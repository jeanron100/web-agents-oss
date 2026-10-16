import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Engine, PermissionMode } from '../types'
import { useAppStore, projectPreferredModel } from '../store/store'
import { CLAUDE_MODELS, KIMI_MODELS } from '../lib/models'
import { gateSaturation } from '../lib/gate'

export default function NewSession() {
  const navigate = useNavigate()
  const servers = useAppStore((s) => s.servers)
  const source = useAppStore((s) => s.source)
  const projectModels = useAppStore((s) => s.projectModels)

  const [serverId, setServerId] = useState('')
  const [projects, setProjects] = useState<Array<{ name: string; cwd: string }>>([])
  const [cwd, setCwd] = useState('')
  const [engine, setEngine] = useState<Engine>('codex')
  const [mode, setMode] = useState<PermissionMode>('auto')
  const [model, setModel] = useState('')
  // 可切的 Codex 模型（按所选服务器取——各机 codex 版本不同、模型集不同）
  const [codexModels, setCodexModels] = useState<Array<{ id: string; displayName: string; isDefault: boolean }>>([])
  const [prompt, setPrompt] = useState('')
  const templates = useAppStore((s) => s.templates)
  const addTemplate = useAppStore((s) => s.addTemplate)
  const removeTemplate = useAppStore((s) => s.removeTemplate)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!serverId && servers.length > 0) setServerId(servers.find((s) => s.online)?.id ?? servers[0].id)
  }, [servers, serverId])

  useEffect(() => {
    if (!serverId) return
    setProjects([])
    setCwd('')
    fetch(`/api/projects?server=${encodeURIComponent(serverId)}`)
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]))
  }, [serverId])

  // Codex 可选模型：**按服务器取**（各机 codex 版本不同、模型集不同：232 有 gpt-5.6-sol，
  // 老机只到 gpt-5.3-codex）。换服务器要重取，否则会给出目标机没有的模型。
  useEffect(() => {
    if (!serverId) { setCodexModels([]); return }
    let alive = true
    fetch(`/api/usage/codex-models?server=${encodeURIComponent(serverId)}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setCodexModels(Array.isArray(d?.models) ? d.models : []) })
      .catch(() => { if (alive) setCodexModels([]) })
    return () => { alive = false }
  }, [serverId])

  // 换引擎/换服务器时清掉已选模型——三种引擎的模型 id 不能串用。
  useEffect(() => { setModel('') }, [engine, serverId])

  const prefilledFor = useRef('')
  useEffect(() => {
    if (!cwd || !serverId || engine !== 'claude') return
    const project = cwd.split('/').filter(Boolean).pop() ?? ''
    const key = `${serverId}/${project}`
    if (prefilledFor.current === key) return            // 该项目已预填过 → 不再覆盖用户手动选择
    const pref = projectPreferredModel(projectModels, serverId, project)
    if (pref) { setModel(pref); prefilledFor.current = key }
  }, [cwd, serverId, engine, projectModels])

  const submit = async () => {
    if (!cwd || !prompt.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, cwd, engine, mode, prompt: prompt.trim(), ...(model ? { model } : {}) }),
      })
      const data = await res.json()
      if (!res.ok || !data.id) throw new Error(data.error ?? '创建失败')
      navigate(`/session/${data.id}`, { replace: true })
    } catch (e) {
      setError(String((e as Error).message))
      setSubmitting(false)
    }
  }

  if (source !== 'live') {
    return (
      <div className="page">
        <header className="page-head">
          <button className="icon-btn" onClick={() => navigate(-1)}>←</button>
          <h1 className="page-head__title">新建会话</h1>
        </header>
        <div className="empty-state">演示模式下不可新建会话（Hub 未连接）</div>
      </div>
    )
  }

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <header className="page-head">
        <button className="icon-btn" onClick={() => navigate(-1)}>←</button>
        <h1 className="page-head__title">新建会话</h1>
      </header>

      <div className="detail-section">
        <div className="detail-section__label">服务器</div>
        <div className="quick-chips">
          {servers.map((sv) => {
            const gate = gateSaturation(sv.sessionGate)
            return (
              <button
                key={sv.id}
                className="quick-chip"
                style={serverId === sv.id ? { borderColor: 'var(--accent)', color: 'var(--text)' } : {}}
                disabled={!sv.online}
                onClick={() => setServerId(sv.id)}
                title={gate.label || undefined}
              >
                {sv.name}{sv.online ? '' : '（离线）'}
                {gate.full && <span style={{ color: 'var(--st-approval)', marginLeft: 4 }}>·满</span>}
              </button>
            )
          })}
        </div>
        {/* 闸门满是「新建会话超时」最常见的真因。说出来，用户才知道是等一下还是去释放几个会话。 */}
        {(() => {
          const g = gateSaturation(servers.find((s) => s.id === serverId)?.sessionGate)
          if (!g.full) return null
          return (
            <div className="dl-hint" style={{ color: 'var(--st-approval)' }}>
              该服务器{g.label}。新建会话会先排队；若久等不下来，可到会话列表释放几个空闲会话再试。
            </div>
          )
        })()}
      </div>

      <div className="detail-section">
        <div className="detail-section__label">引擎</div>
        <div className="quick-chips">
          {([['codex', 'Codex'], ['kimi', 'Kimi'], ['claude', 'Claude']] as Array<[Engine, string]>).map(([e, label]) => (
            <button
              key={e}
              className="quick-chip"
              style={engine === e ? { borderColor: `var(--engine-${e})`, color: 'var(--text)' } : {}}
              onClick={() => setEngine(e)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section__label">项目（/data）</div>
        <select
          className="composer__input"
          style={{ width: '100%', minHeight: 42 }}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        >
          <option value="">选择项目目录…</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="detail-section">
        <div className="detail-section__label">权限模式</div>
        <div className="quick-chips">
          {(['default', 'plan', 'acceptEdits', 'auto'] as PermissionMode[]).map((m) => (
            <button
              key={m}
              className="quick-chip"
              style={mode === m ? { borderColor: 'var(--accent)', color: 'var(--text)' } : {}}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {engine === 'claude' && (
        <div className="detail-section">
          <div className="detail-section__label">模型</div>
          <div className="quick-chips">
            {[{ id: '', label: '默认' }, ...CLAUDE_MODELS].map((m) => (
              <button
                key={m.id}
                className="quick-chip"
                style={model === m.id ? { borderColor: 'var(--accent)', color: 'var(--text)' } : {}}
                onClick={() => setModel(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 「默认」沿用目标服务器返回的 isDefault 模型，不硬编码型号。 */}
      {engine === 'codex' && codexModels.length > 0 && (
        <div className="detail-section">
          <div className="detail-section__label">模型</div>
          <div className="quick-chips">
            {[{ id: '', displayName: `默认（${codexModels.find((m) => m.isDefault)?.displayName ?? '最新'}）`, isDefault: false }, ...codexModels].map((m) => (
              <button
                key={m.id}
                className="quick-chip"
                style={model === m.id ? { borderColor: 'var(--engine-codex)', color: 'var(--text)' } : {}}
                onClick={() => setModel(m.id)}
              >
                {m.displayName}
              </button>
            ))}
          </div>
        </div>
      )}

      {engine === 'kimi' && (
        <div className="detail-section">
          <div className="detail-section__label">模型</div>
          <div className="quick-chips">
            {[{ id: '', label: '默认', description: '使用 Kimi Code CLI 当前默认模型' }, ...KIMI_MODELS].map((m) => (
              <button
                key={m.id}
                className="quick-chip"
                style={model === m.id ? { borderColor: 'var(--engine-kimi)', color: 'var(--text)' } : {}}
                onClick={() => setModel(m.id)}
                title={m.description}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="dl-hint">
            使用目标服务器上的 Kimi Code OAuth 登录态，不需要 API Key。未登录时请在该服务器执行 <span className="mono">kimi login</span>。
          </div>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section__label">模板</div>
        <div className="quick-chips">
          {templates.map((t) => (
            <span key={t.id} className="quick-chip tpl-chip" role="button"
              onClick={() => {
                setPrompt(t.prompt)
                if (t.mode) setMode(t.mode)
                // 旧模板可能保存了 Claude 模型，不能带入默认的 Codex 会话。
                const compatible = t.model && (engine === 'claude' ? t.model.startsWith('claude-')
                  : engine === 'kimi' ? KIMI_MODELS.some(m => m.id === t.model || `kimi-code/${m.id}` === t.model)
                  : codexModels.some(m => m.id === t.model))
                setModel(compatible ? t.model! : '')
              }}
            >
              {t.name}
              <button className="tpl-chip__x" title="删除模板" onClick={(e) => { e.stopPropagation(); removeTemplate(t.id) }}>×</button>
            </span>
          ))}
          <button
            className="quick-chip"
            style={{ borderStyle: 'dashed' }}
            disabled={!prompt.trim()}
            onClick={() => {
              const name = window.prompt('模板名称：', prompt.trim().slice(0, 12))
              if (name) addTemplate({ name, prompt: prompt.trim(), mode, model: model || undefined })
            }}
          >
            ＋ 存为模板
          </button>
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section__label">首条指令</div>
        <textarea
          className="composer__input"
          style={{ width: '100%', minHeight: 110 }}
          placeholder="要做什么？例如：检查项目测试是否全部通过，修复失败用例"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      {error && <div className="risk-note" style={{ marginTop: 12 }}>{error}</div>}

      <div className="approval-actions">
        <button className="btn btn--block btn--primary" disabled={!cwd || !prompt.trim() || submitting} onClick={submit}>
          {submitting ? '正在创建…' : '创建会话'}
        </button>
      </div>
    </div>
  )
}
