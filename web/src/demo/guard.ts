import * as seed from '../mock/seed'

// 对外 Demo 的**唯一咽喉闸**：拦下一切 `/api/*` 请求，用编造数据应答，绝不让它出网。
//
// ⚠️ 为什么必须在这一层做，而不是逐个组件加 `if (IS_DEMO)`：
// Demo 站点与真管控台**同域**（webagents.jeanron100.top/demo/），`/api/*` 就是**真 Hub**。
// 只要有**任何一个**组件漏了守卫，它就会把真实数据拉出来公开展示。
// 实测教训：我先只堵了 `startHubClient` 的那一次探测，以为够了——构建后用浏览器一抓，
// 发现仍在发 `/api/usage/daily`、`/api/usage/limits`、`/api/categories`（各组件自己 fetch 的），
// **真实 token 消耗、订阅额度、成本会被公开**。逐点设防必然漏点；咽喉设防不会。
//
// 于是：demo 构建在启动时**替换全局 fetch**。任何以 `/api/` 开头的请求一律不出网——
// 命中就给编造应答，没命中就给 503。日后有人新加一个 `/api/xxx` 调用，它也**天然被挡住**
// （最坏是那块 UI 显示"不可用"，而不是泄漏真数据）。

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const days = (n: number) => {
  const out = []
  const today = new Date(seed.NOW)
  today.setHours(0, 0, 0, 0)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    // 编一条像样的曲线：工作日高、周末低，带点噪声（确定性——同一天永远同一个值）
    const dow = d.getDay()
    const base = dow === 0 || dow === 6 ? 0.35 : 1
    const jitter = ((i * 2654435761) % 1000) / 1000 * 0.5 + 0.75
    const cost = Math.round(base * jitter * 11 * 100) / 100
    const tokens = Math.round(cost * 260_000)
    const r2 = (x: number) => Math.round(x * 100) / 100
    out.push({
      date: key,
      tokens,
      byEngine: { codex: Math.round(tokens * 0.6), kimi: Math.round(tokens * 0.25), claude: tokens - Math.round(tokens * 0.6) - Math.round(tokens * 0.25) },
      cost,
      tok: { input: Math.round(tokens * 0.03), output: Math.round(tokens * 0.03), cacheRead: Math.round(tokens * 0.89), cacheCreate: Math.round(tokens * 0.05) },
      costc: { input: r2(cost * 0.18), output: r2(cost * 0.46), cacheRead: r2(cost * 0.21), cacheCreate: r2(cost * 0.15) },
    })
  }
  return out
}

