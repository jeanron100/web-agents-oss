import {validateNode} from './runtime-config.js'
const read=async req=>{let s='';for await(const c of req){s+=c;if(Buffer.byteLength(s)>32768)throw new Error('配置请求过大')}return JSON.parse(s||'{}')}
export function createServerManagement({store,onChange,probe,send}){
  const save=async next=>{const result=store.save(next);await onChange(result);return result}
  return async(req,res,url)=>{
    if(!url.pathname.startsWith('/api/servers'))return false
    try{
      if(url.pathname==='/api/servers'&&req.method==='GET'){send(res,200,store.public());return true}
      if(url.pathname==='/api/servers/test'&&req.method==='POST'){
        const body=await read(req),prior=store.get().agents.find(a=>a.id===body.id)
        const node=validateNode({...body,token:body.token||prior?.token||''})
        send(res,200,await probe(node));return true
      }
      const match=/^\/api\/servers\/([a-zA-Z0-9._-]+)(\/info)?$/.exec(url.pathname)
      if(match?.[2]&&req.method==='GET'){
        const node=store.get().agents.find(a=>a.id===match[1]);if(!node){send(res,404,{error:'服务器不存在'});return true}
        send(res,200,await probe(node));return true
      }
      if(url.pathname==='/api/servers'&&req.method==='POST'){
        const node=validateNode(await read(req)),config=store.get()
        if(config.agents.some(a=>a.id===node.id)){send(res,409,{error:'服务器ID已存在'});return true}
        config.agents.push(node);await save(config);send(res,201,store.public());return true
      }
      if(match&&!match[2]&&['PUT','PATCH','DELETE'].includes(req.method)){
        const config=store.get(),index=config.agents.findIndex(a=>a.id===match[1])
        if(index<0){send(res,404,{error:'服务器不存在'});return true}
        if(req.method==='DELETE'){
          config.agents.splice(index,1);config.retiredAgents.push({id:match[1],retiredAt:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})})
        }else{
          const body=await read(req),old=config.agents[index]
          if(body.id&&body.id!==old.id){send(res,400,{error:'服务器ID不能修改；请新增节点以保留历史归属'});return true}
          config.agents[index]=validateNode({...old,...body,id:old.id,token:body.clearToken?'':body.token||old.token||''})
        }
        await save(config);send(res,200,store.public());return true
      }
      send(res,405,{error:'不支持的服务器管理操作'});return true
    }catch(e){send(res,400,{error:e.message?.slice(0,180)||'服务器配置无效'});return true}
  }
}
