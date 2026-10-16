import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findKimi, mapModeValue, mapModelValue, selectPermissionOption } from './kimi-driver.js'

test('Kimi 安装发现：识别官方 ~/.kimi-code/bin 路径', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kimi-discovery-'))
  const oldHome = process.env.HOME, oldBin = process.env.KIMI_BIN
  try {
    const bin = path.join(home, '.kimi-code', 'bin', 'kimi')
    fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o700 })
    process.env.HOME = home; delete process.env.KIMI_BIN
    assert.equal(findKimi(), bin)
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    if (oldBin === undefined) delete process.env.KIMI_BIN; else process.env.KIMI_BIN = oldBin
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Kimi 审批：按 Web resolution 选择对应 ACP option', () => {
  const options = [
    { optionId: 'a1', kind: 'allow_once' },
    { optionId: 'aa', kind: 'allow_always' },
    { optionId: 'r1', kind: 'reject_once' },
  ]
  assert.equal(selectPermissionOption(options, '允许一次').optionId, 'a1')
  assert.equal(selectPermissionOption(options, '本会话始终允许').optionId, 'aa')
  assert.equal(selectPermissionOption(options, '拒绝').optionId, 'r1')
})

test('Kimi 审批：上游选项不完整时安全回退', () => {
  const onlyAllow = [{ optionId: 'a1', kind: 'allow_once' }]
  assert.equal(selectPermissionOption(onlyAllow, '本会话始终允许').optionId, 'a1')
  assert.equal(selectPermissionOption([], '拒绝'), null)
})

test('Kimi 模式：Web 模式映射到 ACP 实际暴露值', () => {
  const options = [{ value: 'default' }, { value: 'plan' }, { value: 'auto' }]
  assert.equal(mapModeValue('default', options), 'default')
  assert.equal(mapModeValue('plan', options), 'plan')
  assert.equal(mapModeValue('auto', options), 'auto')
  assert.equal(mapModeValue('acceptEdits', options), 'auto')
  assert.equal(mapModeValue('unknown', options), null)
})

test('Kimi 模型：官方 Model ID 匹配 ACP provider-qualified 值', () => {
  const options = [
    { value: 'kimi-code/k3' },
    { value: 'kimi-code/k3-256k' },
    'kimi-code/kimi-for-coding',
  ]
  assert.equal(mapModelValue('k3', options), 'kimi-code/k3')
  assert.equal(mapModelValue('kimi-code/k3-256k', options), 'kimi-code/k3-256k')
  assert.equal(mapModelValue('kimi-for-coding', options), 'kimi-code/kimi-for-coding')
  assert.equal(mapModelValue('kimi-for-coding-highspeed', options), null)
  assert.equal(mapModelValue('k3', []), 'k3')
})
