// node --test server/liveness.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideLiveWriter } from './liveness.js'

const W = 30 * 60_000
const d = (o) => decideLiveWriter({ realIdInProc: false, cwdHasClaude: false, ageMs: 0, windowMs: W, ...o })

test('★ 文件新 ≠ 有人在写：没有写者进程时，mtime 再新也不得拦', () => {
  // 这是用户实际踩到的死胡同：为验证性能修复对生产 JSONL 跑了 60s 的 touch 循环 →
  // 旧判据（age < 90s ⇒ running）把「恢复会话」按死，报「该会话正在终端中运行」——
  // 而那台机上根本没有任何进程在跑它，用户面前一条出路都没有。
  assert.equal(d({ ageMs: 0 }), false, 'mtime 刚被 touch，但无进程 → 必须放行')
  assert.equal(d({ ageMs: 1 }), false)
})

test('显式续接同一会话（claude --resume <realId>）→ 铁证，必拦（双写会损坏 JSONL）', () => {
  assert.equal(d({ realIdInProc: true, ageMs: 999 * 60_000 }), true, '哪怕文件很久没动，进程攥着就是攥着')
  assert.equal(d({ realIdInProc: true, cwdHasClaude: false }), true, 'cwd 可以不同（在别处 resume）')
})

test('项目里有 claude 进程 + 文件近期在写 → 拦（新建会话的 cmdline 没有 uuid，只能靠 cwd 抓）', () => {
  assert.equal(d({ cwdHasClaude: true, ageMs: 5_000 }), true)
  assert.equal(d({ cwdHasClaude: true, ageMs: W - 1 }), true)
})

test('项目里有 claude 进程但文件长期没动 → 视为挂起/僵尸，放行（交 force 由用户裁决）', () => {
  assert.equal(d({ cwdHasClaude: true, ageMs: W + 1 }), false)
  assert.equal(d({ cwdHasClaude: true, ageMs: 24 * 3600_000 }), false)
})
