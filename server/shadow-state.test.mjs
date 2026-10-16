// node --test server/shadow-state.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refreshPlatformFromFile, advanceShadowTurn, shadowStateOf, isCodexSubagent } from './shadow-state.js'

const H8 = 8 * 3600_000

test('原生进程续接同一会话：driver 滞后为 idle，文件新鲜 → 上抬为 running（本 bug 主场景）', () => {
  const now = 1_000_000_000
  const ps = { state: 'idle', lastActiveAt: now - H8 } // driver 8 小时没动
  const r = refreshPlatformFromFile(ps, now - 30_000, 'running') // 文件 30s 前刚写
  assert.equal(r.state, 'running')
  assert.equal(r.lastActiveAt, now - 30_000)
})

test('driver=done 同样可被文件上抬', () => {
  const now = 1_000_000_000
  const r = refreshPlatformFromFile({ state: 'done', lastActiveAt: now - H8 }, now - 10_000, 'waiting_input')
  assert.equal(r.state, 'waiting_input')
})

test('绝不覆盖 driver 权威态 waiting_approval（即便文件很新）', () => {
  const now = 1_000_000_000
  const r = refreshPlatformFromFile({ state: 'waiting_approval', lastActiveAt: now - H8 }, now - 5_000, 'running')
  assert.equal(r.state, 'waiting_approval')
  assert.equal(r.lastActiveAt, now - 5_000) // lastActiveAt 仍取较新者
})

test('绝不覆盖 driver 权威态 running（Web 端正在驱动）', () => {
  const now = 1_000_000_000
  const r = refreshPlatformFromFile({ state: 'running', lastActiveAt: now - 2_000 }, now - 60_000, 'running')
  assert.equal(r.state, 'running')
  assert.equal(r.lastActiveAt, now - 2_000) // driver 记录更新，取它
})

test('文件本身也安静（fileState=idle）→ 维持 driver 的 idle，不臆造活动', () => {
  const now = 1_000_000_000
  const r = refreshPlatformFromFile({ state: 'idle', lastActiveAt: now - H8 }, now - 10 * 60_000, 'idle')
  assert.equal(r.state, 'idle')
})

test('driver 记录比文件更新（driver 才是真相）→ 不上抬，lastActiveAt 取 driver', () => {
  const now = 1_000_000_000
  const r = refreshPlatformFromFile({ state: 'idle', lastActiveAt: now - 1_000 }, now - 50_000, 'running')
  assert.equal(r.state, 'idle') // 文件比 driver 旧，不能据此判活
  assert.equal(r.lastActiveAt, now - 1_000)
})

test('纯函数：不修改入参', () => {
  const now = 1_000_000_000
  const ps = { state: 'idle', lastActiveAt: now - H8 }
  refreshPlatformFromFile(ps, now, 'running')
  assert.equal(ps.state, 'idle')
  assert.equal(ps.lastActiveAt, now - H8)
})

test('容错：ps.lastActiveAt 缺失视为 0', () => {
  const r = refreshPlatformFromFile({ state: 'idle' }, 123456, 'running')
  assert.equal(r.state, 'running')
  assert.equal(r.lastActiveAt, 123456)
})

test('finished Codex/Kimi turns stay idle despite fresh bookkeeping writes', () => {
  for (const engine of ['codex', 'kimi']) {
    const record = (type, id) => engine === 'codex'
      ? { type: 'event_msg', payload: { type, turn_id: id } }
      : { type, turnId: id }
    let turn = advanceShadowTurn(null, record(engine === 'codex' ? 'task_started' : 'agent.turn.started', 't1'), engine)
    assert.equal(shadowStateOf(999, false, 1000, turn), 'running')
    turn = advanceShadowTurn(turn, record(engine === 'codex' ? 'task_complete' : 'turn.ended', 't1'), engine)
    turn = advanceShadowTurn(turn, record('token_counting.turn_recorded'), engine)
    assert.equal(shadowStateOf(999, false, 1000, turn), 'idle')
    assert.equal(shadowStateOf(999, true, 1000, turn), 'waiting_input')
  }
})

test('new turns reopen; delayed completion for an older turn is ignored', () => {
  const turn = advanceShadowTurn({ running: false, id: 'old' }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } }, 'codex')
  const same = advanceShadowTurn(turn, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } }, 'codex')
  assert.equal(shadowStateOf(0, true, 120_000, same), 'running', 'long running work with a live process is retained')
  assert.equal(shadowStateOf(0, false, 120_000, same), 'idle', 'stale open turn without a live process is not permanently running')
})

test('legacy transcripts retain fallback; guardian and other subagents are internal', () => {
  assert.equal(shadowStateOf(999, false, 1000), 'running')
  assert.equal(isCodexSubagent({ subagent: { other: 'guardian' } }), true)
  assert.equal(isCodexSubagent({ subagent: { thread_spawn: {} } }), true)
  assert.equal(isCodexSubagent('subagent'), true)
  assert.equal(isCodexSubagent('cli'), false)
  assert.equal(isCodexSubagent(null), false)
})
