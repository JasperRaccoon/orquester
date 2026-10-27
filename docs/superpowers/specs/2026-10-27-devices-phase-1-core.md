# Devices, phase 1 — simulators and emulators beside every agent chat

Status: approved by the owner on 2026-10-27; the owner delegated every product decision to the
builder. Phase 2 (`2026-10-27-devices-phase-2-fleet.md`) and phase 3
(`2026-10-27-devices-phase-3-byo-research.md`) build on this document.

Research inputs (2026-10-27): t3code's device system (`.t3code/apps/server/src/device/*`,
`packages/client-runtime/src/device/*`, `apps/web/src/components/device/*`), `expo-device-hub`
(serve-sim, serve-emu) and Callstack's `agent-device`, simslim, vphone-cli, vphone-ws, the
Orquester daemon/UI/boxes surveys, and three spikes whose reports live in
`docs/superpowers/research/2026-10-27-devices-spikes.md`.

## 1. Intent

An agent working on a mobile app must be able to build it, run it on an iOS simulator or an
Android emulator, see the screen, and drive it — while the owner watches the same device live
next to the chat and can take over at any moment. The experience must hold for the agent (few,
predictable tools that return compact, verifiable results) and for the human (the device appears
by itself, looks like the real phone, and shows what the agent is doing).

Phase 1 delivers:

1. **Android emulators on the Orquester host** (Linux with KVM).
2. **iOS simulators on rented Blacksmith macOS boxes** ("Mac device hosts"), rented on demand
   and shared by every chat.
3. **A Device panel** in the right rail beside the agent chat: live H.264 video, touch and
   keyboard input, a toolbar, realistic 3D device models (t3code's pipeline), the agent's taps
   drawn on the screen, an action log, and a control handoff.
4. **Agent tools** (Orquester MCP, `devices` toolset) to list, open, drive, screenshot and close
   devices, each chat holding exclusive leases.
5. **Settings → Devices**: readiness checklists with one-click install/repair, Mac host budget,
   agent access.

## 2. Goals, non-goals, anti-goals

### Goals

1. A built-in plugin **Device simulators** (`devices`) in Settings → Plugins. With it off,
   nothing in this document runs and no tool is advertised.
2. Android: install the SDK, system image and pinned tools on the host from Settings or on the
   first agent request, boot headless emulators from a prepared snapshot in seconds, run several
   at once within the host's capacity.
3. iOS: rent a Blacksmith macOS box as a Mac device host, prepare it (tools, simulator), and give
   each lease its own simulator.
4. Live view in the browser and the desktop app over the daemon's HTTP transport, with input.
5. Agents drive devices through semantic snapshots (accessibility refs) first, coordinates
   second, and get screenshots as images.
6. Exclusive leases: two chats never drive the same device; one chat may hold up to 3 devices.
7. The human sees which agent drives a device, every action it takes, and can take over and give
   back control.
8. Realistic device frames: t3code's GLB models and procedural fallback, flat view on request or
   when 3D can't run.
9. Everything survives a daemon restart: leases, running emulators, Mac hosts.

### Non-goals (phase 1)

- Device pools on Linux boxes, autoscaling, fleet grid, simslim density, caches (phase 2).
- Bring-your-own Mac/Linux hosts, vphone-cli, Samsung models (phase 3).
- Physical devices over USB.
- Audio from devices.

### Anti-goals

- Exposing `expo-device-hub` or `agent-device` endpoints without Orquester auth. serve-sim has a
  shell-exec route and serve-emu's actions are unauthenticated; only the allowlisted proxy may
  reach them.
- Secrets (agent-device daemon tokens, hub tokens) in API responses, logs or process arguments.
- Installing or renting anything without the owner's consent (plugin on + platform enabled, or an
  approval card).
- Blocking the daemon event loop with video work: the daemon only pipes bytes.

## 3. Terms

| Term | Meaning |
|---|---|
| Device host | A machine that runs devices: `local` (this host, Android) or `box` (a rented box; phase 1: Blacksmith macOS for iOS). Id: `local` or `box:<boxId>`. |
| Hub | `expo-device-hub` running on a device host, bound to its loopback. |
| Agent-device daemon | `agent-device`'s HTTP daemon on a device host, token-protected. |
| Device | A simulator or emulator on a host. Key: `<hostId>/<deviceId>` (Android serials repeat across hosts). |
| Profile | A device model the owner/agent can ask for: e.g. `pixel-9`, `pixel-tablet`, `pixel-fold`, `iphone-17-pro`, `ipad-pro-13`. |
| Lease | A chat's exclusive claim on one device. |
| Controller | Who may drive a leased device right now: `agent` or `user`. |

