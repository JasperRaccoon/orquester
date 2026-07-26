# Archive Workspaces & Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reversible, metadata-only archiving of workspaces/projects (hidden from the sidebar, restorable from a muted footer panel), plus a "Protect archived data" toggle that gates the panel behind a retyped, non-autofillable password.

**Architecture:** The archive flag lives in the existing `workspaces.json` side-table (workspace entries gain `isArchived` + `archivedProjects: string[]`). Two new `PUT` routes toggle it; `GET` responses carry the flag and clients filter at render. The protection toggle lives in `daemon.json` behind a dedicated remote-allowed endpoint; verification is a fully client-side bcrypt compare against the stored credential hash. No events, no cascades — sessions and disk state are untouched.

**Tech Stack:** TypeScript 5.8 ESM, zod (config schemas), Fastify 4 (daemon), React 18 + zustand + Tailwind (UI), bcryptjs (already a UI dep).

**Spec:** `docs/superpowers/specs/2026-07-26-archive-workspaces-projects-design.md` — read it first.

## Global Constraints

- **⛔ Never launch, restart, or stop the daemon** (`pnpm dev*`, `cli.ts`, port `47831`, `daemon.sock`, `systemctl`). This checkout runs inside a live Orquester instance. Verify with `pnpm check` + code review only.
- **No test runner exists in this repo.** The TDD cycle is replaced by: make the change → `pnpm check` (typecheck, the pre-commit gate) → commit. Manual verification steps are collected in Task 10 for the user to run on their live instance.
- Commit to the **current branch as-is** (`main`) — do NOT create a feature branch (repo rule overrides defaults).
- ESM everywhere; packages import each other's TS source directly (no build step between packages).
- New zod fields MUST have `.default(...)` — a required field would make every existing `workspaces.json`/`daemon.json` throw, and the tolerant readers would silently reset them.
- `workspaces.json` meta entries are keyed by workspace **name** (paths contain `$vars`).
- Never log/persist a plaintext password; the typed password in the verify component lives only in component state.
- Run `pnpm check` from the repo root: `/var/lib/orquester/workspaces/jaspersito/orquester`.

---

### Task 1: Config schemas (`@orquester/config`) + daemon compile fix

**Files:**
- Modify: `packages/config/src/index.ts:452-466` (workspaceMetaSchema), `:190-203` (daemonConfigSchema)
- Modify: `apps/daemon/src/index.ts:1453-1458` (POST /api/workspaces entry construction — compile fix)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `WorkspaceMeta` gains `isArchived: boolean` and `archivedProjects: string[]` (non-optional after parse, defaulted on read); `DaemonConfig` gains `protectArchivedData: boolean` (defaulted `false`). Later tasks rely on these exact names.

- [ ] **Step 1: Extend `workspaceMetaSchema`**

In `packages/config/src/index.ts`, the current schema (~line 459):

```ts
export const workspaceMetaSchema = z.object({
  /** Workspace directory name — the stable identifier (paths contain $vars). */
  name: z.string().min(1),
  /** Git account this workspace is bound to (Phase 4); undefined = default identity. */
  gitAccountId: z.string().optional(),
  /** ISO timestamp the workspace was created through orquester. */
  createdAt: z.string()
});
```

becomes:

```ts
export const workspaceMetaSchema = z.object({
  /** Workspace directory name — the stable identifier (paths contain $vars). */
  name: z.string().min(1),
  /** Git account this workspace is bound to (Phase 4); undefined = default identity. */
  gitAccountId: z.string().optional(),
  /** ISO timestamp the workspace was created through orquester. */
  createdAt: z.string(),
  /** Hidden from the sidebar lists; purely cosmetic — nothing on disk changes. */
  isArchived: z.boolean().default(false),
  /** Project dir names under this workspace that are archived. */
  archivedProjects: z.array(z.string()).default([])
});
```

- [ ] **Step 2: Extend `daemonConfigSchema`**

In the same file (~line 190), add one field between `logsDir` and `transports`:

```ts
export const daemonConfigSchema = z.object({
  version: z.literal(1).default(1),
  // May contain $vars; expand with expandVars() before use.
  workspacesDir: z.string().min(1),
  logsDir: z.string().min(1),
  /**
   * "Protect archived data": the UI asks for the (retyped, non-autofilled)
   * password before showing archived workspaces/projects. A client-side
   * curtain, not a server boundary — archived items still appear (flagged)
   * in API responses. Writable via PUT /api/config/daemon/protect-archived,
   * which unlike the full config PUT is allowed over remote HTTP.
   */
  protectArchivedData: z.boolean().default(false),
  // Only the external HTTP transport is configurable here; the local unix
  // socket is always present and resolved at runtime (see resolveDaemonPaths).
  transports: z
    .object({
      http: httpTransportSchema.default({ enabled: false })
    })
    .default({ http: { enabled: false } })
});
```

No change to `createDefaultDaemonConfig` — `parseDaemonConfig` applies the default.

- [ ] **Step 3: Fix the daemon's meta-entry construction (typecheck ripple)**

