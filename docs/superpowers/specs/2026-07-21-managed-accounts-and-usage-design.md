# Managed agent accounts + usage-tracking upgrades

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan

## Problem

Orquester runs coding-agent sessions (Claude Code, Codex, …) but has no first-class notion
of an *account*. Two consequences:

- **No account switching.** A session uses whatever credentials sit in the daemon user's
  home (`$HOME/.claude`, `$HOME/.codex`). To run a second Claude or Codex subscription you
  must manually swap dotfiles. The only multi-account path today is the **TeamClaude proxy
  addon** (`apps/daemon/src/teamclaude.ts`), a ~950-line service that pools accounts behind a
  local proxy — heavy, Claude-only, and it commandeers *every* Claude session (all-or-nothing)
  rather than letting you pick an account per session.
- **Usage tracking is narrower than it could be.** `UsageService` already polls Claude's
  OAuth usage endpoint and scrapes Codex rollout logs (`apps/daemon/src/usage.ts`,
  `usage-sources.ts`), but: Codex has no live source (log-scraping only sees data *after* a
  session emits events, and misses `plan_type` / exact reset times); the agent set is a
  hardcoded `"claude" | "codex"` union; there is no token/cost view; and per-account usage is
  bolted to the TeamClaude proxy rather than to real managed accounts.

Orca (github.com/stablyai/orca) solves the account problem with **per-account credential
homes** (a self-contained `CODEX_HOME` / `CLAUDE_CONFIG_DIR` per account) and keeps idle
accounts alive with a **background OAuth refresher**. This design adapts that model to
Orquester's daemon-owns-sessions architecture — where per-session env injection already
exists — and folds in the usage upgrades that ride on the same account plumbing.

## Goals

1. **Managed accounts** for Claude and Codex: add/remove in Settings, credentials stored in
   per-account homes under the appdir, never returned by any API.
2. **Per-session account selection.** A session picks an account at launch; different sessions
   run different accounts concurrently. This is strictly more capable than Orca's single
   global "active account".
3. **Idle accounts never rot.** A daemon background refresher keeps managed accounts' OAuth
   tokens valid whether or not you use them.
4. **Remove TeamClaude** entirely; managed accounts replace it.
5. **Usage upgrades:** a live Codex source, a registry-driven (non-hardcoded) agent set, a
   token/cost view, and per-managed-account usage.

**Non-goals (v1):** in-panel OAuth login flows (capture is import-only — see below); auto
load-balancing/pooling across accounts (the one TeamClaude capability we consciously drop);
macOS Keychain credential storage (daemon is Linux/file-based; desktop-on-macOS keeps using
`$HOME` dotdirs as the System account); switching a *running* session's account without
relaunch; agents other than Claude/Codex for accounts (the usage agent set does open up, but
account management stays Claude+Codex).

## Why import-only capture

Two facts drive this and are worth stating up front, because they were a point of confusion:

- **How a credential is captured has no bearing on when it expires.** A captured credential is
  just a token blob (`claudeAiOauth {accessToken, refreshToken, expiresAt}` for Claude;
  `tokens {access_token, refresh_token, id_token}` for Codex). Whether it arrives via a hidden
  login process (Orca) or a file upload, it ages identically once on disk.
- **Expiry has two tiers.** The **access token** is short-lived (hours) and is *not* a
  re-login — the refresh token silently mints a new one on next use. The **refresh token** is
  long-lived but rotates on use and can be revoked after prolonged inactivity; only *its* death
  forces a real re-login. So the thing that keeps a rarely-used account alive is **periodic
  refresh**, not the capture method. That is Goal 3, and it is mandatory, not optional.

Given that, capture is **import-only**, mirroring the existing TeamClaude accounts panel
(`AddonsSettings.tsx:344-457`): you bring an already-authenticated credential blob (upload,
paste, or a path on the daemon host) and the daemon stashes it. To bootstrap a fresh machine
you log into Claude Code / Codex once elsewhere (your laptop, or a normal Orquester shell
session running as the System account) to produce the file, then import it. No OAuth-driving
code, smallest surface.

---

## Feature 1 — Managed agent accounts

### 1.1 Storage layout

Under the existing appdir daemon dir (`daemonConfigDir(baseDir)` in `packages/config`,
alongside `sessions.json` / `push.json`):

