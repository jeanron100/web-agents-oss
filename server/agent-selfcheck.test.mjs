// agent 自检判据（2026-08-30 事故整改 R4）。纯函数。
//
// 事故：agent 停止服务 **65 分钟**，而 systemd 全程显示 active(running)、Restart 一次都没触发。
// ★★ 崩溃/冻住但**不退出**，会把自动重启机制一起废掉 —— systemd 只看进程在不在。
//
// ★★★ 而且最要紧的是**区分两种形态，处置完全相反**：
//   · 崩溃壳：journal 有 EPIPE/FATAL，进程 WCHAN 正常 ⇒ **必须重启**
//   · 被节流冻住：WCHAN=mem_cgroup_handle_over_high、journal 零致命错误 ⇒ **重启纯属误伤**
//     （会腰斩正在跑的会话，而队列本来会自己排空——本次事故就是人工清了 5 个尸体后
//      **未经重启 3 分钟自愈**，load 35.37 → 0.83）

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkHealth, classifyStall } from './agent-selfcheck.js'

test('★ 三件套全绿 ⇒ 健康', () => {
  const r = checkHealth({ recvQ: 0, sendQ: 511, httpCode: 200, zombies: 0 })
  assert.equal(r.healthy, true)
})

test('★★ accept 队列接近上限 ⇒ 不健康（端口在听但不 accept 的签名）', () => {
  const r = checkHealth({ recvQ: 500, sendQ: 511, httpCode: 200, zombies: 0 })
  assert.equal(r.healthy, false)
  assert.match(r.reasons.join(' '), /accept/)
})

test('★★ HTTP 自探非 200 ⇒ 不健康', () => {
  assert.equal(checkHealth({ recvQ: 0, sendQ: 511, httpCode: 0, zombies: 0 }).healthy, false)
  assert.equal(checkHealth({ recvQ: 0, sendQ: 511, httpCode: 503, zombies: 0 }).healthy, false)
})

test('★★ 探活端点不能用 /api/health —— 它不存在，返 404，拿它探活等于永远报故障', () => {
  const r = checkHealth({ recvQ: 0, sendQ: 511, httpCode: 404, zombies: 0 })
  assert.equal(r.healthy, false)
  assert.match(r.reasons.join(' '), /404|端点/)
})

test('★ 僵尸进程 > 0 ⇒ 不健康（事件循环没在转）', () => {
  assert.equal(checkHealth({ recvQ: 0, sendQ: 511, httpCode: 200, zombies: 3 }).healthy, false)
})

test('★ 读不到指标时**不误报**（未知 ≠ 故障，否则告警会长鸣到没人看）', () => {
  const r = checkHealth({ recvQ: null, sendQ: null, httpCode: null, zombies: null })
  assert.equal(r.healthy, true)
  assert.match(r.reasons.join(' ') + r.note, /未知|读不到/)
})

// ── 形态判别：处置完全相反，判错的代价是腰斩正在跑的会话 ──

test('★★ WCHAN=mem_cgroup_handle_over_high + 零致命错误 ⇒ 被节流冻住，**别重启**', () => {
  const r = classifyStall({ wchan: 'mem_cgroup_handle_over_high', fatalCount: 0, zombies: 0 })
  assert.equal(r.kind, 'throttled')
  assert.equal(r.shouldRestart, false)
  assert.match(r.action, /解节流|减负|别重启|不要重启/)
})

test('★★ journal 有 EPIPE/FATAL ⇒ 崩溃壳，必须重启', () => {
  const r = classifyStall({ wchan: 'ep_poll', fatalCount: 3, zombies: 9 })
  assert.equal(r.kind, 'crashed')
  assert.equal(r.shouldRestart, true)
})

test('★ 两个特征同时出现时按**保守**处理：不自动重启，交人判断', () => {
  // 误判代价不对称：把"冻住"当"已死"去重启 = 白白截断正在跑的会话
  const r = classifyStall({ wchan: 'mem_cgroup_handle_over_high', fatalCount: 5, zombies: 0 })
  assert.equal(r.shouldRestart, false)
  assert.match(r.kind, /ambiguous|throttled/)
})

test('★ 证据不全时不得断言崩溃（读不到 WCHAN 不等于它正常）', () => {
  const r = classifyStall({ wchan: null, fatalCount: 0, zombies: 0 })
  assert.equal(r.shouldRestart, false)
  assert.match(r.kind, /unknown|ambiguous/)
})
