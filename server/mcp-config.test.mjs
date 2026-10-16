// mcp-config：项目 .mcp.json 读取 + MCP 工具名解析。
// 跑：node --test server/mcp-config.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProjectMcp, mcpServerOf } from './mcp-config.js'

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcfg-'))

test('读到 .mcp.json → servers/names/path 都给', () => {
  const d = mkdir()
  fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({
    mcpServers: { agentmail: { command: 'bun', args: ['run', 's.ts'], env: { AGENTMAIL_ACTOR: 'x@y' } } },
  }))
  const r = loadProjectMcp(d)
  assert.deepEqual([...r.names], ['agentmail'])
  assert.equal(r.path, path.join(d, '.mcp.json'))
  assert.equal(r.servers.agentmail.command, 'bun')
  fs.rmSync(d, { recursive: true, force: true })
})

test('无 .mcp.json → 全空（不启用 MCP）', () => {
  const d = mkdir()
  const r = loadProjectMcp(d)
  assert.equal(r.servers, null)
  assert.equal(r.path, null)
  assert.equal(r.names.size, 0)
  fs.rmSync(d, { recursive: true, force: true })
})

test('损坏 JSON → 容错为空，不抛', () => {
  const d = mkdir()
  fs.writeFileSync(path.join(d, '.mcp.json'), '{ not json')
  const r = loadProjectMcp(d)
  assert.equal(r.path, null)
  assert.equal(r.names.size, 0)
  fs.rmSync(d, { recursive: true, force: true })
})

test('有文件但无 mcpServers 键 → path 为 null（不误传空配置）', () => {
  const d = mkdir()
  fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ other: 1 }))
  const r = loadProjectMcp(d)
  assert.equal(r.servers, null)
  assert.equal(r.path, null)
  fs.rmSync(d, { recursive: true, force: true })
})

test('⚠️ 凭据红线：loadProjectMcp 不把 env 打进日志', () => {
  const d = mkdir()
  fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({
    mcpServers: { agentmail: { command: 'bun', args: [], env: { AGENTMAIL_PASS: 'SECRET_XYZ' } } },
  }))
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try { loadProjectMcp(d) } finally { console.log = orig }
  const joined = logs.join('\n')
  assert.ok(joined.includes('agentmail'), '应记 server 名')
  assert.ok(!joined.includes('SECRET_XYZ'), '绝不能把 env 里的凭据打进日志')
  fs.rmSync(d, { recursive: true, force: true })
})

test('mcpServerOf：从 mcp__<server>__<tool> 取 server 段', () => {
  assert.equal(mcpServerOf('mcp__agentmail__check_inbox'), 'agentmail')
  assert.equal(mcpServerOf('mcp__foo_bar__x'), 'foo_bar')
  assert.equal(mcpServerOf('Bash'), null)       // 非 MCP 工具
  assert.equal(mcpServerOf('Write'), null)
  assert.equal(mcpServerOf(''), null)
  assert.equal(mcpServerOf(undefined), null)
})
