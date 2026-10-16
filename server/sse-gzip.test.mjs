// SSE 流的 gzip 出口 —— 回归测试。
//
// 背景（2026-08-21 实测）：对话流首屏由 SSE 第一帧决定（`\n\n` 没到齐浏览器不触发
// onmessage）。首帧 **90,746 B 明文**，跨境实测 6.7~20.1s，用户报「加载要 5-10 秒」。
// 分段计时证明后端只花 0.01s，全部时间在跨境那一段。
//
// ★ 为什么 2026-08-01 的「跨境链路不压缩」修复没覆盖到这里：那次压的是 hub 的 `json()`
//   出口（/api/state 79KB→24KB），而 SSE **不走 json()**——它是 hub 逐字节透传的流，
//   `writeHead` 里四个固定头，还显式带了 `Cache-Control: no-transform`（禁止中间层改编码），
//   nginx 的 gzip_types 也没有 text/event-stream。三层都没人压，而它恰恰是最大的那个 payload。
//   **修了一类里的一个实例，没把这一类扫干净。**
//
// ★★ 本文件最要紧的一条是「每帧必须 flush」。gzip 天生会攒缓冲区再吐，
//    不 flush 的话逐字流式会退化成「憋一大坨再一次性出现」——那比慢更糟，
//    而且**功能全对、测试全绿**，只有专门盯 flush 的测试会红。

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { acceptsGzip } from './http-compress.js'
import { sseGzipEnabled, createSseSink } from './sse-gzip.js'

const frame = (n) => `id: seq-${n}\ndata: ${JSON.stringify({ n, text: 'x'.repeat(200) })}\n\n`

/** 收集 sink 写出的字节 */
function collector() {
  const chunks = []
  return {
    res: { write: (c) => { chunks.push(Buffer.from(c)); return true }, end: () => {} },
    bytes: () => Buffer.concat(chunks),
  }
}

test('开关：只有显式 "0" 关闭，拼错不得静默降级', () => {
  assert.equal(sseGzipEnabled({}), true)
  assert.equal(sseGzipEnabled({ WA_SSE_GZIP: '1' }), true)
  assert.equal(sseGzipEnabled({ WA_SSE_GZIP: 'flase' }), true)   // 拼错 = 保持启用
  assert.equal(sseGzipEnabled({ WA_SSE_GZIP: '0' }), false)
})

test('客户端不接受 gzip 时必须明文直通', () => {
  const c = collector()
  const sink = createSseSink(c.res, { accepts: false })
  assert.equal(sink.encoding, null)
  sink.write(frame(1))
  sink.end()
  assert.equal(c.bytes().toString(), frame(1))
})

test('acceptsGzip 复用既有实现，`gzip;q=0` 是明确拒绝', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true)
  assert.equal(acceptsGzip('gzip;q=0'), false)
})

test('★★ 每一帧写完就必须能被解出来 —— 不 flush 的 gzip 会把流式憋成一坨', async () => {
  // 这是本文件存在的主要理由。若实现里少了 Z_SYNC_FLUSH，下面 gunzip 会拿不到第 1 帧，
  // 而"功能"看上去完全正常（流结束后一切都对）。
  const c = collector()
  const sink = createSseSink(c.res, { accepts: true })
  assert.equal(sink.encoding, 'gzip')
  await sink.write(frame(1))
  const got1 = zlib.gunzipSync(c.bytes(), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString()
  assert.equal(got1, frame(1), '第 1 帧写完后必须已经可解出——说明 flush 生效')

  await sink.write(frame(2))
  const got2 = zlib.gunzipSync(c.bytes(), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString()
  assert.equal(got2, frame(1) + frame(2))
  await sink.end()
})

test('gzip 后内容逐字节等于明文（不得改写一个字符）', async () => {
  const plain = frame(1) + frame(2) + ': keep-alive\n\n' + frame(3)
  const c = collector()
  const sink = createSseSink(c.res, { accepts: true })
  for (const f of [frame(1), frame(2), ': keep-alive\n\n', frame(3)]) await sink.write(f)
  await sink.end()
  assert.equal(zlib.gunzipSync(c.bytes()).toString(), plain)
})

test('真实首帧量级上确实省得下来（不是聊胜于无）', async () => {
  // 线上首帧 90,746B。这里用同构的重复 JSON 造一个同量级载荷，断言压缩比 ≥3×。
  // 之所以断言比率而不是绝对值：语料会变，而「值不值得做」的判据是比率。
  const big = 'data: ' + JSON.stringify({ events: Array.from({ length: 150 }, (_, i) => ({
    id: `f39b91b2-bde0-4c8c-a1fc-c1052b046241-${i}`,
    seq: `f39b91b2-bde0-4c8c-a1fc-c1052b046241:1020621:${24845479 + i}:0`,
    ts: 1787197026780 + i, type: 'assistant', text: '这是一段助手输出的中文文本，用于近似真实语料。'.repeat(3),
  })) }) + '\n\n'
  const c = collector()
  const sink = createSseSink(c.res, { accepts: true })
  await sink.write(big)
  await sink.end()
  const ratio = Buffer.byteLength(big) / c.bytes().length
  assert.ok(ratio >= 3, `压缩比只有 ${ratio.toFixed(1)}×，不值得做`)
})

test('心跳注释行也要能穿过去（前端靠具名 ping 判活，别在这层被吃掉）', async () => {
  const c = collector()
  const sink = createSseSink(c.res, { accepts: true })
  await sink.write('event: ping\ndata: 1\n\n')
  const got = zlib.gunzipSync(c.bytes(), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString()
  assert.equal(got, 'event: ping\ndata: 1\n\n')
  await sink.end()
})

test('sink.headers() 给出正确的响应头，明文时不得带 Content-Encoding', () => {
  const plain = createSseSink(collector().res, { accepts: false })
  assert.equal(plain.headers()['Content-Encoding'], undefined)
  const gz = createSseSink(collector().res, { accepts: true })
  assert.equal(gz.headers()['Content-Encoding'], 'gzip')
  // no-transform 必须留着：它挡的是中间层**再**改一次编码，与我们自己压不冲突
  assert.match(gz.headers()['Cache-Control'], /no-transform/)
})

test('★ 客户端中途断开不得把 hub 带走 —— 往已销毁的 res 写会抛 ERR_STREAM_DESTROYED', async () => {
  // 这是 'data' 事件回调里的写。事件回调抛出去就是**未捕获异常**，整个 hub 进程会退出，
  // 而触发条件只是"用户切了个页面"——线上必然每天发生很多次。
  const writes = []
  const res = {
    destroyed: false, writableEnded: false,
    write(c) { if (this.destroyed) throw new Error('ERR_STREAM_DESTROYED'); writes.push(c) },
    end() { if (this.destroyed) throw new Error('ERR_STREAM_DESTROYED'); this.writableEnded = true },
  }
  const sink = createSseSink(res, { accepts: true })
  await sink.write(frame(1))
  assert.ok(writes.length > 0)
  res.destroyed = true                       // 用户切页 / 网络断
  await sink.write(frame(2))                 // 必须安静地丢弃，不抛
  await sink.end()                           // 收尾同样不得抛
})

test('明文直通路径同样不得因断开而抛', async () => {
  const res = { destroyed: true, write() { throw new Error('ERR_STREAM_DESTROYED') }, end() { throw new Error('ERR_STREAM_DESTROYED') } }
  const sink = createSseSink(res, { accepts: false })
  await sink.write('data: 1\n\n')
  await sink.end()
})
