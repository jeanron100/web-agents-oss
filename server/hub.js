import { RELEASE_VERSION } from './release-version.js'
// Hub（P1 聚合层）：聚合多台服务器 node-agent 的状态，统一暴露给 Web 前端。
// 远端 agent 通过 SSH 隧道映射到本机端口（免开入站端口，与设计文档 D4 一致）。
// 端点：GET /api/state  GET /api/session/:id/events
import './env.js'          // 必须最先：把 server/.env 灌进 process.env（否则 WA_* 开关不生效）
import http from 'node:http'
import zlib from 'node:zlib'
import { acceptsGzip, shouldCompress } from './http-compress.js'
import { sinkFor, sseGzipEnabled } from './sse-gzip.js'
import { createArchiveStore } from './archive-store.js'
import { pullOnce } from './archive-pull.js'
import { reconcile } from './archive-recon.js'
import { extractSession } from './archive-extract.js'
import { searchSessions } from './archive-search.js'
import { summarize } from './archive-extract.js'
import { conversationAround } from './archive-context.js'
import { createProgressAssistant } from './progress-assistant.js'
import { createProgressBackfill } from './progress-backfill.js'
import { createProgressModel } from './progress-model.js'
import { createTunnelProbe } from './progress-live.js'
import { archivedProgress } from './progress-archive.js'
import { planBatches, shouldPauseByLatency, sleepFor, toPoint, VECTOR_DIM, BATCH, DUTY } from './archive-vector.js'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { notifyPending, notifyEnabled,notificationSettings,updateNotifications } from './notify.js'
import * as push from './push.js'
import * as db from './db.js'
import { normalizeEntries, hiddenForServer } from './hidden-projects.js'
import { flags } from './flags.js'          // WebAgents 2.0 数据库层特性开关（默认全关）
import * as redis from './redis.js'          // Redis 协调层骨架（P0：flag=0 时不连）
import { codexQuotaSamples, kimiQuotaSamples } from './quota-history.js'
import { probeCodexAccounts, configureQuotaSources } from './codex-quota-sources.js'
import { createConfigStore, createAgentFetch, statePath } from './runtime-config.js'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as usageCache from './usage-cache.js' // 额度值 stale-while-revalidate 缓存
import * as mongo from './mongo.js'          // Mongo 历史投影连接层
import * as projector from './event-projector.js' // 轮询增量 → normalize → redact → 幂等写 Mongo
import * as eventRepo from './repositories/event-repository.js' // 只读历史查询（P3）
import * as runRepo from './repositories/run-repository.js'     // 会话概要 + agent 状态跳变/重启事件
import * as alerts from './alerts.js'        // 数据层看门狗（内存/磁盘/spool/心跳/备份新鲜度）
import { buildPendingDigest } from './pending-digest.js' // 总工待处理聚合（P0 可见性）：/api/pending 用的纯函数
import { runUsageProbe, DEFAULT_USAGE_SERVER, DEFAULT_USAGE_CMD } from './usage-limits.js'
import { usageWire } from './usage-wire.js'
import { runKimiUsageProbe, kimiUsageCmd } from './kimi-usage.js' // Kimi 订阅额度（tmux 驱动 TUI 取数） // 订阅额度探测（委派给已登录的机器代跑）
import { classifyForwardError } from './forward-error.js' // 转发失败 → 线协议（超时=504 结果未知，别谎报「未送达」）
import { shouldCacheAccounts, CODEX_CACHE_TTL_SEC } from './usage-throttle.js' // Codex 额度缓存：TTL 必须严格长于前端轮询间隔
import { forwardTimeoutMs } from './forward-timeouts.js' // 转发等多久（派生路径必须等过闸门排队上限）
import { singleFlight } from './single-flight.js' // buildState() 单飞去重（Fix 2，见下方调用处注释）
import { makeCursor, parseCursor, cursorComparable, diffSessions, mergeDelta, deltaEnabled, sessionFingerprint, createVersionRing, wireMetrics, createFrameWindow, dedupeSessionsById, countDuplicateSessions } from './state-delta.js' // /api/state 增量下发
import { createOperatorAuth } from './operator-auth.js'
import { createServerManagement } from './server-management.js'
import { serveWeb } from './static-web.js'
import { createInstallationSettings } from './installation-settings.js'

const PORT = Number(process.env.WA_HUB_PORT)||8787
const HOST = process.env.WA_HUB_HOST||'127.0.0.1'
const configStore=createConfigStore()
const hubConfig=configStore.get()
configureQuotaSources(hubConfig.quota)
const agents=hubConfig.agents.filter(a=>a.enabled!==false)
const fetch=createAgentFetch(()=>agents)
if(HOST!=='127.0.0.1'&&HOST!=='::1'&&process.env.WA_AUTH_ENABLED!=='1')throw new Error('非回环Hub监听必须启用WA_AUTH_ENABLED=1')
const operatorAuth=createOperatorAuth()
const projectUsageScope = { activeServerIds: agents.map(a => a.id), retiredServers: hubConfig.retiredAgents ?? [] }

const idToAgent = new Map()     // sessionId -> agent url
const actionToAgent = new Map() // actionId -> agent url
const serverToAgent = new Map(agents.map((a) => [a.id, a.url]))

const idToMeta = new Map()      // sessionId -> { serverId, project }
let projectModels = {}          // "serverId/project" -> 模型 id（内存缓存，写通式）

// D2 故障回填缓存：agentId -> { sessions, pendingActions, ts }。隧道抖动时某轮 fetch 失败，
// 不再让该服务器的会话瞬间清空再重现——用上一轮成功结果兜住，直到缓存过期（STALE_TTL_MS）。
const lastAgentState = new Map()
// agent 身份与在线态（重启/上下线跳变探测；见 buildState 里 bootId 的注释）
const agentBoot = new Map()   // serverId -> { bootId, bootAt }
const agentOnline = new Map() // serverId -> bool
const STALE_TTL_MS = 5 * 60_000

// ───────── /api/state 增量下发的版本环（见 state-delta.js 文件头的实测数据）─────────
//
// 前端每 3s 全量拉一次（53.5KB 原始 / 17KB gzip），而 20 拍采样里 **18/19 拍零变化**。
// 跨境链路上这份 17KB 要 p50 4.43s / p90 10.57s / max 16.02s，尾部越过前端 20s 超时被 abort
// ⇒ nginx 499（当天 /api/state 50 条）⇒ 连续 4 次 ⇒ 用户看到「与服务器失联 100 秒」。
//
// ★ 版本**只在内容真的变化时**才自增——否则每个请求都推进版本，客户端的游标永远落后一拍，
//   delta 会退化成「总是有变化」。这一点单测覆盖不到（它是接线层语义），改这里请手动核对。
// ★ bootId 每 hub 进程一份：重启后版本从 0 重来，纯数字游标会「看起来还有效」。
const HUB_BOOT_ID = crypto.randomBytes(6).toString('hex')
// 版本环是 state-delta.js 里**已单测**的纯函数（含「内容不变时版本不前进」那条关键语义）。
// 别在这里再写一份——本仓库靠 resume-guard.js 三侧共用同一份续扫判据才没在部署闸上出事。
const stateVersions = createVersionRing(64)
// 版本 → servers/projectModels 的指纹（决定这两块要不要进 delta 帧）
const prevAux = new Map()

// 影子对照：只留**最近一版**的完整会话（约 53KB），够做精确比对，不占内存。
// 阶段 B 用它证明「delta 合并结果 ≡ 同刻全量」在真实流量下也成立——
// 单测里的随机序列证明不了生产语料的形态（真实会话有 40+ 个字段、含 null/嵌套对象）。
let shadowPrev = null   // { version, sessions }
const stateShadow = () => process.env.WA_STATE_DELTA_SHADOW === '1'

// 滑动窗口（最近 200 帧）：**告警看这个，不看累计比率**。累计会被历史稀释——
// 跑了一周好数据后有人把 delta 改回全量，累计比率要几万帧才爬得过阈值，
// 而这期间看门狗一声不吭 = 与坏掉的看门狗外观完全相同。见 state-delta.js#createFrameWindow。
const stateFrameWindow = createFrameWindow(200, 100)

/** 下行线协议计数：可静默退化的收益必须有指标钉住（同 read_amplification 的理由）。 */
const stateWire = { snapshots: 0, deltas: 0, fullBytes: 0, sentBytes: 0, mismatches: 0, shadowChecks: 0, duplicates: 0 }
export function stateWireSnapshot() {
  return {
    ...wireMetrics(stateWire),
    state_delta_mismatch: stateWire.mismatches,
    state_shadow_checks: stateWire.shadowChecks,
    state_delta_enabled: deltaEnabled() ? 1 : 0,
    // SSE 压缩开关也在这里露出来：回退时（WA_SSE_GZIP=0）要能一眼确认真的关掉了
    sse_gzip_enabled: sseGzipEnabled() ? 1 : 0,
    state_shadow_enabled: stateShadow() ? 1 : 0,
    state_duplicate_sessions: stateWire.duplicates ?? 0,
    state_delta_mismatch_sample: stateWire.sample ?? null,
    // 窗口比率：样本不足时是 **null（"还不知道"）**，不是 0——0 会被 `< 阈值` 判成健康，
    // 等于空闲期把看门狗焊死在绿灯上。
    state_full_ratio_recent: stateFrameWindow.ratio(),
    state_recent_frames: stateFrameWindow.samples(),
  }
}

/**
 * 影子对照：把「上一版 + delta」合并出来，与本次全量逐字段比。
 * 不一致 ⇒ 计数并强制下发 snapshot（宁可多传，也绝不下发算错的增量）。
 * @returns {boolean} true = 一致（或没得比）
 */
function shadowVerify(prevFps, sessionsNow) {
  if (!shadowPrev) return true
  stateWire.shadowChecks += 1
  const d = diffSessions(prevFps, new Map(sessionsNow.map((s) => [s.id, s])))
  const merged = mergeDelta({ sessions: shadowPrev.sessions }, { frame: 'delta', changed: d.changed, removed: d.removed })
  const key = (a, b) => String(a.id).localeCompare(String(b.id))
  const A = [...merged.sessions].sort(key)
  const B = [...sessionsNow].sort(key)
  const ok = JSON.stringify(A) === JSON.stringify(B)
  if (!ok) {
    stateWire.mismatches += 1
    // 采样第一处差异——不留证据的 mismatch 计数只能告诉你"有问题"，查不出是什么。
    if (!stateWire.sample) {
      if (A.length !== B.length) {
        const ida = new Set(A.map((x) => x.id)); const idb = new Set(B.map((x) => x.id))
        stateWire.sample = { kind: 'length', a: A.length, b: B.length,
          onlyInMerged: [...ida].filter((x) => !idb.has(x)).slice(0, 5),
          onlyInNow: [...idb].filter((x) => !ida.has(x)).slice(0, 5),
          prevCount: shadowPrev?.sessions?.length ?? null, prevVersion: shadowPrev?.version ?? null }
      }
      else for (let i = 0; i < A.length; i++) {
        if (JSON.stringify(A[i]) !== JSON.stringify(B[i])) {
          const fields = new Set([...Object.keys(A[i]), ...Object.keys(B[i])])
          const bad = [...fields].filter((f) => JSON.stringify(A[i][f]) !== JSON.stringify(B[i][f]))
          stateWire.sample = { kind: 'field', id: A[i].id, fields: bad.slice(0, 5),
            a: bad.slice(0, 2).map((f) => [f, A[i][f]]), b: bad.slice(0, 2).map((f) => [f, B[i][f]]) }
          break
        }
      }
    }
  }
  return ok
}
// 审批/回复/验收转发给 agent 的上限。默认 30s（普通写操作是 15s）：审批落地本身是 O(1)，
// 迟到的是 agent 事件循环的排队时间，多等一会儿能把「瞬时饥饿」直接变成成功而不是假失败。
// 转发超时策略统一在 forward-timeouts.js（含「派生路径必须等过闸门排队上限」的不变量单测）。

// #7 项目分类（应用视角）：优先存 MySQL(app_config.categories)，文件 categories.json 作降级/备份。键 = 'serverId/project'
const CATFILE = statePath('categories.json',path.join(path.dirname(fileURLToPath(import.meta.url)), 'categories.json'))
const DEFAULT_CATS = ['AI前沿', '数据库技术', '投资', '小玩意']
const normCats = (d) => ({ categories: Array.isArray(d?.categories) && d.categories.length ? d.categories : DEFAULT_CATS, map: d?.map ?? {} })
function loadCategoriesFile() {
  try { return normCats(JSON.parse(fs.readFileSync(CATFILE, 'utf8'))) } catch { return { categories: DEFAULT_CATS, map: {} } }
}
async function loadCategories() {
  if (db.dbEnabled()) {
    const c = await db.getConfig('categories')
    if (c && Array.isArray(c.categories)) return normCats(c)
    const f = loadCategoriesFile() // DB 启用但无记录 → 从文件迁移一次
    await db.setConfig('categories', f)
    return f
  }
  return loadCategoriesFile()
}
async function saveCategories(data) {
  const out = normCats(data)
  if (db.dbEnabled()) await db.setConfig('categories', out)
  try { fs.writeFileSync(CATFILE, JSON.stringify(out, null, 2)) } catch { /* 文件备份失败不致命 */ }
  return out
}

// 隐藏项目（「隐藏 = 不加入项目纳管」，用户 2026-09-06）：存 MySQL(app_config.hidden_projects)，
// 文件 hidden-projects.json 作降级/备份。键 = 'serverId/project'，与星标同一套键空间。
//
// ★ 权威在这里、判定在 agent：项目在 /api/state 里不是一等公民（只是 sessions[].project 的
//   派生物），只在 hub 或前端过滤挡不住 agent 继续扫那些 JSONL，也挡不住 /api/review、
//   /api/usage/projects-today 这些旁路漏出来。所以名单要**随每次轮询下发**给 agent。
// ★ 但配置不能存 agent 上——那样改一次要发 5 台还要重启（会腰斩在飞会话）。
const HIDEFILE = statePath('hidden-projects.json',path.join(path.dirname(fileURLToPath(import.meta.url)), 'hidden-projects.json'))
function loadHiddenFile() {
  try { return normalizeEntries(JSON.parse(fs.readFileSync(HIDEFILE, 'utf8'))?.hidden) } catch { return [] }
}
async function loadHidden() {
  if (db.dbEnabled()) {
    const c = await db.getConfig('hidden_projects')
    if (c && Array.isArray(c.hidden)) return normalizeEntries(c.hidden)
    const f = loadHiddenFile()
    if (f.length) await db.setConfig('hidden_projects', { hidden: f }) // DB 无记录 → 从文件迁移一次
    return f
  }
  return loadHiddenFile()
}
async function saveHidden(list) {
  const hidden = normalizeEntries(list)
  if (db.dbEnabled()) await db.setConfig('hidden_projects', { hidden })
  try { fs.writeFileSync(HIDEFILE, JSON.stringify({ hidden }, null, 2)) } catch { /* 文件备份失败不致命 */ }
  hiddenCache = hidden
  return hidden
}
// 轮询热路径不能每拍都打一次 DB ⇒ 内存缓存，写入时同步更新。
// ⚠️ 读失败保持上一次的值（fail-open 的另一面：不要因为 DB 抖一下就把隐藏全放出来闪屏）。
let hiddenCache = []
loadHidden().then((h) => { hiddenCache = h }).catch(() => {})

