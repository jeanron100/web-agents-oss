// server/alerts.js — 数据层看门狗（openspec db-redis-mongo-phase1 / P4 5.2）
//
// 监什么：Redis 内存 >80% / Mongo 磁盘 >80% / spool 积压 >100MB / 隧道断 >60s / 心跳缺 >30s /
//         备份陈旧 >30h。这些都是「悄悄坏掉、等你需要时才发现」的那类故障——**必须主动告警**。
//
// 两条设计纪律：
//  ① **只在跳变时推**（进入告警 / 恢复各推一次）。不然一个持续 3 天的磁盘告警会每分钟推一条，
//     用户会关掉推送——然后真出事时你一条都送不到。
//  ② **看门狗自己绝不能把主链路搞挂**：所有检查各自 try/catch，任何异常只让该项跳过，
//     绝不冒泡到 hub 的轮询循环。
//
// 通道：Web Push（飞书按用户决定短期不启用）。没有订阅者时静默跳过——不报错、不重试。

import fs from 'node:fs'
import * as push from './push.js'
import * as redisMod from './redis.js'
import * as mongo from './mongo.js'
import * as spool from './spool.js'
import { flags } from './flags.js'
import { parseFullRatioThreshold } from './state-delta.js'

const THRESH = {
  redisMemPct: 80,
  mongoDiskPct: 80,
  spoolBytes: 100 * 1024 * 1024,   // 100MB
  heartbeatMs: 30_000,
  backupStaleH: 30,                 // 每日备份 → 超过 30h 没更新即异常
}
const BACKUP_DIR = process.env.WA_MONGO_BACKUP_DIR || '/data/backups/mongo'

// 恢复滞回阈值（Fix 1，2026-07-20 诊断 §1/§2）：一次成功探测就宣布「恢复」曾经在一次真实
// 事故里踩到——177-188 上一个已经 ep_poll 死锁、连 SIGTERM 都不响应的老进程被 systemd
// SIGKILL 强杀后，新进程立刻正常应答一次，hub 下一轮 tick 就看到 age 低于阈值、判定「恢复」，
// 但那台机器上同一个挂起 bug 几乎立刻复发——「已恢复」推送在节点其实还没真的好的时候就出去了。
// 现在要求连续 RECOVER_STREAK 次 tick 都不再 firing 才真正判定恢复；只要中途再犯一次，
// 计数清零重来。默认 2 次（配合 hub 60s 一轮的 alerts.tick，等价于至少约 60~120s 的持续健康），
// 可用 WA_ALERT_RECOVER_STREAK 覆盖，但拒绝裸 Number(process.env…)：环境变量写错/传了非数字
// 字符串会得到 NaN，`okStreak >= NaN` 恒为 false，等于把「恢复」这条路彻底焊死、永远恢复不了——
// 比默认值更危险，所以用 Number.isFinite 显式校验，非法值一律退回默认档，不静默失效。
const DEFAULT_RECOVER_STREAK = 2

/**
 * 防御性解析（可离线单测，见 alerts.test.mjs）：裸 `Number(process.env.X ?? default)` 在
 * 环境变量被设成非数字字符串（拼错/传了单位如"2s"）时会得到 NaN——`??` 只挡 null/undefined，
 * 挡不住"存在但非法"的值。而 `okStreak >= NaN` 恒为 false，等于把"恢复"这条路永久焊死，
 * 比默认值更危险、还悄无声息。这里显式 Number.isFinite 校验，非法值一律退回默认档。
 */
