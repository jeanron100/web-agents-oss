// node --test server/kimi-usage.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseKimiUsage, kimiUsageCmd } from './kimi-usage.js'

// 真机实拍（.177-188, kimi-code 0.31.1, tmux capture-pane 原样）——含边框竖线与进度条方块。
const REAL = `
   ╭ Usage ──────────────────────────────────────────────────────────────╮
   │ Session usage                                                       │
   │   No token usage recorded yet.                                      │
   │                                                                     │
   │ Context window                                                      │
   │   ░░░░░░░░░░░░░░░░░░░░      0%  (0 / 256k)                          │
   │                                                                     │
   │ Plan usage                                                          │
   │   Weekly limit  ███░░░░░░░░░░░░░░░░░  14% used  resets in 5d 4h 42m │
   │   5h limit      ███░░░░░░░░░░░░░░░░░  13% used  resets in 1h 42m    │
   ╰─────────────────────────────────────────────────────────────────────╯
`

test('★ 从 TUI 边框里抠出周额度与 5h 额度', () => {
  const u = parseKimiUsage(REAL)
  assert.ok(u, '真机输出必须能解析')
  assert.equal(u.week.pct, 14)
  assert.equal(u.week.resets, '5d 4h 42m')
  assert.equal(u.session.pct, 13)
  assert.equal(u.session.resets, '1h 42m')
})

test('★ 不能把 Context window 的百分比误当成额度', () => {
  // Context 那行也有 `0%`，且排在 Plan usage 之前——只按 % 抓第一个必然抓错。
  const u = parseKimiUsage(REAL)
  assert.notEqual(u.week.pct, 0)
  assert.notEqual(u.session.pct, 0)
})

test('未登录 / 无 Plan usage 段 → null（调用方据此显示失败态，而不是 0%）', () => {
  assert.equal(parseKimiUsage('Please run `kimi login` first.'), null)
  assert.equal(parseKimiUsage(''), null)
  assert.equal(parseKimiUsage(null), null)
  assert.equal(parseKimiUsage('Session usage:\n- Context: 0 / 262,144 (0.0%)'), null, 'ACP 的 /usage 只有 context，不算额度')
})

test('只有其中一个窗口时也要能返回（上游随时可能砍掉某个窗口）', () => {
  // Codex 那边 OpenAI 就砍掉过 5h 窗；别假设两个窗口恒存在。
  const only = '│ Plan usage │\n│   Weekly limit  ██░░  7% used  resets in 2d 1h 5m │'
  const u = parseKimiUsage(only)
  assert.equal(u.week.pct, 7)
  assert.equal(u.session, null)
})

// 2026-09-27 真机实拍（kimi 2.1.1）：长窗从 Weekly 变成 **Monthly**，还多了
// `kimi 0% · code 3%` 这种不带 limit 的分解行——不得误抓。
const REAL_MONTHLY = `
   ╭ Usage ────────────────────────────────────────────────────────────────╮
   │ Plan usage                                                            │
   │   5h limit       ██░░░░░░░░░░░░░░░░░░  12% used  resets in 2h 29m     │
   │   Monthly limit  █░░░░░░░░░░░░░░░░░░░  3% used   resets in 29d 23h 3m │
   │                  kimi 0% · code 3%                                    │
   ╰───────────────────────────────────────────────────────────────────────╯
`

test('★ 上游把 Weekly 换成 Monthly 也要解析，并把真实标签带给前端', () => {
  const u = parseKimiUsage(REAL_MONTHLY)
  assert.ok(u, 'Monthly 形态必须能解析')
  assert.equal(u.session.pct, 12)
  assert.equal(u.session.resets, '2h 29m')
  assert.equal(u.week.pct, 3)
  assert.equal(u.week.resets, '29d 23h 3m')
  assert.equal(u.week.label, 'Monthly', '标签必须来自数据，不得写死 Weekly——前端据此显示 本周/本月')
})

test('★ Weekly 形态保留标签（上游哪天换回去也不用改代码）', () => {
  const u = parseKimiUsage(REAL)
  assert.equal(u.week.label, 'Weekly')
})

