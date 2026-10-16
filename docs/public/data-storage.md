# 数据存储：默认能力与可选增强

[简体中文](data-storage.md) | [English](en/data-storage.md) · [首页](../../README.md)

初次使用不必把所有组件全部开启。默认 Compose 已提供 MySQL，执行节点保留自己的 CLI JSONL；Redis 和 MongoDB 仅在需要相应收益时添加。启用增强不会替你接入远程节点或登录 CLI，首次使用先看 [远程接入指南](remote-setup.md)。

| 组件 | 当前已接入的能力 | 适合何时开启 | 额外成本 |
|---|---|---|---|
| MySQL（默认） | 项目 Token/工作量统计、中心归档、项目小助理任务证据等持久化 | 标准安装已包含 | 数据卷、备份和数据库维护 |
| Redis（可选） | 额度缓存、节点心跳与短期状态缓存、待办通知去重 | 节点较多、额度探测慢、经常重启控制台 | 单独部署 Redis，配置网络/认证与资源 |
| MongoDB（可选） | 符合采集条件的结构化执行事件索引、历史时间线、会话概要、审批与节点状态审计 | 需要集中查看更细的事件时间线与审计 | 单独部署 MongoDB、索引/存储/备份和资源预算 |

Redis 中确实有锁/租约/幂等工具函数，但它们不等于产品已经实现多 Hub 高可用或所有写操作跨实例幂等。开启缓存也不会提高厂商模型的生成速度。MongoDB 事件投影不是 MySQL 任务证据的替代品；开启后不保证自动回填每个引擎的全部旧历史。

## Redis 能带来什么

控制台启用后会保存额度缓存，重启时可读回已有缓存和探测水位，减少再次启动 CLI/TUI 探测的等待；缓存有时间戳与过期策略，不是永远最新。待办通知利用去重窗口，减少控制台重启后重复通知。节点心跳与状态摘要使用短 TTL。

未启用时继续使用现有轮询、进程内缓存和通知去重。Redis 不可用时调用回退；缓存可以重建，不是长期历史的权威源。

## MongoDB 能带来什么

将符合采集条件的事件规范化、脱敏后建立索引，可查询会话时间线及近期项目/服务器事件；另有会话概要、审批和节点状态事件。必须同时配置 **`WA_MONGO_ENABLED=1` 与 `WA_EVENT_SHADOW_WRITE=1`** 才会进行执行事件投影。仅看到连接正常不代表已经在写事件。

默认执行事件和节点状态事件保留 180 天，审批审计 365 天，会话概要不设置 TTL。写失败的事件会暂存控制台本地 spool；在服务恢复且投影开启后尝试幂等补写。spool 有容量边界，不能当成永久备份。JSONL 仍在执行节点，MySQL 的任务证据/归档仍按既有功能保存。

## 如何启用

1. 先部署需要的外部服务，设置认证、可从控制台访问的网络和资源限额。不必同时部署两者。基础 Compose 不会因为打开开关就自动创建 Redis/MongoDB 服务。
2. 使用 rc.15 或后续版本的 `compose.yaml`，它会将这些配置传给控制台；只把值放进旧版 `.compose.env` 而没有 Compose 映射不会生效。
3. 在安装目录的私有 `.compose.env` 填写实际地址。下面只是模板，替换所有占位符，不要直接公开此文件。

```dotenv
# Redis：已有实例；redis:// 在可信私网使用，跨不可信网络使用相应加密连接。
WA_REDIS_ENABLED=1
WA_REDIS_URL=redis://your-redis:6379
WA_REDIS_PASS=replace-with-your-redis-password

# MongoDB：已有实例；用户、密码、数据库和 authSource 必须与实际部署一致。
WA_MONGO_ENABLED=1
WA_EVENT_SHADOW_WRITE=1
WA_MONGO_URI=mongodb://your-user:your-percent-encoded-password@your-mongo:27017/webagents_v2?authSource=admin
WA_MONGO_DB=webagents_v2
```

数据库 URI 中的特殊字符需要按 URI 规则编码；`.compose.env` 是 Compose 配置文件，不要在 shell 中 source 含特殊字符的连接串。`127.0.0.1` 在容器里指向控制台容器自身；填写容器可以实际到达的服务地址，不沿用任何私人节点 IP。

4. 沿用现有 Compose 文件组合，仅重新创建控制台；不是只执行 `restart`（环境变量需要重建容器才能载入）。

```bash
# 仅远程管理的安装
docker compose --env-file .compose.env -f compose.yaml up -d --no-deps --wait console

# 已使用本地 runner 的安装：保留相同文件组合，但只更新 console
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml up -d --no-deps --wait console
```

不需要重建 runner、停止远程 CLI 或删除数据卷。页面的说明和开关状态用于诊断，不会代替你安装数据库或修改服务器服务。

## 怎么确认带来了收益

- 设置 → 数据存储中应显示目标数据库“正常”；未启用标记是可选项，不是故障。
- Redis：查看已有额度缓存是否能在控制台重启后返回、检查同一待办在去重窗口内是否重复发送。首次没有缓存仍需实际采集，不承诺没有冷启动。
- MongoDB：确认事件投影开启，执行一个符合采集条件的新任务，检查已索引事件计数和时间线。没有事件时，应先核对投影开关、会话采集条件和连接，而不是假设过去所有历史已导入。
- `/api/v2/stats` 与 `/api/v2/health` 提供真实健康/开关/投影信息；端点受管理员认证。备份前先确认没有错误与持续增长的待补写积压。

## 备份与关闭

现有 `scripts/backup.sh` 覆盖 MySQL 和控制台卷，**不包含外部 MongoDB/Redis 实例，也不包含执行节点项目与 CLI 账号卷**。MongoDB 用它自己的备份流程；项目与凭据另外备份。Redis 作为缓存可重建，按自己的部署决定是否持久化。

关闭时将对应 `WA_REDIS_ENABLED` / `WA_MONGO_ENABLED` 设为 `0` 并重新创建控制台；关闭投影同时将 `WA_EVENT_SHADOW_WRITE=0`。关闭不删除外部库与历史数据。MySQL 故障会影响统计和历史持久化，不能将它归为“仅影响状态面板”。
