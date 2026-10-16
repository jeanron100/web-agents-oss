// Explicit container-only policy: Docker supplies the boundary. Native nodes stay workspace-write.
export function externalSandboxEnabled(env=process.env,inContainer=false){
  if(env.WA_CODEX_EXTERNAL_SANDBOX!=='1')return false
  if(env.WA_CONTAINER_RUNNER!=='1'||!inContainer)throw new Error('外部沙箱只适用于显式配置的容器执行节点')
  return true
}
export const sandboxPolicy=(original,external)=>external?{type:'externalSandbox',networkAccess:'enabled'}:original
