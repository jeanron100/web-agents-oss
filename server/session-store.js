// server/session-store.js — 平台会话「瘦身份层」的每 agent 本地持久化（零依赖）
//
// 背景（稳定性 gap #2 / openspec session-durability Phase 1a）：平台会话（ps-*）原本纯内存，
// agent 重启即失身份，旧深链报"会话不存在"。这里只持久化**恢复所需的身份+元数据**（绝不写
// prompt / 完整事件 / 图片 / 命令参数），让重启后能按 psId 别名解析回原生 JSONL。
//
// 关键设计（吸收 Codex 评审 P1-1）：
// - 原子写：tmp → fsync → rename → fsync(dir)，并保留 .bak；加载时主文件坏回退 .bak，再坏则空。
// - 位置 ~/.web-agents/platform-sessions.json（0600）——与 agent.js 既有 EXEC_AUDIT 同目录。
// - 关键字段（realSessionId 等）由调用方 immediate flush；非关键字段可去抖。
//
// 测试见 session-store.test.mjs（node --test）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const VERSION = 1
const DEFAULT_FILE = path.join(os.homedir(), '.web-agents', 'platform-sessions.json')

// Claude 项目目录编码：与 agent.js 的 encodeCwd 完全一致（非字母数字 → '-'）。务必保持同步。
export const encodeCwd = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-')

// 由 cwd + realId 直构 Claude 原生 JSONL 路径并校验存在；不依赖看板 top-N 扫描副作用（修 Codex-P0-4）。
// 返回绝对路径或 null（realId 为空 / 文件不存在）。
export function findClaudeJsonlByRealId(cwd, realId, homedir = os.homedir()) {
  if (!cwd || !realId) return null
  const p = path.join(homedir, '.claude', 'projects', encodeCwd(cwd), `${realId}.jsonl`)
  try { return fs.existsSync(p) ? p : null } catch { return null }
}

// prune 谓词（纯函数）：对应 JSONL 已不存在，或距最后活跃超过 maxAgeDays，即应剪除。
export function shouldPrune(rec, nowMs, maxAgeDays, jsonlExists) {
  if (!jsonlExists) return true
  const ref = rec.lastActiveAt || rec.createdAt || 0
  return nowMs - ref > maxAgeDays * 86_400_000
}

/** Persisted active state + no native resume process means the agent restart interrupted an unconfirmed turn.
 *  仅 running（回合执行中被杀）与 waiting_approval（工具已提议未执行、回合确未完成）算「回合被截断」。
 *  waiting_input（回合以征询收尾）其回合已完整——问题已落 JSONL，恢复后即可回答——不算中断，
 *  否则会给「等你回话」的会话虚报「最后一回合可能未完成」（据 Claude 评审 CR-005 P2）。 */
export function interruptedByRestart(rec, nativeProcessActive = false) {
  return !nativeProcessActive && ['running', 'waiting_approval'].includes(rec?.lastState)
}

// 序列化 / 反序列化（纯函数）。parse 对形状不符抛错，交给 loadStore 回退。
export function serialize(sessions) {
  return JSON.stringify({ version: VERSION, sessions }, null, 2)
}
export function parse(text) {
  const d = JSON.parse(text)
  if (!d || d.version !== VERSION || typeof d.sessions !== 'object' || d.sessions === null) {
    throw new Error('platform-sessions.json: 形状不符')
  }
  return d.sessions
}

