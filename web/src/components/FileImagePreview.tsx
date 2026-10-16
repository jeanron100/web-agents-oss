import { useRef, useState } from 'react'

export function FileImagePreview({ sessionId, path, mtimeMs }: { sessionId: string; path: string; mtimeMs: number }) {
  const image = useRef<HTMLImageElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [scale, setScale] = useState<number | null>(null)
  const [retry, setRetry] = useState(0)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const src = `/api/session/${sessionId}/file-image?path=${encodeURIComponent(path)}&v=${mtimeMs}&retry=${retry}`
  const zoom = (factor: number) => {
    const fit = image.current ? image.current.getBoundingClientRect().width / image.current.naturalWidth : 1
    setScale(Math.max(0.1, Math.min(4, (scale ?? fit) * factor)))
  }
  return <div className="file-image">
    <div className="file-image__bar">
      <span className="file-image__dimensions">{status === 'ready' ? `${dimensions.width} × ${dimensions.height}` : '图片预览'}</span>
      <button className="btn btn--sm btn--ghost" disabled={status !== 'ready'} onClick={() => zoom(1 / 1.25)} aria-label="缩小图片">−</button>
      <button className="btn btn--sm btn--ghost" disabled={status !== 'ready'} onClick={() => zoom(1.25)} aria-label="放大图片">＋</button>
      <button className="btn btn--sm btn--ghost" disabled={status !== 'ready'} onClick={() => setScale(null)}>适应窗口</button>
      <a className="btn btn--sm btn--ghost" href={src} target="_blank" rel="noopener noreferrer">查看原图</a>
      <a className="btn btn--sm btn--ghost" href={src} download={path.split('/').pop()}>下载</a>
    </div>
    {status === 'loading' && <div className="empty-state" role="status">图片加载中…</div>}
    {status === 'error' && <div className="empty-state" role="alert">图片无法加载，文件可能已移动或格式不受支持。<button className="btn btn--sm btn--ghost" onClick={() => { setStatus('loading'); setRetry(n => n + 1) }}>重试</button></div>}
    <div className="file-image__canvas" hidden={status !== 'ready'}>
      <img ref={image} src={src} alt={path.split('/').pop() || path}
        style={scale == null ? { maxWidth: '100%', width: 'auto' } : { maxWidth: 'none', width: dimensions.width * scale }}
        onLoad={e => { setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); setStatus('ready') }}
        onError={() => setStatus('error')} />
    </div>
  </div>
}
