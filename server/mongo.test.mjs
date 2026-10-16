// node --test server/mongo.test.mjs
//
// A) 降级路径（flag=0）——必须永远绿：Mongo 关着时一切中性、不抛，主流程可回退。
// B) 真机路径（flag=1 且隧道可达）——幂等 upsert / 重放不产生重复 / 脱敏样本不进库 / spool 兜底重放。
//    Mongo 不可达时自动跳过。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

try {
  for (const l of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^(WA_MONGO_URI|WA_MONGO_DB)=(.*)$/.exec(l.trim())
    if (m) process.env[m[1]] = m[2]
  }
} catch { /* 只跑降级用例 */ }

const mongo = await import('./mongo.js')
const repo = await import('./repositories/event-repository.js')
const spool = await import('./spool.js')
const { normalizeEvent } = await import('./event-envelope.js')
const { redactEvent } = await import('./event-redaction.js')

// 顶层探测（skip 在注册时求值，必须先做完）
let live = false
if (process.env.WA_MONGO_URI) {
  process.env.WA_MONGO_ENABLED = '1'
  const h = await mongo.health()
  live = h.status === 'ok'
  if (!live) console.warn(`  (跳过真机用例：Mongo 不可达 — ${h.error || h.status})`)
}
const needMongo = live ? false : '需要可达的 Mongo（已跳过）'
const on = () => { process.env.WA_MONGO_ENABLED = '1' }
const TESTSID = `ps-__test__-${process.pid}`

// 造一条脱敏后的信封（模拟真实链路：normalize → redact）
const mkEnv = (seq, extra = {}) => redactEvent(normalizeEvent(
  { type: 'file_op', verb: '执行命令', path: 'src/a.ts', ts: 1783219122253, seq, ...extra },
  { serverId: 'srv-test', engine: 'claude', project: 'p', sessionId: TESTSID, realSessionId: 'r1', ingestedAt: new Date().toISOString() },
))

// ---------- A) 降级 ----------
test('降级：Mongo 关闭时一切中性、不抛（事件落 spool 不丢）', async () => {
  process.env.WA_MONGO_ENABLED = '0'
  assert.equal(mongo.enabled(), false)
  assert.equal(await mongo.getDb(), null)
  assert.deepEqual(await mongo.health(), { status: 'disabled' })
  assert.equal(await mongo.ensureIndexes(), false)
  assert.equal(await repo.timeline('x'), null)   // null → 调用方回退扫 JSONL
  assert.equal(await repo.count(), null)

  // Mongo 关着时，事件必须落 spool（而不是静默丢失）
  const before = spool.count()
  const r = await repo.upsertMany([mkEnv('r1:1:100:0')])
  assert.equal(r.spooled, 1, '必须落 spool')
  assert.equal(spool.count(), before + 1)
  spool.clear()
})

// ---------- B) 真机 ----------
test('真机：建索引幂等 + 唯一索引/TTL 都在', { skip: needMongo }, async () => {
  on()
  assert.equal(await mongo.ensureIndexes(), true)
  assert.equal(await mongo.ensureIndexes(), true, '重复建索引必须幂等')
  const c = await mongo.coll('execution_events')
  const idx = await c.indexes()
  const names = idx.map((i) => i.name)
  assert.ok(names.includes('uniq_eventKey'), '幂等去重的唯一索引必须存在')
  assert.ok(names.includes('session_timeline'), '会话时间线索引必须存在')
  const ttl = idx.find((i) => i.name === 'ttl_180d')
  assert.ok(ttl?.expireAfterSeconds > 0, 'TTL 索引必须有过期秒数')
  const uniq = idx.find((i) => i.name === 'uniq_eventKey')
  assert.equal(uniq.unique, true)
})

