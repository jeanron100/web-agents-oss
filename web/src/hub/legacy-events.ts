import type { ChatEvent } from '../types'

/** Older agents replay unsequenced disk history as if it were a streaming tail.
 * Reconstruct a snapshot while those agents wait for a safe restart. Never sort
 * the whole conversation by timestamps: tool results can retain older times.
 */
export function repairLegacyEvents(incoming: ChatEvent[], existing: ChatEvent[], append: boolean): ChatEvent[] | null {
  const history = incoming.filter(e => e.seq == null && /^(rollout-|kw-)/.test(e.id))
  if (!history.length) return null
  const codex = history[0].id.startsWith('rollout-')
  const live = new Map<string, ChatEvent>()
  if (append) for (const e of existing) {
    if (e.id.startsWith('ev-') && e.seq != null) live.set(e.id, e)
  }
  for (const e of incoming) if (e.id.startsWith('ev-')) live.set(e.id, e)
  const tail = [...live.values()]
  if (!tail.length) return history
  if (codex) return [...history.filter(e => e.ts < tail[0].ts), ...tail]
  // Kimi wire is authoritative; drop live IDs once their content lands on disk.
  const key = (e: ChatEvent) => e.type === 'file_op'
    ? `${e.type}|${e.verb}|${e.path}` : `${e.type}|${'text' in e ? e.text.replace(/\s+/g, ' ').trim() : ''}`
  const keys = new Set(history.slice(-12).map(key))
  const lastTs = history.at(-1)!.ts
  return [...history, ...tail.filter(e => !keys.has(key(e)) &&
    (('streaming' in e && e.streaming) || e.ts > lastTs + 1500))]
}
