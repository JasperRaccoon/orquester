# Agent-chat component test cleanup (composer excluded)

Status: completed cleanup; decisions were recorded before edits. Focused and rendered checks passed; package typecheck is still running. Scope is all 21 original test/check files under `packages/ui/src/components/agent-chat`, excluding `composer/`.

Read root AGENTS.md/README.md, `packages/ui/package.json`, every scoped test/check and the tested production functions. Checked the current callers, the API data contracts and the current GUI/goals specs rather than relying on prior cleanup reports.

Independent sources: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), especially §§4.3, 4.6.5, 4.6.7, 5.1, 5.5, 5.6, 6.3 and 7.1–7.6; [goal design](../superpowers/specs/2026-09-24-agent-goals-design.md) §§4.5/8.2; public `@orquester/api/agent-chat` question/approval/task/checkpoint contracts; git unified-diff/Markdown input formats; documented regressions named per case below. Source comments were checked against these sources or an explicit concrete failure mode, not treated as sufficient evidence alone.

## Retention bar and ownership

Every KEEP/REWRITE row below identifies its independent contract and specific externally visible failure (bar 1/2). Its expected output is a literal independently computed answer, decision, ID, source bytes, elapsed arithmetic, patch metadata, or public semantic browser attribute; no expected value calls production logic (bar 3). The stable seams and their non-test consumers are:

- `banners/banner-model.ts`: `ApprovalCard` and `ChatBannerDock` consume decision lists, priority and visibility; `approval-detail.ts`: `ApprovalCard` consumes authoritative operation text; `pending-answer.ts`: `QuestionCard`/`ChatBannerDock` consume resolved answer payloads, navigation and attachment namespaces.
- `escape-action.ts`, `drill-in-navigation.ts`, `thread-switch.ts`: `AgentChatView` consumes the keyboard/navigation/paint-isolation decisions. Composer listeners have a separate scope; they do not own the shell listener’s contract.
- `primitives/elapsed.ts`: `ElapsedTicker` and `WorkflowGroup` consume duration text. It is numeric data, not marketing/UI wording.
- `roster/background-shell.ts`: `AgentDrillIn` consumes the protocol projection; `roster/drill-in-memory.ts`: `AgentChatView` remembers/recalls and `AgentDrillIn` opens; `roster/roster-summary.ts`: `AgentRoster` consumes kind membership/counts. These counts are semantic agent/shell telemetry, not visual row-count assertions.
- `status/goal-chip.ts`: `AgentChatView` consumes allowed actions and protocol command text; `status/context-meter.ts`: `ChatStatusLine` consumes unknown-vs-known usage/capability data.
- `timeline/diff-tree.ts` and `unified-diff.ts`: `ChangedFilesCard`, `TurnDiffModal` and inline diff views consume file/stat models. `follow.ts`: `ChatTimeline` consumes the reduced-motion decision. `markdown/highlight-core.ts`/`incremental.ts`: `CodeBlock`/`ChatMarkdown` consume source-preserving tokens and rendered Markdown. `timeline/context.ts`: `ChatTimeline` and default row context consume the no-store plan reader. `row-chrome.ts`: `TimelineRow`, `MessageRows` and `ActivityRows` consume command classification, text runs and joined output. `row-format.ts`: activity output/diff rendering consumes format detection.

These are existing production data/decision interfaces, or actual rendered HTML semantics, not private collaborator call graphs (bar 4). Retained assertions tolerate changes to algorithms, maps, component wrappers, styling and internal traversal; the three answer-edit rewrites remove optional draft-object shape assertions (bar 5). Each retained row owns the named boundary: provider adapters guarantee wire frames, but do not test GUI interpretation; stores guarantee thread state, but do not test child projection consumption, keyboard decisions or rendering. The live approval card and historical lifecycle rows have different owners and input shapes. No stronger remaining test exercises the distinct named failure unless explicitly identified as DELETE (bar 6). The renderer regression is retained because the lower shell projector cannot catch ChatTimeline discarding its supplied projection.

Risk for KEEP/REWRITE: low; production behavior is unchanged, literal protocol/security/data assertions remain, and focused execution checks the revised oracle. Risk for DELETE: low, with its stronger coverage or lack of an independent contract stated per row. All tested exports have the non-test consumers above; pruning a test is not permission to delete a production dependency.

