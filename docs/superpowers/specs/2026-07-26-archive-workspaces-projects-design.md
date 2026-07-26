# Archive Workspaces & Projects — Design

**Date:** 2026-07-26
**Status:** Approved (brainstormed + validated with user)

## Summary

Add a reversible, metadata-only **archive** flag to workspaces and projects. Archived
items disappear from the sidebar lists and are reachable through a very muted button at
the bottom of the sidebar that opens a floating panel listing archived items in the
current context, each with an Unarchive action.

Archiving is purely cosmetic: nothing on disk moves, no sessions/browsers/todos are
touched, and unarchiving restores the item exactly as it was (including client-local tab
layout, pane sizes, and view mode).

## Decisions (validated with user)

1. **Sessions keep running.** Archiving never closes or blocks sessions; they are just
   hidden along with their project. No cascade of any kind.
2. **Panel is per-context (context-sensitive button).** At the sidebar's top level
   (workspace list) the button shows archived *workspaces*; inside a workspace (project
   list) it shows that workspace's archived *projects*.
3. **Persistence: Approach A** — extend the existing `workspaces.json` side-table.
   Workspace entries gain `isArchived`; each entry gains `archivedProjects: string[]`
   (project dir names). No new file, no general per-project metadata table (YAGNI), no
   dot-marker files in user directories.
4. **"Protect archived data" is a UI gate, not a server boundary.** With the toggle on,
   the archived panel demands the password (retyped, never autofilled) before revealing
   its list. Verification is client-side against the stored credential. The raw API
   still returns archived items flagged — it's a privacy curtain against someone at an
   open session, not a security boundary against someone holding the credential.
5. **Re-prompt on every panel open.** No unlock timer, no per-session memory.
6. **The toggle is remote-togglable, with retype-to-disable.** It lives in `daemon.json`
   but gets its own small endpoint allowed over HTTP (unlike the full daemon-config
   `PUT`, which stays unix-socket-only). Turning it ON is one click; turning it OFF
   first demands the retyped password in the same no-autofill prompt.

## Backend

### Schema (`packages/config/src/index.ts`)

Extend `workspaceMetaSchema`:

```ts
export const workspaceMetaSchema = z.object({
  name: z.string().min(1),
  gitAccountId: z.string().optional(),
  createdAt: z.string(),
  /** Hidden from the sidebar; purely cosmetic, nothing on disk changes. */
  isArchived: z.boolean().default(false),
  /** Project dir names under this workspace that are archived. */
  archivedProjects: z.array(z.string()).default([])
});
```

Both new fields use zod defaults so every existing `workspaces.json` parses unchanged.
(A required field would make old files throw, and `readWorkspacesMeta` swallows parse
errors into a default config — silently wiping git-account bindings. Defaults avoid
that failure mode entirely.)

Note: zod strips unknown keys on parse, so the fields must be in the schema (they are) —
there is no passthrough to rely on.

### Wire contracts (`packages/api/src/index.ts`)

- `WorkspaceSummary` gains `isArchived?: boolean` (optional-with-doc-comment, matching
  the `gitAccountId`/`createdAt` convention).
- `ProjectSummary` gains `isArchived?: boolean`.
- New request type `UpdateWorkspaceRequest { isArchived?: boolean }` and
  `UpdateProjectRequest { isArchived?: boolean }` (update-shaped so future fields can
  join without a new route).
- `OrquesterApi` interface + `HttpOrquesterApiClient` gain `updateWorkspace` /
  `updateProject` methods.

### Routes (`apps/daemon/src/index.ts`)

Two new endpoints — the first update endpoints on these resources, mirroring the
session-rename pattern (`PUT /api/sessions/:id`):

- `PUT /api/workspaces/:workspace` with body `{ isArchived: boolean }` →
  returns the updated `WorkspaceSummary`.
- `PUT /api/workspaces/:workspace/projects/:project` with body
  `{ isArchived: boolean }` → returns the updated `ProjectSummary`.

Handler behavior:

- Validate the target directory exists (404 otherwise), reusing the existing
  path-resolution guards.
- **Merge into the meta entry, never replace it** (the existing POST upsert replaces
  whole entries; copying that here would clobber `gitAccountId`/`createdAt`). If the
  workspace has no meta entry yet (predates the side-table), create one with
  `createdAt = now`.
- Project archive: add/remove the project name in the workspace entry's
  `archivedProjects` (dedup on add; creating the workspace entry if missing).
