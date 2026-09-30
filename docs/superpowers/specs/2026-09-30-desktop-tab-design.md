# Desktop tab — run Linux GUI apps on the server, with audio, from Orquester

Status: design approved by the owner on 2026-09-30, section by section (stack A after a measured
comparison with Selkies 2.0; process model and survival; data model, API, WebSockets and MCP; the
tab, launch flow, audio UX and mobile; audio internals, errors, testing and scope). The owner chose
the WASM Opus fallback with a CSP change for browsers without WebCodecs Opus. This document is the
written spec awaiting the owner's review.

Research inputs (2026-09-30, this VPS: Ubuntu 24.04.4, 12 × AMD EPYC vCPU, 47 GiB, no GPU, no
`/dev/dri`): the Browser tab end to end (`apps/daemon/src/browsers.ts`, `/ws-browser`,
`/ws-devtools`, `BrowserView.tsx`), tmux service sessions and `sessions.ts` `reattach()`, the
tolerant saved-prompts store, `assertInsideFsRoot`, the MCP tool groups, `deploy/Caddyfile`;
primary sources on WebCodecs Opus in WebKit, noVNC 1.7.0, TigerVNC Xvnc 1.13.1, KasmVNC 1.5.0,
Xpra 6.5 / xpra-html5, Selkies 2.0.0, PulseAudio 16.1 and ffmpeg 6.1.1; two throwaway spikes on this
host (§3), since removed. The spike installed these packages, which stay installed:
`tigervnc-standalone-server tigervnc-tools openbox pulseaudio pulseaudio-utils wmctrl xdotool
x11-utils xterm dbus-x11`.

## 1. Problem and goal

Orquester can run terminals, agent chats and a headless Chromium, but not a Linux GUI app. The goal
is a **Desktop** tab: a virtual display on the server that one or more X11 apps run in, streamed
into the tab with video, audio and input (mouse, keyboard, touch, clipboard), on desktop and
mobile. The motivating app is the JasperEngine editor (ImGui on OpenGL, sound in play mode, at
`JasperEngine/build/linux/editor-install/bin/jasperengine-editor`); it must work equally for
`xterm`, GTK and Qt apps, Godot, GIMP, Blender, and games with sound.

### 1.1 Requirements (the owner's)

1. A new project tab type showing one **desktop**: a virtual display with its window manager and
   audio sink.
2. **Audio** reaches the browser with the least achievable latency, including on mobile; audio and
   video never drift apart over a long session.
3. **Several apps share one display.** Launch more apps into an existing desktop, switch between
   their windows, close one app without tearing down the desktop. An app exiting never kills its
   desktop.
4. **Several viewers** of one desktop at once (phone and laptop, two Orquester windows); the
   display is shared, not duplicated.
5. Desktops and running apps **survive page reloads and daemon restarts** (tmux service sessions,
   reconciled on boot like `sessions.ts` `reattach()`).
6. Closing the tab (after a confirmation if apps are running) stops the desktop and its apps;
   deleting the project stops all its desktops. Otherwise a desktop stops only on explicit Stop.
7. `projectPath` and every `cwd` are validated with `assertInsideFsRoot` (unlike today's
   `POST /api/browsers`).
8. A window list in the tab toolbar (focus/raise, maximize, close), updated by events, not polling.
9. A generic launch dialog (command line, working directory, env vars, target desktop, recent
   commands per project) with suggestions from `.desktop` files and project executables.
10. The same operations exposed to agents through MCP.
11. An "enable sound" control for autoplay rules (especially iOS), per-desktop mute and volume,
    and audio streamed only to active viewers.
12. Missing host binaries produce an install hint, never a silent failure.
13. Runs behind Caddy on Orquester's own origin.

### 1.2 Out of scope for v1

GPU or hardware video encoding; an H.264 video mode (§14); recording; microphone input (§14);
per-app audio mixing (one mix per desktop); screenshots and synthetic input for agents; file
transfer; gamepads.

## 2. Terms

- **Desktop:** one virtual X display (TigerVNC `Xvnc`), plus its Openbox window manager, its
  PulseAudio server with one null sink, and its D-Bus session bus. Identified by `desktopId`.
- **App:** a process launched into a desktop from a shell command line. Identified by `appId`.
- **Window:** a top-level X window listed by the window manager in `_NET_CLIENT_LIST`.
- **Viewer:** one client connection showing a desktop: one RFB stream, plus an audio stream while
  sound is on.
- **Host:** the `desktop-host.sh` process in the desktop's tmux service session that owns the
  display, audio, bus and window manager.

## 3. Stack decision and measurements

### 3.1 Options compared

| | A. Xvnc + noVNC + own audio (**chosen**) | B. KasmVNC | C. Xpra + HTML5 client | D. Selkies 2.0 |
|---|---|---|---|---|
| Video | RFB (Tight/JPEG/ZRLE), changed pixels only | RFB, better encoders | per-window or desktop, many encoders | H.264/JPEG over WebSocket (WebRTC opt-in) |
| Audio | per-desktop PulseAudio → ffmpeg Opus → our WS | none in the core server (only via Kasm Workspaces / archived GPL-3.0 kclient) | built in, via MediaSource (buffered, high latency; Opus+MKA blacklisted on Safari) | built in (Opus, 10 ms frames) |
| Client | noVNC `RFB` bundled in `packages/ui` | its own web client (iframe) | its own client (iframe or bundle) | its own bundled client (iframe or daemon proxy) |
| Auth | ours (WS `?token=`) | its own Basic auth + TLS; must not become a second login | its own | its own; must be disabled and put behind ours |
| Caddy / CSP | no change (the WASM fallback adds `'wasm-unsafe-eval'`, §8.3) | carve-out like `@devtools` | carve-out | carve-out for its page |
| Licence | noVNC MPL-2.0 (bundled); TigerVNC GPL-2.0 (separate host process) | GPL-2.0 | server GPL-2.0+, HTML5 client MPL-2.0 | MPL-2.0 |
| Ubuntu 24.04 | apt: `tigervnc-standalone-server` 1.13.1 | upstream .deb | apt ships 3.1.5 (old); upstream repo for 6.x | upstream .deb (~276 MB Python env), released 2026-09-23 |

Xpra licensing: serving or bundling the MPL-2.0 HTML5 client only obliges publishing changes to
those files; running the GPL server as a separate process over a socket is normally mere
aggregation. Moot, since C is not chosen. Selkies 2.0 is now WebSocket-first and needs no TURN,
which removed D's original blocker, so it was measured (§3.2).

### 3.2 Measured on this host (spikes, 2026-09-30)

Workload: JasperEngine editor at 1280×800 (A) or 1280×576 (D, client-sized), llvmpipe,
`LP_NUM_THREADS=2`, a 440 Hz tone in the desktop's sink, one headless-Chromium viewer.

