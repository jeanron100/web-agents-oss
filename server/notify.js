// 飞书卡片通知器：检测到新待办时推送，卡片含来源信息 + 深链跳回 Web。
// 配置（任一存在即启用，env 优先）：
//   环境变量 FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
//   或 server/notify-config.json: { "webhook": "...", "baseUrl": "https://webagents.jeanron100.top" }
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {statePath,atomicJson} from './runtime-config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let cfg = {}
const configFile=statePath('notify-config.json',path.join(here,'notify-config.json'))
try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch { /* 可选 */ }

let WEBHOOK = process.env.FEISHU_WEBHOOK || cfg.webhook || ''
let BASE_URL = process.env.AGENT_CONSOLE_URL || process.env.WA_PUBLIC_URL || cfg.baseUrl || ''
let enabled = Boolean(WEBHOOK)
export function notificationSettings(){return{enabled,baseUrl:BASE_URL,hasWebhook:!!WEBHOOK}}
export function updateNotifications(next){
  cfg=next;atomicJson(configFile,cfg);WEBHOOK=process.env.FEISHU_WEBHOOK||cfg.webhook||'';BASE_URL=process.env.AGENT_CONSOLE_URL||process.env.WA_PUBLIC_URL||cfg.baseUrl||'';enabled=!!WEBHOOK
}

import * as redis from './redis.js'

const notified = new Set() // 已推送的 actionId（Redis 不可用时的降级去重；Redis 可用时以 Redis 为准）

const KIND_META = {
  approval: { tag: '🛡 权限审批', color: 'orange' },
  question: { tag: '❓ 提问待答', color: 'blue' },
  plan: { tag: '📋 计划待确认', color: 'purple' },
  review: { tag: '✅ 完成待验收', color: 'green' },
}

function card(action) {
  const meta = KIND_META[action.kind] ?? { tag: '待办', color: 'grey' }
  const link = action.kind === 'approval'
    ? `${BASE_URL}/inbox/${action.id}`
    : `${BASE_URL}/session/${action.sessionId}`
  const detail = String(action.detail ?? '').slice(0, 400)
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**${action.title}**` } },
    { tag: 'div', text: { tag: 'lark_md', content: '```\n' + detail + '\n```' } },
    { tag: 'div', text: { tag: 'lark_md', content: `来源：${action.serverId ?? ''}` } },
    {
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: action.kind === 'approval' ? '去审批' : '去处理' },
        type: 'primary',
        url: link,
      }],
    },
  ]
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: meta.color, title: { tag: 'plain_text', content: meta.tag } },
      elements,
    },
  }
}

async function post(payload) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const body = await res.json().catch(() => ({}))
    if (body.code && body.code !== 0) console.error('[notify] feishu error:', body.code, body.msg)
  } catch (e) {
    console.error('[notify] post failed:', String(e?.message ?? e))
  }
}

/** 由 hub 每次 buildState 后调用：对新出现的 pending 待办推送一次（飞书 + Web Push 双通道）
 *
 *  去重键优先走 Redis（`wa:v2:notify:{actionId}`，TTL 24h）——**这样 Hub 重启后不会把还没消解的
 *  待办重新推一遍**（此前 `notified` 是进程内 Set，一重启就全部重推，用户被反复打扰）。
 *  Redis 不可用时（claimNotify 返回 null）**静默回退**到进程内 Set，行为与改造前完全一致。 */
export async function notifyPending(pendingActions, webPushBroadcast) {
  const liveIds = new Set()
  for (const a of pendingActions) {
    if (a.status !== 'pending') continue
    liveIds.add(a.id)

    // Redis 去重：true=首次可推 / false=已推过（跨重启保持）/ null=Redis 不可用→回退内存 Set
    const fresh = await redis.claimNotify(a.id)
    if (fresh === false) { notified.add(a.id); continue }   // 已推过（可能是上个 Hub 进程推的）
    if (fresh === null) {                                    // 降级：与改造前同行为
      if (notified.has(a.id)) continue
    }
    notified.add(a.id)

    if (enabled) void post(card(a))
    if (webPushBroadcast) {
      const meta = KIND_META[a.kind] ?? { tag: '待办' }
      void webPushBroadcast({
        title: `${meta.tag} · ${a.serverId ?? ''}`,
        body: `${a.title}\n${String(a.detail ?? '').slice(0, 120)}`,
        url: a.kind === 'approval' ? `/inbox/${a.id}` : `/session/${a.sessionId}`,
        tag: a.id,
      })
    }
  }
  // 清理已消解的 id，避免 Set 无限增长
  for (const id of [...notified]) if (!liveIds.has(id)) notified.delete(id)
}

export { enabled as notifyEnabled }
