# T3 Code vs Orquester: agent chat GUI, timeline rendering and composer

Analyst 01. Scope: timeline rendering of messages, tools and diffs; Markdown, LaTeX, code and
Mermaid; assistant citations; the composer (editor, mentions, slash commands, attachments, queue,
recall, stash, prompt links, voice); plan, approval and question UI; scroll and virtualization;
thread sidebar UX; composer keyboard handling; chat performance.

Paths: `T3/` = `t3code_codebase/` at ed9b7ca9. `ORQ/` = repo root. **(new)** = landed in
`e8d87689..ed9b7ca9`.

Context: Orquester's chat surface was ported from T3 (MIT) in September, and many files carry
`Ported from T3 Code` headers. Most of the basics are already at parity: the `/` `$` `@`
triggers, steer or queue follow-ups, large paste becoming a file, rewind and fork from a message,
plan card, question cards with option previews and attachments, Mermaid, the context meter,
incremental markdown parsing, MCP apps and HTML visual replies. The gaps below are what T3 kept
building after that port, plus places where Orquester deliberately chose a simpler design.

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (evidence) | User value | Port effort |
|---|---|---|---|---|
| **Inline context chips in the composer and in sent messages** (file, terminal excerpt, review comment, preview annotation, PR, thread and citation as atoms at the caret; the chips survive copy and paste between drafts) | `T3/packages/contracts/src/composerContext.ts`, `T3/packages/shared/src/composerContextReferences.ts` (`t3-context://v1/<kind>/<id>` grammar, provider projection with escaped `<t3_context>` envelope), `T3/apps/web/src/components/ComposerPromptEditorTiptap.tsx`, `T3/apps/web/src/components/chat/UserMessageContextChips.tsx`, `T3/apps/web/src/lib/composerContextRecords.ts`, `docs/internals/composer-context-references.md` | **Missing.** The composer is a plain `<textarea>` by design (`ORQ/packages/ui/src/components/agent-chat/composer/ChatComposer.tsx:220-224`). Context records persist but have no UI: "The composer has no context UI, so they ride along untouched" (`ChatComposer.tsx:302-310`). `ComposerContextRecord` is `{kind,label,ref}` only (`ORQ/packages/api/src/agent-chat/adapter-types.ts:182-186`). `@file` is flattened into text. | H | L |
| **Terminal excerpt and diff review comment into the composer** | `T3/apps/web/src/components/chat/TerminalContextInlineChip.tsx`, `ComposerPendingTerminalContexts.tsx`, `T3/apps/web/src/lib/terminalContext.ts`, `T3/apps/web/src/reviewCommentContext.ts` | **Missing.** The only external callers of `composer-bridge.insertText` and `stageAttachment` are the right rail and the browser element pick (`ORQ/packages/ui/src/components/agent-chat/composer/composer-bridge.ts:1-60`; grep shows only `right-rail/*` and `browser/BrowserView.tsx`). No terminal "send selection to chat" and no line comments on diffs. | H | M |
| **`@` mentions of other threads** (the agent reads the referenced history on demand) and **dragging a sidebar thread onto the composer** | `T3/apps/web/src/components/chat/useComposerMenuItems.ts:156-175` (`matchComposerThreadItems`), `threadContextDrag.ts`, `composerThreadImport.ts`, `T3/apps/web/src/lib/threadContextAttachment.ts`; thread links render as chips with project icon (new, `15dc7b01`) | **Missing.** `@` lists paths only (`ORQ/.../composer/composer-menu.ts:44-64`). Orquester already has the server side, the `read_transcript` and `search_sessions` MCP tools, so only the UI is missing. | M | S–M |
| **`#` pull-request picker** (recent PRs, linked PRs first, number or text search, status-tinted chip) | `T3/apps/web/src/components/chat/useComposerMenuItems.ts:100-150,250+`, `docs/user/composer.md` "Context in your message" | **Missing, deliberately dropped**: "T3's `#` pull-request trigger has no Orquester equivalent and is dropped" (`ORQ/.../composer/composer-trigger.ts:18`). Orquester renders forge links as pills (`ForgeLinkPill.tsx`) but has no picker. | M | M |
| **Prompt recall with ArrowUp/ArrowDown** in an empty composer, walking this thread's sent prompts | `T3/apps/web/src/components/chat/composerPromptHistory.ts`, `useComposerCommandKey.ts:139-220` | **Missing.** ArrowUp/Down only move the token-menu highlight (`ChatComposer.tsx:1806-1817`). Partial substitute: the right-rail History panel has Insert, Send and Jump on past prompts (`ORQ/packages/ui/src/components/right-rail/history/PromptCard.tsx:72-77`). | M | S |
| **Prompt stash** (`Cmd/Ctrl+S` saves the draft with its attachments and chips; restore from a menu) | `T3/apps/web/src/promptStashStore.ts`, `components/chat/useComposerStash.ts`, `ComposerStashMenu.tsx`, `ComposerStashBadge.tsx` | **Partial.** Saved prompts in the right rail cover reusable text (`right-rail/saved-prompts`) but not a one-keystroke park and restore of a draft with its attachments. | M | S |
| **In-thread find** (`Cmd+F` bar, CSS Custom Highlight API, reveals folded rows via `beforematch`) | `T3/apps/web/src/components/chat/ThreadFindBar.tsx`, `ThreadFindProvider.tsx`, `threadFindHighlights.ts:111-216`, `useThreadFindNavigation.ts` | **Partial.** Cross-thread conversation search exists in the command palette with reveal-turn (`ORQ/packages/ui/src/components/command-palette/ConversationSearchResults.tsx`, `reveal-turn.ts`). There is no find inside the open timeline; `keybindings.logic.ts` has no find command. | M | M |
| **Timeline minimap** (ticks per user turn, hover preview as plain text, click to jump) | `T3/apps/web/src/components/chat/TimelineMinimap.tsx`, `timelineMinimapItems.ts`, `timelineMinimapWheel.ts` | **Missing** in chat (the only minimaps are on the workflow canvas). The right-rail History "Jump" is the nearest equivalent. | M | M |
| **Image thumbnails in sent messages and a zoomable gallery** (also for markdown images) | `T3/apps/web/src/components/chat/TimelineUserMessageRow.tsx:411-431`, `ExpandedImageDialog.tsx`, `ZoomableImage.tsx`, `markdownImageGallery.ts`, `ChatMarkdownMedia.tsx` (video too) | **Missing, deliberately.** Sent attachments render as name and size chips: "the timeline does not fetch it" (`ORQ/.../timeline/rows/MessageRows.tsx:80-99`). Markdown images are capped at `max-h-64` with no click to expand (`ChatMarkdown.tsx:162-186`). No video embed. | M | S–M |
| **File links as file chips that open at a line** (`path:42` or `#L42`), with context menu (copy path, open in editor, preview) | `T3/apps/web/src/components/chat/MarkdownFileLink.tsx:26-43,111,251-263`, `MarkdownFileLink.logic.ts`, `T3/apps/web/src/markdown-links.ts` | **Partial.** A workspace link calls `openFile`, which only reveals the path in the Files tab and drops `?`/`#` fragments (`ORQ/.../AgentChatView.tsx:1149-1165`, `timeline/markdown/local-image.ts`). It does not jump to a line and has no file chip or menu. | M | S |
| **Markdown table tools** (copy as Markdown or CSV, expand cells) | `T3/apps/web/src/components/chat/MarkdownTable.tsx:42-161` | **Missing.** Plain `<table>` in a scroller (`ORQ/.../timeline/markdown/ChatMarkdown.tsx:224-238`). | M | S |
| **GitHub alerts** (`> [!NOTE]`, `[!WARNING]` and so on) and **`<details>`** blocks | `T3/apps/web/src/components/ChatMarkdown.tsx:972-984` (`GITHUB_ALERT_PRESENTATIONS`), `:1474` + `chat/MarkdownDetails.tsx` | **Missing.** The component map has a plain `blockquote` and no raw HTML (`ChatMarkdown.tsx:207-212`, no `rehype-raw` by design). Alerts can be done as a remark transform without raw HTML. | L–M | S |
| **ANSI colour in command output** (bounded span count) | `T3/packages/shared/src/terminalOutput.ts:829` (`terminalOutputSpans`, 2,000-span cap), `T3/apps/web/src/components/chat/CommandOutputPanel.tsx:2` | **Missing.** Tool output is raw `<pre>{text}</pre>` (`ORQ/.../timeline/rows/ActivityRows.tsx:123-188`). There is no ANSI handling in `agent-chat` (grep for `x1b`/`u001b` finds nothing). | L–M | S |
| **Composer stays usable during approvals; sending declines the pending approval and redirects the agent** (new) | `a93b03c8`: `T3/packages/client-runtime/src/state/threadRequests.ts:20` (`declinePendingApprovals`), `T3/apps/web/src/components/chat/useComposerSend.ts:987` | **Missing.** A pending approval or question blocks every send except `/goal`: `PENDING_REQUEST_REASON = "Answer the request above first."` (`ORQ/.../composer/composer-submission.ts:390-407`). | H | S |
| **Approvals say why the provider asked in full-access mode** (Claude `decisionReason`; ask-rule vs provider check; no standing-grant option when Claude suppresses it) (new) | `e7492453`: `T3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2840` (`claudeApprovalPresentation`), `T3/apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx:89-91` | **Missing.** The Claude adapter maps `decision_reason` only onto `tool.denied` (`ORQ/apps/daemon/src/agent-host/adapters/claude/normalize.ts:2658-2676`), not onto approval requests. `ApprovalCard.tsx` and `approval-detail.ts` show no reason. | M | S |
| **Automation messages as compact folded rows** ("Automation · task title", expand on click; find reveals the body) (new) | `d27c6067`: `T3/apps/web/src/components/chat/TimelineUserMessageRow.tsx:132-250` (`AutomationMessageRow`) | **Partial.** Long user bubbles are clamped (`MessageRows.tsx:312-345`), and chat-to-chat messages get a caption (`threadMessageCaption`, `MessageRows.tsx:44-57`). A workflow-sent prompt has no attribution: there is no workflow context kind (`ORQ/packages/api/src/agent-chat/thread-tools.ts:363-372`). | M | S |
| **Rich Markdown composer** (styled as you type, list and task continuation, code blocks with language picker and highlighting, TeX kept as editable source) | `T3/apps/web/src/components/ComposerPromptEditorTiptap.tsx` (1,953 lines), `T3/apps/web/src/composer-rich-text*.ts`, `composer-list-continuation.ts`, `composer-code-block.ts`, `chat/ComposerCodeBlockNodeView.tsx`, `docs/internals/composer-editors.md` | **Missing, deliberately** (textarea; `ChatComposer.tsx:220-224`). | M | L |
| **Prompt links** (`/new?prompt=&repo=&provider=&model=&pr=`, "Copy prompt link" on sent messages; invisible and tag characters stripped with a warning) | `T3/packages/shared/src/promptLinks.ts:51-209`, `T3/apps/web/src/components/promptLinks/*`, `TimelineUserMessageRow.tsx:216-220`, `docs/user/prompt-links.md` | **Missing.** No `prompt` URL parameter handling in `apps/web`, `apps/desktop` or `packages/ui`. | L–M | M |
| **Citation identity, comments and back-navigation** (a quote keeps its source message id; each quote has its own comment; clicking a cited quote scrolls to and highlights the source) | `T3/packages/shared/src/assistantCitations.ts`, `T3/apps/web/src/lib/assistantCitationNavigation.ts`, `assistantTextSelection.ts`, `chat/AssistantCitationChip.tsx`, `AssistantCitationCommentEditor.tsx`, `useAssistantCitationTarget.ts` | **Partial.** Quote from a selection exists (`QuoteSelectionToolbar.tsx`), but quotes are sent as leading blockquotes with no per-quote comment and no link back to the source (`ORQ/.../composer/composer-quotes.ts:1-18`). | M | M |
| **Queue editing**: server-persisted, drag reorder, edit in place (`Alt+Up`), promote to steer, hold and resume after a stop or restart, thumbnails | `T3/apps/web/src/components/chat/QueuedRunsControl.tsx`, `queuedMessageEdit.ts`, `useQueuedRunEdit.ts`, `useComposerResume.ts`; `docs/user/composer.md` "Queued messages" | **Partial.** The queue is client-side (sessionStorage outbox), with remove, return to composer and steer-queued; no reorder (`ORQ/packages/ui/src/lib/agent-chat/queue.logic.ts:1-30,89`, `keybindings.logic.ts:55-58`). | M | M |
| **Multi-model send** (Shift-click models in a new thread picker; one thread and worktree per model) and **start in background** (`Cmd+Enter` opens the next draft) | `T3/apps/web/src/components/chat/useMultipleModelSend.ts`, `docs/user/thread-sidebar.md` "Start in the background" | **Missing** (no matches for `multiModel`/`MultipleModel`). Workflows can fan out, but not from the composer. | M | M |
| **Thread sidebar organisation**: pin, drag reorder across Pinned/Active/Settled, settle, snooze, five-second Undo plus `mod+z`, hover card, drop files on a thread row | `T3/apps/web/src/components/Sidebar.tsx`, `Sidebar.drag.ts`, `Sidebar.snooze.ts`, `sidebar/SidebarThreadRow.tsx`, `ThreadHoverCard.tsx`, `T3/apps/web/src/hooks/threadUndo.ts` | **Partial.** Agent cards are grouped by repo, with status dot, unread, limited marker and recede (`ORQ/packages/ui/src/components/sidebar/OpenedAgents.tsx:41-110`). No pin, reorder, snooze, settle or undo. This overlaps with the session-model analyst. | M | L |
| Voice input | `T3/packages/client-runtime/src/voice-input/controller.ts`, `T3/apps/mobile/src/native/voiceTranscription.ios.ts` | **Missing**, but T3 ships it **only on iOS mobile**. `T3/apps/web` has no voice code. | L | M |

