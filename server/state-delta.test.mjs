// node --test server/state-delta.test.mjs
//
// `/api/state` 增量下发的纯函数核心。
//
// 为什么要有（2026-08-20 实测）：前端每 3 秒全量拉一次 /api/state（53.5KB 原始 / 17KB gzip），
// 而**连续两拍之间几乎什么都没变**——20 拍同频采样里 **18/19 拍变化会话数为 0**，
// 中位 delta 占比 **0.00%**，最大 1.22%。即每次轮询有 98.8%~100% 是重复传输。
//
// 内网只是浪费；对外链路是跨境的（.189.4 → cnbypass/169.69 → 62.234），实测
// RTT 162ms、53% 的 TCP 握手需重传，同一份 17KB 经隧道 **p50 4.43s / p90 10.57s / max 16.02s**
// （hub 自身只要 65ms）。尾部越过前端 POLL_TIMEOUT_MS=20s 就被 abort（nginx 记 499，
// 当天 /api/state 50 条 = 0.67%），连续 4 次 ⇒ 用户看到「与服务器失联 100 秒」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCursor, parseCursor, cursorComparable,
  sessionFingerprint, diffSessions, mergeDelta, deltaEnabled, createVersionRing, wireMetrics, dedupeSessionsById, countDuplicateSessions, createFrameWindow, parseFullRatioThreshold
} from './state-delta.js'

// ───────────────────────── 游标 ─────────────────────────
//
// ★ 为什么游标是 `bootId:version` 而不是时间戳：
//   ① hub 聚合 5 台 agent，各机时钟不保证同步，`lastActiveAt` 由 agent 上报
//      ⇒ 拿它当游标会漏掉时钟回拨期间的变更，**且失败是静默的**（本仓库栽过时区的坑）；
//   ② hub 重启后 version 从 0 重来，纯数字游标会"看起来还有效" ⇒ 必须有 bootId 参与比较。
//      这与 resume-guard.js#canResume 用 inode 判文件世代是同一个思路：
//      **别让重置后的计数器骗过比较逻辑。**

test('游标可往返编解码', () => {
  const c = makeCursor('boot-abc', 42)
  assert.equal(typeof c, 'string')
  assert.deepEqual(parseCursor(c), { bootId: 'boot-abc', version: 42 })
})

test('非法游标一律解析为 null，不抛', () => {
  for (const bad of [undefined, null, '', 'nope', 'a:b:c', 'boot:notnum', 42, {}]) {
    assert.equal(parseCursor(bad), null, `${JSON.stringify(bad)} 应解析为 null`)
  }
})

test('★ bootId 不匹配 ⇒ 不可比较（hub 重启后 version 归零会骗过纯数字比较）', () => {
  const c = makeCursor('boot-OLD', 100)
  assert.equal(cursorComparable(c, { bootId: 'boot-NEW', minVersion: 0, curVersion: 5 }), false)
})

test('★ 版本早于保留窗口 ⇒ 不可比较（指纹快照已被淘汰，无法算差异）', () => {
  const c = makeCursor('b', 3)
  assert.equal(cursorComparable(c, { bootId: 'b', minVersion: 10, curVersion: 50 }), false)
})

test('★ 版本晚于当前 ⇒ 不可比较（客户端拿着未来的游标，只可能是状态错乱）', () => {
  const c = makeCursor('b', 99)
  assert.equal(cursorComparable(c, { bootId: 'b', minVersion: 1, curVersion: 50 }), false)
})

test('窗口内的游标可比较', () => {
  assert.equal(cursorComparable(makeCursor('b', 20), { bootId: 'b', minVersion: 10, curVersion: 50 }), true)
  assert.equal(cursorComparable(makeCursor('b', 50), { bootId: 'b', minVersion: 10, curVersion: 50 }), true, '等于当前版本也可比较（返回空 delta）')
})

