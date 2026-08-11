#!/usr/bin/env sh
#
# MariaDB backup — Yorùbá Heritage World Virtual (Phase One, Step 20).
#
# Reads credentials from the environment (or .env) and PRINTS NONE OF
# THEM. The password is handed to the client through MYSQL_PWD rather
# than a --password= argument, because arguments are visible to every
# other process on the machine through the process list.
#
#   BACKUP_DIR=/var/backups/yhwv ./scripts/backup-db.sh
#
# Writes <dir>/yhwv-<database>-<UTC>.sql.gz plus a .sha256 sidecar, and
# prints the file name and digest so an operator can record them.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

# .env is the same file Compose reads. Sourced, never echoed.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

: "${DATABASE_NAME:?DATABASE_NAME is not set}"
: "${DATABASE_USER:?DATABASE_USER is not set}"
: "${DATABASE_PASSWORD:?DATABASE_PASSWORD is not set}"
DATABASE_HOST=${DATABASE_HOST:-127.0.0.1}
DATABASE_PORT=${DATABASE_PORT:-3306}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/yhwv}

# A backup inside the working tree is one `git add -A` away from being
# committed, and one `rm -rf` away from being gone with the code it was
# meant to outlive.
case "$(CDPATH='' cd -- "$BACKUP_DIR" 2>/dev/null && pwd || echo "$BACKUP_DIR")" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "refusing: BACKUP_DIR is inside the repository" >&2
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_DIR/yhwv-$DATABASE_NAME-$STAMP.sql.gz"

# --single-transaction: a consistent snapshot of the InnoDB tables
#   WITHOUT locking them, so a backup never takes the site down.
# --routines --events --triggers: schema objects a schema-only dump
#   would silently drop, leaving a restore that looks complete.
# --no-tablespaces: avoids requiring the PROCESS privilege, so the
#   backup can run as the ordinary application user.
MYSQL_PWD="$DATABASE_PASSWORD" mariadb-dump \
  --host="$DATABASE_HOST" \
  --port="$DATABASE_PORT" \
  --user="$DATABASE_USER" \
  --single-transaction \
  --routines \
  --events \
  --triggers \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  "$DATABASE_NAME" | gzip -9 > "$TARGET"

chmod 600 "$TARGET"

DIGEST=$(sha256sum "$TARGET" | awk '{print $1}')
printf '%s  %s\n' "$DIGEST" "$(basename "$TARGET")" > "$TARGET.sha256"
chmod 600 "$TARGET.sha256"

echo "backup written: $TARGET"
echo "sha256:         $DIGEST"
echo
echo "This backup is not safe until it is OFF THIS MACHINE."
echo "Also back up the private object bucket and the media_data volume;"
echo "the database alone cannot reproduce a recording or its sources."
