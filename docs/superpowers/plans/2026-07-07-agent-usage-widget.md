# Agent Usage Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Claude Code + Codex subscription quota (5-hour session % and weekly %) as a top-bar chip + popover in Orquester, configurable in Settings, read-only and configure-once.

**Architecture:** A daemon-owned `UsageService` reads the real numbers on-host (Claude: poll `api.anthropic.com/api/oauth/usage` with the on-disk OAuth token; Codex: tail `~/.codex/sessions/**/rollout-*.jsonl`), caches them, and emits `usage.changed`. A read-only `GET /api/usage` route + the existing `/events` bus feed a `usage` slice in the zustand store, mirroring the `registry` slice. A `UsageWidget` renders the chip + popover; a Settings ▸ Usage pane holds the knobs (persisted in app config).

**Tech Stack:** TypeScript (ESM, strict, `noEmit`), tsx (daemon runs `.ts` directly), Fastify, zod, Node `EventEmitter`/`fetch`/`fs`, React 18, zustand, Tailwind (dark-only), lucide-react icons.

## Global Constraints

- **No test runner exists.** "Tests" are runnable check scripts executed with `node --import tsx <path>` using `node:assert/strict`, committed alongside the code. The pre-commit gate is `pnpm check` (runs `pnpm -r typecheck` = `tsc --noEmit`). Run it after every task.
- **Never start a daemon or browser in this checkout** (AGENTS.md — this repo is served by a live daemon). Verify with `pnpm check`, the check scripts, and code review. UI runtime behavior cannot be observed here; say so rather than claiming it works.
- **Commits go to the CURRENT branch as-is — do NOT create a branch** (AGENTS.md). Stage files by name; never `git add -A`.
- **Dark-only UI:** use literal `neutral-*` / `emerald-*` / `amber-*` / `red-*` Tailwind classes. No `dark:` variants, no CSS variables — none exist and Tailwind has no `darkMode` configured.
- **Secrets never cross the wire:** `GET /api/usage` returns only percentages, reset timestamps, plan labels, and `available`/`stale`/`updatedAt` — never tokens, transcript text, or file/project paths.
- **Home resolution:** build credential/log paths from `resolved.vars.userhome` (honors `$HOME`), `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`. Never hardcode `/home/<user>` or `/root`.
- **Packages import each other's TS source** (`@orquester/api`, `@orquester/config`) directly — no build step between them.
- Spec: `docs/superpowers/specs/2026-07-07-agent-usage-widget-design.md`.

---

### Task 1: Wire contracts (`@orquester/api`)

**Files:**
- Modify: `packages/api/src/index.ts` (add near `TodoEventType`, ~line 361)

**Interfaces:**
- Produces: `UsageWindow`, `AgentUsage`, `UsageResponse`, `UsageEventType` — consumed by every later task on both sides of the wire.

- [ ] **Step 1: Add the wire types**

In `packages/api/src/index.ts`, immediately after the `TodoEventType` declaration, add:

```ts
/** One quota window (0–100 % used) with its reset time (ISO 8601). */
export interface UsageWindow {
  percent: number;
  resetsAt?: string;
}

export interface AgentUsage {
  id: "claude" | "codex";
  /** installed + logged in + at least one window present. */
  available: boolean;
  /** data known but the token/log is expired/old (last-known shown greyed). */
  stale: boolean;
  /** e.g. "Max 20x", "Pro". */
  plan?: string;
  /** rolling 5-hour window. */
  session: UsageWindow | null;
  weekly: UsageWindow | null;
}

export interface UsageResponse {
  updatedAt: string;
  /** only logged-in agents; empty ⇒ the widget hides. */
  agents: AgentUsage[];
}

export type UsageEventType = "usage.changed";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS (no errors). The new exports are unused so far; that's fine.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): add usage wire contracts (UsageResponse/AgentUsage/UsageWindow)"
```

---

### Task 2: Usage preferences in app config (`@orquester/config`)

**Files:**
- Modify: `packages/config/src/index.ts` (add `usagePrefsSchema`/`UsagePrefs` before `appConfigSchema` at line 275; add `usage` field inside `appConfigSchema`)
- Test: `packages/config/src/usage-prefs.check.ts`

**Interfaces:**
- Produces: `usagePrefsSchema`, `UsagePrefs` (`{ enabled, claude, codex, chip }`), and an `AppConfig.usage` field with defaults.

- [ ] **Step 1: Write the failing check**

Create `packages/config/src/usage-prefs.check.ts`:

```ts
import assert from "node:assert/strict";
import { createDefaultAppConfig, parseAppConfig, usagePrefsSchema } from "./index";

// Defaults make the feature zero-config.
const def = createDefaultAppConfig();
assert.deepEqual(def.usage, { enabled: true, claude: true, codex: true, chip: "busiest" });

// The schema fills partial input.
assert.equal(usagePrefsSchema.parse({ enabled: false }).chip, "busiest");

// An old app.json without `usage` still parses (back-compat).
const migrated = parseAppConfig({ version: 1 });
assert.equal(migrated.usage.enabled, true);

// Invalid chip value is rejected.
assert.throws(() => usagePrefsSchema.parse({ chip: "nope" }));

console.log("usage-prefs.check OK");
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx packages/config/src/usage-prefs.check.ts`
Expected: FAIL — `usagePrefsSchema` is not exported / `def.usage` is undefined.

- [ ] **Step 3: Add the schema**

In `packages/config/src/index.ts`, directly above `export const appConfigSchema = z.object({` (line 275), add:

