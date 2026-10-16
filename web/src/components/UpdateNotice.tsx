import { useEffect, useState } from 'react'

export function UpdateNotice() {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    const current = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src')
    if (!current || !current.includes('/assets/')) return
    let alive = true
    let busy = false
    let controller: AbortController | null = null
    const check = async () => {
      if (busy || document.visibilityState === 'hidden') return
      busy = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}index.html?version-check=${Date.now()}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok || response.redirected) return
        const html = new DOMParser().parseFromString(await response.text(), 'text/html')
        const latest = html.querySelector('script[type="module"][src]')?.getAttribute('src')
        // 登录页、错误页或开发模式不视为发布更新。
        if (alive && latest?.includes('/assets/')) setAvailable(latest !== current)
      } catch { /* 离线不打扰用户 */ }
      finally { clearTimeout(timeout); busy = false }
    }
    void check()
    const timer = setInterval(() => void check(), 60000)
    const visible = () => void check()
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', visible)
    return () => { alive = false; controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible) }
  }, [])
  if (!available) return null
  return <div className="update-notice" role="status"><span>页面有更新</span><button className="btn btn--sm btn--primary" onClick={() => location.reload()}>刷新使用新版</button></div>
}
