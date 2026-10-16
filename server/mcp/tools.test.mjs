import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, createHubClient } from './hub-client.js'

test('★ 超时 = 我不知道，不是失败——措辞里禁止出现「未送达」', () => {
  const e = new Error('aborted'); e.name = 'AbortError'
  const r = classifyError(e)
  assert.equal(r.ok, false)
  assert.equal(r.indeterminate, true)
  assert.doesNotMatch(r.message, /未送达/)
})

test('★ 上游 4xx 的可操作字段必须活着到调用方（canForce 被吃掉=用户没有出路）', () => {
  const e = new Error('该会话正在终端中运行'); e.status = 409; e.body = { canForce: true }
  const r = classifyError(e)
  assert.equal(r.status, 409)
  assert.equal(r.canForce, true)
})

test('闸门满要给结构化退避信息，而不是一句话', () => {
  const e = new Error('并发已满'); e.status = 503
  e.body = { code: 'QUEUE_TIMEOUT', active: 8, max: 8, position: 1, retryAfterMs: 1500 }
  const r = classifyError(e)
  assert.equal(r.code, 'QUEUE_TIMEOUT')
  assert.equal(r.active, 8)
  assert.equal(r.retryAfterMs, 1500)
})

test('其余错误如实报错', () => {
  const r = classifyError(new Error('boom'))
  assert.equal(r.ok, false)
  assert.equal(r.indeterminate, undefined)
})

test('★ 恶意 body 里的 ok/status 顶不掉 wrapper 自己的判断（body 必须先展开、wrapper 字段后写）', () => {
  // 上游 body 恰好带 ok/status 这两个键名时（哪怕纯属巧合），如果 body 后展开就会把
  // 一个真实的 409 悄悄翻成"成功"——调用方据此走错分支，比压根没有这个字段更危险。
  const e = new Error('conflict'); e.status = 409
  e.body = { ok: true, status: 999, canForce: true }
  const r = classifyError(e)
  assert.equal(r.ok, false, 'body 里混进 ok:true 不能让真实的 409 被报成成功')
  assert.equal(r.status, 409, 'body 里混进 status:999 不能顶掉真实状态码')
})

test('恶意字段旁边的无关可操作字段（canForce/retryAfterMs）依然要透传', () => {
  const e = new Error('conflict'); e.status = 409
  e.body = { ok: true, status: 999, canForce: true, retryAfterMs: 2000 }
  const r = classifyError(e)
  assert.equal(r.canForce, true, 'canForce 不能被恶意字段的展开顺序问题连带吃掉')
  assert.equal(r.retryAfterMs, 2000)
})

// ---- createHubClient：注入 fetchImpl，绝不碰真实网络/真实服务 ----

test('createHubClient: 200 JSON 响应原样返回给调用方', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ sessions: [], servers: [] }) })
  const client = createHubClient({ fetchImpl, baseUrl: 'http://fake', timeoutMs: 1000 })
  const body = await client.getState()
  assert.deepEqual(body, { sessions: [], servers: [] })
})

test('★ createHubClient: 4xx 响应抛出的 error 同时带 status 和完整 body（classifyError 靠这个透传字段）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ error: '冲突', canForce: true }) })
  const client = createHubClient({ fetchImpl, timeoutMs: 1000 })
  await assert.rejects(
    () => client.getPending(),
    (err) => {
      assert.equal(err.status, 409)
      assert.deepEqual(err.body, { error: '冲突', canForce: true })
      return true
    },
  )
})

test('createHubClient: 错误响应的 body 非 JSON/为空时不抛不可分类的东西，status 仍保留', async () => {
  // res.json() 对空 body / 非 JSON body 会抛，get() 里用 .catch(() => ({})) 兜底成空对象，
  // 而不是让这个解析异常代替真正的 HTTP 错误往外冒——那样 status 就丢了。
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
  })
  const client = createHubClient({ fetchImpl, timeoutMs: 1000 })
  await assert.rejects(
    () => client.getState(),
    (err) => {
      assert.equal(err.status, 500)
      assert.deepEqual(err.body, {})
      return true
    },
  )
})

test('★ createHubClient: 超时走 indeterminate 而不是 failed（小 timeoutMs 保证测试快，不真的等 15s）', async () => {
  // 模拟真实 fetch 对 AbortSignal 的反应：signal 一 abort 就 reject 一个 AbortError，
  // never-resolves 的 promise 只有真的监听 signal 才会在超时后落地——否则测试会挂住。
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
  const client = createHubClient({ fetchImpl, timeoutMs: 20 })
  let caught
  try {
    await client.getState()
    assert.fail('应当抛出超时错误')
  } catch (e) {
    caught = e
  }
  const r = classifyError(caught)
  assert.equal(r.indeterminate, true, '超时必须归类为「结果未知」，不能是 failed')
  assert.equal(r.ok, false)
})

