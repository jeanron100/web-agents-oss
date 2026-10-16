# Web Agents

[简体中文](README.md) | [English](README.en.md)

自托管的多服务器 AI 编码代理管控台。在手机或桌面浏览器管理 Codex、Kimi 和 Claude 的对话、审批、执行记录、终端和项目进展。

当前交付定位：单一管理员或可信小团队，Linux 执行节点。不是面向不可信用户的多租户执行平台。CLI 使用各自厂商账号，订阅、模型和调用权限由厂商决定。

[在线 Demo（虚构数据，免登录）](https://webagents.jeanron100.top/demo/) · [产品介绍](https://webagents.jeanron100.top/demo.html) · [功能与竞品比较](docs/public/comparison.md)

文档、宣传页及登录/初始化/账户改密提供中英文；登录页可通过 English / 中文 切换并记住选择。主控制台和 Demo 内部仍有中文界面，CLI 对话与项目原文不自动翻译。

## 为什么使用 Web Agents

当项目分散在几台服务器、同时使用不同编码 CLI 时，你需要及时知道：哪个项目在运行、哪里等你审批、之前交办的事有没有解决，以及结论依据是什么。Web Agents 把这些入口集中到一个可以在手机和桌面使用的管控台，减少逐台 SSH、逐个终端和逐段聊天记录之间的切换。

它适合独立开发者、自托管用户和管理多个远程项目的可信小团队，尤其适合同时承担开发与运维工作的维护者。

## 亮点特性

| 特性 | 带来的价值 |
|---|---|
| **多服务器、多个项目，一张看板** | 按服务器或应用查看项目，集中掌握运行状态和待办；节点可在页面添加、检测、禁用与移除 |
| **Codex / Kimi / Claude 统一入口** | 使用节点上各自 CLI 的账号与会话，在浏览器查看对话、工具事件、图片并按支持情况继续会话 |
| **手机上也能处理待办** | 审批、提问、计划和变更待验收集中到收件箱，快速找到需要人工处理的项目 |
| **补充信息及时送达** | Codex 默认将补充信息追加到当前回合；独立新任务可选择排队，在当前回合结束后执行 |
| **执行历史变成可追溯的项目进展** | 小助理围绕“交办什么、进展如何、怎么解决、还有什么风险”检索任务证据，保留来源与覆盖范围提示 |
| **额度与消耗分别看清** | 查看订阅使用率、重置时间和历史变化，以及 Token 用量、引擎趋势和项目消耗；问答模型另显示实际模型、用量与兼容告警 |
| **外部工具也能了解项目** | 8 个受限只读 MCP 工具查询纳管节点、会话、待办、任务证据和进展，接入自己的助理工作流 |
| **终端与文件协同查看** | 内置 Web 终端、文件查看和图片预览，便于检查执行结果与登录二维码 |
| **按版本下载，自托管部署** | Linux 双架构镜像，Mac/Windows Docker Desktop 启动包；支持空环境初始化、持久卷、诊断和备份恢复 |

各引擎能力不完全相同，Claude 的真实推理尚未纳入本次公开版验收。详细说明见 [功能亮点与竞品比较](docs/public/comparison.md) 和 [发布验证](docs/public/release-readiness.md)。

## 版本下载

当前预发布：**[v0.1.0-rc.15](https://github.com/jeanron100/web-agents-oss/releases/tag/v0.1.0-rc.15)**。所有版本独立保存在 [GitHub Releases](https://github.com/jeanron100/web-agents-oss/releases)，可按版本下载和核对更新说明。

| 系统 | 下载 | 解压后启动 |
|---|---|---|
| macOS Intel / Apple Silicon | [Mac 安装包](https://github.com/jeanron100/web-agents-oss/releases/download/v0.1.0-rc.15/web-agents-v0.1.0-rc.15-macos.zip) | `start-macos.command` |
| Windows x64 | [Windows 安装包](https://github.com/jeanron100/web-agents-oss/releases/download/v0.1.0-rc.15/web-agents-v0.1.0-rc.15-windows.zip) | `start-windows.cmd` |
| Linux amd64 / arm64 | [版本源码包](https://github.com/jeanron100/web-agents-oss/releases/download/v0.1.0-rc.15/web-agents-v0.1.0-rc.15.tar.gz) | `bash scripts/quickstart.sh --pull` |

需先安装并启动 Docker（Mac/Windows 使用 Docker Desktop，Windows 开启 WSL 2 Linux 容器）。Release 附有校验和及按架构区分的镜像包，启动时自动选择引擎架构。`-rc.*` 为预发布，`vX.Y.Z` 为正式版本。

## 第一次使用：优先连接远程服务器

本地安装的是管控台，代码与 CLI 继续在执行节点运行。新用户先看 [连接远程服务器](docs/public/remote-setup.md)，按“准备节点 → 连接检测 → 确认项目目录与 CLI 登录 → 第一个任务”完成接入。登录后的 `/getting-started` 提供相同的中英文引导与真实节点检测。

## 容器快速开始

需要 Docker Engine、Compose v2+。建议至少 4 GB 内存和 12 GB 空闲磁盘。支持 Linux amd64/arm64，以及安装 Docker Desktop 的 macOS（Intel/Apple Silicon）和 Windows（WSL 2 Linux 容器）。容器 runner 使用 Docker 外层隔离，详见安装文档；只用于可信项目。

```bash
git clone https://github.com/jeanron100/web-agents-oss.git
cd web-agents-oss
./scripts/quickstart.sh --pull
```

Mac/Windows 可直接从 [Release](https://github.com/jeanron100/web-agents-oss/releases) 下载对应的 `macos.zip` / `windows.zip`，完整解压到用户目录后启动 `start-macos.command` / `start-windows.cmd`。不需要安装 Git 或 Node；先安装并启动 Docker Desktop。Windows 命令行入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\quickstart.ps1 -Desktop -Pull
```

完整平台前提、下载校验和停止/升级方法见 [Mac/Windows 快速交付](docs/public/desktop.md)。

打开 `http://localhost:5188`。**全新容器安装的初始用户名为 `admin`，初始密码为 `admin123`。** 首次登录后，必须设置至少 8 位的新密码，再重新登录，才能访问项目、终端和设置。升级保留已有账号和密码，不会重置为初始密码。

忘记已有密码时，在安装目录执行：

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs reset-password
docker compose --env-file .compose.env restart console
```

此命令保留原用户名、将临时密码重置为 `admin123` 并撤销旧会话；重启控制台后需重新设密。可在首次启动前设置 `WA_INITIAL_ACCOUNT=0` 使用一次性令牌手动创建管理员，详见 [运维说明](docs/public/operations.md)。

全新 Mac/Windows 双击安装默认只启动管控台与 MySQL；先从看板进入“连接远程服务器”。已有安装保留原模式。若需要本地容器体验，先运行 `bash scripts/quickstart.sh --runner --pull`（Windows 使用 `-Runner -Pull`），再在执行容器登录 CLI：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner kimi login
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner bash
# 在 shell 中创建项目：mkdir -p /workspace/my-project
```

页面设置 → 服务器管理 → 检测，可以查看 CLI 版本和登录文件是否存在；文件存在不等于厂商认证成功。本地容器项目默认在 `/workspace`，不是电脑上的任意目录。首次只装控制台、后来开启 runner 时按 [接入指南](docs/public/remote-setup.md) 登记本地节点。预构建安装先尝试 GHCR；不可用时从公开 Release 下载并校验镜像包，Bash 入口需要 `curl` 和 `sha256sum` 或 `shasum`，Windows 使用 PowerShell 内置下载与校验。省略 `--pull` 可从源码构建，需要访问 npm；构建不需要提供账号凭据。

默认仅绑定回环地址。远程访问优先使用 SSH 转发：`ssh -L 5188:127.0.0.1:5188 your-server`。正式公网使用 HTTPS 反向代理，设置 `.compose.env` 的 `WA_PUBLIC_URL` 为实际域名后重建控制台。

可选 Redis / MongoDB 的能力收益、配置与验证见 [数据存储说明](docs/public/data-storage.md)，首次使用不必开启全部组件。

## 运行边界

控制台重启不终止远程原生 CLI。**执行容器重建会终止容器内 CLI**；工作目录与 CLI 登录/历史放在独立卷中，恢复会话需要重新加载。原生节点依赖宿主机 systemd/tmux/cgroup；容器节点没有宿主机进程接管能力。

## 文档与开发

- [为什么选择、功能亮点与竞品比较](docs/public/comparison.md)
- [发布验证与后续计划](docs/public/release-readiness.md)
- [安装与远程节点](docs/public/installation.md)
- [配置、升级、备份与恢复](docs/public/operations.md)
- [MCP 接入](docs/public/mcp.md)
- [安全边界与漏洞报告](SECURITY.md)
- [第三方软件与交付边界](docs/public/third-party-notices.md)
- [贡献说明](CONTRIBUTING.md)

```bash
cd server && npm ci && npm test
cd ../web && npm ci && npm test && npm run build
```

默认不存在真实服务器、账号或演示数据；只有显式 `VITE_DEMO=1` 构建展示虚构数据。

## 公开源码维护

项目最初用于私人部署；公开版由干净导出建立，未包含原私人 Git 历史。维护者同步公开源码时继续使用可核查的导出：

```bash
node scripts/export-public.mjs /absolute/new-export
node scripts/scan-secrets.mjs /absolute/new-export
```

导出包含源码清单和 SHA-256 校验值；不包含私有配置、运行数据和运维记录。扫描只是辅助检查，不能证明不存在秘密。公开仓库为 `jeanron100/web-agents-oss`，版本镜像位于同名 GHCR 命名空间；当前候选版本见 `release/version`。原私人仓库和历史不会随导出公开。

ISC 许可证。Codex、Kimi、Claude 及依赖各遵循自己的许可证、账号和服务条款；本项目不授予这些产品的使用权。
