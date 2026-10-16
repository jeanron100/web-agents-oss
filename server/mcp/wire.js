// server/mcp/wire.js
// 出口投影：内部对象 ≠ 线协议。MCP 的返回体是给 LLM 读的，上下文很贵。
// 依据本仓教训 dont-ship-what-nobody-reads：出口必须是纯函数，且要有硬预算。
// 具体数字来源：232 的 /api/state 实测 49KB，原样吐给 LLM 一次就烧掉几万 token。

/**
 * 从环境变量安全地解析数字，确保结果是有限的正数。
 * 若无效则返回 fallback。防止 NaN 导致预算检查被静默禁用。
 */
export function parseEnvNumber(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const num = Number(raw)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

export const MAX_BYTES = parseEnvNumber('WA_MCP_MAX_BYTES', 8192)
export const MAX_EVENT_CHARS = parseEnvNumber('WA_MCP_MAX_EVENT_CHARS', 2000)
const MAX_PROMPT_CHARS = 80
// project 可能是一条很深的文件系统路径（POSIX PATH_MAX=4096），id/serverId/engine/state
// 理论上都很短，但绝不能假设上游数据干净——reviewer 实测过 20000 字符的 project 字段，
// 单这一个字段就吃掉大半预算。这里给 sessionRow 里除 firstPrompt 外的每个字符串字段都上一道
// 统一的硬上限，防止任何一个字段单独把 base 撑爆（fitResponse 只会砍 items，救不了 base）。
const MAX_FIELD_CHARS = 300

/** 长文本截断，留可见省略号——LLM 需要知道"这里被切了"，否则会把残句当完整事实。 */
export function clip(text, max = MAX_EVENT_CHARS) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/** 会话行：只留 LLM 判断"哪个会话值得关注"所需的字段。 */
export function sessionRow(s, nowMs = Date.now()) {
  const last = s.lastActiveAt || s.startedAt || nowMs
  return {
    id: clip(s.id, MAX_FIELD_CHARS),
    serverId: clip(s.serverId, MAX_FIELD_CHARS),
    project: clip(s.project, MAX_FIELD_CHARS),
    engine: clip(s.engine, MAX_FIELD_CHARS),
    state: clip(s.state, MAX_FIELD_CHARS),
    idleMin: Math.max(0, Math.round((nowMs - last) / 60_000)),
    inflight: !!s.inflight,
    firstPrompt: clip(s.firstPrompt || '', MAX_PROMPT_CHARS),
  }
}

/**
 * 把"数量/偏移量"类参数规范化为有限非负整数——调用方是 LLM，传来的值可能是
 * 字符串/NaN/负数/浮点数。不规范化会连累下游：fitResponse 内部曾直接
 * `Math.max(0, offset)`，但 Math.max(0, NaN) 的结果仍是 NaN 而不是 0，
 * 于是"是否还有更多"的比较 (safeOffset + consumed < all.length) 永远是 false——
 * 数据被悄悄砍掉，却连 hasMore/nextOffset 信号都不给。与 filters.js#normalizeLimit
 * 是同一条纪律：LLM 输入当垃圾看待，服务端兜底规范化。
 */
export function normalizeCount(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/**
 * 硬预算 + 分批。
 *
 * 两条纪律：
 * ① **预算算的是整个返回对象**，不是内层列表——LLM 看到的是整体，把约束只加在
 *    内层等于自欺（外层还有 session/hint/cursor 等固定开销）。
 * ② **超出不静默丢弃**：砍到放得下为止，并给 hasMore + nextOffset，让调用方分批续取。
 *    静默丢数据会让 LLM 把残缺当全集，据此下错误结论。
 */
export function fitResponse(base, listKey, items, { maxBytes = MAX_BYTES, offset = 0 } = {}) {
  const size = (v) => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')
  const all = items ?? []
  // 防止负 offset/NaN/非数字被 slice(-n) 误解为从末尾往前数，或让下面的
  // "是否还有更多" 比较因 NaN 传染而恒为 false（Math.max(0, NaN) 仍是 NaN）
  const safeOffset = normalizeCount(offset, 0)

  // base 本身（不含列表）就已经超预算：items 全砍光也救不回来。这种情况绝不能
  // 悄悄吐出一个超预算对象、让调用方误当作"放得下"的正常结果——必须显式给出信号，
  // 否则 LLM 会把这个畸形响应当全集使用（本仓教训：残缺当全集会据此下错误结论）。
  const bare = { ...base, [listKey]: [] }
  const bareSize = size(bare)
  if (bareSize > maxBytes) {
    return {
      ...bare,
      truncated: true,
      message: `响应基础部分（不含 ${listKey}）已达 ${bareSize} 字节，超出 ${maxBytes} 预算——内容被截断，不可当作完整结果`,
    }
  }

  // 构造包含元数据的返回体（hasMore/nextOffset/hint）
  const buildResponse = (arr) => {
    const res = { ...base, [listKey]: arr }
    const consumed = arr.length
    if (safeOffset + consumed < all.length) {
      res.hasMore = true
      res.nextOffset = safeOffset + consumed
      res.hint = `还有 ${all.length - safeOffset - consumed} 条未返回，用 offset=${res.nextOffset} 续取`
    }
    return res
  }

  let out = all.slice(safeOffset)

  // Keep popping until the full response (including metadata) fits in budget, or we have only 1 item
  while (out.length > 1 && size(buildResponse(out)) > maxBytes) {
    out.pop()
  }

  // 单个元素就超预算：仍返回 1 条并让 nextOffset 前进，否则调用方拿着不动的
  // nextOffset 会无限重试同一批。宁可这一次超一点，也不能造出死循环。
  return buildResponse(out)
}
