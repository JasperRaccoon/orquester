# Terminal file drop & paste → agent attachment

- **Date:** 2026-06-22
- **Status:** Design — pending review
- **Scope:** Let users drag a file onto a terminal (or paste one from the clipboard) and have it
  attached to the running coding agent, the way a native Claude Code / Codex terminal shows
  `[Image #N]`.

## Goal

When a file is **dropped onto** or **pasted into** a terminal, get the file's bytes to the daemon,
write it to a daemon-side path, and inject that path into the session as input — so the running
agent (`claude`, `codex`, …) picks it up exactly as if the file had been dragged into a local
terminal. Any file type is supported; images additionally render as `[Image #N]` in agents that
recognize them.

## Why this isn't trivial (the architecture insight)

In a **native** terminal, dragging a file just inserts its **path**, and the agent — running on the
same machine — reads that path. In Orquester the agent runs inside the **daemon's PTY**, which for
the web client is the **VPS**, a *different machine* from the browser. A dropped file's local path
is therefore meaningless to the agent.

So the flow must be: **read bytes in the client → upload to the daemon → daemon writes a file →
inject the daemon-side absolute path into the session.** This is uniform across both runtimes:

- **Web SPA:** browser can't see local file paths anyway — it must upload.
- **Electron desktop:** Electron 33 with `contextIsolation: true` does **not** expose `File.path`,
  and the daemon is local — so uploading over the existing Unix-socket bridge is just as simple and
  needs no new IPC channel or `webUtils` plumbing.

One code path, both runtimes.

## User-facing behavior

- **Drag** one or more files onto any terminal → terminal shows a drag-over highlight → on drop,
  files upload and their paths are injected into that session's input.
- **Paste** (Cmd/Ctrl+V) when the clipboard holds an image or files → same upload + inject. (A
  clipboard *image* with no filename — e.g. a screenshot — is named `pasted-<id>.png` from its MIME
  type.) A normal text paste is unaffected and still goes to the PTY.
- After injection, an image shows as `[Image #N]` in agents that support it; other files appear as
  their path. The user then types their prompt and submits as usual.
- Failures (too large, upload error, no active session) surface as a brief, non-blocking inline
  notice; nothing is injected.

## End-to-end flow

1. `TerminalView` `drop`/`paste` handler collects `File[]` from `dataTransfer.files` /
   `clipboardData` (`.files` plus image `items`).
2. For each file: client-side size check, then read as bytes and base64-encode.
3. `apiClient.uploadSessionFile(sessionId, { name, type, dataBase64 })` →
   `POST /api/sessions/:id/upload` (over HTTPS for web, over the socket bridge for desktop — both
   are the existing transport; only this route gets a raised body limit).
4. Daemon validates the session exists, decodes, sanitizes the name, writes to
   `<appdir>/daemon/uploads/<sessionId>/<id>-<safeName>`, returns `{ path }` (absolute).
5. Client injects the path(s) into the session via the existing `sendSessionInput` seam.
6. Agent reads the path → `[Image #N]` (images) or the path text (other files).

## Wire contracts (`packages/api`)

```ts
export interface SessionUploadRequest {
  name: string;            // original filename (may be empty for clipboard images)
  type?: string;           // MIME type if known (e.g. "image/png")
  dataBase64: string;      // base64-encoded file bytes
}

export interface SessionUploadResponse {
  path: string;            // absolute daemon-side path the agent can read
  name: string;            // final on-disk basename (sanitized)
  size: number;            // bytes written
}
```

Add to the reference client (`HttpOrquesterApiClient`) and the UI `ApiClient`:

```ts
uploadSessionFile(id: string, body: SessionUploadRequest): Promise<SessionUploadResponse>;
```

This rides the normal request path (JSON body), so it works over both the HTTP transporter and the
desktop Unix-socket bridge with no transport changes.

## Daemon (`apps/daemon/src`)

### Upload endpoint

