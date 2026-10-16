#!/usr/bin/env bash
# Stop writers for a consistent database + config snapshot. Never backs up a runner implicitly.
set -euo pipefail
cd "$(dirname "$0")/.."
destination=${1:?Usage: scripts/backup.sh /absolute/backup-directory}
[[ "$destination" = /* ]] || { echo 'Use an absolute destination' >&2; exit 2; }
mkdir -m 700 "$destination"
dc=(docker compose --env-file .compose.env -f compose.yaml)
"${dc[@]}" stop console
trap '"${dc[@]}" start console >/dev/null' EXIT
"${dc[@]}" exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump -u "$MYSQL_USER" --single-transaction --no-tablespaces "$MYSQL_DATABASE"' > "$destination/mysql.sql"
"${dc[@]}" run --rm --no-deps -T --entrypoint tar console -C /var/lib/web-agents -czf - . > "$destination/console.tgz"
cp .compose.env "$destination/compose.env"
chmod 600 "$destination/"*
printf '1\n' > "$destination/format-version"
sha256sum "$destination/mysql.sql" "$destination/console.tgz" "$destination/compose.env" | sed "s|$destination/||" > "$destination/SHA256SUMS"
echo 'Backup complete. Keep this directory private; it contains credentials and session history.'
