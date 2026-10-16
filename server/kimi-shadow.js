// Kimi 影子会话追踪：把磁盘上的 kimi-code 会话变成管控台可见的记录。
//
// 为什么需要：agent.js 原本只扫 ~/.claude/projects 与 ~/.codex/sessions 两个根，Kimi 完全不在其中。
// 于是 Kimi 会话**只在 agent 内存里活着**——agent 一重启就消失，从终端起的 Kimi 会话更是从未出现过，
// 「会话历史」里永远只有 Claude 和 Codex（2026-08-01 用户报的就是这个）。
//
// 磁盘布局（kimi-code 0.31.x）：
//   ~/.kimi-code/session_index.jsonl                     每行 {sessionId, sessionDir, workDir}
//   <sessionDir>/state.json                              title / workDir / lastPrompt
//   <sessionDir>/agents/main/wire.jsonl                  完整对话记录（protocol 1.4）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { advanceShadowTurn } from './shadow-state.js'

export const KIMI_ROOT = path.join(os.homedir(), '.kimi-code')
export const KIMI_INDEX = path.join(KIMI_ROOT, 'session_index.jsonl')
export const wirePath = (sessionDir) => path.join(sessionDir, 'agents', 'main', 'wire.jsonl')

// 与 agent.js 同一套日/小时桶键（本地时区）。agent.js 引本模块，方向反过来会成环，故这里自带一份。
const dayOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const hourOf = (ts) => `${dayOf(ts)}T${String(new Date(ts).getHours()).padStart(2, '0')}`
const ACTIVE_GAP_MS = 5 * 60_000 // 同 agent.js：相邻行间隔 < 5min 才算"在干活"

// 工具名 → 中文动词，与 kimi-driver.js#toolVerb 保持同一张表（跨源去重依赖词汇一致）。
export const KIMI_TOOL_VERB = {
  Bash: '执行命令', Read: '读取', Edit: '修改文件', Write: '修改文件',
  Glob: '搜索', Grep: '搜索', Search: '搜索', WebFetch: '访问网页', FetchURL: '访问网页',
}

/** 事件归一化指纹：跨源（wire vs driver 内存）判重用，不看 id（两源 id 命名空间不同）。 */
const eventKey = (e) => {
  if (!e) return ''
  if (e.type === 'file_op') return `file_op|${e.verb ?? ''}|${e.path ?? ''}`
  return `${e.type}|${String(e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}`
}

/**
 * 合并 Kimi 的两份事件源：wire.jsonl 历史（权威，kimi 实时落盘，同 Claude 的 JSONL 地位）
 * + driver 内存（ACP 流式）。返回按时间升序的合并结果。
 *
 * 为什么需要它（2026-09-27 用户报「会话内容重复、排序乱」）：eventsPayload 原来直接
 * [...hist, ...live] 再按事件 id 去重——而两源 id 命名空间不同（kw-* vs ev-*），去重恒为 0；
 * 且「两段不相交」的假设只对 Codex 成立（它不实时回写 JSONL），Kimi 的 wire 是实时写的，
 * 接管/重启后 driver 回放的那份历史 wire 里早已有 ⇒ 整段对话出现两次、第二份还整体排在末尾。
 *
 * 规则：
 *  - wire 为空 ⇒ 原样给 live（wire 读不到时的兜底，行为与旧代码一致）
 *  - live 里只有两类能进来：① `streaming` 流式尾巴（当前回合尚未落盘 wire 的那截）
 *    ② 严格晚于 wire 最后一条 ts 的事件；两者都要过边界指纹去重（wire 末尾 ±12 条）
 */
export function mergeKimiEvents(hist, live, { boundary = 12, tsSlackMs = 1500 } = {}) {
  const h = Array.isArray(hist) ? hist : []
  const l = Array.isArray(live) ? live : []
  if (!h.length) return l.slice()
  if (!l.length) return h.slice()
  const lastTs = h[h.length - 1]?.ts || 0
  const tailKeys = new Set(h.slice(-boundary).map(eventKey))
  const tail = []
  for (const e of l) {
    if (tailKeys.has(eventKey(e))) continue
    if (e.streaming || (e.ts || 0) > lastTs + tsSlackMs) tail.push(e)
  }
  return [...h, ...tail]
}

/** 索引行 → {sessionId, sessionDir, workDir}；坏行/半行返回 null（文件可能正在被写） */
export function parseIndexLine(line) {
  let o
  try { o = JSON.parse(line) } catch { return null }
  if (!o?.sessionId || !o?.sessionDir || !o?.workDir) return null
  return { sessionId: String(o.sessionId), sessionDir: String(o.sessionDir), workDir: String(o.workDir) }
}

/** 与 Claude/Codex 同口径：项目名 = workDir 末段 */
export function projectOfWorkDir(cwd) {
  return path.basename(String(cwd || '').replace(/\/+$/, ''))
}

