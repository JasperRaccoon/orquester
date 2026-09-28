# Workflow run and Steps test cleanup

Completed cleanup; the disposition record below was written before source/test edits. Scope is the six test files listed below. Source owners, production callers, API contracts and the workflow design were read before deciding. Validation uses the UI package's existing node import hooks; no live daemon was started.

## Independent contracts and retention bar

References: `docs/superpowers/specs/2026-09-28-automated-workflows-design.md` (D), current workflow API types (`packages/api/src/workflows/types.ts`), daemon log protocol (`apps/daemon/src/workflows/sandbox/log-reader.ts`), and current consumers. The design is used only where consistent with current source/wire contracts. Each retained case below names a contract record; its row supplies the distinct failure and independent expected data. Each record explicitly covers all six bar items.

- **R (run data)**: (1) D §§7.3–7.4 require run states, timings, attempts, errors, agent activity/account/hops and initial selection of an actionable step; (2) missing or stale data hides the executing/failing block from the run viewer; (3) fixed run events, timestamps and graph inputs determine expected values independently; (4) `runTimeline`/`defaultSelectedStep` are the data boundary consumed by `RunTimeline.tsx` and `RunsMode.tsx`; (5) assertions use returned semantic fields, never traversal, CSS or collaborators; (6) this owner adds runtime data beyond the independently tested outline, and no other remaining test owns that projection. Isolated failure modes: losing failure details/attempts; completed duration still ticking; treating unreached blocks as pending after completion; using a previous account/activity; selecting the wrong block.
- **I (run input)**: (1) D §§3.2, 3.4 and 7.3 require the actual trigger/single/merged input, excluding untaken/skipped routes and marking truncated previews; (2) wrong data misleads debugging or presents a preview as complete; (3) explicit outputs/handles give expected input, independent of the projection; (4) `blockInput` is consumed directly by `BlockRunDetails.tsx`; (5) tests assert data, not iteration/calls; (6) `inspector-support.test.ts` covers the separate `blockInputOf` owner, which this implementation does not call. Failure modes: choosing untaken/skipped input, losing trigger payload, overwriting a merge source, losing truncation.
- **A (run actions/API)**: (1) D §7.3 and REST §8.1 require cancellation/retry/failed-block restart and same-input retry, with test runs staying test runs; (2) wrong availability prevents valid actions or offers invalid ones, wrong payload replays different work; (3) fixed statuses and literal request fields are independent API expectations; (4) `runActions` is consumed by `RunHeader.tsx`, request builders by `use-run-actions.ts`; (5) results only, no collaborator shape; (6) server tests cannot detect a UI request builder dropping input or its pending-load guard. Failure modes: cancel/retry inversion, retry unavailable despite failed blocks, deleted temp project offered, lost input/trigger/test flag, unloaded input treated as empty.
- **L (lists)**: (1) D §§7.1/7.3 require scope/status/search/history views; current API distinguishes existing/temp targets and live/history summaries; (2) missing rows, unrelated projects, duplicate/stale runs or wrong ordering are visible; (3) fixed ids/paths/statuses/times supply expectations; (4) `filterWorkflows`/`liveRunOf` feed `WorkflowsPanel`, `filterRuns`/`runFilterCounts` feed `RunsList`, and `mergeRunPages` feeds `useRunHistory`; (5) semantic ids/statuses/order only; (6) these client-owned selection/merge rules are not exercised by server list/store tests. Failure modes: project leakage, missing live card, case-sensitive/missing trigger search, incorrect status grouping, stale duplicate overshadowing live status, chronological reversal.
- **N (new workflow request)**: (1) D §§5.10/6.3/7.1/8.1 plus `CreateWorkflowRequest`/`WorkflowProject` specify existing/temp/clone targets and a manually runnable blank workflow; (2) wrong target or omitted timezone creates work in the wrong project or schedule zone; (3) literal request fields and known zone are independent; (4) helpers are the serialization/validation boundary used by `NewWorkflowDialog.tsx`; (5) only output payloads and validation field ids are checked; (6) API validation cannot catch a form selecting the wrong valid target or serializing it incorrectly. Failure modes: wrong current/other/temp project, wrong clone URL, omitted manual trigger/timezone, accepting required fields missing.
- **E (trigger errors)**: (1) D §6.2 requires failing poll status on the trigger; (2) the failing trigger would appear healthy or healthy ones broken; (3) one explicit failing trigger and null/blank healthy records determine the map; (4) `triggerErrorsOf` feeds editor/phone trigger views; (5) returned ids/error data only; (6) daemon tests cover producing errors, not associating their client display. Failure modes: dropped/misassigned error or invented blank error.
- **B (log text)**: (1) D §7.3 requires a live log tail and complete downloadable log; ANSI/CR terminal bytes and window boundaries are external inputs; (2) visible escape garbage, lost/duplicated partial text or an unbounded buffer harms the viewer; (3) literal terminal streams and expected readable content/bounds are independent of parsing implementation; (4) `appendLog`/`visibleLogLines` are the buffer boundary used by `LogViewer.tsx`; (5) no private carry/partial shape or exact clipping copy; (6) follower tests own offsets, daemon tests own file windows, neither owns this display buffer. Failure modes: incomplete ANSI leakage, incorrect CR progress replacement, lost split lines, memory growth for long output.
- **F (log protocol/lifecycle)**: (1) current daemon `X-Log-*` raw-byte window protocol and D §7.3 require full logs, resumed following and stop when no longer viewed; (2) skipped/duplicated logs, endless poll loops or reads after closure are visible; (3) literal file content, supplied daemon offsets and state/error expectations are external inputs; (4) `startLogFollower`/`readWholeLog` are `LogViewer.tsx`'s IO owner and `parseWorkflowLogWindow` is the wire decoder used by `ApiClient.readWorkflowNodeLogWindow`; (5) native mock clock and observable read offsets/text/state replace private timer queues; (6) daemon route tests cannot detect a client advancing by redacted text length, and download/follow are separate production entrypoints. Failure modes: lost windows, using displayed instead of raw bytes, duplicate append on retry, swallowing failure, runaway reads on held partial line, continued IO after stop, bad case-insensitive headers.
- **S (Steps graph edits)**: (1) D §7.4 authorizes add/connect/move/duplicate/delete/disable from Steps and §3.4 requires a DAG; (2) lost connections, an unexecutable cycle or an unintended runnable block changes the user's workflow; (3) literal before/after edges and selected ids specify expected graph edits independently; (4) Steps operations are the command boundary used by `PhoneEditor.tsx`; (5) geometry/name styling/object identity are removed, assertions use graph edges/disabled state; (6) canvas `connectBlocks`/`addBlock` and clipboard tests cannot detect Steps' choice to splice/heal/re-hang/duplicate into the chain. Failure modes: dropping downstream chain on insertion/deletion, splicing terminal Stop, adding wrong branch, wiring first step to nothing, offering invalid targets, losing old edge on refused move, healing an ambiguous join, inserting copy incorrectly, disabling the wrong node.