Validation A (all named scoped tests): `cd packages/ui && node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test $(find src/components/agent-chat -path '*/composer' -prune -o -name '*.test.ts' -print)`.
Validation B: same node import flags, run `src/components/agent-chat/banners/banner-render.check.ts` and `src/components/agent-chat/roster/drill-in-render.check.ts` separately. Validation C: `pnpm --filter @orquester/ui typecheck`, scoped `git diff --check`, final diff review. Root owns repository-wide lint/typecheck/test/build and commit/push.

## `packages/ui/src/components/agent-chat/banners/banner-model.test.ts`

- **KEEP** `activity sorts first, then severity, then notices` — Live activity could be buried behind an error or notice; GUI §7.5 specifies priority.
- **DELETE** `equal priorities keep the caller's order` — The equal-priority tie break pins sort implementation; GUI §7.5 specifies priority classes, not ordering within a class. The activity/severity test keeps the specified ordering.
- **KEEP** `the default four split into Approve/Decline primary and the rest overflow` — A provider that omits options could offer no decline/session grant; GUI §§4.3/7.5 specify the default four and primary/overflow placement.
- **KEEP** `an empty advertised list falls back to the default four` — An empty advertised list could suppress every decision rather than use defaults; this is a distinct wire representation from omitted options.
- **REWRITE** `advertised options keep the provider's own wording and warnings` — Remove label/warning pass-through assertions (the rendered check owns visibility); retain only explicit advertised decisions including acceptAlways and reordered Accept/Decline grouping. GUI §§4.3/7.5 specifies this behavior independently; dropping a non-default advertised decision would remove a provider action, and default-only cases cannot catch that failure. The resulting case is named “advertised approval decisions keep their grouping when reordered”.
- **DELETE** `the split is on the decision, not on the position` — The rewritten advertised-decision case now covers reordered Accept/Decline and a non-default acceptAlways option together; this separate case adds no distinct failure.
- **KEEP** `the liveness banner is hidden while a turn is working` — A settled turn with live background work could lose its only stop control, or show a duplicate while a turn runs; GUI §7.6.
- **KEEP** `the dock shows one card at a time, in a fixed priority order` — A pending question/plan could hide a blocking approval; GUI §7.5 explicitly specifies the one-card priority.

## `packages/ui/src/components/agent-chat/banners/approval-detail.test.ts`

- **KEEP** `E7: the request's own detail wins and is marked as such` — Stale activity detail could replace the request’s own authoritative patch; GUI E7/§4.3 approval safety.
- **KEEP** `E7: with no detail, the card joins the gated tool call by toolUseId` — The approval could show another in-flight call’s file or omit the actual patch; independently named toolUseId and literal file/patch data define the oracle.
- **KEEP** `E7: the path list alone is enough when the item carries no diff` — An approval with only changedFiles could show no affected paths; path data remains useful without a patch.
- **DELETE** `E7: the body is NEVER the card's own title` — Empty approval with no entries returns null, already covered by missing-payload/no-entry cases; title-echo prevention adds no separate exercised branch.
- **KEEP** `E7: the join is by id only — a second write in flight is never guessed at` — An approval without an ID could guess the newest concurrent write, misleading the user about the operation being approved.
- **KEEP** `E7: the newest activity wins when a tool id is reused across updates` — An updated tool call could show an obsolete affected path; newest wire update must describe current approval.
- **KEEP** `E7: a command payload is used when there are no changed files` — Command-only tool activity could leave the operation invisible when approval detail is absent.
- **KEEP** `E7: a missing or malformed payload never throws` — Malformed/absent optional wire payload could throw during approval rendering; no-entry and null/string/number/undefined cases preserve absent detail.

## `packages/ui/src/components/agent-chat/banners/pending-answer.test.ts`

