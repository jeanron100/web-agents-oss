// server/session-census.js — 会话普查（2026-08-30 事故整改 R6）。纯函数。
//
// ★★ 为什么需要它：复盘说「你名下挂着 9 个会话」，而**真实在跑的只有 4 个**。
//   平台记录里混着 `detached: true` 的可恢复身份——它们是 agent 重启后按 store 别名重建的，
//   state 从 JSONL mtime + /proc 实时重算，`inflight: false`，
//   **不占内存、不占槽位、永不阻塞排空与部署**。
//   把两者混在一个计数里，**故障时看到的规模就是虚高的**：你以为要清 9 个，实际只有 4 个占内存。
//
// ⚠️ 容量判断（还能不能再起一个）**只能看 platformLive**，把幽灵算进去会让准入闸误判。

const ACTIVE = new Set(['running', 'waiting_approval', 'waiting_input'])

export function census(sessions) {
  const out = {
    total: 0, platformLive: 0, platformDetached: 0, platformActive: 0, shadow: 0,
    memoryHolders: 0, byEngine: {},
  }
  for (const s of sessions ?? []) {
    out.total += 1
    const e = s?.engine || 'unknown'
    out.byEngine[e] = (out.byEngine[e] ?? 0) + 1
    if (s?.origin !== 'platform') { out.shadow += 1; continue }
    if (s?.detached) { out.platformDetached += 1; continue }
    out.platformLive += 1
    if (ACTIVE.has(s?.state)) out.platformActive += 1
  }
  // 只有真实在跑的平台会话才持有子进程内存 —— 这个别名是为了让调用方不容易用错。
  out.memoryHolders = out.platformLive
  return out
}