| Measure | Result |
|---|---|
| Audio: sink write → Opus packet out of the ffmpeg pipeline, 10 ms frames | median ~21 ms (11–29 ms, 12 trials) |
| Same with 20 ms frames | median ~33 ms |
| Browser: WebCodecs `AudioDecoder` Opus in Chromium | supported; `baseLatency` 10 ms, `outputLatency` 32 ms |
| A, per-desktop streaming stack (Xvnc + ffmpeg Opus + PulseAudio + relay), 1 desktop | ~15–18 % of one core |
| A, 3 concurrent desktops each running the editor, tone and a viewer | ~1.9 cores per desktop, of which ~1.8 is the editor; stack overhead unchanged per desktop |
| JasperEngine editor on llvmpipe, threads uncapped | 4.6 cores at ~95 FPS |
| Same with `LP_NUM_THREADS=2` | 1.8–1.9 cores at ~26 FPS |
| Editor idle: A (Xvnc) vs D (Selkies x264) | A ~94 kbit/s at ~7 % + audio ~96 kbit/s at ~8 %; D ~590 kbit/s at ~35 % (audio included) |
| Game in motion (TappyPlane play mode): A vs D | A ~430 kbit/s at ~13 % + audio; D ~1.2 Mbit/s at ~41 % |
| Fixed 30 ms jitter buffer, host ~80 % busy, ~1 minute | depth 20–45 ms, 7 underruns, 15 drops: bounded, but the target must adapt (§8.2) |

Findings that shape the design:

1. **The CPU budget is the apps' software rendering, not the encoders.** A virtual display has no
   vblank, so GL apps render uncapped on every core. The llvmpipe thread count is the main lever
   (§5.5).
2. **Xvnc must use an X authority cookie.** Without `-auth`, an unauthenticated local client
   connected; the abstract-namespace X socket is not protected by file modes (§5.7).
3. **`_NET_WM_PID` is not reliable.** The JasperEngine editor does not set it. Xvnc supports the
   X-Resource extension, which gives each window's owning pid (§6.2).
4. **Killing a tmux session orphans backgrounded children.** `pulseaudio` and `dbus-daemon`
   survived `kill-server`; the Selkies host with `trap 'kill 0' EXIT` left none (§5.2).
5. **An app launched without the desktop's audio env fails its audio** ("Failed to initialize
   audio output"): every app gets the full env (§5.5).
6. **TigerVNC sends only pixels that changed.** ImGui repaints every frame even when nothing moved.
   Selkies re-encodes on every damage event, so on this workload it cost ~3× the CPU and 3–6× the
   bandwidth. Full-screen motion (3D games, video) is where H.264 would win; that is the future
   H.264 mode (§14).

Not verified here: a real iPhone. Per WebKit source and release notes, iOS/Safari **26+** decodes
Opus through WebCodecs; older iOS uses the WASM fallback (§8.3). Both paths are manual checks in
§13.4.

### 3.3 Decision

Stack A:

- `Xvnc` on a 0600 Unix socket, relayed by the daemon's authenticated WebSocket to noVNC 1.7.0,
  bundled in `packages/ui`.
- A PulseAudio server per desktop; ffmpeg encodes 10 ms Opus frames; a separate authenticated
  audio WebSocket; WebCodecs `AudioDecoder` (WASM fallback) into an AudioWorklet jitter buffer.
- Openbox as the window manager.
- A small X11 client inside the daemon for the window list and window actions.

The video leg sits behind a small daemon interface (`DesktopVideoTransport`: the relay route plus
host flags), so an H.264 mode can be added per desktop later without changing the data model or
the tab.

## 4. Host prerequisites

Required: `Xvnc` (`tigervnc-standalone-server`), `openbox`, `dbus-daemon`, `tmux` ≥ 3.2.

Optional, for audio: `pulseaudio` (+ `pulseaudio-utils` for diagnostics) and `ffmpeg` built with
the `pulse` input device and `libopus`. Without them, desktops run with `audio: "unavailable"`.

Recommended: `libgl1-mesa-dri` (llvmpipe for OpenGL apps). A non-empty `/etc/machine-id` and a
passwd entry for the service user (both true here; often false in containers). Missing items appear
as warnings in the host status.

`GET /api/desktops/host` reports:

- each tool's resolved path or absence, and whether ffmpeg has `pulse` input and `libopus`;
- whether a `/dev/dri/renderD*` render node exists;
- the machine-id and passwd checks;
- `available` (all required tools present, and tmux ≥ 3.2 usable; desktops need tmux for survival,
  so the `LocalSessionManager` fallback means "unavailable" with a tmux hint);
- `audioAvailable`;
- one `installHint`: `sudo apt-get install -y tigervnc-standalone-server openbox pulseaudio
  pulseaudio-utils dbus-x11 libgl1-mesa-dri`, reduced to the missing packages.

Detection reuses the registry's `resolveBin` / `isBinOnPath`. The ffmpeg capability probe
(`ffmpeg -hide_banner -devices`, `-encoders`) runs once and is cached until the next boot.
`deploy/lib/remote-provision.sh` installs the packages as part of provisioning.

## 5. Daemon: processes, lifecycle and survival

### 5.1 Module layout

`apps/daemon/src/desktops/`:

| File | Responsibility |
|---|---|
| `manager.ts` | `DesktopManager`: records, create/stop/restart, app launch/stop, reconcile, events |
| `store.ts` | tolerant `desktops.json` read/write (chained atomic writes, quarantine, read-only on unreadable) |
| `host-env.ts` | pure builders: desktop dir layout, host script args, app env (scrub, GL rules) |
| `reconcile.ts` | pure reconciliation: records × live tmux windows × ready/exit files → statuses |
| `x11/` | minimal X11 protocol client (connection, auth, requests, events, X-Resource) |
| `windows.ts` | per-desktop window tracker on top of `x11/` (list, active, pid → app mapping, actions) |
| `audio.ts` | per-desktop ffmpeg Opus capture with subscriber fan-out |
| `ogg-opus.ts` | pure Ogg page → Opus packet splitter |
| `host-status.ts` | binary and capability detection, install hint |
| `suggestions.ts` | `.desktop` entry scan and project executables |
| `assets/desktop-host.sh`, `assets/app-run.sh` | shipped POSIX scripts |

Wired in `apps/daemon/src/index.ts` next to `BrowserManager`, with lifecycle events forwarded to
the broadcaster on channel `"desktop"`.

### 5.2 One tmux service session per desktop

Each desktop is a tmux service session `orqsvc-desktop-<id>` on the daemon's existing tmux server
(`tmuxSocketPath`). The name is outside the `orq-` namespace, so the session reaper never sees it
(`tmux.ts` L9–17). New `Tmux` helpers:

- `listServiceSessions(prefix)` lists live sessions whose names start with `prefix`, which must be
  inside `orqsvc-`;
- `newServiceWindow({session, name, cwd, env, bin, args})` opens a window in an existing service
  session;
- `listServiceWindows(session)` returns window name and pane pid.

**Window `host`** runs `desktop-host.sh <dir> <width> <height>`:

1. `trap 'kill 0' EXIT HUP INT TERM`, so the whole process group dies with the host.
2. On exit, it also writes `<dir>/host.exit` atomically (temp file + rename).
3. Starts `dbus-daemon --session --address=unix:path=<dir>/bus --nofork --nopidfile`.
4. If audio is available, starts `pulseaudio -n -F <dir>/default.pa --daemonize=no
   --exit-idle-time=-1 --use-pid-file=no --system=no`, with `PULSE_RUNTIME_PATH`,
   `PULSE_STATE_PATH` under `<dir>`.
   - `default.pa` loads `module-native-protocol-unix socket=<dir>/pulse/native`, then
     `module-null-sink sink_name=orq`, then sets `orq` as the default sink.
   - The socket uses `auth-anonymous=1`; the 0700 directory is the access control. A cookie would
     add nothing, since only same-uid processes can reach the directory and they could read a
     cookie too. (The X display differs: its abstract-namespace socket bypasses file modes, so it
     needs the cookie.)
5. Starts `Xvnc -displayfd 3 -auth <dir>/Xauthority -rfbunixpath <dir>/vnc.sock
   -rfbunixmode 0600 -rfbport -1 -SecurityTypes None -AlwaysShared -nolisten tcp
   -geometry <w>x<h> -depth 24`.
   - `-displayfd` makes the server pick a free display number and write it when ready. That
     removes display-number races and any sleep polling.
   - The script copies that number into `<dir>/ready` (atomic rename).
6. Starts `openbox` with the desktop env (§5.5).
7. Waits for Xvnc. If Xvnc exits, the script exits and the trap takes down everything.

**Window `app-<appId>`** runs `app-run.sh <dir> <appId>`. Before opening the window, the daemon
writes `<dir>/apps/<appId>.env` (0600). It holds the full app env (§5.5), plus `ORQ_APP_CWD` and
`ORQ_APP_COMMAND`, each value single-quoted by `host-env.ts` (`'` → `'\''`). Then the script:

1. Loads the env file with `set -a; . "<env file>"; set +a`, and deletes it.
2. `cd "$ORQ_APP_CWD"`, then `setsid nice -n 10 sh -c 'exec '"$ORQ_APP_COMMAND"` in the background.
   - The app is its own process-group leader: `setsid` doesn't fork because a non-interactive
     shell's background job is not a group leader, and `nice` and `sh` exec in place. So the
     captured pid is the app's `pgid`.
   - The script writes the pid to `<dir>/apps/<appId>.pgid` (temp file + rename).
3. Sends stdout and stderr to `<dir>/apps/<appId>.log`.
4. Waits for the app, then writes `<dir>/apps/<appId>.exit` with the exit status (temp file +
   rename).
5. Never touches the host.

The command line and env values never appear in any process's arguments, including the tmux
client's `-e` flags, because values may be credentials (AGENTS.md "Keep credentials out of process
arguments"). The command line and env values must be single-line: the route rejects `\n`, `\r` and
NUL, and limits the command to 4096 characters.

### 5.3 Per-desktop directory

`desktopRuntimeDir(id)` = `<appdir>/daemon/desktops/<id>/`, mode 0700, containing:

- `Xauthority`, `vnc.sock`, `pulse/native`, `bus`;
- `run/`, the desktop's `XDG_RUNTIME_DIR`, 0700;
- `default.pa`, `client.conf` (`autospawn = no`);
- `ready`, `host.exit`, `host.log`;
- `apps/<appId>.{pgid,exit,log}`.

Unix socket paths are limited to 108 bytes; this host's paths are ~60 bytes. If
`<dir>/pulse/native` would exceed 100 bytes, the helper uses a short 0700 directory under the OS tmp
dir (`orqd-<uid>-<id>`) for the sockets and records the choice in the desktop record
(`socketDir`), so reattach finds it.

### 5.4 Lifecycle

- **Create** (`POST /api/desktops`):
  1. Validate paths.
  2. Write the record with `status: "starting"`.
  3. Create the directory and the Xauthority file: one FamilyWild entry with an empty display
     number (so it matches whatever `-displayfd` picks) and a 16-byte MIT-MAGIC-COOKIE-1, written
     directly in Xauthority format at 0600.
  4. Start the service session.
  5. Wait for `<dir>/ready` via `fs.watch`, with a 15 s timeout.
  6. Record `display`, connect the window tracker, then mark the desktop `running` and emit
     `desktop.updated`.
  7. If a first app was given, launch it.

  On timeout: status `error` with the tail of `host.log`, and the session is killed.
- **Launch app:**
  1. Validate `cwd`.
  2. Append the `AppRecord` (`starting`).
  3. Open the `app-<appId>` window.
  4. Mark the app `running` when `<appId>.pgid` appears.
  5. Update the project's recent commands.
- **App exit:** an `fs.watch` on `<dir>/apps/` sees `<appId>.exit`. The app becomes `exited` with
  `exitCode` and `exitedAt`. The desktop is unaffected.
- **Stop app:** SIGTERM to `-pgid`. If `force` is set, or the app is still alive after 5 s, SIGKILL.
- **Host exit** (Xvnc crash, host killed): the `host.exit` watch fires.
  - The desktop becomes `stopped`.
  - Still-recorded apps are marked `exited` (code `null`).
  - Their process groups are SIGKILLed, because apps are in their own groups and the host trap
    does not reach them.
- **Stop desktop** (tab close, explicit Stop, project delete):
  1. Kill the service session.
  2. SIGKILL every recorded app process group.
  3. Stop the audio encoder and the window tracker.
  4. Remove the directory.
  5. Tab close and project delete (`DELETE /api/desktops/:id`) also remove the record. An explicit
     Stop (`POST /api/desktops/:id/stop`) keeps the record as `stopped`, so the tab stays, showing
     Restart.
- **Restart** (`POST /api/desktops/:id/restart`, only when `stopped`): start a new host with the
  same record and size. Apps are not relaunched automatically; the UI offers their commands.
- **Project delete** calls `desktops.closeForProject(realpath)` next to `browsers.closeForProject`.
  Workspace delete and `DELETE /api/fs` call it too, prefix-matched on the deleted path. This closes
  the gap the browser code has in those two routes.
