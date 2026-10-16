// 平台会话驱动器（P0 交互版）：用 Claude Agent SDK 拉起/驱动会话，
// canUseTool 回调把权限请求转为结构化待办，等 Web/收件箱 allow/deny。
import { WORKER_SLICE, sliceIsolationEnabled } from './spawn-in-slice.js'
import { creditUsage } from './usage-dedupe.js'
import { resolveClaudeBin } from './claude-bin.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { sessionStore, findClaudeJsonlByRealId } from './session-store.js'
import { loadProjectMcp } from './mcp-config.js'

// 上传图片落盘（功能：会话归档到 KB 需要截图，但平台会话的 base64 仅喂给 SDK、不落盘）。
// 存到 ~/.web-agents/attachments/<sessionId>/<sha>.<ext>，事件记 {name,media_type} 引用。
// 跨本地(/data)与远端(/opt)布局一致，故用 homedir 而非硬编码安装目录。
const ATTACH_ROOT = path.join(os.homedir(), '.web-agents', 'attachments')
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const MT_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export function saveSessionImages(id, images = []) {
  const saved = []
  for (const img of images) {
    if (!img?.data || !img?.media_type) continue
    try {
      const dir = path.join(ATTACH_ROOT, id)
      fs.mkdirSync(dir, { recursive: true })
      const sha = crypto.createHash('sha1').update(img.data).digest('hex').slice(0, 12)
      const name = `${sha}.${IMG_EXT[img.media_type] || 'png'}`
      fs.writeFileSync(path.join(dir, name), Buffer.from(img.data, 'base64'))
      saved.push({ name, media_type: img.media_type })
    } catch { /* 落盘失败不阻断发送 */ }
  }
  return saved
}
/** 读取某会话已存截图为 base64（归档用）；返回 [{name, media_type, base64}]。 */
/**
 * 按 (会话 id, 文件名) 取落盘的上传图片 → { buf, mediaType }。
 *
 * 为什么需要它：`/api/session/:id/image/:eventId/:idx` 原本只从**事件里的内联 base64** 取图，
 * 而那条路只对 Claude 成立——它的用户消息带图写进了 JSONL。Codex/Kimi 的事件活在 driver 内存里，
 * 事件上只有 `images:[{name,media_type}]`、没有 base64 ⇒ findImage 必然落空 ⇒ 气泡里是碎图。
 * （2026-08-01 给 Codex 加图片输入时实测到，Kimi 同源。）
 */