- No events are broadcast — workspace data follows the existing refetch-after-mutate
  convention (there is no `workspaces.changed` channel today and this feature does not
  add one; single-user, other clients converge on reconnect/refetch).

### Listing (`apps/daemon/src/index.ts`)

- `listWorkspaces()` surfaces `isArchived` from the meta entry (default `false`).
- `listProjects()` gains a `metaFile` parameter (threaded through the route at ~1479 and
  the MCP dep at ~3444) and surfaces `isArchived` per project from `archivedProjects`.
- **Archived items stay in API responses, flagged.** Clients filter. This keeps the MCP
  tools, `NewProjectModal` lookups, and delete flows working on the full list.
- `projectCount` in `WorkspaceSummary` continues to count all projects, archived
  included (unchanged).

### Cleanup coupling

- `DELETE /api/workspaces/:workspace` already prunes the meta entry — archive state
  cannot leak onto a recreated same-name workspace. Unchanged.
- `DELETE .../projects/:project` additionally prunes the project's name from
  `archivedProjects`.
- A stale name in `archivedProjects` (directory removed outside orquester) is ignored by
  the directory join; harmless.

### MCP surface (`apps/daemon/src/mcp/`)

`list_workspaces` / `list_projects` tool outputs pass `isArchived` through so agents can
see it. No gate on `createTab`/session creation in archived projects — archived means
hidden, not locked.

## UI (`packages/ui`)

### Context menus

- `WorkspaceList.tsx` and `ProjectList.tsx` `menuItems` arrays gain an **Archive** item
  (lucide `Archive` icon, non-danger) between "Copy Full Path" and "Delete".
- No confirmation dialog — archiving is instantly reversible.
- (Rows in the sidebar only ever show non-archived items, so the menu never needs an
  "Unarchive" variant; unarchive lives in the panel.)

### Sidebar filtering

- `WorkspaceList` renders `workspaces.filter((w) => !w.isArchived)`.
- `ProjectList` renders `projects.filter((p) => !p.isArchived)`.
- The zustand store keeps the **full** unfiltered lists (store-level filtering would
  break `deleteWorkspace`'s path lookup and `NewProjectModal`'s account lookup).

### Bottom button + floating panel

New shared component, e.g. `sidebar/ArchivedFooter.tsx`:

- Rendered directly above `<ServerSwitcher />` in **both** the desktop `<aside>` and the
  mobile drawer branches of `Sidebar.tsx`.
- Context-sensitive:
  - top level (`currentWorkspace == null`) → archived workspaces,
  - inside a workspace → that workspace's archived projects.
- **Rendered only when the archived count in the current context is > 0.** Otherwise the
  footer is absent entirely.
- Visual: very muted — `text-neutral-600`-level (matching existing secondary text), a
  small `Archive` icon plus `Archived · N`.
- Clicking opens an `AdaptiveMenu` anchored to the button (the existing `Dropdown`
  auto-flips upward near the viewport bottom; mobile gets the `BottomSheet` for free).
- Each row: item name + an **Unarchive** action. Rows are otherwise inert — no
  navigation into archived items; unarchive first. Unarchive triggers the store action,
  the list refetches, the item reappears in the main list; when the panel empties it
  closes and the footer disappears.

### Store (`packages/ui/src/store/app.ts`)

New actions following the existing `mutate → await load*()` shape:

```ts
setWorkspaceArchived: (name: string, isArchived: boolean) => Promise<void>;
setProjectArchived: (project: ProjectSummary, isArchived: boolean) => Promise<void>;
```

Both delegate through `workspace-service.ts` → new `ApiClient.updateWorkspace` /
`updateProject` methods, then `await loadWorkspaces()` / `loadProjects()`.

**Navigation reset (mirrors delete, minus the purge):** when archiving the currently
open workspace, call `closeWorkspace()` and null `currentProject` if it lives under that
workspace's path; when archiving the current project, null `currentProject`. Do **not**
call `clearProjectLocalState` — client-local tab layout, pane sizes, view mode, and todo
tabs must survive an unarchive. Sessions keep running server-side and reappear untouched.

Adapter note (repo convention): no new persisted client-local shapes are introduced, so
no new localStorage schema/validation work is needed.

## Protect archived data (password gate)

### Config & endpoint (daemon)

- `daemon.json` gains `protectArchivedData: z.boolean().default(false)` in the daemon
  config schema (`packages/config`). It is **not** a secret — `sanitizeDaemonConfig`
  keeps it, so every client can read it from the existing config GET.
