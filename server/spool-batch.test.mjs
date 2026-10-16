// node --test server/spool-batch.test.mjs
//
// spool 原本只有 readAll()/clear() 两档——**全读或全清**，没有中间态。于是 replaySpool()
// 只能把积压的 102MB/151k 条整份读出、一次性 upsert；失败整份落回、下轮再砸一次。
// 这正是 2026-08-01 把跨境隧道 cwnd 打崩到 1 的直接原因。
// 补上「读前 N 条」「丢掉前 N 条」，重放才能小批、渐进、可中断。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// spool 的路径是模块常量（~/.web-agents/mongo-spool.ndjson），这里改 HOME 到临时目录，
// 绝不碰真实 spool——本项目有「别拿生产文件当测试夹具」的前科（连 touch 都触发过线上守卫）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-spool-'))
process.env.HOME = TMP
const spool = await import('./spool.js')

const mk = (i) => ({ eventKey: `k${i}`, seq: i })

test('readBatch(n)：只读前 n 条，不删；n 超过总数就全给', () => {
  spool.clear()
  spool.append([mk(1), mk(2), mk(3), mk(4), mk(5)])
  assert.equal(spool.count(), 5)

  const b = spool.readBatch(2)
  assert.deepEqual(b.map((e) => e.eventKey), ['k1', 'k2'], '必须是【最旧的】那批——先进先出')
  assert.equal(spool.count(), 5, 'readBatch 不得删除')

  assert.equal(spool.readBatch(99).length, 5)
})

test('★ dropFirst(n)：只丢掉已成功的那批，剩下的原样留着', () => {
  spool.clear()
  spool.append([mk(1), mk(2), mk(3), mk(4), mk(5)])
  spool.dropFirst(2)
  const rest = spool.readAll()
  assert.deepEqual(rest.map((e) => e.eventKey), ['k3', 'k4', 'k5'])
  assert.equal(spool.count(), 3)
})

test('dropFirst 丢完最后一批 ⇒ spool 干净（不留空文件残渣）', () => {
  spool.clear()
  spool.append([mk(1), mk(2)])
  spool.dropFirst(2)
  assert.equal(spool.count(), 0)
  assert.deepEqual(spool.readAll(), [])
})

test('dropFirst(0) / 负数 / 超量：不得误删', () => {
  spool.clear()
  spool.append([mk(1), mk(2), mk(3)])
  spool.dropFirst(0)
  assert.equal(spool.count(), 3, '0 条不该动任何东西')
  spool.dropFirst(-1)
  assert.equal(spool.count(), 3, '负数同理')
  spool.dropFirst(999)
  assert.equal(spool.count(), 0, '超量等于全清')
})

test('批次之间新追加的事件排在后面，不被 dropFirst 误伤', () => {
  // 真实时序：readBatch → (await upsert，期间投影仍在 append) → dropFirst。
  // 追加都在文件尾部，丢前 n 条不该碰到它们。
  spool.clear()
  spool.append([mk(1), mk(2)])
  const batch = spool.readBatch(2)
  spool.append([mk(3)])            // 重放进行中，新事件继续落盘
  spool.dropFirst(batch.length)
  assert.deepEqual(spool.readAll().map((e) => e.eventKey), ['k3'], '新来的必须活着')
})

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 尽力 */ } })

// ── 以下三条针对 2026-08-01 的【第二次翻车】：第一版 readBatch/dropFirst 是 O(整个文件)
// （每批读 70MB + 写回 70MB），同步 I/O 饿死 event loop ⇒ hub 轮询停摆、五台 agent 全部
// agent.stale、控制台显示冻结快照。改成字节游标 + 窗口读后，必须锁住这些语义。

test('★ dropFirst 不得重写整个文件（改游标即可）——O(整个文件) 会饿死 event loop', () => {
  spool.clear()
  spool.append(Array.from({ length: 200 }, (_, i) => mk(i + 1)))
  const before = fs.statSync(spool._file).mtimeMs
  const sizeBefore = fs.statSync(spool._file).size
  spool.dropFirst(10)
  const after = fs.statSync(spool._file)
  assert.equal(after.size, sizeBefore, '文件大小不该变——丢弃只推进游标，不重写')
  assert.equal(after.mtimeMs, before, '文件根本不该被写')
  assert.equal(spool.count(), 190, '但逻辑条数必须已经减少')
})

test('★ 多字节字符（中文）下游标不得截断——cursor 是字节偏移，不是字符偏移', () => {
  spool.clear()
  spool.append([{ eventKey: 'k1', verb: '执行命令', path: '中文路径/文件.ts' },
                { eventKey: 'k2', verb: '编辑文件', path: '另一个中文/路径.ts' }])
  spool.dropFirst(1)
  const rest = spool.readAll()
  assert.equal(rest.length, 1)
  assert.equal(rest[0].eventKey, 'k2')
  assert.equal(rest[0].verb, '编辑文件', '中文必须完好，不能被字节游标切碎')
})

test('全部消费完 ⇒ 文件删除、游标归零（不留已消费的僵尸文件）', () => {
  spool.clear()
  spool.append([mk(1), mk(2)])
  spool.dropFirst(2)
  assert.equal(spool.count(), 0)
  assert.equal(fs.existsSync(spool._file), false, '消费干净就该删掉，不能留个大文件占着磁盘')
  spool.append([mk(9)])
  assert.deepEqual(spool.readAll().map((e) => e.eventKey), ['k9'], '新写入必须从头可读')
})
