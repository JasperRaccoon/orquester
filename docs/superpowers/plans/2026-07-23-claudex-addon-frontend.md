# claudex Addon — Build Plan Part 2 of 3: Frontend (wire · Settings UI · launcher chips · usage)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> Part 1 (`2026-07-23-claudex-addon-phase2.md`) built the working daemon proxy + seeding + per-account prefix routing. **This Part 2 is pure UI over already-working daemon mechanisms.** Part 3 (`2026-07-23-claudex-addon-workflow-deploy.md`) does the claudemix workflow + deploy.

**Goal:** Give the addon its full user surface: a Settings "Model proxy" panel (status, per-provider chips, seed-from-account, model default, enable/disable), launcher **model + account chips** on `claudex`/`claudemix` matching the stock Claude/Codex chip UX, visible-but-disabled launcher rendering, tab badges, and correct usage attribution (GPT/Kimi tokens never counted as Claude quota).

**Architecture:** Extend `@orquester/api` (`ApiClient` methods) and `@orquester/ui` (zustand store slice + `cliproxy.changed` event + `preferredModelByAgent` map + new `ModelProxySettings` component + `NewTabMenu` chip changes + `TabStrip` badge). Usage attribution is a daemon change (`usage-tokens.ts` + the Claude-home watcher) surfaced by the existing usage widget.

**Tech Stack:** React 18, zustand, Tailwind, TypeScript 5.8. No UI unit-test runner (AGENTS.md) — verify with `pnpm check` + `scripts/smoke-web.mjs` + live browser drive (agent-browser MCP) against a **separate dev web client**, never the live daemon.

## Global Constraints

- **⛔ Never launch/restart the live daemon.** UI verification uses `pnpm check`, the web smoke test, and browser drive against a dev SPA build — not the production daemon.
- Persisted client state (the new `preferredModelByAgent`) MUST load through schema/field validation with a fallback (AGENTS.md adapter-load rule; mirror `lib/preferred-account.ts`).
- Reuse the existing per-agent account machinery (`preferredAccountByAgent`, `CreateSessionRequest.accountId`) — do NOT invent a parallel account map.
- No secret material ever rendered (status/accounts show labels/emails only; never keys).
- `pnpm check` clean after every task; `pnpm build` (SPA) before any browser verification. Commit per task, by-name, on `main`.

## File Structure (Part 2)

```
packages/api/src/index.ts                          MODIFY  ApiClient cliproxy methods + CliProxySeedRequest (if not from Part 1)
packages/ui/src/lib/api-client.ts                  MODIFY  cliproxy method wrappers
packages/ui/src/lib/preferred-model.ts             CREATE  localStorage map (mirror preferred-account.ts)
packages/ui/src/store/app.ts                       MODIFY  cliproxy slice, cliproxy.changed, preferredModelByAgent, seed/enable actions
packages/ui/src/components/settings/ModelProxySettings.tsx   CREATE  the "Model proxy" panel
packages/ui/src/components/settings/SettingsModal.tsx        MODIFY  add the "modelproxy" section
packages/ui/src/components/topbar/NewTabMenu.tsx             MODIFY  model chips + account family remap + disabled rendering
packages/ui/src/components/topbar/TabStrip.tsx               MODIFY  tab badge (backing model + short account)
apps/daemon/src/usage-tokens.ts                    MODIFY  tag proxy-home records with launcher id, exclude from Claude aggregate
apps/daemon/src/index.ts                           MODIFY  Claude-home watcher covers proxy homes
apps/daemon/src/usage-tokens.test.ts               MODIFY  attribution test
```

---

### Task 1: `ApiClient` cliproxy methods

**Files:**
- Modify: `packages/api/src/index.ts` (`ApiClient` class / the reference HTTP client)
- Modify: `packages/ui/src/lib/api-client.ts` (the UI transporter-backed client wrappers)

