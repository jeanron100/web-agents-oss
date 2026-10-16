# Web Agents v0.1.0-rc.15 — remote-first onboarding / 远程管理首次使用引导

- Fresh Mac/Windows desktop launches start the console and MySQL for remote management. Optional local execution can be enabled explicitly. Existing mode, accounts, image pins and project data are preserved; legacy installations are inspected for an existing runner.
- Adds an English/Chinese first-use guide: prepare a Linux execution node, connect/test it, check real project roots and CLI readiness, and run a first task. The empty dashboard links directly to remote connection or a local trial.
- New Session shows the selected node’s actual project root rather than a fixed `/data` label. Loading, failed requests and genuinely empty folders are distinct; folder refresh, setup links and CLI-install/login hints provide next actions. Older nodes without diagnostics remain usable.
- Settings explain default MySQL persistence and implemented optional Redis/MongoDB benefits, configuration, verification, retention and backup boundaries. Compose forwards their opt-in environment variables but does not deploy the optional services automatically.
- Adds English/Chinese remote setup and data-storage guides. Retains rc.14’s eight-character password minimum and hidden unconfigured Monitoring navigation.

全新桌面安装默认优先远程管理；已有安装保留原模式和数据。新增中英文接入向导与真实准备状态检测；项目路径来自执行节点，空列表和读取失败分别给出下一步。Redis/MongoDB 说明实际收益、启用配置、验证与备份边界，不把可选项当成首次使用必备。

Mac/Windows require Docker Desktop. Existing installations keep their image references: explicitly update the console image to **v0.1.0-rc.15**, use the new Compose file and recreate only the console. These UI/guidance changes do not require updating a remote agent or replacing an existing runner. Published older releases remain unchanged.
