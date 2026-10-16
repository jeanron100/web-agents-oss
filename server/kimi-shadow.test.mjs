// node --test server/kimi-shadow.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIndexLine, parseWire, projectOfWorkDir } from './kimi-shadow.js'

test('Kimi lifecycle survives incremental scans and bookkeeping after completion', () => {
  const start = parseWire('{"type":"agent.turn.started","turnId":"one","time":100}\n')
  const end = parseWire('{"type":"agent.turn.ended","turnId":"one","time":200}\n{"type":"usage.record","time":210}\n', start.state)
  assert.deepEqual(end.state.turn, { running: false, id: 'one' })
  const next = parseWire('{"type":"agent.turn.started","turnId":"two","time":300}\n', end.state)
  assert.deepEqual(next.state.turn, { running: true, id: 'two' })
  assert.deepEqual(next.state.turn, parseWire('{"type":"agent.turn.started","turnId":"one","time":100}\n{"type":"agent.turn.ended","turnId":"one","time":200}\n{"type":"usage.record","time":210}\n{"type":"agent.turn.started","turnId":"two","time":300}\n').state.turn)
})

test('索引行 → {sessionId, sessionDir, workDir}；坏行不炸', () => {
  const ok = parseIndexLine('{"sessionId":"session_a","sessionDir":"/root/.kimi-code/sessions/wd_x/session_a","workDir":"/data/foo"}')
  assert.deepEqual(ok, { sessionId: 'session_a', sessionDir: '/root/.kimi-code/sessions/wd_x/session_a', workDir: '/data/foo' })
  assert.equal(parseIndexLine('{半行'), null)
  assert.equal(parseIndexLine(''), null)
  assert.equal(parseIndexLine('{"sessionId":"x"}'), null, '缺 workDir/sessionDir 不算有效条目')
})

test('workDir → 项目名（取末段，与 Claude/Codex 的 path.basename 口径一致）', () => {
  assert.equal(projectOfWorkDir('/data/invest_data'), 'invest_data')
  assert.equal(projectOfWorkDir('/data/invest_data/'), 'invest_data')
  assert.equal(projectOfWorkDir('/root'), 'root')
  assert.equal(projectOfWorkDir(''), '')
})

const WIRE = [
  '{"type":"metadata","protocol_version":"1.4","created_at":1785556806837}',
  '{"type":"turn.prompt","input":[{"type":"text","text":"只回复两个字：就绪"}],"origin":{"kind":"user"},"time":1785556806921}',
  '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"只回复两个字：就绪"}],"origin":{"kind":"user"}},"time":1785556806923}',
  '{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nAuto permission mode is active.\\n</system-reminder>"}],"origin":{"kind":"system"}},"time":1785556806924}',
  '{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"就绪"}]},"time":1785556809700}',
  '{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":2511,"output":27,"inputCacheRead":17920,"inputCacheCreation":0},"usageScope":"turn","time":1785556809727}',
].join('\n')

test('★ wire.jsonl → 事件流：只留真实对话，剔除 system-reminder 注入', () => {
  // kimi 把权限模式提示等以 role:"user" 注入上下文。照单全收的话，用户会在对话流里
  // 看到自己"发过"一堆从没发过的英文系统提示（Claude 侧同类注入也是这么被滤掉的）。
  const r = parseWire(WIRE)
  assert.deepEqual(r.events.map((e) => [e.type, e.text]), [
    ['user', '只回复两个字：就绪'],
    ['assistant', '就绪'],
  ])
})

test('token 与 model 从 usage.record 累加', () => {
  const r = parseWire(WIRE)
  assert.equal(r.model, 'kimi-code/kimi-for-coding')
  assert.equal(r.tok.input, 2511)
  assert.equal(r.tok.output, 27)
  assert.equal(r.tok.cacheRead, 17920)
})

test('lastActiveAt 取最后一条带 time 的记录', () => {
  assert.equal(parseWire(WIRE).lastActiveAt, 1785556809727)
})

