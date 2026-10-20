# Ephemeral AI VMs — projects and agent work on rented cloud boxes

Status: draft, awaiting the owner's approval. Builder check done 2026-10-19; its questions are answered in the text or listed in §17.

Research inputs (2026-10-19): a code survey of the plugin system, project creation, the agent
host and its adapters, agent accounts and token refresh, and the file/git/workflow/desktop
subsystems; t3code's remote-environment design; the retired model proxy
(`apps/daemon/src/model-proxy-retirement.ts`, commit `b72cefb2`); web research on credential
proxies (CLIProxyAPI and others), each agent CLI's auth and remote-execution options, Blacksmith
and GitHub Actions, connectivity (Coder, VS Code tunnels, Zed, DevPod, Tailscale), and ~60 VM
and GPU providers. The owner's Grok conversation on cheap pay-as-you-go boxes is the starting
point. Facts marked **(unverified)** were not confirmed on an official page and must be checked
by the spike or adapter work that depends on them.

## 1. Intent

The owner's PC or Mac is often overloaded, and the Orquester host is one machine. The owner wants
an AI coding agent to be able to work on its own rented box — exclusive compute, sometimes a
GPU — and to test apps on Windows and macOS without keeping those machines on.

A new built-in plugin, **Ephemeral AI VMs**, adds two things:

1. **Project boxes.** When creating or cloning a project, the owner can choose where it runs:
   this host (the default) or a new box from a configured provider (Linux, Linux + GPU,
   Windows, Windows + GPU, macOS). The project's files, terminals, git, builds, dev servers and
   agent CLIs all run in the box. The box lives as long as the project and is destroyed when
   the project is deleted.
2. **Temporary boxes for agents.** Any agent chat can rent a box for a task through Orquester
   MCP tools — for example, from `JasperEngine`: "check that the games built with the engine
   compile on macOS and Windows" — run commands in it, move files in and out, and destroy it.
   Orquester clones and syncs nothing into these boxes; the agent decides what goes in.

A chat working on a project box must feel exactly like a chat on the host: Claude Code writes
ordinary bash commands and they run in the box.

The hard constraint is credentials. Agent logins (Claude, Codex, Grok subscriptions) must never
be copied into a box. OAuth refresh tokens are single-use: when two holders refresh the same
account, whichever goes second logs the account out. Orquester already lived through this with
the CLIProxyAPI model proxy, which was removed (`model-proxy-retirement.ts:5-13`).

## 2. Goals, non-goals, anti-goals

### Goals

1. A plugin **Ephemeral AI VMs** in Settings → Plugins where the owner connects providers one by
   one, including a guided setup for Blacksmith macOS boxes that automates every step GitHub
   allows.
2. A **Runs on** choice in the New project dialog (every tab) and in the repo group's
   "New clone of …" dialog.
3. Project boxes for every box kind and every provider in §11, with agents, terminals, files,
   search, git, checkpoints, workflows and dev-server previews working as on the host.
4. Temporary boxes for agents through MCP tools, each one approved by the owner.
5. Agent configuration (profiles, skills, plugins, MCP servers, `CLAUDE.md`, settings) always in
   sync between the host and every box.
6. Chat transcripts kept on the host and resumable, with the box using the same absolute paths
   as the host.
7. Boxes destroyed outside Orquester (macOS time limit, provider dashboard, provider failure)
   detected and shown on the project row and its chats; those chats stay readable.
8. Better TS Typecheck, and any future plugin of the same kind, working inside boxes.
9. Works on a server daemon (public HTTPS address) and on the desktop app (through Tailscale).

### Non-goals (this version)

- Recovering unpushed work from a box that died unexpectedly. **Owner decision: accept that it
  is lost.** The Destroyed state says so.
- Recreating a destroyed project's box, or moving a project between the host and a box.
- Auto-sleeping idle boxes (some providers bill only storage while stopped — §11.3 — but boxes
  run until the project is deleted).
- The Desktop tab (virtual displays) inside boxes. Dev servers in a box are viewed through the
  existing Browser tab via port forwarding (§8.9).
- GitHub-hosted macOS runners as a fallback (6 h limit, and GitHub's terms restrict using them
  for work unrelated to the repo — my call).
- AWS, Azure and GCP (**owner decision**), and providers that require a monthly plan or minimum
  (**owner decision**; boat.dev, Vercel Sandbox, Cloudflare Containers, Koyeb GPU and others are
  excluded for this reason).
- A generic third-party plugin runtime. Plugins stay built in (`catalog.ts:1-3`).

### Anti-goals (a failure even if everything else works)

- An agent refresh token, a git private key, a git hosting token or a provider API key present
  in a box in any form; any other secret written to disk in a box, passed in a process argument,
  or written to a log. Exceptions, each decided: short-lived agent ACCESS tokens in a 0600
  credentials file in the box's agent home (Claude, Grok — spikes doc), and Secret files plugin
  files synced into project boxes (**owner decision**, 2026-10-20). (MCP and workflow secrets reach a box only in process env, and only for a
  server the owner switched to "Run in box" or a workflow block in a box project — §8.4, §8.8.)