test('createHubClient: 成功路径必须清理定时器（finally{clearTimeout} 契约——挂着不清的 timer 会让进程/测试迟迟退不出）', async () => {
  // 直接查活跃 handle 数量在 node:test 里不稳（其它并发资源会干扰），改用更直接的方式：
  // 拦截全局 setTimeout/clearTimeout，断言 get() 里创建的那个 timer 确实被同一个 id 清掉。
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  let capturedTimerId
  let clearedWithSameId = false
  global.setTimeout = (fn, ms, ...args) => {
    capturedTimerId = originalSetTimeout(fn, ms, ...args)
    return capturedTimerId
  }
  global.clearTimeout = (id) => {
    if (id === capturedTimerId) clearedWithSameId = true
    return originalClearTimeout(id)
  }
  try {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })
    const client = createHubClient({ fetchImpl, timeoutMs: 5000 })
    await client.getState()
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
  assert.equal(clearedWithSameId, true, '成功路径没清 timer，5000ms 内这个 handle 会一直挂在事件循环里')
})

test('since 传 0 时不能被真值判断吞掉——0 是合法游标，语义不同于"未传"', async () => {
  let capturedUrl
  const fetchImpl = async (url) => { capturedUrl = url; return { ok: true, status: 200, json: async () => ({}) } }
  const client = createHubClient({ fetchImpl, baseUrl: 'http://fake', timeoutMs: 1000 })
  await client.getEvents('ps-1', 0)
  assert.match(capturedUrl, /since=0/, `URL 必须带上 since=0，实际是: ${capturedUrl}`)
})

// ---- C2：2xx 但 body 解析失败，绝不能悄悄退化成 {}（那是一次伪造的"集群空空如也"）----

test('★★ C2：200 响应但 body 不是合法 JSON 时必须抛错，不能悄悄变成 {} 冒充"确有其事的空结果"', async () => {
  // 根因：旧实现对成功响应也套 res.json().catch(() => ({}))——2xx + 解析失败会被悄悄
  // 吞成 {}，下游 fleet_overview 会把 {}.servers ?? [] 当真，报出一句自信的
  // "servers:[] pending:0"（集群空空如也），而事实是"hub 说了什么我读不懂"。
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token in JSON') },
  })
  const client = createHubClient({ fetchImpl, timeoutMs: 1000 })
  await assert.rejects(
    () => client.getState(),
    (err) => {
      assert.match(err.message, /解析|JSON|parse/i, '错误信息必须说明是 body 解析失败，而不是别的原因')
      return true
    },
    '2xx 但 body 解析失败必须原样冒泡成异常，不能被 .catch(() => ({})) 悄悄压成空对象',
  )
})

test('C2 对照：错误响应（4xx/5xx）的 body 解析失败仍然按原语义退化成 {}——这条行为不能被削弱', async () => {
  // 与上一条形成对照：错误响应缺 body 是意料之中的正常情况（status code 本身已经说明了失败），
  // 这里退化成 {} 是合理默认，绝不能因为修 C2 而连带把这条也改坏。
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => { throw new SyntaxError('empty body') },
  })
  const client = createHubClient({ fetchImpl, timeoutMs: 1000 })
  await assert.rejects(
    () => client.getPending(),
    (err) => {
      assert.equal(err.status, 503)
      assert.deepEqual(err.body, {}, '错误响应体解析失败仍应退化成 {}，这条行为是 C2 修复要保留的对照组')
      return true
    },
  )
})

test('★ 垃圾 WA_MCP_TIMEOUT_MS 不能悄悄变成秒级超时（NaN 的 setTimeout 会立刻触发，把每个请求都误报成超时）', async () => {
  const key = 'WA_MCP_TIMEOUT_MS'
  const original = process.env[key]
  process.env[key] = 'not-a-number'
  try {
    // fetchImpl 故意做成"永不 abort 也不会立刻 resolve"，靠一个能被 await 的短延时模拟正常网络往返；
    // 如果 timeoutMs 真的被 NaN 污染，setTimeout(fn, NaN) 会在 ~1ms 内先触发 abort，
    // 于是这次调用会以超时（AbortError）收场，而不是拿到下面的正常响应。
    const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ fine: true }) }), 50)
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        const err = new Error('aborted'); err.name = 'AbortError'
        reject(err)
      })
    })
    const client = createHubClient({ fetchImpl }) // 不传 timeoutMs，走 env 解析
    const body = await client.getState()
    assert.deepEqual(body, { fine: true }, '垃圾 env 值必须回落到默认 15s，而不是被 NaN 秒退')
  } finally {
    if (original === undefined) delete process.env[key]; else process.env[key] = original
  }
})

// ---- createTools：5 个只读工具（Task 5） ----

