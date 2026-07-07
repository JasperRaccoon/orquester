# Orquester MCP v2 (Todos, Attention, File Reads, Usage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the Orquester MCP from 11 terminal-control tools to 20 — todo-list CRUD with an atomic item toggle, a daemon-side bell/activity engine with project-wide `wait_for_attention`, sandboxed read-only file tools, `get_usage` — plus two usage-honesty root fixes.

**Architecture:** All new tools register in `apps/daemon/src/mcp/server.ts`'s `buildServer` through the existing `tool()` helper, backed by three thin new modules beside `terminal-control.ts` (`todo-tools.ts`, `ansi-activity.ts`, `fs-tools.ts`) and small additions to `sessions.ts` (per-session activity tracking) and `terminal-control.ts` (`waitForAttention`, activity fields). The spec is `docs/superpowers/specs/2026-07-07-mcp-v2-todos-attention-fsread-design.md`.

**Tech Stack:** TypeScript 5.8 ESM run by tsx (no build), Fastify 4, `@modelcontextprotocol/sdk`, zod 3, `node:test` + `node:assert/strict` for tests. No new dependencies.

## Global Constraints

- **⛔ Never start a daemon from this checkout** (no `pnpm dev*`, no `tsx src/cli.ts`, no port/socket binds, no `systemctl`) — a live daemon serves this repo. Verification = typecheck + unit tests only.
- **Typecheck gate (run from repo root):** `pnpm check` — must be clean before every commit.
- **Test commands (run from `apps/daemon/`):** single file `node --import tsx --test src/mcp/<file>.test.ts`; whole suite `pnpm test` (runs `node --import tsx --test $(find src -name '*.test.ts')`).
- **Imports inside `apps/daemon/src` use explicit `.ts` extensions** (e.g. `from "../todos.ts"`, `from "./terminal-control.ts"`), matching the existing `mcp/` files.
- **Tool naming:** snake_case `verb_noun`. Success = `ok(JSON.stringify(value))`; every handler's errors flow through `toSafeToolError`; zod schemas are raw shapes (`Record<string, z.ZodTypeAny>`), defaults applied in the implementation, not the schema.
- **Error messages** thrown as `ToolError`/`TabNotFound`/`TodoError` must never contain filesystem paths outside the sandbox, stack traces, or secrets. `FsSandboxError` is already mapped to a generic message — never bypass that.
- **`SERVER_INSTRUCTIONS` must stay ≤ 2048 characters** (currently 1277).
- **Constants (verbatim from the spec):** `ACTIVITY_WORKING_MS = 3000` · `MAX_FS_ENTRIES = 500` · `DEFAULT_READ_BYTES = 64 * 1024` · `MAX_READ_BYTES = 256 * 1024` · binary sniff window `8 * 1024` bytes · waits reuse the existing `DEFAULT_TIMEOUT_MS = 120_000` / `MAX_TIMEOUT_MS = 600_000`.
- **Tasks are ordered; execute in sequence** (Tasks 2, 6, 8, 9 each grow the same `McpDeps` interface in `server.ts`; each task shows the exact state it expects).
- **Commits:** one per task, message shown in the task; end the body with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Todo tools module

**Files:**
- Create: `apps/daemon/src/mcp/todo-tools.ts`
- Test: `apps/daemon/src/mcp/todo-tools.test.ts`

**Interfaces:**
- Consumes: `TodoListManager` from `apps/daemon/src/todos.ts` (`list(scope, refKey): TodoRecord[]`, `get(id)`, `create(scope, refKey, name?)`, `update(id, {name?, body?})`, `delete(id)`; `TodoError` has `.status`); `isValidName` from `@orquester/config`; `TabNotFound`, `ToolError` from `./terminal-control.ts`.
- Produces (used by Task 2): `class TodoTools` with constructor `new TodoTools({ todos: TodoListManager, workspacesDir: string })` and methods:
  - `list(sel: { workspace: string; project?: string }): TodoProjection[]`
  - `create(sel: { workspace: string; project?: string }, name: string): Promise<TodoProjection>`
  - `update(id: string, patch: { name?: string; body?: string }): Promise<TodoProjection>`
  - `remove(id: string): Promise<{ deleted: true }>`
  - `toggleItem(id: string, item: string | number, checked?: boolean): Promise<{ id: string; item: string; checked: boolean; body: string }>`
  - `type TodoProjection = { id: string; name: string; scope: "workspace" | "project"; body: string; createdAt: string; updatedAt: string }` (note: **no `refKey`**).

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/mcp/todo-tools.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TodoListManager } from "../todos.ts";
import { TabNotFound, ToolError } from "./terminal-control.ts";
import { TodoTools } from "./todo-tools.ts";