```ts
export const usagePrefsSchema = z.object({
  /** Master switch for the top-bar usage widget (also gates daemon polling). */
  enabled: z.boolean().default(true),
  claude: z.boolean().default(true),
  codex: z.boolean().default(true),
  /** Which agent drives the collapsed chip. */
  chip: z.enum(["busiest", "claude", "codex"]).default("busiest")
});

export type UsagePrefs = z.infer<typeof usagePrefsSchema>;
```

Then, inside `appConfigSchema`, add a `usage` field after the `runInBackground` line (line 282). The object becomes:

```ts
export const appConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** Connection opened on launch. "local" is always available. */
  activeConnectionId: z.string().min(1).default(LOCAL_CONNECTION_ID),
  /** Render the custom frameless titlebar with window controls. */
  useTitlebar: z.boolean().default(true),
  /** Desktop: keep the daemon running in a tray when the window is closed. */
  runInBackground: z.boolean().default(false),
  /** Top-bar agent-usage widget preferences. */
  usage: usagePrefsSchema.default({})
});
```

- [ ] **Step 4: Run the check to confirm it passes**

Run: `node --import tsx packages/config/src/usage-prefs.check.ts`
Expected: `usage-prefs.check OK`

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/index.ts packages/config/src/usage-prefs.check.ts
git commit -m "feat(config): add usage prefs to app config (enabled/claude/codex/chip)"
```

---

### Task 3: Pure usage parsers (daemon)

**Files:**
- Create: `apps/daemon/src/usage-parse.ts`
- Test: `apps/daemon/src/usage-parse.check.ts`

**Interfaces:**
- Consumes: `AgentUsage`, `UsageWindow` from `@orquester/api` (Task 1).
- Produces:
  - `parseClaudeUsage(body: unknown, creds: ClaudeCreds, now: number): AgentUsage`
  - `parseCodexUsage(rateLimits: unknown, now: number): AgentUsage`
  - `findLastCodexTokenCount(lines: string[]): unknown | null` (returns the last `token_count` event's `rate_limits`, or null)
  - `type ClaudeCreds = { subscriptionType?: string; rateLimitTier?: string }`

- [ ] **Step 1: Write the failing check**

Create `apps/daemon/src/usage-parse.check.ts`:

```ts
import assert from "node:assert/strict";
import { parseClaudeUsage, parseCodexUsage, findLastCodexTokenCount } from "./usage-parse";

const NOW = Date.parse("2026-07-07T08:00:00Z");
const future = "2026-07-07T10:00:00Z";
const futureSec = Math.floor(Date.parse(future) / 1000);
const pastSec = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);

// Claude legacy top-level shape (the shape verified live on-host: 45 / 69).
const claudeLegacy = parseClaudeUsage(
  { five_hour: { utilization: 45, resets_at: future }, seven_day: { utilization: 69, resets_at: future } },
  { subscriptionType: "max", rateLimitTier: "max_20x" },
  NOW
);
assert.equal(claudeLegacy.available, true);
assert.equal(claudeLegacy.session?.percent, 45);
assert.equal(claudeLegacy.weekly?.percent, 69);
assert.equal(claudeLegacy.plan, "Max 20x");
assert.equal(claudeLegacy.stale, false);

// Claude newer limits[] shape → same numbers.
const claudeLimits = parseClaudeUsage(
  { limits: [
    { kind: "session", percent: 45, resets_at: future },
    { kind: "weekly_all", percent: 69, resets_at: future }
  ] },
  { subscriptionType: "max", rateLimitTier: "max_20x" },
  NOW
);
assert.equal(claudeLimits.session?.percent, 45);
assert.equal(claudeLimits.weekly?.percent, 69);

// Leak bug #52326: a reset epoch bled into utilization → drop the window.
const leak = parseClaudeUsage({ five_hour: { utilization: 1783000000 }, seven_day: { utilization: 69 } }, {}, NOW);
assert.equal(leak.session, null);
assert.equal(leak.weekly?.percent, 69);

// Codex object with primary(5h)/secondary(weekly).
const codex = parseCodexUsage(
  { limit_id: "codex", plan_type: "pro",
    primary: { used_percent: 3, window_minutes: 300, resets_at: futureSec },
    secondary: { used_percent: 37, window_minutes: 10080, resets_at: futureSec } },
  NOW
);
assert.equal(codex.session?.percent, 3);
assert.equal(codex.weekly?.percent, 37);
assert.equal(codex.plan, "Pro");

// Codex stale window (resets_at already past) → nulled.
const codexStale = parseCodexUsage(
  { primary: { used_percent: 3, resets_at: futureSec }, secondary: { used_percent: 37, resets_at: pastSec } },
  NOW
);
assert.equal(codexStale.session?.percent, 3);
assert.equal(codexStale.weekly, null);

// findLastCodexTokenCount returns the LAST token_count's rate_limits.
const lines = [
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 1 } } } }),
  JSON.stringify({ type: "event_msg", payload: { type: "agent_message", text: "hi" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 9 } } } }),
  ""
];
const rl = findLastCodexTokenCount(lines) as any;
assert.equal(rl.primary.used_percent, 9);
assert.equal(findLastCodexTokenCount(["", "not json"]), null);

console.log("usage-parse.check OK");
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx apps/daemon/src/usage-parse.check.ts`
Expected: FAIL — module `./usage-parse` not found.

- [ ] **Step 3: Implement the parsers**

Create `apps/daemon/src/usage-parse.ts`:

```ts
import type { AgentUsage, UsageWindow } from "@orquester/api";

export type ClaudeCreds = { subscriptionType?: string; rateLimitTier?: string };

/** 0–100, or null when absent/garbage. Drops the leak-bug value (>101) and clamps 100–101→100. */
function clampPercent(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v > 101) return null;
  if (v >= 100) return 100;
  return v < 0 ? 0 : v;
}

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return v;
  return undefined;
}

