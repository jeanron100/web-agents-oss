// server/usage-dedupe.test.mjs — assistant token 按 message.id 去重（2026-09-05）。
//
// ★★ 为什么存在：Claude Code 把一条 assistant 消息**按 content block 拆成多行 JSONL**，
//   而**每一行都带完整的 message 级 usage**。`agent.js` 原先只判 `type==='assistant'`
//   就无条件累加 ⇒ 同一批 token 被算 2~7 遍。
//
//   实扫 .232 的 1,484 个 transcript（与生产同款过滤条件）：
//     95,128 条 assistant 行里 **51,844 行（54.5%）是重复 message.id**
//     token 308.6 亿 → 去重后 145.7 亿，**虚高 52.8%**
//   看板上的 token、成本、每日/每小时曲线、Token 构成图全部按这个数在画。
//
// ★ 三条被实测否掉的"想当然修法"，测试逐条钉住，别再走回去：
//   ① 「保留第一条」——**会少算**。流式过程中每行带的是当时的 usage，
//      同一条 message 的三行 output_tokens 是 1 → 1 → 374。取首次比真值少 742 万 token。
//   ② 「只数 stop_reason 非 null 的终结行」——**无状态但不成立**。43,318 组里
//      25,060 组有 ≥2 个非 null 终结行、1,001 组一个都没有；照此得 300.7 亿≈没修。
//   ③ 「只记住上一条 id（重复必相邻）」——**不够**。99.2% 相邻，但有约 390 处
//      间隔最远达 775 条 message（转录被 fork 后整段重放），只按相邻去重仍虚高 4.7%。

import test from 'node:test'
import assert from 'node:assert/strict'
import { creditUsage, trimSeen } from './usage-dedupe.js'

/** 生产 JSONL 里的 usage 对象形状。 */
const u = (input, output, cacheRead, cacheCreate) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
})
const sum = (d) => d.input + d.output + d.cacheRead + d.cacheCreate

test('★ 真实事故样本：一条 message 拆成 3 行，cache 那 20,526 token 只能算一遍', () => {
  // 取自 -data-cli2api-gateway/.../agent-a4becc1504ad74d15.jsonl 的 msg_011CeBycEjS3TmQQyvvS2tXH
  // 第 5 行 text 块、第 6 行 tool_use 块、第 8 行 tool_use 块（stop_reason=tool_use，output 才是最终值）
  const seen = {}
  const id = 'msg_011CeBycEjS3TmQQyvvS2tXH'
  const a = creditUsage(seen, id, u(2, 1, 4452, 16074))
  const b = creditUsage(seen, id, u(2, 1, 4452, 16074))
  const c = creditUsage(seen, id, u(2, 374, 4452, 16074))

  assert.equal(sum(a), 2 + 1 + 4452 + 16074, '第一行照单全收')
  assert.deepEqual(b, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, '完全重复的行必须补 0')
  assert.deepEqual(c, { input: 0, output: 373, cacheRead: 0, cacheCreate: 0 },
    'output 从 1 涨到 374 ⇒ 只补差额 373，cache 不能再算一遍')

  // 三行加总必须等于这条 message 的真实用量，而不是 3 倍
  assert.equal(sum(a) + sum(b) + sum(c), 2 + 374 + 4452 + 16074)
})

test('★ 「保留第一条」是错的：最终 output 必须补上，否则少算', () => {
  const seen = {}
  const total = [u(2, 1, 4452, 16074), u(2, 374, 4452, 16074)]
    .reduce((n, x) => n + sum(creditUsage(seen, 'm1', x)), 0)
  // 保留第一条会得到 20529；正确值含最终 output 374
  assert.equal(total, 20902)
})

test('★ 重复不必相邻：中间隔着几百条别的 message 也要认出来（fork 重放）', () => {
  const seen = {}
  creditUsage(seen, 'far', u(10, 20, 30, 40))
  for (let i = 0; i < 500; i++) creditUsage(seen, `mid${i}`, u(1, 1, 1, 1))
  const again = creditUsage(seen, 'far', u(10, 20, 30, 40))
  assert.deepEqual(again, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
})

test('分量回退（同 id 但值变小）补 0，绝不产生负数', () => {
  // 实测 43,327 组里有 1 组 input/cacheRead/cacheCreate **非单调**下降（同 id 不同内容的重放）。
  // 所以规则是"按分量取 max"，不能假设单调递增去做减法。
  const seen = {}
  creditUsage(seen, 'x', u(100, 100, 100, 100))
  const back = creditUsage(seen, 'x', u(5, 5, 5, 5))
  assert.deepEqual(back, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
  // 回退过后再涨回来，只补相对**历史最大值**的差额
  assert.deepEqual(creditUsage(seen, 'x', u(100, 130, 100, 100)),
    { input: 0, output: 30, cacheRead: 0, cacheCreate: 0 })
})

test('没有 message.id 的行照单全收 —— 无从去重时宁可维持原状，不能整条丢掉', () => {
  const seen = {}
  assert.equal(sum(creditUsage(seen, null, u(1, 2, 3, 4))), 10)
  assert.equal(sum(creditUsage(seen, undefined, u(1, 2, 3, 4))), 10)
  assert.equal(sum(creditUsage(seen, '', u(1, 2, 3, 4))), 10)
})

test('缺字段按 0 计，不产生 NaN', () => {
  const seen = {}
  const d = creditUsage(seen, 'n', { output_tokens: 7 })
  assert.deepEqual(d, { input: 0, output: 7, cacheRead: 0, cacheCreate: 0 })
  assert.equal(sum(creditUsage(seen, 'n2', {})), 0)
  assert.equal(sum(creditUsage(seen, 'n3', null)), 0)
})

test('★ 首次出现要真的记进 seen —— 否则跨轮增量续扫会重新全额计一遍', () => {
  const seen = {}
  creditUsage(seen, 'k', u(1, 2, 3, 4))
  // seen 必须可序列化后原样恢复（它要跟着 summary 进检查点）
  const revived = JSON.parse(JSON.stringify(seen))
  assert.deepEqual(creditUsage(revived, 'k', u(1, 2, 3, 4)),
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
})

test('★ trimSeen 落盘只留最近 N 条 —— 但留的必须是**最近**的，不是任意的', () => {
  // 内存里不设上限（实测每会话 distinct id 中位 6、p95 46、最大 3,476），
  // 但检查点是按项目分片的磁盘文件，不能让单个会话把分片撑爆。
  // 只有"跨 agent 重启恰好被截断的那条 message"依赖它，所以留最近的即可。
  const seen = {}
  for (let i = 0; i < 100; i++) creditUsage(seen, `m${i}`, u(1, 1, 1, 1))
  const t = trimSeen(seen, 10)
  assert.equal(Object.keys(t).length, 10)
  assert.deepEqual(Object.keys(t), Array.from({ length: 10 }, (_, i) => `m${90 + i}`))
  // 没超上限时原样返回
  assert.deepEqual(Object.keys(trimSeen({ a: [1, 1, 1, 1] }, 10)), ['a'])
})
