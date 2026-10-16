import { codexAssistantMessage } from './codex-transcript.js'
import { mergeCodexEvents } from './codex-events.js'
// node-agent（P0 影子追踪版）：扫描本机 /data 下项目的 Claude Code 会话 JSONL，
// 提供只读 API 给 Web 前端。无第三方依赖，Node 20+。
// 端点：GET /api/state  GET /api/session/:id/events
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import * as driver from './driver.js'
import * as codexDriver from './codex-driver.js'
import * as kimiDriver from './kimi-driver.js'
import { scanKimiSessions, parseWire as parseKimiWire, mergeKimiEvents } from './kimi-shadow.js' // Kimi 影子追踪（~/.kimi-code）
import * as codetree from './codetree.js'
import { openProjectImage } from './file-image.js'
import * as digest from './digest.js'
import { claudeSeq, seqBounds, buildFrame, claudeCmp, numCmp, needsHistorySnapshot } from './event-seq.js'
import { toWire, findImage } from './event-wire.js'
import { refreshPlatformFromFile, shadowStateOf, advanceShadowTurn, isCodexSubagent } from './shadow-state.js'
import { sessionStore, findClaudeJsonlByRealId, interruptedByRestart } from './session-store.js'
import { createActivityCounter, createMaintenanceLease, restartBlockers } from './maintenance.js'
import { decideLiveWriter } from './liveness.js'
import { creditUsage, trimSeen } from './usage-dedupe.js'
import { parseHiddenParam, isHidden } from './hidden-projects.js'
import { createSpawnGate, MAX_CEILING } from './session-gate.js'
import { windowEvents } from './event-window.js' // 对外窗口：对话与工具调用分开配额
import { allocateSessions } from './session-allocate.js' // 看板名额：每项目保底 1 条，别让热项目挤掉冷项目
import { selectHistory } from './project-history.js' // 会话历史（冷路径）：全量扫单项目，别动 3s 轮询的热路径
import { resolveStartupMax, writePersistedMax } from './max-sessions-store.js'
import { decideReap, cpuPercentFromSamples, releaseWithDeadline } from './session-reaper.js'
import * as terminal from './terminal.js'
import { shouldReprobe, CODEX_MEMO_MS } from './usage-throttle.js' // 额度节流窗口：必须严格长于前端轮询间隔
import { createProcIndex, makeProcReader } from './proc-index.js' // /proc 一次遍历建索引（原为 O(会话×进程)）
import { canResume } from './resume-guard.js' // 三侧共用的续扫判据（唯一真相源）
import { createBoundedCache } from './bounded-cache.js'
import { createTtlMemo } from './dir-memo.js' // 文件发现 5s memo（原为每次 buildState 全树遍历）
import { createRefreshGate } from './map-refresh.js' // id 未映射时的兜底刷新闸（原每 300ms 一次全量）
import { createProjectionStore } from './projection-store.js' // 派生态持久化：重启不重扫（实测原为 780MB）
import { createIngestMetrics, readCgroupEventsFromFs, scanBytes } from './ingest-metrics.js' // 防静默退化的看门狗
import { admitDecision } from './memory-admit.js'
import { census } from './session-census.js'
import { stateToWire } from './state-wire.js' // /api/state 出口裁剪：内部对象 ≠ 线协议
import { listCorpus as archiveCorpus, readRange as archiveRead } from './archive-collect.js'
import { nodeAuthorized } from './operator-auth.js'
import { createAgentInfo } from './agent-info.js'

/** 平台会话 id → 对应驱动器（claude/codex/kimi），用于交互端点分发 */
function driverFor(id) {
  if (driver.realSessionIds().has(id) || String(id).startsWith('ps-')) return driver
  if (codexDriver.realSessionIds().has(id)) return codexDriver
  if (kimiDriver.hasSession(id)) return kimiDriver
  return null
}

const PORT = Number(process.env.WA_AGENT_PORT) || 8788 // 默认 8788；可用 WA_AGENT_PORT 起隔离实例做验证
// 本 agent 进程的身份：重启即变。Hub 据此识别 agent 重启（见 buildState 里 server.bootId 的注释）。
const BOOT_ID = crypto.randomUUID()
const BOOT_AT = Date.now()
const DATA_ROOT = path.resolve(process.env.WA_PROJECT_ROOT || '/data')
if(!process.env.WA_AGENT_TOKEN&&process.env.WA_AGENT_TOKEN_FILE)process.env.WA_AGENT_TOKEN=fs.readFileSync(process.env.WA_AGENT_TOKEN_FILE,'utf8').trim()
const agentInfo=createAgentInfo({root:DATA_ROOT})
if(process.env.WA_AGENT_REQUIRE_TOKEN==='1'&&!process.env.WA_AGENT_TOKEN)throw new Error('节点需要WA_AGENT_TOKEN接入令牌')
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions')
const MAX_AGE_DAYS = 60        // 只纳管最近活跃的会话
const MAX_PER_PROJECT = 3
const MAX_TOTAL = 40

// ---------- 会话派生并发闸门 / 挂起会话回收（AM-260718-401）----------
// 每个平台会话 = 一个独立 claude 子进程（实测 120~265M），.232 只有 3.6G。此前四条派生路径
// （/api/session、/review、/takeover、/reattach）**没有任何上限**，于是：一天两次内存硬重启，
// 重启后积压重放还能「10 分钟内瞬间新增 27 个会话」把自己再打死一次，外加干完活不退的孤儿
// （实测 47min 存活 / 39min 无 JSONL 写入 / CPU~0% / 占 265M）。
// 三道闸：① 同时存活上限 ② 两次派生的最小间隔（防惊群重放）③ 挂起会话回收。
// 全部走 env，别写死；.232 的生效值放 server/.env。
//
// ① 同时存活上限——运行时可调（AM-260721）：过去这个数字只能靠 WA_MAX_SESSIONS 定死，
// 改一次要重启 agent，而重启会杀掉该机全部平台会话，代价太大导致没人敢调。现在
// POST /api/config/max-sessions 走 session-gate.js 的 setMax() 热改，并落盘到
// ~/.web-agents/max-sessions.json（见 max-sessions-store.js）活过下次重启。
// 启动时的有效值优先级：持久化文件 > WA_MAX_SESSIONS 环境变量 > 内置默认值 8——
// 文件代表"运维在这台机上明确调过"，理应盖过部署时写死的 env。
const { value: MAX_SESSIONS, source: MAX_SESSIONS_SOURCE } = resolveStartupMax()
const SPAWN_MIN_INTERVAL_MS = Number(process.env.WA_SPAWN_MIN_INTERVAL_MS ?? 1_500)
// 排队等待上限必须 < nginx proxy_read_timeout(默认 60s)：超了 nginx 先给客户端 504，
// 而后端还在排队、稍后又真把会话拉起来 → 制造"没人认领的会话"，正是本任务要消灭的孤儿。
const SPAWN_QUEUE_WAIT_MS = Number(process.env.WA_SPAWN_QUEUE_WAIT_MS ?? 45_000)
const SPAWN_QUEUE_MAX = Number(process.env.WA_SPAWN_QUEUE_MAX ?? 64)
const REAP_ENABLED = process.env.WA_REAP_ENABLED !== '0'
const REAP_INTERVAL_MS = Number(process.env.WA_REAP_INTERVAL_MS ?? 60_000)
const REAP_IDLE_MS = Number(process.env.WA_REAP_IDLE_MS ?? 30 * 60_000)
const REAP_WAITING_MS = Number(process.env.WA_REAP_WAITING_MS ?? 6 * 60 * 60_000)
// pid 归属不到时的放宽窗口（同项目多开会话 ⇒ attributePid 必然返回 null，见 session-reaper.js）。
// 不设这个窗口，那些会话就永久占着并发槽位——2026-07-19 把 232 焊死在 8/8 的正是它。
const REAP_UNATTRIBUTED_IDLE_MS = Number(process.env.WA_REAP_UNATTRIBUTED_IDLE_MS ?? REAP_IDLE_MS * 3)
const REAP_MIN_AGE_MS = Number(process.env.WA_REAP_MIN_AGE_MS ?? 10 * 60_000)
// 2026-08-30 事故整改：两条豁免的上限。**豁免必须有上限，否则最该收的会话反而免死**。
//   inflight：挂死会话的状态永远停在 running ⇒ inflight 恒 true。30min 不写字＝不可能真在跑。
//   CPU：尸体在内存颠簸时 CPU 反而最高，但「CPU 在动」与「长构建」难以区分 ⇒ 给 3h 宽限。
const REAP_INFLIGHT_GRACE_MS = Number(process.env.WA_REAP_INFLIGHT_GRACE_MS ?? 30 * 60_000)
const REAP_CPU_GRACE_MS = Number(process.env.WA_REAP_CPU_GRACE_MS ?? 3 * 60 * 60_000)
const CLK_TCK = Number(process.env.WA_CLK_TCK ?? 100) // sysconf(_SC_CLK_TCK)，Linux 上通常 100
// 回收时等 driver.release 的上限。release 内部 `await handle.interrupt()` 没有超时，
// 对着一个卡死的子进程可以**永远**挂住（实测 25s+ 不返回）——而回收器要收的正是这种会话。
const REAP_RELEASE_TIMEOUT_MS = Number(process.env.WA_REAP_RELEASE_TIMEOUT_MS ?? 10_000)

// 非项目目录（临时文件中转、备份等），不上看板、不进新建会话列表
const EXCLUDE_PROJECTS = new Set([
  'claude_tmp_files',
  'codes_transfer',
  'comfyui_pics',
  'chatgpt_imgs',
  'docker',
])

// ★ 动态隐藏名单（「隐藏 = 不加入项目纳管」，用户 2026-09-06）。
//   权威在 hub，随每次 `/api/state?hidden=…` / `/api/projects?hidden=…` 下发。
//   **agent 刻意不持久化**：配置存在 agent 上就意味着改一次要发 5 台、还要重启
//   （重启会腰斩在飞的平台会话）。无状态下发 ⇒ 改配置零部署、agent 重启也不丢。
// ⚠️ 用 `searchParams.has()` 区分「没传参数」与「传了空」：直连 agent 调试的请求
//   不会带这个参数，若把「缺席」当成「清空」，隐藏就会随机闪回（hub 那一拍隐藏、
//   别人一 curl 又全冒出来）。只有真传了才更新，显式传空才是取消隐藏。
let hiddenProjectsDyn = new Set()
const applyHiddenParam = (url) => {
  if (!url?.searchParams?.has('hidden')) return
  const next = new Set(parseHiddenParam(url.searchParams.get('hidden')))
  if (next.size === hiddenProjectsDyn.size && [...next].every((x) => hiddenProjectsDyn.has(x))) return
  hiddenProjectsDyn = next
  // ⚠️ 名单变了必须让项目发现 memo 失效，否则最多 5s 内看板还按旧名单渲染
  //    （前端点了「隐藏」却什么都没发生 = 用户会以为按钮坏了，然后连点）。
  //    **只在真的变化时失效** —— hub 每 5s 就带一次这个参数，每拍都失效等于把 memo 废掉，
  //    而它当初是为了把递归遍历从「每次 buildState」降到「每 5 秒一次」才加的。
  discoverProjects.invalidate?.()
}
/** 静态排除表 ∪ 动态隐藏名单。**六个纳管入口共用它，别在任何一处写裸 has()。** */
const excludedProject = (name) => isHidden(name, EXCLUDE_PROJECTS, hiddenProjectsDyn)

// ---------- 项目发现 ----------
const encodeCwd = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')

function discoverProjectsUncached() {
  const out = []
  for (const name of fs.existsSync(DATA_ROOT)?fs.readdirSync(DATA_ROOT):[]) {
    if (excludedProject(name)) continue
    const full = path.join(DATA_ROOT, name)
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch { continue }
    const enc = encodeCwd(full)
    const sessDir = path.join(CLAUDE_PROJECTS, enc)
    if (fs.existsSync(sessDir)) out.push({ name, cwd: full, sessDir })
  }
  return out
}

// ---------- 活跃 CLI 进程探测（/proc） ----------
// 文件发现 memo（P6）：strace 实测每次 buildState 递归遍历整棵 ~/.codex/sessions 日期目录树
// 与 /root/.claude/projects，占改造后开销的绝大部分（3 次请求 10,098 次 openat）。
// 5 秒窗口：前端本来就 3 秒轮询，新会话最多晚一拍上榜，而遍历次数降一个量级。
const DISCOVER_TTL_MS = Number(process.env.WA_DISCOVER_TTL_MS) || 5000
const discoverProjects = createTtlMemo(discoverProjectsUncached, { ttlMs: DISCOVER_TTL_MS })

// ---------- 活跃 CLI 进程索引（proc-index.mjs，一次遍历供多方查询） ----------
//
// 2026-08-13 实测：单次 buildState 消耗 **5,354 次 read()**，平均每次 109 字节
// —— 那是 /proc/<pid>/cmdline，不是 JSONL 行。strace 8 秒归因：.jsonl 打开 4 次、/proc/* 打开 13,885 次。
// 根因是下方 buildState 的别名循环里逐条调 realIdActiveInProc()，每条重扫整个 /proc
// ⇒ O(会话数 × 进程数)。现改为一次遍历建索引 + 200ms memo，判据逐字未改（含已知 kimi bug，
// 见 proc-index.js 文件头与 proc-index.test.mjs）。
const PROC_INDEX_TTL_MS = Number(process.env.WA_PROC_INDEX_TTL_MS) || 200
// 兜底刷新闸（P8）：SSE tick 每 300ms 一次，id 一直映射不上就是 3.3 次全量 buildState/秒。
// 同一 id 在窗口内只放行一次。窗口取 5s——与文件发现 memo 同量级，冷启动顺序造成的
// 短暂未映射最多多等一拍。
const mapRefreshGate = createRefreshGate({ ttlMs: Number(process.env.WA_MAP_REFRESH_TTL_MS) || 5000 })

const procReader = makeProcReader(fs)
const procIndex = createProcIndex({ read: () => { ingestMetrics.recordProcScan(); return procReader() }, ttlMs: PROC_INDEX_TTL_MS })

function activeCliCwds() {
  const ix = procIndex.get()
  return { claude: ix.claude, codex: ix.codex, kimi: ix.kimi }
}

// 精确判断某原生会话是否正被某个进程 `claude --resume <realId>`（Phase 1b reattach 强守卫，Codex-P0-3）。
// 比"按 cwd 判活性"更准：cmdline 是 NUL 分隔，realId 作为连续 uuid 直接子串匹配即可。
/** 接管/恢复的活体判定：真有活的写者才拦。判据与「为什么不能只看 mtime」见 server/liveness.js。 */
function hasLiveWriter(cwd, realId, mtimeMs) {
  // ★ 接管守卫走 fresh()：它一年跑不了几次（用户点按钮才触发），但判错的代价是
  //   「用户一条出路都没有」——曾用 mtime 判活把「恢复会话」按死过。稀有 + 高代价 ⇒ 不吃缓存。
  //   顺带比原实现还省：原来这里要扫两遍 /proc（realIdActiveInProc 一遍 + activeCliCwds 一遍）。
  const ix = procIndex.fresh()
  return decideLiveWriter({
    realIdInProc: ix.hasRealId(realId),
    cwdHasClaude: ix.claude.has(cwd),
    ageMs: Date.now() - mtimeMs,
    windowMs: WAITING_WINDOW_MS,
  })
}

/** 等价于原实现（claude cmdline 子串匹配），但走共享索引：O(claude 进程数) 而非 O(全部进程数)。 */
function realIdActiveInProc(realId) {
  return procIndex.get().hasRealId(realId)
}

// ---------- JSONL 解析（按 mtime 缓存 + 增量续扫） ----------
// 有界 LRU（P5，2026-08-13）。原为裸 Map，**条目只增不减**：.232 有 10,668 个 JSONL，
// 而 usageDaily/usageTodayHourly/usageProjectsToday 会遍历全部文件 ⇒ 缓存可装下整个语料。
//
// 两档上限，因为两类条目体量差一个数量级：
//   · summary 条目：只有聚合量（events 数组恒空，pushEvent 仅在 wantEvents 时写）⇒ 小
//   · events  条目：最多挂 EVENTS_RETAIN=400 条事件，单条文本上限 6000 字符 ⇒ 大
//
// ⚠️ 上限**不能拍太小**：条目被驱逐 = checkpoint 一起丢 = 下次访问全量重扫。
//    配成 0 会静默把增量续扫整个关掉（只是变慢、不报错），故 bounded-cache 对非法值退化为无界。
const CACHE_MAX_SUMMARY = Number(process.env.WA_CACHE_MAX_SUMMARY) || 2000
const CACHE_MAX_EVENTS = Number(process.env.WA_CACHE_MAX_EVENTS) || 200
// 派生态持久化（Persistence V1，P3）。实测：不持久化时 agent 每次重启要重读 **780 MB**
// （60,825 次 read()，全部命中 page cache 故 read_bytes=0，但 CPU 与 event loop 照样被占满）。
// 投影里存 {generation, fileSize, offset} + 全部跨行累积量，重启后 stat 一下就知道该读哪一段。
const projection = createProjectionStore({})
// 可观测性：本次改造的每条收益都可以静默退化（把 resume 改回 null 就回到全量重读，
// 功能全对、只是慢、一条错都不报）。read_amplification 是那道看门狗。
const ingestMetrics = createIngestMetrics({
  readCgroupEvents: () => readCgroupEventsFromFs(process.pid),
  readProjectionStats: () => projection.stats(),
})
let projFlushTimer = null
/** 去抖落盘：与 session-store 同口径（2s），避免每轮轮询都写盘。 */
function scheduleProjectionFlush() {
  if (projFlushTimer) return
  projFlushTimer = setTimeout(() => { projFlushTimer = null; try { projection.flush() } catch { /* 落盘失败已在 store 内记日志 */ } }, 2000)
  projFlushTimer.unref?.()
}

const summaryCache = createBoundedCache(CACHE_MAX_SUMMARY) // file -> { mtimeMs, size, value, state }
const eventsCache = createBoundedCache(CACHE_MAX_EVENTS)   // file -> { mtimeMs, size, value, state }
// 每个会话在解析缓存里留存的事件条数上限。对外窗口恒 150（对话流用量），留存取更大值有两个用途：
// ① 增量续扫的状态载体；② 历史回填 `/events?limit=N` 够到 150 条窗口之外的早期回合。
const EVENTS_RETAIN = 400

const prettyModel = (m) => {
  if (!m || m.startsWith('<')) return ''
  let match = /claude-(\w+)-(\d+)-(\d+)/.exec(m)
  if (match) return match[1][0].toUpperCase() + match[1].slice(1) + ' ' + match[2] + '.' + match[3]
  match = /claude-(\w+)-(\d+)/.exec(m)
  if (match) return match[1][0].toUpperCase() + match[1].slice(1) + ' ' + match[2]
  return m
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  }
  return ''
}

const isNoise = (t) => !t || t.startsWith('<') || t.startsWith('Caveat:')

// 从 Claude 消息 content 抽出图片块（{type:'image',source:{type:'base64',media_type,data}}）→
// [{name, media_type, base64}]。归档到 KB 时把当时对话里贴的截图内联进 markdown（JSONL 里本就存着 base64，
// 之前 textOf 只取文本、把图片丢了 → KB 归档没图）。base64 较大，只在需要 events 时抽。
const imagesOf = (content) => {
  if (!Array.isArray(content)) return []
  const out = []
  let i = 0
  for (const c of content) {
    if (c?.type === 'image' && c.source?.type === 'base64' && c.source.data) {
      const mt = c.source.media_type || 'image/png'
      const ext = (mt.split('/')[1] || 'png').replace('jpeg', 'jpg')
      out.push({ name: `img-${++i}.${ext}`, media_type: mt, base64: c.source.data })
    }
  }
  return out
}

