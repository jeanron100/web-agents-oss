import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { IS_DEMO, refreshNow, startHubClient, stopHubClient } from './hub/client'
import { pendingCount, useAppStore } from './store/store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UpdateNotice } from './components/UpdateNotice'
import { useOperator } from './components/AuthGate'

// 手机和桌面导航保持一致；外部监控仅在已配置页面地址时显示。
// 注：「服务器」按用户要求不在导航显示（/servers 路由仍在，可直接访问）。
const mobileTabs = [
  { to: '/', icon: '📊', label: '看板' },
  { to: '/inbox', icon: '📥', label: '收件箱' },
  { to: '/stats', icon: '📈', label: '消耗' },
  { to: '/archive', icon: '🔎', label: '执行历史' },
  { to: '/terminal', icon: '⌨️', label: '终端' },
  { to: '/ops', icon: '🛠', label: '监控' },
  { to: '/settings', icon: '⚙️', label: '设置' },
]

const desktopNav = [
  { to: '/', icon: '📊', label: '看板' },
  { to: '/inbox', icon: '📥', label: '收件箱' },
  { to: '/stats', icon: '📈', label: '消耗' },
  { to: '/archive', icon: '🔎', label: '执行历史' },
  { to: '/terminal', icon: '⌨️', label: '终端' },
  { to: '/ops', icon: '🛠', label: '监控' },
  { to: '/settings', icon: '⚙️', label: '设置' },
]

