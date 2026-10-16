// node --test server/session-allocate.test.mjs
//
// 看板名额分配。2026-07-21 用户实拍：invest_data 整个项目从看板消失。
// 根因是 buildState 末尾 `sessions.sort(按最后活跃).slice(0, MAX_TOTAL=40)` ——
// **全局**截断。232 上 22 个项目、每项目最多 3 条，候选远超 40，于是按活跃度排完一刀切下去：
//   显示的 14 个项目最新活跃全 < 2.5 天；被截掉的 8 个全 ≥ 3 天（invest_data 正好 3.0 天）。
//
// 两个语义错误：
//  ① 「我的项目在不在看板上」取决于**别的项目有多活跃**——自己没变，别人一忙它就消失；
//  ② 截断是**静默**的，前端完全不知道有 8 个项目被吃掉了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocateSessions } from './session-allocate.js'

// 造会话：project + 最后活跃（分钟前）。输入按活跃降序（与 buildState 排序后一致）。
const mk = (project, minAgo, i = 0) => ({
  id: `${project}-${i}`, project, serverId: 'srv-a', lastActiveAt: Date.now() - minAgo * 60_000,
})
const projectsOf = (rows) => [...new Set(rows.map((s) => s.project))]

test('★ 核心：不再让活跃项目把冷项目整个挤出看板——每个项目至少露 1 条', () => {
  // 3 个热项目各 3 条（都很新），1 个冷项目 1 条（3 天前）= invest_data 的形状
  const rows = [
    ...[0, 1, 2].map((i) => mk('hot1', 1 + i, i)),
    ...[0, 1, 2].map((i) => mk('hot2', 4 + i, i)),
    ...[0, 1, 2].map((i) => mk('hot3', 7 + i, i)),
    mk('invest_data', 3 * 24 * 60),
  ].sort((a, b) => b.lastActiveAt - a.lastActiveAt)

  const r = allocateSessions(rows, 9) // 预算 9：老逻辑会被 3 个热项目吃光，冷项目消失
  assert.ok(projectsOf(r.sessions).includes('invest_data'),
    '冷项目必须留有名额——这正是用户报的 invest_data 消失')
  assert.equal(r.sessions.length, 9)
})

test('★ 预算充足时不该动任何东西（别为了公平反而丢数据）', () => {
  const rows = [mk('a', 1), mk('a', 2, 1), mk('b', 3)]
  const r = allocateSessions(rows, 40)
  assert.equal(r.sessions.length, 3)
  assert.equal(r.truncated, false)
  assert.equal(r.hiddenSessions, 0)
  assert.equal(r.hiddenProjects, 0)
})

test('★★ 截断必须明示：说清藏了多少条、多少个项目（静默截断=前端把残缺当全集）', () => {
  const rows = []
  for (let p = 0; p < 10; p++) for (let i = 0; i < 3; i++) rows.push(mk(`p${p}`, p * 10 + i, i))
  rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const r = allocateSessions(rows, 12)
  assert.equal(r.sessions.length, 12)
  assert.equal(r.truncated, true)
  assert.equal(r.hiddenSessions, 30 - 12)
  assert.equal(r.hiddenProjects, 0, '10 个项目都露了脸，被藏的只是每项目的额外会话')
})

test('★ 项目数超过预算时：只能露前 N 个，且必须报出有多少项目完全没露脸', () => {
  const rows = []
  for (let p = 0; p < 20; p++) rows.push(mk(`p${p}`, p))
  const r = allocateSessions(rows, 5)
  assert.equal(r.sessions.length, 5)
  assert.equal(projectsOf(r.sessions).length, 5, '预算 5 只能容 5 个项目')
  assert.equal(r.hiddenProjects, 15, '必须告诉前端有 15 个项目完全看不到')
  assert.equal(r.hiddenSessions, 15)
})

test('★ 名额优先给最近活跃的项目；同项目内也按最近优先', () => {
  const rows = [
    mk('old', 5000), mk('old', 5001, 1),
    mk('fresh', 1), mk('fresh', 2, 1),
  ].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const r = allocateSessions(rows, 3)
  const ps = projectsOf(r.sessions)
  assert.equal(ps[0], 'fresh', '最活跃的项目排最前')
  assert.ok(ps.includes('old'), '但冷项目仍须有 1 个名额')
  // fresh 拿到 2 条（它更活跃），old 拿 1 条
  assert.equal(r.sessions.filter((s) => s.project === 'fresh').length, 2)
  assert.equal(r.sessions.filter((s) => s.project === 'old').length, 1)
})

test('同名项目跨服务器不混并（agent 内恒同机，但函数本身要正确）', () => {
  const a = { id: 'x', project: 'same', serverId: 'srv-a', lastActiveAt: 100 }
  const b = { id: 'y', project: 'same', serverId: 'srv-b', lastActiveAt: 99 }
  const r = allocateSessions([a, b], 2)
  assert.equal(r.sessions.length, 2, '不同机的同名项目是两个项目，各自应有名额')
})

