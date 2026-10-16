// Codex 平台会话驱动器（app-server v2 JSON-RPC over stdio）。
// 单个 `codex app-server` 进程承载多会话（thread）；创建→thread/start，
// 空闲发消息→turn/start，运行中默认→turn/steer，显式新任务排队；审批 item/*/requestApproval，
// 恢复 thread/resume。协议要点见 server/README.md。
import { spawnInSlice } from './spawn-in-slice.js'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import {externalSandboxEnabled,sandboxPolicy} from './codex-sandbox.js'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { seqBounds } from './event-seq.js'
import { loadProjectMcp } from './mcp-config.js'
import { saveSessionImages } from './driver.js'
import { connectCodexDaemon } from './codex-daemon-transport.js'
import { createReconnectRegistry, independentDaemon } from './codex-reconnect.js'

/**
 * 把 (文本, 图片[]) 拼成 app-server `turn/start` 的 input[]。
 *
 * 合法变体（实测 0.130.0 / 0.144.6 / 0.146.0 三个版本一致，用「传非法字段反查 schema」探得）：
 *   text | image | localImage | skill | mention
 * image **只认 `url`，且必须是内联 data URL**——传 http(s) 外链会被明确拒绝：
 *   "remote image URLs are not supported; use an inline data URL instead"
 *
 * 顺序与 Claude 侧一致：图在前、文在后（见 driver.js:594-599）。
 * 返回空数组表示「没有可发的内容」，调用方据此拒发，而不是发一条空消息。
 */
export function buildCodexInput(text, images) {
  const input = []
  for (const img of Array.isArray(images) ? images : []) {
    if (!img?.data || !img?.media_type) continue
    input.push({ type: 'image', url: `data:${img.media_type};base64,${img.data}` })
  }
  if (text) input.push({ type: 'text', text, text_elements: [] })
  return input
}

function findCodex() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN
  const cands = ['/usr/local/bin/codex', '/usr/bin/codex']
  try {
    const nvm = path.join(os.homedir(), '.nvm/versions/node')
    for (const v of fs.readdirSync(nvm)) cands.push(path.join(nvm, v, 'bin/codex'))
  } catch { /* 无 nvm */ }
  return cands.find((p) => fs.existsSync(p)) ?? 'codex'
}
const CODEX_BIN = findCodex()

let seq = 0
const nid = (p) => `${p}-${Date.now().toString(36)}-${++seq}`
const prettyModel = (m) => m || 'GPT'

// ---- 单例 app-server 连接 ----
let proc = null
let rpcId = 0
const pendingRpc = new Map()    // rpc id -> {resolve, reject}
const threads = new Map()       // threadId -> record
let ready = null
let sharedDaemon = false
const restoringMessages = new Map()
const resumeJobs = new Map()
const reconnectRegistry = createReconnectRegistry()
let daemonSocketPath = null
let daemonPid = null

function ensureServer() {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'app-server-control/app-server-control.sock')
    // CLI 会话由常驻 daemon 持有写锁；连接原服务才能 resume，不能再起第二个写者。
    // 显式 CODEX_BIN（含测试替身）保留独立进程模式。
    sharedDaemon = !process.env.CODEX_BIN && fs.existsSync(socketPath)
    daemonSocketPath = sharedDaemon ? socketPath : null
    daemonPid = null
    proc = sharedDaemon ? connectCodexDaemon(socketPath)
      : spawnInSlice(spawn, CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] }, { unit: 'wa-codex-app-server' })
    proc.on('error', reject)
    proc.stderr.on('data', () => { /* tracing 日志，忽略 */ })
    const rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => { if (line.trim()) handleMessage(line) })
    proc.on('exit', () => {
      proc = null; ready = null
      // 拒绝所有在途 rpc：进程都退了，它们永远等不到响应。不清就得等各自 60s 超时才 reject，
      // 导致 setLlmEffort/sendMessage 等 await 方（及其 HTTP 请求）挂 ~60s 才失败。清了即快速失败。
      for (const { reject, timer } of pendingRpc.values()) {
        clearTimeout(timer)
        try { reject(new Error('codex app-server 进程已退出')) } catch { /* ignore */ }
      }
      pendingRpc.clear()
      for (const t of threads.values()) {
        // app-server 已退出，旧审批的响应通道也随之消失。不能把这些 action 留在收件箱里，
        // 否则用户点击后只会命中一个已经不存在的 server request。
        for (const { action } of t.pending.values()) action.status = 'expired'
        t.pending.clear()
        t.turnActive = false
        t.startingTurn = false
        t.uncertainInflight = false // app-server 已退出，不可能还有子进程在飞
        t.state = 'error'; t.done = true
        t.error = 'Codex app-server 进程已退出（崩溃或被终止），会话已中断，可释放后重开'
        t.summary = `会话中断：${t.error.slice(0, 80)}`
      }
    })

    rpc('initialize', {
      clientInfo: { name: 'agent-console', title: 'Agent Console', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      send({ method: 'initialized' }) // 通知，无 id
      resolve()
    }).catch(reject)
  })
  return ready
}

