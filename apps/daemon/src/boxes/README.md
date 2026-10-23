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
| `boxes/providers/` | One adapter per provider (`BoxProviderAdapter`), price tables, recorded API fixtures. `vm-providers.ts`, `gpu-providers.ts` and `blacksmith.ts` each export their adapters; `index.ts` assembles the registry. |
| `boxes/bootstrap/` | `BuildBootstrap`: POSIX, PowerShell, container and cloud-init bootstraps that fetch and start `orq-agent`, and the staged POSIX bootstrap for size-capped startup scripts (its generic second stage is served by the hub). |
| `boxes/tailscale/` | `TailscaleKeys` over the Tailscale API (API token or OAuth client); `LocalTailscale` (`local.ts`): this machine's `tailscale` CLI — status, whether `tailscale serve` proxies an HTTPS port to the daemon, and the Connection's "Set up for me". |
| `boxes/github/` | GitHub Actions OIDC verification, the Blacksmith control repo (create, workflow commit, dispatch, cancel), the workflow template. |
| `boxes/service/` | Box records (`boxes.json`, `box-secrets.json`), `BoxRegistry`, the lifecycle and provisioning pipeline, reconciler, costs, project integration (create/list/delete), the plugin's HTTP routes and events. |
| `boxes/broker/` | `AgentTokenBroker` and the refresh-scheduling rules (spec §7). |
| `boxes/sync/` | `BoxConfigSync`, `BoxTranscriptSync`, the box → host approval queue and its routes. |
| `boxes/tooling/` | `BoxToolingProvisioner`: per-target plugin tooling (Better TS Typecheck in boxes). |
| `boxes/remote/` | Routing host features to a box: files, search, uploads/downloads, git runner, terminals, workflows, port forwards, secret files. |
| `agent-host/boxes/` | Agent CLIs in boxes: remote spawn, path mapping, auth wiring per CLI, MCP bridge. |
| `mcp/tools/boxes.ts` | Temporary-box MCP tools and their approval card. |
| `boxes/temporary/` | The box tools' daemon side: the `TemporaryBoxes` seam the service implements (`connect`ed in the daemon wiring), ownership per chat, exec and background jobs, streamed transfers, port forwards, the temporary-box routes, chat-close cleanup. |
| `boxes/wiring.ts` | Every module above put together over the daemon's services for `startDaemon` (build order, the plugin switch gating the hub and the box tools, routes per transport, shutdown), the Template command runner, and the "Run in box" route's wiring. |

Rules every module follows:

- Secrets (agent tokens, git credentials, provider keys, Tailscale keys, Windows passwords) never
  appear in logs, API responses, process arguments, or files in a box. Agent refresh tokens never
  leave the host in any form.
- A box is reached only through `BoxConnection`. No SSH.
- Persist a box record before any provider call that creates something billable.
- Waits use events, receipts or deadlines — never sleeps.

Known behaviour and provider limits:

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
- **Prepared Windows images are unused.** No adapter sets `needsWindowsImage`, so
  `BoxProviderAdapter.prepareWindowsImage` and the settings route that calls it are never reached.
  Every Windows-capable provider bootstraps a fresh box from its startup script. A provider that
  needs one later must also teach the PowerShell bootstrap an install-only mode: the image is
  built without a per-box token, and `buildBootstrap` refuses an empty token.
