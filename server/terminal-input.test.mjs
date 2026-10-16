import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalInputQueue } from './terminal-input.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
test('快速按键批处理且逐批串行，粘贴不超命令长度', async () => {
  const chunks = [], callbacks = []
  const q = createTerminalInputQueue((b, cb) => { chunks.push(b); callbacks.push(cb) }, { delayMs: 1, chunkBytes: 4 })
  try {
    for (const char of 'abcdef中文') q.push(char)
    await sleep(15)
    assert.equal(chunks.length, 1)
    callbacks.shift()()
    await sleep(15)
    assert.equal(chunks.length, 2)
    callbacks.shift()()
    await sleep(15)
    callbacks.shift()()
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'abcdef中文')
    assert.ok(chunks.every((c) => c.length <= 4))
  } finally { q.close() }
})
test('关闭后不再送键，积压超限明确报错', async () => {
  let sent = 0, errors = 0
  const q = createTerminalInputQueue(() => { sent++ }, { maxBytes: 3, onError: () => { errors++ } })
  assert.equal(q.push('abcd'), false)
  assert.equal(errors, 1)
  q.push('abc'); q.close()
  await sleep(15)
  assert.equal(sent, 0)
  assert.equal(q.push('x'), false)
})
