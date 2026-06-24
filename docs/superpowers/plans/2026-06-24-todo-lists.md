# To-do Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add synced, daemon-owned to-do lists — flat Notion-style checklists you create per workspace and per project, edited in a focused checklist tab and persisted by the daemon as GitHub task-list markdown.

**Architecture:** The list *data* follows the session-manager precedent (a JSON index in the appdir, atomic tmp+rename writes, reload on boot, change-event broadcast, cascade-delete). The list *tab* follows the Git-tab precedent (a client-local, non-PTY "view" tab). One genuinely new structural piece: the tab strip + `MainView` are generalized from "project only" to a **context** (project *or* workspace) so a workspace with no project open shows its own to-do tabs.

**Tech Stack:** TypeScript (ESM, strict), Fastify (daemon), zod (`@orquester/config`), React 18 + zustand (`@orquester/ui`), `tsx` (TS runner). pnpm workspaces.

> **Verbatim code source:** the committed spec **`docs/superpowers/specs/2026-06-24-todo-lists-design.md`** (cited per task as `spec §N`) holds the exact code blocks. This plan reproduces the full code for the new logic files (Tasks 3, 7, 8, 9) and the cross-task interface signatures inline; for additive blocks already verbatim in the spec it cites the section. Where plan and spec ever disagree, the plan wins (it carries the post-review fixes).

## Global Constraints

- **The gate is `pnpm check`** (= `pnpm -r typecheck` → `tsc --noEmit`). It must be clean at the end of every task. There is **no test runner** in this repo.
- **Pure-logic tasks** (3 = `TodoListManager`, 7 = markdown lib) are *additionally* verified by a throwaway `tsx` assertion script written to the scratchpad and run with `node --import tsx`. These scripts instantiate a class / call pure functions only — they do **not** start a server.
- **NEVER start, restart, or stop the daemon**, and never bind `127.0.0.1:47831` or `daemon.sock` (per AGENTS.md — this checkout runs *inside* a live daemon). Daemon HTTP behavior is smoke-tested by the **human operator** after the plan (Task 15).
- **Commit to the current branch as-is; do NOT create a new branch** (per AGENTS.md), even though the spec header labels a `feat/todo-lists` branch — ignore that label.
- **No new npm dependency.** ESM everywhere. Match existing style: neutral Tailwind palette, `useApi()`, the session/git precedents.
- **List names are free-form** (renamable to anything; never run through `isValidName` — they are not filenames). The checklist body is GitHub task-list markdown: `- [ ] text` (open) / `- [x] text` (done), one item per line.
- **Scratchpad dir** (for verify scripts only, never committed):
  `/var/lib/orquester/tmp/claude-999/-var-lib-orquester-workspaces-appsstats-orquester/f93e6d8a-05d5-4d30-b037-b068394d791b/scratchpad`
- The Bash tool's working directory is already the repo root; run `pnpm`/`node` without `cd`.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `packages/api/src/index.ts` (modify) | 1 | Wire types: `TodoListRecord`, requests, event-type union |
| `packages/config/src/index.ts` (modify) | 2 | `todos.json` path helper + zod schema triad |
| `apps/daemon/src/todos.ts` (create) | 3 | `TodoListManager` — in-memory map + atomic persist + lifecycle |
| `apps/daemon/src/index.ts` (modify) | 4 | Construct/wire the manager, `/api/todos` routes, broadcast bridges, cascade |
| `packages/ui/src/lib/api-client.ts` (modify) | 5 | UI `ApiClient` to-do methods |
| `packages/ui/src/store/app.ts` (modify) | 6 | Tab context, to-do tabs + cache, actions, selectors, event reduction |
| `packages/ui/src/components/todo/todo-markdown.ts` (create) | 7 | Pure parse/serialize of task-list markdown |
| `packages/ui/src/hooks/use-todo-doc.ts` (create) | 8 | Read→edit→debounced-save loop + cross-client reconcile |
| `packages/ui/src/components/todo/TodoView.tsx` + `index.ts` (create) | 9 | The checklist editor component |
| `packages/ui/src/components/main/MainView.tsx` (modify) | 10 | Render `TodoView`, icons, context empty-states |
| `packages/ui/src/components/topbar/TopBar.tsx` (modify) | 11 | Gate the tab strip on context (project *or* workspace) |
| `packages/ui/src/components/topbar/NewTabMenu.tsx` (modify) | 12 | Context-aware "+" menu (to-do create/reopen) |
| `packages/ui/src/components/topbar/{TabStrip,TabSwitcher}.tsx` (modify) | 13 | To-do icon, rename, context menu |
| `packages/ui/src/components/sidebar/{ProjectList,NewItemInput}.tsx` (modify) | 14 | Workspace "To-do lists" sidebar section + `initialValue` prop |
| — | 15 | Final `pnpm check` + human smoke-test handoff |

---

## Task 1: API wire types

**Files:**
- Modify: `packages/api/src/index.ts` (after the last `Fs*` type `FsCapabilitiesResponse`, ~line 225; the Git types follow it — place these after them)

**Interfaces:**
- Produces: `TodoScope`, `TodoListRecord`, `CreateTodoRequest`, `UpdateTodoRequest`, `TodoEventType` (consumed by Tasks 2–14).

- [ ] **Step 1: Add the wire-type block** (spec §3, verbatim)

```ts
// To-do lists — daemon-owned, synced checklists. One record per list; the checklist
// is GitHub task-list markdown in `body`. Scoped to a workspace (refKey = workspace
// name) or a project (refKey = project path). No PTY/session.

export type TodoScope = "workspace" | "project";

export interface TodoListRecord {
  id: string;
  name: string;            // free-form, renamable (NOT a filename)
  scope: TodoScope;
  refKey: string;          // workspace name (scope "workspace") | project path (scope "project")
  body: string;            // "- [ ] a\n- [x] b" ; "" when empty
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
}

export interface CreateTodoRequest {
  scope: TodoScope;
  refKey: string;
  name?: string;           // default "Untitled"
}

/** Patch: send only the fields you change. */
export interface UpdateTodoRequest {
  name?: string;
  body?: string;
}

/** `/events` channel "todos"; type one of these. Payload is always a full TodoListRecord
 *  (for "todo.deleted" it is the record as it was at deletion — clients remove by id). */
export type TodoEventType = "todo.created" | "todo.updated" | "todo.deleted";
```

