# claudex Addon — Phase 1 Implementation Plan (Spike + Daemon Foundations)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the spike plus every spike-independent daemon foundation of the claudex addon (spec: `docs/superpowers/specs/2026-07-22-claudex-addon-design.md`), ending with a daemon that can manage a CLIProxyAPI process, expose `claudex`/`claudemix` launchers with per-launch model choice, and pass a new test suite — while the empirical spike findings gate Phase 2 (build pipeline, login flows, UI, Kimi patch, claudemix dry-run).

**Architecture:** A new `CliProxyManager` daemon service owns `<appdir>/daemon/cliproxy/` (secrets, config, token, homes, state) and runs the proxy in a tmux service session outside the `orq-` namespace. Registry gains runtime enable/disable + env re-resolution; sessions gain a launch-context (per-launch `model`) threaded to a composed addon-env contributor; hooks gain a canonical agent-family mapping.

**Tech Stack:** TypeScript 5.8 ESM, Node 20, Fastify 4, zod (only in `@orquester/config`), node:test via `apps/daemon` `pnpm test`, tmux ≥ 3.2.

## Global Constraints

- **⛔ Never launch/restart a daemon against this checkout** (AGENTS.md). All verification is `pnpm check` + `apps/daemon` unit tests. Live verification happens in the spike (separate paths) or on deploy.
- `pnpm check` (repo-wide `tsc --noEmit`) must be clean after every task.
- Daemon tests: `cd apps/daemon && pnpm test` (`node --import tsx --test`). New test files follow the existing `src/*.test.ts` pattern.
- zod schemas live **only** in `@orquester/config`. Persisted JSON loads go through `safeParse` + fallback; **corrupt `secrets.json` fails closed** (spec §1) — never regenerate on corruption.
- Secrets never cross the wire; registry `env` stays redacted via `publicEntry`; nothing new returns key material.
- Service tmux session name: `orqsvc-cliproxy` (must NOT start with `orq-` — reaper immunity depends on it; `"orqsvc-".startsWith("orq-") === false` because char 3 is `s`).
- Proxy port default `8317`, loopback only. Local API key / management secret / OpenRouter key: authoritative store `secrets.json` (0600); `config.yaml` + `token` are projections.
- Both new registry entries use args `["--dangerously-skip-permissions", "--effort", "max", "--verbose"]` (decided; same as stock `claude`).
- Commit after every task, to the current branch (`main`), per AGENTS.md.

## File Structure (Phase 1)

```
docs/superpowers/spikes/2026-07-22-claudex-spike-findings.md   (Task 0 output)
packages/config/src/index.ts          MODIFY  add cliproxy schemas + path helpers
packages/api/src/index.ts             MODIFY  RegistryEntry.disabledReason, CreateSessionRequest.model,
                                              SessionSummary.model, CliProxy* wire types
packages/registry/src/index.ts        MODIFY  claudex + claudemix entries (enabled:false at rest)
apps/daemon/src/registry.ts           MODIFY  setRuntimeState / reresolve / disabledReason
apps/daemon/src/tmux.ts               MODIFY  raw-name service-session methods
apps/daemon/src/sessions.ts           MODIFY  launch-context, session-record model, effectiveModel hook
apps/daemon/src/agent-hooks.ts        MODIFY  canonical agent-family mapping
apps/daemon/src/index.ts              MODIFY  wiring + /api/cliproxy routes + composed contributor
apps/daemon/src/cliproxy-secrets.ts   CREATE  secrets store (generate / fail-closed load / project)
apps/daemon/src/cliproxy-files.ts     CREATE  config.yaml render, token file, env files, wrapper bins,
                                              home seeder (all hardened writes)
apps/daemon/src/cliproxy.ts           CREATE  CliProxyManager state machine
apps/daemon/src/cliproxy-secrets.test.ts       CREATE
apps/daemon/src/cliproxy-files.test.ts         CREATE
apps/daemon/src/cliproxy-manager.test.ts       CREATE
apps/daemon/src/registry-runtime-state.test.ts CREATE
apps/daemon/src/tmux-service-session.test.ts   CREATE
apps/daemon/src/session-model.test.ts          CREATE
apps/daemon/src/agent-family.test.ts           CREATE
```

Phase 2 (separate plan, after Task 0 findings): source-build pipeline, login flows (`login/start|status|cancel|callback`), OpenRouter key route, Settings UI + chips + `NewTabMenu` disabled rendering, usage scanner/watcher extension, Kimi translator patch, claudemix workflow dry-run, deploy.

---

### Task 0: The Spike (manual, separate paths — findings gate Phase 2)

**Files:**
- Create: `docs/superpowers/spikes/2026-07-22-claudex-spike-findings.md`

**Interfaces:**
- Produces: a findings document with a **verdict line per numbered item below** (`CONFIRMED` / `REFUTED (details)` / `BLOCKED (why)`). Phase 2's plan is written from this file.

This task is a runbook, not TDD. Everything runs on the VPS **under paths that never touch the live daemon or appdir state**: work in `~/cliproxy-spike/` as the session user. The daemon is NOT restarted; the spike proxy binds `127.0.0.1:8317` only if free — otherwise use `18317` and note it.

- [ ] **Step 1: Install a stock CLIProxyAPI binary**

