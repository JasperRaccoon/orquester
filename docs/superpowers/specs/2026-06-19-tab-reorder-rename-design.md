# Tab reorder + rename — design

Date: 2026-06-19
Status: Draft (awaiting review)

## Summary

Let users **drag to reorder** and **rename** the session tabs in a project's tab
strip. Both changes persist on the daemon (server-authoritative, like the
sessions themselves) so they survive page reloads and sync live across every
window/client connected to the same daemon, for as long as the session lives.

Motivating pain: every agent tab launched from the same registry entry shows the
same label ("Claude Code", "Claude Code", "Claude Code"), and there is no way to
reorder them.

## Goals

- Drag a shell/agent tab left/right within a project to reorder it; order persists on the daemon.
- Rename a shell/agent tab to an arbitrary, non-unique label; the name persists on the daemon.
- Both changes broadcast to other connected clients in real time.
- No new runtime dependencies.

## Non-goals

- **File-browser ("Files") tabs are excluded.** They are client-local and
  ephemeral (they do not exist on the daemon), so they are **not renameable** and
  **not part of drag-reorder**. They render after the session tabs as fixed
  utility tabs and remain closeable. (Confirmed scope decision.)
- No cross-project tab moving (reorder is scoped to one project's strip).
- No persistence across a full daemon restart (sessions themselves don't survive
  that — a renamed/reordered tab lives exactly as long as its session).
- No reordering relative to the file tabs (sessions reorder among themselves;
  file tabs always follow).

## Current state (as built)

- A tab strip tab (`ProjectTab` in `packages/ui/src/store/app.ts`) is either a
  `session` (a daemon PTY, keyed by session id) or a `files` tab (client-local).
- `useProjectTabs()` returns `[...sessionTabs, ...fileTabs]`: session tabs in the
  raw `sessions` array order, then file tabs. **No explicit order field exists.**
- Tab label = `SessionSummary.title`, set once at creation from
  `req.title || registryEntry.name` (daemon `sessions.ts:create`). That is why
  same-entry agents share a label. **No rename path exists.**
- `sessions` are server-authoritative and sync via the `/events` stream
  (`session.created` / `session.exited` / `session.closed`, broadcast from
  `SessionManager.lifecycle` in `apps/daemon/src/index.ts:125-132`).
- `fileTabsByProject` / `activeTabByProject` are client-local and **not**
  persisted (no zustand `persist` middleware).

## UX behavior

**Reorder (session tabs only):**
- Session tabs are `draggable`. Dragging shows a drop indicator (a vertical
  insertion bar between tabs) at the nearest gap.
- On drop, the strip reorders optimistically (immediately) and the new order is
  sent to the daemon. The daemon's `session.updated` broadcast reconciles all
  clients (including this one).
- File tabs are not draggable and are not drop targets; sessions cannot be
  dropped after them.

**Rename (session tabs only):**
- **Double-click** a session tab → its label becomes an inline text input
  pre-filled with the current title. **Enter** saves, **Esc** cancels, **blur**
  saves. An empty/whitespace value reverts to the registry entry's default name.
- **Right-click** a session tab → context menu with **Rename** and **Close**.
- Right-click a file tab → context menu with **Close** only (no Rename).
- The tab icon and exited-status dot are unchanged; only the label changes.

## Technical design

### 1. API contract — `packages/api/src/index.ts`

- `SessionSummary`: add `order: number` (per-project sort key, ascending).
- New request types:
  - `RenameSessionRequest { title: string }`
  - `ReorderSessionsRequest { projectPath: string; ids: string[] }`
- New event type string `"session.updated"` on the `sessions` channel, payload
  `SessionSummary`. Used for **both** rename and reorder (each affected session
  is rebroadcast with its new `title` / `order`). This adds exactly one new event
  type and reuses the existing upsert path on the client.

### 2. Daemon — `apps/daemon/src/sessions.ts` + `index.ts`

`SessionManager`:
- On `create`, assign `order = count of existing sessions with the same
  projectPath` (append to the end of that project's strip).
- `rename(id, title): SessionSummary | undefined` — trim title; if empty, fall
  back to the registry entry's `name` (via the injected `RegistryService`);
  update `summary.title`; emit `lifecycle "updated"`; return the summary.
- `reorder(projectPath, ids): SessionSummary[]` — for each id in `ids` that
  belongs to `projectPath`, set `order = index`; emit `lifecycle "updated"` for
  each changed session; return them. Ignore ids not in the project.
- `list()` returns sessions sorted by `order` (stable; tie-break by `createdAt`)
  so a fresh client / reconnect renders the persisted order.

`index.ts`:
- Wire `sessions.lifecycle.on("updated", s => broadcaster.publish("sessions", "session.updated", s))` alongside the existing created/exited/closed handlers.
- Routes:
  - `PUT /api/sessions/:id` → `sessions.rename(id, body.title)`; 404 if unknown.
  - `POST /api/sessions/reorder` → `sessions.reorder(body.projectPath, body.ids)`.

### 3. Client API — `packages/ui/src/lib/api-client.ts`

- `renameSession(id, title): Promise<SessionSummary>` → `PUT /api/sessions/:id`.
- `reorderSessions(projectPath, ids): Promise<void>` → `POST /api/sessions/reorder`.

### 4. Client store — `packages/ui/src/store/app.ts`

- `applyEvent`: handle `"session.updated"` by upserting the summary (covers both
  rename + order changes from any window).
- `useProjectTabs`: sort the project's session tabs by `order` (tie-break
  `createdAt`) before appending file tabs.
- `renameTab(id, title)`: optimistic local title update, then
  `api.renameSession`; on failure, reload sessions to resync.
- `reorderTabs(orderedSessionIds)`: optimistic local `order` reassignment for the
  current project's sessions, then `api.reorderSessions(projectPath, ids)`; on
  failure, reload sessions to resync.

### 5. UI — `packages/ui/src/components/topbar/TabStrip.tsx`

- Split rendering: session tabs (draggable, renameable, full context menu) then
  file tabs (static, Close-only menu).
- Native HTML5 DnD: `draggable`, `onDragStart` (stash dragged id),
  `onDragOver` (compute insertion index from pointer vs. tab midpoints; show drop
  indicator), `onDrop` (build new id order → `reorderTabs`). No new dependency.
- Inline rename: local `editingId` state; render an `<input>` in place of the
  label when editing (reuse the `NewItemInput` pattern in `sidebar/`).
- Context menu: reuse `components/ui/context-menu.tsx`.

## Data flow

```
drag-drop ─▶ store.reorderTabs (optimistic local order)
          └▶ PUT order ─▶ daemon reorder ─▶ lifecycle "updated"
                          └▶ broadcaster "session.updated" ─▶ all clients upsert ─▶ re-sort

double-click ─▶ inline input ─▶ store.renameTab (optimistic)
            └▶ PUT title ─▶ daemon rename ─▶ lifecycle "updated"
                           └▶ broadcaster "session.updated" ─▶ all clients upsert
```

## Edge cases

- **Empty rename** → revert to the registry entry's default name (daemon-side).
- **Close mid-drag** → the dragged/target tab may vanish via `session.closed`;
  drop becomes a no-op if either id is gone.
- **Concurrent reorder from two windows** → last write wins; the server's
  `session.updated` order is the reconciliation point.
- **Pre-existing sessions without `order`** (in-flight upgrade) → client sorts
  with `order ?? createdAt` fallback; daemon always sets `order` on create.
- **Names are not unique** — intentional; the id remains the key.

## Testing / verification

The repo has no test runner (scripts are `build` / `typecheck` / `check` only),
so verification is:
- `pnpm check` (typecheck across the workspace) must pass.
- Manual + Playwright-driven UI checks against the running web app:
  1. Open ≥3 agent tabs; rename each; confirm labels stick.
  2. Drag to reorder; reload the page → order + names persist.
  3. Open a second browser window on the same daemon → rename/reorder in one
     reflects in the other (event sync).
  4. Confirm the Files tab has no Rename affordance and stays after session tabs.

(If desired, a small standalone unit test for `SessionManager.reorder`/`rename`
ordering could be added, but introducing a test framework is out of scope here.)
