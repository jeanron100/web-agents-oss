// 归档采集的**纯决策核**回归测试（openspec change: execution-history-archive）。
//
// 这一层只回答三个问题，不做任何 I/O：
//   ① 哪些文件要采（排除探针残留）
//   ② 每个文件从哪个字节开始读（续扫判据**复用** resume-guard.js#canResume，不写第四份）
//   ③ 上报帧怎么切、幂等键怎么算
//
// ★ 为什么把它抽成纯函数：P0 是整个变更里**唯一不可逆**的一层——L1~L4 都能推倒重做，
//   而 L0 漏采的那段永远补不回来。所以判定逻辑必须能脱离机器、脱离网络被反复验证。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isProbeResidue, planFileReads, frameBatches, idempotencyKey, ARCHIVE_BATCH_BYTES,
} from './archive-plan.js'
import { canResume } from './resume-guard.js'

// ───────────────── ① 探针残留排除 ─────────────────
//
// 实测：189-4 有 3,404 个 JSONL 却只占 50 MB；.232 的 `-root` 目录曾 26 天攒下
// 8,195 个文件 / 146 MB 全是 `claude --print /usage` 的一次性记录。
// 教训（CLAUDE.md）：**凡"要先判别内容才敢删"的清理，都是上游没把可清理的东西隔离出来**
// —— 归档侧同理，宁可采集时就不收，也不要事后在中心库里逐条判别。

test('★ 探针 scratch 目录一律排除', () => {
  assert.equal(isProbeResidue({ project: '-tmp-wa-usage-probe', bytes: 11000, lines: 8 }), true)
})

test('★ `-root` 下的微型会话按体量判为探针', () => {
  // /usage 探针一次约 11 KB、行数极少；真实交互会话不会这么小
  assert.equal(isProbeResidue({ project: '-root', bytes: 11_000, lines: 6 }), true)
})

test('`-root` 下的真实会话不得被误杀', () => {
  // 实测 8,197 个里正好有 2 个是真实交互会话——误杀它们就是永久丢历史
  assert.equal(isProbeResidue({ project: '-root', bytes: 2_400_000, lines: 900 }), false)
})

test('★ Kimi 探针工作目录也要排除（真实归档里发现的）', () => {
  // kimi-usage.js 用 `tmux new-session -c /tmp` 起探针，Kimi 按 cwd 建 wd_tmp_<hash>/wd_root_<hash>。
  // 归档里已混进一批「只回复两个字：就绪」——纯噪声，会稀释检索质量。
  // ★ 这条不是设计时想到的，是**拿真实数据验抽取**时撞出来的。
  assert.equal(isProbeResidue({ project: 'wd_tmp_e9671acd2448', bytes: 50_000, lines: 300 }), true)
  assert.equal(isProbeResidue({ project: 'wd_root_94a6b4475803', bytes: 50_000, lines: 300 }), true)
  // 但不能误伤正常命名
  assert.equal(isProbeResidue({ project: 'wd_tmp_notahash', bytes: 50_000, lines: 300 }), false)
  assert.equal(isProbeResidue({ project: '-data-wd-tmp', bytes: 50_000, lines: 300 }), false)
})

test('正常项目目录一律不排除，无论大小', () => {
  assert.equal(isProbeResidue({ project: '-data-web-agents', bytes: 500, lines: 2 }), false)
  assert.equal(isProbeResidue({ project: '-data-invest-data', bytes: 74_000_000, lines: 90_000 }), false)
})

// ───────────────── ② 从哪读 ─────────────────

test('★★ 续扫判据必须复用 resume-guard —— 不得另写一份', () => {
  // 本仓库靠"三侧共用同一份判据"才没在部署闸上出事。采集器是第四个使用方。
  const st = { ino: 42, size: 1000 }
  const ck = { generation: '42', fileSize: 900, offset: 900 }
  const plan = planFileReads([{ path: '/a.jsonl', st }], { '/a.jsonl': ck })
  assert.equal(plan[0].from, 900)
  assert.equal(plan[0].reason, 'resume')
  // 与判据本身一致
  assert.equal(canResume(ck, st), true)
})