test('缺游标 ⇒ 不可比较（首次加载 / 老前端）', () => {
  assert.equal(cursorComparable(undefined, { bootId: 'b', minVersion: 0, curVersion: 1 }), false)
})

// ───────────────────────── 指纹 ─────────────────────────
//
// ★ 判定「变了」用内容哈希而非逐字段比较：后者每加一个字段就要同步改，迟早漏。
// ★ 指纹必须对**裁剪后**（stateToWire 之后）的对象计算，见下面那条测试的理由。

test('字段顺序不同但内容相同 ⇒ 指纹相同（稳定序列化）', () => {
  const a = { id: 's1', state: 'idle', project: 'p' }
  const b = { project: 'p', id: 's1', state: 'idle' }
  assert.equal(sessionFingerprint(a), sessionFingerprint(b))
})

test('任一字段变化 ⇒ 指纹变化', () => {
  const a = { id: 's1', state: 'idle' }
  assert.notEqual(sessionFingerprint(a), sessionFingerprint({ ...a, state: 'running' }))
})

test('★★ 只有被裁剪字段变化时，调用方传入的是裁剪后对象 ⇒ 指纹不变', () => {
  // 这条钉的是**调用顺序**：服务端 MUST 先 stateToWire() 再算指纹。
  // 若先 diff 再裁剪，firstPrompt/lastEvent/todoStats 的变化会产生「变了但客户端看不见」
  // 的假变更——白白把整条会话重发一遍，收益归零且没人察觉。
  // （stateToWire 是纯函数且不改入参：firstPrompt 服务端内部仍用于归属判断，
  //   就地删字段会静默把会话归错项目。）
  const wire = { id: 's1', state: 'idle' }           // 裁剪后：三个字段已不在
  assert.equal(sessionFingerprint(wire), sessionFingerprint({ ...wire }))
})

// ───────────────────────── 差异 ─────────────────────────

const mk = (id, extra = {}) => ({ id, state: 'idle', project: 'p', ...extra })
const toMap = (arr) => new Map(arr.map((s) => [s.id, s]))

test('无变化 ⇒ 空变更集与空删除集', () => {
  const m = toMap([mk('a'), mk('b')])
  const d = diffSessions(m, toMap([mk('a'), mk('b')]))
  assert.deepEqual(d.changed, [])
  assert.deepEqual(d.removed, [])
})

test('单条变化只带该条', () => {
  const prev = toMap([mk('a'), mk('b'), mk('c')])
  const next = toMap([mk('a'), mk('b', { state: 'running' }), mk('c')])
  const d = diffSessions(prev, next)
  assert.equal(d.changed.length, 1)
  assert.equal(d.changed[0].id, 'b')
  assert.deepEqual(d.removed, [])
})

test('新增会话进变更集', () => {
  const d = diffSessions(toMap([mk('a')]), toMap([mk('a'), mk('z')]))
  assert.deepEqual(d.changed.map((s) => s.id), ['z'])
})

test('★ 删除必须显式列出 —— 不能让客户端靠「本次没出现」推断', () => {
  // 增量协议最经典的塌陷点：客户端无法区分「会话消失了」与「本次是增量所以没带它」。
  const d = diffSessions(toMap([mk('a'), mk('b')]), toMap([mk('a')]))
  assert.deepEqual(d.removed, ['b'])
  assert.deepEqual(d.changed, [])
})

test('★ changed 里放的是 next 的**原对象引用**，不是重新构造的', () => {
  // 这条钉的是 serverId 改写不会被绕过：hub 转发任何含会话的响应都必须把 serverId
  // 改写成 agent id（agent 自报的是 os.hostname()，而前端一切按 serverId 关联/过滤）。
  // 2026-08-03 `/api/project/sessions` 漏了这步，前端按 serverId 过滤把 8 条历史全滤掉、
  // 界面只剩 2 条——**单测和 curl 都测不出来，只有真浏览器能**。
  // 只要 diff 输出的是 state.sessions 里的原对象，改写就自动继承，不存在"第二条路"。
  const a = mk('a', { serverId: 'srv-178-232' })
  const next = toMap([a])
  const d = diffSessions(new Map(), next)
  assert.equal(d.changed[0], a, '必须是同一个对象引用')
  assert.equal(d.changed[0].serverId, 'srv-178-232')
})

