import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from 'react-simple-code-editor'
import { highlight } from '../lib/prism'
import { FileImagePreview } from './FileImagePreview'

type FileResp = { path: string; size: number; mtimeMs: number; truncated: boolean; binary: boolean; content: string; imageMime?: string; imageMaxBytes?: number }
type SaveResp = { ok: boolean; error?: string; mtimeMs?: number; size?: number }

export function FileEditor({ sessionId, path, sessionRunning }: { sessionId: string; path: string; sessionRunning?: boolean }) {
  const [st, setSt] = useState<{ loading: boolean; err?: string; meta?: FileResp }>({ loading: true })
  const [text, setText] = useState('')
  const [base, setBase] = useState<{ mtimeMs: number; content: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saved, setSaved] = useState(false)
  const request = useRef<AbortController | null>(null)
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''

  const load = useCallback(() => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setSt({ loading: true }); setConflict(false); setSaved(false)
    fetch(`/api/session/${sessionId}/file?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: FileResp) => { if (!controller.signal.aborted) { setSt({ loading: false, meta: d }); setText(d.content); setBase({ mtimeMs: d.mtimeMs, content: d.content }) } })
      .catch(() => { if (!controller.signal.aborted) setSt({ loading: false, err: '无法打开：文件不存在，或超出本会话目录范围' }) })
  }, [sessionId, path])
  useEffect(() => { load(); return () => request.current?.abort() }, [load])

  const meta = st.meta
  const editable = !!meta && !meta.binary && !meta.truncated
  const dirty = !!base && text !== base.content

  const save = useCallback(async () => {
    if (!editable || !dirty || saving || !base) return
    setSaving(true); setConflict(false)
    try {
      const r = await fetch(`/api/session/${sessionId}/file`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: text, baseMtimeMs: base.mtimeMs }),
      })
      const d: SaveResp = await r.json().catch(() => ({ ok: false }))
      if (r.status === 409 || d.error === 'conflict') { setConflict(true); return }
      if (!r.ok || !d.ok || d.mtimeMs == null) return // 失败或缺 mtime → 保留 dirty 不清
      setBase({ mtimeMs: d.mtimeMs, content: text }); setSaved(true)
    } finally { setSaving(false) }
  }, [editable, dirty, saving, base, sessionId, path, text])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  if (st.loading) return <div className="empty-state">加载中…</div>
  if (st.err) return <div className="empty-state">{st.err}</div>
  if (!meta) return null
  if (meta.imageMime) {
    if (meta.imageMaxBytes && meta.size > meta.imageMaxBytes) return <div className="empty-state">图片超过 {Math.round(meta.imageMaxBytes / 1024 / 1024)}MB，暂不支持在线预览</div>
    return <FileImagePreview key={`${sessionId}/${path}/${meta.mtimeMs}`} sessionId={sessionId} path={path} mtimeMs={meta.mtimeMs} />
  }
  if (meta.binary) return <div className="empty-state">二进制文件，不可编辑</div>
  if (!editable) return (
    <>
      <pre className="fv-pre"><code>{meta.content}</code></pre>
      <div className="fv-trunc">文件超过 200KB，仅只读，不支持在线编辑</div>
    </>
  )

  return (
    <div className="file-editor">
      <div className="file-editor__bar">
        {dirty && <span className="file-editor__dirty" title="未保存改动">●</span>}
        {conflict && <span className="file-editor__conflict">文件已被改动 <button className="btn btn--sm btn--ghost" onClick={load}>重新加载</button></span>}
        {sessionRunning && !conflict && <span className="file-editor__hint">会话运行中</span>}
        <button className="btn btn--sm btn--primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : (saved && !dirty ? '已保存' : '保存')}
        </button>
      </div>
      <Editor
        value={text}
        onValueChange={(v) => { setText(v); setSaved(false) }}
        highlight={(code) => highlight(code, ext)}
        padding={12}
        textareaId={`fe-${sessionId}`}
        className="file-editor__area mono"
      />
    </div>
  )
}
