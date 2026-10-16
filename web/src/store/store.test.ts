import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAppStore, getStats, pendingCount, sortSessions, sessionsOfProject, projectHistoryList, PROJECT_HISTORY_LIMIT, projectEngineSession, serverTotals, projectTodayActiveMs, projectPreferredModel, projectHeadSession, projectHeadSessions, resolveReleaseTarget, pickSuccessorSession, visibleSessions, starKey} from './store'
import { fmtTokens } from '../lib/format'
import type { Session, ChatEvent } from '../types'

describe('resolveAction', () => {
  it('审批通过：会话 waiting_approval -> running，待办 resolved', () => {
    const store = createAppStore({ seeded: true })
    const ok = store.getState().resolveAction('a-rm-cache', '允许一次')
    expect(ok).toBe(true)
    const st = store.getState()
    expect(st.pendingActions.find((a) => a.id === 'a-rm-cache')!.status).toBe('resolved')
    expect(st.sessions.find((s) => s.id === 's-infra')!.state).toBe('running')
  })

  it('审批拒绝：会话转 idle', () => {
    const store = createAppStore({ seeded: true })
    store.getState().resolveAction('a-rm-cache', '拒绝')
    expect(store.getState().sessions.find((s) => s.id === 's-infra')!.state).toBe('idle')
  })

  it('幂等：二次处理 no-op 且返回 false，首次结果不被覆盖', () => {
    const store = createAppStore({ seeded: true })
    expect(store.getState().resolveAction('a-rm-cache', '允许一次')).toBe(true)
    expect(store.getState().resolveAction('a-rm-cache', '拒绝')).toBe(false)
    const action = store.getState().pendingActions.find((a) => a.id === 'a-rm-cache')!
    expect(action.resolution).toBe('允许一次')
    expect(store.getState().sessions.find((s) => s.id === 's-infra')!.state).toBe('running')
  })

  it('回答提问：追加用户消息事件，会话转 running', () => {
    const store = createAppStore({ seeded: true })
    const before = (store.getState().events['s-pipeline'] ?? []).length
    store.getState().resolveAction('a-q-migration', '合并迁移')
    const events = store.getState().events['s-pipeline']
    expect(events.length).toBe(before + 1)
    expect(events.at(-1)).toMatchObject({ type: 'user', text: '合并迁移' })
    expect(store.getState().sessions.find((s) => s.id === 's-pipeline')!.state).toBe('running')
  })

  it('验收：不改变会话状态，仅消除待办', () => {
    const store = createAppStore({ seeded: true })
    const before = pendingCount(store.getState().pendingActions)
    store.getState().resolveAction('a-review-billing', '标记完成')
    expect(store.getState().sessions.find((s) => s.id === 's-billing')!.state).toBe('done')
    // 断言"少了一条"，别硬编码总数——seed 是演示数据，会随 demo 内容变；
    // 硬编码会让它每改一次 seed 就假失败一次（这次改 demo 数据就踩了）。
    expect(pendingCount(store.getState().pendingActions)).toBe(before - 1)
  })
})

describe('sendMessage / interrupt', () => {
  it('发送指令：追加用户气泡 + 流式回复占位，会话转 running', () => {
    const store = createAppStore({ seeded: true })
    store.getState().sendMessage('s-crawler', '重新配置 deploy key 再推送')
    const events = store.getState().events['s-crawler']
    expect(events.at(-2)).toMatchObject({ type: 'user' })
    expect(events.at(-1)).toMatchObject({ type: 'assistant', streaming: true })
    expect(store.getState().sessions.find((s) => s.id === 's-crawler')!.state).toBe('running')
  })

  it('tick 推进流式文本直至完成', () => {
    const store = createAppStore({ seeded: true })
    store.getState().sendMessage('s-crawler', '测试')
    for (let i = 0; i < 200; i++) store.getState()._tick()
    const last = store.getState().events['s-crawler'].at(-1)!
    expect(last.type).toBe('assistant')
    if (last.type === 'assistant') {
      expect(last.streaming).toBeFalsy()
      expect(last.text.length).toBeGreaterThan(10)
    }
  })

  it('中断：会话转 idle，流式标记清除', () => {
    const store = createAppStore({ seeded: true })
    store.getState().sendMessage('s-crawler', '测试')
    store.getState().interrupt('s-crawler')
    const st = store.getState()
    expect(st.sessions.find((s) => s.id === 's-crawler')!.state).toBe('idle')
    const last = st.events['s-crawler'].at(-1)!
    if (last.type === 'assistant') expect(last.streaming).toBeFalsy()
  })
})

describe('sessionsOfProject（会话历史 Tab 数据）', () => {
  const mk = (id: string, serverId: string, project: string, lastActiveAt: number): Session => ({
    id, serverId, project, branch: '', engine: 'claude', model: 'Opus', mode: 'auto',
    state: 'idle', summary: id, startedAt: 1, lastActiveAt, cost: 0, tokens: 0, origin: 'shadow',
  })
  const all = [
    mk('a', 'srv-1', 'web_agents', 300),
    mk('b', 'srv-1', 'web_agents', 100),
    mk('c', 'srv-1', 'web_agents', 200),
    mk('d', 'srv-1', 'other_proj', 999),     // 同服务器不同项目 → 排除
    mk('e', 'srv-2', 'web_agents', 999),     // 同名项目不同服务器 → 排除
  ]

  it('只含目标服务器+项目，按 lastActiveAt 倒序', () => {
    const out = sessionsOfProject(all, 'srv-1', 'web_agents')
    expect(out.map((s) => s.id)).toEqual(['a', 'c', 'b'])
  })

  it('跨服务器/跨项目隔离：不串项目，不串同名异服务器', () => {
    const out = sessionsOfProject(all, 'srv-1', 'web_agents')
    expect(out.some((s) => s.id === 'd' || s.id === 'e')).toBe(false)
  })

  it('空结果不报错', () => {
    expect(sessionsOfProject(all, 'srv-9', 'nope')).toEqual([])
  })
})

