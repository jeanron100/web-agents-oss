// server/hidden-projects.js — 项目隐藏（= 不纳管）的判据。纯函数，无 I/O。
//
// 用户原话：「项目列表支持编辑和隐藏，有几个项目已经不需要显示了」「隐藏是不加入项目纳管」。
// ⇒ 隐藏**不是**前端少画一张卡片，而是**根本不扫、不解析、不进任何聚合**。
//
// ★ 为什么权威在 hub、判定在 agent：
//   项目在 `/api/state` 里**不是一等公民** —— 没有 projects 数组，它只是 `sessions[].project`
//   的派生物。只在 hub 或前端过滤，挡不住 agent 继续扫那些 JSONL（热路径开销照旧），
//   也挡不住 `/api/review`、`/api/usage/projects-today` 这些旁路把它再漏出来。
//   所以判定必须落在 agent 的扫描循环里。
//   但配置**不能**存在 agent 上——那样改一次要发 5 台、还要重启（会腰斩在飞会话）。
//   ⇒ hub 持久化 + 每次轮询随 `/api/state?hidden=…` 下发。agent 完全无状态，重启不丢。
//
// ★ 键空间是 `serverId/project`，与既有的星标（store.ts `starKey`）同一套，别发明第二套。
//   同名项目可能同时存在于多台机器，只想清掉其中一台上的那份。
//
// ★★ 失败方向刻意选**放行**（fail-open）：配置读不到/传丢了 ⇒ 什么都不隐藏。
//   代价不对称——放行只是「隐藏的项目又冒出来了」（看得见、能再点一次）；
//   反过来一旦探测失败就隐藏，用户的项目会**凭空消失且没有任何提示**。
//   ⚠️ 这与 session-reaper 的方向相反（那边读不到 cgroup 要保守跳过）。
//   本仓库的纪律是**方向按代价定，不是抄一个模板**。

/** 线协议：`?hidden=a,b,c`。容忍空格与空项；拿不到就返回空数组（fail-open）。 */
export function parseHiddenParam(raw) {
  if (typeof raw !== 'string') return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** hub 存的是 `serverId/project`；下发给某台 agent 时只给它自己那份**裸项目名**。 */
export function hiddenForServer(entries, serverId) {
  if (!Array.isArray(entries) || !serverId) return []
  const out = []
  for (const e of entries) {
    if (typeof e !== 'string') continue
    const i = e.indexOf('/')                       // serverId 不含斜杠，项目名可能含 ⇒ 只切第一个
    if (i <= 0) continue
    if (e.slice(0, i) !== serverId) continue
    const proj = e.slice(i + 1).trim()
    if (proj) out.push(proj)
  }
  return out
}

/** 静态排除表（EXCLUDE_PROJECTS）与动态隐藏表的并集判定。 */
export function isHidden(name, staticSet, dynamic) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return false                             // 空项目名不算隐藏，否则误伤取不到名字的会话
  if (staticSet && typeof staticSet.has === 'function' && staticSet.has(n)) return true
  if (!dynamic) return false
  if (typeof dynamic.has === 'function') return dynamic.has(n)
  return Array.isArray(dynamic) && dynamic.includes(n)
}

/** 落盘前规整：去空白、去重、丢掉缺 serverId 或缺项目名的脏项，顺序稳定。 */
export function normalizeEntries(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const e = raw.trim()
    const i = e.indexOf('/')
    if (i <= 0 || i === e.length - 1) continue     // 'no-slash' / '/only-proj' / 'srv-x/' 全丢掉
    if (seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}
