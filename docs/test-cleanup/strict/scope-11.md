# Strict host orchestration and goals audit — scope 11

Status: **completed local cleanup** (337/337 focused tests passed, daemon typecheck passed, scoped `git diff --check` passed). Baseline: 341/341 passed using the focused command below. Incoming `/task/stop` cases from commit `9871b50f` have a separate pre-integration disposition below and await the parent's merge. This ledger names every original declaration before test edits. Earlier cleanup ledgers supply historical evidence, but the decisions here use the current tests and current owners.

Independent requirements: [agent chat GUI design](../../superpowers/specs/2026-09-21-agent-chat-gui-design.md) §§3.1–3.4, 4.1, 5.1–5.6; [lazy boot and thread index design](../../superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md) A/C; [goal design](../../superpowers/specs/2026-09-24-agent-goals-design.md) §§4–5 and its explicit race amendments; [agent-host module map](../../../apps/daemon/src/agent-host/README.md); AGENTS.md event-log, idempotency, and handover rules; and the Q1/R2/R5/R6/S1/E2/E5/E6/E8 regressions named in the test files. The accepted wire/adapter contracts in source were checked against those documents. Baseline failures are zero and play no role in deletion decisions.

The source/seam codes below apply **all six bars to each KEEP and REWRITE row**. Each row adds a concrete independent failure, with literal fixture input and expected outcome. No expected value is calculated from the function under test. For every retained row: (1) the named source specifies its scenario; (2) the row says the distinct visible failure; (3) literal statuses, IDs, timestamps, input text, activities and protocol codes can disagree with production; (4) the named public API, persisted log/read, or documented adapter seam is observed; (5) replacing private helper structure while preserving behavior leaves that result unchanged; (6) the named seam is the lowest owner for the *distinct* outcome after the DELETE rows’ stronger coverage is accounted for.

| Code | Requirement source and independent oracle | Stable seam, refactor tolerance, lowest owner / remaining coverage |
| --- | --- | --- |
| FW | GUI §§3.1/3.3/5.5 and the named Q1/R/S/E findings; literal event sequences, provider failure, actual file stat and fixed public error/status. | Orchestrator subscribe/command/read and adapter requests; one wiring regression per case. Fold, validator, and store tests do not exercise each host dispatch path. |
| GOAL | Goal design §§5.1–5.7; fixed goal status, model, request, clock/deadline, mark, ordered user/provider race and activity kind from the accepted contract. | Public host commands/summary/hold/reconcile and durable head plus documented adapter goal/session operations. The host owns continuation, drain lease and handover; adapter and UI tests cannot establish those decisions. |
| LEFT | Host README leftover-work and legacy migration rules; authored open event histories and fixed closer fields, task states, turn and owner IDs. | Production-called leftoverWorkClosings / legacyLaunchStarts result as durable domain rows. Helper owns classification; retained reconcile integration only owns when/how rows persist and appear. |
| HOST | GUI §§3–6, lazy/index A/C and AGENTS event-log/receipt/security contracts; literal commands, events, cursors, errors and real file sizes. | Orchestrator command/read/history/search/summary with durable log and adapter protocol. This is the first seam joining public commands, provider effects and indexed history; lower policy/index/fold tests cannot prove the remaining cross-boundary outcomes. |
| REC | GUI §3.3, lazy/index A/C and host README recovery rules; authored log/head fixtures, explicit timestamps/IDs, real SQLite pages, fixed 400-activity contract. | Public reconcile/read/history and durable store/provider effects. Host owns recovery ordering and page assembly. Lower helper/fold/index tests do not prove the remaining cross-host or indexed read outcomes. |
| HIST | GUI §4.1/§6.1 E5/E6 resume; supplied conversation/cursor, host snapshots, typed resume error and authored historical rows. | Public create/command/read plus documented Ingestion.ingest service events. Host owns collision policy and one-time projection; adapter history mapper and daemon API tests cannot prove it. |
| WATCH | GUI §3.1 and goal design §5.2; authored runtime event order and literal 10/30/60-minute windows. | Production createTurnWatchdog observe/stall callback, invoked by orchestrator. Callback only records a decision; host integration tests own arming, while this is the lowest deadline-policy owner. |

Non-test callers from `rg --text`: main.ts runs reconcile and creates snapshot registry; server/http-server.ts calls public commands, history, hold and legacy handover; orchestrator.ts calls leftoverWorkClosings, legacyLaunchStarts and createTurnWatchdog and projects history on session start; agent-chat/service.ts calls legacyGoalTurnOf. These real callers retain all shared exports and dependencies. None of the four deleted cases keeps a production seam alive. Risk of each deletion: low because the stronger named case remains. Rewrite risk: low because only a duplicate planner assertion and a negative check that could pass without any initial history are removed; the required outcomes remain. Focused validation from `apps/daemon`: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/agent-host/orchestration/{fix-wave,goal-hold,goal-legacy-handover,goals,leftover-work,orchestrator,reconcile,resume-history,turn-watchdog}.test.ts`. Root owns the repository gates and integration.

## Per-original-case disposition

Original dispositions: **4 DELETE, 2 REWRITE, 335 KEEP** (341 total).

The five `/task/stop` declarations added by remote commit `9871b50f` are audited separately below before integration; they were not in this 341-case baseline.

### `apps/daemon/src/agent-host/orchestration/fix-wave.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `a subscription taken while the thread is cold still receives events` | KEEP | FW | A concurrent cold read strands the subscriber on an abandoned runtime. |
| `persists error, so /session/stop and /revert can still recover the thread` | KEEP | FW | A rejected provider send leaves the session stuck starting instead of recoverable. |
| `delivers the terminal deletion event to subscribers` | KEEP | FW | Deleting a thread strands subscribers without the terminal event. |
| `the resumed turn has a liveness bound like any other` | KEEP | FW | A restarted continuation can stay silent forever because no watchdog observes it. |
| `the snapshot caps a huge tool payload and stamps truncated` | KEEP | FW | A large tool payload escapes snapshot bounds without a truncation marker. |
| `clears once the user sends the implementation turn` | KEEP | FW | The implementation prompt leaves an already accepted plan pending. |
| `refuses a 'small image' that is really a large file` | KEEP | FW | A forged small image size bypasses the actual file-size bound. |
| `a turn queued behind a compaction` | KEEP | FW | A queued turn loses its attachment resolution after compaction. |
| `a message-mode answer's steer` | KEEP | FW | A message-mode answer sends attachment references without resolved paths. |
| `keeps each array independently, including on a machine-level probe` | KEEP | FW | A sparse probe wipes an unrelated cached catalog array. |
| ``a `ready` session state while a turn start is in flight does not complete it`` | KEEP | FW | An early ready event incorrectly settles an unsent pending turn. |
| `drops a turn-diff whose turn count is above the revert target` | KEEP | FW | A late checkpoint resurrects state above a revert's target. |

