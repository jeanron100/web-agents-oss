// server/spool.js — 本地 NDJSON 兜底队列（db-redis-mongo-phase1 / P2）
//
// 为什么它是**真正的持久兜底**：一期没有 Redis Stream 缓冲，Hub 是「轮询增量 → 直写 Mongo」。
// Mongo 或跨境 SSH 隧道一断，写就丢了。所以写 Mongo 失败的事件**必须先落本地磁盘**，
// 等 Mongo 恢复后按 eventKey 幂等重放（重放不会产生重复——靠 {eventKey:1} unique + $setOnInsert）。
//
// 约束：文件 0600（可能含脱敏后仍敏感的路径）、总大小上限、超限告警并丢弃最旧（宁可丢历史投影，
// 也绝不让 spool 把 Hub 的磁盘撑爆——Mongo 是投影、非权威源，最坏可从 JSONL 重投影）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DIR = path.join(os.homedir(), '.web-agents')
const FILE = path.join(DIR, 'mongo-spool.ndjson')
const MAX_BYTES = Number(process.env.WA_SPOOL_MAX_BYTES ?? 100 * 1024 * 1024) // 100MB 上限
const WARN_BYTES = MAX_BYTES * 0.8

let warned = false

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }) } catch { /* 忽略 */ }
}

/** 追加一批事件到 spool（每行一个 JSON）。返回是否写成功。 */
export function append(envelopes) {
  if (!envelopes?.length) return true
  try {
    ensureDir()
    const size = sizeBytes()
    if (size > MAX_BYTES) {
      // 超硬上限：丢弃最旧的一半，保证 Hub 磁盘安全（Mongo 非权威源，可从 JSONL 重投影）
      trimOldest()
      console.error(`[spool] ⚠️ 超过上限 ${Math.round(MAX_BYTES / 1048576)}MB，已丢弃最旧一半——Mongo 侧持续不可用，请人工介入`)
    } else if (size > WARN_BYTES && !warned) {
      warned = true
      console.warn(`[spool] ⚠️ 已达 ${Math.round(size / 1048576)}MB（>80% 上限）——Mongo 可能长期不可达`)
    }
    const lines = envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n'
    fs.appendFileSync(FILE, lines, { mode: 0o600 })
    return true
  } catch (e) {
    console.error('[spool] 落盘失败:', e?.message || e)
    return false
  }
}

export function sizeBytes() {
  try { return fs.statSync(FILE).size } catch { return 0 }
}

export function count() {
  // cursor 是**字节**偏移，内容含中文时字节≠字符：必须按 Buffer 切再解码，
  // 用 string.slice(cursor) 会把多字节字符拦腰截断。
  try {
    return fs.readFileSync(FILE).subarray(cursor).toString('utf8').split('\n').filter(Boolean).length
  } catch { return 0 }
}

/** 读出全部待重放事件（不删）。 */
export function readAll() {
  try {
    return fs.readFileSync(FILE).subarray(cursor).toString('utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

/**
 * ⚠️ 游标（已消费字节数）。这是 2026-08-01 第二次翻车的修正：
 * 第一版 readBatch/dropFirst 写成了 **O(整个文件)**——每批都 readFileSync 70MB、dropFirst 还要
 * 再 writeFileSync 70MB 写回去。同步 I/O 每 5 秒跑一次 140MB，直接**饿死 event loop**：
 * hub 轮询停摆、五台 agent 全部 agent.stale、控制台显示冻结快照（用户看到的是几分钟前的数据）。
 * 这正是 CLAUDE.md 里记着的「事件循环饥饿」失败模式（上次是 JSONL 全量重扫），我又踩了一遍。
 * 现在：读只取 cursor 之后的一个窗口（1MB），丢弃只推进 cursor（O(1)），
 * 仅当已消费超过 COMPACT_BYTES 才压实一次文件（70MB 积压全程只发生几次）。
 */
let cursor = 0
const WINDOW = 1024 * 1024        // 单次窗口读上限
const COMPACT_BYTES = 16 * 1024 * 1024  // 消费超过这么多才压实一次

/** 从 cursor 起读一个窗口，返回 [完整行文本...]（最后半行不要——可能正在被写） */
function windowLines() {
  const fd = fs.openSync(FILE, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (cursor >= size) return { lines: [], atEnd: true }
    const len = Math.min(WINDOW, size - cursor)
    const buf = Buffer.allocUnsafe(len)
    fs.readSync(fd, buf, 0, len, cursor)
    const txt = buf.toString('utf8')
    const atEnd = cursor + len >= size
    const parts = txt.split('\n')
    if (!atEnd) parts.pop()        // 窗口边界上的半行，本轮不碰
    return { lines: parts.filter(Boolean), atEnd }
  } finally { fs.closeSync(fd) }
}

/** 读出**最旧的 n 条**（不删）。重放限批用；只读一个窗口，不碰整个文件。 */
export function readBatch(n) {
  const k = Number(n)
  if (!Number.isFinite(k) || k <= 0) return []
  try {
    const out = []
    for (const l of windowLines().lines) {
      try { out.push(JSON.parse(l)) } catch { continue }
      if (out.length >= k) break
    }
    return out
  } catch { return [] }
}

/**
 * 丢弃**最旧的 n 条**（该批已确认写入 Mongo）：只推进游标，不重写文件。
 * 全部消费完 ⇒ 直接 unlink；消费量超过 COMPACT_BYTES ⇒ 压实一次（把已消费的前缀真正切掉）。
 */
export function dropFirst(n) {
  const k = Number(n)
  if (!Number.isFinite(k) || k <= 0) return false
  try {
    const { lines } = windowLines()
    if (!lines.length) return false
    let bytes = 0
    for (let i = 0; i < Math.min(k, lines.length); i++) bytes += Buffer.byteLength(lines[i], 'utf8') + 1
    cursor += bytes
    const size = sizeBytes()
    if (cursor >= size) return clear()
    if (cursor >= COMPACT_BYTES) compact()
    return true
  } catch { return false }
}

/** 把已消费的前缀真正从文件里切掉（摊还操作，不在每批上跑）。 */
function compact() {
  try {
    const buf = fs.readFileSync(FILE)
    fs.writeFileSync(FILE, buf.subarray(cursor), { mode: 0o600 })
    cursor = 0
  } catch { /* 尽力而为：失败就继续用游标 */ }
}

/** 重放成功后清空。 */
export function clear() {
  cursor = 0
  try { fs.unlinkSync(FILE); warned = false; return true } catch { return false }
}

/** 超上限时丢弃最旧一半（保留后半）。 */
function trimOldest() {
  try {
    // 这里会整份重写文件 ⇒ 游标必须归零，否则下次读会从错误的偏移开始、跳过数据
    cursor = 0
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
    const keep = lines.slice(Math.floor(lines.length / 2))
    fs.writeFileSync(FILE, keep.join('\n') + '\n', { mode: 0o600 })
  } catch { /* 尽力而为 */ }
}

export const _file = FILE
