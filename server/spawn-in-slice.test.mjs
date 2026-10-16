// node --test server/spawn-in-slice.test.mjs
//
// 把会话子进程拉起到独立 cgroup slice —— `isolate-control-plane-cgroups` 的核心机制。
//
// 为什么（2026-08-13 实测故障现场）：
//   web-agents-agent.service 这一个 cgroup 里装着
//     agent.js 102MB + claude worker 406MB + claude worker 299MB + claude-mem 112MB + MCP 131MB
//     = memory.current 1592MB / MemoryHigh 1638MB  ⇒ 内核同步回收节流，服务 active 但不 accept
//   **只用两个会话就顶满了**，而其中 705MB 与控制面毫无关系。
//
// 已实测验证的四条前提（`systemd-run --scope`）：
//   ① stdio 管道保留（codex/kimi 的 NDJSON 双向管道可用）
//   ② 落进 --slice 指定的 cgroup
//   ③ 退出码透传
//   ④ systemd 按连字符自动建层级：web-agents-worker.slice → /web.slice/web-agents.slice/…
//
// ★ 本模块只负责**构造命令行**与**失败时怎么办**，两者都必须可单测——
//   拉起子进程这件事一旦悄悄退化回原路径，隔离就静默失效了，而外表完全正常。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSliceArgv, WORKER_SLICE } from './spawn-in-slice.js'

test('把命令包进 systemd-run --scope 并指定 slice', () => {
  const { cmd, args } = buildSliceArgv('/usr/bin/codex', ['app-server'], { slice: WORKER_SLICE })
  assert.equal(cmd, 'systemd-run')
  assert.ok(args.includes('--scope'), '必须用 --scope：它保留 stdio 管道且退出码透传')
  assert.ok(args.includes(`--slice=${WORKER_SLICE}`))
  assert.ok(args.includes('--collect'), '必须 --collect，否则退出的 scope 单元会堆积成垃圾')
  assert.ok(args.includes('--quiet'), 'systemd-run 的提示会污染 NDJSON 的 stdout/stderr')
})

test('★ 用 -- 分隔，被包的命令参数不得被 systemd-run 吃掉', () => {
  // codex/kimi 的参数里可能出现 -x / --flag 形态。没有 `--` 分隔的话，
  // systemd-run 会把它们当成自己的选项 ⇒ 报错或行为诡异，且现场很难看出来。
  const { args } = buildSliceArgv('/usr/bin/kimi', ['acp', '--verbose', '-x'], { slice: WORKER_SLICE })
  const sep = args.indexOf('--')
  assert.ok(sep > 0, '必须有 -- 分隔符')
  assert.deepEqual(args.slice(sep + 1), ['/usr/bin/kimi', 'acp', '--verbose', '-x'],
    '分隔符之后必须是原样的命令与参数')
})

test('slice 名默认是 worker slice', () => {
  const { args } = buildSliceArgv('/bin/true', [])
  assert.ok(args.includes(`--slice=${WORKER_SLICE}`))
})

test('★ 单元名可选；给了要带上，不给则由 systemd 自动命名', () => {
  // 自动命名可避免"同一会话 id 并发创建两次"导致的单元名冲突。
  const withName = buildSliceArgv('/bin/true', [], { unit: 'wa-claude-abc' })
  assert.ok(withName.args.includes('--unit=wa-claude-abc'))
  const auto = buildSliceArgv('/bin/true', [])
  assert.ok(!auto.args.some((a) => a.startsWith('--unit=')))
})

test('单元名里的非法字符被清洗（会话 id 可能含 / 等）', () => {
  const { args } = buildSliceArgv('/bin/true', [], { unit: 'wa/claude:ps-1 x' })
  const unitArg = args.find((a) => a.startsWith('--unit='))
  assert.match(unitArg, /^--unit=[A-Za-z0-9_.\\-]+$/, `单元名未清洗：${unitArg}`)
})

test('空命令一律拒绝，不构造出半截命令行', () => {
  assert.throws(() => buildSliceArgv('', []))
  assert.throws(() => buildSliceArgv(null, []))
})

test('args 缺省为空数组', () => {
  const { args } = buildSliceArgv('/bin/true')
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/bin/true'])
})

test('★★ 禁用开关：关掉隔离时必须返回**原始命令**，不得留下半包装状态', () => {
  // 出问题要能一键退回原行为（环境变量 + 重启），不需要回滚代码。
  const { cmd, args } = buildSliceArgv('/usr/bin/codex', ['app-server'], { enabled: false })
  assert.equal(cmd, '/usr/bin/codex')
  assert.deepEqual(args, ['app-server'])
})

test('WORKER_SLICE 的命名遵循 systemd 层级约定', () => {
  // systemd 按连字符建层级：web-agents-worker.slice → /web.slice/web-agents.slice/web-agents-worker.slice
  // 于是 control 与 worker 天然共享父级 web-agents.slice，可父级设总量、子级设分量。
  assert.match(WORKER_SLICE, /^web-agents-worker\.slice$/)
})