- **Daemon shutdown:** desktops are left running (they live in tmux); the daemon only closes its
  relays, encoders and X11 connections.

### 5.5 App environment

Built by `host-env.ts`:

1. Start from the session base env (`sessionEnvBase()`: no `$TMUX`, no `ORQUESTER_*`), with the
   same secret scrubbing as sessions.
2. Add the desktop wiring:
   - `DISPLAY=:<n>`, `XAUTHORITY=<dir>/Xauthority`;
   - `PULSE_SERVER=unix:<dir>/pulse/native`, `PULSE_CLIENTCONFIG=<dir>/client.conf`;
   - `DBUS_SESSION_BUS_ADDRESS=unix:path=<dir>/bus`;
   - `XDG_RUNTIME_DIR=<dir>/run`.
3. Software GL: when no `/dev/dri/renderD*` exists, `LIBGL_ALWAYS_SOFTWARE=1`. Always
   `LP_NUM_THREADS=<desktop.renderThreads>` (default 4, range 1–`nproc`).
4. Apply the user's `env` last, so an app can override `LP_NUM_THREADS` or anything else.
5. Apps run under `nice -n 10`, so agents and the daemon stay responsive while llvmpipe saturates
   cores.

`HOME` is the service user's home: desktops isolate display, audio and bus, not files. The working
directory is exactly the app's `cwd` (default: the project), so apps that restore state from their
cwd (JasperEngine's `settings.yaml`) behave deterministically.

### 5.6 Reattach on boot

`DesktopManager.reattach()` runs at boot after `sessions.reattach()`. It inputs
`reconcile(records, liveSessions, windowsBySession, readyFiles, exitFiles)`, a pure function:

- **Record, live session, `ready` present and no `host.exit`:** `running`.
  - Re-read `display`; reconnect the window tracker.
  - Each app with a live `app-<appId>` window → `running`; each app with an exit file → `exited`
    with its code; neither → `exited` with code `null`.
- **Record without a live session:** `stopped`.
- **Live `orqsvc-desktop-*` session without a record:** killed, but only if the index loaded
  cleanly (the `sessions.ts` rule: never reap on an unreadable index).

Status is never trusted from disk.

### 5.7 Security

- **VNC:** a 0600 Unix socket, never TCP (`-rfbport -1`). Browsers reach it only through the
  authenticated relay (§7.2).
- **X display:** a random MIT-MAGIC-COOKIE-1 per desktop (`-auth`). The spike showed an
  unauthenticated client could connect otherwise, and Linux X servers also listen on an
  abstract-namespace socket that file permissions cannot protect.
- **Audio:** a per-desktop server whose socket sits in the 0700 desktop directory. Apps get only their own desktop's
  `PULSE_SERVER`, so one desktop's sound never plays in another desktop's tab.
- **Paths:** `projectPath` and every `cwd` pass through `assertInsideFsRoot(fsRoot, path)`, and the
  returned realpath is what gets stored.
- **Secrets:** the X cookie file never leaves the daemon host and never appear in API responses or
  logs.
- **Unix-socket transport:** desktop routes are served on both transports like the browser routes,
  but viewing needs WebSockets, so the desktop Electron client's local Unix-socket transport cannot
  show desktops (same as browsers).

## 6. Window tracking (in-daemon X11 client)

### 6.1 Protocol subset

`x11/` implements only what is needed, over the display's Unix socket
`/tmp/.X11-unix/X<n>`, authenticated with the desktop's MIT-MAGIC-COOKIE-1:

- connection setup;
- `InternAtom`, `GetProperty`, `ChangeWindowAttributes` (event mask);
- `SendEvent` (EWMH ClientMessages);
- `QueryExtension`;
- X-Resource `QueryClientIds` (pid);
- events: `PropertyNotify`, `ConfigureNotify`, `DestroyNotify`, `ErrorEvent`.

Replies are matched by sequence number. The client does not depend on `wmctrl`, `xdotool` or
`xprop`.

### 6.2 Tracker

Per running desktop, `windows.ts`:

- selects `PropertyChangeMask | StructureNotifyMask` on the root. It reads `_NET_CLIENT_LIST` and
  `_NET_ACTIVE_WINDOW` on start and whenever they change, and treats root `ConfigureNotify` as a
  display resize, which updates the record's `size`;
- for each client window, selects `PropertyChangeMask` and reads `_NET_WM_NAME` (falling back to
  `WM_NAME`), `WM_CLASS` and `_NET_WM_STATE` (maximized);
- maps windows to apps: X-Resource `QueryClientIds` gives the window's pid; the tracker walks up
  `/proc/<pid>/stat` parents until it reaches a recorded app's `pgid`. `_NET_WM_PID` is used only
  as a hint. Unmatched windows get `appId: null` (shown as "Other");
- emits `desktop.windows` on change, debounced to one event per animation-frame-sized burst
  (16 ms).
- **Actions:**
  - activate: `_NET_ACTIVE_WINDOW` ClientMessage;
  - maximize: `_NET_WM_STATE` add `_NET_WM_STATE_MAXIMIZED_VERT|HORZ`, toggled;
  - close: `_NET_CLOSE_WINDOW`, a graceful close, so the app may ask to save.

If the X connection drops while the host is alive, it reconnects with backoff.

## 7. API

### 7.1 HTTP routes

Types and `desktopRoutes` constants live in `packages/api/src/desktops.ts`, re-exported from the
package index. The reference `HttpOrquesterApiClient` gains the methods, and so does the UI
`api-client.ts`.

| Route | Request → response |
|---|---|
| `GET /api/desktops/host` | → `DesktopHostStatus` |
| `GET /api/desktops?projectPath=` | → `DesktopSummary[]` |
| `GET /api/desktops/suggestions?projectPath=` | → `{ entries: DesktopEntrySuggestion[], executables: string[], recent: RecentLaunch[] }` |
| `POST /api/desktops` | `{ projectPath, title?, size?, renderThreads?, app?: LaunchAppRequest }` → `DesktopSummary` |
| `POST /api/desktops/:id/stop` | → `DesktopSummary` (stops the host and apps, keeps the record as `stopped`) |
| `POST /api/desktops/:id/restart` | → `DesktopSummary` (409 unless `stopped`) |
| `DELETE /api/desktops/:id` | → 204 (stops everything, drops the record) |
| `POST /api/desktops/:id/apps` | `LaunchAppRequest { command, cwd?, env? }` → `DesktopAppSummary` |
| `DELETE /api/desktops/:id/apps/:appId?force=1` | → 204 |
| `GET /api/desktops/:id/apps/:appId/log` | → `text/plain`, the last 64 KiB |
| `POST /api/desktops/:id/windows/:windowId/:action` | `action ∈ activate \| maximize \| close` → 204 |

Errors:

- `409 { code: "DESKTOP_UNAVAILABLE", hint }` when a required tool is missing;
- `403` for a path outside the sandbox (`FsSandboxError`);
- `404` for an unknown id;
- `400` for an invalid body (zod).

`DesktopSummary` = the record fields (§9) plus runtime `status` (`starting | running | stopped |
error`), `error?`, `audio` (`available | unavailable`), `windows`, `activeWindowId`.

Suggestions:

- `.desktop` entries come from `/usr/share/applications` and `~/.local/share/applications`: `Name`
  and `Exec` with field codes (`%f %F %u %U …`) stripped; `NoDisplay=true`, `Hidden=true` and
  `Terminal=true` are skipped.
- Executables are regular files with an exec bit, directly in the project or in `bin/`, `build/**/bin/`
  up to depth 4, capped at 50 entries.

### 7.2 WebSockets

Both routes follow the `/ws-devtools` pattern:

- registered in their own child context under the root `@fastify/websocket`;
- `?token=` checked after the upgrade with `authorizeCredential`, failing with close 1008;
- the SPA 404 fallback reserves their prefixes.

**`/ws-desktop/:id?token=`:** an opaque RFB relay.

- Connects to the desktop's `vnc.sock`.
- Client messages that arrive before the upstream opens are buffered in a bounded queue
  (8 MB / 512 messages).
- Binary frames are RFB bytes, piped both ways. Backpressure pauses the socket above an 8 MB
  high-water mark and resumes below it.
- Text frames are a small control side channel that the RFB stream never uses. The client sends
  `{ type: "ping", t }` every 2 s; the relay answers `{ type: "pong", t }` on the same socket,
  queued behind any RFB data still waiting. The round trip therefore includes the video backlog,
  which is the congestion signal for adaptive quality (§11.2) and the liveness check for reconnects.
  The client passes noVNC a thin WebSocket wrapper that consumes text frames and forwards binary
  ones.
- Either side closing closes both. If the desktop isn't running, it closes with 1011
  `"desktop not running"`.
- One RFB connection per viewer; `-AlwaysShared` keeps all viewers on one display.

**`/ws-desktop-audio/:id?token=`:** the Opus stream.

- Server → client:
  - first a text message `{ type: "state", audio: "available" | "unavailable", reason?,
    sampleRate: 48000, channels: 2, frameMs: 10 }`;
  - then binary packets `[u8 type=1][u8 flags=0][u16 reserved=0][u32 seq, big-endian][opus
    packet]`.
- Client → server: `{ type: "ping" }` → `{ type: "pong" }`.
- A subscriber is a connected socket; the client closes the socket to pause.
- If more than 32 KiB (~250 ms) is queued on a socket, packets for that socket are dropped, and the
  `seq` gap tells the client. A slow link hears a gap instead of growing latency.

Audio uses a separate socket so it has its own TCP connection: RFB bursts cannot head-of-line block
audio packets.

### 7.3 Events

Broadcaster channel `"desktop"`:

- `desktop.created`, `desktop.updated` (status, size, title, apps), `desktop.closed`;
- `desktop.windows { desktopId, windows: { id, title, appId, wmClass, maximized }[],
  activeWindowId }`.

### 7.4 MCP

A new `desktops` tool group in `apps/daemon/src/mcp/tools/desktops.ts`, added to `ALL_TOOLS`. Every
tool calls the routes above through `DaemonApi`:

| Tool | Annotation |
|---|---|
| `desktops_list { projectPath }` | READ_ONLY |
| `desktop_host_status` | READ_ONLY |
| `desktop_open { projectPath, title?, size?, renderThreads?, command?, cwd?, env? }` | MUTATING |
| `desktop_launch_app { desktopId, command, cwd?, env? }` | MUTATING |
| `desktop_windows { desktopId }` | READ_ONLY |
| `desktop_window_action { desktopId, windowId, action }` | MUTATING |
| `desktop_app_log { desktopId, appId }` | READ_ONLY |
| `desktop_stop_app { desktopId, appId, force? }` | DESTRUCTIVE |
| `desktop_close { desktopId }` | DESTRUCTIVE |

A desktop opened by an agent appears as a tab in every client through `desktop.created`.

## 8. Audio pipeline

### 8.1 Server

`audio.ts` keeps one encoder per desktop, started on its first subscriber and stopped 2 s after the
last one leaves, so a quick tab switch doesn't restart it:

```
ffmpeg -hide_banner -loglevel error -fflags nobuffer
  -f pulse -server unix:<dir>/pulse/native -fragment_size 1920 -i orq.monitor
  -c:a libopus -application lowdelay -frame_duration 10 -b:a 96k
  -f ogg -page_duration 10000 -flush_packets 1 pipe:1
```

- **Why these flags:** ffmpeg's pulse input otherwise buffers 50 ms (`fragment_size` defaults to
  -1). `-fragment_size 1920` is 10 ms of s16 stereo 48 kHz. With these flags, the spike measured one
  Opus packet per Ogg page.
