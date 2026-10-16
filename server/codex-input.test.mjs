// node --test server/codex-input.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexInput } from './codex-driver.js'

const IMG = { media_type: 'image/png', data: 'iVBORw0KGgo=' }

test('纯文本：形状必须和原来一字不差（text_elements 不能丢）', () => {
  // app-server 的 text item 带 text_elements 字段；改造时最容易顺手删掉它。
  assert.deepEqual(buildCodexInput('hello', []), [{ type: 'text', text: 'hello', text_elements: [] }])
})

test('★ 图片在前、文本在后——与 Claude 侧一致（driver.js:594-599）', () => {
  const out = buildCodexInput('看这张图', [IMG])
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'image', '图必须排在文之前')
  assert.equal(out[1].type, 'text')
})

test('★ 图片必须内联成 data URL——app-server 明确拒绝远程 http(s) URL', () => {
  // 实证（0.130.0/0.144.6/0.146.0 三个版本一致）：
  //   {type:"image", url:"https://…"} → "remote image URLs are not supported; use an inline data URL instead"
  // 所以这里只能拼 data URL，不能传外链。
  const [img] = buildCodexInput('', [IMG])
  assert.equal(img.url, `data:image/png;base64,${IMG.data}`)
  assert.ok(!('data' in img), 'app-server 的 image variant 认 url，不认 data 字段')
})

test('多张图保持原顺序', () => {
  const a = { media_type: 'image/png', data: 'AAA' }
  const b = { media_type: 'image/jpeg', data: 'BBB' }
  const out = buildCodexInput('x', [a, b])
  assert.equal(out[0].url, 'data:image/png;base64,AAA')
  assert.equal(out[1].url, 'data:image/jpeg;base64,BBB')
  assert.equal(out[2].type, 'text')
})

test('缺 data 或 media_type 的图直接丢弃，不能拼出半截 data URL', () => {
  const out = buildCodexInput('x', [{ media_type: 'image/png' }, { data: 'AAA' }, null, undefined])
  assert.deepEqual(out, [{ type: 'text', text: 'x', text_elements: [] }])
})

test('★ 纯图片无文本：只出 image，不能产生空 text item', () => {
  // 空 text item 会让 codex 收到一条空消息；Claude 侧同样是 `if (text)` 才 push。
  const out = buildCodexInput('', [IMG])
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'image')
})

test('★ 空输入返回空数组——调用方据此拒发，而不是发一条空消息', () => {
  assert.deepEqual(buildCodexInput('', []), [])
  assert.deepEqual(buildCodexInput('', [{ bogus: 1 }]), [])
  assert.deepEqual(buildCodexInput(undefined, undefined), [])
})

test('images 传非数组不炸（防御 body.images 被塞成对象/字符串）', () => {
  assert.deepEqual(buildCodexInput('x', 'not-an-array'), [{ type: 'text', text: 'x', text_elements: [] }])
  assert.deepEqual(buildCodexInput('x', null), [{ type: 'text', text: 'x', text_elements: [] }])
})
