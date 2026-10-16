// node --test server/project-history.test.mjs
//
// 「会话历史」Tab 的候选挑选。2026-08-03 用户实拍：web_agents 项目磁盘上有 25 个会话 JSONL，
// 「会话历史」只列出 2 条。三点对账（JSONL 25 / /api/state 2 / 前端 2）定位断点在 ①→②：
//
//   该 Tab 的数据源 sessionsOfProject() 直接取自 /api/state 的**实时列表**，而那个列表被
//   MAX_PER_PROJECT=3（Claude）与 slice(0,2)（Codex/Kimi）**故意**截断——它是 3s 轮询的热
//   路径，截断是对的。错在「会话历史」从一开始就接错了源：名字叫历史，喂的却是"当前纳管集"。
//
// 修法是另开一条按需的冷路径（/api/project/sessions），本模块是它的纯函数部分：
// 从全量候选里挑出对外的 N 条。热路径 buildState 一个字节不动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectHistory } from './project-history.js'

// 造候选：id + 引擎 + 最后活跃（分钟前）。入参顺序刻意打乱，排序是被测行为之一。
const mk = (id, engine, minAgo, extra = {}) => ({
  id, engine, lastActiveAt: Date.now() - minAgo * 60_000, origin: 'shadow', msgCount: 5, ...extra,
})
const idsOf = (rows) => rows.map((s) => s.id)

test('按最后活跃倒序，并封顶 limit', () => {
  const rows = selectHistory([mk('c', 'claude', 30), mk('a', 'claude', 1), mk('b', 'claude', 10)], 2)
  assert.deepEqual(idsOf(rows), ['a', 'b'])
})

test('候选少于 limit 时全给，不补空', () => {
  const rows = selectHistory([mk('a', 'claude', 1)], 10)
  assert.equal(rows.length, 1)
})

test('空输入不炸', () => {
  assert.deepEqual(selectHistory([], 10), [])
  assert.deepEqual(selectHistory(null, 10), [])
})

// ★ 空 stub：`claude --resume` 即退会留下 msgCount==0 的残留文件，且它往往**比真会话更新**。
// buildState 里踩过这个坑（myskills 因 4 个空 stub 比真会话新，整个项目对话流消失）。
// 冷路径同样要滤，否则历史前几行全是点开一片空白的幽灵会话。
test('★ 空 stub（msgCount==0）不占名额——它常比真会话更新', () => {
  const rows = selectHistory([
    mk('stub1', 'claude', 0, { msgCount: 0 }),
    mk('stub2', 'claude', 1, { msgCount: 0 }),
    mk('real', 'claude', 60),
  ], 10)
  assert.deepEqual(idsOf(rows), ['real'])
})

// ★ Codex 接管后 st.sessions 里会同时存在【平台记录】与【影子记录】且**同 id**（见 CLAUDE.md
// 「Codex 接管同 id 孪生」）。历史列表若不去重，同一会话出现两行、且都可能标「当前」。
test('★ 同 id 去重，平台记录优先于影子记录', () => {
  const rows = selectHistory([
    mk('dup', 'codex', 5, { origin: 'shadow', summary: '影子' }),
    mk('dup', 'codex', 5, { origin: 'platform', summary: '平台' }),
  ], 10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].origin, 'platform')
  assert.equal(rows[0].summary, '平台')
})

// ★ 这条守的是 CLAUDE.md 的「三对话流 Tab 布局须一致」不变量在**历史维度**的版本。
// allocateSessions 已经为看板踩过一次（insight_v2 的 2 个 Kimi 会话把 Claude 挤出名额 ⇒
// 「Claude 对话流」Tab 整个消失）。历史列表是纯时间序，同样会让"会话少但存在"的引擎沉底：
// 24 个 Claude + 1 个 3 天前的 Codex，top-10 全是 Claude ⇒ 提示语写着「Claude + Codex + Kimi
// 合集」却一条 Codex 都没有。故每个引擎保底 1 条。
test('★ 每个引擎保底 1 条——别让会话多的引擎把别家整个挤出历史', () => {
  const many = Array.from({ length: 12 }, (_, i) => mk(`cl${i}`, 'claude', i + 1))
  const rows = selectHistory([...many, mk('cx', 'codex', 3 * 24 * 60), mk('km', 'kimi', 5 * 24 * 60)], 10)

  assert.equal(rows.length, 10)
  assert.ok(idsOf(rows).includes('cx'), 'Codex 会话应保底入选')
  assert.ok(idsOf(rows).includes('km'), 'Kimi 会话应保底入选')
  // 保底之外的名额仍按活跃度给最近的 Claude
  assert.ok(idsOf(rows).includes('cl0'), '最近的 Claude 会话必须在')
  // 结果整体仍是时间倒序（前端直接按序渲染，不再排）
  const ts = rows.map((s) => s.lastActiveAt)
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a), '输出必须是时间倒序')
})

// ★ 回归（2026-08-03 实测踩到，且我自己的验证环境掩盖了它）：
// Claude 平台会话的 API id 是 `ps-*`，原生 uuid 在 realSessionId——**两者 id 不同**，
// 所以按 id 去重抓不住这对孪生。当时的现象：正在跑的这个对话在「会话历史」里出现两行
// （ps-* 来自实时列表 + uuid 来自冷路径），点 uuid 那行 events 返回 0 ⇒ 空白页。
//
// 为什么单测比"跑一遍"更重要：我当初是在**探针 agent**（独立 HOME、零平台会话）上验的，
// 那里 uuid 被当普通影子会话、直连 JSONL 有 107 条事件，10/10 全绿——验证环境缺了
// "平台会话"这个维度，把 bug 完整地藏了起来。
test('★ 抑制已被平台会话接管的影子（ps-* 与 uuid 是同一对话但 id 不同）', () => {
  const rows = selectHistory([
    mk('a05e0557-uuid', 'claude', 0),   // 平台会话 ps-xxx 的 realSessionId
    mk('9f91a447-uuid', 'claude', 60),  // 普通影子，应保留
  ], 10, new Set(['a05e0557-uuid']))

  assert.deepEqual(idsOf(rows), ['9f91a447-uuid'])
})

test('suppress 缺省/非 Set 时行为不变（向后兼容）', () => {
  const cands = [mk('a', 'claude', 1), mk('b', 'claude', 2)]
  assert.equal(selectHistory(cands, 10).length, 2)
  assert.equal(selectHistory(cands, 10, null).length, 2)
  assert.equal(selectHistory(cands, 10, ['a']).length, 2) // 数组不是 Set，按缺省处理
})

test('被抑制的会话不占名额（不能让它挤掉真会话）', () => {
  const rows = selectHistory([
    mk('dead', 'claude', 0), mk('x', 'claude', 10), mk('y', 'claude', 20),
  ], 2, new Set(['dead']))
  assert.deepEqual(idsOf(rows), ['x', 'y'])
})

test('保底不会撑破 limit', () => {
  const rows = selectHistory(
    [mk('a', 'claude', 1), mk('b', 'codex', 2), mk('c', 'kimi', 3)], 2,
  )
  assert.equal(rows.length, 2)
})
