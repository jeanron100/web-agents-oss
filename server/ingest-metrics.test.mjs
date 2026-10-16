// node --test server/ingest-metrics.test.mjs
//
// JSONL 采集与资源隔离的可观测性。
//
// 为什么必须有：本次改造的每一条收益都是**可以静默退化**的——
//   · 有人把 `resume` 改回 null ⇒ 回到全量重读，功能全对、只是慢，没有任何报错
//   · 有人在循环里再调一次 /proc ⇒ 回到 O(会话×进程)，同样无声
//   · cgroup 配置被覆盖 ⇒ 控制面重新与 worker 挤在一起
// 而这些退化在**当前的告警体系下完全不可见**：实测 .232 曾 29 分钟被节流 2,787 次，
// 而 `oom_kill` 恒为 0 ⇒ `journalctl` 干净、`systemctl` 显示 active、任何 OOM 告警都不响。
//
// ★ 核心指标是 **read_amplification = bytes_read / bytes_new**。
//   它把"是否还在全量重读"变成一个可以被告警盯住的数，而不是靠人每隔半年 strace 一次。
//   实测基线：Codex 改造前 3,081×，改造后 1.03×。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIngestMetrics } from './ingest-metrics.js'

test('增量读取记入 incremental，全量记入 full', () => {
  const m = createIngestMetrics()
  m.recordScan({ bytesRead: 4096, bytesNew: 4000, incremental: true })
  m.recordScan({ bytesRead: 1_000_000, bytesNew: 4000, incremental: false })
  const s = m.snapshot()
  assert.equal(s.incremental_bytes_total, 4096)
  assert.equal(s.full_scan_bytes_total, 1_000_000)
  assert.equal(s.bytes_read_total, 1_004_096)
  assert.equal(s.bytes_new_total, 8000)
})

test('★★ read_amplification = 读入 / 新增', () => {
  const m = createIngestMetrics()
  m.recordScan({ bytesRead: 4085, bytesNew: 3969, incremental: true })
  assert.ok(Math.abs(m.snapshot().read_amplification - 1.03) < 0.01,
    `实测改造后应约 1.03×，得到 ${m.snapshot().read_amplification}`)
})

test('★ 分母为 0 时不得返回 Infinity/NaN —— 那会让告警规则失效', () => {
  // 空闲期没有新增字节是常态。若此时返回 Infinity，任何 `> 5` 的告警都会长鸣，
  // 三天后就没人看了——这跟没有告警是一回事。
  const m = createIngestMetrics()
  m.recordScan({ bytesRead: 0, bytesNew: 0, incremental: true })
  const a = m.snapshot().read_amplification
  assert.ok(Number.isFinite(a), `分母为 0 时必须是有限值，得到 ${a}`)
  assert.equal(a, 0)
})

test('★ 只读不增（无新数据却读了）要能体现出来', () => {
  const m = createIngestMetrics()
  m.recordScan({ bytesRead: 11_660_000, bytesNew: 0, incremental: false })
  const s = m.snapshot()
  assert.ok(s.read_amplification > 100,
    '零新增却读了 11MB —— 这正是改造前的行为，必须是个大数而不是 0/Infinity')
})

test('proc_scans_total 计数（链 B 的看门狗）', () => {
  const m = createIngestMetrics()
  m.recordProcScan(); m.recordProcScan()
  assert.equal(m.snapshot().proc_scans_total, 2)
})

test('parse_errors_total 计数', () => {
  const m = createIngestMetrics()
  m.recordParseError(); m.recordParseError(); m.recordParseError()
  assert.equal(m.snapshot().parse_errors_total, 3)
})

test('scan_seconds 累加', () => {
  const m = createIngestMetrics()
  m.recordScan({ bytesRead: 1, bytesNew: 1, incremental: true, seconds: 0.5 })
  m.recordScan({ bytesRead: 1, bytesNew: 1, incremental: true, seconds: 0.25 })
  assert.equal(m.snapshot().scan_seconds, 0.75)
})

test('★ cgroup 软限节流计数从 memory.events 读，读不到时为 null 而非 0', () => {
  // 0 的含义是"没被节流"，null 的含义是"没测到"。混为一谈会让"探测坏了"
  // 伪装成"一切正常"——这正是 fail-safe 静默化的典型形态。
  const m = createIngestMetrics({ readCgroupEvents: () => null })
  assert.equal(m.snapshot().cgroup_memory_high_events, null)

  const m2 = createIngestMetrics({ readCgroupEvents: () => ({ high: 2787, max: 0, oom_kill: 0 }) })
  const s = m2.snapshot()
  assert.equal(s.cgroup_memory_high_events, 2787)
  assert.equal(s.cgroup_memory_oom_kill, 0)
})

