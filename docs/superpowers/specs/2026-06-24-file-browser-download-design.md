# File browser — download files & folders from a project

- **Date:** 2026-06-24
- **Status:** Design — pending review
- **Scope:** Let users download a file, or a whole folder (zipped on the server), out of a
  project's file tree — via a **right-click context-menu** item on any file/folder and a
  **download button in the file-preview header** next to Save. Works in both the web client (over
  HTTPS) and the desktop app (over the Unix socket).

## Goal

Get a project file — or a folder, packaged as a single `.zip` — from the daemon's `fsRoot` onto
the user's machine. A file downloads as-is; a folder is zipped **server-side** and streamed.
Large downloads stream straight to disk with no practical size cap (using the browser's own
download manager); the file/folder lands wherever the browser saves downloads. This is the inverse
of the existing upload feature, and it reuses the same sandbox guard and transport abstractions.

## Why a new route (not `/api/fs/raw`)

A single-file binary route already exists — `GET /api/fs/raw` (`apps/daemon/src/index.ts:874`) —
but it is purpose-built for **inline preview**: it caps at `RAW_MAX_BYTES = 50 MB`
(`index.ts:100`), buffers the whole file in memory, serves `application/octet-stream` with **no
`Content-Disposition`**, and is consumed by `BinaryCard`/`FilePreview` to render images, PDFs,
audio, video. Download has opposite requirements — **uncapped, streamed, `Content-Disposition:
attachment`, and a folder→zip branch** — so it gets its own route. `/api/fs/raw` and the inline
preview caps (`PREVIEW_CAP_BY_KIND`, `DOWNLOAD_MAX_BYTES` in `packages/ui/src/lib/file-kind.ts`)
are left untouched.

Likewise, `apps/daemon/src/archive.ts` only **lists** archive contents (`7z l` / `bsdtar -tvf`);
it never **creates** an archive. Folder download needs new zip-creation code — a focused sibling
module — that reuses archive.ts's PATH-probing idiom but spawns a zip writer.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Placement | Context-menu item (files **and** folders) **+** a download button in the preview header next to Save |
| Folder zipping | **Server-side, host tool** (`zip`/`7z`/`bsdtar`), streamed — mirrors `archive.ts`'s host-tool-gated pattern, zero new deps |
| Large downloads | **Native browser streaming, no practical cap** for HTTP transports; buffered fallback for desktop-local |
| Saving on desktop | Browser/Chromium default download manager — **no** native "Save As" dialog in v1 |

## User-facing behavior

- **Context menu** (right-click any tree row): a **Download** item for files; a **Download as Zip**
  item for folders. The folder item is disabled (greyed) when the server reports no zip tool
  available (see *Capability gate*); the file item is always available.
- **Preview header:** a download icon button sits next to **Save** in every previewed file's header
  (text, image, audio, video, PDF, binary). It downloads the currently-open file.
- **Streaming, no cap:** on web and desktop-remote the browser's download manager handles the
  transfer — a multi-hundred-MB file or folder zip streams to disk with a real progress bar; there
  is no 50 MB ceiling on this path.
- **Filenames:** a file keeps its name; a folder downloads as `<folder-name>.zip`.
- **Failure:** a missing path, a permission error, or (for folders) a server with no zip tool
  surfaces a non-blocking error notice; nothing is written client-side.

## Daemon (`apps/daemon/src/index.ts`)

### Route — `GET /api/fs/download?path=`

A new route, registered alongside the other `/api/fs/*` routes (so it inherits the bearer-auth
hook on the remote transport — with the `?token=` extension below). Handler:

1. Require `path` query → 400 `INVALID_REQUEST` otherwise.
2. **`assertInsideFsRoot(fsRoot, path)`** (`index.ts:1899`, the authoritative traversal guard) →
   `FsSandboxError` → 403 `FS_FORBIDDEN`.
