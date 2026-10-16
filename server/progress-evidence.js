import crypto from 'node:crypto'
import { redactString } from './event-redaction.js'
import { parseWire } from './kimi-shadow.js'
export const PROGRESS_PARSER_VERSION = 5

const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24)
const clean = (s, max = 6000) => {
  const safe = String(s ?? '').replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '***PRIVATE_KEY***').split('\n').map(line => redactString(line) + (line.length > 500 ? ' [长行已截断]' : '')).join('\n')
  return safe.length > max ? safe.slice(0, Math.max(0, max - 24)) + '\n[内容已截断，请查看原会话]' : safe
}
const contentText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => ['text', 'input_text', 'output_text'].includes(x?.type)).map(x => x.text || '').join('\n') : ''
const injected = t => /^\s*(?:<environment_context>|<user_instructions>|# AGENTS\.md|<system-reminder>|<permissions instructions>)/.test(t)

export function progressWindow(question, now, days = 7) {
  const q = String(question || ''), day = Math.floor((now + 8 * 3600000)/86400000)*86400000-8*3600000
  if (/今天|今日/.test(q)) return { from: day, to: now+1, label: '今天（北京时间）' }
  if (/昨天|昨日/.test(q)) return { from: day-86400000, to: day, label: '昨天（北京时间）' }
  if (/近(?:一个月|1个月|30天|三十天)|最近一个月/.test(q)) return { from: now-30*86400000, to: now+1, label: '提问指定的近30天' }
  if (/本月|这个月|上个月/.test(q)) {
    const d = new Date(now+8*3600000), month=d.getUTCMonth(), year=d.getUTCFullYear(), previous=/上个月/.test(q)
    return { from: Date.UTC(year,month-(previous?1:0),1)-8*3600000, to: previous?Date.UTC(year,month,1)-8*3600000:now+1,label: previous?'上个月（北京时间）':'本月（北京时间）' }
  }
  if (/本周|这周|上周/.test(q)) {
    const weekday=new Date(day+8*3600000).getUTCDay(), monday=day-((weekday+6)%7)*86400000, previous=/上周/.test(q)
    return {from:monday-(previous?7*86400000:0),to:previous?monday:now+1,label:previous?'上周（北京时间）':'本周（北京时间）'}
  }
  const n = /近(?:两周|2周|14天)|最近两周/.test(q)?14:/近(?:一周|1周|7天)|最近一周/.test(q)?7:days
  return {from:now-n*86400000,to:now+1,label:n>=36500?'全部已沉淀历史':`近${n}天`}
}

/** Only visible dialogue and tool names/commands, never model reasoning. */
export function progressEvents(text, engine, { timestamp = 0 } = {}) {
  if (engine === 'kimi') return parseWire(text).events.map(e => ({ ...e, text: clean(e.text), command: clean(e.path, 300) }))
  const records = []
  for (const line of String(text).split('\n')) {
    try { records.push(JSON.parse(line)) } catch { /* partial or malformed line */ }
  }
  const modern = engine === 'codex' && records.some(r => r.type === 'response_item' && r.payload?.type === 'message')
  const out = [], seen = new Set()
  let ts = timestamp || 0
  for (const r of records) {
    const n = typeof r.timestamp === 'number' ? r.timestamp : Date.parse(r.timestamp || r.time || '')
    if (Number.isFinite(n)) ts = n
    let role, text = '', command = ''
    if (engine === 'codex') {
      const p = r.payload || {}
      if (r.type === 'response_item' && p.type === 'message' && p.channel !== 'analysis') { role = p.role; text = contentText(p.content) }
      else if (!modern && ['agent_message', 'user_message'].includes(p.type)) { role = p.type === 'agent_message' ? 'assistant' : 'user'; text = p.message }
      else if (p.type === 'function_call') {
        let a = {}; try { a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || {} } catch { /* malformed args */ }
        command = a.cmd || a.command || a.code || p.name || ''
      }
    } else {
      const m = r.message || {}
      role = m.role || r.type
      text = contentText(m.content)
      const tools = Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_use') : []
      command = tools.map(c => c.input?.command || c.input?.file_path || c.name).join('\n')
    }
    if (['user', 'assistant'].includes(role) && text?.trim() && !injected(text)) {
      // Native transcripts can mirror one visible message in multiple records.
      const key = `${role}|${ts}|${text}`
      if (!seen.has(key)) { out.push({ type: role, text: clean(text), ts }); seen.add(key) }
    }
    if (command) out.push({ type: 'file_op', command: clean(Array.isArray(command) ? command.join(' ') : command, 300), ts })
  }
  return out
}

export function reportedStatus(reply) {
  if (!reply) return 'unconfirmed'
  if (/尚未|未完成|还没|无法确认|仍未|待核实|暂未|未解决|未验证|待验证|仍需|尚需|还需|部分恢复|部分完成|已截断/.test(reply)) return 'unconfirmed'
  if (/失败|受阻|卡住|无法继续|需要.*(?:授权|确认)/.test(reply)) return 'blocked'
  if (/已(?:完成|修复|解决|清理|删除|上线|改为|恢复|部署)|验证通过|正常.*延迟.*0/.test(reply)) return 'reported_complete'
  return 'in_progress'
}

export function tasksFromEvents(events, source, { carry = null, limit = 60 } = {}) {
  const tasks = carry ? [structuredClone(carry)] : []
  let current = tasks[0] || null, topic = current?.context || '', subject = current?.subject || ''
  const subjectOf = text => (String(text).match(/(?:\d{1,3}\.){3}\d{1,3}|(?<!\d)[.。]\d{2,3}\b|\b\d{2,3}(?=服务器|数据库|主机|节点)/g) || []).join(' ')
  for (const e of events) {
    if (!current && source.sourceTruncated && e.type === 'assistant' && e.text?.trim()) {
      current = { id: hash(`${source.serverId}/${source.sessionId}/${source.sourceKind === 'archive_index' ? 'index-excerpt' : 'uncovered-request'}`), ...source,
        title: '原始交办未覆盖的进展', context: '日志尾部有处理回复，但原始交办不在读取范围内。', request: '', requestMissing: true,
        requestedAt: 0, updatedAt: e.ts || 0, status: 'unconfirmed', result: '', subject: '', progress: [], actions: [], risks: [] }
      tasks.push(current)
    }
    if (e.type === 'user') {
      const user = clean(e.text, 1200).trim()
      if (!user || injected(user)) continue
      // Short follow-ups retain the preceding request as context, not as a new
      // independently completed task. Evidence still includes the actual input.
      const explicitSubject = subjectOf(user)
      if (explicitSubject || user.length > 24 || !topic) topic = user
      subject = explicitSubject || subject
      const id = hash(`${source.serverId}/${source.sessionId}/${e.ts}/${user}`)
      current = { id, ...source, title: user.slice(0, 160), context: topic.slice(0, 800), requestedAt: e.ts || 0,
        updatedAt: e.ts || 0, status: 'unconfirmed', request: user, result: '', subject, progress: [], actions: [], risks: [] }
      tasks.push(current)
    } else if (current && e.type === 'assistant' && e.text?.trim()) {
      current.progress.push({ ts: e.ts || current.updatedAt, text: clean(e.text) })
      current.progress = current.progress.slice(-6)
      current.result = clean(e.text)
      const lines = current.result.split('\n').map(l => l.trim()).filter(Boolean)
      current.causes = [...new Set([...(current.causes || []), ...lines.filter(l => /根因|原因|之所以|由于|问题出在|导致/.test(l))])].slice(-6)
      current.lessons = [...new Set([...(current.lessons || []), ...lines.filter(l => /教训|经验|避免|防止|预防|以后|后续.*(?:应该|需要|必须)|不能再/.test(l))])].slice(-6)
      subject = subjectOf(e.text) || subject
      current.subject = subject
      current.updatedAt = e.ts || current.updatedAt
      current.status = current.requestMissing ? 'unconfirmed' : reportedStatus(current.result)
      current.risks = current.result.split('\n').filter(l => /(?:仍|还|尚|高水位|风险|告警|待核实)/.test(l) || /(?:磁盘|使用率|占用)[^\n]{0,24}(?:9\d|100)%/.test(l)).slice(0, 4)
    } else if (current && e.type === 'file_op' && e.command) {
      if (!current.actions.includes(e.command)) current.actions.push(e.command)
      current.actions = current.actions.slice(-6)
    }
  }
  for (const t of tasks) {
    t.causes ||= []; t.lessons ||= []
  }
  return tasks.slice(-limit)
}

export function questionTerms(question, projects = []) {
  const q = String(question || '').toLowerCase()
  const terms = [...new Set(q.replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, '').match(/(?:\d{1,3}\.){3}\d{1,3}|\b\d{2,3}\b(?!\s*(?:[天日周年月号个条项次%]|小时|分钟|秒|gi?b|mi?b))|[a-z][a-z0-9_-]{2,}/g) || [])]
  const groups = [['磁盘','空间','存储','容量'],['隧道','tunnel','ssh','转发','网络通道'],['审批','权限','授权'],['部署','上线','发布'],['消息','对话','会话'],['根因','原因','导致'],['经验','教训','避免'],['数据库','mysql','mongodb'],['备份','恢复'],['清理','删除'],['日志','binlog'],['复制','主从'],['同步'],['模型']]
  for (const group of groups) if (group.some(w => q.includes(w))) terms.push(...group)
  const known = projects.filter(p => q.includes(p.toLowerCase()))
  if (!terms.length && !known.length && q.trim()) {
    const remainder = q.replace(/今天|昨天|现在|目前|请问|帮我|查看|看看|情况|怎么样|什么|哪些|项目|工作|进展|进度|任务|解决|完成|了吗|如何|是否|有没有|有多少|还有|服务器|整体|最新|的|了|吗|呢|？|\?|[，。,:：\s]/g, '').trim()
    if (remainder && !/^(未|没|已|未完成|没解决|进行中|风险|阻塞|汇总|总结|在做|做了)$/.test(remainder)) {
      const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(remainder)].filter(s => s.isWordLike && s.segment.length >= 2).map(s => s.segment)
      terms.push(...words)
    }
  }
  return { terms: [...new Set(terms.filter(t => !known.some(p => p.toLowerCase() === t)))], projects: known }
}

