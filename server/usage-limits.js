// 订阅额度（官方 /usage 的 5h 会话窗口 % + 本周 %）——解析与探测编排。
//
// 为什么单独成模块：hub 里原来是内联的正则 + execFile，失败被 `if (p)` 和 `(_err, …)`
// 双重吞掉，坏了 18 小时无人知（2026-07-26 事故）。拆出来是为了**能单测失败路径**。
//
// 探测**不在 hub 本机跑**：hub 2026-07-19 迁到 .189.4，那台机的 claude 未登录。
// 官方 /usage 是账号级数据，任一台已登录的机器探一次即可 ⇒ 委派给 .232 代跑。
// 走已有的 /api/exec 通道，从而 agent 侧零改动零重启（重启 .232 agent 会杀掉同 cgroup
// 的运维会话并截断该机所有平台会话的当前回合，见 CLAUDE.md）。

/** 代跑机的 serverId。换机器改 env WA_USAGE_SERVER，不用改代码。 */
export const DEFAULT_USAGE_SERVER = ''

/**
 * 探测命令。三个细节都是实测踩出来的，别精简：
 *  - `HOME=/root`：agent 的 systemd 环境里**没有 HOME**，缺了它 `$HOME/.local/bin` 会
 *    退化成 `/.local/bin`，裸 `claude` 直接 command not found。
 *  - 绝对路径：同上，PATH 里不一定有。
 *  - `< /dev/null`：不给 stdin 的话 claude 要空等 3 秒再打一行 warning（11.9s → ~9s）。
 *  - **`cd $PROBE_CWD`（2026-08-20 加）**：Claude Code 会按 **cwd** 编码，把**每一次**调用
 *    都当成一个会话完整落盘到 `~/.claude/projects/<编码后的 cwd>/`，一次约 11KB。
 *    本探针 5 分钟跑一次 = 288 次/天，26 天在 .232 的 `~/.claude/projects/-root/` 攒了
 *    **8,195 个文件 / 146MB**，而那台磁盘已到 94%。这些记录**没有任何人读**——
 *    我们只要 stdout 里那几个百分比。
 *    ⇒ 固定到一个专用 scratch cwd，好处是该目录**在语义上只可能装探针残留**，
 *      可以整目录安全清空；而 `-root` 里混着真实的交互会话（实测 8197 个里有 2 个是），
 *      在那里做清理永远要先逐个判别内容，迟早误删。
 *    配套清理见 `server/usage-probe-guard.sh`（cron 每小时）。
 */

export const USAGE_PROBE_CWD = '/tmp/wa-usage-probe'
/**
 * ⚠️ **别把 claude 路径写死**（2026-08-21 发现的第二个实例）：原来这里硬编码
 * `/root/.local/bin/claude`，而 srv-177-188 上根本没有这个文件 ⇒ 该机的 Claude 额度探测
 * **一直静默失败**，而界面只是显示不出数字、不报错。与 driver.js 共用 claude-bin.js 的解析
 * （它会真的探一次 --version，"存在"不算数）。解析不到时保留原路径当占位——
 * 让命令以"文件不存在"失败，比拼出一条 `undefined --print /usage` 更容易看懂。
 */
export const DEFAULT_USAGE_CMD =
  `mkdir -p ${USAGE_PROBE_CWD} && cd ${USAGE_PROBE_CWD} && BIN="$(command -v claude || true)" && { [ -n "$BIN" ] || BIN="$HOME/.local/bin/claude"; "$BIN" --print /usage < /dev/null; }`

