import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

test('agent dashboard excludes guardian threads and immediately closes native Codex/Kimi turns', { timeout: 40_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dashboard-state-'))
  const codexDir = path.join(home, '.codex', 'sessions')
  const kimiDir = path.join(home, '.kimi-code', 'sessions', 'main-session')
  fs.mkdirSync(codexDir, { recursive: true })
  fs.mkdirSync(path.join(kimiDir, 'agents', 'main'), { recursive: true })
  const line = (d) => JSON.stringify(d) + '\n'
  const event = (type, id = 'turn1') => line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: id } })
  const rollout = (id, source) => line({ type: 'session_meta', payload: { id, cwd: '/data/wa-dashboard-fixture', source } })
    + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' }] } })
    + event('task_started') + event('task_complete')
  const main = path.join(codexDir, 'main.jsonl')
  fs.writeFileSync(main, rollout('dashboard-main', 'cli'))
  // More recent internal threads must not consume the two project slots.
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(codexDir, `guardian${i}.jsonl`), rollout(`guardian-${i}`, { subagent: { other: 'guardian' } }))
  fs.writeFileSync(path.join(home, '.kimi-code', 'session_index.jsonl'), line({ sessionId: 'kimi-main', sessionDir: kimiDir, workDir: '/data/wa-dashboard-fixture' }))
  const wire = path.join(kimiDir, 'agents', 'main', 'wire.jsonl')
  fs.writeFileSync(wire, line({ type: 'agent.turn.started', turnId: 'k1', time: Date.now() }) + line({ type: 'turn.ended', turnId: 'k1', time: Date.now() }))
  const p = spawn(process.execPath, [new URL('./agent.js', import.meta.url).pathname], {
    env: { ...process.env, HOME: home, WA_AGENT_PORT: '18831', WA_REDIS_ENABLED: '0', WA_MONGO_ENABLED: '0' }, stdio: 'ignore',
  })
  try {
    const state = async () => {
      const r = await fetch('http://127.0.0.1:18831/api/state')
      assert.equal(r.ok, true)
      return r.json()
    }
    let snapshot
    for (let i = 0; i < 100; i++) {
      try { snapshot = await state(); break } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
    }
    assert.ok(snapshot, 'agent must boot')
    assert.equal(snapshot.sessions.some((s) => s.id.startsWith('guardian-')), false)
    assert.equal(snapshot.sessions.find((s) => s.id === 'dashboard-main')?.state, 'idle')
    assert.equal(snapshot.sessions.find((s) => s.id === 'kimi-main')?.state, 'idle')
    fs.appendFileSync(main, event('task_started', 'turn2'))
    fs.appendFileSync(wire, line({ type: 'agent.turn.started', turnId: 'k2', time: Date.now() }))
    snapshot = await state()
    assert.equal(snapshot.sessions.find((s) => s.id === 'dashboard-main')?.state, 'running')
    assert.equal(snapshot.sessions.find((s) => s.id === 'kimi-main')?.state, 'running')
    const end = event('task_complete', 'turn2')
    fs.appendFileSync(main, end.slice(0, -1))
    assert.equal((await state()).sessions.find((s) => s.id === 'dashboard-main')?.state, 'running', 'partial native records must not close a turn')
    fs.appendFileSync(main, '\n')
    fs.appendFileSync(wire, line({ type: 'turn.ended', turnId: 'k2', time: Date.now() }) + line({ type: 'prompt.completed', time: Date.now() }))
    snapshot = await state()
    assert.equal(snapshot.sessions.find((s) => s.id === 'dashboard-main')?.state, 'idle')
    assert.equal(snapshot.sessions.find((s) => s.id === 'kimi-main')?.state, 'idle')
    const history = await (await fetch('http://127.0.0.1:18831/api/project/sessions?project=wa-dashboard-fixture&limit=8')).json()
    assert.equal(history.sessions.some((s) => s.id.startsWith('guardian-')), false)
  } finally {
    p.kill('SIGKILL')
    await new Promise((resolve) => p.once('exit', resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
})
