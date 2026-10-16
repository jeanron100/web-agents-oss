import type { Session } from '../types'

/**
 * 长回合"停更"看门狗（稳定性盘点 gap #5，纯前端软提示，不做后端强制超时）。
 *
 * 背景：driver（Claude/Codex）都没有"N 分钟无新增事件即怀疑挂起"的判定——`state==='running'`
 * 会一直信任下去。A5/A6 场景里（SDK 子进程挂起、Codex turn/start RPC 60s 超时未捕获后再未拨回）
 * 会话会永久停在 running，前端只会无上限地涨"已用 Ns"，无法区分"真在长推理"和"底层已死"。
 *
 * 这里只做**看板/卡片层的软提示**：平台 running 会话距上次活动超过阈值即打"可能卡住"标，
 * 让"感觉会话中断了"这件事对用户可见、可一键中断。措辞刻意留有余地（"可能仍在处理或已卡住"），
 * 因为长时间无事件也可能是正常的长工具执行——软提示不误杀真回合，最终判断权仍在用户。
 *
 * 仅限 origin==='platform'：影子会话的 running 必然是 90s 内有 JSONL 写入（否则 shadowStateOf
 * 早已把它落到 idle），天然不会"停更"，无需提示。
 */
export const STALL_HINT_SECS = 180

/** 平台 running 会话距上次活动的秒数；非"可能卡住"的候选（非平台/非 running）返回 0 */
export function stallSecs(session: Session, nowMs: number): number {
  if (session.origin !== 'platform' || session.state !== 'running') return 0
  return Math.max(0, Math.round((nowMs - session.lastActiveAt) / 1000))
}

/** 是否越过"可能卡住"阈值 */
export function isStalled(session: Session, nowMs: number): boolean {
  return stallSecs(session, nowMs) > STALL_HINT_SECS
}
