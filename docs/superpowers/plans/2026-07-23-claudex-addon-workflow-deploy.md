# claudex Addon — Build Plan Part 3 of 3: claudemix Workflow · §8 Routing · Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> Parts 1–2 (`…-phase2.md`, `…-frontend.md`) built the daemon proxy + full UI. **This Part 3 delivers the flagship mixed-model workflow, verifies in-session per-subagent routing, and ships to the VPS.**

**Goal:** Ship the canonical **Fable-plans / Kimi-designs / Sol-executes / tri-model-review** claudemix workflow (with a real partial-failure quorum), verify the §8 harness routing that makes it possible (`agent({model})` / frontmatter routing per subagent), and deploy the whole addon to the VPS with a full live end-to-end.

**Architecture:** A committed, parameterized workflow script under `.claude/workflows/`, a claudemix launch-time model pre-flight check in the daemon, and the standard Orquester deploy (provision → build SPA → systemd → smoke) — with **no Go toolchain** (spike F3 removed the source build).

**Tech Stack:** The Workflow tool (JS scripts), Claude Code CLI, CLIProxyAPI stock binary, Ubuntu/systemd/Caddy deploy stack.

## Global Constraints

- **⛔ Never restart the live daemon serving this checkout.** The §8 routing verification and live end-to-end run **on the deploy target** (or a separate checkout), per AGENTS.md — not against this workspace's daemon.
- The canonical workflow must handle **1-of-3 subagent failure** gracefully (spec §8.5): wrapped `agent()` calls, configurable quorum (default 2-of-3), failures surfaced — the harness does not retry provider errors.
- Deploy is non-interactive (`CI=1`), stdin detached (`</dev/null`), confirmed by the live bundle hash (AGENTS.md deploy rules).
- Commit per task, by-name, on `main`.

## File Structure (Part 3)

```
.claude/workflows/claudemix-tri-model.js       CREATE  the canonical Fable→Kimi→Sol→review workflow
apps/daemon/src/cliproxy.ts                     MODIFY  claudemix launch model pre-flight (validate referenced/default model)
apps/daemon/src/cliproxy-manager.test.ts        MODIFY  pre-flight test
docs/superpowers/spikes/2026-07-23-claudex-routing.md   CREATE  §8 in-session routing verification log
docs/DEPLOY_TO_VPS.md                           (gitignored, per-machine — update if present)
docs/superpowers/spikes/2026-07-23-claudex-live-e2e.md  CREATE  live end-to-end log
```

---

### Task 1: claudemix launch model pre-flight (daemon)

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts` (extend `validateModel` / add a launch pre-flight surfaced through the create path)
- Test: `apps/daemon/src/cliproxy-manager.test.ts`

**Interfaces:**
- Spec §8.4: when a claudemix session launches, the models it will reference (the default + any configured) are validated against a fresh `/v1/models` so an unknown model fails **before** work starts with a clear provider-named error, not as an opaque mid-run subagent failure. Part-1 `validateModel` already validates the *main* model; this adds a warn-surface for the workflow's referenced models where known (best-effort — workflow `agent({model})` strings are dynamic, so this is a launch-time catalog snapshot the UI can warn against, not a hard gate on every future call).
- Produces: `preflightModels(models: string[]): Promise<{ ok: string[]; missing: string[] }>` on the manager; used by the create path to attach a warning to the session when any referenced model is absent.

- [ ] **Step 1: Write the failing test:** `preflightModels(["gpt-5.6-sol","nope-1"])` against a fake catalog `["gpt-5.6-sol","kimi-k3"]` → `{ ok:["gpt-5.6-sol"], missing:["nope-1"] }`.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): claudemix launch model pre-flight against the live catalog"`

---

### Task 2: The canonical claudemix tri-model workflow

**Files:**
- Create: `.claude/workflows/claudemix-tri-model.js`

**Interfaces:**
- A saved Workflow script (runnable via the Workflow tool inside a **claudemix** session — where the main loop is Fable and `gpt-*`/`kimi-k3` subagents route through the proxy). Encodes spec §8's canonical flow with real degradation:
  - `meta` with phases `Plan / Design / Execute / Review`.
  - **Plan** — one `agent()` on the default model (Fable) produces a structured plan (schema).
  - **Design** — `agent(designPrompt, {model:"kimi-k3"})` produces the frontend/design artifact (Kimi's strength per the user's rationale).
  - **Execute** — `agent(execPrompt, {model:"gpt-5.6-sol"})` (one or fanned) implements against the plan+design.
  - **Review** — a **quorum panel**: three reviewers on three models (`claude-*`, `gpt-5.6-sol`, `kimi-k3`), each wrapped so a provider error resolves to a null vote; **pass = ≥2 of 3 approve** (configurable). Failures are surfaced in the returned result, never retried (spec §8.5).
  - Returns `{ plan, design, execution, review: { votes, approved, failures } }`.
- The script is parameterized via `args` (the task description) so it's reusable.

- [ ] **Step 1:** Write the workflow script with the four phases + quorum review + wrapped `agent()` calls.
- [ ] **Step 2: Static check** — the script parses (it's plain JS; a quick `node --check` on a CommonJS-wrapped copy, or lint via the Workflow author's own validation) and `meta` is a pure literal.
- [ ] **Step 3: Commit** — `git add .claude/workflows/claudemix-tri-model.js && git commit -m "feat(workflows): canonical claudemix Fable→Kimi→Sol→tri-model-review workflow with quorum"`

