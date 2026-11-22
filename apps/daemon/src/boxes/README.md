# Ephemeral AI VMs ("boxes") — daemon module map

Spec: `docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md`.
Contracts: `packages/api/src/boxes.ts` (HTTP/UI), `packages/api/src/box-protocol.ts`
(daemon ↔ `orq-agent` wire), `packages/config/src/boxes.ts` (stores), and
`contracts.ts` here (seams between the modules below). Test doubles: `testing.ts`
(`localBoxConnection()` runs "box" operations on this machine).

| Module | Owns |
|---|---|
| `apps/box-agent/` | `orq-agent`, the program in every box: dials the daemon, serves channels and requests, detached processes, forwards, file transfer. Written in Go (PTY and ConPTY without native addons), cross-compiled per platform by `pnpm --filter @orquester/box-agent build`; `fixtures/*.json` keep its wire types in step with `box-protocol.ts`. |
| `boxes/hub/` | The connect WebSocket route, box authentication (bootstrap token, box credential, GitHub OIDC via `VerifyGithubOidc`), the `BoxHub`/`BoxConnection` implementation, per-box local relay sockets (`boxSocketPath`), serving `orq-agent` builds and the staged bootstrap's second stage. |
| `boxes/client/` | A `BoxConnection` over a relay socket, for the agent host and other local processes (static imports only — agent-host rule). |
| `boxes/providers/` | One adapter per provider (`BoxProviderAdapter`), price tables, recorded API fixtures. `vm-providers.ts`, `gpu-providers.ts` and `blacksmith.ts` each export their adapters; `byo.ts` is the owner's own machines (no calls, price 0, offers built from the records); `index.ts` assembles the registry. |
| `boxes/bootstrap/` | `BuildBootstrap`: POSIX, PowerShell, container and cloud-init bootstraps that fetch and start `orq-agent`, and the staged POSIX bootstrap for size-capped startup scripts (its generic second stage is served by the hub). Linux VMs (root, systemd) give `tailscaled` and `orq-agent` `OOMScoreAdjust` drop-ins (`orquester-oom.conf`). The BYO pairing script also probes and fixes the owner's machine with `sudo -n` only (linger, `/dev/kvm`, OOM protection; developer mode and Xcode on macOS); `byoUnpairCleanupScript` removes its drop-ins again. Windows machines get a PowerShell pairing script (`irm … \| iex` in an elevated PowerShell, or over SSH on stdin): the OrqAgent service (LocalSystem) plus the desktop-session helper's logon task, probing WHPX and the desktop session; no OOM protection there. |
| `boxes/tailscale/` | `TailscaleKeys` over the Tailscale API (API token or OAuth client); `LocalTailscale` (`local.ts`): this machine's `tailscale` CLI — status, serve routes, the operator grant, serve changes with the `sudo -n` fallback, and the Connection's "Set up for me". One instance is made in `startDaemon` and shared with the daemon-level `src/tailnet/` service (Settings → Server's tailnet address, its 30 s repair, shared previews). |
| `boxes/github/` | GitHub Actions OIDC verification, the Blacksmith control repo (create, workflow commit — re-committed at box create when a template changed —, dispatch, cancel), the workflow templates (`orquester-box.yml` for macOS and Linux boxes, `orquester-device-cache.yml`), and `device-cache.ts`: device-host box paths, cache keys and the cache-building scripts the device service shares. |
| `boxes/service/` | Box records (`boxes.json`, `box-secrets.json`), `BoxRegistry`, the lifecycle and provisioning pipeline, reconciler, costs, project integration (create/list/delete), the plugin's HTTP routes and events. `byo.ts`: bring-your-own machines — pairing codes (the hub's `pair` route serves their script), pairing over SSH (`addForSsh`, driven by `machines/pairing/`), removal, lending a machine to a project or chat. |
| `boxes/broker/` | `AgentTokenBroker` and the refresh-scheduling rules (spec §7), `getLentToken` for lends, and the refresh-token-free login files a box gets (`credentials.ts`). |
| `boxes/lends/` | Lending managed accounts to a box (spec `2026-11-03-lend-accounts-to-boxes-design.md`): `service.ts` (records on `StoredBox.accountLends`, resolving names, preview, all-or-nothing install, every way a lend ends, cleanup on the box), `keeper.ts` (one lend's login kept current from the host), `routes.ts` (`accountLendRoutes`, both transports). |
| `boxes/sync/` | `BoxConfigSync`, `BoxTranscriptSync`, the box → host approval queue and its routes. |
| `boxes/tooling/` | `BoxToolingProvisioner`: per-target plugin tooling (Better TS Typecheck in boxes). |
| `boxes/remote/` | Routing host features to a box: files, search, uploads/downloads, git runner, terminals, workflows, port forwards, secret files. Also what a box asks the host for: git over the restricted SSH agent (`git-auth.ts`) and the GitHub CLI's API requests, forwarded with the account's token (`gh-api.ts`). |
| `agent-host/boxes/` | Agent CLIs in boxes: remote spawn, path mapping, auth wiring per CLI, MCP bridge. |
| `mcp/tools/boxes.ts` | Temporary-box MCP tools and their approval card. |
| `boxes/temporary/` | The box tools' daemon side: the `TemporaryBoxes` seam the service implements (`connect`ed in the daemon wiring), ownership per chat, exec and background jobs, streamed transfers, port forwards (for a box project's chat, listeners in its own box: `project-forwards.ts`, the hub's one `host-tcp` handler and owner of every box's forward list), the temporary-box routes, chat-close cleanup. |
| `boxes/agent-ssh/` | Direct SSH for agents (spec `2026-11-22-tailnet-machines-and-agent-ssh-design.md` §4.3): `orq-<name>` aliases per chat and box (and machine-level ones for Free-use machines, `MachineSshAccessPort`), their keys, `~/.ssh/orquester/<name>.conf` and pinned `known_hosts`, the Phase 1 `authorized_keys` lines and the Phase 2 `ssh.keys` push, the proxy socket (`sshProxySocketPath`) behind every alias's ProxyCommand (`ssh-proxy-helper.mjs`, plain Node), the copies in a box project's own box, revocation, and the opt-in `Include` line in `~/.ssh/config`. |
| `boxes/wiring.ts` | Every module above put together over the daemon's services for `startDaemon` (build order, the plugin switch gating the hub and the box tools, routes per transport, shutdown), the Template command runner, and the "Run in box" route's wiring. |

