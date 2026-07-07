# Git Tab Commit-UX Enhancements — Design

**Date:** 2026-07-07
**Status:** Approved (design)

Two independent, GitHub-Desktop-style improvements to the git tab, both
**frontend-only**. The daemon and wire contracts already deliver every field
required — no changes to `apps/daemon/src/git.ts`, `packages/api`, the routes,
or the zustand store.

---

## Feature 1 — Auto-suggested commit summary (Changes tab)

### Problem

Committing a single file still forces the user to type a summary; the commit
button is disabled until the summary box is non-empty
(`ChangesPanel.tsx` — `canCommit = summary.trim().length > 0 && …`). GitHub
Desktop instead shows a suggested message as *ghost text* (the input stays
empty) and commits with that suggestion if the user types nothing.

### Behavior

When **exactly one file** is changed (`files.length === 1`):

- The summary input's **placeholder** shows a suggested message.
- Committing with the box **empty** sends the suggestion as the commit summary.
- The moment the user types, their text wins (placeholder is only visible while
  the field is empty).
- Commit still requires at least one **checked** (staged) file — an unchecked
  lone file shows the suggestion but keeps Commit disabled.

With **zero or more than one** changed file, behavior is unchanged: placeholder
reverts to `"Summary (required)"` and a typed summary is required.

### Verb mapping (matches GitHub Desktop)

Summary = `<verb> <basename>` (file **basename**, not the full repo path):

| `GitFileStatus`                                     | Verb     |
|-----------------------------------------------------|----------|
| `added`, `untracked`                                | `Create` |
| `deleted`                                           | `Delete` |
| `modified`, `renamed`, `copied`, `typechange`, `conflicted` | `Update` |

Examples: `Create index.html`, `Update FileBrowser.tsx`, `Delete index.html`.

### Implementation (in `packages/ui/src/components/git/ChangesPanel.tsx`)

- Module-scope pure helper `suggestedCommitSummary(file: GitFileChange): string`.
- `const suggestion = files.length === 1 ? suggestedCommitSummary(files[0]) : "";`
- `const effectiveSummary = summary.trim() || suggestion;`
- `canCommit` gates on `effectiveSummary.length > 0` (instead of `summary.trim()`).
- `commit()` sends `effectiveSummary` (the daemon requires a non-empty summary,
  `git.ts:461`, so we always resolve it client-side).
- Summary `<Input>` `placeholder={suggestion || "Summary (required)"}`.

---

## Feature 2 — Commit-detail band (History tab)

### Problem

Selecting a commit in History shows a cramped block inside the narrow 288px
"Files" column (`HistoryPanel.tsx:272-281`): the title is **truncated to one
line**, the **description/body is never shown**, and per-file `+/-` counts are
never summed into a commit total — even though `GitCommitDetail` already carries
the full `subject`, full `body`, and per-file `additions`/`deletions`.

### Behavior

Clicking a commit shows a full-width **detail band** above the files+diff area
(the layout the user selected), containing:

- **Full commit title** — wraps instead of truncating.
- **Scrollable description** — the commit body in its own bounded, scrollable
  box (shown only when the body is non-empty).
- **Meta + totals** — `author · relativeDate · shortSha` on the left, and the
  commit's **total** `+N -N` (green/red) pushed to the right.

**Totals** are summed **client-side** from `detail.files` (binary files are
`0/0`, so the sum matches `git show --shortstat` exactly).

### Layout restructure (in `packages/ui/src/components/git/HistoryPanel.tsx`)

The render changes from a flat 3-pane row into a left column + a right area:

```
root (flex row)
├─ commit list            (w-72, unchanged)
└─ right area (flex-col, flex-1)
   ├─ detail band         (NEW — full width, shrink-0)
   └─ files+diff row (flex row, flex-1)
      ├─ files pane        (w-72 — same list, minus the old inline detail block)
      └─ diff pane         (flex-1, unchanged)
```

The old inline detail block (`HistoryPanel.tsx:272-281`) is removed; its content
is promoted (and expanded) into the band. Totals via a `useMemo` reduce over
`detail.files` (requires adding `useMemo` to the import).

### Responsive (preserve the existing 3-stage master/detail)

- Desktop (≥768px): all visible — band spans the right area above files+diff.
- Mobile stages: commits → (band + files) → diff. The band renders on the files
  stage (`selectedSha && !selectedFile`) and is hidden on the full-screen diff
  stage (`selectedFile`). Existing back-button navigation is unchanged.

---

## Global constraints

- **Frontend-only.** No changes to the daemon, `packages/api` types, routes, or
  the zustand store.
- Match existing Tailwind conventions already in these files: `+` =
  `text-green-500`, `-` = `text-red-500`, `font-mono tabular-nums` for counts;
  wrapping via `whitespace-pre-wrap break-words`.
- Repo has **no test runner**; the gate is `pnpm check` (typecheck) plus visual
  verification in the running app (do **not** start a daemon in this checkout).

## Out of scope

- Server-authoritative commit totals (deliberately client-summed).
- Resizable description panel / commit-detail toolbar actions (GitHub Desktop
  extras not requested).
- Any change to the Changes-tab diff pane or the commit list rows.

## Verification

- `pnpm check` passes (no type errors; both changes use already-typed fields).
- Changes tab, one changed file: empty summary shows e.g. *Delete index.html*;
  Commit is enabled (file checked) and commits with that text; typing overrides.
- Changes tab, 0 or >1 files: placeholder is `"Summary (required)"`; summary
  required as before.
- History tab: selecting a commit shows a full-width band with the wrapped full
  title, a scrollable description (when present), and total `+N -N`; the file
  list and diff still work; mobile stages still navigate.
