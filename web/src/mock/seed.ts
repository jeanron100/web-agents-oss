import type { ChatEvent, PendingAction, Server, Session, SessionExtras } from '../types'

// 演示数据（Demo / 离线降级用）。
//
// 这份数据有两个身份：
//  ① **生产降级路径**：真实 Hub 探不到时（agent 全挂、隧道断、纯前端预览）前端回退到这里，
//     不白屏；后台每 10s 重探，Hub 一恢复自动升级为 live。
//  ② **对外 Demo 的数据源**：demo 站点不反代 `/api/*` → 探测必失败 → 天然跑在这份数据上。
//     所以 demo 不是另做的一套假页面，**就是生产代码本身**。
//
// ⚠️ 全部虚构：服务器名 / 项目名 / 路径 / 成本 / 代码片段均为编造，不含任何真实信息。
// 设计意图是让一屏之内就能看到这个系统的全部形态：五台机（含一台离线，演示故障回填缓存）、
// 六种会话状态、双引擎、平台会话与影子会话并存、一个 agent 重启后「已分离待接管」的会话，
// 以及四类待办各至少一条。

const MIN = 60_000
const HOUR = 60 * MIN
export const NOW = Date.now()

export const servers: Server[] = [
  { id: 'node-tokyo-1', name: 'node-tokyo-1', region: '东京 · 主控', flag: '🇯🇵', online: true },
  { id: 'node-sg-1', name: 'node-sg-1', region: '新加坡', flag: '🇸🇬', online: true },
  { id: 'node-fra-1', name: 'node-fra-1', region: '法兰克福', flag: '🇩🇪', online: true },
  { id: 'node-sfo-1', name: 'node-sfo-1', region: '旧金山', flag: '🇺🇸', online: true },
  // 离线节点：展示 D2 故障回填——隧道抖动时不清空该机会话，用上一轮成功缓存兜住并标 stale
  { id: 'node-hkg-1', name: 'node-hkg-1', region: '香港', flag: '🇭🇰', online: false, stale: true },
]

const tok = (input: number, output: number, cacheRead: number, cacheCreate: number) => ({
  input, output, cacheRead, cacheCreate,
})

