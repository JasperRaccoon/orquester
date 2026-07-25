# File-browser rename — design

Add renaming of files and folders to the file-browser tab, entered either from the
right-click context menu or by double-clicking the entry's name, with inline (VS
Code-style) editing in the tree.

## Scope

- Rename a single file or folder within its current directory (no move — the parent
  stays the same).
- Entry points: context-menu **Rename** item (works on mobile via the existing
  long-press menu) and **double-click on the name text** of a tree row.
- Out of scope (YAGNI): F2 shortcut, drag-to-move, overwrite-on-conflict prompts,
  multi-select.

## Daemon: `POST /api/fs/rename`

New route in `apps/daemon/src/index.ts`, sibling of `POST /api/fs/create` (same
sandbox + error mapping).

Request: `{ path: string, newName: string }` → `{ ok: true }`.

Validation, in order:

1. `path` and `newName` required, else `400 INVALID_REQUEST`.
2. `newName` must be a single clean segment: non-empty after trim, no `/` or `\`,
   not `.` or `..`, else `400 INVALID_REQUEST`.
3. `assertInsideFsRoot` on `path` (source must exist — realpath-based, as delete
   does) → `403 FS_FORBIDDEN` outside the sandbox.
4. Refuse to rename the workspaces root itself (compare against the realpathed
   `fsRoot`, like the delete route) → `400 FS_ERROR`.
5. Destination = `join(dirname(source), newName)`, re-checked with
   `assertInsideFsRoot` (defense in depth).
6. **Conflict check:** `lstat(destination)`. If it exists →
   `409 { code: "FS_EXISTS", message: 'A file or folder named "<newName>" already exists.' }`.
   Exception: if source and destination are the same inode (`dev` + `ino` match —
   a case-only rename on a case-insensitive filesystem, e.g. macOS desktop), fall
   through and allow the rename. If `newName` equals the current basename exactly,
   short-circuit `{ ok: true }` (no-op).
7. `fs.rename(source, destination)`; failures → `400 FS_ERROR` with the error
   message.

Sessions running inside a renamed folder are left alone — tmux/PTY cwds follow the
inode on the same filesystem, so nothing needs closing (unlike delete). The
conflict check is check-then-act (TOCTOU) — acceptable for this single-user tool,
same tier as the existing routes.

## Wire contracts (`packages/api`)

- `FsRenameRequest { path: string; newName: string }` next to `FsCreateRequest`.
- Reference client (`HttpOrquesterApiClient`) gets `renameFsEntry`, next to its
  existing `deleteFsEntry`.

## UI client (`packages/ui/src/lib/api-client.ts`)

- `renameFsEntry(path: string, newName: string): Promise<{ ok: true }>` →
  `POST /api/fs/rename`, next to `createFsEntry`.
- Conflict detection in the component via the existing `ApiError` (status `409` /
  body `code === "FS_EXISTS"`); no new error plumbing.

## UI (`packages/ui/src/components/files/FileBrowser.tsx`)

State: `renaming: { path: string; name: string; kind: "dir" | "file" } | null`,
plus a `renameError: string | null` for the conflict message (kept separate from
the generic `error` strip only if reuse is awkward; otherwise reuse `error`).

**Entering rename:**

- Context menu: **Rename** item (pencil icon, e.g. lucide `Pencil`) in the
  `menu.target` section, above Delete.
- Double-click on the name `<span>` of a row: `onDoubleClick` with
  `stopPropagation`/`preventDefault` so it doesn't toggle the folder or reselect
  the file a third time. (The two single-clicks that precede a double-click still
  fire — for a folder that's toggle-open-then-closed, net no change; acceptable.)

**While renaming:** the row's name span is replaced by an `Input` (16px on mobile
like the create input), auto-focused with the text pre-selected, prefilled with the
current name. Enter commits; Escape cancels; blur cancels (matching the create
input) — except immediately after a conflict, where the input stays mounted (see
below). The row's click/context handlers are inert for the renaming row.

**Commit flow:**

1. `api.renameFsEntry(path, newName)`; a no-op name change just closes the editor.
2. On success, patch local state by prefix-rewriting `oldPath` → `newPath`
   (mirroring `confirmDelete`'s cleanup):
   - `expanded`: rewrite every dir equal to or under `oldPath`.
   - `childrenByPath`: rewrite keys equal to or under `oldPath` (entry values are
     refreshed by the reload below; dropping stale subtree entries and letting the
     poll refill is fine as long as keys don't point at dead paths).
   - `selectedFile`: rewrite if it is or is under `oldPath` (`selectedSize`
     unchanged).
   - `activeDir`: rewrite if it is or is under `oldPath`.
   - Reload the parent dir (`loadDir(parentOf(path))`), close the editor.
3. On `ApiError` with status 409: keep the input open (attempted name still in
   place) and show the server's conflict message.
4. On any other error: close the editor, show "Could not rename." in the error
   strip.

## Testing

`pnpm check` clean, then drive the real surface (per repo convention — no test
runner): rename a file and a folder from both entry points; rename to an existing
sibling name (expect the inline conflict message, input still open); rename a
folder that is expanded and contains the selected file (expect the tree and open
editor to follow); rename with `/` in the name (expect 400); verify over the web
client. Sandbox checks ride the existing `assertInsideFsRoot` behavior.