test('空输入 / 预算为 0 不炸', () => {
  assert.deepEqual(allocateSessions([], 40).sessions, [])
  assert.equal(allocateSessions([], 40).truncated, false)
  assert.equal(allocateSessions([mk('a', 1)], 0).sessions.length, 0)
})

test('★★ 引擎不得因抢名额整个消失——每个 (项目, 引擎) 至少保底 1 条', () => {
  // 2026-08-01 用户实拍：insight_v2 打开后「Claude 对话流」Tab 不见了。
  // 根因是轮转键只到「服务器/项目」。真实规模是 20+ 个项目挤 40 个名额，每项目只轮得到 1~2 轮：
  // insight_v2 的 2 个 Kimi 会话更近，占掉这 2 轮，Claude 会话排在第 3 轮而预算早已用完
  // → 整个引擎在前端消失（Tab 是按"项目有无该引擎会话"渲染的）。
  // 「三条对话流 Tab 对称」是项目不变量，名额竞争不能把它打破。
  //
  // ⚠️ 夹具修订（2026-09-11，随「引擎占位加时效门槛」一并改，**本测试的意图一字未动**）：
  //   原夹具用 `lastActiveAt: 1000 / 500 / 100 / 99` —— 那些小数字只是表达**相对先后**，
  //   但绝对时间上是 **epoch 后 1 秒（1970 年）**。加了时效门槛后它们全落在「僵尸」一侧，
  //   于是测试红了。红的是**夹具不真实**，不是不变量被破坏：这个用例要守的是
  //   「Kimi 更近、Claude 更旧，**但两者都在近期活跃范围内** ⇒ 三条 Tab 必须对称」。
  //   现改为相对 now 的真实时间（全部 7 天内），相对顺序与原夹具完全一致。
  //   ★ 新旧边界由上面那条「僵尸引擎不得占位」用例划清：引擎**过了时效**才失去占位权。
  const MIN = 60_000
  const T0 = Date.now()
  const all = []
  // 20 个只有 claude 的项目，都比目标项目更活跃 —— 制造"每项目只轮得到两轮"的真实压力
  for (let i = 0; i < 20; i++) {
    // 每个项目 3 条：这样第 2、3 轮也被它们占满，insight 只轮得到 1 轮多
    for (let j = 0; j < 3; j++) {
      all.push({ serverId: 'a', project: `other${i}`, engine: 'claude', id: `o${i}-${j}`, lastActiveAt: T0 - (10 + i * 3 + j) * MIN })
    }
  }
  // 目标项目：两条 Kimi 更近，两条 Claude 更旧（都在近期，只是有先后）
  all.push({ serverId: 'a', project: 'insight', engine: 'kimi', id: 'k1', lastActiveAt: T0 - 100 * MIN })
  all.push({ serverId: 'a', project: 'insight', engine: 'kimi', id: 'k2', lastActiveAt: T0 - 101 * MIN })
  all.push({ serverId: 'a', project: 'insight', engine: 'claude', id: 'c1', lastActiveAt: T0 - 200 * MIN })
  all.push({ serverId: 'a', project: 'insight', engine: 'claude', id: 'c2', lastActiveAt: T0 - 201 * MIN })
  all.sort((x, y) => y.lastActiveAt - x.lastActiveAt)

  const r = allocateSessions(all, 24) // 21 个项目、24 个名额 ⇒ 只够轮一轮多一点
  const engines = new Set(r.sessions.filter((s) => s.project === 'insight').map((s) => s.engine))
  assert.ok(engines.has('kimi'), 'Kimi 会话应在')
  assert.ok(engines.has('claude'), 'Claude 会话必须保住名额，否则前端 Claude Tab 直接消失')
})

test('引擎保底不能反过来饿死其它项目——每个项目仍至少露 1 条', () => {
  const many = []
  for (let i = 0; i < 5; i++) {
    many.push({ serverId: 'a', project: `p${i}`, engine: 'claude', id: `c${i}`, lastActiveAt: 100 - i })
    many.push({ serverId: 'a', project: `p${i}`, engine: 'kimi', id: `k${i}`, lastActiveAt: 90 - i })
  }
  const r = allocateSessions(many.sort((x, y) => y.lastActiveAt - x.lastActiveAt), 5)
  assert.equal(new Set(r.sessions.map((s) => s.project)).size, 5, '5 个项目每个都要露脸')
})

