# File browser — upload files & folders into a project

- **Date:** 2026-06-23
- **Status:** Design — pending review
- **Scope:** Let users upload files and whole folders (with nested contents) from their PC into a
  project's file tree, both via a toolbar **Upload** button and by dragging from the OS file
  explorer onto a target folder in the tree.

## Goal

Get one or more local files — or an entire folder subtree — from the client machine into the
project's files under `fsRoot`, **preserving the original names and nested directory structure**,
landing under a destination folder the user chooses (the folder they dropped on, or the project
root). A dropped folder **merges recursively** into any same-named folder already present; only
leaf-file collisions prompt the user.

## Why this isn't the terminal-upload route

A real upload mechanism already exists for coding agents — `POST /api/sessions/:id/upload` plus the
client-side base64/FileReader plumbing in `TerminalView.tsx`. We reuse its **mechanism** (base64 in
a JSON body over the shared transport, the `fsRoot` sandbox helper, the 25 MB cap, the raised body
limit, the `ENOSPC → 507` mapping) but **not** its route, because the destinations are opposite:

| | Terminal upload (`/api/sessions/:id/upload`) | File-browser upload (this design) |
|---|---|---|
| Destination | daemon-private `<appdir>/daemon/uploads/<sid>/` | **into the project tree**, under `fsRoot` |
| Filename | randomized (`<id>-<safeName>`) | **original name preserved** |
| Structure | flat | **nested directories preserved** |
| Lifetime | swept when the session dies | **permanent** project content |

So this is a purpose-built sibling of `/api/fs/create`: same sandbox + error mapping as the other
`/api/fs/*` routes, with the upload mechanics layered on.

## User-facing behavior

- **Toolbar:** an **Upload** button (upload/cloud icon) next to *New folder*, opening a small menu:
  **Upload files…** / **Upload folder…**. Matching items are added to the right-click context menu.
  **Destination** mirrors the existing New file/New folder buttons: the **toolbar** Upload targets
  the **project root**; a **context-menu** Upload targets the **clicked folder**.
- **Drag-drop:** dragging files/folders from the OS file explorer onto the tree highlights the
  **target folder** under the cursor and uploads into it. Dropping on a folder row targets that
  folder; on a file row targets its parent; on empty tree space targets the project root. A
  drag-over ring + a "Drop to upload to `<folder>/`" hint shows the target.
- **Merge, never replace:** a dropped folder merges into a same-named existing folder. Files that
  already exist (same relative path) prompt; everything else is created; anything already in the
  project that isn't in the upload is left untouched.
- **Conflicts:** when a target file already exists, a prompt offers **Replace / Skip / Keep both**,
  with an **"apply to all remaining"** checkbox so a folder with many conflicts is one decision.
- **Progress / failures:** an inline status line (`Uploading 12/240…`, `Replaced N`, `Skipped N over
  25 MB`) like the terminal's; per-file errors are reported, non-blocking.
- After a successful upload the destination folder auto-expands and refreshes.

## Merge semantics (the core rule)

Upload is **per-file, keyed by relative path**, written with an **exclusive flag (`wx`) by
default**. Directories merge by name; only **leaf-file** collisions (or a file/dir **type clash**)
prompt. Nothing outside the uploaded set is ever modified or deleted.

Worked example — dropping PC `folder 1` onto the project root, where the project already has
`folder 1/file_a.txt` and `folder 1/folder 2/file_b.txt`:

| Uploaded relative path | Target state | Result |
|---|---|---|
| `folder 1/file_a.txt` | already exists | **conflict → prompt** (Replace / Skip / Keep both) |
| `folder 1/folder 2/file_c.txt` | parent exists, file new | new write |
| `folder 1/folder 3/file_d.txt` | parent missing | `mkdir -p folder 3` then write → new |
| `folder 1/folder 2/file_b.txt` | *not in the upload* | **never touched** |

This falls out of the per-file design for free — there is no whole-folder "replace" path. A
**type clash** (upload needs `folder 3/` but a *file* `folder 3` exists, or vice-versa) is surfaced
as a conflict rather than silently failing.

