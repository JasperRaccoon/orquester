# Host storage treemap — design

## Intent

The user wants an ongoing way to keep an eye on what is consuming disk on the server the daemon runs
on, without SSHing in. Settings → Host status gets a **Storage** view: a WizTree-style treemap of the
whole disk, where every folder and file is a rectangle sized by the space it takes, and right-clicking
a rectangle gives the same kind of actions the project Files tab offers (delete, rename, download,
copy path).

Context at time of writing: `/` is 929 GB with 708 GB used (81%); a second filesystem `/data`
(938 GB) is mounted separately. A plain `du` of `/var/lib/orquester` did not finish in 60 s, so a scan
is a long background job, not a poll.

## Goals

- See, at a glance, which folders and files take the most space on a whole filesystem, starting at
  `/`.
- Drill into any folder (click a rectangle to zoom; a breadcrumb to zoom back out).
- Act on what you see: delete, rename, download, copy relative/full path, from a right-click menu.
- Keep it current without thinking about it: the daemon rescans on its own schedule, and the page opens
  instantly on the latest saved result with its age shown. A **Scan now** button forces a fresh scan.
- Use a fast native scanner.

## Non-goals

- Growth history, trends or "what grew since last week" (explicitly declined).
- Alerts or notifications when the disk fills.
- Configurable schedules, exclusion lists, or scanning remote boxes/VMs.
- Creating files, folders or uploads from the storage view (the Files tab owns that).
- Elevated (root) access: the scanner and every action run as the daemon's service user.

## Anti-goals

- A storage view that can delete Orquester's own live state, the running daemon checkout, a system
  directory, or a mount point. One mis-click must not brick the host or the daemon.
- A scan that noticeably slows the server, chats or terminals while it runs.
- A page that hangs or ships a multi-hundred-megabyte tree to the browser.
- Totals that silently lie: space the service user cannot read must be shown as such, not dropped.

## Constraints (from the repo)

- The existing `/api/fs` routes are sandboxed to `fsRoot` (default: the workspaces dir) via
  `assertInsideFsRoot`; that sandbox stays exactly as it is. Storage actions are new, separate routes
  with their own guard (below), not a widening of `fsRoot`.
- The daemon runs as `orquester` (uid 999) — it cannot read or delete root-owned paths; the design
  reports those, it does not try to escalate.
- Transport contracts go in `packages/api` first; UI goes in `packages/ui` (shared by desktop and
  web); persisted data and paths go through `packages/config` helpers.
- Remote HTTP routes require auth (already true for every `/api/*` route). Host status already lets an
  authenticated remote client kill processes, so storage actions are allowed on both transports.
- The Host status page polls every few seconds while open; the storage view must not add a heavy
  request to that poll.
- Host tools are installed by pinned, idempotent, best-effort deploy scripts (`install-go.sh`,
  `install-voxl.sh`) into `/opt/orquester-tools/<tool>/<version>/`, symlinked in `/usr/local/bin`,
  and the daemon degrades gracefully when one is missing.

## Approaches considered

1. **The daemon walks the disk itself** in a low-priority child process (Node `opendir`/`lstat`). No
   new dependency, precise progress and cancellation, exact list of unreadable paths; slower than a
   native tool.
2. **Shell out to GNU `du`** (already installed) and parse its output. Fast, but progress is vague
   (sizes arrive only as each folder finishes), unreadable paths arrive only as stderr text, and
   parsing millions of lines has its own edge cases.
3. **Ship a fast native scanner** — chosen by the user. Fastest scans (a parallel scanner on this
   RAID-backed disk), at the cost of a binary that deploy has to install and keep pinned.

**Chosen: 3, using `gdu`** (Go, MIT, parallel, exports the ncdu-compatible JSON tree with read-error
markers and inode/hard-link info). It fits the existing pinned-tool pattern, and the Go toolchain is
already provisioned on hosts by `install-go.sh` if building from source is preferred over the release
binary.