// ── 2026-09-11 用户实拍：invest_data 里刚建的会话「都没了」────────────────────────
//
// ★ 现场数据（.232，18 个项目分 40 个名额，invest_data 分到 3 个）：
//     claude  ps-mtwd5omv-229    13 分钟前   ✅ 露出
//     kimi    session_ec1fb8c7   37.9 天前   ✅ 占位  ← 僵尸
//     codex   019fbba9           39.8 天前   ✅ 占位  ← 僵尸
//     claude  ps-mtu2bh63-1325   26 分钟前   ❌ 被挤掉
//     claude  ps-mtwa0aed-95     92 分钟前   ❌ 被挤掉
//   三条都是**今天新建、正在跑**的平台会话，而它们的影子又因为有平台别名被冷路径抑制
//   ⇒ 平台记录被名额挤掉 + 影子被抑制 = **两条路都看不到，会话彻底消失**。
//
// ★★ 元凶是**阶段 2**（每「项目×引擎」无条件保底 1 条），不是 engineFirst 的排序：
//   它把 2 个名额发给了 38/40 天没动过的引擎，阶段 3（按活跃轮转）就没名额了。
//   阶段 2 是 2026-08-01 为「三条对话流 Tab 对称」加的，当时的场景是
//   「2 个 Kimi 更近，挤掉 Claude」—— 两者时间接近，对称性该赢。
//   但 40 天前的僵尸 vs 26 分钟前正在跑的会话，**对称性就不该赢了**。
//
// ⇒ 用户定的需求：**大类（引擎）仍然占位，但占位权只给近期活跃的引擎**。
//   僵尸引擎不占位，把名额让给真正活跃的会话。

const DAY = 86_400_000
const mkE = (project, engine, minAgo, i = 0) => ({
  id: `${project}-${engine}-${i}`, project, engine, serverId: 'srv-a',
  lastActiveAt: Date.now() - minAgo * 60_000,
})

test('★★ 僵尸引擎不得占位：3 个名额应全给今天活跃的 Claude（用户实拍场景）', () => {
  const rows = [
    mkE('invest_data', 'claude', 13, 1),
    mkE('invest_data', 'claude', 26, 2),
    mkE('invest_data', 'claude', 92, 3),
    mkE('invest_data', 'kimi', 37.9 * 24 * 60),
    mkE('invest_data', 'codex', 39.8 * 24 * 60),
    ...Array.from({ length: 17 }, (_, k) => mkE(`p${k}`, 'claude', 60 + k)),
  ]
  // 18 个项目、22 条，预算 20 → invest_data 拿 3 个名额（与线上同构）
  const got = allocateSessions(rows, 20).sessions.filter((s) => s.project === 'invest_data')
  assert.deepEqual(got.map((s) => s.engine), ['claude', 'claude', 'claude'],
    `僵尸 kimi/codex 不该占位，实际 ${JSON.stringify(got.map((s) => `${s.engine}@${Math.round((Date.now() - s.lastActiveAt) / DAY)}d`))}`)
})

test('★★ 但近期活跃的引擎仍必须占位 —— 2026-08-01 那条不变量不能破', () => {
  // insight_v2 原场景：Kimi 更近，但 Claude 也在近期活跃 ⇒ 两个 Tab 都要在
  const rows = [
    mkE('insight_v2', 'kimi', 10, 1),
    mkE('insight_v2', 'kimi', 20, 2),
    mkE('insight_v2', 'claude', 60),
    ...Array.from({ length: 17 }, (_, k) => mkE(`p${k}`, 'claude', 120 + k)),
  ]
  const got = allocateSessions(rows, 20).sessions.filter((s) => s.project === 'insight_v2')
  assert.ok(got.some((s) => s.engine === 'claude'),
    'Claude 近期活跃却没露 —— 对话流 Tab 会整个消失（那正是 2026-08-01 要修的）')
  assert.ok(got.some((s) => s.engine === 'kimi'), 'Kimi 也要在')
})

test('★ 整个项目都是僵尸时仍露最新 1 条 —— 项目不能整个从看板消失', () => {
  // 「每个项目至少露 1 条」优先级高于任何引擎规则（用户确认）
  const rows = [
    mkE('zonggong', 'kimi', 52 * 24 * 60, 1),
    mkE('zonggong', 'codex', 60 * 24 * 60, 2),
    ...Array.from({ length: 19 }, (_, k) => mkE(`p${k}`, 'claude', 10 + k)),
  ]
  const got = allocateSessions(rows, 20).sessions.filter((s) => s.project === 'zonggong')
  assert.equal(got.length, 1, '僵尸项目仍应露最新 1 条')
  assert.equal(got[0].engine, 'kimi', '露的应是该项目最近的那条')
})

test('★ 时效门槛可注入 —— 便于测试与按机器调整，且缺 lastActiveAt 不炸', () => {
  const rows = [
    mkE('a', 'claude', 10, 1), mkE('a', 'claude', 20, 2),
    { id: 'a-kimi-x', project: 'a', engine: 'kimi', serverId: 'srv-a' }, // 无 lastActiveAt
    ...Array.from({ length: 19 }, (_, k) => mkE(`p${k}`, 'claude', 30 + k)),
  ]
  const got = allocateSessions(rows, 21, { engineFreshMs: 60_000 }).sessions.filter((s) => s.project === 'a')
  assert.ok(!got.some((s) => s.engine === 'kimi'), '无 lastActiveAt 视为极旧，不该占位')
})