async function scanFile(file, { wantEvents, resume = null }) {
  const st = fs.statSync(file)
  const summary = resume?.summary ?? {
    title: '', branch: '', model: '', mode: 'default',
    // 归属线索（P0 #6）：首个真实用户消息前 120 字，捕获一次后恒不变——不同于 `title`（来自
    // 'ai-title' 事件，是 AI 生成的摘要，可能很晚才出现）和 `lastText`（每回合都被覆写）。
    firstPrompt: '',
    startedAt: 0, tokens: 0, lastText: '', msgCount: 0, lastEvent: null,
    tok: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, // token 四桶
    daily: {}, // 'YYYY-MM-DD' -> 当日 token（每日消耗曲线用）
    dailyCost: {}, // 'YYYY-MM-DD' -> 当日估算成本(USD)，逐条消息按模型单价计
    dayTokComp: {}, // 'YYYY-MM-DD' -> { input,output,cacheRead,cacheCreate } token 分量（Token 构成用）
    dayCostComp: {}, // 'YYYY-MM-DD' -> { input,output,cacheRead,cacheCreate } 成本分量(USD)（成本构成用）
    hourly: {}, // 'YYYY-MM-DDTHH' -> 当小时 token（近 5h 窗口 + 今日时段图）
    hourlyCost: {}, // 'YYYY-MM-DDTHH' -> 当小时成本(USD)（今日时段图）
    activeMs: 0, prevTs: 0, // 累计活跃时长：相邻回合间隔 < ACTIVE_GAP 才算"在干活"
    dailyActiveMs: {}, // 'YYYY-MM-DD' -> 当日活跃毫秒（跨天清零、每项目今日时长用）
    // message.id -> 已计入的 usage 四分量历史最大值。**必须跟着 summary 进检查点**：
    // 一条 message 的多个 block 行会被增量续扫的 offset 断点劈开，丢了它续扫那半截
    // 就重新全额计一遍（活跃会话每 300ms 续扫一次 ⇒ 等于把 bug 原样装回去）。
    msgSeen: {},
  }
  const bumpActive = (ts) => { // #6 活跃时长：连续回合累加，长 idle 间隔不计
    if (!ts) return
    if (summary.prevTs && ts > summary.prevTs && ts - summary.prevTs < ACTIVE_GAP_MS) {
      const delta = ts - summary.prevTs
      summary.activeMs += delta
      const dk = dayOf(ts)
      summary.dailyActiveMs[dk] = (summary.dailyActiveMs[dk] || 0) + delta
    }
    summary.prevTs = ts
  }
  const events = resume?.events ?? []
  const fileChanges = resume?.fileChanges ?? []
  let todos = resume?.todos ?? []
  let evSeq = resume?.evSeq ?? 0
  // 断线续传 seq（4.2a，纯附加）：realId+文件世代(inode)+行字节偏移+行内子序号，
  // 唯一标识 JSONL 里产出的每个 UI 事件，供 4.2b 帧协议按 seq 续传/去重。
  const realId = path.basename(file, '.jsonl')
  const generation = String(st.ino)
  let curLineOffset = resume?.offset ?? 0 // 当前正在处理的 JSONL 行的起始字节偏移
  let subIndexInLine = 0  // 同一行内已产出的 UI 事件计数（从 0 起）
  const pushEvent = (e) => {
    if (e.type === 'file_op' && e.verb) summary.lastEvent = { ts: e.ts || 0, verb: e.verb, path: e.path ?? '' }
    if (wantEvents) {
      events.push({
        id: `${realId}-${++evSeq}`,
        seq: claudeSeq(realId, generation, curLineOffset, subIndexInLine++),
        ...e,
      })
    }
  }

  // 增量续扫（性能关键，见下方 cachedScan 注释）：JSONL 是 append-only，只解析 [start, safeEnd) 这段新增字节。
  // safeEnd 卡在**最后一个换行符之后**——正在写入的半行本轮不碰（否则 offset 会推过半行，下轮把后半截
  // 当成新行解析 → seq/事件全乱）。半行下一轮补完自然被读到，与旧行为（JSON.parse 失败即跳过）一致。
  const start = resume?.offset ?? 0
  const safeEnd = lastCompleteLineEnd(file, st.size)
  let runningOffset = start // 累计字节偏移（下一行的起始位置）
  const rl = safeEnd > start
    ? readline.createInterface({ input: fs.createReadStream(file, { start, end: safeEnd - 1 }), crlfDelay: Infinity })
    : []
  for await (const line of rl) {
    curLineOffset = runningOffset
    runningOffset += Buffer.byteLength(line, 'utf8') + 1 // readline 已剥离换行符，补回 1 字节 '\n'
    subIndexInLine = 0
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }

    if (d.type === 'ai-title' && d.aiTitle) summary.title = d.aiTitle
    if (d.type === 'permission-mode' && d.permissionMode) summary.mode = d.permissionMode
    if (d.gitBranch) summary.branch = d.gitBranch

    if (d.isSidechain) continue
    const ts = d.timestamp ? Date.parse(d.timestamp) : 0
    if (ts && !summary.startedAt) summary.startedAt = ts

    if (d.type === 'user' && d.message && !d.isMeta) { // isMeta=true 是注入消息(技能加载/命令输出)，非真实对话，跳过
      const t = textOf(d.message.content)
      if (!isNoise(t)) {
        if (!summary.firstPrompt) summary.firstPrompt = t.trim().slice(0, 120)
        summary.msgCount++
        bumpActive(ts)
        // 归档 KB 需要当时贴的截图 → 抽出图片块内联到事件（仅 wantEvents，base64 大不进 summary 扫描）
        const imgs = wantEvents ? imagesOf(d.message.content) : []
        pushEvent(imgs.length
          ? { ts, type: 'user', text: t.slice(0, 4000), images: imgs, imageCount: imgs.length }
          : { ts, type: 'user', text: t.slice(0, 4000) })
      }
    }

    if (d.type === 'assistant' && d.message) {
      // ★★ Claude Code 把一条 assistant 消息**按 content block 拆成多行 JSONL**，
      //   而每一行都带**完整的 message 级 usage**。这里逐行累加过，实扫 1,484 个
      //   transcript：95,128 行里 51,844 行(54.5%)是重复 message.id，
      //   token 308.6 亿 → 去重后 145.7 亿，**看板上的 token/成本/曲线全线虚高 52.8%**。
      //   规则与三个被数据否掉的想当然修法见 server/usage-dedupe.js 文件头。
      const seen = (summary.msgSeen ??= {})
      const mid = d.message.id
      const firstSeen = !mid || !seen[mid]
      if (firstSeen) summary.msgCount++   // 消息数同样不能按 block 行数虚报
      bumpActive(ts)
      const pm = prettyModel(d.message.model)
      if (pm) summary.model = pm
      const u = d.message.usage
      // 无 usage 的行也要登记 id，否则它的 block 兄弟行会被当成新消息重复计数
      const inc = creditUsage(seen, mid, u)
      if (u) {
        summary.tok.input += inc.input
        summary.tok.output += inc.output
        summary.tok.cacheRead += inc.cacheRead
        summary.tok.cacheCreate += inc.cacheCreate
        summary.tokens = summary.tok.input + summary.tok.output + summary.tok.cacheRead + summary.tok.cacheCreate
        const ti = inc.input, to = inc.output, tcr = inc.cacheRead, tcc = inc.cacheCreate
        const msgTok = ti + to + tcr + tcc
        if (ts && msgTok) {
          const day = dayOf(ts), hk = hourOf(ts)
          summary.daily[day] = (summary.daily[day] ?? 0) + msgTok
          summary.hourly[hk] = (summary.hourly[hk] ?? 0) + msgTok
          const dt = (summary.dayTokComp[day] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
          dt.input += ti; dt.output += to; dt.cacheRead += tcr; dt.cacheCreate += tcc
          const p = priceOf(pm || summary.model)
          if (p) {
            const ci = ti / 1e6 * p.in, co = to / 1e6 * p.out, ccr = tcr / 1e6 * p.cacheRead, ccc = tcc / 1e6 * p.cacheWrite
            const c = ci + co + ccr + ccc
            summary.dailyCost[day] = (summary.dailyCost[day] ?? 0) + c
            summary.hourlyCost[hk] = (summary.hourlyCost[hk] ?? 0) + c
            const dcc = (summary.dayCostComp[day] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
            dcc.input += ci; dcc.output += co; dcc.cacheRead += ccr; dcc.cacheCreate += ccc
          }
        }
      }
      const t = textOf(d.message.content)
      if (t.trim()) {
        summary.lastText = t.trim().slice(0, 120)
        pushEvent({ ts, type: 'assistant', text: t.slice(0, 6000) })
      }
      if (Array.isArray(d.message.content)) {
        for (const c of d.message.content) {
          if (c.type !== 'tool_use') continue
          const inp = c.input ?? {}
          switch (c.name) {
            case 'Read':
              pushEvent({ ts, type: 'file_op', verb: '读取文件', path: rel(inp.file_path) })
              break
            case 'Write': {
              const adds = String(inp.content ?? '').split('\n').length
              pushEvent({ ts, type: 'file_op', verb: '创建文件', path: rel(inp.file_path), additions: adds })
              if (wantEvents) pushFileChange(fileChanges, rel(inp.file_path), '', String(inp.content ?? ''))
              break
            }
            case 'Edit':
            case 'MultiEdit': {
              const olds = String(inp.old_string ?? '')
              const news = String(inp.new_string ?? '')
              pushEvent({
                ts, type: 'file_op', verb: '更新文件', path: rel(inp.file_path),
                additions: news ? news.split('\n').length : 0,
                deletions: olds ? olds.split('\n').length : 0,
              })
              if (wantEvents) pushFileChange(fileChanges, rel(inp.file_path), olds, news)
              break
            }
            case 'Bash':
              pushEvent({ ts, type: 'file_op', verb: '执行命令', path: String(inp.command ?? '').slice(0, 100) })
              break
            case 'TodoWrite':
              if (Array.isArray(inp.todos)) {
                todos = inp.todos.map((t2) => ({
                  text: t2.content ?? '',
                  status: t2.status === 'completed' ? 'done' : t2.status === 'in_progress' ? 'active' : 'pending',
                }))
              }
              break
            case 'Task':
              pushEvent({ ts, type: 'file_op', verb: '子代理', path: String(inp.description ?? c.name).slice(0, 100) })
              break
            case 'Grep':
            case 'Glob':
              break // 检索类不进流，降噪
            default:
              pushEvent({ ts, type: 'file_op', verb: '工具', path: c.name })
          }
        }
      }
    }
  }
  // 留存数组截断到远大于对外切片(150/8)的水位：既让 slice(-150)/slice(-8) 结果与全量扫描逐字节相同，
  // 又让续扫状态的内存不随会话长度无限涨（16MB 会话曾累积数千事件）。
  // 富余的那部分不是浪费——历史回填 `?limit=N` 就靠它够到 150 条窗口之外的早期回合。
  if (events.length > EVENTS_RETAIN) events.splice(0, events.length - EVENTS_RETAIN)
  if (fileChanges.length > 40) fileChanges.splice(0, fileChanges.length - 40)
  return {
    summary,
    payload: { events: windowEvents(events), fileChanges: fileChanges.slice(-8), todos },
    state: { summary, events, fileChanges, todos, evSeq, generation, offset: safeEnd },
  }
}

/** 文件里最后一个换行符之后的字节偏移（= 最后一个「完整行」的结尾）。用于增量续扫时不吃进半行。 */
function lastCompleteLineEnd(file, size) {
  if (!size) return 0
  const CHUNK = 65_536
  const fd = fs.openSync(file, 'r')
  try {
    let end = size
    while (end > 0) {
      const from = Math.max(0, end - CHUNK)
      const buf = Buffer.allocUnsafe(end - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      const i = buf.lastIndexOf(0x0a) // '\n'
      if (i >= 0) return from + i + 1
      end = from // 这一块没有换行（超长行），继续往前找
    }
    return 0
  } finally { fs.closeSync(fd) }
}

const rel = (p) => (p ? String(p).replace(/^\/data\/[^/]+\//, '') : '')

/** 本地时区下的 YYYY-MM-DD（每日消耗分桶用） */
const dayOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const hourOf = (ts) => `${dayOf(ts)}T${String(new Date(ts).getHours()).padStart(2, '0')}`
const ACTIVE_GAP_MS = 5 * 60_000 // 相邻回合间隔 < 5min 才算"在干活"（#6 活跃时长）

// 每百万 token 单价(USD)。cacheRead≈0.1×input、cacheWrite≈1.25×input(5m TTL)。
// 用于影子会话成本估算(平台会话用 SDK 实报 total_cost_usd，不走这里)。Codex/GPT 单价未知→不估。
const PRICING = {
  opus:   { in: 5,  out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet: { in: 3,  out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku:  { in: 1,  out: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
  fable:  { in: 10, out: 50, cacheRead: 1.0, cacheWrite: 12.5 },
}
function priceOf(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('opus')) return PRICING.opus
  if (m.includes('sonnet')) return PRICING.sonnet
  if (m.includes('haiku')) return PRICING.haiku
  if (m.includes('fable') || m.includes('mythos')) return PRICING.fable
  return null // 未知模型不估算
}
/** 影子会话成本估算：token 四桶 × 模型单价。未知模型返回 0。 */
function estCost(tok, model) {
  const p = priceOf(model)
  if (!p) return 0
  const c = (tok.input / 1e6) * p.in + (tok.output / 1e6) * p.out
    + (tok.cacheRead / 1e6) * p.cacheRead + (tok.cacheCreate / 1e6) * p.cacheWrite
  return Math.round(c * 100) / 100
}

/** BrightPath 契约：todos -> { done, active, total } 进度统计 */
const todoStatsOf = (todos) => ({
  done: todos.filter((t) => t.status === 'done').length,
  active: todos.filter((t) => t.status === 'active').length,
  total: todos.length,
})

function pushFileChange(arr, p, olds, news) {
  if (!p) return
  const cap = (s) => s.split('\n').slice(0, 40)
  const lines = [
    ...cap(olds).filter((l, i, a) => !(a.length === 1 && !l)).map((text) => ({ kind: 'del', no: null, text })),
    ...cap(news).filter((l, i, a) => !(a.length === 1 && !l)).map((text) => ({ kind: 'add', no: null, text })),
  ]
  arr.push({
    path: p,
    additions: news ? news.split('\n').length : 0,
    deletions: olds ? olds.split('\n').length : 0,
    lines,
  })
}

/**
 * 缓存 + **增量**扫描（性能关键路径）。
 *
 * 为什么必须增量：缓存键是 mtime，而**正在运行的会话每写一行 mtime 就变** → 全量重解析。
 * 一个 16MB 的长会话全量扫要 ~1s，而 SSE 每 300ms tick 一次 → 解析永远追不上 tick，
 * 且 setInterval(async) **不等上一轮跑完**，同一文件被多个全量扫同时碾 → event loop 被埋 →
 * 首帧 snapshot 发不出去 → 前端对话流永久空白 + 转圈（2026-07-12 线上实况）。会话一停写就自愈，
 * 所以它只在「大会话 + 正在跑」时发作，静态环境复现不出来。
 *
 * 两道防线：
 *  1) **增量续扫**：JSONL append-only ⇒ 同 inode 且只增长时，只解析新增字节（O(增量) 而非 O(文件)）。
 *  2) **并发合并**：同一文件同时进来的多路请求（多个 SSE tick + /api/state + 历史投影）共用一次解析。
 * 任一前提不成立（inode 变 / 文件缩小 / 被重写）→ 退回全量扫，正确性优先。
 */
const summaryInflight = new Map()
const eventsInflight = new Map()

async function cachedScan(file, wantEvents) {
  const st = fs.statSync(file)
  const cache = wantEvents ? eventsCache : summaryCache
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value

  const inflight = wantEvents ? eventsInflight : summaryInflight
  const pending = inflight.get(file)
  if (pending) return pending // 合并：已有同文件解析在跑，等它，不再起一个

  const p = (async () => {
    // 判据走共用实现（resume-guard.js）——原先这里是内联的第二份，与 Codex 侧迟早漂移。
    // 注意 hit.size 是缓存条目里的文件大小，对应 checkpoint 的 fileSize。
    let resume = canResume({ ...hit?.state, fileSize: hit?.size }, st) ? hit.state : null

    // ★ 内存里没有断点时，查持久化投影（Persistence V1）。
    //   实测（2026-08-13，.232）：不查投影时，agent 每次重启要重读 **780 MB**（60,825 次 read()）。
    //   投影里存着 {generation, fileSize, offset} + 全部跨行累积量，足以从断点续算。
    //
    //   ⚠️ **只对 summary 侧生效**：投影刻意不存 events（400 条 × 上千会话会让分片失控）。
    //      wantEvents 的路径若拿它当断点，会得到"有摘要但没事件"的残缺结果——
    //      那是"快但错"，比慢更坏。所以这里显式排除。
    if (!resume && !wantEvents) {
      const proj = projection.get(file)
      if (canResume(proj, st)) {
        resume = { summary: proj.summary, events: [], fileChanges: [], todos: [], evSeq: proj.evSeq ?? 0, generation: proj.generation, offset: proj.offset }
      }
    }

    const t0 = Date.now()
    const r = await scanFile(file, { wantEvents, resume })
    ingestMetrics.recordScan({
      ...scanBytes({ fileSize: st.size, knownSize: hit?.size, bytesRead: Math.max(0, r.state.offset - (resume?.offset ?? 0)) }),
      incremental: !!resume, seconds: (Date.now() - t0) / 1000,
    })
    const value = { summary: r.summary, payload: r.payload }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, state: r.state })
    if (!wantEvents) {
      projection.put(file, path.dirname(file), {
        generation: r.state.generation, fileSize: st.size, offset: r.state.offset,
        // ⚠️ 落盘前裁剪去重表：内存里不设上限（p95 才 46 条），但检查点是按项目分片的
        //    磁盘文件，单个长会话最多 3,476 条 id 会把分片撑爆。磁盘那份只服务
        //    "重启时恰好被 offset 劈开的那条 message"，必然是最近的几条。
        mtimeMs: st.mtimeMs, evSeq: r.state.evSeq,
        summary: r.summary?.msgSeen ? { ...r.summary, msgSeen: trimSeen(r.summary.msgSeen) } : r.summary,
      })
      scheduleProjectionFlush()
    }
    return value
  })()
  inflight.set(file, p)
  try { return await p } finally { inflight.delete(file) }
}

// ---------- Codex rollout 解析 ----------
const codexSummaryCache = createBoundedCache(CACHE_MAX_SUMMARY)
const codexEventsCache = createBoundedCache(CACHE_MAX_EVENTS)

function listCodexFilesUncached() {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full)
          if (Date.now() - st.mtimeMs < MAX_AGE_DAYS * 86_400_000) out.push({ full, mtimeMs: st.mtimeMs })
        } catch { /* 忽略 */ }
      }
    }
  }
  walk(CODEX_SESSIONS)
  return out
}

// Codex 增量续扫（2026-08-13）。原实现每次 mtime 一变就整文件重读——实测 11.66MB 的 rollout
// 追加 3,969 字节要重读 11.66MB，**读放大 3,081×**，且 page cache 同步涨 11.66MB。
// 改后实测：读 4,085 字节、page cache 涨 8,192 字节（2 个页，物理下限），读放大 1.03×。
//
// ⚠️ 源码原注释写着"Codex rollout 仍是全量扫（其文件远小于 Claude 会话）"——**这个前提早已不成立**：
//    实测 Codex 最大单文件 95.0MB > Claude 最大 73.8MB。豁免理由建立在过期事实上。
//
// ★ 解析主体（下面的 for await 那一大段）**逐字未改**，只改了两件事：
//    ① 取字节的方式：createReadStream 加 {start, end}
//    ② 结果的去向：多返回一个 state 供下次续扫
//   续扫判据走共用的 resume-guard.js，与 Claude/Kimi 同一份。
const listCodexFiles = createTtlMemo(listCodexFilesUncached, { ttlMs: DISCOVER_TTL_MS })