test('checkpoint / projection 规模可见', () => {
  const m = createIngestMetrics({ readProjectionStats: () => ({ entries: 57, shards: 25, diskOk: true }) })
  const s = m.snapshot()
  assert.equal(s.projection_entries, 57)
  assert.equal(s.projection_shards, 25)
  assert.equal(s.projection_disk_ok, true)
})

test('★ 投影落盘失败必须可见 —— 否则"重启还是慢"查不出原因', () => {
  const m = createIngestMetrics({ readProjectionStats: () => ({ entries: 3, shards: 1, diskOk: false }) })
  assert.equal(m.snapshot().projection_disk_ok, false)
})

test('snapshot 是纯读，不重置计数', () => {
  const m = createIngestMetrics()
  m.recordProcScan()
  m.snapshot(); m.snapshot()
  assert.equal(m.snapshot().proc_scans_total, 1, 'snapshot 不得有副作用')
})

test('探测函数抛异常时 snapshot 仍返回可用对象', () => {
  const m = createIngestMetrics({
    readCgroupEvents: () => { throw new Error('no cgroup') },
    readProjectionStats: () => { throw new Error('boom') },
  })
  let s
  assert.doesNotThrow(() => { s = m.snapshot() })
  assert.equal(s.cgroup_memory_high_events, null)
  assert.equal(s.projection_entries, null)
})

// ───────────── bytesNew 的算法（★ 第一版接线是错的，见下） ─────────────
//
// 2026-08-13：我第一版把 bytesNew 写成 `fileSize - (resume?.fileSize ?? 0)`。
// resume 为 null 时分母变成整个文件大小，**分子分母一起变大 ⇒ read_amplification 恒等于 1**。
// 于是人为打断增量后，指标仍显示 1.0×、所有阈值全绿 ——
// **看门狗抓不到它被设计来抓的那个退化。** 这正是"从不触发的看门狗和坏掉的看门狗长得一样"。
//
// 正确判据是「**上次已知的文件大小**」，与 resume 是否成功无关：
//   · 从没见过这个文件 ⇒ 冷扫，不算放大
//   · 见过 + 增量读     ⇒ 读=增量，放大 1
//   · 见过 + 全量重读   ⇒ 读=整份、增量很小 ⇒ 放大巨大  ← 这才是要抓的
import { scanBytes } from './ingest-metrics.js'

test('首次见到该文件（无先验）⇒ 视作冷扫，放大 1', () => {
  const m = createIngestMetrics()
  m.recordScan({ ...scanBytes({ fileSize: 10_000_000, knownSize: undefined, bytesRead: 10_000_000 }), incremental: false })
  assert.equal(m.snapshot().read_amplification, 1)
})

test('见过 + 增量读 ⇒ 放大 ≈1', () => {
  const m = createIngestMetrics()
  m.recordScan({ ...scanBytes({ fileSize: 10_004_000, knownSize: 10_000_000, bytesRead: 4000 }), incremental: true })
  assert.equal(m.snapshot().read_amplification, 1)
})

test('★★ 见过 + 全量重读 ⇒ 放大必须是个大数（这是本指标存在的唯一理由）', () => {
  const m = createIngestMetrics()
  // 10MB 文件追加 4KB，却整份重读 —— 改造前 Codex 的行为
  m.recordScan({ ...scanBytes({ fileSize: 10_004_000, knownSize: 10_000_000, bytesRead: 10_004_000 }), incremental: false })
  const a = m.snapshot().read_amplification
  assert.ok(a > 2000, `应约 2,501×，实际 ${a.toFixed(1)}× —— 若为 1 则看门狗是坏的`)
})

test('文件缩小（truncate）不产生负的 bytesNew', () => {
  const b = scanBytes({ fileSize: 1000, knownSize: 5000, bytesRead: 1000 })
  assert.ok(b.bytesNew >= 0)
})

// ───────────── 节流计数读在哪一层（★ 第一版接线又是错的） ─────────────
//
// 2026-08-13 生产实测：`/api/metrics/ingest` 报 `cgroup_memory_high_events: 0`，
// 而同一时刻 .232 上
//   web-agents.slice                       high=1717985280  高事件 44,003
//   └ web-agents-control.slice             high=1073741824  高事件 43,930   ← 真正被节流的一层
//     └ web-agents-agent.service           （限额没设在这）  高事件 0        ← 我读的就是这一层
//
// 根因：`/proc/<pid>/cgroup` 给的是**叶子 service**，而 `MemoryHigh` 设在**上面的 slice**。
// cgroup v2 把节流记在「限额被撞破的那一层」，叶子自己没设限 ⇒ 叶子的计数**恒为 0**。
// ⇒ 这个看门狗在结构上永远不可能响。它抓的正是 2,616 次静默节流那类事故，
//   而它自己就是「从不触发的看门狗和坏掉的看门狗长得一样」的又一个实例。
//
// 正确判据：**任何祖先撞限都在节流本进程**，所以要沿叶子→上walk，逐项取最大值。
import { collectCgroupEvents } from './ingest-metrics.js'

