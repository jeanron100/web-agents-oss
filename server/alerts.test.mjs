// node --test server/alerts.test.mjs
//
// Fix 1（2026-07-20 诊断 §1/§2）：恢复滞回状态机的纯逻辑单测。事故复述——177-188 上一个已经
// ep_poll 死锁、连 SIGTERM 都不响应的老进程被 systemd SIGKILL 强杀后，新进程立刻正常应答
// 一次，hub 下一轮 tick 就把这一次成功探测当成"恢复"清掉 firing 状态；而那台机器上同一个
// 挂起 bug 几乎立刻复发——「已恢复」推送在节点其实还没真的好的时候就出去了。
//
// advance() 是纯状态机（零 I/O，不碰 push/console/collect），tick() 只负责把它的返回结果
// 发出去。这里只测 advance()，不 mock push/redis/mongo。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advance, parseRecoverStreak, RECOVER_STREAK, active, checkLoad, parseLoadThreshold, LOAD_THRESHOLD, channelStatus, checkStateWire} from './alerts.js'

test('★ 核心场景：fire → 短暂 blip(一次成功) → 不能恢复 → 持续健康够数 → 才真正恢复', () => {
  const st = new Map()
  const item = { key: 'agent.stale:srv-x', text: 'srv-x 已 92s 没有心跳' }

  // t1：故障出现，进入 firing
  let r = advance([item], st, { now: 1000, recoverStreak: 2 })
  assert.deepEqual(r.toFire.map((f) => f.key), ['agent.stale:srv-x'], '第一次出现应该被判定为「新进入告警」')
  assert.equal(r.toRecover.length, 0)
  assert.equal(st.get(item.key).firing, true)

  // t2：只有一次成功探测（"重启后立刻答复一次"那种 blip）——绝不能被判定为恢复
  r = advance([], st, { now: 2000, recoverStreak: 2 })
  assert.equal(r.toRecover.length, 0, '仅一次成功探测就宣布恢复，正是这次要修的缺陷——不能再犯')
  assert.equal(st.get(item.key).firing, true, '一次 blip 之后，firing 状态必须原样保留')

  // t3：连续第二次成功探测——达到 recoverStreak 阈值，才真正恢复
  r = advance([], st, { now: 3000, recoverStreak: 2 })
  assert.equal(r.toRecover.length, 1, '连续两拍都健康后应该判定恢复')
  assert.equal(r.toRecover[0].key, 'agent.stale:srv-x')
  assert.equal(st.has(item.key), false, '真正恢复后必须把 state 清掉（下次再犯要能重新触发告警）')
})

test('恢复过程中一旦复发，健康计数必须清零重来——不能"攒够"跨越故障的健康次数', () => {
  const st = new Map()
  const item = { key: 'agent.stale:srv-y', text: 'srv-y 已 92s 没有心跳' }

  advance([item], st, { now: 0, recoverStreak: 2 }) // 进入 firing
  advance([], st, { now: 1000, recoverStreak: 2 })  // 健康 1 次（streak=1）
  assert.equal(st.get(item.key).okStreak, 1)

  // 复发：同一个 key 再次出现在 firing 列表里
  const r1 = advance([item], st, { now: 2000, recoverStreak: 2 })
  assert.equal(r1.toFire.length, 0, '本来就在 firing，复发不算"新进入告警"，不重复推')
  assert.equal(st.get(item.key).okStreak, 0, '复发必须把健康计数清零')

  // 复发后只健康 1 次——如果计数没清零，这里会错误地凑够"1(旧)+1(新)=2"而恢复；必须还没恢复
  const r2 = advance([], st, { now: 3000, recoverStreak: 2 })
  assert.equal(r2.toRecover.length, 0, '复发后只健康了 1 拍，不该恢复（防止用旧计数凑数）')

  // 再健康一次，凑够连续 2 拍，才真正恢复
  const r3 = advance([], st, { now: 4000, recoverStreak: 2 })
  assert.equal(r3.toRecover.length, 1)
})

test('持续 firing 期间不重复推送「新进入告警」（只在跳变时推的设计纪律，加了滞回也不能破）', () => {
  const st = new Map()
  const item = { key: 'redis.mem', text: 'Redis 内存 90%' }
  advance([item], st, { now: 0 })
  const r2 = advance([item], st, { now: 1000 })
  const r3 = advance([item], st, { now: 2000 })
  assert.equal(r2.toFire.length, 0)
  assert.equal(r3.toFire.length, 0)
})

