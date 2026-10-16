// Kimi Code 平台会话驱动器（ACP v1 JSON-RPC over stdio）。
// 单个 `kimi acp` 进程承载多个 session：session/new|load → session/prompt →
// session/update 流式事件 / session/request_permission 审批 → cancel / close。
//
// 这里刻意不依赖 ACP SDK：agent 部署仍只需同步本目录 JS 文件，不引入新的运行时安装步骤。
import { spawnInSlice } from './spawn-in-slice.js'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { seqBounds } from './event-seq.js'
import { saveSessionImages } from './driver.js'

export function findKimi() {
  if (process.env.KIMI_BIN && fs.existsSync(process.env.KIMI_BIN)) return process.env.KIMI_BIN
  const cands = [
    path.join(os.homedir(), '.kimi-code', 'bin', 'kimi'),
    path.join(os.homedir(), '.local', 'bin', 'kimi'),
    '/usr/local/bin/kimi',
    '/usr/bin/kimi',
  ]
  return cands.find((p) => fs.existsSync(p)) ?? null
}

let seq = 0
const nid = (p) => `${p}-${Date.now().toString(36)}-${++seq}`
const emptyTok = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })

let proc = null
let ready = null
let rpcSeq = 0
let capabilities = {}
let authMethods = []
const pendingRpc = new Map()
const sessions = new Map()

function write(obj) {
  if (!proc?.stdin?.writable) throw new Error('Kimi ACP 进程不可用')
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n')
}

function rpc(method, params, timeoutMs = 60_000) {
  const id = `wa-${++rpcSeq}`
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (!pendingRpc.has(id)) return
          pendingRpc.delete(id)
          reject(new Error(`Kimi ACP 请求超时：${method}`))
        }, timeoutMs)
      : null
    timer?.unref?.()
    pendingRpc.set(id, {
      resolve: (v) => { if (timer) clearTimeout(timer); resolve(v) },
      reject: (e) => { if (timer) clearTimeout(timer); reject(e) },
    })
    write({ id, method, params })
  })
}

function failProcess(message) {
  for (const p of pendingRpc.values()) p.reject(new Error(message))
  pendingRpc.clear()
  for (const s of sessions.values()) {
    for (const p of s.pending.values()) p.expire()
    s.pending.clear()
    s.turnActive = false
    s.startingTurn = false
    s.state = 'error'
    s.error = message
    s.summary = `会话中断：${message}`
  }
}

async function ensureServer() {
  if (ready) return ready
  const bin = findKimi()
  if (!bin) throw new Error('未安装 Kimi Code CLI；请先安装并执行 `kimi login`')
  ready = new Promise((resolve, reject) => {
    try {
      proc = spawnInSlice(spawn, bin, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] }, { unit: 'wa-kimi-acp' })
    } catch (e) {
      reject(e)
      return
    }
    let settled = false
    const failReady = (e) => {
      if (settled) return
      settled = true
      ready = null
      reject(e)
    }
    proc.on('error', (e) => {
      failReady(e)
      failProcess(`Kimi ACP 启动失败：${e.message}`)
    })
    proc.stderr.on('data', () => { /* Kimi 诊断日志留在其自身日志文件，避免把凭据/提示写入 agent 日志 */ })
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (line.trim()) handleMessage(line)
    })
    proc.on('exit', (code, signal) => {
      const message = `Kimi ACP 进程已退出（${signal || code || 'unknown'}）`
      proc = null
      ready = null
      failReady(new Error(message))
      failProcess(message)
    })
    rpc('initialize', {
      protocolVersion: 1,
      // Kimi 自己在本机执行文件与终端操作；不声明 ACP 反向 fs/terminal，避免重复代理。
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      clientInfo: { name: 'web-agents', title: 'Web Agents', version: '0.1.0' },
    }).then((result) => {
      capabilities = result?.agentCapabilities ?? {}
      authMethods = Array.isArray(result?.authMethods) ? result.authMethods : []
      if (result?.protocolVersion !== 1) throw new Error(`Kimi ACP 协议版本不兼容：${result?.protocolVersion}`)
      settled = true
      resolve(result)
    }).catch((e) => {
      try { proc?.kill('SIGTERM') } catch { /* ignore */ }
      failReady(e)
    })
  })
  return ready
}

