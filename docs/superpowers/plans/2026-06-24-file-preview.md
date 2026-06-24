# File Preview (images/PDF/media/archives) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-only file viewer in the project **Files** tab with a viewer that renders images, PDFs (pdf.js), audio, video, and archive content-listings, falling back to a download card — while text files keep today's editable CodeMirror behavior.

**Architecture:** A client-side `FilePreview` dispatcher classifies the selected file by extension and mounts the right viewer. Renderable kinds (image/pdf/audio/video) fetch raw bytes through a new `requestBytes` capability on the existing `Transporter` seam (so it works on both the web `fetch` transport and the desktop IPC bridge) and render from a `blob:`/`ArrayBuffer`. Archives are parsed on the daemon (which shells out to `7z`/`bsdtar`) and only a small JSON listing crosses the wire. Two new read-only, sandboxed daemon routes back this: `GET /api/fs/raw` and `GET /api/fs/archive`.

**Tech Stack:** TypeScript 5.8 ESM (strict, `noEmit`), Fastify 4 (daemon), React 18 + zustand + Tailwind (UI), `pdfjs-dist` (new), node-pty/tmux (unchanged). Daemon runs via tsx (no build).

## Global Constraints

- **Commit to the _current_ branch as-is. Do NOT create a new branch** (AGENTS.md), even on `main`.
- **Pre-commit gate is `pnpm check`** (`tsc --noEmit` across the workspace). It MUST be clean before every commit.
- **No test runner exists.** "Done" = `pnpm check` clean **and** the behavior was driven in the real app/daemon. See "Testing approach" below.
- **ESM everywhere** (`"type":"module"`); the only CJS files are `apps/desktop/src/main.ts`→`main.cjs` and `preload.cjs`.
- **Packages import each other's TS source directly** (`@orquester/api`, `@orquester/ui`, …) — no inter-package build step.
- **`RAW_MAX_BYTES = 50 * 1024 * 1024`** — daemon hard read cap + in-app download ceiling.
- **Per-kind preview cap:** `video: 50 MB`, `image|pdf|audio|binary: 25 MB`.
- **Sandbox:** every fs path goes through `assertInsideFsRoot(resolved.fsRoot, path)`; a thrown `FsSandboxError` maps to `403 FS_FORBIDDEN`.
- **Spawn external tools with an argument array, never a shell string** (mirrors `git.ts`).

## Testing approach (this repo has no unit-test framework)

- **Pure logic** (file-kind detection, archive output parsing) → a throwaway **tsx assertion script** in the session scratchpad, run with `npx tsx`. These are the only true "unit tests".
- **Daemon routes** → **`curl` over the Unix socket** (`--unix-socket .stage/daemon/daemon.sock`), which needs **no auth**. Start the daemon with `pnpm dev:daemon` (staged in `./.stage`, socket appears at `.stage/daemon/daemon.sock`).
- **UI** → drive the web app (`pnpm dev:web`, log in with the stage password `123456`) and visually confirm; the final task confirms the desktop app (`pnpm dev`).
- **Every task** ends with `pnpm check` clean + a commit.

Scratchpad dir for throwaway scripts: `/var/lib/orquester/tmp/.../scratchpad` (use the session scratchpad; do **not** commit these).

## File Structure

**Daemon**
- `apps/daemon/src/index.ts` *(modify)* — `RAW_MAX_BYTES`; `GET /api/fs/raw`; `GET /api/fs/archive`; import `listArchiveEntries`.
- `apps/daemon/src/archive.ts` *(create)* — host archive-tool resolution + listing + output parsing.

**Wire contracts**
- `packages/api/src/index.ts` *(modify)* — `ArchiveEntry`, `FsArchiveResponse`.

**Transport**
- `packages/ui/src/lib/transporter.ts` *(modify)* — optional `requestBytes`.
- `packages/ui/src/lib/http-client.ts` *(modify)* — `HttpClientBytesResponse`, optional `sendBytes`, `FetchHttpClient.sendBytes`.
- `packages/ui/src/lib/transporters/http-transporter.ts` *(modify)* — `requestBytes`.
- `packages/ui/src/index.ts` *(modify)* — export `HttpClientBytesResponse`.
- `packages/ui/src/lib/api-client.ts` *(modify)* — `readFileBytes`, `listArchive`.
- `apps/desktop/src/main.ts` *(modify)* — binary socket+http request fns + `request-bytes` IPC handlers.
- `apps/desktop/src/preload.cjs` *(modify)* — expose `requestBytes`, `httpRequestBytes`.
- `apps/desktop/src/transport/unix-socket-transporter.ts` *(modify)* — bridge types + `requestBytes`.
- `apps/desktop/src/transport/node-http-client.ts` *(modify)* — `sendBytes`.

**UI**
- `packages/ui/src/lib/file-kind.ts` *(create)* — `detectFileKind`, caps.
- `packages/ui/src/hooks/use-object-url.ts` *(create)* + `hooks/index.ts` *(modify)* — blob-URL lifecycle.
- `packages/ui/src/lib/files.ts` *(modify)* — `downloadBlob`.
- `packages/ui/src/types/worker.d.ts` *(create)* — `*?worker` module declaration.
- `packages/ui/src/components/files/FilePreview.tsx` *(create)* — dispatcher (+ `TextPreview`).
- `packages/ui/src/components/files/viewers/{ImageViewer,BinaryCard,MediaViewer,ArchiveViewer,PdfViewer}.tsx` *(create)*.
- `packages/ui/src/components/files/FileBrowser.tsx` *(modify)* — remove inline `FileContent`, render `<FilePreview>`, thread file size.
- `packages/ui/package.json` *(modify)* — add `pdfjs-dist`.

**Docs**
- `AGENTS.md`, `deploy/README.md` *(modify)* — note the optional archive-tool dependency.

---

### Task 1: File-kind detection (`packages/ui/src/lib/file-kind.ts`)

**Files:**
- Create: `packages/ui/src/lib/file-kind.ts`
- Test: throwaway `scratchpad/file-kind.check.ts` (tsx, not committed)

**Interfaces:**
- Produces: `type FileKind = "text"|"image"|"pdf"|"audio"|"video"|"archive"|"binary"`; `interface FileKindInfo { kind: FileKind; mime: string }`; `detectFileKind(filename: string): FileKindInfo`; `const DOWNLOAD_MAX_BYTES: number`; `const PREVIEW_CAP_BY_KIND: Record<FileKind, number>`. `detectFileKind` only ever returns kinds `text|image|pdf|audio|video|archive` (never `binary`; the dispatcher decides the binary card). Unknown extensions → `{ kind: "text", mime: "text/plain" }`.

- [ ] **Step 1: Write the failing test**

Create `<scratchpad>/file-kind.check.ts`:

```ts
import assert from "node:assert/strict";
import { detectFileKind, PREVIEW_CAP_BY_KIND, DOWNLOAD_MAX_BYTES } from "../packages/ui/src/lib/file-kind";

assert.equal(detectFileKind("photo.PNG").kind, "image");
assert.equal(detectFileKind("a.jpeg").mime, "image/jpeg");
assert.equal(detectFileKind("scan.pdf").kind, "pdf");
assert.equal(detectFileKind("song.mp3").kind, "audio");
assert.equal(detectFileKind("clip.mp4").kind, "video");
assert.equal(detectFileKind("bundle.tar.gz").kind, "archive");
assert.equal(detectFileKind("x.7z").kind, "archive");
assert.equal(detectFileKind("main.ts").kind, "text");
assert.equal(detectFileKind("Dockerfile").kind, "text");
assert.equal(PREVIEW_CAP_BY_KIND.video, 50 * 1024 * 1024);
assert.equal(PREVIEW_CAP_BY_KIND.image, 25 * 1024 * 1024);
assert.equal(DOWNLOAD_MAX_BYTES, 50 * 1024 * 1024);
console.log("file-kind OK");
```

- [ ] **Step 2: Run it to confirm it fails**

Run (from repo root): `npx tsx <scratchpad>/file-kind.check.ts`
Expected: FAIL — `Cannot find module '.../file-kind'`.

- [ ] **Step 3: Implement the module**

Create `packages/ui/src/lib/file-kind.ts`:

```ts
/**
 * Classify a file by extension for the file-preview dispatcher, and carry the
 * per-kind size policy. Extension-based (like CodeMirror's matchFilename) — no
 * magic-byte sniffing; predictable and synchronous.
 */

export type FileKind = "text" | "image" | "pdf" | "audio" | "video" | "archive" | "binary";

export interface FileKindInfo {
  kind: FileKind;
  /** MIME used to wrap bytes in a typed Blob (image/audio/video/pdf). */
  mime: string;
}

/** Mirror of the daemon's RAW_MAX_BYTES: the in-app download limit and absolute
 *  read cap. Files larger than this are neither previewed nor downloaded in-app. */
export const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** Per-kind inline-preview cap. Video gets the full ceiling; everything else is
 *  capped lower to bound renderer memory. A renderable file above its cap (but
 *  <= DOWNLOAD_MAX_BYTES) falls back to the download card. */
export const PREVIEW_CAP_BY_KIND: Record<FileKind, number> = {
  video: 50 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  binary: 25 * 1024 * 1024,
  archive: DOWNLOAD_MAX_BYTES, // listed server-side, not byte-fetched
  text: DOWNLOAD_MAX_BYTES // text uses the separate 1 MB /api/fs/read route
};

// extension (no dot, lowercased) -> [kind, mime]
const BY_EXT: Record<string, [FileKind, string]> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  svg: ["image", "image/svg+xml"],
  bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
  avif: ["image", "image/avif"],
  pdf: ["pdf", "application/pdf"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"],
  flac: ["audio", "audio/flac"],
  aac: ["audio", "audio/aac"],
  mp4: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mkv: ["video", "video/x-matroska"],
  m4v: ["video", "video/mp4"],
  zip: ["archive", "application/zip"],
  rar: ["archive", "application/vnd.rar"],
  "7z": ["archive", "application/x-7z-compressed"],
  tar: ["archive", "application/x-tar"],
  gz: ["archive", "application/gzip"],
  tgz: ["archive", "application/gzip"],
  bz2: ["archive", "application/x-bzip2"],
  xz: ["archive", "application/x-xz"]
};

/** Lowercased extension, collapsing `.tar.*` compound names to a known key. */
function extOf(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "tgz";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tar.xz")) return "tar";
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

export function detectFileKind(filename: string): FileKindInfo {
  const hit = BY_EXT[extOf(filename)];
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: "text", mime: "text/plain" };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx tsx <scratchpad>/file-kind.check.ts`
Expected: `file-kind OK`.

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/file-kind.ts
git commit -m "feat(files): file-kind detection + per-kind preview caps"
```

---

### Task 2: Daemon raw-bytes route (`GET /api/fs/raw`)

**Files:**
- Modify: `apps/daemon/src/index.ts` (add `RAW_MAX_BYTES` near `MAX_UPLOAD_BYTES` ~line 93; add the route right after the `/api/fs/read` route, ~line 862)
- Test: `curl` over the Unix socket

**Interfaces:**
- Produces: HTTP `GET /api/fs/raw?path=<abs>` → `200 application/octet-stream` with raw bytes (`X-Content-Type-Options: nosniff`); `413 FS_TOO_LARGE` when `size > RAW_MAX_BYTES`; `403 FS_FORBIDDEN` on sandbox escape; `400 FS_ERROR` otherwise.

- [ ] **Step 1: Add the constant**

In `apps/daemon/src/index.ts`, directly after the `MAX_UPLOAD_BYTES` declaration (~line 93):

```ts
/**
 * Hard ceiling on a single /api/fs/raw read: the in-memory + in-app download
 * limit for binary preview. See docs/superpowers/specs/2026-06-24-file-preview-design.md.
 */
const RAW_MAX_BYTES = 50 * 1024 * 1024;
```

- [ ] **Step 2: Add the route**

Immediately after the closing `);` of the `app.get(... "/api/fs/read" ...)` route (~line 862), insert:

```ts
  // Read a file's RAW bytes (binary-safe, no decode) for the preview viewers.
  // Capped at RAW_MAX_BYTES; the client picks the real MIME and rewraps the
  // bytes in a typed Blob, so octet-stream here is both safe and sufficient.
  app.get<{ Querystring: { path?: string } }>("/api/fs/raw", async (request, reply) => {
    const path = request.query.path;
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, path);
      const info = await stat(safe);
      if (!info.isFile()) {
        void reply.code(400).send({ code: "FS_ERROR", message: "Not a file." });
        return;
      }
      if (info.size > RAW_MAX_BYTES) {
        void reply.code(413).send({
          code: "FS_TOO_LARGE",
          message: `File exceeds the ${Math.floor(RAW_MAX_BYTES / (1024 * 1024))} MB preview limit.`
        });
        return;
      }
      const buffer = await readFile(safe);
      void reply.header("X-Content-Type-Options", "nosniff").type("application/octet-stream").send(buffer);
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot read file."
      });
    }
  });
```

(`stat`, `readFile`, `assertInsideFsRoot`, `FsSandboxError` are already imported/defined in this file. The `void reply...; return;` pattern matches the existing `gitError` helper.)

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 4: Start the daemon and create test fixtures**

```bash
pnpm dev:daemon   # leave running in a second shell; socket -> .stage/daemon/daemon.sock
mkdir -p .stage/workspaces/demo
head -c 4096 /dev/urandom > .stage/workspaces/demo/blob.bin
fallocate -l $((50*1024*1024+1)) .stage/workspaces/demo/big.bin   # 50MB+1 (sparse, instant)
```

- [ ] **Step 5: Verify the route**

```bash
SOCK=.stage/daemon/daemon.sock
ABS="$(pwd)/.stage/workspaces/demo/blob.bin"
# 200 + octet-stream, bytes identical:
curl -s --unix-socket "$SOCK" "http://x/api/fs/raw?path=$ABS" -o /tmp/raw.out -w "%{http_code} %{content_type}\n"
cmp .stage/workspaces/demo/blob.bin /tmp/raw.out && echo "bytes match"
# 413 over cap:
curl -s --unix-socket "$SOCK" "http://x/api/fs/raw?path=$(pwd)/.stage/workspaces/demo/big.bin" -o /dev/null -w "%{http_code}\n"
# 403 sandbox escape:
curl -s --unix-socket "$SOCK" "http://x/api/fs/raw?path=/etc/passwd" -o /dev/null -w "%{http_code}\n"
```
Expected: `200 application/octet-stream` + `bytes match`; then `413`; then `403`. Clean up: `rm .stage/workspaces/demo/big.bin`.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(files): GET /api/fs/raw — binary-safe file bytes (50MB cap)"
```

