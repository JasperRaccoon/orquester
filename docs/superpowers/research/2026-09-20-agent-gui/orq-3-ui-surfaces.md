# Orquester client-side surface map: what assumes "a session is a PTY rendered by xterm"

Scope: `packages/ui`, with `apps/web` / `apps/desktop` where the host runtime matters.
Question behind it: what would a new `kind: "agent-chat"` session (a chat-style GUI driving a
coding agent over its programmatic protocol) need to change, and what already works unchanged?

Every path below is repo-relative to `/var/lib/orquester/workspaces/jaspersito/orquester`.

---

## 0. Executive shape of the problem

The good news is structural: **the PTY assumption is not spread through the app.** It is
concentrated in exactly three places:

1. `packages/ui/src/components/terminal/TerminalView.tsx` — the whole xterm integration (743 lines,
   essentially all of it PTY-specific).
2. `packages/ui/src/components/terminal/MobileKeyBar.tsx` — a byte-level control-key bar.
3. The *input/output shape* of the transport: `SessionChannel` in
   `packages/ui/src/lib/transporter.ts:310-317` is literally `openOutput(id) / sendInput(id, string)
   / resize(id, cols, rows)`, and `WsSessionChannel` (`lib/transporters/ws-session-channel.ts`)
   speaks a 4-verb text protocol.

Everything else — the tab model, the tab strip, the grid, the command palette, the Attention
Center, the status dots, the launch menu, rename/reorder, close-confirm, activity/attention,
toasts, push — is **already kind-agnostic**, because the daemon is the authority for all of it and
the client only ever reads `SessionSummary`. `SessionSummary` (`packages/api/src/index.ts:1161`)
carries no PTY-only field that the UI depends on except `cols`/`rows`, which **no UI surface reads**
(they are written by `TerminalView` and never rendered anywhere).

The sharpest concrete finding: **`ProjectTab` is already a discriminated union with five arms**
(`packages/ui/src/store/app.ts:440-445`) and `MainView` already dispatches the main area on that
discriminant (`components/main/MainView.tsx:304-318`). Adding a chat renderer is a sixth arm, not a
re-architecture. The real work is (a) a second message family on the wire, (b) a per-session
message log in the store, and (c) deciding whether a chat session is a `SessionSummary` at all.

---

## 1. Every UI surface that renders or targets a session

Legend for the third column:
- **generic** — reads only `SessionSummary` fields that any session kind has (`id`, `kind`,
  `refId`, `title`, `projectPath`, `order`, `status`, `accountId`, `model`, `activity`).
- **PTY** — assumes bytes / xterm / cols+rows.

| # | Surface | File | Today | What `kind:"agent-chat"` needs |
|---|---|---|---|---|
| 1 | **TerminalView** (main-area renderer) | `components/terminal/TerminalView.tsx:87-743` | **PTY, totally** | A *sibling* component. Do not extend this one. |
| 2 | **MobileKeyBar** | `components/terminal/MobileKeyBar.tsx:86-256` | **PTY** (`KEYS` are raw bytes, `:13-23`) | Should render **nothing** for a chat session (its `active.type !== "session"` guard at `:113` must grow a kind check) — a chat composer supplies its own send/attach affordances. |
| 3 | **MainView** (tab-vs-grid layout + dispatch) | `components/main/MainView.tsx:78-357` | **generic**; dispatch at `:304-318` | One added branch. `cellIcon` `:28-40` and `cellTitle` `:42-48` already switch on `tab.type`. Grid keeps every tab mounted (`:266 show = grid \|\| active`), so a chat view must tolerate `display:none` — trivially easier than xterm, which needed the whole `hasLayoutBox` dance (`:77-79`). |
| 4 | **TabStrip** (desktop tabs, drag-reorder, inline rename) | `components/topbar/TabStrip.tsx:59-256` | **generic** | Nothing. It reads `tab.session.title/status/accountId/model` (`:124-141, 212-223`) and calls `reorderTabs`/`renameTab`. Drag-reorder is already session-only by construction (`:80`). The model chip (`:22-27, 131`) works for any session with a `model`. |
| 5 | **TabSwitcher** (mobile tab list) | `components/topbar/TabSwitcher.tsx:11-153` | **generic** | Nothing (adds an icon case at `:17-23`). |
| 6 | **SessionStatusDot** | `components/ui/session-status-dot.tsx:21-66` | **generic** | Nothing. Driven purely by `activity.state` + `activity.attention`. A chat session just needs the daemon to emit `session.activity`. |
| 7 | **Grid-cell header** | `components/main/MainView.tsx:280-302` | **generic** | Nothing. |
| 8 | **NewTabMenu / AgentRow** (the launcher) | `components/topbar/NewTabMenu.tsx:189-520` | **generic** | Either a second row per agent ("chat" vs "terminal") or a global toggle. See §4. |
| 9 | **ProjectOverview** (empty-project resume picker) | `components/main/ProjectOverview.tsx:31-150` | **generic** | Nothing structural; it calls `openTab("agent", …, conversationId)` at `:66-77`. A chat mode adds a `kind` argument. |
| 10 | **Command palette** | `components/command-palette/CommandPalette.tsx:251-332, 390-399` | **generic** | Nothing. Rows are built from `sessions` filtered by a visible-project index; it never touches session content. |
| 11 | **Attention Center / Opened Agents** | `components/sidebar/OpenedAgents.tsx:31-239` + `components/attention/agent-sessions.ts` | **generic, but hardcodes `kind !== "agent"`** at `agent-sessions.ts:333` | **One-line change**: the filter must accept the chat kind too, or every chat session silently disappears from the sidebar, the badge, and `Ctrl+Shift+A`. |
| 12 | **GlobalShortcutListener** | `components/attention/GlobalShortcutListener.tsx:81-141` | **generic**, but its **bail zone is xterm-shaped** | See §5/§1.1 below — this is the one subtle one. |
| 13 | **CloseSessionConfirm** | `components/layout/CloseSessionConfirm.tsx` via `requestCloseTab` `store/app.ts:2480-2500` | **generic** | Nothing. |
| 14 | **PickComposeSheet** (browser element picker → agent) | `components/browser/PickComposeSheet.tsx:28` | **targets a session, delivers bytes** | See §1.2 — the one cross-surface consumer that *writes into* a session. |
| 15 | **Session file upload** (drop / paste / mobile attach) | `lib/session-upload.ts:50-97` | **PTY output format** (`injectionForPaths` `:33-37` emits bracketed-paste escapes) | A chat composer would attach the returned `path` as a structured attachment instead; the upload call itself (`api.uploadSessionFile`, `lib/api-client.ts:929-940`) is transport-generic and reusable verbatim. |
| 16 | **`useProjectTabs` / `firstTabId` / `reassignActive`** | `store/app.ts:3130-3174`, `2902-2936` | **generic** | Nothing, if chat sessions live in the same `sessions` array. |

### 1.1 The xterm bail zone — a real trap for a chat UI

`packages/ui/src/lib/session-nav.ts:151`:

```ts
export const SHORTCUT_BAIL_SELECTOR = ".xterm, [data-browser-view]";
```

`GlobalShortcutListener` is the app's single capture-phase `window` keydown handler
(`components/attention/GlobalShortcutListener.tsx:109`). `Ctrl/Cmd+K` bails inside that selector
(`:101`) because Ctrl+K is readline's kill-line. **A chat composer is a normal `<textarea>`, so it
is NOT in the bail zone** — `Ctrl/Cmd+K` would open the command palette on top of a half-typed
message. Two consequences:

- A chat view should either add itself to `SHORTCUT_BAIL_SELECTOR`, or (better) accept the palette
  steal, since a textarea has no readline semantics. This is a deliberate decision, not a default.
- Conversely `Ctrl+Shift+A` is *unconditionally* stolen (`:87-95`, no bail-zone check) precisely
  because xterm would otherwise encode `\x01` into the PTY (documented at `:20-21`). For a chat
  textarea that theft is harmless and desirable — no change needed.

Note also the documented caveat that Chrome reserves `Ctrl+Shift+A` for tab search, so an installed
PWA may never see it (AGENTS.md); the Attention Center menu is the reliable path either way.

### 1.2 PickComposeSheet — the only other surface that *writes into* a session