Do **not** add methods to `HttpOrquesterApiClient` (it has no `put` helper and the UI doesn't use it — see spec §3).

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): add to-do list wire types"
```

---

## Task 2: Config — path helper + schema triad

**Files:**
- Modify: `packages/config/src/index.ts` (path helper next to `sessionsIndexPath` ~line 124; schemas after the sessions schemas ~line 421; appdir-layout comment ~lines 49-56)

**Interfaces:**
- Produces: `todosIndexPath(baseDir): string`, `todoRecordSchema`, `TodoRecord`, `todosConfigSchema`, `TodosConfig`, `createDefaultTodosConfig()`, `parseTodosConfig(raw): TodosConfig` (consumed by Tasks 3, 4).

- [ ] **Step 1: Add the path helper** (use the file's own `joinPath` — there is **no** `node:path` import here; only `z` from zod)

```ts
export function todosIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "todos.json");
}
```

- [ ] **Step 2: Add the schema triad** (after the sessions schemas, ~line 421)

```ts
export const todoScopeSchema = z.enum(["workspace", "project"]);

export const todoRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  scope: todoScopeSchema,
  refKey: z.string().min(1),
  body: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TodoRecord = z.infer<typeof todoRecordSchema>;

export const todosConfigSchema = z.object({
  version: z.literal(1).default(1),
  todos: z.array(todoRecordSchema).default([])
});
export type TodosConfig = z.infer<typeof todosConfigSchema>;

export function createDefaultTodosConfig(): TodosConfig {
  return { version: 1, todos: [] };
}

export function parseTodosConfig(raw: unknown): TodosConfig {
  return todosConfigSchema.parse(raw);
}
```

- [ ] **Step 3: Document `todos.json`** in the appdir-layout comment block (~lines 49-56), next to `sessions.json`.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/index.ts
git commit -m "feat(config): add todos.json path + zod schema"
```

---

## Task 3: Daemon `TodoListManager`

**Files:**
- Create: `apps/daemon/src/todos.ts`
- Verify (scratchpad, not committed): `<scratchpad>/verify-todos.ts`

**Interfaces:**
- Consumes: `TodoRecord`, `parseTodosConfig` (`@orquester/config`); `TodoScope` (`@orquester/api`).
- Produces:
  - `class TodoError extends Error { status: number }`
  - `class TodoListManager` with `readonly lifecycle: EventEmitter` (emits `"created"|"updated"|"deleted"` with a `TodoRecord`) and:
    - `load(): Promise<void>`
    - `list(scope: TodoScope, refKey: string): TodoRecord[]`
    - `get(id: string): TodoRecord | undefined`
    - `create(scope: TodoScope, refKey: string, name?: string): Promise<TodoRecord>`
    - `update(id: string, patch: { name?: string; body?: string }): Promise<TodoRecord>`
    - `delete(id: string): Promise<void>`
    - `deleteByProjectPath(path: string): Promise<void>`
    - `deleteByWorkspace(name: string, workspacePath: string): Promise<void>`

- [ ] **Step 1: Write the verification script** (it will fail first — the module doesn't exist yet)

Write to `<scratchpad>/verify-todos.ts`:

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Absolute import so resolution doesn't depend on this script's location:
import { TodoListManager, TodoError } from "/var/lib/orquester/workspaces/appsstats/orquester/apps/daemon/src/todos.ts";

const dir = mkdtempSync(join(tmpdir(), "todoverify-"));
const indexPath = join(dir, "todos.json");
const events: string[] = [];

async function main() {
  const m = new TodoListManager(indexPath);
  m.lifecycle.on("created", (r: any) => events.push(`created:${r.id}`));
  m.lifecycle.on("deleted", (r: any) => events.push(`deleted:${r.id}`));
  await m.load(); // ENOENT → empty, no throw

  // create + default name
  const a = await m.create("project", "/ws/proj", undefined);
  assert.equal(a.name, "Untitled");
  assert.equal(a.body, "");
  assert.equal(a.scope, "project");
  const b = await m.create("workspace", "ws", "Groceries");
  assert.equal(b.name, "Groceries");

  // list filters by (scope, refKey)
  assert.equal(m.list("project", "/ws/proj").length, 1);
  assert.equal(m.list("workspace", "ws").length, 1);
  assert.equal(m.list("project", "/other").length, 0);

  // update body + name; updatedAt bumps
  const updated = await m.update(a.id, { body: "- [ ] x\n- [x] y", name: "Bugs" });
  assert.equal(updated.name, "Bugs");
  assert.equal(updated.body, "- [ ] x\n- [x] y");

  // persisted to disk as JSON
  const onDisk = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.todos.length, 2);

  // reload from disk → survives "restart"
  const m2 = new TodoListManager(indexPath);
  await m2.load();
  assert.equal(m2.get(a.id)?.body, "- [ ] x\n- [x] y");
  assert.equal(m2.list("workspace", "ws").length, 1);

  // 404 on missing
  await assert.rejects(() => m2.update("nope", { name: "z" }), (e: any) => e instanceof TodoError && e.status === 404);

  // cascade: project path
  const c = await m2.create("project", "/ws/proj", "More");
  await m2.deleteByProjectPath("/ws/proj");
  assert.equal(m2.list("project", "/ws/proj").length, 0);

  // cascade: workspace removes its own lists + nested project lists
  const m3 = new TodoListManager(join(dir, "todos2.json"));
  await m3.load();
  await m3.create("workspace", "myws", "WS list");
  await m3.create("project", "/root/myws/api", "proj list");   // nested under workspace path /root/myws
  await m3.create("project", "/root/other/x", "keep");          // different workspace
  await m3.deleteByWorkspace("myws", "/root/myws");
  assert.equal(m3.list("workspace", "myws").length, 0);
  assert.equal(m3.list("project", "/root/myws/api").length, 0);
  assert.equal(m3.list("project", "/root/other/x").length, 1);  // untouched

  console.log("OK", { events });
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx <scratchpad>/verify-todos.ts`
Expected: FAIL — cannot resolve `apps/daemon/src/todos.ts` (module not found).

- [ ] **Step 3: Implement `apps/daemon/src/todos.ts`**

```ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import type { TodoScope } from "@orquester/api";
import { type TodoRecord, parseTodosConfig } from "@orquester/config";

export class TodoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "TodoError";
  }
}

