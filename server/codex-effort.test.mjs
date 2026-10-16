// effortForModel：把请求的推理档归一到「该模型实际支持」的档位。
// 跑：node --test server/codex-effort.test.mjs
//
// 背景：旧实现是 `['low','medium','high'].includes(e) ? e : 'high'` —— 写于 xhigh/max/ultra 出现之前，
// 于是 createSession 默认的 effort='xhigh' 被**静默降级成 high**。线上实测所有 codex 会话都是
// effort=high 才发现。这组用例把「跟着模型走、不写死枚举」钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortForModel } from './codex-driver.js'

const SOL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] // gpt-5.6-sol
const OLD = ['low', 'medium', 'high', 'xhigh']                 // gpt-5.5 / 5.4

test('模型支持该档 → 原样返回（xhigh 不再被打成 high）', () => {
  assert.equal(effortForModel('xhigh', SOL), 'xhigh')
  assert.equal(effortForModel('xhigh', OLD), 'xhigh')
  assert.equal(effortForModel('high', OLD), 'high')
})

test('新模型独有的档（max/ultra）在支持它的模型上可用', () => {
  assert.equal(effortForModel('max', SOL), 'max')
  assert.equal(effortForModel('ultra', SOL), 'ultra')
})

test('模型不支持该档 → 降到「不超过请求档的最高可用档」，而不是一律 high', () => {
  assert.equal(effortForModel('ultra', OLD), 'xhigh') // gpt-5.5 最高只到 xhigh
  assert.equal(effortForModel('max', OLD), 'xhigh')
})

test('未知档位 → 落到 high（安全默认）', () => {
  assert.equal(effortForModel('bogus', SOL), 'high')
  assert.equal(effortForModel('', OLD), 'high')
})

test('拿不到模型档位表（codex 未装/超时）→ 按全集判定，不误降级', () => {
  assert.equal(effortForModel('xhigh', undefined), 'xhigh')
  assert.equal(effortForModel('ultra', []), 'ultra')
})

test('低档原样，不会被"提升"', () => {
  assert.equal(effortForModel('low', SOL), 'low')
  assert.equal(effortForModel('medium', OLD), 'medium')
})
