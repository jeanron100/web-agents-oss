import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileSafe, readFileSafe } from './codetree.js'

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cdt-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello', 'utf8')
  return dir
}

test('readFileSafe 返回 mtimeMs', () => {
  const r = readFileSafe(tmpProject(), 'a.txt')
  assert.ok(r && typeof r.mtimeMs === 'number')
})
test('writeFileSafe happy path 写入 cwd 内文件', () => {
  const cwd = tmpProject()
  const r = writeFileSafe(cwd, 'a.txt', 'world')
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'world')
  assert.equal(typeof r.mtimeMs, 'number')
})
test('writeFileSafe 拒绝路径穿越', () => {
  const r = writeFileSafe(tmpProject(), '../escape.txt', 'x')
  assert.equal(r.ok, false); assert.equal(r.error, 'path')
})
test('writeFileSafe 拒绝目录', () => {
  const cwd = tmpProject(); fs.mkdirSync(path.join(cwd, 'sub'))
  const r = writeFileSafe(cwd, 'sub', 'x')
  assert.equal(r.ok, false); assert.equal(r.error, 'notfile')
})
test('writeFileSafe 拒绝不存在文件(v1 不新建)', () => {
  const r = writeFileSafe(tmpProject(), 'nope.txt', 'x')
  assert.equal(r.ok, false); assert.equal(r.error, 'notfound')
})
test('writeFileSafe 拒绝超限内容', () => {
  const r = writeFileSafe(tmpProject(), 'a.txt', 'x'.repeat(200_001), { maxBytes: 200_000 })
  assert.equal(r.ok, false); assert.equal(r.error, 'toolarge')
})
test('writeFileSafe 乐观锁：mtime 不符 → conflict', () => {
  const r = writeFileSafe(tmpProject(), 'a.txt', 'world', { baseMtimeMs: 1 })
  assert.equal(r.ok, false); assert.equal(r.error, 'conflict')
})
test('writeFileSafe 乐观锁：base mtime 正确 → 通过', () => {
  const cwd = tmpProject()
  const cur = readFileSafe(cwd, 'a.txt')
  const r = writeFileSafe(cwd, 'a.txt', 'world', { baseMtimeMs: cur.mtimeMs })
  assert.equal(r.ok, true)
})
test('writeFileSafe 不留 temp 文件', () => {
  const cwd = tmpProject(); writeFileSafe(cwd, 'a.txt', 'world')
  assert.equal(fs.readdirSync(cwd).filter((f) => f.includes('.wa-tmp-')).length, 0)
})
test('writeFileSafe 拒绝非字符串内容(归类 path)', () => {
  const r = writeFileSafe(tmpProject(), 'a.txt', null)
  assert.equal(r.ok, false); assert.equal(r.error, 'path')
})