/**
 * Daemon-owned to-do lists. In-memory map mirrored to `todos.json` with an atomic
 * tmp+rename write and reloaded on boot — the same durability model as the session index.
 * `lifecycle` emits "created" | "updated" | "deleted", each with the TodoRecord.
 */
export class TodoListManager {
  private readonly todos = new Map<string, TodoRecord>();
  readonly lifecycle = new EventEmitter();
  private loaded = false;

  constructor(
    private readonly indexPath: string,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.indexPath, "utf8");
      const parsed = parseTodosConfig(JSON.parse(text));
      this.todos.clear();
      for (const rec of parsed.todos) this.todos.set(rec.id, rec);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // Corrupt/unreadable: keep the map empty but DON'T overwrite the file.
        this.logger.warn(`Failed to read todos index: ${String(error)}`);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.indexPath}.tmp`;
    try {
      await mkdir(dirname(this.indexPath), { recursive: true });
      const data = { version: 1 as const, todos: [...this.todos.values()] };
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.indexPath);
    } catch (error) {
      console.error("Failed to persist todos index", error);
    }
  }

  list(scope: TodoScope, refKey: string): TodoRecord[] {
    return [...this.todos.values()]
      .filter((t) => t.scope === scope && t.refKey === refKey)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  get(id: string): TodoRecord | undefined {
    return this.todos.get(id);
  }

  async create(scope: TodoScope, refKey: string, name?: string): Promise<TodoRecord> {
    if (scope !== "workspace" && scope !== "project") throw new TodoError(400, "invalid scope");
    if (!refKey) throw new TodoError(400, "refKey required");
    const now = new Date().toISOString();
    const record: TodoRecord = {
      id: randomUUID(),
      name: name?.trim() || "Untitled",
      scope,
      refKey,
      body: "",
      createdAt: now,
      updatedAt: now
    };
    this.todos.set(record.id, record);
    await this.persist();
    this.lifecycle.emit("created", record);
    return record;
  }

  async update(id: string, patch: { name?: string; body?: string }): Promise<TodoRecord> {
    const record = this.todos.get(id);
    if (!record) throw new TodoError(404, "todo not found");
    if (patch.name !== undefined) record.name = patch.name.trim() || "Untitled";
    if (patch.body !== undefined) record.body = patch.body;
    record.updatedAt = new Date().toISOString();
    await this.persist();
    this.lifecycle.emit("updated", record);
    return record;
  }

  async delete(id: string): Promise<void> {
    const record = this.todos.get(id);
    if (!record) throw new TodoError(404, "todo not found");
    this.todos.delete(id);
    await this.persist();
    this.lifecycle.emit("deleted", record);
  }

  async deleteByProjectPath(path: string): Promise<void> {
    const removed = [...this.todos.values()].filter((t) => t.scope === "project" && t.refKey === path);
    if (removed.length === 0) return;
    for (const r of removed) this.todos.delete(r.id);
    await this.persist();
    for (const r of removed) this.lifecycle.emit("deleted", r);
  }

  async deleteByWorkspace(name: string, workspacePath: string): Promise<void> {
    const prefix = workspacePath + sep;
    const removed = [...this.todos.values()].filter(
      (t) =>
        (t.scope === "workspace" && t.refKey === name) ||
        (t.scope === "project" && (t.refKey === workspacePath || t.refKey.startsWith(prefix)))
    );
    if (removed.length === 0) return;
    for (const r of removed) this.todos.delete(r.id);
    await this.persist();
    for (const r of removed) this.lifecycle.emit("deleted", r);
  }
}
```

- [ ] **Step 4: Run the verification script — expect PASS**

Run: `node --import tsx <scratchpad>/verify-todos.ts`
Expected: prints `OK { events: [ ... ] }` and exits 0.

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit** (the verify script lives in the scratchpad and is NOT committed)

```bash
git add apps/daemon/src/todos.ts
git commit -m "feat(daemon): add TodoListManager (managed todos.json + lifecycle)"
```

---

## Task 4: Daemon routes + wiring

**Files:**
- Modify: `apps/daemon/src/index.ts`

**Interfaces:**
- Consumes: `TodoListManager`/`TodoError` (Task 3), `todosIndexPath` (Task 2), `TodoListRecord`/`CreateTodoRequest`/`UpdateTodoRequest` (Task 1).
- Produces: routes `GET/POST /api/todos`, `PUT/DELETE /api/todos/:id`; broadcasts on channel `"todos"`.

- [ ] **Step 1: Imports** — add `import { TodoError, TodoListManager } from "./todos";` (next to the sessions/accounts imports) and add `todosIndexPath` to the existing `@orquester/config` import.

- [ ] **Step 2: Resolve the path** — in the `resolved: ResolvedPaths` object literal (~line 167, next to `sessionsIndexFile: sessionsIndexPath(paths.baseDir)`), add:

```ts
todosIndexFile: todosIndexPath(paths.baseDir),
```

If `ResolvedPaths` is an explicit type/interface, add `todosIndexFile: string;` to it.

- [ ] **Step 3: Construct + load** (next to the session manager, ~line 190):

```ts
const todos = new TodoListManager(resolved.todosIndexFile, console);
await todos.load();
```

