# Remote Phase 3 — Workspace/Project Metadata + Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the lightweight per-workspace metadata store the codebase lacks today (mirroring `remotes.json`), wire it into workspace listing/creation, and add **delete** for workspaces and projects from the sidebar — cascading to disk (`rm -rf`), live sessions, and the metadata entry, gated by destructive-action confirmation.

**Architecture:** A new `workspaces.json` side-table (`packages/config`) keyed by workspace **name** carries `gitAccountId` + `createdAt` (Phase 4 reads `gitAccountId` to bind a git identity; this phase keeps the field but adds **no** accounts dependency). The daemon merges this side-table onto its filesystem listing (filesystem stays the source of truth for existence) and gains two `DELETE` routes modeled on the create handlers + `DELETE /api/sessions/:id`, with an extra realpath-prefix safety check before `rm`. Sessions gain `closeByProjectPrefix` so deleting a workspace/project kills its terminals. The web client gets `deleteWorkspace`/`deleteProject` (api-client → service → store actions) and sidebar context-menus that open a reusable `ConfirmDialog` (workspace delete requires typed-name confirmation; project delete is a simple confirm).

**Tech Stack:** TypeScript, Zod (config), Fastify (daemon), node's `fs/promises` (`rm`, `realpath`) + `events`, React 18 + Zustand (web), Tailwind, lucide-react.

## Global Constraints