- **REWRITE** `an option with no value answers with its label` — Codex options without value must submit the label while explicit provider IDs submit their value. Remove direct option-field pass-through assertions; assert both resolved answers.
- **KEEP** `a custom answer beats a selected option` — A selected option could silently override the custom answer the user typed; GUI §7.5.
- **KEEP** `a custom answer is refused when the question forbids one` — A choice-only provider question could submit disallowed free text; public question allowCustomAnswer contract.
- **KEEP** `multi-select answers with an array and drops unknown values` — Multi-select could submit a scalar or an unknown option; public answer array/option membership contract.
- **KEEP** `an attachment alone satisfies a question` — An attachment-only response could remain unanswerable despite a valid upload; GUI §7.5 explicitly permits it.
- **KEEP** `an unfinished upload keeps the answer unresolved` — A selected answer could submit before its file upload finishes and omit the file; GUI §7.5 upload gate.
- **KEEP** `a choice-only question offers no attachments` — Choice-only questions could allow unsupported attachments; GUI §7.5 restricts attachment answers.
- **KEEP** `an `isOther` option asks for text rather than answering with its label` — Provider isOther could be sent as a literal label or custom text could be refused; captured Codex question flags/GUI §7.5.
- **KEEP** `a secret answer is never carried back into the thread draft` — A credential could be copied into the ordinary persisted chat draft; secret-answer security contract.
- **KEEP** `displaced text lands after whatever was already in the draft` — Selecting an option could discard displaced user text or replace the existing draft; GUI §7.5 promises preservation after the existing prompt.
- **REWRITE** `toggling clears the custom answer; multi-select toggles in place` — Toggling a multi-select option could retain the old custom answer or fail to remove a selected value. Assert the answers that would be sent after each action, not exact draft-object layout.
- **REWRITE** `single-select replaces the selection rather than adding to it` — Selecting another single option could submit both choices or retain the previous one. Assert resolved answer, not selectedOptionValues storage. Renamed to “a new single-select choice becomes the submitted answer”.
- **REWRITE** `typing clears a selection only once there is text to prefer` — Typing custom text could lose precedence, while empty input could erase the prior choice. Assert resolved answer after editing, not optional property omission. Renamed to “custom text overrides a choice while empty text preserves it”.
- **KEEP** `the answers map is null until every question resolves` — A multi-question request could submit an incomplete answer map; the public /answer payload must contain every question.
- **KEEP** `progress reports the active question, the count and completeness` — Question navigation could advance an unanswered question or select the wrong prompt; GUI §7.5 active prompt/completeness contract.
- **KEEP** `an out-of-range question index is clamped, never thrown on` — A shorter updated request could leave a stale question index pointing at no prompt; clamping preserves a usable current question and empty requests remain safe.
- **KEEP** `attachment drafts are namespaced per (requestId, questionId)` — Attachment drafts could collide across request/question IDs, sending a file to the wrong answer; namespacing and delimiter-collision security/data isolation.
- **KEEP** `a digit picks its option on the visible tab` — Documented digit shortcuts could select the wrong answer; GUI §7.5 specifies 1–9.
- **KEEP** `an open layer keeps the digit: it never answers the question behind a modal, a menu or a popover` — Typing a digit on a modal/menu button could irreversibly answer a question behind the layer; documented keyboard ownership regression.
- **KEEP** `a digit never answers from a hidden tab, while typing, or under a modifier` — A hidden tab or text field could answer a question from an unrelated keypress; GUI §§7.1/7.5 keyboard scope.
- **KEEP** `only 1–9, and only an option the question has` — A non-digit or digit beyond advertised options could select a nonexistent answer; GUI §7.5 bounds.

## `packages/ui/src/components/agent-chat/drill-in-navigation.test.ts`

- **KEEP** `an agent seen at work that settles while the reader follows its end hands the view back` — A watched live agent could settle without returning a following reader to the parent result; GUI §7.6 auto-return.
- **KEEP** `opening a finished agent from a running agent's view stays open (was one flag for the whole view)` — Opening a finished agent from a running agent could immediately bounce back due to leaked live state; documented GUI §7.6 regression.
- **DELETE** `an agent opened already finished stays open` — Already-finished agent is the same new-agent branch as the stronger running-A → finished-B regression; no distinct failure remains.
- **KEEP** `a reader who scrolled up stays when it settles — and is not yanked later on reaching the end` — Completion could yank a reader from older child output, immediately or after they later reach the end; GUI §7.6 reading protection.
- **KEEP** `idle is not at work: an idle agent that settles returns nothing` — An idle agent could be treated as one observed working and unexpectedly close on completion; public task-state meanings.
- **KEEP** `an agent the roster dropped, then back, starts over` — A roster-removed agent returning completed could inherit stale liveness and close; retained/evicted roster boundary regression.
- **KEEP** `A → B → A: each agent is watched from its own opening` — Reopening A after B could reuse A’s prior live watch and close its already-settled view; each opening is independent.
- **KEEP** `a NEW reveal closes an open drill-in, so the thread's timeline takes it at once` — A new palette search hit could wait behind an unmounted parent timeline until Back; GUI §7.6 documented reveal regression.
- **KEEP** `no new reveal closes nothing: opening a drill-in while an old one is pending leaves it open` — An old reveal or its acknowledgement could close a newly opened child view; nonce identity distinguishes new user navigation.

