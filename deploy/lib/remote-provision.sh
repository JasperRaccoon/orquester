#!/usr/bin/env bash
# Runs ON a fresh Ubuntu VPS as root (delivered by ./deploy.sh provision).
# Idempotent: safe to re-run after a partial failure. Inputs via env:
#   DOMAIN  (required) public domain — DNS A record must already point here
#   REPO    (required) git clone URL
#   BRANCH  default main
#
# Release layout (the one deploy/lib/remote-update.sh keeps; a fresh host gets it directly):
#   /opt/orquester-releases/repo.git   shared git dir, from `git clone --bare "$REPO"`, then
#                                      remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*
#                                      (a bare clone sets none), so `git fetch origin` — in repo.git
#                                      or in any release — updates refs/remotes/origin/* and
#                                      `origin/$BRANCH` resolves. core.bare stays true. The
#                                      refs/heads/* the clone copied are never updated; nothing reads
#                                      them. Also holds orq-deploy.lock and orq-last-deployed-head.
#   /opt/orquester-releases/<sha12>/   one release: `git worktree add --detach <dir> <sha>` (sha12 =
#                                      the first 12 hex digits), fully built, then marked complete
#                                      by .orq-release-complete (the full sha and a newline) last.
#   /opt/orquester                  -> the live release (symlink; git -C, the unit and
#                                      ORQUESTER_WEB_DIR all go through it)
#   /opt/orquester-previous         -> the release before it (symlink; may be absent)
#   /opt/orquester-releases/tooling/   remote-update.sh + self-update.sh of the last layout-aware
#                                      release deployed (0755 dir, 0644 files, replaced atomically);
#                                      orquester-update.service runs these, falling back to
#                                      /opt/orquester/deploy/lib/ when they are missing.
# A host where /opt/orquester is still a plain checkout (a re-run on an older install) is updated in
# place as before; its next ./deploy.sh deploy (or self-update) converts it.
set -euo pipefail
# The generated password is normally printed once at the very end. If a later
# step aborts (daemon won't boot, Caddy, ufw), the password would exist only
# inside root-readable /etc/orquester/daemon.env and a re-run would neither
# regenerate nor reprint it — so the ERR trap must leave it behind.
on_err() {
  echo "[provision] FAILED at line $1" >&2
  if [ -n "${GENERATED_PASSWORD:-}" ]; then
    echo "[provision] NOTE: an HTTP password was already generated and installed in /etc/orquester/daemon.env:" >&2
    echo '==============================================================' >&2
    echo ' HTTP password (username from daemon.env, default: mapacho):' >&2
    echo "   $GENERATED_PASSWORD" >&2
    echo ' Save it NOW — a re-run will NOT regenerate or reprint it.' >&2
    echo '==============================================================' >&2
  fi
}
trap 'on_err $LINENO' ERR

# env validation first: a caller with a bad invocation should hear about that,
# not about privileges.
: "${DOMAIN:?DOMAIN is required}"
: "${REPO:?REPO is required}"
[ "$(id -u)" -eq 0 ] || { echo "[provision] must run as root" >&2; exit 1; }
BRANCH="${BRANCH:-main}"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n[provision] %s\n' "$*"; }

log "1/7 service user"
id orquester >/dev/null 2>&1 || useradd --system --create-home \
  --home-dir /var/lib/orquester --shell /usr/sbin/nologin orquester

log "2/7 packages: apt deps, Node 24, pnpm, Caddy"
apt-get update -qq
apt-get install -y git openssh-client tmux ufw python3 make g++ curl \
  ca-certificates p7zip-full ripgrep gnupg
# Desktop tabs: virtual X display, window manager, compositor, audio and its Opus encoder.
apt-get install -y tigervnc-standalone-server openbox pulseaudio \
  pulseaudio-utils dbus-x11 libgl1-mesa-dri ffmpeg xcompmgr
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 24 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi

