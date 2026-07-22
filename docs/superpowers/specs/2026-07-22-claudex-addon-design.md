# claudex addon — Claude Code harness × GPT via managed CLIProxyAPI

Date: 2026-07-22 · Status: approved design, pre-implementation

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
            ├─ gpt-*      → OpenAI Codex backend (Codex OAuth, from managed Codex account)
            ├─ claude-*   → Anthropic API (Claude OAuth, from managed Claude account)
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
  bin/cli-proxy-api   # pinned linux_amd64 release binary, downloaded on first enable (HTTPS, pinned version — no "latest")
  config.yaml         # generated, 0600
  auth/               # 0700; provider credential JSONs, 0600, auto-refreshed by the proxy
  cliproxy.json       # manager state: enabled, pinned version, default model
```

Generated `config.yaml`: `host: 127.0.0.1`, `port: 8317`, one generated `api-keys` entry
(`crypto.randomBytes`), `remote-management.secret-key` (generated; `allow-remote: false`),
`auth-dir` pointing at `auth/`, `payload.override` forcing `reasoning.effort: high`
on `gpt-*`/codex requests, and — when an OpenRouter key is configured — an
`openai-compatibility` provider (`base-url: https://openrouter.ai/api/v1`) with model
aliases so short names (`kimi-k3` → `moonshotai/kimi-k3`) appear in the merged catalog.

Process model: the proxy runs as `orq-cliproxy` on the daemon's **existing dedicated tmux
server**, so it survives daemon restarts exactly like sessions do. On boot the manager
health-checks `127.0.0.1:8317` and adopts a live proxy instead of respawning. Lifecycle
mirrors `BrowserManager`: lazy spawn, health probe, eviction on death, `shutdown()` leaves
tmux-hosted proxy running (like sessions). Without tmux: direct child, no persistence
(same degradation the session manager accepts).

Config changes that require it trigger a proxy restart; default-model changes do not
(model selection is client-side env).

### 2. Registry entries + env files + wrapper bins

Two new static agent entries in `packages/registry/src/index.ts`, both `bin: ["claude"]`:

| id | Main model | Role |
|---|---|---|
| `claudex` | configurable, default `gpt-5.6-sol` | pure GPT escape hatch |
| `claudemix` | Fable (Claude OAuth via proxy) | mixed-model orchestrator |

- Distinct ids are load-bearing: `resolveLaunchEnv` (agent-accounts.ts) only matches
  `claude`/`codex`, so these entries never get a managed home and — critically — never
  hit the `unset ANTHROPIC_AUTH_TOKEN` that would strip the proxy token. Sessions run
  under System identity and share the system `~/.claude` (skills, settings, history).
- `enabled` is driven by the proxy manager: entry is enabled only when the proxy is
  enabled + healthy + has the needed provider credentials (`claudex` → Codex creds;
  `claudemix` → both). Toggled via a registry hook + `registry.changed` broadcast.