// 实时订阅额度（看板用）：起一个短命 app-server，initialize→account/rateLimits/read→kill。
// 与 Codex 客户端 /status 同源、零额度成本、不发回合；独立于上面的会话单例，避免在
// 无 codex 会话的机器上常驻进程。返回 { primary, secondary, planType, ... } | null。
export function liveRateLimits(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let p = null, done = false, lid = 0
    const pend = new Map()
    const finish = (v) => { if (done) return; done = true; clearTimeout(to); try { p?.kill('SIGKILL') } catch { /* ignore */ } resolve(v) }
    const to = setTimeout(() => finish(null), timeoutMs)
    try { p = spawn(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return finish(null) }
    const w = (o) => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n') } catch { /* ignore */ } }
    const call = (method, params) => new Promise((res) => { const i = ++lid; pend.set(i, res); w({ id: i, method, params }) })
    p.on('error', () => finish(null))
    p.stderr.on('data', () => { /* tracing，忽略 */ })
    readline.createInterface({ input: p.stdout }).on('line', (ln) => {
      if (!ln.trim()) return
      let m; try { m = JSON.parse(ln) } catch { return }
      if (m.id != null && pend.has(m.id)) { const r = pend.get(m.id); pend.delete(m.id); r(m.error ? null : m.result) }
    })
    ;(async () => {
      await call('initialize', { clientInfo: { name: 'agent-console', title: 'Agent Console', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      w({ method: 'initialized' })
      const r = await call('account/rateLimits/read', null)
      finish(r?.rateLimits ?? null)
    })().catch(() => finish(null))
  })
}

function send(obj) {
  if (!proc?.stdin?.writable) throw new Error('codex app-server 不可用')
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n')
}

function rpc(method, params) {
  const id = ++rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRpc.has(id)) { pendingRpc.delete(id); reject(new Error(`codex rpc timeout: ${method}`)) }
    }, 60_000)
    pendingRpc.set(id, { resolve, reject, timer })
    try { send({ id, method, params }) }
    catch (error) { clearTimeout(timer); pendingRpc.delete(id); reject(error) }
  })
}

function handleMessage(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const restoringId = msg.params?.threadId ?? msg.params?.thread?.id
  if (msg.method && restoringMessages.has(restoringId)) {
    restoringMessages.get(restoringId).push(line)
    return
  }

  // 两个方向的 RPC id 独立计数；先按 method 识别 server 请求，避免撞号吞掉审批。
  if (msg.id != null && msg.method) { handleServerRequest(msg); return }
  // 1) client 请求的响应
  if (msg.id != null && pendingRpc.has(msg.id)) {
    const { resolve, reject, timer } = pendingRpc.get(msg.id)
    clearTimeout(timer)
    pendingRpc.delete(msg.id)
    if (msg.error) reject(Object.assign(new Error(msg.error.message ?? 'rpc error'), { rpcCode: msg.error.code }))
    else resolve(msg.result)
    return
  }
  // 3) 通知
  if (msg.method) handleNotification(msg.method, msg.params ?? {})
}

const threadOf = (params) => {
  const tid = params.threadId ?? params.thread?.id
  return tid ? threads.get(tid) : null
}

function handleNotification(method, params) {
  const t = threadOf(params)
  if (!t) return
  t.lastActiveAt = Date.now()
  switch (method) {
    case 'turn/started':
      t.turnActive = true
      t.uncertainInflight = false // app-server 确认回合开始 → 不确定解除，改由 turnActive 表征在飞
      if (t.pending.size === 0) t.state = 'running'
      t.curTurnId = params.turn?.id ?? t.curTurnId
      break
    case 'item/started':
      // 有输出/动作即视为运行中（修复：之前仅 turn/started 置 running，流式输出时却显示空闲）
      if (t.state !== 'waiting_approval') t.state = 'running'
      if (params.item?.type === 'commandExecution') {
        pushEvent(t, { type: 'file_op', verb: '执行命令', path: cleanCmd(params.item.command) })
      }
      break
    case 'item/agentMessage/delta':
      if (t.state !== 'waiting_approval') t.state = 'running'
      appendAssistant(t, params.delta ?? '', params.itemId)
      break
    case 'item/completed': {
      if (t.state !== 'waiting_approval') t.state = 'running'
      const it = params.item ?? {}
      if (it.type === 'agentMessage') {
        const last = t.events[t.events.length - 1]
        if (last?.type === 'assistant' && last._streaming && (!last._itemId || last._itemId === it.id)) {
          if (it.text) {
            // A mid-turn user message can seal an earlier chunk of this SAME native item.
            // Completion contains its whole text; keep only the tail in this later bubble.
            const prefix = t.events.filter(e => e !== last && e.type === 'assistant' && e._itemId === it.id).map(e => e.text).join('')
            last.text = prefix && it.text.startsWith(prefix) ? it.text.slice(prefix.length) : it.text
          }
          finalizeAssistant(t)
        } else if (it.text) {
          const chunks = t.events.filter(e => e.type === 'assistant' && e._itemId === it.id)
          const prefix = chunks.map(e => e.text).join('')
          const remaining = !chunks.length ? it.text : it.text.startsWith(prefix) ? it.text.slice(prefix.length) : ''
          if (remaining) pushEvent(t, { type: 'assistant', text: remaining, _itemId: it.id })
        }
        if (it.text) t.summary = it.text.slice(0, 80)
      }
      if (it.type === 'fileChange' || it.type === 'patchApply') {
        pushEvent(t, { type: 'file_op', verb: '更新文件', path: String(it.path ?? '补丁').slice(0, 100) })
        t._changed = (t._changed ?? 0) + 1
      }
      break
    }
    case 'thread/tokenUsage/updated': {
      const tu = params.tokenUsage?.total
      if (tu) {
        t.tokens = tu.totalTokens ?? t.tokens
        // best-effort 拆分（字段名未必齐全；input 含 cache 则减去）
        const cached = tu.cachedInputTokens ?? 0
        t.tok = {
          input: Math.max(0, (tu.inputTokens ?? 0) - cached),
          output: tu.outputTokens ?? 0,
          cacheRead: cached,
          cacheCreate: 0,
        }
      }
      break
    }
    case 'serverRequest/resolved':
      for (const [id, pending] of t.pending) {
        if (pending.requestId !== params.requestId) continue
        pending.action.status = 'resolved'
        t.pending.delete(id) // 上游已处理，不再回一次 RPC response
      }
      if (t.pending.size === 0 && t.state === 'waiting_approval') t.state = t.turnActive ? 'running' : 'idle'
      if (!t.turnActive) void startNextQueued(t)
      break
    case 'error':
      t.error = params.error?.message || 'Codex 回合失败'
      t.summary = params.willRetry ? `正在重试：${t.error}` : t.error
      if (!params.willRetry) t.state = 'error'
      break
    case 'turn/completed':
      finalizeAssistant(t)
      for (const [id, pending] of t.pending) {
        if (pending.action.kind !== 'approval') continue
        pending.action.status = 'expired'
        t.pending.delete(id)
      }
      t.turnActive = false
      t.uncertainInflight = false // 回合明确结束
      t.curTurnId = null
      if (params.turn?.status === 'failed' || params.turn?.error) {
        t.state = 'error'
        t.error = params.turn?.error?.message || t.error || 'Codex 回合失败'
        t.summary = t.error
        break // 留住队列，不能把下一条用户消息也自动送进同一个失败
      }
      t.state = 'idle'; t.error = undefined
      onTurnEnd(t)
      void startNextQueued(t)
      break
    case 'thread/status/changed':
      if (params.status?.activeFlags?.includes('waitingOnApproval')) t.state = 'waiting_approval'
      break
  }
}

