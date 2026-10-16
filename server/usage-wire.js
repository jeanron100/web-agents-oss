// server/usage-wire.js — 额度端点的出口形态。纯函数，无 I/O。
//
// ★ 起因（2026-09-11 用户提「查 usage 有时候慢」）：实测 hub 读缓存 **0.0006s**、
//   前端经跨境 0.64~1.54s，而 `claude --print /usage` 真探一次 **5.18s**（Kimi 约 20s）。
//   缓存命中时一点都不慢；慢只发生在**没有旧值**时——端点原先那句
//   `if (!usageLimits) await refreshUsageLimits()` 让请求**同步等探测跑完**。
//   代价不只是用户等：它占着一条跨境 HTTP 连接 5~20 秒，
//   而本仓库栽过「请求堆叠打满 keepalive 池」。
//
// ⇒ 改成 stale-while-revalidate：立刻返回手头有的，后台去刷。
//
// ★★ 但**只去掉阻塞会让体验更差**：前端 UsageRow 是 60 秒轮询一次，
//   用户会从「等 5 秒看到数字」变成「等 60 秒」。所以出口带 `pending`，
//   让前端知道"正在探、马上会有"，据此快速补拉一次。
//   **把阻塞去掉的同时必须给出回程**，否则只是把同步等待换成了更长的空窗
//   （同族纪律：「凡写降级路径，先问怎么回来」）。

/**
 * @param o.value   最近一次**成功**的结果；没有则 null
 * @param o.error   最近一次失败原因；null 表示上次是成功的
 * @param o.probing 此刻是否有一次探测在飞（决定要不要让前端快速补拉）
 * @param o.empty   该引擎的空形状（各引擎字段不同，不在这里硬编码）
 */
export function usageWire({ value = null, error = null, probing = false, empty = {} } = {}) {
  const base = value ?? empty
  // 有旧值：即便这次探失败也要把旧值给出去并标 stale —— 一片「—」比一个可能过期的数字更糟。
  if (value) return error ? { ...base, stale: true, error } : { ...base }
  // 没有旧值且失败：标 error/stale，但**不标 pending** —— pending 会触发前端补拉，
  // 而失败态下那是自我攻击（跨境链路只有 ~11KB/s，经不起无谓的快轮）。
  if (error) return { ...base, stale: true, error }
  // 没有旧值、正在探：告诉前端"马上会有"，让它几秒后补一次，而不是干等下一个 60s 周期。
  if (probing) return { ...base, pending: true }
  // 没有旧值、没在探、也没失败 = 冷却期内。此时标 pending 会让前端一直快轮，
  // 而服务端根本不会去探（USAGE_RETRY_MS 挡着）⇒ 纯空转。
  return { ...base }
}
