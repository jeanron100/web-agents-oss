# MCP integration

[English](mcp.md) | [简体中文](../mcp.md) · [Home](../../../README.en.md)

The MCP server uses stdio and is started by the calling tool; it does not expose another public port. Eight read-only tools cover server/project overview, pending items, sessions, events, history search, project progress and task evidence. They can query all nodes managed by the Hub, including remote execution nodes.

Container example; replace the installation paths with your own:

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

Native entry point: `node /path/to/web-agents/server/mcp/index.js`. Set `WA_MCP_HUB` to a trusted Hub origin and `WA_MCP_TOKEN_FILE` to the private `mcp-token` file. Only GET requests to documented read endpoints are permitted. This interface cannot create sessions, run commands, approve actions, open terminals or change settings.

Remote clients should use TLS/SSH forwarding to the Hub or start the remote stdio entry point through SSH. Never put tokens in command-line arguments or public configuration. Read-only results can contain private project history; share this token only with trusted tools.

`history_search` requires the optional MongoDB history projection and reports unavailability when it is not enabled. The project assistant's task evidence and progress use default MySQL persistence and managed-node records; they do not require that optional projection.
