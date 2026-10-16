// server/mcp/tools.js
// 工具 = 任务形状：一次调用解决一个问题，返回体是为 LLM 裁剪过的。
// 反面是薄代理（tool≈REST 端点）——那会把"取全量→自己筛→再逐个取"的苦转嫁给 LLM，
// 调用次数多、上下文烧得快。这里每个工具都自带筛选与预算。
//
// 预算纪律：fitResponse 算的是**整个返回对象**，超出时给 hasMore+nextOffset 让调用方分批续取，
// 绝不静默丢数据——LLM 把残缺当全集会据此下错误结论。
import { fitResponse, clip, sessionRow, normalizeCount, parseEnvNumber, MAX_BYTES } from './wire.js'
import { findSessions, isStuck } from './filters.js'

const notFound = (what) => ({ ok: false, message: `找不到 ${what}` })

// history_search 的 limit：默认值给够一次 fitResponse 常见能装下的行数，上限对齐 hub
// /api/v2/events 自己的硬顶（500）——传更大的值送到 hub 也会被那边砍掉，这里同步设一样的
// 上限只是为了让"调用方传了什么就该拿到什么，而不是被两层各砍一刀却互相不知道"更好懂。
const HISTORY_DEFAULT_LIMIT = parseEnvNumber('WA_MCP_HISTORY_LIMIT', 50)
const HISTORY_MAX_LIMIT = parseEnvNumber('WA_MCP_HISTORY_MAX', 500)

/**
 * limit 语义（不是 offset）：0/负数/非数字都不是"我要这个数量"的合理解释，回落默认值；
 * 超过上限砍到上限。与 filters.js#normalizeLimit 同一条纪律，独立实现是因为这两个工具
 * 面向的调用方/数据源不同，不该共用同一个默认值/上限常量（跟 STUCK_IDLE_MS 旁边注释
 * 「回收是破坏性动作，观测不是，两者该能独立调」是同一个理由）。
 */
function normalizeHistoryLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return HISTORY_DEFAULT_LIMIT
  return Math.min(Math.floor(n), HISTORY_MAX_LIMIT)
}

/**
 * 历史事件（Mongo 持久投影）人话摘要——**不是**同名的 session_tail/session_detail 摘要器：
 * 那两个读的是 agent 实时事件的原始字段（verb/path/text），这里读的是已经过
 * event-envelope.js#normalizeEvent 归一化+摘要过的 payload（verb/path/cmdPreview/summary/
 * additions/deletions/status），字段集完全不同，混用会读到 undefined。
 */
function historySummary(e) {
  const p = e.payload || {}
  if (p.summary) return p.summary
  if (p.cmdPreview) return `执行命令 ${p.cmdPreview}`
  if (p.verb) {
    const parts = [p.verb, p.path || ''].filter(Boolean)
    const stats = []
    if (p.additions != null) stats.push(`+${p.additions}`)
    if (p.deletions != null) stats.push(`-${p.deletions}`)
    return stats.length ? `${parts.join(' ')} (${stats.join('/')})` : parts.join(' ')
  }
  if (p.status) return `状态: ${p.status}`
  return e.type || 'unknown'
}

/** 历史行投影：只留 LLM 判断"那时候发生了什么"所需的字段，绝不透传原始 payload。 */
function historyRow(e) {
  return {
    occurredAt: e.occurredAt ?? null,
    type: clip(e.type ?? 'unknown', 100),
    project: clip(e.project ?? '', 300),
    serverId: clip(e.serverId ?? '', 300),
    session: clip(e.sessionId ?? e.realSessionId ?? '', 300),
    summary: clip(historySummary(e)),
  }
}