- No new runtime dependencies. `rm` is already imported from `node:fs/promises` (`apps/daemon/src/index.ts:52`); add `realpath` to that same import.
- **Filesystem is the source of truth for existence.** `workspaces.json` is a side-table merged onto the directory listing; a missing/garbage file degrades to "no metadata", never to "no workspaces". Read-with-fallback like `readRemotesFile` (`index.ts:884-890`).
- **`workspaces.json` is keyed by workspace NAME**, not path (`workspacesDir` paths contain `$vars`). It lives daemon-side at `<appdir>/daemon/workspaces.json` — NOT under `app/` (that dir holds the client-shared `app.json`/`remotes.json`).
- **This phase adds the `gitAccountId` field but no accounts logic.** `createWorkspace` persists whatever `gitAccountId` it is given (UI passes `undefined` this phase); `listWorkspaces` echoes it back. Do **not** add a resolved `gitAccount` object, an accounts store, or any `includeIf`/git-config code — that is Phase 4. (The spec §3.2 mentions a resolved `gitAccount` object; this plan deliberately ships the simpler `gitAccountId?: string | null` contract the prompt fixes, so Phase 4's UI resolves the label from its own accounts store.)
- **Delete is `rm -rf` of a real directory — irreversible.** Before `rm`, resolve the target's realpath and reject anything not strictly inside `realpath(workspacesDir)`. Keep the existing `isValidName` guards too (defense in depth).
- Delete replies mirror `DELETE /api/sessions/:id` (`index.ts:573-579`): **204** on success, **404** if the directory doesn't exist. (Reject invalid names with **400**, like the create handlers.)
- Workspace delete requires **typed-name confirmation** (the user types the workspace name to enable the button); project delete is a **simple confirm**. No destructive `Button` variant exists — borrow the red from `context-menu.tsx:63` (`bg-red-600`/`text-red-...`) via a `className` override.
- Verification is `pnpm check` (workspace typecheck) + runtime checks (curl / Playwright); the repo has **no test runner** — do not add one.
- Match existing code style (comment density, naming, `cn()` usage). Sidebar rows are `<button>`s; mirror the `TabStrip` context-menu pattern (`TabStrip.tsx:54,104-107,165-167`).

**Auth bearer for curl checks (Phase 1 has NOT landed):** the daemon currently authenticates with the bare bcrypt `passwordHash` as the bearer. The `.stage` daemon's hash (stage password `123456`) is:

```
$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe
```

> If Phase 1 (username auth) lands first, the bearer instead becomes `base64("mapacho:" + passwordHash)` (HTTP `Authorization: Bearer …` and WS `?token=…`). Both forms are noted on every curl step; use the bare hash until Phase 1 is merged.

**Dev servers:** `pnpm dev:daemon` (`tsx watch`, binds `0.0.0.0:47831`, `workspacesDir = ./.stage/workspaces`, `appdir = ./.stage`) and `pnpm dev:web` (:5173) are already running and hot-reload; no restart needed after edits. The daemon's `workspaces.json` will live at `./.stage/daemon/workspaces.json`.

---

### Task 1: Config — `workspaces.json` schema + paths (`@orquester/config`)

**Files:**
- Modify: `packages/config/src/index.ts` (add a `workspaces.json` section after the `remotes.json` triplet, ~line 262; add `workspacesMetaPath` near the other path helpers, ~line 85)

**Interfaces:**
- Produces: `workspacesConfigSchema`; `WorkspacesConfig`; `createDefaultWorkspacesConfig()`; `parseWorkspacesConfig(value)`; `workspacesMetaPath(baseDir) → <appdir>/daemon/workspaces.json`. Mirrors `remotesConfigSchema`/`createDefaultRemotesConfig`/`parseRemotesConfig`/`remotesConfigPath`.

- [ ] **Step 1: Add `workspacesMetaPath`** — insert immediately after `daemonConfigPath` (`index.ts:87-89`), so the workspaces metadata path sits with the other daemon-dir path helpers:

```ts
export function workspacesMetaPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "workspaces.json");
}
```

- [ ] **Step 2: Add the `workspaces.json` schema triplet** — insert after the `remotes.json` block (after `parseRemotesConfig`, `index.ts:260-262`), before the `ClientConfig` section:

```ts
// workspaces.json (daemon-side per-workspace metadata; keyed by workspace NAME)
//
// A lightweight side-table layered onto the filesystem listing of
// `workspacesDir`. The filesystem stays the source of truth for which
// workspaces exist; this only carries extra metadata (the bound git account id
// + creation time) for names that have it. Lives at <appdir>/daemon/workspaces.json.

export const workspaceMetaSchema = z.object({
  /** Workspace directory name — the stable identifier (paths contain $vars). */
  name: z.string().min(1),
  /** Git account this workspace is bound to (Phase 4); undefined = default identity. */
  gitAccountId: z.string().optional(),
  /** ISO timestamp the workspace was created through orquester. */
  createdAt: z.string()
});

export const workspacesConfigSchema = z.object({
  version: z.literal(1).default(1),
  workspaces: z.array(workspaceMetaSchema).default([])
});

export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>;
export type WorkspacesConfig = z.infer<typeof workspacesConfigSchema>;

export function createDefaultWorkspacesConfig(): WorkspacesConfig {
  return workspacesConfigSchema.parse({ workspaces: [] });
}

export function parseWorkspacesConfig(value: unknown): WorkspacesConfig {
  return workspacesConfigSchema.parse(value);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS across the whole workspace. This task only **adds** exports to `@orquester/config`; nothing consumes them yet, so no package breaks. (`@orquester/config` and every downstream package must compile clean.)

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/index.ts
git commit -m "feat(config): workspaces.json metadata schema + workspacesMetaPath"
```

---

### Task 2: API contract — `WorkspaceSummary` + `CreateWorkspaceRequest`

**Files:**
- Modify: `packages/api/src/index.ts` (`WorkspaceSummary` ~line 38-42; `CreateWorkspaceRequest` ~line 54-56)

**Interfaces:**
- Produces: `WorkspaceSummary` gains `gitAccountId?: string | null` and `createdAt?: string`. `CreateWorkspaceRequest` gains `gitAccountId?: string`. (Phase 4 will resolve `gitAccountId` → an account label in the UI from its own store; this phase carries only the id.)

- [ ] **Step 1: Extend `WorkspaceSummary`** — add the two optional fields after `projectCount`:

```ts
export interface WorkspaceSummary {
  name: string;
  path: string;
  projectCount: number;
  /**
   * Git account this workspace is bound to, from workspaces.json (Phase 4).
   * `null`/absent = no binding (default git identity). The UI resolves the id
   * to a label from its accounts store; this contract carries only the id.
   */
  gitAccountId?: string | null;
  /** ISO creation timestamp from workspaces.json, when present. */
  createdAt?: string;
}
```

- [ ] **Step 2: Extend `CreateWorkspaceRequest`** — add the optional account id:

```ts
export interface CreateWorkspaceRequest {
  name: string;
  /** Optional git account to bind (Phase 4 wires the picker; undefined here). */
  gitAccountId?: string;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS. Both fields are **optional**, so existing `WorkspaceSummary` producers/consumers (daemon `listWorkspaces`/create at `index.ts:375-388`; UI store/service) still compile unchanged. The `@orquester/api` package must compile clean.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): WorkspaceSummary gitAccountId/createdAt + CreateWorkspaceRequest gitAccountId"
```

---

### Task 3: Daemon — metadata merge into list + write on create

**Files:**
- Modify: `apps/daemon/src/index.ts` (imports ~line 27-47; `ResolvedPaths` ~line 62-72 + its construction ~line 106-114; `GET`/`POST /api/workspaces` ~line 375-388; `listWorkspaces` ~line 826-835; add read/write helpers near `readRemotesFile`/`writeJsonFile` ~line 884-895)

**Interfaces:**
- Consumes: `workspacesConfigSchema`/`createDefaultWorkspacesConfig`/`parseWorkspacesConfig`/`workspacesMetaPath`/`WorkspacesConfig` (Task 1); `WorkspaceSummary.gitAccountId/createdAt` + `CreateWorkspaceRequest.gitAccountId` (Task 2).
- Produces: `GET /api/workspaces` merges the `workspaces.json` side-table (keyed by name) onto the filesystem listing; `POST /api/workspaces` writes/updates the metadata entry `{ name, gitAccountId, createdAt }`. Adds `resolved.workspacesMetaFile`; adds `readWorkspacesMeta`/`writeWorkspacesMeta` helpers.

- [ ] **Step 1: Import the config helpers + `WorkspacesConfig`** — add to the existing `@orquester/config` import block (`index.ts:27-47`), alphabetically near the other `createDefault…`/`parse…` imports:

```ts
  type WorkspacesConfig,
  createDefaultWorkspacesConfig,
  parseWorkspacesConfig,
  workspacesMetaPath,
```

(Place `type WorkspacesConfig` with the other `type` imports at the top of the block, and the three value imports among `createDefaultRemotesConfig` / `parseRemotesConfig` / `remotesConfigPath`.)

- [ ] **Step 2: Add `workspacesMetaFile` to `ResolvedPaths`** — extend the interface (`index.ts:62-72`):

```ts
/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
  daemonDir: string;
  configPath: string;
  /** app.json + remotes.json live under <appdir>/app and are shared by clients. */
  appConfigFile: string;
  remotesFile: string;
  /** Per-workspace metadata side-table (daemon-side, keyed by workspace name). */
  workspacesMetaFile: string;
  workspacesDir: string;
  logsDir: string;
  vars: ConfigVars;
}
```

- [ ] **Step 3: Populate it where `resolved` is built** — add the field in the `ResolvedPaths` object literal (`index.ts:106-114`), after `remotesFile`:

```ts
  const resolved: ResolvedPaths = {
    daemonDir: paths.daemonDir,
    configPath: paths.configPath,
    appConfigFile: appConfigPath(paths.baseDir),
    remotesFile: remotesConfigPath(paths.baseDir),
    workspacesMetaFile: workspacesMetaPath(paths.baseDir),
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    logsDir: expandVars(config.logsDir, paths.vars),
    vars: paths.vars
  };
```

- [ ] **Step 4: Add read/write helpers** — insert immediately after `readRemotesFile` (`index.ts:884-890`), mirroring its read-with-fallback shape and using the shared `writeJsonFile`:

```ts
async function readWorkspacesMeta(file: string): Promise<WorkspacesConfig> {
  try {
    return parseWorkspacesConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return createDefaultWorkspacesConfig();
  }
}

async function writeWorkspacesMeta(file: string, value: WorkspacesConfig): Promise<void> {
  await writeJsonFile(file, value);
}
```

- [ ] **Step 5: Make `listWorkspaces` merge the side-table** — replace the function (`index.ts:826-835`). It now takes the meta file path and overlays `gitAccountId`/`createdAt` by name; the filesystem still decides which workspaces exist:

```ts
async function listWorkspaces(
  workspacesDir: string,
  metaFile: string
): Promise<WorkspaceSummary[]> {
  const names = await listDirectories(workspacesDir);
  const meta = await readWorkspacesMeta(metaFile);
  const byName = new Map(meta.workspaces.map((w) => [w.name, w]));
  return Promise.all(
    names.map(async (name) => {
      const path = join(workspacesDir, name);
      const projects = await listDirectories(path);
      const entry = byName.get(name);
      return {
        name,
        path,
        projectCount: projects.length,
        gitAccountId: entry?.gitAccountId ?? null,
        createdAt: entry?.createdAt
      };
    })
  );
}
```

- [ ] **Step 6: Pass the meta file at the `GET` call site** — update the route (`index.ts:375-377`):

```ts
  app.get("/api/workspaces", async (): Promise<WorkspaceSummary[]> =>
    listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile)
  );
```

- [ ] **Step 7: Write the metadata entry on create** — replace the `POST /api/workspaces` handler (`index.ts:379-388`). After `mkdir`, upsert the `{ name, gitAccountId, createdAt }` entry (replacing any stale entry for the same name) and return the enriched summary:

```ts
  app.post("/api/workspaces", async (request, reply): Promise<WorkspaceSummary | void> => {
    const body = request.body as CreateWorkspaceRequest | undefined;
    const name = body?.name;
    if (!isValidName(name)) {
      return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
    }

    const path = join(resolved.workspacesDir, name);
    await mkdir(path, { recursive: true });

    // Upsert the metadata side-table entry (keyed by name).
    const createdAt = new Date().toISOString();
    const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
    const entry = { name, gitAccountId: body?.gitAccountId, createdAt };
    meta.workspaces = [...meta.workspaces.filter((w) => w.name !== name), entry];
    await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);

    return { name, path, projectCount: 0, gitAccountId: entry.gitAccountId ?? null, createdAt };
  });
```

- [ ] **Step 8: Typecheck**

Run: `pnpm check`
Expected: PASS across the workspace. (The daemon now consumes the Task 1 exports + Task 2 fields; UI is untouched so far.)

- [ ] **Step 9: Runtime verify — create writes metadata, list merges it** (dev daemon hot-reloads)

```bash
TOKEN='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'   # Phase 1: base64("mapacho:$TOKEN")
B="http://127.0.0.1:47831"
# create a workspace
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"meta-ws"}' "$B/api/workspaces"; echo
# list it back: gitAccountId is null, createdAt is an ISO string
curl -sS -H "Authorization: Bearer $TOKEN" "$B/api/workspaces" \
  | python3 -c 'import sys,json;[print(w["name"],"acct=",w.get("gitAccountId"),"created=",bool(w.get("createdAt"))) for w in json.load(sys.stdin) if w["name"]=="meta-ws"]'
# confirm the side-table file exists with the entry (keyed by name, daemon-side)
cat ./.stage/daemon/workspaces.json
```

Expected: POST returns `{"name":"meta-ws","path":".../meta-ws","projectCount":0,"gitAccountId":null,"createdAt":"<iso>"}`; the list shows `meta-ws acct= None created= True`; `./.stage/daemon/workspaces.json` contains a `workspaces` array with `{ "name": "meta-ws", "createdAt": "<iso>" }` (no `gitAccountId` key, since `undefined` is dropped by `JSON.stringify`). Leave `meta-ws` in place — Task 5 deletes it.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): merge workspaces.json metadata into list + write on create"
```

---

### Task 4: Daemon — sessions cascade + delete endpoints

**Files:**
- Modify: `apps/daemon/src/sessions.ts` (add `closeByProjectPrefix` after `close`, ~line 157; `sep` import)
- Modify: `apps/daemon/src/index.ts` (add `realpath` to the `node:fs/promises` import ~line 52; add the two `DELETE` routes after `POST /api/workspaces/.../projects` ~line 414; add a `resolveInside` guard helper near `isValidName` ~line 809)

**Interfaces:**
- Consumes: `sessions.closeByProjectPrefix` (this task); `isValidName` (`index.ts:801-809`); `resolved.workspacesDir`/`workspacesMetaFile` + `readWorkspacesMeta`/`writeWorkspacesMeta` (Task 3).
- Produces: `SessionManager.closeByProjectPrefix(prefix: string): void`; `DELETE /api/workspaces/:workspace` and `DELETE /api/workspaces/:workspace/projects/:project` → 204 | 404 | 400; a `resolveWithinWorkspaces(...)` realpath guard.

- [ ] **Step 1: Add `closeByProjectPrefix` to `SessionManager`** — first add `sep` to the imports at the top of `sessions.ts` (`sessions.ts:1-6`):

```ts
import { sep } from "node:path";
```

Then insert the method immediately after `close(...)` (`sessions.ts:144-157`). Exact-match handles delete-project; the `prefix + sep` branch handles delete-workspace (every project under it). Snapshot the entries first so deleting while iterating is safe:

```ts
  /**
   * Close every session whose project is `prefix` (exact, e.g. delete-project)
   * or lives under it (`prefix + sep`, e.g. delete-workspace). Reuses close(),
   * so each emits "closed" (clients drop the tab).
   */
  closeByProjectPrefix(prefix: string): void {
    for (const [id, session] of [...this.sessions]) {
      const project = session.summary.projectPath;
      if (project === prefix || project.startsWith(prefix + sep)) {
        this.close(id);
      }
    }
  }
