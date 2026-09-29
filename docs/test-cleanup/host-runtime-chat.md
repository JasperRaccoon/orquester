# Host runtime and daemon chat test cleanup

## Pre-edit disposition record

This inventory was recorded before changing any test or production owner. Scope: all 25 original test files in agent-chat, agent-host top-level, support and server; 339 individually read test cases. No source-grep/check files occur in this scope. Production owners, non-test callers and referenced local contracts were read. Disposition is at original test-title granularity; parameter combinations remain in their named case.

Contract references: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`, `docs/superpowers/specs/2026-09-24-agent-goals-design.md`, `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`, `apps/daemon/src/agent-host/README.md`, root `AGENTS.md`, shared `packages/api/src/agent-chat` contracts and the existing provider fixture provenance.

For each KEEP/REWRITE, the six numbered points in its file record apply to each separately listed required behavior below. The named condition is the independent expected behavior: its violation causes the caller-visible failure described in point 2. DELETE rows identify the failing bar and surviving owner. Fault models are listed before deciding isolated-unit retention.

Validation command prefix (run from `apps/daemon`): `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=1`. Append the per-file `src/...test.ts` path. Two handover cases were additionally recorded as REWRITE during final owner review before changing those cases: their direct marker setup bypassed the real stop route. Root owns final `pnpm check`, `pnpm test`, repository diff review and commit/push.

## `apps/daemon/src/agent-chat/activity-ladder.test.ts`

- Fault model before retaining isolated cases: resolveChatActivity/pushTypeForFields: precedence inversion, premature finished, suppressed attention, wrong goal continuation state.
- Non-test callers: summary.ts; MCP wait/views; workflow activity consumers.
- Bar 1 — independent source: GUI design §6.4 and goals design §4.7/§5.5; each row below selects its exact behavior.
- Bar 2 — recognizable failure: precedence inversion, premature finished, suppressed attention, wrong goal continuation state; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: resolveChatActivity/pushTypeForFields; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: The returned rung is also the public MCP SessionReason and workflow wait discriminator, so its literals are caller-visible protocol data. This is the lowest shared policy seam used outside the daemon poller; duplicated poller ladders are deleted. Distinct rung overlaps and race fallbacks must survive individually.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/activity-ladder.test.ts`.

## `apps/daemon/src/agent-chat/chat-sessions.test.ts`

- Fault model before retaining isolated cases: ChatSessionManager records/summaries and SessionRouter public operations: lost tabs, lost deletion queue, regressed cursors, wrong kind routing or account state.
- Non-test callers: AgentChatService; SessionRouter; SessionManager index contributor; root session API.
- Bar 1 — independent source: GUI design §5.2/§6.1/§6.4 and goals design §4.7; persisted SessionRecord/public session routing contract; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost tabs, lost deletion queue, regressed cursors, wrong kind routing or account state; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: ChatSessionManager records/summaries and SessionRouter public operations; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Persistence and mixed-kind routing are separate owner boundaries; service tests cover transaction ordering, not malformed index rows or mixed list behavior.
- Validation: command prefix above plus `src/agent-chat/chat-sessions.test.ts`.

## `apps/daemon/src/agent-chat/home-prep.test.ts`

