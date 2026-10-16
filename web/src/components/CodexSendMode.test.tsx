// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CodexSendMode } from './CodexSendMode'

it('default supplementation and explicitly chosen queued task expose distinct accessible states', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'), root = createRoot(host), changed = vi.fn()
  try {
    await act(async () => root.render(<CodexSendMode value="steer" onChange={changed} />))
    const [steer, queue] = host.querySelectorAll('button')
    expect(steer.getAttribute('aria-pressed')).toBe('true')
    expect(queue.getAttribute('aria-pressed')).toBe('false')
    expect(host.textContent).toContain('运行中追加到当前任务')
    await act(async () => queue.click())
    expect(changed).toHaveBeenCalledWith('queue')
    await act(async () => root.render(<CodexSendMode value="queue" onChange={changed} />))
    expect(host.textContent).toContain('当前任务结束后处理')
    expect(queue.getAttribute('aria-pressed')).toBe('true')
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})