async function scanCodexFile(file, { wantEvents, resume = null }) {
  const summary = resume?.summary ?? {
    id: '', cwd: '', model: '', startedAt: 0, tokens: 0,
    // 归属线索（P0 #6）：同 Claude 侧，首个真实用户消息前 120 字，只捕获一次。Codex 的 `title`
    // 恰好也是"首次捕获后不覆写"（见下方 `if (!summary.title)`），但 title 上限只有 80 字且
    // 语义是"标题"；firstPrompt 独立成字段，上限 120，专供归属判断用，别混用两个字段的语义。
    firstPrompt: '',
    title: '', lastText: '', msgCount: 0, lastEvent: null,
    tok: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, // token 四桶
    daily: {}, // 'YYYY-MM-DD' -> 当日 token（用累计差值近似）
    dailyCost: {}, dayCostComp: {}, // Codex 暂无单价 → 恒空（保持结构一致）
    dayTokComp: {}, // 'YYYY-MM-DD' -> token 分量
    hourly: {}, hourlyCost: {}, // 'YYYY-MM-DDTHH' -> 当小时 token / 成本
    activeMs: 0, prevTs: 0,
    dailyActiveMs: {},
  }
  const bumpActive = (ts) => {
    if (!ts) return
    if (summary.prevTs && ts > summary.prevTs && ts - summary.prevTs < ACTIVE_GAP_MS) {
      const delta = ts - summary.prevTs
      summary.activeMs += delta
      const dk = dayOf(ts)
      summary.dailyActiveMs[dk] = (summary.dailyActiveMs[dk] || 0) + delta
    }
    summary.prevTs = ts
  }
  // ★ 这三组都是**跨行累积量**，必须随 checkpoint 一起带走。
  //   只存字节 offset 而不存它们，续算出来的 daily/token 分量会全错——
  //   而且不会报错，只会算错，界面照常显示。这正是「checkpoint 必须含累积态」的具体含义。
  let codexPrevCum = resume?.codexPrevCum ?? 0 // 上次 token_count 累计值（算每日增量）
  let codexPrev = resume?.codexPrev ?? { input: 0, output: 0, cacheRead: 0 } // 上次各分量累计
  const events = resume?.events ?? []
  let evSeq = resume?.evSeq ?? 0
  const pushEvent = (e) => {
    if (e.type === 'file_op' && e.verb) summary.lastEvent = { ts: e.ts || 0, verb: e.verb, path: e.path ?? '' }
    if (wantEvents) events.push({ id: `${path.basename(file, '.jsonl')}-${++evSeq}`, ...e })
  }

  // 与 Claude 侧同构：只解析 [start, safeEnd)，safeEnd 卡在**最后一个换行之后**——
  // 正在写入的半行本轮不碰，否则 offset 推过半行、下轮把后半截当新行 ⇒ 事件全乱。
  const st = fs.statSync(file)
  const start = resume?.offset ?? 0
  const safeEnd = lastCompleteLineEnd(file, st.size)
  const rl = safeEnd > start
    ? readline.createInterface({ input: fs.createReadStream(file, { start, end: safeEnd - 1 }), crlfDelay: Infinity })
    : []
  for await (const line of rl) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    const ts = d.timestamp ? Date.parse(d.timestamp) : 0
    const p = d.payload ?? {}

    summary.turn = advanceShadowTurn(summary.turn, d, 'codex')

    if (d.type === 'session_meta') {
      summary.id = p.id ?? ''
      summary.cwd = p.cwd ?? ''
      summary.source = p.source ?? null
      summary.startedAt = ts || summary.startedAt
      continue
    }
    if (d.type === 'turn_context' && p.model) { summary.model = p.model; continue }

    if (d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const texts = (p.content ?? []).filter((c) => c.type === 'input_text').map((c) => c.text)
      const t = texts.join('\n').trim()
      if (t && !t.startsWith('<')) {
        if (!summary.firstPrompt) summary.firstPrompt = t.slice(0, 120)
        summary.msgCount++
        bumpActive(ts)
        if (!summary.title) summary.title = t.slice(0, 80)
        pushEvent({ ts, type: 'user', text: t.slice(0, 4000) })
      }
      continue
    }
    const assistantText = codexAssistantMessage(d, summary)
    if (assistantText != null) {
      summary.msgCount++
      bumpActive(ts)
      summary.lastText = assistantText.slice(0, 120)
      pushEvent({ ts, type: 'assistant', text: assistantText.slice(0, 6000) })
      continue
    }
    // ⚠️ 必须同时收 custom_tool_call（2026-08-02）：Codex 现在把命令执行记成
    // `custom_tool_call` + name=`exec`，载荷在 **input**（一段字符串）而不是 arguments。
    // 只认 function_call/exec_command/shell 的话，实测某会话 611 次 exec **一条都不显示**，
    // 对话流里看不到任何工具活动（用户报「对话明显缺失」时同时踩到了这个）。
    // 工具名/载荷字段都是随 codex 版本变的，加新形态时**先去 JSONL 里数一遍真实分布**，别照猜。
    if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      let args = {}
      try { args = JSON.parse(p.arguments ?? '{}') } catch { /* 保持空 */ }
      if (p.name === 'exec' && typeof p.input === 'string') {
        pushEvent({ ts, type: 'file_op', verb: '执行命令', path: p.input.replace(/\s+/g, ' ').trim().slice(0, 100) })
      } else if (p.name === 'exec_command' || p.name === 'shell') {
        const cmd = args.cmd ?? (Array.isArray(args.command) ? args.command.join(' ') : args.command) ?? ''
        pushEvent({ ts, type: 'file_op', verb: '执行命令', path: String(cmd).slice(0, 100) })
      } else if (p.name === 'apply_patch') {
        pushEvent({ ts, type: 'file_op', verb: '更新文件', path: String(args.path ?? args.file ?? '补丁').slice(0, 100) })
      }
      continue
    }
    if (d.type === 'event_msg' && p.type === 'token_count') {
      const u = p.info?.total_token_usage
      if (u) {
        // Codex 的 input_tokens 已含 cached_input_tokens，拆分时减去避免重复计
        const cached = u.cached_input_tokens ?? 0
        summary.tok.cacheRead = cached
        summary.tok.input = Math.max(0, (u.input_tokens ?? 0) - cached)
        summary.tok.output = u.output_tokens ?? 0
        summary.tok.cacheCreate = 0
        summary.tokens = summary.tok.input + summary.tok.output + summary.tok.cacheRead
        // 每日近似：累计值差值按事件日期归集（总量 + 分量，保证今日 token 构成自洽）
        const cum = u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0))
        const delta = cum - codexPrevCum
        if (ts && delta > 0) {
          const day = dayOf(ts)
          summary.daily[day] = (summary.daily[day] ?? 0) + delta
          summary.hourly[hourOf(ts)] = (summary.hourly[hourOf(ts)] ?? 0) + delta
          const dt = (summary.dayTokComp[day] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
          dt.input += Math.max(0, summary.tok.input - codexPrev.input)
          dt.output += Math.max(0, summary.tok.output - codexPrev.output)
          dt.cacheRead += Math.max(0, summary.tok.cacheRead - codexPrev.cacheRead)
          codexPrev = { input: summary.tok.input, output: summary.tok.output, cacheRead: summary.tok.cacheRead }
        }
        if (cum >= codexPrevCum) codexPrevCum = cum
      }
    }
  }
  // 事件留存封顶（与 Claude 侧 EVENTS_RETAIN 同口径）。续扫会不断往同一个数组追加，
  // 不封顶就是无界增长。对外窗口仍由 windowEvents 取尾部 150，从 400 条里取与从全量里取等价。
  if (events.length > EVENTS_RETAIN) events.splice(0, events.length - EVENTS_RETAIN)
  return {
    summary,
    payload: { events: windowEvents(events), fileChanges: [], todos: [] },
    state: { summary, events, evSeq, codexPrevCum, codexPrev, generation: String(st.ino), fileSize: st.size, offset: safeEnd },
  }
}

// Codex rollout 仍是全量扫（其文件远小于 Claude 会话），但同样做**并发合并**：
// 否则多个 SSE tick + /api/state 会对同一文件并行起多份解析，与 Claude 侧同一个雪崩机理。
const codexInflight = new Map()

async function cachedCodexScan(file, wantEvents) {
  const st = fs.statSync(file)
  const cache = wantEvents ? codexEventsCache : codexSummaryCache
  const hit = cache.get(file)
  // ⚠️ 缓存键必须同时比 mtime **和 size**。原实现只比 mtime——正在写的文件每追加一行 mtime 就变，
  //    于是每次都判定为"脏"并整文件重读；而 size 参与后，配合下面的 canResume 就只读增量。
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value

  const key = `${wantEvents ? 'E' : 'S'}:${file}`
  const pending = codexInflight.get(key)
  if (pending) return pending // 合并：已有同文件解析在跑，等它，不再起一个

  const p = (async () => {
    // 续扫判据走共用实现（resume-guard.js），与 Claude/Kimi 同一份，不在这里重新推导。
    const resume = canResume(hit?.state, st) ? hit.state : null
    const t0 = Date.now()
    const value = await scanCodexFile(file, { wantEvents, resume })
    ingestMetrics.recordScan({
      ...scanBytes({ fileSize: st.size, knownSize: hit?.size, bytesRead: Math.max(0, value.state.offset - (resume?.offset ?? 0)) }),
      incremental: !!resume, seconds: (Date.now() - t0) / 1000,
    })
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value: { summary: value.summary, payload: value.payload }, state: value.state })
    return { summary: value.summary, payload: value.payload }
  })()
  codexInflight.set(key, p)
  try { return await p } finally { codexInflight.delete(key) }
}

// ---------- 会话清单 ----------
const idToFile = new Map()
const idToCwd = new Map()
const idToEngine = new Map()
const shadowState = new Map() // 影子会话最近一次计算的状态（接管前校验用）
const reattachLocks = new Set() // 正在 reattach 的 realSessionId：并发点"恢复会话"时快速 409，防近同时双拉起（Phase 1b）
const maintenanceLease = createMaintenanceLease()
const mutationActivity = createActivityCounter()
let shuttingDown = false

// ---------- 会话派生闸门（AM-260718-401）----------
// 派生闸门与槽位记账都在 session-gate.js（纯逻辑、可单测，见 session-gate.test.mjs）；
// 这里只负责把四条派生路径接上去。
const sessionGate = createSpawnGate({
  max: MAX_SESSIONS,
  minIntervalMs: SPAWN_MIN_INTERVAL_MS,
  queueWaitMs: SPAWN_QUEUE_WAIT_MS,
  maxQueue: SPAWN_QUEUE_MAX,
})
// 排队必须留痕：2026-07-19 那次闸门焊死在 8/8，日志里**一条记录都没有**，
// 事后只能靠 /api/state 现场抓。排不上队是运维信号，不是内部细节。
/**
 * 读本机 worker slice 的内存读数（会话子进程都在里面）。
 * ⚠️ **必须连 swap 一起读**：cgroup v2 的 `memory.max` 不统计 swap，
 *    只看 current 会在事故那种"1353M 匿名 + 1276M swap"的形态下得出"还很宽裕"的错觉。
 */
const WORKER_CG = '/sys/fs/cgroup/web.slice/web-agents.slice/web-agents-worker.slice'
function readWorkerCgroup() {
  const rd = (f) => { try { return fs.readFileSync(`${WORKER_CG}/${f}`, 'utf-8').trim() } catch { return null } }
  const cur = rd('memory.current')
  if (cur == null) return null
  return { current: Number(cur), swapCurrent: Number(rd('memory.swap.current') ?? 0), max: rd('memory.max') ?? 'max' }
}
/** 实测单会话均值：拿 worker slice 当前用量 ÷ 在跑的会话数，比写死的常量贴近本机实况。 */
function avgSessionBytes(cg) {
  const n = sessionGate.stats().active
  if (!cg || !n || n < 1) return null
  return Math.round((cg.current + (cg.swapCurrent || 0)) / n)
}

const spawnGated = (create) => {
  const s = sessionGate.stats()
  if (s.active >= s.max || s.queued > 0) {
    console.warn(`[gate] 派生请求排队：并发 ${s.active}/${s.max} 已满，队列 ${s.queued} 位，最多等 ${Math.round(s.queueWaitMs / 1000)}s`)
  }
  // ★ R2（2026-08-30 事故整改）：条数够不代表内存够。
  //   事故里单会话稳定占 200~350MB，而可用内存不足 1.5G，闸门却按条数放到了 9 个。
  //   这里在**条数闸之前**再加一道内存余量判据；不足就走排队路径，不硬起。
  if (memAdmitEnabled()) {
    const cg = readWorkerCgroup()
    const verdict = admitDecision({ cgroup: cg, avgSessionBytes: avgSessionBytes(cg) })
    lastAdmit = { ...verdict, at: Date.now() }
    if (!verdict.admit) {
      console.warn(`[gate] 内存余量不足，派生请求排队：${verdict.reason}`)
      return sessionGate.spawn(create, { memoryBlocked: true })
    }
  }
  return sessionGate.spawn(create)
}
/** 只有显式 "0" 才关（与本仓库其它开关同口径）。 */
const memAdmitEnabled = () => process.env.WA_MEM_ADMIT !== '0'
let lastAdmit = null
const freeSlot = (id) => sessionGate.free(id)
const reapLog = [] // 最近的回收记录，供 /api/state 事后审计"谁把我的会话收了"

/** 闸门错误 → HTTP 503（含排队位次，便于调用方退避重试）。非闸门错误返回 null。 */
function gateErrorResponse(e) {
  if (e?.code !== 'QUEUE_TIMEOUT' && e?.code !== 'QUEUE_FULL') return null
  return {
    status: 503,
    body: {
      error: e.message,
      code: e.code,
      queued: e.code === 'QUEUE_TIMEOUT',
      position: e.position,
      active: e.active,
      max: e.max,
      retryAfterMs: SPAWN_MIN_INTERVAL_MS,
    },
  }
}

// ---------- 挂起会话回收（AM-260718-401 要求 3）----------
// 判定口径见 server/session-reaper.js（纯函数、可单测）；这里只负责取证据。
// ⚠️ 取证失败一律当作"可能还活着"→ 跳过。宁可漏杀不可错杀：错杀 = 直接掐掉用户正在干的活。
const cpuSamples = new Map() // pid -> {ticks, atMs}

/** 读 /proc/<pid>/stat 的 utime+stime（累计 tick）。comm 字段可能含空格/括号，必须从最后一个 ')' 之后切。 */
function procTicks(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ')
    // 切完 rest[0] 是 field 3(state)，故 field N → rest[N-3]：utime=14→rest[11]，stime=15→rest[12]
    const t = Number(rest[11]) + Number(rest[12])
    return Number.isFinite(t) ? t : null
  } catch { return null }
}

/** 扫出本机所有 claude/codex/kimi 进程及其 cwd/cmdline，供会话归属判定。 */
function scanCliProcs() {
  const out = []
  let pids = []
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)) } catch { return out }
  for (const pid of pids) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!/claude|codex|kimi/i.test(cmdline)) continue
      out.push({ pid, cmdline, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) })
    } catch { /* 进程已退出或无权限 */ }
  }
  return out
}

/**
 * 把进程归属到会话。两条证据，都拿不到就返回 null（→ CPU 视为未知 → 不回收）：
 *   ① cmdline 里含 realSessionId —— `claude --resume <uuid>`，铁证；
 *   ② cwd 命中且该 cwd 下**只有一个**平台会话、**只有一个**候选进程 —— 唯一才敢认，
 *      有歧义就放弃（新建会话的 cmdline 里没有 uuid，只能靠 cwd，宁可不猜）。
 */
function attributePid(sess, procs, cwdSessionCount) {
  if (sess.realSessionId) {
    const hit = procs.find((p) => p.cmdline.includes(sess.realSessionId))
    if (hit) return hit.pid
  }
  if (cwdSessionCount.get(sess.cwd) !== 1) return null
  const inCwd = procs.filter((p) => p.cwd === sess.cwd && /claude/i.test(p.cmdline))
  return inCwd.length === 1 ? inCwd[0].pid : null
}

/** 会话的 JSONL 最后写入时间（权威源）。找不到文件 → null → 不回收。 */
function jsonlIdleMsOf(sess) {
  let file = null
  const alias = sessionStore.get(sess.id)
  if (alias?.jsonlPath && fs.existsSync(alias.jsonlPath)) file = alias.jsonlPath
  else if (sess.engine === 'claude' && sess.realSessionId) file = findClaudeJsonlByRealId(sess.cwd, sess.realSessionId)
  else if (sess.realSessionId) file = idToFile.get(sess.realSessionId) ?? null
  if (!file) return null
  try { return Date.now() - fs.statSync(file).mtimeMs } catch { return null }
}

const reapInFlight = new Set() // 正在回收的会话 id：回收可能耗时十几秒，别让下一拍重复进场

/** 单个会话的进程归属（供 /release 端点用；回收循环里走批量版，避免每个会话都全扫 /proc）。 */
function pidForSession(sess) {
  if (!sess || sess.engine === 'codex' || sess.engine === 'kimi') return null
  const live = [...driver.listSessions(), ...codexDriver.listSessions(), ...kimiDriver.listSessions()]
  const cwdSessionCount = new Map()
  for (const s of live) cwdSessionCount.set(s.cwd, (cwdSessionCount.get(s.cwd) ?? 0) + 1)
  return attributePid(sess, scanCliProcs(), cwdSessionCount)
}

/** releaseWithDeadline 的 I/O 绑定（判定逻辑与超时/杀进程编排在 session-reaper.js，可单测）。 */
const reapRelease = (drv, id, pid) => releaseWithDeadline({
  release: () => drv.release(id),
  pid,
  kill: (p, sig) => { try { process.kill(p, sig) } catch { /* 进程已退出 */ } },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs: REAP_RELEASE_TIMEOUT_MS,
})

