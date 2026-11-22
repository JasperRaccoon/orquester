# Your tailnet machines, device simulators on them, and direct SSH for agents

Status: draft for the owner's review (2026-11-22). Nothing here is implemented yet.
Builds on: devices phases 1–3 (`2026-10-27-devices-phase-3-byo-research.md`), the Ephemeral AI VMs
plugin (boxes, BYO machines), and the t3code research in `docs/superpowers/research/`.

## 1. Intent

The owner already has capable machines on their Tailscale tailnet. They should replace rented
VMs wherever possible, for device simulators first and for any other agent work second. Agents
should also reach every box and machine they may use with plain `ssh`, without going through MCP
tools or hand-made tunnels.

Concretely:

- The owner sees every tailnet machine in Orquester and decides, per machine, whether agents may
  use it, and for what.
- Pairing a machine takes one click over SSH instead of a copy-pasted command.
- jasper (Linux, RTX 3080 Ti) hosts Android emulators with GPU acceleration, the Mac hosts iOS
  simulators and Android emulators, and the Windows mini PC hosts one Android emulator on its
  integrated GPU.
- Simulator video goes straight from the machine to the owner's browser when they share a
  network path, not via the daemon in Helsinki. The Mac keeps working when it travels.
- Metro and other dev servers reach simulators running on those machines.
- `ssh orq-<name>` works for agents on every box and every machine they may use.

Rented VMs, the host itself and Blacksmith all stay as they are. This spec only adds options.

## 2. Where things stand today

- **BYO machines exist.** The Ephemeral AI VMs plugin can pair Linux and macOS machines
  (`curl … /api/boxes/pair/<code> | sh`). The machine runs `orq-agent`, which dials the daemon over
  one multiplexed WebSocket. Paired machines get terminals, agent chats, projects, files, git,
  port forwards, desktops (Linux) and device simulators (Mac → iOS, Linux with KVM → Android).
- **Every use needs an approval card.** Each time a chat wants a paired machine, the owner
  approves a "Use your machine" card (`byoMachineCard`, `apps/daemon/src/mcp/tools/boxes.ts`),
  which is `ungrantable` and so cannot be pre-approved.
- **Windows can't be paired.** `BYO_MACHINE_KINDS` is `["linux", "macos"]`
  (`packages/api/src/boxes.ts:118`), although `orq-agent` already builds for Windows and rented
  Windows boxes exist.
- **Own-machine Android uses software rendering only.** `BOX_GPU_MODES.byo` tries only
  `swangle_indirect` and `swiftshader_indirect` (`devices/hosts/box/android-remote.ts`).
- **A Mac maps only to iOS** (`deviceHostOfRecord`, `devices/hosts/box-host.ts`).
- **Agents can't pick a host.** `open_device.host` accepts only research hosts. The panel's
  picker assumes Android runs on the daemon host.
- **Settings are split.** "Use for device simulators" lives on the BYO card in the boxes
  plugin's settings, not in Devices settings.
- **All simulator video passes through the daemon.** The hub binds `127.0.0.1` on the machine,
  the daemon forwards it over the box connection, and the browser streams from the daemon's hub
  proxy.
- **No tailnet discovery.** The daemon only reads its own Tailscale status (`Self`, in
  `boxes/tailscale/local.ts`) and can set up `tailscale serve` with a `sudo -n` fallback. The
  daemon user can already read the full peer list through the LocalAPI socket
  (`/var/run/tailscale/tailscaled.sock` is world-writable on this host).
- **Agents can't SSH to boxes.** Box creation discards the private half of the SSH key it
  generates, the box IP is never stored or returned, boxes are only reachable outbound to the
  daemon, and the agent instructions point at `box_exec`, `box_upload` and `box_download`.
  Agents are **not** OS-sandboxed: they run as the daemon's user with the normal `~/.ssh`.

## 3. The owner's machines

| | jasper | Mac | Mini PC |
|---|---|---|---|
| Tailnet name | `jasper` | `eduards-macbook-pro` | `minipc-desktop-11fqvre` |
| OS | Ubuntu 24.04, KDE on X11 | macOS 26.2 | Windows 10 Pro 22H2 |
| Hardware | Ryzen 9 5900X, 94 GB, RTX 3080 Ti | M4 Max, 36 GB | Ryzen 7 4800U, 6.9 GB usable, Radeon iGPU |
| Role | Android (6–10 emulators) | iOS, plus Android on arm64 | Android (1 emulator), terminals, chats |
| SSH | `jasper@100.92.198.117`, key auth | `mapacho@100.124.210.7`, key auth | `minipc` alias, `user`, key auth |
| Round trip to daemon (Helsinki) | ~191 ms | ~226 ms (Wi-Fi) | ~191 ms |
| Network | LAN 192.168.2.21, WoL on | travels with the owner | LAN 192.168.2.4, WoL on |