// 服务器标签（运维管家）：存 MySQL(app_config.server_tags)。{ tags:[...预设标签], map:{ serverId: 标签 } }
const DEFAULT_SERVER_TAGS = ['主控', '数据库', '代理', '应用']
const normSrvTags = (d) => ({ tags: Array.isArray(d?.tags) && d.tags.length ? d.tags : DEFAULT_SERVER_TAGS, map: d?.map ?? {} })
async function loadServerTags() {
  if (db.dbEnabled()) {
    const c = await db.getConfig('server_tags')
    if (c) return normSrvTags(c)
  }
  return { tags: DEFAULT_SERVER_TAGS, map: {} }
}
async function saveServerTags(data) {
  const out = normSrvTags(data)
  if (db.dbEnabled()) await db.setConfig('server_tags', out)
  return out
}

// #2 真实订阅用量：官方 /usage 的 5h/周 配额 %（与 VS Code 同源，账号级）。
//
// ⚠️ 探测**不在 hub 本机跑**。hub 2026-07-19 迁到 .189.4，而那台机的 claude 未登录，
// 于是探测静默返回空——更糟的是旧代码 `if (p)` 会把上次的值永久留着、错误也被 `(_err,…)`
// 吞掉，界面自信地挂了 18 小时前的 16%（真实 29%），直到 hub 重启清空内存才暴露成「—」。
// 现在：委派给 WA_USAGE_SERVER（默认 .232，全集群唯一登录着的机器）经**已有的** /api/exec
// 代跑，agent 侧零改动零重启（重启 .232 agent 会杀掉同 cgroup 的运维会话并截断该机所有
// 平台会话的当前回合，见 CLAUDE.md）。解析与失败归因在 usage-limits.js，有单测。
let USAGE_SERVER = process.env.WA_USAGE_SERVER || hubConfig.quota?.preferredSources?.claude || DEFAULT_USAGE_SERVER
const USAGE_CMD = process.env.WA_USAGE_CMD || DEFAULT_USAGE_CMD
const USAGE_RETRY_MS = 60_000  // 冷却：没有它，null 态下**每个请求**都会去 spawn 一次 claude（当天白跑 114 次）
let usageLimits = null         // 最近一次**成功**的结果 { session, week, weekSonnet, ts }
let usageProbing = false       // 此刻是否有探测在飞（供出口标 pending，让前端快速补拉）
let usageError = null          // 最近一次失败原因；null = 上次是成功的
let usageLastTry = 0
/** 让 .232 代跑探测命令，取回原始 stdout（没有 stdout 就退回 stderr，好归因） */
async function execUsageOnAgent() {
  const agentUrl = serverToAgent.get(USAGE_SERVER)
  if (!agentUrl) throw new Error(`未知取数机 ${USAGE_SERVER}（对不上 hub-config.json 里的 id）`)
  const r = await fetchJson(`${agentUrl}/api/exec`, 70_000, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: USAGE_CMD }),
  })
  return String(r?.stdout || '').trim() ? String(r.stdout) : String(r?.stderr || '')
}
// 启动即从 Redis 回填额度：**连节流水位(usageLastTry)一起恢复**才是重点。
// 只恢复值不恢复水位的话，hub 一重启仍会立刻对所有引擎回源重探——而 Kimi 探测
// 要起 tmux 跑 CLI（实测需 90s 超时），那正是这次要消灭的「重启探测风暴」。
// 全程 fail-safe：Redis 挂了 load() 返回 null，一切退回原有行为。
async function hydrateUsageFromCache() {
  const c = await usageCache.load('claude')
  if (c) { usageLimits = c; usageLastTry = c.ts }
  const k = await usageCache.load('kimi')
  if (k) { kimiUsage = k; kimiUsageLastTry = k.ts }
  if (c || k) console.log(`[usage] 已从 Redis 回填额度缓存${c ? ' claude' : ''}${k ? ' kimi' : ''}——本次启动跳过冷探测`)
}

async function refreshUsageLimits() {
  if(!serverToAgent.has(USAGE_SERVER))return
  if (Date.now() - usageLastTry < USAGE_RETRY_MS) return
  usageLastTry = Date.now()
  usageProbing = true              // 供出口标 pending：让前端知道"正在探"，据此快速补拉
  try {
    const r = await runUsageProbe({ exec: execUsageOnAgent })
    if (r.ok) {
      usageLimits = { ...r.data, ts: Date.now() }; usageError = null
      usageCache.save('claude', r.data) // fire-and-forget：同步返回，不可能拖慢这里
      return
    }
    usageError = r.error
    console.warn(`[usage] 额度探测失败（取数机 ${USAGE_SERVER}）：${r.error}`)
  } finally { usageProbing = false }
}
/** 出口载荷：失败时仍给旧值，但必须打上 stale + error，让前端能把"这是旧数据"显示出来 */
function usagePayload() {
  return usageWire({
    value: usageLimits, error: usageError, probing: usageProbing,
    empty: { session: null, week: null, weekSonnet: null },
  })
}
// ── Kimi 订阅额度 ──
// 与 Claude 同一套委派模型（经目标机 /api/exec 代跑），但取数方式不同：Kimi 的 Plan usage
// **只在 TUI 里有**——`kimi -p "/usage"` 会把斜杠命令当提示词、ACP 的 /usage 只回 context
// window、云端 /oauth/usage 端点猜了 5 个 host 全 404（详见 kimi-usage.js 顶部注释）。
// 故用 tmux 驱动 TUI 抓屏解析。一次约 20s，所以冷却比 Claude 长得多。
let KIMI_USAGE_SERVER = process.env.WA_KIMI_USAGE_SERVER || hubConfig.quota?.preferredSources?.kimi || ''
const KIMI_USAGE_CMD = process.env.WA_KIMI_USAGE_CMD || kimiUsageCmd()
const KIMI_RETRY_MS = 10 * 60_000
/**
 * Kimi 额度探测开关（**只有显式 "0" 才关**，拼错保持开启——与 WA_STATE_DELTA / WA_SSE_GZIP 同口径）。
 *
 * 为什么需要它：这条探测不是普通 HTTP 请求，而是 `tmux new-session` 起一个 Kimi TUI、
 * 发按键、抓屏、再 kill——**实测单次 22 秒**（见 exec-audit）。用户不需要时白占取数机。
 * 关掉后 /api/usage/kimi-limits 仍返回缓存里的旧值并标 stale，不会让界面炸掉。
 */
const kimiUsageEnabled = () => process.env.WA_KIMI_USAGE !== '0' && serverToAgent.has(KIMI_USAGE_SERVER)
let kimiUsage = null, kimiUsageError = null, kimiUsageLastTry = 0
let kimiUsageProbing = false
async function execKimiOnAgent() {
  const agentUrl = serverToAgent.get(KIMI_USAGE_SERVER)
  if (!agentUrl) throw new Error(`未知取数机 ${KIMI_USAGE_SERVER}（对不上 hub-config.json 里的 id）`)
  const r = await fetchJson(`${agentUrl}/api/exec`, 70_000, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: KIMI_USAGE_CMD }),
  })
  return String(r?.stdout || '').trim() ? String(r.stdout) : String(r?.stderr || '')
}
async function refreshKimiUsage() {
  if (!kimiUsageEnabled()) return          // 显式关闭：不探测，沿用缓存值
  if (Date.now() - kimiUsageLastTry < KIMI_RETRY_MS) return
  kimiUsageLastTry = Date.now()
  kimiUsageProbing = true          // 供出口标 pending（Kimi 探测约 20s，更需要让前端知道"在探"）
  try {
    const r = await runKimiUsageProbe({ exec: execKimiOnAgent, cmd: KIMI_USAGE_CMD })
    if (r.ok) {
      kimiUsage = { ...r.data, ts: Date.now() }; kimiUsageError = null
      usageCache.save('kimi', r.data)
      void db.insertQuotaSamples(kimiQuotaSamples(kimiUsage, KIMI_USAGE_SERVER))
      return
    }
    kimiUsageError = r.error
    console.warn(`[kimi-usage] 额度探测失败（取数机 ${KIMI_USAGE_SERVER}）：${r.error}`)
  } finally { kimiUsageProbing = false }
}
function kimiUsagePayload() {
  const base = kimiUsage ?? { session: null, week: null }
  // ⚠️ 关掉时必须**如实标记**，不能让界面把陈旧值当成实时值——
  //    本仓库栽过「探测失败仍把旧值当新数据反复 upsert」那个坑。
  if (!kimiUsageEnabled()) return { ...base, stale: true, disabled: true, error: '已按用户要求停用 Kimi 额度探测（WA_KIMI_USAGE=0）' }
  return usageWire({ value: kimiUsage, error: kimiUsageError, probing: kimiUsageProbing, empty: { session: null, week: null } })
}

async function refreshAndStoreUsage() {
  await refreshUsageLimits()
  // 探测失败**不写库**：旧代码在这儿把陈旧值反复 upsert 成"新数据"，
  // 于是 07-25 19:00 之后的周用量时序连续 6 个 3h 桶都是一模一样的 16，看着像还活着。
  if (!usageLimits || usageError) return
  await db.insertUsageLimits(usageLimits) // 官方用量%时序入库（#10）
  await db.upsertUsageLimitsDaily(usageLimits) // 周使用率按日期记录（一天一行）
}
void refreshAndStoreUsage()
setInterval(() => { void refreshAndStoreUsage() }, 5 * 60_000)
// 回填失败也必须继续走探测：没有 .catch 的话，一旦 hydrate 抛异常，refreshKimiUsage
// 就永远不会被调用 ⇒ 额度**再也不刷新**，而且表面上毫无异常（最坏的一种坏法）。
void hydrateUsageFromCache()
  .catch((e) => console.warn(`[usage] Redis 回填失败（不影响探测）：${e?.message || e}`))
  .finally(() => { void refreshKimiUsage() })
setInterval(() => { void refreshKimiUsage() }, KIMI_RETRY_MS)

// Share dashboard requests and historical sampling; never probe once per chart/tab.
let codexQuotaMemo = null
const refreshCodexLimits = singleFlight(async () => {
  if (codexQuotaMemo && Date.now() - codexQuotaMemo.ts >= 0 && Date.now() - codexQuotaMemo.ts < CODEX_CACHE_TTL_SEC * 1000) {
    return codexQuotaMemo.accounts
  }
  const cached = await usageCache.load('codex')
  if (cached && shouldCacheAccounts(cached.accounts)) {
    codexQuotaMemo = cached
    void db.insertQuotaSamples(codexQuotaSamples(cached.accounts))
    return cached.accounts
  }
  const accounts = await probeCodexAccounts(agents, a => fetchJson(`${a.url}/api/usage/codex-limits`, 15000))
  if (shouldCacheAccounts(accounts)) {
    codexQuotaMemo = { accounts, ts: Date.now() }
    usageCache.save('codex', { accounts }, { ttlSec: CODEX_CACHE_TTL_SEC })
    void db.insertQuotaSamples(codexQuotaSamples(accounts))
  }
  return accounts
})

// 跨服务器每日 token/成本聚合（曲线 + 滚动窗口），供接口与 DB rollup 共用
const z4 = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
const merge4 = (dst, src) => { dst.input += src?.input || 0; dst.output += src?.output || 0; dst.cacheRead += src?.cacheRead || 0; dst.cacheCreate += src?.cacheCreate || 0 }
async function computeMergedDaily(days) {
  const merged = {}
  const mergedCost = {}
  const mergedEngine = {} // day -> { claude, codex, ... } 各引擎 token
  const mergedTok = {}   // day -> {input,output,cacheRead,cacheCreate}
  const mergedCostC = {} // day -> {input,output,cacheRead,cacheCreate} (USD)
  let last5h = 0, last7d = 0
  await Promise.all(agents.map(async (a) => {
    try {
      const r = await fetchJson(`${a.url}/api/usage/daily?days=${days}`, 20000)
      for (const [d, t] of Object.entries(r.daily ?? {})) merged[d] = (merged[d] ?? 0) + t
      // 引擎维度：Codex 只贡献 token、不贡献成本，前端要靠它把口径讲清楚
      for (const [d, m] of Object.entries(r.dayEngineTok ?? {})) {
        const dst = (mergedEngine[d] ??= {})
        for (const [e, t] of Object.entries(m || {})) dst[e] = (dst[e] ?? 0) + t
      }
      for (const [d, c] of Object.entries(r.dailyCost ?? {})) mergedCost[d] = (mergedCost[d] ?? 0) + c
      for (const [d, c] of Object.entries(r.dayTokComp ?? {})) merge4(mergedTok[d] ??= z4(), c)
      for (const [d, c] of Object.entries(r.dayCostComp ?? {})) merge4(mergedCostC[d] ??= z4(), c)
      last5h += r.last5h ?? 0
      last7d += r.last7d ?? 0
    } catch { /* 单 agent 失败忽略 */ }
  }))
  const r2 = (n) => Math.round((n || 0) * 100) / 100
  const out = []
  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const tk = mergedTok[key] ?? z4(), cc = mergedCostC[key] ?? z4()
    out.push({
      date: key,
      tokens: merged[key] ?? 0,
      cost: r2(mergedCost[key]),
      tok: tk,
      costc: { input: r2(cc.input), output: r2(cc.output), cacheRead: r2(cc.cacheRead), cacheCreate: r2(cc.cacheCreate) },
      // 各引擎 token。cost 只含 Claude（Codex 无单价），所以 tokens 与 cost **口径不同**——
      // 前端必须把这件事显式讲出来，否则并排两个格子会让人算出荒谬的单价。
      byEngine: mergedEngine[key] ?? {},
    })
  }
  return { days: out, last5h, last7d }
}