export function parseRecoverStreak(raw, fallback = DEFAULT_RECOVER_STREAK) {
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

export const RECOVER_STREAK = parseRecoverStreak(process.env.WA_ALERT_RECOVER_STREAK)

// 主机负载阈值（WA_LOAD_THRESHOLD，默认 5）：判据是 **5 分钟均值**（os.loadavg()[1]），持续过载
// 才叫真问题、排除瞬时尖峰。集群全是 2 核 → raw 5 = 每核 2.5 个待运行进程持续排队，明确"出事了"。
// 与 parseRecoverStreak 同款防御：裸 Number(env) 遇非法值得 NaN，`x > NaN` 恒 false = 把这条告警
// 悄悄焊死（永远不触发），比默认值更危险。这里 Number.isFinite 校验，非法一律退默认。
// 区别：负载阈值是**浮点**（5.5 合法），不像 recoverStreak 是整数拍数，故不取整。
const DEFAULT_LOAD_THRESHOLD = 5
export function parseLoadThreshold(raw, fallback = DEFAULT_LOAD_THRESHOLD) {
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? v : fallback
}
export const LOAD_THRESHOLD = parseLoadThreshold(process.env.WA_LOAD_THRESHOLD)

// /api/state 全量帧占比阈值（WA_STATE_FULL_RATIO，默认 0.5）。稳态实测应 ≈0.02
// （一次页面加载一个 snapshot，之后全是 delta），退化成"总是全量"则为 1.0——
// 0.5 离两端都远，不会被偶发刷新误触。解析防线同 parseLoadThreshold（见 state-delta.js）。
const STATE_FULL_RATIO_THRESHOLD = parseFullRatioThreshold(process.env.WA_STATE_FULL_RATIO)

// key -> { firing: bool, since: ms, okStreak: number }。只在「新进入告警」/「连续健康够数」两类
// 跳变时推送，中间的每一拍都不重复推——这条设计纪律不能因为加滞回就变了（见文件头注释①）。
const state = new Map()

/**
 * 纯状态机（可离线单测，见 alerts.test.mjs）：给定本轮真正在告警的项，把 `st`（调用方持有、
 * 就地推进）推进到下一轮，返回这一拍需要推送的「新进入告警」与「连续健康够数、真正恢复」列表。
 * 不做任何 I/O（不碰 push/console/collect）——tick() 只负责喂数据进来、把返回结果发出去。
 * @param items 本轮 firing 的 [{key, text}]
 * @param st Map<key, {firing, since, okStreak}>，调用方持有并跨轮传入
 * @param opts.now 当前时间戳（可注入，测试用来模拟"跨轮推进"而不必真的等墙钟）
 * @param opts.recoverStreak 需要连续多少拍"不在 active 里"才判定恢复（默认 RECOVER_STREAK）
 */
export function advance(items, st, { now = Date.now(), recoverStreak = RECOVER_STREAK } = {}) {
  const active = new Set(items.map((f) => f.key))
  const toFire = []
  const toRecover = []

  for (const f of items) {
    const s = st.get(f.key)
    if (!s?.firing) {
      // text 一并记住：active() 要把人话给前端展示。只回 {key,since} 的话，界面上只能显示
      // 一个「mongo.down」这样的裸 key，等于没说。
      st.set(f.key, { firing: true, since: now, okStreak: 0, text: f.text })
      toFire.push(f)
    } else {
      s.okStreak = 0 // 仍在发作：清空恢复计数——防止"发作中途巧合过关一拍"被计进连续健康
      s.text = f.text // 文案会随实测值变（如「已 92s 没有心跳」），保持最新
    }
  }

  for (const [key, s] of st) {
    if (!s.firing || active.has(key)) continue // 还在 firing 的项已在上面处理；active 里的不算恢复
    s.okStreak += 1
    if (s.okStreak < recoverStreak) continue // 没连续健康够数，继续按 firing 挂着，不清状态、不推送
    const sinceMs = now - s.since
    st.delete(key)
    toRecover.push({ key, sinceMs })
  }

  return { toFire, toRecover }
}

/** 逐项检查，返回当前**正在告警**的项。任何一项抛错只跳过它自己。 */
async function collect() {
  const out = []
  const add = (key, text) => out.push({ key, text })

  // Redis：内存占比 + 可达性
  try {
    if (flags.redisEnabled()) {
      const h = await redisMod.health()
      if (h?.status !== 'ok') add('redis.down', `Redis 不可达（${h?.status ?? '未知'}）——协调层降级为直连，主链路不受影响`)
      const m = await redisMod.memory?.()
      if (m && m.maxmemory > 0) {
        const pct = Math.round((m.used / m.maxmemory) * 100)
        if (pct >= THRESH.redisMemPct) {
          // noeviction 策略下内存打满 = **写入直接报错**，不是淘汰旧键——比"缓存满了"严重得多
          add('redis.mem', `Redis 内存 ${pct}%（${(m.used / 1048576).toFixed(1)}MB / ${(m.maxmemory / 1048576).toFixed(0)}MB）。策略是 noeviction：打满即写入报错，不是淘汰旧键`)
        }
      }
    }
  } catch { /* 单项失败不影响其余检查 */ }

  // Mongo：可达性 + 磁盘占比
  try {
    if (flags.mongoEnabled()) {
      const h = await mongo.health()
      if (h?.status !== 'ok') add('mongo.down', `MongoDB 不可达（${h?.status ?? '未知'}）——历史投影落 spool，恢复后自动重放；实时链路不受影响`)
      const d = await mongo.diskUsage?.()
      if (d && d.pct >= THRESH.mongoDiskPct) add('mongo.disk', `MongoDB 所在磁盘已用 ${d.pct}%（${mongo.hostLabel?.() ?? '未知主机'}）`)
    }
  } catch { /* ignore */ }

  // spool 积压：Mongo 长期不可用时事件堆在本地
  try {
    const b = spool.sizeBytes()
    if (b >= THRESH.spoolBytes) {
      add('spool.backlog', `本地 spool 积压 ${(b / 1048576).toFixed(0)}MB（${spool.count()} 条）——Mongo 或隧道可能长期不可用`)
    }
  } catch { /* ignore */ }

  return out
}

/** agent 心跳缺失（hub 每轮传进来），隧道断 = 该 agent 连续拿不到状态 */
function checkAgents(agentHealth, out) {
  for (const [serverId, h] of Object.entries(agentHealth || {})) {
    if (!h?.lastOkTs) continue
    const age = Date.now() - h.lastOkTs
    if (age > THRESH.heartbeatMs) {
      out.push({ key: `agent.stale:${serverId}`, text: `${serverId} 已 ${Math.round(age / 1000)}s 没有心跳（隧道断？agent 挂了？）` })
    }
  }
}

/**
 * 主机负载（hub 每轮把各 agent 上报的 os.loadavg() 挂进 agentHealth 一并传进来）。
 * 判据 = **5 分钟均值**（load[1]）> threshold：持续过载才告警，瞬时尖峰进不了 5 分钟均值。
 * 只对**数据新鲜**的 agent 判断——心跳过期的机器 load 是旧值，交给 agent.stale，别拿陈旧负载误报。
 * 纯函数（可离线单测，见 alerts.test.mjs）：不做 I/O，只把 firing 项塞进 out。
 */
export function checkLoad(agentHealth, out, { threshold = LOAD_THRESHOLD, now = Date.now() } = {}) {
  for (const [serverId, h] of Object.entries(agentHealth || {})) {
    if (!h?.lastOkTs) continue                       // 从未成功探测 → 没有可信 load
    if (now - h.lastOkTs > THRESH.heartbeatMs) continue // 数据陈旧 → 交给 agent.stale，不发陈旧负载告警
    const load = Array.isArray(h.load) ? h.load : null
    if (!load) continue                              // 缺 load / 非数组 → 该机 agent 还没上报（优雅部分覆盖）
    const five = Number(load[1])
    if (!(five > threshold)) continue                // 5 分钟均值。NaN 时 `NaN > x` 为 false，天然跳过
    const cores = Number(h.cores)
    const per = Number.isFinite(cores) && cores > 0
      ? `${cores} 核 ≈${(five / cores).toFixed(1)}/核`
      : five.toFixed(2)
    out.push({
      key: `host.load:${serverId}`,
      text: `${serverId} 主机负载过高：5 分钟均值 ${five.toFixed(2)}（${per}）持续过载——可能有会话打满 CPU 或任务堆积`,
    })
  }
}

/**
 * 下行线协议退化看门狗（openspec reduce-state-poll-payload）。
 *
 * 防的是**可静默退化的收益**：有人把 /api/state 的增量改回每次全量下发，功能全对、
 * 只是又慢回去了，等价性测试全绿、一条错都不报，用户重新开始看「与服务器失联」。
 * 与 jsonl-ingest 的 read_amplification 完全同族——正确性测试永远抓不到，只有量化指标会红。
 *
 * ★ 判据用**窗口**比率不用累计比率（见 state-delta.js#createFrameWindow 的注释）。
 * ★ ratio 为 null（样本不足）时**不报警也不判健康**——直接跳过。空闲期没人轮询是常态，
 *   那时既不该说"坏了"，也不该拿它当"好了"的证据。
 *
 * 纯函数（可离线单测）：只读 metrics 快照，把 firing 项塞进 out。
 */
export function checkStateWire(metrics, out, { threshold = STATE_FULL_RATIO_THRESHOLD } = {}) {
  const m = metrics || {}
  if (!m.state_delta_enabled) return          // 开关被显式关掉是**人为决定**，不是故障，别刷屏
  const r = m.state_full_ratio_recent
  if (r === null || r === undefined) return   // 样本不足 = "还不知道"
  if (!(r > threshold)) return                // NaN 时 `NaN > x` 为 false，天然跳过
  const pct = (r * 100).toFixed(0)
  out.push({
    key: 'state.full_ratio',
    text: `/api/state 最近 ${m.state_recent_frames} 帧里 ${pct}% 是整份快照（阈值 ${(threshold * 100).toFixed(0)}%）——增量下发可能已退化，前端会重新开始跨境重传 50KB/3s`,
  })
}

/** 备份新鲜度：dump 停摆是典型的"静默失败"——文件还在，只是不再更新 */
function checkBackup(out) {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('webagents_v2-') && f.endsWith('.gz'))
    if (!files.length) return out.push({ key: 'backup.missing', text: `本地没有任何 Mongo 备份（${BACKUP_DIR}）` })
    const newest = Math.max(...files.map((f) => {
      try { return fs.statSync(`${BACKUP_DIR}/${f}`).mtimeMs } catch { return 0 }
    }))
    const h = (Date.now() - newest) / 3600_000
    if (h > THRESH.backupStaleH) out.push({ key: 'backup.stale', text: `Mongo 备份已 ${Math.round(h)}h 未更新（每日 03:30 应自动跑）` })
  } catch { /* 目录不存在等 → 交给 backup.missing 之外的运维流程，不刷屏 */ }
}