## End-to-end flow (Approach B — optimistic exclusive-write)

1. Entry point produces a flat list of `{ relativePath, file }` (see *Gathering*, below).
2. The destination dir is resolved: the **drop target** for drag-drop; the **project root** for the
   toolbar button; the **clicked folder** for a context-menu upload (matching the New file/folder
   buttons).
3. **Pass 1:** for each file, base64-encode and `POST /api/fs/upload` with `onConflict: "error"`.
   Clean files write immediately (the tree refreshes as they land). Any response tagged
   `conflict: true` is collected, not written.
4. If conflicts were collected, show the conflict modal **once** (Replace / Skip / Keep both +
   apply-to-all) and gather a disposition per conflict.
5. **Pass 2:** re-send the resolved conflicts with `onConflict: "overwrite"` (Replace) or
   `"rename"` (Keep both); Skip sends nothing.
6. Refresh the destination subtree.

One file per request keeps each request small and bounded, gives natural per-file progress, and lets
each conflict resolve independently. A folder = N sequential requests, exactly like the existing
terminal-upload loop.

## Wire contracts (`packages/api`)

```ts
export interface FsUploadRequest {
  destDir: string;          // absolute dir under fsRoot the upload lands in
  relativePath: string;     // path within the upload, e.g. "folder 1/folder 2/file_c.txt"
  dataBase64: string;       // base64-encoded file bytes
  onConflict?: "error" | "overwrite" | "rename"; // default "error"
}

export interface FsUploadResponse {
  path: string;             // absolute final path (after any rename)
  name: string;             // final basename actually written (may differ under "rename")
  size: number;             // bytes written (0 when conflict:true)
  conflict?: boolean;       // true when onConflict:"error" and the target already existed
  conflictKind?: "file" | "dir"; // what was already there (for the type-clash message)
}
```

Add to the reference client (`HttpOrquesterApiClient`) and the UI `ApiClient`:

```ts
uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse>;
```

Rides the normal JSON request path, so it works unchanged over both the HTTP transporter (web) and
the desktop Unix-socket bridge.

## Daemon (`apps/daemon/src/index.ts`)

### Route — `POST /api/fs/upload`

A sibling of `/api/fs/create`, registered with a **route-level `bodyLimit`** (~40 MB, to fit a
base64-encoded 25 MB file over the 256 KB global default). Lives under `/api`, inheriting the bearer
-auth hook on the remote transport.

Handler:
1. Validate body: `destDir`, `relativePath`, non-empty `dataBase64` → 400 otherwise.
2. **Sanitize `relativePath`** client-side *and* here: reject absolute paths and any `..` segment;
   normalize separators.
3. Compute `final = join(destDir, relativePath)` and **`assertInsideFsRoot(fsRoot, final)`** — the
   authoritative traversal guard (defense in depth on top of step 2). `FsSandboxError → 403`.
4. Decode base64 → Buffer; `length > MAX_UPLOAD_BYTES → 413`; non-empty input that decodes to 0
   bytes (invalid base64) → 400 (mirrors the session-upload guard).
5. `mkdir(dirname(final), { recursive: true })`. If a path segment exists as a **file**, the mkdir
   fails with `ENOTDIR/EEXIST` → return `{ conflict: true, conflictKind: "file" }` (type clash).
6. Write by `onConflict`:
   - `"error"` → `writeFile(final, buf, { flag: "wx" })`; on `EEXIST` → return
     `{ conflict: true, conflictKind: <stat of existing> }` (200, **not** an error).
   - `"overwrite"` → `writeFile(final, buf)` (replace). If the target is a directory the write fails
     with `EISDIR → FS_ERROR` (the client never offers Replace for a type clash; the daemon guards
     anyway).
   - `"rename"` → pick the next free `name (n).ext` in the dir, write that, return the actual name.
7. Map `ENOSPC → 507`, other write failures → 500, `{ code: "FS_ERROR", message }` like the
   sibling routes.
