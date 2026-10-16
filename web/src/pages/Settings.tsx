import { useEffect, useState } from 'react'
import { DataLayerPanel } from '../components/DataLayerPanel'
import { ThemePicker } from '../components/ThemePicker'
import { RestartIncidents } from '../components/RestartIncidents'
import { useAppStore } from '../store/store'
import { HiddenProjects } from '../components/HiddenProjects'
import { ServerManager } from '../components/ServerManager'
import { AccountSettings } from '../components/AuthGate'
import { InstallationSettings } from '../components/InstallationSettings'

// 只有约 2GB 内存的两台机（其余机器约 3.6GB）；单会话实测 110~290MB，8 并发就能吃满整机。
// 纯提示，不做硬拦截——运维可能就是要临时冲一下上限，拦死了反而没有出路。
const LOW_RAM_SERVERS = new Set<string>()

function b64ToUint8(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export default function Settings() {
  const source = useAppStore((s) => s.source)
  const servers = useAppStore((s) => s.servers)
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on' | 'denied' | 'busy'>('busy')
  const [subscribers, setSubscribers] = useState<number | null>(null)
  const [msg, setMsg] = useState('')

  // 并发上限：每台机独立的草稿输入 + 保存状态。key = serverId。
  const [gateInputs, setGateInputs] = useState<Record<string, string>>({})
  const [gateBusy, setGateBusy] = useState<Record<string, boolean>>({})
  const [gateMsg, setGateMsg] = useState<Record<string, string>>({})

  const saveMaxSessions = async (serverId: string) => {
    const raw = gateInputs[serverId]
    const n = Number(raw)
    if (raw === undefined || raw === '' || !Number.isFinite(n)) {
      setGateMsg((m) => ({ ...m, [serverId]: '请输入数字' }))
      return
    }
    setGateBusy((b) => ({ ...b, [serverId]: true }))
    setGateMsg((m) => ({ ...m, [serverId]: '' }))
    try {
      const res = await fetch('/api/config/max-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, max: n }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `保存失败（${res.status}）`)
      // 服务端返回的是 clamp 后的生效值——用户输 1000 会被夹到硬天花板，UI 必须跟着显示夹后的值，
      // 不能停留在用户输入的原值（否则用户以为改成了 1000，实际闸门只认 16）。
      setGateInputs((s) => ({ ...s, [serverId]: String(data.max) }))
      setGateMsg((m) => ({ ...m, [serverId]: `已生效：${data.max}` }))
    } catch (e) {
      setGateMsg((m) => ({ ...m, [serverId]: `保存失败：${String((e as Error).message)}` }))
    } finally {
      setGateBusy((b) => ({ ...b, [serverId]: false }))
    }
  }

  const refresh = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setPushState('unsupported'); return }
    if (Notification.permission === 'denied') { setPushState('denied'); return }
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      setPushState(sub ? 'on' : 'off')
      const info = await (await fetch('/api/push/pubkey')).json()
      setSubscribers(info.subscribers ?? null)
    } catch {
      setPushState('off')
    }
  }

  useEffect(() => { void refresh() }, [])

  const enable = async () => {
    setPushState('busy')
    setMsg('')
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') { setPushState(perm === 'denied' ? 'denied' : 'off'); return }
      const reg = await navigator.serviceWorker.ready
      const { key } = await (await fetch('/api/push/pubkey')).json()
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(key) as BufferSource,
      })
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
      if (!res.ok) throw new Error('订阅上报失败')
      setMsg('已开启：审批/提问/验收出现时本机将收到通知')
      await refresh()
    } catch (e) {
      setMsg(`开启失败：${String((e as Error).message)}`)
      setPushState('off')
    }
  }

  const disable = async () => {
    setPushState('busy')
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      void fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      })
      await sub.unsubscribe()
    }
    setMsg('已关闭本设备推送')
    await refresh()
  }

  const test = async () => {
    const r = await (await fetch('/api/push/test', { method: 'POST' })).json()
    setMsg(`测试已发送（${r.sent} 台设备）`)
  }

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <header className="page-head">
        <h1 className="page-head__title">设置</h1>
      </header>

      <ThemePicker />
      <AccountSettings />
      <ServerManager />
      <InstallationSettings />

      <DataLayerPanel />
      <HiddenProjects />
      <RestartIncidents />

      <div className="detail-section">
        <div className="detail-section__label">通知</div>
        <div className="todo-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Web Push 推送</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                待审批/提问/验收时推送到本设备（手机需先「添加到主屏幕」）
                {subscribers != null && ` · 已订阅设备 ${subscribers}`}
              </div>
            </div>
            {pushState === 'unsupported' && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>浏览器不支持</span>}
            {pushState === 'denied' && <span style={{ color: 'var(--st-error)', fontSize: 12 }}>权限被拒，请在浏览器设置开启</span>}
            {pushState === 'off' && <button className="btn btn--primary" onClick={enable}>开启</button>}
            {pushState === 'on' && (
              <>
                <button className="btn btn--ghost btn--sm" onClick={test}>发测试</button>
                <button className="btn btn--danger-outline btn--sm" onClick={disable}>关闭</button>
              </>
            )}
            {pushState === 'busy' && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>…</span>}
          </div>
          {msg && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-2)' }}>{msg}</div>}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section__label">会话并发上限</div>
        <div className="todo-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            每台机器同时能跑的会话数上限。调低<b>不会</b>中断正在跑的会话，只挡住新的排队；调高立即放行排队中的请求。
          </div>
          {servers.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>暂无服务器数据</div>
          )}
          {servers.map((sv, i) => {
            const gate = sv.sessionGate
            const low = LOW_RAM_SERVERS.has(sv.id)
            const draft = gateInputs[sv.id] ?? (gate ? String(gate.max) : '')
            const busy = !!gateBusy[sv.id]
            const rowMsg = gateMsg[sv.id]
            return (
              <div key={sv.id} style={i > 0 ? { borderTop: '1px solid var(--border)', paddingTop: 12 } : undefined}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{sv.name || sv.id}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                      {gate
                        ? `当前使用 ${gate.active}/${gate.max}${gate.queued ? ` · 排队 ${gate.queued}` : ''}`
                        : '该机 agent 尚未上报并发状态（可能待部署新版）'}
                    </div>
                  </div>
                  {gate ? (
                    <>
                      <input
                        className="cat-input"
                        style={{ width: 56, flex: 'none', textAlign: 'center', padding: '8px 6px' }}
                        inputMode="numeric"
                        value={draft}
                        onChange={(e) => setGateInputs((m) => ({ ...m, [sv.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveMaxSessions(sv.id) }}
                      />
                      <button
                        className="btn btn--primary btn--sm"
                        disabled={busy}
                        onClick={() => void saveMaxSessions(sv.id)}
                      >
                        {busy ? '…' : '保存'}
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>不可用</span>
                  )}
                </div>
                {low && (
                  <div style={{ fontSize: 11.5, color: 'var(--st-approval)', marginTop: 6 }}>
                    该机内存约 2GB（其余机器约 3.6GB），单会话占 110~290MB，建议不超过 5
                  </div>
                )}
                {rowMsg && (
                  <div
                    style={{
                      fontSize: 12, marginTop: 6,
                      color: rowMsg.startsWith('已生效') ? 'var(--text-2)' : 'var(--st-error)',
                    }}
                  >
                    {rowMsg}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section__label">关于</div>
        <div className="todo-card detail-kv">
          数据源：<b>{source === 'live' ? '真实 Hub' : '演示数据'}</b>
        </div>
      </div>
    </div>
  )
}
