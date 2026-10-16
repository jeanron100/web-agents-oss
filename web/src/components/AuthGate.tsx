import {createContext,useContext,useEffect,useState,type ReactNode} from 'react'
import {IS_DEMO} from '../hub/client'
import {applyTheme,loadTheme} from '../lib/theme'
import {tr,useLanguage} from '../lib/language'
type Status={enabled:boolean;authenticated:boolean;setupRequired?:boolean;initialAccount?:boolean;passwordChangeRequired?:boolean;user?:string}
const Operator=createContext<Status>({enabled:false,authenticated:true})
export const useOperator=()=>useContext(Operator)
export const requestLogin=()=>window.dispatchEvent(new Event('wa-auth-required'))

function PasswordField({id,label,value,onChange,autoComplete='current-password',minLength,description}:{id:string;label:string;value:string;onChange:(value:string)=>void;autoComplete?:string;minLength?:number;description?:string}){
  useLanguage()
  const [visible,setVisible]=useState(false)
  return <div className="auth-field"><label htmlFor={id}>{label}</label><div className="auth-password"><input id={id} name={id} type={visible?'text':'password'} autoComplete={autoComplete} minLength={minLength} maxLength={256} required value={value} onChange={e=>onChange(e.target.value)} aria-describedby={description?`${id}-hint`:undefined}/><button type="button" className="auth-password__toggle" aria-label={`${visible?tr("隐藏"):tr("显示")}${label}`} aria-pressed={visible} onClick={()=>setVisible(!visible)}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{visible&&<path d="m3 3 18 18"/>}</svg></button></div>{description&&<p className="auth-hint" id={`${id}-hint`}>{description}</p>}</div>
}

