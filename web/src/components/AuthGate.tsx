import {createContext,useContext,useEffect,useState,type ReactNode} from 'react'
import {IS_DEMO} from '../hub/client'
type Status={enabled:boolean;authenticated:boolean;setupRequired?:boolean;user?:string}
const Operator=createContext<Status>({enabled:false,authenticated:true})
export const useOperator=()=>useContext(Operator)
export const requestLogin=()=>window.dispatchEvent(new Event('wa-auth-required'))

export function AuthGate({children}:{children:ReactNode}){
  const [status,setStatus]=useState<Status|null>(IS_DEMO?{enabled:false,authenticated:true}:null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[user,setUser]=useState('admin'),[password,setPassword]=useState(''),[token,setToken]=useState('')
  const check=async()=>{
    setError('')
    try{
      const r=await fetch('/api/auth/status',{signal:AbortSignal.timeout(10000)})
      if(r.status===404){setStatus({enabled:false,authenticated:true});return}
      if(!r.ok)throw new Error('无法连接认证服务')
      const s=await r.json();if(typeof s.enabled!=='boolean')throw new Error('认证服务返回无效数据');setStatus(s)
    }catch{setError('连接控制台失败，请检查服务状态后重试。')}
  }
  useEffect(()=>{if(!IS_DEMO)void check()},[])
  useEffect(()=>{
    if(!status?.enabled)return
    const original=window.fetch
    window.fetch=async(...args)=>{
      const r=await original(...args)
      const raw=typeof args[0]==='string'?args[0]:args[0] instanceof URL?args[0].href:args[0].url
      try{const u=new URL(raw,location.href);if(r.status===401&&u.origin===location.origin&&u.pathname.startsWith('/api/')&&!u.pathname.startsWith('/api/auth/'))requestLogin()}catch{/* native fetch reports malformed URLs */}
      return r
    }
    const reset=()=>{setPassword('');setStatus(s=>s?{...s,authenticated:false}:s)}
    window.addEventListener('wa-auth-required',reset)
    return()=>{window.fetch=original;window.removeEventListener('wa-auth-required',reset)}
  },[status?.enabled])
  const submit=async()=>{
    if(busy)return;setBusy(true);setError('')
    try{
      const r=await fetch(status?.setupRequired?'/api/auth/setup':'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user,password,...(status?.setupRequired?{setupToken:token}:{})})})
      const d=await r.json();if(!r.ok)throw new Error(d.error||'登录失败')
      setPassword('');setToken('')
      if(status?.setupRequired){setStatus({...status,setupRequired:false});setError('管理员已创建，请使用刚才设置的密码登录。')}else await check()
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  if(status?.authenticated||status?.enabled===false)return <Operator.Provider value={status}>{children}</Operator.Provider>
  return <div className="auth-page"><form className="auth-card" onSubmit={e=>{e.preventDefault();void submit()}}>
    <h1>Agent 管控台</h1>
    {!status?<><p>{error||'正在连接控制台…'}</p>{error&&<button type="button" className="btn" onClick={()=>void check()}>重试连接</button>}</>:<>
      <h2>{status.setupRequired?'初始化管理员':'登录'}</h2>
      {status.setupRequired&&<><p className="muted">从控制台服务器获取一次性初始化令牌。容器安装可运行：</p><code className="install-command">docker compose --env-file .compose.env exec console node server/manage.mjs setup-token</code><label>初始化令牌<input autoComplete="off" type="password" required value={token} onChange={e=>setToken(e.target.value)}/></label></>}
      <label>用户名<input autoComplete="username" required value={user} onChange={e=>setUser(e.target.value)}/></label>
      <label>密码<input type="password" autoComplete={status.setupRequired?'new-password':'current-password'} minLength={status.setupRequired?12:undefined} required value={password} onChange={e=>setPassword(e.target.value)}/></label>
      {error&&<p role="alert">{error}</p>}
      <button className="btn btn--primary" disabled={busy}>{busy?'处理中…':status.setupRequired?'创建管理员':'登录'}</button>
    </>}
  </form></div>
}

export function AccountSettings(){
  const status=useOperator(),[oldPassword,setOld]=useState(''),[password,setPassword]=useState(''),[msg,setMsg]=useState('')
  if(!status.enabled)return null
  const logout=async()=>{await fetch('/api/auth/logout',{method:'POST'});requestLogin()}
  const change=async()=>{
    try{const r=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPassword,password})});const d=await r.json();if(!r.ok)throw new Error(d.error);requestLogin()}catch(e){setMsg((e as Error).message)}
  }
  return <section className="detail-section"><h2>账户</h2><div className="todo-card node-form"><p>当前用户：{status.user}</p><button className="btn" onClick={()=>void logout()}>退出登录</button><details><summary>修改密码</summary><label>原密码<input type="password" autoComplete="current-password" value={oldPassword} onChange={e=>setOld(e.target.value)}/></label><label>新密码（至少12字符）<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="btn" onClick={()=>void change()}>保存并重新登录</button>{msg&&<p role="alert">{msg}</p>}</details></div></section>
}
