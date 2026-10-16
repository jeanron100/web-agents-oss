import { ReactNode, useRef, useState } from 'react'
import { refreshNow } from '../hub/client'

const THRESHOLD = 64

/** 「我们滚到顶了吗？」
 *
 *  ⚠️ 不能再用 `window.scrollY`。带底栏的页面已改成 app-shell 布局（外壳不滚动、`.shell__main`
 *  才是滚动容器，见 global.css 里 .tabbar 上方那段长注释）——此时 `window.scrollY` **恒为 0**，
 *  于是"滚到顶了吗"恒为真：你在列表中段随手往下一划，就会触发一次下拉刷新。
 *
 *  这里往上找真正的滚动祖先；找不到（沉浸页 / 桌面仍是 body 滚动）就退回 window.scrollY。
 *  两种滚动模型都成立，不必知道自己身处哪一种。 */
export function scrollTopOf(from: HTMLElement | null): number {
  for (let el = from; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el.scrollTop
  }
  return window.scrollY
}

/** 移动端下拉刷新容器：页面顶部下拉超过阈值触发立即拉取 */
export function PullRefresh({ children }: { children: ReactNode }) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const atTop = () => scrollTopOf(rootRef.current) <= 0

  const onTouchStart = (e: React.TouchEvent) => {
    if (atTop()) startY.current = e.touches[0].clientY
    else startY.current = null
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current == null || refreshing) return
    const dy = e.touches[0].clientY - startY.current
    if (dy > 0 && atTop()) setPull(Math.min(dy * 0.45, 90))
  }
  const onTouchEnd = async () => {
    startY.current = null
    if (pull >= THRESHOLD && !refreshing) {
      setRefreshing(true)
      setPull(46)
      await refreshNow()
      setTimeout(() => { setRefreshing(false); setPull(0) }, 300)
    } else {
      setPull(0)
    }
  }

  return (
    <div ref={rootRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div className="pull-indicator" style={{ height: pull, opacity: pull > 8 ? 1 : 0 }}>
        <span className={refreshing ? 'pull-spinner' : ''}>
          {refreshing ? '◌' : pull >= THRESHOLD ? '↻ 松开刷新' : '↓ 下拉刷新'}
        </span>
      </div>
      {children}
    </div>
  )
}
