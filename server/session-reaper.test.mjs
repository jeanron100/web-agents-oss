// node --test server/session-reaper.test.mjs
// AM-260718-401 要求 3：挂起会话超时回收。
// 总工给的实测特征：孤儿会话「47min 存活、39min 无 JSONL 写入、CPU~0%、占 265M」——干完活不退。
//
// ⚠️ 回收是**破坏性**操作，这里的红线沿用 liveness.js 的教训（"文件新 ≠ 有人在写"的反面）：
// 宁可漏杀，不可错杀。terminal.js 当年把空闲窗口从 30min 放宽到 24h，就是因为用户报
// "会话突然消失"。所以任何一项证据缺失/探测失败 → 一律不回收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideReap, cpuPercentFromSamples, releaseWithDeadline } from './session-reaper.js'

const MIN = 60_000
// 默认：静默态 30min 无活动可回收；等待用户的态 6h；会话至少存活 10min 才纳入判定
const base = {
  state: 'idle', inflight: false, hasPending: false,
  ageMs: 47 * MIN, jsonlIdleMs: 39 * MIN, cpuPercent: 0, procAlive: true,
  idleReapMs: 30 * MIN, waitingReapMs: 6 * 60 * MIN, minAgeMs: 10 * MIN,
}
const d = (o) => decideReap({ ...base, ...o })

test('★ 总工实测的孤儿特征：47min 存活 / 39min 无 JSONL / CPU≈0 → 回收', () => {
  const r = d({})
  assert.equal(r.reap, true)
  assert.match(r.reason, /空闲/)
})

test('★ CPU 在跑 → 宽限期内不回收（原断言为「绝不」，2026-08-30 事故后加了上限）', () => {
  // 默认夹具静默 39min，远小于 CPU 宽限 3h ⇒ 仍受保护（长构建/长测试的正常形态）
  assert.equal(d({ cpuPercent: 12 }).reap, false)
  assert.equal(d({ cpuPercent: 0.9 }).reap, false, '接近 0 但非 0 也算在动')
  // ★ 但静默超过 CPU 宽限（3h）后不再豁免：事故里的尸体正是「CPU 最高 + 静默 25.4h」
  assert.equal(d({ cpuPercent: 90, jsonlIdleMs: 25.4 * 60 * MIN, ageMs: 28.9 * 60 * MIN }).reap, true)
})

test('★ CPU 宽限刻意比 inflight 宽得多 —— 两类证据的歧义程度不同', () => {
  // 「CPU 在动但没写 transcript」真有歧义（可能是 40 分钟的构建）；
  // 「声称在飞却 30 分钟没写一个字」几乎不可能是真在跑。
  // 静默 2h：inflight 早该失效，但 CPU 豁免仍在（未到 3h）
  assert.equal(d({ cpuPercent: 30, jsonlIdleMs: 120 * MIN }).reap, false)
  assert.equal(d({ cpuPercent: 0, inflight: true, jsonlIdleMs: 120 * MIN }).reap, true)
})

test('★ 探测不到 CPU（null/undefined）→ 保守不回收（fail-safe）', () => {
  assert.equal(d({ cpuPercent: null }).reap, false)
  assert.equal(d({ cpuPercent: undefined }).reap, false)
})

test('★ 探测不到 JSONL 活动时间 → 保守不回收', () => {
  assert.equal(d({ jsonlIdleMs: null }).reap, false)
})

test('JSONL 近期有写入 → 不回收（会话在推进）', () => {
  assert.equal(d({ jsonlIdleMs: 5 * MIN }).reap, false)
})

test('★ 刚创建的年轻会话不回收：还没来得及写 JSONL，别把它当孤儿', () => {
  // 新会话 jsonlIdleMs 可能因为文件还没落地而显得极大 —— 必须靠 ageMs 兜住
  assert.equal(d({ ageMs: 2 * MIN, jsonlIdleMs: 999 * MIN }).reap, false)
})