function epochSecondsToIso(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return new Date(v * 1000).toISOString();
}

function claudePlanLabel(creds: ClaudeCreds): string | undefined {
  if (!creds.subscriptionType) return undefined;
  const base = creds.subscriptionType.charAt(0).toUpperCase() + creds.subscriptionType.slice(1);
  const m = /(\d+)\s*x/i.exec(creds.rateLimitTier ?? "");
  return m ? `${base} ${m[1]}x` : base;
}

function codexPlanLabel(planType: unknown): string | undefined {
  if (typeof planType !== "string" || !planType) return undefined;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

export function parseClaudeUsage(body: unknown, creds: ClaudeCreds, _now: number): AgentUsage {
  const b = (body ?? {}) as Record<string, any>;
  let session: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;

  if (b.five_hour || b.seven_day) {
    const s = clampPercent(b.five_hour?.utilization);
    if (s != null) session = { percent: s, resetsAt: isoOrUndefined(b.five_hour?.resets_at) };
    const w = clampPercent(b.seven_day?.utilization);
    if (w != null) weekly = { percent: w, resetsAt: isoOrUndefined(b.seven_day?.resets_at) };
  } else if (Array.isArray(b.limits)) {
    for (const lim of b.limits) {
      const p = clampPercent(lim?.percent);
      if (p == null) continue;
      const win = { percent: p, resetsAt: isoOrUndefined(lim?.resets_at) };
      if (lim?.kind === "session") session = win;
      else if (lim?.kind === "weekly_all") weekly = win;
    }
  }

  return {
    id: "claude",
    available: session != null || weekly != null,
    stale: false,
    plan: claudePlanLabel(creds),
    session,
    weekly
  };
}

function codexWindow(w: any, now: number): UsageWindow | null {
  if (!w) return null;
  const resetsAt = epochSecondsToIso(w.resets_at);
  if (resetsAt && Date.parse(resetsAt) < now) return null; // stale window
  const percent = clampPercent(w.used_percent);
  return percent == null ? null : { percent, resetsAt };
}

export function parseCodexUsage(rateLimits: unknown, now: number): AgentUsage {
  const rl = (rateLimits ?? {}) as Record<string, any>;
  const session = codexWindow(rl.primary, now);
  const weekly = codexWindow(rl.secondary, now);
  return {
    id: "codex",
    available: session != null || weekly != null,
    stale: false,
    plan: codexPlanLabel(rl.plan_type),
    session,
    weekly
  };
}

/** Scan rollout JSONL lines from the end for the last token_count event's rate_limits. */
export function findLastCodexTokenCount(lines: string[]): unknown | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "event_msg" && obj?.payload?.type === "token_count" && obj.payload.rate_limits) {
      return obj.payload.rate_limits;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the check to confirm it passes**

Run: `node --import tsx apps/daemon/src/usage-parse.check.ts`
Expected: `usage-parse.check OK`

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/usage-parse.ts apps/daemon/src/usage-parse.check.ts
git commit -m "feat(daemon): pure Claude/Codex usage parsers with guards"
```

---

### Task 4: `UsageService` (daemon logic, injected deps)

**Files:**
- Create: `apps/daemon/src/usage.ts`
- Test: `apps/daemon/src/usage.check.ts`

**Interfaces:**
- Consumes: `AgentUsage`, `UsageResponse` (Task 1); `UsagePrefs` (Task 2).
- Produces:
  - `interface UsageServiceDeps { fetchClaude: () => Promise<AgentUsage | null>; readCodex: () => Promise<AgentUsage | null>; getPrefs: () => Promise<UsagePrefs>; now: () => number; activeMs?: number; idleMs?: number }`
  - `class UsageService { readonly events: EventEmitter; recompute(): Promise<void>; snapshot(force?: boolean): Promise<UsageResponse>; start(): void; stop(): void }`
  - `events` emits `"changed"` with a `UsageResponse` only when the agents payload changes.

- [ ] **Step 1: Write the failing check**

Create `apps/daemon/src/usage.check.ts`:

```ts
import assert from "node:assert/strict";
import type { AgentUsage } from "@orquester/api";
import type { UsagePrefs } from "@orquester/config";
import { UsageService } from "./usage";

const claude: AgentUsage = { id: "claude", available: true, stale: false, session: { percent: 45 }, weekly: { percent: 69 } };
const codex: AgentUsage = { id: "codex", available: true, stale: false, session: { percent: 3 }, weekly: { percent: 37 } };
const allOn: UsagePrefs = { enabled: true, claude: true, codex: true, chip: "busiest" };

function make(over: Partial<UsagePrefs> = {}, c: AgentUsage | null = claude) {
  const changed: unknown[] = [];
  let now = 1_000;
  const svc = new UsageService({
    fetchClaude: async () => c,
    readCodex: async () => codex,
    getPrefs: async () => ({ ...allOn, ...over }),
    now: () => now,
    activeMs: 60_000,
    idleMs: 300_000
  });
  svc.events.on("changed", (u) => changed.push(u));
  return { svc, changed, setNow: (n: number) => (now = n) };
}

const t = async () => {
  // Snapshot(force) computes; both agents present when enabled.
  const a = make();
  const snap = await a.svc.snapshot(true);
  assert.deepEqual(snap.agents.map((x) => x.id), ["claude", "codex"]);
  assert.equal(a.changed.length, 1); // emitted on first movement

  // Recompute with identical data does NOT re-emit (dedupe on agents payload).
  await a.svc.recompute();
  assert.equal(a.changed.length, 1);

  // Disabling an agent drops it and re-emits.
  const b = make({ codex: false });
  await b.svc.snapshot(true);
  const snapB = await b.svc.snapshot(false);
  assert.deepEqual(snapB.agents.map((x) => x.id), ["claude"]);

  // enabled=false ⇒ no agents at all.
  const c = make({ enabled: false });
  const snapC = await c.svc.snapshot(true);
  assert.equal(snapC.agents.length, 0);

  // A null claude source (not logged in) is simply omitted.
  const d = make({}, null);
  const snapD = await d.svc.snapshot(true);
  assert.deepEqual(snapD.agents.map((x) => x.id), ["codex"]);

  console.log("usage.check OK");
};
void t();
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx apps/daemon/src/usage.check.ts`
Expected: FAIL — module `./usage` not found.

- [ ] **Step 3: Implement `UsageService`**

Create `apps/daemon/src/usage.ts`:

```ts
import { EventEmitter } from "node:events";
import type { AgentUsage, UsageResponse } from "@orquester/api";
import type { UsagePrefs } from "@orquester/config";

export interface UsageServiceDeps {
  /** Returns the Claude agent (possibly stale) or null when not logged in. */
  fetchClaude: () => Promise<AgentUsage | null>;
  /** Returns the Codex agent or null when not logged in / API-key mode. */
  readCodex: () => Promise<AgentUsage | null>;
  getPrefs: () => Promise<UsagePrefs>;
  now: () => number;
  /** Poll cadence while a window is fresh (default 60s) / stale-idle (default 5m). */
  activeMs?: number;
  idleMs?: number;
}

const DEFAULT_PREFS: UsagePrefs = { enabled: true, claude: true, codex: true, chip: "busiest" };

export class UsageService {
  readonly events = new EventEmitter();
  private cache: UsageResponse = { updatedAt: new Date(0).toISOString(), agents: [] };
  private hash = "";
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly deps: UsageServiceDeps) {}

  async recompute(): Promise<void> {
    const prefs = await this.deps.getPrefs().catch(() => DEFAULT_PREFS);
    const agents: AgentUsage[] = [];
    if (prefs.enabled && prefs.claude) {
      const c = await this.deps.fetchClaude().catch(() => null);
      if (c) agents.push(c);
    }
    if (prefs.enabled && prefs.codex) {
      const x = await this.deps.readCodex().catch(() => null);
      if (x) agents.push(x);
    }
    this.cache = { updatedAt: new Date(this.deps.now()).toISOString(), agents };
    const h = JSON.stringify(agents); // dedupe on the agents payload, ignoring updatedAt
    if (h !== this.hash) {
      this.hash = h;
      this.events.emit("changed", this.cache);
    }
  }

  async snapshot(force = false): Promise<UsageResponse> {
    if (force) await this.recompute();
    return this.cache;
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.recompute().catch(() => undefined);
    if (this.stopped) return;
    const claude = this.cache.agents.find((a) => a.id === "claude");
    const delay = claude?.stale ? this.deps.idleMs ?? 300_000 : this.deps.activeMs ?? 60_000;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
```

- [ ] **Step 4: Run the check to confirm it passes**

Run: `node --import tsx apps/daemon/src/usage.check.ts`
Expected: `usage.check OK`

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/usage.ts apps/daemon/src/usage.check.ts
git commit -m "feat(daemon): UsageService — dedupe, cache, stale-aware cadence"
```

---

### Task 5: Real usage sources + daemon wiring

**Files:**
- Create: `apps/daemon/src/usage-sources.ts`
- Modify: `apps/daemon/src/index.ts` (construct service, bridge event, route, stop, best-effort watch)

**Interfaces:**
- Consumes: `parseClaudeUsage`/`parseCodexUsage`/`findLastCodexTokenCount` (Task 3), `UsageService`/`UsageServiceDeps` (Task 4), `parseAppConfig` + `UsagePrefs` (Task 2).
- Produces:
  - `createClaudeSource(opts: { userhome: string; now: () => number; logger?: Pick<Console, "warn"> }): () => Promise<AgentUsage | null>`
  - `createCodexSource(opts: { userhome: string; now: () => number }): () => Promise<AgentUsage | null>`
  - `readUsagePrefs(appConfigFile: string): Promise<UsagePrefs>`
  - A live `GET /api/usage` route + `usage.changed` events on channel `"usage"`.

- [ ] **Step 1: Implement the sources**

Create `apps/daemon/src/usage-sources.ts`:

```ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUsage } from "@orquester/api";
import { type UsagePrefs, parseAppConfig } from "@orquester/config";
import { findLastCodexTokenCount, parseClaudeUsage, parseCodexUsage } from "./usage-parse";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function readUsagePrefs(appConfigFile: string): Promise<UsagePrefs> {
  try {
    return parseAppConfig(JSON.parse(await readFile(appConfigFile, "utf8"))).usage;
  } catch {
    // ENOENT / corrupt → defaults (enabled).
    return { enabled: true, claude: true, codex: true, chip: "busiest" };
  }
}

export function createClaudeSource(opts: {
  userhome: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(opts.userhome, ".claude");
  const credsFile = join(claudeHome, ".credentials.json");
  let lastGood: AgentUsage | null = null;

  const stale = (creds: { subscriptionType?: string; rateLimitTier?: string }): AgentUsage => ({
    id: "claude",
    available: lastGood != null,
    stale: true,
    plan: lastGood?.plan,
    session: lastGood?.session ?? null,
    weekly: lastGood?.weekly ?? null
  });

  return async () => {
    let oauth: any;
    try {
      oauth = JSON.parse(await readFile(credsFile, "utf8"))?.claudeAiOauth;
    } catch {
      return null; // not logged in
    }
    if (!oauth?.accessToken) return null;
    const creds = { subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier };
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= opts.now()) return stale(creds);
    try {
      const res = await fetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
          Accept: "application/json"
        }
      });
      if (res.status === 401) return stale(creds);
      if (!res.ok) return lastGood; // transient; keep last-known
      const agent = parseClaudeUsage(await res.json(), creds, opts.now());
      if (agent.available) lastGood = agent;
      return agent;
    } catch (err) {
      opts.logger?.warn?.(`usage: claude fetch failed: ${String(err)}`);
      return lastGood;
    }
  };
}

async function newestRollout(sessionsDir: string): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true } as { recursive: true });
  } catch {
    return null; // no sessions dir yet
  }
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl") || !rel.includes("rollout-")) continue;
    const full = join(sessionsDir, rel);
    try {
      const s = await stat(full);
      if (!best || s.mtimeMs > best.mtime) best = { path: full, mtime: s.mtimeMs };
    } catch {
      /* ignore */
    }
  }
  return best?.path ?? null;
}

export function createCodexSource(opts: {
  userhome: string;
  now: () => number;
}): () => Promise<AgentUsage | null> {
  const codexHome = process.env.CODEX_HOME || join(opts.userhome, ".codex");
  return async () => {
    try {
      const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
      if (auth?.OPENAI_API_KEY || auth?.auth_mode === "apikey") return null; // no subscription quota
    } catch {
      /* no auth.json — still try the logs */
    }
    const file = await newestRollout(join(codexHome, "sessions"));
    if (!file) return null;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    const rateLimits = findLastCodexTokenCount(text.split("\n"));
    if (!rateLimits) return null;
    const agent = parseCodexUsage(rateLimits, opts.now());
    return agent.available ? agent : null;
  };
}
```

- [ ] **Step 2: Wire the service into `startDaemon`**

In `apps/daemon/src/index.ts`, add the imports near the other daemon-service imports (top of file, with `TodoListManager` etc.):

```ts
import { UsageService } from "./usage";
import { createClaudeSource, createCodexSource, readUsagePrefs } from "./usage-sources";
```

After the broadcaster + registry bridge (after line 208, `registry.events.on("changed", …)`), construct and start the service:

```ts
  const usage = new UsageService({
    fetchClaude: createClaudeSource({ userhome: resolved.vars.userhome, now: () => Date.now(), logger: console }),
    readCodex: createCodexSource({ userhome: resolved.vars.userhome, now: () => Date.now() }),
    getPrefs: () => readUsagePrefs(resolved.appConfigFile),
    now: () => Date.now()
  });
  usage.events.on("changed", (u) => broadcaster.publish("usage", "usage.changed", u));
  usage.start();
```

- [ ] **Step 3: Register the service on `Services`**

Add to the `services` object literal (line 245):

```ts
  const services: Services = { registry, sessions, accounts, git, todos, usage, broadcaster };
```

Add to the `Services` interface (after `todos: TodoListManager;`, line 331):

```ts
  usage: UsageService;
```

Add to the `createServer` destructure (line 345):

```ts
  const { registry, sessions, accounts, git, todos, usage } = services;
```

- [ ] **Step 4: Add the route**

Immediately after the `GET /api/registry` route (line 1478), add:

```ts
  app.get<{ Querystring: { refresh?: string } }>("/api/usage", async (request): Promise<UsageResponse> =>
    usage.snapshot(request.query.refresh === "1")
  );
```

Ensure `UsageResponse` is imported from `@orquester/api` in `index.ts` (add it to the existing `@orquester/api` import list).

- [ ] **Step 5: Tear down on stop**

Find the `stop` function inside `startDaemon` (it detaches sessions and closes the servers; it is returned as `stop` at line 322 and calls `closeAllConnections` around lines 288–312). Add, at the top of that function body:

```ts
    usage.stop();
```

- [ ] **Step 6: Best-effort watchers (accelerate Codex + pick up token rotation)**

Right after `usage.start();` (Step 2), add a debounced watch that nudges a recompute when the Codex logs or the credential files change. This is advisory — the timer stays the reliable path:

```ts
  {
    const { watch } = await import("node:fs");
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const nudge = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void usage.recompute(), 500);
    };
    for (const dir of [
      join(process.env.CODEX_HOME || join(resolved.vars.userhome, ".codex"), "sessions"),
      process.env.CLAUDE_CONFIG_DIR || join(resolved.vars.userhome, ".claude")
    ]) {
      try {
        watch(dir, { recursive: true }, nudge);
      } catch {
        /* dir may not exist yet; the poll still covers it */
      }
    }
  }
```

Ensure `join` is imported from `node:path` in `index.ts` (it already imports from `node:path`; confirm `join` is in the list).

- [ ] **Step 7: Typecheck (the gate — the daemon cannot be run in this checkout)**

Run: `pnpm check`
Expected: PASS. Do NOT start the daemon here (AGENTS.md). The parser + service logic are already proven by Tasks 3–4; this task's fs/fetch glue and wiring are verified by typecheck + review.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/usage-sources.ts apps/daemon/src/index.ts
git commit -m "feat(daemon): wire UsageService — sources, GET /api/usage, usage.changed, watchers"
```

---

### Task 6: UI store slice + client method

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (add `getUsage`)
- Modify: `packages/ui/src/store/app.ts` (usage slice + `UiAppConfig.usage` + hydration)

**Interfaces:**
- Consumes: `UsageResponse` (Task 1), `UsagePrefs` (Task 2), `getUsage` on the client.
- Produces: `store.usage: UsageResponse | null`, `store.loadUsage()`, `store.appConfig.usage: UsagePrefs`, and a `usage.changed` reducer branch — consumed by Tasks 7 & 8.

- [ ] **Step 1: Add the client method**

In `packages/ui/src/lib/api-client.ts`, next to `listRegistry` (line 429), add:

```ts
  getUsage(force?: boolean, signal?: AbortSignal): Promise<UsageResponse> {
    return this.send("GET", `/api/usage${force ? "?refresh=1" : ""}`, { signal });
  }
```

Add `UsageResponse` to the existing `@orquester/api` import in that file.

- [ ] **Step 2: Extend `UiAppConfig` and add a default**

In `packages/ui/src/store/app.ts`, add `UsageResponse` and `UsagePrefs` to the existing `@orquester/api` / `@orquester/config` imports.

Change `UiAppConfig` (lines 239–242) to:

```ts
export interface UiAppConfig {
  useTitlebar: boolean;
  runInBackground: boolean;
  usage: UsagePrefs;
}
```

Add a module-level default next to `EMPTY_REGISTRY` (line 45):

```ts
const DEFAULT_USAGE_PREFS: UsagePrefs = { enabled: true, claude: true, codex: true, chip: "busiest" };
```

- [ ] **Step 3: Add the data field + action declaration**

In the `AppState` interface: add `usage: UsageResponse | null;` right after `registry: RegistryResponse;` (line 456), and `loadUsage: () => Promise<void>;` right after the `loadRegistry` declaration (line 533).

- [ ] **Step 4: Add the initial values and thread `usage` through the three appConfig sites**

- Initial state block: after `registry: EMPTY_REGISTRY,` (line 583) add `usage: null,`. Change the initial `appConfig` (line 574) to include `usage`:

```ts
  appConfig: { useTitlebar: false, runInBackground: false, usage: DEFAULT_USAGE_PREFS },
```

- `initConnections` appConfig (line 842) → add `usage`:

```ts
      appConfig: { useTitlebar: nextSetup.defaultUseTitlebar, runInBackground: false, usage: DEFAULT_USAGE_PREFS },
```

- `loadAppConfig` hydration (lines 855–860) → carry `usage` from the loaded config:

```ts
        set((state) => ({
          appConfig: {
            useTitlebar: config.useTitlebar ?? state.appConfig.useTitlebar,
            runInBackground: config.runInBackground ?? state.appConfig.runInBackground,
            usage: config.usage ?? state.appConfig.usage
          }
        }));
```

(No change needed in `updateAppConfig` — it spreads `appConfig`, so `usage` patches and persists automatically.)

- [ ] **Step 5: Implement `loadUsage` and the event branch**

Add `loadUsage` next to `loadRegistry`'s implementation (line 1200), mirroring it:

```ts
  loadUsage: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ usage: await api.getUsage() });
    } catch {
      /* keep current */
    }
  },
