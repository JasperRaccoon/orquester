# claudex addon — Claude Code harness × GPT via managed CLIProxyAPI

Date: 2026-07-22 (spike-updated 2026-07-23) · Status: approved design, hardened through
four tri-model review rounds (two primed, two blind — Claude, Codex, Kimi K3) + Moonshot
research, then updated by the Task-0 spike + OAuth-seeding sub-spike
(`docs/superpowers/spikes/2026-07-22-claudex-spike-findings.md`). **Phase 1 built + green
(288/288 daemon tests); Phase 2 planned in `docs/superpowers/plans/`.**

## Purpose

Run the Claude Code CLI with OpenAI's GPT models (e.g. `gpt-5.6-sol`) as the backing
model, billed against the user's existing ChatGPT/Codex subscription — fully managed
inside Orquester on the VPS. Two outcomes:

1. **Escape hatch** (`claudex`): when Anthropic usage runs out, launch the same harness
   (tools, skills, UI) on GPT.
2. **Mixed-model orchestration** (`claudemix`): a Fable-driven session whose Workflow
   scripts / subagents can fan out to other model families — plan on Fable, design on
   Kimi K3 (OpenRouter), execute on Sol, then a multi-model cross-review, in one session.

Reference: the "claudex" community guide (CLIProxyAPI + `ANTHROPIC_BASE_URL` alias),
adapted from a laptop/zsh setup to a headless single-user server managed by the daemon.

## Architecture overview

```
claudex/claudemix session (claude CLI)
  └─ ANTHROPIC_BASE_URL=http://127.0.0.1:8317  +  ANTHROPIC_AUTH_TOKEN=<local key>
       └─ CLIProxyAPI (daemon-managed, loopback only)
            ├─ gpt-*      → OpenAI Codex backend (Codex OAuth, proxy-owned device auth)
            ├─ claude-*   → Anthropic API (Claude OAuth, proxy-owned device auth)
            └─ kimi-k3, … → OpenRouter (openai-compatibility provider, plain API key)
```

CLIProxyAPI (github.com/router-for-me/CLIProxyAPI, MIT, static Go binary) speaks the
Anthropic Messages API on the front and routes to providers by model name. Credentials
auto-refresh; multiple accounts round-robin.

## Components

### 1. `CliProxyManager` — new daemon service (`apps/daemon/src/cliproxy.ts`)

Owns everything under `<appdir>/daemon/cliproxy/`:

> **Spike-updated (2026-07-23, `docs/superpowers/spikes/2026-07-22-claudex-spike-findings.md`):**
> the whole chain was proven on this VPS against the **stock** CLIProxyAPI v7.2.95 release
> binary. The Kimi empty-content bug is present in source but **never triggers under Claude
> Code** (Claude Code pairs text with tool calls), so the source-build/patch apparatus is
> **removed** — we ship the verified stock binary. Codex and Claude OAuth **seed by pure file
> conversion** of the existing managed-account credentials (no browser/device flow). Only the
> management `secret-key` is hashed in `config.yaml`; the local API key and provider keys stay
> plaintext there — so `secrets.json` stays authoritative for the management secret.

```
cliproxy/
  bin/cli-proxy-api   # stock release binary, SHA-256-verified download (see below)
  bin.prev/           # previous verified binary, kept for rollback
  config.yaml         # generated, 0600 (NB: the proxy HASHES the plaintext secret-key
                      # in here at startup — config.yaml is not a secret store we can
                      # read back)
  secrets.json        # 0600: THE authoritative secret store — local API key,
                      # management secret, OpenRouter key (survives restarts; see
                      # "Secrets are stable"). config.yaml and token are projections.
  token               # 0600: derived copy of the local API key, read by wrapper bins
  auth/               # 0700; provider credential JSONs, 0600, auto-refreshed by the proxy
  claude-home-claudex/    # dedicated CLAUDE_CONFIG_DIR per entry (see §2 — two homes,
  claude-home-claudemix/  # never one; cross-entry resume isolation)
  logs/               # proxy request log, rotated by the proxy's own log config, 0600
  cliproxy.json       # manager state: enabled, pinned version + sha256, default model,
                      # backgroundModel, port (loopback-only override, default 8317),
                      # last-known model catalog + asOf (chip source while proxy is
                      # offline), tested claude-CLI version (see below)
```

**Binary install (stock release, no build).** The manager downloads the **pinned
CLIProxyAPI release binary** (`CLIProxyAPI_<ver>_linux_amd64.tar.gz`) over HTTPS to a
private temp file, verifies it against a **hardcoded per-platform SHA-256 digest** (bumped
deliberately with the version), extracts, and installs atomically; the prior verified
binary is kept in `bin.prev/` for rollback. Reject unsupported OS/arch. A pinned tag alone
is not integrity verification — the digest is. No Go toolchain, no source, no compile: the
spike confirmed the stock binary is sufficient (Kimi included) for the Claude Code harness.
Version bumps are **manual-only** (no auto-update checks). Enable is **async and
idempotent**: it returns immediately and runs through substates (fetch / verify / install)
surfaced via the status `detail` field (state stays `downloading`), with a bounded timeout,
a disk-space precheck, and diagnostic output retained on failure; a daemon restart mid-
download discards the partial temp file and `bin/` is only ever replaced atomically after a
verified extract.

