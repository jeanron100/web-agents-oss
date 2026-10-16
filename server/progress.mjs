#!/usr/bin/env node
/**
 * 项目进展巡检 —— 给「另一个 agent」用的只读入口。
 *
 *   node server/progress.mjs            # 人读：markdown
 *   node server/progress.mjs --json     # 机读：结构化 JSON（喂给 agent / loop）
 *   node server/progress.mjs --json --hours 24
 *
 * 为什么是它而不是让 agent 自己扒 JSONL：
 *   JSONL 是权威源，但散在 5 台机上、7675 个文件、830MB，还要自己处理增量续扫、
 *   影子/平台双记录去重、Codex 与 Claude 两种格式。hub 的 /api/state 已经把这些都做完了。
 *   **别让巡检 agent 重新实现一遍解析器**——它只会实现出一个不一样的、有 bug 的版本。
 *
 * ⚠️ 只读。**刻意不提供任何 POST 能力**：巡检 agent 拿到的应该是"发生了什么"，
 *   不是"替我点批准"。审批是人的决定，别让 loop 代劳。
 */

const HUB = process.env.WA_HUB ?? 'http://localhost:8787'
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const hours = Number(args[args.indexOf('--hours') + 1]) || 24

// 「卡住」的判据：状态说在跑，但 JSONL 已经很久没动了。
// 不用「时长很长」当判据——大上下文会话首字实测就要 75 秒，长≠卡。
const STUCK_MS = 15 * 60 * 1000

const j = async (p) => {
  const r = await fetch(`${HUB}${p}`, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${p} → ${r.status}`)
  return r.json()
}

const st = await j('/api/state')
const now = Date.now()
const since = now - hours * 3600_000

const fmtAge = (ms) => {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`
}

// 按项目归并（同一项目可能横跨多台机、多个引擎）
const byProject = new Map()
for (const s of st.sessions) {
  const key = s.project || '(unknown)'
  if (!byProject.has(key)) {
    byProject.set(key, { project: key, servers: new Set(), sessions: [], cost: 0, lastActiveAt: 0 })
  }
  const p = byProject.get(key)
  p.servers.add(s.serverId)
  p.cost += s.cost ?? 0
  p.lastActiveAt = Math.max(p.lastActiveAt, s.lastActiveAt ?? 0)
  p.sessions.push(s)
}

const pendingByProject = new Map()
for (const a of st.pendingActions ?? []) {
  const s = st.sessions.find((x) => x.id === a.sessionId)
  const key = s?.project ?? '(unknown)'
  if (!pendingByProject.has(key)) pendingByProject.set(key, [])
  pendingByProject.get(key).push({ id: a.id, kind: a.kind, title: a.title ?? a.summary ?? '', sessionId: a.sessionId })
}

const projects = [...byProject.values()]
  .map((p) => {
    const pend = pendingByProject.get(p.project) ?? []
    const stuck = p.sessions.filter((s) => s.state === 'running' && now - (s.lastActiveAt ?? 0) > STUCK_MS)
    const errored = p.sessions.filter((s) => s.state === 'error')
    return {
      project: p.project,
      servers: [...p.servers],
      lastActiveAt: p.lastActiveAt,
      idleFor: fmtAge(now - p.lastActiveAt),
      costUsd: Math.round(p.cost * 100) / 100,
      sessions: p.sessions.length,
      active: p.sessions.filter((s) => s.lastActiveAt > since).length,
      // ⚠️ summary 是会话最后一条消息的截断，**不是"进展摘要"**。
      // 想要真正的进展提炼要走 /api/session/:id/digest —— 那会调 LLM、要花钱，故不在这里默认做。
      lastMessage: p.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.summary?.slice(0, 120) ?? '',
      // 需要人介入的三类，按紧急度排
      needsYou: [
        ...pend.map((a) => ({ why: 'pending', kind: a.kind, title: a.title, sessionId: a.sessionId, actionId: a.id })),
        ...errored.map((s) => ({ why: 'error', sessionId: s.id, title: s.summary?.slice(0, 80) ?? '' })),
        ...stuck.map((s) => ({ why: 'stuck', sessionId: s.id, silentFor: fmtAge(now - s.lastActiveAt) })),
      ],
    }
  })
  .filter((p) => p.active > 0 || p.needsYou.length > 0)
  .sort((a, b) => b.needsYou.length - a.needsYou.length || b.lastActiveAt - a.lastActiveAt)

const out = {
  generatedAt: new Date(now).toISOString(),
  windowHours: hours,
  servers: st.servers.map((s) => ({ id: s.id, online: s.online })),
  offlineServers: st.servers.filter((s) => !s.online).map((s) => s.id),
  totals: {
    projects: projects.length,
    needsYou: projects.reduce((n, p) => n + p.needsYou.length, 0),
    costUsd: Math.round(projects.reduce((n, p) => n + p.costUsd, 0) * 100) / 100,
  },
  projects,
}

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }

// ── 人读 ──
const L = []
L.push(`# 项目进展 · 近 ${hours}h · ${new Date(now).toLocaleString('zh-CN')}`)
if (out.offlineServers.length) L.push(`\n⚠️ **离线服务器**：${out.offlineServers.join(', ')}`)
L.push(`\n活跃项目 ${out.totals.projects} 个 · **需要你介入 ${out.totals.needsYou} 处** · 累计 $${out.totals.costUsd}`)
for (const p of projects) {
  L.push(`\n## ${p.project}${p.needsYou.length ? `　🔴 ${p.needsYou.length} 处待办` : ''}`)
  L.push(`${p.servers.join(',')} · ${p.sessions} 个会话(近期活跃 ${p.active}) · $${p.costUsd} · ${p.idleFor} 前有动作`)
  for (const n of p.needsYou) {
    const tag = { pending: '⏳ 等你', error: '❌ 出错', stuck: '🧊 疑似卡住' }[n.why]
    L.push(`- ${tag}${n.kind ? `(${n.kind})` : ''}${n.silentFor ? ` 静默 ${n.silentFor}` : ''}：${n.title ?? ''} \`${n.sessionId}\``)
  }
  if (p.lastMessage) L.push(`> ${p.lastMessage.replace(/\n/g, ' ')}`)
}
console.log(L.join('\n'))
