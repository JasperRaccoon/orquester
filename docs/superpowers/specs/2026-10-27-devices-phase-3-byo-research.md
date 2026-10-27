# Devices, phase 3 — your own machines, more device models, real iOS VMs

Status: approved by the owner on 2026-10-27 (product decisions delegated to the builder).
Builds on phases 1 and 2.

## 1. Intent

Rented hosts are convenient but cost money per hour. Owners with an always-on Mac mini or Linux
server should pair it once and use it as a device host for free. Devices should look like the
exact phone being simulated, Android foldables included. For work that needs a real iOS kernel
(device-only APIs, entitlement behaviour), an owner's bare-metal Mac can run vphone-cli virtual
iPhones as an opt-in research host.

## 2. Goals

### 2.1 Bring-your-own hosts (`byo` box provider)

1. A new box provider `byo` (Ephemeral AI VMs) with kinds `linux` and `macos`, price 0, no
   deadline. "Add your machine" in Settings shows a one-line pairing command
   (`curl -fsSL <daemon>/api/boxes/pair/<one-time code> | sh`) valid for 30 minutes; the
   bootstrap token is single-use and exchanged for the box credential on first connect.
2. `orq-agent install-service`: Linux installs a systemd service (root) or user service; macOS
   installs a **per-user LaunchAgent** in the logged-in Aqua session (`~/Library/LaunchAgents/
   dev.orquester.agent.plist`, `RunAtLoad`, `KeepAlive`), because Simulator, ScreenCaptureKit
   and HID need the GUI session. `orq-agent uninstall-service` removes it.
3. Lifecycle: a BYO box is `ready` while connected, `offline` otherwise (never "destroyed" by the
   reconciler); "Remove" sends `agent.shutdown` + `uninstall-service` and revokes the credential.
4. BYO boxes can be used as device hosts (Mac → iOS, Linux with KVM → Android) by the pool with
   the highest placement priority after the local host (free), and as project/temporary boxes
   like any other box. A BYO host's capacity comes from its own readiness probe.

### 2.2 More realistic device models

1. Apple: add models for the devices published on apple.com (iPhone 17, iPhone Air, iPhone 17e,
   iPad Air, iPad A16) through `scripts/convert-device-model.py`, with `sources.json` entries
   (URL + SHA-256), and simulator-name matching.
2. Samsung: official GLBs from samsung.com (Galaxy S26/S26+/S26 Ultra, Z Fold8, Z Flip8): the
   converter accepts glTF input, decodes Draco, normalizes to the `device-screen` contract, and
   for foldables splits at the hinge into `left-half`/`right-half` with `cover-display` and inner
   displays (the Duo rig contract) so folding animates.
3. Android emulator profiles gain matching skins: Pixel-class AVDs use procedural bodies;
   Samsung-named AVD profiles (`galaxy-s26`, `galaxy-z-fold8`) map to the Samsung models, with
   fold posture control through serve-emu `api/fold`.

### 2.3 vphone-cli research hosts

1. A BYO macOS host may enable **"Virtual iPhones (research)"** in its host settings. Readiness
   checks mirror vphone-ws (vphone-cli found, macOS ≥ 15, not a VM, research guests allowed,
   AMFI state) with exact fix commands; Orquester never changes SIP/AMFI itself.
2. Orquester drives `vphone-cli`/`vphone-launchpad-cli` over the box connection: list, create
   from template (`vm create`), clone `--new-identity` per lease, `vm launch --headless
   --api-listen 127.0.0.1:<port>` with a daemon-held `VPHONE_API_TOKEN` (env, never argv),
   stop, delete. Long jobs stream progress into a `DeviceSetupJob`.
3. Streaming: the daemon pulls frames from `/v1/host/screen` (H.264, `box`, `fps`) through the
   forward and re-emits them to the panel in the same avcc envelope the iOS view already decodes.
4. Input and agent actions map to the vphoned RPC: `input.touch` (normalized), `input.button`,
   `input.type`, `ui.tree`/`ui.tap_element` for snapshots/refs, `screen.screenshot`, `apps.*`,
   `logs.syslog`. `device_action` keeps the same surface; destructive `force` methods are never
   exposed.
5. Clearly labelled "Research — real iOS in a VM; not for App Store apps; Apple's licence terms
   may not allow this use" in Settings and in the device picker.

## 3. Non-goals

Windows device hosts, physical USB devices, redistributing Xcode, automating SIP/AMFI changes.

## 4. Verification

- Pairing: unit tests for the one-time code, single-use token, LaunchAgent/systemd unit
  rendering (Go tests), reconciler never destroying BYO boxes.
- Live: pair this host itself as a BYO Linux box from a separate test appdir and lease an Android
  emulator on it.
- Converter: golden tests on a small fixture GLB (normalization, hinge split).
- vphone: protocol tests against recorded fixtures of the vphoned RPC and screen stream.