**Kimi patch is defense-in-depth, not shipped.** The one-line translator fix (omit
`content` when `tool_calls` present) stays documented in `deploy/cliproxy-patches/` but is
**not applied** — it would only matter for a client that emits bare tool-call turns, which
Claude Code does not. If a real `content:""` 400 is ever observed in the request log, that's
the trigger to revisit a patched build; until then the stock binary ships. (Re-verify on any
version bump — the bug line could change upstream.)

**Generated `config.yaml`**: `host: 127.0.0.1`, `port: 8317`, one generated `api-keys`
entry (`crypto.randomBytes`), `remote-management.secret-key` (generated;
`allow-remote: false`), `auth-dir` pointing at `auth/`, request logging into `logs/`,
and — when an OpenRouter key is configured — an `openai-compatibility` provider
(`base-url: https://openrouter.ai/api/v1`) with model aliases so short names
(`kimi-k3` → `moonshotai/kimi-k3`) appear in the merged catalog.

**No proxy-side reasoning-effort override.** The community guide's `payload.override`
forcing `reasoning.effort: high` on all `gpt-*` is dropped entirely: it can't be scoped
to "the main model" when the main model is chosen per launch and the config is static
(and restarts are refused while sessions run), and a blanket override silently bills the
haiku-slot/background calls (title generation, compaction) as high-effort Sol. Effort is
owned client-side (`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` + per-launch effort env/flags).
`payload.override` is reserved for provider-constraint clamps only (e.g. Kimi
temperature range [0,1]). The §8 spike measures real cost per slot.