function handleMessage(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  // 我方请求的响应使用 wa-* 字符串 id，与 Kimi 发起的反向请求 id 分离，避免双向 RPC 撞号。
  if (typeof msg.id === 'string' && msg.id.startsWith('wa-') && pendingRpc.has(msg.id)) {
    const p = pendingRpc.get(msg.id)
    pendingRpc.delete(msg.id)
    if (msg.error) {
      const detail = msg.error.message ?? 'Kimi ACP 错误'
      const oauthLogin = authMethods.some((x) => x?.id === 'login')
      const hint = /auth|login|token|401/i.test(detail) || msg.error.code === -32000
        ? `；请先在该服务器执行 \`kimi login\` 完成 OAuth 认证（不需要 API Key${oauthLogin ? '' : '；当前 CLI 未声明 login 认证方法'}）`
        : ''
      p.reject(new Error(detail + hint))
    } else {
      p.resolve(msg.result)
    }
    return
  }
  if (msg.id != null && msg.method) {
    handleServerRequest(msg)
    return
  }
  if (msg.method === 'session/update') handleSessionUpdate(msg.params ?? {})
}

function textContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (content.type === 'text') return String(content.text ?? '')
  return ''
}

function sealAssistant(s) {
  const last = s.events[s.events.length - 1]
  if (last?.type === 'assistant' && last._streaming) {
    delete last._streaming
    last.seq = ++s.nextSeq
  }
}

function pushEvent(s, event) {
  sealAssistant(s)
  s.events.push({ id: nid('ev'), ts: Date.now(), seq: ++s.nextSeq, ...event })
  if (s.events.length > 400) s.events.splice(0, s.events.length - 400)
  s.lastActiveAt = Date.now()
}

function appendAssistant(s, text, messageId) {
  if (!text) return
  let last = s.events[s.events.length - 1]
  if (!last || last.type !== 'assistant' || !last._streaming || (messageId && last._messageId !== messageId)) {
    sealAssistant(s)
    last = { id: nid('ev'), ts: Date.now(), type: 'assistant', text: '', _streaming: true, _messageId: messageId }
    s.events.push(last)
    if (s.events.length > 400) s.events.splice(0, s.events.length - 400)
  }
  last.text += text
  s.summary = last.text.trim().slice(0, 80) || s.summary
  s.lastActiveAt = Date.now()
}

function optionValue(option) {
  if (typeof option === 'string') return option
  return String(option?.value ?? option?.id ?? option?.optionId ?? '')
}

function configId(option) {
  return String(option?.id ?? option?.configId ?? '')
}

function applyConfigOptions(s, options) {
  if (!Array.isArray(options)) return
  const merged = new Map((s.configOptions ?? []).map((x) => [configId(x), x]))
  for (const option of options) merged.set(configId(option), option)
  s.configOptions = [...merged.values()]
  for (const option of options) {
    const id = configId(option)
    const current = String(option.currentValue ?? option.current_value ?? '')
    if (id === 'model' && current) s.model = current
    if (id === 'thinking' && current) s.effort = current
    if (id === 'mode' && current) s.kimiMode = current
  }
}

function toolPath(update) {
  const loc = update?.locations?.[0] ?? update?.location
  const a = update?.rawInput ?? update?.args ?? update?.input ?? {}
  // 与 kimi-shadow parseWire 的取数对齐：同一操作两源给出同一个 path，跨源指纹去重才比得中。
  return String(loc?.path ?? update?.path ?? a.file_path ?? a.path ?? a.pattern ?? a.command ?? update?.title ?? '').slice(0, 300)
}

function toolVerb(kind) {
  return {
    read: '读取', edit: '修改文件', delete: '删除', move: '移动',
    search: '搜索', execute: '执行命令', fetch: '访问网页', think: '思考',
  }[kind] ?? '调用工具'
}

