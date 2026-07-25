# Auto-Compact Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claudex/claudemix sessions get proactive auto-compaction with correct per-model context windows — same UX as native Claude Code — per `docs/superpowers/specs/2026-07-25-compact-parity-design.md`.

**Architecture:** Three independent mechanisms: (1) a managed-key merge forces `autoCompactEnabled: true` into the proxy homes' `settings.json` on every seed pass; (2) `cliproxyContributor` emits per-launch compact env (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) resolved from curated per-model metadata + user overrides persisted in cliproxy state; (3) a documented CLIProxyAPI patch (upstream PR route) normalizes provider overflow errors so reactive recovery works as backstop.

**Tech Stack:** TypeScript/ESM, zod (packages/config only), node:test via tsx. No new dependencies.

## Global Constraints

- ⛔ Never launch/restart/stop the daemon or bind port 47831 — this checkout is served by a live daemon. Verify with `pnpm check` + `cd apps/daemon && pnpm test`.
- Commit to the current branch (`main`) as-is; never create branches.
- Persisted-shape rule: every new persisted field must be zod-defaulted so old state files parse (`parseCliProxyState` falls back wholesale on schema miss).
- Numbers from the spec (do not re-derive): gpt-5.6-sol/terra/luna → contextWindow 200000, compactPct 75; kimi-k3 → contextWindow 1048576, compactWindow 450000, no pct; any bare id starting with `claude` → `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1048576` only (arming value; Claude Code clamps it to the model's believed window).
- Model ids in env values must already satisfy `MODEL_NAME_RE`; compact resolution always strips the `acc<hex>/` routing prefix first.

---

### Task 1: Curated model metadata, overrides schema, compact-env resolver (`@orquester/config`)

**Files:**
- Modify: `packages/config/src/index.ts` (around `CURATED_PROXY_MODELS` at ~line 686 and `cliProxyStateSchema` at ~line 670)
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx` (~line 44, `DEFAULT_PROXY_MODELS`)
- Modify: `packages/ui/src/components/settings/ModelProxySettings.tsx` (~line 60, `curatedOptions` memo)
- Test: `apps/daemon/src/cliproxy-config.test.ts`

**Interfaces:**
- Consumes: existing `isOpenRouterModel` prefix-strip idiom, `cliProxyStateSchema`.
- Produces (later tasks depend on these exact names):
  - `interface CuratedProxyModel { id: string; contextWindow: number; compactWindow?: number; compactPct?: number }`
  - `const CURATED_PROXY_MODELS: readonly CuratedProxyModel[]`
  - `const CURATED_PROXY_MODEL_IDS: readonly string[]`
  - `const CLAUDE_ARMING_COMPACT_WINDOW = 1_048_576`
  - `type CliProxyModelOverrides = Record<string, { contextWindow?: number; compactWindow?: number; compactPct?: number }>`
  - `const cliProxyModelOverridesSchema` (zod, exported for route validation)
  - `interface CompactEnv { maxContextTokens?: number; autoCompactWindow: number; autoCompactPct?: number }`
  - `function compactEnvForModel(model: string, overrides?: CliProxyModelOverrides): CompactEnv | null`
  - `cliProxyStateSchema` gains `modelOverrides: cliProxyModelOverridesSchema.default({})`

- [ ] **Step 1: Write the failing tests** (append to `apps/daemon/src/cliproxy-config.test.ts`; follow the file's existing import style)

```ts
import {
  CLAUDE_ARMING_COMPACT_WINDOW,
  CURATED_PROXY_MODEL_IDS,
  compactEnvForModel,
  createDefaultCliProxyState,
  parseCliProxyState
} from "@orquester/config";

test("compactEnvForModel: curated gpt model resolves window + pct", () => {
  assert.deepEqual(compactEnvForModel("gpt-5.6-sol"), {
    maxContextTokens: 200000,
    autoCompactWindow: 200000,
    autoCompactPct: 75
  });
});

test("compactEnvForModel: kimi resolves 1M window with 450k compact window, no pct", () => {
  assert.deepEqual(compactEnvForModel("kimi-k3"), {
    maxContextTokens: 1048576,
    autoCompactWindow: 450000
  });
});

test("compactEnvForModel: acc-prefixed model resolves like its bare id", () => {
  assert.deepEqual(compactEnvForModel("acc65eebd90/gpt-5.6-terra"), {
    maxContextTokens: 200000,
    autoCompactWindow: 200000,
    autoCompactPct: 75
  });
});

test("compactEnvForModel: claude ids (bare or prefixed) get the arming value only", () => {
  assert.deepEqual(compactEnvForModel("claude-fable-5"), {
    autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW
  });
  assert.deepEqual(compactEnvForModel("acc14137047/claude-opus-5"), {
    autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW
  });
});

test("compactEnvForModel: overrides beat curated defaults, per field", () => {
  assert.deepEqual(
    compactEnvForModel("gpt-5.6-sol", { "gpt-5.6-sol": { compactWindow: 180000, compactPct: 60 } }),
    { maxContextTokens: 200000, autoCompactWindow: 180000, autoCompactPct: 60 }
  );
});

test("compactEnvForModel: uncurated non-claude id with no override emits nothing", () => {
  assert.equal(compactEnvForModel("glm-5-air"), null);
});

test("compactEnvForModel: an override alone makes an uncurated id resolvable", () => {
  assert.deepEqual(compactEnvForModel("glm-5-air", { "glm-5-air": { contextWindow: 128000 } }), {
    maxContextTokens: 128000,
    autoCompactWindow: 128000
  });
});

test("cliProxyState: modelOverrides roundtrip and absent-field default", () => {
  assert.deepEqual(createDefaultCliProxyState().modelOverrides, {});
  const parsed = parseCliProxyState({
    ...createDefaultCliProxyState(),
    modelOverrides: { "kimi-k3": { compactWindow: 500000 } }
  });
  assert.deepEqual(parsed.modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
});

test("CURATED_PROXY_MODEL_IDS keeps the picker order sol, terra, luna, kimi", () => {
  assert.deepEqual(CURATED_PROXY_MODEL_IDS, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "kimi-k3"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/daemon && node --import tsx --test src/cliproxy-config.test.ts`
Expected: FAIL — `compactEnvForModel` / `CURATED_PROXY_MODEL_IDS` not exported.

- [ ] **Step 3: Implement in `packages/config/src/index.ts`**

Replace the existing `CURATED_PROXY_MODELS` string-tuple export with:

```ts
export interface CuratedProxyModel {
  id: string;
  /** Real backend context ceiling → CLAUDE_CODE_MAX_CONTEXT_TOKENS. */
  contextWindow: number;
  /** Proactive compaction window → CLAUDE_CODE_AUTO_COMPACT_WINDOW (default: contextWindow). */
  compactWindow?: number;
  /** Trigger percentage → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (default: Claude Code's native formula). */
  compactPct?: number;
}

/**
 * The launcher-facing model picks (chips + settings dropdowns) WITH the
 * measured compact metadata (spec 2026-07-25-compact-parity-design.md §3.2).
 * Windows are measured backend ceilings, not marketing numbers.
 */
export const CURATED_PROXY_MODELS: readonly CuratedProxyModel[] = [
  { id: "gpt-5.6-sol", contextWindow: 200_000, compactPct: 75 },
  { id: "gpt-5.6-terra", contextWindow: 200_000, compactPct: 75 },
  { id: "gpt-5.6-luna", contextWindow: 200_000, compactPct: 75 },
  { id: "kimi-k3", contextWindow: 1_048_576, compactWindow: 450_000 }
];

export const CURATED_PROXY_MODEL_IDS: readonly string[] = CURATED_PROXY_MODELS.map((m) => m.id);

/**
 * Arming value for Claude-family ids: proactive auto-compaction is gated OFF on
 * non-first-party base URLs (claude-code #65585) unless AUTO_COMPACT_WINDOW is
 * set; Claude Code clamps the value to the model's believed window, so this
 * never shrinks anything — its only job is to defeat the gate.
 */
export const CLAUDE_ARMING_COMPACT_WINDOW = 1_048_576;

export const cliProxyModelOverridesSchema = z.record(
  z.object({
    contextWindow: z.number().int().positive().optional(),
    compactWindow: z.number().int().positive().optional(),
    compactPct: z.number().int().min(1).max(100).optional()
  })
);
export type CliProxyModelOverrides = z.infer<typeof cliProxyModelOverridesSchema>;

export interface CompactEnv {
  maxContextTokens?: number;
  autoCompactWindow: number;
  autoCompactPct?: number;
}

/**
 * Resolve the compact env for a launch model (spec §3.2): strip the acc<hex>/
 * routing prefix; `claude*` ids get the arming value only (native window
 * detection + native trigger formula do the rest); other ids resolve
 * override → curated → null (uncurated stays reactive-only, same as today).
 */
export function compactEnvForModel(
  model: string,
  overrides?: CliProxyModelOverrides
): CompactEnv | null {
  const bare = model.replace(/^acc[0-9a-fA-F]+\//, "");
  if (bare.startsWith("claude")) {
    return { autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW };
  }
  const curated = CURATED_PROXY_MODELS.find((m) => m.id === bare);
  const override = overrides?.[bare];
  const contextWindow = override?.contextWindow ?? curated?.contextWindow;
  if (contextWindow === undefined) return null;
  const env: CompactEnv = {
    maxContextTokens: contextWindow,
    autoCompactWindow: override?.compactWindow ?? curated?.compactWindow ?? contextWindow
  };
  const pct = override?.compactPct ?? curated?.compactPct;
  if (pct !== undefined) env.autoCompactPct = pct;
  return env;
}
```

In `cliProxyStateSchema`, after the `openRouterKeyVerifiedAt` field, add:

```ts
  /** Per-model compact-window overrides (spec §3.2); additive + defaulted. */
  modelOverrides: cliProxyModelOverridesSchema.default({}),
```

(Declaration order note: `cliProxyModelOverridesSchema` must be defined before `cliProxyStateSchema` in the file.)

- [ ] **Step 4: Fix the two UI call sites (type change fallout)**

`packages/ui/src/components/topbar/NewTabMenu.tsx` — the import and `DEFAULT_PROXY_MODELS`:

```ts
import { CURATED_PROXY_MODEL_IDS, isOpenRouterModel } from "@orquester/config";
// …
const DEFAULT_PROXY_MODELS: string[] = [...CURATED_PROXY_MODEL_IDS];
```

`packages/ui/src/components/settings/ModelProxySettings.tsx` — the `curatedOptions` memo (swap the constant, logic unchanged):

```ts
import { CURATED_PROXY_MODEL_IDS } from "@orquester/config";
// …
  const curatedOptions = useMemo(() => {
    const catalog = models?.models ?? [];
    const confirmed = catalog.length
      ? CURATED_PROXY_MODEL_IDS.filter((m) => catalog.includes(m))
      : [...CURATED_PROXY_MODEL_IDS];
    return confirmed.length ? confirmed : [...CURATED_PROXY_MODEL_IDS];
  }, [models]);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/daemon && node --import tsx --test src/cliproxy-config.test.ts` → all PASS.
Run: `pnpm check` (repo root) → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/index.ts packages/ui/src/components/topbar/NewTabMenu.tsx packages/ui/src/components/settings/ModelProxySettings.tsx apps/daemon/src/cliproxy-config.test.ts
git commit -m "feat(config): curated proxy-model compact metadata, overrides schema, compactEnvForModel"
```

---

### Task 2: Managed-key settings merge in `seedHome`

**Files:**
- Modify: `apps/daemon/src/cliproxy-files.ts` (`seedHome` tail, ~line 329; new helper next to `copyIfMissing` at ~line 264)
- Test: `apps/daemon/src/cliproxy-files.test.ts`

**Interfaces:**
- Produces: `seedHome` now also force-merges `MANAGED_HOME_SETTINGS = { autoCompactEnabled: true }` into `<home>/settings.json` after the one-time copy. No signature change — callers (`cliproxy.ts seedHomes`) are untouched.

- [ ] **Step 1: Write the failing tests** (append to `cliproxy-files.test.ts`)

```ts
test("seedHome: forces autoCompactEnabled:true into an existing settings.json, preserving other keys", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysac-"));
  await writeFile(join(sysDir, "settings.json"), JSON.stringify({ autoCompactEnabled: false, theme: "dark" }));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const settings = JSON.parse(
    await readFile(join(cliproxyHomeDir(dir, "claudex"), "settings.json"), "utf8")
  );
  assert.equal(settings.autoCompactEnabled, true, "managed key forced");
  assert.equal(settings.theme, "dark", "other keys preserved");
});

test("seedHome: creates settings.json with managed keys when the system has none", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysnone-"));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const settings = JSON.parse(
    await readFile(join(cliproxyHomeDir(dir, "claudex"), "settings.json"), "utf8")
  );
  assert.equal(settings.autoCompactEnabled, true);
});

test("seedHome: settings merge is idempotent and survives a malformed file", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysbad-"));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const file = join(cliproxyHomeDir(dir, "claudex"), "settings.json");
  await writeFile(file, "{not json");
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json")); // must not throw
  const settings = JSON.parse(await readFile(file, "utf8"));
  assert.equal(settings.autoCompactEnabled, true, "malformed file replaced with managed keys");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/daemon && node --import tsx --test src/cliproxy-files.test.ts`
Expected: the three new tests FAIL (`autoCompactEnabled` is `false`/absent — today only the one-time copy runs).

- [ ] **Step 3: Implement** — in `cliproxy-files.ts`, next to `copyIfMissing`:

```ts
/** Settings keys the daemon owns in every managed proxy home. Force-merged on
 *  every seed pass (enable + boot) so a stale one-time copy can't freeze them
 *  (spec 2026-07-25-compact-parity-design.md §3.1); all other keys — user
 *  edits, theme, hooks — are preserved. */
const MANAGED_HOME_SETTINGS: Record<string, unknown> = { autoCompactEnabled: true };

async function mergeManagedSettings(home: string): Promise<void> {
  const file = join(home, "settings.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // absent or malformed — managed keys alone become the file
  }
  const next = { ...existing, ...MANAGED_HOME_SETTINGS };
  if (JSON.stringify(next) === JSON.stringify(existing)) return; // no write churn
  await writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
}
```

In `seedHome`, immediately after the existing `copyIfMissing(join(systemClaudeDir, "settings.json"), join(home, "settings.json"));` line, add:

```ts
  await mergeManagedSettings(home);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/daemon && node --import tsx --test src/cliproxy-files.test.ts` → all PASS (including the pre-existing seedHome tests — the merge must not break the 0700/marker/symlink assertions).
Run: `pnpm check` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/cliproxy-files.ts apps/daemon/src/cliproxy-files.test.ts
git commit -m "feat(daemon): force-merge managed settings (autoCompactEnabled) into proxy homes on every seed"
```

---

### Task 3: Per-launch compact env in `cliproxyContributor`

**Files:**
- Modify: `apps/daemon/src/index.ts` (`cliproxyContributor` at ~line 801 and `needsAccountPrefix` just above it)
- Test: `apps/daemon/src/session-launch-env.test.ts`

**Interfaces:**
- Consumes: `compactEnvForModel`, `CLAUDE_ARMING_COMPACT_WINDOW` from `@orquester/config` (Task 1); the existing `daemonDirWithSeeded` test helper in `session-launch-env.test.ts`.
- Produces: `cliproxyContributor` env now may include `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (all string-typed). New module-scope helper `readCliProxyState(daemonDir): CliProxyState | null`.

- [ ] **Step 1: Write the failing tests** (append to `session-launch-env.test.ts`; `DIR` and `ACCOUNT` constants and `daemonDirWithSeeded` already exist there)

```ts
test("cliproxyContributor: gpt launch emits window + compact window + pct", () => {
  const res = cliproxyContributor("claudex", { accountId: "system", model: "gpt-5.6-sol" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "75");
});

test("cliproxyContributor: kimi launch emits 1M window, 450k compact window, no pct", () => {
  const res = cliproxyContributor("claudex", { model: "kimi-k3" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "450000");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});

test("cliproxyContributor: claudemix claude launch gets the arming window only", () => {
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-fable-5" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "never for claude ids");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});

test("cliproxyContributor: claudemix modelless launch still gets the arming window", () => {
  const res = cliproxyContributor("claudemix", {}, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
});

test("cliproxyContributor: claudex modelless launch resolves the configured defaultModel", async () => {
  const dir = await daemonDirWithSeeded([]); // writes a parseable state.json (defaultModel: gpt-5.6-sol)
  const res = cliproxyContributor("claudex", {}, dir);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
});

test("cliproxyContributor: state modelOverrides beat curated defaults at launch", async () => {
  const dir = await daemonDirWithSeeded([]);
  const stateFile = cliproxyStateFile(dir);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.modelOverrides = { "kimi-k3": { compactWindow: 500000 } };
  await writeFile(stateFile, JSON.stringify(state));
  const res = cliproxyContributor("claudex", { model: "kimi-k3" }, dir);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "500000");
});
```

Note: `daemonDirWithSeeded([])` writes a state file containing only `seededAccounts`; `parseCliProxyState` fills `defaultModel: "gpt-5.6-sol"` by schema default, which is exactly what the modelless-claudex test needs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/daemon && node --import tsx --test src/session-launch-env.test.ts`
Expected: new tests FAIL (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` undefined).

- [ ] **Step 3: Implement in `apps/daemon/src/index.ts`**

Add a module-scope helper above `needsAccountPrefix` and refactor the state read into it:

```ts
/** Best-effort read of the persisted cliproxy state (contributor-side: launch
 *  env must never throw). Null when absent/unreadable. */
function readCliProxyState(daemonDir: string): CliProxyState | null {
  try {
    return parseCliProxyState(JSON.parse(readFileSync(cliproxyStateFile(daemonDir), "utf8")));
  } catch {
    return null;
  }
}
```

Change `needsAccountPrefix` to accept the already-read state (keeping its unreadable-state = prefix semantics):

```ts
function needsAccountPrefix(state: CliProxyState | null, accountId: string): boolean {
  if (!state) return true;
  const mine = state.seededAccounts.find((a) => a.accountId === accountId);
  if (!mine) return true;
  return state.seededAccounts.some((a) => a.provider === mine.provider && a.accountId !== accountId);
}
```

In `cliproxyContributor`, read the state once at the top of the function body (after the `entryId` guard), pass it to `needsAccountPrefix`, and append the compact-env emission after the existing model/account block:

```ts
  const state = readCliProxyState(daemonDir);
  // … existing ctx.model block, with:
  //   const prefixed = routesToAccount && needsAccountPrefix(state, ctx.accountId as string);

  // Per-launch compact env (spec 2026-07-25-compact-parity-design.md §3.2):
  // proactive auto-compaction is gated off behind a third-party base URL
  // (claude-code #65585), so AUTO_COMPACT_WINDOW is mandatory arming for every
  // launcher. Resolution is per-model; a modelless claudemix launch is the
  // Claude main loop, a modelless claudex launch runs the configured default.
  const compactModel = ctx.model ?? (entryId === "claudemix" ? "claude" : state?.defaultModel);
  if (compactModel) {
    const compact = compactEnvForModel(compactModel, state?.modelOverrides);
    if (compact) {
      if (compact.maxContextTokens !== undefined) {
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(compact.maxContextTokens);
      }
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(compact.autoCompactWindow);
      if (compact.autoCompactPct !== undefined) {
        env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(compact.autoCompactPct);
      }
    }
  }
```

Imports to extend at the top of `index.ts`: `compactEnvForModel` and type `CliProxyState` from `@orquester/config` (`cliproxyStateFile`, `parseCliProxyState`, `readFileSync` are already imported).

- [ ] **Step 4: Run the full daemon suite + typecheck**

Run: `cd apps/daemon && pnpm test` → all PASS (the pre-existing contributor tests assert specific `env.ANTHROPIC_MODEL` values and must be unaffected; the two `needsAccountPrefix`-based tests from the bare-model work must still pass with the refactored signature).
Run: `pnpm check` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/index.ts apps/daemon/src/session-launch-env.test.ts
git commit -m "feat(daemon): per-launch compact env (window/threshold arming) from cliproxyContributor"
```

---

### Task 4: `setConfig` accepts `modelOverrides` (manager + route + wire types)

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts` (`setConfig` at ~line 311; `status()`)
- Modify: `apps/daemon/src/index.ts` (`CliProxyRouteManager.setConfig` signature at ~line 855; `PUT /api/cliproxy/config` route handler)
- Modify: `packages/api/src/index.ts` (`CliProxyStatus` gains `modelOverrides`)
- Modify: `packages/ui/src/lib/api-client.ts` (`setCliProxyConfig` cfg type, ~line 610)
- Test: `apps/daemon/src/cliproxy-manager.test.ts`

**Interfaces:**
- Consumes: `cliProxyModelOverridesSchema`, `CliProxyModelOverrides` from Task 1.
- Produces: `setConfig(cfg: { defaultModel?; backgroundModel?; claudeDefaultModel?; modelOverrides?: CliProxyModelOverrides }, force)` — `modelOverrides` **replaces** the stored record wholesale, never triggers a restart, and is returned on `CliProxyStatus.modelOverrides`.

- [ ] **Step 1: Write the failing test** (append to `cliproxy-manager.test.ts`)

```ts
test("setConfig: modelOverrides persist without a restart and surface on status", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  const spawnsBefore = h.tmuxCalls.newService;
  h.setLive(2); // live sessions must NOT gate an overrides-only change
  const res = await h.mgr.setConfig({ modelOverrides: { "kimi-k3": { compactWindow: 500000 } } }, false);
  assert.equal(res.ok, true);
  assert.equal(h.tmuxCalls.newService, spawnsBefore, "no proxy restart for overrides");
  assert.deepEqual(h.mgr.status().modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.deepEqual(persisted.modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/cliproxy-manager.test.ts`
Expected: FAIL — `modelOverrides` unknown on cfg / status.

- [ ] **Step 3: Implement**

`apps/daemon/src/cliproxy.ts` — `setConfig` signature and body (the `needsRestart` computation is untouched: it keys only on default/background changes):

```ts
  setConfig(
    cfg: {
      defaultModel?: string;
      backgroundModel?: string;
      claudeDefaultModel?: string;
      modelOverrides?: CliProxyModelOverrides;
    },
    force: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
```

Inside, next to the other field assignments (before the projections block):

```ts
      // Overrides feed the launch-time contributor only (no projection, no
      // restart) — replace wholesale so the UI's record is the whole truth.
      if (cfg.modelOverrides !== undefined) this.state.modelOverrides = cfg.modelOverrides;
```

Also add `modelOverrides: this.state.modelOverrides` to the object returned by `status()`, and `CliProxyModelOverrides` to the `@orquester/config` import list.

`packages/api/src/index.ts` — in `CliProxyStatus`, after `backgroundModel`:

```ts
  /** Per-model compact-window overrides (empty record when none set). */
  modelOverrides: Record<string, { contextWindow?: number; compactWindow?: number; compactPct?: number }>;
```

`apps/daemon/src/index.ts` — `CliProxyRouteManager.setConfig` cfg type gains the same optional `modelOverrides` field; the `PUT /api/cliproxy/config` handler validates it before delegating:

```ts
    if (body.modelOverrides !== undefined) {
      const parsed = cliProxyModelOverridesSchema.safeParse(body.modelOverrides);
      if (!parsed.success) return reply.code(400).send({ error: "invalid modelOverrides" });
      cfg.modelOverrides = parsed.data;
    }
```

(Follow the handler's existing pattern for assembling `cfg` from `body`; import `cliProxyModelOverridesSchema` from `@orquester/config`.)

`packages/ui/src/lib/api-client.ts` — widen the cfg parameter:

```ts
  setCliProxyConfig(
    cfg: {
      defaultModel?: string;
      backgroundModel?: string;
      modelOverrides?: Record<string, { contextWindow?: number; compactWindow?: number; compactPct?: number }>;
    },
    force?: boolean
  ): Promise<CliProxyStatus | CliProxyMutationRefusal> {
```

Route-test fake fallout: `cliproxy-manager.test.ts`'s route-section fake manager builds `status` objects — add `modelOverrides: {}` wherever the fake constructs a `CliProxyStatus` (typecheck will point at every site).

- [ ] **Step 4: Run the full daemon suite + typecheck**

Run: `cd apps/daemon && pnpm test` → all PASS.
Run: `pnpm check` → clean (this catches every fake-status construction missing the new field).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/cliproxy.ts apps/daemon/src/index.ts packages/api/src/index.ts packages/ui/src/lib/api-client.ts apps/daemon/src/cliproxy-manager.test.ts
git commit -m "feat(daemon,api,ui): modelOverrides on cliproxy setConfig/status, restart-free"
```

---

### Task 5: "Context windows" section in Model Proxy settings

**Files:**
- Modify: `packages/ui/src/components/settings/ModelProxySettings.tsx` (new section under "Model defaults")

**Interfaces:**
- Consumes: `CURATED_PROXY_MODELS` (records, Task 1), `status.modelOverrides` + `setCliProxyConfig({ modelOverrides })` (Task 4), the component's existing `run(...)` error-handling helper and `busy` flag.
- Produces: UI only — no exports.

- [ ] **Step 1: Implement the section** (no unit-test runner covers the UI; verification is manual + typecheck)

Below the "Model defaults" section, add:

```tsx
      {/* Context windows — per-model compact tuning (spec §3.2). Values are the
          launch-time env knobs; blank = curated default. */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-200">Context windows</h3>
        <p className="text-xs text-neutral-500">
          Per-model context ceiling and auto-compact window for proxy launches. Blank fields use
          the built-in defaults; changes apply to new tabs (no proxy restart).
        </p>
        {CURATED_PROXY_MODELS.map((m) => {
          const o = status.modelOverrides[m.id] ?? {};
          return (
            <div key={m.id} className="flex items-center gap-2 text-sm">
              <span className="w-32 truncate text-neutral-300">{m.id}</span>
              <NumberField
                label="window"
                placeholder={String(m.contextWindow)}
                value={o.contextWindow}
                disabled={busy}
                onCommit={(v) => saveOverride(m.id, { contextWindow: v })}
              />
              <NumberField
                label="compact at"
                placeholder={String(m.compactWindow ?? m.contextWindow)}
                value={o.compactWindow}
                disabled={busy}
                onCommit={(v) => saveOverride(m.id, { compactWindow: v })}
              />
              <NumberField
                label="pct"
                placeholder={m.compactPct !== undefined ? String(m.compactPct) : "default"}
                value={o.compactPct}
                disabled={busy}
                onCommit={(v) => saveOverride(m.id, { compactPct: v })}
              />
            </div>
          );
        })}
      </section>
```

With, in the component body (`saveOverride` builds the full next record so the wholesale-replace contract from Task 4 holds):

```tsx
  const saveOverride = (
    id: string,
    patch: { contextWindow?: number; compactWindow?: number; compactPct?: number }
  ) => {
    const current = status.modelOverrides ?? {};
    const merged = { ...(current[id] ?? {}), ...patch };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    const next = { ...current };
    if (Object.keys(cleaned).length === 0) delete next[id];
    else next[id] = cleaned;
    run(() => setCliProxyConfig({ modelOverrides: next }));
  };
```

And a small `NumberField` component at file scope (matching the file's existing `ModelSelect` styling conventions — `Input` from `../ui`, label as muted text, commit on blur/Enter, empty string commits `undefined` to clear the override):

```tsx
const NumberField: React.FC<{
  label: string;
  placeholder: string;
  value: number | undefined;
  disabled: boolean;
  onCommit: (v: number | undefined) => void;
}> = ({ label, placeholder, value, disabled, onCommit }) => {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    if (text.trim() === "") return onCommit(undefined);
    const n = Number(text);
    if (Number.isInteger(n) && n > 0) onCommit(n);
    else setText(value === undefined ? "" : String(value)); // revert invalid input
  };
  return (
    <label className="flex items-center gap-1 text-xs text-neutral-500">
      {label}
      <Input
        className="w-24"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
};
```

Import additions in the file: `CURATED_PROXY_MODELS` (already importing `CURATED_PROXY_MODEL_IDS` from Task 1's change — extend the same import).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm check` → clean. Run: `pnpm --filter @orquester/web build` → succeeds (this is UI code — flag in the task report that behavior was NOT browser-verified; the post-deploy smoke + manual checklist in Task 7 covers it).

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/settings/ModelProxySettings.tsx
git commit -m "feat(ui): per-model context-window overrides in Model Proxy settings"
```

---

### Task 6: Docs correction + overflow-normalization patch document

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-claudex-addon-design.md:107`
- Create: `deploy/cliproxy-patches/overflow-error-normalize.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Correct the stale compaction claim**

In `2026-07-22-claudex-addon-design.md` line 107, change:

```
haiku-slot/background calls (title generation, compaction) as high-effort Sol. Effort is
```

to:

```
haiku-slot/background calls (title generation) as high-effort Sol. (Compaction runs on the
MAIN conversation model, not the haiku slot — see 2026-07-25-compact-parity-design.md §1.)
Effort is
```

- [ ] **Step 2: Write the patch document** — `deploy/cliproxy-patches/overflow-error-normalize.md`:

```markdown
# CLIProxyAPI patch: normalize provider context-overflow errors

**Status:** authored, delivery via upstream PR (see below). Companion to the
compact-parity design (docs/superpowers/specs/2026-07-25-compact-parity-design.md §3.4).

## Why

Claude Code's reactive compact-and-retry only recognizes context overflow when the
error message contains (case-insensitive) "prompt is too long" or "input is too long
for requested model". Upstreams behind CLIProxyAPI say other things:

| upstream | observed overflow message |
|---|---|
| ChatGPT-Codex OAuth (gpt-5.6-*) | `Your input exceeds the context window of this model. Please adjust your input and try again.` |
| OpenRouter (kimi-k3) | `Provider returned error` (envelope), upstream detail `…exceeded model token limit: <n>` |
| Moonshot direct | `Invalid request: Your request exceeded model token limit: <limit> (requested: <n>)` |

None match, so a session that outruns proactive compaction dies unrecoverably.

## What

At CLIProxyAPI's per-executor error-translation layer (where upstream errors become
Anthropic-format `{"type":"error","error":{...}}` bodies), detect overflow by matching
the upstream message against:

    (?i)(exceeds the context window|exceeded model token limit|context_length_exceeded|maximum context length)

and rewrite `error.message` to Anthropic's literal shape, preserving numbers when the
upstream supplies them, else omitting them:

    prompt is too long: <n> tokens > <limit> maximum
    prompt is too long

Status code stays as upstream mapped it (400-class). Only `error.message` changes.

## Delivery

Stock-binary invariant holds (install pipeline pins version + sha256), so:
1. Fork `router-for-me/CLIProxyAPI`, implement against the pinned tag, with unit tests
   per executor (codex, openai-compat) covering the three signatures above.
2. Submit upstream PR referencing Claude Code's reactive-recovery matching.
3. When a release containing the fix ships, bump `CLIPROXY_RELEASE` (version + sha256)
   in `apps/daemon/src/cliproxy-install.ts` — the normal upgrade path.

Until merged, proactive thresholds (spec §3.2) are the primary and sufficient defense;
this patch only restores the last-resort path.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-22-claudex-addon-design.md deploy/cliproxy-patches/overflow-error-normalize.md
git commit -m "docs: fix compaction-model claim; author cliproxy overflow-normalization patch doc"
```

---

### Task 7: Rollout (deploy + ops + verification)

**Files:** none (operational; runbook = `DEPLOY_TO_VPS.md`).

- [ ] **Step 1: Full local gate**

Run: `pnpm check` → clean. Run: `cd apps/daemon && pnpm test` → all pass. Run: `pnpm --filter @orquester/web build` → succeeds.

- [ ] **Step 2: Push + deploy both VPSes** per `DEPLOY_TO_VPS.md` one-liners (vps-a `root@173.249.49.126`, vps-b `ubuntu@152.228.139.179`). The daemon restart triggers `bootAdopt → seedHomes` which force-merges `autoCompactEnabled: true` into both proxy homes — no manual home edits.

- [ ] **Step 3: Ops — flip the system settings on vps-a** (normal Claude sessions; user-approved "everywhere"):

```bash
python3 - <<'EOF'
import json
p = '/var/lib/orquester/.claude/settings.json'
d = json.load(open(p))
d['autoCompactEnabled'] = True
json.dump(d, open(p, 'w'), indent=2)
print('autoCompactEnabled:', d['autoCompactEnabled'])
EOF
```

(vps-b: nothing — no cliproxy, no `autoCompactEnabled` key, default is enabled.)

- [ ] **Step 4: Verify on vps-a**

```bash
# homes healed:
python3 -c "import json; print(json.load(open('/var/lib/orquester/daemon/cliproxy/claude-home-claudex/settings.json'))['autoCompactEnabled'])"   # → True
# fresh claudex tab on gpt-5.6-sol: status line shows "N% until auto-compact"
# fresh claudex tab on kimi-k3: /context reflects the 1M window
# fresh claudemix tab: status line shows the auto-compact meter (arming works for claude)
```

Existing tabs keep old env — relaunch to pick the behavior up.

- [ ] **Step 5: Post-deploy smoke** (mandatory after any web/ui deploy):

```bash
node scripts/smoke-web.mjs https://agents.jasperdev.io
node scripts/smoke-web.mjs https://samuelagents.centurlabs.com
```

---

## Self-review notes

- Spec §3.1 → Tasks 2 + 7 (ops flip). §3.2 metadata/overrides/emission → Tasks 1, 3, 4, 5. §3.4 patch → Task 6. §1 doc correction → Task 6. §4 tests distributed into each task. §5 rollout → Task 7. No uncovered spec sections.
- Type names cross-checked: `CliProxyModelOverrides`, `compactEnvForModel`, `CURATED_PROXY_MODEL_IDS`, `CLAUDE_ARMING_COMPACT_WINDOW` used consistently across Tasks 1/3/4/5.
- Known intentional non-goals restated: no compact-model remapping, no effort-capping, no Orquester-side failure detection (spec §3.3).