import { createTools } from './tools.js'

const NOW = 10_000_000
const fakeState = {
  servers: [
    { id: 'srv-A', online: true, sessionGate: { active: 8, max: 8, queued: 2 } },
    { id: 'srv-B', online: true, sessionGate: { active: 0, max: 8, queued: 0 } },
  ],
  sessions: [
    { id: 'ps-1', serverId: 'srv-A', project: 'p1', engine: 'claude', state: 'idle',
      inflight: false, lastActiveAt: NOW - 120 * 60_000, firstPrompt: 'hi' },
    { id: 'ps-2', serverId: 'srv-B', project: 'p2', engine: 'codex', state: 'running',
      inflight: true, lastActiveAt: NOW - 1000, firstPrompt: 'yo' },
  ],
  pendingActions: [{ id: 'act-1' }],
}
const fakeClient = {
  getState: async () => fakeState,
  getEvents: async () => ({ events: Array.from({ length: 50 },
    // type（不是 role——真实 hub 事件没有这个字段，见 C1 修复）
    (_, i) => ({ id: `e${i}`, ts: i, type: 'assistant', text: 'w'.repeat(3000) })) }),
  getPending: async () => ({ total: 1, overdueCount: 0, items: [
    { id: 'act-1', kind: 'approval', sessionId: 'ps-1', serverId: 'srv-A',
      project: 'p1', title: 't', ageMin: 5, overdue: false }] }),
}
const T = createTools(fakeClient)

test('★ fleet_overview 必须点出闸门饱和——那是「全部超时」最常见的真因', async () => {
  const r = await T.fleet_overview({}, NOW)
  const s = r.servers.find(x => x.id === 'srv-A')
  assert.equal(s.gate, '8/8')
  assert.equal(s.gateFull, true)
  assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 8192)
})

test('★ session_find(stuck) 只回卡住的，且行是裁剪过的', async () => {
  const r = await T.session_find({ stuck: true }, NOW)
  assert.deepEqual(r.sessions.map(s => s.id), ['ps-1'])
  assert.deepEqual(Object.keys(r.sessions[0]).sort(),
    ['engine','firstPrompt','id','idleMin','inflight','project','serverId','state'])
})

test('★ session_tail 整体不超预算，且超出时给分批信息而非静默丢弃', async () => {
  const r = await T.session_tail({ sessionId: 'ps-1' })
  assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 8192, '整体必须 <= 8192')
  assert.equal(r.hasMore, true)
  assert.equal(typeof r.nextOffset, 'number')
  assert.ok(r.hint)
})

test('★ session_tail 用 nextOffset 能续取下一批', async () => {
  const first = await T.session_tail({ sessionId: 'ps-1' })
  const second = await T.session_tail({ sessionId: 'ps-1', offset: first.nextOffset })
  assert.ok(second.events.length > 0, '续取必须真拿到数据')
  assert.ok(Buffer.byteLength(JSON.stringify(second), 'utf8') <= 8192)
})

test('session_detail 带上会话状态与最近事件', async () => {
  const r = await T.session_detail({ sessionId: 'ps-1' }, NOW)
  assert.equal(r.session.id, 'ps-1')
  assert.ok(Array.isArray(r.events))
  assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 8192)
})

test('★ session_detail 对不存在的会话给明确 not found，而不是空对象', async () => {
  const r = await T.session_detail({ sessionId: 'nope' }, NOW)
  assert.equal(r.ok, false)
  assert.match(r.message, /找不到|not found/i)
})

test('pending_list 只读返回待办摘要', async () => {
  const r = await T.pending_list({})
  assert.equal(r.total, 1)
  assert.equal(r.items[0].id, 'act-1')
})

// ---- Review 修复回归（Task 5 fix pass）----

test('★ [Finding 1] session_detail 遇到超长 project 字段（如深层文件路径）不会把 base 撑爆预算', async () => {
  // 复现 reviewer 的场景：一个 session 的 project 是 20000 字符、且 0 条事件——
  // 修复前 sessionRow 只裁 firstPrompt，这个字段原样带出，单它就能吃掉大半预算。
  const dirtyClient = {
    getState: async () => ({
      servers: [],
      sessions: [{
        id: 'ps-dirty', serverId: 'srv-A', project: 'p'.repeat(20_000),
        engine: 'claude', state: 'idle', inflight: false, lastActiveAt: NOW, firstPrompt: 'hi',
      }],
      pendingActions: [],
    }),
    getEvents: async () => ({ events: [] }),
    getPending: async () => ({ items: [] }),
  }
  const dirtyTools = createTools(dirtyClient)
  const r = await dirtyTools.session_detail({ sessionId: 'ps-dirty' }, NOW)
  assert.ok(
    Buffer.byteLength(JSON.stringify(r), 'utf8') <= 8192,
    `整体必须 <= 8192，即便 project 字段本身是 20000 字符，实际 ${Buffer.byteLength(JSON.stringify(r), 'utf8')}`,
  )
  assert.ok(r.session.project.length < 1000, 'project 必须被裁剪，不能原样带出 20000 字符')
})