// ⚠️ 修订说明（2026-08-30 事故整改）：本组三条原本断言「inflight ⇒ **无论多安静**都不回收」。
//    那条不变量的本意是"别腰斩用户正在跑的回合"，但实际效果相反——
//    **挂死的会话状态恰恰永远停在 running**（driver 收不到 turn_end），于是
//    `inflight` 恒为 true，**最该被回收的那些反而拿到了免死金牌**。
//    事故实证：一条存活 28.9h、transcript 已静默 25.4h（3 小时后就死了）的会话
//    占着内存直到人工清理。CPU 豁免同理——尸体因为内存颠簸，CPU 反而是全场最高的。
//    现在豁免有上限（inflightGraceMs，默认 30min），判据仍只用 JSONL 静默时长。
//    **不是拆掉防线，是给防线加了个"证据必须还成立"的条件。**
test('★ 在飞回合（inflight）在**宽限期内**不回收（原断言为「无论多安静」，已收紧）', () => {
  // 宽限期内（transcript 5 分钟前还在写）⇒ 真在干活，受保护
  assert.equal(d({ state: 'running', inflight: true, jsonlIdleMs: 5 * MIN }).reap, false)
  // 超过宽限（静默 300min）⇒ 判为挂死，必须可收 —— 这正是事故里那类会话
  assert.equal(d({ state: 'running', inflight: true, jsonlIdleMs: 300 * MIN }).reap, true)
})

test('★ 等待用户的会话用【更长】阈值：用户可能只是去吃饭了', () => {
  // waiting_approval 39min → 不回收（远没到 6h）
  assert.equal(d({ state: 'waiting_approval', hasPending: true }).reap, false)
  assert.equal(d({ state: 'waiting_input', hasPending: true }).reap, false)
  // 但挂到 390min（总工报的"存活 390 分钟的挂起会话"）且超过 6h 窗 → 该收了
  const long = d({ state: 'waiting_approval', hasPending: true, ageMs: 400 * MIN, jsonlIdleMs: 400 * MIN })
  assert.equal(long.reap, true)
})

test('进程已不在（procAlive=false）→ 回收，这是纯粹的僵尸记录', () => {
  const r = d({ procAlive: false, jsonlIdleMs: 1 * MIN, cpuPercent: null })
  assert.equal(r.reap, true)
  assert.match(r.reason, /进程/)
})

test('影子会话不归本回收器管（只回收平台会话派生出的进程）', () => {
  assert.equal(d({ origin: 'shadow' }).reap, false)
})

test('回收决策必须带可读原因，便于事后审计"谁把我的会话收了"', () => {
  const r = d({})
  assert.equal(typeof r.reason, 'string')
  assert.ok(r.reason.length > 0)
})

// ---- Codex：多 thread 共享一个 codex app-server 进程，没有"本会话的 CPU"可测 ----
// 所以对 Codex 不能用 CPU 佐证，否则它永远不满足回收条件 → 永久占着并发槽位 → 队列饿死。
// 替代证据是 driver 内存里的 turnActive/startingTurn（即 inflight），那是协议级的权威状态，
// 比外部 CPU 采样更准。

test('★ Codex（CPU 不适用）：靠 inflight + 空闲时长判定，不因缺 CPU 而永不回收', () => {
  const r = d({ cpuApplicable: false, cpuPercent: null })
  assert.equal(r.reap, true, 'Codex 会话不能因为测不到 CPU 就永远占着槽位')
})

test('★ Codex 在飞回合在宽限期内不回收（inflight 是权威证据，但豁免有上限）', () => {
  assert.equal(d({ cpuApplicable: false, cpuPercent: null, inflight: true, jsonlIdleMs: 5 * MIN }).reap, false)
  // 但超过宽限后不再豁免（Codex 的挂死会话同样会把状态卡在 running）
  assert.equal(d({ cpuApplicable: false, cpuPercent: null, inflight: true, jsonlIdleMs: 300 * MIN }).reap, true)
})

test('Codex 空闲未达阈值 → 不回收', () => {
  assert.equal(d({ cpuApplicable: false, cpuPercent: null, jsonlIdleMs: 5 * MIN }).reap, false)
})

// ---- CPU 采样：/proc/<pid>/stat 的 utime+stime 是**累计**值，必须两次采样求差 ----
// skill hung-agent-session-rescue 的判定表要的是"进程此刻在不在动"，不是"这辈子用过多少 CPU"。

test('★ 没有上一次采样 → null（首轮一律不回收，天然 fail-safe）', () => {
  assert.equal(cpuPercentFromSamples(null, { ticks: 500, atMs: 1000 }), null)
})

