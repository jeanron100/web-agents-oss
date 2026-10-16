// server/state-delta.js — /api/state 增量下发的纯函数核心。零依赖、可单测。
//
// 为什么存在（2026-08-20 实测）：前端每 3 秒全量拉一次 /api/state（53.5KB 原始 / 17KB gzip），
// 而**连续两拍之间几乎什么都没变**——20 拍同频采样里 18/19 拍变化会话数为 0，
// 中位 delta 占比 0.00%，最大 1.22%。每次轮询有 98.8%~100% 是重复传输。
// 跨境链路上这份 17KB 要 p50 4.43s / p90 10.57s / max 16.02s（hub 自身 65ms），
// 尾部越过前端 20s 超时被 abort ⇒ nginx 499 ⇒ 连续 4 次 ⇒ 「与服务器失联 100 秒」。
//
// ★ 便宜的招都用完了才做这个：轮询背压（08-12，堆叠 25.7%→3.3%）、
//   stateToWire 裁掉无人读字段（08-12，−30.8%）、去掉隧道内冗余 TLS（08-14，504 0.26%→0.11%）、
//   BBR（08-20，同时刻交替 A/B **证伪**并回退）。唯一没动过的变量就是「重传不变的数据」。
//
// ★ 三条与既有实现的接缝，改这里前先读：
//   ① 指纹必须对 **stateToWire() 之后**的对象算——顺序反了会产生「变了但客户端看不见」的假变更。
//   ② 删除必须显式下发，客户端不得靠「本次没出现」推断（增量协议最经典的塌陷点）。
//   ③ 客户端合并结果要交回既有 applyState，别新开旁路——墓碑（resolvedTombstones）与
//      乐观气泡（OPTIMISTIC_KEEP_MS）都挂在那条路上。

import crypto from 'node:crypto'

// ───────────────────────── 游标 ─────────────────────────

/**
 * 游标 = `<bootId>:<version>`。
 *
 * ★ 为什么不用时间戳：hub 聚合 5 台 agent，各机时钟不保证同步，`lastActiveAt` 由 agent 上报
 *   ⇒ 拿它当游标会漏掉时钟回拨期间的变更，且失败是静默的（本仓库在时区上栽过）。
 * ★ 为什么带 bootId：hub 重启后 version 从 0 重来，纯数字游标会"看起来还有效"。
 *   与 resume-guard.js#canResume 用 inode 判文件世代同理——别让重置后的计数器骗过比较逻辑。
 */
export function makeCursor(bootId, version) {
  return `${bootId}:${version}`
}

export function parseCursor(s) {
  if (typeof s !== 'string') return null
  const i = s.lastIndexOf(':')
  if (i <= 0 || i === s.length - 1) return null
  const bootId = s.slice(0, i)
  const raw = s.slice(i + 1)
  if (bootId.includes(':')) return null          // 多段 ⇒ 非本协议
  if (!/^\d+$/.test(raw)) return null
  const version = Number(raw)
  if (!Number.isSafeInteger(version)) return null
  return { bootId, version }
}

/**
 * 游标能不能用来算差异。任何一条不成立都必须回落 snapshot——
 * **宁可多发一份全量，也不能漏掉变更**（漏变更的表现是界面与后端不一致，最难查）。
 */
export function cursorComparable(cursor, { bootId, minVersion, curVersion } = {}) {
  const c = parseCursor(cursor)
  if (!c) return false
  if (c.bootId !== bootId) return false          // hub 重启 / 换实例
  if (!Number.isFinite(minVersion) || !Number.isFinite(curVersion)) return false
  if (c.version < minVersion) return false       // 指纹快照已被淘汰，算不出差异
  if (c.version > curVersion) return false       // 客户端拿着"未来"的游标 ⇒ 状态错乱
  return true
}

// ───────────────────────── 指纹 ─────────────────────────

/** 稳定序列化：键排序，保证字段顺序不影响指纹。 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
}

/**
 * 会话指纹。**调用方必须传入 stateToWire() 之后的对象**（见文件头 ①）。
 * 用内容哈希而非逐字段比较：后者每加一个字段就要同步改，迟早漏。
 */
export function sessionFingerprint(wireSession) {
  return crypto.createHash('sha1').update(stable(wireSession)).digest('base64').slice(0, 16)
}

// ───────────────────────── 差异 ─────────────────────────

/**
 * @param {Map<string,object>} prev 上一版本的会话（值可以是完整对象或指纹字符串）
 * @param {Map<string,object>} next 本次的会话（值必须是完整的线协议对象）
 * @returns {{changed: object[], removed: string[]}}
 */