```
<appdir>/daemon/
  agent-accounts.json                         # index (no credential material), 0600
  agent-accounts/
    claude/<id>/home/                          # this account's CLAUDE_CONFIG_DIR, 0700
      .credentials.json                        # the imported blob
      .orq-account                             # marker file containing <id>
    codex/<id>/home/                           # this account's CODEX_HOME, 0700
      auth.json
      .orq-account
```

`agent-accounts.json` (new zod schema in `packages/config`, `parseAgentAccounts` /
`createDefaultAgentAccounts`, index file resolved as `agentAccountsFile(baseDir)`):

```ts
{
  accounts: [{
    id: string,                // randomUUID
    agent: "claude" | "codex",
    label: string,             // user-typed (Claude) or derived email (Codex)
    email: string | null,      // Codex: from id_token JWT; Claude: null
    plan: string | null,       // Claude: subscriptionType; Codex: plan_type when known
    createdAt: string,
    importedAt: string
  }],
  defaults: { claude: string | null, codex: string | null }
}
```

Credentials live **only** in the per-account home files, never in the index and never in any
API response (same discipline as SSH keys / PATs in `AccountsService`).

### 1.2 Ownership assertion

Before any write/delete to an account home, a shared helper
(`assertOwnedAccountHome(agent, id, path)`) must confirm:

- `realpath(path)` is contained under `agent-accounts/<agent>/` (canonicalized, so `/var`
  vs `/private/var` and symlink tricks can't escape),
- the path component is exactly `<agent>/<id>/home`,
- `path` is not a symlink,
- `<path>/.orq-account` exists and contains `<id>`.

This is Orca's cheapest and most valuable safety idea (mirrors
`assertOwnedHostCodexManagedHomePath`) and guards against a swapped/symlinked directory
redirecting a credential write into `$HOME/.codex` or outside the sandbox.

### 1.3 Import (capture)

New `AgentAccountsService` (`apps/daemon/src/agent-accounts.ts`). `importAccount(input)`:

1. Accept a blob via uploaded content, pasted text, or a daemon-host path (reuse the
   three-input pattern and temp-file handling from `TeamClaudeService.importCredentials`).
2. Parse JSON; **auto-detect agent by shape** — `claudeAiOauth` present → Claude;
   `tokens.access_token` present → Codex; otherwise reject with a clear error.
3. Derive identity:
   - **Codex:** base64-decode the `tokens.id_token` JWT payload (no signature verification
     needed — we already hold the token) → `email`, `chatgpt_account_id`; label defaults to
     the email.
   - **Claude:** `.credentials.json` has no email (it lives in `.claude.json`, not imported),
     so `label` is **required from the caller**; `plan` = `claudeAiOauth.subscriptionType`.
4. Mint `id`, create `agent-accounts/<agent>/<id>/home/` (0700), write the blob
   (`.credentials.json` / `auth.json`, 0600) and `.orq-account`, after an ownership assert on
   the freshly created dir.
5. Append to the index, persist (0600), broadcast `agent-accounts.changed`. If this is the
   first account for the agent and no default is set, set it as the default.

`removeAccount(id)`: ownership-assert, `rm -rf` the home, drop from index, clear it from
`defaults` if referenced, broadcast. `setDefault(agent, id | null)`: validate + persist +
broadcast.

### 1.4 Session integration (per-session selection)

- **Wire types (`packages/api`):** `CreateSessionRequest` and `SessionSummary` grow optional
  `accountId?: string`. Persisted in `sessions.json` so reattach and reconnecting clients keep
  it.
