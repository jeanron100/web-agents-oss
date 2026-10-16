import {useSyncExternalStore} from 'react'

export type Language='zh'|'en'
const key='agent-console-language'
function initialLanguage():Language{
  try{
    const requested=new URLSearchParams(location.search).get('lang'),saved=localStorage.getItem(key)
    if(requested==='en'||requested==='zh')return requested
    if(saved==='en'||saved==='zh')return saved
  }catch{/* Storage may be unavailable. */}
  return typeof document!=='undefined'&&document.documentElement.lang.startsWith('en')?'en':'zh'
}
let language=initialLanguage()
const listeners=new Set<()=>void>()
export const getLanguage=()=>language
export function setLanguage(next:Language){
  language=next
  try{localStorage.setItem(key,next)}catch{/* Private browsing. */}
  if(typeof document!=='undefined')document.documentElement.lang=next==='en'?'en':'zh-CN'
  for(const notify of listeners)notify()
}
export function useLanguage(){
  const value=useSyncExternalStore(notify=>{listeners.add(notify);return()=>{listeners.delete(notify)}},getLanguage,()=> 'zh' as Language)
  return [value,setLanguage] as const
}
const english:Record<string,string>={
  '隐藏':'Hide ', '显示':'Show ',
  '无法连接认证服务':'Unable to connect to the authentication service.',
  '认证服务返回无效数据':'The authentication service returned an invalid response.',
  '连接控制台失败，请检查服务状态后重试。':'Unable to connect. Check the console service and try again.',
  '两次输入的新密码不一致。':'The new passwords do not match.',
  '登录失败':'Sign-in failed.',
  '密码已更新，请使用新密码登录。':'Password updated. Sign in with your new password.',
  '管理员已创建，请使用刚才设置的密码登录。':'Administrator created. Sign in with the password you just set.',
  '连接超时，请稍后重试。':'The connection timed out. Please try again.',
  '多服务器 AI 编码代理管控台':'Coding agents across your servers',
  '切换深色主题':'Switch to dark theme', '切换浅色主题':'Switch to light theme',
  '连接控制台':'Connect to your console', '设置你的登录密码':'Set your own password',
  '初始化管理员':'Create an administrator', '欢迎回来':'Welcome back',
  '初始密码仅用于首次登录。设置新密码后，即可进入控制台。':'The temporary password is for initial access only. Set a new password to continue.',
  '创建一个管理员账户，开始管理你的项目。':'Create an administrator account to start managing your projects.',
  '登录后，继续查看项目进展和处理待办。':'Sign in to follow project progress and handle pending work.',
  '正在连接控制台…':'Connecting to your console…', '重试连接':'Try again',
  '从控制台服务器获取一次性初始化令牌。容器安装可运行：':'Get the one-time setup token from your console server. For a container installation, run:',
  '初始化令牌':'Setup token', '当前账户':'Account', '当前密码':'Current password',
  '用户名':'Username', '新密码':'New password', '密码':'Password',
  '至少 12 个字符，建议使用多个单词或密码管理器生成。':'Use at least 12 characters. Consider a passphrase or a password manager.',
  '确认新密码':'Confirm new password', '处理中…':'Please wait…',
  '保存新密码':'Save new password', '创建管理员':'Create administrator', '登录':'Sign in',
  '初始账户':'Initial username', '· 密码':'· Password',
  '首次登录后，请设置自己的密码。':'You must set your own password after the first sign-in.',
  '使用初始化时设置的账户登录。升级安装会保留原账号和密码。':'Use your existing administrator account. Upgrades preserve your username and password.',
  '无法登录？':'Trouble signing in?',
  '忘记密码时，在安装目录的终端中重置临时密码，再仅重启控制台：':'If you forgot your password, open a terminal in the installation directory, reset the temporary password and restart only the console:',
  '原用户名保留，临时密码为 admin123，登录后需重新设密；远程 CLI 不受此控制台重启影响。':'Your username is preserved. The temporary password is admin123; set a new one after signing in. Remote CLIs are not stopped by this console restart.',
  '你的项目与执行进展，统一掌握。':'Your projects and progress, in one place.',
  '账户':'Account', '当前用户：':'Signed in as:', '退出登录':'Sign out',
  '修改密码':'Change password', '原密码':'Current password',
  '新密码（至少12字符）':'New password (at least 12 characters)', '保存并重新登录':'Save and sign in again',
  '用户名或密码错误':'Incorrect username or password.', '原密码错误':'The current password is incorrect.',
  '初始化令牌无效':'Invalid setup token.', '管理员已初始化':'An administrator has already been created.',
  '用户名2至64字符；密码至少12字符，最多256字符':'Use 2–64 characters for the username and 12–256 for the password.',
  '请输入原密码和至少12字符的新密码':'Enter your current password and a new password of at least 12 characters.',
  '密码已更新，请重新登录':'The password has changed. Sign in again.',
  '登录服务繁忙，请稍后重试':'The sign-in service is busy. Please try again.',
  '请求过于频繁，请一分钟后重试':'Too many attempts. Try again in one minute.',
  '请求无效，请检查输入':'Invalid request. Check your input.',
  '请先修改初始密码':'Change the temporary password first.', '请先登录':'Please sign in.',
}
const chinese=Object.fromEntries(Object.entries(english).map(([zh,en])=>[en.trim(),zh]))
// Only apply to interface copy; CLI transcripts, project data and protocol values
// must remain unchanged. Reverse known translations when switching in-place.
export function tr(value:string):string{
  const trimmed=value.trim(),source=chinese[trimmed]||trimmed
  const translated=language==='en'?english[source]||trimmed:source
  return value.replace(trimmed,translated)
}
