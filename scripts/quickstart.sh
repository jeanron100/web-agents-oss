#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
runner=0
prebuilt=0
desktop=0
for option in "$@"; do
  case "$option" in
    --runner) runner=1 ;;
    --pull) prebuilt=1 ;;
    --desktop) desktop=1 ;;
    *) echo 'Usage: scripts/quickstart.sh [--runner] [--pull] [--desktop]' >&2; exit 2 ;;
  esac
done
command -v docker >/dev/null 2>&1 || { echo 'Install and start Docker Desktop (Linux containers) or Docker Engine + Compose v2.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required. Start or update Docker Desktop.' >&2; exit 1; }
daemon=$(docker info --format '{{.OSType}}/{{.Architecture}}') || { echo 'Docker is not ready. Start Docker Desktop and wait for the engine.' >&2; exit 1; }
case "$daemon" in
  linux/x86_64|linux/amd64) architecture=amd64 ;;
  linux/aarch64|linux/arm64) architecture=arm64 ;;
  *) echo "Unsupported Docker engine: $daemon. Select Linux containers (amd64 or arm64)." >&2; exit 1 ;;
esac
# New desktop installs are remote-management consoles. Preserve legacy local installs.
if [ "$desktop" = 1 ] && [ "$runner" = 0 ] && [ -f .compose.env ]; then
  if grep -q '^WA_INSTALL_MODE=local$' .compose.env; then
    runner=1
  elif ! grep -q '^WA_INSTALL_MODE=remote$' .compose.env; then
    existing_services=$(docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml ps --all --services)
    if printf '%s\n' "$existing_services" | grep -qx runner; then runner=1; fi
  fi
fi
install_mode=remote
if [ "$runner" = 1 ]; then install_mode=local; fi
if [ ! -f .compose.env ]; then
  # Shell-safe hex values; never print database secrets.
  db_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  root_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'WA_DB_PASSWORD=%s\nWA_DB_ROOT_PASSWORD=%s\nWA_PORT=5188\nWA_PUBLIC_URL=http://localhost:5188\nWA_INSTALL_MODE=%s\n' "$db_password" "$root_password" "$install_mode" > .compose.env
fi
# Explicit --runner enables the local mode without replacing secrets or image pins.
if [ "$runner" = 1 ] && grep -q '^WA_INSTALL_MODE=remote$' .compose.env; then
  mode_file=$(mktemp .compose.env.mode.XXXXXX)
  sed 's/^WA_INSTALL_MODE=remote$/WA_INSTALL_MODE=local/' .compose.env > "$mode_file"
  mv "$mode_file" .compose.env
fi
if [ "$prebuilt" = 1 ]; then
  version=$(cat release/version)
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'Invalid release/version' >&2; exit 2; }
  # Persist references for subsequent Compose/backup/restore operations.
  for kind in CONSOLE RUNNER; do
    if ! grep -q "^WA_${kind}_IMAGE=" .compose.env; then
      lower=$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]')
      printf 'WA_%s_IMAGE=ghcr.io/jeanron100/web-agents-oss-%s:%s\n' "$kind" "$lower" "$version" >> .compose.env
    fi
  done
fi
args=(-f compose.yaml)
if [ "$runner" = 1 ]; then args+=(-f compose.runner.yaml); fi
if [ "$prebuilt" = 1 ]; then
  services=(console)
  if [ "$runner" = 1 ]; then services+=(runner); fi
  if ! docker compose --env-file .compose.env "${args[@]}" pull "${services[@]}"; then
    # A public Release archive also works when a registry is unavailable or requires login.
    images=$(docker compose --env-file .compose.env "${args[@]}" config --images)
    for kind in "${services[@]}"; do
      if ! printf '%s\n' "$images" | grep -qx "ghcr.io/jeanron100/web-agents-oss-${kind}:${version}"; then
        echo 'Custom image pull failed; check that registry and its credentials.' >&2; exit 1
      fi
    done
    archive_dir=$(mktemp -d /tmp/web-agents-images.XXXXXX)
    trap 'rm -rf "$archive_dir"' EXIT
    archive="web-agents-images-linux-${architecture}.tar.gz"
    release_url="https://github.com/jeanron100/web-agents-oss/releases/download/${version}"
    echo 'Using the verified public Release image archive…'
    command -v curl >/dev/null 2>&1 || { echo 'curl is required for Release archive fallback.' >&2; exit 1; }
    curl -fL --retry 3 "$release_url/$archive" -o "$archive_dir/$archive"
    curl -fL --retry 3 "$release_url/$archive.sha256" -o "$archive_dir/checksum"
    checksum=$(awk -v name="$archive" '$2==name && length($1)==64 && $1 !~ /[^a-f0-9]/ {print $1}' "$archive_dir/checksum")
    [ -n "$checksum" ] || { echo 'Invalid archive checksum file' >&2; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$archive_dir/$archive" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$archive_dir/$archive" | awk '{print $1}')
    else
      echo 'sha256sum or shasum is required for archive verification.' >&2; exit 1
    fi
    [ "$actual" = "$checksum" ] || { echo 'Release image archive checksum mismatch. Nothing loaded.' >&2; exit 1; }
    docker load --input "$archive_dir/$archive"
    rm -rf "$archive_dir"
    trap - EXIT
  fi
  docker compose --env-file .compose.env "${args[@]}" up -d --pull missing --no-build --wait --wait-timeout 240
else
  docker compose --env-file .compose.env "${args[@]}" up -d --build --wait --wait-timeout 240
fi
echo 'Start at /getting-started to connect a remote execution node and prepare a project.'
echo 'Console ready. Fresh installations: admin / admin123; set a new password after signing in.'
echo 'Existing accounts and passwords are preserved. If WA_INITIAL_ACCOUNT=0, use manage.mjs setup-token.'
echo 'Open the WA_PUBLIC_URL configured in .compose.env (default http://localhost:5188).'