```bash
mkdir -p ~/cliproxy-spike && cd ~/cliproxy-spike
# Pin the latest release observed at research time; record the exact version used.
VER=$(curl -fsSL https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"])')
echo "$VER" | tee VERSION
curl -fsSL -o cpa.tgz "https://github.com/router-for-me/CLIProxyAPI/releases/download/${VER}/CLIProxyAPI_${VER#v}_linux_amd64.tar.gz"
sha256sum cpa.tgz | tee cpa.tgz.sha256
tar xzf cpa.tgz
```

- [ ] **Step 2: Minimal config + start**

Write `~/cliproxy-spike/config.yaml`:

```yaml
host: "127.0.0.1"
port: 8317
auth-dir: "/var/lib/orquester/cliproxy-spike-auth"   # adjust to $HOME/cliproxy-spike/auth
api-keys:
  - "spike-local-key-not-a-secret"
remote-management:
  allow-remote: false
  secret-key: "spike-mgmt-secret"
```

Start it in a spare tmux window (NOT the daemon's tmux server): `./cli-proxy-api --config ~/cliproxy-spike/config.yaml`.

- [ ] **Step 3: Verify finding 1 — config-hashing behavior (spec §1 `secrets.json` rationale — verify FIRST)**

After first startup, `cat config.yaml` and record: is `secret-key` now a hash? Is `api-keys` touched? Is an OpenRouter-style provider key (add one temporarily under `openai-compatibility`) hashed or left plaintext? → verdicts for spec assumptions (a) management-secret hashing, (c) provider keys readable.

- [ ] **Step 4: Verify finding 2 — Codex device auth headless**

`./cli-proxy-api --config … -codex-device-login` (and/or management API `GET /v0/management/codex-auth-url` with `X-Management-Key`). Record: does a pure device-code flow exist (URL + code, no localhost callback)? Complete it with the real ChatGPT account. Then `curl -s http://127.0.0.1:8317/v1/models -H "Authorization: Bearer spike-local-key-not-a-secret"` → record the `gpt-*` model list verbatim.

- [ ] **Step 5: Verify finding 3 — Claude device/OAuth flow + callback needs**

Same for Anthropic (`-claude-login` variant / `GET /v0/management/anthropic-auth-url`). Record precisely: device-code-only, or does it require a localhost redirect → does the management API accept a pasted callback (`/v0/management/oauth-callback`)? This decides whether Phase 2 builds the `login/callback` relay.

- [ ] **Step 6: Verify finding 4 — hot-discovery of auth files**

With the proxy running, drop/remove a credential JSON in the auth dir; poll `/v1/models`. Record whether the proxy hot-discovers (spec §3 claims device-auth completions need no restart).

- [ ] **Step 7: Verify finding 5 — claudex chain end-to-end (GPT)**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_AUTH_TOKEN=spike-local-key-not-a-secret \
ANTHROPIC_MODEL=<best gpt-* from step 4> \
ANTHROPIC_DEFAULT_HAIKU_MODEL=<same> \
CLAUDE_CODE_SUBAGENT_MODEL=<same> \
CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 \
CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3 \
ENABLE_TOOL_SEARCH=false \
CLAUDE_CONFIG_DIR=$HOME/cliproxy-spike/claude-home \
claude --model <same> -p "Reply with exactly: claudex works."
```

Then a short interactive session with tool use (edit a scratch file). Record: auth, streaming, tool calls, and the banner model line.

- [ ] **Step 8: Verify finding 6 — Claude-OAuth main loop through the proxy (claudemix precondition)**

Same env but no `ANTHROPIC_MODEL` overrides, `claude -p "what model are you"` with the proxy holding the Claude OAuth from step 5. Record auth/stream/tool-use behavior and any caching/latency observations (spec §8.2/§8.6).

- [ ] **Step 9: Verify finding 7 — Workflow/subagent model strings (spec §8.1)**

In the step-7 environment, run a session that (a) spawns a subagent with `CLAUDE_CODE_SUBAGENT_MODEL` pointing at a *different* catalog model, (b) if the Workflow tool is available, a minimal script with `agent('say hi', {model: '<other-model>'})`, (c) a custom agent file with frontmatter `model: <other-model>`. Record which channels accept non-Anthropic strings and the exact error surface for a model absent from the catalog (spec §8.4).

- [ ] **Step 10: Verify finding 8 — patched source build**

```bash
git clone --depth 1 --branch "$(cat VERSION)" https://github.com/router-for-me/CLIProxyAPI src
# Locate the translator: internal/translator/openai/claude/openai_claude_request.go
# Apply the fix manually: in the assistant-message branch, when !hasContent && hasToolCalls,
# do NOT set a content field; when !hasContent && !hasToolCalls set " ".
# Gate on model name matching /kimi|moonshot/i against BOTH the inbound model string and
# any post-alias resolved name available at that point — record which string is visible there.
GOTOOLCHAIN=local go build -o cli-proxy-api-patched ./cmd/server   # record Go version + build time + peak disk
```

Record: patch location line numbers, which model string the translator sees (alias vs resolved — spec §7.1's load-bearing question), build wall-time and disk usage (feeds Phase 2 constants).

- [ ] **Step 11: Verify finding 9 — Kimi end-to-end through the patched build**

Add the OpenRouter key (`openai-compatibility` provider + alias `kimi-k3` → `moonshotai/kimi-k3`) to the spike config, restart the patched binary, then repeat step 7 with `ANTHROPIC_MODEL=kimi-k3` and drive a **deep tool loop** (≥15 tool calls — e.g. "read these 10 files one by one, then summarize"). Record: no empty-content 400s, control-token leakage in output, temperature clamp needs.

- [ ] **Step 12: Verify finding 10 — cost per slot (spec §8.3)**

~30 min of step-7-style usage; record ChatGPT usage delta from the Codex usage panel/API, noting haiku-slot call volume (compaction/titles). Verdict on whether background calls need a cheaper `backgroundModel` than the main pick.

- [ ] **Step 13: Write findings + cleanup + commit**

Write `docs/superpowers/spikes/2026-07-22-claudex-spike-findings.md` with one section per finding (verdict + evidence + exact strings/versions/timings). Kill the spike proxy, remove `~/cliproxy-spike` **after** the findings file captures everything needed.

```bash
git add docs/superpowers/spikes/2026-07-22-claudex-spike-findings.md
git commit -m "docs: claudex spike findings (proxy behavior, model channels, patched build)"
```

---

### Task 1: `@orquester/config` — cliproxy schemas + paths

**Files:**
- Modify: `packages/config/src/index.ts` (append near the other schema/parse/createDefault groups; follow the existing `parseDaemonConfig`-style pattern exactly)
- Test: `apps/daemon/src/cliproxy-config.test.ts`

**Interfaces:**
- Produces:
  - `interface CliProxyState { enabled: boolean; version: string | null; versionSha256: string | null; goVersion: string | null; goSha256: string | null; defaultModel: string; backgroundModel: string; port: number; modelCatalog: { models: string[]; asOf: string } | null; testedClaudeCliVersion: string | null }`
  - `parseCliProxyState(raw: unknown): CliProxyState` (safeParse + `createDefaultCliProxyState()` fallback)
  - `createDefaultCliProxyState(): CliProxyState` (`enabled:false`, `defaultModel:"gpt-5.6-sol"`, `backgroundModel:"gpt-5.6-sol"`, `port:8317`, rest null)
  - `interface CliProxySecrets { apiKey: string; managementSecret: string; openRouterKey: string | null }`
  - `parseCliProxySecrets(raw: unknown): CliProxySecrets | "corrupt"` — **no default fallback**: schema failure returns the literal `"corrupt"` (fail-closed contract; callers must not regenerate).
  - `cliproxyDir(daemonDir: string): string` → `join(daemonDir, "cliproxy")`, plus `cliproxyStateFile`, `cliproxySecretsFile`, `cliproxyTokenFile`, `cliproxyHomeDir(daemonDir, entryId)` → `join(cliproxyDir, "claude-home-" + entryId)`.
  - `MODEL_NAME_RE = /^[A-Za-z0-9._/-]{1,128}$/` exported (used by env writer, routes, wrapper `--model`).

- [ ] **Step 1: Write the failing test** — `apps/daemon/src/cliproxy-config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCliProxyState, createDefaultCliProxyState,
  parseCliProxySecrets, cliproxyDir, cliproxyHomeDir, MODEL_NAME_RE
} from "@orquester/config";