const cleanCmd = (c) => String(c ?? '').replace(/^\/bin\/bash -lc /, '').replace(/^'|'$/g, '').slice(0, 100)

function handleServerRequest(msg) {
  const p = msg.params ?? {}
  const t = threadOf(p)
  if (!t) {
    // 共享 daemon 的其他客户端请求不属于本站，不能代其拒绝。
    if (!sharedDaemon) send({ id: msg.id, result: { decision: 'decline' } })
    return
  }

  // MCP 工具调用：codex 在 untrusted 下用 **`mcpServer/elicitation/request`** 来征询（不是
  // commandExecution/fileChange），且响应格式是 **`{ action }`** 而非 `{ decision }`。
  // 项目 .mcp.json 声明过的 server（如 agentmail）**自动放行**——项目主动放了这份 600 配置=配置级信任，
  // 否则 bridge 全自动闭环会卡在每次 check_inbox/send 的审批上（对称于 Claude 侧 canUseTool 的 mcp__ 放行）。
  // ⚠️ 这里不能回 `{ decision }`——elicitation 协议只认 `{ action:'accept'|'decline'|'cancel' }`。
  // 命令执行 / 文件变更**不走这条**（它们是 item/commandExecution|fileChange/requestApproval），照常审批。
  if (msg.method === 'mcpServer/elicitation/request') {
    const server = p.serverName
    const ok = server && t.mcpServerNames?.has(server)
    send({ id: msg.id, result: { action: ok ? 'accept' : 'decline' } })
    if (!ok) console.log(`[mcp] 拒绝未声明的 MCP server 征询: ${server ?? '(未知)'}`)
    return
  }

  // 「全权」(approvalPolicy:never)：当前回合即便以 untrusted 起步，收到审批也直接放行，
  // 让全权对进行中的回合立即生效，而不必等下一回合 turn/start。审批/自动两档仍照常弹卡。
  if (CODEX_MODES[t.mode]?.approvalPolicy === 'never') {
    send({ id: msg.id, result: { decision: 'accept' } })
    if (t.state === 'waiting_approval' && t.pending.size === 0) t.state = 'running'
    return
  }

  const isCmd = msg.method === 'item/commandExecution/requestApproval'
  const detail = isCmd ? cleanCmd(p.command) : String(p.path ?? '文件变更')
  const action = {
    id: nid('act'), sessionId: t.id, kind: 'approval',
    title: isCmd ? '请求执行命令' : '请求修改文件',
    detail: detail.slice(0, 500),
    risk: /rm |rm -|--force|sudo |mkfs|dd /.test(detail) ? '该操作可能不可逆，请确认。' : undefined,
    createdAt: Date.now(), status: 'pending',
  }
  t.state = 'waiting_approval'
  t.summary = `${action.title}：${detail.slice(0, 50)}`
  t.pending.set(action.id, {
    action, requestId: msg.id, turnId: p.turnId,
    resolve: (resolution) => {
      action.status = 'resolved'; action.resolution = resolution
      t.pending.delete(action.id)
      const decision = resolution === '拒绝' ? 'decline'
        : resolution === '本会话始终允许' ? 'acceptForSession' : 'accept'
      send({ id: msg.id, result: { decision } })
      if (t.pending.size === 0 && t.state === 'waiting_approval') t.state = 'running'
      if (t.pending.size === 0 && !t.turnActive) void startNextQueued(t)
    },
    expire: () => {
      action.status = 'expired'; t.pending.delete(action.id)
      send({ id: msg.id, result: { decision: 'decline' } })
      if (t.pending.size === 0 && !t.turnActive) void startNextQueued(t)
    },
  })
}

// 封口:给尾部仍在流式的 assistant narration 段赋 seq。多步回合里 narration 会被工具事件
// 插断,若不在边界处封口,这些段将永远无 seq、在快照/续传中错位。
function sealAssistant(t) {
  const last = t.events[t.events.length - 1]
  if (last && last.type === 'assistant' && last._streaming) {
    delete last._streaming
    last.seq = (t.nextSeq = (t.nextSeq ?? 0) + 1)
  }
}
function pushEvent(t, e) {
  // 断线续传 seq（4.2a，纯附加）：driver 内存里单调递增，从 1 起、永不重复；
  // 400 上限的 splice 只丢旧对象，不重编号，故天然满足"曾经分配过的 seq 不复用"。
  sealAssistant(t) // 先封口尾部仍流式的 narration，保证其 seq 小于本事件（时序正确）
  e.seq = (t.nextSeq = (t.nextSeq ?? 0) + 1)
  t.events.push({ id: nid('ev'), ts: Date.now(), ...e })
  const event = t.events[t.events.length - 1]
  if (t.events.length > 400) t.events.splice(0, t.events.length - 400)
  t.lastActiveAt = Date.now()
  return event
}
function appendAssistant(t, delta, itemId) {
  let last = t.events[t.events.length - 1]
  if (!last || last.type !== 'assistant' || !last._streaming || (itemId && last._itemId && last._itemId !== itemId)) {
    sealAssistant(t)
    last = { id: nid('ev'), ts: Date.now(), type: 'assistant', text: '', _streaming: true, _itemId: itemId }
    t.events.push(last)
  }
  last.text += delta
  t.summary = last.text.slice(0, 80)
}
function finalizeAssistant(t) {
  sealAssistant(t) // 定稿即封口 → 可断线续传、边界正确
}
function onTurnEnd(t) {
  const changed = (t._changed ?? 0) - (t._reviewed ?? 0)
  if (changed > 0) {
    t._reviewed = t._changed
    const action = {
      id: nid('act'), sessionId: t.id, kind: 'review',
      title: '回合完成，待验收', detail: `${t.summary}\n${changed} 处文件变更`,
      createdAt: Date.now(), status: 'pending',
    }
    t.pending.set(action.id, {
      action,
      resolve: (r) => { action.status = 'resolved'; action.resolution = r; t.pending.delete(action.id) },
      expire: () => { action.status = 'expired'; t.pending.delete(action.id) },
    })
  }
}

