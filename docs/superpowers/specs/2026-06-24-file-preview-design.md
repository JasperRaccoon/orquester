# File browser — preview images, PDFs, media & archives

- **Date:** 2026-06-24
- **Status:** Design — pending review
- **Scope:** Replace the text-only file viewer in the project **Files** tab with a viewer that
  picks a renderer by file kind: images, PDFs (via pdf.js), audio, video, and archive
  **content listings** (zip/rar/7z/tar/…), falling back to a download card for anything else.
  Text files keep today's editable CodeMirror behavior unchanged.

## Goal

When a user selects a non-text file in the file tree, show it **as what it is** instead of
UTF-8-decoding the bytes into garbled text. Images render as images, PDFs render page-by-page,
audio/video play in native controls, and archives show the list of files inside them. Unknown or
oversized files get a clean "download" card — never garbage text.

## Current behavior (the bug)

`FileContent` (inline in `packages/ui/src/components/files/FileBrowser.tsx`) calls
`api.readFile(path)` → `GET /api/fs/read`, which on the daemon does:

```ts
content: buffer.subarray(0, cap).toString("utf8")   // apps/daemon/src/index.ts
```

i.e. it **always UTF-8-decodes** every file and caps at 1 MB. The result is always fed to the
CodeMirror `Editor`. Binary files are detected only well enough to force read-only
(a null-byte check), but they still render as mojibake. There is no concept of a file
*kind*, and no way to get raw bytes to the client.

## Design overview — a viewer dispatcher keyed on file kind

Replace the inline `FileContent` with a **`FilePreview`** dispatcher. On selecting a file it
classifies the file by extension, then mounts the matching viewer:

| Kind | Trigger extensions | Viewer | How content arrives |
|---|---|---|---|
| `text` | everything else (default) | existing CodeMirror `Editor` — **unchanged**, still edits & saves | `GET /api/fs/read` (today's path) |
| `image` | png, jpg, jpeg, gif, webp, svg, bmp, ico, avif | `<img>` on a blob URL | bytes via Transporter |
| `pdf` | pdf | **pdf.js** → pages rendered to `<canvas>` | `ArrayBuffer` via Transporter |
| `audio` | mp3, wav, ogg, m4a, flac, aac | `<audio controls>` on a blob URL | bytes via Transporter |
| `video` | mp4, webm, mov, mkv, m4v | `<video controls>` on a blob URL | bytes via Transporter |
| `archive` | zip, rar, 7z, tar, tar.gz/tgz, gz, bz2, xz | listing view (read-only entry tree) | `GET /api/fs/archive` → small JSON |
| `binary` | unknown, or **any file over its preview cap** | download + metadata card | bytes via Transporter (on demand) |

**Detection is extension-based**, in a new `packages/ui/src/lib/file-kind.ts`
(`detectFileKind(filename) → { kind, mime }`, plus the `PREVIEW_CAP_BY_KIND` table used by the
dispatcher — see "Size caps"). This mirrors how the existing `Editor` already uses CodeMirror's
`LanguageDescription.matchFilename` to pick a language — predictable, synchronous, zero-cost, and
easy to extend. Magic-byte sniffing is intentionally **not** done (YAGNI; extensions are reliable
enough for a single-user tool browsing its own project files).

### Why two different content paths

The renderable kinds (image/pdf/audio/video/binary) need the **actual bytes** at the client to
render. Archives are the opposite: we never want to ship a 200 MB zip to the browser just to show a
file list, so archives are **parsed on the daemon** (which shells out to a host archive tool) and
only a small JSON listing crosses the wire. This split is the backbone of the design.

## Daemon — two new routes

Both live in `apps/daemon/src/index.ts` alongside the existing `/api/fs/*` routes and reuse the
same `assertInsideFsRoot(resolved.fsRoot, path)` sandbox guard plus the
`FsSandboxError → 403` / generic `→ 400` error mapping. Both are allowed over the remote HTTP
transport (read-only, sandboxed — same posture as `/api/fs/read`).

### `GET /api/fs/raw?path=…`

Returns the file's **raw bytes**, no decode:

- `stat` the file; if `size > RAW_MAX_BYTES` → `413` with a JSON error (the client already knows the
  size from the directory listing and normally won't call this past the cap, but the route enforces
  it as a hard backstop so a single read can't exhaust memory).
- Otherwise `reply.type("application/octet-stream").header("X-Content-Type-Options", "nosniff").send(buffer)`.
- The client determines the real MIME from the extension and rewraps the bytes in a typed `Blob`,
  so serving a generic `application/octet-stream` is both **safe** (an `.svg`/`.html` is never
  served as `text/html`, so no stored-XSS via the raw route) and sufficient.

`RAW_MAX_BYTES = 50 * 1024 * 1024` (50 MB) — a named constant. It is the **absolute ceiling** on any
single read (memory backstop) and the **in-app download ceiling**: above it, a file is neither
previewed nor downloaded in-app, and the card states the size and suggests a terminal. Whether a
file under this ceiling is *previewed inline* vs shown as a download card is a finer, **per-kind
client policy** (see "Size caps" below) — the route itself only enforces the single 50 MB backstop
and stays agnostic to file kind.

### `GET /api/fs/archive?path=…`

Lists the entries inside an archive **without extracting**, by shelling out to a host tool:

- **Tool resolution** mirrors `RegistryService`'s "resolve a bin against PATH" pattern, resolved
  once and cached: prefer `7z` / `7zz` / `7za` (lists zip **and** rar/7z/tar/gz/xz/bz2), else
  `bsdtar -tf` (libarchive — broad format support), else format-specific (`unzip -l`, `tar -tf`).
- **Spawned via `execFile`/`spawn` with an argument array — never a shell string.** The path is
  already sandbox-validated; passing it as an arg (not interpolated into a command line) eliminates
  command-injection risk.
- Parse the tool's text output into `entries: { name, size, dir }[]`. Cap at ~5,000 entries with a
  `truncated` flag so a pathological archive can't produce an unbounded response.
- Response shape: `{ supported: boolean; entries: ArchiveEntry[]; truncated: boolean; tool?: string; reason?: string }`.
  If no available tool can read the format → `{ supported: false, reason }`, and the UI shows the
  download card instead of a listing.

Listing reads only the archive **index** (the tool streams it), so large archives list fine and
their bytes never touch the daemon's or the client's memory.

The existing `GET /api/fs/read` is unchanged and remains the path for `text` files (its existing
null-byte read-only guard stays as a backstop).

## Transport — one new capability on the `Transporter` seam

The desktop **renderer cannot reach the Unix-socket daemon via a URL**, so an `<img src="…socket…">`
is impossible there; everything must ride the existing pluggable `Transporter`
(`packages/ui/src/lib/transporter.ts`). Add one optional method:

```ts
requestBytes?(req: TransportRequest): Promise<TransportResponse<ArrayBuffer>>;
```

- **Web (`HttpTransporter`)** — `fetch(url, { headers: authHeaders })` → `res.arrayBuffer()`.
- **Desktop local (`apps/desktop/src/transport/unix-socket-transporter.ts`)** and **desktop remote
  (`node-http-client.ts`)** — today the IPC handlers in `apps/desktop/src/main.ts` finish with
  `Buffer.concat(chunks).toString("utf8")`, which corrupts binary. Add a **binary IPC path** that
  returns the raw `Buffer` (Electron's structured-clone carries `Buffer`/`Uint8Array` intact)
  instead of decoding to a string, surfaced through `apps/desktop/src/preload.cjs`. This is the
  only Electron-main change.

On top of that the UI `ApiClient` (`packages/ui/src/lib/api-client.ts`) gains:

- `readFileBytes(path): Promise<ArrayBuffer>` → `requestBytes("GET", "/api/fs/raw", { query: { path } })`.
- `listArchive(path): Promise<FsArchiveResponse>` → `request("GET", "/api/fs/archive", …)`.

New wire contracts in `packages/api/src/index.ts`: `ArchiveEntry`, `FsArchiveResponse` (and the
matching methods on the reference `HttpOrquesterApiClient`).

### Blob-URL lifecycle (`useObjectUrl`)

A new `packages/ui/src/hooks/use-object-url.ts`:

```
useObjectUrl(path, mime, enabled) →
  fetch bytes → URL.createObjectURL(new Blob([bytes], { type: mime }))
  revoke the previous URL on path change; revoke on unmount; abort in-flight fetch on change
```

This is the key memory-correctness guard: object URLs are explicitly revoked so previews don't leak.
PDF is the one exception — pdf.js consumes the `ArrayBuffer` directly via `getDocument({ data })`,
so `PdfViewer` uses `readFileBytes` without creating an object URL (it copies the buffer if the same
bytes are also needed for download, since pdf.js may detach it).

## UI components

`FileBrowser.tsx` is already ~640 lines, so the preview is **lifted out** into its own files rather
than grown further (a focused-boundary improvement on code this change already touches). New under
`packages/ui/src/components/files/`:

- `FilePreview.tsx` — the dispatcher; replaces the inline `FileContent`. Owns the header
  (filename, mobile back button, **Save** for `text` only, **Download** for every non-text kind).
- `viewers/ImageViewer.tsx` — centered `<img>` on a fit-to-pane background.
- `viewers/PdfViewer.tsx` — pdf.js canvas renderer (see below).
- `viewers/MediaViewer.tsx` — `<audio>` / `<video controls>`.
- `viewers/ArchiveViewer.tsx` — read-only listing from `listArchive`; shows `truncated` notice and
  falls back to `BinaryCard` when `supported: false`.
- `viewers/BinaryCard.tsx` — metadata (name, size, type); renders in two states — **downloadable**
  (≤ 50 MB: unknown binary, or a non-video over its 25 MB preview cap) with a **Download** button,
  and **over-ceiling** (> 50 MB: download disabled, suggests a terminal). See "Size caps" below.
- `hooks/use-object-url.ts`, `lib/file-kind.ts`, and a `downloadBlob(name, blob)` helper beside the
  existing `lib/files.ts`.

### pdf.js integration

- New dependency **`pdfjs-dist`** in `packages/ui`.
- Worker is loaded via Vite's worker import:
  `import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker"` →
  `GlobalWorkerOptions.workerPort = new PdfWorker()`. `packages/ui` is consumed **as source** by
  both `apps/web` and `apps/desktop`, and both build their renderer with Vite, so the `?worker`
  query resolves correctly in each app's build (no inter-package build step needed).
- `PdfViewer` renders pages to `<canvas>` (lazy/scroll-rendered for multi-page docs). Because it
  renders from bytes, it works **identically on web and desktop** — there is no dependency on
  Electron's `webPreferences.plugins` PDF plugin. Cost to note: `pdfjs-dist` adds a few hundred KB
  to the renderer bundle.

## Size caps & download tiers

Two cap layers, deciding *render inline* vs *download card* vs *neither*:

- **`RAW_MAX_BYTES = 50 MB`** (daemon) — absolute read ceiling + in-app download ceiling. Enforced
  on `/api/fs/raw`; kind-agnostic.
- **Per-kind preview cap** (client, in `lib/file-kind.ts` as `PREVIEW_CAP_BY_KIND`) — `video: 50 MB`,
  everything else (image, audio, pdf, binary) `25 MB`. The client already has `size` (from the
  directory listing's `FsEntry.size`) and `kind`, so it decides inline-vs-card *before* fetching
  bytes — no wasted fetch for a file it won't render.

Resulting tiers:

| File size | image / pdf / audio | video |
|---|---|---|
| ≤ 25 MB | preview inline | preview inline |
| 25 MB – 50 MB | download card (download **works**) | preview inline |
| > 50 MB | card, **no** in-app download (suggest a terminal) | card, no download |

So `BinaryCard` has two visual states: **downloadable** (file ≤ `RAW_MAX_BYTES`, over its preview
cap or just an unknown binary) and **over-ceiling** (file > `RAW_MAX_BYTES`, download disabled).
`useObjectUrl` only fetches when the file is within the download ceiling.

## Error handling & edge cases

| Situation | Behavior |
|---|---|
| Bytes fetch fails | error card ("Could not load file.") |
| Over per-kind preview cap but ≤ 50 MB | "Too large to preview (N MB)" card, **download still works** |
| Over `RAW_MAX_BYTES` (50 MB) | "Too large to preview (N MB)" card, in-app download disabled (suggest a terminal) |
| Archive format unsupported / no host tool | `{ supported: false }` → download card with a short note |
| Archive with >5,000 entries | listing shown + "truncated" notice |
| SVG | rendered via `<img>` on a blob (script-less `<img>` context — safe) |
| Text file (unchanged) | CodeMirror, editable, Save works as today |

## Security

- Both new routes reuse `assertInsideFsRoot` — no new path-traversal surface; both are read-only.
- `/api/fs/archive` spawns the tool with an **args array, no shell** → no command injection; the
  path is sandbox-validated before spawn.
- `/api/fs/raw` serves `application/octet-stream` + `nosniff`; the client controls the rendered
  MIME via the `Blob` type, so untrusted `.svg`/`.html` is never interpreted as active content from
  the raw route.
- Approach uses the Transporter's normal auth (bearer header / IPC bridge), **not** a `?token=` URL,
  so there's no token-in-URL logging concern.
- Entry-count and byte caps bound response/memory size.

## Deployment note

Archive **content listing** depends on a host archive tool being present. On a stock VPS this means
adding one package — `p7zip-full` (provides `7z`/`7za`) or `libarchive-tools` (provides `bsdtar`).
Without it, archives degrade gracefully to the download card (`supported: false`). To be documented
in `AGENTS.md` (provisioning) and `deploy/README.md`.

## Verification (no test runner)

`pnpm check` clean, then drive the real app:

1. Drop a png, an svg, a pdf (multi-page), an mp3, an mp4, a zip, and a rar into a `.stage`
   workspace; open each and confirm the correct viewer renders / plays.
2. Open a text/code file → confirm CodeMirror still edits **and saves**.
3. Size tiers: a ~30 MB image → "too large to preview" card with a **working** download; a ~40 MB
   mp4 → **plays** inline (under the 50 MB video cap); a >50 MB file → card with download **disabled**.
4. Open an archive on a host **with** `7z`/`bsdtar` (listing) and simulate one **without**
   (download card).
5. Repeat the image/pdf/archive checks on the **desktop** app specifically — that exercises the new
   binary-IPC path and the pdf.js-on-Electron rendering, where the cross-client risk concentrates.

## File-by-file change summary

**Daemon**
- `apps/daemon/src/index.ts` — add `GET /api/fs/raw` and `GET /api/fs/archive`; add `RAW_MAX_BYTES`;
  add cached archive-tool resolution + output parsing (possibly factored into a small
  `apps/daemon/src/archive.ts`).

**Wire contracts**
- `packages/api/src/index.ts` — `ArchiveEntry`, `FsArchiveResponse`; reference-client methods.

**Transport**
- `packages/ui/src/lib/transporter.ts` — add optional `requestBytes`.
- `packages/ui/src/lib/transporters/http-transporter.ts` — web `requestBytes` (fetch → arrayBuffer).
- `apps/desktop/src/transport/unix-socket-transporter.ts`, `node-http-client.ts` — binary path.
- `apps/desktop/src/main.ts`, `apps/desktop/src/preload.cjs` — binary IPC bridge.

**UI**
- `packages/ui/src/lib/api-client.ts` — `readFileBytes`, `listArchive`.
- `packages/ui/src/lib/file-kind.ts` — `detectFileKind`.
- `packages/ui/src/hooks/use-object-url.ts` — blob-URL lifecycle.
- `packages/ui/src/components/files/FilePreview.tsx` + `viewers/*` (Image, Pdf, Media, Archive,
  BinaryCard) + `downloadBlob` helper.
- `packages/ui/src/components/files/FileBrowser.tsx` — replace inline `FileContent` with
  `<FilePreview>`.
- `packages/ui/package.json` — add `pdfjs-dist`.

**Docs**
- `AGENTS.md`, `deploy/README.md` — note the optional archive-tool dependency.
