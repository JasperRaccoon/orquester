# File Browser Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload files and whole folders (nested, with merge) from their PC into a project's file tree, via a toolbar **Upload** button/menu and via drag-drop from the OS file explorer onto a target folder.

**Architecture:** A new `POST /api/fs/upload` daemon route — sibling of `/api/fs/create` — writes one file per request into the project tree under `fsRoot`, exclusive-write (`wx`) by default so a pre-existing target comes back tagged `conflict` instead of being clobbered (Approach B). The client gathers a flat `{relativePath, file}[]` from either a `<input webkitdirectory>` pick or a `webkitGetAsEntry` drag-drop walk, uploads sequentially (clean files land immediately), then resolves any conflicts in one prompt (Replace / Skip / Keep both + apply-to-all) and re-uploads the resolved ones. Deep recursive merge falls out for free because writes are keyed by relative path and nothing is ever deleted.

**Tech Stack:** TypeScript ESM, Fastify 4 (daemon route + `bodyLimit`), React 18 + zustand + Tailwind (UI), the shared `Transporter` (base64-in-JSON over HTTP for web / Unix-socket bridge for desktop), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-06-23-file-browser-upload-design.md`

## Global Constraints

- **ESM everywhere**, TypeScript `strict`, `noEmit` — the daemon runs `.ts` via tsx; there is no build step for the daemon or packages (they import each other's `src` directly).
- **Pre-commit gate is `pnpm check`** (`pnpm -r typecheck`, i.e. `tsc --noEmit`). It must be clean after every task.
- **No unit-test runner exists, by design (AGENTS.md).** "Done" = `pnpm check` clean **and** the real surface was driven (daemon API over the socket, the SPA in a browser). This plan therefore replaces classic write-a-failing-test TDD with: implement → `pnpm check` → a concrete behavioral check against the running staged daemon/SPA → commit. Do **not** add a test framework.
- **Commit to the current branch as-is** (AGENTS.md) — do NOT create a new branch.
- **Secrets/sandbox:** every `/api/fs/*` path is resolved through `assertInsideFsRoot(fsRoot, …)`; the upload route is no exception — the joined final path is re-sanitized and re-checked server-side regardless of client input.
- **Reuse the existing upload constant** `MAX_UPLOAD_BYTES = 25 * 1024 * 1024` and the `bodyLimit: 40 * 1024 * 1024` pattern from `/api/sessions/:id/upload`.
- **Conventional commits** with scopes, matching git history (`feat(api): …`, `feat(daemon/fs): …`, `refactor(ui): …`, `feat(ui/files): …`).

---

### Task 1: Wire contracts — `FsUploadRequest` / `FsUploadResponse` + reference client

**Files:**
- Modify: `packages/api/src/index.ts` (add types after `FsWriteRequest` ~line 167; add method near `uploadSessionFile` ~line 530)

**Interfaces:**
- Produces: `FsUploadRequest { destDir: string; relativePath: string; dataBase64: string; onConflict?: "error" | "overwrite" | "rename" }`, `FsUploadResponse { path: string; name: string; size: number; conflict?: boolean; conflictKind?: "file" | "dir" }`, and `HttpOrquesterApiClient.uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse>`.

- [ ] **Step 1: Add the request/response types**

In `packages/api/src/index.ts`, immediately after the `FsWriteRequest` interface (the block ending ~line 167), add:

```ts
export interface FsUploadRequest {
  /** Absolute directory under fsRoot the upload lands in. */
  destDir: string;
  /** Path within the upload, POSIX-separated, e.g. "folder 1/folder 2/file_c.txt". */
  relativePath: string;
  /** base64-encoded file bytes. */
  dataBase64: string;
  /** Conflict policy when the target already exists. Default "error". */
  onConflict?: "error" | "overwrite" | "rename";
}

export interface FsUploadResponse {
  /** Absolute final path written (after any rename); "" when conflict is true. */
  path: string;
  /** Final basename actually written (differs from the source under "rename"). */
  name: string;
  /** Bytes written (0 when conflict is true). */
  size: number;
  /** True when onConflict was "error" and the target already existed. */
  conflict?: boolean;
  /** What already occupied the path (drives the type-clash message). */
  conflictKind?: "file" | "dir";
}
```

- [ ] **Step 2: Add the reference-client method**

In the same file, in `HttpOrquesterApiClient`, right after `uploadSessionFile` (~line 532), add:

```ts
  uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse> {
    return this.post("/api/fs/upload", body);
  }
```

(`FsUploadRequest`/`FsUploadResponse` are declared in this same file, so no import is needed.)

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): add FsUpload request/response contracts + uploadFsEntry"
```

---

### Task 2: Daemon route — `POST /api/fs/upload`

**Files:**
- Modify: `apps/daemon/src/index.ts` (add `FsUploadRequest`/`FsUploadResponse` to the `@orquester/api` type import ~lines 1-35; add `basename` to the `node:path` import line 77; add the route after `/api/fs/create` which ends ~line 907; add the `nextAvailableName` helper near `listFiles` ~line 1745)

**Interfaces:**
- Consumes: `FsUploadRequest`/`FsUploadResponse` (Task 1); existing `assertInsideFsRoot`, `FsSandboxError`, `MAX_UPLOAD_BYTES`, `resolved.fsRoot`, and the `mkdir`/`writeFile`/`stat` imports.
- Produces: `POST /api/fs/upload` and `async function nextAvailableName(desired: string): Promise<string>`.

- [ ] **Step 1: Extend the imports**

