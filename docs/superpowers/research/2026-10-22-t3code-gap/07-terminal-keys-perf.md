# 07 — Terminal, keyboard/focus, and performance engineering: T3 Code vs Orquester

Analyst domain: terminal runtime (PTY, retention, rendering, links, resize, Windows), keybindings and
customization, keyboard focus, command palette, scroll, and performance engineering (measurement,
guards, virtualization, render batching, state management, bundle splitting, telemetry).

- T3 Code: `t3code_codebase` at `ed9b7ca9` (pulled from `e8d87689`; 652 new commits). Paths below
  are relative to `t3code_codebase/`.
- Orquester: repo root at `dcab9eed`. Paths below are relative to the repo root.
- "(new)" marks something that arrived in `e8d87689..ed9b7ca9`. Unmarked T3 items existed before
  this pull.

All claims were checked against source. Line numbers are from the checked-out trees.

---

## 0. Context: how the two terminal stacks differ

| Layer | T3 Code | Orquester |
|---|---|---|
| PTY owner | Environment server `apps/server/src/terminal/Manager.ts` (node-pty via `NodePtyAdapter.ts`). PTYs die with the server; history is persisted to files and restored. | Daemon `apps/daemon/src/sessions.ts`. tmux-backed `SessionManager` (the PTYs survive daemon restarts) or direct node-pty `LocalSessionManager` where tmux is missing (Windows, stock macOS). |
| Retained history | Server-side `BoundedTerminalHistory`, 5,000 lines / 8 MiB, chunked, UTF-16-safe eviction (`Manager.ts:95-97`, `:836-960`). | tmux pane history read with `capture-pane -p -e -J -S -` on every subscribe (`tmux.ts:28-40`, `:315-352`). tmux `history-limit` is never set, so tmux's default of 2,000 lines applies (no `history-limit` anywhere in the repo). There is also a 256 KiB in-memory hot ring (`sessions.ts:29`). |
| Transport | Effect RPC streams with an ack window of 8 chunks / 64 KiB and an 8 MiB per-subscriber queue that resyncs on overflow (`OutputProtocol.ts:9-13`, `:74-186`). | One multiplexed JSON WebSocket `/ws` for all terminals (`apps/daemon/src/index.ts:4828-4963`; client `packages/ui/src/lib/transporters/ws-session-channel.ts`). |
| Renderer | Their own: `libghostty-vt` compiled to WASM, a Canvas 2D renderer, and a surface that handles input, IME, selection, links and blink (`apps/web/src/terminal/ghostty/*`; README there). React stays out of the frame loop. | xterm.js 6 with the DOM renderer and `addon-fit` only (`packages/ui/src/components/terminal/TerminalView.tsx:130-158`, `:218-221`). |

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (with evidence) | User value | Port effort |
|---|---|---|---|---|
| **Bounded per-subscriber terminal output queue with overflow resync.** A slow client cannot grow server memory; on overflow the queue is dropped and the client gets a fresh snapshot. (new: #18429 extended it into the attach path) | `apps/server/src/terminal/OutputProtocol.ts:74-186` (`MAX_QUEUED_OUTPUT` 8 MiB, `EVENT_OVERHEAD`, `takeBatch` ≤64 KiB, `resync`); `:9-13` ack window; commit `3284143b` | **Missing.** `send()` in `/ws` calls `socket.send(JSON.stringify(msg))` with no `bufferedAmount` check (`apps/daemon/src/index.ts:4863-4869`, live subscriber at `:4924-4931`). By contrast, `/ws-browser` drops frames above a high-water mark (`index.ts:4980-4989`) and the chat proxy pipes with backpressure (`apps/daemon/src/agent-chat/proxy-routes.ts:910-911`). A phone on bad mobile data watching a noisy build queues output in daemon memory without limit. | H | S |
| **O(chunk) history append.** Output is appended as chunks, and the full scrollback is only materialized at snapshot and persistence time. The doc names re-copying on every callback as the anti-pattern. | `docs/internals/terminal-runtime.md` ("Output and retention"); `Manager.ts:836-960` (`appendChunk`, `trim`, surrogate-safe split) | **Anti-pattern present.** Every PTY chunk runs `session.buffer = (session.buffer + data).slice(-MAX_BUFFER)` (`sessions.ts:522`, `:1139`). Slicing the cons string flattens it, so a busy terminal copies up to 256 KiB per chunk, for the life of the session, even though the tmux backend uses this ring only before the first client connects. The slice can also cut a surrogate pair or an escape sequence in half. | M | S |
| **Strip terminal query/response traffic from replayed history, and detach the PTY writer during replay.** Without this, replaying DA/DSR queries makes the renderer answer them into the live shell as junk at the prompt. | `docs/internals/terminal-runtime.md` (last paragraph); `Manager.ts:1138-1145` `sanitizeTerminalHistoryChunk`; `apps/web/src/terminal/ghostty/core.ts:374-380` `detachPtyWriter` | **Missing on the local backend.** `LocalSessionManager.scrollback()` returns the raw ring (`sessions.ts:1194-1197`), and `TerminalView` forwards every `term.onData` to the PTY, including xterm's automatic replies (`TerminalView.tsx:555-574`). The tmux path is safe because `capture-pane` renders cells, not the original byte stream. | M (Windows/macOS-without-tmux users) | S |
| **Reset terminal modes a dead program left behind** (mouse tracking, bracketed paste, kitty keyboard, alt screen) before showing inherited history. (new) | `Manager.ts` `INHERITED_INPUT_RESET` and `neutralizeInheritedHistory` (commit `1125b409`) | **Missing.** On exit the client only writes `[session ended]` (`TerminalView.tsx:638`). An agent TUI that crashes leaves xterm in mouse-reporting or alt-screen mode. | L | S |
| **Terminal links: URLs and file paths, including `file:line:col`, quoted paths with spaces, Unicode paths, and wrapped lines.** Clicking a path opens it in the app. (new: Unicode fix #20264) | `apps/web/src/terminal-links.ts:29-40` (patterns), `apps/web/src/terminal/ghostty/surface.ts:243-290` (wrapped-line hit test), `:473-506` (drag threshold, `onLinkActivate`) | **Missing.** No `@xterm/addon-web-links`, no `registerLinkProvider`, no `linkHandler` (grep over `packages/ui/src`). Plain-text URLs are not clickable, and only OSC 8 hyperlinks get xterm's built-in default handling. Orquester already has the target action: `revealInFileBrowser(path)` (`packages/ui/src/store/app.ts:1199`, `:2926`). | H | S |
| **Terminal scrollback navigation and select-all.** Shift+PgUp/PgDn, Ctrl/Cmd+Shift+Home/End, a context menu with "Select all" and "Jump to latest", and Cmd+A / Ctrl+Shift+A. | `docs/user/terminal.md`; `surface.ts:956` `selectAll`, `:1017` `scrollToBottom`, `:1070-1102` key handling | **Partial.** xterm's built-in Shift+PgUp/PgDn works. There is no select-all, no jump-to-start or jump-to-latest, and no context menu: right-click only copies an existing selection (`TerminalView.tsx:321-336`). | M | S |
| **Configurable keybindings.** File-backed `keybindings.json` on the host, hot-reloaded, with `when` expressions (`terminalFocus`, `composerFocus`, `turnRunning`, `editableFocus`, `isDesktop`, ...), last-match-wins precedence, and new defaults merged in without overwriting user edits. | `docs/user/keybindings.md`; `packages/shared/src/keybindings.ts:147` (`DEFAULT_KEYBINDINGS`, about 66 rules); `apps/server/src/keybindings.ts:98-150`, `:241-261` (upsert, watcher); `packages/contracts/src/keybindings.ts` (`MAX_WHEN_EXPRESSION_DEPTH`) | **Missing.** All chords are hard-coded. `resolveChatShortcut` (`packages/ui/src/lib/agent-chat/keybindings.logic.ts:69-103`: Esc, mod+/, mod+E, mod+Shift+M, mod+Shift+Enter, mod+J) and `GlobalShortcutListener.tsx` (Ctrl/Cmd+K, Ctrl+Shift+A) are the whole set. The keybindings logic file credits T3 for the command names, but nothing can be rebound. | M | M |
| **Keybindings settings page:** search, a key recorder, editing `when` with validation, conflict warnings, and reset to default. | `apps/web/src/components/settings/KeybindingsSettings.tsx:112-140` (search), `:261-268` (conflicts), `:682-723` (recording, draft validation) | **Missing.** No shortcuts section in Settings. Only per-control tooltips via `chatShortcutLabel` (`keybindings.logic.ts:106-128`). | M | M |
| **App-level navigation chords:** thread jumps `mod+1..9` with modifier-hold hint badges, `thread.next/previous`, `navigation.back/forward` (`mod+[`/`mod+]`), `view.reopenClosed` (`mod+shift+t`), `sidebar.toggle`, `terminal.toggle/split/new/close`, `diff.toggle`, `chat.find` (`mod+f`), `filePicker.toggle` (`mod+p`), `projectSearch.toggle`. (new: #22607 lets `thread.undo` work inside the composer right after an action) | `packages/shared/src/keybindings.ts:147-240`; `apps/web/src/keybindings.ts:259-300` (`threadJumpCommandForIndex`, `shouldShowThreadJumpHintsForModifiers`) | **Missing**, apart from the palette and the attention cycle. No digit-jump handling (grep for `Digit`/`[1-9]` in `packages/ui/src` finds nothing), no back/forward, no reopen-closed-tab, and no in-thread find. Ctrl+F falls back to the browser's find over the retained DOM rows. | M | S–M per command once a registry exists |
| **Command palette actions mode.** `>` filters to actions; every item shows its live keybinding; it is virtualized; it uses `useDeferredValue` for typing; VCS/PR badge queries are leased only to visible rows plus overscan. (new: #22679/#22687/#22699/#22707 split the palette into item files; #19055 makes new-thread shortcuts work while it is open) | `apps/web/src/components/CommandPalette.tsx:487-488` (deferred query, `>`), `:885-1540` (actions with `shortcutCommand`); `CommandPaletteResults.tsx:116` (`LegendList`), `:196-240` (shortcut labels); `docs/internals/performance-regressions.md` ("Command palette results keep live VCS ... leased to the visible viewport") | **Partial.** Orquester's palette has two modes, `go` (sessions and projects) and `search` (conversation full-text with `?` prefix) (`packages/ui/src/components/command-palette/CommandPalette.tsx:163`, `:612`; `conversation-search.ts:20-23`). There are no actions/commands, no shortcut hints, and no virtualization. | M | M |
| **Terminal split panes and multiple terminals per thread** in a drawer next to the chat (`terminal.split`, `terminal.splitVertical`, `MAX_TERMINALS_PER_GROUP`). | `apps/web/src/components/ThreadTerminalDrawer.tsx:67-76`, `:1161-1224` (`TerminalSplitPanes`); `PersistentThreadTerminals.tsx` | **Partial / different model.** Terminals are project tabs. A per-project `ViewMode` of `"tabs" \| "grid"` shows all tabs tiled (`packages/ui/src/lib/view-mode.ts:1-2`). There is no split inside a tab and no terminal drawer attached to a chat. | M | M–L |
| **Performance-regression test command with payload budgets** that pins wire invariants: cold-open 75 rows / ~1 MiB, bounded catch-up of 128 events / 1 MiB, omitting command output bodies on the wire. | `package.json:36` `test:perf:v2-wire` (16 test files); `docs/internals/performance-regressions.md`; `apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts`, `packages/client-runtime/src/operations/commands.performance.test.ts` | **Missing as a guard.** The fold work was measured by hand (`docs/superpowers/specs/2026-09-23-fold-performance-design.md`, "As built" table) and protected by cache-consistency and determinism tests (`packages/api/src/agent-chat/fold.retention.test.ts`), not by a budget test. The only budget test is about an OpenCode probe timeout (`apps/daemon/src/agent-host/adapters/opencode/snapshot-budget.test.ts`). No root `perf` script. | M | S |
| **React Compiler on, with a coverage test that fails on any compiler bailout.** | `apps/web/vite.config.ts:215` `react({ compiler: true })`; `apps/web/src/reactCompilerCoverage.test.ts` (compiles every non-test source file with `reportDiagnostics` and expects zero bailouts); mobile twin `apps/mobile/src/reactCompilerCoverage.test.ts` (new: #22913 wired the mobile feed into it) | **Missing.** `apps/web/vite.config.ts` and `apps/desktop/vite.config.ts:19` use plain `react()` on React 18.3. `rows.logic.ts:19-21` records this choice: "React 18 with no compiler means identity preservation is the whole performance story." | M | M |
| **Route-level code splitting.** | `apps/web/vite.config.ts:214` `tanstackRouter({ autoCodeSplitting: true })` | **Mostly missing.** Only Excalidraw (`WhiteboardView.tsx:12`), Mermaid (`mermaid-engine.ts:8`) and noVNC (`DesktopView.tsx:46`) are dynamically imported. pdfjs (`files/viewers/PdfViewer.tsx:2`), xyflow (`workflows/canvas/WorkflowCanvas.tsx:33`), CodeMirror (`files/Editor.tsx:2`) and xterm (`TerminalView.tsx:2`) are static imports, and there is no `manualChunks`. Everything lands in the first-load bundle of the PWA. | M (PWA cold start on phones) | S |
| **Cross-platform process telemetry with history.** A separate Rust `sysinfo` monitor samples only while a diagnostics view is subscribed; history is bounded by age, count, rows and bytes; grouped OTLP metrics export once a minute. (new: `ProcessGroupMetrics` OTLP export) | `docs/internals/resource-telemetry.md`; `native/resource-monitor/src/main.rs`; `apps/server/src/resourceTelemetry/*` (`ResourceTelemetryHistory.ts`, `ProcessGroupMetrics.ts`, `ResourceAttribution.ts`); UI `apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx:62`, `:359-410` (history windows and chart) | **Partial.** Orquester has a solid Linux `/proc` Task Manager: CPU, memory, disk and network; the managed process tree including tmux panes; ports; kill (`apps/daemon/src/system-status.ts:1-80`; `packages/ui/src/components/system/TaskManager.tsx`, `sparkline.tsx`). It is on-demand with 2–2.5 s caches. Missing: non-Linux support (`SYSTEM_STATUS_SUPPORTED = process.platform === "linux"`, `system-status.ts:46`), server-side history, per-component logical I/O attribution, and OTLP export. | L–M | M |
| **Slow-request detection in the client.** A toast appears when an RPC is unacknowledged for 15 s, with a 120 s threshold for known long operations and an exemption for background reports. Heartbeat diagnosis avoids blaming DNS for a frozen host. (new: #22212, #22159) | `apps/web/src/rpc/requestLatencyState.ts:1-40`; `apps/web/src/components/SlowRpcRequestToastCoordinator.tsx` | **Missing.** No `slow request` or latency tracking in `packages/ui/src/lib/http-client.ts` or the transporters (grep). | L–M | S |
| **Idle-aware subprocess polling for terminals.** A quiet terminal skips 29 of every 30 ticks, with exponential backoff to 60 s on failure. (new: #21242) | `Manager.ts:99-102`, `:2529-2536` | **Not applicable / no gap.** Orquester derives terminal activity from the output stream (`apps/daemon/src/ansi-activity.ts:244-256`) and never polls the process table for terminals. Listed only so nobody ports it. | — | — |

---

## 2. They do it better

1. **Terminal flow control and resync are designed, not best-effort.**
   - T3 runs three layers. An ack window caps in-flight data at 8 chunks / 64 KiB per stream (`OutputProtocol.ts:9-13`). A per-subscriber queue holds at most 8 MiB, with a 128-byte charge per event so tiny events can't evade the cap (`:74-76`). On overflow the queue is dropped and the client is resynced from a snapshot instead of falling further behind (`:128-136`, `:170-176`).
   - Orquester's `/ws` has none of these. Its resync is also timer-driven: after the first resize following a subscribe, the daemon `await`s `setTimeout(80)` and then re-captures the pane (`apps/daemon/src/index.ts:4941-4953`). AGENTS.md forbids this kind of sleep-based orchestration.
   - Orquester has the better resync primitive, though: `capture-pane` is a free, exact snapshot. Overflow-then-resync costs us almost nothing to adopt.

2. **Retention is bounded by lines and bytes, and both are documented.**
   - T3 keeps 5,000 lines / 8 MiB on the server and caps the client buffer at 512 KiB (`packages/contracts/src/terminal.ts:6`). A long unterminated line can't bypass the cap (`terminal-runtime.md`).
   - Orquester's retained history is whatever tmux's default `history-limit` (2,000 lines) holds, which is fewer lines than xterm's own `scrollback: 8000` (`TerminalView.tsx:139`). Users scrolling a long build log lose history on every reconnect or project switch, because the replay is capped at 2,000 tmux lines.
   - `capture-pane -S -` serializes the whole history on every subscribe (`tmux.ts:36`), so raising the limit has a cost. It should be set deliberately: one `set-option -g history-limit N` beside `window-size` at `tmux.ts:450`.

3. **Renderer correctness and speed.**
   - T3 owns its terminal stack:
     - It paints DEC 2026 synchronized updates atomically (new, `26338ea5`, `SYNCHRONIZED_OUTPUT_RENDER_TIMEOUT_MS` in `surface.ts:37`).
     - Its Canvas 2D renderer batches background and style runs per frame (`renderer.ts`).
     - It bundles a Nerd Font symbols subset, so prompts render without a locally installed font (`ghostty/fonts/`).
     - It suppresses key-release events for shortcuts the app handles (new, `e433eeb7`).
   - Orquester uses xterm's DOM renderer on purpose, because WebGL blanked after resizes and reveals (`TerminalView.tsx:218-221`). The DOM renderer is xterm's slowest path for high-throughput output.
   - xterm 6 already supports `synchronizedOutputMode` (it is in its typings), so Orquester gets atomic sync frames for free. The gaps are throughput and glyph coverage, not correctness.

4. **Re-render isolation during streaming (state-management technique).** All three items below are new.
   - **Quiet shells.** `quietThreadShellAtomFamily` returns the previous shell object while only streaming ticks changed (`packages/client-runtime/src/state/threadShell.ts:267-280`). List-arranging atoms read the quiet list (`:394-403`). The sidebar row reads the live shell itself (`SidebarThreadRow.tsx`, commit `5a0d1594`). A streaming thread re-renders exactly one sidebar row.
   - **Narrow props.** The composer passes a derived enum (`readPromptUltrathink(prompt)` gives `"none" | "prefix" | "body"`) instead of the prompt string, plus a functional `onPromptEdit(edit)` callback. The traits picker and attach button no longer re-render per keystroke (`c19d9977`, `TraitsPicker.tsx`; likewise `17e62e74` for the model picker and `57d78440` for the Shift-hover quick actions).
   - **Debounced highlighting.** Composer code fences keep their mapped colors while the user types and re-tokenize after a pause (`09792213`, `composerCodeBlockHighlight.ts`).
   - **Orquester's equivalent and its limit.**
     - Orquester's timeline is already identity-preserving: memoized rows on stable identity (`ChatTimeline.tsx:72-73`; `rows.logic.ts:19-21`), and stream frames folded per network chunk in one store update (`packages/ui/src/lib/agent-chat/store.ts:2184-2220`).
     - The composer, though, holds the draft in `useState` at the top of a 2,199-line component (`composer/ChatComposer.tsx:325`), and no composer child is wrapped in `memo` (grep). So every keystroke re-renders the whole composer, including popover triggers and chips.

5. **Mobile and long-thread derivation reuses the unchanged prefix (new, `cf558963`).** `buildThreadFeed` and `deriveThreadFeedPresentation` keep the prefix up to the last user message and rebuild only the tail. The result is about 8x less JS per streamed chunk on long threads (`apps/mobile/src/lib/threadActivity.ts`). Orquester's `rows.logic.ts` preserves row identity but still walks the whole retained window on each frame. The window is bounded at 500 activities and 2,000 messages, so this matters less for us than it did for T3.

6. **Focus rules are written down and tested.**
   - T3 documents and tests the behavior (`docs/user/keyboard-focus.md`; `CommandPalette.focus.browser.test.tsx`):
     - The palette keeps focus while open and returns it to the composer on close.
     - Digit shortcuts go to the open palette or picker instead of switching threads.
     - A terminal that becomes ready while you type does not steal focus.
   - Orquester has a good general mechanism (`packages/ui/src/lib/keyboard-surfaces.ts`, `open-layers.ts`, `anotherLayerOwnsTheKeyboard` in `GlobalShortcutListener.tsx:93`). But `TerminalView` calls `term.focus()` unconditionally on mount (`TerminalView.tsx:271`). A project switch remounts every tab, and in grid view every terminal is visible, so the last-mounted terminal takes focus from wherever the user was.

7. **Windows PTY startup.** T3 waits for a valid Windows PTY PID through a readiness socket, can cancel startup before the first output, and kills process trees correctly under ConPTY (`apps/server/src/terminal/NodePtyAdapter.ts:70-161`, `:200`, `:259-284`). Orquester's `LocalSessionManager` spawns with no Windows-specific handling (`sessions.ts:1100-1106`; grep for `win32`/`conpty` in `sessions.ts` finds nothing), and it doesn't set xterm's `windowsPty` option.

---

## 3. Worth copying (ranked by value / effort)

1. **Bound `/ws` terminal output and resync on overflow** (H value, S effort).
   - **Where:** `apps/daemon/src/index.ts` `/ws` handler (`:4848-4963`).
   - **Sketch:**
     - Track per-id queued bytes. Before `send({t:"out"})`, check `socket.bufferedAmount`. Above a high-water mark (say 4 MiB), mark the id `overflowed` and drop its live chunks.
     - When `bufferedAmount` drains below a low-water mark, send `{t:"reset"}` (the client already handles `onReset` → `term.reset()`, `TerminalView.tsx:641-644`), then `sessions.scrollback(id)`.
     - Replace the `setTimeout(80)` resync (`:4949`) with the same "resync on demand" path, triggered when the resize is applied.
   - **Crib:** `apps/server/src/terminal/OutputProtocol.ts:74-186` for the queue, charge and resync shape, and `MAX_PENDING_BYTES` batching. Coalescing several `out` frames per id into one frame per macrotask is a cheap add-on.
   - **Tests:** a daemon test with a fake socket whose `bufferedAmount` stays high. Run with `pnpm --filter @orquester/daemon test`.

2. **Fix the hot-ring append and sanitize local replay** (M value, S effort).
   - **Where:** `apps/daemon/src/sessions.ts:518-525` and `:1135-1142`.
   - **Sketch:**
     - Replace the string ring with a chunk array plus a running byte total, and evict whole chunks from the front. Port T3's surrogate-safe split.
     - For `LocalSessionManager.scrollback()`, strip DA/DSR/OSC-query sequences before replay.
     - On the client, ignore `term.onData` while the replay chunk is being written: set a flag around the first `term.write(chunk, cb)`.
   - **Crib:** `Manager.ts:836-960` (`BoundedTerminalHistory`) and `:1138-1260` (`sanitizeTerminalHistoryChunk`).
   - **Tests:** unit tests in `apps/daemon/src/*sessions*.test.ts`.

3. **Terminal links and a terminal context menu** (H value, S effort).
   - **Where:** `packages/ui/src/components/terminal/TerminalView.tsx`, plus a new pure `packages/ui/src/lib/terminal-links.ts`.
   - **Sketch:**
     - Register an xterm `ILinkProvider` whose `provideLinks(y)` collects the wrapped logical line (use `buffer.getLine(i).isWrapped`, the same idea as T3's `collectWrappedTerminalLinkLine`) and runs T3's `extractTerminalLinks`.
     - URLs open in a new tab, or in the in-app browser tab if preferred.
     - Paths resolve against `session.cwd` and call `useAppStore.getState().revealInFileBrowser(path)` (`store/app.ts:2926`).
     - Add a small context menu: Copy, Paste, Select all (`term.selectAll()`), Jump to latest (`term.scrollToBottom()`), and Ctrl/Cmd+Shift+Home/End.
   - **Crib:** `apps/web/src/terminal-links.ts` (patterns, trailing-punctuation rules, Unicode fix `9ac1355e`) and `apps/web/src/terminal-links.test.ts`.
   - **Attribution:** MIT header comment as in `keybindings.logic.ts:5-7`.

4. **Set an explicit tmux `history-limit` and document the retention contract** (M value, S effort).
   - **Where:** `apps/daemon/src/tmux.ts:450` (beside `window-size latest`).
   - **Sketch:** `set-option -g history-limit 5000`, aligned with xterm's `scrollback`. Measure `capture-pane -S -` latency at the new size, since it runs on every subscribe and reconnect. Add a short "Terminal retention" note to the daemon README or a spec, the way T3's `terminal-runtime.md` does.

5. **A keybinding registry with `when` contexts, then a settings page** (M value, M effort).
   - **Where:**
     - Contract types in `packages/api` (`KeybindingRule { key, command, when? }`).
     - Persisted file and validation in `packages/config`: tolerant parse, keep unknown rules, merge new defaults without overwriting user rules.
     - Daemon route to read and upsert.
     - A resolver in `packages/ui/src/lib/keybindings.ts` that subsumes `resolveChatShortcut` (`agent-chat/keybindings.logic.ts`) and `GlobalShortcutListener.tsx`.
   - **Context keys to start with:** `terminalFocus`, `composerFocus`, `turnRunning`, `editableFocus`, `isDesktop`, `paletteOpen`. They map onto the existing `keyboard-surfaces.ts` and `open-layers.ts` checks.
   - **Crib:**
     - `packages/shared/src/keybindings.ts`: parser, `EVENT_CODE_SHORTCUT_KEYS`, `US_SHIFTED_TO_UNSHIFTED_KEYS`, when-AST, last-match-wins.
     - `apps/server/src/keybindings.ts:98-150`: late defaults and conflict handling.
     - `apps/web/src/components/settings/KeybindingsSettings.tsx`: recorder and conflict labels.
   - **Follow-on commands:** `mod+1..9` tab jump with a hold-modifier hint, `mod+[`/`mod+]` back/forward, `mod+shift+t` reopen closed tab, and terminal toggle/new/close.

6. **Command palette actions mode with shortcut hints** (M value, M effort, after #5).
   - **Where:** `packages/ui/src/components/command-palette/CommandPalette.tsx`. Add a third `PaletteMode` (`"actions"`), triggered by a `>` prefix the same way `?` triggers search (`conversation-search.ts:22-23`).
   - **Sketch:** each action declares `{ id, label, run, shortcutCommand? }`, and the row renders the live label from the registry. Use `useDeferredValue(query)` for filtering.
   - **Crib:** `CommandPalette.logic.ts:495` (actions filter), `CommandPaletteResults.tsx:196-240` (shortcut label), `CommandPaletteThemeItems.tsx` and `CommandPaletteProjectItems.tsx` (item-module split, new).

7. **Lazy-load heavy viewers and add a bundle budget** (M value, S effort).
   - **Where:** `packages/ui/src/components/files/viewers/PdfViewer.tsx`, `files/Editor.tsx`, `workflows/WorkflowEditorTab.tsx`, and the `TerminalView` consumer in `main/MainView.tsx`. Wrap each in `React.lazy` with the existing Suspense pattern from `WhiteboardView.tsx:12`.
   - **Budget:** add `build.rollupOptions.output.manualChunks` or simply rely on dynamic imports, plus a check script that fails when the entry chunk grows past a threshold. Run it with `pnpm build` in CI only, not in `pnpm check`.
   - **Crib:** T3 relies on `tanstackRouter({ autoCodeSplitting: true })` (`apps/web/vite.config.ts:214`). Orquester has no router, so per-component `lazy` is the equivalent.

8. **Composer keystroke isolation, then optionally the React Compiler with T3's coverage test** (M value, M effort).
   - **Step 1, small and safe.** In `composer/ChatComposer.tsx`, pass derived values instead of `draft.text` to the controls bar: has-text boolean, slash-command token, ultrathink-style flags. Wrap `ComposerChips`, `ComposerPrimaryActions` and the model/effort/mode popovers in `React.memo` with stable callbacks that take functional updates (T3 `c19d9977`, `17e62e74`).
   - **Step 2, optional.** Add `babel-plugin-react-compiler` with `target: "18"` (plus `react-compiler-runtime`) to `apps/web/vite.config.ts` and `apps/desktop/vite.config.ts`. Port `apps/web/src/reactCompilerCoverage.test.ts` as a `packages/ui` check over `src/**/*.tsx` that fails on bailouts. This needs a dependency change (`pnpm install`, lockfile) and a careful pass over effects that rely on referential churn.

Smaller follow-ups:
- A `perf` test script that pins the fold budget and the history-page/snapshot wire sizes (T3 `test:perf:v2-wire`, `package.json:36`) using synthetic logs. The spec's "≤ 2.5 s for the 55 MB fleet log" can become an operation-count assertion instead of a wall-clock one.
- A slow-request toast in `packages/ui/src/lib/http-client.ts`, cribbing `apps/web/src/rpc/requestLatencyState.ts`.

---

## 4. We do it better / they lack

- **Terminals survive a server restart.** Orquester's tmux backend keeps PTYs alive across daemon restarts and redeploys, and reattaches with persisted size (`sessions.ts:56-62`, `tmux.ts` `reattach` size fallback). T3 PTYs live in the server process. They restore only saved *history*; the processes don't survive.
- **Replaying a full-screen TUI correctly.** Orquester detects `alternate_on` and replays alt-screen panes with `\x1b[?1049h\x1b[H` framing and no `-J` (`tmux.ts:325-345`). It forces cell measurement before replay (`TerminalView.tsx:201-216`), never fits while hidden (`:67-84`, `hasLayoutBox`), and nudges a SIGWINCH repaint after replay (`:579-631`). This heals an idle agent TUI on reconnect, a case T3's history replay can't repair, because history is not the TUI's current grid.
- **Mobile terminal ergonomics in the PWA.**
  - Touch drag-to-scroll that forwards wheel events to alt-screen apps (`TerminalView.tsx:338-452`), and suppression of synthetic mouse events so scrolling doesn't open the keyboard.
  - IME autocorrect hardening for Android (`:160-182`), and soft-keyboard Enter mapped to newline for agents.
  - `MobileKeyBar` with Esc/Tab/^C/^D/arrows/Enter, paste, attach, and A−/A+ font size (`packages/ui/src/components/terminal/MobileKeyBar.tsx:14-23`, `:179-236`).
  - T3 reached comparable parity only in its native app (new `e27fffa7`).
- **Terminal file drop and paste become uploads with path injection, plus explicit bracketed paste for agent TUIs** (`TerminalView.tsx:454-553`; `lib/paste.ts`). There is also a Shift+Enter → ESC+CR newline for agent prompts (`:292-310`). I found no equivalent upload-into-terminal path in T3's ghostty surface.
- **Output-derived activity, bells and dev-server URLs.** `ActivityTracker` turns PTY output, titles and bells into working/idle/attention states with no process-table polling (`apps/daemon/src/ansi-activity.ts:168-256`). `UrlWatcher` suggests dev-server URLs from any session's output (`apps/daemon/src/index.ts:1413-1418`). The attention cycle (`Ctrl+Shift+A`, `GlobalShortcutListener.tsx:48-57`) jumps to the next agent that needs you. T3's closest equivalents are `thread.next`/`thread.previous`.
- **Measured fold performance work.** The fold-performance spec cut fold time from 45–81 s to 1–1.6 s on real logs, using batch retention, WeakMap per-state caches, and a per-task roster engine (`docs/superpowers/specs/2026-09-23-fold-performance-design.md`, "As built"). The thread-index spec adds lazy boot, `state.json` snapshots and a SQLite index (`2026-09-23-thread-index-and-lazy-boot-design.md`). This is the same class of work as T3's bounded snapshots and paging, adapted to an NDJSON log. What we lack is the regression *guard*, not the engineering.
- **Timeline without a virtualizer.** `content-visibility: auto` on rows (`packages/ui/src/styles/agent-chat.css:748-755`) plus a bounded retained window avoids LegendList's measurement machinery and keeps native find, selection and anchoring. The trade-off is recorded in `ChatTimeline.tsx:56-61`. T3 shipped several scroll-anchoring fixes in this release: `c13d058b`, `48fcf90f`, `7e101444`, `7f1ecf34`, `055a8418`. Some of them fix problems a virtualizer creates.
- **Keyboard-surface ownership** (`packages/ui/src/lib/keyboard-surfaces.ts`). It is a single target-based rule for when chat chords stand down inside modals, rail panels and menus. That is cleaner than T3's growing list of `!terminalFocus` / `!previewFocus` / `!editableFocus` conditions per rule. A keybinding registry (recommendation #5) should keep this rule as a built-in context, not replace it.
- **The process view kills processes and maps ports.** Orquester's Task Manager lists ports and supports guarded kill (`system-status.ts:20-30`). T3's diagnostics also signal processes, but its documented focus is sampling and history.
