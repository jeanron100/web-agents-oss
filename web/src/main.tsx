import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { IS_DEMO } from './hub/client'
import { installDemoGuard } from './demo/guard'

// ⚠️ 必须在**任何组件挂载之前**装上：demo 站点与真管控台同域，/api/* 就是真 Hub。
// 逐个组件加守卫必然漏点（实测漏了 usage/limits/categories 三处，真实成本会被公开）——
// 所以在唯一的咽喉（全局 fetch / EventSource）一刀切。
if (IS_DEMO) installDemoGuard()
import App from './App'
import Dashboard from './pages/Dashboard'
import Inbox from './pages/Inbox'
import ApprovalDetail from './pages/ApprovalDetail'
import SessionDetail from './pages/SessionDetail'
import NewSession from './pages/NewSession'
import Search from './pages/Search'
import Archive from './pages/Archive'
import Settings from './pages/Settings'
import Stats from './pages/Stats'
import Review from './pages/Review'
import Terminal from './pages/Terminal'
import Ops from './pages/Ops'
import GettingStarted from './pages/GettingStarted'
import './styles/global.css'
import { AuthGate } from './components/AuthGate'

const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: '/', element: <Dashboard /> },
      {
        path: '/inbox',
        element: <Inbox />,
        children: [],
      },
      { path: '/inbox/:actionId', element: <ApprovalDetail /> },
      { path: '/session/:sessionId', element: <SessionDetail /> },
      { path: '/new', element: <NewSession /> },
      { path: '/getting-started', element: <GettingStarted /> },
      { path: '/search', element: <Search /> },
      { path: '/archive', element: <Archive /> },
      { path: '/stats', element: <Stats /> },
      { path: '/review', element: <Review /> },
      { path: '/terminal', element: <Terminal /> },
      { path: '/ops', element: <Ops /> },
      { path: '/settings', element: <Settings /> },
    ],
  },
], {
  // 对外 Demo 部署在子路径（/demo/）：vite base 已处理静态资源，路由也得跟上，
  // 否则 /demo/session/x 匹配不到任何路由 → 白屏。主站 BASE_URL 是 '/'，无副作用。
  basename: import.meta.env.BASE_URL,
})

// Demo 站点不注册 SW：① demo 不需要推送；② /sw.js 在登录闸后面，注册会被 302 挡回来，
// 控制台报「The script resource is behind a redirect, which is disallowed」——白噪音。
if (!IS_DEMO && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 注册失败不影响使用 */ })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate><RouterProvider router={router} /></AuthGate>
  </React.StrictMode>,
)