In the `@orquester/api` type-import block (~lines 1-35), add `FsUploadRequest,` and `FsUploadResponse,` (alongside the other `Fs*` types).

On the `node:path` import (line 77), add `basename`:

```ts
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
```

- [ ] **Step 2: Add the `nextAvailableName` helper**

Just above `async function listFiles(` (~line 1745), add:

```ts
/**
 * Given a desired absolute file path, return it if free, else the next free
 * `name (n).ext` in the same directory (n = 1, 2, …). Backs the upload route's
 * "rename" (keep-both) conflict resolution. A leading-dot name (".env") is kept
 * whole — its dot is not an extension.
 */
async function nextAvailableName(desired: string): Promise<string> {
  const dir = dirname(desired);
  const base = basename(desired);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate; // stat threw → does not exist → free
    }
  }
}
```

- [ ] **Step 3: Add the route**

Immediately after the `POST /api/fs/create` handler (the block ending ~line 907), add:

```ts
  // Upload one file into the project tree (a folder is many requests from the
  // client). Sibling of /api/fs/create: same fsRoot sandbox + error mapping,
  // plus the session-upload route's base64/bodyLimit/ENOSPC handling. Writes
  // with `wx` by default so an upload never silently clobbers — a pre-existing
  // target comes back as { conflict:true } (200, NOT an error) so the client
  // can prompt; "overwrite"/"rename" act only on an explicit user choice. The
  // client supplies destDir + relativePath, but the joined final path is
  // re-sanitized and assertInsideFsRoot'd, so nothing escapes fsRoot.
  app.post<{ Body: FsUploadRequest }>(
    "/api/fs/upload",
    { bodyLimit: 40 * 1024 * 1024 },
    async (request, reply): Promise<FsUploadResponse | void> => {
      const body = (request.body ?? {}) as Partial<FsUploadRequest>;
      if (!body.destDir || !body.relativePath || typeof body.dataBase64 !== "string") {
        return reply
          .code(400)
          .send({ code: "INVALID_REQUEST", message: "destDir, relativePath and dataBase64 required." });
      }
      // Sanitize the relative path: split on either separator, drop empties,
      // reject any "."/".." segment. assertInsideFsRoot below is authoritative;
      // this is defense in depth + a clean 400 for obvious garbage.
      const segments = body.relativePath.split(/[\\/]+/).filter((s) => s.length > 0);
      if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "relativePath is invalid." });
      }
      const onConflict = body.onConflict ?? "error";

      const buffer = Buffer.from(body.dataBase64, "base64");
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          code: "UPLOAD_TOO_LARGE",
          message: `File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`
        });
      }
      // Buffer.from(…, "base64") silently drops invalid chars → empty buffer.
      if (buffer.length === 0) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "dataBase64 is not valid base64." });
      }

      const leaf = segments[segments.length - 1];
      try {
        const safeDir = await assertInsideFsRoot(resolved.fsRoot, body.destDir);
        const target = await assertInsideFsRoot(resolved.fsRoot, join(safeDir, ...segments));

        // Create the parent chain. If a path segment is already a FILE, mkdir
        // fails ENOTDIR/EEXIST — a file/dir type clash, surfaced as a conflict
        // the client resolves (Skip / Keep both), not a 500. Other mkdir errors
        // (ENOSPC, EACCES) rethrow to the outer catch.
        try {
          await mkdir(dirname(target), { recursive: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ENOTDIR" || code === "EEXIST") {
            return { path: "", name: leaf, size: 0, conflict: true, conflictKind: "file" };
          }
          throw error;
        }

        if (onConflict === "error") {
          try {
            await writeFile(target, buffer, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
              const existing = await stat(target).catch(() => null);
              return {
                path: "",
                name: leaf,
                size: 0,
                conflict: true,
                conflictKind: existing?.isDirectory() ? "dir" : "file"
              };
            }
            throw error;
          }
          return { path: target, name: leaf, size: buffer.length };
        }

        if (onConflict === "rename") {
          const renamed = await nextAvailableName(target);
          await writeFile(renamed, buffer, { flag: "wx" });
          return { path: renamed, name: basename(renamed), size: buffer.length };
        }

        // "overwrite" — replace. EISDIR if a directory is there (the client
        // never offers Replace for a dir clash) → mapped to FS_ERROR below.
        await writeFile(target, buffer);
        return { path: target, name: leaf, size: buffer.length };
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        const code = (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? 507 : 400;
        return reply.code(code).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot store the uploaded file."
        });
      }
    }
  );
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Drive the real route over the Unix socket**

Start the staged daemon (it serves the same routes on its no-auth Unix socket; `fsRoot` = `.stage/workspaces`):

Run (in a second shell, from the repo root): `pnpm dev:daemon`

Then exercise the route. The socket lives at `.stage/daemon/daemon.sock`; pick any seeded project dir as the destination:

```bash
SOCK=.stage/daemon/daemon.sock
DEST=$(ls -d "$PWD"/.stage/workspaces/*/*/ 2>/dev/null | head -1); DEST=${DEST%/}
echo "dest=$DEST"
DATA=$(printf 'hello upload' | base64)

# 1) New file → expect {"path":".../up/hello.txt","name":"hello.txt","size":12}
curl -s --unix-socket "$SOCK" -X POST http://localhost/api/fs/upload \
  -H 'content-type: application/json' \
  -d "{\"destDir\":\"$DEST\",\"relativePath\":\"up/hello.txt\",\"dataBase64\":\"$DATA\"}"; echo