describe('projectHistoryList（实时 ∪ 冷路径历史）', () => {
  // 2026-08-03 用户实拍：web_agents 磁盘 25 个会话，「会话历史」只列 2 条。
  // 实时列表被服务端 MAX_PER_PROJECT=3 故意截断（3s 轮询热路径，该截断是对的），
  // 冷路径 /api/project/sessions 补历史，二者在 projectHistoryList 汇合。
  const mk = (
    id: string, lastActiveAt: number,
    over: Partial<Session> = {},
  ): Session => ({
    id, serverId: 'srv-1', project: 'web_agents', branch: '', engine: 'claude', model: 'Opus',
    mode: 'auto', state: 'idle', summary: id, startedAt: 1, lastActiveAt, cost: 0, tokens: 0,
    origin: 'shadow', ...over,
  })

  it('★ 核心：历史条目补进来，不再只有被截断的那几条', () => {
    const live = [mk('new1', 900), mk('new2', 800)]
    const hist = [mk('old1', 300), mk('old2', 200), mk('old3', 100)]
    const out = projectHistoryList(live, hist, 'srv-1', 'web_agents')
    expect(out.map((s) => s.id)).toEqual(['new1', 'new2', 'old1', 'old2', 'old3'])
  })

  it('★ 同 id 时实时记录优先——历史行是磁盘快照，state 恒 idle、origin 恒 shadow', () => {
    // 冷路径会把当前正在跑的会话也扫出来（它同样在磁盘上），若让历史行盖住实时行，
    // 正在跑的会话会被显示成 idle、平台会话被显示成影子、「当前」标记错位。
    const live = [mk('same', 500, { state: 'running', origin: 'platform', summary: '实时' })]
    const hist = [mk('same', 500, { state: 'idle', origin: 'shadow', summary: '历史' })]
    const out = projectHistoryList(live, hist, 'srv-1', 'web_agents')
    expect(out).toHaveLength(1)
    expect(out[0].state).toBe('running')
    expect(out[0].origin).toBe('platform')
    expect(out[0].summary).toBe('实时')
  })

  it('跨服务器/跨项目隔离：历史行同样不许串台', () => {
    const live = [mk('a', 900)]
    const hist = [
      mk('x', 800, { project: 'other_proj' }),
      mk('y', 700, { serverId: 'srv-2' }),
      mk('z', 600),
    ]
    const out = projectHistoryList(live, hist, 'srv-1', 'web_agents')
    expect(out.map((s) => s.id)).toEqual(['a', 'z'])
  })

  it('★ 每项目 8 条：需求是"最近 8 个会话（含三引擎）时间倒序"', () => {
    expect(PROJECT_HISTORY_LIMIT).toBe(8)
  })

  it('★ 三引擎混合时仍是严格时间倒序（用户明确要求的排序）', () => {
    const live = [mk('c1', 900, { engine: 'claude' })]
    const hist = [
      mk('k1', 700, { engine: 'kimi' }),
      mk('x1', 800, { engine: 'codex' }),
      mk('c2', 600, { engine: 'claude' }),
    ]
    const out = projectHistoryList(live, hist, 'srv-1', 'web_agents')
    expect(out.map((s) => s.id)).toEqual(['c1', 'x1', 'k1', 'c2'])
    const ts = out.map((s) => s.lastActiveAt)
    expect(ts).toEqual([...ts].sort((a, b) => b - a))
  })

  it('★ 合并结果必须再封顶：实时列表会带来冷路径没有的条目（当前平台会话）', () => {
    // 2026-08-03 真浏览器断言抓到：API 返回 8 条，UI 却渲染 9 行——多出来的正是
    // 当前正在跑的 ps-* 平台会话（冷路径按设计抑制了它的影子孪生）。
    const live = [mk('ps-current', 1000, { origin: 'platform' })]
    const hist = Array.from({ length: 8 }, (_, i) => mk(`h${i}`, 900 - i))
    const out = projectHistoryList(live, hist, 'srv-1', 'web_agents')
    expect(out).toHaveLength(PROJECT_HISTORY_LIMIT)
    expect(out[0].id).toBe('ps-current')   // 最新的在最前
  })

  it('历史还没拉到时退化成实时列表，不报错', () => {
    expect(projectHistoryList([mk('a', 1)], [], 'srv-1', 'web_agents').map((s) => s.id)).toEqual(['a'])
    expect(projectHistoryList([], [], 'srv-1', 'web_agents')).toEqual([])
  })
})

describe('projectEngineSession（三引擎对话流主会话选择器）', () => {
  const mk = (id: string, engine: 'claude' | 'codex' | 'kimi', lastActiveAt: number): Session => ({
    id, serverId: 'srv-1', project: 'web_agents', branch: '', engine, model: 'x', mode: 'auto',
    state: 'idle', summary: id, startedAt: 1, lastActiveAt, cost: 0, tokens: 0, origin: 'shadow',
  })
  const all = [
    mk('c1', 'claude', 100),
    mk('c2', 'claude', 300),
    mk('c3', 'claude', 200),
    mk('x1', 'codex', 150),
  ]

  it('currentId 命中且引擎匹配 → 直接返回该会话（即便不是该引擎里最新的）', () => {
    const out = projectEngineSession(all, 'srv-1', 'web_agents', 'claude', 'c1')
    expect(out?.id).toBe('c1')
  })

  it('currentId 引擎不匹配（如当前是 codex 会话查 claude 流）→ 回退该引擎 lastActiveAt 最新的会话', () => {
    const out = projectEngineSession(all, 'srv-1', 'web_agents', 'claude', 'x1')
    expect(out?.id).toBe('c2')
  })

  it('未传 currentId → 回退该引擎 lastActiveAt 最新的会话', () => {
    const out = projectEngineSession(all, 'srv-1', 'web_agents', 'codex')
    expect(out?.id).toBe('x1')
  })

  it('该项目该引擎无任何会话 → null', () => {
    expect(projectEngineSession(all, 'srv-1', 'web_agents', 'codex', undefined)).not.toBeNull()
    expect(projectEngineSession(all, 'srv-1', 'web_agents', 'kimi')).toBeNull()
    expect(projectEngineSession(all, 'srv-2', 'web_agents', 'codex')).toBeNull()
    expect(projectEngineSession([], 'srv-1', 'web_agents', 'claude')).toBeNull()
  })

  it('有 Kimi 会话时选择项目内最近活跃的一条', () => {
    const withKimi = [...all, mk('k1', 'kimi', 350), mk('k2', 'kimi', 450)]
    expect(projectEngineSession(withKimi, 'srv-1', 'web_agents', 'kimi')?.id).toBe('k2')
  })
})

describe('serverTotals（看板按服务器汇总）', () => {
  // serverTotals 的成本已统一改为 estCostOf 估算（token×单价），不再读 s.cost。
  // 故给 mock 配一个仅含 input 的 breakdown，令估算值精确等于目标 cost：
  // Opus input 单价 = 5/1e6，input = cost×200000 ⇒ estCostOf = input/1e6×5 = cost。
  const mk = (id: string, serverId: string, cost: number, tokens: number): Session => ({
    id, serverId, project: 'p', branch: '', engine: 'claude', model: 'Opus', mode: 'auto',
    state: 'idle', summary: '', startedAt: 1, lastActiveAt: 1, cost, tokens, origin: 'shadow',
    tokensBreakdown: { input: cost * 200000, output: 0, cacheRead: 0, cacheCreate: 0 },
  })
  it('按 serverId 累加 cost/tokens，跨服务器隔离', () => {
    const t = serverTotals([
      mk('a', 'srv-1', 1.5, 1000), mk('b', 'srv-1', 0, 2000), mk('c', 'srv-2', 3, 500),
    ])
    expect(t['srv-1']).toEqual({ cost: 1.5, tokens: 3000 })
    expect(t['srv-2']).toEqual({ cost: 3, tokens: 500 })
  })
})

