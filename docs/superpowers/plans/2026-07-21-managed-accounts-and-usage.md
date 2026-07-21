# Managed Agent Accounts + Usage-Tracking Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Orquester per-session Claude/Codex account selection backed by per-account credential homes (import-only capture) with a background OAuth refresher, remove the TeamClaude proxy addon, and upgrade usage tracking (live Codex source, registry-driven agent set, token/cost aggregates, per-account usage).

**Architecture:** A new daemon `AgentAccountsService` owns per-account credential homes under the appdir and hands the session manager a launch-env patch (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` + auth-env unset) resolved from the session's chosen `accountId`. The existing `resolveExtraEnv` hook (today TeamClaude-only) is widened to carry that patch; the session env-wrapper is widened to unset keys. Usage upgrades ride the same plumbing: a live Codex `wham/usage` source, a token/cost scanner, and per-account usage entries. TeamClaude is deleted wholesale.

**Tech Stack:** TypeScript 5.8 ESM run by tsx (no build), Fastify 4, zod 3, React 18 + zustand + Tailwind, `node:test` + `node:assert/strict` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-21-managed-accounts-and-usage-design.md`

## Global Constraints

- **⛔ Never start, restart, or stop a daemon from this checkout** (no `pnpm dev*`, no `tsx apps/daemon/src/cli.ts`, no port/socket binds, no `systemctl`) — a live daemon serves this repo. Verification = typecheck + unit tests + code review only.
- **Typecheck gate (run from repo root):** `pnpm check` — must be clean before **every** commit. Because packages share TypeScript source directly, a type-shape change is not "done" until every consumer compiles; tasks that change a shared type update all consumers in the same commit.
- **Daemon unit tests** run from `apps/daemon/`: single file `node --import tsx --test src/<file>.test.ts`.
- **Config/UI unit tests** run from repo root: `node --import tsx --test packages/<pkg>/src/<file>.test.ts`.
- **Import extensions:** files inside `apps/daemon/src` import sibling daemon modules with explicit `.ts` extensions (e.g. `from "./sessions.ts"`). Cross-package imports use the package name (`@orquester/api`, `@orquester/config`).
- **Secrets never cross the wire or the index:** credential blobs live only in per-account home files (0600) under 0700 dirs; `agent-accounts.json` and every API response contain **no** token material (same discipline as `AccountsService` for SSH keys / PATs).
- **Constants (verbatim):** Claude OAuth token endpoint `https://platform.claude.com/v1/oauth/token`; Claude Code public OAuth client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`; Codex usage endpoint `https://chatgpt.com/backend-api/wham/usage`; refresher cadence `REFRESH_INTERVAL_MS = 60 * 60_000` (hourly); refresh margin `REFRESH_MARGIN_MS = 15 * 60_000`; usage 429 floor `5 * 60_000`.
- **UI is not unit-tested here** (no browser harness). UI tasks verify by `pnpm check` + code review; each notes what to drive manually when the app is next run by the user.
- **Tasks are ordered; execute in sequence.** Later tasks consume names/types defined in earlier ones (see each task's Interfaces block).
- **Commits:** one per task, message shown in the task. End every commit body with:
  `Co-Authored-By: Claude <noreply@anthropic.com>`

---

## File structure

**New files**

| File | Responsibility |
|---|---|
| `apps/daemon/src/agent-account-paths.ts` | Path helpers + `assertOwnedAccountHome` ownership proof |
| `apps/daemon/src/agent-account-identity.ts` | Blob shape detection + Claude/Codex identity extraction |
| `apps/daemon/src/agent-account-refresh.ts` | OAuth refresh + "which accounts to refresh" selector |
| `apps/daemon/src/agent-accounts.ts` | `AgentAccountsService` (index, import, remove, defaults, launch-env, refresher) |
| `apps/daemon/src/usage-tokens.ts` | Token/cost scanner + price table + cache |
| `packages/ui/src/components/settings/AgentAccountsSettings.tsx` | Settings pane (list/import/remove/default) |
| `*.test.ts` beside each logic module | Unit tests |

**Modified files**

| File | Change |
|---|---|
| `packages/config/src/index.ts` | `agentAccounts*` schema + path helpers; `usagePrefsSchema` → agents record + migration |
| `packages/api/src/index.ts` | Account wire types; `accountId` on `CreateSessionRequest`/`SessionSummary`; widen `AgentUsage.id`; drop TeamClaude types |
| `apps/daemon/src/sessions.ts` | Thread `accountId`; widen `resolveExtraEnv` + env-wrapper unset; `liveAccountIds()` |
| `apps/daemon/src/usage.ts` | Generic prefs read in `recompute`; `DEFAULT_PREFS` |
| `apps/daemon/src/usage-sources.ts` | Codex `wham/usage` source + fallback; per-account home params |
| `apps/daemon/src/usage-parse.ts` | `parseCodexWhamUsage` |
| `apps/daemon/src/index.ts` | Account routes/broadcast/wiring; remove TeamClaude; token route; per-account usage wiring |
| `packages/ui/src/lib/api-client.ts` | Account methods; drop TeamClaude methods |
| `packages/ui/src/store/app.ts` | `agent-accounts` event channel; account state; drop TeamClaude |
| `packages/ui/src/components/topbar/UsageWidget.tsx` | Registry-driven labels; Cost tab |
| `packages/ui/src/components/settings/SettingsModal.tsx` | Add Agent Accounts pane; per-agent usage toggles; drop Addons |
| launch flow + session tab components | Account picker + badge |

**Deleted files**

`apps/daemon/src/teamclaude.ts`, `apps/daemon/src/teamclaude.check.ts`, `packages/ui/src/components/settings/AddonsSettings.tsx`.

---

### Task 1: Agent-accounts config schema + path helpers

**Files:**
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/agent-accounts.test.ts`

**Interfaces:**
- Consumes: `z` (zod), `joinPath`, `daemonConfigDir(baseDir)` (all already in this file).
- Produces (used by Tasks 2, 4, 6, 9):
  - `agentAccountSchema`, `agentAccountsSchema` (zod)
  - `type AgentAccountRecord = z.infer<typeof agentAccountSchema>`
  - `type AgentAccountsIndex = z.infer<typeof agentAccountsSchema>`
  - `parseAgentAccounts(raw: unknown): AgentAccountsIndex`
  - `createDefaultAgentAccounts(): AgentAccountsIndex`
  - `agentAccountsFile(baseDir: string): string` → `<daemonDir>/agent-accounts.json`
  - `agentAccountsDir(baseDir: string): string` → `<daemonDir>/agent-accounts`
  - `agentAccountHome(baseDir: string, agent: string, id: string): string` → `<accountsDir>/<agent>/<id>/home`

- [ ] **Step 1: Write the failing test**

Create `packages/config/src/agent-accounts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  agentAccountsFile,
  agentAccountHome
} from "./index.ts";

test("createDefaultAgentAccounts is empty with null defaults", () => {
  const d = createDefaultAgentAccounts();
  assert.deepEqual(d.accounts, []);
  assert.deepEqual(d.defaults, { claude: null, codex: null });
});

test("parseAgentAccounts fills defaults and coerces missing fields", () => {
  const parsed = parseAgentAccounts({
    accounts: [{ id: "a1", agent: "claude", label: "Work", createdAt: "t", importedAt: "t" }]
  });
  assert.equal(parsed.accounts[0].email, null);
  assert.equal(parsed.accounts[0].plan, null);
  assert.equal(parsed.accounts[0].needsReauth, false);
  assert.deepEqual(parsed.defaults, { claude: null, codex: null });
});

test("parseAgentAccounts rejects an unknown agent", () => {
  assert.throws(() => parseAgentAccounts({ accounts: [{ id: "x", agent: "gemini", label: "g", createdAt: "t", importedAt: "t" }] }));
});

test("path helpers compose under the daemon dir", () => {
  assert.match(agentAccountsFile("/base"), /agent-accounts\.json$/);
  assert.equal(
    agentAccountHome("/base", "codex", "id9").endsWith("agent-accounts/codex/id9/home"),
    true
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test packages/config/src/agent-accounts.test.ts`
Expected: FAIL — `parseAgentAccounts` / helpers are not exported.

- [ ] **Step 3: Implement schema + helpers**

In `packages/config/src/index.ts`, after the existing usage-prefs block, add:

```ts
export const agentAccountSchema = z.object({
  id: z.string(),
  agent: z.enum(["claude", "codex"]),
  label: z.string(),
  email: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  needsReauth: z.boolean().default(false),
  createdAt: z.string(),
  importedAt: z.string()
});
export const agentAccountsSchema = z.object({
  accounts: z.array(agentAccountSchema).default([]),
  defaults: z
    .object({
      claude: z.string().nullable().default(null),
      codex: z.string().nullable().default(null)
    })
    .default({ claude: null, codex: null })
});
export type AgentAccountRecord = z.infer<typeof agentAccountSchema>;
export type AgentAccountsIndex = z.infer<typeof agentAccountsSchema>;

export function parseAgentAccounts(raw: unknown): AgentAccountsIndex {
  return agentAccountsSchema.parse(raw);
}
export function createDefaultAgentAccounts(): AgentAccountsIndex {
  return { accounts: [], defaults: { claude: null, codex: null } };
}
export function agentAccountsFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-accounts.json");
}
export function agentAccountsDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "agent-accounts");
}
export function agentAccountHome(baseDir: string, agent: string, id: string): string {
  return joinPath(agentAccountsDir(baseDir), agent, id, "home");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test packages/config/src/agent-accounts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm check
git add packages/config/src/index.ts packages/config/src/agent-accounts.test.ts
git commit -m "$(cat <<'EOF'
feat(config): agent-accounts schema + appdir path helpers

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Account wire types + session accountId + widen AgentUsage.id

**Files:**
- Modify: `packages/api/src/index.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 6, 8, 9, 11, 13, 14, 15, 16):
  - `type AgentAccountAgent = "claude" | "codex"`
  - `interface AgentAccount { id; agent: AgentAccountAgent; label; email: string | null; plan: string | null; needsReauth: boolean; createdAt; importedAt }`
  - `interface AgentAccountsResponse { accounts: AgentAccount[]; defaults: { claude: string | null; codex: string | null } }`
  - `interface ImportAgentAccountRequest { content?: string; from?: string; label?: string }`
  - `interface SetAgentAccountDefaultsRequest { claude?: string | null; codex?: string | null }`
  - `type AgentAccountsEventType = "agent-accounts.changed"`
  - `CreateSessionRequest.accountId?: string`, `SessionSummary.accountId?: string`
  - `AgentUsage.id: string` (was `"claude" | "codex"`)

- [ ] **Step 1: Add account types**

In `packages/api/src/index.ts`, near the session types, add:

```ts
export type AgentAccountAgent = "claude" | "codex";

export interface AgentAccount {
  id: string;
  agent: AgentAccountAgent;
  label: string;
  email: string | null;
  plan: string | null;
  needsReauth: boolean;
  createdAt: string;
  importedAt: string;
}

export interface AgentAccountsResponse {
  accounts: AgentAccount[];
  defaults: { claude: string | null; codex: string | null };
}

export interface ImportAgentAccountRequest {
  content?: string;
  from?: string;
  label?: string;
}

export interface SetAgentAccountDefaultsRequest {
  claude?: string | null;
  codex?: string | null;
}

export type AgentAccountsEventType = "agent-accounts.changed";
```

- [ ] **Step 2: Thread accountId onto session types**

Edit `CreateSessionRequest` (currently lines ~738-746) to add `accountId?: string;`:

```ts
export interface CreateSessionRequest {
  kind: RegistryKind;
  refId: string;
  projectPath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
  accountId?: string;
}
```

Edit `SessionSummary` (interface at ~721) to add, alongside `refId`:

```ts
  accountId?: string;
```

- [ ] **Step 3: Widen the usage agent id**

In `AgentUsage` (line ~457) change:

```ts
  id: string; // was "claude" | "codex"; opened up so new agents can report usage
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS. (Widening the union is source-compatible; `UsageWidget`'s hardcoded label map still compiles — it's fixed in Task 12. Adding optional fields breaks nothing.)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): agent-account wire types, session accountId, open AgentUsage.id

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Usage prefs → per-agent record (atomic across daemon + UI)

**Files:**
- Modify: `packages/config/src/index.ts` (`usagePrefsSchema`)
- Modify: `apps/daemon/src/usage.ts` (`DEFAULT_PREFS`, `recompute`)
- Modify: `packages/ui/src/store/app.ts` (`DEFAULT_USAGE_PREFS` and any `usage.claude`/`usage.codex` reads)
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx` (per-agent usage toggles)
- Test: `packages/config/src/usage-prefs-migrate.test.ts`

**Interfaces:**
- Consumes: `usagePrefsSchema` (existing), `UsagePrefs`.
- Produces (used by Tasks 12, 14):
  - `UsagePrefs.agents: Record<string, boolean>` (default `{}` = every agent enabled)
  - Helper `usageAgentEnabled(prefs: UsagePrefs, id: string): boolean` exported from `@orquester/config` → `prefs.enabled && (prefs.agents[id] ?? true)`
  - `usagePrefsSchema` accepts legacy `{ claude, codex }` and migrates into `agents`.

- [ ] **Step 1: Write the failing migration test**

Create `packages/config/src/usage-prefs-migrate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { usagePrefsSchema, usageAgentEnabled } from "./index.ts";

test("legacy claude/codex booleans migrate into agents record", () => {
  const p = usagePrefsSchema.parse({ enabled: true, claude: true, codex: false });
  assert.equal(p.agents.claude, true);
  assert.equal(p.agents.codex, false);
});

test("new agents record passes through", () => {
  const p = usagePrefsSchema.parse({ enabled: true, agents: { claude: false } });
  assert.equal(usageAgentEnabled(p, "claude"), false);
  assert.equal(usageAgentEnabled(p, "codex"), true); // unknown → default enabled
});

test("disabled master switch overrides per-agent", () => {
  const p = usagePrefsSchema.parse({ enabled: false, agents: { claude: true } });
  assert.equal(usageAgentEnabled(p, "claude"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test packages/config/src/usage-prefs-migrate.test.ts`
Expected: FAIL — `agents` / `usageAgentEnabled` don't exist.

- [ ] **Step 3: Rewrite the schema with a migration + helper**

Replace `usagePrefsSchema` in `packages/config/src/index.ts` with:

```ts
export const usagePrefsSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Legacy per-agent booleans (pre-record). Optional; folded into `agents`.
    claude: z.boolean().optional(),
    codex: z.boolean().optional(),
    agents: z.record(z.string(), z.boolean()).default({}),
    chip: z.enum(["busiest", "claude", "codex"]).default("busiest"),
    view: z.enum(["aggregate", "accounts"]).default("aggregate")
  })
  .transform((p) => {
    const agents = { ...p.agents };
    if (p.claude !== undefined && agents.claude === undefined) agents.claude = p.claude;
    if (p.codex !== undefined && agents.codex === undefined) agents.codex = p.codex;
    return { enabled: p.enabled, agents, chip: p.chip, view: p.view };
  });
export type UsagePrefs = z.infer<typeof usagePrefsSchema>;

export function usageAgentEnabled(prefs: UsagePrefs, id: string): boolean {
  return prefs.enabled && (prefs.agents[id] ?? true);
}
```

(Keep the existing `appConfigSchema.usage: usagePrefsSchema.default({})` line as-is — the default now yields `{ enabled: true, agents: {}, chip: "busiest", view: "aggregate" }`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test packages/config/src/usage-prefs-migrate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Update the daemon usage service**

In `apps/daemon/src/usage.ts`:

Replace `DEFAULT_PREFS`:

```ts
const DEFAULT_PREFS: UsagePrefs = {
  enabled: true,
  agents: {},
  chip: "busiest",
  view: "aggregate"
};
```

In `recompute`, replace the two hardcoded pref reads. Import the helper at top:

```ts
import { usageAgentEnabled, type UsagePrefs } from "@orquester/config";
```

Then:

```ts
    if (usageAgentEnabled(prefs, "claude")) {
      const c = await this.deps.fetchClaude().catch(() => null);
      if (c) agents.push(c);
    }
    if (usageAgentEnabled(prefs, "codex")) {
      const x = await this.deps.readCodex().catch(() => null);
      if (x) agents.push(x);
    }
```

- [ ] **Step 6: Update UI consumers so typecheck stays green**

In `packages/ui/src/store/app.ts` find `DEFAULT_USAGE_PREFS` (the object with `claude`/`codex` booleans) and change it to:

```ts
export const DEFAULT_USAGE_PREFS: UsagePrefs = {
  enabled: true,
  agents: {},
  chip: "busiest",
  view: "aggregate"
};
```

In `packages/ui/src/components/settings/SettingsModal.tsx`, find the two usage toggles that read/write `usage.claude` and `usage.codex`. Replace each read `prefs.usage.claude` with `prefs.usage.agents.claude ?? true` (and `codex` likewise), and each write to set `agents: { ...prefs.usage.agents, claude: value }`:

```tsx
// Claude toggle
checked={appConfig.usage.agents.claude ?? true}
onChange={(v) => updateUsage({ agents: { ...appConfig.usage.agents, claude: v } })}
// Codex toggle
checked={appConfig.usage.agents.codex ?? true}
onChange={(v) => updateUsage({ agents: { ...appConfig.usage.agents, codex: v } })}
```

(Use the existing `updateUsage`/prefs-update handler in that file; only the field access changes. If the file spreads `usage` when persisting, ensure it spreads the migrated shape — no `claude`/`codex` top-level keys.)

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm check` (must be clean — this is the whole point of the atomic task).

```bash
git add packages/config/src/index.ts packages/config/src/usage-prefs-migrate.test.ts apps/daemon/src/usage.ts packages/ui/src/store/app.ts packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "$(cat <<'EOF'
feat: usage prefs become a per-agent record with legacy migration

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Ownership-assert + path helpers (daemon)

**Files:**
- Create: `apps/daemon/src/agent-account-paths.ts`
- Test: `apps/daemon/src/agent-account-paths.test.ts`

**Interfaces:**
- Consumes: `agentAccountsDir`, `agentAccountHome` from `@orquester/config`; `node:fs/promises` `realpath`, `lstat`, `readFile`.
- Produces (used by Task 6):
  - `class AgentAccountError extends Error`
  - `async function assertOwnedAccountHome(accountsDir: string, agent: string, id: string, home: string): Promise<void>` — throws `AgentAccountError` unless: `realpath(home)` is exactly `<realpath(accountsDir)>/<agent>/<id>/home`, `home` is not a symlink, and `<home>/.orq-account` exists containing `id`.
  - `const ACCOUNT_MARKER = ".orq-account"`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/agent-account-paths.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";

async function makeAccountsDir() {
  return mkdtemp(join(tmpdir(), "orq-acct-"));
}

test("passes for a well-formed owned home", async () => {
  const root = await makeAccountsDir();
  const home = join(root, "claude", "id1", "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ACCOUNT_MARKER), "id1");
  await assertOwnedAccountHome(root, "claude", "id1", home);
});

test("rejects a missing marker", async () => {
  const root = await makeAccountsDir();
  const home = join(root, "claude", "id2", "home");
  await mkdir(home, { recursive: true });
  await assert.rejects(() => assertOwnedAccountHome(root, "claude", "id2", home), AgentAccountError);
});

test("rejects a marker with the wrong id", async () => {
  const root = await makeAccountsDir();
  const home = join(root, "claude", "id3", "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ACCOUNT_MARKER), "somethingelse");
  await assert.rejects(() => assertOwnedAccountHome(root, "claude", "id3", home), AgentAccountError);
});

test("rejects a symlinked home that escapes the accounts dir", async () => {
  const root = await makeAccountsDir();
  const outside = await mkdtemp(join(tmpdir(), "orq-out-"));
  await writeFile(join(outside, ACCOUNT_MARKER), "id4");
  const link = join(root, "claude", "id4", "home");
  await mkdir(join(root, "claude", "id4"), { recursive: true });
  await symlink(outside, link);
  await assert.rejects(() => assertOwnedAccountHome(root, "claude", "id4", link), AgentAccountError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-account-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/agent-account-paths.ts`:

```ts
import { realpath, lstat, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

export const ACCOUNT_MARKER = ".orq-account";

export class AgentAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAccountError";
  }
}

export async function assertOwnedAccountHome(
  accountsDir: string,
  agent: string,
  id: string,
  home: string
): Promise<void> {
  // The home must not itself be a symlink (a swapped link could redirect writes).
  let st;
  try {
    st = await lstat(home);
  } catch {
    throw new AgentAccountError(`Account home is missing: ${agent}/${id}`);
  }
  if (st.isSymbolicLink()) {
    throw new AgentAccountError(`Account home is a symlink: ${agent}/${id}`);
  }
  // Canonicalize both sides so /var vs /private/var and any parent symlink can't fool us.
  const realRoot = await realpath(accountsDir);
  const expected = join(realRoot, agent, id, "home");
  const realHome = await realpath(home);
  if (realHome !== expected && !realHome.startsWith(expected + sep)) {
    throw new AgentAccountError(`Account home is outside the accounts dir: ${agent}/${id}`);
  }
  if (realHome !== expected) {
    throw new AgentAccountError(`Account home path shape is wrong: ${agent}/${id}`);
  }
  let marker: string;
  try {
    marker = (await readFile(join(home, ACCOUNT_MARKER), "utf8")).trim();
  } catch {
    throw new AgentAccountError(`Account marker missing: ${agent}/${id}`);
  }
  if (marker !== id) {
    throw new AgentAccountError(`Account marker mismatch: ${agent}/${id}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-account-paths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm check
git add apps/daemon/src/agent-account-paths.ts apps/daemon/src/agent-account-paths.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): ownership assertion for agent-account homes

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Blob detection + identity extraction (daemon)

**Files:**
- Create: `apps/daemon/src/agent-account-identity.ts`
- Test: `apps/daemon/src/agent-account-identity.test.ts`

**Interfaces:**
- Consumes: nothing external.
- Produces (used by Task 6):
  - `type DetectedAgent = "claude" | "codex"`
  - `function detectAgentFromBlob(parsed: unknown): DetectedAgent | null` — `claudeAiOauth` present → `"claude"`; `tokens.access_token` present → `"codex"`; else `null`.
  - `function claudePlanFromBlob(parsed: unknown): string | null` — `claudeAiOauth.subscriptionType ?? null`.
  - `function parseCodexIdentity(parsed: unknown): { email: string | null; accountId: string | null }` — decode `tokens.id_token` JWT payload (base64url, no verification) for `email`; `accountId` from `tokens.account_id` or the JWT's `chatgpt_account_id`.
  - `function decodeJwtPayload(jwt: string): Record<string, unknown> | null`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/agent-account-identity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAgentFromBlob, claudePlanFromBlob, parseCodexIdentity } from "./agent-account-identity.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

test("detects claude by claudeAiOauth", () => {
  assert.equal(detectAgentFromBlob({ claudeAiOauth: { accessToken: "x" } }), "claude");
});

test("detects codex by tokens.access_token", () => {
  assert.equal(detectAgentFromBlob({ tokens: { access_token: "x" } }), "codex");
});

test("returns null for unknown shapes", () => {
  assert.equal(detectAgentFromBlob({ foo: 1 }), null);
  assert.equal(detectAgentFromBlob("nope"), null);
});

test("claude plan from subscriptionType", () => {
  assert.equal(claudePlanFromBlob({ claudeAiOauth: { subscriptionType: "max" } }), "max");
  assert.equal(claudePlanFromBlob({ claudeAiOauth: {} }), null);
});

test("codex identity from id_token JWT and account_id", () => {
  const blob = {
    tokens: {
      access_token: "a",
      account_id: "acc-123",
      id_token: jwt({ email: "me@example.com", chatgpt_account_id: "ignored-when-account_id-present" })
    }
  };
  const id = parseCodexIdentity(blob);
  assert.equal(id.email, "me@example.com");
  assert.equal(id.accountId, "acc-123");
});

test("codex accountId falls back to JWT chatgpt_account_id", () => {
  const blob = { tokens: { access_token: "a", id_token: jwt({ email: "e@e.com", chatgpt_account_id: "from-jwt" }) } };
  assert.equal(parseCodexIdentity(blob).accountId, "from-jwt");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-account-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/agent-account-identity.ts`:

```ts
export type DetectedAgent = "claude" | "codex";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function detectAgentFromBlob(parsed: unknown): DetectedAgent | null {
  if (!isRecord(parsed)) return null;
  if (isRecord(parsed.claudeAiOauth)) return "claude";
  if (isRecord(parsed.tokens) && typeof parsed.tokens.access_token === "string") return "codex";
  return null;
}

export function claudePlanFromBlob(parsed: unknown): string | null {
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) return null;
  const t = parsed.claudeAiOauth.subscriptionType;
  return typeof t === "string" && t ? t : null;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return isRecord(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function parseCodexIdentity(parsed: unknown): { email: string | null; accountId: string | null } {
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) return { email: null, accountId: null };
  const tokens = parsed.tokens;
  const claims = typeof tokens.id_token === "string" ? decodeJwtPayload(tokens.id_token) : null;
  const email = claims && typeof claims.email === "string" ? claims.email : null;
  const accountId =
    typeof tokens.account_id === "string"
      ? tokens.account_id
      : claims && typeof claims.chatgpt_account_id === "string"
        ? claims.chatgpt_account_id
        : null;
  return { email, accountId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-account-identity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm check
git add apps/daemon/src/agent-account-identity.ts apps/daemon/src/agent-account-identity.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): detect agent + extract identity from credential blobs

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: AgentAccountsService — index, import, remove, defaults, launch-env

**Files:**
- Create: `apps/daemon/src/agent-accounts.ts`
- Test: `apps/daemon/src/agent-accounts.test.ts`

**Interfaces:**
- Consumes: Task 1 config helpers/types; Task 4 (`assertOwnedAccountHome`, `AgentAccountError`, `ACCOUNT_MARKER`); Task 5 (`detectAgentFromBlob`, `claudePlanFromBlob`, `parseCodexIdentity`); `AgentAccount`, `AgentAccountsResponse` from `@orquester/api`.
- Produces (used by Tasks 7, 9, 14):
  - `class AgentAccountsService` with:
    - `readonly events: EventEmitter` (emits `"changed"` with `AgentAccountsResponse`)
    - `constructor(opts: { indexFile: string; accountsDir: string; now: () => number; logger?: Pick<Console, "warn"> })`
    - `init(): Promise<void>` (load index, mkdir accountsDir)
    - `list(): AgentAccountsResponse`
    - `getRecord(id: string): AgentAccountRecord | undefined`
    - `homePath(agent: string, id: string): string`
    - `importAccount(input: { content?: string; from?: string; label?: string }): Promise<AgentAccount>`
    - `removeAccount(id: string): Promise<void>`
    - `setDefaults(patch: { claude?: string | null; codex?: string | null }): Promise<AgentAccountsResponse>`
    - `resolveLaunchEnv(agent: string, accountId?: string): Promise<{ env: Record<string, string>; unset?: string[] } | null>`
    - `persist(): Promise<void>`, `markNeedsReauth(id: string, value: boolean): Promise<void>` (used by Task 7)
  - `const CLAUDE_AUTH_ENV_UNSET = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/agent-accounts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AgentAccountsService } from "./agent-accounts.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

async function makeService() {
  const base = await mkdtemp(join(tmpdir(), "orq-accts-"));
  const svc = new AgentAccountsService({
    indexFile: join(base, "agent-accounts.json"),
    accountsDir: join(base, "agent-accounts"),
    now: () => 1_000
  });
  await svc.init();
  return { base, svc };
}

test("import a codex blob derives identity and writes a 0700 home + marker", async () => {
  const { svc } = await makeService();
  const blob = JSON.stringify({ tokens: { access_token: "a", account_id: "acc1", id_token: jwt({ email: "c@x.com" }) } });
  const acct = await svc.importAccount({ content: blob });
  assert.equal(acct.agent, "codex");
  assert.equal(acct.email, "c@x.com");
  assert.equal(acct.label, "c@x.com");
  const home = svc.homePath("codex", acct.id);
  const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
  assert.equal(auth.tokens.access_token, "a");
  const marker = (await readFile(join(home, ".orq-account"), "utf8")).trim();
  assert.equal(marker, acct.id);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
});

test("import claude requires a label and stores subscriptionType as plan", async () => {
  const { svc } = await makeService();
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", subscriptionType: "max" } });
  await assert.rejects(() => svc.importAccount({ content: blob }), /label/i);
  const acct = await svc.importAccount({ content: blob, label: "Work" });
  assert.equal(acct.agent, "claude");
  assert.equal(acct.label, "Work");
  assert.equal(acct.plan, "max");
  const creds = JSON.parse(await readFile(join(svc.homePath("claude", acct.id), ".credentials.json"), "utf8"));
  assert.equal(creds.claudeAiOauth.refreshToken, "r");
});

test("first account for an agent becomes the default", async () => {
  const { svc } = await makeService();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "e@e.com" }) } }) });
  assert.equal(svc.list().defaults.codex, acct.id);
});

test("resolveLaunchEnv maps claude to CLAUDE_CONFIG_DIR + unset, codex to CODEX_HOME", async () => {
  const { svc } = await makeService();
  const claude = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const cEnv = await svc.resolveLaunchEnv("claude", claude.id);
  assert.equal(cEnv?.env.CLAUDE_CONFIG_DIR, svc.homePath("claude", claude.id));
  assert.deepEqual(cEnv?.unset, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const codex = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z.com" }) } }) });
  const xEnv = await svc.resolveLaunchEnv("codex", codex.id);
  assert.equal(xEnv?.env.CODEX_HOME, svc.homePath("codex", codex.id));
});

test("resolveLaunchEnv falls back to the default account, then System(null)", async () => {
  const { svc } = await makeService();
  const claude = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const dflt = await svc.resolveLaunchEnv("claude"); // no id → default
  assert.equal(dflt?.env.CLAUDE_CONFIG_DIR, svc.homePath("claude", claude.id));
  const none = await svc.resolveLaunchEnv("gemini"); // no accounts for agent → System
  assert.equal(none, null);
});

test("remove deletes the home and clears it from defaults", async () => {
  const { svc } = await makeService();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "d@d.com" }) } }) });
  await svc.removeAccount(acct.id);
  assert.equal(svc.list().accounts.length, 0);
  assert.equal(svc.list().defaults.codex, null);
  await assert.rejects(() => stat(svc.homePath("codex", acct.id)));
});

test("index and API responses carry no token material", async () => {
  const { svc, base } = await makeService();
  await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "SECRET" } }), label: "L" });
  const indexRaw = await readFile(join(base, "agent-accounts.json"), "utf8");
  assert.equal(indexRaw.includes("SECRET"), false);
  assert.equal(JSON.stringify(svc.list()).includes("SECRET"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-accounts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/daemon/src/agent-accounts.ts`:

```ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import type { AgentAccount, AgentAccountsResponse } from "@orquester/api";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  type AgentAccountRecord,
  type AgentAccountsIndex
} from "@orquester/config";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";
import { detectAgentFromBlob, claudePlanFromBlob, parseCodexIdentity } from "./agent-account-identity.ts";

export const CLAUDE_AUTH_ENV_UNSET = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

const CRED_FILENAME = { claude: ".credentials.json", codex: "auth.json" } as const;

export interface AgentAccountsOptions {
  indexFile: string;
  accountsDir: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
}

export class AgentAccountsService {
  readonly events = new EventEmitter();
  private index: AgentAccountsIndex = createDefaultAgentAccounts();

  constructor(private readonly opts: AgentAccountsOptions) {}

  async init(): Promise<void> {
    await mkdir(this.opts.accountsDir, { recursive: true });
    try {
      this.index = parseAgentAccounts(JSON.parse(await readFile(this.opts.indexFile, "utf8")));
    } catch {
      this.index = createDefaultAgentAccounts();
    }
  }

  list(): AgentAccountsResponse {
    return {
      accounts: this.index.accounts.map(toApi),
      defaults: { ...this.index.defaults }
    };
  }

  getRecord(id: string): AgentAccountRecord | undefined {
    return this.index.accounts.find((a) => a.id === id);
  }

  homePath(agent: string, id: string): string {
    return join(this.opts.accountsDir, agent, id, "home");
  }

  async importAccount(input: { content?: string; from?: string; label?: string }): Promise<AgentAccount> {
    const raw = await this.readBlob(input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgentAccountError("Credential file is not valid JSON.");
    }
    const agent = detectAgentFromBlob(parsed);
    if (!agent) {
      throw new AgentAccountError("Unrecognized credential file (expected Claude .credentials.json or Codex auth.json).");
    }

    let label: string;
    let email: string | null = null;
    let plan: string | null = null;
    if (agent === "codex") {
      const idn = parseCodexIdentity(parsed);
      email = idn.email;
      label = input.label?.trim() || idn.email || "Codex account";
    } else {
      if (!input.label?.trim()) {
        throw new AgentAccountError("A label is required for Claude accounts (the credentials file has no email).");
      }
      label = input.label.trim();
      plan = claudePlanFromBlob(parsed);
    }

    const id = randomUUID();
    const home = this.homePath(agent, id);
    await mkdir(home, { recursive: true });
    await chmod(home, 0o700);
    await writeFile(join(home, ACCOUNT_MARKER), id, { mode: 0o600 });
    await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
    await writeFile(join(home, CRED_FILENAME[agent]), raw, { mode: 0o600 });

    const nowIso = new Date(this.opts.now()).toISOString();
    const record: AgentAccountRecord = {
      id,
      agent,
      label,
      email,
      plan,
      needsReauth: false,
      createdAt: nowIso,
      importedAt: nowIso
    };
    this.index.accounts.push(record);
    if (this.index.defaults[agent] == null) this.index.defaults[agent] = id;
    await this.persist();
    this.emitChanged();
    return toApi(record);
  }

  async removeAccount(id: string): Promise<void> {
    const record = this.getRecord(id);
    if (!record) return;
    const home = this.homePath(record.agent, id);
    // Ownership-assert before rm so a swapped/symlinked dir can't redirect the delete.
    await assertOwnedAccountHome(this.opts.accountsDir, record.agent, id, home).catch(() => {
      throw new AgentAccountError(`Refusing to remove unverified account home: ${id}`);
    });
    await rm(join(this.opts.accountsDir, record.agent, id), { recursive: true, force: true });
    this.index.accounts = this.index.accounts.filter((a) => a.id !== id);
    if (this.index.defaults[record.agent] === id) this.index.defaults[record.agent] = null;
    await this.persist();
    this.emitChanged();
  }

  async setDefaults(patch: { claude?: string | null; codex?: string | null }): Promise<AgentAccountsResponse> {
    for (const agent of ["claude", "codex"] as const) {
      if (!(agent in patch)) continue;
      const value = patch[agent] ?? null;
      if (value !== null && !this.index.accounts.some((a) => a.id === value && a.agent === agent)) {
        throw new AgentAccountError(`No ${agent} account with id ${value}`);
      }
      this.index.defaults[agent] = value;
    }
    await this.persist();
    this.emitChanged();
    return this.list();
  }

  async resolveLaunchEnv(
    agent: string,
    accountId?: string
  ): Promise<{ env: Record<string, string>; unset?: string[] } | null> {
    if (agent !== "claude" && agent !== "codex") return null;
    const id = accountId ?? this.index.defaults[agent] ?? null;
    if (!id) return null;
    const record = this.getRecord(id);
    if (!record || record.agent !== agent) return null;
    const home = this.homePath(agent, id);
    await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
    if (agent === "claude") {
      return { env: { CLAUDE_CONFIG_DIR: home }, unset: [...CLAUDE_AUTH_ENV_UNSET] };
    }
    return { env: { CODEX_HOME: home } };
  }

  async markNeedsReauth(id: string, value: boolean): Promise<void> {
    const record = this.getRecord(id);
    if (!record || record.needsReauth === value) return;
    record.needsReauth = value;
    await this.persist();
    this.emitChanged();
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.opts.indexFile), { recursive: true });
    await writeFile(this.opts.indexFile, JSON.stringify(this.index, null, 2), { mode: 0o600 });
  }

  private emitChanged(): void {
    this.events.emit("changed", this.list());
  }

  private async readBlob(input: { content?: string; from?: string }): Promise<string> {
    if (input.content !== undefined) {
      if (input.from?.trim()) throw new AgentAccountError("Provide either uploaded content or a host path, not both.");
      if (!input.content.trim()) throw new AgentAccountError("Uploaded credentials file is empty.");
      return input.content;
    }
    if (!input.from?.trim() || !isAbsolute(input.from.trim())) {
      throw new AgentAccountError("A credential file (upload) or an absolute host path is required.");
    }
    return readFile(input.from.trim(), "utf8");
  }
}

function toApi(r: AgentAccountRecord): AgentAccount {
  return {
    id: r.id,
    agent: r.agent,
    label: r.label,
    email: r.email,
    plan: r.plan,
    needsReauth: r.needsReauth,
    createdAt: r.createdAt,
    importedAt: r.importedAt
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-accounts.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm check
git add apps/daemon/src/agent-accounts.ts apps/daemon/src/agent-accounts.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): AgentAccountsService (import, remove, defaults, launch-env)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: OAuth refresh + idle-account refresher

**Files:**
- Create: `apps/daemon/src/agent-account-refresh.ts`
- Test: `apps/daemon/src/agent-account-refresh.test.ts`
- Modify: `apps/daemon/src/agent-accounts.ts` (add `startRefresher` / `stopRefresher`)

**Interfaces:**
- Consumes: Task 6 service internals (`getRecord`, `homePath`, `assertOwnedAccountHome`, `markNeedsReauth`, `persist`); `AgentAccountRecord`.
- Produces (used by Task 9):
  - `const REFRESH_INTERVAL_MS = 60 * 60_000`, `const REFRESH_MARGIN_MS = 15 * 60_000`
  - `function selectAccountsToRefresh(accounts: AgentAccountRecord[], live: Set<string>, expiries: Map<string, number | null>, now: number, marginMs: number): AgentAccountRecord[]` — returns claude/codex accounts with **no live session** whose token expires within `now + marginMs` (or unknown expiry).
  - `function mergeClaudeRefreshedCreds(existing: any, refreshed: { access_token: string; refresh_token: string; expires_at?: number }): any` — preserves all `claudeAiOauth` fields, overwrites the three token fields (`accessToken`, `refreshToken`, `expiresAt`).
  - `async function refreshClaudeToken(refreshToken: string, fetchImpl?: typeof fetch): Promise<{ ok: true; access_token: string; refresh_token: string; expires_at?: number } | { ok: false; invalidGrant: boolean }>`
  - On the service: `startRefresher(getLiveAccountIds: () => Set<string>): void`, `stopRefresher(): void`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/agent-account-refresh.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAccountsToRefresh, mergeClaudeRefreshedCreds, refreshClaudeToken, REFRESH_MARGIN_MS } from "./agent-account-refresh.ts";
import type { AgentAccountRecord } from "@orquester/config";

function rec(id: string, agent: "claude" | "codex" = "claude"): AgentAccountRecord {
  return { id, agent, label: id, email: null, plan: null, needsReauth: false, createdAt: "t", importedAt: "t" };
}

test("selects idle accounts with soon/unknown expiry, skips live and far-future", () => {
  const now = 1_000_000;
  const accts = [rec("live"), rec("soon"), rec("far"), rec("unknown")];
  const live = new Set(["live"]);
  const expiries = new Map<string, number | null>([
    ["live", now + 60_000],
    ["soon", now + REFRESH_MARGIN_MS - 1],
    ["far", now + REFRESH_MARGIN_MS + 10 * 60_000],
    ["unknown", null]
  ]);
  const picked = selectAccountsToRefresh(accts, live, expiries, now, REFRESH_MARGIN_MS).map((a) => a.id).sort();
  assert.deepEqual(picked, ["soon", "unknown"]);
});

test("mergeClaudeRefreshedCreds preserves other fields", () => {
  const merged = mergeClaudeRefreshedCreds(
    { claudeAiOauth: { accessToken: "old", refreshToken: "oldr", expiresAt: 1, scopes: ["a"], subscriptionType: "max" } },
    { access_token: "new", refresh_token: "newr", expires_at: 2 }
  );
  assert.equal(merged.claudeAiOauth.accessToken, "new");
  assert.equal(merged.claudeAiOauth.refreshToken, "newr");
  assert.equal(merged.claudeAiOauth.expiresAt, 2);
  assert.deepEqual(merged.claudeAiOauth.scopes, ["a"]);
  assert.equal(merged.claudeAiOauth.subscriptionType, "max");
});

test("refreshClaudeToken maps a 200 body", async () => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_at: 9 }), { status: 200 });
  const out = await refreshClaudeToken("r", fake);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.access_token, "A");
    assert.equal(out.refresh_token, "R");
  }
});

test("refreshClaudeToken flags invalid_grant", async () => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  const out = await refreshClaudeToken("r", fake);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.invalidGrant, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-account-refresh.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the refresh module**

Create `apps/daemon/src/agent-account-refresh.ts`:

```ts
import type { AgentAccountRecord } from "@orquester/config";

export const REFRESH_INTERVAL_MS = 60 * 60_000;
export const REFRESH_MARGIN_MS = 15 * 60_000;

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function selectAccountsToRefresh(
  accounts: AgentAccountRecord[],
  live: Set<string>,
  expiries: Map<string, number | null>,
  now: number,
  marginMs: number
): AgentAccountRecord[] {
  return accounts.filter((a) => {
    if (a.agent !== "claude" && a.agent !== "codex") return false;
    if (live.has(a.id)) return false;
    const exp = expiries.get(a.id);
    if (exp == null) return true; // unknown expiry → refresh to be safe
    return exp <= now + marginMs;
  });
}

export function mergeClaudeRefreshedCreds(
  existing: any,
  refreshed: { access_token: string; refresh_token: string; expires_at?: number }
): any {
  const oauth = { ...(existing?.claudeAiOauth ?? {}) };
  oauth.accessToken = refreshed.access_token;
  oauth.refreshToken = refreshed.refresh_token;
  if (refreshed.expires_at !== undefined) oauth.expiresAt = refreshed.expires_at;
  return { ...existing, claudeAiOauth: oauth };
}

export async function refreshClaudeToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<
  { ok: true; access_token: string; refresh_token: string; expires_at?: number } | { ok: false; invalidGrant: boolean }
> {
  let res: Response;
  try {
    res = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID })
    });
  } catch {
    return { ok: false, invalidGrant: false };
  }
  if (!res.ok) {
    let invalidGrant = false;
    try {
      invalidGrant = ((await res.json()) as { error?: string })?.error === "invalid_grant";
    } catch {
      /* ignore */
    }
    return { ok: false, invalidGrant };
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_at?: number };
  if (!body.access_token || !body.refresh_token) return { ok: false, invalidGrant: false };
  return { ok: true, access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/daemon/`): `node --import tsx --test src/agent-account-refresh.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the refresher onto the service**

In `apps/daemon/src/agent-accounts.ts`, add imports:

```ts
import { readFile as fsReadFile } from "node:fs/promises";
import {
  REFRESH_INTERVAL_MS,
  REFRESH_MARGIN_MS,
  selectAccountsToRefresh,
  mergeClaudeRefreshedCreds,
  refreshClaudeToken
} from "./agent-account-refresh.ts";
```

Add a private field `private refreshTimer?: ReturnType<typeof setInterval>;` and these methods to the class:

```ts
  startRefresher(getLiveAccountIds: () => Set<string>): void {
    if (this.refreshTimer) return;
    const run = () => void this.refreshIdleAccounts(getLiveAccountIds()).catch((e) => this.opts.logger?.warn?.(`account refresh failed: ${String(e)}`));
    this.refreshTimer = setInterval(run, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    run(); // once on start (after reattach, callers pass current live ids)
  }

  stopRefresher(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async readClaudeExpiry(id: string): Promise<number | null> {
    try {
      const creds = JSON.parse(await fsReadFile(join(this.homePath("claude", id), ".credentials.json"), "utf8"));
      const exp = creds?.claudeAiOauth?.expiresAt;
      return typeof exp === "number" ? exp : null;
    } catch {
      return null;
    }
  }

  private async refreshIdleAccounts(live: Set<string>): Promise<void> {
    const now = this.opts.now();
    const expiries = new Map<string, number | null>();
    for (const a of this.index.accounts) {
      // Only Claude self-refreshes here; Codex is left to its CLI (see spec 1.5).
      expiries.set(a.id, a.agent === "claude" ? await this.readClaudeExpiry(a.id) : now + REFRESH_INTERVAL_MS * 10);
    }
    const due = selectAccountsToRefresh(this.index.accounts, live, expiries, now, REFRESH_MARGIN_MS).filter(
      (a) => a.agent === "claude"
    );
    for (const acct of due) {
      const home = this.homePath("claude", acct.id);
      await assertOwnedAccountHome(this.opts.accountsDir, "claude", acct.id, home);
      const credsPath = join(home, ".credentials.json");
      let creds: any;
      try {
        creds = JSON.parse(await fsReadFile(credsPath, "utf8"));
      } catch {
        continue;
      }
      const refreshToken = creds?.claudeAiOauth?.refreshToken;
      if (typeof refreshToken !== "string") continue;
      const out = await refreshClaudeToken(refreshToken);
      if (out.ok) {
        await writeFile(credsPath, JSON.stringify(mergeClaudeRefreshedCreds(creds, out)), { mode: 0o600 });
        if (acct.needsReauth) await this.markNeedsReauth(acct.id, false);
      } else if (out.invalidGrant) {
        await this.markNeedsReauth(acct.id, true);
      }
    }
  }
```

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm check
git add apps/daemon/src/agent-account-refresh.ts apps/daemon/src/agent-account-refresh.test.ts apps/daemon/src/agent-accounts.ts
git commit -m "$(cat <<'EOF'
feat(daemon): idle-account OAuth refresher (Claude), invalid_grant flagging

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Session env wiring — accountId, unset in the launch wrapper, liveAccountIds

**Files:**
- Modify: `apps/daemon/src/sessions.ts`
- Test: `apps/daemon/src/session-launch-env.test.ts`

**Interfaces:**
- Consumes: `CreateSessionRequest.accountId` / `SessionSummary.accountId` (Task 2).
- Produces (used by Task 9):
  - `SessionManagerOptions.resolveExtraEnv?: (entry: RegistryEntry, accountId?: string) => Promise<{ env: Record<string, string>; unset?: string[] } | null>` (widened signature + return type)
  - `SessionManager.liveAccountIds(): Set<string>` — set of `accountId`s across running sessions.
  - `writeAddonEnvLaunchScript(launch, env, unset?)` emits `unset KEY` lines.

- [ ] **Step 1: Write a failing test for the wrapper's unset behavior**

`writeAddonEnvLaunchScript` is module-private; export a thin test seam. At the top-level of `apps/daemon/src/sessions.ts`, add `export` to the function declaration (change `async function writeAddonEnvLaunchScript` → `export async function writeAddonEnvLaunchScript`).

Create `apps/daemon/src/session-launch-env.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { writeAddonEnvLaunchScript } from "./sessions.ts";

test("wrapper exports env and unsets requested keys", async () => {
  const w = await writeAddonEnvLaunchScript({ bin: "claude", args: ["--foo"] }, { CLAUDE_CONFIG_DIR: "/x/home" }, ["ANTHROPIC_API_KEY"]);
  const script = await readFile(w.args[0], "utf8");
  assert.match(script, /export CLAUDE_CONFIG_DIR='\/x\/home'/);
  assert.match(script, /unset ANTHROPIC_API_KEY/);
  assert.match(script, /exec 'claude' '--foo'/);
  await w.cleanup();
});

test("wrapper still returns a script when only unsets are present (no env)", async () => {
  const w = await writeAddonEnvLaunchScript({ bin: "claude", args: [] }, {}, ["ANTHROPIC_API_KEY"]);
  assert.notEqual(w.bin, "claude"); // wrapped through a shell, not the bare bin
  const script = await readFile(w.args[0], "utf8");
  assert.match(script, /unset ANTHROPIC_API_KEY/);
  await w.cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/session-launch-env.test.ts`
Expected: FAIL — `writeAddonEnvLaunchScript` isn't exported / doesn't accept `unset`.

- [ ] **Step 3: Widen the wrapper**

In `apps/daemon/src/sessions.ts`, change `writeAddonEnvLaunchScript`'s signature and body:

```ts
export async function writeAddonEnvLaunchScript(
  launch: { bin: string; args: string[] },
  env: Record<string, string>,
  unset: string[] = []
): Promise<{ bin: string; args: string[]; cleanup: () => Promise<void> }> {
  const entries = Object.entries(env).filter(
    ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.includes("\0")
  );
  const unsets = unset.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  if (entries.length === 0 && unsets.length === 0) {
    return { ...launch, cleanup: async () => undefined };
  }

  const shell = sessionCommandShell();
  if (!shell) {
    throw new SessionError("No usable shell found to prepare addon launch environment.");
  }

  const dir = await mkdtemp(join(tmpdir(), "orquester-launch-"));
  const script = join(dir, "launch.sh");
  const exports = entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  const unsetLines = unsets.map((key) => `unset ${key}`);
  const command = [shellQuote(launch.bin), ...launch.args.map(shellQuote)].join(" ");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      "script_dir=${0%/*}",
      'rm -f -- "$0"',
      'rmdir "$script_dir" 2>/dev/null || true',
      ...unsetLines,
      ...exports,
      `exec ${command}`,
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );
  return {
    bin: shell,
    args: [script],
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/daemon/`): `node --import tsx --test src/session-launch-env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Thread accountId + the new return shape through `create`**

In `apps/daemon/src/sessions.ts`:

Update the options type (find the interface with `resolveExtraEnv`) to:

```ts
  resolveExtraEnv?: (
    entry: RegistryEntry,
    accountId?: string
  ) => Promise<{ env: Record<string, string>; unset?: string[] } | null>;
```

In `create`, replace the `addonEnv` block and marker/summary/wrapper lines:

```ts
    let extraEnv: Record<string, string> = {};
    let unsetEnv: string[] = [];
    try {
      const resolved = await this.options.resolveExtraEnv?.(entry, req.accountId);
      if (resolved) {
        extraEnv = resolved.env;
        unsetEnv = resolved.unset ?? [];
      }
    } catch (error) {
      throw error instanceof SessionError
        ? error
        : new SessionError(error instanceof Error ? error.message : String(error));
    }
```

Add `accountId: req.accountId,` to the `summary` object literal (right after `refId: entry.id,`).

Change the wrapper call:

```ts
    const wrapped = await writeAddonEnvLaunchScript(baseLaunch, extraEnv, unsetEnv);
```

- [ ] **Step 6: Add `liveAccountIds`**

Add this method to the `SessionManager` class (near other public accessors):

```ts
  liveAccountIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.summary.status === "running" && s.summary.accountId) ids.add(s.summary.accountId);
    }
    return ids;
  }
