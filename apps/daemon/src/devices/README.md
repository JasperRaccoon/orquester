# Devices — module map

iOS simulators and Android emulators beside agent chats: the "Device simulators" built-in plugin
(`devices`). Specs: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md` (this module),
`…-phase-2-fleet.md` (pools), `…-phase-3-byo-research.md` (BYO hosts, vphone).

Contracts live outside this directory:

- `packages/api/src/devices.ts` — profiles, host/lease/action/setup types, `deviceRoutes`,
  `DEVICE_WS_PREFIXES`, `DEVICES_CHANNEL` events, error codes, request validators, `deviceRef`.
- `packages/config/src/devices.ts` — `devices.json` settings and `device-leases.json` schemas;
  path helpers (`devicesDir`, `devicesToolsDir`, `androidSdkDir`, `androidAvdDir`,
  `devicesRuntimeDir`, `devicesHubStatePath`, `deviceScreenshotsDir`, `devicesSettingsPath`,
  `deviceLeasesPath`) in `packages/config/src/index.ts`.
- `apps/daemon/src/mcp/tools/devices.ts` — the five agent tools (`devices` toolset), through
  `DaemonApi.devices*` (`mcp/daemon-api.ts`) → `DeviceToolsPort` (`tools-port.ts`).

## Files

Foundation (shared seams; change them only with the other work packages in mind):

| File | What it is |
|---|---|
| `host.ts` | `DeviceHost` (one machine), `DeviceHostFactory` (makes/rents hosts), `DeviceHostRegistry`, `DeviceRentalQuote`. |
| `errors.ts` | `DeviceError(code, message)` with its HTTP status. |
| `store.ts` | Tolerant atomic stores: `DeviceSettingsStore` (`devices.json`), `DeviceLeaseStore` (`device-leases.json`). |
| `leases.ts` | Pure lease and controller rules: acquire, boot, handoff, agent-action checks, handles, idle, host loss. |
| `action-log.ts` | Per-lease ring buffer of `DeviceActionEntry` (last 200, memory only). |
| `screenshots.ts` | Last 20 screenshots per lease on disk (`deviceRef.screenshotId`), dropped when the chat closes. |
| `pool.ts` | `choosePlacement`: where a new lease goes (local first, best fit, wait, setup, provision, full). Phase 2 grows it into `decidePool`. |
| `service.ts` | `DeviceService`: hosts, settings, leases, setup jobs, action log, the agent tools' operations. |
| `tools-port.ts` | `DeviceToolsPort` and `runDeviceTool` (principal → thread, `DeviceError` → outcome). |
| `http-routes.ts` | `deviceRoutes` on both transports; the hub proxy route on remote only (raw bodies, `?token=` accepted). |
| `ws-routes.ts` | `/ws-device/:hostId/*`: token, plugin, host and lease checks, then `HubProxy.handleWebSocket`. |
| `wiring.ts` | `createDaemonDevices`: follows the plugin (service on/off), builds the factories and executor, routes. |
| `testing.ts` | `FakeDeviceHost`, `FakeHostFactory`, `FakeActionExecutor`, `startTestDeviceService`. |
| `hub-proxy.ts` | The hub proxy: path/method allowlists, leased-device check, header allowlists, the hub token as `Authorization: Bearer`, WS relay (8 MiB back-pressure), input → `userInput`, viewer counts → `DeviceHost.viewersChanged`. |
| `mjpeg-still-frame.ts` | Re-sends the last MJPEG part once when the stream goes quiet (so `<img>` paints a still screen). |
| `agent-device.ts` | The agent-device runner: pinned `--config`/`--session`/device flags before the command, no shell, scrubbed `AGENT_DEVICE_*`, caps; `--json` refusals → `DeviceError`. Fixtures: `fixtures/agent-device/`. |
| `actions.ts` | `planAction` (every `device_action` kind → agent-device or `DeviceHost.run`), points ↔ agent-device units, ref → point, session reopen, screenshots, installs; `DeviceHost.performAction` / `installApp` answer first. |
| `screenshot-image.ts` | PNG decode, downscale and baseline JPEG encode: screenshots fit `DEVICE_SCREENSHOT_MAX_BASE64_CHARS`. |
| `hosts/box-host.ts` | Box device hosts: rented Macs (box purpose `device-host`, its `devices` setup step is this factory's preparer) and own Macs marked for devices (`byo`); adoption at start, `provision`/`provisionQuote` (spend rules), idle teardown, drain near the deadline. |
| `hosts/box/host.ts` | `BoxDeviceHost`: prepare over `BoxConnection` (probe, pinned tools, detached hub, agent-device daemon, forwards, 0600 `--config`), runner warm-up, simulators per lease. |
| `hosts/box/remote.ts`, `simctl.ts`, `rental.ts`, `agent-device-config.ts` | Box layout and the commands run there; `simctl` parsing, profile → device type, the boot-frame heuristic; rental spec and approval; the agent-device config file. `testing.ts`: `FakeMacBox`. |

Seams owned by the parallel work packages (each file states its contract; replace the stand-in
inside it, keep the exported signature `wiring.ts` calls):

| File | Owner | Stand-in today |
|---|---|---|
| `toolchain/` (`index.ts`, `../tool-versions.json`) | toolchain: pinned npm tools, Android SDK, AVDs, golden snapshots | reports everything missing, refuses installs |
| `hosts/local-android.ts` | local Android host: supervised hub, emulators, capacity, readiness with fix actions | adds a `PlaceholderDeviceHost` (`hosts/placeholder.ts`) while Android is enabled |
| `pool.ts` | phase 2 scheduler (`decidePool`), keeping `choosePlacement`'s contract | phase 1 rules |
| `service.ts`, `leases.ts`, `http-routes.ts`, `ws-routes.ts`, `wiring.ts` | shared: extend, don't fork | complete for phase 1 |

## Rules

- The service exists only while the plugin is on (`wiring.ts`); turning it off releases every
  lease. A daemon restart keeps devices running: `stop()` never releases.
- `device-leases.json` is the durable record; the action log and lease progress are memory only.
- A factory's `start` adds the hosts it has synchronously (before it resolves): leases on hosts
  that are missing afterwards are marked lost by the reconcile.
- Renting fails closed: a `provision` placement needs `provisionQuote(...).needsApproval === false`
  or an approved rental (the panel's Open, or `open_device`'s spend card).
- Secrets (hub and agent-device tokens) stay in host-side files; never in summaries, events,
  logs or process arguments. `DeviceError` messages are shown to the owner or the agent.
- Agent tools act for the calling chat only: `runDeviceTool` takes the thread from the principal;
  a handle naming another chat's device reads `DEVICE_NOT_LEASED`.
