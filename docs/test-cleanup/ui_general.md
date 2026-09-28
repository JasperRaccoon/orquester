# Shared UI test cleanup

Completed cleanup record (decisions recorded before edits; validation appended after execution). Child reports cover `ui_general_prompt_history.md` and `ui_general_saved_prompts.md`.

For each retained isolated unit, the **failure modes** below were listed first. The numbered retention bar is shared only by the explicitly enumerated KEEP/REWRITE cases in that file; each case name identifies its distinct observable expected outcome. No case is retained merely for coverage.

## `packages/ui/src/components/attention/GlobalShortcutListener.test.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/open-layers.test.ts: opening, nesting, idempotent release; agent-chat/escape-layers.test.ts owns Escape decisions
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Thin composite gate is exercised only with the open-layer input, duplicating registry behavior; it never drives a keyboard event.

- **DELETE** `with nothing up, no other layer owns the keyboard` — Thin composite gate is exercised only with the open-layer input, duplicating registry behavior; it never drives a keyboard event.
- **DELETE** `an open modal, sheet, menu or popover owns the keyboard until it closes` — Thin composite gate is exercised only with the open-layer input, duplicating registry behavior; it never drives a keyboard event.

## `packages/ui/src/components/command-palette/conversation-search-render.check.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: conversation-search.test.ts owns prefix, snippet protocol, unavailable/error and loading states
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Static markup, role counts, exact presentation text and prop echoes; no user interaction occurs.

- **DELETE** hit count/title/project/speaker/highlight/time/selection markup.
- **DELETE** unavailable/empty/error/truncated notice copy and button markup.
- **DELETE** mode-chip pressed/label markup.

## `packages/ui/src/components/command-palette/conversation-search.test.ts`

Production callers/seam: CommandPalette.tsx and ConversationSearchResults.tsx
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: 2026-09-23-thread-index-and-lazy-boot-design.md §C Search and Client: ? mode, 200-character query, «» snippets, indexed=false vs failures, results during debounce.
Isolated-unit failure modes: wrong query mode, corrupted search text, oversized query, swallowed unclosed snippet, unavailable/error confusion, lost prior results, hidden failure or truncation.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Remove empty-segment implementation shape, speaker copy, duplicated retry prose, and a nonempty-string smoke assertion.

- **KEEP** `switches to search when `?` is typed first, and keeps the rest as the query` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `leaves an ordinary query alone` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `treats a `?` typed inside the mode as text` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `trims, and sends nothing for blank input` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `never sends more than the host would read` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `splits a snippet on its «marks»` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `keeps a snippet without marks, or with an unclosed one, as plain text` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `drops empty segments` — Remove empty-segment implementation shape, speaker copy, duplicated retry prose, and a nonempty-string smoke assertion.
- **DELETE** `names who spoke on a message hit` — Remove empty-segment implementation shape, speaker copy, duplicated retry prose, and a nonempty-string smoke assertion.
- **DELETE** `names an activity hit by its kind's family` — Remove empty-segment implementation shape, speaker copy, duplicated retry prose, and a nonempty-string smoke assertion.
- **REWRITE** `says the index is unavailable only when the host answers `indexed: false`` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `never reads an HTTP error as an unavailable index — it is a failure worth retrying` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `tells a host it could not reach apart from a host that answered badly` — Remove empty-segment implementation shape, speaker copy, duplicated retry prose, and a nonempty-string smoke assertion.
- **REWRITE** `says there are no matches, rather than showing nothing` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `shows the previous results while the next search runs` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `surfaces any other failure in words` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `invites a query before there is one` — Remove empty-segment implementation shape, speaker copy, duplicated retry prose, and a nonempty-string smoke assertion.
- **KEEP** `says when more matched than it shows` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/components/command-palette/reveal-turn.test.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/agent-chat/store.history.test.ts reveal existing/paged/synchronized/missing turns; store.test.ts registry release generations; store.retention.test.ts remount/TTL
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Tests the retain/reveal/release wrapper through private registry peeks and disposal timing, duplicating the stronger store owner.

- **DELETE** `reveals on the thread's registry slice, then lets go of it` — Tests the retain/reveal/release wrapper through private registry peeks and disposal timing, duplicating the stronger store owner.

## `packages/ui/src/components/right-rail/dock-keyboard.test.ts`

Production callers/seam: RightRailDock.tsx calls dockKeyAction
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI keyboard isolation requirement (§7.4/§7.7) and reported Escape-under-overlay regression.
Isolated-unit failure modes: dock Escape interrupts chat; consumed/IME/repeated Escape leaves dock; portal key reaches wrong owner; digit answers a chat question.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.