- [ ] **Step 4: Services** — add `todos: TodoListManager;` to the `Services` interface (~line 307) and include `todos` in the `services` object literal passed to `createServer`. Destructure `todos` where the other services are destructured at the top of `createServer`.

- [ ] **Step 5: Broadcast bridges** (next to the `session.*` bridges, ~lines 207-224):

```ts
todos.lifecycle.on("created", (r) => broadcaster.publish("todos", "todo.created", r));
todos.lifecycle.on("updated", (r) => broadcaster.publish("todos", "todo.updated", r));
todos.lifecycle.on("deleted", (r) => broadcaster.publish("todos", "todo.deleted", r));
```

- [ ] **Step 6: Routes** — register next to the `/api/sessions` block (~line 1470), mirroring the session route style (Fastify generics, `{ code, message }` errors):

```ts
app.get<{ Querystring: { scope?: string; refKey?: string } }>("/api/todos", async (request, reply) => {
  const { scope, refKey } = request.query;
  if ((scope !== "workspace" && scope !== "project") || !refKey) {
    return reply.code(400).send({ code: "BAD_REQUEST", message: "scope and refKey required" });
  }
  return reply.send(todos.list(scope, refKey));
});

app.post<{ Body: CreateTodoRequest }>("/api/todos", async (request, reply) => {
  const body = (request.body ?? {}) as CreateTodoRequest;
  try {
    const rec = await todos.create(body.scope, body.refKey, body.name);
    return reply.code(201).send(rec);
  } catch (error) {
    const status = error instanceof TodoError ? error.status : 500;
    return reply.code(status).send({ code: "TODO_ERROR", message: (error as Error).message });
  }
});

app.put<{ Params: { id: string }; Body: UpdateTodoRequest }>("/api/todos/:id", async (request, reply) => {
  const body = (request.body ?? {}) as UpdateTodoRequest;
  try {
    const rec = await todos.update(request.params.id, { name: body.name, body: body.body });
    return reply.send(rec);
  } catch (error) {
    const status = error instanceof TodoError ? error.status : 500;
    return reply.code(status).send({ code: "TODO_ERROR", message: (error as Error).message });
  }
});

app.delete<{ Params: { id: string } }>("/api/todos/:id", async (request, reply) => {
  try {
    await todos.delete(request.params.id);
    return reply.code(204).send();
  } catch (error) {
    const status = error instanceof TodoError ? error.status : 500;
    return reply.code(status).send({ code: "TODO_ERROR", message: (error as Error).message });
  }
});
```

Add `CreateTodoRequest, UpdateTodoRequest` to the `@orquester/api` type import at the top.

- [ ] **Step 7: Cascade** — in the existing delete handlers, after the `sessions.closeByProjectPrefix(target)` call:
  - Project delete (~lines 642-666): `await todos.deleteByProjectPath(target);` — `target` is the raw-join path (~line 650), **not** `safe`.
  - Workspace delete (~lines 668-699): `await todos.deleteByWorkspace(workspace, target);` — `workspace` is the name param (~line 671), `target` the raw-join workspace path (~line 686).

- [ ] **Step 8: Typecheck** (do NOT start the daemon)

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): /api/todos routes + broadcast + cascade-delete"
```

---

## Task 5: UI api-client methods

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (after the file methods, ~line 256)

**Interfaces:**
- Consumes: `TodoScope`/`TodoListRecord`/`CreateTodoRequest`/`UpdateTodoRequest` (Task 1).
- Produces: `api.listTodos`, `api.createTodo`, `api.updateTodo`, `api.deleteTodo`.

- [ ] **Step 1: Add the methods** (`send` supports `"PUT"`; the transporter omits `undefined` query params; `deleteTodo` returning `void` matches existing 204 deletes like `deleteSession`)

```ts
listTodos(scope: TodoScope, refKey: string, signal?: AbortSignal): Promise<TodoListRecord[]> {
  return this.send("GET", "/api/todos", { query: { scope, refKey }, signal });
}
createTodo(req: CreateTodoRequest): Promise<TodoListRecord> {
  return this.send("POST", "/api/todos", { body: req });
}
updateTodo(id: string, patch: UpdateTodoRequest): Promise<TodoListRecord> {
  return this.send("PUT", `/api/todos/${encodeURIComponent(id)}`, { body: patch });
}
deleteTodo(id: string): Promise<void> {
  return this.send("DELETE", `/api/todos/${encodeURIComponent(id)}`);
}
```

- [ ] **Step 2:** Add `TodoScope, TodoListRecord, CreateTodoRequest, UpdateTodoRequest` to the `import type { … } from "@orquester/api"` block.

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/api-client.ts
git commit -m "feat(ui): api-client to-do methods"
```

---

## Task 6: UI store — context, to-do tabs, actions, events

**Files:**
- Modify: `packages/ui/src/store/app.ts`

**Interfaces:**
- Consumes: `TodoScope`/`TodoListRecord` (Task 1), `api.listTodos/createTodo/updateTodo/deleteTodo` (Task 5).
- Produces (consumed by Tasks 8–14):
  - `export type TabContext`, `export function currentContext(state): TabContext | null`, `export function todoRefOf(ctx)`
  - `export interface TodoTab { id; contextKey; todoId; title }`; `ProjectTab` gains `| { id; type: "todo"; todoId; title }`
  - state: `todoTabsByContext: Record<string, TodoTab[]>`, `todos: TodoListRecord[]`
  - actions: `loadTodos`, `createTodo`, `openTodo`, `renameTodo`, `saveTodoBody`, `deleteTodo`
  - selectors: `useProjectTabs()` (now context-aware), `useActiveTabId()`

> Reproduce the verbatim blocks from **spec §8a–§8f**. Implement in this order so the file always
> moves toward compiling. All API-calling actions begin with `const api = get().api; if (!api) return;`.

- [ ] **Step 1: Context helpers** — add `TabContext`, `currentContext`, `todoRefOf` exactly as in spec §8a.

