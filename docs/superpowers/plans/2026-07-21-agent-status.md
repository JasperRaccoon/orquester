# Server-Authoritative Agent-Session Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon becomes the single source of truth for session activity (working/waiting/idle + attention), fed by managed agent hooks for claude/codex/opencode, broadcast on `/events`, rendered by the UI, and driving two distinct Web Push types ("needs your input" / "finished").

**Architecture:** Extend `ActivityTracker` into a small state machine that fires an `onChange` callback on transitions; both session backends forward changes to `lifecycle "activity"`; `index.ts` broadcasts `session.activity` and routes pushes. A new socket-only route `POST /api/sessions/:id/agent-event` receives hook events delivered by managed hook scripts/plugins installed into each agent's config. The UI deletes its client-side re-derivation and consumes server state.

**Tech Stack:** TypeScript 5.8 ESM, Fastify 4, tmux/node-pty, zustand, no test runner (`pnpm check` = `tsc --noEmit` is the only gate).

**Spec:** `docs/superpowers/specs/2026-07-21-agent-status-design.md` — read it first.

## Global Constraints

- **⛔ NEVER start/restart/stop any daemon or run `pnpm dev*`** — this checkout runs inside a live Orquester instance (AGENTS.md). Verification = `pnpm check` + code review. Live-drive only if the user explicitly asks, and then only against a separate checkout/scratch appdir.
- **No test runner exists.** Do not add one. Each task's gate is `pnpm check` (runs `tsc --noEmit` across the workspace) plus any pure-logic spot checks via `node --input-type=module -e`.
- **Commit to the CURRENT branch (`main`) after each task.** Do not create branches. Stage files by name.
- ESM everywhere, TS strict. Packages import each other's TS source directly — no build step needed for daemon changes.
- Env vars injected into sessions: exactly `ORQUESTER_SESSION_ID` and `ORQUESTER_DAEMON_SOCK` (agent sessions only).
- Constants: idle threshold `IDLE_MS = 3000` (daemon), push debounce `DEBOUNCE_MS = 30_000` per session **per type**.
- Hook artifacts live in `<appdir>/daemon/hooks/`; installers must be idempotent, atomic (tmp+rename), and NEVER throw into the session-create path (log + degrade).
- All new wire types live in `packages/api/src/index.ts`; UI/daemon import from `@orquester/api`.

---

### Task 1: Wire types in `@orquester/api`

**Files:**
- Modify: `packages/api/src/index.ts` (SessionSummary is at ~line 720; add new types directly above it)

**Interfaces:**
- Produces (used by every later task):
  - `SessionActivityState = "working" | "waiting" | "idle"`
  - `SessionAttention = "bell" | "needs-input" | "finished"`
  - `SessionActivity { state: SessionActivityState; attention: SessionAttention | null; lastOutputAt: string | null }`
  - `SessionSummary.activity?: SessionActivity`
  - `SessionActivityEvent { id: string; activity: SessionActivity }` (payload of `/events` type `"session.activity"`, channel `"sessions"`)
  - `AgentEventSource = "claude" | "codex" | "opencode"`
  - `AgentEventRequest { source: AgentEventSource; event: string; payload?: unknown }`

- [ ] **Step 1: Add the types.** Insert immediately before `export interface SessionSummary`:

```ts
/** Coarse liveness of a session, derived by the daemon (single source of truth). */
export type SessionActivityState = "working" | "waiting" | "idle";

/**
 * Why the session wants the user's eyes. "bell" = terminal BEL with no
 * structural hook info; "needs-input"/"finished" come from agent hooks.
 */
export type SessionAttention = "bell" | "needs-input" | "finished";

export interface SessionActivity {
  state: SessionActivityState;
  attention: SessionAttention | null;
  /** ISO timestamp of the last PTY output, null before first output. */
  lastOutputAt: string | null;
}

/** Payload of the "session.activity" event (channel "sessions"). */
export interface SessionActivityEvent {
  id: string;
  activity: SessionActivity;
}

/** Agents whose managed hooks report structural status to the daemon. */
export type AgentEventSource = "claude" | "codex" | "opencode";

/** Body of POST /api/sessions/:id/agent-event (unix-socket transport only). */
export interface AgentEventRequest {
  source: AgentEventSource;
  event: string;
  payload?: unknown;
}
```

- [ ] **Step 2: Extend SessionSummary.** Add after the `createdAt: string;` member of `SessionSummary`:

```ts
  /** Live activity snapshot; absent in persisted indexes and for exited sessions. */
  activity?: SessionActivity;
```

- [ ] **Step 3: Verify**

Run: `pnpm check`
Expected: exit 0 (types are additive).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): session activity + agent-event wire types"
```

---

### Task 2: ActivityTracker state machine (daemon)

**Files:**
- Modify: `apps/daemon/src/ansi-activity.ts` (keep `BellScanner` untouched; replace `ActivitySnapshot`/`ActivityTracker`)

**Interfaces:**
- Consumes: `SessionActivity`, `SessionAttention` from `@orquester/api`.
- Produces (Tasks 3/5/6/8 rely on these exact signatures):
  - `type ActivityCause = "output" | "idle" | "bell" | "hook" | "input"`
  - `type HookEventClass = "working" | "waiting" | "done"`
  - `class ActivityTracker { constructor(onChange?: (snapshot: SessionActivity, cause: ActivityCause) => void); noteOutput(chunk: string, now?: number): void; noteInput(): void; applyHookEvent(cls: HookEventClass): void; get hasHookSource(): boolean; snapshot(): SessionActivity; dispose(): void }`
  - Old API (`onOutput`, `onInput`, `ActivitySnapshot`) is **removed**; Task 3 and Task 8 update the two consumers (`sessions.ts`, `mcp/terminal-control.ts`).

- [ ] **Step 1: Replace the tracker.** Replace everything from `export interface ActivitySnapshot` to end of file with:

```ts
import type { SessionActivity, SessionAttention } from "@orquester/api";

/** Silence (ms) after the last output before working → idle. */
export const IDLE_MS = 3000;

export type ActivityCause = "output" | "idle" | "bell" | "hook" | "input";
export type HookEventClass = "working" | "waiting" | "done";

/**
 * Per-session activity state machine — the daemon-side single source of truth
 * behind SessionSummary.activity and "session.activity" events. Structural
 * hook events (agent lifecycle) outrank byte-stream heuristics: output flow
 * never overrides "waiting", and a bell never downgrades a structural
 * attention. `onChange` fires only on real transitions (state or attention
 * changed), never on every output chunk.
 */
