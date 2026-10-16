// 结构化抽取层的回归测试（openspec change: execution-history-archive，P1）。
//
// 从归档原文里抽出**可查字段**：跑过的命令、文件变更、用户提问、助手结论、模型与用量。
// 三种引擎的 JSONL 格式各不相同，所以三条路各自要有用例。
//
// ★ 抽取结果是**派生数据**（design D6）：schema 变了就从原文重跑，不回源机器。
//   所以这一层可以放心迭代——真正不可逆的是 P0 的原文归档。

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSession, summarize } from './archive-extract.js'

// ── Claude：assistant/user 消息 + tool_use ──
const claudeLines = [
  JSON.stringify({ type: 'user', timestamp: '2026-08-20T10:00:00Z', message: { role: 'user', content: '帮我修一下对话流加载慢的问题' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T10:00:05Z', message: { role: 'assistant', model: 'claude-opus-5', content: [
    { type: 'text', text: '先分段计时定位瓶颈。' },
    { type: 'tool_use', name: 'Bash', input: { command: 'curl -s -o /dev/null -w "%{time_total}" localhost:8787/api/state' } },
  ], usage: { input_tokens: 1200, output_tokens: 340 } } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T10:01:00Z', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: '/data/web_agents/server/hub.js', old_string: 'a', new_string: 'b' } },
  ] } }),
]

test('★ Claude：抽出用户提问、命令、文件变更、模型与 token', () => {
  const r = extractSession({ engine: 'claude', host: 'h1', project: '-data-web-agents', session: 's1', lines: claudeLines })
  assert.equal(r.engine, 'claude')
  assert.equal(r.firstPrompt, '帮我修一下对话流加载慢的问题')
  assert.deepEqual(r.commands.map((c) => c.cmd), ['curl -s -o /dev/null -w "%{time_total}" localhost:8787/api/state'])
  assert.deepEqual(r.files, ['/data/web_agents/server/hub.js'])
  assert.equal(r.model, 'claude-opus-5')
  assert.equal(r.tokens, 1540)
  assert.equal(r.turns, 3)
  assert.ok(r.startedAt > 0 && r.lastAt >= r.startedAt)
})

// ── Codex：rollout 真实格式（2026-08-29 从线上归档取的样本，**不是我猜的**）──
// ⚠️ 初版夹具是我照直觉编的（payload.arguments.command 数组），真实数据一跑全是 0：
//    实际字段是 `arguments` 里的 **`cmd`**（字符串），命令更好的来源是 `exec_command_end.command`；
//    而**项目名根本不在路径上**——codex 按日期分目录，cwd 在 `session_meta.payload.cwd` 里。
//    **夹具靠猜，测试就只是在验证我的想象。**
const codexLines = [
  JSON.stringify({ timestamp: '2026-04-20T07:05:59Z', type: 'session_meta', payload: { id: 'x', cwd: '/data/daily_feedback', cli_version: '0.122.0' } }),
  JSON.stringify({ timestamp: '2026-04-20T07:06:00Z', type: 'event_msg', payload: { type: 'user_message', message: '# Context from my IDE setup:\n\n## Open tabs:\n- CLAUDE.md\n\n## My request for Codex:\n再检查下 docs 下的修改意见\n' } }),
  JSON.stringify({ timestamp: '2026-04-20T07:06:10Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git status --short docs', workdir: '/data/daily_feedback' }) } }),
  JSON.stringify({ timestamp: '2026-04-20T07:06:12Z', type: 'event_msg', payload: { type: 'exec_command_end', command: ['/bin/bash', '-lc', 'npx next build'], cwd: '/data/daily_feedback' } }),
  JSON.stringify({ timestamp: '2026-04-20T07:06:20Z', type: 'event_msg', payload: { type: 'agent_message', message: '我先看一下 docs 下的改动。' } }),
]

