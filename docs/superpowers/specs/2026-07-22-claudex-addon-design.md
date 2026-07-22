# claudex addon — Claude Code harness × GPT via managed CLIProxyAPI

Date: 2026-07-22 · Status: approved design, amended after tri-model review (Claude,
Codex, Kimi K3) + Moonshot-error research · pre-implementation

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

```
cliproxy/
  bin/cli-proxy-api   # release binary, SHA-256-verified install (see below)
  bin.prev/           # previous verified binary, kept for rollback
  config.yaml         # generated, 0600
  auth/               # 0700; provider credential JSONs, 0600, auto-refreshed by the proxy
  claude-home/        # dedicated CLAUDE_CONFIG_DIR for claudex/claudemix sessions (see §2)
  logs/               # proxy request log, rotated, 0600
  cliproxy.json       # manager state: enabled, pinned version + sha256, default model,
                      # tested claude-CLI version (see CLI-coupling below)
```

**Binary install.** Pinned version **and per-platform SHA-256 digest** (hardcoded per
release bump, updated deliberately). Download over HTTPS to a private temp file, verify
digest, then atomically install; keep the prior verified binary in `bin.prev/` for
rollback. Reject unsupported OS/arch. A pinned tag alone is not integrity verification.

**Generated `config.yaml`**: `host: 127.0.0.1`, `port: 8317`, one generated `api-keys`
entry (`crypto.randomBytes`), `remote-management.secret-key` (generated;
`allow-remote: false`), `auth-dir` pointing at `auth/`, request logging into `logs/`,
and — when an OpenRouter key is configured — an `openai-compatibility` provider
(`base-url: https://openrouter.ai/api/v1`) with model aliases so short names
(`kimi-k3` → `moonshotai/kimi-k3`) appear in the merged catalog.

**Reasoning-effort override is scoped, not blanket.** The community guide's
`payload.override` forcing `reasoning.effort: high` on all `gpt-*` must NOT apply to the
haiku-slot/background calls (`ANTHROPIC_DEFAULT_HAIKU_MODEL` routes title generation and
compaction through the proxy too — a blanket high-effort override silently bills cheap
bookkeeping calls as high-effort Sol). Either scope the override to the main model name
only, or drop it and rely on client-side effort env. The §8 spike measures real cost.

**Secrets are stable.** The local API key and management secret are generated once and
**persist across all ordinary config rewrites and restarts** — live sessions snapshot
their env at launch, so key regeneration would silently break every running claudex
session. Rotation is a separate, explicit operation that warns about/drains live
sessions first.

**Process model.** The proxy runs on the daemon's dedicated tmux server under a session
name **outside the `orq-` namespace** (e.g. `orqsvc-cliproxy`). This is load-bearing:
`SessionManager.reattach()` reaps any live `orq-*` tmux session missing from
`sessions.json`, so an `orq-`-named proxy would be killed on every daemon restart — the
opposite of the intended persistence. Requires either the distinct prefix (with
`listSessions()` scans untouched) or an explicit reserved-name exclusion in the reaper;
a daemon test must prove a restart does not reap the proxy session.

**Adoption is ownership-verified, not health-only.** On boot, in order: (1) check our
tmux server for the service session (owned → probe with our key, adopt or restart if
unhealthy); (2) no owned session but port 8317 answers → **foreign listener**: report
`error: port conflict`, never adopt or kill an unverified process; (3) otherwise spawn,
then poll readiness with bounded backoff. All transitions serialized; states:
`off | downloading | starting | healthy | degraded | error`. `degraded` = process up but
a configured provider is missing from `/v1/models` (expired OAuth, revoked key) — per-
provider status is part of manager state, from a real model-list probe, not just the port.

**Restart/disable honors live sessions.** Config changes that need a proxy restart are
refused (or require an explicit confirm) while any claudex/claudemix session is active;
the API returns the affected session count. Disable hides the launchers for new tabs but
must state that existing sessions keep targeting the (now dead) endpoint. When the proxy
dies unexpectedly, the daemon cross-references sessions routed through it and emits one
targeted notification ("proxy down — N GPT sessions affected") instead of letting each
tab surface raw connection-refused errors.