/** kimi 往上下文里注入的系统提示，role 也是 "user" —— 不能当用户消息展示 */
const isInjected = (msg, text) =>
  (msg?.origin?.kind && msg.origin.kind !== 'user') || /^\s*<system-reminder>/.test(text)

/**
 * 解析 wire.jsonl → { events, tok, model, lastActiveAt }。
 *
 * ⚠️ 图片在 wire 里是内联 data URL（单张就 100KB 级）。只记 imageCount，**绝不把 base64 放进事件**
 * ——否则 /api/state 的载荷会被撑爆（toWire 当初剥 base64 就是为了这个，别在入口又塞回去）。
 */
/**
 * 解析 wire.jsonl。传 `resume` 即为**增量续扫**——只喂新增的那段文本。
 *
 * 2026-08-13：原实现每次整份 readFileSync + 全量解析，与 Codex 改造前同一个毛病。
 * 实测 .232 有 1,644 个 Kimi 文件（48.8MB，最大 2.8MB）⇒ 2.8MB 文件追加 4KB 要重读 2.8MB。
 *
 * ★ 六样累积量必须全部随 state 带走，少一样就静默算错：
 *   events / seq（事件 id 的一部分）/ tok 四桶 / model / lastActiveAt / **lastTs**
 *   lastTs 最阴：wire.jsonl 里确实有不带 time 的行（助手回复就在其中），它们沿用上一条的时间。
 *   跨边界丢了它 ⇒ 那些行 ts 归零 ⇒ 界面显示 1970-01-01 且排序被甩到最前（本仓库修过一次）。
 */
export function parseWire(text, resume = null) {
  const out = resume
    ? { events: resume.events, tok: { ...resume.tok }, model: resume.model, lastActiveAt: resume.lastActiveAt }
    : { events: [], tok: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, model: '', lastActiveAt: 0 }
  // 用量分桶（2026-09-27）：此前 parseWire 只有 tok 总量，usageDaily/Stats 页完全看不到 Kimi
  // （用户报「使用率需要补全」——一个几乎全 Kimi 的日子，消耗页显示「今日 0/—」）。
  // 桶结构与 Codex 同构：daily/dayTokComp/hourly/dailyActiveMs；Kimi 无单价 ⇒ 不出 dailyCost。
  // ★ 它们全是跨行累积量，**必须随 state 进检查点**，否则增量续扫丢一半（同六量教训第七条）。
  const daily = resume?.daily ? { ...resume.daily } : {}
  const dayTokComp = resume?.dayTokComp ? JSON.parse(JSON.stringify(resume.dayTokComp)) : {}
  const hourly = resume?.hourly ? { ...resume.hourly } : {}
  const dailyActiveMs = resume?.dailyActiveMs ? { ...resume.dailyActiveMs } : {}
  let activeMs = resume?.activeMs ?? 0
  let prevTs = resume?.prevTs ?? 0
  let seq = resume?.seq ?? 0
  // 时间兜底：wire.jsonl 里确实有不带 time 的行。原来 `Number(o.time) || 0` ⇒ NaN ⇒ 0，
  // 界面就显示 1970-01-01（用户报「时间戳明显不对」），而且按时间排序处会被甩到最前面。
  // 时间未知就沿用**上一条**的时间：顺序天然单调，比假装它发生在 1970 年诚实得多。
  let lastTs = resume?.lastTs ?? 0
  let turn = resume?.turn ?? null
  const bumpActive = (ts) => { // 与 agent.js 同一规则：相邻行间隔 < 5min 才算"在干活"
    if (!ts) return
    if (prevTs && ts > prevTs && ts - prevTs < ACTIVE_GAP_MS) {
      const delta = ts - prevTs
      activeMs += delta
      const dk = dayOf(ts)
      dailyActiveMs[dk] = (dailyActiveMs[dk] || 0) + delta
    }
    prevTs = ts
  }
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue } // 半行/坏行跳过：正在写入的文件必然有
    turn = advanceShadowTurn(turn, o, 'kimi')
    if (typeof o?.time === 'number' && Number.isFinite(o.time)) {
      lastTs = o.time
      bumpActive(o.time)
      if (o.time > out.lastActiveAt) out.lastActiveAt = o.time
    }
    if (o.type === 'usage.record') {
      if (o.model) out.model = String(o.model)
      const u = o.usage || {}
      const ti = Number(u.inputOther) || 0
      const to = Number(u.output) || 0
      const tcr = Number(u.inputCacheRead) || 0
      const tcc = Number(u.inputCacheCreation) || 0
      out.tok.input += ti
      out.tok.output += to
      out.tok.cacheRead += tcr
      out.tok.cacheCreate += tcc
      const msgTok = ti + to + tcr + tcc
      if (lastTs && msgTok) {
        const day = dayOf(lastTs), hk = hourOf(lastTs)
        daily[day] = (daily[day] ?? 0) + msgTok
        hourly[hk] = (hourly[hk] ?? 0) + msgTok
        const dt = (dayTokComp[day] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
        dt.input += ti; dt.output += to; dt.cacheRead += tcr; dt.cacheCreate += tcc
      }
      continue
    }
    // ⚠️ Kimi 的助手回复**不在** context.append_message 里——那里只有 user。
    // 它在 context.append_loop_event 的 content.part 中（2026-08-02 用户报「Kimi 对话流
    // 只显示自己发的消息，点恢复会话后就正常」：接管态读 driver 内存所以对，影子态读
    // JSONL 所以一边倒）。实测某会话：append_message 72 条全是 user；loop_event 2761 条里
    // content.part 626（text 109 = 可见回复，think 517 = 内部推理**不展示**）、tool.call 550。
    // loop_event 自身没有 time 字段 ⇒ 必须靠 lastTs 顺延，否则时间戳全为 0（1970）。
    if (o.type === 'context.append_loop_event') {
      const ev = o.event
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'content.part' && ev.part?.type === 'text') {
        const t = String(ev.part.text ?? '').trim()
        if (t) out.events.push({ id: `kw-${lastTs}-${++seq}`, ts: lastTs, type: 'assistant', text: t.slice(0, 6000) })
      } else if (ev.type === 'tool.call' && ev.name) {
        const a = ev.args || {}
        const name = String(ev.name)
        // verb 与 kimi-driver 的 toolVerb 同一套词汇（2026-09-27：两边各说各话——同一操作
        // wire 里叫 Read、driver 里叫 读取，跨源合并去重对不上，界面上同一动作两种说法）。
        const verb = KIMI_TOOL_VERB[name] ?? '调用工具'
        const target = name === 'Bash' ? (a.command ?? '') : (a.file_path ?? a.path ?? a.pattern ?? a.command ?? '')
        out.events.push({
          id: `kw-${lastTs}-${++seq}`,
          ts: lastTs,
          type: 'file_op',
          verb,
          path: String(target).replace(/\s+/g, ' ').trim().slice(0, 100),
        })
      }
      continue
    }
    if (o.type !== 'context.append_message') continue
    const msg = o.message
    const role = msg?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = Array.isArray(msg.content) ? msg.content : []
    const txt = content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('\n').trim()
    const imageCount = content.filter((c) => c?.type === 'image_url').length
    if (role === 'user' && isInjected(msg, txt)) continue
    if (!txt && !imageCount) continue
    out.events.push({
      id: `kw-${o.time ?? lastTs}-${++seq}`,
      ts: Number(o.time) || lastTs,
      type: role,
      text: txt,
      ...(imageCount ? { imageCount } : {}),
    })
  }
  // 用量分桶挂在 out 上直接给 usageDaily 用；state 是同一个引用（续扫接着累，见上方注释）。
  out.daily = daily
  out.dayTokComp = dayTokComp
  out.hourly = hourly
  out.dailyActiveMs = dailyActiveMs
  out.activeMs = activeMs
  // state 供下次续扫。events 是同一个数组引用（调用方按需截断），其余为值拷贝。
  out.state = {
    turn,
    events: out.events, tok: { ...out.tok }, model: out.model, lastActiveAt: out.lastActiveAt, seq, lastTs,
    daily: { ...daily }, dayTokComp: JSON.parse(JSON.stringify(dayTokComp)), hourly: { ...hourly },
    dailyActiveMs: { ...dailyActiveMs }, activeMs, prevTs,
  }
  return out
}

