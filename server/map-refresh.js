// server/map-refresh.js — 「会话 id 未映射」时的兜底刷新闸（P8）。
//
// agent.js 有 4 处 `if (!file) { await buildState(); ... }`，其中 SSE 那条在**每 300ms 的 tick**里。
// id 一直映射不上时就是 3.3 次全量 buildState/秒。P1/P6 之后 buildState 已降到 65 次 read()/55ms，
// 但持续下去仍吃约 18% 单核。
//
// ★ 不改映射结构、只加闸：同一 id 在窗口内只允许触发一次全量刷新。
//   为什么不干脆去掉兜底：冷启动顺序确实可能让 id 暂时没映射上，去掉会让"刚重启后点开会话"
//   直接 404。兜底要留，但不能每 300ms 敲一次。
export function createRefreshGate({ ttlMs = 5000, now = Date.now, max = 512 } = {}) {
  const seen = new Map() // id -> 上次放行时刻
  const gate = {
    allow(id) {
      const t = now()
      const last = seen.get(id)
      // age < 0 也放行：时钟回拨时若当成"刚试过"，这个 id 会被永久挡住。
      if (last !== undefined && t - last >= 0 && t - last < ttlMs) return false
      seen.set(id, t)
      // 条目数封顶：深链/扫描器/坏前端都可能带来大量不存在的 id，
      // 闸门自己变成泄漏源等于把小问题换成大问题。Map 保插入序，淘汰最旧。
      while (seen.size > max) seen.delete(seen.keys().next().value)
      return true
    },
    clear(id) { seen.delete(id) },
    get size() { return seen.size },
  }
  return gate
}