**CLI-coupling smoke check.** The claude CLI is a moving target and the proxy emulates
its API surface; a routine CLI update can break claudex/claudemix while stock `claude`
keeps working. `cliproxy.json` records the last claude-CLI version that passed the smoke
check; on version drift the manager re-runs a cheap `claudex -p` smoke test and surfaces
mismatch as `degraded` with a reason.

Fallback without tmux: direct child process, no persistence, explicit graceful
termination on shutdown (same degradation the session manager accepts).

### 2. Registry entries, env files, dedicated home, wrapper bins

Two new static agent entries in `packages/registry/src/index.ts`, both `bin: ["claude"]`,
with **explicitly specified `args`** (decide per entry whether to inherit stock claude's
`--dangerously-skip-permissions --effort max --verbose`; `bin` alone inherits nothing):

| id | Display name | Main model | Role |
|---|---|---|---|
| `claudex` | Claude × GPT | configurable, default `gpt-5.6-sol` | pure GPT escape hatch |
| `claudemix` | Claude × Mixed | Fable (Claude OAuth via proxy) | mixed-model orchestrator |

Distinct ids are load-bearing: `resolveLaunchEnv` (agent-accounts.ts) only matches
`claude`/`codex`, so these entries never get a managed account home and never hit the
`unset ANTHROPIC_AUTH_TOKEN` that would strip the proxy token.

**Dedicated config home (not the shared system `~/.claude`).** Sessions launch with
`CLAUDE_CONFIG_DIR=<appdir>/daemon/cliproxy/claude-home` so GPT/Kimi-authored transcripts
never interleave with native-Fable history (`--resume` poisoning, concurrent-write
hazards). Skills/plugins are symlinked in from the system dir; settings seeded the same
way `syncAccountHome` seeds managed homes (minus identity). This also gives claudemix
transcripts a home whose contents are known to be proxy-routed — the closest available
answer to "which model did this."

**Secret/non-secret env split (two channels, per the codebase's own invariant).**
Registry `entry.env` reaches sessions via `tmux new-session -e` — argv-visible in
`/proc`; sessions.ts documents it as non-secret. Therefore:

- `<appdir>/daemon/env/claudex.env` (generated) carries **non-secrets only**:
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`,
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3`, `ENABLE_TOOL_SEARCH=false`,
  `CLAUDE_CODE_NO_FLICKER=1`. (`claudemix.env`: base URL + flags only; main model stays
  the CLI default. Exact set refined by the spike.)
- **`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CONFIG_DIR` travel the addon-env channel**: a new
  contributor in the `resolveExtraEnv` path returns them for these entry ids, so they are
  injected via the existing 0600 one-shot wrapper script (`writeAddonEnvLaunchScript`),
  never `-e` argv. Note honestly: the token still ends up in the claude process
  environment (`/proc/<pid>/environ`, same-UID readable) — 0600 files and loopback do not
  isolate secrets from other processes running as the same user.

**Env-file hardening** (net-new; the current code only reads the path): `env/` dir 0700;
atomic 0600 writes; refuse symlinked targets; values validated (model names restricted to
`[A-Za-z0-9._/-]`) — and wrapper bins **parse** the dotenv file as data rather than
`source`-ing it as shell, eliminating the injection vector.

**Net-new `RegistryService` API** (does not exist today; env files are read only at
`init()` and `enabled` has no public setter): `reresolve(id)` (re-reads env file + bin,
preserves install state, re-broadcasts sanitized entry) and
`setRuntimeState(id, { enabled, disabledReason? })`. Entries whose proxy/credentials go
away become **visible-but-disabled with a reason** (`"proxy down"`, `"codex auth
expired"`) rather than vanishing from the "+" menu; `RegistryEntry` gains an optional
`disabledReason` field surfaced in both the launcher menu and the Settings card.

**Wrapper bins** `<appdir>/.npm-global/bin/claudex` and `.../claudemix` (0700): parse the
env file + read the token, then `exec claude "$@"`. On PATH **in production** via the
systemd unit's baked PATH (`sessionPath()` does not add it — dev `.stage` won't resolve
them; acceptable, VPS-first). This makes both modes callable primitives from any session
(`claudex -p "…"`, stream-json) in addition to interactive tabs.