**Interfaces:**
- Consumes: Part 1's `/api/cliproxy` routes + `CliProxyStatus`/`CliProxyProviderStatus`/`CliProxySeedRequest` (already in `@orquester/api`).
- Produces (methods, both on the reference client and the UI `ApiClient`):
  - `getCliProxyStatus(): Promise<CliProxyStatus>` → `GET /api/cliproxy`
  - `getCliProxyModels(): Promise<{ models: string[]; asOf: string | null }>` → `GET /api/cliproxy/models`
  - `enableCliProxy(): Promise<CliProxyStatus>` / `disableCliProxy(force?: boolean): Promise<{ ok: boolean; affectedSessions?: number }>`
  - `setCliProxyConfig(cfg: { defaultModel?: string; backgroundModel?: string }, force?: boolean): Promise<CliProxyStatus>`
  - `seedCliProxyAccount(req: CliProxySeedRequest): Promise<CliProxyProviderStatus>` → `POST /api/cliproxy/accounts/seed`
  - `setCliProxyOpenRouterKey(key: string, force?: boolean): Promise<CliProxyStatus>` → `POST /api/cliproxy/openrouter/key`

- [ ] **Step 1:** Add the methods (mirroring the existing `ApiClient` method style — same fetch/transport helper, same error unwrapping). No UI test runner; the contract is enforced by `pnpm check` + Task 2/3 consumers.
- [ ] **Step 2:** `pnpm check` → clean.
- [ ] **Step 3: Commit** — `git add packages/api/src/index.ts packages/ui/src/lib/api-client.ts && git commit -m "feat(api,ui): ApiClient methods for /api/cliproxy status/models/enable/seed/config"`

---

### Task 2: Store slice — cliproxy state, `cliproxy.changed`, `preferredModelByAgent`, actions

**Files:**
- Create: `packages/ui/src/lib/preferred-model.ts`
- Modify: `packages/ui/src/store/app.ts`
- (No unit runner — verified by `pnpm check` + the components in Tasks 3–5.)

**Interfaces:**
- Consumes: Task 1 client methods; the existing `preferredAccountByAgent` pattern (store lines ~559/717/1650) and the event dispatcher (line ~1910, `registry.changed`).
- Produces:
  - `lib/preferred-model.ts` — `loadPreferredModels(): Record<string,string>` + `savePreferredModels(map): void`, localStorage key `orquester:preferred-model-by-agent`, **per-field `typeof === "string"` validation + try/catch fallback to `{}`** (verbatim pattern of `preferred-account.ts`).
  - Store state additions: `cliproxy: CliProxyStatus | null`; `cliproxyModels: { models: string[]; asOf: string | null } | null`; `preferredModelByAgent: Record<string,string>` (loaded via `loadPreferredModels()`).
  - Actions: `loadCliProxy(): Promise<void>` (fetch status + models); `setPreferredModel(agentId, model): void` (persist, mirror `setPreferredAccount`); `enableCliProxy()/disableCliProxy(force)/seedCliProxyAccount(req)/setCliProxyOpenRouterKey(key)/setCliProxyDefaultModel(model)` (call client, refresh `cliproxy`).
  - Event handling: extend the dispatcher — `event.channel === "cliproxy" && event.type === "cliproxy.changed"` → set `cliproxy` from the event payload (or refetch); on reconnect, `loadCliProxy()` alongside the existing refetches.
  - `openTab` gains an optional `model` arg (Part 1 wired the request field; here the store passes `preferredModelByAgent[agentId]` and the already-existing `preferredAccountByAgent[agentId]` into `createSession`).

- [ ] **Step 1:** Implement `preferred-model.ts` + the store additions.
- [ ] **Step 2:** `pnpm check` → clean.
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): cliproxy store slice, cliproxy.changed handling, preferred-model persistence"` (by-name staging)

---

### Task 3: `ModelProxySettings` panel + Settings section

