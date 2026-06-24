# Mobile agent file attach — design

**Date:** 2026-06-24
**Status:** approved, pending implementation plan
**Related:** `2026-06-22-terminal-file-drop-design.md` (the desktop drag-and-drop this ports)

## Summary

On the desktop/web client you can drag a file or image from the OS file explorer onto an
agent terminal to drop its path into the agent's prompt. On a phone there is no drag source,
so the feature is unreachable. This adds a **file-attach button to the mobile control-key bar
(`MobileKeyBar`)** that opens the native file picker and runs the **exact same upload-and-inject
flow** the desktop drop already uses. The button is shown **only for agent sessions**.

## Background

The drop flow lives entirely in `packages/ui/src/components/terminal/TerminalView.tsx` and is
already 100% browser-standard — it does **not** use Electron `file.path`, so it works on any
client. The only thing missing on mobile is a way to *acquire* a `File`.

Today the reusable core is inline in `TerminalView`:

- `MAX_UPLOAD_BYTES` (25 MB) — `TerminalView.tsx:16`, mirrors the daemon's decoded cap.
- `injectionForPaths(paths)` — `TerminalView.tsx:71–75`. Wraps the space-joined paths in
  bracketed-paste escapes (`\x1b[200~`…`\x1b[201~`) with **no trailing Enter** — the path is
  inserted, never submitted. The format is, per its own comment, "locked in via runtime
  verification against real agents," so it must stay single-sourced (never copied).
- `handleFilesRef.current(files)` — `TerminalView.tsx:114–148`. Filters empty/oversized files
  (emitting a "Skipped N over 25 MB" status), base64-encodes and uploads each file sequentially
  (preserving order), then injects all returned paths in one `sendSessionInput`.

End-to-end data flow (unchanged, reused as-is):

```
pick/drop File
  → fileToBase64                      (lib/files.ts)
  → POST /api/sessions/:id/upload     (api.uploadSessionFile)
  → daemon writes <appdir>/daemon/uploads/<sessionId>/<sanitized-name>, returns absolute path
  → api.sendSessionInput(id, injectionForPaths([path]))   → path lands in the prompt as a
    bracketed paste, no Enter
```

The mobile control-key bar is `packages/ui/src/components/terminal/MobileKeyBar.tsx`: a
mobile-only (`useIsDesktop()` is false, i.e. viewport < 768px), session-only toolbar of control
keys (Esc, Tab, ⌃C, ⌃D, arrows, ↵). It is a sibling of the terminal in `AppShell`, reads the
active session from the zustand store, and sends bytes via `api.sendSessionInput`. It currently
renders for **any** session tab (shell or agent).

## Goals

- A file-attach button in `MobileKeyBar` that puts a file's daemon-side path into the agent
  prompt, identical in effect to the desktop drag-and-drop.
- Reuse the existing upload + injection logic verbatim — same 25 MB cap, same bracketed-paste
  injection, same daemon route.
- Any file type, multiple files allowed (matches desktop drop).

## Non-goals

- No dedicated camera/photo-library buttons. A plain `<input type="file">` already lets iOS and
  Android offer Photo Library / Take Photo / Files from one tap, which covers the camera case.
- No restriction to image types.
- No change to the desktop drop behavior, the daemon upload route, or the injection format.
- No attach button for shell sessions (see Scope decision).

## Design

### 1. New shared module: `packages/ui/src/lib/session-upload.ts`

Lift the reusable core out of `TerminalView` so both the desktop drop handler and the new mobile
button share one implementation.

Exports:

- `MAX_UPLOAD_BYTES` — moved from `TerminalView`.
- `injectionForPaths(paths: string[]): string` — moved verbatim from `TerminalView`, comment
  block intact (it documents the locked-in bracketed-paste format).
- `uploadFilesToSession(api, sessionId, files, { onStatus }): Promise<void>` — the body of the
  current `handleFilesRef.current`, lifted unchanged:
  - filter `size > 0`; split into oversized (`> MAX_UPLOAD_BYTES`) and uploadable;
  - if any oversized → `onStatus({ text: "Skipped N file(s) over 25 MB", error: true })`;
  - if nothing uploadable → return;
  - `onStatus({ text: "Uploading N file(s)…" })`; sequentially `fileToBase64` →
    `api.uploadSessionFile` collecting paths; then
    `api.sendSessionInput(sessionId, injectionForPaths(paths))`; `onStatus(null)` on success;
  - on throw → `onStatus({ text: "Upload failed", error: true })`.

`onStatus(status | null)` is the only UX seam — each caller renders feedback its own way.
`api` is typed as the existing `ApiClient` (it only needs `uploadSessionFile` + `sendSessionInput`).
The status object shape is `{ text: string; error?: boolean }`, matching `TerminalView`'s
existing `status` state.

