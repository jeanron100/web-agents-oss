# 首次使用：连接远程服务器

[简体中文](remote-setup.md) | [English](en/remote-setup.md) · [首页](../../README.md)

Web Agents 的主要用途是**在一个浏览器中管理多台服务器上的编码代理**。你安装的是管控台，代码与 Codex / Kimi / Claude CLI 留在执行节点。每台执行节点独立准备项目目录、CLI 登录与 Agent 令牌。

```text
你的浏览器 → Web Agents 管控台 → 远程执行节点 A → 项目与 CLI
                              → 远程执行节点 B → 项目与 CLI
```

rc.15 起，Mac / Windows 双击启动器的全新安装默认只启动管控台与 MySQL；登录后从看板进入“连接远程服务器”，或打开 `/getting-started`。本地容器体验是可选入口，已有安装继续沿用原模式。`WA_INSTALL_MODE` 保存在 `.compose.env`；旧安装没有这个字段时，通过实际已有的 runner 服务判断，不能仅因下载了新版就移除执行节点。

## 1. 准备一台执行节点

首选已有项目的 Linux 服务器。准备 Node.js 24、Git、tmux，以及至少一个已安装且已登录的编码 CLI。**运行 Agent 的系统用户应与登录 CLI、拥有项目目录的用户一致。** Web Agents 管理员登录不等于厂商 CLI 登录。

如果代码是 `~/workspaces/my-app`，项目根目录应设为 `~/workspaces`。项目列表显示这个根目录下的一级子目录，不会扫描任意磁盘，也不会自动上传电脑上的文件。

在执行节点下载对应版本源码或克隆公开仓库，然后运行：

```bash
git clone https://github.com/jeanron100/web-agents-oss.git "$HOME/web-agents"
cd "$HOME/web-agents/server"
npm ci --omit=dev
mkdir -p "$HOME/workspaces/my-app" "$HOME/.config/web-agents"
export WA_SERVER_ID=my-dev-server
export WA_PROJECT_ROOT="$HOME/workspaces"
export WA_AGENT_TOKEN_FILE="$HOME/.config/web-agents/node-token"
umask 077
# 仅首次生成；已有令牌继续使用，避免其他管控台失去连接。
if [ ! -s "$WA_AGENT_TOKEN_FILE" ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$WA_AGENT_TOKEN_FILE"
fi
export WA_AGENT_REQUIRE_TOKEN=1
export WA_AGENT_HOST=127.0.0.1
export WA_WORKER_SLICE=0
node agent.js
```

该命令在前台运行；先验证，再使用 tmux 或操作系统服务管理器保持运行，并保留相同用户、环境变量及工作目录。`WA_WORKER_SLICE=0` 用于尚未配置独立 systemd worker slice 的环境，不表示拥有独立进程隔离。不要直接复制私人部署的 IP、用户或 `/data` 路径。

## 2. 选择管控台可以访问的连接地址

**Agent 地址是管控台容器访问执行节点的 HTTP(S) 地址，不是 SSH 地址。** 浏览器能够访问一个地址，不代表 Docker 容器也能访问它。

| 连接条件 | Agent 监听与填写方式 |
|---|---|
| 有可信私有网络 / VPN，且容器可以访问服务器私网 IP | 将 `WA_AGENT_HOST` 改为该节点私网网卡 IP；防火墙仅允许管控台。填写 `http://节点私网IP:8788`，选择“直连内网” |
| 跨公网 | 保持 Agent 监听 `127.0.0.1:8788`，在执行节点前置带有效证书的 HTTPS 反向代理，填写 `https://agent.example.com`，选择“HTTPS” |
| 已有 SSH 隧道 | 隧道需要事先建立，填写管控台容器能访问的隧道端点；下拉选择本身不会创建隧道 |

`localhost` / `127.0.0.1` 在管控台容器内指向**该容器本身**。Mac / Windows 的宿主机路径也不是 Linux 执行节点路径。本地 Docker runner 在同一 Compose 网络内使用 `http://runner:8788`。

公网 HTTPS 反向代理需保留 Authorization 请求头，并支持 WebSocket 与不缓冲的事件流。例如在已有证书的 Nginx 中：

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