test('★ [Finding 2] session_detail 的 getEvents 失败必须原样冒泡，不能吞成"0 事件"的假成功', async () => {
  const failingClient = {
    getState: fakeClient.getState,
    getEvents: async () => { throw new Error('upstream timeout') },
    getPending: fakeClient.getPending,
  }
  const failingTools = createTools(failingClient)
  await assert.rejects(
    () => failingTools.session_detail({ sessionId: 'ps-1' }, NOW),
    /upstream timeout/,
    '失败必须原样冒泡给上层 classifyError 边界，不能在这里变成 { events: [] } 的假成功',
  )
})

test('★ [Finding 3] session_tail 与 session_detail 的事件必须最新在前——"tail"不该把最旧事件当首条', async () => {
  // fixture events ts 0..49 升序；最新是 49。
  const rTail = await T.session_tail({ sessionId: 'ps-1' })
  assert.equal(rTail.events[0].ts, 49, 'session_tail 第一条必须是最新事件（ts=49）')

  const rDetail = await T.session_detail({ sessionId: 'ps-1' }, NOW)
  assert.equal(rDetail.events[0].ts, 49, 'session_detail 的最近事件视图也必须最新在前')
})

test('★ [Finding 4] session_tail 的 offset 是非数字/负数时必须规范化为 0，不能悄悄丢数据且不给信号', async () => {
  const withGarbage = await T.session_tail({ sessionId: 'ps-1', offset: 'abc' })
  const withZero = await T.session_tail({ sessionId: 'ps-1', offset: 0 })
  assert.deepEqual(withGarbage.events, withZero.events, '非数字 offset 必须等价于 offset=0')
  assert.equal(withGarbage.hasMore, true, '仍应给出 hasMore 信号，不能因 NaN 传染而消失')
  assert.equal(typeof withGarbage.nextOffset, 'number', 'nextOffset 不能是 NaN/undefined')

  const withNegative = await T.session_tail({ sessionId: 'ps-1', offset: -100 })
  assert.deepEqual(withNegative.events, withZero.events, '负数 offset 必须等价于 offset=0')
})

test('★ [Finding 4] session_tail 的 limit 是非数字/负数时必须回落默认值，不能让 slice(-NaN) 退化成"整份都要"', async () => {
  // 用小事件体的 client——这样"limit 未生效返回全部 50 条"和"budget 截断"这两种
  // 原因不会混在一起，谁导致的数量差异一目了然。
  const lightClient = {
    getState: fakeClient.getState,
    getEvents: async () => ({
      events: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, ts: i, type: 'assistant', text: 'ok' })),
    }),
    getPending: fakeClient.getPending,
  }
  const lightTools = createTools(lightClient)
  const withDefault = await lightTools.session_tail({ sessionId: 'ps-1' })
  assert.equal(withDefault.events.length, 20, '默认 limit=20（小事件体不会被 budget 进一步截断）')

  const withGarbage = await lightTools.session_tail({ sessionId: 'ps-1', limit: 'abc' })
  assert.equal(withGarbage.events.length, 20, '非数字 limit 必须回落默认值 20，不能变成 slice(-NaN)=slice(0)=全部 50 条')

  const withNegative = await lightTools.session_tail({ sessionId: 'ps-1', limit: -5 })
  assert.equal(withNegative.events.length, 20, '负数 limit 必须回落默认值 20')
})

test('★ [Finding 4] session_detail 的 events 参数是非数字时必须回落默认值', async () => {
  const lightClient = {
    getState: fakeClient.getState,
    getEvents: async () => ({
      events: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, ts: i, type: 'assistant', text: 'ok' })),
    }),
    getPending: fakeClient.getPending,
  }
  const lightTools = createTools(lightClient)
  const r = await lightTools.session_detail({ sessionId: 'ps-1', events: 'abc' }, NOW)
  assert.equal(r.events.length, 10, '非数字 events 必须回落默认值 10，不能变成 slice(-NaN)=全部 50 条')
})

// ================================================================================
// ---- 终审修复（Final review fix pass）----
// 根因：以上所有测试都对着一个手写假 hub 跑——它的 events 字段（role/text 全非空）是从
// 计划文档臆造出来的，从未和真实 hub 核对过。真实 hub 的事件判别字段是 type（没有 role），
// file_op 类事件根本没有 text（真实字段是 verb/path/additions/deletions）。于是 fixture
// 里从没出现过的 file_op 空壳、恒为 undefined 的 cursor，全部被 54 个绿测试放过。
// 这里补一个"契约测试"：把 GET /api/session/.../events 在真实 232 hub 上的实测响应
// （裁剪版，server/mcp/fixtures/events-sample.json）直接喂给 createTools，而不是再发明
// 一份假数据——任何"字段名猜对了但没对真实响应验证过"的实现都会在这里现形。
// ================================================================================

