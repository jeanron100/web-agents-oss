// server/usage-throttle.js — Codex 额度探测的节流常量与判据。纯函数、零依赖、可单测。
//
// 为什么单独成一个模块：这里的两个常量与**前端轮询间隔**之间存在偏序要求
// （节流窗口必须严格长于轮询间隔），而它们分别住在 agent.js、hub.js、以及前端两个组件里。
// 偏序只写在注释里是留不住的——forward-timeouts.js 记的 07-19 闸门事故就是这么发生的：
// 闸门排队上限从 15s 调到 45s，没人跟着调 hub 的转发超时，于是那条 503 永远送不到用户手里。
// 所以把它提出来，用 usage-throttle.test.mjs 把偏序钉死。
//
// 病根（2026-08-05 实测）：前端 CodexUsageSummary.tsx:129 与 UsageRow.tsx:72 **各自**
// `setInterval(load, 60_000)`，而 agent.js 的 codexLimitsMemo 窗口也正好 60_000。
// 两次请求间隔恰好 ≥60s ⇒ `now - ts < 60_000` 恒为 false ⇒ memo 每次都击穿 ⇒
// 只要有一个标签页开着 /stats，就每分钟 fan-out 5 台、每台起一个短命 codex app-server。
// **窗口与轮询间隔相等 = 没有节流。**

/** 前端轮询 Codex 额度的间隔。改前端就要改这里——它是下面两个窗口的下界。 */
export const UI_POLL_MS = 60_000

/** agent 侧进程内 memo 窗口。必须 > UI_POLL_MS。 */
export const CODEX_MEMO_MS = Number(process.env.WA_CODEX_MEMO_MS) || 5 * 60_000

/** hub 侧 Redis 缓存留存期（秒）。必须 > UI_POLL_MS。
 *  额度是**周窗**慢变量，5 分钟的新鲜度绰绰有余；而 Claude/Kimi 用的 24h 在这里是有害的
 *  ——Codex 没有后台定时刷新，24h TTL 会让页面显示一天前的额度。 */
export const CODEX_CACHE_TTL_SEC = Number(process.env.WA_CODEX_CACHE_TTL_SEC) || 5 * 60

/**
 * 该不该重新探测。
 * 三条边界都不是可选项：
 *  ① `lastTs` 为假 = 从未探测过 —— 显式判定，不依赖「now 是真实 epoch 所以 age 很大」这种巧合；
 *  ② age < 0 = 时钟回拨/跨机不齐 —— 旧写法 `now - lastTs < WINDOW` 会把负数判成"还在窗口内"，
 *     于是**永远不再探测**、额度再也不刷新，且表面毫无异常（最坏的一种坏法）；
 *  ③ age >= windowMs 才探测（取 >=，与"窗口内不探测"互补，边界不重不漏）。
 */
/**
 * 该不该把这批账号数据写进缓存。
 * **空结果绝不写**：5 台 agent 全超时会得到 []，若把它缓存 5 分钟，一次瞬时抖动就被
 * 放大成 5 分钟的"没有额度数据"，且 agent 恢复后仍不自愈（缓存还压着）。
 * 同 hub.js refreshAndStoreUsage 的「探测失败不写库」——那次是把陈旧值反复 upsert 成
 * 新数据，导致连续 6 个时间桶显示一模一样的值、看着像还活着。
 */
export function shouldCacheAccounts(accounts) {
  return Array.isArray(accounts) && accounts.length > 0
}

export function shouldReprobe({ lastTs, now, windowMs = CODEX_MEMO_MS }) {
  if (!lastTs) return true
  const age = now - lastTs
  if (age < 0) return true
  return age >= windowMs
}
