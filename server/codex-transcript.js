// Old rollouts emit agent_message; current CLI emits response_item/message.
// Some versions emit both. Pair only adjacent representations of the same reply,
// preserving repeated replies and carrying the pairing state across checkpoints.
export function codexAssistantMessage(row, state) {
  const p = row.payload ?? {}
  const source = row.type === 'response_item' && p.type === 'message' && p.role === 'assistant'
    ? 'message' : row.type === 'event_msg' && p.type === 'agent_message' ? 'event' : null
  if (!source) return null
  const text = source === 'message'
    ? (p.content ?? []).filter((c) => c.type === 'output_text' || c.type === 'text').map((c) => c.text ?? '').join('\n').trim()
    : String(p.message ?? '').trim()
  if (!text) return null
  const ts = Date.parse(row.timestamp) || 0
  const previous = state.codexAssistantPair
  if (previous && previous.source !== source && previous.text === text && Math.abs(ts - previous.ts) < 10_000) {
    state.codexAssistantPair = null
    return null
  }
  state.codexAssistantPair = { source, text, ts }
  return text
}