log "3/7 release: clone + install + build (SPA, Go toolchain, orq-agent)"
RELEASES=/opt/orquester-releases
REPO_GIT="$RELEASES/repo.git"
LIVE=/opt/orquester
PREVIOUS=/opt/orquester-previous
MARKER=.orq-release-complete
TOOLING="$RELEASES/tooling"
clone_failed() {
  # An SSH clone URL needs a deploy key + known_hosts entry for root on THIS box;
  # a fresh VPS has neither. Say so instead of dying on a bare ssh error.
  echo "[provision] git clone failed: $REPO" >&2
  echo "[provision] an ssh URL (git@…) needs a deploy key in root's ~/.ssh plus a" >&2
  echo "[provision] known_hosts entry on this VPS; for a public repo use an https:// URL." >&2
  exit 1
}
if [ -L "$LIVE" ]; then
  [ -d "$REPO_GIT" ] || { echo "[provision] $LIVE is a symlink but $REPO_GIT is missing — not a release layout this script knows." >&2; exit 1; }
  layout=releases
elif [ -d "$LIVE/.git" ]; then
  layout=checkout
elif [ -e "$LIVE/.git" ]; then
  # A worktree's .git file in a real /opt/orquester: an update's conversion stopped half-way.
  echo "[provision] $LIVE is mid-conversion to the release layout — run ./deploy.sh deploy <target> to finish it, then re-run provision." >&2
  exit 1
elif [ -d "$LIVE" ] && [ -z "$(ls -A "$LIVE")" ]; then
  # Left by an older provision whose clone failed.
  rmdir "$LIVE"
  layout=releases
elif [ -e "$LIVE" ]; then
  echo "[provision] $LIVE exists but is neither a release symlink nor a git checkout — move it aside first." >&2
  exit 1
else
  layout=releases
fi

need_build=1
if [ "$layout" = checkout ]; then
  release_dir="$LIVE"
  cd "$release_dir"
  git fetch origin -q
  git checkout -q "$BRANCH"
  git reset --hard -q "origin/$BRANCH"
else
  mkdir -p "$RELEASES"
  if [ ! -d "$REPO_GIT" ]; then
    # Cloned beside and moved into place, so a half-done clone is never taken for the repo.
    rm -rf "$REPO_GIT.partial"
    git clone --bare -q "$REPO" "$REPO_GIT.partial" || clone_failed
    mv -T "$REPO_GIT.partial" "$REPO_GIT"
  fi
  git -C "$REPO_GIT" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  git -C "$REPO_GIT" fetch -q origin
  sha="$(git -C "$REPO_GIT" rev-parse --verify --quiet "origin/$BRANCH^{commit}")" \
    || { echo "[provision] branch not found on origin: $BRANCH" >&2; exit 1; }
  release_dir="$RELEASES/${sha:0:12}"
  live_dir=""
  if [ -L "$LIVE" ]; then live_dir="$(readlink -f "$LIVE")"; fi
  if [ "$(cat "$release_dir/$MARKER" 2>/dev/null || true)" = "$sha" ]; then
    log "release ${sha:0:12} is already built — not rebuilding it"
    need_build=0
  elif [ "$(readlink -f "$release_dir")" = "$live_dir" ]; then
    # Live but not marked complete (a rebuild of it was interrupted): rebuilt in place, as
    # provision always did — never deleted under the daemon that may run from it.
    log "release ${sha:0:12} is live but not marked complete — rebuilding it in place"
  else
    # A leftover of an interrupted run: start that release over from a clean worktree.
    if [ -e "$release_dir" ]; then
      git -C "$REPO_GIT" worktree remove --force "$release_dir" 2>/dev/null || rm -rf "$release_dir"
    fi
    git -C "$REPO_GIT" worktree prune
    git -C "$REPO_GIT" worktree add -q --detach "$release_dir" "$sha"
  fi
  cd "$release_dir"
