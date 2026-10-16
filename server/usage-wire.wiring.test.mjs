// node --test server/usage-wire.wiring.test.mjs
//
// 额度端点**不得同步等探测**的接线护栏（2026-09-11）。
//
// ★ 纯函数测试（usage-wire.test.mjs）只证明出口形态算得对，证明不了端点在用它 ——
//   本仓库最常见的回归形态就是「接线掉了而单测全绿」。同 driver-usage.wiring 手法。
//
// ⚠️ 源码断言**必须先剥注释**：本文件引用的反例原文若留在被测源码的注释里，
//    断言会在代码已改对的情况下变红（我在 ChatMessage 那次刚踩过）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const RAW = fs.readFileSync(new URL('./hub.js', import.meta.url), 'utf8')
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('★★ 请求路径上不得 await 额度探测（那会占住一条跨境连接 5~20 秒）', () => {
  assert.doesNotMatch(SRC, /if \(!usageLimits\)\s*await/,
    'Claude 探测实测 5.18s；同步等会占住跨境 HTTP 连接，而本仓库栽过"请求堆叠打满 keepalive 池"')
  assert.doesNotMatch(SRC, /if \(!kimiUsage\)\s*await/,
    'Kimi 探测要起 tmux 抓 TUI，注释里写着约 20s —— 比 Claude 那条严重 4 倍')
})

test('★ 必须改成后台刷（void + catch），别把异常变成未处理拒绝', () => {
  assert.match(SRC, /if \(!usageLimits\) void refreshUsageLimits\(\)\.catch/)
  assert.match(SRC, /if \(!kimiUsage\) void refreshKimiUsage\(\)\.catch/)
})

test('★★ 两个出口都要经 usageWire —— 否则 pending 标不出来，前端就只能干等 60 秒', () => {
  const n = (SRC.match(/usageWire\(/g) ?? []).length
  assert.ok(n >= 2, `Claude 与 Kimi 两处都要走，实际只有 ${n} 处`)
  assert.match(SRC, /probing: usageProbing/)
  assert.match(SRC, /probing: kimiUsageProbing/)
})

test('★ probing 标志必须在 finally 里复位 —— 探测抛异常就永远卡在 pending', () => {
  // 我第一版给 Kimi 加了 `try {` 却漏了 `finally`，而 `node --check hub.js` **exit=0 放过了**
  //（.js 按 CJS 解析）。真正 import 才报 Missing catch or finally。
  assert.match(SRC, /\} finally \{ usageProbing = false \}/)
  assert.match(SRC, /\} finally \{ kimiUsageProbing = false \}/)
})
