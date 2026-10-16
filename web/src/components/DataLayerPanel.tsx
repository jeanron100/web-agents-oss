import { useEffect, useState } from 'react'

// 数据层状态面板（WebAgents 2.0 / P3）：一眼看清 Redis / MongoDB / MySQL 是否健康、
// 历史投影攒了多少事件、spool 有没有积压。这是 P0~P2 那一堆后端工作**在 Web 端唯一可见的出口**。
//
// 设计：任一库挂了都只是这里变红，**不影响会话/审批/终端**——所以这个面板本身就是"降级可见性"的证明。

type Health = { status: string; latencyMs?: number; error?: string }
type Stats = {
  redis: Health
  mongo: Health
  mysql: Health
  flags: Record<string, boolean>
  projection: { written: number; skipped: number; spooled?: number; spoolCount: number; spoolBytes: number; lastRun?: number }
  counts: { events: number; byType: { type: string; n: number }[] } | null
}

const dot = (s: string) => (s === 'ok' ? 'var(--st-done)' : s === 'disabled' ? 'var(--text-3)' : 'var(--st-error)')
const label = (s: string) => (s === 'ok' ? '正常' : s === 'disabled' ? '未启用' : '异常')

function Row({ name, h, note }: { name: string; h: Health; note?: string }) {
  return (
    <div className="dl-row">
      <span className="dl-row__dot" style={{ background: dot(h.status) }} />
      <span className="dl-row__name">{name}</span>
      <span className="dl-row__state" style={{ color: dot(h.status) }}>{label(h.status)}</span>
      {h.latencyMs != null && <span className="dl-row__lat mono">{h.latencyMs}ms</span>}
      {note && <span className="dl-row__note">{note}</span>}
      {h.error && <span className="dl-row__note" style={{ color: 'var(--st-error)' }}>{String(h.error).slice(0, 40)}</span>}
    </div>
  )
}

export function DataLayerPanel() {
  const [s, setS] = useState<Stats | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/v2/stats').then((r) => r.json())
      .then((d) => { if (alive) { setS(d); setErr(false) } })
      .catch(() => { if (alive) setErr(true) })
    load()
    const t = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (err) return <div className="detail-section"><div className="dl-title">数据层</div><div className="dl-empty">取不到状态</div></div>
  if (!s) return <div className="detail-section"><div className="dl-title">数据层</div><div className="dl-empty">加载中…</div></div>

  const spoolMB = s.projection.spoolBytes / 1048576
  const spoolWarn = s.projection.spoolCount > 0

  return (
    <div className="detail-section">
      <div className="dl-title">
        数据层
        <span className="dl-title__sub">Redis 管协调 · MongoDB 管历史 · MySQL 管统计 · JSONL 管事实</span>
      </div>

      <Row name="Redis" h={s.redis} note="心跳 / 租约 / 通知去重" />
      <Row name="MongoDB" h={s.mongo} note="执行历史投影" />
      <Row name="MySQL" h={s.mysql} note="成本 / 用量统计" />

      {/* 历史投影攒了多少——这是 Mongo 真正在干活的证据 */}
      <div className="dl-stat">
        <div className="dl-stat__box">
          <div className="dl-stat__label">已投影事件</div>
          <div className="dl-stat__val mono">{s.counts ? s.counts.events.toLocaleString() : '—'}</div>
        </div>
        <div className="dl-stat__box">
          <div className="dl-stat__label">spool 积压</div>
          <div className="dl-stat__val mono" style={{ color: spoolWarn ? 'var(--st-waiting)' : undefined }}>
            {s.projection.spoolCount}
            {spoolMB >= 0.1 && <span className="dl-stat__unit"> · {spoolMB.toFixed(1)}MB</span>}
          </div>
        </div>
      </div>
      {spoolWarn && (
        <div className="dl-note">
          有 {s.projection.spoolCount} 条事件因 MongoDB 不可达暂存本地，恢复后会自动重放（幂等，不会重复）。
        </div>
      )}

      {/* 事件类型分布 */}
      {s.counts && s.counts.byType.length > 0 && (
        <div className="dl-types">
          {s.counts.byType.map((t) => (
            <span key={t.type} className="dl-type">
              <span className="dl-type__k">{t.type}</span>
              <span className="dl-type__n mono">{t.n.toLocaleString()}</span>
            </span>
          ))}
        </div>
      )}

      <div className="dl-flags">
        {Object.entries(s.flags).map(([k, v]) => (
          <span key={k} className={`dl-flag ${v ? 'dl-flag--on' : ''}`}>{k.replace('WA_', '').replace('_ENABLED', '')}</span>
        ))}
      </div>
      <div className="dl-hint">任一数据库故障都只影响本面板与历史查询——会话、审批、终端不受任何影响。</div>
    </div>
  )
}