test('真机：幂等 upsert——同一事件重放 3 次，Mongo 里只有 1 条', { skip: needMongo }, async () => {
  on()
  const c = await mongo.coll('execution_events')
  await c.deleteMany({ sessionId: TESTSID })

  const env = mkEnv('r1:1:1000:0')
  const r1 = await repo.upsertMany([env])
  const r2 = await repo.upsertMany([env])   // 重放
  const r3 = await repo.upsertMany([env])   // 再重放

  assert.equal(r1.written, 1, '首次应写入 1 条')
  assert.equal(r2.written, 0, '重放不应新写')
  assert.equal(r2.skipped, 1, '重放应被识别为已存在')
  assert.equal(r3.written, 0)
  assert.equal(await c.countDocuments({ eventKey: env.eventKey }), 1, '无论重放几次，只能有 1 条')
  await c.deleteMany({ sessionId: TESTSID })
})

test('真机：脱敏样本绝不进 Mongo（密钥/密码/终端输出）', { skip: needMongo }, async () => {
  on()
  const c = await mongo.coll('execution_events')
  await c.deleteMany({ sessionId: TESTSID })

  const env = mkEnv('r1:1:2000:0', {
    // 这些字段/内容都不该出现在库里
    command: 'curl -H "Authorization: Bearer SUPERSECRET123" x',   // 禁用字段名 → 整段丢
    stdout: '一大段终端输出',                                        // 禁用字段名 → 整段丢
  })
  await repo.upsertMany([env])

  const doc = await c.findOne({ eventKey: env.eventKey })
  const blob = JSON.stringify(doc)
  assert.ok(!blob.includes('SUPERSECRET123'), '密钥绝不能进库')
  assert.ok(!blob.includes('一大段终端输出'), '终端输出绝不能进库')
  assert.equal(doc.privacy.redacted, true)
  assert.equal(doc.payload.verb, '执行命令', '结构化字段应保留')
  await c.deleteMany({ sessionId: TESTSID })
})

test('真机：spool 兜底——Mongo 挂时落盘，恢复后重放且不产生重复', { skip: needMongo }, async () => {
  on()
  const c = await mongo.coll('execution_events')
  await c.deleteMany({ sessionId: TESTSID })
  spool.clear()

  const envs = [mkEnv('r1:1:3000:0'), mkEnv('r1:1:3100:0')]

  // 模拟 Mongo 不可用 → 落 spool
  process.env.WA_MONGO_ENABLED = '0'
  const down = await repo.upsertMany(envs)
  assert.equal(down.spooled, 2, 'Mongo 挂时必须落 spool')
  assert.equal(spool.count(), 2)

  // Mongo 恢复 → 重放
  on()
  const rep = await repo.replaySpool()
  assert.equal(rep.replayed, 2)
  assert.equal(rep.written, 2)
  assert.equal(spool.count(), 0, '重放成功后 spool 应清空')

  // 再重放一次（spool 已空）+ 直接重放同样的事件 → 仍不产生重复
  await repo.upsertMany(envs)
  assert.equal(await c.countDocuments({ sessionId: TESTSID }), 2, '重放不得产生重复')

  await c.deleteMany({ sessionId: TESTSID })
  spool.clear()
})

test('真机：时间线按 occurredAt 正序返回（走 session_timeline 索引）', { skip: needMongo }, async () => {
  on()
  const c = await mongo.coll('execution_events')
  await c.deleteMany({ sessionId: TESTSID })

  await repo.upsertMany([
    redactEvent(normalizeEvent({ type: 'file_op', verb: 'B', ts: 2000, seq: 'r1:1:5100:0' },
      { serverId: 'srv-test', engine: 'claude', sessionId: TESTSID, realSessionId: 'r1', ingestedAt: new Date().toISOString() })),
    redactEvent(normalizeEvent({ type: 'file_op', verb: 'A', ts: 1000, seq: 'r1:1:5000:0' },
      { serverId: 'srv-test', engine: 'claude', sessionId: TESTSID, realSessionId: 'r1', ingestedAt: new Date().toISOString() })),
  ])
  const tl = await repo.timeline(TESTSID)
  assert.equal(tl.length, 2)
  assert.equal(tl[0].payload.verb, 'A', '应按 occurredAt 正序（A 早于 B）')
  assert.equal(tl[1].payload.verb, 'B')

  await c.deleteMany({ sessionId: TESTSID })
})

// 不关池 ⇒ 驱动的 socket 一直挂着 ⇒ 用例全过但进程永不退出（曾经的退出码 124）。
after(async () => { await mongo.close() })