/**
 * 推送一条并把结果记进日志（Fix 3）。broadcast() 现在返回真正送达的订阅者数——
 * 过去调用处一律 `void push.broadcast(...).catch(() => {})`，连这个数字都没看过，
 * 于是"到底发出去没有"永远是黑箱（成功 / 静默 404-410 退订 / 从未调用三种情况日志上
 * 长得一模一样，全是零输出）。这里 await + 打一行日志，push 失败也不能反过来搞挂告警状态机。
 */
async function pushAndLog(payload, label) {
  try {
    const sent = await push.broadcast(payload)
    console.warn(`[alert] push ${label}: sent=${sent}`)
  } catch (e) {
    console.warn(`[alert] push 失败 ${label}:`, e?.message ?? e)
  }
}

/**
 * 跑一轮。由 hub 定时调用。
 * @param agentHealth { [serverId]: { lastOkTs } }
 */
/**
 * hub 注入的下行线协议指标读取器。alerts.js **不 import hub.js**（会成环），
 * 由 hub 启动时调用 setStateWireSource() 把 stateWireSnapshot 传进来。
 * 没注入时 checkStateWire 拿到 undefined → 直接跳过，不误报。
 */
let stateWireMetrics = null
export function setStateWireSource(fn) { stateWireMetrics = typeof fn === 'function' ? fn : null }

