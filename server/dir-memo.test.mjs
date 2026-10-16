// node --test server/dir-memo.test.mjs
//
// 文件发现的短 memo（P6）。
//
// 为什么（2026-08-13 在 .232 实测归因）：改完 P1/P2 之后再 strace 一次，
// 3 次 /api/state 期间的 openat 分布是
//   .jsonl 10 次 · /proc/* 1,225 次 · **其它 10,098 次**
// 其它里的头名是 `/root/.claude/projects`(180) 与 `/root/.codex/sessions/2026/*`(174+)
// ⇒ **每次 buildState 都在递归遍历整棵日期目录树**，而 `listCodexFiles()` / `discoverProjects()`
//   一个缓存都没有。10,098 ÷ 3 ≈ 3,366/次，正好等于 P1 修完后剩下的缺口。
//
// ★ 这是数据改计划的一例：P6 原本排在批次 5，实测显示它已是首要开销，于是提前。
//
// ★ memo 窗口的取舍：目录内容变化 = 新会话文件出现。窗口太长 ⇒ 新会话延迟上榜。
//   取 5 秒：前端本来就 3 秒轮询一次，多等一拍用户感知不到；而收益是把递归遍历
//   从「每次 buildState」降到「每 5 秒一次」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTtlMemo } from './dir-memo.js'

test('窗口内复用，不重新计算', () => {
  let calls = 0
  let t = 1000
  const m = createTtlMemo(() => { calls++; return ['a'] }, { ttlMs: 5000, now: () => t })
  m(); m(); m()
  assert.equal(calls, 1)
  t = 5999
  m()
  assert.equal(calls, 1)
})

test('窗口过期后重新计算', () => {
  let calls = 0
  let t = 1000
  const m = createTtlMemo(() => { calls++; return ['a'] }, { ttlMs: 5000, now: () => t })
  m()
  t = 6001
  m()
  assert.equal(calls, 2)
})

test('★ 时钟回拨不得把缓存永久钉死', () => {
  // 同 proc-index：任何 memo 都必须能自己释放。本仓库栽过闸门被焊死的坑。
  let calls = 0
  let t = 10_000
  const m = createTtlMemo(() => { calls++; return [] }, { ttlMs: 5000, now: () => t })
  m()
  t = 3_000
  m()
  assert.equal(calls, 2, '时间倒退时 MUST 重算')
})

test('ttlMs=0 表示不缓存', () => {
  let calls = 0
  const m = createTtlMemo(() => { calls++; return [] }, { ttlMs: 0, now: () => 1 })
  m(); m()
  assert.equal(calls, 2)
})

test('★ 计算抛异常时不缓存异常，下次仍会重试', () => {
  // 目录一时读不到（权限/挂载抖动）不该被记住 5 秒——那会把瞬时故障放大成持续故障。
  let calls = 0
  let boom = true
  const m = createTtlMemo(() => { calls++; if (boom) throw new Error('EACCES'); return ['ok'] }, { ttlMs: 5000, now: () => 1000 })
  assert.throws(() => m())
  boom = false
  assert.deepEqual(m(), ['ok'], '上次抛异常后必须重试，不得返回缓存的失败')
  assert.equal(calls, 2)
})

test('invalidate 强制下次重算', () => {
  let calls = 0
  const m = createTtlMemo(() => { calls++; return [] }, { ttlMs: 100000, now: () => 1000 })
  m()
  m.invalidate()
  m()
  assert.equal(calls, 2)
})

test('返回的是同一个引用（调用方不得依赖每次拿到新数组）', () => {
  const m = createTtlMemo(() => ['a'], { ttlMs: 5000, now: () => 1 })
  assert.equal(m(), m(), 'memo 命中时返回同一引用——调用方若要改动结果必须自己复制')
})
