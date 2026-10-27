# Devices — module map

iOS simulators and Android emulators beside agent chats: the "Device simulators" built-in plugin
(`devices`). Specs: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md` (this module),
`…-phase-2-fleet.md` (pools), `…-phase-3-byo-research.md` (BYO hosts, vphone).

Contracts live outside this directory:

- `packages/api/src/devices.ts` — profiles, host/lease/action/setup types (a host summary's
  `stream.iosH264` picks the panel's iOS transport), `deviceRoutes` (`userAction` included),
  `DEVICE_WS_PREFIXES`, `DEVICES_CHANNEL` events, error codes, request validators, `deviceRef`
  (`{device, leaseId?, screenshotId?, name?, action?, summary?}`: the chat row's words after a reload).
- `packages/config/src/devices.ts` — `devices.json` settings and `device-leases.json` schemas;
  path helpers (`devicesDir`, `devicesToolsDir`, `androidSdkDir`, `androidAvdDir`,
  `devicesRuntimeDir`, `devicesHubStatePath`, `deviceScreenshotsDir`, `devicesSettingsPath`,
  `deviceLeasesPath`) in `packages/config/src/index.ts`.
- `apps/daemon/src/mcp/tools/devices.ts` — the five agent tools (`devices` toolset), through
  `DaemonApi.devices*` (`mcp/daemon-api.ts`) → `DeviceToolsPort` (`tools-port.ts`); `open_device`'s
  per-platform quick start; the instruction line is `DEVICES_LINE` (`session-tools/instructions.ts`).

## Files

Foundation (shared seams; change them only with the other work packages in mind):

| File | What it is |
|---|---|
| `host.ts` | `DeviceHost` (one machine), `DeviceHostFactory` (makes/rents hosts), `DeviceHostRegistry`, `DeviceRentalQuote`; `deviceHostSummary` (with `stream` from `streamCapabilities`). |
| `errors.ts` | `DeviceError(code, message)` with its HTTP status. |
| `store.ts` | Tolerant atomic stores: `DeviceSettingsStore` (`devices.json`), `DeviceLeaseStore` (`device-leases.json`). |
| `leases.ts` | Pure lease and controller rules: acquire, boot, handoff, agent-action checks, handles, idle, host loss. |
| `action-log.ts` | Per-lease ring buffer of `DeviceActionEntry` (last 200, memory only). |
| `screenshots.ts` | Last 20 screenshots per lease on disk (`deviceRef.screenshotId`), dropped when the chat closes. |
| `pool.ts` | `choosePlacement` (phase 1 rules: named hosts, setup, off) and the pure phase 2 scheduler `decidePool` (placement local-first/best-fit/starting hosts, queue with deadlines, scale up within `maxHosts`/`maxHourlyUsd` and the standing approval or an approved card, warm minimum, idle/drain teardown, Android ≤ 16 per host). |
| `pool-actor.ts` | `DevicePool`: runs `decidePool` on every host/lease/settings change and at queue deadlines; rents through the factories' `provision` (one at a time per platform), destroys idle/drained rented hosts (the ONE idle teardown of rented hosts, `pool.idleTeardownMinutes`; `ios.idleTeardownMinutes` is read into it), learns capacity per provider+size, drained ids, cache warms (`cache-warm` jobs; miss → once a day; weekly refresh; a run in flight at a restart is polled again from its persisted `lastRunId`), publishes `devices.pool`. Spend comes from the box records (`hosts/box/rental.ts` `deviceHostSpend`). Persisted in `device-pool.json` (`DevicePoolStore`). |
| `thumbnails.ts` | Lease thumbnails for the fleet view: the hub's screenshot → downscaled JPEG (in the image workers), ≤ 1 s cache per lease. |
| `service.ts` | `DeviceService`: hosts, settings, leases, setup jobs, action log, the agent tools' operations. |
| `tools-port.ts` | `DeviceToolsPort` and `runDeviceTool` (principal → thread, `DeviceError` → outcome). |
| `http-routes.ts` | `deviceRoutes` on both transports (`user-action` refuses agent and external principals); the hub proxy route on remote only (raw bodies, `?token=` accepted). |
| `user-actions.ts` | The panel's buttons that are not hub input (`rotate`, `restart_app`, `appearance`, `power_off`): control goes to the user first, rows are logged as the user's (failures too). |
| `ws-routes.ts` | `/ws-device/:hostId/*`: token, plugin, host and lease checks, then `HubProxy.handleWebSocket`. |
| `wiring.ts` | `createDaemonDevices`: follows the plugin (service on/off), builds the factories and executor, routes. |
| `testing.ts` | `FakeDeviceHost`, `FakeHostFactory`, `FakeActionExecutor`, `startTestDeviceService`. |
| `hub-proxy.ts` | The hub proxy: path/method allowlists, leased-device check, header allowlists, the hub token as `Authorization: Bearer`, WS relay (8 MiB back-pressure), input → `userInput`, viewer counts → `DeviceHost.viewersChanged`. |
| `mjpeg-still-frame.ts` | Re-sends the last MJPEG part once when the stream goes quiet (so `<img>` paints a still screen). |
| `agent-device.ts` | The agent-device runner: pinned `--config`/`--session`/device flags before the command, no shell, an allowlisted environment (no daemon secrets, no `AGENT_DEVICE_*`), caps; typed text never in argv (`fill --text-stdin`; `type` and `wait` text as a one-step `batch --steps-file /dev/stdin`); `--json` refusals → `DeviceError`. Fixtures: `fixtures/agent-device/`. |
| `actions.ts` | `planAction` (every `device_action` kind → agent-device or `DeviceHost.run`), points ↔ agent-device units, ref → point, session reopen, screenshots, installs, `restartApp` (foreground app → `open <app> --relaunch`; the home screen is refused); `DeviceHost.performAction` / `installApp` answer first. |
| `screenshot-image.ts` | PNG decode, downscale and baseline JPEG encode: screenshots fit `DEVICE_SCREENSHOT_MAX_BASE64_CHARS`. |
| `image-pool.ts`, `image-worker.ts` | `deviceImages`: `screenshot-image.ts` run in ≤ 2 worker threads (thumbnails and agent screenshots off the event loop): queue cap 32, a lease's queued thumbnail replaced by its newer one, screenshots ahead of thumbnails, 30 s job deadline. The `.ts` entry loads through the inherited `--import tsx`. |
| `hosts/vphone/` | Phase 3 research hosts (`vphone:<boxId>`, kind `byo`): `factory.ts` adopts BYO Macs with "Use for device simulators" and `settings.research.vphoneHosts[boxId].enabled`; `readiness.ts` (checks with fix commands; never changes SIP/AMFI), `cli.ts` (vphone-cli over `BoxConnection.exec`), `host.ts` (clone/launch/forward/stop/delete per lease, token in env and a 0600 record), `bridge.ts` (loopback serve-sim endpoints ↔ `/v1/host/screen`, `screen.screenshot` (MJPEG and `POST /api/screenshot?device=`, the fleet thumbnail), `/v1/events`), `agent-actions.ts` + `snapshot.ts` (`performAction` → vphoned RPCs), `testing.ts` (fake vphoned, fake Mac link). |
| `hosts/box-host.ts` | Box device hosts: rented Macs (box purpose `device-host`, its `devices` setup step is this factory's preparer) and own Macs marked for devices (`byo`); adoption at start, `provision`/`provisionQuote` (spend rules), drain near the deadline (`pool.drainReason: "deadline"`: the fleet reads "Ending soon (deadline)", Resume is refused), failed rented hosts destroyed, idle own Macs' helpers stopped (idle rented hosts are the pool's). |
| `hosts/box/host.ts` | `BoxDeviceHost`: prepare over `BoxConnection` (probe, pinned tools, detached hub, agent-device daemon, forwards, 0600 `--config`, simslim), runner warm-up, simulators per lease (from the pool, or slimmed while shut down), `capacity` from RAM and `simslim top`. |
| `hosts/box/android-host.ts` | `BoxAndroidHost`: Android emulators on a Linux box (a rented `linux` device-host box, or an own Linux machine marked for devices with `kvm`), the local Android modules run through `android-executor.ts`: probe (KVM direct/`sg`, Node, ffmpeg, Java, sudo; no KVM fails at once), ffmpeg via apt, tools from the lockfile, SDK/image/AVDs (kept when the cache restored them), the first profile's `orq-golden` (the cache's with the GPU mode it recorded, or made here trying GPU modes in order), detached hub + agent-device forwarded, 0600 `--config`; leases from `orq-golden` (cold when it does not load); reattach from `android-host.json` in the box; capacity `min(vCPU/2, memory, 16, own machine's cap)`; `cacheState()`. |
| `hosts/box/android-executor.ts`, `android-remote.ts` | The box `DeviceExecutor` (exec, `setsid` detached processes with logs, files, `/proc`, `curl` downloads); the probe, ffmpeg install, box AVD/golden state (both from `orq-avd.json`/`orq-box-golden.json`: `source: "cache"` is the cache's; no marker or another config hash is outdated), capacity, the Linux rental spec (`pool.androidSize`, default `blacksmith-16vcpu-ubuntu-2404`; time limit `pool.androidLifetimeMinutes`, Mac hosts keep `ios.lifetimeMinutes`). `android-testing.ts`: a fake Linux box over `localBoxConnection()`. |
| `hosts/box/remote.ts`, `simctl.ts`, `rental.ts`, `agent-device-config.ts` | Box layout and the commands run there; `simctl` parsing, profile → device type, simulator names (`orq-<leaseId>`, `orq-pool-*`, `orq-poolprep-*`), the boot-frame heuristic; rental spec and approval; the agent-device config file. `testing.ts`: `FakeMacBox` (simslim emulated with `{ simslim: true }`). |
| `hosts/box/simslim.ts`, `simslim-capacity.ts`, `sim-pool.ts` | simslim (pin and install script in `boxes/github/device-cache.ts`): the Orquester slim profile, command builders, `--json` parsers (fixtures: `fixtures/simslim/`), the iOS 18.5 gate, the device-set decision (default set, `orq-*` names: serve-sim reads only the default set); capacity math; the pre-slimmed pool (N per profile, one refill at a time in the boot slot, preempted by lease boots). `simslim.it.ts` generates the Mac integration run's script. |

Seams owned by the parallel work packages (each file states its contract; replace the stand-in
inside it, keep the exported signature `wiring.ts` calls):

| File | Owner | Stand-in today |
|---|---|---|
| `toolchain/` (`index.ts`, `../tool-versions.json`) | toolchain: pinned npm tools, Android SDK, AVDs | implemented (below) |
| `hosts/local-android.ts` | local Android host: emulators, supervised hub, capacity, readiness with fix actions | implemented (below) |
| `hosts/box-host.ts` | Mac device hosts (box purpose `device-host`, setup step `devices`), `provision`, `provisionQuote`, `destroy` | implemented (above) |
| `service.ts`, `leases.ts`, `http-routes.ts`, `ws-routes.ts`, `wiring.ts` | shared: extend, don't fork | complete for phase 1 |

## Local Android (toolchain, `android/`, `hosts/local-android.ts`)

Facts and flags come from the spike (`docs/superpowers/research/2026-10-27-devices-spikes.md` §2).

| File | What it is |
|---|---|
| `toolchain/index.ts` | `DeviceToolchain`: tool and SDK status, `ensureTool`, `ensureAndroidSdk`, `ensureSystemImage`, `ensureAvd`; the appdir's `layout` and private `env`. |
| `toolchain/npm-tools.ts` | `<tools>/<name>@<version>`: the shipped lockfile (`locks/<name>/`, `locks/box-tools/` for boxes) installed with `npm ci --ignore-scripts`, node-datachannel's prebuilt binary fetched explicitly; staging dir, `.install-complete`, rename, per-tool lock (`lock.ts`: atomic pid file), prune to current + previous; the hub's scrcpy-server v4.0 jar pre-seeded (pinned SHA-256). |
| `toolchain/android-sdk.ts` | cmdline-tools (pinned URL + SHA-256), `sdkmanager --licenses` (the owner's Install click accepts), packages, AVD creation + markers (`orq-avd.json`, `orq-golden.json`). |
| `toolchain/download.ts` | Pinned, checksummed downloads (`<dest>.part` → rename). |
| `android/executor.ts` | `DeviceExecutor`: where the Android tooling runs (exec, detached processes with logs, text files, `/proc` liveness, ports, downloads); `LOCAL_EXECUTOR` here, `hosts/box/android-executor.ts` in a box. Every module below takes one (absent: local). |
| `android/env.ts` | `androidLayout` (every path under `devicesDir`; `androidLayoutAt(root)` for a box) and `buildAndroidEnv` (allowlisted daemon env + `ANDROID_*`, `XDG_RUNTIME_DIR`, `TMPDIR` and `ANDROID_TMP` (the emulator's overlays and crashpad database; it ignores `TMPDIR`), `HOME`, hub and agent-device state dirs, private `ANDROID_ADB_SERVER_PORT` 16000–19999 from the appdir). |
| `android/avd-config.ts` | Per-profile framebuffer (≈720 px across, the device's real aspect, orientation and dp size; foldable hinges and display regions scaled), the `config.ini` patch (avdmanager placeholders, 2 GB, 2 cores, `swangle_indirect`, no cameras/audio, keyboard), `cutoutSpecInDp` (the system image's pixel cutout re-expressed in dp). The patch, the cutout and its overlays (`cutoutOverlayPlan`: cutout, rect approximation, fill) live in `avd-tuning.mjs` (plain JS, types in `.d.mts`): the Linux device-cache workflow embeds that file verbatim. |
| `android/emulator.ts` | Flags (GPU mode, named snapshot, cold fallback), port allocation (5554–5682, above adb's 5555–5585 scan first), detached launch (direct or `sg kvm -c`), QEMU pid lookup, `sys.boot_completed` wait, `adb emu kill` → SIGTERM → SIGKILL, only to a verified emulator (marker, `qemu-system*`, recorded start time). |
| `android/golden.ts` | The golden snapshot, made lazily on a profile's first open: cold writable boot, CPU settle (≤ 5 min), guest settings, the dp display cutout (`fixDisplayCutout`: the overlays of `cutoutOverlayPlan` fabricated as root, then a SystemUI restart), agent-device helper APKs, `emu kill` saves `default_boot` (box hosts: `adb emu avd snapshot save orq-golden`). |
| `android/hub.ts`, `hub-launcher.mjs` | The supervised hub (detached; token from its 0600 `server-<port>.json`, redacted from its log), backoff, capture-session recycling. |
| `android/agent-device-daemon.ts` | Starts agent-device's daemon (`devices --json`), writes the 0600 `--config` (`daemonBaseUrl`, `daemonAuthToken`). |
| `android/state.ts` | `hub.json`: hub and emulator pids; `planReattach` (keep / reap / forget). |
| `android/capacity.ts`, `readiness.ts`, `procs.ts` | Capacity formula, the readiness checklist with fix action ids, `/proc` readers. |

Integration check on a KVM machine — install, two concurrent leases, hub `/api/devices` with the
token, agent-device through `--config`, a simulated daemon restart (reattach), release; then
`open_device` + `device_action snapshot` through a real `DeviceService` — in a throwaway appdir
(~6 min the first time: ~2 min install, ~4 min golden snapshot;
`ORQ_IT_SDK=<sdk>` hard-links an existing SDK instead of downloading it; never touches the live
daemon's appdir or ports):

```sh
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx src/devices/android/integration.it.ts /var/lib/orquester/tmp/devices-local-it/app [profile]
```

The Linux box host with real emulators, this machine as the box (`localBoxConnection()`): prepare,
`ORQ_IT_DEVICES` concurrent leases, `sys.boot_completed`, the display cutout (dumpsys + a
screenshot in `<root>/logs`), hub `/api/devices` with and without the token, agent-device
`snapshot -i`, a restart (reattach), release, teardown, nothing left running (~3 min with an SDK:
~2.5 min golden snapshot; the same script, bundled with esbuild, ran on a Blacksmith runner):

```sh
cd apps/daemon && ORQ_IT_SDK=/var/lib/orquester/tmp/devices-local-it/app/daemon/devices/android-sdk ORQ_IT_DEVICES=2 \
  TSX_DISABLE_CACHE=1 node --import tsx src/devices/hosts/box/android-integration.it.ts /var/lib/orquester/tmp/boxandroid-local-it/devices /var/lib/orquester/tmp/boxandroid-local-it/app
```

The box streaming path, this machine as the box: a box host's emulator leased through a real
`DeviceService`, its serve-emu WebSocket opened through the daemon's `/ws-device` route and the
real hub proxy on a random loopback port; after the first SEMU frame (the hub starts its capture
session, 1–6 s) SEMU frames are counted for 3 s, then one input frame must switch control from the
agent to the user; release, teardown, nothing left running (~6 min the first time, most of it the
golden snapshot, ~30 s after; a root the device-cache script built boots from the cache's golden;
`ORQ_IT_KIND=byo` tries an own machine's GPU order):

```sh
cd apps/daemon && ORQ_IT_SDK=/var/lib/orquester/tmp/devices-local-it/app/daemon/devices/android-sdk \
  TSX_DISABLE_CACHE=1 node --import tsx src/devices/hosts/box/stream-integration.it.ts /var/lib/orquester/tmp/stream-it/devices /var/lib/orquester/tmp/stream-it/app
```

## Rules

- The service exists only while the plugin is on (`wiring.ts`); turning it off releases every
  lease. A daemon restart keeps devices running: `stop()` never releases.
- `device-leases.json` is the durable record; the action log and lease progress are memory only.
- A factory's `start` adds the hosts it has synchronously (before it resolves): leases on hosts
  that are missing afterwards are marked lost by the reconcile.
- Renting fails closed: a rental needs the standing approval (`pool.rentWithoutAsking` — the ONE
  switch for every platform — within `pool.monthlyCapUsd`, counting this month's device-host spend
  plus what running hosts are committed to until their deadline) or an approved rental (the panel's
  Open, or `open_device`'s spend card: one per host).
- Every unnamed open queues in the pool (`pool-actor.ts`); the lease is recorded only after a
  synchronous capacity re-check on the placed host (no over-placement).
- The panel's Open (`POST` leases, `openQueued`) never blocks on that queue: while placement waits
  it answers a stand-in lease (`starting`, `hostId: "pool"`, the wait as its progress, memory
  only) that becomes the placed lease (same id) or `lost` with the reason; Release withdraws it.
  `open_device` keeps waiting (`beginOpen`).
- Leases whose device vanished from the host's `listDevices` (two lists in a row; on host changes
  and every 5 min) become `lost`.
- Secrets (hub and agent-device tokens) stay in host-side files; never in summaries, events,
  logs or process arguments. `DeviceError` messages are shown to the owner or the agent.
- Agent tools act for the calling chat only: `runDeviceTool` takes the thread from the principal;
  a handle naming another chat's device reads `DEVICE_NOT_LEASED`.
- Control: the panel's input frames, a fold POST through the proxy, and every user action switch
  control to the user; the agent's input then answers `DEVICE_CONTROLLED_BY_USER` (reads still run).
  Watching (streams, a fold GET) never changes control.