// DB 初始化 + 每日指标 rollup（每 10min 落库，重启不丢、可超 60 天 JSONL 窗口）
void db.initDb().then(async (ok) => {
  if (!ok) return
  projectModels = await db.readProjectModels().catch(() => ({}))
  // Persist recovered cache snapshots at their original timestamps, then sample
  // continuously even when the stats page is closed. Kimi retains its 10min probe.
  const sampleQuota = async () => {
    try {
      await refreshCodexLimits()
      await db.insertQuotaSamples(codexQuotaSamples(codexQuotaMemo?.accounts))
      await db.insertQuotaSamples(kimiQuotaSamples(kimiUsagePayload(), KIMI_USAGE_SERVER))
    } catch (e) { console.warn('[usage] quota sampling failed:', e.message) }
  }
  void sampleQuota()
  setInterval(() => { void sampleQuota() }, 5 * 60_000)
  const rollupActive = async () => {
    const rows = []
    await Promise.all(agents.map(async (a) => {
      try {
        const r = await fetchJson(`${a.url}/api/usage/projects-today`, 20000)
        for (const p of (r?.rows ?? [])) rows.push({ serverId: a.id, project: p.project, activeMs: p.activeMs, cost: p.cost, tokens: p.tokens })
      } catch { /* 忽略该 agent */ }
    }))
    await db.upsertProjectDailyActive(rows)
  }
  const rollup = async () => {
    try { await db.upsertDaily((await computeMergedDaily(14)).days) } catch { /* ignore */ }
    try { await rollupActive() } catch { /* ignore */ }
  }
  await rollup()
  setInterval(() => { void rollup() }, 10 * 60_000)
})

async function fetchJson(url, timeoutMs = 8000, init = undefined) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(body.error ?? `HTTP ${res.status}`)
      err.status = res.status
      err.body = body // ⚠️ 必须整体带上：agent 的错误体常含**可操作字段**，只留 message 会把出路吃掉。
      // 实际踩到：/reattach 被活体守卫拦时回 409 `{error, canForce:true}`，前端据 canForce 才渲染
      // 「强制接管」。旧代码只 throw message → hub 500 + 纯文本 → 按钮永不出现 → 用户在
      // 「该会话正在终端中运行，暂不可恢复」前面**没有任何出路**（只能点"知道了"）。
      throw err
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

async function buildStateImpl() {
  const servers = []
  const sessions = []
  const pendingActions = []
  await Promise.all(agents.map(async (a) => {
    try {
      // 隐藏名单随每拍下发（agent 无状态、重启不丢）。**永远带这个参数**——
      // agent 靠 `searchParams.has()` 区分「没传」与「传了空」，不带就等于「维持原样」，
      // 那样用户取消隐藏后会一直恢复不了。
      const hq = hiddenForServer(hiddenCache, a.id).map(encodeURIComponent).join(',')
      const st = await fetchJson(`${a.url}/api/state?hidden=${hq}`)
      // sessionGate 必须透传：agent 早就在报「并发 8/8、排队 2 位」，但 hub 这一层把它丢了，
      // 于是前端只能显示「超时」而说不出为什么（2026-07-19 事故）。闸门饱和是运维信号。
      servers.push({
        id: a.id, name: a.name, region: a.region, flag: a.flag ?? '🇨🇳', online: true,
        sessionGate: st.server?.sessionGate ?? null,
        // 主机负载/核数：agent 上报，透传出来供 /api/state 观测 + 负载告警（checkLoad）。
        // 没上报的老 agent 给 null——优雅部分覆盖，覆盖一台是一台。
        load: st.server?.load ?? null, cores: st.server?.cores ?? null,
        // 名额截断信息同样必须透传——agent 报了而 hub 吞掉，前端就还是把残缺当全集
        // （2026-07-21 invest_data 整个项目消失，用户完全看不出是被截断了）。
        sessionsTruncated: !!st.sessionsTruncated,
        hiddenSessions: st.hiddenSessions ?? 0,
        hiddenProjects: st.hiddenProjects ?? 0,
      })
      const aSessions = []
      const aActions = []
      for (const s of st.sessions ?? []) {   // ?? [] 防半开连接返回畸形 200(st.sessions=undefined)抛错→落 catch 里重复 push 同 id server
        idToAgent.set(s.id, a.url)
        // realSessionId 顺带进 idToMeta：/api/v2/events?session= 要把控制台的 ps-* 平台 id
        // 解析成 durable 记录实际按其查询的原生 uuid（见该端点注释），这是现成的查表位置，
        // 不必再另起一张 Map。
        idToMeta.set(s.id, { serverId: a.id, project: s.project, realSessionId: s.realSessionId })
        const merged = { ...s, serverId: a.id }
        sessions.push(merged)
        aSessions.push(merged)
      }
      for (const act of st.pendingActions ?? []) {
        actionToAgent.set(act.id, a.url)
        const merged = { ...act, serverId: a.id }
        pendingActions.push(merged)
        aActions.push(merged)
      }
      // agent 重启探测：bootId 每个 agent 进程一份，变了就是重启过。
      // ⚠️ 名单必须取**重启前那一拍**（lastAgentState 里缓存的），不能用本拍的 aSessions——
      // 重启后那些平台会话早已被 SIGKILL、不在列表里了，事后再也拿不到"谁被杀了"。
      // 这正是本项目最痛的一类事故（2026-07-05 把用户 doc_ceneter 会话在 Edit 落盘后 5 秒杀了），
      // 此前**完全没有记录**：既不知道何时重启，也不知道波及了谁。
      const boot = st.server?.bootId
      if (boot) {
        const prev = agentBoot.get(a.id)
        if (prev && prev.bootId !== boot) {
          const before = lastAgentState.get(a.id)?.sessions ?? []
          void runRepo.recordAgentRestart({
            serverId: a.id, prevBootAt: prev.bootAt, bootAt: st.server?.bootAt,
            activeSessions: before,
          })
        }
        agentBoot.set(a.id, { bootId: boot, bootAt: st.server?.bootAt ?? Date.now() })
      }
      // 在线跳变（只记跳变，不记心跳——心跳在 Redis）
      if (agentOnline.get(a.id) === false) void runRepo.recordOnlineChange({ serverId: a.id, online: true })
      agentOnline.set(a.id, true)

      // 成功一轮才刷新缓存（ts 只在成功时前进，失败轮不续命，过期即真离线）
      // load/cores 一并缓存：负载告警的 alerts.tick 是独立 60s interval，只读 lastAgentState，
      // 让它经 agentHealth 拿到最近一次成功探测的 load（checkLoad 再用 ts 判新鲜度，陈旧不报）。
      lastAgentState.set(a.id, { sessions: aSessions, pendingActions: aActions, ts: Date.now(), load: st.server?.load ?? null, cores: st.server?.cores ?? null })
      // Redis 心跳(30s TTL) + 状态摘要(60s)：轮询成功即续命；30s 不续 → 心跳键自动消失 = 离线（零定时器）。
      // flag=0 或 Redis 不可用时两行都是 no-op（静默降级），绝不拖慢/拖垮 buildState。
      void redis.beatAgent(a.id)
      void redis.cacheAgentState(a.id, {
        online: '1',
        sessions: String(aSessions.length),
        pending: String(aActions.length),
        ts: String(Date.now()),
      })
    } catch {
      if (agentOnline.get(a.id) === true) void runRepo.recordOnlineChange({ serverId: a.id, online: false })
      agentOnline.set(a.id, false)
      const cached = lastAgentState.get(a.id)
      const fresh = cached && (Date.now() - cached.ts < STALE_TTL_MS)
      if (fresh) {
        for (const s of cached.sessions) {
          idToAgent.set(s.id, a.url)
          idToMeta.set(s.id, { serverId: a.id, project: s.project, realSessionId: s.realSessionId })
          sessions.push(s)
        }
        for (const act of cached.pendingActions) {
          actionToAgent.set(act.id, a.url)
          pendingActions.push(act)
        }
        servers.push({ id: a.id, name: a.name, region: a.region, flag: a.flag ?? '🇨🇳', online: false, stale: true })
      } else {
        servers.push({ id: a.id, name: a.name, region: a.region, flag: a.flag ?? '🇨🇳', online: false })
      }
    }
  }))
  // 配置顺序输出
  servers.sort((x, y) => agents.findIndex((a) => a.id === x.id) - agents.findIndex((a) => a.id === y.id))
  // ⚠️ 末尾必须有稳定 tie-breaker（server→project→id）：sessions 是上面 `Promise.all(agents.map(async…push))`
  // 攒的，哪台 agent 先返回就先入列 → 输入顺序随网络时序变。若只按 lastActiveAt 排、平局时就回退到这个
  // 非确定的输入顺序 → /api/state 每次顺序不同、前端看板「感觉有些飘」。前端 sortSessions 也已加同款 tie-breaker。
  sessions.sort((x, y) =>
    (y.lastActiveAt - x.lastActiveAt) ||
    String(x.serverId).localeCompare(String(y.serverId)) ||
    String(x.project).localeCompare(String(y.project)) ||
    String(x.id).localeCompare(String(y.id)))
  pendingActions.sort((x, y) => (y.createdAt - x.createdAt) || String(x.id).localeCompare(String(y.id)))
  void notifyPending(pendingActions, push.broadcast).catch(() => {}) // async：Redis 去重；失败不拖垮 buildState
  // 去重前先记数：这个先前存在的缺陷有多普遍，要能看见（实测 72 条里 1 条重复）
  stateWire.duplicates = countDuplicateSessions(sessions)
  return { servers, sessions: dedupeSessionsById(sessions), pendingActions }
}

// buildState() 单飞去重（Fix 2，2026-07-20 诊断 §3）：这里只做"接线"，去重语义与取舍
// 全部写在 single-flight.js（可独立单测，见 single-flight.test.mjs）——同一时刻只有一次
// buildStateImpl() 真正在跑，5s tick / 每个浏览器 tab 的 3s 轮询 / 60s KB 自动归档 / 各种
// on-demand 兜底路径这四路互不感知的并发调用者不再互相踩踏，堵住"任意一个 agent 变慢就把
// 五台机器一起拖成'同一秒失联又恢复'"的自我放大。
const buildState = singleFlight(buildStateImpl)

// 本机 agent（跑 haiku 复盘用，账号级登录在 .232）
let LOCAL_AGENT = (agents.find((a) => a.url?.includes(':8788')) ?? agents.find((a) => a.url))?.url

// 今日复盘：聚合某天（默认今天）跨项目跨服务器有活跃的会话，按项目分组
function dayRange(dateStr) {
  const base = dateStr ? new Date(dateStr + 'T00:00:00') : new Date()
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()
  return { start, end: start + 86_400_000 }
}
async function buildReview(dateStr) {
  const { servers, sessions } = await buildState()
  const { start, end } = dayRange(dateStr)
  const nameOf = Object.fromEntries(servers.map((s) => [s.id, s.name]))
  const day = sessions.filter((s) => s.lastActiveAt >= start && s.lastActiveAt < end)
  const byProj = new Map()
  for (const s of day) {
    const key = `${s.serverId}|${s.project}`
    const g = byProj.get(key) ?? { project: s.project, server: s.serverId, serverName: nameOf[s.serverId] ?? s.serverId, sessions: [] }
    g.sessions.push({
      id: s.id, engine: s.engine, model: s.model, state: s.state,
      summary: s.summary, lastActiveAt: s.lastActiveAt, tokens: s.tokens, cost: s.cost,
    })
    byProj.set(key, g)
  }
  const projects = [...byProj.values()]
    .map((g) => ({ ...g, sessions: g.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt) }))
    .sort((a, b) => b.sessions.length - a.sessions.length || b.sessions[0].lastActiveAt - a.sessions[0].lastActiveAt)
  const ds = new Date(start)
  const localYMD = `${ds.getFullYear()}-${String(ds.getMonth() + 1).padStart(2, '0')}-${String(ds.getDate()).padStart(2, '0')}`
  return { date: dateStr || localYMD, projects, totalSessions: day.length, totalProjects: projects.length }
}

// 主动轮询，保证待办通知不依赖前端请求（前端没人开着也能推飞书）
const POLL_MS = Number(process.env.HUB_POLL_MS ?? 5000)

// Mongo 历史投影：只在**轮询**这一条路上做（不在每个 /api/state 请求里做，否则前端一刷就重复投影）。
// 取事件走 agent 的 `?since=<seq>` 游标（复用现有 SSE 断线续传协议）→ 只拉增量。
const fetchEventsForProjection = async (sessionId, since) => {
  const url = idToAgent.get(sessionId)
  if (!url) return null
  const q = since ? `?since=${encodeURIComponent(since)}` : ''
  try { return await fetchJson(`${url}/api/session/${sessionId}/events${q}`, 8000) } catch { return null }
}
setInterval(() => {
  void buildState()
    .then(async (st) => {
      const sessions = st?.sessions ?? []
      await projector.projectTick(sessions, fetchEventsForProjection)
      // 会话概要（execution_runs）：跨 agent 重启/文件老化持久的会话账本。
      // 一条会话一条文档，upsert 幂等；量受会话数约束（不随事件量涨），故不建 TTL。
      await runRepo.upsertRuns(sessions)
    })
    .catch(() => {}) // 投影失败绝不影响轮询/通知主流程
}, POLL_MS)

