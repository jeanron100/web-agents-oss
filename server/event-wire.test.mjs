// toWire / findImage：事件 payload 上线时剥离 base64。
// 跑：node --test server/event-wire.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toWire, findImage } from './event-wire.js'

// 按线上真实尺寸造：website_operator 那条 user 事件里就是一张 250KB 的 PNG。
// 夹具太小的话「体积应大幅下降」这条断言形同虚设（我第一版就是这么写的，白跑一轮）。
const RAW = Buffer.alloc(250 * 1024, 'x')
const B64 = RAW.toString('base64')

const payload = () => ({
  kind: 'snapshot',
  firstSeq: 'a:1:0:0',
  lastSeq: 'a:1:900:0',
  todos: [{ text: 't' }],
  fileChanges: [{ path: 'a.ts' }],
  events: [
    { id: 'ev-1', ts: 1, type: 'assistant', text: 'hi', seq: 'a:1:10:0' },
    {
      id: 'ev-2', ts: 2, type: 'user', text: '看这张图', seq: 'a:1:20:0', imageCount: 2,
      images: [
        { name: 'img-1.png', media_type: 'image/png', base64: B64 },
        { name: 'img-2.jpg', media_type: 'image/jpeg', base64: B64 },
      ],
    },
    { id: 'ev-3', ts: 3, type: 'file_op', verb: 'Edit', path: 'x.ts', seq: 'a:1:30:0' },
  ],
})

test('base64 不再上线——这就是首屏 8~10 秒的根因', () => {
  const wire = toWire(payload(), 'ps-abc')
  assert.equal(JSON.stringify(wire).includes('base64'), false, 'payload 里不得残留任何 base64')
  assert.ok(JSON.stringify(wire).length < JSON.stringify(payload()).length / 2, '体积应大幅下降')
})

test('图片换成可懒加载的 URL 引用，带上体积和元信息', () => {
  const u = toWire(payload(), 'ps-abc').events.find((e) => e.id === 'ev-2')
  const bytes = Math.floor((B64.length * 3) / 4)
  assert.equal(u.imageCount, 2)
  assert.deepEqual(u.images, [
    { name: 'img-1.png', media_type: 'image/png', bytes, url: '/api/session/ps-abc/image/ev-2/0' },
    { name: 'img-2.jpg', media_type: 'image/jpeg', bytes, url: '/api/session/ps-abc/image/ev-2/1' },
  ])
})

test('⚠️ 绝不可就地修改原 payload——它是 cachedScan 缓存里的同一个对象，改了归档器就永远拿不到截图', () => {
  const p = payload()
  const before = JSON.parse(JSON.stringify(p))
  toWire(p, 'ps-abc')
  assert.deepEqual(p, before, 'toWire 必须是纯函数；原对象的 base64 一个字节都不能少')
  assert.equal(p.events[1].images[0].base64, B64)
})

test('非图片事件、其余字段原样透传（帧协议/游标不能被动到）', () => {
  const wire = toWire(payload(), 'ps-abc')
  assert.equal(wire.kind, 'snapshot')
  assert.equal(wire.lastSeq, 'a:1:900:0')
  assert.deepEqual(wire.todos, [{ text: 't' }])
  assert.deepEqual(wire.fileChanges, [{ path: 'a.ts' }])
  assert.deepEqual(wire.events[0], payload().events[0])
  assert.deepEqual(wire.events[2], payload().events[2])
  assert.equal(wire.events.length, 3)
})

test('无图会话零开销：直接返回原对象（不复制）', () => {
  const p = { kind: 'snapshot', events: [{ id: 'e1', type: 'assistant', text: 'x' }] }
  assert.equal(toWire(p, 'ps-x'), p, '同一引用')
})

test('空/异常入参不炸', () => {
  assert.equal(toWire(null, 'x'), null)
  assert.deepEqual(toWire({ events: null }, 'x'), { events: null })
})

test('findImage 按 (eventId, idx) 取回原始字节', () => {
  const got = findImage(payload().events, 'ev-2', 1)
  assert.equal(got.mediaType, 'image/jpeg')
  assert.equal(got.name, 'img-2.jpg')
  assert.equal(got.buf.length, RAW.length)
  assert.ok(got.buf.equals(RAW), '取回的字节必须与原图逐字节一致')
})

test('findImage 找不到时返回 null（而不是抛）', () => {
  assert.equal(findImage(payload().events, 'nope', 0), null)
  assert.equal(findImage(payload().events, 'ev-2', 9), null)
  assert.equal(findImage(payload().events, 'ev-1', 0), null) // 该事件本就没图
  assert.equal(findImage(null, 'ev-2', 0), null)
})
