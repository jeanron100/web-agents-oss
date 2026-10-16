// node --test server/scan-resume.test.mjs
//
// 守住一个高爆炸半径的不变量：**JSONL 增量续扫 ≡ 冷启动全量扫**。
//
// 背景（2026-07-12 线上事故）：cachedScan 按 mtime 缓存，而正在运行的会话每写一行 mtime 就变 →
// 每次都全量重解析。一个 16MB 长会话全量扫 ~1s，SSE 每 300ms tick 一次且不等上一轮跑完 →
// 同一文件被多个全量扫同时碾 → event loop 被埋 → 首帧发不出去 → 前端对话流永久空白。
// 修法是「只解析新增字节」，但它必须与全量扫**逐字节等价**——否则 seq 错位，SSE 续传/去重全崩，
// 那比原 bug 更坏。这个测试就是那道闸：起两个隔离 agent 实例（fake HOME + 独立端口），
// 一个走增量路径、一个冷启全量，比对 events/fileChanges/todos 与全部 summary 累加器。
//
// 最阴的用例在 case 3：**追加半行**（模拟正在写入的那一瞬）。若续扫把半行吃进去并推进 offset，
// 下一轮就会把该行后半截当成新行解析 → 事件与 seq 全乱。故 safeEnd 必须卡在最后一个换行符之后。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UUID = '00000000-1111-2222-3333-444444444444'
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scan-workspaces-'))
const CWD = path.join(ROOT, 'project')
fs.mkdirSync(CWD)
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const AGENT = new URL('./agent.js', import.meta.url).pathname

const iso = (n) => new Date(1783000000000 + n * 60_000).toISOString()

/** 合成一段真实形状的 Claude JSONL（不含任何用户数据）。 */
function lines(from, to) {
  const out = []
  for (let i = from; i < to; i++) {
    out.push(JSON.stringify({
      type: 'user', uuid: `u${i}`, timestamp: iso(i * 2), cwd: CWD, gitBranch: 'main',
      message: { role: 'user', content: [{ type: 'text', text: `问题 ${i}` }] },
    }))
    out.push(JSON.stringify({
      type: 'assistant', uuid: `a${i}`, timestamp: iso(i * 2 + 1), cwd: CWD, gitBranch: 'main',
      message: {
        id: `m${i}`, model: 'claude-opus-4-8', role: 'assistant', type: 'message',
        content: [
          { type: 'text', text: `回答 ${i}` },
          { type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: `${CWD}/f${i % 3}.ts`, old_string: `旧${i}`, new_string: `新${i}\n第二行` } },
        ],
        usage: { input_tokens: 10 + i, output_tokens: 20 + i, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 + i },
      },
    }))
  }
  return out.join('\n') + '\n'
}

/** 起一个隔离 agent（fake HOME + 独立端口），返回 { stop, get }。 */
async function boot(home, port) {
  const p = spawn(process.execPath, [AGENT], {
    env: { ...process.env, HOME: home, WA_PROJECT_ROOT: ROOT, WA_AGENT_PORT: String(port), WA_REDIS_ENABLED: '0', WA_MONGO_ENABLED: '0' },
    stdio: 'ignore',
  })
  const get = async (p2) => {
    const r = await fetch(`http://127.0.0.1:${port}${p2}`)
    return r.json()
  }
  for (let i = 0; i < 60; i++) {
    try { await get('/api/state'); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  return { stop: () => p.kill('SIGKILL'), get }
}

const eventsOf = (a) => a.get(`/api/session/${UUID}/events`)
const summaryOf = async (a) => {
  const st = await a.get('/api/state')
  const s = st.sessions.find((x) => x.id === UUID)
  assert.ok(s, '合成会话应出现在 /api/state 里')
  // 剔除随时间漂移的字段，只比累加器与派生量
  const { state, lastActiveAt, durationMs, inflight, ...rest } = s
  return rest
}

test('增量续扫 ≡ 冷启动全量扫（events/fileChanges/todos + 全部 summary 累加器）', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scan-'))
  // 目录名 = agent 的 encodeCwd(CWD)：非字母数字一律替成 '-'
  const dir = path.join(home, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${UUID}.jsonl`)

  let A, B
  try {
    // ── 走增量路径的实例 ──
    fs.writeFileSync(file, lines(0, 40))       // 先落一半
    A = await boot(home, 18801)
    await eventsOf(A); await summaryOf(A)      // 冷扫，把断点写进缓存

    fs.appendFileSync(file, lines(40, 80))     // 追加完整行 → 触发增量续扫
    const incrEv1 = await eventsOf(A)

    // case 3（最阴）：追加**半行**——正好卡在「一行写了一半、换行符还没落盘」的那一瞬。续扫必须无视它。
    const [l1, l2] = lines(80, 81).split('\n').filter(Boolean) // 两条完整行（user / assistant）
    const cut = Math.floor(l1.length / 2)
    fs.appendFileSync(file, l1.slice(0, cut)) // 只写半条，且**不带换行符**
    const incrEvHalf = await eventsOf(A)
    assert.deepEqual(incrEvHalf.events, incrEv1.events, '半行不得被解析（否则 offset 推过半行 → 下轮把后半截当新行 → 事件/seq 全乱）')

    fs.appendFileSync(file, `${l1.slice(cut)}\n${l2}\n`) // 补完这一行 + 下一行
    const incrEv = await eventsOf(A)
    const incrSum = await summaryOf(A)
    A.stop(); A = null

    // ── 基准实例：对同一个（已完整的）文件冷启动全量扫 ──
    B = await boot(home, 18802)
    const fullEv = await eventsOf(B)
    const fullSum = await summaryOf(B)

    assert.deepEqual(incrEv.events, fullEv.events, 'events 必须逐字节相同（含 seq 的 byteOffset）')
    assert.deepEqual(incrEv.fileChanges, fullEv.fileChanges, 'fileChanges 必须相同')
    assert.deepEqual(incrEv.todos, fullEv.todos, 'todos 必须相同')
    assert.ok(fullEv.events.length > 0, '样本应产出事件，否则这测试什么也没测')
    assert.deepEqual(incrSum, fullSum, 'summary 全部累加器（token/成本/条数/活跃时长…）必须相同')
  } finally {
    A?.stop(); B?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