- The daemon **generates** the per-launcher env files (existing secret-safe channel;
  redacted from every API response by `publicEntry`):

  `<appdir>/daemon/env/claudex.env`
  ```
  ANTHROPIC_BASE_URL=http://127.0.0.1:8317
  ANTHROPIC_AUTH_TOKEN=<generated local key>
  ANTHROPIC_MODEL=<configured, default gpt-5.6-sol>
  ANTHROPIC_DEFAULT_HAIKU_MODEL=<same>
  CLAUDE_CODE_SUBAGENT_MODEL=<same>
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1
  CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3
  ENABLE_TOOL_SEARCH=false
  CLAUDE_CODE_NO_FLICKER=1
  ```

  `<appdir>/daemon/env/claudemix.env`: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` +
  `CLAUDE_CODE_NO_FLICKER=1` only — main model stays the CLI default (Fable), `gpt-*`
  reachable by subagents/workflows. (Exact env set to be refined during the verification
  spike; e.g. whether haiku/background-model routing needs pinning.)

  Model changes rewrite the file and re-resolve the registry entry (env files are read at
  resolve time), so new sessions pick them up immediately.
- **Wrapper bins** `<appdir>/.npm-global/bin/claudex` and `.../claudemix` (0700, already
  on every session's PATH): source the matching env file, `exec claude "$@"`. No secrets
  in the script itself. This makes both modes callable primitives from any session
  (`claudex -p "…"`, stream-json, etc.) in addition to interactive tabs.

### 3. Daemon API + events

New routes under `/api/cliproxy` (allowed over remote HTTP; **no secret material is ever
returned** — not the local key, not the management secret, not credential contents):

- `GET  /api/cliproxy` — status: enabled, running/health state, version, connected provider
  accounts (emails only), default model.
- `POST /api/cliproxy/enable` / `POST /api/cliproxy/disable`
- `GET  /api/cliproxy/models` — proxied from the proxy's `/v1/models` (feeds the dropdown).
- `PUT  /api/cliproxy/config` — `{ defaultModel }`.
- `POST /api/cliproxy/accounts/import` — `{ provider: "codex"|"claude", accountId }`:
  seed proxy credentials from an already-imported managed account.
- `POST /api/cliproxy/login/start` — `{ provider }`: begin device-code/OAuth flow;
  returns URL (+ user code where applicable).
- `GET  /api/cliproxy/login/status` — poll until authorized.

A `cliproxy.changed` event on `/events` keeps clients live.

### 4. Credentials: import first, fall back to device-code

- **Import path (preferred)**: read the managed account's credential blob (Codex
  `auth.json` / Claude `.credentials.json`), convert/upload into the proxy's auth dir —
  via the management credential-upload API if it accepts the format, else a direct file
  write in the proxy's own JSON shape — then verify `/v1/models` includes the provider's
  models.
- **Fallback**: device-code / no-browser OAuth driven by the daemon (management API
  `codex-auth-url`/`anthropic-auth-url` + `get-auth-status`, or spawning the binary with
  `-codex-device-login` and parsing URL + code). UI shows the URL and code; user completes
  it on any device; daemon polls to completion.
- Tokens self-refresh afterwards (proxy background workers). Multiple accounts of the
  same provider round-robin automatically.
- **API-key providers (OpenRouter)**: no OAuth at all. Import reads the key from
  OpenCode's store (`~/.local/share/opencode/auth.json`, `openrouter.key` — confirmed
  present on this host, 0600), or the user pastes a key in Settings. The key lands only
  in the proxy's `config.yaml` (0600); like all credentials it is never returned by any
  route. Provider is optional — `claudex`/`claudemix` enablement does not depend on it.

### 5. Settings UI (`packages/ui`)

Settings → Agents gains a "Claudex — GPT via Claude harness" card:

- Proxy status: off / downloading / starting / healthy / error, with version.
- Connected provider accounts (emails), with Connect actions per provider
  (import-from-managed-account buttons, device-code fallback dialog showing URL + code).
- OpenRouter row: "Import from OpenCode" (when its auth.json has a key) or paste-a-key
  field; shows connected state only, never the key.
- Default model dropdown for `claudex` (from `/api/cliproxy/models`).
- Enable/disable toggle.

The "+" launcher menu needs no changes — `claudex`/`claudemix` appear when their entries
become enabled, like any agent.

### 6. Hooks, activity, usage

- `agent-hooks.ts` `configTarget()` gets `claudex`/`claudemix` cases aliased to the
  `claude` behavior, so these sessions report working/waiting/finished activity and fire
  the same push notifications.
- Usage: no new panel. GPT consumption bills the ChatGPT subscription, already tracked by
  the existing per-account Codex usage rows; `claudemix` Anthropic consumption bills the
  Claude account, already tracked likewise.

### 7. Mixed-model workflows (`claudemix`) — verification spike first

The point of `claudemix`: inside one Fable session, Workflow scripts call
`agent(prompt, {model: "gpt-5.6-sol"})` or `{model: "kimi-k3"}` (or use custom agent
types whose frontmatter pins the model) and the proxy routes each subagent request to
its provider — Codex backend, OpenRouter, or Anthropic — while the main loop stays on
Fable via Claude OAuth. Canonical example: Fable plans, a Kimi K3 agent does the
frontend/design work, Sol agents execute, then a three-model review panel judges the
result.

Before building UI on top, a spike must verify (in a separate checkout / on deploy —
never against the live daemon serving this workspace):

1. Non-Anthropic model strings are accepted by Workflow `agent()` `opts.model` /
   `CLAUDE_CODE_SUBAGENT_MODEL` / agent-definition frontmatter — and which of the three
   is the reliable channel (fallback order: frontmatter agentType → env → opts.model).
2. Claude-subscription OAuth through CLIProxyAPI works for the main loop (supported
   provider, but smoke-test: auth, streaming, tool use).
3. Prompt caching and effort flags survive the proxy hop on the `claude-*` path without
   pathological cost/latency regressions.
4. OpenRouter routing: `kimi-k3` alias resolves via `openai-compatibility`, tool use and
   streaming behave in the Claude harness (cheap check — plain API key, no OAuth).

Known trade-off: in `claudemix` sessions all Anthropic traffic transits the local proxy —
a proxy bug or version bump can break that session type. The stock `claude` entry stays
untouched as the always-works default; blast radius is contained to the two new entries.

## Security

- Proxy binds `127.0.0.1` only; never exposed through Caddy/ufw.
- Generated local API key + management secret: `crypto.randomBytes`, stored only in
  `config.yaml` (0600) and env files (redacted channel); never returned by any route.
- Auth dir 0700, credential files 0600 (proxy's own defaults, verified by the manager).
- Release binary: pinned version over HTTPS from GitHub releases; version bumps are an
  explicit manager action, not automatic.
- Wrapper bins contain no secrets (they source the 0600 env file at exec time).
- Existing guarantees hold: registry `env` is stripped from all API responses and
  broadcasts (`publicEntry`); nothing about the proxy weakens the auth model of the
  daemon itself.

## Non-goals (this iteration)

- Generic multi-backend/provider framework (this is claudex-shaped, not a platform).
- Per-workspace or per-account model/backend selection.
- Proxy-level usage/cost dashboards (management API has usage endpoints — later).
- Exposing the proxy to anything but loopback.
- Windows/desktop-embedded daemon support for the proxy (VPS/Linux first; entries simply
  stay disabled elsewhere).

## Implementation order (sketch for the plan)

1. Spike: manual CLIProxyAPI on the VPS (separate paths), verify import-conversion of
   managed-account creds + the three §7 checks. Findings feed the plan.
2. `CliProxyManager` (download, config, tmux lifecycle, health, state, events).
3. Registry entries + env-file generation + enabled-flag wiring + wrapper bins.
4. `/api/cliproxy` routes + auth flows (import + device-code).
5. Settings UI card.
6. Hooks aliasing + polish (labels, icons, tab naming).
7. Deploy, browser smoke test, real workflow dry-run (Fable plans → Sol executes →
   cross-review).

## Verification

- `pnpm check` clean at every step (repo has no test runner).
- Never launch/restart a daemon against this checkout; live verification happens on
  deploy or a separate checkout, per AGENTS.md.
- Post-deploy: health curl, browser smoke test (`scripts/smoke-web.mjs`), then an
  end-to-end claudex session + a claudemix workflow exercising a `gpt-*` subagent.
