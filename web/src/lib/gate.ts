// 会话派生闸门的饱和度 → 一句人能看懂的话。
//
// 背景（2026-07-19）：232 的闸门满在 8/8，用户新建/恢复会话全部「超时」，
// 而「超时」这个词把真因盖死了——用户以为是网络或服务挂了，实际只是并发满了、在排队。
// 后端一直有 sessionGate 数据，缺的只是把它说出来。
//
// 一条纪律：**不知道就别喊**。老版本 agent 不上报 sessionGate，此时必须当作"未知"渲染成正常，
// 绝不能凭空显示成"并发已满"——假告警比没告警更伤信任。

export interface SessionGate {
  active: number
  max: number
  queued: number
  queueWaitMs: number
}

export interface GateSaturation {
  /** 槽位已用尽：下一个派生请求一定会排队 */
  full: boolean
  /** 只剩最后一个槽位：还能派生，但快满了 */
  tight: boolean
  /** 给人看的一句话；未知时为空串（调用方据此决定不渲染） */
  label: string
}

const UNKNOWN: GateSaturation = { full: false, tight: false, label: '' }

export function gateSaturation(gate: SessionGate | null | undefined): GateSaturation {
  if (!gate || typeof gate.active !== 'number' || typeof gate.max !== 'number' || gate.max <= 0) {
    return UNKNOWN // 老节点没上报 → 未知 → 按正常渲染，不制造假告警
  }
  const { active, max, queued = 0, queueWaitMs = 0 } = gate
  const full = active >= max
  if (!full) {
    return { full: false, tight: active >= max - 1, label: `并发 ${active}/${max}` }
  }
  const waitS = Math.round(queueWaitMs / 1000)
  const queueHint = queued > 0 ? `，前面 ${queued} 位排队` : ''
  const waitHint = waitS > 0 ? `，最多等 ${waitS}s` : ''
  return { full: true, tight: true, label: `并发已满 ${active}/${max}${queueHint}${waitHint}` }
}
