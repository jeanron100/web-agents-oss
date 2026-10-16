// 领域类型 —— 与需求设计文档 §7.2 / §9 对齐

export type SessionState =
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'idle'
  | 'done'
  | 'error'

export type Engine = 'claude' | 'codex' | 'kimi'
export type MessageBehavior = 'steer' | 'queue'
export type MessageDelivery = 'sending' | 'accepted' | 'steered' | 'queued' | 'unknown' | 'failed' | 'cancelled'

// Claude 权限模式 + Codex 审批模式（untrusted/on-request/never）合并；mode 取值随引擎不同，
// 各自可选集见 SessionDetail 的 modes / CODEX_MODES_ORDER。
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'untrusted' | 'on-request' | 'never'

export interface Server {
  id: string
  name: string
  region: string
  flag: string
  online: boolean
  /** true=本轮拉取失败，当前展示的是上一轮成功缓存（D2 故障回填），非实时 */
  stale?: boolean
  /**
   * 会话派生闸门的实时占用。老版本 agent 不上报 → undefined ⇒ 按"未知"处理，别渲染成告警。
   * 闸门满时新建/恢复会话会排队（见 lib/gate.ts）——这是「超时」背后最常见的真因。
   */
  sessionGate?: { active: number; max: number; queued: number; queueWaitMs: number } | null
}

export interface Session {
  id: string
  serverId: string
  project: string
  branch: string
  engine: Engine
  model: string
  mode: PermissionMode
  state: SessionState
  /** platform=平台拉起（可交互） shadow=影子追踪（只读，可恢复接管） */
  origin?: 'platform' | 'shadow'
  /** 原生 Claude 会话 id（用于 claude --resume） */
  realSessionId?: string | null
  /** 由哪个影子会话接管而来 */
  resumedFrom?: string | null
  /** 平台会话经 agent 重启已「分离」：id 仍是原 psId（深链有效），但无 live handle，只读、可恢复接管 */
  detached?: boolean
  /** agent 重启前持久化状态仍活跃，且重启后无同 realId 原生进程：最后一回合可能被中断 */
  interrupted?: boolean
  /** 分离前有挂起待办（审批/计划），随进程蒸发——只读提示"已失效，请重新触发"，不进收件箱 */
  lostPending?: boolean
  /** 分离原因文案（详情页展示） */
  detachedReason?: string
  /** 当前动作一行摘要 */
  summary: string
  /** 0-100，仅 running 且有可估进度时存在 */
  progress?: number
  startedAt: number
  lastActiveAt: number
  cost: number
  /** token 真实总量（含 cache，= breakdown 四项之和） */
  tokens: number
  /** token 四项明细（input/output/缓存读/缓存写）；旧 agent 未升级时可能缺失 */
  tokensBreakdown?: { input: number; output: number; cacheRead: number; cacheCreate: number }
  /** 累计活跃时长(ms)：相邻回合间隔 <5min 才计；用于"大模型替你干了多久"（#6） */
  activeMs?: number
  /** 今日累计活跃毫秒（跨天清零；影子会话有，平台会话缺省 0） */
  activeMsToday?: number
  /** 今日成本（USD；Codex=0） */
  costToday?: number
  /** 今日 token */
  tokensToday?: number
  /** effort 思考强度档位（平台会话）：low/medium/high/xhigh/max，默认 xhigh（#2） */
  effort?: string
  /** error 态会话的完整错误原因（平台会话出错时） */
  error?: string
  /** 会话工作目录绝对路径（新建 Codex 对话等场景需要，agent.js 已回传但此前未入 FE 类型） */
  cwd?: string
  /** 平台驱动已加载 Codex 即时补充能力；旧 agent 不声明。 */
  supportsSteering?: boolean
}

export type ActionKind = 'approval' | 'question' | 'plan' | 'review'

export interface PendingAction {
  id: string
  sessionId: string
  kind: ActionKind
  title: string
  /** approval: 待执行命令；question: 问题原文；plan: 计划摘要；review: 结果摘要 */
  detail: string
  /** approval 专用：风险提示 */
  risk?: string
  /** approval 专用：操作上下文说明 */
  context?: string
  /** question 专用：快捷回复 */
  quickReplies?: string[]
  createdAt: number
  status: 'pending' | 'resolved' | 'expired'
  resolution?: string
}

// seq：事件的持久化序号（有则代表 JSONL 已落盘的 durable 事件；缺省=瞬时流式片段，
// 每次 append 帧都会整份重发）。Claude 侧是字符串，Codex 侧是数字，前端只做存在性判断，不比较大小。
/** 对话流里一张截图的引用。字节按需从 url 拉（immutable，浏览器只拉一次）——不再内联 base64。 */
export type EventImage = { name: string; media_type: string; bytes?: number; url: string }

export type ChatEvent =
  // images：后端 toWire 剥掉 base64 后的懒加载引用（见 server/event-wire.js）。老 agent 不带此字段 →
  // 回退到会话级 /images 灯箱（imageCount 徽标那条路），故为可选。
  | { id: string; sessionId: string; ts: number; type: 'user'; text: string; delivery?: MessageDelivery; messageBehavior?: MessageBehavior; deliveryReason?: string; imageCount?: number; images?: EventImage[]; seq?: string | number }
  | { id: string; sessionId: string; ts: number; type: 'assistant'; text: string; streaming?: boolean; seq?: string | number }
  | {
      id: string; sessionId: string; ts: number; type: 'file_op'
      verb: string
      path: string
      additions?: number
      deletions?: number
      seq?: string | number
    }
  | { id: string; sessionId: string; ts: number; type: 'turn_end'; durationSec: number; tokens: number; cost: number; seq?: string | number }

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  no: number | null
  text: string
}

export interface FileChange {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
}

export interface TodoItem {
  text: string
  status: 'done' | 'active' | 'pending'
}

export interface SessionExtras {
  fileChanges: FileChange[]
  todos: TodoItem[]
  messageReceipts?: Record<string, { delivery: MessageDelivery; reason?: string }>
}

/** 数据源抽象：本期 MockHubClient，后续替换为 WsHubClient 对接真实 Hub */
export interface HubClient {
  start(): void
  stop(): void
}