fi
BOX_AGENT_WARNING=""
if [ "$need_build" -eq 1 ]; then
  CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null
  # orq-agent (apps/box-agent, Go): pinned toolchain + prebuilt apps/box-agent/dist.
  # Best-effort, like remote-update.sh: the daemon still starts without it and builds
  # on demand into the appdir, or reports orq-agent builds unavailable.
  if [ -f apps/box-agent/package.json ]; then
    if ! bash deploy/install-go.sh </dev/null; then
      BOX_AGENT_WARNING="Go toolchain install failed — orq-agent not prebuilt"
    elif ! GO=/usr/local/go/bin/go GOTOOLCHAIN=local pnpm --filter @orquester/box-agent build </dev/null; then
      rm -rf apps/box-agent/dist
      BOX_AGENT_WARNING="orq-agent build failed"
    fi
  fi
  if [ -n "$BOX_AGENT_WARNING" ]; then
    echo "[provision] WARNING: $BOX_AGENT_WARNING (see above) — continuing; deploy again to retry." >&2
  fi
fi
# voxl, the optional H.264 desktop streamer (best-effort: desktops fall back to RFB without it).
VOXL_STATUS="skipped"
if [ -f deploy/install-voxl.sh ]; then
  if bash deploy/install-voxl.sh </dev/null; then
    VOXL_STATUS="$(/usr/local/bin/voxl --version 2>/dev/null | sed -n 's/^voxl //p' | head -n1)"
    [ -n "$VOXL_STATUS" ] || VOXL_STATUS="ok"
  else
    VOXL_STATUS="FAILED: deploy/install-voxl.sh (see above)"
    echo "[provision] WARNING: voxl not installed — continuing; desktops stream with RFB. Deploy again to retry." >&2
  fi
fi
# gdu, the Storage view's disk scanner (best-effort: the view shows an install hint without it).
GDU_STATUS="skipped"
if [ -f deploy/install-gdu.sh ]; then
  if bash deploy/install-gdu.sh </dev/null; then
    GDU_STATUS="$(/usr/local/bin/gdu --version 2>/dev/null | sed -n 's/^Version:[[:space:]]*//p' | head -n1)"
    [ -n "$GDU_STATUS" ] || GDU_STATUS="ok"
  else
    GDU_STATUS="FAILED: deploy/install-gdu.sh (see above)"
    echo "[provision] WARNING: gdu not installed — continuing; the Storage view shows an install hint. Deploy again to retry." >&2
  fi
fi
# The daemon loads better-sqlite3 and node-pty under /usr/bin/node (the unit's
# ExecStart interpreter): prove they load there, rebuilding any that don't,
# before the service is started below.
if ! CI=1 /usr/bin/node scripts/ensure-node-native.mjs </dev/null; then
  echo "[provision] native modules do not load under /usr/bin/node $(/usr/bin/node -v) — not starting the daemon." >&2
  exit 1
fi
# A symlink operand would only have its link changed: chown the real directory.
chown -R root:root "$release_dir"
if [ "$layout" = releases ]; then
  # Written last: only a fully built release is ever marked complete.
  printf '%s\n' "$sha" > "$release_dir/$MARKER"
  # Switch: the live release (if another) becomes the previous one, then /opt/orquester points at
  # this one; each symlink is replaced atomically (a new link renamed over the old one).
  if [ "$(readlink -f "$release_dir")" != "$live_dir" ]; then
    if [ -d "$live_dir" ]; then
      ln -sfn "$live_dir" "$PREVIOUS.new"
      mv -T "$PREVIOUS.new" "$PREVIOUS"
    fi
    ln -sfn "$release_dir" "$LIVE.new"
    mv -T "$LIVE.new" "$LIVE"
  fi
  log "release ${sha:0:12} is live: $LIVE -> $release_dir"
  # The self-update tooling, from this release when its remote-update.sh knows the layout (each
  # file copied beside and renamed into place). Otherwise the unit falls back to the live release's.
  if grep -qx '# orq-release-layout: 1' deploy/lib/remote-update.sh 2>/dev/null && [ -f deploy/lib/self-update.sh ]; then
    install -d -m 0755 "$TOOLING"
    for tool in remote-update.sh self-update.sh; do
      install -m 0644 "deploy/lib/$tool" "$TOOLING/.$tool.new"
      mv -f "$TOOLING/.$tool.new" "$TOOLING/$tool"
    done
    log "self-update tooling installed in $TOOLING"
  else
    log "release ${sha:0:12} predates the release layout — $TOOLING not installed"
  fi
