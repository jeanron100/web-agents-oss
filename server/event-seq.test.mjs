// node --test server/event-seq.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeSeq, parseSeq, claudeCmp, numCmp, buildFrame, seqBounds, needsHistorySnapshot } from './event-seq.js'

test('无序号历史必须快照；只有真正的流式尾巴才能随增量追加', () => {
  assert.equal(needsHistorySnapshot([{ id: 'kw-1' }, { seq: 1 }]), true)
  assert.equal(needsHistorySnapshot([{ seq: -1 }, { seq: 1 }, { streaming: true }]), false)
  assert.equal(needsHistorySnapshot([{ seq: 1 }, { streaming: true }]), false)
})

test('claudeSeq + parseSeq 往返一致', () => {
  const s = claudeSeq('real-uuid-123', 'g1', 4096, 2)
  assert.equal(s, 'real-uuid-123:g1:4096:2')
  const p = parseSeq(s)
  assert.deepEqual(p, { realId: 'real-uuid-123', generation: 'g1', byteOffset: 4096, subIndex: 2 })
})

test('parseSeq 对畸形字符串返回 null（段数不对）', () => {
  assert.equal(parseSeq('a:b'), null)
})

test('parseSeq 对畸形字符串返回 null（byteOffset/subIndex 非数字）', () => {
  assert.equal(parseSeq('a:b:c:x'), null)
  assert.equal(parseSeq('a:b:5:x'), null)
  assert.equal(parseSeq('a:b:x:5'), null)
})

test('parseSeq 对非有限整数返回 null', () => {
  assert.equal(parseSeq('a:b:5.5:0'), null)
  assert.equal(parseSeq('a:b:Infinity:0'), null)
})

test('claudeCmp: 同 realId+generation 按 byteOffset 排序', () => {
  const a = claudeSeq('r1', 'g1', 100, 0)
  const b = claudeSeq('r1', 'g1', 200, 0)
  assert.ok(claudeCmp(a, b) < 0)
  assert.ok(claudeCmp(b, a) > 0)
})

test('claudeCmp: 同 byteOffset 按 subIndex 排序', () => {
  const a = claudeSeq('r1', 'g1', 100, 0)
  const b = claudeSeq('r1', 'g1', 100, 1)
  assert.ok(claudeCmp(a, b) < 0)
  assert.ok(claudeCmp(b, a) > 0)
})

test('claudeCmp: 完全相同 seq 比较结果为 0', () => {
  const a = claudeSeq('r1', 'g1', 100, 3)
  assert.equal(claudeCmp(a, a), 0)
})

test('claudeCmp: generation 不同 → NaN（文件被截断/重写）', () => {
  const a = claudeSeq('r1', 'g1', 100, 0)
  const b = claudeSeq('r1', 'g2', 100, 0)
  assert.ok(Number.isNaN(claudeCmp(a, b)))
})

test('claudeCmp: realId 不同 → NaN', () => {
  const a = claudeSeq('r1', 'g1', 100, 0)
  const b = claudeSeq('r2', 'g1', 100, 0)
  assert.ok(Number.isNaN(claudeCmp(a, b)))
})

test('claudeCmp: 任一方解析失败 → NaN', () => {
  const a = claudeSeq('r1', 'g1', 100, 0)
  assert.ok(Number.isNaN(claudeCmp(a, 'not-a-seq')))
  assert.ok(Number.isNaN(claudeCmp('not-a-seq', a)))
})

test('numCmp: 数字比较', () => {
  assert.equal(numCmp(5, 3), 2)
  assert.equal(numCmp(3, 5), -2)
  assert.equal(numCmp(5, 5), 0)
})

test('buildFrame (numCmp): since=null → snapshot 全量', () => {
  const events = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
  const r = buildFrame({ events, since: null, firstSeq: 1, lastSeq: 3, cmp: numCmp })
  assert.deepEqual(r, { kind: 'snapshot', events, firstSeq: 1, lastSeq: 3 })
})

test('buildFrame (numCmp): since=undefined → snapshot 全量', () => {
  const events = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
  const r = buildFrame({ events, since: undefined, firstSeq: 1, lastSeq: 3, cmp: numCmp })
  assert.equal(r.kind, 'snapshot')
  assert.deepEqual(r.events, events)
})