export async function tick(agentHealth) {
  const firing = []
  // ⚠️ 逐项独立兜底，**绝不能用一个大 try + `catch { return }`**（2026-08-02 线上）：
  // 那样任何一个子检查抛错，都会把 collect() **已经收集到的告警一起丢弃**并静默返回
  // ⇒ 看门狗永不发声。实测：mongo.disk 明明 81%≥80、collect() 也确实产出了它，
  // 却因另一个子检查抛错被整批扔掉，界面上一条告警都没有。
  // 「不会响」和「坏了」外观完全一样——所以失败必须留下日志，不能一声不吭。
  const guard = (label, fn) => {
    try { fn() } catch (e) { console.warn(`[alert] 子检查 ${label} 失败（其余检查继续）：${e?.message || e}`) }
  }
  try { firing.push(...(await collect())) } catch (e) { console.warn(`[alert] collect 失败：${e?.message || e}`) }
  guard('agents', () => checkAgents(agentHealth, firing))
  guard('load', () => checkLoad(agentHealth, firing)) // 主机负载（agentHealth 带 load/cores）
  guard('backup', () => checkBackup(firing))
  guard('state-wire', () => checkStateWire(stateWireMetrics?.(), firing))

  const now = Date.now()
  const { toFire, toRecover } = advance(firing, state, { now })

  // ① 新进入告警 → 推一次
  for (const f of toFire) {
    console.warn(`[alert] ${f.key}: ${f.text}`)
    await pushAndLog({ title: '⚠️ 数据层告警', body: f.text, tag: `alert:${f.key}` }, `fire ${f.key}`)
  }
  // ② 连续 RECOVER_STREAK 拍都不再 firing → 才真正判定恢复，推一次「已恢复」（滞回，见 RECOVER_STREAK 注释）
  for (const r of toRecover) {
    const mins = Math.round(r.sinceMs / 60000)
    console.warn(`[alert] 恢复 ${r.key}（持续 ${mins}m）`)
    await pushAndLog({ title: '✅ 告警恢复', body: `${r.key} 已恢复（持续 ${mins} 分钟）`, tag: `alert:${r.key}` }, `recover ${r.key}`)
  }
}