```

(If a `LocalSessionManager` variant also implements the manager interface, add the same method there iterating its own session map; keep signatures identical.)

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm check
git add apps/daemon/src/sessions.ts apps/daemon/src/session-launch-env.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): per-session account env (accountId, config-dir, auth unset)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Account routes + broadcast + service wiring + start refresher

**Files:**
- Modify: `apps/daemon/src/index.ts`

**Interfaces:**
- Consumes: `AgentAccountsService` (Tasks 6-7); `agentAccountsFile`, `agentAccountsDir` (Task 1); `AgentAccountError` (Task 4); the widened `resolveExtraEnv` (Task 8); `sessions.liveAccountIds()` (Task 8); `AgentAccountsResponse`, `ImportAgentAccountRequest`, `SetAgentAccountDefaultsRequest` (Task 2).
- Produces (used by Task 15): HTTP routes `GET/POST/DELETE /api/agent-accounts`, `PUT /api/agent-accounts/defaults`; broadcast channel `agent-accounts`, event `agent-accounts.changed`.

> **Note:** the TeamClaude `resolveExtraEnv` branch is *replaced* here (not additively). Task 10 removes the remaining TeamClaude references; this task only rewires the launch-env hook and adds account plumbing. After this task `pnpm check` may still reference TeamClaude symbols elsewhere — keep them compiling until Task 10.

- [ ] **Step 1: Construct the service + rewire the launch-env hook**

In `apps/daemon/src/index.ts`, add imports:

```ts
import { AgentAccountsService } from "./agent-accounts.ts";
import { agentAccountsFile, agentAccountsDir } from "@orquester/config";
import { AgentAccountError } from "./agent-account-paths.ts";
import type { ImportAgentAccountRequest, SetAgentAccountDefaultsRequest } from "@orquester/api";
```

After `const registry = new RegistryService(...)` and before `const sessions = createSessionManager(...)`, add:

```ts
  const agentAccounts = new AgentAccountsService({
    indexFile: agentAccountsFile(paths.baseDir),
    accountsDir: agentAccountsDir(paths.baseDir),
    now: () => Date.now(),
    logger: console
  });