3. `stat(safe)` and branch on type (neither file nor dir → 400 `FS_ERROR "Not a file or folder."`):

   **File →** stream with `createReadStream(safe)` (true streaming; no full-buffer, no 50 MB cap).
   Headers: `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`,
   `Content-Length` = `stat.size` (so the browser shows real progress), and
   `Content-Disposition: attachment; filename="<name>"` with an RFC 5987
   `filename*=UTF-8''<encoded>` fallback for non-ASCII names. Fastify pipes the stream (backpressure
   + cleanup handled).

   **Directory →** resolve a zip tool (`resolveZipTool()`, below). None → 501 `FS_UNSUPPORTED`
   (defensive; the UI gates this via the capability endpoint). Otherwise stream the zip using the
   established hijack pattern (as in `GET /api/sessions/:id/output`, `index.ts:1488`, and `/events`,
   `index.ts:1528`): `reply.hijack()`, `reply.raw.writeHead(200, { "Content-Type":
   "application/zip", "Content-Disposition": attachment; filename="<dir>.zip", "X-Content-Type-
   Options": "nosniff" })` (chunked — zip size is unknown up front), then `spawn` the tool and
   `child.stdout.pipe(reply.raw)`.

4. **Lifecycle:** kill the spawned child on client disconnect (`request.raw.on("close")`); on child
   spawn error or non-zero exit before any bytes flow, respond 500; once streaming has begun, a
   later child failure destroys the socket (the partial download fails visibly rather than looking
   complete). No tool timeout — a legitimately large folder may take a while; disconnect-kill is the
   backstop.

### Route — `GET /api/fs/capabilities`

A tiny JSON route → `FsCapabilitiesResponse` (below). Returns whether folder-zip is possible and
which tool was resolved, so the UI only offers (enables) "Download as Zip" when the server can
honor it. Tool resolution is cached once at module scope, exactly like archive.ts's `resolvedTool`.

### Zip creation — new `apps/daemon/src/zip.ts`

A focused module beside `archive.ts` (listing and creation stay separate single-purpose units). It
reuses the PATH-probe approach from `archive.ts` (`onPath`/`resolveTool`, `archive.ts:26-50`) — the
shared `onPath` helper is exported from `archive.ts` (or factored into a small shared util) rather
than duplicated. It resolves the first available zip writer and exposes a spawner that streams a
zip of a directory to **stdout**, run with `cwd = dirname(target)` and the basename as the entry so
in-zip paths are relative to the folder:

| Tool (`kind`) | argv (stream zip of `<base>` to stdout) | Symlinks |
|---|---|---|
| `bsdtar` | `bsdtar -c --format zip -f - <base>` | **stored** as links (default) |
| `zip` | `zip -r -y -q - <base>` | `-y`/`--symlinks` **stores** links |
| `7z`/`7zz`/`7za` | `7z a -tzip -snl -so -- <base>` | `-snl` **stores** links; `-so` → stdout |

Resolution priority: `bsdtar` → `zip` → `7z` (any present one wins; availability decides). Uses
`spawn` (streamed), **not** `execFile` (which buffers via `maxBuffer`, as the listing path does).

> **Symlink storing is a security requirement, not a preference** — see *Security*. It also keeps
> the zip small and correct for symlink-heavy trees (e.g. pnpm `node_modules`).

### Auth — accept `?token=` on the download route only

A native `<a download href="…">` navigation cannot send an `Authorization: Bearer` header, so the
download route must also accept the credential as a query param — exactly as `/ws` already does
(`index.ts:1566`). Extend the `onRequest` auth hook (`index.ts:348-388`): when `request.url`'s path
is `/api/fs/download` **and** there is no `Authorization` header, validate `request.query.token`
with the same constant-time `authorizeCredential`. Everything else is unchanged:

- The credential is the same base64 bearer the client already holds on `connection.password` (a
  bcrypt **hash**, never the plaintext password).
