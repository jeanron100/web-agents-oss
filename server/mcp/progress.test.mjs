import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from './tools.js'
import { createHubClient } from './hub-client.js'

test('long Chinese synthesized answers, source labels and risks stay within the complete MCP byte budget', async () => {
  const tools=createTools({getProgress:async()=>({updatedAt:123,total:10,answer:'这是历史报告。'.repeat(500),answerSources:Array.from({length:8},(_,i)=>({id:'T'+i,taskId:'task'+i,label:'很长的项目来源标签'.repeat(30),observedAt:120})),answerSections:[{sources:Array.from({length:8},(_,i)=>'T'+i)}],tasks:Array.from({length:10},(_,i)=>({id:'task'+i,project:'项目'.repeat(100),serverId:'node',sessionId:'session',engine:'codex',status:'unconfirmed',title:'很长的交办'.repeat(100),result:'处理记录与说明'.repeat(300),risks:Array(6).fill('仍有问题需要检查'.repeat(100)),updatedAt:120}))})})
  const r=await tools.project_progress({question:'进展'})
  assert(Buffer.byteLength(JSON.stringify(r))<=8192)
  assert(r.answerExcerptTruncated);assert.equal(r.tasks[0].taskId,'task0')
  assert(r.hasMore);assert(r.nextOffset>0)
})

test('MCP keeps paragraph source IDs while grouping identical historical metadata', async () => {
  const label='历史记录报告（2026/10/15；未重新验证业务状态）：'
  const tools=createTools({getProgress:async()=>({updatedAt:1,total:0,answer:'原文',answerSections:[{text:label+'\n处理方法。',sources:['T1']},{text:label+'\n剩余风险。',sources:['T2']}],answerSources:[{id:'T1',taskId:'a'},{id:'T2',taskId:'b'}],tasks:[]})})
  const r=await tools.project_progress({question:'处理情况'})
  assert.equal(r.message.match(/历史记录报告/g).length,1);assert(r.message.includes('[T1]'));assert(r.message.includes('[T2]'))
  assert(r.message.includes('剩余风险'));assert.equal(r.answerSources[1].taskId,'b')
})

test('MCP progress returns the same task identity, state, coverage and source as the hub', async () => {
  let params
  const tools = createTools({ getProgress: async p => {
    params = p
    return { updatedAt: 123, refreshing: true, total: 1, answer: '当时记录', coverage: { archive: { enabled: false }, sources: [{ truncated: true }] }, tasks: [{ id: 'task1', serverId: 's', project: 'p', sessionId: 'native1', engine: 'codex', status: 'reported_complete', updatedAt: 120, title: '清理', result: '磁盘90%', risks: ['仍高水位'], sourceTruncated: true }] }
  } })
  const out = await tools.project_progress({ question: '120磁盘', serverId: 's', project: 'p', days: 7 })
  assert.deepEqual(params, { q: '120磁盘', host: 's', project: 'p', days: 7 })
  assert.equal(out.tasks[0].taskId, 'task1')
  assert.equal(out.tasks[0].status, 'reported_complete')
  assert.equal(out.refreshing, true); assert.equal(out.retryAfterMs, 2500)
  assert.equal(out.coverage.truncatedSources, 1)
})

test('MCP evidence remains bounded and explicitly marks long quote excerpts', async () => {
  const tools = createTools({ getTaskEvidence: async id => ({ task: { id, serverId: 's', project: 'p', sessionId: 'n', status: 'unconfirmed', requestedAt: 1, request: '问题', progress: Array.from({ length: 6 }, (_, i) => ({ ts: i + 2, text: '中'.repeat(6000) })), actions: ['df -h'], sourceTruncated: true } }) })
  const out = await tools.task_evidence({ taskId: 't' })
  assert.equal(out.taskId, 't'); assert.equal(out.sourceTruncated, true)
  assert.equal(out.hasMore, true); assert(out.nextOffset > 0)
  assert(out.evidence.some(e => e.excerptTruncated))
  assert(Buffer.byteLength(JSON.stringify(out)) <= 8192)
})

test('progress HTTP client only performs GET, escapes IDs and propagates missing evidence', async () => {
  const urls = []
  const client = createHubClient({ baseUrl: 'http://hub', fetchImpl: async (url, init) => {
    assert(!init.method); urls.push(url)
    return { ok: false, status: 404, json: async () => ({ error: 'missing evidence' }) }
  } })
  await assert.rejects(() => client.getTaskEvidence('a/b?c'), /missing evidence/)
  assert.equal(urls[0], 'http://hub/api/assistant/evidence?id=a%2Fb%3Fc')
})
