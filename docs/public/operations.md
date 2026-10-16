# 配置与运维

[简体中文](operations.md) | [English](en/operations.md)

## 配置来源

真实环境变量优先于 `server/.env`。容器不复制 `.env`。关键配置：

| 配置 | 用途 |
|---|---|
| `WA_HUB_CONFIG` | 节点列表、停用/退役信息、可选额度账号映射；私有 JSON |
| `WA_DATA_DIR` / `HOME` | 控制台状态 / CLI 与历史目录；容器均挂独立卷 |
| `WA_PROJECT_ROOT` | 节点项目目录；容器默认 `/workspace` |
| `WA_AUTH_ENABLED=1` | 内置管理员认证；容器强制开启 |
| `WA_INITIAL_ACCOUNT=1` | 全新容器安装创建 `admin / admin123` 初始账号，首次强制改密；已有认证状态不覆盖。设为 `0` 改用一次性令牌初始化 |
| `WA_PUBLIC_URL` | 浏览器实际访问 origin；HTTPS 时启用 Secure cookie；`localhost` 与 `127.0.0.1` 要与访问地址保持一致 |
| `WA_MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` | 中心历史、任务证据、日统计；启动自动创建所需表 |
| `WA_AGENT_TOKEN_FILE` | 节点接入密钥文件；配合 `WA_AGENT_REQUIRE_TOKEN=1` |
| `WA_ASSISTANT_MODEL_CONFIG` | 可选问答模型配置；页面保存，密钥不回显 |

默认不启用 Redis/MongoDB/向量检索和外部监控。未配置不会被当成部署故障。MySQL 是默认持久历史依赖。服务器、监控与问答模型可在设置中配置。Claude/Kimi TUI 额度采集需要显式选择已登录节点；Codex 按真实账号合并，不能把节点数当作账号数。


未配置监控页面地址时，桌面侧栏和手机底栏都隐藏“监控”；在设置中保存地址后自动显示，清空地址并保存后再次隐藏。

## 版本与问答调用信息

`GET /api/health` 的 `version` 包含完整发布后缀（如 `0.1.0-rc.10`），`releaseTag` 为对应 Git 标签。版本权威是 `release/version`，公开导出会生成运行时模块；镜像构建前和实际健康检查均核对一致性。

项目小助理的 `analysis.modelCalls` 分别保留规划和归纳调用的实际模型、提供方、请求标识、网关报告的 Token 计数及兼容告警。`metadata.resolved_model` 优先于可能仍为 `auto` 的顶层 `model`；未知用量保留 `null`，页面显示“未返回”。告警如 `max_tokens` 被忽略会直接展示，不能把请求参数当作已执行的限制。原始响应和凭据不回显。已有缓存问答只展示同一批调用，不按轮询次数重复计量；旧问答不补造当时未保存的用量。MCP 保留精简版信息并标明告警截断。

## 检测

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs doctor
docker compose --env-file .compose.env ps
docker compose --env-file .compose.env logs --tail 80 console
```

检测输出只含配置是否可读、节点连接和 CLI 版本/凭据存在标志；不输出令牌或密钥。查看日志前仍应确认没有任务文本等私人内容。

## 备份与恢复

```bash
./scripts/backup.sh /absolute/private-backup
# 恢复到已初始化的目标安装（先核对 Compose project/volume）
./scripts/restore.sh /absolute/private-backup --replace
```

Mac 可直接使用这些 Bash 脚本，校验兼容系统自带 `shasum`。Windows 的备份/恢复脚本在启用 Docker Desktop 集成的 WSL Linux shell 中运行，从 `/mnt/c/...` 进入同一安装目录；日常启动、停止与升级可直接在 PowerShell 完成。

备份会短暂停控制台写者，导出 MySQL 和完整控制台卷，保存校验和；远程 CLI 不受影响。恢复校验文件后替换当前数据库内容和控制台卷，沿用目标安装的数据库密码。遇到错误时控制台保持停止，修复后再启动，避免带不完整状态对外工作。

runner 的账号、JSONL 和项目代码在 `runner-home`、`runner-workspace` 两卷，**不包含在控制台备份中**。请另外备份，在没有活动写者时做一致快照；不自动停止正在进行的 CLI 任务。备份内有私人历史与令牌，需自行加密并限制访问。

## 升级与回滚

先备份，再在隔离端口/独立 Compose project 中用目标镜像验证。控制台与 runner 可分别升级；只更新控制台不会停止 runner。升级 runner 前先完成任务。`up -d --build console` 后检查健康与实际页面，再继续工作。

预构建安装的镜像地址保存在 `.compose.env`，更新源码不会自动改掉已固定的镜像版本。将 `WA_CONSOLE_IMAGE` 和需要升级的 `WA_RUNNER_IMAGE` 改为目标 Release 中的版本，保留数据库密码。沿用安装时的 Compose 文件组合；使用 runner 的安装可分两步更新：

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml pull console
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml up -d --no-deps --wait console
# 活动任务结束后再更新执行节点
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml pull runner
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml up -d --no-deps --wait runner
```

