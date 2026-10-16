# 配置与运维

## 配置来源

真实环境变量优先于 `server/.env`。容器不复制 `.env`。关键配置：

| 配置 | 用途 |
|---|---|
| `WA_HUB_CONFIG` | 节点列表、停用/退役信息、可选额度账号映射；私有 JSON |
| `WA_DATA_DIR` / `HOME` | 控制台状态 / CLI 与历史目录；容器均挂独立卷 |
| `WA_PROJECT_ROOT` | 节点项目目录；容器默认 `/workspace` |
| `WA_AUTH_ENABLED=1` | 内置管理员认证；容器强制开启 |
| `WA_PUBLIC_URL` | 浏览器实际访问 origin；HTTPS 时启用 Secure cookie |
| `WA_MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` | 中心历史、任务证据、日统计；启动自动创建所需表 |
| `WA_AGENT_TOKEN_FILE` | 节点接入密钥文件；配合 `WA_AGENT_REQUIRE_TOKEN=1` |
| `WA_ASSISTANT_MODEL_CONFIG` | 可选问答模型配置；页面保存，密钥不回显 |

默认不启用 Redis/MongoDB/向量检索和外部监控。未配置不会被当成部署故障。MySQL 是默认持久历史依赖。服务器、监控与问答模型可在设置中配置。Claude/Kimi TUI 额度采集需要显式选择已登录节点；Codex 按真实账号合并，不能把节点数当作账号数。

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

备份会短暂停控制台写者，导出 MySQL 和完整控制台卷，保存校验和；远程 CLI 不受影响。恢复校验文件后替换当前数据库内容和控制台卷，沿用目标安装的数据库密码。遇到错误时控制台保持停止，修复后再启动，避免带不完整状态对外工作。

runner 的账号、JSONL 和项目代码在 `runner-home`、`runner-workspace` 两卷，**不包含在控制台备份中**。请另外备份，在没有活动写者时做一致快照；不自动停止正在进行的 CLI 任务。备份内有私人历史与令牌，需自行加密并限制访问。

## 升级与回滚

先备份，再在隔离端口/独立 Compose project 中用目标镜像验证。控制台与 runner 可分别升级；只更新控制台不会停止 runner。升级 runner 前先完成任务。`up -d --build console` 后检查健康与实际页面，再继续工作。

不要用 `down -v` 做升级，它会删除持久数据。数据库迁移目前为追加式建表/字段；不能假定旧镜像可读所有新数据。回滚镜像需要使用匹配备份，不应直接强行降级生产库。

## 容器验收

```bash
node scripts/container-smoke.mjs http://127.0.0.1:5188 \
  /path/to/private/setup-token-file
```

仅在全新隔离安装运行；脚本创建测试管理员、验证认证与节点 CRUD、密钥不回显、跨源拒绝，并删除测试节点。首次公开前还需完成：镜像来源/依赖检查、厂商真实任务及权限行为验收、备份恢复、桌面和手机页面检查。实际验证记录在发布评估文档中，不能以启动成功替代真实 CLI 验收。

## 首次公开发布的边界

发布工作流仅手动触发；配置 GitHub 的 `release` environment 保护，使用明确版本标签。当前代码没有自动把私有部署发布到互联网。首次发布前应确认：公开仓库地址、镜像注册表、漏洞私报入口、第三方 CLI/SDK 的镜像再分发许可、依赖/SBOM 检查，以及登录厂商账号后的真实任务验收。源码 ISC 许可证不覆盖第三方软件。

既有私人 Git 历史曾包含静态认证值。导出包不带 `.git` 和这些部署记录；扫描报告只输出规则、文件位置和提交号。若计划公开原历史，需要另行清理历史并轮换相关凭据，不能以当前文件已清理替代。