import fs from 'node:fs'
import { DEFS } from './tool-defs.js'

const realEventsFixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/events-sample.json', import.meta.url), 'utf8'),
)
// 佐证：这份夹具确实来自会用到 file_op 的真实会话，且混了 user/assistant/file_op 三种 type
// （否则这份"契约测试"自己也可能是另一个想当然的假数据）。
const realFixtureTypes = new Set(realEventsFixture.events.map((e) => e.type))
if (!realFixtureTypes.has('file_op') || !realFixtureTypes.has('user') || !realFixtureTypes.has('assistant')) {
  throw new Error('events-sample.json 夹具缺失某个真实 type——契约测试的前提就不成立了')
}

const realClient = {
  // 与夹具同源的会话（GET /api/session/ps-mrq88g12-9/events 在 232 上的真实抓包）：
  // 字段名对照 2026-07-20 对 http://127.0.0.1:8787 的实测 /api/state，不是照计划文档臆造。
  getState: async () => ({
    servers: [
      { id: 'srv-178-232', name: 'srv-178-232', region: '腾讯云 · 主节点', flag: '🇨🇳', online: true,
        sessionGate: { active: 8, queued: 1, max: 8, minIntervalMs: 1500, queueWaitMs: 45000, held: 8, reaped: [] } },
    ],
    sessions: [
      { id: 'ps-mrq88g12-9', project: 'dbmanager', branch: '', engine: 'claude', model: 'Opus 4.8',
        effort: 'xhigh', mode: 'auto', state: 'idle', summary: 's', startedAt: 0, firstPrompt: '',
        inflight: false, lastActiveAt: 0, cost: 0.1, tokens: 100, origin: 'platform',
        realSessionId: '19c82f5a-9426-4e3b-b2c5-9b6fa8d4e556', cwd: '/data/dbmanager', serverId: 'srv-178-232' },
    ],
    pendingActions: [],
  }),
  getEvents: async () => realEventsFixture,
  getPending: async () => ({ items: [] }),
}
const RT = createTools(realClient)

test('★★ 契约：真实 hub 事件夹具喂进 session_tail，不能有任何一行内容为空（根治 C1）', async () => {
  const r = await RT.session_tail({ sessionId: 'ps-mrq88g12-9', limit: 20 })
  assert.equal(r.events.length, realEventsFixture.events.length,
    `夹具里就这 ${realEventsFixture.events.length} 条事件，应该都能拿到`)
  for (const e of r.events) {
    assert.notEqual(e.text, '', `事件行内容为空——type=${e.type}，投影大概率读错了字段`)
    assert.ok('type' in e, '事件行必须带 type 字段（真实字段名，不是 role）')
    assert.equal(e.role, undefined, '真实 hub 事件没有 role 字段，投影里不该出现它')
  }
})

test('★★ 契约：session_tail 的 cursor 必须是真实 hub 返回的 lastSeq，不能恒为 null（根治 I4）', async () => {
  const r = await RT.session_tail({ sessionId: 'ps-mrq88g12-9' })
  assert.equal(r.cursor, realEventsFixture.lastSeq, 'cursor 必须来自 hub 真实响应的 lastSeq 字段')
  assert.notEqual(r.cursor, null, 'hub 压根没有 cursor 字段——恒为 null 等于把一句打不通的建议留在 hint 里')
})

test('★★ 契约：session_detail 对同一份真实夹具同样不产出内容为空的事件行', async () => {
  const r = await RT.session_detail({ sessionId: 'ps-mrq88g12-9', events: 20 }, NOW)
  assert.ok(Array.isArray(r.events) && r.events.length > 0)
  for (const e of r.events) assert.notEqual(e.text, '', `type=${e.type} 的事件行不该是空壳`)
})

