// 看板名额分配：把有限的会话条数**公平**分给各项目，而不是按活跃度一刀切。
//
// 为什么需要它（2026-07-21 用户实拍）：buildState 末尾原本是
//     sessions.sort((a,b) => b.lastActiveAt - a.lastActiveAt).slice(0, MAX_TOTAL)
// 这是**全局**截断。232 上 22 个项目 × 每项目最多 3 条 → 候选远超 40，排完一刀切下去的结果是：
//     显示的 14 个项目最新活跃全 < 2.5 天；被截掉的 8 个全 ≥ 3 天。
// 用户的 invest_data 正好 3.0 天，于是**整个项目从看板消失**——而它明明有 5 个会话、3 天前还在用。
//
// 两个语义错误，这个模块各修一个：
//  ① 「我的项目在不在看板上」不该取决于**别的项目有多活跃**。自己什么都没变，别人一忙就消失，
//     这对用户是不可理解的。→ 轮转分配：每个项目先保底 1 条，剩余名额再按活跃度给。
//  ② 截断不能是**静默**的。前端不知道有 8 个项目被吃掉，就会把残缺当全集。
//     → 返回 truncated / hiddenSessions / hiddenProjects，让调用方能说出来。

/**
 * 「引擎大类占位」的时效门槛（2026-09-11 用户实拍后加）。
 *
 * ★ 为什么占位要有时效：阶段 2 原本**无条件**给每个「项目×引擎」保底 1 条，
 *   于是 invest_data 的 3 个名额被 **37.9 天前的 Kimi** 和 **39.8 天前的 Codex** 占掉 2 个，
 *   用户当天新建、**正在跑**的另外两条 Claude 会话（26 分钟前 / 92 分钟前）只能排队，
 *   而它们的影子又因为有平台别名被冷路径抑制 ⇒ **两条路都看不到，会话彻底消失**。
 *   阶段 2 是 2026-08-01 为「三条对话流 Tab 对称」加的，那次的场景是「2 个 Kimi 更近、
 *   挤掉 Claude」——两者时间接近，对称性该赢；但 40 天前的僵尸 vs 26 分钟前正在跑的会话，
 *   **对称性就不该赢了**。⇒ 大类仍然占位，但**占位权只给近期活跃的引擎**。
 */
const DEFAULT_ENGINE_FRESH_MS = 7 * 86_400_000

/**
 * @param sessions 已按 lastActiveAt 降序排好的会话数组
 * @param maxTotal 名额上限
 * @param opts.now 当前时刻（可注入，便于测试）
 * @param opts.engineFreshMs 引擎占位的时效门槛，默认 7 天
 * @returns {{sessions:Array, truncated:boolean, hiddenSessions:number, hiddenProjects:number}}
 */
export function allocateSessions(sessions, maxTotal, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const engineFreshMs = Number.isFinite(opts.engineFreshMs) ? opts.engineFreshMs : DEFAULT_ENGINE_FRESH_MS
  // ⚠️ 缺 lastActiveAt 时刻意退化成 0（=1970=极旧=不占位）。这里的 `|| 0` 是**有意的**，
  //    不是本仓库反复记过的那个「Number(null)===0 把读不到当成 0」的疏忽 ——
  //    对「占位权」而言，取不到活跃时间就不该享受特权，方向是安全的那一侧。
  const engineFresh = (s) => now - (Number(s?.lastActiveAt) || 0) <= engineFreshMs
  const all = sessions ?? []
  if (all.length <= maxTotal) {
    return { sessions: all, truncated: false, hiddenSessions: 0, hiddenProjects: 0 }
  }

  // 按「服务器/项目」分组。入参已按活跃降序，故各组内部天然是最近优先，
  // 且组的首次出现顺序 = 该项目最近活跃时间的顺序（越活跃的项目越靠前）。
  const groups = new Map()
  for (const s of all) {
    const key = `${s.serverId}/${s.project}`
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }

  // 组内重排：把**每个引擎最新的那条**提到前面（按活跃度顺序），其余按原序跟在后面。
  //
  // 为什么不是把轮转键改成「服务器/项目/引擎」：那会让组数变多、第 1 轮就吃掉更多名额，
  // 反过来可能饿死靠后的项目——而「每个项目至少露 1 条」优先级更高。组内重排是最小改动：
  // 分组与轮转逻辑一字不动，只让同一项目里不同引擎的会话错开轮次。
  //
  // 2026-08-01 用户实拍：insight_v2 打开后「Claude 对话流」Tab 不见了。该项目 2 个 Kimi 会话
  // 更近，占掉了它轮得到的 2 轮，Claude 会话排在后面而预算已用完 ⇒ 整个引擎在前端消失
  //（Tab 是按"项目有无该引擎会话"渲染的）。「三条对话流 Tab 对称」是不变量，名额竞争不能打破它。
  const engineFirst = (list) => {
    const seen = new Set(), head = [], tail = []
    for (const s of list) {
      if (seen.has(s.engine)) { tail.push(s); continue }
      seen.add(s.engine)
      // ★ 只有**近期活跃**的引擎才把最新一条提到前面。僵尸引擎留在 tail 里按活跃度排队，
      //   不再靠"我是另一个引擎"插队到活跃会话前面。
      if (engineFresh(s)) head.push(s)
      else tail.push(s)
    }
    return head.concat(tail)
  }

  // 轮转：第 1 轮每个项目各取 1 条（保底），第 2 轮各取第 2 条……直到名额用完。
  // 这样「每个项目至少露一次」优先于「某个热项目多露几条」。
  const out = []
  const taken = new Set()
  const lists = [...groups.values()].map(engineFirst)
  const push = (s) => { if (!taken.has(s)) { taken.add(s); out.push(s) } }

  // 阶段 1：每个项目保底 1 条（最近的那条）——这是最高优先级的不变量，不能被下面两阶段挤掉。
  for (const list of lists) {
    if (out.length >= maxTotal) break
    if (list.length) push(list[0])
  }
  // 阶段 2：每个「项目 × 引擎」再保底 1 条。engineFirst 已把各引擎最新的一条排到组前部，
  // 所以这里顺着扫到"该引擎还没露过"就补一条。防的是"整条对话流 Tab 因抢名额消失"。
  // ⚠️ 但只给**近期活跃**的引擎补 —— 否则几十天前的僵尸会把名额从今天正在跑的会话手里拿走。
  for (const list of lists) {
    if (out.length >= maxTotal) break
    const shown = new Set(list.filter((s) => taken.has(s)).map((s) => s.engine))
    for (const s of list) {
      if (out.length >= maxTotal) break
      if (shown.has(s.engine)) continue
      if (!engineFresh(s)) continue   // ★ 僵尸引擎不占位（见 DEFAULT_ENGINE_FRESH_MS 上方）
      shown.add(s.engine); push(s)
    }
  }
  // 阶段 3：剩余名额按深度轮转（原逻辑），让活跃项目多露几条。
  const deepest = Math.max(...lists.map((l) => l.length))
  for (let round = 0; round < deepest && out.length < maxTotal; round++) {
    for (const list of lists) {
      if (out.length >= maxTotal) break
      if (round < list.length) push(list[round])
    }
  }

  // 项目数本身就超预算时，靠后的项目一条都露不出来——这个必须单独报，
  // 因为「少了几条会话」和「整个项目看不见」对用户是两回事。
  const shownProjects = new Set(out.map((s) => `${s.serverId}/${s.project}`)).size
  return {
    sessions: out,
    truncated: true,
    hiddenSessions: all.length - out.length,
    hiddenProjects: groups.size - shownProjects,
  }
}