test('两次采样 ticks 没变 → 0%，这就是空转孤儿的特征', () => {
  const p = cpuPercentFromSamples({ ticks: 500, atMs: 0 }, { ticks: 500, atMs: 60_000 })
  assert.equal(p, 0)
})

test('1 秒内涨 100 ticks（hz=100）→ 约 100%（满一核）', () => {
  const p = cpuPercentFromSamples({ ticks: 0, atMs: 0 }, { ticks: 100, atMs: 1_000 }, 100)
  assert.ok(Math.abs(p - 100) < 0.01, `应约 100%，实测 ${p}`)
})

test('60 秒内涨 30 ticks → 0.5%（低但非零，仍算在动）', () => {
  const p = cpuPercentFromSamples({ ticks: 0, atMs: 0 }, { ticks: 30, atMs: 60_000 }, 100)
  assert.ok(Math.abs(p - 0.5) < 0.01, `应约 0.5%，实测 ${p}`)
})

test('★ ticks 变小 → null：pid 被复用了，采样不可信，宁可不收', () => {
  assert.equal(cpuPercentFromSamples({ ticks: 900, atMs: 0 }, { ticks: 12, atMs: 60_000 }), null)
})

test('两次采样时间戳没推进 → null（除零/时钟异常）', () => {
  assert.equal(cpuPercentFromSamples({ ticks: 0, atMs: 5_000 }, { ticks: 10, atMs: 5_000 }), null)
  assert.equal(cpuPercentFromSamples({ ticks: 0, atMs: 9_000 }, { ticks: 10, atMs: 5_000 }), null)
})

// ---- releaseWithDeadline：回收时"释放不动就杀进程" ----
// 实测：driver.release() 内部 `await handle.interrupt()` 没有超时，对着卡死的子进程 25s+ 不返回。
// 而回收器要收的**正是**这种会话 → 不设上限，回收循环就卡在第一个僵尸上再也不动。
// 处置沿用 skill hung-agent-session-rescue 的解救 SOP：SIGTERM 杀不动 → SIGKILL。
// JSONL 是权威源且不受影响，会话退回影子态仍可 takeover/reattach。

const noSleep = () => Promise.resolve()
const rw = (o) => releaseWithDeadline({
  release: () => Promise.resolve(),
  pid: 4242, kill: () => {}, sleep: noSleep,
  timeoutMs: 10, killGraceMs: 5, postKillMs: 5, ...o,
})

test('release 正常完成 → released，不碰进程', async () => {
  const killed = []
  const r = await rw({ kill: (pid, sig) => killed.push(sig) })
  assert.equal(r, 'released')
  assert.deepEqual(killed, [], '正常释放不该杀任何进程')
})

test('★ release 挂住 → SIGTERM 仍不动 → SIGKILL，最终判 killed', async () => {
  // 即使 release 的 promise 永远不落地（SDK 的 interrupt 可能就是不 settle），只要 SIGKILL
  // 投递出去了就判 killed：SIGKILL 不可捕获 ⇒ 进程必死 ⇒ 内存必然回收。
  // 这里若判 stuck，调用方会为一个**确定已被杀掉**的会话永久扣住槽位，等于白白缩减容量。
  const killed = []
  const r = await rw({
    release: () => new Promise(() => {}),      // 永不 resolve，模拟卡死的 interrupt
    kill: (pid, sig) => { assert.equal(pid, 4242); killed.push(sig) },
  })
  assert.deepEqual(killed, ['SIGTERM', 'SIGKILL'], '应先温和后强杀')
  assert.equal(r, 'killed')
})

test('★ SIGTERM 之后 release 终于走完 → 不再补 SIGKILL', async () => {
  const killed = []
  let resolve
  const p = new Promise((r) => { resolve = r })
  const r = await rw({
    release: () => p,
    kill: (pid, sig) => { killed.push(sig); if (sig === 'SIGTERM') resolve() },
    sleep: () => new Promise((r) => setTimeout(r, 1)), // 给 release 的 then 一个落地的机会
  })
  assert.deepEqual(killed, ['SIGTERM'], 'SIGTERM 已奏效就不该再 SIGKILL')
  assert.equal(r, 'killed')
})

test('★ 归属不到 pid 时绝不乱杀 → stuck（调用方据此保留槽位）', async () => {
  const killed = []
  const r = await rw({ release: () => new Promise(() => {}), pid: null, kill: (p, s) => killed.push(s) })
  assert.equal(r, 'stuck')
  assert.deepEqual(killed, [], '没有可信归属就不许杀任何进程')
})