- **Env resolution:** the existing `resolveExtraEnv` hook (`apps/daemon/src/index.ts:230`,
  passed into `createSessionManager`) is today TeamClaude-only, receives just the registry
  `entry`, and returns `Record<string,string> | null` (additions only). Two changes:
  (a) widen the signature to also receive the requested `accountId` (thread it from the
  create-session call site through `SessionManager.create`); (b) widen the **return type** to
  `{ env: Record<string,string>, unset?: string[] } | null` so it can express key *removal* as
  well as additions (env additions alone can't unset an inherited var). The session env-merge
  applies `env` over the base, then deletes every key in `unset`. New implementation delegates
  to `AgentAccountsService.resolveLaunchEnv(agent, accountId)`:
  - Resolve the effective account: explicit `accountId` → else per-agent default → else
    **System** (returns `null`, i.e. today's behavior: the session inherits `$HOME`'s dotdir).
  - **Claude:** `{ env: { CLAUDE_CONFIG_DIR: <home> }, unset: ["ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] }` — the `unset` list ensures file OAuth
    wins over any inherited API-key env.
  - **Codex:** `{ env: { CODEX_HOME: <home> } }`.
  - These are non-secret path values, so they ride the normal registry-env merge
    (`sessions.ts:269-273`, tmux `-e`), not the private addon-wrapper script.
- **Concurrency:** env is baked at spawn, so N sessions can each pin a different account at
  once. Changing a live session's account is out of scope — you relaunch. No global "active
  account", no restart-chip machinery.

### 1.5 Background refresher (mandatory)

New daemon task (`AgentAccountsService.startRefresher()`), modest cadence (hourly; also run
once on boot after `sessions.reattach()`):

For each managed account **with zero live sessions currently using it** (the session manager
knows which `accountId`s are live — this is our clean substitute for Orca's live-PTY gate,
which exists to stop the daemon and a running CLI both spending the same single-use Claude
refresh token):

- If the account's access token expires within the next cadence window + margin, refresh it:
  - **Claude:** `POST https://platform.claude.com/v1/oauth/token` with
    `grant_type=refresh_token`, the stored `refresh_token`, and the public Claude Code client
    id (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`). Merge the returned
    `access_token`/`refresh_token`/`expires_at` back into `.credentials.json`, **preserving all
    other fields**.
  - **Codex:** refresh against its token endpoint using the stored `refresh_token`; if that
    contract is uncertain, fall back to a one-shot `codex` CLI invocation with
    `CODEX_HOME=<home>` that forces a refresh, then re-read `auth.json`.
- Persist under an ownership assert; on `invalid_grant` (refresh token dead → genuine
  re-login needed) mark the account `needsReauth` in the index and broadcast, so the UI can
  flag it.

Accounts **with** live sessions are left to their CLI to refresh; the daemon does not touch
them (avoids the single-use-refresh-token race entirely).

### 1.6 API + events

- `GET /api/agent-accounts` → index projection (no credentials): accounts + defaults +
  per-account `needsReauth`.
- `POST /api/agent-accounts` → import (multipart/JSON body: `{ content?|from?, label? }`).
- `DELETE /api/agent-accounts/:id`.
- `PUT /api/agent-accounts/defaults` → `{ claude?: string|null, codex?: string|null }`.
- New broadcast channel `agent-accounts`, event `agent-accounts.changed`, wired like registry
  (`broadcaster.publish`) and consumed in the store's `applyEvent`.
- Security boundary: these routes are allowed over remote HTTP (like `/api/accounts` — no key
  material is ever returned). Import bodies may contain credentials in transit, but that is the
  point of the endpoint and matches TeamClaude's existing import route.

### 1.7 UI

- **Settings → "Agent Accounts" pane** (`packages/ui/.../settings/AgentAccountsSettings.tsx`),
  reusing the TeamClaude accounts panel pattern: per-agent sections, each listing accounts
  (label, plan, `needsReauth` badge) with remove + "set default"; an import dropzone +
  file-picker + host-path input; agent auto-detected on import, with a label field required for
  Claude.
- **Launch flow:** the agent-launch UI gains an account picker (System + each account for that
  agent), shown **only when more than one option exists**; selection sets `accountId` on the
  create request.
- **Session tab:** an account badge when a session runs a non-System account.

---

## Feature 2 — Remove TeamClaude

Full removal (managed accounts supersede it):

- Delete `apps/daemon/src/teamclaude.ts` and `teamclaude.check.ts`.
- Delete the `/api/addons`, `/api/addons/:id/install|update`, `/api/addons/teamclaude`
  (GET/PUT) routes in `index.ts`; remove the `TeamClaudeService` construction, the
  `resolveExtraEnv` TeamClaude branch (replaced by 1.4), and both `teamclaude.events`
  broadcasts.
- Remove `enrichClaudeWithTeamClaude` from the usage wiring (`index.ts:250-255`); the Claude
  source becomes `createClaudeSource(...)` directly, plus per-account entries from Feature 3.4.
- Remove `teamclaude*` from `packages/config` (schema + path helpers), `packages/api` (types +
  `HttpOrquesterApiClient` methods), and `packages/ui/.../settings/AddonsSettings.tsx` (delete
  the file and its `SettingsModal` entry).
- Drop `teamclaude.json` handling; a stale file on disk is simply ignored.

**Consciously lost:** automatic load-pooling/rotation across accounts. Managed accounts are
explicit per-session selection, not auto-balancing. Documented here so it is a decision, not an
accident.

---

## Feature 3 — Usage upgrades

### 3.1 Live Codex source

Rewrite `createCodexSource` (`usage-sources.ts`) to mirror `createClaudeSource`'s structure
(closure over `lastGood` + `backoffUntil`, "signed-in → never return null" discipline):

- Read the access token from `<codexHome>/auth.json` → `tokens.access_token`
  (+ `tokens.account_id`). `codexHome` = the per-account `CODEX_HOME` for per-account fetches,
  else `process.env.CODEX_HOME || $HOME/.codex`.
- `GET https://chatgpt.com/backend-api/wham/usage` with headers `Authorization: Bearer <token>`,
  `User-Agent: codex-cli`, `OpenAI-Beta: codex-1`, `originator: Codex Desktop`, and
  `ChatGPT-Account-Id: <account_id>` when present.
- Map `plan_type` and `rate_limit.primary_window` → session/300 min,
  `secondary_window` → weekly/10080 min, from `used_percent` / `reset_at` (unix **seconds**,
  ×1000) / `limit_window_seconds`. Same 429/`Retry-After` (5-min floor) and stale-fallback
  handling as Claude.
- **Fallback:** on non-OK / parse failure, fall back to the current rollout-log scrape
  (`findLastCodexTokenCount`) so a logged-in Codex with a broken HTTP contract still renders.

### 3.2 Open the agent set

- `packages/api`: `AgentUsage.id` becomes `string` (was `"claude" | "codex"`).
- `packages/config` `usagePrefsSchema`: replace the fixed `claude` / `codex` booleans with
  `agents: z.record(z.string(), z.boolean())` (default `{}` = all enabled), and add a zod
  migration that maps any legacy `{claude, codex}` prefs into the record. Drop the
  TeamClaude-specific wording on `view` (keep the field: `aggregate | accounts` now means
  managed-account breakdown). `chip` stays as-is — its enum keeps `busiest | claude | codex`
  and simply gains no new members in v1 (opening the agent set doesn't require touching it).
- `packages/ui` `UsageWidget`: derive labels and the present/missing lists from the registry
  agent entries instead of the hardcoded `AGENT_LABEL` map and `["claude","codex"]` arrays.

This unblocks Gemini and others later with no further wire-type surgery (adding a source is
then just another `create*Source`).

### 3.3 Token/cost aggregates

New `apps/daemon/src/usage-tokens.ts` (+ check), independent of the rate-limit sources:

- **Scan** `<home>/projects/**/*.jsonl` (Claude: per line `message.usage.{input_tokens,
  output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` + `message.model`) and
  `<home>/sessions/**` (Codex: diff cumulative `total_tokens` between consecutive rows to get
  the billable increment, dedupe as the existing scanner does).
- **Aggregate** per `{agent, model, day}`; estimate USD from a hardcoded per-model price table
  (USD per 1M tokens), labeled `costSource: "api_equivalent"` (subscription users don't pay
  per-token — the figure is "what this would cost on the API"). Unknown model → null cost.
- **Cache** to `<appdir>/daemon/usage-tokens.json` (0600), incremental by file mtime so a
  restart doesn't rescan everything. Recompute nudged by the existing `~/.claude` / `~/.codex`
  fs watcher (`index.ts:262-283`).
- **Expose** `GET /api/usage/tokens` (aggregates + as-of); the price table lives in one place
  next to the scanner for easy per-model updates.
- **UI:** a "Cost" tab in the usage panel (the widget's expanded `AdaptiveMenu`) showing
  per-agent/-model/-day token totals and estimated cost, with the `api_equivalent` caveat
  visible.

### 3.4 Per-account usage

Once Feature 1 exists:

- `UsageResponse` reports one `AgentUsage` entry per **authenticated managed account** (keyed
  by account id, labelled from the index) in addition to (or instead of) the System entry,
  controlled by the `view` pref (`aggregate` vs `accounts`).
- Per-account rate-limit fetches reuse the per-account `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. When
  fetching an idle account's usage, reuse the refresher's refresh-and-persist so displaying
  usage never strands an expiring token (Orca's `fetchManagedAccountUsage` behavior).
- These fetches are lazy/debounced when the account roster is opened (don't hammer N endpoints
  on every 5-min tick); the background refresher (1.5) is what keeps tokens warm in between.

---

## Data flow (account-pinned session)

```
UI launch (accountId) ─POST /api/sessions─▶ SessionManager.create
  │                                            │ resolveExtraEnv(entry, accountId)
  │                                            ▼
  │                              AgentAccountsService.resolveLaunchEnv
  │                                 → { CLAUDE_CONFIG_DIR|CODEX_HOME } (+ strip auth env)
  │                                            │
  │                                    tmux new-session -e … (env baked)
  ▼                                            ▼
SessionSummary{accountId} ◀── session.created ── agent runs against that account's home
```

Background: `startRefresher()` (hourly) → for each managed account with 0 live sessions and a
soon-expiring token → refresh + persist under ownership assert → broadcast on `invalid_grant`.

## Error handling

- **Import:** unparseable JSON, unrecognized shape, missing Claude label, or a host path
  outside any allowed root → 4xx with a specific message; nothing written.
- **Ownership assert failure** anywhere → hard error, operation aborts, nothing mutated.
- **Refresh `invalid_grant`** → account flagged `needsReauth`, surfaced in UI; not deleted.
- **Codex `wham/usage` down** → fall back to log scrape (3.1); Claude endpoint 429/5xx →
  existing backoff + signed-in-stale (never renders a logged-in account as logged-out).
- **Missing account home** (index references a deleted dir) → treat as System for that session
  and flag the account broken in the index.

## Testing / verification

No test runner in this repo; verification is `pnpm check` (typecheck) plus driving the real
surface (AGENTS.md). Concretely:

1. `pnpm check` clean across all packages after each feature.
2. Import a real `.credentials.json` and `auth.json`; confirm homes created 0700, marker
   written, index has no credential material, API responses redact credentials.
3. Launch two Claude sessions pinned to two different accounts; confirm each `claude` resolves
   its own `CLAUDE_CONFIG_DIR` (e.g. `claude auth status` in each) and they differ concurrently.
4. Delete an account with a live session vs. without; confirm ownership assert + clean removal
   and that the refresher skips accounts with live sessions.
5. Force a near-expiry token and confirm the refresher rotates + persists it and that a
   `invalid_grant` flags `needsReauth`.
6. Codex `wham/usage`: confirm live windows + `plan_type` appear before any session runs;
   simulate endpoint failure and confirm log-scrape fallback.
7. Token/cost: confirm aggregates match a hand-computed sample and the cache is
   mtime-incremental across a restart.

## Sequencing

1. **F1 + F2** as one change — F2's removal depends on F1 replacing the launch-env hook.
2. **F3.1** (Codex live source) and **F3.2** (open agent set) — independent, can land in either
   order relative to F1.
3. **F3.3** (token/cost) — independent, self-contained.
4. **F3.4** (per-account usage) — gates on F1.

## Files touched (map)

| Area | Files |
|---|---|
| New account service | `apps/daemon/src/agent-accounts.ts` (+ `.check.ts`) |
| Account schema/paths | `packages/config/src/index.ts` (`agentAccountsSchema`, `agentAccountsFile`) |
| Session env hook | `apps/daemon/src/index.ts` (`resolveExtraEnv`), `apps/daemon/src/sessions.ts` (thread `accountId`, env-strip pass) |
| Wire types | `packages/api/src/index.ts` (`CreateSessionRequest`, `SessionSummary`, `AgentUsage.id`, account types + events, client methods) |
| Usage sources | `apps/daemon/src/usage-sources.ts` (Codex rewrite), `apps/daemon/src/usage-tokens.ts` (new), `usage-parse.ts` |
| Usage prefs | `packages/config/src/index.ts` (`usagePrefsSchema` → record + migration) |
| TeamClaude removal | delete `apps/daemon/src/teamclaude.ts` (+check), `AddonsSettings.tsx`; prune routes/types/config |
| UI | new `AgentAccountsSettings.tsx`, launch-flow account picker, tab badge, `UsageWidget` (registry-driven + Cost tab), store `applyEvent` channel |
