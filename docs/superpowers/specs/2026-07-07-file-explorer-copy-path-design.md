# File explorer — copy relative / full path (desktop + mobile)

- **Date:** 2026-07-07
- **Status:** Design — pending review
- **Scope:** Add two items to the file-tree row context menu — **Copy Relative Path** and **Copy
  Full Path** — and make the context menu (hence these actions, plus the existing Download/Delete)
  reachable on touch devices via **long-press**. Client-only change: `packages/ui`. No daemon, API,
  or wire-contract changes.

## Goal

Right-clicking (desktop) or long-pressing (mobile) a file or folder in the explorer lets the user
copy its path to the clipboard, either **relative to the project root** shown in the tree (e.g.
`apps/daemon/src/index.ts`) or **absolute** (e.g.
`/var/lib/orquester/workspaces/appsstats/orquester/apps/daemon/src/index.ts`). The relative form is
what you'd paste to an agent or terminal running in that project; the full form is the on-disk path.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| "Relative" base | The explorer's **project root** (`rootPath`, from `MainView.tsx:152`). Falls back to the full path if `rootPath` is empty or the target sits outside it. |
| Targets | **Files and folders** — same `menu.target` model as Download/Delete, not files only. |
| Mobile trigger | **Long-press** (~500 ms) opens the existing context menu at the touch point. No per-row UI added. |
| Clipboard | New shared `copyText()` helper: `navigator.clipboard.writeText` with a hidden-`<textarea>` + `execCommand("copy")` fallback for non-secure (`http://`) contexts. |
| `TerminalView` clipboard | Left untouched — it has its own local `writeClipboard` (`TerminalView.tsx:52`); out of scope. |

## User-facing behavior

- **Desktop:** right-click a file/folder → the menu now shows **Copy Relative Path** and **Copy
  Full Path** between Download and Delete (Delete stays last, as the destructive action). Clicking
  copies the string and closes the menu.
- **Mobile / touch:** press-and-hold a row ~0.5 s → the same menu opens at the touch point. A quick
  tap still selects a file / toggles a folder; dragging a finger to scroll the tree does **not**
  open the menu. After a long-press, the row is **not** also selected/toggled (the follow-up ghost
  click is swallowed).
- **Relative path of the project root itself:** not applicable — copy items only appear for a
  concrete `menu.target`; right-clicking the empty tree background (no target) shows no copy items,
  unchanged.
- **Failure:** clipboard write failures are swallowed (no crash); on a secure origin (the HTTPS/
  Caddy deploy and Electron) the primary path always succeeds.

## Implementation

All changes are in `packages/ui`.

### New — `packages/ui/src/lib/clipboard.ts`

A single cross-context helper:

```ts
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to the legacy path (permission denied / insecure context) */
  }
  // Fallback for non-secure contexts (http:// LAN/localhost) where navigator.clipboard is absent.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    /* clipboard unavailable — give up silently */
  }
}
```

`execCommand("copy")` is deprecated but universally supported and is the standard fallback; it only
runs when the async API is missing. Both paths are invoked from a user gesture (the menu-item tap),
which is what iOS Safari / Android Chrome require.

### `components/files/FileBrowser.tsx`

**1. Relative-path helper** — a pure function beside the existing `baseName`/`parentOf`/`joinPath`
(`FileBrowser.tsx:35-37`), reusing their `/`-based path assumption:

```ts
const relativeTo = (root: string, path: string) => {
  const r = root.replace(/\/$/, "");
  if (r && (path === r || path.startsWith(r + "/"))) {
    return path.slice(r.length).replace(/^\//, "") || baseName(path);
  }
  return path; // no/empty root, or target outside root → fall back to the absolute path
};
```

**2. Menu items** — in the `menu.target` branch of `menuItems` (`FileBrowser.tsx:282-292`), insert
the two copy items **between Download and Delete** so the copy items show for any file/folder and
Delete stays last:

```ts
{ label: "Copy Relative Path", icon: <Copy size={14} />,
  onClick: () => void copyText(relativeTo(rootPath, menu.target!.path)) },
{ label: "Copy Full Path", icon: <ClipboardCopy size={14} />,
  onClick: () => void copyText(menu.target!.path) },
```

(`Copy` and `ClipboardCopy` are lucide-react icons; add to the existing import block at
`FileBrowser.tsx:2-14`.)

**3. Coordinate-based menu open** — change `openMenu` (`FileBrowser.tsx:224`) from taking a
`React.MouseEvent` to taking coordinates, so both right-click and long-press can open the menu:

```ts
const openMenu = (x: number, y: number, dir: string, target?: MenuTarget) => {
  setActiveDir(dir);
  setMenu({ x, y, dir, target });
};
```

Update the two existing call sites to pass coords and do their own `preventDefault`/`stopPropagation`
(previously done inside `openMenu`):
- Root drop-zone `onContextMenu` (`FileBrowser.tsx:375`).
- The `TreeLevel` prop (`FileBrowser.tsx:421`) — rename `onContextMenu` → `onOpenMenu`, typed
  `(x, y, dir, target?) => void`.

