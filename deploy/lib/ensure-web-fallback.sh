#!/usr/bin/env bash
# Runs ON the VPS (from a release, called by remote-provision.sh and remote-update.sh, as root).
# Makes the daemon env file name the previous release's web build, from which the daemon serves the
# hashed assets (lazily loaded chunks) the live build no longer has — so pages opened before an
# update keep working after the switch:
#   ORQUESTER_WEB_FALLBACK_DIR=/opt/orquester-previous/apps/web/dist
# Adds the line only when the file has no ORQUESTER_WEB_FALLBACK_DIR= line yet — an existing value,
# even one set by hand (or set empty to turn the fallback off), is never overwritten. The file keeps
# its owner and stays 0600.
# usage: ensure-web-fallback.sh <env-file>
set -euo pipefail

env_file="${1:?usage: ensure-web-fallback.sh <env-file>}"
fallback_dir=/opt/orquester-previous/apps/web/dist

if [ ! -f "$env_file" ]; then
  echo "[web-fallback] $env_file does not exist — nothing to update" >&2
  exit 1
fi
if grep -q '^ORQUESTER_WEB_FALLBACK_DIR=' "$env_file"; then
  echo "[web-fallback] ORQUESTER_WEB_FALLBACK_DIR already set in $env_file — left as is"
  exit 0
fi
# Appending keeps the file's owner and mode; a missing final newline would glue the lines.
if [ -s "$env_file" ] && [ -n "$(tail -c 1 "$env_file")" ]; then
  printf '\n' >> "$env_file"
fi
{
  echo "# The previous release's web build: hashed assets the live build lacks are served from it (added by deploy)."
  echo "ORQUESTER_WEB_FALLBACK_DIR=$fallback_dir"
} >> "$env_file"
chmod 600 "$env_file"
echo "[web-fallback] added ORQUESTER_WEB_FALLBACK_DIR=$fallback_dir to $env_file"
