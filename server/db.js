// MySQL 持久化层（#10）：每日指标时序 + 官方用量%时序。配置取自 server/.env(mysql_* 小写键，不入库)。
// 连接失败/不可用时全部降级为 no-op，绝不阻断 hub 主流程。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { quotaSeries, legacyClaudeQuotaSeries } from './quota-history.js'
import { projectUsageScope } from './project-usage-scope.js'
import { createProgressRepository } from './progress-repository.js'

const ENV = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')
function loadEnv() {
  const out = {}
  try {
    for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* 无 .env */ }
  return { ...out, ...process.env }
}

let pool = null
let ready = false
export function dbEnabled() { return ready }
export const progressRepository = createProgressRepository({ enabled: () => ready, query: (sql, args) => pool.execute(sql, args) })

export async function initDb() {
  const e = loadEnv()
  for(const [name,legacy] of Object.entries({HOST:'host',PORT:'port',DATABASE:'db',USER:'username',PASSWORD:'user_password'})) {
    if(e[`WA_MYSQL_${name}`]!==undefined)e[`mysql_${legacy}`]=e[`WA_MYSQL_${name}`]
  }
  if (!e.mysql_host || !e.mysql_db) { console.log('[db] 未配置 mysql_*，跳过'); return false }
  try {
    pool = mysql.createPool({
      host: e.mysql_host, port: Number(e.mysql_port) || 3306,
      user: e.mysql_username, password: e.mysql_user_password, database: e.mysql_db,
      connectionLimit: 4, connectTimeout: 8000, waitForConnections: true, queueLimit: 20,
    })
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
      day DATE PRIMARY KEY,
      tokens BIGINT NOT NULL DEFAULT 0,
      cost DECIMAL(12,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`)
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_limits (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      session_pct INT, week_pct INT, week_sonnet_pct INT,
      session_resets VARCHAR(64), week_resets VARCHAR(64),
      INDEX idx_ts (ts)
    ) DEFAULT CHARSET=utf8mb4`)
    await pool.query(`CREATE TABLE IF NOT EXISTS app_config (
      k VARCHAR(64) PRIMARY KEY,
      v MEDIUMTEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`)
    await pool.query(`CREATE TABLE IF NOT EXISTS project_daily_active (
      day DATE NOT NULL,
      server_id VARCHAR(64) NOT NULL,
      project VARCHAR(255) NOT NULL,
      active_ms BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (day, server_id, project)
    ) DEFAULT CHARSET=utf8mb4`)
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_limits_daily (
      day DATE PRIMARY KEY,
      week_pct INT, week_sonnet_pct INT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`)
    await pool.query(`CREATE TABLE IF NOT EXISTS project_prefs (
      server_id VARCHAR(64) NOT NULL,
      project   VARCHAR(255) NOT NULL,
      model     VARCHAR(64) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (server_id, project)
    ) DEFAULT CHARSET=utf8mb4`)
    for (const col of ['ADD COLUMN cost DECIMAL(12,2) NOT NULL DEFAULT 0', 'ADD COLUMN tokens BIGINT NOT NULL DEFAULT 0']) {
      try { await pool.query(`ALTER TABLE project_daily_active ${col}`) } catch { /* 已存在则忽略 */ }
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS engine_quota_samples (
      engine VARCHAR(16) NOT NULL,
      account_key VARCHAR(128) NOT NULL,
      window_key VARCHAR(64) NOT NULL,
      window_label VARCHAR(64) NOT NULL,
      ts_ms BIGINT NOT NULL,
      pct DOUBLE NOT NULL,
      reset_at_ms BIGINT NULL,
      PRIMARY KEY (engine, account_key, window_key, ts_ms),
      INDEX idx_sample_ts (ts_ms)
    ) DEFAULT CHARSET=utf8mb4`)
    ready = true
    console.log(`[db] connected ${e.mysql_host}:${e.mysql_port || 3306}/${e.mysql_db}`)
    return true
  } catch (err) {
    console.error('[db] init failed (降级为 no-op):', err.message)
    ready = false
    return false
  }
}

