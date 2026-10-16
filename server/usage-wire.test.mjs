// node --test server/usage-wire.test.mjs
//
// 额度端点的出口形态（2026-09-11 用户提「查 usage 有时候慢」之后改）。
//
// ★ 实测各段：hub 读缓存 **0.0006s**、前端经跨境 **0.64~1.54s**、
//   而 `claude --print /usage` 真探一次 **5.18s**（Kimi 更狠，注释写着约 20s）。
//   缓存命中时一点都不慢；慢只发生在**没有旧值**时——端点那句
//   `if (!usageLimits) await refreshUsageLimits()` 会让请求**同步等探测跑完**。
//   代价不只是用户等：它占着一条跨境 HTTP 连接 5~20 秒，
//   而本仓库栽过「请求堆叠打满 keepalive 池」。
//
// ⇒ 改成 stale-while-revalidate：立刻返回手头有的，后台去刷。
//
// ★★ 但只改服务端会让体验更差：前端 UsageRow 是 **60 秒**轮询一次，
//   用户会从「等 5 秒看到数字」变成「等 60 秒」。所以出口必须带 `pending`，
//   让前端知道"正在探、马上会有"，据此快速补拉一次。
//   **把阻塞去掉的同时必须给出回程 —— 否则就是把同步等待换成了更长的空窗。**
//   （同族：「凡写降级路径，先问怎么回来」。）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageWire } from './usage-wire.js'

const EMPTY = { session: null, week: null, weekSonnet: null }
const VAL = { session: { pct: 5 }, week: { pct: 61 }, weekSonnet: { pct: 0 }, ts: 123 }

test('有值就直接给值，不带任何等待标记', () => {
  const w = usageWire({ value: VAL, error: null, probing: false, empty: EMPTY })
  assert.equal(w.week.pct, 61)
  assert.equal(w.pending, undefined)
  assert.equal(w.stale, undefined)
})

test('★ 有旧值 + 探测失败：给旧值并标 stale + error（别把旧值吞掉）', () => {
  const w = usageWire({ value: VAL, error: '探测超时', probing: false, empty: EMPTY })
  assert.equal(w.week.pct, 61, '有旧值就该显示，总比一片 — 强')
  assert.equal(w.stale, true)
  assert.equal(w.error, '探测超时')
})

test('★★ 没有旧值但正在探：必须标 pending —— 前端据此快速补拉，而不是干等 60 秒', () => {
  const w = usageWire({ value: null, error: null, probing: true, empty: EMPTY })
  assert.deepEqual(w.session, null)
  assert.equal(w.pending, true, '不标 pending 的话，去掉同步阻塞=把 5 秒换成 60 秒空窗')
  assert.equal(w.stale, undefined, '还没探过不算 stale —— stale 的意思是"有旧值但可能过期"')
})

test('★ 没有旧值且探测失败：标 error，但**不标 pending**（别让前端无限快轮）', () => {
  const w = usageWire({ value: null, error: 'CLI 不可用', probing: false, empty: EMPTY })
  assert.equal(w.error, 'CLI 不可用')
  assert.equal(w.pending, undefined, 'pending 会触发前端补拉；失败态下那是自我攻击')
  assert.equal(w.stale, true)
})

test('★ 没有旧值、没在探、也没失败（冷却期内）：不标 pending', () => {
  // USAGE_RETRY_MS 冷却期内 refresh 会直接返回，此时若仍标 pending，
  // 前端会按 pending 一直快速重试，而服务端根本不会去探 —— 空转。
  const w = usageWire({ value: null, error: null, probing: false, empty: EMPTY })
  assert.equal(w.pending, undefined)
})

test('empty 形状原样透传（各引擎字段不同，不在这里硬编码）', () => {
  const kimiEmpty = { session: null, week: null }
  const w = usageWire({ value: null, error: null, probing: true, empty: kimiEmpty })
  assert.deepEqual(Object.keys(w).sort(), ['pending', 'session', 'week'])
})