- Anything other than the existing single refresher ever spending a refresh token
  (`agent-account-refresh.ts`, or the host-local CLI that holds the account).
- A box that keeps billing after Orquester believes it is gone, with nothing telling the owner.
- An agent spending money on a box without the owner approving that box.
- A chat on a project box behaving differently from a host chat in ways the owner can see
  (different tools, missing MCP servers or skills, lost history).
- A proxy that carries Claude inference traffic and injects subscription credentials. Anthropic's
  terms forbid third parties to "intermediate Claude.ai credentials"; CLIProxyAPI does this and
  even disguises its traffic as Claude Code.

## 3. Terms

- **Box:** a rented machine created by this plugin. A **project box** belongs to one project; a
  **temporary box** belongs to the chat that created it.
- **Box kind:** Linux, Linux + GPU, Windows, Windows + GPU, macOS.
- **Provider:** a company the box is rented from (§11).
- **`orq-agent`:** the small program Orquester installs in every box. It connects out to the
  daemon and carries everything the daemon does in the box (§5).
- **Location:** where a project runs: `host` or a box.
- **Token broker:** the daemon-side service that hands a box a short-lived agent access token,
  never a refresh token (§7).

## 4. What runs where

| Piece | Where |
|---|---|
| UI, chat GUI, composer, approvals | Host (unchanged) |
| Agent host, thread `events.ndjson`, checkpoints metadata | Host (unchanged) |
| Agent refresh tokens, git keys and tokens, provider API keys, MCP secrets | Host only |
| MCP servers the owner configured (default) | Host, piped to the box (§8.4) |
| Project checkout, terminals, builds, dev servers | Box |
| Agent CLI processes (`claude`, `codex app-server`, `grok`, `opencode serve`) and every tool call they make | Box |
| Agent config copy (settings, skills, plugins, `CLAUDE.md`, prepared profile dirs) | Synced copy in the box; host is the source of truth (§8.3) |
| Provider transcripts (resume data) | Written in the box, mirrored to the host after every turn (§8.5) |

The agent host stays on the host. Only the provider child processes move into the box.

## 5. `orq-agent`

One self-contained executable per platform, built from this monorepo (a new package; Bun's
`--compile` cross-compiles linux x64/arm64 glibc and musl, darwin arm64/x64 and windows x64
from TypeScript — a suggestion, the builder chooses).

**Connection.**
- It dials **out** to the daemon over one WebSocket (TLS) and multiplexes channels over it, so
  it works behind NAT, inside GPU containers that only map a few ports, and on GitHub Actions
  runners, which accept no inbound connections.
- Two connection routes (§6): the daemon's public HTTPS address, or the daemon's tailnet address.
- Version handshake on every connect. A mismatch makes the daemon push the matching build and
  restart `orq-agent` (the protocol must stay compatible across a daemon upgrade while boxes are
  connected, like the agent-host handover).

**Authentication.**
- At creation the daemon mints a single-use bootstrap token for the box (in the provider's user
  data / startup script or env, never argv). The first connect exchanges it for a per-box
  credential; the daemon stores only its hash, like session-tool credentials
  (`agent-host/session-tools/credentials.ts`).
- macOS runners authenticate with a GitHub Actions OIDC token instead (§11.2), so the control
  repo holds no secret.
- The connect route is a new remote route. It is authenticated by the box credential, not by the
  daemon's HTTP basic auth, and accepts nothing but box connections.

**Channels.** Process exec with stdio (agent CLIs, git, rg), PTY (terminals; tmux where
available so shells survive reconnects, ConPTY on Windows), file system operations and streamed
binary upload/download, search (ripgrep in the box), file watching, port forwarding in both
directions (box → host for dev servers and HTTP MCP endpoints; host → box for the Orquester
session-tool endpoint), config and transcript sync, the token broker, plugin tooling
provisioning, and box status (CPU, memory, disk, listening ports).

**Survives restarts.** A daemon restart or a dropped connection must not kill agent CLIs,
terminals or workflow processes in the box. `orq-agent` owns those processes, buffers their
output, and lets the host side reattach after reconnecting. An **agent-host** restart keeps
today's semantics (my call): agent CLIs are stopped at a turn boundary by the existing drain and
resumed later from their cursor, exactly as on the host; no adapter learns to adopt a running
CLI. A dropped connection that does not come back is handled by §9.2.

**Distribution.** The daemon serves the builds (`/api/boxes/agent/<os>-<arch>`, bootstrap-token
authenticated) and caches them; boxes download from the daemon, not from a third party.

## 6. Connectivity

- **Server daemon (like this host):** boxes connect to the daemon's public HTTPS address
  (through Caddy). The plugin settings show the address and a "Reachable" check.
- **Desktop app, or any daemon the owner chooses:** **owner decision — Tailscale.** The owner
  gives Orquester a Tailscale OAuth client once. For each box Orquester mints a single-use,
  pre-approved, ephemeral auth key tagged `tag:orq-box`; the box joins the tailnet and
  `orq-agent` dials the daemon's tailnet address. Tailscale removes ephemeral nodes after they go
  offline. Containers (vast.ai, RunPod and similar) run `tailscaled` in userspace-networking
  mode. macOS runners join through Tailscale's GitHub OIDC (workload identity) support where
  possible, so no Tailscale secret sits in the repo **(unverified: check the current Tailscale
  action)**.
