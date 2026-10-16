import { describe, it, expect } from 'vitest'
import { isLiveHubResponse, HUB_PROBE_TIMEOUT_MS } from './probe'

const res = (ok: boolean, ct: string | null) =>
  ({ ok, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? ct : null) } })

describe('数据源探测：判据必须是「JSON」而不是「res.ok」', () => {
  it('真 Hub：200 + application/json → live', () => {
    expect(isLiveHubResponse(res(true, 'application/json; charset=utf-8'))).toBe(true)
    expect(isLiveHubResponse(res(true, 'application/json'))).toBe(true)
  })

  it('★ 200 + text/html 必须判为不可达——SPA fallback 会把 /api/state 兜底成 index.html', () => {
    // `vite dev` 没配 proxy 时，Vite 的 SPA fallback 对 Accept:*/* 也兜底 ⇒ /api/state 回 200+HTML。
    // 旧判据 `res.ok` 于是为真 → 选中 ApiHubClient → 每 3s 在 HTML 上 res.json() 抛错被吞 →
    // store 永远是空的 → **一块空白看板，且不会自动升级**（升级探测器只在 mock 态才启动）。
    expect(isLiveHubResponse(res(true, 'text/html'))).toBe(false)
    expect(isLiveHubResponse(res(true, 'text/html; charset=utf-8'))).toBe(false)
  })

  it('没有 content-type 头也不能当 live', () => {
    expect(isLiveHubResponse(res(true, null))).toBe(false)
    expect(isLiveHubResponse(res(true, ''))).toBe(false)
  })

  it('非 2xx 一律不可达（401 登录网关 / 502 上游挂）', () => {
    expect(isLiveHubResponse(res(false, 'application/json'))).toBe(false)
    expect(isLiveHubResponse(res(false, 'text/html'))).toBe(false)
  })
})

describe('探测超时必须宽于接口真实耗时', () => {
  it('★ 阈值 > 4s——公网 /api/state 实测 2.34~3.96s，卡 2.5s 等于抛硬币', () => {
    // 2026-08-01 实测（带 cookie 打 https://webagents.jeanron100.top/api/state，80KB 载荷）：
    //   3.96s / 2.34s / 2.34s
    // 旧值 2500ms 落在这个区间正中间 ⇒ 冷加载随机回退 mock ⇒ 真实会话显示「会话不存在」。
    // 这条断言是护栏：谁把阈值调回去，这个测试就红。
    expect(HUB_PROBE_TIMEOUT_MS).toBeGreaterThan(4000)
  })
})
