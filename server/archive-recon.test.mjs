// 归档对账的回归测试（openspec change: execution-history-archive，P0 验收线）。
//
// ★ 为什么这一层是 P0 的验收线而不是"锦上添花"：一个「看着在跑其实没在采」的采集器，
//   外观与正常的**完全相同**。本仓库多次证明只有"拿两条路径对账"才能发现静默缺陷——
//   `/api/state` 曾返回 72 条会话却只有 71 个唯一 id，任何测试都没发现，
//   是影子对照报出 `kind:"length" a:31 b:32` 才挖出来的。
//
// ★★ 并且必须**报差集**，不能只报总数。总数相等不代表内容相同（可能一边多一条、
//   另一边也多一条），而且"少了 3 条"这种结论无法行动——你得知道少的是**哪三条**。

import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile } from './archive-recon.js'

const src = (host, session, extra = {}) =>
  ({ host, project: '-data-x', session, engine: 'claude', lines: 10, ...extra })

test('全部覆盖时 coverage=1 且差集为空', () => {
  const r = reconcile([src('h1', 's1'), src('h1', 's2')], [src('h1', 's1'), src('h1', 's2')])
  assert.equal(r.coverage, 1)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.extra, [])
})

test('★★ 缺失必须报出**是哪几条**，不只报数量', () => {
  const r = reconcile([src('h1', 's1'), src('h1', 's2'), src('h1', 's3')], [src('h1', 's1')])
  assert.equal(r.missing.length, 2)
  assert.deepEqual(r.missing.map((x) => x.session).sort(), ['s2', 's3'])
  assert.equal(r.sourceTotal, 3)
  assert.equal(r.archivedTotal, 1)
})

test('★ 总数相等也可能两边都有缺 —— 只比总数会漏判', () => {
  // 这正是"只报总数不报差集"会瞎掉的场景
  const r = reconcile([src('h1', 'a'), src('h1', 'b')], [src('h1', 'a'), src('h1', 'zz')])
  assert.equal(r.sourceTotal, r.archivedTotal)
  assert.deepEqual(r.missing.map((x) => x.session), ['b'])
  assert.deepEqual(r.extra.map((x) => x.session), ['zz'])
  assert.ok(r.coverage < 1, '两边都有缺时 coverage 不得是 1')
})

test('★ 同名 session 但不同机器是两条 —— 不同机器可能有同名路径', () => {
  const r = reconcile([src('h1', 's1'), src('h2', 's1')], [src('h1', 's1')])
  assert.deepEqual(r.missing.map((x) => `${x.host}/${x.session}`), ['h2/s1'])
})

test('★ 行数不足也算缺口（采了但没采全）', () => {
  // 会话在中心存在，但只落了一半行——这种"半采"最危险：清单里有它，看着像完整
  const r = reconcile([src('h1', 's1', { lines: 100 })], [src('h1', 's1', { lines: 40 })])
  assert.equal(r.missing.length, 0)                    // 会话本身不缺
  assert.equal(r.partial.length, 1)                    // 但行数对不上
  assert.deepEqual(r.partial[0], { host: 'h1', project: '-data-x', session: 's1', source: 100, archived: 40 })
})

test('归档行数多于源不算缺口（源仍在增长，采集领先一拍是正常的）', () => {
  const r = reconcile([src('h1', 's1', { lines: 40 })], [src('h1', 's1', { lines: 40 })])
  assert.deepEqual(r.partial, [])
})

test('按引擎分组计数 —— 任一引擎为 0 即说明整条路没通', () => {
  const r = reconcile(
    [src('h1', 'a', { engine: 'claude' }), src('h1', 'b', { engine: 'codex' }), src('h1', 'c', { engine: 'kimi' })],
    [src('h1', 'a', { engine: 'claude' }), src('h1', 'b', { engine: 'codex' })],
  )
  assert.deepEqual(r.byEngine, { claude: { source: 1, archived: 1 }, codex: { source: 1, archived: 1 }, kimi: { source: 1, archived: 0 } })
})

test('★ 差集要封顶，避免首次对账把几千条塞进一个响应', () => {
  const many = Array.from({ length: 500 }, (_, i) => src('h1', `s${i}`))
  const r = reconcile(many, [], { limit: 50 })
  assert.equal(r.missing.length, 50)
  assert.equal(r.missingTotal, 500)                    // 但真实数量必须如实报出
  assert.equal(r.truncated, true)
})

test('空输入不抛，coverage 为 null 而不是 1', () => {
  // ⚠️ 源为空时返回 1 会被看门狗判成"完美覆盖"——空闲期把告警焊死在绿灯上。
  const r = reconcile([], [])
  assert.equal(r.coverage, null)
  assert.equal(r.sourceTotal, 0)
})
