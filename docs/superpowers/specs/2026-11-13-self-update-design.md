# Self-update for VPS installs — design

## Why

Updating Orquester today means someone runs `./deploy.sh deploy` from a dev checkout. That works for
the maintainer, but an operator who provisioned a VPS and doesn't follow the repo has no way to know
a newer release exists, and silently falls far behind. Orquester should tell them, and update itself
from one button.

## Goals

- Settings → General → About shows the server's commit only (drop the meaningless `0.0.0 ·`).
- The daemon notices when the commit it runs is behind the head of its install's branch on GitHub,
  checking at boot and **every hour**.
- The UI tells the user ("Orquester is out of date — N commits behind") with a dismissible toast
  that opens Settings, and Settings → About shows the state with an **Update** button.
- Update runs the same cycle as `./deploy.sh deploy` on the host (fetch, install, build, restart,
  health check, automatic revert) and the page reloads itself onto the new release.

## Non-goals

- No self-update for the desktop app's embedded daemon or for dev daemons (`pnpm dev:daemon`).
- No browser smoke test (that runs from the operator's machine in `deploy.sh`); the remote
  health check and automatic revert still apply.
- No release channels, changelog view, or scheduled auto-update.

## Anti-goals

- The daemon user gaining any new way to run arbitrary commands as root.
- An update that kills itself by restarting the daemon it runs under.
- Nagging an operator who deliberately runs a commit that is ahead of / diverged from main
  (only "behind" counts as out of date).

## Approaches considered

1. **Privileged systemd unit triggered by a path unit (chosen).** `orquester-update.service`
   (root, oneshot) runs `deploy/lib/remote-update.sh`; `orquester-update.path` starts it when the
   daemon writes a request file in its appdir. No new sudo rule; the unit runs outside the daemon's
   cgroup so the daemon restart doesn't kill it; the trigger carries no arguments (fixed branch),
   so writing the file can't inject anything.
2. **Scoped sudoers line for `systemctl start orquester-update.service`.** Same unit, but widens
   the sudoers file and needs `NoNewPrivileges=false` to keep holding. Rejected: the path unit
   needs no privilege at all.
3. **Daemon runs the update itself.** Impossible without root: `/opt/orquester` is root-owned,
   `ProtectSystem=strict`, and the daemon can't restart its own unit.

## Design

**Detection (daemon).** A module reads the checkout's `origin` URL from `.git/config` and the
branch the install tracks (`main`). When origin is a GitHub repo it calls
`GET https://api.github.com/repos/<owner>/<repo>/compare/<running commit>...<branch>`
(unauthenticated; the repo is public, 1 request/hour per host is far under the limit). `status:
"behind"` with `behind_by` → out of date; `identical`/`ahead`/`diverged` → not. Result cached in
memory with `checkedAt`; network or API errors keep the last result and record the error. Checks at
boot and hourly. Using the install's own origin means the check and the update always look at the
same repository, forks included.

**Capability.** Self-update is available only when the daemon runs under a unit that has the
update units installed: `orquester.service` sets
`ORQUESTER_SELF_UPDATE_STATUS=/var/lib/orquester-update/status.json`. Without that variable the
daemon still reports "out of date" (useful information) but `canUpdate` is false and the UI says
to update with `./deploy.sh deploy`.

**Trigger + status.** `POST /api/self-update` (authenticated) writes `<appdir>/daemon/update-request`.
`orquester-update.path` (`PathExists=`) starts the root oneshot `orquester-update.service`. Its
`ExecStartPre` copies `deploy/lib/self-update.sh` and `deploy/lib/remote-update.sh` into its
`RuntimeDirectory` (bash reads a script while running it, and the update rewrites the checkout),
then runs the copied wrapper, which: removes the request file (so the path unit doesn't loop),
writes `{ state: "running", from, startedAt }`, runs `remote-update.sh` with `BRANCH=main`, and
writes the outcome: exit 0 → `succeeded`, 3 → `reverted`, anything else → `failed` (with
`exitCode`, `finishedAt`). Root writes status only into its own `StateDirectory`
(`/var/lib/orquester-update`, root-owned, world-readable) — never into a directory the daemon user
controls (a planted symlink would otherwise redirect a root write). The request file's content is
ignored; the branch is fixed, so writing it can't inject anything.
`GET /api/self-update` returns `{ current, latest, behindBy, checkedAt, error, canUpdate, run }`
where `run` is the status file or null. A POST while `run.state === "running"` (or a request file
already pending) answers 409.

**UI.** The commit-only label in About; an "Updates" row: up to date / N commits behind / checking
error, plus **Update** when `canUpdate`. An `UpdateAvailableToast` in the `ToastStack` shows when
`canUpdate && behindBy > 0` (a dev checkout or the desktop app's daemon is never nagged; the
Settings row still reports "behind" everywhere), dismissible per latest commit (localStorage, validated), with "Open settings".
After POST the row shows "Updating…" and polls `GET /api/self-update` (the daemon disappears during the
restart; failed requests are expected). When `/api/info` reports a commit different from the one
the update started from, the client runs the existing reload (service-worker update + reload). A
`failed`/`reverted` status is shown with the step.

**Install.** `install-unit.sh` also installs `orquester-update.service` and
`orquester-update.path` and enables/starts the path unit (it never starts the update service).
The service sets `HOME=/root` (a `git@` origin needs root's deploy key), `TimeoutStartSec=infinity`. Provision and every deploy run it, so existing
VPSes get self-update after one last manual deploy.

## Left to the builder

Exact copy, the polling interval while updating, module/route names, and how the status file is
written from bash (a small `printf` like the version stamp).

## Calls made without asking

- Compare against the install's own `origin` (not hard-coded upstream) so check and update agree.
- Path unit over a sudoers rule.
- "Out of date" only when strictly behind.
