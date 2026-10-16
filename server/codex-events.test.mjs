import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCodexEvents } from './codex-events.js'
import { buildFrame, numCmp } from './event-seq.js'

const user = (id, ts, text, seq) => ({ id, ts, type: 'user', text, ...(seq == null ? {} : { seq }) })

test('实时 JSONL 与 driver 双源只显示一次，保留接管前历史', () => {
  const history = [user('old', 1, '旧问题'), user('disk-test', 110, 'test'), user('disk-question', 200, '整改')]
  const live = { events: [user('live-test', 100, 'test', 1), user('live-question', 190, '整改', 2)], firstSeq: 1, lastSeq: 2, todos: [] }
  const result = mergeCodexEvents(history, live)
  assert.deepEqual(result.events.map((e) => e.text), ['旧问题', 'test', '整改'])
  assert.equal(result.todos, live.todos)
  assert.equal(result.firstSeq, 1)
  assert.equal(result.lastSeq, 2)
  assert.equal(result.events[0].seq, -1)
  assert.deepEqual(buildFrame({ ...result, since: 1, cmp: numCmp }).events.map((e) => e.id), ['live-question'])
})

test('排队 80 秒才落盘仍去重；两次真实发送相同文本均保留', () => {
  const history = [user('h1', 81_000, '继续'), user('h2', 90_000, '继续')]
  const events = [user('l1', 1000, '继续', 1), user('l2', 2000, '继续', 2)]
  assert.deepEqual(mergeCodexEvents(history, { events }).events.map((e) => e.id), ['l1', 'l2'])
})

test('保留图片和流式输出；JSONL 追上后不重复助手回复', () => {
  const events = [{ ...user('l1', 100, '图片', 1), images: [{ url: '/image/1' }] }, { id: 'l2', ts: 120, type: 'assistant', text: '答复', streaming: true }]
  const history = [user('h1', 110, '图片'), { id: 'h2', ts: 150, type: 'assistant', text: '答复' }]
  const result = mergeCodexEvents(history, { events })
  assert.equal(result.events.length, 2)
  assert.deepEqual(result.events[0].images, events[0].images)
  assert.equal(result.events[1].streaming, true)
})

test('driver 留存窗口推进，旧事件转入 JSONL 后重置旧游标，避免旧 ID 残留', () => {
  const history = [user('h1', 110, '一'), user('h2', 210, '二')]
  const result = mergeCodexEvents(history, { events: [user('l2', 200, '二', 2)], firstSeq: 2, lastSeq: 2 })
  assert.deepEqual(result.events.map((e) => e.text), ['一', '二'])
  assert.equal(buildFrame({ ...result, since: 1, cmp: numCmp }).kind, 'snapshot')
})

test('历史尚未落盘时保留 driver 增量协议；无 driver 时仍返回历史', () => {
  const events = [user('l1', 100, '一', 1)]
  assert.equal(mergeCodexEvents([], { events }).lastSeq, 1)
  assert.deepEqual(mergeCodexEvents(events, { events: [] }).events, events)
})
