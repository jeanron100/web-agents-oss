import test from 'node:test'
import assert from 'node:assert/strict'
import {externalSandboxEnabled,sandboxPolicy} from './codex-sandbox.js'
test('container external sandbox is explicit and cannot silently change native policies',()=>{
 assert.equal(externalSandboxEnabled({},true),false)
 assert.throws(()=>externalSandboxEnabled({WA_CODEX_EXTERNAL_SANDBOX:'1'},true))
 assert.throws(()=>externalSandboxEnabled({WA_CODEX_EXTERNAL_SANDBOX:'1',WA_CONTAINER_RUNNER:'1'},false))
 assert.equal(externalSandboxEnabled({WA_CODEX_EXTERNAL_SANDBOX:'1',WA_CONTAINER_RUNNER:'1'},true),true)
 const native={type:'workspaceWrite'};assert.deepEqual(sandboxPolicy(native,false),native);assert.deepEqual(sandboxPolicy(native,true),{type:'externalSandbox',networkAccess:'enabled'})
})
