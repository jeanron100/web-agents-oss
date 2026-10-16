import {useEffect,useState} from 'react'
import {IS_DEMO,refreshNow} from '../hub/client'
type Node={id:string;name:string;url:string;region?:string;enabled:boolean;transport:string;hasToken?:boolean;token?:string}
type Info={connected:boolean;error?:string;latencyMs?:number;info?:{id:string;projectRoot:string;container:boolean;engines:Array<{engine:string;installed:boolean;version:string|null;credentialPresent:boolean;loginCommand:string;note:string}>}}
const empty:Node={id:'',name:'',url:'',region:'',enabled:true,transport:'direct',token:''}
const request=async(url:string,method='GET',body?:unknown)=>{const r=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw new Error(d.error||`请求失败（${r.status}）`);return d}
export function ServerManager(){
  const [nodes,setNodes]=useState<Node[]>([]),[form,setForm]=useState<Node>({...empty}),[editing,setEditing]=useState(''),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[msg,setMsg]=useState(''),[info,setInfo]=useState<Info|null>(null),[removeId,setRemoveId]=useState('')
  const load=async()=>{try{const d=await request('/api/servers');setNodes(d.agents||[])}catch(e){setMsg((e as Error).message)}}
  useEffect(()=>{if(!IS_DEMO)void load()},[])
  if(IS_DEMO)return null
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setMsg('');try{await fn()}catch(e){setMsg((e as Error).message)}finally{setBusy(false)}}
  const edit=(node?:Node)=>{setForm(node?{...node,token:''}:{...empty});setEditing(node?.id||'');setOpen(true);setInfo(null);setMsg('')}
  const update=(key:keyof Node,value:string)=>setForm(s=>({...s,[key]:value}))
  const save=()=>act(async()=>{await request(editing?`/api/servers/${encodeURIComponent(editing)}`:'/api/servers',editing?'PUT':'POST',form);setOpen(false);await load();await refreshNow();setMsg('服务器配置已保存并生效。')})
  const changeEnabled=(node:Node)=>act(async()=>{await request(`/api/servers/${encodeURIComponent(node.id)}`,'PATCH',{enabled:!node.enabled});await load();await refreshNow()})
  const remove=()=>act(async()=>{await request(`/api/servers/${encodeURIComponent(removeId)}`,'DELETE');setRemoveId('');await load();await refreshNow();setMsg('节点已移除，历史记录保留；原CLI进程未停止。')})
  return <section className="detail-section server-manager"><div className="node-section-head"><h2>服务器管理</h2><button className="btn btn--primary" onClick={()=>edit()}>添加服务器</button></div>
    {!nodes.length&&<div className="todo-card"><b>接入第一台执行节点</b><p>先运行本机或远程 Agent，再填入它的地址和接入令牌。仅控制台容器不会自动发现宿主机上的CLI。</p><p className="muted">快速体验可使用 compose.runner.yaml；已有CLI环境可按 README 安装原生 Linux Agent。</p></div>}
    {nodes.map(node=><div className="todo-card node-row" key={node.id}><div><b>{node.name}</b><span className="muted"> · {node.enabled?'已启用':'已禁用'}</span><p className="muted node-address">{node.id} · {node.url} · {node.hasToken?'已配置令牌':'未配置令牌'}</p></div><div className="node-actions"><button className="btn btn--sm" disabled={busy} onClick={()=>edit(node)}>编辑</button><button className="btn btn--sm" disabled={busy} onClick={()=>void act(async()=>setInfo(await request(`/api/servers/${encodeURIComponent(node.id)}/info`)))}>检测</button><button className="btn btn--sm" disabled={busy} onClick={()=>void changeEnabled(node)}>{node.enabled?'禁用':'启用'}</button><button className="btn btn--sm" disabled={busy} onClick={()=>setRemoveId(node.id)}>移除</button></div></div>)}
    {removeId&&<div className="todo-card"><p>移除 {removeId}？这会停止纳管，保留历史记录和节点上的CLI进程。</p><div className="node-actions"><button className="btn" onClick={()=>setRemoveId('')}>取消</button><button className="btn btn--primary" disabled={busy} onClick={()=>void remove()}>确认移除</button></div></div>}
    {open&&<form className="todo-card node-form" onSubmit={e=>{e.preventDefault();void save()}}>
      <h3>{editing?'编辑服务器':'添加服务器'}</h3>
      <label>服务器ID<input required disabled={!!editing} placeholder="例如 my-server" value={form.id} onChange={e=>update('id',e.target.value)}/></label>
      <label>显示名称<input placeholder="例如 开发机" value={form.name} onChange={e=>update('name',e.target.value)}/></label>
      <label>Agent地址<input required type="url" placeholder="http://agent-host:8788" value={form.url} onChange={e=>update('url',e.target.value)}/></label>
      <label>接入令牌<input autoComplete="off" type="password" placeholder={editing?'留空保留原令牌':'填写目标Agent的接入令牌'} value={form.token||''} onChange={e=>update('token',e.target.value)}/></label>
      <label>连接方式<select value={form.transport} onChange={e=>update('transport',e.target.value)}><option value="direct">直连内网</option><option value="https">HTTPS</option><option value="ssh-tunnel">已有SSH隧道</option><option value="local-direct">本机</option></select></label>
      <p className="muted">HTTP适用于可信内网或SSH隧道；公网接入使用HTTPS。SSH隧道须事先建立。</p>
      <div className="node-actions"><button type="button" className="btn" disabled={busy} onClick={()=>void act(async()=>setInfo(await request('/api/servers/test','POST',form)))}>测试连接</button><button type="submit" className="btn btn--primary" disabled={busy}>{busy?'处理中…':'保存服务器'}</button><button type="button" className="btn" onClick={()=>setOpen(false)}>取消</button></div>
    </form>}
    {info&&<div className="todo-card" role="status"><b>{info.connected?`连接成功 · ${info.latencyMs}ms`:'连接未成功'}</b>{info.error&&<p>{info.error}</p>}{info.info&&<><p>节点：{info.info.id} · {info.info.container?'容器内执行':'原生执行'} · 项目目录：{info.info.projectRoot}</p>{info.info.engines.map(e=><div className="engine-diagnostic" key={e.engine}><b>{e.engine}</b> · {e.installed?e.version:'CLI未安装'}<p className="muted">{e.installed?`在该执行节点运行 ${e.loginCommand} 完成登录，然后验证一次真实对话。`:'请先按官方文档安装该CLI。'} {e.credentialPresent?'发现凭据文件；有效性需实际连接确认。':''}</p></div>)}</>}</div>}
    {msg&&<p role="status">{msg}</p>}
  </section>
}
