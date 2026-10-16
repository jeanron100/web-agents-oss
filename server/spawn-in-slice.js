// server/spawn-in-slice.js — 把会话子进程拉起到独立 cgroup slice。
//
// 为什么（2026-08-13 实测故障现场）：web-agents-agent.service 这一个 cgroup 里装着
//   agent.js 102MB + claude 406MB + claude 299MB + claude-mem 112MB + MCP 131MB
//   = memory.current 1592MB / MemoryHigh 1638MB ⇒ 内核同步回收节流，服务 active 却不 accept 连接。
// **两个会话就顶满了**，其中 705MB 与控制面毫无关系。
//
// 已实测验证的四条前提（`systemd-run --scope`，Rocky 9.4 / kernel 5.14）：
//   ① stdio 管道保留 —— codex/kimi 的 NDJSON 双向管道照常工作
//   ② 落进 --slice 指定的 cgroup
//   ③ 退出码透传
//   ④ systemd 按连字符自动建层级：web-agents-worker.slice → /web.slice/web-agents.slice/…
//
// 已有先例：terminal.js#ensureTmuxServer 用同样手法把 tmux server 起在 agent cgroup 之外。
//
// ⚠️ 隔离 ≠ 释放内存。cgroup 只决定**记账归属与故障域**，不释放任何物理页
//    （实测：scope 销毁后文件仍常驻 57MB，全局 Cached +57MB）。别把这两件事混为一谈。

/** worker slice 名。systemd 按连字符建层级，故它与 control slice 共享父级 web-agents.slice。 */
export const WORKER_SLICE = 'web-agents-worker.slice'
export const CONTROL_SLICE = 'web-agents-control.slice'

/** 开关：出问题一键退回原行为（改环境变量 + 重启即可，不需回滚代码）。 */
export const sliceIsolationEnabled = () => process.env.WA_WORKER_SLICE !== '0'

/** systemd 单元名只允许有限字符集；会话 id 里可能有 `/`、`:`、空格。 */
const sanitizeUnit = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 128)

/**
 * 构造「把 cmd 放进 slice 里跑」的命令行。
 *
 * @param {string} cmd 原命令（绝对路径或 PATH 可解析）
 * @param {string[]} args 原参数
 * @param {{slice?:string, unit?:string, enabled?:boolean}} opts
 * @returns {{cmd:string, args:string[]}} 可直接喂给 child_process.spawn
 */
export function buildSliceArgv(cmd, args = [], opts = {}) {
  if (!cmd || typeof cmd !== 'string') throw new Error('buildSliceArgv: cmd 不能为空')
  const list = Array.isArray(args) ? args : []

  const enabled = opts.enabled === undefined ? sliceIsolationEnabled() : opts.enabled
  if (!enabled) return { cmd, args: list }   // ★ 返回**原始命令**，不留半包装状态

  const slice = opts.slice || WORKER_SLICE
  const out = [
    '--scope',              // 保留 stdio 管道 + 透传退出码（已实测）
    '--quiet',              // 否则 systemd-run 的提示会污染 NDJSON 的 stdout/stderr
    '--collect',            // 退出即回收瞬时单元，否则会堆成垃圾
    `--slice=${slice}`,
  ]
  if (opts.unit) out.push(`--unit=${sanitizeUnit(opts.unit)}`)
  // ★ `--` 必须有：codex/kimi 的参数里可能出现 -x/--flag，没有分隔符会被 systemd-run 吃掉。
  out.push('--', cmd, ...list)
  return { cmd: 'systemd-run', args: out }
}

/**
 * 包一层 spawn：隔离失败时**明确记录**再退回原路径。
 *
 * 为什么不静默退回：隔离一旦悄悄失效，外表完全正常（会话照常跑），
 * 只是控制面又被 worker 挤在同一个 cgroup 里 —— 直到下一次节流才发现。
 * 「静默降级」是这类改造最典型的失败方式。
 */
export function spawnInSlice(spawnFn, cmd, args = [], spawnOpts = {}, opts = {}) {
  const plan = buildSliceArgv(cmd, args, opts)
  if (plan.cmd === cmd) return spawnFn(cmd, plan.args, spawnOpts)  // 隔离已关闭
  try {
    const p = spawnFn(plan.cmd, plan.args, spawnOpts)
    // spawn 是异步的，ENOENT 会以 error 事件到达，不会同步抛
    p.once?.('error', (e) => {
      console.error(`[slice] systemd-run 拉起失败（${e?.code || e?.message}）——` +
        `本次子进程未被隔离，控制面仍与它共享 cgroup。cmd=${cmd}`)
    })
    return p
  } catch (e) {
    console.error(`[slice] systemd-run 不可用（${e?.message}），退回直接拉起：${cmd}`)
    return spawnFn(cmd, args, spawnOpts)
  }
}
