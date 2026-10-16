// node --test server/max-sessions-store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readPersistedMax, writePersistedMax, resolveStartupMax, MAX_SESSIONS_DEFAULT } from './max-sessions-store.js'

function tmpfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxsess-'))
  return path.join(dir, 'nested', 'max-sessions.json') // 嵌套目录：验证 mkdirSync recursive
}

test('readPersistedMax：文件不存在 → null', () => {
  assert.equal(readPersistedMax(tmpfile()), null)
})

test('readPersistedMax：损坏 JSON → null（不抛错）', () => {
  const f = tmpfile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, '{not json')
  assert.equal(readPersistedMax(f), null)
})

test('readPersistedMax：max 字段非数字 → null', () => {
  const f = tmpfile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ max: 'twelve' }))
  assert.equal(readPersistedMax(f), null)
})

test('writePersistedMax → readPersistedMax 往返；目录自动创建、文件 0600', () => {
  const f = tmpfile()
  writePersistedMax(12, f)
  assert.equal(readPersistedMax(f), 12)
  const st = fs.statSync(f)
  assert.equal(st.mode & 0o777, 0o600)
  const dirSt = fs.statSync(path.dirname(f))
  assert.equal(dirSt.mode & 0o777, 0o700)
})

test('writePersistedMax 覆盖旧值：只保留最新一次（不是追加）', () => {
  const f = tmpfile()
  writePersistedMax(5, f)
  writePersistedMax(9, f)
  assert.equal(readPersistedMax(f), 9)
})

test('resolveStartupMax：文件存在 → source=file，优先于 env', () => {
  const f = tmpfile()
  writePersistedMax(3, f)
  const r = resolveStartupMax({ file: f, env: '10' })
  assert.deepEqual(r, { value: 3, source: 'file' })
})

test('resolveStartupMax：无文件、有 env → source=env', () => {
  const r = resolveStartupMax({ file: tmpfile(), env: '10' })
  assert.deepEqual(r, { value: 10, source: 'env' })
})

test('resolveStartupMax：无文件、env 非法(非数字字符串) → 回退默认值', () => {
  const r = resolveStartupMax({ file: tmpfile(), env: 'abc' })
  assert.deepEqual(r, { value: MAX_SESSIONS_DEFAULT, source: 'default' })
})

test('resolveStartupMax：无文件、无 env → source=default', () => {
  const r = resolveStartupMax({ file: tmpfile(), env: undefined })
  assert.deepEqual(r, { value: MAX_SESSIONS_DEFAULT, source: 'default' })
})

test('resolveStartupMax：env 为空字符串 → 视同未设置，回退默认值', () => {
  const r = resolveStartupMax({ file: tmpfile(), env: '' })
  assert.deepEqual(r, { value: MAX_SESSIONS_DEFAULT, source: 'default' })
})

// 「文件不存在」与「文件损坏」不能共用静默回落——后者是异常，必须喊出来。
// 运维用这个文件把 2G 机器的上限压低防 OOM；损坏后静默退回默认 8 = 把当初的事故放回来。
test('★ 文件损坏 → 回落但必须留下错误日志（静默回落等于没有告警）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-maxsess-'))
  const f = path.join(dir, 'max-sessions.json')
  fs.writeFileSync(f, '{ 这不是合法 JSON')
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    assert.equal(readPersistedMax(f), null, '损坏文件应回落')
    assert.equal(errs.length, 1, '必须打一条错误日志')
    assert.match(errs[0], /解析失败/)
  } finally { console.error = orig; fs.rmSync(dir, { recursive: true, force: true }) }
})

test('★ 文件不存在 → 静默回落，不该有噪声日志（首次启动是正常路径）', () => {
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    assert.equal(readPersistedMax('/tmp/wa-definitely-not-here-xyz.json'), null)
    assert.equal(errs.length, 0, '正常路径不该打日志')
  } finally { console.error = orig }
})

test('★ 文件在但 max 非法（字符串/null）→ 回落 + 日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-maxsess-'))
  const f = path.join(dir, 'max-sessions.json')
  fs.writeFileSync(f, JSON.stringify({ max: 'abc' }))
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    assert.equal(readPersistedMax(f), null)
    assert.equal(errs.length, 1)
    assert.match(errs[0], /非法/)
  } finally { console.error = orig; fs.rmSync(dir, { recursive: true, force: true }) }
})