// ── 执行历史归档（openspec execution-history-archive，P0）────────────────────
// 中心拉：hub 本来就靠既有反向隧道每 5s 轮询各 agent，拉取**不需要新链路**；
// 且 checkpoint 集中在此 ⇒「中心确认后才推进水位」天然成立（design D4 的硬要求）。
// 开关：WA_ARCHIVE=0 关闭（只有显式 "0" 才关，拼错保持启用——静默不采比慢更糟）。
const archiveEnabled = () => process.env.WA_ARCHIVE !== '0'
const ARCHIVE_INTERVAL_MS = Number(process.env.WA_ARCHIVE_INTERVAL_MS) || 60_000
const archiveStore = createArchiveStore()
// ⚠️ **checkpoint 必须落盘**（2026-08-29 实测踩到）：初版只放内存 Map，hub 一重启就清零 ⇒
//   每轮从 offset 0 重拉 ⇒ 全被 store 判重复 ⇒ **8 MB 的轮次预算全烧在已归档的数据上**，
//   进度永远卡在第一片。症状极具迷惑性：不报错、`blocked=false`、分片文件也在长，
//   只有 `lines` 增量恒为 0 —— 又一个「看着在跑其实没在采」。
//   （这是我把驱动从 agent 搬到中心时弄丢的：agent 版本本来是持久化的。）
const ARCHIVE_CKPT_FILE = path.join(archiveStore.base, '_ckpt.json')
const archiveCkpt = new Map()          // agentId → { [path]: ckpt }
try {
  const raw = JSON.parse(fs.readFileSync(ARCHIVE_CKPT_FILE, 'utf-8'))
  for (const [k, v] of Object.entries(raw)) archiveCkpt.set(k, v)
} catch { /* 首次运行 */ }
const saveArchiveCkpt = () => {
  try {
    const tmp = `${ARCHIVE_CKPT_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(archiveCkpt)))
    fs.renameSync(tmp, ARCHIVE_CKPT_FILE)     // 原子替换，避免半截 checkpoint
  } catch (e) { console.warn('[archive] checkpoint 落盘失败:', e?.message ?? e) }
}
const archiveStats = {
  rounds: 0, lines: 0, frames: 0, blocked: 0, lastOkTs: 0, lastError: null, byHost: {},
}

async function archiveRound() {
  if (!archiveEnabled()) return
  for (const a of agents) {
    const client = {
      inventory: async () => (await fetchJson(`${a.url}/api/archive/inventory`, 30000))?.files ?? [],
      read: async (p, from, len) => (await fetchJson(
        `${a.url}/api/archive/read?path=${encodeURIComponent(p)}&from=${from}&len=${len}`, 30000))?.text ?? '',
    }
    const ckpt = archiveCkpt.get(a.id) ?? {}
    let r
    try { r = await pullOnce({ host: a.id, client, store: archiveStore, ckpt }) }
    catch (e) { r = { blocked: true, error: String(e?.message ?? e), lines: 0, frames: 0 } }
    archiveCkpt.set(a.id, ckpt)
    saveArchiveCkpt()
    archiveStats.rounds += 1
    archiveStats.lines += r.lines ?? 0
    archiveStats.frames += r.frames ?? 0
    if (r.blocked) { archiveStats.blocked += 1; archiveStats.lastError = r.error ?? null }
    else archiveStats.lastOkTs = Date.now()
    archiveStats.byHost[a.id] = { lines: r.lines ?? 0, blocked: !!r.blocked, at: Date.now() }
  }
}
setInterval(() => { void archiveRound().catch((e) => console.warn('[archive] 轮次失败:', e?.message ?? e)) }, ARCHIVE_INTERVAL_MS)

// ── 抽取索引（P1）：从归档原文重建可查视图 ────────────────────────────────
// ★ 抽取是**派生数据**（design D6）：schema 变了就重跑，不回源机器。
//   所以这里可以放心地整份重建——真正不可逆的只有 P0 的原文归档。
// 索引常驻内存（~4,700 个会话的轻量视图，几 MB），落盘一份供重启后秒起。
const ARCHIVE_INDEX_FILE = path.join(archiveStore.base, '_index.json')
let archiveIndex = []
let archiveIndexAt = 0
let archiveIndexing = false

try {
  const raw = JSON.parse(fs.readFileSync(ARCHIVE_INDEX_FILE, 'utf-8'))
  archiveIndex = raw.docs ?? []
  archiveIndexAt = raw.at ?? 0
} catch { /* 首次运行：等第一次 rebuild */ }

/** 每抽多少条让出一次事件循环。 */
const YIELD_EVERY = Number(process.env.WA_ARCHIVE_YIELD_EVERY) || 10
/**
 * 重建的占空比：干 X 毫秒就歇 X 毫秒（0.5 = 只占半个核）。
 *
 * ⚠️⚠️ **归因更正（2026-09-05，我自己的错，别照着上一版结论去排查）**：
 *   提交 `5b29f0e` 的标题写「索引重建把 hub 卡住导致『与服务器失联』」——**那是错的**。
 *   用户当时报的失联，真因是 **`web-agents-tunnel-srv-169-69.service` 根本不存在**
 *   （一条手工起的 ssh 早就死了），hub 每次 `/api/state` 都要干等那台 8s 的 per-agent 超时。
 *   隧道恢复后 `/api/state` 立刻回到 0.12~0.19s。
 *   ★ 我在没有量之前就**连着三轮优化自己刚写的代码**（22.2→8.45→8.15→8.08s，一次都没进 2s），
 *     因为我默认"最近的改动最可疑"。**"我刚改过这里"不是证据，是偏见。**
 *   下面那三条限速实测数字**依然为真**（22.2s 同步阻塞确实会越过前端 20s 超时），限速也确实该做，
 *   但它**不是那次事故的原因**。排「失联」先量链路分段，别先怀疑归档。
 *
 * ★★ 为什么光"让出事件循环"不够（2026-08-31 三次实测）：
 *   ① 纯同步：全量重建阻塞 **22.2s** ⇒ 会越过前端 20s 超时（真实风险，非本次事故成因）
 *   ② 每 50 条让出一次：最坏仍 **8.45s** —— 瓶颈在**单条**的读+解析，不是循环次数
 *   ③ 改异步读 + 每条让出：最坏 8.15s，而且**中位涨到 6.46s**
 *      ⇒ 真相是**整段 CPU 被吃满**：.189.4 只有 2 核，解析 7,619 个会话是 CPU 密集的，
 *        让出只是把请求排到下一拍，排的还是同一个饱和的队列。
 *   ⇒ **必须限速，不是让出。** 与向量回填那边同一条纪律：后台任务慢一点无所谓，
 *     而 `/api/state` 是用户每 3 秒都在等的东西。
 */
const REBUILD_DUTY = Number(process.env.WA_ARCHIVE_REBUILD_DUTY) || 0.35

async function rebuildArchiveIndex({ force = false } = {}) {
  if (archiveIndexing) return { skipped: true }     // 上一轮没跑完就丢本轮，别自我碾压
  archiveIndexing = true
  const t0 = Date.now()
  let reused = 0, rebuilt = 0
  try {
    // ★ 按 mtime 增量重建（2026-08-29 实测修正）：初版只取首尾各 200 行，
    //   结果 **commands 只有 2%、files 只有 1%** —— 工具调用几乎都在会话中段，
    //   而"哪个项目跑过这条命令""谁改过这个文件"正是最高频的真实查询。
    //   窗口式抽取把检索最有用的两个维度直接砍没了，**而单测全绿**（夹具很短，没有中段）。
    //   现在整份抽取，靠 mtime 跳过没变的分片把成本压住。
    const prev = new Map(archiveIndex.map((d) => [`${d.host}/${d.project}/${d.session}`, d]))
    const docs = []
    let chunkAt = Date.now()
    for (const m of archiveStore.manifest()) {
      const id = `${m.host}/${m.project}/${m.session}`
      const f = shardFile(m)
      let st
      try { st = fs.statSync(f) } catch { continue }
      const cached = prev.get(id)
      // ⚠️ force=true 时必须忽略 mtime 缓存：**抽取规则变了而分片没变**时（比如
      //    2026-08-31 把正文截断上限从 300 提到 1200），按 mtime 增量会把旧文档原样复用，
      //    新规则一条都应用不上 —— 而接口还会报「rebuilt 512 / reused 5571」看着挺正常。
      if (!force && cached && cached._mtime === st.mtimeMs) { docs.push(cached); reused += 1; continue }
      let text
      // ⚠️ **必须用异步读**：单会话可达 74 MB，`readFileSync` 会把事件循环整个占住。
      //   实测每 50 条让出一次仍有 8.45s 阻塞——因为瓶颈在**单条**的同步读+解析，
      //   不是循环次数。异步读把 I/O 挪到线程池，主线程只承担解析。
      try { text = await fs.promises.readFile(f, 'utf-8') } catch { continue }
      // 单会话可达 74 MB —— 行数封顶，保证最坏情况可控
      const lines = text.split('\n').filter(Boolean).slice(0, 40_000)
      const d = extractSession({ engine: m.engine, host: m.host, project: m.project, session: m.session, lines })
      d._mtime = st.mtimeMs
      docs.push(d)
      rebuilt += 1
      // ★★ 每抽 N 条**让出一次事件循环**（2026-08-31 实测定位）：
      //   重建原本是纯同步的，实测阻塞时长 == 重建耗时——增量 2.18s、
      //   **全量 22.2s，直接越过前端 20s 超时 ⇒ abort ⇒ 「与服务器失联」**。
      //   用户 12:55~12:58 那 9 次 499 就是这么来的，是我引入的回归。
      //   ⚠️ 让出的代价是重建总时长略增，但**它是后台任务，慢一点无所谓；
      //     而 /api/state 是用户每 3 秒都在等的东西，一秒都不能被它挡住。**
      if (rebuilt % YIELD_EVERY === 0) {
        // 干了多久就歇多久（按占空比）——把 CPU 让给正在等 /api/state 的用户。
        // ⚠️ **绝不能给这个 sleep 封顶**（我第一版写了 `Math.min(nap, 200)`，是个自造 bug）：
        //   一个 chunk 可能跑 2 秒，封在 200ms ⇒ 实际占空比 91%，limit 形同虚设。
        //   实测三轮都卡在 8s 就是因为它。**限速的 sleep 必须与实际耗时成比例，不能设上限。**
        const spent = Date.now() - chunkAt
        const nap = Math.max(1, Math.round(spent * (1 - REBUILD_DUTY) / REBUILD_DUTY))
        await new Promise((r) => setTimeout(r, nap))
        chunkAt = Date.now()
      }
    }
    archiveIndex = docs
    archiveIndexAt = Date.now()
    // ⚠️ 落盘本身也是同步大块：index 已达 38.5 MB，`JSON.stringify` + `writeFileSync`
    //    会再卡住事件循环。先让出一拍，让排队的请求先走。
    await new Promise((r) => setImmediate(r))
    try { fs.writeFileSync(ARCHIVE_INDEX_FILE, JSON.stringify({ at: archiveIndexAt, docs })) } catch { /* 落盘失败不影响内存索引 */ }
  } finally { archiveIndexing = false }
  return { docs: archiveIndex.length, rebuilt, reused, tookMs: Date.now() - t0 }
}

const shardFile = (m) => path.join(archiveStore.base,
  String(m.host).replace(/[^A-Za-z0-9._-]/g, '_'),
  String(m.project).replace(/[^A-Za-z0-9._-]/g, '_'),
  String(m.session).replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl')

let progressAliasCache = new Map(), progressAliasSize = -1
const progressProjectAlias = p => {
  if (progressAliasSize !== idToMeta.size) { progressAliasCache = new Map(); progressAliasSize = idToMeta.size }
  if (progressAliasCache.has(p)) return progressAliasCache.get(p)
  const norm = v => String(v).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^data/, '')
  const matches = [...new Set([...idToMeta.values()].map(s => s.project).filter(Boolean))].filter(v => norm(p) === norm(v))
  const result = matches.length === 1 ? matches[0] : p
  progressAliasCache.set(p, result); return result
}
const progressBackfill = createProgressBackfill({
  repository: db.progressRepository,
  checkpointFile: path.join(archiveStore.base, '_progress-import.json'),
  listSources: () => {
    return archiveStore.manifest().sort((a,b) => b.lastAt-a.lastAt).map(m => {
      return { key: `${m.host}/${m.project}/${m.session}`, file: shardFile(m), serverId: m.host,
        project: progressProjectAlias(m.project), archiveProject: m.project,
        sessionId: m.session, engine: m.engine, lines: m.lines }
    })
  },
})
let nativeProgressSources = [], nativeProgressSourcesAt = 0, nativeProgressUnavailable = []
const nativeProgressBackfill = createProgressBackfill({
  repository: db.progressRepository, checkpointFile: path.join(archiveStore.base, '_progress-native-import.json'),
  listSources: async () => {
    if (Date.now() - nativeProgressSourcesAt < 60000) return { sources: nativeProgressSources, unavailableSources: nativeProgressUnavailable }
    const state = await buildState(), files = [], unavailable = []
    await Promise.all(agents.map(async a => {
      try {
      const inventory = await fetchJson(`${a.url}/api/archive/inventory`, 15000)
      for (const s of state.sessions.filter(s => s.serverId === a.id && s.cwd && path.isAbsolute(s.cwd))) {
        const native = (s.realSessionId || s.id).replace(/^session_/, '')
        const f = (inventory.files || []).find(f => f.engine === s.engine && f.path?.includes(native))
        if (f) files.push({ key: `${a.id}/${f.path}`, file: f.path, agentUrl: a.url, serverId: a.id, project: s.project, sessionId: s.id, engine: s.engine, size: f.st.size, lines: f.st.size })
      }
      } catch { unavailable.push(a.id) }
    }))
    nativeProgressSources = [...new Map(files.sort((a,b) => a.size-b.size).map(f => [f.key, f])).values()]
    nativeProgressSourcesAt = Date.now(); nativeProgressUnavailable = unavailable
    return { sources: nativeProgressSources, unavailableSources: unavailable }
  },
  readSource: async (s, from, len) => (await fetchJson(`${s.agentUrl}/api/archive/read?${new URLSearchParams({ path: s.file, from: String(from), len: String(len) })}`, 15000)).text || '',
})
const progressAssistant = createProgressAssistant({
  file: path.join(archiveStore.base, '_project-progress.json'), agents, retiredAgents:hubConfig.retiredAgents || [],
  getState: () => buildState(), fetchJson,
  repository: db.progressRepository, backfill: progressBackfill, nativeBackfill: nativeProgressBackfill,
  searchArchives: options => archivedProgress(archiveIndex, options, progressProjectAlias),
  model: createProgressModel(), tunnelProbe: createTunnelProbe(),
  archiveStatus: () => ({ enabled: archiveEnabled(), indexedAt: archiveIndexAt }),
})
// Derived evidence is refreshed even when the page is closed. This bounded job
// reuses the read-only corpus routes and never starts or resumes a project CLI.
setTimeout(() => { void progressAssistant.refresh() }, 30000).unref()
setInterval(() => { void progressAssistant.refresh() }, 5 * 60000).unref()
setTimeout(() => { void progressBackfill.run() }, 12000).unref()
setInterval(() => { void progressBackfill.run() }, 15000).unref()
setTimeout(() => { void nativeProgressBackfill.run() }, 20000).unref()
setInterval(() => { void nativeProgressBackfill.run() }, 15000).unref()

// 每 10 分钟重建一次；采集是持续的，索引稍滞后可接受（GOAL A 表要求 p95 ≤ 15 min）
setInterval(() => { void rebuildArchiveIndex().catch(() => {}) }, 10 * 60_000)
setTimeout(() => { void rebuildArchiveIndex().catch(() => {}) }, 15_000)

// ── 语义索引回填（P2）────────────────────────────────────────────────────────
// ★★ 这一段最要紧的不是"能不能建索引"，而是**不能把公网入口打挂**：
//   embedding 跑在 62.234（**2 核，同时是公网入口**），2026-08-29 实测全速跑时
//   网关 load 冲到 2.50~2.79、/api/state 由 0.15s 劣化到 2.28s（15×）——
//   正是「跨境 TLS 握手超时 ⇒ 504 ⇒ 与服务器失联」的成因。所以：
//   串行 + batch=8 + 50% 占空比 + **每批前查网关 load，破线立刻暂停**（不是记日志继续跑）。
// 开关：WA_VEC=0 关闭（只有显式 "0" 才关）。
const vecEnabled = () => process.env.WA_VEC !== '0'
const EMBED_URL = process.env.WA_EMBED_URL || 'http://127.0.0.1:8500'
const QDRANT_URL = process.env.WA_QDRANT_URL || hubConfig.integrations?.qdrantUrl || 'http://127.0.0.1:6333'
const QDRANT_COLL = process.env.WA_QDRANT_COLLECTION || 'web_agents_runs'
const VEC_STATE_FILE = path.join(archiveStore.base, '_vec.json')

const vecStats = {
  indexed: 0, batches: 0, paused: 0, errors: 0, lastMs: 0, baselineMs: 0,
  lastPauseReason: null, lastOkTs: 0, running: false, collectionReady: false,
}
let vecDone = new Set()
try { vecDone = new Set(JSON.parse(fs.readFileSync(VEC_STATE_FILE, 'utf-8')).done ?? []) } catch { /* 首跑 */ }
const saveVecState = () => {
  try {
    const tmp = `${VEC_STATE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ done: [...vecDone] }))
    fs.renameSync(tmp, VEC_STATE_FILE)
  } catch { /* 落盘失败不致命：大不了重算，点 id 由坐标定、不会重复 */ }
}

