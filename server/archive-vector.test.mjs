// 向量回填的回归测试（openspec change: execution-history-archive，P2）。
//
// ★★ 这一层最要紧的不是"能不能建索引"，而是**不能把公网入口打挂**。
//   `62.234` 只有 **2 核**，且同时承载公网 443 与跨境隧道；BGE 进程已占 62% 内存。
//   2026-08-29 我自己实测过一次：embedding 全速跑时网关 load 冲到 **2.50~2.79**、
//   `/api/state` 从 0.15s 劣化到 **2.28s（15×）** —— 正是「跨境 TLS 握手超时 ⇒ 504 ⇒
//   与服务器失联」的成因条件，也正是这两天连修两轮的那个症状。
//   **所以「破线即停」必须是可测的判据，不能只是注释里的一句话。**

import test from 'node:test'
import assert from 'node:assert/strict'
import { planBatches, shouldPause, shouldPauseByLatency, sleepFor, pointId, toPoint, VECTOR_DIM } from './archive-vector.js'

// ───────────────── 分批 ─────────────────

test('★ 按 batch=8 分批（实测最优：单条 1387ms → 551ms，2.5×）', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, text: 't' }))
  const b = planBatches(items, 8)
  assert.deepEqual(b.map((x) => x.length), [8, 8, 4])
})

test('批大小上限 64（服务端 maxItems=64，超了会 422）', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, text: 't' }))
  assert.ok(planBatches(items, 999).every((x) => x.length <= 64))
})

test('空输入返回空批次，不抛', () => {
  assert.deepEqual(planBatches([], 8), [])
  assert.deepEqual(planBatches(null, 8), [])
})

// ───────────────── 破线即停（核心） ─────────────────

test('★★ 网关 5 分钟 load 超阈值 ⇒ 暂停，而不是"记个日志继续跑"', () => {
  // 阈值语义是**每核**。GOAL 写的「2 核机 5 分钟 load ≤ 1.0」= 每核 0.5。
  // 统一成每核是为了可移植：同一份配置换台机器不会要么形同虚设、要么永远暂停。
  assert.equal(shouldPause({ load5: 1.4, cores: 2, threshold: 0.5 }).pause, true)   // 0.70/核
  assert.match(shouldPause({ load5: 1.4, cores: 2, threshold: 0.5 }).reason, /load/)
})

test('★ 未破线则继续', () => {
  assert.equal(shouldPause({ load5: 0.4, cores: 2, threshold: 0.5 }).pause, false)  // 0.20/核
})

test('★★ 读不到 load ⇒ **保守暂停**，不是当作健康继续跑', () => {
  // fail-safe 的方向必须朝"少做事"。读不到就继续 = 探测失效时闸门自动失效，
  // 本仓库栽过同型的坑（「跳过」永远成立 = 永不重启的免死金牌）。
  for (const v of [null, undefined, NaN, 'abc']) {
    const r = shouldPause({ load5: v, cores: 2, threshold: 1.0 })
    assert.equal(r.pause, true, `load5=${String(v)} 时应保守暂停`)
    assert.match(r.reason, /读不到|未知/)
  }
})

test('★ 阈值非法时退回默认，不得得到 NaN 把闸门焊死', () => {
  // `load > NaN` 恒为 false ⇒ 永不暂停，比用默认值更危险且悄无声息。
  const r = shouldPause({ load5: 0.5, cores: 2, threshold: 'flase' })
  assert.equal(typeof r.threshold, 'number')
  assert.ok(Number.isFinite(r.threshold))
})

test('★ 阈值按核数缩放 —— 2 核机的 1.0 与 8 核机的 1.0 不是一回事', () => {
  // 不缩放的话，把同一份配置搬到别的机器上要么形同虚设、要么永远暂停。
  assert.equal(shouldPause({ load5: 3.0, cores: 8, threshold: 0.5 }).pause, false)  // 3.0/8 = 0.375
  assert.equal(shouldPause({ load5: 3.0, cores: 2, threshold: 0.5 }).pause, true)   // 3.0/2 = 1.5
})

