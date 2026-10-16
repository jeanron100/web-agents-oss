// server/ingest-metrics.js — JSONL 采集与资源隔离的可观测性。
//
// 为什么必须有：本次改造的每一条收益都**可以静默退化**——
//   · 有人把 `resume` 改回 null ⇒ 回到全量重读，功能全对、只是慢，一条错都不报
//   · 有人在循环里再调一次 /proc ⇒ 回到 O(会话×进程)，同样无声
//   · cgroup 配置被覆盖 ⇒ 控制面重新与 worker 挤在一起
// 而这些在**当前告警体系下完全不可见**：实测 .232 曾 29 分钟被节流 2,787 次，
// 而 `oom_kill` 恒为 0 ⇒ journalctl 干净、systemctl 显示 active、任何 OOM 告警都不响。
//
// ★ 核心指标 read_amplification = bytes_read / bytes_new，
//   把"是否还在全量重读"变成一个能被告警盯住的数，而不是靠人每隔半年 strace 一次。
//   实测基线：Codex 改造前 3,081×，改造后 1.03×。
import fs from 'node:fs'

const parseEvents = (txt) => {
  const out = {}
  for (const line of txt.split('\n')) {
    const [k, v] = line.split(/\s+/)
    if (k) out[k] = Number(v)
  }
  return out
}

/**
 * 沿 cgroup 链**由叶子向上**收集 memory.events，逐项取最大值。
 *
 * ★ 为什么不能只读叶子（2026-08-13 生产实测，见测试文件顶部的三层数字）：
 *   `/proc/<pid>/cgroup` 指向的是 **service** 叶子，而 `MemoryHigh` 设在**上面的 slice**。
 *   cgroup v2 把节流记在「限额被撞破的那一层」⇒ 没设限的叶子恒为 0
 *   ⇒ 只读叶子的看门狗**结构上永远不会响**。
 *
 * ★ 上溯的边界：只走我们自己的 `web-agents*` 层级。再往上是 `web.slice`，
 *   那里挂着别的项目——把它们的 oom_kill 算到我们头上就是诬告。
 *   叶子本身无论叫什么都要读（裸跑/开发机不在我们的树下）。
 *
 * 全链路读不到 ⇒ null（"没测到"）；读到但都是 0 ⇒ 0（"没被节流"）。这两者不可混同。
 */
export function collectCgroupEvents(rel, readFile) {
  const dirs = []
  let cur = rel
  for (let depth = 0; cur && cur !== '/' && depth < 32; depth++) {
    const base = cur.split('/').pop()
    // 叶子必读；再往上只走我们自己的 slice
    if (depth > 0 && !/web-agents/.test(base)) break
    dirs.push(cur)
    cur = cur.slice(0, cur.lastIndexOf('/'))
  }
  let out = null
  let source = null       // 归因：最内层**非零**的那层——要调的就是那道限额
  let pinned = false      // 归因已锁定，后面更外层的不再顶替
  // dirs 由内向外，所以第一个读到的就是最内层
  for (const d of dirs) {
    let ev
    try { ev = parseEvents(readFile(`/sys/fs/cgroup${d}/memory.events`)) } catch { continue }
    if (!out) { out = ev; source = d }   // 全零时的回落归因
    else for (const [k, v] of Object.entries(ev)) if (!(k in out) || v > out[k]) out[k] = v
    if (!pinned && ((ev.high ?? 0) > 0 || (ev.max ?? 0) > 0)) { pinned = true; source = d }
  }
  return out && { ...out, source }
}

/** 从 cgroup 读 memory.events。读不到返回 null——**不是 0**（见 collectCgroupEvents）。 */
export function readCgroupEventsFromFs(pid = process.pid) {
  try {
    const rel = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n')[0].split(':').pop()
    return collectCgroupEvents(rel, (p) => fs.readFileSync(p, 'utf8'))
  } catch { return null }
}

export function createIngestMetrics({ readCgroupEvents = readCgroupEventsFromFs, readProjectionStats = null } = {}) {
  let bytesRead = 0
  let bytesNew = 0
  let fullBytes = 0
  let incrBytes = 0
  let seconds = 0
  let parseErrors = 0
  let procScans = 0
  let scans = 0

  return {
    recordScan({ bytesRead: br = 0, bytesNew: bn = 0, incremental = false, seconds: sec = 0 } = {}) {
      scans++
      bytesRead += br
      bytesNew += bn
      seconds += sec
      if (incremental) incrBytes += br; else fullBytes += br
    },
    recordProcScan() { procScans++ },
    recordParseError() { parseErrors++ },

    snapshot() {
      // ★ 分母为 0 时返回 0 而不是 Infinity/NaN。空闲期没有新增字节是常态；
      //   若此时返回 Infinity，任何 `> 5` 的告警都会长鸣，三天后就没人看了
      //   —— 长鸣的告警和没有告警是一回事。
      let amp = 0
      if (bytesNew > 0) amp = bytesRead / bytesNew
      else if (bytesRead > 0) amp = bytesRead   // 零新增却读了：让它是个大数，一眼看得出异常

      // ★ 探测失败返回 null，**不是 0**：0 的含义是"没被节流"，null 是"没测到"。
      //   混为一谈会让"探测坏了"伪装成"一切正常"——fail-safe 静默化的典型形态。
      let ev = null
      try { ev = readCgroupEvents?.() ?? null } catch { ev = null }
      let proj = null
      try { proj = readProjectionStats?.() ?? null } catch { proj = null }

      return {
        scans_total: scans,
        bytes_read_total: bytesRead,
        bytes_new_total: bytesNew,
        full_scan_bytes_total: fullBytes,
        incremental_bytes_total: incrBytes,
        read_amplification: amp,
        scan_seconds: seconds,
        parse_errors_total: parseErrors,
        proc_scans_total: procScans,
        cgroup_memory_high_events: ev ? (ev.high ?? null) : null,
        cgroup_memory_events_source: ev ? (ev.source ?? null) : null,
        cgroup_memory_max_events: ev ? (ev.max ?? null) : null,
        cgroup_memory_oom_kill: ev ? (ev.oom_kill ?? null) : null,
        projection_entries: proj ? proj.entries : null,
        projection_shards: proj ? proj.shards : null,
        projection_disk_ok: proj ? proj.diskOk : null,
      }
    },
  }
}

/**
 * 由「文件当前大小 / 上次已知大小 / 本次读入」算出记账用的 (bytesRead, bytesNew)。
 *
 * ★ 判据是「**上次已知的文件大小**」，与 resume 是否成功无关。
 *   第一版我写成了 `fileSize - (resume?.fileSize ?? 0)`：resume 为 null 时分母变成整个文件，
 *   **分子分母一起变大 ⇒ read_amplification 恒等于 1**。于是人为打断增量后指标仍显示 1.0×、
 *   阈值全绿——看门狗抓不到它被设计来抓的那个退化。实测发现，已修正。
 *
 *   · knownSize 为空（从没见过这个文件）⇒ 冷扫，不算放大（bytesNew = bytesRead）
 *   · 见过 + 增量读  ⇒ bytesRead ≈ bytesNew ⇒ 放大 1
 *   · 见过 + 全量重读 ⇒ bytesRead = 整份、bytesNew = 增量 ⇒ 放大巨大（要抓的就是它）
 */
export function scanBytes({ fileSize = 0, knownSize, bytesRead = 0 }) {
  const known = (typeof knownSize === 'number' && Number.isFinite(knownSize)) ? knownSize : null
  const bytesNew = known === null ? bytesRead : Math.max(0, fileSize - known)
  return { bytesRead, bytesNew }
}
