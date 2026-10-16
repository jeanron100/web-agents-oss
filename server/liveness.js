// server/liveness.js — 接管/恢复的「活体判定」纯函数（零依赖、可单测）。
//
// 回答一个问题：**这个会话此刻是否真有一个活的写者？** 有 → 接管会造成双进程写同一 JSONL、
// 状态损坏，必须拦；没有 → 必须放行，否则用户在「该会话正在终端中运行」前面一条出路都没有。
//
// ⚠️ 别退回「只看 mtime」。**文件新 ≠ 有人在写**：touch / rsync -a / 备份工具动一下 mtime，
// 会话就被锁死，而那台机上可能根本没有任何进程在跑它。
// （2026-07-12 实况：为验证性能修复对生产 JSONL 跑了 60s 的 touch 循环，直接把用户的
//  「恢复会话」按死，报「正在终端中运行」——而根本没有终端在跑它。）
//
// 两条 /proc 证据缺一不可：
//   ① realIdInProc —— 存在 `claude --resume <realId>`：显式续接同一会话（可能在任意 cwd）；
//   ② cwdHasClaude —— 存在 cwd 命中本项目的 claude 进程：**新建**会话的进程 cmdline 里没有 uuid，
//      ① 抓不到它，只能靠 cwd。
// mtime 只作为 ② 的**佐证**（进程在、且文件确在动 = 真在写；进程在但文件半天没动 = 挂起/僵尸，
// 交给 force 由用户裁决），它自己**不构成拦截理由**。

/**
 * @param realIdInProc  /proc 里存在 `claude --resume <realId>` 的进程
 * @param cwdHasClaude  /proc 里存在 cwd == 会话 cwd 的 claude 进程
 * @param ageMs         JSONL 距今多久没写（now - mtime）
 * @param windowMs      "进程在 + 近期在写" 的时间窗（agent 用 WAITING_WINDOW_MS = 30min）
 */
export function decideLiveWriter({ realIdInProc, cwdHasClaude, ageMs, windowMs }) {
  if (realIdInProc) return true      // ① 有进程显式攥着这个会话 —— 铁证
  if (!cwdHasClaude) return false    // 该项目没有任何 claude 进程 —— 不可能有人在写它
  return ageMs < windowMs            // ② 进程在，且文件近期确在动
}
