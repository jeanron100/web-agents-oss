// server/mcp/filters.js
// stuck 判据必须写死在服务端——不能让 LLM 自己发明"卡住"的定义，否则同一个问题
// 在不同调用里得到不同答案。口径与 session-reaper.js 对齐，但**不共用阈值变量**：
// 回收是破坏性动作，观测不是，两者该能独立调。

import { parseEnvNumber } from './wire.js'

// 全仓最 load-bearing 的常量之一：STUCK_IDLE_MS 一旦是 NaN，isStuck() 的
// `(nowMs - last) >= idleMs` 对任何输入都是 false——垃圾 env 值会让每个工具
// 都报"全员正常"的假消息。旁边两个常量都走 parseEnvNumber，这里当年漏了，
// 补齐同一条纪律（parseEnvNumber 拒绝 NaN/负数/0/Infinity，垃圾值回落默认值）。
export const STUCK_IDLE_MS = parseEnvNumber('WA_MCP_STUCK_IDLE_MS', 30 * 60_000)
// 真实翻车现场（2026-07-20 用 session_find 默认参数实测）：
//   019e59a0 srv-177-188 tiny_yurts    idle idle=80968min（56 天前）
//   019e8faa srv-189-4   agent_office  idle idle=66982min（46 天前）
// 这些"化石会话"满足 isStuck 的全部旧判据（不在飞、不分离、不等人、idle>=30min），
// 于是被报成"卡住"——但 56 天前的会话不是"本该推进却没推进"，是早该被遗忘的历史。
// "卡住"只在近期窗口内才有意义：超过这个窗口就不再是故障态，继续算 stuck 只会让
// 十几条真正卡住的会话被几十条化石淹没（现场：22 条 stuck，绝大多数几周甚至几个月前）。
// 同 STUCK_IDLE_MS 一样必须走 parseEnvNumber——裸 Number(...) 遇到垃圾 env 值会得到
// NaN，而 `idle <= maxIdleMs` 对 NaN 恒为 false，会悄悄把这道上界焊死成"从不算 stuck"。
export const STUCK_MAX_IDLE_MS = parseEnvNumber('WA_MCP_STUCK_MAX_IDLE_MS', 24 * 60 * 60_000)
const DEFAULT_LIMIT = parseEnvNumber('WA_MCP_FIND_LIMIT', 20)
const MAX_LIMIT = parseEnvNumber('WA_MCP_FIND_MAX', 100)

/**
 * 规范 limit 参数。调用方（LLM）传来的 limit 可能乱七八糟，必须在服务端硬卡。
 * 默认值不是上限——Math.max(1, limit) 只当了下界，LLM 能通过巨大 limit 绕过上限护栏。
 * 本函数确保：未指定/无效 → DEFAULT_LIMIT；超过 MAX_LIMIT → MAX_LIMIT；否则用指定值。
 */
function normalizeLimit(limit) {
  // 未指定、null、undefined、非有限数（NaN 等）→ 默认值
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT
  // <= 0 → 默认值（零条结果永远不是"我想要的数量"的合理解释）
  if (limit <= 0) return DEFAULT_LIMIT
  // 超过上限 → 上限
  if (limit > MAX_LIMIT) return MAX_LIMIT
  // 合理值 → 原样返回
  return limit
}

/**
 * 等人 ≠ 卡住。inflight 优先于任何时长证据。
 * 已分离会话 ≠ 卡住：detached=true 表示 agent 进程已退出，记录仅供历史回看。
 * 没有运行的进程谈不上"卡住"——这是设计释放态，非故障态。
 * 现场计数（2026-07-20）：38 平台会话记录，31 已分离(detached)，7 活跃；
 * 不过滤会导致报告 34 stuck（31 分离+1 真实活跃），实际应为 1。
 *
 * "卡住"还必须有上界（STUCK_MAX_IDLE_MS，默认 24 小时）：idle 是
 * `[idleMs, maxIdleMs]` 的闭区间，而不是"超过下限就一直算数"的开区间。
 * 现场证据见 STUCK_MAX_IDLE_MS 定义处的 56 天化石会话——那类记录不是故障，
 * 是早该被遗忘的历史，继续计入 stuck 只会把真正卡住的会话淹没在化石堆里。
 */
export function isStuck(s, nowMs = Date.now(), idleMs = STUCK_IDLE_MS, maxIdleMs = STUCK_MAX_IDLE_MS) {
  if (s?.inflight) return false
  if (s?.detached) return false
  if (s?.state === 'waiting_approval' || s?.state === 'waiting_input') return false
  const last = s?.lastActiveAt || s?.startedAt || nowMs
  const idle = nowMs - last
  return idle >= idleMs && idle <= maxIdleMs
}

export function findSessions(sessions, opts = {}, nowMs = Date.now()) {
  const { serverId, project, engine, state, stuck, minIdleMin, limit } = opts
  const normalizedLimit = normalizeLimit(limit)
  const idleMinOf = (s) => (nowMs - (s.lastActiveAt || s.startedAt || nowMs)) / 60_000
  const out = (sessions ?? []).filter((s) => {
    if (serverId && s.serverId !== serverId) return false
    if (project && s.project !== project) return false
    if (engine && s.engine !== engine) return false
    if (state && s.state !== state) return false
    if (minIdleMin != null && idleMinOf(s) < minIdleMin) return false
    if (stuck && !isStuck(s, nowMs)) return false
    return true
  })
  // 排序方向依查询意图而定，两者不可共用同一个排序——
  // 真实翻车现场（2026-07-20，session_find 默认参数）：
  //   019e59a0 srv-177-188 tiny_yurts    idle idle=80968min（56 天前）
  //   019e8faa srv-189-4   agent_office  idle idle=66982min（46 天前）
  // 旧实现无条件按空闲降序排，"这个舰队现在什么状况"这种默认查询也用这个顺序，
  // 结果 20 条上限被几个月前的历史化石占满，真正"现在正发生的事"被挤出结果之外——
  // 问的是"发生了什么"，答案却成了考古报告。
  if (stuck) {
    // stuck=true 是故障分诊：空闲越久越该被优先看到，worst-first 是正确顺序，保留原判断。
    out.sort((a, b) => idleMinOf(b) - idleMinOf(a))
  } else {
    // 其余任何查询（含无过滤条件）：按最近活跃优先排序，"最近"才是"现在什么状况"的正确答案。
    out.sort((a, b) => idleMinOf(a) - idleMinOf(b))
  }
  return out.slice(0, normalizedLimit)
}