// ---- 对外 API（与 driver.js 同形） ----
// Codex 推理 effort 仅 low/medium/high；Claude 的 xhigh/max 向下钳到 high
// 推理档强度序（低→高）。归一时据此找「不超过请求档的最高可用档」。
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** 把请求的 effort 归一到**该模型实际支持**的档位（supported 来自 model/list.supportedReasoningEfforts）。
 *  ⚠️ 旧实现是 `['low','medium','high'].includes(e) ? e : 'high'` —— 那是 xhigh/max/ultra 出现之前写的，
 *  于是 createSession 默认的 `effort='xhigh'` **被静默降级成 'high'**：用户要 xhigh、实际一直跑 high
 *  （2026-07-16 实测线上 codex 会话全是 effort=high 才发现）。别再写死枚举，跟着模型走。 */
export function effortForModel(effort, supported) {
  const list = supported?.length ? supported : EFFORT_ORDER
  const want = String(effort)
  if (list.includes(want)) return want
  const wi = EFFORT_ORDER.indexOf(want)
  if (wi < 0) return list.includes('high') ? 'high' : list[list.length - 1]
  for (let i = wi; i >= 0; i--) if (list.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i] // 降到最接近的可用档
  return list[0]
}

// Codex 三档审批模式（turn/start 的 approvalPolicy + sandboxPolicy「本回合及后续生效」）。
// 自动模式由原生 reviewer 审查越界请求，保留 workspace-write 沙箱；切换下一回合生效。
export const DEFAULT_CODEX_MODE = 'on-request'
const WS_SANDBOX = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
const EXTERNAL_SANDBOX=externalSandboxEnabled(process.env,fs.existsSync('/.dockerenv'))
export const CODEX_MODES = {
  untrusted: { label: '审批', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: WS_SANDBOX },
  'on-request': { label: '自动', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: WS_SANDBOX },
  never: { label: '全权', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } },
}
const turnPolicy = (mode) => {
  const m = CODEX_MODES[mode] || CODEX_MODES[DEFAULT_CODEX_MODE]
  return { approvalPolicy: m.approvalPolicy, approvalsReviewer: m.approvalsReviewer, sandboxPolicy: sandboxPolicy(m.sandboxPolicy,EXTERNAL_SANDBOX) }
}

function expireReviewActions(t) {
  for (const [aid, p] of [...t.pending]) {
    if (p.action.kind === 'review') { p.expire(); t.pending.delete(aid) }
  }
}

/**
 * 一个 Codex thread 同时只驱动一个 turn；后续输入由 queuedInputs 串行接续。
 * `input` 是 buildCodexInput() 产出的 item 数组（可含 image），不是裸文本。
 */
async function startTurn(t, input) {
  // ⚠️ 静默 return false 会被上层翻译成「会话不可写（影子会话或已结束）」——完全指错方向。
  // 2026-08-01 就栽在这：改 startTurn(t, text)→(t, input) 时漏了 sendMessage 结尾那个调用点，
  // 于是消息事件进了流、图也落了盘，回合却从未启动，而报错说的是"影子会话"。非数组=调用点漏改，必须喊出来。
  if (!Array.isArray(input)) { console.error('[codex] startTurn 收到非数组 input（调用点漏改？）:', typeof input); return false }
  if (input.length === 0) return false
  if (t.done || t.startingTurn || t.turnActive || t.pending.size > 0) return false
  t.startingTurn = true
  t.turnActive = true
  t.state = 'running'
  t.summary = '正在处理新指令…'
  t.error = undefined
  try {
    const turn = await rpc('turn/start', {
      threadId: t.id,
      input,
      ...turnPolicy(t.mode),
    })
    // 极短回合可能在 rpc response 到达前已发出 completed 通知；不要把已完成 turn 重新标活。
    if (t.turnActive) t.curTurnId = turn.turn?.id ?? t.curTurnId
    t.uncertainInflight = false // 明确拿到 turn/start 响应 → 不再不确定
    return true
  } catch (e) {
    t.turnActive = false
    t.curTurnId = null
    t.state = 'error'
    t.error = '发送失败：' + (e?.message ?? 'turn/start 超时或失败')
    t.summary = '发送失败'
    // turn/start 超时/失败：app-server 可能已受理该回合、只是响应丢了。控制面标 error，但**子进程可能仍在跑**——
    // 标 uncertainInflight，让排空/重启把它当在飞、别此刻 SIGKILL 子进程截断真实回合（CR-006 P0-2）。
    // 待收到 app-server 的 turn/completed|failed 通知（definitive）再清（见通知处理）。
    t.uncertainInflight = true
    return false
  } finally {
    t.startingTurn = false
    if (!t.turnActive && t.queuedInputs.length > 0) void startNextQueued(t)
  }
}