test('★ 图片消息：不把 base64 塞进 text，只记数量', () => {
  // wire.jsonl 里图片是内联 data URL（实测单张就 100KB 级）。原样进事件流会把 /api/state
  // 的载荷撑爆——这正是 toWire 当初要剥 base64 的原因，别在入口处又把它塞回去。
  const w = '{"type":"context.append_message","message":{"role":"user","content":[' +
    '{"type":"text","text":"这是什么颜色"},' +
    '{"type":"image_url","imageUrl":{"url":"data:image/png;base64,AAAABBBB"}}],"origin":{"kind":"user"}},"time":9}'
  const r = parseWire(w)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].text, '这是什么颜色')
  assert.equal(r.events[0].imageCount, 1)
  assert.ok(!JSON.stringify(r.events[0]).includes('AAAABBBB'), 'base64 不得进事件流')
})

test('空 / 半行 / 坏 JSON 一律容错（正在写入的文件必然有半行）', () => {
  assert.deepEqual(parseWire('').events, [])
  assert.deepEqual(parseWire('{"type":"metadata"}\n{"type":"context.appen').events, [])
  const r = parseWire(WIRE + '\n{"type":"context.append_mes')
  assert.equal(r.events.length, 2, '尾部半行不能影响已完整的行')
})

test('纯图片消息（无文本）也要产出一条事件，不能被当空消息丢掉', () => {
  const w = '{"type":"context.append_message","message":{"role":"user","content":[' +
    '{"type":"image_url","imageUrl":{"url":"data:image/png;base64,ZZ"}}],"origin":{"kind":"user"}},"time":5}'
  const r = parseWire(w)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].imageCount, 1)
})

test('★ 缺 time 字段的消息不得掉回 1970——沿用上一条的时间（用户报「时间戳明显不对」）', () => {
  // 真实 wire.jsonl 里确实存在没有 time 字段的行。原来是 `Number(o.time) || 0` ⇒ NaN ⇒ 0
  // ⇒ 界面显示 1970-01-01，而且会把该事件在按时间排序处甩到最前面。
  const wire = [
    JSON.stringify({ type: 'context.append_message', time: 1785557954356, message: { role: 'user', content: [{ type: 'text', text: '第一条' }] } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: '缺 time 的一条' }] } }),
    JSON.stringify({ type: 'context.append_message', time: 1785557954999, message: { role: 'user', content: [{ type: 'text', text: '第三条' }] } }),
  ].join('\n')
  const { events } = parseWire(wire)
  assert.equal(events.length, 3)
  assert.equal(events[0].ts, 1785557954356)
  assert.equal(events[1].ts, 1785557954356, '缺 time ⇒ 沿用上一条，绝不是 0')
  assert.equal(events[2].ts, 1785557954999)
  assert.ok(events.every((e) => e.ts > 0), '任何事件都不该是 1970')
})