```

Add the snapshot fetch to the `establish()` `Promise.all` (line 731) — add `get().loadUsage(),` to the array.

Add a branch at the top of `applyEvent` (line 1504, before the `registry` branch):

```ts
    if (event.channel === "usage") {
      set({ usage: event.payload as UsageResponse });
      return;
    }
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/lib/api-client.ts packages/ui/src/store/app.ts
git commit -m "feat(ui): usage store slice + getUsage + usage prefs in app config"
```

---

### Task 7: `UsageWidget` (chip + popover) and mount

**Files:**
- Create: `packages/ui/src/components/topbar/usage-format.ts`
- Test: `packages/ui/src/components/topbar/usage-format.check.ts`
- Create: `packages/ui/src/components/topbar/UsageWidget.tsx`
- Modify: `packages/ui/src/components/topbar/TopBar.tsx` (mount before `SettingsButton`)

**Interfaces:**
- Consumes: `store.usage`, `store.appConfig.usage`, `store.loadUsage` (Task 6); `AdaptiveMenu` (`packages/ui/src/components/ui`).
- Produces:
  - `pickDriver(agents: AgentUsage[], chip: UsagePrefs["chip"]): AgentUsage | null`
  - `formatCountdown(resetsAt: string | undefined, now: number): string`
  - `barClass(pct: number): string`
  - `formatClock(iso: string): string`
  - The `UsageWidget` component.

- [ ] **Step 1: Write the failing format check**

Create `packages/ui/src/components/topbar/usage-format.check.ts`:

```ts
import assert from "node:assert/strict";
import type { AgentUsage } from "@orquester/api";
import { barClass, formatCountdown, pickDriver } from "./usage-format";

