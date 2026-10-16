// node --test server/proc-index.test.mjs
//
// `/proc` 索引化 —— 本 Change 实测影响最大的一项（P1）。
//
// 背景（2026-08-13 实测，srv-178-232）：
//   单次 buildState 消耗 **5,354 次 read()**，平均每次 **109 字节**
//   —— 那是 `/proc/<pid>/cmdline` 的尺寸，不是 JSONL 行。
//   strace 8 秒归因：`.jsonl` 打开 4 次，`/proc/*` 打开 13,885 次。
//
// 根因：`agent.js:912` 把 `realIdActiveInProc()` 放进了 detached 别名循环**内部**，
// 每条别名都把整个 `/proc` 重扫一遍 ⇒ O(会话数 × 进程数)。
//   理论值 (1+N)×180，N=25 时 4,680，与实测 5,354 同量级。
//
// ★ 本模块的铁律：**只改「怎么拿到」，不改「拿到之后怎么判」。**
//   所以下面有几条测试是**故意钉住既有行为的**，包括一个已知 bug（见「纯 kimi 进程」那条）。
//   静默修好 bug 的重构，等于放弃了等价性验证——bug 要修，但必须是一个独立可见的决定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProcIndex, createProcIndex } from './proc-index.js'

const e = (cmdline, cwd = '/data/p') => ({ cmdline, cwd })

// ───────────────────────── 纯函数：索引构建 ─────────────────────────

test('claude 进程的 cwd 进 claude 集合', () => {
  const ix = buildProcIndex([e('claude\0--resume\0abc', '/data/web_agents')])
  assert.ok(ix.claude.has('/data/web_agents'))
  assert.equal(ix.codex.size, 0)
})

test('codex 进程的 cwd 进 codex 集合', () => {
  const ix = buildProcIndex([e('codex\0app-server', '/data/gitops')])
  assert.ok(ix.codex.has('/data/gitops'))
  assert.equal(ix.claude.size, 0)
})

test('同时匹配 claude 与 codex 的 cmdline 两个集合都进', () => {
  const ix = buildProcIndex([e('node\0claude-codex-bridge', '/data/x')])
  assert.ok(ix.claude.has('/data/x'))
  assert.ok(ix.codex.has('/data/x'))
})

test('★ 保留既有行为：纯 kimi 进程被跳过，kimi 集合拿不到它', () => {
  // agent.js:136 `if (!isClaude && !isCodex) continue` —— isKimi 算了却不参与放行判断。
  // 后果：`active.kimi`（agent.js:1104 消费）实际上恒为空，Kimi 项目的「活跃」标记从不点亮。
  // ⚠️ 这是**已知 bug**，本 Change 刻意不修——修它会改变 UI 行为，应当是独立决定。
  //    这条测试是它的书面记录：将来修好时，这里会红，那正是提醒「行为变了，去确认 UI」。
  const ix = buildProcIndex([e('kimi\0acp', '/data/kimi-proj')])
  assert.equal(ix.kimi.size, 0, '既有实现下纯 kimi 进程不入集合（bug 已记录）')
})

test('kimi 只有在同时匹配 claude/codex 时才入集合（既有行为）', () => {
  const ix = buildProcIndex([e('claude\0kimi-plugin', '/data/both')])
  assert.ok(ix.kimi.has('/data/both'))
})

test('cwd 读不到（进程已退出/无权限）时不入任何 cwd 集合', () => {
  const ix = buildProcIndex([{ cmdline: 'claude\0--resume\0abc', cwd: null }])
  assert.equal(ix.claude.size, 0)
})

// ───────────────────── realId 查询：语义必须与原实现一致 ─────────────────────

test('★ hasRealId 只在 claude 的 cmdline 里做子串匹配', () => {
  // 原 realIdActiveInProc：`/claude/i.test(cmdline) && cmdline.includes(realId)`
  const ix = buildProcIndex([e('claude\0--resume\0UUID-1', '/data/a')])
  assert.equal(ix.hasRealId('UUID-1'), true)
  assert.equal(ix.hasRealId('UUID-2'), false)
})

test('★ codex 的 cmdline 里出现同样的 id 不算命中', () => {
  const ix = buildProcIndex([e('codex\0--thread\0UUID-1', '/data/a')])
  assert.equal(ix.hasRealId('UUID-1'), false, '原实现要求 /claude/i.test(cmdline)')
})

test('空 realId 一律 false', () => {
  const ix = buildProcIndex([e('claude\0--resume\0UUID-1')])
  assert.equal(ix.hasRealId(''), false)
  assert.equal(ix.hasRealId(null), false)
  assert.equal(ix.hasRealId(undefined), false)
})