const unknownSidLog = new Map() // sessionId -> 已打过的日志条数（限流：每个 id 最多 3 条）

function handleSessionUpdate(params) {
  const s = sessions.get(params.sessionId)
  if (!s) {
    // ⚠️ 不许静默丢弃（2026-09-26：ACP id 与 record 键不一致时事件全灭、对话流只剩用户气泡，
    //    而日志里一个字都没有，排查全靠猜）。限流防刷屏，但第一次必须高声。
    const n = unknownSidLog.get(params.sessionId) ?? 0
    if (n < 3) {
      unknownSidLog.set(params.sessionId, n + 1)
      console.warn(`[kimi] session/update 命中未知 sessionId=${params.sessionId}（已登记: ${[...sessions.keys()].join(', ') || '无'}）——事件被丢弃${n === 2 ? '，后续不再重复报告' : ''}`)
    }
    return
  }
  const u = params.update ?? {}
  s.lastActiveAt = Date.now()
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      appendAssistant(s, textContent(u.content), u.messageId)
      break
    case 'user_message_chunk': {
      const text = textContent(u.content)
      if (text) pushEvent(s, { type: 'user', text })
      break
    }
    case 'tool_call':
      s.toolCalls.set(u.toolCallId, u)
      if (u.kind !== 'think') pushEvent(s, { type: 'file_op', verb: toolVerb(u.kind), path: toolPath(u) })
      break
    case 'tool_call_update':
      s.toolCalls.set(u.toolCallId, { ...(s.toolCalls.get(u.toolCallId) ?? {}), ...u })
      break
    case 'plan':
      s.todos = (u.entries ?? []).map((x) => ({
        text: String(x.content ?? ''),
        status: x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'active' : 'pending',
      })).filter((x) => x.text)
      break
    case 'usage_update':
      s.tokens = Number(u.used ?? s.tokens) || 0
      if (u.cost?.currency === 'USD') s.cost = Number(u.cost.amount ?? s.cost) || 0
      break
    case 'session_info_update':
      if (u.title && !s.events.some((e) => e.type === 'assistant')) s.summary = String(u.title).slice(0, 80)
      break
    case 'config_option_update':
      applyConfigOptions(s, [u.configOption ?? u.option ?? u])
      break
    case 'config_options_update':
      applyConfigOptions(s, u.configOptions ?? u.options)
      break
  }
}

export function selectPermissionOption(options, resolution) {
  const list = Array.isArray(options) ? options : []
  const wanted = resolution === '拒绝'
    ? ['reject_once', 'reject_always']
    : resolution === '本会话始终允许'
      ? ['allow_always', 'allow_once']
      : ['allow_once', 'allow_always']
  for (const kind of wanted) {
    const hit = list.find((x) => x?.kind === kind)
    if (hit) return hit
  }
  return list[0] ?? null
}