## `packages/ui/src/components/agent-chat/escape-action.test.ts`

- **DELETE** `Escape leaves the drill-in — the case a React root handler could not see` — Pure input test does not exercise the advertised React-root/body listener regression. Its close action is already asserted by drill-in priority cases; no unique seam coverage.
- **KEEP** `the drill-in wins over the interrupt` — Escape in a child could interrupt the parent turn instead of returning to it; GUI §§7.4/7.6 action priority.
- **KEEP** `Escape interrupts a running turn from anywhere in the tab` — Escape outside the composer could fail to stop the visible running turn; GUI §7.4.
- **DELETE** `Escape does nothing with no drill-in and no turn` — No-action idle case duplicates the stronger first-Escape case with rewind available; no distinct caller failure.
- **KEEP** `a hidden tab never acts, whatever it is doing` — Mounted hidden tabs could stop their own agents or close child views when another tab receives Escape; GUI §7.1.
- **KEEP** `a blocking layer keeps the key: Escape closes the modal, not the thread` — Closing an overlay could interrupt the underlying running agent; GUI §7.4 open-layer rule.
- **KEEP** `focus inside the composer belongs to the composer's own arm, not this one` — Composer and shell listeners could both act on the same Escape; scope separation prevents duplicate interrupts/incorrect child action.
- **KEEP** `an event another listener already handled is not handled twice` — An already-handled Escape could trigger a second action; browser event ownership contract.
- **KEEP** `a held Escape is one press: its auto-repeat never stops the turn the first press spared` — Holding Escape after closing a child/overlay could stop the parent on auto-repeat; documented user-visible regression.
- **KEEP** `only Escape` — Typing any key in an open child could close it if the key gate regresses; browser KeyboardEvent key contract.
- **KEEP** `a second idle Escape opens the rewind picker` — The documented second idle Escape could fail to open rewind; GUI §7.4/§5.5.
- **KEEP** `the first idle Escape does nothing — it is only half of the gesture` — One idle Escape could open rewind prematurely; GUI §7.4 double-press gesture.
- **KEEP** `no message to go back to, no picker` — Rewind could open without any available target; GUI §5.5 requires a rewindable message.
- **KEEP** `the double press never outranks leaving a drill-in or stopping a turn` — Second Escape during active work could rewind instead of leaving the child/stopping the turn; idle-only rewind contract.
- **KEEP** `the rewind obeys every gate the other two do` — A completed double-press could bypass keyboard scope, overlay, handled/repeat or key gates and rewind an unrelated thread.
- **KEEP** `only an idle Escape is pressed into the double-press sequence` — An idle Escape could fail to advance the double-press gesture; sequence output is consumed directly by the listener.
- **KEEP** `an Escape that did something else starts the count over` — An Escape used to stop/close another surface could count toward a later rewind; only consecutive idle presses belong to the gesture.
- **KEEP** `any other key between two Escapes breaks the sequence` — Unrelated typing between Escapes could still trigger rewind; consecutive-key gesture contract.
- **KEEP** `holding Escape is one press, and its auto-repeat breaks nothing either` — Auto-repeat could count as a second press or destroy the real sequence; held key is one gesture.
- **KEEP** `an Escape typed into a field outside this chat is that field's: nothing here, and Esc Esc starts over` — Escape in a tab rename/editor/other field could stop or rewind the chat instead of cancelling that edit; GUI §7.4 documented ownership regression.

## `packages/ui/src/components/agent-chat/primitives/elapsed.test.ts`

