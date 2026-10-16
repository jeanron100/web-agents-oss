// server/hidden-projects.wiring.test.mjs — hub 必须把隐藏名单**下发**给 agent。
//
// ★ 为什么是读源码断言：跑真 hub 要 5 条 SSH 隧道 + 5 台 agent。而这里要守的不是算法
//   （`hidden-projects.test.mjs` 已经证明算得对），是**接线**——本仓库最常见的回归形态
//   就是「纯函数全绿而调用方根本没在用它」。
//
// ★★ 最容易悄悄回归的是「省略参数」这一条：agent 用 `searchParams.has('hidden')` 区分
//   「没传」与「传了空」。若 hub 在名单为空时把参数整个省掉（看起来是个无害的优化），
//   agent 就会**维持上一次的名单** ⇒ 用户点了「恢复纳管」而项目永远回不来，
//   且症状是间歇性的（取决于最后一次带参数的请求是什么）。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const HUB = fs.readFileSync(new URL('./hub.js', import.meta.url), 'utf8')
const AGENT = fs.readFileSync(new URL('./agent.js', import.meta.url), 'utf8')

test('★ hub 拉 agent 的 /api/state 时必须带上 hidden 参数', () => {
  assert.match(HUB, /\/api\/state\?hidden=\$\{hq\}/,
    'hub 不下发名单 = agent 永远不知道该隐藏什么，前端过滤只是障眼法（热路径照扫）')
  assert.match(HUB, /hiddenForServer\(hiddenCache, a\.id\)/,
    '必须按 agent id 切出该机那份——serverId/project 是全局键，整份下发会误伤同名项目')
})

test('★★ 新建会话的项目下拉是另一条链路，hub 也要带参数', () => {
  assert.match(HUB, /\/api\/projects\?hidden=\$\{hq\}/,
    '只挡看板不挡下拉 = 项目消失了却还能新建会话到它上面去')
})

test('★ 名单为空时也必须发参数，不能省略', () => {
  // `join(',')` 对空数组产生空串，模板字符串照样输出 `?hidden=` —— 这正是我们要的。
  // 若有人改成 `hq ? '?hidden='+hq : ''` 之类的"优化"，取消隐藏就永远生效不了。
  // 任何对 hq 的条件判断都是这个 bug 的形态，直接禁掉整类写法（比匹配某一种拼法可靠）
  assert.doesNotMatch(HUB, /\bhq\s*(\?|&&|\|\|)/,
    '对 hq 做条件判断会让「传了空」退化成「没传」，用户就再也恢复不了项目')
})

test('★ agent 必须用 has() 区分「没传」与「传了空」', () => {
  assert.match(AGENT, /searchParams\?\.has\('hidden'\)/,
    "用 get('hidden') 判空会把「没传」和「传了空」混为一谈：直连 curl 一次就把名单冲掉了")
})

test('★★ 六个纳管入口必须共用同一个判据，不许有裸的 EXCLUDE_PROJECTS.has()', () => {
  // 本仓库的老账：resume-guard.js#canResume 三侧共用一份续扫判据才没在部署闸上出事。
  // 这里同理——漏掉任何一个入口，隐藏的项目就会从那个旁路再漏出来
  // （最容易漏的是 /api/usage/projects-today 的 Codex 分支）。
  assert.doesNotMatch(AGENT, /EXCLUDE_PROJECTS\.has\(/,
    '发现裸 has()：该处没有走 excludedProject()，动态隐藏名单在那条路径上失效')
  const n = (AGENT.match(/if \(excludedProject\(/g) ?? []).length
  assert.ok(n >= 6, `六个纳管入口都要判一次，实际只有 ${n} 处`)
})