- **KEEP** `an Escape nothing inside the dock handled leaves the dock` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `an Escape the panel consumed (the search field clearing itself) stays the panel's` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `an Escape an open dropdown, menu or dialog of the panel closes is that layer's alone` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `the layer question is asked only for an Escape that would otherwise leave` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **KEEP** `an IME composition's Escape cancels the composition, nothing else` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a held Escape leaves once: its auto-repeat is not another press` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `keys from a portaled child (a dropdown the panel opened) are never the dock's` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `every other key typed in the dock is contained there` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `the layer question sets the dock's own layer aside, and puts it back` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `focus the dock's element lost to a removal, a disable, hidden or inert comes back to the dock` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `focus the user took away is theirs: the dock lets go` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `a field focused as the panel mounts is recorded by the first look: its removal returns focus to the dock` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `a dock root that refuses focus lets the layer go rather than holding it for nobody` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `focus moving inside keeps the layer; focus taken to another element releases it` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `focus that goes nowhere is decided once the commit is done` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.
- **DELETE** `focus that landed on another element outside is never pulled back, whatever became of the last one` — Delete private layer re-registration/call-count checks and focus tracker simulations whose fake DOM implements focus and selector semantics; this is not a browser focus test.

## `packages/ui/src/components/right-rail/history/history-format.test.ts`

Production callers/seam: PromptCard.tsx, CheckpointCard.tsx, HistoryParts.tsx call previewText
Remaining stronger coverage: lib/prompt-history/index-cache.test.ts owns cache states/retry/search paging; checkpoints.logic.test.ts owns diff data; timestamp-format tests own dates
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Prompt data must remain valid Unicode when shortened; history preview bounds a pasted log instead of duplicating its full text.
Isolated-unit failure modes: splitting an emoji creates an invalid text prefix; collapsed prompt retains a 200KB log.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.

- **DELETE** `says which turn the prompt started, a steer, or just when` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `names the day once the prompt is older than today` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `counts files, and says the lines in full for its tooltip` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `says what an Insert or a Send did, or why it could not` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `maps the cache's states onto the list's edges` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `says the host is still indexing while it asks by itself, and offers Retry once it gave up` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `reads a search's own paging, and only while a search is typed` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `keeps a short text whole` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **REWRITE** `cuts a long one — a pasted 200 KB log becomes a few hundred characters` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `never ends on half a surrogate pair` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `offers the next step, or what is left` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.
- **DELETE** `quotes the query as typed, trimmed` — Delete exact prose, presentation wrappers, duplicated cache-to-view shapes, and redundant short-text pass-through.

## `packages/ui/src/components/right-rail/history/history-panel-render.check.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/prompt-history/*.test.ts
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Static markup snapshots, classes, order/count assertions, exact copy, or stubbed prop echoes; no critical workflow is exercised.

- **DELETE** no-chat and loading markup.
- **DELETE** prompt-card collapsed/expanded/actions/preview/phone classes.
- **DELETE** whole-text/rewind/feedback copy and button states.
- **DELETE** checkpoint origin/files/count/card markup.
- **DELETE** PromptsBody loading/fallback/retry/paging/render-limit/empty-search markup.
- **DELETE** turn-diff loading/empty/error/inline markup.

## `packages/ui/src/components/right-rail/right-rail-render.check.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: right-rail-state.test.ts and dock-keyboard.test.ts
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Static markup snapshots, classes, order/count assertions, exact copy, or stubbed prop echoes; no critical workflow is exercised.

- **DELETE** registry Component/title identity.
- **DELETE** icon button counts/order/classes/ARIA.
- **DELETE** dock style/resize separator/header/marker and fake panel props.
- **DELETE** mobile section button count/order/copy and fake props.
- **DELETE** row content placement/isolation and open-project helper.

## `packages/ui/src/components/right-rail/workflows/workflows-panel-render.check.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/workflows/list.logic.test.ts and workflow store tests
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Static markup snapshots, classes, order/count assertions, exact copy, or stubbed prop echoes; no critical workflow is exercised.

- **DELETE** workflow-card summary/badges/stats/control markup.
- **DELETE** running/error/paused/new workflow card presentations.
- **DELETE** panel search/filter/count/footer.
- **DELETE** starter/empty/error/loading/notice copy and disabled markup.

## `packages/ui/src/components/right-rail/keyboard-surface-wiring.test.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/open-layers.test.ts, lib/agent-chat-active-tab.test.ts and agent-chat keyboard decision suites
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.

- **DELETE** `stripping comments drops a commented-out gate` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `the composer's chords stand down in a surface, before any chord is resolved` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `an Escape a layer takes resets the composer's Esc-Esc count before the surface gate returns` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `the timeline's Ctrl/Cmd+J stands down in a surface` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `the question card's digits stand down for a key some surface owns, before one is read` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.

## `packages/ui/src/components/ui/open-layer-wiring.test.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/open-layers.test.ts, lib/agent-chat-active-tab.test.ts and agent-chat keyboard decision suites
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.