- [ ] **Step 2: Types** — add `TodoTab` (after `GitTab`, ~line 267) and the `| { id: string; type: "todo"; todoId: string; title: string }` arm to `ProjectTab` (~line 275), per spec §8b steps 1–2.

- [ ] **Step 3: State** — per spec §8b step 3: keep `activeTabByProject` (now context-keyed; add a clarifying comment), add `todoTabsByContext: Record<string, TodoTab[]>` and `todos: TodoListRecord[]` to `AppState`, and initialize both (`{}` / `[]`) in the `create(...)` initial state (~line 502). Add `TodoScope, TodoListRecord` to the `@orquester/api` import; add `TabContext`, `TodoTab` to the action/selector interface as needed.

- [ ] **Step 4: Actions** — add the six actions to the `AppState` action signatures and implementation, per spec §8c:
  - `loadTodos(scope, refKey)`: `api.listTodos` → merge into `todos` (replace records with the same `(scope, refKey)`, keep others).
  - `createTodo(scope, refKey, name?)`: `await api.createTodo({scope,refKey,name})`; upsert into `todos`; then `get().openTodo(rec)`.
  - `openTodo(rec)`: find-or-create a `TodoTab` for `rec.id` under `todoTabsByContext[rec.refKey]` (reuse if a tab with that `todoId` exists); set `activeTabByProject[rec.refKey] = tab.id`. Model on `openGit` (~line 1163).
  - `renameTodo(id, name)`: optimistic cache + open-tab title update; `await api.updateTodo(id,{name})`.
  - `saveTodoBody(id, body)`: optimistic cache `body`/`updatedAt`; `await api.updateTodo(id,{body})`.
  - `deleteTodo(id)`: `await api.deleteTodo(id)`; drop from `todos`; close any open tab with that `todoId` across all `todoTabsByContext` entries (reuse `removeLocalTab`).

- [ ] **Step 5: Navigation hooks** — per spec §8c: in `openWorkspace` (async, ~line 1020) add `void get().loadTodos("workspace", name)`; in `openProject` (**synchronous** `=> void`, ~line 1071) add `void get().loadTodos("project", project.path)` (fire-and-forget — do NOT `await`).

- [ ] **Step 6: Close/cleanup helpers** — per spec §8d:
  - `useActiveTabId` → read `activeTabByProject[currentProject?.path ?? currentWorkspace ?? null]` (code in spec §8d).
  - `firstTabId(...)` → add a `todoTabs` arg (`… ?? todoTabs?.[0]?.id ?? null`) and **update every call site** (notably `openProject` ~line 1071) to pass the `todoTabsByContext` slice.
  - `reassignActive(...)` → thread `todoTabsByContext` to `firstTabId`.
  - `removeLocalTab(state, id)` → also filter `todoTabsByContext`.
  - `clearProjectLocalState(...)` → also purge `todoTabsByContext` for matching key(s) and drop those records from `todos`.

- [ ] **Step 7: `useProjectTabs`** — replace its body with the context-aware version in spec §8e (keep the name; keep the four single-slice selectors + `useMemo`; append `todoTabs`; return only `todoTabs` in workspace context).

- [ ] **Step 8: Event reduction** — in `applyEvent` (~lines 1282-1313), add a `"todos"` channel branch **before** the `event.channel !== "sessions"` early return, with `applyTodoUpsert` / `removeTodoEverywhere` helpers, per spec §8f.

- [ ] **Step 9: Typecheck**

Run: `pnpm check`
Expected: PASS. (If `firstTabId` arity errors appear, you missed a call site in Step 6 — fix them.)

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/store/app.ts
git commit -m "feat(ui): store — tab context + to-do tabs, cache, actions, events"
```

---

## Task 7: Pure markdown lib

**Files:**
- Create: `packages/ui/src/components/todo/todo-markdown.ts`
- Verify (scratchpad, not committed): `<scratchpad>/verify-md.ts`

**Interfaces:**
- Produces: `interface TodoItem { id: string; checked: boolean; text: string }`, `parseTodoMarkdown(body: string): TodoItem[]`, `serializeTodoMarkdown(items: TodoItem[]): string` (consumed by Tasks 8, 9).

- [ ] **Step 1: Write the verification script**

Write to `<scratchpad>/verify-md.ts`:

```ts
import { strict as assert } from "node:assert";
import { parseTodoMarkdown, serializeTodoMarkdown } from "/var/lib/orquester/workspaces/appsstats/orquester/packages/ui/src/components/todo/todo-markdown.ts";

// parse: open + done, "-" and "*", optional space after bracket, ignore non-task lines
const items = parseTodoMarkdown("- [ ] milk\n* [x] bread\n\nsome prose\n- [X] eggs");
assert.equal(items.length, 3);
assert.deepEqual(items.map((i) => i.checked), [false, true, true]);
assert.deepEqual(items.map((i) => i.text), ["milk", "bread", "eggs"]);
assert.ok(items.every((i) => typeof i.id === "string" && i.id.length > 0));

// serialize: canonical "- [ ]"/"- [x]", one per line, no trailing blank line
const out = serializeTodoMarkdown([
  { id: "1", checked: false, text: "a" },
  { id: "2", checked: true, text: "b" }
]);
assert.equal(out, "- [ ] a\n- [x] b");

// round-trip preserves order + checked + text (ids are regenerated, so compare on those)
const round = parseTodoMarkdown(serializeTodoMarkdown(items));
assert.deepEqual(
  round.map(({ checked, text }) => ({ checked, text })),
  items.map(({ checked, text }) => ({ checked, text }))
);

// empty body → no items; empty items → empty string
assert.deepEqual(parseTodoMarkdown(""), []);
assert.equal(serializeTodoMarkdown([]), "");

console.log("OK");
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `node --import tsx <scratchpad>/verify-md.ts`
Expected: FAIL (cannot resolve the module).

- [ ] **Step 3: Implement `todo-markdown.ts`**