- The log serializer already redacts `token=` from URLs (`index.ts:337-341`), so it covers this
  route automatically.
- The `?token=` fallback is scoped to **`/api/fs/download` only**; `/api/fs/capabilities` and every
  other `/api/*` route stay header-only.
- On the local Unix socket (`authRequired:false`) no token is needed at all; that path uses the
  buffered fetch instead of a navigation (below).

## Wire contracts (`packages/api`)

```ts
export interface FsCapabilitiesResponse {
  folderZip: boolean;       // server can produce a folder zip (a zip tool is on PATH)
  zipTool: string | null;   // resolved tool basename for diagnostics ("bsdtar"|"zip"|"7z"|…|null)
}
```

The download itself is **not** a typed JSON method — it is either a URL the browser navigates to
(HTTP transports) or a raw-bytes GET (Unix socket). Add to the reference client and the UI
`ApiClient`:

```ts
getFsCapabilities(): Promise<FsCapabilitiesResponse>;          // GET /api/fs/capabilities
buildDownloadUrl(path: string): string | null;                // authed URL for HTTP, else null
downloadBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer>; // GET /api/fs/download (bytes)
```

`downloadBytes` rides the existing `transporter.requestBytes` channel (the same one
`readFileBytes` uses, `api-client.ts:223-237`) — already implemented over the HTTP transporter
**and** the desktop Unix-socket bridge (`preload.cjs:17` → `main.ts:196`).

## UI (`packages/ui`)

### Cross-transport orchestrator — new `lib/download.ts`

`downloadPath(api, target)` picks the mechanism by `transporter.kind`:

| Transport | `transporter.kind` | Mechanism |
|---|---|---|
| Web (same-origin) | `"http"` | native `<a download href={buildDownloadUrl}>` → browser streams to disk |
| Desktop → remote VPS | `"http"` | same native navigation via Electron's Chromium |
| Desktop → local daemon | `"unix"` | buffered: `downloadBytes` → `Blob` → `downloadBlob` |

```ts
export async function downloadPath(api: ApiClient, target: { path: string; name: string; kind: "file" | "dir" }) {
  const filename = target.kind === "dir" ? `${target.name}.zip` : target.name;
  const url = api.buildDownloadUrl(target.path);   // non-null only for HTTP transports
  if (url) { downloadUrl(url, filename); return; } // browser download manager handles it
  const bytes = await api.downloadBytes(target.path);
  const type = target.kind === "dir" ? "application/zip" : "application/octet-stream";
  downloadBlob(filename, new Blob([bytes], { type }));
}
```

`buildDownloadUrl` composes `${connection.endpoint}/api/fs/download?path=<enc>&token=<enc
connection.password>` for HTTP transports, returns `null` for the Unix socket. A top-level download
navigation is **not** subject to CSP `connect-src`/CORS (those govern fetch/XHR/WS), so the existing
Caddyfile and the desktop CORS-bypass plumbing need no changes.

### `lib/files.ts` — add `downloadUrl`