替换域名与证书位置，按服务器自己的部署流程验证并启用；此工具不自动申请证书、开启防火墙或部署 SSH 隧道。反向代理不是 Agent 接入令牌的替代品。

## 3. 添加并检测服务器

在管控台的 **设置 → 服务器管理 → 添加服务器** 中填写：

| 字段 | 示例与说明 |
|---|---|
| 服务器 ID | `my-dev-server`，稳定的历史归属标识 |
| 显示名称 | `开发服务器`，可随时修改 |
| Agent 地址 | 上一步从管控台容器可达的地址 |
| 接入令牌 | 执行节点 `WA_AGENT_TOKEN_FILE` 的内容；在自己的终端读取并粘贴，不发到群聊或截图 |
| 连接方式 | 内网、HTTPS 或事先建立的 SSH 隧道 |

先点击“测试连接”，确认项目根目录和 CLI 检测结果，再保存。节点列表中的“检测”可重复检查；“编辑”修改地址和显示名称，已有令牌留空保留；“禁用”停止轮询和路由；“移除”停止纳管并保留历史，不停止远程 CLI。历史归属 ID 不允许直接改名。

## 4. 确认项目与登录

在 `/getting-started` 选择节点，查看**真实项目根目录、原生/容器执行位置、CLI 安装情况、凭据文件迹象和项目数量**。凭据存在不代表授权有效，要以真实对话为准。新建会话会显示所选节点的实际目录；目录读取失败和真实空目录分别提示，可以刷新重试。

项目列表为空时：确认 Agent 的 `WA_PROJECT_ROOT`，在该目录下放入已有仓库或创建项目子目录；确认 Agent 用户可读写，并检查项目是否被隐藏。修改原生 Agent 环境变量后需按自己的服务管理方式重新启动该 Agent，不影响其他节点。不要为了修复列表删除认证卷或项目数据。

在**执行节点终端**完成 CLI 登录，例如 `codex login --device-auth`、`kimi login`，或启动 `claude` 后使用 `/login`。管控台不会把某台机器的厂商账号自动复制到其他节点。

## 5. 完成第一个任务

选择节点与项目，保留默认权限和模型，先发送：

> 说明这个项目的目录结构，不修改任何文件。

看到来自该节点的回答后，再尝试文件修改、测试、审批或会话恢复。代码始终在所选节点的项目目录中执行；执行历史和项目小助理用于追溯任务及来源。

## 可选：本地容器体验

没有远程服务器时，进入安装目录：

```bash
# Mac / Linux
bash scripts/quickstart.sh --runner --pull
```

```powershell
# Windows PowerShell
.\scripts\quickstart.ps1 -Runner -Pull
```

该选择会记住本地体验模式，并保留已有密码与镜像版本。默认 `/workspace` 是独立持久卷，初始为空；创建示例目录和文件：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner sh -lc 'mkdir -p /workspace/hello-world && echo "Hello Web Agents" > /workspace/hello-world/README.md'
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
```

如果先安装的控制台没有登记本地节点，在“添加服务器”填写 ID `local-runner`、地址 `http://runner:8788`、连接方式“本机”。令牌来自控制台与 runner 共用的专用卷；在自己的终端读取：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec -T console node -e 'process.stdout.write(require("fs").readFileSync("/run/web-agents/runner/token","utf8"))'
```

不要分享令牌。若初次安装就包含 runner，节点会自动登记。刷新项目列表后选择 `hello-world` 即可开始。已有宿主机代码需要专用 bind mount 和 UID/GID 1000 的访问权限；控制台不提供 Mac / Windows 原生进程接管。备份与升级边界见 [运维说明](operations.md)。

## 参考的首次使用模式

流程参考 [Claude Code Quickstart](https://code.claude.com/docs/en/quickstart) 的项目目录、登录与首个问题，以及 [Remote Control](https://code.claude.com/docs/en/remote-control) 对执行位置与连接状态的说明。Web Agents 增加多执行节点和多 CLI 管理，不使用 Claude 的连接服务；安装、鉴权和网络接入由自己的部署负责。
