// server/claude-bin.js — claude CLI 的路径解析。纯函数 + 一层薄 I/O，可单测。
//
// 为什么单独成一个模块（2026-08-21 线上）：srv-177-188 上新建/接管 Claude 会话必定
// `Claude Code process exited with code 1`，agent 日志一个字都没有。根因与会话大小无关
// （我先怀疑那两条 23MB/74MB 的 JSONL，**查下来是错的**）：
//
//   /root/.nvm/versions/node/v22.22.2/bin/claude --version
//   → Error: claude native binary not installed.（postinstall 没跑 / --omit=optional）
//
// 而同机 **/usr/bin/claude 是好的（2.1.197）**，只是它**根本不在候选表里**。
// 原实现是 `candidates.find((p) => fs.existsSync(p))` —— **只判存在、不判能不能跑**，
// 于是稳稳选中那个坏的，而且没有任何日志说它选了谁。
//
// ★ 「装了 ≠ 能用」是本仓库反复栽的一类：systemctl is-active 会骗你、插件装了但 worker
//   从没起来、端口在听但完全不 accept。**判存在是最弱的判据**，能跑才算数。
//
// 同一病根的第二个实例：usage-limits.js 曾把 /root/.local/bin/claude 写死在探针命令里，
// 而 177-188 上没有这个文件 ⇒ Claude 额度探测在那台机上一直静默失败。现在两处共用本模块。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * 候选路径，按优先级。
 * nvm 垫底：它最容易出现"半装"（native binary 缺失），而 /usr/bin 与 ~/.local/bin
 * 多是包管理器或官方安装脚本装的，完整度更高。
 *
 * @param env  读 CLAUDE_BIN 覆盖（**仍要验**，见 pickClaudeBin）
 * @param home 家目录
 * @param nvmVersions 显式传入的 nvm 版本目录名（不传则扫盘；便于单测）
 */
export function claudeCandidates(env = process.env, home = os.homedir(), nvmVersions = null) {
  const out = []
  if (env?.CLAUDE_BIN) out.push(env.CLAUDE_BIN)
  out.push(path.join(home, '.local/bin/claude'))
  out.push('/usr/local/bin/claude')
  out.push('/usr/bin/claude')          // ★ 177-188 上唯一能用的那个，原来缺了它
  const versions = nvmVersions ?? (() => {
    try { return fs.readdirSync(path.join(home, '.nvm/versions/node')) } catch { return [] }
  })()
  for (const v of versions) out.push(path.join(home, '.nvm/versions/node', v, 'bin/claude'))
  return [...new Set(out)]
}

/**
 * 挑第一个**真的能跑**的。
 *
 * ⚠️ 全都跑不起来时返回 **null**，绝不"退而求其次"挑一个存在但坏的——
 * 那会让每次建会话都 exit 1 而没人知道为什么（正是 177-188 上发生的）。
 * 调用方拿到 null 必须**喊出来**。
 *
 * @param candidates 候选路径
 * @param io { exists(path):bool, probe(path):bool }  probe = 真的执行一次看它活不活
 */
export function pickClaudeBin(candidates, io) {
  let firstExisting = null
  for (const p of candidates ?? []) {
    if (!p || !io.exists(p)) continue     // 不存在的不 probe，省掉无谓的进程启动
    if (firstExisting === null) firstExisting = p
    try { if (io.probe(p)) return { bin: p, verified: true } } catch { /* 探测本身炸了 = 不可用 */ }
  }
  // ⚠️ 一个都验不过**不返回 null**（2026-08-21 上线当天的修订）：初版返回 null，结果
  // 我自己的探测器把 177-42 判成了"没有可用 CLI"——那台的 nvm claude 明明是好的（2.1.239），
  // 只是 `--version` 在 stdin:'ignore' 下要 2,092ms、超过了初版 3s 的超时。
  // **探测器误判把一台好机器判死，比原 bug 更糟。** 所以退回"存在的第一个"，
  // 但带 verified:false 让调用方高声报——带着警告继续跑，好过因为我的探测慢而全线停摆。
  return { bin: firstExisting, verified: false }
}

/**
 * 真探测：跑一次 `--version`，退出码 0 且输出像版本号才算数。
 *
 * ⚠️ 超时按**实测最慢值**给，别拍脑袋：177-42 实测 `stdio:['ignore',…]` 要 **2,092ms**，
 * 而 `['pipe',…]` 只要 280ms（7×）。初版给 3s + 'ignore'，机器一忙就超时。
 * 现在两处都改：stdin 用 'pipe'（快 7 倍），超时给到 10s（2 核小机冷启时留足余量）。
 */
export const PROBE_TIMEOUT_MS = 10_000
function probeReal(p) {
  try {
    const out = execFileSync(p, ['--version'], { timeout: PROBE_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] })
    return /\d+\.\d+/.test(String(out))
  } catch { return false }
}

let cached
/**
 * 解析并缓存（每进程一次；探测要起子进程，不该每次调用都做）。
 * @returns {string|null} 可用的 claude 路径；没有则 null
 */
export function resolveClaudeBin({ env = process.env, home = os.homedir(), force = false } = {}) {
  if (cached !== undefined && !force) return cached
  const list = claudeCandidates(env, home)
  const r = pickClaudeBin(list, { exists: (p) => fs.existsSync(p), probe: probeReal })
  cached = r.bin
  if (cached && !r.verified) {
    console.error(`[claude] ⚠ 选中 ${cached}，但 --version 探测没通过——它**可能跑不起来**。`
      + '若会话一建就 `exited with code 1`，先手工跑一次 `<该路径> --version` 看报什么。')
  }
  if (!cached) {
    // 必须喊：静默失败的后果是"每次建会话都 exit 1"，而 stderr 被 SDK 吞掉、日志里一个字没有。
    console.error(`[claude] ✗ 找不到**可用**的 claude CLI。候选均不可执行：\n  ${list.join('\n  ')}\n`
      + '  常见原因：native binary 未安装（postinstall 没跑 / --omit=optional）。'
      + '  修法：node <claude-code 安装目录>/install.cjs，或重装且不要 --ignore-scripts。')
  }
  return cached
}