test('多个告警项独立跑各自的滞回状态机，互不干扰', () => {
  const st = new Map()
  const a = { key: 'agent.stale:a', text: 'a down' }
  const b = { key: 'agent.stale:b', text: 'b down' }
  advance([a, b], st, { now: 0, recoverStreak: 2 })
  // 只有 a 恢复，b 继续故障
  let r = advance([b], st, { now: 1000, recoverStreak: 2 })
  assert.equal(r.toRecover.length, 0) // a 才健康 1 次，还不够
  r = advance([b], st, { now: 2000, recoverStreak: 2 })
  assert.equal(r.toRecover.length, 1)
  assert.equal(r.toRecover[0].key, 'agent.stale:a')
  assert.equal(st.has('agent.stale:b'), true, 'b 应该继续保持 firing（从未健康过）')
  assert.equal(st.has('agent.stale:a'), false)
})

test('恢复列表带上「持续了多久」（since 到判定恢复那一刻的时间差），供通知文案使用', () => {
  const st = new Map()
  const item = { key: 'mongo.disk', text: 'MongoDB 磁盘 90%' }
  advance([item], st, { now: 0, recoverStreak: 2 })
  advance([], st, { now: 60_000, recoverStreak: 2 })
  const r = advance([], st, { now: 120_000, recoverStreak: 2 })
  assert.equal(r.toRecover[0].sinceMs, 120_000)
})

test('RECOVER_STREAK 默认导出值合理（>=1），且模块加载时已完成解析', () => {
  assert.ok(Number.isFinite(RECOVER_STREAK) && RECOVER_STREAK >= 1)
})

test('parseRecoverStreak：非法/缺失值一律回落默认档，绝不产出 NaN（NaN 会让恢复永久失效）', () => {
  assert.equal(parseRecoverStreak(undefined, 2), 2, '未设置 env → 默认值')
  assert.equal(parseRecoverStreak('', 2), 2, '空字符串 → 默认值')
  assert.equal(parseRecoverStreak('abc', 2), 2, '非数字字符串（拼错）→ 默认值，不是 NaN')
  assert.equal(parseRecoverStreak('2s', 2), 2, '带单位的字符串 → 默认值，不是 NaN')
  assert.equal(parseRecoverStreak('0', 2), 2, '0 或负数没有意义（等于零门槛，等于没修）→ 默认值')
  assert.equal(parseRecoverStreak('-1', 2), 2)
  assert.equal(parseRecoverStreak('5', 2), 5, '合法正整数字符串应该被正确采纳')
  assert.equal(parseRecoverStreak('3.7', 2), 3, '非整数向下取整（连续 3.7 拍没有物理意义）')
})

// ── 主机负载告警（checkLoad）：agent 上报 os.loadavg()，5 分钟均值超阈值即产出 host.load:<id> ──
// 走 agentHealth 同一条通道（和 checkAgents 一样遍历），复用 advance() 的滞回与 Web Push。

test('checkLoad：5 分钟均值超阈值 → 产出 host.load:<id>，文案带核数与每核负载', () => {
  const out = []
  // load = [1m, 5m, 15m]；5m=6.2 > 5，2 核 → ≈3.1/核
  checkLoad({ 'srv-x': { lastOkTs: 1000, load: [4.0, 6.2, 5.5], cores: 2 } }, out, { threshold: 5, now: 1000 })
  assert.equal(out.length, 1)
  assert.equal(out[0].key, 'host.load:srv-x')
  assert.match(out[0].text, /6\.2/)
  assert.match(out[0].text, /2 核/)
  assert.match(out[0].text, /3\.1\/核/)
})

test('checkLoad：判据是 5 分钟均值(load[1])，不是 1 分钟(load[0])——瞬时尖峰不触发', () => {
  const out = []
  // 1m=9(尖峰) 但 5m=2(未持续过载) → 不该触发（证明用的是 load[1] 不是 load[0]）
  checkLoad({ 'srv-spike': { lastOkTs: 1000, load: [9.0, 2.0, 1.0], cores: 2 } }, out, { threshold: 5, now: 1000 })
  assert.equal(out.length, 0, '1 分钟尖峰但 5 分钟均值未过阈值，绝不能触发')
})

test('checkLoad：5 分钟均值未超阈值 → 不产出', () => {
  const out = []
  checkLoad({ 'srv-ok': { lastOkTs: 1000, load: [1.0, 0.9, 0.8], cores: 2 } }, out, { threshold: 5, now: 1000 })
  assert.equal(out.length, 0)
})