test('release 抛错也算了结，不能把回收循环卡死', async () => {
  const r = await rw({ release: () => Promise.reject(new Error('session not found')) })
  assert.equal(r, 'released')
})

test('★ 任何情况下都会返回，不会无限等待', async () => {
  const r = await rw({ release: () => new Promise(() => {}), kill: () => {} })
  assert.ok(['killed', 'stuck'].includes(r))
})

// ---- pid 归属不到时的兜底（2026-07-19 线上事故：232 闸门被永久焊死在 8/8）----
// attributePid() 的慢路径是 `cwdSessionCount.get(cwd) !== 1 → null`，即**同一项目开多个会话
// 就归属不到 pid**。而这恰恰是正常用法：实测 232 上 /data/claude_manager 有 6 个 claude 进程、
// /data/web_agents 6 个、/data/zonggong 5 个 —— 没有一个是 1。
// 于是 cpuPercent 恒为 null → 走「探测不到 CPU，保守跳过」→ 槽位**永不归还** →
// 闸门 8/8 焊死 → 所有新建/接管请求排队 45s → hub 15s 先超时 → 用户看到「超时」。
//
// 这跟上面 Codex 那组是同一个病：把「测不到」当成「永久豁免」，等于给槽位泄漏发了免死金牌。
// 解法也一致——改用唯一还可信的独立证据（JSONL 静默时长），但要求**显著更长**的窗口，
// 以维持「宁可漏杀不可错杀」。
const UNATTR = 90 * MIN // 默认 3× idleReapMs

test('★ pid 归属不到（cpuPercent=null）但已静默超过未归属阈值 → 回收，否则槽位永久泄漏', () => {
  const r = d({ cpuPercent: null, jsonlIdleMs: 95 * MIN, ageMs: 120 * MIN })
  assert.equal(r.reap, true, '同项目多开会话时 pid 必然归属不到，不能因此永久占着槽位')
})

test('★ pid 归属不到 + 未达未归属阈值 → 仍然保守不回收（原 fail-safe 不能削弱）', () => {
  assert.equal(d({ cpuPercent: null, jsonlIdleMs: 39 * MIN }).reap, false)
  assert.equal(d({ cpuPercent: null, jsonlIdleMs: 89 * MIN }).reap, false, '差一点也不收')
})

test('★ pid 归属不到 + 回合在飞 → 宽限期内不回收（inflight 优先，但不再无限期）', () => {
  assert.equal(d({ cpuPercent: null, jsonlIdleMs: 5 * MIN, inflight: true }).reap, false)
  // 静默 999min 还说"在飞"就是尸体：pid 归属不到也不再是护身符
  assert.equal(d({ cpuPercent: null, jsonlIdleMs: 999 * MIN, inflight: true }).reap, true)
})

test('★ pid 归属不到 + 等待用户态 → 取更长的那个窗口，别把在等人的会话提前收走', () => {
  // 未归属阈值 90min < waitingReapMs 6h：等待态必须仍按 6h 走，不能被 90min 提前收掉
  const waiting = { cpuPercent: null, state: 'waiting_input', hasPending: true }
  assert.equal(d({ ...waiting, jsonlIdleMs: 95 * MIN }).reap, false, '95min 没到 6h，不能收')
  assert.equal(d({ ...waiting, jsonlIdleMs: 400 * MIN, ageMs: 400 * MIN }).reap, true)
})

test('★ 未归属阈值可配置；未指定时默认 3× idleReapMs', () => {
  // 显式传入更短的窗口应当立即生效（运维可按机器负载调紧）
  const r = d({ cpuPercent: null, jsonlIdleMs: 45 * MIN, unattributedIdleMs: 40 * MIN })
  assert.equal(r.reap, true)
  // 不传时用默认 90min（= 3 × 30min）
  assert.equal(d({ cpuPercent: null, jsonlIdleMs: UNATTR + MIN, ageMs: 200 * MIN }).reap, true)
})

test('回收原因必须点明是「未归属 pid」路径，便于事后审计', () => {
  const r = d({ cpuPercent: null, jsonlIdleMs: 95 * MIN, ageMs: 120 * MIN })
  assert.match(r.reason, /归属|未归属|pid/i)
})

