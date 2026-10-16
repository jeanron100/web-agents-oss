// server/repositories/event-repository.js — 执行事件的幂等投影（db-redis-mongo-phase1 / P2）
//
// 幂等的全部秘密就两件事：
//   ① Mongo 上 `{eventKey:1} unique` 唯一索引；
//   ② 写入用 **`$setOnInsert` upsert**（不是 `$set`）——已存在的文档保持原样，重放是 no-op。
// 二者配合：同一事件被投递/回放/回填多少次，Mongo 里都**只有一条**。并发下另一个 upsert 撞唯一键
// 也安全（被当作已存在）。
//
// 写失败**绝不抛**：落 spool，等 Mongo 恢复后重放（重放同样幂等，不会产生重复）。

import * as mongo from '../mongo.js'
import * as spool from '../spool.js'
import { cursorFilter, decodeCursor, encodeCursor } from '../timeline-cursor.js'

const COLL = 'execution_events'

/**
 * 幂等写入一批事件信封（应已 normalize + redact）。
 * 返回 { written, skipped, spooled }。绝不抛。
 */
/**
 * @param opts.spoolOnFailure 失败时是否落 spool。**重放路径必须传 false**——那批本来就在
 *   spool 里躺着，再 append 一次就是把积压翻倍（2026-08-01 事故的放大器，见 replaySpool）。
 */
export async function upsertMany(envelopes, { spoolOnFailure = true, getColl = () => mongo.coll(COLL) } = {}) {
  const out = { written: 0, skipped: 0, spooled: 0 }
  if (!envelopes?.length) return out

  const c = await getColl()
  if (!c) {                            // Mongo 关着或连不上 → 全落 spool
    if (spoolOnFailure && spool.append(envelopes)) out.spooled = envelopes.length
    else if (!spoolOnFailure) out.failed = true
    return out
  }

  try {
    // bulkWrite 比逐条 updateOne 快得多；ordered:false = 一条失败不影响其余
    const ops = envelopes.map((env) => ({
      updateOne: {
        filter: { eventKey: env.eventKey },
        update: { $setOnInsert: env },   // ⚠️ 必须 $setOnInsert：重放不覆盖已有文档
        upsert: true,
      },
    }))
    const r = await c.bulkWrite(ops, { ordered: false })
    out.written = r.upsertedCount ?? 0
    out.skipped = envelopes.length - out.written   // 已存在（重放/重复投递）
    return out
  } catch (e) {
    // 写失败（Mongo 挂/隧道断/超时）→ 落 spool 等重放。绝不阻塞主流程。
    // 重放路径 spoolOnFailure:false：这批已在 spool 里，再落一次就是翻倍。
    if (spoolOnFailure && spool.append(envelopes)) out.spooled = envelopes.length
    else if (!spoolOnFailure) out.failed = true
    return out
  }
}

/** 单次重放的条数上限。见下方注释：整份重放会把跨境隧道压崩。 */
export const REPLAY_BATCH = Number(process.env.WA_REPLAY_BATCH) || 500

/**
 * 把 spool 里积压的事件**小批**重放进 Mongo。只丢弃确认写入的那批。
 * 返回 { replayed, written, skipped, remaining } 或 null（Mongo 仍不可用 / 本批失败）。
 *
 * 2026-08-01 事故修了两个缺陷：
 * ① **失败会把 spool 翻倍**：原来 readAll() 读出全部（不删）交给 upsertMany，后者 catch 里
 *    `spool.append(envelopes)` 把同一批又落一次盘，而失败路径又不清空 ⇒ 每失败一次积压翻倍，
 *    直到撑破 100MB 上限被 trimOldest() 砍掉最旧一半（真的丢数据）。
 *    ⚠️ 注意 mongo.coll() 只取集合句柄、**不发 I/O**，所以「连得上但写超时」是常态路径，
 *    不是边缘情况。现在重放路径显式 spoolOnFailure:false——这批本来就在 spool 里躺着。
 * ② **一次性整份重放**：102MB/151k 条一把砸进 ~3Mbps 的跨境隧道，把 cwnd 打崩到 1
 *    （实测重传 10.3%、188Kbps），往返涨到 2~5s 又触发 5s 超时 ⇒ 判死 ⇒ 更多事件落 spool。
 *    现在每轮最多 REPLAY_BATCH 条，渐进排干。
 *
 * upsert/getColl 可注入（默认走真实实现），以便离线回归验证，见 replay-spool.test.mjs。
 */
