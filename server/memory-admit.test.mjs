// 内存准入判据（2026-08-30 事故整改 R2）。
//
// 事故：单会话稳定占 200~350MB，而 .232 可用内存不足 1.5G，闸门却按**条数**放到 9 个。
// 到达率长期大于完成率，必然崩。1353M 匿名 + 1276M swap = 2.63G，占整机 73%。
//
// ★★ 核心教训（CLAUDE.md 已有同族前科）：**`memory.max` 不统计 swap**。
//   所以撞了 231 万次限制只 OOM-kill 掉 2 个——压力全额外溢到全局 swap 把整机拖垮。
//   ⇒ 判余量时**必须把 swap 算进去**，只看 memory.current 会得出"还很宽裕"的错觉。

import test from 'node:test'
import assert from 'node:assert/strict'
import { admitDecision, DEFAULT_SESSION_COST, HEADROOM_FACTOR } from './memory-admit.js'

const cg = (cur, swap, max) => ({ current: cur, swapCurrent: swap, max, high: 'max' })
const MB = 1048576

test('★ 余量充足 ⇒ 放行', () => {
  const r = admitDecision({ cgroup: cg(300 * MB, 0, 1500 * MB), avgSessionBytes: 300 * MB })
  assert.equal(r.admit, true)
})

test('★★ 余量不足单会话均值 × 1.5 ⇒ 排队，不硬起', () => {
  // 1500 上限，已用 1100 ⇒ 余 400MB；单会话 300MB × 1.5 = 450MB > 400 ⇒ 不放行
  const r = admitDecision({ cgroup: cg(1100 * MB, 0, 1500 * MB), avgSessionBytes: 300 * MB })
  assert.equal(r.admit, false)
  assert.match(r.reason, /余量/)
})

test('★★ swap 必须计入已用 —— memory.max 不统计 swap，只看 current 会得出"还很宽裕"的错觉', () => {
  // current 只有 700MB 看着宽裕，但另有 700MB 已经被换出去了：真实工作集是 1400MB
  const naive = admitDecision({ cgroup: cg(700 * MB, 0, 1500 * MB), avgSessionBytes: 300 * MB })
  const real = admitDecision({ cgroup: cg(700 * MB, 700 * MB, 1500 * MB), avgSessionBytes: 300 * MB })
  assert.equal(naive.admit, true, '不含 swap 时看着宽裕')
  assert.equal(real.admit, false, '含 swap 后必须拒绝 —— 这正是事故里 2.63G/3.6G 的形态')
})

test('★ 读不到 cgroup ⇒ **放行**（不能因为探测坏了就把平台卡死）', () => {
  // 与回收器的 fail-safe 方向相反，这里要朝"别把功能卡死"：
  // 读不到就拒绝派生 = 探测一坏平台就完全不能用，比偶尔多起一个会话糟糕得多。
  // 兜底仍有条数闸（MAX_SESSIONS）与 cgroup 硬限。
  for (const bad of [null, undefined, {}, { current: NaN, max: NaN }]) {
    const r = admitDecision({ cgroup: bad, avgSessionBytes: 300 * MB })
    assert.equal(r.admit, true, `cgroup=${JSON.stringify(bad)} 时应放行`)
    assert.match(r.reason, /读不到|无法判定/)
  }
})

test('★ max 为 "max"（无硬限）时不拦 —— 没有上限就没有余量概念', () => {
  const r = admitDecision({ cgroup: { current: 9e9, swapCurrent: 0, max: 'max' }, avgSessionBytes: 300 * MB })
  assert.equal(r.admit, true)
})

test('★ 单会话均值缺失时用默认值，不得算出 NaN 把闸门焊死', () => {
  // `余量 > NaN` 恒 false ⇒ 永远拒绝派生，比放行更糟且悄无声息
  for (const bad of [undefined, null, 0, -1, 'x']) {
    const r = admitDecision({ cgroup: cg(100 * MB, 0, 1500 * MB), avgSessionBytes: bad })
    assert.equal(r.admit, true)
    assert.ok(Number.isFinite(r.need), `need=${r.need}`)
  }
  assert.ok(DEFAULT_SESSION_COST > 0)
})

test('★ 报出可读的数字，便于运维判断该调哪个旋钮', () => {
  const r = admitDecision({ cgroup: cg(1200 * MB, 100 * MB, 1500 * MB), avgSessionBytes: 300 * MB })
  assert.equal(r.admit, false)
  assert.ok(r.usedBytes >= 1300 * MB, '已用要含 swap')
  assert.ok(r.freeBytes < 300 * MB)
  assert.equal(r.need, 300 * MB * HEADROOM_FACTOR)
})

test('★ 实测均值优先于默认值（不同机器单会话成本差很多）', () => {
  const small = admitDecision({ cgroup: cg(1200 * MB, 0, 1500 * MB), avgSessionBytes: 50 * MB })
  assert.equal(small.admit, true, '小会话机器上 300MB 余量够起一个 50MB 的')
})
