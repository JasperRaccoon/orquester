# Implemented workflow state test cleanup

This record was created before edits. Scope: three named test files below and their production owners. Root owns final repository gates and commit/push.

Independent sources: `docs/superpowers/specs/2026-09-28-automated-workflows-design.md` §§3.4, 5.11, 7.1–7.3, 8.1–8.2; shared workflow request/event/config types in `packages/api/src/workflows`; AGENTS bridge-payload validation, connection isolation, idempotency and ordering requirements. Current production owners were read before disposition.

## Failure modes considered before retaining isolated units

Editor: lost edits at autosave/load/reconnect boundaries, stale revision writes, failed save data loss, false/self conflicts, incorrect explicit resolution, stale validation and undo corrupting enable/selection state. Store: late response overwrites newer state, cross-connection/workflow leakage, malformed payload enters UI, terminal run/block regressions, stale caches after reconnect, optimistic state survives refusal, wrong manual overlap action. Notifications: incorrect outcome/preferences, missing or duplicate alerts, subworkflow/test alerts in the wrong channel, premature read marking, hidden-page suppression and old-connection residue.

## Six-part bar for every retained or rewritten row

Each row supplies the exact independent contract and recognizable failure (items **1–2**). **3:** expected revisions, names, statuses, protocol codes, identities and boolean preferences are literal fixtures or the specified input data; no expected value is computed by the implementation under test. **4:** editor actions/state and transport requests are the production hook seam; store actions/events/state are the production hook/event-router seam; notification rules are exported SDK functions, and stateful notification actions are the UI/event-router seam. **5:** assertions constrain externally consumed data and state, never private object identity, collaborator call order, markup or prose; removed exact-copy/count/identity assertions are recorded below. **6:** each retained race/stateful operation belongs to these owners and has no stronger remaining owner; generic history and patch semantics are deleted in favor of the specific lower owners named below. Public notification rule tests own pure policy, while retained store tests own deduplication, visibility, preference-source selection, dismissal and connection lifecycle rather than replaying policy. These explicit items 3–6 apply to each KEEP/REWRITE row together with its specific contract/failure; DELETE rows identify the stronger coverage or absent requirement.

Non-test callers: `components/workflows/use-workflow-editor.ts` constructs/retains editors and reads state; editor forms/canvas invoke change/undo/redo/enable/flush; `components/workflows/hooks.ts`, rail/editor/run components consume the workflows store; `store/app.ts` routes events/resets/reconnects; workflow toast/Attention Center/run views consume notification actions/state. Notification rule functions are intentionally public via `packages/ui/src/index.ts` and remain exported. Repository reference scans show timer/remote/mintId editor options, editor reset, document-visibility setter and merge helper exports have test-only external callers; normal production behavior will use native timers/store/document and private helpers. No shared app or fixture changes are planned.

Risk: deleting duplicates has low coverage risk; native timer/store conversion has moderate cleanup/isolation risk, covered by all focused tests and UI typecheck. Runtime semantics must remain unchanged. API stubs supply protocol responses/record requests; they do not compute editor/store state or notification decisions.

Validation (before and after): `cd packages/ui && pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/lib/workflows/editor-store.test.ts src/lib/workflows/store.test.ts src/lib/workflows/notifications.test.ts`. UI typecheck: `pnpm --filter @orquester/ui typecheck`. Root runs full gates.

## `packages/ui/src/lib/workflows/editor-store.test.ts`