describe('fmtTokens', () => {
  it('边界格式化', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1500)).toBe('2k')
    expect(fmtTokens(39000)).toBe('39k')
    expect(fmtTokens(1_500_000)).toBe('1.5M')
    expect(fmtTokens(97_036_078)).toBe('97.0M')
  })
})

describe('applyState 引用稳定对账', () => {
  const srv = [{ id: 'srv-1', name: 'srv-1', region: 'r', flag: '🇨🇳', online: true }]
  const mk = (id: string, over: Partial<import('./store').AppState['sessions'][number]> = {}) => ({
    id, serverId: 'srv-1', project: 'p', branch: '', engine: 'claude' as const, model: 'Opus',
    mode: 'auto' as const, state: 'idle' as const, summary: 's', startedAt: 1, lastActiveAt: 1,
    cost: 0, tokens: 0, origin: 'shadow' as const, ...over,
  })

  it('内容完全未变：sessions 返回同一数组引用（空轮询 no-op）', () => {
    const store = createAppStore()
    store.getState().applyState(srv, [mk('a'), mk('b')], [], {})
    const ref1 = store.getState().sessions
    store.getState().applyState(srv, [mk('a'), mk('b')], [], {}) // 同内容再来一遍
    expect(store.getState().sessions).toBe(ref1) // 同引用 → 选择器不触发
  })

  it('仅一项变化：未变项复用旧引用，仅变项换新', () => {
    const store = createAppStore()
    store.getState().applyState(srv, [mk('a'), mk('b')], [], {})
    const [a0, b0] = store.getState().sessions
    store.getState().applyState(srv, [mk('a'), mk('b', { summary: '变了' })], [], {})
    const [a1, b1] = store.getState().sessions
    expect(a1).toBe(a0)       // 未变项：同引用，React.memo 跳过
    expect(b1).not.toBe(b0)   // 变化项：新引用，触发重渲染
    expect(b1.summary).toBe('变了')
  })
})

