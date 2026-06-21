# Tab Reorder + Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag-reorder and rename shell/agent session tabs, with both changes persisted on the daemon and synced live to all connected clients.

**Architecture:** Add an `order` field + a rename/reorder capability to the daemon's `SessionManager`, exposed via two new routes and broadcast through the existing `/events` stream as a new `session.updated` event. The web client gains store actions + a reworked `TabStrip` (native HTML5 drag, inline rename, context menu). File-browser tabs are excluded (client-local, ephemeral).

**Tech Stack:** TypeScript, Fastify (daemon), node's events, React 18 + Zustand (web), native HTML5 drag-and-drop, Tailwind.

## Global Constraints

- No new runtime dependencies (native HTML5 DnD only).
- File-browser ("files") tabs are NOT renameable and NOT draggable; they render after session tabs.
- Persistence is daemon-side; sync via the existing `sessions` event channel.
- Empty rename reverts to the registry entry's default name.
- Verification is `pnpm check` (typecheck) + runtime checks (curl / Playwright); the repo has no test runner — do not add one.
- Match existing code style (comment density, naming). Sessions keyed by `id`; names need not be unique.

---

### Task 1: API contract — `order` field + request types

**Files:**
- Modify: `packages/api/src/index.ts` (SessionSummary ~line 186; add request types after `CreateSessionRequest`)

**Interfaces:**
- Produces: `SessionSummary.order: number`; `RenameSessionRequest { title: string }`; `ReorderSessionsRequest { projectPath: string; ids: string[] }`. New event type string `"session.updated"` (no type change; documented).

- [ ] **Step 1: Add `order` to `SessionSummary`** — insert after `createdAt: string;` (keep `createdAt` last is fine; add `order` before it):

```ts
export interface SessionSummary {
  id: string;
  kind: RegistryKind;
  /** Registry entry id this session was launched from (e.g. "bash", "claude"). */
  refId: string;
  title: string;
  /** Project the tab belongs to ("" = not bound to a project). */
  projectPath: string;
  cwd: string;
  cols: number;
  rows: number;
  status: SessionStatus;
  exitCode?: number;
  /** Per-project tab sort key (ascending); assigned by the daemon. */
  order: number;
  createdAt: string;
}
```

- [ ] **Step 2: Add request types** — immediately after `CreateSessionRequest`:

```ts
export interface RenameSessionRequest {
  /** New label; empty/whitespace reverts to the registry entry's default name. */
  title: string;
}

export interface ReorderSessionsRequest {
  /** Project whose session tabs are being reordered. */
  projectPath: string;
  /** Session ids in the desired left-to-right order. */
  ids: string[];
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: fails in `apps/daemon` and `packages/ui` where `SessionSummary` objects omit `order` (those are fixed in Tasks 2 & 5). The `@orquester/api` package itself must compile. This is an expected transient failure — proceed.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): add SessionSummary.order + rename/reorder request types"
```

---

### Task 2: Daemon `SessionManager` — order, rename, reorder

**Files:**
- Modify: `apps/daemon/src/sessions.ts`

**Interfaces:**
- Consumes: `SessionSummary.order` (Task 1); `this.registry: RegistryService` (existing constructor field) for default-name fallback.
- Produces: `rename(id: string, title: string): SessionSummary | undefined`; `reorder(projectPath: string, ids: string[]): void`; lifecycle event `"updated"` (payload `SessionSummary`); `list()` returns order-sorted; `create()` assigns `order`.

- [ ] **Step 1: Assign `order` in `create()`** — compute before building `summary`, and include it. Replace the `const id = randomUUID();` line region and the `summary` object:

```ts
    const cwd = req.cwd || req.projectPath || homedir();
    const id = randomUUID();
    const projectPath = req.projectPath ?? "";
    // Append to the end of this project's strip.
    const maxOrder = [...this.sessions.values()]
      .filter((s) => s.summary.projectPath === projectPath)
      .reduce((max, s) => Math.max(max, s.summary.order), -1);

    const pty = spawn(entry.resolvedBin, [], {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    });

    const summary: SessionSummary = {
      id,
      kind: entry.kind,
      refId: entry.id,
      title: req.title || entry.name,
      projectPath,
      cwd,
      cols,
      rows,
      status: "running",
      order: maxOrder + 1,
      createdAt: new Date().toISOString()
    };
```

- [ ] **Step 2: Order-sort `list()`** — replace the body of `list`:

```ts
  list(projectPath?: string): SessionSummary[] {
    const all = [...this.sessions.values()]
      .map((s) => ({ ...s.summary }))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    return projectPath === undefined ? all : all.filter((s) => s.projectPath === projectPath);
  }
```

