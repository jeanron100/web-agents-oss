// server/mcp/filters.test.mjs
// node --test server/mcp/filters.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStuck, findSessions, STUCK_IDLE_MS, STUCK_MAX_IDLE_MS } from './filters.js'

const NOW = 10_000_000
const mk = (o = {}) => ({
  id: 'ps-1', serverId: 'srv-178-232', project: 'web_agents', engine: 'claude',
  state: 'idle', inflight: false, lastActiveAt: NOW - 60 * 60_000, ...o,
})

test('★ 空闲够久 + 回合不在飞 → stuck', () => {
  assert.equal(isStuck(mk(), NOW), true)
})

test('★ 回合在飞 → 绝不算 stuck（它正在干活）', () => {
  assert.equal(isStuck(mk({ inflight: true }), NOW), false)
})

test('★ 等待用户的会话不算 stuck——那是在等人，不是卡住', () => {
  assert.equal(isStuck(mk({ state: 'waiting_input' }), NOW), false)
  assert.equal(isStuck(mk({ state: 'waiting_approval' }), NOW), false)
})

test('★ 已分离会话不算 stuck——agent 进程已退出，没有进程谈不上卡住', () => {
  // 关键：这个会话满足传统"卡住"的所有条件——长时间空闲、不在飞、state=idle
  // 但 detached=true 意味着它只是历史记录，不应该被计入故障指标
  assert.equal(isStuck(mk({ detached: true, lastActiveAt: NOW - 120 * 60_000 }), NOW), false)
})

test('空闲未达阈值 → 不算 stuck', () => {
  assert.equal(isStuck(mk({ lastActiveAt: NOW - 60_000 }), NOW), false)
})

test('★ findSessions 必须封顶，否则一次调用能吐几十条把上下文烧干', () => {
  const many = Array.from({ length: 150 }, (_, i) => mk({ id: `ps-${i}` }))
  assert.equal(findSessions(many, {}, NOW).length, 20)          // 默认 20
  assert.equal(findSessions(many, { limit: 5 }, NOW).length, 5)
  // 上限护栏必须硬生效——无效的 limit 绝不能绕过
  assert.equal(findSessions(many, { limit: 99999 }, NOW).length, 100) // MAX_LIMIT=100
  assert.equal(findSessions(many, { limit: NaN }, NOW).length, 20)    // 无效 → 默认值
  assert.equal(findSessions(many, { limit: 0 }, NOW).length, 20)      // 零 → 默认值
  assert.equal(findSessions(many, { limit: -5 }, NOW).length, 20)     // 负 → 默认值
})

test('按 serverId / project / engine / state 过滤', () => {
  const list = [
    mk({ id: 'a', serverId: 'srv-A', project: 'p1', state: 'idle', lastActiveAt: NOW - 10 * 60_000 }),
    mk({ id: 'b', serverId: 'srv-B', project: 'p2', state: 'running', engine: 'codex', lastActiveAt: NOW - 120 * 60_000 }),
    mk({ id: 'c', serverId: 'srv-A', project: 'p2', state: 'idle', engine: 'codex', lastActiveAt: NOW - 60 * 60_000 }),
  ]
  // serverId 过滤
  assert.deepEqual(findSessions(list, { serverId: 'srv-B' }, NOW).map(s => s.id), ['b'])
  // project 过滤——删此行实现应失败
  // 顺序是 ['c', 'b']（不是 ['b', 'c']）：无 stuck 时默认按最近活跃优先排序，
  // c（idle 60min）比 b（idle 120min）更"新"，理应排前面——这正是本次修复的缺陷1。
  assert.deepEqual(findSessions(list, { project: 'p2' }, NOW).map(s => s.id), ['c', 'b'])
  // engine 过滤——同上，c 更近，排前面
  assert.deepEqual(findSessions(list, { engine: 'codex' }, NOW).map(s => s.id), ['c', 'b'])
  // state 过滤——删此行实现应失败
  assert.deepEqual(findSessions(list, { state: 'running' }, NOW).map(s => s.id), ['b'])
})

test('★ stuck=true 只返回卡住的；结果按空闲时长降序（最可疑的在最前）', () => {
  const list = [
    mk({ id: 'fresh', lastActiveAt: NOW - 60_000 }),
    mk({ id: 'old', lastActiveAt: NOW - 120 * 60_000 }),
    mk({ id: 'mid', lastActiveAt: NOW - 60 * 60_000 }),
  ]
  assert.deepEqual(findSessions(list, { stuck: true }, NOW).map(s => s.id), ['old', 'mid'])
})

