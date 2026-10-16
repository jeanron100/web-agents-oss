import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function run(scenario, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codex-send-'))
  try {
    const bin = path.join(dir, 'codex'), log = path.join(dir, 'rpc.jsonl')
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let count=0, active=null;
const scenario=process.env.WA_TEST_SCENARIO;
const say=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\\n');
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
const reject=(id,code,message)=>process.stdout.write(JSON.stringify({id,error:{code,message}})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(process.env.WA_TEST_RPC_LOG,line+'\\n');
 if(m.id==null||!m.method)return;
 const tid=m.params?.threadId||'test-thread';
 if(m.method==='thread/start'||m.method==='thread/resume')return reply(m.id,{thread:{id:tid}});
 if(m.method==='model/list')return reply(m.id,{data:[]});
 if(m.method==='thread/read'){
   const result={thread:{status:{type:active?'active':'idle'},turns:active?[{id:active,status:'inProgress'}]:[]}};
   return scenario==='read-cancel'?setTimeout(()=>reply(m.id,result),80):reply(m.id,result);
 }
 if(m.method==='turn/start'){
   const id='turn-'+(++count);active=id;reply(m.id,{turn:{id}});
   if(scenario==='stream'||scenario==='stream-final')say('item/agentMessage/delta',{threadId:tid,itemId:'stream-item',delta:'before'});
   setTimeout(()=>{if(active!==id)return;active=null;say('turn/completed',{threadId:tid,turn:{id,status:'completed'}})},400);return;
 }
 if(m.method==='turn/steer'){
   if(scenario==='stream'||scenario==='stream-final'){
     reply(m.id,{turnId:active});
     if(scenario==='stream')say('item/agentMessage/delta',{threadId:tid,itemId:'stream-item',delta:' after'});
     say('item/completed',{threadId:tid,item:{type:'agentMessage',id:'stream-item',text:'before after'}});
     say('item/completed',{threadId:tid,item:{type:'agentMessage',id:'stream-item',text:'before after'}});return;
   }
   if(scenario==='lost')return process.exit(0);
   if(scenario==='reject')return reject(m.id,-32602,'invalid input');
   if(scenario==='unsupported')return reject(m.id,-32601,'Method not found');
   if(scenario==='race'||scenario==='cancel'||scenario==='read-cancel'){
     const old=active;active=null;
     if(scenario!=='cancel')say('turn/completed',{threadId:tid,turn:{id:old,status:'completed'}});
     return setTimeout(()=>reject(m.id,-32000,'No active turn to steer'),scenario==='cancel'?80:0);
   }
   return reply(m.id,{turnId:active});
 }
 if(m.method==='turn/interrupt'){active=null;say('turn/completed',{threadId:tid,turn:{id:m.params.turnId,status:'interrupted'}})}
 reply(m.id,{});
});
`, { mode: 0o700 })
    const source = `import assert from 'node:assert/strict'; import fs from 'node:fs';
import * as driver from ${JSON.stringify(new URL('./codex-driver.js', import.meta.url).href)};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const record=await driver.createSession({cwd:${JSON.stringify(dir)},prompt:'first'});
try { ${script}; process.exit(0) } catch(e) {console.error(e);process.exit(1)}
`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, CODEX_BIN: bin, WA_WORKER_SLICE: '0', WA_TEST_RPC_LOG: log, WA_TEST_SCENARIO: scenario },
      timeout: 8000, encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr + '\nRPC: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No RPC log'))
    return fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('default concurrent supplements steer the existing turn in order; explicit task queues and starts once', () => {
  const calls = run('normal', `
    const receipts=await Promise.all([driver.submitMessage(record.id,'supplement-1'),driver.submitMessage(record.id,'supplement-2'),driver.submitMessage(record.id,'task',[],{behavior:'queue'})]);
    assert.deepEqual(receipts.map(r=>r.delivery),['steered','steered','queued']);
    assert.equal(record.queuedInputs.length,1);
    const queuedSeq=driver.getEvents(record.id).events.find(e=>e.text==='task').seq;
    await pause(550);
    assert.equal(record.queuedInputs.length,0);
    const events=driver.getEvents(record.id).events;
    assert.equal(events.find(e=>e.text==='task').delivery,'accepted');
    assert.equal(events.find(e=>e.text==='task').seq,queuedSeq);
    assert.equal(driver.getEvents(record.id).messageReceipts[events.find(e=>e.text==='task').id].delivery,'accepted');
    assert.equal(events.filter(e=>e.text==='supplement-1').length,1);
  `)
  assert.deepEqual(calls.filter(c=>c.method==='turn/steer').map(c=>c.params.input[0].text), ['supplement-1', 'supplement-2'])
  assert(calls.filter(c=>c.method==='turn/steer').every(c=>c.params.expectedTurnId==='turn-1' && !('approvalPolicy' in c.params)))
  assert.equal(calls.filter(c=>c.method==='turn/start').length,2)
})
test('idle input starts normally; steering supports images and does not bypass an active approval', () => {
  const calls = run('normal', `
    record.pending.set('approval',{action:{kind:'approval',status:'pending'}});
    const r=await driver.submitMessage(record.id,'image', [{media_type:'image/png',data:'AAA'}]);
    assert.equal(r.delivery,'steered'); assert.equal(record.pending.size,1);
    record.pending.clear(); await pause(450);
    assert.equal((await driver.submitMessage(record.id,'idle')).delivery,'accepted');
  `)
  assert.equal(calls.find(c=>c.method==='turn/steer').params.input[0].url,'data:image/png;base64,AAA')
  assert.equal(calls.filter(c=>c.method==='turn/start').length,2)
})
test('completion race rejects steering then sends the input once as a follow-up', () => {
  const calls=run('race', `
    const r=await driver.submitMessage(record.id,'boundary');
    assert.equal(r.ok,true);assert.equal(r.delivery,'queued');
    await pause(50);assert.equal(record.queuedInputs.length,0);
  `)
  assert.equal(calls.filter(c=>c.method==='turn/steer').length,1)
  assert.equal(calls.filter(c=>c.method==='turn/start'&&c.params.input.some(i=>i.text==='boundary')).length,1)
})
test('old app-server falls back to a truthful queued receipt; malformed requests are not retried', () => {
  const old=run('unsupported', `
    const r=await driver.submitMessage(record.id,'old');assert.equal(r.delivery,'queued');assert.match(r.reason,/不支持/);
    await pause(550);
  `)
  assert.equal(old.filter(c=>c.method==='turn/start').length,2)
  const rejected=run('reject', `
    const r=await driver.submitMessage(record.id,'bad');assert.equal(r.ok,false);assert.equal(r.indeterminate,false);
    assert.equal(driver.getEvents(record.id).events.find(e=>e.text==='bad').delivery,'failed');
    assert.equal(record.queuedInputs.length,0);
  `)
  assert.equal(rejected.filter(c=>c.method==='turn/start').length,1)
})
test('lost native acknowledgement remains unknown and is never replayed automatically', () => {
  const calls=run('lost', `
    const r=await driver.submitMessage(record.id,'lost');assert.equal(r.ok,false);assert.equal(r.indeterminate,true);
    assert.equal(driver.getEvents(record.id).events.find(e=>e.text==='lost').delivery,'unknown');
    assert.equal(record.queuedInputs.length,0);
  `)
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1)
  assert.equal(calls.filter(c=>c.method==='turn/steer').length,1)
})
test('steering while assistant text streams preserves chunks without repeating the whole completed answer', () => {
  for (const scenario of ['stream', 'stream-final']) run(scenario, `
    assert.equal((await driver.submitMessage(record.id,'supplement')).delivery,'steered');
    const events=driver.getEvents(record.id).events;
    assert.deepEqual(events.filter(e=>e.type==='assistant').map(e=>e.text),['before',' after']);
    assert.deepEqual(events.map(e=>e.type),['user','assistant','user','assistant']);
  `)
})

test('interrupt cancels queued tasks and pending submissions instead of starting a surprise follow-up', () => {
  for (const scenario of ['cancel', 'read-cancel']) {
  const calls=run(scenario, `
    await driver.submitMessage(record.id,'task',[],{behavior:'queue'});
    const steering=driver.submitMessage(record.id,'during-interrupt');
    await pause(20);await driver.interrupt(record.id);
    assert.equal((await steering).ok,false);
    await pause(120);assert.equal(record.queuedInputs.length,0);
    assert.equal(driver.getEvents(record.id).events.find(e=>e.text==='task').delivery,'cancelled');
  `)
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1)
  }
})
