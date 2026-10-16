/**
 * 会话派生并发闸门（AM-260718-401）。
 *
 * 背景：`/api/session`、`/review`、`/takeover`、`/reattach` 四条派生路径此前**没有任何上限**。
 * 每个平台会话是一个独立 claude/codex 子进程（实测 120~265M），.232 只有 3.6G ——
 * 于是一天两次因内存硬重启，重启后积压重放还会「10 分钟内瞬间新增 27 个会话」把自己再打死一次。
 *
 * 两个维度一起管，缺一不可：
 *   ① max          —— 同时存活的平台会话数上限（真正防 OOM 的那道）
 *   ② minIntervalMs—— 两次派生之间的最小间隔（防重启后积压重放的惊群，即使有空槽也一个一个来）
 *
 * 超限的请求【排队】而不是被拒——这是本任务的硬要求。排队等待有上限（queueWaitMs），
 * 因为 HTTP 请求不能无限挂着：nginx 默认 proxy_read_timeout 60s，超过就给客户端 504，
 * 而后端若仍在排队、稍后又真把会话拉起来，就会产生"没人认领的会话"——正是本任务要消灭的孤儿。
 * 所以宁可到点明确告诉调用方"并发已满，请重试"，也不制造孤儿。
 */

const DEFAULTS = {
  max: 8,
  minIntervalMs: 0,
  queueWaitMs: 45_000,
  maxQueue: 64,
}

/**
 * 并发上限的硬天花板。防手滑：设置页有人输 1000 不该把机器打爆——上限是防 OOM 的
 * 最后一道闸（.232 当初一天硬重启两次才逼出这个闸门），不是随便抬的旋钮。
 * 下界 1：设成 0 会让**所有**派生永久失败，等于把该机锁死。
 */
export const MAX_CEILING = 16

/** 非法值（NaN/字符串/undefined/Infinity）→ 返回 fallback，绝不让脏输入改动闸门。 */
function clampMax(n, fallback) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(MAX_CEILING, Math.max(1, Math.floor(n)))
}