describe('applyEvents 合并去抖', () => {
  it('乐观用户消息在服务端回写前保留，回写后按文本去重', () => {
    const store = createAppStore()
    const now = Date.now() // 生产里 sendMessage 用 Date.now() 打点，乐观气泡保留走绝对时间窗
    // 先注入一条乐观消息（模拟 sendMessage 追加，id 专属前缀 'opt-'）
    store.setState({ events: { s1: [{ id: 'opt-1', sessionId: 's1', ts: now, type: 'user', text: '你好' }] } })
    // 服务端这轮还没记到 → 乐观消息应保留
    store.getState().applyEvents('s1', [{ id: 'srv-evt-0', sessionId: 's1', ts: now - 5000, type: 'assistant', text: '上一条' }], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.some((e) => e.type === 'user' && e.text === '你好')).toBe(true)
    // 服务端回写了同文本 → 去重，不重复显示
    store.getState().applyEvents('s1', [{ id: 'srv-evt-1', sessionId: 's1', ts: now + 1000, type: 'user', text: '你好' }], { fileChanges: [], todos: [] })
    const users = store.getState().events.s1.filter((e) => e.type === 'user' && e.text === '你好')
    expect(users.length).toBe(1)
  })

  // 回归：修复"我刚发的消息刷一下没了/像幻觉"——助手一开始流式输出（ts 晚于用户消息）时，旧的
  // "e.ts>=最后一条服务端事件"判据会把尚未落盘的乐观用户气泡误删。绝对时间窗必须让它存活。
  it('乐观用户消息在助手以更晚 ts 开始流式回复时仍存活（不被误删）', () => {
    const store = createAppStore()
    const now = Date.now()
    store.setState({ events: { s1: [{ id: 'opt-9', sessionId: 's1', ts: now, type: 'user', text: '帮我改下这个函数' }] } })
    // 助手随后开始流式，其 ts 略晚于用户消息，且用户消息此刻尚未回写进事件流
    store.getState().applyEvents('s1', [{ id: 'srv-a', sessionId: 's1', ts: now + 300, type: 'assistant', text: '好的，我看看…' }], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.some((e) => e.id === 'opt-9' && e.type === 'user' && e.text === '帮我改下这个函数')).toBe(true)
  })

  // 回归（对抗式复核 CONFIRMED）：新建平台会话的服务端【内存】用户事件 id 同为 'ev-' 前缀且【无 seq】
  // (driver.js nid('ev'))——旧实现用 'ev-' 前缀或 seq==null 都分不清，忙会话里一条滚出快照窗口的这种真
  // 用户事件会被误当乐观气泡重钉成幽灵重复。判别改用【专属前缀 'opt-'】：服务端事件是 'ev-' 前缀→不匹配→正确排除。
  it("服务端真实用户事件（ev- 前缀、无 seq，模拟新建平台会话内存事件）滚出窗口时不被重钉", () => {
    const store = createAppStore()
    const now = Date.now()
    store.getState().applyEvents('s1', [
      { id: 'ev-srv-1', sessionId: 's1', ts: now, type: 'user', text: '继续跑' }, // 无 seq，与 driver 内存事件一致
      { id: 'ev-srv-2', sessionId: 's1', ts: now + 100, type: 'assistant', text: 'ok' },
    ], { fileChanges: [], todos: [] })
    // 忙会话下一帧窗口只带更新的事件，真实用户事件 ev-srv-1 已滚出
    store.getState().applyEvents('s1', [
      { id: 'ev-srv-9', sessionId: 's1', ts: now + 5000, type: 'assistant', text: '还在跑…' },
    ], { fileChanges: [], todos: [] })
    // 应随窗口滚走（不出现），而不是被重钉到底部
    expect(store.getState().events.s1.some((e) => e.id === 'ev-srv-1')).toBe(false)
  })

  // 回归：重复发同一句（'继续'/'y'/'ok'）时，刚发的乐观气泡不能被"早先那条已回显的同文本"误去重。
  // 去重只认本轮【新到】(id 不在 prev) 的同文本回显。
  it("重复发相同文本时，刚发的乐观气泡不被早先同文本回显误删", () => {
    const store = createAppStore()
    const now = Date.now()
    // 第一句 '继续' 已被服务端回显（durable，带 seq，在 prev 里）
    store.getState().applyEvents('s1', [
      { id: 'ev-srv-1', sessionId: 's1', ts: now - 3000, type: 'user', text: '继续', seq: '1' },
      { id: 'ev-srv-2', sessionId: 's1', ts: now - 2000, type: 'assistant', text: '好', seq: '2' },
    ], { fileChanges: [], todos: [] })
    // 用户再发一次 '继续' → 乐观气泡 opt-dup（专属前缀、ts=now）
    store.setState({ events: { ...store.getState().events, s1: [...store.getState().events.s1, { id: 'opt-dup', sessionId: 's1', ts: now, type: 'user', text: '继续' }] } })
    // 下一帧还只带旧的那条 '继续'（第二条的回显还没落盘）→ 乐观气泡必须留住
    store.getState().applyEvents('s1', [
      { id: 'ev-srv-1', sessionId: 's1', ts: now - 3000, type: 'user', text: '继续', seq: '1' },
      { id: 'ev-srv-2', sessionId: 's1', ts: now - 2000, type: 'assistant', text: '好', seq: '2' },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.some((e) => e.id === 'opt-dup')).toBe(true)
    // 第二条的真回显到达（新 id）→ 此时才去重，不重复
    store.getState().applyEvents('s1', [
      { id: 'ev-srv-1', sessionId: 's1', ts: now - 3000, type: 'user', text: '继续', seq: '1' },
      { id: 'ev-srv-2', sessionId: 's1', ts: now - 2000, type: 'assistant', text: '好', seq: '2' },
      { id: 'ev-srv-3', sessionId: 's1', ts: now + 500, type: 'user', text: '继续', seq: '3' },
    ], { fileChanges: [], todos: [] })
    const jixu = store.getState().events.s1.filter((e) => e.type === 'user' && e.text === '继续')
    expect(jixu.length).toBe(2) // 两条真实的 '继续'，乐观气泡已被第二条回显换掉，不重复
  })

  it('已渲染事件按 id 复用引用（滚动/DOM 稳定）', () => {
    const store = createAppStore()
    const ev = { id: 'srv-evt-9', sessionId: 's1', ts: 10, type: 'assistant' as const, text: 'hi' }
    store.getState().applyEvents('s1', [ev], { fileChanges: [], todos: [] })
    const ref0 = store.getState().events.s1[0]
    store.getState().applyEvents('s1', [{ ...ev }], { fileChanges: [], todos: [] }) // 同内容新对象
    expect(store.getState().events.s1[0]).toBe(ref0) // 复用旧引用
  })
})

describe('appendEvents 增量合并 (Phase 2 §4.4 断线续传)', () => {
  it('append 携带新 durable 事件：upsert 追加在已有事件之后', () => {
    const store = createAppStore()
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 10, type: 'user', text: 'hi', seq: '1' },
    ], { fileChanges: [], todos: [] })
    store.getState().appendEvents('s1', [
      { id: 'e2', sessionId: 's1', ts: 20, type: 'assistant', text: 'hello', seq: '2' },
    ], { fileChanges: [], todos: [] })
    const events = store.getState().events.s1
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('既有流式事件（无 seq）在 append 重发同 id 终态后被替换，不重复', () => {
    // 模拟 Codex：流式 assistant 事件 id 不变，append 帧把它的终态（带 seq）重新整份发来
    const store = createAppStore()
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 10, type: 'user', text: 'hi', seq: '1' },
      { id: 'stream-1', sessionId: 's1', ts: 15, type: 'assistant', text: '思考中', streaming: true },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.map((e) => e.id)).toEqual(['e1', 'stream-1'])

    store.getState().appendEvents('s1', [
      { id: 'stream-1', sessionId: 's1', ts: 15, type: 'assistant', text: '思考完成', seq: '2' },
    ], { fileChanges: [], todos: [] })
    const events = store.getState().events.s1
    expect(events.map((e) => e.id)).toEqual(['e1', 'stream-1'])
    const finalEv = events.find((e) => e.id === 'stream-1')!
    expect(finalEv).toMatchObject({ type: 'assistant', text: '思考完成', seq: '2' })
  })

  it('既有流式事件（无 seq）在 append 未重发时被丢弃（Claude：流式片段以新 id 终态落盘）', () => {
    const store = createAppStore()
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 10, type: 'user', text: 'hi', seq: '1' },
      { id: 'stream-1', sessionId: 's1', ts: 15, type: 'assistant', text: '思考中', streaming: true },
    ], { fileChanges: [], todos: [] })
    // 该 append 帧带来的是终态事件，id 与流式片段不同（Claude 场景）
    store.getState().appendEvents('s1', [
      { id: 'final-1', sessionId: 's1', ts: 18, type: 'assistant', text: '思考完成', seq: '2' },
    ], { fileChanges: [], todos: [] })
    const events = store.getState().events.s1
    expect(events.map((e) => e.id)).toEqual(['e1', 'final-1'])
    expect(events.some((e) => e.id === 'stream-1')).toBe(false)
  })

  it('append 时既有 durable 事件即便未在 incoming 中重发也被保留', () => {
    const store = createAppStore()
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 10, type: 'user', text: 'hi', seq: '1' },
      { id: 'e2', sessionId: 's1', ts: 20, type: 'assistant', text: 'hello', seq: '2' },
    ], { fileChanges: [], todos: [] })
    store.getState().appendEvents('s1', [
      { id: 'e3', sessionId: 's1', ts: 30, type: 'user', text: '继续', seq: '3' },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('乐观用户消息（无 seq）在 append 合并时存活，不被 seq==null 过滤丢弃（appendEvents 委托 applyEvents 重新派生）', () => {
    const store = createAppStore()
    // 先有一条已落盘的 durable 事件
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 10, type: 'assistant', text: '你好，有什么可以帮你', seq: '1' },
    ], { fileChanges: [], todos: [] })
    // 模拟 sendMessage：乐观注入一条用户消息（ev- 前缀、seq-less、ts=Date.now()，服务端还没回写）
    const optimisticId = 'opt-100'
    const now = Date.now()
    store.setState({
      events: { ...store.getState().events, s1: [...store.getState().events.s1, { id: optimisticId, sessionId: 's1', ts: now, type: 'user', text: '帮我看看这个 bug' }] },
    })
    expect(store.getState().events.s1.some((e) => e.id === optimisticId)).toBe(true)

    // append 帧到达，但不包含这条乐观消息（appendEvents 内部会先按 seq==null 丢弃它，
    // 再交给 applyEvents 从 store 现有状态里重新派生保留）
    store.getState().appendEvents('s1', [
      { id: 'e2', sessionId: 's1', ts: now + 200, type: 'assistant', text: '另一条不相关的新 durable 事件', seq: '2' },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.some((e) =>
      e.id === optimisticId && e.type === 'user' && e.text === '帮我看看这个 bug',
    )).toBe(true)

    // 服务端随后回写同文本 → 去重，不重复显示
    store.getState().appendEvents('s1', [
      { id: 'e3', sessionId: 's1', ts: now + 500, type: 'user', text: '帮我看看这个 bug', seq: '3' },
    ], { fileChanges: [], todos: [] })
    const users = store.getState().events.s1.filter((e) => e.type === 'user' && e.text === '帮我看看这个 bug')
    expect(users.length).toBe(1)
  })

  it('乐观气泡按 ts 落位，不得被助手流式输出挤到下面（用户报：「问题在下面、内容在上面」）', () => {
    const store = createAppStore()
    const now = Date.now()
    // 上一轮已落盘的对话
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: now - 5000, type: 'assistant', text: '上一轮回答', seq: '1' },
    ], { fileChanges: [], todos: [] })
    // 我刚发出的提问（乐观气泡，服务端还没回写）
    const optId = 'opt-1'
    store.setState({
      events: { ...store.getState().events, s1: [...store.getState().events.s1, { id: optId, sessionId: 's1', ts: now, type: 'user', text: '帮我查这个 bug' }] },
    })
    // 助手开始流式作答（ts 晚于我的提问）——它必须排在提问【之后】
    store.getState().appendEvents('s1', [
      { id: 'stream-1', sessionId: 's1', ts: now + 300, type: 'assistant', text: '我看看…', streaming: true },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.map((e) => e.id)).toEqual(['e1', optId, 'stream-1'])
  })

  it('服务端事件之间的既有顺序不因排序被打乱（JSONL 里 ts 本就可能非单调）', () => {
    // 反向护栏：修复上一条时若图省事做「全量按 ts 排序」，就会把权威源的顺序改掉。
    const store = createAppStore()
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 100, type: 'assistant', text: '调用工具', seq: '1' },
      { id: 'e2', sessionId: 's1', ts: 100, type: 'file_op', verb: '编辑', path: 'a.ts', seq: '2' },
      { id: 'e3', sessionId: 's1', ts: 90, type: 'assistant', text: 'ts 比上一条还早，但确实在它之后', seq: '3' },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('extras（fileChanges/todos）随 append 帧整份替换为最新全量值', () => {
    const store = createAppStore()
    store.getState().applyEvents('s1', [], { fileChanges: [{ path: 'a.ts', additions: 1, deletions: 0, lines: [] }], todos: [] })
    store.getState().appendEvents('s1', [], { fileChanges: [{ path: 'a.ts', additions: 2, deletions: 1, lines: [] }], todos: [{ text: 'x', status: 'pending' }] })
    expect(store.getState().extras.s1.fileChanges).toEqual([{ path: 'a.ts', additions: 2, deletions: 1, lines: [] }])
    expect(store.getState().extras.s1.todos).toEqual([{ text: 'x', status: 'pending' }])
  })
})