function handleServerRequest(msg) {
  if (msg.method !== 'session/request_permission') {
    write({ id: msg.id, error: { code: -32601, message: `不支持的 ACP 反向方法：${msg.method}` } })
    return
  }
  const p = msg.params ?? {}
  const s = sessions.get(p.sessionId)
  if (!s) {
    write({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
    return
  }
  const tool = { ...(s.toolCalls.get(p.toolCall?.toolCallId) ?? {}), ...(p.toolCall ?? {}) }
  const action = {
    id: nid('act'),
    sessionId: s.id,
    kind: 'approval',
    title: String(tool.title ?? 'Kimi 请求执行操作'),
    detail: toolPath(tool) || String(tool.toolCallId ?? ''),
    createdAt: Date.now(),
    status: 'pending',
  }
  s.state = 'waiting_approval'
  s.summary = `${action.title}：${action.detail}`.slice(0, 100)
  const settle = (resolution, expired = false) => {
    if (!s.pending.has(action.id)) return
    action.status = expired ? 'expired' : 'resolved'
    action.resolution = resolution
    s.pending.delete(action.id)
    const selected = selectPermissionOption(p.options, resolution)
    const outcome = expired || !selected
      ? { outcome: 'cancelled' }
      : { outcome: 'selected', optionId: selected.optionId }
    write({ id: msg.id, result: { outcome } })
    if (s.pending.size === 0) s.state = s.turnActive ? 'running' : 'idle'
  }
  s.pending.set(action.id, {
    action,
    resolve: (resolution) => settle(resolution, false),
    expire: () => settle('拒绝', true),
  })
}

export function mapModeValue(mode, options = []) {
  const values = options.map(optionValue).filter(Boolean)
  const candidates = {
    plan: ['plan'],
    auto: ['auto', 'yolo', 'autopilot'],
    acceptEdits: ['auto', 'accept_edits', 'acceptEdits'],
    default: ['default', 'ask', 'normal'],
  }[mode] ?? [mode]
  return candidates.find((x) => values.includes(x)) ?? null
}

export function mapModelValue(model, options = []) {
  const requested = String(model ?? '').trim()
  if (!requested) return null
  const bare = requested.replace(/^kimi-code\//, '')
  const values = options.map(optionValue).filter(Boolean)
  if (!values.length) return requested
  return values.find((value) => value === requested || value.replace(/^kimi-code\//, '') === bare) ?? null
}

async function setConfig(s, id, value) {
  if (!s || s.done || !value) return false
  try {
    const result = await rpc('session/set_config_option', { sessionId: s.id, configId: id, value })
    applyConfigOptions(s, result?.configOptions)
    return true
  } catch {
    return false
  }
}

async function applyInitialConfig(s, { mode, model, effort }) {
  if (model) {
    const option = s.configOptions.find((x) => configId(x) === 'model')
    const value = mapModelValue(model, option?.options ?? [])
    if (!value || !await setConfig(s, 'model', value)) {
      throw new Error(`Kimi 模型不可用：${model}；请确认当前 OAuth 账号的会员权益`)
    }
    s.model = value
  }
  if (effort) await setConfig(s, 'thinking', effort)
  const modeOption = s.configOptions.find((x) => configId(x) === 'mode')
  const value = mapModeValue(mode, modeOption?.options ?? [])
  if (value) {
    if (await setConfig(s, 'mode', value)) s.kimiMode = value
  }
}

async function startPrompt(s, blocks) {
  if (s.done || s.startingTurn || s.turnActive || s.pending.size > 0) return false
  s.startingTurn = true
  s.turnActive = true
  s.state = 'running'
  s.turnStartedAt = Date.now()
  s.turnStartTokens = s.tokens
  s.summary = '正在处理新指令…'
  try {
    await rpc('session/prompt', { sessionId: s.id, prompt: blocks }, 12 * 60 * 60_000)
    sealAssistant(s)
    s.state = 'idle'
    pushEvent(s, {
      type: 'turn_end',
      durationSec: Math.max(0, Math.round((Date.now() - s.turnStartedAt) / 1000)),
      tokens: Math.max(0, s.tokens - s.turnStartTokens),
      cost: 0,
    })
    return true
  } catch (e) {
    sealAssistant(s)
    s.state = 'error'
    s.error = String(e?.message ?? e)
    s.summary = `发送失败：${s.error}`.slice(0, 100)
    return false
  } finally {
    s.turnActive = false
    s.startingTurn = false
    if (s.queuedInputs.length) void startNextQueued(s)
  }
}

async function startNextQueued(s) {
  if (s.done || s.turnActive || s.startingTurn || s.pending.size || !s.queuedInputs.length) return
  const blocks = s.queuedInputs.shift()
  if (blocks) await startPrompt(s, blocks)
}

function newRecord({ id, cwd, prompt, resume, mode }) {
  return {
    id,
    realSessionId: id,
    resumedFrom: resume ?? null,
    cwd,
    project: path.basename(cwd),
    branch: '',
    engine: 'kimi',
    model: 'Kimi',
    effort: '',
    mode,
    kimiMode: '',
    state: prompt ? 'running' : 'idle',
    summary: prompt ? String(prompt).slice(0, 80) : '已接管，等待指令…',
    firstPrompt: prompt ? String(prompt).trim().slice(0, 120) : '',
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    cost: 0,
    tokens: 0,
    tok: emptyTok(),
    origin: 'platform',
    events: [],
    todos: [],
    fileChanges: [],
    pending: new Map(),
    toolCalls: new Map(),
    configOptions: [],
    queuedInputs: [],
    nextSeq: 0,
    startingTurn: false,
    turnActive: false,
    done: false,
  }
}

export async function createSession({ cwd, prompt, resume, mode = 'auto', model, effort }) {
  if (!fs.existsSync(cwd)) throw new Error(`目录不存在: ${cwd}`)
  await ensureServer()
  // session/load 会在 RPC 响应前用 session/update 回放历史；必须先登记占位 record，不能等响应后再建。
  let record = resume ? newRecord({ id: resume, cwd, prompt, resume, mode }) : null
  if (record) sessions.set(resume, record)
  let result
  try {
    result = await rpc(
      resume ? 'session/load' : 'session/new',
      resume ? { sessionId: resume, cwd, mcpServers: [] } : { cwd, mcpServers: [] },
    )
  } catch (e) {
    if (record) sessions.delete(resume)
    throw e
  }
  const id = result?.sessionId ?? resume
  if (!id) throw new Error('Kimi 会话创建失败：未返回 sessionId')
  if (!record) {
    record = newRecord({ id, cwd, prompt, resume, mode })
    sessions.set(id, record)
  } else if (id !== resume) {
    // ACP 层给会话重新指派了 id（与 resume 请求值不同）：record 必须改挂到新键下，
    // 否则后续 session/update 全按新 id 到达、查不到 record 被静默丢弃——对话流只剩
    // 用户自己的气泡（2026-09-26 线上：ACP id 与存储 id 差一个字符，事件凭空消失）。
    sessions.delete(resume)
    record.id = id
    record.realSessionId = id
    sessions.set(id, record)
    console.warn(`[kimi] ACP 将会话 id 由 ${resume} 重指派为 ${id}，record 已随迁`)
  }
  try {
    applyConfigOptions(record, result?.configOptions)
    await applyInitialConfig(record, { mode, model, effort })
    if (prompt) {
      pushEvent(record, { type: 'user', text: String(prompt) })
      // 创建接口只需等 ACP 接受会话，不应一直等完整回合。
      void startPrompt(record, [{ type: 'text', text: String(prompt) }])
    }
    return record
  } catch (e) {
    // session/close 尚未被 Kimi ACP 实现；至少清掉 WebAgents 的 live handle，避免失败请求占用并发槽。
    sessions.delete(id)
    throw e
  }
}

function lastEventOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'file_op') return { ts: e.ts, verb: e.verb, path: e.path ?? '' }
  }
  return null
}

export function hasSession(id) {
  return sessions.has(id)
}

export function realSessionIds() {
  return new Set(sessions.keys())
}

export function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    project: s.project,
    branch: s.branch,
    engine: 'kimi',
    model: s.model,
    effort: s.effort || undefined,
    mode: s.mode,
    state: s.pending.size ? 'waiting_approval' : s.state,
    summary: s.summary,
    firstPrompt: s.firstPrompt,
    startedAt: s.startedAt,
    lastActiveAt: s.lastActiveAt,
    cost: s.cost,
    tokens: s.tokens,
    tokensBreakdown: { ...s.tok },
    origin: 'platform',
    realSessionId: s.realSessionId,
    resumedFrom: s.resumedFrom,
    cwd: s.cwd,
    error: s.error,
    inflight: !!(s.turnActive || s.startingTurn || s.pending.size),
    queuedMessages: s.queuedInputs.length,
    lastEvent: lastEventOf(s.events),
    todoStats: {
      done: s.todos.filter((x) => x.status === 'done').length,
      active: s.todos.filter((x) => x.status === 'active').length,
      total: s.todos.length,
    },
  }))
}

