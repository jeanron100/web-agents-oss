// server/archive-context.js — 匹配处的对话上下文（2026-08-31 用户实测反馈第二轮）。纯函数。
//
// ★★ 为什么需要它：用户搜自己问过的一句话，片段出来了，但**展开之后看到的是
//   会话开头 8 行 + 36 条 shell 命令** —— 他想看的是「这个问题当时是怎么回答的」。
//   根因：`/api/archive/session` 返回 `lines.slice(0, limit)`，也就是**会话开头 N 行**；
//   而那条会话有 **14,391 行**，匹配在中后段，开头当然什么都看不到。
//
// ★ 一般化：检索类功能里，「命中」只是入口，**用户真正要的是命中处的上下文**。
//   给开头、给统计、给命令清单，都不是他要的那个答案。

/** 前后各留几条。给太多在跨境链路上就是负担（首屏字节是硬指标）。 */
const BEFORE = 2
const AFTER = 6            // 后面给多一点 —— 用户要的是**回答**，答案在提问之后
const TEXT_MAX = 1500

const clip = (s) => {
  const t = String(s ?? '')
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t
}

/** 把一行 JSONL 解析成 {role, text, ts}；解析不了返回 null（坏行不得让整体崩掉）。 */
function toMessage(line, engine) {
  let o
  try { o = JSON.parse(line) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const ts = o.timestamp || o.time || o.ts || o.created_at || null

  // Claude：{ type:'user'|'assistant', message:{ role, content:[{type:'text',text}] } }
  const m = o.message
  if (m && (m.role === 'user' || m.role === 'assistant')) {
    const c = m.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.filter((x) => x?.type === 'text' && x.text).map((x) => x.text).join('\n')
    if (!text.trim()) return null                 // 纯工具调用行不进对话上下文
    return { role: m.role, text: clip(text), ts }
  }
  // Codex / Kimi：扁平结构
  if (o.type === 'agent_message' && o.message) return { role: 'assistant', text: clip(o.message), ts }
  if (o.type === 'user_message' && o.message) return { role: 'user', text: clip(o.message), ts }
  if ((o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string' && o.content.trim()) {
    return { role: o.role, text: clip(o.content), ts }
  }
  return null
}

/**
 * 取匹配处前后的对话。
 *
 * @param lines 该会话的原始 JSONL 行
 * @param q     检索词（可空）
 * @returns { messages: [{role, text, ts, matched}], total, at }
 *
 * ⚠️ 没有关键词、或关键词落在命令/文件上（对话里搜不到）时，退回**会话结尾**而不是开头：
 *   结尾是「最后干到哪了」，开头只是「当初怎么起的头」——后者几乎没有回看价值。
 */
export function conversationAround(lines, { q = '', engine = 'claude' } = {}) {
  const msgs = []
  for (const l of lines ?? []) {
    const m = toMessage(l, engine)
    if (m) msgs.push(m)
  }
  if (!msgs.length) return { messages: [], total: 0, at: -1 }

  const key = String(q ?? '').trim().toLowerCase()
  let at = -1
  if (key) at = msgs.findIndex((m) => m.text.toLowerCase().includes(key))
  // 搜不到（或没给词）⇒ 落到结尾，而不是开头
  if (at < 0) at = msgs.length - 1

  const start = Math.max(0, at - BEFORE)
  const end = Math.min(msgs.length, at + AFTER + 1)
  return {
    messages: msgs.slice(start, end).map((m, i) => ({ ...m, matched: key ? start + i === at : false })),
    total: msgs.length,
    at,
  }
}