---

### Task 3: Daemon archive listing (`archive.ts` + `GET /api/fs/archive` + wire types + docs)

**Files:**
- Modify: `packages/api/src/index.ts` (add `ArchiveEntry`, `FsArchiveResponse` after `FsReadResponse` ~line 157)
- Create: `apps/daemon/src/archive.ts`
- Modify: `apps/daemon/src/index.ts` (import `listArchiveEntries`; add `GET /api/fs/archive` after the `/api/fs/raw` route)
- Modify: `AGENTS.md`, `deploy/README.md` (archive-tool note)
- Test: throwaway `scratchpad/archive.check.ts` (tsx) + `curl`

**Interfaces:**
- Produces (api): `interface ArchiveEntry { name: string; size: number; dir: boolean }`; `interface FsArchiveResponse { supported: boolean; entries: ArchiveEntry[]; truncated: boolean; tool?: string; reason?: string }`.
- Produces (daemon): `listArchiveEntries(absPath: string): Promise<FsArchiveResponse>`; HTTP `GET /api/fs/archive?path=<abs>` → `FsArchiveResponse` (200), `403`/`400` like the other fs routes.
- Consumes: `assertInsideFsRoot`, `FsSandboxError` (from `index.ts`).

- [ ] **Step 1: Add the wire types**

In `packages/api/src/index.ts`, after the `FsReadResponse` interface (~line 157):

```ts
/** One entry inside an archive (from GET /api/fs/archive). */
export interface ArchiveEntry {
  /** POSIX-separated path within the archive, e.g. "src/index.ts". */
  name: string;
  size: number;
  dir: boolean;
}

export interface FsArchiveResponse {
  /** False when no host tool can read this archive format. */
  supported: boolean;
  entries: ArchiveEntry[];
  /** True when the listing was capped (more entries exist than returned). */
  truncated: boolean;
  /** Tool used (diagnostics), e.g. "7z" | "bsdtar". */
  tool?: string;
  /** Why unsupported, when supported is false. */
  reason?: string;
}
```

- [ ] **Step 2: Write the failing parser test**

Create `<scratchpad>/archive.check.ts` (builds a real `.tar` with the host `tar`, lists it via the module):

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArchiveEntries } from "../apps/daemon/src/archive";

const dir = mkdtempSync(join(tmpdir(), "arc-"));
writeFileSync(join(dir, "a.txt"), "hello");
writeFileSync(join(dir, "b.txt"), "world!!");
execFileSync("tar", ["-cf", "test.tar", "a.txt", "b.txt"], { cwd: dir });

const res = await listArchiveEntries(join(dir, "test.tar"));
assert.equal(res.supported, true, `expected supported, got ${JSON.stringify(res)}`);
const names = res.entries.filter((e) => !e.dir).map((e) => e.name).sort();
assert.deepEqual(names, ["a.txt", "b.txt"]);
console.log("archive OK via", res.tool, names);
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx tsx <scratchpad>/archive.check.ts`
Expected: FAIL — `Cannot find module '.../archive'`.

- [ ] **Step 4: Implement `archive.ts`**

Create `apps/daemon/src/archive.ts`:

```ts
/**
 * Archive content listing for the file browser's preview. Shells out to a host
 * archive tool (7-Zip preferred, libarchive's bsdtar as a fallback) to list
 * entries WITHOUT extracting. No tool / unreadable format -> { supported: false }.
 *
 * The tool is spawned with an argument array (no shell), and the archive path is
 * already sandbox-validated by the caller (assertInsideFsRoot), so there is no
 * command-injection or path-escape surface here.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import { promisify } from "node:util";
import type { ArchiveEntry, FsArchiveResponse } from "@orquester/api";

const run = promisify(execFile);

/** Max entries returned; protects the client from a pathological archive. */
const MAX_ENTRIES = 5000;
/** Backstop so an encrypted/corrupt archive that prompts can't hang the daemon. */
const TOOL_TIMEOUT_MS = 15_000;

type Tool = { bin: string; kind: "7z" | "bsdtar" };
let resolvedTool: Tool | null | undefined;

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".EXE", ".CMD", ".BAT", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(`${dir}/${bin}${ext}`, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

/** First available archive tool on PATH, resolved once and cached. */
function resolveTool(): Tool | null {
  if (resolvedTool !== undefined) return resolvedTool;
  for (const bin of ["7z", "7zz", "7za"]) {
    if (onPath(bin)) return (resolvedTool = { bin, kind: "7z" });
  }
  if (onPath("bsdtar")) return (resolvedTool = { bin: "bsdtar", kind: "bsdtar" });
  return (resolvedTool = null);
}

/** Parse `7z l -slt` technical listing (blocks of "Key = Value" lines). */
function parse7z(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    // The header block before the file list has "Path = <the archive itself>";
    // it has no "Size"/"Folder"/"Attributes" file fields — skip blocks missing them.
    const sizeStr = /^Size = (\d+)$/m.exec(block)?.[1];
    const attr = /^Attributes = (.+)$/m.exec(block)?.[1];
    const folder = /^Folder = (.+)$/m.exec(block)?.[1];
    if (sizeStr === undefined && attr === undefined && folder === undefined) continue;
    const dir = (attr?.includes("D") ?? false) || folder === "+";
    entries.push({ name: path, size: sizeStr ? Number(sizeStr) : 0, dir });
  }
  return entries;
}

/** Parse `bsdtar -tvf` verbose listing. */
function parseBsdtar(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // e.g. "drwxr-xr-x  0 user group   0 Jun 24 12:00 dir/name/"
    const m = /^([\w-]{10})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, perms, sizeStr, name] = m;
    entries.push({ name, size: Number(sizeStr), dir: perms.startsWith("d") || name.endsWith("/") });
  }
  return entries;
}

export async function listArchiveEntries(absPath: string): Promise<FsArchiveResponse> {
  const tool = resolveTool();
  if (!tool) {
    return { supported: false, entries: [], truncated: false, reason: "No archive tool (7z/bsdtar) on PATH." };
  }
  try {
    const opts = { maxBuffer: 32 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS };
    let entries: ArchiveEntry[];
    if (tool.kind === "7z") {
      // -slt: technical listing; -p: empty password (don't prompt); --: end switches.
      const { stdout } = await run(tool.bin, ["l", "-slt", "-p", "--", absPath], opts);
      entries = parse7z(stdout);
    } else {
      const { stdout } = await run(tool.bin, ["-tvf", absPath], opts);
      entries = parseBsdtar(stdout);
    }
    const truncated = entries.length > MAX_ENTRIES;
    return {
      supported: true,
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      truncated,
      tool: tool.bin
    };
  } catch (error) {
    // Tool ran but couldn't read it (encrypted, corrupt, unknown format, timeout).
    return {
      supported: false,
      entries: [],
      truncated: false,
      tool: tool.bin,
      reason: error instanceof Error ? error.message.split("\n")[0] : "Cannot read archive."
    };
  }
}
```

- [ ] **Step 5: Run the parser test to confirm it passes**

Run: `npx tsx <scratchpad>/archive.check.ts`
Expected: `archive OK via 7z [ 'a.txt', 'b.txt' ]` (tool name depends on host; this host has `7z`).

- [ ] **Step 6: Add the route**

In `apps/daemon/src/index.ts`, add to the imports block near the top (with the other local imports):

```ts
import { listArchiveEntries } from "./archive.ts";
```

(Use the `.ts` extension to match the daemon's other relative imports if present; otherwise `"./archive"`. Verify against a neighboring import like `./git` and match its style.)

Then, immediately after the `/api/fs/raw` route, insert:

```ts
  // List an archive's contents (no extraction) for the preview viewer.
  app.get<{ Querystring: { path?: string } }>("/api/fs/archive", async (request, reply) => {
    const path = request.query.path;
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, path);
      void reply.send(await listArchiveEntries(safe));
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot read archive."
      });
    }
  });
