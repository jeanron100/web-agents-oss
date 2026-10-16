# Web Agents v0.1.0-rc.13 — simpler password setup / 更轻松的密码设置

- New passwords now require **8–256 characters**, reduced from 12. No uppercase, number or special-symbol combinations are required. Manual setup, mandatory initial-password change and account settings use the same backend rule.
- Chinese and English form hints, validation errors and installation guides match the new minimum.
- Fresh installations still start with **admin / admin123**. Choose a different password at first sign-in; the temporary password cannot be reused to bypass setup. Existing accounts, passwords and project data are preserved.
- Includes the previous bilingual onboarding, theme/contrast fixes and English documentation.

新密码最低长度由 12 位调整为 **8 位**，不强制大小写、数字或特殊符号组合。前后端校验、中英文提示和文档同步更新。首次登录仍需更换临时密码，升级保留已有账号、密码和项目数据。

Mac/Windows require Docker Desktop. Existing installations keep pinned images: update the console image reference to **v0.1.0-rc.13**, pull it and recreate only the console. This password change does not require a runner upgrade or deletion of any data volume. Published older versions remain unchanged.
