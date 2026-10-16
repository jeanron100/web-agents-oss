import { create } from 'zustand'
import type {
  ChatEvent, Engine, PendingAction, PermissionMode, Server, Session, SessionExtras, SessionState, MessageBehavior, MessageDelivery,
} from '../types'
import * as seed from '../mock/seed'
import { estCostOf } from '../lib/cost'

export interface ImagePayload { media_type: string; data: string }

export interface SessionTemplate {
  id: string
  name: string
  prompt: string
  mode?: PermissionMode
  model?: string
}

/** 流式输出队列：eventId -> 待追加文本（mock 专用，真实 Hub 接入后由 WSS 增量替代） */
const streamQueue = new Map<string, string>()
let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${++idSeq}`

/** 浅比较两个对象的一层字段是否全等（用于轮询去抖：内容没变就复用旧引用） */
function sameShallow<T>(a: T, b: T): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  if (ka.length !== Object.keys(rb).length) return false
  for (const k of ka) if (ra[k] !== rb[k]) return false
  return true
}

/**
 * 列表对账：按 key 复用上一轮内容相同的对象引用，使 React.memo 跳过未变项。
 * 整列完全未变时返回**原数组引用**，让选择器订阅者直接不触发重渲染（空轮询变 no-op）。
 */
function reconcileList<T>(prev: T[], next: T[], keyOf: (x: T) => string): T[] {
  const prevByKey = new Map(prev.map((x) => [keyOf(x), x]))
  const merged = next.map((n) => {
    const p = prevByKey.get(keyOf(n))
    return p && sameShallow(p, n) ? p : n
  })
  if (merged.length === prev.length && merged.every((x, i) => x === prev[i])) return prev
  return merged
}

// 乐观用户气泡保留窗：刚发出的消息在服务端回写前先显示这么久；期间被服务端按文本回显即换成真消息，
// 超窗仍未回显则判定发送失败清掉。取 60s 足够覆盖一次 poll/落盘延迟，又不会让失败的幽灵久留。
const OPTIMISTIC_KEEP_MS = 60_000

/**
 * 已提交待办的「墓碑」：actionId -> 提交时刻。
 *
 * 为什么需要它（用户实测：「点了允许，卡片消失后又突然冒出来，然后再消失」）：
 * 点击 → 本地乐观把该待办标成 resolved（卡片据此隐藏）。但 `/api/state` **每 3s 轮询一次**，
 * 而 applyState 用 reconcileList **拿服务端列表整份覆盖本地**。只要有一次轮询的快照**早于**
 * 这次点击（请求在途、或 hub 那一拍还没轮到 agent），它返回的这条仍是 pending →
 * `sameShallow(本地resolved, 服务端pending)` 为假 → 直接采用服务端那份 → **卡片复活**；
 * 再下一拍服务端处理完了 → 卡片二次消失。可见时长恰好一个轮询周期，与用户描述完全吻合。
 *
 * 墓碑期内（TTL）：服务端若仍把它报成 pending，一律按本地的 resolved 压住，不让陈旧快照复活它。
 * 服务端一旦不再报它（真正处理完），墓碑自然失去作用；超时清理避免无限增长。
 * TTL 取 20s：远大于「轮询周期(3s) + hub 轮询 agent(5s) + 网络往返」，又不至于在服务端真的
 * 处理失败时把卡片永久藏起来（超时后服务端仍报 pending 就会重新显示，用户可以重试）。
 */
const RESOLVED_TTL_MS = 20_000

// 上次在线状态快照：进入应用即秒显，避免首屏白等 hub 全量扇出
const SNAP_KEY = 'agent-console-snapshot'
type Snapshot = { servers: Server[]; sessions: Session[]; projectModels?: Record<string, string> }
function loadSnapshot(): Snapshot | null {
  const s = loadLocal<Snapshot | null>(SNAP_KEY, null)
  return s && Array.isArray(s.sessions) && Array.isArray(s.servers) ? s : null
}
function saveSnapshot(servers: Server[], sessions: Session[], projectModels: Record<string, string>) {
  // 只存看板渲染所需，截断防止 localStorage 膨胀；projectModels 一并存 → 冷启动首个 /api/state 到达前即可预填首选模型，避免迟到 pref 覆盖手选
  saveLocal(SNAP_KEY, { servers, sessions: sessions.slice(0, 80), projectModels })
}

/**
 * 从本地快照（上次成功轮询的截面）找回某会话 id 归属的项目——用于会话详情深链命中的 id 已不在
 * 当前 state（agent 重启退回影子态换了新 id，或超出各项目扫描窗口老化掉）时，定位「它曾属于哪个
 * 项目」，从而引导用户改道到该项目的当前会话，而不是干巴巴一句"会话不存在"（稳定性 #8）。
 * 快照最多存 80 条，找不到则 null（真正陌生的 id，或快照本身还没写入过）。
 */
export function snapshotSessionMeta(id: string): { serverId: string; project: string; engine: string } | null {
  const snap = loadSnapshot()
  const s = snap?.sessions.find((x) => x.id === id)
  return s ? { serverId: s.serverId, project: s.project, engine: s.engine } : null
}

export interface AppState {
  servers: Server[]
  sessions: Session[]
  events: Record<string, ChatEvent[]>
  extras: Record<string, SessionExtras>
  pendingActions: PendingAction[]
  /** 每项目首选模型（"serverId/project" -> 模型 id），来自 /api/state */
  projectModels: Record<string, string>
  /** 数据源：live=真实 Hub，mock=演示数据 */
  source: 'mock' | 'live'
  /** 星标项目（serverId/project），localStorage 持久化 */
  starred: string[]
  hiddenProjects: string[]
  toggleHideProject: (serverId: string, project: string) => void
  setHiddenProjects: (list: string[]) => void
  toggleStar: (serverId: string, project: string) => void
  /** 每项目上次打开的会话（serverId/project -> sessionId），localStorage 持久化 */
  lastSessions: Record<string, string>
  rememberSession: (serverId: string, project: string, sessionId: string) => void
  /** 首次数据到达前为 false（骨架屏依据） */
  bootstrapped: boolean
  /** 演示数据装载（仅 Hub 不可达时由 MockHubClient 调用） */
  loadSeed: () => void
  /** 会话模板，localStorage 持久化 */
  templates: SessionTemplate[]
  addTemplate: (t: Omit<SessionTemplate, 'id'>) => void
  removeTemplate: (id: string) => void

  /**
   * 「会话历史」的冷路径结果（/api/project/sessions），**applyState 绝不碰它**。
   *
   * 为什么单开一片而不是并进 sessions：sessions 由 applyState 用服务端列表**整份覆盖**
   * （reconcileList），历史条目并进去会被下一拍 3s 轮询直接抹掉——和「陈旧快照覆盖乐观更新」
   * 是同一个机理（见 CLAUDE.md）。这片只由 loadProjectHistory 写。
   */
  historySessions: Session[]
  /** 拉某项目的会话历史（进入会话详情页即拉一次；深链命中不在实时列表的老会话时也拉） */
  loadProjectHistory: (serverId: string, project: string, limit?: number) => Promise<void>
  /** 真实数据源应用全量状态（轮询 /api/state） */
  applyState: (servers: Server[], sessions: Session[], pendingActions: PendingAction[], projectModels: Record<string, string>) => void
  /** 真实数据源应用某会话的事件与附加数据（全量替换，用于 snapshot/reset 帧或旧后端无 kind 时） */
  applyEvents: (sessionId: string, events: ChatEvent[], extras: SessionExtras) => void
  /** 增量帧合并（append 帧）：保留既有 durable 事件，丢弃既有瞬时流式事件后按 id upsert，再走 applyEvents */
  appendEvents: (sessionId: string, incoming: ChatEvent[], extras: SessionExtras) => void

  /** CAS 解决待办：已处理则 no-op 并返回 false（FR-I4 单端幂等） */
  resolveAction: (id: string, resolution: string) => boolean
  sendMessage: (sessionId: string, text: string, images?: ImagePayload[], behavior?: MessageBehavior) => void
  interrupt: (sessionId: string) => void
  setMode: (sessionId: string, mode: PermissionMode) => void
  /** mock 时钟推进：进度条、流式文本、活动时间 */
  _tick: () => void

  /** 手动刷新信号：自增计数，看板各用量卡片(StatChips/UsageSummary/CodexUsageSummary)监听它即时重拉 */
  refreshSeq: number
  bumpRefresh: () => void

  /** 与 Hub 的同步态：ok=正常，stale=连续失败 2~4 次，lost=连续失败 ≥5 次（失联可见） */
  syncStatus: 'ok' | 'stale' | 'lost'
  /** 最近一次成功同步的时间戳（ms），失联横幅据此算「失联 N 秒」 */
  lastSyncTs: number
  /** 墙钟推进计数：每 30s 自增一次，供相对时间展示订阅以自走 */
  clockTick: number
  /** 连续失败次数（内部计数，驱动 syncStatus 阈值判定） */
  _failStreak: number
  /** refreshNow() 成功/失败回报：驱动 syncStatus/lastSyncTs/_failStreak */
  noteSync: (ok: boolean) => void
  /** 墙钟 tick：clockTick+1 */
  bumpClock: () => void

  /**
   * 数据层看门狗的当前告警 + 告警通道健康（服务端 alerts.snapshot()，随 /api/state 下发）。
   * 存在的理由是一次真实事故：Mongo 隧道断了 10 天没人发现——看门狗每 60s 都正确判定为 down，
   * 但唯一出口 Web Push 的订阅者是 0，3658 条告警全推进虚空，期间 spool 涨破上限丢了历史数据。
   * 所以界面必须自己显示告警：控制台是用户每天都开的东西，这个出口不依赖「有没有人记得订阅」。
   */
  alerts: { firing: { key: string; since: number; text?: string }[]; channel: { deliverable: boolean; subscribers: number; dropping: boolean; hint: string } } | null
  setAlerts: (a: AppState['alerts']) => void

  /** 最近一次写操作（审批/发消息/中断/切模式）失败的可见提示；null=无。App 层展示 5s 后自动清除 */
  writeError: { text: string; ts: number } | null
  /** 写操作失败上报（后端非 2xx / 网络错误），供 UI 提示"没送达"，避免乐观更新静默吞掉失败 */
  noteWriteError: (text: string) => void
  /** 清除写失败提示 */
  clearWriteError: () => void
}

function patchSession(sessions: Session[], id: string, patch: Partial<Session>): Session[] {
  return sessions.map((s) => (s.id === id ? { ...s, ...patch, lastActiveAt: Date.now() } : s))
}

/**
 * 守卫写请求：live 分支的写操作原先都是 `void fetch(...)` 发后不管，后端 500/网络错误对用户完全静默
 * （典型：Codex app-server 崩溃后点审批 → 后端 send() 在 proc===null 上抛 TypeError 返回 500，但乐观
 * 更新已让待办变绿/消失，用户以为成功——稳定性盘点 gap #11）。这里补一层：非 2xx 或网络错误时经
 * note() 上报可见提示。会话状态字段本身由下一轮 /api/state 全量轮询自愈，此处只让"没送达"对用户可见。
 */
function guardWrite(p: Promise<Response>, note: (t: string) => void, label: string) {
  p.then(
    (res) => {
      if (res.ok) return
      // 504 = hub 转发超时：请求**已经送达**上游，只是 hub 没等到应答（详见 server/forward-error.js）。
      // 结果未知，所以既不能说「未送达」，也不能催用户重试——重试等于重放一个可能已生效的写操作。
      // 真实账：2026-07-18 22:34 用户就是照着「未送达，请重试」连点了 6 次。
      // 会话态本来就由下一轮 /api/state 全量轮询自愈，这里只要如实说「结果未知，以列表为准」。
      // 409 = 上游说「待办不存在或已处理」：同样是**送达了**，而且多半是上一次（超时那次）
      // 其实已经生效。再喊「未送达，请重试」就会把用户钉在重试循环里——事故当晚就是这样连点 6 次。
      note(res.status === 504
        ? `${label}超时，结果未知——请勿重复提交，稍候以列表为准`
        : res.status === 409
          ? `该待办已处理（可能是上一次提交已生效），无需重复操作`
          : `${label}未送达服务器，请重试`)
    },
    () => note(`${label}未送达服务器，请重试`), // 网络层直接失败：确实没送达
  )
}

const STAR_KEY = 'agent-console-starred'
// 隐藏项目（「隐藏 = 不加入项目纳管」，用户 2026-09-06）。
// ⚠️ 与星标不同，**权威在服务端**：隐藏不是"这台设备上少画一张卡片"，而是 agent 那边
//    真的不再扫描这个项目（名单由 hub 随每次轮询下发）。localStorage 只是首屏免闪的镜像，
//    服务端名单一到就以它为准——否则换设备/新浏览器看到的是另一套。
const HIDE_KEY = 'agent-console-hidden-projects'
const TPL_KEY = 'agent-console-templates'
// 每项目「上次打开的会话」（"serverId/project" -> sessionId）。
// 为什么需要它：项目卡片的主会话原本只由 sortSessions 决定，而它的**主序是状态优先级**
// （waiting_input=1 排在 running=2 前面）。于是一个停在「等待输入」的旧会话会**永久压住**
// 正在跑的新会话——用户在会话历史里切走，一退回看板再点进来又是那个旧的，切了等于没切。
const LAST_SESSION_KEY = 'agent-console-last-session'
function loadLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(globalThis.localStorage?.getItem(key) ?? '') ?? fallback } catch { return fallback }
}
function saveLocal(key: string, v: unknown) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(v)) } catch { /* 私密模式 */ }
}
function loadStarred(): string[] {
  return loadLocal(STAR_KEY, [])
}

const DEFAULT_TEMPLATES: SessionTemplate[] = [
  { id: 'tpl-test', name: '跑测试并修复', prompt: '运行项目的测试套件，如有失败用例，逐个修复直到全部通过，最后给出修复摘要。' },
  { id: 'tpl-review', name: '代码自查', prompt: '检查最近一次提交以来的改动，找出潜在 bug、安全隐患和可简化之处，只报告不修改。', mode: 'plan' },
  { id: 'tpl-daily', name: '写今日小结', prompt: '根据今天的 git 提交记录和工作区改动，写一份简短的中文日报（做了什么/遇到什么问题/明天计划）。' },
]

export const starKey = (serverId: string, project: string) => `${serverId}/${project}`

/**
 * 从会话列表里滤掉隐藏项目。
 *
 * ★ 前端这一层是**即时反馈**，不是真正的过滤——服务端才是权威（agent 根本不扫）。
 *   但链路有延迟：前端 3s 轮 hub、hub 5s 轮 agent ⇒ 最坏 ~8s。
 *   没有这一层，用户点了「隐藏」会盯着卡片纹丝不动看好几秒，然后以为按钮坏了去连点。
 */
export function visibleSessions<T extends { serverId: string; project: string }>(
  list: T[], hidden: string[],
): T[] {
  if (!hidden?.length) return list
  const set = new Set(hidden)
  return list.filter((s) => !set.has(starKey(s.serverId, s.project)))
}

export function createAppStore({ seeded = false }: { seeded?: boolean } = {}) {
  const snap = seeded ? null : loadSnapshot()
  // 每个 store 实例一份（别放模块级：多实例会互相污染，测试尤其）
  const resolvedTombstones = new Map<string, { ts: number; resolution: string }>()
  return create<AppState>((set, get) => ({
    servers: seeded ? seed.servers : (snap?.servers ?? []),
    sessions: seeded ? seed.sessions : (snap?.sessions ?? []),
    events: seeded ? seed.chatEvents : {},
    extras: seeded ? seed.sessionExtras : {},
    pendingActions: seeded ? seed.pendingActions : [],
    projectModels: snap?.projectModels ?? {},
    historySessions: [],
    loadProjectHistory: async (serverId, project, limit = PROJECT_HISTORY_LIMIT) => {
      try {
        const qs = `server=${encodeURIComponent(serverId)}&project=${encodeURIComponent(project)}&limit=${limit}`
        const res = await fetch(`/api/project/sessions?${qs}`)
        if (!res.ok) return // 拉不到就维持现状：历史 Tab 退化成只显示实时列表，不该整页报错
        const data = await res.json()
        const rows: Session[] = data.sessions ?? []
        if (!rows.length) return
        set((st) => {
          // 同项目的旧结果整体换新，其它项目的保留（用户可能在几个项目间来回切）
          const others = st.historySessions.filter((s) => !(s.serverId === serverId && s.project === project))
          return { historySessions: [...others, ...rows] }
        })
      } catch { /* 网络抖动：静默退化，不打断当前会话浏览 */ }
    },
    source: 'mock',
    refreshSeq: 0,
    bumpRefresh: () => set((st) => ({ refreshSeq: st.refreshSeq + 1 })),
    starred: loadStarred(),
    hiddenProjects: loadLocal<string[]>(HIDE_KEY, []),
    lastSessions: loadLocal<Record<string, string>>(LAST_SESSION_KEY, {}),
    // 有快照即直接出卡片（虽是上次状态），首轮 live 轮询到达后被覆盖；避免白屏骨架
    bootstrapped: seeded || !!snap,
    templates: loadLocal<SessionTemplate[]>(TPL_KEY, DEFAULT_TEMPLATES),

    syncStatus: 'ok',
    lastSyncTs: Date.now(),
    clockTick: 0,
    _failStreak: 0,
    noteSync: (ok) => {
      set((st) => {
        if (ok) return { syncStatus: 'ok', lastSyncTs: Date.now(), _failStreak: 0 }
        const failStreak = st._failStreak + 1
        const syncStatus: AppState['syncStatus'] = failStreak >= 5 ? 'lost' : failStreak >= 2 ? 'stale' : 'ok'
        return { _failStreak: failStreak, syncStatus }
      })
    },
    bumpClock: () => set((st) => ({ clockTick: st.clockTick + 1 })),

    alerts: null,
    // 按【内容】比较后再决定要不要换引用：对象是嵌套的，sameShallow 每拍都会判"不同"
    // （每次轮询都是新对象），那样每 3 秒白白重渲染一次全局横幅。常态下它是 {firing:[],…}，
    // stringify 的开销可以忽略。
    setAlerts: (a) => set((st) => (JSON.stringify(st.alerts) === JSON.stringify(a) ? {} : { alerts: a })),

    writeError: null,
    noteWriteError: (text) => set({ writeError: { text, ts: Date.now() } }),
    clearWriteError: () => set({ writeError: null }),

    loadSeed: () => {
      set({
        servers: seed.servers,
        sessions: seed.sessions,
        events: seed.chatEvents,
        extras: seed.sessionExtras,
        pendingActions: seed.pendingActions,
        projectModels: {},
        source: 'mock',
        bootstrapped: true,
        syncStatus: 'ok',
        lastSyncTs: Date.now(),
        clockTick: 0,
        _failStreak: 0,
        writeError: null,
      })
    },

    addTemplate: (t) => {
      set((st) => {
        const templates = [...st.templates, { ...t, id: nextId('tpl') }]
        saveLocal(TPL_KEY, templates)
        return { templates }
      })
    },

    removeTemplate: (id) => {
      set((st) => {
        const templates = st.templates.filter((t) => t.id !== id)
        saveLocal(TPL_KEY, templates)
        return { templates }
      })
    },

    rememberSession: (serverId, project, sessionId) => set((st) => {
      const key = starKey(serverId, project)
      if (st.lastSessions[key] === sessionId) return st   // 无变化不重渲染（每次轮询都会走到这里）
      const lastSessions = { ...st.lastSessions, [key]: sessionId }
      saveLocal(LAST_SESSION_KEY, lastSessions)
      return { lastSessions }
    }),
    toggleHideProject: (serverId, project) => {
      const key = starKey(serverId, project)
      set((st) => {
        const hiddenProjects = st.hiddenProjects.includes(key)
          ? st.hiddenProjects.filter((k) => k !== key)
          : [...st.hiddenProjects, key]
        saveLocal(HIDE_KEY, hiddenProjects)
        // 落服务端。失败不回滚也不阻塞 UI：下一拍 setHiddenProjects 会以服务端为准把它纠正回来
        // （与 categories 同款策略）。这里刻意不 await —— 跨境链路 ~11KB/s，等它等不起。
        void fetch('/api/hidden-projects', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hidden: hiddenProjects }),
        }).catch(() => { /* 离线/降级：本地先生效 */ })
        return { hiddenProjects }
      })
    },
    setHiddenProjects: (list) => {
      // ⚠️ 坏数据一律忽略，**不能清空本地名单**。服务端抖一下就让所有隐藏项目全冒出来，
      //    是本仓库反复栽过的那类「省略被当成空」的塌陷（/api/state 增量协议那条）。
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) return
      saveLocal(HIDE_KEY, list)
      set({ hiddenProjects: list })
    },
    toggleStar: (serverId, project) => {
      const key = starKey(serverId, project)
      set((st) => {
        const starred = st.starred.includes(key)
          ? st.starred.filter((k) => k !== key)
          : [...st.starred, key]
        saveLocal(STAR_KEY, starred)
        return { starred }
      })
    },

    applyState: (servers, sessions, pendingActions, projectModels) => {
      set((st) => {
        // 引用稳定对账：无变化的卡片复用旧引用 → React.memo 跳过；整列没变 → 选择器不触发
        const nextServers = reconcileList(st.servers, servers, (x) => x.id)
        const nextSessions = reconcileList(st.sessions, sessions, (x) => x.id)
        // 墓碑：陈旧快照不得复活刚刚被本地解决掉的待办（见 resolvedTombstones 注释——用户实测的
        // 「卡片消失→又冒出来→再消失」就是这里被服务端的旧快照整份覆盖造成的）
        const now = Date.now()
        for (const [id, t] of resolvedTombstones) if (now - t.ts > RESOLVED_TTL_MS) resolvedTombstones.delete(id)
        const shielded = resolvedTombstones.size === 0 ? pendingActions : pendingActions.map((a) => {
          const t = resolvedTombstones.get(a.id)
          return t && a.status === 'pending' ? { ...a, status: 'resolved' as const, resolution: t.resolution } : a
        })
        const nextPending = reconcileList(st.pendingActions, shielded, (x) => x.id)
        // 仅在内容真变时写盘（空轮询 nextSessions 复用旧引用，跳过无谓 localStorage 写入）
        if (nextSessions !== st.sessions || nextServers !== st.servers) saveSnapshot(nextServers, nextSessions, projectModels)
        return {
          servers: nextServers,
          sessions: nextSessions,
          pendingActions: nextPending,
          projectModels,
          source: 'live',
          bootstrapped: true,
        }
      })
    },

    applyEvents: (sessionId, events, extras) => {
      set((st) => {
        const prev = st.events[sessionId] ?? []
        // 1) 保留刚发出、服务端尚未回写的乐观用户消息，直到：① 服务端按文本回显（下面 some() 去重）→ 无缝
        //    换成真消息；② 或超过保留窗仍未回显（判定为发送失败的幽灵）→ 清掉。
        //    · 用「绝对时间窗」而非「比最后一条服务端事件更新(e.ts>=lastServerTs)」——后者会在助手一开始
        //      流式输出（其 ts 略晚于用户消息）时，就把尚未落盘的用户气泡误删，造成"我刚发的消息刷一下没了/像幻觉"。
        //    · ⚠️ 判别本地气泡用【专属前缀 'opt-'】(nextId('opt'))，服务端从不产生该前缀。别用 'ev-'：新建平台
        //      会话的服务端【内存】用户事件 id 同为 'ev-' 前缀且【无 seq】(driver.js nid('ev'))，用 'ev-' 或
        //      seq==null 都分不清，忙会话里一条滚出快照窗口的真用户消息会被误当乐观气泡重钉成错位幽灵重复
        //      （对抗式复核 CONFIRMED：绝对时间窗放大了这个歧义）。专属前缀彻底消歧。
        //    · 去重按「本轮新出现的服务端事件」而非「任意同文本」：只有【新到】(id 不在 prev) 的同文本用户事件
        //      才算这条气泡的回显。否则重复发同一句（'继续'/'y'/'ok'）时，早先那条已回显的同文本会把刚发的气泡误删。
        const prevIds = new Set(prev.map((e) => e.id))
        const optimistic = prev.filter((e) =>
          String(e.id).startsWith('opt-') && e.type === 'user' && e.ts >= Date.now() - OPTIMISTIC_KEEP_MS &&
          !events.some((se) => se.type === 'user' && 'text' in se && se.text === e.text && !prevIds.has(se.id)),
        )
        // 2) 服务端事件按 id 对账复用引用 → 已渲染气泡不重建，滚动稳定
        const prevById = new Map(prev.map((e) => [e.id, e]))
        const reconciled = events.map((raw) => {
          const receipt = extras.messageReceipts?.[raw.id]
          const e = raw.type === 'user' && receipt ? { ...raw, delivery: receipt.delivery, deliveryReason: receipt.reason } : raw
          const p = prevById.get(e.id)
          return p && sameShallow(p, e) ? p : e
        })
        // 3) 乐观气泡按 ts 插进服务端序列，而不是无脑拼在末尾。
        //    曾经是 `[...reconciled, ...optimistic]`：发出的瞬间它确实最新、看不出毛病；可助手一开始流式
        //    输出，那条流式事件就进了 reconciled 排在气泡【前面】⇒ 界面变成「助手回答在上、我的提问在下」
        //    （用户报的「问题怎么出现在下面」）。
        //    ⚠️ 只给气泡定位，**绝不整份按 ts 排序**：JSONL 里服务端事件的 ts 本就可能非单调（工具结果常
        //    沿用 tool_use 的 ts），全量排序会把权威源的顺序改掉。splice 不动既有元素的相对次序。
        const merged = reconciled.slice()
        for (const o of optimistic) {
          let i = merged.length
          while (i > 0 && merged[i - 1].ts > o.ts) i--
          merged.splice(i, 0, o)
        }
        const prevExtras = st.extras[sessionId]
        const nextExtras = prevExtras && sameShallow(prevExtras, extras) ? prevExtras : extras
        return {
          events: { ...st.events, [sessionId]: merged },
          extras: { ...st.extras, [sessionId]: nextExtras },
        }
      })
    },

    /**
     * 断线续传（Phase 2 §4.4）：append 帧只带增量，不能直接替换。合并规则——
     * 保留既有 durable 事件（seq!=null，已落盘不会变）；丢弃既有瞬时流式事件（seq==null，
     * 每次 append 都会把它整份重发）；再用 incoming 按 id upsert（Map 保序 → durable 顺序 +
     * 新 durable + 当前流式）。Claude 流式转终态换了新 id → 旧流式被丢、新终态被加，不重复；
     * Codex 流式转终态复用同 id → 旧流式被丢、新终态覆盖同位置，也不重复。
     * 合并结果再交给 applyEvents，复用其乐观气泡保留 + 按 id 引用对账逻辑。
     */
    appendEvents: (sessionId, incoming, extras) => {
      const existing = get().events[sessionId] ?? []
      const merged = new Map<string, ChatEvent>()
      for (const e of existing) if (e.seq != null) merged.set(e.id, e)
      for (const e of incoming) merged.set(e.id, e)
      get().applyEvents(sessionId, [...merged.values()], extras)
    },

    resolveAction: (id, resolution) => {
      const action = get().pendingActions.find((a) => a.id === id)
      if (!action || action.status !== 'pending') return false

      if (get().source === 'live') {
        // 乐观更新：移除该待办（验收类不改会话状态），具体状态以下个轮询周期服务端为准
        const optimistic: Partial<Session> | null =
          action.kind === 'review' ? null
          : action.kind === 'approval' && resolution === '拒绝' ? { state: 'idle', summary: '已拒绝' }
          : { state: 'running', summary: '已处理，继续执行…' }
        // 立墓碑：接下来 RESOLVED_TTL_MS 内，任何仍把它报成 pending 的服务端快照都视为**陈旧**，
        // 不得让卡片复活（这行没有的话，就是用户看到的「消失→又冒出来→再消失」）。
        resolvedTombstones.set(id, { ts: Date.now(), resolution })
        set((st) => ({
          pendingActions: st.pendingActions.map((a) =>
            a.id === id ? { ...a, status: 'resolved' as const, resolution } : a,
          ),
          sessions: optimistic ? patchSession(st.sessions, action.sessionId, optimistic) : st.sessions,
        }))
        guardWrite(
          fetch(`/api/action/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution }),
          }),
          get().noteWriteError,
          action.kind === 'question' ? '回复' : action.kind === 'review' ? '验收' : '审批',
        )
        return true
      }

      set((st) => {
        const pendingActions = st.pendingActions.map((a) =>
          a.id === id ? { ...a, status: 'resolved' as const, resolution } : a,
        )
        let sessions = st.sessions
        const events = { ...st.events }
        const sid = action.sessionId

        switch (action.kind) {
          case 'approval':
            sessions = resolution === '拒绝'
              ? patchSession(sessions, sid, { state: 'idle', summary: `已拒绝：${action.detail}` })
              : patchSession(sessions, sid, { state: 'running', summary: '已批准，继续执行…' })
            break
          case 'question': {
            events[sid] = [
              ...(events[sid] ?? []),
              { id: nextId('opt'), sessionId: sid, ts: Date.now(), type: 'user', text: resolution },
            ]
            sessions = patchSession(sessions, sid, { state: 'running', summary: '收到回复，继续执行…' })
            break
          }
          case 'plan':
            sessions = resolution === '打回修改'
              ? patchSession(sessions, sid, { state: 'waiting_input', summary: '计划被打回，等待修改' })
              : patchSession(sessions, sid, { state: 'running', summary: '计划已批准，开始执行…' })
            break
          case 'review':
            // 验收不改变会话状态（done 保持），仅消除待办
            break
        }
        return { pendingActions, sessions, events }
      })
      return true
    },

    sendMessage: (sessionId, text, images = [], behavior) => {
      if (get().source === 'live') {
        const codex = get().sessions.find(s => s.id === sessionId)?.engine === 'codex'
        const messageBehavior = codex ? behavior ?? 'steer' : undefined
        const evId = nextId('opt')
        set((st) => ({
          events: {
            ...st.events,
            [sessionId]: [...(st.events[sessionId] ?? []), { id: evId, sessionId, ts: Date.now(), type: 'user' as const, text, delivery: 'sending' as const, messageBehavior, imageCount: images.length || undefined }],
          },
          sessions: patchSession(st.sessions, sessionId, { state: 'running', summary: '正在处理新指令…' }),
        }))
        // 消息不同于审批：乐观气泡不会被后续 /api/state 轮询自愈（服务端根本没收到这条），
        // 失败时必须主动撤回气泡并提示重发，否则用户会以为消息已发出（稳定性 gap #11）。
        const rollback = () => {
          get().noteWriteError('消息未送达服务器，请重试')
          set((st) => ({ events: { ...st.events, [sessionId]: (st.events[sessionId] ?? []).filter((e) => e.id !== evId) } }))
        }
        const setDelivery = (delivery: MessageDelivery, deliveryReason?: string) => set((st) => ({
          events: { ...st.events, [sessionId]: (st.events[sessionId] ?? []).map((e) => e.id === evId && e.type === 'user' ? { ...e, delivery, deliveryReason } : e) },
        }))
        const unknown = () => {
          setDelivery('unknown')
          get().noteWriteError('消息送达状态待确认，请勿重复发送；稍候查看对话流')
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 25_000)
        fetch(`/api/session/${sessionId}/message`, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, images, ...(messageBehavior ? { behavior: messageBehavior } : {}) }),
        }).then(async (res) => {
          const body = await res.json?.().catch(() => ({})) ?? {}
          if (res.status === 504 || body.indeterminate) { unknown(); return }
          if (!res.ok) {
            rollback()
            if (body.error) get().noteWriteError(`消息未送达：${body.error}`)
            return
          }
          setDelivery(body.delivery === 'steered' ? 'steered' : body.queued ? 'queued' : 'accepted', body.reason)
        }, unknown).finally(() => clearTimeout(timeout))
        return
      }
      const userEv: ChatEvent = { id: nextId('ev'), sessionId, ts: Date.now(), type: 'user', text }
      const replyId = nextId('ev')
      const replyEv: ChatEvent = { id: replyId, sessionId, ts: Date.now(), type: 'assistant', text: '', streaming: true }
      streamQueue.set(replyId, `好的，开始处理：${text}。我先评估涉及的文件范围，然后逐步给出修改。`)
      set((st) => ({
        events: { ...st.events, [sessionId]: [...(st.events[sessionId] ?? []), userEv, replyEv] },
        sessions: patchSession(st.sessions, sessionId, { state: 'running', summary: '正在处理新指令…' }),
      }))
    },

    interrupt: (sessionId) => {
      if (get().source === 'live') {
        set((st) => ({
          sessions: patchSession(st.sessions, sessionId, { state: 'idle', summary: '已被用户中断' }),
        }))
        guardWrite(fetch(`/api/session/${sessionId}/interrupt`, { method: 'POST' }), get().noteWriteError, '中断')
        return
      }
      set((st) => {
        const events = {
          ...st.events,
          [sessionId]: (st.events[sessionId] ?? []).map((e) => {
            if (e.type === 'assistant' && e.streaming) {
              streamQueue.delete(e.id)
              return { ...e, streaming: false }
            }
            return e
          }),
        }
        return {
          events,
          sessions: patchSession(st.sessions, sessionId, { state: 'idle', summary: '已被用户中断' }),
        }
      })
    },

    setMode: (sessionId, mode) => {
      set((st) => ({ sessions: patchSession(st.sessions, sessionId, { mode }) }))
      if (get().source === 'live') {
        const engine = get().sessions.find((s) => s.id === sessionId)?.engine
        const req = fetch(`/api/session/${sessionId}/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        // Codex 平台会话暂不支持热切权限模式（后端固定返回 409），UI 仍显示切换按钮但为空操作；
        // 不把这类"设计内不支持"当失败打扰用户，只对 Claude 的真实失败上报（稳定性 gap #11）。
        if (engine === 'codex') void req
        else guardWrite(req, get().noteWriteError, '权限模式切换')
      }
    },

    _tick: () => {
      set((st) => {
        // 1. running 会话推进进度与成本
        const sessions = st.sessions.map((s) => {
          if (s.state !== 'running') return s
          return {
            ...s,
            progress: s.progress != null ? Math.min(96, s.progress + Math.random() * 1.5) : s.progress,
            cost: s.cost + 0.0008,
            tokens: s.tokens + Math.floor(Math.random() * 60),
            lastActiveAt: Date.now(),
          }
        })
        // 2. 流式文本推进
        let events = st.events
        if (streamQueue.size > 0) {
          events = Object.fromEntries(
            Object.entries(st.events).map(([sid, list]) => [
              sid,
              list.map((e) => {
                if (e.type !== 'assistant' || !e.streaming || !streamQueue.has(e.id)) return e
                const remaining = streamQueue.get(e.id)!
                const take = Math.min(remaining.length, 2 + Math.floor(Math.random() * 4))
                const chunk = remaining.slice(0, take)
                const rest = remaining.slice(take)
                if (rest.length === 0) {
                  streamQueue.delete(e.id)
                  return { ...e, text: e.text + chunk, streaming: false }
                }
                streamQueue.set(e.id, rest)
                return { ...e, text: e.text + chunk }
              }),
            ]),
          )
        }
        return { sessions, events }
      })
    },
  }))
}

export const useAppStore = createAppStore()

/** mock：给种子里处于 streaming 的事件补一段续写文本 */
streamQueue.set('e8', '对于 polygon 形状，我会用射线法做点位包含判断，并缓存路径采样结果以避免每帧重算。')

// ===== 派生选择器 =====

export interface GlobalStats {
  running: number
  waitingInput: number
  waitingApproval: number
  done: number
  totalCost: number
}

export function getStats(sessions: Session[]): GlobalStats {
  return {
    running: sessions.filter((s) => s.state === 'running').length,
    waitingInput: sessions.filter((s) => s.state === 'waiting_input').length,
    waitingApproval: sessions.filter((s) => s.state === 'waiting_approval').length,
    done: sessions.filter((s) => s.state === 'done').length,
    totalCost: sessions.reduce((sum, s) => sum + estCostOf(s), 0),
  }
}

export function pendingCount(actions: PendingAction[]): number {
  return actions.filter((a) => a.status === 'pending').length
}

/** 看板排序：waiting_approval 置顶，其余按状态优先级 + 最后活动时间 */
const stateRank: Record<SessionState, number> = {
  waiting_approval: 0, waiting_input: 1, running: 2, error: 3, done: 4, idle: 5,
}

export function sortSessions(list: Session[]): Session[] {
  return [...list].sort(
    // 主序：状态优先级（要审批/要输入的置顶）→ 最近活动倒序。
    // ⚠️ 末尾必须有**稳定 tie-breaker**（project→id），让它成为**全序**：否则两项 (state,lastActiveAt)
    // 相同时顺序回退到输入数组顺序，而 hub 用 `Promise.all(agents.map(async…push))` 聚合、哪台 agent
    // 先返回就先入列 → 输入顺序**随网络时序变** → 刷新时平局项左右横跳（用户报的「感觉有些飘」）。
    // 平局只在少数时刻发生（同批新建 / 从未活跃 lastActiveAt 相等 / 远端粗粒度时间戳），但一旦发生就飘。
    (a, b) =>
      stateRank[a.state] - stateRank[b.state] ||
      b.lastActiveAt - a.lastActiveAt ||
      a.project.localeCompare(b.project) ||
      a.id.localeCompare(b.id),
  )
}

// 同一会话可能同时存在「平台记录 + 影子记录」（同 id）——典型：Codex 影子会话被接管后，既有原影子记录、
// 又新增了平台记录。二者 id 相同。若不去重：① 会话历史里同一会话出现两行、且 `s.id===当前会话.id` 时两行都标
// 「当前」；② projectEngineSession 选主会话时也会因重复而错乱。按 id 去重，保留平台记录（可交互），否则留影子。
function dedupSessionsById(list: Session[]): Session[] {
  const byId = new Map<string, Session>()
  for (const s of list) {
    const prev = byId.get(s.id)
    if (!prev || (s.origin === 'platform' && prev.origin !== 'platform')) byId.set(s.id, s)
  }
  return [...byId.values()]
}

/**
 * 项目入口优先待审批、其次正在运行，其余按最近活动选择。
 * 上次打开的历史会话不能盖过当前工作；仅同优先级且同时间时沿用上次选择。
 * 此选择器只用于项目卡片，不改变明确指定的历史会话链接或用户正在看的标签。
 */
export function projectHeadSession(list: Session[], lastOpened: Record<string, string> = {}): Session {
  const priority = (s: Session) => s.state === 'waiting_approval' ? 0 : s.state === 'running' ? 1 : 2
  const remembered = (s: Session) => Number(lastOpened[starKey(s.serverId, s.project)] === s.id)
  return [...list].sort((a, b) =>
    priority(a) - priority(b) ||
    b.lastActiveAt - a.lastActiveAt ||
    remembered(b) - remembered(a) ||
    a.id.localeCompare(b.id),
  )[0]
}

/** One dashboard entry per server/project, using the same primary session as its card. */
export function projectHeadSessions(list: Session[], lastOpened: Record<string, string> = {}): Session[] {
  const groups = new Map<string, Session[]>()
  for (const s of list) {
    const key = starKey(s.serverId, s.project)
    const group = groups.get(key) ?? []
    group.push(s)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => projectHeadSession(group, lastOpened))
}

/** 某项目（同服务器 + 同项目名）的全部会话，按最后活动时间倒序、按 id 去重。会话历史 Tab 用 */
export function sessionsOfProject(sessions: Session[], serverId: string, project: string): Session[] {
  return dedupSessionsById(sessions.filter((s) => s.serverId === serverId && s.project === project))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/**
 * 「会话历史」每项目展示条数：最近 8 个（Claude + Codex + Kimi 合集，时间倒序）。
 *
 * 为什么不是靠实时列表凑：`/api/state` 被 MAX_PER_PROJECT=3 / slice(0,2) 故意截断（3s 轮询
 * 热路径），拿它当历史只能看到 2~3 条。8 条走冷路径 `/api/project/sessions`，与热路径无关。
 */
export const PROJECT_HISTORY_LIMIT = 8

/**
 * 「会话历史」Tab 的列表 = 实时列表 ∪ 冷路径历史，按 id 去重（**实时记录优先**）、时间倒序。
 *
 * 2026-08-03 用户实拍：web_agents 磁盘 25 个会话，历史只列 2 条。根因是这个 Tab 一直只吃
 * sessionsOfProject(实时列表)，而实时列表被服务端 MAX_PER_PROJECT=3 故意截断（3s 轮询的热
 * 路径，那个截断是对的）。冷路径 /api/project/sessions 专门补历史，两者在这里汇合。
 *
 * ⚠️ 实时记录必须优先：历史行是磁盘快照，state 恒为 idle、origin 恒为 shadow。若让它盖住实时
 * 行，正在跑的会话会被显示成 idle、平台会话会被显示成影子，「当前」标记也会错位。
 *
 * ⚠️ 这个合集**不喂 projectEngineSession**（三个对话流 Tab 的数据基础）。历史行一旦参与选主，
 * 「项目没有 Kimi 会话时不显示 Kimi Tab」这条不变量就会被一条 15 天前的老会话破坏。Tab 只看实时。
 */
export function projectHistoryList(
  live: Session[], history: Session[], serverId: string, project: string,
  limit: number = PROJECT_HISTORY_LIMIT,
): Session[] {
  const pick = (list: Session[]) => list.filter((s) => s.serverId === serverId && s.project === project)
  return dedupSessionsById([...pick(live), ...pick(history)])
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    // ★ 合并结果必须**再封顶一次**。冷路径已按 limit 返回，但实时列表可能带来它没有的条目
    //   ——最典型的是当前正在跑的平台会话（`ps-*`，冷路径按设计抑制了它的影子孪生）。
    //   不封顶就会出现「要 8 条、实际渲染 9 行」（2026-08-03 被真浏览器断言抓到）。
    .slice(0, limit)
}

/**
 * 某项目（同服务器 + 同项目名）某引擎的"主会话"：优先返回 currentId 命中且引擎匹配的会话
 * （即便它不是该引擎里最近活动的一个），否则回退该项目该引擎中 lastActiveAt 最新的会话；
 * 都没有则 null。Claude / Codex / Kimi 三个对话流 Tab 对称展示用（D1）。
 */
export function projectEngineSession(
  sessions: Session[], serverId: string, project: string, engine: Engine, currentId?: string,
): Session | null {
  const matches = sessions.filter((s) => s.serverId === serverId && s.project === project && s.engine === engine)
  if (currentId) {
    const cur = matches.find((s) => s.id === currentId)
    if (cur) return cur
  }
  if (matches.length === 0) return null
  return matches.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a))
}

/**
 * 释放/清理会话后该去哪（2026-08-21 用户实拍的死循环，第一环）。
 *
 * 原实现是 `if (res.ok && data.realId) navigate('/session/' + data.realId)` —— **从不验证
 * 这个 id 能否打开**。实测：出错会话的 realId 其 JSONL 在磁盘上确实存在（23MB / 74MB），
 * 但既不在 `/api/state` 的实时列表里、也不在冷路径历史里（scanned=57、返回最近 20 条，
 * 两个都不在）⇒ 跳过去必然落到「会话不存在」，再被 SessionNotFound 自动弹到另一条
 * error 会话，于是两条死会话互相踢皮球、永远清不掉。
 *
 * ★ 与「深链到不在 /api/state 里但真实存在的会话 = 会话不存在」同一个病根：
 *   **跳转到一个从未验证过存在性的 id**。所以这里的判据只有一条 —— 它在不在已知集合里。
 *
 * @param realId release 返回的原生会话 id（可能缺失：进程没起来就没有）
 * @param known  当前可达的会话（实时列表 ∪ 已拉到的历史）
 */
export function resolveReleaseTarget(
  realId: string | null | undefined, known: Session[],
): string {
  if (!realId) return '/'
  return (known ?? []).some((s) => s.id === realId) ? `/session/${realId}` : '/'
}

/**
 * 「会话不存在」时自动改道的后继会话（同上，第二环）。
 *
 * ⚠️ **必须跳过 error 态**：原实现 `sameProject.find(s => s.engine === meta.engine) ?? sameProject[0]`
 * 不看状态，于是把用户从一个死胡同自动送进**另一条同样出错的会话**——同一个「清理此会话」
 * 按钮又出现了，这正是闭合死循环的那一环。
 *
 * 没有可用后继时返回 null：老实停在提示页给「返回看板」，**别自动弹走**。
 * 自动改道只在"确实有地方可去"时才是帮忙，否则就是把人关进旋转门。
 *
 * @param list 同项目会话（调用方已排好序：状态优先级 → 最近活动倒序）
 */
export function pickSuccessorSession(list: Session[], engine?: string): Session | null {
  const usable = (list ?? []).filter((s) => s.state !== 'error')
  if (usable.length === 0) return null
  return usable.find((s) => s.engine === engine) ?? usable[0] ?? null
}

/** 按服务器汇总 cost / tokens（看板服务器头显示用；cost 统一按 token×单价 估算，与消耗页同源） */
export function serverTotals(sessions: Session[]): Record<string, { cost: number; tokens: number }> {
  const out: Record<string, { cost: number; tokens: number }> = {}
  for (const s of sessions) {
    const g = out[s.serverId] ?? { cost: 0, tokens: 0 }
    g.cost += estCostOf(s)
    g.tokens += s.tokens
    out[s.serverId] = g
  }
  return out
}

/** 某项目今日累计活跃时长(ms)：latest + 折叠历史会话各 activeMsToday 之和 */
export function projectTodayActiveMs(latest: Session, history: Session[]): number {
  return (latest.activeMsToday ?? 0) + history.reduce((n, s) => n + (s.activeMsToday ?? 0), 0)
}

/** 某项目首选模型 id（无则 undefined） */
export function projectPreferredModel(
  projectModels: Record<string, string>, serverId: string, project: string,
): string | undefined {
  return projectModels[`${serverId}/${project}`]
}