test('★ file_op 事件必须渲染出人话摘要（覆盖读取/创建/更新/执行命令/通用工具五种真实 verb）', async () => {
  const events = [
    { ts: 1, type: 'file_op', verb: '读取文件', path: 'a.md' },
    { ts: 2, type: 'file_op', verb: '创建文件', path: 'b.md', additions: 10 },
    { ts: 3, type: 'file_op', verb: '更新文件', path: 'c.md', additions: 5, deletions: 2 },
    { ts: 4, type: 'file_op', verb: '执行命令', path: 'ls -la' },
    { ts: 5, type: 'file_op', verb: '工具', path: 'ToolSearch' },
  ]
  const client = { getState: async () => ({}), getEvents: async () => ({ events, lastSeq: null }), getPending: async () => ({}) }
  const r = await createTools(client).session_tail({ sessionId: 's1', limit: 10 })
  assert.equal(r.events.length, 5)
  for (const e of r.events) assert.notEqual(e.text, '', `verb 行不能是空 text（ts=${e.ts}）`)
  const byTs = Object.fromEntries(r.events.map((e) => [e.ts, e.text]))
  assert.match(byTs[2], /创建文件/); assert.match(byTs[2], /b\.md/); assert.match(byTs[2], /\+10/)
  assert.match(byTs[3], /更新文件/); assert.match(byTs[3], /\+5/); assert.match(byTs[3], /-2/)
  assert.match(byTs[4], /ls -la/)
})

// ---- I5：变异存活项的针对性断言（mutation-tested survivors）----

test('★★ [I5] fleet_overview 的 stuck/running/queued/online 必须来自真实数据，不能被写死成 0/0/0/true', async () => {
  const now = 10_000_000
  const state = {
    servers: [
      { id: 'srv-A', online: true, sessionGate: { active: 3, max: 8, queued: 2 } },
      { id: 'srv-B', online: false, sessionGate: { active: 0, max: 8, queued: 0 } },
    ],
    sessions: [
      { id: 's1', serverId: 'srv-A', state: 'idle', inflight: false, lastActiveAt: now - 60 * 60_000 }, // stuck
      { id: 's2', serverId: 'srv-A', state: 'running', inflight: true, lastActiveAt: now - 1000 }, // running，非 stuck
    ],
    pendingActions: [],
  }
  const client = { getState: async () => state, getEvents: async () => ({ events: [] }), getPending: async () => ({ items: [] }) }
  const r = await createTools(client).fleet_overview({}, now)
  const a = r.servers.find((x) => x.id === 'srv-A')
  const b = r.servers.find((x) => x.id === 'srv-B')
  assert.equal(a.stuck, 1, 'srv-A 应有 1 个 stuck 会话——不能被写死成 0')
  assert.equal(a.running, 1, 'srv-A 应有 1 个 running 会话——不能被写死成 0')
  assert.equal(a.queued, 2, 'queued 必须来自 sessionGate.queued——不能被写死成 0')
  assert.equal(b.online, false, 'online 必须来自服务端真实字段——不能被写死成 true')
})

test('★★ [I5] pending_list 必须保留 overdue 字段，且 title 必须裁剪到 100 字符', async () => {
  const client = {
    getState: async () => ({ servers: [], sessions: [], pendingActions: [] }),
    getEvents: async () => ({ events: [] }),
    getPending: async () => ({
      total: 1, overdueCount: 1, items: [
        { id: 'act-x', kind: 'review', sessionId: 's1', serverId: 'srv-A', project: 'p',
          title: 'x'.repeat(500), ageMin: 300, overdue: true },
      ],
    }),
  }
  const r = await createTools(client).pending_list({})
  assert.equal(r.items[0].overdue, true, 'overdue 必须透传——不能丢字段')
  assert.equal(r.items[0].title.length, 100, 'title 必须裁剪到 100 字符（clip 含省略号）')
})

test('★★ [I5] session_detail 必须带上 stuck 判定，不能丢字段', async () => {
  const now = 10_000_000
  const client = {
    getState: async () => ({
      servers: [], sessions: [
        { id: 's1', serverId: 'srv-A', state: 'idle', inflight: false, lastActiveAt: now - 60 * 60_000 },
      ], pendingActions: [],
    }),
    getEvents: async () => ({ events: [] }),
    getPending: async () => ({ items: [] }),
  }
  const r = await createTools(client).session_detail({ sessionId: 's1' }, now)
  assert.equal(r.session.stuck, true, 'session_detail 的 session 对象必须带 stuck 字段')
})

test('★★ [I5] session_tail 必须把 since 原样传给 hub client——丢了续传就形同虚设', async () => {
  let capturedSince = 'NEVER_CALLED'
  const client = {
    getState: async () => ({}),
    getEvents: async (_id, since) => { capturedSince = since; return { events: [], lastSeq: null } },
    getPending: async () => ({}),
  }
  await createTools(client).session_tail({ sessionId: 's1', since: 'seq-123' })
  assert.equal(capturedSince, 'seq-123', 'since 必须原样传给 getEvents，不能被忽略')
})

test('★★ [I5] hasMore 时 live hint 必须提到 cursor 这个真实可用的续传机制，不能被裁成空话', async () => {
  const r = await T.session_tail({ sessionId: 'ps-1' }) // 复用顶部 fakeClient：50 条大事件必然触发分批
  assert.ok(r.hasMore, '前置条件：本用例需要真的触发分批，否则下面的断言没有意义')
  assert.match(r.hint, /cursor/, 'hint 必须包含"改用 cursor"的建议，不能被裁成空话')
})

