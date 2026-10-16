# Configuration, upgrades and recovery

[English](operations.md) | [简体中文](../operations.md) · [Home](../../../README.en.md)

## Configuration

Environment variables take precedence over `server/.env`. Containers do not copy `.env` from the source tree.

| Setting | Purpose |
|---|---|
| `WA_HUB_CONFIG` | Private JSON containing nodes, disabled/retired nodes and optional quota-account mapping |
| `WA_DATA_DIR` / `HOME` | Console state / CLI accounts and history; separate container volumes |
| `WA_PROJECT_ROOT` | Node project root; `/workspace` in the runner |
| `WA_AUTH_ENABLED=1` | Built-in administrator authentication; mandatory in the console container |
| `WA_INITIAL_ACCOUNT=1` | Fresh-container `admin / admin123` account with mandatory password change; existing authentication state is preserved. Set `0` for manual token setup |
| `WA_PUBLIC_URL` | Actual browser origin; HTTPS enables Secure cookies. Use `localhost` or `127.0.0.1` consistently |
| `WA_MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` | Persistent task evidence, history and daily statistics; schema additions are created on startup |
| `WA_AGENT_TOKEN_FILE` | Node token file; combine with `WA_AGENT_REQUIRE_TOKEN=1` |
| `WA_ASSISTANT_MODEL_CONFIG` | Optional assistant-model configuration; saved through settings without revealing the key |

Redis, MongoDB, vector search and external monitoring are optional and disabled by default. Their absence is not a deployment failure. MySQL provides default persistence. Server, monitoring and optional assistant-model settings are configurable through the UI.

Claude/Kimi TUI quota collection requires an authenticated selected source node. Codex quota accounts are grouped by observed account identity and configured aliases. Correctly map shared accounts across nodes rather than adding their percentages together. Historical quota samples and CLI Token consumption measure different things.

Assistant `analysis.modelCalls` retains planning/synthesis stages, reported resolved model/provider, request IDs, Token counts and compatibility warnings. `metadata.resolved_model` takes precedence over a top-level `model` that may still be `auto`. Missing values remain unknown; ignored parameters are displayed as warnings. Cached polling does not create additional model usage. Raw gateway objects and credentials are not exposed. MCP returns bounded metadata and marks truncation.

## Initial account and password recovery

Starting with v0.1.0-rc.11, fresh container installations provide **username `admin` and temporary password `admin123`**. The first sign-in permits password change or sign-out only. Server-side checks block project data, configuration, execution and terminals until a new password of at least 12 characters is saved. Existing sessions are then revoked; sign in with the new password. Complete this on the default loopback listener before exposing the console.

An existing `auth.json` is never overwritten on upgrade, including unfinished manual setup. Native Hub installations use token-based setup by default. To choose this for a fresh container, set `WA_INITIAL_ACCOUNT=0` in `.compose.env` before first start, then run:

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs setup-token
```

Use the one-time token on the setup page to create your own administrator.

Forgotten passwords require local operator access to the installation and container:

```bash
docker compose --env-file .compose.env exec console node server/manage.mjs reset-password
docker compose --env-file .compose.env restart console
```

The username is preserved. Restarting the console loads the temporary `admin123` password and revoked sessions; a new password is mandatory again. This does not recreate the runner or stop remote native CLIs. For ordinary changes, use the account section in settings.

## Backups

Use the bundled scripts from the same installation directory and configuration:

```bash
bash scripts/backup.sh /absolute/private/backup-directory
bash scripts/restore.sh /absolute/private/backup-directory --replace
```

Read the scripts' usage before operating on existing data. Backup requires a new destination directory; restore replaces the target console state and database and therefore requires `--replace`. Console backups cover the console's configuration/state and MySQL. They do **not** include runner account/home or workspace volumes; back those up separately with the runner's activity considered. Backups contain credentials: provide your own encryption, private storage and access controls. Do not commit them to Git.

## Upgrade and lifecycle

Preserve `.compose.env`, volumes and the Compose project identity. Explicitly update `WA_CONSOLE_IMAGE` and `WA_RUNNER_IMAGE` to the target release. Downloading a new ZIP does not automatically change existing pinned images.

```bash
docker compose --env-file .compose.env pull console
docker compose --env-file .compose.env up -d --no-deps --wait console
# Update the runner only after its active work has ended:
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml pull runner
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml up -d --no-deps --wait runner
```

Restarting the console preserves remote native CLI processes. Replacing the runner stops its internal CLIs; retain account/history/workspace volumes and reload sessions afterwards. Never use `down -v` as an upgrade step. Schema migrations currently add tables/columns; do not assume an old image can read newer data. Rollback needs a compatible backup.

`quickstart.sh --runner --pull` can update both console and runner and is appropriate for fresh installations or when both are ready to change. GHCR failures may use verified Release image archives; custom image references are not silently replaced.

## Diagnostics and isolated acceptance

Run `docker compose --env-file .compose.env exec console node server/manage.mjs doctor` to inspect configured node connectivity and CLI information. Presence of a credential file does not prove a real vendor task works.

`scripts/container-smoke.mjs` is for a fresh **isolated** installation only: it changes the initial password or initializes an administrator, verifies access boundaries and node CRUD, then stores private test credentials beside its evidence path. Do not run it against an existing personal or production installation.

## Versioned publishing

The public repository's `v*` tags trigger tests, desktop launcher checks, native amd64/arm64 builds, vulnerability gates and actual Compose initialization before publishing ZIPs, source/image archives, checksums and provenance. The tag must match `release/version`. An already published version cannot be rebuilt or overwritten; fixes use another version.

Release candidates stay prereleases; stable `vX.Y.Z` versions are marked Latest. Publishing does not upgrade existing installations or replace the maintainer's private deployment. Maintainers publish only a manifested, scanned public export, never the original private Git history. See [release validation](release-readiness.md) and [third-party notices](third-party-notices.md).
