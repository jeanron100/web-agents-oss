// 中心原文归档层的回归测试（openspec change: execution-history-archive，P0）。
//
// 这一层负责：把 agent 推上来的原始 JSONL 行**幂等地**落到 `.189.4` 的分片文件里，
// 并维护一份可用于对账的清单（manifest）。
//
// ★ 为什么原文不塞 Mongo（design D5/D11）：单会话实测可达 **74 MB**，远超 Mongo
//   16 MB 文档上限，塞进去必然要分块——那还不如直接按行分片存文件，
//   还能 `zcat | grep` 排障。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shardPath, createArchiveStore } from './archive-store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-arch-'))

const frame = (over = {}) => ({
  host: 'srv-178-232',
  project: '-data-web-agents',
  session: 'ps-abc-1',
  engine: 'claude',
  filePath: '/root/.claude/projects/-data-web-agents/abc.jsonl',
  generation: '42',
  from: 0,
  to: 16,
  key: 'K1',
  lines: ['{"a":1}', '{"b":2}'],
  ...over,
})

// ───────────────── 分片路径 ─────────────────

test('分片路径按 机器/项目/会话 展开，且对路径穿越免疫', () => {
  const p = shardPath('/base', { host: 'srv-1', project: '-data-x', session: 's1' })
  assert.ok(p.startsWith('/base/'), p)
  assert.ok(p.includes('srv-1') && p.includes('-data-x') && p.includes('s1'))
})

test('★ 恶意字段不得逃出 base 目录', () => {
  // agent 上报的坐标来自文件系统路径，必须当成不可信输入。
  // ⚠️ 这里断言的是**真正的安全属性**——`path.resolve` 之后仍在 base 之下。
  //   初版写的是 `!p.includes('..')`，那比不变量更严：`__.._etc` 只是文件名里带了两个点，
  //   逃不出任何地方。**把"看起来危险"当成"实际危险"会逼出无意义的实现改动。**
  for (const bad of [
    { host: '../../etc', project: '..', session: '../../passwd' },
    { host: 'a/../../b', project: '.', session: '..' },
    { host: '', project: '', session: '' },
  ]) {
    const p = path.resolve(shardPath('/base', bad))
    assert.ok(p.startsWith(path.resolve('/base') + path.sep), `逃出了 base：${p}`)
  }
})

// ───────────────── 幂等落库 ─────────────────

test('★★ 同一 key 重复提交只落一份 —— 重试不得制造重复', async () => {
  const base = tmp()
  const s = createArchiveStore(base)
  assert.equal((await s.accept(frame())).written, 2)
  assert.equal((await s.accept(frame())).written, 0)      // 第二次是重发
  assert.equal((await s.accept(frame())).duplicate, true)
  assert.equal(s.stats().lines, 2)
})

test('★ 不同世代的同一区间是不同的份 —— 文件重建后的重采不得被当成重发丢掉', async () => {
  const base = tmp()
  const s = createArchiveStore(base)
  await s.accept(frame({ key: 'K1', generation: '42' }))
  const r = await s.accept(frame({ key: 'K2', generation: '99', lines: ['{"c":3}'] }))
  assert.equal(r.written, 1)
  assert.equal(s.stats().lines, 3)
})

test('落盘内容逐行等于上报内容，不做任何改写', async () => {
  const base = tmp()
  const s = createArchiveStore(base)
  await s.accept(frame({ lines: ['{"x":"中文 with \\"quote\\""}', '{"y":2}'] }))
  const f = shardPath(base, { host: 'srv-178-232', project: '-data-web-agents', session: 'ps-abc-1' })
  const got = fs.readFileSync(f, 'utf-8').trim().split('\n')
  assert.deepEqual(got, ['{"x":"中文 with \\"quote\\""}', '{"y":2}'])
})

test('★ 追加语义：后续帧接在文件末尾，不覆盖', async () => {
  const base = tmp()
  const s = createArchiveStore(base)
  await s.accept(frame({ key: 'A', lines: ['1'] }))
  await s.accept(frame({ key: 'B', from: 16, to: 18, lines: ['2'] }))
  const f = shardPath(base, { host: 'srv-178-232', project: '-data-web-agents', session: 'ps-abc-1' })
  assert.deepEqual(fs.readFileSync(f, 'utf-8').trim().split('\n'), ['1', '2'])
})

// ───────────────── 清单与对账 ─────────────────

test('★ manifest 记录每个会话的坐标与行数，供对账用', async () => {
  const base = tmp()
  const s = createArchiveStore(base)
  await s.accept(frame())
  await s.accept(frame({ session: 'ps-def-2', key: 'K9', lines: ['{"z":1}'] }))
  const m = s.manifest()
  assert.equal(m.length, 2)
  const one = m.find((x) => x.session === 'ps-abc-1')
  assert.equal(one.host, 'srv-178-232')
  assert.equal(one.engine, 'claude')
  assert.equal(one.lines, 2)
  assert.ok(one.lastAt > 0)
})

test('★★ 重启后 manifest 与幂等集合必须能从盘上恢复 —— 否则重启即全量重收', async () => {
  // 这是"丢了就没了"的数据，重启后把已收的又收一遍不致命，但会白烧跨境带宽与中心磁盘；
  // 更糟的是若判重失效，中心库会出现重复行而无人察觉。
  const base = tmp()
  const s1 = createArchiveStore(base)
  await s1.accept(frame())
  const s2 = createArchiveStore(base)                    // 模拟进程重启
  assert.equal((await s2.accept(frame())).duplicate, true)
  assert.equal(s2.manifest().length, 1)
  assert.equal(s2.manifest()[0].lines, 2)
})

test('空 lines 的帧被拒绝，不得产生空分片', async () => {
  const s = createArchiveStore(tmp())
  const r = await s.accept(frame({ lines: [] }))
  assert.equal(r.written, 0)
  assert.equal(r.rejected, true)
})

test('缺必填坐标的帧被拒绝', async () => {
  const s = createArchiveStore(tmp())
  for (const bad of [{ host: '' }, { session: '' }, { key: '' }]) {
    assert.equal((await s.accept(frame(bad))).rejected, true)
  }
})