test('★ cwd 读失败不影响 hasRealId —— 原实现压根不读 cwd', () => {
  const ix = buildProcIndex([{ cmdline: 'claude\0--resume\0UUID-9', cwd: null }])
  assert.equal(ix.hasRealId('UUID-9'), true, 'realId 查询与 cwd 无关，不得被 readlink 失败拖累')
})

test('子串匹配而非整词匹配（保留原 includes 语义）', () => {
  const ix = buildProcIndex([e('claude\0--resume\0abc-123-def', '/data/a')])
  assert.equal(ix.hasRealId('123'), true, '原实现是 cmdline.includes(realId)，不是分词')
})

// ───────────────────── ★ 核心：一次遍历服务两类查询 ─────────────────────

test('★★ 一次遍历同时产出 cwd 集合与 realId 查询能力（P1 的全部意义）', () => {
  let scans = 0
  const read = () => { scans++; return [e('claude\0--resume\0U1', '/data/a'), e('codex\0x', '/data/b')] }
  const ix = createProcIndex({ read, ttlMs: 10_000, now: () => 1000 })

  const snap = ix.get()
  // 模拟 buildState：先用 cwd 集合，再对 N 条别名逐个查 realId
  snap.claude.has('/data/a')
  for (let i = 0; i < 25; i++) snap.hasRealId(`U${i}`)

  assert.equal(scans, 1, '25 条别名 + cwd 查询 MUST 只触发一次 /proc 遍历（原实现是 26 次）')
})

// ───────────────────────── memo 窗口 ─────────────────────────

test('memo 窗口内不重复遍历', () => {
  let scans = 0
  let t = 1000
  const read = () => { scans++; return [] }
  const ix = createProcIndex({ read, ttlMs: 200, now: () => t })
  ix.get(); ix.get(); ix.get()
  assert.equal(scans, 1)
  t = 1150            // 仍在 200ms 窗口内
  ix.get()
  assert.equal(scans, 1)
})

test('memo 窗口过期后重新遍历', () => {
  let scans = 0
  let t = 1000
  const ix = createProcIndex({ read: () => { scans++; return [] }, ttlMs: 200, now: () => t })
  ix.get()
  t = 1201            // 越过窗口
  ix.get()
  assert.equal(scans, 2)
})

test('★ 时钟回拨不得把缓存永久钉死', () => {
  // 本仓库栽过同型：闸门被焊死 8/8 导致全部超时。任何 memo 都必须能自己释放。
  let scans = 0
  let t = 10_000
  const ix = createProcIndex({ read: () => { scans++; return [] }, ttlMs: 200, now: () => t })
  ix.get()
  assert.equal(scans, 1)
  t = 5_000           // 时钟回拨
  ix.get()
  assert.equal(scans, 2, '时间倒退时 MUST 重新遍历，不能因为 now-last<0 就当成"还新鲜"')
})

test('ttlMs=0 表示每次都重新遍历', () => {
  let scans = 0
  const ix = createProcIndex({ read: () => { scans++; return [] }, ttlMs: 0, now: () => 1000 })
  ix.get(); ix.get()
  assert.equal(scans, 2)
})

test('★★ fresh() 绕过 memo —— 接管守卫这条路必须拿新鲜数据', () => {
  // hasLiveWriter 是「能不能接管」的安全闸。它一年跑不了几次（用户点按钮才触发），
  // 但判错的代价是**用户一条出路都没有**（本仓库栽过：mtime 判活把「恢复会话」按死）。
  // ⇒ 稀有 + 高代价 ⇒ 宁可多扫一次也要新鲜。而 buildState 每 3 秒一次，才是该吃 memo 的那条路。
  let scans = 0
  const ix = createProcIndex({ read: () => { scans++; return [] }, ttlMs: 10_000, now: () => 1000 })
  ix.get()
  assert.equal(scans, 1)
  ix.get()
  assert.equal(scans, 1, 'memo 生效')
  ix.fresh()
  assert.equal(scans, 2, 'fresh() MUST 重扫，即使 memo 窗口远未过期')
})

test('fresh() 之后 get() 复用刚拿到的新鲜结果，不再多扫一次', () => {
  let scans = 0
  const ix = createProcIndex({ read: () => { scans++; return [] }, ttlMs: 10_000, now: () => 1000 })
  ix.fresh()
  ix.get()
  assert.equal(scans, 1, 'fresh() 应刷新缓存而非绕过缓存，否则连着调会重复扫')
})

test('read 抛异常时返回空索引且不崩（/proc 不可读的降级）', () => {
  const ix = createProcIndex({ read: () => { throw new Error('EACCES') }, ttlMs: 200, now: () => 1 })
  const snap = ix.get()
  assert.equal(snap.claude.size, 0)
  assert.equal(snap.hasRealId('x'), false)
})