async function reapHungSessions() {
  const live = [...driver.listSessions(), ...codexDriver.listSessions(), ...kimiDriver.listSessions()]
  if (live.length === 0) return
  const procs = scanCliProcs()
  const cwdSessionCount = new Map()
  for (const s of live) cwdSessionCount.set(s.cwd, (cwdSessionCount.get(s.cwd) ?? 0) + 1)

  const seenPids = new Set()
  for (const s of live) {
    const sharedProcessEngine = s.engine === 'codex' || s.engine === 'kimi'
    const pid = sharedProcessEngine ? null : attributePid(s, procs, cwdSessionCount)
    let cpuPercent = null
    if (pid) {
      seenPids.add(pid)
      const cur = { ticks: procTicks(pid), atMs: Date.now() }
      if (cur.ticks != null) {
        cpuPercent = cpuPercentFromSamples(cpuSamples.get(pid), cur, CLK_TCK)
        cpuSamples.set(pid, cur)
      }
    }
    const verdict = decideReap({
      origin: 'platform',
      state: s.state,
      inflight: s.inflight,
      ageMs: Date.now() - s.startedAt,
      jsonlIdleMs: jsonlIdleMsOf(s),
      cpuPercent,
      // Codex/Kimi 多会话共享一个 app-server/ACP 进程，没有"本会话的 CPU"可测；靠 inflight 判权威状态。
      cpuApplicable: !sharedProcessEngine,
      // Claude 会话归属不到进程时不能断言"进程没了"（可能只是 cwd 有歧义），故一律 true，
      // 交给 cpuPercent=null 的 fail-safe 去兜。
      procAlive: true,
      idleReapMs: REAP_IDLE_MS,
      waitingReapMs: REAP_WAITING_MS,
      minAgeMs: REAP_MIN_AGE_MS,
      unattributedIdleMs: REAP_UNATTRIBUTED_IDLE_MS,
      inflightGraceMs: REAP_INFLIGHT_GRACE_MS,
      cpuGraceMs: REAP_CPU_GRACE_MS,
    })
    if (!verdict.reap || reapInFlight.has(s.id)) continue

    // 回收是**非自愿**的释放：必须保住持久化身份，否则 psId 一没，用户的深链和"恢复会话"
    // 就全废了（driver.release 会顺手 sessionStore.remove——那是用户**主动**释放的语义）。
    // JSONL 不受影响，会话退回影子态，之后仍可 takeover/reattach 续上。
    const alias = sessionStore.get(s.id)
    reapInFlight.add(s.id)
    try {
      const drv = driverFor(s.id)
      const outcome = drv ? await reapRelease(drv, s.id, pid) : 'stuck'
      if (alias) sessionStore.upsert(alias, { immediate: true })
      if (outcome === 'stuck') {
        // 没能确认收掉 → **不归还槽位**。宁可少放几个新会话，也不能一边没真收掉、
        // 一边又放新的进来，那等于上限被悄悄突破，回到 OOM 老路。
        console.error(`[reap] ${s.id} 释放未确认（进程可能仍在），保留槽位不放行新会话`)
        continue
      }
      freeSlot(s.id)
      const entry = { id: s.id, project: s.project, engine: s.engine, reason: verdict.reason, outcome, at: Date.now() }
      reapLog.push(entry)
      if (reapLog.length > 50) reapLog.splice(0, reapLog.length - 50)
      console.log(`[reap] 回收挂起会话 ${s.id}(${s.project}/${s.engine})[${outcome}]：${verdict.reason}`)
    } catch (e) {
      console.error(`[reap] 回收 ${s.id} 失败：${String(e?.message ?? e)}`)
    } finally {
      reapInFlight.delete(s.id)
    }
  }
  // 采样表跟着活进程走，别把已退出的 pid 攒成内存泄漏
  for (const pid of [...cpuSamples.keys()]) if (!seenPids.has(pid)) cpuSamples.delete(pid)
}

async function buildState() {
  const hostname = os.hostname()
  const active = activeCliCwds()
  const now = Date.now()
  const platformIds = new Set([...driver.realSessionIds(), ...codexDriver.realSessionIds(), ...kimiDriver.realSessionIds()])
  const sessions = [...driver.listSessions(), ...codexDriver.listSessions(), ...kimiDriver.listSessions()]
    .map((s) => ({ ...s, serverId: hostname }))
  // 平台会话也要登记引擎；事件续传据此为 Codex/Kimi 选择数字 seq 比较器。
  for (const s of sessions) {
    idToCwd.set(s.id, s.cwd)
    idToEngine.set(s.id, s.engine)
  }
  // realSessionId -> 平台会话条目：原生进程续接同一会话时按文件刷新其活性（见 refreshPlatformFromFile）
  const platformByReal = new Map()
  for (const s of sessions) { if (s.realSessionId) platformByReal.set(s.realSessionId, s) }

  // ---- 分离态会话（session-durability Phase 1a）：agent 重启后按 store 别名精确恢复 ----
  // store 里每条 Claude 平台身份（其 realId 已不是 live 平台会话）→ 定位 JSONL，发一条 detached 条目：
  // id 沿用原 psId（旧深链命中），state 每轮从 JSONL mtime+/proc **实时重算**（不信 persisted lastState，
  // 修 Codex-P0-1），summary/model/tokens 从 JSONL 补齐；同 realId 的影子孪生在下面扫描里被 detachedReals
  // 抑制，避免双列（复用既有 platformIds 跳过范式）。JSONL 定位不依赖看板 top-N（findClaudeJsonlByRealId，修 P0-4）。
  const detachedReals = new Set()
  for (const alias of Object.values(sessionStore.all())) {
    if (alias.engine !== 'claude' || !alias.realSessionId) continue
    if (excludedProject(path.basename(alias.cwd || ''))) continue // 排除项目不进看板（与影子扫描一致）
    if (platformIds.has(alias.realSessionId)) continue // 已重新接管为 live，无需 detached
    const file = (alias.jsonlPath && fs.existsSync(alias.jsonlPath))
      ? alias.jsonlPath
      : findClaudeJsonlByRealId(alias.cwd, alias.realSessionId)
    if (!file) continue
    let mtimeMs
    try { mtimeMs = fs.statSync(file).mtimeMs } catch { continue }
    if (now - mtimeMs > MAX_AGE_DAYS * 86_400_000) continue
    const { summary, payload } = await cachedScan(file, false)
    if (summary.msgCount === 0) continue
    // detached 的旧 mtime 不能单独证明仍在跑：agent 重启已杀掉原 SDK 子进程。只有 /proc 明确
    // 命中同 realId 的原生 resume 进程才显示活跃，否则立即收敛为 idle，并标明未确认完成的回合。
    const nativeActive = realIdActiveInProc(alias.realSessionId)
    const interrupted = interruptedByRestart(alias, nativeActive)
    const state = nativeActive ? shadowStateOf(mtimeMs, true, now) : 'idle'
    detachedReals.add(alias.realSessionId)
    idToFile.set(alias.psId, file)
    idToCwd.set(alias.psId, alias.cwd)
    idToEngine.set(alias.psId, 'claude')
    shadowState.set(alias.psId, state)
    sessions.push({
      id: alias.psId,
      serverId: hostname,
      project: path.basename(alias.cwd),
      branch: summary.branch,
      engine: 'claude',
      model: alias.model || summary.model || 'Claude',
      mode: alias.mode || (summary.mode === 'auto' ? 'acceptEdits' : summary.mode),
      state,
      summary: summary.title || summary.lastText || '（无摘要）',
      firstPrompt: summary.firstPrompt || '',
      startedAt: alias.createdAt || summary.startedAt || mtimeMs,
      lastActiveAt: mtimeMs,
      cost: estCost(summary.tok, summary.model),
      tokens: summary.tokens,
      tokensBreakdown: { ...summary.tok },
      activeMs: summary.activeMs,
      activeMsToday: summary.dailyActiveMs[dayOf(now)] || 0,
      costToday: summary.dailyCost[dayOf(now)] || 0,
      tokensToday: summary.daily[dayOf(now)] || 0,
      origin: 'platform',
      detached: true,
      // 分离态不由本 agent 的进程内 SDK 驱动（子进程已随上次重启消失；若 nativeActive 则由独立原生进程跑）——
      // agent 再次重启不会截断它，故永不作为「在飞」阻塞排空/部署（即便 state 因 nativeActive 显示 running）。
      inflight: false,
      interrupted,
      lostPending: !!alias.hadPending,
      detachedReason: interrupted
        ? 'agent 在回合进行中重启；最后一回合可能未完成，历史只读，可恢复后继续'
        : 'agent 重启，会话已分离；历史只读，可点恢复重新接管',
      realSessionId: alias.realSessionId,
      cwd: alias.cwd,
      lastEvent: summary.lastEvent,
      todoStats: todoStatsOf(payload.todos),
    })
  }

  for (const proj of discoverProjects()) {
    let files = []
    try {
      files = fs.readdirSync(proj.sessDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(proj.sessDir, f)
          return { full, mtimeMs: fs.statSync(full).mtimeMs }
        })
        .filter((f) => now - f.mtimeMs < MAX_AGE_DAYS * 86_400_000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      // 不在此按 mtime 截断到 MAX_PER_PROJECT：空 stub（msgCount==0，如 `claude --resume` 即退的续接残留）
      // 常比真实长对话更新，先截断再滤空会把真会话挤出、整个项目无对话流（myskills 就因 4 个空 stub 比真
      // 会话新而 Claude 流消失）。改为循环里只让"真会话"占名额、满 MAX_PER_PROJECT 即停；i<40 是成本护栏。
    } catch { continue }

    let shown = 0 // 已纳管的"真"会话数（空 stub 不计），据此封顶 MAX_PER_PROJECT
    for (let i = 0; i < files.length && shown < MAX_PER_PROJECT && i < 40; i++) {
      const f = files[i]
      const id = path.basename(f.full, '.jsonl')
      idToFile.set(id, f.full)
      idToCwd.set(id, proj.cwd)
      idToEngine.set(id, 'claude')
      if (detachedReals.has(id)) { shown++; continue } // 已作为 detached 条目发出，抑制影子孪生；但占项目名额
      if (platformIds.has(id)) {
        // 平台拉起/接管中的会话由 driver 提供，避免重复；但若有原生进程在续接同一会话、
        // 文件比 driver 记录更新，则按文件刷新该平台条目的状态/活跃时间（否则会误显示为 idle）。
        const ps = platformByReal.get(id)
        if (ps) {
          const projActive = shown === 0 && active.claude.has(proj.cwd)
          const fileState = shadowStateOf(f.mtimeMs, projActive, now)
          const r = refreshPlatformFromFile(ps, f.mtimeMs, fileState)
          ps.state = r.state
          ps.lastActiveAt = r.lastActiveAt
        }
        shown++ // 平台会话占该项目一个名额
        continue
      }
      const { summary, payload } = await cachedScan(f.full, false)
      if (summary.msgCount === 0) continue // 空 stub 不占名额（关键修复：别让它把真会话挤出 top-N）
      // 进程活性只归属该项目最新的"真"会话，旧会话一律 idle
      const projActive = shown === 0 && active.claude.has(proj.cwd)
      const state = shadowStateOf(f.mtimeMs, projActive, now)
      shadowState.set(id, state)
      sessions.push({
        id,
        serverId: hostname,
        project: proj.name,
        branch: summary.branch,
        engine: 'claude',
        model: summary.model || 'Claude',
        mode: summary.mode === 'auto' ? 'acceptEdits' : summary.mode,
        state,
        summary: summary.title || summary.lastText || '（无摘要）',
        firstPrompt: summary.firstPrompt || '',
        startedAt: summary.startedAt || f.mtimeMs,
        lastActiveAt: f.mtimeMs,
        cost: estCost(summary.tok, summary.model), // 影子会话按单价估算（平台会话用 SDK 实报）
        tokens: summary.tokens,
        tokensBreakdown: { ...summary.tok },
        activeMs: summary.activeMs, // #6 累计活跃时长
        activeMsToday: summary.dailyActiveMs[dayOf(Date.now())] || 0, // 今日活跃（跨天清零）
        costToday: summary.dailyCost[dayOf(Date.now())] || 0,         // 今日成本（Codex 无单价=0）
        tokensToday: summary.daily[dayOf(Date.now())] || 0,           // 今日 token
        origin: 'shadow',
        cwd: proj.cwd,
        lastEvent: summary.lastEvent,
        todoStats: todoStatsOf(payload.todos),
      })
      shown++ // 真会话已纳管，占一个名额
    }
  }

  // Codex 影子会话：按 cwd 归属到 /data 项目，每项目取最近 2 个
  const codexByProject = new Map()
  for (const f of listCodexFiles()) {
    const { summary } = await cachedCodexScan(f.full, false)
    if (!summary.id || summary.msgCount === 0 || isCodexSubagent(summary.source)) continue
    if (!summary.cwd.startsWith(DATA_ROOT + '/')) continue
    const projName = summary.cwd.slice(DATA_ROOT.length + 1).split('/')[0]
    if (excludedProject(projName)) continue
    const list = codexByProject.get(projName) ?? []
    list.push({ f, summary, projName })
    codexByProject.set(projName, list)
  }
  for (const list of codexByProject.values()) {
    list.sort((a, b) => b.f.mtimeMs - a.f.mtimeMs)
    list.slice(0, 2).forEach(({ f, summary, projName }, i) => {
      const id = summary.id
      idToFile.set(id, f.full)
      idToCwd.set(id, summary.cwd)
      idToEngine.set(id, 'codex')
      // live Codex thread 的 API id 就是原生 threadId；driver 条目已在 sessions 里，不能再追加
      // 同 id 影子条目，否则前端按 id 对账/选主会话时会在 platform 与 shadow 之间漂移。
      if (platformIds.has(id)) return
      const projActive = i === 0 && active.codex.has(summary.cwd)
      const state = shadowStateOf(f.mtimeMs, projActive, now, summary.turn)
      shadowState.set(id, state)
      sessions.push({
        id,
        serverId: hostname,
        project: projName,
        branch: '',
        engine: 'codex',
        model: summary.model || 'GPT',
        mode: 'default',
        state,
        summary: summary.lastText || summary.title || '（无摘要）',
        firstPrompt: summary.firstPrompt || '',
        startedAt: summary.startedAt || f.mtimeMs,
        lastActiveAt: f.mtimeMs,
        cost: 0,
        tokens: summary.tokens,
        tokensBreakdown: { ...summary.tok },
        activeMs: summary.activeMs, // #6 累计活跃时长
        activeMsToday: summary.dailyActiveMs[dayOf(Date.now())] || 0, // 今日活跃（跨天清零）
        costToday: summary.dailyCost[dayOf(Date.now())] || 0,         // 今日成本（Codex 无单价=0）
        tokensToday: summary.daily[dayOf(Date.now())] || 0,           // 今日 token
        origin: 'shadow',
        cwd: summary.cwd,
        lastEvent: summary.lastEvent,
        todoStats: todoStatsOf([]),
      })
    })
  }


  // Kimi 影子会话：与 Claude/Codex 对称纳管。数据在 ~/.kimi-code（见 kimi-shadow.js）——
  // 此前完全没扫，Kimi 会话只在 agent 内存里活着，重启即消失、终端起的从不出现，
  // 「会话历史」永远只有两家（2026-08-01 用户报的就是这个）。每项目取最近 2 个，与 Codex 同口径。
  const kimiByProject = new Map()
  for (const k of scanKimiSessions()) {
    if (!k.cwd.startsWith(DATA_ROOT + '/')) continue
    const projName = k.cwd.slice(DATA_ROOT.length + 1).split('/')[0]
    if (excludedProject(projName)) continue
    const list = kimiByProject.get(projName) ?? []
    list.push({ k, projName })
    kimiByProject.set(projName, list)
  }
  for (const list of kimiByProject.values()) {
    list.sort((a, b) => b.k.mtimeMs - a.k.mtimeMs)
    for (const [i, { k, projName }] of list.slice(0, 2).entries()) {
      idToFile.set(k.id, k.wirePath)
      idToCwd.set(k.id, k.cwd)
      idToEngine.set(k.id, 'kimi')
      // 同 id 孪生：平台会话已在 sessions 里，不能再追加影子条目（Codex 那条坑同样成立）
      if (platformIds.has(k.id)) continue
      const projActive = i === 0 && active.kimi?.has(k.cwd)
      const { summary } = await cachedKimiScan(k.wirePath)
      const state = shadowStateOf(k.mtimeMs, !!projActive, now, summary.turn)
      shadowState.set(k.id, state)
      sessions.push({
        id: k.id,
        serverId: hostname,
        project: projName,
        branch: '',
        engine: 'kimi',
        model: 'Kimi',
        mode: 'default',
        state,
        summary: k.lastPrompt || k.title || '（无摘要）',
        firstPrompt: k.title || '',
        startedAt: k.mtimeMs,
        lastActiveAt: k.mtimeMs,
        cost: 0,
        tokens: 0,
        origin: 'shadow',
        cwd: k.cwd,
        todoStats: todoStatsOf([]),
      })
    }
  }

  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  // 名额分配见 session-allocate.js（纯函数 + 单测）。**别改回 sessions.slice(0, MAX_TOTAL)**：
  // 那是全局截断，会让「我的项目在不在看板上」取决于别的项目有多活跃——2026-07-21 用户实拍
  // invest_data 整个项目消失，就是 22 个项目挤 40 个名额、它 3 天没动被挤出去了。
  const alloc = allocateSessions(sessions, MAX_TOTAL)
  return {
    // bootId/bootAt：**每个 agent 进程一份，重启即变**。Hub 靠它识别「这台 agent 重启过」——
    // 这是「从一次真实故障生成完整时间线」的地基（openspec 5.4）。没有它，hub 只能靠 online 跳变猜，
    // 而 agent 重启只要 2 秒、hub 每 5 秒才轮一次，多数重启它**根本看不见**——可那一刻正是
    // 平台会话被 SIGKILL 的时刻（本项目最痛的一类事故）。
    // sessionGate：并发闸门与回收的可观测面（AM-260718-401）。挂在 server 里而不是顶层——
    // 它是**每台机器**的容量状态，hub 按 server 聚合时才能天然带上（和 bootId 同理）。
    server: {
      id: hostname, name: hostname, region: '腾讯云 · 本机', flag: '🇨🇳', online: true, bootId: BOOT_ID, bootAt: BOOT_AT,
      sessionGate: { ...sessionGate.stats(), reaped: reapLog.slice(-10), memAdmit: lastAdmit },
      // ★ R6：把"真实在跑"与"分离态可恢复身份"分开报。混在一个数里会让故障时的规模判断虚高
      //   （事故复盘写「挂着 9 个会话」，实际占内存的只有 4 个）。容量判断只能看 platformLive。
      census: census(sessions),   // ⚠️ 用未截断的 sessions，不是 alloc.sessions —— 名额截断后计数会虚低
      // 主机负载：hub 侧 checkLoad 用 5 分钟均值(load[1])判过载告警（和 sessionGate 同理——每机状态挂 server 里）。
      load: os.loadavg(), cores: os.cpus().length,
    },
    sessions: alloc.sessions,
    // 截断必须明示：静默截断会让前端把残缺当全集（同「没有静默上限」原则）。
    // hiddenProjects 与 hiddenSessions 分开报——「少了几条会话」和「整个项目看不见」是两回事。
    sessionsTruncated: alloc.truncated,
    hiddenSessions: alloc.hiddenSessions,
    hiddenProjects: alloc.hiddenProjects,
    pendingActions: [...driver.pendingActions(), ...codexDriver.pendingActions(), ...kimiDriver.pendingActions()],
  }
}

