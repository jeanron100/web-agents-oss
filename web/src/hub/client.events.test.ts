import { afterEach, it, expect, vi } from 'vitest'
import { useAppStore } from '../store/store'
import { syncSessionEvents } from './client'

afterEach(() => vi.unstubAllGlobals())

it('Kimi 旧 snapshot → append → 落盘 snapshot 不重复、不把历史接到末尾', async () => {
  const id = 'kimi-order-regression'
  useAppStore.setState({ source: 'live', events: {}, extras: {} })
  const h = { id: 'kw-1', type: 'user', text: '旧问题', ts: 100 }
  const a = { id: 'ev-a', type: 'assistant', text: '回答', ts: 3000, seq: 1 }
  const u = { id: 'ev-u', type: 'user', text: '下一问', ts: 6000, seq: 2 }
  const frames = [
    { kind: 'snapshot', events: [h, a], lastSeq: 1 },
    { kind: 'append', events: [u, h], lastSeq: 2 },
    { kind: 'snapshot', events: [h, { ...a, id: 'kw-2', seq: undefined }, { ...u, id: 'kw-3', seq: undefined }], lastSeq: null },
    { kind: 'snapshot', events: [h], lastSeq: null },
  ]
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => frames.shift() }))
  vi.stubGlobal('fetch', fetcher)
  await syncSessionEvents(id)
  await syncSessionEvents(id)
  expect(useAppStore.getState().events[id].map(e => e.id)).toEqual(['kw-1', 'ev-a', 'ev-u'])
  await syncSessionEvents(id)
  expect(useAppStore.getState().events[id].map(e => e.id)).toEqual(['kw-1', 'kw-2', 'kw-3'])
  await syncSessionEvents(id)
  expect(fetcher.mock.calls.at(-1)).toEqual([`/api/session/${id}/events`, { signal: undefined }])
})
