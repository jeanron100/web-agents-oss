import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { progressEvents, tasksFromEvents, queryProgress, questionTerms, progressEntities, progressWindow, PROGRESS_PARSER_VERSION } from './progress-evidence.js'
import { liveProgress } from './progress-live.js'
import { redactString } from './event-redaction.js'

const TAIL_BYTES = 4 * 1024 * 1024
const MAX_FILES = 24
const RETAIN = 1000

export function createProgressAssistant({ file, agents, retiredAgents = [], getState, fetchJson, archiveStatus, repository, backfill, nativeBackfill, searchArchives, model, tunnelProbe, now = Date.now }) {
  let records = [], sources = {}, projects = [], updatedAt = 0, loading = null, lastError = null, deferredSessions = 0
  const refreshedScopes = new Map()
  const answers = new Map(), persistFlights = new Map(), spool = file + '.pending'
  let knowledgeError = null
  let seeded = false
  const persist = async tasks => {
    if (!repository || !tasks.length) return
    const raw = JSON.stringify(tasks), key = crypto.createHash('sha256').update(raw).digest('hex')
    if (persistFlights.has(key)) return persistFlights.get(key)
    const job = (async () => {
      await fs.mkdir(spool, { recursive: true, mode: 0o700 })
      const pending = path.join(spool, key + '.json'), temporary = pending + '.' + crypto.randomUUID() + '.tmp'
      await fs.writeFile(temporary, raw, { mode: 0o600 })
      await fs.rename(temporary, pending)
      try { await repository.put(tasks); await fs.unlink(pending); knowledgeError = null }
      catch { knowledgeError = '知识库暂不可用，新增证据已保存在本地待同步' }
    })().finally(() => persistFlights.delete(key))
    persistFlights.set(key,job);return job
  }
  const drain = async () => {
    if (!repository) return
    const files = await fs.readdir(spool).catch(() => [])
    for (const f of files.filter(f=>f.endsWith('.json')&&!persistFlights.has(f.slice(0,-5))).slice(0, 10)) {
      try { await repository.put(JSON.parse(await fs.readFile(path.join(spool, f), 'utf8'))); await fs.unlink(path.join(spool, f)); knowledgeError = null }
      catch { knowledgeError = '知识库暂不可用，新增证据已保存在本地待同步'; break }
    }
  }
  const ready = fs.readFile(file, 'utf8').then(raw => {
    const d = JSON.parse(raw); records = d.records || []; sources = d.sources || {}; updatedAt = d.updatedAt || 0
  }).catch(() => {})
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file + '.tmp', JSON.stringify({ records, sources, updatedAt }), { mode: 0o600 })
    await fs.rename(file + '.tmp', file)
  }
  const refresh = ({ project = '', host = '' } = {}) => {
    if (loading) return loading
    loading = (async () => {
      await ready
      await drain()
      // Seed the durable store from the previously shipped recent-only cache.
      if (!seeded && repository && records.length) { await persist(records); seeded = true }
      const state = await getState()
      projects = [...new Map((state.sessions || []).map(s => [`${s.serverId}/${s.project}`, { serverId: s.serverId, project: s.project }])).values()]
      // One recent session per project/engine, bounded and rotated by last read.
      const chosen = new Map()
      for (const s of [...(state.sessions || [])].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
        if ((host && host !== s.serverId) || (project && project !== s.project)) continue
        if (!agents.some(a => a.id === s.serverId) || !path.isAbsolute(s.cwd||'')) continue
        const key = `${s.serverId}/${s.project}/${s.engine}`
        if (!chosen.has(key)) chosen.set(key, s)
      }
      const sessions = [...chosen.values()].sort((a, b) => (sources[`${a.serverId}/${a.id}`]?.checkedAt || 0) - (sources[`${b.serverId}/${b.id}`]?.checkedAt || 0)).slice(0, MAX_FILES)
      deferredSessions = Math.max(0, chosen.size - sessions.length)
      const inventories = new Map()
      await Promise.all(agents.filter(a => sessions.some(s => s.serverId === a.id)).map(async a => {
        try { inventories.set(a.id, (await fetchJson(`${a.url}/api/archive/inventory`, 15000)).files || []); delete sources[a.id] }
        catch { sources[a.id] = { error: '节点不可达，保留上次记录', checkedAt: now() } }
      }))
      const deadline = now() + 60000
      for (const s of sessions) {
        if (now() >= deadline) { deferredSessions += sessions.length - sessions.indexOf(s); break }
        const key = `${s.serverId}/${s.id}`, a = agents.find(a => a.id === s.serverId)
        if (!inventories.has(a.id)) continue
        const native = s.realSessionId || s.id
        const f = inventories.get(a.id).filter(f => f.engine === s.engine && f.path?.includes(native.replace(/^session_/, ''))).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0]
        if (!f) { sources[key] = { serverId: a.id, project: s.project, error: '未找到对应原生日志', checkedAt: now() }; continue }
        try {
          const prev = sources[key]
          if (prev?.parserVersion === PROGRESS_PARSER_VERSION && prev?.size === f.st.size && prev?.mtime === f.st.mtimeMs && !prev.error) { prev.checkedAt = now(); continue }
          const from = Math.max(0, f.st.size - TAIL_BYTES)
          const p = new URLSearchParams({ path: f.path, from: String(from), len: String(TAIL_BYTES) })
          let text = (await fetchJson(`${a.url}/api/archive/read?${p}`, 15000)).text || ''
          if (from) text = text.slice(text.indexOf('\n') + 1)
          const tasks = tasksFromEvents(progressEvents(text, s.engine), { serverId: a.id, project: s.project, sessionId: s.id, engine: s.engine, sourceTruncated: from > 0 })
          await persist(tasks)
          const ids = new Set(tasks.map(t => t.id))
          records = [...records.filter(t => !ids.has(t.id)), ...tasks].sort((a, b) => b.updatedAt - a.updatedAt).filter(t => t.updatedAt > now() - 90 * 86400000).slice(0, RETAIN)
          sources[key] = { serverId: a.id, project: s.project, parserVersion: PROGRESS_PARSER_VERSION, size: f.st.size, mtime: f.st.mtimeMs, truncated: from > 0, checkedAt: now(), tasks: tasks.length,
            ...(tasks.length ? {} : { error: '当前读取范围没有可解析的交办或回复，不能据此判断项目没有进展' }) }
        } catch { sources[key] = { ...sources[key], serverId: a.id, project: s.project, error: '读取失败，保留上次记录', checkedAt: now() } }
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      updatedAt = now(); lastError = null
      await save()
      refreshedScopes.set(`${host}/${project}`, now())
    })().catch(e => { lastError = e.message }).finally(() => { loading = null })
    return loading
  }
  return {
    refresh,
    async evidence(id) {
      await ready
      const cached = records.find(t => t.id === id), stored = await repository?.get(id).catch(() => null)
      return stored && (!cached || stored.updatedAt >= cached.updatedAt) ? stored : cached || null
    },
    async query(options = {}) {
      options = { ...options, days: Math.min(36500, Math.max(1, Number.isFinite(Number(options.days)) ? Number(options.days) || 7 : 7)) }
      const window = progressWindow(options.q, now(), options.days)
      options = { ...options, from: window.from, to: window.to }
      await ready
      const checked = refreshedScopes.get(`${options.host || ''}/${options.project || ''}`) || 0
      if (!checked || now() - checked > 300000) void refresh(options)
      const state = await getState().catch(() => ({ unavailable: true, servers: [], sessions: [], pendingActions: [] }))
      const inferredIntent = /隧道|tunnel|转发|网络通道/i.test(options.q || '') ? 'tunnels' : /服务器.*(?:多少|几台|在线)|哪些.*(?:运行|审批)|正在.*(?:运行|做)/.test(options.q || '') ? 'fleet' : /未解决|没解决|未完成|没完成|阻塞|风险/.test(options.q || '') ? 'risks' : /已完成|完成了|做完/.test(options.q || '') ? 'completed' : /进展|汇总|总结|做了什么/.test(options.q || '') ? 'overview' : 'history'
      const live = liveProgress(state, agents, { ...options, retiredAgents, now: now(), tunnels: inferredIntent === 'tunnels' && tunnelProbe ? await tunnelProbe() : undefined })
      const known = [...new Set([...records.map(t => t.project), ...(state.sessions || []).map(s => s.project)])]
      const search = async plan => {
        const terms = plan?.terms || questionTerms(options.q, known).terms
        const namedProjects = questionTerms(options.q, known).projects
        const scope = { ...options, project: options.project || (namedProjects.length===1 ? namedProjects[0] : ''), searchTerms: terms, requiredTerms: plan?.entities || [], intent: plan?.intent || inferredIntent, now: now() }
        // Work reports use the platform's Beijing calendar, rather than silently
        // treating “today” as the currently selected seven-day window.
        if (/今天|今日|昨天|昨日/.test(options.q || '')) {
          const day = Math.floor((now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
          const yesterday = /昨天|昨日/.test(options.q)
          scope.from = day - (yesterday ? 86400000 : 0); scope.to = yesterday ? day : undefined
        }
        const from = scope.from ?? now() - Math.max(1, Number(options.days) || 7) * 86400000
        const stored = await repository?.find({ ...scope, terms, from, limit: 100 }).catch(() => { knowledgeError = '知识库查询暂不可用，显示已缓存记录'; return [] }) || []
        const archived = terms.length && searchArchives ? await searchArchives({ ...scope, terms, from }) : []
        if (archived.length) await persist(archived)
        const merge = list => [...new Map([...records, ...list].map(t => [t.id, t])).values()]
        let result = { ...queryProgress(merge([...stored, ...archived]), scope), candidateWindowTruncated: stored.length >= 100 }
        if ((!result.tasks.length || scope.intent === 'tunnels') && terms.length && !/今天|今日|昨天|昨日|本周|这周|上周|本月|这个月|上个月|近.*(?:天|周|月)/.test(options.q || '') && (Number(options.days) || 7) < 90) {
          // A count question needs the last actual inventory even when recent
          // incidental SSH commands fill the generic candidate window.
          const olderTerms = scope.intent === 'tunnels' ? ['隧道','tunnel','转发'] : terms
          const older = await repository?.find({ ...scope, terms: olderTerms, from: now() - 90 * 86400000, limit: 100 }).catch(() => []) || []
          const prior = searchArchives ? await searchArchives({ ...scope, terms, from: now() - 90 * 86400000 }) : []
          if (prior.length) await persist(prior)
          const expanded = queryProgress(merge([...older, ...prior]), { ...scope, from: now()-90*86400000, days: 90 })
          if (expanded.tasks.length) result = { ...expanded, historyExpanded: true, effectiveDays: 90 }
        }
        return result
      }
      const key = JSON.stringify([options.q, options.host, options.project, options.days, options.questionId || ''])
      let result = answers.get(key)?.result || queryProgress(records, { ...options, intent: inferredIntent, now: now() })
      let analysis
      if (options.q?.trim() && model) {
        let job = answers.get(key)
        if (!job || (!options.questionId && job.done && now() - job.at > 600000)) {
          if ([...answers.values()].filter(j => !j.done).length < 3) {
            job = { at: now(), done: false, status: 'planning', result: null }; answers.set(key, job)
            const current = job
            void (async () => {
              try {
                const planned = await model('plan', { question: options.q, selectedProject: options.project || null, projects: known })
                const numeric = questionTerms(options.q, known).terms.filter(t => /^(?:[.。]?\d{2,3}|(?:\d{1,3}\.){3}\d{1,3})$/.test(t))
                const modelTerms = Array.isArray(planned.terms) ? planned.terms.filter(t => typeof t === 'string' && t.trim() && t.length <= 30).slice(0, 6).map(t => t.toLowerCase()) : []
                const originalTerms = questionTerms(options.q, known).terms
                const expandedTerms = modelTerms.flatMap(t => questionTerms(t, known).terms)
                const plan = { intent: ['history','overview','risks','completed','fleet','tunnels'].includes(planned.intent) ? planned.intent : inferredIntent,
                  terms: [...new Set([...numeric, ...(modelTerms.length ? originalTerms : []), ...modelTerms, ...expandedTerms])].slice(0, 16),
                  entities: progressEntities(planned.entities,options.q,known),
                  projects: (Array.isArray(planned.projects) ? planned.projects : []).filter(p => known.includes(p)).slice(0, 1) }
                // Do not allow a model to reinterpret an explicitly named project.
                const explicit = questionTerms(options.q, known).projects
                if (explicit.length) plan.projects = explicit.slice(0, 1)
                current.status = 'answering'
                current.result = await search(plan)
                const grouped = new Map()
                for (const t of current.result.tasks) if (!grouped.has(`${t.serverId}/${t.project}`)) grouped.set(`${t.serverId}/${t.project}`, t)
                const distinct = [...grouped.values()]
                const currentQuestion=/现在|当前|目前/.test(options.q)&&!/历史|当时|过去|退役|迁移/.test(options.q)
                const obsolete=t=>currentQuestion&&retiredAgents.some(a=>t.updatedAt<Date.parse(a.retiredAt)&&[a.id,a.id.replace(/^srv-/,'').replaceAll('-','.')].some(alias=>`${t.request}\n${t.context}\n${t.result}`.includes(alias)))
                let candidates=[...new Map([...distinct,...current.result.tasks].map(t=>[t.id,t])).values()].filter(t=>!obsolete(t))
                // For a current-state question, earlier plans cannot become
                // current blockers merely because their wording matches more.
                // Detailed historical/process questions still receive stages.
                if(currentQuestion)candidates=[...new Map(candidates.sort((a,b)=>b.updatedAt-a.updatedAt).map(t=>[`${t.serverId}/${t.project}`,t]).reverse()).values()].sort((a,b)=>b.updatedAt-a.updatedAt)
                const chosen = candidates.slice(0,12)
                const taskSources = chosen.map((t, i) => ({ source: `T${i + 1}`, taskId: t.id, project: t.project, serverId: t.serverId, engine:t.engine, at: t.updatedAt,
                  request: t.request, context: t.context, result: t.result.slice(0, 6000), resultExcerptTruncated: t.result.length > 6000, causes: t.causes, lessons: t.lessons, risks: t.risks, sourceTruncated: t.sourceTruncated, requestMissing: t.requestMissing, excerptTimestampUnknown: t.excerptTimestampUnknown }))
                const observed = plan.intent === 'tunnels' && !live.tunnels && tunnelProbe ? { ...live, tunnels: await tunnelProbe() } : live
                const readable = n => new Date(n).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间 UTC+08:00）'
                let modelLive = { ...observed, source: 'LIVE', observedAt: readable(observed.observedAt),
                  note: (plan.intent === 'tunnels' ? observed.note : '在线与CLI运行状态不证明业务任务已完成。此次没有重新检查历史任务对应的业务服务器。')+' pendingCount包含审批、提问、计划和验收等全部待办；runningCount是CLI会话数，不是去重后的项目数。',
                  ...(observed.tunnels ? { tunnels: { ...observed.tunnels, observedAt: readable(observed.tunnels.observedAt) } } : {}) }
                if (!taskSources.length && plan.entities.length && !plan.entities.every(e => known.includes(e) || agents.some(a => a.id.includes(e)))) modelLive = { source: 'LIVE', observedAt: readable(observed.observedAt), scope: observed.scope, note: '当前只读观测未覆盖所问的特定对象，不能用其他对象的状态回答。' }
                const searchAt=now(), emptyHistory=!taskSources.length&&(['history','risks','completed'].includes(plan.intent)||plan.entities.some(e=>!known.includes(e)&&!agents.some(a=>a.id.includes(e))))
                const modelTasks=taskSources.map(({serverId,...t})=>{
                  const laterSources=taskSources.filter(later=>later.serverId===serverId&&later.project===t.project&&later.at>t.at).map(later=>later.source)
                  let result=t.result
                  if(laterSources.length&&/风险|最后|当前|现在|目前/.test(options.q)&&!/早期|原来|当时|历史清单/.test(options.q)) {
                    const lines=result.split('\n'),candidate=lines.findIndex(line=>/候选|尚未删除/.test(line))
                    if(candidate>=0)result=lines.slice(0,candidate).join('\n')+'\n[早期候选清单已从当前状态上下文排除：后续已有新报告，当前剩余量未重新盘点。原文可通过任务证据读取。]'
                  }
                  return{...t,result,logSourceServerId:serverId,logSourceMeaning:'CLI日志的来源节点；业务操作目标须依据request/context/result，不能将来源节点作为目标的别名',at:readable(t.at),laterSources}
                })
                const output = emptyHistory ? {sections:[{text:`在${window.label}及已读取的执行历史范围内，未找到能回答当前问题的处理记录，尚无法确认结果。${plan.entities.length?'本次实时观测也未覆盖所问的特定对象。':''}未命中不表示任务未发生；可扩大时间范围或查看资料覆盖。`,sources:['SEARCH']}]} : await model('answer', { question: options.q, live: modelLive, tasks: modelTasks,
                  coverage: { source:'SEARCH', window: { label: window.label, from: readable(window.from), to: readable(window.to) }, historyExpanded: !!current.result.historyExpanded, candidateWindowTruncated: current.result.candidateWindowTruncated, providedTasks: taskSources.length, matchedTasks: current.result.total, imported: backfill?.status(), nativeHistory: nativeBackfill?.status(), currentSourceErrors: Object.values(sources).filter(s => s.error).length, deferredSessions, archive: archiveStatus(), knowledgeError } })
                const valid = new Set(['LIVE','SEARCH', ...taskSources.map(t => t.source)])
                let grounded = (Array.isArray(output.sections) ? output.sections : []).slice(0, 8).filter(s => typeof s.text === 'string' && s.text.trim() && Array.isArray(s.sources) && s.sources.length && s.sources.every(id => valid.has(id)))
                // Current counters have a structured source of truth. Render
                // them directly so a review item cannot become an approval or
                // the managed fleet be mistaken for all business servers.
                let liveShown=false
                grounded=grounded.flatMap(s=>{
                  if(s.sources.length!==1||s.sources[0]!=='LIVE')return[s]
                  if(liveShown)return[]
                  liveShown=true
                  const running=(observed.running||[]).slice(0,8).map(t=>`${t.serverId}/${t.project}`).join('、')
                  const tunnel=observed.tunnels?(observed.tunnels.error?' Hub隧道服务读取失败，当前不能确认服务数量。':` Hub本机观测到${observed.tunnels.units.filter(u=>u.active).length}个活跃的隧道相关服务；这不是全服务器隧道总量，服务活跃也不证明应用连通。`):''
                  return[{sources:['LIVE'],text:observed.available?`截至${readable(observed.observedAt)}，本次纳管范围内${observed.serverCount}台服务器、${observed.onlineCount}台在线，${observed.runningCount}个CLI会话运行中，${observed.pendingCount}项待办（包括审批、提问、计划或验收）。${running?'运行会话：'+running+'。':''}${tunnel} 纳管节点与历史业务盘点的统计范围不同，不能据此推断服务器增减或业务任务完成。`:'当前状态读取失败，无法确认在线、运行及待办数量；历史记录保留供核对。'}]
                })
                if (/推翻|误判|更正|旧结论|新旧结论/.test(options.q)) {
                  const quoteSource = ref => {
                    const t = taskSources.find(t => t.source === ref?.source)
                    if (!t || typeof ref.quote !== 'string' || ref.quote.length < 8 || ref.quote.length > 400) return null
                    const raw = [t.request,t.context,t.result,...(t.causes || []),...(t.lessons || [])].join('\n')
                    return raw.includes(ref.quote) ? t : null
                  }
                  grounded = grounded.filter(s => {
                    const before=quoteSource(s.comparison?.before), after=quoteSource(s.comparison?.after)
                    const explicitCorrection = /更正|修正|误判|判断.{0,12}(?:错|不对)|并非|不是[\s\S]*而是|不成立|推翻|真正.{0,8}(?:原因|根因)|corrected|was wrong|not[\s\S]*but/i.test(s.comparison?.after?.quote || '')
                    return before && after && explicitCorrection && before.at<=after.at && s.sources.includes(before.source) && s.sources.includes(after.source)
                  })
                  if (!grounded.length) {
                    grounded = [{ text:'当前检索证据尚不能确认哪些旧根因被后续结论推翻：需要同时找到旧结论和后续明确更正的原文。当前未展示未经证实的匹配卡片，可通过下方原始执行记录继续检索。', sources:['SEARCH'] }]
                    current.result={...current.result,candidateMatches:current.result.total,total:0,tasks:[]}
                  }
                }
                const sections = grounded.map(s => {
                  // A summary can combine stages of one incident. Supplement a
                  // missing reference when its exact numeric fact is present in
                  // another retrieved original, rather than citing only the
                  // final cleanup reply for earlier measurements.
                  if (!s.sources.includes('LIVE')) {
                    const plain=v=>String(v||'').replace(/[*`\s]/g,'').toLowerCase()
                    const raw=t=>plain([t.request,t.context,t.result,...(t.causes||[]),...(t.lessons||[]),...(t.risks||[])].join('\n'))
                    for(const fact of s.text.match(/\d+(?:\.\d+)?\s*(?:GiB|GB|MiB|MB|G|%|张|秒|条)/gi)||[]) {
                      const value=plain(fact)
                      if(!taskSources.some(t=>s.sources.includes(t.source)&&raw(t).includes(value))) {
                        const supporting=taskSources.find(t=>taskSources.some(cited=>s.sources.includes(cited.source)&&cited.project===t.project&&cited.serverId===t.serverId)&&raw(t).includes(value))
                        if(supporting)s.sources.push(supporting.source)
                      }
                    }
                  }
                  const historical = s.sources.some(id=>id.startsWith('T')), times = taskSources.filter(t => s.sources.includes(t.source)).map(t => t.at)
                  const timestamp = Math.max(...times)
                  const unknownTime = taskSources.some(t => s.sources.includes(t.source) && t.excerptTimestampUnknown)
                  const label = historical ? unknownTime ? '历史索引摘录（片段时间未单独核对，引用日期为会话末次时间；未重新验证业务状态）：\n' : `历史记录报告（${timestamp ? new Date(timestamp).toLocaleString('zh-CN',{ timeZone:'Asia/Shanghai',hour12:false })+' 北京时间' : '时间未记录'}；未重新验证业务状态）：\n` : ''
                  const proof = /推翻|误判|更正|旧结论|新旧结论/.test(options.q) && s.comparison ? `\n旧结论原文：“${s.comparison.before.quote}”\n后续更正原文：“${s.comparison.after.quote}”` : ''
                  let body=s.text.split('\n').map(l => redactString(l)).join('\n').slice(0,1600)
                  // Historical source-node IDs are provenance, never an implicit
                  // alias of the business target named immediately before them.
                  for(const node of new Set(taskSources.filter(t=>s.sources.includes(t.source)).map(t=>t.serverId))) {
                    body=body.split(`（${node}）`).join(`（日志来源：${node}）`).split(`(${node})`).join(`(日志来源：${node})`)
                  }
                  return { text: label + body + proof, sources: [...new Set(s.sources)] }
                })
                if (!sections.length) throw new Error('回答未提供有效证据引用，已保留原始检索结果')
                current.result = { ...current.result, liveSnapshot: observed, answer: sections.map(s => s.text).join('\n\n'), answerSections: sections, answerSources: [{ id: 'LIVE', label: '本次查询的状态快照', observedAt: observed.observedAt }, ...taskSources.map(t => ({ id: t.source, taskId: t.taskId, label: `来源 ${t.project} · ${t.serverId}`, observedAt: t.at })),{id:'SEARCH',label:`本次检索：${window.label}，命中${current.result.total}条（限已读取记录）`,observedAt:searchAt}] }
                current.status = 'done'
              } catch (e) { current.status = 'error'; current.error = String(e.message).slice(0, 200) }
              finally { current.done = true; for (const [k,j] of answers) if (j.done && answers.size > 40) answers.delete(k) }
            })()
          } else analysis = { status: 'error', error: '小助理正在处理其他问题，请稍后重试；已显示检索证据' }
        }
        if (job) { analysis = { status: job.status, error: job.error, observedAt: job.at }; if (job.result) result = job.result }
      } else if (repository || searchArchives) {
        let job = answers.get(key)
        if (!job || (job.done && now()-job.at > 30000)) {
          job = { at: now(), done: false, status: 'retrieving' }; answers.set(key, job)
          const current = job
          void search().then(result => { current.result=result; current.status='done' }).catch(() => { current.status='error'; current.error='历史检索暂未完成，保留最近记录' }).finally(() => { current.done=true })
        }
        analysis = { status: job.status, error: job.error, observedAt: job.at }
        if (job.result) result = job.result
      }
      if (!options.q) result.answer = state.unavailable ? '当前状态读取失败，无法确认在线与运行数量；以下保留已有处理记录。' : `当前纳管 ${live.serverCount} 台服务器，${live.onlineCount} 台在线；${live.runningCount} 个CLI会话运行中，${live.pendingCount} 项待办。以下为各项目最近的处理记录，业务结果以原文为准。`
      const durable = await repository?.stats().catch(() => null)
      const counts = new Map()
      for (const r of records) {
        const key = `${r.serverId}/${r.project}`
        if (!counts.has(key)) counts.set(key, { serverId: r.serverId, project: r.project })
      }
      const preview = result.tasks.map(t => ({ ...t, request: t.request.slice(0,800), result: t.result.slice(0,2000), progress: [], detailsPartial: true }))
      const { liveSnapshot, ...publicResult } = result
      return { ...publicResult, tasks: preview, queryWindow: window, analysis, live: liveSnapshot || live, projects: [...new Map([...counts.entries(), ...projects.map(p => [`${p.serverId}/${p.project}`, p]), ...(state.sessions || []).map(s => [`${s.serverId}/${s.project}`, { serverId: s.serverId, project: s.project }])]).values()],
        updatedAt, refreshing: !!loading, error: lastError, coverage: { sources: Object.values(sources), deferredSessions, maxFilesPerRefresh: MAX_FILES, tailBytes: TAIL_BYTES, retainedTasks: records.length, durable, knowledgeError, backfill: backfill?.status(), nativeHistory: nativeBackfill?.status(), archive: archiveStatus() } }
    },
  }
}
