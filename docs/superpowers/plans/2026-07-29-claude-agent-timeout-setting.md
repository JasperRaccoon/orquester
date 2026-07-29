# Claude Agent Stream Timeout Setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one daemon-side setting that raises the Claude harness stream/API timeouts for every Claude session launched through orquester, defaulting to 30 minutes on every VPS that exists today and every VPS provisioned later.

**Architecture:** A new `agents` group on the zod `appConfigSchema` (its `.default({})` is what makes a fresh VPS inherit 30 minutes with no migration). A tiny pure daemon module turns `(entryId, minutes)` into three env vars for claude-family launchers only, wired into the existing `resolveExtraEnv` launch seam. The UI control lives in the Agents settings panel and rides the already-remote-writable `PUT /api/config/app`. No new HTTP endpoint and no change to the security boundary.

**Tech Stack:** TypeScript 5.8 ESM, zod (config schemas only), Fastify 4 (daemon), React 18 + zustand + Tailwind (UI), `node --import tsx --test` (daemon tests).

## Global Constraints

- **Only `apps/daemon` has a test runner.** `packages/config` and `packages/ui` expose only `build` and `typecheck`. All tests in this plan therefore live in `apps/daemon/src/*.test.ts`, which is the established pattern — `session-launch-env.test.ts` already imports from `@orquester/config`.
- **Run a single test file with:** `cd apps/daemon && node --import tsx --test src/<name>.test.ts`
- **Intra-package daemon imports carry the `.ts` extension** (e.g. `import { agentFamily } from "./agent-hooks.ts"`). ESM everywhere; `"type": "module"`.
- **The gate is `pnpm check`** (`pnpm -r typecheck`). There is no linter or formatter config.
- **Never start, restart, or stop a daemon on your own initiative.** This repo is checked out inside a running Orquester instance on vps-a. Do not run `pnpm dev`, `pnpm dev:daemon`, `pnpm dev:web`, or bind `127.0.0.1:47831`. Task 6 involves a deploy that restarts the daemon and is explicitly gated on user approval.
- **Exact env var names** (any typo silently does nothing): `API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`.
- **Timeout bounds:** integer minutes, min `1`, max `30`. 30 is Claude Code's own hard clamp (`ODh = 1800000`); larger values are silently floored by the harness, so the UI must not offer them.
- **Commit to the current branch as-is.** Do NOT create a branch, even on `main`.
- Spec: `docs/superpowers/specs/2026-07-29-claude-agent-timeout-setting-design.md`

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/config/src/index.ts` | `agentPrefsSchema`, `AgentPrefs`, `appConfigSchema.agents` — the single source of truth for the default | 1 |
| `apps/daemon/src/agent-timeout-config.test.ts` (new) | Schema defaults and bounds | 1 |
| `apps/daemon/src/agent-timeout-env.ts` (new) | Pure `(entryId, minutes) → env \| null`. No I/O, no index.ts import | 2 |
| `apps/daemon/src/agent-timeout-env.test.ts` (new) | Family gating, ms conversion, composition precedence | 2, 3 |
| `apps/daemon/src/index.ts` | Wire the contributor into `resolveExtraEnv` | 3 |
| `packages/ui/src/lib/app-config.ts` | `normalizeAgentPrefs` + `sanitizeStoredAppConfig` handling | 4 |
| `packages/ui/src/store/app.ts` | `UiAppConfig.agents`, defaults, load-time normalization | 4 |
| `packages/ui/src/components/settings/SettingsModal.tsx` | The control in `AgentsSettings` | 5 |

---

### Task 1: Config schema — the `agents` group

**Files:**
- Modify: `packages/config/src/index.ts` (add after `usageAgentEnabled`, ~line 320; and inside `appConfigSchema`, ~line 379)
- Test: `apps/daemon/src/agent-timeout-config.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `agentPrefsSchema`, `type AgentPrefs = { claudeTimeoutMinutes: number }`, and `AppConfig.agents: AgentPrefs`. Tasks 2–5 all depend on the field name `claudeTimeoutMinutes` and the 1–30 integer bounds.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/agent-timeout-config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultAppConfig, parseAppConfig } from "@orquester/config";

test("a config with no agents group defaults to 30 minutes", () => {
  assert.equal(createDefaultAppConfig().agents.claudeTimeoutMinutes, 30);
  assert.equal(parseAppConfig({}).agents.claudeTimeoutMinutes, 30);
});