describe('snapshot/reset/缺省 kind 向后兼容：仍走 applyEvents 全量替换', () => {
  it('第二次 applyEvents（等价 snapshot/reset 帧）整份替换，旧 durable 事件若不在新全量中即消失', () => {
    const store = createAppStore()
    store.getState().applyEvents('s1', [
      { id: 'e1', sessionId: 's1', ts: 10, type: 'user', text: 'hi', seq: '1' },
      { id: 'e2', sessionId: 's1', ts: 20, type: 'assistant', text: 'hello', seq: '2' },
    ], { fileChanges: [], todos: [] })
    // 全量帧只带 e2（模拟旧后端截断的窗口/reset），不是增量——e1 应消失，而非像 append 那样被保留
    store.getState().applyEvents('s1', [
      { id: 'e2', sessionId: 's1', ts: 20, type: 'assistant', text: 'hello', seq: '2' },
    ], { fileChanges: [], todos: [] })
    expect(store.getState().events.s1.map((e) => e.id)).toEqual(['e2'])
  })
})

describe('选择器', () => {
  it('看板按服务器/项目统计，多引擎和历史会话不重复计数，审批优先', () => {
    const base = createAppStore({ seeded: true }).getState().sessions[0]
    const rows: Session[] = [
      { ...base, id: 'a', serverId: 'one', project: 'app', state: 'running', engine: 'codex' },
      { ...base, id: 'b', serverId: 'one', project: 'app', state: 'running', engine: 'kimi' },
      { ...base, id: 'c', serverId: 'two', project: 'app', state: 'running' },
      { ...base, id: 'd', serverId: 'one', project: 'needs-approval', state: 'running' },
      { ...base, id: 'e', serverId: 'one', project: 'needs-approval', state: 'waiting_approval' },
      { ...base, id: 'f', serverId: 'one', project: 'app', state: 'done' },
    ]
    const heads = projectHeadSessions(rows)
    expect(heads).toHaveLength(3)
    expect(getStats(heads)).toMatchObject({ running: 2, waitingApproval: 1, done: 0 })
    const filtered = visibleSessions(rows, [starKey('two', 'app')]).filter((s) => s.serverId === 'one')
    expect(getStats(projectHeadSessions(filtered))).toMatchObject({ running: 1, waitingApproval: 1 })
  })

  it('全局统计与种子数据一致', () => {
    const store = createAppStore({ seeded: true })
    const st = store.getState()
    const stats = getStats(st.sessions)
    // 期望值**从 seed 现算**，不硬编码——这里验的是 getStats 的分类逻辑对不对，
    // 不是"seed 里有几个 running"。硬编码会把 demo 数据的每次调整都变成一次假失败。
    const count = (s: string) => st.sessions.filter((x) => x.state === s).length
    expect(stats).toMatchObject({
      running: count('running'),
      waitingInput: count('waiting_input'),
      waitingApproval: count('waiting_approval'),
      done: count('done'),
    })
    expect(stats.running + stats.waitingInput + stats.waitingApproval + stats.done)
      .toBeLessThanOrEqual(st.sessions.length)
    expect(pendingCount(st.pendingActions))
      .toBe(st.pendingActions.filter((a) => a.status === 'pending').length)
  })

  it('Codex 回执元数据更新排队状态，不新增消息或改变原序号和顺序', () => {
    const store = createAppStore({ seeded: false })
    const events: ChatEvent[] = [
      { id: 'user-queue', sessionId: 's', ts: 10, seq: 1, type: 'user', text: '任务', delivery: 'queued' },
      { id: 'assistant', sessionId: 's', ts: 20, seq: 2, type: 'assistant', text: '当前回合结束' },
    ]
    store.getState().applyEvents('s', events, { fileChanges: [], todos: [] })
    store.getState().appendEvents('s', [], { fileChanges: [], todos: [], messageReceipts: { 'user-queue': { delivery: 'accepted' } } })
    expect(store.getState().events.s.map(e => e.id)).toEqual(['user-queue', 'assistant'])
    expect(store.getState().events.s[0]).toMatchObject({ delivery: 'accepted', seq: 1, ts: 10 })
  })

  it('排序：waiting_approval 置顶', () => {
    const store = createAppStore({ seeded: true })
    const sorted = sortSessions(store.getState().sessions)
    expect(sorted[0].state).toBe('waiting_approval')
  })

  // 看板顺序「感觉有些飘」：平局时不能依赖输入数组顺序（hub 用 Promise.all 聚合，顺序随网络时序变）。
  it('平局稳定：同 state+lastActiveAt 的会话，无论输入顺序如何，输出顺序恒定（全序）', () => {
    const mk = (id: string, project: string): Session => ({
      id, serverId: 'srv', project, branch: '', engine: 'claude', model: 'Opus',
      mode: 'default', state: 'idle', summary: '', startedAt: 1, lastActiveAt: 1000, // 全部同 state+同 lastActiveAt = 平局
      cost: 0, tokens: 0, origin: 'shadow',
    } as Session)
    const base = [mk('s1', 'zebra'), mk('s2', 'alpha'), mk('s3', 'mango')]
    const orderKey = (list: Session[]) => sortSessions(list).map((s) => s.id).join(',')
    const expected = orderKey(base)
    // 模拟 hub Promise.all 的各种到达顺序
    const perms = [
      [base[0], base[1], base[2]], [base[2], base[1], base[0]],
      [base[1], base[2], base[0]], [base[2], base[0], base[1]],
    ]
    for (const p of perms) expect(orderKey(p)).toBe(expected)
    // 且是有意义的确定序（按 project 名），不是偶然
    expect(sortSessions(base).map((s) => s.project)).toEqual(['alpha', 'mango', 'zebra'])
  })
})