- **KEEP** `elapsedBetween accepts ISO stamps and epoch millis alike` — ISO or epoch provider timestamps could show a wrong elapsed duration; independent 64-second/42-second arithmetic, not decorative copy.
- **KEEP** `elapsedBetween measures against `now` when there is no end stamp` — A live row could freeze at zero or use the missing end instead of current time; GUI §7.6 elapsed time contract.
- **KEEP** `elapsedBetween returns empty for missing or unparseable stamps` — Malformed optional provider stamps could display NaN or crash a row; absent data must not become fabricated elapsed time.

## `packages/ui/src/components/agent-chat/roster/background-shell.test.ts`

- **KEEP** `streamed output chunks become the row's output, in arrival order` — Completion could overwrite previously streamed output; actual protocol deltas must remain ordered and byte-preserved through lifecycle merge.
- **DELETE** `a quiet shell whose every chunk aged out still offers the whole of its output` — The assertion only rechecks streamedOutput classification already owned by lib/agent-chat/entries.logic.test.ts, “a Claude background shell’s rows say so with no chunk in view”. No shell-specific transformation sets this flag.
- **KEEP** `the row keeps the first frame's id, so a streaming row cannot close itself` — A completion’s row ID could replace the disclosure identity and close a shell the reader opened; GUI §7.6 stable shell disclosure regression.
- **KEEP** `with no lifecycle frame left, the shell is titled from its roster row, its whole output joined` — Retained orphan output could lose its shell title or chunks after its lifecycle frames age out; GUI §5.1 retention/§7.6 drill-in contract.
- **KEEP** `a Grok shell folds its task lifecycle into the command's output and status` — Grok task frames could show no final output/status because they lack command lifecycle frames; provider task protocol regression.
- **KEEP** `a running Grok shell has no output until it prints` — A Grok shell’s command description could be displayed as output before anything printed; protocol detail-vs-summary distinction.
- **KEEP** `a Grok monitor's latest line is its output` — Grok monitor progress could fail to update visible output; task.progress summary is actual output data.
- **KEEP** `a chunk of the shell's own updates the cached output` — Cached shell projection could fail to include newly arrived own output; appending the second protocol chunk must update output data.

## `packages/ui/src/components/agent-chat/roster/drill-in-memory.test.ts`

- **KEEP** `an agent never opened opens as today: at its end, following, nothing open` — A first-open child could start with stale disclosures or no following; GUI §7.6 opening state.
- **KEEP** `re-opening an agent restores its disclosures and a mid-list position, with follow OFF` — Reopening could lose the saved reading location or follow could immediately overwrite restoration; GUI §7.6 memory.
- **KEEP** `a reader who re-armed follow (the pill, mod+J) comes back to the end, whatever position was published before` — Rearmed follow could restore a stale middle position after reopening; GUI §7.6 explicitly documents ignored programmatic scroll events.
- **KEEP** `an entry keeps the last roster row seen, so a reopened agent the roster evicted keeps its title and kind` — Roster eviction could erase the remembered child’s title/kind; GUI §5.1 retention and §7.6 reopening.
- **KEEP** `A → B saves A's and restores B's, and each keeps its own` — A/B child disclosures could contaminate each other; GUI §7.6 per-agent memory.
- **KEEP** `keeps the 50 most recent agents: the least recently remembered goes first` — The documented 50-agent memory could grow unbounded or evict the recently revisited agent; GUI §7.6 explicit bound, literal independent oracle.

## `packages/ui/src/components/agent-chat/roster/roster-summary.test.ts`

- **KEEP** `counts agents and shells apart, live ones included` — Background shells could inflate agent/live-agent totals; GUI §7.6 explicitly separates activity kinds.
- **KEEP** `counts a loop and a goal as neither an agent nor a shell` — Loop/goal drivers could be counted as shells because agentKind is background; public RuntimeSubagent kind contract.
- **KEEP** `keeps each kind's order while splitting them` — Splitting agent/shell sections could reorder the already-selected activities; GUI §7.6 stable roster ordering.
- **KEEP** `renders a loop and a goal with the agents, never as shells` — Loop/goal drivers could appear under shell controls/section; their background agentKind is insufficient to classify them as shells.

## `packages/ui/src/components/agent-chat/status/goal-chip.test.ts`