// ---- 缺陷1：默认排序方向搞反了 ----
// 真实翻车现场（2026-07-20，session_find 默认参数无 stuck）：
//   019e59a0 srv-177-188 tiny_yurts    idle idle=80968min（56 天前）
//   019e8faa srv-189-4   agent_office  idle idle=66982min（46 天前）
// 旧实现无条件按空闲降序排序，"舰队现在什么状况"这种默认查询被这几条月龄的
// 化石会话占满 20 条上限，真正当下发生的事情被挤出结果之外。
// 用真实量级差异悬殊的夹具（56 天 vs 5 分钟 vs 1 小时），保证升序/降序两种
// 排列产生的结果顺序确实不同，不会因为夹具凑巧对称而测不出问题。
test('★ 默认（无 stuck）按最近活跃优先排序，不是按空闲降序——问的是"现在"不是"考古"', () => {
  const list = [
    mk({ id: 'fossil', lastActiveAt: NOW - 80968 * 60_000 }),  // 56 天前，现场真实数值
    mk({ id: 'recent', lastActiveAt: NOW - 5 * 60_000 }),      // 5 分钟前
    mk({ id: 'mid', lastActiveAt: NOW - 60 * 60_000 }),        // 1 小时前
  ]
  assert.deepEqual(findSessions(list, {}, NOW).map(s => s.id), ['recent', 'mid', 'fossil'])
})

test('★ findSessions stuck=true 排除已分离会话，即使它们长时间空闲', () => {
  const list = [
    mk({ id: 'detached-old', detached: true, lastActiveAt: NOW - 120 * 60_000 }),
    mk({ id: 'live-mid', lastActiveAt: NOW - 60 * 60_000 }),
    mk({ id: 'live-old', lastActiveAt: NOW - 150 * 60_000 }),
  ]
  // 只返回活跃的卡住会话，排除已分离的
  assert.deepEqual(findSessions(list, { stuck: true }, NOW).map(s => s.id), ['live-old', 'live-mid'])
})

test('minIdleMin 过滤——删实现应失败', () => {
  const list = [
    mk({ id: 'fresh', lastActiveAt: NOW - 5 * 60_000 }),      // 5 分钟前
    mk({ id: 'mid', lastActiveAt: NOW - 30 * 60_000 }),       // 30 分钟前
    mk({ id: 'old', lastActiveAt: NOW - 120 * 60_000 }),      // 2 小时前
  ]
  // 只返回空闲 >= 30 分钟的；顺序 ['mid', 'old']——无 stuck 时默认按最近活跃优先，
  // mid（30min）比 old（120min）更近，排前面。
  assert.deepEqual(findSessions(list, { minIdleMin: 30 }, NOW).map(s => s.id), ['mid', 'old'])
  // 只返回空闲 >= 60 分钟的
  assert.deepEqual(findSessions(list, { minIdleMin: 60 }, NOW).map(s => s.id), ['old'])
})

test('idle 边界——恰好达到 STUCK_IDLE_MS', () => {
  // 距现在恰好 STUCK_IDLE_MS → 应该 stuck
  const exact = mk({ lastActiveAt: NOW - STUCK_IDLE_MS })
  assert.equal(isStuck(exact, NOW), true, 'idle 恰好达到阈值应为 stuck')

  // 距现在 STUCK_IDLE_MS - 1ms → 不应该 stuck
  const almostThere = mk({ lastActiveAt: NOW - (STUCK_IDLE_MS - 1) })
  assert.equal(isStuck(almostThere, NOW), false, 'idle 不足阈值 1ms 应不为 stuck')
})

test('STUCK_IDLE_MS 默认 30 分钟（与 reaper 口径一致但独立可调）', () => {
  assert.equal(STUCK_IDLE_MS, 30 * 60_000)
})

// ---- 缺陷2：idle 没有上界，几周/几月前的化石会话被算作"卡住" ----
// 现场真实数据：019e59a0 srv-177-188 tiny_yurts idle idle=80968min（56 天）——
// 满足旧判据的全部条件（不在飞、不分离、不等人、idle>=30min），被报成 stuck。
// 但"卡住"该表达"本该推进却没推进"，这只在近期窗口内有意义；56 天前的会话
// 已经不是故障，是没人来收尾的历史记录。
test('★★ 空闲超过 STUCK_MAX_IDLE_MS（现场 56 天化石）不再算 stuck——上界必须存在', () => {
  const fossil = mk({ lastActiveAt: NOW - 80968 * 60_000 })  // 56 天前，现场真实数值
  assert.equal(isStuck(fossil, NOW), false, '56 天前的化石会话不该被算作 stuck')

  // 对照组：窗口内（1 小时空闲）依然按原判据是 stuck——上界不能连累窗口内的真实卡住会话
  const recentStuck = mk({ lastActiveAt: NOW - 60 * 60_000 })
  assert.equal(isStuck(recentStuck, NOW), true, '窗口内的空闲会话不受上界影响，仍应为 stuck')
})

test('idle 上界边界——恰好等于 STUCK_MAX_IDLE_MS 仍算 stuck，超出 1ms 就不算', () => {
  const exact = mk({ lastActiveAt: NOW - STUCK_MAX_IDLE_MS })
  assert.equal(isStuck(exact, NOW), true, 'idle 恰好等于上界应仍为 stuck（闭区间）')

  const justOver = mk({ lastActiveAt: NOW - (STUCK_MAX_IDLE_MS + 1) })
  assert.equal(isStuck(justOver, NOW), false, 'idle 超出上界 1ms 应不再为 stuck')
})