## Dispositions recorded before editing

Each row supplies path-relative case name, disposition, detected failure/expected result and stronger owner where applicable. For KEEP/REWRITE the record above supplies all six bar checks, production callers and failure inventory. Risk: retained semantic cases low; deletes remove representation coverage only unless explicitly stated. Focused validation command follows the tables.

### `packages/ui/src/lib/workflows/run-view.test.ts`

| Case | Disposition | Reason / failure / coverage |
|---|---|---|
| says a clock as short as it can | DELETE | Exact date prose/format choice, not required wording. No behavioral replacement needed. |
| keeps seconds while they matter | DELETE | Exact duration prose/rounding; numeric duration retained in timeline cases. |
| ticks a live block against the clock and freezes a settled one | DELETE | Numeric duration duplicates timeline R cases; ticker predicate remainder is implementation state classification, not observing ticking. |
| maps block states to a tone, a label and a live flag | DELETE | Styling/copy table mirrors declaration; runtime state retained in R. |
| reads a Stop block's end as a success and a skip with its reason | DELETE | Tone/copy representation, not execution or status contract. |
| says a run's outcome in one sentence | DELETE | Exact prose; underlying run state/duration covered in R/L. |
| names an account, the system login included | DELETE | Exact formatter output; no independently mandated wording. |
| writes the hops in one line | DELETE | Exact formatted chain/copy; timeline retains account/hop data. |
| ends the chain on its own reason when it failed there | DELETE | Exact failure-chain sentence; daemon failover tests own actual failure event. |
| says the account decision and each skip | DELETE | Exact prose assembled from arranged decision; no new selection behavior. |
| gives an agent and a wait their live line | DELETE | Exact status sentences; timeline retains activity/timing data. |
| walks the steps in outline order, branches indented under their handle | DELETE | D §7.4 gives outline ownership to API; duplicates `packages/api/src/workflows/outline.test.ts` diamond/branch/note cases. |
| carries each block's state, timing, hops, error and skip reason | REWRITE R | Keep attempt=2, settled duration=60000, error kind/message, unreached skipped state and initial failed selection. Remove exact skip/handle prose and duplicate `blockSkipReason` call. |
| shows a working agent's account, hops and activity | REWRITE R | Keep latest account identity, one hop, activity, 720000 live duration, pending unreached=false, running selection. Drop presentation `view.live` assertion. |
| builds a block's input from its live upstreams | KEEP I | Trigger payload; single Build input; true-route Deploy versus false-route Alert; skipped input excluded from Notify. Separate run-detail owner from inspector-data. |
| merges several live inputs by name | KEEP I | A=1/B=2 input and truncated=true; no stronger test owns this implementation. |
| offers what makes sense now | KEEP A | Running allows cancel only; failed enables retry/failed retry/temporary cleanup; no failed block and already-deleted project disable those actions. |
| retries with the same input, or from the same event | KEEP A | Literal manual input/git retryOf/fromNodeId/test payloads; null versus unloaded payload guard; failed-block retry keeps test. |
| filters by status and counts each filter | KEEP L | Failed includes interrupted, succeeded includes stopped, active excludes settled; counts match semantic categories. |
| merges the live page with older pages, the live copy winning, newest first | KEEP L | New/mid/old ordering; live new replaces queued duplicate; known failed mid replaces old running copy. |

