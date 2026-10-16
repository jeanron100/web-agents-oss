// node --test server/usage-dedupe-scan.test.mjs
//
// 端到端守住 token 去重（2026-09-05）。`usage-dedupe.test.mjs` 只证明纯函数算得对，
// **证明不了 agent.js 在调用它** —— 本仓库栽过一模一样的一次（SessionDetail 的
// resolveReleaseTarget：7 条纯函数单测全绿，而页面根本没接线）。所以这里起真 agent，
// 从 `/api/state` 读渲染到看板上的那个 tokens 数。
//
// ★★ case 2 才是关键，也是唯一可能悄悄回归的地方：
//   一条 assistant message 的多个 block 行**被增量续扫的 offset 断点劈开**。
//   去重状态若不跟着 summary 进检查点/续扫态，续扫那一半就会重新全额计一遍——
//   而活跃会话每 300ms 就续扫一次，等于把 bug 原样装回去。
//   CLAUDE.md 的老账：「checkpoint 必须含跨行累积量，只存字节 offset 等于没存」。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UUID = '00000000-1111-2222-3333-555555555555'
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-usage-workspaces-'))
const CWD = path.join(ROOT, 'project')
fs.mkdirSync(CWD)
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const AGENT = new URL('./agent.js', import.meta.url).pathname
const iso = (n) => new Date(1783000000000 + n * 60_000).toISOString()

// 取自线上实物 msg_011CeBycEjS3TmQQyvvS2tXH（3 行共享同一 message.id，每行都带完整 usage）
const U1 = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 4452, cache_creation_input_tokens: 16074 }
const U3 = { input_tokens: 2, output_tokens: 374, cache_read_input_tokens: 4452, cache_creation_input_tokens: 16074 }
const TRUTH = 2 + 374 + 4452 + 16074   // 20,902 —— 这条 message 的真实用量
const NAIVE = 20529 + 20529 + 20902    // 61,960 —— 逐行累加会得到的虚高值

const userLine = () => JSON.stringify({
  type: 'user', uuid: 'u0', timestamp: iso(0), cwd: CWD, gitBranch: 'main',
  message: { role: 'user', content: [{ type: 'text', text: '定位并读取那个配置文件' }] },
})
/** 同一条 message 的第 i 个 block 行：id 相同、usage 是消息级的完整值。 */
const blockLine = (i, usage, block) => JSON.stringify({
  type: 'assistant', uuid: `a${i}`, timestamp: iso(i), cwd: CWD, gitBranch: 'main',
  message: {
    id: 'msg_011CeBycEjS3TmQQyvvS2tXH', model: 'claude-opus-4-8', role: 'assistant', type: 'message',
    stop_reason: usage === U3 ? 'tool_use' : null, content: [block], usage,
  },
})
const L1 = () => blockLine(1, U1, { type: 'text', text: "I'll start by locating the config" })
const L2 = () => blockLine(2, U1, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
const L3 = () => blockLine(3, U3, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cat x' } })

async function boot(home, port) {
  const p = spawn(process.execPath, [AGENT], {
    env: { ...process.env, HOME: home, WA_PROJECT_ROOT: ROOT, WA_AGENT_PORT: String(port), WA_REDIS_ENABLED: '0', WA_MONGO_ENABLED: '0' },
    stdio: 'ignore',
  })
  const get = async (u) => (await fetch(`http://127.0.0.1:${port}${u}`)).json()
  for (let i = 0; i < 60; i++) {
    try { await get('/api/state'); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  return { stop: () => p.kill('SIGKILL'), get }
}

const sessionOf = async (a) => {
  const st = await a.get('/api/state')
  const s = st.sessions.find((x) => x.id === UUID)
  assert.ok(s, '合成会话应出现在 /api/state 里')
  return s
}
/** msgCount 不在 /api/state 线协议里（那份被 toWire 裁过），只在冷路径历史里暴露。 */
const historyOf = async (a) => {
  const h = await a.get(`/api/project/sessions?project=${path.basename(CWD)}&limit=20`)
  const s = (h.sessions ?? []).find((x) => x.id === UUID)
  assert.ok(s, '合成会话应出现在冷路径历史里')
  return s
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dedup-'))
  const dir = path.join(home, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  return { home, file: path.join(dir, `${UUID}.jsonl`) }
}

test('★ 冷启动全量扫：多 block 行的同一条 message 只计一次 token', { timeout: 90_000 }, async () => {
  const { home, file } = fixture()
  fs.writeFileSync(file, [userLine(), L1(), L2(), L3()].join('\n') + '\n')
  let a
  try {
    a = await boot(home, 18811)
    const s = await sessionOf(a)
    assert.notEqual(s.tokens, NAIVE, `逐行累加会得到 ${NAIVE}，那正是要修的 bug`)
    assert.equal(s.tokens, TRUTH, 'tokens 必须等于该 message 的真实用量')
    assert.equal((await historyOf(a)).msgCount, 2, '消息数也不能按 block 行数虚报（1 问 + 1 答）')
  } finally { a?.stop(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('★★ 增量续扫断点劈开同一条 message：续扫那半截不得重新全额计一遍', { timeout: 90_000 }, async () => {
  const { home, file } = fixture()
  let a
  try {
    // 先落前两个 block 行 → 冷扫，把断点(offset)与去重状态写进缓存
    fs.writeFileSync(file, [userLine(), L1(), L2()].join('\n') + '\n')
    a = await boot(home, 18812)
    const before = await sessionOf(a)
    assert.equal(before.tokens, 20529, '此刻只见过 output=1 的两行，应为 20,529')

    // 追加第三个 block 行（output 涨到 374）→ 走增量续扫
    fs.appendFileSync(file, L3() + '\n')
    const after = await sessionOf(a)
    assert.notEqual(after.tokens, 20529 + 20902, '把续扫那行整条再加一遍 = 去重状态没跟着断点走')
    assert.equal(after.tokens, TRUTH, '只应补上 output 的差额 373')
    assert.equal((await historyOf(a)).msgCount, 2)
  } finally { a?.stop(); fs.rmSync(home, { recursive: true, force: true }) }
})