async function ensureCollection() {
  if (vecStats.collectionReady) return true
  try {
    const got = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLL}`, { signal: AbortSignal.timeout(8000) })
    if (got.ok) { vecStats.collectionReady = true; return true }
    // ⚠️ 只新建**自己的** collection，绝不碰 insight_items* / kb_docs（spec 硬约束）
    const mk = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLL}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: VECTOR_DIM, distance: 'Cosine' } }),
      signal: AbortSignal.timeout(15000),
    })
    vecStats.collectionReady = mk.ok
    if (mk.ok) console.warn(`[vec] 已创建 collection ${QDRANT_COLL}（${VECTOR_DIM} 维 Cosine）`)
    return mk.ok
  } catch (e) { console.warn('[vec] collection 检查失败:', e?.message ?? e); return false }
}

async function embed(texts) {
  const tok = process.env.BGE_AUTH_TOKEN
  const r = await fetch(`${EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`)
  return (await r.json()).vectors
}

async function upsert(points) {
  const r = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLL}/points?wait=true`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }), signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) throw new Error(`qdrant HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
}

/** 跑一轮回填。**每批前查负载，破线立刻收工**（下一轮再来，不丢进度）。 */
async function vecRound({ maxBatches = 20 } = {}) {
  if (!vecEnabled() || vecStats.running) return { skipped: true }
  vecStats.running = true
  try {
    if (!(await ensureCollection())) return { error: 'collection 未就绪' }
    const pending = archiveIndex
      .filter((d) => !vecDone.has(`${d.host}/${d.project}/${d.session}`))
      .slice(0, maxBatches * BATCH)
    if (!pending.length) return { done: true, indexed: vecStats.indexed }

    const duty = Number(process.env.WA_VEC_DUTY) || DUTY
    const factor = Number(process.env.WA_VEC_FACTOR) || 2.5
    for (const batch of planBatches(pending, BATCH)) {
      // ★ 拥塞判据用**批次耗时**，不读 load：实测 /health 只回 {status,model,device,modes}，
      //   没有负载字段；照「读不到就暂停」办会让回填**永远不跑**。耗时测的正是
      //   "这台 2 核机现在忙不忙"，而且自校准、换机器不用重配。
      const p = shouldPauseByLatency({ lastMs: vecStats.lastMs, baselineMs: vecStats.baselineMs, factor })
      if (p.pause) {
        vecStats.paused += 1; vecStats.lastPauseReason = p.reason
        console.warn(`[vec] 暂停回填：${p.reason}`)
        break                                   // ★ 破线即停，不是记个日志继续跑
      }
      const t0 = Date.now()
      try {
        const vectors = await embed(batch.map((d) => summarize(d)))
        await upsert(batch.map((d, i) => toPoint(d, vectors[i])))
        for (const d of batch) vecDone.add(`${d.host}/${d.project}/${d.session}`)
        saveVecState()
        vecStats.indexed += batch.length
        vecStats.batches += 1
        vecStats.lastOkTs = Date.now()
        vecStats.lastMs = Date.now() - t0
        // 基线取**最快的一批**：慢批可能正赶上别的任务，用它当基线会把闸门放宽
        if (!vecStats.baselineMs || vecStats.lastMs < vecStats.baselineMs) vecStats.baselineMs = vecStats.lastMs
      } catch (e) {
        vecStats.errors += 1
        console.warn('[vec] 批次失败:', e?.message ?? e)
        break                                   // 失败也收工，下轮重来（点 id 由坐标定，可重入）
      }
      const nap = sleepFor(Date.now() - t0, duty)
      if (nap) await new Promise((r) => setTimeout(r, nap))
    }
    return { indexed: vecStats.indexed, pending: pending.length }
  } finally { vecStats.running = false }
}

setInterval(() => { void vecRound().catch((e) => console.warn('[vec] 轮次异常:', e?.message ?? e)) }, 5 * 60_000)
setTimeout(() => { void vecRound().catch(() => {}) }, 45_000)

// 把下行线协议指标注入告警模块（alerts.js 不能 import hub.js —— 会成环）。
alerts.setStateWireSource(stateWireSnapshot)

// 数据层看门狗（P4 5.2）：60s 一轮，只在**跳变**时推 Web Push（进入告警/恢复各一次）。
// 持续告警不重复刷屏——否则用户会关掉推送，真出事时一条都送不到。
setInterval(() => {
  const health = {}
  for (const [id, v] of lastAgentState) health[id] = { lastOkTs: v.ts, load: v.load, cores: v.cores }
  void alerts.tick(health)
}, 60_000)

// 启动时幂等建索引（flag 关着时是 no-op）。没索引 = 全集合扫描，必须先建。
void mongo.ensureIndexes().then((ok) => {
  if (ok) console.warn('[mongo] 索引已就绪')
})

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  // gzip：跨境链路上这是最大的一笔。/api/state 实测 79KB→24KB（省 69%），25KB/s 的链路上
  // 单次 3.10s→0.98s，而前端 3s 轮一次——不压的话链路按定义就是饱和的。
  // res._gzip 在请求入口按 Accept-Encoding 算好（见 createServer），这样 json() 不必改签名，
  // 几十处调用点一行都不用动。
  if (res._gzip && shouldCompress(buf.length)) {
    zlib.gzip(buf, { level: 6 }, (err, out) => {
      if (err) { // 压缩失败绝不能把响应弄丢——退回明文，照常发
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(buf)
      }
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding', // 别让中间缓存把压缩体喂给不支持的客户端
      })
      res.end(out)
    })
    return
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(buf)
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

// ---------- 会话归档到知识库（KB library 25） ----------
// 复用 /data/claude_manager/.env 的 KB 凭据（仅 .232 hub 机有）；state 记 项目→folderId、会话→docId（幂等）。
const KB_LIBRARY = 25
const KB_ENV = process.env.WA_KB_ENV || hubConfig.integrations?.kbEnv || ''
const KB_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.kb-archive-state.json')
function kbConfig() {
  try {
    const txt = fs.readFileSync(KB_ENV, 'utf8')
    const get = (k) => (txt.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '')
    return { base: get('KB_BASE_URL'), token: get('KB_TOKEN') }
  } catch { return { base: process.env.WA_KB_BASE_URL || '', token: process.env.WA_KB_TOKEN || '' } }
}
function kbState() { try { return JSON.parse(fs.readFileSync(KB_STATE, 'utf8')) } catch { return { library_id: KB_LIBRARY, folders: {}, docs: {} } } }
function saveKbState(s) { try { fs.writeFileSync(KB_STATE, JSON.stringify(s, null, 2)) } catch { /* ignore */ } }
async function kbApi(method, p, body) {
  const { base, token } = kbConfig()
  if (!base || !token) throw new Error('知识库未配置；请设置WA_KB_BASE_URL/WA_KB_TOKEN或WA_KB_ENV')
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`KB ${method} ${p} → ${r.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

// 把一张 base64 图片经 doc_center 分片上传接口（init→chunk→complete，sha256 去重）传进 KB，返回其 sha256。
// 图片有免认证公网路由 /api/public/images/{sha256}，正文引用它即可、doc 本身不再内嵌臃肿的 base64。
async function kbUploadImage(base64, mime, filename) {
  const { base, token } = kbConfig()
  const buf = Buffer.from(base64, 'base64')
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  const init = await kbApi('POST', '/api/uploads/init', { filename: filename || `img.${(mime.split('/')[1] || 'png')}`, size: buf.length, mime, library_id: KB_LIBRARY })
  const up = init.upload_id
  const cr = await fetch(`${base}/api/uploads/${up}/chunk?offset=0`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: buf,
  })
  if (!cr.ok) throw new Error(`KB chunk → ${cr.status}`)
  await kbApi('POST', `/api/uploads/${up}/complete`, { sha256: sha })
  return sha
}

// 归档 markdown 里内联的 base64 图片 → 上传到 KB → 替换成公网图片链接（doc 不再巨大，且 sha256 去重）。
// 上传失败的那张保留原 base64（至少图片不丢）。
async function inlineImagesToKb(markdown) {
  if (!markdown || !markdown.includes('](data:image/')) return markdown
  const re = /!\[([^\]]*)\]\(data:(image\/[a-zA-Z.+-]+);base64,([A-Za-z0-9+/=]+)\)/g
  const uniq = new Map() // b64 -> sha（同图去重，一次归档只传一次）
  const found = []
  let m
  while ((m = re.exec(markdown))) found.push({ full: m[0], name: m[1], mime: m[2], b64: m[3] })
  let out = markdown
  for (const f of found) {
    try {
      let sha = uniq.get(f.b64)
      if (!sha) { sha = await kbUploadImage(f.b64, f.mime, f.name); uniq.set(f.b64, sha) }
      out = out.split(f.full).join(`![${f.name}](/api/public/images/${sha})`)
    } catch { /* 保留原 base64 */ }
  }
  return out
}

async function archiveToKb(id, sigArg) {
  let agentUrl = idToAgent.get(id)
  if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(id) }
  if (!agentUrl) throw Object.assign(new Error('session not found'), { status: 404 })
  // 取归档负载（含 haiku 精炼，较慢）
  const payload = await fetchJson(`${agentUrl}/api/session/${id}/archive-payload`, 120000)
  const sig = sigArg != null ? sigArg : (payload?.at || Date.now()) // 内容签名:变了才重归档
  const st = kbState()
  const prev = typeof st.docs[id] === 'number' ? { docId: st.docs[id] } : (st.docs[id] || {})
  // 空会话:不写 KB,记签名避免自动归档反复重试
  if (payload?.empty) {
    st.docs[id] = { ...prev, empty: true, sig }
    saveKbState(st)
    return { ok: true, skipped: 'empty' }
  }
  // 0) 内联 base64 截图 → 上传到 KB 换成公网图片链接（避免 doc 巨大；上传失败保留 base64）
  payload.markdown = await inlineImagesToKb(payload.markdown)
  // 1) 项目文件夹（不存在则建）
  let folderId = st.folders[payload.project]
  if (!folderId) {
    const f = await kbApi('POST', '/api/docs', { library_id: KB_LIBRARY, title: payload.project, type: 'folder' })
    folderId = f.id
    st.folders[payload.project] = folderId
  }
  // 2) upsert 文档（幂等）；sort 取负秒数 → 最新会话排最前（倒序）
  const sort = -Math.floor((payload.at || Date.now()) / 1000)
  let docId = prev.docId
  if (docId) {
    await kbApi('PUT', `/api/docs/${docId}`, { title: payload.title, markdown: payload.markdown, sort })
  } else {
    const d = await kbApi('POST', '/api/docs', { library_id: KB_LIBRARY, parent_id: folderId, title: payload.title, markdown: payload.markdown, sort })
    docId = d.id
  }
  st.docs[id] = { docId, sig }
  saveKbState(st)
  return { ok: true, docId, folderId, project: payload.project, title: payload.title, url: `${kbConfig().base}/libraries/${KB_LIBRARY}` }
}

// ---------- KB 自动归档（落定即归档 · 全量 · 签名去重 · 限速）----------
// 会话进入 idle/done 且静默 > GRACE 即归档；签名(lastActiveAt)未变则跳过(不重复烧 haiku)；
// 每轮最多 BATCH 个(护 3.6G + haiku 成本)，初次会把历史会话分批慢慢沉淀进 KB。设 KB_AUTO_ARCHIVE=off 关闭。
const KB_AUTO = process.env.KB_AUTO_ARCHIVE !== 'off'
const KB_AUTO_GRACE = 10 * 60_000
const KB_AUTO_BATCH = 3
const KB_AUTO_INTERVAL = 60_000
let kbAutoBusy = false
async function kbAutoArchiveTick() {
  if (!KB_AUTO || kbAutoBusy) return
  if (!kbConfig().token) return // 未配置 KB 不跑
  kbAutoBusy = true
  try {
    const { sessions } = await buildState().catch(() => ({ sessions: [] }))
    const byId = new Map()
    for (const s of sessions || []) byId.set(s.id, s)
    const now = Date.now()
    const st = kbState()
    const cand = []
    for (const s of byId.values()) {
      if (!['idle', 'done'].includes(s.state)) continue          // 仅落定态
      if (now - (s.lastActiveAt || 0) < KB_AUTO_GRACE) continue   // 静默够久
      const rec = typeof st.docs[s.id] === 'number' ? { docId: st.docs[s.id] } : (st.docs[s.id] || {})
      if (rec.sig === s.lastActiveAt) continue                    // 签名未变→已归档,跳过
      cand.push(s)
    }
    cand.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0)) // 最近活跃优先
    let done = 0
    for (const s of cand.slice(0, KB_AUTO_BATCH)) {
      try { await archiveToKb(s.id, s.lastActiveAt); done++ } catch { /* 下轮重试 */ }
    }
    if (cand.length) console.log(`[kb-auto] tick: ${done}/${cand.length} 待归档已处理(剩 ${cand.length - done})`)
  } catch { /* 忽略,下轮再来 */ } finally { kbAutoBusy = false }
}
setInterval(() => { void kbAutoArchiveTick() }, KB_AUTO_INTERVAL)

const applyRuntimeConfig=next=>{
  const retired=hubConfig.retiredAgents;retired.splice(0,retired.length,...next.retiredAgents)
  Object.assign(hubConfig,next,{retiredAgents:retired});agents.splice(0,agents.length,...next.agents.filter(a=>a.enabled!==false))
  LOCAL_AGENT=(agents.find(a=>a.url?.includes(':8788'))??agents[0])?.url
  configureQuotaSources(next.quota);projectUsageScope.activeServerIds=agents.map(a=>a.id);projectUsageScope.retiredServers=retired
  serverToAgent.clear();for(const a of agents)serverToAgent.set(a.id,a.url)
  idToAgent.clear();actionToAgent.clear();idToMeta.clear()
  for(const id of lastAgentState.keys())if(!serverToAgent.has(id))lastAgentState.delete(id)
  USAGE_SERVER=process.env.WA_USAGE_SERVER||next.quota?.preferredSources?.claude||''
  KIMI_USAGE_SERVER=process.env.WA_KIMI_USAGE_SERVER||next.quota?.preferredSources?.kimi||''
  codexQuotaMemo=null;usageLimits=null;usageLastTry=0;kimiUsage=null;kimiUsageLastTry=0
}
const installationSettings=createInstallationSettings({store:configStore,onChange:applyRuntimeConfig,send:json,modelFile:process.env.WA_ASSISTANT_MODEL_CONFIG||'/etc/web-agents/assistant-model.json',notifications:notificationSettings,updateNotifications})
const serverManagement=createServerManagement({store:configStore,send:json,onChange:applyRuntimeConfig,probe:async node=>{
  const request=createAgentFetch(()=>[node]),start=Date.now()
  try{
    const r=await request(node.url+'/api/agent/info',{signal:AbortSignal.timeout(6000)})
    if(!r.ok) return{connected:false,status:r.status,error:r.status===401?'节点令牌无效或缺失':`节点返回HTTP ${r.status}`}
    return{connected:true,latencyMs:Date.now()-start,info:await r.json()}
  }catch{return{connected:false,error:'节点连接失败或超时；请检查地址、令牌、证书及网络连通性'}}
}})