```

- [ ] **Step 2: Add `realpath` to the daemon's `fs/promises` import** — extend `index.ts:52`:

```ts
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
```

- [ ] **Step 3: Add the realpath-prefix guard** — insert after `isValidName` (`index.ts:801-809`). It resolves both the candidate and the workspaces root to realpaths and confirms the candidate is the root itself or strictly beneath it. Returns the resolved path, or `null` if the candidate doesn't exist / escapes the root:

```ts
/**
 * Resolve `target` and verify it is `root` itself or strictly inside it (after
 * following symlinks). Returns the realpath when safe, else null. Used to make
 * the destructive delete endpoints reject path traversal / symlink escapes.
 */
async function resolveWithinWorkspaces(target: string, root: string): Promise<string | null> {
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = await realpath(target);
    realRoot = await realpath(root);
  } catch {
    return null; // target (or root) doesn't exist
  }
  if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
    return realTarget;
  }
  return null;
}
```

Add `sep` to the `node:path` import at the top of `index.ts` (`index.ts:54`):

```ts
import { dirname, join, resolve, sep } from "node:path";
```

- [ ] **Step 4: Add the two DELETE routes** — insert immediately after the `POST /api/workspaces/:workspace/projects` handler (`index.ts:401-414`).

Project delete: validate names → build path → realpath-guard → `closeByProjectPrefix(realpath)` → `rm` → 204/404. (Cascade sessions before `rm` so a long-running PTY isn't holding the dir.)

```ts
  app.delete<{ Params: { workspace: string; project: string } }>(
    "/api/workspaces/:workspace/projects/:project",
    async (request, reply): Promise<void> => {
      const { workspace, project } = request.params;
      if (!isValidName(workspace) || !isValidName(project)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
      }

      const target = join(resolved.workspacesDir, workspace, project);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        // Either gone or outside the workspaces root — 404 (don't leak which).
        return reply.code(404).send();
      }

      sessions.closeByProjectPrefix(safe);
      await rm(safe, { recursive: true, force: true });
      return reply.code(204).send();
    }
  );

  app.delete<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace",
    async (request, reply): Promise<void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }

      const target = join(resolved.workspacesDir, workspace);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        return reply.code(404).send();
      }

      // Kill every session under the workspace, remove the tree, then prune the
      // metadata entry (keyed by name).
      sessions.closeByProjectPrefix(safe);
      await rm(safe, { recursive: true, force: true });
      const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
      meta.workspaces = meta.workspaces.filter((w) => w.name !== workspace);
      await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);

      return reply.code(204).send();
    }
  );