| Original test | Disposition | Contract, failure or deletion reason |
|---|---|---|
| loads the definition as the draft, clean, at its revision | DELETE | Initial clean draft/revision is already exercised by autosave, conflict Reload and remote reload; this simple arranged load adds no distinct failure. |
| a missing workflow is an error with words, not a crash | REWRITE | Missing workflow must put editor in error state with no draft and a nonempty diagnostic; drop exact prose. |
| saves 600 ms after the last change, once, with the revision the draft is based on | REWRITE | A second edit resets the specified 600 ms quiet period and saves the latest name with base revision 1; use literal deadline and native mock timers, not exported implementation constants. |
| the body leaves out the daemon's own fields | KEEP | PUT workflow excludes server-owned identity, revision and timestamps per ReplaceWorkflowRequest; catches metadata leaking into writes. |
| serializes saves: a change during a save is saved right after it, on the new revision | KEEP | Edits during an in-flight write must save after its acknowledged revision; detects lost edits and stale/concurrent PUTs. |
| a failed save says so and keeps the edit; flush retries it | KEEP | Transport failure preserves draft and failure state; explicit flush subsequently persists it. Error payload is input data, not product copy. |
| an enabled draft the daemon refuses as invalid is saved disabled, and the editor says so | REWRITE | Invalid enabled definition must still persist the user edit disabled; retain state/data and nonempty notice, remove wording match. |
| a 409 raises the banner and stops autosaving | KEEP | 409 conflict must stop future autosaves and retain conflict state; catches destructive repeated overwrite attempts. |
| Reload takes their copy and drops the edits (and the undo history) | KEEP | Explicit Reload takes the remote revision, discards local edit and clears undo history; catches reapplying abandoned edits. |
| Keep mine overwrites theirs with the draft | REWRITE | Keep mine must persist local name against the fresh remote revision; replace implementation-derived server revision comparison with literal expected revision 3. |
| a newer revision while clean reloads silently | REWRITE | Remote newer revision updates a clean draft without conflict; drop GET count because fetch deduplication is not the contract. |
| a newer revision over unsaved edits raises the banner | KEEP | Newer remote revision cannot overwrite an unsaved draft; must expose conflict and retain the local name. |
| the echo of our own save reloads nothing | REWRITE | An own-save event received before its response must preserve the draft without a false conflict; remove no-GET assertion and express observable result. |
| undo and redo swap whole drafts; a typing burst is one step | DELETE | Whole-draft undo/redo and burst coalescing duplicate history.test.ts ordering/coalescing cases; editor selection/enabled integration remains here. |
| undo drops a selection of blocks the older draft does not have | KEEP | Undo removes selection of a node absent from restored draft; catches dangling inspector selection, not covered by history owner. |
| a rename through patch ops rewrites the references to the old name | DELETE | Patch rename/reference rewriting duplicates packages/api/src/workflows/patch.test.ts rename_node rewrites every template reference and session.fromNode; no distinct editor behavior asserted. |
| enabling saves pending edits first, then patches set_enabled on the new revision | KEEP | Enable after pending edits must send set_enabled using the acknowledged saved revision and preserve the enabled draft; catches out-of-order writes. |
| validates the draft a moment after each change | REWRITE | A changed invalid reference must appear in editor problems without manual validation; use eventual fake-clock advancement rather than implementation-derived validation delay. |
| a reconnect's new client keeps the same editor and its unsaved draft (keyed by connection id) | REWRITE | Reconnecting with a new API client for the same daemon must preserve unsaved data and send it on that transport; other connection must isolate its draft. Remove object identity assertion and test-only options/reset. |
| a load that lands after the user typed keeps the edit and raises the banner | KEEP | A remote load response arriving after typing cannot clobber the edit and must signal revision conflict. |
| the editor's own Enable toggle does not trigger a reload | REWRITE | Enable event echoed before patch response cannot create a false conflict or undo enabled state; drop GET-count requirement. |
| undo never flips enabled | KEEP | Undo restores edited definition while preserving separately enabled execution state; distinct from generic snapshot ordering. |
| reconnect: a failed save is retried; a newer daemon revision is a conflict | KEEP | Reconnect retries failed local writes when revision matches, but preserves local edit in conflict if remote moved ahead. |
| flushAllWorkflowEditors saves a pending edit at once (pagehide) | REWRITE | Lifecycle flush persists pending edit before autosave delay; use normal editor retention/release rather than reset hook. |

## `packages/ui/src/lib/workflows/store.test.ts`