async function startNextQueued(t) {
  if (t.done || t.startingTurn || t.turnActive || t.submittingInputs > 0 || t.uncertainInflight || t.queuedInputs.length === 0) return
  // 排队消息等价于用户已继续对话，旧回合的“待验收”自动失效；真正的权限审批仍必须先处理。
  expireReviewActions(t)
  if (t.pending.size > 0) return
  const entry = t.queuedInputs.shift()
  const input = entry?.input ?? entry
  if (!input?.length) return
  const accepted = await startTurn(t, input)
  if (entry.event) markDelivery(t, entry.event, accepted ? 'accepted' : 'unknown')
}

export async function createSession({ cwd, prompt, resume, effort = 'xhigh', model }) {
  if (resume && threads.has(resume)) return threads.get(resume)
  if (!resume) return createSessionImpl({ cwd, prompt, effort, model })
  if (resumeJobs.has(resume)) return resumeJobs.get(resume)
  const job = createSessionImpl({ cwd, prompt, resume, effort, model })
  resumeJobs.set(resume, job)
  try { return await job } finally { resumeJobs.delete(resume) }
}

async function createSessionImpl({ cwd, prompt, resume, effort, model }) {
  if (!fs.existsSync(cwd)) throw new Error(`目录不存在: ${cwd}`)
  await ensureServer()
  const startMethod = resume ? 'thread/resume' : 'thread/start'
  // 项目 .mcp.json → 注入本 thread 的 per-thread config.mcp_servers（含该 agent 自己的身份/凭据）。
  // 与 Claude 读同一份 .mcp.json（loadProjectMcp）；.mcp.json 的 `mcpServers` 与 codex config 的
  // `mcp_servers` **同形**（每条 {command,args,env}），只是顶层键名不同，直接透传即可。
  // ⚠️ 凭据不进 ps：config 走 stdin RPC、env 进子进程 environ（实测 canary 不出现在任何进程 args）——
  // 天生比 Claude 的 --mcp-config 安全，故 codex 侧直接传 servers 对象即可，无需像 Claude 那样绕文件路径。
  const projMcp = loadProjectMcp(cwd)
  const cfg = projMcp.servers ? { config: { mcp_servers: projMcp.servers } } : {}
  // 新会话默认用 model/list 里 isDefault 的那个（= 该机 codex 的**最新前沿模型**，当前 gpt-5.6-sol）。
  // ⚠️ 不传 model 时 codex 会用 `~/.codex/config.toml` 的 `model=`（本机是 gpt-5.5）——所以看板一直显示
  // 5.5、拿不到新模型。这里显式传，让新建会话跟着"最新"走；调用方指定 model 则尊重调用方。
  // 拿不到列表（codex 未装/超时）→ 不传，退回 codex 自己的配置默认，不影响创建。
  // resume 是接续既有 thread，模型属于该 thread，不覆盖。
  const models = resume ? [] : await listLlmModels().catch(() => [])
  const wantModel = resume ? null : (model || models.find((m) => m.isDefault)?.id || null)
  const supported = models.find((m) => m.id === wantModel)?.efforts
  const eff = effortForModel(effort, supported) // 按该模型实际支持的档归一（旧 clamp 会把 xhigh 打成 high）
  const baseParams = resume
    ? (sharedDaemon ? { threadId: resume, excludeTurns: false } : { threadId: resume, cwd, approvalPolicy: DEFAULT_CODEX_MODE, approvalsReviewer: 'auto_review', sandbox: EXTERNAL_SANDBOX?'danger-full-access':'workspace-write', ...cfg })
    : { cwd, approvalPolicy: DEFAULT_CODEX_MODE, approvalsReviewer: 'auto_review', sandbox: EXTERNAL_SANDBOX?'danger-full-access':'workspace-write', ...cfg, ...(wantModel ? { model: wantModel } : {}) }
  // 带 effort 起 thread；若 app-server 不认该参数则回退，避免创建失败
  let result
  if (resume) restoringMessages.set(resume, [])
  try { result = await rpc(startMethod, { ...baseParams, model_reasoning_effort: eff }) }
  catch (error) {
    if (!/invalid param|unknown field|unrecognized.*model_reasoning_effort/i.test(error.message)) {
      restoringMessages.delete(resume)
      if (/already has an active writer/i.test(error.message)) throw new Error('该会话仍由另一个 Codex 服务持有，请先在原终端退出该会话后再恢复；不会强制中断或删除写锁。')
      throw error
    }
    try { result = await rpc(startMethod, baseParams) }
    catch (retryError) { restoringMessages.delete(resume); throw retryError }
  }
  const threadId = result.thread?.id
  if (!threadId) { restoringMessages.delete(resume); throw new Error('codex thread 创建失败') }
  const record = {
    id: threadId, threadId, realSessionId: threadId, resumedFrom: resume ?? null,
    cwd, project: path.basename(cwd), branch: '', engine: 'codex',
    model: prettyModel(result.model), effort: result.reasoningEffort || eff,
    mode: CODEX_MODES[result.approvalPolicy] ? result.approvalPolicy : DEFAULT_CODEX_MODE,
    state: prompt ? 'running' : 'idle', summary: prompt ? prompt.slice(0, 80) : '已接管，等待指令…',
    // 归属线索（P0 #6）同 driver.js：首个 prompt 前 120 字，创建后恒不变，不随后续回合的
    // `summary`/`t.summary` 一起被覆写。
    firstPrompt: prompt ? prompt.trim().slice(0, 120) : '',
    startedAt: Date.now(), lastActiveAt: Date.now(), cost: 0, tokens: 0, origin: 'platform',
    tok: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    mcpServerNames: projMcp.names, // 项目声明的 MCP server 名（审批路径据此自动放行其工具）
    events: [], todos: [], fileChanges: [], pending: new Map(), curTurnId: null,
    queuedInputs: [], startingTurn: false, turnActive: false, done: false, submittingInputs: 0,
  }
  threads.set(threadId, record)
  if (sharedDaemon) reconnectRegistry.remember(record)
  if (resume && result.thread?.status?.type === 'active') {
    const activeTurn = result.thread.turns?.find(turn => turn.status === 'inProgress')
    record.turnActive = true
    record.curTurnId = activeTurn?.id ?? null
    record.state = result.thread.status.activeFlags?.includes('waitingOnApproval') ? 'waiting_approval' : 'running'
    record.summary = '已连接原会话，正在同步进行中的任务…'
  }
  const buffered = restoringMessages.get(resume) ?? []
  restoringMessages.delete(resume)
  for (const line of buffered) handleMessage(line)
  if (prompt) {
    pushEvent(record, { type: 'user', text: prompt })
    await startTurn(record, buildCodexInput(prompt, []))
  }
  return record
}