```

> Routing note: Fastify matches the static `/api/workspaces/:workspace/projects/:project` and `/api/workspaces/:workspace` distinctly; neither collides with `GET`/`POST` on the same patterns (different methods) nor with `DELETE /api/sessions/:id`.

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS across the workspace.

- [ ] **Step 6: Runtime verify — delete cascade + traversal rejection** (dev daemon hot-reloads)

Creates a workspace + project + a session bound to the project, deletes the **project**, and asserts: the dir is gone, the session is closed (gone from `/api/sessions`), and a delete path **outside** `workspacesDir` is rejected. Then deletes the leftover `meta-ws` from Task 3 and asserts its metadata entry is pruned.

```bash
TOKEN='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'   # Phase 1: base64("mapacho:$TOKEN")
B="http://127.0.0.1:47831"
WS=./.stage/workspaces

# 1. workspace + project + a bash session bound to the project path
curl -sS -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"del-ws"}' "$B/api/workspaces"
PROJ=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"del-proj"}' "$B/api/workspaces/del-ws/projects" | python3 -c 'import sys,json;print(json.load(sys.stdin)["path"])')
SID=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"refId\":\"bash\",\"projectPath\":\"$PROJ\",\"cwd\":\"$PROJ\"}" "$B/api/sessions" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "project=$PROJ session=$SID"
test -d "$PROJ" && echo "dir exists before delete: yes"

# 2. delete the project (simple confirm path)
curl -sS -o /dev/null -w "DELETE project HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/workspaces/del-ws/projects/del-proj"

# 3. dir gone + session closed
test -d "$PROJ" || echo "dir gone after delete: yes"
curl -sS -H "Authorization: Bearer $TOKEN" "$B/api/sessions" | python3 -c "import sys,json;print('session closed:', not any(s['id']=='$SID' for s in json.load(sys.stdin)))"

# 4. traversal / outside-root rejection (escape via .. AND an absolute outside path)
curl -sS -o /dev/null -w "DELETE ../escape HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/workspaces/del-ws/projects/..%2f..%2f..%2fetc"
mkdir -p /tmp/orq-outside && curl -sS -o /dev/null -w "DELETE outside-root HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/workspaces/orq-outside" ; echo "(/tmp/orq-outside still present:)"; test -d /tmp/orq-outside && echo yes