**Files:**
- Create: `packages/ui/src/components/settings/ModelProxySettings.tsx`
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx` (add `"modelproxy"` to the `Section` union, `SECTIONS` list, and `renderSection`)

**Interfaces:**
- Consumes: Task 2 store state/actions.
- Produces a panel rendering (all from `cliproxy` status + `cliproxyModels`):
  - **Status header**: `state` (off/downloading/building/starting/healthy/degraded/error) with the `detail` substage and `reasons[]`; an Enable/Disable button (Disable shows an affected-session confirm when `activeSessionCount > 0`).
  - **Per-provider chips**: `codex ✓ / claude ✓ / openrouter ✗` from `status.providers[]`, each with last-verified time and, when `missing`/`expired`, a **"Seed from managed account"** action → a small picker of the user's Claude/Codex managed accounts (`agentAccounts.accounts` filtered by provider) → `seedCliProxyAccount({provider, accountId})`. OpenRouter shows an import-from-OpenCode / paste-key field → `setCliProxyOpenRouterKey`.
  - **Default model** dropdown (fed by `cliproxyModels.models`, **always shows the persisted `status.defaultModel` even if the fetch failed** — never blank) → `setCliProxyDefaultModel`. A **background model** dropdown likewise.
  - Copy is value-first ("GPT / Kimi in the Claude Code harness"), not mechanism-first.
- `SettingsModal`: `{ id: "modelproxy", label: "Model proxy", icon: <…/>, desc: "Run GPT & Kimi in the Claude Code harness" }`, placed after "agents"; `renderSection("modelproxy") → <ModelProxySettings/>`.

- [ ] **Step 1:** Build the component + wire the section.
- [ ] **Step 2:** `pnpm check` → clean; `pnpm build`.
- [ ] **Step 3: Browser-verify** (agent-browser MCP against a dev SPA pointed at a dev daemon, OR document-verify if no dev daemon): open Settings → Model proxy, assert the status header + provider chips render from a mocked/real status; screenshot.
- [ ] **Step 4: Commit** — `git commit -m "feat(ui): Model proxy settings panel (status, provider seed chips, model defaults)"`

---

### Task 4: `NewTabMenu` — model chips + account family remap + disabled rendering

**Files:**
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx`

**Interfaces:**
- Consumes: Task 2 (`preferredModelByAgent`, `cliproxyModels`), the existing `preferredAccountByAgent`.
- Produces — the crux of the per-launch UX (spec §2/§5):
  - **Launcher family map**: `const PROXY_ACCOUNT_FAMILY: Record<string,"claude"|"codex"> = { claudemix: "claude", claudex: "codex" }`. `AgentRow`'s account source becomes: for a proxy launcher, `accounts.filter(a => a.agent === PROXY_ACCOUNT_FAMILY[agent.id])`; otherwise the existing `a.agent === agent.id`. This is why the chips appear at all (the raw id never matches a managed account).
  - **Account chips** (System + each seeded/managed account of the family) exactly like today, writing `preferredAccountByAgent[agent.id]` and passed as `accountId` on `openTab`.
  - **Model chips** for `claudex` (`gpt-5.6-sol` / `kimi-k3` / others from `cliproxyModels.models`), writing `preferredModelByAgent[agent.id]`, passed as `model` on `openTab`; the account row is **dimmed when the picked model is Kimi** (OpenRouter is keyless — account irrelevant).
  - **Disabled rendering**: the top-level agent filter changes from `registry.agents.filter(a => a.enabled)` to include disabled proxy entries rendered greyed with their `disabledReason` (tooltip) and a non-clickable state — so a `claudex` whose proxy is down is *visible but disabled*, not gone (spec §2). Non-proxy disabled agents keep today's behavior (hidden).
  - Distinct icons/colors for `claudex` vs `claudemix` (ids differ by two letters — spec §5 usability requirement).

- [ ] **Step 1:** Implement the family map, chip rows, dimming, and disabled rendering.
- [ ] **Step 2:** `pnpm check` → clean; `pnpm build`.
- [ ] **Step 3: Browser-verify**: with claudex/claudemix enabled, the "+" menu shows a model row (claudex) and an account row from the correct family; picking chips persists; a disabled entry shows greyed with a reason. Screenshot both states.
- [ ] **Step 4: Commit** — `git commit -m "feat(ui): claudex/claudemix launcher model+account chips with provider-family remap and disabled rendering"`