export function realSessionIds() {
  return new Set([...threads.keys()])
}

/** BrightPath 契约：最后一条 file_op 事件摘要 { ts, verb, path }，无则 null */
function lastEventOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'file_op' && e.verb) return { ts: e.ts, verb: e.verb, path: e.path ?? '' }
  }
  return null
}

export function listSessions() {
  const independent = sharedDaemon && daemonSocketPath && independentDaemon(daemonSocketPath, { daemonPid })
  daemonPid = independent?.pid || null
  return [...threads.values()].map((t) => {
    // 真命令/文件审批(kind:approval) 阻塞在飞回合；回合后的 review 待办不阻塞（回合已结束、可恢复）。
    const hasApproval = [...t.pending.values()].some((p) => p.action.kind === 'approval')
    return {
    id: t.id, project: t.project, branch: t.branch, engine: 'codex', model: t.model,
    effort: t.effort,
    firstPrompt: t.firstPrompt || '',
    mode: t.mode, state: hasApproval ? 'waiting_approval' : t.state,
    queuedMessages: t.queuedInputs.length,
    supportsSteering: true,
    // inflight=回合真正在飞、agent 重启即截断的：turn 进行中 / 正在起 turn / turn/start 超时未获确认
    // (app-server 可能已受理，见 startTurn catch) / 有真审批阻塞回合。review 待办不算（CR-006 P1-b/P0-2）。
    inflight: !!(t.turnActive || t.startingTurn || t.submittingInputs || t.uncertainInflight || hasApproval),
    // Keep execution state truthful; restart safety is a separate property.
    restartSafe: !!(independent && reconnectRegistry.has(t.id) && !t.done
      && !t.startingTurn && !t.submittingInputs && !t.uncertainInflight && t.queuedInputs.length === 0),
    summary: t.pending.size > 0
      ? `${t.summary}${t.queuedInputs.length ? ` · 已排队 ${t.queuedInputs.length} 条消息` : ''}`
      : t.summary,
    // startedAt 必须投影出去：thread 记录里有（createSession 设 Date.now()），但此前漏在
    // 线协议外——于是每个 Codex 平台会话的 startedAt 都缺，前端 duration() 拿到 undefined
    // 渲染成「NaNd」（2026-07-21 实拍，一个崩溃的 Codex 会话顶栏时长 NaNd）。Claude 侧一直有。
    startedAt: t.startedAt,
    lastActiveAt: t.lastActiveAt, cost: 0, tokens: t.tokens, origin: 'platform',
    tokensBreakdown: { ...(t.tok ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }) },
    realSessionId: t.realSessionId, resumedFrom: t.resumedFrom,
    cwd: t.cwd,
    error: t.error,
    lastEvent: lastEventOf(t.events),
    todoStats: {
      done: t.todos.filter((x) => x.status === 'done').length,
      active: t.todos.filter((x) => x.status === 'active').length,
      total: t.todos.length,
    },
    }
  })
}

export function pendingActions() {
  const out = []
  for (const t of threads.values()) for (const { action } of t.pending.values()) out.push(action)
  return out
}

export function getEvents(id) {
  const t = threads.get(id)
  if (!t) return null
  return {
    events: t.events.map(({ _streaming, _itemId, ...e }) => (_streaming ? { ...e, streaming: true } : e)),
    fileChanges: t.fileChanges, todos: t.todos,
    messageReceipts: Object.fromEntries(t.messageReceipts ?? []),
    // 断线续传（4.2a，纯附加）：当前窗口内 seq 边界，供 4.2b 帧协议判断续传/reset。
    // 用 seqBounds 而非首尾直取——最后一条可能是未定稿(seq-less)的流式 assistant 消息。
    ...seqBounds(t.events),
  }
}

function markDelivery(t, event, delivery, reason) {
  event.delivery = delivery
  event.deliveryReason = reason
  // Receipts are metadata updates. Changing an event's durable seq would duplicate it in history.
  t.messageReceipts ??= new Map()
  t.messageReceipts.delete(event.id)
  t.messageReceipts.set(event.id, { delivery, ...(reason ? { reason } : {}) })
  if (t.messageReceipts.size > 16) t.messageReceipts.delete(t.messageReceipts.keys().next().value)
}

async function syncActiveTurn(t) {
  const result = await rpc('thread/read', { threadId: t.id, includeTurns: true })
  const active = result.thread?.turns?.find(turn => turn.status === 'inProgress')
  if (active) { t.turnActive = true; t.curTurnId = active.id }
  else if (result.thread?.status?.type === 'idle') { t.turnActive = false; t.curTurnId = null }
}

function queueInput(t, input, event, reason) {
  t.queuedInputs.push({ input, event })
  markDelivery(t, event, 'queued', reason)
  if (t.pending.size > 0) {
    t.state = 'waiting_approval'
    t.summary = `等待处理 ${t.pending.size} 个审批`
  } else {
    t.state = 'running'
    t.summary = `当前回合处理中 · 已排队 ${t.queuedInputs.length} 条消息`
  }
  return { ok: true, delivery: 'queued', queued: true, queueDepth: t.queuedInputs.length, ...(reason ? { reason } : {}) }
}