`WorkspaceMeta`'s inferred output type now requires the new fields, so the upsert in `POST /api/workspaces` (`apps/daemon/src/index.ts:1453-1458`) no longer typechecks. Change:

```ts
    const entry = { name, gitAccountId: body?.gitAccountId, createdAt };
```

to:

```ts
    const entry = {
      name,
      gitAccountId: body?.gitAccountId,
      createdAt,
      isArchived: false,
      archivedProjects: []
    };
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: exit 0, all packages pass. If any other site constructs a `WorkspaceMeta` literal and now fails, add the same two defaulted fields there.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/index.ts apps/daemon/src/index.ts
git commit -m "feat(config): isArchived/archivedProjects on workspace meta, protectArchivedData on daemon config"
```

---

### Task 2: Wire contracts (`@orquester/api`)

**Files:**
- Modify: `packages/api/src/index.ts:30-62` (summaries + new request types)

**Interfaces:**
- Consumes: nothing.
- Produces: `WorkspaceSummary.isArchived?: boolean`, `ProjectSummary.isArchived?: boolean`, `interface UpdateWorkspaceRequest { isArchived?: boolean }`, `interface UpdateProjectRequest { isArchived?: boolean }`, `interface SetProtectArchivedRequest { enabled: boolean }`. Tasks 3–5 import these exact names.

- [ ] **Step 1: Add `isArchived` to both summaries**

In `packages/api/src/index.ts`, `WorkspaceSummary` (~line 34) gains one optional field after `createdAt` (optional-with-doc-comment, matching the `gitAccountId` convention so older daemons stay compatible):

```ts
  /** ISO creation timestamp from workspaces.json, when present. */
  createdAt?: string;
  /** Hidden from the sidebar lists (workspaces.json flag). Absent = false. */
  isArchived?: boolean;
```

`ProjectSummary` (~line 52) gains the same field after `path`:

```ts
export interface ProjectSummary {
  name: string;
  workspace: string;
  path: string;
  /** Hidden from the sidebar lists (workspaces.json flag). Absent = false. */
  isArchived?: boolean;
}
```

- [ ] **Step 2: Add the three request types**

Directly after `CreateWorkspaceRequest` (~line 62):

```ts
/**
 * Body for PUT /api/workspaces/:workspace. Update-shaped so future fields can
 * join without a new route; today only the archive flag is settable.
 */
export interface UpdateWorkspaceRequest {
  isArchived?: boolean;
}

/** Body for PUT /api/workspaces/:workspace/projects/:project. */
export interface UpdateProjectRequest {
  isArchived?: boolean;
}

/**
 * Body for PUT /api/config/daemon/protect-archived — the one daemon-config
 * field writable over remote HTTP (it guards a UI curtain, not daemon
 * security posture; see the spec).
 */
export interface SetProtectArchivedRequest {
  enabled: boolean;
}
```

Do NOT extend the reference `OrquesterApi` client — it doesn't cover deletes/updates today either (YAGNI).

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): isArchived on summaries + archive/protect request types"
```

---

### Task 3: Daemon — surface flags, PUT archive routes, delete pruning, MCP passthrough

**Files:**
- Modify: `apps/daemon/src/index.ts` — `listWorkspaces` (~3662), `listProjects` (~3685) + its two call sites (~1479, ~3444), new PUT routes (after POST `/api/workspaces` ends ~1470, and after GET `.../projects` ends ~1481), DELETE project handler (~1566-1595), imports
- Modify: `apps/daemon/src/mcp/server.ts:118-122`

**Interfaces:**
- Consumes: `WorkspaceMeta` (Task 1), `UpdateWorkspaceRequest`/`UpdateProjectRequest` (Task 2), existing helpers `readWorkspacesMeta(file)`, `writeWorkspacesMeta(file, meta)`, `resolveWithinWorkspaces(target, root)`, `isValidName(name)`, `listDirectories(dir)`.
- Produces: `PUT /api/workspaces/:workspace` → `WorkspaceSummary`; `PUT /api/workspaces/:workspace/projects/:project` → `ProjectSummary`; `listProjects(workspacesDir, workspace, metaFile)` (new 3-arg signature); GET responses now carry `isArchived`. Task 5's client methods call these routes.

- [ ] **Step 1: Add imports**

In `apps/daemon/src/index.ts`, extend the existing `@orquester/api` type-import list with `UpdateWorkspaceRequest, UpdateProjectRequest, SetProtectArchivedRequest` (SetProtectArchivedRequest is used in Task 4 — adding it now is harmless only if Task 4 lands next; if implementing strictly task-by-task, add it in Task 4 instead) and the `@orquester/config` import list with `WorkspaceMeta`. Add `UpdateWorkspaceRequest, UpdateProjectRequest` and `WorkspaceMeta` now.

- [ ] **Step 2: Surface `isArchived` in `listWorkspaces`**

In the return object of `listWorkspaces` (~line 3673), after `createdAt`:

```ts
      return {
        name,
        path,
        projectCount: projects.length,
        gitAccountId: entry?.gitAccountId ?? null,
        createdAt: entry?.createdAt,
        isArchived: entry?.isArchived ?? false
      };
