import fs from 'node:fs'
import path from 'node:path'
import {dataDir,configPath,createConfigStore} from './runtime-config.js'
const command=process.argv[2]
if(command==='setup-token'){
  const file=path.join(dataDir(),'setup-token')
  if(!fs.existsSync(file)){console.error('No setup token: already initialized, or console has not started.');process.exitCode=1}
  else process.stdout.write(fs.readFileSync(file,'utf8').trim()+'\n')
}else if(command==='health'){
  const runner=process.argv[3]==='runner',headers={}
  if(runner){const token=process.env.WA_AGENT_TOKEN||(process.env.WA_AGENT_TOKEN_FILE?fs.readFileSync(process.env.WA_AGENT_TOKEN_FILE,'utf8').trim():'');if(token)headers.authorization=`Bearer ${token}`}
  try{const r=await fetch(`http://127.0.0.1:${runner?process.env.WA_AGENT_PORT||8788:process.env.WA_HUB_PORT||8787}${runner?'/api/agent/info':'/api/health'}`,{headers,signal:AbortSignal.timeout(6000)});if(!r.ok)throw new Error('unhealthy')}catch{process.exitCode=1}
}else if(command==='doctor'){
  const config=createConfigStore(configPath()).get()
  const result={node:process.version,authenticated:process.env.WA_AUTH_ENABLED==='1',configReadable:true,nodes:[]}
  for(const a of config.agents){try{const r=await fetch(a.url+'/api/agent/info',{headers:a.token?{authorization:`Bearer ${a.token}`}:{},signal:AbortSignal.timeout(6000)});result.nodes.push({id:a.id,enabled:a.enabled,connected:r.ok,status:r.status,...(r.ok?{info:await r.json()}:{})})}catch{result.nodes.push({id:a.id,enabled:a.enabled,connected:false})}}
  console.log(JSON.stringify(result,null,2))
  if(result.nodes.some(n=>n.enabled&&!n.connected))process.exitCode=1
}else{console.error('Usage: node server/manage.mjs setup-token | health [runner] | doctor');process.exitCode=2}
