// 项目 `.mcp.json` 的读取 —— Claude(driver.js) 与 Codex(codex-driver.js) 共用。
//
// 每个想让 launched agent 用 MCP 的项目，在自己根目录放一份 600 的 `.mcp.json`（内含该 agent
// 自己的身份/凭据，如 AGENTMAIL_ACTOR），web_agents 不需要知道任何项目的凭据。两个引擎读同一份文件。
//
// ⚠️ 凭据红线：本模块**只记 server 名、绝不打印 env**（凭据不落日志）。
// ⚠️ 传给引擎的方式也要防凭据进 `ps`：
//    · Claude：**不能**把 mcpServers 当内联对象传（SDK 会拼成 `--mcp-config <明文JSON>`，`ps` 可见凭据），
//      要传**文件路径** `extraArgs:{'mcp-config': path}`——见 driver.js。（观测 2699 实证过这个泄漏。）
//    · Codex：`thread/start` 的 `config.mcp_servers` 走 stdin RPC，env 进子进程 environ，天生不进 ps。
//
// ⚠️ 为什么**不**用 SDK 的 `settingSources:['project']`（Claude 官方推荐法）：实测它会加载项目
//    `.claude/settings.json` 的权限 allowlist（`Bash(*)` 之类），让 SDK 完全跳过 canUseTool → 审批模型被
//    绕过；且它在当前 SDK 版本下根本不加载项目根 `.mcp.json`。集群 8 个项目带这种 allowlist，一律不能碰。

import fs from 'node:fs'
import path from 'node:path'

/**
 * 读 `<cwd>/.mcp.json`。
 * @returns {{ servers: object|null, names: Set<string>, path: string|null }}
 *   servers: mcpServers 对象（Codex 走 RPC config 用）；names: server 名集合（自动放行其工具用）；
 *   path: `.mcp.json` 绝对路径（Claude 走 --mcp-config 文件路径用，避免凭据进 ps）。
 *   缺文件/损坏/无 mcpServers → 全空，调用方据此不启用 MCP。
 */
export function loadProjectMcp(cwd) {
  try {
    const p = path.join(cwd, '.mcp.json')
    if (!fs.existsSync(p)) return { servers: null, names: new Set(), path: null }
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
    const servers = cfg && typeof cfg.mcpServers === 'object' && cfg.mcpServers ? cfg.mcpServers : null
    const names = new Set(servers ? Object.keys(servers) : [])
    if (names.size) console.log(`[mcp] ${path.basename(cwd)}: 加载项目 .mcp.json，servers=[${[...names].join(',')}]`) // 只记名字，不记 env
    return { servers, names, path: names.size ? p : null }
  } catch (e) {
    console.log(`[mcp] ${path.basename(cwd)}: .mcp.json 读取/解析失败，忽略（${e?.message ?? e}）`)
    return { servers: null, names: new Set(), path: null }
  }
}

/** MCP 工具名形如 `mcp__<server>__<tool>`；取其 server 段。非 MCP 工具返回 null。 */
export function mcpServerOf(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null
  return toolName.slice(5).split('__')[0] || null
}