```

- [ ] **Step 3: Thread the meta file through `listProjects`**

Replace the whole function (~line 3685):

```ts
async function listProjects(
  workspacesDir: string,
  workspace: string,
  metaFile: string
): Promise<ProjectSummary[]> {
  const names = await listDirectories(join(workspacesDir, workspace));
  const meta = await readWorkspacesMeta(metaFile);
  const archived = new Set(
    meta.workspaces.find((w) => w.name === workspace)?.archivedProjects ?? []
  );
  return names.map((name) => ({
    name,
    workspace,
    path: join(workspacesDir, workspace, name),
    isArchived: archived.has(name)
  }));
}
```

Update both call sites:

`GET /api/workspaces/:workspace/projects` (~line 1479):
```ts
      return listProjects(resolved.workspacesDir, workspace, resolved.workspacesMetaFile);
```

MCP deps (~line 3444):
```ts
      listProjects: (workspace) =>
        listProjects(resolved.workspacesDir, workspace, resolved.workspacesMetaFile),
```

- [ ] **Step 4: Add `PUT /api/workspaces/:workspace`**

Insert immediately after the `POST /api/workspaces` handler closes (~line 1470), before `GET /api/workspaces/:workspace/projects`. Mirrors the `PUT /api/sessions/:id` shape (typed generics, bodyless 404):

```ts
  app.put<{ Params: { workspace: string }; Body: UpdateWorkspaceRequest }>(
    "/api/workspaces/:workspace",
    async (request, reply): Promise<WorkspaceSummary | void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }
      const target = join(resolved.workspacesDir, workspace);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        return reply.code(404).send();
      }

      // Merge into the meta entry — never replace it (that would clobber
      // gitAccountId/createdAt). Workspaces predating the side-table get an
      // entry created on the spot.
      const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
      const entry: WorkspaceMeta = meta.workspaces.find((w) => w.name === workspace) ?? {
        name: workspace,
        createdAt: new Date().toISOString(),
        isArchived: false,
        archivedProjects: []
      };
      if (typeof request.body?.isArchived === "boolean") {
        entry.isArchived = request.body.isArchived;
      }
      meta.workspaces = [...meta.workspaces.filter((w) => w.name !== workspace), entry];
      await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);

      const all = await listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile);
      const summary = all.find((w) => w.name === workspace);
      if (!summary) {
        return reply.code(404).send();
      }
      return summary;
    }
  );
```

- [ ] **Step 5: Add `PUT /api/workspaces/:workspace/projects/:project`**

Insert after the `GET /api/workspaces/:workspace/projects` handler closes (~line 1481), before `POST .../projects`:

```ts
  app.put<{ Params: { workspace: string; project: string }; Body: UpdateProjectRequest }>(
    "/api/workspaces/:workspace/projects/:project",
    async (request, reply): Promise<ProjectSummary | void> => {
      const { workspace, project } = request.params;
      if (!isValidName(workspace) || !isValidName(project)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
      }
      const target = join(resolved.workspacesDir, workspace, project);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        return reply.code(404).send();
      }

      // Same merge-not-replace rule as the workspace PUT above.
      const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
      const entry: WorkspaceMeta = meta.workspaces.find((w) => w.name === workspace) ?? {
        name: workspace,
        createdAt: new Date().toISOString(),
        isArchived: false,
        archivedProjects: []
      };
      if (typeof request.body?.isArchived === "boolean") {
        const without = entry.archivedProjects.filter((name) => name !== project);
        entry.archivedProjects = request.body.isArchived ? [...without, project] : without;
      }
      meta.workspaces = [...meta.workspaces.filter((w) => w.name !== workspace), entry];
      await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);

      return {
        name: project,
        workspace,
        path: target,
        isArchived: entry.archivedProjects.includes(project)
      };
    }
  );
```

- [ ] **Step 6: Prune `archivedProjects` on project delete**

In the `DELETE /api/workspaces/:workspace/projects/:project` handler (~line 1566), after `await rm(safe, { recursive: true, force: true });` and before `return reply.code(204).send();`:

```ts
      // Prune the archive flag so a recreated same-name project starts fresh
      // (mirrors the workspace delete pruning its whole meta entry).
      const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
      const entry = meta.workspaces.find((w) => w.name === workspace);
      if (entry?.archivedProjects.includes(project)) {
        entry.archivedProjects = entry.archivedProjects.filter((name) => name !== project);
        await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);
      }
```

(Workspace delete already prunes the whole entry — no change there.)

- [ ] **Step 7: Pass the flag through the MCP tools**

In `apps/daemon/src/mcp/server.ts` (~lines 118-122), extend both projections:

```ts
  tool("list_workspaces", "List workspaces.", {}, async () =>
    (await control.listWorkspacesProjected()).map((w) => ({
      name: w.name,
      projectCount: w.projectCount,
      isArchived: w.isArchived ?? false
    }))
  );
  tool("list_projects", "List a workspace's projects.", { workspace: z.string() }, async (a) =>
    (await control.listProjectsProjected(a.workspace)).map((p) => ({
      name: p.name,
      path: p.path,
      isArchived: p.isArchived ?? false
    }))
  );