test("state: defaults on garbage, valid passes through", () => {
  const d = parseCliProxyState({ nonsense: true });
  assert.equal(d.enabled, false);
  assert.equal(d.port, 8317);
  const ok = parseCliProxyState({ ...createDefaultCliProxyState(), enabled: true, defaultModel: "kimi-k3" });
  assert.equal(ok.enabled, true);
  assert.equal(ok.defaultModel, "kimi-k3");
});

test("secrets: corrupt fails closed, never defaults", () => {
  assert.equal(parseCliProxySecrets({ apiKey: 42 }), "corrupt");
  assert.equal(parseCliProxySecrets("not even an object"), "corrupt");
  const ok = parseCliProxySecrets({ apiKey: "a", managementSecret: "b", openRouterKey: null });
  assert.notEqual(ok, "corrupt");
});

test("paths + model charset", () => {
  assert.equal(cliproxyDir("/x/daemon"), "/x/daemon/cliproxy");
  assert.equal(cliproxyHomeDir("/x/daemon", "claudex"), "/x/daemon/cliproxy/claude-home-claudex");
  assert.ok(MODEL_NAME_RE.test("moonshotai/kimi-k3"));
  assert.ok(!MODEL_NAME_RE.test("bad model; rm -rf"));
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/daemon && pnpm test 2>&1 | grep -A2 cliproxy-config` → FAIL (exports missing).
- [ ] **Step 3: Implement** in `packages/config/src/index.ts` (zod schemas with `.catch()`-free explicit `safeParse`; `parseCliProxySecrets` returns `"corrupt"` on `!result.success`; path helpers as pure `join`s; export `MODEL_NAME_RE`). Mirror the file's existing naming and doc-comment style.
- [ ] **Step 4: Run tests + typecheck** — `cd apps/daemon && pnpm test`; `pnpm check` at repo root → both clean.
- [ ] **Step 5: Commit** — `git add packages/config/src/index.ts apps/daemon/src/cliproxy-config.test.ts && git commit -m "feat(config): cliproxy state/secrets schemas, paths, model-name charset"`

---

### Task 2: Wire types in `@orquester/api` + registry entries

**Files:**
- Modify: `packages/api/src/index.ts` — `RegistryEntry` (~line 580-608): add `disabledReason?: string`; `CreateSessionRequest` (~line 734-743): add `model?: string`; `SessionSummary` (~line 711+): add `model?: string`; append new `CliProxyStatus` types.
- Modify: `packages/registry/src/index.ts` — append two agent entries after `opencode`.
- Modify: `packages/config/src/index.ts` — persisted session record schema (~line 489): add optional `model` string field.

**Interfaces:**
- Produces:

```ts
// packages/api
export type CliProxyProviderId = "codex" | "claude" | "openrouter";
export interface CliProxyProviderStatus {
  provider: CliProxyProviderId;
  state: "ok" | "missing" | "expired";
  lastVerifiedAt: string | null;
}
export interface CliProxyStatus {
  state: "off" | "downloading" | "building" | "starting" | "healthy" | "degraded" | "error";
  reasons: string[];
  detail: string | null;
  version: string | null;
  defaultModel: string;
  backgroundModel: string;
  providers: CliProxyProviderStatus[];
  accounts: { id: string; provider: CliProxyProviderId; label: string; email?: string }[];
  activeSessionCount: number;
  testedClaudeCliVersion: string | null;
}
```

- Registry entries (static, disabled at rest — the manager enables them at runtime):

```ts
{
  id: "claudex",
  name: "Claude × GPT/Kimi",
  kind: "agent",
  bin: ["claude"] as const,
  args: ["--dangerously-skip-permissions", "--effort", "max", "--verbose"] as const,
  env: { CLAUDE_CODE_NO_FLICKER: "1" },
  versionFlag: "--version",
  enabledAtRest: false
},
{
  id: "claudemix",
  name: "Claude × Mixed",
  kind: "agent",
  bin: ["claude"] as const,
  args: ["--dangerously-skip-permissions", "--effort", "max", "--verbose"] as const,
  env: { CLAUDE_CODE_NO_FLICKER: "1" },
  versionFlag: "--version",
  enabledAtRest: false
}
```

  Note: the static `RegistryEntryDef` has no `enabled` field — check whether adding `enabledAtRest?: boolean` to the def type is cleaner than a JSON-override; **pick the def-field approach** and have `resolveDef` honor it (`enabled: Boolean(resolvedBin) && def.enabled !== false && def.enabledAtRest !== false` becomes part of Task 3's atomic recomputation).

- [ ] **Step 1:** Add the types/fields (no test runner in `packages/api`; the contract test is `pnpm check` + Task 3/5 tests consuming them).
- [ ] **Step 2:** `pnpm check` → clean (this catches every consumer of the widened types).
- [ ] **Step 3: Commit** — `git add packages/api/src/index.ts packages/registry/src/index.ts packages/config/src/index.ts && git commit -m "feat(api,registry): claudex/claudemix entries + model/disabledReason/CliProxyStatus wire types"`

---

### Task 3: RegistryService runtime state (`setRuntimeState` / `reresolve` / atomic enabled)

**Files:**
- Modify: `apps/daemon/src/registry.ts`
- Test: `apps/daemon/src/registry-runtime-state.test.ts` (model on the existing `registry-env.test.ts` fixtures)

**Interfaces:**
- Consumes: Task 2's `disabledReason` on `RegistryEntry`, `enabledAtRest` on the def.
- Produces (public methods on `RegistryService`):
  - `setRuntimeState(id: string, s: { enabled: boolean; disabledReason?: string }): void` — stores runtime state in a private `Map<string, {enabled: boolean; disabledReason?: string}>`, recomputes effective `enabled`, broadcasts `registry.changed` with the **sanitized** entry (through `publicEntry`).
  - `reresolve(id: string): Promise<void>` — re-runs bin resolution + `loadEnvFile` + `mergeEnv` for one entry, **preserves install state and runtime state**, broadcasts sanitized.
  - Effective enabled is one pure function used everywhere (init, install success, reresolve, setRuntimeState): `effectiveEnabled = Boolean(resolvedBin) && def.enabled !== false && def.enabledAtRest !== false && runtime.enabled !== false`. `disabledReason` is surfaced whenever effective enabled is false and runtime provides a reason.

- [ ] **Step 1: Write the failing test:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Reuse the construction pattern from registry-env.test.ts (temp daemonDir, fake broadcaster
// capturing events, a def whose bin resolves — copy its helper setup verbatim).

test("setRuntimeState disables with reason and broadcasts sanitized entry", async () => {
  const { registry, events } = await makeRegistryWithResolvedEntry("claudex");
  registry.setRuntimeState("claudex", { enabled: false, disabledReason: "proxy down" });
  const entry = registry.get("claudex")!;
  assert.equal(entry.enabled, false);
  assert.equal(entry.disabledReason, "proxy down");
  const evt = events.at(-1);
  assert.equal(evt.entry.disabledReason, "proxy down");
  assert.equal(evt.entry.env, undefined); // sanitized
});

test("reresolve re-reads env file but cannot resurrect a runtime-disabled entry", async () => {
  const { registry, writeEnvFile } = await makeRegistryWithResolvedEntry("claudex");
  registry.setRuntimeState("claudex", { enabled: false, disabledReason: "codex auth expired" });
  await writeEnvFile("claudex", "ANTHROPIC_MODEL=kimi-k3\n");
  await registry.reresolve("claudex");
  const entry = registry.get("claudex")!;
  assert.equal(entry.env?.ANTHROPIC_MODEL, "kimi-k3"); // env reloaded
  assert.equal(entry.enabled, false);                   // runtime state preserved — the race from spec §2
  assert.equal(entry.disabledReason, "codex auth expired");
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/daemon && pnpm test 2>&1 | grep -B1 -A3 runtime-state` → FAIL (methods missing).
- [ ] **Step 3: Implement** — add the private runtime map; extract the effective-enabled computation into one private method called from `resolveDef` results, `install()` success, `reresolve`, and `setRuntimeState`; `reresolve` reuses `resolveDef` then overlays install + runtime state before storing/broadcasting.
- [ ] **Step 4: Run tests + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): registry runtime enable/disable with disabledReason and env reresolve"`

---

### Task 4: Tmux raw-name service-session methods + reaper immunity

**Files:**
- Modify: `apps/daemon/src/tmux.ts`
- Test: `apps/daemon/src/tmux-service-session.test.ts` (pattern: the existing `tmux.test.ts` — skip when tmux is unavailable, use a throwaway `-S` socket)

**Interfaces:**
- Produces (methods on `Tmux`):
  - `newServiceSession(opts: { name: string; cwd: string; env: Record<string,string>; bin: string; args: string[] }): Promise<void>` — like `newSession` but uses `opts.name` verbatim; **throws unless `name.startsWith("orqsvc-")`** (guard against accidentally entering the reaped namespace).
  - `hasServiceSession(name: string): Promise<boolean>`
  - `killServiceSession(name: string): Promise<void>`
  - `SERVICE_SESSION_PREFIX = "orqsvc-"` exported.

- [ ] **Step 1: Write the failing test:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Copy tmux.test.ts's harness: temp socket path, tmux availability check, cleanup.

test("service session lives outside orq- namespace and survives listSessions/reattach scans", async (t) => {
  const tmux = await makeTestTmux(t); if (!tmux) return t.skip("no tmux");
  await tmux.newServiceSession({ name: "orqsvc-test", cwd: "/tmp", env: {}, bin: "sleep", args: ["60"] });
  assert.equal(await tmux.hasServiceSession("orqsvc-test"), true);
  const sessions = await tmux.listSessions();
  assert.ok(!sessions.includes("svc-test") && !sessions.some(s => s.includes("orqsvc")),
    "listSessions (the reaper's input) must not see the service session");
  await tmux.killServiceSession("orqsvc-test");
  assert.equal(await tmux.hasServiceSession("orqsvc-test"), false);
});

test("newServiceSession rejects non-orqsvc names", async (t) => {
  const tmux = await makeTestTmux(t); if (!tmux) return t.skip("no tmux");
  await assert.rejects(() => tmux.newServiceSession({ name: "orq-evil", cwd: "/tmp", env: {}, bin: "sleep", args: ["1"] }));
  await assert.rejects(() => tmux.newServiceSession({ name: "random", cwd: "/tmp", env: {}, bin: "sleep", args: ["1"] }));
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (methods missing).
- [ ] **Step 3: Implement** — mirror `newSession`'s construction (env via `-e`, cwd, detached) minus the `orq-` prefixing; name validation first; `hasServiceSession` via `tmux has-session -t =<name>`; kill via `kill-session -t =<name>`.
- [ ] **Step 4: Run full daemon tests** (`pnpm test`) — including existing `tmux.test.ts` — + `pnpm check` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): raw-name tmux service-session methods outside the reaped orq- namespace"`

---

### Task 5: Session launch-context — per-launch `model` end to end

**Files:**
- Modify: `apps/daemon/src/sessions.ts` — `ResolveSessionExtraEnv` type (~line 87-92), both call sites (~line 256 tmux / ~line 828 local), `recordOf` (~line 739), reattach path; `SessionSummary` assembly.
- Modify: `apps/daemon/src/index.ts` — `createSessionManager` wiring (~line 313-324) and the `POST /api/sessions` handler (~line 1942-1949): request-field validation.
- Test: `apps/daemon/src/session-model.test.ts` (model on `session-launch-env.test.ts`'s harness — it already fakes registry + resolver)

**Interfaces:**
- Consumes: Task 2's `CreateSessionRequest.model` / `SessionSummary.model` / persisted `model`.
- Produces:
  - `type ResolveSessionExtraEnv = (entry: RegistryEntry, ctx: { accountId?: string; model?: string }) => …` (same return shape as today). **This is a signature change** — update the account wiring in `index.ts` to `(entry, ctx) => agentAccounts.resolveLaunchEnv(entry.id, ctx.accountId)`.
  - `CreateSessionRequest.model` handling in the route: reject with 400 `{ error: "model is only valid for claudex/claudemix", entryId }` when set for any other refId; for the two entries, resolution/validation is delegated to a `validateModel` callback injected into route construction (`(entryId, model|undefined) => Promise<{ ok: true; effectiveModel: string } | { ok: false; error: string }>`) — Task 7's manager provides the real implementation (fresh bounded probe); tests use a stub.
  - The effective model is stored on the session record (`model` field), included in every `SessionSummary`, and survives `recordOf` → persist → reattach.

- [ ] **Step 1: Write the failing test:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Reuse session-launch-env.test.ts's fake registry/resolver harness.

test("resolver receives ctx with model; summary and persisted record carry it", async () => {
  const seen: any[] = [];
  const mgr = await makeManagerWithResolver((entry, ctx) => { seen.push(ctx); return null; });
  const s = await mgr.create({ kind: "agent", refId: "claudex", projectPath: "/p", cwd: "/p", cols: 80, rows: 24, model: "kimi-k3" });
  assert.equal(seen[0].model, "kimi-k3");
  assert.equal(s.model, "kimi-k3");
  const persisted = mgr.recordOfForTest(s.id); // or read the sessions.json the harness points at
  assert.equal(persisted.model, "kimi-k3");
});

test("model omitted → ctx.model undefined (route-level default resolution is upstream)", async () => {
  const seen: any[] = [];
  const mgr = await makeManagerWithResolver((entry, ctx) => { seen.push(ctx); return null; });
  await mgr.create({ kind: "agent", refId: "claudex", projectPath: "/p", cwd: "/p", cols: 80, rows: 24 });
  assert.equal(seen[0].model, undefined);
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (ctx signature / model field missing).
- [ ] **Step 3: Implement** — change the type + both call sites + `recordOf` + summary assembly + reattach restore; in `index.ts`, thread `req.model` through and add the 400 guard + `validateModel` seam (default stub in tests: always ok, `effectiveModel = model ?? "gpt-5.6-sol"`). The route passes `effectiveModel` (not the raw request field) into `create`.
- [ ] **Step 4: Run FULL daemon suite** — the signature change touches `session-launch-env.test.ts` and `agent-accounts` wiring; fix fallout. `pnpm check` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): per-launch model threaded through launch context, persisted on session records"`

---

### Task 6: `cliproxy-secrets.ts` + `cliproxy-files.ts` (stores, projections, wrappers, homes)

**Files:**
- Create: `apps/daemon/src/cliproxy-secrets.ts`, `apps/daemon/src/cliproxy-files.ts`
- Test: `apps/daemon/src/cliproxy-secrets.test.ts`, `apps/daemon/src/cliproxy-files.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas/paths/`MODEL_NAME_RE`.
- Produces (`cliproxy-secrets.ts`):
  - `loadOrInitSecrets(dir: string): Promise<{ state: "loaded" | "created"; secrets: CliProxySecrets } | { state: "corrupt" }>` — missing file → generate (`crypto.randomBytes(24).toString("hex")` ×2, `openRouterKey: null`), write 0600 atomically (tmp+rename, parent-realpath check, refuse symlinked target); corrupt file → `{ state: "corrupt" }` and **touch nothing**.
  - `setOpenRouterKey(dir: string, key: string): Promise<CliProxySecrets>` (rewrite, same hardening).
- Produces (`cliproxy-files.ts`):
  - `renderConfigYaml(secrets: CliProxySecrets, state: CliProxyState): string` — loopback host, port, api-keys `[secrets.apiKey]`, management secret, auth-dir, request logging with bodies disabled, and (only when `openRouterKey`) the `openai-compatibility` block with `kimi-k3` alias.
  - `writeProjections(daemonDir: string, secrets, state): Promise<void>` — writes `config.yaml` (0600), `token` (0600, `apiKey` + newline), both entry env files into `<daemonDir>/env/` (0700 dir, 0600 atomic writes; claudex set per spec §2 incl. `CLAUDE_CONFIG_DIR` + `ANTHROPIC_MODEL=<defaultModel>` + `ANTHROPIC_DEFAULT_HAIKU_MODEL=<backgroundModel>`; claudemix set: base URL, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=<backgroundModel>`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`, `CLAUDE_CODE_NO_FLICKER=1`), and both wrapper bins into `<appdir>/.npm-global/bin/` (0700; POSIX sh; parses the env file line-by-line as data — `while IFS='=' read` loop, no `source`; reads token file; supports `--model <name>` for claudex validated against `MODEL_NAME_RE` in-script via `case` pattern; `exec claude "$@"` last).
  - `seedHome(daemonDir: string, entryId: "claudex" | "claudemix", systemClaudeDir: string): Promise<void>` — creates `claude-home-<entryId>` 0700 with `.orq-cliproxy-home` marker (content = entryId), copies identity-free `.claude.json` (delete `oauthAccount`/`userID`, force `hasCompletedOnboarding: true` — mirror `seedClaudeConfig`), symlinks `skills/` + `plugins/`, seeds `settings.json` once, **never touches `projects/`**; refuses symlinked home; validates marker on re-entry.
  - All model values validated against `MODEL_NAME_RE` before writing; reject otherwise.

- [ ] **Step 1: Write the failing tests** (temp dirs per test; assert file modes via `fs.stat` `& 0o777`):

```ts
test("secrets: creates 0600 with generated values; second load returns identical", …);
test("secrets: corrupt file → {state:'corrupt'}, file untouched (mtime + content unchanged)", …);
test("config.yaml render: no openrouter block without key; block + alias with key; bodies logging off", …);
test("projections: token==apiKey; claudex.env contains ANTHROPIC_MODEL + CLAUDE_CONFIG_DIR; claudemix.env has haiku=backgroundModel and NO ANTHROPIC_MODEL", …);
test("wrapper: generated script has no 'source', reads token file path, claudex handles --model", () => {
  const sh = readFileSync(binPath("claudex"), "utf8");
  assert.ok(!/\bsource\b|^\s*\.\s/m.test(sh));
  assert.ok(sh.includes("cliproxy/token"));
  assert.ok(sh.includes("--model"));
});
test("seedHome: 0700, marker, .claude.json identity stripped, projects/ absent, skills symlinked", …);
test("model charset: writeProjections rejects defaultModel 'x; rm -rf'", …);
```

- [ ] **Step 2: Run to verify failure** → FAIL (modules missing).
- [ ] **Step 3: Implement** both modules exactly per the Produces block. Wrapper template (verbatim starting point):

```sh
#!/bin/sh
# generated by orquester CliProxyManager — do not edit
set -eu
ENV_FILE="__ENV_FILE__"; TOKEN_FILE="__TOKEN_FILE__"
while IFS='=' read -r k v; do
  case "$k" in ''|'#'*) continue;; esac
  case "$k" in *[!A-Za-z0-9_]*) continue;; esac
  export "$k=$v"
done < "$ENV_FILE"
ANTHROPIC_AUTH_TOKEN="$(cat "$TOKEN_FILE")"; export ANTHROPIC_AUTH_TOKEN
if [ "__ENTRY__" = "claudex" ] && [ "${1:-}" = "--model" ]; then
  case "${2:-}" in *[!A-Za-z0-9._/-]*|'') echo "claudex: invalid --model" >&2; exit 2;; esac
  export ANTHROPIC_MODEL="$2" CLAUDE_CODE_SUBAGENT_MODEL="$2"; shift 2
fi
exec claude "$@"
```

- [ ] **Step 4: Run tests + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): cliproxy secret store (fail-closed) and hardened file projections/wrappers/homes"`

---

### Task 7: `CliProxyManager` state machine (adapters injected; no real proxy needed)

**Files:**
- Create: `apps/daemon/src/cliproxy.ts`
- Test: `apps/daemon/src/cliproxy-manager.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 6 outputs.
- Produces:

```ts
export interface CliProxyAdapters {           // injected; tests fake all of them
  probe(port: number, apiKey: string): Promise<{ ok: boolean; models?: string[] }>;
  tmux: Pick<Tmux, "newServiceSession" | "hasServiceSession" | "killServiceSession"> | null;
  spawnDirect(bin: string, args: string[]): { kill(): void } | null; // no-tmux fallback
  liveDependentSessionCount(): number;        // daemon-managed claudex/claudemix sessions
  now(): number;
}
export class CliProxyManager {
  constructor(opts: { daemonDir: string; appdir: string; registry: RegistryService;
                      broadcaster: Broadcaster; adapters: CliProxyAdapters });
  status(): CliProxyStatus;
  init(): Promise<void>;        // load state+secrets (fail-closed), boot adoption sequence
  enable(): Promise<void>;      // async/idempotent; Phase 1: requires an existing binary at
                                // cliproxy/bin/cli-proxy-api (the build pipeline is Phase 2);
                                // missing binary → state "error", reason "binary not installed"
  disable(force: boolean): Promise<{ ok: boolean; affectedSessions?: number }>;
  setConfig(cfg: { defaultModel?: string; backgroundModel?: string }, force: boolean): Promise<{ ok: boolean; affectedSessions?: number }>;
  validateModel(entryId: string, model?: string): Promise<{ ok: true; effectiveModel: string } | { ok: false; error: string }>;
  handleSessionSetChanged(): void;  // persistence-lost respawn window re-evaluation
}
```

  Behavior under test (all from spec §1): boot adoption order (owned tmux → probe; port-answers → **probe before classifying** foreign vs persistence-lost; nothing → spawn); corrupt secrets → `error`, no writes; runtime crash supervision (probe fails on owned session → respawn ≤3 with backoff → `error` latch); `disable(false)` with live sessions → refused with count; `setConfig` restart-needing change refused without force; `validateModel` uses a fresh `probe()` bounded by `Promise.race` 2 s, scoped: only fails when the *effective* model is absent, resolves `effectiveModel = model ?? state.defaultModel`; registry coupling: healthy+creds → `setRuntimeState(id, {enabled:true})`, proxy down → `{enabled:false, disabledReason:"proxy down"}`; every state change broadcasts `cliproxy.changed` and persists `cliproxy.json`.

- [ ] **Step 1: Write the failing tests** (fake adapters; fake registry recording `setRuntimeState` calls):

```ts
test("boot: port answers + our key accepted → persistence-lost (not foreign)", …);
test("boot: port answers + key rejected → error 'port conflict', no kill/adopt", …);
test("corrupt secrets.json → state error, secrets file untouched, no config rewrite", …);
test("crash supervision: 3 failed respawns → error latch + single notification event", …);
test("disable without force + 2 live sessions → {ok:false, affectedSessions:2}; with force → kills service session", …);
test("validateModel: request model wins over default; unknown model fails naming provider; probe hang → bounded failure ≤2s (fake timer)", …);
test("healthy → registry claudex/claudemix enabled; probe loss → disabled with 'proxy down'", …);
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** `cliproxy.ts` — a serialized state machine (single in-flight transition promise), `status()` assembling `CliProxyStatus` from state + reasons + detail; wire `validateModel` so Task 5's route seam gets the real implementation.
- [ ] **Step 4: Run tests + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): CliProxyManager state machine with ownership-verified adoption and crash supervision"`

