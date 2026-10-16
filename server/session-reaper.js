/**
 * 挂起会话回收判定（AM-260718-401 要求 3）。
 *
 * 要抓的东西很具体：干完活不退、空转占内存的孤儿。总工今天清掉的那个实测特征是
 * 「47min 存活、39min 无 JSONL 写入、CPU~0%、占 265M」；用户侧还报过「存活 390 分钟的挂起会话」。
 *
 * ⚠️ 这是**破坏性**判定，红线直接沿用 liveness.js 那条教训的反面：
 * 当年 `mtime age < 90s ⇒ 有人在写 ⇒ 拒绝接管`，结果一个 touch/rsync 就把用户的会话锁死，
 * 用户一条出路都没有。回收比拦截更狠——收错了是直接杀掉正在干活的会话。
 * 所以这里一律**宁可漏杀不可错杀**：任何一项证据缺失（探测不到 CPU、探测不到 JSONL 活动）
 * 就当作"可能还活着"，跳过本轮。terminal.js 的回收循环也是这个路子（拿不到 pane 信息就整轮跳过），
 * 而且它当年把空闲窗口从 30min 放宽到 24h，就是因为用户报"会话突然消失"。
 */

/** CPU 采样噪声容忍：真正空转的进程两次采样之间不累计 CPU 时间，读数就是 0；留一点余量防抖。 */
const CPU_EPSILON = 0.5

/**
 * 由两次 /proc/<pid>/stat 采样算 CPU 占用百分比。
 *
 * utime+stime 是**进程生命周期累计**的 tick 数，直接拿来判断"此刻在不在动"是错的
 * （一个跑了 5 天、现在睡死的进程，累计值依然很大）。必须求两次采样的差。
 * 采样间隔就是回收循环的周期，因此这是一个区间平均值，比瞬时采样更抗抖动。
 *
 * @param prev {{ticks:number, atMs:number}|null} 上一轮采样；首轮为 null
 * @param cur  {{ticks:number, atMs:number}}      本轮采样
 * @param hz   每秒 tick 数（Linux 上通常 100，即 sysconf(_SC_CLK_TCK)）
 * @returns {number|null} 百分比；无法可信计算时返回 null（调用方须当作"不确定"→不回收）
 */
export function cpuPercentFromSamples(prev, cur, hz = 100) {
  if (!prev || !cur) return null
  const dtMs = cur.atMs - prev.atMs
  if (dtMs <= 0) return null
  const dTicks = cur.ticks - prev.ticks
  // 负增长只可能是 pid 被复用（原进程已退、新进程占了同号）——采样跨了两个不同进程，不可信。
  if (dTicks < 0) return null
  return (dTicks / hz) / (dtMs / 1000) * 100
}

const no = (reason) => ({ reap: false, reason })
const yes = (reason) => ({ reap: true, reason })

const mins = (ms) => Math.round(ms / 60_000)
/** 有限数判定（本模块没有现成的；`x > NaN` 恒 false 会把判据悄悄焊死）。 */
const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * @param {object} s
 * @param {'platform'|'shadow'} [s.origin]  只回收平台会话派生的进程；影子会话是终端里的独立进程，不归我们管
 * @param {string}  s.state                 六态之一
 * @param {boolean} s.inflight              回合是否真在飞
 * @param {boolean} [s.hasPending]          是否有待用户处理的待办
 * @param {number}  s.ageMs                 会话存活时长
 * @param {number|null} s.jsonlIdleMs       距上次 JSONL 写入的时长；探测不到给 null
 * @param {number|null} s.cpuPercent        近期 CPU 占用；探测不到给 null
 * @param {boolean} [s.procAlive]           承载进程是否还在
 * @param {number}  s.idleReapMs            静默态回收阈值
 * @param {number}  s.waitingReapMs         等待用户态回收阈值（应显著更长）
 * @param {number}  s.minAgeMs              最小存活保护期
 * @returns {{reap:boolean, reason:string}}
 */
/**
 * inflight 豁免的**上限**：声称"回合在飞"但 transcript 已静默这么久，就判为挂死。
 * 默认 30min —— 与 idleReapMs 同量级：真在跑的回合不可能半小时不写一个字。
 */
export const DEFAULT_INFLIGHT_GRACE_MS = 30 * 60_000

/**
 * CPU 豁免的上限，**刻意比 inflight 宽得多**（默认 3 小时）。
 *
 * 理由是两类证据的歧义程度不同：
 * · 「声称回合在飞但 30 分钟没写一个字」——真在跑的回合不会这样，判尸体风险低。
 * · 「CPU 在动但没写 transcript」——**真有歧义**：可能是尸体在内存颠簸空转，
 *   也可能是一次 40 分钟的构建/测试（本仓库 2026-08-15 就有一条会话在跑
 *   `tsc --noEmit` 跑了 17.5 小时）。
 *
 * ★ 代价不对称，所以阈值也该不对称：**误杀活会话 = 用户丢工作**（不可逆），
 *   **漏收尸体 = 内存泄漏**（会累积成整机冻死，但有几小时的余量）。
 *   事故里那些尸体静默了 **25.4 小时**，3 小时的线足够抓住它们，
 *   同时给正常的长构建留出充裕空间。
 */