```

No gate on `createTab` — archived means hidden, not locked (spec).

- [ ] **Step 8: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/index.ts apps/daemon/src/mcp/server.ts
git commit -m "feat(daemon): archive flags on workspace/project listings + PUT archive routes"
```

---

### Task 4: Daemon — protect-archived endpoint + config-PUT preservation

**Files:**
- Modify: `apps/daemon/src/index.ts` — `PUT /api/config/daemon` merge (~1390), new route after it (~1427), imports

**Interfaces:**
- Consumes: `SetProtectArchivedRequest` (Task 2), `config` (the live `DaemonConfig`), `resolved.configPath`, `sanitizeDaemonConfig(config)`, `writeFile`.
- Produces: `PUT /api/config/daemon/protect-archived` (both transports, normal auth) → sanitized `DaemonConfig`. Task 5's `setProtectArchived` client method calls it.

- [ ] **Step 1: Import the request type**

Add `SetProtectArchivedRequest` to the `@orquester/api` type imports in `apps/daemon/src/index.ts` (if not already added in Task 3 Step 1).

- [ ] **Step 2: Preserve the flag through the full config PUT**

The `PUT /api/config/daemon` handler rebuilds the config through an explicit whitelist (~line 1390) — without a carry-over, every daemon-config save would silently reset the toggle to `false`. In its `parseDaemonConfig({...})` call, add one line:

```ts
      merged = parseDaemonConfig({
        version: 1,
        workspacesDir: body.workspacesDir ?? config.workspacesDir,
        logsDir: body.logsDir ?? config.logsDir,
        // Not managed by this route (see the dedicated endpoint below) — carry
        // the live value through so a config save can't silently reset it.
        protectArchivedData: config.protectArchivedData,
        transports: {
          http: {
            ...config.transports.http,
            ...httpPatch,
            password: undefined,
            passwordHash
          }
        }
      });
```

- [ ] **Step 3: Add the dedicated endpoint**

Insert immediately after the `PUT /api/config/daemon` handler closes (~line 1427):

```ts
  // "Protect archived data" toggle. Deliberately allowed on BOTH transports —
  // unlike the full daemon-config PUT above — because it guards a client-side
  // UI curtain, not daemon security posture, and the remote web client must be
  // able to flip it. The UI enforces retype-to-disable on its side. (Spec:
  // docs/superpowers/specs/2026-07-26-archive-workspaces-projects-design.md)
  app.put<{ Body: SetProtectArchivedRequest }>(
    "/api/config/daemon/protect-archived",
    async (request, reply): Promise<DaemonConfig | void> => {
      if (typeof request.body?.enabled !== "boolean") {
        return reply
          .code(400)
          .send({ code: "INVALID_CONFIG", message: "`enabled` must be a boolean." });
      }
      config.protectArchivedData = request.body.enabled;
      await writeFile(resolved.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      return sanitizeDaemonConfig(config);
    }
  );
```

Notes: `sanitizeDaemonConfig` spreads `...config`, so the new top-level boolean flows through unmasked with no change to it. Persisting `config` directly is safe — the transient `password` field is `undefined` after load-time migration and `JSON.stringify` drops `undefined`.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): remote-allowed protect-archived toggle endpoint"
```

---

### Task 5: UI plumbing — ApiClient, workspace-service, store

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (~284 and ~217)
- Modify: `packages/ui/src/services/workspace-service.ts`
- Modify: `packages/ui/src/store/app.ts` — state (~540), declarations (~630), initial values (~754), connect fan-out (~937), implementations (after `deleteProject` ~1441)

**Interfaces:**
- Consumes: routes from Tasks 3–4; types from Task 2; store helpers `closeWorkspace()`, `loadWorkspaces()`, `loadProjects()`, `workspaceService`.
- Produces (used by Tasks 6, 8, 9):
  - `ApiClient.updateWorkspace(name, req)`, `.updateProject(workspace, name, req)`, `.setProtectArchived(enabled)`
  - `workspaceService.setWorkspaceArchived(api, name, isArchived)`, `.setProjectArchived(api, workspace, name, isArchived)`
  - store: state `protectArchived: boolean`; actions `setWorkspaceArchived(name, isArchived)`, `setProjectArchived(project, isArchived)`, `loadProtectArchived()`, `setProtectArchived(enabled)`

- [ ] **Step 1: ApiClient methods**

In `packages/ui/src/lib/api-client.ts`, add `UpdateProjectRequest, UpdateWorkspaceRequest` to the `@orquester/api` type imports (`DaemonConfig`, `WorkspaceSummary`, `ProjectSummary` are already imported). After `listProjects` (~line 284):

```ts
  updateWorkspace(name: string, req: UpdateWorkspaceRequest): Promise<WorkspaceSummary> {
    return this.send("PUT", `/api/workspaces/${encodeURIComponent(name)}`, { body: req });
  }

  updateProject(
    workspace: string,
    name: string,
    req: UpdateProjectRequest
  ): Promise<ProjectSummary> {
    return this.send(
      "PUT",
      `/api/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(name)}`,
      { body: req }
    );
  }
