import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openProjectImage, MAX_IMAGE_BYTES, imageMime } from './file-image.js'
import { readFileSafe } from './codetree.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64')
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-file-image-'))
  const cwd = path.join(root, 'project')
  fs.mkdirSync(cwd)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, cwd }
}
async function bytes(image) {
  const chunks = []
  for await (const chunk of image.stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}
test('PNG metadata is read-only and image stream returns original bytes for relative and absolute paths', async t => {
  const { cwd } = project(t), name = '登录 二维码.png'
  fs.writeFileSync(path.join(cwd, name), png)
  const meta = readFileSafe(cwd, name)
  assert.equal(meta.imageMime, 'image/png')
  assert.equal(meta.binary, true)
  assert.equal(meta.content, '')
  for (const p of [name, path.join(cwd, name)]) {
    const image = openProjectImage(cwd, p)
    assert.equal(image.mediaType, 'image/png')
    assert.equal(image.size, png.length)
    assert.deepEqual(await bytes(image), png)
  }
})
test('images larger than text preview limit are streamed intact instead of truncated', async t => {
  const { cwd } = project(t)
  const data = Buffer.concat([png, Buffer.alloc(250000)])
  fs.writeFileSync(path.join(cwd, 'large.png'), data)
  assert.equal(readFileSafe(cwd, 'large.png').truncated, true)
  assert.equal(readFileSafe(cwd, 'large.png').imageMime, 'image/png')
  assert.deepEqual(await bytes(openProjectImage(cwd, 'large.png')), data)
})
test('traversal, absolute outside paths and symlinks escaping the project are rejected', t => {
  const { root, cwd } = project(t)
  const outside = path.join(root, 'outside.png')
  fs.writeFileSync(outside, png)
  fs.symlinkSync(outside, path.join(cwd, 'escape.png'))
  for (const p of ['../outside.png', outside, 'escape.png', '.', 'missing.png']) {
    assert.equal(openProjectImage(cwd, p), null)
    assert.equal(readFileSafe(cwd, p), null)
  }
  fs.writeFileSync(path.join(cwd, 'inside.png'), png)
  fs.symlinkSync(path.join(cwd, 'inside.png'), path.join(cwd, 'alias.png'))
  assert.equal(readFileSafe(cwd, 'alias.png').imageMime, 'image/png')
})
test('filenames cannot turn HTML or arbitrary binary into a served image; text editing metadata stays intact', t => {
  const { cwd } = project(t)
  for (const [name, content] of [['fake.png', '<html>not an image</html>'], ['a.bin', Buffer.from([1, 0, 3])], ['empty.png', '']]) {
    fs.writeFileSync(path.join(cwd, name), content)
    assert.equal(openProjectImage(cwd, name), null)
    assert.equal(readFileSafe(cwd, name).imageMime, undefined)
  }
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello')
  assert.equal(readFileSafe(cwd, 'a.txt').content, 'hello')
  assert.equal(readFileSafe(cwd, 'a.txt').binary, false)
})
test('oversized images are rejected before allocating or streaming the entire file', t => {
  const { cwd } = project(t), p = path.join(cwd, 'huge.png')
  fs.writeFileSync(p, png)
  fs.truncateSync(p, MAX_IMAGE_BYTES + 1)
  assert.deepEqual(openProjectImage(cwd, 'huge.png'), { error: 'toolarge' })
  assert.equal(readFileSafe(cwd, 'huge.png').imageMaxBytes, MAX_IMAGE_BYTES)
})
test('common raster and SVG signatures are recognized and remain image-only', () => {
  const samples = [
    ['a.jpg', Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
    ['a.gif', Buffer.from('GIF89a'), 'image/gif'],
    ['a.webp', Buffer.from('RIFF1234WEBP'), 'image/webp'],
    ['a.bmp', Buffer.from('BM1234'), 'image/bmp'],
    ['a.ico', Buffer.from([0, 0, 1, 0]), 'image/x-icon'],
    ['a.avif', Buffer.from('\0\0\0\x20ftypavif'), 'image/avif'],
    ['a.svg', Buffer.from('<?xml version="1.0"?><!-- diagram --><svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
  ]
  for (const [name, header, mime] of samples) assert.equal(imageMime(header, name), mime)
  assert.equal(imageMime(Buffer.from('<html><svg>'), 'a.svg'), null)
})