// ---------- 项目会话历史（冷路径·按需全量扫单个项目） ----------
// 看板列表被 MAX_PER_PROJECT=3 / slice(0,2) 故意截断（热路径，见文件头 45-47 行）。而「会话历史」
// Tab 要的是**历史**不是"当前纳管集"——它一直错接了 /api/state，于是 25 个会话的项目只列 2 条
// （2026-08-03 用户实拍）。这条冷路径只在用户打开该 Tab 时扫一个项目，热路径一个字节不动。
//
// ⚠️ 两半必须一起做：只加列表会得到「列 10 条、点开 8 条空白」的假修复。老会话此前**根本没被
// 登记进 idToFile**（登记语句在同一个被截断的循环里，agent.js:974/1043/1096），events 端点因此
// 定位不到文件、返回 null，前端落到 SessionNotFound 并在 1.2 秒后自动跳走。所以下面每挑中一条
// 就登记 idToFile/idToEngine/idToCwd。
async function projectSessionHistory(project, limit) {
  const now = Date.now()
  const today = dayOf(now)
  const host = os.hostname() // ⚠️ buildState 里的 `hostname` 是它的**局部**变量，不是模块级；
  // 照抄那边的 `serverId: host` 会 ReferenceError，且被下面的 per-file catch 吞掉 ⇒
  // 整个项目静默返回 0 条，长得和"这个项目真没有会话"一模一样（开发时实测踩到）。
  const cands = []
  let failed = 0 // 吞掉的异常要计数并上报，否则"全军覆没"和"本来就没有"无法区分

  // Claude：该项目 sessDir 下 60 天内的全部会话（不受 MAX_PER_PROJECT 限制）
  const proj = discoverProjects().find((p) => p.name === project)
  if (proj) {
    let files = []
    try {
      files = fs.readdirSync(proj.sessDir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => { const full = path.join(proj.sessDir, f); return { full, mtimeMs: fs.statSync(full).mtimeMs } })
        .filter((f) => now - f.mtimeMs < MAX_AGE_DAYS * 86_400_000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 40) // 成本护栏：单项目最多解析 40 个文件（对齐 buildState 的 i<40）
    } catch { files = [] }
    for (const f of files) {
      const id = path.basename(f.full, '.jsonl')
      try {
        const { summary, payload } = await cachedScan(f.full, false)
        cands.push({
          id, serverId: host, project, branch: summary.branch, engine: 'claude',
          model: summary.model || 'Claude',
          mode: summary.mode === 'auto' ? 'acceptEdits' : summary.mode,
          state: shadowState.get(id) ?? shadowStateOf(f.mtimeMs, false, now),
          summary: summary.title || summary.lastText || '（无摘要）',
          firstPrompt: summary.firstPrompt || '',
          startedAt: summary.startedAt || f.mtimeMs,
          lastActiveAt: f.mtimeMs,
          cost: estCost(summary.tok, summary.model),
          tokens: summary.tokens,
          activeMs: summary.activeMs,
          costToday: summary.dailyCost?.[today] || 0,
          origin: 'shadow', cwd: proj.cwd, lastEvent: summary.lastEvent,
          todoStats: todoStatsOf(payload.todos),
          msgCount: summary.msgCount,
          _file: f.full,
        })
      } catch (e) { failed++; if (failed <= 3) console.error('[history] claude', id, e?.message) }
    }
  }

  // Codex：按 cwd 归属到该项目（不受 slice(0,2) 限制）
  for (const f of listCodexFiles()) {
    if (now - f.mtimeMs > MAX_AGE_DAYS * 86_400_000) continue
    try {
      const { summary } = await cachedCodexScan(f.full, false)
      if (!summary.id || isCodexSubagent(summary.source) || !summary.cwd.startsWith(DATA_ROOT + '/')) continue
      if (summary.cwd.slice(DATA_ROOT.length + 1).split('/')[0] !== project) continue
      cands.push({
        id: summary.id, serverId: host, project, branch: '', engine: 'codex',
        model: summary.model || 'GPT', mode: 'default',
        state: shadowState.get(summary.id) ?? shadowStateOf(f.mtimeMs, false, now, summary.turn),
        summary: summary.lastText || summary.title || '（无摘要）',
        firstPrompt: summary.firstPrompt || '',
        startedAt: summary.startedAt || f.mtimeMs,
        lastActiveAt: f.mtimeMs,
        cost: 0, tokens: summary.tokens, activeMs: summary.activeMs,
        costToday: summary.dailyCost?.[today] || 0,
        origin: 'shadow', cwd: summary.cwd, lastEvent: summary.lastEvent,
        todoStats: todoStatsOf([]), msgCount: summary.msgCount,
        _file: f.full,
      })
    } catch (e) { failed++; if (failed <= 3) console.error('[history] codex', e?.message) }
  }

  // Kimi：~/.kimi-code（不受 slice(0,2) 限制）
  try {
    for (const k of scanKimiSessions()) {
      if (now - k.mtimeMs > MAX_AGE_DAYS * 86_400_000) continue
      if (!k.cwd.startsWith(DATA_ROOT + '/')) continue
      if (k.cwd.slice(DATA_ROOT.length + 1).split('/')[0] !== project) continue
      const { summary } = await cachedKimiScan(k.wirePath)
      cands.push({
        id: k.id, serverId: host, project, branch: '', engine: 'kimi',
        model: 'Kimi', mode: 'default',
        state: shadowState.get(k.id) ?? shadowStateOf(k.mtimeMs, false, now, summary.turn),
        summary: k.lastPrompt || k.title || '（无摘要）',
        firstPrompt: k.title || '',
        startedAt: k.mtimeMs, lastActiveAt: k.mtimeMs,
        cost: 0, tokens: 0, origin: 'shadow', cwd: k.cwd,
        todoStats: todoStatsOf([]), msgCount: 1,
        _file: k.wirePath,
      })
    }
  } catch (e) { failed++; console.error('[history] kimi', e?.message) }

  // ★ 抑制「已被平台会话/分离态条目代表」的影子，判据与 buildState 同源。
  // Claude 平台会话 API id 是 ps-*、原生 uuid 在 realSessionId，**两者 id 不同**⇒ 按 id 去重
  // 抓不住这对孪生。不抑制的话，正在跑的对话会在历史里出现两行，且 uuid 那行 events 恒为 0
  // ⇒ 点开空白（2026-08-03 实测；我的探针环境无平台会话，把这个 bug 藏住了）。
  const suppress = new Set([
    ...driver.realSessionIds(), ...codexDriver.realSessionIds(), ...kimiDriver.realSessionIds(),
  ])
  // 分离态（agent 重启后按 store 别名恢复的 detached 条目）同样已代表其 realSessionId
  for (const alias of Object.values(sessionStore.all())) {
    if (alias?.engine === 'claude' && alias.realSessionId) suppress.add(alias.realSessionId)
  }
  const picked = selectHistory(cands, limit, suppress)
  // ★ 登记文件映射——没有这步，列出来的老会话点开是空白（见函数头注释）
  for (const s of picked) {
    if (s._file) { idToFile.set(s.id, s._file); idToEngine.set(s.id, s.engine); idToCwd.set(s.id, s.cwd) }
    delete s._file // 内部字段不出网（内部对象 ≠ 线协议）
  }
  // scanned/failed 必须出网：0 条会话有两种截然不同的含义——"这个项目真没有会话" vs
  // "25 个文件全解析失败"。不报出来，前端两种都显示成空列表，排查时无从下手。
  return { sessions: picked, scanned: cands.length, failed }
}

// ---------- 全局搜索 ----------
async function searchSessions(q) {
  const needle = q.toLowerCase()
  const state = await buildState()
  const hits = []
  for (const s of state.sessions) {
    if (hits.length >= 30) break
    let title = s.summary ?? ''
    let snippet = ''
    let matched = title.toLowerCase().includes(needle) || s.project.toLowerCase().includes(needle)
    // 内容检索：用事件缓存（首查全量解析一次，之后按 mtime 缓存）
    const file = idToFile.get(s.id)
    if (file && fs.existsSync(file)) {
      try {
        const se = idToEngine.get(s.id)
        const payload = se === 'kimi'
          ? await cachedKimiScan(file)
          : (await (se === 'codex' ? cachedCodexScan : cachedScan)(file, true)).payload
        for (const e of payload.events) {
          const text = e.text ?? e.path ?? ''
          const idx = text.toLowerCase().indexOf(needle)
          if (idx >= 0) {
            matched = true
            snippet = text.slice(Math.max(0, idx - 60), idx + 90).replace(/\s+/g, ' ')
            break
          }
        }
      } catch { /* 单文件失败不影响整体 */ }
    } else {
      // 平台会话：搜 driver 内存事件
      const live = driver.getEvents(s.id)
      if (live) {
        for (const e of live.events) {
          const text = e.text ?? e.path ?? ''
          const idx = text.toLowerCase().indexOf(needle)
          if (idx >= 0) { matched = true; snippet = text.slice(Math.max(0, idx - 60), idx + 90).replace(/\s+/g, ' '); break }
        }
      }
    }
    if (matched) {
      hits.push({
        sessionId: s.id, serverId: s.serverId, project: s.project, engine: s.engine,
        title: title.slice(0, 100), snippet, lastActiveAt: s.lastActiveAt,
      })
    }
  }
  hits.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return hits
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 24_000_000) req.destroy() })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function listProjects() {
  return (fs.existsSync(DATA_ROOT)?fs.readdirSync(DATA_ROOT):[])
    .filter((name) => {
      if (excludedProject(name)) return false
      try { return fs.statSync(path.join(DATA_ROOT, name)).isDirectory() } catch { return false }
    })
    .sort()
    .map((name) => ({ name, cwd: path.join(DATA_ROOT, name) }))
}

// ---------- 每日 token 消耗聚合（曲线用） ----------
const dailyMemo = new Map() // days -> { ts, value }
async function usageDaily(days) {
  const hit = dailyMemo.get(days)
  if (hit && Date.now() - hit.ts < 30_000) return hit.value
  const now = Date.now()
  const cutoff = now - days * 86_400_000
  const cutoffDay = dayOf(cutoff)
  const day7 = dayOf(now - 7 * 86_400_000)   // 近 7 天起点（本周消耗）
  const h5 = hourOf(now - 5 * 3_600_000)      // 近 5 小时起点（滚动窗口，hourKey 字典序==时间序）
  const daily = {}
  const dailyCost = {}
  const dayTokComp = {}
  const dayCostComp = {}
  let last5h = 0, last7d = 0
  const merge4 = (dst, src) => { dst.input += src.input || 0; dst.output += src.output || 0; dst.cacheRead += src.cacheRead || 0; dst.cacheCreate += src.cacheCreate || 0 }
  // 同一遍扫描里聚合：每日 token 曲线 + 每日成本 + 每日 token/成本四分量 + 近5h + 近7d
  // 引擎维度（2026-08-02）：Codex/Kimi **贡献 token 但不贡献成本**（scanCodexFile 里
  // dailyCost/dayCostComp 恒空），所以「总 token ÷ 总成本」得出的单价会低得离谱——
  // 用户实测 12.4 亿 token 只算出 $183.82，隐含 $0.0003/M input，比任何真实档位都低两个数量级。
  // 出口带上 byEngine，让前端能把口径讲清楚，而不是把两个不同分母的数字并排摆着。
  const dayEngineTok = {}
  const add = (s, engine = 'claude') => {
    for (const [d, t] of Object.entries(s.daily || {})) {
      if (d >= cutoffDay) (dayEngineTok[d] ??= {})[engine] = ((dayEngineTok[d] ??= {})[engine] ?? 0) + t
    }
    for (const [d, t] of Object.entries(s.daily || {})) {
      if (d >= cutoffDay) daily[d] = (daily[d] ?? 0) + t
      if (d >= day7) last7d += t
    }
    for (const [d, c] of Object.entries(s.dailyCost || {})) if (d >= cutoffDay) dailyCost[d] = (dailyCost[d] ?? 0) + c
    for (const [d, c] of Object.entries(s.dayTokComp || {})) if (d >= cutoffDay) merge4(dayTokComp[d] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, c)
    for (const [d, c] of Object.entries(s.dayCostComp || {})) if (d >= cutoffDay) merge4(dayCostComp[d] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, c)
    for (const [h, t] of Object.entries(s.hourly || {})) if (h >= h5) last5h += t
  }
  // Claude：扫所有 /data 项目会话文件（不受 MAX_PER_PROJECT 限制，要全量才准）
  for (const proj of discoverProjects()) {
    let files = []
    try {
      files = fs.readdirSync(proj.sessDir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => { const full = path.join(proj.sessDir, f); return { full, mtimeMs: fs.statSync(full).mtimeMs } })
    } catch { continue }
    for (const f of files) {
      if (f.mtimeMs < cutoff) continue
      try { add((await cachedScan(f.full, false)).summary) } catch { /* 单文件失败忽略 */ }
    }
  }
  // Codex：/data 内的会话
  for (const f of listCodexFiles()) {
    if (f.mtimeMs < cutoff) continue
    try {
      const { summary } = await cachedCodexScan(f.full, false)
      if (summary.cwd.startsWith(DATA_ROOT + '/')) add(summary, 'codex')
    } catch { /* 忽略 */ }
  }
  // Kimi：wire.jsonl（usage.record 自带 time，parseWire 已分 daily/hourly 桶）。
  // 无单价 ⇒ 只贡献 token 不贡献成本（与 Codex 同口径，byEngine 里单独标注）。
  for (const k of scanKimiSessions()) {
    if (k.mtimeMs < cutoff) continue
    if (!k.cwd.startsWith(DATA_ROOT + '/')) continue
    try { add((await cachedKimiScan(k.wirePath)).summary, 'kimi') } catch { /* 忽略 */ }
  }
  const value = { daily, dailyCost, dayTokComp, dayCostComp, dayEngineTok, last5h, last7d }
  dailyMemo.set(days, { ts: now, value })
  return value
}

// ---------- 今日按时段(小时)消耗 ----------
let hourlyMemo = { ts: 0, value: null }
async function usageTodayHourly() {
  if (hourlyMemo.value && Date.now() - hourlyMemo.ts < 30_000) return hourlyMemo.value
  const today = dayOf(Date.now())
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
  const cut = startToday.getTime()
  const tokByH = {}, costByH = {}
  const add = (s) => {
    for (const [hk, t] of Object.entries(s.hourly || {})) if (hk.startsWith(today + 'T')) { const h = hk.slice(-2); tokByH[h] = (tokByH[h] ?? 0) + t }
    for (const [hk, c] of Object.entries(s.hourlyCost || {})) if (hk.startsWith(today + 'T')) { const h = hk.slice(-2); costByH[h] = (costByH[h] ?? 0) + c }
  }
  for (const proj of discoverProjects()) {
    let files = []
    try { files = fs.readdirSync(proj.sessDir).filter((f) => f.endsWith('.jsonl')).map((f) => { const full = path.join(proj.sessDir, f); return { full, mtimeMs: fs.statSync(full).mtimeMs } }) } catch { continue }
    for (const f of files) { if (f.mtimeMs < cut) continue; try { add((await cachedScan(f.full, false)).summary) } catch { /* 忽略 */ } }
  }
  for (const f of listCodexFiles()) {
    if (f.mtimeMs < cut) continue
    try { const { summary } = await cachedCodexScan(f.full, false); if (summary.cwd.startsWith(DATA_ROOT + '/')) add(summary) } catch { /* 忽略 */ }
  }
  for (const k of scanKimiSessions()) {
    if (k.mtimeMs < cut) continue
    if (!k.cwd.startsWith(DATA_ROOT + '/')) continue
    try { add((await cachedKimiScan(k.wirePath)).summary) } catch { /* 忽略 */ }
  }
  const hours = []
  for (let h = 0; h <= 23; h++) { const k = String(h).padStart(2, '0'); hours.push({ hour: k, tokens: tokByH[k] ?? 0, cost: Math.round((costByH[k] ?? 0) * 100) / 100 }) }
  hourlyMemo = { ts: Date.now(), value: { hours } }
  return hourlyMemo.value
}

// ---------- 每项目今日消耗聚合（全量扫描，不受 MAX_PER_PROJECT 封顶；hub rollup 落库用） ----------
// 30s memo（P7，2026-08-13）：本函数会遍历 discoverProjects() 下**全部** Claude 文件 +
// listCodexFiles() 全量，是最重的聚合之一，而它此前**唯独没有 memo**——
// 邻居 usageDaily(:1375) 与 usageTodayHourly(:1435) 都有 30s memo，只有它漏了。
// 「今日项目用量」是看板上的数字，30 秒的新鲜度绰绰有余。
let projectsTodayMemo = { ts: 0, value: null }
async function usageProjectsToday() {
  if (projectsTodayMemo.value && Date.now() - projectsTodayMemo.ts < 30_000) return projectsTodayMemo.value
  const today = dayOf(Date.now())
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
  const cut = startToday.getTime()
  const byProj = new Map() // project -> {activeMs, cost, tokens}
  const add = (project, s) => {
    const a = s.dailyActiveMs?.[today] || 0, c = s.dailyCost?.[today] || 0, t = s.daily?.[today] || 0
    if (!a && !c && !t) return
    const g = byProj.get(project) || { activeMs: 0, cost: 0, tokens: 0 }
    g.activeMs += a; g.cost += c; g.tokens += t
    byProj.set(project, g)
  }
  for (const proj of discoverProjects()) {
    let files = []
    try { files = fs.readdirSync(proj.sessDir).filter((f) => f.endsWith('.jsonl')).map((f) => { const full = path.join(proj.sessDir, f); return { full, mtimeMs: fs.statSync(full).mtimeMs } }) } catch { continue }
    for (const f of files) { if (f.mtimeMs < cut) continue; try { add(proj.name, (await cachedScan(f.full, false)).summary) } catch { /* 忽略 */ } }
  }
  for (const f of listCodexFiles()) {
    if (f.mtimeMs < cut) continue
    try {
      const { summary } = await cachedCodexScan(f.full, false)
      if (!summary.cwd?.startsWith(DATA_ROOT + '/')) continue
      const projName = summary.cwd.slice(DATA_ROOT.length + 1).split('/')[0]
      if (excludedProject(projName)) continue
      add(projName, summary)
    } catch { /* 忽略 */ }
  }
  for (const k of scanKimiSessions()) {
    if (k.mtimeMs < cut) continue
    if (!k.cwd.startsWith(DATA_ROOT + '/')) continue
    if (excludedProject(k.project)) continue
    try { add(k.project, (await cachedKimiScan(k.wirePath)).summary) } catch { /* 忽略 */ }
  }
  const value = [...byProj.entries()].map(([project, g]) => ({ project, ...g }))
  projectsTodayMemo = { ts: Date.now(), value }
  return value
}

// ---------- Codex 订阅额度（账号级，与 Claude /usage 对齐） ----------
// Codex 没有 `codex --print /usage` 之类的非交互命令，配额信息散落在 rollout JSONL 的
// `event_msg` 事件里（payload.rate_limits：primary=5h 窗口、secondary=周窗口、plan_type）。
// 取全局最新 rollout 的最后一条 rate_limits 快照即可。流式读取，避免把大文件读进内存。
let codexLimitsMemo = { ts: 0, value: null }
// 本机 Codex 账号身份（额度账号级，本机一份 auth.json = 本账号）：account_id 来自 auth.json，
// email/name 来自 id_token(JWT) 第二段 payload；plan 优先用快照的 plan_type，auth 里的作兜底。
let codexAccountMemo = { ts: 0, value: null }
function jwtPayload(tok) {
  try {
    let seg = String(tok).split('.')[1] || ''
    seg = seg.replace(/-/g, '+').replace(/_/g, '/')
    while (seg.length % 4) seg += '='
    return JSON.parse(Buffer.from(seg, 'base64').toString('utf8'))
  } catch { return null }
}
function codexAccount() {
  if (Date.now() - codexAccountMemo.ts < 300_000) return codexAccountMemo.value
  let value = { accountId: null, email: null, plan: null }
  try {
    const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))
    const pl = jwtPayload(a?.tokens?.id_token) || {}
    const auth = pl['https://api.openai.com/auth'] || {}
    value = {
      accountId: a?.tokens?.account_id ?? auth.chatgpt_account_id ?? null,
      email: pl.email ?? null,
      plan: auth.chatgpt_plan_type ?? null,
    }
  } catch { /* 无 auth.json / 解析失败：留空，不影响额度主体 */ }
  codexAccountMemo = { ts: Date.now(), value }
  return value
}
function lastRateLimitLine(file) {
  return new Promise((resolve) => {
    let last = null, rl
    try { rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity }) }
    catch { return resolve(null) }
    rl.on('line', (ln) => { if (ln.indexOf('"rate_limits"') >= 0) last = ln })
    rl.on('close', () => resolve(last))
    rl.on('error', () => resolve(null))
  })
}
async function codexLimits() {
  // 判据搬到 usage-throttle.js：窗口从 60s 提到 CODEX_MEMO_MS(5min)。旧值与前端轮询间隔
  // **相等**，两次请求间隔恰好 ≥60s ⇒ 恒判"该探测" ⇒ memo 每次击穿、节流形同虚设。
  // 顺带修掉时钟回拨会把刷新永久卡死的隐患（见该模块注释）。
  if (!shouldReprobe({ lastTs: codexLimitsMemo.ts, now: Date.now(), windowMs: CODEX_MEMO_MS })) return codexLimitsMemo.value
  let value = null

  // 首选：codex app-server `account/rateLimits/read` 实时查询（与客户端 /status 同源、零额度、
  // 不发回合）。拿到即用，at=now → 无滞后；拿不到（codex 未装/未登录）再回退扫 rollout 旧快照。
  const live = await codexDriver.liveRateLimits().catch(() => null)
  if (live && (live.primary || live.secondary)) {
    const acc = codexAccount()
    const w = (x) => x ? { pct: Math.round((x.usedPercent ?? 0) * 10) / 10, windowMin: x.windowDurationMins ?? null, resetsAt: x.resetsAt ?? null } : null
    value = { accountId: acc.accountId, email: acc.email, primary: w(live.primary), secondary: w(live.secondary), plan: live.planType ?? acc.plan ?? null, at: Date.now(), live: true }
    codexLimitsMemo = { ts: Date.now(), value }
    return value
  }

  const files = listCodexFiles().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8) // 回退：最近 8 个 rollout 取最新快照
  for (const f of files) {
    const ln = await lastRateLimitLine(f.full)
    if (!ln) continue
    let o; try { o = JSON.parse(ln) } catch { continue }
    const rl = o?.payload?.rate_limits
    if (!rl || (!rl.primary && !rl.secondary)) continue
    const w = (x) => x ? { pct: Math.round((x.used_percent ?? 0) * 10) / 10, windowMin: x.window_minutes ?? null, resetsAt: x.resets_at ?? null } : null
    const acc = codexAccount()
    value = { accountId: acc.accountId, email: acc.email, primary: w(rl.primary), secondary: w(rl.secondary), plan: rl.plan_type ?? acc.plan ?? null, at: Date.parse(o.timestamp) || f.mtimeMs }
    break // 文件按 mtime 降序，第一个含快照的即最新
  }
  codexLimitsMemo = { ts: Date.now(), value }
  return value
}

