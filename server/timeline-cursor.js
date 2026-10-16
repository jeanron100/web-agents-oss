// 「执行历史」时间线的翻页游标（纯函数，可离线单测）。
//
// 2026-08-03：ExecTrace 只取会话**最近** 800 条事件，更早的看不到，且界面不说自己被截断了
// （实测 ps-ms1k8aom-3092 共 1811 条，头部却显示「92 个回合」，读起来像全集）。与
// session-allocate.js 记录的是同一类错误：**截断不能是静默的**。这里给它一个往前翻的出口。
//
// ★ 游标为什么必须是复合的 (occurredAt, eventKey)：
//   同一 occurredAt（毫秒）下有多条事件是**常态**——JSONL 扫描成批产出的事件共享同一个 ts。
//   若只用时间戳翻页：
//       { occurredAt: { $lt: t } }
//   那么边界那一毫秒里**剩下的事件会被整批跳过**，而且跳得没有规律（取决于这一毫秒恰好有几条、
//   分页边界恰好落在第几条），事后极难复现。所以必须把 eventKey 作为同毫秒内的次级序。

const SEP = '_'

/** 事件 → 游标串。返回 null 表示这条事件不能作游标（缺字段）。 */
export function encodeCursor(ev) {
  if (!ev?.occurredAt || !ev?.eventKey) return null
  return `${ev.occurredAt}${SEP}${ev.eventKey}`
}

/**
 * 游标串 → { occurredAt, eventKey }；任何脏输入一律 null（调用方退化成首页，绝不抛）。
 * ⚠️ 只按**第一个**分隔符切：eventKey 由 serverId/engine/seq 拼成，自身可能含 `_`
 *   （如 srv_178_232|claude|99_100），用 split('_') 会把它切碎。
 */
export function decodeCursor(str) {
  if (typeof str !== 'string') return null
  const s = str.trim()
  if (!s) return null
  const i = s.indexOf(SEP)
  if (i <= 0) return null                       // 没有分隔符，或时间戳为空
  const occurredAt = s.slice(0, i)
  const eventKey = s.slice(i + SEP.length)
  if (!occurredAt || !eventKey) return null
  return { occurredAt, eventKey }
}

/**
 * 构造某会话「比游标更早」的 Mongo 查询条件。
 * 配 sort({ occurredAt: -1, eventKey: -1 }) 使用，仍走 {sessionId:1, occurredAt:1} 索引前缀。
 * @param cursor decodeCursor 的结果；null = 首页
 */
export function cursorFilter(sessionId, cursor) {
  if (!cursor?.occurredAt || !cursor?.eventKey) return { sessionId }
  return {
    sessionId,
    $or: [
      { occurredAt: { $lt: cursor.occurredAt } },                                  // 更早的毫秒
      { occurredAt: cursor.occurredAt, eventKey: { $lt: cursor.eventKey } },       // 同毫秒里更靠前的
    ],
  }
}
