// @vitest-environment jsdom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {it,expect,vi} from 'vitest'
vi.mock('../hub/client',()=>({IS_DEMO:false,refreshNow:vi.fn(async()=>{})}))
import {AuthGate} from './AuthGate'
import {ServerManager} from './ServerManager'
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
it('a failed authentication service keeps project UI inaccessible and offers retry',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline')}))
 const host=document.createElement('div'),root=createRoot(host)
 try{await act(async()=>root.render(<AuthGate><p>private projects</p></AuthGate>));expect(host.textContent).not.toContain('private projects');expect(host.textContent).toContain('连接控制台失败');expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='重试连接')).toBe(true)}
 finally{await act(async()=>root.unmount());vi.unstubAllGlobals()}
})
it('authenticated project UI closes when an API session expires',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>String(input)==='/api/auth/status'?response({enabled:true,authenticated:true,user:'operator'}):response({error:'expired'},401)))
 const host=document.createElement('div'),root=createRoot(host)
 try{await act(async()=>root.render(<AuthGate><p>private projects</p></AuthGate>));expect(host.textContent).toContain('private projects');await act(async()=>{await window.fetch('/api/state')});expect(host.textContent).not.toContain('private projects');expect(host.textContent).toContain('登录')}
 finally{await act(async()=>root.unmount());vi.unstubAllGlobals()}
})
it('node management explains an empty install and keeps existing tokens out of the edit form',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);let nodes:unknown[]=[]
 vi.stubGlobal('fetch',vi.fn(async()=>response({agents:nodes})))
 const host=document.createElement('div'),root=createRoot(host)
 try{
  await act(async()=>root.render(<ServerManager/>));expect(host.textContent).toContain('接入第一台执行节点')
  await act(async()=>root.unmount());const next=createRoot(host)
  nodes=[{id:'n1',name:'remote',url:'http://runner:8788',hasToken:true,enabled:true,transport:'direct'}]
  await act(async()=>next.render(<ServerManager/>));await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='编辑')!.click())
  expect((host.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');expect(host.textContent).toContain('编辑服务器');await act(async()=>next.unmount())
 }finally{vi.unstubAllGlobals()}
})
