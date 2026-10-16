#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
runner=0
prebuilt=0
for option in "$@"; do
  case "$option" in
    --runner) runner=1 ;;
    --pull) prebuilt=1 ;;
    *) echo 'Usage: scripts/quickstart.sh [--runner] [--pull]' >&2; exit 2 ;;
  esac
done
if [ ! -f .compose.env ]; then
  # Shell-safe hex values; never print database secrets.
  db_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  root_password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'WA_DB_PASSWORD=%s\nWA_DB_ROOT_PASSWORD=%s\nWA_PORT=5188\nWA_PUBLIC_URL=http://localhost:5188\n' "$db_password" "$root_password" > .compose.env
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
  docker compose --env-file .compose.env "${args[@]}" up -d --pull always --no-build --wait --wait-timeout 240
else
  docker compose --env-file .compose.env "${args[@]}" up -d --build --wait --wait-timeout 240
fi
echo 'Console ready. Read the setup token with:'
echo 'docker compose --env-file .compose.env exec console node server/manage.mjs setup-token'
echo 'Open the WA_PUBLIC_URL configured in .compose.env (default http://localhost:5188).'
