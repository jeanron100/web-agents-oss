import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'
const version=bin=>new Promise(resolve=>execFile(bin,['--version'],{timeout:4000,maxBuffer:4096},(e,out)=>resolve(e?null:out.trim().split('\n')[0].slice(0,100))))
export function createAgentInfo({root,identity=process.env.WA_SERVER_ID||os.hostname()}={}){
  let cached,pending
  return async()=>{
    if(cached&&Date.now()-cached.at<30000)return cached
    if(pending)return pending
    pending=(async()=>{
      const home=os.homedir(),specs=[
        ['codex',process.env.CODEX_BIN||'codex','codex login --device-auth',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'auth.json')],
        ['kimi',process.env.KIMI_BIN||path.join(home,'.kimi-code/bin/kimi'),'kimi login',path.join(home,'.kimi-code/credentials')],
        ['claude',process.env.CLAUDE_BIN||'claude','claude',path.join(home,'.claude/.credentials.json')],
      ]
      const engines=await Promise.all(specs.map(async([engine,bin,login,credential])=>{const v=await version(bin);return{engine,installed:!!v,version:v,credentialPresent:fs.existsSync(credential),loginCommand:login,note:'凭据文件存在不代表授权仍有效；请完成CLI登录后实际验证。'}}))
      return cached={at:Date.now(),id:identity,platform:process.platform,nodeVersion:process.versions.node,projectRoot:root,container:process.env.WA_CONTAINER_RUNNER==='1',engines,capabilities:{message:true,terminal:true,images:true,immediateSteer:true,queue:true}}
    })().finally(()=>{pending=null});return pending
  }
}