- **Packet splitting:** `ogg-opus.ts` parses page headers and segment tables, reassembles packets
  across lacing values, and skips the `OpusHead` and `OpusTags` packets.
- **Fan-out:** each packet goes to every subscriber with a per-desktop `seq`.
- **Cost:** ~5 % of a core per desktop for ffmpeg plus ~2.5 % for PulseAudio.
- **Process ownership:** ffmpeg is a daemon child, not a tmux process. It is disposable; a viewer
  reconnecting after a daemon restart starts a new one.
- **Failure:** if ffmpeg exits unexpectedly while subscribers remain, it restarts with backoff and
  sends a `state` message with a `reason` if restarts keep failing.

### 8.2 Client

`packages/ui/src/lib/desktop-audio/`:

- **`context.ts`: one app-wide `AudioContext`** (`sampleRate: 48000`,
  `latencyHint: "interactive"`).
  - It is created or resumed only inside the "Enable sound" gesture. Before creating it, set
    `navigator.audioSession.type = "playback"` where supported (Safari 16.4+), so the iOS silent
    switch doesn't mute it.
  - It resumes again on `visibilitychange` and from Safari's `"interrupted"` state.
- **`decoder.ts`:** WebCodecs `AudioDecoder` configured `{ codec: "opus", sampleRate: 48000,
  numberOfChannels: 2 }` with no description. If `AudioDecoder.isConfigSupported` is false, it
  uses the WASM fallback (§8.3). Both paths yield Float32 planar frames.