Sibling of the existing `downloadBlob` (`files.ts:110-119`): create a temporary `<a>` with
`href = url`, `download = filename` (a hint; the server's `Content-Disposition` wins), `rel =
"noopener"`, click, remove. (No `revokeObjectURL` — it's a real URL, not an object URL.)

### Context menu — `components/files/FileBrowser.tsx`

Add a `ContextMenuItem` to `menuItems` (`FileBrowser.tsx:253-264`) when `menu.target` exists,
branching on `target.kind`:

- file → `{ label: "Download", icon: <Download/>, onClick: () => void downloadPath(api, target) }`
- dir → `{ label: "Download as Zip", icon: <FolderDown/>, onClick: …, disabled: capsLoaded && !caps.folderZip }`

Fetch capabilities once on mount (`api.getFsCapabilities()` into local state); assume enabled until
loaded (optimistic — a click before load still works on a capable server). `Download` is already a
lucide import in `BinaryCard.tsx`; `FolderDown` is available from lucide.

### Preview header — `components/files/FilePreview.tsx`

Add a download icon button next to Save in `TextPreview`'s header (`FilePreview.tsx:115-137`) and in
the shared `PreviewHeader` (`FilePreview.tsx:86-99`) so every previewed file gets one. Always the
single-file path: `onClick={() => void downloadPath(api, { path, name: baseName(path), kind: "file" })}`.

## Runtime parity (web vs desktop)

Identical client code; the only difference is which `downloadPath` branch runs, decided by the
already-abstracted `transporter.kind`. **No Electron changes** — desktop-remote uses the native
navigation through Chromium, desktop-local uses the already-implemented `requestBytes` bridge +
`downloadBlob`. No new IPC, no preload changes, no new injection seam (the native "Save As" dialog
that *would* need one is explicitly out of scope for v1).

## Limits & edge cases

- **No size cap on the download path.** Files stream via `createReadStream` (server) and the browser
  download manager (client); folder zips stream from the tool's stdout. Only the desktop-local
  buffered fallback is memory-bound — accepted, since those files are already on the same machine
  and a terminal is available.
- **Empty folder:** some tools exit non-zero with an empty input; verify behavior and either emit a
  valid empty/dir-entry zip or surface a clean error (not a hang). (Open item.)
- **Symlinked target dir / special files:** `assertInsideFsRoot` realpaths the path; non-file/
  non-dir `stat` types → 400. Tree-level symlink classification is pre-existing behavior, out of
  scope.
- **Non-ASCII / special-char filenames:** encoded via RFC 5987 `filename*` in `Content-Disposition`.
- **Concurrent / abandoned downloads:** fine (single-user); abandoned folder zips are killed on
  client disconnect.

## Security

- **Path traversal:** the path is validated by the same `assertInsideFsRoot` guard every other
  `/api/fs/*` route uses — nothing escapes `fsRoot` regardless of client input.
- **Symlink containment (the reason for store-not-follow flags):** if the zip tool *followed*
  symlinks, a link inside the folder pointing at e.g. `/etc/passwd` would let the daemon read
  **outside `fsRoot`** while zipping. Every tool is invoked with store-symlinks-as-links semantics,
  so the daemon never dereferences a link out of the sandbox.
- **Auth surface:** the download route accepts `?token=` — a bcrypt hash (not the plaintext
  password), over HTTPS, redacted from logs, scoped to this one route. This mirrors the existing
  `/ws` precedent and is the documented, accepted trade-off; capabilities and all other routes stay
  header-only.
- **Resource use:** streamed end-to-end (no server-side full-archive buffering); child killed on
  disconnect; single-user scope makes an unbounded-time zip acceptable.
- Inherits the existing remote bearer auth; `/api/fs/*` is already allowed on both transports (no
  secret material is involved).

## Config / constants

- **No new size constant** — the download path is uncapped/streamed. `RAW_MAX_BYTES` (50 MB) and the
  inline-preview caps are untouched (different feature).
- Reuse archive.ts's `onPath`/PATH-probe helper for `zip.ts` (export or factor a shared util — no
  duplication).
- **Provisioning:** the VPS installs `p7zip-full` (gives `7z`) but not `zip`/`bsdtar`. If the `7z
  -snl -so` combination doesn't yield a valid, symlink-safe zip on the VPS's p7zip build (see
  *Risks*), add `libarchive-tools` (`bsdtar`) or `zip` to the provisioning apt list in `AGENTS.md`.

## Build order

1. **`packages/api`** — `FsCapabilitiesResponse` + the three client method signatures (depends on
   nothing).
2. **`apps/daemon`** — `zip.ts` (tool resolution + stdout-zip spawner, symlink-safe flags);
   `GET /api/fs/download` (stat → file stream / dir zip, hijack + disconnect-kill);
   `GET /api/fs/capabilities`; extend the auth hook for `?token=` on the download route.
3. **`packages/ui`** — `ApiClient.{getFsCapabilities,buildDownloadUrl,downloadBytes}`;
   `files.ts` `downloadUrl`; `lib/download.ts` `downloadPath`; `FileBrowser` context-menu item +
   capability fetch; `FilePreview` header buttons.
4. **Docs** — `AGENTS.md` note (new download endpoint + the zip-tool gating, in the style of the
   existing "Archive preview is host-tool-gated" entry) + any provisioning addition.
5. **Verify** (below). `pnpm check` stays clean throughout.

## Verification plan

No test runner in this repo — per project convention, "done" = `pnpm check` clean **and** the real
app/daemon driven:

**Daemon (curl over HTTP and the Unix socket):**
1. **File:** download a known file → bytes match; `Content-Disposition: attachment` + correct
   filename + `Content-Length`.
2. **Large file (>50 MB):** downloads fully → proves the 50 MB preview cap doesn't apply here.
3. **Folder:** download a folder → pipe to `unzip -t` → valid zip; structure + contents correct.
4. **Auth:** missing/!valid `?token=` over HTTP → 401; valid token → 200. Bad/absent header on the
   socket path still works (socket is unauthenticated).
5. **Traversal:** `path=../../etc/passwd` → 403 `FS_FORBIDDEN`, nothing served.
6. **Symlink containment:** a folder containing a symlink to a file **outside** `fsRoot` → the zip
   stores the link, does **not** include the external file's contents.
7. **No tool:** with the zip tool removed from PATH, `/api/fs/capabilities` → `folderZip:false` and
   a folder download → 501.

**Web UI (daemon-served SPA):**
8. Right-click a file → downloads; right-click a folder → downloads a valid `<name>.zip`.
9. Preview-header download button works for text and a binary (image/PDF).
10. Folder context item is disabled when `folderZip:false`.

**Both runtimes:** web (HTTPS, native navigation) and desktop-local (socket, buffered) both
download a file and a folder zip. `pnpm check` clean.

## Alternatives considered

- **Client-side zip (JSZip):** rejected — violates the thin-client design, loads the whole folder
  into browser memory, needs one request per file, adds a client dependency.
- **Node-library zip (`archiver`) on the daemon:** rejected for v1 — a new runtime dependency
  against the codebase's host-tool-for-archives convention. Kept as the fallback if host tools prove
  unreliable across target platforms.
- **Reuse `/api/fs/raw` with a `Content-Disposition` header:** rejected — its 50 MB cap and full-
  buffer behavior are intentional for inline preview; download needs uncapped streaming and a
  folder branch.
- **Buffered-blob everywhere (no `?token=`):** rejected for the primary path — a large file/folder
  would be held entirely in browser memory; kept only as the desktop-local fallback.
- **Native "Save As" dialog on desktop** (`dialog.showSaveDialog` + a streaming IPC + a new
  host-capability injection seam mirroring `windowControls`): deferred to a later iteration — the
  browser/Chromium default download is sufficient and adds zero Electron code for v1.
- **`showSaveFilePicker` (File System Access API) + fetch-with-auth streaming:** rejected — limited
  browser support and more complexity than a native `<a download>` for no v1 benefit.

## Risks / open items

- **`7z -snl -so` on the VPS p7zip build:** the production-guaranteed tool is `7z`; must verify that
  `7z a -tzip -snl -so` emits a **valid** zip to stdout **and** honors `-snl` (store symlinks) on
  that build. If not, add `libarchive-tools`/`zip` to provisioning and adjust resolver priority.
- **Empty-folder zip:** confirm each tool's behavior on an empty directory and handle gracefully.
- **Desktop-local large zips** buffer in memory (accepted per the saving decision; terminal
  available for very large cases).
- **`?token=` in URL** is an accepted surface mirroring `/ws`; revisit only if the auth posture
  changes.