`components/browser/PickComposeSheet.tsx:28` filters eligible targets with
`s.kind === "agent" && s.projectPath === projectPath && s.status === "running"`. It composes an
element payload (HTML/CSS/screenshot) and delivers it into the chosen agent's PTY. A chat session
would be a *better* target for this than a PTY (structured attachment instead of a bracketed paste),
but the filter and the delivery call both need widening. See §7 for the detailed trace.

### 1.3 Surfaces that target a session but are *not* session-content surfaces

These need nothing at all and are listed so they aren't re-audited:

- `components/system/SessionChip.tsx` / `session-owner.ts` — maps a `/proc` pid back to a session
  for the System panel. Works off `SessionSummary` + tmux pane pids server-side. A chat session with
  no PTY simply won't appear there, which is correct.
- `components/status/*` toasts — `ModelWarningToast`, `ResumeErrorToast`, `NoticeToast`,
  `ConnectionStatusToast`, all rendered through one portal column (`components/status/ToastStack.tsx:18-27`).
  Entirely kind-agnostic.

---

## 2. How the store models a session and a tab today

### 2.1 The wire type (server-authoritative)

`packages/api/src/index.ts:1161-1195` — `SessionSummary`:

| Field | Authority | Chat relevance |
|---|---|---|
| `id` | daemon (UUID, never reused — noted at `store/app.ts:493`) | keep |
| `kind: RegistryKind` | daemon | **this is the extension point** — note it is `RegistryKind`, the *wide* union, not the narrow `SessionKind = "shell" \| "agent"` (`packages/api/src/index.ts:786-789`). `SessionSummary.kind` is already widened; `CreateSessionRequest.kind` (`:1198`) is also `RegistryKind`. |
| `refId` | daemon | the registry entry (`claude`, `codex`, …) — unchanged for chat |
| `accountId?`, `model?`, `missingModels?` | daemon | unchanged; `model` already drives the tab chip |
| `title`, `order` | daemon, **client-optimistic** on rename/reorder | unchanged |
| `projectPath`, `cwd` | daemon | unchanged |
| `cols`, `rows` | daemon, written by TerminalView | **dead weight for chat** — no UI surface reads them |
| `status: "running" \| "exited"`, `exitCode?` | daemon | unchanged |
| `createdAt` | daemon | used as a sort tiebreaker everywhere |
| `activity?: SessionActivity` | daemon, **single source of truth** (`:1193-1194`) | **reusable as-is** — see below |

`SessionActivity` (`packages/api/src/index.ts:953-964`) is `{ state: "working"|"waiting"|"idle",
attention: "bell"|"needs-input"|"finished"|null, lastOutputAt, needsAttentionAt? }`. This is already
*exactly* the abstraction a chat session needs, and it is already fed by structural agent hooks for
claude/codex/opencode/grok (`AgentEventSource`, `:972-980`) rather than by bell-sniffing. A chat
session driving an agent over its protocol would produce **better** activity signal than the PTY
path, using the same field.

### 2.2 The client tab model

`packages/ui/src/store/app.ts:440-445`:

```ts
export type ProjectTab =
  | { id: string; type: "session"; session: SessionSummary }
  | { id: string; type: "files"; title: string }
  | { id: string; type: "git"; title: string }
  | { id: string; type: "todo"; todoId: string; title: string }
  | { id: string; type: "browser"; browser: BrowserSummary };
```

Two distinct precedents for "a new tab kind" already exist in this file:

- **Client-local tabs** (`FileTab` `:417-421`, `GitTab` `:424-428`, `TodoTab` `:432-437`) — stored in
  `fileTabsByProject` / `gitTabsByProject` / `todoTabsByContext` (`:656-660`), created with a
  client-side `crypto.randomUUID()` (`:2395`, `:2417`), closed via `removeLocalTab` `:2973-3000`.
- **Server-owned non-session tabs** — `BrowserSummary` in `browsers: BrowserSummary[]` (`:619`),
  created by `openBrowser` `:2427-2446`, reconciled by `browser.*` events (`:2844-2853`), removed by
  `removeBrowser` `:2956-2970`. This is the closer precedent for a chat session: a **daemon-owned
  record with a client-local active-tab pointer**.

Tab ordering: `useProjectTabs` `:3130-3174` concatenates `sessionTabs`, `browserTabs`, `fileTabs`,
`gitTabs`, `todoTabs` in that fixed order, with sessions and browsers each sorted by
`order → createdAt` (`:3152-3156`, `:3167-3171`).

### 2.3 Server-authoritative vs client-local, precisely

**Server-authoritative** (arrives via `listSessions` + the `sessions` event channel):
`sessions` (`:617`), `browsers` (`:619`), `activityById` (`:621`), `recentProjects` (`:607`),
`registry`, `usage`, `agentAccounts`, `cliproxy`, `workspaces`, `projects`, `accounts`, `todos`.

**Client-local, persisted to localStorage**:
`activeTabByProject` (`:667` — keyed by project path *or* workspace name), `viewModeByProject`
(`:669`), `preferredAccountByAgent` (`:671`), `preferredModelByAgent` (`:673`), `terminalFontSize`
(`:675`), `colorScheme`/`themeMode` (`:677-681`), `sidebarWidth` (`:683`), `paneSizesByProject`
(`:685`), `gridTracksByProject` (`:687`).

**Client-local, transient**: `modelWarning` (`:628`), `resumeError` (`:635-648`), `notice` (`:654`),
`pendingCloseTabId` (`:569`), `agentConversationsByProject` (`:614`, a cache invalidated on session
create/close — `dropConversationCache` at `:2341-2344` and `:2465-2468`).

Optimistic-then-reconciled: `renameTab` (`:2638-2655`) and `reorderTabs` (`:2657-2674`) both write
optimistically and fall back to a full `loadSessions()` on failure.

One subtlety worth preserving: `activityById` is **rebuilt from scratch** by `loadSessions`
(`:2069-2080`) rather than merged, guarded by a monotonic `activityEventSeq` (`:479-486`) so an
event that landed mid-fetch is not reverted. Any per-session chat state added to the store needs the
same discipline or it will be clobbered by a reconnect fan-out.

### 2.4 What a chat session would add

None of this exists today. Proposed shape, following the file's own conventions:

```ts
// server-authoritative, keyed by session id — sibling of activityById
messagesBySession: Record<string, ChatMessage[]>;
// client-local streaming state (the in-flight assistant turn)
streamingBySession: Record<string, { messageId: string; text: string; toolCalls: ToolCall[] } | null>;
// server-authoritative: the agent is blocked on the user
pendingApprovalsBySession: Record<string, ApprovalRequest[]>;
pendingQuestionBySession: Record<string, QuestionRequest | null>;
// client-local composer draft, so switching tabs doesn't lose it
composerDraftBySession: Record<string, string>;
```

Per-message fields a coding-agent chat needs (from the protocols this would drive): role, id,
timestamp, content blocks (text / thinking / tool-use / tool-result), tool name + input + output,
diff payloads for edits, token usage, and an error arm. Approvals need: tool name, the exact
proposed action (command string or file diff), and a decision channel back.

**Three store rules from AGENTS.md apply directly to this:**

1. *Anything persisted client-side must load through a schema with a fallback* — "Adapter/localStorage
   loads must go through a schema (or field-wise validation) with fallback". A composer draft or a
   cached transcript in localStorage must `safeParse` (pattern: `lib/app-config.ts`) or validate
   field-wise (`lib/panel-sizes.ts`, `lib/view-mode.ts`). A raw `JSON.parse` of a persisted `usage`
   blob once crashed the whole web client on load.
2. *Preserve object identity when nothing changed* — `renameTodoTabs` `:539-548` and `dropActivity`
   `:496-498` both do this explicitly so `useProjectTabs`' memo doesn't recompute. A chat message
   log appended to on every stream delta will re-render the tab strip on every token unless the
   selector is narrow. The precedent to copy is `useSessionActivity` `:3220-3222` — a single-session
   slice selector, documented at `:3215-3219` as "cheap on a chatty output stream".