export function AuthGate({children}:{children:ReactNode}){
  const [language,changeLanguage]=useLanguage()
  const [status,setStatus]=useState<Status|null>(IS_DEMO?{enabled:false,authenticated:true}:null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[user,setUser]=useState('admin'),[password,setPassword]=useState(''),[token,setToken]=useState('')
  const [notice,setNotice]=useState(''),[oldPassword,setOldPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[theme,setTheme]=useState(loadTheme)
  const check=async()=>{
    setError('')
    try{
      const r=await fetch('/api/auth/status',{signal:AbortSignal.timeout(10000)})
      if(r.status===404){setStatus({enabled:false,authenticated:true});return}
      if(!r.ok)throw new Error(tr("无法连接认证服务"))
      const s=await r.json();if(typeof s.enabled!=='boolean')throw new Error(tr("认证服务返回无效数据"));setStatus(s)
    }catch{setError(tr("连接控制台失败，请检查服务状态后重试。"))}
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
    if(busy)return
    if(status?.authenticated&&status.passwordChangeRequired&&password!==confirmation){setError(tr("两次输入的新密码不一致。"));return}
    setBusy(true);setError('');setNotice('')
    try{
      const changing=status?.authenticated&&status.passwordChangeRequired
      const r=await fetch(changing?'/api/auth/password':status?.setupRequired?'/api/auth/setup':'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify(changing?{oldPassword,password}:{user,password,...(status?.setupRequired?{setupToken:token}:{})})})
      const d=await r.json();if(!r.ok)throw new Error(d.error||tr("登录失败"))
      setOldPassword(d.passwordChangeRequired?password:'');setPassword('');setToken('');setConfirmation('')
      if(changing){setNotice(tr("密码已更新，请使用新密码登录。"));await check()}
      else if(status?.setupRequired){setStatus({...status,setupRequired:false});setNotice(tr("管理员已创建，请使用刚才设置的密码登录。"))}else await check()
    }catch(e){setError(e instanceof Error&&['TimeoutError','AbortError'].includes(e.name)?tr("连接超时，请稍后重试。"):(e as Error).message)}finally{setBusy(false)}
  }
  if((status?.authenticated&&!status.passwordChangeRequired)||status?.enabled===false)return <Operator.Provider value={status}>{children}</Operator.Provider>
  const changing=!!(status?.authenticated&&status.passwordChangeRequired)
  const toggleTheme=()=>{const next=theme==='light'?'default':'light';applyTheme(next);setTheme(next)}
  return <main className="auth-page" lang={language==='en'?'en':'zh-CN'}><div className="auth-shell">
    <header className="auth-brand"><span className="auth-brand__mark" aria-hidden="true">⌘</span><div><span className="auth-brand__name">Web Agents</span><p>{tr("多服务器 AI 编码代理管控台")}</p></div><button type="button" className="auth-language" lang={language==='zh'?'en':'zh-CN'} onClick={()=>changeLanguage(language==='zh'?'en':'zh')} aria-label={language==='zh'?'Switch to English':'切换为中文'}>{language==='zh'?'English':'中文'}</button><button type="button" className="auth-theme" onClick={toggleTheme} aria-label={theme==='light'?tr("切换深色主题"):tr("切换浅色主题")} title={theme==='light'?tr("切换深色主题"):tr("切换浅色主题")}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{theme==='light'?<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>}</svg></button></header>
    <form className="auth-card" aria-labelledby="auth-title" aria-busy={busy} onSubmit={e=>{e.preventDefault();void submit()}}>
      <h1 id="auth-title">{!status?tr("连接控制台"):changing?tr("设置你的登录密码"):status.setupRequired?tr("初始化管理员"):tr("欢迎回来")}</h1>
      <p className="auth-description">{changing?tr("初始密码仅用于首次登录。设置新密码后，即可进入控制台。"):status?.setupRequired?tr("创建一个管理员账户，开始管理你的项目。"):tr("登录后，继续查看项目进展和处理待办。")}</p>
      {!status?<><p role={error?'alert':'status'} className={error?'auth-message auth-message--error':'auth-hint'}>{tr(error||"正在连接控制台…")}</p>{error&&<button type="button" className="btn auth-submit" onClick={()=>void check()}>{tr("重试连接")}</button>}</>:<>
        {status.setupRequired&&<><p className="auth-hint">{tr("从控制台服务器获取一次性初始化令牌。容器安装可运行：")}</p><code className="install-command">docker compose --env-file .compose.env exec console node server/manage.mjs setup-token</code><PasswordField id="auth-token" label={tr("初始化令牌")} value={token} onChange={setToken} autoComplete="off"/></>}
        {changing?<><p className="auth-account">{tr("当前账户 ")}<strong>{status.user}</strong></p><PasswordField id="auth-current-password" label={tr("当前密码")} value={oldPassword} onChange={setOldPassword}/></>:<div className="auth-field"><label htmlFor="auth-user">{tr("用户名")}</label><input id="auth-user" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} value={user} onChange={e=>setUser(e.target.value)}/></div>}
        <PasswordField id="auth-password" label={changing?tr("新密码"):tr("密码")} value={password} onChange={setPassword} autoComplete={changing||status.setupRequired?'new-password':'current-password'} minLength={changing||status.setupRequired?12:undefined} description={changing||status.setupRequired?tr("至少 12 个字符，建议使用多个单词或密码管理器生成。"):undefined}/>
        {changing&&<PasswordField id="auth-confirm-password" label={tr("确认新密码")} value={confirmation} onChange={setConfirmation} autoComplete="new-password" minLength={12}/>}
        {error&&<p className="auth-message auth-message--error" role="alert">{tr(error)}</p>}
        {notice&&<p className="auth-message auth-message--success" role="status">{tr(notice)}</p>}
        <button className="btn btn--primary auth-submit" disabled={busy}>{busy?tr("处理中…"):changing?tr("保存新密码"):status.setupRequired?tr("创建管理员"):tr("登录")}</button>
        {!changing&&!status.setupRequired&&<div className="auth-help">{status.initialAccount?<p>{tr("初始账户 ")}<strong>admin</strong>{tr(" · 密码 ")}<strong>admin123</strong><br/>{tr("首次登录后，请设置自己的密码。")}</p>:<p>{tr("使用初始化时设置的账户登录。升级安装会保留原账号和密码。")}</p>}<details><summary>{tr("无法登录？")}</summary><p>{tr("忘记密码时，在安装目录的终端中重置临时密码，再仅重启控制台：")}</p><code className="install-command">docker compose --env-file .compose.env exec console node server/manage.mjs reset-password<br/>docker compose --env-file .compose.env restart console</code><p>{tr("原用户名保留，临时密码为 admin123，登录后需重新设密；远程 CLI 不受此控制台重启影响。")}</p></details></div>}
      </>}
    </form><p className="auth-footer">{tr("你的项目与执行进展，统一掌握。")}</p>
  </div></main>
}

export function AccountSettings(){
  const [language]=useLanguage()
  const status=useOperator(),[oldPassword,setOld]=useState(''),[password,setPassword]=useState(''),[msg,setMsg]=useState('')
  if(!status.enabled)return null
  const logout=async()=>{await fetch('/api/auth/logout',{method:'POST'});requestLogin()}
  const change=async()=>{
    try{const r=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oldPassword,password})});const d=await r.json();if(!r.ok)throw new Error(d.error);requestLogin()}catch(e){setMsg((e as Error).message)}
  }
  return <section className="detail-section" lang={language==='en'?'en':'zh-CN'}><h2>{tr("账户")}</h2><div className="todo-card node-form"><p>{tr("当前用户：")}{status.user}</p><button className="btn" onClick={()=>void logout()}>{tr("退出登录")}</button><details><summary>{tr("修改密码")}</summary><label>{tr("原密码")}<input type="password" autoComplete="current-password" value={oldPassword} onChange={e=>setOld(e.target.value)}/></label><label>{tr("新密码（至少12字符）")}<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="btn" onClick={()=>void change()}>{tr("保存并重新登录")}</button>{msg&&<p role="alert">{tr(msg)}</p>}</details></div></section>
}
