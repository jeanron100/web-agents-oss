import { useEffect, useState } from 'react'
import { useAppStore } from '../store/store'
import { codexCells, type CodexWin } from '../lib/codex-windows'
import { usageReset } from '../lib/usage-reset'

/**
 * 三家订阅额度并排一行：Codex / Kimi / Claude。
 *
 * 为什么合成一个组件而不是三个各挂各的：原来 UsageSummary 与 CodexUsageSummary 是两段独立
 * section，纵向堆叠，手机上要滑两屏才看全，且两家的标签/格子数各不相同。现在统一成
 * 「一张卡 = 一家 · 卡内两格 = 5h 窗 / 周窗」。
 *
 * ⚠️ 只渲染**真实存在**的窗口：硬画一个「5h —」会让人以为坏了（CLAUDE.md 记过，别退回去）。
 * ⚠️ Codex 两个窗口的归属**按数据里的 windowMin 判定**，不按 primary/secondary 的位置 ——
 *    上游改过不止一次（2026-07-15 取消 5h 窗、之后又改回来），写死哪边就等着下次再错一遍。
 */

type Win = { pct: number; windowMin?: number | null; resets?: string | null; resetsAt?: number | null; label?: string } | null
type Lim = { session?: Win; week?: Win; stale?: boolean; error?: string; pending?: boolean; ts?: number } | null

/** Kimi 长窗标签：从解析器带上来的原始 label（Weekly/Monthly/新名字）映射成中文，不写死。 */
const kimiLongLabel = (w?: Win) => {
  const l = (w?.label ?? '').toLowerCase()
  if (l.startsWith('month')) return '本月'
  if (l.startsWith('week')) return '本周'
  return w?.label || '长窗'
}

const shortReset = (s?: string | null) => (s ? s.replace(/\s*\([^)]*\)\s*$/, '') : '')
const pctCls = (p?: number) => (p == null ? '' : p >= 90 ? 'usage-sum__val--warn' : '')

function Cell({ label, win, tip }: { label: string; win: Win; tip?: string }) {
  return (
    <div className="usage-sum__item" title={`${tip ?? label}${win?.resets ? ` · 重置 ${shortReset(win.resets)}` : ''}`}>
      <div className="usage-sum__label">{label}</div>
      <div className={`usage-sum__val mono ${pctCls(win?.pct)}`}>{win ? `${win.pct}%` : '—'}</div>
    </div>
  )
}

function Card({ engine, name, cells, stale, error, sampledAt }: {
  engine: 'claude' | 'codex' | 'kimi'
  name: string
  cells: Array<{ label: string; win: Win; tip?: string; showReset?: boolean }>
  stale?: boolean
  error?: string
  sampledAt?: number
}) {
  const longWindows = cells.filter(c => c.win && (
    (c.win.windowMin ?? 0) >= 1440 || c.showReset
  ))
  return (
    <div className={`usage-card usage-card--${engine}${stale ? ' usage-sum--dim' : ''}`}>
      <div className="usage-card__head">
        <span className={`usage-card__dot usage-card__dot--${engine}`} />
        {name}
        {stale && <span className="usage-cap__err" title={error ?? ''}>⚠</span>}
      </div>
      <section className="usage-sum usage-sum--inline">
        {cells.map((c) => <Cell key={c.label} {...c} />)}
      </section>
      {longWindows.map(c => {
        const reset = usageReset(c.win, sampledAt)
        return reset && <div className="usage-card__reset" key={c.label} title={reset.title}>
          <span>{c.label}重置</span>
          <time dateTime={reset.dateTime}>{reset.text}</time>
        </div>
      })}
    </div>
  )
}