export function diffSessions(prev, next) {
  const fp = (v) => (typeof v === 'string' ? v : sessionFingerprint(v))
  const changed = []
  for (const [id, s] of next) {
    const before = prev.get(id)
    if (before === undefined || fp(before) !== fp(s)) changed.push(s)
  }
  const removed = []
  for (const id of prev.keys()) if (!next.has(id)) removed.push(id)
  return { changed, removed }
}

// ───────────────────────── 合并 ─────────────────────────

/**
 * 把一帧合并进本地状态，返回**完整** state。
 *
 * ★ 返回完整 state 而不是就地改：调用方要把结果交给既有的 applyState，
 *   那条路上挂着 resolvedTombstones（20s 墓碑，防审批卡「消失→又冒出来」）与
 *   乐观气泡保留。走旁路等于**只在增量路径上**让这些防线失效——最难复现的那种回归。
 * ★ 未知帧类型按 snapshot 兜底：宁可整份替换，也不要静默丢数据。
 */
export function mergeDelta(local, frame) {
  if (!frame || typeof frame !== 'object') return local
  const rest = { ...frame }
  delete rest.frame; delete rest.changed; delete rest.removed; delete rest.cursor

  if (frame.frame !== 'delta') {
    // snapshot / reset / 未知 ⇒ 整份替换（sessions 以帧内为准）
    return { ...local, ...rest, sessions: Array.isArray(frame.sessions) ? frame.sessions : [] }
  }

  const map = new Map((local?.sessions ?? []).map((s) => [s.id, s]))
  for (const id of frame.removed ?? []) map.delete(id)
  for (const s of frame.changed ?? []) map.set(s.id, s)
  return { ...local, ...rest, sessions: [...map.values()] }
}

// ───────────────────────── 去重 ─────────────────────────

/**
 * 按 id 去重会话，保留**最近活跃**的那条。
 *
 * ★ 为什么需要（2026-08-20，被本 change 的影子对照挖出来的**先前就存在**的缺陷）：
 *   实测 /api/state 返回 72 条会话但只有 **71 个唯一 id**——一对 Codex 会话共用同一个 id，
 *   而且**内容完全不同**（summary 各说各的、token 5528 万 vs 1221 万、startedAt 差 3 小时）。
 *   不是 CLAUDE.md 里记的「接管后平台记录 + 影子记录同 id」那种孪生，是两个真实会话撞了 id。
 *
 *   今天的后果：前端 `store.ts sessionsOfProject` 已经按 id 去重，所以用户**本来就只看得到一条**，
 *   而且是哪条取决于数组顺序 ⇒ **不确定**。把去重下沉到 hub，界面才有确定性。
 *
 *   对增量的后果更硬：delta 协议按 id 索引，重复 id 会让「合并结果」比「全量」少一条 ——
 *   这正是影子对照报出的 `kind:"length" a:31 b:32 且 onlyIn* 均为空`（id 集合相同、条数不同）。
 *
 * ★ 判据用 lastActiveAt 而非数组顺序：顺序由 agent 上报与 sort 决定，会飘；
 *   「最近活跃」是内容自带的、可复现的。并列时比 activeMs，再并列按 id 稳定兜底——
 *   **绝不能留下一个会随轮询结果变化的选择**，否则界面会自己闪。
 */
export function dedupeSessionsById(sessions) {
  const best = new Map()
  for (const s of sessions ?? []) {
    const cur = best.get(s.id)
    if (!cur) { best.set(s.id, s); continue }
    const la = (x) => (Number.isFinite(x?.lastActiveAt) ? x.lastActiveAt : -Infinity)
    const am = (x) => (Number.isFinite(x?.activeMs) ? x.activeMs : -Infinity)
    if (la(s) > la(cur) || (la(s) === la(cur) && am(s) > am(cur))) best.set(s.id, s)
  }
  return [...best.values()]
}

/** 有多少条被去掉了——用于观测这个先前存在的缺陷有多普遍。 */
export function countDuplicateSessions(sessions) {
  return (sessions?.length ?? 0) - new Set((sessions ?? []).map((s) => s.id)).size
}

// ───────────────────────── 版本环 ─────────────────────────

