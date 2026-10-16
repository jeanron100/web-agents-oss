# Installation and remote execution nodes

[English](installation.md) | [简体中文](../installation.md) · [Home](../../../README.en.md)

The console aggregates state; execution nodes run coding CLIs. Each node has its own project root, vendor credentials and access token. Existing host CLI processes are not processes inside a container.

Start with the [remote setup guide](remote-setup.md) and `/getting-started` for node preparation, project directories, CLI sign-in and live readiness checks.

## Containers

See the [desktop guide](desktop.md) for Mac/Windows, or the root README for Linux amd64/arm64. Use the same `.compose.env` and Compose file combination for subsequent operations. The default installation exposes neither MySQL nor node ports to the host; the console listens at `127.0.0.1:5188`.

Fresh container installations provide `admin / admin123` and require a new password before project or terminal access. Upgrades preserve existing accounts. Recovery and token-based manual initialization are covered in [operations](operations.md).

The console can connect to multiple native Linux nodes without a runner. With a runner, only a dedicated token volume is shared between control and execution planes; their state and vendor-account directories remain separate. Do not mount `/root`, the entire filesystem or a Docker socket. Use the default workspace volume or a dedicated bind mount writable by UID/GID 1000.

Pinned CLI versions are listed in the Dockerfile. Vendor CLI changes can require upgrades and renewed acceptance testing. Images do not contain logged-in vendor accounts; authentication happens in your environment. Models and capabilities ultimately depend on the CLI and account.

## Native Linux nodes

Install Node.js 24, Git, tmux and the required coding CLIs in a prepared release source tree. Use a dedicated OS user where possible. Sign into each CLI as that user and verify a real task in the terminal first.

```bash
cd /path/to/web-agents/server
npm ci --omit=dev
mkdir -p "$HOME/workspaces"
export WA_PROJECT_ROOT="$HOME/workspaces"
export WA_AGENT_TOKEN_FILE="$HOME/.config/web-agents/node-token"
mkdir -p "$(dirname "$WA_AGENT_TOKEN_FILE")"
umask 077
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$WA_AGENT_TOKEN_FILE"
export WA_AGENT_REQUIRE_TOKEN=1
export WA_AGENT_HOST=127.0.0.1
# Explicitly disable worker slices if this host has no configured systemd slice.
export WA_WORKER_SLICE=0
node agent.js
```

This foreground command is for initial verification. For long-running use, configure the OS service manager with the same user, environment and working directory. Native worker slices and memory limits need operator configuration; the first release does not install host services automatically. Disabling slices must not be represented as independent process isolation.

Forward the node's loopback listener to a console-accessible endpoint through SSH, or use a private interface and firewall restricted to the Hub. Cross-machine connections over untrusted networks need TLS or a secure tunnel. In server-management settings, enter a stable ID, the URL as seen from the Hub and the node token; test before saving.

Disabling a node stops polling and routing. Removing it removes its management configuration, preserves history and does not stop remote CLI processes. IDs identify historical ownership and cannot be renamed during editing; display names and addresses can change. Re-adding the same ID reconnects that node's current ownership.

## Codex sandboxing in the runner

Default Docker restrictions may prevent Codex's internal bwrap from creating namespaces. The optional runner explicitly sets `WA_CODEX_EXTERNAL_SANDBOX=1` and uses the externalSandbox policy: Docker provides outer isolation and outbound network access is allowed. It does not grant host PID access, a Docker socket or additional privileges. Native nodes retain their workspace-write policy.

Projects, mounted directories and CLI accounts within a runner are accessible to that execution node. This is not an isolation boundary between untrusted tenants. Use separate runners or OS users when projects need isolation. You can remove the flag to try the inner sandbox only after verifying host support. See the vendor's [agent approvals and security overview](https://learn.chatgpt.com/docs/agent-approvals-security).