`POST /api/sessions/:id/upload`, registered with a **route-level `bodyLimit`** (the global default
is 256 KB; this route needs ~40 MB to fit a base64-encoded 25 MB file). It lives under `/api`, so it
inherits the existing bearer-auth hook on the remote transport automatically.

Handler:
1. `sessions.get(id)` → 404 if the session doesn't exist.
2. Reject if `dataBase64` missing/oversized (decoded length > cap) → 413.
3. Decode base64 to a Buffer.
4. Sanitize the basename: strip any directory components, keep `[A-Za-z0-9._-]`, collapse the rest,
   drop spaces; if empty, derive from MIME (`pasted-<id>.<ext>`); always prefix a short random id to
   avoid collisions and keep names space-free (so no shell quoting is ever needed).
5. `mkdir(<appdir>/daemon/uploads/<id>, { recursive: true, mode: 0o700 })`, then
   `writeFile(path, buf, { mode: 0o600 })` — mirroring the existing accounts.json / keys conventions.
6. Return `{ path, name, size }`.

### Storage & naming

- Location: **`<appdir>/daemon/uploads/<sessionId>/<id>-<safeName>`** — daemon-private, *not* under
  `fsRoot`. The client never supplies the directory or the final name, so there's no path-traversal
  surface. Keeping uploads out of the project/workspace dir avoids littering repos and accidental
  commits. The absolute path is injected, so the agent reads it regardless of its cwd.
- In production the agent runs as the `orquester` user with the appdir as its writable carve-out
  (`ReadWritePaths=/var/lib/orquester`), so it can read these files; the tmux server + agents are in
  the same systemd unit and inherit that sandbox.

### Limits & validation

- **Size cap:** 25 MB decoded (constant `MAX_UPLOAD_BYTES`); route `bodyLimit` set to ~40 MB to
  cover base64 + JSON overhead. Client also checks size before uploading to fail fast.
- **Type:** any file is allowed (per scope). No magic-byte gating; the daemon-private dir + sanitized
  name + size cap are the controls.

### Cleanup

- **On session exit:** hook the session lifecycle (`sessions.lifecycle` "exited" event) to
  `rm(<appdir>/daemon/uploads/<id>, { recursive: true, force: true })`.
- **On boot:** after `sessions.reattach()`, remove any `uploads/<id>` dir with no matching live
  session (orphans from a crash). Both are best-effort (`.catch(() => {})`).

## UI (`packages/ui`)

### Drop & paste handlers (`TerminalView.tsx`)

- `dragover`/`dragenter`: `preventDefault()` and set a `dragging` state (no global app-root handler
  swallows file drops today, confirmed). `dragleave`/`drop`: clear it.
- `drop`: `preventDefault()`, collect `event.dataTransfer.files`.
- `paste`: read `event.clipboardData` — `.files` for pasted files, plus `.items` of kind `file` for
  raw clipboard images. If any files are present, `preventDefault()` (so xterm doesn't also paste the
  text) and handle them; otherwise let the normal text paste through to the PTY.
- Both go through one `handleFiles(files: File[])` helper.

### Upload + path injection

`handleFiles`: filter empties, enforce the size cap (brief notice on reject), upload each via
`apiClient.uploadSessionFile`, collect returned paths in drop order, then inject **once** with all
paths. Show a subtle "uploading…" affordance while in flight.

### Injection format (the key unknown — verify, don't assume)

Whether the agent converts the path to `[Image #N]` depends on its own paste/path detection. The two
candidate formats:

- **A — bracketed paste:** `\x1b[200~` + paths (space-joined) + `\x1b[201~`. Agents' TUIs enable
  bracketed-paste mode and run their attach/detection on pasted text; this mimics how a native drag
  is delivered.
- **B — raw:** the path(s) + a trailing space, no escape wrapper.

