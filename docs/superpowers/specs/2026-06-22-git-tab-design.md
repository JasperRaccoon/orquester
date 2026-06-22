# Git tab — design & implementation spec

**Status:** approved (2026-06-22) · **Branch:** `feat/git-tab`

A new project tab type, **Git**, that looks and behaves like GitHub Desktop's repository
view: a **Changes** tab (changed-files list + diffs + commit box) and a **History** tab
(commit log + per-commit files & diffs), with a repo header (current branch, ahead/behind,
last-fetched) and **Fetch / Pull / Push** + branch switching.

This document is the source of truth for the implementation. It is written to be read by
implementation agents with **no other context** — follow it exactly. Where it gives exact
type definitions, props, or git commands, reproduce them verbatim (adjust only to make
`pnpm check` pass).

---

## 1. Scope

- **In:** Viewer (Changes + History + diffs) · Commit (stage/unstage/commit/discard) ·
  Sync (fetch/pull/push + switch branch). Scoped to **the current project's repo** (no repo
  picker — the tab follows the project it lives in).
- **Out (v1):** split/side-by-side diff, syntax-highlighted diffs, merge-conflict resolution
  UI, stash, rebase/amend, submodules/worktrees, repo picker, `git init` button (show a
  plain "not a git repository" message instead).

## 2. Architecture — follow the File Browser precedent exactly

The Git tab is a **client-local tab** (like the File Browser): **no daemon PTY/session, no
registry entry**. It is a new `ProjectTab` variant (`type: "git"`) that renders a new
`<GitView>` component. Data comes from new **stateless `/api/git/*`** routes on the daemon
that shell out to the system `git` binary (using the existing `execFile` pattern from
`apps/daemon/src/accounts.ts` — **no new npm dependency**).

Key precedent files to imitate:
- Client-local tab plumbing: `packages/ui/src/store/app.ts` (the `FileTab` / `openFileBrowser`
  machinery).
- Daemon route + path-sandbox pattern: `apps/daemon/src/index.ts` (the `/api/fs/*` routes,
  `assertInsideFsRoot`).
- Subprocess + identity pattern: `apps/daemon/src/accounts.ts` (`run = promisify(execFile)`,
  HOME pinning, error `.stderr` capture, `AccountError`).
- Component conventions/styling: `packages/ui/src/components/files/FileBrowser.tsx` (Tailwind
  classes, `useApi()`, neutral-* palette, `h-9` toolbars, `border-neutral-800`, etc.).

**Identity for fetch/push:** the daemon already writes a per-workspace git `includeIf` rule
that sets `user.*` **and** `core.sshCommand` (see `accounts.ts` `bindWorkspace`). Running git
with `cwd` = the project dir and `HOME` pinned therefore uses the bound account's identity and
SSH key automatically. `GitService` only needs to pin `HOME` (exactly like `AccountsService`);
it does **not** depend on `AccountsService`. When no account is bound, ambient git config is
used.

**Transport policy:** `/api/git/*` is allowed on **both** transports (local socket + remote
HTTP), exactly like `/api/accounts` — the bearer-auth hook already guards `/api/*` on the
remote transport, and no secret is ever returned. Do **not** add a `mode === "remote"` guard.

---

## 3. Wire types — `packages/api/src/index.ts`

Add this block (place it after the `Fs*` interfaces, ~line 167). These names are the contract
used by the daemon, the api-client, and the components.

```ts
// Git — a project's git repo surfaced as a GitHub-Desktop-style tab. Stateless;
// the daemon shells out to `git` in the project dir (no PTY/session).

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

/** A changed file in the working tree / index. A file may be both staged and unstaged. */
export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  /** Present in the index (will be committed). */
  staged: boolean;
  /** Has working-tree changes not yet staged. */
  unstaged: boolean;
  /** Original path for renames/copies. */
  oldPath?: string;
}

export interface GitStatusResponse {
  isRepo: boolean;
  /** Current branch name; null when detached or no commits yet. */
  branch: string | null;
  detached: boolean;
  /** Upstream ref, e.g. "origin/main"; null when none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** ISO timestamp from .git/FETCH_HEAD mtime, or null if never fetched. */
  lastFetched: string | null;
  files: GitFileChange[];
}

export interface GitDiffResponse {
  /** Raw unified diff text (git diff / git show output, --no-color). Empty when no diff. */
  diff: string;
  binary: boolean;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO author date. */
  date: string;
  /** Decorations: branch/tag names on this commit, e.g. ["main", "origin/main", "v1.2"]. */
  refs: string[];
}

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: GitCommitFile[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
}

export interface GitBranchesResponse {
  current: string | null;
  local: GitBranch[];
  /** Remote-tracking branch names, e.g. ["origin/main", "origin/dev"]. */
  remote: string[];
}

export interface GitCommitRequest {
  path: string;
  summary: string;
  description?: string;
}

/** Generic result for git mutations (stage/unstage/commit/discard/fetch/pull/push/checkout). */
export interface GitOpResult {
  ok: true;
  /** Combined stdout/stderr of the op (shown for fetch/pull/push), trimmed. */
  output?: string;
}
```

