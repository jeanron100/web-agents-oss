// 匹配处的对话上下文（2026-08-31 用户实测反馈第二轮）。
//
// 用户搜自己问过的一句话，片段出来了，但**展开之后看到的是会话开头 8 行 + 36 条 shell 命令**
// ⇒ 他想看的是「**这个问题当时是怎么回答的**」，拿到的却是一堆命令。
//
// ★★ 根因：`/api/archive/session` 返回 `lines.slice(0, limit)` —— **会话开头 N 行**。
//   而那条会话有 **14,391 行**，匹配在中后段，开头当然什么都看不到。
//
// ★ 一般化：检索类功能里，「命中」只是入口，**用户真正要的是命中处的上下文**。
//   给开头、给统计、给命令清单，都不是他要的那个答案。

import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationAround } from './archive-context.js'

const claudeLine = (role, text, ts = 1) => JSON.stringify({
  type: role === 'user' ? 'user' : 'assistant',
  timestamp: new Date(ts).toISOString(),
  message: { role, content: [{ type: 'text', text }] },
})

test('★★ 定位到匹配处，而不是会话开头', () => {
  const lines = [
    ...Array.from({ length: 500 }, (_, i) => claudeLine('assistant', `开头的第 ${i} 条无关内容`)),
    claudeLine('user', '目前你有国内和国外端吗?'),
    claudeLine('assistant', '有的，国内走 62.234，国外走 43.165。'),
    ...Array.from({ length: 500 }, (_, i) => claudeLine('assistant', `后面的第 ${i} 条无关内容`)),
  ]
  const r = conversationAround(lines, { q: '国内和国外端', engine: 'claude' })
  assert.ok(r.messages.length > 0, '必须返回消息')
  const joined = r.messages.map((m) => m.text).join('\n')
  assert.ok(joined.includes('目前你有国内和国外端吗'), '必须包含匹配的那条')
  assert.ok(joined.includes('国内走 62.234'), '★ 必须包含**紧随其后的回答** —— 那才是用户要看的')
  assert.ok(!joined.includes('开头的第 0 条'), '不该给会话开头')
})

test('★★ 必须带上回答 —— 用户搜自己的提问，是想看当时怎么答的', () => {
  const lines = [
    claudeLine('user', '这个报错怎么解决'),
    claudeLine('assistant', '把 memory.high 抬到 current+80M 就行'),
  ]
  const r = conversationAround(lines, { q: '这个报错', engine: 'claude' })
  assert.ok(r.messages.some((m) => m.role === 'assistant' && m.text.includes('memory.high')))
})

test('★ 标出哪一条是命中的（前端要突出显示）', () => {
  const lines = [claudeLine('user', 'AAA'), claudeLine('assistant', '含有 KEYWORD 的回答'), claudeLine('user', 'BBB')]
  const r = conversationAround(lines, { q: 'KEYWORD', engine: 'claude' })
  const hit = r.messages.filter((m) => m.matched)
  assert.equal(hit.length, 1)
  assert.ok(hit[0].text.includes('KEYWORD'))
})

test('★ 前后各留几条上下文，条数与长度都有上限（跨境字节是硬指标）', () => {
  const lines = Array.from({ length: 100 }, (_, i) =>
    claudeLine(i % 2 ? 'assistant' : 'user', `${'长'.repeat(3000)} ${i === 50 ? 'TARGET' : ''}`))
  const r = conversationAround(lines, { q: 'TARGET', engine: 'claude' })
  assert.ok(r.messages.length <= 9, `上下文条数应有上限，实际 ${r.messages.length}`)
  for (const m of r.messages) assert.ok(m.text.length <= 1600, `单条过长：${m.text.length}`)
})

test('★ 没有关键词时退回**会话结尾**，不是开头 —— 结尾才是"最后干到哪了"', () => {
  const lines = [claudeLine('user', '第一条'), ...Array.from({ length: 50 }, (_, i) => claudeLine('assistant', `中间 ${i}`)), claudeLine('assistant', '最后一条')]
  const r = conversationAround(lines, { engine: 'claude' })
  const joined = r.messages.map((m) => m.text).join('\n')
  assert.ok(joined.includes('最后一条'), '无关键词时应给结尾')
})

test('★ 搜不到关键词也不能空手而归（片段可能匹配在命令/文件上）', () => {
  const lines = [claudeLine('user', 'AAA'), claudeLine('assistant', 'BBB')]
  const r = conversationAround(lines, { q: '压根不存在的词', engine: 'claude' })
  assert.ok(r.messages.length > 0, '至少给点上下文，别给空白')
})

test('★ 坏行不得让整个上下文崩掉', () => {
  const r = conversationAround(['{坏 json', claudeLine('user', '好行 KEY'), '也是坏的'], { q: 'KEY', engine: 'claude' })
  assert.ok(r.messages.some((m) => m.text.includes('KEY')))
})

test('★ 空输入返回空，不抛', () => {
  assert.deepEqual(conversationAround([], { q: 'x' }).messages, [])
  assert.deepEqual(conversationAround(null, {}).messages, [])
})
