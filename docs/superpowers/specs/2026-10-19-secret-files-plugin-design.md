# Secret files plugin: one vault per repo, synced to every clone

Status: draft, awaiting approval.

## Intent

Some projects keep their secrets in files git ignores: `.env` files, plus
less conventional ones like Orquester's own `deploy/targets.conf`. Every new
clone of a repo starts without them, so the user copies them across by hand.
The copies then drift apart. The MatsSmile clones show both problems:

- MatsSmile3 has no `MatsSmileBack/.env` at all.
- MatsSmile's newer copy dropped `PRIVATEPROXY_API_KEY`, while MatsSmile2's
  older copy still has it.

The plugin keeps one **vault** per repo per workspace on the daemon. The vault is the
source of truth for that repo's secret files. Every clone of the repo that
appears in the sidebar gets the files and stays in sync with the vault:

- When a clone's copy changes, the user can push it to the vault, and every
  other clone then updates.
- Or the user can reset that clone back to the vault's version.

Agents can push too, but only through an approval card.

It is an optional, built-in plugin in Settings → Plugins, off by default.

## Goals (user decisions unless marked)

1. **Existing clones.** When a repo is set up, every clone that is missing a
   secret file gets a copy.
2. **New clones.** A new clone of the repo gets the vault's files
   automatically.
3. **Source of truth and drift.**
   - The vault holds the true version of each file.
   - When a clone's copy differs from the vault, the user is asked to either
     **Push to vault**, which updates every clone, or **Reset to vault**,
     which discards the clone's differences.
   - An agent that changes a secret file can push it through the Orquester
     MCP, but only after the user approves an **approval card**.
4. **File selection.**
   - Conventional secret files are included by default. The user can exclude
     any of them, e.g. `MatsSmileBack/.env.local`, which DevTools/DBTunnels
     generates.
   - The user can add unconventional files, e.g. `deploy/targets.conf`.
5. **Scope.** There is **one vault per repo per workspace**. Only the clones
   that appear in that workspace's sidebar take part, i.e. that workspace's
   projects whose `repoKey` matches. A clone of the same repo in another
   workspace has its own vault, and nothing is shared between them. Archived projects are left out, since
   the sidebar hides them (my call). Agent worktrees nested inside a project
   (`.claude/worktrees/…`) are never touched.
6. **The vault's sources.** Its contents only ever come from clones. There is
   no import from a server, no paste and no outside path.
7. **First setup.** When clones hold different copies of a file, the user
   picks which copy becomes the vault's version, using a variable-by-variable
   comparison with values hidden. The newest copy is pre-selected, because
   "newest wins" picked the wrong copy for MatsSmile. A merged version is also
   offered: the union of every clone's variables (my call).
8. **Plugin.** A built-in entry "Secret files" in Settings → Plugins, off by
   default.

## Non-goals

- Syncing outside Orquester, across machines, or between collaborators. That
  is a separate project the user parked.
- Files that git tracks in a clone. Git already shares them (my call).
- Agent worktrees, workflow temp projects, and projects with no remote origin
  (no `repoKey`).
- Importing secrets from anywhere but a clone.
- A UI to browse vault history. A few previous versions are kept on disk for
  manual recovery only (my call).
- Encryption at rest beyond file permissions. The vault lives in the daemon's
  appdir with 0600/0700 permissions, like `workflow-secrets.json`, and the
  same values already sit in plain text in every clone (my call).

## Anti-goals (would count as failure even if it works)

- Silently overwriting a clone's own edits. Only a clone whose copy still
  matches the vault version it last had is updated without asking.
- Any secret **value** leaving the daemon through:
  - an API response or event payload;
  - a log line;
  - an MCP result or approval card;
  - an error message.

  Everything shown is variable names and "added / removed / changed", or line
  counts for files that aren't KEY=VALUE.
- Writing outside a clone. This covers symlinked secret files or parent
  directories that resolve outside the clone, `..` in a path, and absolute
  paths.
- Making a file sync-managed while git tracks it. It would get committed.
- Losing the vault's last good version because a write failed.
- Noticeable load on the daemon. There are no recursive watches on project
  trees and no git processes on the hot path.