// ---- I6：超时措辞不能给只读工具"别重复提交"这种写操作建议 ----

test('★ I6：超时提示必须鼓励重试（这是只读查询），不能沿用写操作那套"请勿重复提交"', () => {
  const e = new Error('aborted'); e.name = 'AbortError'
  const r = classifyError(e)
  assert.equal(r.indeterminate, true)
  assert.doesNotMatch(r.message, /请勿重复提交/, '五个工具全是只读查询，不存在"重复提交"的顾虑')
  assert.match(r.message, /重试/, '应该明确告诉调用方：这是读，重试是安全的')
})

// ---- history_search：长程历史（Mongo 持久投影），与 session_tail 互补 ----
// fixture 事件形状取自 /api/v2/events 的真实响应字段（见任务描述与本地实测）：
// serverId/project/realSessionId/sessionId/engine/type/occurredAt/seq/payload/eventKey——
// 不是 session_tail 那套 role/text，混用会读到 undefined，历史事件必须用独立 fixture。
function makeHistoryEvents(n, { longSummary = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `srv-A:claude:e${i}`,
    eventKey: `srv-A:claude:e${i}`,
    serverId: 'srv-A',
    project: 'p1',
    engine: 'claude',
    sessionId: 'ps-hist-1',
    realSessionId: 'uuid-hist-1',
    type: i % 2 === 0 ? 'tool.used' : 'assistant.message',
    occurredAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    seq: `uuid-hist-1:1:${i}:0`,
    payload: i % 2 === 0
      ? { verb: '更新文件', path: `file${i}.md`, additions: 3, deletions: 1 }
      : { summary: longSummary ? 'x'.repeat(200) : `assistant reply ${i}` },
  }))
}

test('★ history_search 必须至少给一个收窄条件，否则拒绝且根本不去查 hub（不能"扫全量再截断"）', async () => {
  let called = false
  const client = { getHistory: async () => { called = true; return { available: true, events: [] } } }
  const r = await createTools(client).history_search({})
  assert.equal(r.ok, false, '未收窄查询必须被拒绝')
  assert.match(r.message, /收窄|narrow/i, '拒绝消息必须告诉调用方去收窄查询')
  assert.equal(called, false, '不给任何过滤条件时不该真的去问 hub——那等于先扫全量再截断')
})

test('★ history_search 给了任意一个过滤条件（如 project）就必须真的发起查询', async () => {
  let capturedParams
  const client = { getHistory: async (p) => { capturedParams = p; return { available: true, events: [] } } }
  await createTools(client).history_search({ project: 'p1' })
  assert.equal(capturedParams.project, 'p1', 'project 过滤必须原样传给 hub client')
})

test('★★ history_search 整体不超预算，且超出时给 hasMore/nextOffset 而非静默丢弃', async () => {
  const client = { getHistory: async () => ({ available: true, events: makeHistoryEvents(80, { longSummary: true }) }) }
  const r = await createTools(client).history_search({ project: 'p1' })
  assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= 8192, '整体必须 <= 8192')
  assert.equal(r.hasMore, true, '80 条长摘要必然超预算，必须给出 hasMore 信号')
  assert.equal(typeof r.nextOffset, 'number')
  assert.ok(r.hint)
})

test('★★ history_search 用 nextOffset 能续取下一批，且不是同一批数据的重复', async () => {
  const client = { getHistory: async () => ({ available: true, events: makeHistoryEvents(80, { longSummary: true }) }) }
  const tools = createTools(client)
  const first = await tools.history_search({ project: 'p1' })
  const second = await tools.history_search({ project: 'p1', offset: first.nextOffset })
  assert.ok(second.events.length > 0, '续取必须真拿到数据')
  assert.notDeepEqual(second.events, first.events, '续取必须是不同于第一批的数据，不能原地打转')
  assert.ok(Buffer.byteLength(JSON.stringify(second), 'utf8') <= 8192)
})

test('★★★ 诚实规则：available:false（存储故障）必须和"确实查不到匹配事件"的空结果集能区分开', async () => {
  const downClient = { getHistory: async () => ({ available: false }) }
  const down = await createTools(downClient).history_search({ project: 'p1' })
  assert.equal(down.ok, false, 'Mongo 不可用必须报失败，不能包装成"看起来正常的空结果"')
  assert.equal(down.available, false)
  assert.equal(down.events, undefined, '存储故障的响应体不该带 events 字段，否则容易被当成"0 条匹配"来读')
  assert.doesNotMatch(down.message, /没有历史|无历史记录/, '措辞不能说成"没有历史"——那是查不到，不是不存在')

  const emptyClient = { getHistory: async () => ({ available: true, events: [] }) }
  const empty = await createTools(emptyClient).history_search({ project: 'p1' })
  assert.equal(empty.ok, undefined, '真正的空结果集是成功响应，不该带 ok:false')
  assert.equal(empty.available, true)
  assert.deepEqual(empty.events, [], '确实没有匹配事件时应如实返回空数组，而不是拒绝或报错')

  assert.notDeepEqual(down, empty, '两种情况的响应形状必须不同，否则调用方无法区分"故障"与"确实没有"')
})