- [ ] **Step 3: Add `rename` and `reorder`** — insert after `resize(...)`:

```ts
  /** Rename a session's tab; empty title reverts to the registry default name. */
  rename(id: string, title: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    const trimmed = title.trim();
    const fallback = this.registry.get(session.summary.refId)?.name ?? session.summary.refId;
    session.summary.title = trimmed || fallback;
    this.lifecycle.emit("updated", { ...session.summary });
    return { ...session.summary };
  }

  /** Reassign per-project tab order from an ordered id list (unknown ids ignored). */
  reorder(projectPath: string, ids: string[]): void {
    ids.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session && session.summary.projectPath === projectPath && session.summary.order !== index) {
        session.summary.order = index;
        this.lifecycle.emit("updated", { ...session.summary });
      }
    });
  }
```

- [ ] **Step 4: Typecheck the daemon**

Run: `pnpm check`
Expected: `apps/daemon` compiles (still expect `packages/ui` failures until Task 5). The daemon package must be clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sessions.ts
git commit -m "feat(daemon): SessionManager rename/reorder + order assignment"
```

---

### Task 3: Daemon routes + `session.updated` broadcast

**Files:**
- Modify: `apps/daemon/src/index.ts` (lifecycle wiring ~line 125-133; session routes ~line 553-568)

**Interfaces:**
- Consumes: `sessions.rename` / `sessions.reorder` (Task 2); `RenameSessionRequest` / `ReorderSessionsRequest` (Task 1).
- Produces: `PUT /api/sessions/:id` → `SessionSummary | 404`; `POST /api/sessions/reorder` → `204`; `sessions` channel event `session.updated` (payload `SessionSummary`).

- [ ] **Step 1: Import the new request types** — add to the existing `@orquester/api` import block at the top of the file:

```ts
  RenameSessionRequest,
  ReorderSessionsRequest,
```

- [ ] **Step 2: Broadcast `updated`** — add after the `sessions.lifecycle.on("exited", ...)` handler (alongside created/exited/closed):

```ts
  sessions.lifecycle.on("updated", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.updated", s)
  );
```

- [ ] **Step 3: Add rename + reorder routes** — insert after the `DELETE /api/sessions/:id` route (after line ~568):

```ts
  app.put<{ Params: { id: string }; Body: RenameSessionRequest }>(
    "/api/sessions/:id",
    async (request, reply): Promise<SessionSummary | void> => {
      const summary = sessions.rename(request.params.id, request.body?.title ?? "");
      if (!summary) {
        return reply.code(404).send();
      }
      return summary;
    }
  );

  app.post<{ Body: ReorderSessionsRequest }>(
    "/api/sessions/reorder",
    async (request, reply): Promise<void> => {
      const { projectPath, ids } = request.body ?? { projectPath: "", ids: [] };
      sessions.reorder(projectPath, ids);
      return reply.code(204).send();
    }
  );
```

(Routing note: `POST /api/sessions/reorder` is a static path and does not collide with the `:id` routes, which are `PUT /api/sessions/:id` and `POST /api/sessions/:id/{input,resize}`.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: `apps/daemon` clean (UI still pending Task 5).

- [ ] **Step 5: Runtime verify against the running daemon** (the dev daemon hot-reloads via `tsx watch`)

```bash
TOKEN='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'
# create two bash sessions in a temp project path
P=/tmp/orq-verify
A=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"refId\":\"bash\",\"projectPath\":\"$P\",\"cwd\":\"$P\"}" http://127.0.0.1:47831/api/sessions | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
B=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"refId\":\"bash\",\"projectPath\":\"$P\",\"cwd\":\"$P\"}" http://127.0.0.1:47831/api/sessions | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# rename A
curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"renamed-A"}' "http://127.0.0.1:47831/api/sessions/$A"; echo
# reorder: B before A
curl -sS -o /dev/null -w "reorder HTTP %{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"projectPath\":\"$P\",\"ids\":[\"$B\",\"$A\"]}" http://127.0.0.1:47831/api/sessions/reorder
# confirm: A has title renamed-A and order 1; B order 0
curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/sessions?projectPath=$P" | python3 -c 'import sys,json;[print(s["id"][:8],s["title"],"order",s["order"]) for s in json.load(sys.stdin)]'
# cleanup
curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/sessions/$A"
curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/sessions/$B"
```
Expected: rename returns the updated summary; reorder returns 204; the list shows B (order 0) before A (order 1, title `renamed-A`).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): rename/reorder routes + session.updated broadcast"
```

---

### Task 4: Client API methods

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (after `resizeSession`, ~line 242; import types at top)