---

### Task 5: `TabStrip` badge

**Files:**
- Modify: `packages/ui/src/components/topbar/TabStrip.tsx`

**Interfaces:**
- Consumes: `SessionSummary.model` (Part 1) + the session's `accountId`.
- Produces: for a `claudex`/`claudemix` tab, a small badge showing the backing model (`sol`/`kimi`/short) and, when an account is pinned, a short account label — rendered from the **session record** (never client chip state), so it survives refresh/reattach.

- [ ] **Step 1:** Add the badge (reuse `shortAccountLabel`; add a `shortModelLabel`).
- [ ] **Step 2:** `pnpm check`; `pnpm build`.
- [ ] **Step 3: Browser-verify**: a launched claudex tab shows its model badge; screenshot.
- [ ] **Step 4: Commit** — `git commit -m "feat(ui): tab badge shows the backing model/account for proxy sessions"`

---

### Task 6: Usage attribution — proxy-home tagging (daemon)

**Files:**
- Modify: `apps/daemon/src/usage-tokens.ts`
- Modify: `apps/daemon/src/index.ts` (Claude-home change watcher)
- Test: `apps/daemon/src/usage-tokens.test.ts`

**Interfaces:**
- Fixes the Phase-1 review gap + spec §6: the token scanner covers system + managed account homes and hardcodes `agent: "claude"`. Extend the injected `accountHomes()` set to include the two `cliproxy/claude-home-*` dirs, and **tag records discovered under those homes with the launcher id** (`claudex`/`claudemix`), **excluding them from the Claude-account aggregate** — otherwise GPT/Kimi transcript tokens inflate the "how much Anthropic quota is left" signal. The `index.ts` Claude-home watcher (currently only the system roots) must also watch the proxy homes so live sessions update usage.

- [ ] **Step 1: Write the failing test:** a transcript under `cliproxy/claude-home-claudex/projects/…` is tagged `claudex`, NOT folded into the `claude` aggregate; a system-home transcript stays `claude`.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** the home-set extension + launcher-id tagging + watcher coverage.
- [ ] **Step 4: Run `usage-tokens.test.ts` + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): attribute proxy-home transcripts to launcher id, exclude from Claude usage aggregate"`

---

### Task 7: Frontend close-out + web smoke

- [ ] **Step 1:** `pnpm check` clean; `pnpm build` clean; full daemon suite green (Task 6 changed daemon code).
- [ ] **Step 2:** `node scripts/smoke-web.mjs <dev-url>` (clean storage + the legacy localStorage fixtures) — no uncaught errors, `#root` non-empty. Add a `preferredModelByAgent` legacy-shape fixture to `scripts/smoke-web-fixtures.json` and confirm it degrades gracefully (adapter-load rule).
- [ ] **Step 3:** `superpowers:requesting-code-review`; fix findings.
- [ ] **Step 4: Commit** review fixes.

---

## Self-Review (write-time)

- **Spec coverage (Part 2):** §3 wire/client → Task 1; store/events/persistence → Task 2; §5 Settings panel + provider seed chips → Task 3; §2/§5 launcher model+account chips + family remap + disabled rendering → Task 4; tab badge → Task 5; §6 usage attribution → Task 6. Nothing deferred; there is no device-auth login UI (seeding is the only credential path).
- **Placeholder scan:** none — components specified at contract level with concrete store/props; UI verified via browser drive + web smoke (there is no UI unit runner, per AGENTS.md).
- **Type consistency:** `CliProxyStatus`/`CliProxyProviderStatus`/`CliProxySeedRequest` single-sourced from `@orquester/api` (Part 1) through `ApiClient` (Task 1) → store (Task 2) → components (Tasks 3–5); `preferredModelByAgent` mirrors `preferredAccountByAgent` exactly; `PROXY_ACCOUNT_FAMILY` is the one launcher-id→family map (Task 4).