export const sessions: Session[] = [
  // ── 运行中（平台会话，可交互）──
  {
    id: 's-acme-api', serverId: 'node-tokyo-1', project: 'acme-api', branch: 'feat/rate-limit',
    engine: 'codex', model: 'Codex', mode: 'auto', state: 'running', origin: 'platform',
    effort: 'xhigh', cwd: '/data/acme-api', realSessionId: 'a1b2c3d4-1111-2222-3333-444455556666',
    summary: '正在给网关加令牌桶限流，已改 3 个文件…', progress: 62,
    startedAt: NOW - 2.4 * HOUR, lastActiveAt: NOW - 6_000,
    cost: 4.81, tokens: 1_284_000, tokensBreakdown: tok(41_200, 38_600, 1_141_000, 63_200),
    activeMs: 74 * MIN, activeMsToday: 74 * MIN, costToday: 4.81, tokensToday: 1_284_000,
  },
  // ── 等待审批（危险命令被拦下）──
  {
    id: 's-infra', serverId: 'node-fra-1', project: 'infra-scripts', branch: 'chore/cleanup',
    engine: 'claude', model: 'Opus 4.8', mode: 'auto', state: 'waiting_approval', origin: 'platform',
    effort: 'high', cwd: '/data/infra-scripts',
    summary: '请求执行 rm -rf /var/lib/build-cache/*',
    startedAt: NOW - 38 * MIN, lastActiveAt: NOW - 3 * MIN,
    cost: 0.62, tokens: 96_400, tokensBreakdown: tok(8_100, 6_900, 74_200, 7_200),
    activeMs: 21 * MIN, costToday: 0.62,
  },
  // ── 等待输入（助手在提问）──
  {
    id: 's-pipeline', serverId: 'node-tokyo-1', project: 'data-pipeline', branch: 'refactor/sync',
    engine: 'kimi', model: 'Kimi', mode: 'default', state: 'waiting_input', origin: 'platform',
    effort: 'medium', cwd: '/data/data-pipeline',
    summary: '问：两条迁移撞车了，合并还是回滚？',
    startedAt: NOW - 55 * MIN, lastActiveAt: NOW - 7 * MIN,
    cost: 1.37, tokens: 268_000, tokensBreakdown: tok(15_400, 12_800, 224_000, 15_800),
    activeMs: 33 * MIN, costToday: 1.37,
  },
  // ── 等待输入（计划待确认，plan 模式）──
  {
    id: 's-search', serverId: 'node-sg-1', project: 'search-index', branch: 'feat/vector',
    engine: 'claude', model: 'Opus 4.8', mode: 'plan', state: 'waiting_input', origin: 'platform',
    effort: 'xhigh', cwd: '/data/search-index',
    summary: '计划待确认：向量检索接入（4 步）',
    startedAt: NOW - 26 * MIN, lastActiveAt: NOW - 11 * MIN,
    cost: 0.94, tokens: 143_000, tokensBreakdown: tok(11_900, 9_400, 112_000, 9_700),
    activeMs: 18 * MIN, costToday: 0.94,
  },
  // ── 运行中（Codex，另一套引擎、同一套 UI）──
  {
    id: 's-mobile', serverId: 'node-sg-1', project: 'mobile-app', branch: 'fix/ios-crash',
    engine: 'codex', model: 'GPT-5.5', mode: 'untrusted', state: 'running', origin: 'platform',
    effort: 'high', cwd: '/data/mobile-app',
    summary: '复现 iOS 启动崩溃，正在跑 symbolicate…',
    startedAt: NOW - 19 * MIN, lastActiveAt: NOW - 12_000,
    cost: 0, tokens: 87_500, tokensBreakdown: tok(9_800, 7_100, 66_400, 4_200),
    activeMs: 16 * MIN,
  },
  // ── agent 重启后「已分离」：只读，可一键恢复接管（本项目最痛的一类事故，做成了可恢复）──
  {
    id: 'ps-game-7f3a', serverId: 'node-fra-1', project: 'game-server', branch: 'perf/tick',
    engine: 'claude', model: 'Opus 4.8', mode: 'acceptEdits', state: 'waiting_input', origin: 'platform',
    detached: true, interrupted: true, lostPending: true,
    detachedReason: 'agent 重启（部署新版），会话已分离；历史只读，可点「恢复会话」重新接管',
    realSessionId: 'f7e6d5c4-9999-8888-7777-666655554444', cwd: '/data/game-server',
    summary: '重启前正在执行：优化 tick 循环的对象池',
    startedAt: NOW - 3.1 * HOUR, lastActiveAt: NOW - 41 * MIN,
    cost: 6.28, tokens: 1_902_000, tokensBreakdown: tok(52_800, 47_300, 1_723_000, 78_900),
    activeMs: 96 * MIN, costToday: 6.28,
  },
  // ── 影子会话：终端里起的原生会话，Web 只读追踪，可接管（双向接管的另一半）──
  {
    id: 'b9c8d7e6-0000-1111-2222-333344445555', serverId: 'node-tokyo-1', project: 'blog-engine', branch: 'main',
    engine: 'claude', model: 'Sonnet 4.6', mode: 'default', state: 'idle', origin: 'shadow',
    cwd: '/data/blog-engine',
    summary: '（终端会话）已重写评论区的分页逻辑，等你下一步指示',
    startedAt: NOW - 5.5 * HOUR, lastActiveAt: NOW - 52 * MIN,
    cost: 2.09, tokens: 517_000, tokensBreakdown: tok(21_600, 18_200, 452_000, 25_200),
    activeMs: 47 * MIN,
  },
  // ── 完成（验收待办）──
  {
    id: 's-billing', serverId: 'node-sfo-1', project: 'billing', branch: 'feat/invoice-pdf',
    engine: 'claude', model: 'Opus 4.8', mode: 'acceptEdits', state: 'done', origin: 'platform',
    cwd: '/data/billing',
    summary: '完成：发票 PDF 生成 + 27 个测试全绿  +412 −86 · 9 files',
    startedAt: NOW - 4.2 * HOUR, lastActiveAt: NOW - 22 * MIN,
    cost: 5.44, tokens: 1_461_000, tokensBreakdown: tok(38_900, 41_700, 1_312_000, 68_400),
    activeMs: 88 * MIN, costToday: 5.44,
  },
  // ── 完成（Codex）──
  {
    id: 's-docs', serverId: 'node-sfo-1', project: 'docs-site', branch: 'main',
    engine: 'codex', model: 'GPT-5.5', mode: 'on-request', state: 'done', origin: 'platform',
    cwd: '/data/docs-site',
    summary: '完成：把 API 文档从 v1 迁到 v2，修了 14 处死链',
    startedAt: NOW - 2.8 * HOUR, lastActiveAt: NOW - 64 * MIN,
    cost: 0, tokens: 342_000, tokensBreakdown: tok(19_400, 16_800, 291_000, 14_800),
    activeMs: 51 * MIN,
  },
  // ── 出错（错误横幅 + 完整原因）──
  {
    id: 's-crawler', serverId: 'node-fra-1', project: 'crawler', branch: 'main',
    engine: 'claude', model: 'Sonnet 4.6', mode: 'default', state: 'error', origin: 'platform',
    cwd: '/data/crawler',
    error: 'git push 失败：remote: Permission to acme/crawler.git denied to deploy-bot (403)',
    summary: 'git push 被拒（403）：deploy-bot 无写权限',
    startedAt: NOW - 1.6 * HOUR, lastActiveAt: NOW - 35 * MIN,
    cost: 0.71, tokens: 118_000, tokensBreakdown: tok(9_200, 7_400, 94_600, 6_800),
    activeMs: 12 * MIN, costToday: 0.71,
  },
  // ── 离线节点上的会话：靠上一轮成功缓存兜住（stale），不会瞬间消失又重现 ──
  {
    id: 's-analytics', serverId: 'node-hkg-1', project: 'analytics', branch: 'feat/funnel',
    engine: 'codex', model: 'GPT-5.5', mode: 'on-request', state: 'idle', origin: 'shadow',
    cwd: '/data/analytics',
    summary: '（该节点当前离线，展示的是最后一次成功拉取的缓存）',
    startedAt: NOW - 6.4 * HOUR, lastActiveAt: NOW - 2.2 * HOUR,
    cost: 0, tokens: 208_000, tokensBreakdown: tok(12_100, 9_800, 178_000, 8_100),
    activeMs: 29 * MIN,
  },
]

