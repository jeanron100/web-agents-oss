import fs from 'node:fs'
import {atomicJson} from './runtime-config.js'
const safeUrl=(v,{https=false}={})=>{
  if(!v)return''
  const u=new URL(v);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||(https&&u.protocol!=='https:'))throw new Error('请输入不含凭据的HTTP/HTTPS地址')
  return u.href.replace(/\/$/,'')
}
export function createInstallationSettings({store,onChange,modelFile,notifications,updateNotifications,send}){
  const load=()=>{try{return JSON.parse(fs.readFileSync(modelFile,'utf8'))}catch{return{}}}
  return async(req,res,url)=>{
    if(url.pathname!=='/api/installation')return false
    try{
      if(req.method==='POST'){
        let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>16384)throw new Error('配置请求过大')}
        const body=JSON.parse(raw),config=store.get()
        if(body.monitorUrl!==undefined)config.integrations={...config.integrations,monitorUrl:safeUrl(body.monitorUrl)}
        if(body.preferredSources){
          const selected={};for(const engine of ['claude','kimi']){const id=body.preferredSources[engine]||'';if(id&&!config.agents.some(a=>a.id===id))throw new Error('额度采集节点不存在');selected[engine]=id}
          config.quota={...config.quota,preferredSources:selected}
        }
        let model
        if(body.assistant){
          const old=load(),a=body.assistant,modelName=String(a.model||'').trim()
          if(modelName.length>100)throw new Error('模型名过长')
          const baseUrl=safeUrl(a.baseUrl),apiKey=a.clearKey?'':String(a.apiKey||old.apiKey||'')
          if(apiKey.length>4096||/[\r\n]/.test(apiKey))throw new Error('密钥格式无效')
          model={baseUrl,model:modelName,apiKey}
        }
        if(body.notifications){
          const n=body.notifications
          if(n.webhook)safeUrl(n.webhook,{https:true})
          // Empty input preserves the existing secret. Disabling is explicit.
          if(!n.clearWebhook&&!n.webhook&&notifications().hasWebhook)throw new Error('修改通知地址时请重新填写Webhook；关闭通知请选择清除')
        }
        const next=store.save(config);onChange(next)
        if(model)atomicJson(modelFile,model)
        if(body.notifications)updateNotifications({baseUrl:safeUrl(body.notifications.baseUrl),webhook:body.notifications.clearWebhook?'':body.notifications.webhook||''})
      }else if(req.method!=='GET'){send(res,405,{error:'只允许GET或POST'});return true}
      const model=load(),config=store.get()
      send(res,200,{monitorUrl:config.integrations?.monitorUrl||'',preferredSources:config.quota?.preferredSources||{},assistant:{baseUrl:model.baseUrl||'',model:model.model||'',hasKey:!!model.apiKey,configured:!!(model.baseUrl&&model.model&&model.apiKey)},notifications:notifications()})
    }catch(e){send(res,400,{error:e.message?.slice(0,160)||'配置无效'})}
    return true
  }
}