# 5. workspace delete prunes metadata: remove del-ws and the Task-3 meta-ws
curl -sS -o /dev/null -w "DELETE del-ws HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/workspaces/del-ws"
curl -sS -o /dev/null -w "DELETE meta-ws HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/workspaces/meta-ws"
echo "workspaces.json after pruning (should not contain meta-ws/del-ws):"; cat ./.stage/daemon/workspaces.json
# 6. deleting a non-existent workspace → 404
curl -sS -o /dev/null -w "DELETE missing HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/workspaces/does-not-exist"
rmdir /tmp/orq-outside
```

Expected:
- `dir exists before delete: yes`, then `dir gone after delete: yes`.
- `DELETE project HTTP 204`; `session closed: True`.
- `DELETE ../escape HTTP 404` (the `..` name fails `isValidName` → 400 actually — see note) and `DELETE outside-root HTTP 404`; `/tmp/orq-outside` is **still present** (`yes`) — the guard refused to `rm` outside the root.
- `DELETE del-ws HTTP 204`, `DELETE meta-ws HTTP 204`; the printed `workspaces.json` no longer lists `meta-ws` or `del-ws`.
- `DELETE missing HTTP 404`.

> Note on the `../escape` case: the encoded `..%2f…` segment contains `/` after Fastify decodes the param, so `isValidName` rejects it with **400** (not 404). Either status proves the traversal was refused before any `rm`; the load-bearing assertion is the **outside-root 404 with `/tmp/orq-outside` intact**, which exercises the realpath guard directly (a valid name that resolves outside the root).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/sessions.ts apps/daemon/src/index.ts
git commit -m "feat(daemon): delete workspace/project endpoints + closeByProjectPrefix cascade"
```

---

### Task 5: Client — api-client + service + store delete actions

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (after `createProject` ~line 188; or grouped with the workspace methods ~line 147-159)
- Modify: `packages/ui/src/services/workspace-service.ts` (add `delete`/`deleteProject`; thread `gitAccountId` through `create`)
- Modify: `packages/ui/src/store/app.ts` (`AppState` decls ~line 215-221; store impl `createWorkspace`/`createProject`/`closeWorkspace` ~line 527-568)

**Interfaces:**
- Consumes: `this.send("DELETE", …)` (`api-client.ts:60-74`); `workspaceService` (existing); `CreateWorkspaceRequest.gitAccountId` (Task 2); the daemon DELETE routes (Task 4).
- Produces: `ApiClient.deleteWorkspace(name)` / `deleteProject(workspace, name)`; `workspaceService.delete` / `deleteProject` + `create(api, name, gitAccountId?)`; store actions `deleteWorkspace(name)` / `deleteProject(project)` + `createWorkspace(name, gitAccountId?)`.

- [ ] **Step 1: Add the two api-client methods** — insert in the "Workspaces & projects" group, after `createProject` (`api-client.ts:179-188`):

```ts
  deleteWorkspace(name: string): Promise<void> {
    return this.send("DELETE", `/api/workspaces/${encodeURIComponent(name)}`);
  }

  deleteProject(workspace: string, name: string): Promise<void> {
    return this.send(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(name)}`
    );
  }
```

- [ ] **Step 2: Mirror in the workspace service** — replace the service object (`workspace-service.ts:9-25`). `create` gains the optional `gitAccountId` (threaded into the request); add `delete`/`deleteProject`:

```ts
export const workspaceService = {
  list(api: ApiClient, signal?: AbortSignal): Promise<WorkspaceSummary[]> {
    return api.listWorkspaces(signal);
  },

  create(api: ApiClient, name: string, gitAccountId?: string): Promise<WorkspaceSummary> {
    return api.createWorkspace({ name, gitAccountId });
  },

  delete(api: ApiClient, name: string): Promise<void> {
    return api.deleteWorkspace(name);
  },

  listProjects(api: ApiClient, workspace: string, signal?: AbortSignal): Promise<ProjectSummary[]> {
    return api.listProjects(workspace, signal);
  },

  createProject(api: ApiClient, workspace: string, name: string): Promise<ProjectSummary> {
    return api.createProject(workspace, { name });
  },

  deleteProject(api: ApiClient, workspace: string, name: string): Promise<void> {
    return api.deleteProject(workspace, name);
  }
};
```

- [ ] **Step 3: Declare the store actions + widen `createWorkspace`** — in the `AppState` interface, change the `createWorkspace` signature and add the two delete actions (`app.ts:215` and `app.ts:220`):

```ts
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, gitAccountId?: string) => Promise<void>;
  deleteWorkspace: (name: string) => Promise<void>;
  openWorkspace: (name: string) => Promise<void>;
  closeWorkspace: () => void;

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  deleteProject: (project: ProjectSummary) => Promise<void>;
  openProject: (project: ProjectSummary) => void;
```

- [ ] **Step 4: Implement `createWorkspace` (widened) + `deleteWorkspace`** — replace `createWorkspace` (`app.ts:527-534`) and add `deleteWorkspace` right after it. `deleteWorkspace` deletes on the daemon, then: if the deleted workspace is currently open, reset via `closeWorkspace`; clear the client-local per-path maps for every removed path (the workspace dir prefix); then reload the list. Sessions are dropped by the daemon's `session.closed` broadcast, but the path-keyed client maps (`fileTabsByProject`/`activeTabByProject`/`viewModeByProject`) are **not**, so clear them here:

```ts
  createWorkspace: async (name, gitAccountId) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.create(api, name, gitAccountId);
    await get().loadWorkspaces();
  },

  deleteWorkspace: async (name) => {
    const api = get().api;
    if (!api) {
      return;
    }
    // The deleted workspace's directory prefix; every project path under it is
    // `<wsPath>/<project>`. Used to purge path-keyed client-local tab state.
    const ws = get().workspaces.find((w) => w.name === name);
    const prefix = ws?.path;
    await workspaceService.delete(api, name);
    if (get().currentWorkspace === name) {
      get().closeWorkspace();
    }
    if (prefix) {
      set((state) => clearProjectLocalState(state, (path) => path === prefix || path.startsWith(`${prefix}/`)));
    }
    await get().loadWorkspaces();
  },
