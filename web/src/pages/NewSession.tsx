import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useLanguage } from '../lib/language'
import type { Engine, PermissionMode } from '../types'
import { useAppStore, projectPreferredModel } from '../store/store'
import { CLAUDE_MODELS, KIMI_MODELS } from '../lib/models'
import { gateSaturation } from '../lib/gate'

export default function NewSession() {
  const navigate = useNavigate()
  const [params]=useSearchParams()
  const [language]=useLanguage()
  const t=(zh:string,en:string)=>language==='en'?en:zh
  const servers = useAppStore((s) => s.servers)
  const source = useAppStore((s) => s.source)
  const projectModels = useAppStore((s) => s.projectModels)

  const [serverId, setServerId] = useState(params.get('server')||'')
  const [projects, setProjects] = useState<Array<{ name: string; cwd: string }>>([])
  const [cwd, setCwd] = useState('')
  const [projectsLoading,setProjectsLoading]=useState(false),[projectsError,setProjectsError]=useState(''),[revision,setRevision]=useState(0)
  const [nodeInfo,setNodeInfo]=useState<{projectRoot:string;container:boolean;engines:Array<{engine:string;installed:boolean;credentialPresent:boolean;loginCommand:string}>}|null>(null)
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
    // Honor an explicitly requested node even while the cached server list is stale.
    if (!serverId && servers.length > 0) setServerId(servers.find(s=>s.online&&s.id!=='local-runner')?.id ?? servers.find(s=>s.online)?.id ?? servers[0].id)
  }, [servers, serverId])

  useEffect(() => {
    if (!serverId) return
    let alive=true
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000)
    setProjects([]);setCwd('');setNodeInfo(null);setProjectsError('');setProjectsLoading(true)
    const get=async(url:string)=>{const r=await fetch(url,{signal:controller.signal});const d=await r.json();if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d}
    const listing=get(`/api/projects?server=${encodeURIComponent(serverId)}`).then(d=>{
      if(!alive)return
      if(!Array.isArray(d.projects))throw new Error(t('项目列表返回无效，请重新检测节点。','The project list was invalid. Check the node again.'))
      setProjects(d.projects)
    }).catch(error=>{if(alive)setProjectsError(error.name==='AbortError'?t('读取超时，请检查节点连接后重试。','The request timed out. Check the node and retry.'):String(error.message||error))}).finally(()=>{if(alive)setProjectsLoading(false)})
    const diagnostic=get(`/api/servers/${encodeURIComponent(serverId)}/info`).then(d=>{if(alive&&d.connected&&d.info)setNodeInfo(d.info)}).catch(()=>{/* Older nodes may not provide diagnostics; project selection remains available. */})
    void Promise.allSettled([listing,diagnostic]).finally(()=>clearTimeout(timer))
    return()=>{alive=false;controller.abort();clearTimeout(timer)}
  }, [serverId,revision,language])

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

  const selectedServer=servers.find(s=>s.id===serverId)
  const selectedCli=nodeInfo?.engines.find(e=>e.engine===engine)
  const ready=!!selectedServer?.online&&selectedCli?.installed!==false

  const submit = async () => {
    if (!ready || !cwd || !prompt.trim() || submitting) return
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

      <div className="todo-card setup-server-help"><p>{t('先选择执行节点，再选择该节点上的项目目录。代码与 CLI 在所选节点运行。','Choose an execution node, then a project folder on that node. Code and the CLI run on the selected node.')}</p><Link to="/getting-started">{t('首次使用？连接远程服务器与准备项目 →','First time? Connect a remote server and prepare a project →')}</Link></div>
      <div className="detail-section">
        <div className="detail-section__label">{t('执行节点','Execution node')}</div>
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
        {serverId&&!selectedServer&&servers.length>0&&<p className="dl-hint">{t('所选节点尚未出现在当前列表，请等待刷新或到设置中检查连接；不会自动改用其他节点。','The requested node is not in the current list yet. Wait for refresh or check its connection in settings; another node will not be substituted.')}</p>}
        {!servers.length&&<p className="dl-hint">{t('还没有执行节点。先在设置中添加远程服务器，再创建会话。','No execution node is configured. Add a remote server in settings first.')} <Link to="/settings?add=remote#servers">{t('连接服务器','Connect a server')}</Link></p>}
        <p className="dl-hint">{t('要管理其他服务器？','Manage another server?')} <Link to="/settings?add=remote#servers">{t('添加远程服务器','Add a remote server')}</Link></p>
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
        <label className="detail-section__label" htmlFor="new-session-project">{t('项目目录','Project folder')}</label>
        <p className="dl-hint">{nodeInfo?<>{t('读取位置：','Location: ')}{selectedServer?.name} · <code>{nodeInfo.projectRoot}</code> · {nodeInfo.container?t('容器内目录，宿主机文件需挂载后才能访问','Container folder; host files must be mounted first'):t('远程节点上的目录','Folder on the execution node')}</>:t('这里列出所选执行节点上的目录，不是浏览器或管控台电脑上的目录。','These are folders on the selected execution node, not on the browser or console computer.')}</p>
        <select
          id="new-session-project"
          disabled={!serverId||projectsLoading||!projects.length}
          className="composer__input"
          style={{ width: '100%', minHeight: 42 }}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        >
          <option value="">{projectsLoading?t('正在读取项目目录…','Loading project folders…'):!projects.length?t('尚无可选项目目录','No project folders available'):t('选择项目目录…','Choose a project folder…')}</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>{p.name}</option>
          ))}
        </select>
        {cwd&&<p className="dl-hint"><code>{cwd}</code></p>}
        {projectsError&&<p className="risk-note" role="alert">{t('未能读取项目目录：','Could not read project folders: ')}{projectsError}</p>}
        {serverId&&!projectsLoading&&!projectsError&&!projects.length&&<div className="todo-card"><b>{t('节点已选择，但还没有找到项目','A node is selected, but no projects were found')}</b><p>{t('在该执行节点的项目根目录下准备仓库或创建一个项目子目录，然后刷新。每个一级子目录会显示为一个项目。','Prepare a repository or create a project subfolder under the node’s project root, then refresh. Each immediate subfolder appears as a project.')}</p>{nodeInfo?.container&&<p>{t('本机容器的工作区默认是空的；Mac / Windows 上已有文件不会自动出现在容器里。可先用本地容器体验指南创建示例项目，或连接存放现有代码的远程服务器。','A new local container starts with an empty workspace. Existing Mac / Windows files do not appear there automatically. Follow the local guide to create an example project, or connect the remote server holding your code.')}</p>}<Link to={nodeInfo?.container?'/getting-started?mode=local':'/getting-started'}>{t('查看项目准备步骤 →','See project preparation steps →')}</Link></div>}
        {serverId&&<button className="btn btn--sm" disabled={projectsLoading} onClick={()=>setRevision(v=>v+1)}>{t('刷新项目目录','Refresh project folders')}</button>}
        {selectedCli&&<p className="dl-hint">{selectedCli.installed?(selectedCli.credentialPresent?t('CLI 已安装并发现凭据；登录是否有效需用一次真实对话确认。','CLI installed and credentials found. Verify login with a real conversation.'):t('CLI 已安装，尚未确认登录。请在执行节点终端运行：','CLI installed; login not confirmed. Run this on the execution node: ')):t('该节点尚未安装所选 CLI，请先安装并登录后重试。','The selected CLI is not installed on this node. Install it and sign in first.')} {selectedCli.installed&&!selectedCli.credentialPresent&&<code>{selectedCli.loginCommand}</code>}</p>}
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
        <button className="btn btn--block btn--primary" disabled={!ready || !cwd || !prompt.trim() || submitting} onClick={submit}>
          {submitting ? '正在创建…' : '创建会话'}
        </button>
      </div>
    </div>
  )
}