---

## 2. They do it better

1. **LaTeX coverage and cost (new, `cb0553ea`).** Both use KaTeX. T3 parses `$…$`, `$$…$$`, `\(…\)`,
   `\[…\]` and fenced ```` ```math ````, including inside tables
   (`T3/packages/shared/src/markdownMath.ts:14-67`, `mayContainMath` checks `\(` and `\[`). It
   lazy-loads KaTeX as its own chunk with a 1,000-entry, 4 MiB LRU of typeset HTML so remounts
   don't re-typeset (`T3/apps/web/src/components/chat/MathTypeset.tsx:1-40`). Copying a formula
   copies its TeX (`data-markdown-copy`, `MarkdownMath.tsx:18-30`). Formulas get `role="group"`
   and keyboard-scrollable overflow. Rendering is opt-in in Appearance settings. Orquester
   handles only `$` (`ORQ/.../timeline/markdown/math.ts:213-215`, `mightContainMath` = `includes("$")`)
   and imports `rehype-katex` statically (`ChatMarkdown.tsx:3`). GPT/Codex-style `\( \)` and `\[ \]`
   output therefore renders as raw TeX. Orquester's Pandoc-style dollar rules (`math.ts:1-35`)
   are good, and T3 now matches them ("`$5 and $10` stay text").
2. **Mermaid weight (new, `fcb20e49`).** T3 replaced `mermaid` with `pele`, which loads per
   diagram type (`T3/apps/web/src/components/chat/MermaidDiagram.tsx:1-35`) and pulls KaTeX in
   only for diagrams with math. The commit removed about 790 lockfile lines. Orquester lazy-loads
   all of `mermaid` (~1 MB, `ORQ/.../markdown/mermaid-engine.ts:6-8`). Orquester's
   lazy loading, render-cache and retry logic is solid, so the remaining gain is bundle size.
3. **User messages render Markdown.** T3 user bubbles go through `ChatMarkdown`
   (`TimelineUserMessageRow.tsx:19`), so pasted code blocks, lists and links render. Orquester
   renders user text as `whitespace-pre-wrap` with only skill and forge-link chips
   (`MessageRows.tsx:113-160, 312-345`).
4. **Composer typing performance (new: `c19d9977`, `17e62e74`, `b34f74cd`).** T3 split
   `ChatComposer` into hooks and leaf components so a keystroke doesn't re-render the model,
   traits picker or attach button. They enforce React Compiler coverage with a test
   (`T3/apps/web/src/reactCompilerCoverage.test.ts`; `docs/internals/web-ui.md` "Handlers in large
   components"). Orquester's `ChatComposer.tsx` is one 2,199-line component that holds `draft.text`
   in `useState`. None of `ComposerChips`, `ComposerPrimaryActions`, `ComposerAttachments`,
   `ProfileChip`, `RewindControl` or `ComposerQuotes` is memoised (grep for `memo(` finds nothing),
   so every keystroke re-renders the whole footer.
5. **Sidebar under streaming (new, `5a0d1594`).** "A streaming thread re-renders only its own
   sidebar row." Orquester's `OpenedAgents` derives cards from the session list in one component
   (`OpenedAgents.tsx:190-240`). I did not profile this; it is worth checking with React Profiler
   during a long stream.
6. **Long-thread scaling.** T3 virtualises with `@legendapp/list`
   (`T3/apps/web/src/components/chat/MessagesTimeline.tsx:39`). Its server opens a thread with
   about 75 rows or 1 MiB, pages older history, and streams command output only to expanded rows
   (`T3/docs/internals/performance-regressions.md`). Orquester chose a plain scroller with
   `content-visibility` and "Load older turns" (`ORQ/.../timeline/ChatTimeline.tsx:56-60, 120-145`).
   That is fine for today's tab-bounded threads, but it has no ceiling. Tool output bodies ship
   inline in the row (`ActivityRows.tsx:123`).
7. **Attachment limits and intake.** T3 accepts 100 files per message (10 MiB per image, 80 MiB of
   images per message). It converts HEIC to JPEG, resizes oversize photos
   (`T3/apps/web/src/lib/imageCompression.ts`), and treats a pasted or dropped folder as a
   workspace reference (new, `be56049f`; `chat/folderDrop.ts`). Orquester caps a turn at 8
   attachments (`ORQ/packages/api/src/agent-chat/adapter-types.ts:139`) and has no image
   normalisation.
8. **Code blocks in the composer** (new perf fix `09792213`) and code-block language picking are
   T3-only, because they depend on the rich editor.

---

## 3. Worth copying (ranked by value/effort)

1. **Send while an approval is pending: decline, then redirect** (H/S, new).
   - Change `pendingRequestBlocksSend` in `ORQ/packages/ui/src/components/agent-chat/composer/composer-submission.ts:401-444`
     so it blocks only for *questions*. For approvals, make the send decline every live approval
     through the existing respond action (`AgentChatActions` in `lib/agent-chat/contracts.ts`),
     then send the turn as a steer.
   - Keep Orquester's own MCP `ToolApprovalCard` guards as they are.
   - Crib from `T3/packages/client-runtime/src/state/threadRequests.ts:20-35` and
     `T3/apps/web/src/components/chat/useComposerSend.ts:~960-1000`.
   - Add tests next to `composer-submission.test.ts`.
2. **`\(…\)`, `\[…\]` and ```` ```math ```` in chat Markdown, plus lazy KaTeX and copy-as-TeX** (M/S).
   - In `ORQ/.../timeline/markdown/math.ts`, add a delimiter pre-pass, or a micromark construct,
     for `\(`/`\[`, and extend `mightContainMath` to match.
   - In `ChatMarkdown.tsx`'s `MarkdownCode`, route `language-math` fences to display math.
   - Crib `T3/packages/shared/src/markdownMath.ts`, `T3/apps/web/src/components/chat/MarkdownMath.tsx`
     and `MathTypeset.tsx` (LRU, `data-markdown-copy`).
   - Add cases to `math.test.ts`.
3. **Approval reason (Claude `decisionReason`)** (M/S, new).
   - Daemon: in `ORQ/apps/daemon/src/agent-host/adapters/claude/` (where the approval request is
     built from the permission callback or `can_use_tool` frame), carry the
     `stripVTControlCharacters`'d reason and an ask-rule/provider-check flag onto the
     request-opened payload.
   - Add the optional field in `ORQ/packages/api/src/agent-chat` request types, and render it in
     `banners/ApprovalCard.tsx` via `approval-detail.ts`.
   - Crib `claudeApprovalPresentation` (`T3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2840`).
     Read the provider fixture README first and add a replay fixture.
4. **Prompt recall (ArrowUp/Down)** (M/S).
   - Add a pure `composer-recall.ts` beside `composer-trigger.ts` that walks the thread's user
     rows (excluding agent- and thread-authored messages via `isThreadAuthoredMessage`).
   - Hook it in `onTextareaKeyDown` (`ChatComposer.tsx:1795`) only when the draft is empty or an
     unedited recall and the caret is on the first or last line. A textarea makes this simpler
     than in T3.
   - Crib `T3/apps/web/src/components/chat/composerPromptHistory.ts` (`stepComposerPromptHistory`)
     and its tests.
5. **Markdown polish pack: table copy (Markdown/CSV), GitHub alerts, file links with line jump**
   (M/S each).
   - Tables: wrap `table` in `ChatMarkdown.tsx`'s `COMPONENTS` with a header bar (crib
     `T3/apps/web/src/components/chat/MarkdownTable.tsx:42-161`).
   - Alerts: a small remark plugin that tags `blockquote` nodes starting `[!NOTE]` and similar,
     rendered by the `blockquote` component, with no raw HTML (crib the presentation table at
     `T3/apps/web/src/components/ChatMarkdown.tsx:~355-375,972-990`).
   - File links: parse `:line` and `#Lnn` in `MarkdownLink` and extend `FileReveal` in
     `ORQ/packages/ui/src/store/app.ts:2926` with a line, so `AgentChatView.openFile` opens the
     file at that line instead of only revealing it (crib `MarkdownFileLink.logic.ts` and
     `T3/apps/web/src/markdown-links.ts`).
6. **`@` thread mentions** (M/S–M).
   - Extend `ComposerMenuItem` in `composer-menu.ts` with a `thread` item sourced from the app
     store's sessions, filtered to agent chats in the same project and fuzzy-matched on title.
   - Insert a readable token such as `@thread:"Title" (id)`. The daemon's provider projection
     then appends a hint to call the existing `read_transcript` MCP tool for that id. Render the
     token as a chip in `MessageBodyText`, as skills are today.
   - Crib `matchComposerThreadItems` (`useComposerMenuItems.ts`) and
     `T3/apps/web/src/lib/threadContextAttachment.ts`.
7. **In-thread find (`Cmd/Ctrl+F`)** (M/M).
   - Orquester has no virtualiser, so the DOM is complete apart from collapsed tool rows. Build a
     `ThreadFindBar` in `timeline/` that walks `[data-row-id]` text nodes and paints with
     `CSS.highlights`. Collapsed `Disclosure` panels open on a match, via
     `hidden="until-found"`/`beforematch` or by expanding them explicitly.
   - Register the key in `lib/agent-chat/keybindings.logic.ts`.
   - Crib `T3/apps/web/src/components/chat/threadFindHighlights.ts`, `ThreadFindBar.tsx` and
     `useThreadFindNavigation.ts`.
8. **Workflow-authored prompts as compact rows** (M/S, new).
   - Have the workflow agent and send blocks stamp a context record (for example
     `kind: "workflow-message"` with run and workflow ids) in `ORQ/packages/api/src/agent-chat/thread-tools.ts`
     next to `THREAD_MESSAGE_CONTEXT_KIND`.
   - Render a folded "Workflow · <name>" row in `MessageRows.tsx`, reusing `ClampedBubbleText`.
   - Crib `AutomationMessageRow` (`T3/apps/web/src/components/chat/TimelineUserMessageRow.tsx:132-250`).

Next tier (higher effort): terminal-excerpt and diff-comment context into the composer, using the
`composer-bridge` `insertText`/`stageAttachment` path at first and real chips later. Also image
thumbnails and a lightbox for sent attachments, with lazy fetch on visibility so the
mobile-memory concern in `MessageRows.tsx:80-85` still holds. And memoising the composer footer
chips: wrap them in `React.memo` and pass stable callbacks, which is the cheap version of T3's
split.

---

## 4. We do it better / they lack

- **Approval safety.** `ToolApprovalCard` never autofocuses. `Cmd+Enter` approval is ignored for
  1.5 s after a card appears, double-clicks are guarded, Approve stays disabled until a cut preview
  is fully loaded, and secret fields are masked and cleared after the answer is sent
  (`ORQ/.../banners/ToolApprovalCard.tsx:1-27`). There is also "Deny with a reason…". T3's panel
  has none of these guards.
- **Subagent roster and drill-in.** The roster, `AgentDrillIn`, `DelegateGroupRow` and
  background-shell drill-in (`ORQ/.../roster/*`, `timeline/rows/DelegateGroupRow.tsx`) go beyond
  T3's `ProviderSubagentBar`. Thread lineage (fork, merge-back, delegated) is shown inline
  (`ThreadLineageBar.tsx`, `mergedBackCaption`).
- **Esc Esc rewind picker.** `RewindControl.tsx` (438 lines) lets you rewind from the keyboard.
  T3 only has the per-message "Edit from here" button. Fork-from-here exists on both user and
  assistant rows (`MessageRows.tsx:227, 556`).
- **`[Image #N]` placeholders** in the composer, which renumber when an image is removed
  (`composer/composer-images.ts`). This matches the Claude CLI's convention, and T3 has no
  equivalent in a plain-text path.
- **Host slash commands.** Orquester has `/effort` and host-parsed `/goal` with argument hints
  (`composer-menu.ts:41-62`); T3's built-ins are `/model`, `/plan` and `/default`. The Goal chip
  and context meter are on par or better (`status/GoalChip.tsx`, `status/ContextMeter.tsx`).
- **Forge link pills** for GitHub, GitLab and Bitbucket in both assistant and user text
  (`forge-links/ForgeLinkPill.tsx`). T3 has a GitHub-centric PR chip.
- **Scroll memory per tab**, including the scroll offset inside an expanded tool output
  (`ActivityRows.tsx:139-153`), plus a named two-frame settle latch instead of timers
  (`ChatTimeline.tsx:536-545`). This is comparable to T3's `useTimelinePositionRestore` and finer
  inside tool output.
- **Safer Markdown.** No raw HTML at all (`ChatMarkdown.tsx:24-30`), and local images are read
  through the authenticated file API (`timeline/markdown/local-image.ts`).
- **Right-rail prompt history and saved prompts**, with Insert, Send, Jump and Save-as-prompt
  (`right-rail/history/PromptCard.tsx`). This partly covers T3's minimap, recall and stash in one
  panel.
- **Agent Profiles and account chips** in the composer (`composer/ProfileChip.tsx`,
  `ComposerChips.tsx`) have no T3 counterpart.
- **Parity, not gaps:** question attachments and option previews (`banners/QuestionCard.tsx:35-60`);
  steer or queue follow-up preference (`lib/chat-prefs.ts`); large paste to file
  (`composer-submission.ts` `pastedTextDisposition`); HTML visual replies and MCP apps
  (`visual/*`, `mcp-app/McpAppFrame.tsx`); plan card with copy, download and Implement
  (`timeline/rows/StructureRows.tsx:261-330`); incremental streaming Markdown
  (`markdown/incremental.ts`); code-block wrap and copy (`markdown/CodeBlock.tsx`); unread state
  (per device by design, `lib/thread-visits.ts`, where T3 syncs it server-side).

## Verification notes

- Every claim was checked by reading or grepping source on both sides. T3 docs were used only to
  find the code.
- I did not run either app. The performance points in §2.4 and §2.5 are inferred from code
  structure (no memoisation, single component) and from T3's commit messages, not measured.
- T3's git history starts at `e8d87689`, so features already present there (find, minimap,
  stash, recall, citations, prompt links) are **not** marked (new). Only commits inside
  `e8d87689..ed9b7ca9` are.