---

### Task 8: Canonical agent-family mapping in hooks

**Files:**
- Modify: `apps/daemon/src/agent-hooks.ts` — `configTarget()` (~line 185-196) and `install()` dispatch (~line 198-207)
- Test: `apps/daemon/src/agent-family.test.ts` (reuse `agent-hooks.test.ts` fixtures)

**Interfaces:**
- Produces: `export function agentFamily(entryId: string): "claude" | "codex" | "opencode" | null` — `claude|claudex|claudemix → "claude"`, `codex → "codex"`, `opencode → "opencode"`, else `null`. Both `configTarget()` and `install()` switch on `agentFamily(entryId)`, never on raw id.

- [ ] **Step 1: Write the failing test:**

```ts
test("claudex/claudemix map to claude family for BOTH target and installer dispatch", async () => {
  assert.equal(agentFamily("claudex"), "claude");
  assert.equal(agentFamily("claudemix"), "claude");
  // install-path check via the agent-hooks.test.ts harness:
  const { hooks, home } = await makeHooksHarness();
  await hooks.ensureForEntry("claudex", { CLAUDE_CONFIG_DIR: home });
  assert.ok(existsSync(join(home, "settings.json")), "claude-style installer ran (NOT installOpenCode)");
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (claudex falls to `installOpenCode`, no settings.json in home).
- [ ] **Step 3: Implement** `agentFamily` + both dispatch sites.
- [ ] **Step 4: Run full daemon tests** (existing `agent-hooks.test.ts` must stay green) + `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): canonical agent-family mapping for hook target and installer dispatch"`

