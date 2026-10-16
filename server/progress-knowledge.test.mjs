import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createProgressAssistant } from './progress-assistant.js'
import { createProgressBackfill } from './progress-backfill.js'
import { progressEvents, tasksFromEvents, questionTerms, queryProgress, progressWindow, progressEntities } from './progress-evidence.js'
import { liveProgress } from './progress-live.js'
import { createProgressModel } from './progress-model.js'
import { archivedProgress } from './progress-archive.js'
import { createProgressRepository } from './progress-repository.js'
import { deflateSync } from 'node:zlib'

const at = Date.parse('2026-10-15T13:00:00Z')
const source = { serverId: 'node-a', project: 'ops', sessionId: 'native-a', engine: 'codex' }
const tasks = tasksFromEvents([{ type: 'user', text: '清查服务器的网络转发', ts: at - 60000 }, { type: 'assistant', text: '已修复隧道断连。根因是旧目标端口未随迁移更新。\n以后迁移需要验证应用握手，避免只看进程状态。', ts: at }], source)
const tick = () => new Promise(resolve => setImmediate(resolve))
const repo = initial => {
  const rows = new Map(initial.map(t => [t.id, t]))
  return { rows, put: async list => { for (const t of list) rows.set(t.id, t) }, find: async () => [...rows.values()], get: async id => rows.get(id), stats: async () => ({ tasks: rows.size }) }
}
const config = (dir, extra = {}) => ({ file: path.join(dir, 'recent.json'), agents: [{ id: 'node-a', transport: 'ssh-tunnel' }], now: () => at + 1000,
  getState: async () => ({ servers: [{ id: 'node-a', online: true }], sessions: [], pendingActions: [] }),
  fetchJson: async () => ({}), archiveStatus: () => ({ enabled: false }), ...extra })

test('compressed MySQL candidate projections normalize string booleans instead of marking complete evidence missing', async () => {
  const raw=JSON.stringify({id:'task',sourceTruncated:'false',requestMissing:'0',excerptTimestampUnknown:'0',detailsPartial:'true',risks:'["风险"]',actions:[],updatedAt:String(at)})
  const header=Buffer.alloc(4);header.writeUInt32LE(Buffer.byteLength(raw))
  const repository=createProgressRepository({enabled:()=>true,query:async sql=>sql.startsWith('SELECT COMPRESS')?[[{evidence_z:Buffer.concat([header,deflateSync(raw)])}]]:[[]]})
  const [t]=await repository.find({terms:['隧道']})
  assert.equal(t.sourceTruncated,false);assert.equal(t.requestMissing,false);assert.equal(t.excerptTimestampUnknown,false)
  assert.equal(t.detailsPartial,true);assert.deepEqual(t.risks,['风险']);assert.equal(t.updatedAt,at)
})

test('natural Chinese topics segment and expand without whole-sentence matching or SSH noise', () => {
  assert(questionTerms('现在有多少服务器隧道，当前的进展是什么样的').terms.includes('隧道'))
  assert(!questionTerms('今天各个项目做了什么').terms.some(t => t.includes('今天')))
  assert.equal(queryProgress(tasks, { q: '现在有多少服务器隧道，当前的进展是什么样的', now: at + 1 }).tasks.length, 1)
  const unrelated = { ...tasks[0], id: 'other', context: '清理磁盘', request: '清理磁盘', result: '已清理磁盘', causes: [], lessons: [], actions: ['ssh root@node df -h', 'cat webagents-tunnel.service'] }
  assert.equal(queryProgress([unrelated], { q: '隧道有多少', now: at + 1 }).tasks.length, 0)
  assert.equal(queryProgress(tasks, { q: '北美备用隧道如何', requiredTerms: ['北美'], now: at+1 }).total, 0)
  assert(!questionTerms('近30天磁盘问题').terms.includes('30'))
  assert.equal(progressWindow('近一个月有哪些根因',at).from,at-30*86400000)
  assert.deepEqual(progressEntities(['120磁盘','claude_manager','当前风险'],'claude_manager 120磁盘最后怎么解决的，还有当前风险',['claude_manager']),[])
  assert.deepEqual(progressEntities(['北美备用隧道'],'北美备用隧道近一周如何'),['北美'])
  const otherHost = { ...tasks[0], context: '。232的磁盘清理', request: '。232的磁盘95%，有哪些可以清理', result: '已清理。监控数据写入81.70.185.120。', actions: [], causes:[],lessons:[] }
  assert.equal(queryProgress([otherHost],{q:'120磁盘',now:at+1}).total,0)
})

