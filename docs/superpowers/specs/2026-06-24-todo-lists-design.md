# To-do lists — design & implementation spec

**Status:** approved (2026-06-24) · **Branch:** `feat/todo-lists`

Synced, daemon-owned **to-do lists**: lightweight Notion-style checklists you create per
**workspace** and per **project**, edited in a focused checklist editor (add / check off /
delete / edit-text / drag-reorder / tidy-completed) and persisted by the daemon as GitHub-style
task-list markdown. Because the daemon owns them in its appdir, they survive daemon restarts and
are automatically the same on every machine that connects to the daemon. You can have many lists
per scope, each custom-named and renamable.

This document is the source of truth for the implementation. It is written to be read by
implementation agents with **no other context** — follow it exactly. Where it gives exact type
definitions, props, or commands, reproduce them verbatim (adjust only to make `pnpm check` pass).

---

## 1. Scope

- **In:**
  - Daemon-managed to-do lists (`todos.json`), scoped `workspace` (keyed by workspace **name**)
    or `project` (keyed by project **path**). CRUD + rename + body-save, atomic persistence,
    reload on boot, change-event broadcast, cascade-delete on workspace/project delete.
  - A checklist **editor** (`TodoView`): add item, toggle done, delete item, **edit item text
    inline**, **drag-reorder items**, **tidy completed** (hide-done toggle + clear-completed).
    Flat GitHub task-list markdown (`- [ ] ` / `- [x] `), one item per line.
  - **Project-scoped lists** open as **tabs** in the project tab strip (next to Git / File
    Browser), created/reopened from the "+" menu.
  - **Workspace-scoped lists** appear in the **workspace sidebar** and open as **tabs** in a new
    **workspace-context main view** (the tab strip + main view, generalized to also work when a
    workspace is open with no project).
  - Non-destructive **close** (hides the tab; list stays saved, reopen from "+"/sidebar) vs
    explicit **delete** (a "Delete list" action guarded by a confirm dialog).
  - Live cross-client sync via the existing `/events` bus (last-write-wins).
- **Out (v1):** sub-tasks / nesting, due dates, reminders, rich text, tags/priority, list-level
  reordering (lists sort by `createdAt`), per-item undo, collaborative/CRDT merge, grid view for
  workspace-context tabs, and the collapsed sidebar **rail** entry for to-do lists (rail is
  unchanged; to-do lists are reached from the expanded sidebar / "+" menu).

---

## 2. Architecture — two precedents, combined

The to-do list **data** follows the **session manager** precedent: daemon-owned managed state in
a JSON index, atomically persisted, reloaded on boot, broadcast on change, cascade-deleted with
its project/workspace. The to-do **tab** follows the **Git tab** precedent: a client-local,
non-PTY "view" tab rendered by `MainView`.

The one genuinely new structural piece: today the tab strip + `MainView` only exist **inside a
project** (`MainView.tsx:58` shows an empty state when `currentProject` is null; all tab maps are
keyed by project path). We **generalize the tab "context" from project to project-or-workspace**
so the same strip + main view also render when a workspace is open with no project — there it
offers only to-do tabs.

Key precedent files to imitate:
- Managed-state manager + atomic persist + lifecycle events: `apps/daemon/src/sessions.ts`
  (`persistIndex` tmp+rename `530-542`, `reorder`/`rename` `324-352`, `recordOf` `490-493`,
  `closeByProjectPrefix` `379-386`).
- Persisted-config schema triad: `packages/config/src/index.ts` (sessions block `396-421`,
  `sessionsIndexPath` `122-124`, appdir layout `49-56`).
- Broadcast wiring: `apps/daemon/src/index.ts` (the `session.*` lifecycle→broadcaster bridges
  `207-224`) and `apps/daemon/src/broadcaster.ts` (`publish` `23-39`).
- Client-local tab plumbing: `packages/ui/src/store/app.ts` (`GitTab`/`openGit` `~267`/`~1163`,
  `ProjectTab` union `~275`, the per-project tab maps `~398`, `useProjectTabs` `~1424`,
  `removeLocalTab`/`reassignActive`/`firstTabId`/`clearProjectLocalState`
  `~1364`/`~1331`/`~1316`/`~1391`).
- Tab rendering + integration: `packages/ui/src/components/main/MainView.tsx` (render switch
  `130-138`, `cellIcon`/`cellTitle` `20`/`30`), `topbar/TabStrip.tsx`, `topbar/TabSwitcher.tsx`,
  `topbar/NewTabMenu.tsx` (Tools section `53-59`).
- Read→edit→save editor *shape*: `packages/ui/src/hooks/use-file-text.ts` and
  `components/files/FilePreview.tsx` (`TextPreview` `103`). Note `use-file-text` does **not**
  debounce — its `save` is explicit/manual; the to-do editor adds its own debounced autosave (§9b).
- Confirm dialog: `packages/ui/src/components/ui/confirm-dialog.tsx` (used like
  `sidebar/ProjectList.tsx:121` — no typed-name gate).
- Sidebar entry points: `packages/ui/src/components/sidebar/ProjectList.tsx` (header "New"
  dropdown `63-68`, project nav rows `90-109`, context menu + confirm `112-138`).