Some machine preparation is already done:

- **Mac:** developer mode is on, `xcode-select` points at Xcode, and `simctl` works over SSH.
  Both settings persist across reboots.
- **Mini PC:**
  - Windows Hypervisor Platform is on and the hypervisor is running.
  - Auto-login of `user` into the console session works. The account has no password.
- **jasper:** passwordless sudo exists and ffmpeg is installed.
- **Wake-on-LAN** works in both directions between jasper and the mini PC.

These items remain; Orquester's probes must detect each one and the UI must name the fix:

- jasper:
  - `/dev/kvm` access comes only from the desktop login's ACL. Fix: add `jasper` to the `kvm`
    group.
  - Linger is off, so user services die on logout.
- Mac:
  - The lid sleeps it unless it's in clamshell mode.
  - FileVault needs a physical unlock after a reboot.
- Mini PC: the Radeon driver dates from 2023-03.

## 4. Requirements

### 4.1 Machines registry and visibility

1. **One "Machines" list.** It merges (a) tailnet peers read from the Tailscale LocalAPI
   (`/localapi/v0/status`: hostname, MagicDNS name, OS, online, last seen, tailnet IPs) and
   (b) paired BYO records. A paired machine is matched to its peer by tailnet IP or node key.
   Each entry shows its OS and one state: **not paired**, **pairing**, **ready**, **offline**
   (paired, agent not connected) or **asleep/off** (peer offline).
2. **Discovery needs no setup.** It works whenever `tailscaled` runs on the daemon host. It
   falls back to `tailscale status --json` if the socket is unavailable, and shows a named fix
   if neither works.
3. **Per-machine visibility.** The owner sets this; it is stored on the daemon:
   - **Hidden** (default for every newly discovered peer). The machine does not appear in any
     MCP tool output, agent instructions, device placement, SSH alias or `list_*` result. Only
     the owner sees it, in Settings. Orquester never connects to it.
   - **Ask first.** Visible to agents. Every use by a chat goes through today's approval card.
   - **Free use.** Visible to agents and used without a card.
4. **Per-machine capabilities.** Independent switches: **Device simulators**, **Commands and
   SSH**, **Agent chats and projects**. A capability that is off behaves like Hidden for that
   purpose.
5. **Existing paired machines** migrate to **Ask first** with their current device switch
   carried over, so nothing changes until the owner chooses.
6. **The daemon enforces visibility and capabilities** in every tool, route and placement
   decision. Client checks are presentation only.
