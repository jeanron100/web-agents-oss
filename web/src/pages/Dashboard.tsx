import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { starKey, useAppStore, serverTotals, visibleSessions, projectHeadSessions } from '../store/store'
import { useCategories, UNCATEGORIZED } from '../hub/categories'
import { groupByProject, ServerGroup } from '../components/ServerGroup'
import { PullRefresh } from '../components/PullRefresh'
import { refreshNow } from '../hub/client'
import { SessionCard } from '../components/SessionCard'
import { SkeletonCards } from '../components/Skeleton'
import { StatChips } from '../components/StatChips'
import { UsageRow } from '../components/UsageRow'
import { stateLabel } from '../components/StatusDot'
import type { SessionState } from '../types'
import { orderServers } from '../lib/server-order'
import { withPendingApprovals } from '../lib/pending-approvals'
import {useLanguage} from '../lib/language'

const RECENT_MS = 7 * 86_400_000 // 默认只看近 7 天活跃，砍掉久未动的影子噪声
const VALID_STATES = new Set<SessionState>(['running', 'waiting_input', 'waiting_approval', 'done', 'idle', 'error'])

export default function Dashboard() {
  const navigate = useNavigate()
  const [language]=useLanguage()
  const t=(zh:string,en:string)=>language==='en'?en:zh
  const [searchParams, setSearchParams] = useSearchParams()
  const stateParamRaw = searchParams.get('state')
  const stateFilter: SessionState | null =
    stateParamRaw && VALID_STATES.has(stateParamRaw as SessionState) ? (stateParamRaw as SessionState) : null
  const clearStateFilter = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('state')
    setSearchParams(next)
  }
  const servers = useAppStore((s) => s.servers)
  const rawSessions = useAppStore((s) => s.sessions)
  const pendingActions = useAppStore((s) => s.pendingActions)
  const sessions = useMemo(() => withPendingApprovals(rawSessions, pendingActions), [rawSessions, pendingActions])
  const source = useAppStore((s) => s.source)
  const starred = useAppStore((s) => s.starred)
  const hiddenProjects = useAppStore((s) => s.hiddenProjects)
  const lastSessions = useAppStore((s) => s.lastSessions)
  const bumpRefresh = useAppStore((s) => s.bumpRefresh)
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    bumpRefresh()                       // 触发各用量/额度卡片即时重拉
    try { await refreshNow() } catch { /* 忽略 */ } // 看板会话/服务器状态
    setTimeout(() => setRefreshing(false), 600)
  }
  const bootstrapped = useAppStore((s) => s.bootstrapped)
  const [serverFilter, setServerFilter] = useState<string>('all')
  const [recentOnly, setRecentOnly] = useState(false) // 默认显示全部项目；可选"仅近 7 天"精简
  const [view, setView] = useState<'server' | 'app'>(
    () => (localStorage.getItem('agent-console-view') === 'app' ? 'app' : 'server'),
  )
  const { cats, setCategory, addCategory } = useCategories()
  useEffect(() => { localStorage.setItem('agent-console-view', view) }, [view])
  // 应用视角：折叠的分类（持久化到 localStorage）
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('agent-console-collapsed-cats')
      return saved === null ? new Set(['小玩意']) : new Set(JSON.parse(saved)) // 首次默认折叠「小玩意」，之后尊重用户
    } catch { return new Set(['小玩意']) }
  })
  const toggleCat = (cat: string) => setCollapsedCats((prev) => {
    const next = new Set(prev)
    next.has(cat) ? next.delete(cat) : next.add(cat)
    localStorage.setItem('agent-console-collapsed-cats', JSON.stringify([...next]))
    return next
  })

  // useMemo 锁定输入引用，保持 applyState 的引用稳定性传导到卡片（避免重渲染）
  const cutoff = useMemo(() => Date.now() - RECENT_MS, [])
  const staleCount = useMemo(() => sessions.filter((s) => s.lastActiveAt < cutoff).length, [sessions, cutoff])
  const scopedSessions = useMemo(() => {
    // ★ 隐藏项目在**这一个点**过滤，三个视角（星标/服务器/应用）全覆盖。
    //   分别在三处过滤 = 迟早漏一处，而漏的那处正好是用户在看的那个视角。
    let list = visibleSessions(sessions, hiddenProjects)
    if (serverFilter !== 'all') list = list.filter((s) => s.serverId === serverFilter)
    if (recentOnly) list = list.filter((s) => s.lastActiveAt >= cutoff || s.state === 'waiting_approval')
    return list
  }, [sessions, hiddenProjects, serverFilter, recentOnly, cutoff])
  const projectHeads = useMemo(() => projectHeadSessions(scopedSessions, lastSessions), [scopedSessions, lastSessions])
  const visible = useMemo(() => {
    if (!stateFilter) return scopedSessions
    const keys = new Set(projectHeads.filter((s) => s.state === stateFilter).map((s) => starKey(s.serverId, s.project)))
    return scopedSessions.filter((s) => keys.has(starKey(s.serverId, s.project)))
  }, [scopedSessions, projectHeads, stateFilter])

  const orderedServers = useMemo(() => orderServers(servers, visible), [servers, visible])
  const shown = orderedServers.filter((sv) => serverFilter === 'all' || sv.id === serverFilter)
  // 星标项目：跨服务器聚合置顶（按服务器分别分组避免同名项目混并）
  const starredGroups = shown.flatMap((sv) =>
    groupByProject(
      visible.filter((s) => s.serverId === sv.id && starred.includes(starKey(sv.id, s.project))),
      lastSessions,
    ),
  )
  const isStarred = (serverId: string, project: string) => starred.includes(starKey(serverId, project))
  // 按服务器汇总 cost/token（全量 store，不受近期过滤影响）→ 服务器头显示
  const totals = useMemo(() => serverTotals(sessions), [sessions])

  // 应用视角：所有项目按分类分桶（含未分类），按配置顺序排列
  const appGroups = useMemo(() => {
    const all = shown.flatMap((sv) => groupByProject(visible.filter((s) => s.serverId === sv.id), lastSessions))
    const byCat = new Map<string, typeof all>()
    for (const g of all) {
      const cat = cats.map[starKey(g.latest.serverId, g.latest.project)] || UNCATEGORIZED
      const arr = byCat.get(cat) ?? []
      arr.push(g); byCat.set(cat, arr)
    }
    // 排序：普通分类按配置序 → 未分类 → 杂项(小玩意)垫底
    const BOTTOM = ['小玩意']
    const ordered = [...cats.categories.filter((c) => !BOTTOM.includes(c)), UNCATEGORIZED, ...cats.categories.filter((c) => BOTTOM.includes(c))]
    return ordered.filter((c) => byCat.has(c)).map((c) => ({ cat: c, groups: byCat.get(c) ?? [] }))
  }, [shown, visible, cats, lastSessions])

  return (
    <PullRefresh>
    <div className="page">
      <header className="page-head">
        <h1 className="page-head__title">看板</h1>
        <button className="icon-btn" title="刷新" onClick={onRefresh} disabled={refreshing}>
          <span className={refreshing ? 'icon-spin' : ''}>↻</span>
        </button>
        <button className="icon-btn" title="搜索" onClick={() => navigate('/search')}>⌕</button>
        <button className="btn btn--sm btn--ghost" title="今日复盘" onClick={() => navigate('/review')}>📓 复盘</button>
        {source === 'live' && (
          <button className="btn btn--sm btn--primary" onClick={() => navigate('/new')}>＋ 新建会话</button>
        )}
      </header>

      {source==='live'&&bootstrapped&&rawSessions.length===0&&<div className="todo-card setup-welcome"><h2>{t('连接服务器，开始管理你的项目','Connect a server and start managing your projects')}</h2><p>{t('本地安装的是管控台。把远程服务器接进来，即可在一处查看进展、发送补充信息和处理审批；代码与 CLI 继续在执行节点上运行。','This installation is a console. Connect remote servers to follow progress, send messages and handle approvals in one place. Code and CLIs stay on the execution nodes.')}</p><div className="node-actions"><button className="btn btn--primary" onClick={()=>navigate('/getting-started')}>{t('连接远程服务器 · 推荐','Connect a remote server · Recommended')}</button><button className="btn" onClick={()=>navigate('/getting-started?mode=local')}>{t('本地容器体验','Try a local container')}</button></div></div>}

      <StatChips projects={projectHeads} />
      <UsageRow />

      <div className="view-tabs">
        <button className={`seg-tab ${view === 'server' ? 'active' : ''}`} onClick={() => setView('server')}>服务器视角</button>
        <button className={`seg-tab ${view === 'app' ? 'active' : ''}`} onClick={() => setView('app')}>应用视角</button>
        {view === 'app' && <span className="view-tabs__hint">长按项目卡片可打标签</span>}
      </div>

      <div className="filter-row">
        <select
          className="select-pill"
          value={serverFilter}
          onChange={(e) => setServerFilter(e.target.value)}
          style={{ appearance: 'none' }}
        >
          <option value="all">全部服务器</option>
          {orderedServers.map((sv) => (
            <option key={sv.id} value={sv.id}>{sv.name}</option>
          ))}
        </select>
        {staleCount > 0 && (
          <button className="select-pill" onClick={() => setRecentOnly(!recentOnly)}>
            {recentOnly ? `显示全部 · +${staleCount} 更早` : '仅看近 7 天'}
          </button>
        )}
        {stateFilter && (
          <button className="select-pill" onClick={clearStateFilter}>
            状态：{stateLabel[stateFilter]} ✕
          </button>
        )}
      </div>

      {starredGroups.length > 0 && (
        <section className="server-group">
          <div className="server-group__head" style={{ cursor: 'default' }}>
            <span className="server-group__flag">⭐</span>
            <span className="server-group__name">星标项目</span>
            <span className="server-group__meta">{starredGroups.length} 个</span>
          </div>
          <div className="server-group__cards">
            {starredGroups.map(({ latest, history }) => (
              <SessionCard
                key={`${latest.serverId}/${latest.project}`}
                session={latest}
                history={history}
                showServer
                category={cats.map[starKey(latest.serverId, latest.project)] || ''}
                categories={cats.categories}
                onSetCategory={(c) => setCategory(starKey(latest.serverId, latest.project), c)}
                onAddCategory={addCategory}
              />
            ))}
          </div>
        </section>
      )}

      {!bootstrapped ? (
        <SkeletonCards count={6} />
      ) : view === 'server' ? (
        shown.map((sv) => (
          <ServerGroup
            key={sv.id}
            server={sv}
            sessions={visible.filter((s) => s.serverId === sv.id && !isStarred(sv.id, s.project))}
            totals={totals[sv.id]}
          />
        ))
      ) : (
        appGroups.map(({ cat, groups }) => {
          const collapsed = collapsedCats.has(cat)
          return (
            <section className="server-group" key={cat}>
              <button className="server-group__head" onClick={() => toggleCat(cat)}>
                <span className="server-group__flag">🗂</span>
                <span className="server-group__name">{cat}</span>
                <span className="server-group__meta">{groups.length} 个</span>
                <span className={`server-group__chev ${collapsed ? '' : 'server-group__chev--open'}`}>▾</span>
              </button>
              {!collapsed && (
                <div className="server-group__cards">
                  {groups.map(({ latest, history }) => (
                    <SessionCard
                      key={`${latest.serverId}/${latest.project}`}
                      session={latest}
                      history={history}
                      showServer
                      category={cats.map[starKey(latest.serverId, latest.project)] || ''}
                      categories={cats.categories}
                      onSetCategory={(c) => setCategory(starKey(latest.serverId, latest.project), c)}
                      onAddCategory={addCategory}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        })
      )}
    </div>
    </PullRefresh>
  )
}