const claude: AgentUsage = { id: "claude", available: true, stale: false, session: { percent: 10 }, weekly: { percent: 20 } };
const codex: AgentUsage = { id: "codex", available: true, stale: false, session: { percent: 80 }, weekly: { percent: 5 } };

// "busiest" = highest single window (codex's 80 beats claude's 20).
assert.equal(pickDriver([claude, codex], "busiest")?.id, "codex");
// pinned choice wins when available…
assert.equal(pickDriver([claude, codex], "claude")?.id, "claude");
// …but falls back to busiest when the pinned agent is absent.
assert.equal(pickDriver([codex], "claude")?.id, "codex");
assert.equal(pickDriver([], "busiest"), null);

// Countdown formatting.
const now = Date.parse("2026-07-07T08:00:00Z");
assert.equal(formatCountdown("2026-07-07T10:29:00Z", now), "Resets in 2h 29m");
assert.equal(formatCountdown("2026-07-07T07:59:00Z", now), "Resets now.");
assert.equal(formatCountdown(undefined, now), "");

// Color ramp thresholds.
assert.match(barClass(10), /emerald/);
assert.match(barClass(80), /amber/);
assert.match(barClass(95), /red/);

console.log("usage-format.check OK");
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx packages/ui/src/components/topbar/usage-format.check.ts`
Expected: FAIL — module `./usage-format` not found.

- [ ] **Step 3: Implement the pure helpers**

Create `packages/ui/src/components/topbar/usage-format.ts`:

```ts
import type { AgentUsage, UsagePrefs } from "@orquester/api";
import type { UsagePrefs as _Prefs } from "@orquester/config";