export function readSessionImageFile(id, name) {
  // name 来自事件，仍按不可信处理：只允许纯文件名，挡住 ../ 穿越
  if (!id || !name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  try {
    const buf = fs.readFileSync(path.join(ATTACH_ROOT, id, name))
    const ext = path.extname(name).slice(1).toLowerCase()
    return { buf, mediaType: MT_BY_EXT[ext] || 'application/octet-stream' }
  } catch { return null }
}

export function readSessionImages(id) {
  const out = []
  try {
    for (const name of fs.readdirSync(path.join(ATTACH_ROOT, id))) {
      try {
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        const base64 = fs.readFileSync(path.join(ATTACH_ROOT, id, name)).toString('base64')
        out.push({ name, media_type: MT_BY_EXT[ext] || 'image/png', base64 })
      } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 无目录 */ }
  return out
}

// claude CLI 路径 —— 解析逻辑在 claude-bin.js（纯函数 + 单测）。
//
// ⚠️ **别改回 `candidates.find(fs.existsSync)`**（2026-08-21 线上）：177-188 上
// /root/.nvm/.../bin/claude **存在但跑不起来**（native binary 未安装），而同机好用的
// /usr/bin/claude 当时根本不在候选表里 ⇒ 稳稳选中坏的 ⇒ 每次建会话都
// `exited with code 1`，SDK 把 stderr 吞掉、日志一个字没有，排查了一小时。
// 判存在是最弱的判据，**能跑才算数**。
const CLAUDE_REAL_BIN = resolveClaudeBin()
if (CLAUDE_REAL_BIN) console.warn(`[claude] CLI: ${CLAUDE_REAL_BIN}`)

// ---------- worker cgroup 隔离（isolate-control-plane-cgroups） ----------
//
// 实测故障（2026-08-13）：控制面与会话子进程挤在同一个 cgroup，两个 claude 子进程就占 705MB，
// 把 agent.js 一起拖进 memory.high 节流 ⇒ 端口在听但完全不 accept、oom_kill=0、日志无痕。
//
// Claude 侧的难点：子进程由 SDK 内部 spawn，我们碰不到那次 spawn。唯一的挂钩是
// `pathToClaudeCodeExecutable` —— 于是**在启动时生成一个包装脚本**，让 SDK 去执行它，
// 由它把真正的 claude 放进 worker slice。
//
// ★ 为什么生成而不是随部署下发一个固定脚本：真实 claude 路径因机而异（.local/bin、nvm 各版本…），
//   固定脚本与 findClaude() 的结果一旦不一致就会静默指向错误的二进制。生成能保证两者永远同源。
//
// 已实测：`systemd-run --scope` 保留 stdio 管道、透传退出码、落进指定 slice。
function makeSliceWrapper(realBin) {
  if (!realBin || !sliceIsolationEnabled()) return realBin
  try {
    const dir = path.join(os.homedir(), '.web-agents')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const wrapper = path.join(dir, 'claude-in-slice.sh')
    // `--` 分隔必须有：claude 的参数里全是 --flag，没有它会被 systemd-run 吃掉。
    const body = `#!/bin/sh\n`
      + `# 由 server/driver.js 在启动时生成——不要手工编辑，改动会在下次 agent 启动时被覆盖。\n`
      + `# 作用：把 claude 子进程放进 ${WORKER_SLICE}，使其内存不计入控制面的 cgroup 记账。\n`
      + `exec systemd-run --scope --quiet --collect --slice=${WORKER_SLICE} -- ${JSON.stringify(realBin)} "$@"\n`
    fs.writeFileSync(wrapper, body, { mode: 0o700 })
    return wrapper
  } catch (e) {
    // 生成失败就退回真实二进制：会话照常能起，只是没被隔离。必须喊出来——
    // 静默降级的后果是隔离失效而外表完全正常，直到下一次节流才发现。
    console.error(`[slice] 生成 claude 包装脚本失败（${e?.message}）——本机 claude 子进程未被隔离`)
    return realBin
  }
}
const CLAUDE_BIN = makeSliceWrapper(CLAUDE_REAL_BIN)

let seq = 0
const nid = (p) => `${p}-${Date.now().toString(36)}-${++seq}`

function makeQueue() {
  const items = []
  let notify = null
  let ended = false
  return {
    push(v) { if (!ended) { items.push(v); notify?.() } },
    end() { ended = true; notify?.() },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift()
        if (ended) return
        await new Promise((r) => { notify = r })
        notify = null
      }
    },
  }
}

const sessions = new Map() // id -> record

function approvalTitle(toolName, input) {
  switch (toolName) {
    case 'Bash': return { title: `请求执行命令`, detail: String(input.command ?? '').slice(0, 500), context: input.description ?? '' }
    case 'Write': return { title: `请求写入文件`, detail: String(input.file_path ?? ''), context: '' }
    case 'Edit': return { title: `请求编辑文件`, detail: String(input.file_path ?? ''), context: '' }
    case 'WebFetch': return { title: `请求访问网页`, detail: String(input.url ?? ''), context: '' }
    default: return { title: `请求使用工具 ${toolName}`, detail: JSON.stringify(input).slice(0, 300), context: '' }
  }
}

// effort 档位 → 思考 token 预算（句柄只暴露 setMaxThinkingTokens，用它做动态档位映射）
const EFFORT_THINKING = { low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 60000 }
const EFFORT_LEVELS = Object.keys(EFFORT_THINKING)
const normEffort = (e) => (EFFORT_LEVELS.includes(String(e)) ? String(e) : 'xhigh')

