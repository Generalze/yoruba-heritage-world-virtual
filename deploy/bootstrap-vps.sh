#!/usr/bin/env bash
#
# VPS bootstrap — the PRIVILEGED half of the deployment.
#
#   sudo ./deploy/bootstrap-vps.sh
#
# Everything here needs root, which is why it is a reviewable script an
# operator runs deliberately rather than a list of commands pasted from
# a chat window. It is idempotent: run it twice and the second run
# changes nothing.
#
# WHAT IT DOES
#   1. installs Fail2ban and enables the SSH jail
#   2. installs Docker Engine + Compose from Docker's official Ubuntu
#      repository (not the distribution's older docker.io package)
#   3. narrows UFW to 22, 80, 443
#   4. creates /opt/yhw owned by the deploy user
#
# WHAT IT DELIBERATELY DOES NOT DO
#   - it does NOT add the deploy user to the `docker` group. That group
#     is root-equivalent: any member can bind-mount / into a container
#     and write anywhere. `sudo docker` keeps the privilege visible and
#     audited.
#   - it does NOT write secrets, fetch the application, or start
#     anything. Bringing the stack up is a separate, gated decision.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-yhwadmin}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/yhw}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must run as root:  sudo $0" >&2
  exit 1
fi
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "Deploy user '$DEPLOY_USER' does not exist." >&2
  exit 1
fi

echo "==> 1/4  Fail2ban"
if ! command -v fail2ban-client >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
fi
# A jail.local, never an edit to jail.conf: package upgrades overwrite
# jail.conf and would silently take the jail with it.
cat >/etc/fail2ban/jail.local <<'JAIL'
[DEFAULT]
# Ban for an hour after 5 failures in 10 minutes. Long enough to stop a
# brute force, short enough that locking yourself out is survivable.
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = ssh
JAIL
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "==> 2/4  Docker Engine + Compose (official repository)"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "==> 3/4  UFW — only 22, 80, 443"
ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
# Docker publishes ports by writing iptables rules that BYPASS ufw's
# filter chain, so a published port is reachable even when ufw says
# it is denied. This deployment's answer is structural rather than a
# firewall workaround: only Caddy publishes anything, and it publishes
# exactly 80 and 443. Nothing else has a `ports:` entry at all, which
# the deployment-topology test enforces.

echo "==> 4/4  ${DEPLOY_DIR}"
mkdir -p "$DEPLOY_DIR"
chown "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_DIR"
chmod 750 "$DEPLOY_DIR"

echo
echo "Done. State:"
docker --version
docker compose version
fail2ban-client status sshd 2>/dev/null || echo "  (sshd jail not reporting yet — check: fail2ban-client status)"
ufw status verbose | head -12
echo
echo "NOT done here, by design: no secrets written, nothing fetched,"
echo "nothing started. Next steps are gated."
