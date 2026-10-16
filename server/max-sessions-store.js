// server/max-sessions-store.js — 会话并发上限的运行时可调持久化（纯 I/O，clamp 不在这里）。
//
// 背景：并发上限过去只能靠 WA_MAX_SESSIONS 环境变量在 agent 启动时定死，改一次就要重启 agent——
// 而重启会 SIGKILL 该机全部平台会话（见 CLAUDE.md「部署到远端别裸 systemctl restart」）。
// 这就是为什么这个数字从 2026-07-18 引入闸门以来从没人敢调：代价太大，没人愿意为"调个数字"
// 中断所有人的活。session-gate.js 加了 setMax() 之后可以运行时热改了，但热改的值必须活得过
// agent 重启（否则下次部署/崩溃重启又回到 WA_MAX_SESSIONS，等于白改）——这个模块就是那份"记忆"。
//
// 有效值优先级（resolveStartupMax）：持久化文件 > WA_MAX_SESSIONS 环境变量 > 内置默认值 8。
//
// 落盘位置 ~/.web-agents/max-sessions.json，与 agent.js 既有 EXEC_AUDIT / session-store.js 的
// platform-sessions.json 同目录，沿用同一套文件权限约定（目录 0700、文件 0600）——这里的数据本身
// 不敏感，但没必要为了一个整数另起一套标准，图省事对齐即可。
//
// clamp 逻辑刻意不放这里：唯一真相源是 session-gate.js 的 setMax/clampMax（[1, MAX_CEILING]）。
// 本模块只管"写谁读谁"，谁调用都必须先过 gate.setMax 拿到 clamp 后的值再落盘——
// 否则文件里可能存下一个从没被闸门认可过的数字，下次启动时又得靠 gate 构造时的 clampMax 兜底，
// 等于把同一份判断逻辑抄了两遍（改一处忘一处的典型坑）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_MAX_SESSIONS_FILE = path.join(os.homedir(), '.web-agents', 'max-sessions.json')
export const MAX_SESSIONS_DEFAULT = 8

/** 读持久化值；文件缺失/损坏/JSON 形状不符/字段非数字 → null（调用方据此回退到 env/默认值）。 */
export function readPersistedMax(file = DEFAULT_MAX_SESSIONS_FILE) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null // 文件不存在 = 首次启动的正常路径，不该有噪声日志
  }
  // ⚠️ 到这里文件是**存在**的：解析失败/值非法必须喊出来，不能和「没有文件」共用静默回落。
  // 运维正是用这个文件把 2G 机器（169-69/177-42）的上限压低来防 OOM 的；文件一旦损坏
  // 就悄悄退回 env/默认 8，等于把当初逼出这道闸门的「8 个会话打爆 2G 机」重新放回来，
  // 而日志里一个字都没有。本仓四次事故的共同教训：送不到的错误等于没有。
  try {
    const data = JSON.parse(raw)
    const n = Number(data?.max)
    if (Number.isFinite(n)) return n
    console.error(`[max-sessions] ${file} 里的 max 非法（${JSON.stringify(data?.max)}），已忽略并回落到 env/默认值——请修复该文件`)
    return null
  } catch (e) {
    console.error(`[max-sessions] ${file} 解析失败（${String(e?.message ?? e)}），已忽略并回落到 env/默认值——请修复该文件`)
    return null
  }
}

/**
 * 落盘（tmp→rename 原子写，避免崩溃写一半留半份坏文件；0600 权限）。
 * 调用方负责传入**已经过 gate.setMax clamp 过**的值——这里不重复校验范围。
 */
export function writePersistedMax(n, file = DEFAULT_MAX_SESSIONS_FILE) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ max: n, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* 权限尽力而为，不阻断写入 */ }
}

/**
 * 启动时的有效值 + 来源（source: 'file' | 'env' | 'default'），来源要报出来才能让运维一眼看懂
 * "为什么是这个数"——不然一个改过一次又被人忘记的 WA_MAX_SESSIONS 能让人查半天。
 * 文件里的值也可能是陈旧脏数据（比如有人手改了 json），越界/非法交给上层 gate 构造时的
 * clampMax 兜底（[1, MAX_CEILING]），这里不重复判断范围。
 */
export function resolveStartupMax({ file = DEFAULT_MAX_SESSIONS_FILE, env = process.env.WA_MAX_SESSIONS } = {}) {
  const persisted = readPersistedMax(file)
  if (persisted != null) return { value: persisted, source: 'file' }
  if (env != null && env !== '') {
    const envVal = Number(env)
    if (Number.isFinite(envVal)) return { value: envVal, source: 'env' }
  }
  return { value: MAX_SESSIONS_DEFAULT, source: 'default' }
}