/**
 * 维护「版本 → 会话指纹表」的环形缓冲，供 diff 用。
 *
 * ★ 版本**只在内容真的变化时**自增。若每个请求都推进版本，客户端的游标就永远落后一拍，
 *   delta 会退化成「每拍都有变化」——功能全对、字节没省，而且**正确性测试完全测不出来**。
 *   实测语料里 18/19 拍零变化，这条语义直接决定了收益是 0% 还是 98%。
 * @param {number} keep 保留多少个版本。版本只在变化时前进，64 个已覆盖很长的真实时间。
 */
export function createVersionRing(keep = 64) {
  let seq = 0
  const ring = []
  return {
    /** @returns {{version:number, fps:Map<string,string>, advanced:boolean}} */
    resolve(sessions) {
      const fps = new Map(sessions.map((s) => [s.id, sessionFingerprint(s)]))
      const last = ring[ring.length - 1]
      if (last && last.fps.size === fps.size) {
        let same = true
        for (const [id, f] of fps) if (last.fps.get(id) !== f) { same = false; break }
        if (same) return { version: last.version, fps: last.fps, advanced: false }
      }
      seq += 1
      ring.push({ version: seq, fps })
      while (ring.length > keep) ring.shift()
      return { version: seq, fps, advanced: true }
    },
    fpsAt(version) { return ring.find((e) => e.version === version)?.fps ?? null },
    minVersion() { return ring[0]?.version ?? 0 },
    size() { return ring.length },
  }
}

// ───────────────────────── 指标 ─────────────────────────

/**
 * 下行线协议指标。与 ingest-metrics 的 read_amplification 同族——
 * 一个盯「还在全量重读磁盘吗」，一个盯「还在全量重传给前端吗」，
 * **失败模式完全相同：功能全对、只是慢、一条错不报**。
 *
 * ★ 分母为 0 时返回 0 而非 Infinity/NaN：空闲期没有请求是常态，
 *   若此时返回 Infinity，任何 `> 阈值` 的告警都会长鸣，三天后就没人看了——
 *   这跟没有告警是一回事（ingest-metrics 那条测试的原话）。
 */
export function wireMetrics({ snapshots = 0, deltas = 0, fullBytes = 0, sentBytes = 0 } = {}) {
  const total = snapshots + deltas
  return {
    state_frames_total: total,
    state_snapshots_total: snapshots,
    state_deltas_total: deltas,
    state_full_ratio: total ? Number((snapshots / total).toFixed(4)) : 0,
    state_bytes_saved: Math.max(0, fullBytes - sentBytes),
  }
}

// ───────────────────────── 退化看门狗 ─────────────────────────

/**
 * 最近 N 帧的滑动窗口。**告警必须看窗口，不能看累计比率。**
 *
 * 为什么（本仓库反复栽的那类坑）：累计比率会被历史稀释——跑了一周好数据之后，
 * 有人把 delta 改回每次全量，累计比率要几万帧才爬得过阈值，而看门狗在此期间
 * 一声不吭。「从不触发的看门狗与坏掉的看门狗外观完全相同」，那就等于没装。
 * 窗口比率则在 N 帧内就见分晓。
 *
 * `ratio()` 在样本不足时返回 **null 而不是 0**：0 会被 `< 阈值` 判成健康，
 * 等于空闲期把看门狗焊死在"绿"上；null 让调用方必须显式处理"还不知道"。
 */
export function createFrameWindow(size = 200, minSamples = 100) {
  const buf = []
  return {
    record(kind) {
      buf.push(kind === 'snapshot' ? 1 : 0)
      while (buf.length > size) buf.shift()
      return buf.length
    },
    samples() { return buf.length },
    /** @returns {number|null} 窗口内 snapshot 占比；样本不足返回 null */
    ratio() {
      if (buf.length < minSamples) return null
      return Number((buf.reduce((a, b) => a + b, 0) / buf.length).toFixed(4))
    },
  }
}

/**
 * 阈值解析：与 alerts.js#parseLoadThreshold / parseRecoverStreak 同一防线。
 * 裸 `Number(env)` 遇非法值得 NaN，而 `ratio > NaN` 恒 false ⇒ **把告警悄悄焊死**，
 * 比用默认值更危险。非法一律退回默认档。
 */
export function parseFullRatioThreshold(raw, fallback = 0.5) {
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback
}

// ───────────────────────── 开关 ─────────────────────────

/**
 * 只有显式 `"0"` 关闭。拼错成 `flase` 保持启用——**静默降级比不工作更糟**：
 * 功能全对、只是慢，一条错都不报。与 resume-guard.js#incrementalEnabled 同口径。
 */
export function deltaEnabled(env = process.env) {
  return env.WA_STATE_DELTA !== '0'
}
