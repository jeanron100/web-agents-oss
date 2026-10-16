# Release validation and roadmap

[English](release-readiness.md) | [简体中文](../release-readiness.md) · [Home](../../../README.en.md)

[Public repository](https://github.com/jeanron100/web-agents-oss) · [Versioned downloads](https://github.com/jeanron100/web-agents-oss/releases) · [Publishing workflow](https://github.com/jeanron100/web-agents-oss/actions/workflows/publish.yml)

The product targets one administrator or a trusted small team managing Linux execution nodes. Container delivery supports Linux amd64/arm64 and Docker Desktop on Intel/Apple Silicon Macs and Windows x64 with WSL 2. Read the [desktop guide](desktop.md) for the exact tested scope. Existing native nodes do not have to migrate into containers.

## Delivered

| Area | Available capabilities |
|---|---|
| Delivery | Compose console/MySQL, optional non-root runner, dual-architecture images and archives, checksums, Mac/Windows ZIP launchers |
| First use | Temporary initial account with mandatory password change, login/logout, password change and local recovery; existing token setup remains compatible |
| Multiple servers | UI add/edit/test/disable/remove, per-node tokens and live configuration |
| Execution | Codex immediate supplements and independent queued tasks; multi-engine conversations, images, terminals and supported session recovery |
| Traceability | Execution history, task evidence, optional model-assisted questions and eight read-only MCP tools |
| Operations | External configuration, persistent volumes, diagnostics, backups, dependency inventories, image digests and provenance |

v0.1.0-rc.11 redesigns login/setup across themes, adds temporary initial credentials for fresh containers and server-enforced password change, and updates the fictional-data public demo. Later documentation changes do not rewrite already published version archives.

## Validation scope

- The release workflow runs backend/frontend tests, TypeScript/build checks, architecture-specific image builds, actual Compose initialization and isolated gateway-metadata acceptance. Use the workflow linked to a release for that release's result.
- Dependency/image scans gate publication. Final images must pass the fixable HIGH/CRITICAL gate; scans use `ignore-unfixed=true`. Passing does not mean there are no lower-severity or unpatched vulnerabilities.
- At the rc.5 baseline, isolated native and container workspaces completed real Codex/Kimi tasks: commands, file changes, image input, interruption and resumption, plus Codex supplementation and queued tasks. These were not repeated and claimed as fresh vendor inference for every later patch.
- At the rc.5 baseline, replacing the runner with retained volumes preserved accounts/workspaces and allowed both agents' conversations to load and continue.
- First-use browser checks cover theme contrast and desktop/mobile widths; initialization, authentication boundaries and node management are tested. rc.11's checks include first-login password change and rejection of the old password.
- MCP lists eight tools and has been exercised against managed nodes. Anonymous terminal access is rejected; authenticated access traverses Hub/node authorization.
- A database marker was backed up, removed, restored and read back; the console administrator remained usable, and restoring the console did not replace the runner.
- Public exports carry per-file SHA-256 manifests and secret-scan checks; the original private Git history is excluded.

Pinned CLIs: Codex 0.159.2, Kimi Code 2.2.0 and Claude Code 2.1.301. Builds execute all three version commands as a non-root user. Claude has only executable/version validation here, not inference acceptance with a vendor account. Users need their own legal access. See [third-party notices](third-party-notices.md).

## Boundaries and priorities

Console restarts do not stop remote native CLIs. Runner replacement stops its internal processes; retain volumes and reload sessions. Console backups exclude runner home/workspaces. Native Windows/macOS process adoption and isolation between untrusted users are not delivered. There is no prerelease production-support SLA.

P1 priorities: actual vendor-login checks in the node wizard, a CLI compatibility matrix, visual upgrade/rollback and backup status, sustained fault visibility, and lighter per-engine runners.

P2 priorities: multiple users/RBAC, project isolation, quota/cost policies, more notification channels and lighter single-node storage. These are plans rather than current capabilities.