/** Serialize submissions, not model turns. Steering goes straight to the active native turn. */
export async function submitMessage(id, text, images = [], { behavior = 'steer' } = {}) {
  const t = threads.get(id)
  if (!t || t.done) return { ok: false, status: 409, error: '会话不可写（影子会话或已结束）' }
  if (!['steer', 'queue'].includes(behavior)) return { ok: false, status: 400, error: '消息方式必须为 steer 或 queue' }
  const input = buildCodexInput(text, images)
  if (!input.length) return { ok: false, status: 400, error: '消息内容不能为空' }
  const generation = t.inputGeneration ?? 0
  t.submittingInputs++
  const job = (t.inputSubmission ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (t.done) return { ok: false, status: 409, error: '会话已结束' }
    if ((t.inputGeneration ?? 0) !== generation) return { ok: false, status: 409, error: '输入已取消' }
    expireReviewActions(t)
    const savedImgs = saveSessionImages(id, images)
    const event = pushEvent(t, { type: 'user', text, messageBehavior: behavior, delivery: 'sending',
      imageCount: (Array.isArray(images) ? images.length : 0) || undefined,
      images: savedImgs.length ? savedImgs : undefined })
    try {
      if (t.uncertainInflight) throw new Error('上一条输入的送达状态尚未确认')
      if (behavior === 'steer' && t.turnActive) {
        if (!t.curTurnId) await syncActiveTurn(t)
        if ((t.inputGeneration ?? 0) !== generation) {
          markDelivery(t, event, 'cancelled')
          return { ok: false, status: 409, error: '输入已取消' }
        }
        if (t.turnActive && t.curTurnId) {
          const expectedTurnId = t.curTurnId
          try {
            const result = await rpc('turn/steer', { threadId: t.id, expectedTurnId, input })
            if (result.turnId !== expectedTurnId) throw new Error('即时补充回执的回合ID不匹配')
            markDelivery(t, event, 'steered')
            return { ok: true, delivery: 'steered', queued: false, queueDepth: t.queuedInputs.length }
          } catch (error) {
            if ((t.inputGeneration ?? 0) !== generation) {
              markDelivery(t, event, 'cancelled')
              return { ok: false, status: 409, error: '输入已取消' }
            }
            const unsupported = error.rpcCode === -32601 || /method not found|unknown method/i.test(error.message)
            const ended = /no active turn|not.*active turn|expected.*turn.*(?:match|mismatch)|turn.*(?:not active|already.*(?:ended|completed)|mismatch)/i.test(error.message)
            if (unsupported) return queueInput(t, input, event, '当前 Codex 不支持即时补充，已改为排队')
            if (!ended) throw error
            // An explicit rejection means this input was NOT accepted. Never steer a different turn.
            await syncActiveTurn(t).catch(() => {})
            if ((t.inputGeneration ?? 0) !== generation || t.done) {
              markDelivery(t, event, (t.inputGeneration ?? 0) !== generation ? 'cancelled' : 'failed')
              return { ok: false, status: 409, error: '会话已中断或断开，补充未发送' }
            }
            return queueInput(t, input, event, '原回合已结束，作为后续输入处理')
          }
        }
      }
      if (t.startingTurn || t.turnActive || t.pending.size > 0 || t.queuedInputs.length > 0) return queueInput(t, input, event)
      const accepted = await startTurn(t, input)
      markDelivery(t, event, accepted ? 'accepted' : 'unknown')
      return accepted ? { ok: true, delivery: 'accepted', queued: false, queueDepth: 0 }
        : { ok: false, status: 504, indeterminate: true, error: t.error || '发送结果待确认' }
    } catch (error) {
      const confirmedRejection = error.rpcCode != null
      markDelivery(t, event, confirmedRejection ? 'failed' : 'unknown')
      if (!confirmedRejection) t.uncertainInflight = true // No automatic resend after a lost acknowledgement.
      return { ok: false, status: confirmedRejection ? 409 : 504, indeterminate: !confirmedRejection,
        error: confirmedRejection ? `发送被拒绝：${error.message}` : '补充信息送达状态待确认，请勿重复发送' }
    }
  })
  t.inputSubmission = job
  try { return await job } finally {
    t.submittingInputs--
    if (!t.turnActive) void startNextQueued(t)
  }
}

export async function sendMessage(id, text, images = [], options = {}) {
  return (await submitMessage(id, text, images, options)).ok
}

export async function interrupt(id) {
  const t = threads.get(id)
  if (!t) return false
  t.inputGeneration = (t.inputGeneration ?? 0) + 1
  for (const entry of t.queuedInputs) if (entry.event) markDelivery(t, entry.event, 'cancelled')
  // 先清队列，防最后一个审批 expire 时触发 startNextQueued，造成“中断后反而启动下一回合”。
  t.queuedInputs.length = 0
  for (const p of [...t.pending.values()]) p.expire()
  if (t.curTurnId) { try { await rpc('turn/interrupt', { threadId: id, turnId: t.curTurnId }) } catch { /* 已结束 */ } }
  t.turnActive = false
  t.startingTurn = false
  t.curTurnId = null
  t.state = 'idle'; t.summary = '已被用户中断'
  return true
}