export const DEFAULT_CPU_GRACE_MS = 3 * 60 * 60_000

export function decideReap({
  origin = 'platform',
  state,
  inflight = false,
  hasPending = false,
  ageMs,
  jsonlIdleMs,
  cpuPercent,
  cpuApplicable = true,
  procAlive = true,
  idleReapMs,
  waitingReapMs,
  minAgeMs,
  unattributedIdleMs,
  inflightGraceMs,
  cpuGraceMs,
}) {
  if (origin !== 'platform') return no('影子会话不归平台回收')

  // 进程都没了，留着的只是内存里的记录 —— 这个不用等阈值，纯粹是垃圾。
  if (procAlive === false) return yes('承载进程已不存在（僵尸记录）')

  // 回合真在飞：正在流式输出 / 工具已提议未执行。杀它就是拦腰截断用户的活。
  //
  // ★★ 但**豁免必须有上限**（2026-08-30 事故整改）：driver 里
  //   `inflight = (state === 'running' || state === 'waiting_approval')`，
  //   而**一个挂死的会话，其状态恰恰永远停在 running**（收不到 turn_end）⇒ inflight 恒为 true
  //   ⇒ 无上限的豁免会把**最该回收的那些**永久保护起来。
  //   事故实证：一条存活 28.9h、JSONL 已静默 25.4h 的会话（它 3 小时后就死了）
  //   仍占着内存；而且**尸体的 CPU 和 read_bytes 反而最高**——它在做
  //   "页面被踢出→读回→再踢出"的颠簸空转，看起来比谁都忙。
  //   ⚠️ 同族教训：「fail-safe 的跳过若能永远成立，就是免死金牌」。
  //
  //   判据仍然只用 JSONL 静默时长——真在干活的回合一定在写 transcript。
  //   ⚠️ 探测不到 jsonlIdleMs 时保持豁免：证据不全一律不动手。
  if (inflight) {
    const grace = finite(inflightGraceMs) && inflightGraceMs > 0 ? inflightGraceMs : DEFAULT_INFLIGHT_GRACE_MS
    if (!finite(jsonlIdleMs)) return no('回合在飞且探测不到 JSONL 活动，保守跳过')
    if (jsonlIdleMs < grace) return no(`回合在飞（JSONL ${mins(jsonlIdleMs)}min 前仍在写），不回收`)
    // 落到这里：声称在飞，但 transcript 已静默超过宽限 ⇒ 判为挂死，继续走下面的常规判据
  }

  // 刚创建的会话还没来得及写 JSONL，jsonlIdleMs 会显得极大 —— 必须靠存活时长兜住，
  // 否则新会话一落地就被自己的回收器杀掉。
  if (!(ageMs >= minAgeMs)) return no(`会话仅存活 ${mins(ageMs)}min，未过保护期`)

  // ↓↓ fail-safe：证据不全一律不动手 ↓↓
  if (jsonlIdleMs == null) return no('探测不到 JSONL 活动时间，保守跳过')

  // 等待用户决策的会话给显著更长的窗口：用户可能只是去吃饭了，
  // 但挂到几小时（用户报过 390min）就确实是没人管了。
  const waitingForHuman = hasPending || state === 'waiting_approval' || state === 'waiting_input'
  const baseLimit = waitingForHuman ? waitingReapMs : idleReapMs

  // Codex 的多个 thread 共享同一个 codex app-server 进程，没有"属于本会话的 CPU"可测
  // （cpuApplicable=false）。此时若还坚持要 CPU 佐证，Codex 会话就永远不满足回收条件、
  // 永久占着并发槽位把队列饿死。改用 driver 内存里的 inflight（turnActive/startingTurn）——
  // 那是 app-server 协议级的权威状态，比外部 CPU 采样更准，上面已经判过了。
  //
  // ⚠️ Claude 侧有**同一个病的另一种得法**（2026-07-19 线上事故，232 闸门焊死在 8/8）：
  // attributePid() 的慢路径是 `cwdSessionCount.get(cwd) !== 1 → null`，即**同一项目开多个
  // 会话就归属不到 pid** —— 而这是正常用法（实测 /data/claude_manager 6 个 claude 进程、
  // /data/web_agents 6 个、/data/zonggong 5 个，没有一个是 1）。于是 cpuPercent 恒为 null，
  // 旧代码直接 `return no('探测不到 CPU')` → 槽位**永不归还** → 闸门满 → 新建/接管全部
  // 排队 45s → hub 15s 先超时 → 用户只看到「超时」。
  //
  // 「测不到」不能等于「永久豁免」，否则槽位泄漏就有了免死金牌。改用唯一还可信的独立
  // 证据 —— JSONL 静默时长 —— 但要求**显著更长**的窗口（默认 3× idleReapMs），
  // 以维持「宁可漏杀不可错杀」。inflight 已在上面拦过，等待用户态取两者更长的那个。
  let limit = baseLimit
  let unattributed = false
  let thrashing = null
  if (cpuApplicable) {
    if (cpuPercent == null) {
      unattributed = true
      limit = Math.max(unattributedIdleMs ?? idleReapMs * 3, baseLimit)
    } else if (cpuPercent > CPU_EPSILON) {
      // ★★ CPU 豁免同样必须有上限（2026-08-30 事故整改）。
      //   复盘实测：**尸体的 CPU 和 read_bytes 反而是全场最高的**——它在做
      //   「页面被踢出→读回→再踢出」的颠簸空转（workingset_refault 19867 页/秒、
      //   6 个会话 30 秒内各读 400~960MB）。
      //   ★ **「CPU 在动」证明不了「在干活」**；内存颠簸时它恰恰是垂死的证据。
      //   真在干活的会话一定在写 transcript ⇒ 判据仍然只信 JSONL 静默时长。
      const g = finite(cpuGraceMs) && cpuGraceMs > 0 ? cpuGraceMs : DEFAULT_CPU_GRACE_MS
      if (!finite(jsonlIdleMs) || jsonlIdleMs < g) {
        return no(`CPU ${cpuPercent}% 仍在动，不回收`)
      }
      thrashing = cpuPercent            // 记下来，让理由文案说人话（不能报成 "CPU≈0"）
      // CPU 在动但 transcript 静默已超 CPU 宽限 ⇒ 极可能是颠簸空转，继续走时长判据
    }
  }

  if (jsonlIdleMs < limit) {
    return no(unattributed
      ? `空闲 ${mins(jsonlIdleMs)}min，未达未归属阈值 ${mins(limit)}min（pid 归属不到，窗口已放宽）`
      : `空闲 ${mins(jsonlIdleMs)}min，未达 ${mins(limit)}min 阈值`)
  }
  // ⚠️ 理由文案必须如实：CPU 90% 的颠簸尸体不能报成 "CPU≈0"，那会让人看着日志怀疑判据坏了。
  const cpuNote = thrashing != null ? `CPU ${thrashing}% 但在颠簸空转` : 'CPU≈0'
  return yes(unattributed
    ? `空闲 ${mins(jsonlIdleMs)}min 无 JSONL 写入，且 pid 归属不到（同 cwd 多会话）已超放宽窗口 ${mins(limit)}min（存活 ${mins(ageMs)}min）`
    : `空闲 ${mins(jsonlIdleMs)}min 无 JSONL 写入且 ${cpuNote}（存活 ${mins(ageMs)}min）`)
}

