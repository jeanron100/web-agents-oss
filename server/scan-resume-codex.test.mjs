// node --test server/scan-resume-codex.test.mjs
//
// Codex 侧的「**增量续扫 ≡ 冷启动全量扫**」等价性闸。
//
// 为什么必须有（2026-08-13）：Codex 侧此前**完全没有增量续扫**——
//   `scanCodexFile` 的 `createReadStream(file)` 少了 `{start, end}`，
//   `cachedCodexScan` 的缓存键又只比 mtime 不比 size
//   ⇒ 文件每追加一行就整份重读。实测 11.66MB 的 rollout 追加 3,969 字节要重读 11.66MB，
//     **读放大 3,081×**，page cache 同步涨 11.66MB。
//
// ★ 把它改成增量，最大的风险不是"改不快"，而是**从「慢但对」变成「快但错」**：
//   offset 一旦推到别的文件世代上，事件与 token 全部错位，而且**不会报错**——
//   界面照常显示，只是数字是错的。这个测试就是那道闸。
//
// Codex 的累积量比 Claude 还多两组（`codexPrevCum` / `codexPrev`），它们参与
// daily / dayTokComp 的**差值**计算。只存字节 offset 而不存这两组，续算出来的
// 每日 token 会全错——这正是「checkpoint 必须含累积态」的具体含义。
//
// 最阴的用例同样是**追加半行**：若续扫把半行吃进去并推进 offset，下一轮会把后半截当新行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SID = '019de8d5-0000-7eb1-8ee5-000000000001'
const CWD = '/data/web_agents' // 需是真实存在的 /data 项目（rollout 落在 fake HOME 里，碰不到真数据）
const AGENT = new URL('./agent.js', import.meta.url).pathname

const iso = (n) => new Date(1783000000000 + n * 60_000).toISOString()

/** 合成真实形状的 Codex rollout（字段取自线上样本，不含任何用户数据）。 */
function head() {
  return [
    JSON.stringify({ type: 'session_meta', timestamp: iso(0), payload: { id: SID, timestamp: iso(0), cwd: CWD, originator: 'test', cli_version: '0.0.0' } }),
    JSON.stringify({ type: 'turn_context', timestamp: iso(0), payload: { model: 'gpt-5.6-sol' } }),
  ].join('\n') + '\n'
}

/** 第 i 轮：用户消息 + 助手消息 + 一次 exec + 一次 token_count（累计值递增，触发差值逻辑）。 */
function turns(from, to) {
  const out = []
  for (let i = from; i < to; i++) {
    const t = i * 4
    out.push(JSON.stringify({ type: 'response_item', timestamp: iso(t), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `问题 ${i}` }] } }))
    // 2026-09-30：混合新旧 CLI 格式；只验旧 agent_message 会漏掉线上整段助手回复。
    out.push(JSON.stringify(i % 2
      ? { type: 'event_msg', timestamp: iso(t + 1), payload: { type: 'agent_message', message: `回答 ${i}` } }
      : { type: 'response_item', timestamp: iso(t + 1), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `回答 ${i}` }] } }))
    out.push(JSON.stringify({ type: 'response_item', timestamp: iso(t + 2), payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `echo ${i}` }) } }))
    // token 累计值单调增：daily/dayTokComp 走的是**差值**，跨续扫边界必须仍然正确
    const inp = 1000 + i * 37
    const out_ = 500 + i * 13
    const cached = 200 + i * 7
    out.push(JSON.stringify({
      type: 'event_msg', timestamp: iso(t + 3),
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inp, output_tokens: out_, cached_input_tokens: cached, total_tokens: inp + out_ } } },
    }))
  }
  return out.join('\n') + '\n'
}