export async function setMode(id, mode) {
  const t = threads.get(id)
  if (!t || !CODEX_MODES[mode]) return false
  t.mode = mode // 下一回合 turn/start 带上对应 approvalPolicy/sandboxPolicy 生效
  if (sharedDaemon) reconnectRegistry.remember(t)
  return true
}
// Codex 模型列表（app-server `model/list`，需带 params={}，否则报 missing field `params`）。
// 短命 app-server 查一次即杀，缓存 5min——模型列表几乎不变，且看板/新建页在无会话时也要用。
// 返回 [{ id, displayName, efforts:[...], isDefault }]，只保留 hidden=false 的。
let codexModelsMemo = { ts: 0, value: [] }
export function liveModels(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let p = null, done = false, lid = 0
    const pend = new Map()
    const finish = (v) => { if (done) return; done = true; clearTimeout(to); try { p?.kill('SIGKILL') } catch { /* ignore */ } resolve(v) }
    const to = setTimeout(() => finish([]), timeoutMs)
    try { p = spawn(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return finish([]) }
    const w = (o) => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n') } catch { /* ignore */ } }
    const call = (method, params) => new Promise((res) => { const i = ++lid; pend.set(i, res); w({ id: i, method, params }) })
    p.on('error', () => finish([]))
    p.stderr.on('data', () => { /* ignore */ })
    readline.createInterface({ input: p.stdout }).on('line', (ln) => {
      if (!ln.trim()) return
      let m; try { m = JSON.parse(ln) } catch { return }
      if (m.id != null && pend.has(m.id)) { const r = pend.get(m.id); pend.delete(m.id); r(m.error ? null : m.result) }
    })
    ;(async () => {
      await call('initialize', { clientInfo: { name: 'agent-console', title: 'Agent Console', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      w({ method: 'initialized' })
      const r = await call('model/list', {}) // ⚠️ params 必须给 {}，null 会报 missing field `params`
      const models = (r?.data ?? []).filter((m) => m && !m.hidden).map((m) => ({
        id: m.id, displayName: m.displayName || m.id,
        efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
        isDefault: !!m.isDefault,
      }))
      finish(models)
    })().catch(() => finish([]))
  })
}
export async function listLlmModels() {
  if (Date.now() - codexModelsMemo.ts < 300_000 && codexModelsMemo.value.length) return codexModelsMemo.value
  const models = await liveModels().catch(() => [])
  if (models.length) codexModelsMemo = { ts: Date.now(), value: models }
  return models.length ? models : codexModelsMemo.value
}

// 切模型：thread/settings/update 的 model 字段，下一回合生效（与 effort 同机制）。
// ⚠️ app-server **不校验** model——传 'gpt-9-nope' 也回 ok（实测），故这里**必须自校验**
// （拿 model/list 比对），否则会静默"切成功"、下一回合真发时才失败。
export async function setLlmModel(id, model) {
  const t = threads.get(id)
  if (!t || t.done) return false
  const models = await listLlmModels().catch(() => [])
  if (!models.some((m) => m.id === String(model))) return false // 非法/未知模型：拒绝，别信服务端的 ok
  try {
    await rpc('thread/settings/update', { threadId: t.threadId, model: String(model) })
    t.model = prettyModel(model)
    t.lastActiveAt = Date.now()
    return true
  } catch { return false }
}

// Codex 运行时推理档位：app-server `thread/settings/update` 的 effort 枚举（已实测 unknown-variant 报错
// 反查得到）：none/minimal/low/medium/high/xhigh。此处对外只放常用五档（略去 none=不推理）。
// 与 Claude 的 setEffort 一样「下一回合生效」，但 Codex 走 thread/settings/update 持久化到该 thread。
// 各模型上报的推理档（model/list.supportedReasoningEfforts）：gpt-5.6-sol 有 max/ultra，
// 老模型只到 xhigh。这里是**校验用的并集**（服务端对 effort 也偏宽松）；前端按当前模型 model/list
// 给出各自可选档，不会给 gpt-5.5 放出它不支持的 ultra。'minimal' 已从所有模型消失，去掉。
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export async function setLlmEffort(id, effort) {
  const t = threads.get(id)
  if (!t || t.done) return false
  if (!CODEX_EFFORTS.includes(String(effort))) return false
  try {
    await rpc('thread/settings/update', { threadId: t.threadId, effort: String(effort) })
    t.effort = String(effort)
    t.lastActiveAt = Date.now()
    return true
  } catch { return false }
}

export function resolveAction(actionId, resolution) {
  for (const t of threads.values()) {
    const p = t.pending.get(actionId)
    if (p) { p.resolve(resolution); t.lastActiveAt = Date.now(); return true }
  }
  return false
}

/** 某 pending action 的类型（approval/review），无则 null。排空期用于放行审批、拒绝会触发出队新回合的 review（CR-006 P1-c）。 */
export function actionKind(actionId) {
  for (const t of threads.values()) {
    const p = t.pending.get(actionId)
    if (p) return p.action.kind
  }
  return null
}

export async function release(id) {
  const t = threads.get(id)
  if (!t) return null
  t.inputGeneration = (t.inputGeneration ?? 0) + 1
  t.done = true
  t.queuedInputs.length = 0
  for (const p of [...t.pending.values()]) p.expire()
  if (t.curTurnId) { try { await rpc('turn/interrupt', { threadId: id, turnId: t.curTurnId }) } catch { /* ignore */ } }
  threads.delete(id)
  reconnectRegistry.forget(id)
  return { realId: t.realSessionId }
}

/** Rejoin only identities previously managed by this agent. Never submit input. */
export async function restoreManagedSessions() {
  const records = reconnectRegistry.list()
  if (!records.length) return
  const socket = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'app-server-control/app-server-control.sock')
  if (process.env.CODEX_BIN || !fs.existsSync(socket)) {
    console.warn('[codex-reconnect] daemon unavailable; identities retained for a later retry')
    return
  }
  for (const saved of records) {
    if (threads.has(saved.id)) continue
    try {
      const record = await createSession({ cwd: saved.cwd, resume: saved.id })
      if (CODEX_MODES[saved.mode]) record.mode = saved.mode
      if (saved.startedAt) record.startedAt = saved.startedAt
      reconnectRegistry.remember(record)
      console.log(`[codex-reconnect] restored ${saved.id} (${record.state})`)
    } catch (error) { console.error(`[codex-reconnect] ${saved.id}: ${error.message}`) }
  }
}