test("an explicit in-range value is preserved", () => {
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 10 } }).agents.claudeTimeoutMinutes, 10);
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 1 } }).agents.claudeTimeoutMinutes, 1);
  assert.equal(parseAppConfig({ agents: { claudeTimeoutMinutes: 30 } }).agents.claudeTimeoutMinutes, 30);
});

test("out-of-range and non-integer values are rejected", () => {
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: 0 } }));
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: 31 } }));
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: 2.5 } }));
  assert.throws(() => parseAppConfig({ agents: { claudeTimeoutMinutes: "30" } }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/agent-timeout-config.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'claudeTimeoutMinutes')`, because `AppConfig` has no `agents` field yet.

- [ ] **Step 3: Add the schema**

In `packages/config/src/index.ts`, immediately after the `usageAgentEnabled` function, add:

```ts
/**
 * Agent-harness runtime preferences. Daemon-side and per-VPS: the daemon reads
 * them at session launch, so every client that launches a session gets the same
 * value. The parent group's `.default({})` on appConfigSchema is what lets a
 * freshly provisioned VPS inherit these with no migration step.
 */
export const agentPrefsSchema = z.object({
  /**
   * Claude harness stream/API timeout, in minutes. Injected at session launch
   * for every claude-family launcher (claude/claudex/claudemix). 30 is Claude
   * Code's own hard clamp on the idle watchdogs (ODh = 1800000) — a larger
   * value is silently floored by the harness, so it is rejected here rather
   * than displayed as a number that does nothing.
   */
  claudeTimeoutMinutes: z.number().int().min(1).max(30).default(30)
});
export type AgentPrefs = z.infer<typeof agentPrefsSchema>;
```

Then in `appConfigSchema`, change the last property from:

```ts
  /** Top-bar agent-usage widget preferences. */
  usage: usagePrefsSchema.default({})
```

to:

```ts
  /** Top-bar agent-usage widget preferences. */
  usage: usagePrefsSchema.default({}),
  /** Agent-harness runtime preferences (see agentPrefsSchema). */
  agents: agentPrefsSchema.default({})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/daemon && node --import tsx --test src/agent-timeout-config.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: clean. (`UiAppConfig` in the UI store is a separate hand-written interface, not derived from `AppConfig`, so adding this field does not break the UI build yet. Task 4 adds it there.)

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/index.ts apps/daemon/src/agent-timeout-config.test.ts
git commit -m "feat(config): add agents.claudeTimeoutMinutes app-config setting"
```

---

### Task 2: The launch-env module

**Files:**
- Create: `apps/daemon/src/agent-timeout-env.ts`
- Test: `apps/daemon/src/agent-timeout-env.test.ts` (create)

**Interfaces:**
- Consumes: `agentFamily(entryId: string): "claude" | "codex" | "opencode" | null` from `./agent-hooks.ts` (defined at `agent-hooks.ts:16`).
- Produces: `claudeTimeoutEnv(entryId: string, minutes: number): { env: Record<string, string> } | null`. Task 3 calls exactly this signature.

**Critical constraint:** `LaunchEnv` is declared **unexported** at `apps/daemon/src/index.ts:763`, and `index.ts` will import this module in Task 3. This module must therefore NOT import that type back from `index.ts` — that is an import cycle. Declare the return shape locally; it is structurally compatible with what `composeExtraEnv` accepts.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/agent-timeout-env.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeTimeoutEnv } from "./agent-timeout-env.ts";

test("returns null for every non-claude launcher", () => {
  assert.equal(claudeTimeoutEnv("codex", 30), null);
  assert.equal(claudeTimeoutEnv("opencode", 30), null);
  assert.equal(claudeTimeoutEnv("gemini", 30), null);
  assert.equal(claudeTimeoutEnv("deepseek", 30), null);
  assert.equal(claudeTimeoutEnv("", 30), null);
});

test("covers every claude-family launcher with all three keys", () => {
  for (const id of ["claude", "claudex", "claudemix"]) {
    const result = claudeTimeoutEnv(id, 30);
    assert.ok(result, `${id} must receive timeout env`);
    assert.deepEqual(result.env, {
      API_TIMEOUT_MS: "1800000",
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1800000",
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1800000"
    });
  }
});

test("converts minutes to milliseconds at both bounds", () => {
  assert.equal(claudeTimeoutEnv("claude", 1)?.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "60000");
  assert.equal(claudeTimeoutEnv("claude", 30)?.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "1800000");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/agent-timeout-env.test.ts`
Expected: FAIL — `Cannot find module './agent-timeout-env.ts'`.

- [ ] **Step 3: Write the module**

Create `apps/daemon/src/agent-timeout-env.ts`:

```ts
import { agentFamily } from "./agent-hooks.ts";

/**
 * Structural match for index.ts's unexported `LaunchEnv`. Declared locally on
 * purpose: index.ts imports THIS module, so importing the type back from
 * index.ts would be a cycle. `composeExtraEnv` accepts this shape structurally.
 */
type TimeoutLaunchEnv = { env: Record<string, string> };

/**
 * Claude harness stream/API timeout env for one session launch.
 *
 * Claude Code aborts a streaming request after 180 s with no bytes received
 * (its `$Dh` default) and renders "[Request interrupted by user]" — which
 * killed 37 of 52 subagents in a single workflow run on the VPS. These three
 * variables are the documented per-process overrides. The managed CLIProxyAPI
 * is NOT involved: it has no timeout of any kind and merely observes the
 * client hang up.
 *
 * Keys on the FAMILY, never the raw id: claudex/claudemix run the real `claude`
 * binary against the managed proxy, so they need the same env as plain `claude`
 * (same reasoning as agent-hooks.ts's config targeting).
 *
 * Returns null for non-claude launchers — these variables mean nothing to
 * codex/opencode/gemini and must not be set for them.
 */
export function claudeTimeoutEnv(entryId: string, minutes: number): TimeoutLaunchEnv | null {
  if (agentFamily(entryId) !== "claude") return null;
  const ms = String(minutes * 60_000);
  return {
    env: {
      API_TIMEOUT_MS: ms,
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: ms,
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: ms
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/daemon && node --import tsx --test src/agent-timeout-env.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agent-timeout-env.ts apps/daemon/src/agent-timeout-env.test.ts
git commit -m "feat(daemon): add claudeTimeoutEnv launch-env contributor"
```

---

### Task 3: Wire the contributor into the launch seam

**Files:**
- Modify: `apps/daemon/src/index.ts` — the import block at the top, and `resolveExtraEnv` at `index.ts:341-356`
- Test: `apps/daemon/src/agent-timeout-env.test.ts` (append one test)

**Interfaces:**
- Consumes: `claudeTimeoutEnv` from Task 2; `composeExtraEnv(a, b)` and `cliproxyContributor(entryId, ctx, daemonDir)` (both already exported from `index.ts`); `readAppConfigFile(file)` (already defined at `index.ts:4005`, a hoisted function declaration, so calling it from line ~341 is fine).
- Produces: no new exports. Behavioural contract: every claude-family agent session launched through the daemon carries the three env vars.

**Why the nesting order matters:** `composeExtraEnv(a, b)` lets `b` win key collisions and takes `accountId` from `a` first, falling back to `b`. The existing call is `composeExtraEnv(agentAccounts, cliproxy)`. Nesting the timeout contributor into the `a` position preserves both properties exactly: `cliproxyContributor` stays outermost-`b` so it still wins collisions, and `accountId` still resolves agentAccounts-then-cliproxy.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/agent-timeout-env.test.ts`:

```ts
import { composeExtraEnv } from "./index.ts";

test("cliproxy contributor still wins collisions once the timeout contributor is nested in", () => {
  // Mirrors the exact composition shape used in resolveExtraEnv.
  const merged = composeExtraEnv(
    composeExtraEnv(
      { env: { ANTHROPIC_MODEL: "from-account" }, accountId: "acct-1" },
      claudeTimeoutEnv("claudemix", 30)
    ),
    { env: { ANTHROPIC_MODEL: "from-cliproxy" } }
  );
  assert.equal(merged?.env.ANTHROPIC_MODEL, "from-cliproxy");
  assert.equal(merged?.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, "1800000");
  assert.equal(merged?.accountId, "acct-1");
});

test("a non-claude launcher composes to no timeout keys", () => {
  const merged = composeExtraEnv(
    composeExtraEnv({ env: { CODEX_HOME: "/x" } }, claudeTimeoutEnv("codex", 30)),
    null
  );
  assert.equal(merged?.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS, undefined);
  assert.equal(merged?.env.CODEX_HOME, "/x");
});
```

Move the new `import { composeExtraEnv } from "./index.ts";` up with the other imports at the top of the file rather than leaving it mid-file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/agent-timeout-env.test.ts`
Expected: FAIL on the first new test — `merged.env.CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS` is `undefined`, because nothing imports `claudeTimeoutEnv` into the composition yet. (The test itself calls it directly, so this fails only if you wrote the composition wrong — if it passes immediately, that is fine and expected, since this test pins composition semantics rather than driving new code. Proceed to Step 3 either way.)

- [ ] **Step 3: Add the import to `index.ts`**

In the import block at the top of `apps/daemon/src/index.ts`, alongside the other local `./*.ts` imports, add:

```ts
import { claudeTimeoutEnv } from "./agent-timeout-env.ts";
```

- [ ] **Step 4: Rewrite `resolveExtraEnv`**

In `apps/daemon/src/index.ts`, replace the existing `resolveExtraEnv` body (currently at `index.ts:341-356`):

```ts
    resolveExtraEnv: async (entry, ctx) => {
      if (entry.kind !== "agent") return null;
      try {
        // Managed-account identity (Claude/Codex homes) composed with the
        // cliproxy contributor (auth token + isolated config home + per-launch
        // model) for the claudex/claudemix launchers. The contributor wins on
        // any collision; the managed account keeps the effective accountId.
        return composeExtraEnv(
          await agentAccounts.resolveLaunchEnv(entry.id, ctx.accountId),
          cliproxyContributor(entry.id, ctx, resolved.daemonDir)
        );
      } catch (error) {
        throw new SessionError(error instanceof Error ? error.message : String(error));
      }
    },
```

with:

```ts
    resolveExtraEnv: async (entry, ctx) => {
      if (entry.kind !== "agent") return null;
      try {
        // Claude harness stream/API timeout (spec
        // 2026-07-29-claude-agent-timeout-setting-design.md §3). Read fresh per
        // launch so a settings change applies to the next session with no daemon
        // restart; readAppConfigFile already falls back to schema defaults on a
        // missing or corrupt file, so this cannot throw.
        const { claudeTimeoutMinutes } = (await readAppConfigFile(resolved.appConfigFile)).agents;
        // Managed-account identity (Claude/Codex homes) and the claude-family
        // timeout env, composed with the cliproxy contributor (auth token +
        // isolated config home + per-launch model) for claudex/claudemix. The
        // cliproxy contributor stays outermost so it still wins on any
        // collision; the managed account keeps the effective accountId.
        return composeExtraEnv(
          composeExtraEnv(
            await agentAccounts.resolveLaunchEnv(entry.id, ctx.accountId),
            claudeTimeoutEnv(entry.id, claudeTimeoutMinutes)
          ),
          cliproxyContributor(entry.id, ctx, resolved.daemonDir)
        );
      } catch (error) {
        throw new SessionError(error instanceof Error ? error.message : String(error));
      }
    },
```

- [ ] **Step 5: Run the full daemon test suite**

Run: `cd apps/daemon && pnpm test`
Expected: PASS, including the pre-existing `session-launch-env.test.ts` — that file exercises `composeExtraEnv` and `cliproxyContributor` and must not regress.

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/index.ts apps/daemon/src/agent-timeout-env.test.ts
git commit -m "feat(daemon): inject claude timeout env at agent session launch"
```

---

### Task 4: UI store — type, defaults, and load-time normalization

**Files:**
- Modify: `packages/ui/src/lib/app-config.ts` (imports at line 1; `sanitizeStoredAppConfig`)
- Modify: `packages/ui/src/store/app.ts` (`DEFAULT_USAGE_PREFS` block ~line 134; `UiAppConfig` at line 336; initial state at line 752; initial state at lines 1129-1134; `loadAppConfig` at line 1152)

**Interfaces:**
- Consumes: `agentPrefsSchema` and `type AgentPrefs` from Task 1.
- Produces: `normalizeAgentPrefs(value: unknown, fallback: AgentPrefs): AgentPrefs` exported from `lib/app-config.ts`; `UiAppConfig.agents: AgentPrefs` in the store. Task 5 reads `appConfig.agents.claudeTimeoutMinutes` and writes via `updateAppConfig({ agents: {...} })`.

**Why normalization is mandatory:** AGENTS.md requires that any new persisted client-side shape go through a schema with fallback — raw `JSON.parse` output must never reach typed code, because payloads written by an older bundle outlive a deploy. A `usage` blob from a pre-migration bundle once crashed the whole web client on load.

- [ ] **Step 1: Add `normalizeAgentPrefs` to `lib/app-config.ts`**

Change the import on line 1 from:

```ts
import { usagePrefsSchema, type AppConfig, type UsagePrefs } from "@orquester/config";
```

to:

```ts
import {
  agentPrefsSchema,
  usagePrefsSchema,
  type AgentPrefs,
  type AppConfig,
  type UsagePrefs
} from "@orquester/config";
```

Then add, directly beneath the existing `normalizeUsagePrefs` function:

```ts
export function normalizeAgentPrefs(value: unknown, fallback: AgentPrefs): AgentPrefs {
  if (value == null) return fallback;
  const parsed = agentPrefsSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
```

- [ ] **Step 2: Handle `agents` in `sanitizeStoredAppConfig`**

In the same file, inside `sanitizeStoredAppConfig`, after the `confirmCloseSession` line and before the closing `return out;`, add:

```ts
  if (rec.agents !== undefined) {
    const parsed = agentPrefsSchema.safeParse(rec.agents);
    if (parsed.success) out.agents = parsed.data;
  }
```

This matches the function's documented contract: valid fields pass through, wrong-typed fields are dropped, absent fields stay absent so per-host defaults still win in the store's merge.

- [ ] **Step 3: Add the store default constant**

In `packages/ui/src/store/app.ts`, directly beneath the existing `const DEFAULT_USAGE_PREFS: UsagePrefs = { ... };` block (~line 134), add:

```ts
const DEFAULT_AGENT_PREFS: AgentPrefs = { claudeTimeoutMinutes: 30 };
```

Add `AgentPrefs` to the existing `@orquester/config` type import in this file, and add `normalizeAgentPrefs` to the existing import from `../lib/app-config` on line 45:

```ts
import { normalizeAgentPrefs, normalizeUsagePrefs, type AppConfigAdapter } from "../lib/app-config";
```

- [ ] **Step 4: Extend the `UiAppConfig` interface**

At `packages/ui/src/store/app.ts:336`, change:

```ts
export interface UiAppConfig {
  useTitlebar: boolean;
  runInBackground: boolean;
  confirmCloseSession: boolean;
  usage: UsagePrefs;
}
```

to:

```ts
export interface UiAppConfig {
  useTitlebar: boolean;
  runInBackground: boolean;
  confirmCloseSession: boolean;
  usage: UsagePrefs;
  agents: AgentPrefs;
}
```

- [ ] **Step 5: Run typecheck to find every construction site**

Run: `pnpm check`
Expected: FAIL with `Property 'agents' is missing in type ...` at exactly two object literals — `store/app.ts:752` and `store/app.ts:1129`. This is the intended way to locate them; do not skip this step.

- [ ] **Step 6: Fix both initial-state literals**

At `packages/ui/src/store/app.ts:752`, change:

```ts
  appConfig: { useTitlebar: false, runInBackground: false, confirmCloseSession: true, usage: DEFAULT_USAGE_PREFS },
```

to:

```ts
  appConfig: {
    useTitlebar: false,
    runInBackground: false,
    confirmCloseSession: true,
    usage: DEFAULT_USAGE_PREFS,
    agents: DEFAULT_AGENT_PREFS
  },
```

At `packages/ui/src/store/app.ts:1129`, change:

```ts
      appConfig: {
        useTitlebar: nextSetup.defaultUseTitlebar,
        runInBackground: false,
        confirmCloseSession: true,
        usage: DEFAULT_USAGE_PREFS
      },
```

to:

```ts
      appConfig: {
        useTitlebar: nextSetup.defaultUseTitlebar,
        runInBackground: false,
        confirmCloseSession: true,
        usage: DEFAULT_USAGE_PREFS,
        agents: DEFAULT_AGENT_PREFS
      },
```

- [ ] **Step 7: Normalize on load**

In `loadAppConfig`, at `packages/ui/src/store/app.ts:1152`, change:

```ts
            usage: normalizeUsagePrefs(config.usage, state.appConfig.usage)
```

to:

```ts
            usage: normalizeUsagePrefs(config.usage, state.appConfig.usage),
            agents: normalizeAgentPrefs(config.agents, state.appConfig.agents)
```

- [ ] **Step 8: Typecheck**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/lib/app-config.ts packages/ui/src/store/app.ts
git commit -m "feat(ui): thread agents prefs through the app-config store"
```

---

### Task 5: The settings control in the Agents panel

**Files:**
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx` — the `AgentsSettings` component at line 186

**Interfaces:**
- Consumes: `appConfig.agents.claudeTimeoutMinutes` and `updateAppConfig` from Task 4; the file-local `Field` component (`SettingsModal.tsx:170`) and the imported `Input`, both already used by the Daemon panel.
- Produces: nothing consumed by later tasks.

`useEffect` and `useState` are already imported at `SettingsModal.tsx:1`. No new imports beyond the store selectors, which follow the existing `useAppStore((s) => s.x)` pattern already used in this component.

- [ ] **Step 1: Add state and commit handler**

In `packages/ui/src/components/settings/SettingsModal.tsx`, inside `AgentsSettings`, directly after the existing `const [filter, setFilter] = useState<AgentFilter>("all");`, add:

```tsx
  const agents = useAppStore((s) => s.appConfig.agents);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const [timeoutDraft, setTimeoutDraft] = useState(String(agents.claudeTimeoutMinutes));

  // Re-sync when another client changes the value (app.json is shared).
  useEffect(() => setTimeoutDraft(String(agents.claudeTimeoutMinutes)), [agents.claudeTimeoutMinutes]);

  const commitTimeout = () => {
    const next = Number.parseInt(timeoutDraft, 10);
    // Reject out-of-band values by snapping the field back rather than
    // persisting something the daemon's zod schema would refuse.
    if (!Number.isInteger(next) || next < 1 || next > 30) {
      setTimeoutDraft(String(agents.claudeTimeoutMinutes));
      return;
    }
    if (next !== agents.claudeTimeoutMinutes) {
      void updateAppConfig({ agents: { ...agents, claudeTimeoutMinutes: next } });
    }
  };
```

- [ ] **Step 2: Render the control**

In the same component's returned JSX, insert this block as the first child of the outer `<div className="space-y-3">`, above the existing filter-button row:

```tsx
      <div className="rounded-lg border border-neutral-800 px-3">
        <Field
          label="Claude stream timeout"
          hint="Minutes an idle Claude stream may stall before the harness aborts it. Applies to every Claude harness launched here (claude, claudex, claudemix) and to their subagents. 30 is the maximum the harness honors. Takes effect for newly launched sessions."
        >
          <Input
            className="w-20"
            type="number"
            min={1}
            max={30}
            value={timeoutDraft}
            onChange={(e) => setTimeoutDraft(e.target.value)}
            onBlur={commitTimeout}
          />
        </Field>
      </div>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: clean.

- [ ] **Step 4: Build the web bundle**

Run: `pnpm build`
Expected: succeeds, emitting `apps/web/dist`. Do NOT pipe this through `tail` or `grep` — a pipeline's exit status is the last command's, so `set -e` would not catch a failed `vite build`.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "feat(ui): add Claude stream timeout control to Agents settings"
```

---

### Task 6: Remove the hand-edited overrides, deploy, verify

**Files:**
- Delete edits on vps-a: `/var/lib/orquester/.claude/settings.json`, `/var/lib/orquester/daemon/cliproxy/claude-home-claudex/settings.json`, `/var/lib/orquester/daemon/cliproxy/claude-home-claudemix/settings.json`
- Delete edits on vps-b: `/var/lib/orquester/.claude/settings.json`
- Each has an adjacent `.bak-timeouts` backup taken before the edit.

**Interfaces:**
- Consumes: the deployed build from Tasks 1–5.
- Produces: a system where the daemon setting is the only writer of these three env vars.

**Why this is not cosmetic:** Claude Code applies `settings.json` `env` on top of the inherited process env. Those four files currently hard-code `1800000`, so they would override the new setting. Today both values agree and nothing looks wrong — the first time the setting is lowered, the files silently pin it back to 30.

> **STOP — user approval required before this task.** `./deploy.sh deploy all` restarts the `orquester` service on **vps-a, which is the box hosting this checkout and the live session**. tmux sessions survive it (`KillMode=process`, near-instant graceful restart), but this is an outward-facing action. Do not run it on your own initiative.

- [ ] **Step 1: Restore the three vps-a files from backup**

```bash
for f in /var/lib/orquester/.claude/settings.json \
         /var/lib/orquester/daemon/cliproxy/claude-home-claudex/settings.json \
         /var/lib/orquester/daemon/cliproxy/claude-home-claudemix/settings.json; do
  cp -p "$f.bak-timeouts" "$f" && echo "restored $f"
done
```

- [ ] **Step 2: Verify the three timeout keys are gone from vps-a**

```bash
grep -l "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS" \
  /var/lib/orquester/.claude/settings.json \
  /var/lib/orquester/daemon/cliproxy/claude-home-*/settings.json 2>/dev/null || echo "CLEAN: no hand-edited overrides remain"
```

Expected: `CLEAN: no hand-edited overrides remain`

- [ ] **Step 3: Restore the vps-b file from backup**

Real host/user/key values live ONLY in the gitignored `deploy/targets.conf` (per
AGENTS.md: never commit a real domain, IP, or secret). Read the `[vps-b]` section
there for `$HOST`/`$USER`/`$KEY`, and prefix `sudo` only if that target sets
`sudo = yes`.

```bash
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  "$USER@$HOST" \
  'cp -p /var/lib/orquester/.claude/settings.json.bak-timeouts /var/lib/orquester/.claude/settings.json &&
   (grep -q CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS /var/lib/orquester/.claude/settings.json && echo "STILL PRESENT" || echo "CLEAN")'
```

Expected: `CLEAN`

- [ ] **Step 4: Deploy (after explicit user approval)**

```bash
./deploy.sh deploy all
```

Expected: per-target health check `{"ok":true}` and a bundle-hash change. Confirm by the live bundle hash, not by the SSH output:

```bash
curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js'
```

- [ ] **Step 5: Browser smoke test (mandatory after any web/ui deploy)**

```bash
node scripts/smoke-web.mjs https://<vps-a-domain>
```

Expected: exits 0. It loads the deployed SPA with clean storage *and* with legacy localStorage fixtures, failing on any uncaught page error, console error, or empty `#root` — which is exactly the regression class the new `agents` field could introduce for a client holding an older `orquester.app` blob.

- [ ] **Step 6: Verify the env actually reaches a session**

Launch a Claude agent session through the UI, then from a terminal session on the same box:

```bash
for p in $(pgrep -f "claude" ); do
  tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS &&
    { echo "PID $p:"; tr '\0' '\n' < /proc/$p/environ | grep -E "TIMEOUT_MS"; }
done
```

Expected: the three variables present at `1800000` on the newly launched session. A session launched *before* the deploy will not have them — that is correct, not a failure.

- [ ] **Step 7: Behavioural confirmation**

Run a workload with long generations, then measure the idle gap between each agent's last transcript event and any interrupt marker across the run's agent JSONL files (the same measurement that diagnosed this). Expected: no cluster at ~180 s.

- [ ] **Step 8: Commit any deploy-related changes**

```bash
git status --short
# commit only if the deploy modified tracked files
```

---

## Self-Review

**Spec coverage:** §1 data model → Task 1. §2 `agent-timeout-env.ts` incl. the no-import-cycle constraint → Task 2. §3 wiring at `index.ts:341` incl. contributor ordering and fail-safe read → Task 3. §4 "API — no change" → no task needed, verified by Task 3 using the existing `readAppConfigFile` and by the UI using the existing `updateAppConfig`. §5 UI → Task 5, with the mandatory `normalizeAgentPrefs` split into Task 4 because it is a distinct reviewable deliverable. §6 cleanup → Task 6. Testing section → Tasks 1, 2, 3 (unit) and Task 6 (end-to-end). No gaps.

**Placeholder scan:** No TBD/TODO. Every code step carries complete code. No "similar to Task N" references. `<vps-a-domain>` in Task 6 Step 5 is a deliberate placeholder for a real domain, which AGENTS.md forbids committing to the repo.

**Type consistency:** `claudeTimeoutMinutes` used identically in Tasks 1, 3, 4, 5. `claudeTimeoutEnv(entryId, minutes)` defined in Task 2, called with that signature in Task 3. `AgentPrefs` exported in Task 1, imported in Task 4, consumed in Task 5. `normalizeAgentPrefs(value, fallback)` defined and used consistently in Task 4. `DEFAULT_AGENT_PREFS` defined in Task 4 Step 3 before its uses in Steps 6.

**One known soft spot:** Task 3 Step 2's "expected failure" may pass immediately, because the test pins composition semantics rather than driving new code. The step says so explicitly rather than pretending otherwise.
