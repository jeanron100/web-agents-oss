import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { modelInvocation } from './model-invocation.js'
import { createProgressModel } from './progress-model.js'

const response = content => ({ model:'auto', metadata:{resolved_model:'gpt-6.1-sol',resolved_provider:'codex',request_id:'req-123',warnings:[{parameter:'max_tokens',policy:'ignored',detail:'max_tokens is ignored by this upstream'}]},usage:{prompt_tokens:420,completion_tokens:31,total_tokens:451,prompt_tokens_details:{cached_tokens:100},completion_tokens_details:{reasoning_tokens:10}},choices:[{message:{content}}] })

test('gateway-resolved model, detailed tokens and compatibility warning survive JSON parsing',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-model-meta-')),file=path.join(dir,'model.json')
 await fs.writeFile(file,JSON.stringify({baseUrl:'https://gateway.example/v1',apiKey:'private-fixture-value',model:'auto'}))
 try{
  const model=createProgressModel({configFile:file,fetchImpl:async()=>({ok:true,json:async()=>response(JSON.stringify({terms:['disk'],invocation:{actualModel:'invented',usage:{totalTokens:0}}}))})})
  const out=await model('plan',{})
  assert.deepEqual(out.terms,['disk']);assert.equal(out.invocation.actualModel,'gpt-6.1-sol');assert.equal(out.invocation.requestedModel,'auto')
  assert.equal(out.invocation.usage.totalTokens,451);assert.equal(out.invocation.usage.cachedInputTokens,100)
  assert.equal(out.invocation.warnings[0].parameter,'max_tokens');assert.equal(out.invocation.warnings[0].policy,'ignored')
  const malformed=createProgressModel({configFile:file,fetchImpl:async()=>({ok:true,json:async()=>response('not json')})})
  await assert.rejects(()=>malformed('answer',{}),error=>error.invocation.usage.totalTokens===451&&error.invocation.warnings.length===1)
 }finally{await fs.rm(dir,{recursive:true,force:true})}
})
test('unknown model and absent or invalid counters are not fabricated as zero',()=>{
 const unknown=modelInvocation({model:'auto',usage:{prompt_tokens:-1,completion_tokens:'5',total_tokens:null}},{requestedModel:'auto',stage:'answer'})
 assert.equal(unknown.actualModel,null);assert.deepEqual(Object.values(unknown.usage),Array(6).fill(null))
 const zero=modelInvocation({model:'reported-model',usage:{input_tokens:0,output_tokens:0,total_tokens:0}},{stage:'plan'})
 assert.equal(zero.actualModel,'reported-model');assert.equal(zero.usage.inputTokens,0)
})
test('only bounded redacted metadata is exposed, never raw response fields or configured secret',()=>{
 const body=response('{}');body.metadata.apiKey='private-fixture-value';body.metadata.warnings=Array(20).fill({parameter:'max_tokens',policy:'ignored',detail:'private-fixture-value Bearer secret-token-123 '+ '中文'.repeat(1000)})
 const info=modelInvocation(body,{stage:'answer',secret:'private-fixture-value'})
 assert.equal(info.warnings.length,8);assert(info.warningsTruncated);assert(!JSON.stringify(info).includes('private-fixture-value'));assert(!JSON.stringify(info).includes('secret-token-123'));assert(info.warnings[0].detail.length<=320)
 assert(!('apiKey' in info));assert(!('choices' in info))
})
