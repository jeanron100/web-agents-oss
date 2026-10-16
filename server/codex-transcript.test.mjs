import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexAssistantMessage } from './codex-transcript.js'
const row = (source, text, ts = 1000) => ({ timestamp: new Date(ts).toISOString(), type: source === 'message' ? 'response_item' : 'event_msg', payload: source === 'message' ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } : { type: 'agent_message', message: text } })
test('新版 response_item 回复可见，旧版 agent_message 仍兼容', () => {
  assert.equal(codexAssistantMessage(row('message', '已完成'), {}), '已完成')
  assert.equal(codexAssistantMessage(row('event', '已完成'), {}), '已完成')
})
test('跨检查点双格式去重，不吞掉下一次相同回复', () => {
  for (const [first, second] of [['message', 'event'], ['event', 'message']]) {
    const state = {}
    assert.equal(codexAssistantMessage(row(first, '好的'), state), '好的')
    const resumed = JSON.parse(JSON.stringify(state))
    assert.equal(codexAssistantMessage(row(second, '好的', 1100), resumed), null)
    assert.equal(codexAssistantMessage(row(first, '好的', 1200), resumed), '好的')
  }
})
test('同格式两条相同文本保留；系统和用户消息不当助手显示', () => {
  const state = {}
  assert.equal(codexAssistantMessage(row('message', '好的'), state), '好的')
  assert.equal(codexAssistantMessage(row('message', '好的', 1100), state), '好的')
  assert.equal(codexAssistantMessage({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } }, state), null)
})
