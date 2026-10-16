// @vitest-environment jsdom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {AuthGate} from './AuthGate'
import {setLanguage} from '../lib/language'

vi.mock('../hub/client',()=>({IS_DEMO:false}))
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})
afterEach(()=>{vi.unstubAllGlobals();setLanguage('zh');localStorage.clear();document.documentElement.removeAttribute('data-theme')})
const input=async(host:HTMLElement,id:string,value:string)=>act(async()=>{const el=host.querySelector<HTMLInputElement>(`#${id}`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})
const submit=async(host:HTMLElement)=>act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
it('first installation explains the initial account and password visibility stays inside the form',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>response({enabled:true,authenticated:false,initialAccount:true})))
  const host=document.createElement('div'),root=createRoot(host)
  try{
    await act(async()=>root.render(<AuthGate>private projects</AuthGate>))
    expect(host.textContent).toContain('admin123');expect(host.textContent).toContain('首次登录后');expect(host.textContent).not.toContain('private projects')
    expect(host.querySelector<HTMLInputElement>('#auth-user')!.value).toBe('admin')
    const toggle=host.querySelector<HTMLButtonElement>('button[aria-label="显示密码"]')!
    await act(async()=>toggle.click());expect(host.querySelector<HTMLInputElement>('#auth-password')!.type).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="切换浅色主题"]')!.click())
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  }finally{await act(async()=>root.unmount())}
})
it('a limited authenticated session cannot expose project UI and mismatched confirmation never reaches the server',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  const fetcher=vi.fn(async()=>response({enabled:true,authenticated:true,passwordChangeRequired:true,user:'admin'}));vi.stubGlobal('fetch',fetcher)
  const host=document.createElement('div'),root=createRoot(host)
  try{
    await act(async()=>root.render(<AuthGate>private projects</AuthGate>))
    expect(host.textContent).toContain('设置你的登录密码');expect(host.textContent).not.toContain('private projects')
    await input(host,'auth-password','my-new-long-password');await input(host,'auth-confirm-password','a-different-password');await submit(host)
    expect(host.querySelector('[role=alert]')?.textContent).toContain('不一致');expect(fetcher).toHaveBeenCalledTimes(1)
  }finally{await act(async()=>root.unmount())}
})
it('saving the first password returns to login and does not grant access with the old session',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);let changed=false
  const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
    if(String(url)==='/api/auth/password'){changed=true;return response({ok:true})}
    return response({enabled:true,authenticated:!changed,passwordChangeRequired:!changed,user:'admin'})
  });vi.stubGlobal('fetch',fetcher)
  const host=document.createElement('div'),root=createRoot(host)
  try{
    await act(async()=>root.render(<AuthGate>private projects</AuthGate>))
    await input(host,'auth-current-password','admin123');await input(host,'auth-password','my-new-long-password');await input(host,'auth-confirm-password','my-new-long-password');await submit(host)
    expect(changed).toBe(true);expect(host.textContent).toContain('密码已更新');expect(host.textContent).toContain('欢迎回来');expect(host.textContent).not.toContain('private projects')
    const call=fetcher.mock.calls.find(args=>String(args[0])==='/api/auth/password')
    expect(call).toBeDefined()
  }finally{await act(async()=>root.unmount())}
})

it('language switching translates sign-in and provider errors without changing credentials',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL)=>String(url)==='/api/auth/login'?response({error:'用户名或密码错误'},401):response({enabled:true,authenticated:false,initialAccount:true})))
  const host=document.createElement('div'),root=createRoot(host)
  try{
    await act(async()=>root.render(<AuthGate>private projects</AuthGate>))
    await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="Switch to English"]')!.click())
    expect(host.textContent).toContain('Welcome back');expect(host.textContent).toContain('Sign in');expect(host.textContent).toContain('admin123')
    expect(host.querySelector('label[for=auth-user]')!.textContent).toBe('Username')
    await input(host,'auth-password','admin123');await submit(host)
    expect(host.querySelector('[role=alert]')!.textContent).toBe('Incorrect username or password.')
    expect(host.querySelector<HTMLInputElement>('#auth-user')!.value).toBe('admin');expect(host.querySelector<HTMLInputElement>('#auth-password')!.value).toBe('admin123')
    expect(localStorage.getItem('agent-console-language')).toBe('en')
    await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="切换为中文"]')!.click())
    expect(host.textContent).toContain('欢迎回来');expect(host.querySelector('[role=alert]')!.textContent).toBe('用户名或密码错误')
  }finally{await act(async()=>root.unmount())}
})
