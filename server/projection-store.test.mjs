// node --test server/projection-store.test.mjs
//
// Persistence V1 —— 让 agent 重启后**不必重扫历史**（P3）。
//
// 现状：`summaryCache` / `eventsCache` 是裸 Map，agent 一重启全丢 ⇒ 首个 /api/state
// 对每个会话触发全量重扫。而 checkpoint 的结构 `{generation, offset, evSeq}` 在
// `agent.js` 里**早就算好了，只是从来没写过盘**。
//
// ★ 只存字节 offset 是**不够的**，存了也白存。
//   解析是有状态的：tok 四桶 / daily / hourly / activeMs / prevTs / firstPrompt
//   全是跨行累积量。从第 8,200 万字节接着解析，必须同时知道"截至该字节时这些量是多少"。
//   这也正是 Fluent Bit 的 offset DB 顶不上用的原因——它只记字节。
//
// ★ 范围决定：**只持久化 summary 侧，不持久化 events。**
//   `/api/state` 只需要 summary；events 是用户点开某个会话才要的，那时冷扫一个文件可接受。
//   若把 400 条事件 × 上千会话也写盘，分片文件会失控——收益全被 IO 吃掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProjectionStore, PROJECTION_VERSION } from './projection-store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-proj-'))

/** 一条真实形状的记录：checkpoint + 全部跨行累积量。 */
const rec = (over = {}) => ({
  generation: '1001', fileSize: 82_000_000, offset: 82_000_000, mtimeMs: 1755000000000,
  summary: {
    title: 't', firstPrompt: 'fp', model: 'opus', msgCount: 42, tokens: 999,
    tok: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
    daily: { '2026-08-13': 500 }, dailyCost: { '2026-08-13': 0.5 },
    dayTokComp: { '2026-08-13': { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 } },
    hourly: { '2026-08-13T10': 100 }, hourlyCost: { '2026-08-13T10': 0.1 },
    activeMs: 12345, prevTs: 1755000000000, dailyActiveMs: { '2026-08-13': 12345 },
    lastText: 'x', lastEvent: { ts: 1, verb: 'edit', path: 'a.ts' },
  },
  evSeq: 77,
  ...over,
})

