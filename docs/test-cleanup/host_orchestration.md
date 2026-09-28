# Completed cleanup record: host orchestration (owned subset)

Pre-edit dispositions recorded before mutations. Original 19-file scope split: reconcile, orchestrator, goals and goal-hold are independently reported in host-reconcile.md, host-orchestrator.md and host-goals.md. This record owns the other 15 files.

Baseline: all 204 expanded cases in these 15 files passed. The first attempt hit a concurrent Grok export edit; the retry log `/tmp/orquester-test-cleanup/host-owned-before-retry.log` establishes the green baseline.

Independent sources: [agent chat design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [goals design](../superpowers/specs/2026-09-24-agent-goals-design.md), [durable log / lazy boot design](../superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md), and the named historical failure modes described in each case's fixture setup. Section numbers below refer to these documents, not inferred implementation output.

For each file, the six numbered retention criteria below apply to each listed KEEP/REWRITE, whose concrete expected behavior/failure is its case and reason. DELETE lists stronger coverage. Risk is low test-only refactor unless explicitly noted; validation is the 15-file focused node command below. No runtime behavior change is authorized to satisfy tests.

## `apps/daemon/src/agent-host/orchestration/fix-wave.test.ts`

Owner, independent source, failure modes and non-test callers: Named Q1/R/S/E incidents document concrete failures at public orchestrator commands/subscriptions/reads or stable AgentAdapter process protocol. Host read/command clients are production callers; distinct lazy-load, failed-send, real file dispatch, pending-turn/revert races are not replayed by owner policy tests.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | a subscription taken while the thread is cold still receives events | Detects the distinct failure stated by this case: a subscription taken while the thread is cold still receives events. |
| KEEP | persists error, so /session/stop and /revert can still recover the thread | Detects the distinct failure stated by this case: persists error, so /session/stop and /revert can still recover the thread. |
| REWRITE | detaches subscribers and tells ingestion to forget the thread | Retain terminal thread.deleted event visible to open stream; remove fake forgottenThreads call-shape assertion. |
| REWRITE | the resumed turn has a liveness bound like any other | Advance fake time to actual10minute deadline after observable progress and assert persisted turn failure/cancellation instead of timers.pending. |
| REWRITE | the snapshot caps a huge tool payload and stamps truncated | Use independent32KiB fixture and observable truncated wire/full item data, not imported slimmer bound. |
| KEEP | a seed leaves the provider free to retitle; a user rename does not | Detects the distinct failure stated by this case: a seed leaves the provider free to retitle; a user rename does not. |
| DELETE | captureBaseline runs ahead of startSession and sendTurn | Does not assert ordering at all: array entry/length and unrelated first provider call can pass when capture happens late. Checkpoint owner real capture/revert tests retain artifact behavior. |
| KEEP | the reconcile settles a turn start whose effect never ran | Detects the distinct failure stated by this case: the reconcile settles a turn start whose effect never ran. |
| KEEP | clears once the user sends the implementation turn | Detects the distinct failure stated by this case: clears once the user sends the implementation turn. |
| DELETE | routes the message onto the cached snapshot so the toast can fire | Overwrites registry behavior with spy and checks exact collaborator argument; provider-snapshots status transition protects real consumer contract. |
| REWRITE | refuses a 'small image' that is really a large file | Keep actual11MiB file rejection despite forged1KB client metadata on direct/queued/answer paths; inspect stable provider.turn.start.failed activity kind, not summary prose. |
| REWRITE | a turn queued behind a compaction | Keep actual11MiB file rejection despite forged1KB client metadata on direct/queued/answer paths; inspect stable provider.turn.start.failed activity kind, not summary prose. |
| REWRITE | a message-mode answer's steer | Keep actual11MiB file rejection despite forged1KB client metadata on direct/queued/answer paths; inspect stable provider.turn.start.failed activity kind, not summary prose. |
| KEEP | keeps each array independently, including on a machine-level probe | Detects the distinct failure stated by this case: keeps each array independently, including on a machine-level probe. |
| KEEP | a `ready` session state while a turn start is in flight does not complete it | Detects the distinct failure stated by this case: a `ready` session state while a turn start is in flight does not complete it. |
| KEEP | drops a turn-diff whose turn count is above the revert target | Detects the distinct failure stated by this case: drops a turn-diff whose turn count is above the revert target. |

## `apps/daemon/src/agent-host/orchestration/goal-legacy-handover.test.ts`

Owner, independent source, failure modes and non-test callers: Public resumeGoalSessionsAfterHandover plus daemon supervisor legacyGoalTurnOf/readThread compatibility implement goals§5.7 old-host migration. Gate, unsafe IDs, stopped host and old turn-loop timing are distinct migration regressions.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | resumes each session without a turn, after the gate, and clears the mark | Detects the distinct failure stated by this case: resumes each session without a turn, after the gate, and clears the mark. |
| KEEP | takes only threads it knows: an unknown id, an unsafe one or a repeat is skipped | Detects the distinct failure stated by this case: takes only threads it knows: an unknown id, an unsafe one or a repeat is skipped. |
| KEEP | takes nothing once the host has begun to stop | Detects the distinct failure stated by this case: takes nothing once the host has begun to stop. |
| REWRITE | a Codex goal loop reads as one off `readThread`'s own answer; a turn started later does not | Detects the distinct failure stated by this case: a Codex goal loop reads as one off `readThread`'s own answer; a turn started later does not. |

## `apps/daemon/src/agent-host/orchestration/identity.test.ts`

Owner, independent source, failure modes and non-test callers: Orchestrator identity command and shared identity-switch policy enforce spec§3.4 provider account isolation, idempotence, deferred restart and refusal while work is live. Daemon host routes call command; stable adapter startSession is external process boundary.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | records the new identity, rewrites launch.json and starts NOTHING | Detects the distinct failure stated by this case: records the new identity, rewrites launch.json and starts NOTHING. |
| KEEP | the NEXT turn restarts the provider under the new home, carrying the cursor | Detects the distinct failure stated by this case: the NEXT turn restarts the provider under the new home, carrying the cursor. |
| KEEP | a thread with no live session simply starts under the new identity | Detects the distinct failure stated by this case: a thread with no live session simply starts under the new identity. |
| KEEP | an unchanged identity is a no-op receipt: no event, no activity | Detects the distinct failure stated by this case: an unchanged identity is a no-op receipt: no event, no activity. |
| KEEP | replays the same receipt for a retried commandId rather than switching twice | Detects the distinct failure stated by this case: replays the same receipt for a retried commandId rather than switching twice. |
| KEEP | refuses while a turn is running, and the thread keeps its account | Detects the distinct failure stated by this case: refuses while a turn is running, and the thread keeps its account. |
| KEEP | refuses while a request is parked | Detects the distinct failure stated by this case: refuses while a request is parked. |
| KEEP | a thread whose session is in ERROR may still switch — that is the escape hatch | Detects the distinct failure stated by this case: a thread whose session is in ERROR may still switch — that is the escape hatch. |
| KEEP | refuses an OpenCode thread outright — its server owns the identity | Detects the distinct failure stated by this case: refuses an OpenCode thread outright — its server owns the identity. |
| KEEP | refuses to cross the cliproxy boundary in either direction | Detects the distinct failure stated by this case: refuses to cross the cliproxy boundary in either direction. |
| KEEP | passes only when nothing is in flight | Detects the distinct failure stated by this case: passes only when nothing is in flight. |
| KEEP | refuses every in-flight shape | Detects the distinct failure stated by this case: refuses every in-flight shape. |
| DELETE | names the compaction first — it is the phase the user can act on | Exact English refusal copy and priority change detectors. Keep in-flight policy matrix and host identity rejection; goals.test.ts/goal-hold.test.ts retain continuing/held-goal rejection. |
| DELETE | refuses a continuing goal in the words the composer mirror shows (goals §5.5) | Exact English refusal copy and priority change detectors. Keep in-flight policy matrix and host identity rejection; goals.test.ts/goal-hold.test.ts retain continuing/held-goal rejection. |
| DELETE | names a goal held for an Orquester update in words of its own, in the continuing goal's slot (goals §5.7) | Exact English refusal copy and priority change detectors. Keep in-flight policy matrix and host identity rejection; goals.test.ts/goal-hold.test.ts retain continuing/held-goal rejection. |

## `apps/daemon/src/agent-host/orchestration/item-reads.test.ts`

Owner, independent source, failure modes and non-test callers: Orchestrator readItem/readThread/readToolOutputWindow are the API/MCP read owner over durable real store; spec§6.3 requires full drill-in, bounded snapshot and offset/complete output semantics.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| REWRITE | answers a message its resident fold holds from the fold — equal to the store's whole-log fold — never asking the store | Keep resident/dropped message content, whole launch prompt and output pagination/completion through orchestrator public reads on real store. Remove callback/monkeypatch read-count instrumentation and comparing one production reader to another. |
| DELETE | reads a message retention dropped from the fold, and any activity, through the store | Its independent rewrite exposed a real storage bug; fixed and retained below in store/tool-output.test.ts multipart eviction and rewind survival/exclusion cases. Remove this weaker duplicate once the lower-owner assertions pass. |
| REWRITE | an agent's launch prompt: the snapshot carries it slimmed and flagged, the item read serves it as stored | Keep resident/dropped message content, whole launch prompt and output pagination/completion through orchestrator public reads on real store. Remove callback/monkeypatch read-count instrumentation and comparing one production reader to another. |
| REWRITE | serves a tool call's output windows from the real store's cache: after the first page, only the log's tail is read | Keep resident/dropped message content, whole launch prompt and output pagination/completion through orchestrator public reads on real store. Remove callback/monkeypatch read-count instrumentation and comparing one production reader to another. |

## `apps/daemon/src/agent-host/orchestration/launch-config.test.ts`

Owner, independent source, failure modes and non-test callers: LaunchConfigStore save/load and tolerant persisted config parser; AGENTS credentials daemon-only and backward-tolerant storage. Failures include lost credentials/home, world-readable0600 file or corrupt config preventing launch.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | keeps only well-formed fields and drops the empty ones | Detects the distinct failure stated by this case: keeps only well-formed fields and drops the empty ones. |
| DELETE | picks the four launch fields off a create request | Private extraction wrapper shape; file roundtrip and identity switch/restart cover the real persisted fields and launch behavior. |
| REWRITE | round-trips through a 0600 file and survives a reread | Retain sensitive launch-file mode0600 and cold reread of literal config; drop redundant raw JSON token grep. |
| KEEP | degrades to no launcher env on an unreadable file rather than failing the thread | Detects the distinct failure stated by this case: degrades to no launcher env on an unreadable file rather than failing the thread. |
| DELETE | strips the proxy token WITHOUT the allowance — the bug this guards | Duplicate support/env.test.ts public buildProviderEnv credential exclusion/allowCredentialVars security contracts; these belong to env owner. |
| DELETE | keeps it when the launcher IS the identity, and nothing else | Duplicate support/env.test.ts public buildProviderEnv credential exclusion/allowCredentialVars security contracts; these belong to env owner. |

## `apps/daemon/src/agent-host/orchestration/leftover-work.test.ts`

Owner, independent source, failure modes and non-test callers: leftoverWorkClosings/legacyLaunchStarts are pure persisted-domain-event migration owners called by orchestrator first-load/reconcile. AGENTS says no running state outlives process, retain history/rewind ownership and backward persisted records. Distinct fixture rows reproduce crash/legacy provider schemas; closings are durable protocol records, not private function calls.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| REWRITE | closes every open call `failed`, with its latest lifecycle row's item type, title, turn, owner and data | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| REWRITE | keeps a crash-closed Claude call's command, unmarked: no Load full output, no outputItemId | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| KEEP | never passes a cut output for whole: it takes the opening row's whole data instead, unmarked | Detects the distinct failure stated by this case: never passes a cut output for whole: it takes the opening row's whole data instead, unmarked. |
| KEEP | keeps a cut output marked when no row holds whole data: the cut copy, with its truncated | Detects the distinct failure stated by this case: keeps a cut output marked when no row holds whole data: the cut copy, with its truncated. |
| KEEP | carries whole data as it is — the latest row's, else the opening row's — unmarked | Detects the distinct failure stated by this case: carries whole data as it is — the latest row's, else the opening row's — unmarked. |
| REWRITE | keeps a crash-closed file change's files: its latest lifecycle row's changedFiles ride the closer | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| REWRITE | names a crash-closed file change's files when only its closer can: its opening row gone from the window | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| KEEP | leaves alone an open call no row of the window anchors — what a rewind left of an adopted call — and closes one a row anchors | Detects the distinct failure stated by this case: leaves alone an open call no row of the window anchors — what a rewind left of an adopted call — and closes one a row anchors. |
| REWRITE | stops every task the roster shows active — any agent kind — and leaves an idle or a settled one alone | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| REWRITE | closes a background shell's item before its task, as the adapters do | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| KEEP | stamps a task's closer with its start row's turn, so a rewind keeps or removes the two together | Detects the distinct failure stated by this case: stamps a task's closer with its start row's turn, so a rewind keeps or removes the two together. |
| KEEP | stamps a task whose start the window lost with its latest row's turn | Detects the distinct failure stated by this case: stamps a task whose start the window lost with its latest row's turn. |
| KEEP | puts every closer in exactly the class the fold gives its opener, whatever the owner's spelling | Detects the distinct failure stated by this case: puts every closer in exactly the class the fold gives its opener, whatever the owner's spelling. |
| KEEP | leaves every message still streaming to its readers: no closing names one | Detects the distinct failure stated by this case: leaves every message still streaming to its readers: no closing names one. |
| REWRITE | cancels every parked request but a message-mode question, first, as the host's own settle does | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| KEEP | cancels on the turn the caller names when it settled the turn first — the one the head said was running | Detects the distinct failure stated by this case: cancels on the turn the caller names when it settled the turn first — the one the head said was running. |
| KEEP | skips what a caller already closed, and finds nothing in a thread with nothing open | Detects the distinct failure stated by this case: skips what a caller already closed, and finds nothing in a thread with nothing open. |
| REWRITE | gives a settled legacy OpenCode agent one start that names a launch id, on its first start's turn and owner | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| KEEP | changes nothing the roster shows, and lets a later relaunch reopen the agent | Detects the distinct failure stated by this case: changes nothing the roster shows, and lets a later relaunch reopen the agent. |
| KEEP | gives a settled legacy Codex agent one too — a stopped one as much as a completed one | Detects the distinct failure stated by this case: gives a settled legacy Codex agent one too — a stopped one as much as a completed one. |
| KEEP | gives none to an agent that needs none: launched with an id, idle, still active, a background task, or no start in the window | Detects the distinct failure stated by this case: gives none to an agent that needs none: launched with an id, idle, still active, a background task, or no start in the window. |
| KEEP | gives none on a Claude thread, whose agents always launched with an id | Detects the distinct failure stated by this case: gives none on a Claude thread, whose agents always launched with an id. |
| KEEP | names a settled Grok agent the goals build started with none — a `subagent_spawned` no spawn call explained | Detects the distinct failure stated by this case: names a settled Grok agent the goals build started with none — a `subagent_spawned` no spawn call explained. |
| REWRITE | keeps the rows a capped roster lists: stamped with the roster's own `updatedAt`, never the load's time | Keep durable activity identities/state/data/order/rewind compatibility; remove summary/detail copy, constant-against-itself helper probe, redundant MCP/projection replays and replace roster cap with independent100. |
| KEEP | gives each agent one, once: a second pass finds nothing | Detects the distinct failure stated by this case: gives each agent one, once: a second pass finds nothing. |

## `apps/daemon/src/agent-host/orchestration/liveness.test.ts`

Owner, independent source, failure modes and non-test callers: createLivenessRegistry consumes normalized runtime event protocol and supplies summary/MCP liveness. Spec§3.1/§6.4 requires live agent vs monitor distinction, expiry and user/wake turn-boundary behavior.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| DELETE | is null for an untouched thread | Duplicate null/agent work states already exercised by terminal transitions, wake boundary and Codex/OpenCode self-stamped subagent lifecycle; provider label changes no input protocol shape. |
| DELETE | any live agent work reads as working | Duplicate null/agent work states already exercised by terminal transitions, wake boundary and Codex/OpenCode self-stamped subagent lifecycle; provider label changes no input protocol shape. |
| KEEP | watch loops alone read as monitoring | Detects the distinct failure stated by this case: watch loops alone read as monitoring. |
| KEEP | idle and every terminal status drop out | Detects the distinct failure stated by this case: idle and every terminal status drop out. |
| KEEP | a status-free progress row never resurrects a finished task | Detects the distinct failure stated by this case: a status-free progress row never resurrects a finished task. |
| KEEP | plan-mode bookkeeping is inert | Detects the distinct failure stated by this case: plan-mode bookkeeping is inert. |
| KEEP | a subagent's own shell is covered by its owner, a nested agent is not | Detects the distinct failure stated by this case: a subagent's own shell is covered by its owner, a nested agent is not. |
| KEEP | session.exited clears the thread | Detects the distinct failure stated by this case: session.exited clears the thread. |
| KEEP | classification is per transition, not sticky | Detects the distinct failure stated by this case: classification is per transition, not sticky. |
| REWRITE | drops a watch loop that has been silent for the TTL | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |
| REWRITE | a transition refreshes the window | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |
| REWRITE | never expires an agent — a subagent that runs for hours is real work | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |
| KEEP | a turn ending drops a watch loop that reported nothing during it | Detects the distinct failure stated by this case: a turn ending drops a watch loop that reported nothing during it. |
| KEEP | …but keeps one that did report during the turn | Detects the distinct failure stated by this case: …but keeps one that did report during the turn. |
| KEEP | an aborted turn sweeps the same way | Detects the distinct failure stated by this case: an aborted turn sweeps the same way. |
| KEEP | a turn end with no turn start recorded leaves the registry alone | Detects the distinct failure stated by this case: a turn end with no turn start recorded leaves the registry alone. |
| KEEP | an agent survives the turn-boundary sweep | Detects the distinct failure stated by this case: an agent survives the turn-boundary sweep. |
| REWRITE | a silent shell survives a wake's end, and still expires at its TTL | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |
| KEEP | a turn the host sent still sweeps — after a wake as before one | Detects the distinct failure stated by this case: a turn the host sent still sweeps — after a wake as before one. |
| DELETE | a thread left with nothing live keeps no state behind a wake | Duplicate null/agent work states already exercised by terminal transitions, wake boundary and Codex/OpenCode self-stamped subagent lifecycle; provider label changes no input protocol shape. |
| REWRITE | a Grok background shell is live monitoring work, bounded by the TTL | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |
| KEEP | …and leaves on its own terminal row | Detects the distinct failure stated by this case: …and leaves on its own terminal row. |
| KEEP | Claude's shapes are unchanged: an agent's shell is its owner's, the parent's monitors | Detects the distinct failure stated by this case: Claude's shapes are unchanged: an agent's shell is its owner's, the parent's monitors. |
| KEEP | Codex's and OpenCode's shapes are unchanged: a self-stamped agent works, rests, stops | Detects the distinct failure stated by this case: Codex's and OpenCode's shapes are unchanged: a self-stamped agent works, rests, stops. |
| DELETE | a Grok subagent — stamped with itself, typed subagent — is working until its end | Duplicate null/agent work states already exercised by terminal transitions, wake boundary and Codex/OpenCode self-stamped subagent lifecycle; provider label changes no input protocol shape. |
| REWRITE | reads working for the TTL after its start, then drops out | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |
| KEEP | a running poll re-arms the hour; a status-free row after expiry does not revive it | Detects the distinct failure stated by this case: a running poll re-arms the hour; a status-free row after expiry does not revive it. |
| KEEP | its end drops it, and an end after expiry changes nothing | Detects the distinct failure stated by this case: its end drops it, and an end after expiry changes nothing. |
| REWRITE | an agent without a TTL still never expires, beside one that does | Keep externally visible monitoring/working expiry behavior; use independent10minute background TTL rather than imported production value. |

## `apps/daemon/src/agent-host/orchestration/provider-snapshots.test.ts`

Owner, independent source, failure modes and non-test callers: ProviderSnapshotRegistry public get/all/load/refresh/watch/event methods own persisted cache and probe coordination. Spec§3.2/§6.3/goals§5.4 requires correlated identity, fresh model lists, error state and current capability overlays; daemon provider routes consume outputs.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | caches, notifies on change and short-circuits an identical configuration | Detects the distinct failure stated by this case: caches, notifies on change and short-circuits an identical configuration. |
| KEEP | a probe that finishes after stop() persists nothing and never recreates the state directory | Detects the distinct failure stated by this case: a probe that finishes after stop() persists nothing and never recreates the state directory. |
| KEEP | serialises refreshes so two clients opening Settings run one probe at a time | Detects the distinct failure stated by this case: serialises refreshes so two clients opening Settings run one probe at a time. |
| REWRITE | only runs the background loop while something is watching | Detects the distinct failure stated by this case: only runs the background loop while something is watching. |
| DELETE | a watcher on an empty registry probes immediately, before the first interval | First watcher immediate probe already covered by background-loop lifecycle case; no stronger distinct externally required second-watcher behavior than idempotent watcher/boot cases. |
| KEEP | a watcher on a registry warmed from the cache does not re-probe at once | Detects the distinct failure stated by this case: a watcher on a registry warmed from the cache does not re-probe at once. |
| KEEP | never re-probes a cwd it already holds and collapses concurrent ones | Detects the distinct failure stated by this case: never re-probes a cwd it already holds and collapses concurrent ones. |
| KEEP | merges a sparse rate-limit update onto the cached snapshot by window id | Detects the distinct failure stated by this case: merges a sparse rate-limit update onto the cached snapshot by window id. |
| KEEP | persists the cache keyed by the agent id it was written for, and ignores a mismatch | Detects the distinct failure stated by this case: persists the cache keyed by the agent id it was written for, and ignores a mismatch. |
| KEEP | ignores an unreadable cache rather than failing startup | Detects the distinct failure stated by this case: ignores an unreadable cache rather than failing startup. |
| REWRITE | stores `error`, not `degraded`, so the client actually raises it | Keep literal provider status/auth states and provider-supplied error data. Remove local copied clientWouldToast implementation and seed presentation-copy assertion. |
| REWRITE | clears back to ready on a clean auth.status | Keep literal provider status/auth states and provider-supplied error data. Remove local copied clientWouldToast implementation and seed presentation-copy assertion. |
| REWRITE | layer 1: seeds a pending snapshot at construction, before load() and before any probe | Keep literal provider status/auth states and provider-supplied error data. Remove local copied clientWouldToast implementation and seed presentation-copy assertion. |
| DELETE | layer 1: a pending snapshot never raises the client's auth toast | Calls test-local reimplementation of UI toast logic with arranged pending values; seed status already covered and UI owns toast. |
| KEEP | layer 1: a pending seed is never written to the cache file | Detects the distinct failure stated by this case: layer 1: a pending seed is never written to the cache file. |
| KEEP | layer 2: a correlated cached snapshot overrides the pending seed | Detects the distinct failure stated by this case: layer 2: a correlated cached snapshot overrides the pending seed. |
| KEEP | layer 2: an uncorrelated cached snapshot is discarded and the pending seed stands | Detects the distinct failure stated by this case: layer 2: an uncorrelated cached snapshot is discarded and the pending seed stands. |
| KEEP | layer 2: a v1 identity-less payload is discarded | Detects the distinct failure stated by this case: layer 2: a v1 identity-less payload is discarded. |
| KEEP | layer 2: a payload from another protocol version is discarded | Detects the distinct failure stated by this case: layer 2: a payload from another protocol version is discarded. |
| KEEP | layer 3: startBootRefresh probes every provider, returns synchronously, and is idempotent | Detects the distinct failure stated by this case: layer 3: startBootRefresh probes every provider, returns synchronously, and is idempotent. |
| KEEP | layer 3: a correlated cache makes boot refresh a no-op | Detects the distinct failure stated by this case: layer 3: a correlated cache makes boot refresh a no-op. |
| DELETE | layer 3: the boot probe's result is written to the cache WITH its identity | Explicit refreshAllNow makes assertions pass even if preceding boot/watcher action does nothing. Existing boot idempotence/empty watcher cases plus cache roundtrip own real contracts. |
| KEEP | the first watcher's priming is a no-op once the boot probe has run | Detects the distinct failure stated by this case: the first watcher's priming is a no-op once the boot probe has run. |
| DELETE | the first watcher still primes a registry nobody kicked at boot | Explicit refreshAllNow makes assertions pass even if preceding boot/watcher action does nothing. Existing boot idempotence/empty watcher cases plus cache roundtrip own real contracts. |
| REWRITE | a read schedules exactly ONE background refresh, and the rate limit holds the next off | Keep real symlink install change/stale-while-refresh version data and one-probe idempotence, use literal5000ms rate limit. |
| KEEP | the refreshed snapshot is cached under the NEW bin identity | Detects the distinct failure stated by this case: the refreshed snapshot is cached under the NEW bin identity. |
| KEEP | the disk cache refuses to hydrate a row whose bin identity moved | Detects the distinct failure stated by this case: the disk cache refuses to hydrate a row whose bin identity moved. |
| KEEP | a correlated cached row from before `goals` existed is served with today's capabilities | Detects the distinct failure stated by this case: a correlated cached row from before `goals` existed is served with today's capabilities. |
| DELETE | the pending seed and a live probe's own row serve the adapter's capabilities too | Arranged mock capabilities echoed unchanged; cold-cache capability overlay and newer probe overriding old cache are stronger differentiated cases. |
| KEEP | the freshest live statement wins: a probe's capabilities replace the seed's | Detects the distinct failure stated by this case: the freshest live statement wins: a probe's capabilities replace the seed's. |
| DELETE | the cache file itself is rewritten with the current capabilities | Arranged mock capabilities echoed unchanged; cold-cache capability overlay and newer probe overriding old cache are stronger differentiated cases. |
| DELETE | parameterized pending capability identity: claude, codex, grok | Declaration identity inventory compares pending seed to imported constants and static goal fields. Real cached/live capability transitions remain; remove capability imports. |

## `apps/daemon/src/agent-host/orchestration/resume-history.test.ts`

Owner, independent source, failure modes and non-test callers: Public createThread/command/read state enforces spec§6.1/§4.1 transcript replay and exclusive provider-conversation ownership; credible E5/E6 recorded regressions are explicit independent source.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| DELETE | projects it through ingestion before the session is announced | Fake ingestion event inventory/call order duplicates stronger v1-residual host history eager-load and old-before-new read contracts. |
| REWRITE | says so in the timeline when the adapter cannot replay history | Assert runtime.warning activity and usable subsequent turn; discard exact explanatory summary. |
| KEEP | does not replay history into a thread that already has one | Detects the distinct failure stated by this case: does not replay history into a thread that already has one. |
| REWRITE | refuses the resume and names the tab that owns it | Detects the distinct failure stated by this case: refuses the resume and names the tab that owns it. |
| KEEP | allows it once the owning session is gone | Detects the distinct failure stated by this case: allows it once the owning session is gone. |
| KEEP | forks instead of refusing where the adapter declares it | Detects the distinct failure stated by this case: forks instead of refusing where the adapter declares it. |

## `apps/daemon/src/agent-host/orchestration/session-binding.test.ts`

Owner, independent source, failure modes and non-test callers: Orchestrator public create/command/reconcile/continuation APIs plus persisted ThreadStore binding; AGENTS requires field-wise cursor retention and old persisted compatibility. Lost conversation identity after restart is visible data loss.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | records what the session start and the turn learned | Detects the distinct failure stated by this case: records what the session start and the turn learned. |
| KEEP | a session-set that dropped the cursor still resumes — the binding carries it | Detects the distinct failure stated by this case: a session-set that dropped the cursor still resumes — the binding carries it. |
| DELETE | …and without the binding it would not have — the control | Deletes every available cursor then asserts no cursor: manufactured control duplicates explicit no-cursor-not-marked contract, while migration fallback/resume survive. |
| KEEP | falls back to the head's cursor for a thread written before bindings existed (§8) | Detects the distinct failure stated by this case: falls back to the head's cursor for a thread written before bindings existed (§8). |
| KEEP | a settle that names no cursor never rewrites the binding's | Detects the distinct failure stated by this case: a settle that names no cursor never rewrites the binding's. |
| KEEP | the reconcile resumes from the binding when the head has no cursor at all | Detects the distinct failure stated by this case: the reconcile resumes from the binding when the head has no cursor at all. |
| KEEP | an intentional stop marks a thread whose head lost its cursor but whose binding kept it | Detects the distinct failure stated by this case: an intentional stop marks a thread whose head lost its cursor but whose binding kept it. |
| KEEP | a thread with no cursor anywhere is not marked | Detects the distinct failure stated by this case: a thread with no cursor anywhere is not marked. |
| REWRITE | a create-time resume seeds the binding before any session is started | Assert literal Claude resume cursor shape instead of not-null assertion that also passes undefined. |

## `apps/daemon/src/agent-host/orchestration/session-policy.test.ts`

Owner, independent source, failure modes and non-test callers: decideSessionRestart is the lowest state-transition policy consumed by orchestrator ensureSession. Spec§3.4 requires mode/cwd/account restart and adapter-dependent model/cursor behavior; table expectations are independent booleans/cursor decisions.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| KEEP | is a no-op when nothing changed | Detects the distinct failure stated by this case: is a no-op when nothing changed. |
| KEEP | restarts on runtime mode, cwd and account | Detects the distinct failure stated by this case: restarts on runtime mode, cwd and account. |
| KEEP | applies a model change live where the adapter can switch in session | Detects the distinct failure stated by this case: applies a model change live where the adapter can switch in session. |
| KEEP | restarts and DROPS the cursor when the adapter cannot switch model in session | Detects the distinct failure stated by this case: restarts and DROPS the cursor when the adapter cannot switch model in session. |
| KEEP | Claude compares the whole selection object, options included | Detects the distinct failure stated by this case: Claude compares the whole selection object, options included. |
| KEEP | other adapters ignore an options-only change | Detects the distinct failure stated by this case: other adapters ignore an options-only change. |
| DELETE | modelSelectionEquals is deep and order-sensitive | Private equality helper shape; decideSessionRestart model/options transition table is stable policy owner and remains. |

## `apps/daemon/src/agent-host/orchestration/slash.test.ts`

Owner, independent source, failure modes and non-test callers: parseHostGoalCommand is the shared owner of provider-defined Codex /goal grammar and host security limits; orchestrator consumes its discriminated command, errors and objective data.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| REWRITE | is not a goal command unless the trimmed text is /goal followed by a boundary | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | a bare /goal and `status` both ask for the status, in any case | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | pause, resume and clear match the WHOLE argument, case-insensitively | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | edit takes an objective, and without one is a usage error | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | anything else sets a goal with that objective — trimmed, otherwise verbatim | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | an objective is 1–4000 characters after trimming | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | counts characters the way Codex does — code points, not UTF-16 units | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |
| REWRITE | refuses attachments with every goal command | Retain Codex goal grammar, literal objective data, 4000 code-point bound and attachment rejection. Remove exact error prose and constant-against-itself check. |

## `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts`

Owner, independent source, failure modes and non-test callers: createTurnWatchdog is the timer policy owner consumed by orchestrator; onStalled drives provider cancellation. Spec§3.1/goals§5.2 requires10minute idle/30minute tool/60minute goal bounds and no cancellation while a user request is pending.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| REWRITE | does not arm until the protocol produces observable progress | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | cancels a turn that goes silent for the idle window | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | widens to the tool window while a tool call is open | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | is paused entirely while an approval is open | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | re-checks the pause immediately before cancelling | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | never stalls a turn while the thread holds a card waiting on the user — even one an earlier turn raised | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| DELETE | with no card waiting on the user, a quiet turn stalls on its first window | Duplicate default idle and ended-goal cancellation outcomes. |
| REWRITE | stops on turn completion and on session exit | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | a card the user holds under an active goal: looked at again a normal window later, and the goal's window names the stall | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| DELETE | is an hour — longer than a Grok goal run's silent verifier rounds | Constant declaration inventory; retained silent-goal behavior independently asserts cancellation at60minutes. |
| REWRITE | while a goal is active a silent turn is not cancelled at the idle window | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| DELETE | without an active goal the normal windows apply | Duplicate default idle and ended-goal cancellation outcomes. |
| DELETE | is the LONGER of the goal window and the normal one, never a shortcut | Only exercises test-only deadline override no production caller supplies. Remove override seam; actual10/30/60minute product windows remain. |
| REWRITE | a goal that turns active after the timer was armed is honoured when it fires | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | a goal that ends while the timer is armed cancels at the normal window, not the hour | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | the goal window is re-checked at every normal window, so it holds while the goal does | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |
| REWRITE | is still paused entirely while an approval is open | Assert onStalled public callback timing at literal10/30/60minutes, not timers.pending or exposed private paused/turnId; remove those test-only introspection getters. |

## `apps/daemon/src/agent-host/orchestration/v1-residual.test.ts`

Owner, independent source, failure modes and non-test callers: Named R4/R5/R2/E2 incidents independently require correct adapter project identity, bounded reconnect payload, precommit forbidden-command rejection, eager resumed transcript and chronology. Public orchestrator command/read + stable adapter launch protocol are owner seams.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| REWRITE | hands the project root to the adapter, so the pool keys on it | Retain stable AgentAdapter.startSession projectPath/cwd protocol (wrong root spawns duplicate pool); remove extra call to private OpenCode key helper. |
| KEEP | does not ship the full persisted tool payload on the replay branch | Detects the distinct failure stated by this case: does not ship the full persisted tool payload on the replay branch. |
| KEEP | refuses Grok's /always-approve with 400 and appends nothing | Detects the distinct failure stated by this case: refuses Grok's /always-approve with 400 and appends nothing. |
| KEEP | leaves the same text alone on another provider | Detects the distinct failure stated by this case: leaves the same text alone on another provider. |
| REWRITE | projects history on CREATE, without waiting for a turn | Keep caller-visible eager/history ordering outcomes; consolidate real transcript timestamp preservation and invalid/current fallback into these existing history fixtures so private helper export can go. |
| REWRITE | orders the old conversation ABOVE the new prompt | Keep caller-visible eager/history ordering outcomes; consolidate real transcript timestamp preservation and invalid/current fallback into these existing history fixtures so private helper export can go. |
| DELETE | pushes a `now`-stamped row behind the thread's creation, in order | Internal stampHistoryTimes test-only export. Public eager/history-order host tests exercise current-time, real transcript time and invalid-time fallback after fixture consolidation. |
| DELETE | keeps a real transcript timestamp exactly as the adapter read it | Internal stampHistoryTimes test-only export. Public eager/history-order host tests exercise current-time, real transcript time and invalid-time fallback after fixture consolidation. |
| DELETE | treats an unparseable stamp as missing rather than dropping the row | Internal stampHistoryTimes test-only export. Public eager/history-order host tests exercise current-time, real transcript time and invalid-time fallback after fixture consolidation. |

## `apps/daemon/src/agent-host/orchestration/validate.test.ts`

Owner, independent source, failure modes and non-test callers: Public host command validators, version gate and adapter resume cursor builders enforce spec§4.1 bounds/§6.1 resume security before provider effects. Orchestrator is production caller.

Retention bar: **1** the cited independent protocol/storage/security/spec/incident requirements define the named case; **2** the named wrong status, data, rejection, persistence or side effect is visible to its caller; **3** fixture values and literal expected outcomes do not invoke production logic as their oracle (rewrites remove imported-constant/private-comparator oracles); **4** the owner API or durable event boundary above is stable; **5** assertions constrain its result, not identifiers, containers, helper sequence, copy or layout, and therefore survive behavior-preserving implementation changes; **6** this is the lowest owner for each listed transition/edge, while higher tests retained elsewhere exercise separate transport/restart integration. No stronger retained case covers the exact remaining input-state transition.

| Disposition | Original named case | Failure/coverage decision |
| --- | --- | --- |
| REWRITE | requires a commandId | Keep typed INVALID_COMMAND rejection and valid controls, using independent10MiB image/50MiB file and120000 character/8 attachment caps; remove error-copy matching. |
| REWRITE | trims input and enforces the character cap | Keep typed INVALID_COMMAND rejection and valid controls, using independent10MiB image/50MiB file and120000 character/8 attachment caps; remove error-copy matching. |
| REWRITE | caps the attachment count | Keep typed INVALID_COMMAND rejection and valid controls, using independent10MiB image/50MiB file and120000 character/8 attachment caps; remove error-copy matching. |
| REWRITE | refuses the whole set if any member fails | Keep typed INVALID_COMMAND rejection and valid controls, using independent10MiB image/50MiB file and120000 character/8 attachment caps; remove error-copy matching. |
| REWRITE | lowercases the mime before judging it and accepts only the four image types | Keep typed INVALID_COMMAND rejection and valid controls, using independent10MiB image/50MiB file and120000 character/8 attachment caps; remove error-copy matching. |
| REWRITE | keeps the unknown arm as a forward-compat catch-all, still bounded | Keep typed INVALID_COMMAND rejection and valid controls, using independent10MiB image/50MiB file and120000 character/8 attachment caps; remove error-copy matching. |
| KEEP | strips a client-supplied path: a command's ref is a reference and nothing else (§6.3) | Detects the distinct failure stated by this case: strips a client-supplied path: a command's ref is a reference and nothing else (§6.3). |
| KEEP | targetTurnCount must be a non-negative integer | Detects the distinct failure stated by this case: targetTurnCount must be a non-negative integer. |
| KEEP | recognises exactly /compact with no attachments | Detects the distinct failure stated by this case: recognises exactly /compact with no attachments. |
| KEEP | never rewrites a turn that starts with a slash | Detects the distinct failure stated by this case: never rewrites a turn that starts with a slash. |
| REWRITE | compares dotted versions | Observe required OpenCode version through checkMinimumVersion rather than private dotted-number comparator; retain lower/equal/newer/v-prefixed version acceptance. |
| DELETE | refuses an out-of-range OpenCode with the required version in the message | Covered in rewritten public minimum-version boundary table; exact diagnostic phrasing is not the contract. |
| KEEP | never refuses on an unknown version | Detects the distinct failure stated by this case: never refuses on an unknown version. |
| KEEP | refuses a traversal-shaped or flag-shaped id | Detects the distinct failure stated by this case: refuses a traversal-shaped or flag-shaped id. |
| KEEP | builds the documented cursor shape per adapter | Detects the distinct failure stated by this case: builds the documented cursor shape per adapter. |

## Validation and support removal

`pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test $(cat /tmp/orquester-test-cleanup/host-owned.txt)`

Removed support: copied clientWouldToast; item read spies/onLogRead; duplicated capability imports; watchdog deadline override options/introspection getters; private version compare export; leftover copy/id helper exports; private stampHistoryTimes export (coordinated owner). Native watchdog/orchestrator timer migration is additionally recorded in host-timer-seams.md.

### Resumed cleanup follow-up (recorded before editing)

- REWRITE provider-snapshots `only runs the background loop while something is watching`: assert the specified five-minute demand-gated cadence with native mock timers; custom 1-second interval and timer injection are test-only. The existing caller-observable probe count detects both wasted provider subprocesses without demand and stale settings while watched. No other retained case owns periodic demand. Independent literal five-minute expectation, public registry lifecycle and provider boundary satisfy bars 1–6; removing injection preserves the production default and lowers test-only surface risk.
- Remove provider registry `intervalMs`, `setTimer`, `clearTimer` options; `main.ts` is its sole production constructor and passes none. Remove now-unreferenced exports of its four internal cache/window constants. Keep per-provider `timeoutMs`: real adapters require different start/probe deadlines.
- Remove unused liveness `backgroundTtlMs` override and privatize its default TTL constant after external tests use the independently specified ten-minute bound. Keep the clock: host orchestration and adapters share that runtime clock contract.
- Privatize `MAX_GOAL_OBJECTIVE_CHARS`; its only external mention is documentation. The 4,000-code-point grammar cases retain literal boundary expectations.
- The strengthened item-read assertion fails: both original compared production readers returned null for an evicted message. The store folds the whole log using bounded retention again. This is a product bug, not grounds for deleting the retained regression; the storage owner is fixing it while this scope keeps its independent expected message data.
- Remove empty describe blocks and stale timer/private-cache comments left after deleting their only cases. Risk: formatting/support only. Validate this same 15-file command, followed by daemon typecheck.

- REWRITE resume-history `refuses the resume and names the tab that owns it`: retain `COMMAND_REJECTED`, nested `RESUME_UNAVAILABLE` and literal `ownerThreadId` from the public error payload; discard the English sentence template. The protocol's exclusive-conversation rule and owning-tab identifier are independently observable; this is the lowest orchestrator owner for provider identity collision. Refactoring error wording cannot affect the assertion.
- Remove test-only export `LAUNCH_CONFIG_FILE`; the retained real-storage security test independently checks `threads/t1/launch.json`. Move `createMemoryLaunchConfigStore` into `orchestration/testing/fakes.ts`, and require the production orchestrator's `launchConfigs` dependency (coordinated orchestrator owner). `main.ts` always supplies the durable store; only tests depended on the implicit memory fallback. No runtime behavior changes.
- Privatize `GOAL_CONTINUING_SWITCH_REFUSAL` and `GOAL_HELD_SWITCH_REFUSAL` after the goal owner removed the last constant/copy assertions; `identitySwitchRefusal` still returns identical strings to real callers.

- REWRITE/move `opencode/snapshot-budget.test.ts` case `E9: the registry honours a probe's own ceiling` to `orchestration/provider-snapshots.test.ts`. Its real contract is the registry honoring a provider's declared 45-second cold-probe budget instead of the default auth budget. Existing registry tests do not protect this. Replace private armed-timer inventory and English error matching with native time at 44,999/45,000ms, an unsettled/pending check and typed timeout rejection from public `refresh`. This catches both premature and missing expiry, uses independent configured input, observes stable registry API, survives scheduling refactors, and owns the contract below adapter E2E. Remove now-unused adapter-side registry imports/support. Risk low; provider registry and snapshot-budget focused tests cover the move.
- REWRITE goal-legacy-handover `a Codex goal loop reads as one off readThread's own answer; a turn started later does not`: use a literal four-second gap (outside the documented three-second continuation window), removing the private supervisor constant oracle; preserve public snapshot-to-supervisor compatibility and distinct later-user-command behavior. Supervisor owner already privatized the constant.

- Remove the unused `minimumVersions` / `minimums` override forwarded by the orchestration harness and version gate. No test or production consumer supplies it. The real minimum-version test uses independently specified OpenCode versions; production continues to use the same fixed supported-version table. Privatize that table after the orchestrator owner removes its redundant import/forwarding.

- Final disposition DELETE for item-reads `reads a message retention dropped from the fold, and any activity, through the store`: the independent assertion exposed the storage bug and has now moved to its lowest owner, `store/tool-output.test.ts` (`readItem reconstructs a multipart message whose earlier deltas aged out of the resident window` and `full message reads preserve rewind survival and exclusion after window retention`). Those retain full multiline reconstruction across eviction and keep/drop after rewind, stronger than this simple message-0 integration. Resident read composition, full-prompt wire/drill-in distinction and incremental output pagination remain different orchestrator contracts. Delete the integration duplicate only after those storage assertions pass with the owner fix; do not keep the former production-to-production equality oracle.

### Completed outcome

This is implemented cleanup. All 202 original named definitions have dispositions above: 105 KEEP, 66 REWRITE, 31 DELETE. The three-adapter parameter family expands one DELETE row to three cases. Original focused baseline: 204 passed. Final owned set: 172 cases (including the one registry-ceiling case moved from the adapter file). The 15 owned test files have 562 fewer lines than baseline; the moved adapter case removes additional support there.

Production seams/dead support removed: provider interval/timer injection and four private cache/window exports; liveness TTL override/export; watchdog three deadline overrides and two introspection getters; leftover detail/legacy-ID exports; goal objective and identity-refusal exports; version comparator and unused minimum-version overrides/table export; launch filename export; fake ingestion forget observer; copied toast predicate and whole snapshot/MCP replay helper; the in-production memory launch-config double and implicit fallback (double relocated to test support). Orchestrator owner privatized `stampHistoryTimes`. The timer-seam owner additionally removed the manual timer wheel and production timer hooks; no runtime deadline changed.

The sole product bug uncovered here was an evicted message's full item read returning null: the former test compared two buggy production answers. Storage now reconstructs that read with unbounded retention, and its stronger direct-store multipart and rewind regressions own the contract. This report deletes the higher duplicate only after their successful validation.

Validation:

- Original 15-file baseline: 204/204 passed (`host-owned-before-retry.log`).
- Rewritten 15-file set before relocating the now-duplicate eviction regression: 173/173 passed (`host-owned-verified.log`). Removing only that duplicate leaves 172 cases; repository gates run by the root agent cover the final full set.
- Native registry timeout/cadence, OpenCode snapshot-budget and legacy handover follow-up: 34/34 passed (`host-owned-followup.log`).
- Final version/identity/launch support cleanup: 29/29 passed (`host-owned-last-seams.log`).
- Remaining orchestrator item reads plus the stronger storage output/eviction/rewind owner: 27/27 passed (`host-owned-item-owner.log`).
- Daemon typecheck passed after the first support cleanup (`host-owned-typecheck-final.log`). The final retry found only concurrent out-of-scope stream event typing, workflow storage callback typing, and stale trigger export errors (`host-owned-typecheck-verified.log`); notified their owners/root for final repository gates. No remaining diagnostic points into this scope.
- Scope `git diff --check`: passed. No snapshots or external credentials were created. Temporary real-store/git fixtures are cleaned by test teardown.

Focused command pattern: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/orchestration/{fix-wave,goal-legacy-handover,identity,item-reads,launch-config,leftover-work,liveness,provider-snapshots,resume-history,session-binding,session-policy,slash,turn-watchdog,v1-residual,validate}.test.ts`. Follow-up commands use the same imports with the named file paths above. Logs referenced here reside in `/tmp/orquester-test-cleanup/` for this run; no test result depends on those logs.
