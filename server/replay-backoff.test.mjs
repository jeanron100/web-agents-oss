// node --test server/replay-backoff.test.mjs
//
// 2026-08-01 事故：Mongo 经跨境公网隧道（81.70，~3Mbps）访问，spool 攒到 102MB/151k 条后，
// 每一轮投影都把【整份 102MB】砸进管子重试；失败就整份落回、下轮再砸。内核统计实测：
//   cwnd:1  bytes_retrans:67MB/655MB(10.3%)  send 188Kbps  Send-Q 积压
// 即拥塞窗口被自己打崩，往返涨到 2~5s > serverSelectionTimeoutMS(5000) ⇒ 判定 down ⇒
// 新事件继续落 spool ⇒ 重试压力更大。**自维持的拥塞崩溃**。
//
// 退避闸门是这个闭环的断点：失败后按指数拉长间隔，别让重试把链路焊死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextDelayMs, shouldAttempt, BASE_MS, MAX_MS } from './replay-backoff.js'

test('从未失败过 ⇒ 不等待，正常节奏重放', () => {
  assert.equal(nextDelayMs(0), 0)
  assert.equal(shouldAttempt({ failures: 0, lastAttemptAt: 0, now: 1000 }), true)
})

test('★ 失败后按指数拉长间隔（这是打断拥塞崩溃闭环的关键）', () => {
  assert.equal(nextDelayMs(1), BASE_MS)
  assert.equal(nextDelayMs(2), BASE_MS * 2)
  assert.equal(nextDelayMs(3), BASE_MS * 4)
  assert.equal(nextDelayMs(4), BASE_MS * 8)
})

test('退避有上限，不能无限拉长到「实际上再也不重试」', () => {
  // 没有上限的话，连续失败几十次后间隔会变成几天——等于永久放弃，
  // 而链路恢复时没人会去戳它一下。
  assert.equal(nextDelayMs(99), MAX_MS)
  assert.ok(nextDelayMs(50) <= MAX_MS)
})

test('退避期内不得尝试；等够了才放行', () => {
  const lastAttemptAt = 10_000
  const d = nextDelayMs(3)
  assert.equal(shouldAttempt({ failures: 3, lastAttemptAt, now: lastAttemptAt + d - 1 }), false, '差 1ms 也不行')
  assert.equal(shouldAttempt({ failures: 3, lastAttemptAt, now: lastAttemptAt + d }), true)
})

test('成功一次即清零（failures 归 0）⇒ 立刻恢复正常节奏，不留惯性', () => {
  // 链路恢复后还按 10 分钟退避挪，spool 要排到天荒地老。
  assert.equal(nextDelayMs(0), 0)
  assert.equal(shouldAttempt({ failures: 0, lastAttemptAt: 999_999, now: 1_000_000 }), true)
})

test('非法输入不得把闸门焊死（NaN/负数一律按「可以试」处理）', () => {
  // fail-safe 方向必须是「放行」：算错了最多多试一次，
  // 算成永不放行就是把恢复路径彻底堵死（比 bug 本身更糟）。
  assert.equal(shouldAttempt({ failures: NaN, lastAttemptAt: NaN, now: 1000 }), true)
  assert.equal(shouldAttempt({ failures: -5, lastAttemptAt: 0, now: 0 }), true)
})