- **KEEP** `the action matrix — ${adapter} × every status × running/idle × background liveness` — Claude/Codex/Grok could offer invalid actions for a status or suppress a valid pause/resume; goals §§4.5/8.2 independently specifies each matrix. Three parameterized adapters.
- **KEEP** `no goal, a finished goal, or no goal support ⇒ no actions` — Absent goals or provider support could still expose actions; goals §8.2 capability and unfinished-goal contract.
- **KEEP** `only the actions an adapter honours are ever offered` — A provider could be offered an action omitted from its advertised capabilities; API AdapterGoalSupport is the authority.
- **KEEP** `each action sends exactly the §8.2 text, as the user's message` — Goal action buttons could send prose/commands that the provider does not interpret; goals §8.2 explicitly specifies these exact command bytes, so copy retention is intentional.

## `packages/ui/src/components/agent-chat/status/status-line.test.ts`

- **KEEP** `the meter reports a percentage only when a context window is reported` — Context usage could display the wrong fraction or remaining tokens; independent 50k/200k arithmetic and GUI §7.6.
- **KEEP** `without maxTokens there is no ring and no percentage — never a zero` — A missing model window could be displayed as invented 0% instead of unknown; GUI §7.6 explicitly forbids it.
- **KEEP** `an adapter that does not report a context window degrades even if a max leaks through` — A capability-false provider could show an unsupported context percentage even with a leaked max value; API capability contract.
- **KEEP** `usage past the window clamps at 100% and never reports negative remaining` — Over-window readings could show negative capacity or more than 100%; bounded usage data contract.
- **KEEP** `no usage frame yet means no meter at all, not a zeroed one` — No usage frame could be shown as a real zero reading; absent/invalid input must not fabricate telemetry.
- **KEEP** `zero and non-finite extras are dropped rather than shown` — Nonfinite or zero optional telemetry could leak NaN/invalid window values to the user; optional wire data normalization.
- **KEEP** `the meter carries the auto-compaction verdict through to its model` — An explicit auto-compaction-off verdict could disappear and falsely promise compaction; GUI §7.6 Claude usage contract distinguishes false from unknown.

## `packages/ui/src/components/agent-chat/thread-switch.test.ts`

- **KEEP** `rows for the named thread always win` — Stale held rows could replace an available incoming snapshot; GUI §7.1 requires the current thread when loaded.
- **KEEP** `a reconnect on the same thread repaints its own rows, still interactive` — Reconnect could disable the current thread’s callbacks despite showing its own rows; GUI §7.1 paint hold is inert only across identities.
- **KEEP** `switching to a thread with no snapshot holds the previous one, inert` — Cross-thread hold could route clicks into the incoming thread while displaying the old one; GUI §7.1 interaction isolation.
- **KEEP** `a settled empty thread renders empty rather than someone else's rows` — Settled empty thread could continue displaying another thread’s history; GUI §7.1 snapshot ends the hold.
- **DELETE** `an empty hold never engages, so the hold cannot outlive its content` — An empty held record is unreachable through nextHeldTimeline, the only production writer. This defensive implementation branch has no independent caller contract.
- **DELETE** `nothing held yet and nothing to show is simply empty` — Null hold plus empty rows only asserts the empty default object; settled-empty test protects the observable stale-content risk and current-row case protects attribution.
- **KEEP** `only a settled non-empty paint is remembered` — A held/empty paint could overwrite the last real snapshot and make stale holding self-perpetuating; GUI §7.1 hold lifecycle.

## `packages/ui/src/components/agent-chat/timeline/diff-tree.test.ts`

- **KEEP** `buildDiffTree rolls stats up through every ancestor` — Changed-file ancestor totals could omit descendants; independent numeric sums protect data, not tree geometry.
- **KEEP** `summarizeDiffStats totals changed lines` — Changed-files total additions/deletions could be incorrect or absent for no changes; checkpoint stats public data contract.
- **KEEP** `splitUnifiedDiff yields one entry per file with its own patch text` — A file preview could include another file’s patch or lose its own patch; git unified-diff boundary contract.
- **KEEP** `a deletion keeps the old path when the new one is /dev/null` — Deleted files could disappear or be named /dev/null; git unified-diff deletion path semantics.
- **KEEP** `a binary file is flagged rather than dropped` — Binary modifications could be silently dropped from the diff; git binary-diff marker contract.
- **KEEP** `a bare patch with no `diff --git` preamble is still one file` — Provider bare unified patches could be dropped without a git preamble; supported patch protocol.
- **KEEP** `a quoted path with spaces is unquoted` — Quoted paths could retain syntax quotes and fail file navigation; git diff path data contract.
- **KEEP** `an empty or whitespace diff is no files, not a throw` — Empty/whitespace diff could create a phantom file; zero-change diff semantics.
- **KEEP** `a truncated patch still yields the file it started` — An incomplete streamed patch could lose its already-known file; tolerant protocol parsing contract.
- **KEEP** `unifiedDiffForPath matches exactly and then by suffix` — Absolute/Windows file paths could fail to locate their relative git patch, or an absent path could show unrelated data.
- **KEEP** `countDiffLines ignores the file headers` — File headers could count as added/deleted content; unified-diff line-count semantics.

