// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ProgressAssistant } from './ProgressAssistant'

const data = { tasks: [{ id: 't1', serverId: 'srv-178-232', project: 'claude_manager', sessionId: 'native-id', engine: 'codex', title: '120磁盘清理', context: '120磁盘清理', request: '120磁盘清理', result: '已完成清理，当前磁盘90%，可用8.8G。', status: 'reported_complete', updatedAt: 1792062363665, sourceTruncated: true, progress: [{ ts: 1792062363665, text: '已改为7天保留，复制正常。' }], actions: ['df -h'], risks: ['仍为90%高水位'] }], projects: [{ serverId: 'srv-178-232', project: 'claude_manager' }], total: 1, answer: '以下是当时记录', updatedAt: 1792062363665, refreshing: false, coverage: { retainedTasks: 1, archive: { enabled: false }, sources: [{ truncated: true }] } }

it('shows reported outcome, remaining risk, source identity and coverage without claiming fresh verification', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => data })
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div'), root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><ProgressAssistant /></MemoryRouter>))
    expect(host.textContent).toContain('记录报告完成')
    expect(host.textContent).toContain('90%高水位')
    expect(host.textContent).toContain('中心历史采集当前关闭')
    expect(host.textContent).toContain('较早交办可能未覆盖')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/session/native-id')
    expect(host.querySelector('.progress-task details')?.textContent).toContain('df -h')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fetch).toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it('puts the cited answer before collapsed coverage and allows repeating the same question', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...data, answerSections: [{ text: '根因是旧端口，记录报告已恢复。', sources: ['T1'] }], answerSources: [{ id: 'T1', taskId: 't1', label: 'claude_manager', observedAt: 1792062363665 }], analysis: { status: 'done' }, coverage: { ...data.coverage, durable: { tasks: 13500 }, backfill: { total: 13645, imported: 10000 } } }) })
  vi.stubGlobal('fetch', fetch)
  const host = document.createElement('div'), root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><ProgressAssistant /></MemoryRouter>))
    expect(host.querySelector('.progress-assistant__answer')?.textContent).toContain('旧端口')
    expect(host.querySelector('.progress-assistant__citations a')?.getAttribute('href')).toBe('#progress-task-t1')
    const coverage = host.querySelector('details.progress-assistant__coverage') as HTMLDetailsElement
    expect(coverage.open).toBe(false)
    expect(coverage.querySelector('summary')?.textContent).toContain('10000/13645')
    const before = fetch.mock.calls.length
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(fetch.mock.calls.length).toBe(before + 2)
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it('keeps useful evidence visible when model synthesis fails', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...data, analysis: { status: 'error', error: '问答模型暂不可用，已保留检索证据' } }) }))
  const host = document.createElement('div'), root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><ProgressAssistant /></MemoryRouter>))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('已保留检索证据')
    expect(host.querySelector('.progress-task__result')?.textContent).toContain('8.8G')
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it('loads detailed evidence on expansion and retains it when the result is polled again', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const preview={...data,tasks:[{...data.tasks[0],detailsPartial:true,progress:[]}]}
  const full={...data.tasks[0],progress:[{ts:1792062363665,text:'完整处理证据：已校验归档，主从延迟0秒。'}]}
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url:string)=>({ok:true,json:async()=>url.startsWith('/api/assistant/evidence')?{task:full}:preview})))
  const host=document.createElement('div'),root=createRoot(host)
  try{
    await act(async()=>root.render(<MemoryRouter><ProgressAssistant/></MemoryRouter>))
    await act(async()=>{const details=host.querySelector('.progress-task details') as HTMLDetailsElement;details.open=true;details.dispatchEvent(new Event('toggle'))})
    expect(host.textContent).toContain('完整处理证据')
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(host.textContent).toContain('完整处理证据')
  }finally{await act(async()=>root.unmount());vi.unstubAllGlobals()}
})

it('groups repeated historical metadata while retaining each paragraph and its source link', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  const label='历史记录报告（2026/10/15 19:06 北京时间；未重新验证业务状态）：'
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({...data,answerSections:[{text:label+'\n已改为7天保留。',sources:['T1']},{text:label+'\n磁盘仍为90%。',sources:['T1']}],answerSources:[{id:'T1',taskId:'t1',label:'来源 claude_manager',observedAt:1792062363665}]})}))
  const host=document.createElement('div'),root=createRoot(host)
  try{
    await act(async()=>root.render(<MemoryRouter><ProgressAssistant/></MemoryRouter>))
    expect(host.querySelectorAll('.progress-assistant__metadata').length).toBe(1)
    expect(host.querySelectorAll('.progress-assistant__citations a').length).toBe(2)
    expect(host.textContent).toContain('已改为7天保留');expect(host.textContent).toContain('磁盘仍为90%')
  }finally{await act(async()=>root.unmount());vi.unstubAllGlobals()}
})

it('no evidence and transport errors are visible rather than a fabricated completion', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('节点暂不可达')))
  const host = document.createElement('div'), root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><ProgressAssistant /></MemoryRouter>))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('节点暂不可达')
    expect(host.querySelectorAll('.progress-task').length).toBe(0)
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})


it('shows gateway model, stage usage and ignored-parameter notices even when synthesis failed', async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const usage={inputTokens:1200,outputTokens:0,totalTokens:null,cachedInputTokens:null,cacheCreationTokens:null,reasoningTokens:null}
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({...data,analysis:{status:'error',error:'回答无效，已保留证据',modelCalls:[{stage:'plan',observedAt:1,requestedModel:'auto',actualModel:'actual-model',provider:'codex',requestId:'req-1',usage,warnings:[{parameter:'max_tokens',policy:'IGNORED_WITH_WARNING',detail:'max_tokens was ignored'}]},{stage:'answer',observedAt:2,requestedModel:'auto',actualModel:null,provider:null,requestId:null,usage:{...usage,inputTokens:null,outputTokens:null},warnings:[]}]}})}))
 const host=document.createElement('div'),root=createRoot(host)
 try{
  await act(async()=>root.render(<MemoryRouter><ProgressAssistant/></MemoryRouter>))
  const info=host.querySelector('[aria-label="问答模型调用"]')!
  expect(info.textContent).toContain('actual-model');expect(info.textContent).toContain('输入 1,200');expect(info.textContent).toContain('输出 0');expect(info.textContent).toContain('合计 未返回')
  expect(info.querySelector('[role="note"]')?.textContent).toContain('max_tokens · 已忽略')
  expect(info.querySelectorAll('article').length).toBe(2)
  expect(host.querySelector('.progress-task__result')?.textContent).toContain('8.8G')
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals()}
})
