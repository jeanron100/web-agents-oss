// 「会话历史」Tab 的候选挑选（冷路径 /api/project/sessions 的纯函数部分）。
//
// 为什么单独有这条路（2026-08-03 用户实拍）：web_agents 磁盘上 25 个会话 JSONL，「会话历史」
// 只列 2 条。断点不在前端——三点对账 JSONL 25 / /api/state 2 / 前端 2，②就已经只有 2 条了。
//
// 根因：该 Tab 的数据源 sessionsOfProject() 取自 /api/state 的**实时列表**，而那个列表被
// MAX_PER_PROJECT=3（Claude）和 slice(0,2)（Codex/Kimi）截断。**那个截断是对的**，别去动它：
// /api/state 是前端 3s 轮询 + hub 5s 轮 agent 的热路径；实测把每项目放到 10 条，232 单机候选
// 从 58 涨到 91（还得同步放开 MAX_TOTAL=40 才真生效），5 台机 state 会从 69 条涨到两三百条，
// 而 232 只有 3.6G 内存、每个纳管会话还挂着 400 条事件的解析缓存。为一个很少打开的 Tab 让所有
// 人每 3 秒付这份钱，正是「别传没人要的东西」那条教训。
//
// 所以：看板走热路径（截断、常驻），历史走冷路径（全量、按需、没人点就零成本）。
//
// ⚠️ 调用方（agent.js）必须为返回的每条会话登记 idToFile/idToEngine/idToCwd——events 端点靠
// 这三张表定位文件。漏了就会做出「列了 10 条、点开 8 条空白」的假修复：前端拿不到会话会落到
// SessionNotFound，1.2 秒后自动跳走，用户看到的是"点了没反应"。

/**
 * 从某项目的全量候选里挑出对外的 N 条。
 * @param candidates 该项目的全部会话候选（Claude+Codex+Kimi，顺序不限）
 * @param limit      名额上限
 * @param suppress   需要抑制的原生 id 集合（已被平台会话/分离态条目代表，见下）
 * @returns 时间倒序、已去重、已滤空 stub 的会话数组
 */
export function selectHistory(candidates, limit, suppress) {
  const all = candidates ?? []
  if (!all.length || limit <= 0) return []

  // ① 空 stub 不占名额。`claude --resume` 即退会留下 msgCount==0 的残留，且它往往比真会话**更新**
  //    ——先截断再滤会把真会话挤出去（buildState 里 myskills 就因此整个项目对话流消失）。
  //
  // ★ 同时抑制「已被平台会话接管的影子」。Claude 平台会话的 API id 是 `ps-*`，原生 uuid 放在
  //   realSessionId——**两者 id 不同**，所以下面按 id 的去重抓不住它们，必须靠外部传入的 suppress。
  //   不抑制的后果（2026-08-03 实测）：当前正在跑的这个对话在「会话历史」里出现**两行**
  //   （ps-* 来自实时列表 + uuid 来自本冷路径），且点 uuid 那行 events 返回 0 ⇒ **空白页**——
  //   正是本次改动声称要消灭的失败模式。buildState 用 platformIds/detachedReals 拦这个，
  //   冷路径必须同源。
  const drop = suppress instanceof Set ? suppress : new Set()
  const real = all.filter((s) => (s.msgCount ?? 1) > 0 && !drop.has(s.id))

  // ② 同 id 去重，平台记录优先。Codex 影子会话被接管后，平台记录与影子记录**同 id** 并存
  //    （见 CLAUDE.md「Codex 接管同 id 孪生」）；不去重则同一会话在历史里出现两行。
  const byId = new Map()
  for (const s of real) {
    const cur = byId.get(s.id)
    if (!cur || (s.origin === 'platform' && cur.origin !== 'platform')) byId.set(s.id, s)
  }

  const sorted = [...byId.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  if (sorted.length <= limit) return sorted

  // ③ 每个引擎保底 1 条，再按活跃度填满剩余名额。
  //    守的是「三对话流 Tab 布局须一致」在历史维度的版本：纯时间序会让"会话少但存在"的引擎沉底
  //    （24 个 Claude + 1 个 3 天前的 Codex ⇒ top-10 全是 Claude），而提示语明写着「Claude +
  //    Codex + Kimi 合集」。看板侧 allocateSessions 已为同一类问题踩过一次（insight_v2 的 Kimi
  //    把 Claude 挤出名额，整个 Tab 消失），这里用同样的保底思路。
  const picked = new Set()
  const seenEngine = new Set()
  for (const s of sorted) {
    if (picked.size >= limit) break
    if (seenEngine.has(s.engine)) continue
    seenEngine.add(s.engine)
    picked.add(s)
  }
  for (const s of sorted) {
    if (picked.size >= limit) break
    picked.add(s)
  }

  // 保底可能打乱时间序（冷引擎被提前选中），最终输出必须重新排成倒序：
  // 前端直接按序渲染，不再自己排。
  return sorted.filter((s) => picked.has(s))
}