```

- [ ] **Step 5: Implement `deleteProject`** — add right after `createProject` (`app.ts:560-568`). It deletes on the daemon, resets `currentProject` if the deleted project is open, clears that one path's client-local state, and reloads the project list:

```ts
  deleteProject: async (project) => {
    const api = get().api;
    if (!api) {
      return;
    }
    await workspaceService.deleteProject(api, project.workspace, project.name);
    set((state) => {
      const next = clearProjectLocalState(state, (path) => path === project.path);
      // If the open project was deleted, drop it from the main view.
      if (state.currentProject?.path === project.path) {
        next.currentProject = null;
      }
      return next;
    });
    await get().loadProjects();
  },
```

- [ ] **Step 6: Add the `clearProjectLocalState` helper** — insert near the other state helpers at the bottom of the file (after `removeFileTab`, `app.ts:779-788`). It drops every entry from the three path-keyed maps whose key matches `match`, and persists `viewModeByProject` (same as `setViewMode`, `app.ts:680`):

```ts
/**
 * Purge the client-local, path-keyed tab maps for project paths matching
 * `match` (used after a workspace/project is deleted — the daemon's
 * session.closed events drop sessions, but these maps are client-only).
 */
function clearProjectLocalState(
  state: AppState,
  match: (path: string) => boolean
): Partial<AppState> {
  const fileTabsByProject: Record<string, FileTab[]> = {};
  for (const [path, tabs] of Object.entries(state.fileTabsByProject)) {
    if (!match(path)) {
      fileTabsByProject[path] = tabs;
    }
  }
  const activeTabByProject: Record<string, string | null> = {};
  for (const [path, id] of Object.entries(state.activeTabByProject)) {
    if (!match(path)) {
      activeTabByProject[path] = id;
    }
  }
  const viewModeByProject: Record<string, ViewMode> = {};
  for (const [path, mode] of Object.entries(state.viewModeByProject)) {
    if (!match(path)) {
      viewModeByProject[path] = mode;
    }
  }
  saveViewModes(viewModeByProject);
  return { fileTabsByProject, activeTabByProject, viewModeByProject };
}
```

(`FileTab`, `ViewMode`, and `saveViewModes` are already imported/declared in this file — see `app.ts:7,127`.)

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: PASS across the workspace. (The store/service/api-client now consume the Task 2/Task 4 contracts; the UI sidebar still calls `createWorkspace(name)` with one arg, which is valid since `gitAccountId` is optional.)

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/lib/api-client.ts packages/ui/src/services/workspace-service.ts packages/ui/src/store/app.ts
git commit -m "feat(ui): deleteWorkspace/deleteProject actions + client-local state cleanup"
```

---

### Task 6: UI — reusable `ConfirmDialog`

**Files:**
- Create: `packages/ui/src/components/ui/confirm-dialog.tsx`
- Modify: `packages/ui/src/components/ui/index.ts` (export it)

**Interfaces:**
- Consumes: `Modal`, `Button`, `Input` (`../ui`); the AuthModal layout (`AuthModal.tsx:34-78`) as the icon-header + outline-Cancel + colored-confirm template.
- Produces: `ConfirmDialog` — a confirm modal with an optional **typed-name gate** (`confirmText`: the confirm button stays disabled until the user types it exactly). Red confirm button via `className`.

- [ ] **Step 1: Create the component** — write `packages/ui/src/components/ui/confirm-dialog.tsx`. It mirrors the AuthModal layout (portal `Modal`, icon header, body text, outline Cancel + a colored confirm). When `confirmText` is set, it renders an `Input` and disables the confirm button until the typed value matches exactly (workspace delete); when absent, it's a plain confirm (project delete). The confirm button borrows the red from `context-menu.tsx:63`:

```tsx
import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Input, Modal } from ".";
import { cn } from "../../lib/cn";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body message (string or rich node). */
  message: React.ReactNode;
  confirmLabel?: string;
  /** When set, the confirm button is disabled until the user types this exactly. */
  confirmText?: string;
  /** Styles the confirm button + header icon as destructive (default true). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog built on Modal (no confirm primitive exists). Optional
 * `confirmText` adds a typed-name gate for irreversible actions (e.g. deleting
 * a workspace, which rm -rf's all its projects). Layout mirrors AuthModal.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = "Delete",
  confirmText,
  danger = true,
  onConfirm,
  onCancel
}) => {
  const [typed, setTyped] = useState("");

  // Reset the typed gate whenever the dialog (re)opens.
  React.useEffect(() => {
    if (open) {
      setTyped("");
    }
  }, [open]);

  const gateOk = !confirmText || typed === confirmText;

  const confirm = () => {
    if (gateOk) {
      onConfirm();
    }
  };

  return (
    <Modal open={open} onClose={onCancel} className="max-w-sm">
      <div className="w-full p-5">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md",
              danger ? "bg-red-500/10 text-red-400" : "bg-neutral-800 text-neutral-300"
            )}
          >
            <AlertTriangle size={16} />
          </span>
          <p className="text-sm font-medium text-neutral-100">{title}</p>
        </div>

        <div className="text-sm text-neutral-400">{message}</div>

        {confirmText && (
          <Input
            autoFocus
            className="mt-3"
            placeholder={confirmText}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                confirm();
              }
            }}
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!gateOk}
            onClick={confirm}
            className={cn(
              danger && "bg-red-600 text-white hover:bg-red-500",
              danger && "disabled:bg-red-600/40 disabled:text-white/70"
            )}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
```

