// node --test server/usage-throttle.test.mjs
//
// Codex 额度探测的**节流不变量**。
//
// 事故（2026-08-05 实测，非推测）：前端 CodexUsageSummary.tsx 与 UsageRow.tsx **各自**
// `setInterval(load, 60_000)`，而 agent.js 的 `codexLimitsMemo` TTL 也正好是 `60_000`。
// 判据是 `Date.now() - memo.ts < 60_000`，两次请求间隔恰好 ≥60s ⇒ 恒为 false ⇒
// **memo 每次都被击穿**。于是只要有一个浏览器标签页开着 /stats，就每 60 秒 fan-out 到
// 5 台 agent、每台起一个短命 codex app-server 进程 —— 一天约 1440 轮 × 5 台 ≈ 7200 个
// 进程，不管有没有人在看。
//
// 这跟 forward-timeouts.js 记的 07-19 闸门事故是同一个形状：两个魔法数字之间存在
// **偏序要求**，但它只活在注释里、没人跟着调，于是其中一个被改动后另一个悄悄失效。
// 所以这里把它写成可测的偏序，而不是散落在两个文件里的常量：
//   **凡是节流窗口，都必须【严格长于】前端的轮询间隔。**
// 相等就等于没有节流 —— 这正是这次的病根。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldReprobe, shouldCacheAccounts,
  CODEX_MEMO_MS, CODEX_CACHE_TTL_SEC, UI_POLL_MS,
} from './usage-throttle.js'

test('★ 核心不变量：agent 侧 memo 窗口必须【严格长于】前端轮询间隔', () => {
  assert.ok(
    CODEX_MEMO_MS > UI_POLL_MS,
    `memo 窗口 ${CODEX_MEMO_MS}ms 必须 > 前端轮询 ${UI_POLL_MS}ms；` +
    '相等（旧值 60000/60000）意味着每次轮询都击穿 memo，节流形同虚设',
  )
})

test('★ 核心不变量：hub 侧 Redis 缓存 TTL 同样必须【严格长于】前端轮询间隔', () => {
  assert.ok(
    CODEX_CACHE_TTL_SEC * 1000 > UI_POLL_MS,
    `缓存 TTL ${CODEX_CACHE_TTL_SEC}s 必须 > 前端轮询 ${UI_POLL_MS}ms，否则缓存永远不命中`,
  )
})

test('窗口内的第二次请求不重新探测（这才是节流生效）', () => {
  assert.equal(shouldReprobe({ lastTs: 1_000, now: 1_000 + CODEX_MEMO_MS - 1 }), false)
})

test('达到窗口边界才重新探测', () => {
  assert.equal(shouldReprobe({ lastTs: 1_000, now: 1_000 + CODEX_MEMO_MS }), true)
})

test('从未探测过（lastTs=0）必须探测', () => {
  assert.equal(shouldReprobe({ lastTs: 0, now: 1 }), true)
})

test('★ 时钟回拨不能把节流卡死', () => {
  // 旧写法 `now - lastTs < WINDOW` 在 now < lastTs 时得到负数，负数恒 < 窗口
  // ⇒ 永远返回"不用探测" ⇒ 额度再也不刷新，且表面毫无异常（最坏的一种坏法）。
  // 跨机时钟不齐 / NTP 回拨都会触发。usage-cache.js 的 decide() 已经处理过同一问题。
  assert.equal(shouldReprobe({ lastTs: 5_000_000, now: 1_000 }), true)
})

test('窗口可注入，便于运维按机型调整而不改代码', () => {
  assert.equal(shouldReprobe({ lastTs: 0, now: 10, windowMs: 100 }), true)
  assert.equal(shouldReprobe({ lastTs: 10, now: 50, windowMs: 100 }), false)
})

// ── 缓存写入判据 ──
// 本项目栽过同型的坑（hub.js refreshAndStoreUsage 的注释）：探测失败时把陈旧值反复
// upsert 成"新数据"，于是 07-25 19:00 之后连续 6 个 3h 桶都是一模一样的 16，看着像还活着。
// 这里的等价失败模式是：5 台 agent 全部超时 ⇒ accounts=[] ⇒ 若把空数组缓存 5 分钟，
// 一次瞬时抖动就被放大成 5 分钟的"没有额度数据"，且 agent 恢复后**仍不自愈**（缓存还在）。
test('★ 空结果绝不写缓存——否则一次瞬时抖动被放大成 5 分钟的假空态', () => {
  assert.equal(shouldCacheAccounts([]), false)
})

test('拿不到数组（上游异常形态）同样不写缓存', () => {
  assert.equal(shouldCacheAccounts(null), false)
  assert.equal(shouldCacheAccounts(undefined), false)
  assert.equal(shouldCacheAccounts('oops'), false)
})

test('有真实账号数据才写缓存', () => {
  assert.equal(shouldCacheAccounts([{ accountId: 'acc_1', primary: { pct: 12 } }]), true)
})
