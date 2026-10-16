// 全站统一成本口径：所有显示的成本都按 token×模型单价「估算」，不混 SDK 实报，
// 保证 看板 / 会话卡片 / 会话详情 / 消耗统计(标题·成本构成·项目行) 处处自洽、能对得上。
// SDK 实报值仅在会话详情作为辅助信息单列、以及对话流逐回合显示。
export type Tok = { input: number; output: number; cacheRead: number; cacheCreate: number }

// 每百万 token 单价(USD)：input / output / cacheRead(≈0.1×in) / cacheWrite(≈1.25×in)
const PRICING: Record<string, [number, number, number, number]> = {
  opus: [5, 25, 0.5, 6.25], sonnet: [3, 15, 0.3, 3.75], haiku: [1, 5, 0.1, 1.25], fable: [10, 50, 1.0, 12.5],
}

export function priceOf(model: string): [number, number, number, number] | null {
  const m = (model || '').toLowerCase()
  if (m.includes('opus')) return PRICING.opus
  if (m.includes('sonnet')) return PRICING.sonnet
  if (m.includes('haiku')) return PRICING.haiku
  if (m.includes('fable') || m.includes('mythos')) return PRICING.fable
  return null // 未知模型(如 Codex 暂无单价) → 不估
}

/** 单个会话的估算成本(USD)。无单价或无 token 明细 → 0。 */
export function estCostOf(s: { model: string; tokensBreakdown?: Tok | null }): number {
  const p = priceOf(s.model); const b = s.tokensBreakdown
  if (!p || !b) return 0
  return (b.input / 1e6) * p[0] + (b.output / 1e6) * p[1] + (b.cacheRead / 1e6) * p[2] + (b.cacheCreate / 1e6) * p[3]
}