const server = http.createServer(async (req, res) => {
  try {
    // 这一拍能不能压：只看客户端声明，SSE/终端 WS 走各自的出口、不经 json()，不受影响。
    res._gzip = acceptsGzip(req.headers['accept-encoding'])
    const url = new URL(req.url, 'http://localhost')
    if(url.pathname==='/api/health'){
      const ready=!process.env.WA_MYSQL_HOST||db.dbEnabled()
      return json(res,ready?200:503,{status:ready?'ok':'initializing',version:RELEASE_VERSION,releaseTag:`v${RELEASE_VERSION}`,authEnabled:operatorAuth.enabled})
    }
    if(await operatorAuth.handle(req,res))return
    if(url.pathname.startsWith('/api/')){
      const access=operatorAuth.authorize(req);if(!access.ok)return json(res,access.status,{error:access.error})
    }else if(serveWeb(req,res,process.env.WA_WEB_ROOT))return
    if(await serverManagement(req,res,url))return
    if(await installationSettings(req,res,url))return
    if (url.pathname === '/api/v2/health') {
      // WebAgents 2.0 健康检查：hub 恒 ok；redis/mongo P0 恒 disabled（flag=0）；mysql 复用现有就绪态。
      const [r, m] = await Promise.all([redis.health(), mongo.health()])
      return json(res, 200, {
        hub: 'ok',
        flags: flags.snapshot(),
        redis: r,
        mongo: m,
        mysql: { status: db.dbEnabled() ? 'ok' : 'disabled' },
        projection: projector.getStats(), // 投影进度 + spool 积压（spool>100MB 要告警）
        alerts: alerts.active(),          // 当前正在告警的项（看门狗，60s 一轮）
      })
    }
    // ---------- WebAgents 2.0 只读历史接口（读 Mongo；不可用一律返回 null 让前端回退 JSONL）----------
    // 铁律：这些接口 MUST NOT 修改会话状态；且 /api/state 永不查 Mongo（保住 P95）。
    {
      const m = /^\/api\/v2\/runs\/([\w-]+)\/timeline$/.exec(url.pathname)
      if (m) {
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 500))
        // before = 游标串（见 timeline-cursor.js）：给了就取比它更早的一页，支撑「加载更早」。
        const before = url.searchParams.get('before')
        const r = await eventRepo.timeline(m[1], limit, before)
        return json(res, 200, {
          available: r !== null,                   // false = Mongo 不可用 → 前端回退现有 JSONL 事件接口
          events: r?.events ?? [],
          // hasMore/oldest 是「把静默截断变成可见截断」的关键：没有它们，前端把残缺当全集，
          // 头部那句「N 个回合」会骗人（session-allocate.js 为同一类错误付过代价）。
          hasMore: r?.hasMore ?? false,
          oldest: r?.oldest ?? null,
          asOf: Date.now(),                        // 诚实标注：历史是异步投影，可能滞后
        })
      }
    }
    // 会话账本：跨 agent 重启/文件老化持久（JSONL 那套一重启/一老化就查无此人）
    if (url.pathname === '/api/v2/runs') {
      const runs = await runRepo.recentRuns({
        serverId: url.searchParams.get('server') || undefined,
        project: url.searchParams.get('project') || undefined,
        status: url.searchParams.get('status') || undefined,
        limit: Number(url.searchParams.get('limit')) || 50,
      })
      return json(res, 200, { available: runs !== null, runs: runs ?? [], asOf: Date.now() })
    }
    // agent 状态跳变时间线（上线/离线/重启）
    if (url.pathname === '/api/v2/agents') {
      const [events, summary] = await Promise.all([
        runRepo.agentStatus({ serverId: url.searchParams.get('server') || undefined, limit: Number(url.searchParams.get('limit')) || 100 }),
        runRepo.runsSummary(),
      ])
      return json(res, 200, { available: events !== null, events: events ?? [], summary, asOf: Date.now() })
    }
    // **agent 重启事件簿**——每条带「当时被 SIGKILL 波及的平台会话名单」。
    // 这是本项目最痛的一类事故（重启把正在跑的回合拦腰截断）此前唯一缺的东西：事后可复盘。
    if (url.pathname === '/api/v2/incidents/restarts') {
      // DELETE：清理事件簿。例行部署每次都产生一条「无会话受影响」，9 天攒 45 条，
      // 把真正有价值的那几条（波及了会话的）淹没。onlyEmpty 默认 true——**只清噪声**，
      // 真事故记录必须留着：那份被 SIGKILL 波及的会话名单事后再也拿不到。
      if (req.method === 'DELETE') {
        const onlyEmpty = url.searchParams.get('all') !== '1'
        const n = await runRepo.purgeRestartIncidents({ onlyEmpty })
        if (n === null) return json(res, 503, { ok: false, error: '历史库不可用，未执行清理' })
        return json(res, 200, { ok: true, deleted: n, onlyEmpty })
      }
      const items = await runRepo.restartIncidents({ limit: Number(url.searchParams.get('limit')) || 50 })
      return json(res, 200, { available: items !== null, incidents: items ?? [], asOf: Date.now() })
    }
    if (url.pathname === '/api/v2/events') {
      const q = {}
      const server = url.searchParams.get('server'); if (server) q.serverId = server
      const project = url.searchParams.get('project'); if (project) q.project = project
      const type = url.searchParams.get('type'); if (type) q.type = type
      // ?session= 按会话过滤。durable 记录（event-envelope.js normalizeEvent）按原生
      // realSessionId（uuid）存，不是控制台的平台会话 id（ps-xxxx）。调用方两种都可能传：
      // 先按 idToMeta 把 ps-* 解析成 realSessionId；查不到映射（老会话/尚未探测到）就原样
      // 当 realSessionId 用——调用方本来就可能直接传 uuid，绝不能因为「解析不出」就悄悄
      // 查一个必空的字段、把"查不到映射"伪装成"这个会话没有历史"。
      const sessionParam = url.searchParams.get('session')
      if (sessionParam) {
        let meta = idToMeta.get(sessionParam)
        if (!meta) { await buildState(); meta = idToMeta.get(sessionParam) }
        q.realSessionId = meta?.realSessionId || sessionParam
      }
      const from = Number(url.searchParams.get('from')); const to = Number(url.searchParams.get('to'))
      if (from || to) {
        q.occurredAt = {}
        if (from) q.occurredAt.$gte = new Date(from).toISOString()
        if (to) q.occurredAt.$lte = new Date(to).toISOString()
      }
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100)) // 硬上限，防一次拉爆
      const r = await eventRepo.recent(q, limit)
      return json(res, 200, { available: r !== null, events: r ?? [], asOf: Date.now() })
    }
    if (url.pathname === '/api/v2/stats') {
      // 数据层总览：给运维页「数据层」面板用（一眼看清 Redis/Mongo/投影/spool 是否健康）
      const [r, m, counts] = await Promise.all([redis.health(), mongo.health(), eventRepo.summary()])
      return json(res, 200, {
        redis: r, mongo: m,
        mysql: { status: db.dbEnabled() ? 'ok' : 'disabled' },
        flags: flags.snapshot(),
        projection: projector.getStats(),
        counts,                                    // { events, byType: [...] } 或 null（Mongo 不可用）
      })
    }
    if (url.pathname === '/api/state') {
      const state = await buildState()
      state.projectModels = projectModels
      // 告警兜底出口（2026-08-01 事故）：一次 Mongo 隧道中断持续 10 天没人发现——看门狗全程
      // 正确判定、日志里躺着 3658 条 `push fire mongo.down: sent=0`，但唯一通道 Web Push 的
      // 订阅者是 0，全推进了虚空（期间 spool 涨破 100MB 上限、丢了一半历史）。所以把告警挂到
      // 每 3s 都会拉的 /api/state 上，让【控制台界面本身】成为不依赖「有没有人记得订阅」的出口。
      // 常态是 firing:[]，多出来的字节可以忽略。
      state.alerts = alerts.snapshot()
      // BrightPath 契约：?activeDays=N 只返回近 N 天活跃的会话（servers/pendingActions 不过滤）
      const days = Number(url.searchParams.get('activeDays'))
      if (Number.isFinite(days) && days > 0) {
        const cutoff = Date.now() - days * 86_400_000
        // ★ 过滤视图不走增量：它的会话集与全量不同，共用版本环会算出错误的差异。
        return json(res, 200, { ...state, sessions: state.sessions.filter((s) => s.lastActiveAt >= cutoff) })
      }

      // ───── 增量下发 ─────
      // 顺序说明：会话在 **agent 侧**已经过 stateToWire() 裁剪（agent.js:38），hub 这里只做
      // `serverId` 改写；所以在此处算指纹 = 对最终线协议对象算，满足 spec 里
      // 「增量下发必须在线协议裁剪之后」那条。改动这段前先确认这个前提没变。
      const { version } = stateVersions.resolve(state.sessions)
      const cursorNow = makeCursor(HUB_BOOT_ID, version)
      const minVersion = stateVersions.minVersion()
      // 名额截断**不禁用**增量（2026-08-20 实测推翻了初稿的顾虑）：
      //   · 生产上 srv-178-232 长期 sessionsTruncated=True（隐藏 26 条），按初稿这个能力
      //     在生产上一次都不会生效——特性直接死在娘胎里。
      //   · 差异是在**可见集合**上算的，而可见集合正是客户端该看到的那份；截断边界移动时
      //     diffSessions 会如实报出 changed/removed，等价性不受影响。影子对照的 27 次
      //     零不一致比对全部是在 .232 已截断的状态下完成的。
      //   · 2026-07-21 invest_data 整个项目消失的真因是 **hub 把截断标志吞掉了**（前端把残缺
      //     当全集），与增量无关 ⇒ 正确的约束是「标志必须每帧透传」，见下面 frame 里的 servers。
      const cur = url.searchParams.get('cursor')
      const canDelta = deltaEnabled() &&
        cursorComparable(cur, { bootId: HUB_BOOT_ID, minVersion, curVersion: version })

      // 影子对照（阶段 B）：算 delta 但仍下发 snapshot，只记指标。
      // 跑满 ≥24h 且 mismatch 为 0 才允许进入真实下发——单测的随机序列证明不了生产语料的形态。
      let shadowOk = true
      if (stateShadow() && shadowPrev) {
        shadowOk = shadowVerify(stateVersions.fpsAt(shadowPrev.version) ?? new Map(), state.sessions)
      }
      if (!shadowPrev || shadowPrev.version !== version) {
        shadowPrev = { version, sessions: state.sessions.map((s) => ({ ...s })) }
      }

      const full = { ...state, frame: 'snapshot', cursor: cursorNow }
      if (canDelta && shadowOk && !stateShadow()) {
        const prev = stateVersions.fpsAt(parseCursor(cur).version)
        if (prev) {
          const d = diffSessions(prev, new Map(state.sessions.map((s) => [s.id, s])))
          // ★ servers / projectModels 几乎从不变，但它们是 delta 帧字节地板的大头
          //   （实测 3.8KB 地板里 servers 1.9KB + projectModels 1.3KB = 3.2KB）。
          //   不变就省略，客户端沿用本地值 —— 这是把中位数从 8.42% 压到 <2% 的关键一步。
          //   ⚠️ pendingActions 与 alerts **永远整份下发**：它们是"要用户立刻做事"的东西，
          //     省几百字节换一次"审批卡没出现"是极差的交易。
          const srvFp = sessionFingerprint(state.servers)
          const pmFp = sessionFingerprint(state.projectModels)
          const frame = {
            frame: 'delta', cursor: cursorNow,
            changed: d.changed, removed: d.removed,
            pendingActions: state.pendingActions, alerts: state.alerts,
          }
          if (srvFp !== prevAux.get(parseCursor(cur).version)?.srv) frame.servers = state.servers
          if (pmFp !== prevAux.get(parseCursor(cur).version)?.pm) frame.projectModels = state.projectModels
          prevAux.set(version, { srv: srvFp, pm: pmFp })
          while (prevAux.size > 64) prevAux.delete(prevAux.keys().next().value)
          stateWire.deltas += 1
          stateFrameWindow.record('delta')
          stateWire.fullBytes += Buffer.byteLength(JSON.stringify(full))
          stateWire.sentBytes += Buffer.byteLength(JSON.stringify(frame))
          return json(res, 200, frame)
        }
      }
      prevAux.set(version, { srv: sessionFingerprint(state.servers), pm: sessionFingerprint(state.projectModels) })
      stateWire.snapshots += 1
      stateFrameWindow.record('snapshot')
      const fullSize = Buffer.byteLength(JSON.stringify(full))
      stateWire.fullBytes += fullSize
      stateWire.sentBytes += fullSize
      return json(res, 200, full)
    }
    // 下行线协议指标：与 /api/metrics/ingest 同族——一个盯「还在全量重读磁盘吗」，
    // 一个盯「还在全量重传给前端吗」。两者失败模式相同：功能全对、只是慢、一条错不报。
    if (url.pathname === '/api/assistant/evidence' && req.method === 'GET') {
      const task = await progressAssistant.evidence(url.searchParams.get('id') || '')
      return task ? json(res, 200, { task }) : json(res, 404, { error: '任务证据未找到或已超出保留范围' })
    }
    if (url.pathname === '/api/assistant/progress' && req.method === 'GET') {
      return json(res, 200, await progressAssistant.query({ q: (url.searchParams.get('q') || '').slice(0, 500), questionId: (url.searchParams.get('questionId') || '').slice(0, 64), project: (url.searchParams.get('project') || '').slice(0, 255), host: url.searchParams.get('host') || '', days: Number(url.searchParams.get('days')) || 7 }))
    }
    if (url.pathname === '/api/assistant/refresh' && req.method === 'POST') {
      const body = await readBody(req)
      void progressAssistant.refresh({ project: String(body.project || '').slice(0, 255), host: String(body.host || '') })
      return json(res, 202, { ok: true, refreshing: true })
    }
    if (url.pathname === '/api/archive/vec-stats') {
      return json(res, 200, { ...vecStats, enabled: vecEnabled() ? 1 : 0, doneCount: vecDone.size, indexSize: archiveIndex.length, collection: QDRANT_COLL })
    }
    if (url.pathname === '/api/archive/vec-run') {
      return json(res, 200, await vecRound({ maxBatches: Math.min(Number(url.searchParams.get('batches')) || 5, 200) }))
    }
    // 归档检索（P1）：结构化过滤 + 关键词，**独立可用**，不依赖语义索引就位
    if (url.pathname === '/api/archive/search') {
      const p = url.searchParams
      const num = (k) => (p.get(k) ? Number(p.get(k)) : undefined)
      const r = searchSessions(archiveIndex, {
        q: p.get('q') ?? '', project: p.get('project') ?? '', host: p.get('host') ?? '',
        engine: p.get('engine') ?? '', cmd: p.get('cmd') ?? '', file: p.get('file') ?? '',
        from: num('from'), to: num('to'),
      }, { limit: Math.min(Number(p.get('limit')) || 30, 100) })
      return json(res, 200, { ...r, indexedAt: archiveIndexAt, indexSize: archiveIndex.length })
    }
    // 取一条归档会话的原文片段（溯源用）——**按需取，不进检索结果**
    if (url.pathname === '/api/archive/session') {
      const p = url.searchParams
      const m = archiveStore.manifest().find((x) =>
        x.host === p.get('host') && x.project === p.get('project') && x.session === p.get('session'))
      if (!m) return json(res, 404, { error: 'not found' })
      let lines = []
      try {
        lines = fs.readFileSync(shardFile(m), 'utf-8').split('\n').filter(Boolean)
      } catch { /* 分片丢了 */ }
      const limit = Math.min(Number(p.get('limit')) || 200, 1000)
      // ★★ 展开时必须给**匹配处的对话上下文**，不是会话开头（2026-08-31 用户实测）：
      //   原来返回 lines.slice(0, limit)，而那条会话 14,391 行、匹配在中后段
      //   ⇒ 用户看到的是开头 8 行 + 一堆 shell 命令，唯独没有他要的那个答案。
      const ctx = conversationAround(lines, { q: p.get('q') || '', engine: m.engine })
      return json(res, 200, {
        ...m,
        context: ctx,
        detail: extractSession({ engine: m.engine, host: m.host, project: m.project, session: m.session, lines: lines.slice(0, 400) }),
        total: lines.length,
        lines: lines.slice(0, limit),
      })
    }
    if (url.pathname === '/api/archive/reindex') {
      return json(res, 200, await rebuildArchiveIndex({ force: url.searchParams.get('force') === '1' }))
    }
    // 归档：状态 / 对账（对账是 P0 的验收线——**报差集，不只报总数**）
    if (url.pathname === '/api/archive/stats') {
      return json(res, 200, { ...archiveStats, enabled: archiveEnabled() ? 1 : 0, ...archiveStore.stats() })
    }
    if (url.pathname === '/api/archive/recon') {
      const source = []
      const unreachable = []
      for (const a of agents) {
        try {
          const inv = await fetchJson(`${a.url}/api/archive/inventory`, 30000)
          for (const f of inv?.files ?? []) {
            source.push({
              host: a.id, engine: f.engine, project: f.project, session: f.session,
              lines: Math.max(1, Math.round((f.st?.size ?? 0) / 900)),
            })
          }
        } catch (e) {
          // ⚠️ 某台不可达时**绝不能**当成"它没有会话"——那会把覆盖率算成虚高的绿，
          //    正是本仓库反复栽的「fail-safe 静默成永久豁免」那一类。
          //    如实记下来，并在下面把 coverage 置 null（"还不知道"），而不是给个好看的数字。
          unreachable.push({ host: a.id, error: String(e?.message ?? e) })
        }
      }
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
      const r = reconcile(source, archiveStore.manifest(), { limit })
      // 有机器没问到 ⇒ 覆盖率**不可知**，不是"达标"。宁可显示 null 也不给虚高的绿。
      return json(res, 200, { ...r, unreachable, coverage: unreachable.length ? null : r.coverage })
    }
    if (url.pathname === '/api/metrics/state-wire') {
      return json(res, 200, stateWireSnapshot())
    }
    // 总工待处理聚合（P0 可见性）：一次返回跨全部节点的 pendingActions，不用去翻 /api/state 自己拼。
    // 只读、不改 /api/state 契约——buildState() 本身不动，这里只是多包一层纯函数整理展示。
    // ?thresholdMin=N 配置超时阈值（默认 30），超过即标 overdue=true，让「挂了 N 小时没人管」一眼可见。
    // ?owner=<text> 按归属线索（首个 prompt 摘要/title/detail，启发式文本匹配）只看自己的；
    // ?since=<ms> 只看某时间点之后创建的待办——见 pending-digest.js 归属线索的注释（P0 #6）。
    if (url.pathname === '/api/pending') {
      const state = await buildState()
      const thresholdMin = Number(url.searchParams.get('thresholdMin'))
      const owner = url.searchParams.get('owner') || undefined
      const since = Number(url.searchParams.get('since'))
      return json(res, 200, buildPendingDigest(state, { thresholdMin, owner, since }))
    }
    // 今日复盘：聚合当天会话（GET 只读，不触发 LLM）
    if (url.pathname === '/api/review') {
      return json(res, 200, await buildReview(url.searchParams.get('date') || ''))
    }
    if (url.pathname === '/api/projects') {
      const sid = url.searchParams.get('server') ?? ''
      const agentUrl = serverToAgent.get(sid)
      if (!agentUrl) return json(res, 404, { error: 'server not found' })
      // 新建会话的下拉是**另一条链路**（agent 的 listProjects()），也要带上隐藏名单，
      // 否则项目从看板消失了、新建会话时却还能选到它。
      const hq = hiddenForServer(hiddenCache, sid).map(encodeURIComponent).join(',')
      return json(res, 200, await fetchJson(`${agentUrl}/api/projects?hidden=${hq}`))
    }
    // 终端会话管理：按 server 转发到对应 agent（列出可复用的 tmux 终端会话）
    if (url.pathname === '/api/term/list') {
      const agentUrl = serverToAgent.get(url.searchParams.get('server') ?? '')
      if (!agentUrl) return json(res, 404, { error: 'server not found' })
      // 该机 agent 不可达/超时 → 干净返回空列表，别抛 500（前端 picker 显示"暂无会话"即可）
      try { return json(res, 200, await fetchJson(`${agentUrl}/api/term/list`, 10000)) }
      catch { return json(res, 200, { sessions: [] }) }
    }
    if (url.pathname === '/api/categories' && req.method !== 'POST') {
      return json(res, 200, await loadCategories())
    }
    if (url.pathname === '/api/categories' && req.method === 'POST') {
      return json(res, 200, await saveCategories(await readBody(req)))
    }
    if (url.pathname === '/api/server-tags' && req.method !== 'POST') {
      return json(res, 200, await loadServerTags())
    }
    if (url.pathname === '/api/server-tags' && req.method === 'POST') {
      return json(res, 200, await saveServerTags(await readBody(req)))
    }

    if (url.pathname === '/api/hidden-projects') {
      if (req.method === 'POST') {
        const body = await readBody(req)
        return json(res, 200, { hidden: await saveHidden(body?.hidden) })
      }
      return json(res, 200, { hidden: hiddenCache })
    }
    if (url.pathname === '/api/push/pubkey') {
      return json(res, 200, { key: push.publicKey, subscribers: push.subscriberCount() })
    }
    if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
      const body = await readBody(req)
      return push.subscribe(body)
        ? json(res, 200, { ok: true, subscribers: push.subscriberCount() })
        : json(res, 400, { error: 'invalid subscription' })
    }
    if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
      const body = await readBody(req)
      push.unsubscribe(body.endpoint)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/push/test') {
      const sent = await push.broadcast({ title: '测试通知', body: 'Agent 管控台推送链路正常 ✅', url: '/' })
      return json(res, 200, { ok: true, sent })
    }

    if (url.pathname === '/api/usage/limits') {
      // ★ 不再同步等探测（2026-09-11）：`claude --print /usage` 实测 5.18s，
      //   那 5 秒里请求**占着一条跨境 HTTP 连接**，而本仓库栽过「请求堆叠打满 keepalive 池」。
      //   现在立刻返回手头有的，后台去刷；没有旧值时出口标 pending，前端据此快速补拉。
      if (!usageLimits) void refreshUsageLimits().catch(() => {}) // 有 USAGE_RETRY_MS 冷却兜底
      return json(res, 200, usagePayload())
    }
    // Kimi 订阅额度（与 Claude 同构：5h 窗 + 周窗 + resets），单独一条路由：
    // 它的探测要起 tmux+TUI 约 20s，不能拖在 /api/usage/limits 的同步路径上。
    if (url.pathname === '/api/usage/kimi-limits') {
      // 同 Claude：不同步等。Kimi 更狠——它要起 tmux 跑 TUI 抓屏，注释里写着**约 20s**。
      if (!kimiUsage) void refreshKimiUsage().catch(() => {})
      return json(res, 200, kimiUsagePayload())
    }
    if (url.pathname === '/api/usage/daily') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14))
      return json(res, 200, await computeMergedDaily(days)) // { days:[{date,tokens,cost,tok,costc}], last5h, last7d }
    }
    if (url.pathname === '/api/usage/limits-history') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14))
      return json(res, 200, { days: await db.readUsageLimitsDaily(days) })
    }
    if (url.pathname === '/api/usage/limits-trend') {
      const days = Number(url.searchParams.get('days')) || 14
      return json(res, 200, { points: await db.readUsageLimitsTrend(days, 3) })
    }
    if (url.pathname === '/api/usage/projects-daily') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 1))
      const [rows, series] = await Promise.all([db.readProjectsDaily(days, projectUsageScope), db.readActiveDailySeries(days, projectUsageScope)])
      return json(res, 200, { rows, series }) // series: 每日活跃总时长（AI 工作量迷你柱）；rows 形状不变，向后兼容
    }
    if (url.pathname === '/api/usage/today-hourly') {
      // 今日按时段(小时)消耗：跨服务器按小时求和
      const tok = {}, cost = {}
      await Promise.all(agents.map(async (a) => {
        try {
          const r = await fetchJson(`${a.url}/api/usage/today-hourly`, 20000)
          for (const h of r.hours ?? []) { tok[h.hour] = (tok[h.hour] ?? 0) + (h.tokens || 0); cost[h.hour] = (cost[h.hour] ?? 0) + (h.cost || 0) }
        } catch { /* 单 agent 失败忽略 */ }
      }))
      const hours = []
      for (let h = 0; h <= 23; h++) { const k = String(h).padStart(2, '0'); hours.push({ hour: k, tokens: tok[k] ?? 0, cost: Math.round((cost[k] ?? 0) * 100) / 100 }) }
      return json(res, 200, { hours })
    }
    if (url.pathname === '/api/usage/codex-limits') {
      return json(res, 200, { accounts: await refreshCodexLimits() })
    }
    if (url.pathname === '/api/usage/quota-trend') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 30))
      return json(res, 200, { available: db.dbEnabled(), series: await db.readQuotaTrend(days, { includeHistory: url.searchParams.get('history') === '1' }) })
    }
    if (url.pathname === '/api/usage/codex-models') {
      // ⚠️ 模型列表**按服务器**取，不能全局合并：各机 codex 版本不同、模型集不同（实测 232 有
      // gpt-5.6-sol，177-188 只到 gpt-5.3-codex）。会话跑在哪台就问哪台，否则下拉给出目标机没有的
      // 模型、切了必失败。带 ?server=<id> 定向；缺省才回退到第一个非空（新建页尚未选机时）。
      const wantSrv = url.searchParams.get('server')
      const target = wantSrv ? agents.find((a) => a.id === wantSrv) : null
      if (target) {
        const r = await fetchJson(`${target.url}/api/usage/codex-models`, 15000).catch(() => null)
        return json(res, 200, { models: r?.models ?? [], server: wantSrv })
      }
      const rs = await Promise.all(agents.map((a) => fetchJson(`${a.url}/api/usage/codex-models`, 15000).catch(() => null)))
      const models = rs.map((r) => r?.models).find((m) => Array.isArray(m) && m.length) ?? []
      return json(res, 200, { models })
    }
    if (url.pathname === '/api/usage/history') {
      // 长期每日历史(MySQL，可超 60 天 JSONL 窗口)；DB 不可用则回退实时聚合
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 30))
      const rows = db.dbEnabled() ? await db.readDailyHistory(days) : (await computeMergedDaily(Math.min(60, days))).days
      return json(res, 200, { days: rows, source: db.dbEnabled() ? 'mysql' : 'live' })
    }

    // 「会话历史」冷路径转发。**必须按 ?server= 定向**：项目名在不同服务器上可以重名（同一个
    // repo 铺在多台机上是常态），全局合并会把 A 机的会话混进 B 机的历史里，点开必然 404——
    // 会话 id → agent 的路由表只认发出它的那台。缺 server 参数就是调用方的 bug，直接 400，
    // 不要"猜一台"回退（猜错的表现是历史里混进别人的会话，比报错难查得多）。
    if (url.pathname === '/api/project/sessions') {
      const project = (url.searchParams.get('project') ?? '').trim()
      const wantSrv = url.searchParams.get('server')
      if (!project || !wantSrv) return json(res, 400, { error: 'project 与 server 均必填' })
      const target = agents.find((a) => a.id === wantSrv)
      if (!target) return json(res, 404, { error: `未知服务器 ${wantSrv}` })
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 8)) // 默认 8：与前端 PROJECT_HISTORY_LIMIT 一致
      const qs = `project=${encodeURIComponent(project)}&limit=${limit}`
      const r = await fetchJson(`${target.url}/api/project/sessions?${qs}`, 20000).catch(() => null)
      // ★ serverId 必须改写成 agent id，与 /api/state 同口径（那边是 `{...s, serverId: a.id}`）。
      // agent 自报的是 os.hostname()（如 VM-0-3-rockylinux），而实时列表里是 srv-178-232。
      // 漏掉这步的后果（2026-08-03 被真浏览器断言抓到）：前端 projectHistoryList 按 serverId
      // 过滤，冷路径 8 条**全被滤掉**，界面只剩实时列表那 2 条——API 明明返回 8，UI 就是 2。
      // 单测用一致的夹具、curl 只数条数，两者都测不出来；只有真浏览器能发现。
      const sessions = (r?.sessions ?? []).map((s) => ({ ...s, serverId: target.id }))
      // scanned/failed 一并透传：0 条会话有两种含义（真没有 vs 全解析失败），压平就没法排查
      return json(res, 200, { sessions, scanned: r?.scanned ?? 0, failed: r?.failed ?? 0 })
    }

    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') ?? ''
      const results = await Promise.all(agents.map(async (a) => {
        try {
          const r = await fetchJson(`${a.url}/api/search?q=${encodeURIComponent(q)}`, 20000)
          return (r.hits ?? []).map((h) => ({ ...h, serverId: a.id }))
        } catch { return [] }
      }))
      const hits = results.flat().sort((x, y) => y.lastActiveAt - x.lastActiveAt).slice(0, 40)
      return json(res, 200, { hits })
    }

    const mEvents = /^\/api\/session\/([\w-]+)\/events$/.exec(url.pathname)
    if (mEvents) {
      let agentUrl = idToAgent.get(mEvents[1])
      if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(mEvents[1]) }
      if (!agentUrl) return json(res, 404, { error: 'session not found' })
      return json(res, 200, await fetchJson(`${agentUrl}/api/session/${mEvents[1]}/events${url.search}`, 15000)) // 透传 ?since 续传游标
    }

    // 对话流里单张截图的字节（懒加载）。这是唯一的**二进制**会话路由——不能走 fetchJson/json()，
    // 那条路会把图片当 JSON 解析。原样透传 body + Content-Type + Cache-Control(immutable)。
    const mImage = /^\/api\/session\/([\w-]+)\/image\/[^/]+\/\d+$/.exec(url.pathname)
    if (mImage && req.method !== 'POST') {
      let agentUrl = idToAgent.get(mImage[1])
      if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(mImage[1]) }
      if (!agentUrl) return json(res, 404, { error: 'session not found' })
      const up = await fetch(`${agentUrl}${url.pathname}`, { signal: AbortSignal.timeout(20000) })
      if (!up.ok) return json(res, up.status, { error: 'image not found' })
      const buf = Buffer.from(await up.arrayBuffer())
      res.writeHead(200, {
        'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': up.headers.get('cache-control') || 'public, max-age=31536000, immutable',
      })
      return res.end(buf)
    }

    // Project images belong to the session's actual server; stream bytes without JSON/base64.
    const mFileImage = /^\/api\/session\/([\w-]+)\/file-image$/.exec(url.pathname)
    if (mFileImage && (req.method === 'GET' || req.method === 'HEAD')) {
      let agentUrl = idToAgent.get(mFileImage[1])
      if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(mFileImage[1]) }
      if (!agentUrl) return json(res, 404, { error: 'session not found' })
      const abort = new AbortController()
      const deadline = setTimeout(() => abort.abort(), 60_000)
      res.on('close', () => abort.abort())
      try {
        const up = await fetch(`${agentUrl}${url.pathname}${url.search}`, { method: req.method, signal: abort.signal })
        if (!up.ok) { await up.body?.cancel(); return json(res, up.status, { error: up.status === 413 ? 'toolarge' : 'image not found' }) }
        res.writeHead(200, {
          'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
          ...(up.headers.has('content-length') ? { 'Content-Length': up.headers.get('content-length') } : {}),
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        })
        if (req.method === 'HEAD' || !up.body) return res.end()
        await pipeline(Readable.fromWeb(up.body), res)
      } catch {
        if (res.headersSent) res.destroy()
        else if (!res.destroyed) json(res, 502, { error: 'image unavailable' })
      } finally { clearTimeout(deadline) }
      return
    }

    // 功能2/3 demo：会话回溯 digest、代码视图 tree/file、已持久化图片 —— 按会话路由到对应 agent（透传 query）
    const mSessGet = /^\/api\/session\/([\w-]+)\/(tree|file|digest|images)$/.exec(url.pathname)
    if (mSessGet && req.method !== 'POST') {
      let agentUrl = idToAgent.get(mSessGet[1])
      if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(mSessGet[1]) }
      if (!agentUrl) return json(res, 404, { error: 'session not found' })
      return json(res, 200, await fetchJson(`${agentUrl}${url.pathname}${url.search}`, 20000))
    }

    // SSE 实时流：从对应 agent 拉取并原样管道转发（不缓冲、不解析）
    const mStream = /^\/api\/session\/([\w-]+)\/stream$/.exec(url.pathname)
    if (mStream) {
      let agentUrl = idToAgent.get(mStream[1])
      if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(mStream[1]) }
      if (!agentUrl) return json(res, 404, { error: 'session not found' })
      // 透传 Last-Event-ID(浏览器重连游标)+ ?since 到上游 agent,支持断线续传
      const fwdHeaders = {}
      if (req.headers['last-event-id']) fwdHeaders['Last-Event-ID'] = req.headers['last-event-id']
      const upstream = await fetch(`${agentUrl}/api/session/${mStream[1]}/stream${url.search}`, { headers: fwdHeaders })
      if (!upstream.ok || !upstream.body) return json(res, upstream.status || 502, { error: 'stream unavailable' })
      // gzip 出口（2026-08-21）：对话流首屏由**第一帧**决定，线上实测 90,746B 明文、
      // 跨境 6.7~20.1s，而 agent 直连只要 0.00s、hub 经隧道 0.01s —— 时间全在跨境那一段
      // （实测吞吐 ~11KB/s）。2026-08-01 那次「跨境链路不压缩」只压了 `json()` 出口，
      // 而 SSE 是这条透传流，从来没被覆盖到，偏偏它是最大的一个 payload。
      // ⚠️ 逐帧 Z_SYNC_FLUSH（见 sse-gzip.js），否则逐字流式会被 gzip 缓冲憋成一坨。
      const sink = sinkFor(req, res)
      res.writeHead(200, sink.headers())
      const reader = upstream.body.getReader()
      req.on('close', () => { void reader.cancel().catch(() => {}) })
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          await sink.write(value)
        }
      } catch { /* 客户端断开或上游中断 */ }
      await sink.end()
      return
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      // 超时策略集中在 forward-timeouts.js（纯函数 + 不变量单测）。
      // 关键不变量：派生路径（/api/session、reattach、takeover、review）必须等得比闸门
      // 排队上限更久，否则闸门那条「并发已满，排队第 N 位」的 503 永远塌成 504，用户只看到「超时」。
      const forward = (agentUrl, pathName, timeoutMs = forwardTimeoutMs(pathName)) =>
        fetchJson(`${agentUrl}${pathName}`, timeoutMs, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

      // 会话归档到知识库（KB library 25）
      const mArch = /^\/api\/session\/([\w-]+)\/archive-to-kb$/.exec(url.pathname)
      if (mArch) {
        try { return json(res, 200, await archiveToKb(mArch[1])) }
        catch (e) { return json(res, e.status || 500, { error: String(e?.message || e) }) }
      }

      if (url.pathname === '/api/session') {
        const agentUrl = serverToAgent.get(body.serverId ?? '')
        if (!agentUrl) return json(res, 404, { error: 'server not found' })
        const out = await forward(agentUrl, '/api/session')
        // 显式选了 Claude 模型 → 记为该项目首选（写通缓存）
        if (out?.id && body.engine === 'claude' && body.model && body.cwd) {
          const key = `${body.serverId}/${path.basename(body.cwd)}`
          if (await db.upsertProjectModel(body.serverId, path.basename(body.cwd), String(body.model))) {
            projectModels[key] = String(body.model)
          }
        }
        return json(res, 200, out)
      }
      // Webshell：按 serverId 路由到对应机执行（70s 略大于 agent 60s 超时）
      if (url.pathname === '/api/exec') {
        const agentUrl = serverToAgent.get(body.serverId ?? '')
        if (!agentUrl) return json(res, 404, { error: 'server not found' })
        try {
          return json(res, 200, await fetchJson(`${agentUrl}/api/exec`, 70000, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: body.cmd, cwd: body.cwd }),
          }))
        } catch (e) { return json(res, e.status || 502, { error: String(e?.message || e) }) }
      }
      // 运行时调整某机的会话并发上限（AM-260721）：设置页"会话并发上限"用，转发给对应 agent，
      // 现值不需要新读端点——/api/state 里各 server.sessionGate.max 已经带着（agent.js buildState）。
      if (url.pathname === '/api/config/max-sessions') {
        const agentUrl = serverToAgent.get(body.serverId ?? '')
        if (!agentUrl) return json(res, 404, { error: 'server not found' })
        return json(res, 200, await forward(agentUrl, url.pathname))
      }
      // 终端会话管理：删除 / 改名+保留开关（按 server 路由到对应 agent）
      if (url.pathname === '/api/term/kill' || url.pathname === '/api/term/meta') {
        const agentUrl = serverToAgent.get(body.server ?? '')
        if (!agentUrl) return json(res, 404, { error: 'server not found' })
        try { return json(res, 200, await forward(agentUrl, url.pathname)) }
        catch { return json(res, 200, { ok: false, error: 'agent unreachable' }) }
      }
      // 今日复盘：汇总当天会话要点（含已缓存 digest 的 abstracts），交本机 agent 跑 haiku 归纳
      if (url.pathname === '/api/review/reflect') {
        if (!LOCAL_AGENT) return json(res, 503, { error: 'no local agent' })
        const review = await buildReview(body.date || '')
        const items = await Promise.all(review.projects.slice(0, 12).map(async (p) => ({
          project: p.project, server: p.serverName,
          sessions: await Promise.all(p.sessions.slice(0, 6).map(async (s) => {
            let abstracts = []
            try {
              const dg = await fetchJson(`${idToAgent.get(s.id) ?? LOCAL_AGENT}/api/session/${s.id}/digest`, 8000)
              abstracts = (dg.turns ?? []).map((t) => t.abstract).filter(Boolean)
            } catch { /* 无缓存 digest 就只用 summary */ }
            return { summary: s.summary, engine: s.engine, abstracts }
          })),
        })))
        const out = await fetchJson(`${LOCAL_AGENT}/api/review/reflect`, 120000, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: review.date, items }),
        })
        return json(res, 200, out)
      }
      // 会话级 POST /api/session/:id/review 已于 2026-08-04 删除：
      // 它是 8e10e30（"去掉开始审核"）之后留下的死接口，前端零调用方长达一个月。
      let m = /^\/api\/session\/([\w-]+)\/digest\/build$/.exec(url.pathname)
      if (m) {
        let agentUrl = idToAgent.get(m[1])
        if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(m[1]) }
        if (!agentUrl) return json(res, 404, { error: 'session not found' })
        // haiku 精炼可能耗时，放宽超时到 120s
        return json(res, 200, await fetchJson(`${agentUrl}${url.pathname}`, 120000, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }))
      }
      m = /^\/api\/session\/([\w-]+)\/(message|interrupt|mode|model|effort|takeover|reattach|release|file)$/.exec(url.pathname)
      if (m) {
        let agentUrl = idToAgent.get(m[1])
        if (!agentUrl) { await buildState(); agentUrl = idToAgent.get(m[1]) }
        if (!agentUrl) return json(res, 404, { error: 'session not found' })
        const out = await forward(agentUrl, url.pathname)
        // 会话头切换 Claude 模型（下一回合生效）→ 记为该项目首选
        if (m[2] === 'model' && out?.ok !== false && body.model) {
          let meta = idToMeta.get(m[1])
          if (!meta) { await buildState(); meta = idToMeta.get(m[1]) }
          if (meta && String(body.model).startsWith('claude-')) {
            const key = `${meta.serverId}/${meta.project}`
            if (await db.upsertProjectModel(meta.serverId, meta.project, String(body.model))) {
              projectModels[key] = String(body.model)
            }
          }
        }
        return json(res, 200, out)
      }
      m = /^\/api\/action\/([\w-]+)$/.exec(url.pathname)
      if (m) {
        let agentUrl = actionToAgent.get(m[1])
        if (!agentUrl) { await buildState(); agentUrl = actionToAgent.get(m[1]) }
        if (!agentUrl) return json(res, 409, { error: '待办不存在或已处理' })
        // ⚠️ 审批比别的写操作更值得等：resolveAction 本身是 O(1) 的内存 Map 操作，
        // 迟到几乎只可能是 agent 事件循环被压住的**排队**时间，而不是活儿真有那么久。
        // 15s 太紧——2026-07-18 22:34 那次，用户 6 次审批全卡在这个上限上（详见 forward-error.js）。
        // 放宽到 ACTION_FORWARD_MS 让瞬时饥饿自愈；真超了就走 504「结果未知」，靠轮询对账。
        // 具体值由 forward-timeouts.js 统一裁决（该文件是超时策略的唯一真相源）。
        return json(res, 200, await forward(agentUrl, url.pathname))
      }
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    // 分类见 forward-error.js（纯函数 + 单测）：
    //   · 上游 agent 的 HTTP 错误 → **原样透传状态码与完整错误体**（压平会吃掉 canForce 这类
    //     可操作字段，前端就只剩死胡同）
    //   · 转发超时/中止 → 504 + indeterminate（hub 自己不等了 ≠ agent 没做，别谎报「未送达」）
    const { status, body } = classifyForwardError(e)
    if (status >= 500) console.error(e)
    json(res, status, body)
  }
})