export const pendingActions: PendingAction[] = [
  {
    id: 'a-rm-cache', sessionId: 's-infra', kind: 'approval',
    title: '请求执行 rm -rf /var/lib/build-cache/*',
    detail: 'rm -rf /var/lib/build-cache/*',
    risk: '不可逆。将永久删除该目录下全部内容（当前约 6.2 GB，含 4 个仍在用的构建缓存）。',
    context: 'CI 盘用量已到 91%，助手判断构建缓存可清。但 /var/lib/build-cache 下混着 4 个近 24h 仍被引用的缓存，删掉会让下次构建全量重跑。',
    createdAt: NOW - 3 * MIN, status: 'pending',
  },
  {
    id: 'a-q-migration', sessionId: 's-pipeline', kind: 'question',
    title: '两条迁移撞车了，合并还是回滚？',
    detail: '检测到两条同号迁移：`0042_add_index`（你上周的）与 `0042_add_column`（同事今早的）。\n\n合并需要手工重排依赖；回滚其一则会丢掉已经在预发环境跑过的数据变更。你倾向哪种？',
    quickReplies: ['合并并重排', '回滚 add_column', '先给我看两边的 diff'],
    createdAt: NOW - 7 * MIN, status: 'pending',
  },
  {
    id: 'a-plan-vector', sessionId: 's-search', kind: 'plan',
    title: '计划待确认：向量检索接入',
    detail: '1. 引入 pgvector，为 documents 表加 embedding 列（1536 维）\n2. 写一个回填脚本，分批把 82 万条历史文档跑一遍 embedding（预计 4.5h / $38）\n3. 检索层改成混合召回：BM25 取 top-100 → 向量重排取 top-10\n4. 加一组离线评测集（200 条人工标注 query），先证明比现在好再切流量',
    createdAt: NOW - 11 * MIN, status: 'pending',
  },
  {
    id: 'a-review-billing', sessionId: 's-billing', kind: 'review',
    title: '发票 PDF 生成已完成',
    detail: '实现 PDF 渲染 + 多币种金额格式化 + 合规字段校验，27 个测试全绿。\n+412 −86 · 9 files。已在预发跑通 3 张真实历史发票。',
    createdAt: NOW - 22 * MIN, status: 'pending',
  },
  {
    id: 'a-review-docs', sessionId: 's-docs', kind: 'review',
    title: 'API 文档 v1 → v2 迁移已完成',
    detail: '迁移 63 个页面，修复 14 处死链，补齐 8 个缺失的响应示例。链接检查器全绿。',
    createdAt: NOW - 64 * MIN, status: 'pending',
  },
]