**Transport policy:** `/api/todos/*` is allowed on **both** transports (local socket + remote
HTTP), exactly like `/api/sessions` and `/api/accounts` — the bearer-auth hook already guards
`/api/*` on the remote transport and no secret is ever returned. Do **not** add a
`mode === "remote"` guard.

**No new npm dependency.** Markdown parse/serialize is a tiny hand-written pure module. UUIDs via
`node:crypto` (daemon) / `crypto.randomUUID()` (browser). ESM everywhere.

---

## 3. Wire types — `packages/api/src/index.ts`

Add this block after the `Fs*`/Git interface block (the last `Fs*` type `FsCapabilitiesResponse`
ends ~line 225; the Git types follow it — place these after them). These names are the contract
used by the daemon, the **UI** api-client (§7), the store, and the components.

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

**Add only the types above** — do not add methods to the reference `HttpOrquesterApiClient` in
this file. That class is a reference client the UI does **not** use (the UI has its own
`send`-based `ApiClient`, §7), and it has no `put` helper and its `get`/`delete` don't handle a
204 — adding to-do methods there would mean extra plumbing for no consumer. The methods the app
actually calls go in §7.

---

## 4. Config — `packages/config/src/index.ts`

### 4a. Path helper (next to `sessionsIndexPath`, ~line 124)

```ts
export function todosIndexPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "todos.json");
}
```

Use the file's own **`joinPath`** helper (defined ~line 11) and `daemonConfigDir` (~line 67) —
**not** `node:path`'s `join`. This file imports only `z` from zod (there is no `node:path`
import), and `sessionsIndexPath` itself uses `joinPath`.

Add `todos.json` to the documented appdir layout comment (the `daemon/` block, ~lines 49-56).

### 4b. Schema triad (after the sessions schemas, ~line 421)

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

(`TodoRecord` here is structurally identical to `@orquester/api`'s `TodoListRecord`; config owns
the zod validation, api owns the wire type — same split as sessions.)

---

## 5. Daemon — `apps/daemon/src/todos.ts` (new file)

