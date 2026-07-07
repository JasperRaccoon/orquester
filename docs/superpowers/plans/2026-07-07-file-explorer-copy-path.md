# File Explorer — Copy Relative / Full Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Copy Relative Path** and **Copy Full Path** items to the file-tree row context menu, and make that menu (hence the new items plus existing Download/Delete) reachable on touch devices via long-press.

**Architecture:** Client-only change in `packages/ui`. A new shared `copyText()` helper writes to the clipboard with a non-secure-context fallback. Two menu items are added to the existing data-driven `menuItems` array in `FileBrowser.tsx`, computing a project-root-relative path with a small pure helper. The context menu, currently opened only by `onContextMenu` (right-click), is refactored to open from coordinates so a new long-press touch handler on tree rows can reuse it.

**Tech Stack:** React 18 + TypeScript (strict, ESM), Tailwind, lucide-react icons. No daemon/API/wire-contract changes.

## Global Constraints

- **Client-only:** all edits live in `packages/ui`. No daemon, `@orquester/api`, or wire-contract changes.
- **No test runner in this repo.** The pre-commit gate is `pnpm check` (`tsc --noEmit`, typecheck only). "Done" = `pnpm check` clean **and** the app driven/built. Pure functions get a throwaway `node` assertion script under the scratchpad; there is no test framework to add and none should be introduced.
- **Menu labels, verbatim:** `Copy Relative Path` and `Copy Full Path` (Title Case, matching `New File` / `Download as Zip`).
- **Menu order:** Download → Copy Relative Path → Copy Full Path → Delete (Delete stays last as the destructive action).
- **"Relative" base:** the explorer's project root `rootPath`. Fall back to the full absolute path when `rootPath` is empty or the target sits outside it.
- **POSIX paths:** reuse the file's existing `/`-based helpers (`baseName`, `parentOf`); introduce no new path assumption. Production is Linux.
- **Long-press constants:** `LONG_PRESS_MS = 500`, `MOVE_SLOP_PX = 10`.
- **Icons:** lucide-react `Copy` (relative) and `ClipboardCopy` (full).
- **Do NOT modify** `packages/ui/src/components/terminal/TerminalView.tsx` — its local `writeClipboard` (`TerminalView.tsx:52`) is out of scope.
- **Git (AGENTS.md):** commit to the **current** branch as-is; never create a new branch; commit **only when the user asks**. The commit step in each task marks the intended boundary — batch or defer per that policy.
- **Never start/restart the daemon in this checkout (AGENTS.md).** Verify with `pnpm check` / `pnpm build`; interactive right-click / long-press behavior is confirmed by the user or via browser device-emulation (state this explicitly rather than claiming it was driven here).

## File Structure

- **Create** `packages/ui/src/lib/clipboard.ts` — one responsibility: write a string to the clipboard across secure and non-secure contexts. Consumed by `FileBrowser.tsx` (and available to future callers).
- **Modify** `packages/ui/src/components/files/FileBrowser.tsx` — the file tree + its context menu. Gains the `relativeTo` helper, two menu items, a `MenuTarget` type alias, the coordinate-based `openMenu`, and long-press touch handling on tree rows.

---

### Task 1: Shared clipboard helper

**Files:**
- Create: `packages/ui/src/lib/clipboard.ts`
- Verify (scratch): `<scratchpad>/clipboard-shape.mjs` (throwaway)

**Interfaces:**
- Consumes: nothing.
- Produces: `export async function copyText(text: string): Promise<void>` — writes `text` to the clipboard; resolves whether or not it succeeded (failures are swallowed). Consumed by Task 2.

- [ ] **Step 1: Create the helper**

Create `packages/ui/src/lib/clipboard.ts`:

```ts
/**
 * Write text to the clipboard, working in non-secure contexts too.
 *
 * `navigator.clipboard` only exists on secure origins (HTTPS / localhost) and in
 * Electron — the production Caddy deploy qualifies. When the daemon is reached over
 * plain `http://` (a LAN IP), that API is absent, so fall back to the legacy
 * hidden-<textarea> + execCommand path. Both run from a user gesture (a menu-item
 * tap), which iOS Safari / Android Chrome require.
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* permission denied / blocked — fall through to the legacy path */
  }
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

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: clean (no errors). Confirms the new module typechecks under `strict`.

- [ ] **Step 3: Sanity-check the branch shape (throwaway)**

Because there is no DOM here, verify only that the async API is preferred when present and the fallback runs when it is absent. Write `<scratchpad>/clipboard-shape.mjs`:

```js
async function copyText(text, env) {
  const log = [];
  try {
    if (env.clipboard?.writeText) { await env.clipboard.writeText(text); log.push("async"); return log; }
  } catch { /* fall through */ }
  env.execCommand("copy"); log.push("fallback");
  return log;
}
const secure = await copyText("x", { clipboard: { writeText: async () => {} }, execCommand: () => { throw new Error("should not run"); } });
const insecure = await copyText("x", { clipboard: undefined, execCommand: () => {} });
const denied = await copyText("x", { clipboard: { writeText: async () => { throw new Error("denied"); } }, execCommand: () => {} });
console.assert(JSON.stringify(secure) === '["async"]', "secure→async", secure);
console.assert(JSON.stringify(insecure) === '["fallback"]', "insecure→fallback", insecure);
console.assert(JSON.stringify(denied) === '["fallback"]', "denied→fallback", denied);
console.log("clipboard branch shape OK");
```

Run: `node <scratchpad>/clipboard-shape.mjs`
Expected: `clipboard branch shape OK` and no `Assertion failed` lines.

- [ ] **Step 4: Commit** (per the git policy in Global Constraints)

```bash
git add packages/ui/src/lib/clipboard.ts
git commit -m "feat(ui): add copyText clipboard helper with non-secure-context fallback"
```

---

### Task 2: Desktop copy-path menu items

Adds the two context-menu items and the relative-path helper. After this task, right-click → **Copy Relative Path** / **Copy Full Path** works on desktop. The context menu still opens only via right-click (touch support is Task 3).

**Files:**
- Modify: `packages/ui/src/components/files/FileBrowser.tsx` (imports `FileBrowser.tsx:2-14`; helpers `:35-37`; `menuItems` target branch `:282-292`)
- Verify (scratch): `<scratchpad>/relative-to.mjs` (throwaway)

**Interfaces:**
- Consumes: `copyText` from Task 1.
- Produces: `const relativeTo = (root: string, path: string) => string` (module-scope in `FileBrowser.tsx`) — the project-relative path, or the absolute `path` when `root` is empty or `path` is outside it.

- [ ] **Step 1: Add the icon imports**

In the lucide-react import block (`FileBrowser.tsx:2-14`), add `ClipboardCopy` and `Copy` (keeping the roughly-alphabetical order):

