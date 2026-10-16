// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileEditor } from './FileEditor'

let root: Root, host: HTMLDivElement
const meta = { path: '二维码.png', size: 300000, mtimeMs: 1, truncated: true, binary: true, content: '', imageMime: 'image/png', imageMaxBytes: 20971520 }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function open(data = meta) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }))
  await act(async () => root.render(<FileEditor sessionId="session-test" path="logs/二维码.png" />))
}
describe('project image file preview', () => {
  it('loads original image after opening even when larger than text limit, without editable controls', async () => {
    await open()
    const img = host.querySelector('img')!
    expect(img.getAttribute('src')).toContain('/api/session/session-test/file-image?path=logs%2F%E4%BA%8C%E7%BB%B4%E7%A0%81.png')
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.textContent).not.toContain('二进制文件')
    expect(host.querySelector('a[download]')?.getAttribute('download')).toBe('二维码.png')
  })
  it('shows dimensions and zoom controls after load; fitting resets explicit zoom', async () => {
    await open()
    const img = host.querySelector('img')!
    Object.defineProperties(img, { naturalWidth: { value: 600 }, naturalHeight: { value: 400 } })
    img.getBoundingClientRect = () => ({ width: 300 }) as DOMRect
    await act(async () => img.dispatchEvent(new Event('load')))
    expect(host.textContent).toContain('600 × 400')
    await act(async () => (host.querySelector('[aria-label="放大图片"]') as HTMLButtonElement).click())
    expect(img.style.width).toBe('375px')
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '适应窗口')!.click())
    expect(img.style.maxWidth).toBe('100%')
  })
  it('failed images show a retry action with a fresh URL', async () => {
    await open()
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('图片无法加载')
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '重试')!.click())
    expect(host.querySelector('img')!.getAttribute('src')).toContain('retry=1')
  })
  it('oversized images do not start an image request', async () => {
    await open({ ...meta, size: 20971521 })
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('图片超过 20MB')
  })
  it('non-image binary keeps its existing read-only fallback', async () => {
    await open({ ...meta, imageMime: undefined } as unknown as typeof meta)
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('二进制文件，不可编辑')
  })
  it('closing the preview aborts the metadata request', async () => {
    const pending = vi.fn((_url: string, _init: RequestInit) => new Promise(() => {}))
    vi.stubGlobal('fetch', pending)
    await act(async () => root.render(<FileEditor sessionId="session-test" path="a.png" />))
    const signal = pending.mock.calls[0][1].signal!
    expect(signal.aborted).toBe(false)
    await act(async () => root.render(null))
    expect(signal.aborted).toBe(true)
  })
})
