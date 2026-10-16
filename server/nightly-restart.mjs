// server/nightly-restart.js — 每日例行重启的决策核。纯函数、可单测、无副作用。
//
// 由 server/nightly-restart.sh 在**北京时间每天 04:00** 调用，逐台判断"能不能重启"。
//
// 为什么要有这一层：重启这件事本身很简单（systemctl restart），难的是**什么时候不能重启**。
// 而"什么时候不能重启"这个判据，本仓库已经有两处在用（deploy-agent.sh 与 restart.sh），
// 都指向 maintenance.js 的 restartBlockers。这里**继续复用同一个**，绝不手写第三份——
// 三份判据迟早漂移，然后某一份在最需要保守的时候 fail-open。
//
// ★ 关于"跳过"：探测失败/有活跃会话就跳过，这是对的。但**跳过必须会喊**。
//   fail-safe 的跳过如果能永远成立，就成了"永不重启"的免死金牌，而且外表跟正常运转
//   一模一样（日志每天都在写"已跳过"，健康得很）。所以连续跳过到阈值必须升级为告警。
//   —— 对应记忆里那条「测不到 ≠ 永久豁免」。
import { pathToFileURL } from 'node:url'
import { restartBlockers } from './maintenance.js'

/** 北京时区。**必须显式写进 crontab**：5 台机里 3 台宿主机是 Asia/Tokyo。 */
export const BEIJING_TZ = 'Asia/Shanghai'
/** 凌晨 4 点。 */
export const CRON_SCHEDULE = '0 4 * * *'
/** 连续跳过多少次之后升级为告警。 */
export const DEFAULT_MAX_SKIP_STREAK = 3

/**
 * 判断某台机现在能否重启 agent。
 * @param {object} o
 * @param {boolean} o.probeOk    /api/state 是否成功取回（网络层）
 * @param {string}  o.stateText  /api/state 原文
 * @param {number}  o.skipStreak 此前已连续跳过的次数
 * @param {number}  o.maxSkipStreak 触发告警的连续跳过阈值
 * @returns {{restart:boolean, reason:string, blockers:Array, alert:boolean}}
 */
export function decideRestart({
  probeOk = true,
  stateText = '',
  skipStreak = 0,
  maxSkipStreak = DEFAULT_MAX_SKIP_STREAK,
} = {}) {
  const alert = skipStreak >= maxSkipStreak
  const skip = (reason) => ({
    restart: false,
    reason: alert ? `${reason}（已连续跳过 ${skipStreak} 次，需要人来看一眼）` : reason,
    blockers: [],
    alert,
  })

  if (!probeOk) return skip('探测不到 /api/state，拒绝盲重启')

  let payload
  try {
    payload = JSON.parse(stateText)
  } catch {
    // 截断的 JSON 曾被旧实现解析成空串 ⇒ 等价于"无活跃会话" ⇒ 在最该保守时 fail-open。
    return skip('/api/state 不是有效 JSON（可能被截断），拒绝盲重启')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.sessions)) {
    return skip('/api/state 缺少 sessions 数组，形状不可信，拒绝盲重启')
  }

  // 复用与 deploy-agent.sh / restart.sh 完全相同的判据：
  // origin=platform 且真在飞（优先 inflight 布尔，回退粗粒度 state）。
  // 影子会话是独立进程、不受 agent 重启影响 ⇒ 不计入，否则终端里常年有人跑着就永远等不到窗口。
  const blockers = restartBlockers({ sessionLists: [payload.sessions] })
  if (blockers.length) {
    return { restart: false, reason: `有 ${blockers.length} 个活跃平台会话在飞，本次跳过`, blockers, alert }
  }
  return { restart: true, reason: '无活跃平台会话，可安全重启', blockers: [], alert: false }
}

// ───────────────────────── crontab 时区安全 ─────────────────────────
//
// cronie 的 `CRON_TZ=X` 是**向后传染**的：一直作用到下一个 CRON_TZ 或文件结束。
// 于是有两个都很安静的坑：
//   ① 不写 CRON_TZ ⇒ 跟随宿主机。232/177-188/169-69 是 Asia/Tokyo ⇒ "4 点"其实是北京 3 点。
//   ② 写了但没恢复现场 ⇒ 把**后面每一条既有任务**一起挪走，无报错、无日志、只有结果不对。

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/
const CRON_TZ_RE = /^CRON_TZ\s*=\s*(\S+)$/

