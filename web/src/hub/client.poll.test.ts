import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// /api/state 轮询的**背压**回归测试。
//
// 背景（2026-08-12 线上实测）：用户反复看到「与服务器失联 N 秒，数据可能过期」，但网关
// load 只有 0.15/2 核、隧道 NRestarts=0 —— 不是网络也不是后端。真因是**轮询自己攻击自己**：
//   · /api/state = 80KB(gzip 25KB)，跨境一次要 6~16 秒
//   · 而 client 用的是裸 `setInterval(() => void this.poll(), 3000)`，**不等上一拍跑完**
//   ⇒ 永远有 2~5 个请求在飞 ⇒ nginx keepalive 池(32) 被占满 ⇒ 只能新建连接
//   ⇒ 每条新连接要跨境 TLS 握手（实测 0.69~8.13s）⇒ 撞 proxy_connect_timeout 10s
//   ⇒ 成簇 504（30 分钟 219/9327 = 2.3%）⇒ 前端连续失败计数打穿 ⇒ 弹「失联」
//
// 这跟 agent.js 已经修过的「SSE tick 上一拍没跑完就丢本拍」是同一个 bug，只是那道防线
// 当时没做到前端来。
//
// ★ 这里钉两条**必须同时成立**的性质。只做①不做②会造出更严重的故障：
//   ① 在飞时丢拍 —— 背压，让请求堆叠结构上不可能发生；
//   ② **闸门必须能自己释放** —— 若请求永不返回（半死连接、跨境黑洞），`inFlight` 会永远为真
//      ⇒ 轮询彻底停摆 ⇒ 界面永久冻死，比原 bug 严重得多。本仓库已经栽过同型的坑
//      （会话闸门被焊死在 8/8，导致新建/恢复会话一律超时）。所以必须有**有限超时**兜底。
import { useAppStore } from '../store/store'

let ApiHubClient: typeof import('./client')['ApiHubClient']
let POLL_TIMEOUT_MS: number

/** 可外部控制何时结束的 fetch 替身 */
function deferredFetch() {
  const calls: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal }> = []
  const fn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    calls.push({ resolve, reject, signal: init?.signal })
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  }))
  return { fn, calls }
}

