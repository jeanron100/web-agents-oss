import type { ChatEvent, HubClient, Server, Session, SessionExtras } from '../types'
import { useAppStore } from '../store/store'
import { repairLegacyEvents } from './legacy-events'

/**
 * Mock 数据源：定时推进 store（进度、流式文本、活动时间）。
 */
export class MockHubClient implements HubClient {
  private timer: ReturnType<typeof setInterval> | null = null

  start() {
    if (this.timer) return
    useAppStore.getState().loadSeed()
    this.timer = setInterval(() => useAppStore.getState()._tick(), 400)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/**
 * 真实数据源（P0/P1 影子追踪版）：轮询 Hub 的 /api/state。
 * 后续升级为 WSS 增量（按 events.seq 补传）时保持同一接口。
 */
export const POLL_INTERVAL_MS = 3000
/**
 * 单次轮询的硬超时。**必须有限，且必须大于轮询间隔。**
 *
 * 值的来历（2026-08-12 在网关实测，不是拍脑袋）：跨境冷连接 total 最坏 16.2s
 * （其中 TLS 握手 0.69~8.13s）。20s 留出余量，又不至于让一个挂死的请求拖太久。
 *
 * ★ 没有这个超时，下面的 inFlight 闸门就会被**永不返回的请求焊死** ⇒ 轮询彻底停摆
 * ⇒ 界面永久冻死，比它要修的那个 bug 严重得多。本仓库已经栽过同型的坑（会话闸门
 * 焊死在 8/8，新建/恢复会话一律超时）。**能永远成立的「跳过」不是保护，是免死金牌。**
 */
export const POLL_TIMEOUT_MS = 20_000
/** 轮询兜底后重建 SSE 的退避区间。首次 15s（够躲过一次瞬时抖动），封顶 5 分钟（服务端真挂了别猛冲）。 */
export const SSE_RETRY_MIN_MS = 15_000
export const SSE_RETRY_MAX_MS = 300_000

export class ApiHubClient implements HubClient {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 背压闸：上一拍没跑完就丢本拍。见 client.poll.test.ts 顶部的事故说明。 */
  private inFlight = false

  start() {
    if (this.timer) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async poll() {
    // 裸 setInterval 不等上一拍结束。/api/state 跨境要 6~16s 而间隔只有 3s ⇒ 曾经
    // 稳定有 2~5 个请求在飞，把 nginx keepalive 池(32) 占满 ⇒ 新连接被迫跨境握手 ⇒ 504。
    // 与 agent.js 的「SSE tick 上一拍没跑完就丢本拍」同一道理。
    if (this.inFlight) return
    this.inFlight = true
    try {
      await refreshNow()
    } finally {
      this.inFlight = false // 必须在 finally：任何失败路径都要还闸，否则等于焊死
    }
  }
}

// ── /api/state 增量下发的客户端状态（见 state-frame.ts 与 server/state-delta.js）──
// 游标与上一份会话列表是一对：拿着游标就必须拿着对应的本地列表，否则 delta 无从合并。
// 任何一方失效就一起清空 —— 半个状态比没有状态更危险。
let stateCursor: string | null = null
let lastSessions: Session[] = []
// servers / projectModels 在 delta 帧里**不变就不下发**（它们占字节地板的大头），
// 所以客户端必须自己留着上一份。缺字段 = "没变"，不是 "空了"。
let lastServers: Server[] = []
let lastProjectModels: Record<string, string> = {}

function stateUrl(): string {
  return stateCursor ? `/api/state?cursor=${encodeURIComponent(stateCursor)}` : '/api/state'
}

// 自动轮询、下拉刷新与页面恢复共享同一状态游标，也必须共享背压。
// 锁涵盖响应体解析；后来的调用者沿用原请求的剩余超时，不延长挂起连接。
let stateRefresh: Promise<void> | null = null

/** 立即发起或加入状态刷新；失败保留上次状态，所有等待者只记一次同步结果。 */
export function refreshNow({ timeoutMs = POLL_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
  if (stateRefresh) return stateRefresh
  stateRefresh = fetchState(timeoutMs).finally(() => { stateRefresh = null })
  return stateRefresh
}

async function fetchState(timeoutMs: number): Promise<void> {
  // 原先是裸 `fetch('/api/state')`，**没有任何超时**：跨境半死连接下请求可以无限期挂着，
  // 既占住一条上游连接，也会把调用方的背压闸门焊死。超时 + abort 两者缺一不可
  // ——只 reject 不 abort 的话，底层连接仍然挂在那儿占着 keepalive 池。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    // 携带游标请求增量。服务端随时可以回落 snapshot（重启 / 游标过期 / 名额截断 / 开关关闭），
    // 那是**合法路径**，不是错误——所以这里不做任何"必须是 delta"的假设。
    const res = await fetch(stateUrl(), { signal: ac.signal })
    if (!res.ok) { useAppStore.getState().noteSync(false); return }   // 游标照留，理由见下方 catch
    const data = await res.json()
    // ★ 先把帧合并成**完整** state，再交给既有的 applyState。
    //   绝不为增量另开一条写 store 的旁路：applyState 上挂着一串已修 bug 的防线——
    //   20s 墓碑期（防审批卡「消失→又冒出来→再消失」）、乐观气泡保留（防「消息刷一下没了」）。
    //   走旁路等于**只在增量路径上**让这些防线失效，是最难复现的那种回归。
    const sessions = mergeStateFrame(lastSessions, data)
    lastSessions = sessions
    // ★ delta 帧里 servers/projectModels 缺席 = **没变**，沿用本地；不是"空了"。
    //   把缺席当空会让服务器列表整个消失——而且只在增量路径上发生，最难复现。
    const servers: Server[] = Array.isArray(data.servers) ? data.servers : lastServers
    const projectModels: Record<string, string> = data.projectModels ?? lastProjectModels
    lastServers = servers
    lastProjectModels = projectModels
    stateCursor = typeof data.cursor === 'string' ? data.cursor : null
    useAppStore.getState().applyState(servers, sessions, data.pendingActions ?? [], projectModels)
    useAppStore.getState().setAlerts(data.alerts ?? null)
    useAppStore.getState().noteSync(true)
  } catch {
    /* Hub 暂不可达（含超时 abort）：保留上次状态与游标，仅记一次失败 */
    // ⚠️ **游标照留**（2026-08-25 修订，线上日志推翻了本文件的初稿）。初版在这里
    // `resetStateCursor()`，理由是「失败后不知道服务端到哪一版了，拿旧游标会静默错位」。
    // 那个理由站不住：`lastSessions` 只在**完整解析成功之后**才写入，失败/abort 的请求
    // 什么都没应用 ⇒ 本地列表仍精确地与旧游标一致，继续拿它请求就是对的。
    // 游标到底还能不能用由**服务端**判（cursorComparable：bootId + 版本环窗口），
    // 不可用时它回落 snapshot —— 那才是安全网。
    //
    // 而作废游标是实测出来的**失败放大器**：稳态每拍 760 B，一失败就退回全量 14,720 B，
    // 恰好在链路最脆弱时把包放大 20 倍 ⇒ 更容易再失败。网关日志实证：
    //   21:01:25 ?cursor=… 499 / 21:01:46 /api/state 499 / 21:02:07 /api/state 499
    //   ⇒ 三次连撞 20s 超时 ⇒ 用户看到「与服务器失联 41 秒」。
    // **降级路径不得让故障更容易复发**——与「fail-safe 的降级必须有回程」同一条纪律。
    useAppStore.getState().noteSync(false)
  } finally {
    clearTimeout(timer) // 不清就会堆积定时器：3s 一拍 × 20s 超时 ⇒ 常驻约 7 个待触发 timer
  }
}

import { mergeStateFrame } from './state-frame'
import { isLiveHubResponse, HUB_PROBE_TIMEOUT_MS } from './probe'

let client: HubClient | null = null
let mockUpgradeProbe: ReturnType<typeof setInterval> | null = null

/** 对外 Demo 构建：`VITE_DEMO=1 npm run build`。恒 mock，**永不触碰 /api**。 */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1'

/** 非演示安装始终使用真实 Hub；连接失败不会展示演示项目。 */
export async function startHubClient(): Promise<void> {
  if (client) return
  // ⚠️ 安全闸：Demo 站点与真管控台**同域**（/api/* 就是真 Hub）。若 demo 版去探 /api/state，
  // 它会探到**真实数据**并公开展示。所以 demo 构建在这里就短路——不发请求、不重探、恒 mock。
  // 靠"部署在没有 /api 反代的路径上"来保证是不够的：一次 nginx 配置手滑就会把真数据泄出去。
  if (IS_DEMO) {
    client = new MockHubClient()
    client.start()
    return
  }
  useAppStore.setState({ source: 'live' })
  try {
    const res = await fetch('/api/state', { signal: AbortSignal.timeout(HUB_PROBE_TIMEOUT_MS) })
    if(!isLiveHubResponse(res))useAppStore.getState().noteSync(false)
    client = new ApiHubClient()
  } catch {
    client = new ApiHubClient()
  }
  client.start()
  if (client instanceof MockHubClient) startMockUpgradeProbe()
}

/** mock 态下每 ~10s 重探 /api/state，一旦可达即停 mock、切换为 ApiHubClient（mock 自动升级为 live） */
function startMockUpgradeProbe(): void {
  if (mockUpgradeProbe) return
  mockUpgradeProbe = setInterval(() => {
    void (async () => {
      try {
        const res = await fetch('/api/state', { signal: AbortSignal.timeout(HUB_PROBE_TIMEOUT_MS) })
        if (!isLiveHubResponse(res)) return
        if (mockUpgradeProbe) { clearInterval(mockUpgradeProbe); mockUpgradeProbe = null }
        client?.stop()
        client = new ApiHubClient()
        client.start()
      } catch {
        /* 仍不可达：继续留在 mock，下一轮再探 */
      }
    })()
  }, 10000)
}

export function stopHubClient(): void {
  client?.stop()
  client = null
  if (mockUpgradeProbe) { clearInterval(mockUpgradeProbe); mockUpgradeProbe = null }
}

type RawPayload = {
  events?: Array<Omit<ChatEvent, 'sessionId'>>
  fileChanges?: SessionExtras['fileChanges']
  todos?: SessionExtras['todos']
  messageReceipts?: SessionExtras['messageReceipts']
  /** 断线续传帧类型（Phase 2）：append=增量合并；snapshot/reset/缺省(旧后端)=全量替换 */
  kind?: 'snapshot' | 'append' | 'reset'
  firstSeq?: string | number
  lastSeq?: string | number
  droppedBefore?: boolean
}

/** 每个会话最后应用过的 seq —— 兜底轮询据此带游标，让服务端回 append 帧而不是全量快照 */
const lastSeqBySession = new Map<string, string | number>()
const eventRevision = new Map<string, number>()
const eventRequest = new Map<string, number>()

function applyPayload(sessionId: string, data: RawPayload): void {
  eventRevision.set(sessionId, (eventRevision.get(sessionId) ?? 0) + 1)
  const events: ChatEvent[] = (data.events ?? []).map((e) => ({ ...e, sessionId } as ChatEvent))
  // fileChanges/todos 每帧都是当前全量值，无论 kind
  const extras: SessionExtras = { fileChanges: data.fileChanges ?? [], todos: data.todos ?? [],
    ...(data.messageReceipts ? { messageReceipts: data.messageReceipts } : {}) }
  if (data.lastSeq != null) lastSeqBySession.set(sessionId, data.lastSeq)
  else lastSeqBySession.delete(sessionId)
  const repaired = repairLegacyEvents(events, useAppStore.getState().events[sessionId] ?? [], data.kind === 'append')
  if (repaired) {
    useAppStore.getState().applyEvents(sessionId, repaired, extras)
  } else if (data.kind === 'append') {
    useAppStore.getState().appendEvents(sessionId, events, extras)
  } else {
    // 'snapshot' | 'reset' | 缺省（旧后端未升级前）均为全量替换，行为与升级前一致
    useAppStore.getState().applyEvents(sessionId, events, extras)
  }
}

/**
 * 会话详情页拉取一次事件流（live 模式）；mock 模式 no-op。SSE 不可用时的兜底轮询也用它。
 *
 * ⚠️ **必须带游标**。原先是裸 `/events`（无 since）→ 服务端恒回 `kind:'snapshot'` → 前端**全量替换**。
 * 全量替换 + 无取消 = 「陈旧快照抹掉新消息」：订阅被拆掉后（切 Tab、claudeSession.id 因轮询抖动而变）
 * 在途的旧请求照样会 applyPayload，把一份**过时的**快照整份盖上去 —— 刚发出的消息就这么消失几秒，
 * 下一帧又回来（用户报的「消息刷一下没了、过几秒又出现」）。
 * 带上 since 后服务端回 `append` 帧，前端走 appendEvents（只增不减），**从原理上不可能抹掉已有事件**。
 * 游标不可比（换了文件世代等）时服务端回 `reset`，那时的全量替换是正确且必要的。
 *
 * @param signal 订阅被取消时中止；即便请求已发出，下面也会再查一次 aborted，不让迟到的响应写进 store。
 */
export async function syncSessionEvents(sessionId: string, signal?: AbortSignal): Promise<void> {
  if (useAppStore.getState().source !== 'live') return
  const revision = eventRevision.get(sessionId) ?? 0
  const request = (eventRequest.get(sessionId) ?? 0) + 1
  eventRequest.set(sessionId, request)
  const since = lastSeqBySession.get(sessionId)
  const qs = since != null ? `?since=${encodeURIComponent(String(since))}` : ''
  try {
    const res = await fetch(`/api/session/${sessionId}/events${qs}`, { signal })
    if (!res.ok) return
    const data = await res.json()
    if (signal?.aborted) return // 迟到的响应：订阅早已取消，写进去就是用旧数据覆盖新状态
    // SSE may have recovered while this poll was in flight. Its newer snapshot
    // must not be replaced by the stale HTTP response (or an older parallel poll).
    if (eventRevision.get(sessionId) !== undefined && eventRevision.get(sessionId) !== revision) return
    if (eventRequest.get(sessionId) !== request) return
    applyPayload(sessionId, data)
  } catch {
    /* 忽略瞬时失败 / AbortError */
  }
}

/**
 * 订阅会话事件：优先 SSE 实时推送（逐字流式），连接致命失败时自动回退到自适应轮询。
 * 返回取消函数（详情页卸载时调用）。
 */
export function subscribeSessionEvents(sessionId: string): () => void {
  if (useAppStore.getState().source !== 'live') return () => {}
  let es: EventSource | null = null
  let poller: ReturnType<typeof setTimeout> | null = null
  let closed = false
  // 取消令牌：详情页切 Tab / claudeSession.id 变化都会重订阅（useEffect 依赖里有它们）。
  // 没有它的话，被拆掉的那次订阅**仍有一个 fetch 在途**，迟到的响应照样往 store 里写——
  // 那是一份比当前更旧的数据，直接把刚出现的消息盖没了。
  const ac = new AbortController()

  // ── 轮询兜底的**回程**（2026-08-21 线上）────────────────────────────────────
  // 原实现只有去路没有回程：`onerror` 里 `es = null; startPolling()`，而看门狗第一句是
  // `if (closed || !es) return` ⇒ `es` 已是 null，看门狗直接返回，`startPolling` 里也没有
  // 任何重建 SSE 的代码。**降级即终身**——一次瞬时错误换来永久轮询，直到用户手动刷新页面。
  //
  // 实测代价（网关日志坐实）：13:33:16 一条 `/stream 502`，此后 `/stream` 再没被请求过一次，
  // 而 `/events?since=…` 每 2 秒一次、每次跨境 5.5KB(gzip)。链路实测只有 ~11KB/s ⇒ 一条会话
  // 吃掉半条链路 ⇒ `/api/state` 排队 → 499 → 连续失败 → 弹「与服务器失联 135 秒」。
  // 用户原话：「早上还很快 有点秒出的感觉 现在卡了」。
  //
  // ★ 一般化：**fail-safe 的降级若没有回程，就是把瞬时故障焊成永久故障。**
  //   本仓库同族前科：闸门被焊死在 8/8、「跳过」永远成立、看门狗结构上永不响。
  let polling = false
  let retryAt = 0                       // 下一次允许尝试重建 SSE 的时刻
  let retryDelay = SSE_RETRY_MIN_MS     // 退避步长，连回来即复位

  const stopPolling = () => {
    polling = false
    if (poller) { clearTimeout(poller); poller = null }
  }

  const startPolling = () => {
    if (polling || closed) return
    polling = true
    retryAt = Date.now() + retryDelay   // 别刚掉下来就立刻猛冲，先等一个退避
    const tick = async () => {
      if (closed || !polling) return
      await syncSessionEvents(sessionId, ac.signal)
      // ⚠️ 每一步都要重新判：await 期间订阅可能已被取消，或 SSE 已经连回来把轮询停了。
      // 少判一次就会出现「SSE 与轮询两条源同时写 store」——白烧带宽，还会放大气泡闪烁。
      if (closed || !polling) return
      const st = useAppStore.getState().sessions.find((s) => s.id === sessionId)?.state
      const fast = st === 'running' || st === 'waiting_approval' || st === 'waiting_input'
      poller = setTimeout(() => void tick(), fast ? 1000 : 2500)
    }
    void tick()
  }

  // ── 心跳看门狗 ──────────────────────────────────────────────────────────────
  // SSE 的经典失败模式是**半死连接**：手机休眠 / 切后台 / NAT/代理超时之后，TCP 还开着，
  // 但一个字节也不再来。此时 `onerror` **永不触发**、`readyState` 恒 OPEN —— 上面那个
  // "CLOSED 才回退轮询"的判据永远等不到，于是**兜底轮询永不启动，界面永久冻在旧数据上**。
  // 用户实测：看板显示"刚刚"、摘要是最新的助手输出，而对话流停在 15 分钟前，等多久都不刷新。
  // 服务端每 15s 发一次具名 `ping` 事件（此前是注释行 `: ping`，浏览器根本不暴露给 JS，
  // 前端无从判活）。这里据它判定：45s 一个字节都没来 → 认定连接已死，主动重建。
  const HEARTBEAT_TIMEOUT_MS = 45_000
  let lastSeen = Date.now()
  const bump = () => { lastSeen = Date.now() }

  const connect = () => {
    if (closed) return
    try {
      const source = new EventSource(`/api/session/${sessionId}/stream`)
      es = source
      es.onopen = () => {
        if (closed || es !== source) return
        bump()
        // 连回来了：停轮询、复位退避。**必须等 onopen 而不是"发起连接就停"**——
        // 后者会在服务端持续不可用时把兜底也一起关掉，比原 bug 更糟。
        retryDelay = SSE_RETRY_MIN_MS
        stopPolling()
      }
      es.onmessage = (ev) => {
        if (closed || es !== source) return
        bump()
        try { applyPayload(sessionId, JSON.parse(ev.data)) } catch { /* 忽略坏帧 */ }
      }
      // 具名事件不触发 onmessage，不会污染 applyPayload；只用来判活
      es.addEventListener('ping', bump)
      es.onerror = () => {
        if (closed || es !== source) return
        // CONNECTING=浏览器正自动重连，放行；CLOSED=致命，回退轮询
        if (es && es.readyState === EventSource.CLOSED) { es = null; startPolling() }
      }
    } catch {
      es = null
      startPolling()
    }
  }
  connect()

  const isActive = () => {
    const st = useAppStore.getState().sessions.find((s) => s.id === sessionId)?.state
    return st === 'running' || st === 'waiting_approval' || st === 'waiting_input'
  }

  const watchdog = setInterval(() => {
    // 轮询兜底中（es 为 null）：这里是**唯一的回程**，按退避周期性重建 SSE。
    // 原实现在这一行直接 return，于是永远回不去（见 startPolling 上方注释）。
    if (closed) return
    if (!es) {
      if (!polling || Date.now() < retryAt) return
      retryDelay = Math.min(retryDelay * 2, SSE_RETRY_MAX_MS)  // 服务端真挂了就别每拍猛冲
      retryAt = Date.now() + retryDelay
      connect()                                     // 成功与否由 onopen / onerror 决定
      return
    }
    // 只在会话**活跃**时判死：空闲会话本来就没有数据流（服务端 sig 去重，内容没变就不发帧），
    // 无差别判死会对着尚未升级、不发 ping 的旧 agent 每 45s 重连一次，纯属自找麻烦。
    if (!isActive()) { bump(); return }
    if (Date.now() - lastSeen < HEARTBEAT_TIMEOUT_MS) return
    try { es.close() } catch { /* 已关 */ }
    es = null
    bump()                                          // 重置计时，避免重建后立刻又被判死
    void syncSessionEvents(sessionId, ac.signal)    // 先带游标补一次增量，别让用户干等重连
    connect()
  }, 10_000)

  // 从后台切回前台：移动端 PWA 最常见的场景。休眠期间连接多半已死，
  // 立刻补拉一次（带游标，只取增量），别等看门狗那 45s。
  const onVisible = () => {
    if (closed || document.visibilityState !== 'visible') return
    void syncSessionEvents(sessionId, ac.signal)
    // 切回前台：立刻放行一次重建尝试，别让用户干等退避（此时多半正是网络刚恢复的时刻）
    if (polling) { retryAt = 0; retryDelay = SSE_RETRY_MIN_MS }
    if (!es) { bump(); connect(); return }
    if (es && Date.now() - lastSeen > 10_000) { try { es.close() } catch { /* 已关 */ } es = null; bump(); connect() }
  }
  document.addEventListener('visibilitychange', onVisible)
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onVisible() }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onVisible)
    window.addEventListener('pageshow', onPageShow)
  }

  return () => {
    closed = true
    stopPolling()
    es?.close()
    ac.abort() // 掐掉在途的 /events —— 迟到的响应不得再写 store
    clearInterval(watchdog)
    document.removeEventListener('visibilitychange', onVisible)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onVisible)
      window.removeEventListener('pageshow', onPageShow)
    }
    if (poller) clearTimeout(poller)
  }
}