---

## 4. Daemon — `apps/daemon/src/git.ts` (new file)

Create a `GitService` class mirroring `AccountsService`'s shape and conventions.

```ts
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
const run = promisify(execFile);
```

- **`GitError extends Error`** with a `status: number` (mirror `AccountError` in
  `accounts.ts:23-31`).
- Pin **`HOME`**: `private readonly home = process.env.HOME ?? homedir()` (mirror
  `accounts.ts:50`).
- Core runner: `private async exec(cwd: string, args: string[], opts?: { timeout?: number; allowFail?: boolean }): Promise<{ stdout: string; stderr: string; code: number }>`
  - `run("git", args, { cwd, env: { ...process.env, HOME: this.home }, maxBuffer: 64 * 1024 * 1024, timeout: opts?.timeout })`.
  - On rejection, the error object carries `.stdout`/`.stderr`/`.code` (see
    `accounts.ts:252-255`). If `opts.allowFail`, resolve with those instead of throwing
    (needed for `git diff --no-index`, which exits 1 when a diff exists). Otherwise throw
    `new GitError(500, errText)` where `errText` prefers `.stderr` (mirror
    `accounts.ts:495-500`).
  - Remote ops (fetch/pull/push) additionally set env `GIT_TERMINAL_PROMPT: "0"` (never hang
    on a credential prompt) and pass `timeout: 60_000`.

**Methods** (all take an absolute, already-sandbox-validated `cwd` = the project dir). Commands
use `--no-color` and arg arrays (no shell). The implementing agent MUST validate parsing by
running these commands against this repo before finishing.

- `isRepo(cwd): Promise<boolean>` — `git rev-parse --is-inside-work-tree` (allowFail; true iff
  stdout trims to "true").
- `status(cwd): Promise<GitStatusResponse>`:
  - If not a repo → return `{ isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, lastFetched: null, files: [] }`.
  - `git status --porcelain=v2 --branch -z`. Parse:
    - Header lines: `# branch.head <name>` (name `(detached)` ⇒ `detached:true, branch:null`),
      `# branch.upstream <up>`, `# branch.ab +<a> -<b>` (absent ⇒ ahead/behind 0).
    - Entry records (NUL-separated): `1 <XY> …  <path>` (ordinary), `2 <XY> … <path>` **followed
      by a separate NUL field = original path** (rename/copy — consume the next field),
      `u <xy> … <path>` (unmerged ⇒ conflicted), `? <path>` (untracked). `XY`: index status X,
      worktree status Y. `staged = X !== '.'`, `unstaged = Y !== '.'`. Map letters to
      `GitFileStatus`: any side `U` (or `u` record) ⇒ conflicted; `R` ⇒ renamed; `C` ⇒ copied;
      `A` ⇒ added; `D` ⇒ deleted; `T` ⇒ typechange; `M` ⇒ modified; `?` ⇒ untracked.
    - `lastFetched`: `stat(join(cwd, ".git", "FETCH_HEAD")).mtime.toISOString()`; null on error.
- `diff(cwd, file, opts: { staged?: boolean; commit?: string }): Promise<GitDiffResponse>`:
  - commit set ⇒ `git show --no-color --format= <commit> -- <file>`.
  - staged ⇒ `git diff --no-color --staged -- <file>`.
  - else ⇒ `git diff --no-color -- <file>`; **if that output is empty**, the file is likely
    untracked ⇒ `git diff --no-color --no-index -- <NULL> <file>` (allowFail; `<NULL>` =
    `process.platform === "win32" ? "NUL" : "/dev/null"`).
  - `binary: /^Binary files .* differ$/m.test(diff)` (also true when git prints
    "GIT binary patch").
