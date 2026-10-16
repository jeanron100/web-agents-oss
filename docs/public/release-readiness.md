# v0.1.0-rc.11 发布验证与后续计划

[简体中文](release-readiness.md) | [English](en/release-readiness.md)

[公开仓库](https://github.com/jeanron100/web-agents-oss) · [候选版与交付附件](https://github.com/jeanron100/web-agents-oss/releases/tag/v0.1.0-rc.11) · [发布工作流](https://github.com/jeanron100/web-agents-oss/actions/workflows/publish.yml)

定位为单管理员或可信小团队的 Linux 管控台，容器交付扩展到 Linux amd64/arm64，以及 Docker Desktop 下的 Mac Intel/Apple Silicon 和 Windows x64（WSL 2）。各平台实测范围见 [桌面说明](desktop.md)。现有原生部署可以独立升级控制台，不需要迁入容器。

## 已交付

| 范围 | 内容 |
|---|---|
| 安装 | Compose 控制台/MySQL、可选非 root runner；amd64/arm64 镜像、带校验和的架构镜像包、Mac/Windows ZIP 与启动入口 |
| 首次使用 | 初始账号 admin / admin123、首次强制改密、登录退出、密码恢复；旧版令牌初始化兼容，升级保留已有账号 |
| 多服务器 | 页面添加、编辑、检测、禁用、移除；独立令牌，配置即时生效 |
| 执行体验 | Codex 即时补充/独立任务排队；多引擎对话、图片、终端及会话恢复 |
| 追溯 | 执行历史、任务证据、可选问答模型和 8 个只读 MCP 工具 |
| 运维 | 配置外置、持久卷、诊断、备份恢复、依赖清单、镜像摘要和构建证明 |

本版修复登录页深浅主题混用与低对比度，统一表单、错误提示和密码显隐；全新容器使用临时初始账号，后端强制改密后才能访问项目和终端。公开 Demo 使用虚构数据，展示 Codex/Kimi/Claude、额度趋势与任务证据示例。

## 实际验证

- 本版 GitHub 全新环境：后端/前端完整测试、TypeScript/构建、双架构 Compose 首次安装及隔离网关元数据验收均通过；具体计数和运行记录以本版 CI 为准。
- 应用 npm 依赖扫描无已知漏洞；最终镜像通过可修复 HIGH/CRITICAL 门槛。扫描使用 `ignore-unfixed=true`，不表示不存在其他等级或未修复漏洞。
- rc.5 发布时的原生隔离工作区和候选容器真实 Codex/Kimi：命令、文件修改、图片、中断与恢复；Codex 即时补充与后续任务排队。
- rc.5 镜像替换 runner 后，管理员配置与账号/工作区卷保留；既有 Codex、Kimi 会话可重新加载并完成新任务。最后的镜像修复为执行 Claude 官方安装脚本，业务代码及 Codex/Kimi 版本未改变。
- 真浏览器：首次登录、服务器增删改/禁用及令牌不回显；1440/390/320 宽度无横向溢出和脚本错误。
- 匿名终端拒绝；登录后经 Hub/节点鉴权执行终端命令，读取真实任务文件；stdio MCP 列出 8 个工具并查询实际节点。
- MySQL 标记记录备份、删除、恢复后读回；恢复后管理员仍能登录，runner 容器未因控制台备份而重建。
- 干净导出清单逐文件 SHA-256 验证；非测试凭据匹配为 0。原私人 Git 历史没有公开。

固定 CLI 为 Codex 0.159.2、Kimi Code 2.2.0、Claude Code 2.1.301。构建会以非 root 用户实际运行三个版本命令。Claude 仅验证可执行文件和版本，未登录厂商账号进行推理验收；用户仍需使用自己的合法账号。许可来源与交付条件见 [第三方说明](third-party-notices.md)。

## 使用边界

控制台重启不终止远程原生 CLI；runner 替换会停止其内部进程，需保留卷并恢复会话。控制台备份不包含 runner 账号与工作区卷。未提供 Windows/macOS 原生进程接管，也未验证不可信用户之间的隔离，不能据此宣称多租户安全。

## 后续优先级

P1：节点向导内的厂商登录状态实测、CLI 兼容矩阵、可视化升级/回滚与备份状态、持续故障提示，以及更轻的按引擎选择的 runner。

P2：多用户/RBAC、项目级隔离、配额与成本策略、通知渠道扩展，以及更轻的单节点存储方案。优先保持从空环境安装到首个真实任务的完整体验。