describe('projectTodayActiveMs', () => {
  const mk = (id: string, activeMsToday?: number): Session => ({
    id, serverId: 'srv', project: 'p', branch: '', engine: 'claude', model: 'Opus',
    mode: 'default', state: 'idle', summary: '', startedAt: 1, lastActiveAt: 1,
    cost: 0, tokens: 0, origin: 'shadow', activeMsToday,
  } as Session)
  it('求和 latest + history 的 activeMsToday，缺省按 0', () => {
    expect(projectTodayActiveMs(mk('a', 60_000), [mk('b', 30_000), mk('c')])).toBe(90_000)
  })
  it('全缺省时为 0', () => { expect(projectTodayActiveMs(mk('a'), [])).toBe(0) })
})

describe('projectPreferredModel', () => {
  const pm = { 'srv-1/alpha': 'claude-fable-5' }
  it('命中返回模型 id', () => {
    expect(projectPreferredModel(pm, 'srv-1', 'alpha')).toBe('claude-fable-5')
  })
  it('未命中返回 undefined', () => {
    expect(projectPreferredModel(pm, 'srv-1', 'beta')).toBeUndefined()
    expect(projectPreferredModel({}, 'srv-1', 'alpha')).toBeUndefined()
  })
})

// 稳定性 gap #11：live 写操作失败不再静默——上报可见提示，且发消息会撤回乐观气泡
describe('写操作失败提示 (writeError)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const toLive = () => {
    const store = createAppStore({ seeded: true })
    const s = store.getState()
    store.getState().applyState(s.servers, s.sessions, s.pendingActions, {})  // source -> live
    return store
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('noteWriteError 设置、clearWriteError 清除', () => {
    const store = createAppStore({ seeded: true })
    expect(store.getState().writeError).toBeNull()
    store.getState().noteWriteError('测试失败')
    expect(store.getState().writeError?.text).toBe('测试失败')
    store.getState().clearWriteError()
    expect(store.getState().writeError).toBeNull()
  })

  it('live 发消息后端 500：撤回乐观气泡并置 writeError', async () => {
    const store = toLive()
    const sid = store.getState().sessions[0].id
    const before = (store.getState().events[sid] ?? []).length
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500 } as Response))
    store.getState().sendMessage(sid, '你好')
    expect((store.getState().events[sid] ?? []).length).toBe(before + 1)  // 乐观气泡先出现
    await flush()
    expect((store.getState().events[sid] ?? []).length).toBe(before)       // 失败后撤回
    expect(store.getState().writeError?.text).toContain('消息未送达')
  })

  // 2026-09-30 修订：连接断开只证明没拿到回执，不能声称服务器没收到并鼓励重发。
  it('live 发消息网络错误：保留待确认气泡，避免重复发送', async () => {
    const store = toLive()
    const sid = store.getState().sessions[0].id
    const before = (store.getState().events[sid] ?? []).length
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network')))
    store.getState().sendMessage(sid, '在吗')
    await flush()
    expect((store.getState().events[sid] ?? []).length).toBe(before + 1)
    expect(store.getState().writeError?.text).toContain('待确认')
    expect(store.getState().events[sid].at(-1)).toMatchObject({ delivery: 'unknown' })
  })

  it('live 发送回执区分已送达和排队；504 保留待确认状态', async () => {
    for (const [status, body, delivery] of [[200, { queued: false }, 'accepted'], [200, { delivery: 'steered', queued: false }, 'steered'], [200, { queued: true }, 'queued'], [504, { indeterminate: true }, 'unknown']] as const) {
      const store = toLive()
      const sid = store.getState().sessions[0].id
      vi.stubGlobal('fetch', () => Promise.resolve({ ok: status === 200, status, json: async () => body } as Response))
      store.getState().sendMessage(sid, '你好')
      await flush()
      expect(store.getState().events[sid].at(-1)).toMatchObject({ delivery })
    }
  })

  it('Codex 默认发送即时补充，显式排队独立任务；其他引擎保持原消息协议', async () => {
    const store = toLive()
    const current = store.getState()
    const sid = current.sessions[0].id
    store.getState().applyState(current.servers, current.sessions.map(s => s.id === sid ? { ...s, engine: 'codex' } : s), current.pendingActions, {})
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, delivery: 'steered' }) })
    vi.stubGlobal('fetch', fetcher)
    store.getState().sendMessage(sid, '补充信息')
    store.getState().sendMessage(sid, '独立任务', [], 'queue')
    await flush()
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ behavior: 'steer', text: '补充信息' })
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ behavior: 'queue', text: '独立任务' })
    const updated = store.getState()
    store.getState().applyState(updated.servers, updated.sessions.map(s => s.id === sid ? { ...s, engine: 'kimi' } : s), updated.pendingActions, {})
    store.getState().sendMessage(sid, 'Kimi消息')
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).not.toHaveProperty('behavior')
  })

  it('live 审批后端 500：置 writeError（会话态靠轮询自愈，不撤回）', async () => {
    const store = toLive()
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500 } as Response))
    const ok = store.getState().resolveAction('a-rm-cache', '允许一次')
    expect(ok).toBe(true)
    await flush()
    expect(store.getState().writeError?.text).toContain('审批未送达')
  })

  // 2026-07-18 22:34 事故：hub 转发超时被压成 500，前端照着报「审批未送达服务器，请重试」，
  // 用户连点 6 次——而请求其实**每次都送达了**，只是 hub 15s 不等了。现在 hub 对超时回 504，
  // 前端必须换一套诚实说法：不许说「未送达」，也不许催人重试（可能重放已生效的写操作）。
  it('live 审批 504（结果未知）：提示不得声称未送达、不得催重试', async () => {
    const store = toLive()
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 504 } as Response))
    expect(store.getState().resolveAction('a-rm-cache', '允许一次')).toBe(true)
    await flush()
    const text = store.getState().writeError?.text ?? ''
    expect(text).not.toContain('未送达')
    expect(text).not.toContain('请重试')
    expect(text).toContain('超时')
  })

  // 同一事故的收尾：超时的那次审批若其实已经落下，用户的重试会拿到 409「待办不存在或已处理」。
  // 那更不是「未送达」——它送达了、而且已经生效。再报「未送达，请重试」会把人钉在重试循环里。
  it('live 审批 409（已处理）：说清已处理，不得声称未送达', async () => {
    const store = toLive()
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 409 } as Response))
    expect(store.getState().resolveAction('a-rm-cache', '允许一次')).toBe(true)
    await flush()
    const text = store.getState().writeError?.text ?? ''
    expect(text).not.toContain('未送达')
    expect(text).toContain('已处理')
  })

  it('live 写成功（200）：不产生 writeError', async () => {
    const store = toLive()
    const sid = store.getState().sessions[0].id
    const before = (store.getState().events[sid] ?? []).length
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200 } as Response))
    store.getState().sendMessage(sid, '成功路径')
    await flush()
    expect((store.getState().events[sid] ?? []).length).toBe(before + 1)   // 气泡保留
    expect(store.getState().writeError).toBeNull()
  })
})

