// server/state-wire.js — /api/state 的线协议裁剪。纯函数、零依赖、可单测。
//
// 为什么存在：前端每 3 秒轮询 /api/state，跨境一次 6~16 秒。按字段拆开量（2026-08-12）：
//   firstPrompt 17.3KB(18.5%) · lastEvent 8.9KB(9.5%) · todoStats 2.6KB(2.7%)
//   合计占 sessions[] 的 30.8%，而**全仓库 grep 只有生产者、没有任何消费方**。
// 三成的会话载荷没人读，却每 3 秒跨境传一次。
//
// ★ 两条硬约束（都有单测钉着）：
//  ① **纯函数，绝不改动入参**——`firstPrompt` 服务端内部仍用于归属判断
//     （agent.js:545「专供归属判断用」）。就地删字段会静默把会话归错项目，且不报错。
//  ② 只裁 sessions[] 里这三个字段，其余原样透传——别顺手"优化"，
//     前端用哪些字段是 SessionCard.tsx 的 KEYS 与 lib/cost.ts 说了算。
//
// 加字段回来之前先问：前端真的读它吗？（`grep -rn "\b<字段>\b" web/src/`）

/** 不进线协议的会话字段。改这个列表 = 改线协议，必须同步确认前端无引用。 */
export const DROPPED_SESSION_FIELDS = ['firstPrompt', 'lastEvent', 'todoStats']

/**
 * 把内部 state 裁成可下发的线协议。输入不被修改。
 * 非对象/缺 sessions/非数组 一律安全返回（这是热路径，绝不能因为形态意外而抛）。
 */
export function stateToWire(state) {
  if (!state || typeof state !== 'object') return state
  const sessions = state.sessions
  if (!Array.isArray(sessions)) return state
  return {
    ...state,
    sessions: sessions.map((s) => {
      if (!s || typeof s !== 'object') return s
      const out = { ...s }
      for (const f of DROPPED_SESSION_FIELDS) delete out[f]
      return out
    }),
  }
}
