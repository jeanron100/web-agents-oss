// 会话普查（2026-08-30 事故整改 R6，**修正版**）。
//
// ★ 先说我自己搞错的地方：我一开始把 .232 上「11 条 idle 且静默 13 天」的平台记录
//   说成"回收器视野外的内存泄漏"。查下去**不是**——它们是 `detached: true` 的可恢复身份，
//   agent 重启后按 store 别名重建，state 每轮从 JSONL mtime + /proc 实时重算，
//   显式 `inflight: false`，**不占内存、不占槽位、永不阻塞排空与部署**。代码注释里写得很清楚。
//
// ★★ 但这里有个真问题，而且很可能就是故障当天误导判断的那个：
//   复盘说「你名下挂着 9 个会话」，而**真实在跑的只有 4 个**（worker slice 里 5 个 scope）。
//   分离态与在跑的混在同一个计数里 ⇒ **故障时看到的规模是虚高的**。
//   你会以为要清 9 个，实际只有 4 个占内存 —— 这不是内存 bug，是操作画面失真。

import test from 'node:test'
import assert from 'node:assert/strict'
import { census } from './session-census.js'

const s = (o) => ({ origin: 'platform', detached: false, state: 'idle', engine: 'claude', ...o })

test('★★ 在跑的与分离态必须分开计数 —— 混在一起会让人在故障时数错规模', () => {
  const c = census([
    s({ state: 'running' }), s({ state: 'running' }),
    s({ state: 'waiting_input' }), s({ state: 'idle' }),
    ...Array.from({ length: 9 }, () => s({ detached: true, state: 'idle' })),
    { origin: 'shadow', state: 'idle', engine: 'codex' },
  ])
  assert.equal(c.platformLive, 4, '真实在跑（占内存、占槽位）')
  assert.equal(c.platformDetached, 9, '分离态（可恢复身份，不占资源）')
  assert.equal(c.shadow, 1)
  assert.equal(c.total, 14)
})

test('★ 只有 platformLive 才是"占内存的那些" —— 容量判断只能看它', () => {
  const c = census([s({ detached: true }), s({ detached: true }), s({ state: 'running' })])
  assert.equal(c.platformLive, 1)
  assert.equal(c.memoryHolders, 1, 'memoryHolders 必须等于 platformLive，别把幽灵算进容量')
})

test('★ 活跃态细分：running / waiting_* 是"会被重启腰斩"的那些', () => {
  const c = census([
    s({ state: 'running' }), s({ state: 'waiting_approval' }),
    s({ state: 'waiting_input' }), s({ state: 'idle' }), s({ state: 'error' }),
    s({ detached: true, state: 'running' }),   // 分离态即便显示 running 也不算（inflight:false）
  ])
  assert.equal(c.platformActive, 3, 'running + waiting_approval + waiting_input')
  assert.equal(c.platformLive, 5)
})

test('★ 空输入返回全 0，不抛', () => {
  const c = census([])
  assert.equal(c.total, 0); assert.equal(c.platformLive, 0)
  assert.equal(census(null).total, 0)
})

test('★ 按引擎分组 —— 某引擎为 0 时一眼可见（三引擎对称是本仓库的不变量）', () => {
  const c = census([s({ engine: 'claude' }), s({ engine: 'codex' }), { origin: 'shadow', engine: 'kimi', state: 'idle' }])
  assert.deepEqual(c.byEngine, { claude: 1, codex: 1, kimi: 1 })
})