### 3. Daemon API, wire types, events

New routes under `/api/cliproxy`, protected by the same remote-HTTP bearer auth as every
`/api` route; **no secret material is ever returned** (not the local key, not the
management secret, not credential contents):

- `GET  /api/cliproxy` — full status: manager state, version, per-provider status
  (`codex | claude | openrouter` → ok/missing/expired + last-verified), connected
  accounts (`{id, provider, label, email?}` — imported Claude accounts have labels, not
  emails; email is display-only, never the identity key), default model, active-session
  count, last CLI smoke-check result.
- `POST /api/cliproxy/enable` / `disable` — disable reports affected live sessions.
- `GET  /api/cliproxy/models` — proxied `/v1/models` (dropdown source).
- `PUT  /api/cliproxy/config` — `{ defaultModel }` (validated against catalog + charset).
- `POST /api/cliproxy/login/start` — `{ provider }` → `{ url, userCode?, expiresAt }`.
- `GET  /api/cliproxy/login/status` — terminal states included:
  `pending | done | expired | superseded | error` (device codes expire ~15 min; starting
  a second flow supersedes the first).
- `POST /api/cliproxy/login/cancel`
- `POST /api/cliproxy/openrouter/key` — set/import the OpenRouter key.
- `GET  /api/cliproxy/logs/tail` — recent proxy request log, auth headers redacted.

Contract work is explicit scope: request/response types in `packages/api`
(`CliProxyStatus`, `CliProxyLoginState`, …), `ApiClient` methods, zustand store
state/actions, `cliproxy.changed` event handling with reconnect refetch, and
loading/error states — enumerated in the implementation plan, not improvised.

### 4. Credentials: proxy-owned device auth first; import is opt-in with a caveat

**Reversal of the earlier "import first" decision, for OAuth providers.** Cloning a
managed account's OAuth blob into the proxy creates two independent refreshers of the
same (rotating, effectively single-use) refresh token — Orquester's account service
already serializes refreshes precisely because concurrent refreshers invalidate each
other. So:

- **Primary: separate device authorization owned by the proxy** (management API
  `codex-auth-url`/`anthropic-auth-url` + status polling, or `-codex-device-login`
  parsing). One-time URL+code per provider; tokens then self-refresh under a single
  owner (the proxy). UI shows the code copyable + deep link, and the dialog re-renders
  from `login/status` on open so a reconnected client resumes instead of hanging.
- **Optional: import from a managed account**, offered with an explicit warning that the
  source account's refresh chain may be invalidated and it should not remain in dual use.
  (Kept because it's occasionally the only path, e.g. providers throttling new device
  auths.)
- **OpenRouter**: plain API key, no refresh semantics — import from OpenCode's store
  (`~/.local/share/opencode/auth.json`, `openrouter.key` — confirmed present on this
  host) or paste in Settings. Key lands only in the proxy's `config.yaml` (0600).

Multiple accounts of one provider round-robin automatically.

**Credential concentration acknowledged**: `auth/` concentrates Codex OAuth + Claude
OAuth + OpenRouter key in one place, alongside (not instead of) the managed-account
stores. Rotation story: revoke upstream, delete the auth file, re-run device auth.
`/api/cliproxy` mutations carry the same remote-auth strength as account-management
routes.

### 5. Settings UI (`packages/ui`)

Settings → Agents gains a **"Model proxy"** section (value-first naming — not
mechanism-first) with two compact launcher rows (Claude × GPT / Claude × Mixed) over one
shared proxy panel:

- Manager state incl. `degraded`, with **per-provider status chips**
  (codex ✓ / claude ✓ / openrouter ✗) each with last-verified time.
- Connect actions per provider: device-code dialog (resumable, copyable code, expiry
  countdown, cancel), opt-in import-from-managed-account (with the dual-refresher
  warning), OpenRouter import/paste.
- Default-model dropdown for `claudex`: **always renders the persisted selection even
  when the catalog fetch fails** ("proxy offline — list may be stale"); never blanks a
  saved value.
- Enable/disable with live-session impact confirm; disabled launchers show their
  `disabledReason` here and in the "+" menu.
- Distinct icons/colors for the two entries and tab badges showing the backing model —
  a usability requirement (ids differ by two letters), not end-stage polish.

### 6. Hooks, activity, usage

- **One canonical agent-family mapping** used by BOTH `configTarget()` and `install()`'s
  dispatch in `agent-hooks.ts` maps `claudex`/`claudemix` → claude-style hooks (fixing
  only `configTarget` would route them to the OpenCode-style installer). Hook installs
  target the dedicated `claude-home` of §2. Tests cover install + activity for each id.
- **Usage attribution, honestly stated**: alias sessions carry no managed `accountId`,
  and transcript scanning classifies Claude-harness records as `claude` regardless of
  the proxied provider. Existing Codex/Claude account usage rows still reflect
  subscription burn (same accounts upstream), but per-session/per-model attribution for
  proxy traffic is **not** provided in this iteration; the proxy request log
  (§3 `logs/tail`) is the interim answer. Proper attribution is future work.

### 7. Kimi K3 / Moonshot: the translator patch is a hard gate