test('百分比与 resets 的空白/宽度变化不影响解析', () => {
  const t = 'Plan usage\n Weekly limit █  100% used  resets in 12m\n 5h limit ░   0% used   resets in 4h'
  const u = parseKimiUsage(t)
  assert.equal(u.week.pct, 100)
  assert.equal(u.week.resets, '12m')
  assert.equal(u.session.pct, 0)
  assert.equal(u.session.resets, '4h')
})

test('★ 发 /usage 前必须先 Escape——否则那个 Enter 会按在升级弹窗的「立即安装」上', () => {
  // kimi 0.31.0 启动弹升级菜单，默认高亮第一项 Install update now。
  // 原来直接 send-keys "/usage" Enter ⇒ /usage 从未执行（额度显示 —）+ 每次探测都触发自升级。
  // ⚠️ 断言必须对**引号转义免疫**：命令现在包在 `sh -c ${JSON.stringify(body)}` 里
  //    （R5 加硬超时的副作用），内层引号会变成 \"。用字面量匹配会假红。
  const cmd = kimiUsageCmd()
  const esc = cmd.search(/send-keys[^;]*Escape/)
  const usage = cmd.search(/send-keys[^;]*\/usage[^;]*Enter/)
  assert.ok(esc > 0, `必须有 Escape：${cmd.slice(0, 160)}`)
  assert.ok(usage > 0, `必须发 /usage：${cmd.slice(0, 160)}`)
  assert.ok(esc < usage, 'Escape 必须在 /usage 之前，否则等于没关弹窗')
})

// ───────── 2026-08-30 事故整改 R5：探针必须有最大执行时长 + 孤儿自杀 ─────────
//
// 事故实测：kimi-code 探针存活 **26.6 小时**，而它依赖的 tmux server 早就不存在了；
// exec 审计里另有一条 `dur=427968ms TIMEOUT`（428 秒，本该 22 秒）。
// ★ 根因是这条命令是 `;` 拼接的固定 sleep 链：**任何一步挂住，整条就一直往下拖**，
//   而 agent 侧的 `process.kill(-pid)` 打不到 tmux —— tmux 会 daemonize（PPID=1），
//   进程组杀法从来就没打中过它（CLAUDE.md 记过这条）。

test('★★ 整条命令必须有硬超时 —— 固定 sleep 链没有自然上界', () => {
  const c = kimiUsageCmd()
  assert.match(c, /\btimeout\s+\d+/, `没有 timeout：${c.slice(0, 120)}`)
})

test('★★ 开跑前先清掉上一轮的孤儿 server（26.6 小时那条就是这么留下的）', () => {
  const c = kimiUsageCmd()
  const killIdx = c.indexOf('kill-server')
  const newIdx = c.indexOf('new-session')
  assert.ok(killIdx >= 0 && killIdx < newIdx, '必须在 new-session 之前先 kill-server 清孤儿')
})

test('★★ 每个依赖 session 的步骤前都要确认它还在 —— 不在就立即退出，别继续睡', () => {
  const c = kimiUsageCmd()
  assert.match(c, /has-session/, '缺少 has-session 存活检查')
  // 检查必须能中断链条，而不是 `;` 继续走下去
  assert.match(c, /has-session[^;]*\|\|[^;]*exit/, '存活检查必须 || exit，否则检查了也不起作用')
})

test('★ 无论成功失败都要清理（trap），否则超时被杀时 tmux server 会留下来', () => {
  const c = kimiUsageCmd()
  assert.match(c, /trap[^;]*kill-server/, '缺少 trap 清理')
})

test('★ 超时值可配且必须大于内部 sleep 总和（否则永远超时，等于探针废掉）', () => {
  const c = kimiUsageCmd({ boot: 12, settle: 8 })
  const t = Number((/\btimeout\s+(\d+)/.exec(c) || [])[1])
  assert.ok(Number.isFinite(t), '超时值必须是数字')
  assert.ok(t > 12 + 2 + 8, `超时 ${t}s 小于内部 sleep 总和 22s，探针永远拿不到结果`)
})

test('★ 仍然产出可解析的输出（改造不能把功能改没）', () => {
  const c = kimiUsageCmd()
  assert.match(c, /capture-pane/)
  assert.match(c, /\/usage/)
})