### `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `pauses a goal whose turn is running, marks it at once, says why in one row, and answers its id` | KEEP | GOAL | Deploy hold interrupts the current turn, misses its durable mark or public heldForUpdate activity, or forwards an unwanted model selection. |
| `the held goal's settled turn reads continuing: no finished stamp, the switch still refused` | KEEP | GOAL | A held goal finishing its current turn looks finished or permits account migration before the promised resume. |
| `holds a goal between two of its turns — inside the grace and past it` | KEEP | GOAL | A goal between turns is never held because it has no running turn or its ordinary continuation grace expired. |
| `holds nothing while another thread's own turn keeps the drain waiting, and holds once it settles` | KEEP | GOAL | A hold prematurely pauses goals while an unrelated user turn is still draining, or fails to hold once it settles. |
| `holds nothing while another thread's background work keeps the drain waiting` | KEEP | GOAL | A hold pauses goals while another thread has background tasks/subagents that still block deployment. |
| `holds every holdable goal at once, and a thread already held never keeps the others waiting` | KEEP | GOAL | Only one holdable goal is paused, or an already-held goal prevents other eligible goals from being held. |
| `never holds a goal that runs inside its turn (Claude), and that turn keeps every other goal going` | KEEP | GOAL | A Claude-style turn-contained goal is paused by a Codex-only mechanism or fails to keep other goals running while it drains. |
| `two requests that overlap pause once and write one row` | KEEP | GOAL | Overlapping hold requests produce duplicate pauses or duplicate public hold promises. |
| `a pause that fails holds nothing — the mark written before it goes again — and the next renewal retries` | KEEP | GOAL | A failed pause leaves a false durable hold or cannot be retried on the next lease renewal. |
| `a pause the provider answers in words (no goal left to pause) holds nothing` | KEEP | GOAL | A provider refusal expressed as a response is mistaken for a successful hold and promises a resume. |
| `a pause that hangs is given up after its deadline, holding nothing` | KEEP | GOAL | A hung pause blocks a hold indefinitely or keeps a mark after the 1500 ms deadline without success. |
| `holds nothing once the host has begun to stop` | KEEP | GOAL | An already-stopping host accepts new hold work and writes new promises it cannot fulfill. |
| `resumes a held goal that still reads paused, and clears both marks` | KEEP | GOAL | A 120-second lease expiry fails to conditionally resume a still-paused goal or leaves either durable marker behind. |
| `a renewal pushes the end back: the timer waits out the remainder` | KEEP | GOAL | A renewal fails to extend the lease, or the old timer releases goals before the renewed 120-second deadline. |
| `resumes nothing for a goal achieved, cleared, blocked or limited during its final turn` | KEEP | GOAL | A goal completed/cleared/blocked/limited in its final turn is restarted when the lease expires. |
| `a resume that fails says so on the timeline, the marks go anyway, and the goal stays paused` | KEEP | GOAL | A failed release resume loses its recovery activity or leaves the paused goal falsely held/continuing. |
| `a resume the provider refuses in words puts those words on the timeline` | KEEP | GOAL | A provider refusal on resume is replaced by generic wording or fails to reach the hold-marked activity stream. |
| `the release brings back a provider that died while the goal was held, then resumes it` | KEEP | GOAL | Lease release never restarts a dead provider session before attempting to resume the held goal. |
| `a held session that cannot be brought back is a failed resume, said on the timeline` | KEEP | GOAL | Failure to restart the held provider session silently breaks the user-visible resume promise. |
| `the release starts no session for a goal that ended meanwhile` | KEEP | GOAL | Lease release starts a provider child for a goal that already ended while held. |
| `a session the release starts after a stop began is stopped again, and the mark is kept` | KEEP | GOAL | A child whose lease-release start races host stop survives the stop or consumes its next-host marker. |
| `…even while the pause's own update trails: the release asks the provider, which holds the goal paused` | KEEP | GOAL | A delayed pause notification makes lease release trust stale active fold state and skip the provider conditional resume. |
| `a stop that cuts the hold's pause short keeps the thread held; aborted, the lease's end asks the provider` | KEEP | GOAL | An aborted stop that interrupted pause loses the persisted hold or cannot resume it through the original lease. |
| `a release still queued when a stop begins resumes nothing and keeps the mark` | KEEP | GOAL | A queued release runs after shutdown starts and consumes the hold despite needing the next host. |
| `a stop that begins while the provider answers the release keeps the mark` | KEEP | GOAL | Stop beginning while resume is being answered drops the durable hold mark too early. |
| `a stop under way suspends the lease; an aborted stop brings it back` | KEEP | GOAL | A stop in progress releases held goals by timer, or aborting stop never restores the lease timer. |
| `/goal pause: the hold goes, nothing is resumed, and the goal stays paused` | KEEP | GOAL | The user explicitly pauses a held goal but a lease expiry resumes it anyway. |
| `/goal resume: the goal goes again, renewals leave it alone, and a new lease holds it` | KEEP | GOAL | The user explicitly resumes a goal but lease renewals immediately pause it again instead of honoring the release until a new lease. |
| `a Stop: the hold goes, and the Stop is an ordinary interrupt of the turn it names` | KEEP | GOAL | A user Stop on a held goal leaves the automatic resume obligation or bypasses ordinary named-turn interruption. |
| `a session stop: the hold goes with the session, and nothing is resumed` | KEEP | GOAL | A user session stop leaves a held goal scheduled to restart its provider. |
| `deleting the thread: nothing is held any more, and nothing is resumed` | KEEP | GOAL | A deleted thread remains held and later receives a resume side effect. |
| `/goal status reads the goal and keeps the hold: a read must not cancel the promised resume` | KEEP | GOAL | A read-only /goal status clears the hold and silently cancels its promised resume. |
| `/compact while its final turn runs gets the plain refusal: a held goal starts no next turn` | KEEP | GOAL | Compaction starts before the held final turn ends, or remains blocked after it ends despite no further goal turn being possible. |
| `taken back with /goal pause, as the refusal advises, the goal stays paused and the switch applies` | KEEP | GOAL | A user reclaiming the goal with /goal pause cannot switch accounts or carries the wrong goal state to the new account. |
| `a held goal the host has set going again is no longer held: the pause advice is back` | KEEP | GOAL | Lease release followed by a delayed active notification wrongly permits account switching during the newly resumed goal. |
| `the next host resumes nothing before its gate opens: never on the readiness path` | KEEP | GOAL | Recovery starts sessions/goals on the readiness path before the host gate opens. |
| `the next host resumes the session, THEN the goal — and clears both marks` | KEEP | GOAL | Next-host recovery resumes a goal before its session, sends a new model turn, or fails to clear both durable marks. |
| `…and resumes only the session when the goal no longer reads paused` | KEEP | GOAL | Next-host recovery starts a completed/cleared/limited/blocked goal instead of limiting recovery to its session. |
| `keeps the mark when its own stop cuts the session resume short` | KEEP | GOAL | Stop interrupting next-host session start consumes the held marker needed by another host. |
| `keeps the mark when a stop begins while the goal's resume is answered` | KEEP | GOAL | Stop during next-host goal resume consumes the held marker needed by another host. |
| `a crash while holding leaves the mark, and the next host resumes the goal all the same` | KEEP | GOAL | A crash while holding loses the persisted pause obligation and leaves the next host unable to resume the goal. |
| `a crash after the final turn settled is found off meta.json alone, and resumed the same way` | KEEP | GOAL | A crash after the final turn settled is missed because reconcile only scans orphaned active turns instead of durable meta.json. |
| `the user's own goal command before the boot's resume wins over the mark` | KEEP | GOAL | The user changes the goal before boot recovery but the old hold still overrides that action. |
| `the user's own session stop before the boot's resume clears the mark` | KEEP | GOAL | The user stops the session before boot recovery but the old hold still restarts it. |
| `a thread that cannot be loaded has both marks cleared off meta.json` | KEEP | GOAL | An unreadable held thread retains one/both durable markers because no runtime could be loaded. |
| `a goal resume that fails on the next host takes the hold's promise back on the timeline` | KEEP | GOAL | Next-host goal resume failure silently breaks the previously recorded hold promise. |
| `a held goal whose session the next host cannot start says so too` | KEEP | GOAL | Next-host provider start failure silently breaks the previously recorded hold promise. |
| `a §5.5 resume that fails writes no such row: only a held goal was promised one` | KEEP | GOAL | A plain unheld restart failure writes a misleading hold-recovery promise the user never received. |
| `a pause whose update never reached the old host: the next host asks Codex, which holds the goal paused` | KEEP | GOAL | Next-host recovery skips a goal whose pause reached the provider but whose paused update never reached the old fold. |
| `a stop that cuts the hold's pause short hands the mark over, and the next host asks Codex` | KEEP | GOAL | An old host stop that interrupted the pause loses the hold, so the next host never asks the provider conditionally. |
| `a crash after the mark but before the pause leaves a mark the next host clears safely` | KEEP | GOAL | A crash between mark and pause causes next-host recovery to resume an already-active provider goal or emit a false failure row. |
| `is let go of after three minutes behind other work — not before — and held again once goals are last` | KEEP | GOAL | A held idle goal waits indefinitely behind unrelated work, resumes before three minutes, or cannot be held again when that work clears. |
| `its clock restarts when the held thread runs a turn of its own` | KEEP | GOAL | A held thread doing another turn is released using an old idle timestamp instead of receiving a fresh three-minute idle interval. |
| `its clock resets whenever nothing but goals is in the way` | KEEP | GOAL | A temporary absence of unrelated work fails to reset the idle interval and triggers a premature release later. |
| `a thread's OWN background work is in the way: nothing new is held, and a held goal is let go of` | KEEP | GOAL | Background work on the held goal’s own thread is ignored, causing premature holding or indefinite idle behind its own workers. |
| `a user pause racing a hold queued behind it wins: the hold does nothing` | KEEP | GOAL | A hold queued before the fold receives a user pause overwrites the user action instead of respecting its lease release. |
| `a pause that lands after its deadline is adopted as a hold — mark, then row` | KEEP | GOAL | A pause that succeeds after its timeout leaves a paused provider goal without a durable hold/resume promise. |
| `reads continuing while the fold still says paused — no finished stamp, no push` | KEEP | GOAL | A delayed active notification creates a false finished window after host resume, or continuation never expires if the update is lost. |
| `a Stop in that moment still pauses the goal: Codex would start its next turn once its update lands` | KEEP | GOAL | A Stop during the delayed-notification window fails to pause the goal because the fold still says paused. |
| `the user's own /goal resume opens the same moment: working, and a Stop in it pauses` | KEEP | GOAL | A user /goal resume lacks the delayed-notification grace or cannot be stopped during that window. |
| `the user's own pause right after ends it` | KEEP | GOAL | A user pause immediately after host resume fails to end the optimistic continuation grace. |