> `Input` forwards `className` (it spreads props), so `className="mt-3"` is honored; `Button` merges `className` last (`button.tsx:33`), so the red overrides the default variant. Importing from `"."` (the barrel) is safe — the barrel re-exports `Button`/`Input`/`Modal`, and `confirm-dialog` is itself only re-exported (no import cycle at module-eval time).

- [ ] **Step 2: Export from the UI barrel** — add to `packages/ui/src/components/ui/index.ts` (after the `ContextMenu` export, line 16):

```ts
export { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS. The component compiles and is exported; nothing imports it yet (Task 7 does), so no other file changes.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/ui/confirm-dialog.tsx packages/ui/src/components/ui/index.ts
git commit -m "feat(ui): reusable ConfirmDialog with optional typed-name gate"
```

---

### Task 7: UI — sidebar delete context menus

**Files:**
- Modify: `packages/ui/src/components/sidebar/WorkspaceList.tsx` (row `<button>` ~line 48-59; add menu + dialog state)
- Modify: `packages/ui/src/components/sidebar/ProjectList.tsx` (row `<button>` ~line 68-83; add menu + dialog state)

**Interfaces:**
- Consumes: `ContextMenu`/`ContextMenuItem` + `ConfirmDialog` (`../ui`); `useAppStore` (`deleteWorkspace`/`deleteProject`); `WorkspaceSummary`/`ProjectSummary` (`../../types`). Mirrors the `TabStrip` context-menu pattern (`TabStrip.tsx:54,104-107,165-167`).
- Produces: right-click on a workspace/project row → `ContextMenu` with a `danger:true` "Delete" item → `ConfirmDialog`. Workspace delete uses the typed-name gate; project delete is a simple confirm. No exported API change.

- [ ] **Step 1: Rewrite `WorkspaceList.tsx`** — add `onContextMenu` to the row button, a `menu` state (cursor + target workspace) and a `pendingDelete` state (the workspace to confirm). The dialog passes `confirmText={pendingDelete.name}` so the user must type the workspace name:

```tsx
import React, { useState } from "react";
import { Folder, FolderPlus, PanelLeftClose, Trash2 } from "lucide-react";
import { ConfirmDialog, ContextMenu, IconButton, type ContextMenuItem } from "../ui";
import { NewItemInput } from "./NewItemInput";
import { useAppStore } from "../../store/app";
import type { WorkspaceSummary } from "../../types";

/** Root sidebar view: the list of workspace folders. */
export const WorkspaceList: React.FC = () => {
  const workspaces = useAppStore((s) => s.workspaces);
  const loading = useAppStore((s) => s.workspacesLoading);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; workspace: WorkspaceSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null);

  const menuItems = (workspace: WorkspaceSummary): ContextMenuItem[] => [
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(workspace)
    }
  ];

  return (
    <>
      <div className="flex h-9 items-center gap-1 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Workspaces
        </span>
        <IconButton label="New workspace" onClick={() => setCreating(true)}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {creating && (
          <NewItemInput
            placeholder="workspace-name"
            onCancel={() => setCreating(false)}
            onSubmit={(name) => {
              setCreating(false);
              void createWorkspace(name);
            }}
          />
        )}

        {loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && workspaces.length === 0 && !creating && (
          <p className="px-2 py-2 text-xs text-neutral-600">No workspaces yet</p>
        )}
        {workspaces.map((workspace) => (
          <button
            key={workspace.path}
            type="button"
            onClick={() => void openWorkspace(workspace.name)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, workspace });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <Folder size={15} className="text-neutral-500" />
            <span className="flex-1 truncate">{workspace.name}</span>
            <span className="text-xs text-neutral-600">{workspace.projectCount}</span>
          </button>
        ))}
      </nav>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.workspace)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete workspace"
        confirmText={pendingDelete?.name}
        message={
          <>
            This permanently deletes <span className="font-medium text-neutral-200">{pendingDelete?.name}</span>{" "}
            and all of its projects from disk. This cannot be undone. Type the workspace name to confirm.
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const name = pendingDelete?.name;
          setPendingDelete(null);
          if (name) {
            void deleteWorkspace(name);
          }
        }}
      />
    </>
  );
};
```

- [ ] **Step 2: Rewrite `ProjectList.tsx`** — same pattern, but the dialog has **no** `confirmText` (simple confirm):

