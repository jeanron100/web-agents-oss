// server/forward-timeouts.js — hub→agent 转发超时策略。纯函数，单测见 forward-timeouts.test.mjs。
//
// ⚠️ 一条送不到的错误消息，等于没有这条消息。
//
// 事故（2026-07-19）：232 的会话闸门（session-gate.js）焊死在 8/8，用户新建/恢复会话全「超时」。
// 闸门其实回的是一条很有用的 503：`{error:'等待空闲会话槽位超时（当前 8/8 已满，排队第 2 位）',
// code:'QUEUE_TIMEOUT', active, max, position, retryAfterMs}`。前端本可以照着它显示
// 「并发已满，排队第 2 位」并自动退避。
//
// 但用户一次都没看到过——闸门要等 queueWaitMs=45s 才放弃，hub 的 forward() 却固定 15s 就 abort，
// 于是每次都先塌成 504「节点响应超时（结果未知）」。系统知道真因，却结构性地说不出口。
//
// 07-18 的审批事故（见 forward-error.js）已经踩过一模一样的坑，当时把 /api/action 放宽到 30s
// 修好了；但**派生路径的闸门等 45s，错得更多，却没人跟着调**。所以这次不再散落魔法数字，
// 而是把它写成一条可测的不变量：
//
//   凡是会被闸门排队的路径，hub 的等待必须【严格长于】闸门的排队上限。
//
// 别把这里的超时理解为"性能预算"——它是"让上游把话说完的耐心"。

/** 普通写操作：不排队，等久了只是白白拖着用户。 */
export const DEFAULT_FORWARD_MS = 15_000

/** 审批：resolveAction 是 O(1) 内存操作，迟到只可能是 agent 事件循环排队（07-18 事故结论）。 */
export const ACTION_FORWARD_MS = Number(process.env.WA_ACTION_FORWARD_MS || 30_000)

/**
 * 闸门排队上限，**必须与 agent 侧 WA_SPAWN_QUEUE_WAIT_MS 保持一致**。
 * agent 把生效值放在 /api/state 的 server.sessionGate.queueWaitMs 里，便于核对漂移。
 */
export const GATE_QUEUE_WAIT_MS = Number(process.env.WA_SPAWN_QUEUE_WAIT_MS || 45_000)

/** 留给上游把 503 组装好并回写的余量。只要 >0 即可，不必大。 */
export const SPAWN_GRACE_MS = 5_000

/** 会被闸门排队的三条派生路径（对应 agent.js 里走 spawnGated() 的分支）。
 *  注：曾有第四条 `/review`，随该死接口于 2026-08-04 一并删除。 */
const SPAWN_RE = /^\/api\/session(\/[\w-]+\/(reattach|takeover))?$/

export function isSpawnPath(pathName) {
  return typeof pathName === 'string' && SPAWN_RE.test(pathName)
}

/**
 * 该路径应该等上游多久。
 * @param pathName 转发的路径（hub 侧原样的 url.pathname）
 * @param opts.gateQueueWaitMs 闸门排队上限（默认取 GATE_QUEUE_WAIT_MS，可注入便于测试/调优）
 */
export function forwardTimeoutMs(pathName, { gateQueueWaitMs = GATE_QUEUE_WAIT_MS } = {}) {
  if (isSpawnPath(pathName)) return gateQueueWaitMs + SPAWN_GRACE_MS
  if (typeof pathName === 'string' && pathName.startsWith('/api/action/')) return ACTION_FORWARD_MS
  return DEFAULT_FORWARD_MS
}