export class ActivityTracker {
  private readonly scanner = new BellScanner();
  private lastOutputAt: number | null = null;
  private state: SessionActivity["state"] = "idle";
  private attention: SessionAttention | null = null;
  private hookSource = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange?: (snapshot: SessionActivity, cause: ActivityCause) => void
  ) {}

  get hasHookSource(): boolean {
    return this.hookSource;
  }

  noteOutput(chunk: string, now: number = Date.now()): void {
    this.lastOutputAt = now;
    const rang = this.scanner.feed(chunk) > 0;
    let changed = false;
    if (this.state === "idle") {
      this.state = "working";
      changed = true;
    }
    // "waiting" is structural — a TUI repaint at a permission prompt must not
    // clear it, so output only rearms the idle timer for the "working" state.
    if (this.state === "working") {
      this.armIdleTimer();
    }
    if (rang && this.attention === null) {
      this.attention = "bell";
      changed = true;
    }
    if (changed) {
      this.emit(rang ? "bell" : "output");
    } else if (rang) {
      this.emit("bell");
    }
  }

  noteInput(): void {
    let changed = false;
    if (this.attention !== null) {
      this.attention = null;
      changed = true;
    }
    // Answering a prompt produces no hook event in any agent; the user's
    // keystrokes are the answer. Optimistically resume "working" — the next
    // hook event corrects if wrong.
    if (this.state === "waiting") {
      this.state = "working";
      this.armIdleTimer();
      changed = true;
    }
    if (changed) {
      this.emit("input");
    }
  }

  applyHookEvent(cls: HookEventClass): void {
    this.hookSource = true;
    const before = this.key();
    if (cls === "working") {
      this.state = "working";
      this.attention = null;
      this.armIdleTimer();
    } else if (cls === "waiting") {
      this.state = "waiting";
      this.attention = "needs-input";
      this.clearIdleTimer();
    } else {
      this.state = "idle";
      this.attention = "finished";
      this.clearIdleTimer();
    }
    if (this.key() !== before) {
      this.emit("hook");
    }
  }

  snapshot(): SessionActivity {
    return {
      state: this.state,
      attention: this.attention,
      lastOutputAt: this.lastOutputAt === null ? null : new Date(this.lastOutputAt).toISOString()
    };
  }

  dispose(): void {
    this.clearIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state === "working") {
        this.state = "idle";
        this.emit("idle");
      }
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private key(): string {
    return `${this.state}|${this.attention ?? ""}`;
  }

  private emit(cause: ActivityCause): void {
    this.onChange?.(this.snapshot(), cause);
  }
}
```

- [ ] **Step 2: Typecheck knowingly fails** (consumers still call the old API):

Run: `pnpm check`
Expected: FAIL in `apps/daemon/src/sessions.ts` and `apps/daemon/src/mcp/terminal-control.ts` only. Do NOT commit yet — Task 3 restores green; Tasks 2+3 commit together as one unit.

---

### Task 3: Session managers — wiring, env injection, agentEvent (commit includes Task 2)

**Files:**
- Modify: `apps/daemon/src/sessions.ts`
- Modify: `apps/daemon/src/mcp/terminal-control.ts` (minimal fix to compile; full rework in Task 8)

**Interfaces:**
- Consumes: `ActivityTracker` (Task 2), `classifyAgentEvent` comes later (Task 4) — this task adds `agentEvent()` calling a placeholder-free inline classification? **No** — order swap: this task only adds the plumbing `agentEvent(id, req)` that Task 4's classifier completes. To keep every commit green, `agentEvent` lands **in Task 4** instead; here we only rewire tracker/env.
- Produces:
  - `SessionManagerOptions { resolveExtraEnv?: ResolveSessionExtraEnv; daemonSockPath?: string; onAgentLaunch?: (entry: RegistryEntry) => void }`
  - `ISessionManager.activity(id): SessionActivity | undefined` (was `ActivitySnapshot`)
  - `ISessionManager.lifecycle` `"activity"` event payload becomes `{ id: string; activity: SessionActivity; cause: ActivityCause; hasHookSource: boolean; kind: RegistryKind }`
  - `list()`/`get()`/`"created"`/`"updated"` summaries carry `activity` (filled at the boundary; never persisted).

- [ ] **Step 1: Update imports and `Session` construction.** In `sessions.ts`, change the ansi-activity import to `import { ActivityTracker, type ActivityCause } from "./ansi-activity";` (drop `ActivitySnapshot`) and add `import type { SessionActivity } from "@orquester/api";` (extend the existing `@orquester/api` type import). In **both** `SessionManager.create` (line ~258) and `LocalSessionManager.create`, replace `tracker: new ActivityTracker()` with a tracker that forwards transitions (the session object is created before the tracker needs to fire, so close over `id` + the manager):

```ts
    const tracker = new ActivityTracker((activity, cause) => {
      this.lifecycle.emit("activity", {
        id,
        activity,
        cause,
        hasHookSource: tracker.hasHookSource,
        kind: summary.kind
      });
    });
    const session: Session = { summary, pty: null, buffer: "", tracker, emitter: new EventEmitter() };
```

Do the same in `SessionManager.reattach` (tracker construction at ~line 619 — same closure, using that scope's `id`/`summary`).

- [ ] **Step 2: Rewire output/input/exit.** In `SessionManager.attach`'s `pty.onData` (and the parallel block in `LocalSessionManager.create`), replace

```ts
      if (session.tracker.onOutput(data, Date.now())) {
        this.lifecycle.emit("activity", { id, type: "bell" });
      }
```

with

```ts
      session.tracker.noteOutput(data);
```

In both managers' `input()`, replace `session?.tracker.onInput();` with `session?.tracker.noteInput();`. In both exit paths (`pty.onExit` handlers) and both `close()` methods, add `session.tracker.dispose();` right where the session is marked exited/removed (before emitting), so a pending idle timer can't fire on a dead session.

- [ ] **Step 3: activity() + boundary summaries.** Change both managers' `activity(id)` return type to `SessionActivity | undefined` (body stays `this.sessions.get(id)?.tracker.snapshot()`), and update `ISessionManager` accordingly (also update its `lifecycle` doc comment to the new payload). Add a private helper to **both** managers and use it in `list()`, `get()`, and the `"created"`/`"updated"`/`"exited"` lifecycle emissions (`create`, `rename`, `reorder` — wherever `{ ...summary }` or `{ ...s.summary }` is emitted/returned):

```ts
  private withActivity(session: Session): SessionSummary {
    return session.summary.status === "running"
      ? { ...session.summary, activity: session.tracker.snapshot() }
      : { ...session.summary };
  }
