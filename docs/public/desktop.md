# Mac / Windows 快速交付

通过 Docker Desktop 在个人电脑启动完整控制台、数据库和执行节点；网页功能与 Linux 部署一致。代码和厂商登录态默认保存在 Docker 命名卷，免安装宿主机 Node、Git 或 Python。

## 平台与前提

| 电脑 | Docker 引擎 | 入口 |
|---|---|---|
| Mac Intel | Linux amd64 | `start-macos.command` 或 Bash |
| Mac Apple Silicon（M 系列） | Linux arm64，原生镜像 | `start-macos.command` 或 Bash |
| Windows x64 | Docker Desktop WSL 2，Linux amd64 | `start-windows.cmd` 或 PowerShell 5.1+ |
| Linux amd64/arm64 | Docker Engine + Compose v2 | Bash |

需先安装并启动 [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) 或 [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)，Windows 使用 [WSL 2 后端](https://docs.docker.com/desktop/features/wsl/) 并开启 Linux 容器。系统版本/硬件虚拟化要求以 Docker 当前官方说明为准；Windows Server、Windows ARM 桌面不在此次宿主机验收范围内。

建议给 Docker 至少 4GB 内存，电脑至少 12GB 空闲磁盘。Docker Desktop 自身许可依官方条款执行。本项目不自动安装 Docker 或修改系统执行策略。

## 下载与启动

1. 从 [Release](https://github.com/jeanron100/web-agents-oss/releases) 下载对应 `web-agents-<版本>-macos.zip` 或 `-windows.zip` 及 `.sha256`。这些是安装配置包；第一次启动会下载适合引擎架构的镜像。
2. 校验后**完整解压**到用户可写目录，例如 `~/Applications/Web Agents` 或 `%USERPROFILE%\Web Agents`。不要在 ZIP 预览中运行，也不要放共享目录或云盘同步目录。
3. 启动 Docker Desktop，等待引擎就绪。Mac 双击 `start-macos.command`；Windows 双击 `start-windows.cmd`。如系统因下载来源要求确认，只在确认下载来源可信后允许该文件；不需要全局关闭系统保护。
4. 等待服务 Healthy，打开 `http://localhost:5188`。**全新安装的初始用户名：`admin`；初始密码：`admin123`。** 首次登录必须设置至少 12 位的新密码，再重新登录使用。已有安装升级会保留原账户，不会覆盖密码；仍处于旧版令牌初始化阶段的安装也会保留原流程。

可先在 [在线 Demo](https://webagents.jeanron100.top/demo/) 免登录体验虚构项目，或查看 [产品介绍](https://webagents.jeanron100.top/demo.html)。演示数据不连接真实服务器。

macOS 如解压工具未保留执行权限，可在终端进入解压目录后运行：

```bash
bash scripts/quickstart.sh --runner --pull
```

Windows 可在解压目录打开 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\quickstart.ps1 -Runner -Pull
```

此 Bypass 仅限该次进程，不修改持久系统策略。只需管理远程服务器时去掉 `--runner` / `-Runner`。首次生成 `.compose.env`，之后启动保留原有密码和镜像配置。端口默认只监听回环；网络公开配置见 [运维说明](operations.md)。

## CLI 登录和项目

在终端从解压目录执行（各平台相同）：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner kimi login
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner bash
# 容器 shell 内：mkdir -p /workspace/my-project
```

厂商账号由自己登录，不在镜像中共享。项目默认在 `/workspace` 卷中；可用 `docker compose ... cp` 复制文件或在容器内克隆仓库。Mac/Windows 宿主目录的绑定挂载通常涉及性能和权限差异，默认命名卷更适合高频开发 I/O。

支持的是 Linux 容器执行环境，不自动接管电脑上已有的原生 CLI 进程、Windows 服务或 macOS LaunchAgent。远程 Linux 节点仍可在页面“设置 → 服务器管理”接入。

## 校验、停止和升级

Mac 校验 ZIP：`shasum -a 256 web-agents-<版本>-macos.zip`。Windows：`Get-FileHash .\web-agents-<版本>-windows.zip -Algorithm SHA256`。将输出与同名 `.sha256` 比对。

停止服务而保留数据（各平台相同）：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml down
```

再次启动运行原来的入口文件。不要加 `-v`，该参数会删除数据库、CLI 账号和项目卷。不要删除 Docker Desktop 的数据盘。备份及升级步骤见 [运维说明](operations.md)；升级时保留旧 `.compose.env`，显式更新其中两个镜像版本，沿用同一 Compose project/卷。不要同时从不同目录启动两个指向同一端口的安装。

拉取失败时，入口自动下载同版本、同架构的 Release 镜像包并先校验 SHA-256。可提前下载对应 `web-agents-images-linux-amd64.tar.gz` / `arm64.tar.gz` 及校验和，通过 `docker load --input <文件>` 导入。Apple Silicon 应使用 arm64。自定义镜像拉取失败不会被替换成官方镜像。

## 验证范围

发布流水线在真实 macOS/Windows shell 中执行从 ZIP 解压的安装入口，验证路径带空格、随机密码与配置保留、架构选择、失败退出、下载与校验拒绝。Docker 引擎和下载在这些 shell 用受控测试替身，以免将启动 Docker Desktop GUI 的硬件条件与应用测试混淆。

实际镜像构建、三个 CLI 版本运行、Compose 健康检查和首次认证流程在原生 Linux amd64/arm64 CI 节点执行。未将这些检查描述成真实 Mac/Windows Docker Desktop 图形桌面的人工验收。
