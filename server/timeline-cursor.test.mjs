// node --test server/timeline-cursor.test.mjs
//
// 「执行历史」翻页游标。2026-08-03：ExecTrace 只能看到会话最后 800 条事件，更早的看不到，
// 且**界面不告诉你被砍了**（实测 ps-ms1k8aom-3092 有 1811 条、显示「92 个回合」像是全集）。
//
// 本模块是"往前翻"的游标。★核心风险不是翻页本身，而是**同一毫秒的事件被整批跳过**：
// JSONL 扫描成批产出的事件共享同一个 ts，若游标只用 occurredAt 做 $lt，边界那一毫秒里
// 剩下的事件就永远翻不到——漏得没规律、极难复现。故游标必须是 (occurredAt, eventKey) 复合的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeCursor, decodeCursor, cursorFilter } from './timeline-cursor.js'

const ev = (occurredAt, eventKey) => ({ occurredAt, eventKey })

test('编解码往返', () => {
  const c = encodeCursor(ev('2026-08-03T01:09:12.345Z', 'srv-a|claude|1234'))
  assert.equal(typeof c, 'string')
  assert.deepEqual(decodeCursor(c), { occurredAt: '2026-08-03T01:09:12.345Z', eventKey: 'srv-a|claude|1234' })
})

test('脏游标一律退化成 null（调用方退回首页，绝不抛）', () => {
  for (const bad of [null, undefined, '', '   ', 'no-separator', '_', '2026-08-03T01:09:12.345Z_']) {
    assert.equal(decodeCursor(bad), null, `应退化: ${JSON.stringify(bad)}`)
  }
})

test('eventKey 里含分隔符也能正确还原（只按第一个 _ 切）', () => {
  // eventKey 由 serverId/engine/seq 拼成，本身可能带下划线
  const key = 'srv_178_232|claude|99_100'
  const back = decodeCursor(encodeCursor(ev('2026-08-03T01:09:12.345Z', key)))
  assert.equal(back.eventKey, key)
})

test('无游标 = 首页：filter 只按 sessionId', () => {
  assert.deepEqual(cursorFilter('s-1', null), { sessionId: 's-1' })
})

// ★ 这条是本模块存在的理由。
test('★ 同毫秒不漏：filter 必须同时覆盖「更早的毫秒」与「同毫秒里更靠前的事件」', () => {
  const f = cursorFilter('s-1', { occurredAt: '2026-08-03T01:09:12.345Z', eventKey: 'k-050' })
  assert.equal(f.sessionId, 's-1')
  assert.ok(Array.isArray(f.$or) && f.$or.length === 2, '必须是复合条件，不能只有时间戳')

  const [older, sameMs] = f.$or
  assert.deepEqual(older, { occurredAt: { $lt: '2026-08-03T01:09:12.345Z' } })
  assert.deepEqual(sameMs, { occurredAt: '2026-08-03T01:09:12.345Z', eventKey: { $lt: 'k-050' } })
})

// 用一份"同毫秒挤了很多条"的数据集，在内存里跑一遍 filter 语义，证明翻到底一条不漏、不重。
// （真 Mongo 的 $or/$lt 语义与此一致；这里验的是我们构造的条件对不对。）
test('★ 端到端翻页：同毫秒 20 条事件，分页翻完一条不漏、不重复', () => {
  const rows = []
  for (let i = 0; i < 20; i++) rows.push(ev('2026-08-03T01:09:12.345Z', `k-${String(i).padStart(3, '0')}`))
  rows.push(ev('2026-08-03T01:09:11.000Z', 'k-early'))   // 更早的毫秒
  rows.push(ev('2026-08-03T01:09:13.000Z', 'k-late'))    // 更晚的毫秒

  // 模拟 Mongo：按 filter 选出、按 (occurredAt, eventKey) 倒序、取 limit 条
  const applies = (r, f) => {
    if (!f.$or) return true
    const [a, b] = f.$or
    if (r.occurredAt < a.occurredAt.$lt) return true
    return r.occurredAt === b.occurredAt && r.eventKey < b.eventKey.$lt
  }
  const desc = (x, y) => (x.occurredAt === y.occurredAt
    ? (x.eventKey < y.eventKey ? 1 : -1)
    : (x.occurredAt < y.occurredAt ? 1 : -1))

  const PAGE = 7
  const seen = []
  let cursor = null
  for (let guard = 0; guard < 20; guard++) {
    const f = cursorFilter('s-1', cursor)
    const page = rows.filter((r) => applies(r, f)).sort(desc).slice(0, PAGE)
    if (!page.length) break
    seen.push(...page)
    cursor = decodeCursor(encodeCursor(page[page.length - 1])) // 最老一条作下一页游标
  }

  assert.equal(seen.length, rows.length, '必须翻完全部事件——漏一条就是这个 bug')
  assert.equal(new Set(seen.map((s) => s.eventKey)).size, rows.length, '不能出现重复')
})
