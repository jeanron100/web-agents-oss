// node --test server/incident-filter.test.mjs
//
// 重启事件簿的删除条件。这是**破坏性**操作，条件写错就把真事故记录删了——而那份名单
// （重启当时被 SIGKILL 波及的会话）事后**再也拿不到**，是本项目最痛那类事故的唯一复盘依据。
// 所以「只清无影响记录」必须严格只匹配空名单，宁可漏删不可错删。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restartDeleteFilter, isNoImpact } from './incident-filter.js'

test('★★ 只清无影响：有 killedSessions 的记录绝不能被匹配（错删=丢失事故证据）', () => {
  const real = { kind: 'agent.restart', killedSessions: [{ sessionId: 'ps-1', project: 'web_agents', state: 'running', inflight: true }] }
  assert.equal(isNoImpact(real), false, '波及过会话的记录必须保住')
})

test('★ 空名单 / 字段缺失 / null 都算「无影响」', () => {
  assert.equal(isNoImpact({ killedSessions: [] }), true)
  assert.equal(isNoImpact({}), true, '老记录可能压根没这个字段')
  assert.equal(isNoImpact({ killedSessions: null }), true)
})

test('★ onlyEmpty 的查询必须同时锁定 kind，别误删别的状态事件', () => {
  const q = restartDeleteFilter(true)
  assert.equal(q.kind, 'agent.restart', '不锁 kind 会连 agent 上下线等事件一起删')
  assert.ok(Array.isArray(q.$or), '空数组与字段缺失两种形态都要覆盖')
  const forms = JSON.stringify(q.$or)
  assert.ok(forms.includes('$size'), '必须匹配空数组')
  assert.ok(forms.includes('$exists'), '必须匹配字段缺失的老记录')
})

test('★ 清空全部：只按 kind 限定，且【不得】带上 $or（否则就不是全清了）', () => {
  const q = restartDeleteFilter(false)
  assert.deepEqual(q, { kind: 'agent.restart' })
})

test('★ 两种条件对同一批数据的实际效果（防止条件看着对、匹配错）', () => {
  const docs = [
    { kind: 'agent.restart', killedSessions: [{ sessionId: 'a' }] },  // 真事故
    { kind: 'agent.restart', killedSessions: [] },                    // 噪声
    { kind: 'agent.restart' },                                        // 老记录，无字段
  ]
  const noImpact = docs.filter(isNoImpact)
  assert.equal(noImpact.length, 2, '只该命中 2 条噪声')
  assert.equal(docs.filter((d) => !isNoImpact(d)).length, 1, '真事故那条必须活着')
})