// 把 driver 内存 record 的「瘦身份层」落到本地 store（session-durability Phase 1a）。
// 只写恢复所需字段，绝不写 prompt/事件/图片。immediate 见调用点注释。
function persistRecord(r, immediate = false) {
  // release() 会先 sessions.delete(id) 再 sessionStore.remove(id)；此后异步生成器收尾若再触发 persist，
  // 不能把已释放的会话重新写回 store。以"driver 是否仍跟踪该会话"为准，杜绝 release 后被复活的竞态。
  if (!sessions.has(r.id)) return
  sessionStore.upsert({
    psId: r.id,
    realSessionId: r.realSessionId,
    cwd: r.cwd,
    engine: 'claude',
    model: r.model,
    mode: r.mode,
    jsonlPath: r.realSessionId ? findClaudeJsonlByRealId(r.cwd, r.realSessionId) : null,
    createdAt: r.startedAt,
    lastActiveAt: r.lastActiveAt,
    lastState: r.state,
    hadPending: r.pending.size > 0,
  }, { immediate })
}

export function createSession({ cwd, mode = 'auto', prompt, resume, model, effort = 'xhigh', id: wantId }) {
  if (!fs.existsSync(cwd)) throw new Error(`目录不存在: ${cwd}`)
  // 幂等（Phase 1b reattach）：① 指定 psId 已存在 → 返回现有，恢复后 URL 不变且不重复拉起；
  // ② 同一 realId 已被别的会话续接 → 返回它，杜绝两个 SDK 同时 `--resume` 同一原生会话造成双写损坏。
  if (wantId && sessions.has(wantId)) return sessions.get(wantId)
  if (resume) { const ex = [...sessions.values()].find((r) => r.resumedFrom === resume); if (ex) return ex }
  const id = wantId || nid('ps')
  const projMcp = loadProjectMcp(cwd) // { servers, names }：项目 .mcp.json 的 MCP 配置（放在幂等返回之后，避免重复读/重复日志）
  const queue = makeQueue()
  const record = {
    id,
    realSessionId: resume ?? null,
    resumedFrom: resume ?? null,
    cwd,
    project: path.basename(cwd),
    branch: '',
    engine: 'claude',
    model: '',
    effort: normEffort(effort),
    mode,
    state: prompt ? 'running' : 'idle',
    summary: prompt ? prompt.slice(0, 80) : '已接管，等待指令…',
    // 归属线索（P0 #6）：首个 prompt 的前 120 字，创建后恒不变（`summary` 会被后续回合反复覆写，
    // 到出现待办时早已不是"这是谁派的活"的信号了）。接管场景 prompt 为空，留空——归属回退到
    // pending-digest.js 的"会话创建时间"那一半信号，不强行伪造。
    firstPrompt: prompt ? prompt.trim().slice(0, 120) : '',
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    cost: 0,
    tokens: 0,
    tok: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, // token 四桶（真实总量 = 四项和）
    origin: 'platform',
    events: [],
    todos: [],
    fileChanges: [],
    pending: new Map(),       // actionId -> {action, resolve}
    autoAllow: new Set(),     // 本会话始终允许的工具名
    mcpServerNames: projMcp.names, // 项目 .mcp.json 声明的 MCP server 名（用于自动放行其工具）
    queue,
    handle: null,
    done: false,
  }
  sessions.set(id, record)

  // 平台会话瘦身份持久化（session-durability Phase 1a）：委托模块级 persistRecord，
  // immediate=true 用于关键字段（realSessionId 到达 / pending 变更 / 初次创建），确保崩溃窗口不丢恢复键。
  const persist = (immediate = false) => persistRecord(record, immediate)
  persist(true) // 初次登记身份（此时 realSessionId 仍为 null，待 system init 补齐）

  const pushEvent = (e) => {
    record.events.push({ id: nid('ev'), ts: Date.now(), ...e })
    if (record.events.length > 400) record.events.splice(0, record.events.length - 400)
    record.lastActiveAt = Date.now()
  }

  if (prompt) pushEvent({ type: 'user', text: prompt })

  const canUseTool = async (toolName, input) => {
    if (record.autoAllow.has(toolName)) return { behavior: 'allow', updatedInput: input }

    // 项目 .mcp.json 声明的 MCP server 的工具（名形如 mcp__<server>__<tool>）自动放行——
    // 项目主动放了这份 600 的 .mcp.json = 配置级信任（等同于把凭据放进去），否则 bridge 全自动闭环
    // 会卡在每一次 check_inbox/send 的审批卡上（验收 §6「全程无人手工介入」）。
    // 只放行**本项目声明过的** server，且仅限 MCP 工具——Bash/Write/Edit 等一律照常走下面的 canUseTool。
    if (toolName.startsWith('mcp__') && record.mcpServerNames.size) {
      const server = toolName.slice(5).split('__')[0]
      if (record.mcpServerNames.has(server)) return { behavior: 'allow', updatedInput: input }
    }

    // plan 模式产出计划 -> 计划待确认（ExitPlanMode 的 plan 字段即计划全文）
    if (toolName === 'ExitPlanMode') {
      const action = {
        id: nid('act'), sessionId: id, kind: 'plan',
        title: '计划待确认',
        detail: String(input.plan ?? '').slice(0, 4000),
        createdAt: Date.now(), status: 'pending',
      }
      record.state = 'waiting_input'
      record.summary = '计划待确认'
      return new Promise((resolve) => {
        record.pending.set(action.id, {
          action,
          resolve: (resolution) => {
            action.status = 'resolved'
            action.resolution = resolution
            record.pending.delete(action.id)
            persist(true) // 待办清空 → hadPending 落盘
            if (resolution === '打回修改') {
              record.state = 'running'
              record.summary = '计划被打回，修改中…'
              resolve({ behavior: 'deny', message: '用户打回了计划，请根据上下文调整后重新提交' })
            } else {
              record.state = 'running'
              record.summary = '计划已批准，开始执行…'
              resolve({ behavior: 'allow', updatedInput: input })
            }
          },
          expire: () => { action.status = 'expired'; record.pending.delete(action.id); resolveSafely() },
        })
        persist(true) // 计划待办已挂起 → 立即记 hadPending，防崩溃窗口丢失
        const resolveSafely = () => resolve({ behavior: 'deny', message: '会话被中断' })
      })
    }

    const meta = approvalTitle(toolName, input)
    const dangerous = /rm |rm -|drop |--force|sudo |chmod |mkfs|dd |:>|truncate |git push|reset --hard/.test(meta.detail)
    // auto 模式：安全操作自动放行（危险操作仍走审批）；acceptEdits：文件编辑自动放行。让"默认 auto"真正顺畅。
    if (
      (record.mode === 'auto' && !dangerous) ||
      (record.mode === 'acceptEdits' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName))
    ) {
      record.state = 'running'
      return { behavior: 'allow', updatedInput: input }
    }
    const action = {
      id: nid('act'),
      sessionId: id,
      kind: 'approval',
      title: meta.title,
      detail: meta.detail,
      context: meta.context,
      risk: dangerous ? '该操作可能不可逆，请确认命令影响范围。' : undefined,
      toolName,
      createdAt: Date.now(),
      status: 'pending',
    }
    record.state = 'waiting_approval'
    record.summary = `${meta.title}：${meta.detail.slice(0, 60)}`
    return new Promise((resolve) => {
      const settle = (resolution) => {
        action.status = 'resolved'
        action.resolution = resolution
        record.pending.delete(action.id)
        persist(true) // 审批清空 → hadPending 落盘
        if (record.state === 'waiting_approval' && record.pending.size === 0) record.state = 'running'
        if (resolution === '拒绝') {
          record.summary = `已拒绝：${meta.detail.slice(0, 60)}`
          resolve({ behavior: 'deny', message: '用户在管控台拒绝了该操作' })
        } else {
          if (resolution === '本会话始终允许') record.autoAllow.add(toolName)
          record.summary = '已批准，继续执行…'
          resolve({ behavior: 'allow', updatedInput: input })
        }
      }
      record.pending.set(action.id, {
        action,
        resolve: settle,
        expire: () => settle('拒绝'),
      })
      persist(true) // 审批待办已挂起 → 立即记 hadPending
    })
  }

  const q = query({
    prompt: queue,
    options: {
      cwd,
      // 只有 plan 用 SDK 原生模式；auto/acceptEdits/default 一律传 'default'，确保 canUseTool 必被调用，
      // 由我们在 canUseTool 里按 record.mode 决策(auto 放行安全/拦危险、acceptEdits 放行编辑)。
      // 注意：直接传 'auto' 给 SDK 会被当成未知模式而绕过 canUseTool → 危险命令也自动跑，故不能透传。
      permissionMode: mode === 'plan' ? 'plan' : 'default',
      canUseTool,
      includePartialMessages: true, // 开启 token 级流式（stream_event），前端逐字呈现
      disallowedTools: ['AskUserQuestion'],
      effort: record.effort, // 默认 xhigh；起会话即生效
      // 项目 .mcp.json 的 MCP（含各 agent 自己的身份/凭据）。
      // ⚠️ **必须传文件路径，不能传内联对象**：SDK 的 `mcpServers` 选项会被拼成 `--mcp-config <明文JSON>`
      //    CLI 参数，`ps -ewwo args` 里凭据(AGENTMAIL_PASS 等)全裸奔（观测 2699 实测；agent_mail 红线：凭据不进 ps/日志）。
      //    改用 `extraArgs:{'mcp-config': <路径>}` → CLI 只拿到路径，600 文件里的凭据不进进程表。
      //    `strictMcpConfig` → 只认这份配置，不再吸收用户级 ~/.claude 的 MCP，launched agent 更确定。
      //    **不**用 settingSources:['project']——那会加载项目权限 allowlist 并绕过 canUseTool（见 mcp-config.js 注释）。
      ...(projMcp.path ? { extraArgs: { 'mcp-config': projMcp.path }, strictMcpConfig: true } : {}),
      ...(resume ? { resume } : {}),
      ...(model ? { model } : {}),
      ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
    },
  })
  record.handle = q
  if (prompt) {
    queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null, session_id: '' })
  }

  ;(async () => {
    // 流式 assistant 事件：token 增量边到边累积，最终消息到达时收尾（避免与完整消息重复）
    let streamingEv = null
    const appendDelta = (delta) => {
      if (!delta) return
      if (!streamingEv) {
        streamingEv = { id: nid('ev'), ts: Date.now(), type: 'assistant', text: '', streaming: true }
        record.events.push(streamingEv)
        if (record.events.length > 400) record.events.splice(0, record.events.length - 400)
      }
      streamingEv.text += delta
      record.summary = streamingEv.text.trim().slice(0, 80)
      record.lastActiveAt = Date.now()
    }
    const finalizeStream = (finalText) => {
      if (!streamingEv) return false
      if (finalText && finalText.trim()) streamingEv.text = finalText
      delete streamingEv.streaming
      streamingEv = null
      return true
    }
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          record.realSessionId = msg.session_id
          if (msg.model) record.model = prettyModel(msg.model)
          persist(true) // realSessionId 是恢复键，一到达立即落盘（含 jsonlPath）
          continue
        }
        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') appendDelta(ev.delta.text)
          continue
        }
        if (msg.type === 'assistant') {
          const content = msg.message?.content ?? []
          const u = msg.message?.usage
          if (u) {
            // ★★ SDK 把一条 assistant 消息**按 content block 逐条推**，每条都带**完整的
            //   message 级 usage**（JSONL 里那 52.8% 的重复行就是它写出来的）。逐条裸加
            //   ⇒ 平台会话卡片上的实时 token 虚高一倍（单条实测虚高 2.97 倍）。
            //   规则与 agent.js / archive-extract.js 共用 usage-dedupe.js，别写第四份。
            // ⚠️ 去重表挂在 record 上：多个 block 是跨 for-await 迭代到达的，
            //   建在循环体里的表每轮都是新的，永远命中不了。
            const inc = creditUsage((record.msgSeen ??= {}), msg.message?.id, u)
            record.tok.input += inc.input
            record.tok.output += inc.output
            record.tok.cacheRead += inc.cacheRead
            record.tok.cacheCreate += inc.cacheCreate
            record.tokens = record.tok.input + record.tok.output + record.tok.cacheRead + record.tok.cacheCreate
          }
          const finalText = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
          if (finalText.trim()) record.summary = finalText.trim().slice(0, 80)
          // 先收尾本回合流式文本（若有），再按序补推工具事件（文本在前、工具在后）
          if (!finalizeStream(finalText) && finalText.trim()) pushEvent({ type: 'assistant', text: finalText })
          for (const c of content) {
            if (c.type === 'tool_use') handleToolUse(record, c, pushEvent)
          }
          continue
        }
        if (msg.type === 'result') {
          finalizeStream()
          record.cost += msg.total_cost_usd ?? 0
          record.state = 'idle'
          pushEvent({
            type: 'turn_end',
            durationSec: Math.round((msg.duration_ms ?? 0) / 1000),
            tokens: (msg.usage?.output_tokens ?? 0) + (msg.usage?.input_tokens ?? 0),
            cost: msg.total_cost_usd ?? 0,
          })
          onTurnEnd(record)
          // 回合边界决定重启后是否标“可能中断”，必须立即落盘；否则完成后 2s 内重启会沿用旧 running 假报中断。
          persist(true)
        }
      }
    } catch (e) {
      record.state = 'error'
      record.error = String(e?.message ?? e)          // 完整错误（详情页错误横幅用）
      record.summary = `会话异常：${record.error.slice(0, 80)}`
      persist(true)
    } finally {
      record.done = true
      if (record.state === 'running' || record.state === 'waiting_approval') record.state = 'idle'
    }
  })()

  return record
}