async function make() {
  const root = await mkdtemp(join(tmpdir(), "todo-tools-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const todos = new TodoListManager(join(root, "state", "todos.json"));
  return { root, todos, tools: new TodoTools({ todos, workspacesDir: root }) };
}

test("workspace scope: create → list; refKey is the workspace name and is NOT projected", async () => {
  const { todos, tools } = await make();
  const created = await tools.create({ workspace: "w" }, "Sprint");
  assert.equal(created.name, "Sprint");
  assert.equal(created.scope, "workspace");
  assert.ok(!("refKey" in created), "projection must omit refKey");
  const listed = tools.list({ workspace: "w" });
  assert.deepEqual(listed.map((t) => t.id), [created.id]);
  assert.equal(todos.list("workspace", "w").length, 1); // stored under the workspace NAME
});

test("project scope: refKey is the project PATH (join of workspacesDir/w/p)", async () => {
  const { root, todos, tools } = await make();
  const created = await tools.create({ workspace: "w", project: "p" }, "Tasks");
  assert.equal(created.scope, "project");
  assert.equal(todos.list("project", join(root, "w", "p")).length, 1);
  assert.equal(tools.list({ workspace: "w", project: "p" })[0].id, created.id);
});

test("invalid names and missing dirs are rejected before any path join", async () => {
  const { tools } = await make();
  assert.throws(() => tools.list({ workspace: ".." }), TabNotFound);
  assert.throws(() => tools.list({ workspace: "w", project: "../x" }), TabNotFound);
  await assert.rejects(() => tools.create({ workspace: "nope" }, "x"), TabNotFound);
  await assert.rejects(() => tools.create({ workspace: "w", project: "missing" }, "x"), TabNotFound);
});

test("update renames and replaces body; remove deletes", async () => {
  const { tools } = await make();
  const t = await tools.create({ workspace: "w" }, "a");
  const up = await tools.update(t.id, { name: "b", body: "- [ ] one" });
  assert.equal(up.name, "b");
  assert.equal(up.body, "- [ ] one");
  await tools.remove(t.id);
  assert.equal(tools.list({ workspace: "w" }).length, 0);
});

test("toggleItem by 1-based index flips, sets, and preserves non-task lines", async () => {
  const { tools } = await make();
  const t = await tools.create({ workspace: "w" }, "a");
  await tools.update(t.id, { body: "# Heading\n- [ ] first\ntext\n- [x] second" });
  const r1 = await tools.toggleItem(t.id, 1);            // flip → checked
  assert.equal(r1.checked, true);
  assert.equal(r1.item, "first");
  assert.equal(r1.body, "# Heading\n- [x] first\ntext\n- [x] second");
  const r2 = await tools.toggleItem(t.id, 2, false);     // explicit set
  assert.equal(r2.body, "# Heading\n- [x] first\ntext\n- [ ] second");
});

test("toggleItem by text: exact-after-trim, case-insensitive", async () => {
  const { tools } = await make();
  const t = await tools.create({ workspace: "w" }, "a");
  await tools.update(t.id, { body: "- [ ] Fix the Bug  " });
  const r = await tools.toggleItem(t.id, "fix the bug");
  assert.equal(r.checked, true);
});

test("toggleItem errors: empty list, no match (lists items), ambiguous text", async () => {
  const { tools } = await make();
  const t = await tools.create({ workspace: "w" }, "a");
  await assert.rejects(() => tools.toggleItem(t.id, 1), ToolError); // no task items
  await tools.update(t.id, { body: "- [ ] dup\n- [ ] dup\n- [ ] other" });
  await assert.rejects(() => tools.toggleItem(t.id, "nope"), /other/); // error lists the items
  await assert.rejects(() => tools.toggleItem(t.id, "dup"), /index/);  // ambiguous → use index
  await assert.rejects(() => tools.toggleItem("no-such-id", 1), ToolError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/daemon/`): `node --import tsx --test src/mcp/todo-tools.test.ts`
Expected: FAIL — `Cannot find module './todo-tools.ts'`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/mcp/todo-tools.ts`:

```ts
import { join } from "node:path";
import { statSync } from "node:fs";
import type { TodoScope } from "@orquester/api";
import { isValidName, type TodoRecord } from "@orquester/config";
import type { TodoListManager } from "../todos.ts";
import { TabNotFound, ToolError } from "./terminal-control.ts";

export interface TodoToolsDeps {
  todos: TodoListManager;
  workspacesDir: string;
}

/** MCP projection of a todo record — refKey omitted (the caller addressed the scope). */
export type TodoProjection = {
  id: string;
  name: string;
  scope: TodoScope;
  body: string;
  createdAt: string;
  updatedAt: string;
};

/** GitHub task-list line: indent, "-"/"*" bullet, "[ ]"/"[x]" mark, rest. */
const TASK_LINE = /^(\s*[-*] \[)( |x|X)(\] ?)(.*)$/;

function project(r: TodoRecord): TodoProjection {
  return { id: r.id, name: r.name, scope: r.scope, body: r.body, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

export class TodoTools {
  constructor(private readonly deps: TodoToolsDeps) {}

  /** project given → scope "project" with refKey = its PATH; else scope "workspace" with refKey = the NAME. */
  private resolveScope(sel: { workspace: string; project?: string }): { scope: TodoScope; refKey: string } {
    if (!isValidName(sel.workspace)) {
      throw new TabNotFound("Invalid workspace name.");
    }
    if (sel.project === undefined) {
      if (!statSafe(join(this.deps.workspacesDir, sel.workspace))?.isDirectory()) {
        throw new TabNotFound(`No workspace "${sel.workspace}".`);
      }
      return { scope: "workspace", refKey: sel.workspace };
    }
    if (!isValidName(sel.project)) {
      throw new TabNotFound("Invalid project name.");
    }
    const projectPath = join(this.deps.workspacesDir, sel.workspace, sel.project);
    if (!statSafe(projectPath)?.isDirectory()) {
      throw new TabNotFound(`No project "${sel.project}" in "${sel.workspace}".`);
    }
    return { scope: "project", refKey: projectPath };
  }

  list(sel: { workspace: string; project?: string }): TodoProjection[] {
    const { scope, refKey } = this.resolveScope(sel);
    return this.deps.todos.list(scope, refKey).map(project);
  }

  async create(sel: { workspace: string; project?: string }, name: string): Promise<TodoProjection> {
    const { scope, refKey } = this.resolveScope(sel);
    return project(await this.deps.todos.create(scope, refKey, name));
  }

  async update(id: string, patch: { name?: string; body?: string }): Promise<TodoProjection> {
    return project(await this.deps.todos.update(id, patch));
  }

  async remove(id: string): Promise<{ deleted: true }> {
    await this.deps.todos.delete(id);
    return { deleted: true as const };
  }

  /**
   * Atomically tick one task item. `item` = 1-based index over the task lines, or
   * exact-after-trim case-insensitive text. `checked` omitted = flip. The
   * get→mutate→update runs with no await between read and write construction, so
   * concurrent MCP ticks can't interleave; against a UI full-body save it touches
   * only this one line.
   */
  async toggleItem(id: string, item: string | number, checked?: boolean) {
    const rec = this.deps.todos.get(id);
    if (!rec) {
      throw new ToolError("Todo list not found.");
    }
    const lines = rec.body.split("\n");
    const items: { line: number; checked: boolean; text: string; pre: string; post: string; rest: string }[] = [];
    lines.forEach((l, i) => {
      const m = TASK_LINE.exec(l);
      if (m) {
        items.push({ line: i, checked: m[2] !== " ", text: m[4].trim(), pre: m[1], post: m[3], rest: m[4] });
      }
    });
    if (items.length === 0) {
      throw new ToolError("The list has no task items ('- [ ] …' lines).");
    }
    const listing = () => items.map((it, i) => `${i + 1}. ${it.text}`).join("; ");
    let target: (typeof items)[number];
    if (typeof item === "number") {
      const hit = items[item - 1];
      if (!hit) {
        throw new ToolError(`No item ${item}. Items: ${listing()}`);
      }
      target = hit;
    } else {
      const want = item.trim().toLowerCase();
      const matches = items.filter((it) => it.text.toLowerCase() === want);
      if (matches.length === 0) {
        throw new ToolError(`No item "${item}". Items: ${listing()}`);
      }
      if (matches.length > 1) {
        throw new ToolError(`"${item}" matches ${matches.length} items — retry with the 1-based index.`);
      }
      target = matches[0];
    }
    const next = checked ?? !target.checked;
    lines[target.line] = `${target.pre}${next ? "x" : " "}${target.post}${target.rest}`;
    const updated = await this.deps.todos.update(id, { body: lines.join("\n") });
    return { id: updated.id, item: target.text, checked: next, body: updated.body };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/mcp/todo-tools.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /var/lib/orquester/workspaces/appsstats/orquester && pnpm check
git add apps/daemon/src/mcp/todo-tools.ts apps/daemon/src/mcp/todo-tools.test.ts
git commit -m "feat(daemon/mcp): TodoTools — scope resolution, CRUD projection, atomic toggleItem"
```

---

### Task 2: Register the 5 todo tools

**Files:**
- Modify: `apps/daemon/src/mcp/server.ts` (imports, `toSafeToolError`, new `McpDeps`, `buildServer`/`registerMcp` signatures, version bump, 5 registrations)
- Modify: `apps/daemon/src/index.ts:1886-1898` (the `registerMcp` call site)
- Test: `apps/daemon/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `TodoTools` (Task 1), `TodoError` from `../todos.ts` (`.status: number`, safe messages like `"todo not found"`).
- Produces (Tasks 6/8/9 grow this): `export interface McpDeps { control: TerminalControl; todos: TodoTools }`; `registerMcp(app: FastifyInstance, deps: McpDeps)`; `buildServer(deps: McpDeps, signal: AbortSignal)`. Server version `"1.1.0"`.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/mcp/server.test.ts`:

```ts
import { TodoError } from "../todos.ts";

test("TodoError surfaces its (safe) message", () => {
  const r = toSafeToolError(new TodoError(404, "todo not found"));
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "todo not found");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/mcp/server.test.ts`
Expected: FAIL — `todo not found` collapsed to `"Internal error handling the tool call."` (no TodoError branch yet).

- [ ] **Step 3: Modify `server.ts`**

3a. Add imports (after the existing `terminal-control.ts` import at the top):

```ts
import { TodoError } from "../todos.ts";
import { TodoTools } from "./todo-tools.ts";
```

3b. In `toSafeToolError`, insert a branch after the `SessionError` branch:

```ts
  } else if (err instanceof TodoError) {
    message = err.message; // TodoListManager's own — safe ("todo not found", "invalid scope")
  } else if (err instanceof FsSandboxError) {
```

3c. Introduce `McpDeps` and change the two signatures. Replace:

```ts
/** Build a per-request McpServer with all 11 tools bound to `control`. */
function buildServer(control: TerminalControl, signal: AbortSignal): McpServer {
  const server = new McpServer(
    { name: "orquester", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
```

with:

```ts
/** Everything the per-request server needs; grows as tool families are added. */
export interface McpDeps {
  control: TerminalControl;
  todos: TodoTools;
}

/** Build a per-request McpServer with all tools bound to the injected deps. */
function buildServer(deps: McpDeps, signal: AbortSignal): McpServer {
  const { control, todos } = deps;
  const server = new McpServer(
    { name: "orquester", version: "1.1.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
```

3d. Register the 5 tools, after the existing `close_tab` registration and before `return server;`:

```ts
  tool("list_todos",
    "List a workspace's (project's, if given) shared todo lists — the human sees them live in the UI.",
    { workspace: z.string(), project: z.string().optional() },
    (a) => todos.list({ workspace: a.workspace, project: a.project })
  );
  tool("create_todo",
    "Create a shared todo list in a workspace (or project). Body starts empty — fill it with update_todo.",
    { workspace: z.string(), project: z.string().optional(), name: z.string() },
    (a) => todos.create({ workspace: a.workspace, project: a.project }, a.name)
  );
  tool("update_todo",
    "Rename a todo list and/or replace its whole markdown body ('- [ ] item' lines). To tick ONE item use toggle_todo_item (atomic — no clobber).",
    { id: z.string(), name: z.string().optional(), body: z.string().optional() },
    (a) => todos.update(a.id, { name: a.name, body: a.body })
  );
  tool("delete_todo", "Delete a todo list.", { id: z.string() }, (a) => todos.remove(a.id));
  tool("toggle_todo_item",
    "Atomically check/uncheck one task item by 1-based index or exact text; omit checked to flip. Prefer this over update_todo for ticks.",
    { id: z.string(), item: z.union([z.string(), z.number().int()]), checked: z.boolean().optional() },
    (a) => todos.toggleItem(a.id, a.item, a.checked)
  );
```

3e. Change `registerMcp`'s signature and the one `buildServer` call inside it:

```ts
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
```
and
```ts
    const server = buildServer(deps, ctrl.signal);
```

- [ ] **Step 4: Modify the call site in `apps/daemon/src/index.ts`**

Add to the imports near the existing `import { registerMcp } from "./mcp/server.ts";` (line ~54):

```ts
import { TodoTools } from "./mcp/todo-tools.ts";
```

Replace `registerMcp(app, control);` (line ~1897, inside the `options.mode === "remote"` block) with:

```ts
    registerMcp(app, {
      control,
      todos: new TodoTools({ todos, workspacesDir: resolved.workspacesDir }),
    });
```

(`todos` — the `TodoListManager` — is already destructured from `services` at the top of `createServer`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test src/mcp/server.test.ts` → PASS (incl. the new TodoError test).
Run: `node --import tsx --test src/mcp/todo-tools.test.ts` → still PASS.
Run from root: `pnpm check` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/mcp/server.ts apps/daemon/src/mcp/server.test.ts apps/daemon/src/index.ts
git commit -m "feat(daemon/mcp): register todo tools (list/create/update/delete/toggle); McpDeps; v1.1.0"
```

---

### Task 3: ANSI-aware bell scanner + activity tracker

**Files:**
- Create: `apps/daemon/src/ansi-activity.ts` (daemon core, not `mcp/` — sessions.ts consumes it)
- Test: `apps/daemon/src/ansi-activity.test.ts`

**Interfaces:**
- Produces (used by Tasks 4/5):
  - `class BellScanner { feed(chunk: string): number }` — count of REAL bells (BEL in ground state); escape-state persists across chunks.
  - `interface ActivitySnapshot { lastOutputAt: number | null; attention: boolean }`
  - `class ActivityTracker { onOutput(chunk: string, now: number): boolean; onInput(): void; snapshot(): ActivitySnapshot }` — `onOutput` returns true when a bell rang.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/ansi-activity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BellScanner, ActivityTracker } from "./ansi-activity.ts";

test("BEL in ground state is a bell", () => {
  assert.equal(new BellScanner().feed("hello\x07world"), 1);
  assert.equal(new BellScanner().feed("\x07\x07"), 2);
});

test("BEL terminating an OSC (title set) is NOT a bell", () => {
  assert.equal(new BellScanner().feed("\x1b]0;my title\x07"), 0);
  // …and the scanner is back in ground: a following BEL IS a bell.
  const s = new BellScanner();
  assert.equal(s.feed("\x1b]0;my title\x07\x07"), 1);
});

test("OSC terminated by ST (ESC \\) also swallows its content", () => {
  assert.equal(new BellScanner().feed("\x1b]0;title\x1b\\\x07"), 1); // only the trailing BEL
});

test("DCS/SOS/PM/APC strings swallow BELs", () => {
  for (const opener of ["\x1bP", "\x1bX", "\x1b^", "\x1b_"]) {
    assert.equal(new BellScanner().feed(`${opener}data\x07`), 0, JSON.stringify(opener));
  }
});

test("CSI sequences don't eat a following bell", () => {
  assert.equal(new BellScanner().feed("\x1b[31;1mred\x07"), 1);
});

test("state persists across chunk boundaries", () => {
  const s = new BellScanner();
  assert.equal(s.feed("\x1b]0;spl"), 0);
  assert.equal(s.feed("it title\x07"), 0);  // still the OSC terminator
  assert.equal(s.feed("\x07"), 1);           // ground again
});

test("ActivityTracker: bell raises attention; output alone does not clear it; input clears", () => {
  const t = new ActivityTracker();
  assert.deepEqual(t.snapshot(), { lastOutputAt: null, attention: false });
  assert.equal(t.onOutput("working…", 1000), false);
  assert.deepEqual(t.snapshot(), { lastOutputAt: 1000, attention: false });
  assert.equal(t.onOutput("done\x07", 2000), true);
  assert.deepEqual(t.snapshot(), { lastOutputAt: 2000, attention: true });
  t.onOutput("spinner frame", 3000);          // more output — attention STAYS raised
  assert.equal(t.snapshot().attention, true);
  t.onInput();                                 // the driver/human answered
  assert.deepEqual(t.snapshot(), { lastOutputAt: 3000, attention: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/ansi-activity.test.ts`
Expected: FAIL — `Cannot find module './ansi-activity.ts'`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/ansi-activity.ts`:

```ts
/**
 * Escape-aware BEL detection + per-session activity bookkeeping.
 *
 * A raw byte scan for \x07 is wrong: BEL also TERMINATES OSC strings (every
 * terminal title update is `ESC ] 0 ; title BEL`), so naive counting would
 * raise "attention" on each title change. This scanner only counts a BEL in
 * ground state. Simplification: BEL also exits DCS/SOS/PM/APC strings (strictly
 * those end on ST only) — a BEL there is swallowed, never counted, so the
 * failure direction is a missed bell, never a false one.
 */
type ScanState = "ground" | "esc" | "csi" | "string" | "string-esc";

export class BellScanner {
  private state: ScanState = "ground";

  /** Feed one PTY output chunk; returns how many real bells it contained. */
  feed(chunk: string): number {
    let bells = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      switch (this.state) {
        case "ground":
          if (c === 0x07) bells++;
          else if (c === 0x1b) this.state = "esc";
          break;
        case "esc":
          if (c === 0x5b) this.state = "csi"; // [
          else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f)
            this.state = "string"; // ] P X ^ _  → OSC / DCS / SOS / PM / APC
          else this.state = "ground"; // two-char escape (incl. ESC \)
          break;
        case "csi":
          if (c >= 0x40 && c <= 0x7e) this.state = "ground"; // final byte
          break;
        case "string":
          if (c === 0x07) this.state = "ground"; // string terminator — NOT a bell
          else if (c === 0x1b) this.state = "string-esc";
          break;
        case "string-esc":
          this.state = c === 0x5c ? "ground" : c === 0x1b ? "string-esc" : "string"; // ESC \ = ST
          break;
      }
    }
    return bells;
  }
}

export interface ActivitySnapshot {
  lastOutputAt: number | null;
  attention: boolean;
}

/** Per-session state behind the MCP attention signal. In-memory only (resets on restart). */
export class ActivityTracker {
  private readonly scanner = new BellScanner();
  private lastOutputAt: number | null = null;
  private attention = false;

  /** Feed one output chunk; a real bell raises `attention`. Returns true when a bell rang. */
  onOutput(chunk: string, now: number): boolean {
    this.lastOutputAt = now;
    const rang = this.scanner.feed(chunk) > 0;
    if (rang) this.attention = true;
    return rang;
  }

  /** Any input answers the bell (the daemon can't see "viewed"; typing is the clear signal). */
  onInput(): void {
    this.attention = false;
  }

  snapshot(): ActivitySnapshot {
    return { lastOutputAt: this.lastOutputAt, attention: this.attention };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/ansi-activity.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /var/lib/orquester/workspaces/appsstats/orquester && pnpm check
git add apps/daemon/src/ansi-activity.ts apps/daemon/src/ansi-activity.test.ts
git commit -m "feat(daemon): escape-aware BellScanner + ActivityTracker (OSC-terminator BELs are not bells)"
```

---

### Task 4: Wire activity tracking into both session backends

**Files:**
- Modify: `apps/daemon/src/sessions.ts` — `Session` interface (~line 19), `ISessionManager` (~line 37), tmux `SessionManager.create` (~line 146, the `const session: Session =` literal), `SessionManager.attach` onData (~line 246), `SessionManager.input` (~line 332), `LocalSessionManager.create` (~line 648 literal, ~line 651 onData), `LocalSessionManager.input` (~line 705), plus an `activity()` method on both classes.
- Test: `apps/daemon/src/sessions-activity.test.ts` (new)

**Interfaces:**
- Consumes: `ActivityTracker`, `ActivitySnapshot` (Task 3).
- Produces (used by Task 5): `ISessionManager.activity(id: string): ActivitySnapshot | undefined`; `lifecycle` additionally emits `"activity"` with payload `{ id: string; type: "bell" }`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/sessions-activity.test.ts` (drives a REAL node-pty via `LocalSessionManager` — no tmux, no daemon):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { LocalSessionManager } from "./sessions.ts";

const registry = {
  get: (id: string) =>
    id === "sh"
      ? { id: "sh", name: "sh", kind: "shell" as const, enabled: true, resolvedBin: "/bin/sh",
          args: ["-c", "printf 'ready\\007'; sleep 30"] }
      : undefined,
} as any;

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("bell from a real PTY raises attention; input clears it; bell emits lifecycle activity", async () => {
  const mgr = new LocalSessionManager(registry);
  const bells: { id: string; type: string }[] = [];
  mgr.lifecycle.on("activity", (ev: { id: string; type: string }) => bells.push(ev));
  const s = mgr.create({ kind: "shell", refId: "sh", projectPath: tmpdir() });
  try {
    await until(() => mgr.activity(s.id)?.attention === true);
    const snap = mgr.activity(s.id)!;
    assert.equal(typeof snap.lastOutputAt, "number");
    assert.ok(bells.some((b) => b.id === s.id && b.type === "bell"));
    mgr.input(s.id, " ");
    assert.equal(mgr.activity(s.id)?.attention, false);
    assert.equal(mgr.activity("nope"), undefined);
  } finally {
    mgr.closeAll();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/sessions-activity.test.ts`
Expected: FAIL — `mgr.activity is not a function` (after the PTY spawns; if `/bin/sh` were missing this box would have bigger problems).

- [ ] **Step 3: Modify `sessions.ts`**

3a. Import (top of file, beside the other local imports):

```ts
import { ActivityTracker, type ActivitySnapshot } from "./ansi-activity.ts";
```

3b. `Session` interface — add the tracker field:

```ts
interface Session {
  summary: SessionSummary;
  /** Streaming PTY: `tmux attach -t orq-<id>`. Null once exited. */
  pty: IPty | null;
  buffer: string;
  emitter: EventEmitter;
  tracker: ActivityTracker;
}
```

3c. `ISessionManager` — update the lifecycle doc comment and add the accessor:

```ts
  /** Emits "created" | "exited" | "updated" (SessionSummary), "closed" ({ id }),
   *  and "activity" ({ id, type: "bell" } — a real terminal bell rang). */
  readonly lifecycle: EventEmitter;
```
and (after `buffer(id: string): string;`):
```ts
  /** Per-session activity (bell/attention + last-output time); undefined for unknown id. */
  activity(id: string): ActivitySnapshot | undefined;
```

3d. Both `Session` literals gain the tracker. In tmux `SessionManager.create` (~line 146):

```ts
    const session: Session = { summary, pty: null, buffer: "", emitter: new EventEmitter(), tracker: new ActivityTracker() };
```

In `LocalSessionManager.create` (~line 648):

```ts
    const session: Session = { summary, pty, buffer: "", emitter: new EventEmitter(), tracker: new ActivityTracker() };
```

3e. Both onData handlers feed the tracker. In tmux `SessionManager.attach` replace:

```ts
    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      session.emitter.emit("output", data);
    });
```

with:

```ts
    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      if (session.tracker.onOutput(data, Date.now())) {
        this.lifecycle.emit("activity", { id, type: "bell" });
      }
      session.emitter.emit("output", data);
    });
```

In `LocalSessionManager.create`, the identical replacement (its onData is the same two lines; `id` is in scope there too).

3f. Both `input()` methods clear attention. Replace (both classes — tmux ~line 332, local ~line 705):

```ts
  input(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data);
  }
```

with:

```ts
  input(id: string, data: string): void {
    const s = this.sessions.get(id);
    s?.tracker.onInput(); // any keystroke answers the bell
    s?.pty?.write(data);
  }
```

3g. Both classes get the accessor (place next to `buffer()` in each):

```ts
  activity(id: string): ActivitySnapshot | undefined {
    return this.sessions.get(id)?.tracker.snapshot();
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/sessions-activity.test.ts`
Expected: PASS. Also run `node --import tsx --test src/ansi-activity.test.ts` → still PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /var/lib/orquester/workspaces/appsstats/orquester && pnpm check
git add apps/daemon/src/sessions.ts apps/daemon/src/sessions-activity.test.ts
git commit -m "feat(daemon): per-session ActivityTracker in both backends; ISessionManager.activity + lifecycle 'activity' bell events"
```

---

### Task 5: `waitForAttention` + activity fields in TerminalControl

**Files:**
- Modify: `apps/daemon/src/mcp/terminal-control.ts` (constant, `listTabs`, `readTerminal`, new `activityFields`, new `waitForAttention`, new `AttentionResult` type)
- Modify: `apps/daemon/src/mcp/terminal-control.test.ts` (extend `FakeManager`, add tests)

**Interfaces:**
- Consumes: `ISessionManager.activity(id)` + lifecycle `"activity"`/`"exited"` events (Task 4).
- Produces (used by Task 6):
  - `export const ACTIVITY_WORKING_MS = 3000`
  - `export type AttentionResult = { tabs: { id: string; title: string; status: "running" | "exited"; activity?: "working" | "idle"; attention?: boolean; lastOutputAt?: string }[]; settled: boolean; aborted?: boolean }`
  - `TerminalControl.waitForAttention(sel: TabSelector, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AttentionResult>`
  - `listTabs` rows and `readTerminal` results additionally carry `activity? / attention? / lastOutputAt?` (running tabs with tracker data only).

- [ ] **Step 1: Extend `FakeManager` (test infra) and write the failing tests**

In `apps/daemon/src/mcp/terminal-control.test.ts`, add to the imports:

```ts
import { EventEmitter } from "node:events";
```

Inside `FakeManager`, add these members (beside `texts`):

```ts
  lifecycle = new EventEmitter();
  activityMap = new Map<string, { lastOutputAt: number | null; attention: boolean }>();
  activity(id: string) { return this.activityMap.get(id); }
  ringBell(id: string) {
    this.activityMap.set(id, { lastOutputAt: Date.now(), attention: true });
    this.lifecycle.emit("activity", { id, type: "bell" });
  }
  lifecycleExit(id: string) {
    const t = this.get(id);
    if (t) { t.status = "exited"; this.lifecycle.emit("exited", { ...t }); }
  }
```

Append the tests:

```ts
import { ACTIVITY_WORKING_MS } from "./terminal-control.ts";

test("listTabs projects activity/attention/lastOutputAt for running tabs with tracker data", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.add({ id: "b", title: "old", projectPath: "/ws/w/p", status: "exited" });
  f.activityMap.set("a", { lastOutputAt: Date.now(), attention: true });
  const rows = make(f).listTabs({ workspace: "w", project: "p" });
  const a = rows.find((r) => r.id === "a")!;
  assert.equal(a.activity, "working"); // just produced output
  assert.equal(a.attention, true);
  assert.equal(typeof a.lastOutputAt, "string");
  const b = rows.find((r) => r.id === "b")!;
  assert.equal(b.activity, undefined); // exited → no live signal
});

test("listTabs: a quiet running tab reads idle", () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.activityMap.set("a", { lastOutputAt: Date.now() - ACTIVITY_WORKING_MS - 1000, attention: false });
  assert.equal(make(f).listTabs({ workspace: "w", project: "p" })[0].activity, "idle");
});

test("waitForAttention: returns already-flagged tabs immediately", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.activityMap.set("a", { lastOutputAt: Date.now(), attention: true });
  const r = await make(f).waitForAttention({ workspace: "w", project: "p" });
  assert.equal(r.settled, true);
  assert.deepEqual(r.tabs.map((t) => t.id), ["a"]);
});

test("waitForAttention: blocks, then resolves on a bell for a watched tab (snapshot semantics)", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  f.add({ id: "x", title: "Other", projectPath: "/ws/w/OTHER" });
  const p = make(f).waitForAttention({ workspace: "w", project: "p" }, { timeoutMs: 5000 });
  f.ringBell("x"); // different project — ignored
  f.add({ id: "late", title: "Late", projectPath: "/ws/w/p" }); // created MID-WAIT
  f.ringBell("late"); // not in the call-time snapshot — ignored (documented semantics)
  f.ringBell("a");
  const r = await p;
  assert.equal(r.settled, true);
  assert.deepEqual(r.tabs.map((t) => t.id), ["a"]);
  assert.equal(r.tabs[0].attention, true);
});

test("waitForAttention: resolves when a watched tab exits", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "bash", projectPath: "/ws/w/p" });
  const p = make(f).waitForAttention({ workspace: "w", project: "p" }, { timeoutMs: 5000 });
  f.lifecycleExit("a");
  const r = await p;
  assert.equal(r.settled, true);
  assert.equal(r.tabs[0]?.status, "exited");
});

test("waitForAttention: timeout → settled:false, empty tabs; listeners removed", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = make(f).waitForAttention({ workspace: "w", project: "p" }, { timeoutMs: 2000 });
    mock.timers.tick(2000);
    const r = await p;
    assert.equal(r.settled, false);
    assert.deepEqual(r.tabs, []);
    assert.equal(f.lifecycle.listenerCount("activity"), 0);
    assert.equal(f.lifecycle.listenerCount("exited"), 0);
  } finally {
    mock.timers.reset();
  }
});

