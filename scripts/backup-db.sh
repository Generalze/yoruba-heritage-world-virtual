#!/usr/bin/env sh
#
# MariaDB backup — Yorùbá Heritage World Virtual.
#
#   BACKUP_DIR=/var/backups/yhwv DOCKER="sudo docker" ./scripts/backup-db.sh
#
# THROUGH THE CONTAINER, NOT THROUGH A PORT. This script used to connect
# to 127.0.0.1:3306 with a mariadb-dump installed on the host. In the
# hardened topology neither of those exists: the database deliberately
# publishes no port, and the VPS has no MariaDB client — the client
# lives in the database image and nowhere else. So the dump runs INSIDE
# the db container and only its output crosses the boundary.
#
# THE PASSWORD NEVER TOUCHES A HOST COMMAND LINE. The credential is
# already in the container's own environment, and the command below is
# SINGLE-QUOTED so the host shell never expands it: `$MARIADB_ROOT_
# PASSWORD` is resolved by the shell inside the container. Nothing
# appears in this machine's process list, which every other user on a
# box can read, and nothing is printed here.
#
# Writes <dir>/yhwv-<database>-<UTC>.sql.gz plus a .sha256 sidecar.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

# `sudo docker` on a server where the deploy user is deliberately NOT in
# the docker group — that group is root-equivalent. Overridable so the
# same script works on a development machine.
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
: "${DATABASE_NAME:?DATABASE_NAME is not set}"
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

if ! $DOCKER compose -f "$COMPOSE_FILE" ps db >/dev/null 2>&1; then
  echo "refusing: cannot reach Docker Compose." >&2
  echo "  On the server the deploy user is not in the docker group, by" >&2
  echo "  design. Run with:  DOCKER=\"sudo docker\" $0" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_DIR/yhwv-$DATABASE_NAME-$STAMP.sql.gz"

# --single-transaction: a consistent snapshot of the InnoDB tables
#   WITHOUT locking them, so a backup never takes the site down.
# --routines --events --triggers: schema objects a plain dump would
#   silently drop, leaving a restore that only looks complete.
# --no-tablespaces: avoids requiring the PROCESS privilege.
# The database's own root account is used INSIDE the container, where
# its password already lives; it never reaches this host.
#
# shellcheck disable=SC2016  # $MARIADB_ROOT_PASSWORD is expanded in the container, deliberately
if ! $DOCKER compose -f "$COMPOSE_FILE" exec -T db sh -c '
      MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump \
        --user=root \
        --single-transaction \
        --routines \
        --events \
        --triggers \
        --no-tablespaces \
        --default-character-set=utf8mb4 \
        "$MARIADB_DATABASE"
    ' | gzip -9 > "$TARGET"; then
  rm -f "$TARGET"
  echo "backup FAILED — no partial archive was kept" >&2
  exit 1
fi

# An empty or truncated dump must never be mistaken for a backup.
if [ ! -s "$TARGET" ]; then
  rm -f "$TARGET"
  echo "backup FAILED — the dump was empty" >&2
  exit 1
fi
if ! gzip -t "$TARGET"; then
  rm -f "$TARGET"
  echo "backup FAILED — the archive did not survive its own integrity check" >&2
  exit 1
fi

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