const ALL_ENGINES = ['codex', 'kimi', 'claude'] as const
export function UsageRow({ engines = ALL_ENGINES }: { engines?: readonly ('claude' | 'codex' | 'kimi')[] }) {
  const engineKey = engines.join(',')
  const [claude, setClaude] = useState<Lim>(null)
  const [kimi, setKimi] = useState<Lim>(null)
  const [codex, setCodex] = useState<{ primary?: CodexWin; secondary?: CodexWin; stale?: boolean; error?: string } | null>(null)
  const refreshSeq = useAppStore((s) => s.refreshSeq)

  useEffect(() => {
    let alive = true
    const retries: Array<ReturnType<typeof setTimeout>> = []
    /**
     * ★★ `pending` 是服务端在说「手头没有旧值、正在探，马上会有」（2026-09-11）。
     *   背景：端点原先是 `if (!usageLimits) await refreshUsageLimits()` —— 同步等探测跑完，
     *   实测 Claude 5.18s、Kimi 约 20s，那几秒**占着一条跨境 HTTP 连接**
     *   （本仓库栽过「请求堆叠打满 keepalive 池」）。现在改成立刻返回 + 后台刷。
     *   ⚠️ **但只去掉阻塞会让体验更差**：这里是 60 秒轮询一次，用户会从
     *   「等 5 秒看到数字」变成「等 60 秒」。所以见到 pending 就补拉一次。
     *   **凡去掉等待，先问"怎么回来"** —— 否则只是把同步等待换成了更长的空窗。
     */
    const get = (u: string, set: (d: Lim) => void, depth = 0) =>
      fetch(u).then((r) => r.json()).then((d: Lim) => {
        if (!alive) return
        set(d)
        // 最多补两次（~8s / ~24s），够覆盖 Claude 5s 与 Kimi 20s 两种探测；再多就是空转
        if (d?.pending && depth < 2) retries.push(setTimeout(() => get(u, set, depth + 1), depth === 0 ? 8_000 : 16_000))
      }).catch(() => {})
    const load = () => {
      if (engines.includes('claude')) get('/api/usage/limits', setClaude)
      if (engines.includes('kimi')) get('/api/usage/kimi-limits', setKimi)
      // codex-limits 是按账号的数组；取第一个账号的窗口（多账号场景仍在 /usage 页看明细）
      if (engines.includes('codex')) fetch('/api/usage/codex-limits').then((r) => r.json()).then((d) => {
        if (!alive) return
        const a = Array.isArray(d?.accounts) ? d.accounts[0] : (Array.isArray(d) ? d[0] : d)
        setCodex(a ?? null)
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t); retries.forEach(clearTimeout) }
  }, [refreshSeq, engineKey])

  return (
    <div className="usage-row">
      {engines.includes('codex') && <Card
        engine="codex" name="Codex" stale={codex?.stale} error={codex?.error}
        // ★ 按数据自带的 windowMin 归位，**不写死 primary/secondary 对应哪个窗**。
        //   2026-09-08 用户实拍「反了」：原先写死 secondary→5h、primary→本周，
        //   那是照 2026-07-15「OpenAI 取消 5h 窗」的观察写的；上游后来又改回去了
        //   （实测 primary.windowMin=300、secondary.windowMin=10080），于是周用量
        //   被画进 5h 格。把映射对调只是把赌注押到另一边 —— 见 lib/codex-windows.ts。
        cells={codexCells(codex)}
      />}
      {engines.includes('kimi') && <Card
        engine="kimi" name="Kimi" stale={kimi?.stale} error={kimi?.error}
        sampledAt={kimi?.ts}
        // 长窗标签从数据来：2026-09-27 上游把 Weekly 换成了 Monthly，
        // 写死「本周」就会把月额度标成周额度（同 codex-windows 那条教训）。
        cells={[
          { label: '5h', win: kimi?.session ?? null, tip: '5h 限额' },
          { label: kimiLongLabel(kimi?.week), win: kimi?.week ?? null, tip: `${kimi?.week?.label ?? '长窗'}限额`, showReset: true },
        ]}
      />}
      {engines.includes('claude') && <Card
        engine="claude" name="Claude" stale={claude?.stale} error={claude?.error}
        cells={[
          { label: '5h', win: claude?.session ?? null, tip: '会话窗口 (5h)' },
          { label: '本周', win: claude?.week ?? null, tip: '本周 · 全模型', showReset: true },
        ]}
      />}
    </div>
  )
}