export const chatEvents: Record<string, ChatEvent[]> = {
  // 主线：一段"有故事"的对话——提问 → 读代码 → 跑命令 → 改文件 → 撞上审批 → 继续
  's-acme-api': [
    {
      id: 'e1', sessionId: 's-acme-api', ts: NOW - 2.3 * HOUR, type: 'user',
      text: '网关最近被刷崩过两次。给 /v1/* 加限流，按 API key 维度，不要引新中间件依赖。',
    },
    {
      id: 'e2', sessionId: 's-acme-api', ts: NOW - 2.28 * HOUR, type: 'assistant',
      text: '先看现在的网关是怎么分发的，确认在哪一层插限流最省事。',
    },
    { id: 'e3', sessionId: 's-acme-api', ts: NOW - 2.26 * HOUR, type: 'file_op', verb: '读取文件', path: 'src/gateway/router.ts' },
    { id: 'e4', sessionId: 's-acme-api', ts: NOW - 2.24 * HOUR, type: 'file_op', verb: '读取文件', path: 'src/gateway/middleware/auth.ts' },
    {
      id: 'e5', sessionId: 's-acme-api', ts: NOW - 2.2 * HOUR, type: 'assistant',
      text: `鉴权中间件里已经解出了 \`ctx.apiKey\`，限流插在它**之后**最自然——不用再解一次 key，也不会把未鉴权流量算进配额。

方案：**令牌桶**，桶存在进程内 \`Map\`（你说了不引新依赖，所以先不上 Redis）。

\`\`\`ts
// 每个 key 一个桶：容量 = 突发上限，refill = 稳态速率
type Bucket = { tokens: number; last: number }
const buckets = new Map<string, Bucket>()
\`\`\`

⚠️ 有个前提要跟你确认：**进程内桶在多实例下是不准的**（每个实例各算各的，实际放行量 = 配额 × 实例数）。你们网关现在是几个实例？`,
    },
    { id: 'e6', sessionId: 's-acme-api', ts: NOW - 2.1 * HOUR, type: 'user', text: '4 个实例。先按单实例做，配额除以 4，后面再上 Redis。' },
    {
      id: 'e7', sessionId: 's-acme-api', ts: NOW - 2.05 * HOUR, type: 'assistant',
      text: '明白。那我按「稳态 25 req/s、突发 50」来配（= 全局 100/200 除以 4），并在代码里留一句注释说明这个除法从哪来，免得日后有人加实例忘了改。',
    },
    { id: 'e8', sessionId: 's-acme-api', ts: NOW - 1.9 * HOUR, type: 'file_op', verb: '创建文件', path: 'src/gateway/middleware/rate-limit.ts', additions: 94 },
    { id: 'e9', sessionId: 's-acme-api', ts: NOW - 1.7 * HOUR, type: 'file_op', verb: '更新文件', path: 'src/gateway/router.ts', additions: 6, deletions: 1 },
    { id: 'e10', sessionId: 's-acme-api', ts: NOW - 1.4 * HOUR, type: 'file_op', verb: '执行命令', path: 'npm test -- rate-limit' },
    {
      id: 'e11', sessionId: 's-acme-api', ts: NOW - 1.3 * HOUR, type: 'assistant',
      text: '12 个用例过了 11 个。挂的那个是「突发耗尽后应返回 429 且带 Retry-After」——我漏了响应头。补上。',
    },
    { id: 'e12', sessionId: 's-acme-api', ts: NOW - 1.2 * HOUR, type: 'file_op', verb: '更新文件', path: 'src/gateway/middleware/rate-limit.ts', additions: 8, deletions: 2 },
    { id: 'e13', sessionId: 's-acme-api', ts: NOW - 1.1 * HOUR, type: 'file_op', verb: '执行命令', path: 'npm test -- rate-limit' },
    { id: 'e14', sessionId: 's-acme-api', ts: NOW - 1.05 * HOUR, type: 'turn_end', durationSec: 4_380, tokens: 986_000, cost: 3.62 },
    { id: 'e15', sessionId: 's-acme-api', ts: NOW - 52 * MIN, type: 'user', text: '12 个都过了？那再压一下：并发 500 打 30 秒，看 p99 和内存。' },
    { id: 'e16', sessionId: 's-acme-api', ts: NOW - 48 * MIN, type: 'file_op', verb: '执行命令', path: 'npx autocannon -c 500 -d 30 http://localhost:8080/v1/ping' },
    {
      id: 'e17', sessionId: 's-acme-api', ts: NOW - 41 * MIN, type: 'assistant',
      text: `压测结果：

| 指标 | 值 |
|---|---|
| 吞吐 | 24.8k req/s |
| p50 | 3 ms |
| p99 | 41 ms |
| 429 占比 | 71.2%（符合预期：500 并发远超 25 r/s 配额）|

**但内存有问题**：跑完 RSS 从 82MB 涨到 340MB 且不回落。原因是 \`buckets\` 这个 Map **只增不删**——每个见过的 API key 都留了一个桶，压测用了 5000 个随机 key。

真实场景 key 数量有限，但只要有人拿随机 key 打，这就是一条**内存泄漏**。我加个惰性清理：桶满且 5 分钟没用过就删。`,
    },
    { id: 'e18', sessionId: 's-acme-api', ts: NOW - 32 * MIN, type: 'file_op', verb: '更新文件', path: 'src/gateway/middleware/rate-limit.ts', additions: 17, deletions: 3 },
    { id: 'e19', sessionId: 's-acme-api', ts: NOW - 18 * MIN, type: 'file_op', verb: '执行命令', path: 'npx autocannon -c 500 -d 30 http://localhost:8080/v1/ping' },
    {
      id: 'e20', sessionId: 's-acme-api', ts: NOW - 12 * MIN, type: 'assistant',
      text: '这次跑完 RSS 回落到 88MB，p99 42ms 基本没变。现在补一个「桶被清理后再来请求」的回归用例，防止有人日后把清理阈值调错。',
    },
    { id: 'e21', sessionId: 's-acme-api', ts: NOW - 6 * MIN, type: 'file_op', verb: '更新文件', path: 'test/rate-limit.test.ts', additions: 34 },
    {
      id: 'e22', sessionId: 's-acme-api', ts: NOW - 20_000, type: 'assistant',
      text: '正在跑最后一轮全量测试，顺便看一眼 lint……',
      streaming: true,
    },
  ],

  // 审批场景：点开审批卡能看到"它为什么要删"的完整上下文
  's-infra': [
    {
      id: 'i1', sessionId: 's-infra', ts: NOW - 36 * MIN, type: 'user',
      text: 'CI 盘满了，帮我清一下能清的东西。',
    },
    { id: 'i2', sessionId: 's-infra', ts: NOW - 34 * MIN, type: 'file_op', verb: '执行命令', path: 'df -h /var/lib && du -sh /var/lib/* | sort -rh | head' },
    {
      id: 'i3', sessionId: 's-infra', ts: NOW - 30 * MIN, type: 'assistant',
      text: `盘用到 **91%**。占大头的三块：

| 目录 | 大小 |
|---|---|
| \`/var/lib/build-cache\` | 6.2 GB |
| \`/var/lib/docker\` | 4.1 GB |
| \`/var/lib/apt\` | 0.8 GB |

docker 那块不敢乱动（在跑的容器分层就在里面）。build-cache 看着是可清的——但我先查一下有没有还在被引用的。`,
    },
    { id: 'i4', sessionId: 's-infra', ts: NOW - 22 * MIN, type: 'file_op', verb: '执行命令', path: 'find /var/lib/build-cache -maxdepth 1 -atime -1 | head' },
    {
      id: 'i5', sessionId: 's-infra', ts: NOW - 8 * MIN, type: 'assistant',
      text: `**有 4 个缓存近 24 小时内还被访问过。** 全删的话下次构建会全量重跑（估计多花 8~12 分钟）。

两个选择：
1. **全删**（省 6.2 GB，代价是下次构建慢一次）
2. **只删 7 天没动过的**（省 ~4.4 GB，不影响近期构建）

我倾向 2，但你盘已经 91% 了，如果你要的是「一次清干净」，我就走 1。

下面这条命令要动你的盘，**需要你授权**：`,
    },
    { id: 'i6', sessionId: 's-infra', ts: NOW - 3 * MIN, type: 'file_op', verb: '执行命令', path: 'rm -rf /var/lib/build-cache/*' },
  ],

  // 影子会话：终端里起的，Web 只读追踪
  'b9c8d7e6-0000-1111-2222-333344445555': [
    { id: 'b1', sessionId: 'b9c8d7e6-0000-1111-2222-333344445555', ts: NOW - 70 * MIN, type: 'user', text: '评论区翻页现在是 offset 分页，数据一多就慢。换成游标分页。' },
    { id: 'b2', sessionId: 'b9c8d7e6-0000-1111-2222-333344445555', ts: NOW - 66 * MIN, type: 'file_op', verb: '读取文件', path: 'src/api/comments.ts' },
    {
      id: 'b3', sessionId: 'b9c8d7e6-0000-1111-2222-333344445555', ts: NOW - 61 * MIN, type: 'assistant',
      text: '现在是 `OFFSET ? LIMIT ?`，第 500 页开始就要扫 5 万行。改成按 `(created_at, id)` 复合游标，索引直接定位。注意要带 id 兜底——同一毫秒发的两条评论会撞 created_at。',
    },
    { id: 'b4', sessionId: 'b9c8d7e6-0000-1111-2222-333344445555', ts: NOW - 57 * MIN, type: 'file_op', verb: '更新文件', path: 'src/api/comments.ts', additions: 41, deletions: 18 },
    { id: 'b5', sessionId: 'b9c8d7e6-0000-1111-2222-333344445555', ts: NOW - 54 * MIN, type: 'file_op', verb: '创建文件', path: 'migrations/0043_comments_cursor_idx.sql', additions: 4 },
    {
      id: 'b6', sessionId: 'b9c8d7e6-0000-1111-2222-333344445555', ts: NOW - 52 * MIN, type: 'assistant',
      text: '改完了。第 500 页从 **840ms → 6ms**。迁移脚本建了 `(created_at DESC, id DESC)` 复合索引，记得上线前先在从库跑一遍。',
    },
  ],
}