/**
 * 有上限地释放一个挂起会话；释放不动就按 skill hung-agent-session-rescue 的解救 SOP 杀进程。
 *
 * 为什么必须有上限：driver.release() 内部 `await handle.interrupt()` **没有超时**，
 * 对着一个卡死的子进程可以永远挂住（实测 25s+ 不返回）。而回收器要收的**正是**这种会话
 * —— 不设上限，回收循环就卡在第一个僵尸上再也不动，而一个从不触发的看门狗
 * 和一个坏掉的看门狗长得一模一样。
 *
 * 杀进程是安全的：JSONL 是权威源且完好无损，会话退回影子态，之后仍能 takeover/reattach 续上。
 * 而且杀掉子进程会让 SDK 的流关闭，上面挂住的 interrupt 随之了结，release 才真正走完
 * （否则 driver 内部的 sessions.delete 永远执行不到，会话会一直挂着被反复重试）。
 *
 * @returns {'released'|'killed'|'stuck'} stuck = 没能确认收掉，调用方应**保留槽位**别放新会话进来
 */
export async function releaseWithDeadline({
  release, pid, kill, sleep,
  timeoutMs = 10_000, killGraceMs = 2_000, postKillMs = 5_000,
}) {
  let done = false
  const settle = () => { done = true }
  const releasing = release().then(settle, settle) // 抛错也算了结，别把回收循环卡死
  const nap = (ms) => sleep(ms)

  await Promise.race([releasing, nap(timeoutMs)])
  if (done) return 'released'
  // 归属不到进程就不敢乱杀——错杀 = 掐掉别人正在干的活。保守放弃本轮。
  if (!pid) return 'stuck'

  kill(pid, 'SIGTERM')
  await Promise.race([releasing, nap(killGraceMs)])
  if (done) return 'killed'

  kill(pid, 'SIGKILL') // 卡死进程通常不响应 SIGTERM，这恰好印证它是僵尸
  await Promise.race([releasing, nap(postKillMs)])
  // SIGKILL 是**不可捕获**的：只要投递出去，进程必死、内存必然被回收。
  // 所以即便 release 的 promise 还没落地（SDK 那边的 interrupt 可能永远不 settle），
  // 也判 killed —— 若在这里返回 stuck，调用方会把槽位永久扣住，
  // 等于为一个**确定已被杀掉**的会话永久缩减容量，与闸门的目的背道而驰。
  return 'killed'
}
