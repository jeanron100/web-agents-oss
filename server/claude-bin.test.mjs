// claude CLI 路径解析 —— 回归测试。
//
// 背景（2026-08-21 用户实拍）：srv-177-188 上新建/接管 Claude 会话必定
// `Claude Code process exited with code 1`，agent 日志一个字都没有。
// 查下来根因与会话大小无关（我一开始怀疑那两条 23MB/74MB 的 JSONL，**错了**）：
//
//   /root/.nvm/versions/node/v22.22.2/bin/claude --version
//   → Error: claude native binary not installed.（postinstall 没跑 / --omit=optional）
//
// 而同机的 **/usr/bin/claude 是好的（2.1.197）**，只是它**根本不在候选表里**。
// 原实现 `candidates.find((p) => fs.existsSync(p))` —— **只判存在，不判能不能跑** ⇒
// 稳稳选中那个坏的，且**没有任何日志**说它选了谁。
//
// ★ 这是本仓库反复出现的一类：**「装了 ≠ 能用」**（systemctl is-active 会骗你、
//   插件装了但 worker 从没起来、端口在听但不 accept）。判存在是最弱的判据。
//
// 同一病根的第二个实例：usage-limits.js 把 /root/.local/bin/claude **写死**在探针命令里，
// 而 177-188 上没有这个文件 ⇒ Claude 额度探测在那台机上一直静默失败。

import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeCandidates, pickClaudeBin, PROBE_TIMEOUT_MS } from './claude-bin.js'

/** probe 替身：给定「哪些路径能真正跑起来」 */
const probeWith = (workingSet) => (p) => workingSet.has(p)

test('★★ 存在但跑不起来的必须跳过 —— 这就是 177-188 的原样复现', () => {
  const candidates = ['/root/.nvm/versions/node/v22.22.2/bin/claude', '/usr/bin/claude']
  const exists = new Set(candidates)                       // 两个都"存在"
  const works = new Set(['/usr/bin/claude'])               // 只有一个能跑
  const got = pickClaudeBin(candidates, { exists: (p) => exists.has(p), probe: probeWith(works) })
  assert.equal(got.bin, '/usr/bin/claude')
  assert.equal(got.verified, true)
})

test('★ /usr/bin/claude 必须在候选表里（177-188 上唯一能用的那个）', () => {
  const list = claudeCandidates({}, '/root')
  assert.ok(list.includes('/usr/bin/claude'), `候选表缺 /usr/bin/claude：${list.join(', ')}`)
})

test('候选顺序：先 ~/.local/bin，再 /usr/local/bin、/usr/bin，nvm 垫底', () => {
  // nvm 最容易出现"半装"（native binary 缺失），排最后。
  const list = claudeCandidates({}, '/root')
  const i = (p) => list.indexOf(p)
  assert.ok(i('/root/.local/bin/claude') < i('/usr/local/bin/claude'))
  assert.ok(i('/usr/local/bin/claude') < i('/usr/bin/claude'))
})

test('★★ 一个都验不过时，退回"存在的第一个"但必须标记未验证', () => {
  // ⚠️ 修订（2026-08-21，上线当天实测）：初版在这里返回 null，结果**我自己的探测器**
  // 把 177-42 判成了"没有可用 CLI"——那台的 nvm claude 明明是好的（2.1.239），
  // 只是 `--version` 在 stdin:'ignore' 下要 **2,092ms**，超过了我给的 3s 超时（机器繁忙时）。
  // 探测器误判把一台好机器直接判死，**比原 bug 更糟**。
  // 所以失败模式改成：优先用验过的；一个都验不过就用存在的那个，并把 verified=false
  // 交给调用方**高声报**。宁可"带着警告继续跑"，也不要"因为我的探测慢而全线停摆"。
  const got = pickClaudeBin(['/a/claude', '/b/claude'], { exists: () => true, probe: () => false })
  assert.equal(got.bin, '/a/claude')
  assert.equal(got.verified, false)
})

test('一个候选都不存在 → bin 为 null', () => {
  const got = pickClaudeBin(['/a/claude'], { exists: () => false, probe: () => true })
  assert.equal(got.bin, null)
  assert.equal(got.verified, false)
})

test('★ CLAUDE_BIN 优先，但**同样要验** —— 写错了不能静默用一个坏的', () => {
  const list = claudeCandidates({ CLAUDE_BIN: '/custom/claude' }, '/root')
  assert.equal(list[0], '/custom/claude')
  // 指定了但跑不起来时，必须继续往下找能用的，而不是硬用它
  const got = pickClaudeBin(list, {
    exists: (p) => p === '/custom/claude' || p === '/usr/bin/claude',
    probe: probeWith(new Set(['/usr/bin/claude'])),
  })
  assert.equal(got.bin, '/usr/bin/claude')
})

test('不存在的路径不会被 probe（省掉无谓的进程启动）', () => {
  const probed = []
  pickClaudeBin(['/gone/claude', '/usr/bin/claude'], {
    exists: (p) => p === '/usr/bin/claude',
    probe: (p) => { probed.push(p); return true },
  })
  assert.deepEqual(probed, ['/usr/bin/claude'])
})

test('nvm 多版本全部进候选，且不影响前面的优先级', () => {
  const list = claudeCandidates({}, '/root', ['v20.1.0', 'v22.22.2'])
  assert.ok(list.includes('/root/.nvm/versions/node/v22.22.2/bin/claude'))
  assert.ok(list.indexOf('/usr/bin/claude') < list.indexOf('/root/.nvm/versions/node/v20.1.0/bin/claude'))
})

test('空候选表返回 null，不抛', () => {
  assert.equal(pickClaudeBin([], { exists: () => true, probe: () => true }).bin, null)
})

test('★ 探测超时必须留足余量 —— 实测 stdin:ignore 下 --version 要 2,092ms', () => {
  // 177-42 实测：stdio:['ignore','pipe','pipe'] → 2,092ms，而 ['pipe',...] → 280ms（7×）。
  // 初版给了 3s，机器一忙就超时，把好机器判死。余量必须按**实测最慢值**给，不是拍脑袋。
  assert.ok(PROBE_TIMEOUT_MS >= 10_000, `探测超时 ${PROBE_TIMEOUT_MS}ms 太紧，实测能到 2秒+`)
})