const FAKE = {
  '/sys/fs/cgroup/web.slice/web-agents.slice/web-agents-control.slice/web-agents-agent.service/memory.events':
    'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
  '/sys/fs/cgroup/web.slice/web-agents.slice/web-agents-control.slice/memory.events':
    'low 0\nhigh 43930\nmax 0\noom 0\noom_kill 0\n',
  '/sys/fs/cgroup/web.slice/web-agents.slice/memory.events':
    'low 0\nhigh 44003\nmax 0\noom 0\noom_kill 0\n',
  // 兄弟服务的账不该被算进来——web.slice 下还挂着别的项目
  '/sys/fs/cgroup/web.slice/memory.events':
    'low 0\nhigh 999999\nmax 7\noom 0\noom_kill 3\n',
}
const fakeRead = (p) => { if (!(p in FAKE)) throw new Error('ENOENT'); return FAKE[p] }
const LEAF = '/web.slice/web-agents.slice/web-agents-control.slice/web-agents-agent.service'

test('★★ 节流记在祖先 slice 上时必须能读到 —— 只读叶子恒为 0', () => {
  const ev = collectCgroupEvents(LEAF, fakeRead)
  assert.ok(ev.high > 0, `叶子恒为 0，必须上溯才能看到真实节流；得到 ${ev.high}`)
  // cgroup v2 的 `memory.events` 是**含子树**的（本地量在 `memory.events.local`）
  // ⇒ 44,003 ⊇ 43,930，取链上最大值 = 整个 web-agents 树被节流的总次数。
  assert.equal(ev.high, 44003)
})

test('★ 计数与归因是两个问题：数取链上最大，归因取**最内层非零**（要调的就是那道限额）', () => {
  const ev = collectCgroupEvents(LEAF, fakeRead)
  assert.equal(ev.high, 44003, '告警要问"有没有被节流" ⇒ 链上最大')
  assert.match(ev.source, /web-agents-control\.slice$/, '排障要问"调谁的限额" ⇒ 最内层非零的那层')
})

test('★ 不得把 web-agents 之外的兄弟 slice 记到我们头上', () => {
  const ev = collectCgroupEvents(LEAF, fakeRead)
  assert.notEqual(ev.high, 999999, 'web.slice 下还有别的项目，越界统计会诬告')
  assert.equal(ev.oom_kill, 0, 'oom_kill 同理不得跨界继承')
})

test('★ 全链路为 0 时归因回落到最内层可读的一层（而不是 null）', () => {
  const zero = (p) => (p.includes('web-agents') ? 'low 0\nhigh 0\nmax 0\noom_kill 0\n' : (() => { throw new Error('ENOENT') })())
  assert.match(collectCgroupEvents(LEAF, zero).source, /web-agents-agent\.service$/)
})

test('全链路都是 0 时返回 0（"没被节流"），不是 null（"没测到"）', () => {
  const zero = (p) => (p.includes('web-agents') ? 'low 0\nhigh 0\nmax 0\noom_kill 0\n' : (() => { throw new Error('ENOENT') })())
  assert.equal(collectCgroupEvents(LEAF, zero).high, 0)
})

test('一层都读不到时返回 null —— 探测坏了不得伪装成一切正常', () => {
  assert.equal(collectCgroupEvents(LEAF, () => { throw new Error('ENOENT') }), null)
})

test('中间某层读不到不影响其余层（部分可读也要给结论）', () => {
  const partial = (p) => {
    if (p.endsWith('web-agents-control.slice/memory.events')) throw new Error('EACCES')
    return fakeRead(p)
  }
  assert.equal(collectCgroupEvents(LEAF, partial).high, 44003, '跳过读不到的那层，仍要拿到 web-agents.slice 的 44,003')
})

test('不在 web-agents 树下（如裸跑/开发机）时只读自己那一层，不上溯', () => {
  const solo = { '/sys/fs/cgroup/user.slice/session-3.scope/memory.events': 'low 0\nhigh 12\nmax 0\noom_kill 0\n' }
  const r = (p) => { if (!(p in solo)) throw new Error('ENOENT'); return solo[p] }
  const ev = collectCgroupEvents('/user.slice/session-3.scope', r)
  assert.equal(ev.high, 12)
})
