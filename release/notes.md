# Web Agents v0.1.0-rc.14 — simpler setup and optional monitoring / 简化初始化与可选监控

- New passwords now require **8–256 characters**, reduced from 12. No uppercase, number or special-symbol combinations are required. Manual setup, mandatory initial-password change and account settings use the same backend rule.
- Chinese and English form hints, validation errors and installation guides match the new minimum.
- Fresh installations still start with **admin / admin123**. Choose a different password at first sign-in; the temporary password cannot be reused to bypass setup. Existing accounts, passwords and project data are preserved.
- Hides Monitoring from both desktop and mobile navigation when no external monitoring URL is configured. Saving or clearing the URL in settings updates navigation immediately.
- Includes the previous bilingual onboarding, theme/contrast fixes and English documentation.

新密码最低长度由 12 位调整为 **8 位**，不强制大小写、数字或特殊符号组合。前后端校验、中英文提示和文档同步更新。未配置外部监控时隐藏桌面和手机的监控入口，保存或清空配置后即时更新。首次登录仍需更换临时密码，升级保留已有账号、密码和项目数据。

Mac/Windows require Docker Desktop. Existing installations keep pinned images: update the console image reference to **v0.1.0-rc.14**, pull it and recreate only the console. This password change does not require a runner upgrade or deletion of any data volume. Published older versions remain unchanged.