- **DELETE** `stripping comments leaves code and drops both kinds of comment` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `the hook holds the layer while open and releases it on close and on unmount` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `each overlay holds its layer with the right argument — one live call, never commented out` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `every portaled overlay that closes on Escape holds one — the palette too, and the gate reads it by name as well` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `final wave (2): the Dropdown closes on its dismiss event while open, and the chat's popovers ask for it` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.
- **DELETE** `micro-fix: the composer's popover closes on its thread being LEFT — the same rule` — Source regexes depend on private identifiers/call order; own comment-stripping helper tests only support that change detector. Renames fail without behavior changes.

## `packages/ui/src/components/right-rail/right-rail-state.test.ts`

Production callers/seam: RightRailFrame.tsx, RightRailDock.tsx, useRightRailState
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: AGENTS.md field-wise tolerant localStorage validation; persisted orquester:right-rail v1 schema and React useSyncExternalStore snapshot contract.
Isolated-unit failure modes: bad stored JSON crashes rail, malformed field discards valid fields, newer versions reset selection, toggle/drag not persisted, storage denial breaks interaction, stale snapshot prevents re-render.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Remove geometry/CSS formulas and lazy-read cache implementation check; retain storage contracts without reset/injection seam and without exact write-count assertions.

- **REWRITE** `nothing stored, or garbage stored, loads the defaults` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `a well-formed payload round-trips` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `each field is validated on its own: one bad field never costs the others` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `the workflows panel is a panel like the others` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `a stored width is clamped into range, and a nonsensical one is dropped` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a payload written by another version is still read field by field` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `the width cap leaves the tab content its floor, even below the dock's minimum` — Remove geometry/CSS formulas and lazy-read cache implementation check; retain storage contracts without reset/injection seam and without exact write-count assertions.
- **DELETE** `the CSS bounds are the cap's rule, resolved against the row by the browser` — Remove geometry/CSS formulas and lazy-read cache implementation check; retain storage contracts without reset/injection seam and without exact write-count assertions.
- **DELETE** `clamping rounds, bounds and caps against the row` — Remove geometry/CSS formulas and lazy-read cache implementation check; retain storage contracts without reset/injection seam and without exact write-count assertions.
- **REWRITE** `load and save swallow storage errors and missing storage` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `the store loads once from storage, lazily` — Remove geometry/CSS formulas and lazy-read cache implementation check; retain storage contracts without reset/injection seam and without exact write-count assertions.
- **REWRITE** `toggling opens, switches and closes the dock — and persists every change` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `a live drag updates the state only; the release persists it` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `subscribers hear real changes only, and can unsubscribe` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `a storage that throws never breaks the store` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/components/system/session-owner.check.ts`

Production callers/seam: system/SessionChip.tsx
Remaining stronger coverage: session-nav tests own path resolution; this seam uniquely joins session ID to visibility and title
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Archived-data curtain from session navigation contract; README project/workspace session ownership.
Isolated-unit failure modes: unknown/archived/no-project session exposes title; visible process cannot navigate to project.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

- **ASSERTION FAMILY** visible session resolves its own title/project.
- **ASSERTION FAMILY** archived project/workspace, missing project, unknown ID resolve null.
- **ASSERTION FAMILY** project-list absent resolves workspace/project from path.

## `packages/ui/src/components/system/system-format.check.ts`

Production callers/seam: system/ProcessTree.tsx and system/index.ts
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: GET system/processes parent/PID/RSS data contract; KillProcessErrorCode protocol.
Isolated-unit failure modes: tmux children disappear, incorrect subtree kill target/RSS, cyclic or self parent crashes recursive render, refusal code erased.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete byte/percentage prose, bar geometry and kill-message copy. Keep process forest and API error code data only.

- **ASSERTION FAMILY** DELETE: bytes/percent copy and bar widths.
- **ASSERTION FAMILY** KEEP: orphan/tmux forest edges, subtree PID kill targets, RSS totals.
- **ASSERTION FAMILY** KEEP: cycle and self-parent safety.
- **ASSERTION FAMILY** DELETE: empty array smoke.
- **ASSERTION FAMILY** KEEP: recognized kill error codes and unknown/network/null fallbacks.
- **ASSERTION FAMILY** DELETE: process label and refusal-copy comparisons.

## `packages/ui/src/components/topbar/usage-format.check.ts`

Production callers/seam: topbar usage chip/panel via usage-format exports
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: README usage widget selecting daily/session/weekly provider data; UsagePrefs enabled-agent settings; AgentUsage scopedWindows/capacity protocol.
Isolated-unit failure modes: wrong pinned/busiest agent, disabled/missing login hint wrong, scoped model cap lost, real capacity numbers lost.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete countdown/age/agent labels, color classes, exact formatted copy, duplicate unit helpers and expectation derived from formatter; keep selected agent and window data.

- **ASSERTION FAMILY** KEEP: busiest/pinned/absent-pinned/empty driver.
- **ASSERTION FAMILY** DELETE: countdowns/color classes/duplicate windowMax/chip and registry copy.
- **ASSERTION FAMILY** DELETE: age helpers.
- **ASSERTION FAMILY** KEEP: default-enabled/explicit-disabled/present/master-off missing usage agents.
- **ASSERTION FAMILY** REWRITE: normalize only present/shared/scoped window data, credit unit/capacity and reset timestamp.
- **ASSERTION FAMILY** DELETE: long-label copy/future wire-field intrusion/compact numbers/locale-derived amounts/reset formatter restatement.

## `packages/ui/src/components/topbar/usage-format.test.ts`

Production callers/seam: store/app.ts provider usage updates and topbar usage cards
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: ProviderUsageLimitsUpdate sparse-by-ID protocol and GUI deduplication of polled/provider windows.
Isolated-unit failure modes: sparse/empty update erases weekly quota; same pool rendered twice.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete seed duplicate, presentation order/namespacing, geometry clamp and monthly label mapping.

- **DELETE** `the first update seeds the list` — Delete seed duplicate, presentation order/namespacing, geometry clamp and monthly label mapping.
- **KEEP** `a sparse update replaces only the windows it names` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a known window keeps its slot and a new one lands at the end` — Delete seed duplicate, presentation order/namespacing, geometry clamp and monthly label mapping.
- **KEEP** `an empty update is a no-op, not a reset` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `provider windows project into presentation rows with a namespaced id` — Delete seed duplicate, presentation order/namespacing, geometry clamp and monthly label mapping.
- **KEEP** `a window the daemon's own poll already covers is dropped, not printed twice` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `an out-of-range percentage is clamped rather than blowing the bar out` — Delete seed duplicate, presentation order/namespacing, geometry clamp and monthly label mapping.
- **DELETE** `a monthly window reads as a period bar; an unknown kind falls back to rolling` — Delete seed duplicate, presentation order/namespacing, geometry clamp and monthly label mapping.