// ───────────────── 耗时拥塞探针 ─────────────────
//
// 实测 `/health` 只回 {status,model,device,modes}，**没有负载字段**。
// 「读不到 load 就暂停」的方向是对的，但那样**回填永远不跑**。
// 与其改另一个项目的服务，不如用自带的信号：**batch 耗时本身**——
// 它测的正是我们关心的那件事，而且自校准。

test('★★ 批次耗时超基线数倍 ⇒ 暂停（网关吃紧的直接证据）', () => {
  const r = shouldPauseByLatency({ lastMs: 15_000, baselineMs: 4400, factor: 2.5 })
  assert.equal(r.pause, true)
  assert.match(r.reason, /超基线/)
})

test('★ 正常波动不暂停', () => {
  assert.equal(shouldPauseByLatency({ lastMs: 5200, baselineMs: 4400, factor: 2.5 }).pause, false)
})

test('★★ 没有基线时**不暂停** —— 否则首批就被挡住，基线永远建立不起来（闸门自锁）', () => {
  // 与「读不到 load 就暂停」不冲突：那里的未知是"探测坏了"，这里的未知是"还没开始"。
  for (const b of [undefined, null, 0, NaN, -1]) {
    assert.equal(shouldPauseByLatency({ lastMs: 99_999, baselineMs: b }).pause, false, `baseline=${String(b)}`)
  }
})

test('★ factor 非法退回默认，不得算出 NaN 把闸门焊死', () => {
  const r = shouldPauseByLatency({ lastMs: 20_000, baselineMs: 4400, factor: 'x' })
  assert.equal(r.pause, true)
  assert.ok(Number.isFinite(r.factor))
})

// ───────────────── 占空比 ─────────────────

test('★★ 50% 占空比：批间休眠 ≈ 上一批耗时，等于只占一个核', () => {
  // 2 核机上让出一个核给 TLS 握手——那正是被 embedding 抢走时会超时的东西。
  assert.equal(sleepFor(4410, 0.5), 4410)
  assert.equal(sleepFor(1000, 0.5), 1000)
})

test('占空比 1.0 = 不休眠（只应在专用机上用）', () => {
  assert.equal(sleepFor(4410, 1), 0)
})

test('★ 占空比非法值退回 0.5，不得算出负数或 Infinity', () => {
  for (const d of [0, -1, 'x', null, 99]) {
    const ms = sleepFor(1000, d)
    assert.ok(Number.isFinite(ms) && ms >= 0, `duty=${String(d)} → ${ms}`)
  }
})

// ───────────────── Qdrant 点 ─────────────────

test('★★ 点 id 必须由坐标决定 —— 重跑回填不得产生重复点', () => {
  const a = pointId({ host: 'h1', project: '-data-x', session: 's1' })
  assert.equal(a, pointId({ host: 'h1', project: '-data-x', session: 's1' }))
  assert.notEqual(a, pointId({ host: 'h2', project: '-data-x', session: 's1' }))
  // Qdrant 只接受无符号整数或 UUID
  assert.match(String(a), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test('★★ payload 必须带全坐标 —— 检索结果 100% 可溯源是 GOAL 硬指标', () => {
  const p = toPoint({
    host: 'h1', project: '-data-x', session: 's1', engine: 'claude',
    startedAt: 1, lastAt: 2, firstPrompt: '修 bug',
  }, new Array(VECTOR_DIM).fill(0.1))
  for (const k of ['host', 'project', 'session', 'engine', 'lastAt']) {
    assert.ok(p.payload[k] !== undefined, `payload 缺 ${k}`)
  }
  assert.equal(p.vector.length, VECTOR_DIM)
})

test('★ 维度不符必须拒绝 —— 写进去就污染 collection 了', () => {
  assert.throws(() => toPoint({ host: 'h', project: 'p', session: 's' }, [0.1, 0.2]), /维度/)
})

test('★ payload 不夹带原文 —— Qdrant 是索引不是仓库', () => {
  const p = toPoint({ host: 'h', project: 'p', session: 's', firstPrompt: 'x'.repeat(5000), texts: ['y'.repeat(9000)] },
    new Array(VECTOR_DIM).fill(0))
  assert.ok(JSON.stringify(p.payload).length < 1200, `payload ${JSON.stringify(p.payload).length} B 太大`)
  assert.equal(p.payload.texts, undefined)
})