### `apps/daemon/src/agent-host/orchestration/goal-legacy-handover.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `resumes each session without a turn, after the gate, and clears the mark` | KEEP | GOAL | The legacy-resume endpoint starts a turn, resumes before readiness gate, loses the conversation cursor, or never consumes its marker. |
| `takes only threads it knows: an unknown id, an unsafe one or a repeat is skipped` | KEEP | GOAL | Legacy recovery accepts unsafe/missing IDs or duplicates a provider session start for repeated IDs. |
| `takes nothing once the host has begun to stop` | KEEP | GOAL | A stopping host accepts legacy recovery work and starts another provider child. |
| `the legacy goal reader accepts the host's actual readThread response and turn identity` | KEEP | GOAL | Daemon legacy handover cannot recognize a genuine host snapshot and therefore strands a provider-initiated Codex goal turn. |

### `apps/daemon/src/agent-host/orchestration/goals.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `never answers a pending message-mode question: the /goal passes the card, which stays pending` | KEEP | GOAL | Host /goal accidentally answers an outstanding message-mode card although no provider turn received the answer. |
| `commits the user's message and NO turn row, and never sends /goal to the model` | KEEP | GOAL | Host /goal sends model input or opens a turn instead of recording only the original user message and context. |
| `ensures the provider session first, exactly as a turn does` | KEEP | GOAL | A goal command reaches a missing provider session before start/resume and loses its request. |
| `during a running turn it joins that turn and opens nothing` | KEEP | GOAL | A goal command during a running turn invents another turn or loses the existing turn association. |
| `a non-empty summary is a visible goal.status info row` | KEEP | GOAL | A nonempty provider goal answer never reaches the user timeline as goal.status/info. |
| `an empty summary appends nothing — the provider's own updates tell the story` | KEEP | GOAL | An empty provider answer produces a spurious goal reply instead of leaving goal updates as the state owner. |
| `a provider refusal is a goal.command.failed error row, never an HTTP error` | KEEP | GOAL | A rejected provider goal operation escapes as a transport error or loses its goal.command.failed/error activity. |
| `a session that cannot start fails the goal command as a row, too` | KEEP | GOAL | A session-start failure loses the accepted goal command instead of producing its failure activity. |
| `a malformed goal command is refused BEFORE anything is committed (R2-7)` | KEEP | GOAL | Invalid goal syntax or forbidden attachments commit a message/turn before the command is rejected. |
| `a provider-command adapter, or one with no goals, gets /goal as an ordinary turn` | KEEP | GOAL | Host parsing intercepts a CLI-owned /goal command, preventing a provider without host-goal capability from receiving it. |
| `an adapter that advertises host goals without goalCommand fails as a row, not a crash` | KEEP | GOAL | An inconsistent adapter capability crashes the host rather than recording the command failure. |
| `knownGoal is the fold's goal without its row stamp, on every start` | KEEP | GOAL | Provider session starts omit the persisted goal or leak the activity-row timestamp into knownGoal. |
| `a finished goal is still handed over as known — the adapter decides` | KEEP | GOAL | A finished goal is discarded before the provider can reconcile its own store on start. |
| `an account-switch restart carries the goal into the new home` | KEEP | GOAL | An account switch fails to carry the goal to the newly selected account home. |
| `a switch applied while no session is live still carries it — the binding names the old home` | KEEP | GOAL | A switch made while offline loses the prior account binding and therefore fails to migrate the goal. |
| `a lazy restart in the SAME home carries nothing` | KEEP | GOAL | A same-home lazy restart unnecessarily overwrites the provider-native goal through carryGoal. |
| `a paused or limited goal is reported but not continuing; a finished one is not reported` | KEEP | GOAL | Unfinished paused/limited goals vanish from summaries, or a finished goal remains presented as ongoing work. |
| `a provider that does not continue across turns is never continuing` | KEEP | GOAL | A turn-contained provider goal is falsely advertised as independently continuing between turns. |
| `without a live session nothing can start the next turn, so it is not continuing` | KEEP | GOAL | A dead provider session leaves a stale active goal permanently shown as continuing. |
| `a continuing goal is never background work and never an active turn (§4.7)` | KEEP | GOAL | A between-turn goal is misclassified as a running turn or background task and blocks the wrong drain path. |
| `finding 2: a turn Codex starts by itself for a host /goal is watched, and cancelled on silence` | KEEP | GOAL | A provider-initiated goal turn has no live watchdog and can remain silently running indefinitely. |
| `finding 2: a replayed turn.started never arms one` | KEEP | GOAL | Replayed historical turn.started arms a new watchdog that cancels a current/replayed conversation. |
| `finding 3: a goal that ends mid-turn gives the silence the normal window, not the hour` | KEEP | GOAL | Ending a goal mid-turn leaves the enlarged silence budget in force and delays normal stalled-turn cancellation. |
| `finding 5: a goal command waits for a compaction — refused before anything is committed` | KEEP | GOAL | A /goal command accepted during compaction is reordered after later input or persisted despite refusal. |
| `finding 6: a goal command records a changed model selection exactly as a turn does` | KEEP | GOAL | A model selected alongside /goal is not persisted for subsequent user turns. |
| `finding 8: a live session whose head says error is not continuing` | KEEP | GOAL | A provider process left alive after an error makes an errored session look as though it will continue. |
| `pause → card cancel → interrupt, with no goal row for the internal pause` | KEEP | GOAL | Stop cancels a pending card before pausing the goal, allowing another automatic turn, or leaks an internal goal reply. |
| `a pause that fails still cancels and interrupts without a goal reply` | KEEP | GOAL | A provider pause failure blocks Stop from cancelling the pending card or interrupting its named turn, or emits a false /goal reply. |
| `a pause that hangs is given up after its deadline, and Stop goes on` | KEEP | GOAL | A nonresponsive goal pause blocks Stop beyond its independently specified 1500 ms deadline. |
| `no pause for a goal that is not continuing, or an adapter without goal commands` | KEEP | GOAL | Stop emits an unsupported/unneeded goal pause for a paused goal or turn-contained provider. |
| `goes ahead for an active goal whose session is stopped — nothing continues it, and the goal is carried` | KEEP | GOAL | An offline active goal wrongly blocks account switching or loses the carried goal on its next start. |
| `goes ahead for an active goal on an errored session` | KEEP | GOAL | An errored session with an active goal wrongly prevents changing its account. |
| `never refuses for a goal the provider does not continue by itself` | KEEP | GOAL | A turn-contained provider goal incorrectly blocks the account switch intended for independently continuing goals. |
| `marks a continuing goal WITHOUT the project's continuation opt-in` | KEEP | GOAL | A goal loses restart continuity because the unrelated per-project turn-continuation opt-in is disabled. |
| `with the opt-in and a turn running, both markers are written` | KEEP | GOAL | A running opted-in goal persists only one of the separate turn and goal restart obligations. |
| `marks nothing for a goal that is not continuing, or that nothing could resume` | KEEP | GOAL | Noncontinuing, unsupported, dead, or cursorless goals receive a restart mark that starts unintended work. |
| `an aborted stop clears the goal marker with the others` | KEEP | GOAL | An aborted host stop leaves restart markers that trigger an unwanted later resume. |
| `resumes the goal's session WITHOUT a turn, then clears the marker` | KEEP | GOAL | Reconcile starts a new turn or wrong conversation instead of restoring the marked provider session once. |
| `a resume that fails clears the marker and stops continuing` | KEEP | GOAL | A failed boot goal resume leaves a durable marker to retry forever or advertises work that cannot continue. |
| `a closed tab's goal is not resumed` | KEEP | GOAL | Reconcile brings back a goal in a tab the user has closed. |
| `an unmarked boot resumes nothing — a crash leaves the goal to the next start` | KEEP | GOAL | An unmarked crash recovery starts goal sessions without an authorized restart obligation. |
| `the user's own Stop before the resume wins over the marker` | KEEP | GOAL | A user session stop before reconcile is undone by a stale goal resume marker. |
| `a provider-started turn is paused AND interrupted, in the normal order` | KEEP | GOAL | A delayed Stop fails to interrupt a newer provider-initiated goal turn after pausing continuation. |
| `a turn the USER started is still protected: pause only` | KEEP | GOAL | A delayed Stop incorrectly interrupts a newer turn the user explicitly started. |
| `with nothing running, the Stop pauses the goal and interrupts nothing` | KEEP | GOAL | A delayed Stop with no running turn fails to pause the autonomous goal or interrupts a nonexistent turn. |
| `without a continuing goal, a late Stop behaves exactly as before` | KEEP | GOAL | A stale Stop for an ordinary conversation unexpectedly interrupts a different turn. |
| `item 2: a stop that lands while the resume is starting keeps the mark and stops the new child` | KEEP | GOAL | A provider child started during host shutdown leaks past stop, or its next-host resume obligation disappears. |
| `item 2: a handover that begins before the resume reaches the provider starts nothing, and keeps the mark` | KEEP | GOAL | A handover beginning before deferred resume effects still starts a child or consumes the marker. |
| `item 2: a handover that begins while the resume is still loading the thread starts nothing` | KEEP | GOAL | A handover beginning during asynchronous thread loading fails the second stop check and starts a child. |
| `item 2: a start the stop tears down is not a failed resume — the mark is kept` | KEEP | GOAL | An interrupted provider start is mistaken for a completed failed resume and consumes the next-host marker. |
| `item 3: a thread that cannot be loaded has its disk mark cleared without starting a session` | KEEP | GOAL | An unreadable goal thread keeps a resume mark on disk or starts a provider session despite the absent runtime. |
| ``item 4: a goal turn killed mid-flight keeps `continuing` through the error settle until the resume`` | KEEP | GOAL | Reconcile settles an orphaned turn as error and prematurely clears continuing before its promised goal resume. |
| `item 4: once the resume has failed, an error is an error again` | KEEP | GOAL | A genuinely failed resume leaves an errored orphaned goal displayed as continuing. |
| ``item 2: `continuing` lasts the grace past the last turn settling, and flips on read with no event`` | KEEP | GOAL | Continuation grace expires before 60 seconds, never expires on reads, or fails to renew after another turn ends. |
| `item 2: a freshly started session is the goal's idle point too` | KEEP | GOAL | Restarting a session with an old last-turn timestamp does not open its own 60-second continuation grace. |
| `item 2: a pending resume mark keeps the goal continuing whatever the clock says` | KEEP | GOAL | A pending durable restart mark ages out during a slow handover before the provider can return. |
| `item 1: the switch is refused only while the goal is continuing — a stale grace lets it through` | KEEP | GOAL | Account switching is allowed during live continuation, or remains blocked after the 60-second idle grace expires. |
| `item 3: a Stop whose turn ends during the pause interrupts the provider's next turn instead` | KEEP | GOAL | A turn ending while Stop awaits pause makes the host interrupt the obsolete turn instead of its provider-started successor. |
| `item 3: a Stop whose turn ends during the pause, with nothing after it, interrupts nothing` | KEEP | GOAL | A turn ending while Stop awaits pause still receives an interrupt despite there being no successor. |
| `item 4: the model picked with a goal command reaches the provider, only when it changed` | KEEP | GOAL | Changed model selection is lost at the goalCommand adapter boundary, or unchanged selections are repeatedly reapplied. |
| `the host's own pause never carries a model — only the user's /goal does, and only a changed one` | KEEP | GOAL | An internal pause sends model changes during Stop and mutates provider settings without a new user model selection. |
| `item 5: /compact under a continuing goal says to pause the goal` | KEEP | GOAL | Both compact entry routes permit compaction while an independently continuing goal can start another turn. |