- New endpoint `PUT /api/config/daemon/protect-archived` with body
  `{ enabled: boolean }` — available on **both** transports with normal bearer auth
  (deliberate, documented exception to the daemon-config-writes-are-socket-only rule;
  it guards a UI curtain, not daemon security posture). Persists the flag to
  `daemon.json` and returns the sanitized config. The full `PUT /api/config/daemon`
  remains 403 over HTTP, unchanged.

### Settings UI

- Daemon settings section gains a "Protect archived data" toggle (below Password):
  label + subtitle "Ask for the password before showing archived workspaces/projects."
- Unlike the other daemon fields, the toggle stays enabled over remote HTTP (it calls
  the dedicated endpoint, not the read-only config form).
- Turning **ON**: immediate call. Turning **OFF**: opens the password prompt first;
  only on successful verification does the UI call the endpoint.

### The password prompt

A small shared modal component (reused by the archived panel and the settings toggle):

- Single password field + Confirm/Cancel. Field is cleared on every mount, and the
  typed value lives only in component state — never persisted, never logged.
- **Anti-autofill measures**: `autoComplete="new-password"` (the reliable way to stop
  password-manager/browser fill — `off` is widely ignored for password fields), a
  non-credential `name`, no wrapping `<form>` with a username field, and
  `data-1p-ignore`/`data-lpignore` attributes for the common password-manager
  extensions. The user must physically type the password.
- **Verification is fully client-side and offline**: the stored wire credential already
  contains the bcrypt hash (which embeds its salt), so the prompt runs
  `bcrypt.compare(typed, storedHash)` with the bcryptjs dependency the UI already has.
  No network round trip, no plaintext on the wire — consistent with the existing
  never-send-plaintext auth design.
- Wrong password: inline error, field cleared, stays open. No throttle needed (it's a
  local compare; the real login throttle guards the actual auth surface).

### Gate behavior in the archived panel

- Toggle off → footer button opens the panel directly (base feature behavior).
- Toggle on → every click on the footer button opens the password prompt first; the
  panel (and its unarchive actions) renders only after verification. Closing and
  reopening re-prompts.
- **Local unix-socket clients (desktop) with no stored credential are exempt**: there
  is no password to verify against on the socket transport (auth is HTTP-only), so the
  gate is inert there and the panel opens directly. The curtain targets remote browser
  sessions, which is where an unattended open tab lives.
- Edge: if the stored credential is stale (password rotated server-side while the tab
  stayed open), the compare fails until re-login — acceptable; re-login refreshes it.

## Error handling & edge cases

- Old/corrupt `workspaces.json`: zod defaults handle old files; the existing
  swallow-and-default fallback for corrupt files is unchanged.
- Archiving a workspace whose meta entry doesn't exist: entry is created on the spot.
- Unarchiving from the panel when the underlying dir was deleted externally: refetch
  simply no longer lists it; stale `archivedProjects` names are ignored.
- `PUT` on a nonexistent workspace/project: 404.
- Remote HTTP transport: the new `PUT` routes are ordinary authenticated `/api` routes —
  allowed remotely (unlike `PUT /api/config/daemon`); no security asymmetry is added.
  No secrets are involved.

## Testing / verification

Repo has no test runner. Done means:

1. `pnpm check` clean.
2. Drive the real surface: exercise the new `PUT` routes against the running daemon's
   HTTP API (archive/unarchive a scratch workspace + project, confirm `workspaces.json`
   contents and `GET` flags), and verify the sidebar flows in the web UI (context menu →
   item disappears; muted footer appears with count; panel opens upward; unarchive
   restores; archiving the open workspace/project navigates away without losing tab
   layout after unarchive). For the password gate: flip the toggle from remote,
   confirm the prompt appears on every panel open, wrong password is rejected, right
   password reveals the list, the browser offers no autofill, and disabling the toggle
   demands the retype. Per repo rules, the daemon is never restarted by the
   implementing agent — daemon code changes are verified by typecheck + review, and live
   verification happens on the user's running instance when they restart it, or via a
   separate checkout if explicitly requested.

## Out of scope

- No `workspaces.changed` event channel.
- No archiving-blocks-sessions or cascade behavior.
- No rename or other workspace/project update fields (the `PUT` body shape leaves room).
- No global "all archived items" view; the panel is strictly per-context.
- No server-side hiding of archived data behind the password gate (UI curtain only, by
  decision #4); no unlock timers or per-session unlock memory.
