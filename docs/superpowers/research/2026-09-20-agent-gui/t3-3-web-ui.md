# T3 Code — Web Client UI for Agent Threads

Scope: `apps/web/src/**`, `packages/client-runtime/**` (React-facing parts), `apps/desktop` only as a
wrapper. Written for a team building a chat-style agent GUI on React 18 + zustand + Tailwind.

All paths are relative to the t3code repo root unless noted.

---

## 1. Tech stack

From `apps/web/package.json` (version `0.0.42`) and the pnpm catalog in `pnpm-workspace.yaml`:

| Concern | Choice | Version | Notes |
|---|---|---|---|
| Framework | React | `19.2.6` (`apps/web/package.json:60`) | React 19 `use()` hook used for context + promises |
| Compiler | `babel-plugin-react-compiler` | `1.0.0` | wired in `apps/web/vite.config.ts:175-182` via `@rolldown/plugin-babel` + `reactCompilerPreset()` — auto-memoization is a load-bearing perf lever |
| Router | `@tanstack/react-router` | `^1.160.2` | file-based routes, `autoCodeSplitting: true` (`apps/web/vite.config.ts:173`) |
| Bundler | Vite (`@voidzero-dev/vite-plus-core`) | `0.3.0` | |
| State (domain) | `@effect/atom-react` + `effect` Atom | `4.0.0-rc.115` | 85 files in `apps/web/src` import `@effect/atom` |
| State (local UI) | `zustand` | `^5.0.11` | 19 files; used for *client-local* stores only (drafts, right panel, UI toggles) |
| Styling | Tailwind CSS | `4.3.3` | v4, CSS-first config; `class-variance-authority` + `tailwind-merge` (`apps/web/src/lib/utils.ts:7`) |
| Headless UI primitives | `@base-ui/react` | `^1.4.1` | shadcn-shaped `components/ui/*` but on Base UI, not Radix (28 of the ui files import it). See `apps/web/src/components/ui/button.tsx:3-5` |
| Virtualization | `@legendapp/list` | `3.3.5` | `LegendList` — the same list used by the React Native app |
| Markdown | `react-markdown` `^10.1.0` + `remark-gfm` `^4.0.1` + `remark-breaks` + `rehype-raw` + `rehype-sanitize` | | plugin set at `apps/web/src/components/ChatMarkdown.tsx:489-511` |
| Code highlighting | Shiki via `@pierre/diffs` `getSharedHighlighter` | `1.3.0-beta.10` | forced to the **Oniguruma WASM engine** (`apps/web/src/lib/syntaxHighlighting.ts:16`) because the JS regex engine can catastrophically backtrack and hang tokenization |
| Diff viewer | `@pierre/diffs` (`FileDiff` react component + worker pool) | `1.3.0-beta.10` | `apps/web/src/components/DiffWorkerPoolProvider.tsx:1-3` |
| File tree | `@pierre/trees` | `1.0.0-beta.4` | |
| Icons | `lucide-react` | `^0.564.0` | plus hand-rolled `Icons.tsx`, `JetBrainsIcons.tsx`, brand SVGs |
| Composer editor | **Tiptap 3** (ProseMirror) | `^3.31.3` | `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`, task-list extensions |
| Drag & drop | `@dnd-kit/*` | core `^6.3.1` | thread-list reordering |
| Animation | `@formkit/auto-animate` | `^0.9.0` | |
| Misc | `heic-to` (HEIC→JPEG), `jszip`, `jsonc-parser`, `culori` (theme color math), `jose`, `@clerk/react` (cloud auth), `@tanstack/react-pacer` (debounce/throttle) | | |

Notable absences: no Radix, no Framer Motion (transitions are CSS + View Transitions), no
TanStack Query (Effect Atom does that job), no Redux.

> **Caveat on docs.** `docs/internals/composer-context-references.md:112` calls
> `ComposerContextReferenceNode` "the one inline **Lexical** node". That is stale — the app is
> Tiptap-only. `apps/web/src/components/ComposerPromptEditor.tsx:10-17` is explicit: *"Tiptap in
> both modes: the `richTextEnabled` setting toggles Markdown styling, never the engine."*

---

## 2. Component architecture of the thread view

### 2.1 Route → page

```
routes/__root.tsx
└── routes/_chat.tsx                         (chat layout: sidebar + inset + right panel)
    ├── routes/_chat.index.tsx               ("/" — no active thread)
    ├── routes/_chat.draft.$draftId.tsx      (client-only draft thread)
    ├── routes/_chat.$environmentId.$threadId.tsx   (server thread)
    └── routes/_chat.pull-requests.tsx
```

Both leaf thread routes render `component: () => null` (`routes/_chat.$environmentId.$threadId.tsx:5-7`).
The actual view is mounted by the **layout** route so that promoting a draft to a server thread
swaps the URL without remounting:

- `components/ThreadRouteView.tsx:47` is the single chat surface behind `/draft/$draftId` and
  `/$environmentId/$threadId`.
- It latches a `chatViewKey` (`ThreadRouteView.tsx:95-107`) so the React element that carried the
  draft keeps its identity across the route swap — "the route swap only changes props and the
  timeline never paints an empty frame" (`ThreadRouteView.tsx:34-46`).
- Plain server threads are rendered **unkeyed** so navigating between threads reuses one `ChatView`
  instance (`ThreadRouteView.tsx:197-207`).

### 2.2 ChatView — the orchestrator

`components/ChatView.tsx` is one ~8,300-line function component (`ChatView.tsx:1465`). Its render
tree (`ChatView.tsx:9757-10472`):

```
<div relative flex>                                    ChatView root
 ├ WorkspacePageHeader > ChatHeader                    9791-9832 (title, project, scripts, open-in)
 ├ chat column (drop target for files)                 9837-9844
 │  ├ absolute banner overlay (does not change timeline height)   9860-9875
 │  │   ├ ProviderStatusBanner
 │  │   └ ThreadErrorBanner
 │  ├ <MessagesTimeline …/>                            9878-9961
 │  ├ "Scroll to end" pill (absolute, bottom)          9964-9985
 │  └ composer overlay (absolute inset-0 hero  |  absolute bottom docked)  9988-10231
 │        └ ComposerSurface.Shell
 │             ├ ComposerSurface.Host > <ChatComposer …/>       10037-10170
 │             └ <BranchToolbar …/>  (context strip)            10180-10218
 ├ PersistentThreadTerminalDrawer (per mounted thread) 10293-10310
 ├ RightPanelTabs (inline)  |  RightPanelSheet > RightPanelTabs (mobile)  10313-10417
 └ dialogs: device setup, branch-switch confirm, PullRequestThreadDialog,
            "Edit from here?" revert AlertDialog (10419-10461), ExpandedImageDialog
```

Two structural decisions worth copying:

1. **The composer is an absolutely positioned overlay over the timeline**, not a flex sibling
   (`ChatView.tsx:9988-9994`). Its height is published back to the list as
   `contentInsetEndAdjustment` (`ChatView.tsx:9941`) so the list reserves bottom space instead of
   the layout reflowing when the composer grows. The same overlay becomes a **centered hero** when
   the thread has no messages (`isDraftHeroState`), and a View Transition animates the hero→docked
   move (`ChatView.tsx:10020-10027`, `components/chat/draftHeroTransition.ts`).