describe('已解决待办的墓碑：陈旧快照不得让卡片"复活"', () => {
  // 用户实测：「点了允许，审批卡消失后又突然冒出来，然后再消失」，可见时长恰好一个轮询周期。
  // 机理：applyState 用 reconcileList **拿服务端列表整份覆盖本地**。/api/state 每 3s 一轮，
  // 只要有一次快照**早于**这次点击（请求在途 / hub 那一拍还没轮到 agent），它返回的这条仍是
  // pending → sameShallow(本地 resolved, 服务端 pending) 为假 → 采用服务端那份 → 卡片复活。
  const act = (status: 'pending' | 'resolved' = 'pending') => ({
    id: 'a-1', sessionId: 's-1', serverId: 'srv', project: 'p', engine: 'claude' as const,
    kind: 'approval' as const, title: '删除缓存', detail: 'rm -rf', createdAt: 1, status,
  })
  const sess = () => ({
    id: 's-1', serverId: 'srv', project: 'p', engine: 'claude' as const, state: 'waiting_approval' as const,
    summary: '', cwd: '/data/p', startedAt: 1, lastActiveAt: 1, tokens: 0, cost: 0,
  }) as unknown as Session

  it('点击后到达的陈旧 pending 快照，不得把卡片变回 pending', () => {
    const store = createAppStore()
    store.getState().applyState([], [sess()], [act('pending')], {})   // 进入 live 模式
    expect(store.getState().resolveAction('a-1', '允许一次')).toBe(true)
    expect(store.getState().pendingActions[0].status).toBe('resolved')

    // ← 这一拍是**点击之前**发出的轮询，服务端还没处理完，仍报 pending
    store.getState().applyState([], [sess()], [act('pending')], {})
    expect(store.getState().pendingActions[0].status).toBe('resolved')   // 没有墓碑时这里会是 'pending'（卡片复活）
    expect(store.getState().pendingActions[0].resolution).toBe('允许一次')

    // 服务端处理完 → 不再报这条 → 卡片正常消失
    store.getState().applyState([], [sess()], [], {})
    expect(store.getState().pendingActions.length).toBe(0)
  })

  it('墓碑过期后不再压制：服务端仍报 pending（说明真的没处理成功）→ 卡片重新出现，用户可重试', () => {
    vi.useFakeTimers()
    try {
      const store = createAppStore()
      store.getState().applyState([], [sess()], [act('pending')], {})
      store.getState().resolveAction('a-1', '允许一次')
      vi.advanceTimersByTime(21_000)                                   // 超过 RESOLVED_TTL_MS
      store.getState().applyState([], [sess()], [act('pending')], {})
      expect(store.getState().pendingActions[0].status).toBe('pending') // 不能永久藏起来
    } finally {
      vi.useRealTimers()
    }
  })
})

// 项目入口跟随活跃会话，历史链接仍直接打开指定会话。
describe('projectHeadSession（项目卡片打开哪个会话）', () => {
  const mk = (id: string, state: Session['state'], lastActiveAt: number, engine: Session['engine'] = 'claude'): Session => ({
    id, serverId: 'srv-1', project: 'invest_data', branch: '', engine, model: '',
    mode: 'auto', state, summary: id, startedAt: 1, lastActiveAt, cost: 0, tokens: 0, origin: 'platform',
  })
  const old = mk('claude-old', 'idle', 1_000)
  const running = mk('codex-new', 'running', 9_000, 'codex')
  const rememberedOld = { 'srv-1/invest_data': old.id }

  it('运行中的 Codex 优先于记住的旧 Claude 会话', () => {
    expect(projectHeadSession([old, running], rememberedOld).id).toBe(running.id)
  })

  it('正在运行优先于停在等待输入的旧会话', () => {
    expect(projectHeadSession([{ ...old, state: 'waiting_input' }, running]).id).toBe(running.id)
  })

  it('Kimi 有待审批时优先打开审批所在的流', () => {
    const approval = mk('kimi-approval', 'waiting_approval', 5_000, 'kimi')
    expect(projectHeadSession([old, running, approval], rememberedOld).id).toBe(approval.id)
  })

  it('多个运行中的流选择最近活动的，且不修改输入数组', () => {
    const kimi = mk('kimi-new', 'running', 10_000, 'kimi')
    const list = [old, running, kimi]
    expect(projectHeadSession(list, { 'srv-1/invest_data': running.id }).id).toBe(kimi.id)
    expect(list.map(s => s.id)).toEqual([old.id, running.id, kimi.id])
  })

  it('回合结束后仍打开最近活动的流，不退回记住的旧 Claude', () => {
    expect(projectHeadSession([old, { ...running, state: 'idle' }], rememberedOld).id).toBe(running.id)
  })

  it('记住的会话已消失时正常选择活跃流', () => {
    expect(projectHeadSession([old, running], { 'srv-1/invest_data': 'gone' }).id).toBe(running.id)
  })

  it('状态优先级和时间相同时沿用上次选择，但不串项目或服务器', () => {
    const other = mk('z-other', 'idle', old.lastActiveAt)
    expect(projectHeadSession([old, other], { 'srv-1/invest_data': other.id }).id).toBe(other.id)
    expect(projectHeadSession([old, other], { 'srv-2/invest_data': other.id }).id).toBe(old.id)
    expect(projectHeadSession([old, other], { 'srv-1/other': other.id }).id).toBe(old.id)
  })
})

describe('rememberSession（把用户的选择记下来）', () => {
  it('打开会话后写入 lastSessions，键是 serverId/project', () => {
    const store = createAppStore({ seeded: true })
    store.getState().rememberSession('srv-1', 'invest_data', 'ps-new')
    expect(store.getState().lastSessions['srv-1/invest_data']).toBe('ps-new')
  })

  it('再打开另一个会话会覆盖，而不是追加', () => {
    const store = createAppStore({ seeded: true })
    store.getState().rememberSession('srv-1', 'invest_data', 'ps-new')
    store.getState().rememberSession('srv-1', 'invest_data', 'ps-other')
    expect(store.getState().lastSessions['srv-1/invest_data']).toBe('ps-other')
  })
})