### `packages/ui/src/lib/workflows/format.test.ts`

| Case | Disposition | Reason / failure / coverage |
|---|---|---|
| formats a duration at a glance | DELETE | Exact formatting, not wording contract. |
| says how long ago, and nothing for garbage | DELETE | Relative-time prose, not mandated wording. |
| says when a trigger fires next, in local time | DELETE | Formatter thresholds/copy; schedule correctness belongs to API schedule tests. |
| writes a trigger line with its next run | DELETE | String concatenation/copy contract absent. |
| names a status and its tone | DELETE | Declaration lookup/styling snapshot. |
| times a run: its duration once ended, the time so far while running | KEEP R | Live run advances by 720000ms, completed run uses stored 4000ms, missing start is unknown. Run-level duration owner distinct from block timeline. Production caller `runProgress`/`runOutcomeText`. |
| draws the live line and its bar | DELETE | Exact copy and arbitrary half-step progress geometry. |
| names what started a run | DELETE | Exact label mapping table. |
| shows the running run over a queued one | KEEP L | Card selects running r ahead of queued q and no-run returns null. |
| matches a project by its path, never a temporary one | DELETE | Predicate duplicates `filterWorkflows` owner test. Add existing trailing-slash inputs/temp exclusion to that retained case, not a second test. |
| filters by scope, by running, and by the search | REWRITE L | Keep all/project/running and case-insensitive trigger-text search; exercise trailing-slash equivalence through this production list seam, removing weaker predicate-only case. |
| a blank workflow is one manual trigger the daemon names and places, in the browser's time zone | REWRITE N | Keep explicit manual trigger/project/name/Europe-Madrid request. Remove expected default timezone computed by `browserTimeZone()` itself and arbitrary Untitled copy. |
| a starter is named after its template (stubbed until buildTemplate lands) | DELETE | Export/title inventory and stale stub story; API templates tests own executable templates. |
| defaults to this project, and resolves each target | KEEP N | Valid trimmed name/current/other/temp clone payloads; no active project starts with other target. |
| names the first thing missing | REWRITE N | Assert field id and ok=false for missing name/project/workspace/clone URL, plus too-long name; remove exact error prose. |
| reads secret names the daemon's way | DELETE | `isValidSecretName` is a direct shared config regex wrapper; `apps/daemon/src/workflows/secrets.test.ts` (`names and values are validated: 400 SECRET_INVALID`) owns name pattern; normalization is trivial character substitution with no distinct requirement. |
| maps each trigger whose last poll failed to its error, and nothing else | KEEP E | Only git carries its authentication failure, blank/null errors absent and null summary safe. |

### `packages/ui/src/components/workflows/runs/log-buffer.test.ts`