8. Return `{ path, name, size, conflict?, conflictKind? }`.

### Limits

- `MAX_UPLOAD_BYTES = 25 MB` decoded (reuse the existing constant); route `bodyLimit ≈ 40 MB`.
- Per-file only; a folder is many requests. No total-size cap server-side (the client guards big
  folders — below); the per-file cap bounds memory per request.

## UI (`packages/ui`)

### Gathering the file list (both entry points → `{ relativePath, file }[]`)

- **Drag-drop:** recurse `DataTransferItem.webkitGetAsEntry()` — `FileSystemFileEntry` yields a file
  at its relative path; `FileSystemDirectoryEntry.createReader().readEntries()` recurses (and can
  surface empty dirs). A bare file drop yields `relativePath = file.name`.
- **Button:** a hidden `<input type="file" multiple>` (Upload files…) and one with `webkitdirectory`
  (Upload folder…). Folder picks carry `webkitRelativePath` as the relative path; plain file picks
  use `file.name`.

### Upload driver (`FileBrowser.tsx`)

The two-pass Approach-B loop from *End-to-end flow*: filter empties, enforce the per-file cap (skip +
report oversized), Pass 1 with `onConflict:"error"`, collect conflicts, prompt once, Pass 2 to
resolve. Sequential to preserve order and give per-file progress; refresh the destination subtree on
completion.

### Shared helper (targeted dedup)

Extract `fileToBase64` + `stripDataUrlPrefix` out of `TerminalView.tsx` into
`packages/ui/src/lib/files.ts`; import from both. No behavior change to the terminal — pure move.

### Components

- **Toolbar Upload button + menu** next to New folder; matching context-menu items. The toolbar is a
  tight `h-9` strip already at three icons, so one Upload icon with a Files/Folder menu beats a
  fourth and fifth icon.
- **Drop targets:** `dragover/dragenter` on tree rows set a `dropTarget` (folder path); a folder row
  gets a highlight ring, a file row resolves to its parent, empty space resolves to root. Clear on
  `dragleave/drop`. A small "Drop to upload to `<folder>/`" hint. The existing app root must not
  swallow these drops (confirm, as the terminal-drop work did).
- **Conflict modal:** lists the conflicting relative path, offers **Replace / Skip / Keep both** and
  an **"apply to all remaining"** checkbox; returns dispositions to the driver. For a **file↔dir
  type clash** (`conflictKind: "dir"`), **Replace is omitted** — only Skip / Keep both — since
  replacing a directory subtree with a single file would delete the subtree.
- **Status line:** inline `Uploading n/total…`, `Replaced N`, `Skipped N over 25 MB`, error notices.

## Limits & edge cases

- **Per-file 25 MB cap** (reuse `MAX_UPLOAD_BYTES`); oversized files skipped + reported.
- **Big-folder guard (client):** if a drop/selection expands to **> 500 files** or **> 200 MB**
  total, confirm before starting (`Upload 4,182 files?`) — cheap insurance against dropping
  `node_modules`. **No silent ignore filter in v1** (YAGNI; revisit if annoying).
- **Empty folders:** drag-drop recursion can create them; the `webkitdirectory` button can't
  (browsers omit empty dirs from the file list) — accepted asymmetry.
- **Type clash** (file vs dir at the same path): surfaced as a conflict (§ Daemon step 5/6).
- Relative path sanitized on **both** client and daemon.

## Runtime parity (web vs desktop)

Identical client code; the only difference is transport, already abstracted (HTTP for web, the
Unix-socket bridge for desktop) — both carry the JSON upload body unchanged. No Electron-specific
path extraction, no new IPC.

## Security

- Client supplies `destDir` + `relativePath`, but the daemon **re-sanitizes and
  `assertInsideFsRoot`s the joined final path**, so nothing can escape `fsRoot` regardless of client
  input — the same guarantee the other `/api/fs/*` routes give.
- Exclusive-write default (`wx`) means an upload never silently clobbers; overwrite/rename happen
  only on explicit user disposition.