**Interfaces:**
- Consumes: `RenameSessionRequest`/`ReorderSessionsRequest` shapes (Task 1), `this.send` (existing).
- Produces: `renameSession(id, title): Promise<SessionSummary>`; `reorderSessions(projectPath, ids): Promise<void>`.

- [ ] **Step 1: Add the two methods** — after `resizeSession`:

```ts
  renameSession(id: string, title: string): Promise<SessionSummary> {
    return this.send("PUT", `/api/sessions/${encodeURIComponent(id)}`, { body: { title } });
  }

  reorderSessions(projectPath: string, ids: string[]): Promise<void> {
    return this.send("POST", "/api/sessions/reorder", { body: { projectPath, ids } });
  }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: `packages/ui` still fails only where Task 5 changes are pending; api-client.ts itself compiles.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/api-client.ts
git commit -m "feat(ui): api-client renameSession + reorderSessions"
```

---

### Task 5: Client store — event, sort, actions

**Files:**
- Modify: `packages/ui/src/store/app.ts` (AppState interface ~line 224-228; store impl; `applyEvent` ~line 675; `useProjectTabs` ~line 739)

**Interfaces:**
- Consumes: `api.renameSession` / `api.reorderSessions` (Task 4); `session.updated` event (Task 3).
- Produces: `renameTab(id: string, title: string): Promise<void>`; `reorderTabs(orderedSessionIds: string[]): Promise<void>`; order-sorted `useProjectTabs`.

- [ ] **Step 1: Declare the actions on `AppState`** — add after `activateTab: (id: string) => void;`:

```ts
  renameTab: (id: string, title: string) => Promise<void>;
  reorderTabs: (orderedSessionIds: string[]) => Promise<void>;
```

- [ ] **Step 2: Handle `session.updated` in `applyEvent`** — inside the `event.channel === "sessions"` block, extend the created/exited branch to include updated:

```ts
    if (
      event.type === "session.created" ||
      event.type === "session.exited" ||
      event.type === "session.updated"
    ) {
      const summary = event.payload as SessionSummary;
      set((state) => ({ sessions: upsertSession(state.sessions, summary) }));
    } else if (event.type === "session.closed") {
```

- [ ] **Step 3: Implement the two actions** — add after `activateTab` in the store object:

```ts
  renameTab: async (id, title) => {
    const trimmed = title.trim();
    // Optimistic only when non-empty; an empty title is resolved to the default
    // name on the daemon and arrives via the session.updated broadcast.
    if (trimmed) {
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title: trimmed } : s))
      }));
    }
    try {
      const updated = await get().api?.renameSession(id, trimmed);
      if (updated) {
        set((state) => ({ sessions: upsertSession(state.sessions, updated) }));
      }
    } catch {
      await get().loadSessions();
    }
  },

  reorderTabs: async (orderedSessionIds) => {
    const project = get().currentProject;
    if (!project) {
      return;
    }
    // Optimistic: assign order by index for this project's sessions.
    set((state) => ({
      sessions: state.sessions.map((s) => {
        const index = orderedSessionIds.indexOf(s.id);
        return s.projectPath === project.path && index !== -1 ? { ...s, order: index } : s;
      })
    }));
    try {
      await get().api?.reorderSessions(project.path, orderedSessionIds);
    } catch {
      await get().loadSessions();
    }
  },
```

- [ ] **Step 4: Order-sort session tabs in `useProjectTabs`** — replace the `sessionTabs` assignment:

```ts
    const sessionTabs: ProjectTab[] = sessions
      .filter((s) => s.projectPath === project.path)
      .slice()
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .map((session) => ({ id: session.id, type: "session", session }));
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS across the whole workspace (api, daemon, ui all clean).

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/store/app.ts
git commit -m "feat(ui): store rename/reorder actions + session.updated sync + order sort"
```

---

### Task 6: `TabStrip` — drag reorder, inline rename, context menu

**Files:**
- Modify: `packages/ui/src/components/topbar/TabStrip.tsx` (full rewrite)

**Interfaces:**
- Consumes: `useProjectTabs`, `useActiveTabId`, `useAppStore` (`activateTab`/`closeTab`/`renameTab`/`reorderTabs`), `ProjectTab` (store); `ContextMenu`/`ContextMenuItem` (`../ui/context-menu`); `getRegistryIcon` (icons).
- Produces: the interactive tab strip (no exported API change).

- [ ] **Step 1: Replace the file contents** with:

```tsx
import React, { useState } from "react";
import { Circle, FolderTree, Pencil, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { getRegistryIcon } from "../../icons";
import { ContextMenu, type ContextMenuItem } from "../ui/context-menu";
import {
  useActiveTabId,
  useAppStore,
  useProjectTabs,
  type ProjectTab
} from "../../store/app";

/** Small inline editor shown in place of a tab label while renaming. */
const TabRenameInput: React.FC<{
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}> = ({ initial, onSubmit, onCancel }) => {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => onSubmit(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="h-5 w-[120px] rounded bg-neutral-900 px-1 text-xs text-neutral-100 outline-none ring-1 ring-neutral-600"
    />
  );
};

/** Tabs for the current project — daemon sessions (drag/rename) plus file tabs. */
export const TabStrip: React.FC = () => {
  const tabs = useProjectTabs();
  const activeTabId = useActiveTabId();
  const activateTab = useAppStore((s) => s.activateTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ProjectTab } | null>(null);

  if (tabs.length === 0) {
    return null;
  }

  const sessionIds = tabs.filter((t) => t.type === "session").map((t) => t.id);

  const drop = (targetId: string) => {
    const from = sessionIds.indexOf(dragId ?? "");
    const to = sessionIds.indexOf(targetId);
    setDragId(null);
    setOverId(null);
    if (from === -1 || to === -1 || from === to) {
      return;
    }
    const next = [...sessionIds];
    next.splice(from, 1);
    next.splice(to, 0, sessionIds[from]);
    void reorderTabs(next);
  };

  const menuItems = (tab: ProjectTab): ContextMenuItem[] =>
    tab.type === "session"
      ? [
          { label: "Rename", icon: <Pencil size={13} />, onClick: () => setEditingId(tab.id) },
          { label: "Close", icon: <X size={13} />, danger: true, onClick: () => void closeTab(tab.id) }
        ]
      : [{ label: "Close", icon: <X size={13} />, danger: true, onClick: () => void closeTab(tab.id) }];

  return (
    <div className="app-no-drag flex items-center gap-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const isSession = tab.type === "session";
        const editing = editingId === tab.id;
        const title = isSession ? tab.session.title : tab.title;
        const icon = isSession ? (
          getRegistryIcon(tab.session.kind, tab.session.refId, 13)
        ) : (
          <FolderTree size={13} />
        );
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            draggable={isSession && !editing}
            onClick={() => activateTab(tab.id)}
            onDoubleClick={() => isSession && setEditingId(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, tab });
            }}
            onDragStart={() => isSession && setDragId(tab.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(event) => {
              if (isSession && dragId) {
                event.preventDefault();
                if (overId !== tab.id) setOverId(tab.id);
              }
            }}
            onDrop={(event) => {
              if (isSession && dragId) {
                event.preventDefault();
                drop(tab.id);
              }
            }}
            className={cn(
              "group flex h-7 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs",
              editing ? "cursor-text" : "cursor-pointer",
              dragId === tab.id && "opacity-50",
              overId === tab.id && dragId !== tab.id && "ring-1 ring-neutral-500",
              active
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
            )}
          >
            <span className="text-neutral-500">{icon}</span>
            {editing ? (
              <TabRenameInput
                initial={title}
                onSubmit={(value) => {
                  setEditingId(null);
                  if (value.trim() !== title) void renameTab(tab.id, value);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span className="max-w-[140px] truncate">{title}</span>
            )}
            {isSession && tab.session.status === "exited" ? (
              <Circle size={7} className="ml-0.5 fill-neutral-600 text-neutral-600" />
            ) : null}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(tab.id);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tab)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
};
```

- [ ] **Step 2: Verify the `ContextMenu` import path** — confirm the named exports exist:

Run: `grep -n "export.*ContextMenu" packages/ui/src/components/ui/context-menu.tsx`
Expected: shows `ContextMenu` and `ContextMenuItem` exports (import path `../ui/context-menu` is correct).

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS (whole workspace clean).

- [ ] **Step 4: Runtime verify in the browser** (Playwright via system Chrome, against the running web app)

Drive: open project → open ≥3 agent/shell tabs → double-click one and rename → drag one tab to a new position → screenshot and confirm the new label + order; reload the page and confirm both persist; confirm the file-browser tab shows no rename on double-click. (Reuse the `/tmp/orq-driver` Playwright harness pattern.)
Expected: renamed label sticks across reload; dragged order persists across reload; file tab is not renameable.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/topbar/TabStrip.tsx
git commit -m "feat(ui): drag-reorder + inline rename + context menu in TabStrip"
```

---

## Notes for the implementer

- The dev servers are already running (`pnpm dev:daemon` on :47831, `pnpm dev:web` on :5173) and hot-reload; no restart needed after edits.
- Auth bearer for curl checks = the daemon's `passwordHash` (stage password `123456`): `$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe`.
- After Task 1, `pnpm check` is expected to fail until Tasks 2 and 5 land — that is intentional staging, not a regression.