// 末尾像在征询用户（问号，或常见中文征询词尾）
const ASK_PATTERNS = [
  /[?？]\s*$/,
  /(吗|呢|还是哪个|怎么办)[？?]?\s*$/,
  /(请(你)?(选择|确认|告诉我|决定|定夺)|你(的)?(倾向|意见|想法)|按推荐来|要不要|是否需要|哪一?个更好|A\s*还是\s*B)/,
]
const looksLikeQuestion = (t) => {
  const tail = t.slice(-200)
  return ASK_PATTERNS.some((re) => re.test(tail))
}

/** 回合结束：识别「完成待验收」（有文件变更）或「提问待答」（征询收尾），二者互斥 */
function onTurnEnd(record) {
  const lastAssistant = [...record.events].reverse().find((e) => e.type === 'assistant')
  const lastText = (lastAssistant?.text ?? '').trim()
  const changed = record.fileChanges.length - (record._reviewedChanges ?? 0)

  // 1) 完成待验收：本回合有文件变更（优先级高于提问）
  if (changed > 0) {
    record._reviewedChanges = record.fileChanges.length
    const adds = record.fileChanges.slice(-changed).reduce((n, f) => n + f.additions, 0)
    const dels = record.fileChanges.slice(-changed).reduce((n, f) => n + f.deletions, 0)
    const action = {
      id: nid('act'), sessionId: record.id, kind: 'review',
      title: '回合完成，待验收',
      detail: `${lastText.slice(0, 200) || record.summary}\n+${adds} −${dels} · ${changed} 处变更`,
      createdAt: Date.now(), status: 'pending',
    }
    record.pending.set(action.id, {
      action,
      resolve: (resolution) => { action.status = 'resolved'; action.resolution = resolution; record.pending.delete(action.id) },
      expire: () => { action.status = 'expired'; record.pending.delete(action.id) },
    })
    return
  }

  // 2) 提问待答：回合无文件变更但以征询收尾
  if (lastText && looksLikeQuestion(lastText)) {
    const action = {
      id: nid('act'), sessionId: record.id, kind: 'question',
      title: lastText.split('\n').filter(Boolean).at(-1)?.slice(0, 100) ?? '等待你的回答',
      detail: lastText.slice(-1500),
      createdAt: Date.now(), status: 'pending',
    }
    record.state = 'waiting_input'
    record.summary = `问：${action.title.slice(0, 60)}`
    record.pending.set(action.id, {
      action,
      resolve: (resolution) => {
        action.status = 'resolved'
        action.resolution = resolution
        record.pending.delete(action.id)
        sendMessage(record.id, resolution)
      },
      expire: () => { action.status = 'expired'; record.pending.delete(action.id) },
    })
  }
}