- The settings page shows a short tailnet policy snippet for the owner to paste, allowing
  `tag:orq-box` to reach only Orquester's port on the daemon machine. Orquester never edits the
  tailnet policy itself.
- My call: the Connection section lets the owner pick either route on any daemon; a desktop
  daemon without Tailscale configured shows the box kinds as unavailable with the reason.

## 7. Agent credentials: the token broker

**Rule.** Refresh tokens never leave the host. Whoever refreshes an account today keeps doing
it: the daemon refresher (`agent-account-refresh.ts`) for accounts with no host-local CLI
running, or the host-local CLI itself for accounts in use on the host. A box only ever receives
an access token, which expires within hours. A CLI in a box therefore cannot refresh, so it
cannot race anyone.

**Changes to refresh scheduling.** `sessions.liveAccountIds()` today makes the daemon skip any
account with a live session, because the CLI refreshes it. Box sessions must not count as
refreshers. When a box asks for a token and no host-local session holds the account, the daemon
refreshes on demand if the token has less than a threshold left (builder's value, e.g. 45 min).
When a host-local session holds it, the broker reads the token that CLI keeps in the account
home. The existing sub-second window around a session starting mid-refresh stays as is.

- **Idle host CLI with a short token** (CLIs refresh lazily, on their next request). Spike 1
  also checks whether a running host CLI picks up a credentials file the daemon refreshed. If it
  does, the daemon refreshes on demand in this case too. If it does not, my call: the box turn
  waits with a visible "waiting for a fresh login token" status until the host CLI refreshes or
  its session ends (then the daemon refreshes), with the same deadline rules as other waits.
- **System account** (the daemon user's own CLI logins, never refreshed by the daemon and
  possibly refreshed by CLIs outside Orquester): my call — box chats use managed accounts only.
  The composer's account picker hides System for box projects and explains why.

**Per CLI** (each needs the spike in §14 before its adapter work):

| CLI | How the box gets tokens |
|---|---|
| Codex | `codex app-server` in the box, logged in with the app-server's `chatgptAuthTokens` mode: the host supplies `accessToken` + `chatgptAccountId` and answers `account/chatgptAuthTokens/refresh` requests through the broker. Regenerate the Codex bindings per the `_generated` README if new protocol types are needed. |
| Claude Code | A refresh-token-free `.credentials.json` in the box's config dir (spike: `CLAUDE_CODE_OAUTH_TOKEN` switches the default model). A running CLI re-reads the file, so before the token's remaining life drops below the threshold the adapter rewrites it between turns. Anthropic's own Desktop SSH sessions use the same model: the desktop keeps the refresh token and pushes fresh credentials to the remote engine. |
| Grok | `[auth] auth_provider_command` in the box's Grok config runs `orq-agent token grok`, which prints `{access_token, expires_in}` from the broker; Grok re-runs it with `GROK_AUTH_EXPIRED=1`. Written through the `GROK_CONFIG_PATH` overlay, never through account-home symlinks. |
| OpenCode | No managed accounts today; it uses the host's own `auth.json`. My call: in a box, OpenCode works with API-key providers through a host-side key-injecting endpoint (the documented gateway pattern), and OpenCode OAuth providers show as unsupported in boxes with a clear message. |

**Inference traffic** goes straight from the box to the provider. Orquester never proxies
Claude, Codex or Grok inference.

**Policy note.** Claude Code's terms allow an unmodified Claude Code binary signed in with the
user's own credentials on a hosted platform, and forbid third parties to intermediate
credentials. Handing the owner's own short-lived token to the owner's own box mirrors
Anthropic's Desktop SSH design and involves no proxy, but it is not explicitly documented for
third parties. The owner accepts this residual risk by approving this design.

**Git.** The box's git authenticates through the host: SSH via an agent forwarded over
`orq-agent` (the private key stays in `<appdir>/daemon/keys`), HTTPS via a git credential
helper (`orq-agent git-credential`) that asks the daemon. The workspace git identity
(`user.name`, `user.email`) is written into the box's git config; it is not secret. My call:
`gh` inside a box is not authenticated in this version (pushing, fetching and cloning work).

**Other secrets.** Provider API keys, the Tailscale OAuth client, the GitHub token, and Windows
administrator passwords returned by providers live in a new host-only store (§12) and never
appear in API responses or logs.

## 8. Project boxes

### 8.1 Creating one

- The **Runs on** row (mockups approved in chat on 2026-10-19) appears on every tab of the New
  project dialog and in the repo group's "New clone of …" dialog, under the Name field. It lists
  This host (default) and one card per box kind the owner has connected, each with a "from
  $/h" price, plus "Set up more…" which opens the plugin settings.
- Choosing a kind reveals provider, size and region (or GPU type / OS version) selectors. The
  summary line shows the live hourly price and the monthly equivalent, says the box runs until
  the project is deleted, and that setup clones the repo and installs its toolchain. macOS adds a
  warning with the daily cost and the maximum lifetime.
- The submit button reads "Clone into a new VM" (or "Create in a new VM").
- `CreateProjectRequest` (`packages/api/src/index.ts:320-339`) gains an optional location; the
  shared API contract changes first, then the daemon handler (`index.ts:2216-2348`) and the UI
  (`sidebar/NewProjectModal.tsx`).

### 8.2 What setup does

1. Persist the box record (state `provisioning`, the provider request identity, the generated
   instance name) **before** calling the provider, so a daemon crash mid-create is reconciled
   (§9.4).
2. Create the instance with the bootstrap script, which downloads `orq-agent` from the daemon and
   starts it (as a service on Linux and Windows; as the job's long-running step on macOS).
3. Wait for `orq-agent` to connect (an event, not a sleep; deadline per provider, e.g. 15 min for
   Windows images).
4. Create the host-equivalent paths (§8.6), sync agent config (§8.3), provision plugin tooling
   (§10).
5. Clone the repository with host-forwarded credentials (§7), at the requested ref. Empty and New
   repo work the same way; Template runs its typed command in a terminal in the box.
6. Install the toolchain: devcontainer if the repo has one **and** Docker works in the box;
   otherwise mise (`mise.toml`, `.tool-versions`, `.nvmrc`, `.python-version`, `go.mod`, …) plus
   corepack from `packageManager`, then the lockfile's install command. Shown as a progress log
   in the project; a failed step leaves the box usable and reports which step failed.
7. Mark the project ready.

### 8.3 Agent configuration sync

**Owner decision: always in sync with the host,** not only at launch.

- What syncs: everything a chat reads from its account home and from Agent Profile prepared
  directories — settings, skills, plugins, commands, hooks, agents, `CLAUDE.md`/`AGENTS.md`,
  MCP config — including targets of the account home's symlinks into the shared system config
  (`syncAccountHome`, `agent-accounts.ts:405-468`). The builder defines the per-CLI include and
  exclude lists (caches, telemetry, shell snapshots and similar stay out).
- Never syncs: credential files (`.credentials.json`, `auth.json`), profile `secrets.json`, git
  credentials. Transcripts use §8.5.
- The host watches those trees and pushes changes to every connected box within about a second.
  A full hash comparison runs whenever a box (re)connects and right before any agent CLI starts
  in the box.
- Direction (**owner decision**): host → box is automatic. A change made **inside a box** (an
  agent installing a skill, plugin, hook, command or MCP server, or editing settings or
  instruction files) reaches the host only with the owner's approval:
  - The box's change is held as pending. My call: it stays in effect inside that box while
    pending, so the agent can keep working with it there; it reaches neither the host nor other
    boxes.
  - My call: the pending changes of one turn are grouped into one approval card shown in the
    chat whose turn made them (or, if no chat turn was running, on the project row and the
    plugin page). The card lists each file with its diff and says which ones are executable
    (hooks, MCP server commands, plugin and skill scripts).
  - Approve: the change is written to the host and pushed to every other box. Deny: the box's
    copy is reverted to the host's.
  - If the host's copy of the same file changes while a box change is pending, the host wins and
    the pending item is marked stale.
- Profile chats keep their isolation rules (`2026-10-18-agent-profiles-design.md` §6): the box
  receives the same prepared directories at the same paths.

### 8.4 MCP servers

- My call: by default an MCP server runs **on the host**. The box's MCP config replaces a stdio
  server's command with `orq-agent mcp-bridge <id>`; the daemon starts the real server on the
  host and pipes its stdio over the connection. Host-local HTTP MCP servers are reached through a
  forwarded port; internet MCP servers are reached directly from the box. Secrets and logins of
  MCP servers therefore stay on the host.
- A per-server "Run in box" switch (Agent config and Agent Profiles) runs that server inside the
  box instead, for servers that must act on the box (a linter, a browser driving a dev server).
  My call: such a server's env and header secrets are delivered to its process environment only
  (never written to disk in the box), and the switch warns that the server's secrets will be
  present in the box while it runs.
- Orquester's own session tools keep working: Claude's in-process server already rides the SDK
  control channel; Codex, Grok and OpenCode reach the agent host's loopback endpoint through a
  host → box port forward, with the endpoint's Host-header check
  (`agent-host/session-tools/endpoint.ts:180`) satisfied by forwarding to the same port number or
  by adding the forwarded authority.

### 8.5 Agent chats in a box

- **Spawning.**
  - Claude: the adapter passes the Agent SDK's `spawnClaudeCodeProcess` option
    (SDK 0.3.278, `sdk.d.ts:2343`; documented "to run Claude Code in VMs, containers, or remote
    environments"). The SDK still builds the command, flags, cwd and env; the hook runs them in
    the box through `orq-agent` and returns a `SpawnedProcess` whose streams are channels.
  - Codex and Grok: a remote variant of `spawnProviderChild` (`support/spawn.ts:103`) with the
    same `ProviderChild` shape; `kill()` and the process-group teardown go to `orq-agent`.
  - OpenCode: `opencode serve` runs in the box; its HTTP port is forwarded to the agent host.
- Everything that today passes a host path into a launch passes the box path instead:
  executable, cwd, `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`, the attachments directory
  (attachments are copied into the box at the same path before the turn), profile
  `--mcp-config`/settings files, the Grok config overlay, and the `--version` probe.
- The chat GUI, approvals, interrupts, model and mode chips, forks and goals behave as on the
  host.
- **Transcripts.** After every turn `orq-agent` sends what the CLI appended to its session files
  back to the host account home at the identical path (Claude's `projects/<encoded cwd>/*.jsonl`
  are append-only). When a chat resumes in a box, its session files are pushed in before the CLI
  starts. Codex: rollout files sync; its SQLite state index is rebuilt in the box, never copied
  **(spike)**. Grok and OpenCode stores: same approach, verified by the spike. Host-side history
  readers (`claude/history.ts`, `agent-conversations.ts`) keep working on the mirrored files.
- **Checkpoints** (`agent-host/checkpoints/`) run their git commands in the box through
  `orq-agent`; refs live in the box's repository.

### 8.6 Same absolute paths

**Owner decision.** The box mirrors the host's paths: the project at
`<workspacesRoot>/<workspace>/<project>` (e.g. `/var/lib/orquester/workspaces/jaspersito/…`),
agent account homes at `<appdir>/daemon/agent-accounts/<agent>/<id>/home`, profile prepared
directories and the attachments directory at their host paths. `orq-agent` creates them with the
box's root/sudo and gives them to the box's working user. On a desktop daemon the host paths are
whatever that machine uses (e.g. under `/Users/…`); boxes create the same.

- macOS: `/var` is a symlink to `/private/var`. If a CLI records the realpath, the encoded
  transcript folder differs from the host's. **Spike;** if so, rewrite the folder name during
  transcript sync.
- Windows boxes cannot hold POSIX paths. They use a fixed mapping (my call: `C:\orq\` + the host
  path's segments). Their chats resume only inside the same box; this was explained to the
  owner.

### 8.7 Files, search and git panels

The project row stays a directory on the host so `listProjects` and every path-keyed store keep
their identity. My call: the host directory is an empty stub; a project record (§12) says it
lives in a box. Every file route (`/api/fs/*`), search (`search.ts`), archive/zip/parquet, upload
and download, and `GitService` (`git.ts`, which already takes an injectable runner, `:77`) route
to the box through `orq-agent` when the project's location is a box. Containment
(`assertInsideFsRoot`) is checked against the same root path on the box side. `listProjects`
fills `repoKey`/`repoName`/`cloneUrl` for box projects from the record, since there is no local
`.git`, so box projects join their repo group. The git panel's polling
(`GitWatcher`, `git.ts:1234`) runs its `git status` in the box.

### 8.8 Terminals and workflows

- A terminal tab in a box project opens a shell in the box (tmux-backed where available). The
  multiplexed terminal WebSocket protocol to the UI is unchanged; only the PTY source moves.
- Workflow `shell` and `code` blocks and the `agent` block run in the project's box. Their
  processes are owned by `orq-agent`, not re-adopted through the host's `/proc`
  (`workflows/sandbox/proc.ts`). Workflow wait state is persisted before a side effect starts,
  as today.
- Workflow secrets (my call): a block in a box project gets its secrets in process env or stdin
  only, never in files in the box. `code` blocks, which today receive inputs in `input.json`
  (`nodes/code.ts`), receive the secret-bearing part over stdin instead when run in a box.
  Output redaction stays on the host.
- Terminal-agent sessions from the launch registry (`packages/registry`: Claude, Codex, Grok,
  OpenCode, DeepSeek TUIs, IDEs, file explorers): my call — not offered for box projects in this
  version. The "+" menu hides them for box projects; agent chats and plain shells are offered.

### 8.9 Dev servers and the Browser tab

The server-side Chromium stays on the host. Ports listening in the box (from `orq-agent`'s port
list, and URLs sniffed from terminal output by `url-watcher.ts`) are forwarded to host loopback
ports; the Browser tab's suggestions point at the forwarded address. HTML-render image inlining
from the project reads through the box file channel.

### 8.10 Status, cost and the sidebar

- Project rows show a badge: provider and $/h for running boxes; for macOS, a countdown to
  automatic shutdown ("4d 6h left"); `Provisioning…`, `Unreachable` and `Destroyed` when they
  apply. The same badge appears on each chat card in "Opened agents".
- The plugin page shows all boxes, the total $/h and an estimated running total for the month
  (uptime × the hourly price recorded at creation; labelled as an estimate).

### 8.11 Archive and delete

- **Delete** (project menu) destroys the box through the provider API, waits for the provider to
  confirm, then removes the project as today (`index.ts:2350-2396`). A failed destroy leaves the
  project in a "Destroy failed — retry" state; it is never silently dropped while billing.
- My call: **Archive** leaves the box running and shows "still billing" on the archived row.

## 9. Lifecycle, failures and reconciliation

### 9.1 States

`provisioning` → `ready` ⇄ `unreachable` → `destroyed`; plus `destroying` and `destroy-failed`.

### 9.2 Detection

- **Unreachable:** `orq-agent` has not been connected for a short window (builder's value, e.g.
  60 s) while the provider still reports the instance running. The UI shows "Reconnecting…".
- **Destroyed:** the provider reports the instance gone or terminated, the runner job finished or
  was cancelled, or the macOS deadline passed. Checked by a periodic provider poll and
  immediately whenever the box drops.

### 9.3 What the owner sees when a box is destroyed outside Orquester

- **Owner decision.** The project row and each of its chats in "Opened agents" show
  "Destroyed". A chat opened from that project shows a banner explaining what happened ("gone in
  the Vultr dashboard", "macOS time limit reached", "provider error") and that unpushed changes
  are lost. The transcript stays readable (it lives in the host's thread log); the composer is
  disabled.
- Terminals, file and git panels show the destroyed state instead of erroring.
- The project menu offers Delete, which removes the stub, its chats and records.

### 9.4 Reconciler

- Runs at daemon start, periodically, and after any provider error.
- Lists every instance carrying Orquester's marker per provider (tags/labels where the provider
  has them — Vultr, Hetzner, others per §11 — otherwise an `orq-<boxId>` name prefix) and
  compares with the box records.
- An instance with no record, or a record in `destroying`/`destroyed`, is destroyed after a grace
  period and reported to the owner. A record whose instance is gone becomes `destroyed`.
- A `provisioning` record left by a crash is matched by its instance name and either resumed or
  destroyed.

### 9.5 macOS deadline

The workflow sets `timeout-minutes` (the owner picks the lifetime at creation, up to 7200 =
5 days, GitHub's limit for self-hosted runners, which is how Blacksmith runners register). The
countdown uses that deadline. Before it ends the UI warns; at the end the box is `destroyed`.

## 10. Plugins inside boxes

Better TS Typecheck today puts a host path into `NODE_OPTIONS=--require …`
(`plugins/session-env.ts:26-30`) and bakes host paths into the preload (`preload.ts:256-262`). A
host path leaking into a box makes every Node process there fail to start, so this must change
before any box session launches.

- A plugin that contributes per-session tooling declares, per **target** (os, arch, libc):
  artifacts (URL, integrity, archive layout, entry binary, smoke test), an optional preload
  rendered with the target's paths, and env contributions (PATH prepend, env vars, a Node
  `--require`). Today's single global `activePreloadPath` becomes a contribution set per
  execution target (`host` or a box).
- The daemon resolves artifacts for the box's target and verifies integrity itself (the existing
  npm-registry protocol in `installer.ts:169-299`), keeps a host cache keyed by
  (id, version, os, arch, libc), and streams the archive to the box (binary, not JSON).
  `orq-agent` installs it with the same stage → verify → extract → smoke-test → rename steps and
  reports the result.
- The box gets a small state file (enabled, engine, version) pushed by the daemon instead of
  reading the host's `plugins.json`; its preload uses the box's workspace root.
- Engine choice is per target: tsrs where it has a build (Linux glibc/musl, macOS arm64),
  otherwise tsc-rs (Windows, Intel Mac). A Windows box gets tsc-rs even when the host uses tsrs.
- Windows: build paths and `NODE_OPTIONS` with the target's path rules, merge into whichever of
  `Path`/`PATH` exists, use a space-free tool directory.
- The plugin settings Status section adds a per-box line when a box's install failed.

## 11. Providers

### 11.1 Catalog

**Owner decisions:** pay-as-you-go only; no AWS, Azure or GCP; providers whose account needs a
one-time check after signup are kept (Hetzner and Scaleway ID checks, Akamai GPU account
review), with that check stated in their setup row. The builder confirms each provider's API
details while writing its adapter.

| Kind | Providers |
|---|---|
| Linux | Hetzner, Vultr, IONOS Cloud, OVHcloud Public Cloud (hourly), Scaleway, DigitalOcean, Exoscale, Akamai/Linode, Fly.io Machines, Morph Cloud, Civo, Oracle Cloud |
| Linux + GPU | vast.ai, RunPod (API v2 only — v1 retires 2026-11-15), Hyperstack, Thunder Compute, CloudRift, Massed Compute, Jarvislabs, DigitalOcean GPU, OVHcloud GPU, Scaleway GPU, Akamai/Linode GPU |
| Windows | Vultr, Exoscale, Oracle Cloud, UpCloud (Cloud Native plans), OVHcloud, Scaleway |
| Windows + GPU | TensorDock, OVHcloud |
| macOS | Blacksmith (through the owner's GitHub org) |

Provider-specific facts the adapters must handle (from research):

- Containers, not VMs: vast.ai, RunPod (no systemd, no Docker-in-Docker on GPU pods; SSH/ports
  via mapped ports) — `orq-agent` runs in the foreground from the container's start command
  (`onstart`, `args`) and, with Tailscale, in userspace mode. Fly Machines run their own init (no
  systemd).
- Readiness: every provider reports "running" before the startup script finishes; readiness is
  the `orq-agent` connect.
- Windows bootstrap: with `orq-agent` dialing out, a Windows box needs no OpenSSH, only a way to
  run a startup PowerShell script (cloudbase-init user data on OVH, Exoscale, Oracle, Scaleway;
  Vultr startup scripts or a one-time "prepared image" built by the plugin and stored as a
  snapshot). TensorDock Windows bootstrap is unverified (no snapshot API; cloud-init support for
  Windows unknown) — **spike**; if no unattended path exists, TensorDock Windows is dropped and
  OVH remains for Windows + GPU.
- Windows licence fees are part of the displayed price.
- Prices for the "from $/h" cards and the summary line come from provider pricing APIs where
  they exist (vast.ai offers, RunPod catalog, TensorDock locations/hostnodes, Exoscale pricing
  API, Vultr/Hetzner plans) and from a bundled table refreshed by the builder otherwise.
- Stopping saves nothing on several providers, and boxes are never stopped in this version;
  destroy is the only teardown.

### 11.2 Blacksmith macOS boxes

- Blacksmith is organization-only; a free GitHub org works. Jobs on Blacksmith count as
  self-hosted, so the limit is 5 days per job (GitHub docs); Blacksmith documents no shorter cap
  of its own. Price: $0.08/min (6 vCPU M4), $0.16/min (12 vCPU).
- Setup steps in the plugin settings, each with a status:
  1. Pick one of the GitHub accounts already connected in Settings → Git hosting
     (**owner decision** — no separate sign-in). Its token needs the `repo` and `workflow`
     scopes and the account must be able to create repos in the org; the step checks the token's
     scopes and org membership and, if something is missing, says exactly which scope to add
     to the token on GitHub. The token never leaves the host; the box receives nothing from it.
  2. Pick an org (creating one is a link to GitHub — it cannot be automated).
  3. Install the Blacksmith GitHub App on it (a link to the app's install page — needs a
     browser click by an org owner).
  4. Automatic: create the private control repo, commit the workflow to its default branch,
     wait until GitHub accepts a dispatch (retry on 404/422, no fixed sleep).
  5. Automatic: test run — start a box, see `orq-agent` connect, destroy it (~2 min).
- Starting a box: `workflow_dispatch` with `return_run_details: true` (gets the run ID
  directly), inputs carrying only the box ID and lifetime. The workflow requests
  `permissions: id-token: write`, downloads `orq-agent` from the daemon, and runs it with a
  GitHub OIDC token whose claims (repository, run ID, workflow ref, audience = the daemon) the
  daemon verifies against the dispatch it just made.
- Destroying: tell `orq-agent` to exit (the job ends successfully), then `cancel`, then
  `force-cancel` as a last resort.

### 11.3 Provider setup rows

Each provider row in the plugin settings takes its API key (validated with a cheap read call
before it is saved), shows which kinds it unlocks, any one-time account check, and a Windows
"prepared image" status where §11.1 needs one.

## 12. Persistence and contracts

- `PluginId` (`packages/api/src/plugins.ts:5-12`) gains the new plugin; catalog entry in
  `apps/daemon/src/plugins/catalog.ts`; its settings UI is bespoke, like the Engine choice
  (`PluginsSettings.tsx`).
- New tolerant stores in `packages/config` with path helpers (no hardcoded appdir paths;
  passthrough schemas that keep unknown fields and records written by other versions):
  - `boxes.json`: box records — id, kind, purpose (project | temporary), provider, provider
    instance identity, region, size/image, os/arch/libc, hourly price at creation, created and
    deadline times, state and reason, the project or thread it belongs to, the hashed box
    credential.
  - The project location record for box projects (either inside `boxes.json` or a separate
    store keyed by workspace and project; not in `workspaces.json`, whose strict schema drops
    unknown fields, `packages/config/src/index.ts:953-969`).
  - `box-secrets.json` (mode 0600, atomic writes, like `workflows/secrets.ts`): provider keys,
    Tailscale OAuth client, GitHub token, provider-returned Windows passwords.
- Transport contracts in `packages/api` first: box kinds, states and summaries; the
  `CreateProjectRequest` location; `ProjectSummary.box`; box fields on chat summaries for
  "Opened agents"; plugin settings payloads. Then daemon handlers and UI consumers.
- Box state changes are broadcast on the existing broadcaster so the sidebar, chats and plugin
  page update live.

## 13. Temporary boxes for agents

### 13.1 Tools

New tools in the one Orquester MCP catalog, behind `DaemonApi`:

- `create_box` — kind, optional provider/size/region, time limit (default 2 h; maximum the
  provider's limit), a short purpose. Blocks on the owner's approval (§13.2), then until the box
  is ready; returns its ID, OS and arch.
- `box_exec` — run a command (bash on Linux and macOS, PowerShell on Windows, or an explicit
  shell), stream output, with a timeout; long-running commands can be started in the background
  and read later.
- `box_upload` / `box_download` — move files or directories between a path in the chat's
  project and a path in the box, streamed as binary (e.g. a `git bundle` in, build logs and
  binaries out).
- `box_forward_port` — expose a box port on the host so the Browser tab can open it.
- `list_boxes`, `destroy_box`.

A chat can use only the boxes it created. My call: the box tools are agent-chat tools only (like
`request_secret`); external MCP clients do not get them. Chats started by workflow `agent`
blocks or by other agents may call `create_box`; the approval card then waits for the owner,
sends a push notification, and is denied automatically after a timeout (builder's value, e.g.
30 min).

### 13.2 Approval

**Owner decision: the agent asks every time.** `create_box` raises an approval card in the chat
showing kind, provider, size, estimated $/h, the time limit, and the worst-case cost if it runs
the whole time. Deny returns an error to the agent. My call: the card appears in every
permission mode, including full access, because it spends money.

### 13.3 Lifetime and visibility

- A temporary box is destroyed when the agent calls `destroy_box`, when its time limit ends, or
  when its chat is closed (my call), and leftovers are caught by the reconciler.
- The chat shows a card per box with kind, cost so far and a countdown, and a "Watch" button
  that opens a terminal tab attached to the box.
- Temporary boxes are listed on the plugin page with project boxes.
- They use the same `orq-agent`, providers and connectivity; no config sync, transcript sync,
  clone or toolchain setup.

## 14. Spikes (run before the work that depends on each)

1. **Claude with an access token only:** a regular OAuth access token via
   `CLAUDE_CODE_OAUTH_TOKEN` (or a credentials file without a refresh token) on a box gives the
   full subscription experience; behaviour at expiry; restart-with-resume keeps the thread
   intact. If this fails, stop and bring it back to the owner before building Claude-in-box.
2. **Codex `chatgptAuthTokens`** in the Codex version Orquester pins: login, refresh request
   flow, and resume of a thread whose rollouts were synced.
3. **Grok `auth_provider_command`** with a grok.com subscription token (documented for corporate
   identity providers).
4. **`orq-agent` packaging:** one executable per platform with PTY support on Linux, macOS and
   Windows.
5. **Paths:** Claude's encoded project folder on macOS (`/private/var`), Codex's state index
   rebuild, Grok and OpenCode stores.
6. **TensorDock Windows** unattended bootstrap.
7. **Blacksmith end to end:** dispatch → OIDC verification → connect → cancel, on a free org.

## 15. Verification

- Unit tests: provider adapters against recorded, redacted fixtures (create, readiness, list by
  marker, destroy, error shapes, rate limits); the token broker's refresh rules (no refresh
  token ever leaves; box sessions never counted as refreshers; on-demand refresh only when no
  host-local holder); config sync (include/exclude lists, credentials never sent, host wins on
  conflict); transcript mirroring; reconciler decisions; store schemas tolerating unknown fields;
  OIDC claim checks; plugin tooling resolution per target, including Windows paths.
- `orq-agent` protocol tests: channel multiplexing, reattach after reconnect, version handshake,
  binary file transfer.
- UI logic tests for the Runs on row, badges and destroyed/read-only chats; check both the
  desktop and web entry points.
- Live checks with real provider keys only through the plugin's own test-run flows and a
  separate checkout and appdir, never the live daemon.
- `pnpm check` and `pnpm test` as usual.

## 16. Left to the builder

- `orq-agent`'s language/packaging, wire framing, and how the agent host reaches box channels
  (through the daemon's socket or a per-box local endpoint), within §5's requirements.
- Timeouts, thresholds, poll intervals, retry policies.
- Per-CLI sync include/exclude lists.
- Provider adapter order and internal structure; how live prices are fetched and cached.
- Exact UI layout beyond the approved mockups, matching the existing settings and sidebar style.
- Splitting the work into implementation plans (the spikes come first).

## 17. Calls made during design (not owner-stated — check these)

1. Plugin name spelled "Ephemeral AI VMs".
2. GitHub-hosted macOS runners are not offered as a fallback.
3. Box-made config changes stay live in that box while pending, are grouped per turn into one
   approval card in the chat that made them, and lose to a host change of the same file.
4. MCP servers run on the host by default, with a per-server "Run in box" switch.
5. OpenCode in boxes supports API-key providers only.
6. `gh` is not authenticated inside boxes.
7. The host project directory is an empty stub for box projects.
8. Windows boxes map host paths to `C:\orq\…`.
9. Archive leaves the box running, with a "still billing" note.
10. The Runs on row appears on all four New project tabs.
11. Temporary boxes: default 2 h limit, destroyed when their chat is closed, approval card even in
    full-access mode.
12. (Superseded by owner decision: Blacksmith setup reuses a connected Git hosting account.)
13. Either connection route (public address or Tailscale) can be chosen on any daemon.
14. The Desktop tab is out of scope inside boxes.
15. An agent-host restart stops box CLIs at a turn boundary and resumes them, as on the host;
    only daemon restarts and dropped connections reattach to running processes.
16. Box chats use managed accounts only; an idle host CLI with a short token makes the box turn
    wait unless spike 1 shows host CLIs pick up daemon-refreshed files.
17. Workflow secrets and "Run in box" MCP secrets reach a box only in process env/stdin.
18. Terminal-agent and IDE launches are hidden for box projects.
19. Box MCP tools are agent-chat only; unattended approvals notify and time out as denied.