```

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: no errors. (If the `./archive.ts` import errors, switch to `./archive` to match the repo's resolution style.)

- [ ] **Step 8: Verify the route**

```bash
# daemon still running from Task 2 (pnpm dev:daemon). Build a zip under fsRoot:
( cd .stage/workspaces/demo && printf 'hi' > one.txt && printf 'yo' > two.txt && tar -cf sample.tar one.txt two.txt )
SOCK=.stage/daemon/daemon.sock
curl -s --unix-socket "$SOCK" "http://x/api/fs/archive?path=$(pwd)/.stage/workspaces/demo/sample.tar"
echo
# sandbox escape -> 403:
curl -s --unix-socket "$SOCK" "http://x/api/fs/archive?path=/etc/hosts.tar" -o /dev/null -w "%{http_code}\n"
```
Expected: a JSON `{"supported":true,"entries":[...one.txt...two.txt...],"truncated":false,"tool":"7z"}`; then `403` (path outside fsRoot).

- [ ] **Step 9: Document the optional dependency**

In `AGENTS.md`, in the **First-time provisioning** apt-install line (step 2), append `p7zip-full` to the package list, e.g.:

```
sudo apt-get install -y git openssh-client tmux ufw python3 make g++ curl ca-certificates p7zip-full
```

And add a bullet under **Conventions & gotchas**:

```
- **Archive preview is host-tool-gated.** `GET /api/fs/archive` lists archive contents by
  shelling out to `7z` (p7zip-full) or `bsdtar` (libarchive-tools). Without either on PATH,
  archives degrade gracefully to a download card (`supported:false`). Not an npm package.
```

In `deploy/README.md`, add the same one-line note near the provisioning prerequisites (install `p7zip-full` for archive previews; optional).

- [ ] **Step 10: Commit**

```bash
git add packages/api/src/index.ts apps/daemon/src/archive.ts apps/daemon/src/index.ts AGENTS.md deploy/README.md
git commit -m "feat(files): GET /api/fs/archive — list archive contents via 7z/bsdtar"
```

---

### Task 4: Web byte transport + ApiClient methods

**Files:**
- Modify: `packages/ui/src/lib/http-client.ts` (add `HttpClientBytesResponse`; `sendBytes?` on `HttpClient`; implement `FetchHttpClient.sendBytes`)
- Modify: `packages/ui/src/lib/transporter.ts` (add optional `requestBytes`)
- Modify: `packages/ui/src/lib/transporters/http-transporter.ts` (implement `requestBytes`)
- Modify: `packages/ui/src/index.ts` (export `HttpClientBytesResponse`)
- Modify: `packages/ui/src/lib/api-client.ts` (add `readFileBytes`, `listArchive`)

**Interfaces:**
- Produces: `interface HttpClientBytesResponse { status: number; ok: boolean; headers: Record<string,string>; bytes(): Promise<ArrayBuffer> }`; `HttpClient.sendBytes?(req): Promise<HttpClientBytesResponse>`; `Transporter.requestBytes?(req): Promise<TransportResponse<ArrayBuffer>>`; `ApiClient.readFileBytes(path, signal?): Promise<ArrayBuffer>`; `ApiClient.listArchive(path, signal?): Promise<FsArchiveResponse>`.
- Consumes: `FsArchiveResponse` (Task 3); `ApiError` (already in api-client.ts).

> No standalone runtime test (pure transport plumbing, and the HTTP path needs auth). Gate is `pnpm check`; it is exercised end-to-end by the ImageViewer in Task 5 (web) and the desktop path in Task 8.

- [ ] **Step 1: Extend the HttpClient contract**

In `packages/ui/src/lib/http-client.ts`, add after `HttpClientResponse` (~line 22):

```ts
export interface HttpClientBytesResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bytes(): Promise<ArrayBuffer>;
}
```

Add to the `HttpClient` interface (after `send`):

```ts
  /**
   * Optional binary GET (file preview). Web uses fetch -> arrayBuffer; desktop
   * injects a Node client that returns bytes over IPC. Absent => binary preview
   * is unavailable on that connection.
   */
  sendBytes?(req: HttpClientRequest): Promise<HttpClientBytesResponse>;
```

Add to `FetchHttpClient` (after `send`):

```ts
  async sendBytes(req: HttpClientRequest): Promise<HttpClientBytesResponse> {
    const doFetch = this.fetchImpl;
    const response = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      signal: req.signal
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers,
      bytes: () => response.arrayBuffer()
    };
  }
