// node --test server/hidden-projects-scan.test.mjs
//
// 端到端守住「隐藏 = 不纳管」。纯函数测试证明不了 agent 在用它——本仓库的高频回归形态
// 就是「接线掉了而单测全绿」（SessionDetail.resolveReleaseTarget 那次）。
//
// ★★ 为什么要同时验**两条**链路：`/api/state`（看板）和 `/api/projects`（新建会话下拉）
//   走的是**完全独立**的代码路径（前者 buildState 的四个扫描循环，后者 listProjects()）。
//   只改一条 = 项目从看板消失了，但新建会话时还能选到它。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AGENT = new URL('./agent.js', import.meta.url).pathname
// Both the workspaces and JSONL live in the fixture; no operator directories are needed.
const KEEP = 'web_agents'
const HIDE = 'claude_manager'
const iso = (n) => new Date(1783000000000 + n * 60_000).toISOString()

const lines = (tag, cwd) => [
  JSON.stringify({ type: 'user', uuid: `u-${tag}`, timestamp: iso(0), cwd, gitBranch: 'main',
    message: { role: 'user', content: [{ type: 'text', text: `在 ${tag} 里干点什么` }] } }),
  JSON.stringify({ type: 'assistant', uuid: `a-${tag}`, timestamp: iso(1), cwd, gitBranch: 'main',
    message: { id: `m-${tag}`, model: 'claude-opus-4-8', role: 'assistant', type: 'message',
      content: [{ type: 'text', text: '好的' }],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
].join('\n') + '\n'

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hide-'))
  for (const p of [KEEP, HIDE]) {
    const cwd = path.join(home, 'workspaces', p)
    fs.mkdirSync(cwd, { recursive: true })
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `0000000${p.length}-1111-2222-3333-44444444444${p.length}.jsonl`), lines(p, cwd))
  }
  return home
}

async function boot(home, port) {
  const p = spawn(process.execPath, [AGENT], {
    env: { ...process.env, HOME: home, WA_PROJECT_ROOT: path.join(home, 'workspaces'), WA_AGENT_PORT: String(port), WA_REDIS_ENABLED: '0', WA_MONGO_ENABLED: '0' },
    stdio: 'ignore',
  })
  const get = async (u) => (await fetch(`http://127.0.0.1:${port}${u}`)).json()
  for (let i = 0; i < 60; i++) {
    try { await get('/api/state'); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  return { stop: () => p.kill('SIGKILL'), get }
}

const projectsIn = (st) => [...new Set((st.sessions ?? []).map((s) => s.project))]

test('★ hidden 下发后：该项目的会话不进 /api/state，其余项目不受影响', { timeout: 90_000 }, async () => {
  const home = fixture()
  let a
  try {
    a = await boot(home, 18821)
    const before = projectsIn(await a.get('/api/state'))
    assert.ok(before.includes(HIDE), `前置条件：${HIDE} 本来应该在（实际 ${JSON.stringify(before)}）`)
    assert.ok(before.includes(KEEP), `前置条件：${KEEP} 本来应该在`)

    const after = projectsIn(await a.get(`/api/state?hidden=${HIDE}`))
    assert.ok(!after.includes(HIDE), `${HIDE} 应被排除，实际 ${JSON.stringify(after)}`)
    assert.ok(after.includes(KEEP), '没被隐藏的项目必须还在 —— 别一隐藏就全清空')
  } finally { a?.stop(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('★★ 新建会话的项目下拉是另一条链路，也必须挡住', { timeout: 90_000 }, async () => {
  const home = fixture()
  let a
  try {
    a = await boot(home, 18822)
    const before = ((await a.get('/api/projects')).projects ?? []).map((p) => p.name)
    assert.ok(before.includes(HIDE), '前置条件：下拉里本来有它')

    const after = ((await a.get(`/api/projects?hidden=${HIDE}`)).projects ?? []).map((p) => p.name)
    assert.ok(!after.includes(HIDE), '隐藏了却还能在新建会话时选到 = 只挡了一半')
    assert.ok(after.includes(KEEP), '其余项目不受影响')
  } finally { a?.stop(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('★ 不带 hidden 参数时保持上一次的名单 —— 而不是把隐藏清空', { timeout: 90_000 }, async () => {
  // 直连 agent 调试（curl / 本测试）不会带这个参数。若「参数缺席」被当成「清空名单」，
  // 隐藏就会随机闪回：hub 那一拍隐藏、别人一 curl 又全冒出来。
  // ⇒ 用 `searchParams.has()` 区分「没传」与「传了空」，只有真传了才更新。
  const home = fixture()
  let a
  try {
    a = await boot(home, 18823)
    await a.get(`/api/state?hidden=${HIDE}`)
    const noParam = projectsIn(await a.get('/api/state'))
    assert.ok(!noParam.includes(HIDE), '不带参数的请求不得把隐藏名单冲掉')

    // 显式传空 = 取消隐藏（这条路必须走得通，否则用户没法恢复项目）
    const cleared = projectsIn(await a.get('/api/state?hidden='))
    assert.ok(cleared.includes(HIDE), '显式传空应恢复该项目，否则隐藏是单向的、取消不了')
  } finally { a?.stop(); fs.rmSync(home, { recursive: true, force: true }) }
})