| Case | Disposition | Reason / failure / coverage |
|---|---|---|
| drops colours, cursor moves, OSC titles and links | REWRITE B | Observe readable lines after `appendLog`, preserving literal ANSI/OSC/control inputs, instead of private `stripAnsi`. |
| carries an escape sequence split across chunks | REWRITE B | Keep visible red text after CSI split; drop internal `[complete, carry]` tuples. |
| keeps what a terminal would show | REWRITE B | Keep chunked 10%→60%→100% and CRLF readable text; drop direct private CR helper tests. |
| splits chunks into lines and keeps the line in progress | REWRITE B | Assert visible one/tw then one/two/three, remove partial/lines fields and empty-append object identity. |
| caps the lines it keeps and counts the ones it dropped | REWRITE B | Bound actual production buffer, expected retained suffix and dropped accounting incl. partial slot; remove exact singular/plural warning copy. Limits are resource bounds, not layout row counts. |
| clips a huge line | REWRITE B | Assert bounded visible line preserving prefix through production limit; remove exact omission sentence and injected limit option. |
| counts UTF-8 bytes, for resuming a stream | DELETE | Dead counter has no production reader; actual resume offset is daemon `X-Log-Next-Offset` retained in F. Remove bytes/utf8Length support. |
| formats sizes and file names | DELETE | Exact human formatting/filename spelling; no independent naming requirement. |

### `packages/ui/src/components/workflows/runs/log-follower.test.ts`

All lifecycle cases use native mocked time and `onState` completion receipts, replacing the arbitrary twenty-`setImmediate` settle loop and timer-queue collaborator assertions.

| Case | Disposition | Reason / failure / coverage |
|---|---|---|
| reads a finished log to its end, window after window, by the daemon's offsets | REWRITE F | Preserve complete redacted text/raw offsets 0,7,…,56 and done state. |
| polls a live log, and a failed read resumes from the same offset once — no duplicates | REWRITE F | Observe one/two once and offsets 0,4,4 after failure/retry; no private queue counts. |
| an error on a finished log is reported, not appended | REWRITE F | Retain empty text plus nonempty error/finished state; remove custom error stub expected to equal itself. |
| stop() ends it: no further reads, no timer | REWRITE F | After stop and clock advance/wake, reads stay at one; no private timer shape. |
| a live log held at a partial last line waits for the next poll instead of spinning | REWRITE F | One read before polling and second on poll; external no-progress response must not cause tight IO loop. |
| readWholeLog reads every window to the end (the download) | KEEP F | Full 50-character download despite 16-byte windows; distinct full-download owner. |
| parseWorkflowLogWindow reads the X-Log-* headers, case-insensitively | KEEP F | Literal headers decode raw cursor/eof/size/live; absent-header fallback uses bytes. Protocol decoder has no stronger client test. |

### `packages/ui/src/components/workflows/runs/use-run-history.test.ts`

| Case | Disposition | Reason / failure / coverage |
|---|---|---|
| starts the older pages over when the first page's cursor moved (a reload) | DELETE | Merely checks equality predicate; never loads/discards an older page, so cannot detect promised visible behavior. Inline private `firstPageReplaced` at its only production call and remove export. Pagination merge remains L; actual hook reset is a coverage gap explicitly left rather than claiming this predicate tested it. |

### `packages/ui/src/components/workflows/steps/steps-logic.test.ts`

| Case | Disposition | Reason / failure / coverage |
|---|---|---|
| dresses the outline: names, summaries, outputs and their wiring, problems | DELETE | Wrapper fields/appearance and arranged summary callback result; API outline/validation tests own semantics. |
| a plain success child is not labelled; a join lists what leads into it | DELETE | Duplicates API outline diamond/join and UI outline display owners. |
| an empty workflow has no trigger | DELETE | Empty-object declaration/change detector, no distinct workflow failure. |
| splices into a chain: the new block goes between, downstream shifts a column right | REWRITE S | Keep a→new→b preserving t→a; remove coordinates. |
| an unconnected output: added and connected, placed right of its source | DELETE | Delegates unchanged to canvas addBlock; covered by connection.test.ts `adds a block wired from an output...`; remaining assertion geometry. |
| a block with no outputs (Stop) never splices: it becomes another branch | KEEP S | Preserve a→b when adding a→Stop; Steps conditional policy not owned by addBlock. |
| the failure output: one more branch | DELETE | Delegation to canvas connection output-handle test; no Steps-specific branch decision when unconnected. |
| the first step goes after the trigger; with no trigger, loose | REWRITE S | Keep t→new and adding standalone trigger; assert selected node id/type rather than mere row counts. |
| connect candidates: connectable first, with why the rest cannot | REWRITE S | Keep valid Stop first, trigger/self absent and ancestor refused; use nonnull refusal, not word `/loop/`. UI candidate policy distinct from edge validator. |
| connectStep adds the edge, or nothing when refused | DELETE | One-line wrapper over `connectBlocks`, covered in canvas/connection.test.ts. Production wrapper remains used by PhoneEditor. |
| move to another output: re-hangs the row's edge; loops are refused | REWRITE S | Keep current-output flag, descendant refusal, i:false→y replacing i:true→y and graph unchanged after refused cyclic move; remove exact reason/object identity. |
| deleting a middle step heals the chain | REWRITE S | Keep t→b and removed node id; replace count with actual remaining ids. |
| a join (two edges in) is deleted without guessing a heal | KEEP S | Removes ambiguous join edges while retaining t→a/t→b; no invented a/b→z. |
| duplicate puts the copy right after the original, taking over what it fed | REWRITE S | Keep a→copy→b with t→a; remove geometry and reminted-name assertion (clipboard owner). |
| disable / enable | REWRITE S | Assert selected a disabled while other nodes remain enabled, then semantic enabled false; do not require deletion rather than false property. |
| the Jira template reads as one chain with a failure branch | DELETE | Template title/order inventory duplicates API templates/outline examples. |