test('★ history_search 事件行必须裁剪投影，不能把原始 payload 透传给 LLM', async () => {
  const client = { getHistory: async () => ({ available: true, events: makeHistoryEvents(3) }) }
  const r = await createTools(client).history_search({ project: 'p1' })
  for (const row of r.events) {
    assert.equal(row.payload, undefined, '投影后的行不该再带原始 payload 字段')
    assert.ok(row.occurredAt, '必须保留 occurredAt')
    assert.ok(row.type, '必须保留 type')
    assert.ok(row.summary, '必须有人话摘要，不能是空壳')
  }
  assert.match(r.events[0].summary, /更新文件/)
  assert.match(r.events[0].summary, /file0\.md/)
  assert.match(r.events[1].summary, /assistant reply 1/)
})

test('★ history_search 的 fromMs/toMs 必须映射成 hub 的 from/to，session/serverId/type 必须原样转发', async () => {
  let captured
  const client = { getHistory: async (p) => { captured = p; return { available: true, events: [] } } }
  await createTools(client).history_search({
    session: 'ps-x', serverId: 'srv-A', type: 'tool.used', fromMs: 111, toMs: 222,
  })
  assert.equal(captured.session, 'ps-x')
  assert.equal(captured.server, 'srv-A', 'serverId 参数必须映射成 hub 的 server 查询键')
  assert.equal(captured.type, 'tool.used')
  assert.equal(captured.from, 111, 'fromMs 必须映射成 hub 的 from')
  assert.equal(captured.to, 222, 'toMs 必须映射成 hub 的 to')
})

test('★ history_search 的 limit 非法值回落默认、超上限被砍——不能被绕过去问 hub 要全部 500', async () => {
  let captured
  const client = { getHistory: async (p) => { captured = p; return { available: true, events: [] } } }
  const tools = createTools(client)
  await tools.history_search({ project: 'p1', limit: 'abc' })
  assert.equal(captured.limit, 50, '非数字 limit 必须回落默认值')
  await tools.history_search({ project: 'p1', limit: 999999 })
  assert.equal(captured.limit, 500, '超上限的 limit 必须被砍到 500')
})

// ---- M7：红线断言——暴露的工具集合 + hub-client 无写能力 ----

test('★★ M7 红线：MCP 暴露的工具集合必须恰好是这 8 个只读工具，不多不少', () => {
  const names = DEFS.map((d) => d.name).sort()
  // history_search（长程历史，P2）是本次唯一有意加入的新工具——扩容是刻意的，红线要跟着挪，
  // 但仍然只放行"只读"这一类：出现 approve_action/reject_action 之类的写工具就该炸。
  assert.deepEqual(names,
    ['fleet_overview', 'history_search', 'pending_list', 'project_progress', 'session_detail', 'session_find', 'session_tail', 'task_evidence'])
  // 双重核对：index.js 实际分发靠的是 createTools(client) 返回对象的 key，不是 DEFS——
  // 万一有人在 tools.js 里悄悄多加一个方法却忘了写进 DEFS（或反过来），这里也要能照出来。
  assert.deepEqual(Object.keys(T).sort(), names, 'createTools 暴露的方法名必须和对外广播的 DEFS 完全一致')
})

test('★★ M7 红线：hub-client 只做 GET，从不带 method/body——没有写能力就没有自我审批的物理可能', async () => {
  const calls = []
  const fetchImpl = async (_url, opts) => { calls.push(opts); return { ok: true, status: 200, json: async () => ({}) } }
  const client = createHubClient({ fetchImpl, baseUrl: 'http://fake', timeoutMs: 1000 })
  await client.getState()
  await client.getEvents('s1')
  await client.getPending()
  await client.getHistory({ project: 'p1' })
  await client.getProgress({ question: '120磁盘' })
  await client.getTaskEvidence('t1')
  assert.equal(calls.length, 6)
  for (const opts of calls) {
    assert.equal(opts.method, undefined, 'fetch 调用不能带 method——出现就可能是非 GET 的写操作')
    assert.equal(opts.body, undefined, 'fetch 调用不能带 body——只读工具集不该有请求体')
  }
  assert.deepEqual(Object.keys(client).sort(), ['getEvents', 'getHistory', 'getPending', 'getProgress', 'getState', 'getTaskEvidence'], 'hub client 不能多出任何写方法')
})