---

### Task 9: `/api/cliproxy` routes + daemon wiring

**Files:**
- Modify: `apps/daemon/src/index.ts` — construct `CliProxyManager` in `startDaemon()` (after registry/sessions, alongside `BrowserManager` ~line 516); register routes; hand `manager.validateModel` to the sessions route seam (Task 5); hand `agentAccounts` composition: `resolveExtraEnv: async (entry, ctx) => composeExtraEnv(await agentAccounts.resolveLaunchEnv(entry.id, ctx.accountId), cliproxyContributor(entry, ctx))` where `cliproxyContributor` returns `{ env: { ANTHROPIC_AUTH_TOKEN, CLAUDE_CONFIG_DIR, ANTHROPIC_MODEL?, CLAUDE_CODE_SUBAGENT_MODEL? } }` for the two entry ids (model overrides only when `ctx.model` set) and `null` otherwise.
- Test: extend `apps/daemon/src/cliproxy-manager.test.ts` with route-level tests via Fastify `inject` (follow the pattern of existing route tests if present; otherwise unit-test the handler functions directly).

**Interfaces:**
- Consumes: Tasks 5 + 7.
- Produces routes (spec §3; login flows and openrouter/key are **Phase 2** — register them returning `501 { error: "pending spike findings" }` so the surface is reserved):
  - `GET /api/cliproxy` → `manager.status()` (both transports).
  - `POST /api/cliproxy/enable` / `POST /api/cliproxy/disable` (body `{ force?: boolean }`) / `PUT /api/cliproxy/config` — **HTTP-transport-only**: the socket-served instance registers these paths with a handler that replies `403 { error: "cliproxy mutations require the authenticated HTTP transport" }`. Implementation: the Fastify factory already knows its mode (`"local" | "remote"` — same mechanism as the existing `PUT /api/config/daemon` 403); reuse it inverted.
  - `GET /api/cliproxy/models` → last-known catalog + `asOf`, refreshed opportunistically from a probe.
  - `composeExtraEnv(a, b)` merges env objects (b wins), concatenates `unset`, preserves `accountId` from `a`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("mutations 403 on local mode, work on remote mode with auth", …);   // inject() against both factory modes