### `apps/daemon/src/agent-host/orchestration/leftover-work.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| ``closes every open call `failed`, with its latest lifecycle row's item type, title, turn, owner and data`` | KEEP | LEFT | An open call survives a crash or loses its recorded context in the closer. |
| `keeps a crash-closed Claude call's command, unmarked: no Load full output, no outputItemId` | KEEP | LEFT | A command-only Claude payload is incorrectly advertised as truncated output. |
| `never passes a cut output for whole: it takes the opening row's whole data instead, unmarked` | KEEP | LEFT | A cut output replaces available complete opening data and is advertised as whole. |
| `keeps a cut output marked when no row holds whole data: the cut copy, with its truncated` | KEEP | LEFT | A genuinely cut output loses its truncation flag when no complete copy exists. |
| `carries whole data as it is — the latest row's, else the opening row's — unmarked` | KEEP | LEFT | Available complete data is discarded or incorrectly marked truncated. |
| `keeps a crash-closed file change's files: its latest lifecycle row's changedFiles ride the closer` | KEEP | LEFT | A crashed file change loses the latest changed-file list. |
| `names a crash-closed file change's files when only its closer can: its opening row gone from the window` | KEEP | LEFT | A file change loses its files after its opening row was evicted. |
| `leaves alone an open call no row of the window anchors — what a rewind left of an adopted call — and closes one a row anchors` | KEEP | LEFT | A rewind-hidden adopted call is resurrected as a visible failed item. |
| `stops every task the roster shows active — any agent kind — and leaves an idle or a settled one alone` | KEEP | LEFT | An active task remains running after its process died, or an idle task is falsely stopped. |
| `closes a background shell's item before its task, as the adapters do` | KEEP | LEFT | A background shell task closes while its tool call remains running. |
| `stamps a task's closer with its start row's turn, so a rewind keeps or removes the two together` | KEEP | LEFT | Rewinding separates a task closer from its original start turn. |
| `stamps a task whose start the window lost with its latest row's turn` | KEEP | LEFT | An evicted task start causes its closer to lose its surviving turn association. |
| `puts every closer in exactly the class the fold gives its opener, whatever the owner's spelling` | DELETE | LEFT | Only pins the fold’s handling of malformed whitespace agentId and copies that value into generated rows. No independent caller requirement for whitespace identity; real owner/turn preservation is covered by the other closer cases in this file. |
| `leaves every message still streaming to its readers: no closing names one` | DELETE | LEFT | This generated-closer probe is covered by reconcile.test.ts / small-thread and large-thread history loses no row after a first-load closer: each includes a streaming message, requires only the call closer, and walks actual indexed history pages. |
| `cancels every parked request but a message-mode question, first, as the host's own settle does` | KEEP | LEFT | Repair leaves blocking native cards open or cancels persistent message-mode questions. |
| `cancels on the turn the caller names when it settled the turn first — the one the head said was running` | KEEP | LEFT | Repair loses the original running-turn association after session settlement. |
| `skips what a caller already closed, and finds nothing in a thread with nothing open` | KEEP | LEFT | Repeated repair writes duplicate closers or invents work on an empty thread. |
| `gives a settled legacy OpenCode agent one start that names a launch id, on its first start's turn and owner` | KEEP | LEFT | An old OpenCode agent never reopens on its first new launch. |
| `changes nothing the roster shows, and lets a later relaunch reopen the agent` | DELETE | LEFT | Replays the OpenCode migration and relaunch through a fold fixture. reconcile.test.ts / an OpenCode thread’s first load names the agent’s launch proves the same completed-to-running transition through durable first load and the public roster. |
| `gives a settled legacy Codex agent one too — a stopped one as much as a completed one` | KEEP | LEFT | A legacy completed or stopped Codex agent cannot relaunch. |
| `gives none to an agent that needs none: launched with an id, idle, still active, a background task, or no start in the window` | KEEP | LEFT | Migration writes starts for live, already identified, or non-agent work. |
| `gives none on a Claude thread, whose agents always launched with an id` | KEEP | LEFT | Migration invents launch identities for Claude records that never needed repair. |
| ``names a settled Grok agent the goals build started with none — a `subagent_spawned` no spawn call explained`` | KEEP | LEFT | A Grok agent spawned without a matching call never receives a legacy launch identity. |
| ``keeps the rows a capped roster lists: stamped with the roster's own `updatedAt`, never the load's time`` | KEEP | LEFT | Migrating a capped roster changes its ordering or visible timestamps. |
| `gives each agent one, once: a second pass finds nothing` | KEEP | LEFT | A second migration pass keeps appending starts. |

