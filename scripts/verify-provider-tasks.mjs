// Explicit, billable acceptance against the operator's own logged-in CLIs.
// Never run in ordinary CI. HOME/CODEX_HOME must be an isolated test home.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
const engine=process.argv[2],cwd=path.resolve(process.argv[3]||'')
if(process.env.WA_PROVIDER_ACCEPTANCE!=='1'||!['codex','kimi'].includes(engine)||!process.argv[3])throw new Error('Explicit acceptance only: WA_PROVIDER_ACCEPTANCE=1 HOME=<isolated-home> node scripts/verify-provider-tasks.mjs codex|kimi <isolated-workspace>')
if(!fs.existsSync(path.join(os.homedir(),'.wa-acceptance-home')))throw new Error('Refusing to use a non-acceptance HOME')
fs.mkdirSync(cwd,{recursive:true})
if(fs.readdirSync(cwd).length)throw new Error('Use a new, empty acceptance workspace')
const driver=await import(`../server/${engine}-driver.js`),checks=[],ids=new Set()
let id
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const record=()=>driver.listSessions().find(s=>s.id===id)
async function waitFor(predicate,label,timeout=150_000){
 const started=Date.now()
 while(Date.now()-started<timeout){
  const s=record()
  if(s?.error||s?.state==='error')throw new Error(`${label}: ${s.error||s.state}`)
  if(s?.state==='waiting_approval')throw new Error(`${label}: unexpected manual approval in automatic mode`)
  if(await predicate(s))return
  await pause(150)
 }
 throw new Error('Timed out: '+label)
}
const mark=name=>{checks.push(name);console.log(JSON.stringify({engine,check:name,passed:true}))}
const exists=name=>fs.existsSync(path.join(cwd,name))
const hard=setTimeout(()=>{console.error('Acceptance hard timeout');process.exit(2)},420_000)
try{
 const first=await driver.createSession({cwd,model:engine==='codex'?'gpt-6.1-sol':undefined,effort:engine==='codex'?'low':undefined,mode:'auto',prompt:'This is a bounded software acceptance test. Work only in this directory. Run a shell command that waits 12 seconds, then write the exact text INITIAL_OK into initial.txt. Do not ask questions or access any external files. Report completion in one sentence.'})
 id=first.id;ids.add(id)
 if(engine==='codex'){
  await waitFor(s=>s?.inflight,'initial turn active',30_000)
  const steer=await driver.submitMessage(id,'Additional information for this same task: also write the exact text STEER_OK into steered.txt.',[],{behavior:'steer'})
  assert.equal(steer.ok,true);assert.equal(steer.delivery,'steered');mark('immediate-steer-acknowledged')
  const queued=await driver.submitMessage(id,'This is a separate queued task. Write the exact text QUEUE_OK into queued.txt. Do not change initial.txt or steered.txt.',[],{behavior:'queue'})
  assert.equal(queued.ok,true);assert(queued.queued||queued.delivery==='queued');mark('separate-task-queued')
  await waitFor(s=>exists('initial.txt')&&exists('steered.txt')&&exists('queued.txt')&&!s?.inflight&&!s?.queuedMessages,'edit, steer and queue complete')
  for(const [name,value] of [['initial.txt','INITIAL_OK'],['steered.txt','STEER_OK'],['queued.txt','QUEUE_OK']])assert.equal(fs.readFileSync(path.join(cwd,name),'utf8').trim(),value)
  mark('edits-and-queued-task-verified')
 }else{
  await waitFor(s=>exists('initial.txt')&&!s?.inflight,'initial edit complete')
  assert.equal(fs.readFileSync(path.join(cwd,'initial.txt'),'utf8').trim(),'INITIAL_OK');mark('authenticated-command-and-edit')
 }
 // Same valid PNG in both engines; assert real model recognition, not just serialization.
 const image={media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC'}
 const imageText='Inspect the attached image. Write IMAGE_OK into image.txt only if you can actually see a red square in the attachment. If no attachment is available, write IMAGE_MISSING instead. Work only in this directory.'
 if(engine==='codex')assert.equal((await driver.submitMessage(id,imageText,[image])).ok,true)
 else assert.equal(await driver.sendMessage(id,imageText,[image]),true)
 await waitFor(s=>exists('image.txt')&&!s?.inflight,'image input complete')
 assert.equal(fs.readFileSync(path.join(cwd,'image.txt'),'utf8').trim(),'IMAGE_OK');mark('image-input-recognized')
 const long='Run a shell command that sleeps 45 seconds, then write LATE into interrupted.txt. This is an interruption test. Do not do anything else.'
 if(engine==='codex')assert.equal((await driver.submitMessage(id,long,[])).ok,true)
 else assert.equal(await driver.sendMessage(id,long,[]),true)
 await waitFor(s=>s?.inflight,'interruptible turn started',30_000)
 await pause(1500);assert.equal(await driver.interrupt(id),true)
 await waitFor(s=>!s?.inflight,'turn interrupted',30_000)
 assert.equal(exists('interrupted.txt'),false);mark('active-turn-interrupted')
 const previous=id
 await driver.release(id);ids.delete(id)
 const resumed=await driver.createSession({cwd,resume:previous,mode:'auto',effort:engine==='codex'?'low':undefined})
 id=resumed.id;ids.add(id)
 const text='The interrupted sleep task is cancelled. Verify initial.txt contains INITIAL_OK, then write RESUME_OK into resumed.txt. Do not run the old task again.'
 if(engine==='codex')assert.equal((await driver.submitMessage(id,text,[])).ok,true)
 else assert.equal(await driver.sendMessage(id,text,[]),true)
 await waitFor(s=>exists('resumed.txt')&&!s?.inflight,'resumed conversation complete')
 assert.equal(fs.readFileSync(path.join(cwd,'resumed.txt'),'utf8').trim(),'RESUME_OK');mark('release-resume-and-continued-task')
 console.log(JSON.stringify({engine,passed:true,checks}))
}catch(error){console.error(JSON.stringify({engine,passed:false,checks,error:String(error.message)}));process.exitCode=1}
finally{for(const active of ids)await driver.release(active).catch(()=>{});clearTimeout(hard);process.exit(process.exitCode||0)}
