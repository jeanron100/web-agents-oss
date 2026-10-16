// 中心侧采集驱动的回归测试（openspec change: execution-history-archive，P0）。
//
// I/O 全部注入，脱离机器验证**最要紧的那条不变量**：
//   落库没成功 ⇒ 立刻停手且水位不推进 ⇒ 下轮从同一位置重来，一行不丢。
//
// 前科（CLAUDE.md）：2026-08-01 Mongo 隧道断了 10 天没人发现，spool 涨破 100 MB 上限后
// **按策略丢弃了最旧一半历史**。本变更采的是"丢了就永远没有"的数据 —— 宁可停采也不丢。

import test from 'node:test'
import assert from 'node:assert/strict'
import { pullOnce, interleaveByEngine } from './archive-pull.js'

const line = (i) => JSON.stringify({ i, t: 'x'.repeat(60) })
const body = (n) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'

/** 假 agent：一份内存里的语料 */
function fakeClient(files) {
  return {
    inventory: async () => files.map((f) => ({
      engine: f.engine ?? 'claude', project: f.project ?? '-p', session: f.session ?? 's',
      path: f.path, st: { ino: f.ino ?? 1, size: Buffer.byteLength(f.text) },
    })),
    read: async (p, from, len) => {
      const f = files.find((x) => x.path === p)
      return Buffer.from(f.text).subarray(from, from + len).toString('utf-8')
    },
  }
}

/** 假中心：可控制是否接收 */
function fakeStore() {
  const seen = new Map()
  const st = {
    accept: async (f) => {
      if (st.fail) return { written: 0, rejected: true }
      if (seen.has(f.key)) return { written: 0, duplicate: true }
      seen.set(f.key, f)
      return { written: f.lines.length }
    },
    fail: false,
    lines: () => [...seen.values()].flatMap((f) => f.lines),
    seenFrames: () => [...seen.values()],
  }
  return st
}

test('拉一轮把全部行落到中心，并推进水位；第二轮无新增则不再拉', async () => {
  const files = [{ path: '/a.jsonl', text: body(5) }]
  const store = fakeStore(); const ckpt = {}
  const r1 = await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  assert.equal(r1.lines, 5)
  assert.equal(r1.blocked, false)
  const r2 = await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  assert.equal(r2.frames, 0, '稳态不得空转重拉')
})

test('★★ 落库失败 ⇒ 立刻停手且水位不推进 ⇒ 下轮一行不丢地重来', async () => {
  const files = [{ path: '/a.jsonl', text: body(5) }]
  const store = fakeStore(); const ckpt = {}
  store.fail = true
  const r1 = await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  assert.equal(r1.blocked, true)
  assert.deepEqual(ckpt, {}, '水位不得推进')

  store.fail = false
  const r2 = await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  assert.equal(r2.lines, 5, '五行一行不少')
})

test('★ agent 不可达时本轮什么都不做，水位一动不动', async () => {
  const store = fakeStore(); const ckpt = { '/a.jsonl': { generation: '1', fileSize: 10, offset: 10 } }
  const before = JSON.stringify(ckpt)
  const r = await pullOnce({
    host: 'h1', store, ckpt,
    client: { inventory: async () => { throw new Error('ECONNREFUSED') }, read: async () => '' },
  })
  assert.equal(r.blocked, true)
  assert.match(r.error, /ECONNREFUSED/)
  assert.equal(JSON.stringify(ckpt), before)
})

test('★ 读取失败同样停手且不推进该文件的水位', async () => {
  const files = [{ path: '/a.jsonl', text: body(3) }]
  const client = fakeClient(files)
  client.read = async () => { throw new Error('EIO') }
  const ckpt = {}
  const r = await pullOnce({ host: 'h1', client, store: fakeStore(), ckpt })
  assert.equal(r.blocked, true)
  assert.deepEqual(ckpt, {})
})

test('★ 增量：追加后只拉新增部分', async () => {
  const files = [{ path: '/a.jsonl', text: body(3) }]
  const store = fakeStore(); const ckpt = {}
  await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  files[0].text += line(99) + '\n'
  const r = await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  assert.equal(r.lines, 1)
})

test('★ 正在写的半行本轮不拉，下轮补齐', async () => {
  const files = [{ path: '/a.jsonl', text: body(2) + '{"half":' }]
  const store = fakeStore(); const ckpt = {}
  await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  const got = store.lines()
  assert.equal(got.length, 2)
  assert.ok(got.every((l) => { try { JSON.parse(l); return true } catch { return false } }))

  files[0].text += '1}\n'
  await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  assert.deepEqual(store.lines().slice(-1), ['{"half":1}'])
})

test('★ 重复落库（duplicate）不算失败，水位照常推进', async () => {
  // 中心重启后 manifest 恢复 ⇒ 同一帧会被判 duplicate。那是正常路径，不能当成"落库失败"停采。
  const files = [{ path: '/a.jsonl', text: body(3) }]
  const store = fakeStore(); const ckpt = {}
  await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt })
  const ckpt2 = {}                                   // 水位丢了，但中心已有
  const r = await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt: ckpt2 })
  assert.equal(r.blocked, false)
  assert.ok(ckpt2['/a.jsonl'], '重复也要推进水位，否则会永远原地重拉')
})

test('★ 限速：单轮读取不超过 roundBytes', async () => {
  const files = [{ path: '/big.jsonl', text: body(3000) }]
  const r = await pullOnce({ host: 'h1', client: fakeClient(files), store: fakeStore(), ckpt: {}, roundBytes: 4096 })
  assert.ok(r.bytes <= 4096 * 1.2, `本轮读了 ${r.bytes} B`)
})

// ───────────────── 引擎轮转（防饿死）─────────────────
//
// 实测（2026-08-29）：枚举顺序是 claude → codex → kimi，而每轮有字节上限。
// 177-188 上 claude 待采 393.8 MB、codex 171.7 MB、kimi 1.0 MB，8 MB/轮 ⇒
// **claude 要 50 轮才轮得到 codex，kimi 要等 70 轮**。
// ★ 那不是"路不通"，但对账看到的是一样的 0 —— **分不清「还没轮到」和「根本没通」，
//   是最坏的一种**：你会以为只是慢，于是不去查。

test('★★ 大引擎不得饿死小引擎 —— 首轮三个引擎都要有进展', async () => {
  const files = [
    ...Array.from({ length: 20 }, (_, i) => ({ path: `/c${i}.jsonl`, engine: 'claude', text: body(60) })),
    { path: '/x.jsonl', engine: 'codex', text: body(5) },
    { path: '/k.jsonl', engine: 'kimi', text: body(5) },
  ]
  const store = fakeStore()
  await pullOnce({ host: 'h1', client: fakeClient(files), store, ckpt: {}, roundBytes: 3000 })
  const engines = new Set([...store.seenFrames()].map((f) => f.engine))
  assert.ok(engines.has('codex'), 'codex 在首轮就该有进展')
  assert.ok(engines.has('kimi'), 'kimi 在首轮就该有进展')
})

test('interleaveByEngine 不丢计划、不重复', () => {
  const eo = new Map([['a', 'claude'], ['b', 'claude'], ['c', 'codex']])
  const out = interleaveByEngine([{ path: 'a' }, { path: 'b' }, { path: 'c' }], eo)
  assert.deepEqual(out.map((x) => x.path).sort(), ['a', 'b', 'c'])
  assert.equal(out[1].path, 'c', '第二个应轮到另一个引擎')
})