### `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `a turn persists the user message, opens a pending turn and sends it` | KEEP | HOST | An accepted turn is not persisted, opened, or delivered to its provider. |
| `never rewrites the turn text of a slash invocation (§4.6.9)` | KEEP | HOST | A provider slash command gains a prefix that prevents native dispatch. |
| `rejects an empty turn` | KEEP | HOST | An attachment-free empty user turn creates provider work instead of returning the documented invalid-command error. |
| `rejects an unknown approval decision` | KEEP | HOST | An invalid approval decision reaches the adapter. |
| `answers THREAD_NOT_FOUND for an unknown thread` | KEEP | HOST | An unknown thread returns the wrong public error/status. |
| `steering reuses the active turn and opens no second turn row` | KEEP | HOST | Steering creates a second turn instead of continuing the active one. |
| `dismiss closes a dismissible question and refuses a native one` | KEEP | HOST | A message-mode card cannot be dismissed or a native card is silently abandoned. |
| `replays the recorded sequence for a repeated commandId` | KEEP | HOST | Retrying an accepted command delivers duplicate provider work. |
| `a commandId recorded against another thread is COMMAND_ID_CONFLICT` | KEEP | HOST | A command ID is accepted for another thread. |
| `a rejected commandId replays the rejection instead of retrying` | KEEP | HOST | Retrying a rejected command changes its outcome or repeats side effects. |
| `a provider rejection records an approval failure after accepting the command` | KEEP | HOST | A provider rejection disappears after the HTTP command was accepted. |
| `an approval with no live session appends a failure row, not an HTTP error` | KEEP | HOST | A stale approval causes a transport error instead of a durable failure row. |
| `a Stop's cancel is one row: the adapter's own report of it is not written` | KEEP | HOST | The adapter's cancellation duplicates a host Stop closure. |
| `a turn end's dismissal is the question's one row: a cancellation the adapter reports later is not written` | KEEP | HOST | A late adapter cancellation duplicates the host's stranded-question dismissal. |
| `a real answer racing the Stop keeps its row: only a cancellation repeats the host's` | KEEP | HOST | Cancellation deduplication discards a genuine answer racing Stop. |
| `a new request reusing the id is not the host's closure: its own cancellation is written` | KEEP | HOST | An ID reused by a new request inherits an earlier host cancellation suppression. |
| `a question an earlier turn raised keeps a turn the provider started from being cancelled; closed, a quiet turn is` | KEEP | HOST | Provider-initiated turns ignore a still-open earlier question when arming their watchdog. |
| `a shell silent through a turn nobody sent survives its end, and still expires at its TTL` | KEEP | HOST | A wake's turn boundary prematurely drops background shell monitoring. |
| `a turn the host sent still sweeps a shell silent through it` | KEEP | HOST | A user turn fails to sweep a shell that stayed silent throughout it. |
| `…even when its turn.started is handled before sendTurn answers: the command's row is pending` | KEEP | HOST | Early turn.started delivery misclassifies a user turn as a provider wake. |
| `settles every pending request as cancel BEFORE interrupting` | KEEP | HOST | Interrupt kills the provider before pending cards receive cancellation. |
| `is valid with no running turn and stops background work` | KEEP | HOST | Interrupt cannot stop background work when no turn is currently running. |
| `drops a stale interrupt so it cannot kill the next turn` | KEEP | HOST | A stale interrupt kills the next active turn. |
| `appends provider.turn.interrupt.failed when no session is bound` | KEEP | HOST | A stale interrupt without a session silently disappears instead of becoming a failure row. |
| `refuses compaction while a turn is running` | KEEP | HOST | Compaction begins while a turn is still running. |
| `a /turn during compaction is queued and replayed in order, reusing its message id` | KEEP | HOST | Messages sent during compaction are lost, reordered, or given duplicate IDs. |
| `a failed compaction rejects queued messages without sending them` | KEEP | HOST | A failed compaction still sends queued turns. |
| `a /turn that is exactly /compact takes the host-native path` | KEEP | HOST | Native compact text is sent as an ordinary provider turn. |
| `refuses compaction on an empty conversation` | KEEP | HOST | An empty conversation starts an unsupported compaction. |
| `a runtime-mode change restarts the session carrying the cursor` | KEEP | HOST | Changing runtime mode loses the resume cursor or keeps the old provider session. |
| `a mode change on a thread with no session starts nothing` | KEEP | HOST | Editing an idle thread's mode starts an unwanted provider child. |
| `lazy recovery: a turn after the session died starts a fresh one from the cursor` | KEEP | HOST | A turn after provider exit loses the conversation instead of recovering from its cursor. |
| `refuses to start a CLI below the minimum version` | KEEP | HOST | The command path bypasses the minimum supported CLI gate. |
| `refuses a revert target above the started turns even when checkpoint counts are higher` | KEEP | HOST | Dense checkpoint counts permit rewinding beyond the actual started turns. |
| `refuses while a turn is running` | KEEP | HOST | A running turn is destructively rewound. |
| `checks rollback support before touching disk, and lands the failure as a row` | KEEP | HOST | A provider without rollback support has its disk state changed before refusal. |
| `rewinds a thread with ZERO checkpoints, naming the cut to the adapter by turn id` | KEEP | HOST | Rewind without checkpoints cannot identify the actual provider turn cut. |
| `prunes the dropped turns' own checkpoints, even where their counts are dense` | KEEP | HOST | Rewind leaves dropped turns' sparse/dense checkpoint refs behind. |
| `a target equal to the started turns rolls nothing back and still records the revert` | KEEP | HOST | Rewinding to the current count needlessly calls rollback or fails to record the request. |
| `a new turn after a revert captures at target + 1 and moves head.turnCount there` | KEEP | HOST | A fresh post-revert turn captures at the stale pre-revert ordinal. |
| `a restart re-derives the guard from the log: a turn started after the revert lifts it` | KEEP | HOST | Restart restores an obsolete revert guard and discards the next valid capture. |
| `refuses interrupt in an error session while accepting session stop` | KEEP | HOST | An error session accepts interrupt or refuses the recovery stop operation. |
| `a message sent into an errored session restarts it and is sent` | KEEP | HOST | A new message cannot recover an errored session. |
| `a message sent into an errored but still live session stops it before starting again` | KEEP | HOST | Recovery starts a replacement while the errored provider process is still live. |
| `the user's end lets the adapter prepare it before any card is answered` | KEEP | HOST | Stop answers pending cards before recording the work that user-end must clean up. |
| `the session stop command and a closed tab end the session for the user; a restart does not` | KEEP | HOST | A restart is mistaken for user-end, or user-end is not communicated on stop/delete. |
| `closing a tab whose session is no longer live still sweeps what its earlier launches left running` | KEEP | HOST | Closing an already-dead tab leaves work from its earlier launches running. |
| `session/stop cancels a pending question with the host's cancel, never an empty answer` | KEEP | HOST | A stopped native question receives an empty answer rather than cancellation. |
| `queues commands until the gate opens and runs them in arrival order` | KEEP | HOST | Commands run before readiness or arrive out of order after it opens. |
| `a failed gate fails every queued and subsequent command` | KEEP | HOST | A failed startup leaves queued commands hanging or permits subsequent work. |
| `answers a snapshot with no cursor and a replay within the budgets` | KEEP | HOST | A client cannot bootstrap without a cursor or replay within bounded history. |
| `forces a snapshot when the range contains the thread's creation` | KEEP | HOST | A creation event is replayed into a client with no initialized thread snapshot. |
| `forces a snapshot past the replay row budget` | KEEP | HOST | An oversized event replay exceeds the public row budget. |
| ``forces a snapshot when `after` is above the head`` | KEEP | HOST | A future client cursor produces an invalid replay instead of a reset snapshot. |
| `forces a snapshot when the log was truncated at a malformed line` | KEEP | HOST | A corrupt/truncated log produces an incomplete replay advertised as complete. |
| `persists the user message before any provider work, even when the start fails` | KEEP | HOST | A failed provider start loses the user's accepted message. |
| `hands the tool-use id to a capable adapter and records the request as an activity` | KEEP | HOST | Background-task requests lose their tool-use target or leave no audit row. |
| `is refused where the provider cannot do it, and when nothing is running` | KEEP | HOST | Unsupported or idle background operations are accepted. |
| `answers a message-mode (Codex async) question as a steered message, never over RPC` | KEEP | HOST | An asynchronous question answer is sent over a dead native RPC instead of steering. |
| `force-resolves a STRANDED native question when its turn ends — never a message-mode one` | KEEP | HOST | A completed native turn leaves a blocking card, or dismisses a persistent async card. |
| `folds attachments into the answer text before the adapter sees it` | KEEP | HOST | Answer attachments are omitted from the text delivered to the provider. |
| `keeps a multi-select answer's selections when files ride along, and the array when none do` | KEEP | HOST | Adding files destroys selected answers or changes an unadorned multi-select's array shape. |
| `reports pending approvals, questions and the latest turn` | KEEP | HOST | Thread summaries hide pending cards or report the wrong latest turn. |
| `reports the head's session and whether the title was renamed by hand` | KEEP | HOST | Summaries misreport session state or treat provider titles as manual edits. |
| `the client's first-message seed writes the title without marking it manual` | KEEP | HOST | A first-message title seed permanently prevents provider retitling. |
| `a provider diff opens a placeholder only for the currently running turn` | KEEP | HOST | A stale provider diff creates a checkpoint for the wrong active turn. |
| `a provider diff uses the third turn ordinal when earlier turns have no checkpoints` | KEEP | HOST | Checkpoint ordinals are counted by existing checkpoints instead of all started turns. |
| `keeps each thread's live usage for its summary, and moves the snapshot only for the system login` | KEEP | HOST | One account/thread's live usage contaminates another thread or the system-login catalog. |
| `persists the launcher env at create and hands it back for the child's env` | KEEP | HOST | Create-time launcher environment never reaches the provider child. |
| `resolves a project's launcher env for OpenCode's shared server` | KEEP | HOST | OpenCode loses the project-level launcher environment needed by its shared server. |
| `survives a host restart — the daemon sends it once, at create` | KEEP | HOST | A restarted host loses launcher settings that the daemon sent only at creation. |
| `feeds the liveness registry and clears it on session.exited` | KEEP | HOST | Adapter events never update liveness or an exited session stays live. |
| `reports threads with live background work for the drain-restart, and drops them on session.exited` | KEEP | HOST | Drain-restart cannot see real background work or waits on exited work. |
| `a long cold fold yields to the event loop and retains the final activity` | KEEP | HOST | A long cold fold blocks the event loop or loses its final row while yielding. |
| `restores events appended after a valid snapshot` | KEEP | HOST | Rows appended after a valid snapshot disappear on reload. |
| `discards a snapshot that no longer matches the log and folds the log from the top` | KEEP | HOST | A stale snapshot overrides the authoritative event log. |
| `discards a snapshot whose orchestrator extras are missing or malformed` | KEEP | HOST | Missing/corrupt orchestration snapshot metadata hides the correct log-derived state. |
| `a snapshot that cannot be written never fails the command` | KEEP | HOST | A disposable snapshot write failure rejects a command already committed to the log. |
| `carries the manual title and the revert guard as the log derives them` | KEEP | HOST | A warm snapshot loses the manual-title flag or revives an obsolete revert guard. |
| `an index that throws never fails the command whose events landed` | KEEP | HOST | A disposable index failure rejects a successfully committed command. |
| `drops a deleted thread's rows` | KEEP | HOST | Deleted-thread data remains discoverable in the index. |
| `offers older history exactly when the window has evicted an indexed activity` | KEEP | HOST | Older history is offered too early or is hidden after retention actually evicts rows. |
| ``stamps an unindexed snapshot `indexed: false`, and refuses history with INDEX_UNAVAILABLE`` | KEEP | HOST | An unavailable index produces false history instead of an explicit unavailable response. |
| `walks one monster turn back in blocks of 400 — contiguous, lossless, no row twice` | KEEP | HOST | Paging a large single turn skips or duplicates activities. |
| `delivers a message streamed across a block boundary whole, on exactly one page` | REWRITE | HOST | Keep the complete message, single-page occurrence and lossless walk. Remove exact first-page activity count and exact cursor endItemId; these pin page planner shape rather than the public whole-message guarantee. |
| ``walks back across turn boundaries, and honours the `turns` soft cap`` | KEEP | HOST | Paging ignores turn boundaries or its requested turn cap. |
| `leaves a revert's cut out of the block that spans it` | KEEP | HOST | A history page resurrects rows removed by a rewind. |
| `an old row retention keeps out of order does not pull the boundary back` | KEEP | HOST | An out-of-order retained row moves the history boundary backward and strands older rows. |
| `a cursor whose activity was rewritten since ends the block just past the one below it` | KEEP | HOST | A cursor for a rewritten activity loses or repeats the next older row. |
| `an empty page when nothing is older` | KEEP | HOST | An exhausted cursor invents older history. |
| ``searches through the index, and answers `indexed: false` without one`` | KEEP | HOST | Search returns the wrong index results or conceals index unavailability. |
| `hands the adapter every attachment with the size the host STAT'd, and the text as typed` | KEEP | HOST | Untrusted attachment metadata reaches the adapter without host resolution/stat. |
| `a steer resolves and stats its files too` | KEEP | HOST | Steered messages bypass attachment stat and resolution. |
| `a message-mode answer's steer carries its files, and its text already names them` | KEEP | HOST | Async question answers lose attachment refs or their file-name text. |
| `an answer naming a file the host no longer has is refused, and the card stays open` | KEEP | HOST | Answering with a missing attachment closes the card without delivering the file. |
| `a turn naming an attachment the host does not have is refused as a row, and nothing is sent` | KEEP | HOST | A missing turn attachment is sent anyway or fails without a durable rejection row. |