## Current code this builds on

- **Repo identity:** `ProjectSummary.repoKey` (daemon `repoKeyOf`), read
  without spawning git in `listProjects` (`apps/daemon/src/index.ts`). Repo
  groups, the "+" fresh clone, and the typed-clone git follow are in
  spec 2026-10-18.
- **Plugins:**
  - Static catalog: `apps/daemon/src/plugins/catalog.ts` (Excalidraw is the
    built-in example, `updates:false`).
  - Ids: `PLUGIN_IDS` in `packages/api/src/plugins.ts`. It is a closed union,
    and the UI drops unknown ids, so the new id must be added there.
  - Settings UI: `PluginsSettings.tsx` / `PluginDetail`.
  - UI gate: `isGlobalPluginEnabled`.
  - No plugin has daemon-side gating yet; this one subscribes to
    `plugins.events` "changed".
- **Approval cards:**
  - An admin-tier tool declares `adminFamily` and `approval(args, ctx)`. The
    executor blocks until the user answers.
  - Families live in `ADMIN_FAMILIES` (`packages/api/src/agent-chat/tool-approvals.ts`),
    grant scopes in `packages/config/src/agent-tools.ts`, and family text in
    `banner-model.ts`.
  - Best template: `set_workflow_secret` (`apps/daemon/src/mcp/tools/workflows.ts`).
- **MCP tools** reach the daemon only through `DaemonApi`, which calls
  in-process routes. Adding a tool also means updating:
  - the catalog `buildCatalog`;
  - `TOOLSETS`;
  - the tool counts in `registry.test.ts`;
  - `docs/orquester-mcp.md`.
- **Host-only secret store pattern:** `apps/daemon/src/workflows/secrets.ts`
  (0600 atomic writes, move-aside on corruption, names only on the wire).
- **File watching pattern:** targeted `fs.watch` with debounce and re-arm, in
  `apps/daemon/src/agent-profile/service.ts`.
- **Project creation:** `POST /api/workspaces/:ws/projects`, server clone at
  `index.ts:~2281-2314`. No event is published on create.

## Design

### 1. Plugin

- **Contract:** add `SECRET_FILES_PLUGIN_ID = "secret-files"` to `PLUGIN_IDS`.
- **Catalog:** a built-in entry, `scope:"global"`, `updates:false`, off by
  default. Description: "Keep each repo's secret files (.env and others) in one
  vault and synced to every clone."
- **Detail panel:** a one-line explanation and the list of repos that have a
  vault set up, each with its sync status and a link that opens that repo's
  "Secret files…" dialog.
- **Off:**
  - every watcher stops;
  - all UI entry points hide;
  - routes other than reads answer 409 `SECRET_FILES_DISABLED`;
  - no clone file is touched;
  - vaults are kept.
- **On:** a full reconcile pass runs (§5).

### 2. What counts as a secret file

Paths are **relative to the clone root**, use `/` separators, contain no
`..`, and are not absolute.

**Conventional candidates.** Any file whose name is `.env` or starts with
`.env.`, at any depth, that git **ignores**.
- Names ending `.example`, `.sample`, `.template`, `.dist` or `.defaults` are
  excluded.
- **How they're found:** run `git ls-files --others --ignored --exclude-standard`
  with pathspecs `:(glob)**/.env` and `:(glob)**/.env.*`, in each clone.
  - Git does not descend into nested repositories or worktrees, so
    `.claude/worktrees` stays out on its own. Also skip `node_modules`
    explicitly as a safety net.
  - The scan only runs when the dialog opens, on a reconcile pass, and when a
    new clone appears. It never runs per change.

**Per-repo selection** is stored in the vault:
- `files`: the managed paths.
- `excluded`: candidate paths the user turned off. These are never suggested
  again. `.env.local` goes here.
- Paths the user added by hand (`deploy/targets.conf`) become ordinary
  `files` entries.

