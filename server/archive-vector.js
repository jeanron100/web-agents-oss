// server/archive-vector.js — 向量回填的决策核（openspec change: execution-history-archive，P2）
//
// ★★ 这一层最要紧的不是"能不能建索引"，而是**不能把公网入口打挂**。
//   `62.234` 只有 **2 核**，同时承载公网 443 与跨境隧道，BGE 进程已占 62% 内存。
//   2026-08-29 实测：embedding 全速跑时网关 5 分钟 load 冲到 **2.50~2.79**、
//   `/api/state` 由 0.15s 劣化到 **2.28s（15×）** —— 正是「跨境 TLS 握手超时 ⇒ 504 ⇒
//   与服务器失联」的成因条件，也正是这两天连修两轮的那个症状。
//   **所以「破线即停」必须是可测的判据，不是注释里的一句话。**
//
// 依赖（都已就位，维度天然对齐）：
//   embedding：BGE-M3 @ 62.234:8500（经 web-agents-tunnel-bge 隧道），1024 维
//   向量库：  Qdrant 1.16.3 @ .195:6333，既有 collection 同为 1024 维 / Cosine

import crypto from 'node:crypto'

/** 与 .195 上既有 collection 保持一致；不一致的向量写进去就污染整个 collection。 */
export const VECTOR_DIM = 1024
/** 实测最优批大小：单条 1387ms → batch=8 时 551ms（2.5×）。服务端 maxItems=64。 */
export const BATCH = Math.min(Number(process.env.WA_VEC_BATCH) || 8, 64)
/** 默认占空比 0.5 —— 2 核机上让出一个核给 TLS 握手。 */
export const DUTY = 0.5
/** 网关 load 阈值（**按核数归一**后的每核值）。 */
export const LOAD_THRESHOLD = 0.5

/** 分批。 */
export function planBatches(items, size = BATCH) {
  const n = Math.max(1, Math.min(Number(size) || BATCH, 64))
  const out = []
  for (let i = 0; i < (items?.length ?? 0); i += n) out.push(items.slice(i, i + n))
  return out
}

/**
 * 要不要暂停回填。
 *
 * ⚠️ 三条 fail-safe 方向，全都朝「少做事」：
 *  ① **读不到 load ⇒ 暂停**，不是当作健康继续跑。探测失效时闸门必须自动收紧，
 *    否则就是「fail-safe 的跳过永远成立」那个老坑（本仓库前科：永不重启的免死金牌）。
 *  ② **阈值非法 ⇒ 退回默认**。`load > NaN` 恒为 false = 永不暂停，比用默认值更危险且悄无声息。
 *  ③ **按核数归一**：2 核机的 1.0 和 8 核机的 1.0 不是一回事；不归一的话同一份配置
 *    换台机器要么形同虚设、要么永远暂停。
 */
export function shouldPause({ load5, cores = 2, threshold = LOAD_THRESHOLD } = {}) {
  const th = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : LOAD_THRESHOLD
  const c = Number.isFinite(Number(cores)) && Number(cores) > 0 ? Number(cores) : 2
  // ⚠️ `Number(null) === 0`、`Number('') === 0` —— 不显式挡掉，读不到就会被当成
  //    "负载 0，非常健康"，闸门在探测失效时**自动失效**。这正是 fail-safe 方向搞反的典型。
  const l = (load5 === null || load5 === undefined || load5 === '') ? NaN : Number(load5)
  if (!Number.isFinite(l)) {
    return { pause: true, threshold: th, reason: '读不到网关 load（未知即暂停，不赌）' }
  }
  const perCore = l / c
  if (perCore > th) {
    return { pause: true, threshold: th, perCore, reason: `网关 load ${l.toFixed(2)}/${c} 核 = ${perCore.toFixed(2)}/核，超阈值 ${th}` }
  }
  return { pause: false, threshold: th, perCore }
}

/**
 * 用**批次耗时**当拥塞信号（比读 load 更直接，也不需要改别人的服务）。
 *
 * 为什么不读 `/health` 的 load：实测它只回 `{status,model,device,modes}`，**没有负载字段**。
 * 而「读不到就暂停」的 fail-safe 方向是对的 ⇒ 结果会是**回填永远不跑**。
 * 与其去改另一个项目的服务，不如换一个自带的信号：**batch 耗时本身**。
 * 它测的正是我们关心的那件事——这台 2 核机现在忙不忙；而且自校准，换机器不用重配。
 *
 * 基线取首批实测（batch=8 约 4.4s）。超过 `factor` 倍即认为网关吃紧，暂停本轮。
 * ⚠️ 没有基线时**不暂停**（首批必须放行，否则永远建立不了基线，闸门自锁）。
 *   这与「读不到 load 就暂停」不冲突：那里的未知是"探测坏了"，这里的未知是"还没开始"。
 */
export function shouldPauseByLatency({ lastMs, baselineMs, factor = 2.5 } = {}) {
  const f = Number.isFinite(Number(factor)) && Number(factor) > 1 ? Number(factor) : 2.5
  const b = Number(baselineMs)
  const l = Number(lastMs)
  if (!Number.isFinite(b) || b <= 0) return { pause: false, reason: '尚无基线，首批放行' }
  if (!Number.isFinite(l) || l <= 0) return { pause: false, reason: '本批无耗时读数' }
  if (l > b * f) {
    return { pause: true, factor: f, reason: `批次耗时 ${Math.round(l)}ms 超基线 ${Math.round(b)}ms 的 ${f}× —— 网关吃紧，暂停` }
  }
  return { pause: false, factor: f }
}

/** 批间休眠：占空比 0.5 ⇒ 休眠 ≈ 上一批耗时，等于只占一个核。 */
export function sleepFor(lastMs, duty = DUTY) {
  const d = Number(duty)
  const safe = Number.isFinite(d) && d > 0 && d <= 1 ? d : DUTY
  const ms = Math.round(Number(lastMs) * (1 - safe) / safe)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/**
 * 点 id：**由坐标决定**，所以重跑回填只会覆盖同一个点，不会产生重复。
 * Qdrant 只接受无符号整数或 UUID —— 这里把坐标的 sha1 前 16 字节格式化成 UUID。
 */
export function pointId({ host, project, session }) {
  const h = crypto.createHash('sha1').update(`${host}/${project}/${session}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * 组一个 Qdrant 点。
 *
 * ⚠️ **payload 不夹带原文**：Qdrant 是索引不是仓库。原文在 `.189.4` 的分片文件里，
 *   命中后按坐标去取即可（`/api/archive/session`）。payload 只放能溯源与筛选的字段。
 */
export function toPoint(d, vector) {
  if (!Array.isArray(vector) || vector.length !== VECTOR_DIM) {
    throw new Error(`向量维度必须是 ${VECTOR_DIM}，实际 ${Array.isArray(vector) ? vector.length : typeof vector}`)
  }
  return {
    id: pointId(d),
    vector,
    payload: {
      host: d.host, project: d.project, session: d.session, engine: d.engine,
      startedAt: d.startedAt ?? 0, lastAt: d.lastAt ?? 0,
      model: d.model ?? '',
      firstPrompt: String(d.firstPrompt ?? '').slice(0, 300),
      files: (d.files ?? []).slice(0, 5).map((f) => String(f).split('/').slice(-2).join('/')),
    },
  }
}