A `TodoListManager`: the session manager's shape minus all PTY/tmux machinery. In-memory `Map`
mirrored to `todos.json` with the **atomic tmp+rename** write, an `EventEmitter` for lifecycle,
and a robust read that treats ENOENT as "empty" but refuses to clobber on a parse error.

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
```

(`TodoScope` is the `"workspace" | "project"` union from `@orquester/api`; `sessions.ts` imports
its shared types the same split way — `SessionSummary` from `@orquester/api`, the record/config
types from `@orquester/config`.)

**Class `TodoListManager`:**

- Construct with `(private readonly indexPath: string, private readonly logger?: Pick<Console, "warn">)`.
- `private readonly todos = new Map<string, TodoRecord>();`
- `readonly lifecycle = new EventEmitter();` — a **plain, untyped** `EventEmitter`, exactly like
  `sessions.ts:103`. It emits `"created"` / `"updated"` / `"deleted"`, each with a `TodoRecord`
  payload; document the names/payloads in a comment (consumers cast at the `.on(...)` site, e.g.
  `(r: TodoRecord) => ...`).
- `private loaded = false;`

**Methods:**

- `async load(): Promise<void>` — read `indexPath`. On `ENOENT` → empty (first run). On other
  read/parse error → `logger?.warn(...)` and **leave the map empty without overwriting the file**
  (conservative, like `sessions.ts:502-522`). On success → `parseTodosConfig(JSON.parse(text))`
  then fill the map keyed by `id`. Set `loaded = true`.
- `private async persist(): Promise<void>` — verbatim pattern from `sessions.ts:530-542`:
  `await mkdir(dirname(this.indexPath), { recursive: true })`, write
  `${JSON.stringify({ version: 1, todos: [...this.todos.values()] }, null, 2)}\n` to
  `${this.indexPath}.tmp`, then `rename` over `this.indexPath`; wrap in try/catch +
  `console.error` (so a persist failure never throws into a request handler).
- `list(scope: TodoScope, refKey: string): TodoRecord[]` — values filtered by
  `t.scope === scope && t.refKey === refKey`, sorted by `createdAt` ascending (ties: `id`).
- `get(id: string): TodoRecord | undefined`.
- `async create(scope, refKey, name?): Promise<TodoRecord>` — validate `scope` ∈ enum and
  `refKey` non-empty (else `throw new TodoError(400, ...)`); `const now = new Date().toISOString();`
  record `{ id: randomUUID(), name: (name?.trim() || "Untitled"), scope, refKey, body: "", createdAt: now, updatedAt: now }`;
  set, `await persist()`, `lifecycle.emit("created", record)`; return it.
- `async update(id, patch: { name?: string; body?: string }): Promise<TodoRecord>` — get or
  `throw new TodoError(404, "todo not found")`. If `patch.name !== undefined` set
  `name = patch.name.trim() || "Untitled"`. If `patch.body !== undefined` set `body = patch.body`.
  Bump `updatedAt = new Date().toISOString()`. `await persist()`, emit `"updated"`, return.
- `async delete(id): Promise<void>` — get or `throw new TodoError(404, ...)`; `todos.delete(id)`;
  `await persist()`; emit `"deleted"` with the record.
- `async deleteByProjectPath(path: string): Promise<void>` — delete every record where
  `scope === "project" && refKey === path`; persist once; emit `"deleted"` for each.
- `async deleteByWorkspace(name: string, workspacePath: string): Promise<void>` — delete every
  record where `(scope === "workspace" && refKey === name)` **or**
  `(scope === "project" && (refKey === workspacePath || refKey.startsWith(workspacePath + sep)))`;
  persist once; emit `"deleted"` for each. (This removes the workspace's own lists and every list
  belonging to a project inside that workspace.)

---

## 6. Daemon — routes & wiring in `apps/daemon/src/index.ts`

1. **Import** (top, next to the sessions/accounts imports): `import { TodoError, TodoListManager } from "./todos";`
   and add `todosIndexPath` to the `@orquester/config` import.
2. **Resolve the path, construct & load.** The appdir base is **`paths.baseDir`** (from
   `resolveDaemonPaths`), and the daemon stores computed paths on a `resolved: ResolvedPaths`
   object. Mirror `sessionsIndexFile`: add a field to that object literal (~line 167, next to
   `sessionsIndexFile: sessionsIndexPath(paths.baseDir)`):
   ```ts
   todosIndexFile: todosIndexPath(paths.baseDir),
   ```
   (add `todosIndexFile: string` to the `ResolvedPaths` type if it's an explicit interface), then
   construct next to the session manager (~line 190):
   ```ts
   const todos = new TodoListManager(resolved.todosIndexFile, console);
   await todos.load();
   ```
3. **`Services` interface** (~line 307): add `todos: TodoListManager;`, and include `todos` in the
   `services` object literal passed to `createServer`.
4. **Lifecycle → broadcaster bridges** (next to the `session.*` bridges, ~lines 207-224):
   ```ts
   todos.lifecycle.on("created", (r) => broadcaster.publish("todos", "todo.created", r));
   todos.lifecycle.on("updated", (r) => broadcaster.publish("todos", "todo.updated", r));
   todos.lifecycle.on("deleted", (r) => broadcaster.publish("todos", "todo.deleted", r));
   ```
5. **Routes** — register next to the `/api/sessions` block (~line 1470). Wrap each handler in
   try/catch mapping `TodoError.status` (else 500) to
   `reply.code(status).send({ code: "TODO_ERROR", message })`.

   | Method | Path | Input | Returns |
   |---|---|---|---|
   | GET | `/api/todos` | `?scope&refKey` (querystring) | `TodoListRecord[]` |
   | POST | `/api/todos` | `{scope, refKey, name?}` | `TodoListRecord` (201) |
   | PUT | `/api/todos/:id` | `{name?, body?}` | `TodoListRecord` |
   | DELETE | `/api/todos/:id` | — | 204 No Content |

   - `GET`: reject missing/invalid `scope` or missing `refKey` with `400 {code:"BAD_REQUEST"}`;
     else `reply.send(todos.list(scope, refKey))`.
   - `POST`: `await todos.create(body.scope, body.refKey, body.name)` → `reply.code(201).send(rec)`.
   - `PUT`: `await todos.update(req.params.id, { name: body.name, body: body.body })`.
   - `DELETE`: `await todos.delete(req.params.id)` → `reply.code(204).send()`.
   - Use Fastify generics for typed params/body, matching the session routes.
6. **Cascade-delete** — in the existing delete handlers (which already call
   `sessions.closeByProjectPrefix`):
   - Project delete (`DELETE /api/workspaces/:workspace/projects/:project`, ~lines 642-666): after
     the session cascade, `await todos.deleteByProjectPath(target)`. **`target`** is the **raw-join**
     path (`join(resolved.workspacesDir, workspace, project)`, ~line 650) already passed to
     `sessions.closeByProjectPrefix` at ~line 662 — **not** the realpath `safe`. Matching `target`
     is what keeps the prefix logic aligned with session refKeys.
   - Workspace delete (`DELETE /api/workspaces/:workspace`, ~lines 668-699): after the session
     cascade, `await todos.deleteByWorkspace(workspace, target)`. **`workspace`** is the name param
     (~line 671); **`target`** is the raw-join workspace path (~line 686, the same arg given to
     `sessions.closeByProjectPrefix`).

`prepareDirs`/`daemonConfigDir` already create `<appdir>/daemon`, so `todos.json` needs no extra
directory setup.

---

## 7. UI api-client — `packages/ui/src/lib/api-client.ts`

The UI's own `ApiClient` (the `Transporter`-backed class — **this** is the client the app calls,
not the `@orquester/api` reference client) gets these methods, after the file methods (~line 256),
following the existing `send(...)` style. `send` supports `"PUT"`, and the transporter's
`buildQueryString` omits `undefined` query params, so `deleteTodo` returning `void` matches the
existing 204-returning deletes (e.g. `deleteSession`):

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

Add `TodoScope, TodoListRecord, CreateTodoRequest, UpdateTodoRequest` to the
`import type { … } from "@orquester/api"` block.

---

## 8. UI store — `packages/ui/src/store/app.ts`

This is the largest change: the **tab context generalization** plus the to-do tab/cache/actions.
Do it additively and keep project behavior identical.

### 8a. Tab context

Add near the navigation types:

```ts
/** What the tab strip + MainView are showing. A project (full tab set) or a
 *  workspace (to-do tabs only). The `key` is the map key for all per-context tab state:
 *  project path (never collides with) workspace name (names have no "/"; paths are absolute). */