- Fault model before retaining isolated cases: real .claude.json writer: absent/malformed file, erased user data, broad credential permissions, severed symlink or launch-aborting I/O error.
- Non-test callers: AgentChatService.create and switchAccount via markClaudeProjectTrusted.
- Bar 1 — independent source: GUI design Claude trust amendment and host security rule preserving credential-bearing config; documented account-home symlinks; each row below selects its exact behavior.
- Bar 2 — recognizable failure: absent/malformed file, erased user data, broad credential permissions, severed symlink or launch-aborting I/O error; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real .claude.json writer; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Actual filesystem writer is the lowest stable config seam; pure-transform probes are deleted/consolidated. Service keeps sandbox selection, not duplicate writer mechanics.
- Validation: command prefix above plus `src/agent-chat/home-prep.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| DELETE | a never-seen directory is marked trusted, with onboarding forced | Private transformation probe; the retained absent-file writer case gains these literal persisted flags, proving trust bytes at the production seam. |
| DELETE | an existing project's other settings are preserved | Private transformation probe; preservation moves into the existing real 0644-config writer regression, which also protects credential permissions. |
| REWRITE | a malformed projects map is replaced rather than crashing the launch | Exercise markClaudeProjectTrusted against a real malformed config, then inspect persisted trust flags; stop exporting the private pure transform. |
| DELETE | the other projects in the file survive the grant | Private transformation probe; preservation moves into the existing real 0644-config writer regression, checking actual persisted neighboring project/history data. |
| REWRITE | markClaudeProjectTrusted writes 0600 and survives an absent file | Consolidate first-use onboarding/trust flags at this real persisted-file seam while retaining mode and idempotence checks. |
| REWRITE | a pre-existing 0644 config is NARROWED to 0600, never left wide | Consolidate same-project settings, other projects, history and credential preservation at the real config writer, together with 0600 narrowing. |

## `apps/daemon/src/agent-chat/host-client.test.ts`

- Fault model before retaining isolated cases: HTTP body stream and public error/cause classifier: uncaught body errors, lost cap refusal, false 413 for unrelated errors.
- Non-test callers: AgentChatService upload proxy; upload-stream consumers.
- Bar 1 — independent source: public AgentHostClient/upload error contract; credible body-error regression with early host refusal; each row below selects its exact behavior.
- Bar 2 — recognizable failure: uncaught body errors, lost cap refusal, false 413 for unrelated errors; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: HTTP body stream and public error/cause classifier; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Client owns stream rejection/cause preservation; service routes separately own response status and downstream connection cleanup. Neither alone substitutes for the other.
- Validation: command prefix above plus `src/agent-chat/host-client.test.ts`.

## `apps/daemon/src/agent-chat/owner.test.ts`

- Fault model before retaining isolated cases: parseSessionOwner and public sessions route: accepting malformed ownership, dropping legitimate owner, permitting ownership on terminal sessions.
- Non-test callers: root POST /api/sessions route; AgentChatService.create.
- Bar 1 — independent source: workflow-owned SessionOwner API schema and GUI create-session transport contract; each row below selects its exact behavior.
- Bar 2 — recognizable failure: accepting malformed ownership, dropping legitimate owner, permitting ownership on terminal sessions; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: parseSessionOwner and public sessions route; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Parser owns complete field validation; route cases own API status/kind gating and transport propagation. Service persistence is a separate boundary.
- Validation: command prefix above plus `src/agent-chat/owner.test.ts`.

## `apps/daemon/src/agent-chat/provider-auth-overlay.test.ts`

- Fault model before retaining isolated cases: overlayManagedAccountAuth: false sign-in toast, wrong account family/default, overwritten system identity, erased non-auth install error.
- Non-test callers: AgentChatService provider snapshots.
- Bar 1 — independent source: GUI design §7.7 managed-account authentication overlay; each row below selects its exact behavior.
- Bar 2 — recognizable failure: false sign-in toast, wrong account family/default, overwritten system identity, erased non-auth install error; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: overlayManagedAccountAuth; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest pure reconciliation owner. Fixture snapshots are inputs; fixed expected status/account fields are independent of production filtering.
- Validation: command prefix above plus `src/agent-chat/provider-auth-overlay.test.ts`.

## `apps/daemon/src/agent-chat/proxy-routes.test.ts`

- Fault model before retaining isolated cases: public HTTP requests with controlled upstream: lost body/path/query/auth, incorrect status/envelope, leaked raw upstream response, failed stream cancellation.
- Non-test callers: AgentChatService HTTP registration; UI/API/MCP clients through daemon transport.
- Bar 1 — independent source: shared agent-chat API paths/types and GUI design §6.2/§6.3; thread-index prompt/history wire contracts; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost body/path/query/auth, incorrect status/envelope, leaked raw upstream response, failed stream cancellation; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: public HTTP requests with controlled upstream; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Proxy forwarding is the actual contract, so sentinel upstream data is an independent oracle, not a mock implementing proxy behavior. Host tests own host meaning; these own distinct daemon transport transformations.
- Validation: command prefix above plus `src/agent-chat/proxy-routes.test.ts`.

## `apps/daemon/src/agent-chat/service.test.ts`

- Fault model before retaining isolated cases: public create/switch/provider/upload service and HTTP routes: wrong identity/env, security trust escape, orphan tab, wrong host ordering, upload crash/truncation or connection leak.
- Non-test callers: daemon service lifecycle; session routes; account switches; DaemonApi/MCP.
- Bar 1 — independent source: GUI design §5.2/§6.1/§6.2, trust amendment, goals design §5.7 and agent profile §4.8; binary-upload API; each row below selects its exact behavior.
- Bar 2 — recognizable failure: wrong identity/env, security trust escape, orphan tab, wrong host ordering, upload crash/truncation or connection leak; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: public create/switch/provider/upload service and HTTP routes; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Service is the lowest owner for tab-host transactions, account-home selection and HTTP/upload coordination. Simple trust duplication is removed; underlying env/config helpers own independent transformation mechanics.
- Validation: command prefix above plus `src/agent-chat/service.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| DELETE | the project is marked trusted for the home the thread will run under | Duplicates the immediately following validated-projectPath-versus-request-cwd test, which uses the same account home and proves the stronger security boundary. |