```

- [ ] **Step 2: Export the new type from the UI barrel**

In `packages/ui/src/index.ts`, add `type HttpClientBytesResponse,` to the existing `from "./lib/http-client"` export block (alongside `HttpClientResponse`).

- [ ] **Step 3: Add `requestBytes` to the Transporter interface**

In `packages/ui/src/lib/transporter.ts`, inside the `Transporter` interface (after `request`):

```ts
  /**
   * Optional binary GET (file preview: image/pdf/audio/video bytes). Returns the
   * raw bytes; absent on transports that cannot carry binary.
   */
  requestBytes?(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>>;
```

- [ ] **Step 4: Implement `requestBytes` on HttpTransporter**

In `packages/ui/src/lib/transporters/http-transporter.ts`, add after the `request` method:

```ts
  async requestBytes(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>> {
    if (!this.client.sendBytes) {
      throw new Error("This transport cannot fetch binary content.");
    }
    const url = `${this.baseUrl}${req.path}${buildQueryString(req.query)}`;
    const headers: Record<string, string> = { ...req.headers };
    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }
    const response = await this.client.sendBytes({ url, method: req.method, headers, signal: req.signal });
    const data = response.ok ? await response.bytes() : new ArrayBuffer(0);
    return { status: response.status, ok: response.ok, data, headers: response.headers };
  }
```

- [ ] **Step 5: Add ApiClient methods**

In `packages/ui/src/lib/api-client.ts`: add `FsArchiveResponse` to the `@orquester/api` type import (the alphabetized `import type { … }` block at the top). Then, in the `// --- File browser` region (right after `readFile`, ~line 219):

```ts
  /** Raw bytes of a file (binary-safe) for the preview viewers. */
  async readFileBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) {
      throw new Error("Binary preview is not supported on this connection.");
    }
    const response = await this.transporter.requestBytes({
      method: "GET",
      path: "/api/fs/raw",
      query: { path },
      signal
    });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", "/api/fs/raw", response.headers, undefined);
    }
    return response.data;
  }

  listArchive(path: string, signal?: AbortSignal): Promise<FsArchiveResponse> {
    return this.send("GET", "/api/fs/archive", { query: { path }, signal });
  }
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/lib/http-client.ts packages/ui/src/lib/transporter.ts packages/ui/src/lib/transporters/http-transporter.ts packages/ui/src/index.ts packages/ui/src/lib/api-client.ts
git commit -m "feat(files): requestBytes transport capability + readFileBytes/listArchive"
```

---

### Task 5: UI dispatcher — text, image, binary card (web-verifiable)

**Files:**
- Create: `packages/ui/src/hooks/use-object-url.ts`; Modify: `packages/ui/src/hooks/index.ts`
- Modify: `packages/ui/src/lib/files.ts` (add `downloadBlob`)
- Create: `packages/ui/src/components/files/viewers/ImageViewer.tsx`
- Create: `packages/ui/src/components/files/viewers/BinaryCard.tsx`
- Create: `packages/ui/src/components/files/FilePreview.tsx` (dispatcher + `TextPreview`)
- Modify: `packages/ui/src/components/files/FileBrowser.tsx` (remove inline `FileContent`; render `<FilePreview>`; thread size)
- Test: drive `pnpm dev:web`

**Interfaces:**
- Produces: `useObjectUrl(fetchBytes, path, mime, enabled): { url: string|null; loading: boolean; error: boolean }`; `downloadBlob(filename: string, blob: Blob): void`; `FilePreview({ path: string|null; size: number; onBack: () => void })`; `ImageViewer`/`BinaryCard` (props below).
- Consumes: `detectFileKind`, `PREVIEW_CAP_BY_KIND`, `DOWNLOAD_MAX_BYTES` (Task 1); `api.readFileBytes` (Task 4); `useApi`, `Editor`, `Button`.

- [ ] **Step 1: `useObjectUrl` hook**

Create `packages/ui/src/hooks/use-object-url.ts`:

```ts
import { useEffect, useState } from "react";

export interface ObjectUrlState {
  url: string | null;
  loading: boolean;
  error: boolean;
}

/**
 * Fetch bytes for `path`, wrap them in a typed Blob, and expose a
 * createObjectURL() string that is revoked on path/mime change and on unmount.
 * `enabled` gates the fetch (skip when over the download ceiling). An in-flight
 * fetch is aborted when inputs change.
 */
export function useObjectUrl(
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
  path: string,
  mime: string,
  enabled: boolean
): ObjectUrlState {
  const [state, setState] = useState<ObjectUrlState>({ url: null, loading: enabled, error: false });

  useEffect(() => {
    if (!enabled) {
      setState({ url: null, loading: false, error: false });
      return;
    }
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ url: null, loading: true, error: false });
    fetchBytes(path, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setState({ url: objectUrl, loading: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ url: null, loading: false, error: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fetchBytes, path, mime, enabled]);

  return state;
}
```

Add to `packages/ui/src/hooks/index.ts`:

```ts
export { useObjectUrl, type ObjectUrlState } from "./use-object-url";
```

- [ ] **Step 2: `downloadBlob` helper**

In `packages/ui/src/lib/files.ts`, append:

```ts
/** Trigger a browser "Save as" for an in-memory blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 3: `ImageViewer`**

Create `packages/ui/src/components/files/viewers/ImageViewer.tsx`:

```tsx
import React from "react";
import { useObjectUrl } from "../../../hooks";

export interface ViewerProps {
  path: string;
  mime: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}

export const ImageViewer: React.FC<ViewerProps> = ({ path, mime, fetchBytes }) => {
  const { url, loading, error } = useObjectUrl(fetchBytes, path, mime, true);
  if (loading) return <p className="p-3 text-xs text-neutral-600">Loading…</p>;
  if (error || !url) return <p className="p-3 text-xs text-red-400">Could not load image.</p>;
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-neutral-900 p-4">
      <img src={url} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  );
};
```

- [ ] **Step 4: `BinaryCard`**

Create `packages/ui/src/components/files/viewers/BinaryCard.tsx`:

```tsx
import React, { useState } from "react";
import { Download, FileQuestion } from "lucide-react";
import { Button } from "../../ui";
import { downloadBlob } from "../../../lib/files";

const fmtSize = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

export interface BinaryCardProps {
  path: string;
  name: string;
  size: number;
  mime: string;
  title: string;
  /** True when size <= the download ceiling (download button shown). */
  downloadable: boolean;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}

export const BinaryCard: React.FC<BinaryCardProps> = ({ path, name, size, mime, title, downloadable, fetchBytes }) => {
  const [busy, setBusy] = useState(false);
  const onDownload = async () => {
    setBusy(true);
    try {
      const bytes = await fetchBytes(path);
      downloadBlob(name, new Blob([bytes], { type: mime }));
    } catch {
      /* ignore — leaves the button re-enabled */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <FileQuestion size={32} className="text-neutral-600" />
      <div>
        <p className="text-sm text-neutral-300">{title}</p>
        <p className="text-xs text-neutral-600">
          {name} · {fmtSize(size)}
        </p>
      </div>
      {downloadable ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDownload()}>
          <Download size={13} />
          {busy ? "Downloading…" : "Download"}
        </Button>
      ) : (
        <p className="text-[11px] text-neutral-600">Too large for in-app download — use a terminal.</p>
      )}
    </div>
  );
};
```

- [ ] **Step 5: `FilePreview` dispatcher (with `TextPreview`)**

Create `packages/ui/src/components/files/FilePreview.tsx`. This replaces the old inline `FileContent`. `TextPreview` is the old text logic (read via `api.readFile`, edit, save) plus a null-byte → `BinaryCard` branch. Viewers for pdf/audio/video/archive are added in Tasks 6–7; until then those kinds fall through to a download `BinaryCard`.

```tsx
import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft, File, Save } from "lucide-react";
import { Button } from "../ui";
import { Editor } from "./Editor";
import { ImageViewer } from "./viewers/ImageViewer";
import { BinaryCard } from "./viewers/BinaryCard";
import { useApi } from "../../context/orquester-context";
import { detectFileKind, PREVIEW_CAP_BY_KIND, DOWNLOAD_MAX_BYTES } from "../../lib/file-kind";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * File viewer dispatcher: classifies the selected file and mounts the right
 * viewer. Text stays in CodeMirror (editable + saveable); binary kinds render
 * from raw bytes (or a download card when over their size cap).
 */
