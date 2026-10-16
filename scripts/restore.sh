#!/usr/bin/env bash
# Explicitly replaces the target installation. Does not modify native remote CLI sessions.
set -euo pipefail
cd "$(dirname "$0")/.."
backup=${1:?Usage: scripts/restore.sh /absolute/backup-directory --replace}
[ "${2:-}" = --replace ] || { echo 'Restore replaces the target console/database. Supply --replace after checking the backup and target.' >&2; exit 2; }
[[ "$backup" = /* ]] && [ "$(cat "$backup/format-version")" = 1 ] || exit 2
( cd "$backup" && sha256sum --check SHA256SUMS )
# Restore into an initialized installation: keep its database password, restore auth/config state.
dc=(docker compose --env-file .compose.env -f compose.yaml)
"${dc[@]}" stop console
"${dc[@]}" exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"' < "$backup/mysql.sql"
"${dc[@]}" run --rm --no-deps -T --entrypoint node console -e 'const f=require("fs");for(const n of f.readdirSync("/var/lib/web-agents"))f.rmSync("/var/lib/web-agents/"+n,{recursive:true,force:true})'
"${dc[@]}" run --rm --no-deps -T --entrypoint tar console -C /var/lib/web-agents -xzf - < "$backup/console.tgz"
"${dc[@]}" start --wait console
echo 'Console and database restored. Runner home/workspace require a separate backup.'