function handleToolUse(record, c, pushEvent) {
  const inp = c.input ?? {}
  switch (c.name) {
    case 'Read':
      pushEvent({ type: 'file_op', verb: '读取文件', path: relPath(record, inp.file_path) })
      break
    case 'Write': {
      const news = String(inp.content ?? '')
      pushEvent({ type: 'file_op', verb: '创建文件', path: relPath(record, inp.file_path), additions: news.split('\n').length })
      addFileChange(record, relPath(record, inp.file_path), '', news)
      break
    }
    case 'Edit': {
      const olds = String(inp.old_string ?? '')
      const news = String(inp.new_string ?? '')
      pushEvent({
        type: 'file_op', verb: '更新文件', path: relPath(record, inp.file_path),
        additions: news ? news.split('\n').length : 0,
        deletions: olds ? olds.split('\n').length : 0,
      })
      addFileChange(record, relPath(record, inp.file_path), olds, news)
      break
    }
    case 'Bash':
      pushEvent({ type: 'file_op', verb: '执行命令', path: String(inp.command ?? '').slice(0, 100) })
      break
    case 'TodoWrite':
      if (Array.isArray(inp.todos)) {
        record.todos = inp.todos.map((t) => ({
          text: t.content ?? '',
          status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending',
        }))
      }
      break
    case 'Task':
      pushEvent({ type: 'file_op', verb: '子代理', path: String(inp.description ?? '').slice(0, 100) })
      break
    case 'Grep':
    case 'Glob':
      break
    default:
      pushEvent({ type: 'file_op', verb: '工具', path: c.name })
  }
}

