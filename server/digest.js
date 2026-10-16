// 会话回溯（功能2·demo）：把事件流配对成「我的提问(原文) → 模型回复(精炼)」的时间线。
// 我的每条提问完整保留；模型回复用 haiku 一次性批量精炼成一句要点，按 文本hash 缓存（重开/增量只补新回合）。
// 只读：不改动活跃会话状态机。doc_center 图片归档待其 blob 契约就绪，本期先在 UI 标注「含 N 张图」。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'

function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN
  const cands = [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude']
  try {
    const nvm = path.join(os.homedir(), '.nvm/versions/node')
    for (const v of fs.readdirSync(nvm)) cands.push(path.join(nvm, v, 'bin/claude'))
  } catch { /* 无 nvm */ }
  return cands.find((p) => fs.existsSync(p))
}
const CLAUDE_BIN = findClaude()

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const abstractCache = new Map() // 文本hash -> 精炼要点（进程内；重启退回未精炼，符合平台会话不持久化的边界）

// ---- 事件 → 回合配对 ----
function isRealUser(text) {
  const t = (text || '').trim()
  return !!t && !t.startsWith('<') // 过滤系统注入 / 工具结果包裹
}

/** 把 events 配对成回合：每个真实 user 起一回合，吸附其后的 assistant 文本与 file_op。 */
export function pairTurns(events) {
  const turns = []
  let cur = null
  for (const e of events || []) {
    if (e.type === 'user') {
      if (!isRealUser(e.text)) continue
      if (cur) turns.push(cur)
      cur = { ts: e.ts, user: { text: e.text, imageCount: e.imageCount || 0 }, assistantText: '', fileOps: [] }
    } else if (!cur) {
      continue
    } else if (e.type === 'assistant' && e.text) {
      cur.assistantText += (cur.assistantText ? '\n\n' : '') + e.text
    } else if (e.type === 'file_op') {
      cur.fileOps.push({ verb: e.verb || '', path: e.path || '' })
    }
  }
  if (cur) turns.push(cur)
  return turns
}

const keyOf = (t) => sha(t.assistantText || JSON.stringify(t.fileOps) || 'empty')

function dedupeFileOps(ops) {
  const seen = new Set()
  const out = []
  for (const o of ops) {
    const k = `${o.verb}|${o.path}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(o)
    if (out.length >= 8) break
  }
  return out
}

// 规则兜底（无 LLM / 超时 / 解析失败时）：取首行结论或文件改动清单
function ruleAbstract(t) {
  const body = (t.assistantText || '').trim()
  if (body) {
    const first = body.split('\n').find((l) => l.trim()) || ''
    return first.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').slice(0, 140)
  }
  const files = [...new Set(t.fileOps.map((f) => f.path).filter(Boolean))].slice(0, 4)
  if (t.fileOps.length) return `执行了 ${t.fileOps.length} 步操作${files.length ? '：' + files.join('、') : ''}`
  return '（无文本回复）'
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}

// 一次 haiku 调用批量精炼：输入 #编号+回复原文，输出 #编号+一句要点
async function haikuBatch(items, timeoutMs = 90_000) {
  if (!items.length) return new Map()
  const parts = [
    '下面是若干条「AI 助手的回复」。请把每一条压缩成一句精炼中文要点（突出结论/方案/改了哪些文件，去掉寒暄和过程描述），第 N 条回复对应第 N 条要点。',
    '严格按格式：每条一行，以「#编号 」开头，例如：#1 修复了登录超时，改了 auth.js。除这些行外不要输出任何内容。',
    '',
  ]
  for (const it of items) {
    parts.push(`#${it.idx} 回复原文：`)
    parts.push(it.text.slice(0, 1500))
    parts.push('')
  }
  let outText = ''
  try {
    outText = await withTimeout(runHaiku(parts.join('\n')), timeoutMs)
  } catch { return new Map() }
  const map = new Map()
  for (const line of String(outText).split('\n')) {
    const m = /^#(\d+)\s+(.*)$/.exec(line.trim())
    if (m && m[2].trim()) map.set(Number(m[1]), m[2].trim())
  }
  return map
}

async function runHaiku(prompt) {
  const q = query({
    prompt,
    options: {
      cwd: os.tmpdir(), // 中性目录：纯文本摘要，不需要项目上下文
      model: 'claude-haiku-4-5',
      permissionMode: 'default',
      maxTurns: 1,
      disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit', 'MultiEdit', 'AskUserQuestion'],
      ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
    },
  })
  let out = ''
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      out += (msg.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    }
    if (msg.type === 'result') break
  }
  return out
}

function toTurn(t, i) {
  return {
    seq: i + 1,
    ts: t.ts,
    user: t.user,
    abstract: abstractCache.get(keyOf(t)) ?? null,
    fileOps: dedupeFileOps(t.fileOps),
    hasReply: !!t.assistantText.trim(),
  }
}

