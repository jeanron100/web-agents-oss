import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {atomicJson,configPath,validateConfig} from './runtime-config.js'
const mode=process.argv[2]||'console'
if(mode==='console'){
  const file=configPath(),fresh=!fs.existsSync(file)
  if(process.env.WA_LOCAL_RUNNER_URL){
    const key='/run/web-agents/runner/token'
    fs.mkdirSync(path.dirname(key),{recursive:true})
    if(!fs.existsSync(key))fs.writeFileSync(key,crypto.randomBytes(32).toString('hex'),{mode:0o600})
    if(fresh)atomicJson(file,validateConfig({agents:[{id:'local-runner',name:'本机容器节点',url:process.env.WA_LOCAL_RUNNER_URL,token:fs.readFileSync(key,'utf8').trim()}]}))
  }
  await import('./hub.js')
}else if(mode==='runner'){
  const file=process.env.WA_AGENT_TOKEN_FILE
  for(let i=0;file&&!fs.existsSync(file)&&i<90;i++)await new Promise(r=>setTimeout(r,1000))
  fs.mkdirSync(process.env.WA_PROJECT_ROOT||'/workspace',{recursive:true})
  await import('./agent.js')
}else throw new Error('Expected console or runner')
