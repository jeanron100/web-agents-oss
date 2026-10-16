// @vitest-environment jsdom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi} from 'vitest'
import NewSession from './NewSession'
import {useAppStore} from '../store/store'

it('keeps an explicitly requested execution node while an older cached server list refreshes',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const before=useAppStore.getState(),cached={id:'cached-node',name:'Cached server',online:true,region:'',flag:''},requested={...cached,id:'requested-node',name:'Requested server'}
 useAppStore.setState({source:'live',servers:[cached],projectModels:{},templates:[]})
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input)
  return new Response(JSON.stringify(url.includes('/info')?{connected:true,info:{projectRoot:'/srv/requested',container:false,engines:[]}}:url.includes('/projects?')?{projects:[]}:{models:[]}),{status:200,headers:{'Content-Type':'application/json'}})
 });vi.stubGlobal('fetch',fetcher)
 const host=document.createElement('div'),root=createRoot(host)
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/new?server=requested-node']}><NewSession/></MemoryRouter>))
  await act(async()=>useAppStore.setState({servers:[cached,requested]}))
  const urls=fetcher.mock.calls.map(([url])=>String(url))
  expect(urls).toContain('/api/projects?server=requested-node')
  expect(urls.some(url=>url.includes('cached-node'))).toBe(false)
  expect(host.textContent).toContain('/srv/requested')
 }finally{await act(async()=>root.unmount());useAppStore.setState(before,true);vi.unstubAllGlobals()}
})