Research (empirical + CLIProxyAPI source) established: Moonshot's API rejects any
historical assistant message whose `content` is an empty string — even with `tool_calls`
— and CLIProxyAPI's Anthropic→OpenAI translator **manufactures exactly that shape**
(`content: ""`) for every tool-only assistant turn. Claude-harness agents emit bare
tool-call turns constantly, so unpatched, Kimi subagents fail on essentially every deep
tool loop ("…message at position N with role 'assistant' must not be empty").
OpenRouter does not sanitize (it relays Moonshot's 400 verbatim), provider-pinning to
OSS hosts trades this for ~87% broken tool-call *generation*, Moonshot-direct hits the
same validator, and the proxy's `payload.override` config cannot reach the `messages`
array. The only correct layer is the translator itself: omit `content` when
`tool_calls` are present (spec-valid OpenAI; the fix OpenCode/OpenClaw shipped), ideally
gated on kimi/moonshot model names, plus `reasoning_content` handling if thinking mode
is ever enabled.

**Build strategy (explicit, resolves the fork-vs-upstream contradiction):**

1. Upstream the one-line translator fix to CLIProxyAPI (tiny, spec-correct, benefits all
   users).
2. Until a release containing it is pinned, the **`kimi-k3` alias is not configured** —
   Kimi routing is gated on the fix being present in the shipped binary. claudex/
   claudemix work fully with gpt-*/claude-* meanwhile.
3. If upstreaming stalls, fall back to a maintained patched build (documented patch file
   in-repo, applied to the pinned source tag, built in CI or on the VPS) — a deliberate
   commitment, recorded here, not an implicit assumption.

Additional Kimi operational constraints for workflows: temperature range [0,1] (clamp
via `payload.override` — top-level params ARE config-reachable), `tool_choice:
"required"` is k3-only (not k2.6), and streaming can leak raw `<|tool_call…|>` control
tokens — the spike checks the response translator strips them.

### 8. Mixed-model workflows (`claudemix`) — verification spike gates the build

Inside one Fable session, Workflow scripts call `agent(prompt, {model: "gpt-5.6-sol"})`
or `{model: "kimi-k3"}` (or custom agent types with frontmatter-pinned models) and the
proxy routes each subagent to its provider. Canonical example: Fable plans, a Kimi K3
agent does the frontend/design work, Sol agents execute, then a three-model review panel
judges the result.

The spike (separate checkout / on deploy — never the live daemon serving this
workspace) must verify:

1. Non-Anthropic model strings accepted by Workflow `agent()` `opts.model` /
   `CLAUDE_CODE_SUBAGENT_MODEL` / agent frontmatter — which channel is reliable
   (fallback order: frontmatter agentType → env → opts.model).
2. Claude-subscription OAuth through CLIProxyAPI for the main loop (auth, streaming,
   tool use).
3. **Real cost measurement**: a ~30-min claudex session vs a native Codex session —
   specifically whether haiku-slot calls escape the effort override scoping of §1.
4. **Unknown-model error surface**: exact behavior when a workflow references a model
   absent from the catalog (harness retry? silent fallback? opaque subagent error) —
   feeds a pre-flight check: at claudemix launch, referenced/configured models are
   validated against `/v1/models` with a warning before work starts.
5. **Partial-failure behavior**: the canonical tri-model workflow must handle 1-of-3
   reviewer failure (OpenRouter latency, translation error) gracefully; document that
   the harness does not retry subagent provider errors.
6. Kimi path (once §7 gate passes): empty-content fix verified end-to-end, control-token
   leakage checked, prompt-caching/latency on the `claude-*` path acceptable.

Known trade-off: in `claudemix` sessions all Anthropic traffic transits the local proxy;
a proxy or CLI-version break can take that session type down. Stock `claude` stays
untouched as the always-works default — with the §1 CLI-coupling smoke check guarding
the inverse failure (CLI update breaking the proxy path first).

## Security

- Proxy binds `127.0.0.1` only; never exposed through Caddy/ufw.
- Generated local API key + management secret: `crypto.randomBytes`, stored only in
  `config.yaml` (0600); token delivered to sessions via the 0600 addon-env wrapper, not
  argv. Registry env remains non-secret by invariant. Redaction: registry `env` is
  stripped from all API responses/broadcasts (`publicEntry`) — that protects the wire,
  not `/proc`; same-UID visibility is accepted and documented.
- Auth dir 0700, credential files 0600; env dir 0700, atomic 0600 writes, symlink
  refusal; dotenv parsed as data, never `source`d; model names charset-validated.
- Binary: pinned version + SHA-256 verification + rollback copy (see §1).
- `/api/cliproxy` sits behind the daemon's standard remote bearer auth; login flows
  expire, are cancellable, and are single-in-flight per provider.

## Non-goals (this iteration)

- Generic multi-backend/provider framework (this is claudex-shaped, not a platform).
- Per-workspace or per-account model/backend selection.
- Per-session/per-model usage attribution and proxy cost dashboards (request log only).
- Exposing the proxy to anything but loopback.
- Windows/desktop-embedded daemon support (VPS/Linux first; entries stay disabled
  elsewhere, wrapper bins are production-PATH only).

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
7. Deploy, browser smoke test, real workflow dry-run (Fable plans → Sol executes →
   cross-review; Kimi joins once §7 gate passes).

## Verification

- `pnpm check` clean at every step.
- **Daemon test suite** (`apps/daemon` `pnpm test`, node --test — the repo DOES have
  one; AGENTS.md's "no test runner" is stale for the daemon): new tests for the reaper
  exclusion (restart does not kill the service session), env redaction + reload,
  runtime enable/disable with `disabledReason`, stable-secret config rewrites, foreign-
  port conflict handling, hook-family dispatch for both new ids, and wrapper-env
  parsing.
- Never launch/restart a daemon against this checkout; live verification happens on
  deploy or a separate checkout, per AGENTS.md.
- Post-deploy: health curl, browser smoke test (`scripts/smoke-web.mjs`), CLI-coupling
  smoke (`claudex -p`), then an end-to-end claudex session + a claudemix workflow
  exercising a `gpt-*` subagent.