**Secrets are stable — and persisted outside `config.yaml`.** CLIProxyAPI **hashes the
plaintext `secret-key` (management secret) inside `config.yaml` at startup** — spike-
confirmed — so it cannot be read back for management-API auth after a restart. (The
`api-keys` local key and provider keys stay *plaintext* in `config.yaml`, also spike-
confirmed — so the "can't read it back" reason applies specifically to the management
secret; `secrets.json` is nonetheless the authoritative store for all of them, to avoid
parsing config back and to keep one source for rotation.) The daemon persists its own
plaintext copies in `secrets.json` (0600, hardened writes, zod-schema'd). **`secrets.json`
is the single authoritative store** — for the local API key, the management secret, AND
the OpenRouter key (config regeneration must re-emit them); `config.yaml` and the `token`
file are derived projections rewritten from it. The local API key and management secret
are generated once and **persist across all ordinary config rewrites and restarts** —
live sessions snapshot their env at launch, so key regeneration would silently break
every running claudex session. **A corrupt `secrets.json` fails closed**: the loader
distinguishes missing (first enable → generate) from corrupt (→ `error` state, no
regeneration, no config rewrite — regenerating would orphan every live session and the
surviving proxy), following the session-index precedent of never taking destructive
action on a bad file. Rotation is a separate explicit operation following the `force`
pattern: warn with the affected-session count → explicit confirm → regenerate,
accepting that those sessions break.

**Process model.** The proxy runs on the daemon's dedicated tmux server under a session
name **outside the `orq-` namespace** (e.g. `orqsvc-cliproxy`). This is load-bearing:
`SessionManager.reattach()` reaps any live `orq-*` tmux session missing from
`sessions.json`, so an `orq-`-named proxy would be killed on every daemon restart — the
opposite of the intended persistence. Requires either the distinct prefix (with
`listSessions()` scans untouched) or an explicit reserved-name exclusion in the reaper;
a daemon test must prove a restart does not reap the proxy session. Net-new `Tmux`
surface is required: **every existing session-scoped public method prepends `orq-`**
(`newSession`, `hasSession`, `killSession`, the capture methods — and the socket/raw
runner are private; there is no session-scoped resize, that lives on the attach PTY),
so the manager gets dedicated raw-name service-session methods enumerated from the real
class rather than reusing the session-scoped ones.

**Adoption is ownership-verified, not health-only — and the authenticated probe comes
FIRST.** On boot, in order: (1) our tmux server has the service session → probe with our
key; adopt if healthy, restart if not. (2) No owned tmux session but the port answers →
**probe with our key before classifying** (probe-order matters; classifying "foreign" on
port-liveness alone would mislabel our own surviving proxy): key accepted → it is ours,
running outside tmux (crash-recovery edge) — track it best-effort as an external process
(it is not and cannot become a child of the restarted daemon), mark `persistence-lost`,
and respawn under tmux at the next safe window (no active sessions), a condition
**re-evaluated on every session-set change and on a slow poll**; the daemon test for
this asserts clearance *under the stated invariant that sessions eventually drain* —
on a server that never idles, `persistence-lost` legitimately persists and stays
warn-only. Key rejected → **foreign listener**: report `error: port conflict`, never
adopt or kill an unverified process (a loopback-only port override in `cliproxy.json`
exists for the legitimate-permanent-occupant case). (3) Nothing on the port → spawn,
then poll readiness with bounded backoff. **Runtime crash supervision** (not just
boot-time): when the health probe finds an owned-but-dead proxy mid-run, the manager
respawns with bounded exponential backoff (3 attempts), then latches `error` and
notifies — "mark degraded and wait for a daemon restart" is not an acceptable
availability cliff for a loopback service. All transitions serialized. Status shape is
`{ state, reasons: string[] }` — `state ∈ off | downloading | building | starting |
healthy | degraded | error`, and `degraded` carries one reason per cause so multiple can
compose (`provider codex missing from /v1/models`, `CLI version drift`,
`persistence-lost`); registry `disabledReason` strings are derived from these reasons.
Per-provider status comes from a real model-list probe, not just the port.
Reason→consequence is explicit: provider-credential reasons (`codex auth expired`,
`proxy down`) disable the dependent launcher entries (with that `disabledReason`);
`CLI version drift` and `persistence-lost` are warn-only — entries stay launchable;
`backgroundModel missing from catalog` (probed alongside provider status) is warn-only
with last-known env retained. A status `detail` field carries build substage text.

**Restart/disable honors live sessions.** Default: config changes that need a proxy
restart are **hard-refused** while any **daemon-managed** claudex/claudemix session is
active (the API returns the affected session count; the guarantee is explicitly scoped
to daemon-managed sessions — wrapper-launched `claudex -p` processes are invisible to
this accounting, per §2, and can be broken by a non-force restart). A distinct explicit `force: true` operation exists
for "I accept breaking N sessions" — disclosure alone is not quiescence. **Disable is
force-gated identically to restart**, synchronous once confirmed, and cancels an
in-flight build (workspace discarded); it marks the launchers visible-but-disabled (per
§2 `disabledReason` — not hidden) and states that existing sessions keep targeting the
(now dead) endpoint. When the proxy
dies unexpectedly, the daemon cross-references sessions routed through it and emits one
targeted notification ("proxy down — N GPT sessions affected") instead of letting each
tab surface raw connection-refused errors.

**CLI-coupling smoke check.** The claude CLI is a moving target and the proxy emulates
its API surface; a routine CLI update can break claudex/claudemix while stock `claude`
keeps working. `cliproxy.json` records the last claude-CLI version that passed the smoke
check; on version drift the manager re-runs a cheap `claudex -p` smoke test —
**async post-boot** (never blocking `starting`), **skipped entirely when no provider is
authenticated yet** (a fresh install must not sit in `degraded` over a check it can't
run), and noted as costing real subscription tokens — surfacing mismatch as a warn-only
`degraded` reason.

Fallback without tmux: direct child process, no persistence, explicit graceful
termination on shutdown (same degradation the session manager accepts).

### 2. Registry entries, env files, dedicated home, wrapper bins

Two new static agent entries in `packages/registry/src/index.ts`, both `bin: ["claude"]`,
with **explicitly specified `args`** (`bin` alone inherits nothing). **Decided**: both
entries carry the same args as the stock `claude` entry —
`--dangerously-skip-permissions --effort max --verbose` — matching how codex/opencode
already run in yolo mode on this host (explicit user decision). Stated consequence:
wrapper-bin invocations (`claudex -p` from any session or workflow) run with the same
full autonomy.

| id | Display name | Main model | Role |
|---|---|---|---|
| `claudex` | Claude × GPT/Kimi | **picked per launch** (chips: GPT, Kimi, …), default `gpt-5.6-sol` | non-Anthropic escape hatch |
| `claudemix` | Claude × Mixed | Fable (Claude OAuth via proxy) | mixed-model orchestrator |

**Per-launch model choice for `claudex` — honest plumbing inventory.** The launcher row
shows model chips (visually like the account chips, but a **parallel new
implementation** — the existing chip block is render-gated on managed accounts): at
minimum `gpt-5.6-sol` and `kimi-k3`, sourced from the last-known proxy catalog with a
stale/disabled treatment when a chip's model has vanished (never a silent fallback).
Net-new pieces, all in scope:

- `CreateSessionRequest.model?` — **rejected with a 400 naming the entry id when sent
  for any other entry** (never silently ignored). For these entries, every daemon
  launch resolves `effectiveModel = request.model ?? persisted defaultModel` and
  validates **that value** fail-closed against a fresh `/v1/models` probe — bounded
  (≤2 s) and **scoped to the effective model's provider** (an OpenRouter outage must
  not block a GPT launch); on probe failure/timeout the create fails with an error
  naming the provider status. An omitted field gets the same validation as an explicit
  one — a stale *default* must not launch and die mid-session either. (Wrapper-bin
  invocations cannot get this daemon-side guarantee; documented in §2 Wrapper bins.)
- `ResolveSessionExtraEnv` gains a launch-context parameter carrying `model` (today its
  signature is `(entry, accountId)` — the request never reaches it); both session-backend
  call sites and the `index.ts` wiring change; the account contributor and the new
  cliproxy contributor **compose** (merged env/unsets, `accountId` recording preserved).
- The chosen model is **persisted on the session record** and returned on
  `SessionSummary.model?` (wire type + persisted schema + create/reattach paths +
  `session.updated` events): immutable for the session's life, survives daemon restart
  and client refresh, and the tab badge renders from the record — never from client chip
  state.
- Client: a `preferredModelByAgent` store map + its own schema-validated localStorage
  key (per the adapter-load rule in AGENTS.md), `openTab` extended to carry `model`, and
  the launcher-menu filter changed to render visible-but-disabled entries (today it
  filters `enabled` out entirely).

