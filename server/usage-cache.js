// 额度值的 Redis 缓存：stale-while-revalidate。
//
// 为什么需要：hub 原先只有**进程内节流**（usageLastTry/usageLimits 存内存），
// 一重启缓存清零 → 多个 usage 端点 × 多台服务器同时回源重探。而每次探测都是重活：
// Kimi 要起 tmux + 跑 CLI + 等 TUI 渲染（实测得给 90s 超时），Claude 走 /api/exec 跑 CLI。
// 额度本来就不是实时量（Codex 是**周窗**，一周才走完一轮），按秒轮询毫无意义。
//
// ⚠️ 红线：Redis 只能是**缓存层——丢了只是变慢，不能变不可用**。它单点跑在 189.4。
// 刚把 Mongo 从「阻塞就 502」的坑里捞出来，别再造第二个。落到代码就是两条硬约束：
//   ① load() 任何异常都塌成 null（miss 即回退原有探测路径）
//   ② save() **同步返回 undefined**——调用方拿不到 promise，就不可能 await 它、
//      也就不可能让缓存写入卡住请求路径。内部异常自吞，绝不冒泡成未捕获拒绝。
import * as redis from './redis.js'

/** 超过这个年龄就在后台刷新——但**仍然把旧值给出去**。 */
export const REFRESH_MS = Number(process.env.WA_USAGE_REFRESH_MS) || 10 * 60_000
/** Redis 里的留存期。给得远大于 REFRESH_MS：**过期 ≠ 不可用**，只是意味着"该刷了"。 */
export const TTL_SEC = Number(process.env.WA_USAGE_TTL_SEC) || 86_400

const keyOf = (engine) => `wa:usage:${engine}`

/**
 * 给定缓存与当前时间，决定「给什么」和「要不要刷」。纯函数，便于测。
 * 最重要的性质：**过期也给值**。前端拿到带 ts 的旧值可以显示"数据时间"，
 * 那比转圈或报错诚实得多——额度本就不是实时量。
 */
export function decide({ cached, now, refreshMs = REFRESH_MS }) {
  const ok = cached && typeof cached === 'object' && typeof cached.ts === 'number' && Number.isFinite(cached.ts)
  if (!ok) return { serve: null, refresh: true, stale: false }
  const age = now - cached.ts
  // age < 0 = 时钟回拨或跨机时钟不齐。仍然给值（服务优先），但标记为该刷新。
  const needsRefresh = age < 0 || age >= refreshMs
  return { serve: cached, refresh: needsRefresh, stale: needsRefresh }
}

/** 读缓存。**任何失败都返回 null**（当 miss），绝不把异常抛进请求路径。 */
export async function load(engine, { client = redis.getClient } = {}) {
  try {
    const c = await client()
    if (!c) return null
    const raw = await c.get(keyOf(engine))
    if (!raw) return null
    const o = JSON.parse(raw)
    return o && typeof o === 'object' && typeof o.ts === 'number' ? o : null
  } catch {
    return null // redis 挂了/连不上/脏数据 —— 一律当没缓存，回退原路径
  }
}

/**
 * 写缓存，fire-and-forget。
 * **必须同步返回 undefined**：调用方拿不到 promise 就无从 await，
 * 结构上杜绝了「缓存写入拖慢请求」这种失败模式（而不是靠约定/注释提醒）。
 */
export function save(engine, value, { client = redis.getClient, ttlSec = TTL_SEC, now = Date.now } = {}) {
  ;(async () => {
    try {
      const c = await client()
      if (!c) return
      await c.set(keyOf(engine), JSON.stringify({ ...value, ts: now() }), { EX: ttlSec })
    } catch { /* 缓存写失败无所谓，下次再写；绝不冒泡 */ }
  })()
}