### `apps/daemon/src/agent-host/orchestration/reconcile.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `folds an orphaned thread at boot and never reads an idle one` | KEEP | REC | Boot replaying idle logs delays readiness; orphan remains unsettled. |
| `settles a stale pending turn on the thread's first load after boot, never at boot` | KEEP | REC | Cold concurrent first readers see a stale pending turn or append duplicate settlements. |
| `leaves a pending turn inside the grace window alone on first load` | KEEP | REC | A fresh pending turn is incorrectly failed before its grace period. |
| `settles a stale pending turn before the first command on it runs` | KEEP | REC | First command runs before stale pending work settles. |
| `an intentional stop after a lazy boot never folds a thread it did not load` | KEEP | REC | Intentional shutdown forces unopened history replay. |
| `a thread whose head cannot be read is folded at boot rather than guessed` | KEEP | REC | Unreadable metadata causes an orphan to be skipped instead of recovered. |
| `settles an orphaned turn as an error when continuation is off` | KEEP | REC | Orphan silently remains running when continuation is disabled. |
| `continues an orphaned turn when the project opted in, and clears the marker` | KEEP | REC | Opted-in orphan never resumes or leaves a replayable marker. |
| `sends a promptless continuation where the adapter declares it (Codex)` | KEEP | REC | Promptless-capable provider receives an extra user prompt. |
| `settles rather than continues a thread whose tab was closed` | KEEP | REC | Closed tab restarts work without user consent. |
| `settles a thread with no resume cursor` | KEEP | REC | Missing provider identity still sends a continuation. |
| ``continues a `ready` thread whose marker says prepared-but-never-sent`` | KEEP | REC | Crash after preparation loses the pending continuation when head says ready. |
| `settles individually and never fails the whole pass` | KEEP | REC | One corrupt thread prevents later threads recovering. |
| `an intentional stop marks only a project that opted in, and clears on abort` | KEEP | REC | Opt-in shutdown loses durable stamped marker or abort leaves it set. |
| `an intentional stop does NOT mark a project that opted out` | KEEP | REC | Opted-out project is marked/resumed. |
| `writes the prepared marker and the binding BEFORE the continuation is sent` | KEEP | REC | External continuation starts before durable marker/binding; crash can replay or lose identity. |
| `a continuation that fails says so, and clears its marker` | KEEP | REC | Failed send leaves running binding/marker or erases resume identity. |
| `a prepare that cannot reach disk settles instead of sending` | KEEP | REC | Failed preparation still starts external work. |
| `a marker from an older turn is ignored rather than replaying the wrong work` | KEEP | REC | Marker resumes an older active turn. |
| `continues it: the next host resumes the turn the teardown settled, and never settles it again` | KEEP | REC | Normal teardown settlement suppresses authorized continuation or settles twice. |
| `an older host's unstamped marker on a settled head is cleared and never continued, however old` | KEEP | REC | Legacy unstamped settled marker resurrects old work. |
| `an unstamped marker keeps the old rule on a head that still reads running: continued` | KEEP | REC | Compatible legacy running marker ceases to resume. |
| `clears it without continuing when the tab was closed, and writes nothing else` | KEEP | REC | Closed settled tab resumes or retains marker. |
| `never continues a marked turn that is no longer the thread's latest, and clears the marker` | KEEP | REC | Stale marker resumes a superseded settled turn. |
| `never continues a marked turn that ended on its own, and clears the marker` | KEEP | REC | Naturally finished marked turn runs twice. |
| `a stale marker never continues an old turn when a crash leaves a new turn starting` | KEEP | REC | Older marked turn replaces a newly starting user turn. |
| `the marker is cleared when the user ends the session` | KEEP | REC | User stop leaves restart continuation enabled. |
| `the marker is cleared when a new turn starts — the user's or the provider's own` | KEEP | REC | A new user/provider turn inherits stale continuation intent. |
| `the orphaned-thread reconcile closes them too, once it has settled the turn at the time its process last wrote` | KEEP | REC | Orphan closure runs before settle, has wrong turn owner/time or repeats. |
| `closes them ahead of a continuation as well: the new process owns none of them` | KEEP | REC | Continuation starts while dead-process work still looks live. |
| `never touches a thread an adapter still lists as live` | KEEP | REC | Reconcile closes active work owned by a live adapter. |
| `never closes anything on a first load that finds the thread live` | KEEP | REC | Adapter becoming live before first load has its work falsely interrupted. |
| `a closing that cannot be appended is logged, and the thread still loads` | KEEP | REC | Closure append failure prevents reading otherwise valid history. |
| `a thread whose head cannot be read is folded at boot, and closed there` | KEEP | REC | Unreadable head leaves dead-process work looking live. |
| `a snapshot predating the closings reads nothing running on the next host` | KEEP | REC | A stale disposable fold snapshot hides durable first-load closer rows on the next host and shows work as still running. |
| `on the real store: the closings reach the log on disk, and the next host finds nothing left` | KEEP | REC | Closures never reach disk or replay on another process; dead requests/work remain live. |
| `closes every running task, even more than the roster lists at once` | KEEP | REC | Roster pagination leaves task101+ running or duplicates closures. |
| `settles an orphaned turn at the time its process last wrote: its duration is its own, not the downtime's` | KEEP | REC | Crash downtime inflates completed turn duration. |
| `an orphan with a stale pending turn behind it: both turns end when the process last wrote` | KEEP | REC | Pending and active orphan turns settle at different/incorrect time. |
| `a stale pending turn a first load settles ends when its process last wrote, and its notice says when it was noticed` | KEEP | REC | First-load stale turn uses restart time instead of last write; notice gets old time. |
| `settles a stale pending turn behind a session already stopped, once: the next host's first load writes nothing` | KEEP | REC | Already-stopped session leaves stale pending work unresolved or repeatedly rewrites it. |
| `never ends a turn before it started: a line flushed out of order after the start does not set the time` | KEEP | REC | Out-of-order final timestamp gives a negative running duration. |
| `nor ends a turn that never started before it was requested` | KEEP | REC | Never-started turn ends before its request. |
| `settles at the restart, as it did, when the last line carries no time it can read` | KEEP | REC | Invalid last-write timestamp makes recovery invalid instead of falling back to now. |
| `an OpenCode thread's first load names the agent's launch: it still reads completed, and a relaunch reopens it` | KEEP | REC | Older OpenCode launch cannot reopen on a new activation or changes completed state. |
| `a second load appends nothing` | KEEP | REC | Legacy repair duplicates migration records on later host loads. |
| `an orphaned Codex thread gets it in the reconcile, before a continuation's process can relaunch anything` | KEEP | REC | Codex continuation relaunch occurs before missing legacy identity is repaired. |
| `never on a first load that finds the thread live` | KEEP | REC | Legacy repair mutates a thread another adapter currently owns. |
| `small-thread history loses no row after a first-load closer` | KEEP | REC | First-load closer stretches an old turn and strands a message or activity in one history block. |
| `large-thread history loses no row after a first-load closer` | KEEP | REC | A large log crossing several 400-activity blocks loses or duplicates rows after the old call closes. |
| `a rewind to r-1: once evicted, r-1's late completion and capture are on a page, no row of r-2` | KEEP | REC | Evicted late completion/checkpoint is lost or reverted turn rows reappear. |
| `a rewind to r-1: once evicted, a first-load closer on r-1 is on a page` | KEEP | REC | Evicted first-load closer is omitted from older history after rewind. |
| `several rewinds: each kept turn's late rows are on a page once evicted, a removed turn's never` | KEEP | REC | Repeated rewinds lose retained late rows or restore removed ones. |
| `a kept turn's late rows count toward a page's activities: no page folds more than a lossless one` | KEEP | REC | Late gap activities overflow bounded pages or displace normal rows. |
| `a cut with more late rows than a page holds is served without them, as before, and says so` | KEEP | REC | Oversized gap silently displaces ordinary history or exceeds response bound. |
| `a page lists a late row's turn only when it lists no later one: a rewind of it reaches the page either way` | KEEP | REC | Page metadata fails to identify a turn whose removal invalidates that page. |
| `late rows written after the rewind retain their turn on bounded history pages` | KEEP | REC | A late row written after rewind loses its turn identity on public history pages, so a later rewind cannot invalidate it. |
| `after a rewind that left the parent below its limit, every evicted row is reachable (setup A)` | KEEP | REC | Rewind shrinking parent below retention threshold makes evicted rows unreachable. |
| `after a rewind whose only full window lies in its cut, every evicted row is reachable (setup B)` | KEEP | REC | Only full retained class lies in cut, making old rows unreachable. |
| `after a rewind with no full window left, an old launch row does not strand r-1's evicted rows` | KEEP | REC | Old pinned launch with no full retained class strands evicted history. |
| `an agent's turnless rows reach a page once evicted: in the cut, and before the next prompt` | KEEP | REC | Turnless agent rows vanish after rewind, dropped words return, or legacy checkpoints duplicate. |
| `a turn-less prompt the fold's fallback restores out of a rewind's cut is on a page` | KEEP | REC | Fallback-restored turnless prompt is missing from history pages. |
| `a turn-less prompt a rewind drops is on no page, even inside a kept turn's range` | KEEP | REC | Discarded turnless prompt resurrects inside a retained turn range. |
| `a turn-less prompt one rewind restores and a later one drops: on a page between them, then on none` | KEEP | REC | Prompt restored once survives a subsequent rewind that drops it. |
| `a page whose fold would evict a message beside its gap messages is served without its gap rows, and says so` | KEEP | REC | Gap-message overflow silently loses ordinary answers instead of warning and omitting gap. |