## `packages/ui/src/components/ui/dropdown-logic.test.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: lib/agent-chat-active-tab.test.ts retains real tab dismissal subscription; no visual-regression requirement
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.

- **DELETE** `a panel that fits keeps its anchor exactly as before` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `before the panel is measured it takes the anchor — the measurement corrects it before paint` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `the goal popover on a 360px phone: a right-aligned panel that would leave the left edge is pulled inside` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `a left-aligned panel that would leave the right edge is pushed back inside` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `a panel wider than the viewport pins to the margin, and its max width is the viewport less both margins` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `the result is always inside the viewport's margins, for any trigger and any width` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `is a menu by default, exactly as before — no label, not focusable itself` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `a readout with plain buttons is a labelled dialog, focusable itself when it has no control` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `focus lands on the panel's first control, or on the panel itself when it has none` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `fix round 2: never auto-focuses a destructive control — the panel takes focus instead` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `only enabled, reachable controls count as the first one` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `an open panel subscribes, and the event dismisses it` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.
- **DELETE** `a closed panel, or one with nothing to watch, subscribes to nothing` — Geometry plus DOM-prop assembly, selector-string inspection and fake querySelector that returns the arranged focus target; fake subscription restates wrapper.

## `packages/ui/src/lib/agent-auth-notice.test.ts`

Production callers/seam: store/app.ts auth sink/dismissal actions
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI §7.7 provider auth notice dismissal regression: repeated snapshot must stay dismissed; changed provider/verdict/message must show.
Isolated-unit failure modes: undismissable re-published toast or suppressed distinct provider failure.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete fresh/legacy duplicates, forged-separator assertion with no relevant attacker contract, and internal list identity/constant-derived bound.