export type TabContext =
  | { kind: "project"; key: string; project: ProjectSummary }
  | { kind: "workspace"; key: string; workspace: string };

/** Resolve the active context from navigation. Project wins when both are set. */
export function currentContext(state: Pick<AppState, "currentProject" | "currentWorkspace">): TabContext | null {
  if (state.currentProject) {
    return { kind: "project", key: state.currentProject.path, project: state.currentProject };
  }
  if (state.currentWorkspace) {
    return { kind: "workspace", key: state.currentWorkspace, workspace: state.currentWorkspace };
  }
  return null;
}

/** The (scope, refKey) a to-do list gets in a given context. */
export function todoRefOf(ctx: TabContext): { scope: TodoScope; refKey: string } {
  return ctx.kind === "project"
    ? { scope: "project", refKey: ctx.key }
    : { scope: "workspace", refKey: ctx.key };
}
```

In **components**, prefer selecting `currentProject` / `currentWorkspace` separately and deriving
the context inline (or with `useMemo`) — `currentContext(state)` returns a fresh object each call,
so passing it directly to `useAppStore` re-renders on every state change. That's acceptable for the
top-level `MainView`/`TopBar`, but don't use it in hot/list components.

### 8b. Types & state

1. After `GitTab` (~line 267) add:
   ```ts
   /** A client-local to-do tab. Bound to a TodoListRecord by `todoId`; `title` mirrors
    *  the record's name (kept in sync by the todo.* event handler + rename). */
   export interface TodoTab {
     id: string;         // tab id
     contextKey: string; // project path or workspace name (the map key)
     todoId: string;
     title: string;
   }
   ```
2. Extend `ProjectTab` (~line 275):
   ```ts
   export type ProjectTab =
     | { id: string; type: "session"; session: SessionSummary }
     | { id: string; type: "files"; title: string }
     | { id: string; type: "git"; title: string }
     | { id: string; type: "todo"; todoId: string; title: string };
   ```
3. **Keep all existing map names — do NOT rename them** (avoids a sweeping ripple). From now on
   `activeTabByProject` (`Record<string, string | null>`, ~line 402) is keyed by a **context key**
   (project path *or* workspace name — they can't collide: paths are absolute, names have no `/`).
   Add a one-line comment saying so. Add the new maps/cache next to the others (~lines 398-404) and
   initialize all to `{}`/`[]` in the `create(...)` initial state (~line 502):
   ```ts
   todoTabsByContext: Record<string, TodoTab[]>;   // keyed by context key (path | workspace name)
   todos: TodoListRecord[];                          // server cache (all loaded scopes/refs)
   ```
   `fileTabsByProject`, `gitTabsByProject`, `viewModeByProject` keep their names and stay
   project-only (their keys are always project paths).

### 8c. Actions

All actions read the client via `const api = get().api; if (!api) return;` (the store holds
`api: ApiClient | null` at ~line 355; existing actions like `openTab` use exactly this guard). Add
to the actions interface + implementation:

- `loadTodos: (scope: TodoScope, refKey: string) => Promise<void>` — `api.listTodos(scope, refKey)`
  then merge into `todos` (replace any cached records with the same `(scope, refKey)`, keep
  others). Call it **fire-and-forget** from navigation: in **`openWorkspace`** (which is `async`,
  ~line 1020) add `void get().loadTodos("workspace", name)`; in **`openProject`** add
  `void get().loadTodos("project", project.path)`. ⚠️ `openProject` is **synchronous**
  (`=> void`, a plain `set(...)`, ~line 1071) — do **not** `await` there; fire-and-forget keeps its
  signature unchanged. Swallow errors (never throw into navigation).
- `createTodo: (scope: TodoScope, refKey: string, name?: string) => Promise<void>` — `const rec =
  await api.createTodo({ scope, refKey, name })`; upsert into `todos`; then `openTodo(rec)`
  (opens a tab for the new list, in the context whose key === `refKey`).
- `openTodo: (rec: TodoListRecord) => void` — find-or-create a tab for `rec.id` under
  `contextKey = rec.refKey` in `todoTabsByContext`; reuse if a tab with that `todoId` exists;
  set it active in `activeTabByProject[rec.refKey]`. (Per-`todoId` singleton; multiple distinct
  lists ⇒ multiple tabs. Model on `openGit`, ~line 1163.)
- `renameTodo: (id: string, name: string) => Promise<void>` — optimistic: update the cached
  record's `name` and any open tab's `title`; `await api.updateTodo(id, { name })`; the
  `todo.updated` event reconciles. On failure, reload via `loadTodos` for that record's
  scope/ref.
- `saveTodoBody: (id: string, body: string) => Promise<void>` — optimistic: update the cached
  record's `body`/`updatedAt`; `await api.updateTodo(id, { body })`. (The component debounces;
  this action just sends.)
- `deleteTodo: (id: string) => Promise<void>` — `await api.deleteTodo(id)`; remove from `todos`;
  **close any open tab** with that `todoId` across all `todoTabsByContext` entries (reuse the
  close/reassign helpers). The confirm dialog is the caller's responsibility (§10).

### 8d. Close / reassign / cleanup must include to-do tabs

- `useActiveTabId` (~line 1452) now reads `activeTabByProject[contextKey]` where the context key
  falls back from project to workspace:
  ```ts
  export function useActiveTabId(): string | null {
    return useAppStore((s) => {
      const key = s.currentProject?.path ?? s.currentWorkspace ?? null;
      return key ? (s.activeTabByProject[key] ?? null) : null;
    });
  }
  ```
- `firstTabId(...)` — add a `todoTabs` argument; fallback chain becomes
  `session ?? fileTabs?.[0]?.id ?? gitTabs?.[0]?.id ?? todoTabs?.[0]?.id ?? null`. **Update every
  call site** to pass the new `todoTabsByContext` slice — it's called directly by `openProject`
  (~line 1071) and via `reassignActive` (`pnpm check` flags any you miss).
- `reassignActive(...)` — thread the `todoTabsByContext` slice through to `firstTabId`.
- `removeLocalTab(state, id)` — filter `id` out of `fileTabsByProject`, `gitTabsByProject`, **and
  `todoTabsByContext`**, then `reassignActive`. (`closeTab`'s non-session branch already calls
  this; closing a to-do tab is therefore **non-destructive** — it never calls `deleteTodo`.)
- `clearProjectLocalState(...)` (used on project/workspace delete) — also purge
  `todoTabsByContext` for the matching key(s) and drop deleted records from `todos`.

### 8e. Combine into the tab list — keep `useProjectTabs` (make it context-aware)

**Do NOT rename it** and do **NOT** pass a compare fn. The real selector (~lines 1424-1450) uses
**four separate single-slice** `useAppStore((s) => s.field)` calls + a `useMemo` (default `Object.is`
per slice — there is no `shallow`/custom equality). Mirror that exactly, adding the
`todoTabsByContext` + `currentWorkspace` slices and a context branch:

```ts
export function useProjectTabs(): ProjectTab[] {
  const sessions = useAppStore((s) => s.sessions);
  const fileTabsByProject = useAppStore((s) => s.fileTabsByProject);
  const gitTabsByProject = useAppStore((s) => s.gitTabsByProject);
  const todoTabsByContext = useAppStore((s) => s.todoTabsByContext);
  const project = useAppStore((s) => s.currentProject);
  const workspace = useAppStore((s) => s.currentWorkspace);
  return useMemo(() => {
    const key = project?.path ?? workspace ?? null;            // context key
    if (!key) return [];
    const todoTabs = (todoTabsByContext[key] ?? []).map<ProjectTab>((t) => ({
      id: t.id, type: "todo", todoId: t.todoId, title: t.title
    }));
    if (!project) return todoTabs;                              // workspace context: to-do only
    const sessionTabs = sessions
      .filter((x) => x.projectPath === key)
      .sort((a, b) => a.order - b.order)
      .map<ProjectTab>((session) => ({ id: session.id, type: "session", session }));
    const fileTabs = (fileTabsByProject[key] ?? []).map<ProjectTab>((t) => ({ id: t.id, type: "files", title: t.title }));
    const gitTabs = (gitTabsByProject[key] ?? []).map<ProjectTab>((t) => ({ id: t.id, type: "git", title: t.title }));
    return [...sessionTabs, ...fileTabs, ...gitTabs, ...todoTabs];
  }, [sessions, fileTabsByProject, gitTabsByProject, todoTabsByContext, project, workspace]);
}
```

The three consumers (`MainView`, `TabStrip`, `TabSwitcher`) keep importing `useProjectTabs`
unchanged.

### 8f. Event handling — `todo.*`

The event reducer is **`applyEvent`** inside `app.ts` (~lines 1282-1313) — NOT a separate
transporter file (the transporter just forwards each parsed `EventMessage` to
`get().applyEvent(event)`). `applyEvent` discriminates on `event.channel` and
**early-returns for any channel other than `"sessions"`** (~lines 1288-1290). The daemon emits
to-do events on channel **`"todos"`** (§6), so add a `"todos"` branch **before** that early
return (next to the `"registry"` branch at ~line 1283):

```ts
if (event.channel === "todos") {
  const rec = event.payload as TodoListRecord;
  if (event.type === "todo.created" || event.type === "todo.updated") {
    set((state) => applyTodoUpsert(state, rec));   // upsert cache + sync any open tab's title
  } else if (event.type === "todo.deleted") {
    set((state) => removeTodoEverywhere(state, rec.id));   // drop from cache + removeLocalTab the tab
  }
  return;
}
```

Add small local helpers near the existing `upsertSession`/`removeSession`: `applyTodoUpsert`
(replace-by-`id` in `todos`, and if a tab with that `todoId` is open, set its `title = rec.name`)
and `removeTodoEverywhere` (drop the record from `todos`, then `removeLocalTab` any tab with that
`todoId`). This is how a delete or a cascade on **another machine** closes the tab here. (Session
lifecycle events are `created`/`exited`/`updated`/`closed` — note `session.exited` exists, distinct
from `closed`; to-do has only the three above.) An incoming `todo.updated` body flows through the
cache into `TodoView` (§9), which reconciles when the editor is idle.

---

## 9. UI components — `packages/ui/src/components/todo/` (new dir)

Match `FileBrowser.tsx` / `GitView.tsx` conventions: `useApi()` from
`../../context/orquester-context`, `cn` from `../../lib/cn`, lucide icons, the neutral palette,
`border-neutral-800`, `bg-neutral-950/900`, `text-xs`/`text-sm`, `h-9` toolbars. Icon for to-do
everywhere: lucide **`ListTodo`** (size 13 in strips, 14 in menus — matching `FolderTree`/`GitBranch`).

### 9a. `todo-markdown.ts` — pure parse/serialize (no React)

```ts
export interface TodoItem { id: string; checked: boolean; text: string; }

