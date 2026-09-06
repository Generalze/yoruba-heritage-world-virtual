#!/usr/bin/env sh
#
# MariaDB restore — Yorùbá Heritage World Virtual.
#
# DESTRUCTIVE, and deliberately awkward about it. A restore overwrites
# live data; every guard below exists because the alternative is finding
# out afterwards.
#
#   CONFIRM_RESTORE=yes \
#   BACKUP_FILE=/var/backups/yhwv/yhwv-....sql.gz \
#   DOCKER="sudo docker" ./scripts/restore-db.sh
#
# THROUGH THE CONTAINER, NOT THROUGH A PORT — the same reason as the
# backup script: production publishes no database port and the host has
# no MariaDB client. The credential is resolved inside the container
# from its own environment and never appears on a host command line or
# in this machine's process list.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
DOCKER=${DOCKER:-docker}

# THE .env IS READ, NEVER SOURCED. `set -a; . .env` executes the file as
# shell: a value containing spaces or parentheses breaks the script, and
# a value containing $(...) would RUN it. Compose parses this file with
# different rules to the shell, so agreeing with the shell is not even
# correct. Only the one key needed here is extracted, literally.
read_env() {
  [ -f "$REPO_ROOT/.env" ] || return 0
  sed -n "s/^$1=//p" "$REPO_ROOT/.env" | head -n 1 | sed 's/^["'"'"']//;s/["'"'"']$//'
}
DATABASE_NAME=${DATABASE_NAME:-$(read_env DATABASE_NAME)}
: "${BACKUP_FILE:?BACKUP_FILE is not set}"
: "${DATABASE_NAME:?DATABASE_NAME is not set}"

# RESTORE_INTO lets an operator rehearse into a throwaway database
# instead of over the live one — which is the only way to find out
# whether a backup is a backup. Defaults to the real database precisely
# so that choosing it is deliberate.
RESTORE_INTO=${RESTORE_INTO:-$DATABASE_NAME}

if [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "refusing: set CONFIRM_RESTORE=yes to overwrite '$RESTORE_INTO'" >&2
  echo "restore into a THROWAWAY database first — see docs/OPERATIONS.md" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "refusing: BACKUP_FILE does not exist" >&2
  exit 1
fi

if ! $DOCKER compose -f "$COMPOSE_FILE" ps db >/dev/null 2>&1; then
  echo "refusing: cannot reach Docker Compose." >&2
  echo "  Run with:  DOCKER=\"sudo docker\" $0" >&2
  exit 1
fi

# The application must not be writing while the tables are replaced. A
# worker mid-pass would write generation rows into a schema being
# rebuilt underneath it.
RUNNING=$($DOCKER compose -f "$COMPOSE_FILE" ps --services --filter status=running 2>/dev/null || true)
for service in app worker; do
  if printf '%s\n' "$RUNNING" | grep -qx "$service"; then
    echo "refusing: '$service' is running — stop it first:" >&2
    echo "  $DOCKER compose -f $COMPOSE_FILE stop app worker" >&2
    exit 1
  fi
done

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

echo "restoring into '$RESTORE_INTO' (inside the db container)"

# shellcheck disable=SC2016  # expanded in the container, deliberately
$DOCKER compose -f "$COMPOSE_FILE" exec -T -e RESTORE_INTO="$RESTORE_INTO" db sh -c '
  MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb \
    --user=root \
    --default-character-set=utf8mb4 \
    -e "CREATE DATABASE IF NOT EXISTS \`'"$RESTORE_INTO"'\`
          CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
'

# shellcheck disable=SC2016  # expanded in the container, deliberately
gunzip -c "$BACKUP_FILE" | $DOCKER compose -f "$COMPOSE_FILE" exec -T db sh -c '
  MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb \
    --user=root \
    --default-character-set=utf8mb4 \
    "'"$RESTORE_INTO"'"
'

echo "restore complete"
echo
echo "NOW VERIFY — a restore you have not checked is a hypothesis:"
echo "  - table count matches the expected schema"
echo "  - __drizzle_migrations row count matches the revision"
echo "  - appointment / upload counts are plausible (counts only)"
echo "See docs/OPERATIONS.md for the exact queries."