export const sessionExtras: Record<string, SessionExtras> = {
  's-acme-api': {
    fileChanges: [
      {
        path: 'src/gateway/middleware/rate-limit.ts', additions: 17, deletions: 3,
        lines: [
          { kind: 'ctx', no: 61, text: 'const buckets = new Map<string, Bucket>()' },
          { kind: 'ctx', no: 62, text: '' },
          { kind: 'del', no: 63, text: 'function take(key: string): boolean {' },
          { kind: 'add', no: 63, text: '// 惰性清理：桶满(=长期没被消耗) 且 5min 未使用即回收。' },
          { kind: 'add', no: 64, text: '// 不加这个的话 buckets 只增不删——随机 key 打一轮就是内存泄漏' },
          { kind: 'add', no: 65, text: '// （压测实测 RSS 82MB → 340MB 且不回落）。' },
          { kind: 'add', no: 66, text: 'const IDLE_MS = 5 * 60_000' },
          { kind: 'add', no: 67, text: '' },
          { kind: 'add', no: 68, text: 'function take(key: string, now = Date.now()): boolean {' },
          { kind: 'ctx', no: 69, text: '  const b = buckets.get(key) ?? { tokens: BURST, last: now }' },
          { kind: 'ctx', no: 70, text: '  b.tokens = Math.min(BURST, b.tokens + (now - b.last) * RATE / 1000)' },
          { kind: 'ctx', no: 71, text: '  b.last = now' },
          { kind: 'add', no: 72, text: '  if (b.tokens >= BURST && now - b.last > IDLE_MS) { buckets.delete(key); return true }' },
          { kind: 'ctx', no: 73, text: '  if (b.tokens < 1) return false' },
          { kind: 'del', no: 74, text: '  b.tokens -= 1' },
          { kind: 'add', no: 74, text: '  b.tokens -= 1' },
          { kind: 'ctx', no: 75, text: '  buckets.set(key, b)' },
          { kind: 'ctx', no: 76, text: '  return true' },
          { kind: 'ctx', no: 77, text: '}' },
        ],
      },
      {
        path: 'src/gateway/router.ts', additions: 6, deletions: 1,
        lines: [
          { kind: 'ctx', no: 22, text: "import { auth } from './middleware/auth'" },
          { kind: 'add', no: 23, text: "import { rateLimit } from './middleware/rate-limit'" },
          { kind: 'ctx', no: 24, text: '' },
          { kind: 'ctx', no: 25, text: "router.use('/v1', auth)" },
          { kind: 'add', no: 26, text: '// 必须在 auth 之后：limiter 依赖 ctx.apiKey，' },
          { kind: 'add', no: 27, text: '// 且未鉴权流量不该算进配额。' },
          { kind: 'add', no: 28, text: "router.use('/v1', rateLimit)" },
          { kind: 'del', no: 29, text: "router.use('/v1', routes)" },
          { kind: 'add', no: 29, text: "router.use('/v1', routes)" },
        ],
      },
      {
        path: 'test/rate-limit.test.ts', additions: 34, deletions: 0,
        lines: [
          { kind: 'add', no: 88, text: "it('桶被回收后再来请求，应重新发放而不是直接 429', async () => {" },
          { kind: 'add', no: 89, text: '  const key = "k-idle"' },
          { kind: 'add', no: 90, text: '  for (let i = 0; i < BURST; i++) expect(take(key, T0)).toBe(true)' },
          { kind: 'add', no: 91, text: '  expect(take(key, T0)).toBe(false)            // 桶空了' },
          { kind: 'add', no: 92, text: '  expect(take(key, T0 + IDLE_MS + 1)).toBe(true) // 回收后重新发放' },
          { kind: 'add', no: 93, text: '})' },
        ],
      },
    ],
    todos: [
      { text: '读现有网关分发逻辑，定位插入点', status: 'done' },
      { text: '实现令牌桶（进程内，单实例配额 = 全局 / 4）', status: 'done' },
      { text: '补 429 + Retry-After 响应头', status: 'done' },
      { text: '压测：并发 500 / 30s，看 p99 与内存', status: 'done' },
      { text: '修内存泄漏（buckets 只增不删）+ 回归用例', status: 'done' },
      { text: '跑全量测试 + lint', status: 'active' },
      { text: '写 ADR：为什么先不上 Redis', status: 'pending' },
    ],
  },
  's-infra': {
    fileChanges: [],
    todos: [
      { text: '统计 /var/lib 占用', status: 'done' },
      { text: '排查 build-cache 是否仍被引用', status: 'done' },
      { text: '等待授权：rm -rf /var/lib/build-cache/*', status: 'active' },
      { text: '清理后复测盘用量', status: 'pending' },
    ],
  },
}
