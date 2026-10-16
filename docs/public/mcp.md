# MCP 接入

MCP 服务采用 stdio，由调用工具启动，不另开放公网端口。8 个只读工具覆盖服务器/项目概况、待办、会话、事件、归档、项目进展与任务证据。它读取 Hub 已纳管的全部节点，不局限于 Hub 所在服务器。

容器安装示例（把工作目录替换为本机的发布目录）：

```json
{
  "mcpServers": {
    "web-agents": {
      "command": "docker",
      "args": ["compose", "--project-directory", "/path/to/web-agents", "--env-file", "/path/to/web-agents/.compose.env", "exec", "-T", "-e", "WA_MCP_TOKEN_FILE=/var/lib/web-agents/.web-agents/mcp-token", "console", "node", "server/mcp/index.js"]
    }
  }
}
```

原生 MCP 入口：`node /path/to/web-agents/server/mcp/index.js`。环境变量 `WA_MCP_HUB` 指向可信 Hub origin，`WA_MCP_TOKEN_FILE` 指向私有的 `mcp-token` 文件。默认仅 GET 允许的读端点；不能创建会话、执行命令、审批、打开终端或修改设置。

远程工具应通过 TLS/SSH 安全转发连接 Hub，或通过 SSH 启动远端 stdio 入口。不要将令牌放入命令行参数或公开配置；MCP token 仍可读取私人执行历史，只交给可信工具。

`history_search` 依赖可选 MongoDB 历史投影，默认安装未启用时会明确返回不可用；项目小助理的任务证据与进展使用默认 MySQL 持久化及现役节点记录，不依赖这一可选投影。