/**
 * 解析 `claude --print /usage` 的输出。纯函数。
 * 拿不到百分比一律返回 null——**绝不能**因为"跑成功了"就编出 0%。
 * @returns {{session:{pct,resets}|null, week:{pct,resets}|null, weekSonnet:{pct,model}|null}|null}
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * 归一 resets 字符串。纯函数。
 *
 * ★ 为什么需要（2026-09-08 实测）：同一个重置时刻，上游会在两种写法之间来回跳 ——
 *   .189.4 近两日 417 个采样点里 "Sep 10, 11:59am" 出现 113 次、"Sep 10, 12pm" 304 次。
 *   显示上只是抖一下，但**任何拿 resets 当窗口标识的逻辑都会被它切碎**。
 *   我排查配额问题时就被它骗过一次：先按「resets 变了 = 真重置」判定，
 *   据此断言两次归零是数据 bug —— 结论完全是错的（用户确认那是真重置）。
 *   ⇒ 判据里用到的字段，先把它的等价形式收敛掉，否则判据本身就是坏的。
 *
 * 只归一「差一分钟的同一边界」这一种情形，其余原样返回（宁可不归一，也不能把不同时刻合并）。
 */
export function normalizeReset(raw) {
  const s = String(raw ?? '').trim()
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*11:59(am|pm)(\s*\(.*\))?$/i.exec(s)
  if (!m) return s
  const [, mon, day, ap, tz = ''] = m
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === mon.toLowerCase())
  if (mi < 0) return s
  // 11:59am → 同日 12pm（不跨日，最常见的那种）
  if (ap.toLowerCase() === 'am') return `${MONTHS[mi]} ${Number(day)}, 12pm${tz}`
  // 11:59pm → 次日 12am。要跨月/跨年，所以借 Date 算，年份取「离现在最近」的那个
  //（重置时刻总在一周内，唯一的边角是 12/31→1/1）。
  const now = new Date()
  let best = null
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(y, mi, Number(day))
    if (Number.isNaN(d.getTime())) continue
    if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d
  }
  if (!best) return s
  best.setDate(best.getDate() + 1)
  return `${MONTHS[best.getMonth()]} ${best.getDate()}, 12am${tz}`
}

export function parseUsage(txt) {
  const s = String(txt || '')
  const sess = /Current session:\s*(\d+)%\s*used\s*·\s*resets\s*([^\n]+)/i.exec(s)
  const week = /Current week \(all models\):\s*(\d+)%\s*used\s*·\s*resets\s*([^\n]+)/i.exec(s)
  // 第三行是"次级模型"窗口。官方模型名会变（曾是 Sonnet only，现在是 Fable），
  // 所以**不能写死名字**——写死过一次，结果第三格恒空、DB 里 sonnet 列 25 天全 null。
  // 负向前瞻排掉 all models 那行，其余括号内容整个当模型名捕获。
  const other = /Current week \(((?!all models)[^)]+)\):\s*(\d+)%/i.exec(s)
  if (!sess && !week) return null
  return {
    session: sess ? { pct: +sess[1], resets: normalizeReset(sess[2]) } : null,
    week: week ? { pct: +week[1], resets: normalizeReset(week[2]) } : null,
    weekSonnet: other
      ? { pct: +other[2], model: other[1].trim().replace(/\s+only$/i, '') }
      : null,
  }
}

/** 把原始输出翻成人能看懂的失败原因（要送到前端 tooltip 上的）。 */
function explainFailure(txt) {
  const s = String(txt || '')
  if (!s.trim()) return '探测无输出（命令没跑起来？）'
  if (/Not logged in/i.test(s)) return `未登录：探测机的 claude 需要重新 /login`
  if (/Invalid API key|authentication_error|401/i.test(s)) return '认证失败：探测机的 claude 凭据已失效'
  return `输出里找不到用量百分比：${s.trim().slice(0, 120)}`
}

/**
 * 跑一次探测并解析。exec 由调用方注入（hub 注入"POST 到 agent 的 /api/exec"），
 * 便于单测失败路径，也便于以后换传输方式。
 * @param {{exec: () => Promise<string>}} deps
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function runUsageProbe({ exec }) {
  let out
  try {
    out = await exec()
  } catch (e) {
    // 不加「探测失败：」前缀——调用方（hub 日志、前端横幅）已经在说"额度取数失败"了，
    // 再叠一层就成了「额度取数失败：探测失败：未知取数机…」。实测点火时发现的。
    return { ok: false, error: String(e?.message || e) }
  }
  const data = parseUsage(out)
  if (!data) return { ok: false, error: explainFailure(out) }
  return { ok: true, data }
}