/** 编造应答表。键是路径前缀，命中即返回。 */
function respond(path: string, search: URLSearchParams): Response | null {
  if (path === '/api/state') {
    return ok({ servers: seed.servers, sessions: seed.sessions, pendingActions: seed.pendingActions, projectModels: {} })
  }
  if (path === '/api/usage/daily') {
    const n = Math.min(90, Math.max(1, Number(search.get('days')) || 30))
    const d = days(n)
    return ok({ days: d, last5h: 1_284_000, last7d: d.slice(-7).reduce((a, x) => a + x.tokens, 0) })
  }
  if (path === '/api/usage/kimi-limits') return ok({ session: { pct: 28, windowMin: 300, resets: '2 小时后' }, week: { pct: 36, windowMin: 43200, label: 'Monthly', resets: '下月 1 日' }, ts: seed.NOW })
  if (path === '/api/usage/quota-trend') return ok({ available: true, series: (['codex','kimi','claude'] as const).map((engine,index)=>({
    id:`demo-${engine}`,engine,windowLabel:engine==='kimi'?'本月':'本周',sourceLabel:'演示账号',
    points:Array.from({length:240},(_,i)=>({ts:seed.NOW-(239-i)*3*3600_000,pct:Math.round((i%56)*(index+1)*.45)})),
  })) })
  if (path === '/api/assistant/progress' || path === '/api/assistant/evidence') {
    const task={id:'demo-disk',serverId:'node-fra-1',project:'infra-scripts',sessionId:'s-infra',engine:'claude',title:'演示：磁盘空间排查与日志保留策略',context:'检查磁盘空间，不删除业务数据。',request:'检查磁盘空间，不删除业务数据。',result:'演示记录报告：定位到过期压缩日志，设置保留周期并核对释放后的空间。',status:'reported_complete',updatedAt:seed.NOW-3600_000,sourceTruncated:false,causes:['演示原因：归档日志没有配置保留周期。'],lessons:['演示经验：清理前先确认数据归属，清理后核对空间及日志保留策略。'],progress:[{ts:seed.NOW-7200_000,text:'演示：按目录统计占用，确认主要来源为过期压缩日志。'}],actions:['演示：检查日志轮转配置与剩余磁盘空间。'],risks:['全部为虚构数据；不代表任何真实服务器已完成清理。']}
    if(path.endsWith('/evidence'))return ok({task})
    const q=search.get('q')||'',match=(!q||/磁盘|日志|空间/.test(q))&&(!search.get('project')||search.get('project')===task.project)&&(!search.get('host')||search.get('host')===task.serverId)
    return ok({tasks:match?[task]:[],total:match?1:0,answer:match?'演示模式：以下预置任务展示交办、处理结果、原因、风险及来源。未连接真实模型或服务器。':'演示模式仅预置一条磁盘日志排查任务，可尝试提问“磁盘空间怎么解决的”。真实历史检索与问答需自行安装。',updatedAt:seed.NOW,refreshing:false,error:null,projects:[{serverId:task.serverId,project:task.project}],coverage:{retainedTasks:1,durable:{tasks:1},archive:{enabled:true},sources:[]}})
  }
  if (path === '/api/usage/limits') {
    // 官方订阅额度（5h 窗口 / 本周）——编造
    return ok({ session: { pct: 41, resets: '2 小时后' }, week: { pct: 63, resets: '周四' }, weekSonnet: { pct: 22 }, ts: seed.NOW })
  }
  if (path === '/api/usage/codex-limits') {
    // 真接口形状：{ accounts:[{ primary, secondary, ... }] }。2026-07-15 起 OpenAI 只剩 weekly 窗、
    // secondary=null（5h 窗被取消）——demo 照此，顺便验证前端「secondary 为空不画空格子」的路径。
    return ok({ accounts: [{
      accountId: 'demo-acct', email: 'demo@example.com', plan: 'plus', live: true, at: seed.NOW,
      primary: { pct: 47, windowMin: 10080, resetsAt: Math.floor(seed.NOW / 1000) + 3 * 86400 },
      secondary: null,
    }] })
  }
  if (path === '/api/usage/codex-models') {
    return ok({ models: [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], isDefault: true },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], isDefault: false },
    ] })
  }
  if (path === '/api/usage/projects-today') {
    return ok({ projects: seed.sessions.map((s) => ({ project: s.project, serverId: s.serverId, cost: s.costToday ?? 0, tokens: s.tokensToday ?? 0, activeMs: s.activeMsToday ?? 0 })) })
  }
  if (path === '/api/categories') {
    return ok({
      categories: ['后端服务', '前端应用', '数据与检索', '基础设施'],
      map: {
        'node-tokyo-1/acme-api': '后端服务', 'node-tokyo-1/data-pipeline': '数据与检索',
        'node-tokyo-1/blog-engine': '前端应用', 'node-sg-1/search-index': '数据与检索',
        'node-sg-1/mobile-app': '前端应用', 'node-fra-1/infra-scripts': '基础设施',
        'node-fra-1/game-server': '后端服务', 'node-fra-1/crawler': '数据与检索',
        'node-sfo-1/billing': '后端服务', 'node-sfo-1/docs-site': '前端应用',
        'node-hkg-1/analytics': '数据与检索',
      },
    })
  }
  // ── 数据层健康（设置页的「数据层」面板）──
  // ⚠️ 别偷懒返回 `{available:false}` 了事：DataLayerPanel 直接读 `s.projection.spoolBytes`，
  // 形状对不上就是 `Cannot read properties of undefined` —— **整个应用白屏**（用户实测踩到）。
  // 守卫一旦接管某个端点，就必须回**形状正确**的数据，不能只回个"不可用"。
  if (path === '/api/v2/stats' || path === '/api/v2/health') {
    return ok({
      hub: 'ok',
      redis: { status: 'ok', latencyMs: 2 },
      mongo: { status: 'ok', latencyMs: 41 },
      mysql: { status: 'ok' },
      flags: { WA_REDIS_ENABLED: true, WA_MONGO_ENABLED: true, WA_EVENT_SHADOW_WRITE: true },
      projection: {
        written: 6_412, skipped: 0, spooled: 0, sessions: 11, replayed: 0,
        lastRun: seed.NOW - 3_000, tookMs: 58, lastError: null, spoolCount: 0, spoolBytes: 0,
      },
      events: { total: 6_412, byType: [
        { _id: 'tool.used', n: 3_580 }, { _id: 'assistant.message', n: 2_610 },
        { _id: 'user.message', n: 214 }, { _id: 'approval.resolved', n: 8 },
      ] },
      alerts: [],
      asOf: seed.NOW,
    })
  }

  // agent 重启事件簿——demo 里给一条**真事故**的样子（这是这个项目最值得展示的东西之一）
  if (path === '/api/v2/incidents/restarts') {
    return ok({
      available: true,
      incidents: [{
        _id: 'inc-1', serverId: 'node-fra-1', kind: 'agent.restart',
        ts: new Date(seed.NOW - 41 * 60_000).toISOString(),
        prevBootAt: new Date(seed.NOW - 3.9 * 3600_000).toISOString(),
        killedSessions: [{ sessionId: 'ps-game-7f3a', project: 'game-server', state: 'running', inflight: true }],
      }],
      asOf: seed.NOW,
    })
  }

  // 执行历史（按回合分组）：给主线会话编一段
  const tl = /^\/api\/v2\/runs\/([\w-]+)\/timeline$/.exec(path)
  if (tl) {
    const evs = (seed.chatEvents[tl[1]] ?? []).map((e, i) => ({
      eventKey: `demo:${tl[1]}:${i}`,
      type: e.type === 'user' ? 'user.message' : e.type === 'assistant' ? 'assistant.message' : 'tool.used',
      occurredAt: new Date(e.ts).toISOString(),
      payload: e.type === 'file_op'
        ? { verb: e.verb, ...(e.verb === '执行命令' ? { cmdPreview: String(e.path).slice(0, 48) } : { path: e.path }), additions: e.additions, deletions: e.deletions }
        : 'text' in e && e.text ? { summary: String(e.text).replace(/\s+/g, ' ').slice(0, 140) } : {},
    }))
    return ok({ available: true, events: evs, asOf: seed.NOW })
  }
  if (path.startsWith('/api/v2/')) return ok({ available: true, events: [], runs: [], incidents: [], asOf: seed.NOW })

  // ── 用量图表 ──
  if (path === '/api/usage/quota-trend') {
    const end = Date.now()
    return ok({ available: true, series: ['codex', 'kimi', 'claude'].map(engine => ({
      id: `demo-${engine}`, engine, windowLabel: engine === 'kimi' ? '本月' : '本周',
      points: Array.from({ length: 30 * 8 }, (_, i) => ({
        ts: end - (30 * 8 - 1 - i) * 3 * 3600_000,
        pct: engine === 'kimi' ? Math.round(i / 3.2) : Math.round((i % 56) * 1.6),
      })).filter((_p, i) => engine !== 'claude' || i < 160),
    })) })
  }
  if (path === '/api/usage/limits-trend') {
    const pts = []
    for (let i = 6 * 24; i >= 0; i -= 3) {
      const d = new Date(seed.NOW - i * 3600_000)
      const p2 = (n: number) => String(n).padStart(2, '0')
      pts.push({
        date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:00`,
        week: Math.min(96, Math.round(20 + (6 * 24 - i) * 0.28)),
        sonnet: Math.min(40, Math.round(6 + (6 * 24 - i) * 0.09)),
      })
    }
    return ok({ points: pts })
  }
  if (path === '/api/usage/today-hourly') {
    const hrs = []
    for (let h = 0; h <= new Date(seed.NOW).getHours(); h++) {
      const busy = h >= 9 && h <= 23 ? 1 : 0.18
      const j = ((h * 2654435761) % 1000) / 1000 * 0.6 + 0.7
      const cost = Math.round(busy * j * 1.9 * 100) / 100
      hrs.push({ hour: String(h).padStart(2, '0'), tokens: Math.round(cost * 260_000), cost })
    }
    return ok({ hours: hrs })
  }
  if (path === '/api/usage/projects-daily') {
    // series：每日活跃总时长（AI 工作量卡的迷你柱）。形状必须与真接口一致，否则 demo 卡读 undefined。
    // 编造 14 天、每天 3~7h 的活跃波动——demo 数据全部虚构，不出网。
    const series = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(seed.NOW - (13 - i) * 86400_000)
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const activeMs = Math.round((3 + ((i * 37) % 45) / 10) * 3600_000)
      return { date, activeMs, projects: 4 + (i % 5) }
    })
    return ok({
      rows: seed.sessions.map((x) => ({
        serverId: x.serverId, project: x.project,
        activeMs: x.activeMs ?? 0, cost: x.cost, tokens: x.tokens,
      })),
      series,
    })
  }

  // ── 其余只读端点：给形状正确的空/合理值，别让组件读 undefined ──
  if (path === '/api/projects') {
    return ok({ projects: [...new Set(seed.sessions.map((x) => `${x.serverId}/${x.project}`))].map((k) => {
      const [serverId, project] = k.split('/')
      return { serverId, project, cwd: `/data/${project}` }
    }) })
  }
  if (path === '/api/server-tags') return ok({ tags: ['主控', '应用', '数据'], map: { 'node-tokyo-1': '主控' } })
  if (path === '/api/term/list') return ok({ sessions: [] })
  if (path === '/api/push/pubkey') return ok({ key: '', subscribers: 0 })
  if (path === '/api/search') return ok({ results: [] })

  // ⚠️ 形状必须和真接口一致。我先随手编了 `{items:[]}`、`{tree:[]}`——两页都炸了
  // （`Object.keys(undefined)` / `undefined.map`）。**守卫接管一个端点，就得回对形状。**
  if (path === '/api/review') {
    const byProject = new Map<string, typeof seed.sessions>()
    for (const x of seed.sessions) {
      const k = `${x.serverId}|${x.project}`
      byProject.set(k, [...(byProject.get(k) ?? []), x])
    }
    const d = new Date(seed.NOW)
    const p2 = (n: number) => String(n).padStart(2, '0')
    return ok({
      date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
      totalProjects: byProject.size,
      totalSessions: seed.sessions.length,
      projects: [...byProject.entries()].map(([k, list]) => {
        const [server, project] = k.split('|')
        return {
          project, server, serverName: server,
          sessions: list.map((x) => ({
            id: x.id, engine: x.engine, model: x.model, state: x.state,
            summary: x.summary, cost: x.cost, tokens: x.tokens,
            startedAt: x.startedAt, lastActiveAt: x.lastActiveAt,
          })),
        }
      }),
    })
  }

  if (path.endsWith('/tree')) {
    const mk = (name: string, type: 'dir' | 'file', p: string, children?: unknown[]) => ({ name, type, path: p, children })
    return ok({
      cwd: '/data/acme-api', fileCount: 128, truncated: false,
      status: { 'src/gateway/middleware/rate-limit.ts': 'M', 'src/gateway/router.ts': 'M', 'test/rate-limit.test.ts': 'A' },
      root: mk('acme-api', 'dir', '', [
        mk('src', 'dir', 'src', [
          mk('gateway', 'dir', 'src/gateway', [
            mk('middleware', 'dir', 'src/gateway/middleware', [
              mk('auth.ts', 'file', 'src/gateway/middleware/auth.ts'),
              mk('rate-limit.ts', 'file', 'src/gateway/middleware/rate-limit.ts'),
            ]),
            mk('router.ts', 'file', 'src/gateway/router.ts'),
          ]),
          mk('index.ts', 'file', 'src/index.ts'),
        ]),
        mk('test', 'dir', 'test', [mk('rate-limit.test.ts', 'file', 'test/rate-limit.test.ts')]),
        mk('package.json', 'file', 'package.json'),
        mk('README.md', 'file', 'README.md'),
      ]),
    })
  }

  if (path.endsWith('/images')) return ok({ images: [] })
  // 对话流内联截图（/api/session/:id/image/:eventId/:idx）。demo 与真管控台**同域**，
  // 这条路由不拦就会真的去 hub 拉用户的私人截图。demo 的种子数据不带图，这里恒返回 404 即可。
  if (/\/image\/[^/]+\/\d+$/.test(path)) return new Response('', { status: 404 })
  if (path.endsWith('/digest')) return ok({ markdown: '' })
  if (path.endsWith('/file')) {
    return ok({ path: 'src/gateway/middleware/rate-limit.ts', mtime: seed.NOW,
      content: '// Demo：文件内容需连接真实 Hub 才能读取。\n// 这里展示的是编造的演示数据。\n' })
  }

  return null
}

/** 安装咽喉闸。只在 demo 构建里调用一次（main.tsx 启动时）。 */
export function installDemoGuard(): void {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let path: string
    let search: URLSearchParams
    try {
      const u = new URL(raw, window.location.origin)
      path = u.pathname
      search = u.searchParams
    } catch {
      return real(input as RequestInfo, init)
    }
    if (!path.startsWith('/api/')) return real(input as RequestInfo, init) // 静态资源照常走

    // 写操作（发消息/审批/中断…）：mock 态下 store 本来就只改本地，这里直接吞掉，绝不出网
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return ok({ ok: true, demo: true })

    const r = respond(path, search)
    if (r) return r
    // 没编过的端点 → 503。**宁可这块 UI 显示"不可用"，也绝不放它去打真 Hub。**
    return new Response(JSON.stringify({ error: 'demo: 该功能需要连接真实 Hub' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })
  }

  // SSE 也要堵：EventSource 不走 fetch。Demo 里没有真实事件流，直接让它变成一个永不连接的空壳，
  // 前端的心跳看门狗在 mock 态下不会被触发（source !== 'live' 时 subscribeSessionEvents 直接 no-op）。
  class DeadEventSource extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readyState = 2
    url: string
    onmessage: unknown = null
    onerror: unknown = null
    onopen: unknown = null
    constructor(url: string) { super(); this.url = url }
    close() { /* no-op */ }
  }
  ;(window as unknown as { EventSource: unknown }).EventSource = DeadEventSource

  // WebSocket 同样要堵：终端页用它连 /api/term/ws。Demo 里没有真终端，
  // 让它变成一个立刻"关闭"的空壳，终端页会走它自己的断线分支，不会崩。
  class DeadWebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = 3
    url: string
    onopen: unknown = null
    onmessage: unknown = null
    onerror: unknown = null
    onclose: ((e: unknown) => void) | null = null
    constructor(url: string) {
      super()
      this.url = url
      setTimeout(() => { this.onclose?.({ code: 1000, reason: 'demo' }); this.dispatchEvent(new Event('close')) }, 0)
    }
    send() { /* no-op */ }
    close() { /* no-op */ }
  }
  ;(window as unknown as { WebSocket: unknown }).WebSocket = DeadWebSocket
}