# 2) Same again (onConflict defaults to "error") → expect {"...","conflict":true,"conflictKind":"file"}
curl -s --unix-socket "$SOCK" -X POST http://localhost/api/fs/upload \
  -H 'content-type: application/json' \
  -d "{\"destDir\":\"$DEST\",\"relativePath\":\"up/hello.txt\",\"dataBase64\":\"$DATA\"}"; echo

# 3) rename → expect name "hello (1).txt"
curl -s --unix-socket "$SOCK" -X POST http://localhost/api/fs/upload \
  -H 'content-type: application/json' \
  -d "{\"destDir\":\"$DEST\",\"relativePath\":\"up/hello.txt\",\"dataBase64\":\"$DATA\",\"onConflict\":\"rename\"}"; echo

# 4) traversal in relativePath → expect 400 INVALID_REQUEST
curl -s --unix-socket "$SOCK" -X POST http://localhost/api/fs/upload \
  -H 'content-type: application/json' \
  -d "{\"destDir\":\"$DEST\",\"relativePath\":\"../escape.txt\",\"dataBase64\":\"$DATA\"}"; echo

# 5) destDir outside fsRoot → expect 403 FS_FORBIDDEN
curl -s --unix-socket "$SOCK" -X POST http://localhost/api/fs/upload \
  -H 'content-type: application/json' \
  -d "{\"destDir\":\"/etc\",\"relativePath\":\"x.txt\",\"dataBase64\":\"$DATA\"}"; echo
```

Expected: (1) success JSON with `size:12`; (2) `conflict:true,conflictKind:"file"`; (3) `name:"hello (1).txt"`; (4) `{"code":"INVALID_REQUEST",…}`; (5) `{"code":"FS_FORBIDDEN",…}`. Confirm the files exist: `ls "$DEST/up"` shows `hello.txt` and `hello (1).txt`. Clean up: `rm -rf "$DEST/up"`.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon/fs): add POST /api/fs/upload (exclusive-write, conflict/rename)"
```

---

### Task 3: Shared `lib/files.ts` (extract base64 helpers) + `ApiClient.uploadFsEntry`

**Files:**
- Create: `packages/ui/src/lib/files.ts`
- Modify: `packages/ui/src/components/terminal/TerminalView.tsx` (remove local `stripDataUrlPrefix`/`fileToBase64` ~lines 90-107; import from `../../lib/files`)
- Modify: `packages/ui/src/lib/api-client.ts` (add `FsUploadRequest`/`FsUploadResponse` to the `@orquester/api` type import ~lines 1-32; add `uploadFsEntry` after `saveFile` ~line 225)

**Interfaces:**
- Consumes: `FsUploadRequest`/`FsUploadResponse` (Task 1).
- Produces: `fileToBase64(file: File): Promise<string>`, `stripDataUrlPrefix(dataUrl: string): string` (from `lib/files`); `ApiClient.uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse>`.

- [ ] **Step 1: Create `packages/ui/src/lib/files.ts`**

```ts
/** Strip the `data:<mime>;base64,` prefix from a FileReader data URL. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Base64-encode a file via FileReader. readAsDataURL is safe for large files;
 * btoa(String.fromCharCode(...)) overflows the call stack on big buffers.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(stripDataUrlPrefix(reader.result as string));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 2: Point `TerminalView.tsx` at the shared helpers**

Delete the two local function definitions in `TerminalView.tsx` (`stripDataUrlPrefix` and `fileToBase64`, ~lines 90-107, including their doc comments). Add an import near the other relative imports at the top of the file:

```ts
import { fileToBase64 } from "../../lib/files";
```

(`TerminalView` only calls `fileToBase64`; `stripDataUrlPrefix` was internal to it.)

- [ ] **Step 3: Add the types to the api-client import + the method**

In `packages/ui/src/lib/api-client.ts`, add `FsUploadRequest,` and `FsUploadResponse,` to the `@orquester/api` type-import block (the one ending ~line 32, alongside `FsListResponse`/`FsReadResponse`).

After `saveFile` (~line 225), add:

```ts
  uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse> {
    return this.send("POST", "/api/fs/upload", { body });
  }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS (TerminalView still resolves `fileToBase64` from the new module; no duplicate-symbol or unused errors).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/files.ts packages/ui/src/components/terminal/TerminalView.tsx packages/ui/src/lib/api-client.ts
git commit -m "refactor(ui): extract fileToBase64 to lib/files; add ApiClient.uploadFsEntry"
```

---

### Task 4: Folder-gathering helpers (`UploadItem`, input + drag-drop)

**Files:**
- Modify: `packages/ui/src/lib/files.ts` (append)

**Interfaces:**
- Consumes: `fileToBase64` (not needed here), DOM `FileList`/`DataTransfer`/`FileSystemEntry` APIs.
- Produces: `interface UploadItem { relativePath: string; file: File }`, `gatherFromInput(files: FileList): UploadItem[]`, `gatherFromDataTransfer(dt: DataTransfer): Promise<UploadItem[]>`.

- [ ] **Step 1: Append the gathering helpers to `lib/files.ts`**

```ts
/** One file to upload, tagged with its path relative to the dropped/picked root. */
export interface UploadItem {
  /** e.g. "folder 1/folder 2/file_c.txt" (POSIX separators). */
  relativePath: string;
  file: File;
}

/**
 * Flatten an <input type="file"> selection into UploadItems. A folder picked
 * via `webkitdirectory` carries `webkitRelativePath` (e.g. "folder 1/a.txt");
 * a plain multi-file pick has none, so fall back to the bare name.
 */
export function gatherFromInput(files: FileList): UploadItem[] {
  return Array.from(files).map((file) => ({
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file
  }));
}