const okBody = { servers: [], sessions: [], pendingActions: [], projectModels: {}, alerts: null }

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  const mod = await import('./client')
  ApiHubClient = mod.ApiHubClient
  POLL_TIMEOUT_MS = (mod as unknown as { POLL_TIMEOUT_MS: number }).POLL_TIMEOUT_MS
  useAppStore.setState({ sessions: [], servers: [] } as never)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('/api/state 轮询背压', () => {
  it('自动轮询、手动刷新和前台刷新必须共享同一个慢请求', async () => {
    const { refreshNow } = await import('./client')
    const { fn, calls } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    const c = new ApiHubClient()
    c.start()
    const manual = refreshNow()
    const foreground = refreshNow()
    expect(fn).toHaveBeenCalledTimes(1)
    calls[0].resolve({ ok: true, json: async () => okBody })
    await Promise.all([manual, foreground])
    expect((await freshStore()).getState()._failStreak).toBe(0)
    c.stop()
  })

  it('收到响应头后仍须等响应体读取完成，后续刷新不能另开请求', async () => {
    const { refreshNow } = await import('./client')
    let finishBody!: (body: unknown) => void
    const body = new Promise((resolve) => { finishBody = resolve })
    const fn = vi.fn(async () => ({ ok: true, json: () => body }))
    vi.stubGlobal('fetch', fn)
    const first = refreshNow()
    await flush()
    const second = refreshNow()
    expect(fn).toHaveBeenCalledTimes(1)
    finishBody({ ...okBody, sessions: [sess('body-read', { state: 'running' })] })
    await Promise.all([first, second])
    expect((await freshStore()).getState().sessions.map(s => s.id)).toEqual(['body-read'])
  })

  it('共享请求超时只记一次失败，随后可重新刷新并保留旧游标', async () => {
    const { refreshNow } = await import('./client')
    const store = await freshStore()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ ...okBody, cursor: 'boot:1', sessions: [sess('kept')] }),
    })))
    await refreshNow()
    const { fn, calls } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    const first = refreshNow({ timeoutMs: 100 })
    const second = refreshNow()
    await vi.advanceTimersByTimeAsync(101)
    await Promise.all([first, second])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(calls[0].signal?.aborted).toBe(true)
    expect(store.getState()._failStreak).toBe(1)
    expect(store.getState().sessions.map(s => s.id)).toEqual(['kept'])
    const recovered = refreshNow()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn.mock.calls[1][0]).toContain('cursor=boot%3A1')
    calls[1].resolve({ ok: true, json: async () => ({ ...okBody, cursor: 'boot:2' }) })
    await recovered
    expect(store.getState()._failStreak).toBe(0)
  })

  it('★① 上一拍还在飞时，后续 tick 必须丢弃——不得并发发出第二个请求', async () => {
    const { fn, calls } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    const c = new ApiHubClient()
    c.start()                       // 立即发第一拍
    expect(fn).toHaveBeenCalledTimes(1)

    // 第一拍未结束期间，连推 5 个轮询周期
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(1) // 仍然只有 1 个在飞，没有堆叠

    // 第一拍结束后，下一拍才允许发出
    calls[0].resolve({ ok: true, json: async () => okBody })
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(2)
    c.stop()
  })

  it('★② 请求永不返回时，闸门必须靠超时自行释放——否则轮询永久停摆', async () => {
    const { fn } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    const c = new ApiHubClient()
    c.start()
    expect(fn).toHaveBeenCalledTimes(1)

    // 请求挂死：推进到超时之后，闸门应已释放，轮询恢复
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + 3000 + 100)
    expect(fn.mock.calls.length).toBeGreaterThan(1)
    c.stop()
  })

  it('★② 之推论：超时必须是有限值，且要大于轮询间隔（否则每拍都自杀）', () => {
    expect(Number.isFinite(POLL_TIMEOUT_MS)).toBe(true)
    expect(POLL_TIMEOUT_MS).toBeGreaterThan(3000)
  })

  it('请求失败（网络错误）同样要释放闸门，不能一次失败就再也不轮询', async () => {
    const { fn, calls } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    const c = new ApiHubClient()
    c.start()
    calls[0].reject(new Error('boom'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(2)
    c.stop()
  })

  it('挂死的请求必须被真正 abort，而不是放着占连接', async () => {
    const { fn, calls } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    const c = new ApiHubClient()
    c.start()
    expect(calls[0].signal).toBeDefined()
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + 100)
    expect(calls[0].signal!.aborted).toBe(true)
    c.stop()
  })
})

// ───────────────────────── /api/state 增量下发 ─────────────────────────
//
// 背景（2026-08-20 实测）：/api/state 53.5KB 原始 / 17KB gzip，每 3 秒一次，
// 而 20 拍采样里 **18/19 拍零变化** ⇒ 98.8%~100% 是重复传输。
// 跨境链路上这份 17KB 要 p50 4.43s / p90 10.57s / max 16.02s，尾部越过 20s 超时被 abort
// （nginx 记 499，当天 /api/state 50 条）⇒ 连续 4 次 ⇒ 「与服务器失联 100 秒」。

/**
 * ★ 必须从**同一份模块图**里取 store。
 * `vi.resetModules()` 之后 `import('./client')` 会得到全新的模块实例，它引用的
 * `../store/store` 也是新的一份——而本文件顶部 import 的 useAppStore 是**旧实例**。
 * 断言 fetch 调用次数看不出这个差别（既有测试就只断言那个），但断言 store 内容一定会踩到：
 * 状态写进了新实例，你查的是旧实例，永远是空的。
 */
