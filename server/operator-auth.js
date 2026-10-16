import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {promisify} from 'node:util'
import {atomicJson,dataDir} from './runtime-config.js'

const derive=promisify(crypto.scrypt),digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex')
export const equalSecret=(a,b)=>crypto.timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)))
const send=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body))}
const read=async req=>{let body='';for await(const c of req){body+=c;if(Buffer.byteLength(body)>8192)throw new Error('请求过大')}try{return JSON.parse(body||'{}')}catch{throw new Error('JSON格式错误')}}
const random=()=>crypto.randomBytes(32).toString('base64url')
const initialPasswordHash=()=>{const salt=crypto.randomBytes(16).toString('hex');return salt+'.'+crypto.scryptSync('admin123',salt,32).toString('hex')}
export function resetOperatorPassword(dir=dataDir()){
  const file=path.join(dir,'auth.json'),state=JSON.parse(fs.readFileSync(file,'utf8'))
  if(state.version!==1||!state.user)throw new Error('管理员尚未初始化')
  state.passwordHash=initialPasswordHash();state.passwordChangeRequired=true;state.sessions=[];atomicJson(file,state)
  return state.user
}
export function createOperatorAuth({enabled=process.env.WA_AUTH_ENABLED==='1',initialAccount=process.env.WA_INITIAL_ACCOUNT==='1',dir=dataDir(),publicUrl=process.env.WA_PUBLIC_URL||'',now=Date.now}={}){
  if(!enabled)return{enabled:false,authorize:()=>({ok:true,role:'admin'}),handle:async(req,res)=>{
    if(req.url.split('?')[0]!=='/api/auth/status')return false
    send(res,200,{enabled:false,authenticated:true});return true
  }}
  const file=path.join(dir,'auth.json'),setupFile=path.join(dir,'setup-token'),mcpFile=path.join(dir,'mcp-token')
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  let state
  try{state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.version!==1)throw new Error('Unsupported authentication state')}
  catch(e){
    if(e.code!=='ENOENT')throw e
    if(initialAccount)state={version:1,user:'admin',passwordHash:initialPasswordHash(),passwordChangeRequired:true,sessions:[]}
    else{const setupToken=random();state={version:1,setupHash:digest(setupToken),sessions:[]};fs.writeFileSync(setupFile,setupToken+'\n',{mode:0o600})}
    atomicJson(file,state)
  }
  let mcpToken
  try{mcpToken=fs.readFileSync(mcpFile,'utf8').trim()}catch(e){if(e.code!=='ENOENT')throw e;mcpToken=random();fs.writeFileSync(mcpFile,mcpToken+'\n',{mode:0o600})}
  const save=()=>atomicJson(file,state),attempts=new Map();let hashing=0
  const hash=async(password,salt=crypto.randomBytes(16).toString('hex'))=>{
    if(hashing>=4)throw new Error('登录服务繁忙，请稍后重试')
    hashing++;try{return salt+'.'+(await derive(password,salt,32)).toString('hex')}finally{hashing--}
  }
  const secure=req=>!!req.socket.encrypted||publicUrl.startsWith('https://')
  const cookie=(value,req,maxAge=30*86400)=>`wa_operator=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req)?'; Secure':''}`
  const cookieToken=req=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('wa_operator='))?.slice(12)||''
  const originOK=req=>{
    if(req.headers['sec-fetch-site']==='cross-site')return false
    if(!req.headers.origin)return true
    try{return new URL(req.headers.origin).origin===new URL(publicUrl||`http://${req.headers.host}`).origin}catch{return false}
  }
  const readOnly=p=>p==='/api/state'||p==='/api/pending'||p==='/api/assistant/progress'||p==='/api/assistant/evidence'||/^\/api\/session\/[^/]+\/events$/.test(p)||/^\/api\/v2\/(events|runs)(\/|$)/.test(p)
  const authorize=req=>{
    const p=new URL(req.url,'http://local').pathname,bearer=String(req.headers.authorization||'').replace(/^Bearer /,'')
    if(bearer&&equalSecret(bearer,mcpToken))return req.method==='GET'&&readOnly(p)?{ok:true,role:'read'}:{ok:false,status:403,error:'该令牌仅允许MCP只读查询'}
    if(process.env.WA_HUB_TOKEN&&bearer&&equalSecret(bearer,process.env.WA_HUB_TOKEN))return{ok:true,role:'admin'}
    const token=cookieToken(req)
    if(!token||!state.sessions.some(s=>s.hash===digest(token)&&s.expires>now()))return{ok:false,status:401,error:'请先登录'}
    if(!originOK(req))return{ok:false,status:403,error:'拒绝跨站请求'}
    if(state.passwordChangeRequired&&!['/api/auth/status','/api/auth/password','/api/auth/logout'].includes(p))return{ok:false,status:403,error:'请先修改初始密码'}
    return{ok:true,role:'admin',user:state.user}
  }
  const throttle=req=>{
    const ip=req.socket.remoteAddress||'local',t=attempts.get(ip)
    if(t&&t.until>now()&&t.count>=10)return false
    if(!t||t.until<=now())attempts.set(ip,{count:1,until:now()+60000});else t.count++
    if(attempts.size>1024)attempts.delete(attempts.keys().next().value)
    return true
  }
  const passwordOK=p=>typeof p==='string'&&p.length>=12&&p.length<=256
  return{enabled:true,setupFile,mcpFile,authorize,async handle(req,res){
    const p=new URL(req.url,'http://local').pathname
    if(p==='/api/auth/status'&&req.method==='GET'){
      const a=authorize(req);send(res,200,{enabled:true,setupRequired:!state.user,initialAccount:!!state.passwordChangeRequired&&state.user==='admin',authenticated:a.ok&&a.role==='admin',...(a.ok?{user:state.user,passwordChangeRequired:!!state.passwordChangeRequired}:{} )});return true
    }
    if(!['/api/auth/setup','/api/auth/login','/api/auth/logout','/api/auth/password'].includes(p))return false
    if(req.method!=='POST'){send(res,405,{error:'只允许POST'});return true}
    if(!originOK(req)){send(res,403,{error:'拒绝跨站请求'});return true}
    if(!throttle(req)){send(res,429,{error:'请求过于频繁，请一分钟后重试'});return true}
    try{
      if(p==='/api/auth/logout'){
        const token=cookieToken(req);state.sessions=state.sessions.filter(s=>s.hash!==digest(token));save();send(res,200,{ok:true},{'Set-Cookie':cookie('',req,0)});return true
      }
      const body=await read(req)
      if(p==='/api/auth/setup'){
        if(state.user){send(res,409,{error:'管理员已初始化'});return true}
        if(typeof body.setupToken!=='string'||!equalSecret(digest(body.setupToken),state.setupHash)){send(res,403,{error:'初始化令牌无效'});return true}
        if(!/^[a-zA-Z0-9_.-]{2,64}$/.test(body.user||'')||!passwordOK(body.password)){send(res,400,{error:'用户名2至64字符；密码至少12字符，最多256字符'});return true}
        const passwordHash=await hash(body.password)
        // Another setup may have completed while scrypt was running.
        if(state.user){send(res,409,{error:'管理员已初始化'});return true}
        state.user=body.user;state.passwordHash=passwordHash;delete state.setupHash;save();try{fs.unlinkSync(setupFile)}catch{}
        send(res,201,{ok:true});return true
      }
      if(p==='/api/auth/password'){
        const a=authorize(req);if(!a.ok){send(res,a.status,{error:a.error});return true}
        if(typeof body.oldPassword!=='string'||body.oldPassword.length>256||!passwordOK(body.password)){send(res,400,{error:'请输入原密码和至少12字符的新密码'});return true}
        const salt=state.passwordHash.split('.')[0]
        if(!equalSecret(await hash(body.oldPassword,salt),state.passwordHash)){send(res,403,{error:'原密码错误'});return true}
        const nextHash=await hash(body.password)
        // Do not let a concurrent password change overwrite a newer credential.
        if(state.passwordHash.split('.')[0]!==salt){send(res,409,{error:'密码已更新，请重新登录'});return true}
        state.passwordHash=nextHash;state.passwordChangeRequired=false;state.sessions=[];save();send(res,200,{ok:true},{'Set-Cookie':cookie('',req,0)});return true
      }
      if(typeof body.password!=='string'||body.password.length>256){send(res,401,{error:'用户名或密码错误'});return true}
      const salt=state.passwordHash?.split('.')[0]||'unconfigured'
      const expected=state.passwordHash,actual=await hash(body.password,salt)
      if(!state.user||expected!==state.passwordHash||body.user!==state.user||!equalSecret(actual,expected)){send(res,401,{error:'用户名或密码错误'});return true}
      const token=random();state.sessions=state.sessions.filter(s=>s.expires>now()).slice(-15);state.sessions.push({hash:digest(token),expires:now()+30*86400000});save()
      send(res,200,{ok:true,user:state.user,passwordChangeRequired:!!state.passwordChangeRequired},{'Set-Cookie':cookie(token,req)});return true
    }catch(e){send(res,400,{error:e.message==='登录服务繁忙，请稍后重试'?e.message:'请求无效，请检查输入'});return true}
  }}
}

export function nodeAuthorized(req,token=process.env.WA_AGENT_TOKEN||''){
  return !token||equalSecret(req.headers.authorization||'',`Bearer ${token}`)
}