/**
 * Recurse a drag-drop DataTransfer via the webkitGetAsEntry / *Entry API into a
 * flat UploadItem list, preserving nested paths. Falls back to the plain
 * `.files` list when the entries API is unavailable. Empty directories are
 * walked but contribute no items (file-only upload model).
 */
export async function gatherFromDataTransfer(dt: DataTransfer): Promise<UploadItem[]> {
  // Snapshot the roots SYNCHRONOUSLY: the DataTransferItemList is emptied once
  // the drop handler returns, so we must call webkitGetAsEntry before any await.
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file") {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        roots.push(entry);
      }
    }
  }
  if (roots.length === 0) {
    // No entries API (older runtime) — fall back to flat files.
    return Array.from(dt.files).map((file) => ({ relativePath: file.name, file }));
  }
  const items: UploadItem[] = [];
  for (const entry of roots) {
    await walkEntry(entry, "", items);
  }
  return items;
}

/** Depth-first walk of a FileSystemEntry, appending files to `out`. */
async function walkEntry(entry: FileSystemEntry, prefix: string, out: UploadItem[]): Promise<void> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ relativePath, file: await fileFromEntry(entry as FileSystemFileEntry) });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries yields at most ~100 per call — loop until it returns empty.
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) {
      break;
    }
    for (const child of batch) {
      await walkEntry(child, relativePath, out);
    }
  }
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. (`FileSystemEntry`/`FileSystemDirectoryReader`/`FileSystemFileEntry` are in the TS DOM lib; if `webkitGetAsEntry` is flagged, the optional-call `?.()` plus the `File &` intersection cast already guard it — no `any` needed.)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/files.ts
git commit -m "feat(ui/files): add UploadItem + input/drag-drop folder gathering"
```

---

### Task 5: Upload driver hook — `use-file-upload.ts`

**Files:**
- Create: `packages/ui/src/components/files/use-file-upload.ts`

**Interfaces:**
- Consumes: `ApiClient` (the `useApi()` value), `fileToBase64`, `UploadItem` (Task 3/4); `api.uploadFsEntry` (Task 3).
- Produces: `useFileUpload(api: ApiClient, onUploaded: (destDir: string) => void): UseFileUpload`, plus exported `type ConflictChoice = "replace" | "skip" | "keepBoth"`, `interface ConflictPrompt`, `interface UploadStatus`, `interface UseFileUpload`. Consumed by Tasks 6 & 7.

- [ ] **Step 1: Create the hook**

```ts
import { useCallback, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api-client";
import { fileToBase64, type UploadItem } from "../../lib/files";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // mirror the daemon cap
const MAX_UPLOAD_FILES = 500; // big-folder confirm threshold
const MAX_UPLOAD_TOTAL_BYTES = 200 * 1024 * 1024; // big-folder confirm threshold

export type ConflictChoice = "replace" | "skip" | "keepBoth";

export interface ConflictPrompt {
  /** The relative path that already exists. */
  relativePath: string;
  /** What's already there — "dir" hides Replace (would delete a subtree). */
  kind: "file" | "dir";
  /** Conflicts left after this one (for the "apply to all" copy). */
  remaining: number;
  /** Called by the modal with the user's choice. */
  resolve: (choice: ConflictChoice, applyToAll: boolean) => void;
}

export interface UploadStatus {
  text: string;
  error?: boolean;
}

export interface UseFileUpload {
  status: UploadStatus | null;
  conflict: ConflictPrompt | null;
  bigFolder: { count: number; bytes: number } | null;
  confirmBigFolder: () => void;
  cancelBigFolder: () => void;
  /** Upload items into destDir; refreshes destDir as files land. */
  start: (destDir: string, items: UploadItem[]) => Promise<void>;
}

/**
 * Drives an upload (Approach B): pass 1 writes every file exclusively
 * (onConflict:"error") so clean files land immediately and existing targets
 * come back tagged; then a single prompt (with apply-to-all) resolves conflicts
 * and pass 2 re-sends them as overwrite/rename. A big-folder confirmation gates
 * accidental node_modules-sized drops. The two interactive pauses (big-folder
 * confirm, per-conflict prompt) are modal awaits via captured promise resolvers.
 */
export function useFileUpload(api: ApiClient, onUploaded: (destDir: string) => void): UseFileUpload {
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [bigFolder, setBigFolder] = useState<{ count: number; bytes: number } | null>(null);
  const bigFolderResolve = useRef<((ok: boolean) => void) | null>(null);

  const confirmBigFolder = useCallback(() => bigFolderResolve.current?.(true), []);
  const cancelBigFolder = useCallback(() => bigFolderResolve.current?.(false), []);

  const start = useCallback(
    async (destDir: string, items: UploadItem[]) => {
      const usable = items.filter((it) => it.file.size > 0);
      const oversized = usable.filter((it) => it.file.size > MAX_UPLOAD_BYTES);
      const toUpload = usable.filter((it) => it.file.size <= MAX_UPLOAD_BYTES);
      if (toUpload.length === 0) {
        setStatus(
          oversized.length > 0 ? { text: `Skipped ${oversized.length} file(s) over 25 MB`, error: true } : null
        );
        return;
      }

      // Big-folder guard — await the confirm modal.
      const totalBytes = toUpload.reduce((sum, it) => sum + it.file.size, 0);
      if (toUpload.length > MAX_UPLOAD_FILES || totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        const ok = await new Promise<boolean>((res) => {
          bigFolderResolve.current = res;
          setBigFolder({ count: toUpload.length, bytes: totalBytes });
        });
        setBigFolder(null);
        bigFolderResolve.current = null;
        if (!ok) {
          setStatus(null);
          return;
        }
      }

      // Pass 1 — exclusive write; collect conflicts and failures.
      const conflicts: { item: UploadItem; kind: "file" | "dir" }[] = [];
      let failed = 0;
      let done = 0;
      for (const item of toUpload) {
        setStatus({ text: `Uploading ${++done}/${toUpload.length}…` });
        try {
          const dataBase64 = await fileToBase64(item.file);
          const res = await api.uploadFsEntry({ destDir, relativePath: item.relativePath, dataBase64, onConflict: "error" });
          if (res.conflict) {
            conflicts.push({ item, kind: res.conflictKind ?? "file" });
          }
        } catch {
          failed++;
        }
      }
      onUploaded(destDir);

      // Resolve conflicts — one prompt at a time, with apply-to-all.
      let replaced = 0;
      let kept = 0;
      let skipped = 0;
      let bulk: ConflictChoice | null = null;
      if (conflicts.length > 0) {
        setStatus({ text: `Resolving ${conflicts.length} conflict(s)…` });
      }
      for (let i = 0; i < conflicts.length; i++) {
        const c = conflicts[i];
        let choice = bulk;
        if (!choice) {
          const decision = await new Promise<{ choice: ConflictChoice; all: boolean }>((res) => {
            setConflict({
              relativePath: c.item.relativePath,
              kind: c.kind,
              remaining: conflicts.length - i - 1,
              resolve: (ch, all) => res({ choice: ch, all })
            });
          });
          setConflict(null);
          choice = decision.choice;
          if (decision.all) {
            bulk = decision.choice;
          }
        }
        if (choice === "skip") {
          skipped++;
          continue;
        }
        // A dir clash can't be replaced — coerce defensively to rename.
        const policy = choice === "replace" && c.kind !== "dir" ? "overwrite" : "rename";
        try {
          const dataBase64 = await fileToBase64(c.item.file);
          await api.uploadFsEntry({ destDir, relativePath: c.item.relativePath, dataBase64, onConflict: policy });
          if (policy === "overwrite") {
            replaced++;
          } else {
            kept++;
          }
        } catch {
          failed++;
        }
      }
      if (conflicts.length > 0) {
        onUploaded(destDir);
      }

      const parts: string[] = [];
      if (replaced) parts.push(`Replaced ${replaced}`);
      if (kept) parts.push(`Kept both ${kept}`);
      if (skipped) parts.push(`Skipped ${skipped}`);
      if (oversized.length) parts.push(`Skipped ${oversized.length} over 25 MB`);
      if (failed) parts.push(`${failed} failed`);
      setStatus(parts.length ? { text: parts.join(" · "), error: oversized.length > 0 || failed > 0 } : null);
    },
    [api, onUploaded]
  );

  return { status, conflict, bigFolder, confirmBigFolder, cancelBigFolder, start };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/files/use-file-upload.ts
git commit -m "feat(ui/files): add useFileUpload driver (two-pass, conflicts, big-folder guard)"
```

---

### Task 6: Conflict prompt — `UploadConflictModal.tsx`

**Files:**
- Create: `packages/ui/src/components/files/UploadConflictModal.tsx`

**Interfaces:**
- Consumes: `ConflictPrompt`, `ConflictChoice` (Task 5); `Button`, `Modal` from `../ui`.
- Produces: `UploadConflictModal: React.FC<{ prompt: ConflictPrompt | null }>`.

- [ ] **Step 1: Create the component**

```tsx
import React, { useEffect, useState } from "react";
import { FileWarning } from "lucide-react";
import { Button, Modal } from "../ui";
import type { ConflictChoice, ConflictPrompt } from "./use-file-upload";

/**
 * Per-conflict upload prompt: shows the existing target's relative path and
 * offers Replace / Skip / Keep both. "Apply to all remaining" reuses the choice
 * for the rest of this upload. When a DIRECTORY already occupies the path,
 * Replace is hidden — replacing a subtree with a file would delete it.
 */
export const UploadConflictModal: React.FC<{ prompt: ConflictPrompt | null }> = ({ prompt }) => {
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (prompt) {
      setAll(false);
    }
  }, [prompt]);

  if (!prompt) {
    return null;
  }
  const isDir = prompt.kind === "dir";
  const choose = (choice: ConflictChoice) => prompt.resolve(choice, all);

  return (
    <Modal open onClose={() => choose("skip")} className="max-w-md">
      <div className="w-full p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
            <FileWarning size={16} />
          </span>
          <p className="text-sm font-medium text-neutral-100">
            {isDir ? "A folder already exists here" : "This file already exists"}
          </p>
        </div>

        <p className="break-all text-sm text-neutral-400">
          <code className="text-neutral-300">{prompt.relativePath}</code>
          {isDir && " is a folder in the project — it can't be replaced by a file."}
        </p>

        {prompt.remaining > 0 && (
          <label className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Apply to all {prompt.remaining} remaining conflict(s)
          </label>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => choose("skip")}>
            Skip
          </Button>
          <Button variant="outline" size="sm" onClick={() => choose("keepBoth")}>
            Keep both
          </Button>
          {!isDir && (
            <Button
              size="sm"
              onClick={() => choose("replace")}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              Replace
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. (`Button`, `Modal` are exported from `packages/ui/src/components/ui/index.ts`; `FileWarning` is a valid lucide-react icon.)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/files/UploadConflictModal.tsx
git commit -m "feat(ui/files): add UploadConflictModal (replace/skip/keep-both + apply-all)"
```

---

### Task 7: FileBrowser — Upload button/menu, context-menu items, hook wiring, modals & status

**Files:**
- Modify: `packages/ui/src/components/files/FileBrowser.tsx`

**Interfaces:**
- Consumes: `useFileUpload`, `UploadConflictModal` (Tasks 5/6); `gatherFromInput` (Task 4); `AdaptiveMenu`, `DropdownItem`, `ConfirmDialog` from `../ui`; `Upload` from lucide-react.
- Produces: button- and context-menu-driven upload into the project root / clicked folder (the drag-drop path is Task 8).

- [ ] **Step 1: Add imports**

In `FileBrowser.tsx`, add `Upload` to the existing lucide-react import:

```ts
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  RefreshCw,
  Save,
  Upload
} from "lucide-react";
```

Extend the `../ui` import to add the menu/dialog primitives:

```ts
import {
  AdaptiveMenu,
  Button,
  ConfirmDialog,
  ContextMenu,
  DropdownItem,
  IconButton,
  Input,
  type ContextMenuItem
} from "../ui";
```

Add the feature imports (near the `Editor`/`useApi` imports):

```ts
import { gatherFromInput } from "../../lib/files";
import { useFileUpload } from "./use-file-upload";
import { UploadConflictModal } from "./UploadConflictModal";
```

- [ ] **Step 2: Wire the hook + hidden inputs + an upload trigger inside the `FileBrowser` component**

Right after the existing `useState` declarations (after `const [error, setError] = useState…`, ~line 42) and before `loadDir`, add:

```ts
  const upload = useFileUpload(api, (dir) => {
    void loadDir(dir);
    setExpanded((prev) => new Set(prev).add(dir));
  });
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Destination for the *next* button-triggered pick (root, or a context dir).
  const uploadDestRef = useRef<string>(rootPath);

  const pickUpload = (dest: string, mode: "files" | "folder") => {
    uploadDestRef.current = dest;
    (mode === "folder" ? folderInputRef : filesInputRef).current?.click();
  };

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (list && list.length > 0) {
      void upload.start(uploadDestRef.current, gatherFromInput(list));
    }
    event.target.value = ""; // allow re-picking the same path
  };
```

`loadDir` must exist before this — it's defined just below with `useCallback`; move the `upload`/`pickUpload`/`onInputChange` block to **after** the `loadDir` `useCallback` definition (so `loadDir` is in scope). Place it immediately after the `loadDir` definition (~line 54) and before the `useEffect`. Add `useRef` to the top-level React import:

```ts
import React, { useCallback, useEffect, useRef, useState } from "react";
```

- [ ] **Step 3: Add the Upload menu to the toolbar**

In the toolbar row (the `flex h-9 …` div, ~lines 124-137), insert an `AdaptiveMenu` between the New-folder `IconButton` and the Refresh `IconButton`:

```tsx
          <IconButton label="New folder" onClick={() => startCreate(rootPath, "dir")}>
            <FolderPlus size={14} />
          </IconButton>
          <AdaptiveMenu
            title="Upload"
            align="right"
            width="w-44"
            trigger={
              <IconButton label="Upload">
                <Upload size={14} />
              </IconButton>
            }
          >
            <DropdownItem icon={<FilePlus size={14} />} onClick={() => pickUpload(rootPath, "files")}>
              Upload files…
            </DropdownItem>
            <DropdownItem icon={<FolderPlus size={14} />} onClick={() => pickUpload(rootPath, "folder")}>
              Upload folder…
            </DropdownItem>
          </AdaptiveMenu>
          <IconButton label="Refresh" onClick={() => void loadDir(activeDir)}>
            <RefreshCw size={13} />
          </IconButton>
```

> Note: `IconButton` is the `AdaptiveMenu` trigger here. `AdaptiveMenu`/`Dropdown` wraps the trigger in its own `<button>`, so the inner `IconButton`'s click is handled by the wrapper — that's fine (the wrapper toggles the menu). Keep the `IconButton`'s `label` for the tooltip/aria.

- [ ] **Step 4: Add the hidden file inputs**

Just inside the outermost return container (right after the opening `<div className="flex h-full min-h-0 bg-neutral-950">`, ~line 116), add the two hidden inputs:

```tsx
      <input ref={filesInputRef} type="file" multiple hidden onChange={onInputChange} />
      <input
        ref={folderInputRef}
        type="file"
        hidden
        onChange={onInputChange}
        // webkitdirectory isn't in React's input typings — set via ref attrs.
        ref={(el) => {
          folderInputRef.current = el;
          if (el) {
            el.setAttribute("webkitdirectory", "");
            el.setAttribute("directory", "");
          }
        }}
      />
```

> A single `ref` per element — the folder input above shows the callback-ref form that both stores the node AND sets the non-standard `webkitdirectory`/`directory` attributes (React has no prop for them). Remove the earlier `ref={folderInputRef}` line on that element so there is exactly one `ref`; the `filesInputRef` input keeps its plain `ref`.

- [ ] **Step 5: Add Upload to the right-click context menu**

In `menuItems` (~lines 107-113), add two items targeting the clicked dir:

```ts
  const menuItems: ContextMenuItem[] = menu
    ? [
        { label: "New File", icon: <FilePlus size={14} />, onClick: () => startCreate(menu.dir, "file") },
        { label: "New Folder", icon: <FolderPlus size={14} />, onClick: () => startCreate(menu.dir, "dir") },
        { label: "Upload Files…", icon: <Upload size={14} />, onClick: () => pickUpload(menu.dir, "files") },
        { label: "Upload Folder…", icon: <Upload size={14} />, onClick: () => pickUpload(menu.dir, "folder") },
        { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void loadDir(menu.dir) }
      ]
    : [];
```

- [ ] **Step 6: Render the status line, conflict modal, and big-folder confirm**

Add a status line above the tree (inside the tree sub-sidebar, right after the toolbar `div` closes, before the scroll container ~line 138):

```tsx
        {upload.status && (
          <p
            className={cn(
              "border-b border-neutral-800 px-3 py-1 text-[11px]",
              upload.status.error ? "text-red-400" : "text-neutral-400"
            )}
          >
            {upload.status.text}
          </p>
        )}
```

At the end of the outermost container, next to the existing `{menu && <ContextMenu …/>}` (~line 186), add:

```tsx
      <UploadConflictModal prompt={upload.conflict} />
      <ConfirmDialog
        open={upload.bigFolder !== null}
        danger={false}
        title="Upload a large folder?"
        confirmLabel="Upload"
        message={
          upload.bigFolder
            ? `This will upload ${upload.bigFolder.count.toLocaleString()} files (${Math.round(
                upload.bigFolder.bytes / (1024 * 1024)
              ).toLocaleString()} MB). Folders like node_modules can be very large.`
            : ""
        }
        onConfirm={upload.confirmBigFolder}
        onCancel={upload.cancelBigFolder}
      />
```

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 8: Drive the button path in the real SPA**

Run (separate shells, from repo root): `pnpm dev:daemon` and `pnpm dev:web`. Open `http://localhost:5173`, log in (stage password `123456`), open a project's **Files** tab, then:

1. Toolbar **Upload ▸ Upload files…** → pick 2 files → both appear at the project root; the status line shows progress then clears.
2. Toolbar **Upload ▸ Upload folder…** → pick a nested folder → structure is recreated under the root.
3. Re-run (1) with the same 2 files → the conflict modal appears; choose **Keep both** → `name (1).ext` appears. Repeat, tick **apply to all**, choose **Skip** → nothing changes.
4. Right-click a sub-folder → **Upload Files…** → file lands inside that folder, not the root.
5. (If feasible) pick a folder with >500 files → the "Upload a large folder?" confirm appears first; Cancel aborts.

Expected: all behaviors as described; `pnpm check` still clean.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/components/files/FileBrowser.tsx
git commit -m "feat(ui/files): upload button/menu + context-menu, conflict & big-folder modals"
```

---

### Task 8: FileBrowser — drag-drop targets on the tree

**Files:**
- Modify: `packages/ui/src/components/files/FileBrowser.tsx`

**Interfaces:**
- Consumes: `gatherFromDataTransfer` (Task 4); `upload.start`, `dropTarget` state (this task); the existing `TreeLevel` props.
- Produces: dropping OS files/folders onto a folder row (or empty tree space → root) uploads into that folder, with a drag-over highlight.

- [ ] **Step 1: Import `gatherFromDataTransfer` and add drop state + handler**

Extend the `lib/files` import:

```ts
import { gatherFromDataTransfer, gatherFromInput } from "../../lib/files";
```

In the `FileBrowser` component, add drop-target state (next to the other `useState`s):

```ts
  const [dropTarget, setDropTarget] = useState<string | null>(null);
```

Add a drop handler (near `pickUpload`):

```ts
  const onDropTo = async (dir: string, dt: DataTransfer) => {
    setDropTarget(null);
    const items = await gatherFromDataTransfer(dt);
    if (items.length > 0) {
      void upload.start(dir, items);
    }
  };
```

- [ ] **Step 2: Make the tree scroll-container a drop zone for empty space → root**

On the scroll container `div` (the `min-h-0 flex-1 overflow-auto py-1` element, ~lines 139-142), add drag handlers and a root-target ring:

```tsx
        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto py-1",
            dropTarget === rootPath && "ring-1 ring-inset ring-neutral-600"
          )}
          onContextMenu={(e) => openMenu(e, rootPath)}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              e.preventDefault();
              setDropTarget(rootPath);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) {
              setDropTarget(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            void onDropTo(rootPath, e.dataTransfer);
          }}
        >