test('cause and lesson excerpts preserve provenance and redact multiline private keys', () => {
  assert.match(tasks[0].causes[0], /旧目标端口/)
  assert.match(tasks[0].lessons[0], /应用握手/)
  const lines = JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '-----BEGIN PRIVATE KEY-----\nprivate-secret-line\n-----END PRIVATE KEY-----' }] } })
  assert(!JSON.stringify(progressEvents(lines, 'codex')).includes('private-secret-line'))
})

test('business tunnel questions skip assistant self-reviews and recover an older actual inventory', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const inventory={...tasks[0],id:'inventory',updatedAt:at-8*86400000,request:'现在有几个隧道？',context:'现在有几个隧道？',result:'当时核查8台服务器，运行11条SSH隧道。'}
  const meta=Array.from({length:5},(_,i)=>({...tasks[0],id:'meta'+i,request:'补齐小助理的隧道检索',context:'历史沉淀',result:'小助理验收正在补齐逐段证据，隧道问答检索需要验证。'}))
  assert.equal(queryProgress(meta,{q:'服务器隧道多少',now:at}).total,0)
  const assistant=createProgressAssistant(config(dir,{repository:repo([...meta,inventory]),model:async(stage,input)=>stage==='plan'?{intent:'tunnels',terms:['隧道','ssh']}:{sections:[{text:'当时运行11条隧道，不能当作当前总量。',sources:[input.tasks.find(t=>t.request==='现在有几个隧道？').source]}]}}))
  try {
    await assistant.refresh()
    let r
    for(let i=0;i<30;i++){r=await assistant.query({q:'现在服务器隧道有多少'});await tick();if(r.analysis.status==='done'||r.analysis.status==='error')break}
    assert.equal(r.analysis.status,'done',JSON.stringify(r.analysis));assert.equal(r.tasks[0].id,'inventory');assert.equal(r.historyExpanded,true)
    assert.equal(queryProgress([inventory],{q:'今天隧道多少',now:at,days:1}).total,0)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('central archive excerpts are immediately searchable, redacted and marked as incomplete history', () => {
  const docs = [{ host: 'old-node', project: '-data-ops', session: 'old-session', engine: 'claude', lastAt: at-30*86400000, firstPrompt: '旧运维任务', texts: ['完成迁移。', '隧道断连的根因是地址未更新，password=private-secret', '后续需要验证应用握手。'] }]
  const found = archivedProgress(docs, { terms: ['隧道'] }, p => p === '-data-ops' ? 'ops' : p)
  assert.equal(found.length, 1); assert.equal(found[0].project, 'ops')
  assert(found[0].requestMissing); assert.equal(found[0].status, 'unconfirmed')
  assert(!found[0].result.includes('private-secret')); assert.match(found[0].result, /根因/)
  assert.equal(found[0].archiveProject, '-data-ops'); assert(found[0].excerptTimestampUnknown)
})

test('a compound model keyword must not hide an existing disk answer or its numeric host', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-'))
  const disk = tasksFromEvents([{ type: 'user', ts: at-2000, text: '120数据库空间满了？' }, { type: 'user', ts: at-1000, text: '保留1个星期以内就可以' }, { type: 'assistant', ts: at, text: '已改为7天保留，当前磁盘90%，可用8.8G。' }], { ...source, project: 'claude_manager' })
  const assistant = createProgressAssistant(config(dir, { repository: repo(disk), model: async stage => stage === 'plan' ? { intent: 'risks', terms: ['磁盘空间', '清理风险'],entities:['120磁盘'] } : { sections: [{ text: '记录报告7天保留，可用8.8G，仍为90%。', sources: ['T1'] }] } }))
  try {
    await assistant.refresh()
    let result
    for (let i=0;i<20;i++) { result=await assistant.query({ q: 'claude_manager今天排查120服务器磁盘空间，最后怎么解决的，还有什么风险' }); await tick(); if(result.analysis.status==='done')break }
    assert.equal(result.analysis.status,'done'); assert.match(result.tasks[0].result,/8.8G/)
    assert.equal(queryProgress(disk,{q:'987服务器的磁盘',now:at}).total,0)
  } finally { await fs.rm(dir,{recursive:true,force:true}) }
})

test('an earlier cause survives many subsequent progress replies and remains searchable', () => {
  const events = [{ type: 'user', ts: at-2000, text: '处理生产事故' }, { type: 'assistant', ts: at-1900, text: '根因是连接池耗尽。以后需要限制并发。' }, ...Array.from({length:10},(_,i)=>({type:'assistant',ts:at-1000+i,text:'已完成第'+i+'轮验证'}))]
  const t = tasksFromEvents(events, source)
  assert.match(t[0].causes[0],/连接池/); assert.match(t[0].lessons[0],/限制并发/)
  assert.equal(queryProgress(t,{q:'连接池',now:at}).total,1)
})

test('combined incident summaries cite earlier exact measurements as well as the final result', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const history=[{...tasks[0],id:'final',request:'120磁盘清理',context:'120磁盘清理',result:'已清理，当前90%，可用8.8G。'}, {...tasks[0],id:'cause',updatedAt:at-1000,request:'120磁盘增长原因',context:'120磁盘清理',result:'最近3天binlog产生8.9GiB。\n另外发现候选：\n88张历史表尚未删除。'}, {...tasks[0],id:'unrelated',project:'another-project',updatedAt:at-2000,request:'120磁盘文档',context:'120磁盘文档',result:'记录另一个项目的2条通知。'}]
  const assistant=createProgressAssistant(config(dir,{repository:repo(history),model:async(stage,input)=>{
    if(stage==='plan')return{terms:['磁盘']}
    assert(!JSON.stringify(input.tasks).includes('88张'))
    return{sections:[{text:'清理后90%，可用8.8G，但近期binlog增长8.9GiB；以上2条为历史记录。',sources:[input.tasks.find(t=>t.taskId==='final').source]}]}
  }}))
  try {
    await assistant.refresh();let r
    for(let i=0;i<30;i++){r=await assistant.query({q:'120磁盘最后情况'});await tick();if(r.analysis.status==='done')break}
    assert.equal(r.analysis.status,'done');assert.deepEqual(r.answerSections[0].sources.map(id=>r.answerSources.find(s=>s.id===id).taskId),['final','cause'])
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('fleet counts exclude stale cache; service observations never assert a global tunnel total', () => {
  const live = liveProgress({ servers: [{ id: 'a', online: true, stale: true }, { id: 'b', online: true }], sessions: [], pendingActions: [] }, [{ id: 'a' }, { id: 'b' }], { now: at })
  assert.equal(live.serverCount, 2); assert.equal(live.onlineCount, 1)
  assert.match(live.note, /无法确认全局隧道总量/)
  assert.equal(liveProgress({ unavailable: true }, []).available, false)
  const lifecycle=liveProgress({servers:[{id:'current',online:true}]},[{id:'current'}],{retiredAgents:[{id:'srv-189-4',retiredAt:'2026-09-30'}]})
  assert.equal(lifecycle.serverCount,1);assert.deepEqual(lifecycle.retiredAgents,[{id:'srv-189-4',retiredAt:'2026-09-30',alias:'189.4'}])
})

test('current business answers exclude pre-retirement plans and retain the end of long final reports',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const rows=[{...tasks[0],id:'final-long',request:'清查隧道',context:'清查隧道',result:'处理过程。'+'细节'.repeat(1400)+'最后已经完成全部转发验证。'}, {...tasks[0],id:'obsolete',updatedAt:at-30*86400000,request:'迁移177.188隧道',context:'迁移177.188隧道',result:'旧计划仍未完成，等待切换。'}, {...tasks[0],id:'older-blocker',updatedAt:at-20*86400000,request:'隧道转发检查',context:'隧道转发检查',result:'旧阶段由于SSH限制受阻。'}]
  const assistant=createProgressAssistant(config(dir,{retiredAgents:[{id:'srv-177-188',retiredAt:'2026-09-26'}],repository:repo(rows),model:async(stage,input)=>{
    if(stage==='plan')return{intent:'tunnels',terms:['隧道']}
    assert(!input.tasks.some(t=>t.taskId==='obsolete'))
    assert(!input.tasks.some(t=>t.taskId==='older-blocker'))
    assert.match(input.tasks.find(t=>t.taskId==='final-long').result,/最后已经完成/)
    return{sections:[{text:'记录报告转发验证已完成。',sources:[input.tasks.find(t=>t.taskId==='final-long').source]}]}
  }}))
  try{
    await assistant.refresh();let r
    for(let i=0;i<30;i++){r=await assistant.query({q:'现在隧道进展如何'});await tick();if(['done','error'].includes(r.analysis.status))break}
    assert.equal(r.analysis.status,'done',JSON.stringify(r.analysis));assert.match(r.answer,/未重新验证/)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('current-state wording uses actual counters and does not turn a review into an approval',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const assistant=createProgressAssistant(config(dir,{repository:repo(tasks),getState:async()=>({servers:[{id:'node-a',online:true}],sessions:[{id:'a',serverId:'node-a',project:'ops',state:'idle'}],pendingActions:[{sessionId:'a',serverId:'node-a',kind:'review',status:'pending'}]}),model:async stage=>stage==='plan'?{intent:'fleet',terms:[]}:{sections:[{text:'全服务器共13台，有1项待审批。',sources:['LIVE']},{text:'仍有1项待审批。',sources:['LIVE']}]}}))
  try{
    await assistant.refresh();let r
    for(let i=0;i<30;i++){r=await assistant.query({q:'当前运行情况'});await tick();if(r.analysis.status==='done')break}
    assert.equal(r.analysis.status,'done');assert.equal(r.answerSections.length,1)
    assert.match(r.answer,/本次纳管范围内1台/);assert.match(r.answer,/1项待办/);assert(!r.answer.includes('待审批'));assert(!r.answer.includes('13台'))
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('model context and rendered node labels distinguish log provenance from a business target', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const target=tasksFromEvents([{type:'user',text:'120服务器隧道排查',ts:at-1000},{type:'assistant',text:'已修复120的隧道连接',ts:at}],source)
  const assistant=createProgressAssistant(config(dir,{repository:repo(target),model:async(stage,input)=>{
    if(stage==='plan')return{terms:['隧道']}
    assert.equal(input.tasks[0].serverId,undefined);assert.equal(input.tasks[0].logSourceServerId,source.serverId)
    return{sections:[{text:`120服务器（${source.serverId}）的隧道已修复。`,sources:['T1']}]}
  }}))
  try{
    await assistant.refresh();let r
    for(let i=0;i<20;i++){r=await assistant.query({q:'隧道情况'});await tick();if(r.analysis.status==='done')break}
    assert.match(r.answer,/日志来源：node-a/);assert(!r.answer.includes('120服务器（node-a）'))
    assert(r.answerSources.some(s=>s.taskId===target[0].id&&s.label.startsWith('来源 ')))
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('planning and cited synthesis are single flight across polling and use durable evidence beyond recent cache', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-'))
  let plans = 0, answers = 0, release
  const hold = new Promise(resolve => { release = resolve })
  const assistant = createProgressAssistant(config(dir, { repository: repo(tasks), model: async stage => {
    if (stage === 'plan') { plans++; await hold; return { intent: 'tunnels', terms: ['隧道'], projects: ['made-up-project'] } }
    answers++; return { sections: [{ text: '记录报告已修复断连，根因是旧端口。', sources: ['T1'] }, { text: '当前纳管1台，不能据此推算全局隧道数量。', sources: ['LIVE'] }] }
  } }))
  try {
    await assistant.refresh()
    const opts = { q: '网络通道现在怎么样了' }
    assert.equal((await assistant.query(opts)).analysis.status, 'planning')
    await assistant.query(opts); assert.equal(plans, 1)
    release()
    let result
    for (let i = 0; i < 30; i++) { await tick(); result = await assistant.query(opts); if (result.analysis.status === 'done') break }
    assert.equal(result.analysis.status, 'done')
    assert.equal(plans, 1); assert.equal(answers, 1)
    assert.match(result.answer, /旧端口/); assert.equal(result.answerSources[1].taskId, tasks[0].id)
    const restarted = createProgressAssistant(config(dir, { repository: repo(tasks) }))
    assert.equal((await restarted.evidence(tasks[0].id)).id, tasks[0].id)
    await restarted.refresh()
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('invalid model citations fail visibly and cannot replace evidence with an unsupported answer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-'))
  const assistant = createProgressAssistant(config(dir, { repository: repo(tasks), model: async stage => stage === 'plan' ? { terms: ['隧道'] } : { sections: [{ text: '所有服务器都已修好', sources: ['invented'] }] } }))
  try {
    await assistant.refresh()
    let result
    for (let i = 0; i < 20; i++) { result = await assistant.query({ q: '隧道情况' }); await tick(); if (result.analysis.status === 'error') break }
    assert.equal(result.analysis.status, 'error'); assert.match(result.analysis.error, /有效证据引用/)
    assert(!result.answer.includes('所有服务器都已修好')); assert(result.tasks.length)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('unknown named objects return a scoped evidence-absence answer, not a citation error or an invented status', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'));let answerCalls=0
  const assistant=createProgressAssistant(config(dir,{repository:repo(tasks),model:async stage=>{
    if(stage==='plan')return{intent:'tunnels',terms:['隧道'],entities:['北美备用隧道']}
    answerCalls++;return{sections:[]}
  }}))
  try{
    await assistant.refresh();let r
    for(let i=0;i<20;i++){r=await assistant.query({q:'北美备用隧道近一周状态'});await tick();if(r.analysis.status==='done')break}
    assert.equal(r.analysis.status,'done');assert.equal(answerCalls,0);assert.equal(r.tasks.length,0)
    assert.match(r.answer,/尚无法确认/);assert.deepEqual(r.answerSections[0].sources,['SEARCH'])
    assert(r.answerSources.some(s=>s.id==='SEARCH'))
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('claimed reversal of a root cause requires both literal before and after evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const assistant = createProgressAssistant(config(dir,{repository:repo(tasks),model:async stage => stage==='plan'?{terms:['隧道']}:{sections:[{text:'此前把3台服务器当成隧道总数的结论被推翻。',sources:['T1']}]}}))
  try {
    await assistant.refresh();let result
    for(let i=0;i<20;i++){result=await assistant.query({q:'隧道故障的旧结论被推翻了吗'});await tick();if(result.analysis.status==='done')break}
    assert.equal(result.analysis.status,'done');assert.match(result.answer,/尚不能确认/)
    assert(!result.answer.includes('此前把3台'))
    assert.equal(result.tasks.length,0);assert.equal(result.total,0)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('a supported root-cause correction shows both original quotes and preserves temporal ordering', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-'))
  const old='初步判断：连接异常的根因是网络波动。', changed='修正结论：不是网络问题，而是连接池耗尽。'
  const rows=tasksFromEvents([{type:'user',text:'检查网络根因',ts:at-4000},{type:'assistant',text:old,ts:at-3000},{type:'user',text:'继续核查网络根因',ts:at-2000},{type:'assistant',text:changed,ts:at}],source)
  const assistant=createProgressAssistant(config(dir,{repository:repo(rows),model:async(stage,input)=>{
    if(stage==='plan')return{terms:['网络']}
    const before=input.tasks.find(t=>t.result===old),after=input.tasks.find(t=>t.result===changed)
    return{sections:[{text:'旧网络归因被明确更正为连接池耗尽。',sources:[before.source,after.source],comparison:{before:{source:before.source,quote:old},after:{source:after.source,quote:changed}}}]}
  }}))
  try{
    await assistant.refresh();let r
    for(let i=0;i<20;i++){r=await assistant.query({q:'网络故障旧根因被后续更正了吗'});await tick();if(r.analysis.status==='done')break}
    assert.equal(r.analysis.status,'done');assert.match(r.answer,/旧结论原文/);assert(r.answer.includes(changed));assert.match(r.answer,/未重新验证业务状态/)
    assert.equal(r.live.observedAt,r.answerSources[0].observedAt)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('archive backfill resumes across chunk boundaries and restart, preserving the original instruction and later cause', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-'))
  const message = (role, text, timestamp = at) => JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: 'output_text', text }] } })
  const file = path.join(dir, 'source.jsonl'), checkpointFile = path.join(dir, 'checkpoint.json'), repository = repo([])
  const text = message('user', '检查隧道连接') + '\n' + (JSON.stringify({ type: 'ignored', padding: 'x'.repeat(900) }) + '\n').repeat(4700) + message('assistant', '已恢复。根因是旧地址，后续迁移应验证握手。') + '\n'
  await fs.writeFile(file, text)
  const options = { checkpointFile, repository, now: () => at, listSources: () => [{ key: 'source', file, ...source, lines: 4702 }] }
  try {
    const importer = createProgressBackfill(options); await importer.run()
    assert.equal(importer.status().imported, 0)
    assert.equal(repository.rows.size, 1)
    const next = createProgressBackfill(options); await next.run()
    assert.equal(next.status().imported, 1)
    const task = [...repository.rows.values()][0]
    assert.equal(task.request, '检查隧道连接'); assert.match(task.causes[0], /旧地址/)
    await next.run(); assert.equal(repository.rows.size, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('failed durable writes do not advance archive checkpoints; retry recovers without losing history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-')), file = path.join(dir, 'source.jsonl')
  await fs.writeFile(file, JSON.stringify({ timestamp: at, type: 'user', message: { role: 'user', content: '排查旧问题' } }) + '\n')
  let fail = true
  const store = repo([]), options = { checkpointFile: path.join(dir, 'checkpoint.json'), listSources: () => [{ key: 'source', file, ...source, engine: 'claude', lines: 1 }], repository: { put: async rows => { if (fail) throw Error('db unavailable'); await store.put(rows) } } }
  try {
    const importer = createProgressBackfill(options); await importer.run()
    assert.match(importer.status().error, /检查点未推进/)
    fail = false; await importer.run()
    assert.equal(importer.status().imported, 1); assert.equal(store.rows.size, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('native full-history capture continues an existing task when new replies arrive after EOF', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-')), store = repo([])
  const row = (role,text,timestamp) => JSON.stringify({type:'response_item',timestamp,payload:{type:'message',role,content:[{type:'output_text',text}]}})+'\n'
  let text = row('user','排查连接失败',at-1000)+row('assistant','正在检查',at)
  const options = { checkpointFile:path.join(dir,'checkpoint.json'),repository:store,listSources:async()=>[{key:'native',...source,size:Buffer.byteLength(text),lines:Buffer.byteLength(text)}],readSource:async(s,from,len)=>Buffer.from(text).subarray(from,from+len).toString('utf8') }
  try {
    await createProgressBackfill(options).run()
    assert.equal(store.rows.size,1)
    text += row('assistant','已恢复，根因是端口错误。以后需要验证握手。',at+1000)
    const resumed=createProgressBackfill(options);await resumed.run()
    assert.equal(resumed.status().imported,1);assert.equal(store.rows.size,1)
    const task=[...store.rows.values()][0]
    assert.equal(task.request,'排查连接失败');assert.match(task.causes[0],/端口错误/);assert.equal(task.sourceKind,'native_history')
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('an oversized UTF-8 row does not stall later dialogue or attach it to the wrong instruction', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-')),store=repo([])
  const row=(role,text,timestamp)=>JSON.stringify({type:'response_item',timestamp,payload:{type:'message',role,content:[{type:'output_text',text}]}})+'\n'
  const text=row('user','之前的交办',at-3000)+JSON.stringify({padding:'汉字'.repeat(800000)})+'\n'+row('assistant','这条回复的交办没有完整覆盖',at-2000)+row('user','新的交办',at-1000)+row('assistant','已完成新任务',at)
  const opts={checkpointFile:path.join(dir,'checkpoint.json'),repository:store,now:()=>at,listSources:()=>[{key:'native',...source,size:Buffer.byteLength(text),lines:Buffer.byteLength(text)}],readSource:async(s,from,len)=>Buffer.from(text).subarray(from,from+len).toString('utf8')}
  try{
    const importer=createProgressBackfill(opts)
    for(let i=0;i<5;i++)await importer.run()
    const status=importer.status();assert.equal(status.failed,0);assert.equal(status.caughtUp,1);assert.equal(status.imported,0);assert.equal(status.limitedSources,1)
    assert.match(status.limitWarning,/超大单行/)
    const rows=[...store.rows.values()]
    assert.equal(rows.find(t=>t.request==='之前的交办').result,'')
    assert(rows.some(t=>t.requestMissing&&t.result.includes('没有完整覆盖')))
    assert.equal(rows.find(t=>t.request==='新的交办').result,'已完成新任务')
    const cp=JSON.parse(await fs.readFile(opts.checkpointFile,'utf8'));assert.equal(cp.native.offset,Buffer.byteLength(text))
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('database outage leaves complete replayable evidence on disk and recovery drains it without losing task identity', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-knowledge-')),store=repo([])
  let offline=true
  const repository={...store,put:async rows=>{if(offline)throw Error('offline');await store.put(rows)}}
  const line=(role,text)=>JSON.stringify({type:'response_item',timestamp:at,payload:{type:'message',role,content:[{type:'output_text',text}]}})
  const text=line('user','处理连接故障')+'\n'+line('assistant','已恢复。根因是旧端口。')
  const assistant=createProgressAssistant(config(dir,{repository,getState:async()=>({sessions:[{...source,id:source.sessionId,cwd:'/home/runner/workspaces/ops',lastActiveAt:at}]}),fetchJson:async url=>url.includes('/inventory')?{files:[{engine:'codex',path:'/sessions/'+source.sessionId+'.jsonl',st:{size:Buffer.byteLength(text),mtimeMs:at}}]}:{text}}))
  try{
    await assistant.refresh()
    const pending=await fs.readdir(path.join(dir,'recent.json.pending'));assert.equal(pending.length,1)
    const [saved]=JSON.parse(await fs.readFile(path.join(dir,'recent.json.pending',pending[0]),'utf8'));assert.match(saved.result,/旧端口/)
    offline=false;await assistant.refresh()
    assert.equal((await fs.readdir(path.join(dir,'recent.json.pending'))).length,0)
    assert.equal(store.rows.size,1);assert.equal((await assistant.evidence(saved.id)).id,saved.id)
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})

test('model transport never includes credentials in errors and rejects malformed model output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-knowledge-')), file = path.join(dir, 'model.json')
  await fs.writeFile(file, JSON.stringify({ baseUrl: 'http://fixed/v1', apiKey: 'private-key', model: 'kimi-fast' }))
  try {
    const call = createProgressModel({ configFile: file, fetchImpl: async (url, options) => { assert.equal(url, 'http://fixed/v1/chat/completions'); assert(!options.body.includes('private-key')); return { ok: false, status: 503 } } })
    await assert.rejects(() => call('plan', { question: '情况如何' }), e => !e.message.includes('private-key') && e.message.includes('503'))
    const bad = createProgressModel({ configFile: file, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }) })
    await assert.rejects(() => bad('answer', {}), /有效结果/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


test('completed model usage and warnings survive synthesis errors and cached question polling', async () => {
  for (const malformed of [false, true]) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-telemetry-')),file=path.join(dir,'model.json')
    await fs.writeFile(file,JSON.stringify({baseUrl:'https://gateway.example/v1',apiKey:'private-fixture',model:'auto'}))
    let calls=0
    const model=createProgressModel({configFile:file,fetchImpl:async()=>{
      const stage=calls++===0?'plan':'answer'
      const content=stage==='plan'?JSON.stringify({intent:'history',terms:['隧道']}):malformed?'bad json':JSON.stringify({sections:[{text:'当时记录报告已修复隧道断连。',sources:['T1']}]})
      return{ok:true,json:async()=>({model:'auto',metadata:{resolved_model:stage+'-actual',warnings:[{parameter:'max_tokens',policy:'IGNORED_WITH_WARNING',detail:'max_tokens was ignored'}]},usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25},choices:[{message:{content}}]})}
    }})
    const assistant=createProgressAssistant(config(dir,{repository:repo(tasks),model}))
    try {
      await assistant.refresh();let result
      for(let i=0;i<60;i++){result=await assistant.query({q:'隧道修复情况',questionId:'same-question'});if(['done','error'].includes(result.analysis.status))break;await new Promise(r=>setTimeout(r,2))}
      assert.equal(result.analysis.status,malformed?'error':'done')
      assert.equal(result.analysis.modelCalls.length,2);assert.equal(result.analysis.modelCalls[1].actualModel,'answer-actual')
      assert.equal(result.analysis.modelCalls[1].usage.totalTokens,25);assert.equal(result.analysis.modelCalls[0].warnings[0].policy,'IGNORED_WITH_WARNING')
      assert(result.tasks.length>0)
      const again=await assistant.query({q:'隧道修复情况',questionId:'same-question'})
      assert.equal(calls,2);assert.deepEqual(again.analysis.modelCalls,result.analysis.modelCalls)
    }finally{await fs.rm(dir,{recursive:true,force:true})}
  }
})