/** 供 /api/v2/health 展示：当前正在告警的项 */
export function active() {
  return [...state.entries()].filter(([, s]) => s.firing).map(([key, s]) => ({ key, since: s.since, text: s.text }))
}

/**
 * 告警**送不送得出去**（2026-08-01 事故）。
 *
 * 一次 Mongo 隧道中断持续了 10 天没人发现。复盘时发现看门狗全程正确：每 60s 一次
 * `mongo.health()` 真发 ping、判定 down、写日志——生产 hub 日志里躺着 3658 条
 * `[alert] push fire mongo.down: sent=0`。**探测没问题，出口是断的**：告警的唯一通道是
 * Web Push，而 push-subs.json 里是 0 个订阅者，`broadcast()` 直接 skip。这期间 spool
 * 涨破 100MB 上限、按策略丢弃了最旧一半历史数据。
 *
 * 所以：**看门狗必须能说出自己送不送得出去**，并且这个结论要送到一个不依赖「有没有人记得
 * 订阅」的地方——控制台界面本身（用户每天都开）。`sent=0` 只写 console.warn 等于没写。
 *
 * 纯函数，可离线单测（见 alerts.test.mjs）。
 */
export function channelStatus({ subscribers = 0, firingCount = 0 } = {}) {
  if (subscribers > 0) return { deliverable: true, subscribers, dropping: false, hint: '' }
  return {
    deliverable: false,
    subscribers: 0,
    dropping: firingCount > 0,   // 有告警在发作却没出口 = 此刻正在丢告警
    hint: firingCount > 0
      ? `${firingCount} 条告警无处可送（0 个推送订阅者）——去设置页开启通知，否则故障只会躺在日志里`
      : '未开启推送通知：真出故障时不会有人告诉你',
  }
}

/** 一次性快照：当前告警 + 通道健康。挂在 /api/state 上，让界面兜底显示。 */
export function snapshot() {
  const firing = active()
  return { firing, channel: channelStatus({ subscribers: push.subscriberCount(), firingCount: firing.length }) }
}
