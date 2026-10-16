import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useAppStore } from '../store/store'
import type { Session } from '../types'

// SSE 心跳看门狗的回归测试。
//
// 背景（2026-07-13 线上）：用户看板显示「刚刚」、对话流冻在 15 分钟前，等多久都不刷新。
// 根因是 **SSE 半死连接**——手机休眠/切后台/NAT 超时后 TCP 还开着但零字节流入，
// `onerror` 永不触发、`readyState` 恒 OPEN → 「CLOSED 才回退轮询」的判据**永远等不到** → 界面永久冻死。
//
// 这里钉两条**必须同时成立**的性质（任缺一条这个修复都不成立）：
//  ① **对着尚未升级、不发 ping 的旧后端也能自愈** —— 判据是「本该活跃却 N 秒无字节」，
//     不要求对端一定发心跳。舰队滚动升级期间总有旧 agent，靠它们配合才生效的修复等于没修。
//  ② **空闲会话不得重连** —— 空闲会话本来就没有数据流（服务端 sig 去重，内容没变不发帧），
//     无差别判死会对着每一台旧 agent 每 45s 重连一次，制造重连风暴。

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CLOSED = 2
  static OPEN = 1
  url: string
  readyState = 1
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  listeners: Record<string, Array<() => void>> = {}
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn) }
  close() { this.closed = true; this.readyState = 2 }
  /** 模拟服务端推一帧业务事件（会 bump lastSeen） */
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
}

const session = (state: Session['state']): Session => ({
  id: 's-1', serverId: 'srv', project: 'p', engine: 'claude', state,
  summary: '', cwd: '/data/p', startedAt: 1, lastActiveAt: 1, tokens: 0, cost: 0,
} as unknown as Session)

let subscribeSessionEvents: (id: string) => () => void

beforeEach(async () => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ kind: 'append', events: [] }) })))
  vi.useFakeTimers()
  // client.ts 在模块作用域没有副作用，但要在 stub 之后再拿到它，避免拿到旧的全局引用
  subscribeSessionEvents = (await import('./client')).subscribeSessionEvents
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SSE 心跳看门狗：半死连接必须被判死并重建', () => {
  it('SSE 恢复后，迟到的旧轮询快照不得覆盖新消息', async () => {
    const { syncSessionEvents } = await import('./client')
    let finish!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve })))
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('race-sse-poll')
    const pending = syncSessionEvents('race-sse-poll')
    FakeEventSource.instances[0].emit({ kind: 'snapshot', events: [{id:'new',type:'assistant',text:'新回复',ts:200,seq:2}], lastSeq:2 })
    finish({ok:true,json:async()=>({kind:'snapshot',events:[{id:'old',type:'user',text:'旧问题',ts:100,seq:1}],lastSeq:1})})
    await pending
    expect(useAppStore.getState().events['race-sse-poll'].map(e=>e.id)).toEqual(['new'])
    unsub()
  })

  it('已关闭旧 SSE 的迟到消息不得污染新连接', () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    const old = FakeEventSource.instances[0]
    vi.advanceTimersByTime(50_000)
    const current = FakeEventSource.instances.at(-1)!
    current.emit({kind:'snapshot',events:[{id:'new-sse',type:'assistant',text:'新',ts:200}]})
    old.emit({kind:'snapshot',events:[{id:'old-sse',type:'user',text:'旧',ts:100}]})
    expect(useAppStore.getState().events['s-1'].map(e=>e.id)).toEqual(['new-sse'])
    unsub()
  })

  it('手机网络恢复时立即重建 SSE，不等待退避定时器', () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),
      removeEventListener:(name:string)=>listeners.delete(name),
    })
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    const old = FakeEventSource.instances[0]
    old.readyState = FakeEventSource.CLOSED
    old.onerror?.()
    listeners.get('online')!()
    expect(FakeEventSource.instances).toHaveLength(2)
    unsub()
    expect(listeners.size).toBe(0)
  })

  it('缓存页面恢复立即补消息并重建过期 SSE，首次加载和卸载后不触发', async () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const pageShow = (persisted: boolean) => {
      const event = new Event('pageshow')
      Object.defineProperty(event, 'persisted', { value: persisted })
      target.dispatchEvent(event)
    }
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    const first = FakeEventSource.instances[0]
    vi.advanceTimersByTime(11_000)
    pageShow(false)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ kind: 'snapshot', events: [
        { id: 'after-cache', type: 'assistant', text: '后台期间的新回复', ts: 200, seq: 1 },
      ] }),
    } as Response)
    pageShow(true)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(first.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].url).toBe('/api/session/s-1/stream')
    expect(useAppStore.getState().events['s-1'].map(e => e.id)).toEqual(['after-cache'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/api/session/s-1/events')

    unsub()
    pageShow(true)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('★ 活跃会话 45s 没有任何字节 → 主动重建连接（对着不发 ping 的旧后端也自愈）', () => {
    // 进 live 模式，且该会话处于活跃态
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')

    expect(FakeEventSource.instances).toHaveLength(1)
    const first = FakeEventSource.instances[0]
    expect(first.closed).toBe(false)

    // 半死连接：readyState 仍是 OPEN、onerror 永不触发、一个字节都不来。
    // 旧后端不发具名 ping —— 看门狗必须只靠「活跃却静默」就判死。
    vi.advanceTimersByTime(50_000)

    expect(first.closed).toBe(true)                       // 旧连接被主动关掉
    expect(FakeEventSource.instances.length).toBeGreaterThan(1) // 建了新连接
    unsub()
  })

  it('★ 空闲会话静默再久也不得重连（否则对旧 agent 制造重连风暴）', () => {
    useAppStore.getState().applyState([], [session('idle')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    expect(FakeEventSource.instances).toHaveLength(1)

    vi.advanceTimersByTime(120_000) // 两分钟无数据——空闲会话本来就该没数据

    expect(FakeEventSource.instances).toHaveLength(1)     // 没有重连
    expect(FakeEventSource.instances[0].closed).toBe(false)
    unsub()
  })

  it('收到帧就续命：活跃会话只要仍有数据流，就不该被判死', () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    const first = FakeEventSource.instances[0]

    // 每 20s 来一帧（< 45s 阈值）
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20_000)
      first.emit({ kind: 'append', events: [] })
    }

    expect(first.closed).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)
    unsub()
  })

  it('取消订阅后看门狗必须停：不得继续重建连接（否则详情页切 Tab 会泄漏连接）', () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    unsub()
    const n = FakeEventSource.instances.length
    vi.advanceTimersByTime(200_000)
    expect(FakeEventSource.instances).toHaveLength(n)
  })
})

