// server/sse-gzip.js — 对话流 SSE 的 gzip 出口（2026-08-21）
//
// 为什么要有这个文件：对话流首屏由 SSE **第一帧**决定（`\n\n` 没到齐，浏览器不触发
// onmessage）。线上首帧 **90,746 B 明文**，跨境实测 6.7~20.1s——用户报的「加载消息要 5-10 秒」
// 就是它。分段计时把范围钉死了：agent 直连 0.00s、hub 经隧道 0.01s、跨境 9.2s。
// 后端算得出也发得出，全部时间在跨境那一段，而那段的实测吞吐只有 ~11KB/s。
//
// ★ 2026-08-01 的「跨境链路不压缩」修复（commit 85c4eef）为什么没覆盖到这里：
//   那次压的是 hub 的 `json()` 出口（/api/state 79KB→24KB、3.10s→0.98s）。而 SSE
//   **不走 json()**——它是 hub 逐字节 `res.write(value)` 透传的流，`writeHead` 里四个固定头；
//   nginx 侧 `gzip_types` 也没有 `text/event-stream`，且响应带 `Cache-Control: no-transform`。
//   三层都没人压，而它恰恰是**最大的那个 payload**（91KB > 79KB）。
//   教训：修了一类问题里的一个实例，要顺手把这一类扫一遍——尤其是"同一诊断、不同出口"。
//
// ★★ 唯一容易搞砸的地方是 **flush**。gzip 天生攒够缓冲区才吐，不 flush 的话逐字流式会
//    退化成「憋一大坨再一次性出现」——比慢更糟，而且**功能全对、常规测试全绿**。
//    所以每写一帧就 `Z_SYNC_FLUSH`，并由 `sse-gzip.test.mjs` 专门盯着这条。
//
// 压在 hub 而不是 agent：只需发一台（.189.4），不用动 5 台 agent；也不依赖网关机的配置。

import zlib from 'node:zlib'
import { acceptsGzip } from './http-compress.js'

/**
 * 只有显式 `"0"` 关闭。拼错成 `flase` 保持启用——**静默降级比不工作更糟**：
 * 功能全对、只是又慢回去了，一条错都不报。与 `deltaEnabled` / `incrementalEnabled` 同口径。
 */
export function sseGzipEnabled(env = process.env) {
  return env.WA_SSE_GZIP !== '0'
}

const BASE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform 保留：它挡的是**中间层再改一次编码**（会破坏我们自己压好的体），
  // 与「我们自己压」不冲突。X-Accel-Buffering 同理，禁的是代理攒包。
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/**
 * 建一个 SSE 出口。客户端不接受 gzip 时是**明文直通**（零开销、零行为变化）。
 *
 * @param res 目标可写端（只用到 write/end，便于单测替身）
 * @param accepts 客户端是否接受 gzip（由 acceptsGzip(req) 算好传进来）
 * @returns {{encoding:string|null, headers:()=>object, write:(s)=>Promise<void>, end:()=>Promise<void>}}
 */
export function createSseSink(res, { accepts = false, level = 6 } = {}) {
  // 断开保护对两条路径一视同仁：客户端切页/断网是**每天必然发生**的常态，
  // 往已销毁的 res 写会抛 ERR_STREAM_DESTROYED，而调用点在事件回调里 = 未捕获异常。
  const alive = () => !res.destroyed && !res.writableEnded
  const safe = (fn) => { if (!alive()) return; try { fn() } catch { /* 客户端已断开 */ } }

  if (!accepts) {
    return {
      encoding: null,
      headers: () => ({ ...BASE_HEADERS }),
      write: (s) => { safe(() => res.write(s)); return Promise.resolve() },
      end: () => { safe(() => res.end()); return Promise.resolve() },
    }
  }
  const gz = zlib.createGzip({ level })
  // 客户端随时可能断开（切页/杀进程/网络断）。往已销毁的 res 写会抛 ERR_STREAM_DESTROYED，
  // 而这里是 'data' 事件回调——抛出去就是未捕获异常，**能把整个 hub 带走**。
  gz.on('data', (c) => safe(() => res.write(c)))
  return {
    encoding: 'gzip',
    headers: () => ({ ...BASE_HEADERS, 'Content-Encoding': 'gzip' }),
    /** 写一帧并**立刻 flush** —— 少了这一步，逐字流式就没了（见文件头 ★★）。 */
    write: (s) => new Promise((resolve) => {
      gz.write(s, () => gz.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()))
    }),
    // ⚠️ 必须等**可读端** 'end'，不能只等 gz.end() 的写回调：写回调在 writable 侧完成时
    //    就触发，而最后一块 deflate 输出和 gzip 尾部（CRC + 长度）是随后才 emit 的 'data'。
    //    只等写回调就会在 res.end() 之后才吐尾部 ⇒ 客户端拿到截断的 gzip 流
    //    （单测「gzip 后内容逐字节等于明文」实测报 Z_BUF_ERROR: unexpected end of file）。
    end: () => new Promise((resolve) => {
      gz.on('end', () => { safe(() => res.end()); resolve() })
      gz.end()
    }),
  }
}

/** 便捷入口：从请求头直接判定本次是否压缩。 */
export function sinkFor(req, res, env = process.env) {
  return createSseSink(res, {
    accepts: sseGzipEnabled(env) && acceptsGzip(req.headers?.['accept-encoding']),
  })
}