- `log(cwd, opts: { skip?: number; limit?: number }): Promise<GitLogEntry[]>`:
  - `git log --no-color -z --pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b --skip=<skip> -n <limit||50>`
    (allowFail — a repo with no commits returns nothing). Split records on `\0`, fields on
    `\x1f`. `refs` = `%D` split on `", "`, each trimmed, stripping a leading `HEAD -> `
    and `tag: ` prefix; drop empties.
- `commitDetail(cwd, sha): Promise<GitCommitDetail>`:
  - meta: `git show -s --no-color --format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b <sha>`.
  - files: `git show --no-color --numstat --format= <sha>` ⇒ lines `<add>\t<del>\t<path>`
    (`-`/`-` ⇒ binary). Get status letters from `git show --no-color --name-status --format= <sha>`
    (lines `<X>\t<path>` or `R<score>\t<old>\t<new>`), merge by path. Map letters as in
    `status`. For renames the numstat path may be `old => new` / `a/{b => c}/d` — prefer the
    name-status pair for `path`/`oldPath` and match numstat by the new path.
- `branches(cwd): Promise<GitBranchesResponse>`:
  - local: `git for-each-ref --format=%(refname:short)%x1f%(upstream:short)%x1f%(HEAD) refs/heads`
    (the `%(HEAD)` field is `*` for current). remote:
    `git for-each-ref --format=%(refname:short) refs/remotes` (drop any ending in `/HEAD`).
    `current` = the local branch whose HEAD field is `*` (or null).
- `stage(cwd, files: string[]): GitOpResult` — `git add -- <…files>` (if `files` empty ⇒
  `git add -A`).
- `unstage(cwd, files: string[]): GitOpResult` — `git restore --staged -- <…files>` (empty ⇒
  `git reset -q HEAD --`). 
- `commit(cwd, summary, description?): GitOpResult` — reject `GitError(400, …)` if summary is
  blank. `git commit -m <summary>` and, when description is non-empty, an extra `-m <description>`.
  Relies on the ambient/includeIf identity (do not pass author flags).
- `discard(cwd, files: string[]): GitOpResult` — for tracked files: `git restore -- <…files>`;
  for untracked: `git clean -fd -- <…files>`. (The route receives `files` already classified,
  or call both best-effort — restore tracked then clean leftovers. Keep it simple and
  best-effort; this is destructive and gated by a client confirm.)
- `fetch(cwd): GitOpResult` — `git fetch --all --prune` (remote-op env + timeout); return
  trimmed combined output.
- `pull(cwd): GitOpResult` — `git pull --no-edit` (remote-op env + timeout).
- `push(cwd): GitOpResult` — `git push` (remote-op env + timeout). On the "no upstream" error,
  surface the git stderr message (do not auto-set upstream in v1).
- `checkout(cwd, branch): GitOpResult` — `git checkout <branch>`.

