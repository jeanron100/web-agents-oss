import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here=path.dirname(fileURLToPath(import.meta.url))
export const dataDir=()=>path.resolve(process.env.WA_DATA_DIR||path.join(os.homedir(),'.web-agents'))
export const statePath=(name,legacy)=>process.env.WA_DATA_DIR?path.join(dataDir(),name):legacy||path.join(dataDir(),name)
export const configPath=()=>process.env.WA_HUB_CONFIG||
  (fs.existsSync('/etc/web-agents/hub-config.json')?'/etc/web-agents/hub-config.json':path.join(here,'hub-config.json'))

export function validateNode(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('服务器配置必须为对象')
  const id=String(input.id||'').trim()
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id))throw new Error('服务器ID只允许字母、数字、点、横线和下划线，最长64字符')
  let u;try{u=new URL(input.url)}catch{throw new Error('请输入完整的HTTP或HTTPS节点地址')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('节点地址只能包含HTTP/HTTPS协议、主机和端口，不能含凭据或路径')
  const token=String(input.token||'')
  if(token&&(!/^[\x21-\x7e]{24,512}$/.test(token)))throw new Error('接入令牌须为24至512个可打印字符')
  const transport=input.transport||'direct'
  if(!['direct','local-direct','ssh-tunnel','https'].includes(transport))throw new Error('不支持的连接方式')
  const clean=(v,max)=>String(v||'').trim().slice(0,max)
  const node={id,name:clean(input.name,100)||id,url:u.origin,region:clean(input.region,100),flag:clean(input.flag,12),transport,enabled:input.enabled!==false}
  if(token)node.token=token
  if(input.sshTarget){
    if(!/^(?:local|[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+)$/.test(input.sshTarget))throw new Error('维护SSH目标须为local或user@host')
    node.sshTarget=input.sshTarget
  }
  return node
}

export function validateConfig(input){
  if(!input||!Array.isArray(input.agents)||input.agents.length>100)throw new Error('agents必须是最多100个节点的数组')
  const agents=input.agents.map(validateNode),ids=agents.map(a=>a.id)
  if(new Set(ids).size!==ids.length)throw new Error('服务器ID不能重复')
  if(new Set(agents.map(a=>a.url)).size!==agents.length)throw new Error('节点地址不能重复')
  const retiredAgents=(input.retiredAgents||[]).map(r=>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(r.id)||!/^\d{4}-\d{2}-\d{2}$/.test(r.retiredAt))throw new Error('历史节点信息无效')
    return{id:r.id,retiredAt:r.retiredAt}
  }).filter(r=>!ids.includes(r.id))
  const quota=input.quota||{},groups=quota.groups||[],historyAliases=quota.historyAliases||{}
  if(!Array.isArray(groups)||groups.length>100)throw new Error('额度分组无效')
  for(const g of groups)if(typeof g.accountId!=='string'||!g.accountId||!Array.isArray(g.serverIds)||g.serverIds.some(id=>typeof id!=='string'))throw new Error('额度分组须包含账号标识和节点列表')
  for(const [key,value] of Object.entries(historyAliases))if(['__proto__','constructor','prototype'].includes(key)||typeof value!=='string')throw new Error('历史账号别名无效')
  return{...input,agents,retiredAgents,quota:{...quota,groups,historyAliases}}
}

export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
  const temporary=file+'.'+crypto.randomUUID()+'.tmp'
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);fs.chmodSync(file,0o600)}
  finally{try{fs.unlinkSync(temporary)}catch{}}
}

export function createConfigStore(file=configPath()){
  let config
  try{config=validateConfig(JSON.parse(fs.readFileSync(file,'utf8')))}catch(e){
    if(e.code!=='ENOENT')throw e
    config=validateConfig({agents:[],retiredAgents:[]});atomicJson(file,config)
  }
  return{file,get:()=>structuredClone(config),save(next){const valid=validateConfig(next);atomicJson(file,valid);config=valid;return this.get()},
    public(){return{agents:config.agents.map(({token,...n})=>({...n,hasToken:!!token})),retiredAgents:config.retiredAgents}}}
}

export function createAgentFetch(getAgents,nativeFetch=globalThis.fetch){
  const known=new Set(getAgents().map(a=>a.url))
  return(input,init={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url)
    const current=getAgents();for(const a of current)known.add(a.url)
    const agent=current.find(a=>a.url===url.origin)
    if(!agent&&known.has(url.origin))throw new Error('节点已禁用或移除')
    if(!agent)return nativeFetch(input,init)
    const headers=new Headers(init.headers)
    headers.delete('cookie');headers.delete('authorization')
    if(agent.token)headers.set('authorization',`Bearer ${agent.token}`)
    return nativeFetch(input,{...init,headers,redirect:'error'})
  }
}