**Plan:** default to **A**, and during verification test both against a real `claude` *and* `codex`
session; lock in whichever reliably yields `[Image #N]` for an image. No shell escaping is applied —
we're feeding the agent's prompt, not executing a shell command, and names are space-free by
construction. If neither auto-converts on some agent/version, the path is still inserted (graceful
degradation) and the feature is still useful.

### Visual feedback

A border/overlay highlight on the terminal container while `dragging`, and a short-lived inline
status line for "uploading…" / errors. Reuse existing styling tokens; keep it minimal.

## Runtime parity (web vs desktop)

Identical client code. The only difference is transport, which is already abstracted: the web SPA
uses the HTTP transporter, the desktop uses the Unix-socket bridge — both carry the JSON upload body
unchanged. No Electron-specific path extraction, no new IPC channel.

## Security

- Client supplies only bytes + a name hint; the daemon fully controls the directory and final
  filename (random-prefixed, sanitized) → no traversal, no overwrite of arbitrary paths.
- Files land in a 0700 daemon-private dir, 0600 per file; never returned by `/api/fs/*` (outside
  `fsRoot`).
- Size-capped to bound memory/disk; the route's raised body limit is scoped to this one endpoint.
- Inherits the existing remote bearer auth; no new auth surface.

## Config / constants

- `MAX_UPLOAD_BYTES = 25 * 1024 * 1024` (daemon constant; route `bodyLimit ≈ 40 MB`).
- No new daemon.json schema field for now (YAGNI); can be promoted to config later if needed.

## Build order

1. `packages/api` — add the request/response types + client method (depends on nothing).
2. `apps/daemon` — upload route + storage/cleanup; wire the lifecycle + boot sweep.
3. `packages/ui` — `ApiClient.uploadSessionFile`, then `TerminalView` drop/paste/inject + visuals.
4. Verify (below). `pnpm check` must stay clean throughout.

## Verification plan

Driven against a real daemon (the daemon-served SPA harness used previously), not mocks:

1. **Image, drag:** start a real `claude` session, drop a PNG → agent shows `[Image #1]`. Repeat for
   `codex`.
2. **Image, paste:** copy a screenshot, Cmd/Ctrl+V into the terminal → `[Image #1]`.
3. **Non-image, drag:** drop a `.txt`/`.pdf` → path is injected (agent shows path / `[File]` per its
   own behavior).
4. **Multiple files:** drop two at once → both paths injected in order.
5. **Format lock-in:** confirm whether A (bracketed paste) or B (raw) triggers `[Image #N]`; set the
   chosen format.
6. **Size cap:** oversized file → rejected client-side with a notice, nothing injected.
7. **Cleanup:** kill the session → its `uploads/<id>` dir is removed; restart daemon with an orphan
   dir present → it's swept.
8. **Both runtimes:** confirm web (HTTPS) and desktop (socket) paths both upload + inject.
9. `pnpm check` clean.

## Alternatives considered

- **Multipart / `application/octet-stream` upload** instead of base64-in-JSON: avoids the ~33%
  base64 inflation, but requires `@fastify/multipart` and makes the desktop socket bridge carry
  binary — more plumbing for a single-user app with occasional uploads. Rejected for uniformity.
- **Write into the session's project dir** so the agent can use a short relative path and the user
  sees the file: rejected to avoid cluttering repos / accidental commits; absolute-path injection
  from a private dir is cleaner.
- **Desktop fast-path via `webUtils.getPathForFile`** (skip upload, inject the real local path):
  a possible later optimization, but the local socket upload is already instant and a single code
  path is simpler. Not now.

## Risks / open items

- **Injection-format dependence** (the main risk): resolved by verifying A vs B against real
  `claude`/`codex` before shipping; graceful degradation if an agent doesn't auto-convert.
- **Large base64 over IPC** on desktop: a 25 MB file is a ~33 MB string through `ipcRenderer.invoke`
  — acceptable for single-user occasional use; the size cap bounds it.
