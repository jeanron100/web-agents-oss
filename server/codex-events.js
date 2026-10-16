import { seqBounds } from './event-seq.js'

/** JSONL supplies history before the retained live segment; the driver owns that segment.
 * App-server now writes JSONL while running. Its timestamps reflect processing time,
 * whereas queued user events in the driver reflect submission time. Matching by a
 * short time tolerance (or globally deduplicating text) therefore loses messages.
 */
export function mergeCodexEvents(history, live) {
  const h = history ?? []
  const l = live?.events ?? []
  if (!h.length || !l.length) {
    const events = l.length ? l : h
    return { ...live, events, ...seqBounds(events) }
  }
  const start = l[0].ts
  const prefix = h.filter((e) => e.ts < start)
  // Historical prefix is snapshot-only: negative sequence numbers cannot pass a
  // positive live cursor. Keep the driver cursor/window bounds so every delta
  // sends only new live events, and falling behind its retained window resets
  // the history. Never resend prefix IDs alongside already-retained driver IDs.
  const events = [...prefix.map((event, i) => ({ ...event, seq: i - prefix.length })), ...l]
  return { ...live, events, ...seqBounds(l) }
}