### `apps/daemon/src/agent-host/orchestration/resume-history.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `says so in the timeline when the adapter cannot replay history` | KEEP | HIST | A provider without history projection silently presents an empty resumed thread. |
| `does not replay history into a thread that already has one` | REWRITE | HIST | Keep the no-duplicate-history contract at the Ingestion service seam. Require the authored historical turn and user text on the first start, then no second projected set after the provider session restarts; the old count-only check could pass if no history was ever projected. |
| `refuses the resume and names the tab that owns it` | KEEP | HIST | Two non-forkable tabs take ownership of the same provider conversation. |
| `allows it once the owning session is gone` | KEEP | HIST | A closed owner's stale record permanently prevents resuming its conversation. |
| `forks instead of refusing where the adapter declares it` | KEEP | HIST | A fork-capable provider is incorrectly refused when another tab owns the original. |

### `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts`

| Exact original declaration | Disposition | Source/seam | Concrete failure, retained oracle or stronger owner |
| --- | --- | --- | --- |
| `does not arm until the protocol produces observable progress` | KEEP | WATCH | A timer kills a turn before any provider progress established that it started. |
| `cancels a turn that goes silent for the idle window` | KEEP | WATCH | A silent active turn never receives a stall cancellation. |
| `widens to the tool window while a tool call is open` | KEEP | WATCH | A long-running tool is cancelled at the shorter idle deadline. |
| `is paused entirely while an approval is open` | KEEP | WATCH | A user approval is cancelled while awaiting a human, or timing never resumes. |
| `never stalls a turn while the thread holds a card waiting on the user — even one an earlier turn raised` | KEEP | WATCH | A card from an earlier turn fails to pause the current turn's stall timer. |
| `stops on turn completion` | KEEP | WATCH | A completed turn is cancelled later by a leftover timer. |
| `a card the user holds under an active goal: looked at again a normal window later, and the goal's window names the stall` | KEEP | WATCH | A goal-associated card uses the wrong eventual stall window after its normal check. |
| `while a goal is active a silent turn is not cancelled at the idle window` | KEEP | WATCH | An active goal is cancelled at the ordinary idle deadline. |
| `a goal that turns active after the timer was armed is honoured when it fires` | KEEP | WATCH | A goal activated after arming is ignored by expiry. |
| `a goal that ends while the timer is armed cancels at the normal window, not the hour` | KEEP | WATCH | A goal ended after arming leaves the turn waiting the full goal hour. |
| `is still paused entirely while an approval is open` | DELETE | WATCH | Duplicates is paused entirely while an approval is open in the same suite; the earlier test also resolves the card and proves the deadline restarts. Goal activity only widens a running deadline and cannot alter the already open request pause. |

