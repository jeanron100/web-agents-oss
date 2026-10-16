// 订阅额度探测：解析 + 编排的单测。
// 夹具全部是**真实抓到的输出**（2026-07-26 从 .232 / .189.4 实测），不是手编的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUsage, runUsageProbe, DEFAULT_USAGE_CMD, DEFAULT_USAGE_SERVER, USAGE_PROBE_CWD } from './usage-limits.js'

// .232 (claude 2.1.220, 已登录) 实际输出
const OK_TXT = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Jul 27, 12:09am (Asia/Tokyo)
Current week (all models): 29% used · resets Jul 30, 12pm (Asia/Tokyo)
Current week (Fable): 0% used

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1159 requests · 52 sessions
  86% of your usage was at >150k context
`

// 历史格式（本改动前线上就是按这个写的正则），必须不回归
const LEGACY_TXT = `Current session: 14% used · resets Jun 27, 4:39pm (Asia/Shanghai)
Current week (all models): 13% used · resets Jul 2, 10:59am (Asia/Shanghai)
Current week (Sonnet only): 0% used · resets Jul 2, 10:59am (Asia/Shanghai)
`

// .189.4 未登录时的实际输出（注意：**不报错、退出码 0**，这正是它能静默坏 18 小时的原因）
const NOT_LOGGED_IN_TXT = 'Not logged in · Please run /login\n'

// .189.4 带完整 env 时的实际输出：一段 cost 摘要，完全没有百分比
const COST_ONLY_TXT = `Total cost:            $0.0000
Total duration (API):  0s
Total duration (wall): 1s
Total code changes:    0 lines added, 0 lines removed
Usage:                 0 input, 0 output, 0 cache read, 0 cache write
`

test('parseUsage：解析真实输出的三段百分比', () => {
  const u = parseUsage(OK_TXT)
  assert.equal(u.session.pct, 5)
  assert.match(u.session.resets, /^Jul 27, 12:09am/)
  assert.equal(u.week.pct, 29)
  assert.match(u.week.resets, /^Jul 30, 12pm/)
  assert.equal(u.weekSonnet.pct, 0)
})

test('parseUsage：第三行的模型名要捕获出来（官方已从 Sonnet 改成 Fable）', () => {
  assert.equal(parseUsage(OK_TXT).weekSonnet.model, 'Fable')
})

test('parseUsage：历史 "Sonnet only" 格式不回归，且去掉 only 后缀', () => {
  const u = parseUsage(LEGACY_TXT)
  assert.equal(u.weekSonnet.pct, 0)
  assert.equal(u.weekSonnet.model, 'Sonnet')
  assert.equal(u.session.pct, 14)
})

test('parseUsage：第三行不能把 "all models" 那行误当成模型行', () => {
  const u = parseUsage(OK_TXT)
  assert.notEqual(u.weekSonnet.model, 'all models')
  assert.equal(u.week.pct, 29)   // all models 仍归到 week
})

test('parseUsage：未登录 / 只有 cost 摘要 / 空串 → null（不能瞎解析出 0%）', () => {
  assert.equal(parseUsage(NOT_LOGGED_IN_TXT), null)
  assert.equal(parseUsage(COST_ONLY_TXT), null)
  assert.equal(parseUsage(''), null)
  assert.equal(parseUsage(null), null)
})

test('runUsageProbe：成功时返回解析结果，ok=true', async () => {
  const r = await runUsageProbe({ exec: async () => OK_TXT })
  assert.equal(r.ok, true)
  assert.equal(r.data.week.pct, 29)
  assert.equal(r.error, undefined)
})

test('runUsageProbe：未登录要给出人能看懂的原因，而不是静默 null', async () => {
  const r = await runUsageProbe({ exec: async () => NOT_LOGGED_IN_TXT })
  assert.equal(r.ok, false)
  assert.match(r.error, /未登录/)
})

test('runUsageProbe：exec 抛异常时不能把异常吞掉', async () => {
  const r = await runUsageProbe({ exec: async () => { throw new Error('agent 不可达') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /agent 不可达/)
})

test('runUsageProbe：无输出也要报错（别当成解析失败糊过去）', async () => {
  const r = await runUsageProbe({ exec: async () => '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /无输出/)
})

test('default quota sampling is opt-in and resolves the CLI on the execution node', () => {
  // agent 的 systemd 环境里没有 HOME，裸 `claude` 会 command not found（实测踩过）
  assert.equal(DEFAULT_USAGE_SERVER, '')
  assert(!DEFAULT_USAGE_CMD.includes('HOME=/root'))
  // 2026-08-20：命令前面加了 `cd` 到专用 scratch 目录，所以不再是串首（原断言写死了 `^`）。
  // 意图不变——HOME 与绝对路径仍必须自带，只是位置移到了 `&&` 之后。
  assert.match(DEFAULT_USAGE_CMD, /command -v claude/)
  assert.match(DEFAULT_USAGE_CMD, /< \/dev\/null/)   // 省掉 claude 的 3s stdin 等待
})

test('★ 探针必须固定 cwd 到专用 scratch 目录，不得污染真实项目树', () => {
  // 为什么（2026-08-20 用户发现）：Claude Code 按 **cwd** 编码，把每一次 `--print` 调用
  // 都当成一个会话完整落盘到 `~/.claude/projects/<编码 cwd>/`，约 11KB/次。
  // 本探针 5 分钟一次 = 288 次/天 ⇒ .232 的 `-root` 目录 26 天攒了 8,195 个文件 / 146MB，
  // 而那台磁盘已到 94%。这些记录**没有任何人读**，我们只要 stdout 里的百分比。
  // ⇒ 固定 cwd 的好处是：那个目录在语义上**只可能**装探针残留，可整目录安全清空；
  //   而 `-root` 里混着真实交互会话（实测 8197 个里正好有 2 个是），在那儿清理永远
  //   要先逐个判内容，迟早误删。配套清理见 server/usage-probe-guard.sh。
  assert.equal(USAGE_PROBE_CWD, '/tmp/wa-usage-probe')
  assert.match(DEFAULT_USAGE_CMD, new RegExp(`cd ${USAGE_PROBE_CWD}`))
  assert.match(DEFAULT_USAGE_CMD, new RegExp(`mkdir -p ${USAGE_PROBE_CWD}`), '目录可能被 /tmp 清理，必须每次确保存在')
})

// ── 2026-09-08：resets 字符串的显示抖动 ────────────────────────────────────────
// 实测 .189.4 上近两日 417 个采样点里，同一个重置时刻被上游写成两种形式：
//   "Sep 10, 11:59am (Asia/Tokyo)" 113 次 / "Sep 10, 12pm (Asia/Tokyo)" 304 次
// 二者相差 1 分钟，指的是同一个窗口边界。
// ★ 危害不在显示，在**任何按窗口分组的逻辑**：拿 resets 当窗口标识时，
//   这个抖动会把一个窗口切成几十段。我自己排查时就被它骗过一次
//   （先按 resets 变化判"真重置"，得出的结论完全是错的）。
test('★ resets 归一：11:59am 与 12pm 是同一个窗口边界，必须收敛成一个值', () => {
  const mk = (r) => `Current week (all models): 61% used · resets ${r}`
  const a = parseUsage(mk('Sep 10, 11:59am (Asia/Tokyo)')).week.resets
  const b = parseUsage(mk('Sep 10, 12pm (Asia/Tokyo)')).week.resets
  assert.equal(a, b, `两种写法必须归一，实际 "${a}" vs "${b}"`)
})

test('归一不能误伤真正不同的时刻', () => {
  const mk = (r) => `Current week (all models): 61% used · resets ${r}`
  const p = (r) => parseUsage(mk(r)).week.resets
  assert.notEqual(p('Sep 10, 12pm (Asia/Tokyo)'), p('Sep 11, 12pm (Asia/Tokyo)'), '日期不同不能归一')
  assert.notEqual(p('Sep 10, 12pm (Asia/Tokyo)'), p('Sep 10, 3pm (Asia/Tokyo)'), '小时不同不能归一')
  assert.notEqual(p('Sep 10, 11:59am (Asia/Tokyo)'), p('Sep 10, 11:59am (Asia/Shanghai)'), '时区不同不能归一')
  // 11:59pm 是午夜前一分钟，和 12am(次日零点) 是同一边界的两种写法
  assert.equal(p('Sep 10, 11:59pm (Asia/Tokyo)'), p('Sep 11, 12am (Asia/Tokyo)'), '跨日那对也要归一')
})