## Design

### 1. Scanner install (deploy)

- New `deploy/install-gdu.sh`, modelled on `install-voxl.sh`: pinned `GDU_VERSION` with per-arch
  SHA-256 of the official release binary (amd64, arm64), installed to
  `/opt/orquester-tools/gdu/<version>/gdu`, symlinked at `/usr/local/bin/gdu` (an existing
  non-symlink is left alone). Idempotent; run as root by `remote-provision.sh` and `remote-update.sh`
  best-effort (a failure only warns).
- The daemon resolves the binary the same way voxl is resolved: `<appdir>/bin/gdu`, then the sessions'
  PATH, then `/usr/local/bin/gdu`.
- Without the binary, the Storage view shows an empty state saying the scanner isn't installed and how
  to install it (run the deploy, or `sudo bash deploy/install-gdu.sh`). Nothing else breaks.
- Document it in `deploy/README.md` next to voxl/Go.

### 2. Scan service (daemon)

A `StorageScanService` in `apps/daemon/src/storage-scan.ts` (wired in `index.ts` beside
`SystemStatusService`), owning:

- **Volumes.** The scannable filesystems: real local filesystems from `/proc/self/mountinfo`
  (ext4, xfs, btrfs, zfs, f2fs…; not tmpfs/proc/overlay/vfat boot partitions), de-duplicated by device
  so bind mounts of `/` (`/etc`, `/usr`, `/var`, `/tmp` on this host) collapse into one `/` volume.
  **Important (found in review):** the daemon runs under systemd `ProtectSystem=strict`, so inside its
  mount namespace `/etc`, `/usr`, `/var` and `/tmp` are separate bind mounts of the same device. The
  "stay on one filesystem" rule must therefore compare *device IDs*, not stop at mount points —
  otherwise a scan of `/` would skip `/var` and with it `/var/lib/orquester`, the main suspect. The
  builder must confirm the pinned gdu's no-cross flag behaves this way (it should, being device-based);
  if it doesn't, scan without no-cross and pass the other volumes' mount points (and `/proc`, `/sys`,
  `/dev`, `/run`) as ignored dirs. Also, `ProtectHome=true` hides `/home` and `/root` from the daemon:
  they read as empty, so their space lands in the "Unaccounted" block — the UI tooltip on that block
  says so.
  Each volume reports mount point, total/used/free bytes (statfs) and its latest scan's summary. On
  this host that is `/` and `/data`.
- **Running a scan.** One scan at a time host-wide. It spawns gdu under
  `nice -n 19 ionice -c 3` with: non-interactive, no-cross (stay on that filesystem), export the JSON
  tree to a temp file in the appdir. Cancel kills the process group. The exact gdu flags and whether it
  emits usable progress during export are for the builder to confirm against the pinned version; the
  UI requirement is: while scanning, show elapsed time and, when available, items/bytes so far; if gdu
  gives no live progress, show elapsed time against the previous scan's duration.
- **Pruning.** The raw export can be hundreds of MB for millions of files. The daemon stream-parses it
  and keeps a compact tree: every directory, plus files at or above a size threshold; the rest of each
  directory's files are folded into one synthetic "N smaller files" node carrying their total. Sizes
  are **disk usage** (allocated blocks), with apparent size kept alongside. Hard links count once.
  Directories gdu could not read are kept and flagged `unreadable`; the volume's "used" minus the
  scanned total is shown as an **"Unaccounted (not readable by orquester)"** block at the root, so
  the map always adds up to the disk's used space.
- **Persistence.** The pruned tree per volume is saved under a new `packages/config` path helper
  (e.g. `<appdir>/daemon/storage/<volume-id>.json`, written atomically), with scan start/end time,
  duration, scanner version and totals. Only the latest scan per volume is kept. A corrupt or
  unrecognised file is treated as "no scan yet".
