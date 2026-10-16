// node --test server/session-store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  encodeCwd, findClaudeJsonlByRealId, shouldPrune, serialize, parse,
  atomicWriteFile, loadStore, createSessionStore, interruptedByRestart,
} from './session-store.js'

// 每个测试用独立 tmp 目录，跑完清理
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sstore-'))
  return d
}

test('encodeCwd：非字母数字全部 → -（与 agent.js 同步）', () => {
  assert.equal(encodeCwd('/data/web_agents'), '-data-web-agents')
  assert.equal(encodeCwd('/tmp/a.b_c'), '-tmp-a-b-c')
})

test('findClaudeJsonlByRealId：命中构造路径、缺失返回 null', () => {
  const home = tmpdir()
  try {
    const cwd = '/data/proj_x'
    const realId = 'abc-123'
    const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd))
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `${realId}.jsonl`)
    fs.writeFileSync(f, '{}')
    assert.equal(findClaudeJsonlByRealId(cwd, realId, home), f)
    assert.equal(findClaudeJsonlByRealId(cwd, 'missing', home), null)
    assert.equal(findClaudeJsonlByRealId('', realId, home), null)
    assert.equal(findClaudeJsonlByRealId(cwd, '', home), null)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('shouldPrune：JSONL 缺失→true；超期→true；新鲜→false', () => {
  const now = 1_000_000_000
  const rec = { lastActiveAt: now - 5 * 86_400_000 } // 5 天前
  assert.equal(shouldPrune(rec, now, 14, false), true)  // 文件缺失优先
  assert.equal(shouldPrune(rec, now, 14, true), false)  // 5<14 天，新鲜
  assert.equal(shouldPrune({ lastActiveAt: now - 20 * 86_400_000 }, now, 14, true), true) // 超期
  assert.equal(shouldPrune({ createdAt: now - 20 * 86_400_000 }, now, 14, true), true)    // 无 lastActiveAt 用 createdAt
})

test('interruptedByRestart：持久化活跃态且无原生进程才标为中断', () => {
  assert.equal(interruptedByRestart({ lastState: 'running' }), true)
  assert.equal(interruptedByRestart({ lastState: 'waiting_approval' }), true)
  assert.equal(interruptedByRestart({ lastState: 'waiting_input' }), false) // 回合以征询收尾=已完整，不算中断（CR-005 P2）
  assert.equal(interruptedByRestart({ lastState: 'idle' }), false)
  assert.equal(interruptedByRestart({ lastState: 'running' }, true), false)
})

test('serialize/parse 往返；parse 拒绝坏形状', () => {
  const s = { 'ps-a': { psId: 'ps-a', realSessionId: 'u1' } }
  assert.deepEqual(parse(serialize(s)), s)
  assert.throws(() => parse('{"version":1}'))          // 缺 sessions
  assert.throws(() => parse('{"version":2,"sessions":{}}')) // 版本不符
  assert.throws(() => parse('not json'))
})