export const FilePreview: React.FC<{ path: string | null; size: number; onBack: () => void }> = ({
  path,
  size,
  onBack
}) => {
  const api = useApi();
  const fetchBytes = useCallback((p: string, signal?: AbortSignal) => api.readFileBytes(p, signal), [api]);

  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Select a file to view its contents
      </div>
    );
  }

  const name = baseName(path);
  const { kind, mime } = detectFileKind(name);

  // Text keeps its own header (Save button + dirty dot) — delegate wholesale.
  if (kind === "text") {
    return <TextPreview path={path} mime={mime} size={size} onBack={onBack} />;
  }

  const overCeiling = size > DOWNLOAD_MAX_BYTES;
  const overPreview = size > PREVIEW_CAP_BY_KIND[kind];

  let body: React.ReactNode;
  if (overCeiling) {
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable={false} title="Too large to preview" fetchBytes={fetchBytes} />
    );
  } else if (overPreview) {
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Too large to preview" fetchBytes={fetchBytes} />
    );
  } else if (kind === "image") {
    body = <ImageViewer path={path} mime={mime} fetchBytes={fetchBytes} />;
  } else {
    // pdf | audio | video | archive — real viewers land in Tasks 6–7.
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Preview" fetchBytes={fetchBytes} />
    );
  }

  return (
    <>
      <PreviewHeader name={name} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </>
  );
};

/** Shared header for non-text viewers (filename + mobile back button). */
const PreviewHeader: React.FC<{ name: string; onBack: () => void }> = ({ name, onBack }) => (
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
  </div>
);

/** Text files: CodeMirror editor with save — plus a null-byte -> binary card
 *  guard so an unknown-extension binary never renders as mojibake. */