export async function replaySpool({ maxBatch = REPLAY_BATCH, upsert = upsertMany, getColl = () => mongo.coll(COLL) } = {}) {
  const batch = spool.readBatch(maxBatch)
  if (!batch.length) return { replayed: 0, written: 0, skipped: 0 }

  const c = await getColl()
  if (!c) return null                  // Mongo 还没恢复，一个字节都别往管子里灌

  let r
  try {
    r = await upsert(batch, { spoolOnFailure: false, getColl })
  } catch { return null }              // 本批失败：原样留在 spool，下轮再来（绝不重复落盘）
  if (!r || r.failed || r.spooled > 0) return null

  spool.dropFirst(batch.length)        // 只丢确认写入的这批；期间新追加的在尾部，不受影响
  return { replayed: batch.length, written: r.written, skipped: r.skipped, remaining: spool.count() }
}

/**
 * 某会话的时间线（只读；走 {sessionId:1, occurredAt:1} 索引）。
 *
 * @param before 游标串（见 timeline-cursor.js）；给了就取**比它更早**的一页，用于「加载更早」。
 * @returns { events, hasMore, oldest } | null（null = Mongo 不可用，调用方回退 JSONL）
 *
 * 取**最近** limit 条再翻回时间正序。曾经是 `sort({occurredAt:1}).limit()` —— 那取的是**最早**的
 * limit 条：会话攒到 5000 条时，你看到的是开头那截、而不是当下在跑的这截，越用越没用。
 *
 * 2026-08-03 补上翻页：只保留"最近 N 条"意味着更早的历史**永远看不到**，而且截断是静默的
 * （实测 ps-ms1k8aom-3092 共 1811 条，前端显示「92 个回合」像是全集）。hasMore 就是为了让
 * 这个截断**说出来**——与 session-allocate.js 的 truncated/hidden* 同一个理由。
 */
export async function timeline(sessionId, limit = 500, before = null) {
  const c = await mongo.coll(COLL)
  if (!c) return null                  // Mongo 不可用 → 调用方回退扫 JSONL
  try {
    const filter = cursorFilter(sessionId, decodeCursor(before))
    // 多取一条判断"上面还有没有"，省掉一次 countDocuments
    const rows = await c.find(filter)
      .sort({ occurredAt: -1, eventKey: -1 })   // eventKey 是同毫秒内的次级序，必须与游标一致
      .limit(limit + 1)
      .toArray()
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return {
      events: page.reverse(),                    // 翻回时间正序供前端渲染
      hasMore,
      oldest: page.length ? encodeCursor(page[0]) : null, // reverse 后 [0] 是本页最老的一条
    }
  } catch { return null }
}

/** 计数（用于验证/健康）。 */
export async function count(filter = {}) {
  const c = await mongo.coll(COLL)
  if (!c) return null
  try { return await c.countDocuments(filter) } catch { return null }
}

/** 最近事件（可按 serverId/project/type/时间窗筛）。走 *_recent 索引；limit 有硬上限防拉爆。 */
export async function recent(filter = {}, limit = 100) {
  const c = await mongo.coll(COLL)
  if (!c) return null                  // Mongo 不可用 → 调用方标 available:false
  try {
    return await c.find(filter).sort({ occurredAt: -1 }).limit(limit).toArray()
  } catch { return null }
}

/** 数据层总览：总事件数 + 按类型分布（给运维页「数据层」面板）。 */
export async function summary() {
  const c = await mongo.coll(COLL)
  if (!c) return null
  try {
    const [events, byType] = await Promise.all([
      c.countDocuments({}),
      c.aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]).toArray(),
    ])
    return { events, byType: byType.map((x) => ({ type: x._id, n: x.n })) }
  } catch { return null }
}