```

After `updateDaemonConfig` (~line 217):

```ts
  /** The one daemon-config field writable over remote HTTP (UI curtain toggle). */
  setProtectArchived(enabled: boolean): Promise<DaemonConfig> {
    return this.send("PUT", "/api/config/daemon/protect-archived", { body: { enabled } });
  }
```

- [ ] **Step 2: workspace-service methods**

In `packages/ui/src/services/workspace-service.ts`, after `deleteProject`:

```ts
  setWorkspaceArchived(api: ApiClient, name: string, isArchived: boolean): Promise<WorkspaceSummary> {
    return api.updateWorkspace(name, { isArchived });
  },

  setProjectArchived(
    api: ApiClient,
    workspace: string,
    name: string,
    isArchived: boolean
  ): Promise<ProjectSummary> {
    return api.updateProject(workspace, name, { isArchived });
  }
```

(Add a trailing comma after the existing `deleteProject` method.)

- [ ] **Step 3: Store state + declarations**

In `packages/ui/src/store/app.ts`:

State interface (next to `workspaces` ~line 540): add

```ts
  /** "Protect archived data" daemon flag (UI curtain; loaded on connect). */
  protectArchived: boolean;
```

Action declarations (after `openProject` ~line 639):

```ts
  setWorkspaceArchived: (name: string, isArchived: boolean) => Promise<void>;
  setProjectArchived: (project: ProjectSummary, isArchived: boolean) => Promise<void>;
  loadProtectArchived: () => Promise<void>;
  setProtectArchived: (enabled: boolean) => Promise<void>;
```

Initial values (next to `workspaces: []` ~line 754): add `protectArchived: false,`

- [ ] **Step 4: Store implementations**

Insert after `deleteProject` (~line 1441):

```ts
  // Archive = navigation reset only. Unlike delete, do NOT call
  // clearProjectLocalState: tab layout, pane sizes, and view mode must survive
  // an unarchive (spec decision). Sessions keep running server-side.
  setWorkspaceArchived: async (name, isArchived) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const ws = get().workspaces.find((w) => w.name === name);
    await workspaceService.setWorkspaceArchived(api, name, isArchived);
    if (isArchived) {
      if (get().currentWorkspace === name) {
        get().closeWorkspace();
      }
      const prefix = ws?.path;
      const current = get().currentProject;
      if (prefix && current && (current.path === prefix || current.path.startsWith(`${prefix}/`))) {
        set({ currentProject: null });
      }
    }
    await get().loadWorkspaces();
  },

  setProjectArchived: async (project, isArchived) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.setProjectArchived(api, project.workspace, project.name, isArchived);
    if (isArchived && get().currentProject?.path === project.path) {
      set({ currentProject: null });
    }
    await get().loadProjects();
  },

  loadProtectArchived: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      const config = await api.getDaemonConfig();
      set({ protectArchived: config.protectArchivedData ?? false });
    } catch {
      /* older daemon without the field — keep the default (off) */
    }
  },

  setProtectArchived: async (enabled) => {
    const api = get().api;
    if (!api) {
      return;
    }
    const config = await api.setProtectArchived(enabled);
    set({ protectArchived: config.protectArchivedData ?? enabled });
  },
```

- [ ] **Step 5: Load the flag on connect**

In the connect fan-out `Promise.all` (~line 937, the block starting `get().loadWorkspaces(),`), add one line:

```ts
      get().loadProtectArchived(),
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/lib/api-client.ts packages/ui/src/services/workspace-service.ts packages/ui/src/store/app.ts
git commit -m "feat(ui): archive + protect-archived store actions and client plumbing"
```

---

### Task 6: UI — Archive context-menu items + sidebar filtering

**Files:**
- Modify: `packages/ui/src/components/sidebar/WorkspaceList.tsx` (imports ~1-21, `menuItems` ~45-57, rows map ~91-146)
- Modify: `packages/ui/src/components/sidebar/ProjectList.tsx` (imports ~1-27, `menuItems` ~59-71, rows map ~125-186)

**Interfaces:**
- Consumes: store actions `setWorkspaceArchived` / `setProjectArchived` (Task 5), `isArchived` on summaries (Task 2).
- Produces: sidebar lists render only unarchived items (Task 8's footer complements this).

- [ ] **Step 1: WorkspaceList — Archive menu item**

Add `Archive` to the lucide-react import (line 2). Add the store action next to the existing ones (the component already reads `openWorkspace`/`deleteWorkspace` from `useAppStore`):

```tsx
  const setWorkspaceArchived = useAppStore((s) => s.setWorkspaceArchived);
```

Insert into `menuItems` between "Copy Full Path" and "Delete" (no confirm dialog — instantly reversible):

```tsx
    {
      label: "Archive",
      icon: <Archive size={13} />,
      onClick: () => void setWorkspaceArchived(workspace.name, true)
    },
```

- [ ] **Step 2: WorkspaceList — filter archived rows**

The component maps `workspaces` directly. Derive a filtered list right after the store reads:

```tsx
  const visibleWorkspaces = workspaces.filter((w) => !w.isArchived);
