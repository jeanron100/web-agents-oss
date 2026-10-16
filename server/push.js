// Web Push：VAPID 密钥自动生成持久化，订阅存盘，向全部订阅广播。
// 密钥与订阅文件均不入库（.gitignore）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import webpush from 'web-push'
import { statePath, atomicJson } from './runtime-config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const KEYS_FILE = statePath('push-keys.json',path.join(here, 'push-keys.json'))
const SUBS_FILE = statePath('push-subs.json',path.join(here, 'push-subs.json'))

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
const saveJson = atomicJson

let keys = loadJson(KEYS_FILE, null)
if (!keys) {
  keys = webpush.generateVAPIDKeys()
  saveJson(KEYS_FILE, keys)
}
webpush.setVapidDetails('mailto:admin@example.com', keys.publicKey, keys.privateKey)

let subs = loadJson(SUBS_FILE, [])

export const publicKey = keys.publicKey

export function subscribe(subscription) {
  if (!subscription?.endpoint) return false
  subs = subs.filter((s) => s.endpoint !== subscription.endpoint)
  subs.push(subscription)
  saveJson(SUBS_FILE, subs)
  return true
}

export function unsubscribe(endpoint) {
  subs = subs.filter((s) => s.endpoint !== endpoint)
  saveJson(SUBS_FILE, subs)
}

export function subscriberCount() {
  return subs.length
}

/**
 * 广播一条推送；失效订阅（404/410）自动清理。
 *
 * 可观测性（Fix 3，2026-07-20 诊断 §4）：过去三条分支里两条完全没有日志——成功 (`sent++`)
 * 和 404/410 自动退订——只有"既失败又不是 404/410"才打一行 `console.error`。调用处又是
 * `void push.broadcast(...).catch(() => {})`，连返回的 `sent` 都没看。结果是：「这次告警的
 * 推送到底发出去没有」这件事，"从未调用" / "静默退订" / "确实送达" 三种情况在日志里长得
 * 一模一样（全是零输出），完全无法区分。现在无论哪条分支都汇总进一行日志，不管成功/失败/
 * 退订都能看见发生过什么、发给了几个订阅者、丢了几个失效订阅——但只记这些计数和耗时，
 * 绝不记 payload 正文（可能带会话内容，见文件头注释）。
 *
 * 注意语义边界：`webpush.sendNotification` resolve 只代表推送中继（如 Apple 的
 * web.push.apple.com）**受理**了这条消息，不代表设备真的收到、更不代表用户看到了通知——
 * 这一层系统级不确定性（设备离线/勿扰/PWA 被后台回收）在当前架构下确实拿不到，日志如实
 * 反映"送到中继"这一层，不夸大成"送达用户"。
 */
export async function broadcast(payload) {
  const total = subs.length
  if (total === 0) {
    console.log(`[push] broadcast tag=${payload?.tag ?? '-'} skip：0 个订阅者`)
    return 0
  }
  const body = JSON.stringify(payload)
  const t0 = Date.now()
  let sent = 0
  let expired = 0
  let failed = 0
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600 })
      sent++
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        unsubscribe(sub.endpoint)
        expired++
      } else {
        failed++
        console.error('[push] send failed:', e.statusCode ?? e.message)
      }
    }
  }))
  console.log(`[push] broadcast tag=${payload?.tag ?? '-'} total=${total} sent=${sent} expired=${expired} failed=${failed} ${Date.now() - t0}ms`)
  return sent
}