```

- [ ] **Step 3: Thread drop props into `TreeLevel` and wire row drop targets**

Extend `TreeLevelProps`:

```ts
interface TreeLevelProps {
  dir: string;
  depth: number;
  childrenByPath: Record<string, FsEntry[]>;
  expanded: Set<string>;
  selectedFile: string | null;
  activeDir: string;
  dropTarget: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, dir: string) => void;
  onDragTo: (dir: string | null) => void;
  onDropTo: (dir: string, dt: DataTransfer) => void;
}
```

Pass the new props where `<TreeLevel … />` is rendered in `FileBrowser` (~line 162):

```tsx
          <TreeLevel
            dir={rootPath}
            depth={0}
            childrenByPath={childrenByPath}
            expanded={expanded}
            selectedFile={selectedFile}
            activeDir={activeDir}
            dropTarget={dropTarget}
            onToggleDir={toggleDir}
            onSelectFile={selectFile}
            onContextMenu={openMenu}
            onDragTo={setDropTarget}
            onDropTo={(dir, dt) => void onDropTo(dir, dt)}
          />
```

In the `TreeLevel` row `<button>` (~lines 223-246), compute the drop dir (folder → itself, file → parent), add drag handlers, and highlight when targeted. Replace the row `<button>`'s opening tag + className with:

```tsx
            <button
              type="button"
              onClick={() => (isDir ? props.onToggleDir(entry.path) : props.onSelectFile(entry.path))}
              onContextMenu={(e) => props.onContextMenu(e, isDir ? entry.path : parentOf(entry.path))}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.types).includes("Files")) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDragTo(isDir ? entry.path : parentOf(entry.path));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onDropTo(isDir ? entry.path : parentOf(entry.path), e.dataTransfer);
              }}
              style={{ paddingLeft: 8 + props.depth * 12 }}
              className={cn(
                "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm",
                isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900",
                isDir && props.dropTarget === entry.path && "bg-neutral-800 ring-1 ring-inset ring-neutral-600"
              )}
            >
