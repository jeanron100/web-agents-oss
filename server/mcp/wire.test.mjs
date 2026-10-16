// server/mcp/wire.test.mjs
// node --test server/mcp/wire.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitResponse, clip, sessionRow, MAX_BYTES, parseEnvNumber } from './wire.js'

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8')
const S = {
  id: 'ps-abc-1', serverId: 'srv-178-232', project: 'web_agents', engine: 'claude',
  state: 'idle', inflight: false, lastActiveAt: 1000, startedAt: 0,
  firstPrompt: 'x'.repeat(500), cost: 1.23, tokensBreakdown: { a: 1 }, todoStats: {},
}

test('★ sessionRow 只保留 LLM 用得上的字段——不得把 49KB 的 state 原样带出去', () => {
  const r = sessionRow(S, 61_000)
  assert.deepEqual(Object.keys(r).sort(),
    ['engine','firstPrompt','id','idleMin','inflight','project','serverId','state'])
  assert.equal(r.idleMin, 1)                       // (61000-1000)/60000
  assert.ok(r.firstPrompt.length <= 80, 'firstPrompt 必须裁剪')
})

test('★ 预算算的是【整个返回对象】，不是内层列表', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'y'.repeat(50) }))
  const r = fitResponse({ note: 'z'.repeat(1000) }, 'items', items)
  assert.ok(bytes(r) <= MAX_BYTES, `整体 ${bytes(r)} 字节，必须 <= ${MAX_BYTES}`)
  assert.ok(r.items.length < items.length)
})

test('★ 超出不得静默丢弃——必须给 hasMore + nextOffset 供分批续取', () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'y'.repeat(50) }))
  const r = fitResponse({}, 'items', items)
  assert.equal(r.hasMore, true)
  assert.equal(r.nextOffset, r.items.length)
  assert.ok(r.hint, '必须告诉调用方怎么取下一批')
})

test('★ 用 nextOffset 续取能拿到后续数据，且不重不漏', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ i, pad: 'y'.repeat(50) }))
  const first = fitResponse({}, 'items', items)
  const second = fitResponse({}, 'items', items, { offset: first.nextOffset })
  assert.equal(second.items[0].i, first.items[first.items.length - 1].i + 1, '不重不漏')
  assert.ok(bytes(second) <= MAX_BYTES)
})

test('放得下时不加 hasMore/nextOffset（别给调用方无谓的续取暗示）', () => {
  const r = fitResponse({ a: 1 }, 'items', [{ b: 2 }])
  assert.deepEqual(r, { a: 1, items: [{ b: 2 }] })
})

test('★ 单个元素就超预算时至少返回 1 条，否则调用方会拿 nextOffset 死循环', () => {
  const huge = [{ pad: 'q'.repeat(20_000) }, { pad: 'r'.repeat(20_000) }]
  const r = fitResponse({}, 'items', huge)
  assert.equal(r.items.length, 1)
  assert.equal(r.nextOffset, 1, 'nextOffset 必须前进')
})

test('★ clip 截断长文本并留下省略标记（事件正文可能极长）', () => {
  const t = clip('z'.repeat(5000))
  assert.ok(t.length < 5000)
  assert.match(t, /…/)
})

test('clip 不动短文本', () => {
  assert.equal(clip('hello'), 'hello')
})

test('★ clip 截断结果精确到 max 字符（包括省略号）', () => {
  assert.equal(clip('z'.repeat(5000), 100).length, 100)
  assert.equal(clip('x'.repeat(200), 50).length, 50)
  assert.ok(clip('a'.repeat(1000), 75).endsWith('…'))
})

test('★ parseEnvNumber 对无效值回落到默认值——垃圾值不得静默禁用预算', () => {
  // 垃圾输入必须被拦截，否则预算检查会被 NaN 无声破坏
  assert.equal(parseEnvNumber('nonexistent', 8192), 8192, '未定义的 env 返回 fallback')
  assert.equal(parseEnvNumber('WA_TEST', 5000), 5000, 'undefined → fallback')

  // 模拟设置测试环境变量并直接测试
  const testKey = 'WA_TEST_PARSE_' + Date.now()
  process.env[testKey] = 'not-a-number'
  assert.equal(parseEnvNumber(testKey, 8192), 8192, '非数字字符串 → fallback')

  process.env[testKey] = '-100'
  assert.equal(parseEnvNumber(testKey, 8192), 8192, '负数 → fallback')

  process.env[testKey] = '0'
  assert.equal(parseEnvNumber(testKey, 8192), 8192, '0 → fallback（预算不能禁用）')

  process.env[testKey] = ''
  assert.equal(parseEnvNumber(testKey, 8192), 8192, '空字符串 → fallback（Number("") === 0）')

  process.env[testKey] = 'Infinity'
  assert.equal(parseEnvNumber(testKey, 8192), 8192, 'Infinity → fallback（非有限数）')

  process.env[testKey] = '4096'
  assert.equal(parseEnvNumber(testKey, 8192), 4096, '有效数字照样返回（不过度防御）')

  // 清理
  delete process.env[testKey]
})