```

`persistIndex` must keep writing the bare summary (it already reads `session.summary` directly — verify it does not pick up `activity`).

- [ ] **Step 4: Env injection.** Add to `SessionManagerOptions`:

```ts
export interface SessionManagerOptions {
  resolveExtraEnv?: ResolveSessionExtraEnv;
  /** Absolute path to the daemon's unix socket, injected into agent sessions for hook delivery. */
  daemonSockPath?: string;
  /** Fire-and-forget notification that an agent session is launching (hook installers). */
  onAgentLaunch?: (entry: RegistryEntry) => void;
}
```

In **both** `create()` methods, after the `env` object is built, add:

```ts
    if (entry.kind === "agent") {
      env.ORQUESTER_SESSION_ID = id;
      if (this.options.daemonSockPath) {
        env.ORQUESTER_DAEMON_SOCK = this.options.daemonSockPath;
      }
      try {
        this.options.onAgentLaunch?.(entry);
      } catch {
        // hook installation is best-effort; never blocks a session launch
      }
    }
```

(tmux backend: these ride the existing `-e` mechanism — values contain no newlines; local backend: they merge into the spawn env the same way `entry.env` does.)

- [ ] **Step 5: Keep `terminal-control.ts` compiling** (full rework in Task 8). In `activityFields()` replace the body's use of `activity.lastOutputAt !== null && Date.now() - ... < ACTIVITY_WORKING_MS ? "working" : "idle"` with the tracker's own state and coerce attention to the old boolean shape for now:

```ts
      activity: activity.state === "waiting" ? "working" : activity.state,
      attention: activity.attention !== null,
      lastOutputAt: activity.lastOutputAt ?? undefined
```

(Adjust the surrounding types minimally — `lastOutputAt` is already an ISO string now.) In `waitForAttention`, the lifecycle listener currently matches `{ id, type: "bell" }`; change the predicate to `(event: { id: string; activity: SessionActivity }) => watched(event.id) && event.activity.attention !== null`.

- [ ] **Step 6: Verify**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 7: Spot-check the state machine** (pure logic, no daemon):

```bash
node --import tsx --input-type=module -e '
import { ActivityTracker } from "./apps/daemon/src/ansi-activity.ts";
const log = [];
const t = new ActivityTracker((s, c) => log.push(`${c}:${s.state}/${s.attention}`));
t.noteOutput("hello");             // idle -> working
t.applyHookEvent("waiting");       // -> waiting/needs-input
t.noteOutput("repaint");     // must stay waiting; bell must NOT override needs-input
t.noteInput();                     // -> working, attention cleared
t.applyHookEvent("done");          // -> idle/finished
t.dispose();
console.log(log.join("\n"));
'
```
Expected output:
```
output:working/null
hook:waiting/needs-input
input:working/null
hook:idle/finished
```
(No line between `hook:waiting` and `input:` — the repaint+bell emits nothing because attention was already structural. If a `bell:` line appears there, the bell override guard is wrong.)

- [ ] **Step 8: Commit (Tasks 2+3 together)**

```bash
git add apps/daemon/src/ansi-activity.ts apps/daemon/src/sessions.ts apps/daemon/src/mcp/terminal-control.ts
git commit -m "feat(daemon): activity state machine as single source of session status"
```

---

### Task 4: Event classifier + agentEvent + socket-only route + broadcast + push split

**Files:**
- Create: `apps/daemon/src/agent-status.ts`
- Modify: `apps/daemon/src/sessions.ts` (add `agentEvent` to `ISessionManager` + both managers)
- Modify: `apps/daemon/src/index.ts` (route, `session.activity` broadcast, push routing at lines ~314-326)
- Modify: `apps/daemon/src/push.ts`

**Interfaces:**
- Produces:
  - `classifyAgentEvent(source: AgentEventSource, event: string, payload: unknown): HookEventClass | null`
  - `ISessionManager.agentEvent(id: string, req: AgentEventRequest): boolean` (false = unknown session)
  - `PushService.notifyStructural(session: SessionSummary, type: "needs-input" | "finished"): Promise<void>`
  - Route: `POST /api/sessions/:id/agent-event` → 204 (applied or ignored), 404 (unknown session). Registered ONLY when `options.mode === "local"`.
  - `/events`: `{ channel: "sessions", type: "session.activity", payload: SessionActivityEvent }`

- [ ] **Step 1: Create `apps/daemon/src/agent-status.ts`:**

```ts
import type { AgentEventSource } from "@orquester/api";
import type { HookEventClass } from "./ansi-activity";

/**
 * Maps a raw agent hook event to an activity class. Mapping mirrors what each
 * CLI actually emits (see the design spec's table); unknown events return null
 * and are ignored — a hook must never be able to break a session.
 */
export function classifyAgentEvent(
  source: AgentEventSource,
  event: string,
  payload: unknown
): HookEventClass | null {
  switch (source) {
    case "claude":
      return classifyClaude(event, payload);
    case "codex":
      return classifyCodex(event);
    case "opencode":
      return classifyOpenCode(event);
  }
}

function toolName(payload: unknown): string {
  return typeof (payload as { tool_name?: unknown })?.tool_name === "string"
    ? ((payload as { tool_name: string }).tool_name)
    : "";
}

/** Claude auto-allows AskUserQuestion, so it never reaches PermissionRequest. */
function isAskUserQuestion(payload: unknown): boolean {
  return toolName(payload) === "AskUserQuestion";
}

function isPermissionNotification(payload: unknown): boolean {
  const message = (payload as { message?: unknown })?.message;
  return typeof message === "string" && /permission|approv|waiting for your input/i.test(message);
}

function classifyClaude(event: string, payload: unknown): HookEventClass | null {
  switch (event) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "PreToolUse":
      return isAskUserQuestion(payload) ? "waiting" : "working";
    case "PermissionRequest":
      return "waiting";
    case "Notification":
      return isPermissionNotification(payload) ? "waiting" : null;
    case "Stop":
      return "done";
    default:
      return null;
  }
}

function classifyCodex(event: string): HookEventClass | null {
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "PermissionRequest":
      return "waiting";
    case "Stop":
      return "done";
    default:
      return null;
  }
}

function classifyOpenCode(event: string): HookEventClass | null {
  switch (event) {
    case "SessionBusy":
      return "working";
    case "PermissionRequest":
    case "AskUserQuestion":
      return "waiting";
    case "SessionIdle":
      return "done";
    default:
      return null;
  }
}
```

- [ ] **Step 2: Add `agentEvent` to sessions.** In `ISessionManager` (after `activity`):

```ts
  /** Apply a managed-hook event to a session's tracker. False = unknown session. */
  agentEvent(id: string, req: AgentEventRequest): boolean;
```

Identical implementation in **both** `SessionManager` and `LocalSessionManager` (import `classifyAgentEvent` and `AgentEventRequest`):

```ts
  agentEvent(id: string, req: AgentEventRequest): boolean {
    const session = this.sessions.get(id);
    if (!session || session.summary.status !== "running") {
      return false;
    }
    const cls = classifyAgentEvent(req.source, req.event, req.payload);
    if (cls !== null) {
      session.tracker.applyHookEvent(cls);
    }
    return true;
  }