## `apps/daemon/src/agent-chat/session-index.test.ts`

- Fault model before retaining isolated cases: real sessions.json reattachment/save: accidental PTY attach/reap, failed legacy migration, lost mixed records or corrupt overlapping writes.
- Non-test callers: SessionManager persistence and ChatSessionManager contributor.
- Bar 1 — independent source: GUI design §5.2 migration/session persistence and AGENTS.md legacy terminal ownership; each row below selects its exact behavior.
- Bar 2 — recognizable failure: accidental PTY attach/reap, failed legacy migration, lost mixed records or corrupt overlapping writes; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real sessions.json reattachment/save; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: This is the actual mixed-kind persistence seam, not a duplicate of single chat-record serialization; realistic close operations replace an unnecessary test seam.
- Validation: command prefix above plus `src/agent-chat/session-index.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | concurrent writes retain the latest complete session index | Replace the test-only ChatSessionManager.clear shortcut with production close operations before the next save; preserve real disk race assertions. |

## `apps/daemon/src/agent-chat/summary.test.ts`

- Fault model before retaining isolated cases: poll host summaries and observe tab/bus/push outputs: false startup push, missed attention restamp, duplicate pending events, erased last known state or wrong drain readiness.
- Non-test callers: daemon SummaryPoller lifecycle, SessionRouter, workflow bus and push publisher, supervisor drain.
- Bar 1 — independent source: GUI design §6.4 coarse activity/pending/turn events; MCP wait cursor semantics; goals §4.7/§5.5; each row below selects its exact behavior.
- Bar 2 — recognizable failure: false startup push, missed attention restamp, duplicate pending events, erased last known state or wrong drain readiness; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: poll host summaries and observe tab/bus/push outputs; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Retains poll comparison, field validation and publication semantics; deletes repeated pure ladder scenarios owned by activity-ladder. Same-turn/new-id/replayed-row cases are different credible missed-wakeup failure modes.
- Validation: command prefix above plus `src/agent-chat/summary.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| DELETE | a pending approval pushes 'needs your input' exactly once per raise | Duplicates the stronger restamp-only notification case, which crosses several polls, changes request identity, and checks push count and attention transitions. |
| DELETE | NEVER a 'finished' push while background liveness is non-null | Duplicates activity-ladder's exhaustive push suppression rule, including errored sessions; summary retains real liveness propagation/drain tests and notification transition ownership. |
| DELETE | a continuing goal holds the finished stamp and push until the goal stops (goals §4.7) | Replays the activity-ladder goal precedence contract one layer higher. Goal parsing/propagation, notification transitions and ladder decisions retain separate owners. |
| DELETE | a goal turn killed by a restart raises no finished stamp or push while its resume is owed (goals §5.5) | Repeats activity-ladder's errored-session/continuing-goal case with arranged host summaries; it does not exercise an actual restart. Real restart/continuation is covered by host-teardown and goals owners. |
| DELETE | an errored thread whose watch loop is still live does not push 'finished' | Duplicates activity-ladder's non-null-background push suppression matrix. Summary retains error-to-tab state propagation independently. |
| DELETE | forget() stops a closed tab producing any further activity | Passes for the wrong reason: the tab is closed as well as forgotten, so refreshAll has no tab to poll even if forget does nothing. Re-adoption after forget remains and detects stale memo state. |