/**
 * file_op 事件没有 text 字段——真实字段是 verb/path/additions/deletions
 * （见 server/agent.js pushEvent 调用点，约 278/317/325 行：Read→读取文件，
 * Write→创建文件+additions，Edit/MultiEdit→更新文件+additions/deletions，
 * Bash→执行命令+path=命令，其余工具→"工具"+path=工具名）。
 * 原实现对 file_op 直接读 e.text，而 file_op 从不带 text，于是这类行全部
 * 序列化成 {ts, text:""} 的空壳——实测 55~80% 的返回行是这种空壳。
 * 这里把 verb/path/additions/deletions 拼成一行人话，让每条 file_op 都有内容。
 */
function fileOpSummary(e) {
  const verb = e.verb || '操作'
  const parts = [verb, e.path || ''].filter(Boolean)
  const stats = []
  if (e.additions != null) stats.push(`+${e.additions}`)
  if (e.deletions != null) stats.push(`-${e.deletions}`)
  return stats.length ? `${parts.join(' ')} (${stats.join('/')})` : parts.join(' ')
}

/**
 * 事件行投影：session_detail 与 session_tail 共用同一份字段——别让未来加字段只套用到一个工具上。
 * 真实 hub 事件的判别字段是 `type`（值：assistant/user/file_op），**没有 `role` 字段**——
 * 这是本文件曾经的根因 bug：手写假 hub fixture 发明了 role，测试全绿，生产里读到的永远是
 * undefined。这里改读 type，并对 file_op 类型渲染出人话摘要而不是空 text。
 */
function eventRow(e) {
  const type = e.type ?? 'unknown'
  const text = type === 'file_op' ? fileOpSummary(e) : (e.text ?? '')
  return { ts: e.ts, type, text: clip(text) }
}

/**
 * 取最近 N 条事件，并按"最新在前"排序后再交给 fitResponse。
 * 两个事件源（getEvents 返回的 events）都是升序（旧→新）；一个叫"tail"的工具如果直接把
 * 升序切片交给 fitResponse，预算超出时 fitResponse 会从数组末尾 pop——那会先丢最新的事件，
 * 留下最陈旧的，正好和"tail"该有的语义相反。这里在交给 fitResponse 之前先反转成新→旧，
 * pop 掉的就是本批里最旧的，成功保留的第一条永远是最新事件。
 *
 * 已知限制（不在本次修复范围内，P2 跟进）：offset 续取只在"快照不变"的前提下可靠。
 * 如果两次调用之间会话还在写新事件，重新计算出的窗口会整体前移，中间写入的事件会被跳过
 * （reviewer 实测：ts 33–37 两批续取都没被返回过）。要跟一个仍在增长的实时会话，
 * 应该用 hub 自带的 cursor（session_tail 的 since/cursor 参数），那才是快照稳定的续传机制；
 * offset 只适合对着一份已经不再变化的快照分批拉取。
 */
function recentEventRows(events, limit) {
  return (events ?? []).slice(-limit).reverse().map(eventRow)
}

/** hasMore 时把 hint 拓展一句：offset 续取对正在增长的会话不安全，引导调用方改用 cursor。 */
function withLiveHint(res) {
  if (!res.hasMore) return res
  return {
    ...res,
    hint: `${res.hint}（若会话仍在写入新事件，offset 续取可能跳过中间写入的行——请改用 cursor 做快照稳定的续传，而非 offset）`,
  }
}

