#!/usr/bin/env bash
# Runs ON the VPS (from the checkout, called by remote-provision.sh and remote-update.sh, as root).
# Makes the daemon env file name the daemon's public origin, which boxes (macOS runners
# especially) dial and the boxes Connection settings use by default:
#   ORQUESTER_PUBLIC_URL=https://<domain>
# Adds the line only when the file has no ORQUESTER_PUBLIC_URL= line yet — an existing value,
# even one set by hand, is never overwritten. The file keeps its owner and stays 0600.
# usage: ensure-public-url.sh <env-file> <domain>   (an empty domain does nothing)
set -euo pipefail

env_file="${1:?usage: ensure-public-url.sh <env-file> <domain>}"
domain="${2:-}"

if [ -z "$domain" ]; then
  echo "[public-url] no domain configured — ORQUESTER_PUBLIC_URL not managed"
  exit 0
fi
case "$domain" in
  *[!0-9A-Za-z.-]*) echo "[public-url] invalid domain '$domain'" >&2; exit 1 ;;
esac
if [ ! -f "$env_file" ]; then
  echo "[public-url] $env_file does not exist — nothing to update" >&2
  exit 1
fi
if grep -q '^ORQUESTER_PUBLIC_URL=' "$env_file"; then
  echo "[public-url] ORQUESTER_PUBLIC_URL already set in $env_file — left as is"
  exit 0
fi
# Appending keeps the file's owner and mode; a missing final newline would glue the lines.
if [ -s "$env_file" ] && [ -n "$(tail -c 1 "$env_file")" ]; then
  printf '\n' >> "$env_file"
fi
{
  echo "# The daemon's public origin (boxes dial it; added by deploy from the target's domain)."
  echo "ORQUESTER_PUBLIC_URL=https://$domain"
} >> "$env_file"
chmod 600 "$env_file"
echo "[public-url] added ORQUESTER_PUBLIC_URL=https://$domain to $env_file"