type Chip = _Prefs["chip"];

function windowMax(a: AgentUsage): number {
  return Math.max(a.session?.percent ?? 0, a.weekly?.percent ?? 0);
}

/** The agent whose numbers drive the collapsed chip. */
export function pickDriver(agents: AgentUsage[], chip: Chip): AgentUsage | null {
  if (agents.length === 0) return null;
  if (chip !== "busiest") {
    const pinned = agents.find((a) => a.id === chip);
    if (pinned) return pinned;
  }
  return agents.reduce((best, a) => (windowMax(a) > windowMax(best) ? a : best), agents[0]);
}

export function formatCountdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms) || ms <= 60_000) return "Resets now.";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `Resets in ${h}h ${m}m` : `Resets in ${m}m`;
}

/** Fill color for a percentage: emerald < 75, amber < 90, red otherwise. */
export function barClass(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 75) return "bg-amber-400";
  return "bg-emerald-400";
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
```

Note: `UsagePrefs` is re-exported from `@orquester/api` for convenience — if it is not, import the `chip` type from `@orquester/config` only (the `_Prefs` import above already covers it; remove the unused `@orquester/api` `UsagePrefs` import if `pnpm check` flags it).

- [ ] **Step 4: Run the check to confirm it passes**

Run: `node --import tsx packages/ui/src/components/topbar/usage-format.check.ts`
Expected: `usage-format.check OK`

- [ ] **Step 5: Implement `UsageWidget`**

Create `packages/ui/src/components/topbar/UsageWidget.tsx`:

```tsx
import React from "react";
import { ChevronDown, Gauge, RefreshCw } from "lucide-react";
import type { AgentUsage } from "@orquester/api";
import { AdaptiveMenu } from "../ui";
import { useAppStore } from "../../store/app";
import { barClass, formatClock, formatCountdown, pickDriver } from "./usage-format";

