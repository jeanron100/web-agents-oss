// server/proc-index.js — `/proc` 一次遍历建索引，供多方 O(1)/O(小) 查询。
//
// 为什么存在（2026-08-13 实测，srv-178-232）：
//   单次 buildState 消耗 **5,354 次 read()**，平均每次 109 字节 —— 那是 `/proc/<pid>/cmdline`。
//   strace 8 秒归因：`.jsonl` 打开 4 次，`/proc/*` 打开 13,885 次。
//   根因：`realIdActiveInProc()` 被放在 detached 别名循环**内部**，每条别名重扫一遍整个 `/proc`
//   ⇒ O(会话数 × 进程数)，理论 (1+N)×180，N=25 时 4,680，与实测同量级。
//
// ★ 铁律：**只改「怎么拿到」，不改「拿到之后怎么判」。**
//   本模块逐字保留 `agent.js` 原 `activeCliCwds()` / `realIdActiveInProc()` 的判据，
//   **包括一个已知 bug**：`if (!isClaude && !isCodex) continue` 让纯 kimi 进程进不了 kimi 集合
//   （`active.kimi` 在 agent.js:1104 被消费，实际恒空）。该 bug 由 proc-index.test.mjs 明文钉住，
//   修它会改变 UI 行为，应当是一个独立可见的决定，不夹带在重构里。
//
// ⚠️ `liveness.js#decideLiveWriter` 的判活语义不受本模块影响——它拿到 `realIdInProc` /
//    `cwdHasClaude` 之后怎么判，一个字都没动。

/**
 * 纯函数：由 `/proc` 条目构建索引。
 * @param {Array<{cmdline:string, cwd:string|null}>} entries
 */
export function buildProcIndex(entries) {
  const claude = new Set()
  const codex = new Set()
  const kimi = new Set()
  const claudeCmdlines = []

  for (const entry of entries || []) {
    const cmdline = entry?.cmdline || ''
    const isClaude = /claude/i.test(cmdline)
    const isCodex = /codex/i.test(cmdline)
    const isKimi = /kimi/i.test(cmdline)

    // realId 查询只看 cmdline、不读 cwd —— 必须在下面的 continue 与 cwd 判空**之前**收集，
    // 否则 readlink 失败的进程会从 realId 查询里消失（原实现压根不读它的 cwd）。
    if (isClaude) claudeCmdlines.push(cmdline)

    if (!isClaude && !isCodex) continue   // ← 逐字保留（含 kimi bug，见文件头）
    const cwd = entry?.cwd
    if (cwd == null) continue             // ← 等价于原实现 readlinkSync 抛错被 catch 吞掉
    if (isClaude) claude.add(cwd)
    if (isCodex) codex.add(cwd)
    if (isKimi) kimi.add(cwd)
  }

  return {
    claude,
    codex,
    kimi,
    /**
     * 等价于原 `realIdActiveInProc(realId)`：在 claude 进程的 cmdline 里做**子串**匹配。
     * O(claude 进程数) 而非 O(全部进程数)——前者实测个位数，后者 180。
     */
    hasRealId(realId) {
      if (!realId) return false
      return claudeCmdlines.some((c) => c.includes(realId))
    },
  }
}

const EMPTY = () => buildProcIndex([])

/**
 * 带 memo 的索引工厂。
 * @param {object} o
 * @param {() => Array<{cmdline:string,cwd:string|null}>} o.read 读取 `/proc` 条目
 * @param {number} o.ttlMs memo 窗口，默认 200ms（`/proc` 状态不需要毫秒级新鲜度，
 *                         而 `/api/state` 可能 3 秒内被打多次）
 * @param {() => number} o.now
 */
export function createProcIndex({ read, ttlMs = 200, now = Date.now } = {}) {
  let cached = null
  let cachedAt = 0
  return {
    get() {
      const t = now()
      const age = t - cachedAt
      // ★ age < 0 也要重扫：时钟回拨时若当成"还新鲜"，缓存会被永久钉死。
      //   本仓库栽过同型（闸门焊死 8/8 致全部超时）——任何 memo 都必须能自己释放。
      if (cached && ttlMs > 0 && age >= 0 && age < ttlMs) return cached
      let entries = []
      try { entries = read() } catch { entries = [] }  // /proc 不可读 ⇒ 空索引，不崩
      cached = buildProcIndex(entries)
      cachedAt = t
      return cached
    },
    /**
     * 立刻重扫并刷新缓存，返回新鲜索引。
     *
     * 给**接管守卫**（`hasLiveWriter`）用：它一年跑不了几次（用户点按钮才触发），
     * 但判错的代价是"用户一条出路都没有"——本仓库栽过（mtime 判活把「恢复会话」按死）。
     * 稀有 + 高代价 ⇒ 宁可多扫一次也要新鲜。而 buildState 每 3 秒一次，才是该吃 memo 的那条。
     *
     * 注意是**刷新**而非绕过：刷完写回缓存，紧接着的 get() 直接复用，不会连扫两遍。
     */
    fresh() {
      let entries = []
      try { entries = read() } catch { entries = [] }
      cached = buildProcIndex(entries)
      cachedAt = now()
      return cached
    },
    /** 测试与运维用：强制下一次 get() 重扫。 */
    invalidate() { cached = null; cachedAt = 0 },
  }
}

/** 默认的 `/proc` 读取实现。抽出来是为了让纯逻辑可测。 */
export function makeProcReader(fs, root = '/proc') {
  return () => {
    const out = []
    let pids = []
    try { pids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)) } catch { return out }
    for (const pid of pids) {
      let cmdline
      try { cmdline = fs.readFileSync(`${root}/${pid}/cmdline`, 'utf8') } catch { continue }
      // cwd 只对可能需要的进程读（readlink 也是 syscall，能省则省）
      let cwd = null
      if (/claude|codex/i.test(cmdline)) {
        try { cwd = fs.readlinkSync(`${root}/${pid}/cwd`) } catch { cwd = null }
      }
      out.push({ cmdline, cwd })
    }
    return out
  }
}

export { EMPTY as emptyProcIndex }