// 原子写：先把现有主文件备份到 .bak（=上一份好的），再 tmp→fsync→rename→fsync(dir)，最后 chmod 0600。
// .bak 只在「现有主文件确实可 parse」时才覆盖——否则一份坏主文件会把上一份好的 .bak 顶掉，
// 崩溃后主/备皆坏（据 Codex 评审 CR-006 P1-d）。
// ⚠️ `validate` 必须可替换：本函数的**机制**（tmp→fsync→rename→fsync(dir)→.bak 回退）是通用的，
//    但 `parse` 只认 platform-sessions.json 的形状（校验 version+sessions 并只返回 sessions）。
//    别的调用方（如 projection-store.js 的分片）形状不同，若沿用默认校验，
//    结果是**静默的**：`.bak` 永远写不出来、load 恒返回空——功能看着"没生效"，却一条错都不报。
export function atomicWriteFile(file, text, { validate = parse } = {}) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    if (fs.existsSync(file)) {
      validate(fs.readFileSync(file, 'utf8')) // 抛错=当前主文件不可解析→跳过备份，保住上一份好的 .bak
      fs.copyFileSync(file, file + '.bak')
    }
  } catch { /* 当前主文件坏或读失败：不覆盖 .bak（尽力而为） */ }
  const tmp = `${file}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  // fsync 目录，确保 rename 本身落盘（否则崩溃可能只剩 tmp 或旧 inode）
  try {
    const dfd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
  } catch { /* 某些 fs 不支持对目录 fsync，忽略 */ }
  try { fs.chmodSync(file, 0o600) } catch { /* 权限尽力而为 */ }
}

// 加载：依次尝试主文件、.bak；都坏或不存在则返回空对象（不抛）。
// `parseWith` 同 atomicWriteFile 的 `validate`——形状校验必须可替换，见那里的注释。
export function loadStore(file, { parseWith = parse } = {}) {
  for (const f of [file, file + '.bak']) {
    try {
      if (!fs.existsSync(f)) continue
      return parseWith(fs.readFileSync(f, 'utf8'))
    } catch { /* 坏文件，试下一个 */ }
  }
  return {}
}

/**
 * 有状态 store 工厂：内存持有 sessions（psId -> rec），落盘走原子写。
 * 生产用默认单例 `sessionStore`（driver 写、agent 启动读）；测试可传独立 file 隔离。
 */
export function createSessionStore({ file = DEFAULT_FILE, debounceMs = 2000, onWriteError = null } = {}) {
  let sessions = {}
  let timer = null
  let lastWriteError = null // 最近一次落盘失败（磁盘满/权限/fsync）；null=上次成功

  // 落盘失败不影响内存态，但**不能再静默吞掉**：磁盘满/权限失败时若无声「成功」，重启后才暴露身份丢失
  // （据 Codex 评审 CR-006 P1-d）。故记录 lastWriteError、回调上报、返回 ok 布尔，供 flush/健康检查判断。
  const writeNow = () => {
    try {
      atomicWriteFile(file, serialize(sessions))
      lastWriteError = null
      return true
    } catch (e) {
      lastWriteError = e
      try { onWriteError ? onWriteError(e) : console.warn(`[session-store] 落盘失败(${file}): ${e?.message || e}`) } catch { /* 上报本身别再抛 */ }
      return false
    }
  }
  const scheduleWrite = () => {
    if (timer) return
    timer = setTimeout(() => { timer = null; writeNow() }, debounceMs)
    if (timer.unref) timer.unref()
  }

  return {
    /** 启动加载（含 .bak 回退），返回 sessions 引用 */
    load() { sessions = loadStore(file); return sessions },
    /** 当前全部记录 */
    all() { return sessions },
    get(psId) { return sessions[psId] || null },
    /**
     * 合并 upsert 一条记录。immediate=true 立即落盘（关键字段：psId 创建 / realSessionId 到达 /
     * pending 变更 / release），否则去抖（lastActiveAt/summary/lastState）。
     */
    upsert(rec, { immediate = false } = {}) {
      if (!rec || !rec.psId) return null
      sessions[rec.psId] = { ...(sessions[rec.psId] || {}), ...rec }
      immediate ? writeNow() : scheduleWrite()
      return sessions[rec.psId]
    },
    /** 删除一条（release/reattach 成功后不再需要影子身份），立即落盘 */
    remove(psId) { if (sessions[psId]) { delete sessions[psId]; writeNow() } },
    /**
     * 剪除：JSONL 不存在或超期。existsFn 默认按 findClaudeJsonlByRealId 判定，测试可注入。
     * 返回剩余 sessions。
     */
    prune(nowMs, maxAgeDays = 14, existsFn) {
      const exists = existsFn || ((rec) => !!findClaudeJsonlByRealId(rec.cwd, rec.realSessionId))
      let changed = false
      for (const [psId, rec] of Object.entries(sessions)) {
        if (shouldPrune(rec, nowMs, maxAgeDays, exists(rec))) { delete sessions[psId]; changed = true }
      }
      if (changed) writeNow()
      return sessions
    },
    /** 强制把去抖中的改动立即落盘（进程退出前可调）。返回 true=成功；false=落盘失败（身份可能未持久，调用方应告警）。 */
    flush() { if (timer) { clearTimeout(timer); timer = null } return writeNow() },
    /** 最近一次落盘是否失败（null=好）。供健康检查/优雅退出判断身份层是否真落盘。 */
    lastWriteError() { return lastWriteError },
    _file: file,
  }
}

// 生产单例：driver.js 写入、agent.js 启动读取，共享同一实例（ES module 单例）。
export const sessionStore = createSessionStore()
