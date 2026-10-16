// node --test server/forward-timeouts.test.mjs
//
// hub→agent 转发超时的**策略不变量**（2026-07-19 线上事故的收尾）。
//
// 事故：232 的会话闸门（session-gate.js）被焊死在 8/8，用户新建 / 恢复会话一律「超时」。
// 闸门本身是有礼貌的——排不上就回 503，body 里带 `active/max/position/retryAfterMs`，
// 前端本可以显示「并发 8/8，排队第 2 位，稍后重试」。
//
// 但那条消息**一次都没到过用户手里**：闸门要等 queueWaitMs=45s 才放弃，
// 而 hub 的 forward() 固定 15s 就 abort → 每次都先变成 504「节点响应超时」。
// 系统明明知道真因，却结构性地说不出口。
//
// 这跟 forward-error.js 记的 07-18 审批事故是同一个模式（当时把 /api/action 放宽到 30s 修好了），
// 但**派生路径的闸门等得更久（45s），反而错得更多，没人跟着调**。
//
// 所以这里把「谁该等多久」变成一条可测的不变量，而不是散落在 hub.js 里的魔法数字：
//   **凡是会被闸门排队的路径，hub 的等待必须严格长于闸门的排队上限。**
// 否则那条 503 永远不可达 —— 一个永远送不到的错误消息，和没有这个消息是一回事。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  forwardTimeoutMs, isSpawnPath,
  DEFAULT_FORWARD_MS, ACTION_FORWARD_MS, GATE_QUEUE_WAIT_MS,
} from './forward-timeouts.js'

test('★ 核心不变量：派生路径的转发超时必须【严格长于】闸门排队上限', () => {
  for (const p of ['/api/session', '/api/session/ps-abc-1/reattach',
                   '/api/session/ps-abc-1/takeover']) {
    const t = forwardTimeoutMs(p)
    assert.ok(t > GATE_QUEUE_WAIT_MS,
      `${p} 超时 ${t}ms 必须 > 闸门排队上限 ${GATE_QUEUE_WAIT_MS}ms，否则闸门的 503 永远送不到前端`)
  }
})

test('★ 闸门排队上限可注入：运维调大 WA_SPAWN_QUEUE_WAIT_MS 后不变量仍成立', () => {
  const gate = 90_000
  const t = forwardTimeoutMs('/api/session', { gateQueueWaitMs: gate })
  assert.ok(t > gate, `注入 ${gate}ms 后超时应随之抬高，实测 ${t}ms`)
})

test('四条派生路径都被识别为「会被闸门排队」', () => {
  assert.equal(isSpawnPath('/api/session'), true)
  assert.equal(isSpawnPath('/api/session/ps-abc-1/reattach'), true)
  assert.equal(isSpawnPath('/api/session/ps-abc-1/takeover'), true)
  // /review 已随死接口于 2026-08-04 删除，故不再是派生路径
  assert.equal(isSpawnPath('/api/session/ps-abc-1/review'), false)
})

test('非派生的写操作不受影响，仍用默认 15s（它们不排队，等久了只是拖着用户）', () => {
  for (const p of ['/api/session/ps-abc-1/message', '/api/session/ps-abc-1/interrupt',
                   '/api/session/ps-abc-1/mode', '/api/session/ps-abc-1/release']) {
    assert.equal(isSpawnPath(p), false, `${p} 不该被当成派生路径`)
    assert.equal(forwardTimeoutMs(p), DEFAULT_FORWARD_MS)
  }
})

test('审批仍走 30s（07-18 事故的既有结论，别回退）', () => {
  assert.equal(forwardTimeoutMs('/api/action/act-abc-1'), ACTION_FORWARD_MS)
  assert.ok(ACTION_FORWARD_MS > DEFAULT_FORWARD_MS, '审批比普通写操作更值得等')
})

test('未知路径回落到默认值，不抛错（新增端点不能因为没登记就炸）', () => {
  assert.equal(forwardTimeoutMs('/api/whatever/new'), DEFAULT_FORWARD_MS)
  assert.equal(forwardTimeoutMs(''), DEFAULT_FORWARD_MS)
  assert.equal(forwardTimeoutMs(undefined), DEFAULT_FORWARD_MS)
})