## Incoming remote addendum — five `/task/stop` cases

Pre-integration source: commit `9871b50f` in `/tmp/orquester-test-audit/incoming`. Independent requirements: `packages/api/src/agent-chat/wire.ts` TaskStopCommandBody and activity-kind comments; `packages/api/src/agent-chat/roster.ts` taskStopRefusal contract; and `docs/orquester-mcp.md` `stop_task` public behavior. B1 is those explicit API and MCP rules for each row. B2 is the distinct failure in the table. B3 is the authored workflow/member task IDs, literal `COMMAND_REJECTED`/`INVALID_COMMAND`, activity kinds, tone, upstream error detail and target ID, none computed from the host. B4 is the public orchestrator command, documented adapter `stopTask` operation, and durable activity log. B5 requires only those observable outcomes, so helper names, call inventories and editorial words may change. B6: the host is the lowest seam proving it routes and gates `/task/stop`, validates the public command body, and turns an adapter failure into a durable error; `roster.test.ts` owns accepted task types and the detailed member/unknown/settled decision matrix, while existing command-receipt tests own generic retry idempotency. Risk: low; the retained host integration and lower policy owner cover each contract.

| Exact incoming declaration | Disposition | Concrete failure / edit |
| --- | --- | --- |
| `hands a live workflow run's id to the adapter and records the request` | REWRITE | A workflow Stop sends the wrong task ID or loses the `task-stop.requested` row with `targetTaskId`. Keep those outcomes; remove exact editorial summary, private row-ID shape and generic repeated-commandId replay already owned elsewhere. |
| `stops a background shell the same way` | DELETE | The host has no shell-specific dispatch branch. The retained workflow stop proves host routing; API `taskStopRefusal: a live workflow run, subagent or shell can be stopped` owns shell eligibility. No independent host failure remains. |
| `refuses a workflow member, an unknown task and a settled one — and never reaches the adapter` → `refuses a workflow member or malformed stop before contacting the provider` | REWRITE | A workflow member is accidentally stopped alone even though the provider can stop only the run, or a missing required task ID is accepted by the public command. Keep one typed member refusal and missing-body `INVALID_COMMAND` with no adapter effect; the roster helper suite owns unknown and settled inputs. |
| `is refused where the provider cannot stop a single task` | REWRITE | A provider without the declared capability receives an unsupported stop. Keep `COMMAND_REJECTED` and no adapter dispatch; remove the incidental error sentence. |
| `a provider that fails the stop lands a failure row` | KEEP | A failed provider stop silently disappears, loses the upstream error, or its durable failure row cannot be tied to the targeted task. Keep failure kind/tone and injected upstream detail; add the wire-required `targetTaskId` assertion. The UI store begins with an already-created row and cannot cover this host effect. |

The original cleanup removed four redundant declarations and the now-unused `relaunch` fixture helper. It rewrote the page-boundary test to assert whole, lossless delivery without a private page shape, and the resume-history test to prove an authored historical message was ingested exactly once across a session restart. No production export or seam became unused: `leftoverWorkClosings`, `legacyLaunchStarts`, and the watchdog still have non-test callers listed above. Scoped final diff was reviewed and passes `git diff --check`.

The incoming five-case disposition is **1 DELETE, 3 REWRITE, 1 KEEP**. The corresponding source edit is prepared as `/tmp/orquester-test-audit/scope11-incoming.patch` and passes `git apply --check` against the isolated incoming checkout. That checkout lacks the `@orquester/api` workspace link, so its attempted focused run failed during module resolution before executing a test. Run the focused host suite after integration into the linked main checkout.