```

- [ ] **Step 3: Push split.** In `push.ts`, rename the debounce map comment, key by `"<id>:<type>"`, and add the structural method. Replace `notifyAttention` + the map with:

```ts
  /** Last-push timestamp per `<sessionId>:<type>` key, for the per-type debounce. */
  private readonly lastPushAt = new Map<string, number>();

  private debounced(key: string, now: number): boolean {
    for (const [k, ts] of this.lastPushAt) {
      if (now - ts >= DEBOUNCE_MS) {
        this.lastPushAt.delete(k);
      }
    }
    const last = this.lastPushAt.get(key) ?? 0;
    if (now - last < DEBOUNCE_MS) {
      return true;
    }
    this.lastPushAt.set(key, now);
    return false;
  }

  /** Bell fallback push for sessions without hook coverage. */
  async notifyAttention(session: SessionSummary): Promise<void> {
    await this.notify(session, "bell", "needs your attention");
  }

  /** Structural push from agent-hook transitions ("needs-input" | "finished"). */
  async notifyStructural(session: SessionSummary, type: "needs-input" | "finished"): Promise<void> {
    await this.notify(session, type, type === "finished" ? "finished" : "needs your input");
  }

  private async notify(session: SessionSummary, type: string, verb: string): Promise<void> {
    try {
      if (this.debounced(`${session.id}:${type}`, Date.now())) {
        return;
      }
      const project = session.projectPath ? basename(session.projectPath) : "";
      const payload = JSON.stringify({
        title: project ? `${session.title} in ${project} ${verb}` : `${session.title} ${verb}`,
        body: "",
        tag: `session-${session.id}`,
        sessionId: session.id
      });
      await this.deliver(payload);
    } catch (error) {
      this.logger.error("push notify failed", error);
    }
  }
```

- [ ] **Step 4: Broadcast + push routing in `index.ts`.** Replace the whole `sessions.lifecycle.on("activity", …)` block (lines ~314-326) with:

```ts
  // Activity transitions → event bus (all clients render the same dot) AND push.
  // Push policy: structural hook attentions push per-type; bells push only for
  // agent sessions that have never delivered a hook event (no double-notify).
  sessions.lifecycle.on(
    "activity",
    (event: {
      id: string;
      activity: SessionActivity;
      cause: ActivityCause;
      hasHookSource: boolean;
      kind: RegistryKind;
    }) => {
      broadcaster.publish("sessions", "session.activity", {
        id: event.id,
        activity: event.activity
      } satisfies SessionActivityEvent);
      if (event.kind !== "agent") {
        return;
      }
      const summary = sessions.get(event.id);
      if (!summary) {
        return;
      }
      if (event.cause === "hook" && event.activity.attention === "needs-input") {
        void push.notifyStructural(summary, "needs-input");
      } else if (event.cause === "hook" && event.activity.attention === "finished") {
        void push.notifyStructural(summary, "finished");
      } else if (event.cause === "bell" && !event.hasHookSource) {
        void push.notifyAttention(summary);
      }
    }
  );
```

Add the needed imports (`SessionActivity`, `SessionActivityEvent`, `RegistryKind` from `@orquester/api`; `ActivityCause` from `./sessions`' re-export or directly from `./ansi-activity`).

- [ ] **Step 5: Socket-only route.** In `createServer`, next to the other session routes (~line 1832), add — gated exactly like the daemon-config write (`options.mode === "local"`):

```ts
  if (options.mode === "local") {
    // Managed agent hooks report lifecycle events here (see the agent-status
    // design doc). Socket-only: sessions always run on the daemon's host, and
    // the unix socket is the single-user trust boundary — the HTTP transport
    // never exposes this surface. 204 fail-open on unknown events so a hook
    // can never break an agent.
    app.post<{ Params: { id: string }; Body: AgentEventRequest }>(
      "/api/sessions/:id/agent-event",
      async (request, reply): Promise<void> => {
        const body = request.body ?? ({} as AgentEventRequest);
        if (
          (body.source !== "claude" && body.source !== "codex" && body.source !== "opencode") ||
          typeof body.event !== "string"
        ) {
          return reply.code(204).send();
        }
        const known = sessions.agentEvent(request.params.id, body);
        return reply.code(known ? 204 : 404).send();
      }
    );
  }
```

- [ ] **Step 6: Verify**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/agent-status.ts apps/daemon/src/sessions.ts apps/daemon/src/index.ts apps/daemon/src/push.ts
git commit -m "feat(daemon): agent-event route, session.activity broadcast, push split"
```

---

### Task 5: Hook scripts + Claude installer

**Files:**
- Create: `apps/daemon/src/agent-hooks.ts`
- Modify: `apps/daemon/src/index.ts` (construct + wire `onAgentLaunch` and `daemonSockPath` into `createSessionManager` options at ~line 229)

**Interfaces:**
- Consumes: `SessionManagerOptions.onAgentLaunch` / `daemonSockPath` (Task 3).
- Produces:
  - `class AgentHooks { constructor(daemonDir: string, homeDir: string, logger?: { error(...a: unknown[]): void }); ensureForEntry(entryId: string): void }` — synchronous fire-and-forget facade; internally async + per-entry once-latch.
  - Script on disk: `<daemonDir>/hooks/agent-hook.sh` (mode 0755), invoked as `agent-hook.sh <source> <event>` with the hook payload JSON on stdin.

- [ ] **Step 1: Create `apps/daemon/src/agent-hooks.ts`** (script writer + claude installer now; codex/opencode installers land in Tasks 6/7 inside this same file):

```ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Logger {
  error(...args: unknown[]): void;
}

/** Bump when the script body changes so existing installs get rewritten. */
const SCRIPT_VERSION = 1;

/**
 * POSIX hook transport: no-op without a session id (agent launched outside
 * Orquester), otherwise POST the stdin payload to the daemon's unix socket.
 * Always exits 0 — a hook failure must never surface inside the agent.
 */
function hookScript(): string {
  return `#!/bin/sh