**New candidates.** A candidate that turns up later in any clone (e.g. a new
`.env.staging`) is neither managed nor excluded. It is shown in the dialog,
and counted on the repo header, as "1 new secret file found", with Add /
Ignore. It never syncs until the user adds it (my call; this keeps the user in
control of what spreads).

**Refusals.** A managed path is refused for a given clone when:
- git **tracks** it in that clone (flagged "tracked by git, not synced");
- it is a symlink, or it resolves outside the clone after realpath;
- it is a directory;
- it is larger than 1 MiB.

Other limits: at most 50 managed files per repo.

### 3. The vault

**Storage:** `<appdir>/daemon/secret-files/` (dir 0700), via path helpers in
`packages/config`.
- `vaults.json` (0600) is a tolerant schema in `packages/config`: unknown
  fields and rejected records are kept, a broken outer shape moves the file
  aside, and an unreadable file blocks writes with 503. It holds, per
  **vault id = (workspace, repoKey)**:
  - `files[]` and `excluded[]`;
  - per file: `{ path, version (sha256 of content), updatedAt, updatedBy: { kind:"user"|"agent", threadId?, clonePath } }`;
  - `clones`: per project path, per file, the `baseline` version, meaning the
    vault version that clone last received or pushed.
- **Content** is stored as blobs `blobs/<sha256>` (0600), written
  atomically before the record that points at them.
  - The last 10 versions per file are kept. Unreferenced blobs are swept on
    load, with the same caution as repo icons: never while a moved-aside index
    exists.

**What crosses the wire** (routes, events, MCP): paths, versions (hashes),
timestamps, and states. **Never content.**

**Compare views** are computed on the daemon:
- **KEY=VALUE files** (parsed like dotenv: `export ` prefix, quotes, `#`
  comments): a list of keys, each marked `added | removed | changed | same`.
- **Any other file:** `{ linesAdded, linesRemoved }` and nothing more.

### 4. Clone states

For each managed file in each clone, compare the clone's content hash to the
vault version and to that clone's `baseline`:

| Clone file | State | Automatic action |
|---|---|---|
| hash = vault version | `synced` | none |
| missing, never had a baseline | `missing` | **copy** from the vault (goal 1), only when the parent directory exists; otherwise `missing-dir`, flagged, nothing created (my call) |
| missing, had a baseline (deleted in the clone) | `deleted` | none: flagged. **Reset** restores it. A deletion is never pushed to other clones (my call) |
| hash = baseline, vault moved on | `outdated` | **update** from the vault |
| hash ≠ baseline and ≠ vault | `modified` | none: flagged, user decides (Push / Reset / Compare) |
| no baseline yet (first setup), hash ≠ vault | `modified` | none: flagged |
| tracked / symlink / too large | `refused` | none: flagged with the reason |

**Writes:**
- Each write is atomic (temp file in the same directory, then rename). It
  keeps the existing file's mode, or uses 0600 for a new file.
- After a write the baseline becomes the vault version.
- **Push** (clone → vault):
  1. A new vault version is created from that clone's content, and that
     clone's baseline is set to it.
  2. Every `synced` or `outdated` clone of the repo is updated.
  3. Any other `modified` clone stays flagged and is now compared against the
     new version. A second push therefore never silently drops the first one.
- **Reset** (vault → clone) overwrites that clone's file and sets its
  baseline.

### 5. Noticing changes and new clones

**Watchers.** For every enabled repo, each clone gets one `fs.watch` per
**directory** that contains a managed file, plus the clone root. Directory
watches survive atomic replaces; events are filtered to managed names.
- Changes are debounced (500 ms), then that clone's files are re-hashed.
- Watchers are re-armed when they error, following the agent-profile pattern.
- There are never recursive watches.

**Reconcile pass.** It re-lists every workspace's projects in-process, using
the same `listProjects` logic exported for reuse, then checks every enabled
repo's clones and applies the automatic actions in §4. It runs:
- on daemon start;
- when the plugin is enabled;
- when a repo is set up;
- on every `GET /api/workspaces/:ws/projects` (debounced). The UI already
  reloads the list after a clone lands, so typed clones are picked up too.