export function getEvents(id) {
  const s = sessions.get(id)
  if (!s) return null
  const events = s.events.map(({ _streaming, _messageId, ...e }) => (_streaming ? { ...e, streaming: true } : e))
  return { events, fileChanges: s.fileChanges, todos: s.todos, ...seqBounds(events) }
}

export function pendingActions() {
  const out = []
  for (const s of sessions.values()) for (const p of s.pending.values()) out.push(p.action)
  return out
}

export async function sendMessage(id, text, images = []) {
  const s = sessions.get(id)
  if (!s || s.done) return false
  const blocks = []
  if (text) blocks.push({ type: 'text', text })
  for (const img of images) {
    if (img?.data && img?.media_type) blocks.push({ type: 'image', data: img.data, mimeType: img.media_type })
  }
  if (!blocks.length) return false
  const saved = saveSessionImages(id, images)
  pushEvent(s, {
    type: 'user',
    text,
    imageCount: images.length || undefined,
    images: saved.length ? saved : undefined,
  })
  if (s.turnActive || s.startingTurn || s.pending.size) {
    s.queuedInputs.push(blocks)
    s.state = s.pending.size ? 'waiting_approval' : 'running'
    s.summary = s.pending.size ? `等待处理 ${s.pending.size} 个审批` : `当前回合处理中 · 已排队 ${s.queuedInputs.length} 条消息`
    return true
  }
  void startPrompt(s, blocks)
  return true
}