## `apps/daemon/src/agent-chat/supervisor.test.ts`

- Fault model before retaining isolated cases: supervisor public lifecycle with process/transport fakes: lost active work, foreign-process kill, stale token race, fatal unhandled spawn, endless retry or lost legacy goal handover.
- Non-test callers: AgentChatService start/health/restart; daemon stop protection.
- Bar 1 — independent source: GUI design §3.1/§3.3/§8 host adoption and drain lifecycle; goals §5.7; AGENTS.md session ownership and secrets; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost active work, foreign-process kill, stale token race, fatal unhandled spawn, endless retry or lost legacy goal handover; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: supervisor public lifecycle with process/transport fakes; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest stable host-supervision state-machine owner; tests model external process/probe replies and assert externally meaningful spawn/kill/hold decisions. Real teardown tests own provider flush/continuation, not supervisor decisions.
- Validation: command prefix above plus `src/agent-chat/supervisor.test.ts`.

## `apps/daemon/src/agent-host/main.test.ts`

- Fault model before retaining isolated cases: real isolated host boot and durable files: stale upload work survives a host downtime/restart or fresh work is deleted.
- Non-test callers: agent-host process boot.
- Bar 1 — independent source: GUI design §3.1 startup housekeeping and persisted upload/session retention; each row below selects its exact behavior.
- Bar 2 — recognizable failure: stale upload work survives a host downtime/restart or fresh work is deleted; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real isolated host boot and durable files; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Composition-only startup-wiring regression cannot be proven by the sweeper unit; isolated appdir artifact is inspected.
- Validation: command prefix above plus `src/agent-host/main.test.ts`.

## `apps/daemon/src/agent-host/host-teardown.test.ts`

- Fault model before retaining isolated cases: isolated host instance, child processes and durable events.ndjson: orphan helpers, missing terminal rows, lost active turns, failed resume or shutdown completion before helper cleanup.
- Non-test callers: real agent-host process main shutdown; daemon supervisor handover.
- Bar 1 — independent source: GUI design §3.3 intentional shutdown and durable append-only logs; provider lifecycle and continuation regressions; each row below selects its exact behavior.
- Bar 2 — recognizable failure: orphan helpers, missing terminal rows, lost active turns, failed resume or shutdown completion before helper cleanup; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: isolated host instance, child processes and durable events.ndjson; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Critical composition ownership: actual lifecycle/IPC/log artifacts across stop and new host. Provider unit tests cannot establish lifecycle + durable ordering + restart integration.
- Validation: command prefix above plus `src/agent-host/host-teardown.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | a helper that ignores SIGTERM is killed inside the SIGTERM path's 3 s backstop | Root-review disposition recorded before this edit: retain actual helper disappearance at completed authenticated HTTP stop, bounded by a watchdog; remove the total-stop wall-clock measurement, which never ran the SIGTERM process-entry backstop and included unrelated log/index/cache draining and scheduling. The lower Grok lifecycle test owns the independently documented 1000 ms TERM→KILL grace using a real helper and controlled time. Composition uniquely catches an early onStopped completion or an orphan after shutdown. |
| REWRITE | an intentional stop's running Grok turn is continued by the next host, the teardown's rows kept | Final owner review: the handover manually marked continuation, bypassing the HTTP stop composition. Issue authenticated POST /stop with AgentHostClient, assert acknowledged thread ids, await the production onStopped lifecycle callback, then retain the durable log and next-host continuation assertions. The oracle is the real persisted resumed turn, independent of the route implementation; this is the lowest stable composition seam for this regression. |
| REWRITE | an intentional stop's running Codex turn is continued by the next host, the teardown's rows kept | Final owner review: the handover manually marked continuation, bypassing the HTTP stop composition. Issue authenticated POST /stop with AgentHostClient, assert acknowledged thread ids, await the production onStopped lifecycle callback, then retain the durable log and next-host continuation assertions. The oracle is the real persisted resumed turn, independent of the route implementation; this is the lowest stable composition seam for this regression. |

## `apps/daemon/src/agent-host/support/code-stamp.test.ts`

- Fault model before retaining isolated cases: real temporary git-layout files: stale build incorrectly adopted because detached/packed/worktree identity is unreadable.
- Non-test callers: agent-host main and AgentChatService readCodeStamp; supervisor codeStampsDiffer.
- Bar 1 — independent source: Git HEAD/packed-refs/worktree file formats; GUI design code-version drain amendment; each row below selects its exact behavior.
- Bar 2 — recognizable failure: stale build incorrectly adopted because detached/packed/worktree identity is unreadable; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real temporary git-layout files; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Filesystem parser owns git layout variants; boolean comparison duplicate is deleted in favor of supervisor restart/adoption cases.
- Validation: command prefix above plus `src/agent-host/support/code-stamp.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| DELETE | only two known, different stamps differ | Boolean helper truth table duplicates supervisor adoption/drain cases for changed, equal and unknown stamps; those observe an actual restart decision. The helper retains its production supervisor caller. |

