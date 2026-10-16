// node --test server/replay-spool.test.mjs
//
// 两个真实缺陷的回归测试（2026-08-01 跨境隧道拥塞崩溃事故）：
//
// ① **重放失败会把 spool 翻倍。** replaySpool() 用 readAll() 读出全部（不删），交给
//    upsertMany()；后者 catch 里 `spool.append(envelopes)` 把同一批**又落一次盘**，而
//    replaySpool 因为失败又不清空 ⇒ 每失败一次积压翻倍，直到撑破 100MB 上限被
//    trimOldest() 砍掉最旧一半（真的丢数据）。
//    注意 mongo.coll() 只是取集合句柄、**不发 I/O**，所以「连得上但写超时」正是常态路径。
//
// ② **一次性整份重放。** 102MB/151k 条一把砸进 ~3Mbps 的跨境隧道，把 cwnd 打崩到 1
//    （实测重传 10.3%、188Kbps），往返涨到 2~5s 反过来又触发超时——自维持的拥塞崩溃。
//
// 依赖注入（upsert/getColl 都有默认值，生产行为不变）以便离线验证，不需要真 Mongo。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-replay-'))
process.env.HOME = TMP   // 隔离 spool 文件，绝不碰生产（本项目有前科）
const spool = await import('./spool.js')
const repo = await import('./repositories/event-repository.js')

const mk = (i) => ({ eventKey: `k${i}`, seq: i, payload: { v: i } })
const fill = (n) => { spool.clear(); spool.append(Array.from({ length: n }, (_, i) => mk(i + 1))) }
const okColl = async () => ({ bulkWrite: async () => ({ upsertedCount: 0 }) })
// 句柄拿得到、但写超时——这正是跨境隧道下的常态路径（coll() 只取句柄、不发 I/O）
const timingOutColl = async () => ({ bulkWrite: async () => { throw new Error('bulkWrite 超时（跨境隧道）') } })

test('★ 重放失败绝不能让 spool 变大（原来每失败一次翻一倍，直到撑破上限丢数据）', async () => {
  fill(10)
  const before = spool.count()
  // 走【真实的 upsertMany】，只把集合句柄换成写必超时的——否则测不到 append 那一行
  const r = await repo.replaySpool({ maxBatch: 5, getColl: timingOutColl })
  assert.equal(r, null, '失败必须回 null，让调用方知道没成功')
  assert.equal(spool.count(), before, `失败后 spool 必须原样不变，实际 ${spool.count()} vs ${before}`)
})

test('★ 单次重放限批：102MB 积压不得一把砸进 3Mbps 的管子', async () => {
  fill(1000)
  let sawBatch = -1
  await repo.replaySpool({
    maxBatch: 50,
    getColl: okColl,
    upsert: async (batch) => { sawBatch = batch.length; return { written: batch.length, skipped: 0, spooled: 0 } },
  })
  assert.equal(sawBatch, 50, '一次只能取 maxBatch 条')
  assert.equal(spool.count(), 950, '成功的那批才被丢掉，剩下的留到下轮')
})

test('成功重放只丢掉已写入的那批，顺序保持先进先出', async () => {
  fill(5)
  await repo.replaySpool({
    maxBatch: 2,
    getColl: okColl,
    upsert: async (batch) => {
      assert.deepEqual(batch.map((e) => e.eventKey), ['k1', 'k2'], '必须先重放最旧的')
      return { written: 2, skipped: 0, spooled: 0 }
    },
  })
  assert.deepEqual(spool.readAll().map((e) => e.eventKey), ['k3', 'k4', 'k5'])
})

test('upsert 报告 spooled>0（内部已落盘）时同样按失败处理，不得重复丢弃', async () => {
  fill(4)
  const r = await repo.replaySpool({
    maxBatch: 4,
    getColl: okColl,
    upsert: async (batch) => ({ written: 0, skipped: 0, spooled: batch.length }),
  })
  assert.equal(r, null)
  assert.equal(spool.count(), 4)
})

test('Mongo 不可用（拿不到集合句柄）⇒ 直接回 null，一个字节都不发', async () => {
  fill(3)
  let called = false
  const r = await repo.replaySpool({
    maxBatch: 10,
    getColl: async () => null,
    upsert: async () => { called = true; return { written: 0, skipped: 0, spooled: 0 } },
  })
  assert.equal(r, null)
  assert.equal(called, false, 'Mongo 都没连上就别往管子里灌东西')
  assert.equal(spool.count(), 3)
})

test('spool 为空 ⇒ 平凡成功，不去碰 Mongo', async () => {
  spool.clear()
  const r = await repo.replaySpool({ maxBatch: 10, getColl: async () => { throw new Error('不该被调用') } })
  assert.deepEqual(r, { replayed: 0, written: 0, skipped: 0 })
})

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 尽力 */ } })
