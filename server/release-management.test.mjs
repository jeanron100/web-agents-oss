import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createConfigStore} from './runtime-config.js'
import {createServerManagement} from './server-management.js'
import {createInstallationSettings} from './installation-settings.js'
import {serveWeb} from './static-web.js'
const send=(r,c,b)=>{r.writeHead(c,{'Content-Type':'application/json'});r.end(JSON.stringify(b))}
test('node lifecycle persists, preserves blank token and live-updates; optional keys never echo',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-manage-')),file=path.join(dir,'config.json'),store=createConfigStore(file),updates=[]
 const nodeApi=createServerManagement({store,onChange:c=>updates.push(c),send,probe:async n=>({connected:!!n.token})})
 const settings=createInstallationSettings({store,onChange:c=>updates.push(c),send,modelFile:path.join(dir,'model.json'),notifications:()=>({hasWebhook:false}),updateNotifications:()=>{}})
 const server=http.createServer(async(q,r)=>{const u=new URL(q.url,'http://x');if(await nodeApi(q,r,u)||await settings(q,r,u))return;r.writeHead(404);r.end()})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
 const call=(url,method='GET',body)=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
 try{
  const token='a'.repeat(40)
  assert.equal((await call('/api/servers','POST',{id:'n1',url:'http://runner:8788',token})).status,201)
  assert.equal((await call('/api/servers','POST',{id:'n1',url:'http://runner:8788'})).status,409)
  assert.equal((await call('/api/servers/n1','PATCH',{enabled:false,token:''})).status,200)
  assert.equal(createConfigStore(file).get().agents[0].token,token)
  assert.equal((await(await call('/api/servers/test','POST',{id:'n1',url:'http://runner:8788'})).json()).connected,true)
  assert(!(await(await call('/api/servers')).text()).includes(token))
  const model={baseUrl:'https://model.example/v1',model:'test',apiKey:'model-secret'}
  let r=await call('/api/installation','POST',{assistant:model});assert.equal(r.status,200);assert(!(await r.text()).includes('model-secret'))
  assert.equal((await call('/api/installation','POST',{assistant:{...model,apiKey:''}})).status,200)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'model.json'),'utf8')).apiKey,'model-secret')
  assert.equal((await call('/api/installation','POST',{monitorUrl:'https://user:password@example.com'})).status,400)
  assert.equal((await call('/api/installation','POST',{preferredSources:{kimi:'missing'}})).status,400)
  assert.equal((await call('/api/servers/n1','DELETE')).status,200)
  assert.equal(createConfigStore(file).get().agents.length,0);assert.equal(store.get().retiredAgents[0].id,'n1');assert(updates.length>=4)
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
test('SPA assets do not traverse paths or follow symlinks outside the web root',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-static-')),web=path.join(dir,'web');fs.mkdirSync(web);fs.writeFileSync(path.join(web,'index.html'),'app');fs.writeFileSync(path.join(dir,'secret'),'private');fs.symlinkSync(path.join(dir,'secret'),path.join(web,'leak.txt'))
 const server=http.createServer((q,r)=>{if(!serveWeb(q,r,web)){r.writeHead(404);r.end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
 try{assert.equal(await(await fetch(base+'/session/demo')).text(),'app');assert.equal((await fetch(base+'/missing.js')).status,404);assert.equal((await fetch(base+'/leak.txt')).status,404);assert.equal((await fetch(base+'/%2e%2e%2fsecret')).status,404)}finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