## `packages/ui/src/components/agent-chat/timeline/follow.test.ts`

- **REWRITE** `snaps when the user prefers reduced motion, even mid-turn` — Reduced-motion preference could still cause animated following; GUI §7.3 accessibility contract. Remove firstPaint/settling iterations that pass through independent no-animation gates and retain the otherwise-animating state.

## `packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.test.ts`

- **KEEP** `highlighting preserves source bytes across styled, empty and trailing lines` — Highlighting could lose newlines/text in multiline tokens or trailing/blank lines; GUI §7.3 source preservation.
- **KEEP** `an oversized block preserves the source without running the grammar` — An over-120000-character block could invoke an expensive grammar and freeze the UI; GUI §7.3 explicitly specifies unhighlighted oversized input. Parser spy observes that externally specified work boundary.
- **KEEP** `a grammar failure preserves the source instead of killing the row` — A throwing third-party grammar could crash the row or lose code text; graceful grammar failure regression with literal source oracle.
- **KEEP** `an unknown grammar preserves the source` — Unknown language could hide code instead of rendering plain text; GUI §7.3 explicitly supports unknown fences.

## `packages/ui/src/components/agent-chat/timeline/markdown/incremental.test.ts`

- **KEEP** `a reference in the prefix resolves when its definition arrives later` — A later reference definition could fail to resolve an earlier link across a cached fence; Markdown document-wide definition contract.
- **KEEP** `a streamed reference resolves a definition before the cached fence` — A streamed reference could lose a definition before the cached fence; inverse Markdown dependency direction.
- **KEEP** `a streamed CR becoming CRLF preserves text and one line break` — A CR followed by LF in another chunk could introduce a second newline; source text/Markdown streaming preservation.
- **KEEP** `a BOM inside streamed text remains an interior character` — An interior BOM at a reparse boundary could be stripped as though it started the document; literal source-preservation regression.

## `packages/ui/src/components/agent-chat/timeline/plan-reader.test.ts`

- **KEEP** `with no thread store, an intact plan is still its own markdown` — An intact proposal could fail Copy/Download when no store remains; GUI §7.3 plan data contract through fallback reader.
- **KEEP** `with no thread store, a truncated plan rejects rather than returning partial markdown` — A cut proposal could be copied/downloaded as though complete when its backing store is gone; truncation safety contract; assertion observes rejection without pinning copy.

## `packages/ui/src/components/agent-chat/timeline/row-chrome.test.ts`

- **KEEP** `a `/compact` user message is recognised at render time` — A raw/case-varied user /compact command could render as ordinary chat text; GUI §4.6.5(b) exact recognition contract.
- **KEEP** `only a bare `/compact` from the user, with no attachments, is the command` — Assistant prose, arguments or attachments could be hidden as a compact marker; GUI §4.6.5(b) narrow command grammar.
- **KEEP** `the concatenated runs always reproduce the input exactly` — Re-chipping skills could silently remove or duplicate user message bytes; GUI §4.6.7 text conservation, independent input oracle.
- **KEEP** `a fileChange approval with no diff borrows it from its own item.started` — Historical file approval row could lack its gated call’s patch/paths; GUI §7.3 call-lifecycle join, separate consumer from live approval-detail.
- **KEEP** `several orphan chunks of one call join into ONE row: the first carries all their text, nothing lost` — Orphan output could lose/duplicate chunks or mix calls after lifecycle retention; GUI §5.1/§7.3 requires byte-preserving per-call joined output.
- **KEEP** `the row a command's streamed output joins onto says the call streamed, however its rows were built` — Joined command output could lose access to full output, or a file edit could falsely offer command output; GUI §6.3 source semantics.
- **KEEP** `the join never overwrites a value the row already has` — Borrowed lifecycle details could overwrite a row’s authoritative own detail; missing command can fill without replacing existing payload.
- **REWRITE** `the join is keyed on toolCallId only — never on a label match` — Matching labels must never transfer output between distinct calls. Give the output-bearing donor the same label as recipients; the original donor had another label and could pass a label-join regression for the wrong reason.