```

Then in the JSX replace the three usages: `workspaces.length === 0` (both empty/loading conditions) → `visibleWorkspaces.length === 0`, and `{workspaces.map((workspace) => {` → `{visibleWorkspaces.map((workspace) => {`. Keep every other lookup (e.g. delete's `workspaces.find`) on the full list.

- [ ] **Step 3: ProjectList — same pattern**

Add `Archive` to the lucide-react import. Add:

```tsx
  const setProjectArchived = useAppStore((s) => s.setProjectArchived);
```

Insert into `menuItems` between "Copy Full Path" and "Delete":

```tsx
    {
      label: "Archive",
      icon: <Archive size={13} />,
      onClick: () => void setProjectArchived(project, true)
    },
```

Derive and use the filtered list exactly as in Step 2:

```tsx
  const visibleProjects = projects.filter((p) => !p.isArchived);
```

replacing `projects.length === 0` conditions and `projects.map(...)` in the rows JSX with `visibleProjects`. (Do not touch the to-do section.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/sidebar/WorkspaceList.tsx packages/ui/src/components/sidebar/ProjectList.tsx
git commit -m "feat(ui): Archive context-menu action; hide archived items from sidebar lists"
```

---

### Task 7: UI — client-side password verify (helper + shared component)

**Files:**
- Modify: `packages/ui/src/lib/auth.ts`
- Create: `packages/ui/src/components/ui/password-verify.tsx`
- Modify: `packages/ui/src/components/ui/index.ts` (barrel export)

**Interfaces:**
- Consumes: `loadStoredHash(endpoint)` (existing, `lib/auth.ts`), store `api` (for `api.connection.endpoint`), existing `Button` component.
- Produces (used by Tasks 8, 9): `verifyLocalPassword(password, storedHash): boolean`; `<PasswordVerify onVerified={() => void} message?: string autoFocus?: boolean />` — auto-calls `onVerified` on mount when no stored hash exists (local/unauthenticated transport ⇒ gate is inert).

- [ ] **Step 1: Add `verifyLocalPassword` to `lib/auth.ts`**

```ts
/**
 * Client-side check for the "Protect archived data" curtain: does the typed
 * password match the per-endpoint stored credential hash? A bcrypt hash embeds
 * its own salt, so this is a pure offline compare — nothing crosses the wire
 * and the plaintext never leaves this call.
 */
export function verifyLocalPassword(password: string, storedHash: string): boolean {
  try {
    return bcrypt.compareSync(password, storedHash);
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Create `password-verify.tsx`**

First read `packages/ui/src/components/ui/input.tsx` and copy its `className` string onto the raw `<input>` below (a raw element is used deliberately: `data-*` password-manager attributes don't typecheck on a typed component, and we don't want to widen `Input`'s props for this one use).

```tsx
import React, { useEffect, useState } from "react";
import { Button } from "./button";
import { useAppStore } from "../../store/app";
import { loadStoredHash, verifyLocalPassword } from "../../lib/auth";

export interface PasswordVerifyProps {
  /** Called once the typed password matches the stored credential hash. */
  onVerified: () => void;
  /** Short explainer shown above the field. */
  message?: string;
  autoFocus?: boolean;
}

/**
 * Retype-the-password gate for "Protect archived data" (spec decision #4/#6).
 * Fully client-side: bcrypt-compares the typed password against the
 * per-endpoint stored hash (the hash embeds its salt) — nothing crosses the
 * wire. Anti-autofill: `autoComplete="new-password"` (the reliable opt-out —
 * `off` is widely ignored for password fields), a non-credential `name`, no
 * surrounding form/username field, and 1Password/LastPass ignore attributes.
 * The typed value lives only in component state.
 *
 * With no stored hash (local unix-socket desktop — auth is HTTP-only), the
 * gate is inert: it auto-verifies on mount and renders nothing.
 */
export const PasswordVerify: React.FC<PasswordVerifyProps> = ({
  onVerified,
  message,
  autoFocus
}) => {
  const api = useAppStore((s) => s.api);
  const storedHash = api ? loadStoredHash(api.connection.endpoint) : undefined;
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!storedHash) {
      onVerified();
    }
    // Inert-gate auto-pass fires once per mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!storedHash) {
    return null;
  }

  const submit = () => {
    if (verifyLocalPassword(value, storedHash)) {
      setValue("");
      onVerified();
    } else {
      setValue("");
      setError(true);
    }
  };

  return (
    <div className="space-y-2 px-2 py-1.5">
      <p className="text-xs text-neutral-400">{message ?? "Enter your password to continue."}</p>
      <input
        type="password"
        name="orq-verify"
        autoComplete="new-password"
        data-1p-ignore=""
        data-lpignore="true"
        autoFocus={autoFocus}
        placeholder="Password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            submit();
          }
        }}
        className="COPY_INPUT_CLASSNAME_FROM_input.tsx"
      />
      {error && <p className="text-xs text-red-400">Wrong password. Try again.</p>}
      <Button size="sm" disabled={!value} onClick={submit}>
        Unlock
      </Button>
    </div>
  );
};
```

Replace `COPY_INPUT_CLASSNAME_FROM_input.tsx` with the literal className from `Input` (this is the one lookup this task requires; everything else is verbatim).

- [ ] **Step 3: Export from the barrel**

Add to `packages/ui/src/components/ui/index.ts` alongside the other exports:

```ts
export * from "./password-verify";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/auth.ts packages/ui/src/components/ui/password-verify.tsx packages/ui/src/components/ui/index.ts
git commit -m "feat(ui): client-side PasswordVerify gate (no-autofill, offline bcrypt compare)"
```

---

### Task 8: UI — ArchivedFooter + floating panel

**Files:**
- Create: `packages/ui/src/components/sidebar/ArchivedFooter.tsx`
- Modify: `packages/ui/src/components/sidebar/Sidebar.tsx` (both branches)
- Modify: `packages/ui/src/components/sidebar/index.ts` (barrel, optional export)

**Interfaces:**
- Consumes: store `workspaces`/`projects`/`currentWorkspace`/`protectArchived` + actions `setWorkspaceArchived`/`setProjectArchived` (Task 5); `PasswordVerify` (Task 7); `AdaptiveMenu`, `DropdownItem`, `DropdownLabel`, `DropdownEmpty` (existing).
- Produces: `<ArchivedFooter />`, rendered above `<ServerSwitcher />`.

- [ ] **Step 1: Create `ArchivedFooter.tsx`**

```tsx
import React, { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { AdaptiveMenu, DropdownEmpty, DropdownItem, DropdownLabel, PasswordVerify } from "../ui";
import { useAppStore } from "../../store/app";

/**
 * Muted sidebar-footer entry for archived items. Context-sensitive: at the top
 * level it lists archived workspaces; inside a workspace, that workspace's
 * archived projects. Hidden entirely when nothing is archived in the current
 * context. Rows are inert except Unarchive — no navigation into archived
 * items (spec). With "Protect archived data" on, the panel body demands the
 * password on every open: the dropdown/sheet unmounts its children on close,
 * so the `verified` state below cannot outlive one open.
 */
export const ArchivedFooter: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);

  const count = currentWorkspace
    ? projects.filter((p) => p.isArchived).length
    : workspaces.filter((w) => w.isArchived).length;

  if (count === 0) {
    return null;
  }

  const trigger = (
    <span className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-neutral-600 transition-colors hover:text-neutral-400">
      <Archive size={13} className="shrink-0" />
      <span className="flex-1 truncate text-xs">Archived · {count}</span>
    </span>
  );

  return (
    <div className="px-2 pb-1">
      <AdaptiveMenu title="Archived" trigger={trigger} width="w-64">
        <ArchivedPanel />
      </AdaptiveMenu>
    </div>
  );
};