const TextPreview: React.FC<{ path: string; mime: string; size: number; onBack: () => void }> = ({ path, mime, size, onBack }) => {
  const api = useApi();
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);
  const fetchBytes = useCallback((p: string, signal?: AbortSignal) => api.readFileBytes(p, signal), [api]);

  useEffect(() => {
    let active = true;
    setState("loading");
    api
      .readFile(path)
      .then((res) => {
        if (!active) return;
        setContent(res.content);
        setOriginal(res.content);
        setTruncated(res.truncated);
        setState("idle");
      })
      .catch(() => active && setState("error"));
    return () => {
      active = false;
    };
  }, [api, path]);

  const name = baseName(path);
  // Same NUL-byte guard the original viewer used to force read-only;
  // written via fromCharCode to keep the source copy-paste-safe (no literal NUL).
  const isBinary = content.includes(String.fromCharCode(0));
  const readOnly = truncated || isBinary;
  const dirty = !readOnly && content !== original;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.saveFile(path, content);
      setOriginal(content);
    } catch {
      /* surfaced as still-dirty */
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
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
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" title="Unsaved changes" />}
        {truncated && <span className="text-[10px] text-neutral-600">(truncated · read-only)</span>}
        <div className="flex-1" />
        {!readOnly && state === "idle" && (
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {state === "loading" && <p className="p-3 text-xs text-neutral-600">Loading…</p>}
        {state === "error" && <p className="p-3 text-xs text-red-400">Could not read file.</p>}
        {state === "idle" && isBinary && (
          <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Binary file" fetchBytes={fetchBytes} />
        )}
        {state === "idle" && !isBinary && (
          <Editor filename={name} value={content} readOnly={readOnly} onChange={setContent} onSave={() => void save()} />
        )}
      </div>
    </>
  );
};
```

- [ ] **Step 6: Wire `FilePreview` into `FileBrowser` and thread the file size**

In `packages/ui/src/components/files/FileBrowser.tsx`:

1. Replace the `import { Editor } from "./Editor";` line with `import { FilePreview } from "./FilePreview";`.
2. Add size state next to `selectedFile` (~line 54):

```tsx
  const [selectedSize, setSelectedSize] = useState(0);
```

3. Update `selectFile` (~line 179) to accept and store size:

```tsx
  const selectFile = (path: string, size: number) => {
    setSelectedFile(path);
    setSelectedSize(size);
    setActiveDir(parentOf(path));
  };
```

4. In the content pane (~line 405), replace `<FileContent path={selectedFile} onBack={() => setSelectedFile(null)} />` with:

```tsx
        <FilePreview path={selectedFile} size={selectedSize} onBack={() => setSelectedFile(null)} />
```

5. In `TreeLevelProps`, change the `onSelectFile` type to `(path: string, size: number) => void;` and update the row click handler (~line 493) to pass size:

```tsx
              onClick={() => (isDir ? props.onToggleDir(entry.path) : props.onSelectFile(entry.path, entry.size))}
```

6. **Delete the entire inline `FileContent` component** (the `const FileContent: React.FC<…> = …` block at the bottom of the file, ~lines 542–636) — it now lives in `FilePreview.tsx`. Remove the now-unused `Save`/`ArrowLeft` imports from the lucide-react import if they are no longer referenced elsewhere in `FileBrowser.tsx` (check first — `File` is still used by the tree rows; keep it).

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: no errors. (Common catches: a leftover `FileContent` reference, or an unused import — remove them.)

- [ ] **Step 8: Drive the web app**

```bash
pnpm dev:daemon   # if not already running
pnpm dev:web      # http://localhost:5173 ; log in with password 123456
```
Put fixtures under a project, e.g. `.stage/workspaces/demo/` — copy/make a real `.png`, a `.ts` file, and a >25 MB image (`fallocate -l 26000000 big.png` renders as a card). In the **Files** tab:
- Open the `.png` → image renders centered. ✅
- Open the `.ts` file → CodeMirror, edit a char, **Save** clears the dirty dot. ✅
- Open `big.png` → "Too large to preview" card with a working **Download**. ✅
- Open an `.mp4`/`.zip` → interim **Preview** download card (upgraded in Tasks 6–7). ✅

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/hooks/use-object-url.ts packages/ui/src/hooks/index.ts packages/ui/src/lib/files.ts packages/ui/src/components/files/FilePreview.tsx packages/ui/src/components/files/viewers/ImageViewer.tsx packages/ui/src/components/files/viewers/BinaryCard.tsx packages/ui/src/components/files/FileBrowser.tsx
git commit -m "feat(files): FilePreview dispatcher — image + text + binary/download card"
```

---

### Task 6: Media + Archive viewers

**Files:**
- Create: `packages/ui/src/components/files/viewers/MediaViewer.tsx`
- Create: `packages/ui/src/components/files/viewers/ArchiveViewer.tsx`
- Modify: `packages/ui/src/components/files/FilePreview.tsx` (route audio/video → MediaViewer, archive → ArchiveViewer)
- Test: drive `pnpm dev:web`

**Interfaces:**
- Produces: `MediaViewer({ path, mime, kind: "audio"|"video", fetchBytes })`; `ArchiveViewer({ path, name, size, mime, fetchBytes })`.
- Consumes: `useObjectUrl` (Task 5), `api.listArchive` (Task 4), `BinaryCard` (Task 5), `FsArchiveResponse` (Task 3).

- [ ] **Step 1: `MediaViewer`**

Create `packages/ui/src/components/files/viewers/MediaViewer.tsx`:

```tsx
import React from "react";
import { useObjectUrl } from "../../../hooks";

export const MediaViewer: React.FC<{
  path: string;
  mime: string;
  kind: "audio" | "video";
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, mime, kind, fetchBytes }) => {
  const { url, loading, error } = useObjectUrl(fetchBytes, path, mime, true);
  if (loading) return <p className="p-3 text-xs text-neutral-600">Loading…</p>;
  if (error || !url) return <p className="p-3 text-xs text-red-400">Could not load media.</p>;
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-neutral-900 p-4">
      {kind === "video" ? (
        <video src={url} controls className="max-h-full max-w-full" />
      ) : (
        <audio src={url} controls className="w-full max-w-md" />
      )}
    </div>
  );
};
```

- [ ] **Step 2: `ArchiveViewer`**

Create `packages/ui/src/components/files/viewers/ArchiveViewer.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { File as FileIcon, Folder } from "lucide-react";
import type { FsArchiveResponse } from "@orquester/api";
import { useApi } from "../../../context/orquester-context";
import { BinaryCard } from "./BinaryCard";

export const ArchiveViewer: React.FC<{
  path: string;
  name: string;
  size: number;
  mime: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, name, size, mime, fetchBytes }) => {
  const api = useApi();
  const [state, setState] = useState<{ data: FsArchiveResponse | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false
  });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ data: null, loading: true, error: false });
    api
      .listArchive(path, controller.signal)
      .then((data) => active && setState({ data, loading: false, error: false }))
      .catch(() => active && !controller.signal.aborted && setState({ data: null, loading: false, error: true }));
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, path]);

  if (state.loading) return <p className="p-3 text-xs text-neutral-600">Reading archive…</p>;
  if (state.error || !state.data) return <p className="p-3 text-xs text-red-400">Could not read archive.</p>;
  if (!state.data.supported) {
    return (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable={size <= 50 * 1024 * 1024} title="Archive (no preview tool)" fetchBytes={fetchBytes} />
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-2 text-sm">
      {state.data.truncated && (
        <p className="px-2 py-1 text-[11px] text-amber-500/80">
          Listing truncated to {state.data.entries.length.toLocaleString()} entries.
        </p>
      )}
      <ul>
        {state.data.entries.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 px-2 py-0.5 text-neutral-300">
            {entry.dir ? (
              <Folder size={13} className="shrink-0 text-neutral-500" />
            ) : (
              <FileIcon size={13} className="shrink-0 text-neutral-600" />
            )}
            <span className="flex-1 truncate">{entry.name}</span>
            {!entry.dir && <span className="text-[11px] text-neutral-600">{entry.size.toLocaleString()} B</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};
```

- [ ] **Step 3: Route the new kinds in `FilePreview`**

In `packages/ui/src/components/files/FilePreview.tsx`, add the imports:

```tsx
import { MediaViewer } from "./viewers/MediaViewer";
import { ArchiveViewer } from "./viewers/ArchiveViewer";
```

Replace the final `else { … BinaryCard … "Preview" … }` branch with:

```tsx
  } else if (kind === "audio" || kind === "video") {
    body = <MediaViewer path={path} mime={mime} kind={kind} fetchBytes={fetchBytes} />;
  } else if (kind === "archive") {
    body = <ArchiveViewer path={path} name={name} size={size} mime={mime} fetchBytes={fetchBytes} />;
  } else {
    // pdf — viewer lands in Task 7.
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Preview" fetchBytes={fetchBytes} />
    );
  }
```

Note: archives route to `ArchiveViewer` **before** the size-cap checks would matter, because `PREVIEW_CAP_BY_KIND.archive === DOWNLOAD_MAX_BYTES` (listing is server-side, not byte-fetched). Confirm the `overPreview` branch sits above this — for `archive`, `overPreview` is only true when `size > 50 MB`, in which case `overCeiling` already caught it. So archives always reach `ArchiveViewer` unless > 50 MB. That is intended (a > 50 MB archive shows the card).

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 5: Drive the web app**

With `pnpm dev:web` running, add an `.mp3`, an `.mp4`, and a real `.zip`/`.tar` under the project:
- Open `.mp3` → audio controls play. ✅
- Open `.mp4` → video plays with controls. ✅
- Open `.zip`/`.tar` → file listing with folder/file icons + sizes. ✅

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/files/viewers/MediaViewer.tsx packages/ui/src/components/files/viewers/ArchiveViewer.tsx packages/ui/src/components/files/FilePreview.tsx
git commit -m "feat(files): audio/video players + archive content listing viewer"
```

---

### Task 7: PDF viewer (pdf.js)

**Files:**
- Modify: `packages/ui/package.json` (add `pdfjs-dist`)
- Create: `packages/ui/src/types/worker.d.ts` (`*?worker` module declaration)
- Create: `packages/ui/src/components/files/viewers/PdfViewer.tsx`
- Modify: `packages/ui/src/components/files/FilePreview.tsx` (route pdf → PdfViewer)
- Test: drive `pnpm dev:web`

**Interfaces:**
- Produces: `PdfViewer({ path, fetchBytes })`.
- Consumes: `pdfjs-dist`, `api.readFileBytes`.

- [ ] **Step 1: Add the dependency**

In `packages/ui/package.json`, add to `dependencies` (keep alphabetical-ish; place after `"lucide-react"`):

```json
    "pdfjs-dist": "^4.7.76",
```

Then install:

```bash
pnpm install
```
Expected: lockfile updates; `pdfjs-dist` resolves (no native build).

- [ ] **Step 2: Declare the `?worker` import**

Create `packages/ui/src/types/worker.d.ts`:

```ts
/** Vite's `?worker` import: default export is a zero-arg Worker constructor. */
declare module "*?worker" {
  const WorkerCtor: { new (): Worker };
  export default WorkerCtor;
}
```

- [ ] **Step 3: `PdfViewer`**

Create `packages/ui/src/components/files/viewers/PdfViewer.tsx`:

```tsx
import React, { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
// Vite bundles the worker for both apps/web and apps/desktop (both build the
// renderer with Vite and consume @orquester/ui as source).
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

export const PdfViewer: React.FC<{
  path: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, fetchBytes }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (containerRef.current) containerRef.current.replaceChildren();
    setState("loading");

    fetchBytes(path, controller.signal)
      .then(async (bytes) => {
        // pdf.js may detach the buffer; pass a copy so it can't disturb callers.
        const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) break;
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "mx-auto mb-3 max-w-full shadow";
          const ctx = canvas.getContext("2d");
          if (ctx && containerRef.current) {
            containerRef.current.appendChild(canvas);
            await page.render({ canvasContext: ctx, viewport }).promise;
          }
        }
        if (!cancelled) setState("ready");
        void doc.destroy();
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) setState("error");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchBytes, path]);

  return (
    <div className="relative h-full min-h-0 overflow-auto bg-neutral-900 p-4">
      {state === "loading" && <p className="p-3 text-xs text-neutral-600">Rendering PDF…</p>}
      {state === "error" && <p className="p-3 text-xs text-red-400">Could not render PDF.</p>}
      <div ref={containerRef} />
    </div>
  );
};
```

- [ ] **Step 4: Route pdf in `FilePreview`**

In `FilePreview.tsx`, add the import:

```tsx
import { PdfViewer } from "./viewers/PdfViewer";
```

Add a branch before the final fallback `else`:

```tsx
  } else if (kind === "pdf") {
    body = <PdfViewer path={path} fetchBytes={fetchBytes} />;
  } else {
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: no errors. (If TS can't find `pdfjs-dist` types, confirm the install succeeded; if the `?worker` import errors, confirm `packages/ui/src/types/worker.d.ts` is included by `packages/ui/tsconfig.json`'s `include` — it covers `src/**/*`.)

- [ ] **Step 6: Drive the web app**

With `pnpm dev:web` running, open a multi-page `.pdf` under the project → pages render stacked as canvases, scrollable. ✅

- [ ] **Step 7: Commit**

```bash
git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/types/worker.d.ts packages/ui/src/components/files/viewers/PdfViewer.tsx packages/ui/src/components/files/FilePreview.tsx
git commit -m "feat(files): PDF viewer via pdf.js"
```

---

### Task 8: Desktop binary IPC (full end-to-end in Electron)

**Files:**
- Modify: `apps/desktop/src/main.ts` (binary socket+http request fns + `request-bytes` handlers)
- Modify: `apps/desktop/src/preload.cjs` (expose `requestBytes`, `httpRequestBytes`)
- Modify: `apps/desktop/src/transport/unix-socket-transporter.ts` (bridge types + `requestBytes`)
- Modify: `apps/desktop/src/transport/node-http-client.ts` (`sendBytes`)
- Test: drive `pnpm dev` (Electron)

**Interfaces:**
- Consumes: the `request-bytes` IPC channels; `HttpClientBytesResponse` (Task 4, exported from `@orquester/ui`); `Transporter.requestBytes` (Task 4).
- Produces: `UnixSocketTransporter.requestBytes`, `NodeHttpClient.sendBytes` — so the desktop renderer's `api.readFileBytes` works for both local (socket) and remote (HTTP) connections.

- [ ] **Step 1: Main-process binary request functions**

In `apps/desktop/src/main.ts`, after `requestOverSocket` (~line 182), add:

```ts
interface DaemonBytesResponse {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  body: ArrayBuffer;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Like requestOverSocket but preserves raw bytes (file preview). */
function requestBytesOverSocket({ method, path: requestPath, headers, body }: DaemonRequest): Promise<DaemonBytesResponse> {
  return new Promise((resolve, reject) => {
    if (!daemonSocketPath) {
      reject(new Error("Orquester daemon is not running."));
      return;
    }
    const req = http.request(
      { socketPath: daemonSocketPath, path: requestPath || "/", method: method || "GET", headers: headers || {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: toArrayBuffer(Buffer.concat(chunks)) });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
```

And after `requestOverHttp` (~line 267), add the remote sibling:

```ts
/** Like requestOverHttp but preserves raw bytes (file preview over TCP). */
function requestBytesOverHttp({ url, method, headers, body }: RemoteHttpRequest): Promise<DaemonBytesResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const req = httpModuleFor(target).request(target, { method: method || "GET", headers: headers || {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: toArrayBuffer(Buffer.concat(chunks)) });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
```

- [ ] **Step 2: Register the IPC handlers**

In `registerIpc()` (~line 317), add after the existing `orquester:request` / `orquester:http:request` handles:

```ts
  ipcMain.handle("orquester:request-bytes", (_event, request: DaemonRequest) => requestBytesOverSocket(request));
  ipcMain.handle("orquester:http:request-bytes", (_event, request: RemoteHttpRequest) => requestBytesOverHttp(request));
```

- [ ] **Step 3: Expose them in preload**

In `apps/desktop/src/preload.cjs`, add inside the `exposeInMainWorld("orquesterDesktop", { … })` object (next to `request` / `httpRequest`):

```js
  requestBytes: (request) => ipcRenderer.invoke("orquester:request-bytes", request),
  httpRequestBytes: (request) => ipcRenderer.invoke("orquester:http:request-bytes", request),
```

- [ ] **Step 4: Bridge types + `requestBytes` on the unix transporter**

In `apps/desktop/src/transport/unix-socket-transporter.ts`:

Add the bytes-response type after `DesktopBridgeResponse` (~line 23):

```ts
/** Binary response shape (file preview) — raw bytes instead of a decoded body. */
export interface DesktopBridgeBytesResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: ArrayBuffer;
}
```

Add to the `DesktopBridge` interface (after `request`):

```ts
  requestBytes(request: DesktopBridgeRequest): Promise<DesktopBridgeBytesResponse>;
  httpRequestBytes(request: DesktopBridgeHttpRequest): Promise<DesktopBridgeBytesResponse>;
```

Add the method to `UnixSocketTransporter` (after `request`):

```ts
  async requestBytes(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>> {
    const response = await this.bridge.requestBytes({
      method: req.method,
      path: `${req.path}${buildQueryString(req.query)}`,
      headers: { ...req.headers }
    });
    return { status: response.status, ok: response.ok, data: response.body, headers: response.headers };
  }
```

- [ ] **Step 5: `sendBytes` on the remote Node client**

In `apps/desktop/src/transport/node-http-client.ts`: add `HttpClientBytesResponse` to the `@orquester/ui` type import, then add the method to `NodeHttpClient` (after `send`):

```ts
  async sendBytes(req: HttpClientRequest): Promise<HttpClientBytesResponse> {
    const response = await this.bridge.httpRequestBytes({
      url: req.url,
      method: req.method,
      headers: req.headers
    });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      bytes: () => Promise.resolve(response.body)
    };
  }
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: no errors. (The desktop `tsconfig` typechecks `main.ts` separately; ensure `DaemonBytesResponse`/`toArrayBuffer` are used and the `as ArrayBuffer` cast satisfies `Buffer.buffer` being `ArrayBufferLike`.)

- [ ] **Step 7: Drive the desktop app (full end-to-end)**

```bash
pnpm dev   # Electron + in-process daemon, staged in ./.stage
```
In a project's **Files** tab, open each fixture type (`.png`, `.pdf`, `.mp3`, `.mp4`, `.zip`, a large image, a `.ts`):
- image/pdf/audio/video render & play (exercises the new socket binary IPC). ✅
- archive lists contents. ✅
- text edits & saves; over-cap file shows the card. ✅

This confirms the binary path works over the Unix socket (the desktop's default transport), closing the cross-client gap.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main.ts apps/desktop/src/preload.cjs apps/desktop/src/transport/unix-socket-transporter.ts apps/desktop/src/transport/node-http-client.ts
git commit -m "feat(files): desktop binary IPC bridge for file preview (socket + remote)"
```

---

## Spec coverage (self-review)

| Spec section | Task(s) |
|---|---|
| Viewer dispatcher keyed on file kind | 1 (detection), 5 (dispatcher) |
| `GET /api/fs/raw` (50 MB cap, nosniff, octet-stream) | 2 |
| `GET /api/fs/archive` (7z/bsdtar, args-array, entry cap, graceful fallback) | 3 |
| `ArchiveEntry` / `FsArchiveResponse` wire types | 3 |
| `requestBytes` on the Transporter seam (web) | 4 |
| Desktop binary IPC (socket + remote) | 8 |
| `readFileBytes` / `listArchive` ApiClient methods | 4 |
| `useObjectUrl` blob lifecycle | 5 |
| Image / Media / Archive / PDF / BinaryCard viewers | 5, 6, 7 |
| pdf.js (canvas, worker via Vite) | 7 |
| Per-kind preview caps + download tiers | 1 (caps), 5 (dispatcher logic) |
| `text` unchanged (edit/save) + null-byte → card | 5 (`TextPreview`) |
| Security (sandbox, no-shell spawn, octet-stream) | 2, 3 |
| Deploy note (archive tool) | 3 |
| Verification (drive web + desktop) | per-task steps; 8 (full e2e) |
```