- **Schedule.** A nightly automatic scan of each volume (one after the other) at a low-traffic hour
  local to the host, skipped if that volume was scanned in the last 20 hours or a scan is already
  running. A daemon restart mid-scan simply drops it; the next schedule or a manual scan redoes it.
- **After an action.** A successful delete or rename updates the saved tree in place (remove the node
  and subtract its size up the chain; or rename the node), so the map is correct immediately without a
  rescan.

### 3. API (`packages/api`)

Route constants in a `storageRoutes` object, types beside them. Off Linux, or without gdu, responses
say `supported: false` / `scanner: "missing"` like the `/api/system` routes do.

- `GET /api/system/storage` — volumes with statfs totals, latest-scan summary, and current scan state
  (idle / scanning with progress / last error).
- `POST /api/system/storage/scan` `{ volume }` — start a scan (409 if one is running).
  `DELETE /api/system/storage/scan` — cancel.
- `GET /api/system/storage/tree?volume=&path=&depth=` — a subtree of the saved scan rooted at `path`,
  `depth` levels deep (default enough for a good-looking map, e.g. 3–4), with children below a minimum
  share of the parent folded into "other". This is how zooming fetches detail without shipping the
  whole tree.
- `POST /api/system/storage/delete` `{ path, confirm }`, `POST /api/system/storage/rename`
  `{ path, newName }` — the guarded actions (below).
- Download reuses the existing streamed download route only if the path is inside `fsRoot`; for paths
  outside it, a storage-scoped download route with the same streaming and zip behaviour and the storage
  guard (read-only checks only: must exist, be readable, not a special file).
- Scan state changes are pushed through the existing broadcaster (a `storage.changed` event) so the
  page updates when a scan finishes, rather than polling the tree.

### 4. The action guard

Storage actions are **not** confined to `fsRoot`, so they get their own server-side guard, applied after
`realpath` resolution of both the target and every protected path:

- Refused outright for delete and rename (403, with a reason the UI shows):
  - `/` itself, every direct child of `/` (`/usr`, `/etc`, `/var`, `/home`, `/boot`, `/opt`, `/data`,
    …), and any mount point (including a volume root such as `/data`). *Builder's call, made in
    review:* this applies to children of `/` only — top-level folders inside a data volume such as
    `/data/foo` are deletable (with typed confirm), since cleaning those up is the point of the view;
  - the daemon's appdir state (`<appdir>/daemon` and its contents), the running daemon checkout (the
    repo the daemon process runs from), the workspaces root itself, the configured `fsRoot`, and the
    gdu install dir;
  - the service user's home is the appdir on this host (`orquester:…:/var/lib/orquester`), so these
    are protected too *(my call, made in review)*: `<appdir>/bin`, `<appdir>/tmp` (the daemon's
    `TMPDIR`), `.local`, `.npm-global` (both on the service's PATH), `.claude`, `.claude.json`,
    `.codex`, `.config`, `.ssh`, and `.docker` — deleting any of them breaks chats, tools or git.
    Their *contents* may still be shown; only the protected entries and their ancestors are refused.
    Cache dirs (`.cache`, `.npm/_cacache`, `go/pkg/mod`, …) stay deletable — they are typical space
    hogs and safe to regenerate;
  - anything that is an ancestor of one of those (deleting `/var/lib` would take the appdir with it).
- **Reading secrets.** Download is refused (403) for `<appdir>/daemon/**` (keys, auth sessions,
  `daemon.json`, agent-account credential homes), `<appdir>/app/**` and `/etc/orquester`, and — since
  no denylist of credential files can be complete — for **everything in the service user's home and
  the appdir except the workspaces root** (and `fsRoot` when it lies in there); the daemon's state stays
  refused even if those overlap it. Every action (delete, rename, download) is refused under the kernel
  pseudo-filesystems `/proc`, `/sys`, `/dev` and `/run` (`/proc/self/environ` is the daemon's env). A
  folder containing a refused path can't be zipped (so `/`, `/var/lib` and the home itself are refused),
  and a file download never sends more bytes than its stat size. Download auth reuses
  the existing `?token=` allowance that `/api/fs/download` has (added for exactly this storage
  download route, nothing broader) *(my call)*. The tree itself only ever returns names and sizes,
  never contents.
- Delete and rename are also refused on a filesystem mounted read-only in the daemon's mount namespace
  (systemd `ProtectSystem=strict`; the nearest enclosing mount in `/proc/self/mountinfo` decides), so
  the UI says so up front instead of failing with `EROFS` after the confirm.
- Every delete first closes the sessions, browser tabs and desktops rooted in the tree (a project can be
  symlinked outside the workspaces root); inside the workspaces root it also notifies workspaces changed,
  i.e. the same side effects as `DELETE /api/fs` — ideally by calling the
  same code path, not duplicating it.
- Outside the workspaces root, delete requires `confirm` to equal the entry's name (typed by the user
  in the dialog); the server checks it. Rename outside the workspaces root needs no typed confirm (it
  is reversible), but the same refused set applies.
- Everything else is left to the OS: if the `orquester` user can't delete it, the error is shown as-is.

### 5. UI (`packages/ui`)

- **Where.** A third tab on the Host status page, **Storage**, beside Processes and Listening ports.
  It does not join the page's 3-second poll: it loads the volume list once when the tab opens, then
  listens for `storage.changed`.
- **Header.** Drive picker (one chip per volume: mount point, used/total bar), the scan's age
  ("Scanned 6 h ago, took 4 min"), and **Scan now** / **Cancel**. While scanning, a progress line.
- **Treemap.** Squarified treemap drawn on a canvas (thousands of rectangles stay smooth), laid out
  with `d3-hierarchy` (new dependency, same family as the `d3-force` the UI already uses). Nested
  folders are drawn inside their parents WizTree-style; colour by top-level folder (or by file type for
  files); labels where a rectangle is big enough; hover shows path, size and share. Click a folder to
  zoom (fetch its subtree); breadcrumb to go back. Unreadable and "Unaccounted" blocks are drawn grey
  and hatched. Keyboard and screen-reader access via a companion sorted list beneath the map
  (biggest first, same right-click menu), which also serves narrow/mobile widths.
- **Right-click menu** (same `ContextMenu` component as the Files tab): Open (zoom in, folders only),
  Download / Download as Zip, Copy Relative Path (relative to the volume root), Copy Full Path, Rename,
  Delete, and "Open in Files" when the path is inside a project. Items the guard would refuse are shown
  disabled with the reason as a tooltip (the server still enforces it).
- **Delete dialog.** Shows path and size; outside workspaces it asks to type the name to confirm.
- **Empty and error states.** No scan yet (with Scan now), scanner missing (install hint), unsupported
  host, scan failed (error text and Retry).

## Testing

- Daemon: the guard (protected paths, ancestors, mount points, symlink tricks resolved by realpath,
  confirm mismatch) through the routes; pruning and "unaccounted" arithmetic from a small fixture
  export in gdu's JSON format; tree subtree/depth/fold queries; delete/rename updating the saved tree;
  tolerant loading of a corrupt saved scan; scheduler skip rules with `mock.timers`. The real gdu run
  is covered by one integration test that skips when gdu isn't installed, scanning a temp directory.
- UI: treemap layout behaviour that a user would notice (zoom fetches the subtree; disabled menu items
  for refused paths; type-to-confirm gating) through a DOM test; visual look proved with screenshots.

## Left to the builder

- gdu version, exact flags, and its progress/export behaviour; release-binary vs `go install`.
- Pruning threshold and subtree depth/fold numbers (tune on this host's real disk).
- The nightly hour and colour palette.
- How to share the in-workspace delete side effects with `DELETE /api/fs` without duplicating them.