- every 5 minutes as a safety net (my call), which also covers clones made by
  hand in a terminal.

**Server clones.** The create route calls the service right after a
successful clone or create, so a "+" clone gets its files before the response
returns.

**Removed clones** drop out of `clones` on the next pass.

**Events.** State changes are published on a `secret-files` channel as a
per-repo summary: clone path, file path and state. No content.

### 6. First setup (the "Secret files…" dialog)

The dialog opens from a repo group's ⋯ menu. It appears only when the plugin
is on and the group has a `repoKey`.

1. **Files.** The detected candidates are listed with checkboxes, all ticked
   by default. Next to each candidate the dialog shows which clones have it.
   An "Add file…" field takes extra paths, validated per §2.
2. **Source per file.** For each selected file whose copies differ across
   clones, the dialog shows the copies side by side, as a variable-by-variable
   comparison (§3) with modification times.
   - The newest copy is pre-selected.
   - "Merge all" builds the union of keys from every copy. Where a key's value
     differs, the selected copy's value wins.
   - Files found in only one clone, or with identical copies, need no choice.
3. **Set up.**
   - The vault is created.
   - Clones `missing` a file get it.
   - Clones whose copy differs from the chosen version are `modified`: they
     are flagged, not overwritten (goal 3).

**Afterwards** the same dialog shows:
- the file list, editable: add, exclude, or stop managing a file (the vault's
  copy is kept in history);
- every clone's per-file state, with Push / Reset / Compare;
- "Delete vault", behind a confirmation. Clone files are left as they are.

### 7. Where drift shows

- **Project row:** a small key badge, amber when any file is `modified`,
  `missing-dir` or `refused`. The tooltip names the files.
- **Repo group header:** a count of clones that need attention.
- **Project bar:** when the open project has `modified` files, a slim bar
  sits at the top of the main view: "`MatsSmileBack/.env` differs from the
  vault: 1 added, 2 changed", with **Push to vault**, **Reset to vault** and
  **Compare**.
  - Dismissing it hides it until the file changes again.
  - It's a new component at the top of `MainView`; there's no existing
    project bar.
- **Compare:** a modal showing the §3 key or line summary between this clone
  and the vault. Values are never shown. The user can open the real file in
  the file viewer, as today.

### 8. Agents (MCP)

**Audiences (my call):**
- `secret_files_status` is offered to both in-chat agents and external MCP
  clients. External clients name the project explicitly.
- `push_secret_files` is **chat-only**: an external client has no "own
  project" and never sees a card.

