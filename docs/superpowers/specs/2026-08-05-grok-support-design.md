# Grok Support — Design

**Date:** 2026-08-05
**Status:** Approved (brainstorm 2026-08-05)
**Scope:** Two independent features: **(A)** xAI's Grok Build terminal agent as an installable
registry agent with structural hook/push coverage, and **(B)** Grok models in the `claudex`
launcher via a new **xAI OAuth account** provider kind in the model proxy, backed by the user's
SuperGrok Heavy subscription. Out of scope: an xAI API-key router preset, grok managed
multi-accounts, grok usage/quota reporting, claudemix model chips.

## Background / verified facts (2026-08-05)

### Grok Build (the agent)

- Official product: **Grok Build**, repo `xai-org/grok-build` (Rust, Apache-2.0, source-available,
  no external contributions), npm package **`@xai-official/grok`** (weekly stable / near-daily
  alpha), binary **`grok`**, Linux x64/arm64 first-class. Node ≥ 20 required.
- The npm trampoline unpacks the platform binary into `$GROK_HOME/bin` (default `~/.grok`) —
  on the VPS that resolves under `/var/lib/orquester` (`HOME` is set there), inside
  `ReadWritePaths`. The curl installer is NOT used (it adds a second `agent` symlink on PATH and
  edits shell rc files).
