# 第三方软件与交付边界

项目源码采用 ISC；第三方软件保留自身许可证，源码许可证不授予模型、订阅或商标权利。2026-10-16 核对的固定 CLI 版本如下：

| 软件 | 版本 | 许可证或官方条款 | 交付方式 |
|---|---|---|---|
| Codex CLI | 0.159.2 | [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE) | runner 从官方 npm 包安装，保留包内许可证 |
| Kimi Code CLI | 2.2.0 | [MIT](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE) | runner 从官方 npm 包安装，保留包内许可证 |
| Claude Code | 2.1.301 | [Anthropic 官方法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance) | runner 安装官方原版，不修改二进制或认证方式 |
| Claude Agent SDK | 0.3.172 | 包内 LICENSE.md 引用上述官方条款 | runner 的 Claude 适配依赖；console 移除此依赖及捆绑 CLI |

Anthropic 官方说明对产品预装、终端用户自行认证及品牌使用有具体条件。自行部署者必须遵循适用条款；各用户通过 CLI 官方流程登录自己的账号或使用自己的合法凭据，本项目不代售额度、不在镜像中附带账号、不提供共享登录。非面向可信用户的托管服务不属于本版本已验证场景。

镜像还包含 Node.js、Debian 系统包、MySQL 及 npm 依赖，各自的许可通知保留在安装位置。版本镜像通过 GitHub Actions 生成 SBOM 与构建来源证明；它们描述实际构建内容，不能由源码许可证清单替代。发布前运行 npm 漏洞扫描并扫描最终镜像；依赖清单随 Release 附件提供。
