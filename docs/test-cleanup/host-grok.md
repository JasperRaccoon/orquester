# Grok test cleanup audit

Status: completed cleanup. The per-test audit was recorded before source mutations; focused validation and final inspection results are below. Scope: every original test declaration in 20 Grok files (380 declarations; parameterized families are expanded by node:test). No generated bindings are edited.

Read root AGENTS.md/README.md, package scripts, agent-host module README, Grok fixture README, relevant GUI/goals requirements, all scoped tests and their production owners/callers. Existing docs/test-cleanup/adapter_grok.md records a previous cleanup; this report audits the current baseline independently.

Isolated-unit failure modes considered before keeping cases: wrong protocol framing/correlation or option/error mapping; privileged approval without consent; leaked credentials; unsafe config writes; data loss/misattribution in chunk/task/goal history; repeated or missing lifecycle ends; stale live-work state; lost delayed/woken/steered output; incorrect accounting; blocked requests or surviving owned subprocesses. Internal ID spelling, declarations, formatter wording, and fixture contents asserted against themselves do not qualify.

Validation command for each row: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test <listed file>` from repository root. Full focused gate uses `apps/daemon/src/agent-host/adapters/grok/*.test.ts apps/daemon/src/agent-host/adapters/grok/acp/*.test.ts`. Parent owns repository `pnpm check`, `pnpm test` and final diff/commit/push. All runtime tests use isolated temporary homes/children, never the live daemon.

Every KEEP/REWRITE below has this full six-bar justification, specialized by its file source/seam and distinct per-case scenario: **B1** its source is the independent requirement/protocol/capture identified for the file. **B2** violating the concrete input/state/outcome in the row breaks the named provider/client operation, loses data, shows wrong state, leaks a secret, or leaves a request/process alive. **B3** expected values are literal protocol/fixture data or required state transitions, not outputs calculated by production helpers. **B4** assertions observe the listed production-facing seam. **B5** internal names, factoring, data structures and call arrangements can change without changing those outputs; REWRITEs remove the noted remaining coupling. **B6** the case is the lowest owner of that particular mapping, temporal ordering, or cross-interface composition; pure mapping duplicates at subprocess layers are removed as listed. Shared fixture inputs do not by themselves duplicate distinct asserted outcomes. Retained cases have low change risk (unchanged), while rewrites have low risk after focused tests because they preserve the behavior oracle and remove incidental observations. Each DELETE lists its stronger remaining owner and support impact.

## apps/daemon/src/agent-host/adapters/grok/acp/connection.test.ts

Independent source (B1): ACP initialize/authenticate frames and GUI design §4.5 noninteractive authentication. Production seam and non-test callers (B4): AcpConnection.handshake, consumed by session.ts and probe.ts; spawned test peer exercises real stdio.

## apps/daemon/src/agent-host/adapters/grok/acp/errors.test.ts

Independent source (B1): captured ACP codes and CLI authentication/usage-limit errors; typed runtime failure public contract. Production seam and non-test callers (B4): acpFailureReason, consumed by session.ts/probe.ts error handling.

## apps/daemon/src/agent-host/adapters/grok/acp/peer.test.ts

Independent source (B1): JSON-RPC 2.0 request/notification/error protocol, ACP extension aliases, AGENTS.md unmapped-event and secret rules. Production seam and non-test callers (B4): AcpPeer request/notify/handleLine and registered handlers, consumed by AcpConnection and GrokSession.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L55: a request is framed as JSON-RPC 2.0 with an incrementing numeric id | REWRITE | JSON-RPC requires response correlation, not IDs starting at 1 or incrementing. Assert unique emitted IDs and literal method/params, answer the two IDs out of order, then assert their independently chosen results reach the correct promises. Detects crossed concurrent replies while allowing any valid ID allocation. Lowest wire seam; no remaining test covers reversed concurrent responses. |
| L176: the warning summarises the payload rather than copying it | REWRITE | Keep the secret non-disclosure assertion on the warning; delete exact private string(400)/array(3) formatter assertions. Host diagnostic redaction is the independent security rule, and a copied payload exposes a secret. AcpPeer is the production transport warning seam; redact.test.ts owns on-disk trace redaction, a different sink. |

## apps/daemon/src/agent-host/adapters/grok/acp/redact.test.ts

Independent source (B1): AGENTS.md secrets never enter logs; fixture README redaction/provenance requirements. Production seam and non-test callers (B4): redactAcpFrame, invoked by ACP trace logging; assertions cover persisted diagnostic bytes and hostile input bounds.

## apps/daemon/src/agent-host/adapters/grok/fold-seam.test.ts

Independent source (B1): GUI §§4.2/7.6 and documented duplicate-finish, poll-revival, cross-launch loop/run, child-shell ownership regressions. Production seam and non-test callers (B4): GrokNormalizer output through production activity ingestion/folds/liveness; contract is the resulting caller-visible timeline/roster/work state, not isolated event shape.

## apps/daemon/src/agent-host/adapters/grok/goal.test.ts

Independent source (B1): goals design §6.3 and fixture README observations 53/57: status/event mappings, planning, throttling, load reconciliation, reminder grammar. Production seam and non-test callers (B4): GrokNormalizer handleXaiNotification/reconcileGoal/beginTurn and goalCommandFromReminder consumed by session/history; shared RuntimeEvent goal payloads.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L215: an unknown status keeps the tracked status | DELETE | The preceding every-status table tests the same unknown status with a previously active goal and independently expects active; it also covers malformed variants. Same normalizer seam, no stronger contract removed. Low risk. |
| L227: an unknown status with nothing tracked emits nothing rather than guess one | DELETE | The retained dropped-goal_created case tests an invalid initial status then a valid create, asserting both no phantom event and no leaked state. It owns this failure more strongly. Low risk. |
| L1049: anything else is not a goal block | DELETE | The leading-block negative controls already protect rejection of prose, non-leading blocks and unrelated system reminders. The generic negatives add no separate grammar requirement. Low risk. |

## apps/daemon/src/agent-host/adapters/grok/history.test.ts

Independent source (B1): GUI readThread/native-history contract, replay markers, and captured session/load frames. Production seam and non-test callers (B4): GrokHistoryCollector and GrokNormalizer replay projection consumed by GrokSession readThread; output items and ordering are caller-visible.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L361: an unterminated tail is kept under a synthetic id rather than lost | REWRITE | Assert the saved user-message content and a nonempty ID instead of the private grok-history- prefix. The independent history contract is no text loss for an incomplete captured turn; GrokHistoryCollector.snapshotTurns is the production-used storage/projection seam. Other cases only close turns with provider prompt IDs. |

## apps/daemon/src/agent-host/adapters/grok/launch.test.ts

Independent source (B1): GUI design §§3.1, 4.4, 4.5 version/model/effort rules and AGENTS.md GROK_CONFIG_PATH overlay requirement. Production seam and non-test callers (B4): version/config/model helpers consumed by GrokAdapter, GrokSession and probe.ts; actual filesystem for overlay safety.

## apps/daemon/src/agent-host/adapters/grok/lifecycle.test.ts

Independent source (B1): AgentAdapter public contract, GUI §§3.1/4.1/4.3/4.4/4.5, AGENTS.md process/session ownership; fixture README observations 48/55 for detached children. Production seam and non-test callers (B4): GrokAdapter start/send/interrupt/stop/read/list/compact over a protocol-only spawned mock CLI and real owned helper processes.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L606: /always-approve is refused with a pointer at the permission selector | DELETE | Duplicate rejection is owned by the later INVALID_COMMAND/400 case, which checks the stable public error code. Move its valuable lookalike acceptance control to that retained case. Low risk after rewrite. |
| L649: listSessions reflects active sessions | REWRITE | Keep public listSessions thread/runtime-state assertions. Delete assert(adapter.id === grok) declaration equality and its now-unused AgentAdapterId import. The session list is the caller contract; identifier declaration is not independent behavior. |
| L661: attachments reach the agent as PATHS, because promptCapabilities.image is false | REWRITE | Assert the resolved absolute path actually reaches provider input instead of a presentation header. The echo fixture only returns transport input; it does not resolve attachments. The public adapter wiring can lose the path even when the shared formatter passes, so this is its lowest integration seam. |
| L686: a path the text already names is not repeated in the Attached files block | DELETE | The shared adapters/attachment-lines.test.ts directly owns already-named-path suppression, including mixed named/unnamed attachments. Retained Grok attachment case verifies resolving and delivering paths through the adapter. Low risk. |
| L1489: sendTurn refuses /always-approve with INVALID_COMMAND / 400 | REWRITE | Keep the public INVALID_COMMAND/400 error; remove exact explanatory-copy assertion and retain the deleted duplicate test’s lookalike acceptance control. Detects bypass of the permission selector or an overbroad slash-command guard. Stable AgentAdapter sendTurn contract, independent security rule, no equivalent owner. |
| L1666: at the host's teardown a helper that ignores SIGTERM is killed after a 1 s grace, not spawn.ts's 2 s | REWRITE | Baseline broad run failed with artificial 3000 ms fake elapsed; the isolated case passed. Owner sets the independently specified 1000 ms host grace. The harness also advanced ACP stdout-close’s unrelated 2000 ms timer after helper SIGTERM. Restrict its clock driver to timers within the grace window, preserving real process SIGTERM/SIGKILL and gone-on-resolution assertions. B1 GUI §3.1 teardown deadline; B2 helper surviving the backstop; B3 fixed specified 1000 ms; B4 real adapter stopAll and OS signals; B5 no private method/callback-shape assertion; B6 only session test of host-specific grace (support owns generic signaling). |
| L2205: `a prompt the CLI answers with "${message}" (-32603) names ${reason ?? "no account failure"}` | REWRITE | Keep auth, usage_limit and unrelated-failure representatives to verify distinct account outcomes are forwarded to runtime.error. Remove two redundant auth wording variants; acp/errors.test.ts owns the complete lexical/code mapping. Session integration owns forwarding/once-only reporting, not parser vocabulary. |
| L2223: `a prompt the CLI answers with ${code} names ${reason ?? "no account failure"}` | DELETE | acp/errors.test.ts owns each numeric-code mapping; the retained prompt-error integration proves the parser result reaches runtime.error. Replaying all three numeric cases via a subprocess duplicates the parser owner. Remove the now-empty parameter loop. Low risk. |

## apps/daemon/src/agent-host/adapters/grok/normalize.test.ts

Independent source (B1): fixture README task/shell/subagent ownership, Stop, polling, plan, tool and scheduler observations; GUI §§3.1, 4.2, 4.5, 7.6. Production seam and non-test callers (B4): GrokNormalizer public frame handlers and lifecycle methods called by GrokSession; normalized RuntimeEvent payloads.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L590: T3's kill answer ends the agent stopped — only a completed call whose outcome is killed | DELETE | The adjacent captured kill-answer case exercises actual subagent/shell snapshots, successful kill and failed-call refusal; work-replay fixture 27 additionally checks an already-exited target. This simplified synthetic variant duplicates their owner. Low risk. |
| L1182: subagent_spawned joins a resume to its source's task, and a spawn no launch explains starts its own | DELETE | subagent-replay fixture 17 proves resume/source identity with actual provider traffic; work-replay fixture 29 and xai-updates goal-agent cases prove CLI-owned spawns without launch calls. Their fixed data asserts richer results at the same normalizer seam. Low risk. |
| L1356: the session's end closes a live loop; a later fire notes itself, the CLI re-creating it is a new run | REWRITE | Observe that recreation has a different nonempty run ID from the initial start, not the private loop-run:<id>:launch-1:2 byte format. Scheduled-loop contract requires reopening a new run after closure; source identifier renames/allocation changes should survive. Normalizer output owns this transition and no other case covers recreation within one launch. |

## apps/daemon/src/agent-host/adapters/grok/permissions.test.ts

Independent source (B1): GUI design §§4.3–4.4 approval decisions/modes; fixture 03 advertised option IDs and vendor tool metadata. Production seam and non-test callers (B4): permission decision/classification/grant-key helpers used by GrokSession at the provider authorization boundary.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L80: the adapter compensates for acceptEdits being a no-op on this CLI | REWRITE | Final caller review found that the retained lifecycle cases cover approval-required, auto-accept-edits and full-access, but not auto. Keep only auto’s two distinct policy assertions: edit approvals are automatic; all other approvals are not globally granted. Delete duplicate mode rows. B1 GUI §4.4 auto mode and server-side authorization rule; B2 an edit unnecessarily parks, or a non-edit is silently authorized; B3 independently fixed true/false policy; B4 exported pure runtime-mode policy functions consumed by session.ts; B5 internal control-flow/renaming can change; B6 no remaining runtime case owns auto-specific policy, unlike the deleted mode rows. Low risk. |
| L163: the vendor tool kind beats ACP's coarser one | REWRITE | The first arranged ACP edit and vendor write kinds previously agreed, so it could pass with wrong precedence. Make them disagree (ACP execute vs vendor write), retaining the independently required file-change approval. Provider vendor metadata is authoritative per captured protocol. Pure permission mapping is its lowest owner, used by session.ts. |

## apps/daemon/src/agent-host/adapters/grok/plan.test.ts

Independent source (B1): captured plan write/enter/exit frames, managed GROK_HOME requirement, GUI plan workflow contract. Production seam and non-test callers (B4): planMarkdownFromToolCall and nextPlanModeActive used by normalizer/session; stable provider-data conversion boundary.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L91: a write to anything else reports no plan at all | DELETE | Duplicates stronger negative controls for workspace plan.md and non-plan files within the Grok sessions directory in this file. Ordinary /work/notes.txt adds no independent failure mode. Low risk. |

## apps/daemon/src/agent-host/adapters/grok/questions.test.ts

Independent source (B1): fixture 07b question and answer protocol; public InputAnswer mapping. Production seam and non-test callers (B4): answersToXaiResponse consumed by GrokSession answerUserInput; fixed provider-envelope literals are expected values.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L61: annotations are omitted entirely when empty | DELETE | Duplicates the full literal answer-envelope assertion in “the envelope is keyed by question TEXT”; that stronger same-seam case already rejects an annotations property. No support loses its last caller. Low risk. |

## apps/daemon/src/agent-host/adapters/grok/replay.test.ts

Independent source (B1): redacted fixtures 02–11 and README observed provider order/data; GUI normalization and liveness contracts. Production seam and non-test callers (B4): captured frames through GrokNormalizer, with real liveness registry only for the recorded self-owned-shell misclassification regression.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L128: 02 plain prompt: the running context size becomes thread.token-usage.updated | DELETE | Getter-to-output equality and >1000 are weaker than usage.test.ts captured token-accounting oracle and the adjacent all-meter-rows regression. Getter remains production-used by session.ts; remove this redundant observation only. Low risk. |
| L136: 02 plain prompt: EVERY chunk-driven meter row carries the window, not just the session's | REWRITE | Retain every public usage row carrying the independently known 500k window and auto-compaction flag. Delete getter self-inspection and remove contextWindowTokens, which has no production callers. This detects the documented latest-row meter flicker through normalizer output; parser tests cannot expose lost per-row window fields. |
| L182: 04 reject: the tool fails and the turn's stop reason is a PermissionRejected cancel | REWRITE | Keep actual normalized failed tool and rejection detail; remove assertions that read stopReason/cancellationCategory directly from the fixture without executing production. lifecycle declined-tool case owns cancellation discrimination. The retained fixture case owns provider tool failure mapping at normalizer output. |
| L275: 11 background task: stopping the session closes every live task | DELETE | lifecycle.test.ts Stop with no active turn verifies the user operation actually closes background work; normalize.test.ts retains detailed task Stop/revival/final-end cases. A repeated fixture followed by a direct helper call adds no distinct failure. Low risk. |

## apps/daemon/src/agent-host/adapters/grok/session-replay.test.ts

Independent source (B1): captured ACP fixture traffic plus AgentAdapter lifecycle, request/reply, load, scheduled-task and question-cancel public contracts. Production seam and non-test callers (B4): GrokAdapter over replaying spawned CLI: registration, prompt arbitration, provider replies and teardown wiring unavailable to pure mapper tests.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L189: 15 replayed: a foreground agent ends once; the CLI's replies to its own reloads are not warnings | DELETE | subagent-replay fixture 15 already owns foreground completion and real payload at the normalizer seam; acp/peer.test.ts owns replies bearing the CLI request IDs. Other retained session replays exercise registration/dispatch. Removes a duplicate scenario at the subprocess layer. Low risk. |
| L271: 21 replayed: the session-scoped Stop closes the work; the poll that says the shell still runs revives it | DELETE | lifecycle.test.ts owns session-scoped Stop without an active turn; normalize.test.ts shell Stop/poll-running owns revival including new start status. This repeats the same scenario through fixture subprocess playback. Low risk. |
| L422: 29 replayed: a loop the host's teardown ends says why — it lived in the CLI the teardown stopped | REWRITE | Keep stopped status and a semantic host-attributed reason; delete full sentence equality. Public adapter stopAll must explain a host-caused end distinctly from user Stop. This integration proves teardown supplies that cause, while the lower mapper only passes an explicitly supplied reason. |

## apps/daemon/src/agent-host/adapters/grok/subagent-replay.test.ts

Independent source (B1): redacted fixtures 15–25 and README foreground/background/resume/child-session/kill protocol observations. Production seam and non-test callers (B4): captured frames through normalizer/session replay driver; RuntimeEvent identity/status/payload and wake-turn boundaries.

## apps/daemon/src/agent-host/adapters/grok/tool-output.test.ts

Independent source (B1): GUI design §4.5 explicit 8k tail, >=256-char/10-skipped-update coalescing rule, captured tool metadata/output forms. Production seam and non-test callers (B4): tool-output conversion/coalescing functions used by tool-calls.ts; fixed expected payload fragments and specified thresholds.

## apps/daemon/src/agent-host/adapters/grok/usage.test.ts

Independent source (B1): captured prompt/private response usage, USD x 1e9 protocol scale, advertised context-window metadata. Production seam and non-test callers (B4): usage conversion functions used by normalizer/session/probe; literal captured accounting quantities provide oracles.

## apps/daemon/src/agent-host/adapters/grok/work-replay.test.ts

Independent source (B1): redacted fixtures 26–30 and README permission rejection, turn cap, kill-already-exited, scheduler and goal observations. Production seam and non-test callers (B4): captured frames through production normalizer; registry used only to expose scheduled-loop versus live-fire deploy ownership.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L98: 29 a loop is a roster row of its own: started when created, re-noted per fire, ended when deleted | REWRITE | Keep event lifecycle, scheduled task kind, provider prompt data, creating turn and no agent ownership. Delete generated title/Fired once/Deleted exact-copy assertions. Captured loop frames independently require one scheduled row with a terminal stop; this normalizer seam can detect misrouting or lost closure without pinning copy. |

## apps/daemon/src/agent-host/adapters/grok/xai-updates.test.ts

Independent source (B1): fixture README observation 58 private update vocabulary and observations 37–51 spawn/finish/task ownership; AGENTS.md warn on unmapped events. Production seam and non-test callers (B4): GrokNormalizer public ACP/private frame handlers consumed by GrokSession; normalized events, with fold only for ownership joins.

| Original case | Disposition | Specific failure, remaining stronger coverage, risk |
| --- | --- | --- |
| L803: an unknown private update still warns | REWRITE | Assert warning event count and detail.sessionUpdate identifying the unknown provider kind, instead of exact diagnostic wording. AGENTS.md requires unmapped provider events to surface as warnings. The normalizer’s runtime-event boundary is the lowest owner of private-update dispatch. |

## Planned support removal

Remove `GrokNormalizer.contextWindowTokens`: repository-wide caller search found only the replay test assertion and the getter definition; no production caller uses it. `contextSize` remains production-used. Remove the unused AgentAdapterId import. Permission-policy imports remain necessary for the narrowed auto-only contract. Remove empty numeric-error parameter loop; check removed replay cases for unused local helpers. No capture becomes unused: retained capture-wide mapping and scenario cases still consume every Grok fixture.

## Validation results

Baseline scoped test run started before modifications; pending at audit-write time.

Additional support finding, recorded before removal: replay.test.ts no longer has a caller for its returned normalizer, so remove the ReplayRun wrapper return and its unused turnId option. Return only the normalized event array; captured input routing remains unchanged.

Baseline completed: 386/387 expanded tests passed in 285.9 s. Sole failure was the retained teardown-grace test (fake elapsed 3000 instead of 1000 ms). Isolated baseline rerun passed. The owner’s 1000 ms grace is correct; unrelated timer advancement in the test harness is the cause, addressed by the recorded REWRITE rather than deleting the regression or changing production behavior.

Focused changed-file validation: 210/210 tests passed in 157.4 s (concurrency 2; ten mapping/replay files). Complete Grok scope is next, including lifecycle and spawned fixture replay.

Additional dead-support decision before editing: after the numeric-code session table was removed, repository-wide search found `GROK_MOCK_PROMPT_ERROR_CODE` only in the mock peer and the remaining test setting its default -32603. Remove this redundant mock configuration flag and use the literal generic RPC error in that scenario; numeric mapping remains directly tested in acp/errors.test.ts. No production caller/configuration is affected.

Final support review: only 20 test files exist in scope, with no .check.ts files or snapshots. The final 366 declarations match the 14 completed declaration deletions exactly (the auto-only policy case was retained after caller review). Repository-wide searches found no non-documentation references to contextWindowTokens or the removed mock error-code flag. All captures remain consumed by the capture-wide replay contract. Final test diff inspected; `git diff --check` passes for all scoped files.

Final retention correction recorded before applying: the auto mode had no remaining stronger approval-policy coverage. Preserve only its two independently specified policy assertions in permissions.test.ts; other runtime-mode rows remain removed because lifecycle tests own them. This changes the disposition totals to 14 DELETE, 16 REWRITE, 350 KEEP (380 original declarations).

## Completed result

Every original declaration is dispositioned: **14 DELETE, 16 REWRITE, 350 KEEP**. Parameter-table pruning also removes redundant auth wording and numeric-code subprocess cases; the current suite expands to 369 tests. Changes total **230 fewer test lines**, **3 fewer mock-support lines**, and **4 fewer production lines**, excluding this required audit report. Production behavior is unchanged.

Removed support: unused `GrokNormalizer.contextWindowTokens` getter (no production callers), replay helper’s normalizer-return wrapper and unused turn-ID option, unused AgentAdapterId import, empty numeric-error parameter loop, and redundant mock RPC error-code configuration. No fixture/snapshot was orphaned. The final caller check retained auto-only permission-policy coverage because no stronger runtime test covers that mode.

Validation performed:

- Original baseline: 386/387 passed; one retained timing regression exposed unrelated fake-clock advancement, as investigated above. Isolated original regression passed.
- Focused changed mapping/replay files: 210/210 passed.
- Complete 20-file scoped suite: **368/368 passed** in 283.8 s, including the corrected real-process teardown-grace regression. Command: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test --test-concurrency=2 apps/daemon/src/agent-host/adapters/grok/*.test.ts apps/daemon/src/agent-host/adapters/grok/acp/*.test.ts`.
- Final auto-policy retention refinement: **permissions.test.ts 16/16 passed** in 11.9 s after the complete scoped run. This exercises the one additional retained case, bringing current expanded inventory to 369.
- All scoped source/test/support diffs inspected; `git diff --check` passes. Parent runs final workspace typecheck/test gates and remote synchronization/commit/push. No live daemon or development server was started.

No unresolved scoped test failures or cross-scope support changes remain.
