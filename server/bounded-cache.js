// server/bounded-cache.js — 有界 LRU 缓存，给解析缓存兜底（P5）。
//
// 为什么需要：agent.js 里五个解析缓存（summaryCache / eventsCache / codexSummaryCache /
// codexEventsCache / kimiEventsCache）全是裸 `new Map()`，**条目只增不减**。
// 实测 .232 有 10,668 个 Claude JSONL，而 usageDaily / usageTodayHourly / usageProjectsToday
// 会遍历**全部**文件 ⇒ 缓存最终可装下整个语料，每条还挂着 summary + 最多 400 条事件。
// 这是 cgroup 里 anon 内存（实测 610MB）的一个确定增长源。
//
// ★ 但驱逐本身有代价：条目一旦被驱逐，checkpoint 也没了，下次访问要**全量重扫**。
//   上限太小 ⇒ 抖动式全量扫风暴，把增量续扫的收益整个抵消。所以：
//   ① 必须是 LRU 不是 FIFO —— 活跃会话每 3 秒用一次，绝不能因为"进得早"被先踢；
//   ② 上限配错（0/负数/NaN）时**退化为无界**，即回到今天的行为，而不是静默变成 0 容量。
//      后者会把增量续扫整个关掉，而且不报错、只是突然变慢——最坏的一种失败。

/**
 * @param {number} max 条目上限。≤0 或非法 ⇒ 无界（保守回退到现有行为）。
 */
export function createBoundedCache(max) {
  const limit = (typeof max === 'number' && Number.isFinite(max) && max > 0) ? Math.floor(max) : Infinity
  const m = new Map()
  let hits = 0
  let misses = 0
  let evictions = 0

  return {
    get(k) {
      if (!m.has(k)) { misses++; return undefined }
      hits++
      // Map 保持插入顺序：删了再塞 = 移到队尾 = 标记为"最近使用"
      const v = m.get(k)
      m.delete(k)
      m.set(k, v)
      return v
    },
    set(k, v) {
      if (m.has(k)) m.delete(k)       // 重新入队尾，size 不变
      m.set(k, v)
      while (m.size > limit) {
        // Map 迭代序 = 插入序 ⇒ 第一个就是最久未使用
        const oldest = m.keys().next().value
        m.delete(oldest)
        evictions++
      }
    },
    /** 只读探测，**不**刷新新鲜度——否则一次巡检就会打乱驱逐顺序。 */
    has(k) { return m.has(k) },
    delete(k) { return m.delete(k) },
    clear() { m.clear() },
    get size() { return m.size },
    keys() { return m.keys() },
    stats() { return { max: limit, size: m.size, hits, misses, evictions } },
  }
}