// ───────────────────────── 去重（★ 影子对照挖出来的先前缺陷） ─────────────────────────
//
// 实测 /api/state 返回 72 条会话但只有 71 个唯一 id：一对 Codex 会话撞了 id，
// 且内容完全不同（token 5528 万 vs 1221 万、startedAt 差 3 小时、summary 各说各的）。
// 前端本来就按 id 去重，所以用户一直只看得到一条——**而且哪条取决于数组顺序，不确定**。

test('★ 同 id 保留最近活跃的那条', () => {
  const old = mk('x', { lastActiveAt: 100, tokens: 1 })
  const fresh = mk('x', { lastActiveAt: 900, tokens: 2 })
  assert.equal(dedupeSessionsById([old, fresh])[0].tokens, 2)
  assert.equal(dedupeSessionsById([fresh, old])[0].tokens, 2, '结果不得依赖数组顺序')
})

test('★★ 去重结果必须与输入顺序无关 —— 否则界面会自己闪', () => {
  const a = mk('x', { lastActiveAt: 500, activeMs: 10, tag: 'A' })
  const b = mk('x', { lastActiveAt: 500, activeMs: 99, tag: 'B' })
  assert.equal(dedupeSessionsById([a, b])[0].tag, 'B')
  assert.equal(dedupeSessionsById([b, a])[0].tag, 'B', 'lastActiveAt 并列时按 activeMs，仍要确定')
})

test('缺 lastActiveAt 的条目不得意外胜出', () => {
  const good = mk('x', { lastActiveAt: 100 })
  const bad = mk('x', {})
  assert.equal(dedupeSessionsById([bad, good])[0].lastActiveAt, 100)
  assert.equal(dedupeSessionsById([good, bad])[0].lastActiveAt, 100)
})

test('无重复时原样返回', () => {
  const arr = [mk('a'), mk('b'), mk('c')]
  assert.equal(dedupeSessionsById(arr).length, 3)
})

test('重复计数可观测（这个缺陷有多普遍要能看见）', () => {
  assert.equal(countDuplicateSessions([mk('a'), mk('a'), mk('b')]), 1)
  assert.equal(countDuplicateSessions([mk('a'), mk('b')]), 0)
  assert.equal(countDuplicateSessions([]), 0)
})

test('★ 去重后 diff 的「合并 ≡ 全量」才成立（这条正是影子对照报错的原因）', () => {
  // 影子对照实测：kind="length" a=31 b=32，且 onlyInMerged/onlyInNow 都是空 ——
  // id 集合完全相同、条数不同 ⇒ 只可能是重复 id 被 Map 折叠。
  const withDup = [mk('a'), mk('b', { lastActiveAt: 1 }), mk('b', { lastActiveAt: 2 })]
  assert.equal(withDup.length, 3)
  const clean = dedupeSessionsById(withDup)
  assert.equal(clean.length, 2)
  const merged = mergeDelta({ sessions: [] }, { frame: 'delta', changed: diffSessions(new Map(), toMap(clean)).changed, removed: [] })
  assert.equal(merged.sessions.length, clean.length, '去重后长度才对得上')
})

// ───────────────────────── 合并 ─────────────────────────

test('合并 delta 后得到完整 state', () => {
  const local = { sessions: [mk('a'), mk('b')], servers: [{ id: 's' }] }
  const out = mergeDelta(local, {
    frame: 'delta',
    changed: [mk('b', { state: 'running' }), mk('c')],
    removed: ['a'],
    servers: [{ id: 's' }],
  })
  assert.deepEqual(out.sessions.map((s) => s.id).sort(), ['b', 'c'])
  assert.equal(out.sessions.find((s) => s.id === 'b').state, 'running')
})