- `grok --version` prints `X.Y.Z (shortsha) [channel]` on one line — fits the existing 80-char
  version capture. (`grok version --json` exists but the registry's single-flag probe is enough.)
- Auth: OAuth via `grok login`, with **`grok login --device-auth`** for headless/SSH (the VPS
  case); tokens persist in `~/.grok/auth.json` (0600). `XAI_API_KEY` is a documented fallback we
  don't need.
- Auto-update must be disabled under a managed daemon: `GROK_DISABLE_AUTOUPDATER=1`.
- Hooks: native hook system discovered from `~/.grok/hooks/*.json` (also reads
  `~/.claude/settings.json` — deliberately NOT used here, see A.2). Events include `Stop`
  (fires on genuine turn completion with `reason:"end_turn"`; also fires observe-only at session
  end with `reason:"channel_closed"|"shutdown"`; a handler returning JSON can BLOCK the stop),
  `Notification`, `PermissionDenied`, `UserPromptSubmit`, `PreToolUse`. Handlers get event JSON
  (camelCase) on stdin; failures fail open.
- Auto-approve flag: `--yolo`.

### xAI OAuth through CLIProxyAPI (the models)

- The `router-for-me/CLIProxyAPI` fork we supervise has **native xAI OAuth support**. It
  authenticates with the official Grok CLI's public OAuth client id and routes chat to
  **`https://cli-chat-proxy.grok.com/v1`** — the subscription-backed Grok Build backend, NOT the
  pay-per-token `api.x.ai` (`auth_kind:"oauth"` ⇒ `using_api:false`). Heavy-plan quota flows
  through this path.
- Login is an **RFC 8628 device-code flow, fully drivable via the management API** (no callback,
  no listener, no browser on the VPS):
  `GET /v0/management/xai-auth-url` (bearer = management secret) →
  `{url, user_code, state, flow:"device", expires_in:1800}`; poll
  `GET /v0/management/get-auth-status?state=…` → `wait|ok|error`; cancel via
  `DELETE /v0/management/oauth-session?state=…`. The proxy's background goroutine exchanges the
  token and **writes the auth file itself**.
- Auth file: `auth/xai-<email>.json` (email/sub/millis fallbacks, sanitized), shape
  `{type:"xai", auth_kind:"oauth", access_token, refresh_token, id_token, expired, last_refresh,
  email, sub, …}` — same auth dir the daemon already manages
  (`<appdir>/daemon/cliproxy/auth/`), hot-discovered like seeded codex/claude files.
- Refresh is **proxy-owned** (5-min lead, singleflight, rotation persisted). CLIProxyAPI does
  not read the Grok CLI's `~/.grok/auth.json` and we don't either — the device flow is the sole
  credential path for part B.
- Model catalog is CLIProxyAPI's static embedded list (no entitlement query). Relevant:
  **`grok-build-0.1`** (256k ctx, 256k max output, coding-trained, no thinking config) and
  **`grok-4.5`** (500k ctx, `zero_allowed:false` — **reasoning cannot be disabled**).
- ⚠️ Known sharp edges (accepted by the user in brainstorm):
  - CLIProxyAPI **impersonates the first-party Grok CLI** (spoofed `x-grok-client-identifier:
    grok-shell` headers, pinned client version constant) against an undocumented endpoint. This
    is a reverse-engineered contract: xAI version-gating it breaks Grok-via-proxy until
    CLIProxyAPI updates and we redeploy. Exposure is rate-limiting/account action against the
    $300/mo subscription. No ban reports found.
  - **No quota readout exists** (the management panel's quota fetch 400s; upstream issue #3883
    closed not-planned). On quota exhaustion the upstream 429 body is
    `subscription:…-usage-exhausted` and CLIProxyAPI silently **cools that account for 24 h**.
  - `grok-4.5`'s forced reasoning collides with Claude Code's ~30 s non-streaming
    security-classifier call (TTFB = full reasoning time) → intermittent Bash-approval stalls.
    Hence `grok-build-0.1` is the default pick.
  - xAI's `api.x.ai` returns **HTTP 400** (not 401/403) for a bad API key — irrelevant here
    (no keys in part B) but recorded for any future xAI router preset.

## Decisions (from brainstorm)

1. **Proxy path:** xAI OAuth account via the management-API device flow, proxy-owned. No
   API-key router preset, no OpenRouter changes. ToS/fragility caveat explicitly accepted.
2. **Agent scope:** registry entry + hook/push coverage. No managed accounts, no usage source.
3. **UI surface:** extend `claudex` (chips union, like router models). claudemix keeps zero
   model chips. No new launcher.
4. **Model list:** curated pair `grok-build-0.1` (default) + `grok-4.5` (opt-in, caveat in
   description). No new `/model` slot — the Fable slot stays kimi; chips are the surface
   (consistent with the router-providers spec's deferred slot-assignment decision).
5. **Mechanism separation:** xai is a **new provider kind** in the cliproxy subsystem — not a
   router provider (`routerKeys`/`keyState` don't apply: there is no key) and not an
   `AgentAccountAgent` family (there is no importable CLI blob, no Orquester-side refresh, no
   home-dir seeding). `AgentAccountAgent` stays `"claude" | "codex"`.

---

## Part A — Grok Build agent

### A.1 Registry entry + icon

`packages/registry/src/index.ts`, inserted after `opencode` (managed entries stay last):

```ts
{
  id: "grok",
  name: "Grok Build",
  kind: "agent",
  bin: ["grok"] as const,
  args: ["--yolo"] as const,                 // auto-approve, codex `--yolo` precedent
  env: { GROK_DISABLE_AUTOUPDATER: "1" },    // managed install must never self-update
  versionFlag: "--version",
  installCmd: "npm install -g @xai-official/grok",
  installCmdWin32: "npm install -g @xai-official/grok",
  updateCmd: "npm update -g @xai-official/grok"
}
```

UI: new `packages/ui/src/icons/agents/grok.svg` + import and `specific`-map line in
`packages/ui/src/icons/registry-icons.tsx`.

Everything else is inherited from the data-driven registry runtime: bin resolution/enabled
gating, Settings → Agents row with Install/Update, background version detection, "+" new-tab
row, tab-strip icon, MCP `list_launchers`/`create_tab`, and the per-launcher env file
`<appdir>/daemon/env/grok.env` (for future proxy/env needs; document like
`deploy/opencode.env.example` only if a real need appears — no example file ships now).

Login UX (no code): the user opens a Grok tab once and runs `grok login --device-auth`;
credentials persist in `~/.grok/auth.json` across sessions and restarts.

### A.2 Hook/push coverage (structural "finished" / "needs input")

The hook-reporting set is widened from three sources to four. Touchpoints (all existing
id-gated seams):

- `packages/api/src/index.ts` — `AgentEventSource` gains `"grok"`.
- `apps/daemon/src/index.ts` (agent-event route) — source whitelist gains `"grok"` (route stays
  unix-socket-only; unknown sources keep the 204 fail-open).
- `apps/daemon/src/agent-hooks.ts`:
  - `agentFamily()` gains `case "grok": return "grok"` (return type widens).
  - `configTarget()`: grok → `launchEnv.GROK_HOME || ~/.grok`.
  - `installGrok()`: writes `<grokHome>/hooks/orquester.json` in Grok's **native** hook format
    with `type:"command"` handlers invoking the existing `agent-hook.sh grok <event>` for:
    `Stop`, `Notification`, `PermissionDenied`, `UserPromptSubmit`, `PreToolUse`. Handlers are
    pure notifiers: exit 0, no stdout JSON — a `Stop` handler must never emit a block decision.
    The shared `agent-hook.sh` body is source-agnostic — **no `SCRIPT_VERSION` bump**.
  - Deliberately NOT relying on Grok's ability to read `~/.claude/settings.json`: that would
    emit claude-labeled events from grok sessions and corrupt per-family classification.
- `apps/daemon/src/agent-status.ts` — `classifyGrok(event, payload)`:
  - `Stop` with `payload.reason === "end_turn"` → `done`; any other reason (`channel_closed`,
    `shutdown`) → `null` (session teardown, not a completed turn).
  - `Notification`, `PermissionDenied` → `waiting`.
  - `UserPromptSubmit`, `PreToolUse` → `working`.
  - Anything else → `null`.
- Push policy needs no change: hook events yield structural "needs your input"/"finished"
  pushes; a grok session that never delivers a hook event keeps the bell fallback automatically.

Explicit non-goals: `claudeTimeoutEnv` stays claude-family-only (grok gets none); no
`AgentAccountAgent` widening; no usage source.

### A.3 Tests / docs (part A)

- `apps/daemon/src/agent-family.test.ts` — `agentFamily("grok") === "grok"`;
  `agent-timeout-env` behavior for grok stays `null`.
- New coverage in the existing ad-hoc pattern for `classifyGrok` and the `orquester.json`
  hook-file rendering (pure parts).
- `AGENTS.md`: agent list (feature bullet) + hook-reporting agent list.

---

## Part B — xAI OAuth account in the model proxy

### B.1 Data model & state

No secrets are stored by Orquester for xai — CLIProxyAPI owns the tokens in
`<appdir>/daemon/cliproxy/auth/xai-*.json`. The daemon's view is **derived, not persisted**:

- `CliProxyStatus` (packages/api) gains:

```ts
xai: {
  state: "none" | "linking" | "linked" | "expired";
  email: string | null;        // from the auth file
  expiredAt: string | null;    // RFC3339 `expired` field
  lastQuotaError: string | null; // most recent upstream …-usage-exhausted body, if seen
  link: { url: string; userCode: string; expiresAt: string } | null; // while linking
}
```

- `linking` (and its `link` payload) is in-memory only; carrying it on the status keeps the
  card correct across page reloads mid-flow, but it does not survive a daemon restart (the
  proxy-side session dies after 30 min anyway). The device-flow `url`/`userCode` are
  user-facing by design (the user must visit them) — they are not secrets.
- `linked` vs `expired`: presence of ≥1 `xai-*.json` in the auth dir; `expired` when every such
  file's `expired` timestamp is in the past (informational — the proxy refreshes with a 5-min
  lead, so a persistent past-due stamp means the refresh token is dead and relinking is the
  recovery).
- No zod schema changes in `cliProxyState`/`cliProxySecrets` — nothing new at rest. The
  existing `state.json`/`secrets.json` are untouched (`managementSecret` already exists and is
  already rendered into `config.yaml`'s `remote-management` block; part B is its first reader).

### B.2 Link / unlink flow

New manager methods on `CliProxyManager` + HTTP routes (all `refusedOnSocket`, matching every
other cliproxy mutation):

| Route | Behavior |
|---|---|
| `POST /api/cliproxy/xai/link` | Requires proxy running (same precondition as account seeding). Daemon calls `GET http://127.0.0.1:<port>/v0/management/xai-auth-url` with `Authorization: Bearer <managementSecret>` → returns `{url, userCode}` to the client and starts a poll loop against `get-auth-status` (poll every ~3 s, stop at `ok`/`error`/30-min expiry). 409 if a link session is already active or an account is already linked. |
| `DELETE /api/cliproxy/xai/link` | Cancels an active device-flow session (`DELETE /v0/management/oauth-session?state=…`), or — when linked — **unlinks**: deletes all `auth/xai-*.json` files. Unlink is guarded by the live-session rule: 409 `{ok:false, affectedSessions}` unless `force`, counting live claudex/claudemix sessions whose model resolves to `XAI_OAUTH_MODELS`. |

On `ok`: re-probe `/v1/models`, `applyRegistryCoupling`, broadcast `cliproxy.changed`. On
unlink: same tail. **No `config.yaml` change and no proxy restart in either direction** — the
proxy hot-discovers auth-dir changes; link/unlink is deliberately lighter than router-provider
mutations.

Management-API details: loopback only, bearer secret from `secrets.json`; 5 s per-request
timeout; management-API errors surface as 502 with the upstream status, mirroring the router
catalog route's error contract. Tokens never cross Orquester's API; the status carries only
`email`/timestamps.

### B.3 Model exposure (data-driven, gated on `linked`)

New constant in `packages/config/src/index.ts` beside `CURATED_PROXY_MODELS`:

```ts
export const XAI_OAUTH_MODELS = [
  {
    id: "grok-build-0.1",
    label: "Grok Build",
    contextWindow: 256_000,
    compactWindow: 190_000,   // xAI doubles the whole request's price past 200k input
  },
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    contextWindow: 500_000,
    compactWindow: 190_000,   // same 200k pricing cliff; forced-reasoning caveat in UI copy
  },
] as const;
```

plus `resolveXaiModel(model)` — exact match on `id` after stripping one `acc<hex>/` prefix,
the companion to `resolveRouterModel`. It feeds the same consumers (this list is the checklist):

1. **Chips** (`NewTabMenu.tsx`): claudex chip ids become curated ∪ keyed-router ∪
   (**linked-xai**) — ∩ live catalog as today. Picking a grok model dims the account chip
   ("uses Grok account") and launches with `SYSTEM_ACCOUNT_ID`, exactly like router models.
2. **Launch env** (`cliproxyContributor` + `resolveLaunchModel`): xai models are emitted
   **bare** (never `acc<hex>/`-prefixed — CLIProxyAPI routes them to the xai auth internally),
   and `routesToAccount` excludes them alongside router models.
3. **Seeded-account launch gate** (`POST /api/sessions`): an xai model skips the "account not
   seeded" 400, alongside the router-model skip.
4. **`compactEnvForModel`**: xai branch between the router and curated branches —
   `modelOverrides` still win, then the `XAI_OAUTH_MODELS` windows.
5. **Probe catalog union**: xai model ids are unioned into the live catalog while linked (the
   embedded CLIProxyAPI catalog should already list them; the union makes chips and
   `validateModel` independent of upstream catalog drift, as with router aliases).
6. **Collision guard**: `validateRouterProviders` also rejects router model names/aliases that
   shadow an `XAI_OAUTH_MODELS` id (same rule as the curated-id guard).

`grok-build-0.1` is the intended default chip; `state.defaultModel`/`backgroundModel` picks of
xai models are allowed (dropdown unions them while linked) and reset to defaults by the
existing dangling-pick logic when the account is unlinked.

### B.4 Launcher coupling, label, managed home

- `applyRegistryCoupling` (`apps/daemon/src/cliproxy.ts`): claudex requirement becomes
  `codexOk || routerOk || xaiLinked`. claudemix unchanged (`claudeOk`).
- Registry label: `claudex` renamed **"Claude Code × GPT/Kimi/Grok"**
  (`packages/registry/src/index.ts`).
- Managed home (`cliproxy-files.ts`): a new gated `grok.md` managed subagent (model
  `grok-build-0.1`) joins `MANAGED_AGENTS` beside the kimi-gated `kimi.md`, gated on
  `xaiLinked` (tri-state like the kimi gate: `undefined` = state unknown ⇒ don't churn files).
  `renderManagedMemory` (claudemix `CLAUDE.md`) mentions it under the same gate. No new
  `claudex.env` `/model` slot — the Fable slot stays kimi-gated.

### B.5 Settings UI

Settings → Model proxy → Accounts section gains a **Grok account** card (beside the
codex/claude provider rows, visually distinct from Routers):

- `none`: "Link Grok account" button + one-line caveat copy (subscription is used through a
  reverse-engineered first-party-client contract; may break or be rate-limited without notice;
  no quota readout is possible).
- `linking`: the verification URL (clickable) + user code + cancel; polls status via the
  normal `cliproxy.changed` broadcast.
- `linked`: email, expiry stamp, last quota-exhaustion event if any, and "Unlink" (rides the
  existing `withRestartConfirm`-style force-confirm for live sessions).
- `expired`: relink prompt.

### B.6 Error handling

- Link while proxy stopped → 409 ("model proxy must be running"), matching seeding.
- Device flow timeout/`error` → status back to `none` with a transient error message in the
  card; the daemon always fires the proxy-side session cancel on abandonment.
- Quota exhaustion: the proxy 502/429 surfaces in-session as today; additionally the daemon
  scrapes the proxy log line / upstream body when it sees `…-usage-exhausted` and stores it as
  `xai.lastQuotaError` with a note that the account is cooled for 24 h. Best-effort only —
  **no quota gauge is possible** (upstream limitation, recorded above).
- Auth file unreadable/corrupt → treated as `none` (fail-closed, never crashes status).
- Unlink resets dangling `defaultModel`/`backgroundModel` picks in the same mutation
  (existing `resetDanglingModelPicks`).

### B.7 Tests / docs (part B)

- Ad-hoc test files (existing pattern): `resolveXaiModel` + compact-env branch, chip-source
  derivation (pure part if extracted), `applyRegistryCoupling` xai case, link-state derivation
  from auth-dir fixtures, collision guard.
- `AGENTS.md`: the model-proxy section gains the xai account contract (device-flow link, auth
  dir ownership, no-restart semantics, the accepted-risk note, the 24 h cooldown gotcha);
  README feature line.
- The router-providers spec/plan stay untouched (no preset added; their
  `preset: "openrouter"|"tokenrouter"|null` contract is unchanged).

## Verification

No test runner in this repo; "done" means:

1. `pnpm check` clean; the ad-hoc test files above pass.
2. Drive a real daemon **in a separate checkout** (never the live one — AGENTS.md rule):
   - Part A: install Grok Build from Settings, confirm version detection, launch a grok tab,
     `grok login --device-auth`, run a turn, confirm hook events land (`session.activity`
     working/waiting/done) and a push fires on finish.
   - Part B: enable the proxy, link the Grok account via the device flow from Settings, confirm
     `xai.state === "linked"` + email, launch a claudex tab on the `grok-build-0.1` chip
     (account chip dimmed), confirm the session answers, `claudex.env`/`config.yaml` unchanged
     by link, unlink with a live session → 409 → force works.
3. After deploy: health curl + `node scripts/smoke-web.mjs` (mandatory web smoke test).

## Out of scope / future

- xAI API-key router preset (would need the 400-status key-verify fix recorded above).
- Grok managed multi-accounts / account chips (single Heavy account today).
- Grok usage/quota reporting (upstream provides no readable quota).
- claudemix model chips; `/model` slot assignment UI (still deferred from the router spec).
- Importing `~/.grok/auth.json` into the proxy (CLIProxyAPI has no reader; device flow is
  strictly simpler).
