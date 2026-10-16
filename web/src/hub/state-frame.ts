// state-frame.ts — /api/state 三态帧（snapshot / delta / reset）的客户端合并。
//
// 服务端对应实现：server/state-delta.js（那边还有指纹与差异计算，依赖 node:crypto，
// 进不了浏览器，所以这里**只实现合并这一半**）。两边的帧语义必须一致，改协议要同时改。
//
// 为什么有增量（2026-08-20 实测）：/api/state 53.5KB 原始 / 17KB gzip，每 3 秒一次，
// 而 20 拍采样里 **18/19 拍零变化**。跨境链路上这份 17KB 要 p50 4.43s / p90 10.57s / max 16.02s，
// 尾部越过 POLL_TIMEOUT_MS=20s 被 abort（nginx 记 499）⇒ 连续 4 次 ⇒ 「与服务器失联 100 秒」。

export type StateFrameKind = 'snapshot' | 'delta' | 'reset'

export interface StateFrame {
  frame?: string
  cursor?: string
  sessions?: unknown[]
  changed?: unknown[]
  removed?: string[]
  [k: string]: unknown
}

/**
 * 把一帧合并进本地会话列表，返回**新数组**（不改入参）。
 *
 * ★ 三条不可省的语义：
 *  ① `delta` 只带变化的会话，**删除必须靠 `removed` 显式列出**——客户端若用
 *     「本次没出现 ⇒ 删除」推断，就无法区分「会话没了」和「本次是增量所以没带它」。
 *     这是增量协议最经典的塌陷点。
 *  ② `snapshot` / `reset` 整份替换。
 *  ③ **未知帧类型按 snapshot 兜底**：宁可整份替换，也不要静默丢数据。
 *     协议以后加新帧类型时，老前端会走到这里——安全的默认值必须是"多做"而不是"少做"。
 */
export function mergeStateFrame<T extends { id: string }>(localSessions: T[], frame: StateFrame): T[] {
  if (frame?.frame !== 'delta') {
    return Array.isArray(frame?.sessions) ? ([...frame.sessions] as T[]) : []
  }
  const map = new Map<string, T>()
  for (const s of localSessions ?? []) map.set(s.id, s)
  for (const id of frame.removed ?? []) map.delete(id)
  for (const s of (frame.changed ?? []) as T[]) map.set(s.id, s)
  return [...map.values()]
}

/** 这一帧是否要求丢弃本地游标（reset / 服务端回落 snapshot 都算重新对齐）。 */
export function isFullFrame(frame: StateFrame): boolean {
  return frame?.frame !== 'delta'
}