fi

log "4/7 /etc/orquester/daemon.env"
GENERATED_PASSWORD=""
if [ ! -f /etc/orquester/daemon.env ]; then
  mkdir -p /etc/orquester
  GENERATED_PASSWORD="$(openssl rand -base64 32)"
  # Create the file already-restricted: a plain `> file` redirect would use
  # root's umask (0644 on stock Ubuntu) and leave the plaintext password
  # world-readable until the chmod lands.
  install -m 600 -o orquester -g orquester /dev/null /etc/orquester/daemon.env
  # base64 alphabet never contains '|' or '&' -> safe as sed replacement
  sed "s|replace-with-a-32+char-random-secret|$GENERATED_PASSWORD|" \
    deploy/daemon.env.example > /etc/orquester/daemon.env
else
  log "daemon.env already exists — leaving it untouched (except a missing ORQUESTER_PUBLIC_URL or ORQUESTER_WEB_FALLBACK_DIR)"
fi
# The daemon's public origin, from the target's domain (an existing value is kept).
bash deploy/lib/ensure-public-url.sh /etc/orquester/daemon.env "$DOMAIN" </dev/null
# The previous release's web build, for pages opened before an update (an existing value is kept).
bash deploy/lib/ensure-web-fallback.sh /etc/orquester/daemon.env </dev/null

log "5/7 systemd unit + session devtools + start"
bash deploy/install-unit.sh </dev/null
bash deploy/provision-devtools.sh </dev/null
systemctl daemon-reload
systemctl enable --now orquester
systemctl restart orquester
curl -fsS --retry 600 --retry-delay 1 --retry-max-time 600 --retry-connrefused http://127.0.0.1:47831/health 2>/dev/null \
  || curl -fsS --max-time 10 http://127.0.0.1:47831/health; echo

log "6/7 Caddy vhost for $DOMAIN"
# Re-run safe: never clobber an existing Caddyfile that drifted from the
# template (hand reconciliation after a template update is expected — the
# deploy payload explicitly tells the operator to do it).
caddy_new="$(mktemp)"
sed "s|orquester.example.com|$DOMAIN|" deploy/Caddyfile > "$caddy_new"
if [ ! -f /etc/caddy/Caddyfile ]; then
  install -m 0644 "$caddy_new" /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
elif cmp -s "$caddy_new" /etc/caddy/Caddyfile; then
  log "Caddyfile already up to date"
else
  log "WARNING: /etc/caddy/Caddyfile differs from the repo template — leaving it"
  log "         untouched. Reconcile manually, then: systemctl reload caddy"
fi
rm -f "$caddy_new"

log "7/7 firewall: allow 22 + 443 only"
ufw allow 22/tcp
ufw allow 443/tcp
ufw --force enable

log "DONE — https://$DOMAIN"
echo "[provision] voxl=$VOXL_STATUS"
echo "[provision] gdu=$GDU_STATUS"
if [ -n "$BOX_AGENT_WARNING" ]; then
  echo "[provision] WARNING: $BOX_AGENT_WARNING — boxes fall back to an on-demand build; deploy again to retry." >&2
fi
if [ -n "$GENERATED_PASSWORD" ]; then
  echo '=============================================================='
  echo ' HTTP password (username from daemon.env, default: mapacho):'
  echo "   $GENERATED_PASSWORD"
  echo ' Shown ONCE — save it in your password manager now.'
  echo '=============================================================='
fi
