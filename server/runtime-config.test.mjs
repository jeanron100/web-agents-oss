import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createConfigStore,validateConfig,validateNode,createAgentFetch} from './runtime-config.js'

test('clean configuration has no operator servers and invalid edits cannot replace valid persisted state',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-config-'))
  try{
    const store=createConfigStore(path.join(dir,'hub.json'));assert.deepEqual(store.get().agents,[])
    const node={id:'my-node',url:'https://agent.example:8788',token:'s'.repeat(32)}
    store.save({agents:[node]});assert.equal(store.public().agents[0].hasToken,true);assert(!JSON.stringify(store.public()).includes(node.token))
    assert.equal(fs.statSync(store.file).mode&0o777,0o600)
    assert.throws(()=>store.save({agents:[node,node]}),/重复/)
    assert.throws(()=>store.save({agents:[node,{...node,id:'duplicate-address'}]}),/地址不能重复/)
    assert.equal(createConfigStore(store.file).get().agents.length,1)
    store.save({agents:[{...node,enabled:false}]});assert.equal(store.get().agents[0].enabled,false)
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('destinations reject embedded credentials, query injection and malformed identities',()=>{
  for(const url of ['file:///etc/passwd','http://user:pass@example','http://example/path','http://example/?q=secret'])assert.throws(()=>validateNode({id:'node',url}))
  assert.throws(()=>validateNode({id:'../private',url:'http://localhost:8788'}))
  assert.throws(()=>validateNode({id:'node',url:'http://localhost:8788',sshTarget:'root@host;touch /tmp/bad'}))
  assert.equal(validateConfig({agents:[{id:'node',url:'http://localhost:8788'}],retiredAgents:[{id:'node',retiredAt:'2026-10-01'}]}).retiredAgents.length,0)
})
test('node secrets only reach an exact destination and redirects/cookie forwarding are disabled',async()=>{
  const calls=[],request=createAgentFetch(()=>[{url:'http://node:8788',token:'secret-node-token'}],async(u,i)=>{calls.push({u,i});return{ok:true}})
  await request('http://node:8788/api/state',{headers:{cookie:'browser-secret',authorization:'Bearer hub-secret'}})
  assert.equal(calls[0].i.headers.get('authorization'),'Bearer secret-node-token');assert.equal(calls[0].i.headers.get('cookie'),null);assert.equal(calls[0].i.redirect,'error')
  await request('http://node.evil:8788/api/state');assert.equal(calls[1].i.headers,undefined)
})

test('removed node destinations cannot be reached through stale session routing',async()=>{
 let nodes=[{url:'http://node:8788',token:'x'.repeat(32)}],calls=0
 const fetchNode=createAgentFetch(()=>nodes,async()=>{calls++;return{ok:true}})
 await fetchNode('http://node:8788/api/state');nodes=[]
 assert.throws(()=>fetchNode('http://node:8788/api/session/stale'),/禁用或移除/)
 assert.equal(calls,1)
})