test('atomicWriteFile + loadStore：写读往返、0600、生成 .bak', () => {
  const dir = tmpdir()
  try {
    const file = path.join(dir, 'platform-sessions.json')
    atomicWriteFile(file, serialize({ 'ps-1': { psId: 'ps-1' } }))
    assert.deepEqual(loadStore(file), { 'ps-1': { psId: 'ps-1' } })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    // 第二次写会把上一份备份到 .bak
    atomicWriteFile(file, serialize({ 'ps-2': { psId: 'ps-2' } }))
    assert.ok(fs.existsSync(file + '.bak'))
    assert.deepEqual(loadStore(file), { 'ps-2': { psId: 'ps-2' } })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('loadStore：主文件损坏→回退 .bak；两者皆坏→空对象', () => {
  const dir = tmpdir()
  try {
    const file = path.join(dir, 'platform-sessions.json')
    atomicWriteFile(file, serialize({ 'ps-good': { psId: 'ps-good' } }))     // 主
    atomicWriteFile(file, serialize({ 'ps-newer': { psId: 'ps-newer' } }))   // .bak=ps-good, 主=ps-newer
    fs.writeFileSync(file, 'CORRUPT{')                                        // 弄坏主文件
    assert.deepEqual(loadStore(file), { 'ps-good': { psId: 'ps-good' } })    // 回退 .bak
    fs.writeFileSync(file + '.bak', 'ALSO CORRUPT')
    assert.deepEqual(loadStore(file), {})                                    // 都坏 → 空
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('atomicWriteFile：主文件不可解析时不覆盖上一份好的 .bak（CR-006 P1-d）', () => {
  const dir = tmpdir()
  try {
    const file = path.join(dir, 'platform-sessions.json')
    atomicWriteFile(file, serialize({ 'ps-good': { psId: 'ps-good' } }))     // 好主
    atomicWriteFile(file, serialize({ 'ps-2': { psId: 'ps-2' } }))           // .bak=ps-good
    fs.writeFileSync(file, 'CORRUPT{')                                        // 主文件坏
    atomicWriteFile(file, serialize({ 'ps-3': { psId: 'ps-3' } }))           // 坏主不该顶掉 .bak
    assert.deepEqual(parse(fs.readFileSync(file + '.bak', 'utf8')), { 'ps-good': { psId: 'ps-good' } })
    assert.deepEqual(loadStore(file), { 'ps-3': { psId: 'ps-3' } })          // 主已是新好文件
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('createSessionStore：落盘失败时 flush 返回 false 并记 lastWriteError（CR-006 P1-d）', () => {
  const dir = tmpdir()
  try {
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x')                       // 父路径是普通文件 → mkdir 目录必失败
    const errs = []
    const store = createSessionStore({ file: path.join(blocker, 'sub', 'ps.json'), onWriteError: (e) => errs.push(e) })
    store.upsert({ psId: 'ps-a', realSessionId: 'u1' }, { immediate: true })
    assert.equal(store.flush(), false)                  // 落盘失败要显式返回 false
    assert.ok(store.lastWriteError())                   // 且暴露错误，不再静默
    assert.ok(errs.length >= 1)                         // onWriteError 回调被调用
    assert.deepEqual(store.get('ps-a')?.psId, 'ps-a')   // 内存态不受影响
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('createSessionStore：upsert/get/remove/immediate 落盘', () => {
  const dir = tmpdir()
  try {
    const file = path.join(dir, 'platform-sessions.json')
    const store = createSessionStore({ file, debounceMs: 5 })
    store.upsert({ psId: 'ps-a', cwd: '/x', realSessionId: null }, { immediate: true })
    assert.deepEqual(loadStore(file), { 'ps-a': { psId: 'ps-a', cwd: '/x', realSessionId: null } })
    // 合并 upsert：realSessionId 到达
    store.upsert({ psId: 'ps-a', realSessionId: 'u9' }, { immediate: true })
    assert.equal(store.get('ps-a').realSessionId, 'u9')
    assert.equal(store.get('ps-a').cwd, '/x') // 旧字段保留
    // 重新 load 也能读回
    const store2 = createSessionStore({ file })
    assert.equal(store2.load()['ps-a'].realSessionId, 'u9')
    // remove 立即落盘
    store.remove('ps-a')
    assert.deepEqual(loadStore(file), {})
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('createSessionStore.prune：按 existsFn 与 maxAgeDays 剪除', () => {
  const dir = tmpdir()
  try {
    const file = path.join(dir, 'platform-sessions.json')
    const store = createSessionStore({ file })
    const now = 2_000_000_000
    store.upsert({ psId: 'ps-fresh', cwd: '/a', realSessionId: 'u1', lastActiveAt: now - 1000 }, { immediate: true })
    store.upsert({ psId: 'ps-old', cwd: '/b', realSessionId: 'u2', lastActiveAt: now - 30 * 86_400_000 }, { immediate: true })
    store.upsert({ psId: 'ps-gone', cwd: '/c', realSessionId: 'u3', lastActiveAt: now - 1000 }, { immediate: true })
    // existsFn：只有 u1/u2 的 JSONL 存在，u3 已删
    const left = store.prune(now, 14, (rec) => rec.realSessionId !== 'u3')
    assert.deepEqual(Object.keys(left).sort(), ['ps-fresh']) // old 超期、gone 文件缺失都被剪
    assert.deepEqual(Object.keys(loadStore(file)), ['ps-fresh']) // 落盘一致
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
