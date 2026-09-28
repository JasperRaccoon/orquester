# Claude test-seam cleanup addendum

Status: completed cleanup; pre-edit record and final verification; complements `adapter_claude_opencode.md` without re-auditing unrelated tests.

Caller audit: `ClaudeAdapterDeps.onGoalWorkIdle` and `goalReadGate` are supplied only by `lifecycle.test.ts`; session goal work invokes them solely for test synchronization. `goalWorkPending` exists only to feed the idle callback. The SDK query/spawn interfaces remain real transport boundaries. `setTimer`, `clearTimer`, and configurable deadlines are supplied by the production defaults and overridden only by this lifecycle harness. `ClaudeGoalTranscriptOptions.maxReadBytes` is overridden only by four goal-transcript tests; session construction passes configDir and cwd alone.

Production changes planned: remove goal observer/gate and their counter, use native timers with the exact existing production windows, and use the existing 1 MiB transcript read size directly. No protocol, persistence, authentication, or user behavior is changed.

The affected tests are REWRITE at their existing owner. Six-bar justification: (1) host design §3.1 requires bounded child operations and paused watchdogs, goals §6.1.4–5 and Claude fixture README observation 23 require transcript verdicts, delayed writes, user precedence, serialized reads and teardown ordering; (2) a stuck session, hidden goal completion, resurrected cleared goal, lost transcript row or reordered exit is visible to callers; (3) literal states, error outcomes, transcript bytes and event ordering are independent expectations; (4) native timers and real filesystem operations replace private timer arrays and goal-work callbacks while the public adapter/session remains the observed boundary; (5) no private queue shape or timer handle is asserted; (6) these cases own adapter integration with the SDK/file boundaries, while `goal-transcript.test.ts` owns incremental storage reads. Risk: medium during harness migration, mitigated by focused lifecycle/transcript suites, then all Claude tests.

Failure modes retained: handshake never answers; compaction never settles; context-usage refresh never answers; a pending approval incorrectly trips liveness; background shell output is lost between polls; deferred goal progress never flushes; a late transcript verdict is missed on first or second retry; a cancelled retry consumes later-turn data; slow transcript work races session stop/recovery or a user goal change; serialized multi-chunk reads lose or misattribute a verdict. Filesystem delay/failure tests intercept native file operations while reading actual bytes; no mock computes an asserted goal result.

Transcript cases using a cap override will use actual 1 MiB files: bounded split-row reading, skipping oversized lines, committing each chunk, and retrying an abandoned chunk. Expected rows are literal inputs. These remain the lowest storage owner and cannot be replaced by adapter timing assertions.

Validation: from apps/daemon, use node with the repository tsx/assert-ok/quiet-mock-timers hooks on `adapters/claude/lifecycle.test.ts` and `goal-transcript.test.ts`; then all Claude test files. Root owns broad repository gates.

Final disposition amendment: DELETE `lifecycle.test.ts` — “a verdict that never lands costs two bounded re-reads, no rows, and a timer cleared at teardown.” Its timer-array count and cleared-handle assertions observe private scheduling. The retained late-verdict cases exercise both real retry windows, the rewritten new-turn case proves later verdict bytes remain unconsumed until that turn finishes, and the retained stop/multi-chunk cases verify no goal output follows session exit. No test-only timer counter remains.

## Per-case amendments

The full six-bar and caller/risk record above applies to each row; the original names identify the independently specified failure. All paths are under `apps/daemon/src/agent-host/adapters/claude/`.

| Disposition | Baseline path:line | Case / exact protected failure |
| --- | --- | --- |
| REWRITE | `lifecycle.test.ts:634` | an expired handshake deadline kills the child instead of staying 'starting' |
| REWRITE | `lifecycle.test.ts:1380` | the liveness watchdog cancels a silent turn and pauses on a pending request |
| REWRITE | `lifecycle.test.ts:1980` | Q1 #13: a compaction that never settles is bounded, not a permanent wedge |
| REWRITE | `lifecycle.test.ts:2410` | tails the CLI's output file and drains it BEFORE the completion bookend |
| REWRITE | `lifecycle.test.ts:2499` | an unreadable output file says so once and stops, rather than polling forever |
| REWRITE | `lifecycle.test.ts:2620` | an unanswered request expires on its own deadline rather than hanging the thread |
| REWRITE | `lifecycle.test.ts:2808` | a row of the goal's previous run, behind the set point, never ends the new run |
| REWRITE | `lifecycle.test.ts:2824` | still unmet with background work live at turn end is `waiting-background`; a throttled change is flushed by its timer |
| REWRITE | `lifecycle.test.ts:2928` | a session dying with a goal read parked finishes its teardown before its recovery starts |
| REWRITE | `lifecycle.test.ts:2974` | a stop on a session already closing waits for all of its teardown |
| REWRITE | `lifecycle.test.ts:3050` | a met verdict the CLI writes ~100 ms AFTER its result is found by the re-read, stamped with the turn that ended |
| REWRITE | `lifecycle.test.ts:3074` | an impossible verdict landing only by the second re-read is `failed` |
| DELETE | `lifecycle.test.ts:3100` | a verdict that never lands costs two bounded re-reads, no rows, and a timer cleared at teardown |
| REWRITE | `lifecycle.test.ts:3124` | a new turn supersedes a pending re-read |
| REWRITE | `lifecycle.test.ts:3161` | a walk whose epoch moved before it started ends WITHOUT reading: its rows stay for the next walk |
| REWRITE | `lifecycle.test.ts:3206` | a read that fails ends its walk and hands off to the next waiting walk |
| REWRITE | `lifecycle.test.ts:3284` | a stop mid-way through a multi-chunk walk still lands the verdict before session.exited |
| REWRITE | `lifecycle.test.ts:3339` | two turn-end walks never interleave: a verdict keeps the turn that wrote it |
| REWRITE | `lifecycle.test.ts:3459` | a slow scan never resurrects a goal the user cleared meanwhile |
| REWRITE | `lifecycle.test.ts:3509` | the same goal on both sides is quiet |
| REWRITE | `lifecycle.test.ts:3517` | a missing transcript leaves the thread's goal alone, with a debug line |
| REWRITE | `lifecycle.test.ts:3537` | a lazy recovery compares with the goal the dead session last reported, not the one it started with |
| REWRITE | `goal-transcript.test.ts:212` | walks the file in bounded reads, rows split across reads included |
| REWRITE | `goal-transcript.test.ts:229` | skips a line longer than one whole read — a goal row never is |
| REWRITE | `goal-transcript.test.ts:347` | commits every chunk: a delta bigger than one read is walked in pieces, each one kept |
| REWRITE | `goal-transcript.test.ts:370` | a chunk that is abandoned loses nothing an earlier chunk committed |

Validation: focused lifecycle/transcript suite **117 passed, 0 failed**; all Claude adapter tests **441 passed, 0 failed**, including real filesystem races and default deadline windows. Commands used the documented node hooks. `git diff --check` passed. Root owns final repository typecheck/test/build.

Removed production-only test support: goal-work observer/gate/counter, timer callbacks in `ClaudeAdapterDeps`, custom deadline fields, and transcript read-size override. Native test mocks control time without altering production scheduling; SDK query and spawn remain genuine external transport interfaces. Lifecycle harnesses now stop their real adapter and drain actual filesystem work after every case, preventing cross-test work from leaking across mocked clocks.

Final reference audit: the shell-tail interval/read deadline, goal transcript read deadline/retry delays and transcript chunk limit now have no external callers. Make these five owner-local constants private; retained tests advance independently documented windows and construct independently sized files.
