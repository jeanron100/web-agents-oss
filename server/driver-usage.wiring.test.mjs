// server/driver-usage.wiring.test.mjs — 平台会话的实时 token 也必须按 message.id 去重。
//
// ★ 为什么是**读源码断言**而不是跑真逻辑：driver.js 的这段挂在 @anthropic-ai/claude-agent-sdk
//   的消息流上，跑起来要真拉一个 Claude 会话（要 CLI、要额度、要几十秒）。本仓库已有同款手法
//   （web/src/styles/layout.test.ts、SessionDetail.wiring.test.ts）——纯函数测试证明不了
//   调用方在用它，而"接线掉了"恰恰是本仓库最常见的回归形态。
//
// ★★ 病根与 agent.js / archive-extract.js 完全相同：SDK 把一条 assistant 消息**按 content
//   block 逐条推**，每条都带**完整的 message 级 usage**（JSONL 里那 52.8% 的重复行就是它写的）。
//   逐条累加 ⇒ 平台会话卡片上的实时 token 同样虚高一倍。
//
// ⚠️ 这个修法对"SDK 其实只推一条"的情形是**无害的**：creditUsage 在 id 不重复时原样返回，
//   所以即使将来 SDK 改了行为，这里也不会算错——只会退化成今天的语义。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('./driver.js', import.meta.url), 'utf8')

test('★ driver 必须走 creditUsage，而不是把 usage 逐条裸加进 record.tok', () => {
  assert.match(SRC, /import \{[^}]*creditUsage[^}]*\} from '\.\/usage-dedupe\.js'/,
    'driver.js 必须引入共用的去重规则，别写第二份')
  assert.doesNotMatch(SRC, /record\.tok\.input\s*\+=\s*u\.input_tokens/,
    '裸加 = 同一条 message 的每个 block 都算一遍，token 虚高一倍')
  assert.doesNotMatch(SRC, /record\.tok\.cacheRead\s*\+=\s*u\.cache_read_input_tokens/,
    'cache 是四桶里最大的一桶，重复计它虚高最狠（实测单条 message 虚高 2.97 倍）')
  assert.match(SRC, /creditUsage\(/, '要真的调用它')
})

test('★ 去重表必须挂在 record 上 —— 挂在回合级变量上等于没去重', () => {
  // 同一条 message 的多个 block 是**跨多次 for-await 迭代**到达的。
  // 若 seen 表建在循环体里，每次迭代都是新表，去重永远命中不了。
  const m = SRC.match(/creditUsage\(([^,]+),/)
  assert.ok(m, '应能找到 creditUsage 调用')
  assert.match(m[1], /record\./,
    `去重表要从 record 上取（当前传的是 ${m[1].trim()}），才能跨 block 行存活；` +
    '传一个函数内的局部变量 = 每轮迭代都是新表，去重永远命中不了')
})
