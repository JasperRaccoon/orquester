# Agent Usage Widget — Design Spec

- **Date:** 2026-07-07
- **Status:** Design (approved for planning)
- **Scope:** v1 — Claude Code + Codex subscription usage, surfaced as a top-bar widget + popover, configurable in Settings
- **Author:** brainstormed with an army of parallel research agents (11 reference repos + a codebase-integration sweep)

---

## 1. Goal

Show, inside Orquester, the **subscription-plan quota** for coding agents — the "current 5-hour session %" and "current week %" that Claude and Codex expose on their own usage popovers — as a compact top-bar chip that opens a details panel. It must be **configure-once / buttery-smooth**: no repeated manual action, no pasting tokens, no browser login. It should Just Work for any agent that is installed and logged in, and be tunable from **Settings**.

Reference target (the user's personal setup): a `3% • 37%` chip that opens a "Claude Code Usage" panel with two progress bars ("Current session (5 hours)", "Current week"), a plan label ("Max 20x"), reset countdowns ("Resets in 2h 29m"), an "Updated on HH:MM:SS" line, and a manual refresh button.

---

## 2. Key finding: the exact numbers are readable server-side

The whole feature hinges on **where the real percentages come from**. They are **not** stored on disk as percentages by the agents' transcripts — Claude's `~/.claude/projects/**/*.jsonl` carry only raw token counts and **no** `rate_limits` block (verified grep-empty). But because the Orquester daemon runs **on the same host and as the same OS user** as the agent sessions, it can reach the authoritative sources directly, using credentials the user already created via `claude login` / `codex login`.

### Evidence (verified on the deployment host, 2026-07-07)

- `~/.claude/.credentials.json` exists, mode `0600`, owned by the daemon user (`orquester`, `HOME=/var/lib/orquester`). Contains `claudeAiOauth.{accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier}`. `scopes` includes `user:profile`; `subscriptionType` = `max`.
- `GET https://api.anthropic.com/api/oauth/usage` with that token returned **HTTP 200** carrying `five_hour.utilization = 45` and `seven_day.utilization = 69` (plus a newer `limits[]` array) — i.e. the box was at **45% of the 5-hour window, 69% of the weekly** at test time. Server-computed 0–100, read verbatim, works even when no session is running.
- `~/.codex/sessions/**/rollout-*.jsonl` `token_count` events carry a server-computed `rate_limits` block (`primary` = 5h, `secondary` = weekly). `~/.codex/auth.json` has `OPENAI_API_KEY = null` → OAuth (subscription) mode.

This is the same data behind the agents' own popovers. No token math, no scraping, no browser cookie.

---

## 3. Scope

### In scope (v1)
- **Claude Code**: 5-hour session % and weekly %, plan label, reset timers.
- **Codex**: 5-hour session % and weekly %, plan label, reset timers.
- **One aggregate per agent** (single-user host).
- Top-bar chip + popover panel (desktop and mobile headers).
- A **Settings ▸ Usage** section (master toggle, per-agent toggles, chip mode).
- **Read-only** credential handling; graceful **stale** state when a token has expired during long idle.

### Out of scope (v1) — kept pluggable for later
- Per-model weekly bars (Opus / Sonnet / Fable) — the Claude endpoint returns them.
- Extra-usage / spend / credit balance.
- Per-workspace / per-account rows (keyed on Orquester's per-workspace identities).
- Daemon-side token refresh / write-back.
- Registering Orquester as Claude Code's `statusLine` command (token-less push path).
- Other agents (gemini / deepseek / opencode) — no comparable subscription quota surface.
- USD cost estimates (needs a price table that drifts).

---

## 4. Architecture

End-to-end, mirroring the existing `registry` single-object live slice:

```
credentials + logs (on host)
        │
        ▼
UsageService (apps/daemon/src/usage.ts)      ← Claude: adaptive poll · Codex: fs.watch · read-only
        │  emits "changed" (only on movement)
        ├──────────────► GET /api/usage        ← snapshot (cached); ?refresh=1 forces a fresh fetch
        └──────────────► broadcaster.publish("usage","usage.changed", payload)  → /events (NDJSON)
        │
        ▼
UI store slice `usage` (packages/ui/src/store/app.ts)
   loadUsage() on (re)connect  +  applyEvent("usage") live deltas
        │
        ▼
UsageWidget (packages/ui/src/components/topbar/UsageWidget.tsx)  — chip + popover
Settings ▸ Usage (packages/ui/src/components/settings/SettingsModal.tsx) — configure
```

Rationale for **event-push, not client polling**: the `/events` bus is already open whenever connected, auto-reconnects, and works identically on desktop (unix socket) and web (HTTP) via `Transporter.openStream`. Usage rides `/events`, **never** `/ws` (the desktop unix transporter has no `sessionChannel`). The snapshot fetch on connect is mandatory because the bus has no replay/backfill.

---

## 5. Data acquisition

### 5.1 Claude Code — poll the OAuth usage endpoint

- **Credential:** read `${claudeHome}/.credentials.json` → `claudeAiOauth.accessToken`. `claudeHome` = `$CLAUDE_CONFIG_DIR` if set, else `${resolved.vars.userhome}/.claude`. **Never hardcode** `/home/<user>` or `/root`; derive from `resolved.vars.userhome` (honors `$HOME`, = `/var/lib/orquester` on the VPS).
- **Request:** `GET https://api.anthropic.com/api/oauth/usage`
  - `Authorization: Bearer <accessToken>`
  - `anthropic-beta: oauth-2025-04-20`
  - `User-Agent: claude-code/<detected version>` (fallback `claude-code/2.1.0`)
  - `Accept: application/json`
- **Parse (two coexisting shapes — read one, fall back to the other):**
  - Preferred (legacy top-level): `five_hour.{utilization, resets_at}` → session; `seven_day.{utilization, resets_at}` → weekly (`resets_at` is ISO 8601).
  - Newer: `limits[]` where `kind:"session"` → session, `kind:"weekly_all"` → weekly (`percent`, `resets_at`; `kind:"weekly_scoped"` + `scope.model.display_name` is per-model, out of scope v1).
- **Plan label:** from creds `subscriptionType` / `rateLimitTier` (e.g. `max` → "Max"), or from the response if present.
- **Guards:** drop any utilization value `> 101` and clamp `100–101 → 100` (known Anthropic leak bug #52326 where a reset epoch can bleed into the field).
- **Scope requirement:** the endpoint needs `user:profile` scope (verified present). If a token lacks it and 401s, treat Claude as **unavailable** (future fallback: statusLine capture — out of scope v1).

### 5.2 Codex — tail the local session log (zero auth, zero network)

- **Home:** `codexHome` = `$CODEX_HOME` if set, else `${resolved.vars.userhome}/.codex`.
- **Reject API-key mode:** if `${codexHome}/auth.json` has `OPENAI_API_KEY` set or `auth_mode == "apikey"`, there is no subscription quota — mark Codex unavailable.
- **Source:** newest `${codexHome}/sessions/YYYY/MM/DD/rollout-*.jsonl`; scan from the tail for the last line with `type:"event_msg"` and `payload.type:"token_count"`; read `payload.rate_limits` (prefer `limit_id == "codex"`):
  - `primary` (`window_minutes == 300`) → session 5h: `used_percent`, `resets_at`
  - `secondary` (`window_minutes == 10080`) → weekly: `used_percent`, `resets_at`
  - `plan_type` → plan label
  - **`resets_at` is epoch seconds** (Claude's is ISO 8601 — do not mix).
- **Stale windows:** null a window whose `resets_at` is already in the past.
- **Do not** build Codex on the `chatgpt.com/backend-api/wham/usage` HTTP endpoint: verified it returns `401 token_expired` when Codex sits idle. The local log never 401s. (`codex app-server` RPC is a possible on-demand-freshness path but is out of scope v1.)

---

## 6. Refresh & staleness model

| Provider | Steady state | On-demand | Staleness |
|---|---|---|---|
| **Claude** | Adaptive **poll**: ~60s while a Claude Code session is running, ~5 min when idle. Respect HTTP 429 (`Retry-After`, else ~5 min backoff). | Immediate fetch when the panel opens or the refresh button is pressed (`?refresh=1`). | Read-only. If `expiresAt <= now` or the endpoint 401s, mark `stale: true`, keep last-known bars greyed, surface "stale — open Claude Code to refresh". |
| **Codex** | **fs.watch** the newest `rollout-*.jsonl` with an incremental byte-offset tail — updates precisely when Codex makes a request; quiesces when idle. | Re-read on demand (cheap). | A window with a past `resets_at` is nulled. |

- "Claude session is running" is determined from the daemon's own session manager (a session whose agent is `claude`), so the fast cadence only applies when it can actually move.
- Both providers additionally `fs.watch` their credential file (`~/.claude/.credentials.json`, `~/.codex/auth.json`) with a ~500 ms debounce, to pick up token rotation / account switches and re-read immediately.
- **Read-only is deliberate** (user decision): the daemon never writes tokens, which entirely avoids the write-back race where refreshing the file rotates a running agent's token out from under it. The cost is that Claude goes stale after ~2h of full idle; this is acceptable and clearly surfaced.
- The daemon caches the last-good aggregate and serves it from `GET /api/usage` with a short TTL (~10–15 s) so a reconnect burst can't trigger a re-scan/re-fetch storm. `changed` is emitted **only when a number actually moves** (dedupe by hashing the aggregate).

---

## 7. Daemon design

New file `apps/daemon/src/usage.ts` — `UsageService`, modeled on `apps/daemon/src/todos.ts` (`TodoListManager`):

- `readonly events = new EventEmitter()` emitting `"changed"` with a `UsageResponse`.
- Constructor `(claudeHome, codexHome, deps)`; owns the Claude poll timer, the Codex + credential file watchers, and the cached aggregate.
- `recompute()` gathers both providers, applies the guards/unit-normalization above, and emits `"changed"` on movement. Missing dirs/files ⇒ that agent `available: false` (ENOENT-as-empty, like `todos.ts` treats a missing index).
- `snapshot(force?: boolean): Promise<UsageResponse>` returns the cache (or forces a fresh Claude fetch when `force`).
- `start()` / `stop()` manage timers and watchers.
- Reads `usage.enabled` from **app config** (see §10) to decide whether to poll Claude at all; Codex's passive watch may always run.

**Wiring in `apps/daemon/src/index.ts`** (all references approximate — anchor on the named symbols):

- Construct **once** in `startDaemon` near the todos service (~`index.ts:206`). `createServer` runs **twice** (unix `~:256`, HTTP `~:271`) and the HTTP transport is recreated on config change — so timers/watchers must **not** live inside `createServer`. Pass via the shared `services`.
- Add `usage: UsageService` to the `Services` interface (~`index.ts:326`) and the `services` object (~`index.ts:245`); destructure it in `createServer` (~`index.ts:345`).
- Bridge to the bus next to the registry bridge (~`index.ts:208`):
  `usage.events.on("changed", (u) => broadcaster.publish("usage", "usage.changed", u));`
- Route, placed after the to-do routes (~`index.ts:1700`), before `GET /events` (~`index.ts:1703`):
  `app.get<{ Querystring: { refresh?: string } }>("/api/usage", async (req, reply) => reply.send(await usage.snapshot(req.query.refresh === "1")));`
  Same auth posture as `GET /api/registry` / `GET /api/todos`: unauthenticated over the local unix socket, bearer-gated + throttled over remote HTTP. **Do not** add the `mode === "remote"` 403 that `PUT /api/config/daemon` uses.
- Call `usage.stop()` in the daemon `stop()` teardown.

---

## 8. Wire contract (`packages/api/src/index.ts`)

Add near `TodoEventType`:

```ts
export type UsageEventType = "usage.changed";

export interface UsageWindow {
  /** 0–100, server-computed, verbatim. */
  percent: number;
  /** ISO 8601; normalized from Claude ISO / Codex epoch-seconds. */
  resetsAt?: string;
}

export interface AgentUsage {
  id: "claude" | "codex";
  /** installed + logged in + data present. */
  available: boolean;
  /** data known but the token/log is expired/old. */
  stale: boolean;
  /** e.g. "Max 20x", "Pro". */
  plan?: string;
  session: UsageWindow | null; // 5-hour
  weekly: UsageWindow | null;
  updatedAt?: string;
}

export interface UsageResponse {
  updatedAt: string;
  /** only logged-in agents; empty ⇒ the widget hides. */
  agents: AgentUsage[];
}
```

Add `usage(force?: boolean): Promise<UsageResponse>` to the `OrquesterApi` interface and implement on `HttpOrquesterApiClient` (mirror `getFsCapabilities`): `usage(force){ return this.get<UsageResponse>("/api/usage" + (force ? "?refresh=1" : "")); }`.

`EventMessage.channel`/`type` are already loose strings, so no union edit is needed. **Both the daemon publish payload and the client cast must import `UsageResponse` from `@orquester/api`** so they stay in lockstep (mitigating the unvalidated `payload as UsageResponse` cast).

**Privacy:** the response carries **only** percentages, reset timestamps, plan label, and the `available`/`stale`/`updatedAt` flags — never token material, transcript text, or file/project paths (the endpoint is unauthenticated over the local socket).

---

## 9. UI store slice (`packages/ui/src/store/app.ts`)

Mirror the single-object `registry` slice:

- Add `usage: UsageResponse | null` to the `AppState` data block; initial `null`.
- Add `loadUsage(force?): Promise<void>` (copy `loadRegistry`, swap endpoint) — swallow errors.
- Add `get().loadUsage()` to the `establish()` `Promise.all` fan-out so a fresh snapshot loads inside the existing `reconnectGen`-guarded block on every (re)connect (**mandatory** — the bus has no replay).
- Add an `applyEvent` branch: `if (event.channel === "usage") { set({ usage: event.payload as UsageResponse }); return; }`.
- Add `getUsage()` to `ApiClient` (mirror `listRegistry`). `openEvents` needs no change — the new channel flows through automatically.

---

## 10. Config — app config (`@orquester/config` + `UiAppConfig`)

The user-facing knobs live in **app config**, not daemon config, so they're editable from the web client (daemon config is socket-only / 403 over remote HTTP; app config is edited via the existing `PUT /api/config/app`).

Add to `appConfigSchema` (`packages/config/src/index.ts`, near `~:275`) and the matching `UiAppConfig` (`packages/ui/src/store/app.ts`, `~:240`), and thread through the `UiAppConfig ↔ AppConfig` mapping:

```ts
usage: z.object({
  enabled: z.boolean().default(true),
  claude:  z.boolean().default(true),
  codex:   z.boolean().default(true),
  chip:    z.enum(["busiest", "claude", "codex"]).default("busiest"),
}).default({})
```

Defaults make the feature **zero-config**. The daemon reads `usage.enabled` from `app.json` (it already loads app config) to gate Claude polling, so toggling the widget off also **stops the network activity**, not just the display. (On desktop, where app config is host-local, `enabled` is a client-side display gate; the remote/web deployment — the primary target — gets the daemon-side gate.)

---

## 11. UI — chip + popover (`packages/ui/src/components/topbar/UsageWidget.tsx`)

New component, mounted in `TopBar.tsx`'s right cluster **before `SettingsButton`**, wrapped in `<div className="app-no-drag">` (the desktop header is a frameless-window drag region — unwrapped clicks are swallowed), and in mobile header row 1. Rendered **unconditionally** (usage is global, not project-scoped), but returns `null` when `!appConfig.usage.enabled` or no agent is available.

- **Chip trigger:** copy `OpenOnMenu`'s trigger span (`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800`); content = the **driving agent**'s `session% • weekly%` prefixed by that agent's icon. The driving agent is chosen by `appConfig.usage.chip`: `"busiest"` = the included+available agent with the highest `max(session%, weekly%)` (ties broken claude → codex); `"claude"`/`"codex"` pin a specific one (falling back to busiest if that one is unavailable). A stale driver shows a muted indicator.
- **Popover:** `AdaptiveMenu` (desktop `Dropdown` + mobile `BottomSheet` for free), `align="right"`, `width="w-72"`, with **custom JSX** as children (not `DropdownItem`s) — mirror `ServerSwitcher`, which renders a rich body inside a `Dropdown`. Contents:
  - A header row with a refresh button (calls `loadUsage(true)` → `?refresh=1`) and an "Updated on HH:MM:SS" line (from `updatedAt`).
  - One section per included agent, titled e.g. "Claude Code Usage" / "Codex Usage":
    - "Current session (5 hours)" — a progress bar + `percent` + reset countdown ("Resets in 2h 29m" / "Resets now.").
    - "Current week" — same.
    - A plan label ("Max 20x").
  - An **unavailable** included agent shows a muted, actionable row ("Not logged in — run `claude login`"). A **stale** agent shows greyed last-known bars + "stale — open Claude Code to refresh".
- **Progress bar** (no reusable exists — build from primitives): track `<div className="h-1.5 w-full rounded-full bg-neutral-800">` + fill `<div className="h-full rounded-full" style={{ width: `${clamp(pct)}%` }}>` with a color ramp: `emerald-400` `< 75%` → `amber-400` `>= 75%` → `red-500` `>= 90%`.
- **Styling:** dark-only literal `neutral-*` / `emerald-*` / `amber-*` / `red-*` classes. **No** `dark:` variants and **no** CSS variables — none exist in the repo and Tailwind has no `darkMode` configured.

---

## 12. Settings — a new "Usage" section (`packages/ui/src/components/settings/SettingsModal.tsx`)

- Add a `SECTIONS` entry (`~:27`): `{ id: "usage", label: "Usage", icon: <Activity size={16} />, desc: "Top-bar usage widget for Claude Code & Codex" }`. Extend the `Section` union type and the `renderSection` switch.
- New `UsageSettings` pane mirroring `AppSettings` (`Field` + `Switch`, reading `appConfig` + `updateAppConfig` from the store). Fields:
  - **Show usage in the top bar** — `Switch` bound to `usage.enabled`.
  - **Claude Code** / **Codex** — per-agent `Switch`es bound to `usage.claude` / `usage.codex`, each with a live state hint derived from `registry` (installed?) + the `usage` slice (available / stale / plan), e.g. "Logged in · Max 20x", "Not logged in", "Stale — token expired".
  - **Chip shows** — a select bound to `usage.chip`: Busiest agent / Claude Code / Codex.

---

## 13. Security & privacy

- Only aggregates cross the wire (§8). No tokens, transcript text, or project paths.
- `GET /api/usage` matches `/api/registry`'s posture: unauthenticated over the local socket, bearer-gated + per-IP throttled over remote HTTP. Not restricted to the socket (it returns no secret) — consistent with `GET /api/config/daemon` / `GET /api/accounts`.
- The path-derivation for credential/log reads is fixed (built from `resolved.vars.userhome` / `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME`), **not** driven by request params — it cannot be turned into an arbitrary-file read, and it does **not** reuse the `/api/fs/*` routes (which are sandboxed to the workspaces dir and would 403 on `~/.claude` anyway).

---

## 14. Failure modes & edge cases

- **Endpoint drift:** the Anthropic/OpenAI endpoints, the `anthropic-beta` header, the `User-Agent`, and client IDs are unofficial and load-bearing. Version the parser; on an unrecognized shape, degrade to `available: false` rather than rendering wrong numbers.
- **Two Claude response shapes** coexist today — read one with fallback to the other; assume neither persists.
- **Short-lived Claude token** (~2.5 h) → handled by the read-only stale model (§6).
- **Codex idle token** 401s on the HTTP endpoint → avoided entirely by reading the local log.
- **No `rate_limits` in Claude transcripts** (verified) → never estimate from token sums; there is no offline path to the real weekly %.
- **Stale windows** (`resets_at` in the past, seen on-host for Codex) → null the window.
- **Unit mismatches** → Claude `expiresAt` epoch-ms; Claude `resets_at` ISO; Codex `resets_at` epoch-seconds; Codex `window_minutes` (300/10080). Normalize to ISO on the wire.
- **Leak bug #52326** → drop `> 101`, clamp `100–101 → 100`.
- **Codex used_percent** is server-rounded to an integer — don't imply finer precision.
- **Multi-user / other UID:** the daemon must be able to read the home holding the tokens. Fine on this single-user VPS; per-workspace/other-UID homes would need explicit resolution (future).
- **429 budget** scales with account count × poll frequency — centralize the Claude fetch and throttle.
- **Both hosts at once:** the shared component + store slice change desktop and web simultaneously.
- **Frozen `expiresAt` handling:** compare in a single unit (divide epoch-ms by 1000).

---

## 15. File footprint

**New**
- `apps/daemon/src/usage.ts` — `UsageService` (Claude poll / Codex watch, read-only, cache + `changed` event).
- `packages/ui/src/components/topbar/UsageWidget.tsx` — chip + popover.

**Modified**
- `apps/daemon/src/index.ts` — construct/wire the service, bridge the event, `GET /api/usage`, `stop()` teardown.
- `packages/api/src/index.ts` — `UsageWindow` / `AgentUsage` / `UsageResponse` / `UsageEventType` + client method.
- `packages/config/src/index.ts` — `usage` block in `appConfigSchema` (+ default).
- `packages/ui/src/store/app.ts` — `usage` slice (field, init, `loadUsage`, `establish` fan-out, `applyEvent` branch) + `UiAppConfig.usage` + `UiAppConfig ↔ AppConfig` mapping.
- `packages/ui/src/lib/api-client.ts` — `getUsage()`.
- `packages/ui/src/components/topbar/TopBar.tsx` — mount the widget (desktop right cluster + mobile row 1).
- `packages/ui/src/components/settings/SettingsModal.tsx` — new "Usage" section + `UsageSettings` pane + `Section`/`renderSection`.

---

## 16. Alternatives considered

- **Estimate % from token sums vs. plan budgets** (several reference repos) — rejected as the primary source: it's a heuristic (wrong-window, guessed limits, can exceed 100%) and **cannot** reconstruct Claude's weekly. Kept in mind only as a clearly-labeled offline fallback (not built in v1).
- **claude.ai web-cookie endpoint** (`/api/organizations/{orgId}/usage`, used by the browser-extension repos) — same numbers, but needs a browser `sessionKey` cookie + Cloudflare bypass. Wrong credential surface for a headless daemon when the OAuth file is already present.
- **Daemon refreshes the Claude token itself** — rejected for v1 (user decision): keeps the widget live through long idle but introduces a credential-file write-back race with running agents and makes the daemon perform outbound OAuth calls. Read-only + stale is simpler and safer.
- **Codex `wham/usage` HTTP endpoint / `codex app-server` RPC** — rejected as the baseline: the HTTP endpoint 401s when idle; the RPC costs a subprocess and is version-gated. The local log is always-available and never 401s.
- **Two separate chips (one per agent)** — rejected for top-bar space; one "busiest" chip + a multi-section popover scales better.
- **statusLine capture** (register Orquester as Claude Code's `statusLine`) — deferred: a token-less push path, but it only fires while a session renders and overrides any user `statusLine`.

---

## 17. Verification approach

- **Gate:** `pnpm check` (typecheck) — the repo has no test runner.
- **Do not** start a daemon in this checkout (AGENTS.md hard rule — this repo is served by a live daemon). Runtime verification is driven against a separate checkout or the live web SPA.
- **De-risk the parsing:** implement the Claude response parser, the Codex log parser, and the window/guard normalization as **pure functions**, exercised with captured real fixtures (the verified 200 response and a real `token_count` line) via a scratch script — no live daemon needed to prove the math.
- Manually confirm: chip renders the busiest agent; popover shows both sections with correct reset countdowns; Settings toggles hide/show and (on the remote deployment) stop Claude polling; stale state appears after the token expires.

---

## 18. Deferred / future extensions

Per-model weekly bars · spend/credits · per-workspace or per-account rows (using Orquester's per-workspace identities) · daemon-side token refresh · statusLine push path · Codex `app-server` on-demand freshness · additional agents. All are additive: the `agents[]` response shape and the pluggable `UsageService` are designed to absorb them without a redesign.