### 2. `TerminalView.tsx` — refactor, zero behavior change

- Remove the inline `MAX_UPLOAD_BYTES`, `injectionForPaths`, and the `handleFilesRef` body.
- `handleFilesRef.current = (files) => uploadFilesToSession(api, session.id, files, { onStatus: setStatus })`.
- Drag overlay, the `status` state, and the status line render unchanged.
- Parity is proven by `pnpm check` plus a manual desktop drop after the change.

### 3. `MobileKeyBar.tsx` — the attach button (agent-only)

- The bar still renders for all session tabs; **only the attach button is gated** to
  `active.session.kind === "agent"` (same discriminator `TerminalView` already uses at lines 245,
  367, 395). `SessionKind` is `"shell" | "agent"`, so this is shells-excluded.
- Add a hidden `<input type="file" multiple>` with **no `accept`** (any file type), a `ref`, and
  an `onChange` that calls
  `uploadFilesToSession(api, sessionId, Array.from(e.target.files), { onStatus: setStatus })`
  then resets `e.target.value = ""` (so re-picking the same file fires `change` again).
- A leading **Paperclip** button (lucide-react, already a dependency) triggers `input.click()`.
  - Unlike the control keys (which use `onPointerDown` + `preventDefault()` to keep the soft
    keyboard up), the attach button uses a normal `onClick` — opening the native picker inherently
    moves focus, which is expected here.
  - While uploading, the button shows a spinning `Loader2` and is `disabled`.
- Local state: `status: { text; error? } | null` (passed as `onStatus`) and an explicit `busy`
  flag set `true` immediately around the `uploadFilesToSession` call and cleared in a `finally`
  (not parsed from the status text). Error/skip statuses auto-clear after ~4 s via a `setTimeout`
  so a transient message doesn't linger in the horizontally-scrolling bar.
- Layout: the component root becomes a `flex flex-col shrink-0` wrapper holding (a) an optional
  thin status line above and (b) the existing button row (unchanged `overflow-x-auto` scroller).
  The status line mirrors `TerminalView`'s treatment: small text, red when `error`.

### Component tree (unchanged placement)

```
AppShell
└─ main column
   ├─ TopBar
   ├─ MainView            → TerminalView per session tab (xterm; desktop drop lives here)
   └─ MobileKeyBar        ← attach button added here; agent-only
```

## UX details

- **Success feedback:** none beyond the path appearing in the prompt — identical to desktop drop.
- **Icon:** `Paperclip` for attach, `Loader2` (`animate-spin`) while busy.
- **Placement:** leading position in the key row so it's visible without scrolling.
- **Focus:** attach button is allowed to take focus / close the keyboard (the picker takes over);
  control keys keep their no-focus behavior.

## Edge cases

- **Empty / 0-byte files:** filtered out by `uploadFilesToSession` (existing behavior).
- **Oversized (> 25 MB):** skipped with a status message; remaining files still upload (existing).
- **Same file re-picked:** `input.value` reset on every change so the picker re-fires.
- **Upload failure / offline:** caught → "Upload failed" status; no partial injection of failed
  paths (paths are only injected after all uploads resolve — existing behavior).
- **Non-agent session active:** attach button not rendered; control keys unaffected.

## Testing / verification

- `pnpm check` (typecheck — the pre-commit gate).
- Manual desktop regression: drag a file onto an agent terminal, confirm unchanged behavior
  (the refactor must be behavior-neutral).
- Manual mobile (narrow viewport / device): on an **agent** session, tap attach → pick a small
  image → confirm the daemon path lands in the prompt as a bracketed paste with **no Enter**;
  confirm the button has no effect on a **shell** session (not rendered); confirm a > 25 MB file
  shows the skip message and an offline upload shows "Upload failed".

## Files touched

- `packages/ui/src/lib/session-upload.ts` — **new** (shared `MAX_UPLOAD_BYTES`,
  `injectionForPaths`, `uploadFilesToSession`).
- `packages/ui/src/components/terminal/TerminalView.tsx` — use the shared module; remove the
  inlined copies. No behavior change.
- `packages/ui/src/components/terminal/MobileKeyBar.tsx` — hidden file input + agent-only attach
  button + status line.

## Decisions

- **Scope: agent sessions only.** The control-key bar still shows for all sessions, but the
  attach button renders only when `active.session.kind === "agent"`. (Chosen over all-sessions:
  attaching a file path is an agent-prompt affordance; a shell user gains nothing from it.)
- **Status placement:** a thin line above the key row, mirroring `TerminalView`'s status
  treatment (over a floating toast).
- **Logic sharing:** extract a shared orchestrator (`uploadFilesToSession`) rather than a hook or
  a copy — one source of truth for the 25 MB cap and the locked-in injection format.