**`secret_files_status`** (read).
- **Input:** a project (default: the chat's own).
- **Output:** the repo's managed files and every clone's per-file state.
- **For the caller's own project** it adds a key-level compare against the
  vault. Names only.

**`push_secret_files`** (admin tier).
- **Input:** `{ files?: string[] }`. Defaults to every `modified` file in the
  chat's **own** project. No other project is allowed.
- **Card:** new `adminFamily: "secret-files"`. The card names:
  - the repo;
  - the source clone;
  - each file with its added/removed/changed keys (names only);
  - the other clones in the same workspace that will be updated.
- **Grants:** none (`AGENT_TOOL_GRANT_SCOPES` = `[]`), so it is always a card.
- **On approval:** the same push as the UI's, with `updatedBy` set to the
  agent's thread.
- **Wiring:** `ADMIN_FAMILIES`, grant scopes, banner family text, `TOOLSETS`
  entry, catalog registration, `registry.test.ts` counts, and
  `docs/orquester-mcp.md`.

Agents get no reset tool. An agent that wants to undo its own edit rewrites
the file, or asks the user (my call).

### 9. Routes (contracts in `packages/api` first)

Names are indicative; all are on the authenticated remote transport like the
other `/api` routes. Every vault-specific route identifies the vault by
**`workspace` + `repoKey`**, passed as query values or body fields, not path
segments. `workspace` is validated with `isValidName`, and `repoKey` with
`repoKeyProblem`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/secret-files` | Summary for every vault: workspace, repoKey, file count, clones needing attention. |
| GET | `/api/secret-files/repo?workspace=&repoKey=` | Files, excluded, new candidates, per-clone per-file states. |
| GET | `/api/secret-files/candidates?workspace=&repoKey=` | Setup scan: candidates per clone, with per-file variable-level compares across clones. |
| POST | `/api/secret-files/setup` | `{ workspace, repoKey, files: [{ path, source: { clonePath } \| { merge: true, primary: clonePath } }], excluded }` |
| PUT | `/api/secret-files/files` | `{ workspace, repoKey, add?, exclude?, unmanage? }` |
| POST | `/api/secret-files/push` | `{ workspace, repoKey, clonePath, files? }` |
| POST | `/api/secret-files/reset` | `{ workspace, repoKey, clonePath, files? }` |
| GET | `/api/secret-files/compare?workspace=&repoKey=&clonePath=&file=` | Key or line summary. |
| DELETE | `/api/secret-files/repo?workspace=&repoKey=` | Delete the vault. |

**`clonePath`** must be a listed, non-archived project of that workspace and
repo after realpath; any other path answers 400.

**Errors** are `{ code, message }`, and a message never quotes file content.

## Constraints (AGENTS.md)

- Contracts go in `packages/api` first; persisted schemas and path helpers go
  in `packages/config`.
- Persisted records written by other app versions are tolerated: unknown
  fields are kept, and corruption moves the file aside.
- Secrets stay on the daemon and out of responses and logs. Fixtures and tests
  use fake values.
- File paths stay inside their clone after realpath.
- MCP tools go through `DaemonApi`, with no dynamic `import()` under
  agent-host.
- No sleep-based tests. Watchers and timers are injectable and driven by hand
  in tests.
- Shared UI changes are checked in both desktop and web, including the narrow
  mobile drawer.

## Tests (minimum)

- **Config:** vault index parser round-trips, keeps unknown fields and
  rejected records, and throws on a bad shape.
- **Daemon:**
  - the candidate scan (ignored vs tracked, excluded suffixes, nested
    worktrees skipped);
  - path refusal (`..`, absolute, symlink file, symlinked parent directory,
    too large);
  - the state table in §4, every row;
  - push propagation: `outdated` clones update and `modified` ones stay
    flagged;
  - a second divergent push;
  - reset;
  - setup with a chosen source and with merge;
  - `missing-dir`;
  - atomic writes keep the file mode;
  - plugin off makes writes refused and nothing touched;
  - reconcile on a list call and on a server clone;
  - watcher debounce driven by hand;
  - no route, event or MCP result ever contains a test secret value (assert
    on serialized output).
- **MCP:** status output has no values; the push card preview has no values
  and lists keys, and approve/deny is honoured; push is refused for another
  project; registry counts.
- **UI:** plugin gating hides the entry points; dialog setup flow; badge,
  header count and bar rendering from states; compare modal.

## Calls I made (not decided by the user)

- **Committed files:** files git tracks are never managed, and are flagged
  if selected.
- **New candidates:** a new conventional file found later is suggested,
  never auto-synced.
- **Missing directory:** a clone missing a file's parent directory is
  flagged, and no directories are created.
- **Storage:** the vault is plain files with 0600/0700 permissions in the
  appdir, keeping the last 10 versions per file, with no history UI.
- **Watching and reconcile:** watches are per directory, never recursive,
  plus a reconcile on list calls and every 5 minutes.
- **Values never shown:** no API returns secret values. Compare shows key
  names or line counts only; to see values, open the real file.
- **Agent tools:** agents get `secret_files_status` and a card-gated
  `push_secret_files` for their own project only. There is no agent reset,
  and no "always allow" grant.
- **Merge option:** at setup, "merge all" takes the union of keys, and the
  selected copy wins where a key's value differs.
- **Turning it off:** turning the plugin off, or deleting a vault, never
  touches clone files.

## Left to the builder

- Exact route and component names within the shapes above.
- The dotenv parser details (multi-line quoted values may be compared as one
  value).
- Visual details of the badge, bar and dialog, matching the existing sidebar
  and settings styles.
