# Web Agents

自托管的多服务器 AI 编码代理管控台。在手机或桌面浏览器管理 Codex、Kimi 和 Claude 的对话、审批、执行记录、终端和项目进展。

当前交付定位：单一管理员或可信小团队，Linux 执行节点。不是面向不可信用户的多租户执行平台。CLI 使用各自厂商账号，订阅、模型和调用权限由厂商决定。

## 容器快速开始

需要 Docker Engine、Compose v2+。建议至少 4 GB 内存和 12 GB 空闲磁盘。当前验收平台为 Linux amd64。容器 runner 使用 Docker 外层隔离，详见安装文档；只用于可信项目。

```bash
git clone https://github.com/jeanron100/web-agents-oss.git
cd web-agents-oss
./scripts/quickstart.sh --runner --pull
```

打开 `http://localhost:5188`，获取初始化令牌：

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs setup-token
```

创建管理员后登录。执行容器已自动注册为“本机容器节点”。先在执行容器登录需要使用的 CLI：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner kimi login
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner bash
# 在 shell 中创建项目：mkdir -p /workspace/my-project
```

页面设置 → 服务器管理 → 检测，可以查看 CLI 版本和登录文件是否存在；文件存在不等于厂商认证成功。只需要控制台时使用 `./scripts/quickstart.sh --pull`，然后添加已部署的远程执行节点。预构建安装先尝试 GHCR；不可用时从公开 Release 下载并校验镜像包，需要 `curl` 和 `sha256sum`。省略 `--pull` 可从源码构建，需要访问 npm；构建不需要提供账号凭据。

默认仅绑定回环地址。远程访问优先使用 SSH 转发：`ssh -L 5188:127.0.0.1:5188 your-server`。正式公网使用 HTTPS 反向代理，设置 `.compose.env` 的 `WA_PUBLIC_URL` 为实际域名后重建控制台。

## 能力与边界

- 多节点看板、项目状态、待审批收件箱和真实事件对话流。
- Codex 当前任务即时补充与独立任务排队；Kimi/Claude 依各自 CLI 支持运行。
- 项目小助理：从执行历史和任务证据追溯交办、结果、处理方法和风险；可选兼容 Chat Completions 的问答模型。
- 额度窗口、重置时间、Token 趋势；额度与 Token 用量分别统计。
- 图片预览、文件查看和 Web 终端。
- stdio MCP 提供受限只读查询，可接入其他工具。

控制台重启不终止远程原生 CLI。**执行容器重建会终止容器内 CLI**；工作目录与 CLI 登录/历史放在独立卷中，恢复会话需要重新加载。原生节点依赖宿主机 systemd/tmux/cgroup；容器节点没有宿主机进程接管能力。

## 文档与开发

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