export function createTools(client) {
  return {
    /** Same task evidence as the web assistant; no command execution or approvals. */
    async project_progress(args = {}) {
      const r = await client.getProgress({ q: String(args.question || '').slice(0, 500), project: args.project, host: args.serverId, days: Math.min(36500, Math.max(1, Number(args.days) || 7)) })
      const rows = (r.tasks || []).map(t => ({ taskId: t.id, serverId: t.serverId, project: t.project, sessionId: t.sessionId, engine: t.engine,
        status: t.status, updatedAt: t.updatedAt, request: clip(t.title, 160), latestReportedResult: clip(t.result, 700),
        risks: (t.risks || []).map(r => clip(r, 200)), sourceTruncated: !!t.sourceTruncated, requestMissing: !!t.requestMissing }))
      const citeable=r.answerSections?.filter(s=>typeof s.text==='string'&&Array.isArray(s.sources))
      let previousMetadata=''
      const citedAnswer=citeable?.length?citeable.map(s=>{
        const lines=s.text.split('\n'),metadata=/^历史(?:记录报告|索引摘录)/.test(lines[0])&&lines.length>1?lines.shift():''
        const body=metadata&&metadata===previousMetadata?lines.join('\n'):s.text
        previousMetadata=metadata
        return`[${s.sources.join(', ')}] ${body}`
      }).join('\n\n'):r.answer
      const base = { available: !!r.updatedAt || r.live?.available === true, refreshing: r.refreshing, analysis: r.analysis, queryWindow:r.queryWindow, updatedAt: r.updatedAt, total: r.total, message: clip(citedAnswer, 1200), answerExcerptTruncated: (citedAnswer?.length || 0) > 1200,
        answerSources: r.answerSources?.filter(s => r.answerSections?.some(p => p.sources.includes(s.id))).slice(0, 8).map(s => ({ ...s, label: clip(s.label, 80) })), historyExpanded: r.historyExpanded,
        live: r.live ? { available: r.live.available, observedAt: r.live.observedAt, scope: r.live.scope, serverCount: r.live.serverCount, onlineCount: r.live.onlineCount, runningCount: r.live.runningCount, pendingCount: r.live.pendingCount, retiredAgents:r.live.retiredAgents?.slice(0,20),note: r.live.note } : undefined,
        error: r.error || undefined, view: r.view, sourceWindowTruncated: !!r.windowTruncated,
        ...(r.windowTruncated ? { windowHint: '当前任务窗口最多30条，请按项目、节点或关键词缩小范围；offset仅续取本窗口。' } : {}),
        coverage: { archiveEnabled: r.coverage?.archive?.enabled, durable: r.coverage?.durable, backfill: r.coverage?.backfill, nativeHistory: r.coverage?.nativeHistory, knowledgeError: r.coverage?.knowledgeError, sourceErrors: r.coverage?.sources?.filter(s => s.error).length || 0, truncatedSources: r.coverage?.sources?.filter(s => s.truncated).length || 0 },
        ...(r.refreshing || ['retrieving','planning','answering'].includes(r.analysis?.status) ? { retryAfterMs: 2500 } : {}) }
      const offset = normalizeCount(args.offset, 0)
      let packed = fitResponse(base, 'tasks', rows, { offset })
      if (Buffer.byteLength(JSON.stringify(packed)) > MAX_BYTES) {
        base.message = clip(base.message, 800); base.answerExcerptTruncated = true
        base.answerSources = base.answerSources?.map(({ id, taskId, observedAt }) => ({ id, taskId, observedAt }))
        packed = fitResponse(base, 'tasks', rows.map(t => ({ ...t, request: clip(t.request,100), latestReportedResult: clip(t.latestReportedResult,300), risks:t.risks.slice(0,2).map(s => clip(s,80)), taskExcerptTruncated:true })), { offset })
      }
      if (Buffer.byteLength(JSON.stringify(packed)) > MAX_BYTES) return { available: base.available, total: r.total, analysis:r.analysis, message:clip(citedAnswer,400),answerExcerptTruncated:true,
        tasks:rows.slice(offset,offset+1).map(t=>({taskId:t.taskId,project:clip(t.project,120),serverId:clip(t.serverId,64),status:t.status,updatedAt:t.updatedAt})),hasMore:offset+1<rows.length,nextOffset:offset+1,hint:'回答与任务已精简，请按taskId调用task_evidence，或缩小项目范围。' }
      return packed
    },
    async task_evidence(args = {}) {
      if (!args.taskId) return notFound('taskId')
      const { task: t } = await client.getTaskEvidence(String(args.taskId))
      const evidence = [{ kind: 'request', ts: t.requestedAt, text: clip(t.request, 2000) }, ...(t.causes || []).map(text => ({ kind: 'reported_cause', text: clip(text, 500) })), ...(t.lessons || []).map(text => ({ kind: 'reported_lesson', text: clip(text, 500) })), ...(t.progress || []).map(p => ({ kind: 'reply', ts: p.ts, text: clip(p.text, 2000), excerptTruncated: p.text.length > 2000 })), ...(t.actions || []).map(a => ({ kind: 'operation', text: clip(a, 300) }))]
      return fitResponse({ taskId: t.id, serverId: t.serverId, project: t.project, sessionId: t.sessionId, status: t.status,
        sourceTruncated: !!t.sourceTruncated, requestMissing: !!t.requestMissing, note: 'serverId是CLI日志来源节点，不是业务操作目标的别名；目标看交办与原文。回复与操作均为当时记录，不是重新执行验证。工具不执行命令、不审批。' }, 'evidence', evidence, { offset: normalizeCount(args.offset, 0) })
    },
    /** 5 台机一屏摘要。闸门饱和度必须在里面——它是「全部超时」最常见的真因。 */
    async fleet_overview(args = {}, nowMs = Date.now()) {
      const st = await client.getState()
      const sessions = st.sessions ?? []
      const rows = (st.servers ?? []).map((s) => {
        const g = s.sessionGate || {}
        const mine = sessions.filter((x) => x.serverId === s.id)
        return {
          id: s.id,
          online: !!s.online,
          gate: g.max ? `${g.active}/${g.max}` : null,
          gateFull: !!(g.max && g.active >= g.max),
          queued: g.queued ?? 0,
          sessions: mine.length,
          running: mine.filter((x) => x.inflight).length,
          stuck: mine.filter((x) => isStuck(x, nowMs)).length,
        }
      })
      return fitResponse(
        { pending: (st.pendingActions ?? []).length, asOf: nowMs },
        'servers', rows, { offset: normalizeCount(args.offset, 0) },
      )
    },

    /**
     * 按条件找会话。排序方向随查询意图切换（见 filters.js#findSessions）：
     * stuck=true 按空闲降序（worst-first，故障分诊）；其余（含默认无过滤）按
     * 空闲升序，即最近活跃优先——"现在什么状况"要的是最近，不是被 20 条上限
     * 挤到最前面的月龄化石。
     */
    async session_find(args = {}, nowMs = Date.now()) {
      const st = await client.getState()
      const hits = findSessions(st.sessions ?? [], args, nowMs)
      return fitResponse({}, 'sessions', hits.map((s) => sessionRow(s, nowMs)),
        { offset: normalizeCount(args.offset, 0) })
    },

    /** 单会话详情 + 最近事件（最新在前）。 */
    async session_detail(args = {}, nowMs = Date.now()) {
      const { sessionId } = args
      const events = normalizeCount(args.events, 10)
      const offset = normalizeCount(args.offset, 0)
      const st = await client.getState()
      const s = (st.sessions ?? []).find((x) => x.id === sessionId)
      if (!s) return notFound(`会话 ${sessionId}`)
      // 不 catch：拿不到事件是"我不知道"，不是"这个会话没有事件"。任何 rejection
      // （超时/5xx/断网）都必须原样冒泡给上层 classifyError 边界去分类，绝不能在这里
      // 静默吞成 { events: [] } 冒充一个"确认无事件"的成功结果——那是本项目被烧过的
      // 那类 bug：把"不知道"报成"事实"。与 session_tail 保持一致。
      const ev = await client.getEvents(sessionId)
      const rows = recentEventRows(ev.events, events)
      return withLiveHint(fitResponse(
        { session: { ...sessionRow(s, nowMs), stuck: isStuck(s, nowMs) } },
        'events', rows, { offset },
      ))
    },

    /** 只取最近事件（最新在前），支持 cursor（服务端游标）与 offset（本次结果内分批）。 */
    async session_tail(args = {}) {
      const { sessionId, since } = args
      const limit = normalizeCount(args.limit, 20)
      const offset = normalizeCount(args.offset, 0)
      const ev = await client.getEvents(sessionId, since)
      const rows = recentEventRows(ev.events, limit)
      // hub 的 /events 响应里根本没有 `cursor` 字段——真实字段是 lastSeq（见 server/event-seq.js
      // withSeqBounds）。此前这里读 ev.cursor 恒为 undefined，cursor 恒为 null，
      // 而 hint 文案却教调用方"用 cursor 续传"——一条打不通的建议比诚实的限制更糟。
      // 没有 seq 承载事件时（如无 seq 的 codex 影子扫描）lastSeq 本就是 null，属实报告即可。
      return withLiveHint(fitResponse({ cursor: ev.lastSeq ?? null }, 'events', rows, { offset }))
    },

    /**
     * 长程历史查询（Mongo 持久投影，周级别，与 session_tail/session_detail 的"agent 内存
     * 最近 ~150 条"是两个互补的数据源——见 tool-defs.js 里的对比描述）。
     *
     * 两条纪律都不能少：
     * ① **必须收窄**：不给任何过滤条件时直接拒绝，不去扫 2.8 万+ 条历史再截断——那种"扫全量
     *    再砍到预算"的响应会让 LLM 把"恰好排在前 N 条"误当成"这就是相关结果"。
     * ② **available:false ≠ 空结果**：hub 在 Mongo 不可用时明确报 available:false，这里必须
     *    原样识别并报成"查不到"，不能把它和"确实没有匹配"的空数组混为一谈——见本文件模块
     *    头部注释引用的 dont-ship-what-nobody-reads/四次"前端≠后端真相"教训，同一类问题。
     */
    async history_search(args = {}) {
      const { session, project, serverId, type } = args
      const hasFilter = !!session || !!project || !!serverId || !!type
        || args.fromMs != null || args.toMs != null
      if (!hasFilter) {
        return {
          ok: false,
          message: '历史事件库有 2.8 万+ 条记录，history_search 必须至少给一个收窄条件'
            + '（session/project/serverId/type/fromMs/toMs）——不收窄等于让工具替你倾倒全部历史，'
            + '不是查询。若只想看"现在什么状况"，改用 session_tail/session_find。',
        }
      }
      const limit = normalizeHistoryLimit(args.limit)
      const offset = normalizeCount(args.offset, 0)
      const r = await client.getHistory({
        session, project, server: serverId, type,
        from: args.fromMs, to: args.toMs, limit,
      })
      if (r.available === false) {
        // 诚实规则：这是"我查不到"，不是"没有历史"。绝不能把这个当空结果吐给 LLM——
        // 它会据此下"这段时间什么都没发生"的错误结论。
        return {
          ok: false,
          available: false,
          message: '历史存储（Mongo）当前不可用——这是"我查不到"，不代表这段时间真的什么都没发生；'
            + '请稍后重试，或改用 session_tail 看实时活动。',
        }
      }
      const rows = (r.events ?? []).map(historyRow)
      return fitResponse({ available: true }, 'events', rows, { offset })
    },

    /** 只读看待办。**没有 resolve**——审批是这套系统里唯一的人类控制点。 */
    async pending_list(args = {}) {
      const p = await client.getPending()
      const items = (p.items ?? []).map((i) => ({
        id: i.id, kind: i.kind, sessionId: i.sessionId, serverId: i.serverId,
        project: i.project, title: clip(i.title ?? '', 100), ageMin: i.ageMin, overdue: i.overdue,
      }))
      return fitResponse(
        { total: p.total ?? items.length, overdue: p.overdueCount ?? 0 },
        'items', items, { offset: normalizeCount(args.offset, 0) },
      )
    },
  }
}

export { MAX_BYTES }
