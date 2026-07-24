#!/usr/bin/env bash
# Install the Max Gleam cron.d entries onto this host.
#
# The scheduled sweeps (sign-off, growth, scheduler, GPS prune) run from
# /etc/cron.d/, which lives OUTSIDE the repo and is therefore NOT restored by
# a git checkout or ./deploy.sh. This script is the version-controlled source
# of truth: run it once on a fresh host (or after a reprovision) to (re)install
# them. Idempotent — re-running overwrites with identical content.
#
# Usage:  sudo ./ops/install-cron.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "✖ must run as root (cron.d files are root-owned): sudo ./ops/install-cron.sh" >&2
  exit 1
fi

installed=0
for src in cron.d/*; do
  name="$(basename "$src")"
  dest="/etc/cron.d/$name"
  install -o root -g root -m 0644 "$src" "$dest"
  echo "✓ installed $dest"
  installed=$((installed + 1))
done

# cron picks up /etc/cron.d changes on its next minute tick; no reload needed,
# but nudge it if the service is present so a fresh install starts promptly.
if systemctl is-active --quiet cron 2>/dev/null; then
  systemctl reload-or-restart cron 2>/dev/null || true
fi

echo "▶ $installed cron.d entries installed. Verify: systemctl status cron; ls -l /etc/cron.d/maxgleam-*"