```

> The row `onDragOver`/`onDrop` call `stopPropagation`, so the container handler (Step 2) only fires for empty space. A file row resolves its target to `parentOf(entry.path)`, which highlights the *containing* folder row.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Drive the drag-drop path in the real SPA**

With `pnpm dev:daemon` + `pnpm dev:web` running and a project's Files tab open:

1. Drag a file from the OS file explorer onto a **folder row** → that row highlights → drop → file lands inside it.
2. Drag a file onto a **file row** → the containing folder row highlights → drop → file lands in that parent folder.
3. Drag onto **empty tree space** → the tree gets the root ring → drop → file lands at the project root.
4. **Merge test (the spec's worked example):** in the project, create `folder 1/file_a.txt` and `folder 1/folder 2/file_b.txt`. On the PC make `folder 1` with `file_a.txt`, `folder 2/file_c.txt`, `folder 3/file_d.txt`. Drag PC `folder 1` onto the project root → `file_a.txt` prompts (Replace/Skip/Keep both); after resolving, `folder 2/file_c.txt` and `folder 3/file_d.txt` are created and `folder 2/file_b.txt` is untouched.

Expected: all behaviors as described.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/files/FileBrowser.tsx
git commit -m "feat(ui/files): drag-drop upload onto tree folders with target highlight"
```