## `apps/daemon/src/agent-host/support/deadline.test.ts`

- Fault model before retaining isolated cases: withDeadline public promise outcome and abort callbacks: wrong winning result, swallowed failure, cancellation hang or unhandled late rejection.
- Non-test callers: provider adapters, orchestrator, host HTTP server.
- Bar 1 — independent source: host startup/provider deadline and cancellation contract, GUI design §3.1; each row below selects its exact behavior.
- Bar 2 — recognizable failure: wrong winning result, swallowed failure, cancellation hang or unhandled late rejection; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: withDeadline public promise outcome and abort callbacks; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest reusable deadline seam; caller tests establish their own policy, not all promise race/error modes.
- Validation: command prefix above plus `src/agent-host/support/deadline.test.ts`.

## `apps/daemon/src/agent-host/support/env.test.ts`

- Fault model before retaining isolated cases: buildProviderEnv values: ambient vendor credential leak, wrong account home/PATH/TMPDIR, missing process ownership marker or session id.
- Non-test callers: agent-host main launches; provider sessions and AgentChatService account env selection.
- Bar 1 — independent source: GUI design §3.1 child env allowlist and account-home/launch identity; AGENTS.md secret isolation; each row below selects its exact behavior.
- Bar 2 — recognizable failure: ambient vendor credential leak, wrong account home/PATH/TMPDIR, missing process ownership marker or session id; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: buildProviderEnv values; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Security allowlist/precedence owner. Spawn integration tests cover actual OS inheritance separately; caller tests do not enumerate toxic ambient/extraEnv values.
- Validation: command prefix above plus `src/agent-host/support/env.test.ts`.

## `apps/daemon/src/agent-host/support/leftover-processes.test.ts`

- Fault model before retaining isolated cases: process scanner/signal executor against synthetic /proc and real subprocesses: kill stranger/recycled PID, miss orphan member, fail escalation or touch unsupported OS.
- Non-test callers: Grok session cleanup; leftover-work sweeper; workflows sandbox parseStat.
- Bar 1 — independent source: Linux /proc stat/environ identity; host README leftover-work safety; AGENTS.md process/session ownership; each row below selects its exact behavior.
- Bar 2 — recognizable failure: kill stranger/recycled PID, miss orphan member, fail escalation or touch unsupported OS; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: process scanner/signal executor against synthetic /proc and real subprocesses; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Synthetic proc fixtures enable exact PID-reuse races unavailable reliably at process integration; real /proc test uniquely proves kernel format/session semantics. Signal recorder asserts permitted targets, not private implementation shape.
- Validation: command prefix above plus `src/agent-host/support/leftover-processes.test.ts`.

## `apps/daemon/src/agent-host/support/leftover-work.test.ts`