const ArchivedPanel: React.FC = () => {
  const protectArchived = useAppStore((s) => s.protectArchived);
  // Fresh mount per open ⇒ the gate re-asks every time (spec decision #5).
  const [verified, setVerified] = useState(!protectArchived);

  if (!verified) {
    return (
      <>
        <DropdownLabel>Archived</DropdownLabel>
        <PasswordVerify
          autoFocus
          message="Enter your password to view archived items."
          onVerified={() => setVerified(true)}
        />
      </>
    );
  }
  return <ArchivedList />;
};

const ArchivedList: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);
  const setWorkspaceArchived = useAppStore((s) => s.setWorkspaceArchived);
  const setProjectArchived = useAppStore((s) => s.setProjectArchived);

  const rows = currentWorkspace
    ? projects
        .filter((p) => p.isArchived)
        .map((p) => ({
          key: p.path,
          name: p.name,
          unarchive: () => void setProjectArchived(p, false)
        }))
    : workspaces
        .filter((w) => w.isArchived)
        .map((w) => ({
          key: w.path,
          name: w.name,
          unarchive: () => void setWorkspaceArchived(w.name, false)
        }));

  return (
    <>
      <DropdownLabel>
        {currentWorkspace ? "Archived projects" : "Archived workspaces"}
      </DropdownLabel>
      {rows.length === 0 && <DropdownEmpty>Nothing archived</DropdownEmpty>}
      {rows.map((row) => (
        <DropdownItem
          key={row.key}
          keepOpen
          icon={<ArchiveRestore size={14} />}
          onClick={row.unarchive}
        >
          {row.name}
        </DropdownItem>
      ))}
    </>
  );
};
```

Notes:
- `keepOpen` keeps the panel up while unarchiving several items; when the last one is unarchived, `count` hits 0 and `ArchivedFooter` returns `null`, which closes and removes everything (spec: panel closes when emptied).
- **Verify the fresh-mount assumption**: check `dropdown.tsx` and `sheet.tsx` render children only while open (the Dropdown portals its panel on open; `BottomSheet` should return null when `open` is false). If either keeps children mounted while closed, key the panel off the open state via `DropdownContext` so `verified` still resets per open.

- [ ] **Step 2: Mount in both Sidebar branches**

In `packages/ui/src/components/sidebar/Sidebar.tsx`, add the import:

```tsx
import { ArchivedFooter } from "./ArchivedFooter";
```

and in **both** the desktop `<aside>` and the mobile drawer `<aside>`, change:

```tsx
          {currentWorkspace ? <ProjectList /> : <WorkspaceList />}
          <ServerSwitcher />
