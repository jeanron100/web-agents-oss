import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {createOperatorAuth,nodeAuthorized,resetOperatorPassword} from './operator-auth.js'

test('setup, hashed persistent sessions, origin rejection, read-only MCP, password and logout boundaries',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-auth-'))
  let auth=createOperatorAuth({enabled:true,dir}),requests=0
  const server=http.createServer(async(req,res)=>{if(await auth.handle(req,res))return;const a=auth.authorize(req);res.writeHead(a.ok?200:a.status);res.end(JSON.stringify(a.ok?{ok:true,requests:++requests}:{error:a.error}))})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
  const post=(route,body={},headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  try{
    assert.equal((await fetch(base+'/api/state')).status,401)
    assert.equal((await post('/api/auth/setup',{setupToken:'bad'})).status,403)
    const setupToken=fs.readFileSync(auth.setupFile,'utf8').trim(),password='12345678'
    assert.equal((await post('/api/auth/setup',{setupToken,user:'admin',password:'1234567'})).status,400)
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
    assert.equal((await post('/api/auth/password',{oldPassword:password,password:'1234567'},{cookie})).status,400)
    assert.equal((await post('/api/auth/password',{oldPassword:password,password:'87654321'},{cookie})).status,200)
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,401)
    const next=await post('/api/auth/login',{user:'admin',password:'87654321'}),newCookie=next.headers.get('set-cookie').split(';')[0]
    assert.equal((await post('/api/auth/logout',{},{cookie:newCookie})).status,200)
    assert.equal((await fetch(base+'/api/state',{headers:{cookie:newCookie}})).status,401)
    assert(!JSON.stringify(await(await fetch(base+'/api/auth/status')).json()).includes(readToken))
  }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
test('Agent tokens are checked without changing explicit loopback compatibility',()=>{
  assert(nodeAuthorized({headers:{}},''));assert(!nodeAuthorized({headers:{}},'node-secret'))
  assert(nodeAuthorized({headers:{authorization:'Bearer node-secret'}},'node-secret'))
})

test('initial account is restricted across restart until changed; existing credentials survive bootstrap settings',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-initial-auth-'))
  let clock=Date.now(),auth=createOperatorAuth({enabled:true,initialAccount:true,dir,now:()=>clock})
  const server=http.createServer(async(req,res)=>{if(await auth.handle(req,res))return;const a=auth.authorize(req);res.writeHead(a.ok?200:a.status);res.end(JSON.stringify(a.ok?{ok:true}:{error:a.error}))})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
  const post=(route,body={},cookie='')=>{clock+=61000;return fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body)})}
  try{
    assert(!fs.existsSync(auth.setupFile));assert(!fs.readFileSync(path.join(dir,'auth.json'),'utf8').includes('admin123'))
    assert.equal((await(await fetch(base+'/api/auth/status')).json()).initialAccount,true)
    const login=await post('/api/auth/login',{user:'admin',password:'admin123'}),cookie=login.headers.get('set-cookie').split(';')[0]
    assert.equal(login.status,200);assert.equal((await login.json()).passwordChangeRequired,true)
    auth=createOperatorAuth({enabled:true,initialAccount:false,dir,now:()=>clock})
    const status=await(await fetch(base+'/api/auth/status',{headers:{cookie}})).json()
    assert.equal(status.authenticated,true);assert.equal(status.passwordChangeRequired,true)
    for(const route of ['/api/state','/api/session','/api/term/ws','/api/installation'])assert.equal((await fetch(base+route,{headers:{cookie}})).status,403)
    assert.equal((await post('/api/session',{},cookie)).status,403)
    assert.equal((await post('/api/auth/password',{oldPassword:'wrong',password:'12345678'},cookie)).status,403)
    const unchanged=await post('/api/auth/password',{oldPassword:'admin123',password:'admin123'},cookie)
    assert.equal(unchanged.status,400);assert.equal((await unchanged.json()).error,'新密码不能与临时密码相同')
    assert.equal((await post('/api/auth/password',{oldPassword:'admin123',password:'x'.repeat(257)},cookie)).status,400)
    assert.equal((await post('/api/auth/password',{oldPassword:'admin123',password:'12345678'},cookie)).status,200)
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,401)
    auth=createOperatorAuth({enabled:true,initialAccount:true,dir,now:()=>clock})
    assert.equal((await post('/api/auth/login',{user:'admin',password:'admin123'})).status,401)
    const next=await post('/api/auth/login',{user:'admin',password:'12345678'}),nextCookie=next.headers.get('set-cookie').split(';')[0]
    assert.equal(next.status,200);assert.equal((await next.json()).passwordChangeRequired,false)
    assert.equal((await fetch(base+'/api/state',{headers:{cookie:nextCookie}})).status,200)
    assert.equal(resetOperatorPassword(dir),'admin')
    auth=createOperatorAuth({enabled:true,initialAccount:true,dir,now:()=>clock})
    assert.equal((await fetch(base+'/api/state',{headers:{cookie:nextCookie}})).status,401)
    assert.equal((await post('/api/auth/login',{user:'admin',password:'12345678'})).status,401)
    const reset=await post('/api/auth/login',{user:'admin',password:'admin123'})
    assert.equal(reset.status,200);assert.equal((await reset.json()).passwordChangeRequired,true)
  }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})

test('enabling initial-account mode never replaces an existing token-based setup or custom username',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-existing-auth-'))
  try{
    const first=createOperatorAuth({enabled:true,initialAccount:false,dir}),before=fs.readFileSync(path.join(dir,'auth.json'),'utf8'),token=fs.readFileSync(first.setupFile,'utf8')
    createOperatorAuth({enabled:true,initialAccount:true,dir})
    assert.equal(fs.readFileSync(path.join(dir,'auth.json'),'utf8'),before);assert.equal(fs.readFileSync(first.setupFile,'utf8'),token)
    const state=JSON.parse(before);state.user='custom-user';state.passwordHash='old-hash';delete state.setupHash;fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify(state))
    createOperatorAuth({enabled:true,initialAccount:true,dir})
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8')).passwordHash,'old-hash')
    assert.equal(resetOperatorPassword(dir),'custom-user')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8')).user,'custom-user')
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
