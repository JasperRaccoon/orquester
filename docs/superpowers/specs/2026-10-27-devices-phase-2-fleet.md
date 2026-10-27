# Devices, phase 2 — device fleets on Ephemeral AI VMs

Status: approved by the owner on 2026-10-27 (product decisions delegated to the builder).
Builds on `2026-10-27-devices-phase-1-core.md`; spike facts in
`docs/superpowers/research/2026-10-27-devices-spikes.md`.

## 1. Intent

The owner wants many agents testing on devices at once — e.g. 100 concurrent Android emulators —
without overloading the Orquester host. Phase 2 turns device hosts into an elastic **device
pool**: Android emulators spill from the host onto rented Linux boxes with KVM, iOS simulators
pack densely onto Mac hosts, hosts start fast from caches, and the owner controls the budget and
sees the whole fleet at a glance.

## 2. Goals

1. **Linux device-host boxes for Android** on Blacksmith x64 Linux runners (KVM documented by
   Blacksmith; confirmed by the spike). The Blacksmith adapter gains box kind `linux` for device
   hosts (runner labels, prices, `linux-x64` `orq-agent`, the KVM udev step).
2. **`orq-agent` reports KVM** (`sys.info` gains `kvm: boolean`); a Linux device-host box
   without a usable `/dev/kvm` fails its `devices` setup step at once, and the provider/size is
   remembered as unusable for Android.
3. **Pool scheduler** (`apps/daemon/src/devices/pool.ts` with a pure `decidePool`):
   placement local-first up to local capacity, then best-fit onto ready pool hosts, then scale up
   ahead of demand; scale down idle hosts after `idleTeardownMinutes`; keep `minWarmHosts`
   per platform; hard caps `maxHosts` and `maxHourlyUsd`; requests above the cap wait up to
   `capacityWaitSeconds` (default 120) then fail with `DEVICE_CAPACITY`.
4. **Placement modes** in Settings: `local-only`, `prefer-local` (default), `pool-only`.
5. **Budget approval once**: Settings → Devices → Fleet holds provider, size, caps and a
   "Rent device hosts without asking" switch; within the budget no cards; outside it a `spend`
   card per host (new `devices` spend family).
6. **Fast host start**: the device-host workflow restores caches before `orq-agent` starts —
   Android SDK + system image + AVD golden snapshot (Linux), npm tool installs (both), iOS
   agent-device XCTest runner DerivedData keyed on the Xcode build (macOS). A separate
   "warm the cache" dispatch saves them (normal device-host runs only restore, because destroy
   cancels the run). Settings shows cache state and a "Warm caches" button.
7. **iOS density with simslim** on Mac hosts: pinned simslim installed in the box; leases create
   simulators in a dedicated device set, slim them before first boot (`simslim on` while shut
   down), verify (`simslim verify --json`), and admit new simulators only while `simslim top
   --json` shows memory headroom. `maxSimulatorsPerHost` becomes computed (24 GB host: ~8 slim).
   A small pool of pre-slimmed shut-down simulators per host keeps `open_device` fast.
8. **Android density**: read-only snapshot clones, 720×1280 @320 dpi for pool hosts, animations
   off; emulators per host from the spike's measured numbers (`perHostCapacity` per size).
9. **Fleet view**: a "Devices" server-level view (next to Knowledge) with a thumbnail grid of all
   leased devices (≈1 fps JPEG thumbnails via the hub's screenshot endpoint, never full video),
   grouped by host, showing chat, agent, controller, last action and cost; click opens the device
   in its chat's panel; per-host cards with utilization, $/h, uptime, Destroy/Drain.
10. **Host loss handling**: link drop → leases `suspended` (devices keep running); reconnect →
    `ready`; box gone → `lost`, the scheduler replaces capacity, the agent's next call gets
    `DEVICE_LOST` naming `open_device`.
11. **Main-host protection**: box-hosted devices run nothing heavy on the host (no emulator,
    ffmpeg or agent-device daemon); only viewed streams are relayed; thumbnails cost ~20 kbit/s.
    The relay caps full-video viewers per client (4) and shows "Paused — focus to resume" beyond.

## 3. Non-goals

AWS/GCP/Azure adapters, redroid, Cuttlefish, GPU encode, direct-to-box WebRTC (the relay is
enough for watched streams; revisit if relay CPU measures high).

## 4. Data and contracts

- `packages/api/src/devices.ts`: `DevicePoolSettings`, `DevicePoolSummary` (hosts, capacity,
  utilization, $/h, queue), `DeviceHostSummary.pool` fields, events `devices.pool`.
- `packages/config/src/devices.ts`: pool settings (tolerant), per-provider/size capacity table
  learned at runtime (`learnedCapacity`), cache state.
- `packages/api/src/box-protocol.ts`: optional `kvm` on the system info response (additive).
- `packages/api/src/boxes.ts`: Blacksmith sizes for `linux`, `BoxPurpose` `device-host` already
  exists from phase 1.
- `packages/api/src/agent-chat/tool-approvals.ts`: `devices` spend family.

## 5. Workflow template changes

`apps/daemon/src/boxes/github/workflow-template.ts`:
- inputs gain `os` (`macos|linux`) and `prepare` (`none|devices`); the `orq-agent` download picks
  `darwin-arm64` or `linux-x64`;
- Linux runs a KVM udev step; both run `actions/cache/restore` for the device caches when
  `prepare=devices`;
- a second workflow file `orquester-device-cache.yml` builds and saves caches
  (`actions/cache/save`).
- The control repo's workflow files are re-committed when their content hash changes, at
  box-create time (old orgs pick up new inputs without re-running setup).

## 6. Verification

- `decidePool` table tests (placement, scale up/down, caps, warm minimum, host loss).
- Workflow template snapshot tests; cache key tests.
- orq-agent `kvm` probe test (Go).
- simslim command builder + JSON parser tests (fixtures from the spike).
- Live: one Blacksmith Linux device host started from cache, N emulators leased by N chats,
  streams viewed, host drained and destroyed; one Mac host with slim simulators.
