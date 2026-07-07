# Git Tab Commit-UX Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two GitHub-Desktop-style touches to the git tab — an auto-suggested commit summary for single-file changes, and a full-width commit-detail band (full title + scrollable description + total +/-) in History.

**Architecture:** Both are frontend-only React/Tailwind changes. Feature 1 edits `ChangesPanel.tsx`; Feature 2 edits `HistoryPanel.tsx`. All required data (`GitCommitDetail.subject`/`body`, per-file `additions`/`deletions`, `GitFileChange.status`) already arrives from the daemon — nothing changes server-side.

**Tech Stack:** React 18, TypeScript (ESM), Tailwind, `@orquester/api` wire types, lucide-react icons. Package manager pnpm 10.

## Global Constraints

- **Frontend-only.** No edits to `apps/daemon/*`, `packages/api/*`, daemon routes, or `packages/ui/src/store/*`.
- **No test runner exists.** The only gate is `pnpm check` (runs `tsc --noEmit` across the workspace). Verify behavior visually in the running app; **do not start a daemon in this checkout** (a live one is already serving it).
- Commit verbs (Feature 1) are exactly `Create` / `Update` / `Delete`; summary uses the file **basename**, not the full path.
- Reuse existing Tailwind conventions in these files: additions `text-green-500`, deletions `text-red-500`, counts `font-mono tabular-nums`, wrapping `whitespace-pre-wrap break-words`.
- Commit each task separately; use the repo's co-author trailer.

## File Structure

- `packages/ui/src/components/git/ChangesPanel.tsx` — Feature 1. Add a module-scope helper and wire a suggested summary into the commit box. Only file touched by Task 1.
- `packages/ui/src/components/git/HistoryPanel.tsx` — Feature 2. Add a totals `useMemo` and restructure the render into a left column + right area (detail band over the files/diff row). Only file touched by Task 2.

The two tasks are independent and may be done/committed in either order.

---

### Task 1: Auto-suggested commit summary (Changes tab)

**Files:**
- Modify: `packages/ui/src/components/git/ChangesPanel.tsx`

**Interfaces:**
- Consumes: `GitFileChange` (already imported at `ChangesPanel.tsx:3`) with fields `path: string` and `status: GitFileStatus`.
- Produces: module-scope `suggestedCommitSummary(file: GitFileChange): string`.

- [ ] **Step 1: Add the pure helper above the component**

Insert this immediately **before** the `ChangesPanel` component definition (which starts with `export const ChangesPanel: React.FC<ChangesPanelProps> = ({` at `ChangesPanel.tsx:28`), after the `ChangesPanelProps` interface:

```tsx
/**
 * GitHub-Desktop-style default commit summary for a single-file changeset:
 * "<verb> <basename>" with Create/Update/Delete chosen by the file's status.
 */
function suggestedCommitSummary(file: GitFileChange): string {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  switch (file.status) {
    case "added":
    case "untracked":
      return `Create ${name}`;
    case "deleted":
      return `Delete ${name}`;
    default:
      return `Update ${name}`;
  }
}
```

- [ ] **Step 2: Derive `suggestion` + `effectiveSummary` and update `canCommit`**

Find this line (currently `ChangesPanel.tsx:~157`):

```tsx
  const canCommit = summary.trim().length > 0 && checked.size > 0 && !committing;
```

Replace it with:

```tsx
  // Only one changed file → offer a GitHub-Desktop-style default summary shown as
  // the input's placeholder; committing with the box empty uses it.
  const suggestion = files.length === 1 ? suggestedCommitSummary(files[0]) : "";
  const effectiveSummary = summary.trim() || suggestion;
  const canCommit = effectiveSummary.length > 0 && checked.size > 0 && !committing;
```

- [ ] **Step 3: Send `effectiveSummary` from `commit()`**

In the `commit` function, find:

```tsx
      await api.gitCommit({
        path: projectPath,
        summary: summary.trim(),
        description: description.trim() || undefined
      });
```

Replace `summary: summary.trim(),` with `summary: effectiveSummary,`:

```tsx
      await api.gitCommit({
        path: projectPath,
        summary: effectiveSummary,
        description: description.trim() || undefined
      });
```

- [ ] **Step 4: Show the suggestion as the input placeholder**

Find the summary `<Input>` (currently `ChangesPanel.tsx:~253`):

```tsx
          <Input
            placeholder="Summary (required)"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
```

Replace the `placeholder` prop:

```tsx
          <Input
            placeholder={suggestion || "Summary (required)"}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: completes with no errors (exit 0). `suggestedCommitSummary`'s `switch` is exhaustive over `GitFileStatus` via `default`, so no type error.

- [ ] **Step 6: Verify in the app (Changes tab)**

In the running app's git tab → Changes, with the DiffView/commit box visible:
- Make exactly **one** change in a repo (e.g. edit one file) → the summary box is empty but shows ghost text like `Update <file>`; delete a file → `Delete <file>`; add a new file → `Create <file>`. With the file **checked**, the Commit button is enabled; clicking it creates a commit whose subject is that text.
- Type in the box → your text replaces the ghost text and is used verbatim.
- Make **two** changes → placeholder returns to `Summary (required)` and Commit stays disabled until you type a summary.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/git/ChangesPanel.tsx
git commit -m "$(cat <<'EOF'
feat(git): suggest a commit summary for single-file changes

Show a GitHub-Desktop-style Create/Update/Delete <basename> placeholder in the
Changes commit box when exactly one file changed; commit uses it when the box is
left empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Commit-detail band (History tab)

**Files:**
- Modify: `packages/ui/src/components/git/HistoryPanel.tsx`

**Interfaces:**
- Consumes: `detail: GitCommitDetail | null` state (already at `HistoryPanel.tsx:93`) with `subject: string`, `body: string`, `authorName: string`, `shortSha: string`, `date: string`, `files: GitCommitFile[]`; each `GitCommitFile` has `additions: number`, `deletions: number`. Existing helper `relativeDate(iso)` (`HistoryPanel.tsx:43`) and `baseName(p)` (`HistoryPanel.tsx:40`).
- Produces: a `totals` value `{ additions: number; deletions: number }`.

- [ ] **Step 1: Import `useMemo`**

Change the React import at `HistoryPanel.tsx:1`:

```tsx
import React, { useCallback, useEffect, useState } from "react";
```

to:

```tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
```

- [ ] **Step 2: Add the commit totals memo**

Immediately **after** the diff state block (the `const [loadingDiff, setLoadingDiff] = useState(false);` line at `HistoryPanel.tsx:99`) and **before** the `// Clear the selection…` effect at line 101, insert:

```tsx

  // Commit-wide +/- totals, summed from the per-file numstat the daemon already
  // returns. Binary files report 0/0, so this equals git's own shortstat.
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of detail?.files ?? []) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { additions, deletions };
  }, [detail]);
```

- [ ] **Step 3: Replace the render with the banded layout**

Replace the **entire** `return ( … );` block of the `HistoryPanel` component (currently `HistoryPanel.tsx:206-322`, the `<div className="flex h-full min-h-0 bg-neutral-950">` … its matching close before `};` at line 324) with:

```tsx
  return (
    <div className="flex h-full min-h-0 bg-neutral-950">
      {/* Commit list (full width on mobile until a commit is picked) */}
      <div
        className={cn(
          "min-h-0 flex-col border-r border-neutral-800 md:flex md:w-72 md:shrink-0",
          selectedSha ? "hidden md:flex" : "flex w-full"
        )}
      >
        <div className="flex h-9 shrink-0 items-center border-b border-neutral-800 px-2.5">
          <span className="text-xs text-neutral-500">History</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loadingLog && commits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>
          ) : commits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-600">No commits yet.</p>
          ) : (
            <>
              {commits.map((commit) => (
                <CommitRow
                  key={commit.sha}
                  commit={commit}
                  active={commit.sha === selectedSha}
                  onSelect={() => selectCommit(commit.sha)}
                />
              ))}
              {!done && (
                <div className="px-2.5 py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right area: commit-detail band above the files + diff row */}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col md:flex",
          selectedSha ? "flex" : "hidden md:flex"
        )}
      >
        {/* Commit-detail band: full title, scrollable description, meta + totals.
            Hidden on the mobile diff stage so the diff gets the full screen. */}
        {detail && (
          <div
            className={cn(
              "shrink-0 space-y-2 border-b border-neutral-800 px-4 py-3",
              selectedFile ? "hidden md:block" : "block"
            )}
          >
            <p className="whitespace-pre-wrap break-words text-sm font-semibold text-neutral-100">
              {detail.subject}
            </p>
            {detail.body.trim() && (
              <div className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-900/40 p-2 text-xs leading-relaxed text-neutral-400">
                {detail.body.trim()}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-neutral-500">
              <span className="min-w-0 truncate">{detail.authorName}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{relativeDate(detail.date)}</span>
              <span className="shrink-0 font-mono text-neutral-600">{detail.shortSha}</span>
              <span className="ml-auto shrink-0 font-mono tabular-nums">
                <span className="text-green-500">+{totals.additions}</span>{" "}
                <span className="text-red-500">-{totals.deletions}</span>
              </span>
            </div>
          </div>
        )}

        {/* Files list + diff */}
        <div className="flex min-h-0 flex-1">
          {/* Commit's changed files (mobile: shown once a commit is picked, until a file is) */}
          <div
            className={cn(
              "min-h-0 flex-col border-r border-neutral-800 md:flex md:w-72 md:shrink-0",
              selectedSha && !selectedFile ? "flex w-full" : "hidden md:flex"
            )}
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
              <button
                type="button"
                aria-label="Back to history"
                onClick={() => setSelectedSha(null)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
              >
                <ArrowLeft size={15} />
              </button>
              <span className="truncate text-xs text-neutral-500">
                {detail ? `${detail.files.length} changed ${detail.files.length === 1 ? "file" : "files"}` : "Files"}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {loadingDetail ? (
                <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>
              ) : !selectedSha ? (
                <p className="px-3 py-2 text-xs text-neutral-600">Select a commit.</p>
              ) : (
                detail?.files.map((file) => (
                  <CommitFileRow
                    key={file.path}
                    file={file}
                    active={file.path === selectedFile}
                    onSelect={() => selectedSha && selectFile(selectedSha, file)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Diff pane (full width on mobile when a file is selected) */}
          <div className={cn("min-w-0 flex-1 flex-col", selectedFile ? "flex" : "hidden md:flex")}>
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 px-2">
              <button
                type="button"
                aria-label="Back to files"
                onClick={() => setSelectedFile(null)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
              >
                <ArrowLeft size={15} />
              </button>
              <span className="truncate text-xs text-neutral-300">{selectedFile ? baseName(selectedFile) : ""}</span>
            </div>
            {selectedFile ? (
              <DiffView diff={diff} binary={diffBinary} loading={loadingDiff} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
                Select a commit to view its changes
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
```

Note vs. the old render: the inline detail block that lived inside the files
scroll container is removed (now the band); the files scroll container merges its
`overflow-auto` with `py-1`; the files pane + diff pane are wrapped in a new
`flex min-h-0 flex-1` row inside the right-area column. `CommitRow`,
`CommitFileRow`, and the diff pane markup are otherwise unchanged.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: completes with no errors (exit 0). `useMemo` is now imported; `totals`, `detail.body`, `detail.date` are all typed.

- [ ] **Step 5: Verify in the app (History tab)**

In the running app's git tab → History:
- Select a commit → a full-width band appears above the file list + diff, showing the **full title wrapped** (long titles no longer clip), `author · <relative date> · shortSha`, and a right-aligned green/red **total** `+N -N` that equals the sum of the per-file counts.
- A commit **with** a body shows a bounded, **scrollable** description box; a commit with an empty body shows no description box.
- The file list and per-file diff still open/switch correctly; the "N changed files" header still shows.
- Narrow the window (<768px): commits → (band + files) → diff stages navigate via the back buttons; on the diff stage the band is hidden and the diff fills the screen.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/git/HistoryPanel.tsx
git commit -m "$(cat <<'EOF'
feat(git): show a commit-detail band in History

Selecting a commit now shows a full-width band with the wrapped full title, a
scrollable description, and the commit's total +/- (summed client-side from the
per-file numstat), matching GitHub Desktop. Restructures the History render into
a left commit list + a right area (band over the files/diff row); mobile
master/detail stages are preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Feature 1 (auto summary: verb map, trigger, wiring, placeholder) → Task 1, Steps 1-4. ✓
- Feature 2 (band: full title, scrollable body, totals, layout, mobile) → Task 2, Steps 1-3. ✓
- Frontend-only / no backend edits → enforced by Global Constraints; both tasks touch only their one UI file. ✓
- `pnpm check` gate + visual verification → each task's Steps 5-6/4-5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `suggestedCommitSummary(file: GitFileChange)` used consistently; `totals.additions`/`totals.deletions` defined in Step 2 and consumed in Step 3; `detail.body`/`detail.date`/`detail.subject` match `GitCommitDetail`. ✓