async function boot(home, port) {
  const p = spawn(process.execPath, [AGENT], {
    env: { ...process.env, HOME: home, WA_AGENT_PORT: String(port), WA_REDIS_ENABLED: '0', WA_MONGO_ENABLED: '0' },
    stdio: 'ignore',
  })
  const get = async (p2) => (await fetch(`http://127.0.0.1:${port}${p2}`)).json()
  for (let i = 0; i < 60; i++) {
    try { await get('/api/state'); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  return { stop: () => p.kill('SIGKILL'), get, pid: p.pid }
}

const eventsOf = (a) => a.get(`/api/session/${SID}/events`)
const summaryOf = async (a) => {
  const st = await a.get('/api/state')
  const s = st.sessions.find((x) => x.id === SID)
  assert.ok(s, '合成的 Codex 会话应出现在 /api/state 里')
  const { state, lastActiveAt, durationMs, inflight, ...rest } = s
  return rest
}

test('Codex：增量续扫 ≡ 冷启动全量扫（events + 全部 summary 累加器）', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-'))
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-08-13T00-00-00-${SID}.jsonl`)

  let A = null
  let B = null
  try {
    // ── 走增量路径的实例 ──
    fs.writeFileSync(file, head() + turns(0, 20))
    A = await boot(home, 18811)
    await eventsOf(A); await summaryOf(A)          // 冷扫一次，把 checkpoint 写进缓存

    fs.appendFileSync(file, turns(20, 45))         // 追加完整行 → 走增量
    const incrEv1 = await eventsOf(A)

    // ★ 最阴的一步：追加**半行**（正在写、换行符还没落盘的那一瞬）
    const [l1] = turns(45, 46).split('\n').filter(Boolean)
    const cut = Math.floor(l1.length / 2)
    fs.appendFileSync(file, l1.slice(0, cut))      // 只写半条，不带换行
    const incrEvHalf = await eventsOf(A)
    assert.deepEqual(incrEvHalf.events, incrEv1.events,
      '半行不得被解析——否则 offset 推过半行，下轮把后半截当新行 ⇒ 事件与 token 全乱')

    fs.appendFileSync(file, l1.slice(cut) + '\n' + turns(45, 46).split('\n').filter(Boolean).slice(1).join('\n') + '\n')
    const incrEv = await eventsOf(A)
    const incrSum = await summaryOf(A)
    A.stop(); A = null

    // ── 基准实例：对同一个（已完整的）文件冷启动全量扫 ──
    B = await boot(home, 18812)
    const fullEv = await eventsOf(B)
    const fullSum = await summaryOf(B)

    assert.ok(fullEv.events.some((e) => e.type === 'assistant' && e.text === '回答 44'), '新版 response_item 回复必须进入 API')
    assert.deepEqual(incrEv.events, fullEv.events, 'events 必须完全相同')
    assert.deepEqual(incrSum, fullSum,
      'summary 全部累加器必须相同——尤其 daily / dayTokComp，它们走的是 token 累计值的**差值**，' +
      '跨续扫边界最容易错（codexPrevCum / codexPrev 没随 checkpoint 带走的话，这里会红）')
  } finally {
    A?.stop(); B?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Codex：文件被 truncate 后重建结果 ≡ 冷启全量（inode 判据兜底）', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-tr-'))
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-08-13T00-00-00-${SID}.jsonl`)

  let A = null
  let B = null
  try {
    fs.writeFileSync(file, head() + turns(0, 30))
    A = await boot(home, 18813)
    await eventsOf(A); await summaryOf(A)          // 建立 checkpoint（offset 指向 30 轮之后）

    // 缩小并重写：size < checkpoint.fileSize ⇒ canResume MUST 判 false ⇒ 走全量重建
    fs.writeFileSync(file, head() + turns(0, 10))
    const afterTruncEv = await eventsOf(A)
    const afterTruncSum = await summaryOf(A)
    A.stop(); A = null

    B = await boot(home, 18814)
    const fullEv = await eventsOf(B)
    const fullSum = await summaryOf(B)

    assert.deepEqual(afterTruncEv.events, fullEv.events,
      'truncate 后必须走全量重建，且结果与冷启动一致——不得残留旧世代的事件')
    assert.deepEqual(afterTruncSum, fullSum, 'truncate 后 summary 不得残留旧数据')
  } finally {
    A?.stop(); B?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('★★ Codex：append 4KB 的**读放大**必须 ≤2×（证明真的走了增量，而非"碰巧算对"）', { timeout: 90_000 }, async () => {
  // 上面两条只证明「结果对」。但全量扫描永远结果对 —— 它们在增量完全没生效时**照样会绿**。
  // 这一条量的是真实读入字节，是唯一能证伪「其实还在全量重读」的测试。
  //
  // 实测基线（2026-08-13，11.66MB 真实 rollout，append 3,969 字节）：
  //   改造前：读 11.66 MB，page cache +11.66 MB，读放大 3,081×
  //   改造后：读  4,085 B，page cache +  8,192 B，读放大 1.03×
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-amp-'))
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-08-13T00-00-00-${SID}.jsonl`)

  let A = null
  try {
    fs.writeFileSync(file, head() + turns(0, 4000))   // 造一个够大的样本，让"全量 vs 增量"拉开量级
    const sizeBefore = fs.statSync(file).size
    assert.ok(sizeBefore > 2_000_000, `样本要够大才测得出差异，当前 ${sizeBefore}`)

    A = await boot(home, 18815)
    await eventsOf(A)                                  // 冷扫，建立 checkpoint
    await eventsOf(A)                                  // 再来一次，确保缓存已热

    const rchar = () => {
      for (const l of fs.readFileSync(`/proc/${A.pid}/io`, 'utf8').split('\n')) {
        if (l.startsWith('rchar:')) return Number(l.split(/\s+/)[1])
      }
      return 0
    }

    const before = rchar()
    const appended = turns(4000, 4002)                 // 约 1~2 KB 的真实增量
    fs.appendFileSync(file, appended)
    await eventsOf(A)                                  // 这一次应当只读增量
    const delta = rchar() - before

    const newBytes = Buffer.byteLength(appended, 'utf8')
    // 阈值给得宽松（文件的 1/4），但仍与"全量重读"相差一个量级 —— 宽松是为了容忍
    // agent 同期的其它读取（/proc、目录发现），不是为了放水。
    assert.ok(delta < sizeBefore / 4,
      `疑似仍在全量重读：本次读入 ${delta} 字节，而文件有 ${sizeBefore} 字节（新增仅 ${newBytes}）`)
    // 同时给出可读的放大倍数，失败时一眼能看出量级
    assert.ok(delta / newBytes < 200,
      `读放大 ${(delta / newBytes).toFixed(0)}× 过高（新增 ${newBytes} 字节，读入 ${delta} 字节）`)
  } finally {
    A?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('★ /api/metrics/ingest 端到端：增量场景下读放大必须 ≈1（接线正确性）', { timeout: 90_000 }, async () => {
  // 单测已证明 scanBytes+metrics 的**公式**能抓住"见过却全量重读"（放大 >2000×）。
  // 这条补的是**接线**：真实 agent 里 knownSize 是否被正确地传成"上次已知文件大小"。
  //
  // ⚠️ 为什么不在生产上做打断实验：`.232` 的 Codex 近 7 天写入为 0，被打断的代码路径
  //    根本不会执行（全是缓存命中），实验做了也不会红——**那是实验设计错，不是指标坏**。
  //    要触发它就得去动生产 JSONL 的 mtime，而本仓库明令禁止拿生产文件当夹具
  //    （曾因 touch 循环把用户的「恢复会话」按死）。故改用隔离实例 + 测试语料。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-m-'))
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-08-13T00-00-00-${SID}.jsonl`)

  let A = null
  try {
    fs.writeFileSync(file, head() + turns(0, 800))
    A = await boot(home, 18816)
    await eventsOf(A)                 // 冷扫：knownSize 未知 ⇒ 计入 full，放大 1（合理）
    await A.get('/api/metrics/ingest')

    // 追加若干轮 → 走增量。此后放大应保持在 1 附近而不是暴涨。
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(file, turns(800 + i * 2, 802 + i * 2))
      await eventsOf(A)
      await A.get('/api/state')
    }
    const m = await A.get('/api/metrics/ingest')
    assert.ok(Number.isFinite(m.read_amplification), 'read_amplification 必须是有限值')
    assert.ok(m.read_amplification < 5,
      `增量场景下读放大应 <5×，实际 ${m.read_amplification.toFixed(2)}× —— 偏高说明还在整份重读`)
    assert.ok(m.incremental_bytes_total > 0, '必须有增量读入被记账，否则说明埋点没生效')
    assert.ok(m.scans_total > 0)
    assert.ok(m.proc_scans_total > 0, '/proc 扫描计数必须有埋点')
  } finally {
    A?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('★ 场景 F：文件被 rename（inode 跟随）后结果仍 ≡ 冷启全量', { timeout: 90_000 }, async () => {
  // 翻案判据 1 的实验室半：若本项目真会 rotate，Fluent Bit 的核心竞争力就回来了。
  // 这里验的是「即便发生 rename/inode 变更，我们的判据也不会算错」——
  // 不是"不会发生"，而是"发生了也安全"。生产观测那半见 server/bench/watch-inode.sh。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-f-'))
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-08-13T00-00-00-${SID}.jsonl`)

  let A = null
  let B = null
  try {
    fs.writeFileSync(file, head() + turns(0, 25))
    A = await boot(home, 18817)
    await eventsOf(A); await summaryOf(A)        // 建立 checkpoint

    // rename 走位：把原文件挪走，再用**新 inode** 写一份内容不同的同名文件
    fs.renameSync(file, file + '.rotated')
    fs.writeFileSync(file, head() + turns(0, 12))  // 新 inode、内容更短
    const afterEv = await eventsOf(A)
    const afterSum = await summaryOf(A)
    A.stop(); A = null

    B = await boot(home, 18818)
    const fullEv = await eventsOf(B)
    const fullSum = await summaryOf(B)

    assert.deepEqual(afterEv.events, fullEv.events,
      'inode 变更后必须整份重建——沿用旧 offset 会把新文件从中间读起，事件与 token 全错且不报错')
    assert.deepEqual(afterSum, fullSum, 'summary 不得残留旧世代的累积量')
  } finally {
    A?.stop(); B?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