test('put → get 往返完整', () => {
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    s.put('/p/a.jsonl', 'projA', rec())
    assert.deepEqual(s.get('/p/a.jsonl'), rec())
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('未知文件返回 undefined，不抛', () => {
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    assert.equal(s.get('/nope.jsonl'), undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★★ 跨进程持久化：写盘 → 新实例 load → 累积量一字不差', () => {
  // 这是本模块存在的全部意义。任何一个累积量丢了，续算出来的数就是错的，
  // 而且**不会报错**——界面照常显示，只是数字不对。
  const dir = tmp()
  try {
    const a = createProjectionStore({ dir })
    a.put('/p/a.jsonl', 'projA', rec())
    a.flush()

    const b = createProjectionStore({ dir })
    b.load()
    const got = b.get('/p/a.jsonl')
    assert.ok(got, '新实例必须读得到')
    assert.equal(got.offset, 82_000_000, 'offset')
    assert.equal(got.generation, '1001', 'generation(inode)')
    assert.equal(got.evSeq, 77, 'evSeq')
    assert.equal(got.summary.activeMs, 12345, 'activeMs')
    assert.equal(got.summary.prevTs, 1755000000000, '★ prevTs —— activeMs 的续算全靠它')
    assert.deepEqual(got.summary.tok, { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 }, 'token 四桶')
    assert.deepEqual(got.summary.daily, { '2026-08-13': 500 }, 'daily')
    assert.deepEqual(got.summary.hourly, { '2026-08-13T10': 100 }, 'hourly')
    assert.deepEqual(got.summary.dayTokComp, rec().summary.dayTokComp, 'dayTokComp')
    assert.deepEqual(got.summary.dailyActiveMs, { '2026-08-13': 12345 }, 'dailyActiveMs')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★ 按项目分片：不同项目落不同文件', () => {
  // 全局单文件要装上万条记录，每次更新整份重写（数 MB）——不可接受。
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    s.put('/p/a.jsonl', 'projA', rec())
    s.put('/q/b.jsonl', 'projB', rec({ offset: 1 }))
    s.flush()
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 2, `应至少两个分片，实际 ${files.length}: ${files}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★ 单个分片损坏不影响其它项目', () => {
  const dir = tmp()
  try {
    const a = createProjectionStore({ dir })
    a.put('/p/a.jsonl', 'projA', rec())
    a.put('/q/b.jsonl', 'projB', rec({ offset: 42 }))
    a.flush()
    // 把其中一个分片写坏
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    fs.writeFileSync(path.join(dir, files[0]), '{ 坏掉的半截 JSON')
    fs.rmSync(path.join(dir, files[0] + '.bak'), { force: true })

    const b = createProjectionStore({ dir })
    assert.doesNotThrow(() => b.load(), '坏分片不得让整个 load 崩掉')
    const alive = ['/p/a.jsonl', '/q/b.jsonl'].filter((f) => b.get(f))
    assert.equal(alive.length, 1, '坏的那个作废，另一个必须还在')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★ 主文件坏但 .bak 好 ⇒ 回退 .bak', () => {
  const dir = tmp()
  try {
    const a = createProjectionStore({ dir })
    a.put('/p/a.jsonl', 'projA', rec()); a.flush()
    a.put('/p/a.jsonl', 'projA', rec({ offset: 99 })); a.flush()   // 第二次写会生成 .bak
    const shard = fs.readdirSync(dir).find((f) => f.endsWith('.json'))
    assert.ok(fs.existsSync(path.join(dir, shard + '.bak')), '第二次写后应有 .bak')
    fs.writeFileSync(path.join(dir, shard), '坏')

    const b = createProjectionStore({ dir })
    b.load()
    assert.ok(b.get('/p/a.jsonl'), '主文件坏时必须从 .bak 恢复')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★★ parserVersion 变更 ⇒ 旧投影一律作废（不得沿用旧 parser 的产物）', () => {
  const dir = tmp()
  try {
    const a = createProjectionStore({ dir, parserVersion: 1 })
    a.put('/p/a.jsonl', 'projA', rec()); a.flush()

    const b = createProjectionStore({ dir, parserVersion: 2 })
    b.load()
    assert.equal(b.get('/p/a.jsonl'), undefined,
      'parser 升级后必须重建——沿用旧产物会让新旧语义混在同一份数据里')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('projectionVersion 变更同样作废', () => {
  const dir = tmp()
  try {
    const a = createProjectionStore({ dir })
    a.put('/p/a.jsonl', 'projA', rec()); a.flush()
    const shard = fs.readdirSync(dir).find((f) => f.endsWith('.json'))
    const j = JSON.parse(fs.readFileSync(path.join(dir, shard), 'utf8'))
    j.projectionVersion = PROJECTION_VERSION + 1
    fs.writeFileSync(path.join(dir, shard), JSON.stringify(j))
    fs.rmSync(path.join(dir, shard + '.bak'), { force: true })

    const b = createProjectionStore({ dir })
    b.load()
    assert.equal(b.get('/p/a.jsonl'), undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★ events 不落盘（范围决定：只持久化 summary 侧）', () => {
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    s.put('/p/a.jsonl', 'projA', rec({ events: [{ id: 'e1', text: 'x'.repeat(5000) }] }))
    s.flush()
    const shard = fs.readdirSync(dir).find((f) => f.endsWith('.json'))
    const raw = fs.readFileSync(path.join(dir, shard), 'utf8')
    assert.ok(!raw.includes('xxxxxxxxxx'), 'events 正文不得进入分片文件')
    assert.ok(raw.length < 4000, `分片应保持小巧，实际 ${raw.length} 字节`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('flush 只写脏分片（未改动的不重写）', () => {
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    s.put('/p/a.jsonl', 'projA', rec()); s.flush()
    const shard = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json')))
    const mt1 = fs.statSync(shard).mtimeMs
    s.flush()                       // 无改动
    assert.equal(fs.statSync(shard).mtimeMs, mt1, '无改动时不该重写文件')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('remove 删除条目', () => {
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    s.put('/p/a.jsonl', 'projA', rec())
    s.remove('/p/a.jsonl')
    assert.equal(s.get('/p/a.jsonl'), undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('目录不可写时降级为纯内存，不崩', () => {
  // 磁盘满 / 权限问题不该让 agent 起不来——投影没了大不了回到今天的行为（重扫）。
  const s = createProjectionStore({ dir: '/dev/null/nope' })
  assert.doesNotThrow(() => { s.put('/p/a.jsonl', 'projA', rec()); s.flush(); s.load() })
  assert.ok(s.get('/p/a.jsonl'), '内存态仍应可用')
})

test('stats() 供可观测性上报', () => {
  const dir = tmp()
  try {
    const s = createProjectionStore({ dir })
    s.put('/p/a.jsonl', 'projA', rec())
    s.put('/q/b.jsonl', 'projB', rec())
    const st = s.stats()
    assert.equal(st.entries, 2)
    assert.equal(st.shards, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
