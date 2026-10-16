// server/replay-backoff.js — spool 重放的指数退避闸门（2026-08-01 拥塞崩溃事故）
//
// 事故机理（实测，非推测）：Mongo 走跨境公网隧道（81.70，全新连接实测仅 ~3Mbps/376KB/s），
// spool 攒到 102MB/151k 条后，replaySpool() 每轮都 readAll() 整份读出、一次性 upsert，
// 失败又整份落回，下一轮再来。内核 TCP 统计：
//     cwnd:1  ssthresh:2  bytes_retrans:67.7MB / bytes_sent:655MB (10.3%)  send 188Kbps
// 也就是**我们自己的重试把拥塞窗口打崩到 1 个报文段**，往返从 61ms 涨到 2~5s，超过
// serverSelectionTimeoutMS(5000) ⇒ 判定 Mongo down ⇒ 新事件继续落 spool ⇒ 重试压力更大。
// 同机其他四条隧道都在 10.7.x 内网（cwnd 37~474、重传 ~0%、200+Mbps），唯独这条走公网。
//
// 两个断点缺一不可：① 单次重放限批（见 event-repository.replaySpool）——别再整份砸；
// ② 失败后指数退避（本文件）——别用重试把链路持续焊死。

export const BASE_MS = 30_000        // 首次失败后等 30s
export const MAX_MS = 10 * 60_000    // 上限 10 分钟

/**
 * 连续失败 n 次后，下次重放前应等待多久。
 * n=0（刚成功过 / 从未失败）⇒ 0，即按投影本身的节奏走，不额外等。
 */
export function nextDelayMs(failures) {
  const n = Number(failures)
  if (!Number.isFinite(n) || n <= 0) return 0
  // 2^(n-1) 倍 BASE：1→30s, 2→1m, 3→2m, 4→4m, 5→8m, 6+→封顶 10m
  const d = BASE_MS * 2 ** (n - 1)
  return Number.isFinite(d) ? Math.min(d, MAX_MS) : MAX_MS
}

/**
 * 这一拍能不能试。
 * ⚠️ fail-safe 方向必须是**放行**：输入异常（NaN/负数）时宁可多试一次，也绝不能算成
 * 「永不放行」——那等于把恢复路径彻底堵死，比原 bug 更糟（本项目已有「闸门被焊死」的前科）。
 */
export function shouldAttempt({ failures = 0, lastAttemptAt = 0, now = Date.now() } = {}) {
  const delay = nextDelayMs(failures)
  if (delay <= 0) return true
  const last = Number(lastAttemptAt)
  const t = Number(now)
  if (!Number.isFinite(last) || !Number.isFinite(t)) return true
  return t - last >= delay
}