test("waitForAttention: abort → aborted:true", async () => {
  const f = new FakeManager();
  f.add({ id: "a", title: "Claude", projectPath: "/ws/w/p" });
  const ac = new AbortController();
  const p = make(f).waitForAttention({ workspace: "w", project: "p" }, { signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.settled, false);
});

test("waitForAttention: zero running tabs in the project → ToolError; explicit exited tab returns immediately", async () => {
  const f = new FakeManager();
  await assert.rejects(() => make(f).waitForAttention({ workspace: "w", project: "p" }), ToolError);
  f.add({ id: "gone", title: "bash", projectPath: "/ws/w/p", status: "exited" });
  await assert.rejects(() => make(f).waitForAttention({ workspace: "w", project: "p" }), ToolError);
  const r = await make(f).waitForAttention({ workspace: "w", project: "p", tab: "bash" });
  assert.equal(r.settled, true);
  assert.equal(r.tabs[0].status, "exited");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/mcp/terminal-control.test.ts`
Expected: FAIL — `ACTIVITY_WORKING_MS` has no export / `waitForAttention is not a function`. (The pre-existing tests still pass.)

- [ ] **Step 3: Implement in `terminal-control.ts`**

3a. Constant (beside `MAX_TABS_PER_PROJECT`):

```ts
/** A tab that produced output within this window reads as "working"; else "idle". */
export const ACTIVITY_WORKING_MS = 3000;
```

3b. Result type (beside `WaitResult`):

```ts
/** tabs = only the tabs needing attention (bell-flagged or just-exited); empty on timeout. */
export type AttentionResult = {
  tabs: {
    id: string;
    title: string;
    status: SessionSummary["status"];
    activity?: "working" | "idle";
    attention?: boolean;
    lastOutputAt?: string;
  }[];
  settled: boolean;
  aborted?: boolean;
};
```

3c. Private helper (place after `resolveTab`):

```ts
  /** working/idle + attention for a RUNNING tab; {} when exited or no tracker data. */
  private activityFields(t: SessionSummary): {
    activity?: "working" | "idle";
    attention?: boolean;
    lastOutputAt?: string;
  } {
    if (t.status !== "running") {
      return {};
    }
    const a = this.deps.sessions.activity(t.id);
    if (!a) {
      return {};
    }
    return {
      activity:
        a.lastOutputAt !== null && Date.now() - a.lastOutputAt < ACTIVITY_WORKING_MS ? "working" : "idle",
      attention: a.attention,
      lastOutputAt: a.lastOutputAt === null ? undefined : new Date(a.lastOutputAt).toISOString(),
    };
  }
```

3d. `listTabs` — spread the fields into the projection:

```ts
    return this.deps.sessions.list(projectPath).map((t) => ({
      id: t.id, title: t.title, kind: t.kind, refId: t.refId,
      status: t.status, exitCode: t.exitCode, order: t.order,
      ...this.activityFields(t),
    }));
```

3e. `readTerminal` — same spread in its return:

```ts
    return { text, status: t.status, exitCode: t.exitCode, cols: t.cols, rows: t.rows, ...this.activityFields(t) };
```

3f. `waitForAttention` (place after `waitForIdle`):

```ts
  /**
   * Block until any watched tab needs attention: a real bell (tracker) or an exit.
   * Watch set = one resolved tab (tab/tabId given) or every RUNNING tab of the
   * project, snapshotted now — tabs created mid-wait are not watched. Returns
   * already-flagged tabs immediately without blocking.
   */
  async waitForAttention(
    sel: TabSelector,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<AttentionResult> {
    const { sessions, workspacesDir } = this.deps;
    let watched: SessionSummary[];
    if (sel.tabId || sel.tab) {
      watched = [this.resolveTab(sel)];
    } else {
      if (!sel.workspace || !sel.project) {
        throw new ToolError("Provide workspace+project (optionally tab), or tabId.");
      }
      if (!isValidName(sel.workspace) || !isValidName(sel.project)) {
        throw new TabNotFound("Invalid workspace/project name.");
      }
      const projectPath = join(workspacesDir, sel.workspace, sel.project);
      watched = sessions.list(projectPath).filter((t) => t.status === "running");
      if (watched.length === 0) {
        throw new ToolError("No running tabs to wait on.");
      }
    }
    const ids = new Set(watched.map((t) => t.id));
    const needy = () =>
      [...ids]
        .map((id) => sessions.get(id))
        .filter((t): t is SessionSummary => Boolean(t))
        .filter((t) => t.status === "exited" || sessions.activity(t.id)?.attention === true)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, ...this.activityFields(t) }));
    const initial = needy();
    if (initial.length > 0) {
      return { tabs: initial, settled: true };
    }
    const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const sig = opts?.signal;
    const settled = await new Promise<boolean>((resolve) => {
      let resolved = false;
      const done = (ok: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimer);
        sessions.lifecycle.off("activity", onActivity);
        sessions.lifecycle.off("exited", onExited);
        sig?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onActivity = (ev: { id: string; type: string }) => {
        if (ev.type === "bell" && ids.has(ev.id)) done(true);
      };
      const onExited = (s: SessionSummary) => {
        if (ids.has(s.id)) done(true);
      };
      const onAbort = () => done(false);
      const hardTimer = setTimeout(() => done(false), timeoutMs);
      sessions.lifecycle.on("activity", onActivity);
      sessions.lifecycle.on("exited", onExited);
      sig?.addEventListener("abort", onAbort, { once: true });
      if (sig?.aborted) {
        done(false);
      }
    });
    if (sig?.aborted) {
      return { tabs: [], settled: false, aborted: true };
    }
    return { tabs: needy(), settled };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/mcp/terminal-control.test.ts`
Expected: PASS — all pre-existing tests plus the 8 new ones. (`FakeManager` now has `activity()`, so the projection guard path is exercised, and fakes without map entries return `{}` fields.)

- [ ] **Step 5: Typecheck and commit**

```bash
cd /var/lib/orquester/workspaces/appsstats/orquester && pnpm check
git add apps/daemon/src/mcp/terminal-control.ts apps/daemon/src/mcp/terminal-control.test.ts
git commit -m "feat(daemon/mcp): activity/attention projections + project-wide waitForAttention"
```

---

### Task 6: Register `wait_for_attention` + instructions update

**Files:**
- Modify: `apps/daemon/src/mcp/server.ts` (new exported `ATTENTION_HINT`, one registration, `SERVER_INSTRUCTIONS` addition)
- Test: `apps/daemon/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `control.waitForAttention` (Task 5).
- Produces: `export const ATTENTION_HINT: string`. `SERVER_INSTRUCTIONS` now describes all four new tool families (todos/files/attention/usage — the files/usage tools land in Tasks 8/9 of this same branch; the text ships once here so the ≤2 KB budget is checked once).

- [ ] **Step 1: Write the failing tests**

Append to `apps/daemon/src/mcp/server.test.ts`:

```ts
import { ATTENTION_HINT } from "./server.ts";

test("attention guidance: bell semantics + wait_for_idle fallback survive trims", () => {
  assert.match(ATTENTION_HINT, /bell/i, "must explain attention = terminal bell");
  assert.match(ATTENTION_HINT, /read_terminal/, "must send the driver to read the screen next");
  assert.match(ATTENTION_HINT, /wait_for_idle/, "must name the fallback for non-bell TUIs");
  assert.match(SERVER_INSTRUCTIONS, /wait_for_attention/, "instructions must advertise the tool");
});

test("SERVER_INSTRUCTIONS stays under the ~2KB truncation budget", () => {
  assert.ok(
    SERVER_INSTRUCTIONS.length <= 2048,
    `instructions are ${SERVER_INSTRUCTIONS.length} chars; Claude Code truncates ~2KB`
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/mcp/server.test.ts`
Expected: FAIL — no export `ATTENTION_HINT`.

- [ ] **Step 3: Implement in `server.ts`**

3a. Export the hint (place right after `PROMPT_HINT`):

```ts
export const ATTENTION_HINT =
  " attention:true = the tab rang the terminal BELL (Claude Code rings when it finishes or needs input) — read_terminal next and answer. Only bell-ringing TUIs raise it; for plain shells and non-bell TUIs use wait_for_idle.";
```

3b. Append one bullet to the end of the `SERVER_INSTRUCTIONS` template literal (before the closing backtick):

```
• Beyond terminals: shared TODO lists (list/create/update/delete_todo, toggle_todo_item — the human sees them live in the UI); sandboxed file reads (list_files, read_file — byte-offset paging); wait_for_attention (bell-based "this tab needs you", one tab or a whole project — prefer it over wait_for_idle for agent tabs); get_usage (Claude/Codex quota — an ABSENT agent is not logged in, null windows + stale = logged in/updating; never loop refresh:true).
```

(Prefix it with `\n` so it is its own line inside the template literal.)

3c. Register the tool (after `toggle_todo_item`, before `return server;`):

```ts
  tool("wait_for_attention",
    "Block until a watched tab needs you (bell or exit). workspace+project watches every running tab; add tab/tabId for one. Already-flagged tabs return instantly; tabs:[] on timeout." + ATTENTION_HINT + PROMPT_HINT,
    { ...sel, timeoutMs: z.number().int().optional() },
    (a) => control.waitForAttention(a, { timeoutMs: a.timeoutMs, signal })
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/mcp/server.test.ts`
Expected: PASS, including the ≤ 2048 length check (the addition is ~430 chars on top of 1277).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /var/lib/orquester/workspaces/appsstats/orquester && pnpm check
git add apps/daemon/src/mcp/server.ts apps/daemon/src/mcp/server.test.ts
git commit -m "feat(daemon/mcp): wait_for_attention tool + attention guidance; instructions budget test"
```

---

### Task 7: File-read tools module

**Files:**
- Create: `apps/daemon/src/mcp/fs-tools.ts`
- Test: `apps/daemon/src/mcp/fs-tools.test.ts`

**Interfaces:**
- Consumes: `assertInsideFsRoot` from `@orquester/config/fs` (throws `FsSandboxError`, already mapped path-free); `ToolError` from `./terminal-control.ts`.
- Produces (used by Task 8): `class FsTools` with constructor `new FsTools({ fsRoot: string })` and:
  - `listFiles(path: string): Promise<{ path: string; entries: { name: string; kind: "dir" | "file" | "symlink" | "other"; size: number }[]; truncated: boolean }>`
  - `readFileWindow(path: string, opts?: { offset?: number; maxBytes?: number }): Promise<{ path: string; text: string; size: number; offset: number; truncated: boolean }>`
  - `export const MAX_FS_ENTRIES = 500`, `DEFAULT_READ_BYTES = 64 * 1024`, `MAX_READ_BYTES = 256 * 1024`.
- Note: the daemon's HTTP `listFiles` helper (`index.ts:2187`) is **not exported** and importing it from `mcp/` would create an import cycle (index → mcp/server → …), so this module does its own small `readdir` — same sandbox, MCP-shaped projection.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/mcp/fs-tools.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./terminal-control.ts";
import { FsTools, MAX_FS_ENTRIES, DEFAULT_READ_BYTES, MAX_READ_BYTES } from "./fs-tools.ts";

async function make() {
  const root = await mkdtemp(join(tmpdir(), "fs-tools-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  await writeFile(join(root, "w", "p", "hello.txt"), "hello world");
  return { root, fs: new FsTools({ fsRoot: root }) };
}

test("listFiles: absolute and fsRoot-relative paths; kinds and sizes", async () => {
  const { root, fs } = await make();
  await symlink("/etc", join(root, "w", "p", "esc-link"));
  const abs = await fs.listFiles(join(root, "w", "p"));
  assert.equal(abs.truncated, false);
  assert.deepEqual(
    abs.entries.map((e) => [e.name, e.kind]),
    [["esc-link", "symlink"], ["hello.txt", "file"]]
  );
  assert.equal(abs.entries[1].size, "hello world".length);
  const rel = await fs.listFiles("w/p"); // relative resolves against fsRoot
  assert.deepEqual(rel.entries.map((e) => e.name), abs.entries.map((e) => e.name));
});

test("listFiles: escapes are rejected; missing dir is a safe ToolError", async () => {
  const { fs } = await make();
  await assert.rejects(() => fs.listFiles("/etc"), FsSandboxError);
  await assert.rejects(() => fs.listFiles("../../.."), FsSandboxError);
  await assert.rejects(() => fs.listFiles("w/nope"), ToolError);
});

test("listFiles: caps entries at MAX_FS_ENTRIES with truncated:true", async () => {
  const { root, fs } = await make();
  const big = join(root, "big");
  await mkdir(big);
  await Promise.all(
    Array.from({ length: MAX_FS_ENTRIES + 1 }, (_, i) =>
      writeFile(join(big, `f${String(i).padStart(4, "0")}`), "")
    )
  );
  const r = await fs.listFiles("big");
  assert.equal(r.entries.length, MAX_FS_ENTRIES);
  assert.equal(r.truncated, true);
});

test("readFileWindow: default window, offset paging, hard cap", async () => {
  const { root, fs } = await make();
  await writeFile(join(root, "big.txt"), "x".repeat(DEFAULT_READ_BYTES + 10));
  const first = await fs.readFileWindow("big.txt");
  assert.equal(first.text.length, DEFAULT_READ_BYTES);
  assert.equal(first.truncated, true);
  assert.equal(first.size, DEFAULT_READ_BYTES + 10);
  const rest = await fs.readFileWindow("big.txt", { offset: DEFAULT_READ_BYTES });
  assert.equal(rest.text.length, 10);
  assert.equal(rest.truncated, false);
  const capped = await fs.readFileWindow("big.txt", { maxBytes: MAX_READ_BYTES * 10 });
  assert.ok(capped.text.length <= MAX_READ_BYTES);
});

test("readFileWindow: binary refused, dir refused, missing file safe, symlink escape blocked", async () => {
  const { root, fs } = await make();
  await writeFile(join(root, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
  await assert.rejects(() => fs.readFileWindow("bin.dat"), /[Bb]inary/);
  await assert.rejects(() => fs.readFileWindow("w"), ToolError);        // a directory
  await assert.rejects(() => fs.readFileWindow("w/none.txt"), ToolError);
  await symlink("/etc/hostname", join(root, "leak"));
  await assert.rejects(() => fs.readFileWindow("leak"), FsSandboxError); // realpath escapes
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/mcp/fs-tools.test.ts`
Expected: FAIL — `Cannot find module './fs-tools.ts'`.

- [ ] **Step 3: Write the implementation**

Create `apps/daemon/src/mcp/fs-tools.ts`:

```ts
import { join, resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { assertInsideFsRoot } from "@orquester/config/fs";
import { ToolError } from "./terminal-control.ts";

export const MAX_FS_ENTRIES = 500;
export const DEFAULT_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface FsToolsDeps {
  /** Sandbox root (resolved.fsRoot) — every path is realpath-checked against it. */
  fsRoot: string;
}

export type FsToolEntry = { name: string; kind: "dir" | "file" | "symlink" | "other"; size: number };

/** Read-only, sandboxed file access for MCP clients. */
export class FsTools {
  constructor(private readonly deps: FsToolsDeps) {}

  /** Relative paths resolve against fsRoot; EVERYTHING is sandbox-asserted after resolution. */
  private resolveSafe(path: string): Promise<string> {
    return assertInsideFsRoot(this.deps.fsRoot, resolve(this.deps.fsRoot, path));
  }

  async listFiles(path: string): Promise<{ path: string; entries: FsToolEntry[]; truncated: boolean }> {
    const safe = await this.resolveSafe(path);
    let dirents;
    try {
      dirents = await readdir(safe, { withFileTypes: true });
    } catch {
      throw new ToolError("Cannot list: not a directory, or it does not exist.");
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const truncated = dirents.length > MAX_FS_ENTRIES;
    const entries = await Promise.all(
      dirents.slice(0, MAX_FS_ENTRIES).map(async (d): Promise<FsToolEntry> => {
        const kind = d.isDirectory() ? ("dir" as const)
          : d.isFile() ? ("file" as const)
          : d.isSymbolicLink() ? ("symlink" as const)
          : ("other" as const);
        let size = 0;
        if (kind === "file") {
          try {
            size = (await stat(join(safe, d.name))).size;
          } catch {
            // raced delete — keep 0
          }
        }
        return { name: d.name, kind, size };
      })
    );
    return { path: safe, entries, truncated };
  }

  async readFileWindow(
    path: string,
    opts?: { offset?: number; maxBytes?: number }
  ): Promise<{ path: string; text: string; size: number; offset: number; truncated: boolean }> {
    const safe = await this.resolveSafe(path); // symlink to outside → FsSandboxError here
    let st;
    try {
      st = await stat(safe);
    } catch {
      throw new ToolError("File not found.");
    }
    if (st.isDirectory()) {
      throw new ToolError("Path is a directory — use list_files.");
    }
    const buffer = await readFile(safe);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new ToolError(`Binary file (${buffer.length} bytes); read_file only serves text.`);
    }
    const offset = Math.max(0, opts?.offset ?? 0);
    const maxBytes = Math.min(Math.max(1, opts?.maxBytes ?? DEFAULT_READ_BYTES), MAX_READ_BYTES);
    const slice = buffer.subarray(offset, offset + maxBytes);
    return {
      path: safe,
      text: slice.toString("utf8"), // byte window — a multibyte char may clip at the edges
      size: buffer.length,
      offset,
      truncated: offset + slice.length < buffer.length,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/mcp/fs-tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /var/lib/orquester/workspaces/appsstats/orquester && pnpm check
git add apps/daemon/src/mcp/fs-tools.ts apps/daemon/src/mcp/fs-tools.test.ts
git commit -m "feat(daemon/mcp): FsTools — sandboxed list_files/read_file with entry cap + byte windows"
```

---

### Task 8: Register `list_files` / `read_file`

**Files:**
- Modify: `apps/daemon/src/mcp/server.ts` (import, `McpDeps.files`, exported `READ_FILE_DESC`, 2 registrations)
- Modify: `apps/daemon/src/index.ts` (call site gains `files`)
- Test: `apps/daemon/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `FsTools` (Task 7).
- Produces (Task 9 grows this): `McpDeps = { control; todos; files: FsTools }`; `export const READ_FILE_DESC: string`.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/mcp/server.test.ts`:

```ts
import { READ_FILE_DESC } from "./server.ts";

test("read_file description teaches byte-offset paging and the binary refusal", () => {
  assert.match(READ_FILE_DESC, /offset/, "must teach offset paging");
  assert.match(READ_FILE_DESC, /64\s?KB|65536/i, "must state the default window");
  assert.match(READ_FILE_DESC, /binary/i, "must state binary files are refused");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/mcp/server.test.ts`
Expected: FAIL — no export `READ_FILE_DESC`.

- [ ] **Step 3: Implement in `server.ts`**

3a. Import: `import { FsTools } from "./fs-tools.ts";`

3b. Grow the deps interface and destructure:

```ts
export interface McpDeps {
  control: TerminalControl;
  todos: TodoTools;
  files: FsTools;
}
```
and in `buildServer`: `const { control, todos, files } = deps;`

3c. Exported description (beside `ATTENTION_HINT`):

```ts
export const READ_FILE_DESC =
  "Read a text file inside the workspace sandbox (absolute path, or relative to the sandbox root). Byte-offset paging: offset/maxBytes, default 64KB window, 256KB max; truncated:true means more bytes remain — advance offset. Binary files are refused.";
```

3d. Registrations (after `wait_for_attention`):

```ts
  tool("list_files",
    "List a directory inside the workspace sandbox (absolute path, or relative to the sandbox root). Capped at 500 entries.",
    { path: z.string() },
    (a) => files.listFiles(a.path)
  );
  tool("read_file", READ_FILE_DESC,
    { path: z.string(), offset: z.number().int().optional(), maxBytes: z.number().int().optional() },
    (a) => files.readFileWindow(a.path, { offset: a.offset, maxBytes: a.maxBytes })
  );
```

- [ ] **Step 4: Modify the call site in `index.ts`**

Add the import beside `TodoTools`:

```ts
import { FsTools } from "./mcp/fs-tools.ts";
```

Grow the `registerMcp` call:

```ts
    registerMcp(app, {
      control,
      todos: new TodoTools({ todos, workspacesDir: resolved.workspacesDir }),
      files: new FsTools({ fsRoot: resolved.fsRoot }),
    });
```

- [ ] **Step 5: Run tests + typecheck, commit**

Run: `node --import tsx --test src/mcp/server.test.ts` → PASS.
Run from root: `pnpm check` → clean.

```bash
git add apps/daemon/src/mcp/server.ts apps/daemon/src/index.ts apps/daemon/src/mcp/server.test.ts
git commit -m "feat(daemon/mcp): register list_files/read_file"
```

---

### Task 9: `get_usage` tool

**Files:**
- Modify: `apps/daemon/src/mcp/server.ts` (import type, `McpDeps.getUsage`, exported `GET_USAGE_DESC` + `projectUsage`, 1 registration)
- Modify: `apps/daemon/src/index.ts` (call site gains `getUsage`)
- Test: `apps/daemon/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `UsageService.snapshot(force: boolean): Promise<UsageResponse>` (already constructed in `index.ts`, in scope as `usage`); `UsageResponse`/`AgentUsage` from `@orquester/api`.
- Produces: `McpDeps = { control; todos; files; getUsage: (force: boolean) => Promise<UsageResponse> }`; `export function projectUsage(res: UsageResponse, now: number)`; `export const GET_USAGE_DESC: string`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/daemon/src/mcp/server.test.ts`:

```ts
import { GET_USAGE_DESC, projectUsage } from "./server.ts";
import type { UsageResponse } from "@orquester/api";

test("projectUsage: derives ageMinutes from asOf, drops the top level, keeps null windows", () => {
  const now = Date.parse("2026-07-07T12:00:00Z");
  const res = {
    updatedAt: "2026-07-07T11:59:59Z", // still on the wire until Task 10 — must NOT leak through
    agents: [
      { id: "claude", available: true, stale: false, plan: "Max 20x",
        session: { percent: 42, resetsAt: "2026-07-07T14:00:00Z" }, weekly: { percent: 10 },
        asOf: "2026-07-07T11:37:00Z" },
      { id: "codex", available: true, stale: true, session: null, weekly: null },
    ],
  } as unknown as UsageResponse;
  const p = projectUsage(res, now);
  assert.ok(!("updatedAt" in p), "poll timestamp must not masquerade as freshness");
  assert.equal(p.agents[0].ageMinutes, 23);
  assert.equal(p.agents[0].session?.percent, 42);
  assert.equal(p.agents[1].ageMinutes, undefined); // no asOf → no age
  assert.equal(p.agents[1].session, null);         // null stays null — never invent 0%
});

test("get_usage description pins the honesty semantics", () => {
  assert.match(GET_USAGE_DESC, /ABSENT|absent/, "absent agent = not logged in");
  assert.match(GET_USAGE_DESC, /null windows|no reading/i, "placeholder ≠ 0%");
  assert.match(GET_USAGE_DESC, /NEVER|never/, "must forbid refresh loops");
  assert.match(GET_USAGE_DESC, /loop/, "must forbid refresh loops");
  assert.match(GET_USAGE_DESC, /asOf|ageMinutes/, "must name the freshness fields");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/mcp/server.test.ts`
Expected: FAIL — no export `projectUsage` / `GET_USAGE_DESC`.

- [ ] **Step 3: Implement in `server.ts`**

3a. Type import (top): `import type { UsageResponse } from "@orquester/api";`

3b. Grow the deps interface + destructure:

```ts
export interface McpDeps {
  control: TerminalControl;
  todos: TodoTools;
  files: FsTools;
  /** usage.snapshot(force) — force still respects the upstream backoff floor server-side. */
  getUsage: (force: boolean) => Promise<UsageResponse>;
}
```
and `const { control, todos, files, getUsage } = deps;`

3c. Description + projection (beside `READ_FILE_DESC`):

```ts
export const GET_USAGE_DESC =
  "Claude Code / Codex subscription quota (percent USED, 0-100; session = rolling 5h window, weekly = 7d; either window may be null). Served from the daemon's cache (fresh to ~5min). An ABSENT agent is not logged in on the host; PRESENT with null windows + stale:true = logged in, no reading yet — never report 0% for unknown. Freshness = asOf/ageMinutes. refresh:true forces a recompute but may still return last-known data (upstream backoff) — NEVER call it in a loop.";

/** MCP projection: per-agent asOf/ageMinutes are the freshness signals; the top-level
 *  poll timestamp is deliberately dropped (it advances even when fetches fail/skip). */
export function projectUsage(res: UsageResponse, now: number) {
  return {
    agents: res.agents.map((a) => ({
      id: a.id,
      available: a.available,
      stale: a.stale,
      plan: a.plan,
      session: a.session,
      weekly: a.weekly,
      asOf: a.asOf,
      ageMinutes: a.asOf ? Math.max(0, Math.round((now - Date.parse(a.asOf)) / 60_000)) : undefined,
    })),
  };
}
```

3d. Registration (after `read_file`):

```ts
  tool("get_usage", GET_USAGE_DESC, { refresh: z.boolean().optional() },
    async (a) => projectUsage(await getUsage(a.refresh === true), Date.now())
  );
```

- [ ] **Step 4: Modify the call site in `index.ts`**

```ts
    registerMcp(app, {
      control,
      todos: new TodoTools({ todos, workspacesDir: resolved.workspacesDir }),
      files: new FsTools({ fsRoot: resolved.fsRoot }),
      getUsage: (force) => usage.snapshot(force),
    });
```

(`usage` is already destructured from `services` at the top of `createServer`.)

- [ ] **Step 5: Run tests + typecheck, commit**

Run: `node --import tsx --test src/mcp/server.test.ts` → PASS.
Run from root: `pnpm check` → clean.

```bash
git add apps/daemon/src/mcp/server.ts apps/daemon/src/index.ts apps/daemon/src/mcp/server.test.ts
git commit -m "feat(daemon/mcp): get_usage — cache-first quota with honest asOf/ageMinutes projection"
```

---

### Task 10: Root fix — remove `UsageResponse.updatedAt` from the wire

**Files:**
- Modify: `packages/api/src/index.ts:384-388` (the `UsageResponse` interface)
- Modify: `apps/daemon/src/usage.ts:25,43-44`

**Interfaces:**
- Produces: `UsageResponse = { agents: AgentUsage[] }`. Consumers verified 2026-07-07: nothing reads `updatedAt` (not the UI, desktop, or `usage*.check.ts`); the daemon's dedupe already ignores it. `UsageServiceDeps.now` stays (harmless; check-test fakes pass it).

- [ ] **Step 1: Edit the wire type**

In `packages/api/src/index.ts`, replace:

```ts
export interface UsageResponse {
  updatedAt: string;
  /** only logged-in agents; empty ⇒ the widget hides. */
  agents: AgentUsage[];
}
```

with:

```ts
export interface UsageResponse {
  /** Only logged-in agents; empty ⇒ the widget hides. Freshness lives in each
   *  agent's `asOf` — there is deliberately no top-level poll timestamp (it would
   *  advance even when fetches fail/skip and read as a freshness lie). */
  agents: AgentUsage[];
}
```

- [ ] **Step 2: Edit `apps/daemon/src/usage.ts`**

Replace line 25:

```ts
  private cache: UsageResponse = { updatedAt: new Date(0).toISOString(), agents: [] };
```
with:
```ts
  private cache: UsageResponse = { agents: [] };
```

Replace lines 43-44:

```ts
    this.cache = { updatedAt: new Date(this.deps.now()).toISOString(), agents };
    const h = JSON.stringify(agents); // dedupe on the agents payload, ignoring updatedAt
```
with:
```ts
    this.cache = { agents };
    const h = JSON.stringify(agents); // dedupe on the agents payload
```

- [ ] **Step 3: Prove the removal is complete**

Run: `grep -rn "updatedAt" packages/api/src apps/daemon/src/usage.ts apps/daemon/src/usage.check.ts apps/daemon/src/usage-sources.check.ts packages/ui/src/components/topbar | grep -v TodoListRecord | grep -v "todo"`
Expected: no output. (The `updatedAt` occurrences that legitimately remain in the repo belong to the todos feature — `TodoListRecord` in `packages/api` and the todo body-save in `packages/ui/src/store/app.ts` — which is why the grep scopes to the usage files/dirs.)
Run from root: `pnpm check`
Expected: clean. If any `usage*.check.ts` constructs a `UsageResponse` literal with `updatedAt`, typecheck will flag it — delete that property from the literal.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts apps/daemon/src/usage.ts
git commit -m "fix(usage): drop UsageResponse.updatedAt — a poll timestamp is not freshness; asOf is"
```

---

### Task 11: Root fix — truthful Settings usage hint

**Files:**
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx:490`

**Interfaces:** none (copy-only UI fix; `AgentUsage.stale` semantics unchanged).

- [ ] **Step 1: Edit the hint**

In `SettingsModal.tsx`'s `agentHint`, replace:

```ts
    if (found.stale) return "Stale — token expired";
```

with:

```ts
    // stale covers 429 backoff, network errors, empty new sessions AND expired tokens —
    // a stale agent is still LOGGED IN; claiming "token expired" for all of them is wrong.
    if (found.stale) return found.plan ? `Logged in · ${found.plan} — updating…` : "Logged in — updating…";
```

- [ ] **Step 2: Typecheck**

Run from root: `pnpm check`
Expected: clean. (Copy-only change; there is no UI test runner — visual verification happens post-deploy, per the spec.)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "fix(ui/usage): Settings hint — stale ≠ token expired; show truthful logged-in/updating copy"
```

---

### Task 12: Docs + full verification sweep

**Files:**
- Modify: `docs/terminal-control-mcp.md` (title, §5 tool list, §6 patterns, §8 safety)

**Interfaces:** none.

- [ ] **Step 1: Update the doc title and intro**

Change line 1 from `# Orquester Terminal-Control MCP — install & use` to:

```markdown
# Orquester Control MCP — install & use
```

and add directly under it (before §1):

```markdown
> Scope note: this MCP started as terminal control and now also covers shared todo
> lists, sandboxed file reads, a bell-based attention signal, and usage quota.
> The filename keeps its historical name.
```

- [ ] **Step 2: Append the new tools to §5 ("The tools", ends ~line 200)**

Insert at the end of §5, before the `## 6.` heading:

```markdown
### Beyond terminals (v1.1.0)

| Tool | What it does |
|---|---|
| `list_todos` / `create_todo` / `update_todo` / `delete_todo` | Shared todo lists on a workspace (`{workspace}`) or project (`{workspace, project}`). `body` is GitHub task-list markdown (`- [ ] item`). The human sees every change live in the UI's Todo tab. |
| `toggle_todo_item` | Atomically check/uncheck ONE item by 1-based index or exact text (omit `checked` to flip). Prefer this over `update_todo` for ticks — no read-modify-write clobber. |
| `wait_for_attention` | Block until a watched tab needs you: a real terminal BELL or an exit. `{workspace, project}` watches every running tab; add `tab`/`tabId` for one. Already-flagged tabs return instantly; `tabs: []` on timeout. `list_tabs`/`read_terminal` now also report `activity` ("working"/"idle"), `attention`, and `lastOutputAt` for running tabs. |
| `list_files` | List a sandboxed directory (absolute, or relative to the workspaces root). Capped at 500 entries (`truncated: true` beyond). |
| `read_file` | Read a text file with byte-offset paging (`offset`/`maxBytes`, 64 KB default, 256 KB max). Binary files are refused; `truncated: true` means advance `offset`. |
| `get_usage` | Claude Code / Codex subscription quota from the daemon's cache (≈5 min fresh). Percent is % USED. An ABSENT agent is not logged in; present with null windows + `stale: true` is "logged in, no reading yet". Freshness = per-agent `asOf`/`ageMinutes`. `refresh: true` may still return last-known data (upstream backoff) — never call it in a loop. |
```

- [ ] **Step 3: Append two patterns to §6 ("Usage patterns", before `## 7.`)**

```markdown
### Supervise several agent tabs

`wait_for_attention {workspace, project, timeoutMs: 300000}` → it returns the tabs that
rang the bell or exited → `read_terminal` each → answer (menus per §7) → loop. This
replaces short-timeout `wait_for_idle` polling for bell-capable TUIs (Claude Code rings
on finish/needs-input). Non-bell TUIs and plain shells still need `wait_for_idle`.

### Shared todo lists (agent ↔ human)

Plan work as a checklist the human watches live: `create_todo {workspace, project, name}`
→ `update_todo {id, body: "- [ ] step 1\n- [ ] step 2"}` → after finishing a step,
`toggle_todo_item {id, item: "step 1"}`. Check quota first when the work is long:
`get_usage {}` — treat `ageMinutes > 10` as stale, and don't start a big run against a
window that is nearly exhausted.
```

- [ ] **Step 4: Extend §8 ("Safety & things to know")**

Append one paragraph at the end of §8:

```markdown
`read_file`/`list_files` widen the read surface: file contents inside the sandbox
(including `.env`s or tokens developers keep in workspaces) flow to the driving model,
exactly like terminal reads. The todo tools are the only new mutating surface — benign,
human-visible, event-audited. `get_usage` returns percentages/reset times only; its
`refresh: true` cannot bust Anthropic's rate limit (the daemon's backoff floor applies)
but is still not for polling loops.
```

- [ ] **Step 5: Full verification sweep**

Run from `apps/daemon/`: `pnpm test`
Expected: every `*.test.ts` passes (todo-tools, ansi-activity, sessions-activity, terminal-control, fs-tools, server, keys, text).
Run from root: `pnpm check`
Expected: clean across all packages.

- [ ] **Step 6: Commit**

```bash
git add docs/terminal-control-mcp.md
git commit -m "docs(mcp): document todos/attention/files/usage tools + supervision and todo patterns"
```

---

## Post-plan notes for the reviewer

- **Live verification** (driving `/mcp` with a real client) is deliberately out of scope here: this checkout is served by a live daemon that must not be restarted. After deploying to the VPS (AGENTS.md "Routine updates"), verify with a **fresh** `claude` session (tool descriptions are cached per session) — `list_todos` on a real workspace, `wait_for_attention` against a Claude tab, `read_file` on a project file, `get_usage`.
- Spec: `docs/superpowers/specs/2026-07-07-mcp-v2-todos-attention-fsread-design.md`. Tool count after this plan: 20.
