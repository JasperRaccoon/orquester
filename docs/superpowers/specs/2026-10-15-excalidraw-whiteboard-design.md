# Excalidraw whiteboard plugin — design

Date: 2026-10-15. Builds on `2026-10-14-plugins-ts-rust-design.md`.

## 1. Goal

A built-in plugin, **Excalidraw Whiteboard**, that adds a whiteboard to the
"+" menu's Tools section of every project. The whiteboard is
[Excalidraw](https://github.com/excalidraw/excalidraw) and follows Orquester's
light/dark mode.

Decisions taken with the owner:

- **Global**, not per workspace: one switch in Settings → Plugins for the whole server.
- **Bundled, pinned** to the current stable `@excalidraw/excalidraw` (0.18.1). It
  is not downloaded or updated at runtime. Upgrading means bumping the dependency.
- **Files in the project:** new whiteboards go in `<project>/whiteboards/`, and any
  `.excalidraw` file opens from the file browser.
- **Not in scope:** real-time collaboration, Excalidraw's AI features, and
  excalidraw.com's share links.

## 2. Plugin model

`PluginInfo` gains three fields:

- `scope: "workspace" | "global"` says where the plugin is turned on.
- `updates: boolean` says whether the daemon downloads the plugin and keeps it up to date.
- `enabled: boolean` is the global switch. For a workspace plugin it means "on
  in any existing workspace".

A global plugin's record in `plugins.json` stores only `enabled` (absent means
off). Records written by older versions are kept as they are.

Routes:

| Route | Plugin | Effect |
|---|---|---|
| `PUT /api/plugins/:id` `{ enabled }` | global | Switches it on or off. |
| `PUT /api/plugins/:id/workspaces/:workspace` | workspace | Unchanged. |

Refusals:

- Using the wrong toggle route for a plugin's scope answers 409 `PLUGIN_SCOPE`.
- The version routes (check, rollback, downloads) answer 409 `PLUGIN_BUNDLED` for a
  plugin with `updates: false`.

Clients load the plugin list on every connect, not only from Settings, so that
other parts of the UI can depend on whether a plugin is on. A daemon from before
this change sends neither `scope` nor `updates`; the client reads such a plugin
as a per-workspace plugin with updates.

## 3. Whiteboard

**Tab.** A client-local tab, `whiteboard`, with one tab per file per project. Like
the to-do and Git tabs, open tabs are not restored after a reload; the drawings
themselves are files.

**"+" menu.** While the plugin is on, the menu shows:

- **New whiteboard.** It uploads an empty scene to
  `whiteboards/Untitled.excalidraw`. If that name is taken, the daemon numbers it.
- Every `.excalidraw` file in `whiteboards/`, listed when the menu opens.

**File browser.** A `.excalidraw` file offers **Open in Whiteboard**, both in the
preview and in the context menu. The preview can still edit the file as text.

**Saving.**

- Edits are saved 1 s after they stop, when the tab is hidden, and when it closes.
- Saves overwrite the file through the upload route (a temp file renamed over
  the target), so drawings with embedded images are not limited by the 1 MB
  JSON body limit.
- Opening a drawing never writes it. Only a change to the elements, the
  background or the grid marks the board as unsaved.
- When the tab is shown again with nothing unsaved, a file changed meanwhile
  (by an agent, git, or another client) is reloaded.
- An empty file opens as an empty board. A file that is not a scene is refused
  instead of being overwritten.

**Theme.**

- Excalidraw's `theme` prop follows `resolvedMode`, and its own theme toggle is hidden.
- Its panels use the scheme's surfaces through CSS variables on `.orq-whiteboard`.
- The theme is not saved in the file.

**Loading.** The editor is a lazy chunk, so the app's main bundle does not grow.

**Fonts.**

- A shared Vite plugin, `packages/ui/vite/excalidraw-assets.ts`, copies
  Excalidraw's fonts to `<build>/excalidraw/fonts/` and serves them in dev.
- `window.EXCALIDRAW_ASSET_PATH` points at them with an absolute URL, which works
  in the desktop app's `file://` window too.
- Nothing is fetched from Excalidraw's CDN, which the CSP blocks and an offline
  host can't reach anyway.
