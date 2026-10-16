// node --test server/attach-read.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveSessionImages, readSessionImageFile } from './driver.js'

const ROOT = path.join(os.homedir(), '.web-agents', 'attachments')
const SID = `test-attach-${process.pid}`
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('落盘的图能按文件名取回，且 mediaType 由扩展名还原', () => {
  const saved = saveSessionImages(SID, [{ media_type: 'image/png', data: PNG_B64 }])
  assert.equal(saved.length, 1)
  const hit = readSessionImageFile(SID, saved[0].name)
  assert.ok(hit, '刚落盘的图必须取得回来')
  assert.equal(hit.mediaType, 'image/png')
  assert.ok(hit.buf.length > 0)
  assert.equal(hit.buf.subarray(1, 4).toString(), 'PNG', '取回的必须是真 PNG 字节')
})

test('★ 路径穿越必须挡住——name 来自事件，按不可信输入对待', () => {
  // 事件里的 images[].name 走过 HTTP 出口再回来，不能假定它没被改过。
  for (const evil of ['../../../etc/passwd', '..%2Fpasswd', 'a/b.png', 'a\\b.png', '../x.png']) {
    assert.equal(readSessionImageFile(SID, evil), null, `必须拒绝: ${evil}`)
  }
})

test('缺参数 / 不存在的文件一律返回 null，不抛', () => {
  assert.equal(readSessionImageFile('', 'x.png'), null)
  assert.equal(readSessionImageFile(SID, ''), null)
  assert.equal(readSessionImageFile(SID, 'nope-does-not-exist.png'), null)
  assert.equal(readSessionImageFile(SID, undefined), null)
})

test.after(() => { try { fs.rmSync(path.join(ROOT, SID), { recursive: true, force: true }) } catch { /* ignore */ } })
