import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileEditor } from './FileEditor'

// 代码视图（功能3·demo）：实时项目树（git ls-files）+ git 工作区状态徽标 + 点击文件预览。
// 5s 轮询刷新（复用现有轮询体感），展开态本地保留，不随刷新丢失。

type Node = { name: string; type: 'dir' | 'file'; path: string; children?: Node[] }
type TreeResp = { root: Node; fileCount: number; truncated: boolean; status: Record<string, string>; cwd: string }

// 按扩展名给文件一个图标，提升可扫读性
const ICONS: Record<string, string> = {
  ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️', mjs: '🟨', cjs: '🟨', json: '🔧',
  md: '📄', css: '🎨', scss: '🎨', html: '🌐', py: '🐍', sh: '⚙️', sql: '🗄️',
  yml: '🔧', yaml: '🔧', toml: '🔧', env: '🔑', svg: '🖼️', png: '🖼️', jpg: '🖼️',
  lock: '🔒', txt: '📃',
}
function fileIcon(name: string) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return ICONS[ext] || '📃'
}
function collectDirs(node: Node, acc: string[] = []): string[] {
  if (node.type === 'dir') { acc.push(node.path); node.children?.forEach((c) => collectDirs(c, acc)) }
  return acc
}
// 扁平化所有文件路径（搜索模式用）
function flattenFiles(node: Node, acc: { path: string; name: string }[] = []): { path: string; name: string }[] {
  if (node.type === 'file') acc.push({ path: node.path, name: node.name })
  else node.children?.forEach((c) => flattenFiles(c, acc))
  return acc
}

// git 状态码 → 徽标样式
function statusBadge(code?: string) {
  if (!code) return null
  const c = code.replace(/\?/g, '?')
  let cls = 'codetree__badge--m'
  if (c.includes('A') || c === '??') cls = 'codetree__badge--a'
  else if (c.includes('D')) cls = 'codetree__badge--d'
  else if (c.includes('R')) cls = 'codetree__badge--r'
  const label = c === '??' ? 'U' : c.trim().slice(0, 1)
  return <span className={`codetree__badge ${cls}`}>{label}</span>
}

function fileBadge(rel: string, status: Record<string, string>) {
  // status 的 key 是相对 cwd 的路径；目录显示其下任意改动的聚合提示
  return statusBadge(status[rel])
}

function dirHasChange(node: Node, status: Record<string, string>): boolean {
  const prefix = node.path ? node.path + '/' : ''
  return Object.keys(status).some((k) => k.startsWith(prefix))
}

function TreeRow({
  node, depth, status, expanded, toggle, onPick, selected,
}: {
  node: Node; depth: number; status: Record<string, string>
  expanded: Set<string>; toggle: (p: string) => void
  onPick: (p: string) => void; selected: string | null
}) {
  const isDir = node.type === 'dir'
  const open = expanded.has(node.path)
  const pad = { paddingLeft: 8 + depth * 14 }
  return (
    <>
      <button
        className={`codetree__row ${selected === node.path ? 'codetree__row--sel' : ''}`}
        style={pad}
        onClick={() => (isDir ? toggle(node.path) : onPick(node.path))}
      >
        <span className="codetree__icon">{isDir ? (open ? '▾' : '▸') : fileIcon(node.name)}</span>
        <span className="codetree__name">{node.name}</span>
        {isDir
          ? (!open && dirHasChange(node, status) && <span className="codetree__dot" />)
          : fileBadge(node.path, status)}
      </button>
      {isDir && open && node.children?.map((c) => (
        <TreeRow key={c.path} node={c} depth={depth + 1} status={status}
          expanded={expanded} toggle={toggle} onPick={onPick} selected={selected} />
      ))}
    </>
  )
}

export function CodeTree({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<TreeResp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [picked, setPicked] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/session/${sessionId}/tree`)
      if (!res.ok) { if (alive.current) setErr((await res.json().catch(() => ({}))).error || '加载失败'); return }
      const d = await res.json()
      if (alive.current) { setData(d); setErr(null) }
    } catch { /* 瞬时失败，下个轮询重试 */ }
  }, [sessionId])

  useEffect(() => {
    alive.current = true
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => { alive.current = false; clearInterval(t) }
  }, [load])

  const toggle = (p: string) => setExpanded((prev) => {
    const next = new Set(prev)
    next.has(p) ? next.delete(p) : next.add(p)
    return next
  })

  const pick = (p: string) => setPicked(p)
  const closePicked = () => setPicked(null)

  useEffect(() => {
    if (!picked) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicked() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked])

  if (err && !data) return <div className="empty-state">代码视图不可用：{err}</div>
  if (!data) return <div className="empty-state">加载项目树…</div>

  const changed = Object.keys(data.status).length
  const q = filter.trim().toLowerCase()
  const matches = q ? flattenFiles(data.root).filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200) : null
  const expandAll = () => setExpanded(new Set(collectDirs(data.root)))
  const collapseAll = () => setExpanded(new Set(['']))

  return (
    <div className="codetree">
      <div className="codetree__head">
        <span className="mono codetree__cwd">{data.cwd}</span>
        <span className="codetree__meta">
          {data.fileCount} 文件{data.truncated ? '（已截断）' : ''} · {changed ? `${changed} 处改动` : '工作区干净'} · 实时
        </span>
      </div>
      <div className="codetree__toolbar">
        <input className="codetree__filter" placeholder="🔍 筛选文件…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {filter
          ? <button className="codetree__tool-btn" onClick={() => setFilter('')}>清除</button>
          : <>
              <button className="codetree__tool-btn" onClick={expandAll}>展开全部</button>
              <button className="codetree__tool-btn" onClick={collapseAll}>折叠</button>
            </>}
      </div>
      <div className="codetree__body">
        <div className="codetree__tree">
          {matches
            ? matches.length
              ? matches.map((f) => (
                  <button key={f.path} className={`codetree__row ${picked === f.path ? 'codetree__row--sel' : ''}`}
                    style={{ paddingLeft: 8 }} onClick={() => pick(f.path)}>
                    <span className="codetree__icon">{fileIcon(f.name)}</span>
                    <span className="codetree__name codetree__name--path">{f.path}</span>
                    {statusBadge(data.status[f.path])}
                  </button>
                ))
              : <div className="empty-state" style={{ padding: 14, fontSize: 12.5 }}>无匹配文件</div>
            : data.root.children?.map((c) => (
                <TreeRow key={c.path} node={c} depth={0} status={data.status}
                  expanded={expanded} toggle={toggle} onPick={pick} selected={picked} />
              ))}
        </div>
      </div>
      {picked && createPortal(
        <div className="fv-overlay" onClick={closePicked}>
          <div className="fv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fv-head">
              <span className="fv-path mono">{picked}</span>
              <button className="icon-btn" onClick={closePicked} title="关闭">✕</button>
            </div>
            <div className="fv-body">
              <FileEditor sessionId={sessionId} path={picked} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