/** 每日指标 upsert。rows: [{date:'YYYY-MM-DD', tokens, cost}] */
export async function upsertDaily(rows) {
  if (!ready || !rows?.length) return
  for (const r of rows) {
    try {
      await pool.query(
        'INSERT INTO daily_metrics (day, tokens, cost) VALUES (?,?,?) ON DUPLICATE KEY UPDATE tokens=VALUES(tokens), cost=VALUES(cost)',
        [r.date, Math.round(r.tokens || 0), Number(r.cost || 0)],
      )
    } catch { /* 单行失败忽略 */ }
  }
}

/** 官方用量%时序入库。u: {session,week,weekSonnet} */
export async function insertUsageLimits(u) {
  if (!ready || !u) return
  try {
    await pool.query(
      'INSERT INTO usage_limits (session_pct, week_pct, week_sonnet_pct, session_resets, week_resets) VALUES (?,?,?,?,?)',
      [u.session?.pct ?? null, u.week?.pct ?? null, u.weekSonnet?.pct ?? null, u.session?.resets ?? null, u.week?.resets ?? null],
    )
  } catch { /* 忽略 */ }
}

/** Preserve the source observation time: cache reads cannot manufacture history. */
export async function insertQuotaSamples(rows, { strict = false } = {}) {
  if (!ready) { if (strict) throw new Error('quota persistence unavailable'); return 0 }
  if (!rows?.length) return 0
  let inserted = 0
  try {
    for (const r of rows) {
      const [result] = await pool.query(
      `INSERT IGNORE INTO engine_quota_samples
       (engine, account_key, window_key, window_label, ts_ms, pct, reset_at_ms) VALUES (?,?,?,?,?,?,?)`,
      [r.engine, r.accountKey, r.windowKey, r.windowLabel, r.ts, r.pct, r.resetAt],
      )
      inserted += result.affectedRows
    }
    return inserted
  } catch (e) { if (strict) throw e; console.warn('[db] quota history write failed:', e.message); return inserted }
}

/** Latest actual observation per account/window/3h bucket, without zero filling. */
export async function readQuotaTrend(days = 30, { includeHistory = true } = {}) {
  if (!ready) return []
  const since = Date.now() - Math.max(1, Math.min(60, days)) * 86400_000
  const [rows] = await pool.query(
    `SELECT q.* FROM engine_quota_samples q JOIN (
       SELECT engine, account_key, window_key, MAX(ts_ms) AS latest
       FROM engine_quota_samples WHERE ts_ms >= ? ${includeHistory ? '' : "AND account_key NOT LIKE 'historical:%'"}
       GROUP BY engine, account_key, window_key, FLOOR(ts_ms / 10800000)
     ) b ON q.engine=b.engine AND q.account_key=b.account_key
       AND q.window_key=b.window_key AND q.ts_ms=b.latest
     ORDER BY q.engine, q.account_key, q.window_key, q.ts_ms`, [since],
  )
  if (!includeHistory) return quotaSeries(rows)
  const [legacy] = await pool.query(
    `SELECT UNIX_TIMESTAMP(u.ts) * 1000 AS ts_ms, u.week_pct FROM usage_limits u
     JOIN (
       SELECT FLOOR(UNIX_TIMESTAMP(ts)/10800) AS bucket, MAX(ts) AS latest
       FROM usage_limits WHERE ts >= FROM_UNIXTIME(? / 1000)
       GROUP BY bucket
     ) b ON FLOOR(UNIX_TIMESTAMP(u.ts)/10800)=b.bucket AND u.ts=b.latest
     ORDER BY u.ts, u.id DESC`, [since],
  )
  return [...quotaSeries(rows), ...legacyClaudeQuotaSeries(legacy)]
}

