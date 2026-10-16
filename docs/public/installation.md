# 安装与远程执行节点

[简体中文](installation.md) | [English](en/installation.md)

控制台聚合状态，执行节点运行 CLI。每个节点有独立的项目根目录、CLI 账号和访问令牌。不能把宿主机已有 CLI 进程当成容器内的进程。

## 容器

Mac（Intel/Apple Silicon）、Windows（WSL 2）见 [桌面快速交付](desktop.md)，通过 Docker Desktop 使用 Linux 容器。Linux amd64/arm64 参见根 README 的 quickstart。所有命令使用同一份 `.compose.env`；修改配置后运行相同 Compose 文件组合的 `up -d --build`。默认无 MySQL 或节点端口暴露到宿主机。控制台默认仅在 `127.0.0.1:5188` 访问。

单独控制台可接任意多个原生节点。使用 runner 时，控制台与 runner 共用的只有单独令牌卷；两者的状态和账号目录完全分开。不要挂载 `/root`、整个 `/` 或 Docker socket。项目代码可保存在默认 workspace 卷，也可自行挂载专用目录并设置 UID/GID 1000 的权限。

runner 固定安装版本见 Dockerfile；CLI API 变化可能需要升级和重新验收。镜像内没有厂商登录态。厂商登录只在用户自己的环境完成。可用引擎和模型最终由 CLI/账号提供。

## 原生 Linux 节点

在准备好的发布源码树中安装 Node.js 24、git、tmux 和需要的 CLI。推荐专用 OS 用户。先以该用户登录 CLI 并确认能在终端完成一个任务。

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
# 无 systemd worker slice 的环境显式关闭，不能声称拥有独立进程隔离。
export WA_WORKER_SLICE=0
node agent.js
```

以上前台启动用于验证；长期服务请使用 OS 服务管理器并保留相同环境、工作目录与用户。原生 worker slice 的创建与内存限额由运维配置，不能直接复制他人的绝对路径/内存值。首次版本不自动接管宿主机服务安装。

通过 SSH 将节点回环端口转发到控制台可达的位置；或监听私有网卡并设置防火墙只允许 Hub。公网跨机器直连需要可信 HTTPS 终结。设置 → 服务器管理中填写稳定 ID、Hub 视角地址和该节点令牌，先检测再保存。

禁用停止采集与路由；移除只移除纳管配置，保留历史，不停止远程 CLI。ID 代表历史归属，不能在编辑时改名；地址与显示名称可修改。重新添加相同 ID 将恢复该节点当前归属。

## 容器内 Codex 的沙箱

默认 Docker 安全策略可能禁止 Codex 内部 bwrap 创建命名空间。本项目的可选 runner 明确设置 `WA_CODEX_EXTERNAL_SANDBOX=1`，使用 Codex 的 externalSandbox 策略，由 Docker 提供外层隔离，网络允许出站。它不会获得宿主机 PID、Docker socket 或额外权限；原生节点仍使用原有 workspace-write 策略。

容器内的项目、CLI 账号和挂载目录均属于该执行节点可访问的范围，不能用于运行不可信租户任务。如需项目之间隔离，应部署独立 runner/OS 用户，不把多个不可信项目共用一个账号卷。可移除此环境变量尝试内层沙箱，但必须确认宿主机支持，不能默认认为有效。官方背景：[Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)。