// Hosts and known projects have separate scope/alias rules. A planner-produced
// phrase such as “120磁盘” is a topic plus host, not a literal proper name that
// must occur verbatim in every follow-up (“保留7天” may be the actual request).
export function progressEntities(entities, question, projects = []) {
  return [...new Set((Array.isArray(entities)?entities:[]).flatMap(value=>{
    if(typeof value!=='string'||value.length>30)return[]
    let core=value.toLowerCase()
    for(const p of projects)core=core.split(p.toLowerCase()).join('')
    core=core.replace(/当前|现在|目前|最后|所有|全部|服务器|数据库|主机|节点|磁盘|空间|隧道|备用|集群|项目|服务|故障|问题|排查|检查|整改|修复|解决|清理|进展|状态|风险|权限|审批|同步|迁移|日志|mysql|mongodb|codex|kimi|claude|ssh|tls|ssl/g,'').trim()
    if(core.length<2||/^[\d.。\s]+$/.test(core)||!String(question).toLowerCase().includes(core))return[]
    return[core]
  }))].slice(0,4)
}

export function queryProgress(all, { q = '', project = '', host = '', days = 7, now = Date.now(), limit = 30, searchTerms, requiredTerms = [], intent = '', from, to } = {}) {
  const knownProjects = [...new Set(all.map(t => t.project))]
  const parsed = questionTerms(q, knownProjects)
  const terms = searchTerms || parsed.terms, projects = parsed.projects
  const cutoff = from ?? now - Math.max(1, Math.min(36500, Number(days) || 7)) * 86400000
  const candidates = all.filter(t => t.updatedAt >= cutoff && (!to || t.updatedAt < to) && (!project || t.project === project) && (!host || t.serverId === host) && (!projects.length || projects.includes(t.project)))
  const scored = candidates.map(t => {
    const hay = `${t.project}\n${t.subject || ''}\n${t.context}\n${t.request}\n${t.result}\n${(t.causes || []).join('\n')}\n${(t.lessons || []).join('\n')}\n${t.actions.join('\n')}`.toLowerCase()
    // The assistant's own acceptance/development conversation quotes business
    // questions. It is not evidence of work on that business object.
    if (/隧道|tunnel|网络通道/i.test(q) && !/小助理|问答|检索|验收/.test(q)) {
      const meta = `${t.context}\n${t.request}\n${t.result}`
      if (/小助理|问答层|查询规划|历史沉淀/.test(meta) && /检索|逐段证据|验收|归档导入|读取范围/.test(meta)) return { t, score: -1 }
    }
    const hosts = terms.filter(word => /^(?:[.。]?\d{2,3}|(?:\d{1,3}\.){3}\d{1,3})$/.test(word))
    const explicitRequestHosts = `${t.request}\n${t.context}`.match(/(?:\d{1,3}\.){3}\d{1,3}|[.。]\d{2,3}\b|\b\d{2,3}(?=服务器|数据库|主机|节点)/g) || []
    if (hosts.length && explicitRequestHosts.length && !hosts.every(h => explicitRequestHosts.some(v => v.replace(/^。/,'.') === h || v.replace(/^[.。]/,'') === h.replace(/^[.。]/,'') || v.endsWith('.'+h.replace(/^[.。]/,''))))) return { t, score: -1 }
    if (!requiredTerms.every(w => hay.includes(w.toLowerCase()))) return { t, score: -1 }
    if (hosts.length && !hosts.every(word => hay.includes(word))) return { t, score: -1 }
    const topics = terms.filter(w => !hosts.includes(w))
    if (topics.length && !topics.some(w => hay.includes(w))) return { t, score: -1 }
    if (/隧道|tunnel|网络通道/i.test(q) && !/隧道|tunnel|转发/i.test(`${t.request}\n${t.context}\n${t.result}`)) return { t, score: -1 }
    const score = terms.reduce((n, word) => n + (hay.includes(word) ? (/\d/.test(word) ? 8 : 2) : 0), 0)
    const requested = `${t.request}\n${t.context}`.toLowerCase()
    return { t, score, instructionMatch: topics.some(w => requested.includes(w)) ? 1 : 0 }
  }).filter(x => x.score >= 0 && (!terms.length || x.score > 0))
  // Most recent answer within a matching project matters more than an old reply
  // repeating the host number; keep relevance for matching, chronology for truth.
  scored.sort((a, b) => (b.instructionMatch || 0)-(a.instructionMatch || 0) || b.t.updatedAt - a.t.updatedAt || b.score - a.score)
  let selected = ((!q || (intent === 'overview' && !terms.length)) && !project) ? [...new Map([...scored].reverse().map(x => [`${x.t.serverId}/${x.t.project}`, x])).values()].sort((a, b) => b.t.updatedAt - a.t.updatedAt) : scored
  if (['risks', 'completed'].includes(intent)) {
    // A later report for the same topic supersedes an earlier completion.
    selected = [...new Map([...selected].reverse().map(x => [`${x.t.serverId}/${x.t.project}/${x.t.context}`, x])).values()].sort((a,b) => b.t.updatedAt-a.t.updatedAt)
    selected = selected.filter(x => intent === 'completed' ? x.t.status === 'reported_complete' : x.t.status !== 'reported_complete' || x.t.risks.length)
  }
  const tasks = selected.slice(0, Math.min(40, limit)).map(x => x.t)
  return { tasks, total: scored.length, terms, view: !q && !project ? 'project_latest' : 'task_history', windowTruncated: selected.length > tasks.length, answer: tasks.length
    ? `${!q && !project ? `已找到${scored.length}条任务记录，以下按项目展示最新进展；选择项目可查看处理过程。` : `找到 ${scored.length} 条相关任务记录，按最近进展排列。`}“记录报告完成”来自当时回复，不代表当前服务器状态已重新检查。`
    : '当前范围尚未找到相关处理记录，尚无法确认。正在查询时会继续规划检索；可查看资料覆盖详情，或扩大时间范围。' }
}
