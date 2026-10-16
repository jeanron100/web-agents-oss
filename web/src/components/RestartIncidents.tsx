import { useEffect, useState } from 'react'

// 「agent 重启事件簿」（WebAgents 2.0 / P4）。
//
// 为什么这个面板存在：agent 一重启，它进程内的**平台会话**全部随 cgroup 被 SIGKILL——正在跑的那一回合
// 被拦腰截断，前端把悬空的 tool_use 永久渲染成「正在执行 305s / 卡住」。这是本项目最痛的一类事故
// （2026-07-05 就把用户 doc_ceneter 会话在 Edit 落盘后 5 秒杀了）。而此前**完全没有记录**：
// 事后你既不知道什么时候重启的，也不知道当时有哪些会话被波及。
//
// Hub 靠 agent 上报的 `bootId`（每进程一份、重启即变）识别重启，并把**重启前那一拍**轮询里的
// 活跃平台会话名单一并存进 Mongo——那份名单事后再也拿不到。影子会话是独立进程、不受 agent 重启
// 影响，故不计入。

type Incident = {
  _id: string
  serverId: string
  ts: string
  prevBootAt: string | null
  killedSessions: Array<{ sessionId: string; project: string | null; state: string; inflight: boolean }>
}

const fmt = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const uptimeOf = (i: Incident) => {
  if (!i.prevBootAt) return ''
  const ms = +new Date(i.ts) - +new Date(i.prevBootAt)
  if (!(ms > 0)) return ''
  const m = Math.round(ms / 60000)
  return m < 60 ? `存活 ${m}m` : `存活 ${Math.floor(m / 60)}h${m % 60}m`
}

export function RestartIncidents() {
  const [items, setItems] = useState<Incident[] | null>(null)
  const [available, setAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = (alive = { v: true }) => {
    fetch('/api/v2/incidents/restarts?limit=50')
      .then((r) => r.json())
      .then((d) => { if (alive.v) { setAvailable(!!d.available); setItems(d.incidents ?? []) } })
      .catch(() => { if (alive.v) { setAvailable(false); setItems([]) } })
  }

  useEffect(() => {
    const alive = { v: true }
    load(alive)
    return () => { alive.v = false }
  }, [])

  // 清理。onlyEmpty 是默认动作——真事故记录（波及过会话的）必须留着：
  // 那份被 SIGKILL 波及的会话名单事后再也拿不到，是复盘的唯一依据。
  const purge = async (all: boolean) => {
    if (all && !confirm('清空全部重启记录？\n\n包括「波及了会话」的事故记录——那份名单事后无法重建，将永久丢失复盘依据。')) return
    setBusy(true); setMsg('')
    try {
      const res = await fetch(`/api/v2/incidents/restarts${all ? '?all=1' : ''}`, { method: 'DELETE' })
      const d = await res.json()
      if (!res.ok || d.ok === false) throw new Error(d.error || `HTTP ${res.status}`)
      setMsg(`已清理 ${d.deleted} 条`)
      load()
    } catch (e) {
      setMsg(`清理失败：${String((e as Error).message)}`)
    } finally { setBusy(false) }
  }

  if (items === null) return null
  if (!available) return null // Mongo 不可用 → 面板整块隐藏，不占位、不误导

  return (
    <div className="detail-section">
      <div className="dl-title">
        agent 重启事件簿
        <span className="dl-title__sub">重启会 SIGKILL 掉该机进程内的平台会话（影子会话不受影响）</span>
      </div>

      {!!items.length && (
        <div className="ri__tools">
          <button className="quick-chip" disabled={busy} onClick={() => purge(false)}>
            清理无影响记录
          </button>
          <button className="quick-chip" disabled={busy} onClick={() => purge(true)}>
            清空全部
          </button>
          <span className="ri__count">共 {items.length} 条</span>
          {msg && <span className="ri__msg">{msg}</span>}
        </div>
      )}

      {!items.length ? (
        <div className="ri__none">暂无记录 —— 自本功能上线以来没有 agent 重启过。</div>
      ) : (
        // 内层滚动区：条数只增不减，全铺开会把设置页撑得极长（用户实拍）。
        // ⚠️ 只加**内层**滚动，绝不碰 .shell__main —— 那是全页唯一滚动容器（见 global.css 的
        // 布局护栏与 layout.test.ts），动它会连累底栏与 PullRefresh。
        <div className="ri ri--scroll">
          {items.map((i) => {
            const killed = i.killedSessions ?? []
            const truncated = killed.filter((k) => k.inflight)
            return (
              <div key={i._id} className={`ri__row ${killed.length ? 'ri__row--hit' : ''}`}>
                <div className="ri__head">
                  <span className="ri__srv">{i.serverId}</span>
                  <span className="ri__ts mono">{fmt(i.ts)}</span>
                  <span className="ri__up">{uptimeOf(i)}</span>
                  <span className={`ri__badge ${killed.length ? 'ri__badge--bad' : 'ri__badge--ok'}`}>
                    {killed.length ? `波及 ${killed.length} 个会话` : '无会话受影响'}
                  </span>
                </div>
                {!!killed.length && (
                  <div className="ri__list">
                    {killed.map((k) => (
                      <div key={k.sessionId} className="ri__sess">
                        <span className="ri__proj">{k.project ?? '—'}</span>
                        <span className="ri__sid mono">{k.sessionId}</span>
                        <span className="ri__state">{k.state}</span>
                        {k.inflight && <span className="ri__flag">回合被拦腰截断</span>}
                      </div>
                    ))}
                    {!!truncated.length && (
                      <div className="ri__warn">
                        其中 {truncated.length} 个会话<b>当时正在执行回合</b>——tool_result 已落盘、assistant 下一回合没来，
                        会话冻在半途（前端会显示「正在执行 N 秒」不动）。需恢复会话后重新触发。
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