- **DELETE** `a fresh notice is raised` — Delete fresh/legacy duplicates, forged-separator assertion with no relevant attacker contract, and internal list identity/constant-derived bound.
- **KEEP** `a dismissal sticks across the re-publish the provider load causes` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a DIFFERENT message on the same provider still gets through` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `the same message on a different provider still gets through` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `the key spans [adapterId, status, auth.status, message] (T3's banner key)` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a notice from an older bundle, carrying no columns, still keys and dismisses` — Delete fresh/legacy duplicates, forged-separator assertion with no relevant attacker contract, and internal list identity/constant-derived bound.
- **DELETE** `the key cannot be forged by a message containing the separator` — Delete fresh/legacy duplicates, forged-separator assertion with no relevant attacker contract, and internal list identity/constant-derived bound.
- **DELETE** `dismissals are deduped and bounded` — Delete fresh/legacy duplicates, forged-separator assertion with no relevant attacker contract, and internal list identity/constant-derived bound.

## `packages/ui/src/lib/agent-chat-active-tab.test.ts`

Production callers/seam: MainView.tsx, AgentChatView, ChatComposer, banners and ComposerPopover
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI §7.7/keyboard regression: only focused tab owns global chords; grid chip activation must keep its own popover open.
Isolated-unit failure modes: hidden tab sends/answers; stale unmount clears new owner; terminal inherits hidden chat; popover closes on activation or stays after leaving.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete legacy terminal duplicate, lower predicate duplicate of real subscription, and fake closest/getAttribute DOM call-shape test.

- **KEEP** `only the published tab is active; every other mounted tab is not` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `no chat tab showing means no chat tab owns the keyboard` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `subscribers see each change once and never a repeat of the same id` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a tab releases the keyboard only while it still holds it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a fast switch keeps the newcomer's claim when the old tab unmounts after it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `the active chat tab is the one showing, not merely one that is mounted` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a terminal tab on screen means NO chat tab owns the keyboard` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `no active tab, or an id naming none, owns nothing` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a legacy `agent` terminal record is a PTY tab, never a chat tab` — Delete legacy terminal duplicate, lower predicate duplicate of real subscription, and fake closest/getAttribute DOM call-shape test.
- **DELETE** `the dismiss decision: activating the popover's own tab keeps it open; any other tab closes it` — Delete legacy terminal duplicate, lower predicate duplicate of real subscription, and fake closest/getAttribute DOM call-shape test.
- **KEEP** `a popover subscribed while its unfocused grid cell is being activated stays open` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a popover finds its own thread from where its trigger sits` — Delete legacy terminal duplicate, lower predicate duplicate of real subscription, and fake closest/getAttribute DOM call-shape test.

## `packages/ui/src/lib/app-config.check.ts`

Production callers/seam: app-config adapter and store/app.ts config hydration
Remaining stronger coverage: packages/config tests own schema; these checks uniquely guard client field filtering and adapter normalization boundary
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: AGENTS.md validate localStorage/bridge payloads; documented legacy pre-agents usage crash.
Isolated-unit failure modes: legacy usage booleans lost; malformed payload crashes load; absent field overrides daemon defaults; corrupt usage destroys good fields.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

- **ASSERTION FAMILY** KEEP: legacy pre-agents record migrates booleans.
- **ASSERTION FAMILY** KEEP: current shape passes and stale view key stripped.
- **ASSERTION FAMILY** KEEP: nonobject/invalid usage falls back.
- **ASSERTION FAMILY** KEEP: stored config keeps valid fields, drops invalid, preserves absent and migrates usage.
- **ASSERTION FAMILY** KEEP: garbage root empty and corrupt usage isolated.

## `packages/ui/src/lib/chat-prefs.test.ts`

Production callers/seam: store/app.ts prefs hydration and launcher runtimeModeForAgent
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: AGENTS.md localStorage validation and agent GUI §7.4/§4.4 permission-mode default.
Isolated-unit failure modes: malformed prefs enable invalid mode, old prefs lose queue choice, unknown agent misses full-access default.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete label inventory; replace production-default-derived expectations with literal specified state.

- **REWRITE** `a missing or non-object blob falls back whole` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a blob from an older bundle keeps the fields it does have` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `wrong-typed fields are dropped, not coerced` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `only known permission modes survive the per-agent map` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `an agent with no remembered mode gets the full-access default` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `every permission mode has a chip label` — Delete label inventory; replace production-default-derived expectations with literal specified state.

## `packages/ui/src/lib/composer-inbox.test.ts`

Production callers/seam: ChatComposer.tsx, file drop/picker delivery and app tab close
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI §7.4/§7.7 file/picker delivery must enter intended session draft, survive mount, preserve attachments and absolute upload path.
Isolated-unit failure modes: lost pre-mount input, duplicate mount delivery, cross-session prompt leak, closed tab resurrects draft, missing attachment path/order.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Drop single-item object identity assertion; retain queue lifecycle and exact delivered bytes/data.

- **KEEP** `a delivery made before the composer mounts is waiting for it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a mounted composer receives deliveries directly and nothing queues` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `after unsubscribing, deliveries queue again` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `deliveries are per session and never cross` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `clearing a closed tab drops what was queued for it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a delivery becomes draft text plus one attachment path per line` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `either half alone stands on its own, and an empty delivery is empty text` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `merging keeps order and concatenates attachments` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/copy-produced.test.ts`

Production callers/seam: agent-chat/primitives/CopyButton.tsx and workflows/runs/JsonTree.tsx
Remaining stronger coverage: No stronger owner: both callers delegate browser clipboard boundary here; fake is the external clipboard API, not the async ordering under test
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Async Clipboard API user-activation contract and observed Safari deferred-copy/Chromium refusal regressions.
Isolated-unit failure modes: write starts after click gesture expires, full text/MIME lost, fallback missing, failed read copies truncated data, rejected write leaves unhandled read promise.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

- **KEEP** `a string is written with writeText at once, inside the click` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a text still being read starts write() inside the click, and copies it once read` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `without ClipboardItem, or without write(), a text being read falls back to writeText once read` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a read that fails copies nothing down either path, and never the cut text` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a write refused without reading its item leaves nothing unhandled when the read fails too` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `with no async clipboard at all (an insecure origin) nothing is copied, and a failing read is still observed` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/file-icon.test.ts`

Production callers/seam: icons/files/index.tsx FileTypeIcon used by attachment chips
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Arbitrary user filenames must not crash attachment rendering by resolving Object.prototype members.
Isolated-unit failure modes: constructor/__proto__ input resolves a non-icon and React crashes.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.

- **DELETE** `resolves office, data and code files by extension, case-insensitively` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.
- **DELETE** `falls back to the mime when the name has no usable extension` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.
- **DELETE** `ranks the extension above the mime, and strips mime parameters before the exact match` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.
- **DELETE** `is the generic file for the unknown: no extension, no mime, octet-stream` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.
- **KEEP** `reads only its own table keys: a name or mime spelled like an Object.prototype member is unknown` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `backs every id with an icon component` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.
- **DELETE** `renders the resolved icon as a sized, decorative glyph carrying the light-mode hook` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.
- **DELETE** `maps every id to its own <id>.svg, which exists on disk` — Delete appearance catalogue, export inventory, sized element shape and barrel/file source inspection; production build resolves actual asset imports.

## `packages/ui/src/lib/file-kind.test.ts`

Production callers/seam: FilePreview and file browser preview dispatcher; extOf shared with icon resolver
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: README image/archive/text preview dispatch and user filename safety.
Isolated-unit failure modes: Object.prototype extension becomes invalid preview; uppercase image/compound archive routed to text.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Remove separate private extension-helper assertion; keep dispatch result and MIME.

- **KEEP** `never resolves a prototype member: an extension like `constructor` is the text fallback` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `classifies by lowercased extension and collapses .tar.* names` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/keyboard-surfaces.test.ts`

Production callers/seam: Read the adjacent owner; deleted tests observed source/markup/private wrapper shape, not an independent interface.
Remaining stronger coverage: dock-keyboard.test.ts retained key actions, agent-chat shortcut owner suites; actual DOM isolation requires browser interaction
Risk: low; behavioral coverage below stays.
Validation: package Node import hooks with this test path (deletion: focused surviving owner suites).

Cleanup reason: A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.

- **DELETE** `owns keys typed anywhere inside a rail surface` — A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.
- **DELETE** `owns keys typed inside any modal dialog or sheet` — A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.
- **DELETE** `leaves the chat's own popovers (menus, not modal) and the page to the chat` — A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.
- **DELETE** `marks a root with the attribute it looks for` — A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.
- **DELETE** `adds menus and listboxes: a digit on a menu item is the menu's` — A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.
- **DELETE** `still owns what a surface owns, and leaves the page to the chat` — A custom fake implements CSS closest/selector matching; these checks prove that fake plus production selector spelling, not browser keyboard isolation; props assertion is self-derived.

## `packages/ui/src/lib/launch-models.test.ts`

Production callers/seam: NewTabMenu.tsx and ProjectOverview.tsx launch selection
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI §6.1 launch requires modelSelection.model; §3.2 cold provider catalogues usable; user selected model/search behavior.
Isolated-unit failure modes: one-click launch posts empty/retired model; remembered model ignored; default absent; search hides selection/default or misses catalogue name.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.

- **KEEP** `a launch always names a model, so the host cannot refuse it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `the remembered pick wins while the catalogue still serves it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a remembered pick the catalogue dropped falls back to the default` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `two models flagged default resolve deterministically to catalogue order` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `no default flag at all falls back to the first entry` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `no catalogue yields null, so the caller can refuse instead of posting` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a pending snapshot with a bundled catalogue is launchable` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `a remembered pick still wins inside a pending catalogue` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `a pending snapshot with NO catalogue is the only 'still loading' case` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `resolution never branches on the snapshot's status` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `the pending catalogue renders as chips without a search` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `a 378-model catalogue never renders as 378 chips` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **REWRITE** `the selected model is always shown, even when a query excludes it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `the catalogue default stays one click away when it is not the selection` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `search matches the slug or the display name, case-insensitively` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a query with no match shows nothing but the selection` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a small catalogue is not searchable and shows everything` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `a search is capped, so one character cannot render the catalogue` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `a model reads by its catalogue name, matching the composer's chip` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `the provider is the segment before the first slash, or none` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.
- **DELETE** `grouping keeps catalogue order of first appearance` — Delete repeated pending-catalogue scenarios with identical model-only inputs, signature tautology, chip counts/ordering, friendly-copy and grouping appearance.

## `packages/ui/src/lib/open-layers.test.ts`

Production callers/seam: use-open-layer.ts, ui/sheet.tsx, dock-keyboard.ts and GlobalShortcutListener.tsx
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Escape-under-viewer regression and nested overlay ownership: only released layer disappears; newest active layer owns Escape.
Isolated-unit failure modes: phantom layer blocks chat forever; closing nested overlay exposes underlying chat; duplicate cleanup removes another layer; sheet intercepts dropdown Escape.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete manually replayed React lifecycle over one-line effect wrapper; inline and remove wrapper.

- **KEEP** `a layer counts as open from its opening until its release` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `nested layers count separately: closing the inner one leaves the outer one open` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a release runs once in effect: a second call never closes another layer` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `a closed layer registers nothing` — Delete manually replayed React lifecycle over one-line effect wrapper; inline and remove wrapper.
- **DELETE** `StrictMode's mount, cleanup and mount again leave exactly one layer, and unmounting it none` — Delete manually replayed React lifecycle over one-line effect wrapper; inline and remove wrapper.
- **DELETE** `closing runs the cleanup, and the closed render registers nothing in its place` — Delete manually replayed React lifecycle over one-line effect wrapper; inline and remove wrapper.
- **DELETE** `unmounting while open releases the layer — no Escape stays swallowed after it is gone` — Delete manually replayed React lifecycle over one-line effect wrapper; inline and remove wrapper.
- **KEEP** `a tracked layer knows when a newer one (a dropdown inside a sheet) is above it` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/preferred-model.test.ts`

Production callers/seam: store/app.ts preference persistence and launchers
Remaining stronger coverage: No stronger owner for client model-selection storage key/field filtering
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: AGENTS.md tolerant localStorage; owner requirement remember model plus its options for new chats.
Isolated-unit failure modes: effort/thinking preference lost; corrupt record crashes; options for one model applied to another.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

- **KEEP** `round-trips model and options, and drops what it cannot type` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `launch carries the remembered options only for the remembered model` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `garbage storage loads as empty rather than throwing` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/regexp.test.ts`

Production callers/seam: html-preview.ts, composer-files.ts and row-chrome.ts
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: ECMAScript RegExp literal escaping used for attachment path and filename matching.
Isolated-unit failure modes: regex metacharacter filename matches different file or throws syntax error.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Drop plain-string pass-through and exact escape spelling; retain regex behavior including negative control.

- **REWRITE** `escapes every metacharacter so the escaped form matches the literal` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `leaves a plain word untouched` — Plain-string identity restates implementation; metacharacter literal-match and negative-control case already covers the real regex matching contract.

## `packages/ui/src/lib/session-kind.test.ts`

Production callers/seam: ProjectOverview.tsx, NewTabMenu.tsx, MainView and ambient session surfaces
Remaining stronger coverage: Registry catalog tests own agent enumeration; installed-agent/menu predicates retain proxy routing beyond lower duplicate predicates
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI §5.2 legacy PTY migration, §5.3 proxy resume HOME ownership, §7.1 session kinds and first-message title rules.
Isolated-unit failure modes: legacy PTY treated as chat; orphan proxy resume goes to wrong home; disabled launcher listed; manual title overwritten.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete catalog/export inventories and direct proxy predicate cases already covered by actual offered-list seams; hardcode specified default title instead of importing it.

- **KEEP** `the three session kinds are classified without overlap` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `every catalog agent with an adapter can open a chat tab; deepseek cannot` — Delete catalog/export inventories and direct proxy predicate cases already covered by actual offered-list seams; hardcode specified default title instead of importing it.
- **DELETE** `the five dropped agents are gone from the catalog entirely` — Delete catalog/export inventories and direct proxy predicate cases already covered by actual offered-list seams; hardcode specified default title instead of importing it.
- **DELETE** `a cliproxy conversation launches under its proxy launcher, not plain claude` — Delete catalog/export inventories and direct proxy predicate cases already covered by actual offered-list seams; hardcode specified default title instead of importing it.
- **DELETE** `a cliproxy row with no proxyRefId is not resumable: no launcher owns its home` — Delete catalog/export inventories and direct proxy predicate cases already covered by actual offered-list seams; hardcode specified default title instead of importing it.
- **KEEP** `ProjectOverview offers a proxied row under its launcher, never an orphaned one` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `NewTabMenu lists a proxied row under its launcher, and no agent lists an orphaned one` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `a conversation whose agent has no adapter is not offered` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `only a title nobody chose may be overwritten by the seed` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/thread-visits.test.ts`

Production callers/seam: store/app.ts mark-read/unread and tab-strip/sidebar selectors
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Agent GUI §7.7 unread completion-vs-last-visit and mark-unread completion minus 1ms; AGENTS.md client persisted-shape validation.
Isolated-unit failure modes: future completion swallowed by wall clock, unread marker moves backwards, invalid visit accepted, running/never-read thread spuriously unread, unread action not reversible.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Delete constant-derived cache-size shape, duplicate unread/read lifecycle and comparator case; use stable mark-read seam and data equality instead of reference identity.

- **KEEP** `a junk blob loads as empty and bad entries are dropped` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `the visit map is capped, newest first` — Delete constant-derived cache-size shape, duplicate unread/read lifecycle and comparator case; use stable mark-read seam and data equality instead of reference identity.
- **KEEP** `reading a thread stamps the TURN'S COMPLETION, never the clock` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `a thread whose latest turn never completed has nothing to read` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `mark-unread survives a later read of the SAME completion` — Delete constant-derived cache-size shape, duplicate unread/read lifecycle and comparator case; use stable mark-read seam and data equality instead of reference identity.
- **REWRITE** `visits are monotonic: an older stamp never moves the mark back` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `an unparseable visit stamp is ignored and the map keeps its identity` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `mark-unread stamps one millisecond before the completion` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `mark-unread is a no-op without a completed turn, and is idempotent` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **DELETE** `unread is exactly completedAt newer than the last visit` — Delete constant-derived cache-size shape, duplicate unread/read lifecycle and comparator case; use stable mark-read seam and data equality instead of reference identity.
- **KEEP** `a never-visited thread is not unread, and a running turn is never unread` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **KEEP** `an unreadable visit stamp reads as unread rather than silently read` — Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## `packages/ui/src/lib/transporters/http-transporter-stream.test.ts`

Production callers/seam: remote event stream and workflow output stream via HttpTransporter
Remaining stronger coverage: No stronger owner covers the retained caller decision; downstream render checks cannot exercise these transitions.
Risk: retained cases cover the concrete failure modes below; presentation checks intentionally removed.
Validation: package Node import hooks with this test path.

Independent source: Transporter.openStream callback contract: success bytes then end; non-2xx emits error/end without treating error JSON as stream data.
Isolated-unit failure modes: 404 JSON contaminates stream, missing/duplicate end, dropped successful stream data.
Retention bar for each KEEP/REWRITE below: (1) the specific source above establishes its behavior; (2) its named failure is caller/user-visible, not coverage; (3) expected inputs and results are literal protocol/storage/interaction data, independent of production calculations (rewrites remove derived expectations); (4) the named production-consumed decision, storage API or external browser/HTTP boundary is observed; (5) algorithms, helper names, internal storage and JSX may change without changing these observations; (6) this is the lowest owner of this client decision, with stronger duplicated cases deleted as recorded.

Cleanup reason: Replace 20-event-loop-turn polling with promise resolved by the stream end receipt.

- **REWRITE** `a non-2xx answer is one error and one end — its JSON body is never stream data` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.
- **REWRITE** `a 2xx body streams, then ends once` — Same contract; remove incidental assertion or unsafe wait. Detects the named failure at the production-consumed seam; expected outcome is the concrete behavior stated in this case.

## Production seams and support removed

- Right rail fake-panel and mobile-order injection props; test-only state reset/storage override; local-only exports used only by removed tests.
- Open-layer effect wrapper, now redundant after lifecycle simulations are deleted.
- File-icon runtime inventory exports and stale README claim that an import-source test validates icons.
- Fake DOM trees, source-scanning/comment stripping, render helpers and presentation fixtures disappeared with their owning tests.
- Removed unused `groupModelsByProvider`; removed the unused launch-list `limit`, preview-text `max`, mobile-section `max`, and focus-tracker `defer` override arguments. Kept actual production defaults unchanged.
- Made local-only dock focus types/functions, rail parser/clamp/constants, model-provider helper, tab-dismiss predicate, read-stamp helper and dropdown selector private. Inlined dropdown attribute/subscription wrappers into their single real caller.

## Validation

Implemented cleanup, not audit-only. This report covers 33 assigned files; 10 complete files removed. Children cover the other 15 files in the two reports named above.

- Focused surviving named tests: **105 passed, 0 failed**. Run from `packages/ui`:

```sh
node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/components/command-palette/conversation-search.test.ts src/components/right-rail/dock-keyboard.test.ts src/components/right-rail/history/history-format.test.ts src/components/right-rail/right-rail-state.test.ts src/components/topbar/usage-format.test.ts src/lib/agent-auth-notice.test.ts src/lib/agent-chat-active-tab.test.ts src/lib/chat-prefs.test.ts src/lib/composer-inbox.test.ts src/lib/copy-produced.test.ts src/lib/file-icon.test.ts src/lib/file-kind.test.ts src/lib/launch-models.test.ts src/lib/open-layers.test.ts src/lib/preferred-model.test.ts src/lib/regexp.test.ts src/lib/session-kind.test.ts src/lib/thread-visits.test.ts src/lib/transporters/http-transporter-stream.test.ts
```

- Standalone retained checks: **4 passed** (`app-config.check.ts`, `system/session-owner.check.ts`, `system/system-format.check.ts`, `topbar/usage-format.check.ts`), each executed with the same four Node import hooks.
- `pnpm --filter @orquester/ui typecheck`: reached unrelated concurrent agent-chat changes (removed status/title helpers still imported by tests, removed historyRowCap/rest test seams). No errors in this scope. Root handles the integrated rerun.
- Final scoped `git diff --check`: passed. Reviewed production default-equivalence and deleted support references. No daemon/browser was started. Root owns repository check/test/build and commit/merge/push.