*(Live execution of this workflow is Task 5's end-to-end, on the deploy target.)*

---

### Task 3: §8 in-session routing verification (on deploy target / separate checkout)

**Files:**
- Create: `docs/superpowers/spikes/2026-07-23-claudex-routing.md` (log)

The one remaining empirical unknown (spec §8.1): does the Claude Code harness route a **non-Anthropic model string per subagent**? Verify against a real seeded proxy (the deploy target), never this workspace's daemon.

- [ ] **Step 1:** In a claudemix session pointed at the seeded proxy, test each channel and record which routes per-subagent: (a) a subagent via `CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol`; (b) a Workflow `agent("…", {model:"gpt-5.6-sol"})`; (c) a custom agent file with frontmatter `model: gpt-5.6-sol`. Confirm the proxy log shows the subagent request hitting the Codex backend while the main loop stays on Claude.
- [ ] **Step 2:** Record the **unknown-model error surface** — reference a model absent from the catalog and capture exactly what the harness does (error/retry/fallback), confirming Task 1's pre-flight warning is the right mitigation.
- [ ] **Step 3:** Confirm the account **prefix routing** end-to-end via the UI: launch two claudex tabs on two different seeded Codex accounts (if ≥2 exist) / two claudemix tabs on the two Claude accounts, and confirm each routes to its pinned account (proxy log / usage).
- [ ] **Step 4:** Record results; commit the log.

---

### Task 4: Deploy — provision (no Go), build SPA, ship

**Files:**
- (Deploy commands; update the gitignored `DEPLOY_TO_VPS.md` if present.)

**Interfaces:**
- Standard Orquester deploy (AGENTS.md "Routine updates"), plus: p7zip/ripgrep already provisioned; **no Go toolchain needed** (stock binary). The daemon serves the addon after `systemctl restart` (tsx runs new source); the SPA needs `pnpm build` because Part 2 changed `packages/ui`/`apps/web`.

- [ ] **Step 1:** `sudo git fetch && sudo git reset --hard origin/main`; `sudo -u orquester CI=1 pnpm install --frozen-lockfile </dev/null`; `sudo -u orquester pnpm build </dev/null` (SPA changed); `sudo chown -R root:root /opt/orquester`; `sudo systemctl restart orquester`.
- [ ] **Step 2:** `curl -fsS http://127.0.0.1:47831/health` → `{"ok":true}`; confirm the live bundle hash changed (`curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js'`).
- [ ] **Step 3:** `node scripts/smoke-web.mjs https://<domain>` (clean + legacy fixtures) → clean.
- [ ] **Step 4:** On trouble: `journalctl -u orquester -n 50 --no-pager`. No commit (deploy is an operation) — record outcome in the live-e2e log (Task 5).

---

### Task 5: Live end-to-end (on the deployed instance)

**Files:**
- Create: `docs/superpowers/spikes/2026-07-23-claudex-live-e2e.md` (log)

Drive the real deployed UI (agent-browser MCP or manual) — the full user journey:

- [ ] **Step 1:** Settings → Model proxy → **Enable**; watch it go `downloading → starting → healthy` (binary sha256-verified). Seed the Codex account and a Claude account from the managed-account pickers; seed the OpenRouter key from OpenCode. Confirm provider chips go green.
- [ ] **Step 2:** "+" menu shows `claudex` (model row GPT/Kimi + Codex account row) and `claudemix` (Claude account row), both enabled. Launch **claudex on `gpt-5.6-sol`** → reply works; launch **claudex on `kimi-k3`** → a deep tool loop works (no empty-content 400 — spike F3); tab badges show the model.
- [ ] **Step 3:** Launch **claudemix**; run `.claude/workflows/claudemix-tri-model.js` on a small real task → confirm Fable plans, Kimi designs, Sol executes, the tri-model review returns a quorum verdict, and a forced 1-of-3 reviewer failure degrades gracefully (spec §8.5).
- [ ] **Step 4:** Confirm usage attribution — GPT/Kimi tokens appear tagged to the launchers, **not** inflating the Claude account quota (spec §6, Part-2 Task 6).
- [ ] **Step 5:** Record everything in the log; commit the log.

---

## Self-Review (write-time)

- **Spec coverage (Part 3):** §8 canonical workflow + quorum/partial-failure → Task 2; §8.1/§8.4 routing + unknown-model surface → Tasks 1/3; §2 prefix routing live proof → Task 3; deploy → Task 4; full live journey + §6 attribution → Task 5; §8.3 cost → Task 5 (gated). Nothing deferred.
- **Placeholder scan:** none — the routing/e2e tasks are empirical logs by nature. No device-auth and no cost-measurement task exist (both removed by explicit decision).
- **Type/name consistency:** the workflow uses the deployed model names verified in the spikes (`gpt-5.6-sol`, `kimi-k3`, `claude-*`); `preflightModels` is the single pre-flight entry point (Task 1) referenced by the create path.

---

## Build-order across all three plans

1. **Part 1 (daemon)** — install, seed + prefix routing, lifecycle, launcher enablement. *(Standalone testable: daemon suite + on-VPS module e2e.)*
2. **Part 2 (frontend)** — wire/client, Settings panel, launcher chips, tab badge, usage attribution. *(Depends on Part 1's routes/types.)*
3. **Part 3 (workflow + deploy)** — canonical workflow, §8 routing verification, deploy, live e2e. *(Depends on Parts 1–2 being live.)*

Execute in order; each part is committed to `main` and independently reviewable. There are no gated or deferred actions in the build — device-auth login and the cost measurement were both removed by explicit decision.