2. **Banners overlay the timeline** rather than pushing it (`ChatView.tsx:9860`, comment: *"Banners
   overlay the timeline without changing its content height."*).

### 2.3 The normalized item model

There are **three** projections, each incremental (see §3):

**Layer 1 — `TimelineEntry`** (`session-logic.ts:134-152`). Only three kinds:

```ts
{ kind: "message",       message: ChatMessage }   // role: user | assistant | system | reasoning
{ kind: "proposed-plan", proposedPlan: ProposedPlan }
{ kind: "work",          entry: WorkLogEntry }
```

`WorkLogEntry` (`session-logic.ts:56-95`) is the single normalized shape for *everything an agent
did*: tool calls, commands, file changes, approvals, question answers, subagent spawns, runtime
errors. Its discriminators are `tone: "thinking" | "tool" | "info" | "error"`, `itemType`,
`toolLifecycleStatus`, `sourceActivityKind` (the raw orchestration activity kind), plus optional
`command`/`rawCommand`/`changedFiles`/`toolData`/`questionAnswer`/`agentSpawn`.

**Layer 2 — `MessagesTimelineRow`** (`components/chat/MessagesTimeline.logic.ts:329-442`), 12 kinds:
`activity-group`, `work`, `work-live`, `work-toggle`, `turn-fold`, `context-compaction`, `message`,
`assistant-meta`, `proposed-plan`, `working`, `thinking`, `worktree-setup`, `queued-message`.

**Layer 3 — stable rows** (`useStableRows`, `MessagesTimeline.tsx:4157`): preserves per-row object
identity when a row's fields are unchanged.

### 2.4 Row renderers

Dispatch is a flat chain of `row.kind === … ? <X/> : null` inside a memoized
`TimelineRowContent` (`MessagesTimeline.tsx:1663-1731`), which also owns *all* the vertical rhythm
(`pb-1` / `pb-2` / `pb-4` per kind) and stamps `data-timeline-row-kind` / `data-message-id`
attributes used by selection, citation and test code.

| Normalized item | Component | Renders | Interactions |
|---|---|---|---|
| **User message** | `UserTimelineRow` (`MessagesTimeline.tsx:1934`) | right-aligned bubble (`max-w-[80%]`), image thumbnails, video players, un-chipped file rows, `CollapsibleUserMessageBody` markdown with inline context chips | hover-revealed footer with timestamp tooltip, **copy** (`MessageCopyButton`, writes canonical Markdown + a structured `application/x-t3-context-fragment+json` clipboard flavor, `:2287-2305`), **"Edit from here"** revert (`RevertUserMessageButton`, `:2267`), file preview/download buttons, chip activation opens details popovers/media modal |
| **Assistant text** | `AssistantTimelineRow` (`:2360`) | `"T3 Code"` author heading, `<ChatMarkdown>`, then `AssistantChangedFilesSection`, then `AssistantMessageMeta` | text selection → `AssistantSelectionToolbar` "Cite in composer" (`:1272-1278`); hover reveals copy button + timestamp (`AssistantMessageMeta:2424`, `opacity-0 … group-hover/assistant:opacity-100`) |
| **Assistant meta (split row)** | `AssistantMetaTimelineRow` (`:2406`) | copy + timestamp as its own row when the meta must not be inside the message row | same |
| **Reasoning** | `ReasoningTimelineRow` (`:2814`) / `ReasoningTraceBlock` (`:2721`) | collapsed by default, brain icon, header reads "Thinking" (live, shimmering) or "Thought"; collapsed header shows a one-line Markdown *preview* of the thought via a custom `remarkThoughtPreview` plugin (`:2695`); expanded body is `max-h-96 overflow-auto` markdown | click to expand/collapse; **expansion state lives on the list** (`expandedReasoningMessageIds` in `TimelineRowCtx`) "so it survives row recycling in the virtualizer" (`:2809-2813`) |
| **Tool call / command / file change (collapsed group)** | `WorkGroupSection` → `SimpleWorkEntryRow` → `PlainWorkEntryRow` (`:4812`) | one 24px line: tool icon (tinted by tone/failure), `previewText` (from `resolveWorkEntryToolPresentation` / command / changed file), optional answer preview, hover timestamp, chevron | click or Enter/Space expands an inline `<pre>` body built by `buildToolCallExpandedBody` (`:4498`) — MCP call JSON, raw command, detail, changed-file list, viewed image (`ChatMarkdownAssetImage`), or `QuestionAnswerHistory` |
| **Activity group** (the headline idea) | `ActivityGroupTimelineRow` (`:2586`) | **one collapsed line summarizing an entire run of reasoning + tool calls**. Live: the current tool's present-tense label ("Running pnpm", "Thinking") with a shimmer. Settled: `summarizeToolGroup(work)` → "Read 3 files, ran 2 commands, and used Linear integration" (`packages/client-runtime/src/work-log/presentation.ts:598-637`) | click toggles; expanded renders interleaved `WorkGroupSection`s and `ReasoningTraceBlock`s |
| **Work group toggle** | `WorkGroupToggleTimelineRow` (`:3320`) | "+N more" header with summary + failure flag | expand/collapse |
| **Live work entry** | `LiveWorkEntryTimelineRow` (`:3232`) / `LiveActivityRow` (`:3140`) | the single active tool row with `ActivityShimmerOverlay` (`:3116`) | |
| **File change / diff** | `AssistantChangedFilesSection` (`:3352`) → `ChangedFilesCard` (`components/chat/ChangedFilesTree.tsx:28`) | a per-turn card rendered *inside the assistant message*: "N changed files", `DiffStatLabel` (+/-), a collapsible directory tree with per-file stats and Pierre file-type icons | click a file → `onOpenTurnDiff(turnId, filePath)` opens the right-panel diff at that file; expand/collapse-all toggle persisted per thread+turn in `uiStateStore` (`:3394-3398`); right-click → OS file context menu |
| **Approval request** | **not a timeline row** — see §5 | | |
| **Question / form** | **not a timeline row while pending** — see §5. Once answered, folds into a `work` row whose `questionAnswer` expands to `QuestionAnswerHistory` (`:5028`) | | expand to read the full Q&A |
| **Error** | tone `"error"` work rows get destructive styling only for *severe* failures (`workEntrySignalsSevereFailure`, `session-logic.ts:165`: `runtime.error` or any `*.failed` activity); routine non-zero exits get a muted ✗. Thread-level errors go to the overlay `ThreadErrorBanner` (`components/chat/ThreadErrorBanner.tsx:36`) | | banner: 3-line clamp + full tooltip + dismiss, dismissal remembered per `threadKey\0message` for the session (`:19-34`) |
| **Usage / context window** | `ContextWindowMeter` (`components/chat/ContextWindowMeter.tsx:18`) lives in the composer footer, not the timeline: an SVG ring, red above 90% | hover popover with token counts + a **Compact** button |
| **Proposed plan** | `ProposedPlanTimelineRow` (`:2490`) → `ProposedPlanCard` | collapsed plan markdown preview | expand, copy, save to workspace file, "implement in new thread" |
| **Working / thinking / compacting** | `WorkingTimelineRow` (`:2510`), `ThinkingTimelineRow` (`:2683`) | one span for every label "so the setup-to-working handoff swaps text in place instead of remounting the row" (`:2513`); `WorkingTimer` (`:2890`) ticks elapsed time | |
| **Turn fold** | `TurnFoldTimelineRow` (`:2335`) | a collapsed older turn behind a separator line | expand |
| **Context compaction** | `ContextCompactionTimelineRow` (`:1860`) | a `role="separator"` hairline with a label | none |
| **Queued message** | `QueuedMessageTimelineRow` (`:1759`) | **dashed-border ghost bubble** at the end of the list with a "Queued" clock chip and a tooltip explaining when it will go ("Sends after the next tool call or when the turn ends") | ↑ **Send now** (with its keybinding label in the tooltip), ✗ **Cancel and return to the composer** |
| **Worktree setup** | `WorktreeSetupTimelineRow` (`:1733`) | bootstrap stage list; `embedded` variant drops its own header once the agent takes over | cancel, work locally, open setup terminal |
| **Subagent spawn** | `AgentSpawnRow` (`:4595`) / `AgentSpawnMemberRow` (`:4678`) | "Kicked off N subagents", live status derived from the agent panel model at render time | expand members, "Open Agents" → right panel `AgentsPanel` |

### 2.5 Prop plumbing: one context, not prop drilling

`MessagesTimeline` passes **nothing** through `renderItem`. `renderItem` is a zero-dep `useCallback`
(`MessagesTimeline.tsx:1242-1249`) and every row reads shared state from two React contexts:

- `TimelineRowCtx` (`:274-308`) — callbacks, theme, workspace root, disclosure sets, timestamp format.
- `TimelineRowActivityCtx` (`:310-323`) — `isWorking`, `latestTurnId`, `unsettledTurnId`, etc.

The comment at `:267-272` states the rule explicitly: *"`nowIso` is intentionally excluded —
self-ticking components (WorkingTimer, LiveElapsed) handle it."* That is, anything that changes
every second is pulled into a leaf component instead of being pushed down the tree.

---

## 3. Streaming rendering & long-thread performance

This is the most transferable part of the codebase. Six distinct mechanisms stack:

### 3.1 The wire is a delta append

`thread.message-sent` arrives repeatedly for the same `messageId`. The client reducer *appends*
while `streaming: true` and *replaces* on the final frame
(`packages/client-runtime/src/state/threadReducer.ts:394-411`):

```ts
text: message.streaming ? `${entry.text}${message.text}` : (message.text.length > 0 ? message.text : entry.text)
```

### 3.2 Three incremental projections, each with a fast path

**Entries** — `deriveTimelineEntriesWithState` (`session-logic.ts:1654`): if only message text
changed, it calls `replaceStreamingTimelineMessages` and reuses the entry array shape; otherwise if
the new arrays are strict *prefix extensions* of the old ones (`hasExactArrayPrefix`), it appends
only the new tail and sorts that suffix. Full rebuild is the last resort. Called from
`ChatView.tsx:3525-3541` with a `useRef`-held previous projection keyed by thread.

**Rows** — `deriveMessagesTimelineRowsWithState` (`MessagesTimeline.logic.ts:1544`) →
`replaceStreamingMessageRows` (`:1477`). It bails to a full rebuild unless *everything else is
shallow-equal* and the only entry differences are `isStreamingMessageTextUpdate`; then it maps rows
and swaps only the `message` object on the affected rows. Wired at `MessagesTimeline.tsx:774-813`.

**Stable rows** — `computeStableMessagesTimelineRows` (`MessagesTimeline.logic.ts:1556`) with a
hand-written per-variant shallow comparator `isRowUnchanged` (`:1577-1675`). Unchanged rows keep
their *previous object reference*, so `memo`'d row components never re-render. If nothing changed at
all it returns the previous state object, so the array identity is stable too.

Net effect: a streaming token touches exactly one row object out of N.

### 3.3 Virtualization: LegendList, with recycling deliberately OFF on the main list

`MessagesTimeline.tsx:1279-1332`:

```
<LegendList<MessagesTimelineRow>
  data={rows}
  extraData={`${listIdentityKey}:${rows.length}`}
  keyExtractor={item => item.id}                 // :1354
  getItemType={item => item.kind === "message" ? `message:${item.message.role}` : item.kind}  // :1358
  estimatedItemSize={90}
  maintainScrollAtEnd={…}
  maintainVisibleContentPosition={…}
  maintainScrollAtEndThreshold={1}
  className="… [overflow-anchor:none] …"
/>
```

- `getItemType` gives the virtualizer per-kind pools; user/assistant/reasoning are separate types.
- **No `recycleItems`** on the main list — row DOM is not reused, which is why per-row local state
  (like `PlainWorkEntryRow`'s `expanded`) is safe there, while reasoning/work-group expansion state
  is hoisted to the list *because* it must survive across thread switches and the nested list.
- `[overflow-anchor:none]` disables the browser's own scroll anchoring so LegendList owns it.
- The **nested** list for expanded tool output (`:3078-3109`) *does* set `recycleItems` and
  `drawDistance={240}`, `estimatedItemSize={24}` — a second virtualized list inside a row,
  capped at `max-h-[min(18rem,50dvh)]`, with its own scroll-position memory keyed by group
  (`resolveWorkGroupScrollAnchor`, `packages/client-runtime/src/work-log/scrollAnchor.ts`).

### 3.4 Autoscroll / live follow / "Scroll to end"

Three named scroll modes (`components/chat/timelineScrollAnchoring.ts:6`):
`"following-end" | "anchoring-new-turn" | "free-scrolling"`.

- `liveFollowEnabled` is a **render-visible flag**, not just a ref, because "LegendList's
  `maintainScrollAtEnd` re-pins on its own (independent of the refs)" (`ChatView.tsx:5297-5300`).
  When false, `maintainScrollAtEnd` is passed `false` outright (`MessagesTimeline.tsx:1294-1304`).
- **Re-arm band**: `resolveTimelineIsAtEnd` (`MessagesTimeline.logic.ts:158-173`) computes
  `contentLength - scroll - scrollLength <= 40px` rather than trusting LegendList's `isNearEnd`,
  which "fires within half a viewport, which re-armed live-follow while the user was reading
  history and yanked them back down on the next stream chunk" (`:149-156`).
- **Smooth vs instant**: while `isWorking` and not `prefers-reduced-motion`, follow uses
  `{ animated: true }` so each streamed paragraph glides instead of jumping
  (`MessagesTimeline.tsx:389-395`, applied at `:1301-1303`).
- Follow triggers are enumerated: `{ dataChange: true, footerLayout: false, itemLayout: true,
  layout: true }` (`:380-387`) — footer (composer) height changes explicitly must *not* move
  visible messages.
- **"Anchoring-new-turn"** is the ChatGPT-style behavior: on send, the new user message is pinned
  near the top and empty space is reserved below it via `anchoredEndSpace`
  (`resolveChatListAnchoredEndSpace`, `packages/shared/src/chatList.ts:12`) so the answer grows
  downward without the viewport jumping. It releases to `following-end` when tool activity makes it
  pointless (`shouldReleaseTimelineAnchorForToolActivity`, `ChatView.tsx:5433-5448`).
- **Scroll-to-end pill**: `showScrollToBottom` is debounced (`showScrollDebouncer`) and driven by
  `onIsAtEndChange` (`ChatView.tsx:5630-5659`); the button sits above the composer at
  `bottom: scrollToEndClearance + 4` (`ChatView.tsx:9967`) and calls `scrollToEnd(true)` which
  re-arms every follow ref in one place (`ChatView.tsx:5390-5405`).
- **Per-thread scroll memory**: `rememberTimelinePosition` / `readTimelinePosition`
  (`timelineScrollAnchoring.ts:128-141`) keep a 100-entry LRU of `{rowId, offsetWithinRow,
  scrollOffset, atEnd, disclosures}` — including which tool groups and reasoning blocks were open —
  so returning to a thread restores the exact reading position *and* disclosure state.

### 3.5 Markdown streaming

- `ChatMarkdown` is `memo`'d (`components/ChatMarkdown.tsx:3363`) and all its config is funnelled
  through one `useMemo`'d `componentState` object published on a context
  (`:2655-2729`), so plugin/component arrays never change identity.
- **Incremental Markdown parse** (`markdown-incremental.ts`): when streaming *and* the text contains
  a fence, a custom unified parser caches the parsed prefix up to the last closed top-level code
  fence followed by a blank line, then only parses the suffix and shifts node positions
  (`markdown-incremental.ts:37-85`). Bails out entirely on `\r`/BOM or if the document has link
  definitions (which are document-wide). Enabled at `ChatMarkdown.tsx:3315-3326`.
- **Incremental Shiki**: while streaming, code blocks render as individually mounted lines
  (`codeToHast` + `HighlightedCodeLines`) rather than `innerHTML`, so appending a line does not blow
  away the user's text selection; once settled, the HTML is memoized into a size-aware
  `LRUCache` and served via `dangerouslySetInnerHTML`
  (`ChatMarkdown.tsx:1036-1132`, cache at `:354`).
- `data-streaming` on the wrapper gates a CSS fade-in for newly arrived blocks (`:3339`).

### 3.6 Pagination

Threads do not load whole. `INITIAL_THREAD_USER_TURN_LIMIT = 10`, `OLDER_THREAD_PAGE_USER_TURN_LIMIT
= 20` (`packages/client-runtime/src/state/threads.ts:49-50`), "sized so first paint on the heaviest
observed threads stays around 100K gzipped". `loadEarlier` renders a plain button as
`ListHeaderComponent` — deliberately **no spinner**, "the label change is the loading indicator"
(`MessagesTimeline.tsx:342-344`).

### 3.7 Timeline minimap

A left-gutter rail with one dot per user message (`deriveTimelineMinimapItems`,
`components/chat/timelineMinimapItems.ts:11`), each carrying the user text and the turn's *final*
assistant text for a hover preview. Clicking scrolls to that row.
`resolveTimelineMinimapHitStripWidth` (`MessagesTimeline.logic.ts:257`) caps the invisible hover
strip to the actual gutter so it can never swallow clicks on message text at narrow widths.

---

## 4. The composer

`components/chat/ChatComposer.tsx` is a single 7,017-line component. It owns draft subscriptions,
provider/model state, trigger detection, the command menu, attachments, uploads, paste/drag,
prompt history, the stash, the ⌘S listener, a ~350-line FLIP animation system for the "resting"
layout, and the entire render tree. Everything extracted into sibling modules is *pure logic*.

### 4.1 Editor: Tiptap in both modes

`components/ComposerPromptEditor.tsx` is a 17-line re-export of
`ComposerPromptEditorTiptap.tsx` (1,379 lines). The engine is created at
`ComposerPromptEditorTiptap.tsx:728` with `StarterKit` stripped hard (`:731-746`: blockquote,
bulletList, codeBlock, heading, hr, listItem, link, orderedList, underline, dropcursor, gapcursor,
trailingNode all `false`).

The `composerRichTextEnabled` setting (default **true**,
`packages/contracts/src/settings.ts:434`) toggles **styling, never the engine**: in plain mode the
marks themselves are disabled (`ComposerPromptEditorTiptap.tsx:745`) and the editor is remounted via
`key={richTextEnabled ? "rich" : "plain"}` (`:556-563`), rehydrating from the stored Markdown.

- Inline Markdown parsing is hand-rolled — **only bold, italic, strike, inline code**
  (`composer-rich-text.ts:20-25, 39-131`); unmatched markers unwind back to literal text so nothing
  typed is ever lost (`:120-127`).
- **Marker reveal**: a ProseMirror plugin decorates the styled range under the caret with widget
  spans showing the literal `**` / `_` / `` ` `` (`ComposerPromptEditorTiptap.tsx:495-548`).
- Rich mode adds `TaskList` + a `wrappingInputRule` on `/^- \[([ xX])\] $/` (`:752-766`).

**Three cursor coordinate spaces** (`composer-rich-text-doc.ts:9-22`) are the load-bearing
invariant:
1. *flat* — markers excluded, a chip counts 1;
2. *collapsed* — markers literal, chip counts 1 (the draft-store coordinate);
3. *markdown* — markers literal, chips expand to full source.

Conversions: `flatToCollapsed:571`, `flatToMarkdown:584`, `collapsedToFlat:597`, `flatToPm:616`,
`pmToFlat:628`; serializer `serializeEditorDoc:537` → `{value, runs, docLength, contextIds}`.
Task-list indentation round-trips byte-exactly via `indent` / `markerSpace` / `contentSpace`
attributes (`:49-58`); only `[X]`→`[x]` and `__b__`→`**b**` normalize.

The editor is **fully controlled**: a `useLayoutEffect` (`ComposerPromptEditorTiptap.tsx:1020-1084`)
applies store value+cursor with `setContent(..., { emitUpdate: false })` behind
`isApplyingControlledUpdateRef`. The internals doc warns not to replace content for a mere cursor
move — it creates undo entries and regenerates citation identities
(`docs/internals/composer-editors.md`).

Editor-level key handling (`editorProps.handleKeyDown`, `:799-915`): macOS Home/End via
`selection.modify("lineboundary")`, arrow keys jump over chip atoms as units, Enter swallowed during
IME composition, Enter on a task checkbox is a no-op (Space toggles), `splitBlockKeepMarks` +
`scrollIntoView` otherwise. `handleTextInput` (`:916-942`) implements **surround-selection**: typing
`( [ { ' " “ \` < « * _` with a selection wraps it, bailing at atom/mark/mention boundaries.

There is **no separate mobile editor on web** — the same Tiptap, with a collapsed layout (§8).

### 4.2 Triggers, mentions and context references

`detectComposerTrigger` (canonical: `packages/shared/src/composerTrigger.ts:55-130`, web copy
`composer-logic.ts:206-254`):

| Char | Kind | Rule |
|---|---|---|
| `/` at line start | `slash-command` | `/^\/(\S*)$/` on the line prefix |
| `#` | `pull-request` | `/^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u` |
| `$` (any `\p{Sc}`) | `skill` | `/^\p{Sc}/u` |
| `@` | `path` | token starts with `@` |

The menu is `ComposerCommandMenu` (`components/chat/ComposerCommandMenu.tsx:71`) — a Base UI
`Command` list with `autoHighlight={false}` and `mode="none"`, i.e. highlight is fully controlled by
ChatComposer (`nudgeComposerMenuHighlight`, `ChatComposer.tsx:3688-3702`). It renders inside a
`ComposerBanner.Surface`. PR results are debounced 180 ms and capped
(`COMPOSER_PULL_REQUEST_LIST_LIMIT = 99`, `..._RESULT_LIMIT = 12`, `ChatComposer.tsx:393-394`).

**Chips are four Tiptap inline atom nodes**, each with a `ReactNodeViewRenderer`
(`ComposerPromptEditorTiptap.tsx`):

| Node | Attrs | Defined | Serializes to |
|---|---|---|---|
| `composer-mention` | `path`, `source` | `:192-248` | `[basename](encoded/path)` |
| `composer-skill` | `skillName`, `skillLabel`, `skillDescription` | `:250-313` | `` `$name` `` |
| `composer-citation` | `citation`, `source`, `citeKey` | `:315-413` | canonical citation link |
| `composer-context-reference` | `kind`, `contextId`, `label`, `source` | `:415-450` | `[label](t3-context://v1/<kind>/<id>)` |

The wire contract is documented in `docs/internals/composer-context-references.md`: a **context
record** is the payload (in `message.context.records`, never bytes — images/files bind to a
`ChatAttachmentId`), a **context reference** is one occurrence, a Markdown link carrying only kind +
`contextId`. At turn start the server projects it for the provider: each reference becomes an
in-place marker `[Image: shot.png; ref=ctx_1]` plus one trailing `<t3_context version="1">` envelope;
captured text is escaped so a terminal line cannot forge a record.

Ids outside `[a-z0-9_-]` fold to `slug-<fnv1a64>` deterministically
(`lib/composerContextReferences.ts:27-52`); labels are sanitized to ≤200 chars, no brackets or
newlines. Per-kind presentation capabilities (`details: none|tooltip|popover`,
`expanded: none|inline-block|modal`) live in `components/contextPresentationRegistry.ts:14-47` with a
hard invariant that every `COMPOSER_CONTEXT_KINDS` entry has a definition (`:51-64`). Chip geometry
is in `em` so chips scale with the prompt font-size setting
(`components/composerInlineChip.ts:4-5`); one accent hue per kind at fixed lightness
`oklch(0.62 …)` (`:47-62`).

Two details worth stealing:
- **Undo-aware reference reconciliation** — deleting a chip removes its draft payload but *retains*
  it in `removedContextPayloadsRef` so an undo restores it
  (`ChatComposer.tsx:3336-3360`, `chat/composerContextUndo.ts:16-45`).
- **File-tree drag → mention** uses a custom MIME `application/x-t3code-composer-mention` and claims
  the event in the **capture** phase, stopping the native event so Tiptap's own DOM listeners never
  see it (`chat/composerMentionDrag.ts:8, 56-66`).

Copy/cut writes `text/plain` + a structured `x-t3-context-fragment+json` flavor + an HTML mirror
(`ComposerPromptEditorTiptap.tsx:1198-1227`); paste re-imports records, re-minting colliding ids
(`components/composerInlineTokenPaste.ts`), and auto-completes chip delimiters at boundaries
(`:953-969`).

### 4.3 Slash commands

Built in `composerMenuItems` (`ChatComposer.tsx:2317-2385`):
- **T3 built-ins**: `/model` ("Switch response model for this thread"), `/plan` + `/default` when
  plan-mode UI is on.
- **Provider commands** → `provider-slash-command` items.
- **Skills** → `/skill:<name>`, gated on `settings.showSkillsInSlashMenu`.
- **`/compact`** only when the slash token is the *entire* prompt and there are zero attachments or
  context items (`:2235-2245`).

Position gating (`composerSlashCommandSearch.ts:15-29`): provider commands are dropped unless the
trigger is at offset 0 — "A provider expands a slash command only when it opens the whole message;
anywhere else it reaches the agent as literal text." Built-ins and skills work anywhere.

Ranking (`composerSlashCommandSearch.ts:31-114`): per-field escalating bases
(`exact 0 / prefix 2 / boundary 4 / includes 6 / fuzzy 100` on name; `20/22/24/26` on description,
no fuzzy), boundary markers `- _ /`, tie-break key prefixed `0\0|1\0|2\0` so built-ins sort before
provider commands before skills.

Selection (`onSelectComposerItem`, `ChatComposer.tsx:3548-3675`) is guarded by a one-frame
re-entry lock. `/model` and `/plan` **erase their own text** and open the picker / switch mode rather
than inserting anything.

### 4.4 Attachments

Classification (`chat/composerAttachmentFiles.ts:23-77`): HEIC counts as image; an empty or
`application/octet-stream` MIME falls back to extension sniffing; a real `image/*` the provider
doesn't support becomes `unsupported-image`.

`addComposerAttachments` (`ChatComposer.tsx:5234-5420+`) does **all validation synchronously before
any await**, so concurrent pastes see each other's reservations (`:5259-5262`). Order:
pending-question gate → reattach-marker match (a re-picked file replaces a `needs-reattach` row and
consumes no slot) → count limit `PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8`
(`packages/contracts/src/orchestration.ts:166`) → unsupported image type → file size vs
`PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 MB` (`:168`) → **images are downscaled, not refused**
against `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 MB` (`:167`, call at `ChatComposer.tsx:5374-5377`).

Every accepted attachment inserts an inline **chip at the caret** (`:5343-5348`). Files exist *only*
as chips — deleting a file's last chip removes the file. Images additionally keep a **thumbnail
shelf** as their inventory; deleting an image chip leaves the image, and removing a thumbnail that is
still referenced asks for confirmation.

Upload lifecycle is a queue module (`lib/attachmentUploadQueue.ts`): `startAttachmentUpload:376`,
`retryAttachmentUpload:508`, `releaseAttachmentUpload:466`, `verifyStashedAttachmentUpload:534`,
`getUploadedAttachments:550`. On a capability flap (reconnect / version skew) only uploads *not yet
stamped* with `uploadedAttachmentId` are torn down, so a persisted draft reference survives a reload
(`composerAttachmentFiles.ts:132-142`).

Thumbnails decode off the render path (`chat/ComposerImageThumbnail.tsx:6-28`). Overlays: a
draft-not-persisted warning badge, a byte-level upload progress strip, and a retry button on failure
(`ChatComposer.tsx:6504-6556`).

### 4.5 Model / access-mode / effort / workspace selectors

**Model picker** — `ProviderModelPicker` (trigger) → `ModelPickerContent` (1,076 lines: a Base UI
Combobox over a virtualized `LegendList`) + `ModelPickerSidebar` (provider instances). Keys are
opaque *length-prefixed* strings so model slugs may contain `:`
(`chat/modelPickerKeys.ts:6-37`). Search is multi-token AND with field-ordered penalties and a `-24`
favorite boost (`chat/modelPickerSearch.ts:55-87`). Keyboard: ArrowLeft on an empty query or
Shift+Tab moves to the provider sidebar; ArrowRight returns; Enter commits; **Shift+Enter
multi-selects** (fan a prompt out to several models, each starting its own thread + worktree);
everything else `stopPropagation`s so the composer never sees it
(`ModelPickerContent.tsx:899-948`).

**Access mode** (`RuntimeMode`) — four options with labels/descriptions/icons in
`chat/runtimeModeConfig.ts:4-28`:

| Value | Label | Description |
|---|---|---|
| `approval-required` | Supervised | "Ask before commands and file changes." |
| `auto-accept-edits` | Auto-accept edits | "Auto-approve edits, ask before other actions." |
| `auto` | Auto | "Supported providers approve routine actions; others still ask." |
| `full-access` | Full access | "Allow commands and edits without prompts." |

Rendered as a `Select` in `ComposerFooterModeControls` (`ChatComposer.tsx:1039-1149`), collapsing to
a `MenuRadioGroup` under an "Access" heading in `CompactComposerControlsMenu.tsx:76-89`.

**Plan/Build** interaction mode toggles with **Shift+Tab** from the editor
(`ChatComposer.tsx:3954-3958`).

**Effort / reasoning** — `chat/TraitsPicker.tsx` renders `MenuRadioGroup`s and supports
*prompt-injected* effort (e.g. Claude's `ultrathink` prefix, `:10, :349`).

**Host / workspace / branch / previous-worktree** live in the `BranchToolbar` below the composer but
are driven through composer-namespaced shortcuts.

The generic mechanism for all of these is worth copying: `ChatComposerHandle.openControl(command)`
(`ChatComposer.tsx:5880-5900`) un-collapses and focuses the composer with `flushSync`, then does a
DOM query for `button[data-composer-shortcut~="<command>"]:not(:disabled)` inside
`[data-slot="composer-shell"]`, skipping `[inert]` and invisible nodes, then `.focus()` + `.click()`.
Every control carries a `data-composer-shortcut` attribute; one keybinding handler drives them all.

### 4.6 Queueing while a turn runs

Store: `queuedMessageStore.ts` (zustand, **in-memory only** — "a queued message is a live intent,
not a draft worth persisting", `:70-71`). A `QueuedComposerMessage` (`:15-36`) is a full draft
snapshot: prompt, images, files, terminalContexts, previewAnnotations, reviewComments,
`submissionIntent`, `queuedAfterToolActivityId`, `holdUntilUserAction`.

Three subtleties:
- `take` **re-anchors** the remaining messages to the new `toolActivityId` so only one queued message
  leaves per tool-call boundary (`:90-105`).
- `drainGeneration` (`:40-45`) lets a send that grabbed a message before a Stop, and finished its
  upload after, detect the drain and give up — Stop can never be followed by a queued message
  starting a new turn.
- `holdAtFront` marks `holdUntilUserAction` on a failed send so nothing overtakes it (`:128-140`).

**Steer vs Queue** is one setting with a per-message inversion (`ChatView.tsx:7629-7660`):

```ts
if (!queuedMessage && phase === "running" &&
    (settings.followUpBehavior === "queue") !== (submissionIntent === "alternate")) { enqueue() }
```

`alternate` comes from `composerSubmissionIntentForEnter` (`composer-logic.ts:26-44`) when the turn
is running and the mod key is held — so ⌘/Ctrl+Enter always does *the opposite of the setting* for
one message.

`mod+shift+enter` → `thread.steerQueuedMessage` takes the head of the queue and sends it now
(`packages/shared/src/keybindings.ts:45`, handler `ChatView.tsx:6877-6886`).

### 4.7 Composer keyboard shortcuts

`sendShortcut: "enter" | "mod-enter-multiline" | "mod-enter"`
(`packages/contracts/src/settings.ts:435`), resolved by `composerSubmissionIntentForEnter`
(`composer-logic.ts:26-44`). `"mod-enter-multiline"` only demands the modifier once the prompt
contains a newline. `background` intent (⌘+Enter on a draft thread) starts the thread *without*
foregrounding it, so you can fire several drafts in a row.

`onComposerCommandKey` priority chain (`ChatComposer.tsx:3952-4026`):
1. Shift+Tab → plan/build toggle
2. menu open → arrows nudge, Enter/Tab select
3. ArrowUp/ArrowDown → prompt history recall
4. Enter → submit
5. Enter on a task item → native ProseMirror split
6. Enter/Tab → Markdown list continuation / indentation (`composer-list-continuation.ts`)

**ArrowUp prompt recall** (`chat/composerPromptHistory.ts`) is terminal-style, per-thread, derived
from thread user messages on every keypress — no store. `recallableComposerPrompt` (`:113-156`)
strips send-time appends: the Claude `"Ultrathink:\n"` prefix, trailing `<review_comment>` /
`<terminal_context>` / `<element_context>` / `<preview_annotation>` blocks, orphaned inline
`@terminal-1:12-13` labels, and **all** `t3-context://` references — "Recall is text-only: never
create dangling chips without their backing records" (`:144-150`). Consecutive duplicates collapse
(`HISTCONTROL=ignoredups` style, `:164-179`). It only claims the arrow keys when the caret is on the
first/last **visual** (soft-wrapped) line, probed with DOM ranges
(`ComposerPromptEditorTiptap.tsx:1164-1193`), and refuses entirely when the composer holds any
attachment or context item (`ChatComposer.tsx:3903-3919`).

**⌘S prompt stash** (`keybindings.ts:44`) — the window listener is **capture phase** and *always*
`preventDefault()`s so the browser save dialog never opens, even when stashing isn't possible
(`ChatComposer.tsx:5177-5209`). Store `promptStashStore.ts`: `MAX_STASH_ENTRIES = 20`, per-entry
attachment budget 2.7 MB of chars, overflow dropped (`:110-125`). Restore verifies uploads *before*
taking the entry (the server sweeps pending uploads after 24 h) and aborts if the thread changed
mid-await (`ChatComposer.tsx:4046-4074`).

**⌘⇧V paste-as-text** (`packages/client-runtime/src/textPaste.ts:6-17`) is armed with a 1-second
deadline ref because Electron's native menu action can arrive *before* the paste event
(`ChatComposer.tsx:2150-2186`).

**PageUp/PageDown** are forwarded out of the editor to scroll the timeline
(`ComposerPromptEditorTiptap.tsx:1250-1277`).

### 4.8 Voice input

**The web composer has no voice input.** No mic button, no `SpeechRecognition`.
`packages/client-runtime/src/voice-input/` is platform-agnostic infrastructure consumed only by the
React Native app: `VoiceInputController` with phases `idle | preparing | recording | transcribing |
error` (`controller.ts:7`), a 5-minute cap (`:5`), `voiceInputBlocksSubmission` /
`voiceInputFreezesEditor` (`:15-23`), and a DI surface (`:46-62`) for recorder/transcriber/permission
/`readDraft`/`commitDraft`.

The reusable piece is `resolveTranscriptCommit` (`:73-121`): it compares a captured
`VoiceDraftSnapshot` (`ownerKey` + `text` + `revision`) against the current one and returns `"stale"`
if anything moved; trims and returns `"empty"` when blank; applies English-only smart spacing based
on the characters either side of a collapsed caret; then splices via `replaceTextRange` — the same
primitive the trigger replacement uses. Bringing voice to web needs only a `MediaRecorder`-backed
`VoiceRecorder`, a `VoiceTranscriber`, and a draft bridge.

### 4.9 Prompt length and the large-paste rule

`PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000` (`packages/contracts/src/orchestration.ts:165`).
`getComposerPromptLengthValidationMessage` (`chat/composerSubmission.ts:12-24`) measures
**`max(literal, citation-expanded)`** — a citation chip is short in the composer but expands on the
wire. Answers to pending user input are exempt (`:26-32`). `submitComposerDraft` (`:34-50`) is the
single funnel; display is `ComposerPromptLengthValidation` with `role="alert"`.

**Large paste → attachment**: threshold `PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 KiB`
(`packages/client-runtime/src/textPaste.ts:1`). `pastedTextDisposition` (`:24-37`) folds when the
paste would exceed the input limit **or** is ≥32 KiB by char count *or* UTF-8 byte length —
byte-based on purpose, since "character counts substantially understate the context cost of some
Unicode-heavy clipboard contents" (`:20-23`). Names mint as `pasted-text.txt`, `pasted-text-2.txt`
(`:40-51`). `foldPastedText` (`ChatComposer.tsx:5492-5566`) only *errors* when the paste would
actually overflow; otherwise it silently falls back to inline. Success shows a toast with the escape
hatch: *"Large paste attached as pasted-text.txt — 41.2 KB · Use ⌘⇧V to keep a large paste inline."*
(`:5354-5364`).

---

## 5. Approval & question UX

**The single biggest structural difference from most agent GUIs: pending approvals and questions are
NOT timeline cards. They are docked banners attached to the top of the composer.**

`ChatComposer.tsx:6131-6260` renders a `ComposerBanner.Dock > ComposerBanner.Column` above the input
containing, in priority order:

1. `ComposerBannerStack` — the general notice stack (`ComposerBannerStack.tsx:33-41` sorts
   `activity` → `urgent`/`error`/`warning` → `notice`, collapsing extras behind a "peek" popover).
2. A **top drawer** whose content is chosen by an if-chain (`ChatComposer.tsx:6149-6260`):
   - an **approval** (`variant="warning"`, `density="spacious"`, shield icon), else
   - a **pending question**, else
   - a plan follow-up prompt, else
   - a mobile-collapsed variant of the question.

### Approvals

- `ComposerPendingApprovalPanel` (`components/chat/ComposerPendingApprovalPanel.tsx:11`) renders the
  label + detail. Label comes from `requestKind`: `command` → "Command approval", `file-read` →
  "File read approval", `file-change` → "File change approval", `permission` → "App permission
  approval", `mcp-elicitation` → "App access approval" (`:17-36`).
- The detail is a scrollable, focusable `<code>` (`whitespace-pre font-mono`, `max-h-20`,
  `tabIndex={0}`) — or a prose `<span>` for MCP elicitations (`:51-63`).
- **Only one approval is shown at a time**, with a `1/N` counter in the header when more are queued
  (`:47-49`). `pendingApprovals[0]` is the active one.
- `ComposerPendingApprovalActions` (`ComposerPendingApprovalActions.tsx:30`) splits the
  provider-supplied `options` into **primary buttons** (`decline` + `accept`) and an **overflow "…"
  menu** for everything else (`:36-41`). Default set when the provider supplies none (`:23-28`):
  `Cancel`, `Decline`, `Always allow this session` (`acceptForSession`), `Approve`.
- An option may carry a `warning` string → triangle icon + tooltip + `aria-description` (`:52-65`).
- `isResponding` disables everything while the response is in flight; in-flight ids live in
  `respondingRequestIds` (`ChatView.tsx:1728`).
- No modal, no focus steal. Approval never moves focus out of the composer; the user can keep typing.
- The composer is `inert` only while a *checkpoint revert* runs (`ChatView.tsx:9990`).

### Questions

`ComposerPendingUserInputPanel` (`components/chat/ComposerPendingUserInputPanel.tsx:23`) +
pure logic in `pendingUserInput.ts`:

- A `PendingUserInput` carries `questions[]` and a `dismissible` flag ("Async questions can be
  dismissed without a reply; native callbacks cannot", `packages/client-runtime/src/pendingRequests.ts:26`).
- **One question at a time** with an index; `derivePendingUserInputProgress`
  (`pendingUserInput.ts:160`) computes `activeQuestion`, `answeredQuestionCount`, `isLastQuestion`,
  `canAdvance`, `isComplete`.
- Answer precedence: a non-empty **custom answer beats selected options**
  (`resolvePendingUserInputAnswer:42-68`); multi-select returns an array. Attachments alone can
  satisfy a question (`attachmentCount > 0` → `""`).
- **Digit shortcuts 1–9** select options when focus is outside any editable field
  (`:141-166`) — explicitly skipped while the card is collapsed "since the numbers they refer to are
  not on screen".
- Single-select **auto-advances after 200ms** with an optimistic local selection
  (`:118-135`); multi-select toggles in place.
- **The card is collapsible**, keyed by the *question id* rather than a bare flag, so it reopens when
  the prompt advances to the next question (`:75-82`) — "a tall prompt stops covering the thread the
  user is trying to read".
- **Typed text is never lost**: clicking an option would discard the custom answer, so
  `carryDisplacedCustomAnswerIntoPrompt` (`pendingUserInput.ts:93-105`) moves it into the thread
  draft, appended after whatever was already there.
- **Attachments on answers** (`questionAttachments.ts`, `docs/user/question-attachments.md`): each
  question keeps its own attachment set while you move between questions; the normal prompt draft
  stays separate; uploads must finish before submit; capability-gated by
  `supportsQuestionAttachments` (`ChatView.tsx:10045`).
- Once answered, the question is **folded out of the message list** and re-rendered as a work row:
  `deriveTimelineEntriesWithState` drops the user message whose id is
  `async-answer:<requestId>` when a work entry already carries that `questionAnswer`
  (`session-logic.ts:1670-1676`). Expanding that row shows `QuestionAnswerHistory`
  (`MessagesTimeline.tsx:5028`).

### Permission modes

Four modes (`docs/user/permission-modes.md`): **Supervised**, **Auto-accept edits**, **Auto**,
**Full access**. Chosen in the composer (`interactionMode` / `handleInteractionModeChange`,
`ChatView.tsx:10162-10164`), scoped **per thread**, defaulted per environment and overridable per
project. Keybinding `mod+shift+a` opens the access-mode picker
(`docs/user/keybindings.md`). The thread shell carries `hasPendingApprovals` /
`hasPendingUserInput` booleans (`packages/contracts/src/orchestration.ts:895-896`) so the sidebar
can show a needs-attention state without loading the thread.

---

## 6. Thread sidebar, navigation & command palette

### 6.1 Routing details

`router.ts:5-17` — TanStack router with `defaultPreload: "intent"` (route chunks prefetch on
hover/focus). History is **hash-based on Electron, browser history on web**
(`main.tsx:18-20`), which is why `__root.tsx:368` reads the pathname from the router rather than
`window.location`.

Root shell (`routes/__root.tsx:196-244`):

```
ToastProvider > AnchoredToastProvider
  > sync components (DocumentTitle, ContrastAppearance, EnvironmentTheme, Glass, Font)
  > FirstRunGate
      > coordinators (SnapShot, ThreadNotification, ConfirmDialog, CustomSnooze, SlowRpc,
                      ProjectClone, EventRouter, PlanAgentSelectionHeal, ProviderUpdate)
      > CommandPalette          ← wraps the entire shell
          > AppSidebarLayout    ← sidebar + inset
              > Outlet
      > ThemeEditorHost         ← above the router so a theme draft survives navigation
```

`AppSidebarLayout.tsx:234-274` is the three-column composer: a `SidebarProvider` (`h-dvh!`) with
CSS vars `--sidebar-width` / `--panel-animation-duration`, a `<Sidebar side="left"
collapsible="offcanvas" resizable>` whose content is one of `SettingsSidebarNav` /
`LegacyThreadSidebar` / `ThreadSidebar`, the route `Outlet`, and a **fixed-position** floating
`SidebarControl` toggle. Widths in `components/threadSidebarWidth.ts`: default 256, min 208,
main-content min 640, max = `viewportWidth - 640`; double-clicking the rail resets.

The right panel is **not** in the layout route — it is owned per-thread by `ChatView` (§6.5).

### 6.2 Thread sidebar

`components/Sidebar.tsx` is 4,986 lines (a legacy project-grouped variant lives in
`LegacySidebar.tsx`, selected by the `legacySidebarEnabled` client setting).

Data comes from **thread shells**, not details (`useThreadShells()`), plus `useThreadActions()`
which supplies `settle/unsettle/snooze/unsnooze/pin/unpin/reorderPinned/reorderActive/archive/delete`
(`Sidebar.tsx:2164-2176`).

**Four sections** (`Sidebar.logic.ts:117`): `pinned | active | snoozed | settled`.
Classification precedence (`Sidebar.tsx:2541-2637`): optimistic drop override → **snooze**
("snooze outranks settlement and pinning until the thread wakes") → settled → pinned → active.
Each transition is **capability-gated per environment** (`threadSettlement`, `threadSnooze`,
`threadPinning`, `threadPinReorder`, `threadActiveReorder`) — a thread on a server lacking
`threadSettlement` never classifies as settled, because the user could neither un-settle nor pin it.
Critically, the capability gates *dragging only, never the sort*, so mixed-version fleets render
identically on web and mobile (`Sidebar.tsx:2604-2609`).

Snooze wake timing (`Sidebar.tsx:2543-2547, 2688-2707`) uses a real timestamp (not the quantized
minute tick) and arms a `setTimeout` clamped to `2_147_483_647` ms to avoid the signed-32-bit
overflow that would turn a far-future snooze into a re-arm loop.

The settled tail paginates (`SETTLED_TAIL_INITIAL_COUNT = 10`, `PAGE_COUNT = 25`,
`Sidebar.tsx:256-257`) and the currently open settled thread is force-pulled into the visible page.

**Status is two parallel models:**

*Row status* (`Sidebar.logic.ts:812-863`) —
`"approval" | "input" | "working" | "monitoring" | "failed" | "ready"`, precedence
pendingApprovals → pendingUserInput → session running/starting → session error → backgroundLiveness
→ ready. The design note at `:801-810` is quotable: *"Five visual states, three colors: color is
reserved for 'act now' (approval), 'in motion' (working), and 'broken' (failed). Ready is the
unlabeled resting state."* `shouldRecedeSidebarThread` (`:820-833`) is the inbox-zero rule:
working/monitoring rows recede; ready/approval rows recede only when not unread and not woken;
active/selected/input rows never recede.

*Status pill* (`resolveThreadStatusPill`, `Sidebar.logic.ts:1010-1096`):

| Label | Color | Pulse |
|---|---|---|
| Pending Approval | amber | no |
| Awaiting Input | indigo | no |
| Working | sky | yes |
| Connecting | sky | yes |
| Plan Ready | violet | no |
| Monitoring | sky | no |
| Completed (unseen) | emerald | no |

Rolled up to project level via `THREAD_STATUS_PRIORITY` (`:527-535`), where "Plan Ready" outranks
"Monitoring" so a monitoring sibling cannot hide an actionable plan prompt.

**Unread** = `hasUnseenCompletion` (`Sidebar.logic.ts:635-644`): the latest turn's `completedAt` is
newer than `uiStateStore.threadLastVisitedAtById[threadKey]`. There is an explicit
`markThreadUnread` too (`uiStateStore.ts:250-296`).

**Project grouping** in the new sidebar is a *filter scope, not a nesting level*.
`sidebarProjectGrouping.ts:67-120` merges the same logical repo across machines into a
`SidebarProjectSnapshot` with `environmentPresence: "local-only" | "remote-only" | "mixed"`. The
scope picker is a Combobox in the header with its own search, favicons and per-row settings gear
(`Sidebar.tsx:4437-4568`); the choice persists as `sidebarProjectScopeKey`.

**Drag & drop** is the most elaborate part. dnd-kit over a **single sortable list containing both
thread rows and structural markers** (`Sidebar.logic.ts:123-148`): markers are
`pinned-header | active-placeholder | settled-placeholder | pinned-divider | snoozed-header |
settled-header`, with colon-free ids so they never collide with scoped thread keys.
`sectionAtSidebarSlot` (`:150-162`) derives the destination section by walking markers before the
drop index; `resolveSidebarDropTarget` (`:170-193`) returns `null` for the snoozed shelf because
snoozing needs a wake time; `resolveSidebarDropVerb` (`:227-237`) produces the badge on the lifted
row (`Pin / Unpin / Settle / Unsettle / Wake`); `planSidebarThreadDrop` (`:239-336`) emits a typed
plan with fractional order keys from `client-runtime/state/thread-sort` so web and mobile agree.
A custom `SidebarPointerSensor` (`Sidebar.pointer.ts:19-140`) owns capture-phase listeners and
cancels on Escape/blur/pagehide/resize/visibility-change/lost-button, suppressing the trailing click.
`Sidebar.motion.ts` is a FLIP layer: 150 ms ease-out, clone-based fade-outs, a
`MAX_FADED_ROWS_PER_UPDATE = 40` bail-out for bulk changes, and `prefers-reduced-motion` respected.

**Search** is hybrid: local title matching (`searchSidebarThreads`, `Sidebar.logic.ts:907-938`,
matching title + PR search terms) plus a debounced, two-character-floor server content search over
connected environments only (`useThreadSearch`, `state/queries.ts:79-102`, backed by
`client-runtime/state/threadSearch.ts:50-84`, which treats failures/disconnects as "no content
matches" so local title search stays the fallback). While searching, the entire DnD tree is
unmounted and a flat result list renders instead.

**Thread jump**: `thread.jump.1..9` and `thread.previous/next` resolve against `orderedThreadKeys`
(`Sidebar.tsx:4322-4368`), skipped when the palette or model picker is open. A hint overlay appears
after 200 ms, only when held modifiers *exactly* match a jump binding, and **never while the terminal
is focused** (`keybindings.ts:317-343`) — Ghostty would type the key instead.

**Notifications**: `ThreadNotificationCoordinator` drives `setNotificationBadge(count)`
(`threadNotifications.ts:25-65`) — a 64px red canvas badge on desktop, a generated-PNG favicon swap
on web — plus `playNotificationSound("completion"|"input")` through an `AudioContext` unlocked from a
gesture. Modes: `off | notifications | sound | notifications-and-sound`.

### 6.3 Command palette

Three ways to open (`components/CommandPalette.tsx`):
1. keybinding, via a map `commandPalette.toggle → "command"`, `filePicker.toggle → "files"`,
   `projectSearch.toggle → "content"` (`:458-462`, handler `:516-573`);
2. an **event bus** — `CustomEvent("t3code:open-command-palette")` with
   `detail: {open?: "add-project"|"new-thread-in", query?, linkedThreads?}`
   (`commandPaletteBus.ts:10-32`);
3. programmatic open-intent reducer actions.

`isCommandPaletteOpen()` (`commandPaletteBus.ts:35-38`) is a **DOM probe**
(`[data-command-palette]`) read at event time, so global-shortcut owners can suppress themselves
without subscribing to transient dialog state.

One reducer owns three mutually exclusive overlays so they can never stack
(`CommandPalette.logic.ts:55-122`): `"command" | "files" | "content"` (⌘K / ⌘P / ⇧⌘F). Toggling the
active mode closes; **Escape inside files/content returns to command mode** rather than closing
(`CommandPalette.tsx:504-514`, with `eventDetails.cancel()` on `onOpenChange`). The background tree
is `inert` while open, and `finalFocus` returns focus to the composer (`:619-621, 694-697`).

What it searches (`filterCommandPaletteGroups`, `CommandPalette.logic.ts:376-455`): at rest,
`actions` + `recent-threads` (limit 12). With a query, recents are dropped and three search groups
append: `projects-search`, `settings-search`, `threads-search`. Thread search terms are
`[title, ...PR terms, projectTitle, branch, contentSnippet, id]` with **id last so a pasted id never
outranks a title match** (`:310-311`). Ranking (`:333-374`): every query token must appear in the
field; exact 3 / prefix 2 / substring 1; earlier fields win by 100.

The **`>` actions filter** (`:384-402`): a leading `>` restricts to the `actions` group and skips
appending project/settings/thread groups entirely; it also swaps the empty-state copy to *"No
matching actions."*

Keyboard: Base UI `Autocomplete` drives arrows + Enter but the palette passes `mode="none"` and
tracks the highlight itself. `handleKeyDown` (`:2667-2716`) adds `thread.jump.N` execution,
`thread.copyReference`, `Mod+Enter` to force-submit a browse path over a highlighted directory, and
**Backspace on an empty query pops the submenu**. Mouse rows `preventDefault()` on mousedown so the
input keeps focus.

**There is no command registry** — actions are an imperatively built array inside the component
render (`CommandPalette.tsx:1738-2079`), with two item kinds (`action` with `run()` + `keepOpen`,
and `submenu` with nested groups). 16 actions are registered: new thread, new-thread-in (submenu),
copy thread reference, link PR, open thread PRs, open file picker, search project contents,
add project (18 search terms), add WSL folder, change theme (submenu), change appearance (submenu),
theme editor, pull requests, usage, settings, project settings. `enumerateCommandPaletteItems`
(`:174-184`) assigns `thread.jump.1..9` to the first nine rows so numbered shortcuts work inside the
palette.

### 6.4 Keybindings

**The server owns the config and pre-compiles it.** `apps/server/src/keybindings.ts` parses
`~/.t3/userdata/keybindings.json`, merges with defaults, and ships
`ResolvedKeybindingRule { command, shortcut: KeybindingShortcut, whenAst }`
(`packages/contracts/src/keybindings.ts:170-175`) — the key string is already parsed into modifier
booleans and the `when` string into an AST. **The client never parses text.** The payload uses
`ForwardCompatibleArray` so unknown commands or `when` nodes are dropped rather than failing the
whole config (`:177-187`). Limits: 256 rules, 64-char keys, 256-char `when`, depth 64 (`:4-8`).

`KeybindingShortcut` carries `key, metaKey, ctrlKey, shiftKey, altKey, modKey` (`:131-139`) — the
platform-agnostic `modKey` is the reason one rule file works on macOS and Linux.

`when` context (`apps/web/src/keybindings.ts:32-40`): `terminalFocus`, `terminalOpen`,
`previewFocus`, `previewOpen`, plus derived `isWeb`/`isDesktop` and ad-hoc keys like
`modelPickerOpen`. `isWeb`/`isDesktop` are derived, not caller-supplied — that's the mechanism
behind desktop-only `mod+1..9`.

Dispatch (`resolveShortcutCommand`, `apps/web/src/keybindings.ts:232-248`) iterates **backwards** so
later rules win (user overrides shadow defaults). Two key-matching subtleties worth stealing:
`shortcutKeyFromEvent` (`:86-91`) prefers the layout key for `a-z` and falls back to a physical-code
table otherwise; `resolveEventKeys` (`:93-107`) adds the physical letter **only when the layout key
isn't Latin**, so Cyrillic/Greek layouts work without one press firing two shortcuts.
`findEffectiveShortcutForCommand` (`:195-221`) replays the same last-wins precedence for *label*
display, so a shadowed binding never appears in a tooltip.

Dispatch sites are deliberately scattered rather than centralized — `AppSidebarLayout.tsx:86-114`
(sidebar toggle, capture phase, with a Tiptap `Mod+B` bold escape hatch and a
`[data-keybinding-capture]` bail-out for the rebinding UI), `CommandPalette.tsx:516-573`,
`routes/_chat.tsx:60-174`, `Sidebar.tsx:4322-4368`.

Settings UI (`components/settings/KeybindingsSettings.tsx`, 1,591 lines) edits `when` **structurally,
not as free text** (`parseWhenExpressionDraft`, `whenAstToExpression`, `buildWhenVariableOptions`),
shows `source: Default | Custom | Project`, and computes conflicts.

### 6.5 Right panel

`rightPanelStore.ts` — zustand + `persist` (`"t3code:right-panel-state:v2"`, version 13), state is
**per thread**: `byThreadKey: Record<string, {isOpen, activeSurfaceId, surfaces[]}>`.
Surface kinds (`:22-33`): `diff | files | file | preview | device | terminal | pull-request |
pull-requests | agents`. Descriptors carry their own resource identity (`browser:<tabId>`,
`terminal:<id>` with `terminalIds[] / splitDirection`, `file:<path>` with
`revealLine / revealRequestId`, `pull-request:<ref>` so several PRs can be peer tabs).

The idea worth stealing is `openProactive(ref, surface, expectedUserActionRevision)`
(`:117-124`): an app-initiated panel open that is **refused if the user made a panel choice since the
revision was read**. `userActionRevisionByThreadKey` counts only user choices. This is how the app
auto-opens a diff without ever stealing a panel the user just picked. It is disabled entirely on
narrow layouts.

Layout switch is one constant: `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)"`
(`rightPanelLayout.ts:1`). Above it, a resizable inline column with per-thread width persistence and
a maximize control; below it, an overlay `RightPanelSheet` with fixed widths, no maximize, titlebar
controls moved *into* the panel, and proactive opens disabled.

---

## 7. Diffs & source control

### In-thread

Per-turn, not per-tool. The server produces a **checkpoint** per turn (a hidden git ref —
`docs/internals/overview.md`), and `thread.checkpoints: TurnDiffSummary[]` is handed to the timeline
as `turnDiffSummaries` (`ChatView.tsx:9945-9949`). A summary is attached to the assistant message
that ended the turn (`row.assistantTurnDiffSummary`) and rendered as `ChangedFilesCard`
(`components/chat/ChangedFilesTree.tsx:28`): header with file count + aggregate `+/-`, an
expand-all toggle, and a directory tree built by `buildTurnDiffTree` (`lib/turnDiffTree.ts`) with
per-file stats.

Individual tool rows show changed file paths only as text inside the expanded body
(`buildToolCallExpandedBody`, `MessagesTimeline.tsx:4531-4542`) — there is **no inline diff inside a
tool call**. Review comments are the exception: `buildReviewCommentRenderablePatch`
(`reviewCommentContext.ts`) renders a small `FileDiff` inside a user message's review-comment card
(`MessagesTimeline.tsx:4093`).

### The diff panel

`components/DiffPanel.tsx` (1,202 lines) opens in the right panel via `onOpenTurnDiff(turnId,
filePath)` (`ChatView.tsx:9471`).

- Renderer: `FileDiff` from `@pierre/diffs/react`.
- **Split vs unified** is a user toggle: `diffStyle: diffLayout === "split" ? "split" : "unified"`
  (`DiffPanel.tsx:1155`).
- **Worker pool**: `DiffWorkerPoolProvider` (`components/DiffWorkerPoolProvider.tsx`) owns a
  module-level shared `WorkerPoolManager` with refcounting and a 30s idle TTL
  (`:27-60`), `totalASTLRUCacheSize: 240`, `tokenizeMaxLineLength: 1000`, and the same forced
  `shiki-wasm` highlighter. Tokenization and diffing run off the main thread.
- Per-file caching keyed by identity + content version (`buildFileDiffIdentityKey` /
  `buildFileDiffContentVersion`, `lib/diffRendering.ts:230-251`) with a WeakMap
  (`DiffPanel.tsx:98-108`).
- **Per-line comment annotations**: `AnnotatableCodeView` + `DiffCommentAnnotation`
  (`components/diffs/`), and a submitted comment becomes a **composer context chip** via
  `reviewCommentContext.ts` — i.e. reviewing a diff feeds the agent.
- Theme: two Shiki themes (`pierre-light` / `pierre-dark`), resolved by `resolveDiffThemeName`
  (`lib/diffRendering.ts:13`).

### Checkpoints / revert

- Entry point is **"Edit from here"** on a user message (`RevertUserMessageButton`,
  `MessagesTimeline.tsx:2267`), disabled while a turn is running or another revert is in flight.
- It opens an `AlertDialog` with **two destructive-ish choices** (`ChatView.tsx:10419-10461`):
  *Revert files too* (only offered when the thread runs in a worktree) and *Revert and keep changes*.
- `onRevertToTurnCount` (`ChatView.tsx:6995-7060+`) guards on: provider support
  (`supportsConversationRollback`), environment connectivity, running turn, pending composer
  attachments, and the 8-attachment cap; then downloads the original message's attachments back into
  the composer draft and restores the prompt text.
- `isRevertingCheckpoint` makes the whole composer overlay `inert` and is tracked in the zustand
  `composerDraftStore.rewindingThreadKeys`.

### PR surfaces

A full sub-app under `components/pullRequest/` (~50 files): list page (`routes/_chat.pull-requests.tsx`),
`PullRequestDetailPanel` with Summary / Code / Timeline tabs, `PullRequestReviewBar`,
`PullRequestCommentComposer`, `PullRequestChecksPopover`, and **stacked-PR** support
(`PullRequestStackLayers`, `PullRequestStackHeader`). PRs attach to messages as review-comment
context records with typed `pullRequest` metadata
(`docs/internals/composer-context-references.md`), rendered as `#123` chips whose color reflects
open/draft/merged/closed at attach time. Linking is **capability-negotiated** through the
environment descriptor, never a client version (`docs/internals/overview.md` table).

---

## 8. Mobile web / responsive

### 8.1 Viewport and the soft keyboard — one line, no JS

`apps/web/index.html:5-8`:

```html
<meta name="viewport"
  content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />
```

- `viewport-fit=cover` → the app draws edge-to-edge and owns `env(safe-area-inset-*)`.
- `interactive-widget=resizes-content` → **the soft keyboard resizes the layout viewport.**

Consequently there is **no `visualViewport` code anywhere in `apps/web/src`** (verified by grep).
This is a notable contrast with hand-rolled keyboard-avoidance layers: it is a single meta attribute
instead of a resize-listener subsystem. The trade-off is that Safari/iOS honors it less consistently
than Chrome/Android, and there is no hook to build sub-keyboard positioning on if one is ever needed.

### 8.2 Safe areas

`apps/web/src/index.css`:
- Four Tailwind v4 `@utility` shorthands (`:939-950`): `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`,
  each `max(env(safe-area-inset-*), 0px)`.
- `#root` gets `padding-top: max(env(safe-area-inset-top), 0px)` plus `overflow-x: clip`,
  `overflow-y: hidden`, `overscroll-behavior-y: none` (`:1552-1561`).
- `html, body { min-height: calc(100svh + env(safe-area-inset-top)); overscroll-behavior: none; }`
  (`:1540-1543`) — the `svh + inset` trick for iOS toolbar collapse.
- Window-control insets are safe-area-aware CSS vars (`:1209-1210`):
  `--workspace-controls-left: calc(env(safe-area-inset-left) + 0.75rem)`.
- The chat composer rail pads its own left/right insets and reserves a bottom spacer
  `h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]`
  (`ChatView.tsx:10000, 10226`).
- The PWA/Windows-Controls-Overlay case has its own custom Tailwind variant `wco:`
  (`index.css:6`), used for `wco:mt-[env(titlebar-area-height)]` on the right-panel sheet.

### 8.3 The breakpoint hook

`hooks/useMediaQuery.ts` is a small DSL over `matchMedia` + `useSyncExternalStore`:
- breakpoints `sm 640, md 768, lg 1024, xl 1280, 2xl 1536, 3xl 1600, 4xl 2000` (`:3-11`);
- grammar `"md"` (min), `"max-md"` (max, `px - 1`), `"md:max-lg"` (range), an object
  `{min, max, pointer: "coarse"|"fine"}`, or a raw media string;
- `useIsMobile() = useMediaQuery("max-md")`, i.e. `< 768px` (`:85-87`).

**Three different "narrow" thresholds coexist:**

| Threshold | Query | Used by |
|---|---|---|
| `< 768px` | `useIsMobile()` | sidebar offcanvas → sheet (`ui/sidebar.tsx:105`) |
| `< 640px` | `useMediaQuery("max-sm")` | composer collapse (`ChatComposer.tsx:2079`), autofocus suppression (`ChatView.tsx:1750`) |
| `≤ 980px` | raw media string | right-panel sheet (`rightPanelLayout.ts:1`) |

They can disagree in the 640–767px band — the sidebar is a sheet while the composer is still in
desktop mode. Also, `pointer: coarse` is *supported* by the hook but **used nowhere**; all touch
adaptation keys off width alone. (Some CSS does use `pointer-coarse:` variants directly, e.g.
always-visible message action rows in `MessagesTimeline.tsx:2445`.)

### 8.4 Component-level mobile behaviour

**Sidebar** — `ui/sidebar.tsx` keeps two independent open flags: `open` (desktop, persisted to a
`sidebar_state` cookie, 7-day max-age) and `openMobile` (ephemeral). Below 768px it renders **a
different component tree** — a `Sheet` with
`--sidebar-width: calc(100vw - var(--spacing(3)))` (`:26, 232-268`) and a visually-hidden
`SheetTitle` for the dialog name. Resizing is disabled on mobile (`:196-199`). Titlebar control
targets grow below 640px (`max-sm:[--workspace-titlebar-control-size:--spacing(8)]`, `:159`).
`components/Sidebar.tsx` itself contains **zero** responsive utilities — all of it is delegated to
`ui/sidebar` and the `isMobile` context flag.

**Composer** — collapses to a single-row pill:
`isComposerCollapsedMobile = isMobileViewport && !forceExpandedOnMobile && !isComposerFocused &&
!hasMultilinePrompt` (`ChatComposer.tsx:2102-2103`). **Enter never sends on mobile**
(`composer-logic.ts:27-45` returns `null`) — the on-screen Return inserts a newline. After a
successful send the composer blurs so the keyboard dismisses
(`blurMobileComposerAfterSend`, `:3711-3756`). `ChatView.tsx:5749` suppresses composer autofocus on
thread open below 640px so the keyboard doesn't pop on every navigation. Pending-question actions get
a dedicated compact mobile layout (`ChatComposer.tsx:6200-6260`).

Independently of viewport queries, the composer footer uses **container-width breakpoints measured in
JS**: `COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620` and `…WIDE_ACTIONS…= 780`
(`composerFooterLayout.ts:1-2`), with an overflow-menu solver that carries a **1px hysteresis slack
to prevent "Maximum update depth exceeded" flip-flop** (`:171-177`).

**Command palette** — viewport padding `py-[max(--spacing(4),4vh)] sm:py-[10vh]`, rows are taller and
larger on touch (`min-h-8 text-base sm:min-h-7 sm:text-sm`, `CommandPaletteResults.tsx:71`), and the
footer hint gutter stacks vertically below 640px.

**Reduced motion** is checked in six places (`Sidebar.motion.ts:22`, `RightPanelTabs.tsx:856`,
`ChatView.tsx:563`, `BranchToolbar.tsx:419`, `ChatComposer.tsx:528`, `SnapShotCoordinator.tsx:352`).
Panel transitions additionally gate on a `data-panel-animations` attribute plus a
`--panel-animation-duration` var set by `AppSidebarLayout`, scoped with `motion-safe:`.

---

## 9. State management

### Two stores, deliberately split

**Domain state = Effect Atom in `packages/client-runtime`.** Everything that crosses the wire or is
shared with the React Native app lives here. `apps/web/src/state/entities.ts` is a thin hook layer
over atom families:

```ts
useThreadShell(ref)   // entities.ts:99   → environmentThreadShells.threadShellAtom(ref)
useThreadDetail(ref)  // entities.ts:105  → environmentThreadDetails.detailAtom(ref)
useThreadStatus(ref)  // entities.ts:111
useThread(ref)        // entities.ts:128  → shell-authoritative metadata merged over detail
```

**Client-local UI state = zustand** (19 files): `composerDraftStore.ts`, `queuedMessageStore.ts`,
`promptStashStore.ts`, `rightPanelStore.ts`, `uiStateStore.ts`, `diffPanelStore.ts`,
`threadSelectionStore.ts`, `previewStateStore.ts`, `terminalUiStateStore.ts`,
`sidebarPendingFileDropStore.ts`, `browserHistoryStore.ts`, `themeEditorStore.ts`.

### Shell vs detail — the key scaling decision

A thread has two server-side projections:

- **`OrchestrationThreadShell`** (`packages/contracts/src/orchestration.ts:860-905+`) — everything
  the sidebar needs and nothing else: id, projectId, title, modelSelection, runtimeMode,
  interactionMode, branch, worktreePath, `latestTurn`, `session`, `latestUserMessageAt`,
  **`hasPendingApprovals`**, **`hasPendingUserInput`**, `hasActionableProposedPlan`,
  `backgroundLiveness`, plus pin/settle/snooze/archive timestamps and order keys.
- **`OrchestrationThread`** (detail) — adds `messages`, `activities`, `checkpoints`, `proposedPlans`.

Only the *open* thread subscribes to detail. `docs/internals/overview.md`: *"Subscriptions send the
state a client needs, so a client viewing one thread does not pay for every thread's history."*

### Subscription lifecycle

`makeEnvironmentThreadState` (`packages/client-runtime/src/state/threads.ts:178`) is an Effect
scoped resource per thread:

- `subscribeDynamic(ORCHESTRATION_WS_METHODS.subscribeThread, …)` (`:748`) rebuilds its subscribe
  input from each new session's `initialConfig`, **capability-gating** on
  `threadSnapshotPagination`, `threadResumeCompletionMarker`, `reasoningMessages` (`:750-770`).
- A windowed cache resuming against a server *without* pagination is detected and the window marker
  dropped, forcing a full reload — "the missing older turns can never be loaded" otherwise
  (`:774-794`).
- Events are folded by `applyThreadDetailEvent` (`state/threadReducer.ts:101`), a large pure
  `switch` over ~35 event kinds.
- **Persistence to local cache is debounced 500 ms** (`Stream.debounce("500 millis")`, `threads.ts:309`)
  and only committed if the snapshot still matches (`:283-294`).
- Atom TTLs: the live state atom is `Atom.setIdleTTL(0)` (dropped immediately when unobserved,
  `:951`) while a *resume cache* atom holds the snapshot for `THREAD_SNAPSHOT_IDLE_TTL_MS`
  (`:930`) so navigating away and back resumes by sequence instead of refetching.
- Reconnect states are explicit: `setConnecting` / `setReady` / `setDisconnected` / `setStreamError`
  (`:314-356`); disconnect clears session-scoped capability flags so a stale capability can't be used
  against a new server (`:332-340`, with the review finding written into the comment).

### Optimistic updates

Minimal and local, not a generic mutation layer:

- **User messages**: `optimisticUserMessages: ChatMessage[]` in `ChatView` local state
  (`ChatView.tsx:1686`), merged into the server list by id at `:3505-3514`, and removed when the
  server ids appear (`:5776`).
- **Queued messages**: held entirely client-side in `queuedMessageStore` (zustand) and rendered as
  ghost rows appended after the live rows.
- **Draft promotion**: a client-reserved thread id is used before the server knows the thread
  (`ThreadRouteView.tsx:56-64`), with `markPromotedDraftThreadByRef` /
  `finalizePromotedDraftThreadByRef` bridging.
- **Question single-select**: `optimisticSingleSelect` in the question card
  (`ComposerPendingUserInputPanel.tsx:71-107`), cleared once the store agrees.
- **Thread-switch hold**: `resolveThreadSwitchTimeline` (`ChatView.tsx:3542`) keeps painting the
  *previous* thread's rows while the next thread's snapshot loads, so a switch never flashes empty;
  callbacks are swapped for no-ops during that window (`paintOnlyDisplayedTimeline`).

---

## Desktop wrapper (brief)

`apps/desktop` is Electron `44.4.2` + electron-builder. It does **not** load `file://`:
`DesktopWindow.ts:369` resolves `getDesktopUrl(isDevelopment)` to a custom privileged scheme —
`t3code-dev://app/` in dev (proxying the Vite server, with a backoff retry ladder at
`DesktopWindow.ts:704-722`) and `t3code://app` in production, served by
`src/electron/ElectronProtocol.ts:119` (`registerSchemesAsPrivileged`) + `protocol.handle` (`:270`).
Same-origin, so the web app's `window.location.origin` endpoint resolution just works.

The renderer bridge is `contextBridge.exposeInMainWorld("desktopBridge", …)`
(`apps/desktop/src/preload.ts:64`). Chat-relevant members: `getClientPlatform`,
`setNotificationBadge` + `onNotificationBadgeClear` (`:74-80`), `getPathForFile` (drag-and-drop
→ real path, `:72`), `getClientSettings`/`setClientSettings`, `getLocalEnvironmentBootstraps` and
`getLocalEnvironmentBearerToken` (the bundled server), plus SSH/WSL/snapshot/global-shortcut
surfaces. The web app branches on `isElectron` for title-bar inset
(`ChatView.tsx:9791-9800`, `--workspace-controls-top/right`) and on `isDesktop` in keybinding `when`
clauses (`docs/user/keybindings.md`).

---

## 10. What to steal / what to skip

For a much smaller single-user product on React 18 + zustand + Tailwind. (React 18 matters: T3 Code
leans on React 19's `use()` and on the React Compiler; neither is available, so memoization has to
be manual — which raises the value of the identity-preserving projections below.)

### Steal — high value, low cost

1. **The three-layer incremental projection.** Entries → rows → stable rows, each with an explicit
   fast path (`session-logic.ts:1654`, `MessagesTimeline.logic.ts:1477`, `:1556`). Without a
   compiler you need this *more*, not less. The hand-written per-variant `isRowUnchanged`
   (`:1577-1675`) is ~100 lines and is what lets `memo` actually work.
2. **The `WorkLogEntry` shape** (`session-logic.ts:56-95`). One normalized record for every agent
   action — tool call, command, file change, approval, question answer, subagent spawn, error —
   discriminated by `tone`, `itemType`, `toolLifecycleStatus`, `sourceActivityKind`. Do not build a
   per-tool component taxonomy; build one row with a presentation resolver.
3. **The activity group.** Collapse the whole reasoning + tool run between two assistant texts into
   *one line* that shows the live tool label while running and
   `summarizeToolGroup()` → "Read 3 files, ran 2 commands" when settled
   (`MessagesTimeline.tsx:2586`, `packages/client-runtime/src/work-log/presentation.ts:598`,
   `toolGroupAction:464`, `omitSupersededLifecycleMarkers:637`). This is the single biggest
   readability win in the whole UI, and it is ~200 lines of pure logic.
4. **Approvals and questions as a docked banner above the composer, not timeline cards.**
   One at a time with an `1/N` counter, primary Approve/Decline buttons plus an overflow menu for
   the rest, digit shortcuts 1–9 for question options, a collapsible card keyed by question id, and
   focus never leaving the composer (`ComposerPendingApprovalPanel.tsx`,
   `ComposerPendingApprovalActions.tsx`, `ComposerPendingUserInputPanel.tsx`). Cheap, and it solves
   "the approval scrolled off screen" outright.
5. **`carryDisplacedCustomAnswerIntoPrompt`** (`pendingUserInput.ts:93-105`) — never silently
   discard text the user typed; move it into the draft. Ten lines, and the class of bug it kills is
   the kind users never forgive.
6. **Live-follow as a render-visible flag plus a pixel re-arm band** (40px,
   `MessagesTimeline.logic.ts:156-173`), not the virtualizer's own `isNearEnd`. Plus
   `{footerLayout: false}` so composer growth never moves visible messages.
7. **Composer-as-overlay with a published height** fed back as the list's bottom content inset
   (`ChatView.tsx:9941, 9988`). Avoids the whole class of "the list jumps when the textarea grows"
   bugs.
8. **`data-composer-shortcut` + `openControl(command)`** (`ChatComposer.tsx:5880-5900`): one
   keybinding handler that focuses-and-clicks a control found by attribute query. Replaces N imperative
   handles with a DOM convention.
9. **`interactive-widget=resizes-content` + `viewport-fit=cover`** in the viewport meta, plus four
   `*-safe` Tailwind utilities (`index.css:939-950`). This is the entire mobile keyboard/safe-area
   story in ~15 lines.
10. **Shell vs detail split** (`packages/contracts/src/orchestration.ts:860`): the sidebar consumes a
    lightweight per-thread projection carrying `hasPendingApprovals`, `hasPendingUserInput`,
    `latestTurn`, `session`; only the open thread subscribes to messages. If a thread list will ever
    exceed ~20 rows this is not optional.
11. **The queued-message ghost bubble** (`MessagesTimeline.tsx:1759`) with "Send now" / "Return to
    composer" and an explicit tooltip about *when* it will go. Queueing that is invisible is
    terrifying; queueing that is visible is delightful.
12. **Streaming markdown details**: memoize the whole markdown config object once
    (`ChatMarkdown.tsx:2655`), render code blocks as individually mounted lines while streaming so
    appending never clobbers a selection, then cache the settled HTML
    (`ChatMarkdown.tsx:1036-1132`). Force the Oniguruma WASM Shiki engine
    (`lib/syntaxHighlighting.ts:16`) — the JS regex engine really does hang.
13. **Per-thread scroll + disclosure memory** (`timelineScrollAnchoring.ts:110-141`): a 100-entry
    LRU of `{rowId, offsetWithinRow, atEnd, disclosures}`. Restoring *which tool groups were open*
    alongside the scroll position is what makes thread switching feel free.
14. **The "no spinner" load-earlier header** (`MessagesTimeline.tsx:342`) and the shimmer-on-label
    pattern for live rows — both are cheaper than spinners and read better.
15. **Backwards keybinding resolution so later rules win**, with a separate
    `findEffectiveShortcutForCommand` for label display (`apps/web/src/keybindings.ts:195-248`).

### Steal if you have the appetite

- **Turn-scoped "anchoring-new-turn" scroll** with reserved end space
  (`packages/shared/src/chatList.ts:12`). Great UX, but it interacts with the virtualizer in fiddly
  ways; budget real time.
- **Per-turn `ChangedFilesCard` inside the assistant message** (`ChangedFilesTree.tsx:28`) backed by
  git checkpoints, with click-through into a diff panel. The card is easy; the checkpoint plumbing
  is not.
- **Context chips as canonical Markdown links + a separate record map**
  (`docs/internals/composer-context-references.md`). The right model, but it is a genuine
  sub-project: a grammar, a provider projection, a clipboard fragment format, legacy upgrades, and
  undo-aware reconciliation.
- **The timeline minimap** (`timelineMinimapItems.ts`) — a small, distinctive feature; the only
  fiddly part is capping the hover strip to the gutter (`MessagesTimeline.logic.ts:257`).
- **`openProactive` with a user-action revision** (`rightPanelStore.ts:117-124`) — the cleanest
  "auto-open a panel without ever stealing the user's choice" primitive I've seen.

### Skip

- **Effect / `@effect/atom-react` as the state layer.** The value here is multi-environment
  reconnect semantics, capability negotiation across independently versioned servers, and a shared
  runtime with React Native. A single-user local product has none of those problems; zustand plus a
  hand-rolled WebSocket reducer is the right size. Do keep the *idea* of an idle-TTL resume cache.
- **Multi-environment / relay / Tailscale / Clerk** — entirely out of scope.
- **`@legendapp/list`.** It is excellent, but chosen partly because RN shares it. On web, if threads
  are capped (pagination at ~10 turns) the timeline can be a plain scroll container with
  `content-visibility: auto`. Adopt a virtualizer only when a profile says so — and note that T3
  Code deliberately does *not* recycle items on the main list, which removes most of the benefit.
- **Tiptap/ProseMirror for the composer**, unless chips are a requirement. `ComposerPromptEditorTiptap.tsx`
  is 1,379 lines plus a 644-line coordinate model, and the majority of it exists to make three
  cursor coordinate spaces agree. A `<textarea>` plus a token-based overlay covers `@file` and `/slash`
  for a fraction of the cost; adopt ProseMirror only when you need inline atoms.
- **The 7,017-line `ChatComposer` / 10,472-line `ChatView` shape.** Copy the logic modules, not the
  component decomposition (or lack of it). The extracted `*.logic.ts` files are the actual asset.
- **`@pierre/diffs` worker pool** until diffs are genuinely slow. Start with a simple unified diff
  renderer plus the same Shiki instance the markdown uses.
- **Sidebar drag & drop across sections.** ~1,500 lines across `Sidebar.drag.ts`, `.motion.ts`,
  `.pointer.ts`, `.logic.ts` and a custom collision detector, and it still has an open touch-vs-scroll
  problem. A menu with Pin/Settle/Snooze gets 95% of the value.
- **Three different narrow breakpoints.** Pick one and define it once — T3 Code's 640/768/980 split
  produces a band where the sidebar is a sheet and the composer is still desktop.
- **Provider-shaped machinery** (multi-select model fan-out, per-provider slash-command position
  gating, subagent fleet panel, prompt-injected effort) — all of it exists because six provider CLIs
  disagree. With one or two agents, hard-code.