test('★ 事件 id 必须唯一——缺 time 时不能全挤成同一个前缀导致 React key 冲突', () => {
  const wire = [
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'a' }] } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } }),
  ].join('\n')
  const ids = parseWire(wire).events.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际 ${ids.join(',')}`)
})

// ───────── 2026-09-27：mergeKimiEvents（用户报「Kimi 会话内容重复、排序乱」）─────────
// 两源：wire.jsonl（kw-* id，实时落盘）+ driver 内存（ev-* id，ACP 回放/流式）。
// 旧合并按事件 id 去重——命名空间不同恒为 0 ⇒ 接管后整段对话出现两次、第二份还排在末尾。

import { mergeKimiEvents } from './kimi-shadow.js'

const kw = (ts, type, text) => ({ id: `kw-${ts}-1`, ts, type, text })
const ev = (ts, type, text, extra = {}) => ({ id: `ev-x-${ts}`, ts, type, text, ...extra })
const kwOp = (ts, verb, path) => ({ id: `kw-${ts}-2`, ts, type: 'file_op', verb, path })
const evOp = (ts, verb, path) => ({ id: `ev-x-${ts}`, ts, type: 'file_op', verb, path })

test('★ 重叠段按指纹去重：同一对话不得出现两次（id 不同也不算数）', () => {
  const hist = [kw(1000, 'user', '查一下文档'), kw(2000, 'assistant', '好的'), kwOp(3000, '执行命令', 'ls /data')]
  // driver 回放：同样的三条（不同 id）+ 一条真正的新消息
  const live = [ev(1001, 'user', '查一下文档'), ev(2001, 'assistant', '好的'), evOp(3001, '执行命令', 'ls /data'), ev(9000, 'user', '再说一句')]
  const m = mergeKimiEvents(hist, live)
  const texts = m.filter((e) => e.type === 'user').map((e) => e.text)
  assert.deepEqual(texts, ['查一下文档', '再说一句'], '回放的用户消息必须去重，只留真正的新消息')
  assert.equal(m.filter((e) => e.type === 'assistant').length, 1)
  assert.equal(m.filter((e) => e.type === 'file_op').length, 1)
})

test('★ 排序：合并结果保持 wire 时序在前、只把严格更新的 live 事件接在尾部', () => {
  const hist = [kw(1000, 'user', '一'), kw(2000, 'assistant', '二')]
  const live = [ev(1000, 'user', '一'), ev(2000, 'assistant', '二'), ev(10_000, 'assistant', '三')]
  const m = mergeKimiEvents(hist, live)
  assert.deepEqual(m.map((e) => e.text), ['一', '二', '三'])
  assert.ok(m[2].id.startsWith('ev-'), '新内容来自 driver 尾部')
})

test('★ 流式尾巴必留（当前回合还没落盘 wire），但已在 wire 里的不算', () => {
  const hist = [kw(1000, 'user', '问'), kw(2000, 'assistant', '正在回复的前半段完整版')]
  const live = [
    ev(2001, 'assistant', '正在回复的前半段完整版', { streaming: true }), // wire 已有 ⇒ 去重
    ev(2100, 'assistant', '还在打字的新一句', { streaming: true }),        // wire 没有 ⇒ 必留
  ]
  const m = mergeKimiEvents(hist, live)
  assert.deepEqual(m.map((e) => e.text), ['问', '正在回复的前半段完整版', '还在打字的新一句'])
})

test('★ wire 读不到（空历史）⇒ 原样给 live（兜底行为与旧代码一致）', () => {
  const live = [ev(1000, 'user', '问'), ev(2000, 'assistant', '答')]
  assert.deepEqual(mergeKimiEvents([], live), live)
  assert.deepEqual(mergeKimiEvents(null, live), live)
})

test('★ live 为空 ⇒ 原样给 wire（影子态等价路径）', () => {
  const hist = [kw(1000, 'user', '问'), kw(2000, 'assistant', '答')]
  assert.deepEqual(mergeKimiEvents(hist, []), hist)
})

test('★ 去重不改变条数以外的任何字段（事件对象原样引用）', () => {
  const hist = [kw(1000, 'user', '问')]
  const live = [ev(10_000, 'assistant', '答', { seq: 42 })]
  const m = mergeKimiEvents(hist, live)
  assert.equal(m[0].id, hist[0].id)
  assert.equal(m[1].seq, 42, 'driver 事件的 seq（断线续传游标）必须原样保留')
})

test('★ file_op 指纹按 verb+path：词汇统一后同一操作跨源判重成功', () => {
  const hist = [kwOp(3000, '读取', '/data/a.md')]
  const live = [evOp(3001, '读取', '/data/a.md'), evOp(9000, '读取', '/data/b.md')]
  const m = mergeKimiEvents(hist, live)
  assert.deepEqual(m.map((e) => e.path), ['/data/a.md', '/data/b.md'])
})