7. **Hidden is not a security boundary.** Agents still run as the daemon's user, so `tailscale`
   and `ssh` in bash keep working when the owner explicitly asks for them (for example "tailscale
   ssh into the clinic X PC"). The UI says this in one line and points at Tailscale ACLs for real
   isolation.
8. **New agent tool `list_machines`.** It returns the machines visible to the calling chat: name,
   OS, state, visibility, capabilities, the SSH alias if one exists, and whether the machine can
   be woken.

### 4.2 Pairing: one click over SSH, and Windows

1. **"Pair over SSH"** on any not-paired machine. The daemon connects with the host's SSH setup
   (default `~/.ssh/id_ed25519`). User, port, identity file or an existing `~/.ssh/config` alias
   can be overridden per machine. It then runs the existing pairing bootstrap on the machine with
   the daemon URL pre-filled. Pairing is owner-only; agents cannot pair machines.
2. **Pre-filled daemon URL.** When the machine is a tailnet peer, the URL is the daemon's tailnet
   HTTPS address (§4.7).
3. **Host keys.** Unknown keys are shown for confirmation with their fingerprint. Changed keys
   block pairing with a named error.
4. **Credentials stay out of argv.** No secret goes in process arguments on either side. The
   pairing code travels over stdin.
5. **The pairing run fixes known gaps, or names the fix when it can't:**
   - linger for user services on Linux;
   - `kvm` group membership;
   - OOM protection (§4.9);
   - on the Mac, developer mode and `xcode-select`.

   It uses `sudo -n` where needed and never prompts.
6. **Windows pairing.**
   - Add `windows` to `ByoMachineKind`, with a PowerShell pairing bootstrap (both by SSH and as a
     copy-paste one-liner).
   - `orq-agent` runs as a Windows service for shells, files and forwards.
   - A **desktop-session helper** (`orq-agent` in a helper mode, started by a logon scheduled
     task in the interactive session) is used for anything that needs the GPU or the desktop.
   - Windows path mapping already exists in `box-protocol.ts`.
7. **Removing a machine** uninstalls `orq-agent`, revokes its credential, and removes every key
   or alias Orquester added for it.

### 4.3 Direct SSH for agents

The goal is that `ssh orq-<name>` (and `scp`, `rsync`, `git push`, `docker -H ssh://`) works
from any agent's bash, for every box the chat owns and every machine it may use. There is no MCP
middleman and no public IP or open inbound port. All traffic goes through the daemon's existing
connection to `orq-agent`. Codex always runs in full access, so no Codex-specific transport is
needed.

#### Phase 1: tunnel to the machine's own sshd

1. **Key.** When a chat's box becomes ready, or a machine is lent to a chat, the daemon generates
   an ed25519 key for that chat and box. It is stored under the thread directory (`ssh/`, 0700,
   key 0600), using a new path helper in `packages/config`.
2. **Authorization.** The daemon appends the public key to the work user's `authorized_keys` over
   the box connection, with `expiry-time="<deadline>"` and the comment
   `orquester chat=<id> box=<id>`.
3. **Host key.** The daemon reads the machine's sshd host key over the box connection and writes a
   pinned `known_hosts` entry under `HostKeyAlias orq-<name>`. There is never a trust-on-first-use
   prompt.
4. **SSH config.** The daemon writes `~/.ssh/orquester/<name>.conf` (`Host orq-<name>`, `User`,
   `IdentityFile`, `IdentitiesOnly yes`, `UserKnownHostsFile`, `HostKeyAlias`) with a
   `ProxyCommand` that pipes stdin/stdout through the daemon (a small helper that connects to a
   daemon Unix socket, which opens `openTcp(22)` on the box). `~/.ssh/config` gets one
   `Include ~/.ssh/orquester/*.conf` line. This is **opt-in** in Settings because that file is the
   owner's. Without the Include, agents can use `ssh -F ~/.ssh/orquester/<name>.conf orq-<name>`.
5. **Tool output and instructions.** `create_box`, `list_boxes` and `list_machines` return the
   alias. The agent instructions (`session-tools/instructions.ts`) and the `create_box`
   description change from "use `box_exec`/`box_upload`/`box_download`" to "use
   `ssh orq-<name>`". The MCP box tools stay available.
6. **Revocation:**
   - box destroyed or past its deadline: delete the config and key (hook where forwards already
     close);
   - chat closed: delete the thread's `ssh/` directory;
   - machine handed back, set to Hidden, or capability turned off: also remove the tagged
     `authorized_keys` line;
   - `expiry-time` is the backstop if cleanup fails.
7. **Free-use machines** get a machine-level alias (`orq-jasper`) that every chat may use while
   the machine stays Free use with Commands and SSH on. It is revoked as soon as either changes.
   Ask-first machines get their alias only for the approved chat and only until release.
8. **Box-project chats** (the agent CLI runs inside a project box) need the per-chat key and
   config in the box's work home, with the tunnel through `orq-agent`'s host channel. This is a
   documented exception to "no secrets in box files": the key opens only that chat's own box or
   machine and expires with it.
9. **Docs.** Rewrite the "A box is reached only through `BoxConnection`. No SSH." rule in
   `apps/daemon/src/boxes/README.md` and the discarded-key comment in `boxes/contracts.ts`.

Phase 1 covers the cloud VM providers and paired Linux machines and Macs with sshd enabled. It
does not cover GPU container providers (vast.ai, RunPod, Fly and similar), Blacksmith macOS
runners, Windows boxes or machines with SSH off.

#### Phase 2: an SSH server inside `orq-agent`

1. **Embedded server.** `orq-agent` embeds an SSH server (`golang.org/x/crypto/ssh`). It **listens
   on no network port**. It is reachable only as a new `ssh` channel type over the existing
   WebSocket (`packages/api/src/box-protocol.ts`, `boxes/contracts.ts`). The ProxyCommand opens
   that channel instead of `openTcp(22)`, so agents see no difference.
2. **Supported features:**
   - interactive shells with a PTY (creack/pty on Unix, ConPTY on Windows, both already in
     `orq-agent`);
   - exec, exit codes, signals and environment;
   - the SFTP subsystem (scp and sftp);
   - `direct-tcpip` (`ssh -L`);
   - commands run as the box's work user;
   - `rsync` works through exec when installed on the machine.
3. **Authorized keys** are pushed by the daemon over the connection and held in memory only.
   Nothing is written to `authorized_keys`, so revocation is immediate and leaves nothing behind
   on the owner's machines.
4. **Host key.** `orq-agent` generates a persistent host key, reports it to the daemon, and the
   daemon pins it.
5. **Routing rule.** Use the built-in server whenever the box's `orq-agent` supports it. Use
   Phase 1 (real sshd) only for agents too old to support it. Once Phase 2 ships it is the main
   path everywhere, and Phase 1's `authorized_keys` writes become the fallback.
6. **Coverage:** containers, Blacksmith macOS runners, Windows boxes and machines, and machines
   without sshd.

### 4.4 Device simulators on the owner's machines

1. **GPU modes on own machines.**
   - Linux: try `-gpu host` first when the probe finds a usable GPU (NVIDIA or Mesa with direct
     rendering on jasper), then fall back to the current software modes.
   - The golden snapshot records the mode it was made with (already supported).
2. **Android on Apple Silicon.** A Mac can host Android emulators (arm64-v8a system images,
   Hypervisor.framework) as well as iOS. The SDK download, executor and probes must support
   macOS arm64. Today they assume Linux x86_64 with `/proc`, `setsid` and `apt`.
3. **Windows Android host.** This needs:
   - the Windows SDK and emulator with the WHPX check (`emulator -accel-check`);
   - launching through the desktop-session helper (§4.2) so `-gpu host` uses the Radeon iGPU;
   - an `-gpu angle_indirect` attempt from the service session first (if it renders on hardware,
     the helper is optional);
   - a capacity computed from free RAM (one emulator on the mini PC, `-memory 1536`, lean
     `google_apis` x86_64 image).
4. **Capacity per host** comes from the probe (CPU, free RAM, disk, KVM/WHPX), not fixed numbers.
5. **Agents choose a host.**
   - `open_device` accepts any visible host id (not only research hosts).
   - `list_devices` lists hosts with machine name, platform support, capacity and state.
   - Placement still picks automatically when no host is given.
   - Hidden machines and machines with Device simulators off are never placed on.
6. **The panel's picker** groups devices by host and stops assuming Android runs on the daemon
   host. A ready jasper must never show "needs setup" because the local host isn't set up.
7. **One place for settings.** The per-machine device switch moves to Devices settings (and the
   Machines list), with placement preference ordering own machines before rentals.
8. **Probes report environment problems with the exact fix:**
   - KVM permission;
   - missing linger;
   - Xcode path;
   - developer mode;
   - an asleep Mac;
   - no desktop session on Windows.

### 4.5 Direct route for simulator video

1. **Route list.** Each device host has an ordered list of routes for the stream:
   1. **Direct over the tailnet:** the machine's own HTTPS name via `tailscale serve` on the
      machine (valid certificate, so no mixed-content block from an HTTPS Orquester origin).
      When the browser and machine share a LAN, Tailscale itself uses the LAN path.
   2. **Direct over the LAN:** only where the client can load plain `http`/`ws` from a LAN
      address (desktop app).
   3. **Via the daemon:** today's hub proxy, always available.
2. **Tickets.** The daemon issues a short-lived, host- and device-scoped ticket. The browser
   presents it to the machine's hub, so the hub token never leaves the daemon. The hub must accept
   tickets on its tailnet-facing listener and keep the existing allowlist of proxied paths.
3. **Identity check first.** Before sending a ticket, the client checks the route's public
   identity endpoint, which must return the expected machine id. An address now held by another
   device never receives a ticket.
4. **Roaming.** The client re-evaluates routes on network change, on app resume, and every 60 s
   while on a slower route, with a cooldown to avoid flapping. When the Mac leaves home, the LAN
   path drops, Tailscale finds the new path, and the stream falls back to the daemon route if
   direct fails. Probe timeouts are short for LAN and longer for tailnet paths behind DERP.
5. **Fallback is invisible to agents.** Agents keep using screenshots and actions through the
   daemon. Only the human's viewer switches routes.

### 4.6 Metro and dev servers for remote simulators

1. **Metro forwarded automatically.** When a device opens for a chat whose project runs Metro,
   the device machine gets a listener on `localhost:8081` that pipes back to the project's Metro
   through `orq-agent`'s host channel.
   - iOS simulators use the Mac's `localhost` directly.
   - Android emulators get `adb reverse tcp:8081 tcp:8081`.
2. **Other ports.** An agent tool (and a UI control) adds further ports (for example an API on
   3000) for the device's lifetime.
3. **Cleanup.** Forwards close when the device closes, the chat ends or the machine is released.

### 4.7 Tailscale integration on the daemon host

1. **Tailscale HTTPS for web clients.** Settings → Server shows the daemon's tailnet HTTPS URL
   (`https://<host>.ts.net:<port>`) with a QR code, alongside the existing HTTP setting. It uses
   the existing "set up for me" `tailscale serve` path.
2. **No sudo for serve.** Setup offers `tailscale set --operator=<daemon user>` once, so later
   `serve` changes need no `sudo`.
3. **Self-repair of the serve route.** Every 30 s the daemon checks that its route exists and
   points at its live port, and recreates it if not. It never takes a route another live app
   owns, and on disable removes only its own route.
4. **Sharing dev-server previews.** A project port can be shared as
   `https://<host>.ts.net:<port>` from the UI or by an agent tool. Shared ports are tracked,
   listed and removed when the chat closes or the port stops listening. The same ownership rules
   as item 3 apply.
5. **Tailnet address detection.** Anywhere Orquester labels an address as tailnet (route lists,
   connection diagnosis, host stats), it identifies Tailscale by interface name (`tailscale*`,
   `utun` with a Tailscale address) or the `fd7a:115c:a1e0::/48` prefix, not by 100.64.0.0/10
   alone.

### 4.8 Wake-on-LAN

1. **Learning the details.** On pairing (and refreshed while connected), `orq-agent` reports each
   wired NIC's MAC, its LAN subnet and broadcast address, and whether wake-on-magic-packet is
   enabled.
2. **Sending the wake.** The daemon asks another connected machine on the same subnet (or the
   daemon host itself if it is on that LAN) to send the magic packet. jasper and the mini PC wake
   each other today.
3. **Where it's offered.**
   - The UI shows **Wake** on asleep machines that have a sender.
   - Agents get `wake_machine` for Free-use machines. Ask-first machines get it inside the
     approval flow.
   - After a wake, the machine's state follows its tailnet and `orq-agent` reconnection.

### 4.9 Reachability: OOM protection

1. **Linux only.** On paired Linux machines and rented Linux boxes, `tailscaled`, `sshd` and
   `orq-agent` get systemd drop-ins with a strongly negative `OOMScoreAdjust`, so the kernel's
   OOM killer never picks them.
2. **When it's applied.** Box bootstrap applies it (root). BYO pairing applies it with `sudo -n`,
   or reports the named fix when sudo isn't available.
3. **macOS and Windows** have no equivalent risk and are skipped.

### 4.10 Errors that name the fix (cross-cutting)

Every failure in this spec is classified into a stable code. Its message says which machine needs
the fix and gives it, for example:

- `tailscale set --operator=orquester`;
- enable HTTPS certificates in the tailnet admin;
- host key changed for jasper;
- SSH login refused;
- add jasper to the `kvm` group;
- the Mac is asleep;
- no desktop session on the mini PC.

Raw stderr is never logged where it may contain keys or `tskey-` values.

## 5. Agent-facing surface, summarized

**New tools:**
- `list_machines`
- `wake_machine`
- a port-forward tool for device machines
- a preview-share tool

**Changed tools:**
- `create_box` and `list_boxes`: return SSH aliases.
- `open_device`: accepts any visible host.
- `list_devices`: shows hosts.
- Approval for Ask-first machines is unchanged.

**Instructions.** Session instructions say: use `ssh orq-<name>` for boxes and machines; Hidden
machines are never mentioned. Every tool filters by visibility and capability on the daemon.

## 6. UI summary

- **Machines.** A Machines section lists discovered and paired machines with:
  - state and OS;
  - visibility (Hidden / Ask first / Free use);
  - capability switches;
  - Pair over SSH;
  - Wake;
  - Remove.
- **Devices settings.** Lists device hosts, their placement order and probe problems with fixes.
- **Server settings.** Adds the tailnet HTTPS URL and QR code.
- **Device panel.** Groups by host and shows the active stream route (direct or via the daemon).
- **Settings → Agents** (or SSH). Toggles the opt-in `Include` line for `~/.ssh/config`.

## 7. Security

1. **Machine-side credentials are revocable.** The `orq-agent` credentials, per-chat SSH keys and
   hub tickets are all revocable. Keys expire with their box or lease, and Phase 2 keeps
   authorized keys in memory only.
2. **Visibility and capabilities** are enforced on the daemon.
3. **Agents run as the daemon's user** and can read `<appdir>`, and the daemon's box relay
   sockets are unauthenticated. This spec does not change that. Per-chat scoping of keys and
   aliases is therefore bookkeeping and cleanup, not isolation.
4. **jasper has passwordless sudo**, so a chat with SSH on jasper is effectively root there. The
   Machines UI notes this for machines where the probe finds it.
5. **The mini PC auto-logs in with no password.** Remote access is key-only (SSH) or uses
   RustDesk's own password.
6. **Direct stream routes** accept only short-lived tickets after an identity check, and never
   expose the hub's shell or exec routes.
7. **No change to tailnet ACLs.** The daemon never edits the tailnet policy.

## 8. Not included

- Removing or changing rented VMs, the host backend or Blacksmith.
- A pure-SSH device backend with no `orq-agent` (t3code's model). `orq-agent` stays the only
  transport, and SSH is used only to install it.
- Editing Tailscale ACLs, or Tailscale SSH as the agent SSH mechanism.
- SSH certificates from an Orquester CA, or a restricted ssh-agent for agents. Not needed with
  Phase 2.
- Opening port 22 on public IPs.
- t3code ideas not chosen:
  - peer links between daemons;
  - pairing QR links for clients;
  - load-balancing chats across machines;
  - a bind policy;
  - exit-node diagnosis;
  - Tailscale `whois` device labels;
  - a non-interactive setup CLI.
- An OS sandbox for agents.

## 9. Delivery order

1. Agent SSH Phase 1 (§4.3).
2. Machines registry, visibility and capabilities, `list_machines` (§4.1).
3. Pair over SSH with OOM protection and the probe fixes (§4.2 items 1–5, §4.9, §4.10).
4. Device gaps: GPU host mode, host choice for agents, picker, settings move, Metro (§4.4 items
   1, 4–8, §4.6).
5. Direct stream route with roaming (§4.5), plus daemon Tailscale HTTPS, operator setup and
   self-repair (§4.7 items 1–3).
6. Agent SSH Phase 2 (§4.3).
7. Android on Apple Silicon (§4.4 item 2).
8. Windows pairing and the Windows Android host on the iGPU (§4.2 item 6, §4.4 item 3).
9. Preview sharing, tailnet address detection and Wake-on-LAN (§4.7 items 4–5, §4.8).

## 10. To verify during implementation

- Whether `-gpu angle_indirect` renders on the Radeon from the Windows service session. This
  decides whether the desktop-session helper is required.
- Whether `tailscale serve` can be driven unattended on each machine type: Linux needs operator
  rights, the Mac has the App Store variant with the CLI inside the app bundle, and Windows is
  untested.
- Whether `simctl io` screenshots and video work over `orq-agent` on the Mac without a Screen
  Recording grant.
- Whether arm64 Android system images boot headless with acceleration on the M4 Max through the
  existing hub.
- Matching a BYO record to a tailnet peer when a machine has several tailnet IPs or was
  re-authenticated (node key changes).

## 11. Acceptance checks

1. A new tailnet peer appears in Machines as Hidden. No agent tool mentions it. An agent can still
   `tailscale status` in bash.
2. jasper set to Free use with Device simulators on: an agent opens an Android device on jasper
   without an approval card. It renders with `-gpu host`, and the owner's browser on the tailnet
   streams directly from jasper.
3. The Mac set to Free use: an iOS simulator opens on it. Taking the Mac off the home network
   keeps the stream working through a fallback route without a reload.
4. A React Native app on the simulators on jasper and the Mac loads its bundle from the project's
   Metro.
5. After `create_box`, the agent runs `ssh orq-<box>`, `scp` and `rsync` with no extra steps.
   After `destroy_box`, the alias, key and `authorized_keys` line are gone. With Phase 2 the same
   works on a vast.ai container and a Windows box.
6. Pair over SSH pairs jasper, the Mac and the mini PC with one click each.
7. The mini PC runs one Android emulator on its Radeon iGPU.
8. Wake on an asleep jasper powers it on through the mini PC, and it returns to ready.
9. Killing memory on a Linux box never takes down `tailscaled`, `sshd` or `orq-agent`.
10. Settings → Server shows the tailnet HTTPS URL and QR code. Breaking the serve route is
    repaired within 30 s.