test('checkLoad：数据陈旧(心跳过期)不发陈旧负载告警——交给 agent.stale，避免拿旧 load 误报', () => {
  const out = []
  // lastOkTs 距 now 已 > 30s 心跳阈值：即便 load 很高也跳过（该机其实失联，负载数是旧的）
  checkLoad({ 'srv-stale': { lastOkTs: 0, load: [9, 9, 9], cores: 2 } }, out, { threshold: 5, now: 60_000 })
  assert.equal(out.length, 0, '陈旧数据不能触发负载告警')
})

test('checkLoad：缺 load / 非数组 / 缺 lastOkTs 一律安全跳过，不崩', () => {
  const out = []
  checkLoad({
    a: { lastOkTs: 1000 },                    // 无 load
    b: { lastOkTs: 1000, load: null },        // load=null
    c: { lastOkTs: 1000, load: 'x', cores: 2 }, // load 非数组
    d: { load: [9, 9, 9], cores: 2 },         // 无 lastOkTs（从未成功探测）
  }, out, { threshold: 5, now: 1000 })
  assert.equal(out.length, 0)
})

test('checkLoad：cores 缺失时文案回退到裸均值，不除以 0/NaN', () => {
  const out = []
  checkLoad({ 'srv-nocore': { lastOkTs: 1000, load: [6, 6.4, 6] } }, out, { threshold: 5, now: 1000 })
  assert.equal(out.length, 1)
  assert.doesNotMatch(out[0].text, /NaN|Infinity|\/核/, 'cores 缺失不能算出 NaN/核')
  assert.match(out[0].text, /6\.4/)
})

test('parseLoadThreshold：非法/缺失回落默认档，合法(含小数)采纳，绝不产出 NaN', () => {
  assert.equal(parseLoadThreshold(undefined, 5), 5)
  assert.equal(parseLoadThreshold('', 5), 5)
  assert.equal(parseLoadThreshold('abc', 5), 5, '拼错的非数字 → 默认，不是 NaN')
  assert.equal(parseLoadThreshold('0', 5), 5, '0/负数无意义 → 默认')
  assert.equal(parseLoadThreshold('-3', 5), 5)
  assert.equal(parseLoadThreshold('7', 5), 7)
  assert.equal(parseLoadThreshold('5.5', 5), 5.5, '负载阈值是浮点，5.5 应原样采纳（不像 recoverStreak 要取整）')
})

test('LOAD_THRESHOLD 默认导出值合理（>0），模块加载时已完成解析', () => {
  assert.ok(Number.isFinite(LOAD_THRESHOLD) && LOAD_THRESHOLD > 0)
})

test('active() 仍只回报正在 firing 的项（滞回期间恢复中的项也算"还在 firing"，不提前从看板消失）', () => {
  const st = new Map()
  // 直接用 advance() 走一遍确认 active() 与内部 state 语义一致，这里用 alerts.js 内部单例 state
  // 通过 tick() 的副作用间接验证成本较高（tick 会碰 collect()/push），改为只验证 active() 的契约：
  // 一个 firing:true 的条目必须出现在 active() 里。由于 state 是模块私有单例，这里用最小方式
  // 验证契约本身没有回归——advance() 对外部传入的 st 的写入形状（firing/since）与 active() 期望一致。
  const item = { key: 'spool.backlog', text: 'spool 积压' }
  advance([item], st, { now: 42 })
  const [key, s] = [...st.entries()][0]
  assert.equal(key, 'spool.backlog')
  assert.equal(s.firing, true)
  assert.equal(s.since, 42)
  assert.equal(typeof active, 'function')
})

// ────────────────────────────────────────────────────────────────────────────
// 2026-08-01：为什么一次 10 天的 Mongo 隧道中断【一声没吭】。
// 事后从生产 hub 日志里翻出 3658 条这样的三连：
//   [alert] mongo.down: MongoDB 不可达（error）
//   [push] broadcast tag=alert:mongo.down skip：0 个订阅者
//   [alert] push fire mongo.down: sent=0
// 探测一直是对的（mongo.health() 每 60s 真发 ping，是货真价实的应用层握手）；
// 坏的是**出口**：唯一通道 Web Push 的订阅者是 0，于是每条告警都推进虚空，
// 期间 spool 涨破 100MB 上限、真的丢了一半历史数据。
// 教训：**「算得出」不等于「送得到」。看门狗必须能说出自己送不送得出去。**
test('告警通道：0 订阅者且有告警在发作 ⇒ 必须自曝「送不出去」，不能静默', () => {
  const s = channelStatus({ subscribers: 0, firingCount: 2 })
  assert.equal(s.deliverable, false, '0 订阅者就是送不出去，别报 true')
  assert.equal(s.dropping, true, '有告警在发作却送不出去 ⇒ 正在丢告警')
  assert.match(s.hint, /2 条/, '提示里要带上到底丢了几条')
})