---

### Task 9: End-to-end verification & cleanup

**Files:** none (verification only)

- [ ] **Step 1: Full `pnpm check`**

Run: `pnpm check`
Expected: PASS across all packages.

- [ ] **Step 2: Cross-runtime + sandbox sweep**

With the staged daemon + SPA running, confirm the full spec verification list end-to-end:
1. Single file & folder via button (root + context-menu folder destinations).
2. Drag-drop onto folder row, file row (→ parent), empty space (→ root).
3. Conflict dispositions: Replace, Skip, Keep both (`foo (1).txt`), apply-to-all.
4. Type clash: upload a file where a same-named folder exists → modal omits **Replace** (Skip / Keep both only); upload resolves without a crash.
5. Size cap: include a >25 MB file → it's skipped + reported, others still upload.
6. Big-folder guard: a >500-file folder → confirm appears first; Cancel aborts.
7. Sandbox: confirmed in Task 2 step 5 (traversal → 400, out-of-root destDir → 403).
8. Desktop runtime (optional but preferred): `pnpm dev` (Electron) → repeat (1) and the merge test over the Unix-socket bridge.

- [ ] **Step 3: Confirm the terminal still uploads (no regression from the Task 3 extraction)**

In a terminal/agent session, drag an image in → it still uploads and injects its path (proves the `fileToBase64` move didn't break `TerminalView`).

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(ui/files): verify file/folder upload end-to-end"
```

(If no fixes were needed, skip — the feature is already committed across Tasks 1-8.)

---

## Self-Review

**Spec coverage:**
- Toolbar Upload button + Files/Folder menu → Task 7 (§ Step 3). Context-menu items → Task 7 (§ Step 5). ✓
- Drag-drop onto target folder / file-parent / root, with highlight → Task 8. ✓
- New `POST /api/fs/upload`, exclusive-write, conflict tagging, rename, ENOSPC, sandbox → Task 2. ✓
- Wire types + client methods (reference + UI) → Tasks 1, 3. ✓
- Recursive merge semantics → falls out of Task 2's per-relative-path write; verified Task 8 §5.4 / Task 9 §2. ✓
- Prompt-per-conflict with Replace/Skip/Keep-both + apply-to-all, dir-clash hides Replace → Tasks 5 (driver) + 6 (modal). ✓
- Folder gathering (webkitGetAsEntry recursion + webkitdirectory input) → Task 4. ✓
- Shared `fileToBase64` extraction (dedup with TerminalView) → Task 3. ✓
- 25 MB per-file cap + big-folder (>500 files / >200 MB) confirm → Tasks 5 (thresholds) + 7 (confirm modal). ✓
- Runtime parity (web + desktop) → Task 9 §2.8. ✓
- Status/progress line + error reporting → Tasks 5 (status state) + 7 (render). ✓

**Placeholder scan:** No "TBD/TODO". Every code step shows full code; every run step shows the command + expected result. ✓

**Type consistency:** `FsUploadRequest`/`FsUploadResponse` identical across Tasks 1/2/3. `uploadFsEntry` signature identical in the reference client (Task 1) and `ApiClient` (Task 3). `UploadItem`, `gatherFromInput`, `gatherFromDataTransfer` defined in Task 4, consumed in Tasks 5/7/8 with matching signatures. `useFileUpload`/`ConflictPrompt`/`ConflictChoice`/`UploadStatus` defined in Task 5, consumed in Tasks 6/7 unchanged. `onConflict` values `"error"|"overwrite"|"rename"` consistent daemon↔client. Conflict `kind`/`conflictKind` `"file"|"dir"` consistent. ✓
