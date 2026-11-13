# Staged release updates — design

## Intent

Clicking **Update** (Settings → General → About, the self-update) or running `./deploy.sh deploy`
should not stop people working. Today a ~4-minute update on vps-b was:

- **~3½ min build** (pnpm install, web build 2m18s, embed build 44s, box-agent ~1 min). The old
  daemon keeps running, but `git reset --hard`, `pnpm install` and the web build rewrite its own
  checkout (`/opt/orquester`) underneath it: sources it may still lazily import, `node_modules`, and
  the `apps/web/dist` it serves. Open pages fetch chunks that were just deleted or get a half-built
  `index.html` — "everything is weird".
- **~3 s restart**, then **~30 s to healthy** (minutes after a large update: the first start
  transpiles every changed module, tsx's cache is cold).

Chats (agent host) and terminals (tmux) already survive the restart; only the browser's connection
to the daemon drops.

The user chose: a few seconds of "Reconnecting…" at the switch is fine; nothing else should be
disturbed (option 1 of "short reconnect vs no blip at all").

## Goals

- During the build, the running daemon and the pages it serves are untouched — users work normally.
- The visible interruption is the restart only: a few seconds of "Reconnecting…", ideally ≤ 10 s,
  because the new release is pre-warmed (no cold transpile on first start).
- Pages opened before the switch keep working after it (their lazily-loaded chunks still resolve).
- Rollback (automatic on a failed health check, or `./deploy.sh rollback <sha>`) to a release that is
  still on disk is a switch + restart, no rebuild.
- Existing installs convert automatically on their next update; no manual step.

## Non-goals

- A no-blip handover (two daemons at once, socket/tmux/agent-host/timer handover).
- Changing how the agent host, tmux sessions or chats survive a restart (they already do).
- Multi-host or container deployments.

## Anti-goals

- An update that fails mid-build changing what runs (it must leave the current release live).
- Releases filling the disk.
- Breaking `./deploy.sh` (deploy, rollback, verify, provision), the self-update unit, or a rollback
  to a release from before this change.
- Running a half-built release.

## Constraints (from the repo)

- `/opt/orquester` is hard-wired in many places: `orquester.service` (`WorkingDirectory`,
  `ExecStart`), `orquester-update.service` (copies `deploy/lib/*.sh` from it), `daemon.env`
  (`ORQUESTER_WEB_DIR=/opt/orquester/apps/web/dist`), `deploy.sh verify`, `remote-provision.sh`,
  docs. It must keep resolving to the live release.
- `remote-update.sh` runs both over ssh from `deploy.sh` and as root from `orquester-update.service`
  (no ssh session, `SUDO` unset); and (since `f140951d`) hands over to the release's own copy after
  the reset — the hand-over must keep working.
- Per-checkout state lives in `/opt/orquester/.git`: the update lock (`orq-deploy.lock`, flock) and
  the last successful deploy (`orq-last-deployed-head`). Both must be shared across releases.
- The daemon runs as `orquester` through `tsx`; its transpile cache is `$TMPDIR/tsx-<uid>` with
  `TMPDIR=/var/lib/orquester/tmp`. A warm-up run as root would fill root's cache, not the daemon's.
- `apps/daemon/src/build-info.ts` reads the commit from the checkout (`.git` dir or a linked
  worktree's `.git` file — already supported) or from `.orquester-version.json`.
- Node resolves the entry point through symlinks (`preserveSymlinks` off), so a running daemon's
  relative imports stay inside the real directory it started from even after the symlink moves.

## Approaches considered

1. **A directory per release, `/opt/orquester` a symlink to the live one** — chosen. Build in
   `/opt/orquester-releases/<sha>`, warm it, flip the symlink, restart. Keeps every existing path,
   makes rollback a flip, isolates the build completely. Costs disk for 2–3 kept releases
   (`node_modules` mostly hard-linked from the pnpm store) and a one-time conversion.
2. **Two fixed slots (A/B), alternating** — simpler layout, but only one level of rollback, and a
   failed build half-overwrites the slot a rollback would need.
3. **One checkout, stage only the web build** — smallest change, but `git reset` and `pnpm install`
   still rewrite the running daemon's code and dependencies; doesn't meet the goal.

## Design

### Layout

```
/opt/orquester-releases/
  repo.git/              shared git dir: objects, refs, the update lock, orq-last-deployed-head
  <sha12>/               one release: a linked worktree of repo.git at that commit, fully built
  <sha12>/ …
/opt/orquester           -> /opt/orquester-releases/<live sha12>      (symlink)
/opt/orquester-previous  -> /opt/orquester-releases/<previous sha12>  (symlink; may be absent)
```

Releases are linked worktrees (`git worktree add --detach`) of one shared repository, so fetches
are shared and `git -C /opt/orquester …` keeps working. The lock and `orq-last-deployed-head` move
to `repo.git/`.

### Update cycle (`remote-update.sh`)

1. Take the lock (in `repo.git/`). Read the live release (realpath of `/opt/orquester`) and the
   last successful deploy.
2. Fetch into `repo.git`; resolve `RESET_REF` to a sha. If `releases/<sha>` already exists and is
   marked complete (a marker file written last by step 4), skip to step 5 (a re-deploy or rollback
   to a kept release is instant).
3. Create `releases/<sha>` as a fresh worktree (remove a leftover incomplete one first).
4. In that directory only: `pnpm install --frozen-lockfile`, web + embed build, Go/box-agent,
   voxl/gdu installers, native-module guard, **warm-up** (below), chown, version stamp, then the
   completion marker. Any failure: stop here — the live release was never touched; delete the
   incomplete directory; exit 1 as today.
   (The hand-over check moves to right after step 3, before the build — see "Update tooling".)
6. `prepare_host` from the new release (public URL, units — `install-unit.sh` of the new release),
   but only when that release is layout-aware (see "Update tooling"); otherwise the units installed
   now stay.
7. **Switch**: point `/opt/orquester-previous` at the live release, then atomically replace the
   `/opt/orquester` symlink (`ln -sfn` to a temp name + `mv -T`). Restart, health check (as today).
8. Unhealthy: flip `/opt/orquester` back to the previous release, `prepare_host` from it, restart,
   health check — no rebuild. Exit codes 3/4 as today.
9. Healthy: record `orq-last-deployed-head`; prune releases (see "Pruning").

### Pruning *(my call, made in review)*

The agent host deliberately survives daemon restarts and is only replaced when its own code stamp
or protocol changes (`agent-host/support/code-stamp.ts`), and a retiring host may live up to 12 h.
It loads files from its own release directory on demand (e.g. the Claude adapter's
`history-worker.mjs`, `node_modules`), as may desktop/device helpers launched from code-relative
paths. So a release directory must never be deleted while any process still uses it.

Rule: keep the live release, the previous release, one more, **and every release any running
process still references** (cwd, executable, command line or open files/maps under that directory,
from `/proc`). Delete the rest. This is bounded in practice (one long-lived agent host pins at most
one extra release, plus retiring hosts for ≤ 12 h); a deploy that finds more than ~5 kept releases
warns in its summary instead of deleting an in-use one. A disk-space check before the build refuses
an update that would leave the volume nearly full.

### Update tooling across releases *(my call, made in review)*

A release from before this change ships a `remote-update.sh` and units that know nothing of the
layout: its script would `git reset --hard` in place inside a worktree, miss the lock (`.git` is a
file there), and fail to record the deploy; its `orquester-update.service` would make later
self-updates use that old script. So:

- Each layout-aware `remote-update.sh` declares it (a marker line the current script greps for).
- The hand-over (f140951d) happens right after the new worktree is created — before the build, so
  steps a release adds still run on the update that delivers it — and **only to a layout-aware
  script**. A rollback to an older release is carried out by the current script.
- `prepare_host` installs units from the target release only if it is layout-aware; otherwise the
  current units stay, so self-update keeps using layout-aware tooling after a rollback to an old
  release.

### Startup time *(my call, made in review)*

The ~30 s to healthy is not yet broken down (tsx transpile vs. `agentChat.init()` adopting the agent
host vs. session reattach). The build measures it first on a real host, then adds the warm-up.
"≤ 10 s" is the target, not a gate: if warm-up alone doesn't reach it, the result is reported with
the measured breakdown and any daemon startup work becomes a separate follow-up — it is not part of
this project.

### Warm-up

Before the switch, populate the daemon's tsx cache for the new release by loading its module graph
as the daemon user with the daemon's `TMPDIR` — e.g. a small script that imports the daemon's entry
modules (and the agent host's) without starting anything, run as `orquester` via `runuser`. The
builder must confirm how tsx keys its cache (content vs path) and that the warmed entries are hit by
the real start; the measure of success is the time from restart to healthy.

### Pages opened before the switch

`daemon.env` gains `ORQUESTER_WEB_FALLBACK_DIR=/opt/orquester-previous/apps/web/dist`. The static
handler serves a request for a hashed asset (`/assets/*`, embed chunks) that the live dist doesn't
have from the fallback dir, if present. `index.html` and everything unhashed always come from the
live dist. After reconnecting, the UI's existing "new version" handling (if any — builder to check;
otherwise a gentle "Orquester was updated — reload" notice) moves the page to the new build.

### Conversion of an existing install

On the first run of the new `remote-update.sh` where `/opt/orquester` is a real directory with
`.git/`:

- Move its git dir to `/opt/orquester-releases/repo.git` (or clone it there bare-ish and keep the
  old dir as the first release), register the old directory as release `<old sha>` without
  rebuilding it, carry over the lock/state files, build the new release as above, and at the switch
  replace the directory with the symlink (`mv /opt/orquester /opt/orquester-releases/<old sha>` then
  the symlink, back to back, immediately before the restart).
- The builder must make this step safe to re-run after a crash at any point (each sub-step
  idempotent, detectable from the filesystem) and keep the running daemon working until the restart
  (its open files and already-loaded modules are unaffected; the window where `/opt/orquester`
  briefly points elsewhere is the seconds before the restart).

`remote-provision.sh` creates the new layout directly on fresh hosts.

### Rollback (`./deploy.sh rollback <target> <sha>`)

Same cycle with `RESET_REF=<sha>`: a kept, complete release switches instantly; otherwise it is
built in its own directory first. A target release from before this change builds and runs fine in
a release directory (it never relied on its own path being a real directory).

## Testing

- Extend `deploy/lib/remote-update.test.mjs` (real git + stubs) to cover: a deploy builds in a new
  directory and only then flips the symlink; a failed build leaves the symlink and the live tree
  untouched; an unhealthy release flips back without a rebuild; a re-deploy of a kept release skips
  the build; pruning keeps live + previous + one; conversion from a plain checkout (including
  re-running after an interruption between its steps); the hand-over still works across the
  conversion; the lock is shared across releases; a release referenced by a running process is
  never pruned; a rollback to a pre-layout release keeps the layout-aware units and tooling.
- The static fallback: a daemon route test that a missing hashed asset is served from the fallback
  dir and `index.html` never is.
- Measure on a real host (after review, with the user's go-ahead): time-to-healthy after a restart
  with and without warm-up.

## Left to the builder

- Exact commands for the worktree/bare-repo handling and the conversion's idempotent sub-steps.
- The warm-up script (what to import so the cache covers the start), and confirming tsx's cache key.
- The `/proc` scan for in-use releases, the exact warning threshold, the disk-space margin.
- The marker that makes a `remote-update.sh` layout-aware.
- Whether the UI already reloads on a build change after reconnect; the notice if it doesn't.