test("GET /api/cliproxy returns CliProxyStatus shape incl. reasons[]", …);
test("composeExtraEnv: cliproxy env wins on collision, accountId preserved, unsets concatenated", …);
test("POST /api/sessions with model on refId 'claude' → 400; on 'claudex' passes through validateModel", …);
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** routes + composition + construction in `startDaemon()`; `manager.init()` runs in boot order **after** `sessions.reattach()` (adoption must see the final session set) and before HTTP starts serving.
- [ ] **Step 4: Run the FULL daemon suite + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): /api/cliproxy routes with socket-refused mutations, composed launch-env contributor, boot wiring"`

---

### Task 10: Phase-1 close-out review

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-claudex-addon-design.md` (only if discrepancies found)

- [ ] **Step 1:** Run the complete verification battery: `pnpm check` at root; `cd apps/daemon && pnpm test` (full suite, zero failures).
- [ ] **Step 2:** Diff-audit against spec §Verification's test list: every Phase-1-scoped item (reaper exclusion, env redaction+reload, runtime enable/disable + race, corrupt-secrets fail-closed, socket-refused mutations, effectiveModel on omitted request, hook-family dispatch, wrapper-env parsing assertions, model persistence across restart/reattach) has a named passing test. List any gap and close it before proceeding.
- [ ] **Step 3:** Request code review per the superpowers flow (`superpowers:requesting-code-review`), fix findings.
- [ ] **Step 4: Commit** any fixes — `git commit -am "chore(daemon): phase-1 close-out fixes from review"`.
- [ ] **Step 5:** Write the Phase 2 plan from the Task 0 findings file (build pipeline constants from measured build time/disk; login-flow shape from the device-auth verdicts; Kimi patch content from the recorded translator model-string; claudemix env final set from the model-channel verdicts).

---

## Self-Review (performed at write time)

- **Spec coverage:** Phase-1 scope maps: §1 manager/state/adoption/supervision → Tasks 6-7; §2 entries/env/homes/wrappers/registry-APIs/model-plumbing → Tasks 2-6; §3 routes/transport-authz/schemas → Tasks 1, 9; §6 hooks → Task 8; §8 spike → Task 0. Deliberately deferred to Phase 2 (listed in File Structure): build pipeline, login flows, OpenRouter key route, UI, usage scanner/watcher extension, Kimi patch, notifications polish, deploy. No silent gaps.
- **Placeholder scan:** the only intentionally-stubbed surface is the Phase-2 route set returning 501 — explicit, not a TBD.
- **Type consistency:** `CliProxyStatus` (Task 2) is what `manager.status()` (Task 7) returns and `GET /api/cliproxy` (Task 9) serves; `validateModel` signature identical in Tasks 5, 7, 9; `ResolveSessionExtraEnv` ctx shape identical in Tasks 5 and 9; `MODEL_NAME_RE` single-sourced from Task 1.