/** 通用 KV 配置：读 JSON。无则 null。 */
export async function getConfig(k) {
  if (!ready) return null
  try {
    const [rows] = await pool.query('SELECT v FROM app_config WHERE k = ?', [k])
    return rows.length ? JSON.parse(rows[0].v) : null
  } catch { return null }
}

/** 通用 KV 配置：写 JSON（upsert）。返回是否成功。 */
export async function setConfig(k, obj) {
  if (!ready) return false
  try {
    await pool.query(
      'INSERT INTO app_config (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [k, JSON.stringify(obj)],
    )
    return true
  } catch { return false }
}

/** 每项目首选模型（Claude）upsert。缺参或 DB 未就绪返回 false。 */
export async function upsertProjectModel(serverId, project, model) {
  if (!ready || !serverId || !project || !model) return false
  try {
    await pool.query(
      'INSERT INTO project_prefs (server_id, project, model) VALUES (?,?,?) ON DUPLICATE KEY UPDATE model=VALUES(model)',
      [serverId, project, model],
    )
    return true
  } catch { return false }
}

/** 读全部项目首选模型 → { "serverId/project": "claude-fable-5" }。DB 未就绪返回 {}。 */
export async function readProjectModels() {
  if (!ready) return {}
  try {
    const [rows] = await pool.query('SELECT server_id, project, model FROM project_prefs')
    const out = {}
    for (const r of rows) out[`${r.server_id}/${r.project}`] = r.model
    return out
  } catch { return {} }
}

/** 长期每日历史（可超出 JSONL 的 60 天扫描窗口）。返回 [{date,tokens,cost}] 升序 */
export async function readDailyHistory(days) {
  if (!ready) return []
  try {
    const [rows] = await pool.query(
      'SELECT DATE_FORMAT(day, "%Y-%m-%d") AS date, tokens, cost FROM daily_metrics WHERE day >= (CURRENT_DATE - INTERVAL ? DAY) ORDER BY day',
      [Math.max(1, Math.min(400, days || 30))],
    )
    return rows.map((r) => ({ date: r.date, tokens: Number(r.tokens), cost: Number(r.cost) }))
  } catch { return [] }
}

/** 每项目当日活跃时长/成本/token upsert(day=当天)。rows: [{serverId, project, activeMs, cost, tokens}] */
export async function upsertProjectDailyActive(rows) {
  if (!ready || !rows?.length) return
  for (const r of rows) {
    try {
      await pool.query(
        'INSERT INTO project_daily_active (day, server_id, project, active_ms, cost, tokens) VALUES (CURRENT_DATE, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE active_ms=VALUES(active_ms), cost=VALUES(cost), tokens=VALUES(tokens)',
        [r.serverId, r.project, Math.round(r.activeMs || 0), Number(r.cost || 0), Math.round(r.tokens || 0)],
      )
    } catch { /* 单行失败忽略 */ }
  }
}

/** 周使用率%按日期记录(一天一行,当天反复 upsert 保留最新值)。u: {week,weekSonnet} */
export async function upsertUsageLimitsDaily(u) {
  if (!ready || !u) return
  try {
    await pool.query(
      'INSERT INTO usage_limits_daily (day, week_pct, week_sonnet_pct) VALUES (CURRENT_DATE, ?, ?) ON DUPLICATE KEY UPDATE week_pct=VALUES(week_pct), week_sonnet_pct=VALUES(week_sonnet_pct)',
      [u.week?.pct ?? null, u.weekSonnet?.pct ?? null],
    )
  } catch { /* 忽略 */ }
}