Validate `branch`/file inputs defensively (they are arg-array params, not shell, so injection
isn't the risk — but reject empty branch with `GitError(400)`).

---

## 5. Daemon — routes & wiring in `apps/daemon/src/index.ts`

1. **Import** (top, ~line 34, next to the accounts import):
   `import { GitError, GitService } from "./git";`
2. **`Services` interface** (~line 288): add `git: GitService;`.
3. **Construct** (~line 173, after `accounts`): `const git = new GitService();` and add `git`
   to the `services` object literal (~line 207).
4. **Routes** — register next to the `/api/fs/*` block (after ~line 898). Every route resolves
   and sandboxes the project path the same way the fs routes do:
   `const safe = await assertInsideFsRoot(resolved.fsRoot, path)` and uses `safe` as the git
   `cwd`. Wrap handlers in try/catch mapping `GitError.status` (else 500) to
   `reply.code(status).send({ code: "GIT_ERROR", message })`, and `FsSandboxError` → 403
   (mirror the fs routes). `path` (and `sha`/`file`/`branch`) come from querystring (GET) or
   body (POST). Reject missing `path` with 400.

   | Method | Path | Input | Returns |
   |---|---|---|---|
   | GET | `/api/git/status` | `?path` | `GitStatusResponse` |
   | GET | `/api/git/diff` | `?path&file&staged?&commit?` | `GitDiffResponse` |
   | GET | `/api/git/log` | `?path&skip?&limit?` | `GitLogEntry[]` |
   | GET | `/api/git/commit` | `?path&sha` | `GitCommitDetail` |
   | GET | `/api/git/branches` | `?path` | `GitBranchesResponse` |
   | POST | `/api/git/stage` | `{path, files}` | `GitOpResult` |
   | POST | `/api/git/unstage` | `{path, files}` | `GitOpResult` |
   | POST | `/api/git/commit` | `{path, summary, description?}` | `GitOpResult` |
   | POST | `/api/git/discard` | `{path, files}` | `GitOpResult` |
   | POST | `/api/git/fetch` | `{path}` | `GitOpResult` |
   | POST | `/api/git/pull` | `{path}` | `GitOpResult` |
   | POST | `/api/git/push` | `{path}` | `GitOpResult` |
   | POST | `/api/git/checkout` | `{path, branch}` | `GitOpResult` |

   `staged` arrives as the string `"true"`; coerce. `GET /api/git/status` must **not** error on
   a non-git directory — return `isRepo:false` (200) so the UI shows the empty state.

---

## 6. UI api-client — `packages/ui/src/lib/api-client.ts`

Add the `Git*` types to the `import type { … } from "@orquester/api"` block (top), then add a
`// --- Git ---` section after the file-browser methods (~line 218), following the existing
`send(...)` style:

```ts
gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  return this.send("GET", "/api/git/status", { query: { path }, signal });
}
gitDiff(path: string, file: string, opts?: { staged?: boolean; commit?: string }, signal?: AbortSignal): Promise<GitDiffResponse> {
  return this.send("GET", "/api/git/diff", {
    query: { path, file, staged: opts?.staged ? "true" : undefined, commit: opts?.commit },
    signal
  });
}
gitLog(path: string, opts?: { skip?: number; limit?: number }, signal?: AbortSignal): Promise<GitLogEntry[]> {
  return this.send("GET", "/api/git/log", {
    query: { path, skip: opts?.skip?.toString(), limit: opts?.limit?.toString() },
    signal
  });
}
gitCommitDetail(path: string, sha: string, signal?: AbortSignal): Promise<GitCommitDetail> {
  return this.send("GET", "/api/git/commit", { query: { path, sha }, signal });
}
gitBranches(path: string, signal?: AbortSignal): Promise<GitBranchesResponse> {
  return this.send("GET", "/api/git/branches", { query: { path }, signal });
}
gitStage(path: string, files: string[]): Promise<GitOpResult> {
  return this.send("POST", "/api/git/stage", { body: { path, files } });
}
gitUnstage(path: string, files: string[]): Promise<GitOpResult> {
  return this.send("POST", "/api/git/unstage", { body: { path, files } });
}
gitCommit(req: GitCommitRequest): Promise<GitOpResult> {
  return this.send("POST", "/api/git/commit", { body: req });
}
gitDiscard(path: string, files: string[]): Promise<GitOpResult> {
  return this.send("POST", "/api/git/discard", { body: { path, files } });
}
gitFetch(path: string): Promise<GitOpResult> { return this.send("POST", "/api/git/fetch", { body: { path } }); }
gitPull(path: string): Promise<GitOpResult> { return this.send("POST", "/api/git/pull", { body: { path } }); }
gitPush(path: string): Promise<GitOpResult> { return this.send("POST", "/api/git/push", { body: { path } }); }
gitCheckout(path: string, branch: string): Promise<GitOpResult> {
  return this.send("POST", "/api/git/checkout", { body: { path, branch } });
}
```

(`query` values that are `undefined` are omitted by the transporter — matching how
`gitDiff`/`gitLog` pass optional params.)

---

## 7. UI store — `packages/ui/src/store/app.ts`

Mirror the `FileTab` machinery additively. A Git tab is a **singleton per project**.

1. After `FileTab` (~line 265) add:
   ```ts
   /** A client-local Git tab (GitHub-Desktop-style), one per project. */
   export interface GitTab {
     id: string;
     projectPath: string;
     title: string;
   }
   ```
2. Extend the `ProjectTab` union (~line 268):
   ```ts
   export type ProjectTab =
     | { id: string; type: "session"; session: SessionSummary }
     | { id: string; type: "files"; title: string }
     | { id: string; type: "git"; title: string };
   ```
3. State: add `gitTabsByProject: Record<string, GitTab[]>;` next to `fileTabsByProject`
   (~line 324) AND initialize it to `{}` in the store defaults (next to `fileTabsByProject: {}`
   in the `create(...)` initial state).
4. Action signature (~line 383, next to `openFileBrowser`): `openGit: () => void;`.
5. Action impl (next to `openFileBrowser`, ~line 1054) — **singleton**:
   ```ts
   openGit: () =>
     set((state) => {
       const project = state.currentProject;
       if (!project) return state;
       const existing = state.gitTabsByProject[project.path]?.[0];
       if (existing) {
         return { activeTabByProject: { ...state.activeTabByProject, [project.path]: existing.id } };
       }
       const tab: GitTab = { id: crypto.randomUUID(), projectPath: project.path, title: "Git" };
       return {
         gitTabsByProject: {
           ...state.gitTabsByProject,
           [project.path]: [tab]
         },
         activeTabByProject: { ...state.activeTabByProject, [project.path]: tab.id }
       };
     }),
   ```
6. **Closing & active-tab reassignment must include git tabs.** Update:
   - `firstTabId(sessions, fileTabs, gitTabs, path)` — add a `gitTabs` param; fallback chain
     `session ?? fileTabs[path]?.[0]?.id ?? gitTabs[path]?.[0]?.id ?? null`.
   - `reassignActive(...)` — thread `gitTabs` through to `firstTabId`.
   - `removeSession` — pass `state.gitTabsByProject` to `reassignActive`.
   - Replace `removeFileTab` with a `removeLocalTab(state, id)` that filters the id out of
     **both** `fileTabsByProject` and `gitTabsByProject` and calls `reassignActive` with both
     maps; `closeTab`'s non-session branch calls `removeLocalTab`. (Keep `removeFileTab`'s
     behavior for file tabs — just generalize it to also drop git tabs.)
   - `clearProjectLocalState` — also purge `gitTabsByProject` for matching paths.
