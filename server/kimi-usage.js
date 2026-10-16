// Kimi 订阅额度取数：驱动 kimi TUI 的 /usage 斜杠命令，解析 Plan usage。
//
// 为什么要绕 tmux —— 三条更直接的路都试过，全不通（2026-08-01 实测，别再走一遍）：
//   ① `kimi -p "/usage"` → -p 是**提示词**模式，斜杠命令不被执行，模型反而跑去查文档；
//      （这点和 Claude 不同：`claude --print "/usage"` 是真执行命令的。）
//   ② ACP `session/prompt` 发 "/usage" → 只回 `Session usage: Context: 0 / 262,144`，
//      **不含 Plan usage**（周/5h 额度）；ACP 的 available_commands 里那个 usage 只管 token。
//   ③ 云端 REST：二进制里能搜到 "/oauth/usage" 与 "/plan"，但 api.kimi.com/coding/v1、
//      auth.kimi.com、platform.kimi.{com,ai} 五个 host 组合全 404，靠猜不划算。
// 只有 TUI 里有完整的 Plan usage，所以驱动 TUI。本质和 usage-limits.js 解析
// `claude --print /usage` 的人类可读输出是同一路数。
//
// 输出与 Claude 侧刻意同构（都是 5h 窗 + 周窗 + resets），前端三块额度卡才能统一渲染。

export const DEFAULT_KIMI_BIN = '"$(command -v kimi || printf %s \"$HOME/.kimi-code/bin/kimi\")"'
export const KIMI_TMUX_SOCK = 'wa-kimi-usage'

/**
 * tmux 一次性会话跑 kimi → 关掉可能的升级弹窗 → 发 /usage → 抓屏 → 清理。
 *
 * ⚠️ 那个 Escape **不是保险起见，是必须的**（2026-08-02 用户报「kimi 额度怎么不显示了」）：
 * kimi 0.31.0 启动时会弹升级确认菜单，默认高亮**第一项**：
 *     ❯ Install update now (0.31.1)
 *       Continue with current version
 *       ↑↓ choose · Enter confirm · Esc continue
 * 我们原来直接 send-keys `"/usage" Enter`，那个 Enter 按下的是【立即安装升级】——
 * 于是 /usage 从未被执行（额度显示 —），而且**每次探测都在触发一次 kimi 自升级**。
 * 探测器带副作用，比测不到更糟。TUI 自己写着 Esc 可跳过，就用它。
 */
/**
 * Kimi 额度探针命令（tmux 驱动 TUI 抓屏）。
 *
 * ★★ 2026-08-30 事故整改 R5：原实现是一串 `;` 拼接的固定 sleep，**没有任何上界**——
 *   任何一步挂住整条就一直往下拖。实测：一次跑了 **428 秒**（本该 22 秒），
 *   另有一个探针**存活 26.6 小时**，而它依赖的 tmux server 早就不存在了。
 *   ⚠️ 而 agent 侧的 `process.kill(-pid)` **打不到 tmux**：tmux 会 daemonize（PPID=1），
 *     进程组杀法从来就没打中过它（CLAUDE.md 记过这条）。所以上界必须做在命令内部。
 *
 * 四道闸，缺一不可：
 *  ① `timeout` 给整条硬上界（外部的 EXEC_TIMEOUT 跑在被节流的 agent 进程里，靠不住）
 *  ② 开跑前先 `kill-server` 清掉**上一轮的孤儿**（26.6 小时那条就是这么留下的）
 *  ③ 每个依赖 session 的步骤前 `has-session || exit` —— 会话没了就立刻退，别继续睡完剩下的
 *  ④ `trap` 保证被超时杀掉时也清理，否则 tmux server 会留下来变成下一个孤儿
 */
