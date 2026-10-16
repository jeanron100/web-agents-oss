// event-seq.js — 断线续传帧协议的纯函数：cursor/seq 逻辑
// 零依赖。两套引擎的 seq 方案不同：
//   - Claude：字符串 seq `realId:generation:byteOffset:subIndex`（JSONL 逐行扫描，一行可产多个 UI 事件）
//   - Codex：单调递增数字 seq（driver 内存序号）
// 本模块只提供 Claude seq 的编解码/比较，以及与引擎无关的通用重连帧构建器。

/**
 * 构造 Claude 事件的 seq 字符串。
 * @param {string} realId 原生会话 uuid
 * @param {string} generation 文件世代标识（截断/重写后变化）
 * @param {number} byteOffset 该 JSONL 行的字节偏移
 * @param {number} subIndex 同一行内产出的第几个 UI 事件（从 0 起）
 * @returns {string}
 */
export function claudeSeq(realId, generation, byteOffset, subIndex) {
  return `${realId}:${generation}:${byteOffset}:${subIndex}`
}

/**
 * 解析 Claude seq 字符串。
 * @param {string} s
 * @returns {{realId: string, generation: string, byteOffset: number, subIndex: number} | null}
 */
export function parseSeq(s) {
  if (typeof s !== 'string') return null
  const parts = s.split(':')
  if (parts.length !== 4) return null
  const [realId, generation, byteOffsetStr, subIndexStr] = parts
  const byteOffset = Number(byteOffsetStr)
  const subIndex = Number(subIndexStr)
  if (!Number.isFinite(byteOffset) || !Number.isInteger(byteOffset)) return null
  if (!Number.isFinite(subIndex) || !Number.isInteger(subIndex)) return null
  return { realId, generation, byteOffset, subIndex }
}

/**
 * 比较两个 Claude seq 字符串。
 * 若任一解析失败，或 realId/generation 不一致（文件被截断/重写），返回 NaN——
 * 调用方须将其视为“不可比较”，触发 reset。
 * 否则先比 byteOffset，再比 subIndex。
 * @param {string} aSeq
 * @param {string} bSeq
 * @returns {number}
 */
export function claudeCmp(aSeq, bSeq) {
  const a = parseSeq(aSeq)
  const b = parseSeq(bSeq)
  if (!a || !b) return NaN
  if (a.realId !== b.realId || a.generation !== b.generation) return NaN
  return (a.byteOffset - b.byteOffset) || (a.subIndex - b.subIndex)
}

/**
 * Codex 单调数字 seq 的比较器。
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function numCmp(a, b) {
  return a - b
}

// Unsequenced disk history is not a streaming tail. Until it has a cursor of
// its own, only a full snapshot can preserve its position and replace live IDs.
export function needsHistorySnapshot(events) {
  return events.some(e => e.seq == null && !e.streaming)
}

/** 从事件数组取 seq 边界，忽略无 seq(流式/未定稿)事件。无 seq 承载事件 → { firstSeq:null, lastSeq:null }。 */
export function seqBounds(events) {
  let firstSeq = null, lastSeq = null
  for (const e of events ?? []) {
    if (e?.seq == null) continue
    if (firstSeq == null) firstSeq = e.seq
    lastSeq = e.seq
  }
  return { firstSeq, lastSeq }
}

/**
 * 决定重连时下发给客户端的帧。
 * @param {object} params
 * @param {Array<{seq: any}>} params.events 当前窗口内的事件
 * @param {any} params.since 客户端携带的 cursor（null/undefined 表示首次连接）
 * @param {any} params.firstSeq 窗口起点 seq
 * @param {any} params.lastSeq 窗口终点 seq
 * @param {(a: any, b: any) => number} params.cmp 引擎比较器（claudeCmp 或 numCmp）
 */
export function buildFrame({ events, since, firstSeq, lastSeq, cmp }) {
  if (since == null) {
    return { kind: 'snapshot', events, firstSeq, lastSeq }
  }
  if (firstSeq == null) return { kind: 'reset' } // 窗口无 seq 承载事件(如 Codex 影子扫描)但客户端持游标 → 无法比较 → 重置
  const c = cmp(since, firstSeq)
  if (Number.isNaN(c)) {
    return { kind: 'reset' }
  }
  if (c < 0) {
    return { kind: 'snapshot', events, firstSeq, lastSeq, droppedBefore: firstSeq }
  }
  return {
    kind: 'append',
    events: events.filter((e) => cmp(e.seq, since) > 0),
    fromSeq: since,
    lastSeq,
  }
}