/** 读 state.json（标题/lastPrompt）；缺失或坏掉返回 {} —— 影子记录不因它失败 */
export function readState(sessionDir) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')) || {} }
  catch { return {} }
}

/**
 * 扫出本机所有 Kimi 影子会话（不含事件流，事件按需再读 wire.jsonl）。
 * 只返回 wire.jsonl 真实存在的条目——索引里可能残留已被删目录的会话。
 */
export function scanKimiSessions({ indexPath = KIMI_INDEX } = {}) {
  let raw
  try { raw = fs.readFileSync(indexPath, 'utf8') } catch { return [] }
  const seen = new Set()
  const out = []
  for (const line of raw.split('\n')) {
    const e = parseIndexLine(line)
    if (!e || seen.has(e.sessionId)) continue
    const wp = wirePath(e.sessionDir)
    let st
    try { st = fs.statSync(wp) } catch { continue } // 目录已删 / 还没落盘
    seen.add(e.sessionId)
    const s = readState(e.sessionDir)
    out.push({
      id: e.sessionId,
      realSessionId: e.sessionId,
      sessionDir: e.sessionDir,
      wirePath: wp,
      cwd: e.workDir,
      project: projectOfWorkDir(e.workDir),
      engine: 'kimi',
      origin: 'shadow',
      title: typeof s.title === 'string' ? s.title : '',
      lastPrompt: typeof s.lastPrompt === 'string' ? s.lastPrompt : '',
      size: st.size,
      mtimeMs: st.mtimeMs,
    })
  }
  return out
}
