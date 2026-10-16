// server/archive-extract.js — 结构化抽取层（openspec change: execution-history-archive，P1）
//
// 从归档原文里抽出**可查字段**：跑过的命令、改过的文件、用户提问、模型与用量、时间线。
//
// ★ 抽取结果是**派生数据**（design D6）：schema 变了就从原文重跑，不回源机器。
//   所以这一层可以放心迭代——真正不可逆的是 P0 的原文归档。
//
// ★ 三种引擎的 JSONL 格式互不相同，各走各的解析分支：
//   claude  —— {type:'user'|'assistant', message:{content:[{type:'text'|'tool_use'}]}}
//   codex   —— {type:'event_msg'|'response_item', payload:{...}}（rollout 格式）
//   kimi    —— wire.jsonl，**有不带 `time` 的行，且助手回复恰在其中**
//
// ⚠️ 坏行是常态：归档里必然混着半行、异常行。**一行坏不得让整段抽取失败**——
//   否则一个 74 MB 的会话里有一行脏数据，整条历史就查不到了。

const ts = (v) => {
  if (!v) return 0
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) ? n : 0
}

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) : String(s ?? ''))

/**
 * 正文入索引的单条上限。
 *
 * ★★ 2026-08-31 用户实测暴露的问题：原值 **300** 砍掉了 **17,718 / 48,876（36%）** 条消息的主体
 *   —— 助手的长回复只有开头 300 字进索引，中后段全部不可检索。
 *   用户搜 `Z_SYNC_FLUSH`（讨论过很多、代码里也有）**0 条命中**。
 *   ★ 这不是"召回算法不好"，是**语料压根没进去**：再好的检索也搜不到没索引的东西。
 *
 * ⚠️ 但仍要有上限：实测单条消息最长 33 万字，整条进内存索引会把 hub 撑爆
 *   （hub RSS 260MB / 可用 1,587MB，索引常驻内存）。1200 是权衡后的值：
 *   覆盖绝大多数消息的完整语义，索引估从 9.7MB 涨到 ~30MB。
 */
import { creditUsage } from './usage-dedupe.js'

const TEXT_CLIP = Number(process.env.WA_ARCHIVE_TEXT_CLIP) || 1200

/** 从一段原文行抽出一个会话的结构化视图。 */
export function extractSession({ engine, host, project, session, lines = [], textClip } = {}) {
  const TC = Number.isFinite(Number(textClip)) && Number(textClip) > 0 ? Number(textClip) : TEXT_CLIP
  const out = {
    host, project, session, engine,
    firstPrompt: '', model: '', tokens: 0, turns: 0,
    startedAt: 0, lastAt: 0, parseErrors: 0,
    commands: [], files: [], texts: [],
  }
  const cmdCount = new Map()
  const fileSet = new Set()
  const msgSeen = {}   // message.id -> 已计入的 usage（多 block 行去重，见 extractClaude）
  let lastKnownTs = 0

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue
    let o
    try { o = JSON.parse(raw) } catch { out.parseErrors += 1; continue }
    out.turns += 1

    // ⚠️ 时间：Kimi 的 wire.jsonl 里有**不带 time 的行，助手回复恰在其中**。
    //    丢了它时间戳会归零 ⇒ 界面显示 1970（CLAUDE.md 记过这条）。沿用上一条已知时间。
    const t = ts(o.timestamp ?? o.time ?? o.ts ?? o.created_at)
    if (t) lastKnownTs = t
    const eff = t || lastKnownTs
    if (eff) {
      if (!out.startedAt) out.startedAt = eff
      out.lastAt = Math.max(out.lastAt, eff)
    }

    try {
      if (engine === 'codex') extractCodex(o, out, cmdCount, fileSet, TC)
      else if (engine === 'kimi') extractKimi(o, out, TC)
      else extractClaude(o, out, cmdCount, fileSet, TC, msgSeen)
    } catch { out.parseErrors += 1 }
  }

  // ★ Codex 的项目名必须来自内容里的 cwd —— 它按日期分目录，路径上只有年份。
  if (out.cwd) out.project = '-' + String(out.cwd).replace(/^\//, '').replace(/[/_.]/g, '-')
  out.commands = [...cmdCount.entries()].map(([cmd, n]) => ({ cmd, n })).slice(0, 200)
  out.files = [...fileSet].slice(0, 200)
  return out
}

function extractClaude(o, out, cmdCount, fileSet, TC = TEXT_CLIP, msgSeen = null) {
  const m = o.message
  if (!m) return
  if (m.model && !out.model) out.model = m.model
  // ★ 按 message.id 去重：Claude Code 把一条 assistant 消息**按 content block 拆成多行
  //   JSONL，每行都带完整的 message 级 usage**。逐行累加 ⇒ 检索卡片上的 tokens 虚高
  //   （全量实扫 1,484 个 transcript：308.6 亿 → 145.7 亿，虚高 52.8%）。
  //   与 agent.js 同一病根、不同出口 —— 共用 server/usage-dedupe.js，别写第二份规则。
  if (m.usage) {
    const inc = creditUsage(msgSeen ?? {}, m.id, m.usage)
    out.tokens += inc.input + inc.output
  }

  const content = m.content
  if (typeof content === 'string') {
    if (o.type === 'user' && !out.firstPrompt) out.firstPrompt = clip(content, 400)
    else if (content.trim()) out.texts.push(clip(content, TC))
    return
  }
  if (!Array.isArray(content)) return
  for (const c of content) {
    if (c?.type === 'text' && c.text) {
      if (o.type === 'user' && !out.firstPrompt) out.firstPrompt = clip(c.text, 400)
      else out.texts.push(clip(c.text, TC))
    }
    if (c?.type === 'tool_use') {
      const inp = c.input ?? {}
      if (inp.command) bump(cmdCount, clip(inp.command, 500))
      if (inp.file_path) fileSet.add(inp.file_path)
      if (inp.path) fileSet.add(inp.path)
    }
  }
}

