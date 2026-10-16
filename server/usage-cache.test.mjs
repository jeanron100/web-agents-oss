import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, load, save, REFRESH_MS } from './usage-cache.js'

// ── decide：stale-while-revalidate 的核心判据 ──
// 最重要的性质：**旧值也要给**。额度不是实时量，给个带时间戳的旧值远好过转圈或报错。

test('无缓存 → 没得给，必须刷新', () => {
  const r = decide({ cached: null, now: 1000 })
  assert.equal(r.serve, null)
  assert.equal(r.refresh, true)
})

test('新鲜缓存 → 给值，不刷新（这条省掉的就是 CLI 探测）', () => {
  const cached = { ts: 1000, session: { pct: 5 } }
  const r = decide({ cached, now: 1000 + REFRESH_MS - 1 })
  assert.equal(r.serve, cached)
  assert.equal(r.refresh, false)
  assert.equal(r.stale, false)
})

test('★ 过期缓存 → 仍然给值，同时触发刷新（绝不能返回 null 让前端空转）', () => {
  const cached = { ts: 1000, session: { pct: 5 } }
  const r = decide({ cached, now: 1000 + REFRESH_MS + 1 })
  assert.equal(r.serve, cached, '过期不等于不可用——这是本模块存在的理由')
  assert.equal(r.refresh, true)
  assert.equal(r.stale, true)
})

test('ts 缺失/非数字 → 当作 miss（脏数据不能污染出口）', () => {
  for (const bad of [{ pct: 1 }, { ts: 'x' }, { ts: NaN }, { ts: null }, 'not-an-object', 42]) {
    const r = decide({ cached: bad, now: 1000 })
    assert.equal(r.serve, null, `${JSON.stringify(bad)} 应当作 miss`)
    assert.equal(r.refresh, true)
  }
})

test('时钟回拨（ts 在未来）→ 照样给值并刷新，不能因此判成 miss', () => {
  const cached = { ts: 5000, session: { pct: 5 } }
  const r = decide({ cached, now: 1000 })
  assert.equal(r.serve, cached)
  assert.equal(r.refresh, true)
})

// ── load：任何异常都必须塌成 miss ──
// 红线：Redis 是缓存层，丢了只是变慢，不能变不可用。

test('load：redis 抛异常 → 返回 null 而不是把异常抛给请求路径', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await load('claude', { client: boom }), null)
})

test('load：client 为 null（redis 未启用）→ null，不抛', async () => {
  assert.equal(await load('claude', { client: async () => null }), null)
})

test('load：Redis 里是坏 JSON → null，不抛', async () => {
  const c = async () => ({ get: async () => '{坏的' })
  assert.equal(await load('claude', { client: c }), null)
})

test('load：正常读回', async () => {
  const val = { ts: 123, week: { pct: 98 } }
  const c = async () => ({ get: async () => JSON.stringify(val) })
  assert.deepEqual(await load('codex', { client: c }), val)
})

test('load：键名带引擎，避免三个引擎互相覆盖', async () => {
  const seen = []
  const c = async () => ({ get: async (k) => { seen.push(k); return null } })
  await load('kimi', { client: c })
  assert.ok(seen[0].includes('kimi'), `键里要含引擎名，实际 ${seen[0]}`)
})

// ── save：fire-and-forget，绝不阻塞调用方 ──

test('★ save：同步返回（不是 promise），调用方无从 await ⇒ 不可能阻塞请求路径', () => {
  const c = async () => ({ set: async () => 'OK' })
  const r = save('claude', { week: { pct: 49 } }, { client: c })
  assert.equal(r, undefined, 'save 必须同步返回 undefined，否则会诱使调用方 await')
})

test('★ save：底层 redis 抛异常也不能冒泡（此处若泄漏就是未捕获拒绝）', async () => {
  const c = async () => { throw new Error('down') }
  save('claude', { week: { pct: 49 } }, { client: c })
  await new Promise((r) => setImmediate(r)) // 给内部异步任务一拍去炸
  assert.ok(true, '走到这里说明异常没冒泡')
})

test('save：写入带 ts 与 TTL', async () => {
  let key = '', body = '', opts = null
  const c = async () => ({ set: async (k, v, o) => { key = k; body = v; opts = o; return 'OK' } })
  save('codex', { week: { pct: 98 } }, { client: c, now: () => 777 })
  await new Promise((r) => setImmediate(r))
  assert.ok(key.includes('codex'))
  assert.equal(JSON.parse(body).ts, 777, '必须打上 ts，否则 decide 无从判新旧')
  assert.ok(opts?.EX > 0, 'TTL 必须给，防止 redis 无限堆积')
})