// ───────────── 出错会话的「清理」死循环（2026-08-21 用户实拍）─────────────
//
// 现场：doc_ceneter 上两条平台会话都 `Claude Code process exited with code 1`。
// 点「清理此会话」→ 页面跳走 → 又回到同一个「清理」页面，会话永远删不掉。
//
// 两个 bug 叠起来才闭环，缺一环都不会死循环：
//  ① release 成功后无条件 `navigate('/session/' + data.realId)`，**从不验证这个 id 能否打开**。
//     实测那两个 realId 的 JSONL 在磁盘上确实存在（23MB / 74MB），但既不在 /api/state
//     的实时列表里、也不在冷路径历史里（scanned=57、返回最近 20 条，两个都不在）
//     ⇒ 必然落到「会话不存在」。
//  ② SessionNotFound 挑后继时**不看状态**，于是把用户从一个死胡同自动送进另一个死胡同
//     ——那条后继正是**另一条 error 会话**，同一个「清理此会话」按钮又出现了。
//
// ★ 病根与「深链到不在 /api/state 里但真实存在的会话 = 会话不存在」同源：
//   跳转到一个**从未验证过存在性**的 id。

describe('出错会话清理：不得跳进死胡同，也不得在死胡同之间弹来弹去', () => {
  const s = (id: string, extra: Partial<Session> = {}): Session => ({
    id, serverId: 'srv-1', project: 'p', engine: 'claude', state: 'idle',
    summary: '', cwd: '/data/p', startedAt: 1, lastActiveAt: 1, tokens: 0, cost: 0,
    ...extra,
  } as unknown as Session)

  it('★ realId 在已知会话里 → 跳过去（正常释放回终端的路径不能被改坏）', () => {
    const known = [s('real-1'), s('other')]
    expect(resolveReleaseTarget('real-1', known)).toBe('/session/real-1')
  })

  it('★★ realId 不可达 → 必须回看板，不得跳过去', () => {
    // 这一条就是死循环的第一环。跳过去 = 必然「会话不存在」。
    const known = [s('other')]
    expect(resolveReleaseTarget('c6394da7-87bc-4c57-bfb5-eb71d150c8a6', known)).toBe('/')
  })

  it('realId 缺失（进程没跑起来，压根没有原生 id）→ 回看板', () => {
    expect(resolveReleaseTarget(undefined, [s('a')])).toBe('/')
    expect(resolveReleaseTarget(null, [s('a')])).toBe('/')
    expect(resolveReleaseTarget('', [s('a')])).toBe('/')
  })

  it('★★ 挑后继必须跳过 error 会话 —— 否则就是从一个死胡同弹进另一个', () => {
    const list = [
      s('err-a', { state: 'error', lastActiveAt: 300 }),
      s('err-b', { state: 'error', lastActiveAt: 200 }),
      s('ok', { state: 'idle', lastActiveAt: 100 }),
    ]
    expect(pickSuccessorSession(list, 'claude')?.id).toBe('ok')
  })

  it('★ 全是 error 就返回 null —— 老实停在提示页，别自动弹走', () => {
    const list = [s('err-a', { state: 'error' }), s('err-b', { state: 'error' })]
    expect(pickSuccessorSession(list, 'claude')).toBeNull()
  })

  it('优先同引擎，同引擎没有可用的才退回其它引擎', () => {
    const list = [
      s('codex-ok', { engine: 'codex', state: 'idle', lastActiveAt: 300 }),
      s('claude-err', { engine: 'claude', state: 'error', lastActiveAt: 200 }),
      s('claude-ok', { engine: 'claude', state: 'idle', lastActiveAt: 100 }),
    ]
    expect(pickSuccessorSession(list, 'claude')?.id).toBe('claude-ok')
    expect(pickSuccessorSession(list, 'kimi')?.id).toBe('codex-ok')
  })

  it('空列表返回 null，不抛', () => {
    expect(pickSuccessorSession([], 'claude')).toBeNull()
  })
})

// ── 项目隐藏（「隐藏 = 不加入项目纳管」，用户 2026-09-06）────────────────────────
//
// ★ 与星标（纯 localStorage）的关键差别：隐藏必须**存服务端**。
//   它不是"这台设备上少画一张卡片"，而是 agent 那边真的不再扫描这个项目 ——
//   而 agent 的名单是 hub 下发的，所以权威只能在服务端。换设备/新浏览器必须一致。
//
// ★★ 隐藏之后项目会从看板、新建会话下拉、用量聚合**全部消失**，
//   所以「能恢复」和「能隐藏」同等重要 —— 否则这是个单向的、把项目弄丢的按钮。
describe('隐藏项目', () => {
  it('★ 隐藏后该项目的会话不再出现在可见列表里', () => {
    const store = createAppStore({ seeded: true })
    const s0 = store.getState().sessions
    const victim = s0[0]
    expect(visibleSessions(s0, store.getState().hiddenProjects).length).toBe(s0.length)

    store.getState().toggleHideProject(victim.serverId, victim.project)
    const hidden = store.getState().hiddenProjects
    expect(hidden).toContain(starKey(victim.serverId, victim.project))
    const left = visibleSessions(s0, hidden)
    expect(left.some((s) => s.serverId === victim.serverId && s.project === victim.project)).toBe(false)
    expect(left.length).toBeLessThan(s0.length)
  })

  it('★ 同名项目在别的服务器上不受影响', () => {
    const store = createAppStore({ seeded: true })
    const list = [
      { serverId: 'srv-a', project: 'shared' },
      { serverId: 'srv-b', project: 'shared' },
    ] as Session[]
    store.getState().toggleHideProject('srv-a', 'shared')
    const left = visibleSessions(list, store.getState().hiddenProjects)
    expect(left.map((s) => s.serverId)).toEqual(['srv-b'])
  })

  it('★★ 必须能取消隐藏 —— 否则这是个把项目弄丢的单向按钮', () => {
    const store = createAppStore({ seeded: true })
    store.getState().toggleHideProject('srv-a', 'p1')
    expect(store.getState().hiddenProjects).toContain('srv-a/p1')
    store.getState().toggleHideProject('srv-a', 'p1')
    expect(store.getState().hiddenProjects).not.toContain('srv-a/p1')
  })

  it('服务端名单到达时以服务端为准（换设备要一致）', () => {
    const store = createAppStore({ seeded: true })
    store.getState().toggleHideProject('srv-a', 'local-only')
    store.getState().setHiddenProjects(['srv-b/from-server'])
    expect(store.getState().hiddenProjects).toEqual(['srv-b/from-server'])
  })

  it('★ 服务端返回坏数据不得清空本地名单 —— 一次抖动不该让隐藏的项目全冒出来', () => {
    const store = createAppStore({ seeded: true })
    store.getState().toggleHideProject('srv-a', 'p1')
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      store.getState().setHiddenProjects(bad as unknown as string[])
      expect(store.getState().hiddenProjects).toContain('srv-a/p1')
    }
  })
})
