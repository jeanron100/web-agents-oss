// server/dir-memo.js — 文件发现的短 memo（P6）。
//
// 为什么（2026-08-13 在 .232 strace 归因）：改完 /proc 索引化与 Codex 增量之后再量一次，
// 3 次 /api/state 期间 openat 分布是 `.jsonl` 10 次 / `/proc/*` 1,225 次 / **其它 10,098 次**，
// 其它里的头名是 `/root/.claude/projects` 与 `/root/.codex/sessions/2026/*`
// ⇒ 每次 buildState 都在递归遍历整棵日期目录树，而 listCodexFiles()/discoverProjects()
//   一个缓存都没有。10,098÷3 ≈ 3,366/次，正好是 P1 修完后剩下的缺口。
//
// ★ 窗口取舍：目录变化 = 新会话文件出现。窗口太长 ⇒ 新会话延迟上榜。
//   取 5 秒——前端本来就 3 秒轮询，多等一拍感知不到；收益是把递归遍历
//   从「每次 buildState」降到「每 5 秒一次」。

/**
 * 给纯读取型的昂贵函数套一层 TTL memo。
 * @param {() => T} fn
 * @param {{ttlMs?: number, now?: () => number}} o
 * @returns {(() => T) & {invalidate: () => void}}
 */
export function createTtlMemo(fn, { ttlMs = 5000, now = Date.now } = {}) {
  let cached
  let at = 0
  let has = false
  const memo = () => {
    const t = now()
    const age = t - at
    // age < 0 也要重算：时钟回拨时若当成"还新鲜"，缓存会被永久钉死。
    if (has && ttlMs > 0 && age >= 0 && age < ttlMs) return cached
    // ⚠️ 抛异常不缓存——目录一时读不到（权限/挂载抖动）不该被记住整个窗口，
    //    那会把瞬时故障放大成持续故障。
    const v = fn()
    cached = v; at = t; has = true
    return v
  }
  memo.invalidate = () => { has = false; at = 0 }
  return memo
}