test('buildFrame (numCmp): since=lastSeq → append 空数组（客户端已是最新）', () => {
  const events = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
  const r = buildFrame({ events, since: 3, firstSeq: 1, lastSeq: 3, cmp: numCmp })
  assert.deepEqual(r, { kind: 'append', events: [], fromSeq: 3, lastSeq: 3 })
})

test('buildFrame (numCmp): since 在窗口中间 → append 仅严格更新的事件', () => {
  const events = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]
  const r = buildFrame({ events, since: 2, firstSeq: 1, lastSeq: 4, cmp: numCmp })
  assert.equal(r.kind, 'append')
  assert.deepEqual(r.events, [{ seq: 3 }, { seq: 4 }])
  assert.equal(r.fromSeq, 2)
  assert.equal(r.lastSeq, 4)
})

test('buildFrame (numCmp): since < firstSeq → snapshot 带 droppedBefore', () => {
  const events = [{ seq: 10 }, { seq: 11 }, { seq: 12 }]
  const r = buildFrame({ events, since: 5, firstSeq: 10, lastSeq: 12, cmp: numCmp })
  assert.deepEqual(r, { kind: 'snapshot', events, firstSeq: 10, lastSeq: 12, droppedBefore: 10 })
})

test('buildFrame: since=0 (Codex 游标可为 0) → append 而非 snapshot', () => {
  const events = [{ seq: 1 }, { seq: 2 }]
  const f = buildFrame({ events, since: 0, firstSeq: 0, lastSeq: 2, cmp: numCmp })
  assert.equal(f.kind, 'append')
  assert.deepEqual(f.events.map((e) => e.seq), [1, 2])
})

test('buildFrame: 窗口无 seq(firstSeq=null)但有 since → reset', () => {
  const f = buildFrame({ events: [{ id: 'a' }], since: 5, firstSeq: null, lastSeq: null, cmp: numCmp })
  assert.equal(f.kind, 'reset')
})

test('buildFrame (claudeCmp): since 不可比较（generation 不同）→ reset', () => {
  const firstSeq = claudeSeq('r1', 'g2', 0, 0)
  const lastSeq = claudeSeq('r1', 'g2', 200, 0)
  const events = [{ seq: firstSeq }, { seq: lastSeq }]
  const since = claudeSeq('r1', 'g1', 999, 0) // 旧 generation，文件被截断重写后已不匹配
  const r = buildFrame({ events, since, firstSeq, lastSeq, cmp: claudeCmp })
  assert.deepEqual(r, { kind: 'reset' })
})

test('buildFrame (claudeCmp): since 在窗口中间 → append 仅严格更新的事件', () => {
  const s0 = claudeSeq('r1', 'g1', 0, 0)
  const s1 = claudeSeq('r1', 'g1', 100, 0)
  const s2 = claudeSeq('r1', 'g1', 200, 0)
  const s3 = claudeSeq('r1', 'g1', 200, 1)
  const events = [{ seq: s0 }, { seq: s1 }, { seq: s2 }, { seq: s3 }]
  const r = buildFrame({ events, since: s1, firstSeq: s0, lastSeq: s3, cmp: claudeCmp })
  assert.equal(r.kind, 'append')
  assert.deepEqual(r.events, [{ seq: s2 }, { seq: s3 }])
  assert.equal(r.fromSeq, s1)
  assert.equal(r.lastSeq, s3)
})

test('seqBounds: 空/undefined → { firstSeq: null, lastSeq: null }', () => {
  assert.deepEqual(seqBounds([]), { firstSeq: null, lastSeq: null })
  assert.deepEqual(seqBounds(undefined), { firstSeq: null, lastSeq: null })
})

test('seqBounds: 全部无 seq → 两端都是 null', () => {
  const events = [{ type: 'assistant', text: 'a' }, { type: 'assistant', text: 'b' }]
  assert.deepEqual(seqBounds(events), { firstSeq: null, lastSeq: null })
})

test('seqBounds: 混合有/无 seq → 忽略无 seq 事件取边界', () => {
  const events = [{ seq: 5 }, {}, { seq: 9 }, {}]
  assert.deepEqual(seqBounds(events), { firstSeq: 5, lastSeq: 9 })
})
