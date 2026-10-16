// node --test server/deploy-state-check.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDeployState } from './deploy-state-check.mjs'

test('verified independent Codex can restart while running, queued input still blocks', () => {
  const daemon = { engine:'codex',origin:'platform',state:'running',inflight:true,restartSafe:true }
  assert.equal(checkDeployState(JSON.stringify({sessions:[daemon]})).code,0)
  assert.equal(checkDeployState(JSON.stringify({sessions:[{...daemon,queuedMessages:1}]})).code,10)
  assert.equal(checkDeployState(JSON.stringify({sessions:[{...daemon,engine:'kimi'}]})).code,10)
})

test('valid idle state is safe', () => {
  assert.deepEqual(checkDeployState(JSON.stringify({ sessions: [{ origin: 'platform', state: 'idle' }] })), {
    code: 0, output: '',
  })
})

test('active platform session is listed and blocks deploy', () => {
  const result = checkDeployState(JSON.stringify({ sessions: [{
    id: 'ps-1', origin: 'platform', state: 'running', project: 'demo', summary: 'working',
  }] }))
  assert.equal(result.code, 10)
  assert.match(result.output, /ps-1.*running.*demo/)
})

test('malformed or incomplete state fails closed', () => {
  assert.equal(checkDeployState('{broken').code, 2)
  assert.equal(checkDeployState(JSON.stringify({ sessions: null })).code, 2)
})

test('inflight=false 的平台会话（回合后待办/分离态）不阻塞部署（CR-006 P1-b）', () => {
  // state=waiting_approval 但 inflight=false → 放行
  assert.equal(checkDeployState(JSON.stringify({ sessions: [
    { id: 'review', origin: 'platform', state: 'waiting_approval', inflight: false },
  ] })).code, 0)
  // inflight=true → 阻塞
  const r = checkDeployState(JSON.stringify({ sessions: [
    { id: 'ps-live', origin: 'platform', state: 'running', inflight: true, project: 'p', summary: 's' },
  ] }))
  assert.equal(r.code, 10)
  assert.match(r.output, /ps-live/)
  // 无 inflight 字段（老 agent）→ 回退按 state 阻塞
  assert.equal(checkDeployState(JSON.stringify({ sessions: [
    { id: 'legacy', origin: 'platform', state: 'running' },
  ] })).code, 10)
})

test('maintenance drain response uses the active field', () => {
  assert.equal(checkDeployState(JSON.stringify({ ok: true, active: [] }), 'active').code, 0)
  assert.equal(checkDeployState(JSON.stringify({ ok: false, active: [{ id: 'ps-2', state: 'waiting_input' }] }), 'active').code, 10)
})
