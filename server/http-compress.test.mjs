// node --test server/http-compress.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { acceptsGzip, shouldCompress, MIN_BYTES } from './http-compress.js'

test('acceptsGzip：常见头都要认出来', () => {
  assert.equal(acceptsGzip('gzip'), true)
  assert.equal(acceptsGzip('gzip, deflate, br'), true)
  assert.equal(acceptsGzip('deflate, gzip;q=1.0, *;q=0.5'), true)
  assert.equal(acceptsGzip('GZIP'), true, '大小写不敏感')
})

test('★ acceptsGzip：`gzip;q=0` 是【明确拒绝】，不能当接受', () => {
  // 天真的 includes('gzip') 会在这里判错，然后给一个说了「我不要」的客户端发压缩体 → 乱码
  assert.equal(acceptsGzip('gzip;q=0'), false)
  assert.equal(acceptsGzip('gzip;q=0, deflate'), false)
  assert.equal(acceptsGzip('gzip; q=0'), false, '分号后允许空格')
})

test('acceptsGzip：没有 gzip / 空 / 非法输入一律 false（宁可不压，绝不发错）', () => {
  assert.equal(acceptsGzip('deflate, br'), false)
  assert.equal(acceptsGzip(''), false)
  assert.equal(acceptsGzip(undefined), false)
  assert.equal(acceptsGzip(null), false)
  assert.equal(acceptsGzip(123), false)
})

test('shouldCompress：小响应不压（gzip 头能让它变得更大）', () => {
  assert.equal(shouldCompress(10), false)
  assert.equal(shouldCompress(MIN_BYTES - 1), false)
  assert.equal(shouldCompress(MIN_BYTES), true)
  assert.equal(shouldCompress(79_000), true)
  assert.equal(shouldCompress(NaN), false)
})

test('端到端自证：压出来的东西必须能原样解回去（别只信压缩比）', () => {
  const body = JSON.stringify({ sessions: Array.from({ length: 200 }, (_, i) => ({ id: `ps-${i}`, summary: '会话摘要文本' })) })
  const raw = Buffer.from(body)
  assert.ok(shouldCompress(raw.length))
  const gz = zlib.gzipSync(raw, { level: 6 })
  assert.ok(gz.length < raw.length / 2, '这种重复性强的 JSON 至少该省一半')
  assert.equal(zlib.gunzipSync(gz).toString(), body, '解压必须逐字节还原')
})