**Default-model precedence has one source of truth: `cliproxy.json.defaultModel`.**
The Settings dropdown writes it; env-file regeneration (`ANTHROPIC_MODEL`) follows from
it; the client's `preferredModelByAgent` is a **per-client chip preselection only** —
it decides which chip renders highlighted, is passed as `request.model` on launch, and
is never authoritative (divergence across browsers resolves to whatever each launch
explicitly sends, falling back to the persisted default). The background/haiku-slot
model (`backgroundModel`, persisted in `cliproxy.json`) is validated at set-time,
applies to **both** entries' env generation, defaults to a cheap `gpt-*`, and is
**never** touched by a per-launch main-model pick.

Distinct ids are load-bearing: `resolveLaunchEnv` (agent-accounts.ts) only matches
`claude`/`codex`, so these entries never get a managed account home and never hit the
`unset ANTHROPIC_AUTH_TOKEN` that would strip the proxy token.

**Dedicated config homes (not the shared system `~/.claude`) — one per entry.**
claudex sessions launch with `CLAUDE_CONFIG_DIR=<appdir>/daemon/cliproxy/claude-home-
claudex`, claudemix with `…/claude-home-claudemix`, so (a) GPT/Kimi-authored transcripts
never interleave with native-Fable history and (b) claudex and claudemix don't recreate
the same `--resume` poisoning between each other (resuming a Sol transcript under a
Fable main loop, or vice versa). Seeding is a **manager-owned custom seeder, NOT
`syncAccountHome`** — that routine symlink-shares `projects/` (conversation history)
into the system store, which would defeat the isolation outright; it also can't reuse
`assertOwnedAccountHome` (wrong path shape/marker). The seeder: copies identity-free
`.claude.json` (onboarding forced), symlinks `skills/`/`plugins/` (live-shared —
consequence accepted and documented: a skill edit from a claudex session writes through
to the shared store; single-user trade-off), seeds `settings.json` once (hooks installer
re-ensures on every launch), and **never shares `projects/`**. Each home gets its own
ownership marker + symlink-refusal guard, and is created **0700** (same rigor as
managed account homes). The usage-token scanner and the Claude-home change watcher are
both extended to cover these homes' `projects/` dirs — today the scanner covers the
system home + managed account homes and the **watcher only the system roots** —
without both extensions, proxy sessions vanish from usage scans. Records discovered
under a proxy home are **tagged with the launcher id, not `agent: "claude"`**, and
excluded from the Claude-account aggregate — otherwise GPT/Kimi transcript tokens
inflate exactly the "how much Anthropic quota is left" signal the escape hatch exists
to protect. This also gives proxy-routed transcripts identifiable homes — the closest
available answer to "which model did this."

**Secret/non-secret env split (two channels, per the codebase's own invariant).**
Registry `entry.env` reaches sessions via `tmux new-session -e` — argv-visible in
`/proc`; sessions.ts documents it as non-secret. Therefore:

- `<appdir>/daemon/env/claudex.env` (generated) carries **non-secrets only**:
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`,
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3`, `ENABLE_TOOL_SEARCH=false`,
  `CLAUDE_CODE_NO_FLICKER=1`, and `CLAUDE_CONFIG_DIR=<its dedicated home>` (non-secret;
  dual-channel rationale below). `claudemix.env`, enumerated in full for the same
  invariant: `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR=<its home>`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL=<backgroundModel>` (required — "flags only" would
  silently route claudemix background calls to the CLI default, exactly the failure the
  backgroundModel invariant forbids), `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`,
  `CLAUDE_CODE_NO_FLICKER=1`; main model deliberately unset (Fable via CLI default).
  Exact set refined by the spike.
- **`ANTHROPIC_AUTH_TOKEN` travels the addon-env channel**: a new contributor in the
  `resolveExtraEnv` path returns it for these entry ids. On the **tmux backend** it is
  injected via the existing 0600 one-shot wrapper script (`writeAddonEnvLaunchScript`),
  never `-e` argv; on the **local (node-pty) backend** there is no wrapper — `extraEnv`
  is merged directly into the child environment (still never argv). Both backends are
  described and tested as they actually are. Note honestly: the token ends up in the
  claude process environment either way (`/proc/<pid>/environ`, same-UID readable) —
  0600 files and loopback do not isolate secrets from other processes running as the
  same user.
- **`CLAUDE_CONFIG_DIR` is non-secret and deliberately appears in BOTH channels** with
  identical values: in each entry's env file (so the wrapper bins inherit the dedicated
  home — without this, `claudex -p` from a shell would silently fall back to the shared
  system `~/.claude` and recreate the resume-poisoning the homes exist to prevent) and
  in the addon-env contributor (so the hooks installer's `launchEnv` sees it, which is
  how `configTarget` resolves the home). The collision is harmless by construction; a
  wrapper test asserts the launched process's `CLAUDE_CONFIG_DIR`.

**Env-file hardening** (net-new; the current code only reads the path): `env/` dir 0700;
atomic 0600 writes; refuse symlinked targets; values validated (model names restricted to
`[A-Za-z0-9._/-]`) — and wrapper bins **parse** the dotenv file as data rather than
`source`-ing it as shell, eliminating the injection vector.

**Net-new `RegistryService` API** (does not exist today; env files are read only at
`init()` and `enabled` has no public setter): `reresolve(id)` (re-reads env file + bin,
preserves install state **and runtime state**, re-broadcasts sanitized entry) and
`setRuntimeState(id, { enabled, disabledReason? })`. The two must not race: effective
`enabled` is a single atomic recomputation of `binResolved && runtimeEnabled` — a bin
re-resolution can never resurrect a launcher that runtime state disabled (proxy down,
auth expired). Entries whose proxy/credentials go
away become **visible-but-disabled with a reason** (`"proxy down"`, `"codex auth
expired"`) rather than vanishing from the "+" menu; `RegistryEntry` gains an optional
`disabledReason` field surfaced in both the launcher menu and the Settings card.

**Wrapper bins** `<appdir>/.npm-global/bin/claudex` and `.../claudemix` (0700): parse
the env file (which includes `CLAUDE_CONFIG_DIR`), read the token from the dedicated
`<appdir>/daemon/cliproxy/token` file (0600 — the ONE specified wrapper token source;
not `config.yaml`, whose secret the proxy hashes, and not the env file, which stays
non-secret), then `exec claude "$@"`. Honest accounting caveat: wrapper-launched
processes are not daemon sessions — restart-refusal counts, "N sessions affected"
warnings, and proxy-down notifications cover daemon-managed sessions only. `claudex`
additionally supports
`--model <name>` (validated against the same charset rules, translated to the env
overrides before exec) so programmatic callers can pick Kimi/GPT per invocation instead
of being pinned to the env-file default. On PATH **in production** via the
systemd unit's baked PATH (`sessionPath()` does not add it — dev `.stage` won't resolve
them; acceptable, VPS-first). This makes both modes callable primitives from any session
(`claudex -p "…"`, stream-json) in addition to interactive tabs.

