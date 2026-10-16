// server/mcp/index.js
// 唯一碰 MCP SDK 的文件。业务逻辑全在 tools.js/wire.js/filters.js（纯函数、可单测）——
// 协议壳可替换而不影响核心。
//
// 传输：stdio。由 MCP 客户端（driver 经项目 .mcp.json）按需拉起，非常驻服务。
// ⚠️ Claude 侧挂载必须传**文件路径** extraArgs:{'mcp-config': path}，不能内联 JSON，
// 否则 SDK 会拼成 --mcp-config <明文JSON>，凭据在 ps 里可见（观测 2699 实证）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHubClient, classifyError } from './hub-client.js'
import { createTools } from './tools.js'
import { DEFS } from './tool-defs.js'

const ACTOR = process.env.WA_MCP_ACTOR || 'unknown'
const client = createHubClient({})
const tools = createTools(client)

// 所有返回列表的工具都带 offset：返回体整体受 8192 字节预算约束，超出时会给
// hasMore + nextOffset，调用方拿它续取下一批。description 里必须写清楚这件事，
// 否则 LLM 拿到 nextOffset 也不知道该干什么，会把截断当成全集。
// 工具清单本体在 tool-defs.js；含项目小助理共8个只读工具，测试锁定允许集合。

const server = new Server({ name: 'web-agents', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEFS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = tools[req.params.name]
  if (!fn) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, message: `未知工具 ${req.params.name}` }) }], isError: true }
  try {
    const out = await fn(req.params.arguments ?? {})
    return { content: [{ type: 'text', text: JSON.stringify(out) }] }
  } catch (e) {
    // 超时 ⇒ indeterminate（别说成失败）；上游 4xx ⇒ 原样透传可操作字段
    return { content: [{ type: 'text', text: JSON.stringify(classifyError(e)) }], isError: true }
  }
})

console.error(`[wa-mcp] actor=${ACTOR} hub=${process.env.WA_MCP_HUB || 'http://127.0.0.1:8787'}`)
await server.connect(new StdioServerTransport())
