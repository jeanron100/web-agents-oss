// node --test server/map-refresh.test.mjs
//
// 「会话 id 未映射」时的兜底刷新闸（P8）。
//
// 现状：`agent.js` 有 4 处 `if (!file) { await buildState(); ... }`。其中 SSE 那条在
// **每 300ms 的 tick 里**——id 一直映射不上时就是 3.3 次全量 buildState/秒。
// P1/P6 之后 buildState 降到 65 次 read()/55ms，危害比原先小，但仍持续吃约 18% 单核。
//
// ★ 不改映射结构、只加闸：同一个 id 在窗口内只允许触发一次全量刷新。
//   为什么不干脆去掉兜底：id 确实可能因为冷启动顺序而暂时没映射上，去掉会让
//   「刚重启后点开会话」直接 404。兜底要留，但不能每 300ms 敲一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRefreshGate } from './map-refresh.js'

test('首次允许', () => {
  const g = createRefreshGate({ ttlMs: 5000, now: () => 1000 })
  assert.equal(g.allow('sid-1'), true)
})

test('★ 窗口内同一 id 只放行一次（300ms tick 不得穿透）', () => {
  let t = 1000
  const g = createRefreshGate({ ttlMs: 5000, now: () => t })
  assert.equal(g.allow('sid-1'), true)
  for (let i = 0; i < 16; i++) { t += 300; assert.equal(g.allow('sid-1'), false, `第 ${i + 2} 次 tick 不该放行`) }
})

test('窗口过期后重新放行', () => {
  let t = 1000
  const g = createRefreshGate({ ttlMs: 5000, now: () => t })
  g.allow('sid-1')
  t = 6001
  assert.equal(g.allow('sid-1'), true)
})

test('★ 不同 id 互不影响（一个会话卡住不能拖累别的）', () => {
  const g = createRefreshGate({ ttlMs: 5000, now: () => 1000 })
  assert.equal(g.allow('a'), true)
  assert.equal(g.allow('b'), true)
  assert.equal(g.allow('a'), false)
})

test('★ 时钟回拨不得把闸门焊死', () => {
  let t = 10_000
  const g = createRefreshGate({ ttlMs: 5000, now: () => t })
  g.allow('x')
  t = 3000
  assert.equal(g.allow('x'), true, '时间倒退时必须重新放行')
})

test('★ 条目数有上限，不得随 id 无限增长', () => {
  // 深链、扫描器、错误的前端都可能带来大量不存在的 id。
  // 闸门自己变成内存泄漏源，就是把一个小问题换成一个大问题。
  const g = createRefreshGate({ ttlMs: 100000, now: () => 1000, max: 50 })
  for (let i = 0; i < 500; i++) g.allow(`id-${i}`)
  assert.ok(g.size <= 50, `条目数应 ≤50，实际 ${g.size}`)
})

test('成功映射后可主动清除，下次立即放行', () => {
  const g = createRefreshGate({ ttlMs: 100000, now: () => 1000 })
  g.allow('x')
  g.clear('x')
  assert.equal(g.allow('x'), true)
})
