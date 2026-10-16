# Web Agents 0.1 release candidate

Self-hosted, single-administrator console for Codex, Kimi and Claude across multiple Linux servers.

- First-run login, persistent server management and authenticated node connections.
- Mobile conversation streams, approvals, Codex immediate supplements and separate queued tasks.
- Execution history, evidence-backed project progress and a read-only MCP interface.
- Token/usage trends, quota reset windows, image preview and Web terminal.
- Console/MySQL Compose delivery and an optional non-root execution container.
- Public source checksums, versioned images, dependency inventories and a verified prebuilt image archive.

Start with `./scripts/quickstart.sh --runner --pull`. The installer tries GHCR first, then the checksum-verified public Release archive. Source builds remain available without `--pull`.

Linux amd64 is the verified platform. Users authenticate their own vendor accounts. This candidate is for trusted administrators, with no multi-tenant security boundary. Replacing a runner container stops its CLI processes; persist its account/workspace volumes and resume conversations after replacement. See README, SECURITY.md and docs/public/ for setup and operational limits.