7. `useProjectTabs` (~line 1237): also read `gitTabsByProject`, map its tabs to
   `{ id, type: "git", title }`, and append them after the file tabs. Add `gitTabsByProject` to
   the selector + memo deps.

---

## 8. UI components — `packages/ui/src/components/git/` (new dir)

Match `FileBrowser.tsx` conventions: `useApi()` from `../../context/orquester-context`,
`cn` from `../../lib/cn`, lucide icons, the neutral palette, `border-neutral-800`,
`bg-neutral-950/900`, `text-xs`/`text-sm`, `h-9` toolbars. Diff/code uses
`font-mono text-xs`. Be responsive (mobile master/detail) like FileBrowser where reasonable,
but desktop fidelity to the GitHub Desktop screenshots is the priority.

Status letter colors: added/untracked → `text-green-500`, modified → `text-yellow-500`,
deleted → `text-red-500`, renamed/copied → `text-blue-400`, conflicted → `text-orange-500`.
Diff row backgrounds: add → `bg-green-950/40` with `text-green-300`-ish; del →
`bg-red-950/40` with `text-red-300`-ish; context → default; hunk header →
`bg-neutral-900 text-neutral-500`.

### 8a. `lib/git-diff.ts` — unified-diff parser (pure, no React)
```ts
export type DiffRowType = "hunk" | "add" | "del" | "context";
export interface DiffRow { type: DiffRowType; oldNo: number | null; newNo: number | null; text: string; }
export interface DiffHunk { header: string; rows: DiffRow[]; }
export interface ParsedDiff { hunks: DiffHunk[]; binary: boolean; }
export function parseUnifiedDiff(diff: string): ParsedDiff;
```
Skip file-header meta lines (`diff --git`, `index `, `--- `, `+++ `, `new file`, `deleted file`,
`similarity`, `rename `). Start a hunk on `@@ -a,b +c,d @@…`; seed `oldNo=a`, `newNo=c`.
For each body line: ` ` → context (advance both), `+` → add (advance newNo, oldNo null), `-`
→ del (advance oldNo, newNo null). `\ No newline at end of file` → ignore. If the text contains
`Binary files` / `GIT binary patch` → `binary:true, hunks:[]`. (Place this file at
`packages/ui/src/components/git/git-diff.ts`.)