- Fault model before retaining isolated cases: actual sidecar persistence plus sweep boundary: lost launch records, broad permissions, malformed data crash, recreated deleted thread or multiplied shutdown delay.
- Non-test callers: Grok background session lifecycle and host close/boot sweeps.
- Bar 1 — independent source: host README retained-work.json format, 0600, 8 launches/64 sessions bounds, no ghost threads; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost launch records, broad permissions, malformed data crash, recreated deleted thread or multiplied shutdown delay; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: actual sidecar persistence plus sweep boundary; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Storage writer/reader owns tolerance/concurrency/bounds; proc tests own identity checks; sweep tests own assembling remembered launches and clearing durable work.
- Validation: command prefix above plus `src/agent-host/support/leftover-work.test.ts`.

## `apps/daemon/src/agent-host/support/ndjson.test.ts`

- Fault model before retaining isolated cases: reader/writer public byte stream: corrupted split codepoint, phantom line, dropped final frame, unbounded queue or post-close write.
- Non-test callers: Codex protocol and Grok transport/ACP connection.
- Bar 1 — independent source: NDJSON/UTF-8/CRLF provider framing and backpressure contract, host README transport map; each row below selects its exact behavior.
- Bar 2 — recognizable failure: corrupted split codepoint, phantom line, dropped final frame, unbounded queue or post-close write; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: reader/writer public byte stream; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest framing owner; provider replay fixtures ordinarily use full frames and cannot uniquely detect arbitrary transport splits/pressure.
- Validation: command prefix above plus `src/agent-host/support/ndjson.test.ts`.

## `apps/daemon/src/agent-host/support/spawn-group.test.ts`

- Fault model before retaining isolated cases: real provider child/grandchild process group: descendant survives provider shutdown.
- Non-test callers: provider child termination via spawnProvider.
- Bar 1 — independent source: host provider lifecycle requires descendant process-group termination; AGENTS.md PTY/process ownership; each row below selects its exact behavior.
- Bar 2 — recognizable failure: descendant survives provider shutdown; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real provider child/grandchild process group; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Distinct kernel process-group ownership seam; single-child spawn test cannot detect an orphan grandchild.
- Validation: command prefix above plus `src/agent-host/support/spawn-group.test.ts`.

## `apps/daemon/src/agent-host/support/spawn.test.ts`

- Fault model before retaining isolated cases: real child process and public result: inherited secrets, missing stderr/exit status, uncaught ENOENT, stuck process or repeated kill failure.
- Non-test callers: Claude/Codex/Grok provider process launches.
- Bar 1 — independent source: GUI design §3.1 subprocess outcome, explicit env, stderr and escalation rules; each row below selects its exact behavior.
- Bar 2 — recognizable failure: inherited secrets, missing stderr/exit status, uncaught ENOENT, stuck process or repeated kill failure; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real child process and public result; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest OS spawn owner, different from env policy pure builder and descendant group integration. Fixed child script exit/data are an external oracle.
- Validation: command prefix above plus `src/agent-host/support/spawn.test.ts`.

## `apps/daemon/src/agent-host/support/stderr.test.ts`

