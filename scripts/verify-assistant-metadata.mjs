// Run only against the disposable Compose installation created by container-smoke.mjs.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
const base=process.argv[2],credentialsFile=process.argv[3]
if(!base||!credentialsFile?.endsWith('.smoke-admin.json'))throw new Error('Provide the isolated smoke installation and its generated admin file')
const compose=['compose','--env-file','.compose.env'],docker=args=>execFileSync('docker',[...compose,...args],{stdio:'pipe'})
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:fs.readFileSync(credentialsFile,'utf8')})
assert.equal(login.status,200)
const cookie=login.headers.get('set-cookie').split(';')[0]
const call=(route,body)=>fetch(base+route,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
const original=await(await call('/api/installation')).json()
assert.equal(original.assistant.hasKey,false,'Refusing to replace an existing model account')
const gateway=`import http from 'node:http';const server=http.createServer(async(req,res)=>{if(req.url==='/ready'){res.end('ok');return}if(req.url==='/close'){res.end('ok');server.close();return}let text='';for await(const c of req)text+=c;const input=JSON.parse(JSON.parse(text).messages[1].content);const plan='projects' in input;const content=JSON.stringify(plan?{intent:'fleet',terms:[]}:{sections:[{text:'当前状态见本次只读观测。',sources:['LIVE']}]});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'auto',metadata:{resolved_model:'fixture-actual-model',resolved_provider:'fixture-provider',request_id:plan?'fixture-plan':'fixture-answer',warnings:[{parameter:'max_tokens',policy:'IGNORED_WITH_WARNING',detail:'max_tokens ignored; fixture-private-key'}]},usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150},choices:[{message:{content}}]}))});server.listen(18799,'127.0.0.1');setTimeout(()=>server.close(),120000).unref()`
let started=false
try{
 docker(['exec','-d','-T','console','node','--input-type=module','-e',gateway]);started=true
 for(let i=0;i<20;i++){
  try{docker(['exec','-T','console','node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:18799/ready');if(!r.ok)process.exit(1)"]);break}catch(error){if(i===19)throw error;await new Promise(r=>setTimeout(r,250))}
 }
 assert.equal((await call('/api/installation',{assistant:{baseUrl:'http://127.0.0.1:18799/v1',apiKey:'fixture-private-key',model:'auto'}})).status,200)
 const params=new URLSearchParams({q:'当前纳管服务器有几台',questionId:crypto.randomUUID()})
 let result
 for(let i=0;i<60;i++){
  result=await(await call('/api/assistant/progress?'+params)).json()
  if(['done','error'].includes(result.analysis?.status))break
  await new Promise(r=>setTimeout(r,500))
 }
 assert.equal(result.analysis.status,'done',result.analysis.error)
 assert.equal(result.analysis.modelCalls.length,2)
 for(const modelCall of result.analysis.modelCalls){
  assert.equal(modelCall.actualModel,'fixture-actual-model');assert.equal(modelCall.usage.totalTokens,150)
  assert.equal(modelCall.warnings[0].parameter,'max_tokens');assert.equal(modelCall.warnings[0].policy,'IGNORED_WITH_WARNING')
 }
 assert(!JSON.stringify(result.analysis).includes('fixture-private-key'))
 const repeated=await(await call('/api/assistant/progress?'+params)).json()
 assert.deepEqual(repeated.analysis.modelCalls,result.analysis.modelCalls)
 console.log('PASS: actual container model adapter preserves plan/answer usage, resolved model, compatibility warnings and polling identity without leaking credentials')
}finally{
 await call('/api/installation',{assistant:{...original.assistant,clearKey:true}}).catch(()=>{})
 if(started)try{docker(['exec','-T','console','node','--input-type=module','-e',"await fetch('http://127.0.0.1:18799/close')"])}catch{}
 await call('/api/auth/logout',{}).catch(()=>{})
}