- **`jitter-buffer.ts`:** a pure policy module, unit-tested (§13.3), used inside the AudioWorklet
  processor `player.worklet.ts`:

  | Parameter | Behaviour |
  |---|---|
  | Initial target | 30 ms of buffered audio before playback starts |
  | Underrun | output silence, target += 10 ms (max 150 ms), re-buffer to the target, 2.5 ms fade-in |
  | Stable | after 30 s without an underrun, target −= 5 ms (min 20 ms) |
  | Overflow | depth > target + 40 ms → drop the oldest whole packets, 2.5 ms crossfade |
  | Stats | depth, target, underruns, drops, posted every 500 ms (shown in the ⋯ info panel) |

- **`controller.ts`:** opens the audio socket only while the desktop's tab is active, the document
  is visible, sound is enabled and the desktop isn't muted. It closes the socket otherwise.
  - Volume is a `GainNode` per desktop.
  - A `seq` gap is treated as lost packets: nothing is inserted, and the jitter buffer absorbs it.

**Drift and sync:**

- The server's sample clock and the browser's `AudioContext` clock differ by tens of ppm, so an
  uncorrected buffer would slowly grow or run dry. The overflow and underrun rules hard-bound buffer
  depth, so audio latency cannot accumulate over any session length. At 50 ppm the overflow rule
  drops a 10 ms packet about every 3–4 minutes, which is inaudible behind the crossfade.
- Video has no buffer: noVNC draws each update as it arrives. Audio and video therefore stay within
  the audio buffer depth of each other: typically 30–80 ms, at most ~190 ms (150 + 40).

**Expected end-to-end audio latency:** capture to packet ~21 ms (measured), plus one-way network,
plus the jitter buffer (20–60 ms typical), plus output latency (10–40 ms). About **70–120 ms plus
network** on a good link.

### 8.3 WASM fallback (owner's choice)

For browsers without WebCodecs Opus (mainly iOS before 26):

- `decoder.ts` lazy-loads a Worker running `opus-decoder` (MIT, from `wasm-audio-decoders`; ~68 KB
  gzipped with the WASM inlined).
- Raw Opus packets go to `decodeFrame`, and the Float32 output is posted to the worklet.
- The dependency is added to `packages/ui`.
- It needs `'wasm-unsafe-eval'` in `script-src` of the `@app` CSP, in both `deploy/Caddyfile` and
  the live `/etc/caddy/Caddyfile`. The live file is changed only at deploy time, with the owner's
  go-ahead. That directive allows compiling WebAssembly only, not JS `eval`.
- Where neither path is available (for example Lockdown Mode, which disables Web Audio), the sound
  control is disabled and explains why.

## 9. Persistence (`packages/config`)

- Path helpers: `desktopsIndexPath()` → `daemon/desktops.json`; `desktopsRuntimeDir()` →
  `daemon/desktops/`; `desktopRuntimeDir(id)`. The layout comment is updated. `prepareDirs` creates
  the directory at 0700.
- Schema (zod, `.passthrough()` on records so unknown fields survive rewrites):

```ts
desktopAppRecord = {
  id: string, desktopId: string,
  command: string,                    // shell command line, run as sh -c 'exec …'
  cwd: string,                        // realpath inside the fs root
  env: Record<string, string>,        // user-entered only; defaults to {}
  status: "starting" | "running" | "exited",
  exitCode: number | null,
  pgid: number | null,
  startedAt: string, exitedAt: string | null,
}
desktopRecord = {
  id: string, projectPath: string, title: string /* default "Desktop" */,
  order: number, createdAt: string,
  display: number | null,
  size: { width: number, height: number },   // default 1280×800; clamped 320..7680 × 240..4320
  renderThreads: number,                      // default 4
  socketDir: string | null,                   // set only when the short tmp fallback is used (§5.3)
  apps: desktopAppRecord[],                   // exited apps pruned to the newest 20
}
recentLaunch = { command: string, cwd: string, env: Record<string, string>, lastUsedAt: string }
desktopsFile = {
  version: 1,
  desktops: desktopRecord[],
  recent: Record<projectPath, recentLaunch[]>,   // newest first, capped at 20 per project
  ...unknown top-level keys preserved
}
```

- `parseDesktopsFile` follows `parseSavedPromptsConfig`. It parses per record, keeps rejected
  records verbatim to write back, and returns `{ desktops, recent, rejected, extra }`. If the outer
  shape is invalid, the file is quarantined to `.corrupt-<stamp>` and the store goes read-only until
  the next boot, so it is never silently overwritten.
- Writes are chained and atomic at 0600 via `writeFileAtomic`.
- Stored `app.status` and `pgid` are hints for reconciliation only.
- Environment values entered in the launch dialog are stored in this 0600 file and returned only to
  authenticated clients, like session launch commands. The UI masks them after entry. They are
  never logged: the daemon logger's serializer redacts `env` in desktop routes.

## 10. UI (`packages/ui`)

### 10.1 Registration and state

- `ProjectTab` gains `{ id; type: "desktop"; desktop: DesktopSummary }` (`store/app.ts`). Like
  browsers, desktop tabs are server-backed:
  - a `desktops` slice, loaded on connect (404 tolerated for older daemons) and reset on server
    switch;
  - updated from the `"desktop"` bus channel, including `desktop.windows`;
  - `upsertDesktop` / `removeDesktop`;
  - ordered after browsers in `useProjectTabs`.
- Rendering branches in `MainView.tsx` (Monitor icon; title `<title> · <active window title>`),
  `TabStrip.tsx` and `TabSwitcher.tsx`.
- `DesktopView`'s root carries `data-desktop-view`, which is added to `SHORTCUT_BAIL_SELECTOR`
  (`lib/session-nav.ts`), so global shortcuts don't steal keys from apps.
- A client has one tab per desktop. Several viewers means several clients or windows.
- Desktop routes go through `api-client.ts` and the shared transport. WebSocket URLs are built like
  `getBrowserChannel()`: the same origin, `http→ws`, `?token=`.

### 10.2 Menu and launch dialog

- `NewTabMenu` adds:
  - **New desktop…**, which opens the launch dialog with target "New desktop";
  - **Open app in desktop ›**, which lists the project's running desktops and opens the dialog
    targeting one.
- Both appear only with an HTTP transport and when `host.available` is true. Otherwise a
  `DropdownEmpty` shows either "needs a remote (HTTP) connection" or the host's `installHint`, with
  a copy button.
- `LaunchAppDialog`:
  - **Command:** a command-line input with fuzzy suggestions (`fuzzysort`, already a dependency)
    over `.desktop` entries, project executables and recent commands. Recent commands are also
    one-click chips.
  - **Working directory:** a path relative to the project, defaulting to the project root; the
    server validates it.
  - **Environment:** `KEY=VALUE` rows; values masked after entry; keys validated as
    `[A-Za-z_][A-Za-z0-9_]*`.
  - **Target:** "New desktop" or one of the project's running desktops. "New desktop" has an
    Advanced area with size (Fit tab, 1280×800, 1600×900, 1920×1080) and render threads.
  - **Submit:** a new desktop opens its tab; launching into an existing desktop focuses that tab.