## 4. What runs where

| Piece | Local Android host | Mac device host (box) |
|---|---|---|
| Hub, agent-device daemon | daemon child processes (supervised) | `orq-agent` detached processes in the box |
| Emulators / simulators | started by the hub (`emulator`) | `xcrun simctl` |
| H.264 encode | ffmpeg (serve-emu) on the host | serve-sim helper in the box |
| Proxy, leases, tools | daemon | daemon (traffic over `BoxConnection.forwardToHost`) |
| `agent-device` CLI | daemon runs it with `--config` pinned to the host's daemon | same CLI on the Orquester host, talking to the box's daemon through the forward |

## 5. Toolchain

- `apps/daemon/src/devices/tool-versions.json` pins `expo-device-hub` and `agent-device`
  (initial: `0.19.0-canary-20261023-1357114`, `0.21.31`).
- Local installs go under `devicesToolsDir(appDir)/<name>@<version>` (new path helpers in
  `packages/config`), installed with the daemon's Node via `npm install --prefix … --no-audit
  --no-fund` into a staging dir, renamed into place after a `.install-complete` sentinel. One
  install lock per tool. Old versions pruned except the current and previous.
- Android SDK: `androidSdkDir(appDir)`; cmdline-tools from Google's official zip; packages
  `platform-tools`, `emulator`, `system-images;android-35;google_apis;x86_64` (API 35 avoids
  API 37's 4 GB minimum). `yes | sdkmanager --licenses` runs as part of the owner-started install
  (the owner's click is the acceptance; Settings shows the licence notice and link).
- AVDs: `androidAvdDir(appDir)`, one AVD per profile, created by `avdmanager`, `config.ini`
  tuned (RAM 2048, 2 cores, audio/camera off). A golden snapshot `orq-golden` is taken after the
  first cold boot with animations off; leases boot `-read-only -snapshot orq-golden
  -no-snapshot-save` so many instances of one AVD run at once and each starts clean.
- The serve-emu scrcpy server jar is pre-seeded next to the hub install so no GitHub download
  happens at stream time.
- `XDG_RUNTIME_DIR` for the hub and emulators is `devicesRuntimeDir(appDir)` (0700), so the
  emulator publishes its gRPC token where serve-emu reads it.
- The exact flags, GPU mode and timings come from the local spike
  (`docs/superpowers/research/2026-10-27-devices-spikes.md`).

Install progress is a tracked job (`DeviceSetupJob`: steps, percent, live log line, error), shown
in Settings and returned by tools.

## 6. Device hosts

### 6.1 The seam

`apps/daemon/src/devices/host.ts` defines `DeviceHost`:
`id`, `kind`, `platforms`, `readiness(): DeviceHostReadiness` (checks with `ok|missing|error`,
detail and a fix action id), `ensureReady(signal, onProgress)`, `hubOrigin()` (a loopback URL
the proxy targets), `agentDeviceConfigPath()`, `listDevices()`, `boot(profile|deviceId)`,
`shutdown(deviceId)`, `release(lease)`, `run(cmd, args)` (simctl/adb), `uploadFile(stream,
name)`, `dispose()`.

### 6.2 Local Android host

- Available when the plugin is on and the platform is enabled in Settings → Devices.
- Readiness: `/dev/kvm` openable, Node ≥ 22, ffmpeg with libx264, SDK packages, AVD per
  profile, golden snapshot, pinned tools. Each missing item has an Install/Repair action.
- The hub runs as a supervised child (`--platform android --host 127.0.0.1 --port <reserved>`),
  with `hub.json` recording pid + port so a restarted daemon reaps orphans (command-line check
  before kill) or reattaches. Exponential restart backoff, reset after 60 s healthy.
- Capacity: `min(setting maxLocalDevices (default 6), floor((freeMem − 6 GB) / 3 GB),
  floor((cores − 2) / 2))`. Above capacity, `open_device` fails with `DEVICE_CAPACITY` naming
  the current leases (phase 2 spills to boxes instead).
- Boot waits for `sys.boot_completed=1` (the hub returns earlier), then sets animations to 0.
- Shutdown: `adb -s <serial> emu kill`. Emulators left over from a crash with no lease are killed
  on reconcile.

### 6.3 Mac device host (Blacksmith macOS box)

- A box with the new `BoxPurpose` `"device-host"`, `threadId: null`, owned by the device service
  (agents can't `box_exec` it). Created through the box service with the Blacksmith provider,
  size and lifetime from Settings → Devices (default `blacksmith-6vcpu-macos-26`, 4 h lifetime,
  20 min idle teardown).
- Spend: if Settings → Devices "Rent Mac hosts without asking" is on (with a monthly cap), no
  card; otherwise the first `open_device` for iOS raises a `spend` approval card in the
  requesting chat, as `create_box` does.
- A new box setup step `devices` (after `connect`) prepares it: Node (from the image or
  `actions/setup-node` already in the template), pinned tools via npm, start the hub and the
  agent-device daemon detached, read their ports and token from the box (token stays on the
  host side config file, never in a response), and `forwardToHost` both ports.
- Simulators: a lease creates `orq-<leaseId>` from the profile's device type and the newest iOS
  runtime, boots it (`bootstatus -b`), attaches serve-sim; release shuts it down and deletes it.
- Up to `maxSimulatorsPerHost` (default 3 on 6 vCPU / 24 GB; refined in phase 2 with simslim)
  leases share one host; beyond that a second host is rented (subject to budget).
- Host loss (box destroyed/unreachable): its leases become `lost`; the next tool call returns
  `DEVICE_LOST` with "call open_device again".
- The agent-device XCTest runner builds on first use (minutes). The device service starts that
  build right after the host is ready so the first agent snapshot is fast.

## 7. Leases and control

- `DeviceLease { id, threadId, hostId, deviceId, platform, profile, name, createdAt,
  lastUsedAt, state: 'starting'|'ready'|'lost'|'released', controller: 'agent'|'user',
  error? }`, persisted in `deviceLeasesPath(appDir)` (tolerant store, unknown fields kept).
- One device ↔ at most one active lease. A chat holds ≤ 3 leases. Human-opened devices (from the
  panel picker) lease to the visible chat.
- Leases are released when the chat closes (`agentChat.chat.lifecycle "closed"`), by
  `close_device`, by the user ("Release" in the panel), or after `leaseIdleMinutes` (default 60)
  with no agent or viewer activity.
- **Controller handoff.** New leases start with `controller: 'agent'` when opened by an agent,
  `'user'` when opened by the human. When the user touches or types on a device the agent
  controls, control switches to the user immediately (pill: "You have control · Give back").
  While the user has control, agent input actions fail with `DEVICE_CONTROLLED_BY_USER` ("The
  user is controlling this device. Wait, or ask them to give control back."); read-only actions
  (snapshot, screenshot, logs) still work. "Give back" returns control to the agent.

## 8. Hub proxy

- HTTP: `/api/devices/hosts/:hostId/hub/*`; WebSocket: `/ws-device/:hostId/*` (added to the SPA
  fallback prefixes).
- Allowlists ported from t3code's `DeviceHubProxy.ts`: device list, serve-sim helper streams
  (`stream.avcc`, `stream.mjpeg`, `ws`), serve-sim grid start, serve-emu `ws`, `api/fold`,
  screenshot. Everything else 404; non-GET only on the mutable list.
- Auth: HTTP routes use the daemon's normal auth; WebSockets the same `?token=` scheme desktops
  use. Viewing needs a lease visible to the caller's server session (any authenticated client of
  the owner); input frames are accepted only from the panel that holds `controller: 'user'` or
  when the lease's controller switches on the first input (see §7).
- Strip cookies/authorization/dpop, rewrite `Origin`/`Host`, `Cache-Control: no-store,
  no-transform`, MJPEG still-frame repeat (t3code `mjpegStillFrame.ts`).
- Box hosts: upstream is the `forwardToHost` loopback port. Back-pressure: pause the upstream
  past 8 MiB buffered (as `desktops/ws-routes.ts`).

## 9. Agent tools

Toolset `devices` in `packages/api/src/agent-tools.ts`, chat audience, advertised when the plugin
is on and at least one platform is enabled. Defined in `apps/daemon/src/mcp/tools/devices.ts`
behind `DaemonApi`.

| Tool | Tier | Input | Result |
|---|---|---|---|
| `list_devices` | read | — | Hosts (platform, readiness summary, capacity), profiles, this chat's leases, other leases as "busy". |
| `open_device` | act (spend card if it must rent a Mac and isn't pre-approved) | `platform`, `profile?`, `app?` (bundle id/package to launch), `fresh?` | Lease summary (`device` key, name, OS, screen size), and a 6-line quick start. Waits for boot (iOS host rental can take minutes; returns progress text if it exceeds 9 min with `state: 'starting'` and a hint to call `list_devices`). |
| `device_action` | act (read-only kinds are read) | `device`, `action`, args | See below. |
| `device_install` | act | `device`, `path` (a file or `.app`/`.apk`/`.ipa` inside the chat's project) | Streams the build to the host and installs; returns bundle id. |
| `close_device` | act | `device`, `shutdown?` | Releases the lease. |

`device_action` actions (agent-device under the hood, pinned with `--config`/`--session`):
`snapshot` (interactive accessibility tree with `@eN` refs, compact text), `tap` (`ref` or
`x,y` in points), `long_press`, `fill` (`ref`, `text`), `type` (`text`), `press` (`home`,
`back`, `enter`, `app_switch`, `volume_up/down`, `lock`), `swipe` (`direction` or
`from`/`to`), `scroll` (`direction`, `ref?`), `open_app` (`app`), `close_app`, `open_url`,
`screenshot` (image result), `logs` (`seconds` ≤ 60), `rotate` (`portrait|landscape`),
`appearance` (`light|dark`), `location` (`lat`,`lon`), `permissions` (`app`, `grant|revoke`,
`permission`), `wait` (`text|ref`, `timeout`).

- After each input action the tool returns the new snapshot diff (agent-device `--settle`) so
  the agent rarely needs a separate snapshot call.
- Errors name the next call: `DEVICE_NOT_LEASED` → "call open_device", `DEVICE_LOST`,
  `DEVICE_CONTROLLED_BY_USER`, `DEVICE_CAPACITY`, `PLATFORM_NOT_READY` (with the missing
  readiness items and "ask the owner to enable it in Settings → Devices").
- Every action is recorded in the lease's action log (`DeviceActionEntry { at, kind, summary,
  point?, from?, to?, ok }`, last 200 in memory, broadcast on `DEVICES_CHANNEL`) so the panel draws
  taps/swipes and lists actions. Ref taps resolve the ref's frame from the last snapshot to get a
  point.
- Screenshots: returned as an MCP image block plus JSON metadata, capped like
  `MAX_SCREENSHOT_BASE64_CHARS` (JPEG fallback). The daemon also keeps the last 20 screenshots per
  lease on disk under the thread's attachment area and returns a `deviceRef` session-tool
  reference (`{device, screenshotId}`) so the chat row shows a thumbnail without base64 in the
  transcript.
- `composeOrquesterInstructions` gains one line when the toolset is advertised: "Mobile devices:
  call list_devices/open_device; prefer device_action snapshot refs over coordinates; the user
  watches the Device panel." The rest of the guidance travels in `open_device`'s quick start.

## 10. UI

### 10.1 Device panel (right rail)

- A new rail panel `device` (`right-rail/panels.ts`, `types.ts`, `right-rail-state.ts`), in the
  docked rail and in the phone section list. The panel's width range is 320–900 px (wider than
  other panels, clamped per panel).
- Content: the visible chat's leases as tabs (name + platform glyph + controller dot); an empty
  state with a device picker (profiles grouped "Android" / "iPhone & iPad", each with readiness
  and an Open button; Mac host status: "No Mac host — opening an iPhone rents one (~$4.80/h)").
- Stream view: canvas fed by a WebCodecs `VideoDecoder` — serve-sim avcc envelopes for iOS,
  SEMU frames for Android; MJPEG fallback for iOS when WebCodecs is missing; Android without
  WebCodecs shows "This browser can't decode the stream" plus periodic screenshots. Keep the last
  frame during stalls; "Waiting for device video…" after 2 s of silence; reconnect with jittered
  backoff; connect only while the panel is visible.
- Input: pointer → normalized touch (begin/move/end) with letterbox and rotation mapping;
  keyboard focus ring; text paste; hardware keys. Mark the root `data-device-view` and add it to
  `SHORTCUT_BAIL_SELECTOR`.
- Toolbar (compact vertical rail): Home, Back (Android), Rotate, Screenshot (to the composer via
  `deliverToComposerDraft`, Shift-click downloads), Keyboard, 3D/Flat, More (Release, Power off,
  Restart app, Copy device key).
- Controller pill above the device: "● Claude is controlling" (amber) with **Take over**, or
  "You have control" with **Give back**; agent name from the lease's chat.
- Agent overlay: tap ripple with the target's label ("@e7 Search"), swipe trail, typed text
  bubble; fades after 1.2 s; respects `prefers-reduced-motion`.
- Action log drawer under the device: timestamped agent and user actions, failures in red.
- Booting state: steps "Renting Mac host" (iOS, with cost), "Preparing host", "Starting device",
  "Connecting video", each with elapsed time.

### 10.2 Following the agent

When an agent opens a device for the visible chat, the rail opens on the Device panel and selects
it, unless the owner closed the panel for that chat during this session. Setting (Settings →
Devices): "Show the device when an agent opens one" (default on). Reload never reopens dismissed
devices (first snapshot is the baseline, as t3code `useAgentOpenedPreviews`).

### 10.3 Chat rows

`presentation.logic.ts` labels: "Opened Pixel 9", "Tapped @e7 “Search”", "Took a screenshot",
etc. Rows with a `deviceRef` show a **Show device** button (opens the panel on that device) and
a thumbnail for screenshots (served by an authenticated route).

### 10.4 3D device frames

- Port t3code's viewer (`phoneViewer`, `phoneScene`, `modelScene`, `model`, `shapeProfile`,
  `deviceMotion`, `deviceFraming`, `deviceViewSnap`, `phoneInteraction`, `renderScheduler`,
  `frame`, `phoneTrackpad`, `androidFoldScene`, `duoViewer`, `duoScene`, `duoSnap`,
  `duoControl`) into `packages/ui/src/components/device/three/` with their tests and the MIT
  notice (Copyright 2026 T3 Tools Inc.) in `THIRD_PARTY_NOTICES.md`.
- Ship the five GLBs and `sources.json` (owner's decision) under
  `packages/ui/src/components/device/models/`, plus `scripts/convert-device-model.py`. Re-encode
  geometry with meshopt and register `MeshoptDecoder` if the pipeline's output loads correctly;
  otherwise ship them as t3code does.
- `three@0.180.0` loaded lazily (dynamic `import()` in the UI only, never in the agent host).
- Default view: 3D when WebGL works and the stream is H.264; Flat otherwise or on request
  (per-device preference in localStorage). Flat view draws a 2D bezel from `shapeProfile`.

### 10.5 Settings → Devices

A section in the "server" group:
- **Android on this host**: readiness checklist (KVM, Node, ffmpeg, SDK, system image, AVDs,
  snapshot, tools) with Install all / Repair and live progress; profiles; max local devices.
- **iPhone & iPad (Mac hosts)**: provider (Blacksmith; disabled with a link to set it up in the
  Ephemeral AI VMs plugin when missing), size, lifetime, idle teardown, "Rent Mac hosts without
  asking" + monthly cap, current hosts with cost and Destroy.
- **Agents**: "Let agents use devices" (the toolset), "Show the device when an agent opens one".
- **Tools**: pinned versions and installed state.

### 10.6 Transports

Streams need the HTTP transport (as desktops/browsers). On the desktop app's Unix-socket
connection the panel shows "Live devices need a server connection" and still lists leases and
action logs.

## 11. Contracts and persistence

- `packages/api/src/devices.ts`: `DevicePlatform`, `DeviceProfile`, `DeviceHostSummary`,
  `DeviceHostReadiness`, `DeviceSummary`, `DeviceLeaseSummary`, `DeviceActionEntry`,
  `DeviceSetupJob`, `deviceRoutes`, `DEVICE_WS_PREFIXES`, `DEVICES_CHANNEL` events
  (`devices.hosts`, `devices.lease`, `devices.lease.closed`, `devices.action`, `devices.setup`),
  `DEVICES_PLUGIN_ID`.
- `packages/config/src/devices.ts`: `devicesSettingsSchema` (tolerant), `deviceLeasesFileSchema`,
  path helpers (`devicesDir`, `devicesToolsDir`, `androidSdkDir`, `androidAvdDir`,
  `devicesRuntimeDir`, `devicesSettingsPath`, `deviceLeasesPath`, `deviceScreenshotsDir`).
- `packages/api/src/boxes.ts`: `BoxPurpose` gains `"device-host"`; setup step id `devices`.

## 12. Verification

- Unit tests beside every new module (store tolerance, proxy allowlist, lease rules, controller
  handoff, capacity, stream envelope parsers, pointer mapping, action-log reducer, tool input
  validation, readiness evaluation).
- Fixture tests for the hub proxy (HTTP + WS) with a fake hub.
- An end-to-end run on a separate checkout and appdir (never the live daemon): plugin on, install
  Android, open a Pixel through `open_device`, `device_action snapshot/tap/screenshot`, watch the
  stream in the web UI (agent-browser), take over, give back, close.
- An end-to-end iOS run on a Blacksmith macOS device host through the same test daemon.
- `pnpm check` and `pnpm test` green before merging to `main`.