## `packages/ui/src/components/agent-chat/timeline/row-format.test.ts`

- **KEEP** `looksLikeUnifiedDiff recognises a patch and rejects ordinary output` — Ordinary tool output could be parsed as a patch, or valid git/bare patches treated as ordinary output; unified-diff format recognition contract.

## `packages/ui/src/components/agent-chat/banners/banner-render.check.ts`

- **KEEP** Approval in-flight controls disabled — GUI §7.5 duplicate-submission prevention; actual HTML disabled state, with nonempty control precondition; no lower model determines the component’s DOM disabled state.
- **KEEP** Question in-flight answer buttons/text field disabled — same rule for answer submission; the separate component must wire its own controls, so approval coverage is not a duplicate.
- **REWRITE** Provider warning accessible before approval — GUI §§4.3/7.5 specifies provider wording/warning data; retain aria-description and assert provider label at the actual rendering seam, removing the filter helper’s pass-through assertions. This checks data visibility, not a markup tree snapshot.
- **KEEP** Dismiss control only for dismissible requests — native callbacks cannot be abandoned; verify absence alongside positive dismissible case, so failure is not an empty-render false positive. `ChatBannerDock` owns this wiring.
- **KEEP** Secret compact question uses masked field, no ordinary text/file field — Codex isSecret security contract; actual browser input semantics catches visible credential exposure. No lower model can ensure the HTML field type.

All five groups satisfy the shared six bars above: independent GUI/API/security sources, user-visible incorrect control/data state, literal semantic attribute/data oracles, real component interface, wrapper/style-independent matching, and no stronger owner of actual DOM attributes. The static render does not claim to test click dispatch or focus effects.

## `packages/ui/src/components/agent-chat/roster/drill-in-render.check.ts`

- **KEEP** Seeded store background-shell drill-in exposes command and output without another click — GUI §7.6 documented regression: ChatTimeline’s second projection replaced the shell’s supplied output with closed folds. The real stream-fed store and component projection path are exercised; the transport only delivers frames and never implements rendering. Literal command/output bytes are the independent oracle. Rendering is the lowest seam that catches projection replacement; shell projector tests cannot. No class/tree/row-count snapshot or source grep remains. No live daemon/browser is started.

## Production seams and support

Planned removal is limited to deleted cases, unused test imports and superseded assertion setup. All affected production functions have callers listed above; no production export/injection hook is exclusively kept alive by these cases. Shared store test helpers remain used by the retained seeded-render check and other scopes; no external snapshot/fixture becomes orphaned.

Pre-edit named-test declaration dispositions: {"KEEP": 120, "DELETE": 9, "REWRITE": 7}. Goal matrix declaration expands to three cases. Standalone checks have the six separately inventoried groups above.

## Completed implementation and verification

Applied the recorded decisions: 9 named cases deleted, 7 named cases rewritten, 120 named declarations retained (the retained goal matrix expands to three cases), plus one rendered warning group rewritten and five rendered groups retained. Original scoped suite: 138/138 passed before edits. Changed named suites: 81/81 passed after edits (0 failures, 2 suites, 177025 ms under shared host load). Both standalone checks passed: banner disabled/dismissible/secret/provider-warning semantics and the seeded real-store shell command/output regression.

The scoped test diff is 22 added/96 deleted lines (net −74). No production behavior, export or injection seam changed: every affected helper has real component callers listed above. Removed the unused test import of questionOptionValue and the deleted cases’ inline setup; no external fixtures or snapshots were orphaned. The lower entries.logic streamed-output owner was confirmed retained with the UI-lib auditor. Scoped git diff --check and final test diff review passed. The initial package typecheck reported only two concurrent composer-outbox test errors (missing Map.set values); both were fixed by the composer owner, whose shared-package `pnpm --filter @orquester/ui typecheck` rerun passed (exit 0, recorded in ui-composer.md). Final repository gates are root-owned.