// ---------- HTTP ----------
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 给 eventsPayload 的返回对象附加 firstSeq/lastSeq（若上游已提供——如 codex-driver.getEvents
 *  ——则直接沿用，不重复计算）。纯附加字段，不改变既有 events/fileChanges/todos 形状。 */
function withSeqBounds(payload) {
  if (!payload) return payload
  if ('firstSeq' in payload || 'lastSeq' in payload) return payload
  return { ...payload, ...seqBounds(payload.events) }
}

/** 断线续传帧协议（4.2b，纯附加）：把 withSeqBounds 处理过的 payload 包一层 snapshot/append/reset。
 *  - since=null（无游标，覆盖今天所有既有调用方，含 /stream）→ 恒 kind:'snapshot'，events/顺序与改造前
 *    完全一致（向后兼容硬约束）。
 *  - since!=null 且可比较 → 'append'，只带比 since 新的耐久（有 seq）事件。
 *  - since 不可比较（引擎/文件世代不匹配）→ 'reset'，仍随全量窗口（客户端据此清空本地缓冲重建）。
 *  流式（未定稿，e.seq==null）事件永远随行——append/reset 帧里也带上，由客户端按 id upsert 去重合并，
 *  不受 seq 游标影响（这类事件本就没有 seq）。 */
function frameify(payload, id, since) {
  if (!payload) return payload
  const engine = idToEngine.get(id)
  const numericSeq = engine === 'codex' || engine === 'kimi'
  if (numericSeq && needsHistorySnapshot(payload.events)) {
    return { ...payload, kind: 'snapshot', firstSeq: null, lastSeq: null }
  }
  const cmp = numericSeq ? numCmp : claudeCmp
  const sinceVal = since == null ? null : (numericSeq ? Number(since) : String(since))
  const durable = payload.events.filter((e) => e.seq != null)
  const streaming = payload.events.filter((e) => e.seq == null)
  const frame = numericSeq && sinceVal != null && payload.lastSeq != null && sinceVal > payload.lastSeq
    ? { kind: 'reset' } // driver 重建后旧游标不能把新输出全部过滤掉
    : buildFrame({ events: durable, since: sinceVal, firstSeq: payload.firstSeq, lastSeq: payload.lastSeq, cmp })
  const events = frame.kind === 'append' ? [...frame.events, ...streaming] : payload.events
  return {
    ...payload,
    kind: frame.kind,
    events,
    ...(frame.droppedBefore != null ? { droppedBefore: frame.droppedBefore } : {}),
    ...(frame.fromSeq !== undefined ? { fromSeq: frame.fromSeq } : {}),
  }
}

/** 构建某会话的事件 payload（events/fileChanges/todos）。null=会话不存在。
 *  /events（轮询，支持 ?since 续传游标）与 /stream（SSE，恒 since=null 全量）共用同一来源，保证一致。 */
/** Kimi wire.jsonl → 事件载荷。按 mtime 缓存（同 cachedScan 策略）；解析在 kimi-shadow.js，有单测。 */
const kimiEventsCache = createBoundedCache(CACHE_MAX_EVENTS) // file -> { mtimeMs, payload }
// Kimi 增量续扫（2026-08-13）。原实现与 Codex 改造前同一个毛病：缓存键只比 mtime、
// `readFileSync` 整份读进**一个字符串**（比流式更糟，是内存尖峰）、无任何续扫能力。
// 实测语料：.232 有 **1,644 个** Kimi 文件 / 48.8 MB / 最大 2.8 MB
// ⇒ 2.8MB 文件追加 4KB 要重读 2.8MB，读放大 ≈700×。
//
// ⚠️ 我在 proposal 的 Non-goals 里曾写「Kimi 只读 index、不是压力源」——
//    **那句话只对 summary 路径成立**，events 路径一直在整份重读。已订正。
async function cachedKimiScan(file) {
  let st
  try { st = fs.statSync(file) } catch { return { events: [], todos: [], fileChanges: [], summary: kimiUsageSummary(null) } }
  const hit = kimiEventsCache.get(file)
  // 补上 size：正在写的文件每追加一行 mtime 就变，只比 mtime 等于每次都判脏。
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ...hit.payload, summary: kimiUsageSummary(hit.state) }

  // 判据走共用实现，与 Claude/Codex 同一份。
  const resume = canResume(hit?.ck, st) ? hit.state : null
  const start = resume ? hit.ck.offset : 0
  const safeEnd = lastCompleteLineEnd(file, st.size)  // 半行本轮不碰
  let txt = ''
  if (safeEnd > start) {
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.allocUnsafe(safeEnd - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        txt = buf.toString('utf8')
      } finally { fs.closeSync(fd) }
    } catch { /* 读失败退空 */ }
  }
  const t0 = Date.now()
  const r = parseKimiWire(txt, resume)
  ingestMetrics.recordScan({
    ...scanBytes({ fileSize: st.size, knownSize: hit?.size, bytesRead: Math.max(0, safeEnd - start) }),
    incremental: !!resume, seconds: (Date.now() - t0) / 1000,
  })
  // 事件封顶：续扫会不断往同一数组追加，不封顶就是无界增长（与 Claude/Codex 同口径）。
  if (r.events.length > EVENTS_RETAIN) r.events.splice(0, r.events.length - EVENTS_RETAIN)
  const payload = { events: r.events.slice(-EVENTS_RETAIN), todos: [], fileChanges: [] }
  kimiEventsCache.set(file, {
    mtimeMs: st.mtimeMs, size: st.size, payload, state: r.state,
    ck: { generation: String(st.ino), fileSize: st.size, offset: safeEnd },
  })
  return { ...payload, summary: kimiUsageSummary(r.state) }
}

/** parseWire state → usageDaily/hourly 聚合所需的桶（Kimi 无单价，故无 dailyCost/dayCostComp）。 */
function kimiUsageSummary(st) {
  return {
    turn: st?.turn ?? null,
    tok: st?.tok ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    daily: st?.daily ?? {}, dayTokComp: st?.dayTokComp ?? {}, hourly: st?.hourly ?? {},
    dailyActiveMs: st?.dailyActiveMs ?? {},
  }
}

async function eventsPayload(id, since = null) {
  // Claude 接管型会话：历史以 JSONL 为准（CLI 实时续写，避免双源重复），
  // 但叠加 driver 内存里"正在流式"的事件——当前回合 JSONL 尚未落盘，借此实现逐字实时（#8）。
  const target = driver.resumeTarget(id)
  if (target) {
    let file = idToFile.get(target)
    if (!file && mapRefreshGate.allow(target)) { await buildState(); file = idToFile.get(target) }
    if (file && fs.existsSync(file)) {
      const payload = (await cachedScan(file, true)).payload
      const live = (driver.getEvents(id)?.events ?? []).filter((e) => e.streaming)
      return frameify(withSeqBounds(live.length ? { ...payload, events: [...payload.events, ...live] } : payload), id, since)
    }
  }
  const drv = driverFor(id)
  const live = drv?.getEvents(id)
  // 只有 driver 里「确有事件」才用它（活跃/流式会话）。Codex 影子会话被接管后 driver 内存事件为空
  // （不像 Claude 会回放 JSONL）——若用空事件短路就会「接管后对话流空白」。此时回退到下面的 JSONL 历史。
  if (live && live.events && live.events.length) {
    // ⚠️ 不能直接短路（2026-08-02 用户报「对话明显缺失，执行历史却是全的」）：
    // Codex/Kimi 的 driver 内存**只有接管之后**产生的事件。实测 invest_data 那个会话，
    // JSONL 里应产出 ~697 个事件（对外 slice(-150)），而接口只回 29 条——正是接管后的那截，
    // 接管前的整段对话在界面上凭空消失。Claude 侧本来就是「JSONL 历史 + driver 流式」叠加
    // （见上方 resumeTarget 分支），这里与之对齐。
    // app-server 现在也实时回写 JSONL；两源 ID 不同，必须划分历史与实时段，不能直接拼接。
    const hf = idToFile.get(id)
    if (hf && fs.existsSync(hf)) {
      try {
        const he = idToEngine.get(id)
        if (he === 'kimi') {
          // Kimi 的 wire.jsonl 是**实时落盘**的（与 Claude 的 JSONL 同地位），
          // 接管/重启后 driver 回放的历史 wire 里早已有。
          // 故以 wire 为权威、driver 只补流式尾巴与严格更新的事件（mergeKimiEvents 内有指纹去重），
          // 直接 [...hist, ...live] 会整段重复（两源 id 命名空间不同，按 id 去重恒为 0，2026-09-27 用户实拍）。
          const hist = await cachedKimiScan(hf)
          const merged = mergeKimiEvents(hist.events, live.events)
          return frameify(withSeqBounds({ ...live, events: merged.slice(-EVENTS_RETAIN) }), id, since)
        }
        // Codex：JSONL 仅补 driver 留存段之前的历史，实时段由 driver 提供。
        const hist = (await cachedCodexScan(hf, true)).payload
        return frameify(mergeCodexEvents(hist.events, live), id, since)
      } catch { /* 历史读不到就退回只给内存，绝不因此让对话流整个挂掉 */ }
    }
    return frameify(withSeqBounds(live), id, since)
  }
  let file = idToFile.get(id)
  if (!file && mapRefreshGate.allow(id)) { await buildState(); file = idToFile.get(id) }
  if (!file || !fs.existsSync(file)) return null
  const eng = idToEngine.get(id)
  if (eng === 'kimi') {
    const { summary: _drop, ...kPayload } = await cachedKimiScan(file) // summary 仅供用量聚合，不进事件出口
    return frameify(withSeqBounds(kPayload), id, since)
  }
  const scan = eng === 'codex' ? cachedCodexScan : cachedScan
  return frameify(withSeqBounds((await scan(file, true)).payload), id, since)
}

/** 深挖事件（仅供历史回填 `?limit=N`）：直接取解析缓存留存的全量事件（上限 EVENTS_RETAIN），
 *  绕过对外的 150 条窗口。Mongo 里的存量事件要补 payload.summary，只够到 150 条就补不全早期回合。
 *  只对 Claude 有效（Codex 无续扫留存态）；拿不到就返回 null，调用方退回 150 条窗口。 */
async function deepEvents(id, limit) {
  if (idToEngine.get(id) === 'codex' || idToEngine.get(id) === 'kimi') return null
  const target = driver.resumeTarget(id) || id
  let file = idToFile.get(target)
  if (!file && mapRefreshGate.allow(target)) { await buildState(); file = idToFile.get(target) }
  if (!file || !fs.existsSync(file)) return null
  await cachedScan(file, true)                     // 确保缓存/留存态是最新的
  const kept = eventsCache.get(file)?.state?.events
  return Array.isArray(kept) ? kept.slice(-limit) : null
}

/** 会话 id → 工作目录：先查平台会话记录（含 fresh 起的会话），再查影子映射（必要时刷新一次）。 */
async function cwdForSession(id) {
  for (const s of [...driver.listSessions(), ...codexDriver.listSessions(), ...kimiDriver.listSessions()]) {
    if (s.id === id && s.cwd) return s.cwd
  }
  let c = idToCwd.get(id)
  if (!c && mapRefreshGate.allow(`cwd:${id}`)) { await buildState(); c = idToCwd.get(id) }
  return c || null
}

/** 归档负载：把某会话渲染成可直接进 KB 的 markdown（精炼 + 原文提问 + 内联截图）。 */
async function buildArchivePayload(id) {
  const ev = await eventsPayload(id)
  if (!ev) return null
  const state = await buildState()
  const s = state.sessions.find((x) => x.id === id) || {}
  const project = s.project || 'unknown'
  const serverId = s.serverId || hostname
  // 空会话(无真实提问)不归档:无价值还白烧 haiku。归档器据此跳过并记签名不再重试。
  const userTurns = (ev.events || []).filter((e) => e.type === 'user' && (e.text || '').trim() && !(e.text || '').trim().startsWith('<'))
  if (userTurns.length === 0) return { empty: true, project, serverId }
  const summary = (s.summary || '').replace(/\s+/g, ' ').trim().slice(0, 60) || `会话 ${String(id).slice(0, 8)}`
  const date = new Date().toISOString().slice(0, 10)
  const title = `[${date}] ${summary}`
  const engineName = s.engine === 'codex' ? 'Codex' : s.engine === 'kimi' ? 'Kimi' : 'Claude'
  const refined = await digest.archiveSummary(ev.events || [])
  const imgByName = new Map(driver.readSessionImages(id).map((x) => [x.name, x]))

  const md = []
  md.push(`# ${title}`, '')
  md.push(`> 项目 ${project} · 服务器 ${serverId} · 引擎 ${engineName} ${s.model || ''}`)
  md.push(`> 会话ID ${id} · 状态 ${s.state || ''} · 归档于 ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`, '')
  md.push(refined || '## 问题信息\n（精炼暂不可用）\n\n## 主要进展\n（精炼暂不可用）', '')

  // 对话记录（IM 聊天式：我问什么 → 助手答什么；用户提问原文保留 + 截图内联，助手回复超长则截断）
  md.push('## 对话记录', '')
  const ASST_MAX = 1200
  const turns = [] // 把事件配成回合，保留截图引用
  let cur = null
  for (const e of ev.events || []) {
    if (e.type === 'user') {
      const t = (e.text || '').trim()
      if (!t || t.startsWith('<')) continue
      if (cur) turns.push(cur)
      cur = { user: e.text, images: e.images || [], imageCount: e.imageCount || 0, asst: '', ops: 0 }
    } else if (!cur) {
      continue
    } else if (e.type === 'assistant' && e.text) {
      cur.asst += (cur.asst ? '\n\n' : '') + e.text
    } else if (e.type === 'file_op') {
      cur.ops++
    }
  }
  if (cur) turns.push(cur)

  if (turns.length === 0) {
    md.push('（无对话内容）', '')
  } else {
    turns.forEach((t, i) => {
      md.push(`**🧑 我**：${t.user}`)
      for (const ref of t.images) {
        // JSONL 会话：图片 base64 已内联在事件上（imagesOf 抽的）；平台会话：按 name 查落盘的截图
        if (ref.base64) md.push('', `![${ref.name}](data:${ref.media_type};base64,${ref.base64})`)
        else { const f = imgByName.get(ref.name); if (f) md.push('', `![${ref.name}](data:${f.media_type};base64,${f.base64})`) }
      }
      if (t.imageCount && !t.images.length) md.push(`（含 ${t.imageCount} 张截图，未持久化）`)
      let reply = (t.asst || '').trim()
      if (reply.length > ASST_MAX) reply = reply.slice(0, ASST_MAX) + ` …（回复较长，已截断 ${reply.length - ASST_MAX} 字）`
      if (!reply && t.ops) reply = `（执行了 ${t.ops} 步操作）`
      md.push('', `**🤖 助手**：${reply || '（无文本回复）'}`)
      if (i < turns.length - 1) md.push('', '---')
      md.push('')
    })
  }
  return { project, serverId, title, markdown: md.join('\n'), at: Date.now() }
}