// 交互式终端（Task 2）：hub 不解析 WS 帧，只做透明 TCP splice。
// browser --(WS upgrade)--> hub --(raw TCP，原样转发 upgrade 请求)--> agent（WS 在 browser↔agent 终结）。
server.on('upgrade', (req, socket, head) => {
  if(!operatorAuth.authorize(req).ok){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/api/term/ws') { socket.destroy(); return }
  const agentUrl = serverToAgent.get(url.searchParams.get('server') || '')
  if (!agentUrl) { socket.destroy(); return }
  socket.setNoDelay(true)
  const u = new URL(agentUrl)
  const agent=agents.find(a=>a.url===agentUrl),connect=u.protocol==='https:'?tls.connect:net.connect
  const up = connect({port:Number(u.port)||(u.protocol==='https:'?443:80),host:u.hostname,...(u.protocol==='https:'&&!net.isIP(u.hostname)?{servername:u.hostname}:{})}, () => {
    // 原样转发升级请求行 + 头，再对拷字节（WS 在 browser↔agent 终结，hub 只做管道）
    up.write(`GET ${req.url} HTTP/1.1\r\n`)
    for (let i = 0; i < req.rawHeaders.length; i += 2)if(!['authorization','cookie','host'].includes(req.rawHeaders[i].toLowerCase()))up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`)
    up.write(`Host: ${u.host}\r\n`)
    if(agent?.token)up.write(`Authorization: Bearer ${agent.token}\r\n`)
    up.write('\r\n'); if (head && head.length) up.write(head)
    socket.pipe(up); up.pipe(socket)
  })
  up.setNoDelay(true)
  const bye = () => { try { up.destroy() } catch {}; try { socket.destroy() } catch {} }
  up.on('error', bye); socket.on('error', bye); socket.on('close', bye); up.on('close', bye)
})

server.listen(PORT, HOST, () => {
  console.log(`hub listening on ${HOST}:${PORT}, agents: ${agents.map((a) => a.id).join(', ')}, feishu: ${notifyEnabled ? 'on' : 'off'}`)
})