| Original test | Disposition | Contract, failure or deletion reason |
|---|---|---|
| drops a row with no id or name, and repairs the rest field by field | KEEP | Untrusted bridge summary missing id/name is rejected; malformed fields are normalized and foreign/malformed active runs are excluded (AGENTS payload-validation rule; WorkflowSummary contract). |
| loads once, shares a request in flight, and refreshes when stale | KEEP | Concurrent/fresh consumers reuse loaded state; reconnect stale mark triggers refresh and removes absent workflows. Distinct cache lifecycle contract consumed by hooks. |
| a failure is the error state, and a refresh failure keeps the rows | REWRITE | Load failure must publish error state; a failed refresh must preserve visible rows. Existing title promised refresh but tested only initial error and exact copy; use explicit rejected response and observable state/data. |
| an event that crosses the answer is not undone by it | KEEP | A late list response cannot undo newer event revision or resurrect deleted workflow; asynchronous boundary is unique owner. |
| a client of another connection resets first | KEEP | Changing daemon connection drops previous daemon rows; protects connection isolation. |
| ignores malformed payloads and unknown types without a throw | KEEP | Malformed/unknown event payloads cannot throw into event router or create workflow records; protocol tolerance boundary. |
| upserts are idempotent and report what the tabs mirror | KEEP | Repeated upsert creates one row, deletion yields tab effect and prevents resurrection; tab effect is consumed by app event router. |
| a run's start, updates and end fold into its workflow's row | KEEP | Start/update/end events change active/current/completed states; late running updates and stale rows cannot resurrect finished run. |
| a secrets change marks the scopes it touches stale | KEEP | Workflow secret change invalidates only its scope; global change invalidates every scope; malformed secret metadata excluded. |
| a run that ended never reads as running again | DELETE | mergeRunSummary object identity duplicates run event terminal-state regression in this file; remove private test-only export. |
| a block never steps back | REWRITE | A block retry may move forward to attempt 2, but late attempt 1 or earlier same-attempt state cannot regress displayed progress; observe event-driven state, not merge helper object identity. |
| a workflow's recent runs load newest first, and a started run joins them | KEEP | Recent runs are newest-first, scoped to requested workflow, and a live started run joins the list; catches cross-workflow leakage and stale ordering. |
| a loaded run keeps the deltas that landed while it was in flight | KEEP | Full run arriving after block delta must preserve advanced block state while adding previously unseen blocks; unique load/event race. |
| a reconnect marks a held run stale; a forced reload clears it and takes the run's end | KEEP | Reconnect invalidates whole-run cache and force load learns missed termination; catches permanently running stale run. |
| a list refresh updates the summary of a run held whole | KEEP | Run-list refresh must update an already open whole-run summary; catches stale run view when completion event was missed. |
| a run whose definition does not parse is an error, not a crash | REWRITE | Malformed definition in otherwise valid run must create readable load error and no usable run; provide valid remaining fields and assert public error accessor to prevent wrong-reason success. |
| enabling shows at once, then carries the daemon's answer | KEEP | Enable must show optimistic state immediately, send protocol revision and eventually adopt server revision; store owns UI optimistic state. |
| a refusal rolls back and becomes the notice; a stale revision is re-read once | REWRITE | 409 retry uses newly read revision; validation refusal clears optimistic override and exposes error code/workflow notice; remove exact generated text. |
| an overlap skip offers Run anyway | KEEP | Overlap skip exposes run-anyway action for correct workflow and force request on retry; independently specified manual override (§5.11). |
| create shows the row at once; delete removes it, and a gone workflow counts as deleted | REWRITE | Create populates workflow data immediately and deleting already gone workflow removes it successfully; remove trigger-label prose assertion. |
| a reset drops answers still in flight | KEEP | Reset discards in-flight old connection response and leaves store idle; race coverage distinct from completed connection switch. |

## `packages/ui/src/lib/workflows/notifications.test.ts`

