import { useCallback, useEffect, useState } from 'react'

// #7 项目分类（应用视角）：前端即时生效(localStorage) + 后端持久化(/api/categories)，随时可调。
const LS_KEY = 'agent-console-categories'
const DEFAULT_CATS = ['AI前沿', '数据库技术', '投资', '小玩意']
export const UNCATEGORIZED = '未分类'

export type Categories = { categories: string[]; map: Record<string, string> }

function readLS(): Categories {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || '')
    if (d && Array.isArray(d.categories)) return { categories: d.categories, map: d.map ?? {} }
  } catch { /* ignore */ }
  return { categories: DEFAULT_CATS, map: {} }
}

export function useCategories() {
  const [cats, setCats] = useState<Categories>(readLS)

  // 后端为权威持久化，启动时拉一次覆盖本地缓存
  useEffect(() => {
    let alive = true
    fetch('/api/categories')
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d || !Array.isArray(d.categories)) return
        const next: Categories = { categories: d.categories, map: d.map ?? {} }
        setCats(next)
        localStorage.setItem(LS_KEY, JSON.stringify(next))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const save = (next: Categories) => {
    localStorage.setItem(LS_KEY, JSON.stringify(next)) // 即时生效
    void fetch('/api/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    }).catch(() => {}) // 落后端，失败不阻塞 UI
  }

  const setCategory = useCallback((key: string, cat: string) => {
    setCats((prev) => {
      const map = { ...prev.map }
      if (cat) map[key] = cat
      else delete map[key]
      const next: Categories = { categories: prev.categories, map }
      save(next)
      return next
    })
  }, [])

  const addCategory = useCallback((name: string) => {
    const n = name.trim()
    if (!n) return
    setCats((prev) => {
      if (prev.categories.includes(n)) return prev
      const next: Categories = { categories: [...prev.categories, n], map: prev.map }
      save(next)
      return next
    })
  }, [])

  return { cats, setCategory, addCategory }
}
