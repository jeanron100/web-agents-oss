// server/memory-admit.js — 内存准入判据（2026-08-30 事故整改 R2）。纯函数，可单测。
//
// 事故：单会话稳定占 200~350MB，而 .232 可用内存不足 1.5G，闸门却只按**条数**放到 9 个。
// 到达率长期大于完成率 ⇒ 必然崩：worker slice 匿名 1353M + swap 1276M = 2.63G（整机 73%）。
//
// ★★ 最关键的一条：**cgroup v2 的 `memory.max` 不统计 swap**（CLAUDE.md 已记过同族教训）。
//   事故里撞了 231 万次限制却只 OOM-kill 掉 2 个，正因为压力全额外溢到全局 swap，
//   把整机拖垮而硬限"看起来没被突破"。
//   ⇒ 判余量时**必须把 swap 计入已用**，只看 `memory.current` 会得出"还很宽裕"的错觉。

/** 单会话内存成本的兜底估值（实测 200~350MB，取中位偏上）。 */
export const DEFAULT_SESSION_COST = 300 * 1048576
/** 余量安全系数：要留出 均值 × 1.5 才放行，别卡着线起。 */
export const HEADROOM_FACTOR = 1.5

const num = (v) => {
  const n = typeof v === 'string' ? (v === 'max' ? Infinity : Number(v)) : Number(v)
  return Number.isFinite(n) || n === Infinity ? n : NaN
}

/**
 * 能否再派生一个会话。
 *
 * @param cgroup { current, swapCurrent, max }  —— 由调用方从 cgroupfs 读好传进来（便于单测）
 * @param avgSessionBytes 实测单会话均值；缺失/非法时用 DEFAULT_SESSION_COST
 *
 * ⚠️ fail-safe 方向与回收器**相反**：读不到 cgroup 时**放行**。
 *   理由：这里拒绝的代价是"平台完全不能新建会话"，探测一坏就全线瘫痪；
 *   而多起一个会话的代价有条数闸与 cgroup 硬限兜底。
 *   （回收器那边相反：证据不全就不动手，因为误杀不可逆。**方向要按代价来定，不是抄一个模板。**）
 */
export function admitDecision({ cgroup, avgSessionBytes } = {}) {
  const per = (() => {
    const n = Number(avgSessionBytes)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_COST
  })()
  const need = per * HEADROOM_FACTOR

  const cur = num(cgroup?.current)
  const swap = Number.isFinite(Number(cgroup?.swapCurrent)) ? Number(cgroup.swapCurrent) : 0
  const max = num(cgroup?.max)

  if (!Number.isFinite(cur) || Number.isNaN(max)) {
    return { admit: true, need, reason: '读不到 cgroup 内存读数，无法判定余量（放行，交给条数闸与硬限兜底）' }
  }
  if (max === Infinity) {
    return { admit: true, need, usedBytes: cur + swap, reason: '该 cgroup 无内存硬限，不按余量拦截' }
  }

  const usedBytes = cur + swap        // ★ swap 必须计入：memory.max 不统计它
  const freeBytes = max - usedBytes
  if (freeBytes >= need) {
    return { admit: true, need, usedBytes, freeBytes }
  }
  return {
    admit: false, need, usedBytes, freeBytes,
    reason: `余量 ${Math.round(freeBytes / 1048576)}MB 不足单会话均值×${HEADROOM_FACTOR}（${Math.round(need / 1048576)}MB）`
      + `；已用 ${Math.round(usedBytes / 1048576)}MB（含 swap ${Math.round(swap / 1048576)}MB）/ 上限 ${Math.round(max / 1048576)}MB`,
  }
}