```tsx
import React, { useState } from "react";
import { Box, ChevronLeft, FolderPlus, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  ConfirmDialog,
  ContextMenu,
  Dropdown,
  DropdownItem,
  IconButton,
  type ContextMenuItem
} from "../ui";
import { NewItemInput } from "./NewItemInput";
import { useAppStore } from "../../store/app";
import type { ProjectSummary } from "../../types";

/** Sidebar view shown after entering a workspace: its projects. */
export const ProjectList: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const currentProject = useAppStore((s) => s.currentProject);
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.projectsLoading);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const openProject = useAppStore((s) => s.openProject);
  const createProject = useAppStore((s) => s.createProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [creating, setCreating] = useState<null | "project" | "folder">(null);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectSummary } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);

  const menuItems = (project: ProjectSummary): ContextMenuItem[] => [
    {
      label: "Delete",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => setPendingDelete(project)
    }
  ];

  return (
    <>
      <div className="flex h-9 items-center gap-0.5 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <IconButton label="Back to workspaces" onClick={closeWorkspace}>
          <ChevronLeft size={16} />
        </IconButton>
        <span className="flex-1 truncate text-sm font-medium text-neutral-100">
          {currentWorkspace}
        </span>
        <Dropdown
          trigger={
            <IconButton label="New">
              <Plus size={16} />
            </IconButton>
          }
          align="right"
          width="w-44"
        >
          <DropdownItem icon={<Box size={14} />} onClick={() => setCreating("project")}>
            New Project
          </DropdownItem>
          <DropdownItem icon={<FolderPlus size={14} />} onClick={() => setCreating("folder")}>
            New Folder
          </DropdownItem>
        </Dropdown>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {creating && (
          <NewItemInput
            placeholder={creating === "folder" ? "folder-name" : "project-name"}
            onCancel={() => setCreating(null)}
            onSubmit={(name) => {
              setCreating(null);
              void createProject(name);
            }}
          />
        )}

        {loading && projects.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && projects.length === 0 && !creating && (
          <p className="px-2 py-2 text-xs text-neutral-600">No projects yet</p>
        )}
        {projects.map((project) => (
          <button
            key={project.path}
            type="button"
            onClick={() => openProject(project)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, project });
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              project.path === currentProject?.path
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
            )}
          >
            <Box size={15} className="text-neutral-500" />
            <span className="flex-1 truncate">{project.name}</span>
          </button>
        ))}
      </nav>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.project)}
          onClose={() => setMenu(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete project"
        message={
          <>
            This permanently deletes <span className="font-medium text-neutral-200">{pendingDelete?.name}</span>{" "}
            and its contents from disk. This cannot be undone.
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const project = pendingDelete;
          setPendingDelete(null);
          if (project) {
            void deleteProject(project);
          }
        }}
      />
    </>
  );
};
```

- [ ] **Step 3: Verify the barrel exports** — confirm the named imports resolve:

Run: `grep -nE "ConfirmDialog|ContextMenu|IconButton" packages/ui/src/components/ui/index.ts`
Expected: shows `ConfirmDialog`, `ContextMenu` (+ `ContextMenuItem`), and `IconButton` exports — so `import { ConfirmDialog, ContextMenu, IconButton, type ContextMenuItem } from "../ui"` is valid.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS across the whole workspace (config, api, daemon, ui all clean).

- [ ] **Step 5: Runtime verify in the browser** (Playwright via system Chrome against the running web app, or manual)

Drive:
1. Create a workspace `pw-ws` and, inside it, a project `pw-proj` (sidebar `+`).
2. **Project delete (simple confirm):** right-click the `pw-proj` row → "Delete" → the ConfirmDialog appears with no text field → click "Delete" → the row disappears and the project dir is gone on disk (`ls ./.stage/workspaces/pw-ws`).
3. Re-enter workspaces. **Workspace delete (typed-name gate):** right-click `pw-ws` → "Delete" → the dialog shows a text input and the red "Delete" button is **disabled**; type `pw-ws` → the button **enables** → click it → the row disappears and `./.stage/workspaces/pw-ws` is gone.
4. **Open-target reset:** open `pw-ws` → open `pw-proj` (so it's the current project with a terminal tab) → delete the project via right-click; confirm the main view clears (no stale tab strip for the deleted path) and any open terminal tab vanishes (its `session.closed` arrived).
(Reuse the `/tmp/orq-driver` Playwright harness pattern from prior phases.)

Expected: right-click → confirm → row disappears for both; the workspace "Delete" button stays disabled until the exact name is typed; deleting the open project clears the main view; directories are removed on disk.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/sidebar/WorkspaceList.tsx packages/ui/src/components/sidebar/ProjectList.tsx
git commit -m "feat(ui): sidebar right-click delete for workspaces (typed gate) + projects"
```

---

## Notes for the implementer

- **Phase ordering:** This plan assumes Phases 1/2 may not have landed. The daemon source already contains the Phase 2 `order`/`rename`/`reorder`/`updated` plumbing (committed earlier), but **not** Phase 1 username auth — so curl bearers use the bare `passwordHash`. If Phase 1 merges first, swap every `Authorization: Bearer $TOKEN` for `Authorization: Bearer $(printf 'mapacho:%s' "$TOKEN" | base64)` and the WS `?token=` likewise.
- **No transient `pnpm check` failures between tasks.** Unlike the tab-reorder plan (whose Task 1 broke the build until Task 5), every task here is independently green: Task 1 only adds config exports; Task 2's API fields are optional; each consumer lands in the same task that needs the producer. `pnpm check` should PASS after **every** task.
- **Side-table file location:** dev = `./.stage/daemon/workspaces.json`; prod = `/var/lib/orquester/daemon/workspaces.json`. It is created lazily on the first `POST /api/workspaces` (via `writeJsonFile`'s `mkdir`), so a fresh daemon with no workspaces simply has no file — and `readWorkspacesMeta` falls back to empty.
- **The realpath guard is the load-bearing safety check.** `isValidName` already blocks `..`/`/`/`\`/leading-dot, but the realpath-prefix check in `resolveWithinWorkspaces` is what defends against a symlinked workspace dir or a `workspacesDir` that itself contains symlinks (spec §"Edge cases", §"Security model"). Do not remove either layer.
- **What this phase deliberately does NOT do** (deferred to Phase 4): resolve `gitAccountId` to an account object/label; any accounts store/UI; writing/removing `git config --global includeIf` rules on create/delete; promoting workspace creation to a modal with an account picker. `createWorkspace` already accepts `gitAccountId?` so Phase 4 only wires the picker.