- Size-capped to bound memory/disk; raised body limit scoped to this one route.
- Inherits the existing remote bearer auth; no new auth surface. (`/api/fs/*` is allowed on both
  transports — no secret material involved.)

## Config / constants

- Reuse `MAX_UPLOAD_BYTES = 25 * 1024 * 1024`; route `bodyLimit ≈ 40 MB`.
- Client big-folder thresholds: `MAX_UPLOAD_FILES = 500`, `MAX_UPLOAD_TOTAL_BYTES = 200 MB` (UI
  constants; confirmation only, not a hard server limit).

## Build order

1. `packages/api` — `FsUploadRequest`/`FsUploadResponse` + client method (depends on nothing).
2. `apps/daemon` — `POST /api/fs/upload` (sanitize, sandbox, conflict/rename, ENOSPC).
3. `packages/ui` — extract `lib/files.ts`; `ApiClient.uploadFsEntry`; folder gathering
   (`webkitGetAsEntry` + `webkitdirectory`); the two-pass driver; toolbar/menu, drop targets,
   conflict modal, status.
4. Verify (below). `pnpm check` stays clean throughout.

## Verification plan

Driven against a real daemon-served SPA (the harness used for the terminal-drop work), not mocks:

1. **Single file, button:** Upload files… → file appears in the tree under the target, correct
   bytes.
2. **Folder, button:** Upload folder… on a nested folder → structure recreated; `webkitRelativePath`
   honored.
3. **Folder, drag-drop merge:** reproduce the worked example (PC `folder 1` onto project root with a
   pre-existing `folder 1`) → `file_a.txt` prompts; `file_c.txt`, `folder 3/file_d.txt` created;
   `file_b.txt` untouched.
4. **Conflict dispositions:** exercise Replace, Skip, Keep both (`foo (1).txt`), and apply-to-all.
5. **Drop targets:** drop on a folder row, a file row (→ parent), and empty space (→ root); verify
   the highlight + hint and the resulting destination.
6. **Type clash:** upload a file where a same-named dir exists (and vice-versa) → reported, not a
   crash.
7. **Size cap:** an oversized file is skipped + reported; others in the batch still upload.
8. **Big-folder guard:** drop a folder over the threshold → confirmation appears first.
9. **Both runtimes:** web (HTTPS) and desktop (socket) both upload + merge.
10. **Sandbox:** a crafted `relativePath` with `..` is rejected (403), file not written.
11. `pnpm check` clean.

## Alternatives considered

- **Approach A — pre-flight conflict check** (ask the daemon which paths exist, then upload):
  rejected for an extra endpoint and a time-of-check/time-of-use gap; Approach B gets the same
  one-prompt UX race-free, using the filesystem itself as the source of truth.
- **Reuse `/api/sessions/:id/upload`:** rejected — session-scoped, randomized names, flat structure;
  wrong destination/naming/structure for project content.
- **Multipart / octet-stream** instead of base64-in-JSON: avoids ~33% inflation but needs
  `@fastify/multipart` and makes the desktop socket bridge carry binary — more plumbing for a
  single-user app; rejected for uniformity with the existing upload path.
- **Whole-folder atomic replace** (delete the target folder, then write): rejected — destroys
  untouched existing files (`file_b.txt`); the per-file merge is the desired behavior.
- **Silent ignore filter** (auto-skip `node_modules`/`.git`): deferred (YAGNI); the big-folder
  confirmation covers the footgun without surprising omissions.

## Risks / open items

- **Large base64 over IPC** on desktop: a 25 MB file is a ~33 MB string per request — acceptable for
  occasional single-user use; the per-file cap bounds it, and a folder streams file-by-file rather
  than one giant payload.
- **Drag-drop folder API support:** `webkitGetAsEntry` is supported across the Electron Chromium and
  target browsers; the bare-file path is the graceful fallback if a directory entry is unavailable.
- **Many sequential requests** for a large folder: bounded by the big-folder guard; could batch or
  parallelize later if needed (not now).