### 3. Daemon API, wire types, events

New routes under `/api/cliproxy`; **no secret material is ever returned** (not the
local key, not the management secret, not credential contents). **Transport authz is
explicit and asymmetric**: read-only routes (status, models, logs metadata) follow the
normal rule (bearer auth over remote HTTP, open over the local Unix socket like other
local routes). **Mutating routes (enable/disable/config/login/key/rotation) are
HTTP-transport-only with bearer auth — refused over the Unix socket.** Rationale: the
socket is unauthenticated by design and every agent session receives its path
(`ORQUESTER_DAEMON_SOCK`, for hook events); without this rule, any daemon-launched
agent — or a prompt-injected workflow — could silently mutate proxy credentials and
configuration:

- `GET  /api/cliproxy` — full status: manager state, version, per-provider status
  (`codex | claude | openrouter` → ok/missing/expired + last-verified), connected
  accounts (`{id, provider, label, email?}` — imported Claude accounts have labels, not
  emails; email is display-only, never the identity key), default model, active-session
  count, last CLI smoke-check result.
- `POST /api/cliproxy/enable` / `disable` — disable reports affected live sessions.
- `GET  /api/cliproxy/models` — proxied `/v1/models` (dropdown source).
- `PUT  /api/cliproxy/config` — `{ defaultModel, backgroundModel? }` (validated against
  catalog + charset). Per-launch choice rides `POST /api/sessions` via the new optional
  `model` field (same validation), not this route.
- `POST /api/cliproxy/login/start` — `{ provider, label? }` →
  `{ flowId, url, userCode?, expiresAt }`. `label` is required for Claude device auth
  (the credential carries no email; label is the display identity, matching the managed-
  account import convention).
- `GET  /api/cliproxy/login/status?flowId=…` — terminal states included:
  `pending | done | expired | superseded | error` (device codes expire ~15 min; starting
  a second flow **for the same provider** supersedes the previous one — flows for
  different providers run concurrently).
- `POST /api/cliproxy/login/cancel` — `{ flowId }`.
- `POST /api/cliproxy/accounts/seed` — **the primary credential path** (spike-proven):
  `{ provider: "codex"|"claude", accountId }` → the daemon reads that managed account's
  credential and **converts** it into CLIProxyAPI's auth-file schema, writing it 0600
  into `auth/` (see §4 for the field mappings). No browser flow. Auto-discovered by the
  proxy without restart. Returns the resulting provider status.
- `POST /api/cliproxy/openrouter/key` — set/import the OpenRouter key (stored in
  `secrets.json`, projected into `config.yaml`; the projection requires a proxy
  restart, so this route is restart-gated with the same force-confirm treatment —
  unlike credential seeding / device-auth completions, which land in `auth/` and are
  hot-discovered by the proxy without restart — spike-confirmed).
- `POST /api/cliproxy/login/callback` — `{ flowId, callbackUrlOrCode }`: relay for
  providers whose OAuth completes via a browser redirect to localhost. The proxy is
  loopback-only and Caddy exposes only Orquester, so a redirect can never reach the
  proxy directly — the user pastes the callback URL/code from their browser and the
  daemon submits it to the proxy's management API (which supports callback
  submission). The spike determines per provider whether pure device-code polling
  suffices or this relay is required.
- `GET  /api/cliproxy/logs/tail` — recent request **metadata only**: timestamp, model,
  provider, HTTP status, token counts. Request/response **bodies are never returned**
  (prompts routinely contain pasted secrets and file contents; header redaction alone
  is not secret-safe). Body logging is disabled in the generated proxy config by
  default; when enabled explicitly for debugging, full logs stay on disk, 0600,
  rotated, and still never cross this API.

