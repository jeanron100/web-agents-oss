// server/event-envelope.js — 统一事件信封 + 全局幂等键（db-redis-mongo-phase1 / P0）
//
// 作用：把 Claude/Codex 的原生事件归一化成同一结构，并算出一个「全局唯一、可重算」的 eventKey，
// 供 Mongo 以 {eventKey:1} unique + $setOnInsert upsert 去重（重复投递/回填不产生重复记录）。
// 纯函数、零依赖、可单测。脱敏交给 event-redaction.js（写库前一次做）；这里只搭骨架、不碰敏感明文。
//
// ⚠️ eventKey 的稳定性依赖 native seq 稳定（Claude 的 seq 含 byteOffset）。若 CLI 会重写/压缩 JSONL
//    致偏移变化，需改键算法——见 docs/database_ops.md §4.3 (R1)，这是 P2 的首验项。

export const SCHEMA_VERSION = 1

// 引擎命名空间前缀保证 Claude 与 Codex 的 eventKey 绝不冲突（即便 seq 字符串偶然相同）。
// seq 是各引擎原生的单调定位串（Claude: `realId:generation:byteOffset:subIndex`；
// Codex: `threadId:monotonicSeq`），本身已含会话身份，故无需再拼 realSessionId。
export function computeEventKey({ serverId, engine, seq }) {
  if (!serverId || !engine || seq == null || seq === '') {
    throw new Error('computeEventKey: serverId/engine/seq 必填')
  }
  return `${serverId}:${engine}:${seq}`
}

// 原生事件类型 → 统一 type 分类（durable、可查询；不承载 prompt/正文）。
const TYPE_MAP = {
  file_op: 'tool.used',
  assistant: 'assistant.message',
  user: 'user.message',
}
function deriveType(raw) {
  if (raw?.kind) return String(raw.kind) // 已是归一 type（如 approval.resolved / system.event_failed）
  return TYPE_MAP[raw?.type] || `raw.${raw?.type || 'unknown'}`
}

// 从原生事件的 payload 里只挑「可留存的结构化字段」，绝不搬 prompt/text/正文/命令全文。
// 真正的敏感明文兜底由 redactEvent 再扫一遍。
//
// ⚠️ 坑（实际踩到）：agent 对「执行命令」类 file_op **把命令行本身塞进了 `path` 字段**
// （agent.js: `path: String(inp.command).slice(0,100)`），于是命令绕过了 redaction 的 `command`
// 字段黑名单、原样进了库——违反 spec「完整 Bash 参数 MUST NOT 进入 Mongo」。
// 故这里对「执行命令」单独处理：只留**极短预览**（首个动词/命令名 + 截断），不留完整参数。
const CMD_PREVIEW_MAX = 48

// 用户提问 / 助手回答的**截断脱敏摘要**。
//
// 为什么要存它：不存任何文本时，历史就退化成「更新文件 console.html +3 −2」重复十几行——
// **没有语义锚点，根本看不出这一串在干什么**（用户实测反馈）。历史投影的价值恰恰依赖一个语义锚。
// 为什么允许存：设计稿的「允许进入 Mongo」清单里明确包含 **「截断后的脱敏摘要」**；红线禁的是
// 「**完整** Prompt 和回答正文」。故这里只留 SUMMARY_MAX 字的摘要，且仍过 redactString 脱敏。
const SUMMARY_MAX = 140

// 摘要要当**一句话**读，不是当 markdown 渲染——所以先把标记压平。
// （首版没压：时间线上满屏 `**这样**` 和反引号，噪到盖过语义本身。）
const plainText = (s) => String(s)
  .replace(/```[\s\S]*?```/g, ' ')      // 代码块整段丢掉：贴进摘要没有任何信息量
  .replace(/`([^`]*)`/g, '$1')          // 行内代码去反引号
  .replace(/\*\*([^*]+)\*\*/g, '$1')    // 加粗
  .replace(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/g, '$1') // 斜体（避开 snake_case 里的下划线）
  .replace(/^#{1,6}\s+/gm, '')          // 标题井号
  .replace(/\s+/g, ' ')
  .trim()

function safePayload(raw) {
  const p = {}
  if (raw?.verb) p.verb = raw.verb                // 工具动作（读取文件/执行命令/更新文件…）
  // 只对「用户提问」「助手回答」取摘要；其余类型一律不碰文本
  if (raw?.text && (raw.type === 'user' || raw.type === 'assistant')) {
    const one = plainText(raw.text)
    if (one) p.summary = one.length > SUMMARY_MAX ? one.slice(0, SUMMARY_MAX) + '…' : one
  }
  if (raw?.path) {
    if (raw.verb === '执行命令') {
      // 只留命令预览（够在时间线上认出"跑了什么"），绝不留完整参数
      const oneLine = String(raw.path).replace(/\s+/g, ' ').trim()
      p.cmdPreview = oneLine.length > CMD_PREVIEW_MAX ? oneLine.slice(0, CMD_PREVIEW_MAX) + '…' : oneLine
    } else {
      p.path = raw.path                           // 项目内相对路径（agent 侧已相对化）
    }
  }
  if (typeof raw?.additions === 'number') p.additions = raw.additions
  if (typeof raw?.deletions === 'number') p.deletions = raw.deletions
  if (raw?.status) p.status = raw.status
  if (typeof raw?.durationMs === 'number') p.durationMs = raw.durationMs
  if (typeof raw?.exitCode === 'number') p.exitCode = raw.exitCode
  return p
}

/**
 * 把一条原生事件 + 会话元数据归一化为统一信封。
 * @param raw  agent 扫描/driver 产出的原生事件 { type, ts, verb, path, seq, ... }
 * @param meta { serverId, project, engine, sessionId, realSessionId, ingestedAt? }
 * 返回信封对象（未脱敏——调用方随后过 redactEvent）。
 */
export function normalizeEvent(raw, meta) {
  const { serverId, project, engine, sessionId, realSessionId } = meta || {}
  const seq = raw?.seq ?? raw?.id
  const eventKey = computeEventKey({ serverId, engine, seq })
  return {
    _id: eventKey,
    eventKey,
    schemaVersion: SCHEMA_VERSION,
    type: deriveType(raw),
    serverId,
    project: project ?? null,
    engine,
    sessionId: sessionId ?? null,
    realSessionId: realSessionId ?? null,
    seq: String(seq),
    occurredAt: raw?.ts ? new Date(raw.ts).toISOString() : null,
    ingestedAt: meta?.ingestedAt ?? null, // 写库时由 repository 用 Date.now() 覆盖
    payload: safePayload(raw),
    privacy: { redacted: false, containsPrompt: false },
  }
}
