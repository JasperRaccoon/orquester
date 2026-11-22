# Devices — module map

iOS simulators and Android emulators beside agent chats: the "Device simulators" built-in plugin
(`devices`). Specs: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md` (this module),
`…-phase-2-fleet.md` (pools), `…-phase-3-byo-research.md` (BYO hosts, vphone),
`2026-11-22-tailnet-machines-and-agent-ssh-design.md` §4.4, §4.6 (devices on the owner's machines:
GPU host mode, capacity from the probe, hosts for agents, visibility, Metro and port forwards).

Contracts live outside this directory:

- `packages/api/src/devices.ts` — profiles, host/lease/action/setup types (a host summary's
  `stream.iosH264` picks the panel's iOS transport), `deviceRoutes` (`userAction` included),
  `DEVICE_WS_PREFIXES`, `DEVICES_CHANNEL` events, error codes, request validators, `deviceRef`
  (`{device, leaseId?, screenshotId?, name?, action?, summary?}`: the chat row's words after a reload).
- `packages/config/src/devices.ts` — `devices.json` settings and `device-leases.json` schemas;
  path helpers (`devicesDir`, `devicesToolsDir`, `androidSdkDir`, `androidAvdDir`,
  `devicesRuntimeDir`, `devicesHubStatePath`, `deviceScreenshotsDir`, `devicesSettingsPath`,
  `deviceLeasesPath`) in `packages/config/src/index.ts`.
- `apps/daemon/src/mcp/tools/devices.ts` — the six agent tools (`devices` toolset: `list_devices` with
  the hosts, `open_device` with any visible `host`, `device_action`, `device_install`,
  `device_forward_port`, `close_device`), through
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
| `pool.ts` | `choosePlacement` (phase 1 rules: named hosts, setup, off) and the pure phase 2 scheduler `decidePool` (placement local-first, then the owner's own machines before rented hosts, best fit within each, starting hosts, queue with deadlines, scale up within `maxHosts`/`maxHourlyUsd` and the standing approval or an approved card, warm minimum, idle/drain teardown, Android ≤ 16 per host). |
| `pool-actor.ts` | `DevicePool`: runs `decidePool` on every host/lease/settings change and at queue deadlines; rents through the factories' `provision` (one at a time per platform), destroys idle/drained rented hosts (the ONE idle teardown of rented hosts, `pool.idleTeardownMinutes`; `ios.idleTeardownMinutes` is read into it), learns capacity per provider+size, drained ids, cache warms (`cache-warm` jobs; miss → once a day; weekly refresh; a run in flight at a restart is polled again from its persisted `lastRunId`), publishes `devices.pool`. Spend comes from the box records (`hosts/box/rental.ts` `deviceHostSpend`). Persisted in `device-pool.json` (`DevicePoolStore`). |
| `thumbnails.ts` | Lease thumbnails for the fleet view: the hub's screenshot → downscaled JPEG (in the image workers), ≤ 1 s cache per lease. |
| `service.ts` | `DeviceService`: hosts, settings, leases, setup jobs, action log, the agent tools' operations; visibility through the optional `machineAccess` (hosts on Hidden machines or with "Device simulators" off are in no summary, placement — the pool's `placeable` too — or tool answer; a named one reads `HOST_NOT_FOUND` like an unknown id); own hosts' `machineId`; the lease's port forwards (Metro after a boot, made again when the host is ready, closed with the lease or when it is lost). |
| `machine-access.ts` | How devices read the machines registry's `MachineAccessPort` (`machines/ports.ts`): `byoRunsDevices` (the policy when the registry knows the machine, else the box's `deviceHost`), `boxAllowsDevices`, `machineIdOfBox`. |
| `forwards.ts` | `DeviceForwards`: per-lease port forwards `{devicePort, targetPort, auto}` — a listener on the device machine's loopback (a box's forward list through `ProjectBoxForwards` `bind: "box"`, iOS on the exact port; this host's own loopback) piped to the project's port (this host or its project box), `adb reverse` on Android, nothing on the same machine; Metro auto-forward after Metro's `/status` answers; wanted lists persisted on the lease record (`forwards`); `createDeviceForwardLink` over the box wiring. |
| `tools-port.ts` | `DeviceToolsPort` and `runDeviceTool` (principal → thread, `DeviceError` → outcome). |
| `http-routes.ts` | `deviceRoutes` on both transports (`user-action` and forward changes refuse agent and external principals), a lease's `forwards` (GET/POST) and `forward` (DELETE), the hub proxy route too (raw bodies, `?token=` accepted on remote; the desktop app's unix connection gets here through `apps/desktop/src/device-relay.ts`). |
| `user-actions.ts` | The panel's buttons that are not hub input (`rotate`, `restart_app`, `appearance`, `power_off`): control goes to the user first, rows are logged as the user's (failures too). |
| `ws-routes.ts` | `/ws-device/:hostId/*`: token, plugin, host and lease checks, then `HubProxy.handleWebSocket`. |
| `wiring.ts` | `createDaemonDevices`: follows the plugin (service on/off), builds the factories and executor, routes; `machineAccess` (optional, read when the plugin turns on) goes to the box and vphone factories and the service; the forward link over `DaemonBoxes.projectForwards`. |
| `testing.ts` | `FakeDeviceHost` (box info, problems), `FakeHostFactory`, `FakeActionExecutor`, `FakeMachineAccess`, `startTestDeviceService`. |
| `hub-proxy.ts` | The hub proxy: path/method allowlists (`direct/hub-paths.mjs`), leased-device check, header allowlists, the hub token as `Authorization: Bearer`, WS relay (8 MiB back-pressure), input → `userInput`, viewer counts → `DeviceHost.viewersChanged` (with the streams own machines' gates report open on direct routes: `directViewers`, `directInput`). |
| `mjpeg-still-frame.ts` | Re-sends the last MJPEG part once when the stream goes quiet (so `<img>` paints a still screen). |
| `agent-device.ts` | The agent-device runner: pinned `--config`/`--session`/device flags before the command, no shell, an allowlisted environment (no daemon secrets, no `AGENT_DEVICE_*`), caps; typed text never in argv (`fill --text-stdin`; `type` and `wait` text as a one-step `batch --steps-file /dev/stdin`); `--json` refusals → `DeviceError`. Fixtures: `fixtures/agent-device/`. |
| `actions.ts` | `planAction` (every `device_action` kind → agent-device or `DeviceHost.run`), points ↔ agent-device units, ref → point, session reopen, screenshots, installs, `restartApp` (foreground app → `open <app> --relaunch`; the home screen is refused); `DeviceHost.performAction` / `installApp` answer first. |
| `screenshot-image.ts` | PNG decode, downscale and baseline JPEG encode: screenshots fit `DEVICE_SCREENSHOT_MAX_BASE64_CHARS`. |
| `image-pool.ts`, `image-worker.ts` | `deviceImages`: `screenshot-image.ts` run in ≤ 2 worker threads (thumbnails and agent screenshots off the event loop): queue cap 32, a lease's queued thumbnail replaced by its newer one, screenshots ahead of thumbnails, 30 s job deadline. The `.ts` entry loads through the inherited `--import tsx`. |
| `hosts/vphone/` | Phase 3 research hosts (`vphone:<boxId>`, kind `byo`): `factory.ts` adopts BYO Macs with "Use for device simulators" and `settings.research.vphoneHosts[boxId].enabled`; `readiness.ts` (checks with fix commands; never changes SIP/AMFI), `cli.ts` (vphone-cli over `BoxConnection.exec`), `host.ts` (clone/launch/forward/stop/delete per lease, token in env and a 0600 record), `bridge.ts` (loopback serve-sim endpoints ↔ `/v1/host/screen`, `screen.screenshot` (MJPEG and `POST /api/screenshot?device=`, the fleet thumbnail), `/v1/events`), `agent-actions.ts` + `snapshot.ts` (`performAction` → vphoned RPCs), `testing.ts` (fake vphoned, fake Mac link). |
| `hosts/box-host.ts` | Box device hosts: rented Macs (box purpose `device-host`, its `devices` setup step is this factory's preparer) and own machines used for devices (`byo`: the machine's registry policy, else "Use for device simulators"; a policy turning devices off removes the host and stops what devices run there); adoption at start, `provision`/`provisionQuote` (spend rules), drain near the deadline (`pool.drainReason: "deadline"`: the fleet reads "Ending soon (deadline)", Resume is refused), failed rented hosts destroyed, idle own Macs' helpers stopped (idle rented hosts are the pool's). |
| `hosts/box/host.ts` | `BoxDeviceHost`: prepare over `BoxConnection` (probe, pinned tools, detached hub, agent-device daemon, forwards, 0600 `--config`, simslim), runner warm-up, simulators per lease (from the pool, or slimmed while shut down), `capacity` from RAM and `simslim top` (its `basis`: CPUs, free memory and disk, `hvf`); an own Mac's `problems` (asleep or offline, `xcode-path`, `devtools-security-off`). |
| `hosts/box/android-host.ts` | `BoxAndroidHost`: Android emulators on a Linux box (a rented `linux` device-host box, or an own Linux machine marked for devices with `kvm`), the local Android modules run through `android-executor.ts`: probe (KVM direct/`sg`, Node, ffmpeg, Java, sudo; no KVM fails at once), ffmpeg via apt, tools from the lockfile, SDK/image/AVDs (kept when the cache restored them), the first profile's `orq-golden` (the cache's with the GPU mode it recorded, or made here trying GPU modes in order: an own machine with a usable GPU `host` first — a boot rendering in software fails it, and the failed GPU + emulator is kept in `android-host.json` `gpuHostFailed` —, then the software modes), detached hub + agent-device forwarded, 0600 `--config`; leases from `orq-golden` (cold when it does not load); reattach from `android-host.json` in the box; capacity `min(vCPU/2, memory, 16)` and on an own machine its free disk too, with its `basis`; an own machine's `problems` (`kvm-permission`, `linger-off`, asleep or offline); `cacheState()`. |
| `hosts/box/android-executor.ts`, `android-remote.ts` | The box `DeviceExecutor` (exec, `setsid` detached processes with logs, files, `/proc`, `curl` downloads); the probe (also free memory and disk, the kvm group and `/dev/kvm` mode, systemd linger, NVIDIA driver and DRM render nodes), `usableHostGpu`, `boxGpuModes`, `rendersInSoftware`, `androidProbeProblems`, ffmpeg install, box AVD/golden state (both from `orq-avd.json`/`orq-box-golden.json`: `source: "cache"` is the cache's; no marker or another config hash is outdated), capacity, the Linux rental spec (`pool.androidSize`, default `blacksmith-16vcpu-ubuntu-2404`; time limit `pool.androidLifetimeMinutes`, Mac hosts keep `ios.lifetimeMinutes`). `android-testing.ts`: a fake Linux box over `localBoxConnection()`. |
| `hosts/box/problems.ts` | Own machines' problems beyond the Linux probe's: asleep or offline (Mac or Linux), the Mac's Xcode path and developer mode, each with its fix. |
| `hosts/box/remote.ts`, `simctl.ts`, `rental.ts`, `agent-device-config.ts` | Box layout and the commands run there (the probe also reads `xcode-select -p`, `DevToolsSecurity`, CPUs, `vm_stat` free memory and free disk); `simctl` parsing, profile → device type, simulator names (`orq-<leaseId>`, `orq-pool-*`, `orq-poolprep-*`), the boot-frame heuristic; rental spec and approval; the agent-device config file. `testing.ts`: `FakeMacBox` (simslim emulated with `{ simslim: true }`). |
| `hosts/box/simslim.ts`, `simslim-capacity.ts`, `sim-pool.ts` | simslim (pin and install script in `boxes/github/device-cache.ts`): the Orquester slim profile, command builders, `--json` parsers (fixtures: `fixtures/simslim/`), the iOS 18.5 gate, the device-set decision (default set, `orq-*` names: serve-sim reads only the default set); capacity math; the pre-slimmed pool (N per profile, one refill at a time in the boot slot, preempted by lease boots). `simslim.it.ts` generates the Mac integration run's script. |

Seams owned by the parallel work packages (each file states its contract; replace the stand-in
inside it, keep the exported signature `wiring.ts` calls):

| File | Owner | Stand-in today |
|---|---|---|
| `toolchain/` (`index.ts`, `../tool-versions.json`) | toolchain: pinned npm tools, Android SDK, AVDs | implemented (below) |
| `hosts/local-android.ts` | local Android host: emulators, supervised hub, capacity, readiness with fix actions | implemented (below) |
| `hosts/box-host.ts` | Mac device hosts (box purpose `device-host`, setup step `devices`), `provision`, `provisionQuote`, `destroy` | implemented (above) |
| `service.ts`, `leases.ts`, `http-routes.ts`, `ws-routes.ts`, `wiring.ts` | shared: extend, don't fork | complete for phase 1 |

## Direct stream routes (`direct/`, tailnet machines spec §4.5)

The owner's viewer streams an own machine's devices straight from it when it can reach it; agents
keep going through the daemon. `POST deviceRoutes.streamTicket(hostId)` (`service.streamTicket`,
people only) answers the routes best first — `tailnet` (the machine's `tailscale serve` is up),
`lan` (desktop app only), `daemon` (always, last) — and a ticket for one leased device, bound to the
asking page's origin, valid `DEVICE_STREAM_TICKET_TTL_MS`.

| File | What it is |
|---|---|
| `direct/hub-paths.mjs` | The hub path allowlists and header allowlists, shared by the proxy and the gate (plain JS: uploaded to the machine). |
| `direct/gate.mjs` | The stream gate on the machine (Node standard library only): `0.0.0.0:<port>`, the public identity (`DEVICE_HOST_IDENTITY_PATH`), ticketed hub paths that name a device (HMAC tickets: host, device, expiry, origin; CORS for that origin), WS relay reading client frames only to tell input from `reset-video`, `/.orq/gate/*` for the daemon (status, events long poll: viewers, input, LAN IPv4s; stop). Ticket sign/verify live here and the daemon imports them. |
| `direct/machine-gate.ts` | `DirectStreamGate` (one per own-machine host, made by `hosts/box-host.ts`): uploads the gate, 0600 config with the per-host secret (read back after a restart), reuses or starts detached `orq-devices-gate`, long-polls its events into the hub proxy, keeps its `tailscale serve` route (every ensure and 2 min), `stop` (idle, teardown) removes only Orquester's route. |
| `direct/serve.ts` | `tailscale` on the machine through the box link (`createLocalTailscale` with a remote runner; the macOS app's CLI found too), `decideGateServe` over `tailnet/decide.ts`'s ownership rules (ports 10043–10047, 8444), the problems with their fixes (`tailscale-not-operator`, `tailscale-https-disabled`, `tailscale-unavailable`, `serve-port-taken`). |
| `direct/routes.ts` | `streamRoutes`: the ticket's route order per client. |

The panel's side is `packages/ui/src/components/device/stream/routes.ts` (usable routes, identity
probe, the roaming state machine) and `useStreamRoute.ts`.

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
- Secrets (hub and agent-device tokens, stream gate secrets) stay in host-side files; never in
  summaries, events, logs or process arguments. Browsers get only short-lived stream tickets, and
  only after the route's identity answered the expected machine. `DeviceError` messages are shown to the owner or the agent.
- Agent tools act for the calling chat only: `runDeviceTool` takes the thread from the principal;
  a handle naming another chat's device reads `DEVICE_NOT_LEASED`.
- Hosts on a Hidden machine or with "Device simulators" off do not exist for devices: no summary,
  no placement, no tool answer, no setup; their factories drop them. Rented boxes and this host are
  always allowed. Own machines are placed on before rented hosts.
- Port forwards close with their lease (released, lost, its chat closed, its machine gone); their
  wanted list lives on the lease record, what listens is memory only and is made again once the
  host is ready.
- Control: the panel's input frames, a fold POST through the proxy, and every user action switch
  control to the user; the agent's input then answers `DEVICE_CONTROLLED_BY_USER` (reads still run).
  Watching (streams, a fold GET) never changes control.