const AGENT_LABEL: Record<AgentUsage["id"], string> = { claude: "Claude Code", codex: "Codex" };

const Bar: React.FC<{ label: string; window: AgentUsage["session"]; muted: boolean }> = ({ label, window, muted }) => {
  const pct = window?.percent ?? 0;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-300">{label}</span>
        <span className={muted ? "text-neutral-500" : "text-neutral-200"}>{window ? `${Math.round(pct)}%` : "—"}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full ${muted ? "bg-neutral-600" : barClass(pct)}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">{formatCountdown(window?.resetsAt, Date.now())}</p>
    </div>
  );
};

const AgentSection: React.FC<{ agent: AgentUsage }> = ({ agent }) => (
  <div className="px-3 py-2">
    <div className="flex items-center justify-between">
      <p className="text-sm text-neutral-200">{AGENT_LABEL[agent.id]} Usage</p>
      {agent.plan && <span className="text-xs text-neutral-500">{agent.plan}</span>}
    </div>
    {agent.stale && <p className="text-[11px] text-amber-400">Stale — open {AGENT_LABEL[agent.id]} to refresh</p>}
    <Bar label="Current session (5 hours)" window={agent.session} muted={agent.stale} />
    <Bar label="Current week" window={agent.weekly} muted={agent.stale} />
  </div>
);

export const UsageWidget: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);

  if (!prefs.enabled || !usage) return null;
  const agents = usage.agents.filter((a) => (a.id === "claude" ? prefs.claude : prefs.codex));
  if (agents.length === 0) return null;

  const driver = pickDriver(agents, prefs.chip);
  if (!driver) return null;

  const chipText = `${Math.round(driver.session?.percent ?? 0)}% • ${Math.round(driver.weekly?.percent ?? 0)}%`;
  const trigger = (
    <span className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800">
      <Gauge size={13} className={driver.stale ? "text-neutral-600" : "text-emerald-400"} />
      <span>{chipText}</span>
      <ChevronDown size={13} className="text-neutral-500" />
    </span>
  );

  return (
    <AdaptiveMenu title="Usage" trigger={trigger} align="right" width="w-72">
      <div className="flex items-center justify-between px-3 pt-2 text-[11px] text-neutral-500">
        <span>Updated {formatClock(usage.updatedAt)}</span>
        <button
          type="button"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation();
            void loadUsage();
          }}
          aria-label="Refresh usage"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {agents.map((a) => (
        <AgentSection key={a.id} agent={a} />
      ))}
    </AdaptiveMenu>
  );
};
```

Note: `loadUsage()` re-fetches the cached snapshot; the daemon's `?refresh=1` force-recompute is available via `getUsage(true)` if a harder refresh is wanted later — kept simple here.

- [ ] **Step 6: Mount it in the top bar**

In `packages/ui/src/components/topbar/TopBar.tsx`: import the widget:

```tsx
import { UsageWidget } from "./UsageWidget";
```

In the desktop right cluster (`<div className="flex items-center gap-1 pr-1">`), immediately before `<SettingsButton />`, add:

```tsx
        <div className="app-no-drag">
          <UsageWidget />
        </div>
```

(The `app-no-drag` wrapper is required — the desktop header is a frameless-window drag region.) Optionally add the same line before `<SettingsButton />` in the mobile header row for parity.

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: PASS. Note: the rendered widget cannot be verified in a browser from this checkout; correctness of the pure helpers is covered by Step 4, the rest by typecheck + review.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/components/topbar/usage-format.ts packages/ui/src/components/topbar/usage-format.check.ts packages/ui/src/components/topbar/UsageWidget.tsx packages/ui/src/components/topbar/TopBar.tsx
git commit -m "feat(ui): UsageWidget chip + popover, mounted in the top bar"
```