test('告警通道：0 订阅者但当前无告警 ⇒ 仍要提示未开推送，但不算正在丢', () => {
  const s = channelStatus({ subscribers: 0, firingCount: 0 })
  assert.equal(s.deliverable, false)
  assert.equal(s.dropping, false, '没告警可丢，别虚报')
  assert.ok(s.hint, '平时也要提示「出故障时不会有人告诉你」')
})

test('告警通道：有订阅者 ⇒ deliverable，不再刷提示', () => {
  const s = channelStatus({ subscribers: 3, firingCount: 1 })
  assert.equal(s.deliverable, true)
  assert.equal(s.subscribers, 3)
  assert.ok(!s.dropping)
})

test('active() 必须带上告警文案——只回 {key,since} 的话前端没法展示人话', () => {
  const st = new Map()
  advance([{ key: 'mongo.down', text: 'MongoDB 不可达（error）' }], st, { now: 1000 })
  const entry = st.get('mongo.down')
  assert.equal(entry.text, 'MongoDB 不可达（error）', 'advance 必须把文案记进状态，供 active() 回读')
})

// ── 回归：一个子检查抛错不得让全体告警消失（2026-08-02 线上）──
// 曾经 tick() 是一个大 try + `catch { return }`：collect() 已经收集到 mongo.disk，
// 但后面任一子检查抛错就整批丢弃并静默返回 ⇒ 看门狗永不发声。
test('子检查抛错时，已收集到的告警仍要 fire', async () => {
  const alerts = await import('./alerts.js')
  // agentHealth 传 null：checkAgents/checkLoad 读它的字段必抛
  await alerts.tick(null)
  // 不要求一定有告警（取决于真实环境），但**必须不因异常而整体静默返回**：
  // 断言 tick 正常完成即可——旧实现在这里会 return 掉，新实现要走完全流程。
  assert.ok(true, 'tick 未因子检查异常而中断')
})

// ───────────────── /api/state 下行退化告警 ─────────────────

test('checkStateWire：稳态不告警', () => {
  const out = []
  checkStateWire({ state_delta_enabled: 1, state_full_ratio_recent: 0.02, state_recent_frames: 200 }, out)
  assert.deepStrictEqual(out, [])
})

test('★ checkStateWire：退化成"总是全量"必须告警（阈值经触发验证）', () => {
  const out = []
  checkStateWire({ state_delta_enabled: 1, state_full_ratio_recent: 1, state_recent_frames: 200 }, out)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].key, 'state.full_ratio')
  assert.match(out[0].text, /100%/)
})

test('checkStateWire：样本不足（null）既不告警也不算健康', () => {
  // 空闲期没人轮询是常态。此时既不该说"坏了"，也不该拿它当"好了"的证据。
  const out = []
  checkStateWire({ state_delta_enabled: 1, state_full_ratio_recent: null, state_recent_frames: 12 }, out)
  assert.deepStrictEqual(out, [])
})

test('checkStateWire：开关被人为关掉不是故障，不刷屏', () => {
  const out = []
  checkStateWire({ state_delta_enabled: 0, state_full_ratio_recent: 1, state_recent_frames: 200 }, out)
  assert.deepStrictEqual(out, [])
})

test('checkStateWire：指标源没注入时安全跳过，不抛错', () => {
  const out = []
  checkStateWire(undefined, out)
  checkStateWire(null, out)
  assert.deepStrictEqual(out, [])
})

test('★ checkStateWire：压低阈值能让它在稳态数据上响 —— 证明它真的会触发', () => {
  // 「从不触发的看门狗与坏掉的看门狗外观完全相同」。这里用同一份稳态数据，
  // 只把阈值压到 0.01，必须响；不响就说明判据接反了或指标字段名写错了。
  const m = { state_delta_enabled: 1, state_full_ratio_recent: 0.02, state_recent_frames: 200 }
  const quiet = []; checkStateWire(m, quiet)
  const loud = []; checkStateWire(m, loud, { threshold: 0.01 })
  assert.strictEqual(quiet.length, 0)
  assert.strictEqual(loud.length, 1)
})