## Production seams / dead support

Before removal, repository-wide references show: `splitIncompleteEscape`, `applyCarriageReturns`, `stripAnsi` only used inside log-buffer and tests; `utf8Length`/`LogBufferState.bytes` only used by the dead counter test and internal accumulation; injected log limits only tests; follower timer implementation/options, offset option, state getters and download max-window override have no production callers (LogViewer uses read/live/onText/onState/errorText and stop/wake). Internalize helpers, remove dead counter and test-only configuration/getters, use real native timers. `firstPageReplaced` has only the hook and its test; inline condition. Keep user-visible production behavior and default resource limits unchanged. No changes to shared `run-fixtures.ts` or `testing.ts`.

Risk: low, because production-used operations retain default behavior; resource-bound tests use actual limits and asynchronous tests use settled-state callbacks. History reset remains untested by a hook-level test (the deleted predicate never proved reset). Arbitrary display copy, geometry, and dead counters intentionally have no replacement coverage.

## Validation

Planned focused command from `packages/ui`:

```sh
pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/lib/workflows/run-view.test.ts src/lib/workflows/format.test.ts src/components/workflows/runs/log-buffer.test.ts src/components/workflows/runs/log-follower.test.ts src/components/workflows/steps/steps-logic.test.ts
```

Results will be appended after implementation. Root agent owns repository typecheck/test/build gates and final commit/push.

Additional pre-edit reference check: `hopCountText` in run-view is referenced only by the deleted exact-hop-copy test; remove this dead formatter. Other run-view formatting helpers still have production consumers in `BlockRunDetails`, `RunHeader`, or `RunsList` and remain.


### Completed results

- Baseline focused command (same imports and test paths as above, plus `src/components/workflows/runs/use-run-history.test.ts`) passed **69/69 tests**, before edits.
- Final focused command above passed **37/37 tests**, zero failures/cancellations/skips.
- Reviewed the final scoped source and test diff. `git diff --check -- packages/ui/src/lib/workflows/run-view.ts packages/ui/src/lib/workflows/run-view.test.ts packages/ui/src/lib/workflows/format.test.ts packages/ui/src/components/workflows/runs/log-buffer.ts packages/ui/src/components/workflows/runs/log-buffer.test.ts packages/ui/src/components/workflows/runs/log-follower.ts packages/ui/src/components/workflows/runs/log-follower.test.ts packages/ui/src/components/workflows/runs/use-run-history.ts packages/ui/src/components/workflows/runs/use-run-history.test.ts packages/ui/src/components/workflows/steps/steps-logic.test.ts` passed.
- `pnpm --filter @orquester/ui typecheck` ran and reported errors only in concurrently edited agent-chat tests (stale composer/keybinding/reducer/retention/status/store/stream/title/transport imports/options and markdown processor plugin typing). No errors were reported in this cleanup scope. Parent/root owns integrated rerun after those edits finish.
- Whole-tree `git diff --check` found trailing blank lines in concurrently edited codex child-routing/seam-testing, right-rail keyboard/state, and agent-chat title files; sent to parent for final integration. This scope's diff is clean.
- Net test-source change: **465 fewer lines** across six assigned test files; the broader scoped source diff is **522 fewer lines**. The separate audit document records the full case-level dispositions.
- Removed dead support: `ManualTimers` and arbitrary settle polling, test-only log parser exports, buffer byte accounting/UTF-8 helper, configurable test log limits, follower timer injection/unused polling-retry-offset options/getters, unused download limit override, `firstPageReplaced`, and `hopCountText`.
- No shared fixtures, snapshots, scripts or production behavior were changed to preserve tests. No commit was made by this subtask; parent/root handles integration and commit/push.
