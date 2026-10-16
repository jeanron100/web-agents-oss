// No provider account/model call: validate local CLI protocols and one sandboxed local command.
import {spawn} from 'node:child_process'
import readline from 'node:readline'
import assert from 'node:assert/strict'
import fs from 'node:fs'
if(process.env.WA_CONTAINER_RUNNER!=='1'||!fs.existsSync('/.dockerenv'))throw new Error('Run this self-check inside an isolated runner container')
async function check(bin,args,initialize,command){
 const p=spawn(bin,args,{stdio:['pipe','pipe','pipe']}),pending=new Map();let id=0
 p.stderr.on('data',()=>{})
 const lines=readline.createInterface({input:p.stdout})
 lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}const item=pending.get(m.id);if(item){pending.delete(m.id);clearTimeout(item.timer);m.error?item.reject(new Error(JSON.stringify(m.error))):item.resolve(m.result)}})
 p.on('error',e=>{for(const v of pending.values()){clearTimeout(v.timer);v.reject(e)}pending.clear()})
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error(bin+' '+method+' timed out'))},15000);pending.set(n,{resolve,reject,timer});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')})
 try{const init=await rpc('initialize',initialize);if(command){p.stdin.write(JSON.stringify({method:'initialized'})+'\n');await command(rpc)}return init}
 finally{for(const v of pending.values())clearTimeout(v.timer);lines.close();p.stdin.destroy();p.stdout.destroy();p.stderr.destroy();p.kill('SIGTERM');p.unref();const timer=setTimeout(()=>p.kill('SIGKILL'),1000);timer.unref()}
}
await check('codex',['app-server'],{clientInfo:{name:'web-agents-selfcheck',version:'1.0.0'},capabilities:{experimentalApi:true}},async rpc=>{
 const out=await rpc('command/exec',{command:['/bin/sh','-c','printf wa-runner-selfcheck'],cwd:process.env.WA_PROJECT_ROOT||'/workspace',sandboxPolicy:{type:'externalSandbox',networkAccess:'restricted'},timeoutMs:10000})
 assert.equal(out.exitCode,0);assert.equal(out.stdout,'wa-runner-selfcheck')
})
const kimi=await check(process.env.KIMI_BIN||'kimi',['acp'],{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'web-agents-selfcheck',version:'1.0.0'}})
assert.equal(kimi.protocolVersion,1)
console.log('PASS: Codex app-server RPC, isolated local command, Kimi ACP initialize; no provider inference or login tested')