```ts
export interface TodoItem {
  /** Render-only stable key for list/drag. Never serialized; regenerated on each parse. */
  id: string;
  checked: boolean;
  text: string;
}

const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s?(.*)$/;

/** Parse GitHub task-list markdown into items. Non-task lines are ignored. */
export function parseTodoMarkdown(body: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    items.push({ id: crypto.randomUUID(), checked: m[1] === "x" || m[1] === "X", text: m[2] });
  }
  return items;
}

/** Serialize items to "- [ ] text" / "- [x] text", one per line, no trailing blank line. */
export function serializeTodoMarkdown(items: TodoItem[]): string {
  return items.map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`).join("\n");
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `node --import tsx <scratchpad>/verify-md.ts`
Expected: prints `OK`, exits 0.

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/todo/todo-markdown.ts
git commit -m "feat(ui): to-do task-list markdown parse/serialize"
```

---

## Task 8: `use-todo-doc` hook

**Files:**
- Create: `packages/ui/src/hooks/use-todo-doc.ts`

**Interfaces:**
- Consumes: `parseTodoMarkdown`/`serializeTodoMarkdown`/`TodoItem` (Task 7); `useAppStore` + `saveTodoBody` + `todos` cache (Task 6); `TodoListRecord` (Task 1).
- Produces: `useTodoDoc(todoId): { record: TodoListRecord | undefined; items: TodoItem[]; setItems(next): void; saving: boolean }`.

- [ ] **Step 1: Implement the hook** (load from the store cache; optimistic local items; 400 ms debounced save; flush on unmount; reconcile external body when idle)

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { TodoListRecord } from "@orquester/api";
import { useAppStore } from "../store/app";
import { parseTodoMarkdown, serializeTodoMarkdown, type TodoItem } from "../components/todo/todo-markdown";

const DEBOUNCE_MS = 400;

export function useTodoDoc(todoId: string): {
  record: TodoListRecord | undefined;
  items: TodoItem[];
  setItems: (next: TodoItem[]) => void;
  saving: boolean;
} {
  const record = useAppStore((s) => s.todos.find((t) => t.id === todoId));
  const saveTodoBody = useAppStore((s) => s.saveTodoBody);

  const [items, setItemsState] = useState<TodoItem[]>(() => parseTodoMarkdown(record?.body ?? ""));
  const [saving, setSaving] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null); // serialized body waiting to be saved
  const lastSynced = useRef<string>(record?.body ?? "");

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current === null) return;
    const body = pending.current;
    pending.current = null;
    // Mark as synced BEFORE awaiting: saveTodoBody does a synchronous optimistic store
    // write (new record.body) that re-runs the reconcile effect mid-flight. Setting
    // lastSynced now makes the reconcile guard treat that write as self-originated, so it
    // won't re-parse the body and churn the render-only item ids. On save failure the next
    // external todo.updated event still reconciles.
    lastSynced.current = body;
    setSaving(true);
    try {
      await saveTodoBody(todoId, body);
    } finally {
      setSaving(false);
    }
  }, [saveTodoBody, todoId]);

  const setItems = useCallback(
    (next: TodoItem[]) => {
      setItemsState(next);
      const body = serializeTodoMarkdown(next);
      pending.current = body;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush]
  );

  // Reconcile an external body change (another client) only when there's no pending local edit.
  useEffect(() => {
    const body = record?.body ?? "";
    if (pending.current === null && body !== lastSynced.current) {
      lastSynced.current = body;
      setItemsState(parseTodoMarkdown(body));
    }
  }, [record?.body]);

  // Flush any pending save on unmount.
  useEffect(() => () => void flush(), [flush]);

  return { record, items, setItems, saving };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/hooks/use-todo-doc.ts
git commit -m "feat(ui): useTodoDoc — debounced autosave + reconcile"
```

---

## Task 9: `TodoView` component

**Files:**
- Create: `packages/ui/src/components/todo/TodoView.tsx`
- Create: `packages/ui/src/components/todo/index.ts`

**Interfaces:**
- Consumes: `useTodoDoc`/`TodoItem` (Tasks 7–8); `ConfirmDialog` (`../ui`); `EmptyState` (`../main/EmptyState`).
- Produces: `export { TodoView }`; `TodoView` props `{ todoId: string; active: boolean }`.

- [ ] **Step 1: Implement `TodoView.tsx`** (flat checklist: add / toggle / inline-edit / delete / drag-reorder; "Hide done" view toggle; "Clear completed" with confirm; per spec §9c). Match the neutral palette and lucide icons used by `FileBrowser`/`GitView`.