// 今日复盘：把当天各会话的要点喂给 haiku，产出 markdown 复盘（卓有成效 / 进展不足 / 明日建议）
const reflectCache = new Map() // dateKey+hash -> markdown

/** items: [{ project, server, sessions:[{summary, engine, abstracts:[...]}] }] */
export async function reflectDay(date, items) {
  const lines = []
  for (const it of items || []) {
    lines.push(`## 项目：${it.project}（${it.server || ''}）`)
    for (const s of it.sessions || []) {
      lines.push(`- 会话「${(s.summary || '').slice(0, 60)}」[${s.engine || ''}]`)
      for (const a of (s.abstracts || []).slice(0, 12)) lines.push(`  · ${a}`)
    }
  }
  const corpus = lines.join('\n').slice(0, 12_000)
  if (!corpus.trim()) return ''
  const key = sha(date + '|' + corpus)
  if (reflectCache.has(key)) return reflectCache.get(key)
  const prompt = [
    `下面是我在 ${date} 这一天，跨多个项目的 AI 编码会话要点汇总。请你作为我的工作复盘助手，输出一份简洁中文复盘，用 markdown，包含三个小节：`,
    '## ✅ 卓有成效（哪些事推进得好、产出明确）',
    '## ⚠️ 进展/效果不足（哪些卡住、反复、或没闭环）',
    '## 🎯 明日建议（3 条以内，具体可执行）',
    '要求：基于材料归纳，不要逐条复述；点名具体项目；克制、直给。',
    '',
    corpus,
  ].join('\n')
  let md = ''
  try { md = (await withTimeout(runHaiku(prompt), 90_000)).trim() } catch { md = '' }
  if (md) reflectCache.set(key, md)
  return md
}

// 归档精炼（会话→KB）：把整段对话喂 haiku，产出「问题信息」「主要进展」两段 markdown。
// 关键：把我的简短确认（可以/ok/对/按这个来）结合其前一条助手内容还原成"确认了哪个方案"。
const archiveCache = new Map() // hash -> markdown
export async function archiveSummary(events) {
  const turns = pairTurns(events).filter((t) => isRealUser(t.user.text))
  if (!turns.length) return ''
  const lines = []
  turns.forEach((t, i) => {
    lines.push(`#${i + 1} 我：${(t.user.text || '').slice(0, 800)}${t.user.imageCount ? `（含${t.user.imageCount}张截图）` : ''}`)
    if (t.assistantText.trim()) lines.push(`   助手：${t.assistantText.slice(0, 1000)}`)
    else if (t.fileOps.length) lines.push(`   助手：执行了 ${t.fileOps.length} 步操作`)
  })
  const corpus = lines.join('\n').slice(0, 16_000)
  const key = sha(corpus)
  if (archiveCache.has(key)) return archiveCache.get(key)
  const prompt = [
    '下面是我和 AI 助手的一段完整对话（按回合，"我："是我说的，"助手："是 AI 回复）。请输出两段中文 markdown：',
    '',
    '## 问题信息',
    '说明我这次到底想解决什么、关键诉求与决策点。**特别注意**：当我的话很短（如"可以""ok""对""按这个来""继续"）时，要结合它前面助手刚提出的方案/问题，还原成"我确认/选择了哪个方案"，不要原样照抄"可以"——否则孤立看毫无意义。',
    '',
    '## 主要进展',
    '要点列出实际做了什么、定了什么、关键结论与产出（含改了哪些文件、部署了什么，如有）。基于材料归纳，克制直给，不要逐条复述对话。',
    '',
    '只输出这两段 markdown（含上面两个 ## 标题），不要任何其它内容。',
    '',
    '对话如下：',
    corpus,
  ].join('\n')
  let md = ''
  try { md = (await withTimeout(runHaiku(prompt), 90_000)).trim() } catch { md = '' }
  if (md) archiveCache.set(key, md)
  return md
}

/** GET：纯读，从缓存填充要点，不触发 LLM。 */
export function digestFromCache(events) {
  return pairTurns(events).filter((t) => isRealUser(t.user.text)).map(toTurn)
}

/** POST build：对未精炼的回合跑一次 haiku 批量精炼，写缓存后返回完整时间线。 */
export async function buildDigest(events) {
  const turns = pairTurns(events).filter((t) => isRealUser(t.user.text))
  const missing = turns.filter((t) => !abstractCache.has(keyOf(t)))
  // 有文本回复的走 LLM 批量；无文本（纯工具）回合走规则兜底
  const llm = missing.filter((t) => t.assistantText.trim())
  if (llm.length) {
    const items = llm.map((t, i) => ({ idx: i + 1, text: t.assistantText }))
    const res = await haikuBatch(items)
    llm.forEach((t, i) => {
      const ab = res.get(i + 1)
      abstractCache.set(keyOf(t), ab || ruleAbstract(t))
    })
  }
  for (const t of missing) {
    if (!abstractCache.has(keyOf(t))) abstractCache.set(keyOf(t), ruleAbstract(t))
  }
  return turns.map(toTurn)
}