| Original test | Disposition | Contract, failure or deletion reason |
|---|---|---|
| reads notify settings field-wise, defaulting to failures only | REWRITE | Absent or malformed notify fields default to failures=true/success=false, explicit boolean preferences survive; literal expectations replace production DEFAULT_NOTIFY_PREFS expected values. |
| counts a Stop block's end as a success and a cancel or a skip as nothing | KEEP | Protocol outcomes failed/interrupted are failure, succeeded/stopped success, cancelled/skipped/running quiet; this exported public classification is the lowest owner. |
| toasts a failure, and a success only when the workflow asks | REWRITE | Failure notice preserves run error/project, success requires opt-in and tests retain test metadata; remove titles and duplicated classification cases. |
| says nothing about a run on screen or a sub-workflow's run | REWRITE | Subworkflow notification suppression is distinct from viewing suppression; delete viewing assertion duplicated by setRunOnScreen store test and retain subworkflow exclusion. |
| puts failed runs in the Attention Center, never test runs | REWRITE | Failed run attention entry preserves navigation identity/error/time/project; test runs excluded. Delete success/off cases duplicated by store preference selection and remove fallback wording assertion. |
| raises a toast and an entry once per run, however often the event arrives | KEEP | Repeated finished event notifies once; unrelated/malformed wire events do not add notifications. Store owns deduplication/protocol entry. |
| stays quiet for the run the user is looking at | KEEP | An actually visible run suppresses both toast and attention; tests mounted view reporting integration beyond pure preference calculation. |
| a run view that is not on screen (Editor mode, hidden tab, hidden document) does not swallow the failure | REWRITE | A hidden document must still notify a failed mounted run; use document visibility value rather than production injection hook, delete already-covered no-view prelude. |
| viewing a LIVE run never silences its later failure | KEEP | Viewing a live run does not mark a future failure read; catches lost failure notification. |
| the workflow summary's notify settings decide (a success toast when asked, no failure when off) | REWRITE | Current workflow summary settings drive notification choice, independently of defaults; state lookup wiring unique owner. |
| clears a run's toast and entry once it is viewed, and stays quiet about it after | KEEP | Viewing removes that run from both channels without affecting another; finished-view tracking suppresses late completion delivery. |
| dismisses the toasts and one entry at a time | KEEP | Dismiss-all toast leaves attention entries; dismiss-one attention leaves the other run; actual UI actions own separate channels. |
| keeps a bounded queue, newest first | DELETE | Bounded queue test derives all expectations from MAX_TOASTS and locks an undocumented implementation capacity; newest-first remains exercised by dismiss test. |
| reads the workflow's notify settings from a loaded run's definition | REWRITE | When current summary absent, frozen definition success opt-in produces notice and no attention entry; assert run identity/tone instead of title. |
| forgets everything on a connection switch | KEEP | Connection reset removes old notifications and deduplication memory, allowing equal run ID on new daemon; isolation contract. |

## Execution and removed support

Cleanup completed for all 60 original cases: 5 DELETE; retained/reworked 55 pass. Focused command above passed baseline 60/60 and final 55/55. No retained baseline regressions failed. Final scoped `git diff --check` passed and all six source/test diffs were reviewed.

Removed support: hand-written editor FakeTimers/FakeRemote and repeated 20-turn settle loop; unused FakeApi GET counter, deferred reject callback, run-list defer slot and secret-call recording. Removed production editor timer/clock/remote/mintId injection options and associated interfaces/wrappers, resetWorkflowEditors; document visibility probe/setter; test-only exports of mergeRunSummary, mergeBlock, autosave/validation/release/notification-cap constants, replaceBody and connectionKeyOf. Retained implementation helpers are private; native platform/store behavior is unchanged. No fixtures or snapshots became unused; shared testing.ts remains used by neighboring suites.

`pnpm --filter @orquester/ui typecheck` was attempted twice. First run raced another agent deleting outline-display.test.ts (TS6053). Second run found concurrent out-of-scope edits in incremental.test.ts, log-follower.test.ts, reducer.logic.test.ts and saved-prompts/list.logic.test.ts; none in this scope. Parent/root was notified to repeat after integration. One focused command was accidentally invoked at repository root and exited before loading tests (path missing); corrected package-directory commands above passed.