export async function interrupt(id) {
  const s = sessions.get(id)
  if (!s) return false
  s.queuedInputs.length = 0
  for (const p of [...s.pending.values()]) p.expire()
  // ACP cancellation is a notification, not a request (a request gets Method not found).
  try { write({ method: 'session/cancel', params: { sessionId: id } }) } catch { /* 已结束 */ }
  sealAssistant(s)
  s.turnActive = false
  s.startingTurn = false
  s.state = 'idle'
  s.summary = '已被用户中断'
  return true
}

export async function setMode(id, mode) {
  const s = sessions.get(id)
  if (!s) return false
  const option = s.configOptions.find((x) => configId(x) === 'mode')
  const value = mapModeValue(mode, option?.options ?? [])
  if (!value) return false
  const ok = await setConfig(s, 'mode', value)
  if (ok) { s.mode = mode; s.kimiMode = value }
  return ok
}

export async function setLlmModel(id, model) {
  const s = sessions.get(id)
  if (!s) return false
  const option = s.configOptions.find((x) => configId(x) === 'model')
  const value = mapModelValue(model, option?.options ?? [])
  if (!value) return false
  const ok = await setConfig(s, 'model', value)
  if (ok) s.model = value
  return ok
}

export async function setLlmEffort(id, effort) {
  const s = sessions.get(id)
  const ok = await setConfig(s, 'thinking', String(effort))
  if (ok) s.effort = String(effort)
  return ok
}

export function resolveAction(actionId, resolution) {
  for (const s of sessions.values()) {
    const p = s.pending.get(actionId)
    if (!p) continue
    p.resolve(resolution)
    s.lastActiveAt = Date.now()
    return true
  }
  return false
}

export function actionKind(actionId) {
  for (const s of sessions.values()) {
    const p = s.pending.get(actionId)
    if (p) return p.action.kind
  }
  return null
}

export async function release(id) {
  const s = sessions.get(id)
  if (!s) return null
  s.done = true
  s.queuedInputs.length = 0
  for (const p of [...s.pending.values()]) p.expire()
  try {
    if (capabilities?.sessionCapabilities?.close) await rpc('session/close', { sessionId: id })
    else if (s.turnActive) write({ method: 'session/cancel', params: { sessionId: id } })
  } catch { /* 本地仍释放，原生 session 已持久化，可稍后 load */ }
  sessions.delete(id)
  return { realId: s.realSessionId }
}
