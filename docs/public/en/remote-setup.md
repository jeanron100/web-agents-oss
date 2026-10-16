# First use: connect a remote server

[English](remote-setup.md) | [简体中文](../remote-setup.md) · [Home](../../../README.en.md)

Web Agents is a browser console for coding agents across multiple servers. Code, CLI accounts and execution stay on each node. The console connects them so you can follow progress, send messages and handle approvals from one place.

Starting with rc.15, fresh Mac/Windows desktop launches start the console and MySQL, without a local runner. Open `/getting-started` after signing in. Local container execution remains optional. Existing installations retain their mode; `.compose.env` records `WA_INSTALL_MODE`, and older installations are checked for an existing runner rather than silently removing one.

## 1. Prepare a Linux execution node

Use a server with your existing projects. Install Node.js 24, Git, tmux and at least one coding CLI. Use the same OS user for the agent, project files and CLI sign-in. Your Web Agents administrator account is separate from vendor CLI authentication.

For code in `~/workspaces/my-app`, set the project root to `~/workspaces`. The project list contains its immediate subfolders. Files on your laptop are not uploaded automatically.

Download the release source or clone the public repository, then run on the execution node:

```bash
git clone https://github.com/jeanron100/web-agents-oss.git "$HOME/web-agents"
cd "$HOME/web-agents/server"
npm ci --omit=dev
mkdir -p "$HOME/workspaces/my-app" "$HOME/.config/web-agents"
export WA_SERVER_ID=my-dev-server
export WA_PROJECT_ROOT="$HOME/workspaces"
export WA_AGENT_TOKEN_FILE="$HOME/.config/web-agents/node-token"
umask 077
# Generate once; keep an existing token so other consoles remain connected.
if [ ! -s "$WA_AGENT_TOKEN_FILE" ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$WA_AGENT_TOKEN_FILE"
fi
export WA_AGENT_REQUIRE_TOKEN=1
export WA_AGENT_HOST=127.0.0.1
export WA_WORKER_SLICE=0
node agent.js
```

This runs in the foreground. Verify it first, then keep it running with tmux or your OS service manager, preserving the user, environment and working directory. `WA_WORKER_SLICE=0` is for hosts without a configured systemd worker slice; it does not provide independent process isolation. Do not copy someone else's private IP or `/data` paths.

## 2. Make the agent reachable from the console

The Agent URL is an HTTP(S) endpoint reached **by the console container**, not an SSH login address. Opening it in your browser does not prove the container can reach it.

| Network | Configuration |
|---|---|
| Trusted private network / VPN reachable from the container | Bind `WA_AGENT_HOST` to the node’s private interface, restrict its firewall to the console and use `http://private-ip:8788` with private-network transport |
| Across the public internet | Keep the agent on `127.0.0.1:8788`, put an HTTPS reverse proxy with a valid certificate in front of it and use `https://agent.example.com` |
| Existing SSH tunnel | Establish it first and enter the tunnel endpoint reachable from the container; choosing the transport does not create a tunnel |

`localhost` or `127.0.0.1` inside a container means that container. A Mac/Windows host path is not a Linux node path. The optional Docker runner uses `http://runner:8788` on the shared Compose network.

An HTTPS reverse proxy must preserve Authorization headers, WebSocket upgrades and unbuffered event streams. With an existing certificate, an example Nginx server is:

```nginx
server {
    listen 443 ssl;
    server_name agent.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Replace the domain and certificate paths and validate through your normal deployment process. Web Agents does not provision certificates, firewall rules or SSH tunnels. HTTPS does not replace agent-token authentication.

## 3. Add and check the server

Under **Settings → Server management → Add server**, enter a stable ID such as `my-dev-server`, a friendly name, the Agent URL, its access token and transport. Read the node-token file in your own terminal and paste it; do not share it in chat or screenshots.

Test the connection before saving. The diagnostics report the actual project root and installed CLIs. Later you can edit names/URLs, retain a token by leaving its field empty, disable polling/routing, or remove management while preserving history and remote CLI processes. A server ID identifies historical ownership and cannot be renamed in place.

## 4. Prepare projects and sign in

The `/getting-started` page checks the selected node’s actual project root, native/container execution, installed CLIs, credential-file indicators and project count. Credential presence is not proof of valid authorization: verify a real conversation.

An empty project list needs a repository or project subfolder under the configured root, readable/writable by the agent user. Check hidden projects too. A failed directory request is shown separately from a genuine empty directory. Refresh after preparing a project. Changing a native agent’s environment requires restarting that agent through your service manager; do not delete account volumes or project data to fix the list.

Sign in on the **execution node** using commands such as `codex login --device-auth`, `kimi login`, or `claude` followed by `/login`. Accounts are not copied automatically between nodes.

## 5. Start a first task

Choose the node and project, retain the default model and permission mode, and ask:

> Explain this project’s directory structure without changing any files.

After a successful response, try edits, tests, approvals and session resumption. Execution stays in the selected node’s project directory. Execution history and the project assistant provide traceable task records.

## Optional local container trial

From the installation folder:

```bash
# Mac / Linux
bash scripts/quickstart.sh --runner --pull
```

```powershell
# Windows PowerShell
.\scripts\quickstart.ps1 -Runner -Pull
```

This remembers local mode and preserves existing credentials and image pins. The `/workspace` volume starts empty. Prepare a sample project and sign into the CLI inside the runner:

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner sh -lc 'mkdir -p /workspace/hello-world && echo "Hello Web Agents" > /workspace/hello-world/README.md'
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
```

If the console was first initialized without a runner, add it manually with ID `local-runner`, URL `http://runner:8788` and local transport. Read its token from the dedicated shared token volume in your own terminal:

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec -T console node -e 'process.stdout.write(require("fs").readFileSync("/run/web-agents/runner/token","utf8"))'
```

Do not share this token. A runner included during the console’s first initialization is registered automatically. Refresh project folders and choose `hello-world`. Host code needs a dedicated bind mount writable by UID/GID 1000. Native Mac/Windows process adoption is not provided. See [operations](operations.md) for backups and upgrade boundaries.

## Design references

The workflow draws from [Claude Code Quickstart](https://code.claude.com/docs/en/quickstart): start in a project, authenticate and ask a first question; and [Remote Control](https://code.claude.com/docs/en/remote-control): make execution location and connection state explicit. Web Agents adds multi-node/multi-CLI management using your own deployment and authentication, without using Claude’s connection service.