- Fault model before retaining isolated cases: redacted emitted lines/tail: leaked credential or home path, terminal escapes in UI, lost error severity, corrupted chunking or unbounded diagnostics.
- Non-test callers: all provider adapters; agent-profile CLI runner stripAnsi.
- Bar 1 — independent source: GUI design §3.1 ANSI cleanup/redaction/classification/4KiB tail and provider fixture redaction provenance; each row below selects its exact behavior.
- Bar 2 — recognizable failure: leaked credential or home path, terminal escapes in UI, lost error severity, corrupted chunking or unbounded diagnostics; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: redacted emitted lines/tail; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest privacy/framing owner with literal hazardous fixtures. Repeated cache-internal probe is removed; each remaining case protects a distinct token/path/frame boundary.
- Validation: command prefix above plus `src/agent-host/support/stderr.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | redaction collapses a percent-encoded home too, in either hex case | Remove repeated compiled-regex cache probe with an expected string generated by replace; retain literal encoded-home, case and regex-metacharacter privacy oracles. |

## `apps/daemon/src/agent-host/support/tail-file.test.ts`

- Fault model before retaining isolated cases: real output files: duplicate/missing appended bytes, split Unicode corruption, uncapped output, repeated unreadable notices or missed truncation restart.
- Non-test callers: Claude background task output capture.
- Bar 1 — independent source: Claude background-output cap/UTF-8 offset contract; provider fixture and host module map; each row below selects its exact behavior.
- Bar 2 — recognizable failure: duplicate/missing appended bytes, split Unicode corruption, uncapped output, repeated unreadable notices or missed truncation restart; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real output files; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest filesystem output-tail owner; adapter tests consume summaries and do not create append/truncate/read-error edge cases.
- Validation: command prefix above plus `src/agent-host/support/tail-file.test.ts`.

## `apps/daemon/src/agent-host/server/http-server.test.ts`

- Fault model before retaining isolated cases: real Unix-socket HTTP/NDJSON: unauthorized access, wrong route/status/bytes/pagination, lost live events, unclosed connection or invalid goal hold/resume response.
- Non-test callers: daemon AgentHostClient, summary poller and supervisor; public host Unix socket clients.
- Bar 1 — independent source: GUI design §6.2/§6.3/§6.6, host-protocol.ts, shared wire types, thread-index and goals protocols; each row below selects its exact behavior.
- Bar 2 — recognizable failure: unauthorized access, wrong route/status/bytes/pagination, lost live events, unclosed connection or invalid goal hold/resume response; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: real Unix-socket HTTP/NDJSON; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Public protocol exception: server owns parsing/serialization/status and transport lifecycle; orchestrator/index units own domain transitions. Bogus pre-arranged stop ordering is deleted; open-stream count becomes observed client close.
- Validation: command prefix above plus `src/agent-host/server/http-server.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | answers one identical 401 for a missing and for a wrong token | Compare actual missing-token and wrong-token status/envelopes; assert protocol code, remove exact human Unauthorized wording. |
| REWRITE | refuses a malformed offset, clamps maxBytes, and answers an offset past the end as the end | Retain status, error code, UTF-8 byte window bounds and clamping; remove exact diagnostic prose assertions. |
| REWRITE | names every open request so the daemon can publish agentChat.pending | Assert request ids and approval/question kinds without pinning generated presentation titles. |
| DELETE | the intentional stop writes the continuation markers first (§3.3) | Arranges the claimed effect itself by manually marking the orchestrator before calling /stop; harness onStop returns an empty list. Cannot detect production stop ordering. Host-teardown's real stop/restart tests retain durable continuation coverage. Delete its harness-only afterStopResponse option. |
| REWRITE | closes every open stream when the host stops | Await actual HTTP response close after stopping the host, instead of a test-only openStreams counter. Remove that unused production getter/interface member. |

## `apps/daemon/src/agent-host/server/stream.test.ts`