```

to:

```tsx
          {currentWorkspace ? <ProjectList /> : <WorkspaceList />}
          <ArchivedFooter />
          <ServerSwitcher />
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/sidebar/ArchivedFooter.tsx packages/ui/src/components/sidebar/Sidebar.tsx packages/ui/src/components/sidebar/index.ts
git commit -m "feat(ui): archived-items footer panel with per-open password gate"
```

---

### Task 9: UI — Settings toggle "Protect archived data"

**Files:**
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx` (`DaemonSettings`, ~725-846)

**Interfaces:**
- Consumes: store `protectArchived` + `setProtectArchived(enabled)` (Task 5), `PasswordVerify` (Task 7), existing `Field`, `Switch`, `Modal` components.
- Produces: the settings surface for the toggle (final UI piece).

- [ ] **Step 1: Wire the store + local state into `DaemonSettings`**

Inside the `DaemonSettings` component, next to the existing hooks:

```tsx
  const protectArchived = useAppStore((s) => s.protectArchived);
  const setProtectArchived = useAppStore((s) => s.setProtectArchived);
  const [confirmDisable, setConfirmDisable] = useState(false);
```

(`useAppStore` and `useState` are already imported in this file; add `Modal` and `PasswordVerify` to the `../ui` import if missing.)

- [ ] **Step 2: Add the field row**

Inside the `<div className="divide-y divide-neutral-800">`, after the `{httpEnabled && (...)}` fragment closes, add — note it is deliberately **not** `disabled={!isLocal}`: unlike its neighbors it drives the dedicated remote-allowed endpoint, applies instantly, and needs no Save:

```tsx
        <Field
          label="Protect archived data"
          hint="Ask for the password before showing archived workspaces/projects. Changeable from any client; applies instantly."
        >
          <Switch
            checked={protectArchived}
            onChange={(next) => {
              if (next) {
                void setProtectArchived(true);
              } else {
                // Retype-to-disable (spec decision #6): the curtain must not be
                // one-click removable on an unattended open session.
                setConfirmDisable(true);
              }
            }}
          />
        </Field>
```

- [ ] **Step 3: Add the retype-to-disable modal**

At the end of `DaemonSettings`' returned JSX (after the Save button block, inside the root `<div className="space-y-4">`):

```tsx
      <Modal open={confirmDisable} onClose={() => setConfirmDisable(false)} className="w-80">
        <div className="space-y-3 p-4">
          <p className="text-sm text-neutral-200">Disable archived-data protection</p>
          <PasswordVerify
            autoFocus
            message="Retype your password to turn this off."
            onVerified={() => {
              setConfirmDisable(false);
              void setProtectArchived(false);
            }}
          />
        </div>
      </Modal>
```

(On the local desktop client with no stored credential, `PasswordVerify` auto-verifies — the gate is inert there by spec.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "feat(ui): Protect archived data toggle with retype-to-disable"
```

---

### Task 10: Final verification & handoff checklist

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + diff review**

Run: `pnpm check` — expected exit 0.
Run: `git log --oneline main@{u}..main 2>/dev/null || git log --oneline -8` and `git diff HEAD~8 --stat` (adjust the count to the commits made) — confirm only the files this plan names changed.

- [ ] **Step 2: Spec conformance re-read**

Re-read `docs/superpowers/specs/2026-07-26-archive-workspaces-projects-design.md` top to bottom and check each decision against the diff (metadata-only, merge-not-replace, no events, no `clearProjectLocalState`, per-open re-prompt, remote-togglable protect endpoint, MCP passthrough, delete pruning).

- [ ] **Step 3: Report the manual verification checklist to the user**

The live daemon runs old code until the **user** restarts it (⛔ never restart it yourself). Report done = typecheck + review, and hand over this checklist for their next restart:

1. Right-click a scratch workspace → Archive → it vanishes; muted "Archived · 1" footer appears; `workspaces.json` shows `isArchived: true` merged into the entry (with `gitAccountId`/`createdAt` intact).
2. Footer → panel opens (flips upward) → Unarchive → row returns to the list, footer disappears.
3. Same for a project inside a workspace (`archivedProjects` gains/loses the name).
4. Archive the currently open workspace/project → UI navigates away; unarchive → reopen → tab layout/pane sizes/view mode intact; running sessions untouched throughout.
5. Settings → Daemon → toggle "Protect archived data" ON from the remote web client (works despite the read-only banner) → every panel open now prompts; wrong password rejected inline; right password reveals; browser offers **no autofill**.
6. Toggle OFF → retype prompt appears first; `daemon.json` shows `protectArchivedData` flipping; a normal daemon-config Save does not reset it.
7. Delete an archived project → its name is pruned from `archivedProjects`.
8. After any future deploy: `pnpm build` + `node scripts/smoke-web.mjs https://<domain>` per AGENTS.md (UI changed).
