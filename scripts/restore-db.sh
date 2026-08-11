#!/usr/bin/env sh
#
# MariaDB restore — Yorùbá Heritage World Virtual (Phase One, Step 20).
#
# DESTRUCTIVE, and deliberately awkward about it. A restore overwrites
# live data; every guard below exists because the alternative is finding
# out afterwards.
#
#   CONFIRM_RESTORE=yes \
#   BACKUP_FILE=/var/backups/yhwv/yhwv-....sql.gz \
#   ./scripts/restore-db.sh
#
# Reads credentials from the environment and PRINTS NONE OF THEM.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

: "${BACKUP_FILE:?BACKUP_FILE is not set}"
: "${DATABASE_NAME:?DATABASE_NAME is not set}"
: "${DATABASE_USER:?DATABASE_USER is not set}"
: "${DATABASE_PASSWORD:?DATABASE_PASSWORD is not set}"
DATABASE_HOST=${DATABASE_HOST:-127.0.0.1}
DATABASE_PORT=${DATABASE_PORT:-3306}

if [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "refusing: set CONFIRM_RESTORE=yes to overwrite '$DATABASE_NAME'" >&2
  echo "restore into a THROWAWAY database first — see docs/OPERATIONS.md §5" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "refusing: BACKUP_FILE does not exist" >&2
  exit 1
fi

# The application must not be writing while the tables are replaced. A
# worker mid-pass would write generation rows into a schema being
# rebuilt underneath it.
if command -v docker >/dev/null 2>&1; then
  RUNNING=$(docker compose ps --services --filter status=running 2>/dev/null || true)
  for service in app worker; do
    if printf '%s\n' "$RUNNING" | grep -qx "$service"; then
      echo "refusing: '$service' is running — docker compose stop app worker" >&2
      exit 1
    fi
  done
fi

# Prove the archive is the one that was written, before trusting a byte
# of it. A silently corrupted backup restored over live data is worse
# than no backup at all.
if [ -f "$BACKUP_FILE.sha256" ]; then
  EXPECTED=$(awk '{print $1}' < "$BACKUP_FILE.sha256")
  ACTUAL=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "refusing: backup digest does not match its .sha256 sidecar" >&2
    exit 1
  fi
  echo "digest verified"
else
  echo "refusing: no .sha256 sidecar beside the backup" >&2
  exit 1
fi

# gzip's own integrity check, before anything is applied.
gzip -t "$BACKUP_FILE"

echo "restoring into '$DATABASE_NAME' on $DATABASE_HOST:$DATABASE_PORT"

MYSQL_PWD="$DATABASE_PASSWORD" mariadb \
  --host="$DATABASE_HOST" \
  --port="$DATABASE_PORT" \
  --user="$DATABASE_USER" \
  --default-character-set=utf8mb4 \
  -e "CREATE DATABASE IF NOT EXISTS \`$DATABASE_NAME\`
        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

gunzip -c "$BACKUP_FILE" | MYSQL_PWD="$DATABASE_PASSWORD" mariadb \
  --host="$DATABASE_HOST" \
  --port="$DATABASE_PORT" \
  --user="$DATABASE_USER" \
  --default-character-set=utf8mb4 \
  "$DATABASE_NAME"

echo "restore complete"
echo
echo "NOW VERIFY — a restore you have not checked is a hypothesis:"
echo "  - table count matches the expected schema"
echo "  - __drizzle_migrations row count matches the revision"
echo "  - appointment / upload counts are plausible (counts only)"
echo "See docs/OPERATIONS.md §5 for the exact queries."
