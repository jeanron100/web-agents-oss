// 「AI 工作量」量化：把一堆 agent 的累计活跃时长，换算成人能直接体感的单位。
//
// 用户诉求原话：「它们运行了 100 个小时，而一天就 24 小时，那么 AI 使用的程度就相当于
// 干了 3~5 天，有个量化效果就行。」——不要精确，要的是"规模感"。
//
// ⚠️ 诚实边界：这里的 activeMs 是**密集活跃时长**（相邻回合间隔 < 5min 才计，见 agent.js
// ACTIVE_GAP_MS）。它**保守**——一个回合里 agent 闷头跑 20 分钟只算作两端点间隔、长思考不计。
// 所以这是"至少干了这么多"，不是"满打满算"。别把它当精确工时卖，UI 上要标清楚口径。
//
// 两种换算，对应两种"几天"：
//   · 满负荷天 = 小时 / 24 —— 用户说的那个「一天 24 小时，相当于 N 天」（机器不眠不休）
//   · 人力工作日 = 小时 / 8 —— 更贴近"一个人要干几天活"（按 8h 工作制）
// 两个都给，因为它们回答的是不同的问题，且并行的意义只有摆在一起才看得出来。

const HOUR_MS = 3_600_000

export type Workload = {
  hours: number        // 累计活跃小时（一位小数）
  fullDays: number     // ÷24：满负荷不间断天数
  personDays: number   // ÷8：折算人力工作日
}

export function quantifyWorkload(activeMs: number): Workload {
  const hours = Math.max(0, activeMs) / HOUR_MS
  const round1 = (n: number) => Math.round(n * 10) / 10
  return {
    hours: round1(hours),
    fullDays: round1(hours / 24),
    personDays: round1(hours / 8),
  }
}

/** 一句话概括，给卡片副标题用。activeMs=0 时给一句不尴尬的空态。 */
export function workloadSentence(activeMs: number): string {
  const w = quantifyWorkload(activeMs)
  if (w.hours < 0.1) return '本时段暂无活跃记录'
  return `≈ 满负荷不间断 ${w.fullDays} 天，或 ${w.personDays} 个人力工作日（8h/天）`
}