```tsx
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
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

- [ ] **Step 2: Import `copyText`**

Add next to the other `../../lib/*` imports (e.g. after the `downloadPath` import at `FileBrowser.tsx:31`):

```tsx
import { copyText } from "../../lib/clipboard";
```

- [ ] **Step 3: Add the `relativeTo` helper**

Immediately after `baseName` (`FileBrowser.tsx:37`):

```tsx
// Path of `path` relative to the explorer's project root `root` (e.g. "apps/daemon/src/index.ts").
// Falls back to the absolute path when there is no root or `path` sits outside it. The trailing
// "/" boundary check stops "/a/proj" from being treated as a child of root "/a/pro".
const relativeTo = (root: string, path: string) => {
  const r = root.replace(/\/$/, "");
  if (r && (path === r || path.startsWith(r + "/"))) {
    return path.slice(r.length).replace(/^\//, "") || baseName(path);
  }
  return path;
};
```

- [ ] **Step 4: Insert the two menu items between Download and Delete**

Replace the `menu.target` branch of `menuItems` (`FileBrowser.tsx:282-292`) with:

```tsx
        ...(menu.target
          ? [
              {
                label: menu.target.kind === "dir" ? "Download as Zip" : "Download",
                icon: menu.target.kind === "dir" ? <FolderDown size={14} /> : <Download size={14} />,
                disabled: menu.target.kind === "dir" && !folderZip,
                onClick: () => void downloadPath(api, menu.target!)
              },
              {
                label: "Copy Relative Path",
                icon: <Copy size={14} />,
                onClick: () => void copyText(relativeTo(rootPath, menu.target!.path))
              },
              {
                label: "Copy Full Path",
                icon: <ClipboardCopy size={14} />,
                onClick: () => void copyText(menu.target!.path)
              },
              { label: "Delete", icon: <Trash2 size={14} />, onClick: () => setDeleting(menu.target!) }
            ]
          : [])
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: clean. Confirms the new items, imports, and `relativeTo` typecheck.

- [ ] **Step 6: Verify `relativeTo` logic (throwaway)**

Write `<scratchpad>/relative-to.mjs`:

```js
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const relativeTo = (root, path) => {
  const r = root.replace(/\/$/, "");
  if (r && (path === r || path.startsWith(r + "/"))) {
    return path.slice(r.length).replace(/^\//, "") || baseName(path);
  }
  return path;
};
const cases = [
  ["/root/proj", "/root/proj/a/b.ts", "a/b.ts"],
  ["/root/proj/", "/root/proj/a/b.ts", "a/b.ts"],   // trailing slash on root
  ["/root/proj", "/root/proj", "proj"],             // target === root → its basename
  ["", "/root/proj/a", "/root/proj/a"],             // empty root → absolute
  ["/root/proj", "/other/x", "/other/x"],           // outside root → absolute
  ["/root/proj", "/root/project/a", "/root/project/a"] // prefix-but-not-child → absolute
];
for (const [root, path, want] of cases) {
  const got = relativeTo(root, path);
  console.assert(got === want, `relativeTo(${JSON.stringify(root)}, ${JSON.stringify(path)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
console.log("relativeTo OK");
```

Run: `node <scratchpad>/relative-to.mjs`
Expected: `relativeTo OK` and no `Assertion failed` lines.

- [ ] **Step 7: Commit** (per the git policy in Global Constraints)

```bash
git add packages/ui/src/components/files/FileBrowser.tsx
git commit -m "feat(ui): add Copy Relative/Full Path to file explorer context menu"
```

---

### Task 3: Long-press to open the menu on touch

Refactors `openMenu` to take coordinates (so it can be opened from any gesture), then adds long-press touch handling to tree rows. After this task the whole context menu — the two copy items plus Download/Delete — is reachable on mobile.

**Files:**
- Modify: `packages/ui/src/components/files/FileBrowser.tsx` (`MenuState` `:39-44`; `openMenu` `:224-233`; root drop-zone `onContextMenu` `:375`; `TreeLevelProps.onContextMenu` `:492-496`; `TreeLevel` body `:501-510`; `TreeLevel` prop pass `:421`; row `<button>` `:521-563`; module constants near `:35`)

**Interfaces:**
- Consumes: `copyText` / `relativeTo` from Task 2 (unchanged).
- Produces:
  - `type MenuTarget = { path: string; name: string; kind: "dir" | "file" }` (module scope) — reused by `MenuState`, `openMenu`, and `TreeLevelProps`.
  - `const openMenu = (x: number, y: number, dir: string, target?: MenuTarget) => void`.
  - `TreeLevelProps.onOpenMenu: (x: number, y: number, dir: string, target?: MenuTarget) => void` (renamed from `onContextMenu`).

- [ ] **Step 1: Add long-press constants**

Near the other module-scope constants (after `baseName`/`relativeTo`, around `FileBrowser.tsx:37`):

```tsx
const LONG_PRESS_MS = 500;
const MOVE_SLOP_PX = 10;
```

- [ ] **Step 2: Name the menu-target type and use it in `MenuState`**

Replace `MenuState` (`FileBrowser.tsx:39-44`) with:

```tsx
type MenuTarget = { path: string; name: string; kind: "dir" | "file" };

interface MenuState {
  x: number;
  y: number;
  dir: string;
  target?: MenuTarget;
}
```

- [ ] **Step 3: Refactor `openMenu` to coordinates**

Replace `openMenu` (`FileBrowser.tsx:224-233`) with:

```tsx
  const openMenu = (x: number, y: number, dir: string, target?: MenuTarget) => {
    setActiveDir(dir);
    setMenu({ x, y, dir, target });
  };
```

- [ ] **Step 4: Update the root drop-zone right-click handler**

Replace `onContextMenu={(e) => openMenu(e, rootPath)}` (`FileBrowser.tsx:375`) with:

```tsx
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, rootPath);
          }}
```

- [ ] **Step 5: Rename the `TreeLevel` prop at the pass site**

Change `onContextMenu={openMenu}` (`FileBrowser.tsx:421`) to:

```tsx
            onOpenMenu={openMenu}
```

- [ ] **Step 6: Update `TreeLevelProps`**

Replace the `onContextMenu` member (`FileBrowser.tsx:492-496`) with:

```tsx
  onOpenMenu: (x: number, y: number, dir: string, target?: MenuTarget) => void;
```

- [ ] **Step 7: Add long-press refs + a clear helper in `TreeLevel`**

At the top of the `TreeLevel` component body — after `const entries = props.childrenByPath[props.dir];` (`FileBrowser.tsx:502`) — add:

```tsx
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
```

(`useRef` is already imported at `FileBrowser.tsx:1`.)

- [ ] **Step 8: Wire the row handlers (right-click + long-press + ghost-click guard)**

In the row `<button>` (`FileBrowser.tsx:521-563`), replace the `onClick` and `onContextMenu` props and add the four touch handlers. The `onClick` gains a guard so a long-press doesn't also select/toggle; `onContextMenu` now calls `props.onOpenMenu`:

```tsx
              onClick={() => {
                if (didLongPress.current) {
                  didLongPress.current = false;
                  return;
                }
                if (isDir) props.onToggleDir(entry.path);
                else props.onSelectFile(entry.path, entry.size);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onOpenMenu(e.clientX, e.clientY, isDir ? entry.path : parentOf(entry.path), {
                  path: entry.path,
                  name: entry.name,
                  kind: entry.kind
                });
              }}
              onTouchStart={(e) => {
                const { clientX, clientY } = e.touches[0];
                pressStart.current = { x: clientX, y: clientY };
                didLongPress.current = false;
                clearPress();
                pressTimer.current = window.setTimeout(() => {
                  didLongPress.current = true;
                  props.onOpenMenu(clientX, clientY, isDir ? entry.path : parentOf(entry.path), {
                    path: entry.path,
                    name: entry.name,
                    kind: entry.kind
                  });
                }, LONG_PRESS_MS);
              }}
              onTouchMove={(e) => {
                const s = pressStart.current;
                if (!s) return;
                const t = e.touches[0];
                if (Math.abs(t.clientX - s.x) > MOVE_SLOP_PX || Math.abs(t.clientY - s.y) > MOVE_SLOP_PX) {
                  clearPress();
                }
              }}
              onTouchEnd={(e) => {
                clearPress();
                if (didLongPress.current) e.preventDefault();
              }}
              onTouchCancel={clearPress}
```

- [ ] **Step 9: Suppress the native touch callout on rows**

In the row `<button>` `className` (`FileBrowser.tsx:544-548`), add `select-none` and `[-webkit-touch-callout:none]` to the base string so iOS shows our menu instead of the text-selection callout:

```tsx
              className={cn(
                "flex w-full select-none items-center gap-1.5 py-1 pr-2 text-left text-sm [-webkit-touch-callout:none]",
                isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900",
                isDir && props.dropTarget === entry.path && "bg-neutral-800 ring-1 ring-inset ring-neutral-600"
              )}
```

- [ ] **Step 10: Typecheck**

Run: `pnpm check`
Expected: clean. Confirms the `MenuTarget` alias, the `onOpenMenu` rename across pass-site + props type + row usage, and the touch handlers all typecheck.

- [ ] **Step 11: Confirm the SPA bundles**

Run: `pnpm build`
Expected: `apps/web/dist` rebuilds with no error (the daemon serves this bundle; a build failure here would ship a stale/broken SPA). Do **not** start the daemon.

- [ ] **Step 12: Behavioral verification (user / emulation — state honestly)**

This environment cannot drive the live daemon's UI (AGENTS.md forbids starting a daemon here), so confirm interactively — by the user, or via browser devtools device-emulation against a separate dev instance:

1. **Desktop:** right-click a nested file → **Copy Relative Path** pastes as e.g. `apps/daemon/src/index.ts`; **Copy Full Path** pastes as the absolute path. Repeat on a folder.
2. **Touch (emulated or real device):** long-press a row (~0.5 s) → the menu opens at the touch point; both copies land the right string; a quick tap still selects a file / toggles a folder; dragging to scroll the tree does **not** open the menu and does **not** get swallowed.
3. **Non-secure origin:** load the SPA over plain `http://` → copy still works (the `execCommand` fallback).

Report results honestly; do not claim the interactive steps passed unless they were actually run.

- [ ] **Step 13: Commit** (per the git policy in Global Constraints)

```bash
git add packages/ui/src/components/files/FileBrowser.tsx
git commit -m "feat(ui): long-press to open file explorer context menu on touch"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Two menu items (Copy Relative/Full Path), files + folders, order Download→copy→Delete → Task 2 Step 4.
- Relative base = project root with fallback → Task 2 Step 3 (`relativeTo`) + Step 6 (verified).
- Shared `copyText` with non-secure fallback; `TerminalView` untouched → Task 1 (Global Constraints forbids touching `TerminalView`).
- Long-press trigger (500 ms / 10 px slop), ghost-click guard, scroll slop-cancel, callout suppression → Task 3 Steps 1, 7–9.
- Coordinate-based `openMenu`, `onOpenMenu` prop rename, all three call sites updated → Task 3 Steps 3–6, 8.
- Edge cases (empty root, outside root, trailing slash, prefix-not-child) → Task 2 Step 6 assertions.
- Verification = `pnpm check` + `pnpm build` + honest interactive note → Task 3 Steps 10–12.

**Placeholder scan:** none — every code step shows complete code; no TBD/TODO/"handle edge cases".

**Type consistency:** `MenuTarget` defined in Task 3 Step 2 and used identically in `openMenu` (Step 3), `TreeLevelProps.onOpenMenu` (Step 6), and the row calls (Step 8). `onOpenMenu` name matches at the pass site (Step 5), the props type (Step 6), and the row handlers (Step 8). `copyText`/`relativeTo` signatures match between definition (Tasks 1–2) and use (Task 2 Step 4). `LONG_PRESS_MS`/`MOVE_SLOP_PX` defined (Step 1) and used (Step 8).

Note: Task 2 delivers desktop copy without touching `openMenu`; Task 3's `openMenu` refactor does not change any Task 2 code (the menu-item array is coordinate-agnostic), so the two tasks don't conflict despite sharing the file.