const relPath = (record, p) => (p ? String(p).replace(record.cwd + '/', '') : '')

function addFileChange(record, p, olds, news) {
  const cap = (s) => s.split('\n').slice(0, 40)
  record.fileChanges.push({
    path: p,
    additions: news ? news.split('\n').length : 0,
    deletions: olds ? olds.split('\n').length : 0,
    lines: [
      ...cap(olds).filter(Boolean).map((text) => ({ kind: 'del', no: null, text })),
      ...cap(news).filter(Boolean).map((text) => ({ kind: 'add', no: null, text })),
    ],
  })
  if (record.fileChanges.length > 12) record.fileChanges.splice(0, record.fileChanges.length - 12)
}

function prettyModel(m) {
  if (!m) return ''
  let match = /claude-(\w+)-(\d+)-(\d+)/.exec(m)
  if (match) return match[1][0].toUpperCase() + match[1].slice(1) + ' ' + match[2] + '.' + match[3]
  match = /claude-(\w+)-(\d+)/.exec(m)
  if (match) return match[1][0].toUpperCase() + match[1].slice(1) + ' ' + match[2]
  return m
}

// ===== 对外 API（由 agent.js 调用） =====

/** BrightPath 契约：最后一条 file_op 事件摘要 { ts, verb, path }，无则 null */
function lastEventOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'file_op' && e.verb) return { ts: e.ts, verb: e.verb, path: e.path ?? '' }
  }
  return null
}