test('★★ 多轮增量 ≡ 同刻全量（等价性）', () => {
  // 随机变更序列：每轮随机改/加/删，比对「逐轮合并」与「直接用最终全量」。
  let truth = [mk('s0'), mk('s1'), mk('s2'), mk('s3'), mk('s4')]
  let local = { sessions: truth.map((s) => ({ ...s })) }
  let seed = 7
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }

  for (let round = 0; round < 40; round++) {
    const prev = toMap(truth.map((s) => ({ ...s })))
    const op = rnd(3)
    if (op === 0 && truth.length) truth[rnd(truth.length)].state = ['idle', 'running', 'done'][rnd(3)]
    else if (op === 1) truth.push(mk(`new${round}`))
    else if (truth.length > 1) truth.splice(rnd(truth.length), 1)

    const d = diffSessions(prev, toMap(truth.map((s) => ({ ...s }))))
    local = mergeDelta(local, { frame: 'delta', changed: d.changed, removed: d.removed })

    const a = [...local.sessions].sort((x, y) => x.id.localeCompare(y.id))
    const b = [...truth].sort((x, y) => x.id.localeCompare(y.id))
    assert.deepEqual(a, b, `第 ${round} 轮后增量结果必须与全量逐字段相等`)
  }
})

test('snapshot 帧整份替换本地', () => {
  const out = mergeDelta({ sessions: [mk('old')] }, { frame: 'snapshot', sessions: [mk('new')] })
  assert.deepEqual(out.sessions.map((s) => s.id), ['new'])
})

test('★ 未知帧类型按 snapshot 安全兜底，不得静默丢数据', () => {
  const out = mergeDelta({ sessions: [mk('old')] }, { frame: 'wat', sessions: [mk('new')] })
  assert.deepEqual(out.sessions.map((s) => s.id), ['new'])
})

// ───────────────────────── 字节量（★ 独立于等价性） ─────────────────────────
//
// ★★ 为什么这条不能省，而且必须与等价性测试分开：
//   **全量永远算对**，所以「增量完全没生效」时等价性测试照样全绿。
//   jsonl-ingest 那次的实测证据：人为打断 resume 后，等价性与 truncate 测试都绿，
//   **只有读放大测试变红**。若有人把 delta 改回每次返回 snapshot，功能全对、只是慢，
//   一条错都不报——这正是本仓库反复强调的「可静默退化的收益必须有指标钉住」。

const sz = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8')

test('★★ 无变化时 delta 帧 < 同刻快照的 5%（此测试在改回全量时必须变红）', () => {
  const sessions = Array.from({ length: 72 }, (_, i) =>
    mk(`s${i}`, { summary: 'x'.repeat(90), tokensBreakdown: { a: 1, b: 2, c: 3 }, cwd: '/data/proj' }))
  const snapshot = { frame: 'snapshot', sessions }
  const m = toMap(sessions)
  const d = diffSessions(m, toMap(sessions.map((s) => ({ ...s }))))
  const delta = { frame: 'delta', changed: d.changed, removed: d.removed }
  const ratio = sz(delta) / sz(snapshot)
  assert.ok(ratio < 0.05, `无变化时 delta 应远小于快照，实测 ${(ratio * 100).toFixed(2)}%`)
})

test('★ 单条变化时 delta 仍应 < 快照的 10%（72 条里变 1 条 ≈ 1.4%）', () => {
  const sessions = Array.from({ length: 72 }, (_, i) => mk(`s${i}`, { summary: 'x'.repeat(90) }))
  const next = sessions.map((s, i) => (i === 3 ? { ...s, state: 'running' } : s))
  const d = diffSessions(toMap(sessions), toMap(next))
  const ratio = sz({ frame: 'delta', changed: d.changed, removed: d.removed }) / sz({ frame: 'snapshot', sessions: next })
  assert.ok(ratio < 0.10, `实测 ${(ratio * 100).toFixed(2)}%`)
})