test('★ inode 变了（文件被重建）必须从 0 重采，不得沿用旧 offset', () => {
  const st = { ino: 99, size: 1000 }            // 新世代
  const ck = { generation: '42', fileSize: 900, offset: 900 }
  const plan = planFileReads([{ path: '/a.jsonl', st }], { '/a.jsonl': ck })
  assert.equal(plan[0].from, 0)
  assert.equal(plan[0].reason, 'generation-changed')
  assert.equal(canResume(ck, st), false)
})

test('★ 文件被截断（size < 已读 offset）必须从 0 重采', () => {
  const st = { ino: 42, size: 500 }
  const ck = { generation: '42', fileSize: 900, offset: 900 }
  assert.equal(planFileReads([{ path: '/a.jsonl', st }], { '/a.jsonl': ck })[0].from, 0)
})

test('没有 checkpoint 的新文件从 0 采', () => {
  const plan = planFileReads([{ path: '/new.jsonl', st: { ino: 7, size: 100 } }], {})
  assert.deepEqual([plan[0].from, plan[0].reason], [0, 'new'])
})

test('★ 没有新增字节的文件不产生任务 —— 稳态不得空转', () => {
  const st = { ino: 42, size: 900 }
  const ck = { generation: '42', fileSize: 900, offset: 900 }
  assert.deepEqual(planFileReads([{ path: '/a.jsonl', st }], { '/a.jsonl': ck }), [])
})

// ───────────────── ③ 分帧与幂等 ─────────────────

test('★ safeEnd 必须卡在最后一个换行之后 —— 正在写的半行本轮不碰', () => {
  // 与 scanFile 同一条纪律：offset 推过半行，下轮把后半截当新行 ⇒ 内容错乱且不报错
  const chunk = '{"a":1}\n{"b":2}\n{"c":3'      // 末行未完成
  const b = frameBatches({ path: '/a.jsonl', from: 0, text: chunk })
  assert.equal(b.batches.length, 1)
  assert.deepEqual(b.batches[0].lines, ['{"a":1}', '{"b":2}'])
  assert.equal(b.safeEnd, 16)                    // 只推进到第二个 \n 之后
})

test('整块都没有换行时不推进 offset，也不产生帧', () => {
  const b = frameBatches({ path: '/a.jsonl', from: 0, text: '{"half' })
  assert.deepEqual(b.batches, [])
  assert.equal(b.safeEnd, 0)
})

test('★ 大块按字节上限切成多帧（单会话实测可达 74 MB，不能一帧发完）', () => {
  const line = '{"x":"' + 'y'.repeat(2000) + '"}'
  const text = Array.from({ length: 200 }, () => line).join('\n') + '\n'
  const b = frameBatches({ path: '/a.jsonl', from: 0, text })
  assert.ok(b.batches.length > 1, `应切多帧，实际 ${b.batches.length}`)
  for (const f of b.batches) {
    const size = f.lines.reduce((n, l) => n + l.length + 1, 0)
    assert.ok(size <= ARCHIVE_BATCH_BYTES * 1.5, `单帧 ${size} B 超上限太多`)
  }
  // 不丢行
  assert.equal(b.batches.reduce((n, f) => n + f.lines.length, 0), 200)
})

test('★★ 幂等键只由「文件世代 + 字节区间」决定 —— 重发不得产生重复', () => {
  const a = idempotencyKey({ host: 'h1', path: '/a.jsonl', generation: '42', from: 0, to: 100 })
  const b = idempotencyKey({ host: 'h1', path: '/a.jsonl', generation: '42', from: 0, to: 100 })
  assert.equal(a, b)
  // 换了世代必须是不同的键，否则新文件会被当成旧文件的重发而被丢弃
  assert.notEqual(a, idempotencyKey({ host: 'h1', path: '/a.jsonl', generation: '99', from: 0, to: 100 }))
  // 换了机器也必须不同（不同机器可能有同名路径）
  assert.notEqual(a, idempotencyKey({ host: 'h2', path: '/a.jsonl', generation: '42', from: 0, to: 100 }))
})

test('幂等键与内容无关 —— 同一区间重读即便解析结果不同也视为同一份', () => {
  const k = (extra) => idempotencyKey({ host: 'h', path: '/p', generation: '1', from: 0, to: 10, ...extra })
  assert.equal(k({}), k({ lines: ['a'] }))
})