/** 读周使用率日序列(升序)。返回 [{date, week, sonnet}] */
export async function readUsageLimitsDaily(days) {
  if (!ready) return []
  try {
    const [rows] = await pool.query(
      'SELECT DATE_FORMAT(day, "%Y-%m-%d") AS date, week_pct, week_sonnet_pct FROM usage_limits_daily WHERE day >= (CURRENT_DATE - INTERVAL ? DAY) ORDER BY day',
      [Math.max(1, Math.min(400, days || 30))],
    )
    return rows.map((r) => ({
      date: r.date,
      week: r.week_pct == null ? null : Number(r.week_pct),
      sonnet: r.week_sonnet_pct == null ? null : Number(r.week_sonnet_pct),
    }))
  } catch { return [] }
}

/** 周使用率%时序按 bucketHours(默认3)小时分桶：取每桶内最新一条采样。
    返回 [{date:'YYYY-MM-DD HH:00', week, sonnet}]（按时间升序）。DB 未就绪返回 []。 */
export async function readUsageLimitsTrend(days, bucketHours = 3) {
  if (!ready) return []
  const secs = Math.max(1, Math.round(bucketHours)) * 3600
  const d = Math.max(1, Math.min(60, days || 14))
  try {
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(u.ts, '%Y-%m-%d %H:00') AS date, u.week_pct, u.week_sonnet_pct
       FROM usage_limits u
       JOIN (
         SELECT FLOOR(UNIX_TIMESTAMP(ts)/?) AS b, MAX(ts) AS mts
         FROM usage_limits WHERE ts >= NOW() - INTERVAL ? DAY
         GROUP BY b
       ) m ON FLOOR(UNIX_TIMESTAMP(u.ts)/?) = m.b AND u.ts = m.mts
       ORDER BY u.ts`,
      [secs, d, secs],
    )
    return rows.map((r) => ({
      date: r.date,
      week: r.week_pct == null ? null : Number(r.week_pct),
      sonnet: r.week_sonnet_pct == null ? null : Number(r.week_sonnet_pct),
    }))
  } catch { return [] }
}

/** 近 N 天各项目消耗聚合(窗口 SUM)。days=1→今日,7→近7天,30→近30天。返回 [{serverId,project,activeMs,cost,tokens}] */
export async function readProjectsDaily(days, scope) {
  if (!ready) return []
  const filter = projectUsageScope(scope)
  try {
    const [rows] = await pool.query(
      `SELECT server_id, project, SUM(active_ms) AS active_ms, SUM(cost) AS cost, SUM(tokens) AS tokens FROM project_daily_active WHERE day >= (CURRENT_DATE - INTERVAL ? DAY) AND ${filter.sql} GROUP BY server_id, project`,
      [Math.max(1, Math.min(400, days || 1)) - 1, ...filter.params],
    )
    return rows.map((r) => ({ serverId: r.server_id, project: r.project, activeMs: Number(r.active_ms), cost: Number(r.cost), tokens: Number(r.tokens) }))
  } catch { return [] }
}

/** 每天的活跃总时长序列（跨项目合计）——给「AI 工作量」的每日迷你柱用。
 *  同一张 project_daily_active，只是按 day 聚合而不是按 project。 */
export async function readActiveDailySeries(days, scope) {
  if (!ready) return []
  const filter = projectUsageScope(scope)
  try {
    const [rows] = await pool.query(
      `SELECT day, SUM(active_ms) AS active_ms, COUNT(DISTINCT project) AS projects FROM project_daily_active WHERE day >= (CURRENT_DATE - INTERVAL ? DAY) AND ${filter.sql} GROUP BY day ORDER BY day`,
      [Math.max(1, Math.min(400, days || 1)) - 1, ...filter.params],
    )
    return rows.map((r) => ({
      // day 是 DATE，mysql2 给回 Date 对象——取本地日期串，别 toISOString（会偏时区一天）
      date: r.day instanceof Date ? `${r.day.getFullYear()}-${String(r.day.getMonth() + 1).padStart(2, '0')}-${String(r.day.getDate()).padStart(2, '0')}` : String(r.day),
      activeMs: Number(r.active_ms),
      projects: Number(r.projects),
    }))
  } catch { return [] }
}