/**
 * Codex（rollout 格式）。字段以 **2026-08-29 线上样本**为准，不是照直觉猜的：
 * · 项目在 `session_meta.payload.cwd` —— **路径上是日期目录，不含项目名**
 * · 命令有两个来源：`function_call.arguments.cmd`（字符串，不是 `command` 数组）
 *   与 `exec_command_end.command`（数组，更完整）
 * · `user_message` 前面常挂一大段 IDE 前言，不剥掉的话每个会话的"提问"长得一样、毫无区分度
 */
function extractCodex(o, out, cmdCount, fileSet, TC = TEXT_CLIP) {
  const p = o.payload
  if (!p) return
  if (o.type === 'session_meta' && p.cwd) out.cwd = p.cwd
  if (p.type === 'user_message' && p.message && !out.firstPrompt) out.firstPrompt = stripIdePreamble(p.message)
  if (p.type === 'agent_message' && p.message) out.texts.push(clip(p.message, TC))
  if (p.type === 'exec_command_end') {
    if (Array.isArray(p.command)) bump(cmdCount, clip(stripShellWrapper(p.command), 500))
    if (p.cwd && !out.cwd) out.cwd = p.cwd
  }
  if (p.type === 'function_call' && p.arguments) {
    let args
    try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments } catch { return }
    const c = args?.cmd ?? args?.command
    if (Array.isArray(c)) bump(cmdCount, clip(stripShellWrapper(c), 500))
    else if (typeof c === 'string') bump(cmdCount, clip(c, 500))
    if (args?.path) fileSet.add(args.path)
    if (args?.file_path) fileSet.add(args.file_path)
  }
}

/** `["/bin/bash","-lc","真命令"]` → `真命令`；其余原样 join。 */
function stripShellWrapper(arr) {
  if (arr.length >= 3 && /(^|\/)(ba)?sh$/.test(arr[0]) && /^-[lc]+$/.test(arr[1])) return arr.slice(2).join(' ')
  return arr.join(' ')
}

/** 剥掉 Codex/IDE 注入的前言，只留用户真正写的那句。 */
function stripIdePreamble(msg) {
  const m = String(msg)
  const marks = ['## My request for Codex:', '## My request:', '# 我的请求']
  for (const k of marks) {
    const i = m.indexOf(k)
    if (i >= 0) return clip(m.slice(i + k.length).trim(), 400)
  }
  return clip(m.trim(), 400)
}

/**
 * Kimi（wire.jsonl）。字段同样以线上样本为准：
 * · 用户提问在 `turn.prompt.input[].text`（`origin.kind === 'user'`）
 * · 消息在 `context.append_message.message.content[].text`
 * · 模型在 `llm.request.model`
 * ⚠️ **`llm.request` 与 `context.append_message` 都不带 `time`** —— 助手回复恰在其中。
 *   时间沿用逻辑在 extractSession 里统一处理（丢了它界面会显示 1970）。
 */
function extractKimi(o, out, TC = TEXT_CLIP) {
  if (o.type === 'turn.prompt' && Array.isArray(o.input)) {
    const t = o.input.map((x) => x?.text).filter(Boolean).join(' ')
    if (t && !out.firstPrompt && (o.origin?.kind ?? 'user') === 'user') out.firstPrompt = clip(t, 400)
    return
  }
  if (o.type === 'llm.request' && o.model && !out.model) { out.model = o.model; return }
  if (o.type === 'context.append_message') {
    const c = o.message?.content
    const t = Array.isArray(c) ? c.map((x) => x?.text).filter(Boolean).join(' ') : (typeof c === 'string' ? c : '')
    if (!t) return
    if (o.message?.role === 'user' && !out.firstPrompt) out.firstPrompt = clip(t, 400)
    else if (o.message?.role !== 'user') out.texts.push(clip(t, TC))
  }
}

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

/**
 * 生成用于 embedding 的一段文本（**首期每会话 1 向量**，见 design D12）。
 *
 * 放什么进去是检索质量的关键：**项目名 + 用户提问 + 改过的文件 + 跑过的命令**
 * 都是很强的检索线索——用户回忆一件事时，想起的往往正是"哪个项目""改了哪个文件"。
 * 助手的长篇输出反而稀释语义，只取少量。
 *
 * ⚠️ 长度封顶：embedding 在 2 核网关上是 0.55 s/条（实测），文本越长越慢。
 */
export function summarize(r) {
  const parts = [
    `项目 ${String(r.project ?? '').replace(/^-/, '').replace(/-/g, '_')}`,
    `引擎 ${r.engine}`,
    r.firstPrompt && `提问 ${r.firstPrompt}`,
    r.files.length && `改动文件 ${r.files.slice(0, 12).map((f) => f.split('/').slice(-2).join('/')).join(' ')}`,
    r.commands.length && `命令 ${r.commands.slice(0, 8).map((c) => c.cmd.slice(0, 80)).join(' ; ')}`,
    r.texts.length && `要点 ${r.texts.slice(0, 3).join(' ')}`,
  ].filter(Boolean)
  return clip(parts.join('\n'), 2000)
}
