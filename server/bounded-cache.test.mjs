// node --test server/bounded-cache.test.mjs
//
// 有界 LRU 缓存 —— 给 agent.js 里五个**零驱逐策略**的解析缓存兜底（P5）：
//   summaryCache / eventsCache / codexSummaryCache / codexEventsCache / kimiEventsCache
//
// 现状：全是裸 `new Map()`，条目**只增不减**，随 agent 生命周期无限增长。
// 实测语料：.232 有 10,668 个 Claude JSONL。虽然 buildState 因 MAX_PER_PROJECT 只扫子集，
// 但 `usageDaily` / `usageTodayHourly` / `usageProjectsToday` 会遍历**全部**文件 ⇒
// 缓存最终可以装下整个语料。每条还挂着 summary + 最多 400 条事件 ⇒ 这是 cgroup 里
// `anon` 内存的一个确定增长源（实测 anon=610MB）。
//
// ★ 但驱逐本身也有风险：驱逐掉的条目下次访问就要**全量重扫**（checkpoint 一并没了）。
//   所以上限不能拍脑袋——太小会把「增量续扫」的收益抵消掉，变成周期性全量扫风暴。
//   下面几条测试就是钉这个平衡的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedCache } from './bounded-cache.js'

test('未超上限时行为与普通 Map 一致', () => {
  const c = createBoundedCache(3)
  c.set('a', 1); c.set('b', 2)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('b'), 2)
  assert.equal(c.size, 2)
  assert.equal(c.get('nope'), undefined)
})

test('超上限时驱逐**最久未访问**的条目', () => {
  const c = createBoundedCache(2)
  c.set('a', 1)
  c.set('b', 2)
  c.set('c', 3)                 // 超限 → 应驱逐 a
  assert.equal(c.get('a'), undefined)
  assert.equal(c.get('b'), 2)
  assert.equal(c.get('c'), 3)
  assert.equal(c.size, 2)
})

test('★ get 会刷新新鲜度（LRU 而非 FIFO）', () => {
  // 关键：活跃会话被反复 get。若是 FIFO，最活跃的那个反而会被先踢掉，
  // 那正是最不该丢 checkpoint 的一个 —— 它每 3 秒就要用一次。
  const c = createBoundedCache(2)
  c.set('a', 1)
  c.set('b', 2)
  c.get('a')                    // a 变成最新
  c.set('c', 3)                 // 应驱逐 b，不是 a
  assert.equal(c.get('a'), 1, '刚访问过的 a 不该被驱逐')
  assert.equal(c.get('b'), undefined)
})

test('重复 set 同一个键刷新新鲜度且不增长 size', () => {
  const c = createBoundedCache(2)
  c.set('a', 1); c.set('b', 2)
  c.set('a', 9)                 // 更新 a
  c.set('c', 3)                 // 应驱逐 b
  assert.equal(c.get('a'), 9)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.size, 2)
})

test('has 不改变新鲜度（只读探测不该影响驱逐顺序）', () => {
  const c = createBoundedCache(2)
  c.set('a', 1); c.set('b', 2)
  c.has('a')
  c.set('c', 3)
  assert.equal(c.get('a'), undefined, 'has 不是访问，a 仍是最久未用')
})

test('delete 生效并腾出位置', () => {
  const c = createBoundedCache(2)
  c.set('a', 1); c.set('b', 2)
  assert.equal(c.delete('a'), true)
  assert.equal(c.size, 1)
  c.set('c', 3)
  assert.equal(c.get('b'), 2, '删过一个之后不该再驱逐')
  assert.equal(c.get('c'), 3)
})

test('★ 上限 ≤0 或非法时退化为**无界**，而不是变成 0 容量', () => {
  // 配错一个环境变量就把缓存变成"永远不命中"，等于把增量续扫整个关掉，
  // 而且完全静默——只是突然变慢。宁可无界（回到今天的行为），也不要静默失效。
  for (const bad of [0, -1, NaN, undefined, null, 'x']) {
    const c = createBoundedCache(bad)
    for (let i = 0; i < 50; i++) c.set(`k${i}`, i)
    assert.equal(c.size, 50, `上限=${String(bad)} 时应无界`)
    assert.equal(c.get('k0'), 0)
  }
})

test('驱逐是逐个的，不是清空', () => {
  const c = createBoundedCache(3)
  for (let i = 0; i < 10; i++) c.set(`k${i}`, i)
  assert.equal(c.size, 3, '应恒定维持在上限，而不是一超就清空')
  assert.equal(c.get('k9'), 9)
  assert.equal(c.get('k7'), 7)
  assert.equal(c.get('k6'), undefined)
})

test('提供 stats() 供可观测性上报', () => {
  const c = createBoundedCache(2)
  c.set('a', 1); c.set('b', 2)
  c.get('a')            // hit
  c.get('zz')           // miss
  c.set('c', 3)         // 触发一次驱逐
  const s = c.stats()
  assert.equal(s.max, 2)
  assert.equal(s.size, 2)
  assert.equal(s.hits, 1)
  assert.equal(s.misses, 1)
  assert.equal(s.evictions, 1)
})
