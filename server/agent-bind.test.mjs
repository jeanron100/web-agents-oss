// node --test server/agent-bind.test.mjs
//
// agent 的监听地址（2026-09-08，用户要求「用安全组开内网端口替代 SSH 隧道」）。
//
// 背景：hub 原先靠 3 条 `ssh -L` 才能拉到 3 台 agent，因为 agent 只监听 127.0.0.1。
// 实测 VPC 内网本来就互通（189-4 能直连 10.7.0.3:20022），隧道纯粹是这个 bind 选择的产物。
// 连带代价：加一台机器 = 加一条隧道 + 改 hub-config 的端口映射表，而那张表正是
// CLAUDE.md 里记着的坑（「套错了不报错，只会把会话默默记到另一台机器名下」）。
//
// ★★ 两条必须同时成立的约束，缺一不可：
//   ① **不能绑 `0.0.0.0`**。实测这几台机器网卡上虽无公网 IP，但有 docker 网桥(172.x)、
//      tailscale(100.x)、以及 cnbypass 的 tun0(10.98.x)。绑 0.0.0.0 = 把一个
//      **无鉴权且能执行任意命令**的 API（/api/exec、终端 WebSocket）暴露给容器和隧道对端。
//      所以要显式绑 eth0 的那个内网地址。
//   ② **127.0.0.1 必须继续可用**。deploy-agent.sh 的活跃会话检查与 drain、restart.sh、
//      agent-watchdog.sh 全都在打 `localhost:8788`。只绑内网地址会把这些工具**静默弄坏**——
//      而看门狗坏掉是本仓库反复栽过的那类问题（「看门狗与被监控对象不能共享故障域」）。
//
// ⇒ 结论是**双监听**：WA_AGENT_HOST 指定的地址 + 127.0.0.1。默认值保持 127.0.0.1
//   （不配就是今天的行为，部署时才由 systemd drop-in 显式给内网 IP）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AGENT = new URL('./agent.js', import.meta.url).pathname
// 127.0.0.2 也是本机回环（127/8 整段都是），可以当"另一个地址"用，不需要真实网卡
const ALT = '127.0.0.2'

async function boot(port, host, extra={}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bind-'))
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true })
  const env = { ...process.env, HOME: home, WA_AGENT_PORT: String(port), WA_REDIS_ENABLED: '0', WA_MONGO_ENABLED: '0', ...extra }
  if (host) env.WA_AGENT_HOST = host
  const p = spawn(process.execPath, [AGENT], { env, stdio: 'ignore' })
  const hit = async (addr) => {
    const r = await fetch(`http://${addr}:${port}/api/projects`)
    return r.status
  }
  for (let i = 0; i < 60; i++) {
    try { await hit('127.0.0.1'); break } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  return { stop: () => { p.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) }, hit }
}

test('★ 配了 WA_AGENT_HOST 时，该地址与 127.0.0.1 **都要**可达', { timeout: 90_000 }, async () => {
  let a
  try {
    a = await boot(18841, ALT)
    assert.equal(await a.hit(ALT), 200, `${ALT} 应可达——这是 hub 要走的那条路`)
    assert.equal(await a.hit('127.0.0.1'), 200,
      '127.0.0.1 必须继续可用，否则 deploy-agent.sh / restart.sh / 看门狗全部静默失效')
  } finally { a?.stop() }
})

test('★ 不配 WA_AGENT_HOST 时保持今天的行为：只听 127.0.0.1', { timeout: 90_000 }, async () => {
  let a
  try {
    a = await boot(18842, '')
    assert.equal(await a.hit('127.0.0.1'), 200)
    // 默认必须是安全的那一侧：没显式配置就不该在别的地址上出现
    await assert.rejects(() => a.hit(ALT), `未配置时不应监听 ${ALT}`)
  } finally { a?.stop() }
})

test('★★ 绝不允许绑 0.0.0.0 —— 那会暴露给 docker 网桥/tailscale/cnbypass 隧道对端', () => {
  const src = fs.readFileSync(AGENT, 'utf8')
  assert.doesNotMatch(src, /listen\([^)]*['"]0\.0\.0\.0['"]/,
    'agent 的 API 无鉴权且能执行任意命令，0.0.0.0 等于把 root 执行权开放给同机所有容器')
})

// Public/container bind must have a token and must not create a second competing loopback listener.
test('token-protected container bind serves loopback and refuses anonymous HTTP', {timeout:30000}, async()=>{
 const token='t'.repeat(40),a=await boot(18843,'0.0.0.0',{WA_AGENT_TOKEN:token})
 try{assert.equal(await a.hit('127.0.0.1'),401);assert.equal((await fetch('http://127.0.0.1:18843/api/projects',{headers:{authorization:`Bearer ${token}`}})).status,200)}finally{a.stop()}
})