```tsx
import React, { useMemo, useState } from "react";
import { Eye, EyeOff, GripVertical, ListTodo, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { ConfirmDialog } from "../ui";
import { EmptyState } from "../main/EmptyState";
import { useTodoDoc } from "../../hooks/use-todo-doc";
import type { TodoItem } from "./todo-markdown";

interface TodoViewProps {
  todoId: string;
  active: boolean;
}

export const TodoView: React.FC<TodoViewProps> = ({ todoId }) => {
  const { record, items, setItems, saving } = useTodoDoc(todoId);
  const [hideDone, setHideDone] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const completedCount = useMemo(() => items.filter((i) => i.checked).length, [items]);
  const visible = hideDone ? items.filter((i) => !i.checked) : items;

  if (!record) {
    return <EmptyState icon={<ListTodo size={40} strokeWidth={1.25} />} title="This list was deleted." description="" />;
  }

  const toggle = (id: string) =>
    setItems(items.map((i) => (i.id === id ? { ...i, checked: !i.checked } : i)));
  const remove = (id: string) => setItems(items.filter((i) => i.id !== id));
  const commitEdit = (id: string, text: string) => {
    const t = text.trim();
    setItems(t ? items.map((i) => (i.id === id ? { ...i, text: t } : i)) : items.filter((i) => i.id !== id));
    setEditingId(null);
  };
  const addItem = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setItems([...items, { id: crypto.randomUUID(), checked: false, text: t }]);
  };
  const reorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = [...items];
    const from = next.findIndex((i) => i.id === dragId);
    const to = next.findIndex((i) => i.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900/40 px-3">
        <ListTodo size={14} className="text-neutral-500" />
        <span className="flex-1 truncate text-sm text-neutral-200">{record.name}</span>
        {saving ? <span className="text-xs text-neutral-600">saving…</span> : null}
        <button
          type="button"
          onClick={() => setHideDone((v) => !v)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800"
        >
          {hideDone ? <EyeOff size={13} /> : <Eye size={13} />}
          {hideDone ? "Show done" : "Hide done"}
        </button>
        <button
          type="button"
          disabled={completedCount === 0}
          onClick={() => setConfirmClear(true)}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
        >
          Clear completed
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {items.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-neutral-600">No items yet — add one below.</p>
        ) : (
          <ul className="flex flex-col">
            {visible.map((item: TodoItem) => (
              <li
                key={item.id}
                draggable={editingId !== item.id}
                onDragStart={() => setDragId(item.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { reorder(item.id); setDragId(null); }}
                className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-neutral-900"
              >
                <GripVertical size={13} className="shrink-0 cursor-grab text-neutral-700 opacity-0 group-hover:opacity-100" />
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={() => toggle(item.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-neutral-400"
                />
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(item.id, draft)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(item.id, draft);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 text-sm text-neutral-100 outline-none"
                  />
                ) : (
                  <span
                    onClick={() => { setEditingId(item.id); setDraft(item.text); }}
                    className={cn(
                      "flex-1 cursor-text truncate text-sm",
                      item.checked ? "text-neutral-500 line-through" : "text-neutral-200"
                    )}
                  >
                    {item.text}
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Delete item"
                  onClick={() => remove(item.id)}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-600 opacity-0 hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddItemInput onAdd={addItem} />

      <ConfirmDialog
        open={confirmClear}
        title="Clear completed items"
        message={`Clear ${completedCount} completed ${completedCount === 1 ? "item" : "items"}?`}
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setItems(items.filter((i) => !i.checked));
          setConfirmClear(false);
        }}
      />
    </div>
  );
};

const AddItemInput: React.FC<{ onAdd: (text: string) => void }> = ({ onAdd }) => {
  const [value, setValue] = useState("");
  return (
    <div className="shrink-0 border-t border-neutral-800 px-3 py-2">
      <input
        value={value}
        placeholder="Add a to-do…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) {
            onAdd(value);
            setValue("");
          }
        }}
        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
      />
    </div>
  );
};
```

- [ ] **Step 2: Create the barrel `index.ts`**

```ts
export { TodoView } from "./TodoView";
```

- [ ] **Step 3: Typecheck** (confirm `ConfirmDialog` is exported from `../ui` and `EmptyState` from `../main/EmptyState`; adjust the import paths if `pnpm check` reports otherwise)

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/todo/TodoView.tsx packages/ui/src/components/todo/index.ts
git commit -m "feat(ui): TodoView checklist editor"
```

---

## Task 10: Wire `TodoView` into `MainView`

**Files:**
- Modify: `packages/ui/src/components/main/MainView.tsx`

**Interfaces:**
- Consumes: `TodoView` (Task 9); `useProjectTabs`/`currentContext` (Task 6).

- [ ] **Step 1: Imports** — add `import { TodoView } from "../todo";`, `currentContext` from `../../store/app`, and `ListTodo` from `lucide-react`.

- [ ] **Step 2: Icon** — extend `cellIcon` (~line 20) to return `<ListTodo size={13} />` for `tab.type === "todo"`. (`cellTitle` already uses `tab.title`.)

- [ ] **Step 3: Context + empty states** — add `const ctx = useAppStore(currentContext);` and replace the `!currentProject` gate (~line 58) per spec §10a:
  - `if (!ctx)` → `EmptyState` "No workspace selected".
  - `tabs.length === 0` → project context keeps the existing "No tabs open"; workspace context → `EmptyState` `<ListTodo/>` "No to-do lists open".

- [ ] **Step 4: Render switch** — extend (~line 130) to the 4-way from spec §10a (the `git`/`files` arms read `ctx.kind === "project" ? ctx.project.path : ""`; the new arm is `<TodoView todoId={tab.todoId} active={show} />`).

- [ ] **Step 5: View mode** — when `ctx?.kind === "workspace"`, force tab view (no grid). Confirm `useViewMode` returns `"tab"` without a current project; guard if needed.

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/main/MainView.tsx
git commit -m "feat(ui): MainView renders to-do tabs + workspace context"
```

---

## Task 11: `TopBar` — gate the strip on context

**Files:**
- Modify: `packages/ui/src/components/topbar/TopBar.tsx`

- [ ] **Step 1:** Add `const ctx = useAppStore(currentContext);` (import `currentContext` from `../../store/app`). Render the `TabStrip` + `NewTabMenu` cluster whenever `ctx` is non-null (desktop ~lines 67-78 and mobile ~53-59). Render `<ProjectSwitcher/>` and `<ViewModeToggle/>` **only** when `ctx?.kind === "project"`. The "Select a project to begin" fallback shows only when `ctx` is `null`. (Spec §10b.)

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/topbar/TopBar.tsx
git commit -m "feat(ui): TopBar shows the tab strip in workspace context"
```

---

## Task 12: `NewTabMenu` — context-aware "+" menu

**Files:**
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx`

**Interfaces:**
- Consumes: `createTodo`/`openTodo`/`todos`/`currentContext` (Task 6).