test('★★ Codex：项目名必须取自 session_meta.cwd —— 路径上是日期，不是项目', () => {
  const r = extractSession({ engine: 'codex', host: 'h1', project: '2026', session: 's2', lines: codexLines })
  assert.equal(r.project, '-data-daily-feedback', `实际 ${r.project}`)
})

test('★ Codex：命令要抽得出（arguments.cmd 与 exec_command_end.command 两个来源）', () => {
  const r = extractSession({ engine: 'codex', host: 'h1', project: '2026', session: 's2', lines: codexLines })
  const cmds = r.commands.map((c) => c.cmd)
  assert.ok(cmds.some((c) => c.includes('git status --short docs')), JSON.stringify(cmds))
  assert.ok(cmds.some((c) => c.includes('npx next build')), JSON.stringify(cmds))
})

test('★ Codex：提问要剥掉 IDE 前言，留真正的请求', () => {
  // 真实数据里 user_message 前面挂着一大段 "# Context from my IDE setup"，
  // 不剥掉的话每个 codex 会话的"提问"看起来都一样，检索时完全没有区分度。
  const r = extractSession({ engine: 'codex', host: 'h1', project: '2026', session: 's2', lines: codexLines })
  assert.equal(r.firstPrompt, '再检查下 docs 下的修改意见')
})

// ── Kimi：wire.jsonl 真实格式（同样是线上取的样本）──
const kimiLines = [
  JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1785632870540 }),
  JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: '把 KB 同步脚本跑一遍' }], origin: { kind: 'user' }, time: 1785632871000 }),
  JSON.stringify({ type: 'llm.request', kind: 'loop', provider: 'kimi', model: 'kimi-for-coding' }),   // ← 无 time
  JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: '好的，我先检查连通性。' }] } }), // ← 无 time
]

test('★★ Kimi：不带 time 的行不得让时间戳归零（界面会显示 1970）', () => {
  // CLAUDE.md 记着这条：wire.jsonl 里有不带 time 的行，**助手回复恰在其中**，
  // 丢了它时间戳就归零。抽取层必须沿用上一条已知时间。
  const r = extractSession({ engine: 'kimi', host: 'h1', project: '-data-kb', session: 's3', lines: kimiLines })
  assert.ok(r.startedAt > 0, '起始时间不得为 0')
  assert.ok(r.lastAt > 0, `末次时间不得归零，实际 ${r.lastAt}`)
  assert.ok(new Date(r.lastAt).getUTCFullYear() > 2000, '不得回到 1970')
})

test('★ Kimi：提问取 turn.prompt，模型取 llm.request', () => {
  const r = extractSession({ engine: 'kimi', host: 'h1', project: '-data-kb', session: 's3', lines: kimiLines })
  assert.equal(r.firstPrompt, '把 KB 同步脚本跑一遍')
  assert.equal(r.model, 'kimi-for-coding')
})

// ── 稳健性 ──

test('坏行不得让整段抽取失败 —— 归档里必然混着半行/异常行', () => {
  const r = extractSession({ engine: 'claude', host: 'h', project: 'p', session: 's', lines: ['{坏行', '', ...claudeLines] })
  assert.equal(r.firstPrompt, '帮我修一下对话流加载慢的问题')
  assert.ok(r.parseErrors >= 1)
})

test('空输入返回可用的空结构，不抛', () => {
  const r = extractSession({ engine: 'claude', host: 'h', project: 'p', session: 's', lines: [] })
  assert.deepEqual(r.commands, [])
  assert.equal(r.turns, 0)
})

