# Security

Web Agents controls files, shell commands and AI coding CLIs with the privileges of its execution user. Use it only with trusted administrators. Built-in authentication is a single administrator boundary; there are no tenant, project or command-level permissions for separate users.

Keep the console behind HTTPS, a VPN or an SSH tunnel. Console cookies are HttpOnly and SameSite=Strict; set `WA_PUBLIC_URL` to the actual HTTPS origin. Non-loopback Hub listeners require built-in authentication. Native loopback compatibility mode assumes an authenticated reverse proxy and is not a public deployment mode.

Each execution node should require its own token. Use private networks, TLS or SSH tunnels; tokens on plain HTTP over an untrusted network are exposed. Browser sessions and console tokens are stripped before node forwarding. The node token grants powerful execution capabilities, not read-only access. Restrict its distribution.

The MCP token is separate and allows only the documented read endpoints. Its results contain project names, transcripts and history: treat it as confidential. A full Hub token, CLI credentials and optional model/provider keys must never enter Git, screenshots or images. Backups contain credentials and need encryption/access controls supplied by the operator.

Default containers run without root, privileged mode, host PID access or a Docker socket. This does not make commands from an untrusted user safe. Runner changes replace CLI processes inside that container. For host-level isolation and persistent native writers, deploy a native Linux node under a dedicated OS account.

Report a suspected vulnerability through [private security reporting](https://github.com/jeanron100/web-agents-oss/security/advisories/new). Do not post exploitable details or secrets in a public issue. The latest 0.1.x release candidate receives fixes; older candidates should be upgraded before reporting a known issue. There is no production support SLA for prereleases.