3. *Never store what the daemon owns* — `SessionSummary.model` is rendered on the tab (rather than
   the client's `preferredModelByAgent`) precisely so it survives reload/reattach
   (`components/topbar/TabStrip.tsx:19-20`). A chat transcript must be daemon-owned for the same
   reason: sessions survive daemon restarts via tmux today, and a client-only transcript would be
   lost on every reload.

---

## 3. The transport layer

### 3.1 What exists

Three layers, all in `packages/ui/src/lib/`:

- **`Transporter`** (`transporter.ts:319-347`) — `request()`, optional `requestBytes()`,
  `openStream(path, handlers)` (chunked GET), optional `sessionChannel()`, optional
  `browserChannel()`.
- **`SessionChannel`** (`transporter.ts:310-317`) — the multiplexed terminal I/O abstraction:
  exactly `openOutput(id, handlers)`, `sendInput(id, data: string)`, `resize(id, cols, rows)`.
- **`WsSessionChannel`** (`transporters/ws-session-channel.ts:15-211`) — the web implementation.
  Wire protocol documented at `:11-13`:
  `client → {t:"sub"|"unsub", id} | {t:"input", id, data} | {t:"resize", id, cols, rows} | {t:"ping"}`
  `server → {t:"out", id, data} | {t:"end", id} | {t:"pong"}`

`ApiClient` picks per call: `sendSessionInput` (`api-client.ts:915-921`) and `resizeSession`
(`:942-950`) use the channel **when present** and fall back to REST POSTs; `openSessionOutput`
(`:961-965`) uses the channel or falls back to `transporter.openStream("/api/sessions/:id/output")`.
That fallback is the desktop unix-socket path (`transporter.ts:336-340` explains why: no connection
cap, so no need to multiplex).

The separate NDJSON event bus is `ApiClient.openEvents` (`api-client.ts:197-228`): it rides
`transporter.openStream("/events")`, buffers partial lines and `JSON.parse`s each complete one into
`applyEvent`. **The per-message parse is already try/caught to "ignore malformed line"** (`:218-220`).

There is a third, *already-shipped* precedent for a second WS family: `WsBrowserChannel`
(`transporters/ws-browser-channel.ts`), exposed as `Transporter.browserChannel?()`
(`transporter.ts:341-346`) and deliberately kept separate — the comment at
`transporters/http-transporter.ts:514-518` says it is "a sibling of `sessionChannel` kept separate
so the terminals' text-only path is untouched."

### 3.2 Can `/ws` carry a second message family?

**Mechanically, yes, cheaply.** `WsSessionChannel.onmessage` (`:127-153`) dispatches on `msg.t` and
routes by `msg.id` into a `Map<string, StreamHandlers>`. Adding `{t:"event", id, payload}` and a
richer handler interface is a small change. **But the recommendation is: don't.** Three reasons,
all grounded in the code:

1. **`StreamHandlers` is text-only by contract** (`transporter.ts:287-298`): `onData(chunk: string)`.
   Every consumer treats chunks as an *append-only byte stream with no framing* — `TerminalView`
   does `term.write(chunk)` (`:630`) and `openEvents` does its own newline reframing (`:209-223`).
   Structured events need message boundaries, which means either reframing again or widening the
   interface for every implementation (web fetch-stream, desktop IPC bridge, WS channel).
2. **The precedent is already set against it.** The browser tab got its own channel rather than
   riding `/ws`, with an explicit "keep the terminals' text-only path untouched" rationale.
3. **The desktop-LOCAL transport has no session channel.** `HttpTransporter.sessionChannel()` exists
   (`http-transporter.ts:510-512`); the unix-socket transporter omits it (`transporter.ts:336-340`:
   "Transports with no connection limit (the desktop unix socket) omit it and fall back to
   `openStream`/request"), so desktop-local terminals go through `openStream` + REST.
   **Precision that matters:** desktop-*remote* **does** get the channel — `apps/desktop/src/renderer.tsx`
   builds an `HttpTransporter` with a `NodeHttpClient`, and its terminals open a real renderer-side
   `WebSocket` (a cross-origin WS handshake is not CORS-gated, so it needs no IPC detour). So the
   split is **desktop-local vs. everything else**, not "web vs. desktop". Anything built only on
   `SessionChannel` silently dies on desktop-local — exactly the trap `openBrowser` had to guard
   against (`store/app.ts:2430-2433`: "a transport without it would create a dead blank tab. Refuse
   rather than open one with no way to render"). A chat session must either ship a desktop-local
   fallback or refuse to open there, explicitly.

**Recommended split:**

- **Transcript + streaming deltas** → a **third channel**, `WsAgentChannel`, modelled on
  `WsBrowserChannel`, with a JSON-message handler interface rather than `StreamHandlers`. On desktop
  it degrades to `transporter.openStream("/api/sessions/:id/agent-stream")` with NDJSON reframing —
  the exact pattern `openEvents` already implements, so the reframing code is reusable.
- **Lifecycle** (created/updated/exited/activity/approval-raised) → the **existing `/events`
  NDJSON bus**, because `applyEvent` (`store/app.ts:2798-2898`) is already the single reconciliation
  point and already handles a 6th channel trivially (add `if (event.channel === "agent-chat")`).
- **User actions** (send message, approve/deny, cancel turn) → **plain REST** through
  `ApiClient.send`, like `renameSession`/`reorderSessions`. They are request/response with a result
  the UI wants to reconcile, not fire-and-forget keystrokes. Note `sendSessionInput` returns
  `Promise<void>` and resolves *immediately* when the channel exists (`api-client.ts:918`) — i.e.
  the current input path has **no delivery guarantee at all**, which is fine for a keystroke and not
  fine for a chat message.

### 3.3 Reconnect/resubscribe behaviours a structured stream must replicate

These are hard-won and each has an explicit rationale in the code. A structured stream must
reproduce every one of them:

| Behaviour | Where | Why it exists |
|---|---|---|
| **Re-subscribe every id on `onopen`** | `ws-session-channel.ts:117-125` | nothing is remembered server-side per socket |
| **`onReset()` before replay** | `ws-session-channel.ts:122`, consumed at `TerminalView.tsx:636-639` | the daemon replays the buffer on re-subscribe, so the view must clear or it duplicates. **A chat log has the same hazard**: a replayed transcript appended to an existing one doubles every message. Either `onReset` + full replay, or a cursor/`since` parameter — the latter is strictly better for a transcript and has no PTY analogue. |
| **`wake()` — the half-dead socket probe** | `ws-session-channel.ts:68-92` | mobile browsers freeze hidden tabs and kill sockets **without delivering `close`**; `readyState` still reads OPEN. A pending backoff is short-circuited, a dead socket redialed, an apparently-open one must answer `{t:"ping"}` within 2500 ms or is force-reconnected. Driven from `store/app.ts:1287-1289` (`wakeSessionChannels()` + `wakeBrowserChannels()`), itself fired by visibility/pageshow/focus/online in `OrquesterApp.tsx:79-80`. |
| **Backoff** `min(attempts*500, 5000)` | `ws-session-channel.ts:192-202` | linear, capped |
| **Superseded-close guard** | `ws-session-channel.ts:157-160` | an explicit reconnect's `close` must not schedule a second dial |
| **Drop-on-offline is acceptable** | `ws-session-channel.ts:204-210` | "outputs re-subscribe on reconnect, and a keystroke/resize missed during a blip is corrected by the buffer replay". **This is NOT acceptable for a chat message** — a dropped user turn is silently lost. A chat send must be REST (ack'd) or must queue-and-retry. |
| **One channel per origin, reused across `ApiClient` rebuilds** | `ws-session-channel.ts:213-234` | credential changes call `setCredential` → reconnect (`:31-37`) |
| **Event-bus buffering during the connect fan-out** | `store/app.ts:1115-1141`, replayed at `:1182-1188` | the broadcaster has no replay, so subscribing *after* the snapshot fetch loses transitions emitted in between. A chat channel opened at connect time has the identical race. |
| **Staleness watchdog** | `store/app.ts:1190-1205` (`EVENTS_STALE_MS`), `:1300-1310` | a silently-stalled stream is detected by heartbeat age *before* `/health`, because `/health` can succeed while the stream is dead |
| **`activityEventSeq` anti-revert guard** | `store/app.ts:472-486`, applied at `:2069-2080` | an awaited snapshot fetch must not overwrite state an event freshened mid-flight. A transcript refetch has the same problem. |

---

## 4. The launch flow UI

### 4.1 What it collects

`AgentRow` in `components/topbar/NewTabMenu.tsx:189-405` is the whole picker. Per agent row:

- **Agent** — `agent.id` from `registry.agents`, filtered to `a.enabled || isProxyLauncher(a.id)`
  (`:429`). Disabled proxy launchers render greyed-but-visible with the daemon's `disabledReason`
  (`:295-313`).
- **Account chips** — `:363-389`. Options are `System` (the `SYSTEM_ACCOUNT_ID` sentinel, *not* an
  omitted value — `:215`, semantics documented at `packages/api/src/index.ts:1153-1159`) plus
  managed accounts for the family. Proxy launchers remap family via `PROXY_ACCOUNT_FAMILY` (`:44-47`)
  and additionally require the account to be **seeded into the proxy** (`:206-212`). Selection is
  remembered client-side in `preferredAccountByAgent` (`store/app.ts:671`, `setPreferredAccount`
  `:2523-2528`).
- **Model chips** — `:340-362`, `claudex`-only (`showModels` `:224`). Built from curated ids ∪
  router/xAI-served ids confirmed by the live catalog (`:262-276`). A keyless (router/Grok) pick
  **dims the account row and forces `SYSTEM_ACCOUNT_ID` on launch** (`:281-289`, `:331`) so no
  `acc<hex>/` routing prefix is stamped. Remembered in `preferredModelByAgent`.
- **Resume conversation id** — `ResumeSection` `:79-172`. Lazily triggers
  `loadAgentConversations(projectPath)` only when expanded (`:93-97`), filters to this agent and
  drops `cliproxy`-home rows via `isResumableConversation` (`:102`), caps at 10 inline (`:34`,
  `:103-104`). Crucially it resolves the **identity** for the resume via `resumeAccountId`
  (`lib/resume-account.ts:25-36`) — an `account`-home row forces that account, a `system`-home row
  honours the chip. Gated on `canResumeAgent(agent.id)` and on being inside a project (`:395`).
- **`initialCommand`** — *not* collected here. It is collected by
  `components/sidebar/NewProjectModal.tsx` (template review step, `templateCommand` at `:461-468`)
  and passed through `createProjectWithCommand` (`store/app.ts:1750-1799`), which picks a POSIX
  shell deliberately (`:1769-1771`) and passes the command as the 7th arg to `openTab` (`:1780-1788`).

### 4.2 How it posts

Every launch path funnels through one action, `store/app.ts:2273-2347`:

```ts
openTab(kind, refId, title?, accountId?, model?, resumeConversationId?, initialCommand?)
  → api.createSession({ kind, refId, title, projectPath, cwd, accountId, model,
                        resumeConversationId, initialCommand })   // POST /api/sessions
```

`projectPath` and `cwd` both come from `currentProject` (`:2285-2286`). On success it upserts the
session, **makes it the active tab** (`:2328-2330`), raises `modelWarning` if the daemon reported
`missingModels` (`:2334-2337`), and drops the conversation cache for that project (`:2341-2344`).
On a `RESUME_UNAVAILABLE` 400 it converts the error into `resumeError` with **replay material**
(the exact account/model/project of the refused attempt, `:2309-2314`) and re-scans conversations
(`:2319-2321`); `startFreshFromResumeError` (`:2353-2383`) navigates back to that project before
relaunching. Every other error rethrows to `launchWithNotice` (`lib/launch-notice.ts:15-24`), which
turns a fire-and-forget rejection into a visible toast.

### 4.3 What changes for chat

The signature is already 7 positional arguments, which is at its limit. The clean move is to
**convert `openTab` to an options object** and add `mode: "terminal" | "chat"` (or make chat a
distinct `kind`). Everything downstream — the upsert, the active-tab assignment, the model warning,
the resume-error recovery, the conversation-cache invalidation — is kind-agnostic and needs no
change. Callers to update: `NewTabMenu.tsx:141-152, 323-336`, `ProjectOverview.tsx:66-77, 138`,
`store/app.ts:1780, 2382`.

A per-agent "open as chat" affordance also needs the registry to advertise which agents support a
programmatic protocol — the natural home is `RegistryEntry` in `packages/registry/src/index.ts`,
alongside the existing `resumeArgs` / `canResumeAgent` precedent.

---

## 5. Mobile-specific concerns

### 5.1 What a chat UI sidesteps

- **The whole MobileKeyBar** (`components/terminal/MobileKeyBar.tsx`). Its `KEYS` array (`:13-23`)
  exists solely because soft keyboards lack Esc/Tab/Ctrl-C/arrows. A chat composer needs none of it.
  Its A−/A+ font controls (`:210-239`) and its `onPointerDown + preventDefault` focus-theft
  avoidance (`:174-177`, `:244-248`) go away too.
- **The soft-keyboard Enter ambiguity.** `TerminalView.tsx:550-569`: on mobile, a bare Enter from an
  agent session is rewritten to `\x1b\r` ("insert newline") because there is no Shift modifier, and
  submitting is delegated to the key bar's `↵` button. A chat composer has an explicit Send button —
  the whole class of problem disappears. (Desktop's Shift+Enter → `\x1b\r` hack at `:287-305` goes
  too.)
- **Touch drag-to-scroll re-implementation.** `TerminalView.tsx:333-447` is ~115 lines: a slop
  threshold, alt-screen detection routing the drag to synthesized `WheelEvent`s vs
  `term.scrollLines`, and a 350 ms window that swallows the compatibility mouse burst so a scroll
  doesn't also open the keyboard. **A normal scrollable `<div>` needs none of this.**
- **Bracketed-paste plumbing.** `lib/paste.ts:18-35` exists because xterm only brackets a paste once
  it has *seen* the app enable mode `?2004h`, and `tmux capture-pane` replay omits DEC private
  modes — so a reconnected client never learns. Structured messages make this moot.
- **IME hardening.** `TerminalView.tsx:156-177` re-asserts `autocorrect/autocapitalize/spellcheck`
  off on xterm's textarea because Android Gboard's autocorrect backspaces never reach the PTY. A
  chat composer *wants* autocorrect.
- **Fit/resize/SIGWINCH.** `hasLayoutBox` (`:77-79`), `applyFit` (`:225-253`), first-render refit
  (`:262-265`), the `ResizeObserver` (`:571-572`), and the `forceAgentRepaint` nudge (`:587-626` —
  shrink the pane a row and restore it 50 ms later to force a TUI self-repaint after a capture-pane
  replay). **All of it disappears.** This is the single largest simplification available.

### 5.2 What a chat UI still needs

- **`visualViewport` sizing.** `hooks/use-viewport-height.ts:17-52` sizes the shell to
  `visualViewport.height`, coalesced to one measurement per frame (`:43-51`) and listening to
  `scroll` as well as `resize` because iOS only reports the final height on `scroll` (`:254-257`).
  A chat composer pinned above the soft keyboard needs this **exactly as much** as a terminal does.
- **Safe-area insets — and the one-owner rule.** `apps/web/src/styles.css:38-44` pads
  `env(safe-area-inset-*)` onto **`#root > *`** (the `AppWrapper`, `components/layout/AppWrapper.tsx:19-30`)
  with `box-sizing: border-box`, keeping the insets *inside* the measured height. The comment at
  `:26-37` spells out the bug this fixed: padding `#root` itself stacked top+bottom inset on top of
  the shell height and pushed the last in-flow row below the fold by exactly `inset-top`.
  **Therefore: a chat composer must NOT pad its own bottom inset**, because it is an in-flow child.
  The only exception, by construction, is `position: fixed` overlays, which escape the box and pad
  their own — see `components/ui/sheet.tsx:202` (`pb-[max(0.5rem,env(safe-area-inset-bottom))]`).
  Web-only: the Electron host never loads this stylesheet.
- **Overscroll suppression.** `apps/web/src/styles.css:16-19` sets `overscroll-behavior: none` on
  html/body to kill pull-to-refresh. A scrollable chat transcript at scroll-top on mobile would
  re-introduce the pull-to-refresh reload risk if that rule were ever relaxed — it must stay.
- **Mobile tab affordance.** `TabSwitcher` replaces `TabStrip` below `md`; `AdaptiveMenu`
  (`components/ui/adaptive-menu.tsx:20-45`) renders the "+" launcher as a `BottomSheet` on mobile.
  `useIsDesktop()` is `(min-width: 768px)` (`hooks/use-media-query.ts:21-23`).
- **Attach without drag.** A phone has no drag source. `MobileKeyBar`'s hidden `<input type="file">`
  (`:185-208`) is the mobile equivalent of desktop drop; a chat composer needs its own equivalent,
  reusing `uploadFilesToSession` minus the `injectionForPaths` escape wrapper.
- **Clipboard read for iOS.** `MobileKeyBar.readClipboard` (`:46-72`) exists because iOS's soft
  keyboard has no paste key and its long-press callout needs an editable target under the finger —
  which xterm's hidden textarea is not. **A chat `<textarea>` IS an editable target**, so iOS's
  native paste works and this helper becomes unnecessary for chat (though image-paste handling is
  still worth keeping).

---

## 6. Design-system building blocks a chat/diff/approval UI can reuse

### 6.1 Theming — reuse by doing nothing

`packages/ui/tailwind-preset.ts:19-21` remaps Tailwind's whole `neutral` scale to
`rgb(var(--n-<step>) / <alpha-value>)`, and `packages/ui/src/styles/globals.css:22-36` defines the
eleven triples per `[data-scheme][data-mode]`. **A chat UI written with ordinary `bg-neutral-900` /
`text-neutral-300` classes is themed across all seven schemes × light/dark for free, with no
component branching.** Two hard rules:

- **Keep the `<alpha-value>` placeholder** — a plain `var(--x)` silently breaks every opacity
  modifier (`bg-neutral-900/40`), documented at `tailwind-preset.ts:11-15`.
- **Never branch a component on the scheme.** The only two surfaces that opt out do so on the
  resolved *mode*, not the scheme: xterm keeps a static palette (`TerminalView.tsx:30-52`, rationale
  in `globals.css:17-19`) and CodeMirror swaps `oneDark` ↔ light chrome (`files/Editor.tsx:29-34`).

There is also a **semantic status scale** (`tailwind-preset.ts:23, 45-60`): `danger` / `warn` / `ok`
/ `info`, each with `DEFAULT`, `-soft` (wash base, always used with an alpha modifier), `-muted`
(pre-dimmed for sites rendering under `/70`–`/80`) and numbered steps. Directly applicable to an
approval UI (danger for a destructive tool call, warn for pending, ok for approved). Already in use:
the launcher's model chips are `bg-warn-500/15 text-warn-300 ring-warn-500/40` and its account chips
`bg-info-500/15 …` (`NewTabMenu.tsx:352-354`, `:379-381`) — a ready-made chip vocabulary.

And **diff bands are already themed variables**: `--diff-add-bg/-fg`, `--diff-del-bg/-fg`
(`globals.css:38-45`), explicitly called out as "the one place a red/green pair is a SURFACE rather
than a status label".

### 6.2 Diff rendering — reuse directly

`components/git/DiffView.tsx:10-38` + `components/git/git-diff.ts` (`parseUnifiedDiff` → `DiffRow[]`).
Its own docstring (`:5-9`) describes it as "the PTY-free counterpart to the file Editor — purely
presentational". It takes `{ diff: string, binary?, loading?, emptyLabel? }` and handles the binary
and empty cases. **An agent's proposed file edit, rendered in a chat bubble or an approval card, is
exactly this component with a unified-diff string.** No modification needed.

### 6.3 Overlays and dialogs

| Block | File | Chat use |
|---|---|---|
| `Modal` | `components/ui/modal.tsx:14-47` | portal, backdrop-click + Escape close, `max-h-[90vh] max-w-3xl` |
| `ConfirmDialog` | `components/ui/confirm-dialog.tsx:25-` | **approval prompts.** Already supports `danger` styling and an optional `confirmText` typed-name gate for irreversible actions (`:12-13`) — e.g. requiring the user to type a filename before approving a destructive write |
| `BottomSheet` | `components/ui/sheet.tsx:168-220` | mobile approval / attachment sheet. Note the two traps documented inline: the wrapper is `overflow-hidden`, so anything that must escape (a dropdown, tooltip, nested confirm) **must portal to `document.body`** (`:183-186`); and it pads its own bottom inset because it is `fixed` (`:202`) |
| `AdaptiveMenu` | `components/ui/adaptive-menu.tsx:20-45` | dropdown on desktop / sheet on mobile, same `DropdownItem` children in both |
| `ContextMenu` | `components/ui/context-menu.tsx` | per-message actions (copy, retry, fork) |
| `Tooltip`, `Button`, `IconButton`, `Input`, `Switch`, `ResizeHandle`, `UploadProgressBar`, `PasswordVerify` | `components/ui/index.ts:1-23` | the full existing primitive set |

### 6.4 Toasts

`components/status/ToastStack.tsx:18-27` is the single floating portal column, ordered by urgency
(transport → launch warnings → notices). Four existing toasts show the pattern of a store field +
dismiss action: `modelWarning`/`dismissModelWarning`, `resumeError`/`dismissResumeError` (with an
*action*: `startFreshFromResumeError`), `notice`/`dismissNotice`. A chat error ("the agent's stream
died mid-turn") should become a fifth entry here rather than an inline banner — and
`lib/launch-notice.ts:15-24` is the helper that guarantees a `void`ed launch rejection becomes
visible instead of an unhandled rejection.

### 6.5 CodeMirror and Markdown

- **`components/files/Editor.tsx:26-` (CodeMirror 6)** — lazy language loading by filename
  (`LanguageDescription.matchFilename`, `:60`), `oneDark` on dark / default light chrome on light
  (`:29-34`), jump-to-line-and-select support (`:41-56`). Reusable read-only for a code block inside
  a chat message, and reusable editable for an "edit this file before approving" flow.
- **`lib/markdown-preview.ts:31-` (`marked`, GFM, GitHub heading slugs)** — already in the bundle.
  Important caveat: it is written to produce a **complete self-contained document for a sandboxed
  iframe** with zero JS (`:1-10`), i.e. the safety comes from the iframe, not from sanitization.
  Rendering agent-authored Markdown *inline* in the React tree needs a different safety story —
  either a sanitizer or a renderer that emits React nodes rather than an HTML string. **Do not
  `dangerouslySetInnerHTML` the output of `renderMarkdownBody`.**
- `components/todo/todo-markdown.ts` + `hooks/use-todo-doc.ts` are a worked example of a
  daemon-owned text document edited in the UI and synced by `todo.*` events (`store/app.ts:2822-2830`)
  — a useful template if the chat transcript is ever surfaced as an editable artifact.

### 6.6 Upload plumbing

`lib/api-client.ts:929-940` (`uploadSessionFile` — raw octet-stream body, metadata in the query,
byte-level progress callback), `lib/upload-progress.ts` (`BatchProgress`),
`components/ui/upload-progress.tsx` (`UploadProgressBar`), `lib/session-upload.ts:50-97`
(sequential upload preserving order, size-cap skipping against `MAX_UPLOAD_BYTES`). **All reusable
verbatim except the final line** — `api.sendSessionInput(sessionId, injectionForPaths(paths))`
(`:92`) — which a chat composer replaces with a structured attachment.

---

## 7. The browser tab (Design Mode) and PickComposeSheet

### 7.1 A browser tab is a *tab kind*, not a session — and it is the template to copy

`BrowserSummary` (`packages/api/src/index.ts:1293-1309`) lives in its own store slice
`browsers: BrowserSummary[]` (`store/app.ts:618-619`), **never** in `sessions[]`, and has its own
`BrowserStatus = "stopped"|"starting"|"running"|"crashed"|"error"` (`:1291`) distinct from
`SessionStatus`. It is created by `openBrowser` → `POST /api/browsers` (`api-client.ts:976-978`),
reconciled by a dedicated `browser.*` event channel (`store/app.ts:2844-2853`), and closed through
the **same** `closeTab` action as sessions, which trichotomizes by id (`store/app.ts:2448-2478`).

Naming, worth internalizing before touching any of this:

- **`type`** discriminates a *tab* (`ProjectTab.type`, `store/app.ts:440-445`).
- **`kind`** discriminates a *session* (`SessionKind`, `packages/api/src/index.ts:789`) **and,
  separately, a tab context** (`TabContext = {kind:"project"|"workspace"}`, `store/app.ts:450-453`).
- **`ViewMode`** is the orthogonal per-project tabs-vs-grid layout (`lib/view-mode.ts`).

**This is the decisive precedent for the chat design.** A chat session could be modelled either way:

| | As a `SessionSummary` with a new `kind` | As a sibling record (`ChatSummary[]`, like `browsers`) |
|---|---|---|
| Attention Center / `Ctrl+Shift+A` | free (after widening `agent-sessions.ts:333`) | needs a parallel derivation |
| Command palette rows | free (`CommandPalette.tsx:251-267` iterates `sessions`) | needs a second row source |
| Tab strip rename/reorder | free (`reorderSessions` is session-only) | needs new routes |
| Close-confirm | free | needs a branch |
| Risk | every `session.kind === "agent"` site must be audited (13 sites, §1) | zero risk to existing PTY paths |

Given that **every** navigational surface already iterates `sessions` and would need re-plumbing for
a sibling record, the `SessionSummary`-with-a-new-kind route is substantially cheaper — provided the
13 `kind`-sensitive sites in §1 are each dealt with deliberately.

### 7.2 PickComposeSheet — the exact delivery path into an agent

**Capture.** The daemon's in-page picker emits `BrowserPickPayload` (`packages/api/src/index.ts:1322-1357`:
`page{url,title,viewport,viewportMode}`, a `target` with selector / elementPath / classes /
allow-listed attributes / ~16 computed styles / rect / a11y / `reactSource` / `reactComponents` /
`textSnippet` / `htmlSnippet ≤4096`, plus `screenshotBase64` — cropped PNG, ≤2 MB, omitted on
overflow). It arrives as `{t:"picked"}` on the browser channel (`ws-browser-channel.ts:151`) and is
**batched** in `BrowserView.tsx:105`; the sheet mounts while `picks.length > 0` (`:446-457`).

**Compose.** `lib/design-feedback.ts:19-63` `formatDesignFeedback(picks, {comment, intent})` builds
one Markdown block per element and ends with `**Feedback:** <comment>` (`:62`). The screenshot is
referenced **by daemon-side path, not inline bytes** (`:60`, rationale at `:14-17`: "agents like
Claude Code read image paths natively"). The whole string is control-char-stripped at `:63`, for the
reason at `:5-10`: a raw `\x1b[201~` inside hostile page-derived HTML would **end paste mode early
and let the following bytes run as typed keystrokes — a command injection**.

**Deliver** (`components/browser/PickComposeSheet.tsx:52-95`) — two steps:

1. Each screenshot base64 → Blob → `api.uploadSessionFile(targetId, {name, type:"image/png"}, blob, batch.onBytes)`
   (`:78`), **sequentially so path numbering matches pick order** (`:67`), named `design-pick-<n>.png`
   (`:75`). Uploads are memoized in a `WeakMap` keyed per `(payload, targetId)` (`:50`, `:71-82`) so
   a retry after a partial failure doesn't orphan duplicates — and because "a path is only valid for
   the session it was uploaded to".
2. **One PTY write:**
   ```ts
   const markdown = formatDesignFeedback(picks, { comment, intent });        // :87
   await api.sendSessionInput(targetId, `\x1b[200~${markdown}\x1b[201~\r`);  // :88
   ```
   Bracketed paste **plus a trailing `\r` to submit**. Contrast the generic drop/paste path,
   `lib/session-upload.ts:33-37`, which uses the same wrapper but deliberately **omits** the CR
   ("the path is only inserted, never submitted").

**Eligible targets** (`PickComposeSheet.tsx:27-30`): `s.kind === "agent" && s.projectPath === projectPath
&& s.status === "running"`. No per-agent-id allow-list — any registry agent is offered, including
ones with no image support. **Target memory is mount-local and ephemeral**: seeded to `agents[0]?.id`
(`:31`), re-seeded when the current target vanishes (`:32-39`, because the user may pick an element
*before* starting Claude), manually overridable via a `<select>` (`:179-189`). Nothing is persisted —
contrast `preferredAccountByAgent` / `preferredModelByAgent`.

### 7.3 A safe-area bug worth fixing while in the neighbourhood

`apps/web/src/styles.css:33-37` names two files as the by-construction exceptions to "no in-flow
component pads its own inset": `ui/sheet.tsx` and `browser/PickComposeSheet`.

`ui/sheet.tsx` genuinely qualifies — `fixed inset-0` (`:38`, actually `:188` in the current file) and
portalled to `document.body`, i.e. outside the padded box.

**`PickComposeSheet` does not.** It is `absolute inset-x-0 bottom-0` (`:98`) inside
`BrowserView.tsx:402-404`'s `relative … overflow-hidden` wrapper — which is *inside* `#root > *`,
where the inset has already been subtracted. It then pads again:
`pb-[max(0.75rem,env(safe-area-inset-bottom))]` (`:159`). In an installed PWA on a home-indicator
device the inset is counted twice. Because it's `max()` rather than an addition, the effect is a
taller footer (≈34px vs 12px on iPhone) rather than clipping — cosmetic, but it contradicts both
AGENTS.md and the styles.css comment that cites it as a fixed overlay. Two related behaviours: the
wrapper is `overflow-hidden`, so anything that must escape needs a portal; and when DevTools goes
fullscreen on mobile the wrapper gets `hidden` (`BrowserView.tsx:403`) — the pending pick sheet
vanishes while the batch state survives in `BrowserView`.

### 7.4 What changes if the target is a chat session

1. **The framing is hardcoded PTY escapes** (`:88`). A chat session would receive `\x1b[200~` as
   literal text. This needs a `deliverDesignFeedback(api, session, picks, opts)` seam branching on
   PTY-vs-chat.
2. **There is no structured input route.** `sendSessionInput` is byte-stream only
   (`api-client.ts:915-921`), and the daemon pipes it straight to the PTY. A chat agent needs a new
   verb (`POST /api/sessions/:id/message` with `{text, attachments[]}`) plus an explicit "submit"
   concept replacing the trailing `\r`.
3. **No discriminant exists to branch on** — `SessionKind` is only `"shell"|"agent"`, and
   `MainView` renders `TerminalView` for *every* `type:"session"` tab. Also, `status === "running"`
   is a process notion a chat session may not express identically.
4. **Screenshot delivery changes shape.** The client already holds `screenshotBase64` (`:60`), and
   the ≤2 MB cap makes an inline attachment viable — which would make the whole
   `uploadSessionFile` round-trip, the `design-pick-N.png` naming, the sequential-ordering
   constraint, the `BatchProgress` UI and the `(payload,targetId)` cache dead code on the chat path.
5. **The control-byte strip loses its purpose but keep it as hygiene** — with a structured
   transport the paste-mode-escape injection vector disappears, but `design-feedback.ts:5-10`'s
   comment would need rewording rather than the code being deleted.
6. **Natural refactor:** split `formatDesignFeedback` into a data-builder plus a Markdown renderer.
   It is the only consumer of `BrowserPickPayload` outside `BrowserView`, so a chat agent could take
   the same data as typed fields while the Markdown string survives as the PTY fallback.
7. **Unaffected:** `/ws-browser` streaming and picking, batch accumulation, the `ProjectTab`
   `type:"browser"` model, and the daemon browser CRUD routes. The identically-shaped sibling that
   needs the same treatment is `lib/session-upload.ts:92`.

---

## 8. Usage overview and per-session usage

### 8.1 There is no per-session usage, and no join key to build one

Usage has exactly three dimensions — **agent, account, window** — and none of them reference a
session. `AgentUsage` (`packages/api/src/index.ts:668-694`), `UsageAccount` (`:655-666`),
`USAGE_AGENT_IDS = ["claude","codex","grok"]` (`components/topbar/usage-format.ts:9`).

**Naming trap:** `AgentUsage.session` is **not** an Orquester session — it is the provider's rolling
5-hour quota window, rendered as `label: "5h", longLabel: "Session (5h)"` (`usage-format.ts:172-177`).

Cost rows are aggregated on `` `${r.agent}|${r.model}|${r.day}` `` (`apps/daemon/src/usage-tokens.ts:82`),
which **deliberately discards the transcript file the rows came from** — even though the scanner
reads and caches per-file (`:107-125`, `:257`, `:365-383`).

Confirming the negative on the session side: `SessionSummary` carries no conversation id and no token
counters; `resumeConversationId` exists only on `CreateSessionRequest`
(`packages/api/src/index.ts:1212-1217`) and is consumed into launch args at spawn
(`apps/daemon/src/sessions.ts:399`, `:945`), never persisted onto the summary. **So today, given a
live tab, the daemon cannot say which transcript it is writing.**

### 8.2 Data path

| | Windows (quota bars) | Cost (tokens) |
|---|---|---|
| Route | `GET /api/usage?refresh=1` (`apps/daemon/src/index.ts:3418-3420`) | `GET /api/usage/tokens?refresh=1` (`:3422-3425`) |
| api-client | `getUsage()` (`lib/api-client.ts:707`) | `getUsageTokens()` (`:711`) |
| Store action / field | `loadUsage` (`store/app.ts:2098-2108`, called on connect at `:1151`) → `usage` (`:585`) | `loadUsageTokens` (`:2110-2120`) → `usageTokens` (`:586`) |
| Live push | **yes** — `usage.changed` on `/events`, applied wholesale (`store/app.ts:2799-2801`) | **no** — fetched lazily when the Cost tab first opens (`UsageWidget.tsx:307-309`) |

Daemon side: `UsageService` polls every 5 min and emits only when the serialized blob changes
(`apps/daemon/src/usage.ts:38-58`, `:70-77`); `UsageTokensScanner` watches transcript roots with a
leading+trailing 30 s throttle (`usage-tokens.ts:294-312`). Cost is an **API-equivalent estimate**
from a hardcoded price table (`MODEL_PRICING`, `:8-23`), labelled as such in the UI
(`UsageWidget.tsx:174-177`).

### 8.3 What a chat session would need

1. **A session↔conversation join key.** It is *computable* today — `agent-conversations.ts:232`
   derives a Claude conversation id as the transcript basename minus `.jsonl`, i.e. the session UUID
   — but never stored. Either persist it on the session record, or have the agent hook report it:
   `POST /api/sessions/:id/agent-event` already carries a free-form `payload?: unknown`
   (`packages/api/src/index.ts:976-980`).
2. **A conversation dimension in `aggregateRows`.** The per-file rows already exist in `fileCache`;
   this is an aggregation-key change plus a wire-shape addition to `UsageTokenRow` (`:705-721`), not
   new parsing.
3. **A live per-turn counter.** Nothing streams token deltas today (30 s floor, 5 s debounce, all
   filesystem-polled). A "this turn cost $X" readout needs a new push path — a `session.tokens`
   event, or an extension of `session.activity`.
4. **A context-window readout.** Does not exist. `UsageWindow` is quota-only, and context-window
   sizes live in the cliproxy router-provider model config (`contextWindow`/`compactWindow`), not in
   usage.
5. **Reusable as-is:** the pure presentation helpers `normalizeUsageWindows`,
   `formatUsageCapacity`, `compactCount`, `barClass`/`gaugeClass`, `formatCost`/`labelForModel`
   (`UsageWidget.tsx:12-37`), and the device-local display prefs + shared 60 s ticker
   (`lib/usage-display.ts:18`, `:84-121`, consumed via `hooks/use-usage-display.ts`).

---

## 9. PWA push notifications

### 9.1 The trigger is 100% daemon-side; the client only subscribes

`lib/push.ts` has no trigger logic — only `pushSupported()` (`:15-23`), `enablePush()` (`:58-91`),
`disablePush()` (`:97-105`). The subscription's existence **is** the preference (`:10-12`). The only
UI is `PushNotificationsField` (`components/settings/SettingsModal.tsx:1187-1270`), mounted only when
`runtime === "web" && pushSupported()` (`:1017`). SW registration is web-host-only and PROD-gated
(`apps/web/src/pwa.ts:5-13`). **The store has zero push state**, and there is no `new Notification(...)`
anywhere in `packages/ui` or `apps/desktop`.

### 9.2 Trigger policy — already generic, with the bell strictly as a fallback

`apps/daemon/src/index.ts:639-668`:

```ts
sessions.lifecycle.on("activity", (event) => {
  broadcaster.publish("sessions", "session.activity", { id, activity });
  if (event.kind !== "agent") return;
  if (event.cause === "hook" && event.activity.attention === "needs-input") push.notifyStructural(summary, "needs-input");
  else if (event.cause === "hook" && event.activity.attention === "finished")  push.notifyStructural(summary, "finished");
  else if (event.cause === "bell" && !event.hasHookSource)                     push.notifyAttention(summary);
});
```

- **Structural** (generic): cause `"hook"`, from managed agent hooks hitting the unix-socket-only
  `POST /api/sessions/:id/agent-event` (`index.ts:3776-3798`).
- **PTY-specific bell**: cause `"bell"`, from ANSI BEL scanning
  (`apps/daemon/src/ansi-activity.ts:41-118`, with an echo-grace suppression at `:255`), fired **only**
  when the session has never delivered a hook event (`hasHookSource`, `sessions.ts:355`, `:806`, `:1003`).
- Non-agent sessions never push; process exit deliberately does not push (`ansi-activity.ts:341-343`).
- Debounce: 30 s per `` `${session.id}:${type}` `` (`apps/daemon/src/push.ts:16`, `:173-185`).

**Implication for chat: a chat-style agent that reports hooks gets correct "needs your input" /
"finished" pushes for free**, and the whole PTY bell-sniffing path becomes dead weight for it. Note
the `kind !== "agent"` early-return would need widening for a new chat kind.

### 9.3 Payload, and what the SW shows

`apps/daemon/src/push.ts:196-212` builds `{ title: "<tabTitle> in <project> <verb>", body: "",
tag: "session-<id>", sessionId }`, where `verb` ∈ "needs your attention" (bell) / "needs your input"
/ "finished". Delivery fans out to **every** stored subscription with 404/410 pruning (`:228-262`) —
**no per-device targeting and no "is this device already looking at that tab" suppression**.

`apps/web/public/sw.js:205-223` shows `{body: "", tag, icon:"/icon-192.png", badge:"/icon-192.png",
data:{sessionId}}`. Body is always empty; everything is in the title. The `tag` means repeat
notifications for one session collapse onto each other.

### 9.4 The session id travels but is never used — clicking a push does NOT navigate to the tab

`sw.js:225-243`: `notificationclick` closes the notification, then `clients.matchAll(...)` and
**`client.focus()`** on the first window, or `openWindow("/")`. There is no `client.navigate()`, no
`postMessage` to the page, and no page-side `message` listener anywhere in `packages/ui`.
`data.sessionId` is stored and ignored.

A deep-link would need: a URL/route for a session (none exists — `site.webmanifest`'s `start_url` is
`/`), plus either `client.navigate(url)` or a `postMessage` → store bridge. **The focus helper
already exists**: `focusAgentSession` (`components/attention/agent-sessions.ts:413-415`, used by
`GlobalShortcutListener.tsx:140` and `OpenedAgents.tsx:37`) — it takes an `AgentSessionEntry` and
calls `jumpToProject`. This is a genuinely small, high-value gap worth closing alongside a chat UI,
since a chat notification is far more likely to be actioned from the lock screen than a terminal bell.

SW hygiene: `BYPASS_PREFIXES` (`sw.js:25`, enforced at `:187`) must never intercept `/api`,
`/events`, `/ws`, `/health`, `/mcp`, `/devtools-frontend`, `/ws-devtools`; **a new chat WS/stream
path must be added to that list**, and `VERSION` (`:16`, currently `"v5"`) bumped when it or
`SHELL_PRECACHE` (`:31`) changes.

---

## 10. Desktop bridging: chunked HTTP vs `/ws`

### 10.1 Three paths, not two

`apps/desktop/src/renderer.tsx:8-27` constructs both transports up front and passes them into
`OrquesterApp`.

| Path | Transporter | Session output | Input/resize |
|---|---|---|---|
| desktop → local daemon | `UnixSocketTransporter` (`kind = "unix"`) | chunked `GET /api/sessions/:id/output` **over IPC** | REST `POST …/input`, `…/resize` |
| desktop → remote VPS | `HttpTransporter` + `NodeHttpClient` | **`/ws`, opened directly in the renderer** | WS frames |
| web | `HttpTransporter` + `FetchHttpClient` | `/ws` | WS frames |

The branch is `this.channel = transporter.sessionChannel?.() ?? null` (`api-client.ts:142`), then the
ternaries at `:917-920`, `:942-948`, `:961-965`. Only unary requests and `openStream` need the Node
detour (for CORS); a cross-origin WS handshake is not CORS-gated, so desktop-remote terminals use a
real renderer-side `WebSocket`. Daemon side of the chunked path: `GET /api/sessions/:id/output`
hijacks the reply, writes scrollback, then subscribes (`apps/daemon/src/index.ts:3871-3907`), with
`content-type: application/octet-stream` and `x-accel-buffering: no`.

### 10.2 IPC framing: UTF-8 strings and ArrayBuffers, never Blobs

Preload exposes six stream primitives (`apps/desktop/src/preload.cjs:14-54`: `streamOpen`,
`streamClose`, `onStreamData`, `onStreamEnd`, plus the `orquester:http-stream:*` mirror for remote).
Main process at `apps/desktop/src/main.ts:366-397` (socket) and `:476-512` (remote).

Facts that constrain a structured stream:

- **Chunks are UTF-8 strings** — `res.setEncoding("utf8")` in the main process, so Node's
  `StringDecoder` guarantees multi-byte codepoints are never split across IPC messages. But **chunk
  boundaries are arbitrary and carry no message semantics**.
- **No backpressure.** `event.sender.send` is fire-and-forget: no pause/resume, no ack, no queue cap.
  A fast producer floods the renderer.
- **Fan-out is by `streamId` filtering in the renderer** (`unix-socket-transporter.ts:164-176`) —
  every listener sees every stream's chunks and discards non-matching ids, so N streams cost O(N) JS
  callbacks per chunk.
- **Binary is unary-only** — `requestBytes` buffers the whole body then `toArrayBuffer`
  (`main.ts:333-364`). There is **no binary streaming channel**.
- **Blobs do not cross IPC**, confirmed at `unix-socket-transporter.ts:11-28`: "Electron's structured
  clone carries ArrayBuffers but not Blobs, so a File is read into memory first (the desktop pays
  ~2× the file size across the two processes; the web client streams it)".
- Cancellation: unary via a renderer-minted `requestId` gated by `senderId` (`main.ts:261-279`);
  streams via `streamClose` → `req.destroy()` (`:514-520`).

### 10.3 Does the desktop bridge support `/events` NDJSON? Yes — it already does

This is the single most useful finding for the transport decision. **`/events` already rides this
bridge on both desktop transports, and it is already NDJSON.**

- Daemon: `GET /events` hijacks, writes `content-type: application/x-ndjson`, one JSON object + `\n`
  per event, plus a 15 s `daemon.heartbeat` (`apps/daemon/src/index.ts:3987-4055`).
- Client: `ApiClient.openEvents` (`api-client.ts:197-229`) does its own newline reassembly across
  arbitrary chunk boundaries and silently drops malformed lines.
- Desktop-local: `UnixSocketTransporter.openStream` → `orquester:stream:*`.
- Desktop-remote: `HttpTransporter.openStream` detects the injected Node client and routes through it
  rather than `fetch`, specifically to dodge CORS (`http-transporter.ts:466-474`).

So a structured agent-event stream can reuse the bridge verbatim, subject to:

1. **Frame as NDJSON and reassemble client-side.** The bridge guarantees byte order and UTF-8
   integrity but **not** message boundaries. Copy the `openEvents` buffering loop; never assume one
   chunk = one message.
2. **Prefer the existing `/events` bus over a new per-session stream** for lifecycle. On
   desktop-local a separate `openStream` per session is fine (no connection cap over a unix socket —
   which is precisely why `sessionChannel` is omitted there), but on web/desktop-remote a
   per-session HTTP stream reintroduces the ~6-connection cap that `/ws` was built to solve. The
   web-side precedent for per-session structured data is a new `t:` verb on `/ws`, with a
   desktop-local fallback — the same dual-path shape `openSessionOutput` already has.
3. **Text only.** Binary must be base64'd into the JSON or go through the unary
   `requestBytes`/upload path.
4. **No flow control** — a chatty structured stream needs daemon-side rate limiting. The precedent is
   `UsageTokensScanner.requestRecompute`'s leading+trailing throttle (`usage-tokens.ts:294-312`).
5. **Socket-only ingress stays socket-only.** `POST /api/sessions/:id/agent-event` is registered
   under `if (options.mode === "local")` (`index.ts:3785-3798`) — deliberately unreachable over HTTP.

---

## 11. Consolidated verdict and the shortest credible path

### 11.1 The three things that are genuinely hard

1. **A second message family on the wire, with a desktop-local fallback.** `StreamHandlers` is
   text-only by contract, so a structured channel needs a new handler interface, and
   `SessionChannel`'s absence on the unix socket means every chat feature needs an
   `openStream`+NDJSON path too. The `/events` reframing loop is the template; `WsBrowserChannel` is
   the architectural precedent.
2. **A daemon-owned transcript with replay semantics that don't duplicate.** The PTY path solves this
   with `onReset()` + full buffer replay (`ws-session-channel.ts:122` → `TerminalView.tsx:636-639`).
   A transcript wants a cursor/`since` parameter instead — strictly better, with no PTY analogue to
   copy.
3. **Delivery guarantees for a user turn.** `sendSessionInput` resolves immediately and silently
   drops frames while offline (`ws-session-channel.ts:204-210`) — correct for a keystroke, wrong for
   a chat message. Sends must be ack'd REST or queue-and-retry.

### 11.2 The things that are nearly free

- The whole tab system: `ProjectTab` union, `useProjectTabs`, `MainView` dispatch, `TabStrip`,
  `TabSwitcher`, grid layout, close-confirm, rename, reorder.
- Activity, attention, status dots, the Attention Center, `Ctrl+Shift+A`, the command palette — all
  already driven by the daemon's `SessionActivity`, which a protocol-driven agent reports *better*
  than a PTY does.
- Push notifications, for any agent reporting hooks.
- Theming (Tailwind neutral + semantic scales), toasts, modals, sheets, `ConfirmDialog` (with its
  typed-name gate, ideal for destructive approvals), `DiffView` (drop-in for proposed edits),
  CodeMirror, the upload pipeline minus its final escape-wrapped write.

### 11.3 Concrete change list, smallest first

| Change | File:line | Why |
|---|---|---|
| Widen the agent filter | `components/attention/agent-sessions.ts:333` | else chat sessions vanish from the sidebar, badge and cycle shortcut |
| Widen the push kind gate | `apps/daemon/src/index.ts:~642` | else chat sessions never push |
| Guard MobileKeyBar on kind | `components/terminal/MobileKeyBar.tsx:113` | else a byte-level key bar renders under a chat composer |
| Add a `MainView` dispatch arm | `components/main/MainView.tsx:304-318` (+ `cellIcon` `:28-40`) | the new renderer |
| Add the `ProjectTab` arm | `store/app.ts:440-445` | the discriminant |
| Decide the `SHORTCUT_BAIL_SELECTOR` stance | `lib/session-nav.ts:151` | Ctrl/Cmd+K over a composer |
| Add the SW bypass prefix + bump `VERSION` | `apps/web/public/sw.js:16,25` | else the SW may cache/fallback the chat stream |
| Convert `openTab` to an options object | `store/app.ts:836-844, 2273` (+ 5 call sites) | 7 positional args is at its limit |
| Widen PickComposeSheet eligibility + add a delivery seam | `components/browser/PickComposeSheet.tsx:27-30, 88` | structured payload instead of a bracketed paste |
| Fix the double safe-area pad | `components/browser/PickComposeSheet.tsx:159` | contradicts the documented one-owner rule |
| Add `client.navigate`/`postMessage` on notification click | `apps/web/public/sw.js:225-243` | `sessionId` is already in the payload and thrown away |
| Persist the conversation id on the session record | `packages/api/src/index.ts:1161-1195` + daemon | the missing join key for per-conversation cost |