test('STUCK_MAX_IDLE_MS 默认 24 小时', () => {
  assert.equal(STUCK_MAX_IDLE_MS, 24 * 60 * 60_000)
})

// ---- STUCK_MAX_IDLE_MS 必须走 parseEnvNumber，理由同 STUCK_IDLE_MS 那条(I3) ----
// 裸 Number(process.env...) 遇到垃圾 env 值会得到 NaN，而 `idle <= maxIdleMs` 对 NaN
// 恒为 false——上界会被静默焊死成"什么都不算 stuck"，等价于闸门被永久堵死。
test('★★ STUCK_MAX_IDLE_MS 必须走 parseEnvNumber——垃圾 env 值不能让它变成 NaN', async () => {
  const key = 'WA_MCP_STUCK_MAX_IDLE_MS'
  const original = process.env[key]
  process.env[key] = 'not-a-number'
  try {
    const mod = await import(`./filters.js?cachebust=${Date.now()}-${Math.random()}`)
    assert.ok(Number.isFinite(mod.STUCK_MAX_IDLE_MS), 'STUCK_MAX_IDLE_MS 不能是 NaN——垃圾 env 值必须被拦截')
    assert.equal(mod.STUCK_MAX_IDLE_MS, 24 * 60 * 60_000, '垃圾 env 值必须回落到默认值 24 小时，而不是变成 NaN')
    // 双重确认：窗口内（1 小时空闲）的会话必须仍判定为 stuck——不能因 NaN 传染而恒为 false
    const nowMs = 999_999_999
    const stuckSession = { inflight: false, state: 'idle', lastActiveAt: nowMs - 60 * 60_000 }
    assert.equal(mod.isStuck(stuckSession, nowMs), true,
      '拿回落后的上界判定一个窗口内的空闲会话，必须仍是 stuck——不能因 NaN 传染而恒为 false')
  } finally {
    if (original === undefined) delete process.env[key]; else process.env[key] = original
  }
})

// ---- I3：STUCK_IDLE_MS 必须走 parseEnvNumber，不能是裸 Number(...) ----
// 根因：旁边两个常量（DEFAULT_LIMIT/MAX_LIMIT）都走 parseEnvNumber，STUCK_IDLE_MS 当年漏了，
// 直接用 Number(process.env.… ?? 默认值)。垃圾 env 值（非数字字符串）会让它变成 NaN，
// 而 isStuck() 的判据是 `(nowMs - last) >= idleMs`——NaN 参与比较恒为 false，
// 于是每个工具都会报"全员正常"的假消息。用动态 import + query 参数绕过模块缓存，
// 在设置垃圾 env 值之后重新加载 filters.js，验证 STUCK_IDLE_MS 没有被污染成 NaN。
test('★★ STUCK_IDLE_MS 必须走 parseEnvNumber——垃圾 env 值不能让它变成 NaN（NaN 会让 isStuck 对谁都返回 false）', async () => {
  const key = 'WA_MCP_STUCK_IDLE_MS'
  const original = process.env[key]
  process.env[key] = 'not-a-number'
  try {
    const mod = await import(`./filters.js?cachebust=${Date.now()}-${Math.random()}`)
    assert.ok(Number.isFinite(mod.STUCK_IDLE_MS), 'STUCK_IDLE_MS 不能是 NaN——垃圾 env 值必须被拦截')
    assert.equal(mod.STUCK_IDLE_MS, 30 * 60_000, '垃圾 env 值必须回落到默认值 30 分钟，而不是变成 NaN')
    // 双重确认：拿这个 NaN 风险值直接喂给 isStuck，任何空闲会话都不该被判定为"正常"
    // （lastActiveAt 故意给非零值——isStuck 内部用 `s.lastActiveAt || s.startedAt || nowMs`，
    // 0 会被当假值跳过，那是另一个已知的 `||` 陷阱，不是本测试要验的东西）
    // idle 定在 1 小时（落在 [30min, 24h] 的 stuck 窗口内），而不是任意巨大值——
    // 本测试验的是 NaN 不传染，不是上界判据（上界另有专门测试），idle 若落在窗口外，
    // 会被新加的 STUCK_MAX_IDLE_MS 上界正确判为"不 stuck"，反而让这条断言测错东西。
    const nowMs = 999_999_999
    const stuckSession = { inflight: false, state: 'idle', lastActiveAt: nowMs - 60 * 60_000 }
    assert.equal(mod.isStuck(stuckSession, nowMs, mod.STUCK_IDLE_MS), true,
      '拿回落后的阈值判定一个明显空闲很久的会话，必须是 stuck——不能因 NaN 传染而恒为 false')
  } finally {
    if (original === undefined) delete process.env[key]; else process.env[key] = original
  }
})
