// 对外事件窗口：**对话消息与工具调用分开配额**。
//
// 为什么需要（2026-08-02 我自己制造的回归）：修好「Codex 的 exec 工具调用在对话流里全部隐形」
// 之后，工具调用终于进了事件流——但对外窗口是一刀切的 slice(-150)，而工具调用数量
// 天然碾压对话（实测某会话 611 次 exec vs 78 条对话）。结果窗口被工具调用占满：
//     改前 103 条 = user 13 + assistant 90（整段对话都在）
//     改后 150 条 = user  1 + assistant 19 + file_op 130（对话被挤出去了）
// 用户最初的抱怨就是「对话明显缺失」，我却让对话更看不见了。
//
// 根因不是数量，是**让两类内容抢同一个坑**。对话是主体、工具是佐证，配额必须分开：
// 先给对话保底名额，剩下的才给工具调用。
export const LIMIT = 150
export const MIN_MSG = 100

const isMsg = (e) => e?.type === 'user' || e?.type === 'assistant'

/**
 * @param {Array} events 全量事件（时间升序）
 * @returns 不超过 limit 条、且对话消息至少保留 min(minMsg, 实际条数) 条的子集，**保持原有顺序**
 */
export function windowEvents(events, { limit = LIMIT, minMsg = MIN_MSG } = {}) {
  if (!Array.isArray(events)) return []
  if (events.length <= limit) return events

  // ① 对话保底：取最近的 minMsg 条消息（不足则全要）
  const keep = new Set()
  const msgs = events.filter(isMsg)
  for (const e of msgs.slice(-Math.min(minMsg, limit))) keep.add(e)

  // ② 余额给工具调用等其余事件，同样取最近的
  const rest = limit - keep.size
  if (rest > 0) {
    const others = events.filter((e) => !keep.has(e))
    for (const e of others.slice(-rest)) keep.add(e)
  }

  // ③ 按原始顺序输出——绝不能在这里重排，事件流的时序是语义的一部分
  return events.filter((e) => keep.has(e))
}