```

Replace the `resolveExtraEnv` option passed to `createSessionManager` (currently the TeamClaude branch) with:

```ts
    resolveExtraEnv: async (entry, accountId) => {
      if (entry.kind !== "agent") return null;
      try {
        return await agentAccounts.resolveLaunchEnv(entry.id, accountId);
      } catch (error) {
        throw new SessionError(error instanceof Error ? error.message : String(error));
      }
    }
```

- [ ] **Step 2: Broadcast + init + start refresher**

Near the other `*.events.on("changed", ...)` broadcast lines, add:

```ts
  agentAccounts.events.on("changed", (payload) => broadcaster.publish("agent-accounts", "agent-accounts.changed", payload));
```

In the boot sequence, after `await sessions.reattach()` (so live sessions are known), add:

```ts
  await agentAccounts.init();
  agentAccounts.startRefresher(() => sessions.liveAccountIds());
```

Add `agentAccounts.stopRefresher();` to the daemon `stop()` path (beside the other service teardown).

Add `agentAccounts` to the `Services` object and the destructure (mirroring how `usage`/`registry` are threaded).

- [ ] **Step 3: Add the routes**

Near the other `/api/...` route registrations, add:

```ts
  app.get("/api/agent-accounts", async () => agentAccounts.list());

  app.post("/api/agent-accounts", async (request, reply) => {
    const body = (request.body ?? {}) as ImportAgentAccountRequest;
    try {
      return await agentAccounts.importAccount(body);
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/agent-accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await agentAccounts.removeAccount(id);
      return { ok: true };
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.put("/api/agent-accounts/defaults", async (request, reply) => {
    const body = (request.body ?? {}) as SetAgentAccountDefaultsRequest;
    try {
      return await agentAccounts.setDefaults(body);
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS (TeamClaude symbols may still be present; they're removed in Task 10 — the launch-env hook no longer calls TeamClaude, but its construction/routes still compile).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): agent-account routes, broadcast, refresher wiring

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Remove TeamClaude

**Files:**
- Delete: `apps/daemon/src/teamclaude.ts`, `apps/daemon/src/teamclaude.check.ts`, `packages/ui/src/components/settings/AddonsSettings.tsx`
- Modify: `apps/daemon/src/index.ts`, `packages/config/src/index.ts`, `packages/api/src/index.ts`, `packages/ui/src/lib/api-client.ts`, `packages/ui/src/store/app.ts`, `packages/ui/src/components/settings/SettingsModal.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: no TeamClaude symbols anywhere; `pnpm check` clean.

- [ ] **Step 1: Delete the daemon service + its usage overlay**

```bash
git rm apps/daemon/src/teamclaude.ts apps/daemon/src/teamclaude.check.ts
```

In `apps/daemon/src/index.ts` remove: the `TeamClaudeError`/`TeamClaudeService` import; `teamclaudeConfigPath` import; the `const teamclaude = new TeamClaudeService(...)` construction; both `teamclaude.events.on(...)` broadcasts; `teamclaude.init()` and `teamclaude.stop()`; the `teamclaude` field in `Services` and its destructure; the `/api/addons`, `/api/addons/:id/install`, `/api/addons/:id/update`, `GET`/`PUT /api/addons/teamclaude` routes.

Replace the Claude usage wiring so it no longer overlays TeamClaude — find `enrichClaudeWithTeamClaude` (its definition and the call inside the `UsageService` `fetchClaude`) and simplify to:

```ts
  const baseClaude = createClaudeSource({ userhome: resolved.vars.userhome, now: () => Date.now(), logger: console });
  const usage = new UsageService({
    fetchClaude: baseClaude,
    readCodex: createCodexSource({ userhome: resolved.vars.userhome, now: () => Date.now() }),
    getPrefs: () => readUsagePrefs(resolved.appConfigFile),
    now: () => Date.now()
  });
```

Delete the `enrichClaudeWithTeamClaude` function definition entirely.

- [ ] **Step 2: Prune config + api**

In `packages/config/src/index.ts` remove `teamclaudeConfigPath` and any TeamClaude schema/types.

In `packages/api/src/index.ts` remove `TeamClaudeStatus`, `TeamClaudeImportRequest`, `TeamClaudeSettings*`, `TeamClaudeAccount`, `AddonEntry`/addon types, and the `teamclaude.status`/`addon.changed` event-type references.

- [ ] **Step 3: Prune the UI**

```bash
git rm packages/ui/src/components/settings/AddonsSettings.tsx
```

In `packages/ui/src/lib/api-client.ts` remove `importTeamClaude`, `removeTeamClaudeAccount`, `toggleTeamClaudeAccount`, `installAddon`, `updateAddon`, `getAddons`, `getTeamClaude`, `updateTeamClaude` and their type imports.

In `packages/ui/src/store/app.ts` remove any TeamClaude/addon state, `applyEvent` branches for `channel === "addons"`, and related actions.

In `packages/ui/src/components/settings/SettingsModal.tsx` remove the Addons tab/section that renders `AddonsSettings` and its import.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS. If the typechecker names a leftover TeamClaude reference, delete it (there must be zero remaining).

Run: `rg -i "teamclaude|addonssettings" apps packages` — expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: remove the TeamClaude proxy addon (superseded by managed accounts)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Live Codex usage source (wham/usage) with log-scrape fallback

**Files:**
- Modify: `apps/daemon/src/usage-parse.ts` (add `parseCodexWhamUsage`)
- Modify: `apps/daemon/src/usage-sources.ts` (`createCodexSource` rewrite)
- Test: `apps/daemon/src/usage-codex-wham.test.ts`

**Interfaces:**
- Consumes: `AgentUsage`, `UsageWindow` (`@orquester/api`); existing `findLastCodexTokenCount`, `parseCodexUsage` (for the fallback).
- Produces (used by Task 14):
  - `parseCodexWhamUsage(json: unknown, now: number): AgentUsage` — maps `plan_type`, `rate_limit.primary_window`→session/300m, `secondary_window`→weekly/10080m from `used_percent`/`reset_at`(unix seconds ×1000).
  - `createCodexSource(opts: { userhome: string; now: () => number; codexHome?: string; fetchImpl?: typeof fetch; logger?: Pick<Console,"warn"> })` tries the endpoint, falls back to the log scrape.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/usage-codex-wham.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexWhamUsage } from "./usage-parse.ts";

const NOW = Date.parse("2026-07-07T08:00:00Z");
const resetSec = Math.floor(Date.parse("2026-07-07T10:00:00Z") / 1000);

test("maps plan_type and primary/secondary windows", () => {
  const a = parseCodexWhamUsage(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: resetSec, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 44, reset_at: resetSec, limit_window_seconds: 604800 }
      }
    },
    NOW
  );
  assert.equal(a.id, "codex");
  assert.equal(a.available, true);
  assert.equal(a.plan, "Pro");
  assert.equal(a.session?.percent, 12);
  assert.equal(a.weekly?.percent, 44);
  assert.equal(a.session?.resetsAt, new Date(resetSec * 1000).toISOString());
});

test("unparseable payload → available:false", () => {
  const a = parseCodexWhamUsage({ nope: true }, NOW);
  assert.equal(a.available, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/usage-codex-wham.test.ts`
Expected: FAIL — `parseCodexWhamUsage` not exported.

- [ ] **Step 3: Implement the parser**

In `apps/daemon/src/usage-parse.ts` add:

```ts
import type { AgentUsage, UsageWindow } from "@orquester/api";

function whamWindow(w: unknown, now: number): UsageWindow | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const pct = typeof o.used_percent === "number" ? o.used_percent : null;
  if (pct === null) return null;
  const resetSec = typeof o.reset_at === "number" ? o.reset_at : null;
  const win: UsageWindow = { percent: Math.max(0, Math.min(100, pct)) };
  if (resetSec !== null && resetSec * 1000 > now - 86_400_000) win.resetsAt = new Date(resetSec * 1000).toISOString();
  return win;
}

function titleCasePlan(plan: unknown): string | undefined {
  if (typeof plan !== "string" || !plan) return undefined;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function parseCodexWhamUsage(json: unknown, now: number): AgentUsage {
  const root = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const rl = typeof root.rate_limit === "object" && root.rate_limit !== null ? (root.rate_limit as Record<string, unknown>) : {};
  const session = whamWindow(rl.primary_window, now);
  const weekly = whamWindow(rl.secondary_window, now);
  const available = session !== null || weekly !== null;
  return {
    id: "codex",
    available,
    stale: false,
    plan: titleCasePlan(root.plan_type),
    session,
    weekly,
    asOf: available ? new Date(now).toISOString() : undefined
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/daemon/`): `node --import tsx --test src/usage-codex-wham.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewrite `createCodexSource` to try the endpoint, then fall back**

In `apps/daemon/src/usage-sources.ts`, replace the body of `createCodexSource` with an endpoint-first implementation that keeps the existing log-scrape as fallback. Add near the top:

```ts
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
```

New `createCodexSource`:

```ts
export function createCodexSource(opts: {
  userhome: string;
  now: () => number;
  codexHome?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const codexHome = opts.codexHome || process.env.CODEX_HOME || join(opts.userhome, ".codex");
  const authFile = join(codexHome, "auth.json");
  let lastGood: AgentUsage | null = null;
  let backoffUntil = 0;
  const scrapeFallback = createCodexLogScrapeSource({ codexHome, now: opts.now }); // existing scrape, extracted

  return async () => {
    let tokens: { access_token?: string; account_id?: string } | undefined;
    try {
      tokens = JSON.parse(await readFile(authFile, "utf8"))?.tokens;
    } catch {
      return null; // not logged in
    }
    if (!tokens?.access_token) return null;

    const signedIn = (): AgentUsage => lastGood ? { ...lastGood, stale: true } : { id: "codex", available: true, stale: true, session: null, weekly: null };
    const now = opts.now();
    if (now < backoffUntil) return (await scrapeFallback()) ?? signedIn();

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokens.access_token}`,
        "User-Agent": "codex-cli",
        "OpenAI-Beta": "codex-1",
        originator: "Codex Desktop",
        Accept: "application/json"
      };
      if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
      const res = await doFetch(CODEX_USAGE_URL, { headers });
      if (res.status === 429) {
        backoffUntil = now + retryAfterMs(res, 5 * 60_000);
        opts.logger?.warn?.("usage: codex usage endpoint rate-limited (429); backing off");
        return (await scrapeFallback()) ?? signedIn();
      }
      if (!res.ok) {
        backoffUntil = now + 60_000;
        return (await scrapeFallback()) ?? signedIn();
      }
      const agent = parseCodexWhamUsage(await res.json(), now);
      if (agent.available) {
        lastGood = agent;
        return lastGood;
      }
      return (await scrapeFallback()) ?? signedIn();
    } catch (err) {
      opts.logger?.warn?.(`usage: codex fetch failed: ${String(err)}`);
      backoffUntil = now + 60_000;
      return (await scrapeFallback()) ?? signedIn();
    }
  };
}
```

Extract the current log-scrape logic into `createCodexLogScrapeSource({ codexHome, now })` (move the existing `findLastCodexTokenCount`-based body verbatim into that helper, taking `codexHome` instead of recomputing from `userhome`). Import `parseCodexWhamUsage` from `./usage-parse.ts`.

- [ ] **Step 6: Run the existing Codex usage checks + typecheck**

Run (from `apps/daemon/`): `node --import tsx --test src/usage-codex-wham.test.ts` (PASS) and `node --import tsx src/usage-sources.check.ts` (the existing runtime check — expect `OK`).
Run: `pnpm check`

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/usage-parse.ts apps/daemon/src/usage-sources.ts apps/daemon/src/usage-codex-wham.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): live Codex wham/usage source with log-scrape fallback

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Registry-driven usage labels (UI)

**Files:**
- Modify: `packages/ui/src/components/topbar/UsageWidget.tsx`
- Test: `packages/ui/src/components/topbar/usage-format.check.ts` (extend if a label helper is added there) — optional

**Interfaces:**
- Consumes: `AgentUsage.id: string` (Task 2); the shared `REGISTRY` from `@orquester/registry` for labels.
- Produces (used by Task 17): a `labelForAgent(id: string): string` helper resolving the registry entry's `name`, falling back to a title-cased id.

- [ ] **Step 1: Replace the hardcoded label map**

In `packages/ui/src/components/topbar/UsageWidget.tsx`, remove the `AGENT_LABEL` constant (the `{ claude: "Claude", codex: "Codex" }` map) and add:

```tsx
import { REGISTRY } from "@orquester/registry";

function labelForAgent(id: string): string {
  const entry = REGISTRY.agents?.find((a) => a.id === id);
  if (entry) return entry.name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
```

Replace every `AGENT_LABEL[agent.id]` read with `labelForAgent(agent.id)`.

- [ ] **Step 2: Make the present/missing lists dynamic**

Find the hardcoded `["claude", "codex"]` arrays (the "which agents to show as available/missing" logic). Replace the "present" set with `usage.agents.map((a) => a.id)` and derive "missing" from the enabled agent ids in prefs (`Object.entries(appConfig.usage.agents).filter(([, on]) => on).map(([id]) => id)`) minus present. Keep the existing rendering; only the source of the id list changes.

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit + note manual drive**

```bash
git add packages/ui/src/components/topbar/UsageWidget.tsx
git commit -m "$(cat <<'EOF'
feat(ui): registry-driven usage widget labels (no hardcoded agent map)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Manual drive (next app run):** open the usage widget with Claude + Codex logged in; confirm both labels render from the registry and no console errors.

---

### Task 13: Token/cost scanner + price table + route

**Files:**
- Create: `apps/daemon/src/usage-tokens.ts`
- Test: `apps/daemon/src/usage-tokens.test.ts`
- Modify: `packages/config/src/index.ts` (add `usageTokensCacheFile(baseDir)`)
- Modify: `apps/daemon/src/index.ts` (add `GET /api/usage/tokens` + construct scanner + fs-watch nudge)
- Modify: `packages/api/src/index.ts` (`UsageTokensResponse` type)

**Interfaces:**
- Consumes: `daemonConfigDir` (config); fs watcher already in `index.ts`.
- Produces (used by Task 17):
  - `packages/api`: `interface UsageTokenRow { agent: string; model: string; day: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; costSource: "api_equivalent" }` and `interface UsageTokensResponse { rows: UsageTokenRow[]; asOf: string }`
  - `class UsageTokensScanner` with `constructor(opts: { userhome: string; cacheFile: string; now: () => number })`, `snapshot(force?: boolean): Promise<UsageTokensResponse>`, `recompute(): Promise<void>`
  - `function estimateCostUsd(agent: string, model: string, tok: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null`
  - `const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/usage-tokens.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, aggregateRows } from "./usage-tokens.ts";

test("estimateCostUsd multiplies by the per-million price table", () => {
  // claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 per 1M
  const cost = estimateCostUsd("claude", "claude-opus-4-8", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 30);
});

test("unknown model yields null cost", () => {
  assert.equal(estimateCostUsd("claude", "made-up-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test("aggregateRows groups by agent/model/day and sums tokens", () => {
  const rows = aggregateRows([
    { agent: "claude", model: "claude-opus-4-8", day: "2026-07-07", input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
    { agent: "claude", model: "claude-opus-4-8", day: "2026-07-07", input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 15);
  assert.equal(rows[0].outputTokens, 5);
  assert.equal(rows[0].costSource, "api_equivalent");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/usage-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scanner core (pricing + aggregation first)**

Create `apps/daemon/src/usage-tokens.ts`:

```ts
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { UsageTokenRow, UsageTokensResponse } from "@orquester/api";

// USD per 1,000,000 tokens. Update when models ship. Subscription users don't
// pay per token — this is an "API-equivalent" estimate, labeled as such.
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5.4-codex": { input: 1.25, output: 10, cacheRead: 0.125 }
};

export function estimateCostUsd(
  _agent: string,
  model: string,
  tok: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const per = (n: number, price: number | undefined) => (price ? (n / 1_000_000) * price : 0);
  return per(tok.input, p.input) + per(tok.output, p.output) + per(tok.cacheRead, p.cacheRead) + per(tok.cacheWrite, p.cacheWrite);
}

interface RawRow {
  agent: string;
  model: string;
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function aggregateRows(raw: RawRow[]): UsageTokenRow[] {
  const byKey = new Map<string, UsageTokenRow>();
  for (const r of raw) {
    const key = `${r.agent}|${r.model}|${r.day}`;
    const cur =
      byKey.get(key) ??
      { agent: r.agent, model: r.model, day: r.day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costSource: "api_equivalent" as const };
    cur.inputTokens += r.input;
    cur.outputTokens += r.output;
    cur.cacheReadTokens += r.cacheRead;
    cur.cacheWriteTokens += r.cacheWrite;
    byKey.set(key, cur);
  }
  for (const row of byKey.values()) {
    row.costUsd = estimateCostUsd(row.agent, row.model, {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens
    });
  }
  return [...byKey.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.model.localeCompare(b.model)));
}
```

- [ ] **Step 4: Run test to verify pricing/aggregation pass**

Run (from `apps/daemon/`): `node --import tsx --test src/usage-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the API type**

In `packages/api/src/index.ts`:

```ts
export interface UsageTokenRow {
  agent: string;
  model: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costSource: "api_equivalent";
}
export interface UsageTokensResponse {
  rows: UsageTokenRow[];
  asOf: string;
}
```

- [ ] **Step 6: Add the scanner class (Claude JSONL + Codex sessions) + cache**

Append to `apps/daemon/src/usage-tokens.ts`:

```ts
async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await rec(dir);
  return out;
}

function dayOf(iso: string | undefined, fallbackMs: number): string {
  const d = iso ? new Date(iso) : new Date(fallbackMs);
  return Number.isNaN(d.getTime()) ? new Date(fallbackMs).toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

export class UsageTokensScanner {
  private cache: UsageTokensResponse = { rows: [], asOf: new Date(0).toISOString() };

  constructor(private readonly opts: { userhome: string; cacheFile: string; now: () => number }) {}

  async init(): Promise<void> {
    try {
      this.cache = JSON.parse(await readFile(this.opts.cacheFile, "utf8"));
    } catch {
      /* first run */
    }
  }

  async snapshot(force = false): Promise<UsageTokensResponse> {
    if (force) await this.recompute();
    return this.cache;
  }

  async recompute(): Promise<void> {
    const raw: RawRow[] = [];
    await this.scanClaude(raw);
    await this.scanCodex(raw);
    this.cache = { rows: aggregateRows(raw), asOf: new Date(this.opts.now()).toISOString() };
    await mkdir(dirname(this.opts.cacheFile), { recursive: true });
    await writeFile(this.opts.cacheFile, JSON.stringify(this.cache), { mode: 0o600 });
  }

  private async scanClaude(raw: RawRow[]): Promise<void> {
    const dir = join(process.env.CLAUDE_CONFIG_DIR || join(this.opts.userhome, ".claude"), "projects");
    for (const file of await walkJsonl(dir)) {
      let mtimeMs = this.opts.now();
      try {
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        /* ignore */
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const u = obj?.message?.usage;
        if (!u) continue;
        raw.push({
          agent: "claude",
          model: obj?.message?.model ?? "unknown",
          day: dayOf(obj?.timestamp, mtimeMs),
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0
        });
      }
    }
  }

  private async scanCodex(raw: RawRow[]): Promise<void> {
    const dir = join(process.env.CODEX_HOME || join(this.opts.userhome, ".codex"), "sessions");
    for (const file of await walkJsonl(dir)) {
      let mtimeMs = this.opts.now();
      try {
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        /* ignore */
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      let prevTotal = 0;
      let model = "unknown";
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof obj?.model === "string") model = obj.model;
        const tc = obj?.payload?.token_count ?? obj?.token_count;
        if (!tc) continue;
        const total = tc.total_tokens ?? 0;
        const delta = Math.max(0, total - prevTotal);
        prevTotal = total;
        if (delta === 0) continue;
        raw.push({
          agent: "codex",
          model,
          day: dayOf(obj?.timestamp, mtimeMs),
          input: tc.input_tokens ?? 0,
          output: tc.output_tokens ?? 0,
          cacheRead: tc.cached_input_tokens ?? tc.cache_read_input_tokens ?? 0,
          cacheWrite: 0
        });
      }
    }
  }
}
```

- [ ] **Step 7: Add cache-path helper + route + fs-watch nudge**

In `packages/config/src/index.ts`:

```ts
export function usageTokensCacheFile(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "usage-tokens.json");
}
```

In `apps/daemon/src/index.ts`, construct the scanner near the usage service:

```ts
  const usageTokens = new UsageTokensScanner({
    userhome: resolved.vars.userhome,
    cacheFile: usageTokensCacheFile(paths.baseDir),
    now: () => Date.now()
  });
  await usageTokens.init();
```

Add to the existing `~/.claude` / `~/.codex` fs-watch `nudge` (the debounced block near line 262) a second recompute:

```ts
      debounce = setTimeout(() => {
        void usage.recompute();
        void usageTokens.recompute();
      }, 500);
```

Add the route:

```ts
  app.get("/api/usage/tokens", async (request) => {
    const force = (request.query as { refresh?: string })?.refresh === "1";
    return usageTokens.snapshot(force);
  });
```

Import `UsageTokensScanner` and `usageTokensCacheFile`.

- [ ] **Step 8: Typecheck + tests + commit**

```bash
pnpm check
cd apps/daemon && node --import tsx --test src/usage-tokens.test.ts && cd ../..
git add apps/daemon/src/usage-tokens.ts apps/daemon/src/usage-tokens.test.ts packages/config/src/index.ts packages/api/src/index.ts apps/daemon/src/index.ts
git commit -m "$(cat <<'EOF'
feat(daemon): token/cost scanner (Claude JSONL + Codex sessions) + route

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Per-account usage entries

**Files:**
- Modify: `apps/daemon/src/index.ts` (compose per-account Claude/Codex sources)
- Modify: `apps/daemon/src/usage-sources.ts` (accept a per-account home for Claude, mirroring the Codex `codexHome` param)

**Interfaces:**
- Consumes: `AgentAccountsService.list()` / `homePath()` (Tasks 6-7); `createClaudeSource`/`createCodexSource` with per-home params; `UsageAccount` (existing in `@orquester/api`); usage `view` pref.
- Produces: `fetchClaude`/`readCodex` that, when `view === "accounts"`, attach `AgentUsage.accounts: UsageAccount[]` (one per managed account) and set `aggregate`.

- [ ] **Step 1: Add a per-home param to the Claude source**

In `apps/daemon/src/usage-sources.ts`, change `createClaudeSource`'s options to accept an optional `claudeHome?: string` and use it:

```ts
export function createClaudeSource(opts: {
  userhome: string;
  now: () => number;
  claudeHome?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const claudeHome = opts.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(opts.userhome, ".claude");
  const credsFile = join(claudeHome, ".credentials.json");
  // ...rest unchanged...
```

- [ ] **Step 2: Compose per-account sources in the daemon**

In `apps/daemon/src/index.ts`, replace the flat `fetchClaude`/`readCodex` deps with helpers that read the `view` pref and fan out over accounts. Add:

```ts
  const claudeAccountSource = (home?: string) => createClaudeSource({ userhome: resolved.vars.userhome, now: () => Date.now(), claudeHome: home, logger: console });
  const codexAccountSource = (home?: string) => createCodexSource({ userhome: resolved.vars.userhome, now: () => Date.now(), codexHome: home, logger: console });

  async function agentWithAccounts(
    agent: "claude" | "codex",
    makeSource: (home?: string) => () => Promise<AgentUsage | null>
  ): Promise<AgentUsage | null> {
    const prefs = await readUsagePrefs(resolved.appConfigFile);
    const base = await makeSource()(); // System account
    if (prefs.view !== "accounts") return base;
    const managed = agentAccounts.list().accounts.filter((a) => a.agent === agent);
    if (managed.length === 0) return base;
    const accounts: UsageAccount[] = [];
    for (const acct of managed) {
      const u = await makeSource(agentAccounts.homePath(agent, acct.id))().catch(() => null);
      accounts.push({
        id: acct.id,
        label: acct.label,
        available: u?.available ?? false,
        stale: u?.stale ?? true,
        plan: u?.plan,
        session: u?.session ?? null,
        weekly: u?.weekly ?? null,
        asOf: u?.asOf
      });
    }
    const head = base ?? { id: agent, available: accounts.some((a) => a.available), stale: true, session: null, weekly: null };
    return { ...head, accounts, aggregate: { strategy: "worst-account", accountCount: accounts.length } };
  }
```

Wire the usage service deps to these:

```ts
  const usage = new UsageService({
    fetchClaude: () => agentWithAccounts("claude", claudeAccountSource),
    readCodex: () => agentWithAccounts("codex", codexAccountSource),
    getPrefs: () => readUsagePrefs(resolved.appConfigFile),
    now: () => Date.now()
  });
```

Import `UsageAccount` from `@orquester/api`.

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit + note manual drive**

```bash
git add apps/daemon/src/index.ts apps/daemon/src/usage-sources.ts
git commit -m "$(cat <<'EOF'
feat(daemon): per-managed-account usage entries (view=accounts)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Manual drive (next app run):** with 2 Claude accounts imported and usage `view` = accounts, confirm the widget shows one row per account; with `view` = aggregate, confirm a single row.

---

### Task 15: Agent Accounts settings pane + api-client + store channel

**Files:**
- Create: `packages/ui/src/components/settings/AgentAccountsSettings.tsx`
- Modify: `packages/ui/src/lib/api-client.ts`
- Modify: `packages/ui/src/store/app.ts`
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx`

**Interfaces:**
- Consumes: account routes (Task 9); `AgentAccount`, `AgentAccountsResponse`, `ImportAgentAccountRequest`, `SetAgentAccountDefaultsRequest`, `AgentAccountsEventType` (Task 2).
- Produces (used by Task 16): store `agentAccounts: AgentAccountsResponse | null`, `loadAgentAccounts()`, and api-client methods.

- [ ] **Step 1: Add api-client methods**

In `packages/ui/src/lib/api-client.ts` (mirroring `getUsage`/`createSession`):

```ts
  getAgentAccounts(signal?: AbortSignal): Promise<AgentAccountsResponse> {
    return this.send("GET", "/api/agent-accounts", { signal });
  }
  importAgentAccount(req: ImportAgentAccountRequest): Promise<AgentAccount> {
    return this.send("POST", "/api/agent-accounts", { body: req });
  }
  removeAgentAccount(id: string): Promise<{ ok: true }> {
    return this.send("DELETE", `/api/agent-accounts/${encodeURIComponent(id)}`);
  }
  setAgentAccountDefaults(req: SetAgentAccountDefaultsRequest): Promise<AgentAccountsResponse> {
    return this.send("PUT", "/api/agent-accounts/defaults", { body: req });
  }
```

Add the type imports to the existing `@orquester/api` import.

- [ ] **Step 2: Add store state + event channel**

In `packages/ui/src/store/app.ts`:

- Add to state: `agentAccounts: AgentAccountsResponse | null` (init `null`).
- Add action:

```ts
  loadAgentAccounts: async () => {
    const api = get().api;
    if (!api) return;
    set({ agentAccounts: await api.getAgentAccounts() });
  },
```

- In `applyEvent`, add a branch:

```ts
    if (event.channel === "agent-accounts") {
      set({ agentAccounts: event.payload as AgentAccountsResponse });
      return;
    }
```

- Call `get().loadAgentAccounts()` in the same place initial data is loaded (beside `loadUsage()`).

- [ ] **Step 3: Build the settings pane**

Create `packages/ui/src/components/settings/AgentAccountsSettings.tsx` (reuse the drop-zone pattern from the old `AddonsSettings` accounts section — list + import + remove + default). Key structure:

```tsx
import React, { useCallback, useRef, useState } from "react";
import { Trash2, Upload, Star } from "lucide-react";
import type { AgentAccount, AgentAccountAgent } from "@orquester/api";
import { Button, Input } from "../ui";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";

export function AgentAccountsSettings() {
  const api = useApi();
  const accounts = useAppStore((s) => s.agentAccounts);
  const load = useAppStore((s) => s.loadAgentAccounts);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const importBlob = (content: string) => run(() => api!.importAgentAccount({ content, label: label.trim() || undefined }));

  const onPickFile = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    await importBlob(text);
    setLabel("");
  };

  const byAgent = (agent: AgentAccountAgent) => (accounts?.accounts ?? []).filter((a) => a.agent === agent);
  const isDefault = (a: AgentAccount) => accounts?.defaults[a.agent] === a.id;

  return (
    <div className="space-y-6">
      {err ? <p className="text-xs text-red-400">{err}</p> : null}
      {(["claude", "codex"] as const).map((agent) => (
        <section key={agent} className="space-y-2">
          <h3 className="text-sm font-medium capitalize">{agent} accounts</h3>
          <div className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
            {byAgent(agent).length === 0 ? (
              <p className="px-2 py-2 text-xs text-neutral-600">No accounts. Import a credentials file below.</p>
            ) : (
              byAgent(agent).map((a) => (
                <div key={a.id} className="flex items-center gap-2 px-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{a.label}{a.needsReauth ? " · needs re-auth" : ""}</p>
                    <p className="text-[11px] text-neutral-500">{a.email ?? a.plan ?? a.agent}</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy || isDefault(a)}
                    onClick={() => void run(() => api!.setAgentAccountDefaults({ [agent]: a.id }))}>
                    <Star size={13} className={isDefault(a) ? "fill-current" : ""} />
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => { if (window.confirm(`Remove “${a.label}”?`)) void run(() => api!.removeAgentAccount(a.id)); }}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>
      ))}
      <div className="space-y-2">
        <p className="text-xs font-medium text-neutral-300">Import an account</p>
        <p className="text-[11px] text-neutral-600">
          Upload a Claude <code>.credentials.json</code> or Codex <code>auth.json</code>. Agent is auto-detected. Claude needs a label.
        </p>
        <Input placeholder="Label (required for Claude)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-neutral-700 px-3 py-6 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void onPickFile(e.dataTransfer.files?.[0]); }}>
          <Upload size={18} className="text-neutral-500" />
          <p className="text-xs text-neutral-400">Drag & drop, or</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>Choose file…</Button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onPickFile(f); }} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Register the pane in Settings**

In `packages/ui/src/components/settings/SettingsModal.tsx`, add an "Accounts" tab that renders `<AgentAccountsSettings />` (replacing the removed Addons tab slot). Import it and load accounts when the modal opens (call `loadAgentAccounts()` in the existing on-open effect).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm check
git add packages/ui/src/components/settings/AgentAccountsSettings.tsx packages/ui/src/lib/api-client.ts packages/ui/src/store/app.ts packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "$(cat <<'EOF'
feat(ui): Agent Accounts settings pane (import/remove/default) + live updates

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Manual drive (next app run):** open Settings → Accounts; import a Codex `auth.json` (auto-labels from email) and a Claude `.credentials.json` with a label; confirm both appear, set-default toggles, remove works, and a second client updates live via the `agent-accounts` event.

---

### Task 16: Launch-flow account picker + session tab badge

**Files:**
- Modify: `packages/ui/src/store/app.ts` (`openTab` action, ~line 1428)
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx` (agent launcher — calls `openTab("agent", agent.id, agent.name)`)
- Modify: `packages/ui/src/components/topbar/TabStrip.tsx` (renders each session tab's title)

**Interfaces:**
- Consumes: `store.agentAccounts` (Task 15) + `createSession({ ..., accountId })` (Tasks 2, 15); `SessionSummary.accountId` (Task 2).
- Produces: an `accountId` passed into `createSession`; a badge label resolved from `agentAccounts`.

- [ ] **Step 1: Thread accountId through the `openTab` store action**

In `packages/ui/src/store/app.ts`, change `openTab` (line ~1428) to accept an optional 4th arg and pass it through (update its type in the store interface too — search for `openTab:` in the `AppState`/actions type and add `accountId?: string`):

```ts
  openTab: async (kind, refId, title, accountId) => {
    const api = get().api;
    if (!api) return;
    const project = get().currentProject;
    const session = await api.createSession({
      kind,
      refId,
      title,
      projectPath: project?.path ?? "",
      cwd: project?.path,
      accountId
    });
    set((state) => ({
      sessions: upsertSession(state.sessions, session),
      activeTabByProject: project
        ? { ...state.activeTabByProject, [project.path]: session.id }
        : state.activeTabByProject
    }));
  },
```

- [ ] **Step 2: Add the account picker to `NewTabMenu.tsx`**

In `packages/ui/src/components/topbar/NewTabMenu.tsx`, read accounts from the store and, for each **agent** row whose id is `claude` or `codex` with ≥1 managed account, render a small inline `<select>` (System + managed accounts, defaulting to that agent's `defaults[agent]` or System). The agent row's launch handler passes the chosen id (or `undefined` for System) as the 4th `openTab` arg:

```tsx
const agentAccounts = useAppStore((s) => s.agentAccounts);
// per agent row:
const managed = (agentAccounts?.accounts ?? []).filter((a) => a.agent === agent.id);
const [picked, setPicked] = useState<string | undefined>(agentAccounts?.defaults[agent.id as "claude" | "codex"] ?? undefined);
// launch:
onClick={() => void openTab("agent", agent.id, agent.name, picked)}
// picker (only when managed.length > 0):
{managed.length > 0 ? (
  <select value={picked ?? ""} onChange={(e) => setPicked(e.target.value || undefined)}>
    <option value="">System</option>
    {managed.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
  </select>
) : null}
```

(Match the file's existing JSX/handler shape — the substance is: capture `picked` and pass it as the 4th `openTab` argument. `openTab` is already pulled from the store in this file.)

- [ ] **Step 3: Add the tab badge in `TabStrip.tsx`**

In `packages/ui/src/components/topbar/TabStrip.tsx`, where a session tab's title is rendered, resolve the account label and render a compact badge when `session.accountId` is set:

```tsx
const agentAccounts = useAppStore((s) => s.agentAccounts);
// within the session-tab render, near the title:
{tab.session.accountId
  ? (() => {
      const acct = agentAccounts?.accounts.find((a) => a.id === tab.session.accountId);
      return acct ? <span className="ml-1 rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">{acct.label}</span> : null;
    })()
  : null}
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm check
git add packages/ui/src/store/app.ts packages/ui/src/components/topbar/NewTabMenu.tsx packages/ui/src/components/topbar/TabStrip.tsx
git commit -m "$(cat <<'EOF'
feat(ui): per-session account picker + session tab account badge

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Manual drive (next app run):** launch two Claude sessions pinned to different accounts; confirm each tab shows the right badge and each `claude` resolves its own config dir.

---

### Task 17: Cost tab in the usage panel

**Files:**
- Modify: `packages/ui/src/components/topbar/UsageWidget.tsx`
- Modify: `packages/ui/src/lib/api-client.ts` (add `getUsageTokens`)
- Modify: `packages/ui/src/store/app.ts` (state + loader)

**Interfaces:**
- Consumes: `GET /api/usage/tokens` → `UsageTokensResponse` (Task 13); `labelForAgent` (Task 12).
- Produces: a "Cost" view in the expanded usage panel.

- [ ] **Step 1: api-client + store**

In `api-client.ts`:

```ts
  getUsageTokens(force?: boolean, signal?: AbortSignal): Promise<UsageTokensResponse> {
    return this.send("GET", `/api/usage/tokens${force ? "?refresh=1" : ""}`, { signal });
  }
```

In `store/app.ts`: add `usageTokens: UsageTokensResponse | null` (init null) and `loadUsageTokens: async (force?) => { const api = get().api; if (api) set({ usageTokens: await api.getUsageTokens(force) }); }`.

- [ ] **Step 2: Cost tab in the widget**

In `UsageWidget.tsx`'s expanded `AdaptiveMenu`, add a tab toggle `Windows | Cost`. When "Cost" is active, call `loadUsageTokens()` on first open and render `usageTokens.rows` grouped by agent (using `labelForAgent`), showing per-model/day token totals and `costUsd` (or "—" when null), with a caption: "API-equivalent estimate; subscription usage isn't billed per token." Keep the default tab = Windows.

```tsx
{tab === "cost" ? (
  <div className="max-h-64 overflow-auto text-xs">
    {(usageTokens?.rows ?? []).map((r) => (
      <div key={`${r.agent}-${r.model}-${r.day}`} className="flex justify-between gap-3 py-0.5">
        <span className="truncate">{labelForAgent(r.agent)} · {r.model} · {r.day}</span>
        <span className="tabular-nums text-neutral-400">
          {(r.inputTokens + r.outputTokens).toLocaleString()} tok · {r.costUsd == null ? "—" : `$${r.costUsd.toFixed(2)}`}
        </span>
      </div>
    ))}
    <p className="mt-2 text-[10px] text-neutral-600">API-equivalent estimate; subscription usage isn't billed per token.</p>
  </div>
) : null}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm check
git add packages/ui/src/components/topbar/UsageWidget.tsx packages/ui/src/lib/api-client.ts packages/ui/src/store/app.ts
git commit -m "$(cat <<'EOF'
feat(ui): Cost tab (token/cost aggregates) in the usage panel

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Manual drive (next app run):** open the usage panel → Cost; confirm rows render with token totals and per-model $ (or "—" for unknown models) and the estimate caption shows.

---

## Self-review — spec coverage

| Spec section | Task(s) |
|---|---|
| 1.1 Storage layout (index + per-account homes + marker) | 1, 6 |
| 1.2 Ownership assertion | 4 (used by 6, 7) |
| 1.3 Import capture (auto-detect, identity, label) | 5, 6, 9, 15 |
| 1.4 Per-session selection (accountId, env, unset, System default) | 2, 8, 9, 16 |
| 1.5 Background refresher (zero-live-session gate, Claude refresh, invalid_grant) | 7, 9 |
| 1.6 API + events (routes, `agent-accounts` channel) | 9, 15 |
| 1.7 UI (settings pane, launch picker, tab badge) | 15, 16 |
| F2 TeamClaude removal | 10 |
| F3.1 Codex wham/usage + fallback | 11 |
| F3.2 Open agent set (id, prefs record, registry labels) | 2, 3, 12 |
| F3.3 Token/cost aggregates + cache + route + Cost tab | 13, 17 |
| F3.4 Per-account usage | 14 |
| Data-flow (account-pinned session) | 8, 9 |
| Error handling (import 4xx, ownership abort, invalid_grant flag, endpoint fallback) | 6, 9, 7, 11 |

**Deferred vs. spec (call-outs for the implementer):**
- **Codex refresher:** Task 7 refreshes **Claude** idle tokens only. Codex idle refresh is left to its CLI (the spec's "fall back to a one-shot CLI refresh" is not implemented in v1 to avoid spawning per idle account); Codex accounts still work while used, and `needsReauth` is never set for Codex. If Codex idle-rot becomes real, add a Codex branch to `refreshIdleAccounts` that runs `codex` once with the account's `CODEX_HOME`.
- **`chip` pref** keeps its `busiest | claude | codex` enum (Task 3) — not generalized in v1, per spec.
- **Desktop `LocalSessionManager`** (non-tmux) must gain the identical `liveAccountIds()` method (Task 8, Step 6) so the interface stays uniform; env injection already flows through the shared `create`.