// ---------- Webshell：一次性命令执行（root，超时+输出上限+审计） ----------
const EXEC_AUDIT = path.join(os.homedir(), '.web-agents', 'exec-audit.log')
const EXEC_CAP = 1_000_000      // stdout+stderr 合计上限
const EXEC_TIMEOUT = 60_000
let activeExecCount = 0
function runExec({ cmd, cwd }) {
  return new Promise((resolve) => {
    const dir = cwd || os.homedir()
    if (!cmd || !cmd.trim()) return resolve({ error: '命令为空', status: 400 })
    if (!fs.existsSync(dir)) return resolve({ error: `目录不存在: ${dir}`, status: 400 })
    const t0 = Date.now()
    let out = '', err = '', total = 0, truncated = false, timedOut = false, done = false
    let child
    try { child = spawn('bash', ['-lc', cmd], { cwd: dir, detached: true }) }
    catch (e) { return resolve({ error: String(e?.message || e), status: 500 }) }
    activeExecCount++
    const append = (buf, isErr) => {
      if (total >= EXEC_CAP) { truncated = true; return }
      const s = buf.toString()
      const room = EXEC_CAP - total
      const piece = s.length > room ? (truncated = true, s.slice(0, room)) : s
      total += piece.length
      if (isErr) err += piece; else out += piece
    }
    const finish = (code) => {
      if (done) return; done = true
      activeExecCount = Math.max(0, activeExecCount - 1)
      clearTimeout(timer)
      try {
        fs.mkdirSync(path.dirname(EXEC_AUDIT), { recursive: true })
        fs.appendFileSync(EXEC_AUDIT, `${new Date().toISOString()} ${dir} | exit=${code} dur=${Date.now() - t0}ms${timedOut ? ' TIMEOUT' : ''} | ${cmd}\n`)
      } catch { /* 审计失败不阻断 */ }
      resolve({ stdout: out, stderr: err, code, durationMs: Date.now() - t0, truncated, timedOut })
    }
    child.stdout.on('data', (b) => append(b, false))
    child.stderr.on('data', (b) => append(b, true))
    child.on('error', (e) => { err += String(e?.message || e); finish(-1) })
    child.on('close', (code) => finish(code ?? 0))
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ } }, EXEC_TIMEOUT)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if(!nodeAuthorized(req))return json(res,401,{error:'节点接入令牌无效或缺失'})
    const url = new URL(req.url, 'http://localhost')
    if(url.pathname==='/api/agent/info')return json(res,200,await agentInfo())

    // drain/SIGTERM 后拒绝会启动新工作的写操作；推进当前回合的审批/plan、显式中断、释放仍放行，确保已有回合能收尾。
    // 但 action 要按 kind 细分：Claude question 的 resolve 会 sendMessage() 起新回合、Codex review 会触发出队，
    // 这两类在排空期必须拒绝（CR-006 P1-c），否则违背「只收尾、不接新工作」。approval/plan 只推进当前回合，放行。
    const actionMatch = /^\/api\/action\/([\w-]+)$/.exec(url.pathname)
    const actionStartsNewTurn = actionMatch
      ? ['question', 'review'].includes(
          driver.actionKind(actionMatch[1])
          || codexDriver.actionKind(actionMatch[1])
          || kimiDriver.actionKind(actionMatch[1])
          || '',
        )
      : false
    const completionPost = (actionMatch && !actionStartsNewTurn)
      || /^\/api\/session\/[\w-]+\/(interrupt|release)$/.test(url.pathname)
    if (req.method === 'POST' && url.pathname !== '/api/maintenance/drain'
      && (maintenanceLease.isActive() || shuttingDown) && !completionPost) {
      return json(res, 503, { error: 'agent 正在进入维护重启，暂不接受新操作，请稍后重试' })
    }
    // 请求在 drain 之前已进入、但正停在 await（例如 Codex thread/start、takeover 的 buildState）时，
    // session list 可能尚无记录。跨整个响应生命周期计数，drain 必须把这种在途 mutation 也视为活跃。
    if (req.method === 'POST' && url.pathname !== '/api/maintenance/drain') {
      const releaseMutation = mutationActivity.begin()
      res.once('finish', releaseMutation)
      res.once('close', releaseMutation)
    }

    // 采集指标：把"是否还在全量重读"变成能被告警盯住的数，而不是靠人每半年 strace 一次。
    if (url.pathname === '/api/metrics/ingest') {
      return json(res, 200, ingestMetrics.snapshot())
    }
    if (url.pathname === '/api/state') {
      applyHiddenParam(url)
      // 出口裁剪：内部对象 ≠ 线协议。前端每 3 秒轮询这个端点，跨境一次 6~16 秒，
      // 而 firstPrompt/lastEvent/todoStats 占 sessions 的 30.8% 且前端引用为 0。
      // stateToWire 是纯函数（不动入参——firstPrompt 内部还要做归属判断），有单测。
      return json(res, 200, stateToWire(await buildState()))
    }
    if (url.pathname === '/api/projects') {
      applyHiddenParam(url)
      return json(res, 200, { projects: listProjects() })
    }
    // ── 归档采集：暴露给中心的**只读**接口（openspec execution-history-archive，P0）──
    // 方向是**中心拉**：hub 已经靠既有反向隧道每 5s 轮询本机 /api/state，拉取不需要新链路，
    // 且 checkpoint 集中在中心 ⇒「确认后才推进水位」天然成立（见 archive-pull.js 的订正说明）。
    if (url.pathname === '/api/archive/inventory') {
      return json(res, 200, { host: os.hostname(), files: archiveCorpus(), asOf: Date.now() })
    }
    if (url.pathname === '/api/archive/read') {
      // ⚠️ path 来自网络请求 ⇒ readRange 内部强制校验「必须在语料根之下」。
      //   没有那道闸，一个 path=/root/.ssh/id_rsa 就能把私钥读走。
      try {
        const text = archiveRead(
          url.searchParams.get('path') ?? '',
          Number(url.searchParams.get('from')) || 0,
          Math.min(Number(url.searchParams.get('len')) || 65536, 8 * 1024 * 1024),
        )
        return json(res, 200, { text })
      } catch (e) {
        return json(res, 400, { error: String(e?.message ?? e) })
      }
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').trim()
      if (q.length < 2) return json(res, 200, { hits: [] })
      return json(res, 200, { hits: await searchSessions(q) })
    }
    // 「会话历史」Tab 专用冷路径：按需全量扫单个项目，不受看板的 MAX_PER_PROJECT 截断影响
    if (url.pathname === '/api/project/sessions') {
      const project = (url.searchParams.get('project') ?? '').trim()
      if (!project) return json(res, 400, { error: 'project 必填' })
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 8)) // 默认 8：与前端 PROJECT_HISTORY_LIMIT 一致
      return json(res, 200, await projectSessionHistory(project, limit))
    }
    // 终端会话管理：列出本机可复用的 web 终端 tmux 会话（wt-*）
    if (url.pathname === '/api/term/list') {
      return json(res, 200, { sessions: await terminal.listTermSessions() })
    }
    if (url.pathname === '/api/usage/daily') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14))
      const u = await usageDaily(days) // { daily, dailyCost, dayTokComp, dayCostComp, last5h, last7d }
      return json(res, 200, u)
    }
    if (url.pathname === '/api/usage/today-hourly') {
      return json(res, 200, await usageTodayHourly()) // { hours: [{hour,tokens,cost}] }
    }
    if (url.pathname === '/api/usage/projects-today') {
      return json(res, 200, { rows: await usageProjectsToday() })
    }
    if (url.pathname === '/api/usage/codex-limits') {
      return json(res, 200, (await codexLimits()) || {}) // { primary, secondary, plan, at } | {}
    }
    if (url.pathname === '/api/usage/codex-models') {
      // 可切的 Codex 模型（含各自推理档），供前端下拉。app-server model/list，缓存 5min。
      return json(res, 200, { models: await codexDriver.listLlmModels().catch(() => []) })
    }

    const mEvents = /^\/api\/session\/([\w-]+)\/events$/.exec(url.pathname)
    if (mEvents) {
      const since = url.searchParams.get('since') || null // 断线续传游标（4.2b）；无则同旧行为，全量 kind:'snapshot'
      const payload = await eventsPayload(mEvents[1], since)
      if (!payload) return json(res, 404, { error: 'session not found' })
      // ?limit=N（仅供历史回填用）：默认仍是 150 条窗口（UI 对话流的用量，不动）；
      // 回填脚本要给存量文档补 payload.summary，只够到 150 条就补不全早期回合，故允许要到留存上限（400）。
      const limit = Math.min(Number(url.searchParams.get('limit')) || 0, EVENTS_RETAIN)
      if (limit > 150) {
        const deep = await deepEvents(mEvents[1], limit)
        if (deep) return json(res, 200, toWire({ ...payload, events: deep }, mEvents[1]))
      }
      // toWire：剥掉内联的 base64 截图，换成 /image/:eventId/:idx 懒加载 URL（见 event-wire.js）。
      // 这些 base64 曾占 payload 的 96%（实测 1.35MB / 1.41MB），而前端**从不使用**——收到就扔。
      // 手机上首屏因此要 8~10 秒。⚠️ 只在 HTTP 出口剥；内部调用方（归档/digest）仍要 base64。
      return json(res, 200, toWire(payload, mEvents[1]))
    }

    // 单张截图的原始字节（懒加载）。base64 只活在 JSONL/解析缓存里，这里按 (eventId, idx) 取出解码回传。
    // 历史事件不可变 ⇒ 一年 immutable：同一张图浏览器只拉一次，滚动回看不再产生流量。
    const mImage = /^\/api\/session\/([\w-]+)\/image\/([^/]+)\/(\d+)$/.exec(url.pathname)
    if (mImage) {
      const [, sid, evId, idx] = mImage
      const ev = await eventsPayload(sid) // 内部对象：base64 仍在
      if (!ev) return json(res, 404, { error: 'session not found' })
      // 老图可能已滑出对外的 150 条窗口，先从留存态（EVENTS_RETAIN=400）里找，找不到再退回窗口内
      const deep = await deepEvents(sid, EVENTS_RETAIN)
      const want = decodeURIComponent(evId)
      let hit = findImage(deep, want, idx) || findImage(ev.events, want, idx)
      if (!hit) {
        // Codex/Kimi 的事件在 driver 内存里，不含内联 base64（Claude 的在 JSONL 里含）⇒ 上面必然落空。
        // 回退到落盘附件：事件的 images[idx].name 就是 saveSessionImages 写下的文件名。
        const evt = [...(deep ?? []), ...(ev.events ?? [])].find((e) => String(e.id) === want)
        const meta = evt?.images?.[Number(idx)]
        if (meta?.name) hit = driver.readSessionImageFile(sid, meta.name)
      }
      if (!hit) return json(res, 404, { error: 'image not found' })
      res.writeHead(200, {
        'Content-Type': hit.mediaType,
        'Content-Length': hit.buf.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      return res.end(hit.buf)
    }

    // 会话已持久化的 Web 上传图片（引擎无关，按会话 id 落盘）
    const mImages = /^\/api\/session\/([\w-]+)\/images$/.exec(url.pathname)
    if (mImages) {
      return json(res, 200, { images: driver.readSessionImages(mImages[1]) })
    }

    // 代码视图（功能3·demo）：实时项目树 + git 状态
    const mTree = /^\/api\/session\/([\w-]+)\/tree$/.exec(url.pathname)
    if (mTree) {
      const cwd = await cwdForSession(mTree[1])
      if (!cwd) return json(res, 404, { error: 'cwd not found' })
      const [tree, status] = await Promise.all([codetree.buildTree(cwd), codetree.gitStatus(cwd)])
      return tree ? json(res, 200, { ...tree, status, cwd }) : json(res, 404, { error: 'cwd unavailable' })
    }
    // Project image bytes, loaded only after opening a file preview.
    const mFileImage = /^\/api\/session\/([\w-]+)\/file-image$/.exec(url.pathname)
    if (mFileImage && (req.method === 'GET' || req.method === 'HEAD')) {
      const cwd = await cwdForSession(mFileImage[1])
      if (!cwd) return json(res, 404, { error: 'cwd not found' })
      const image = openProjectImage(cwd, url.searchParams.get('path') || '')
      if (!image) return json(res, 404, { error: 'image not found' })
      if (image.error) return json(res, 413, { error: image.error })
      res.writeHead(200, {
        'Content-Type': image.mediaType, 'Content-Length': image.size,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      })
      if (req.method === 'HEAD') { image.stream.destroy(); return res.end() }
      await pipeline(image.stream, res).catch(() => { res.destroy() })
      return
    }
    // 代码视图：单文件预览
    const mFile = /^\/api\/session\/([\w-]+)\/file$/.exec(url.pathname)
    if (mFile) {
      const cwd = await cwdForSession(mFile[1])
      if (!cwd) return json(res, 404, { error: 'cwd not found' })
      if (req.method === 'POST') {
        const body = await readBody(req) // 此路由在 POST 解析块之前，需自取 body
        const r = codetree.writeFileSafe(cwd, body.path || '', body.content ?? '', { baseMtimeMs: body.baseMtimeMs })
        return json(res, r.ok ? 200 : (r.error === 'conflict' ? 409 : 400), r)
      }
      const f = codetree.readFileSafe(cwd, url.searchParams.get('path') || '')
      return f ? json(res, 200, f) : json(res, 404, { error: 'file not found' })
    }
    // 会话回溯（功能2·demo）：纯读取已精炼时间线（不触发 LLM）
    const mDigest = /^\/api\/session\/([\w-]+)\/digest$/.exec(url.pathname)
    if (mDigest) {
      const ev = await eventsPayload(mDigest[1])
      if (!ev) return json(res, 404, { error: 'session not found' })
      return json(res, 200, { turns: digest.digestFromCache(ev.events || []) })
    }

    // 归档负载（会话→KB）：本机产出 markdown（含 haiku 精炼 + 内联截图），hub 负责写 KB
    const mArch = /^\/api\/session\/([\w-]+)\/archive-payload$/.exec(url.pathname)
    if (mArch) {
      const p = await buildArchivePayload(mArch[1])
      return p ? json(res, 200, p) : json(res, 404, { error: 'session not found' })
    }

    // SSE 实时事件流（4.2c）：Last-Event-ID 续传游标 + 增量 append 帧，服务端本地 300ms tick。
    // 首帧按客户端携带的游标走 snapshot/append/reset（同 /events，见 eventsPayload/frameify）；
    // 之后每次 tick 都以“上次已下发的 lastSeq”为游标继续取增量，而非重复整窗全量对比。
    const mStream = /^\/api\/session\/([\w-]+)\/stream$/.exec(url.pathname)
    if (mStream) {
      const id = mStream[1]
      const cursor = req.headers['last-event-id'] || null // 浏览器重连自动回带 → 从该 seq 续传
      const first = await eventsPayload(id, cursor)
      if (!first) return json(res, 404, { error: 'session not found' })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 禁止反代缓冲（nginx）
      })
      let lastSentSeq = first.lastSeq ?? cursor
      let lastSig = ''
      const send = (raw) => {
        if (!raw) return
        // 先 toWire 再算 sig/发送：① 不把 base64 截图推给浏览器（同 /events，见 event-wire.js）；
        // ② 顺带治掉一笔隐性开销——sig 是**每 300ms** 把整个 events 数组 stringify 一遍做去重的，
        //    带着 1.35MB base64 时，光这一下就足以把 event loop 拖住。
        const frame = toWire(raw, id)
        // 去重键含 kind + events + fileChanges + todos：todos(如 TodoWrite)/fileChanges 可能在无新
        // event 时变化，仅比 events 会漏发致详情面板陈旧；含 kind 防 reset 帧被同 sig 吞掉。
        const sig = JSON.stringify([frame.kind, frame.events, frame.fileChanges, frame.todos, frame.messageReceipts])
        if (sig === lastSig) return // 内容未变，不发
        lastSig = sig
        if (frame.lastSeq != null) lastSentSeq = frame.lastSeq
        const idLine = frame.lastSeq != null ? `id: ${frame.lastSeq}\n` : ''
        res.write(`${idLine}data: ${JSON.stringify(frame)}\n\n`) // SSE id: 供浏览器重连游标
      }
      send(first)
      let ticks = 0
      let busy = false // setInterval(async) 不会等上一轮跑完；不设闸，慢会话上多轮解析会互相叠加 → 雪崩
      const timer = setInterval(async () => {
        if (busy) return // 上一拍还在扫，本拍直接丢（下一拍自然补上，不丢数据——游标在 lastSentSeq 上）
        busy = true
        try {
          send(await eventsPayload(id, lastSentSeq)) // 持续：从上次已发 seq 续增量
          // ~15s 心跳。**必须是具名事件而不是注释行 `: ping`**：注释行浏览器根本不暴露给 JS，
          // 前端无从知道连接是死是活。而 SSE 的经典失败模式是「半死连接」——手机休眠/切后台/
          // NAT 超时后 TCP 还开着、一个字节也不再来，`onerror` 永不触发、readyState 恒 OPEN，
          // 于是兜底轮询永不启动，界面**永久冻在旧数据上**（用户实测：看板是最新的，对话流停在 15 分钟前）。
          // 具名事件不会触发 onmessage，不污染 applyPayload；前端据它做心跳看门狗。
          if (++ticks % 50 === 0) res.write(`event: ping\ndata: ${Date.now()}\n\n`)
        } catch { /* 单次失败不致命 */ } finally { busy = false }
      }, 300)
      req.on('close', () => clearInterval(timer))
      req.on('error', () => { clearInterval(timer); res.end() })
      return
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      if (url.pathname === '/api/maintenance/drain') {
        const result = maintenanceLease.enter(() => restartBlockers({
          sessionLists: [driver.listSessions(), codexDriver.listSessions(), kimiDriver.listSessions()],
          mutationCount: mutationActivity.count(),
          execCount: activeExecCount,
        }))
        return json(res, 200, result)
      }
      // 运行时调整会话并发上限（AM-260721）：设置页"会话并发上限"用。
      // 立即生效 + 落盘，让"调个数字"不再要以重启杀光该机全部平台会话为代价。
      if (url.pathname === '/api/config/max-sessions') {
        const raw = body.max
        // 非数字（字符串/undefined/数组/…）直接 400，不能悄悄吞掉——gate.setMax 对脏输入的行为
        // 是"保持原值不变"，那是给内部脏数据兜底用的，不能当 API 层的校验：调用方发错了参数
        // 应该被明确告知，而不是看到 200 却发现值根本没变，一头雾水。
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          return json(res, 400, { error: `max 必须是数字，例如 { "max": 12 }（收到 ${JSON.stringify(raw)}）` })
        }
        const before = sessionGate.stats().max
        // clamp 只信 setMax 的返回值——[1, MAX_CEILING] 的判断唯一真相源在 session-gate.js，
        // 这里绝不重新实现一遍（重复实现=两处判断迟早不一致）。
        const effective = sessionGate.setMax(raw)
        try {
          writePersistedMax(effective)
        } catch (e) {
          // 落盘失败不影响本次已经生效的内存值，只是意味着下次 agent 重启会回退到旧文件/env——
          // 这种漂移必须留痕，不能悄悄吞掉。
          console.error('[gate] 并发上限持久化失败（本次调整仍已在内存生效，重启后可能回退）:', e)
        }
        // 限额变更是运维事件，值得进日志：谁（来源 IP，本系统在 agent 这层拿不到更细的用户身份）、
        // 改了什么（请求值→clamp 后的生效值）。
        console.log(`[gate] 会话并发上限变更 ${before} → ${effective}（请求值 ${raw}，来自 ${req.socket.remoteAddress || '?'}）`)
        return json(res, 200, { ...sessionGate.stats(), max: effective })
      }
      // 今日复盘：对当天各会话要点做 haiku 归纳（由 hub 汇总后转发到本机 agent）
      if (url.pathname === '/api/review/reflect') {
        const md = await digest.reflectDay(String(body.date ?? ''), Array.isArray(body.items) ? body.items : [])
        return json(res, 200, { markdown: md })
      }
      if (url.pathname === '/api/exec') {
        const r = await runExec({ cmd: String(body.cmd ?? ''), cwd: body.cwd ? String(body.cwd) : '' })
        return r.error ? json(res, r.status || 500, { error: r.error }) : json(res, 200, r)
      }
      // 终端会话管理：删除 / 改名+保留开关
      if (url.pathname === '/api/term/kill') {
        return json(res, 200, { ok: await terminal.killTermSession(String(body.termId ?? '')) })
      }
      if (url.pathname === '/api/term/meta') {
        return json(res, 200, { ok: await terminal.setTermMeta(String(body.termId ?? ''), { label: body.label, keep: body.keep }) })
      }
      if (url.pathname === '/api/session') {
        const { cwd, mode, prompt, model, engine, effort } = body
        if (!cwd || !prompt) return json(res, 400, { error: 'cwd 与 prompt 必填' })
        if(process.env.WA_ENFORCE_WORKSPACE==='1'){
          let real,root;try{real=fs.realpathSync(cwd);root=fs.realpathSync(DATA_ROOT)}catch{return json(res,400,{error:'项目目录不存在'})}
          if(real!==root&&!real.startsWith(root+path.sep))return json(res,403,{error:'项目目录不在该节点配置的工作区范围内'})
        }
        const record = await spawnGated(() => {
          if (engine === 'codex') return codexDriver.createSession({ cwd, prompt, effort, model })
          if (engine === 'kimi') return kimiDriver.createSession({ cwd, mode, prompt, model, effort })
          return driver.createSession({ cwd, mode, prompt, model, effort })
        })
        idToCwd.set(record.id, cwd)
        idToEngine.set(record.id, record.engine)
        return json(res, 200, { id: record.id })
      }
      let m = /^\/api\/session\/([\w-]+)\/digest\/build$/.exec(url.pathname)
      if (m) {
        const ev = await eventsPayload(m[1])
        if (!ev) return json(res, 404, { error: 'session not found' })
        return json(res, 200, { turns: await digest.buildDigest(ev.events || []) })
      }
      // 双引擎并行：为某 Claude 会话起一个 Codex 审核会话（拿当前 git diff 预设审查提示）
      // 会话级 POST /api/session/:id/review 已于 2026-08-04 删除。
      // 它由 8e10e30（"去掉开始审核"）遗留：那次有意把「开始审核」UI 换成通用 Codex 对话流，
      // 但后端这条没跟着删，前端零调用方长达一个月，还挂在 openapi 里误导人。
      // ⚠️ 随之丢失的能力：它会自动跑 codetree.gitDiff(cwd) 把真实改动注入审核 prompt
      //    （新流程只发用户手打的 prompt）。gitDiff 本身保留在 codetree.js，将来代码 Tab
      //    要做 diff 视图可直接用。若要恢复"一键审核当前改动"，从这里重建即可。
      m = /^\/api\/session\/([\w-]+)\/message$/.exec(url.pathname)
      if (m) {
        const drv = driverFor(m[1])
        if (!drv) return json(res, 409, { error: '会话不可写（影子会话或已结束）' })
        if (drv === codexDriver) {
          const receipt = await drv.submitMessage(m[1], String(body.text ?? ''), Array.isArray(body.images) ? body.images : [], { behavior: body.behavior ?? 'steer' })
          return json(res, receipt.ok ? 200 : receipt.status || 409, receipt)
        }
        const accepted = await drv.sendMessage(m[1], String(body.text ?? ''), Array.isArray(body.images) ? body.images : [])
        const current = drv.listSessions().find((s) => s.id === m[1])
        return accepted
          ? json(res, 200, { ok: true, queued: (current?.queuedMessages ?? 0) > 0, queueDepth: current?.queuedMessages ?? 0 })
          : json(res, 409, { error: current?.error || '会话不可写（影子会话或已结束）' })
      }
      m = /^\/api\/session\/([\w-]+)\/interrupt$/.exec(url.pathname)
      if (m) {
        const drv = driverFor(m[1])
        return (drv && await drv.interrupt(m[1]))
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: 'session not found' })
      }
      m = /^\/api\/session\/([\w-]+)\/mode$/.exec(url.pathname)
      if (m) {
        const drv = driverFor(m[1])
        return (drv && await drv.setMode(m[1], String(body.mode ?? 'default')))
          ? json(res, 200, { ok: true })
          : json(res, 409, { error: '模式切换失败' })
      }
      m = /^\/api\/session\/([\w-]+)\/model$/.exec(url.pathname)
      if (m) {
        const drv = driverFor(m[1])
        return (drv && await drv.setLlmModel(m[1], String(body.model ?? '')))
          ? json(res, 200, { ok: true })
          : json(res, 409, { error: '模型切换失败（会话不存在，或模型不在可选列表）' })
      }
      m = /^\/api\/session\/([\w-]+)\/effort$/.exec(url.pathname)
      if (m) {
        const drv = driverFor(m[1])
        return (drv && await drv.setLlmEffort(m[1], String(body.effort ?? 'xhigh')))
          ? json(res, 200, { ok: true })
          : json(res, 409, { error: 'effort 切换失败（仅 Claude 平台会话支持）' })
      }
      m = /^\/api\/action\/([\w-]+)$/.exec(url.pathname)
      if (m) {
        return (driver.resolveAction(m[1], String(body.resolution ?? ''))
          || codexDriver.resolveAction(m[1], String(body.resolution ?? ''))
          || kimiDriver.resolveAction(m[1], String(body.resolution ?? '')))
          ? json(res, 200, { ok: true })
          : json(res, 409, { error: '待办不存在或已处理' })
      }
      m = /^\/api\/session\/([\w-]+)\/takeover$/.exec(url.pathname)
      if (m) {
        const reqId = m[1]
        await buildState() // 刷新状态与映射
        // 分离态（session-durability Phase 1a）：reqId 是持久化的 psId → 按 alias 精确定位原生会话恢复。
        // JSONL 定位不依赖看板 top-N（findClaudeJsonlByRealId，修 Codex-P0-4）；resume 用 realSessionId 而非 psId。
        const alias = sessionStore.get(reqId)
        if (alias && alias.engine === 'claude' && alias.realSessionId) {
          const cwd = alias.cwd
          const file = (alias.jsonlPath && fs.existsSync(alias.jsonlPath))
            ? alias.jsonlPath : findClaudeJsonlByRealId(cwd, alias.realSessionId)
          if (!file || !cwd) return json(res, 404, { error: 'session not found' })
          // 实时活跃守卫：终端可能正 `claude --resume` 同一会话，双写会损坏。判据见 hasLiveWriter——
          // 必须**真有写者进程**，光看 mtime 会把 touch/rsync 误判成"在跑"，把用户堵成死胡同。
          let mtimeMs
          try { mtimeMs = fs.statSync(file).mtimeMs } catch { return json(res, 404, { error: 'session not found' }) }
          if (!body.force && hasLiveWriter(cwd, alias.realSessionId, mtimeMs)) {
            return json(res, 409, { error: '该会话正在终端中运行，暂不可接管', canForce: true })
          }
          const record = await spawnGated(() => driver.createSession({ cwd, mode: String(body.mode ?? alias.mode ?? 'auto'), resume: alias.realSessionId }))
          sessionStore.remove(reqId) // 旧 psId 身份被新 live 会话取代（新会话自建持久化条目；Phase 1b 将改为复用同 psId）
          return json(res, 200, { id: record.id })
        }
        // 普通影子会话：shadowId 即原生 uuid
        const shadowId = reqId
        const file = idToFile.get(shadowId)
        const cwd = idToCwd.get(shadowId)
        if (!file || !cwd) return json(res, 404, { error: 'session not found' })
        // 影子会话 shadowId 即原生 uuid（= realId）。Claude 走 hasLiveWriter 的精确活体判定；
        // Codex 通过原 daemon 重连，由上游写锁保证单写；活跃状态不应阻止重连。
        let blocked
        const shadowEngine = idToEngine.get(shadowId)
        if (shadowEngine === 'codex') {
          blocked = false
        } else if (shadowEngine === 'kimi') {
          const st = shadowState.get(shadowId)
          blocked = st === 'running' || st === 'waiting_input'
        } else {
          let mt = 0
          try { mt = fs.statSync(file).mtimeMs } catch { return json(res, 404, { error: 'session not found' }) }
          blocked = hasLiveWriter(cwd, shadowId, mt)
        }
        if (!body.force && blocked) {
          return json(res, 409, { error: '该会话正在终端中运行，暂不可接管', canForce: true })
        }
        // ⚠️ 必须按引擎三路分派。曾经是 codex/claude 二选一，Kimi 影子会话一上线就落进 Claude
        // 分支 → 把 `session_<uuid>` 喂给 `claude --resume` → 报「is not a UUID」（用户实拍）。
        // 每加一个引擎，这里和 driverFor() 都要同步，漏一个就是这种指错方向的报错。
        const record = await spawnGated(() =>
          shadowEngine === 'codex' ? codexDriver.createSession({ cwd, resume: shadowId })
          : shadowEngine === 'kimi' ? kimiDriver.createSession({ cwd, resume: shadowId })
          : driver.createSession({ cwd, mode: String(body.mode ?? 'auto'), resume: shadowId }))
        return json(res, 200, { id: record.id })
      }
      m = /^\/api\/session\/([\w-]+)\/reattach$/.exec(url.pathname)
      if (m) {
        // Phase 1b：把 detached 平台会话按**原 psId** 重新拉起 SDK，恢复后 URL 不变。
        const psId = m[1]
        const alias = sessionStore.get(psId)
        if (!alias || alias.engine !== 'claude' || !alias.realSessionId) {
          return json(res, 404, { error: '会话不存在或不可恢复' })
        }
        const realId = alias.realSessionId
        // 幂等：该 realId 已是 live 平台会话（已被恢复）→ 直接返回其 id，不重复拉起
        if (driver.realSessionIds().has(realId)) {
          const live = driver.listSessions().find((s) => s.realSessionId === realId)
          return json(res, 200, { id: live ? live.id : psId, already: true })
        }
        if (reattachLocks.has(realId)) return json(res, 409, { error: '恢复进行中，请稍候' })
        const cwd = alias.cwd
        const file = (alias.jsonlPath && fs.existsSync(alias.jsonlPath)) ? alias.jsonlPath : findClaudeJsonlByRealId(cwd, realId)
        if (!file || !cwd) return json(res, 404, { error: 'session not found' })
        // 实时活跃守卫（Codex-P0-3）：终端正 `claude --resume <realId>` → 双写会损坏，禁止恢复
        let mtimeMs
        try { mtimeMs = fs.statSync(file).mtimeMs } catch { return json(res, 404, { error: 'session not found' }) }
        // body.force=用户已确认原进程挂起/僵尸(见 hung-agent-session-rescue),放行强制接管;否则守卫拦。
        if (!body.force && hasLiveWriter(cwd, realId, mtimeMs)) {
          return json(res, 409, { error: '该会话正在终端中运行，暂不可恢复', canForce: true })
        }
        reattachLocks.add(realId)
        try {
          const record = await spawnGated(() => driver.createSession({ cwd, mode: String(body.mode ?? alias.mode ?? 'auto'), resume: realId, id: psId }))
          return json(res, 200, { id: record.id }) // record.id === psId → URL 不变
        } finally {
          reattachLocks.delete(realId)
        }
      }
      m = /^\/api\/session\/([\w-]+)\/release$/.exec(url.pathname)
      if (m) {
        const id = m[1]
        const drv = driverFor(id)
        if (!drv) return json(res, 404, { error: 'session not found' })
        // ⚠️ 必须有超时上限：driver.release 内部 `await handle.interrupt()` 对着卡死的子进程
        // 会**永远**挂住（实测 25s+ 不返回，nginx 60s 后给用户 504）。而且它挂在
        // sessions.delete 之前 → 会话根本没被释放、槽位也永远回不来 → 闸门容量被慢慢漏光、
        // 排队者饿死。用户点"释放"想解决的恰恰就是这种卡死会话，不能让他一条出路都没有。
        const sess = [...driver.listSessions(), ...codexDriver.listSessions(), ...kimiDriver.listSessions()].find((s) => s.id === id)
        if (!sess) return json(res, 404, { error: 'session not found' })
        const realId = sess.realSessionId // 先取，release 之后记录就没了
        const outcome = await reapRelease(drv, id, pidForSession(sess))
        if (outcome === 'stuck') {
          return json(res, 409, { error: '会话释放未确认（进程可能仍卡住），请稍后重试或在终端中手动处理', outcome })
        }
        freeSlot(id) // 归还并发槽位，让排队中的派生请求能被放行
        return json(res, 200, { ok: true, realId, outcome })
      }
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    // 并发闸门的排队超时/队列满是**预期内**的背压，不是 500，也不该刷错误日志。
    // 必须按 503 原样透传（含 position/active/max），否则 hub 的 fetchJson 会把可操作字段吃掉，
    // 前端只剩一句"创建失败"，用户一条出路都没有——这个坑本项目栽过（见 CLAUDE.md 代理层压平错误）。
    const gated = gateErrorResponse(e)
    if (gated) return json(res, gated.status, gated.body)
    console.error(e)
    json(res, 500, { error: String(e?.message ?? e) })
  }
})
server.on('upgrade', (req, socket, head) => {if(!nodeAuthorized(req)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}terminal.handleUpgrade(req, socket, head)})
// 监听地址（2026-09-08：用安全组开内网端口替代 3 条 `ssh -L` 隧道）。
//
// ★ 默认仍是 127.0.0.1 —— 不配就是今天的行为，安全的那一侧当默认值。
//   部署时由 systemd drop-in 显式给本机 eth0 的内网地址（如 10.7.0.3），hub 直连它。
// ⚠️ **绝不能用 0.0.0.0**：这些机器网卡上虽无公网 IP，但有 docker 网桥(172.x)、
//   tailscale(100.x) 和 cnbypass 的 tun0(10.98.x)。agent 的 API 无鉴权、且 /api/exec
//   与终端 WebSocket 能以 root 执行任意命令 ⇒ 绑 0.0.0.0 等于把 root 开放给同机所有容器
//   和隧道对端。护栏在 agent-bind.test.mjs（源码断言）。
// ⚠️ 127.0.0.1 **必须同时保留**：deploy-agent.sh 的活跃会话检查与 drain、restart.sh、
//   agent-watchdog.sh 全都在打 localhost:8788。只绑内网地址会把这些工具静默弄坏，
//   而看门狗坏掉是本仓库反复栽过的那一类。
const BIND_HOST = (process.env.WA_AGENT_HOST || '').trim() || '127.0.0.1'
if(['0.0.0.0','::'].includes(BIND_HOST)&&!process.env.WA_AGENT_TOKEN)throw new Error('全网卡节点监听必须配置接入令牌')
if (!['127.0.0.1','0.0.0.0','::'].includes(BIND_HOST)) {
  const loopback = http.createServer(server.listeners('request')[0])
  loopback.on('upgrade', (req, socket, head) => {if(!nodeAuthorized(req)){socket.destroy();return}terminal.handleUpgrade(req, socket, head)})
  loopback.on('error', (e) => console.error(`[bind] 回环监听失败（本机运维工具会受影响）：${e?.message ?? e}`))
  loopback.listen(PORT, '127.0.0.1', () => console.log(`node-agent also listening on 127.0.0.1:${PORT}`))
}
server.listen(PORT, BIND_HOST, () => {
  // 平台会话身份持久化（session-durability Phase 1a）：启动即加载本地 store 并剪除死记录，
  // 供 buildState 把重启前的平台会话按原 psId 以 detached 形式恢复到列表 + 支撑旧深链解析。
  sessionStore.load()
  projection.load()
  console.log(`[projection] 已加载：${JSON.stringify(projection.stats())}`)
  sessionStore.prune(Date.now())
  // Reattach the external Codex daemon after restart; HTTP remains available.
  // Count restoration as a mutation so another restart cannot race startup.
  let reconnecting = false
  const reconnectCodex = async () => {
    if (reconnecting || shuttingDown || maintenanceLease.isActive()) return
    reconnecting = true
    const finish = mutationActivity.begin()
    try { await codexDriver.restoreManagedSessions() }
    finally { finish(); reconnecting = false }
  }
  void reconnectCodex()
  const reconnectTimer = setInterval(() => void reconnectCodex(), 30_000)
  reconnectTimer.unref()
  console.log(`node-agent listening on ${BIND_HOST}:${PORT} (platform-sessions: ${Object.keys(sessionStore.all()).length})`)
  // 来源要报出来：运维看到一个陌生的数字时，得能一眼分清是"上次调过且落了盘"还是
  // "部署配的 env"还是"压根没配走了默认值"，别让人对着一个数字干猜。
  const maxSessionsSourceLabel = { file: '持久化文件', env: 'WA_MAX_SESSIONS 环境变量', default: '内置默认值' }[MAX_SESSIONS_SOURCE] || MAX_SESSIONS_SOURCE
  console.log(`[gate] 会话并发上限 ${MAX_SESSIONS}（来源：${maxSessionsSourceLabel}，硬天花板 ${MAX_CEILING}），派生最小间隔 ${SPAWN_MIN_INTERVAL_MS}ms，排队等待上限 ${SPAWN_QUEUE_WAIT_MS}ms`)
  if (REAP_ENABLED) {
    console.log(`[reap] 挂起会话回收已启用：静默 ${REAP_IDLE_MS / 60000}min / 等待用户 ${REAP_WAITING_MS / 60000}min，每 ${REAP_INTERVAL_MS / 1000}s 一轮`)
    const timer = setInterval(() => { reapHungSessions().catch((e) => console.error('[reap]', e)) }, REAP_INTERVAL_MS)
    timer.unref() // 别因为回收循环拖住 agent 的优雅退出
  }
})

