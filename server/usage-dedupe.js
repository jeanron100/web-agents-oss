// server/usage-dedupe.js — assistant token 按 message.id 去重（2026-09-05）。纯函数，无 I/O。
//
// ★★ 病根：Claude Code 把一条 assistant 消息**按 content block 拆成多行 JSONL**，
//   而**每一行都带完整的 message 级 usage**（同一个 requestId、同一个 message.id）。
//   实物（agent-a4becc1504ad74d15.jsonl 的 msg_011CeBycEjS3TmQQyvvS2tXH）：
//     行5 text     stop_reason=null      output=1    cache_read=4452 cache_create=16074
//     行6 tool_use stop_reason=null      output=1    cache_read=4452 cache_create=16074
//     行8 tool_use stop_reason=tool_use  output=374  cache_read=4452 cache_create=16074
//   `agent.js` 原先逐行无条件累加 ⇒ 那 20,526 个 cache token 被算了 3 遍。
//   全量实扫 1,484 个 transcript：**token 308.6 亿 → 145.7 亿，虚高 52.8%**。
//
// ★ 规则是「按分量取历史最大值，只补差额」，而不是下面这三个想当然的修法
//   （每一个都被实测数据当场否掉，别再走回去，理由见 usage-dedupe.test.mjs 文件头）：
//     ① 保留第一条        → 少算最终 output（1 vs 374）
//     ② 只数终结行        → 25,060 组有 ≥2 个终结行、1,001 组一个都没有 ⇒ 等于没修
//     ③ 只记住上一条 id   → 有约 390 处重复间隔达 775 条 message（fork 重放）
//
// ⚠️ 为什么取 max 而不是"后来居上"直接覆盖：实测 43,327 组里有 1 组分量**非单调下降**
//   （同 id 不同内容的重放）。做减法会得到负 token，而负数在日/时曲线上是没法解释的脏数据。

/** `Number(null)===0` 的老坑：这里语义上确实要把缺失当 0，所以显式收敛，别让 NaN 漏进累加器。 */
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })

/**
 * 记账一行 assistant 的 usage，返回**本行应当计入累加器的增量**。
 *
 * @param {object} seen  message.id -> [input, output, cacheRead, cacheCreate] 已计入的历史最大值。
 *                       就地更新；必须可 JSON 往返（它要跟着 summary 进检查点）。
 * @param {string} id    d.message.id
 * @param {object} usage d.message.usage
 * @returns {{input:number,output:number,cacheRead:number,cacheCreate:number}} 增量，恒非负
 */
export function creditUsage(seen, id, usage) {
  const cur = [
    n(usage?.input_tokens), n(usage?.output_tokens),
    n(usage?.cache_read_input_tokens), n(usage?.cache_creation_input_tokens),
  ]
  // 没有 id 就无从去重。此时**照单全收**：宁可维持今天的行为，也不能整行丢掉——
  // 少算比多算更难发现（多算至少数字扎眼，少算看起来一切正常）。
  if (!id || !seen || typeof seen !== 'object') {
    return { input: cur[0], output: cur[1], cacheRead: cur[2], cacheCreate: cur[3] }
  }

  const prev = Array.isArray(seen[id]) ? seen[id] : null
  if (!prev) {
    seen[id] = cur
    return { input: cur[0], output: cur[1], cacheRead: cur[2], cacheCreate: cur[3] }
  }

  const d = ZERO()
  const keys = ['input', 'output', 'cacheRead', 'cacheCreate']
  for (let i = 0; i < 4; i++) {
    const was = n(prev[i])
    if (cur[i] > was) { d[keys[i]] = cur[i] - was; prev[i] = cur[i] }
  }
  return d
}

/**
 * 落盘前裁剪：只保留**最近** max 条。
 *
 * 内存里刻意不设上限（实测每会话 distinct message.id 中位 6、p95 46、最大 3,476，
 * 全留也就几百 KB），但检查点是**按项目分片的磁盘文件**，不能让单个长会话把分片撑爆。
 * 磁盘那份只服务一种情形：agent 重启时恰好有一条 message 的 block 行被截断在 offset 两侧。
 * 那必然是**最近**的几条，所以留最近的即可；漏掉的代价上限是"每次重启多算一条 message"。
 */
export function trimSeen(seen, max = 64) {
  if (!seen || typeof seen !== 'object') return {}
  const keys = Object.keys(seen)
  if (keys.length <= max) return seen
  const out = {}
  for (const k of keys.slice(keys.length - max)) out[k] = seen[k]
  return out
}
