type ResetWindow = { resetsAt?: number | null; resets?: string | null } | null | undefined

/** Codex 是秒级时间戳；Kimi 是采集时的倒计时，必须以采集时间为基准。 */
export function usageReset(win: ResetWindow, sampledAt?: number) {
  if (!win) return null
  const raw = win.resets?.trim() ?? ''
  let at = typeof win.resetsAt === 'number' && Number.isFinite(win.resetsAt) && win.resetsAt > 0
    ? win.resetsAt * 1000 : NaN
  if (!Number.isFinite(at) && sampledAt && Number.isFinite(sampledAt) && sampledAt > 0 &&
      raw && /^(?:\d+d\s*)?(?:\d+h\s*)?(?:\d+m\s*)?$/i.test(raw)) {
    const minutes = [...raw.matchAll(/(\d+)([dhm])/gi)].reduce((total, match) =>
      total + Number(match[1]) * ({ d: 1440, h: 60, m: 1 }[match[2].toLowerCase()] ?? 0), 0)
    at = sampledAt + minutes * 60_000
  }
  const date = new Date(at)
  if (Number.isFinite(date.getTime())) {
    const pad = (value: number) => String(value).padStart(2, '0')
    return {
      text: `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
      dateTime: date.toISOString(),
      title: `${date.toLocaleString('zh-CN', { hourCycle: 'h23', timeZoneName: 'short' })}（浏览器本地时间）`,
    }
  }
  // Claude 的文字时间可能自带时区；不把无时区或无年份的字符串猜成绝对日期。
  return { text: raw || '时间未知', dateTime: undefined, title: raw || '上游尚未提供重置时间' }
}