function gateError(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

export function createSessionGate(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const { minIntervalMs, queueWaitMs, maxQueue } = cfg
  // max 必须可变：原本它在 agent 启动时定死，改一次就得重启 agent——而重启会杀掉该机
  // 全部平台会话。于是「调个数字」的代价是「中断所有人的活」，实际没人敢调（2026-07-21）。
  let max = clampMax(cfg.max, DEFAULTS.max)
  let active = 0
  let lastGrantAt = 0
  let drainTimer = null
  const waiters = []

  /** 槽位句柄。release 必须幂等——重复归还会悄悄把上限抬高，等于没上限。 */
  const makeSlot = () => {
    let released = false
    return {
      release() {
        if (released) return
        released = true
        active -= 1
        drain()
      },
    }
  }

  /** 距离"下一次允许派生"还差多少毫秒（限速用）。 */
  const rateWaitMs = () => {
    if (!minIntervalMs) return 0
    const since = Date.now() - lastGrantAt
    return since >= minIntervalMs ? 0 : minIntervalMs - since
  }

  const take = () => {
    active += 1
    lastGrantAt = Date.now()
    return makeSlot()
  }

  function drain() {
    if (drainTimer) return
    while (waiters.length > 0 && active < max) {
      const wait = rateWaitMs()
      if (wait > 0) {
        // 有空槽但还没到限速点：等一会儿再放，别让积压瞬间倾泻。
        drainTimer = setTimeout(() => { drainTimer = null; drain() }, wait)
        return
      }
      const w = waiters.shift()
      clearTimeout(w.timer)
      w.resolve(take())
    }
  }

  return {
    /**
     * 申请一个派生槽位。
     * @returns {Promise<{release():void}>} 拿到槽位；用完（会话释放/被回收）必须 release。
     * @throws  code=QUEUE_TIMEOUT 排队超时 / code=QUEUE_FULL 队列已满
     */
    acquire() {
      // 快路径：没人排队、没到上限、也不违反限速 → 立刻派生。
      // `waiters.length === 0` 这一项保证插队不会发生（FIFO 公平）。
      if (waiters.length === 0 && active < max && rateWaitMs() === 0) {
        return Promise.resolve(take())
      }
      if (waiters.length >= maxQueue) {
        return Promise.reject(gateError(
          'QUEUE_FULL',
          `会话派生队列已满（${waiters.length}/${maxQueue}），请稍后重试`,
          { position: waiters.length, active, max },
        ))
      }
      return new Promise((resolve, reject) => {
        // 入队位次要**当场记下**：等超时回调触发时，排在前面的等待者可能已经先超时被摘走，
        // 那时再 indexOf 算出来的一律是 0，三个排队者全报 pos=0，调用方拿它退避毫无意义。
        const position = waiters.length
        const w = { resolve, reject }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(gateError(
            'QUEUE_TIMEOUT',
            `等待空闲会话槽位超时（当前 ${active}/${max} 已满，排队第 ${position + 1} 位），请稍后重试`,
            { position, active, max },
          ))
        }, queueWaitMs)
        waiters.push(w)
        drain()
      })
    },

    // queueWaitMs 必须报出来：hub 的转发超时**必须严格长于**它，否则闸门那条
    // 「并发已满，排队第 N 位」的 503 永远塌成 504（见 forward-timeouts.js）。
    // 报出来才能在 /api/state 上核对两侧是否漂移。
    /**
     * 运行时调整上限。
     * · 调高 → 立即 drain()，排队者当场放行。
     * · 调低 → **绝不驱逐正在跑的会话**，只是拦住新派生，等 active 自然降下来。
     *   （驱逐 = 拦腰截断用户的活，本仓在这上面栽过；宁可短暂 active > max。）
     * @returns 生效后的上限
     */
    setMax(n) {
      const v = clampMax(n, null)
      if (v === null) return max      // 非法输入：保持原值，别被脏数据锁死闸门
      max = v
      drain()
      return max
    },

    stats() {
      return { active, queued: waiters.length, max, minIntervalMs, queueWaitMs }
    },
  }
}

/**
 * 会话派生的唯一入口：把闸门槽位和会话 id 绑起来。
 * 会话活着就一直攥着槽位，直到 free(id)（显式释放 / 被回收器收走）。
 *
 * 三个必须归还槽位的边界，漏一个闸门就会被慢慢磨死：
 *   ① 派生抛错（如"目录不存在"）—— 失败一次就漏一个名额；
 *   ② 派生返回了**既有**会话 —— driver.createSession 对同 psId / 同 realId 是幂等的，
 *      这种情况下压根没起新进程，槽位当场还回去，否则 reattach 点几次就把闸门堵死；
 *   ③ 返回值没有 id —— 同上，没有可绑定的会话。
 */
export function createSpawnGate(opts = {}) {
  const gate = createSessionGate(opts)
  const slots = new Map() // 会话 id -> 槽位

  return {
    /** @param create 真正派生会话的函数（可同步可异步），返回带 id 的会话记录 */
    async spawn(create) {
      const slot = await gate.acquire()
      let record
      try {
        record = await create()
      } catch (e) {
        slot.release()
        throw e
      }
      if (!record?.id || slots.has(record.id)) {
        slot.release()
        return record
      }
      slots.set(record.id, slot)
      return record
    },

    /** 运行时调整上限（透传给内层闸门）。agent 用的是本包装层，不透出就等于功能没接上。 */
    setMax(n) {
      return gate.setMax(n)
    },

    /** 归还某会话占用的槽位；未知 id 是安全的空操作。 */
    free(id) {
      const slot = slots.get(id)
      if (!slot) return false
      slots.delete(id)
      slot.release()
      return true
    },

    stats() {
      return { ...gate.stats(), held: slots.size }
    },
  }
}
