// agent 侧采集器的回归测试（openspec change: execution-history-archive，P0）。
//
// agent 侧只负责**只读地**暴露语料：枚举 + 按区间读。采集的驱动与 checkpoint 都在中心
// （见 archive-pull.js 的方向订正），所以这里不涉及任何水位推进。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listCorpus, inventory, readRange } from './archive-collect.js'

/** 造一个假的 $HOME，里面有三引擎的语料 */
function fakeHome({ claude = {}, codex = {}, kimi = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-home-'))
  const put = (rel, name, body) => {
    const d = path.join(home, rel)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, name), body)
  }
  for (const [proj, files] of Object.entries(claude))
    for (const [n, b] of Object.entries(files)) put(`.claude/projects/${proj}`, n, b)
  for (const [proj, files] of Object.entries(codex))
    for (const [n, b] of Object.entries(files)) put(`.codex/sessions/${proj}`, n, b)
  for (const [proj, files] of Object.entries(kimi))
    for (const [n, b] of Object.entries(files)) put(`.kimi-code/sessions/${proj}`, n, b)
  return home
}

/** ⚠️ checkpoint 必须落在临时目录 —— 绝不碰真实的 ~/.web-agents/archive-ckpt.json */
const ck = (home) => path.join(home, 'ckpt.json')

const line = (i) => JSON.stringify({ i, t: 'x'.repeat(80) })
const body = (n) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'

test('★ 三引擎的语料都被枚举到 —— 不得只覆盖 Claude', () => {
  const home = fakeHome({
    claude: { '-data-a': { 'c1.jsonl': body(3) } },
    codex: { s1: { 'rollout-x.jsonl': body(3) } },
    kimi: { k1: { 'wire.jsonl': body(3) } },
  })
  const engines = new Set(listCorpus(home).map((f) => f.engine))
  assert.deepEqual([...engines].sort(), ['claude', 'codex', 'kimi'])
})

test('codex 只收 rollout-*.jsonl，其它 jsonl 不收', () => {
  const home = fakeHome({ codex: { s1: { 'rollout-a.jsonl': body(2), 'other.jsonl': body(2) } } })
  const names = listCorpus(home).map((f) => path.basename(f.path))
  assert.deepEqual(names, ['rollout-a.jsonl'])
})

test('★ 探针残留不进清单', () => {
  const home = fakeHome({
    claude: { '-tmp-wa-usage-probe': { 'p.jsonl': body(4) }, '-data-real': { 'r.jsonl': body(4) } },
  })
  const projects = inventory(home).map((x) => x.project)
  assert.deepEqual(projects, ['-data-real'])
})


// ───────────────── 按区间读（供中心拉取）─────────────────

test('★★ readRange 只允许读语料根之下的路径 —— 这是暴露给中心的读接口，必须防穿越', () => {
  const home = fakeHome({ claude: { '-data-a': { 'c1.jsonl': body(2) } } })
  const ok = path.join(home, '.claude/projects/-data-a/c1.jsonl')
  assert.ok(readRange(ok, 0, 100, home).length > 0)
  for (const bad of ['/etc/passwd', path.join(home, '.ssh/id_rsa'), path.join(home, '.claude/../.ssh/id_rsa')]) {
    assert.throws(() => readRange(bad, 0, 100, home), /语料根/, `不该允许读 ${bad}`)
  }
})

test('readRange 按字节区间返回，越界安全', () => {
  const home = fakeHome({ claude: { '-data-a': { 'c1.jsonl': 'abcdefghij' } } })
  const p = path.join(home, '.claude/projects/-data-a/c1.jsonl')
  assert.equal(readRange(p, 2, 3, home), 'cde')
  assert.equal(readRange(p, 8, 999, home), 'ij')
  assert.equal(readRange(p, 999, 10, home), '')
})