Contract work is explicit scope: request/response types in `packages/api`
(`CliProxyStatus`, `CliProxyLoginState`, …), `ApiClient` methods, zustand store
state/actions, `cliproxy.changed` event handling with reconnect refetch, and
loading/error states — enumerated in the implementation plan, not improvised.
`cliproxy.json` and `secrets.json` get **versioned zod schemas, `safeParse`-with-
default loaders, and path helpers in `@orquester/config`**, per the repo's rule that
raw `JSON.parse` output never reaches typed code — a partial or older file must
degrade, not crash the daemon.

### 4. Credentials: seed by conversion from managed accounts (primary); device-auth fallback

**Spike-updated decision (2026-07-23): seed by file conversion first.** The sub-spike
proved both Codex and Claude OAuth seed into the proxy by converting the existing managed-
account credential into CLIProxyAPI's auth-file schema and dropping it in `auth/` — **no
browser/device flow**. This is the primary path (`POST /api/cliproxy/accounts/seed`):

- **Codex** → CLIProxyAPI `CodexTokenStorage` (`internal/auth/codex/token.go`), from the
  managed `auth.json`:

  | target field | source |
  |---|---|
  | `id_token` / `access_token` / `refresh_token` | `tokens.{id_token,access_token,refresh_token}` |
  | `account_id` | id_token claim `https://api.openai.com/auth`.`chatgpt_account_id` |
  | `email` | id_token claim `email` · `last_refresh` ← `last_refresh` |
  | `type` | literal `"codex"` · `expired` ← RFC3339 of access_token `exp` |

- **Claude** → `ClaudeTokenStorage` (`internal/auth/claude/token.go`), from the managed
  `.credentials.json`: `access_token`←`claudeAiOauth.accessToken`,
  `refresh_token`←`claudeAiOauth.refreshToken`, `expired`←RFC3339 of
  `claudeAiOauth.expiresAt` (ms→s), `type`=`"claude"`; `id_token`/`email` may be blank.

- **OpenRouter**: plain API key, no refresh — import from OpenCode's store
  (`~/.local/share/opencode/auth.json`, `openrouter.key` — confirmed present) or paste in
  Settings. Stored in `secrets.json` (authoritative); `config.yaml` carries the projection.

**The dual-refresher hazard is managed, not avoided by device-auth.** Two independent
refreshers of the same rotating refresh token invalidate each other. The spike sidestepped
it by seeding while the source access token was **fresh** (no refresh fired; managed files
untouched), but that's timing luck, not a design. The **owner rule**: once the proxy holds
a seeded copy, **Orquester stops refreshing that managed account** (the account service's
`ensureFreshForUsage`/idle refresh must skip accounts marked proxy-owned), so exactly one
refresher exists. Seeding records the `(provider, accountId)` → proxy-owned mapping;
un-seeding restores Orquester's ownership. A re-seed is always available if the chains ever
desync.