test('★ 命令去重但保留次数 —— 同一条命令跑 50 次不该占满索引', () => {
  const lines = Array.from({ length: 50 }, () => JSON.stringify({
    type: 'assistant', timestamp: '2026-08-20T10:00:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  }))
  const r = extractSession({ engine: 'claude', host: 'h', project: 'p', session: 's', lines })
  assert.equal(r.commands.length, 1)
  assert.equal(r.commands[0].n, 50)
})

test('★ summarize 给出适合做 embedding 的一段文本（首期每会话 1 向量）', () => {
  const r = extractSession({ engine: 'claude', host: 'h1', project: '-data-web-agents', session: 's1', lines: claudeLines })
  const t = summarize(r)
  assert.ok(t.includes('web-agents') || t.includes('web_agents'), t)
  assert.ok(t.includes('对话流加载慢'), t)
  assert.ok(t.includes('hub.js'), '改过的文件应进摘要，它是很强的检索线索')
  assert.ok(t.length <= 2000, `摘要过长会拖慢 embedding：${t.length}`)
})

test('★ 摘要必须带坐标 —— 检索结果 100% 可溯源是 GOAL 的硬指标', () => {
  const r = extractSession({ engine: 'claude', host: 'h1', project: '-data-x', session: 'sX', lines: claudeLines })
  assert.equal(r.host, 'h1')
  assert.equal(r.project, '-data-x')
  assert.equal(r.session, 'sX')
})

// ───────── 用户实测：搜不到深处的内容（2026-08-31）─────────
//
// 实测：`Z_SYNC_FLUSH` 这个词我们讨论了很多、代码里也有，但检索 0 条命中。
// 查因：每条消息被 `clip(content, 300)` 砍断，**48,876 条消息里 17,718 条（36%）超了 300 字**
// ⇒ 助手的长回复只有开头 300 字进索引，中后段全部不可检索。
// ★ 这不是"召回算法不好"，是**语料压根没进去**——再好的检索也搜不到没索引的东西。

test('★★ 正文截断上限必须够长：300 字砍掉了 36% 的消息主体', () => {
  const long = 'A'.repeat(500) + ' Z_SYNC_FLUSH ' + 'B'.repeat(1000)   // 关键词在第 500 字，旧的 300 上限必然砍掉
  const r = extractSession({
    engine: 'claude', host: 'h', project: 'p', session: 's',
    lines: [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } })],
  })
  const joined = (r.texts ?? []).join(' ')
  assert.ok(joined.includes('Z_SYNC_FLUSH'), `第 200 字之后的关键词必须能进索引：实际只留了 ${joined.length} 字`)
})

test('★ 上限可配（不同机器内存余量不同）', () => {
  const long = 'x'.repeat(5000)
  const small = extractSession({ engine: 'claude', host: 'h', project: 'p', session: 's', textClip: 100,
    lines: [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } })] })
  assert.ok((small.texts ?? []).join('').length <= 120)
})

test('★ 但仍要有上限 —— 单条 33 万字的消息不能整条进内存索引', () => {
  const huge = 'y'.repeat(400_000)
  const r = extractSession({ engine: 'claude', host: 'h', project: 'p', session: 's',
    lines: [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: huge }] } })] })
  assert.ok((r.texts ?? []).join('').length < 10_000, '单条消息不得无限进索引')
})

// ── 2026-09-05：token 按 message.id 去重（与 agent.js 同一病根，不同出口）────────────
// Claude Code 把一条 assistant 消息按 content block 拆成多行 JSONL，每行都带完整 usage。
// 归档索引这里也在逐行累加 ⇒ 检索结果卡片上显示的 tokens 同样虚高（实测全量虚高 52.8%）。
// ★ 这条是「修完一个实例要顺着同一诊断把这一类扫一遍」的产物——不扫就只修了看得见的那半边。
test('★ 多 block 行的同一条 message 只计一次 token', () => {
  const L = (out) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-05T00:00:00Z',
    message: { id: 'msg_same', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 2, output_tokens: out } },
  })
  const r = extractSession({ engine: 'claude', host: 'h1', project: '-p', session: 's', lines: [L(1), L(1), L(374)] })
  assert.equal(r.tokens, 376, '2 + 374；逐行累加会得到 380')
})