export default function App() {
  const operator=useOperator()
  const [monitorConfigured,setMonitorConfigured]=useState(false)
  const count = useAppStore((s) => pendingCount(s.pendingActions))
  const syncStatus = useAppStore((s) => s.syncStatus)
  const lastSyncTs = useAppStore((s) => s.lastSyncTs)
  const writeError = useAppStore((s) => s.writeError)
  const clearWriteError = useAppStore((s) => s.clearWriteError)
  // 订阅 clockTick 仅为驱动本组件按墙钟周期重渲染，让失联横幅里的「N 秒」持续推进
  useAppStore((s) => s.clockTick)

  useEffect(() => {
    void startHubClient()
    return () => stopHubClient()
  }, [])

  useEffect(() => {
    if (IS_DEMO) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const configured = (url: unknown) => typeof url === 'string' && url.trim().length > 0
    const saved = (event: Event) => {
      // A saved setting takes precedence over any older initial request.
      controller.abort()
      setMonitorConfigured(configured((event as CustomEvent<{monitorUrl?: string}>).detail?.monitorUrl))
    }
    window.addEventListener('wa-installation-updated', saved)
    fetch('/api/installation', {signal: controller.signal})
      .then(r => r.ok ? r.json() : null)
      .then(config => { if (!controller.signal.aborted && config) setMonitorConfigured(configured(config.monitorUrl)) })
      .catch(() => { /* Optional integrations stay hidden until configuration is available. */ })
      .finally(() => clearTimeout(timeout))
    return () => { controller.abort(); clearTimeout(timeout); window.removeEventListener('wa-installation-updated', saved) }
  }, [])

  // 隐藏项目名单：**服务端为权威**（agent 靠 hub 下发的这份名单决定扫不扫）。
  // localStorage 那份只是首屏免闪的镜像，服务端一到就覆盖——否则换设备看到的是另一套。
  useEffect(() => {
    let alive = true
    fetch('/api/hidden-projects')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) useAppStore.getState().setHiddenProjects(d.hidden) })
      .catch(() => { /* 离线/演示态：用本地镜像即可 */ })
    return () => { alive = false }
  }, [])

  // 前后台切回 / 网络恢复：立即补一次刷新，别等下一个轮询周期才发现活过来了
  useEffect(() => {
    // 仅在 live 数据源下补刷新——mock/演示态调 refreshNow 会误触发失联横幅、且可能抢在 mock→live 升级探测之前把 mock _tick 叠到真实数据上
    const onVisible = () => { if (document.visibilityState === 'visible' && useAppStore.getState().source === 'live') void refreshNow() }
    const onOnline = () => { if (useAppStore.getState().source === 'live') void refreshNow() }
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onVisible() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  // 墙钟推进：驱动相对时间展示（"N 分钟前"）与失联横幅按秒数自走，而不是冻结在上一次渲染
  useEffect(() => {
    const timer = setInterval(() => useAppStore.getState().bumpClock(), 30000)
    return () => clearInterval(timer)
  }, [])

  // 写操作失败提示 5s 后自动消失（也可点一下立即关）；writeError 每次上报都是新对象，effect 会重置计时
  useEffect(() => {
    if (!writeError) return
    const t = setTimeout(() => clearWriteError(), 5000)
    return () => clearTimeout(t)
  }, [writeError, clearWriteError])

  // 沉浸页（会话详情）：不显示底栏，且保留「body 滚动」模型（对话流自动滚底依赖 window.scrollY）
  const immersive = useLocation().pathname.startsWith('/session/')

  // PWA 图标角标：待办数（安装到主屏后生效）
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (count > 0) void nav.setAppBadge?.(count)
    else void nav.clearAppBadge?.()
  }, [count])

  return (
    // shell--tabs：**有底栏的页面**用「外壳占满视口、不滚动；内容区是唯一滚动容器；底栏是流内元素」
    // 的经典 app-shell 布局。底栏因此**不再是 position: fixed** —— 它没有"漂"的自由度了。
    // 为什么非这么做不可：iOS/WebKit 会把 fixed 元素并进滚动合成层，往下滚一段后底栏漂到页面中间
    // （2026-07-10、2026-07-13 两次用户手机实拍）。这个 bug **在 chromium 里复现不出**，也就是说
    // 任何"去掉某个触发条件"的修法**我们本地都验证不了**——上一次就是那么修的（去掉 backdrop-filter），
    // 它回来了。验证不了的修复和坏掉的修复长得一模一样，所以只能让失败模式在结构上不可能发生。
    //
    // 会话页（沉浸页）**刻意不动**：它的对话流自动滚底、composer 键盘避让都绑在 window 滚动上，
    // 而 iOS 软键盘行为在没有真机的情况下改不动也验不了。它本就不显示底栏，不受此 bug 影响。
    <div className={`shell ${immersive ? 'shell--immersive' : 'shell--tabs'} ${IS_DEMO ? 'shell--demo' : ''}`}>
      {!IS_DEMO && <UpdateNotice />}
      {/* Demo 站点横幅：数据全是编造的，所有操作只改本地 store，不会发往任何服务器。
          必须醒目——否则有人会以为自己看到的是别人的真实生产数据。 */}
      {IS_DEMO && (
        <div className="demo-banner">
          <span className="demo-banner__tag">DEMO</span>
          <span>演示数据 · 所有操作只改本地，不会发往任何服务器</span>
          <a className="demo-banner__link" href="/demo.html">这是什么？ →</a>
        </div>
      )}
      {syncStatus !== 'ok' && !IS_DEMO && (
        <div className={`sync-banner ${syncStatus === 'lost' ? 'sync-banner--lost' : 'sync-banner--stale'}`}>
          {syncStatus === 'lost' ? '✕' : '⚠'} 与服务器失联 {Math.max(0, Math.round((Date.now() - lastSyncTs) / 1000))} 秒，数据可能过期
        </div>
      )}
      {writeError && (
        <div className="write-toast" role="alert" onClick={() => clearWriteError()}>
          <span>⚠ {writeError.text}</span>
          <button className="write-toast__close" aria-label="关闭" onClick={(e) => { e.stopPropagation(); clearWriteError() }}>✕</button>
        </div>
      )}
      <nav className="sidenav">
        <div className="sidenav__brand">⌘ Agent 管控台</div>
        {desktopNav.filter(item => item.to !== '/ops' || monitorConfigured).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `sidenav__item ${isActive ? 'active' : ''}`}>
            <span>{item.icon}</span>
            <span>{item.label}</span>
            {item.to === '/inbox' && count > 0 && <span className="badge">{count}</span>}
          </NavLink>
        ))}
        <div className="sidenav__foot">{operator.user||'操作员'} · 在线</div>
      </nav>

      <main className="shell__main">
        <ErrorBoundary label="page">
          <Outlet />
        </ErrorBoundary>
      </main>

      <nav className="tabbar">
        {mobileTabs.filter(item => item.to !== '/ops' || monitorConfigured).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `tabbar__item ${isActive ? 'active' : ''}`}>
            <span className="tabbar__icon">
              {item.icon}
              {item.to === '/inbox' && count > 0 && <span className="badge">{count}</span>}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
