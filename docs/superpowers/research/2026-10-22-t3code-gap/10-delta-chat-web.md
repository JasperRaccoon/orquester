# T3 Code delta (ed9b7ca9..66ee628e + v0.1.2): chat GUI, web UI, client performance

Analyst 10. This covers only T3's new range (`git log ed9b7ca9..66ee628e`, 111 commits) plus the
v0.1.2 release-note PRs in the same domain. Report 01 already covers the older gaps: find, the
minimap, context chips, `@` thread mentions, tables, alerts and so on. Its findings are not
repeated here.

Paths: `T3/` = `t3code_codebase/` at `66ee628e`. `ORQ/` = this worktree (`t3gap/integration` at
`09e2399a`). `UI/` = `ORQ/packages/ui/src`. Every status below was checked in source on both
sides. Nothing was built or run. The bundle numbers come from the existing `ORQ/apps/web/dist`
build (2026-10-23 17:40) and from the `pele@1.9.0` npm tarball. Both were measured as the sum of
the gzipped chunks.

## 1. Table

| Change | T3 evidence | Orquester status | Value | Effort |
|---|---|---|---|---|
| **Mermaid rendered with `pele`** instead of `mermaid` | `fcb20e49` (#21472), `c3540a78` (#22570). `T3/apps/web/src/components/chat/MermaidDiagram.tsx`: `pele/lazy` loads one chunk per diagram type. KaTeX loads only for `$$` labels. There is no serial queue, and `--pele-*` CSS variables carry the theme. `T3/apps/web/package.json:69` | **Have mermaid; missing pele.** `mermaid ^12.2.0` (`ORQ/packages/ui/package.json:38`) is lazily `import()`ed (`UI/components/agent-chat/timeline/markdown/mermaid-engine.ts`). It renders through a serial queue with a 64-entry LRU keyed by theme and source (`mermaid-render.ts:1-60`), and only knows a `default`/`dark` theme (`mermaid-render.ts:82`). It ignores our 7 colour schemes (`UI/lib/theme.ts:19`). | M | M |
| **Messages from other agents fold into one-line rows** | `f054d1b8` (#23135). In `T3/apps/web/src/components/chat/TimelineUserMessageRow.tsx`, `FoldedMessageHeader` shows the sender thread title and the first line, with expand on click. `folded = attribution === "agent"`, and find reveals the hidden body. | **Partial.** A caption ("Sent by / Reply from / Delegated by …", `UI/components/agent-chat/timeline/rows/MessageRows.tsx:44-56, 396-402`) sits over a full bubble clamped at `max-h-44` (`ClampedBubbleText`, `:312-350`). There is no one-line fold. | M | S |
| **Streamed reply text no longer re-renders ChatView** | `83f118a4` (#23117). The new `T3/apps/web/src/components/chat/ThreadTimeline.tsx` reads the live turn items, and ChatView reads "quiet" thread atoms (`T3/packages/client-runtime/src/state/threadDetail.ts`). | **Missing.** `AgentChatView` subscribes to the whole `slice` and `rows` (`UI/components/agent-chat/AgentChatView.tsx:247-248` → `UI/lib/agent-chat/hooks.ts:106-120`). `ChatComposer` is a plain, non-memo function (`composer/ChatComposer.tsx:264`) rendered by that view. The store notifies per event with no frame batching (`UI/lib/agent-chat/store.ts`). So every streamed delta re-renders the 1,589-line view and the 2,371-line composer, including every footer chip. | H | M |
| Visit marks during a reply don't re-render ChatView | `ee33c4c6` (#23124) strips `lastVisitedAt`/`updatedAt` from thread structure. | **N/A.** Visits are per-device localStorage (`UI/lib/thread-visits.ts`), not part of the thread slice. | – | – |
| Fewer allocations in streaming timeline scans | `f7f02d77` (#23739): `for…of entries()` becomes an index loop in `MessagesTimeline.logic.ts` `replaceStreamingMessageRows` and `session-logic.ts`. | **Missing.** We have the same ported loops: `UI/lib/agent-chat/rows.logic.ts:1856` (`replaceStreamingMessageRows`), `:1764` (`attachTrailingToolGroupsToAssistant`), and `entries.logic.ts:1440` (`replaceStreamingTimelineMessages`). | L | S |
| One reused collator for changed-file trees | `9828cad4` (#23776), `T3/apps/web/src/lib/turnDiffTree.ts` | **Missing.** We have the same pre-fix pattern in `UI/components/agent-chat/timeline/diff-tree.ts:46-49`, and similar calls in `UI/lib/opened-agents.ts:123` and `UI/lib/repo-groups.ts:50` (sidebar sorts). `UI/lib/saved-prompts/list.logic.ts:134` already uses a shared `Intl.Collator`. | L | S |
| **Screen readers hear when the open thread starts, needs you or finishes** | `eb1510d2` (#23752): `T3/apps/web/src/components/chat/ThreadActivityAnnouncer.tsx` (one `aria-live="polite"` region written straight to the DOM, deliberately without `role="status"` because Orca drops its updates) and `threadActivityAnnouncement.ts`, a pure transition function with 221 lines of tests. | **Missing.** The only live region in agent chat is the loading screen (`UI/components/agent-chat/ChatLoadingScreen.tsx:43-44`). The inputs exist: `useAgentChatStatus` and `useAgentChatPending` (`AgentChatView.tsx:253, 279`). | M | S |
| **Arabic/Hebrew right-to-left** | `3690c862` (#22777): `T3/apps/web/src/textDirection.ts` (word-count heuristic that beats `dir="auto"` for "English term + Arabic" lines), `components/chat/markdownTextDirection.ts` (per-block rehype plugin, inline code isolated as LTR), composer and sidebar `dir`, and logical CSS in `index.css`. | **Missing.** There is no `dir` attribute anywhere in `UI/components/agent-chat`. Markdown uses physical utilities (`ChatMarkdown.tsx:202-235`: `pl-5`, `border-l-2`, `text-left`). The composer `<textarea>` has no `dir` (`ChatComposer.tsx:2147`). | L–M | S |
| Cmd+K hides subagents and favours recent, whole-word matches | `4812dcad` (#24032): `T3/apps/web/src/components/CommandPalette.logic.ts` ranks exact, then prefix, then word-start over mid-word matches, with recency as the tie-break. | **Partial.** Matching is a substring test (`UI/components/command-palette/CommandPalette.tsx:128`). Results are sorted by project, then tab order, with no rank (`:298-351`). Delegated children are real tabs here, so listing them is consistent with the sidebar. | L–M | S |
| Cmd+B toggles the sidebar unless text is selected | `7d6b5bec` (#24063): `T3/apps/web/src/keybindings.ts`, `AppSidebarLayout.tsx`. | **Missing.** There is no desktop sidebar collapse at all: only the mobile drawer (`UI/store/app.ts:1946`) and the width (`:3446`). `UI/components/attention/GlobalShortcutListener.tsx` handles only Ctrl/Cmd+K and Ctrl+Shift+A. | L–M | M |
| Blockquote readable in every theme | `1df9c329` (#24036): `color: inherit`, border `color-mix(currentcolor 35%)`, `border-inline-start`. | **Partial.** Quotes use muted `text-neutral-400` with `border-l-2 border-neutral-700` (`ChatMarkdown.tsx:214-217`). `neutral` is remapped per scheme and mode (`UI/lib/theme.ts:6-9`), so contrast varies. | L | S |
| Tool images beyond the preview limit are marked | `f0559950` (#23595): `T3/packages/client-runtime/src/work-log/itemDetail.ts` writes `[image]` for each image not previewed. | **Missing, and worse.** Tool-output images are never previewed. `extractTextContent` keeps only text blocks, so image blocks vanish with no marker (`ORQ/apps/daemon/src/agent-host/adapters/claude/classify.ts:336-357`). | L (marker) / M (previews) | S / M |
| Thread-title instructions setting | `51273020` (#21882): `T3/apps/web/src/components/settings/ThreadTitleInstructionsSettings.tsx` and the server text-generation prompts. | **N/A by design.** There is no title-generation service (`UI/lib/agent-chat/title.logic.ts:8-9`). Titles are client-seeded, then retitled by the provider. | – | – |
| List layout passes capped (React error 185) | `05b697f6` (#23315): `T3/patches/@legendapp__list@3.3.5.patch` | **N/A.** We use no virtualiser, by design (`UI/components/agent-chat/timeline/ChatTimeline.tsx:59`, `UI/styles/agent-chat.css:748-755`). | – | – |
| Dialogs keep their content while closing | `5bc19ac6` (#21960): `RetainedWhileClosed` in `T3/apps/web/src/components/ui/dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx` | **N/A.** `UI/components/ui/modal.tsx` and `sheet.tsx` have no exit animation, so there is no blank closing frame to fix. | – | – |
| Thread links render as chips with the project icon | `15dc7b01` (#22621): `T3/apps/web/src/components/chat/MarkdownThreadLink.tsx`, `ThreadContextChip.tsx` | **Partial.** Session-tool rows link the target chat by its live tab title (`ThreadLink`, `UI/components/agent-chat/timeline/rows/ActivityRows.tsx:~425-455`), with no project icon. Session links in Markdown prose are not chipped. | L | S |
| **Composer: typing no longer re-renders the model and traits pickers or the attach button; `ComposerFooterControls` / `ComposerControlsBar`** | `94bce7f1` (#22720), `17e62e74` (#22721), `c19d9977` (#23040), #23058, #23093. Files: `T3/apps/web/src/components/chat/ComposerFooterControls.tsx`, `ComposerControlsBar.tsx` and about 20 `useComposer*.ts` hooks. T3 relies on React Compiler. | **Missing.** `ChatComposer.tsx` is still one 2,371-line component. `draft` and `cursor` live in `useState` (`:359-360`), so every keystroke and caret move re-renders `ModelChip`, `OptionChip`, `RuntimeModeChip`, `PlanChip`, `ProfileChip`, `AccountChip`, `RewindControl` and `ComposerPrimaryActions` (rendered inline at `:2250-2360`, none memoised). We run React 18 with no compiler (`ORQ/packages/ui/package.json:51`). | M | S–M |
| Timeline minimap and find reader | `76e4aac3` (#22662) and `bef9142f` (#22682) are file moves (`TimelineMinimap.tsx`, `useThreadFindPositionReader.ts`) with no new behaviour. | **Missing**, as in 01 §1. The range adds nothing to port. | (see 01) | – |
| **An instructed `/compact` runs without a bare compaction first** | `16aaf5ba` (#24008): `COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i` in `T3/apps/web/src/components/ChatView.logic.ts:934-936, 1545-1548` | **Missing: this is our bug.** The "When you return" offer sets `compactFirst` for any send (`UI/components/agent-chat/composer/ChatComposer.tsx:1703`), and `sendAfterCompaction` runs `command("compact")` first (`UI/lib/agent-chat/store.ts:1745`, `resume-compaction.logic.ts:55-60`). Typing `/compact` or `/compact <focus>` under the offer therefore compacts twice. A bare `/compact` is a host-native compaction (`ORQ/apps/daemon/src/agent-host/orchestration/slash.ts:39-51`); the instructed form reaches Claude after an uninstructed one. Found by reading the code, not reproduced. | M | S |
| Steers split a finished turn's work instead of stacking under it | `a8bb769d` (#22783): `steerSegments` in `T3/apps/web/src/components/chat/MessagesTimeline.logic.ts` `deriveTurnFolds`, plus 110 lines of tests | **Likely missing (not checked in the UI).** Our ported `deriveTurnFolds` (`UI/lib/agent-chat/rows.logic.ts:610-700`) skips every user message (`continue`) and keeps one group per fold key. Work after a steer therefore folds into the same "Worked for…" row above the steer. | M | M |

## 2. Worth copying, ranked

1. **Keep streamed deltas out of the chat view and the composer** (H/M; covers rows 3 and 17).
   - Give `ChatTimeline` its own subscription. Pass `sessionId` and read `rows` through
     `useAgentChatThreadSelector` (`UI/lib/agent-chat/hooks.ts:129`) inside the timeline, as T3's
     `ThreadTimeline.tsx` does.
   - In `AgentChatView`, replace `useAgentChatThread`'s whole `slice` with field selectors for
     what the view reads (`head`, `sessionStatus`, `turnStatus`, `queue`, `interactionMode`,
     `connection`, …). Reducer identity preservation already keeps those fields stable across
     deltas.
   - Wrap `ChatComposer` and the footer chips in `React.memo`, and pass stable callbacks through
     refs (the pattern already used for `readRecallItems`, `AgentChatView.tsx:256-258`). The
     cheap first step is memoising the footer chips: the composer then still re-renders while
     typing, but its chips don't.
   - Verify with the React Profiler during a long stream, and add a `.check.ts` render-count
     test like `composer-send-render.check.ts`.
2. **Fix compact-before-send for a typed `/compact`** (M/S).
   - In `ChatComposer.tsx:1703`, add `&& !/^\/compact(?:\s|$)/i.test(outgoing)`. Better, put it
     in a pure helper in `resume-compaction.logic.ts`, beside `sendAfterCompaction`.
   - Add tests for `/compact`, `/COMPACT focus on tests`, and `/compacting` (which must still
     compact first).
3. **Screen-reader thread announcements** (M/S).
   - Add a `ThreadActivityAnnouncer` under `UI/components/agent-chat/`: one `aria-live="polite"`,
     `sr-only` div that is written imperatively, so the timeline never re-renders.
   - Inputs: `useAgentChatStatus` (working/idle), `useAgentChatPending` (approval or question id)
     and the turn outcome.
   - Port the pure transition function `nextThreadAnnouncement` with its tests
     (`T3/apps/web/src/components/chat/threadActivityAnnouncement.ts`). Keep the
     trailing-NBSP trick for repeated "Done" and the reset on tab switch.
4. **Fold other agents' messages to one line** (M/S).
   - In `MessageRows.tsx` `UserMessageRow`, when `fromThread` or `markedThread` is set, render a
     header button with an icon, the sender title (already parsed: `fromTitle`) and the first
     non-empty line of the body. Expand on click, reusing `ClampedBubbleText` for the body.
   - Suggested rule: fold `sent`, `reply`, `opened` and `delegated` origins. Keep `attention`
     ("Needs input in") and merged-back results open, because those are what the user came to
     read.
   - Crib `FoldedMessageHeader` from `f054d1b8`.
5. **Swap `mermaid` for `pele`** (M/M; spike first, pin the version).
   - Gain, from our `apps/web/dist`: the first flowchart costs 12 chunks, 614 KB raw / about
     145 KB gzip (mermaid.core alone is 482 KB / 102 KB gzip), and a sequence diagram 723 KB /
     about 166 KB gzip. With `pele@1.9.0` `lazy`, a flowchart is 152 KB / about 62 KB gzip, a
     sequence diagram 126 KB / about 53 KB, and all diagram types together 716 KB / about
     294 KB.
   - Mermaid 12 also ships its own KaTeX 0.18. Two `katex-*.js` chunks of about 261 KB each are in
     dist; pele would reuse our KaTeX 0.16.
   - T3's PR benchmark: reload to 14 diagrams drawn went from 1,574 ms to 755 ms, and a theme
     switch costs no diagram re-render.
   - Pele themes through CSS variables, so diagrams could follow our 7 colour schemes instead of
     a binary default/dark.
   - Port: replace `mermaid-engine.ts` and `mermaid-render.ts` (queue, LRU, `initialize`) with
     `pele/lazy` `detectType`/`load`/`mount`. Keep `MermaidBlock.tsx`'s code toggle, expand and
     retry. Keep a DOMPurify pass (reuse `mermaid-svg.ts`, or crib T3's two sanitizer profiles,
     including the KaTeX MathML allowlist). Map `--pele-*` to our palette variables in
     `styles/agent-chat.css`. Rewrite the `mermaid-render`/`MermaidBlock` tests, and add pele (MIT)
     to the third-party notices.
   - Risks:
     - **Maturity.** The `pele` npm name dates from 2020, but the real 1.0.1 shipped on 2026-10-06.
       Seventeen releases came in 16 days, up to 1.9.0 on 2026-10-22.
     - **Provenance.** It is from Obsidian (`github.com/obsidianmd/pele`, MIT, © kepano), with
       zero runtime dependencies. It claims all Mermaid 12.1 diagram types, tested against
       Mermaid's parser specs plus differential fuzzing.
     - **Visual change.** It uses its own layout and visual style, so diagrams will look different.
     - **Second copy stays.** `mermaid@11` remains in the tree anyway, through
       `@excalidraw/mermaid-to-excalidraw` (`ORQ/pnpm-lock.yaml:6198-6202`, used by the
       whiteboard). Dist currently holds two copies of every Mermaid diagram chunk. That copy is
       lazy and separate from chat.
6. **RTL text** (L–M/S).
   - Port `textDirection.ts` (31 lines) and `markdownTextDirection.ts` (67 lines) as a
     `rehypePlugins` entry in `ChatMarkdown` (it passes only `remarkPlugins` today, `:296`).
   - Set `dir` from the same heuristic, or `dir="auto"`, on the composer textarea, user bubbles
     and tab titles.
   - Switch the markdown classes to logical utilities (`ps-5`, `border-s-2`, `text-start`).
7. **Palette ranking** (L–M/S). In `CommandPalette.tsx`, replace `matches` with a rank: exact,
   then prefix, then every token starting a word (crib `startsWord` and
   `rankSearchFieldMatch`). Sort by rank, then recent activity (`activityById`), then the
   current order. Keep delegated tabs listed.
8. **Small polish batch** (L/S each).
   - A shared lazy `Intl.Collator` in `diff-tree.ts`, `opened-agents.ts` and `repo-groups.ts`.
   - Index loops at the three streaming scans named in row 5 of the table.
   - Blockquote `text-inherit` with a logical, currentcolor border.
   - An `[image]` placeholder in `claude/classify.ts` `extractTextContent`. This changes
     normalised output, so read the provider fixture README and update the replay fixtures.
     Real tool-image previews (agent-browser screenshots) are a separate M/M feature.
9. **Steer-split folds** (M/M; first confirm the symptom in a thread with a mid-turn steer). Add
   T3's `steerSegments` to `deriveTurnFolds` in `rows.logic.ts`, with the back-to-back steer
   rule, and port the 110 lines of tests from `a8bb769d`.
10. **Sidebar collapse with Cmd+B** (L–M/M). This first needs a collapsed desktop sidebar state in
    `store/app.ts` and the layout. Bind it in `GlobalShortcutListener.tsx`, skipping when text is
    selected. Ctrl+B is the tmux prefix in our terminal panes, so bind Cmd+B on macOS only, or
    respect `insideShortcutBailZone` for terminals.

## 3. Skip, and why

- **Thread-title instructions:** we have no title generator to instruct (`title.logic.ts:8-9`).
  Adding one would be a new service, not a port.
- **React error 185 layout-pass cap:** this is a `@legendapp/list` patch; we don't virtualise.
- **Dialogs keep content while closing:** this fixes a Base UI exit-animation blank frame; our
  modals don't animate out.
- **Hiding subagents in Cmd+K:** in T3 subagents are sidebar-hidden threads. Ours are open tabs
  the user can see, so hiding them in the palette would be inconsistent.
- **Thread links as chips with the project icon:** this is low value. Our tool rows already link
  chats by live title, and agents rarely write session links in prose. Revisit with 01's `@`
  thread mentions.
- **Minimap and find-reader refactors, the ChatView, palette and settings file splits**
  (#22662–#23101): these are structure-only. The behaviour gaps stay as listed in 01.
- **Visit-mark re-render fix:** not applicable, because our visits are not in the thread slice.
- Out of domain or T3-specific, not assessed in depth: toast accordion width (#23777), paused
  sidebar videos (#23106), offline machine on new thread (#23967), provider-update toasts
  (#23233), sidebar route-follow after history navigation (#23519; we use tabs, not routes),
  narrow subagent bar (#23502; our roster differs), task-duration wrap (#13472).
