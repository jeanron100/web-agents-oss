# Web Agents versioned desktop delivery candidate

This candidate adds automatic per-tag GitHub Releases, stable/prerelease classification, published-version protection and direct versioned downloads on the repository homepage. Each version keeps its own packages, source, checksums and image tags.

Run the full Web Agents console on Linux, macOS (Intel / Apple Silicon) and Windows x64 through Docker Desktop Linux containers.

- Native Linux amd64/arm64 console and runner images; Docker selects the matching manifest.
- Download `web-agents-<version>-macos.zip` or `-windows.zip`, extract, and use the desktop launcher. Git and host Node/Python are not required.
- Portable Bash bootstrap and Windows PowerShell 5.1+ startup, persistent credentials, Docker readiness checks, and architecture-specific SHA-256 verified fallback archives.
- Windows/macOS hosted shell acceptance and real Compose initialization plus all three CLI version checks on both Linux architectures.

Install and start Docker Desktop first (Windows: WSL 2 Linux containers). Open http://localhost:5188 and follow `docs/public/desktop.md` for the first administrator and vendor login. Existing remote Linux agents remain supported. Native Windows/macOS host CLI adoption and a standalone .app/.exe runtime are outside this delivery.

Single-administrator/trusted-team candidate; vendor accounts remain your own. Runner replacement stops its internal CLI processes; preserve account/workspace volumes and reload conversations. Shell acceptance uses a mocked Docker/download contract; full Docker Desktop GUI/hardware validation is not claimed.
