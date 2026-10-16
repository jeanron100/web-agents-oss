import { useEffect, useState } from 'react'
import { useAppStore } from '../store/store'
import { codexUsageView } from '../lib/codexUsage'

// Codex 订阅额度（看板）：官方 rate_limits，账号级。
// ⚠️ 2026-07-15：OpenAI 改了额度结构——**取消了 5 小时窗**。以前 primary=5h 窗、secondary=周窗；
// 现在只剩一个 weekly 窗（primary=10080min），secondary=null（实测 codex-cli 0.142.5 + 全新回合确认）。
// 故此块现在通常只有一格（本周）；secondary 为空时**不渲染空格子**（否则显示「窗口 —」像坏了）。
// primary(5h 窗口) + secondary(周窗口)（旧结构，保留兼容：万一某些账号/版本仍返回双窗，两格都显示），账号级，
// 各机 agent 上报本机最新快照 + 本机账号身份(email/plan)；hub 按 accountId 分组(同账号取最新)。
// 口径对齐：rate_limits 字段本就是 used_percent(已用)，此处**直接显示「已用%」**，与看板上「Claude 额度」
// 块同维度（都是用量、越高越告警），避免同一看板一个用量一个剩余看着拧巴（用户 2026-07-07 反馈）。
// 代价：Codex 客户端显示的是「剩余用量」，与本块正好互补——剩余% 仍保留在每格 tooltip 供交叉核对。
// 数据来自「服务器侧」Codex 会话写入的快照，本地客户端用量不计入、仅服务器侧发起回合时刷新——
// 故快照可能滞后：① 显著标注快照时间；② 窗口越过 resetsAt 后旧快照失效，当前用量显示未知。
type Win = { pct: number; windowMin: number | null; resetsAt: number | null } | null
type Acct = {
  accountId?: string | null
  email?: string | null
  plan?: string | null
  primary?: Win
  secondary?: Win
  at?: number
  live?: boolean  // true=codex app-server 实时查询;false/缺=回退的 rollout 滞后快照
}

// 相对时间：过去用「前」（含「刚刚」），未来用「后」（含「即将」）。
const fmtReset = (sec?: number | null) => {
  if (!sec) return ''
  const diff = sec * 1000 - Date.now()
  const ab = Math.abs(diff)
  if (ab < 6e4) return diff < 0 ? '刚刚' : '即将'
  const suf = diff < 0 ? '前' : '后'
  const h = ab / 3.6e6
  if (h < 1) return `${Math.round(ab / 6e4)}分钟${suf}`
  if (h < 24) return `${Math.round(h)}h${suf}`
  return `${Math.round(h / 24)}天${suf}`
}
const winLabel = (min?: number | null) => {
  if (!min) return '窗口'
  if (min % 1440 === 0) { const d = min / 1440; return d === 7 ? '本周' : `${d}天窗口` }
  return `会话 ${Math.round(min / 60)}h`
}
const planText = (p?: string | null) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : '—')
// 已用值越高越告警（已用 ≥90% 标红），与「Claude 额度」块的 pctCls 口径一致
const usedCls = (p?: number) => (p == null ? '' : p >= 90 ? 'usage-sum__val--warn' : '')
// 快照新鲜度：始终给出可读文案 + 是否已滞后（>2h 视为可能滞后，显式提醒）
const snapAge = (at?: number): { text: string; stale: boolean } => {
  if (!at) return { text: '未知', stale: true }
  const ms = Date.now() - at
  const h = ms / 3.6e6
  let text: string
  if (ms < 12e4) text = '刚刚'
  else if (h < 1) text = `${Math.round(ms / 6e4)} 分钟前`
  else if (h < 24) text = `${Math.round(h)} 小时前`
  else text = `${Math.round(h / 24)} 天前`
  return { text, stale: h >= 2 }
}
// 账号标签：取邮箱 @ 前部分；无 email 时退回通用名
const acctLabel = (email?: string | null) => {
  if (!email) return 'Codex 账号'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

function WinCell({ win }: { win: Win }) {
  if (!win) {
    return (
      <div className="usage-sum__item">
        <div className="usage-sum__label">窗口</div>
        <div className="usage-sum__val mono">—</div>
      </div>
    )
  }
  // 窗口越过 resetsAt 后，旧窗口确实归零，但新窗口可能已经产生消耗；没有新快照就不能推断当前是 0%。
  const { expired, used, remain, display } = codexUsageView(win.pct, win.resetsAt)
  const resetTxt = win.resetsAt ? `${expired ? '已重置' : '重置'} ${fmtReset(win.resetsAt)}` : ''
  const tip = expired
    ? `${winLabel(win.windowMin)} · ${resetTxt} · 旧快照已失效，当前已用未知（重置前快照已用 ${win.pct}%）`
    : `${winLabel(win.windowMin)}${resetTxt ? ' · ' + resetTxt : ''} · 已用 ${used}%（剩余 ${remain}%）`
  return (
    <div className="usage-sum__item" title={tip}>
      <div className="usage-sum__label">{winLabel(win.windowMin)}</div>
      <div className={`usage-sum__val mono ${expired ? '' : usedCls(used)}`}>
        {display}
      </div>
    </div>
  )
}

function AccountBlock({ acc }: { acc: Acct }) {
  const snap = snapAge(acc.at)
  return (
    <>
      <div
        className="usage-cap usage-cap--codex"
        title={`${acc.email ?? 'Codex 订阅额度'} — 显示「已用」额度，与看板「Claude 额度」块同维度（用量，越高越告警）。注意 Codex 客户端显示的是「剩余用量」，与本块互补；每格 tooltip 附剩余%。数据来自各服务器 Codex 会话写入的 rate_limits 快照，本地客户端用量不计入，且仅服务器侧发起 Codex 回合时才刷新`}
      >
        {acctLabel(acc.email)} · {planText(acc.plan)} · 已用
        {acc.live ? (
          <span className="usage-cap__live" title="codex app-server 实时查询（account/rateLimits/read），与客户端 /status 同源、零额度">🟢 实时</span>
        ) : (
          <span className={`usage-cap__age ${snap.stale ? 'usage-cap__age--stale' : ''}`} title="rollout 旧快照（实时查询不可用时回退）；越旧实际已用可能更高">· {snap.text}快照{snap.stale ? '(滞后)' : ''}</span>
        )}
      </div>
      {/* 只渲染真实存在的窗口。5h 窗被 OpenAI 取消后 secondary=null——不再画「窗口 —」空格子。
          万一上游又回到双窗，两格照常显示（用 filter 而非硬编码两格）。 */}
      <section className="usage-sum usage-sum--codex">
        {[acc.primary, acc.secondary].filter((w): w is NonNullable<Win> => !!w).map((w, i) => (
          <WinCell key={w.windowMin ?? i} win={w} />
        ))}
      </section>
    </>
  )
}

export function CodexUsageSummary() {
  const [accounts, setAccounts] = useState<Acct[]>([])
  const refreshSeq = useAppStore((s) => s.refreshSeq)
  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/usage/codex-limits').then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const list: Acct[] = Array.isArray(d?.accounts) ? d.accounts : []
        setAccounts(list.filter((a) => a && (a.primary || a.secondary)))
      }).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [refreshSeq])
  if (!accounts.length) return null
  return (
    <>
      {accounts.map((acc, i) => (
        <AccountBlock key={acc.accountId ?? acc.email ?? i} acc={acc} />
      ))}
    </>
  )
}