- [ ] **Step 1:** Add `const ctx = useAppStore(currentContext);` plus `todos`, `createTodo`, `openTodo` selectors, and `ListTodo` import. Branch per spec §10c:
  - Project context: keep Shells/Agents; under the **Tools** label (after Git, ~lines 57-59) add `New to-do list` → `createTodo("project", ctx.key)`, then `todos.filter(t => t.scope==="project" && t.refKey===ctx.key)` reopen items → `openTodo(rec)`.
  - Workspace context: render **only** a to-do section — `New to-do list` → `createTodo("workspace", ctx.key)` + the workspace's lists to reopen. No Shells/Agents/File Browser/Git.

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/topbar/NewTabMenu.tsx
git commit -m "feat(ui): context-aware + menu with to-do entries"
```

---

## Task 13: `TabStrip` / `TabSwitcher` — icon, rename, menu

**Files:**
- Modify: `packages/ui/src/components/topbar/TabStrip.tsx`
- Modify: `packages/ui/src/components/topbar/TabSwitcher.tsx`

**Interfaces:**
- Consumes: `renameTodo`/`deleteTodo`/`closeTab` (Task 6); `ConfirmDialog` (`../ui`).

- [ ] **Step 1: Icons** — add a `ListTodo` branch for `type === "todo"` in the TabStrip icon ladder (~lines 92-98) and `TabSwitcher`'s `tabIcon` (~lines 10-17).

- [ ] **Step 2: Rename** — change the rename gates from `isSession` to `isSession || tab.type === "todo"` (double-click ~line 106 and the `TabRenameInput` mount), and branch the commit: session → `renameTab(...)`; to-do → `renameTodo(tab.todoId, value)`. (Spec §10d.)

- [ ] **Step 3: Context menu** — in `menuItems` (~lines 77-83), a `type === "todo"` tab returns **Rename** (enter edit mode), **Delete list** (open a `ConfirmDialog` "Delete '\<name>'? This removes it on every machine.", `danger`; on confirm `deleteTodo(tab.todoId)`), **Close** (`closeTab`). Sessions stay Rename+Close; files/git stay Close-only. Track the pending-delete tab in local state and render one `ConfirmDialog`.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/topbar/TabStrip.tsx packages/ui/src/components/topbar/TabSwitcher.tsx
git commit -m "feat(ui): to-do tab icon, rename, delete/close menu"
```

---

## Task 14: Sidebar — workspace "To-do lists" section

**Files:**
- Modify: `packages/ui/src/components/sidebar/NewItemInput.tsx`
- Modify: `packages/ui/src/components/sidebar/ProjectList.tsx`

**Interfaces:**
- Consumes: `createTodo`/`openTodo`/`renameTodo`/`deleteTodo`/`todos` + `currentWorkspace` (Task 6); `ConfirmDialog` (`../ui`).

- [ ] **Step 1: `NewItemInput` — add an optional `initialValue`** so it can pre-fill a name for rename:

```tsx
// props: add `initialValue?: string;`
// seed the input state from it:
const [value, setValue] = useState(initialValue ?? "");
```

(Default `""` keeps existing call sites — the folder-create input — unchanged.)

- [ ] **Step 2: `ProjectList` — create entry** — add `New to-do list` to the header **"New"** `Dropdown` (after New Folder, ~line 63) with a `ListTodo` icon → `createTodo("workspace", currentWorkspace)`.

- [ ] **Step 3: `ProjectList` — list section** — below the project `<nav>`, render a labeled "To-do lists" group from `todos.filter(t => t.scope==="workspace" && t.refKey===currentWorkspace)` (sorted by `createdAt`). Each row: `ListTodo` icon + name; click → `openTodo(rec)`; right-click → a `ContextMenu` (mirror ~line 112) with **Rename** and **Delete**. Match the project-row styling (~lines 90-109).
  - **Rename** → render `NewItemInput` seeded with `rec.name`; Enter → `renameTodo(rec.id, value)`; Escape cancels.
  - **Delete** → `ConfirmDialog` ("Delete '\<name>'?", defaults — no typed-name gate, like the project delete ~lines 121-138) → `deleteTodo(rec.id)`.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/sidebar/NewItemInput.tsx packages/ui/src/components/sidebar/ProjectList.tsx
git commit -m "feat(ui): workspace sidebar To-do lists section"
```

---

## Task 15: Final verification + human smoke-test handoff

**Files:** none (verification gate).

- [ ] **Step 1: Full typecheck**

Run: `pnpm check`
Expected: PASS across all packages — **this is the done gate.**

- [ ] **Step 2: Self-read** the diff for the integration tasks (10–14) and confirm no `tab.type === "todo"` branch was missed in any icon/render ladder.

- [ ] **Step 3: Hand off to the human operator** (agents must NOT start the daemon — AGENTS.md). Provide this checklist for them to run against a real daemon, per spec §12:
  - Daemon: `POST /api/todos {scope:"project",refKey:"<repo path>"}` → record; `GET …` lists it; `PUT …{body:"- [ ] x"}` updates; **restart daemon → persists**; `DELETE` removes; deleting a project/workspace removes its lists.
  - UI: workspace level → sidebar "To-do lists" → "New to-do list" opens a tab; add/check/edit/drag/hide-done/clear-completed autosave; reload → persists. Project level → "+" → To-do. Close keeps the list (reopen from "+"); Delete list (confirm) removes it everywhere. A second client sees changes live.

- [ ] **Step 4: Clean up** the scratchpad verify scripts (they were never committed): they can be left in the scratchpad or deleted — they are outside the repo either way.

---

## Self-Review (completed during authoring)

- **Spec coverage:** §3→T1, §4→T2, §5→T3, §6→T4, §7→T5, §8→T6, §9a→T7, §9b→T8, §9c/d→T9, §10a→T10, §10b→T11, §10c→T12, §10d→T13, §10e→T14, §11/§12→T1–15 gates + T15. No gaps.
- **Placeholders:** none — new-file tasks (3,7,8,9) carry full code; wiring/integration tasks carry concrete edits + spec section refs with signatures.
- **Type consistency:** `TodoListRecord`/`TodoScope` (T1) flow through config `TodoRecord` (T2), the manager (T3), routes (T4), client (T5), store (T6); `TodoItem`/`parseTodoMarkdown`/`serializeTodoMarkdown` (T7) → `useTodoDoc` (T8) → `TodoView` (T9); `currentContext`/`openTodo`/`createTodo`/`renameTodo`/`deleteTodo`/`todoTabsByContext` (T6) consumed by T10–14. Names checked end-to-end.