### 10.3 `DesktopView`

`components/desktop/DesktopView.tsx`:

- **When noVNC runs:** `RFB` (from `@novnc/novnc/core/rfb.js`) is constructed only while the tab is
  active and the document visible, and disconnected otherwise. Hidden desktops therefore cost no
  encoding. It reconnects with exponential backoff (max 10 s) on unexpected close.
- **Overlays:**
  - **Starting:** a spinner.
  - **Stopped:** "Desktop stopped" with Restart.
  - **Error:** the message, the host log tail and, if relevant, the install hint.
  - **Reconnecting:** shown while the connection is re-established.
- **noVNC options:** `qualityLevel` 6 and `compressionLevel` 2, adjusted by the adaptive rule in
  §11.2.

### 10.4 Toolbar

| Control | Behaviour |
|---|---|
| Windows | Taskbar-style pills (title, app icon or `WM_CLASS` initial), the active one highlighted. Tap to activate; hover/long-press menu: Maximize, Close. On narrow screens (< 640 px), a "Windows (n)" button that opens a sheet with the same actions. |
| Launch app (+) | Opens `LaunchAppDialog` targeting this desktop. |
| Sound | "Enable sound" until the shared `AudioContext` is unlocked; then a mute toggle and a volume slider. Disabled with a reason when `audio: "unavailable"` or no decoder is available. |
| View | **Fit** (default on non-touch): the display follows the tab size, see below. **Fixed** 1280×800 / 1600×900 / 1920×1080 (default on touch devices, because editors need room), shown scaled to fit (`scaleViewport`) or at 1:1 with drag-to-pan (`clipViewport` + `dragViewport`). |
| Keyboard | Touch devices only. A hidden input for text and IME (characters sent as keysyms), plus a key strip: Esc, Tab, Ctrl, Alt, Super, arrows. Modifiers latch for one key. |
| Clipboard | A popover with the last remote clipboard text (Copy button) and a "Send to desktop" textarea. |
| ⋯ | An Apps list (command, status, exit code; Stop, Force quit, Relaunch, View log), Restart desktop, Stop desktop, and Info (display, size, audio state and jitter-buffer stats). |

**Resize with several viewers:** in Fit mode, a viewer sets `resizeSession = true` when it receives
focus or local input, and `false` on blur. So the viewer you last used drives the display size; the
others scale the shared display to fit (`scaleViewport`).

**Clipboard:**

- Remote → local: noVNC's `clipboard` event updates the popover. When the document has focus it
  also calls `navigator.clipboard.writeText` and ignores rejections.
- Local → remote: a `paste` event inside the view sends `clipboardPasteFrom(text)` and then
  forwards the Ctrl+V keystroke.

**Touch:** noVNC's built-in gestures: tap = click, two-finger tap = right click, long-press drag =
drag, two-finger drag = scroll, pinch = Ctrl+wheel to the app.

### 10.5 Audio UX

- There is a single app-wide unlock. After the first "Enable sound" gesture in a page load, other
  desktop tabs play without asking.
- Per-desktop viewer prefs are stored in localStorage under `orq.desktop.prefs.<desktopId>` as
  `{ muted: boolean, volume: 0..1, view: "fit" | "fixed", fixedSize?, fixedMode?: "scale" | "pan" }`
  and validated with zod on read.
  - Invalid values fall back to `{ muted: false, volume: 1 }`, with `view` defaulting to `"fixed"`
    at 1280×800 on touch devices (`matchMedia("(pointer: coarse)")`) and `"fit"` otherwise.
  - The keys are removed when the desktop is closed.
- Audio streams only to active viewers (§8.2 controller rule); each active viewer gets its own
  stream from the shared encoder.

### 10.6 Closing the tab

- `requestCloseTab` gets a desktop branch:
  - **Running apps:** always confirm, regardless of `confirmCloseSession`: "Stop desktop "<title>"?
    2 apps are running: jasperengine-editor, xterm. They will be terminated."
  - **No running apps:** close without asking.
- Confirming calls `DELETE /api/desktops/:id`.
- `CloseSessionConfirm` is generalised to take the title and body from the tab, not only from
  `sessions`.

### 10.7 Build

- noVNC 1.7 is ESM but keeps a top-level `await` in `core/util/browser.js`. Both `apps/web` and
  `apps/desktop` Vite configs set `build.target: "es2022"` (verified to build with Vite 6.4.3), and
  `optimizeDeps.esbuildOptions.target: "es2022"` for dev.
- The worklet and the WASM worker load as same-origin module URLs (`new URL(..., import.meta.url)`),
  which fit `script-src 'self'` and `worker-src 'self' blob:`.

## 11. CPU budget and adaptivity

### 11.1 Budget

The measured streaming overhead is ~15–18 % of a core per desktop, so 3 desktops cost about half a
core before apps. App rendering dominates: an uncapped llvmpipe app used 4.6 cores. The levers:

- `renderThreads` per desktop (default 4), overridable per app with `LP_NUM_THREADS`;
- `nice 10` for apps;
- streaming stops when nobody is watching (RFB disconnects when the tab is inactive; audio stops 2 s
  after its last subscriber).

### 11.2 Adaptive video

Each viewer uses the relay's ping/pong round trip (§7.2), which queues behind unsent RFB data, so
it rises when video exceeds the link:

- 3 consecutive samples above 150 ms (6 s) step `qualityLevel` down 6 → 4 → 2.
- 5 consecutive samples below 50 ms (10 s) step it back up.
- The rule is a pure function in `desktop-quality.ts`, unit-tested.
- Xvnc already sends only changed pixels and picks encodings from the client's list.

Audio encoding stays fixed (96 kbit/s, 10 ms frames), since its measured cost is small.

## 12. Licences and notices

- **noVNC** (MPL-2.0) is bundled unmodified from npm `@novnc/novnc`. Its notice goes in
  `docs/THIRD_PARTY_NOTICES.md`; any future modification to its files must be published under
  MPL-2.0.
- **`opus-decoder`** (MIT; libopus BSD) is added to the notices.
- **TigerVNC, Openbox and PulseAudio** (GPL) and **ffmpeg** (LGPL/GPL build) are installed from the
  distribution and run as separate processes. Orquester neither ships nor links them, so no licence
  obligation reaches Orquester's code.

## 13. Testing

### 13.1 `packages/config`

`desktops-config.test.ts`:

- defaults are applied;
- unknown record fields and top-level keys survive a parse/serialise round trip;
- a bad record is kept verbatim in `rejected` while the good ones load;
- size clamping works;
- `recent` capping works.