### 8b. `DiffView.tsx`
Props: `{ diff: string; binary?: boolean; loading?: boolean; emptyLabel?: string }`. Parses
with `parseUnifiedDiff` and renders the GitHub-Desktop unified look (Image #2): a scrollable
`font-mono text-xs` area; each hunk a faint header row showing the `@@` line, then rows with
**two line-number gutters** (old, new — right-aligned, `text-neutral-600`, `select-none`,
`tabular-nums`) and the content with `+`/`-`/space coloring as above. States: `loading` →
"Loading diff…"; `binary` → "Binary file not shown"; empty hunks → `emptyLabel ?? "No changes"`.

### 8c. `FileStatusList.tsx` — working-tree changed-files list (used by ChangesPanel)
Props:
```ts
{
  files: GitFileChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  checked: Set<string>;            // staged-for-commit selection
  onToggle: (path: string) => void;
  onToggleAll: () => void;
}
```
Header row: a select-all checkbox + "N changed files". Each row: checkbox, a status letter
badge (M/A/D/R/U/etc, colored), the path (dir portion `text-neutral-500`, filename
`text-neutral-200`), selectable (active row `bg-neutral-800`). Mirror FileBrowser row styling.

### 8d. `GitHeader.tsx`
Props:
```ts
{
  repoName: string;
  status: GitStatusResponse | null;
  branches: GitBranchesResponse | null;
  busy: string | null;             // e.g. "fetch" | "pull" | "push" | "checkout" while in-flight
  onRefresh: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onCheckout: (branch: string) => void;
}
```
Renders the GitHub-Desktop top bar (Images #2/#5): repo name; a **current-branch dropdown**
(use the existing `AdaptiveMenu`/`Dropdown*` from `../ui`; lists `branches.local`, switches on
select via `onCheckout`); a Fetch/Pull/Push cluster showing ahead/behind (↑`ahead` ↓`behind`)
and `lastFetched` ("Last fetched …"); a manual refresh button. Show Pull emphasized when
`behind>0`, Push when `ahead>0`, else Fetch. Disable actions while `busy`.

### 8e. `ChangesPanel.tsx`
Props: `{ projectPath: string; status: GitStatusResponse | null; onChanged: () => void }`.
Layout (Image #5): left column = `FileStatusList` + (bottom) commit box (Summary `Input`,
Description `textarea`, **"Commit to `<branch>`"** `Button`); right = `DiffView` of the selected
file. Behavior:
- Selecting a file fetches its diff (`api.gitDiff(projectPath, file, { staged })` — pick staged
  vs unstaged by what the file has; prefer unstaged, fall back to staged) and shows it.
- The checkbox set is the staged selection: toggling calls `api.gitStage`/`api.gitUnstage`
  then `onChanged()`. Initialize `checked` from files where `staged` is true.
- Commit: enabled only when summary non-empty AND at least one file checked; calls
  `api.gitCommit({ path, summary, description })`, clears the box, calls `onChanged()`.
- Right-click a file → "Discard changes" (confirm via `window.confirm`) → `api.gitDiscard` →
  `onChanged()`. (A simple confirm is fine for v1.)
- Empty state (no files) = the "No local changes" message (Image #5) — keep it simple (title +
  one line), no external-editor suggestions.

### 8f. `HistoryPanel.tsx`
Props: `{ projectPath: string }`. Layout (Image #2): commit list (left) → selected commit's
file list (middle) → `DiffView` (right); collapse to master/detail on mobile. Behavior:
- On mount fetch `api.gitLog(projectPath, { limit: 50 })`; "Load more" appends with `skip`.
- Each commit row: subject, author + relative time, ref-name badges (`refs`), short sha.
- Selecting a commit fetches `api.gitCommitDetail`; show its files (path + `+adds`/`-dels`).
- Selecting a file fetches `api.gitDiff(projectPath, file, { commit: sha })` → `DiffView`.

### 8g. `GitView.tsx` + `index.ts`
`GitView` props: `{ projectPath: string }`. Root component:
- Owns top-level state: `status`, `branches`, the active sub-tab (`"changes" | "history"`), and
  a `busy` string. On mount + on `window` focus + after any mutation, refresh `status` +
  `branches` (`api.gitStatus`, `api.gitBranches`). (No polling in v1.)
- If `status && !status.isRepo` → render a centered "Not a git repository" message
  (use `EmptyState` from `../main/EmptyState` if convenient) instead of the panels.
- Else: render `GitHeader` (wired to `onFetch`/`onPull`/`onPush`/`onCheckout` → call the api,
  set `busy`, then refresh), a **Changes | History** segmented control, and the active panel
  (`ChangesPanel` with `status` + `onChanged={refresh}` · `HistoryPanel`). Derive `repoName`
  from the last path segment of `projectPath`.
- `index.ts`: `export { GitView } from "./GitView";`

---

## 9. Tab integration (small edits, one coherent change)

Teach the tab UI about the third `ProjectTab` variant. Use a `GitBranch` icon from
`lucide-react` for git tabs (size 13 in strips, matching the `FolderTree` usage).

- **`packages/ui/src/components/topbar/NewTabMenu.tsx`** — import `useAppStore`'s `openGit`
  (`const openGit = useAppStore((s) => s.openGit);`) and add, under the **Tools**
  `DropdownLabel` (after the File Browser item, ~line 55):
  ```tsx
  <DropdownItem icon={<GitBranch size={14} />} onClick={() => openGit()}>Git</DropdownItem>
  ```
  (import `GitBranch` from `lucide-react`).
- **`packages/ui/src/components/main/MainView.tsx`** — import `{ GitView } from "../git"` and
  `GitBranch`. Extend `cellIcon` (~line 18) to return `<GitBranch size={13} />` for
  `tab.type === "git"`. `cellTitle` already works (git tab has `.title`). Extend the render
  switch (~line 123) to a 3-way:
  ```tsx
  {tab.type === "session" ? (
    <TerminalView session={tab.session} active={active} viewMode={viewMode} />
  ) : tab.type === "git" ? (
    <GitView projectPath={currentProject.path} />
  ) : (
    <FileBrowser rootPath={currentProject.path} />
  )}
  ```
- **`packages/ui/src/components/topbar/TabStrip.tsx`** — import `GitBranch`; in the `icon`
  computation (~line 91) return `<GitBranch size={13} />` when `tab.type === "git"` (else the
  existing session/files branches). `title` already works. Git tabs are non-session, so they
  correctly get only "Close" in the context menu and aren't draggable — no other change.
- **`packages/ui/src/components/topbar/TabSwitcher.tsx`** — import `GitBranch`; in `tabIcon`
  (~line 9) return `<GitBranch size={size} />` for `tab.type === "git"`.

`MobileKeyBar.tsx` already guards `active.type !== "session"`, so it needs no change.

---

## 10. Build phases (workflow structure)

Files are partitioned so no two concurrently-running agents edit the same file.

1. **Contracts** — §3 (`packages/api`). (barrier)
2. **Data layer** (parallel, disjoint files): (a) daemon `git.ts` + routes/wiring in
   `index.ts` (§4–5); (b) api-client (§6); (c) store (§7). (barrier)
3. **Components** (§8), in dependency waves so later files read earlier ones from disk:
   3.1 `git-diff.ts`+`DiffView.tsx` (one agent) · `FileStatusList.tsx` · `GitHeader.tsx`;
   3.2 `ChangesPanel.tsx` · `HistoryPanel.tsx`; 3.3 `GitView.tsx`+`index.ts`. (barrier)
4. **Tab integration** — §9 (one agent, four files). (barrier)
5. **Verify & reconcile** — run `pnpm check` (the repo's typecheck gate) from the repo root;
   fix all type errors across any files; repeat until clean. Sanity-read the new code.

## 11. Verification / done criteria

- `pnpm check` (= `pnpm -r typecheck`, `tsc --noEmit`) is clean. **This is the gate.**
- Daemon smoke test (done by the human operator after the workflow): start the daemon, then
  `GET /api/git/status?path=<this repo>` returns `isRepo:true` with a branch; `…/log` returns
  commits; a non-repo path returns `isRepo:false`.
- Manual UI check: open a project → "+" → **Git**; Changes shows working-tree files + diffs;
  History shows the log + per-commit diffs; commit/fetch/pull/push/branch-switch work.
- No new npm dependency added; ESM only; matches existing code style.