// ───────── 2026-08-30 事故整改：inflight 豁免会把最该收的会话永久保护起来 ─────────
//
// 事故：.232 被 9 个会话拖到 load 35.37，全机 D 状态，agent 自身停服 65 分钟。
// 日志坐实 19:48 → 20:54 **66 分钟零输出**，而它一恢复（20:54）立刻收掉两条——
// 说明**判据是对的，是回收器跟着主进程一起被饿死了**。
//
// ★★ 但另有一个结构性缺陷，比"被饿死"更根本：
//   driver.js 里 `inflight = (state === 'running' || state === 'waiting_approval')`，
//   而 decideReap 第一条就是 `if (inflight) return no('回合在飞，不回收')`。
//   **一个挂死的会话，其状态恰恰永远停在 running**（driver 收不到 turn_end）⇒
//   `inflight` 恒为 true ⇒ **最该被回收的那些，正是回收器拒绝碰的那些**。
//   豁免本意是"别腰斩正在干活的回合"，实际效果是"给尸体发免死金牌"。
//
// ⚠️ 与本仓库既有教训同族：「fail-safe 的跳过若能永远成立，就是免死金牌」。

test('★★ inflight 但 JSONL 已长时间静默 ⇒ 必须可回收（尸体不得因为"回合在飞"而豁免）', () => {
  const v = decideReap({
    origin: 'platform', state: 'running', inflight: true,
    ageMs: 28.9 * 3600_000,          // 事故里那条：存活 28.9h
    jsonlIdleMs: 25.4 * 3600_000,    // 静默 25.4h —— 它 3 小时后就死了
    cpuPercent: 90,                  // ⚠️ 尸体的 CPU 反而最高（在做颠簸空转）
    idleReapMs: 30 * 60_000, waitingReapMs: 6 * 3600_000,
    minAgeMs: 10 * 60_000, unattributedIdleMs: 90 * 60_000,
    inflightGraceMs: 30 * 60_000,
  })
  assert.equal(v.reap, true, `不该豁免：${v.reason}`)
  // ⚠️ 理由文案必须如实说出"CPU 高但在颠簸"，不能报成 CPU≈0 —— 那会让人看日志时怀疑判据坏了
  assert.match(v.reason, /颠簸/, v.reason)
})

test('★ 真正在飞的回合仍然受保护 —— 不能把"别腰斩用户的活"这条防线拆了', () => {
  const v = decideReap({
    origin: 'platform', state: 'running', inflight: true,
    ageMs: 60 * 60_000,
    jsonlIdleMs: 20_000,             // 20 秒前还在写 —— 真的在干活
    cpuPercent: 50,
    idleReapMs: 30 * 60_000, waitingReapMs: 6 * 3600_000,
    minAgeMs: 10 * 60_000, unattributedIdleMs: 90 * 60_000,
    inflightGraceMs: 30 * 60_000,
  })
  assert.equal(v.reap, false)
  assert.match(v.reason, /在飞/)
})

test('★ inflight 宽限期可配，且非法值不得算出 NaN 把豁免变成永久', () => {
  // `idle > NaN` 恒 false ⇒ 永远豁免，比用默认值更危险且悄无声息。
  for (const bad of [undefined, null, 'x', -1]) {
    const v = decideReap({
      origin: 'platform', state: 'running', inflight: true,
      ageMs: 10 * 3600_000, jsonlIdleMs: 9 * 3600_000, cpuPercent: 0,
      idleReapMs: 30 * 60_000, waitingReapMs: 6 * 3600_000,
      minAgeMs: 10 * 60_000, unattributedIdleMs: 90 * 60_000,
      inflightGraceMs: bad,
    })
    assert.equal(v.reap, true, `inflightGraceMs=${String(bad)} 时静默 9 小时仍不收，说明豁免被焊死`)
  }
})

test('★ 探测不到 JSONL 活动时，inflight 仍然保护（证据不全一律不动手）', () => {
  const v = decideReap({
    origin: 'platform', state: 'running', inflight: true,
    ageMs: 10 * 3600_000, jsonlIdleMs: null, cpuPercent: 0,
    idleReapMs: 30 * 60_000, waitingReapMs: 6 * 3600_000,
    minAgeMs: 10 * 60_000, unattributedIdleMs: 90 * 60_000, inflightGraceMs: 30 * 60_000,
  })
  assert.equal(v.reap, false)
})
