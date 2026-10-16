import { tasksFromEvents } from './progress-evidence.js'

// Use the existing archive index immediately while full task extraction catches
// up. These are explicitly incomplete excerpts, never fabricated task requests.
export function archivedProgress(docs, { terms = [], requiredTerms = [], host = '', project = '', from = 0, to, limit = 8 } = {}, alias = p => p) {
  if (!terms.length) return []
  const ranked = []
  for (const d of docs) {
    if ((host && d.host !== host) || (project && alias(d.project) !== project) || Number(d.lastAt) < from || (to && Number(d.startedAt) >= to)) continue
    const text = [d.firstPrompt || '', ...(d.texts || [])]
    const hay = text.join('\n').toLowerCase()
    if (!requiredTerms.every(t => hay.includes(t.toLowerCase()))) continue
    const score = terms.reduce((n, t) => n + (hay.includes(t.toLowerCase()) ? 1 : 0), 0)
    if (score) ranked.push({ d, text, score })
  }
  ranked.sort((a,b) => b.score-a.score || Number(b.d.lastAt)-Number(a.d.lastAt))
  return ranked.slice(0, limit).map(({ d, text }) => {
    const indexes = new Set()
    for (let i = 0; i < text.length; i++) if (terms.some(t => text[i].toLowerCase().includes(t.toLowerCase()))) {
      for (const j of [i-1,i,i+1]) if (j >= 0 && j < text.length) indexes.add(j)
    }
    const body = [...indexes].sort((a,b) => a-b).slice(-10).map(i => text[i]).join('\n\n')
    const task = tasksFromEvents([{ type: 'assistant', text: body, ts: Number(d.lastAt) || 0 }], {
      serverId: d.host, project: alias(d.project), sessionId: d.session, engine: d.engine,
      sourceKind: 'archive_index', archiveProject: d.project, sourceTruncated: true, excerptTimestampUnknown: true,
    })[0]
    if (task) { task.title = '历史会话中的相关处理记录'; task.context = '来自历史索引摘录，原始交办未完整覆盖；所示时间为会话最后记录时间，片段时刻尚未单独校验。' }
    return task
  }).filter(Boolean)
}