Rules every module follows:

- Secrets (agent tokens, git credentials, provider keys, Tailscale keys, Windows passwords) never
  appear in logs, API responses or process arguments, nor in files in a box, with one exception: a
  box's login file (a Claude chat's, or a lent login's, mode 0600) holds a short-lived ACCESS token,
  and anything on that box can read it until it expires. Agent refresh tokens and id tokens never
  leave the host in any form: a Codex login's id token is synthetic. Files we write on a box carry
  `lentBy: "orquester"`; neither a chat nor a lend overwrites or removes a login or account index
  that is not ours (`isOwnBoxLogin`, `BOX_LOGIN_IN_USE`, `LEND_APPDIR_IN_USE`). Each check and its
  write are separate box requests, so a process on the box writing in between is not excluded.
  A second exception is agent SSH in a box project (`agent-ssh/`): a chat whose CLI runs in a
  project box gets its private keys for its own temporary boxes and lent machines (0600, under the
  work user's `~/.ssh/orquester/`), so `ssh orq-<name>` works there too. Each key opens only that
  chat's own box or machine, through the daemon, and stops working when the alias is revoked (box
  destroyed or given back, deadline, chat closed); the files are removed then, or at the project
  box's next connect.
- A box is reached only through `BoxConnection`; the daemon never opens SSH to a box. Agents' SSH
  (`ssh orq-<name>`, scp, rsync from their bash) is tunnelled through that same connection: the
  alias's ProxyCommand talks to the daemon's proxy socket, which opens an `ssh` channel to
  orq-agent's built-in server (capability `ssh-server`, Phase 2: its keys are pushed with `ssh.keys`
  and held in memory only) or, for an orq-agent without one, `openTcp(22)` to the box's own sshd
  (Phase 1: one tagged `authorized_keys` line per alias, with an `expiry-time` backstop). Host keys
  are pinned from the connection (never trust-on-first-use). No box gets a public SSH port for it.
- Persist a box record before any provider call that creates something billable.
- Waits use events, receipts or deadlines — never sleeps.

Known behaviour and provider limits:

- **Bring-your-own machines are never destroyed.** A `byo` record is the owner's machine: `pairing`
  until its one-time command ran, then `ready` while `orq-agent` is connected and `offline`
  otherwise. A project or an approved chat borrows it (the record takes their purpose); "destroy"
  releases it back to `purpose: "machine"`. Only "Remove machine" deletes the record (after
  `agent.shutdown` with `uninstall`). A project on one needs the host paths creatable there
  (root or passwordless sudo on macOS), like any box.
- **Wake-on-LAN goes through another paired machine.** A box connection carries the NICs
  `orq-agent` reports (hello `nics`, then `sys.nics`); the machines registry keeps a paired
  machine's wired ones in `machines.json`, so they are known while it sleeps. A wake is a
  `net.wake` to a connected machine on the same subnet whose `orq-agent` lists `wake-sender`;
  orq-agent broadcasts only onto its own interfaces' broadcast addresses (`machines/wake.ts`).
- **A Windows machine has two sessions.** `orq-agent` runs as the LocalSystem service OrqAgent
  (session 0: shells, files, forwards); programs that need the desktop or the GPU run through the
  desktop-session helper (`orq-agent desktop-helper`, a logon scheduled task in the desktop user's
  session) with exec `session: "desktop"`. `desktop-session` is in `hello.capabilities` while the
  helper is installed, connected or not (hello is sent once per connection, and the helper usually
  signs in after the service connected); such an exec waits briefly for the helper, starts its task,
  and otherwise fails with `NO_DESKTOP_SESSION` naming the cause. Removing the machine ends and
  deletes the task, the service and, once `orq-agent` exited, `C:\orq\agent`.

- **Plugin MCP servers run in the box.** A box chat's MCP servers from the account config, a
  profile's server list and Orquester's own tools are planned per server (bridged to the host or
  "Run in box"). Servers that an installed agent plugin declares are started by the CLI from the
  plugin's own files, so in a box chat they run inside the box, with the box's network, tools and
  environment.
- **Thunder Compute cannot rent boxes.** Its create call takes no startup script, user data,
  env or name, so `orq-agent` cannot start unattended (`kinds` is empty). The provider can still
  be connected, priced and cleaned up.
- **TensorDock is Linux + GPU only.** Its Windows image runs no first-boot script and there is
  no snapshot API for a prepared image.
- **Scaleway and UpCloud offer no Windows boxes.** Their Windows images run no cloud-init or
  first-boot script; the only automation path is SSH.
- **Windows boxes bootstrap directly.** Every Windows-capable provider uses its startup script;
  no provider needs a prepared image.
