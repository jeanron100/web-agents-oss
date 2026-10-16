// node --test server/health-timeout.test.mjs
//
// `health()` 必须有界返回 —— 2026-09-08 由「删掉 redis 隧道」意外挖出来的**生产挂起风险**。
//
// ★★ 怎么发现的：删掉 .232 的 redis 隧道后跑全套测试，`redis.test.mjs` 卡了 **600 秒不退**。
//   查因不是别的改动，而是 `node-redis` 的 `reconnectStrategy: (n) => Math.min(n*200, 3000)`
//   **永远返回一个延迟、从不返回 false** ⇒ 连不上就无限重试 ⇒ `await getClient()` 永不 settle。
//   `connectTimeout: 3000` 只管**单次**尝试，管不住整体。
//
// ★★★ 而这不只是测试慢：`health()` 就长在生产的请求路径和告警循环上 ——
//     · `hub.js` 两处 HTTP 处理器里 `await Promise.all([redis.health(), mongo.health()])`
//       ⇒ redis 一不可达，这两个端点**永久挂起**（连接被占住，不是干净地返回 500）
//     · `alerts.js` 的告警循环也 await 它 ⇒ **整个告警循环卡死**
//   后者正是本仓库反复栽的那一类：**看门狗自己是坏的**（「结构上永不响」「被焊死在 8/8」
//   「fail-safe 的跳过永远成立」）。一个探活函数能永久挂起，比它给出错误答案更糟 ——
//   错误答案至少还会被看见。
//
// ⇒ 不变量：**health() 无论后端死活，都必须在有界时间内 settle**。探不到就报错，
//   不能靠"一直等"假装还在探。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

/**
 * 在**子进程**里探一次 health()，返回 `{status, ms}` 或 `'HUNG'`。
 *
 * ⚠️ 必须用子进程：连不上时 redis/mongo 客户端会留下无限重连的定时器，
 *    **事件循环永不 drain** ⇒ 在同一进程里测会把整个测试套件挂住
 *    （2026-09-08 实测：全套卡 600s 不退，就是这么来的）。
 *    子进程顺带保证这个用例不会把脏定时器泄漏给同批其它用例。
 */
function probe(mod, env, budgetMs) {
  return new Promise((resolve) => {
    const code = `const t0 = Date.now()
const m = await import('./${mod}')
const r = await m.health()
console.log(JSON.stringify({ status: r.status, ms: Date.now() - t0 }))
process.exit(0)`
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('.', import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    const kill = setTimeout(() => { p.kill('SIGKILL'); resolve('HUNG') }, budgetMs)
    p.on('exit', () => {
      clearTimeout(kill)
      try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve('HUNG') }
    })
  })
}

// 192.0.2.1 是 RFC5737 的 TEST-NET-1，保证不可达；且是**丢包黑洞**而非拒绝，
// 最接近「隧道断了」的真实形态（连接一直等，不会立刻 ECONNREFUSED）。
const DEAD = '192.0.2.1'

test('★★ redis.health() 连不上时必须有界返回，不能永久挂起', { timeout: 60_000 }, async () => {
  const r = await probe('redis.js', { WA_REDIS_ENABLED: '1', WA_REDIS_URL: `redis://${DEAD}:6379` }, 30_000)
  assert.notEqual(r, 'HUNG',
    'health() 30s 内没返回 —— 生产上 hub 的两个端点和整个告警循环都会被它挂住')
  assert.notEqual(r.status, 'ok', '不可达不能报 ok')
})

test('★★ mongo.health() 同样必须有界返回', { timeout: 60_000 }, async () => {
  const r = await probe('mongo.js', { WA_MONGO_ENABLED: '1', WA_MONGO_URI: `mongodb://${DEAD}:27017/x` }, 30_000)
  assert.notEqual(r, 'HUNG', 'health() 30s 内没返回')
  assert.notEqual(r.status, 'ok', '不可达不能报 ok')
})
