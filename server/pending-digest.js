// 总工待处理聚合（P0 可见性）：把 buildState() 已经跨全部节点聚合好的 {sessions, pendingActions}
// 整理成一份「总工一眼看清积压」的摘要——按 kind 分组、组内年龄倒序（最老最先看见）、超时(overdue)标记。
//
// 纯函数，不发网络请求、不读文件、不碰 buildState() 本身：hub.js 的 /api/pending 路由只是
// `buildPendingDigest(await buildState(), opts)` 一行胶水，/api/state 的契约完全不受影响。
//
// 待办条目形状（driver.js canUseTool / onTurnEnd、codex-driver.js 同款）固定含
// id/sessionId/kind/title/detail/createdAt；serverId 由 hub.js buildState() 在聚合时补上。
// cwd/project 待办本身不带，需要按 sessionId 去 sessions 列表里 join（sessions 里 agent.js 已经放了）。

const DEFAULT_THRESHOLD_MIN = 30
// 分组展示优先级：question/review 是「等人」的（最容易被忽略），approval 通常最贵（烧 token/卡进度），
// plan 殿后；未知 kind（协议演进出的新类型）不丢数据，排在已知四类后面、按字母序稳定输出。
const KIND_ORDER = ['question', 'review', 'approval', 'plan']

// 归属线索（P0 #6）：真实事故——总工批量清理待办积压时，把一条不是自己派的 review 盲批了，
// 列表里看不出这条是谁的派单。/api/session 目前不接收任何调用方身份字段（cwd/mode/prompt/model/
// engine/effort 而已），所以「发起来源」结构性拿不到——诚实置 requestedBy=null，不硬编成
// 'zonggong'/'bridge' 这类猜测值。回退到务实可得的信号：会话创建时间 + 首个 prompt 前 120 字
// （driver.js/codex-driver.js/agent.js 的 firstPrompt，创建后捕获一次、恒不变，不像 `summary`
// 会被后续回合反复覆写——等出现待办时 summary 早就不是"谁派的活"的信号了）。
function attributionOf(act, sess) {
  const requestedBy = act.requestedBy ?? null // 预留：若未来上游真传了身份，这里直接生效
  return {
    requestedBy,
    sessionStartedAt: sess?.startedAt ?? null,
    firstPromptPreview: sess?.firstPrompt || null,
    // 诚实标注：requestedBy 为空时，以上两个回退字段是启发式信号（"像不像我派的活"），
    // 不是经过身份校验的权威归属；别当成 ACL 用。
    heuristic: requestedBy == null,
  }
}

// owner 过滤没有真实身份字段可比对，只能对已暴露的归属文本信号做大小写不敏感的包含匹配
// （requestedBy 命中优先；否则搜首个 prompt 摘要 + 待办自身的 title/detail）。这就是"启发式
// 过滤"，别指望它等价于权限意义上的"只属于我"。
function matchesOwner(item, ownerLower) {
  if (String(item.attribution.requestedBy ?? '').toLowerCase().includes(ownerLower)) return true
  const hay = `${item.attribution.firstPromptPreview ?? ''} ${item.title ?? ''} ${item.detail ?? ''}`.toLowerCase()
  return hay.includes(ownerLower)
}

export function buildPendingDigest(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const thresholdMin = Number.isFinite(opts.thresholdMin) && opts.thresholdMin > 0
    ? opts.thresholdMin
    : DEFAULT_THRESHOLD_MIN
  const ownerLower = typeof opts.owner === 'string' && opts.owner.trim() ? opts.owner.trim().toLowerCase() : null
  const since = Number.isFinite(opts.since) && opts.since > 0 ? opts.since : null

  const sessions = state?.sessions ?? []
  const pendingActions = state?.pendingActions ?? []
  const sessById = new Map(sessions.map((s) => [s.id, s]))

  let items = pendingActions.map((act) => {
    const sess = sessById.get(act.sessionId)
    const ageMin = Math.max(0, Math.round((now - (act.createdAt ?? now)) / 60_000))
    return {
      id: act.id,
      kind: act.kind ?? 'unknown',
      sessionId: act.sessionId ?? null,
      serverId: act.serverId ?? sess?.serverId ?? null,
      project: sess?.project ?? null,
      cwd: sess?.cwd ?? null,
      title: act.title ?? '',
      detail: String(act.detail ?? '').slice(0, 300),
      createdAt: act.createdAt ?? null,
      ageMin,
      overdue: ageMin >= thresholdMin,
      attribution: attributionOf(act, sess),
    }
  })

  // 过滤先于排序/分组/聚合统计——?owner=/&since= 要的是"只看自己的"这份自洽摘要，
  // 不是过滤了 items 数组、total/byKind/oldestMin 却还在报全量。
  if (since) items = items.filter((i) => (i.createdAt ?? 0) >= since)
  if (ownerLower) items = items.filter((i) => matchesOwner(i, ownerLower))

  const byAgeDesc = (a, b) => b.ageMin - a.ageMin || String(a.id).localeCompare(String(b.id))
  items.sort(byAgeDesc)

  const kindsSeen = new Set(items.map((i) => i.kind))
  const orderedKinds = [
    ...KIND_ORDER.filter((k) => kindsSeen.has(k)),
    ...[...kindsSeen].filter((k) => !KIND_ORDER.includes(k)).sort(),
  ]
  const groups = {}
  for (const k of orderedKinds) groups[k] = items.filter((i) => i.kind === k) // 已整体按 byAgeDesc 排过，filter 保序
  const byKind = Object.fromEntries(orderedKinds.map((k) => [k, groups[k].length]))

  return {
    thresholdMin,
    owner: ownerLower, // 回显本次生效的过滤条件（null=未过滤），别让调用方猜"这份 total 是全量还是过滤后的"
    since,
    generatedAt: now,
    total: items.length,
    overdueCount: items.filter((i) => i.overdue).length,
    oldestMin: items.length ? items[0].ageMin : 0,
    byKind,
    groups,
    items,
  }
}