// 配合 systemd KillMode=mixed：SIGTERM 只到主进程，SDK/app-server 子进程继续完成当前回合。
// active 归零后 flush 身份层并退出。
//
// ⚠️ 两条硬教训（CR-008，2026-07-09 在 232 实测踩到）：
// ① **排空必须有自己的截止时间**。原来 check() 无限等到 blockers 清零，靠 systemd TimeoutStopSec 兜底——
//    结果 stop 一直卡在 'stop-sigterm'，到点 systemd 把 agent 主进程和**全部** claude/codex 子进程一起
//    SIGKILL：优雅排空非但没保护在飞回合，反而制造了 120s 停机 + 全量硬杀。故这里自己设 DRAIN_MAX_MS
//    (< TimeoutStopSec)，到点就干净退出（flush 已落盘），把「停机 120s + 硬杀」降级成「≤30s + 干净重启」。
// ② **不能等待"发起本次重启的那个会话"**。它由本 agent 驱动、恒为 running（正在跑 restart 命令），
//    排空等它、它等排空 → 死锁。restart.sh 会把该会话 psId 写进 drain-exclude 清单，这里读取并豁免。
const DRAIN_MAX_MS = Number(process.env.WA_DRAIN_MAX_MS ?? 30_000)
const DRAIN_EXCLUDE_FILE = path.join(os.homedir(), '.web-agents', 'drain-exclude')

/** 读取并消费排空豁免清单（restart.sh 写入，仅 120s 内新鲜有效）。读完即删，避免影响下次重启。 */
function readDrainExclusions() {
  try {
    const st = fs.statSync(DRAIN_EXCLUDE_FILE)
    const fresh = Date.now() - st.mtimeMs < 120_000
    const ids = fresh
      ? fs.readFileSync(DRAIN_EXCLUDE_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      : []
    try { fs.unlinkSync(DRAIN_EXCLUDE_FILE) } catch { /* 删不掉不致命 */ }
    return new Set(ids)
  } catch { return new Set() }
}

let shutdownTimer = null
let shutdownClosing = false
function beginGracefulShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  const excludeIds = readDrainExclusions()
  const drainStart = Date.now()
  console.warn(`[shutdown] 收到 ${signal}，停止接收新工作并等待活跃回合排空（上限 ${Math.round(DRAIN_MAX_MS / 1000)}s）…`
    + (excludeIds.size ? ` 豁免发起本次重启的会话：${[...excludeIds].join(', ')}` : ''))
  const check = () => {
    if (shutdownClosing) return
    const blockers = restartBlockers({
      sessionLists: [driver.listSessions(), codexDriver.listSessions(), kimiDriver.listSessions()],
      mutationCount: mutationActivity.count(),
      execCount: activeExecCount,
      excludeIds,
    })
    const waited = Date.now() - drainStart
    if (blockers.length && waited < DRAIN_MAX_MS) {
      console.warn(`[shutdown] 等待中(${Math.round(waited / 1000)}s)：${blockers.map((x) => `${x.id}[${x.state}]`).join(', ')}`)
      return
    }
    if (blockers.length) {
      console.error(`[shutdown] ⚠️ 排空超时 ${Math.round(waited / 1000)}s，仍在飞：${blockers.map((x) => `${x.id}[${x.state}]`).join(', ')}`
        + '——放弃等待、干净退出（继续等只会被 systemd TimeoutStopSec 到点 SIGKILL 整个 cgroup，代价更大）')
    }
    shutdownClosing = true
    if (shutdownTimer) clearInterval(shutdownTimer)
    shutdownTimer = null
    if (!sessionStore.flush()) {
      console.error(`[shutdown] ⚠️ 身份层落盘失败：${sessionStore.lastWriteError()?.message || '未知'}——重启后可能丢失平台会话身份，请检查磁盘/权限`)
    }
    console.warn('[shutdown] 已排空，退出 agent 主进程')
    server.close(() => process.exit(0))
    // SSE/keep-alive 连接不应反向阻塞服务退出；systemd 的 120s 上限留给真正的在飞回合。
    const forceMainExit = setTimeout(() => process.exit(0), 2_000)
    forceMainExit.unref?.()
  }
  check()
  if (!shutdownClosing && !shutdownTimer) {
    shutdownTimer = setInterval(check, 1_000)
    shutdownTimer.unref?.()
  }
}
process.on('SIGTERM', () => beginGracefulShutdown('SIGTERM'))
