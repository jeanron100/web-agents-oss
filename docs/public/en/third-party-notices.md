# Third-party software and delivery boundaries

[English](third-party-notices.md) | [简体中文](../third-party-notices.md) · [Home](../../../README.en.md)

This project's source is ISC-licensed. Third-party software keeps its own licenses; the source license does not grant model access, subscriptions or trademark rights. The pinned versions checked on 2026-10-16 are:

| Software | Version | License or official terms | Delivery |
|---|---|---|---|
| Codex CLI | 0.159.2 | [Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE) | Official npm package in the runner, with package license retained |
| Kimi Code CLI | 2.2.0 | [MIT](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE) | Official npm package in the runner, with package license retained |
| Claude Code | 2.1.301 | [Anthropic legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) | Official distribution, without binary or authentication modifications |
| Claude Agent SDK | 0.3.172 | Bundled LICENSE.md refers to the official terms above | Runner's Claude adapter dependency; removed along with its bundled CLI from the console image |

Anthropic's official documentation specifies conditions for preinstallation, end-user authentication and branding. Operators must follow applicable terms. Users authenticate through official CLI flows with their own accounts or legitimate credentials. This project does not resell quota, ship accounts in images or provide shared vendor logins. Hosting for untrusted users is not a validated use case for this release.

Images also include Node.js, Debian packages, MySQL and npm dependencies, whose license notices remain at their installed locations. GitHub Actions generates SBOMs and build provenance describing actual versioned artifacts; a source-level license list is not a substitute. Publication runs dependency and final-image scans, with inventories attached to the Release.
