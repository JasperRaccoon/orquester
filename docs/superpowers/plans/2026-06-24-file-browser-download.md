# File Browser Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users download a file (as-is) or a folder (zipped on the server) out of a project's file tree — via a right-click **Download** context-menu item and a download button in the file-preview header — in both the web client and the desktop app.

**Architecture:** A new daemon route `GET /api/fs/download?path=` stats the path and either streams the file (`createReadStream`, uncapped, `Content-Disposition: attachment`) or streams a zip of the folder produced by a host tool (`bsdtar`/`zip`/`7z`) spawned to stdout via the existing `reply.hijack()` pattern. A new `apps/daemon/src/zip.ts` resolves the tool off PATH (reusing `archive.ts`'s `onPath`) with **store-symlinks-not-follow** flags. The route also accepts the credential as `?token=` (only on this route, mirroring `/ws`) so a native browser `<a download>` can authenticate. On the client, a `lib/download.ts` orchestrator picks native-browser-streaming (HTTP transports) vs a buffered bytes fetch + blob save (the desktop unix socket) by `transporter.kind`.

**Tech Stack:** TypeScript ESM, Fastify 4 (daemon routes + `reply.hijack()` streaming), `node:child_process` `spawn` (host zip tool), React 18 + Tailwind (UI), the shared `Transporter` (HTTP for web / unix-socket bridge for desktop), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-06-24-file-browser-download-design.md`

## Global Constraints

- **ESM everywhere**, TypeScript `strict`, `noEmit` — the daemon runs `.ts` via tsx; there is no build step for the daemon or packages (they import each other's `src` directly). `pnpm dev:daemon` uses `tsx watch`, so it hot-reloads on file changes (the module-scope tool cache resets on reload).
- **Pre-commit gate is `pnpm check`** (`pnpm -r typecheck`, i.e. `tsc --noEmit`). It must be clean after every task.
- **No unit-test runner exists, by design (AGENTS.md).** "Done" = `pnpm check` clean **and** the real surface was driven (daemon API over the socket, the SPA in a browser). This plan replaces classic write-a-failing-test TDD with: implement → `pnpm check` → a concrete behavioral check against the running staged daemon/SPA → commit. Do **not** add a test framework.
- **Commit to the current branch as-is** (AGENTS.md) — do NOT create a new branch.
- **Sandbox:** every `/api/fs/*` path is resolved through `assertInsideFsRoot(resolved.fsRoot, …)` (returns the safe resolved path, throws `FsSandboxError` → 403 `FS_FORBIDDEN`). The download route is no exception.
- **Symlink containment is a security requirement:** the zip tool must STORE symlinks as links, never follow them, so a link inside a folder can't make the daemon read outside `fsRoot`. Flags: `bsdtar` stores by default; `zip -y`; `7z -snl`.
- **`?token=` is scoped to `/api/fs/download` only.** Every other `/api/*` route stays header-only. The credential is the base64 bearer the client already holds on `connection.password` (a bcrypt hash). The log serializer already redacts `token=` from URLs.
- **Do not change `/api/fs/raw`** (the capped, in-memory inline-preview route) or the preview size caps in `packages/ui/src/lib/file-kind.ts`. Download is a separate, uncapped path.
- **Conventional commits** with scopes matching git history (`feat(api): …`, `feat(daemon): …`, `feat(daemon/fs): …`, `feat(ui): …`, `feat(ui/files): …`, `docs(files): …`).

---

### Task 1: Wire contract — `FsCapabilitiesResponse` + reference client `getFsCapabilities`

**Files:**
- Modify: `packages/api/src/index.ts` (add the type after `FsUploadResponse` ~line 217; add the method in `HttpOrquesterApiClient` after `uploadFsEntry` ~line 586)

**Interfaces:**
- Produces: `FsCapabilitiesResponse { folderZip: boolean; zipTool: string | null }` and `HttpOrquesterApiClient.getFsCapabilities(): Promise<FsCapabilitiesResponse>`.

- [ ] **Step 1: Add the response type**

In `packages/api/src/index.ts`, immediately after the `FsUploadResponse` interface (the block ending ~line 217, just before the `// Git —` comment), add:

```ts
/** Server-side file-browser capabilities (GET /api/fs/capabilities). */
export interface FsCapabilitiesResponse {
  /** True when the server can produce a folder zip (a zip tool is on PATH). */
  folderZip: boolean;
  /** Resolved zip tool basename for diagnostics ("bsdtar"|"zip"|"7z"|…), or null. */
  zipTool: string | null;
}
```

- [ ] **Step 2: Add the reference-client method**

In the same file, in `HttpOrquesterApiClient`, right after `uploadFsEntry` (~line 586), add:

```ts
  getFsCapabilities(): Promise<FsCapabilitiesResponse> {
    return this.get("/api/fs/capabilities");
  }
```

(`FsCapabilitiesResponse` is declared in this same file, so no import is needed. `OrquesterApi` does not need the method — the class already implements methods beyond that interface, e.g. `uploadFsEntry`.)

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): add FsCapabilitiesResponse + getFsCapabilities"
```

---

### Task 2: Daemon zip module — `apps/daemon/src/zip.ts`

**Files:**
- Create: `apps/daemon/src/zip.ts`
- Modify: `apps/daemon/src/archive.ts` (export `onPath` so the zip module reuses the PATH probe — change `function onPath` to `export function onPath` ~line 26)

**Interfaces:**
- Consumes: `onPath(bin: string): boolean` from `./archive`.
- Produces: `type ZipTool = { bin: string; kind: "bsdtar" | "zip" | "7z" }`, `resolveZipTool(): ZipTool | null`, `spawnDirZip(absDir: string): ChildProcessWithoutNullStreams | null`. Consumed by Task 3.

- [ ] **Step 1: Export `onPath` from `archive.ts`**

In `apps/daemon/src/archive.ts`, change the `onPath` declaration (~line 26) from:

```ts
function onPath(bin: string): boolean {
```

to:

```ts
export function onPath(bin: string): boolean {
```

(No other change to `archive.ts`.)

- [ ] **Step 2: Create `apps/daemon/src/zip.ts`**

```ts
/**
 * Folder → zip for the file browser's download feature. Spawns a host zip tool
 * (libarchive's bsdtar preferred, then Info-ZIP `zip`, then 7-Zip) that writes a
 * .zip to STDOUT, so the route can stream it without buffering the whole archive
 * in memory. The tool is run with an argument array (no shell) and a cwd of the
 * folder's PARENT with the folder's basename as the single entry, so in-zip
 * paths are relative to the folder.
 *
 * SECURITY: every tool is invoked with store-symlinks-as-links flags (NOT
 * follow). The folder path is already assertInsideFsRoot'd by the caller, but a
 * symlink INSIDE the folder could point outside fsRoot — following it would let
 * the daemon read out-of-sandbox files into the zip. Storing the link is both
 * safe and the correct/standard archive behavior (also keeps symlink-heavy trees
 * like pnpm node_modules small).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname } from "node:path";
import { onPath } from "./archive";

export type ZipTool = { bin: string; kind: "bsdtar" | "zip" | "7z" };

let resolvedZip: ZipTool | null | undefined;

/** First available zip-writing tool on PATH, resolved once and cached. */
export function resolveZipTool(): ZipTool | null {
  if (resolvedZip !== undefined) return resolvedZip;
  // bsdtar stores symlinks by default and reliably writes a zip to stdout.
  if (onPath("bsdtar")) return (resolvedZip = { bin: "bsdtar", kind: "bsdtar" });
  if (onPath("zip")) return (resolvedZip = { bin: "zip", kind: "zip" });
  for (const bin of ["7z", "7zz", "7za"]) {
    if (onPath(bin)) return (resolvedZip = { bin, kind: "7z" });
  }
  return (resolvedZip = null);
}

/**
 * Spawn the resolved tool to write a zip of `absDir` to stdout. Returns null
 * when no tool is on PATH. The caller pipes `child.stdout` to the response,
 * drains `child.stderr`, kills the child on client disconnect, and destroys the
 * response on `child` error.
 */
export function spawnDirZip(absDir: string): ChildProcessWithoutNullStreams | null {
  const tool = resolveZipTool();
  if (!tool) return null;
  const cwd = dirname(absDir);
  const base = basename(absDir);
  const argv =
    tool.kind === "bsdtar"
      ? ["-c", "--format", "zip", "-f", "-", base] // -f - : write to stdout
      : tool.kind === "zip"
        ? ["-r", "-y", "-q", "-", base] // -y store symlinks; "-" archive == stdout
        : ["a", "-tzip", "-snl", "-so", "--", base]; // -snl store links; -so stdout
  return spawn(tool.bin, argv, { cwd });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS. (`spawn(cmd, args, { cwd })` with no `stdio` option returns `ChildProcessWithoutNullStreams`, so `child.stdout`/`child.stderr` are non-null.)

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/zip.ts apps/daemon/src/archive.ts
git commit -m "feat(daemon): add zip.ts (host-tool folder zip to stdout, symlink-safe)"
```

---

### Task 3: Daemon routes — `GET /api/fs/download` + `GET /api/fs/capabilities` + `?token=` auth

**Files:**
- Modify: `apps/daemon/src/index.ts` (add `FsCapabilitiesResponse` to the `@orquester/api` type import ~lines 1-37; add `createReadStream` to the `node:fs` import line 77; import the zip helpers ~after line 44; extend the `onRequest` auth hook ~lines 374-379; add the two routes after the `/api/fs/archive` handler ~line 928; add the `contentDisposition` helper after `FsSandboxError` ~line 1934)

**Interfaces:**
- Consumes: `FsCapabilitiesResponse` (Task 1); `resolveZipTool`, `spawnDirZip` (Task 2); existing `assertInsideFsRoot`, `FsSandboxError`, `resolved.fsRoot`, `authorizeCredential`, `stat`, `basename`, the `reply.hijack()` streaming pattern.
- Produces: `GET /api/fs/download`, `GET /api/fs/capabilities`, and `function contentDisposition(name: string): string`.

- [ ] **Step 1: Extend the imports**

In `apps/daemon/src/index.ts`, add `FsCapabilitiesResponse,` to the `@orquester/api` type-import block (alongside the other `Fs*` types, ~line 9-15):

```ts
  FsCapabilitiesResponse,
  FsCreateRequest,
  FsEntry,
```

On the `node:fs` import (line 77), add `createReadStream`:

```ts
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
```

Just after the `import { listArchiveEntries } from "./archive";` line (line 44), add:

```ts
import { resolveZipTool, spawnDirZip } from "./zip";
```

- [ ] **Step 2: Accept `?token=` on the download route in the auth hook**

In the `onRequest` hook, replace the `authorizeCredential(...)` call (lines 375-379) — currently:

```ts
    const authorized = authorizeCredential(
      request.headers.authorization?.replace(/^Bearer\s+/i, ""),
      config.transports.http.username,
      config.transports.http.passwordHash
    );
```

with:

```ts
    // A browser download navigation (<a download>) can't set an Authorization
    // header, so /api/fs/download also accepts the credential as ?token= — the
    // same trick /ws uses. Scoped to this one route; the token is redacted from
    // logs by the request serializer above.
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryToken = url === "/api/fs/download" ? (request.query as { token?: string }).token : undefined;
    const authorized = authorizeCredential(
      headerToken ?? queryToken,
      config.transports.http.username,
      config.transports.http.passwordHash
    );
```

(`url` is already computed at line 358 as `request.url.split("?")[0]`.)

- [ ] **Step 3: Add the `/api/fs/capabilities` and `/api/fs/download` routes**

Immediately after the `GET /api/fs/archive` handler (the block ending ~line 928), add:

```ts
  // File-browser capabilities probe: whether the server can zip a folder for
  // download (a zip tool is on PATH). Single-file download never needs a tool.
  app.get("/api/fs/capabilities", async (): Promise<FsCapabilitiesResponse> => {
    const tool = resolveZipTool();
    return { folderZip: tool !== null, zipTool: tool?.bin ?? null };
  });

  // Download a file (streamed, uncapped) or a folder (zipped on the fly via a
  // host tool, streamed). Distinct from /api/fs/raw, which is the 50 MB-capped,
  // in-memory inline-preview route. Auth: this route also accepts ?token= (see
  // the onRequest hook) so a native <a download> works without a header.
  app.get<{ Querystring: { path?: string } }>("/api/fs/download", async (request, reply) => {
    const path = request.query.path;
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    let safe: string;
    try {
      safe = await assertInsideFsRoot(resolved.fsRoot, path);
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot resolve path."
      });
      return;
    }

    let info;
    try {
      info = await stat(safe);
    } catch {
      void reply.code(404).send({ code: "FS_ERROR", message: "Not found." });
      return;
    }
    const name = basename(safe);

    // File: stream the bytes as-is. createReadStream (not readFile) means no
    // memory cap; Content-Length from the stat gives the browser a progress bar.
    if (info.isFile()) {
      void reply
        .header("Content-Disposition", contentDisposition(name))
        .header("Content-Length", String(info.size))
        .header("X-Content-Type-Options", "nosniff")
        .type("application/octet-stream")
        .send(createReadStream(safe));
      return;
    }

    // Directory: spawn a zip tool and stream its stdout (hijack pattern, as the
    // session-output route does). Zip size is unknown up front, so it's chunked.
    if (info.isDirectory()) {
      const child = spawnDirZip(safe);
      if (!child) {
        void reply.code(501).send({
          code: "FS_UNSUPPORTED",
          message: "No zip tool (bsdtar/zip/7z) on the server PATH."
        });
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": contentDisposition(`${name}.zip`),
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache"
      });
      // pipe() ends reply.raw when stdout ends. Drain stderr so a chatty tool
      // (zip warns on e.g. empty dirs) can't block on a full pipe. Kill the
      // child if the client disconnects; destroy the socket on a spawn error.
      child.stdout.pipe(reply.raw);
      child.stderr.resume();
      child.on("error", () => reply.raw.destroy());
      request.raw.on("close", () => child.kill());
      return;
    }

    void reply.code(400).send({ code: "FS_ERROR", message: "Not a file or folder." });
  });
```

- [ ] **Step 4: Add the `contentDisposition` helper**

Immediately after the `class FsSandboxError extends Error {}` line (~line 1934), add:

```ts
/**
 * Build a `Content-Disposition: attachment` value. The ASCII filename="" form is
 * a fallback with control/quote/backslash and non-ASCII bytes replaced by "_";
 * the RFC 5987 filename*=UTF-8'' form carries the real (possibly non-ASCII) name
 * for browsers that honor it.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Drive the routes over the Unix socket (no auth) + a zip tool check**

Start the staged daemon (`tsx watch`, serves the same routes on its no-auth Unix socket; `fsRoot` = `.stage/workspaces`):

Run (separate shell, repo root): `pnpm dev:daemon`

Then, from the repo root:

```bash
SOCK=.stage/daemon/daemon.sock
DIR=$(ls -d "$PWD"/.stage/workspaces/*/*/ 2>/dev/null | head -1); DIR=${DIR%/}
echo "dir=$DIR"

# 0) Capabilities — expect {"folderZip":true,"zipTool":"bsdtar|zip|7z"}.
#    If folderZip:false, install a tool: `sudo apt-get install -y libarchive-tools`
#    (bsdtar) or `zip` or `p7zip-full` (7z), then re-run.
curl -s --unix-socket "$SOCK" http://localhost/api/fs/capabilities; echo

# 1) File download — headers show Content-Disposition: attachment; bytes match.
FILE=$(find "$DIR" -maxdepth 2 -type f | head -1); echo "file=$FILE"
curl -s --unix-socket "$SOCK" -D - -o out.bin --get --data-urlencode "path=$FILE" \
  http://localhost/api/fs/download | grep -i 'content-disposition\|content-length'
cmp "$FILE" out.bin && echo "BYTES OK"

# 2) Folder download — a valid zip.
curl -s --unix-socket "$SOCK" -o out.zip --get --data-urlencode "path=$DIR" \
  http://localhost/api/fs/download
unzip -t out.zip | tail -1   # expect "No errors detected ..."

# 3) Traversal — expect 403.
curl -s --unix-socket "$SOCK" -o /dev/null -w "%{http_code}\n" --get \
  --data-urlencode "path=../../etc/passwd" http://localhost/api/fs/download

# 4) Symlink containment — a link INSIDE the folder pointing OUTSIDE fsRoot must
#    be stored as a link, NOT followed (its contents must not leak into the zip).
echo "SECRET-OUTSIDE-FSROOT" > "$PWD/.stage/secret_outside.txt"   # outside fsRoot (=.stage/workspaces)
mkdir -p "$DIR/__linktest"; ln -sf "$PWD/.stage/secret_outside.txt" "$DIR/__linktest/escape"
curl -s --unix-socket "$SOCK" -o link.zip --get --data-urlencode "path=$DIR/__linktest" \
  http://localhost/api/fs/download
unzip -p link.zip '__linktest/escape' 2>/dev/null | grep -q "SECRET-OUTSIDE-FSROOT" \
  && echo "FAIL: symlink was followed (leak!)" || echo "OK: symlink stored, not followed"

# cleanup
rm -f out.bin out.zip link.zip "$PWD/.stage/secret_outside.txt"; rm -rf "$DIR/__linktest"
```

Expected: (0) `folderZip:true`; (1) a `content-disposition: attachment; filename="…"` header + `BYTES OK`; (2) `No errors detected`; (3) `403`; (4) `OK: symlink stored, not followed`.

- [ ] **Step 7: Verify the route is auth-gated over HTTP (negative check)**

The staged daemon also serves HTTP on `127.0.0.1:47831` with auth (stage password `123456`). A download with no credential must be rejected:

```bash
curl -s -o /dev/null -w "%{http_code}\n" 'http://127.0.0.1:47831/api/fs/download?path=/x'
```

Expected: `401` (proves the route is gated; the valid-`?token=` path is exercised end-to-end from the SPA in Task 6).

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon/fs): add GET /api/fs/download + /api/fs/capabilities (+ ?token=)"
```

---

### Task 4: UI `ApiClient` — `getFsCapabilities`, `buildDownloadUrl`, `downloadBytes`

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (add `FsCapabilitiesResponse` to the `@orquester/api` type import ~lines 11-15; add the three methods in the `--- File browser ---` section after `listArchive` ~line 241)

**Interfaces:**
- Consumes: `FsCapabilitiesResponse` (Task 1); existing `this.connection` (`UiConnection` with `endpoint`/`password`), `this.transportKind`, `this.transporter.requestBytes`, `ApiError`.
- Produces: `getFsCapabilities(signal?): Promise<FsCapabilitiesResponse>`, `buildDownloadUrl(path: string): string | null`, `downloadBytes(path: string, signal?): Promise<ArrayBuffer>`. Consumed by Task 5.

- [ ] **Step 1: Add the type to the import**

In `packages/ui/src/lib/api-client.ts`, add `FsCapabilitiesResponse,` to the `@orquester/api` type-import block (alongside `FsArchiveResponse`, ~line 11):

```ts
  FsArchiveResponse,
  FsCapabilitiesResponse,
  FsListResponse,
```

- [ ] **Step 2: Add the three methods**

In the `--- File browser ---` section, right after `listArchive` (~line 241), add:

```ts
  getFsCapabilities(signal?: AbortSignal): Promise<FsCapabilitiesResponse> {
    return this.send("GET", "/api/fs/capabilities", { signal });
  }

  /**
   * Build an authenticated URL for a native browser download (<a download>) of a
   * file or folder zip — or null when the transport can't be reached that way
   * (the desktop unix socket). The bearer rides as ?token= because a download
   * navigation can't set an Authorization header; the daemon accepts it only on
   * this route.
   */
  buildDownloadUrl(path: string): string | null {
    if (this.transportKind !== "http") {
      return null;
    }
    const base = this.connection.endpoint.replace(/\/$/, "");
    const params = new URLSearchParams({ path });
    if (this.connection.password) {
      params.set("token", this.connection.password);
    }
    return `${base}/api/fs/download?${params.toString()}`;
  }

  /**
   * Buffered download (file bytes or a folder zip) for transports without a
   * native download URL (the desktop unix socket). Rides requestBytes, the same
   * channel readFileBytes uses.
   */
  async downloadBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) {
      throw new Error("Download is not supported on this connection.");
    }
    const response = await this.transporter.requestBytes({
      method: "GET",
      path: "/api/fs/download",
      query: { path },
      signal
    });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", "/api/fs/download", response.headers, undefined);
    }
    return response.data;
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS. (`this.connection` is public; `this.transportKind` is the existing getter at ~line 71; `this.transporter` and `ApiError` are in scope.)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/api-client.ts
git commit -m "feat(ui): add ApiClient download methods (capabilities, url, bytes)"
```

---

### Task 5: UI download helpers — `lib/files.ts` `downloadUrl` + `lib/download.ts` `downloadPath`

**Files:**
- Modify: `packages/ui/src/lib/files.ts` (append after `downloadBlob` ~line 119)
- Create: `packages/ui/src/lib/download.ts`

**Interfaces:**
- Consumes: `downloadBlob` (existing), `downloadUrl` (this task); `ApiClient.buildDownloadUrl`/`downloadBytes` (Task 4).
- Produces: `downloadUrl(url: string, filename: string): void` (in `lib/files`); `interface DownloadTarget { path: string; name: string; kind: "dir" | "file" }`, `downloadPath(api: ApiClient, target: DownloadTarget): Promise<void>` (in `lib/download`). Consumed by Tasks 6 & 7.

- [ ] **Step 1: Append `downloadUrl` to `lib/files.ts`**

After the `downloadBlob` function (the block ending ~line 119), add:

```ts
/**
 * Trigger a browser download from a URL (the server sets the real filename via
 * Content-Disposition; `filename` is only a fallback hint). Unlike downloadBlob
 * there's no object URL to revoke — this is a real URL the browser streams to
 * disk via its own download manager.
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
```

- [ ] **Step 2: Create `packages/ui/src/lib/download.ts`**

```ts
import type { ApiClient } from "./api-client";
import { downloadBlob, downloadUrl } from "./files";

/** A file-tree entry to download. */
export interface DownloadTarget {
  path: string;
  name: string;
  kind: "dir" | "file";
}

/**
 * Download a file (as-is) or a folder (zipped server-side) to the user's disk.
 * HTTP transports (web, desktop→remote) use a native <a download> so the browser
 * streams to disk with no size cap and a progress bar; the desktop unix socket
 * has no reachable URL, so it falls back to a buffered bytes fetch + blob save.
 * A folder downloads as "<name>.zip".
 */
export async function downloadPath(api: ApiClient, target: DownloadTarget): Promise<void> {
  const filename = target.kind === "dir" ? `${target.name}.zip` : target.name;
  const url = api.buildDownloadUrl(target.path);
  if (url) {
    downloadUrl(url, filename);
    return;
  }
  const bytes = await api.downloadBytes(target.path);
  const type = target.kind === "dir" ? "application/zip" : "application/octet-stream";
  downloadBlob(filename, new Blob([bytes], { type }));
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/files.ts packages/ui/src/lib/download.ts
git commit -m "feat(ui/files): add downloadUrl + downloadPath orchestrator"
```

---

### Task 6: FileBrowser — Download in the context menu + capability gate

**Files:**
- Modify: `packages/ui/src/components/files/FileBrowser.tsx`

**Interfaces:**
- Consumes: `downloadPath` (Task 5); `ApiClient.getFsCapabilities` (Task 4); existing `menu.target`, `menuItems`, `ContextMenuItem`, `useApi`.
- Produces: a "Download" / "Download as Zip" context-menu item (folder item disabled when the server reports no zip tool).

- [ ] **Step 1: Add imports**

In `FileBrowser.tsx`, add `Download` and `FolderDown` to the lucide-react import (the block at lines 2-12):

```ts
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FilePlus,
  Folder,
  FolderDown,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload
} from "lucide-react";
```

Add the download-orchestrator import near the other `lib` imports (after the `gatherFromDataTransfer, gatherFromInput` import, ~line 28):

```ts
import { downloadPath } from "../../lib/download";
```

- [ ] **Step 2: Probe folder-zip capability on mount**

Right after the `const [deleting, …] = useState(…)` line (~line 59), add the capability state:

```ts
  // Whether the server can zip a folder. Optimistic (true) until the probe
  // answers, so a fast right-click before it resolves still works on a capable
  // server; if the server has no tool the folder item disables itself.
  const [folderZip, setFolderZip] = useState(true);
```

Add a probe effect next to the other `useEffect`s (e.g. right after the `useEffect` that pins `activeDir`/loads the root, ~line 120):

```ts
  useEffect(() => {
    let alive = true;
    api
      .getFsCapabilities()
      .then((caps) => {
        if (alive) setFolderZip(caps.folderZip);
      })
      .catch(() => {
        /* leave optimistic; a failed download surfaces its own error */
      });
    return () => {
      alive = false;
    };
  }, [api]);
```

- [ ] **Step 3: Add Download to the context menu**

In `menuItems` (~lines 253-264), replace the trailing target-gated block (currently the Delete-only spread at lines 260-262):

```ts
        ...(menu.target
          ? [{ label: "Delete", icon: <Trash2 size={14} />, onClick: () => setDeleting(menu.target!) }]
          : [])
```

with a Download item (file vs folder) plus the existing Delete:

```ts
        ...(menu.target
          ? [
              {
                label: menu.target.kind === "dir" ? "Download as Zip" : "Download",
                icon: menu.target.kind === "dir" ? <FolderDown size={14} /> : <Download size={14} />,
                disabled: menu.target.kind === "dir" && !folderZip,
                onClick: () => void downloadPath(api, menu.target!)
              },
              { label: "Delete", icon: <Trash2 size={14} />, onClick: () => setDeleting(menu.target!) }
            ]
          : [])
```

(`ContextMenuItem` already supports an optional `disabled` field.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Drive the context-menu download in the real SPA**

Run (separate shells, repo root): `pnpm dev:daemon` and `pnpm dev:web`. Open `http://localhost:5173`, log in (stage password `123456`), open a project's **Files** tab, then:

1. Right-click a **file** → **Download** → the browser saves the file; bytes match the original.
2. Right-click a **folder** → **Download as Zip** → the browser saves `<folder>.zip`; opening it shows the folder's contents.
3. Right-click a large file (>50 MB if one exists, or create one) → **Download** → it downloads via the browser's download manager with a progress bar (proves the native ?token= path and the lifted 50 MB cap).
4. (Capability gate) Temporarily make the server report no tool — stop the daemon, remove zip tools from PATH (or rename them), restart `pnpm dev:daemon`; right-click a folder → **Download as Zip** is greyed/disabled. Restore PATH afterward.

Expected: all behaviors as described; `pnpm check` still clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/files/FileBrowser.tsx
git commit -m "feat(ui/files): download in the file-tree context menu (file + folder zip)"
```

---

### Task 7: FilePreview — download button in the preview headers

**Files:**
- Modify: `packages/ui/src/components/files/FilePreview.tsx`

**Interfaces:**
- Consumes: `downloadPath` (Task 5); existing `useApi`, `IconButton` from `../ui`.
- Produces: a download icon button next to Save in `TextPreview`'s header and in the shared `PreviewHeader` (always the single-file path).

- [ ] **Step 1: Add imports**

In `FilePreview.tsx`, add `Download` to the lucide import (line 2):

```ts
import { ArrowLeft, Download, File, Save } from "lucide-react";
```

Add `IconButton` to the `../ui` import (line 3, currently only `Button`):

```ts
import { Button, IconButton } from "../ui";
```

Add the orchestrator import after the `useFileText` import (~line 12):

```ts
import { downloadPath } from "../../lib/download";
```

- [ ] **Step 2: Add a download button + `path` to `PreviewHeader`**

Replace the entire `PreviewHeader` component (lines 86-99) with a version that takes `path`, resolves the api, and renders a download button:

```tsx
/** Shared header for non-text viewers (filename + mobile back + download). */
const PreviewHeader: React.FC<{ path: string; name: string; onBack: () => void }> = ({ path, name, onBack }) => {
  const api = useApi();
  return (
    <div className="flex h-9 items-center gap-2 border-b border-neutral-800 px-2">
      <button
        type="button"
        aria-label="Back to files"
        onClick={onBack}
        className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
      >
        <ArrowLeft size={15} />
      </button>
      <File size={13} className="text-neutral-500" />
      <span className="truncate text-xs text-neutral-300">{name}</span>
      <div className="flex-1" />
      <IconButton label="Download" onClick={() => void downloadPath(api, { path, name, kind: "file" })}>
        <Download size={14} />
      </IconButton>
    </div>
  );
};
```

Update the `PreviewHeader` call site (~line 79) to pass `path`:

```tsx
      <PreviewHeader path={path} name={name} onBack={onBack} />
```

- [ ] **Step 3: Add a download button to the `TextPreview` header**

In `TextPreview`, insert a download button between the `<div className="flex-1" />` spacer (line 130) and the Save `Button` (lines 131-136). The header block becomes:

```tsx
        <div className="flex-1" />
        <IconButton label="Download" onClick={() => void downloadPath(api, { path, name, kind: "file" })}>
          <Download size={14} />
        </IconButton>
        {!readOnly && state === "idle" && (
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
```

(`api` is already in scope in `TextPreview` at line 104; `path` and `name` are too.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Drive the preview-header download in the real SPA**

With `pnpm dev:daemon` + `pnpm dev:web` running and a Files tab open:

1. Open a **text** file → click the **Download** icon next to Save → the file downloads.
2. Open an **image** or **PDF** → click the **Download** icon in the header → the file downloads.
3. Confirm Save still works on an edited text file (the download button didn't displace it).

Expected: all behaviors as described.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/files/FilePreview.tsx
git commit -m "feat(ui/files): download button in the file-preview headers"
```

---

### Task 8: Docs + end-to-end verification & cleanup

**Files:**
- Modify: `AGENTS.md` (add a download note near the "Archive preview is host-tool-gated" gotcha)

- [ ] **Step 1: Document the feature in `AGENTS.md`**

In the **Conventions & gotchas** section, immediately after the bullet that begins "**Archive preview is host-tool-gated.**", add:

```markdown
- **Folder download is host-tool-gated; file download is not.** `GET /api/fs/download`
  streams a file as-is (`createReadStream`, uncapped, `Content-Disposition: attachment`)
  or zips a folder on the fly by shelling out to `bsdtar`/`zip`/`7z` (`apps/daemon/src/zip.ts`,
  reusing `archive.ts`'s PATH probe) and streaming stdout. No tool → `GET /api/fs/capabilities`
  reports `folderZip:false` and the UI disables "Download as Zip" (the VPS's `p7zip-full`
  gives `7z`; add `libarchive-tools`/`zip` if needed). Zip tools are invoked with
  store-symlinks-not-follow flags so a link inside a folder can't read outside `fsRoot`.
  This is the **only** route that accepts the credential as `?token=` (besides `/ws`), so a
  native browser `<a download>` can authenticate; it's redacted from logs. Distinct from
  `/api/fs/raw`, the 50 MB-capped in-memory inline-preview route.
```

- [ ] **Step 2: Full `pnpm check`**

Run: `pnpm check`
Expected: PASS across all packages.

- [ ] **Step 3: Cross-runtime + sandbox sweep**

With the staged daemon + SPA running, confirm the spec's verification list end-to-end:
1. File download — context menu **and** preview header; bytes correct.
2. Folder download — context menu → valid `<name>.zip`.
3. Large file (>50 MB) streams via the browser download manager (no 50 MB error).
4. Capability gate — folder item disabled when no server zip tool.
5. Sandbox — traversal → 403, symlink-not-followed (confirmed in Task 3 step 6); the negative HTTP auth check → 401 (Task 3 step 7).
6. Desktop runtime (preferred): `pnpm dev` (Electron, unix socket) → download a file and a folder; both ride the buffered `downloadBytes` → blob path and save via the Chromium download manager.

- [ ] **Step 4: Commit the docs (and any verification fixes)**

```bash
git add AGENTS.md
git commit -m "docs(files): document the download endpoint + zip-tool gating"
```

(If verification surfaced code fixes, include them in their task's file and commit with the matching scope.)

---

## Self-Review

**Spec coverage:**
- New `GET /api/fs/download` (file stream + folder zip stream, `Content-Disposition`, hijack, disconnect-kill) → Task 3. ✓
- New `apps/daemon/src/zip.ts` (host-tool resolve + stdout zip, store-symlink flags) → Task 2. ✓
- `GET /api/fs/capabilities` (folder-zip gate) → Task 3 (route) + Task 6 (UI gate). ✓
- `?token=` accepted on the download route only, redacted from logs → Task 3 step 2. ✓
- Wire type `FsCapabilitiesResponse` + reference client → Task 1. ✓
- UI `buildDownloadUrl`/`downloadBytes`/`getFsCapabilities` → Task 4. ✓
- Cross-transport `downloadPath` (native href for HTTP, buffered blob for unix) + `downloadUrl` → Task 5. ✓
- Context-menu "Download"/"Download as Zip" (file + folder), gated → Task 6. ✓
- Preview-header download button (TextPreview + PreviewHeader) → Task 7. ✓
- No Electron changes (rides existing requestBytes + Chromium download) → confirmed by Task 8 step 3.6 (no desktop files modified). ✓
- Security: `assertInsideFsRoot`, symlink containment, auth surface → Tasks 2/3, verified Task 3 step 6-7. ✓
- Docs (host-tool gating note) → Task 8. ✓
- Untouched `/api/fs/raw` + preview caps → respected (no task modifies them). ✓

**Placeholder scan:** No "TBD/TODO". Every code step shows full code; every run step shows the command + expected result. ✓

**Type consistency:** `FsCapabilitiesResponse { folderZip: boolean; zipTool: string | null }` identical across Tasks 1 (api + reference client) and 4 (UI import/use). `ZipTool`/`resolveZipTool`/`spawnDirZip` defined in Task 2, consumed in Task 3 with matching signatures (`resolveZipTool(): ZipTool | null`, `spawnDirZip(absDir): ChildProcessWithoutNullStreams | null`). `downloadUrl(url, filename)` defined in Task 5 (files.ts), consumed in Task 5 (download.ts). `DownloadTarget`/`downloadPath(api, target)` defined in Task 5, consumed in Tasks 6 & 7 with `{ path, name, kind }` objects. `buildDownloadUrl(path): string | null`, `downloadBytes(path, signal?): Promise<ArrayBuffer>`, `getFsCapabilities(signal?)` defined in Task 4, consumed in Task 5 (`downloadPath`) and Task 6 (probe). `contentDisposition(name): string` defined and consumed within Task 3. ✓