export function listSessions() {
  return [...sessions.values()].map((r) => ({
    id: r.id, project: r.project, branch: r.branch, engine: r.engine, model: r.model,
    effort: r.effort,
    mode: r.mode, state: r.state, summary: r.summary, startedAt: r.startedAt,
    firstPrompt: r.firstPrompt || '',
    // inflight=回合真正在飞、被 agent 重启即截断的：running(流式中) 或 waiting_approval(工具已提议未执行、
    // 回合暂停在中途)。waiting_input(以提问收尾) 与回合后的 review 待办都是回合后态、可恢复，不算在飞
    // （据 Codex 评审 CR-006 P1-b：只有真在飞回合才应阻塞重启/排空，别让待办白等 120s）。
    inflight: r.state === 'running' || r.state === 'waiting_approval',
    lastActiveAt: r.lastActiveAt, cost: Math.round(r.cost * 100) / 100, tokens: r.tokens,
    tokensBreakdown: { ...r.tok },
    origin: 'platform', realSessionId: r.realSessionId, resumedFrom: r.resumedFrom,
    cwd: r.cwd,
    error: r.error,
    lastEvent: lastEventOf(r.events),
    todoStats: {
      done: r.todos.filter((t) => t.status === 'done').length,
      active: r.todos.filter((t) => t.status === 'active').length,
      total: r.todos.length,
    },
  }))
}

/** 接管型会话的事件流重定向目标（真实 sessionId，事件由 JSONL 提供） */
export function resumeTarget(id) {
  const r = sessions.get(id)
  return r?.resumedFrom ?? null
}

