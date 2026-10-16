// server/event-projector.js — 执行事件 → Mongo 历史投影（db-redis-mongo-phase1 / P2）
//
// 一期**不上 Redis Stream**：Hub 轮询增量后 normalize → redact → **直写 Mongo**（幂等 upsert）。
// 见 openspec design D1：本系统事件由 5s 轮询驱动、非高频，Stream 的价值是多消费者扇出而非低延迟，
// 一期只需"历史可查"，少一层活动部件更简单。
//
// 增量策略（关键——不能每轮把 69 个会话的事件全拉一遍）：
//   · 只处理 **lastActiveAt 前进了** 的会话（绝大多数会话是 idle，直接跳过）；
//   · 用 agent 的 `?since=<seq>` 游标只取**新增**事件（复用现有 SSE 断线续传协议）；
//   · 限并发，避免一轮打爆 agent。
//
// 失败一律不抛：写不进 Mongo 就落 spool，下轮重放（幂等，不产生重复）。

import { normalizeEvent } from './event-envelope.js'
import { redactEvent } from './event-redaction.js'
import * as eventRepo from './repositories/event-repository.js'
import * as spool from './spool.js'
import { flags } from './flags.js'
import { shouldAttempt, nextDelayMs } from './replay-backoff.js'

const projectedSeq = new Map()   // sessionId -> 最后投影到的 seq（增量游标）
const lastSeen = new Map()       // sessionId -> 上次看到的 lastActiveAt（判断有没有新活动）
const CONCURRENCY = 5

// spool 重放的退避状态（见下方 replaySpool 调用处的注释）
let replayFailures = 0
let lastReplayAt = 0

let stats = { written: 0, skipped: 0, spooled: 0, sessions: 0, lastRun: 0, lastError: null }
export function getStats() { return { ...stats, spoolCount: spool.count(), spoolBytes: spool.sizeBytes() } }

const on = () => flags.mongoEnabled() && flags.eventShadowWrite()

/** 简单并发闸：一次最多 n 个 */
async function pool(items, n, fn) {
  const out = []
  for (let i = 0; i < items.length; i += n) {
    out.push(...await Promise.all(items.slice(i, i + n).map((x) => fn(x).catch(() => null))))
  }
  return out
}

/**
 * 由 hub 每轮 buildState 之后调用。
 * @param sessions  本轮 /api/state 汇总的会话（含 serverId/project/engine/realSessionId/lastActiveAt）
 * @param fetchEvents async (sessionId, sinceSeq) => { kind, events } | null   （由 hub 注入，走 agent 路由）
 */
export async function projectTick(sessions, fetchEvents) {
  if (!on()) return
  const t0 = Date.now()

  // 1) 挑出「有新活动」的会话：lastActiveAt 前进了才拉事件（idle 会话直接跳过）
  const changed = []
  for (const s of sessions || []) {
    if (!s?.id || !s.realSessionId) continue
    const la = Number(s.lastActiveAt) || 0
    if (lastSeen.get(s.id) === la) continue      // 没动过 → 跳过（绝大多数）
    lastSeen.set(s.id, la)
    changed.push(s)
  }

  let written = 0, skipped = 0, spooled = 0
  if (changed.length) {
    await pool(changed, CONCURRENCY, async (s) => {
      const since = projectedSeq.get(s.id) || null
      const payload = await fetchEvents(s.id, since)
      const evs = payload?.events
      if (!Array.isArray(evs) || !evs.length) return

      const envelopes = evs.map((raw) => redactEvent(normalizeEvent(raw, {
        serverId: s.serverId,
        project: s.project,
        engine: s.engine,
        sessionId: s.id,
        realSessionId: s.realSessionId,
        ingestedAt: new Date().toISOString(),
      }))).filter((e) => e.eventKey)

      if (!envelopes.length) return
      const r = await eventRepo.upsertMany(envelopes)
      written += r.written; skipped += r.skipped; spooled += r.spooled
      // 游标推进到本批最后一条（下轮只取更新的）
      const lastSeq = evs[evs.length - 1]?.seq
      if (lastSeq) projectedSeq.set(s.id, String(lastSeq))
    })
  }

  // 2) 顺手重放 spool（Mongo 恢复后自动补齐；幂等，不会重复）
  //
  // ⚠️ 退避闸门（2026-08-01 拥塞崩溃）：Mongo 走跨境公网隧道（~3Mbps），一直失败还每轮硬砸的话，
  // 重试流量本身就把 cwnd 打崩到 1（实测重传 10.3%、188Kbps），往返涨到 2~5s 又超过 5s 超时 ⇒
  // 判死 ⇒ 更多事件落 spool ⇒ 重试压力更大。**不退避就永远出不来。**
  // 成功一次立刻清零，链路一好就全速排干，不留惯性。
  let replay = null
  if (shouldAttempt({ failures: replayFailures, lastAttemptAt: lastReplayAt })) {
    lastReplayAt = Date.now()
    replay = await eventRepo.replaySpool()
    if (replay === null) {
      replayFailures += 1
      console.warn(`[projector] spool 重放失败 ${replayFailures} 次，下次至少等 ${Math.round(nextDelayMs(replayFailures) / 1000)}s（积压 ${spool.count()} 条）`)
    } else {
      if (replayFailures) console.warn(`[projector] spool 重放恢复，本批 ${replay.replayed} 条，剩余 ${replay.remaining ?? spool.count()} 条`)
      replayFailures = 0
    }
  }

  stats = {
    written, skipped, spooled,
    sessions: changed.length,
    replayed: replay?.replayed ?? 0,
    lastRun: Date.now(),
    tookMs: Date.now() - t0,
    lastError: null,
  }
}
