# Mac and Windows quick start

[English](desktop.md) | [简体中文](../desktop.md) · [Home](../../../README.en.md)

Run the console, database and optional execution node through Docker Desktop. Projects and vendor credentials live in Docker named volumes by default. Host Node.js, Git and Python are not required.

## Requirements

| Host | Docker engine | Launcher |
|---|---|---|
| Intel Mac | Linux amd64 | `start-macos.command` or Bash |
| Apple Silicon Mac | Linux arm64, native image | `start-macos.command` or Bash |
| Windows x64 | Docker Desktop WSL 2, Linux amd64 | `start-windows.cmd` or PowerShell 5.1+ |
| Linux amd64/arm64 | Docker Engine with Compose v2 | Bash |

Install and start [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) or [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/). Windows needs the [WSL 2 backend](https://docs.docker.com/desktop/features/wsl/) with Linux containers. Refer to Docker's current documentation for supported OS versions and virtualization requirements. Windows Server and Windows ARM desktop hosts are outside this release's host validation scope.

Allow Docker at least 4 GB of RAM and your computer at least 12 GB of free disk space. Docker Desktop has its own licensing terms. The launchers do not install Docker or change persistent system execution policies.

## Download and start

1. Download the matching `web-agents-<version>-macos.zip` or `-windows.zip` and `.sha256` from [GitHub Releases](https://github.com/jeanron100/web-agents-oss/releases). These contain launchers and configuration; the first start downloads the matching architecture's images.
2. Verify the checksum and extract the entire ZIP to a writable location, such as `~/Applications/Web Agents` or `%USERPROFILE%\Web Agents`. Do not launch from a ZIP preview or a shared/cloud-synchronized directory.
3. Start Docker Desktop and wait for the engine. Double-click `start-macos.command` or `start-windows.cmd`. If your OS asks about a downloaded file, confirm its source rather than disabling system protection globally.
4. Wait for healthy services, then open `http://localhost:5188`. **Initial username: `admin`. Temporary password: `admin123`.** Set a new password of at least 8 characters and sign in again. Existing accounts and unfinished token-based setup remain unchanged during upgrade.

Starting with rc.15, fresh desktop launches start the console and MySQL for remote management, without a local runner. Existing installations retain their mode. Open `/getting-started` and follow the [remote setup guide](remote-setup.md).

Choose **English** on the sign-in page for English setup, password and recovery instructions. The choice is saved locally. The main console/demo currently still includes Chinese interface text; the bilingual documentation does not imply every application screen has been translated.

You can first explore the [fictional-data demo](https://webagents.jeanron100.top/demo/) without an account, or read the [product overview](https://webagents.jeanron100.top/demo.en.html).

If macOS extraction did not preserve executable permissions, run this from the extracted directory:

```bash
bash scripts/quickstart.sh --desktop --pull
```

Windows PowerShell entry point:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\quickstart.ps1 -Desktop -Pull
```

The execution-policy override applies only to that process. `--desktop` / `-Desktop` starts fresh installations in remote-management mode and preserves an existing recorded mode or runner. `.compose.env` is created on first start and preserved thereafter, including image references and passwords. Listening is restricted to loopback by default.

## Vendor accounts and projects

From the installation directory:

For a local trial first run `bash scripts/quickstart.sh --runner --pull` or `.\scripts\quickstart.ps1 -Runner -Pull`. Register a later-added runner using [remote/local setup](remote-setup.md).

```bash
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner codex login --device-auth
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner kimi login
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml exec runner bash
# Inside the runner:
mkdir -p /workspace/my-project
```

Use your own vendor accounts; images do not contain shared login credentials. The workspace defaults to `/workspace` in a named volume. Copy projects with Docker Compose or clone inside the runner. Host bind mounts on Mac/Windows may have different performance and permission characteristics.

This runs Linux containers. It does not adopt native macOS/Windows CLI processes, services or LaunchAgents. Add remote Linux nodes through the console's server-management settings.

## Checksums, stopping and upgrades

Mac: `shasum -a 256 web-agents-<version>-macos.zip`. Windows: `Get-FileHash .\web-agents-<version>-windows.zip -Algorithm SHA256`. Compare against the accompanying `.sha256` file.

Stop services without removing data:

```bash
docker compose --env-file .compose.env -f compose.yaml down
# Local mode: include -f compose.runner.yaml before down
```

Start again with the same launcher. Do not add `-v` or delete Docker Desktop's data disk: that removes database, account and workspace volumes. For upgrades, preserve `.compose.env`, explicitly update its two image references, and use the same Compose project and volumes. See [operations](operations.md) for backups, password recovery and lifecycle boundaries.

If registry pulls fail, launchers download the same version's architecture-specific image archive and verify SHA-256 before loading it. You may preload `web-agents-images-linux-amd64.tar.gz` or `arm64.tar.gz` with `docker load --input <file>`. Apple Silicon should use arm64. A failed custom image is never silently replaced with an official image.

## What has been tested

CI extracts the actual ZIPs and runs launchers in macOS/Windows shells, checking paths with spaces, persistent secrets/configuration, architecture selection, download verification, failure handling and checksum rejection. Docker and download operations in those shell tests use controlled substitutes.

Actual image builds, CLI version commands, Compose health and first authentication are tested on native Linux amd64/arm64 runners. These are not described as manual acceptance on physical Mac/Windows Docker Desktop GUI installations.