// ───────────────────────── 版本环 ─────────────────────────

test('★★ 内容不变时版本不前进 —— 这条决定收益是 0% 还是 98%', () => {
  // 若每个请求都推进版本，客户端游标永远落后一拍 ⇒ delta 退化成「每拍都有变化」。
  // 功能全对、字节没省，而且**正确性测试完全测不出来**。
  const r = createVersionRing()
  const s = [mk('a'), mk('b')]
  const v1 = r.resolve(s)
  const v2 = r.resolve(s.map((x) => ({ ...x })))     // 内容相同、对象不同
  assert.equal(v2.version, v1.version)
  assert.equal(v2.advanced, false)
})

test('内容变化时版本前进', () => {
  const r = createVersionRing()
  const v1 = r.resolve([mk('a')])
  const v2 = r.resolve([mk('a', { state: 'running' })])
  assert.equal(v2.version, v1.version + 1)
  assert.equal(v2.advanced, true)
})

test('会话数量变化（新增/删除）也算变化', () => {
  const r = createVersionRing()
  const v1 = r.resolve([mk('a')])
  assert.equal(r.resolve([mk('a'), mk('b')]).version, v1.version + 1)
  assert.equal(r.resolve([mk('a')]).version, v1.version + 2)
})

test('★ 超出保留窗口的版本被淘汰，其游标随即不可比较', () => {
  const r = createVersionRing(3)
  for (let i = 0; i < 5; i++) r.resolve([mk('a', { state: `s${i}` })])
  assert.equal(r.size(), 3)
  assert.equal(r.fpsAt(1), null, '第 1 版应已被淘汰')
  assert.equal(cursorComparable(makeCursor('b', 1), { bootId: 'b', minVersion: r.minVersion(), curVersion: 5 }), false)
})

test('保留窗口内的版本可取回指纹表用于 diff', () => {
  const r = createVersionRing(8)
  const v1 = r.resolve([mk('a'), mk('b')])
  r.resolve([mk('a'), mk('b', { state: 'running' })])
  const prev = r.fpsAt(v1.version)
  assert.ok(prev, '窗口内必须取得到')
  const d = diffSessions(prev, new Map([['a', mk('a')], ['b', mk('b', { state: 'running' })]]))
  assert.deepEqual(d.changed.map((s) => s.id), ['b'])
})

// ───────────────────────── 指标 ─────────────────────────

test('★ 分母为 0 时不得返回 Infinity/NaN —— 那会让告警长鸣，等于没有告警', () => {
  const m = wireMetrics({})
  assert.ok(Number.isFinite(m.state_full_ratio))
  assert.equal(m.state_full_ratio, 0)
})

test('全是增量 ⇒ full_ratio ≈ 0', () => {
  assert.equal(wireMetrics({ snapshots: 0, deltas: 100 }).state_full_ratio, 0)
})

test('★★ 退化回全量 ⇒ full_ratio 升到 1（这是本指标存在的唯一理由）', () => {
  // 若有人在 hub 层把 delta 改回每次返回 snapshot，state-delta.js 的单测**一条都不会红**
  // ——功能全对、只是慢。只有这个数会动。
  assert.equal(wireMetrics({ snapshots: 100, deltas: 0 }).state_full_ratio, 1)
  assert.ok(wireMetrics({ snapshots: 95, deltas: 5 }).state_full_ratio > 0.9)
})

test('省下的字节不得为负（快照比全量还大是不可能的，但别让它变成负数吓人）', () => {
  assert.equal(wireMetrics({ fullBytes: 100, sentBytes: 300 }).state_bytes_saved, 0)
  assert.equal(wireMetrics({ fullBytes: 1000, sentBytes: 50 }).state_bytes_saved, 950)
})