`quickstart.sh --runner --pull` 会处理控制台和 runner，适合首次安装或已准备好同时更新的环境。GHCR 不可用时会使用公开 Release 的镜像包；加载前必须通过 SHA-256 校验，不会静默绕过校验或替换自定义镜像。

不要用 `down -v` 做升级，它会删除持久数据。数据库迁移目前为追加式建表/字段；不能假定旧镜像可读所有新数据。回滚镜像需要使用匹配备份，不应直接强行降级生产库。

## 容器验收

```bash
node scripts/container-smoke.mjs http://127.0.0.1:5188 \
  /path/to/private/setup-token-file
```

仅在全新隔离安装运行；脚本创建测试管理员、验证认证与节点 CRUD、密钥不回显、跨源拒绝，并删除测试节点。首次公开前还需完成：镜像来源/依赖检查、厂商真实任务及权限行为验收、备份恢复、桌面和手机页面检查。实际验证记录在发布评估文档中，不能以启动成功替代真实 CLI 验收。

## 初始账号、改密与恢复

v0.1.0-rc.11 起，全新容器安装提供用户名 **`admin`**、密码 **`admin123`**。首次登录只允许修改密码和退出；后端同时拦截项目数据、设置、执行与终端访问，不依赖页面隐藏。设置至少 8 位的新密码后，初始密码失效、旧登录会话撤销，需重新登录。应在向其他人开放服务前完成设置。原生节点/Hub 默认保留令牌初始化方式。

已有 `auth.json` 的安装不会被此选项覆盖，包括旧版尚未完成的令牌初始化。若希望新安装自行创建管理员，在首次启动前在 `.compose.env` 中设 `WA_INITIAL_ACCOUNT=0`，启动后运行 `docker compose --env-file .compose.env exec console node server/manage.mjs setup-token` 获取令牌，在页面创建自己的账号。

忘记已有密码时，只能由有权限操作安装目录和容器的维护者在终端恢复：

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs reset-password
docker compose --env-file .compose.env restart console
```

恢复保留原用户名，将临时密码重置为 `admin123`，撤销旧会话；重启控制台加载新状态后，必须重新设置密码。只重启控制台，不重建 runner，也不停止远程 CLI。正常改密使用页面“设置 → 账户”。

## 按版本发布

公开仓库推送 `v*` 标签会自动发布对应版本，亦可从 Actions 手动重试尚未公开的版本。标签必须是真实 Git tag、与 `release/version` 一致且符合 `vX.Y.Z` / `vX.Y.Z-rc.N` 格式。维护者先从私有源导出干净源码、核对清单与更新说明，再在公开仓库创建并推送该版本标签；不要向公开仓库推送私有历史。

流水线通过单元测试、三个系统的启动脚本检查、双架构镜像构建/高危漏洞扫描/实际 Compose 初始化后，生成版本源码包、Mac/Windows ZIP、架构镜像包、校验和、依赖清单与来源证明。附件上传并校验后自动公开 Release。带预发布后缀的版本标为 prerelease，不替换稳定版 Latest；`vX.Y.Z` 正式版本标为稳定版 Latest。

每个版本独立保留。工作流在构建前拒绝已公开版本，按版本串行化，避免重建或覆盖既有版本；已发布包的修复使用新版本号。维护者需要同步更新首页版本下载链接。版本发布不会自动升级现有安装；安装中的 `.compose.env` 仍固定原版本，升级按上面的步骤显式进行。运行中的私人部署不会被发布工作流替换。源码 ISC 许可证不覆盖第三方软件，许可来源见第三方说明。

既有私人 Git 历史曾包含静态认证值。导出包不带 `.git` 和这些部署记录；扫描报告只输出规则、文件位置和提交号。若计划公开原历史，需要另行清理历史并轮换相关凭据，不能以当前文件已清理替代。