/** 释放平台会话：结束 SDK 进程，会话退回影子态；返回 realSessionId 供终端 resume */
export async function release(id) {
  const r = sessions.get(id)
  if (!r) return null
  for (const p of [...r.pending.values()]) p.expire()
  try { await r.handle?.interrupt() } catch { /* 已结束 */ }
  r.queue.end()
  sessions.delete(id)
  sessionStore.remove(id) // 显式释放 = 主动退回影子态，删除持久化身份（区别于崩溃重启）
  return { realId: r.realSessionId }
}

export function realSessionIds() {
  return new Set([...sessions.values()].map((r) => r.realSessionId).filter(Boolean))
}

export function pendingActions() {
  const out = []
  for (const r of sessions.values()) {
    for (const { action } of r.pending.values()) out.push(action)
  }
  return out
}

export function getEvents(id) {
  const r = sessions.get(id)
  if (!r) return null
  return { events: r.events, fileChanges: r.fileChanges, todos: r.todos }
}

// images: [{ media_type, data(base64) }]
export function sendMessage(id, text, images = []) {
  const r = sessions.get(id)
  if (!r) return false
  if (r.done) return false
  // 用户直接发消息时，挂起的提问/验收待办自动失效（已被回应）
  for (const [aid, p] of [...r.pending]) {
    if (p.action.kind === 'question' || p.action.kind === 'review') { p.expire(); r.pending.delete(aid) }
  }
  const content = []
  for (const img of images) {
    if (img?.data && img?.media_type) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })
    }
  }
  if (text) content.push({ type: 'text', text })
  if (content.length === 0) return false

  const savedImgs = saveSessionImages(id, images)
  r.events.push({ id: nid('ev'), ts: Date.now(), type: 'user', text, imageCount: images.length || undefined, images: savedImgs.length ? savedImgs : undefined })
  r.state = 'running'
  r.summary = '正在处理新指令…'
  r.lastActiveAt = Date.now()
  persistRecord(r, false) // 刷新 lastActiveAt/lastState（去抖）
  r.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
  return true
}

export async function interrupt(id) {
  const r = sessions.get(id)
  if (!r) return false
  // 先把挂起待办全部失效，避免 canUseTool 悬挂
  for (const p of [...r.pending.values()]) p.expire()
  try { await r.handle?.interrupt() } catch { /* 已结束 */ }
  r.state = 'idle'
  r.summary = '已被用户中断'
  r.lastActiveAt = Date.now()
  persistRecord(r, true) // 明确中断已收敛为 idle，避免紧接着重启时被误标为异常中断
  return true
}

export async function setMode(id, mode) {
  const r = sessions.get(id)
  if (!r) return false
  try { await r.handle?.setPermissionMode(mode) } catch { return false }
  r.mode = mode
  return true
}

/** 会话中切换模型（下一回合生效） */
export async function setLlmModel(id, model) {
  const r = sessions.get(id)
  if (!r || typeof r.handle?.setModel !== 'function') return false
  try { await r.handle.setModel(model || undefined) } catch { return false }
  r.model = prettyModel(model) || r.model
  return true
}

/** 会话中切换 effort 档位（下一回合生效）。句柄无 setEffort，用 setMaxThinkingTokens 映射档位。 */
export async function setLlmEffort(id, effort) {
  const r = sessions.get(id)
  if (!r) return false
  const lv = normEffort(effort)
  if (typeof r.handle?.setMaxThinkingTokens !== 'function') return false
  try { await r.handle.setMaxThinkingTokens(EFFORT_THINKING[lv]) } catch { return false }
  r.effort = lv
  return true
}

export function resolveAction(actionId, resolution) {
  for (const r of sessions.values()) {
    const p = r.pending.get(actionId)
    if (p) {
      p.resolve(resolution)
      r.lastActiveAt = Date.now()
      return true
    }
  }
  return false
}

/** 某 pending action 的类型（approval/plan/question/review），无则 null。
 *  用于排空期判定：question 的 resolve 会 sendMessage() 起新回合，须在 drain 时拒绝（CR-006 P1-c）。 */
export function actionKind(actionId) {
  for (const r of sessions.values()) {
    const p = r.pending.get(actionId)
    if (p) return p.action.kind
  }
  return null
}