// ───────────────────────── 开关 ─────────────────────────

test('★ 只有显式 "0" 关闭；拼错值保持启用（不得静默降级）', () => {
  assert.equal(deltaEnabled({ WA_STATE_DELTA: '0' }), false)
  assert.equal(deltaEnabled({ WA_STATE_DELTA: 'flase' }), true, '拼错必须保持启用，否则是静默降级')
  assert.equal(deltaEnabled({ WA_STATE_DELTA: 'false' }), true, '只认 "0"，与 WA_JSONL_INCREMENTAL 同口径')
  assert.equal(deltaEnabled({}), true, '默认启用')
})

// ───────────────── 退化看门狗：窗口比率 ─────────────────
//
// 这一组测的是「看门狗会不会响」，不是「功能对不对」。本仓库两次栽在这上面：
// cgroup 节流计数读在没设限的叶子层上恒为 0、SSE 心跳写成注释行浏览器根本不暴露给 JS——
// 两次都是**装了看门狗但结构上永远不会响**，和没装完全一样。

test('窗口比率：样本不足返回 null，不是 0', () => {
  const w = createFrameWindow(200, 100)
  for (let i = 0; i < 99; i++) w.record('delta')
  // ★ 返回 0 会被 `< 阈值` 判成"健康"，等于空闲期把看门狗焊死在绿灯上。
  assert.strictEqual(w.ratio(), null)
  w.record('delta')
  assert.strictEqual(w.ratio(), 0)
})

test('窗口比率：稳态（1 快照 + 199 增量）远低于阈值', () => {
  const w = createFrameWindow(200, 100)
  w.record('snapshot')
  for (let i = 0; i < 199; i++) w.record('delta')
  assert.ok(w.ratio() < 0.05, `稳态比率应 <5%，实际 ${w.ratio()}`)
})

test('★ 退化成"总是全量"时窗口比率必须爬到 1（看门狗会响）', () => {
  const w = createFrameWindow(200, 100)
  for (let i = 0; i < 200; i++) w.record('delta')   // 先攒一窗好数据
  assert.ok(w.ratio() < 0.05)
  for (let i = 0; i < 200; i++) w.record('snapshot') // 有人把 delta 改回全量
  assert.strictEqual(w.ratio(), 1)
})

test('★★ 窗口比率必须比累计比率先越过阈值 —— 否则告警形同虚设', () => {
  // 这条钉的是"为什么不用累计比率"：跑了一周好数据后退化，累计比率被历史稀释，
  // 要几万帧才爬得过阈值，而这期间看门狗一声不吭。
  const w = createFrameWindow(200, 100)
  let snaps = 0, total = 0
  for (let i = 0; i < 20_000; i++) { w.record('delta'); total++ }   // 一周好数据
  for (let i = 0; i < 200; i++) { w.record('snapshot'); snaps++; total++ } // 退化后 200 帧
  const cumulative = snaps / total
  assert.strictEqual(w.ratio(), 1)                    // 窗口：立刻满格
  assert.ok(cumulative < 0.02, `累计比率仍只有 ${cumulative}`)  // 累计：仍在阈值以下
})

test('阈值解析：非法值退回默认，不得得到 NaN 把告警焊死', () => {
  // `ratio > NaN` 恒为 false ⇒ 永不触发，比用默认值更危险且悄无声息。
  assert.strictEqual(parseFullRatioThreshold('0.3'), 0.3)
  assert.strictEqual(parseFullRatioThreshold('flase'), 0.5)
  assert.strictEqual(parseFullRatioThreshold(undefined), 0.5)
  assert.strictEqual(parseFullRatioThreshold('0'), 0.5)     // 0 会让告警长鸣
  assert.strictEqual(parseFullRatioThreshold('1.5'), 0.5)   // 比率不可能 >1
})
