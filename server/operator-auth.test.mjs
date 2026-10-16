import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {createOperatorAuth,nodeAuthorized} from './operator-auth.js'

test('setup, hashed persistent sessions, origin rejection, read-only MCP, password and logout boundaries',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-auth-'))
  let auth=createOperatorAuth({enabled:true,dir}),requests=0
  const server=http.createServer(async(req,res)=>{if(await auth.handle(req,res))return;const a=auth.authorize(req);res.writeHead(a.ok?200:a.status);res.end(JSON.stringify(a.ok?{ok:true,requests:++requests}:{error:a.error}))})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
  const post=(route,body={},headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  try{
    assert.equal((await fetch(base+'/api/state')).status,401)
    assert.equal((await post('/api/auth/setup',{setupToken:'bad'})).status,403)
    const setupToken=fs.readFileSync(auth.setupFile,'utf8').trim(),password='strong-demo-password'
    assert.equal((await post('/api/auth/setup',{setupToken,user:'admin',password})).status,201)
    assert(!fs.existsSync(auth.setupFile));assert(!fs.readFileSync(path.join(dir,'auth.json'),'utf8').includes(password))
    const login=await post('/api/auth/login',{user:'admin',password}),cookie=login.headers.get('set-cookie').split(';')[0]
    assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/)
    auth=createOperatorAuth({enabled:true,dir})
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200)
    assert.equal((await post('/api/session',{},{cookie,Origin:'https://evil.example'})).status,403)
    const readToken=fs.readFileSync(auth.mcpFile,'utf8').trim(),headers={Authorization:`Bearer ${readToken}`}
    assert.equal((await fetch(base+'/api/state',{headers})).status,200)
    assert.equal((await fetch(base+'/api/term/ws',{headers})).status,403)
    assert.equal((await post('/api/session',{},headers)).status,403)
    assert.equal((await post('/api/auth/password',{oldPassword:password,password:'new-strong-password'},{cookie})).status,200)
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,401)
    const next=await post('/api/auth/login',{user:'admin',password:'new-strong-password'}),newCookie=next.headers.get('set-cookie').split(';')[0]
    assert.equal((await post('/api/auth/logout',{},{cookie:newCookie})).status,200)
    assert.equal((await fetch(base+'/api/state',{headers:{cookie:newCookie}})).status,401)
    assert(!JSON.stringify(await(await fetch(base+'/api/auth/status')).json()).includes(readToken))
  }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
test('Agent tokens are checked without changing explicit loopback compatibility',()=>{
  assert(nodeAuthorized({headers:{}},''));assert(!nodeAuthorized({headers:{}},'node-secret'))
  assert(nodeAuthorized({headers:{authorization:'Bearer node-secret'}},'node-secret'))
})
