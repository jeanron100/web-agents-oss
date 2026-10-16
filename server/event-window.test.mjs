import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowEvents, LIMIT, MIN_MSG } from './event-window.js'

const msg = (i) => ({ type: i % 2 ? 'assistant' : 'user', text: `m${i}`, ts: i })
const op = (i) => ({ type: 'file_op', verb: '执行命令', path: `c${i}`, ts: i })

test('不超上限时原样返回', () => {
  const e = [msg(1), op(2), msg(3)]
  assert.deepEqual(windowEvents(e), e)
})

test('★ 工具调用洪水不得挤掉对话（我制造的那个回归）', () => {
  // 复刻真实形态：78 条对话 + 611 次工具调用
  const e = []
  for (let i = 0; i < 78; i++) e.push(msg(i))
  for (let i = 0; i < 611; i++) e.push(op(1000 + i))
  const w = windowEvents(e)
  const kept = w.filter((x) => x.type === 'user' || x.type === 'assistant').length
  assert.equal(w.length, LIMIT)
  assert.equal(kept, 78, `78 条对话应全部保留，实际只剩 ${kept}`)
  // 旧的一刀切行为在这里会是 0 —— 611 次工具调用全排在后面，slice(-150) 一条对话都留不下
  assert.notEqual(kept, 0)
})

test('对话本身超过保底额度时，取最近的', () => {
  const e = []
  for (let i = 0; i < 500; i++) e.push(msg(i))
  const w = windowEvents(e)
  assert.equal(w.length, LIMIT)
  assert.equal(w.at(-1).text, 'm499', '必须保留最新的')
})

test('工具调用仍要占满余额（防止修过头把工具活动又弄没了）', () => {
  const e = []
  for (let i = 0; i < 20; i++) e.push(msg(i))
  for (let i = 0; i < 400; i++) e.push(op(1000 + i))
  const w = windowEvents(e)
  assert.equal(w.length, LIMIT)
  assert.equal(w.filter((x) => x.type === 'file_op').length, LIMIT - 20)
})

test('★ 保持原始顺序，绝不重排', () => {
  const e = []
  for (let i = 0; i < 300; i++) e.push(i % 3 === 0 ? msg(i) : op(i))
  const w = windowEvents(e)
  const idx = w.map((x) => e.indexOf(x))
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), '输出顺序必须与输入一致')
})

test('边界：空/非数组不炸', () => {
  assert.deepEqual(windowEvents([]), [])
  assert.deepEqual(windowEvents(null), [])
})

test('minMsg 不会超过 limit', () => {
  const e = []
  for (let i = 0; i < 500; i++) e.push(msg(i))
  assert.equal(windowEvents(e, { limit: 10, minMsg: 999 }).length, 10)
})