### 13.2 Daemon unit tests

| Test | Covers |
|---|---|
| `ogg-opus.test.ts` | Packet splitting over a checked-in fixture captured from ffmpeg 6.1.1 (a 200 ms tone), including pages split across chunk boundaries and lacing values of 255 |
| `host-env.test.ts` | Env scrubbing, `LIBGL_ALWAYS_SOFTWARE` with and without a render node, `LP_NUM_THREADS` default and user override, socket-dir fallback over 100 bytes; the env file round-trips values containing quotes, `$`, backticks, spaces and non-ASCII through `sh -c '. file'` unchanged; the command line never appears in any spawned argv |
| `reconcile.test.ts` | Every row of §5.6, including the "index not loaded → never reap" rule |
| `x11/*.test.ts` | Request encoding and reply/event decoding against byte fixtures; sequence matching; X-Resource client-id reply parsing |
| `desktop-routes.test.ts` | Follows `devtools-routes.test.ts`: `createServer` with a stubbed `services.desktops`. Sandbox rejection of `projectPath` and `cwd`; WS `?token=` auth (1008); the relay pre-open queue and backpressure against a fake Unix socket; audio `state` message and packet framing; `409 DESKTOP_UNAVAILABLE` |
| `mcp/tools/desktops.test.ts` | Tools map to routes through a stub `DaemonApi`; annotations |

### 13.3 UI unit tests

- `jitter-buffer.test.ts` drives the pure policy with simulated clocks:
  - a ±100 ppm drift over 2 simulated hours keeps depth ≤ target + 40 ms;
  - burst arrival after a 300 ms stall recovers without growing latency;
  - underruns raise the target and stable periods lower it.
- Viewer prefs: localStorage validation and touch/non-touch defaults.
- `desktop-quality.test.ts`: step-down and step-up thresholds.
- The noVNC WebSocket wrapper: text frames are consumed as control messages; binary frames reach
  noVNC unchanged.
- Store: `upsertDesktop` / `removeDesktop`, and the `desktop.windows` event reducer.

### 13.4 Integration and manual

**Integration:** `desktop-manager.integration.test.ts` is skipped with `t.skip` when `Xvnc`,
`openbox` or `tmux` is missing (and its audio case when PulseAudio or ffmpeg-pulse is missing). It
uses a throwaway `tmux -S` socket and a temp appdir. There are no sleeps: every wait is an event,
`fs.watch` or X event with a timeout.

1. Create a desktop; wait for `running`.
2. Launch `xterm`; wait for a window whose `appId` matches, via X-Resource.
3. `close` that window; wait for the app to be `exited` while the desktop stays `running`.
4. Launch `sh -c 'exit 3'`; the app is `exited` with code 3.
5. Construct a second `DesktopManager` over the same appdir (a simulated daemon restart);
   `reattach()` finds the desktop `running` with its apps' statuses.
6. Audio: subscribe, play a tone with `pacat` into the desktop's server; Opus packets with non-silent
   size arrive.
7. Stop the desktop; no process from its process groups remains (checked via `/proc`).

**Manual:** run on a separate checkout and appdir, never the live daemon (AGENTS.md).

- Browsers: desktop Chrome, Firefox and Safari; Android Chrome.
- A real iPhone on iOS 26+ (WebCodecs path) and on an older iOS (WASM path), including the silent
  switch and backgrounding.
- JasperEngine editor with play-mode sound.
- `xterm`, a GTK app and a Qt app in one desktop, with switching and closing one.
- Two simultaneous viewers, including resize handover.
- Surviving a daemon restart.
- Tab close with apps running, and project delete.

Record any check that could not run, and why.

**Repository checks:** `pnpm check`, `pnpm test`, `pnpm build`, `git diff --check`.

## 14. Future work (recorded, not built)

- **H.264 video mode** for full-screen motion (3D games, video playback): a per-desktop option using
  Selkies' `pixelflux` or ffmpeg x264 on the display. It would stream over a third WebSocket and
  decode with WebCodecs `VideoDecoder`, with RFB kept for input. It plugs in behind
  `DesktopVideoTransport` (§3.3).
- **GPU or hardware encoding:** not applicable on this host (no `/dev/dri`); VA-API/NVENC would come
  with the H.264 mode.
- **Recording:** tap the same Opus stream plus an H.264 or x11grab video encode into a file.
- **Microphone:**
  - browser `getUserMedia`, then WebCodecs `AudioEncoder` (Opus, 10 ms frames), then upstream
    binary messages on `/ws-desktop-audio`;
  - the daemon writes decoded PCM (ffmpeg or `pacat`) into a per-desktop `module-pipe-source` set as
    the default source;
  - `Permissions-Policy microphone=()` becomes `microphone=(self)` in both Caddyfiles, plus a
    permission prompt UX.
- **Per-app mixing:** per-sink-input volume via PulseAudio `set-sink-input-volume`, keyed by the
  app's pid.
- **Agent screenshots and input:** `desktop_screenshot` (X11 `GetImage` or `ffmpeg -f x11grab
  -frames 1`) and synthetic input via XTEST.
- **File transfer, gamepads.**

## 15. Build order

1. **Contracts:** `packages/config` schema and paths; `packages/api/src/desktops.ts` types and
   `desktopRoutes`; the reference client methods.
2. **Host and lifecycle:** `host-status.ts`; `desktop-host.sh` and `app-run.sh`; `Tmux` helpers
   (`listServiceSessions`, `newServiceWindow`, `listServiceWindows`); `store.ts`; `host-env.ts`;
   `reconcile.ts`; `DesktopManager` create/launch/stop/restart/reattach; routes. The integration
   test for steps 1–5 and 7 of §13.4.
3. **Relay:** `/ws-desktop/:id` with its route tests.
4. **Window tracking:** `x11/` and `windows.ts`, window actions, and the `desktop.windows` event.
5. **Audio server:** `ogg-opus.ts`, `audio.ts`, `/ws-desktop-audio/:id`, and integration step 6.
6. **UI core:** tab plumbing, `DesktopView` with noVNC, overlays, menu entries, the launch dialog
   and suggestions, tab-close confirmation, and the Vite `es2022` target in both frontends.
7. **UI audio:** context, decoder, worklet, jitter buffer, controller, sound controls; then the WASM
   fallback and the `deploy/Caddyfile` CSP change.
8. **Toolbar completion:** the window list, View modes and resize handover, keyboard strip,
   clipboard popover, the ⋯ menu (apps list, logs, info), and adaptive quality.
9. **Integration and docs:** the MCP `desktops` tool group, project/workspace/fs-delete cleanup,
   `deploy/lib/remote-provision.sh` packages, third-party notices, and the README feature mention.