- Fault model before retaining isolated cases: createThreadStream wire frames and sink closure: event loss/duplication during read, early synchronized frame, missed heartbeat, memory overrun or write after disconnect.
- Non-test callers: host HTTP server thread streams.
- Bar 1 — independent source: GUI design §6.3 snapshot/replay atomic tail and §6.6 framing/coalescing/backpressure; each row below selects its exact behavior.
- Bar 2 — recognizable failure: event loss/duplication during read, early synchronized frame, missed heartbeat, memory overrun or write after disconnect; each named scenario distinguishes the failure it can expose.
- Bar 4 — stable seam: createThreadStream wire frames and sink closure; no retained assertion requires a private call graph.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest streaming owner with an OS-sink fake; it does not implement snapshot overlap selection/queueing. HTTP integration owns socket wiring, not exhaustive scheduled pressure/race cases.
- Validation: command prefix above plus `src/agent-host/server/stream.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | loses no event published while the read is in flight, and duplicates none | Remove private subscription-order flag/assertion. The output sequence already proves no missed in-flight event and no replay duplication. |

## Production/support removed

- Remove the export on `applyClaudeProjectTrust`; production only calls it inside `markClaudeProjectTrusted`. Writer tests use the same filesystem boundary as AgentChatService.
- Remove `ChatSessionManager.clear`, an explicitly labeled test/teardown helper with only the concurrent-index test caller. Use public close operations in that case.
- Remove `AgentHostServer.openStreams` and its returned getter; only the server shutdown test reads it. Observe the HTTP response close instead.
- Remove the HTTP test harness `afterStopResponse` option used solely by the deleted pre-arranged continuation test. Keep the actual production callback used by main.
- Remove now-unused imports and the empty codeStampsDiffer suite. No provider fixtures or durable snapshots become unowned.

## Validation and completion

Baseline: 299 tests passed, 3 failed (302 executed because two files failed import before registering 39 cases). `owner.test.ts` and `service.test.ts` could not import missing installed dependency `yauzl`; root is reconciling dependencies with frozen lockfile install. The SIGTERM backstop case measured 4805 ms during heavily concurrent host work; it remains retained and will be rerun isolated before judging product behavior. No failing test is deleted for being red.

Cleanup is implemented and its final diff inspected: **12 DELETE, 13 REWRITE, 314 KEEP** across 339 original cases; **327 cases remain**. Test diff: 79 lines added, 277 removed (**net -198 test LOC**). Production exposure cleanup removes 9 net lines; no runtime behavior changes. No fixtures or snapshots became unowned.

Post-edit checks (from `apps/daemon`, using the preload/runner prefix above):

- `src/agent-chat/home-prep.test.ts src/agent-chat/session-index.test.ts src/agent-chat/summary.test.ts src/agent-host/support/code-stamp.test.ts src/agent-host/support/stderr.test.ts src/agent-host/server/stream.test.ts src/agent-host/server/http-server.test.ts`: **96 passed, 0 failed**. Includes the actual HTTP close oracle, authentication equality, preserved config bytes/mode/symlink and concurrent session saves.
- `src/agent-chat/owner.test.ts src/agent-chat/service.test.ts`: **38 passed, 0 failed** after root restored the missing lockfile-declared dependencies with `pnpm install --frozen-lockfile`; no dependency metadata changes.
- `--test-name-pattern='an intentional stop' src/agent-host/host-teardown.test.ts`: **2 passed, 0 failed, 4 deliberately unselected**. Both provider handovers now use authenticated real HTTP `/stop`, observe its acknowledged marked thread, await production `onStopped`, and inspect durable log/meta artifacts after the next host starts.
- `git diff --check` for all owned test/production files and this report: **passed**.
- Original and final AST inventories: 25 files, 339 → 327 named cases; report lists every original case.

Root-review follow-up, recorded before editing the composition case: the original total-stop wall measurement failed at 4805 ms and 4537 ms under heavy shared load, while both runs confirmed that the actual helper was killed. `agent-host/README.md` documents a 1 s helper grace inside the process entry's 3 s SIGTERM backstop. It does not require an in-process `stop()` call, including all log/index/cache flushing and scheduling, to return within 3 s of caller wall time. This test never executed that process-entry timer, so its measured failure did not establish a violated signal deadline or a leaked helper.

The rewritten existing case is named `an authenticated host stop reaps a helper that ignores SIGTERM before reporting completion`: it uses the real authenticated Unix-socket stop route, waits for the same `onStopped` callback that permits the production process to exit, and verifies the real helper is absent. A 15 s watchdog fails a hung teardown; it is test infrastructure, not a replacement product latency oracle. The lower owner `apps/daemon/src/agent-host/adapters/grok/lifecycle.test.ts` retains `at the host's teardown a helper that ignores SIGTERM is killed after a 1 s grace, not spawn.ts's 2 s`: actual TERM and KILL signals reach a spawned helper; a controlled clock asserts exactly 1000 ms between them; helper absence is observed before adapter teardown completion. Host composition now owns route wiring and completed cleanup, and the lower seam owns signal timing. No production backstop or grace was changed. Post-edit validation: the entire `src/agent-host/host-teardown.test.ts` file ran serially with the documented preloads: **6 passed, 0 failed**, including the rewritten helper case and both HTTP handovers (19.1 s total). `git diff --check` passed again. The scoped regression validation is complete; final repository gates remain root-owned.

Repository-wide lint/typecheck/test gates, remote synchronization and commit/push are root-agent responsibilities. This scoped cleanup does not alter package scripts, thresholds, production state or the live daemon.