(`MenuTarget` = `{ path: string; name: string; kind: "dir" | "file" }`, extracted from the existing
inline type on `MenuState`/`openMenu`/`TreeLevelProps` to name it once.)

**4. Long-press on tree rows** — in `TreeLevel` (`FileBrowser.tsx:501`), add touch handling for the
row `<button>` (`FileBrowser.tsx:521-563`). One long-press is active at a time, so a single set of
refs per `TreeLevel` instance suffices (no per-row hooks):

```ts
const LONG_PRESS_MS = 500;
const MOVE_SLOP_PX = 10;
// refs in TreeLevel:
const pressTimer = useRef<number | null>(null);
const pressStart = useRef<{ x: number; y: number } | null>(null);
const didLongPress = useRef(false);
```

Per-row handlers:
- `onTouchStart(e)`: record `pressStart` from `e.touches[0].client{X,Y}`, reset `didLongPress`,
  start a `LONG_PRESS_MS` timer. On fire → `didLongPress = true` and
  `props.onOpenMenu(x, y, isDir ? entry.path : parentOf(entry.path), target)`.
- `onTouchMove(e)`: if the finger moved past `MOVE_SLOP_PX` from `pressStart`, clear the timer
  (it's a scroll, not a long-press).
- `onTouchEnd` / `onTouchCancel`: clear the timer. If `didLongPress`, `preventDefault()` to suppress
  the synthesized mouse/click sequence.
- `onClick` (existing select/toggle): if `didLongPress`, reset it and return early (swallow the
  ghost click so the long-press doesn't also select/toggle).
- Row `className` gains `select-none` and `[-webkit-touch-callout:none]` so iOS shows our menu
  instead of the native text-selection callout.

The existing `onContextMenu` on the row becomes a thin wrapper: `preventDefault()` +
`props.onOpenMenu(e.clientX, e.clientY, dir, target)`.

Long-press is scoped to tree rows (which carry a target). New File/Folder/Upload remain reachable on
mobile via the existing toolbar buttons (`FileBrowser.tsx:323-353`), so the root background needs no
touch handler.

## Edge cases

- **`rootPath === ""`** (non-project context): `relativeTo` returns the full path — the relative and
  full items copy the same string. Acceptable; the explorer is normally project-rooted.
- **Target outside root** (shouldn't happen — tree entries are children of `rootPath`): falls back
  to the absolute path rather than emitting a broken `../…` string.
- **Trailing slash on `rootPath`:** normalized before prefix-stripping.
- **Windows paths:** the file browser already assumes POSIX `/` throughout (`baseName`, `parentOf`,
  `joinPath`); production is Linux. No new assumption introduced.
- **Long-press vs. scroll/drop:** rows are drop *targets* (`onDragOver`/`onDrop`), not drag
  *sources* (no `draggable`/`onDragStart`), so long-press starts no HTML drag. A touch drag to
  scroll the tree is caught by our `onTouchMove` slop-cancel, so it doesn't open the menu.

## Security

No new surface. Paths shown/copied are already visible in the tree; nothing new is sent over the
wire (clipboard is client-local). No daemon or auth change.

## Verification plan

No test runner in this repo — "done" = `pnpm check` clean **and** the real SPA driven (per project
convention):

1. `pnpm check` (typecheck) clean.
2. **Desktop (browser):** right-click a nested file → **Copy Relative Path** yields the
   project-relative path (e.g. `apps/daemon/src/index.ts`); **Copy Full Path** yields the absolute
   path. Repeat on a folder. Paste to confirm the exact strings.
3. **Mobile (emulated touch / real device):** long-press a row → menu opens at the touch point;
   both copies land the right string; a quick tap still selects the file / toggles the folder;
   dragging to scroll the tree does **not** open the menu and does **not** get swallowed.
4. **Fallback:** load the SPA over a non-secure origin (plain `http://` to the daemon, clipboard API
   absent) → copy still works via the `execCommand` path.

## Alternatives considered

- **Kebab (⋯) button per row** to open the menu on mobile — rejected in brainstorming: adds
  persistent UI to every row in a dense tree; long-press is the native file-manager idiom.
- **Rely on the browser's long-press → `contextmenu`** with no code — rejected: unreliable on iOS
  Safari (triggers text selection / callout instead).
- **Relative to the workspace/`fsRoot`** instead of the project root — rejected: the project root is
  the tree's visible root and the cwd agents run in, so it's the useful base.
- **Reuse `TerminalView`'s `writeClipboard`** by importing it — rejected: it's a private helper with
  no fallback; a shared `lib/clipboard.ts` is the cleaner home and adds the non-secure-context path.

## Risks / open items

- **`execCommand("copy")` deprecation:** long-term deprecated but still universally supported; only
  used as a fallback. Acceptable until browsers actually remove it.
- **iOS long-press tuning:** 500 ms / 10 px are conventional defaults; may need a small tweak after
  real-device testing (the terminal already uses a 6 px scroll slop for touch — `TerminalView.tsx:24`).
