// Codex 额度窗口的归位（2026-09-08 用户实拍「数据反了」）。纯函数。
//
// ★★ 根因不是「写反了」，是**把上游结构当常量写死了**。
//   `UsageRow.tsx` 原先写死：secondary → 5h 格、primary → 本周格。
//   那在 2026-07-15 的观察下是对的（当时 OpenAI 取消 5h 窗，primary 变周窗、secondary=null，
//   CLAUDE.md 也是这么记的）。但上游又改回去了，实测：
//       primary   : pct=0, windowMin=300    ← 5 小时
//       secondary : pct=3, windowMin=10080  ← 7 天
//   于是周用量 3% 被画进「5h」格、「本周」显示 0% —— 正好颠倒。
//
// ★ 所以修法**不是把映射对调**（那只是把赌注押到另一边，上游再变一次还会错），
//   而是按数据自带的 `windowMin` 归位：位置怎么换都不会错。
//   本仓库同族教训：「先升级客户端再下结论，别把『我们的工具过时了』误判成『上游没有了』」——
//   上游结构会变，**凡是能从数据里读出来的，就别写进代码里**。

export type CodexWin = { pct: number; windowMin?: number | null; resets?: string | null; resetsAt?: number | null } | null

/** 窗口长度 → 人看的标签。与 CodexUsageSummary 的 winLabel 同口径。 */
export function windowLabel(min?: number | null): string {
  if (!min) return '窗口'                                   // 不猜：没有长度信息就给中性标签
  if (min % 1440 === 0) { const d = min / 1440; return d === 7 ? '本周' : `${d}天` }
  return `${Math.round(min / 60)}h`
}

/**
 * 把账号的两个窗口排成看板上的格子。
 *
 * - 只输出**真实存在**的窗口：硬画一个「5h —」会让人以为坏了（CLAUDE.md 记过，别退回去）
 * - 顺序按 windowMin 升序（短窗在前），与上游给的字段顺序无关
 * - 标签由 windowMin 推出，出现没见过的窗口长度（比如 24h）也如实标注，不硬塞进 5h/本周
 */
export function codexCells(
  a: { primary?: CodexWin; secondary?: CodexWin } | null | undefined,
): Array<{ label: string; win: CodexWin; tip: string }> {
  const wins = [a?.primary, a?.secondary].filter((w): w is NonNullable<CodexWin> => !!w)
  return wins
    .slice()
    .sort((x, y) => (x.windowMin ?? Number.MAX_SAFE_INTEGER) - (y.windowMin ?? Number.MAX_SAFE_INTEGER))
    .map((win) => {
      const label = windowLabel(win.windowMin)
      return { label, win, tip: `${label} 窗口 · 已用 ${win.pct}%` }
    })
}
