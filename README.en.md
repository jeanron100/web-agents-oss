# Web Agents

[English](README.en.md) | [简体中文](README.md)

A self-hosted console for AI coding agents across multiple servers. Follow Codex, Kimi and Claude conversations, handle approvals, inspect execution history, open terminals and track project progress from a desktop or mobile browser.

For a single administrator or trusted small team using Linux execution nodes. This is not an isolation platform for untrusted tenants. You bring your own vendor accounts; model access and subscription terms remain with each provider.

[Live demo — fictional data, no login](https://webagents.jeanron100.top/demo/) · [Product overview](https://webagents.jeanron100.top/demo.en.html) · [Features and alternatives](docs/public/en/comparison.md)

Bilingual coverage includes the documentation, product pages, sign-in/setup and account-password screens. Use the **English / 中文** control on the sign-in page; the choice is saved locally. The main project console and demo still contain Chinese interface text. Agent conversations and project content remain in their original language.

## Why use it?

When projects live on several servers and use different coding CLIs, it becomes difficult to answer simple questions: What is running? What needs my approval? Was yesterday's task actually resolved? What evidence supports the answer?

Web Agents brings those entry points into one console, reducing the need to switch between SSH sessions, terminals and transcripts. It is especially useful for independent developers and maintainers who handle both development and operations across remote projects.

## Highlights

| Feature | What it helps you do |
|---|---|
| **One dashboard across servers and projects** | Inspect project state and pending work by server or application; add, test, disable and remove nodes in settings |
| **Codex, Kimi and Claude in one console** | View conversations, tool events and images using each node's CLI accounts and sessions; resume where supported |
| **An inbox for human decisions** | Find approvals, questions, plans and changes awaiting review from a mobile or desktop browser |
| **Supplement now, queue separate work** | Codex supplements go to the current turn by default; independent tasks can be queued until that turn finishes |
| **Project progress backed by execution records** | The assistant retrieves requests, reported outcomes, methods and risks, with sources and coverage information |
| **Quota and consumption kept separate** | Inspect subscription windows, reset times, quota history, daily Token trends and project consumption; assistant calls retain reported model, usage and compatibility warnings |
| **Read-only MCP integration** | Eight bounded tools expose managed nodes, sessions, pending items, task evidence and progress to trusted external assistants |
| **Terminals, files and image previews** | Inspect command results, screenshots and QR codes without leaving the console |
| **Versioned self-hosted delivery** | Linux amd64/arm64 images and Mac/Windows Docker Desktop launchers, with persistent volumes, diagnostics and backup instructions |

Agent capabilities differ. Claude inference has not been tested with a vendor account for this public release. Read the [comparison](docs/public/en/comparison.md) and [release validation](docs/public/en/release-readiness.md) for the actual scope.

## Download a version

Current prerelease: **[v0.1.0-rc.13](https://github.com/jeanron100/web-agents-oss/releases/tag/v0.1.0-rc.13)**. Previous versions and release notes remain available in [GitHub Releases](https://github.com/jeanron100/web-agents-oss/releases).

| Platform | Download | Start after extracting |
|---|---|---|
| macOS Intel / Apple Silicon | [Mac ZIP](https://github.com/jeanron100/web-agents-oss/releases/download/v0.1.0-rc.13/web-agents-v0.1.0-rc.13-macos.zip) | `start-macos.command` |
| Windows x64 | [Windows ZIP](https://github.com/jeanron100/web-agents-oss/releases/download/v0.1.0-rc.13/web-agents-v0.1.0-rc.13-windows.zip) | `start-windows.cmd` |
| Linux amd64 / arm64 | [Versioned source archive](https://github.com/jeanron100/web-agents-oss/releases/download/v0.1.0-rc.13/web-agents-v0.1.0-rc.13.tar.gz) | `bash scripts/quickstart.sh --runner --pull` |

Install and start Docker first. Mac/Windows use Docker Desktop; Windows requires WSL 2 and Linux containers. Downloads include checksums, with separate image archives for each architecture. Versions ending in `-rc.N` are release candidates; `vX.Y.Z` identifies a stable release.

## Quick start

Use Docker Engine with Compose v2, or Docker Desktop. Allow at least 4 GB of memory and 12 GB of free disk space. The optional runner uses Docker as its outer isolation boundary and is intended for trusted projects.

```bash
git clone https://github.com/jeanron100/web-agents-oss.git
cd web-agents-oss
./scripts/quickstart.sh --runner --pull
```

On Mac/Windows, you can instead download the ZIP, extract it completely to a writable directory and run the launcher. Host Git, Node.js and Python are not required. See the [desktop guide](docs/public/en/desktop.md).

Open `http://localhost:5188`. **Fresh container installations use username `admin` and temporary password `admin123`.** You must set a new password of at least 8 characters, then sign in again before accessing projects, settings or terminals. Upgrades preserve existing credentials.

If you forget an existing password, run these commands from the installation directory:

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs reset-password
docker compose --env-file .compose.env restart console
```

This preserves the username, resets the temporary password to `admin123` and revokes old login sessions when the console loads the reset state. You must set a new password again. To use token-based manual account setup instead, set `WA_INITIAL_ACCOUNT=0` before first start; see [operations](docs/public/en/operations.md).

The optional runner registers as a local container node. Sign into the vendor CLIs you want to use:

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner kimi login
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner bash
# In the runner shell:
mkdir -p /workspace/my-project
```

Node diagnostics show CLI versions and credential-file presence; a file's presence does not prove authentication succeeds. Use `./scripts/quickstart.sh --pull` without a runner to connect existing remote Linux nodes instead.

The launcher first tries GHCR. If unavailable, it downloads the matching public Release image archive and verifies its SHA-256 checksum. Omit `--pull` to build from source; this requires npm network access, but no vendor credentials during the build.

The console binds to loopback by default. For remote access, use `ssh -L 5188:127.0.0.1:5188 your-server`, or configure an HTTPS reverse proxy and set `WA_PUBLIC_URL` to the actual origin.

## Lifecycle boundaries

Restarting the console does not terminate remote native CLI processes. **Replacing a runner container stops the CLIs inside it.** Preserve the workspace and account/history volumes, then reload the sessions. Native Linux nodes use host facilities such as systemd, tmux and cgroups; containers do not adopt host processes.

## Documentation and development

- [Features, use cases and alternatives](docs/public/en/comparison.md)
- [Mac/Windows downloads and launchers](docs/public/en/desktop.md)
- [Installation and remote nodes](docs/public/en/installation.md)
- [Configuration, upgrades, backups and recovery](docs/public/en/operations.md)
- [MCP integration](docs/public/en/mcp.md)
- [Release validation and roadmap](docs/public/en/release-readiness.md)
- [Security and vulnerability reporting](SECURITY.md)
- [Third-party software](docs/public/en/third-party-notices.md)
- [Contributing](CONTRIBUTING.md)

```bash
cd server && npm ci && npm test
cd ../web && npm ci && npm test && npm run build
```

Real installations start without demo accounts for vendor CLIs, real server lists or sample projects. Only an explicit `VITE_DEMO=1` frontend build uses fictional project data. The console's temporary administrator account is separate from vendor accounts.

## Public source and licensing

This project began as a private deployment. The public repository contains a clean export, without the original private Git history, deployment credentials or operational data. Maintainers verify a file manifest and SHA-256 hashes before publishing. A secret scan is an additional check, not proof that secrets cannot exist.

ISC license for this project. Third-party CLIs, dependencies and services retain their own licenses and terms; this project does not grant access to their products.
