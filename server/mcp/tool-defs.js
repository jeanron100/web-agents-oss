// server/mcp/tool-defs.js
// 纯数据：MCP 对外广播的工具清单。从 index.js 拆出来，专为 M7 这条红线服务——
// 「这套系统里没有任何工具能批准/拒绝审批」目前只写在注释和 pending_list 的
// description 里，属于口头承诺。index.js 本身在 import 时就会启动 stdio 传输、
// 连真实 hub（副作用不可测），没法直接 import 来断言"暴露的工具集合"；
// 把 DEFS 拆成零副作用的纯数据模块，才能在测试里断言它恰好是 5 个只读工具，
// 一旦未来有人偷偷加一个 approve_action/reject_action，这里的名单测试会先炸。
export const BATCH = '若返回 hasMore=true，用返回的 nextOffset 作为 offset 再调一次可取下一批。'

export const DEFS = [
  { name: 'project_progress', description: `项目小助理：自然语言查各服务器项目交办、原因、解决办法、经验和风险，结合有明确范围的当前状态。支持question、project、serverId、days（默认7；36500为全部已沉淀历史）。与网页共用证据及问答；analysis.status为planning/answering或refreshing=true时按retryAfterMs重试。历史结果不是当前实测，Hub本机服务数不是全服务器隧道总数。用taskId调用task_evidence溯源。${BATCH}`,
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, project: { type: 'string' }, serverId: { type: 'string' }, days: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'task_evidence', description: `读取project_progress返回的taskId对应的原始交办、当时回复和操作摘录。只读，含服务器、项目、会话、时间与截断说明。${BATCH}`,
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, offset: { type: 'number' } }, required: ['taskId'] } },
  { name: 'fleet_overview', description: `已配置节点一屏摘要：在线、会话并发闸门饱和度、各状态会话数、待办数。排查「操作全部超时」时先看这个——闸门满是最常见的真因。${BATCH}`,
    inputSchema: { type: 'object', properties: { offset: { type: 'number' } } } },
  { name: 'session_find', description: `按条件查找会话。默认排序按最近活跃优先（问"现在什么状况"要的是最近，不是最古老的记录）。stuck=true 只返回卡住的（空闲在 30 分钟~24 小时区间内、回合不在飞、不在等待用户、且未 detached——已分离/detached 的会话只是历史记录，不计入卡住），此时按空闲时长降序排列（最可疑的排最前）。limit 默认 20，硬上限 100（更大的值会被砍到 100）。${BATCH}`,
    inputSchema: { type: 'object', properties: {
      serverId: { type: 'string' }, project: { type: 'string' },
      engine: { type: 'string', enum: ['claude', 'codex', 'kimi'] }, state: { type: 'string' },
      stuck: { type: 'boolean' }, minIdleMin: { type: 'number' },
      limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'session_detail', description: `单个会话的状态与最近事件。${BATCH}`,
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' }, events: { type: 'number' }, offset: { type: 'number' } },
      required: ['sessionId'] } },
  { name: 'session_tail', description: `只取会话最近事件。cursor 用于跨调用的服务端增量续拉；offset 用于本次结果内分批。${BATCH}`,
    inputSchema: { type: 'object', properties: {
      sessionId: { type: 'string' }, since: { type: 'string' },
      limit: { type: 'number' }, offset: { type: 'number' } }, required: ['sessionId'] } },
  { name: 'pending_list', description: `只读查看待办（审批/计划/提问/评审）。注意：本 MCP 不提供批准或拒绝的能力——审批必须由人处理。${BATCH}`,
    inputSchema: { type: 'object', properties: { offset: { type: 'number' } } } },
  { name: 'history_search', description: `跨会话/跨时间窗查**长程历史**（可选 Mongo 持久投影，按实际配置和采集覆盖返回）——与 session_tail 是两个互补工具，别选错：session_tail 答"现在/刚刚在干什么"（agent 内存里最近约 150 条，实时，只能查还活着或刚结束不久的会话）；history_search 答"几天/几周前那个会话做了什么"（能查早已不在内存里的旧会话，但事件已被投影摘要——是"发生过 tool.used/assistant.message/user.message 这类事"的结构化记录，不是完整对话原文）。session 参数接受平台会话 id（ps-xxxx）或原生 uuid 均可，服务端会自动解析。必须至少给 session/project/serverId/type/fromMs/toMs 之一——不给任何过滤条件会被拒绝并提示收窄，不会去扫全部历史再截断。若 Mongo 存储当前不可用，返回 available:false 并明确告知"查不到"而非悄悄报成"没有历史"。${BATCH}`,
    inputSchema: { type: 'object', properties: {
      session: { type: 'string' }, project: { type: 'string' }, serverId: { type: 'string' },
      type: { type: 'string' }, fromMs: { type: 'number' }, toMs: { type: 'number' },
      limit: { type: 'number' }, offset: { type: 'number' } } } },
]