# orquester-managed agent hook v${SCRIPT_VERSION} — do not edit (rewritten by the daemon)
[ -n "$ORQUESTER_SESSION_ID" ] || exit 0
[ -n "$ORQUESTER_DAEMON_SOCK" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
source="$1"
event="$2"
payload=$(cat 2>/dev/null || printf '{}')
[ -n "$payload" ] || payload='{}'
printf '{"source":"%s","event":"%s","payload":%s}' "$source" "$event" "$payload" | \\
  curl -sS -X POST --unix-socket "$ORQUESTER_DAEMON_SOCK" \\
    --connect-timeout 0.5 --max-time 1.5 \\
    -H "Content-Type: application/json" \\
    --data-binary @- \\
    "http://localhost/api/sessions/$ORQUESTER_SESSION_ID/agent-event" >/dev/null 2>&1
exit 0
`;
}

async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await chmod(tmp, mode).catch(() => undefined);
  await rename(tmp, path);
}

/**
 * Installs managed status hooks into agent configs at launch time. Everything
 * here is best-effort: any failure logs and the session simply stays on the
 * bell/quiescence fallback. Never throws into the session-create path.
 */
export class AgentHooks {
  private readonly done = new Set<string>();

  constructor(
    private readonly daemonDir: string,
    private readonly homeDir: string,
    private readonly logger: Logger = console
  ) {}

  private get scriptPath(): string {
    return join(this.daemonDir, "hooks", "agent-hook.sh");
  }

  /** Fire-and-forget; deduped per entry id per daemon lifetime. */
  ensureForEntry(entryId: string): void {
    if (this.done.has(entryId) || process.platform === "win32") {
      return;
    }
    this.done.add(entryId);
    void this.install(entryId).catch((error) => {
      this.done.delete(entryId); // retry on the next launch
      this.logger.error(`agent-hooks: install failed for ${entryId}`, error);
    });
  }

  private async install(entryId: string): Promise<void> {
    if (entryId !== "claude" && entryId !== "codex" && entryId !== "opencode") {
      return;
    }
    await writeFileAtomic(this.scriptPath, hookScript(), 0o755);
    if (entryId === "claude") {
      await this.installClaude();
    } else if (entryId === "codex") {
      await this.installCodex();
    } else {
      await this.installOpenCode();
    }
  }

  // --- claude: managed hooks block in ~/.claude/settings.json ---------------

  private async installClaude(): Promise<void> {
    const settingsPath = join(this.homeDir, ".claude", "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
        throw new Error("settings.json is not an object");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Malformed user file: never clobber it.
        throw error;
      }
    }
    const hooks =
      settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
        ? (settings.hooks as Record<string, unknown>)
        : {};
    const events: Array<{ event: string; matcher?: string }> = [
      { event: "UserPromptSubmit" },
      { event: "PreToolUse", matcher: "*" },
      { event: "PostToolUse", matcher: "*" },
      { event: "PermissionRequest", matcher: "*" },
      { event: "Notification" },
      { event: "Stop" }
    ];
    let changed = false;
    for (const { event, matcher } of events) {
      const command = `"${this.scriptPath}" claude ${event}`;
      const managed = {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: 10 }]
      };
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      // Managed marker: any command referencing our hooks dir. Replace stale
      // versions in place; append when absent; leave user hooks untouched.
      const isOurs = (group: unknown): boolean =>
        JSON.stringify(group ?? "").includes(join(this.daemonDir, "hooks"));
      const withoutOurs = groups.filter((g) => !isOurs(g));
      const current = groups.find(isOurs);
      if (JSON.stringify(current) !== JSON.stringify(managed)) {
        hooks[event] = [...withoutOurs, managed];
        changed = true;
      }
    }
    if (changed) {
      settings.hooks = hooks;
      await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
    }
  }

  private async installCodex(): Promise<void> {
    // Task 6
  }

  private async installOpenCode(): Promise<void> {
    // Task 7
  }
}
```

- [ ] **Step 2: Wire into `startDaemon`.** In `index.ts` at the `createSessionManager` call (~line 229), construct `const agentHooks = new AgentHooks(resolved.daemonDir, homedir());` above it (import `AgentHooks` from `./agent-hooks`; `homedir` from `node:os` — check existing imports; **note**: in production `HOME=/var/lib/orquester` per daemon.env, so `homedir()` is the daemon user's home, which is exactly where sessions' agents read their config). Extend the options object:

```ts
  const sessions = createSessionManager(registry, tmux, resolved.sessionsIndexFile, {
    resolveExtraEnv: async (entry) => { /* existing body unchanged */ },
    daemonSockPath: paths.socketPath,
    onAgentLaunch: (entry) => agentHooks.ensureForEntry(entry.id)
  });
```

(`paths.socketPath` must be in scope at line 229 — it is currently resolved later at ~line 343; hoist the `paths` resolution above the `createSessionManager` call if needed. It comes from `resolveDaemonPaths`, which is pure path math — safe to hoist.)

- [ ] **Step 3: Verify**

Run: `pnpm check` — expected exit 0. Then spot-check the merge logic in isolation:

```bash
export SCRATCH=$(mktemp -d) && mkdir -p $SCRATCH/home/.claude
cat > $SCRATCH/home/.claude/settings.json <<'EOF'
{"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/home/user/my-own-stop.sh"}]}]}}
EOF
node --import tsx --input-type=module -e '
import { AgentHooks } from "./apps/daemon/src/agent-hooks.ts";
const scratch = process.env.SCRATCH;
const h = new AgentHooks(`${scratch}/daemon`, `${scratch}/home`);
h.ensureForEntry("claude");
setTimeout(async () => {
  const { readFile } = await import("node:fs/promises");
  const s = JSON.parse(await readFile(`${scratch}/home/.claude/settings.json`, "utf8"));
  console.log("model preserved:", s.model === "opus");
  console.log("user Stop hook preserved:", JSON.stringify(s.hooks.Stop).includes("my-own-stop.sh"));
  console.log("managed Stop hook added:", JSON.stringify(s.hooks.Stop).includes("agent-hook.sh"));
  console.log("PreToolUse matcher:", s.hooks.PreToolUse?.[0]?.matcher === "*");
}, 300);
' 
```
Expected: all four lines print `true`. Run it twice — second run must not change the file (idempotent).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/agent-hooks.ts apps/daemon/src/index.ts
git commit -m "feat(daemon): managed hook script + Claude Code hook installer"
```

---

### Task 6: Codex installer (hooks.json + config.toml trust)

**Files:**
- Modify: `apps/daemon/src/agent-hooks.ts` (fill `installCodex`)

**Reference:** Orca's implementation (cloned at the session scratchpad under `orca/`): `src/main/codex/config-toml-trust.ts` (`computeTrustedHash`, `canonicalize`, trust-block format) and `codex-hook-identity.ts` (event-label map). Key facts replicated below — the plan is self-contained.

**Interfaces:**
- Consumes: `writeFileAtomic`, `this.scriptPath`, `this.homeDir` from Task 5.
- Produces: `~/.codex/hooks.json` with our command hook **appended** per event (appending never shifts existing user groups' indices, so their trust keys stay valid — Orca prepends and pays for it with promotion machinery we don't want), and `[hooks.state."…"]` trust blocks in `~/.codex/config.toml`.

- [ ] **Step 1: Implement `installCodex` + helpers.** Replace the `// Task 6` stub with:

```ts
  // --- codex: hooks.json + config.toml trust entries ------------------------
  //
  // Codex >= 0.129 silently drops any hook without a matching
  // [hooks.state."<key>"] trust block whose trusted_hash equals Codex's own
  // canonical-JSON sha256 of the hook definition. We replicate that hash
  // (mirrors codex-rs command_hook_hash via Orca's config-toml-trust.ts).
  // Accepted risk: Codex owns the algorithm — if it drifts, hooks stop firing
  // and sessions degrade to quiescence; the log hint tells the user to run
  // /hooks in Codex to approve manually.

  private async installCodex(): Promise<void> {
    const codexHome = join(this.homeDir, ".codex");
    const hooksJsonPath = join(codexHome, "hooks.json");
    const configTomlPath = join(codexHome, "config.toml");

    const CODEX_EVENTS: Array<{ name: string; label: string; matcher?: string }> = [
      { name: "SessionStart", label: "session_start" },
      { name: "UserPromptSubmit", label: "user_prompt_submit" },
      { name: "PreToolUse", label: "pre_tool_use", matcher: "*" },
      { name: "PermissionRequest", label: "permission_request", matcher: "*" },
      { name: "PostToolUse", label: "post_tool_use", matcher: "*" },
      { name: "Stop", label: "stop" }
    ];

    // 1) hooks.json — Claude-shaped { hooks: { Event: [group…] } }. Codex
    // rejects unknown top-level fields, so preserve only "hooks".
    let hooksDoc: { hooks: Record<string, unknown[]> } = { hooks: {} };
    try {
      const parsed = JSON.parse(await readFile(hooksJsonPath, "utf8")) as {
        hooks?: Record<string, unknown[]>;
      };
      if (parsed && typeof parsed === "object" && parsed.hooks && typeof parsed.hooks === "object") {
        hooksDoc = { hooks: parsed.hooks };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error; // malformed user file — do not clobber
      }
    }

    const managedFor = (event: { name: string; matcher?: string }) => ({
      ...(event.matcher !== undefined ? { matcher: event.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: `"${this.scriptPath}" codex ${event.name}`,
          timeout: 10
        }
      ]
    });
    const hooksDirMarker = join(this.daemonDir, "hooks");
    const isOurs = (group: unknown): boolean =>
      JSON.stringify(group ?? "").includes(hooksDirMarker);

    let changed = false;
    // Trust identity depends on the group index — compute AFTER the final
    // array shape is known.
    const trustTargets: Array<{ label: string; matcher?: string; groupIndex: number; command: string }> = [];
    for (const event of CODEX_EVENTS) {
      const managed = managedFor(event);
      const groups = Array.isArray(hooksDoc.hooks[event.name])
        ? hooksDoc.hooks[event.name]
        : [];
      const withoutOurs = groups.filter((g) => !isOurs(g));
      const current = groups.find(isOurs);
      const next = [...withoutOurs, managed]; // append: user group indices stay stable
      if (JSON.stringify(current) !== JSON.stringify(managed) || groups.length !== next.length) {
        hooksDoc.hooks[event.name] = next;
        changed = true;
      } else {
        hooksDoc.hooks[event.name] = groups;
      }
      trustTargets.push({
        label: event.label,
        matcher: event.matcher,
        groupIndex: (hooksDoc.hooks[event.name] as unknown[]).length - 1,
        command: (managed.hooks[0] as { command: string }).command
      });
    }
    if (changed) {
      await writeFileAtomic(hooksJsonPath, `${JSON.stringify(hooksDoc, null, 2)}\n`, 0o644);
    }

    // 2) config.toml trust blocks — written LAST so a half-write can't point
    // at a nonexistent hook.
    let toml = "";
    try {
      toml = await readFile(configTomlPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    let tomlNext = toml;
    for (const t of trustTargets) {
      const key = `${hooksJsonPath}:${t.label}:${t.groupIndex}:0`;
      const hash = codexTrustHash(t.label, t.command, t.matcher);
      tomlNext = upsertCodexTrustBlock(tomlNext, key, hash);
    }
    if (tomlNext !== toml) {
      await writeFileAtomic(configTomlPath, tomlNext, 0o644);
    }
  }
```

- [ ] **Step 2: Add the two module-level helpers** (bottom of `agent-hooks.ts`; `createHash` from `node:crypto` added to imports):

```ts
/** Recursively sort object keys (Codex's canonical_json); arrays keep order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Mirrors codex-rs command_hook_hash: sha256 over canonical JSON of
 * { event_name, hooks: [handler], matcher? }. Codex drops matchers on
 * user_prompt_submit/stop before hashing (codex-rs matcher_pattern_for_event),
 * so including one there would yield a hash Codex never writes.
 */
function codexTrustHash(eventLabel: string, command: string, matcher?: string): string {
  const handler = { type: "command", command, timeout: 10, async: false };
  const identity: Record<string, unknown> = { event_name: eventLabel, hooks: [handler] };
  const effectiveMatcher =
    eventLabel === "user_prompt_submit" || eventLabel === "stop" ? undefined : matcher;
  if (effectiveMatcher !== undefined) {
    identity.matcher = effectiveMatcher;
  }
  const serialized = JSON.stringify(canonicalize(identity));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function escapeTomlString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/**
 * Upsert one [hooks.state."<key>"] block (enabled + trusted_hash), replacing an
 * existing block for the same key. Line-based: a block ends at the next table
 * header or EOF. Preserves a user-set `enabled = false`.
 */
function upsertCodexTrustBlock(content: string, key: string, hash: string): string {
  const header = `[hooks.state."${escapeTomlString(key)}"]`;
  const lines = content.length === 0 ? [] : content.split("\n");
  const headerIdx = lines.findIndex((line) => line.trim() === header);
  if (headerIdx === -1) {
    const block = [header, "enabled = true", `trusted_hash = "${escapeTomlString(hash)}"`];
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") {
      out.push("");
    }
    out.push(...block, "");
    return out.join("\n");
  }
  let end = headerIdx + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) {
    end++;
  }
  const block = lines.slice(headerIdx, end);
  const disabled = block.some((l) => /^\s*enabled\s*=\s*false\s*$/.test(l));
  const replacement = [
    header,
    `enabled = ${!disabled}`,
    `trusted_hash = "${escapeTomlString(hash)}"`
  ];
  return [...lines.slice(0, headerIdx), ...replacement, ...lines.slice(end)].join("\n");
}
```

- [ ] **Step 3: Verify.** `pnpm check` → exit 0. Then simulate an install against a scratch home (same pattern as Task 5 Step 3, `ensureForEntry("codex")`): assert `hooks.json` has all 6 events each ending with our appended group; `config.toml` contains 6 `[hooks.state."…hooks.json:…"]` blocks with `sha256:` hashes; re-run is byte-identical (idempotent); a pre-existing user hook group in `hooks.json` keeps index 0 and a pre-seeded `enabled = false` in one trust block survives as `enabled = false`.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/agent-hooks.ts
git commit -m "feat(daemon): Codex hook installer with config.toml trust entries"
```

---

### Task 7: OpenCode plugin installer

**Files:**
- Modify: `apps/daemon/src/agent-hooks.ts` (fill `installOpenCode`)

**Interfaces:**
- Consumes: `writeFileAtomic` (Task 5).
- Produces: `~/.config/opencode/plugin/orquester-status.js` — an OpenCode plugin posting `SessionBusy`/`SessionIdle`/`PermissionRequest`/`AskUserQuestion` to the daemon socket via `node:http` `socketPath`.

- [ ] **Step 1: Implement `installOpenCode`.** Replace the `// Task 7` stub with:

```ts
  // --- opencode: status plugin in the global plugin dir ---------------------

  private async installOpenCode(): Promise<void> {
    const pluginPath = join(this.homeDir, ".config", "opencode", "plugin", "orquester-status.js");
    const source = openCodePluginSource();
    let current = "";
    try {
      current = await readFile(pluginPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (current !== source) {
      await writeFileAtomic(pluginPath, source, 0o644);
    }
  }
```

- [ ] **Step 2: Add the plugin source builder** (module level, bottom of the file):

```ts
/**
 * OpenCode status plugin. Runs inside OpenCode's own runtime, so transport is
 * node:http over the daemon's unix socket (no curl). Design notes:
 *  - no-ops without ORQUESTER_SESSION_ID/ORQUESTER_DAEMON_SOCK (runs outside
 *    Orquester, or on Windows);
 *  - opaque ctx, no destructuring — OpenCode may invoke the factory with
 *    undefined during startup;
 *  - child-session guard: a tool-spawned child session's busy/idle must not
 *    flip the pane; parent lookup fails CLOSED (assume child);
 *  - no message-part subscription at all (state transitions only).
 */
function openCodePluginSource(): string {
  return `// orquester-managed status plugin v${SCRIPT_VERSION} — do not edit (rewritten by the daemon)
import http from "node:http";

const SESSION_ID = process.env.ORQUESTER_SESSION_ID || "";
const SOCK = process.env.ORQUESTER_DAEMON_SOCK || "";

function post(event, payload) {
  if (!SESSION_ID || !SOCK) return;
  try {
    const body = JSON.stringify({ source: "opencode", event, payload: payload || {} });
    const req = http.request(
      {
        socketPath: SOCK,
        path: "/api/sessions/" + SESSION_ID + "/agent-event",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 1500
      },
      (res) => res.resume()
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(body);
  } catch {
    // never let status reporting break the agent
  }
}

export const OrquesterStatusPlugin = async (ctx) => {
  const client = ctx && ctx.client ? ctx.client : null;
  const childCache = new Map();

  async function isChildSession(sessionID) {
    if (!sessionID) return true; // fail closed
    if (childCache.has(sessionID)) return childCache.get(sessionID);
    let child = true; // fail closed on lookup errors
    try {
      if (client && client.session && typeof client.session.get === "function") {
        const info = await client.session.get({ path: { id: sessionID } });
        const data = info && (info.data || info);
        child = Boolean(data && data.parentID);
      }
    } catch {
      child = true;
    }
    childCache.set(sessionID, child);
    return child;
  }

  let lastStatus = "";

  return {
    event: async (input) => {
      const event = input && input.event ? input.event : null;
      if (!event || !event.type) return;
      const props = event.properties || {};
      if (event.type === "permission.asked") {
        post("PermissionRequest", {});
        return;
      }
      if (event.type === "question.asked") {
        post("AskUserQuestion", {});
        return;
      }
      if (event.type === "session.status" || event.type === "session.idle" || event.type === "session.error") {
        const sessionID = props.sessionID || (props.status && props.status.sessionID) || "";
        if (await isChildSession(sessionID)) return;
        const statusType =
          event.type === "session.status" && props.status && props.status.type
            ? props.status.type
            : "idle";
        const busy = statusType === "busy" || statusType === "retry";
        const next = busy ? "SessionBusy" : "SessionIdle";
        if (next === lastStatus) return;
        lastStatus = next;
        post(next, {});
      }
    }
  };
};
`;
}
```

- [ ] **Step 3: Verify.** `pnpm check` → exit 0. Then `node --check` the emitted plugin:

```bash
export SCRATCH=$(mktemp -d)
node --import tsx --input-type=module -e '
import { AgentHooks } from "./apps/daemon/src/agent-hooks.ts";
new AgentHooks(process.env.SCRATCH + "/daemon", process.env.SCRATCH + "/home").ensureForEntry("opencode");
setTimeout(() => {}, 300);
'
node --check "$SCRATCH/home/.config/opencode/plugin/orquester-status.js" && echo PLUGIN-SYNTAX-OK
```
Expected: `PLUGIN-SYNTAX-OK`.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/agent-hooks.ts
git commit -m "feat(daemon): OpenCode status plugin installer"
```

---

### Task 8: MCP terminal-control on the shared state

**Files:**
- Modify: `apps/daemon/src/mcp/terminal-control.ts`
- Modify: `apps/daemon/src/mcp/server.ts` (only if tool hint text mentions bell-only attention — update wording)

**Interfaces:**
- Consumes: `SessionActivity` (attention is now `SessionAttention | null`), lifecycle `"activity"` payload `{ id, activity, cause, hasHookSource, kind }`.
- Produces: `ActivityFields` reported to MCP becomes `{ activity: "working" | "waiting" | "idle"; attention: "bell" | "needs-input" | "finished" | null; lastOutputAt?: string }`.

- [ ] **Step 1: Rework `activityFields()`** (replacing Task 3's shim) to pass the tracker state through verbatim:

```ts
      activity: activity.state,
      attention: activity.attention,
      lastOutputAt: activity.lastOutputAt ?? undefined
```

Update the `ActivityFields` type and any zod/JSON-schema output description accordingly (`attention` is a string enum or null, no longer boolean). `ACTIVITY_WORKING_MS` becomes unused — delete it and its import sites.

- [ ] **Step 2: `waitForAttention`** already listens on `"activity"` (Task 3 shim); confirm the resolve predicate is `event.activity.attention !== null` and update its doc/tool-hint text: attention now also fires structurally (agent hooks report needs-input/finished), not just on bell/exit. `waitForIdle`/`sendAndWait` quiescence logic: replace any remaining `Date.now() - lastOutputAt` computation with `activity.state !== "working"` where it checks idleness, keeping the timeout loops otherwise unchanged.

- [ ] **Step 3: Verify + commit**

```bash
pnpm check
git add apps/daemon/src/mcp/terminal-control.ts apps/daemon/src/mcp/server.ts
git commit -m "feat(mcp): terminal-control reads shared activity state"
```

---

### Task 9: UI consumes server activity

**Files:**
- Modify: `packages/ui/src/store/app.ts`
- Modify: `packages/ui/src/components/terminal/TerminalView.tsx`
- Modify: `packages/ui/src/components/ui/session-status-dot.tsx`
- Check-and-update: whatever defines `useSessionActivity` (grep `useSessionActivity` — likely `app.ts` or a hooks file) and any other `noteSessionActivity`/`noteSessionBell` callers (grep before deleting).

**Interfaces:**
- Consumes: `SessionActivity` from `@orquester/api`, `session.activity` events, `SessionSummary.activity`.
- Produces: `activityById: Record<string, SessionActivity>` (server-shaped), `localAttentionCleared: Record<string, string>` — a client-local acknowledgment map (see Step 3).

- [ ] **Step 1: Delete client derivation in `app.ts`.** Remove: `IDLE_THRESHOLD_MS`, `idleTimers`, `clearIdleTimer`, `rearmIdleTimer`, the local `SessionActivity` interface (lines ~404-453; import the type from `@orquester/api` instead — note field shape changes: `attention` is `SessionAttention | null`, plus `lastOutputAt`), and the actions `noteSessionActivity` + `noteSessionBell` (their AppState type members too). Keep `dropActivity` as-is. Remove the two `clearIdleTimer(...)` calls in `applyEvent`/`removeSession` (the timers no longer exist).

- [ ] **Step 2: Seed + apply events.** In `applyEvent`, extend the sessions-channel handling:

```ts
    if (event.type === "session.activity") {
      const { id, activity } = event.payload as SessionActivityEvent;
      set((state) => ({ activityById: { ...state.activityById, [id]: activity } }));
      return;
    }
```

and in the `session.created` / `session.updated` branch (and wherever the full session list is loaded into the store — grep for the action that sets `sessions:` from `api.listSessions()`), seed `activityById[summary.id] = summary.activity` when `summary.activity` is present:

```ts
      set((state) => ({
        sessions: upsertSession(state.sessions, summary),
        ...(summary.activity
          ? { activityById: { ...state.activityById, [summary.id]: summary.activity } }
          : {})
      }));
```

- [ ] **Step 3: Local acknowledgment (`clearSessionAttention`).** The daemon clears attention on *input*; focusing a tab sends no input, so acknowledgment-on-focus stays client-local per the spec. Reshape `clearSessionAttention` to null out the attention field locally (server events later overwrite):

```ts
  clearSessionAttention: (id) => {
    const current = get().activityById[id];
    if (!current || current.attention === null) {
      return;
    }
    set((state) => ({
      activityById: { ...state.activityById, [id]: { ...current, attention: null } }
    }));
  },
```

- [ ] **Step 4: `TerminalView.tsx`.** Delete the `noteSessionActivity` call in `openSessionOutput.onData` (keep `term.write` + `forceAgentRepaint`), and delete the whole `bellSub` block (`term.onBell` wiring + its dispose). Keep both `clearSessionAttention` calls (input handler + focus effect).

- [ ] **Step 5: Status dot.** Replace the non-exited branch of `SessionStatusDot`:

```tsx
  const activity = useSessionActivity(sessionId);
  if (status === "exited") { /* unchanged gray */ }
  const state = activity?.state ?? "idle";
  const attention = activity?.attention ?? null;
  const label =
    attention === "needs-input" ? "Needs your input"
    : attention === "finished" ? "Finished"
    : attention === "bell" ? "Waiting for you"
    : state === "working" ? "Working"
    : state === "waiting" ? "Waiting" : "Idle";
  return (
    <Circle
      size={7}
      aria-label={label}
      className={cn(
        "shrink-0",
        state === "working"
          ? "fill-amber-400 text-amber-400"
          : state === "waiting"
            ? "fill-amber-400 text-amber-400"
            : "fill-green-400 text-green-400",
        (attention !== null || state === "waiting") && "animate-pulse",
        className
      )}
    />
  );
```

(Waiting = amber pulse; finished/bell = green pulse; plain amber = working; plain green = idle — exactly the spec's rendering.)

- [ ] **Step 6: Sweep remaining references.** `grep -rn "noteSessionActivity\|noteSessionBell\|IDLE_THRESHOLD_MS" packages/ apps/` → must return nothing. Fix any stragglers (e.g. mobile key bar or grid components).

- [ ] **Step 7: Verify + commit**

```bash
pnpm check
git add -u packages/ui
git commit -m "feat(ui): server-driven session activity (dots survive reload)"
```

---

### Task 10: Docs + final review pass

**Files:**
- Modify: `AGENTS.md` (the PWA/push bullet in *Conventions & gotchas*, and the appdir layout block)

- [ ] **Step 1: Update AGENTS.md.** In the appdir layout, add `hooks/ (managed agent hook script)` to the `daemon/` line. Replace the stale push sentence ("pushes fire only from **agent**-session bells (shell beeps never push), debounced per session") with:

```
pushes fire from agent-session status: hook-reporting agents (claude/codex/opencode
via managed hooks → `POST /api/sessions/:id/agent-event`, unix-socket-only) send
distinct "needs your input" / "finished" pushes; agents without hook coverage keep
the bell fallback. Debounced 30 s per session per type. Session activity
(working/waiting/idle + attention) lives on SessionSummary.activity and streams as
`session.activity` events — the UI never re-derives it.
```

- [ ] **Step 2: Full-diff self-review.** `git diff main~N --stat` (all task commits), re-read the spec end-to-end, confirm each spec section maps to landed code: state model (Task 2/3), wire surface (1/4), mapping table (4), hook delivery (5), installers (5/6/7), push (4), UI (9), MCP (8). Run the Task 3 Step 7 and Task 5 Step 3 spot-checks once more.

- [ ] **Step 3: Final gate + commit**

```bash
pnpm check
git add AGENTS.md
git commit -m "docs: agent-status architecture in AGENTS.md"
```

- [ ] **Step 4: Report.** Summarize to the user: what landed, the accepted risks (Codex trust-hash drift; Claude `PermissionRequest` event name pending verification against the installed CLI — flag it explicitly), and that live verification (scratch appdir + real agents + push) is available on request but was not run per the no-daemon rule.