/** 解析 crontab 文本，返回每条任务及其**生效时区**（未声明为 null = 跟随宿主机）。 */
export function parseCrontab(text) {
  const rows = []
  let tz = null
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = CRON_TZ_RE.exec(line)
    if (m) { tz = m[1]; continue }
    if (ENV_ASSIGN_RE.test(line)) continue // 其它环境变量赋值，不是任务
    const parts = line.split(/\s+/)
    if (line.startsWith('@')) {
      if (parts.length >= 2) rows.push({ schedule: parts[0], command: parts.slice(1).join(' '), tz })
      continue
    }
    if (parts.length < 6) continue
    rows.push({ schedule: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' '), tz })
  }
  return rows
}

/** 文本末尾生效的 CRON_TZ（没有则 null）。 */
function trailingTz(text) {
  let tz = null
  for (const raw of String(text ?? '').split('\n')) {
    const m = CRON_TZ_RE.exec(raw.trim())
    if (m) tz = m[1]
  }
  return tz
}

/**
 * 把每日重启任务追加进 crontab 文本，保证：
 *   · 新任务生效时区恒为北京，与宿主机无关；
 *   · 既有任务的生效时区一字不变；
 *   · 结束后恢复原本生效的 CRON_TZ，不坑下一个往末尾追加的人；
 *   · 幂等，重复安装不产生第二条。
 */
export function planCrontab(text, scriptPath) {
  const src = String(text ?? '')
  if (parseCrontab(src).some((r) => r.command.includes(scriptPath))) return src

  const prevTz = trailingTz(src)
  const body = src.replace(/\s+$/, '')
  const block = [
    '',
    '# ── web_agents 每日例行重启（无活跃平台会话才重启）────────────────',
    '# CRON_TZ 必须显式声明：5 台机里 3 台宿主机是 Asia/Tokyo，裸写 0 4 * * *',
    '# 在那 3 台上等于北京时间 3 点——差一小时，且日志上完全看不出来。',
    `CRON_TZ=${BEIJING_TZ}`,
    `${CRON_SCHEDULE} ${scriptPath}`,
  ]
  if (prevTz) {
    block.push('# 恢复现场：CRON_TZ 向后传染，不恢复的话往下追加的任务会静默变成北京时间。')
    block.push(`CRON_TZ=${prevTz}`)
  }
  return (body ? `${body}\n` : '') + block.join('\n').replace(/^\n/, '') + '\n'
}

// ───────────────────────── CLI 胶水 ─────────────────────────
// shell 靠退出码分支，所以退出码就是协议的一部分：
//   decide → 0 可重启 / 10 跳过 / 11 跳过且已连续跳过到阈值（需要人看）
// 与 deploy-state-check.mjs 同一套路（0/10/2），保持运维手感一致。

const readStdin = async () => {
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s
}
const flag = (argv, name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}

async function main(argv) {
  const cmd = argv[2]
  if (cmd === 'decide') {
    const d = decideRestart({
      probeOk: flag(argv, 'probe-ok', '1') !== '0',
      stateText: await readStdin(),
      skipStreak: Number(flag(argv, 'skip-streak', '0')) || 0,
      maxSkipStreak: Number(flag(argv, 'max-skip-streak', String(DEFAULT_MAX_SKIP_STREAK))) || DEFAULT_MAX_SKIP_STREAK,
    })
    process.stdout.write(`${JSON.stringify(d)}\n`)
    process.exitCode = d.restart ? 0 : (d.alert ? 11 : 10)
    return
  }
  if (cmd === 'plan-cron') {
    const scriptPath = argv[3]
    if (!scriptPath) { process.stderr.write('用法: nightly-restart.js plan-cron <scriptPath> < crontab\n'); process.exitCode = 2; return }
    process.stdout.write(planCrontab(await readStdin(), scriptPath))
    return
  }
  process.stderr.write('用法: nightly-restart.js decide|plan-cron\n')
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv)
