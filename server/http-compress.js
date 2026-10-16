// server/http-compress.js — JSON 响应的 gzip 出口（2026-08-01 跨境链路优化）
//
// 背景：hub 自 2026-07-19 迁到 189.4，浏览器经 62.234 网关跨境访问，实测这条链路只有
// ~25KB/s。前端每 3s 轮一次 /api/state，实测 **79KB 明文** ⇒ 单次就要 3.1 秒，轮询周期
// 才 3 秒——链路按定义就是饱和的，于是「与服务器失联」横幅此起彼伏、还伴随 502。
//
// 为什么之前没压：网关 conf 里有句注释说「gzip 后 30KB」，但那是**假设，不是事实**——
// 该文件没有任何 gzip 指令，而 nginx 对代理响应默认 `gzip_proxied off`（不压）；上游 hub
// 是裸 node http，带 `Accept-Encoding: gzip` 请求实测照样回 79340 字节明文。三层都没人压。
//
// 实测压缩比（真实 /api/state 载荷）：79KB → 24KB（省 69%），跨境耗时 3.10s → 0.98s。
// 压在 hub 自己身上而不是 nginx：不依赖那台网关机的配置（它不在本仓库管辖内），
// 且对所有消费方（PWA / MCP / curl）一致生效。

const MIN_BYTES = 1024 // 小响应压了反而更大（gzip 头 ~20B）+ 白烧 CPU，1KB 以下直接不压

/**
 * 客户端是否真的接受 gzip。
 * ⚠️ 必须处理 `gzip;q=0`——按 RFC 7231 那是**明确拒绝**，可 `includes('gzip')` 会判成接受，
 * 于是给一个说了「我不要」的客户端发压缩体，它只能解出乱码。这类实现 bug 很常见。
 */
export function acceptsGzip(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return false
  for (const part of headerValue.split(',')) {
    const [coding, ...params] = part.trim().split(';')
    if (coding.trim().toLowerCase() !== 'gzip') continue
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='))
    if (!q) return true
    return Number(q.slice(2)) > 0
  }
  return false
}

/** 够大才值得压。 */
export function shouldCompress(byteLength, minBytes = MIN_BYTES) {
  return Number.isFinite(byteLength) && byteLength >= minBytes
}

export { MIN_BYTES }
