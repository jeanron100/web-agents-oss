// 会话闸门饱和度 —— 2026-07-19 事故的前端收尾。
//
// 那天用户新建 / 恢复会话一律「超时」，界面上**没有任何线索**指向真因：
// 232 的派生闸门满了（8/8），所有请求都在排队。后端其实一直在报
// `server.sessionGate = {active, max, queued, queueWaitMs}`，只是这条信息
// 先被 hub 的 servers 投影丢掉，又从来没在 UI 上出现过。
//
// 「超时」是症状，「并发已满」才是原因。用户看得到原因，才知道该等一下还是去释放几个会话。
import { describe, it, expect } from 'vitest'
import { gateSaturation } from './gate'

describe('gateSaturation', () => {
  it('闸门满 → 标记饱和，并说清还要等多久', () => {
    const g = gateSaturation({ active: 8, max: 8, queued: 2, queueWaitMs: 45_000 })
    expect(g.full).toBe(true)
    expect(g.label).toContain('8/8')
    expect(g.label).toContain('2')
  })

  it('★ 有空槽 → 不饱和（别把正常状态渲染成告警，狼来了喊多了就没人信）', () => {
    expect(gateSaturation({ active: 3, max: 8, queued: 0, queueWaitMs: 45_000 }).full).toBe(false)
  })

  it('★ 满了但队列为空 → 仍算饱和：下一个请求就会排队', () => {
    const g = gateSaturation({ active: 8, max: 8, queued: 0, queueWaitMs: 45_000 })
    expect(g.full).toBe(true)
  })

  it('★ 缺字段 / 老版本 agent 没上报 → 一律当作「不知道」，绝不渲染成饱和', () => {
    // 未升级的节点不该被显示成"并发已满"——那是凭空捏造的告警
    expect(gateSaturation(null).full).toBe(false)
    expect(gateSaturation(undefined).full).toBe(false)
    expect(gateSaturation({} as never).full).toBe(false)
    expect(gateSaturation(null).label).toBe('')
  })

  it('接近上限时给出预警（还没满，但只剩一个槽）', () => {
    const g = gateSaturation({ active: 7, max: 8, queued: 0, queueWaitMs: 45_000 })
    expect(g.full).toBe(false)
    expect(g.tight).toBe(true)
  })
})