test('★ 负的 offset 不会被误解为"从末尾往前"——应该被夹到 0', () => {
  const items = [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]
  const r = fitResponse({}, 'items', items, { offset: -5 })
  // 负 offset 应该被夹到 0，所以应该返回完整列表
  assert.deepEqual(r.items, items)
})

test('★ offset 是 NaN/非数字时不能让"还有没有更多"的判断恒为 false——必须退化为 0', () => {
  // 根因：旧实现是 Math.max(0, offset)，而 Math.max(0, NaN) 的结果仍是 NaN（不是 0），
  // 会让 safeOffset + consumed < all.length 永远算不出真值——数据被悄悄砍掉且没有信号。
  const items = Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'y'.repeat(50) }))
  const withNaN = fitResponse({}, 'items', items, { offset: NaN })
  const withString = fitResponse({}, 'items', items, { offset: 'abc' })
  const baseline = fitResponse({}, 'items', items, { offset: 0 })
  assert.deepEqual(withNaN.items, baseline.items, 'NaN offset 必须等价于 offset=0')
  assert.deepEqual(withString.items, baseline.items, '非数字字符串 offset 必须等价于 offset=0')
  assert.equal(withNaN.hasMore, true)
  assert.equal(typeof withNaN.nextOffset, 'number', 'nextOffset 不能是 NaN')
})

// ---- fitResponse：base 自身就超预算（Finding 1）----

test('★ base 本身（不含列表）就超预算时必须显式给 truncated 信号，不能悄悄吐出超预算对象', () => {
  // 复现 reviewer 的场景：session 投影里混进一个巨大字段（例如未裁剪的 project 路径），
  // 哪怕 items 是空数组，base 自己就已经超过预算——fitResponse 砍不动 base，
  // 绝不能假装这是一次"放得下"的正常响应。
  const hugeBase = { session: { project: 'p'.repeat(20_000), id: 'ps-1' } }
  const r = fitResponse(hugeBase, 'events', [])
  assert.equal(r.truncated, true, '必须带 truncated: true')
  assert.match(r.message, /预算|超出|budget/i, '必须有说明 base 超预算的 message')
  assert.deepEqual(r.events, [], 'items 键仍要在，只是空——不能整个字段消失')
})

test('★ base 超预算时即使传了 items 也不能悄悄拼进一个超预算响应且不给信号', () => {
  const hugeBase = { session: { project: 'p'.repeat(20_000) } }
  const items = [{ ts: 1, role: 'user', text: 'hi' }]
  const r = fitResponse(hugeBase, 'events', items)
  assert.equal(r.truncated, true)
  assert.equal(r.hasMore, undefined, 'base 超预算分支走的是专门的截断信号，不是常规 hasMore 续取语义')
})

test('base 未超预算时不受 truncated 分支影响——正常路径原样工作', () => {
  const r = fitResponse({ a: 1 }, 'items', [{ b: 2 }])
  assert.equal(r.truncated, undefined)
})

// ---- sessionRow：除 firstPrompt 外的字符串字段也必须裁剪（Finding 1）----

test('★ sessionRow 必须裁剪 project/id/serverId/engine/state——不能只裁 firstPrompt', () => {
  // 决定性夹具：project 20000 字符，若裁剪逻辑被去掉，序列化后的长度会远超任何合理上限；
  // 若裁剪生效，长度必须被夹到一个明显小的数（本实现用 300）。
  const dirty = {
    ...S,
    project: 'p'.repeat(20_000),
    id: 'i'.repeat(20_000),
    serverId: 'srv-'.repeat(5_000),
    engine: 'e'.repeat(20_000),
    state: 's'.repeat(20_000),
  }
  const r = sessionRow(dirty, 61_000)
  assert.ok(r.project.length <= 300, `project 必须被裁剪，实际长度 ${r.project.length}`)
  assert.ok(r.id.length <= 300, `id 必须被裁剪，实际长度 ${r.id.length}`)
  assert.ok(r.serverId.length <= 300, `serverId 必须被裁剪，实际长度 ${r.serverId.length}`)
  assert.ok(r.engine.length <= 300, `engine 必须被裁剪，实际长度 ${r.engine.length}`)
  assert.ok(r.state.length <= 300, `state 必须被裁剪，实际长度 ${r.state.length}`)
  // 整个投影序列化后必须远小于 8192 预算，否则单这一个 session 就能吃掉大半响应
  assert.ok(bytes(r) < 2000, `裁剪后的 sessionRow 应该很小，实际 ${bytes(r)} 字节`)
})