// ───────────────── 轮询兜底必须能回到 SSE ─────────────────
//
// 背景（2026-08-21 线上，用户实拍 + 网关日志坐实）：
//   13:33:16  /api/session/ps-mt1ipjug-1138/stream   502  ← 一次瞬时错误
//   13:33:22  /api/session/.../events                200  34589  ← 掉进轮询兜底
//   13:33:32  /api/session/.../events?since=…        200  5517
//   …每 2 秒一次，此后 **/stream 再没被请求过一次**
//
// 原实现：`onerror` 里 `es = null; startPolling()`，而看门狗第一句是
// `if (closed || !es) return`——`es` 已是 null ⇒ 看门狗直接返回，`startPolling` 里也没有
// 任何重建 SSE 的代码。**降级即终身**：一次网络抖动换来永久 2 秒轮询，直到用户手动刷新。
//
// 代价不只是"慢"：轮询每 2 秒跨境拉 5.5KB(gzip)，而实测链路只有 ~11KB/s ⇒ 一条会话吃掉
// 半条链路 ⇒ /api/state 排队 → 499 → 连续失败 → 弹「与服务器失联 135 秒」。
// 用户的原话是「早上还很快 有点秒出的感觉 现在卡了」——早上走 SSE，13:33 之后走轮询。
//
// ★ 这是本仓库反复出现的那类错误：**fail-safe 的降级若没有回程，就是把瞬时故障焊成永久故障**
//   （同族：闸门被焊死在 8/8、「跳过」永远成立、看门狗结构上永不响）。

describe('轮询兜底必须能回到 SSE（降级不得是终身的）', () => {
  /** 让 SSE 致命失败，把订阅打进轮询兜底 */
  const dropIntoPolling = (es: FakeEventSource) => {
    es.readyState = FakeEventSource.CLOSED
    es.onerror?.()
  }

  it('★ 掉进轮询兜底后，必须仍会尝试重建 SSE', () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    expect(FakeEventSource.instances).toHaveLength(1)

    dropIntoPolling(FakeEventSource.instances[0])
    expect(FakeEventSource.instances).toHaveLength(1)   // 此刻还没重建，正常

    // 原实现在这里会**永远**停在 1 个：看门狗因 `!es` 直接返回，轮询里也没有重建逻辑。
    vi.advanceTimersByTime(120_000)
    expect(FakeEventSource.instances.length).toBeGreaterThan(1)
    unsub()
  })

  it('★ 重建成功后必须停掉轮询 —— 两条源同时写 store = 白烧带宽 + 放大闪烁', async () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    dropIntoPolling(FakeEventSource.instances[0])

    vi.advanceTimersByTime(120_000)                       // 触发重建
    const revived = FakeEventSource.instances.at(-1)!
    revived.onopen?.()                                    // SSE 连回来了
    await vi.advanceTimersByTimeAsync(0)

    const fetchFn = globalThis.fetch as unknown as { mock: { calls: unknown[] } }
    const before = fetchFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)             // 再走 30 秒
    expect(fetchFn.mock.calls.length).toBe(before)        // 轮询必须已经停了
    unsub()
  })

  it('★ 重连要退避 —— 服务端真挂了不得每拍猛冲（否则把它打得更死）', () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    dropIntoPolling(FakeEventSource.instances[0])

    // 每次重建都立刻再失败，模拟服务端持续不可用
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(15_000)
      const last = FakeEventSource.instances.at(-1)!
      if (!last.closed && last.readyState !== FakeEventSource.CLOSED) dropIntoPolling(last)
    }
    // 10 分钟内若无退避、按 15s 死磕 ⇒ 会到 40 次。退避后应显著更少。
    expect(FakeEventSource.instances.length).toBeLessThan(15)
    unsub()
  })

  it('取消订阅后不得再重建（轮询兜底状态下同样成立）', () => {
    useAppStore.getState().applyState([], [session('running')], [], {})
    const unsub = subscribeSessionEvents('s-1')
    dropIntoPolling(FakeEventSource.instances[0])
    unsub()
    const n = FakeEventSource.instances.length
    vi.advanceTimersByTime(600_000)
    expect(FakeEventSource.instances).toHaveLength(n)
  })
})