const freshStore = async () => (await import('../store/store')).useAppStore

/** fetch → json → applyState 之间有多跳 microtask，光推进定时器不够 */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

const sess = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, serverId: 'srv-1', project: 'p', state: 'idle', ...extra }) as never

describe('/api/state 增量下发', () => {
  it('首拍不带游标；服务端给了 cursor 后，下一拍必须带上', async () => {
    const urls: string[] = []
    const fn = vi.fn((url: string) => {
      urls.push(url)
      return Promise.resolve({ ok: true, json: async () => ({ ...okBody, frame: 'snapshot', cursor: 'boot:7', sessions: [sess('a')] }) })
    })
    vi.stubGlobal('fetch', fn)
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    expect(urls[0]).toBe('/api/state')
    expect(urls[1]).toContain('cursor=boot%3A7')
  })

  it('★ delta 帧只带变化的会话，未提及的必须保留（不得靠「没出现」推断删除）', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n += 1
      const body = n === 1
        ? { ...okBody, frame: 'snapshot', cursor: 'b:1', sessions: [sess('a'), sess('b'), sess('c')] }
        : { ...okBody, frame: 'delta', cursor: 'b:2', changed: [sess('b', { state: 'running' })], removed: [] }
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    const ss = (await freshStore()).getState().sessions
    expect(ss).toHaveLength(3)                                   // a/c 未被抹掉
    expect(ss.find((s) => s.id === 'b')?.state).toBe('running')  // b 已更新
  })

  it('★ removed 里的会话被移除', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n += 1
      const body = n === 1
        ? { ...okBody, frame: 'snapshot', cursor: 'b:1', sessions: [sess('a'), sess('b')] }
        : { ...okBody, frame: 'delta', cursor: 'b:2', changed: [], removed: ['a'] }
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    expect((await freshStore()).getState().sessions.map((s) => s.id)).toEqual(['b'])
  })

  it('★★ 请求失败后必须**保留**游标 —— 作废游标是个失败放大器', async () => {
    // ⚠️ 修订（2026-08-25，线上日志推翻了我自己的初稿）。本条初版写的是「失败后必须作废游标」，
    // 理由是「失败后我们不知道服务端到哪一版了，拿旧游标继续增量会静默错位」。**那个理由是错的**：
    //   · lastSessions 只在**完整解析成功之后**才被写入，失败/abort 的请求什么都没应用；
    //   · 所以本地列表仍然精确地与旧游标一致，拿它继续请求是正确的；
    //   · 游标能不能用由**服务端**判（cursorComparable：bootId + 版本环窗口），
    //     不可用时它会回落 snapshot —— 那才是真正的安全网，不需要客户端来疑神疑鬼。
    //
    // 而作废游标的代价是实测出来的（网关日志）：稳态每拍 **760 B**，一旦失败就退回全量
    // **14,720 B** —— 恰好在链路最脆弱的时刻把包放大 20 倍，于是更容易再失败。
    // 21:01:25 / 21:01:46 / 21:02:07 连续三次 499（每次撞满 20s 超时）⇒ 用户看到「失联 41 秒」。
    // **降级路径不能让故障更容易复发**，这和「fail-safe 的降级必须有回程」是同一条纪律。
    const urls: string[] = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(url); n += 1
      if (n === 2) return Promise.reject(new Error('网络中断'))
      return Promise.resolve({ ok: true, json: async () => ({ ...okBody, frame: 'snapshot', cursor: 'b:1', sessions: [sess('a')] }) })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()     // 拍1 成功，拿到游标
    await vi.advanceTimersByTimeAsync(3000); await flush()  // 拍2 失败
    await vi.advanceTimersByTimeAsync(3000); await flush()  // 拍3
    c.stop()
    expect(urls[1]).toContain('cursor=')       // 拍2 带游标
    expect(urls[2]).toContain('cursor=b%3A1')  // ★ 拍3 **仍然**带同一个游标，不退回全量
  })

  it('★ 失败后本地列表必须原样保留 —— 它仍与那个游标一致', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n += 1
      if (n >= 2) return Promise.reject(new Error('网络中断'))
      return Promise.resolve({ ok: true, json: async () => ({ ...okBody, frame: 'snapshot', cursor: 'b:1', sessions: [sess('a'), sess('b')] }) })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    // 失败不得清空界面：用户看到的是上一份数据 + 「失联」提示，而不是空看板
    expect((await freshStore()).getState().sessions.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('★ 服务端随时回落 snapshot 是合法路径，不得当成错误', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n += 1
      const body = n === 1
        ? { ...okBody, frame: 'snapshot', cursor: 'b:1', sessions: [sess('a'), sess('b')] }
        : { ...okBody, frame: 'snapshot', cursor: 'NEWBOOT:1', sessions: [sess('z')] }   // hub 重启了
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    expect((await freshStore()).getState().sessions.map((s) => s.id)).toEqual(['z'])  // 整份替换
    expect((await freshStore()).getState().syncStatus).toBe('ok')                     // 不算失败
  })

  it('★ delta 帧省略 servers/projectModels 时，必须沿用本地 —— 缺席 = 没变，不是空了', async () => {
    // 服务端把「几乎从不变」的 servers(1.9KB)/projectModels(1.3KB) 从 delta 帧里省掉了，
    // 这是把增量中位数从快照的 8.42% 压到 <2% 的关键一步。客户端若把缺席当成空，
    // **服务器列表会整个消失**，而且只在增量路径上发生——最难复现的那一类回归。
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n += 1
      const body = n === 1
        ? { ...okBody, frame: 'snapshot', cursor: 'b:1', servers: [{ id: 'srv-1', name: 'A' }],
            projectModels: { 'srv-1/p': 'opus' }, sessions: [sess('a')] }
        : { frame: 'delta', cursor: 'b:2', changed: [sess('a', { state: 'running' })], removed: [],
            pendingActions: [], alerts: null }              // ← 没有 servers / projectModels
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    const st = (await freshStore()).getState()
    expect(st.servers.map((s) => s.id)).toEqual(['srv-1'])       // 服务器没消失
    expect(st.sessions.find((s) => s.id === 'a')?.state).toBe('running')
  })

  it('★ servers 变了就必须整份下发并覆盖本地（截断标志靠它透传）', async () => {
    // 2026-07-21 invest_data 整个项目消失的真因是 hub 把 sessionsTruncated 吞掉了，
    // 前端把残缺当全集。所以「省略」只允许发生在**指纹相同**时；一旦变化必须原样带上。
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n += 1
      const body = n === 1
        ? { ...okBody, frame: 'snapshot', cursor: 'b:1', servers: [{ id: 'srv-1', sessionsTruncated: false }], sessions: [sess('a')] }
        : { frame: 'delta', cursor: 'b:2', changed: [], removed: [], pendingActions: [], alerts: null,
            servers: [{ id: 'srv-1', sessionsTruncated: true, hiddenSessions: 26 }] }
      return Promise.resolve({ ok: true, json: async () => body })
    }))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    await vi.advanceTimersByTimeAsync(3000); await flush()
    c.stop()
    const srv = (await freshStore()).getState().servers[0] as unknown as { sessionsTruncated?: boolean }
    expect(srv.sessionsTruncated).toBe(true)
  })

  it('★ 老后端（不带 frame/cursor）行为不变 —— 向后兼容', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, json: async () => ({ ...okBody, sessions: [sess('legacy')] }),   // 无 frame/cursor
    })))
    const c = new ApiHubClient()
    c.start()
    await vi.advanceTimersByTimeAsync(0); await flush()
    c.stop()
    expect((await freshStore()).getState().sessions.map((s) => s.id)).toEqual(['legacy'])
  })
})