---

### Task 8: Settings ▸ Usage section

**Files:**
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx`

**Interfaces:**
- Consumes: `store.appConfig.usage`, `store.updateAppConfig`, `store.usage`, `useRegistry` (installed check); `Field`/`Switch` (in-file / `../ui`).
- Produces: a `"usage"` section in the Settings modal.

- [ ] **Step 1: Add the icon import + section id**

In `SettingsModal.tsx`, add `Gauge` to the `lucide-react` import list. Change the `Section` type (line 26) to include `"usage"`:

```ts
type Section = "app" | "agents" | "usage" | "github" | "daemon";
```

Add the `SECTIONS` entry (after the `app` entry, line 29):

```tsx
  { id: "usage", label: "Usage", icon: <Gauge size={16} />, desc: "Top-bar usage widget for Claude Code & Codex" },
```

- [ ] **Step 2: Add the render branch**

Change `renderSection` (lines 35–45) to route `"usage"`:

```tsx
const renderSection = (id: Section) =>
  id === "app" ? (
    <AppSettings />
  ) : id === "agents" ? (
    <AgentsSettings />
  ) : id === "usage" ? (
    <UsageSettings />
  ) : id === "github" ? (
    <GitHubSettings />
  ) : (
    <DaemonSettings />
  );
```

- [ ] **Step 3: Add the `UsageSettings` pane**

Add this component near `AppSettings` (it reuses the in-file `Field` helper and the `Switch` already imported from `../ui`):

```tsx
const UsageSettings: React.FC = () => {
  const prefs = useAppStore((s) => s.appConfig.usage);
  const usage = useAppStore((s) => s.usage);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const registry = useRegistry();

  const setUsage = (patch: Partial<typeof prefs>) => void updateAppConfig({ usage: { ...prefs, ...patch } });

  const agentHint = (id: "claude" | "codex") => {
    const installed = registry.agents.some((a) => a.id === id && a.enabled);
    if (!installed) return "Not installed";
    const found = usage?.agents.find((a) => a.id === id);
    if (!found) return "Not logged in";
    if (found.stale) return "Stale — token expired";
    return found.plan ? `Logged in · ${found.plan}` : "Logged in";
  };

  const CHIP_OPTIONS: { value: typeof prefs.chip; label: string }[] = [
    { value: "busiest", label: "Busiest" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" }
  ];

  return (
    <div className="divide-y divide-neutral-800">
      <Field label="Show usage in the top bar" hint="A compact quota chip that opens a details panel.">
        <Switch checked={prefs.enabled} onChange={(v) => setUsage({ enabled: v })} />
      </Field>
      <Field label="Claude Code" hint={agentHint("claude")}>
        <Switch checked={prefs.claude} onChange={(v) => setUsage({ claude: v })} />
      </Field>
      <Field label="Codex" hint={agentHint("codex")}>
        <Switch checked={prefs.codex} onChange={(v) => setUsage({ codex: v })} />
      </Field>
      <Field label="Chip shows" hint="Which agent drives the collapsed chip.">
        <div className="flex gap-1">
          {CHIP_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setUsage({ chip: o.value })}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                prefs.chip === o.value
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800"
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
};
```

(`cn` and `useRegistry` are already imported in this file; `registry.agents` is the installed-agent list.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS. Confirm `registry.agents` exposes `{ id, enabled }` (it backs `AgentsSettings`); if the shape differs, adjust `agentHint`'s `installed` check to match how `AgentsSettings` reads it.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "feat(ui): Settings ▸ Usage — widget toggle, per-agent, chip mode"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §5.1 Claude endpoint/parse/guards → Tasks 3 (parse) + 5 (fetch). §5.2 Codex log/reject-api-key/stale-window → Tasks 3 + 5.
- §6 refresh & staleness (read-only, stale, cadence, cred watch) → Task 4 (cadence/dedupe) + Task 5 (stale source, watchers).
- §7 daemon service/route/singleton/stop → Tasks 4 + 5.
- §8 wire contract → Task 1. §10 app-config prefs + daemon gate → Task 2 + Task 5 (`readUsagePrefs`).
- §9 store slice → Task 6. §11 chip + popover → Task 7. §12 Settings → Task 8.
- §13 privacy (aggregates only) → enforced by the `UsageResponse` shape (Task 1) + sources returning only windows (Tasks 3/5).
- §14 edge cases → parser guards (Task 3: leak clamp, stale window, two shapes), source (Task 5: 401→stale, API-key reject, ENOENT), cadence (Task 4).

**2. Placeholder scan** — no `TBD`/`TODO`/"handle edge cases"; every code step shows complete code; test steps contain real assertions.

**3. Type consistency** — `UsageResponse`/`AgentUsage`/`UsageWindow` (Task 1) are used unchanged in Tasks 3–8. `UsagePrefs` (Task 2) `{ enabled, claude, codex, chip }` matches the store field (Task 6), the widget filter (Task 7), and the settings pane (Task 8). `UsageService` method names (`recompute`/`snapshot`/`start`/`stop`, `events` emitting `"changed"`) match between Task 4's definition and Task 5's wiring. `getUsage` (Task 6) matches the widget's `loadUsage` call (Task 7). Channel string `"usage"` / type `"usage.changed"` match between the daemon publish (Task 5) and the store reducer (Task 6).

Two verify-at-implementation notes carried into steps: (a) `registry.agents` element shape in Task 8 Step 4; (b) whether `UsagePrefs` is re-exported from `@orquester/api` in Task 7 Step 3 (fallback documented).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-agent-usage-widget.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
