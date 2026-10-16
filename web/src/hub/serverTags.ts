import { useCallback, useEffect, useState } from 'react'

// 服务器标签：前端即时(localStorage) + 后端 MySQL(/api/server-tags) 持久化。
const LS = 'agent-console-server-tags'
export type SrvTags = { tags: string[]; map: Record<string, string> }

function readLS(): SrvTags {
  try { const d = JSON.parse(localStorage.getItem(LS) || ''); if (d && Array.isArray(d.tags)) return { tags: d.tags, map: d.map ?? {} } } catch { /* ignore */ }
  return { tags: [], map: {} }
}

export function useServerTags() {
  const [st, setSt] = useState<SrvTags>(readLS)
  useEffect(() => {
    let alive = true
    fetch('/api/server-tags').then((r) => r.json()).then((d) => {
      if (!alive || !d || !Array.isArray(d.tags)) return
      const n = { tags: d.tags, map: d.map ?? {} }
      setSt(n); localStorage.setItem(LS, JSON.stringify(n))
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const persist = (n: SrvTags) => {
    localStorage.setItem(LS, JSON.stringify(n))
    void fetch('/api/server-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) }).catch(() => {})
  }
  const setTag = useCallback((serverId: string, tag: string) => {
    setSt((prev) => { const map = { ...prev.map }; if (tag) map[serverId] = tag; else delete map[serverId]; const n = { tags: prev.tags, map }; persist(n); return n })
  }, [])
  const addTag = useCallback((name: string) => {
    const t = name.trim(); if (!t) return
    setSt((prev) => { if (prev.tags.includes(t)) return prev; const n = { tags: [...prev.tags, t], map: prev.map }; persist(n); return n })
  }, [])
  return { st, setTag, addTag }
}