export function kimiUsageCmd({ bin = DEFAULT_KIMI_BIN, sock = KIMI_TMUX_SOCK, boot = 12, settle = 8, hardTimeout } = {}) {
  const s = 'wa_ku_$$'
  const T = (() => {
    const n = Number(hardTimeout)
    // 默认给内部 sleep 总和的 2 倍 + 20s 余量；小于总和就等于探针永远拿不到结果。
    return Number.isFinite(n) && n > boot + settle + 2 ? n : (boot + settle + 2) * 2 + 20
  })()
  const alive = `tmux -L ${sock} has-session -t ${s} 2>/dev/null || exit 0`
  const body = [
    // ② 先清孤儿：上一轮若被超时杀掉，tmux server 会留着（daemonize，进程组杀不到）
    `tmux -L ${sock} kill-server 2>/dev/null || true`,
    // ④ 无论怎么退出都清理
    `trap 'tmux -L ${sock} kill-server 2>/dev/null || true' EXIT`,
    `tmux -L ${sock} new-session -d -s ${s} -x 200 -y 50 -c /tmp ${bin}`,
    `sleep ${boot}`,
    alive,                                        // ③ 依赖对象没了就立即退
    `tmux -L ${sock} send-keys -t ${s} Escape`,   // 关掉升级弹窗；没有弹窗时 Esc 无害
    `sleep 2`,
    alive,
    `tmux -L ${sock} send-keys -t ${s} "/usage" Enter`,
    `sleep ${settle}`,
    alive,
    `tmux -L ${sock} capture-pane -p -t ${s}`,
    `tmux -L ${sock} kill-session -t ${s} 2>/dev/null || true`,
  ].join('; ')
  // ① 硬上界：外部 EXEC_TIMEOUT 的定时器跑在 agent 自己进程里，agent 被饿死时它不响。
  //    这里的 timeout 是独立进程，不受 agent 死活影响。
  return `timeout ${T} sh -c ${JSON.stringify(body)}; true`
}

// `Weekly limit  ███░░░  14% used  resets in 5d 4h 42m`（可能被 tmux 边框 │ 包着）
// ⚠️ 必须带 m 标志：真机输出每行以 tmux 边框 `│` 收尾，靠 `│` 就能收住；但没有边框时
// （窄屏 / 别的抓屏方式）行尾是 \n，无 m 的 `$` 只认串尾 ⇒ 整条匹配失败、返回 null。
// ⚠️ 窗口**标签不写死**（2026-09-27：上游把 Weekly 换成了 Monthly，写死 Weekly 就静默拿不到
// 长窗——与 Codex 额度窗口「上游改过不止一次」同一条教训）。名字从数据里解析出来，
// 长窗附带原始 label（Weekly/Monthly/没见过的新名字都如实带上），由前端决定怎么标。
const WIN_ANY = /([a-z0-9]+)\s+limit[^\n%]*?(\d+)%\s*used(?:[^\n]*?resets\s+in\s+([0-9dhm ]+?))?\s*(?:│|$)/gim

/**
 * 解析 kimi TUI 的 /usage 输出 → { session, week }（任一可为 null；week 附 label）。
 * ⚠️ 必须先切到 `Plan usage` 段再抓百分比：它上面的 `Context window` 那行也带 `0%`，
 * 全文抓第一个 % 会稳定抓错（测试里钉死了这条）。
 */
export function parseKimiUsage(txt) {
  const s = String(txt || '')
  const at = s.search(/Plan\s+usage/i)
  if (at < 0) return null
  const seg = s.slice(at)
  const wins = []
  for (const m of seg.matchAll(WIN_ANY)) {
    wins.push({ name: m[1].toLowerCase(), label: m[1], pct: Number(m[2]), resets: (m[3] || '').trim() || null })
  }
  if (!wins.length) return null
  const short = wins.find((w) => w.name === '5h') ?? null
  const long = wins.find((w) => w.name !== '5h') ?? null
  if (!short && !long) return null
  return {
    session: short && { pct: short.pct, resets: short.resets },
    week: long && { pct: long.pct, resets: long.resets, label: long.label },
  }
}

/**
 * 跑一次探测。exec 由调用方注入（hub 走 agent 的 /api/exec，与 Claude 额度同机制）。
 * 返回 {ok:true,data} 或 {ok:false,error}——不抛，失败态由前端显示，不静默沿用旧值。
 */
export async function runKimiUsageProbe({ exec, cmd = kimiUsageCmd() }) {
  let out
  try { out = await exec(cmd) } catch (e) { return { ok: false, error: String(e?.message || e) } }
  const data = parseKimiUsage(out)
  if (!data) {
    if (/login|not\s+logged|unauthor/i.test(String(out || ''))) return { ok: false, error: '未登录（在该服务器执行 kimi login）' }
    return { ok: false, error: '未解析到 Plan usage（kimi 版本或输出格式变了？）' }
  }
  return { ok: true, data }
}
