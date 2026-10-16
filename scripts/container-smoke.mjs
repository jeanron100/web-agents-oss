import fs from 'node:fs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
const base=process.argv[2]||'http://127.0.0.1:5188',file=process.argv[3]
if(!file)throw new Error('Provide a private evidence path for an isolated fresh installation')
const password='smoke-'+crypto.randomBytes(20).toString('hex'),token=crypto.randomBytes(32).toString('hex')
let user='smoke-admin'
const headers={'Content-Type':'application/json'},request=(route,method='GET',body,extra={})=>fetch(base+route,{method,headers:{...headers,...extra},...(body?{body:JSON.stringify(body)}:{})})
const health=await(await request('/api/health')).json()
const releaseTag=fs.readFileSync(new URL('../release/version',import.meta.url),'utf8').trim()
assert.equal(health.version,releaseTag.replace(/^v/,''));assert.equal(health.releaseTag,releaseTag)
assert.equal((await request('/api/state')).status,401)
const status=await(await request('/api/auth/status')).json()
if(status.initialAccount){
  user='admin'
  const initial=await request('/api/auth/login','POST',{user,password:'admin123'});assert.equal(initial.status,200)
  assert.equal((await initial.json()).passwordChangeRequired,true)
  const restricted={cookie:initial.headers.get('set-cookie').split(';')[0]}
  assert.equal((await request('/api/state','GET',null,restricted)).status,403)
  assert.equal((await request('/api/servers','POST',{id:'blocked',url:'http://127.0.0.1:9'},restricted)).status,403)
  assert.equal((await request('/api/auth/password','POST',{oldPassword:'admin123',password},restricted)).status,200)
  assert.equal((await request('/api/state','GET',null,restricted)).status,401)
  assert.equal((await request('/api/auth/login','POST',{user,password:'admin123'})).status,401)
}else{
  assert.equal((await request('/api/auth/setup','POST',{setupToken:fs.readFileSync(file,'utf8').trim(),user,password})).status,201)
}
const login=await request('/api/auth/login','POST',{user,password});assert.equal(login.status,200)
const cookie=login.headers.get('set-cookie').split(';')[0],auth={cookie}
assert.equal((await request('/api/state','GET',null,auth)).status,200)
assert.equal((await request('/api/servers','POST',{id:'blocked',url:'http://example.com'}, {...auth,Origin:'https://untrusted.example'})).status,403)
assert.equal((await request('/api/servers','POST',{id:'smoke-node',url:'http://127.0.0.1:9',token},auth)).status,201)
let result=await(await request('/api/servers','GET',null,auth)).json();assert(!JSON.stringify(result).includes(token));assert(result.agents.find(n=>n.id==='smoke-node').hasToken)
assert.equal((await request('/api/servers/smoke-node','PATCH',{enabled:false},auth)).status,200)
assert.equal((await request('/api/servers/smoke-node','DELETE',null,auth)).status,200)
assert.equal((await request('/api/auth/logout','POST',{},auth)).status,200)
assert.equal((await request('/api/state','GET',null,auth)).status,401)
assert.equal((await fetch(base+'/')).status,200)
// Test credentials written only to an explicitly private neighboring file for restart/UI verification.
fs.writeFileSync(file+'.smoke-admin.json',JSON.stringify({user,password}),{mode:0o600})
console.log('PASS: fresh account, required first password change or token setup, login, protected state, origin checks, node lifecycle, secret redaction, logout and SPA')
