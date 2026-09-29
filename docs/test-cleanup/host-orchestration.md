# Host orchestration test cleanup

Completed cleanup, not an audit-only pass. Audited all **335 original test declarations across 16 files** in this scope: **13 DELETE, 4 REWRITE, 318 KEEP**. Parameterized inputs inside a declaration are recorded with that declaration. The original inventory also contained 128 declarations in `goals.test.ts`, `goal-hold.test.ts`, and `goal-legacy-handover.test.ts`; their separate audit and changes are recorded in [host-goals-current.md](host-goals-current.md).

Every original case is listed below with its original title, disposition, and the particular failure its assertions can detect. Source and test bodies were read before deciding; regex supplied only the inventory. The deletion/rewrite decisions were written here before edits. No retained baseline failure was hidden by deletion.

## Evidence, stable seams, and risk

Read root AGENTS.md/README.md, root and daemon package scripts, the [host module map](../../apps/daemon/src/agent-host/README.md), relevant production owners, service/adapter interfaces, test harness, and overlapping store output tests. Main production callers are `agent-host/main.ts`, `agent-host/server/http-server.ts`, and the orchestrator itself. Specification references below use [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [lazy boot/index design](../superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md), and [goal design](../superpowers/specs/2026-09-24-agent-goals-design.md).

For an isolated policy unit, the possible failures were enumerated before retention: incorrect acceptance/rejection, wrong target/cursor/data, premature or missing timeout, stale state resurrection, unauthorized continuation, or lost/duplicated durable data. Remaining isolated tests exercise those failures. Tests that could pass without exercising their claimed branch were removed or repaired.

For each KEEP/REWRITE row, its file rationale explicitly supplies **B1** (independent contract), **B3** (independent oracle), **B4** (stable seam), **B5** (refactor tolerance), and **B6** (lowest owner/no stronger duplicate). **B2** is the specific caller-visible failure in that row. B5 for every retained file: assertions use behavior, durable protocol fields or service outcomes; no source greps, export inventories, implementation helper identity, markup geometry or private method counts. Adapter operations and store transactions are declared production protocols, not arbitrary internal collaborators. Fixtures may change with a refactor; the behavior oracle does not.

Risk is low: production changes remove only unused exports, a dead predicate and a pass-through wrapper. No provider behavior, persistence format, limit, authorization decision or wire payload changed. Removal reduces duplicate/ineffective coverage; each deletion names the remaining owner or why no genuine behavior had been protected. No coverage threshold or test-count gate was changed.

## Removed support and production seams

- Removed `slash.ts:isSlashInvocation`, which had no production caller, and `providerInputFor`; the sole real call in sendTurnEffect now passes `turn.input` directly. The retained slash integration asserts the exact provider input.
- Removed the orchestrator re-export of `PLAN_IMPLEMENTATION_PROMPT_PREFIX`; fix-wave tests import its existing public API definition. The public API definition remains; the now-unused orchestrator import was also removed.
- Made `orchestrator.ts:serializedSize` private; no external caller existed.
- Made `launch-config.ts:parseThreadLaunchConfig` private; its only external caller was the test. Malformed valid-JSON coverage now exercises the real store load interface used by production.
- Removed item-reads.test.ts’s orphaned `shellRow` helper with its duplicated output-window test. Other fixtures and orchestration testing helpers still have retained consumers; no fixture/snapshot file was orphaned.
- Updated two stale comment references to the removed API `deriveLatestTurn` export, at the API reviewer’s request; behavior unchanged.

## Validation

- Focused initial edit run: `validate`, `turn-watchdog`, `liveness`, `provider-snapshots`, `fix-wave`, `orchestrator` — **183 passed, 0 failed**, exit 0.
- Final owned scope plus stronger storage owner: **345 passed, 0 failed, 0 skipped**, exit 0; 322 retained orchestration tests plus 23 store tool-output tests. Command from `apps/daemon`: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/agent-host/orchestration/{fix-wave,identity,item-reads,launch-config,leftover-work,liveness,orchestrator,provider-snapshots,reconcile,resume-history,session-binding,session-policy,slash,turn-watchdog,v1-residual,validate}.test.ts src/agent-host/store/tool-output.test.ts`.
- After removing the redundant session-binding constant comparison: **8/8 passed**, exit 0.
- `pnpm --filter @orquester/daemon typecheck`: no orchestration diagnostics; failed on concurrent Codex `units.test.ts` edits (`findLast` target support, missing `MockConfig.logPath`, unsupported `refreshSnapshot.force`). Findings were sent to that owner and coordinator. The Codex owner corrected them and its subsequent `pnpm exec tsc --noEmit -p apps/daemon/tsconfig.json` passed; the final repository gate also supersedes this intermediate result.
- Scoped final diff and `git diff --check` reviewed. Repository `pnpm check` and `pnpm test`, integration of concurrent work, commit and push are owned by the coordinating agent and recorded in the aggregate report. No live daemon or dev script was started.

## Decisions before edits

- **DELETE** `apps/daemon/src/agent-host/orchestration/validate.test.ts` — `never rewrites a turn that starts with a slash`. The predicate has no production caller and providerInputFor is an identity wrapper: this test cannot detect the send-path regression. Stronger retained owner: orchestrator.test.ts / never rewrites the turn text of a slash invocation (§4.6.9). Remove unused predicate and inline identity wrapper in sendTurnEffect; no behavior change.
- **DELETE** `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` — `re-checks the pause immediately before cancelling`. Duplicates the approval pause behavior; request arrival disarms the timer, so it does not exercise the claimed expiry re-check. Retained owner: is paused entirely while an approval is open, including resumption after close.
- **DELETE** `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` — `the goal window is re-checked at every normal window, so it holds while the goal does`. Ending the goal at the hour cannot distinguish normal-window rechecking from a single hour timer. The active-goal window test plus goal-ending-while-armed test detect the real timing failures.
- **DELETE** `apps/daemon/src/agent-host/orchestration/liveness.test.ts` — `its end drops it, and an end after expiry changes nothing`. The only completion arrives after TTL expiry, when liveness is already null; completion could be a no-op. Existing terminal-status and self-stamped-agent lifecycle tests own actual completion removal; TTL boundary and refresh cases own expiry.
- **DELETE** `apps/daemon/src/agent-host/orchestration/fix-wave.test.ts` — `a seed leaves the provider free to retitle; a user rename does not`. Duplicate of orchestrator.test.ts / the client’s first-message seed writes the title without marking it manual, with the same threadContext seam and weaker setup.
- **DELETE** `apps/daemon/src/agent-host/orchestration/fix-wave.test.ts` — `the reconcile settles a turn start whose effect never ran`. The fixture fails startSession and waits for the existing error settle before reconciling, so reconcile can do nothing and the assertion passes. Retained reconcile.test.ts explicitly seeds pending log state and asserts first-load settlement.
- **DELETE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `codex applies a model change live`. Only asserts no extra startSession; dropping the entire mode command still passes. The policy suite owns in-session eligibility and goals tests assert changed selections reach adapters; no unique live-model contract proved here.
- **DELETE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `a Claude model change restarts the session`. Only counts starts for the same restart branch already owned at the policy seam (Claude whole-selection comparison), with runtime-mode integration proving restart execution/cursor carry.
- **DELETE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `session/stop settles pending requests and stops the child`. Duplicate of the stronger user-end preparation ordering case and user-end lifecycle case. Its ordering expression also accepts missing respondToApproval (-1 < stop index).
- **DELETE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `requires a commandId`. Duplicate rejection at a higher layer; validate.test.ts / requires a commandId owns the wire validation rule, and receipt tests own orchestration idempotency.
- **DELETE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `rejects a malformed targetTurnCount with INVALID_COMMAND`. Duplicate higher-layer type rejection; validate.test.ts covers non-integer, negative and string values at the parser owner. Revert integration retains valid-count bounds and side-effect protection.
- **REWRITE** `apps/daemon/src/agent-host/orchestration/provider-snapshots.test.ts` — `persists the cache keyed by the agent id it was written for, and ignores a mismatch`. The mismatched cache is loaded with probes: [], so every cache row is ignored even if identity validation is removed. Configure a real probe in the reloader and first prove a valid row hydrates, then mutate only its snapshot identity; retain literal persisted-format assertions. This storage contract has no stronger owner.

REWRITE six-bar justification: (1) §3.2 and host README require cache identities to agree; (2) a foreign provider catalog could be shown otherwise; (3) the literal Claude/Codex identities and on-disk bytes are fixture inputs, independent of registry output; (4) load/get and persisted cache file are stable seams; (5) no private method/order assertion; (6) registry is the lowest owner of correlation, with no equivalent remaining test of payload-id mismatch. Non-test callers: main.ts loads the registry, HTTP reads providers; no seam is removed for this rewrite.

- **DELETE** `apps/daemon/src/agent-host/orchestration/item-reads.test.ts` — `serves output windows including newly appended output and completion`. Duplicates the stronger real-store test `a running call’s windows continue across appends: totalBytes grows, and complete flips when its completion lands` in store/tool-output.test.ts, plus its byte-exact multi-window case. Orchestrator methods simply delegate to this store path; no distinct orchestration rule is exercised. Remove its now-unused shellRow helper. Validation: item-reads and store/tool-output suites. Risk: low, identical store contract retains stronger edge cases.

Additional seam cleanup recorded before editing: `PLAN_IMPLEMENTATION_PROMPT_PREFIX` is re-exported by orchestrator.ts only for fix-wave.test.ts; the shared definition and exports already live in @orquester/api/agent-chat, so use that established public import and remove the orchestration re-export. `serializedSize` has no external callers at all: remove only its export modifier, retaining the private replay-budget helper. No production behavior changes.

Additional decisions before final edits:

- **DELETE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `commits the resolution and the message as ONE append — the card cannot close alone`. Adjacency after successful completion does not establish one append or atomicity: two sequential commits satisfy every assertion. The retained message-mode answer case verifies delivery and card resolution; command receipt and real-store append tests own idempotency and transaction guarantees. No distinct caller failure is proved here.
- **REWRITE** `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` — `rejects an empty turn and an over-long one`. Keep the orchestration-owned empty-turn rejection, remove the overlong-input assertion already covered by validate.test.ts / trims input and enforces the character cap. Rename to rejects an empty turn. The parser permits empty strings for attachment-only sends, so the empty command rule uniquely belongs to this command seam.
- **REWRITE** `apps/daemon/src/agent-host/orchestration/launch-config.test.ts` — `keeps only well-formed fields and drops the empty ones`. Retain the persisted config compatibility behavior through createFileLaunchConfigStore.load against literal launch.json fixtures, and make parseThreadLaunchConfig private. Its only external caller is this test; production uses it internally through load and launchConfigFromRequest. No malformed persisted-object coverage exists in the valid roundtrip or invalid-JSON cases.

Empty-turn rewrite bars: (1) §4.1 command bounds; (2) an empty send creates useless work instead of rejecting; (3) literal empty input and INVALID_COMMAND/400 oracle; (4) public command; (5) no implementation observation; (6) parser deliberately permits empty input, so orchestration owns the attachment-free refusal. Config rewrite bars: (1) AGENTS.md persisted payload validation and §3.1/§8 launcher compatibility; (2) invalid environment data reaches child launch or old config crashes recovery; (3) literal input bytes and hand-written expected fields; (4) store load and launch.json storage contract; (5) parser may be renamed or inlined; (6) file store is the lowest production boundary, with distinct valid-JSON malformed fields not covered elsewhere. Risks: low, no production behavior changed. Validate command/orchestration and launch-config suites.

Final assertion cleanup recorded before editing: **REWRITE** `apps/daemon/src/agent-host/orchestration/session-binding.test.ts` / `the reconcile resumes from the binding when the head has no cursor at all`: remove the continuation-text comparison against imported `CONTINUATION_PROMPT`, and its orphaned import. Reconcile tests separately assert the literal required by GUI §3.3. The real binding-source, successful-send and marker-clear assertions remain. No production seam changes; risk low, validate the session-binding suite.

## Complete disposition inventory

### `apps/daemon/src/agent-host/orchestration/fix-wave.test.ts`

**B1 — independent contract:** GUI spec §§3.1, 3.3, 4.1, 5.1, 5.5, 5.6 and the named Q1/R2 regressions: subscription loss on concurrent first access, failed-send deadlock, missing deletion delivery, watchdog omission, oversized payloads, lost attachments and stale rewind captures.
**B3 — oracle:** Literal event inputs, injected provider failures, actual attachment stat results, expected error/activity states and exact preserved payloads; no fake manufactures the orchestrator outcome.
**B4/B5 — seam and refactor tolerance:** Orchestrator command/read/subscribe/ingestion interfaces, ThreadStore records, and public AgentAdapter operations. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** Each surviving case catches the particular orchestration wiring fault named below. Lower fold, attachment, watchdog and cache unit tests cannot detect omitted calls or incorrect command timing; duplicate title and vacuous reconcile cases were removed.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | a subscription taken while the thread is cold still receives events | A concurrent cold read strands the subscriber on an abandoned runtime. |
| **KEEP** | persists error, so /session/stop and /revert can still recover the thread | A rejected provider send leaves the session stuck starting instead of recoverable. |
| **KEEP** | delivers the terminal deletion event to subscribers | Deleting a thread strands subscribers without the terminal event. |
| **KEEP** | the resumed turn has a liveness bound like any other | A restarted continuation can stay silent forever because no watchdog observes it. |
| **KEEP** | the snapshot caps a huge tool payload and stamps truncated | A large tool payload escapes snapshot bounds without a truncation marker. |
| **DELETE** | a seed leaves the provider free to retitle; a user rename does not | Duplicate of orchestrator.test.ts / the client’s first-message seed writes the title without marking it manual, with the same threadContext seam and weaker setup. |
| **DELETE** | the reconcile settles a turn start whose effect never ran | The fixture fails startSession and waits for the existing error settle before reconciling, so reconcile can do nothing and the assertion passes. Retained reconcile.test.ts explicitly seeds pending log state and asserts first-load settlement. |
| **KEEP** | clears once the user sends the implementation turn | The implementation prompt leaves an already accepted plan pending. |
| **KEEP** | refuses a 'small image' that is really a large file | A forged small image size bypasses the actual file-size bound. |
| **KEEP** | a turn queued behind a compaction | A queued turn loses its attachment resolution after compaction. |
| **KEEP** | a message-mode answer's steer | A message-mode answer sends attachment references without resolved paths. |
| **KEEP** | keeps each array independently, including on a machine-level probe | A sparse probe wipes an unrelated cached catalog array. |
| **KEEP** | a &#96;ready&#96; session state while a turn start is in flight does not complete it | An early ready event incorrectly settles an unsent pending turn. |
| **KEEP** | drops a turn-diff whose turn count is above the revert target | A late checkpoint resurrects state above a revert's target. |

### `apps/daemon/src/agent-host/orchestration/leftover-work.test.ts`

**B1 — independent contract:** AGENTS.md “running state never outlives its process”, host README leftover-work/migration rules, and the durable event/roster contract: repair preserves provenance and supports old launch-less provider records.
**B3 — oracle:** Hand-written open/completed event histories and literal closer fields; where the fold is used, the asserted original data and task state come from the fixture, not from repeating closer-generation logic.
**B4/B5 — seam and refactor tolerance:** leftoverWorkClosings and legacyLaunchStarts are production-called recovery-policy seams producing durable protocol rows. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** These functions are the lowest owner of which recovery/migration rows to emit. Reconcile tests separately prove when those rows are committed and survive restarts; they do not replay this field/classification matrix.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | closes every open call &#96;failed&#96;, with its latest lifecycle row's item type, title, turn, owner and data | An open call survives a crash or loses its recorded context in the closer. |
| **KEEP** | keeps a crash-closed Claude call's command, unmarked: no Load full output, no outputItemId | A command-only Claude payload is incorrectly advertised as truncated output. |
| **KEEP** | never passes a cut output for whole: it takes the opening row's whole data instead, unmarked | A cut output replaces available complete opening data and is advertised as whole. |
| **KEEP** | keeps a cut output marked when no row holds whole data: the cut copy, with its truncated | A genuinely cut output loses its truncation flag when no complete copy exists. |
| **KEEP** | carries whole data as it is — the latest row's, else the opening row's — unmarked | Available complete data is discarded or incorrectly marked truncated. |
| **KEEP** | keeps a crash-closed file change's files: its latest lifecycle row's changedFiles ride the closer | A crashed file change loses the latest changed-file list. |
| **KEEP** | names a crash-closed file change's files when only its closer can: its opening row gone from the window | A file change loses its files after its opening row was evicted. |
| **KEEP** | leaves alone an open call no row of the window anchors — what a rewind left of an adopted call — and closes one a row anchors | A rewind-hidden adopted call is resurrected as a visible failed item. |
| **KEEP** | stops every task the roster shows active — any agent kind — and leaves an idle or a settled one alone | An active task remains running after its process died, or an idle task is falsely stopped. |
| **KEEP** | closes a background shell's item before its task, as the adapters do | A background shell task closes while its tool call remains running. |
| **KEEP** | stamps a task's closer with its start row's turn, so a rewind keeps or removes the two together | Rewinding separates a task closer from its original start turn. |
| **KEEP** | stamps a task whose start the window lost with its latest row's turn | An evicted task start causes its closer to lose its surviving turn association. |
| **KEEP** | puts every closer in exactly the class the fold gives its opener, whatever the owner's spelling | A closer enters another retention class and survives after its opener disappears. |
| **KEEP** | leaves every message still streaming to its readers: no closing names one | Repair extends a streaming message span and cuts unrelated history out of paging. |
| **KEEP** | cancels every parked request but a message-mode question, first, as the host's own settle does | Repair leaves blocking native cards open or cancels persistent message-mode questions. |
| **KEEP** | cancels on the turn the caller names when it settled the turn first — the one the head said was running | Repair loses the original running-turn association after session settlement. |
| **KEEP** | skips what a caller already closed, and finds nothing in a thread with nothing open | Repeated repair writes duplicate closers or invents work on an empty thread. |
| **KEEP** | gives a settled legacy OpenCode agent one start that names a launch id, on its first start's turn and owner | An old OpenCode agent never reopens on its first new launch. |
| **KEEP** | changes nothing the roster shows, and lets a later relaunch reopen the agent | Legacy repair changes the displayed settled agent or prevents a later relaunch. |
| **KEEP** | gives a settled legacy Codex agent one too — a stopped one as much as a completed one | A legacy completed or stopped Codex agent cannot relaunch. |
| **KEEP** | gives none to an agent that needs none: launched with an id, idle, still active, a background task, or no start in the window | Migration writes starts for live, already identified, or non-agent work. |
| **KEEP** | gives none on a Claude thread, whose agents always launched with an id | Migration invents launch identities for Claude records that never needed repair. |
| **KEEP** | names a settled Grok agent the goals build started with none — a &#96;subagent_spawned&#96; no spawn call explained | A Grok agent spawned without a matching call never receives a legacy launch identity. |
| **KEEP** | keeps the rows a capped roster lists: stamped with the roster's own &#96;updatedAt&#96;, never the load's time | Migrating a capped roster changes its ordering or visible timestamps. |
| **KEEP** | gives each agent one, once: a second pass finds nothing | A second migration pass keeps appending starts. |

### `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts`

**B1 — independent contract:** GUI spec §3.1 bounded child liveness and goal design §5: first observable progress, distinct idle/tool/goal windows, and human approvals must not trigger premature cancellation.
**B3 — oracle:** Explicit fake-clock advances, independent literal elapsed deadlines and cancellation outcomes over supplied runtime frames.
**B4/B5 — seam and refactor tolerance:** createTurnWatchdog observe/stop with the documented stall callback; the callback records a real decision rather than implementing it. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** This is the lowest scheduling-policy owner. Host integration keeps only cases proving omitted continuation hooks, cross-turn pending-card state, and user/provider-turn derivation; the two misleading timer cases were deleted.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | does not arm until the protocol produces observable progress | A timer kills a turn before any provider progress established that it started. |
| **KEEP** | cancels a turn that goes silent for the idle window | A silent active turn never receives a stall cancellation. |
| **KEEP** | widens to the tool window while a tool call is open | A long-running tool is cancelled at the shorter idle deadline. |
| **KEEP** | is paused entirely while an approval is open | A user approval is cancelled while awaiting a human, or timing never resumes. |
| **DELETE** | re-checks the pause immediately before cancelling | Duplicates the approval pause behavior; request arrival disarms the timer, so it does not exercise the claimed expiry re-check. Retained owner: is paused entirely while an approval is open, including resumption after close. |
| **KEEP** | never stalls a turn while the thread holds a card waiting on the user — even one an earlier turn raised | A card from an earlier turn fails to pause the current turn's stall timer. |
| **KEEP** | stops on turn completion | A completed turn is cancelled later by a leftover timer. |
| **KEEP** | a card the user holds under an active goal: looked at again a normal window later, and the goal's window names the stall | A goal-associated card uses the wrong eventual stall window after its normal check. |
| **KEEP** | while a goal is active a silent turn is not cancelled at the idle window | An active goal is cancelled at the ordinary idle deadline. |
| **KEEP** | a goal that turns active after the timer was armed is honoured when it fires | A goal activated after arming is ignored by expiry. |
| **KEEP** | a goal that ends while the timer is armed cancels at the normal window, not the hour | A goal ended after arming leaves the turn waiting the full goal hour. |
| **DELETE** | the goal window is re-checked at every normal window, so it holds while the goal does | Ending the goal at the hour cannot distinguish normal-window rechecking from a single hour timer. The active-goal window test plus goal-ending-while-armed test detect the real timing failures. |
| **KEEP** | is still paused entirely while an approval is open | An approval under an active goal is cancelled instead of pausing. |

### `apps/daemon/src/agent-host/orchestration/launch-config.test.ts`

**B1 — independent contract:** AGENTS.md persisted-data validation and secret protection; GUI §§3.1/6.1/8 require restart-safe launcher environment with backward-compatible reads and 0600 credential-bearing files.
**B3 — oracle:** Literal on-disk JSON fixtures, hand-written expected surviving fields, filesystem mode bits and a fresh store instance.
**B4/B5 — seam and refactor tolerance:** createFileLaunchConfigStore load/save and the durable launch.json file. The parser is now private. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The file store owns parsing, permissions and unreadable-file fallback. Orchestrator tests cover create/reload integration, not these malformed-field and actual filesystem-permission conditions.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **REWRITE** | keeps only well-formed fields and drops the empty ones | Retain the persisted config compatibility behavior through createFileLaunchConfigStore.load against literal launch.json fixtures, and make parseThreadLaunchConfig private. Its only external caller is this test; production uses it internally through load and launchConfigFromRequest. No malformed persisted-object coverage exists in the valid roundtrip or invalid-JSON cases. |
| **KEEP** | round-trips through a 0600 file and survives a reread | Credentials are written with unsafe permissions or vanish after a store restart. |
| **KEEP** | degrades to no launcher env on an unreadable file rather than failing the thread | Unreadable launch configuration prevents recovery instead of yielding no configuration. |

### `apps/daemon/src/agent-host/orchestration/session-policy.test.ts`

**B1 — independent contract:** GUI spec §3.4 restart policy and AgentAdapter capabilities: identity/cwd/mode changes restart; supported models switch live; unsupported changes discard incompatible cursor state; Claude selection options participate.
**B3 — oracle:** Explicit bound/desired session fixtures and literal restart/cursor decisions, independent of the comparison implementation.
**B4/B5 — seam and refactor tolerance:** decideSessionRestart, called by ensureSession at the documented restart-policy boundary. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The pure policy owns the complete input matrix. Integration retains actual runtime-mode restart/cursor transport, not another restatement of model-policy decisions.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | is a no-op when nothing changed | An unchanged session is restarted and loses ongoing provider state. |
| **KEEP** | restarts on runtime mode, cwd and account | A mode, directory, or account change reuses a session with the old configuration. |
| **KEEP** | applies a model change live where the adapter can switch in session | A provider that supports live switching is unnecessarily restarted. |
| **KEEP** | restarts and DROPS the cursor when the adapter cannot switch model in session | An unsupported model switch reuses an incompatible resume cursor. |
| **KEEP** | Claude compares the whole selection object, options included | Claude model options change without the required session restart. |
| **KEEP** | other adapters ignore an options-only change | An options-only update needlessly restarts a provider whose policy ignores it. |

### `apps/daemon/src/agent-host/orchestration/liveness.test.ts`

**B1 — independent contract:** GUI §3.1 background work/drain rules and LivenessRegistry protocol: classify working versus monitoring, expire only bounded monitors/TTL work, and preserve independently active agents.
**B3 — oracle:** Literal normalized lifecycle frames and controlled timestamps; expected classifications/absence are hand specified, never computed by a duplicate registry.
**B4/B5 — seam and refactor tolerance:** createLivenessRegistry observe/read operations used by runtime consumption and thread/health summaries. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** This is the lowest event-to-liveness owner. The host tests cover its actual integration and distinguishing provider wakes from user turns; they do not duplicate the provider shape/TTL matrix. The ineffective completion case was removed.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | watch loops alone read as monitoring | A watch-only thread reports active work instead of monitoring. |
| **KEEP** | idle and every terminal status drop out | Idle or terminal tasks keep a thread falsely busy. |
| **KEEP** | a status-free progress row never resurrects a finished task | A late status-free progress row resurrects completed work. |
| **KEEP** | plan-mode bookkeeping is inert | Plan bookkeeping marks the thread busy. |
| **KEEP** | a subagent's own shell is covered by its owner, a nested agent is not | An agent-owned shell is double-counted or an independent nested agent disappears. |
| **KEEP** | session.exited clears the thread | An exited process leaves a thread reporting live work. |
| **KEEP** | classification is per transition, not sticky | A task's previous classification overrides its new transition. |
| **KEEP** | drops a watch loop that has been silent for the TTL | A silent watch loop holds monitoring forever. |
| **KEEP** | a transition refreshes the window | Fresh watch activity fails to extend its expiry. |
| **KEEP** | never expires an agent — a subagent that runs for hours is real work | A long-running subagent expires despite still owning real work. |
| **KEEP** | a turn ending drops a watch loop that reported nothing during it | A watch silent throughout a user turn remains listed afterward. |
| **KEEP** | …but keeps one that did report during the turn | A watch that reported during a turn is incorrectly swept at its end. |
| **KEEP** | an aborted turn sweeps the same way | An aborted user turn fails to remove its stale watches. |
| **KEEP** | a turn end with no turn start recorded leaves the registry alone | An unmatched turn end removes work with no matching sweep window. |
| **KEEP** | an agent survives the turn-boundary sweep | A turn-boundary sweep removes a live agent. |
| **KEEP** | a silent shell survives a wake's end, and still expires at its TTL | A provider-initiated wake wrongly sweeps a still-live background shell. |
| **KEEP** | a turn the host sent still sweeps — after a wake as before one | A previous wake disables normal user-turn sweeping. |
| **KEEP** | a Grok background shell is live monitoring work, bounded by the TTL | Grok shell monitoring is omitted or has no expiry. |
| **KEEP** | …and leaves on its own terminal row | A terminal Grok shell stays live until expiry. |
| **KEEP** | Claude's shapes are unchanged: an agent's shell is its owner's, the parent's monitors | Claude parent and child shell ownership produces the wrong liveness. |
| **KEEP** | Codex's and OpenCode's shapes are unchanged: a self-stamped agent works, rests, stops | Self-stamped Codex/OpenCode agents do not transition through active, idle, and terminal states. |
| **KEEP** | reads working for the TTL after its start, then drops out | A TTL-bearing agent does not expire at its stated boundary. |
| **KEEP** | a running poll re-arms the hour; a status-free row after expiry does not revive it | A running poll fails to refresh expiry, or a status-free stale row revives it. |
| **DELETE** | its end drops it, and an end after expiry changes nothing | The only completion arrives after TTL expiry, when liveness is already null; completion could be a no-op. Existing terminal-status and self-stamped-agent lifecycle tests own actual completion removal; TTL boundary and refresh cases own expiry. |
| **KEEP** | an agent without a TTL still never expires, beside one that does | A TTL-bearing neighbor causes an ordinary agent to expire. |

### `apps/daemon/src/agent-host/orchestration/item-reads.test.ts`

**B1 — independent contract:** GUI §§5.1/5.6/6.3 item-read contract: complete item content remains available when a snapshot is bounded/slimmed, including streamed text and subagent prompts.
**B3 — oracle:** The complete original delta sequence and prompt string, including Unicode, are fixture inputs; expected bytes are not taken from the fold or reader.
**B4/B5 — seam and refactor tolerance:** Orchestrator readThread/readItem against the real durable ThreadStore. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** Only resident-message selection and slim-snapshot/full-item coordination remain here. Store tool-output tests own retained-message reconstruction and incremental output windows; the duplicated output-window case was deleted.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | reads the complete resident message after streamed deltas | A resident streamed message read returns only its last delta or loses Unicode bytes. |
| **KEEP** | an agent's launch prompt: the snapshot carries it slimmed and flagged, the item read serves it as stored | A bounded snapshot either leaks the full prompt or prevents a full stored-item read. |
| **DELETE** | serves output windows including newly appended output and completion | Duplicates the stronger real-store test &#96;a running call’s windows continue across appends: totalBytes grows, and complete flips when its completion lands&#96; in store/tool-output.test.ts, plus its byte-exact multi-window case. Orchestrator methods simply delegate to this store path; no distinct orchestration rule is exercised. Remove its now-unused shellRow helper. |

### `apps/daemon/src/agent-host/orchestration/session-binding.test.ts`

**B1 — independent contract:** AGENTS.md field-wise session binding rules and GUI §§3.3/8: omit unknown cursors, preserve the authoritative binding, and migrate legacy head-only cursors.
**B3 — oracle:** Literal provider cursor values, persisted binding fields and actual adapter resume inputs; unrelated head updates are independent fixture events.
**B4/B5 — seam and refactor tolerance:** Commands, ingestion, reconcile and continuation markers through the public orchestrator and ThreadStore binding contract. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The store owns field-wise patch mechanics. These cases uniquely prove the host chooses/updates the correct cursor source across start, turn, settlement, legacy read and intentional handover.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | records what the session start and the turn learned | Resume identity learned from start/send is not persisted into the binding. |
| **KEEP** | a session-set that dropped the cursor still resumes — the binding carries it | A head update omitting the cursor destroys the ability to resume. |
| **KEEP** | falls back to the head's cursor for a thread written before bindings existed (§8) | A legacy head cursor is ignored before a binding file exists. |
| **KEEP** | a settle that names no cursor never rewrites the binding's | An unrelated settlement clears the authoritative binding cursor. |
| **REWRITE** | the reconcile resumes from the binding when the head has no cursor at all | Boot continuation ignores the binding when its head projection lacks a cursor. Remove the expected continuation text imported from the same production constant: reconcile.test.ts owns the specified literal. Keep actual resume cursor, send occurrence and marker-clear assertions. B1–B6 are the session-binding rationale above. |
| **KEEP** | an intentional stop marks a thread whose head lost its cursor but whose binding kept it | Intentional stop fails to mark resumable work whose cursor lives only in the binding. |
| **KEEP** | a thread with no cursor anywhere is not marked | A non-resumable thread receives a continuation marker. |
| **KEEP** | a create-time resume seeds the binding before any session is started | Create-time resume identity is lost before any provider session starts. |

### `apps/daemon/src/agent-host/orchestration/slash.test.ts`

**B1 — independent contract:** Agent-goals design §4.6 and Codex goal protocol: /goal token boundary, case-insensitive whole subcommands, objective code-point bound, and attachment refusal.
**B3 — oracle:** Literal command strings and expected parsed commands/errors, including boundary and supplementary-Unicode inputs.
**B4/B5 — seam and refactor tolerance:** parseHostGoalCommand is the production-called host command grammar seam. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** This parser is the lowest grammar owner. Goal integration covers adapter delivery/lifecycle, not this string and Unicode boundary matrix.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | is not a goal command unless the trimmed text is /goal followed by a boundary | Ordinary text or a longer slash token is mistaken for a goal command. |
| **KEEP** | a bare /goal and &#96;status&#96; both ask for the status, in any case | Bare or case-varied status requests are treated as new objectives. |
| **KEEP** | pause, resume and clear match the WHOLE argument, case-insensitively | A subcommand prefix consumes objective text instead of matching the whole argument. |
| **KEEP** | edit takes an objective, and without one is a usage error | Goal edit loses its objective or accepts an empty edit. |
| **KEEP** | anything else sets a goal with that objective — trimmed, otherwise verbatim | Setting a goal mutates objective bytes beyond trimming. |
| **KEEP** | an objective is 1–4000 characters after trimming | An empty or over-limit goal objective reaches the provider. |
| **KEEP** | counts characters the way Codex does — code points, not UTF-16 units | Unicode objectives are bounded by UTF-16 units rather than protocol code points. |
| **KEEP** | refuses attachments with every goal command | Attachments silently ride a host goal command that cannot deliver them. |

### `apps/daemon/src/agent-host/orchestration/reconcile.test.ts`

**B1 — independent contract:** GUI §§3.1/3.3/5.1/5.5, lazy-boot design A1/A2/C, AGENTS.md durable logs and cache recovery, plus host README recovery/migration/history-loss regressions.
**B3 — oracle:** Persisted event histories, independently supplied cursor/marker state, injected I/O faults, explicit historical timestamps, real-store restarts, and conservation of fixture item IDs across pages. Expected history membership is taken from input events, not from running the production page planner twice.
**B4/B5 — seam and refactor tolerance:** Orchestrator reconcile, continuation lifecycle, readThread/readHistory and command interfaces; ThreadStore is the durable service seam, with real-store coverage for persistence. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The host owns whether/when repair, migration and continuation execute and how index ranges become bounded pages. Unit closer/index/fold tests cannot catch omitted repair, stale marker authority, boot latency or rows lost between the resident window and pages. Small/large histories cross different late-reference bounds; rewind cases differ in retained turns, turnless rows, gap budgets, and cursor reachability.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | folds an orphaned thread at boot and never reads an idle one | Boot folds all idle histories and delays readiness, or skips an actual orphan. |
| **KEEP** | settles a stale pending turn on the thread's first load after boot, never at boot | A stale pending turn is never settled on first access after lazy boot. |
| **KEEP** | leaves a pending turn inside the grace window alone on first load | A merely slow pending turn is prematurely interrupted within its grace period. |
| **KEEP** | settles a stale pending turn before the first command on it runs | A new command runs against stale pending state before recovery settles it. |
| **KEEP** | an intentional stop after a lazy boot never folds a thread it did not load | Shutdown scans cold idle histories and blocks deploy acknowledgment. |
| **KEEP** | a thread whose head cannot be read is folded at boot rather than guessed | An unreadable head makes boot incorrectly assume the thread is safe. |
| **KEEP** | settles an orphaned turn as an error when continuation is off | An orphan remains running despite continuation being disabled. |
| **KEEP** | continues an orphaned turn when the project opted in, and clears the marker | An opted-in orphan fails to resume or retains a replayable marker. |
| **KEEP** | sends a promptless continuation where the adapter declares it (Codex) | Codex receives a synthetic text prompt instead of its declared promptless continuation. |
| **KEEP** | settles rather than continues a thread whose tab was closed | A closed tab restarts work without user authorization. |
| **KEEP** | settles a thread with no resume cursor | An orphan without a cursor attempts a fresh continuation. |
| **KEEP** | continues a &#96;ready&#96; thread whose marker says prepared-but-never-sent | A prepared-but-unsent continuation on a ready head is lost. |
| **KEEP** | settles individually and never fails the whole pass | One bad thread prevents other orphaned threads from being reconciled. |
| **KEEP** | an intentional stop marks only a project that opted in, and clears on abort | An intentional stop misses eligible markers or an aborted stop leaves them behind. |
| **KEEP** | an intentional stop does NOT mark a project that opted out | An opted-out project receives an automatic continuation marker. |
| **KEEP** | writes the prepared marker and the binding BEFORE the continuation is sent | A provider starts work before its recovery marker and binding are durable. |
| **KEEP** | a continuation that fails says so, and clears its marker | A failed continuation leaves its marker armed or hides its failure. |
| **KEEP** | a prepare that cannot reach disk settles instead of sending | A failed marker write still sends work that the next host cannot reconcile. |
| **KEEP** | a marker from an older turn is ignored rather than replaying the wrong work | An old marker replays a different turn's work. |
| **KEEP** | continues it: the next host resumes the turn the teardown settled, and never settles it again | A marked turn settled by teardown is never continued by its successor host. |
| **KEEP** | an older host's unstamped marker on a settled head is cleared and never continued, however old | An unstamped legacy marker unexpectedly revives a long-settled turn. |
| **KEEP** | an unstamped marker keeps the old rule on a head that still reads running: continued | Backward compatibility drops a valid unstamped marker on a running head. |
| **KEEP** | clears it without continuing when the tab was closed, and writes nothing else | A closed tab is resumed or receives spurious settlement rows. |
| **KEEP** | never continues a marked turn that is no longer the thread's latest, and clears the marker | A marker resumes work after a newer turn has superseded it. |
| **KEEP** | never continues a marked turn that ended on its own, and clears the marker | A naturally completed turn is resumed because an old marker remains. |
| **KEEP** | a stale marker never continues an old turn when a crash leaves a new turn starting | A crash during a new start replays the previous turn's stale marker. |
| **KEEP** | the marker is cleared when the user ends the session | User session end leaves a marker that can restart ended work. |
| **KEEP** | the marker is cleared when a new turn starts — the user's or the provider's own | A newly started user or provider turn inherits an obsolete continuation marker. |
| **KEEP** | the orphaned-thread reconcile closes them too, once it has settled the turn at the time its process last wrote | Orphan recovery leaves cards/tools/tasks running after settling their dead turn. |
| **KEEP** | closes them ahead of a continuation as well: the new process owns none of them | A continuation's new process inherits work owned by the dead process. |
| **KEEP** | never touches a thread an adapter still lists as live | Boot repair cancels work that a current adapter still owns. |
| **KEEP** | never closes anything on a first load that finds the thread live | Lazy first-load repair cancels work belonging to a live session. |
| **KEEP** | a closing that cannot be appended is logged, and the thread still loads | A failed repair append makes the whole thread unreadable. |
| **KEEP** | a thread whose head cannot be read is folded at boot, and closed there | An unreadable head bypasses boot cleanup of dead work. |
| **KEEP** | a snapshot predating the closings reads nothing running on the next host | A stale pre-repair snapshot restores work that closers already stopped. |
| **KEEP** | on the real store: the closings reach the log on disk, and the next host finds nothing left | Crash closers never reach durable storage or repeat on the next real-store restart. |
| **KEEP** | closes every running task, even more than the roster lists at once | Only the roster's first bounded batch of running tasks is repaired. |
| **KEEP** | settles an orphaned turn at the time its process last wrote: its duration is its own, not the downtime's | Turn duration includes the host's downtime instead of ending at its last write. |
| **KEEP** | an orphan with a stale pending turn behind it: both turns end when the process last wrote | A stale pending turn and its orphan predecessor acquire inconsistent finish times. |
| **KEEP** | a stale pending turn a first load settles ends when its process last wrote, and its notice says when it was noticed | Lazy settlement counts downtime or backdates the later explanatory notice. |
| **KEEP** | settles a stale pending turn behind a session already stopped, once: the next host's first load writes nothing | A stopped session's pending turn remains unresolved and triggers endless notices. |
| **KEEP** | never ends a turn before it started: a line flushed out of order after the start does not set the time | An out-of-order flushed row makes a turn finish before it started. |
| **KEEP** | nor ends a turn that never started before it was requested | An unsent turn ends before its request timestamp. |
| **KEEP** | settles at the restart, as it did, when the last line carries no time it can read | An unreadable timestamp prevents settlement or produces an invalid time. |
| **KEEP** | an OpenCode thread's first load names the agent's launch: it still reads completed, and a relaunch reopens it | First-load legacy migration leaves an OpenCode agent unable to relaunch. |
| **KEEP** | a second load appends nothing | A second load repeats an already persisted legacy-launch repair. |
| **KEEP** | an orphaned Codex thread gets it in the reconcile, before a continuation's process can relaunch anything | A continued Codex process relaunches before the old launch identity is repaired. |
| **KEEP** | never on a first load that finds the thread live | Legacy migration rewrites agents still owned by a live process. |
| **KEEP** | small-thread history loses no row after a first-load closer | A first-load closer creates a missing row in small-thread history. |
| **KEEP** | large-thread history loses no row after a first-load closer | A first-load closer creates a missing row beyond the large-history late-reference limit. |
| **KEEP** | a rewind to r-1: once evicted, r-1's late completion and capture are on a page, no row of r-2 | A rewind loses retained late completion/checkpoint rows or leaks removed turns. |
| **KEEP** | a rewind to r-1: once evicted, a first-load closer on r-1 is on a page | A first-load closer on a retained turn disappears from older history. |
| **KEEP** | several rewinds: each kept turn's late rows are on a page once evicted, a removed turn's never | Multiple rewinds duplicate retained late rows or restore removed ones. |
| **KEEP** | a kept turn's late rows count toward a page's activities: no page folds more than a lossless one | Late retained rows bypass the bounded history activity budget. |
| **KEEP** | a cut with more late rows than a page holds is served without them, as before, and says so | An oversized late-row gap is silently represented as complete history. |
| **KEEP** | a page lists a late row's turn only when it lists no later one: a rewind of it reaches the page either way | A page cursor cannot rewind a late row's turn when later turns share its block. |
| **KEEP** | late rows written after the rewind retain their turn on bounded history pages | Post-rewind late rows lose their turn on bounded pages. |
| **KEEP** | after a rewind that left the parent below its limit, every evicted row is reachable (setup A) | Rewinding below the resident limit strands rows after later eviction. |
| **KEEP** | after a rewind whose only full window lies in its cut, every evicted row is reachable (setup B) | A rewind whose full window was cut leaves old retained rows unreachable. |
| **KEEP** | after a rewind with no full window left, an old launch row does not strand r-1's evicted rows | An old launch row moves the boundary before the last reachable full window. |
| **KEEP** | an agent's turnless rows reach a page once evicted: in the cut, and before the next prompt | Turnless agent rows disappear when they lie inside a cut or before the next prompt. |
| **KEEP** | a turn-less prompt the fold's fallback restores out of a rewind's cut is on a page | A fallback-restored turnless prompt is absent from older history. |
| **KEEP** | a turn-less prompt a rewind drops is on no page, even inside a kept turn's range | A dropped turnless prompt leaks back through a kept turn's byte range. |
| **KEEP** | a turn-less prompt one rewind restores and a later one drops: on a page between them, then on none | Later rewinds fail to remove a prompt restored by an earlier rewind. |
| **KEEP** | a page whose fold would evict a message beside its gap messages is served without its gap rows, and says so | Adding gap messages silently evicts another message from a supposedly lossless page. |

### `apps/daemon/src/agent-host/orchestration/v1-residual.test.ts`

**B1 — independent contract:** GUI §§3.2/4.6/5.6/6.1 and documented v1 regressions: per-project OpenCode pooling, replay byte bounds, Grok approval-bypass blocking, and resumed history chronology.
**B3 — oracle:** Literal project paths/slash text/history frames and expected public error, replay bounds and event order.
**B4/B5 — seam and refactor tolerance:** Orchestrator create/command/read operations and public adapter projectPath/history projection contract. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** These are orchestration-specific dispatch and ordering branches: replay slimming differs from snapshots; project-level launch differs from thread policy; history-at-create differs from adapter frame parsing.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | hands the project root to the adapter, so the pool keys on it | OpenCode is launched without the project root needed for correct server pooling. |
| **KEEP** | does not ship the full persisted tool payload on the replay branch | The replay branch sends unbounded persisted tool payloads. |
| **KEEP** | refuses Grok's /always-approve with 400 and appends nothing | Grok's blocked approval-bypass command reaches the provider or mutates the log. |
| **KEEP** | leaves the same text alone on another provider | A provider-specific Grok restriction rejects valid text on another provider. |
| **KEEP** | projects history on CREATE, without waiting for a turn | A resumed conversation stays empty until a new turn is sent. |
| **KEEP** | orders the old conversation ABOVE the new prompt | Imported conversation rows appear after the new prompt and corrupt chronology. |

### `apps/daemon/src/agent-host/orchestration/resume-history.test.ts`

**B1 — independent contract:** GUI §6.1 create-time resume and AgentAdapter history/fork capability rules: tell users when native history is unavailable and protect exclusive conversation ownership.
**B3 — oracle:** Explicit conversation IDs, adapter capabilities, source history and expected refusal/owner metadata or forked resume input.
**B4/B5 — seam and refactor tolerance:** Orchestrator create/command/history reads and stable provider adapter resume interface. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The host owns cross-tab resume ownership and choosing whether to project existing history. Provider replay tests cannot catch those cross-session decisions.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | says so in the timeline when the adapter cannot replay history | A provider without history projection silently presents an empty resumed thread. |
| **KEEP** | does not replay history into a thread that already has one | A thread with existing history imports duplicate provider rows. |
| **KEEP** | refuses the resume and names the tab that owns it | Two non-forkable tabs take ownership of the same provider conversation. |
| **KEEP** | allows it once the owning session is gone | A closed owner's stale record permanently prevents resuming its conversation. |
| **KEEP** | forks instead of refusing where the adapter declares it | A fork-capable provider is incorrectly refused when another tab owns the original. |

### `apps/daemon/src/agent-host/orchestration/provider-snapshots.test.ts`

**B1 — independent contract:** GUI §3.2 provider registry, host README three startup layers/per-read binary identity rule, and AGENTS.md disposable versioned cache compatibility.
**B3 — oracle:** Literal provider identities, cache JSON, clock advances, binary stat identities and catalog/auth deltas. Probes return fixture data; the assertions concern registry scheduling, correlation, persistence and merged results that probes do not implement.
**B4/B5 — seam and refactor tolerance:** ProviderSnapshotRegistry read/watch/refresh/load/startBootRefresh/stop/flush and its persisted cache file. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The registry is the lowest cache/scheduling owner. Independent identity dimensions (agent, configuration, protocol, binary), startup phases, watcher states and live updates are not duplicates. The payload-ID mismatch now first proves successful hydration with a configured probe.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | E9: the registry honours a probe's own ceiling | A provider-specific deadline is replaced by the generic ceiling. |
| **KEEP** | caches, notifies on change and short-circuits an identical configuration | Changed provider data fails to notify/cache, or identical configuration triggers another probe. |
| **KEEP** | a probe that finishes after stop() persists nothing and never recreates the state directory | An in-flight probe recreates a state directory after shutdown. |
| **KEEP** | serialises refreshes so two clients opening Settings run one probe at a time | Concurrent settings reads launch overlapping provider probes. |
| **KEEP** | only runs the background loop while something is watching | An unwatched registry keeps spawning periodic work, or watching never starts it. |
| **KEEP** | a watcher on a registry warmed from the cache does not re-probe at once | A recently cached registry immediately runs a redundant probe when watched. |
| **KEEP** | never re-probes a cwd it already holds and collapses concurrent ones | Repeated or concurrent requests for one cwd launch duplicate probes. |
| **KEEP** | merges a sparse rate-limit update onto the cached snapshot by window id | A partial rate-limit update erases other windows. |
| **REWRITE** | persists the cache keyed by the agent id it was written for, and ignores a mismatch | The mismatched cache is loaded with probes: [], so every cache row is ignored even if identity validation is removed. Configure a real probe in the reloader and first prove a valid row hydrates, then mutate only its snapshot identity; retain literal persisted-format assertions. This storage contract has no stronger owner. |
| **KEEP** | ignores an unreadable cache rather than failing startup | A corrupt cache aborts startup. |
| **KEEP** | stores &#96;error&#96;, not &#96;degraded&#96;, so the client actually raises it | An authentication failure is downgraded to a state the client never surfaces. |
| **KEEP** | clears back to ready on a clean auth.status | A clean authentication event leaves a provider stuck in error. |
| **KEEP** | layer 1: seeds a pending snapshot at construction, before load() and before any probe | Startup has no usable pending provider entries before disk/probes finish. |
| **KEEP** | layer 1: a pending seed is never written to the cache file | A provisional pending seed overwrites useful persisted provider data. |
| **KEEP** | layer 2: a correlated cached snapshot overrides the pending seed | A valid correlated cache fails to replace the provisional seed. |
| **KEEP** | layer 2: an uncorrelated cached snapshot is discarded and the pending seed stands | A foreign installation's cached data replaces the current pending seed. |
| **KEEP** | layer 2: a v1 identity-less payload is discarded | An identity-less old cache is trusted under the new correlation contract. |
| **KEEP** | layer 2: a payload from another protocol version is discarded | An incompatible protocol cache is served as current provider data. |
| **KEEP** | layer 3: startBootRefresh probes every provider, returns synchronously, and is idempotent | Boot probing blocks readiness, omits a provider, or runs twice. |
| **KEEP** | layer 3: a correlated cache makes boot refresh a no-op | An already correlated provider runs an unnecessary boot CLI probe. |
| **KEEP** | the first watcher's priming is a no-op once the boot probe has run | A completed boot probe is repeated by the first watcher. |
| **KEEP** | a read schedules exactly ONE background refresh, and the rate limit holds the next off | Changed binary detection schedules duplicate probes or ignores its rate limit. |
| **KEEP** | the refreshed snapshot is cached under the NEW bin identity | Refreshed data is persisted with the obsolete binary identity. |
| **KEEP** | the disk cache refuses to hydrate a row whose bin identity moved | A moved CLI binary keeps serving an obsolete persisted catalog. |
| **KEEP** | a correlated cached row from before &#96;goals&#96; existed is served with today's capabilities | A pre-goals cache hides capabilities supported by the current host. |
| **KEEP** | the freshest live statement wins: a probe's capabilities replace the seed's | A newer live probe cannot override stale seed capabilities. |

### `apps/daemon/src/agent-host/orchestration/validate.test.ts`

**B1 — independent contract:** GUI §§4.1/4.6/6.1/6.3/8 input limits, attachment security, native compact grammar, provider minimum version and documented resume cursor shapes.
**B3 — oracle:** Literal malformed/valid inputs, fixed bound examples, expected API error codes and documented provider cursor bytes.
**B4/B5 — seam and refactor tolerance:** Production-called validation, compact classification, version gate and resume conversion functions. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** These are the lowest parser/policy owners. Higher duplicate commandId/revert count/length assertions and the dead slash wrapper test were removed. Integration keeps only empty-send orchestration and actual adapter delivery/start enforcement.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | requires a commandId | Commands without idempotency IDs are accepted. |
| **KEEP** | trims input and enforces the character cap | Input normalization or the protocol character/type bound is broken. |
| **KEEP** | caps the attachment count | A request exceeds the attachment-count resource bound. |
| **KEEP** | refuses the whole set if any member fails | An invalid member of an attachment set is silently accepted. |
| **KEEP** | lowercases the mime before judging it and accepts only the four image types | Upper-case image MIME is rejected or unsupported image types pass. |
| **KEEP** | keeps the unknown arm as a forward-compat catch-all, still bounded | Future attachment kinds lose compatibility or escape size bounds. |
| **KEEP** | strips a client-supplied path: a command's ref is a reference and nothing else (§6.3) | A client-controlled filesystem path reaches attachment resolution. |
| **KEEP** | targetTurnCount must be a non-negative integer | A negative, fractional, or string revert count reaches destructive work. |
| **KEEP** | recognises exactly /compact with no attachments | A command argument or attachment is silently consumed as native compact. |
| **DELETE** | never rewrites a turn that starts with a slash | The predicate has no production caller and providerInputFor is an identity wrapper: this test cannot detect the send-path regression. Stronger retained owner: orchestrator.test.ts / never rewrites the turn text of a slash invocation (§4.6.9). Remove unused predicate and inline identity wrapper in sendTurnEffect; no behavior change. |
| **KEEP** | enforces the minimum supported OpenCode CLI version | An unsupported OpenCode binary is allowed through the version policy. |
| **KEEP** | never refuses on an unknown version | An unknown version or another provider is needlessly refused. |
| **KEEP** | refuses a traversal-shaped or flag-shaped id | Resume identifiers can smuggle traversal, flags, or invalid separators. |
| **KEEP** | builds the documented cursor shape per adapter | Create-time resume uses the wrong provider-specific cursor bytes. |

### `apps/daemon/src/agent-host/orchestration/identity.test.ts`

**B1 — independent contract:** GUI §3.4 account switching and AGENTS.md preserve provider resume identity: switching persists configuration without launching, is idempotent, and refuses unsafe in-flight/shared-server moves.
**B3 — oracle:** Literal old/new identities and launch homes, command receipts, retained cursors and explicit in-flight fixtures.
**B4/B5 — seam and refactor tolerance:** Orchestrator setThreadIdentity and subsequent turn commands; identitySwitchRefusal is the production-called policy seam. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** Integration owns persistence/order/next-turn delivery; the pure guard matrix covers distinct queued, compaction, background and pending shapes not repeated across the integration tests.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | records the new identity, rewrites launch.json and starts NOTHING | Switching identity starts a child immediately or fails to persist the new launch configuration. |
| **KEEP** | the NEXT turn restarts the provider under the new home, carrying the cursor | The next turn uses the old account/home or drops its existing resume cursor. |
| **KEEP** | a thread with no live session simply starts under the new identity | An idle thread launches under a stale account after identity change. |
| **KEEP** | an unchanged identity is a no-op receipt: no event, no activity | An identical identity update writes duplicate history or activity. |
| **KEEP** | replays the same receipt for a retried commandId rather than switching twice | A retried identity command switches twice instead of replaying its receipt. |
| **KEEP** | refuses while a turn is running, and the thread keeps its account | An in-flight turn is reassigned to another account. |
| **KEEP** | refuses while a request is parked | A parked request becomes bound to a different account than its provider process. |
| **KEEP** | a thread whose session is in ERROR may still switch — that is the escape hatch | A failed session cannot escape by switching identity. |
| **KEEP** | refuses an OpenCode thread outright — its server owns the identity | OpenCode's shared-server account ownership is bypassed. |
| **KEEP** | refuses a home kind it does not know — an older build's &#96;cliproxy&#96; included | An obsolete or unknown home kind is accepted as a valid account home. |
| **KEEP** | passes only when nothing is in flight | A completely idle session is falsely refused by the identity policy. |
| **KEEP** | refuses every in-flight shape | Queued, compacting, active, or background work bypasses the identity switch guard. |

### `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts`

**B1 — independent contract:** GUI §§3.1–3.4/4.1/5.1/5.4–5.6/6.2–6.4, lazy-boot/index design A2/C/invariant 7, AGENTS.md receipts/log/cursor/account rules, and documented race/recovery regressions.
**B3 — oracle:** Literal commands, events and expected wire codes/state; independently supplied provider failures; original fixture text/IDs for conservation; real file stats for attachment size. Scripted adapters only record public operations or emit supplied frames, and cannot produce the host log/queue/replay/paging decisions being asserted.
**B4/B5 — seam and refactor tolerance:** Public orchestrator command/create/update/delete/read/history/search/summary/subscription operations, durable ThreadStore service rows and AgentAdapter protocol calls. applyEventsChunked is the production event-loop-yield seam, tested for progress and retained data rather than chunk-count shape. Assertions remain valid if internals are renamed, split or inlined; shared B5 above applies.
**B6 — owner and remaining coverage:** The host is the lowest owner of command transaction decisions, scheduling, recovery integration, public replay selection, bounded history assembly, and attachment delivery. Parser/policy duplicates and a false atomicity claim were removed. Fold/index/adapter suites own their local transforms; they cannot detect omitted host dispatch, wrong sequencing, stale cursor selection or history gaps across these boundaries.

| Disposition | Original test name | B2: failure detected / disposition reason |
|---|---|---|
| **KEEP** | a turn persists the user message, opens a pending turn and sends it | An accepted turn is not persisted, opened, or delivered to its provider. |
| **KEEP** | never rewrites the turn text of a slash invocation (§4.6.9) | A provider slash command gains a prefix that prevents native dispatch. |
| **REWRITE** | rejects an empty turn and an over-long one | Keep the orchestration-owned empty-turn rejection, remove the overlong-input assertion already covered by validate.test.ts / trims input and enforces the character cap. Rename to rejects an empty turn. The parser permits empty strings for attachment-only sends, so the empty command rule uniquely belongs to this command seam. |
| **KEEP** | rejects an unknown approval decision | An invalid approval decision reaches the adapter. |
| **KEEP** | answers THREAD_NOT_FOUND for an unknown thread | An unknown thread returns the wrong public error/status. |
| **KEEP** | steering reuses the active turn and opens no second turn row | Steering creates a second turn instead of continuing the active one. |
| **KEEP** | dismiss closes a dismissible question and refuses a native one | A message-mode card cannot be dismissed or a native card is silently abandoned. |
| **KEEP** | replays the recorded sequence for a repeated commandId | Retrying an accepted command delivers duplicate provider work. |
| **KEEP** | a commandId recorded against another thread is COMMAND_ID_CONFLICT | A command ID is accepted for another thread. |
| **KEEP** | a rejected commandId replays the rejection instead of retrying | Retrying a rejected command changes its outcome or repeats side effects. |
| **DELETE** | requires a commandId | Duplicate rejection at a higher layer; validate.test.ts / requires a commandId owns the wire validation rule, and receipt tests own orchestration idempotency. |
| **KEEP** | a provider rejection records an approval failure after accepting the command | A provider rejection disappears after the HTTP command was accepted. |
| **KEEP** | an approval with no live session appends a failure row, not an HTTP error | A stale approval causes a transport error instead of a durable failure row. |
| **KEEP** | a Stop's cancel is one row: the adapter's own report of it is not written | The adapter's cancellation duplicates a host Stop closure. |
| **KEEP** | a turn end's dismissal is the question's one row: a cancellation the adapter reports later is not written | A late adapter cancellation duplicates the host's stranded-question dismissal. |
| **KEEP** | a real answer racing the Stop keeps its row: only a cancellation repeats the host's | Cancellation deduplication discards a genuine answer racing Stop. |
| **KEEP** | a new request reusing the id is not the host's closure: its own cancellation is written | An ID reused by a new request inherits an earlier host cancellation suppression. |
| **KEEP** | a question an earlier turn raised keeps a turn the provider started from being cancelled; closed, a quiet turn is | Provider-initiated turns ignore a still-open earlier question when arming their watchdog. |
| **KEEP** | a shell silent through a turn nobody sent survives its end, and still expires at its TTL | A wake's turn boundary prematurely drops background shell monitoring. |
| **KEEP** | a turn the host sent still sweeps a shell silent through it | A user turn fails to sweep a shell that stayed silent throughout it. |
| **KEEP** | …even when its turn.started is handled before sendTurn answers: the command's row is pending | Early turn.started delivery misclassifies a user turn as a provider wake. |
| **KEEP** | settles every pending request as cancel BEFORE interrupting | Interrupt kills the provider before pending cards receive cancellation. |
| **KEEP** | is valid with no running turn and stops background work | Interrupt cannot stop background work when no turn is currently running. |
| **KEEP** | drops a stale interrupt so it cannot kill the next turn | A stale interrupt kills the next active turn. |
| **KEEP** | appends provider.turn.interrupt.failed when no session is bound | A stale interrupt without a session silently disappears instead of becoming a failure row. |
| **KEEP** | refuses compaction while a turn is running | Compaction begins while a turn is still running. |
| **KEEP** | a /turn during compaction is queued and replayed in order, reusing its message id | Messages sent during compaction are lost, reordered, or given duplicate IDs. |
| **KEEP** | a failed compaction rejects queued messages without sending them | A failed compaction still sends queued turns. |
| **KEEP** | a /turn that is exactly /compact takes the host-native path | Native compact text is sent as an ordinary provider turn. |
| **KEEP** | refuses compaction on an empty conversation | An empty conversation starts an unsupported compaction. |
| **KEEP** | a runtime-mode change restarts the session carrying the cursor | Changing runtime mode loses the resume cursor or keeps the old provider session. |
| **DELETE** | a Claude model change restarts the session | Only counts starts for the same restart branch already owned at the policy seam (Claude whole-selection comparison), with runtime-mode integration proving restart execution/cursor carry. |
| **DELETE** | codex applies a model change live | Only asserts no extra startSession; dropping the entire mode command still passes. The policy suite owns in-session eligibility and goals tests assert changed selections reach adapters; no unique live-model contract proved here. |
| **KEEP** | a mode change on a thread with no session starts nothing | Editing an idle thread's mode starts an unwanted provider child. |
| **KEEP** | lazy recovery: a turn after the session died starts a fresh one from the cursor | A turn after provider exit loses the conversation instead of recovering from its cursor. |
| **KEEP** | refuses to start a CLI below the minimum version | The command path bypasses the minimum supported CLI gate. |
| **KEEP** | refuses a revert target above the started turns even when checkpoint counts are higher | Dense checkpoint counts permit rewinding beyond the actual started turns. |
| **DELETE** | rejects a malformed targetTurnCount with INVALID_COMMAND | Duplicate higher-layer type rejection; validate.test.ts covers non-integer, negative and string values at the parser owner. Revert integration retains valid-count bounds and side-effect protection. |
| **KEEP** | refuses while a turn is running | A running turn is destructively rewound. |
| **KEEP** | checks rollback support before touching disk, and lands the failure as a row | A provider without rollback support has its disk state changed before refusal. |
| **KEEP** | rewinds a thread with ZERO checkpoints, naming the cut to the adapter by turn id | Rewind without checkpoints cannot identify the actual provider turn cut. |
| **KEEP** | prunes the dropped turns' own checkpoints, even where their counts are dense | Rewind leaves dropped turns' sparse/dense checkpoint refs behind. |
| **KEEP** | a target equal to the started turns rolls nothing back and still records the revert | Rewinding to the current count needlessly calls rollback or fails to record the request. |
| **KEEP** | a new turn after a revert captures at target + 1 and moves head.turnCount there | A fresh post-revert turn captures at the stale pre-revert ordinal. |
| **KEEP** | a restart re-derives the guard from the log: a turn started after the revert lifts it | Restart restores an obsolete revert guard and discards the next valid capture. |
| **KEEP** | refuses interrupt in an error session while accepting session stop | An error session accepts interrupt or refuses the recovery stop operation. |
| **KEEP** | a message sent into an errored session restarts it and is sent | A new message cannot recover an errored session. |
| **KEEP** | a message sent into an errored but still live session stops it before starting again | Recovery starts a replacement while the errored provider process is still live. |
| **DELETE** | session/stop settles pending requests and stops the child | Duplicate of the stronger user-end preparation ordering case and user-end lifecycle case. Its ordering expression also accepts missing respondToApproval (-1 < stop index). |
| **KEEP** | the user's end lets the adapter prepare it before any card is answered | Stop answers pending cards before recording the work that user-end must clean up. |
| **KEEP** | the session stop command and a closed tab end the session for the user; a restart does not | A restart is mistaken for user-end, or user-end is not communicated on stop/delete. |
| **KEEP** | closing a tab whose session is no longer live still sweeps what its earlier launches left running | Closing an already-dead tab leaves work from its earlier launches running. |
| **KEEP** | session/stop cancels a pending question with the host's cancel, never an empty answer | A stopped native question receives an empty answer rather than cancellation. |
| **KEEP** | queues commands until the gate opens and runs them in arrival order | Commands run before readiness or arrive out of order after it opens. |
| **KEEP** | a failed gate fails every queued and subsequent command | A failed startup leaves queued commands hanging or permits subsequent work. |
| **KEEP** | answers a snapshot with no cursor and a replay within the budgets | A client cannot bootstrap without a cursor or replay within bounded history. |
| **KEEP** | forces a snapshot when the range contains the thread's creation | A creation event is replayed into a client with no initialized thread snapshot. |
| **KEEP** | forces a snapshot past the replay row budget | An oversized event replay exceeds the public row budget. |
| **KEEP** | forces a snapshot when &#96;after&#96; is above the head | A future client cursor produces an invalid replay instead of a reset snapshot. |
| **KEEP** | forces a snapshot when the log was truncated at a malformed line | A corrupt/truncated log produces an incomplete replay advertised as complete. |
| **KEEP** | persists the user message before any provider work, even when the start fails | A failed provider start loses the user's accepted message. |
| **KEEP** | hands the tool-use id to a capable adapter and records the request as an activity | Background-task requests lose their tool-use target or leave no audit row. |
| **KEEP** | is refused where the provider cannot do it, and when nothing is running | Unsupported or idle background operations are accepted. |
| **KEEP** | answers a message-mode (Codex async) question as a steered message, never over RPC | An asynchronous question answer is sent over a dead native RPC instead of steering. |
| **DELETE** | commits the resolution and the message as ONE append — the card cannot close alone | Adjacency after successful completion does not establish one append or atomicity: two sequential commits satisfy every assertion. The retained message-mode answer case verifies delivery and card resolution; command receipt and real-store append tests own idempotency and transaction guarantees. No distinct caller failure is proved here. |
| **KEEP** | force-resolves a STRANDED native question when its turn ends — never a message-mode one | A completed native turn leaves a blocking card, or dismisses a persistent async card. |
| **KEEP** | folds attachments into the answer text before the adapter sees it | Answer attachments are omitted from the text delivered to the provider. |
| **KEEP** | keeps a multi-select answer's selections when files ride along, and the array when none do | Adding files destroys selected answers or changes an unadorned multi-select's array shape. |
| **KEEP** | reports pending approvals, questions and the latest turn | Thread summaries hide pending cards or report the wrong latest turn. |
| **KEEP** | reports the head's session and whether the title was renamed by hand | Summaries misreport session state or treat provider titles as manual edits. |
| **KEEP** | the client's first-message seed writes the title without marking it manual | A first-message title seed permanently prevents provider retitling. |
| **KEEP** | a provider diff opens a placeholder only for the currently running turn | A stale provider diff creates a checkpoint for the wrong active turn. |
| **KEEP** | a provider diff uses the third turn ordinal when earlier turns have no checkpoints | Checkpoint ordinals are counted by existing checkpoints instead of all started turns. |
| **KEEP** | keeps each thread's live usage for its summary, and moves the snapshot only for the system login | One account/thread's live usage contaminates another thread or the system-login catalog. |
| **KEEP** | persists the launcher env at create and hands it back for the child's env | Create-time launcher environment never reaches the provider child. |
| **KEEP** | resolves a project's launcher env for OpenCode's shared server | OpenCode loses the project-level launcher environment needed by its shared server. |
| **KEEP** | survives a host restart — the daemon sends it once, at create | A restarted host loses launcher settings that the daemon sent only at creation. |
| **KEEP** | feeds the liveness registry and clears it on session.exited | Adapter events never update liveness or an exited session stays live. |
| **KEEP** | reports threads with live background work for the drain-restart, and drops them on session.exited | Drain-restart cannot see real background work or waits on exited work. |
| **KEEP** | a long cold fold yields to the event loop and retains the final activity | A long cold fold blocks the event loop or loses its final row while yielding. |
| **KEEP** | restores events appended after a valid snapshot | Rows appended after a valid snapshot disappear on reload. |
| **KEEP** | discards a snapshot that no longer matches the log and folds the log from the top | A stale snapshot overrides the authoritative event log. |
| **KEEP** | discards a snapshot whose orchestrator extras are missing or malformed | Missing/corrupt orchestration snapshot metadata hides the correct log-derived state. |
| **KEEP** | a snapshot that cannot be written never fails the command | A disposable snapshot write failure rejects a command already committed to the log. |
| **KEEP** | carries the manual title and the revert guard as the log derives them | A warm snapshot loses the manual-title flag or revives an obsolete revert guard. |
| **KEEP** | an index that throws never fails the command whose events landed | A disposable index failure rejects a successfully committed command. |
| **KEEP** | drops a deleted thread's rows | Deleted-thread data remains discoverable in the index. |
| **KEEP** | offers older history exactly when the window has evicted an indexed activity | Older history is offered too early or is hidden after retention actually evicts rows. |
| **KEEP** | stamps an unindexed snapshot &#96;indexed: false&#96;, and refuses history with INDEX_UNAVAILABLE | An unavailable index produces false history instead of an explicit unavailable response. |
| **KEEP** | walks one monster turn back in blocks of 400 — contiguous, lossless, no row twice | Paging a large single turn skips or duplicates activities. |
| **KEEP** | delivers a message streamed across a block boundary whole, on exactly one page | A message spanning the page boundary is split, duplicated, or lost. |
| **KEEP** | walks back across turn boundaries, and honours the &#96;turns&#96; soft cap | Paging ignores turn boundaries or its requested turn cap. |
| **KEEP** | leaves a revert's cut out of the block that spans it | A history page resurrects rows removed by a rewind. |
| **KEEP** | an old row retention keeps out of order does not pull the boundary back | An out-of-order retained row moves the history boundary backward and strands older rows. |
| **KEEP** | a cursor whose activity was rewritten since ends the block just past the one below it | A cursor for a rewritten activity loses or repeats the next older row. |
| **KEEP** | an empty page when nothing is older | An exhausted cursor invents older history. |
| **KEEP** | searches through the index, and answers &#96;indexed: false&#96; without one | Search returns the wrong index results or conceals index unavailability. |
| **KEEP** | hands the adapter every attachment with the size the host STAT'd, and the text as typed | Untrusted attachment metadata reaches the adapter without host resolution/stat. |
| **KEEP** | a steer resolves and stats its files too | Steered messages bypass attachment stat and resolution. |
| **KEEP** | a message-mode answer's steer carries its files, and its text already names them | Async question answers lose attachment refs or their file-name text. |
| **KEEP** | an answer naming a file the host no longer has is refused, and the card stays open | Answering with a missing attachment closes the card without delivering the file. |
| **KEEP** | a turn naming an attachment the host does not have is refused as a row, and nothing is sent | A missing turn attachment is sent anyway or fails without a durable rejection row. |