**Device-auth is the fallback**, not the primary — for accounts not already in Orquester,
or if conversion ever fails on a future credential format. It uses the proxy management
API (`codex-auth-url`/`anthropic-auth-url` + status polling) via the `login/*` routes; the
`login/callback` relay covers redirect-style flows since the proxy is loopback-only behind
Caddy. (Spike note: the management `status` path 404'd, but seeding sidesteps the
management API entirely; the login/* fallback still needs the management-API endpoints
verified in a Phase-2 step before that fallback UI is built.)

Multiple accounts of one provider round-robin automatically. **Health probes are
per-credential, not per-provider**: with N accounts round-robining, a provider-level
probe can hit only healthy accounts while user requests fail 1/N of the time on an
expired one — the provider status chip degrades if *any* registered credential fails
its probe. Rollback of a proxy version is a **manual explicit operation** (API action
that atomically swaps `bin.prev/` back and re-pins), not an automatic behavior.
**Accepted-risk note (ToS)**: routing ChatGPT/Codex and Claude *subscriptions* through
an API-emulating local proxy is the kind of use providers have historically restricted;
account-action risk is explicitly accepted by the user, same as the community guide
this design is based on.

**Credential concentration acknowledged**: `auth/` concentrates Codex OAuth + Claude
OAuth + OpenRouter key in one place, alongside (not instead of) the managed-account
stores. Rotation story: revoke upstream, delete the auth file, re-seed (or re-run device
auth). `/api/cliproxy` mutations carry the same remote-auth strength as account-management
routes.

### 5. Settings UI (`packages/ui`)

Settings → Agents gains a **"Model proxy"** section (value-first naming — not
mechanism-first) with two compact launcher rows (Claude × GPT / Claude × Mixed) over one
shared proxy panel:

- Manager state incl. `degraded`, with **per-provider status chips**
  (codex ✓ / claude ✓ / openrouter ✗) each with last-verified time.
- Connect actions per provider: **primary is "Seed from managed account"** — a
  one-click picker of the existing Claude/Codex accounts (spike-proven file conversion,
  no browser); a **device-code dialog** (resumable, copyable code, expiry countdown,
  cancel) is the fallback for accounts not in Orquester; OpenRouter import/paste.
- Default-model dropdown for `claudex` (sets the default launcher chip): **always
  renders the persisted selection even when the catalog fetch fails** ("proxy offline —
  list may be stale"); never blanks a saved value. Launcher-row model chips (GPT / Kimi
  / …) handle the per-launch pick; tab badges show the chosen model.
- Enable/disable with live-session impact confirm; disabled launchers show their
  `disabledReason` here and in the "+" menu.
- Distinct icons/colors for the two entries and tab badges showing the backing model —
  a usability requirement (ids differ by two letters), not end-stage polish.

### 6. Hooks, activity, usage

- **One canonical agent-family mapping** used by BOTH `configTarget()` and `install()`'s
  dispatch in `agent-hooks.ts` maps `claudex`/`claudemix` → claude-style hooks (fixing
  only `configTarget` would route them to the OpenCode-style installer). Hook installs
  target each entry's dedicated home of §2 via the launch-env `CLAUDE_CONFIG_DIR`.
  Tests cover install + activity for each id.
- **Usage attribution, honestly stated**: alias sessions carry no managed `accountId`.
  Transcript records discovered under the proxy homes are **tagged with the launcher
  id and excluded from the Claude aggregate** (the §2 contract — the scanner's current
  hardcoded `agent: "claude"` classification is changed as part of extending it; §2
  and this section state one contract, not two). Existing Codex/Claude account usage
  rows still reflect subscription burn (same accounts upstream), but per-session/
  per-model attribution for proxy traffic is **not** provided in this iteration; the
  proxy request log (§3 `logs/tail`) is the interim answer. Proper attribution is
  future work.

### 7. Kimi K3 / Moonshot: **no patch needed under Claude Code** (spike-resolved)

Research (empirical + CLIProxyAPI source) established that Moonshot's API rejects any
historical assistant message whose `content` is an empty string — even with `tool_calls`
— and that CLIProxyAPI's Anthropic→OpenAI translator emits exactly that shape
(`content: ""`) for a **bare** tool-call turn (no text). The original failure was
OpenCode-specific.

**The spike (2026-07-23) reproduced this NOT under Claude Code.** The `content: ""` line
is still present in v7.2.95 source, but Claude Code **pairs preamble text with its tool
calls** (`hasContent` is true), so the empty-content branch is never taken. A 24-tool-call
Kimi loop through the stock binary completed with **zero** `must not be empty` / 400s.

**Decision: ship the stock binary; do not patch.** For the Claude Code harness specifically
(both claudex and claudemix), Kimi works on the unmodified release. The one-line translator
fix (omit `content` when `tool_calls` present, gated on kimi/moonshot model names, matching
both the alias and resolved model strings) is kept **documented in
`deploy/cliproxy-patches/`** as defense-in-depth, to be applied only if a real `content:""`
400 is ever observed in the request log (e.g. from a subagent that emits a bare tool call).
Re-verify on any version bump — the bug line could change upstream. This removes the entire
Go-toolchain / source-build / patch-apply apparatus from Phase 2 (see §1).

Additional Kimi operational constraints for workflows: temperature range [0,1] (clamp
via `payload.override` — top-level params ARE config-reachable), `tool_choice:
"required"` is k3-only (not k2.6), and streaming can leak raw `<|tool_call…|>` control
tokens — the Phase-2 daemon-integration check confirms the response translator strips them.

### 8. Mixed-model workflows (`claudemix`) — verification spike gates the build

Inside one Fable session, Workflow scripts call `agent(prompt, {model: "gpt-5.6-sol"})`
or `{model: "kimi-k3"}` (or custom agent types with frontmatter-pinned models) and the
proxy routes each subagent to its provider. Canonical example: Fable plans, a Kimi K3
agent does the frontend/design work, Sol agents execute, then a three-model review panel
judges the result.

**Spike-resolved (2026-07-23):** the transport is proven on all three families — one proxy
instance seeded (by conversion) with Codex + Claude + OpenRouter served `gpt-5.6-sol`,
`claude-fable-5`/`claude-sonnet-5`, and `kimi-k3` from one `/v1/models`, and each was driven
functionally by `claude --model <x> -p`. What remains is **harness-level, not proxy-level**,
and is verified once `claudemix` runs against the daemon (a separate checkout / on deploy —
never the live daemon serving this workspace):

1. Non-Anthropic model strings accepted by Workflow `agent()` `opts.model` /
   `CLAUDE_CODE_SUBAGENT_MODEL` / agent frontmatter — which channel routes per-subagent
   (fallback order: frontmatter agentType → env → opts.model). (Transport proven; this is
   the harness routing knob.)
2. ~~Claude-subscription OAuth through the proxy for the main loop~~ — **DONE** (spike:
   `claude --model claude-sonnet-4-5` functional via seeded Claude OAuth).
3. **Real cost measurement**: a ~30-min claudex session vs a native Codex session —
   whether haiku-slot calls stay on the cheap `backgroundModel`. (Deferred pending explicit
   go-ahead — it spends real subscription quota.)
4. **Unknown-model error surface**: exact behavior when a workflow references a model
   absent from the catalog (harness retry? silent fallback? opaque subagent error) —
   feeds a pre-flight check: at claudemix launch, referenced/configured models are
   validated against `/v1/models` with a warning before work starts.
5. **Partial-failure behavior is a required authoring pattern, not documentation**: the
   canonical tri-model workflow ships with `agent()` calls wrapped, a configurable
   review quorum (default 2-of-3), and failures surfaced in the review output; the
   harness does not retry subagent provider errors, so the script owns degradation. The
   §Verification dry-run exercises a **forced** 1-of-3 reviewer failure.
6. ~~Kimi empty-content on a deep tool loop~~ — **DONE** (spike: 24-tool-call loop, zero
   400s on the stock binary). Still confirm control-token stripping and `claude-*`
   caching/latency during the Phase-2 dry-run.

Known trade-off: in `claudemix` sessions all Anthropic traffic transits the local proxy;
a proxy or CLI-version break can take that session type down. Stock `claude` stays
untouched as the always-works default — with the §1 CLI-coupling smoke check guarding
the inverse failure (CLI update breaking the proxy path first).

## Security

- Proxy binds `127.0.0.1` only; never exposed through Caddy/ufw.
- Generated local API key + management secret + OpenRouter key: `crypto.randomBytes`
  (generated ones), **authoritatively stored in `secrets.json`** (0600, fail-closed on
  corruption per §1); `config.yaml` holds only projected/hashed forms and the `token`
  file a derived copy for wrapper bins. Token delivered to daemon-launched sessions via
  the addon-env channel (0600 one-shot wrapper on tmux; direct child env on the local
  backend), never argv. Registry env remains non-secret by invariant. Redaction:
  registry `env` is stripped from all API responses/broadcasts (`publicEntry`) — that
  protects the wire, not `/proc`; same-UID visibility is accepted and documented.
- `/api/cliproxy` mutations are HTTP-bearer-only and refused over the Unix socket
  (agents hold the socket path; see §3).
- Auth dir 0700, credential files 0600; env dir 0700, atomic 0600 writes, symlink
  refusal; dotenv parsed as data, never `source`d; model names charset-validated.
- `config.yaml` and credential mutations get **the same hardening as the env files**
  (atomic writes, parent-realpath check, symlink refusal) — it holds more secrets than
  they do; 0600 alone is not the bar.
- Binary: pinned **stock release** version + per-platform SHA-256 verification + rollback
  copy (see §1). No source build / Go toolchain (removed per the spike).
- `/api/cliproxy` sits behind the daemon's standard remote bearer auth; login flows
  expire, are cancellable, and are single-in-flight per provider.

## Non-goals (this iteration)

- Generic multi-backend/provider framework (this is claudex-shaped, not a platform).
- Per-workspace or per-account model/backend selection.
- Per-session/per-model usage attribution and proxy cost dashboards (request log only).
- Exposing the proxy to anything but loopback.
- Windows/desktop-embedded daemon support (VPS/Linux first; entries stay disabled
  elsewhere, wrapper bins are production-PATH only).
- Sequencing claudex-GPT-first with Kimi gated on the upstream merge was considered
  and **rejected**: Kimi ships day one via the patched source build (explicit user
  decision; the source-build machinery is accepted cost).

## Implementation order (sketch for the plan)

1. Spike (§8, plus §7 Kimi gate probing + credential device-auth flows against a manual
   CLIProxyAPI install on separate paths). Findings feed the plan.
2. `CliProxyManager`: verified download, config generation, tmux lifecycle outside
   `orq-`, ownership-verified adoption, health/degraded probing, state, events.
3. Registry: entries, net-new `reresolve`/`setRuntimeState` + `disabledReason`, env-file
   generation + hardening, addon-env contributor for token + `CLAUDE_CONFIG_DIR`,
   wrapper bins, dedicated claude-home seeding.
4. `/api/cliproxy` routes + wire types + login flows.
5. Settings UI (Model proxy section) + launcher menu `disabledReason` + notifications.
6. Hooks family mapping + tests; polish (icons, tab badges).
7. Deploy, browser smoke test, real workflow dry-run — the full tri-model flow: Fable
   plans, Kimi designs, Sol executes, three-model cross-review.

## Verification

- `pnpm check` clean at every step.
- **Daemon test suite** (`apps/daemon` `pnpm test`, node --test — the repo DOES have
  one; AGENTS.md's "no test runner" is stale for the daemon): new tests for the reaper
  exclusion (restart does not kill the service session), env redaction + reload,
  runtime enable/disable with `disabledReason` (incl. the reresolve-vs-runtime-state
  race), stable-secret config rewrites, foreign-port conflict handling, hook-family
  dispatch for both new ids, wrapper-env parsing, per-launch model propagation +
  persistence across restart/reattach, two concurrent provider login flows, dedicated-
  home seeding (no `projects/` sharing) + usage-scanner coverage, `backgroundModel`
  restart persistence, rejection of Go toolchain auto-switching (`GOTOOLCHAIN=local`)
  and offline module compile (`GOPROXY=off`), wrapper-bin assertions
  (`CLAUDE_CONFIG_DIR` of the launched process + token sourced from the `token` file),
  management-API auth surviving a daemon restart (via `secrets.json`, not the hashed
  `config.yaml`), corrupt-`secrets.json` failing closed (no regeneration), cliproxy
  mutations refused over the Unix socket, `effectiveModel` validation when the request
  omits `model`, adoption probing before foreign classification, per-credential health
  degradation, the login callback relay, `logs/tail` returning metadata only, the
  patch gate matching both alias and resolved model names, and the raw-name service
  tmux methods.
- Never launch/restart a daemon against this checkout; live verification happens on
  deploy or a separate checkout, per AGENTS.md.
- Post-deploy: health curl, browser smoke test (`scripts/smoke-web.mjs`), CLI-coupling
  smoke (`claudex -p`), then an end-to-end claudex session + a claudemix workflow
  exercising a `gpt-*` subagent.