/** Parse GitHub task-list markdown into items. Lines that aren't task items are ignored.
 *  `id` is a stable client-side key for list rendering/drag (assigned per parse). */
export function parseTodoMarkdown(body: string): TodoItem[];

/** Serialize items back to "- [ ] text" / "- [x] text", one per line, no trailing blank line. */
export function serializeTodoMarkdown(items: TodoItem[]): string;
```

- Parse: split on `\n`; a task line matches `^\s*[-*]\s+\[(?<c>[ xX])\]\s?(?<t>.*)$` →
  `{ id: crypto.randomUUID(), checked: c === "x" || c === "X", text: t }`. Non-matching lines
  (blank, prose, headings) are skipped. Trim trailing `\r`.
- Serialize: `items.map(i => "- [" + (i.checked ? "x" : " ") + "] " + i.text).join("\n")`.
- Round-trip note: `id` is render-only and never serialized; reordering/editing operate on the
  in-memory `TodoItem[]` and reserialize.

### 9b. `use-todo-doc.ts` hook — `packages/ui/src/hooks/use-todo-doc.ts`

A read→edit→save loop in the *shape* of `use-file-text.ts` (load on mount; expose content + a
save), but **item-oriented**, **debounced/auto-saving**, and reconciling against the live store
cache. Important: `use-file-text.ts` itself does **not** debounce (its `save` is manual/explicit) —
the debounce here is **new code**, not copied from it.

```ts
export function useTodoDoc(todoId: string): {
  record: TodoListRecord | undefined;
  items: TodoItem[];
  setItems: (next: TodoItem[]) => void;   // optimistic; schedules a debounced save
  saving: boolean;
};
```

Behavior:
- `record` = `useAppStore(s => s.todos.find(t => t.id === todoId))`.
- Local `items` state seeded from `parseTodoMarkdown(record.body)`.
- `setItems(next)`: set local state immediately; schedule a **400 ms debounced**
  `saveTodoBody(todoId, serializeTodoMarkdown(next))`. Coalesce rapid edits.
- **Flush** the pending save on unmount and when the tab goes inactive (so edits aren't lost when
  you switch/close tabs).
- **Reconcile**: when `record.body` changes from outside (another client) **and** there is no
  pending debounce/dirty edit, re-seed `items` from the new body. While a save is pending, keep
  local items (last-write-wins).

### 9c. `TodoView.tsx`

Props: `{ todoId: string; active: boolean }` (`active` mirrors `GitView`/`FileBrowser` — all tabs
stay mounted; use it to flush-on-inactive and to autofocus the add-input when active).

Uses `useTodoDoc(todoId)`. If `record` is undefined (deleted) → render a small centered
"This list was deleted." `EmptyState`.

Layout (single column, max-width comfortable like a doc):
- **Header** (`h-9`-ish row): the list **name** (display only — rename is via the tab, §10), then
  right-aligned tidy controls: a **"Hide done"** toggle (`Eye`/`EyeOff`) and a **"Clear
  completed"** button (enabled only when ≥1 item is checked). A subtle "saving…" hint when
  `saving`.
- **Items**: for each `TodoItem` (respecting the hide-done filter), a row with:
  - a checkbox (toggle `checked` → `setItems`),
  - the **text** — click to edit inline (an `Input` seeded with the text; Enter or blur commits
    via `setItems`; if the committed text is empty, **remove** that item),
  - a delete **×** button (hover-revealed) → remove the item via `setItems`,
  - a drag handle (`GripVertical`) for reordering.
  Completed item text is `line-through text-neutral-500`.
- **Add item**: a persistent input at the bottom ("Add a to-do…"); Enter appends
  `{ id, checked:false, text }` via `setItems` and **keeps focus** for rapid entry; empty Enter is
  a no-op.
- **Empty state** (no items): "No items yet — add one below."
- **Drag-reorder**: native HTML5 drag like `TabStrip` (`draggable`, `onDragStart`/`onDragOver`/
  `onDrop`) reordering the `items` array → `setItems`. Keep it simple; no cross-list drag.
- **Hide done**: local view state only (does not change the body).
- **Clear completed**: opens a `ConfirmDialog` ("Clear N completed items?", danger) → on confirm,
  `setItems(items.filter(i => !i.checked))`.

### 9d. `index.ts`

`export { TodoView } from "./TodoView";`

---

## 10. Tab + sidebar integration

A set of small, coherent edits teaching the UI about the `todo` tab variant, the workspace
context, and the two entry points. Use `ListTodo` from `lucide-react`.

### 10a. `MainView.tsx`

- Import `{ TodoView } from "../todo"`, `currentContext`, and `ListTodo`. Keep using
  `useProjectTabs()` (now context-aware, §8e) for the tab array; add
  `const ctx = useAppStore(currentContext);` for the empty-state + render-prop logic.
- `cellIcon` (~line 20) + `TabStrip`/`TabSwitcher` icon ladders: return `<ListTodo size={…} />`
  for `tab.type === "todo"`. `cellTitle` already works (`tab.title`).
- Replace the `!currentProject` gate (~line 58) with **context** logic:
  - `const ctx = useAppStore(currentContext);`
  - `if (!ctx) return <EmptyState … "No workspace selected" "Pick a workspace from the sidebar." />`.
  - else if `tabs.length === 0`:
    - project context → keep the existing "No tabs open" empty state.
    - workspace context → `<EmptyState icon={<ListTodo/>} title="No to-do lists open"
      description='Use "+" or the sidebar to open a to-do list.' />`.
- Extend the render switch (~line 130) to 4-way:
  ```tsx
  {tab.type === "session" ? (
    <TerminalView session={tab.session} active={active} viewMode={viewMode} />
  ) : tab.type === "git" ? (
    <GitView projectPath={ctx.kind === "project" ? ctx.project.path : ""} active={show} />
  ) : tab.type === "files" ? (
    <FileBrowser rootPath={ctx.kind === "project" ? ctx.project.path : ""} active={show} />
  ) : (
    <TodoView todoId={tab.todoId} active={show} />
  )}
  ```
  (Git/Files tabs only ever exist in project context, so `ctx.project.path` is always defined for
  them; the ternary just satisfies the type.)
- **Grid view** stays project-only: when `ctx.kind === "workspace"`, force tab view (do not offer
  the grid toggle). `useViewMode` should return `"tab"` for workspace context.

### 10b. `TopBar.tsx`

Today (`~lines 67-78`, desktop) the gate is
`currentProject ? (<ProjectSwitcher/> + <TabStrip/> + <NewTabMenu/>) : <span>Select a project to
begin</span>`, and `<ViewModeToggle/>` is gated on `currentProject` (`~lines 82-86`);
`currentProject` is read at `~line 34`. Change the gate to the **active context**: add
`const ctx = useAppStore(currentContext);` and render the `TabStrip` + `NewTabMenu` cluster whenever
`ctx` is non-null (mobile branch too, ~53-59). Render `<ProjectSwitcher/>` and `<ViewModeToggle/>`
**only** when `ctx?.kind === "project"` (both are project-specific). The "Select a project to
begin" fallback shows only when `ctx` is `null`.

### 10c. `NewTabMenu.tsx` — the "+" menu (context-aware)

`NewTabMenu` has **no** `currentProject`/`currentWorkspace` reference today (the gating lives in
`TopBar` + the store actions). Add `const ctx = useAppStore(currentContext);` plus the `todos`,
`createTodo`, `openTodo` selectors, and branch on `ctx.kind`:

- **Project context** (`ctx.kind === "project"`): keep the existing Shells / Agents sections; under
  the **Tools** `DropdownLabel` (after the Git item, ~lines 57-59) add:
  - `New to-do list` → `createTodo("project", ctx.key)`.
  - then the project's existing lists to **reopen**: map
    `todos.filter(t => t.scope === "project" && t.refKey === ctx.key)` to `DropdownItem`s
    (icon `ListTodo`, label = name) calling `openTodo(rec)`.
- **Workspace context** (`ctx.kind === "workspace"`): show **only** a to-do section — no Shells /
  Agents / File Browser / Git (those require a project; their actions no-op without one):
  `New to-do list` → `createTodo("workspace", ctx.key)` + the workspace's existing lists
  (`scope === "workspace" && refKey === ctx.key`) to reopen via `openTodo`.

Read the lists from the store cache (already loaded by `openProject`/`openWorkspace`).

### 10d. `TabStrip.tsx` / `TabSwitcher.tsx`

- **Icon ladders**: add a `ListTodo` branch for `type === "todo"` (TabStrip icon ~lines 92-98;
  TabSwitcher `tabIcon` ~lines 10-17).
- **Enable rename for to-do tabs.** Rename is session-only today: `isSession = tab.type ===
  "session"` (~line 89) gates the double-click (`onDoubleClick={() => isSession && setEditingId(...)}`,
  ~line 106) and the `TabRenameInput`. Change those gates to `isSession || tab.type === "todo"`, and
  make the **commit** branch by type: session → the existing `renameTab(...)`; to-do →
  `renameTodo(tab.todoId, value)`.
- **Context menu** (`menuItems`, ~lines 77-83): a to-do tab returns **Rename** (→ enter edit mode),
  **Delete list** (→ open a `ConfirmDialog` "Delete '<name>'? This removes it on every machine.",
  `danger`; on confirm `deleteTodo(tab.todoId)`), and **Close** (→ `closeTab`). Keep sessions =
  Rename+Close and files/git = Close-only.
- **Close** button: unchanged (`closeTab`) — non-destructive.
- **Drag-reorder**: to-do tabs are non-session (`draggable={isSession && !editing}` ~line 104; drop
  operates over `sessionIds` ~line 61), so they're correctly non-draggable — no change.

### 10e. Sidebar — `ProjectList.tsx` (workspace-scoped lists)

`ProjectList` renders inside a workspace. Add a **"To-do lists"** section so workspace lists are
discoverable and manageable from the sidebar (project-scoped lists live in the project "+" menu,
not here).

- **Create**: add `New to-do list` to the header **"New"** `Dropdown` (alongside New Project / New
  Folder, ~line 63) → `createTodo("workspace", currentWorkspace)` (opens the new list as a tab).
- **List section**: below the project `<nav>`, render a labeled "To-do lists" group listing
  `todos.filter(t => t.scope==="workspace" && t.refKey===currentWorkspace)` (sorted by
  `createdAt`). Each row: `ListTodo` icon + name; click → `openTodo(rec)`. Match the project-row
  styling (`90-109`).
- **Per-row context menu** (mirror the project `ContextMenu` `112`):
  - **Rename** → inline input. `NewItemInput` (`components/sidebar/NewItemInput.tsx`) currently
    takes only `{ placeholder, onSubmit, onCancel }` — **add an optional `initialValue?: string`
    prop** (seed the text field with it, default `""`) so it can pre-fill the current name. Render
    it seeded with `rec.name`; Enter commits via `renameTodo(rec.id, value)`, Escape cancels.
  - **Delete** → `ConfirmDialog` ("Delete '<name>'?", danger, no typed-name gate — like the
    project delete at `121-138`) → `deleteTodo(rec.id)`.
- The collapsed **`SidebarRail`** is **out of scope** (v1) — no change.

`MobileKeyBar.tsx` already guards `active.type !== "session"`, so to-do tabs need no change there.

---

## 11. Build phases (workflow structure)

Files are partitioned so no two concurrently-running agents edit the same file.

1. **Contracts** (parallel, disjoint files): (a) `packages/api/src/index.ts` §3; (b)
   `packages/config/src/index.ts` §4. *(barrier)*
2. **Data layer** (parallel, disjoint files): (a) daemon `apps/daemon/src/todos.ts` **+** its
   wiring/routes in `apps/daemon/src/index.ts` §5–6 (one agent — both daemon files);
   (b) UI api-client `packages/ui/src/lib/api-client.ts` §7. *(barrier)*
3. **Store** — `packages/ui/src/store/app.ts` §8 (one agent — single large file). *(barrier)*
4. **To-do components** (waves so later files read earlier ones from disk):
   4.1 `todo/todo-markdown.ts` §9a · `hooks/use-todo-doc.ts` §9b (one agent — 9b imports 9a);
   4.2 `todo/TodoView.tsx` §9c **+** `todo/index.ts` §9d. *(barrier)*
5. **Integration edits** §10 — `MainView.tsx`, `TopBar.tsx`, `NewTabMenu.tsx`, `TabStrip.tsx`,
   `TabSwitcher.tsx`, `ProjectList.tsx` (one agent for a coherent cross-file change; all read the
   store from phase 3 and the component from phase 4). *(barrier)*
6. **Verify & reconcile** — run `pnpm check` from the repo root; fix every type error across any
   file; repeat until clean. Sanity-read the new code. **Do NOT start, restart, or stop the daemon**
   (per AGENTS.md, this repo runs inside a live daemon) — verify server-side changes with
   `pnpm check` + code review only.

---

## 12. Verification / done criteria

- **`pnpm check`** (= `pnpm -r typecheck`, `tsc --noEmit`) is clean. **This is the gate.**
- **Daemon smoke test** — performed by the **human operator only** (implementation agents must not
  launch the daemon, per AGENTS.md). With the daemon running,
  `POST /api/todos {scope:"project",refKey:"<this repo path>"}` returns a record;
  `GET /api/todos?scope=project&refKey=<path>` lists it; `PUT /api/todos/:id {body:"- [ ] x"}`
  updates it; **restart the daemon → the list and its body persist**; `DELETE` removes it.
  Deleting a project/workspace via its route removes that scope's lists (`GET` returns `[]`).
- **Manual UI check:**
  - Workspace level (no project open): sidebar shows a "To-do lists" section; "New to-do list"
    creates a list that opens as a tab in the workspace main view; add / check / edit-text /
    drag-reorder / hide-done / clear-completed all work and autosave; **reload the page → list +
    items persist**.
  - Project level: "+" → To-do → New to-do list opens a tab; same editing; "+" lists existing
    project lists to reopen.
  - **Close** a to-do tab → the list is gone from the strip but still listed in "+" / the sidebar
    (re-open restores it). **Delete list** (tab or sidebar context menu) → confirm dialog → the
    list disappears everywhere; deleting the project/workspace removes its lists.
  - Second connected client (or a second browser tab) sees create/rename/edit/delete **live**.
- No new npm dependency; ESM only; matches existing code style (neutral palette, `useApi()`, the
  session/git precedents).
```
