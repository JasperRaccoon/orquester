# Process cleanup seam follow-up

This implements the final support-seam cleanup after the case audit in `host_ingestion_support.md`. Before edits, the complete owner, both test files, Grok's real teardown callers, and the independent process ownership contract in GUI design §3.1 and `agent-host/README.md` were read.

Failure modes of this isolated OS owner: selecting another launch, selecting a daemon that escaped into a new session, treating a recycled session/PID as owned, losing marked members after a leader exits, missing descendants created during termination, escalating before the grace expires, waiting on zombies, touching `/proc` on another platform, and forgetting durable work before the appropriate launches were swept. Literal Linux stat/environment bytes and explicit signal outcomes define the expectation; the mock filesystem must never calculate ownership or implement the sweep.

The six optional process/time/platform overrides and exported `ProcSource`/`PROC` have no production consumers. `graceMs` survives: Grok's teardown supplies its real shorter shutdown grace. `parseStat` remains exported because `workflows/sandbox/proc.ts` uses it. The existing `support/leftover-work.ts` forwarding type automatically narrows with the stop options; no algorithm change is needed there.

Common six-bar justification for the retained rewritten process cases: (1) §3.1 independently requires marker AND recorded-session ownership, start-time identity, and SIGTERM then grace-bounded SIGKILL; (2) the specific failure below is an observable wrong process selection/signal or shutdown delay; (3) expected PIDs/signals/states are fixed by the fixture, not calculated by production; (4) the action is the real exported process cleanup API, with only native filesystem/process/clock boundaries intercepted; (5) no private source object, overridden implementation, read-count oracle, or injected poll interval remains; (6) this is the lowest owner that can deterministically stage kernel PID/session races, while the real process-tree integration owns actual Linux signaling. No stronger remaining test subsumes a listed race.

| Original test in `support/leftover-processes.test.ts` | Final disposition before edits | Exact failure / remaining owner |
|---|---|---|
| finds exactly the processes of a recorded session carrying this launch's marker | REWRITE | Literal raw `/proc` environment/stat data must select only 100 and 101; catches wrong launch, prefix match, escaped daemon and self-selection. Real process-tree test cannot deterministically cover malformed marker variants. |
| a recycled session id is not ours: its live leader must be the process recorded | REWRITE | Recorded start time 10 must reject the new leader at 20 and its member; no other case has session-ID reuse. |
| a member whose leader is gone is still its session's | REWRITE | Marked member 131 remains owned despite missing leader 130; avoids leaked orphan work. |
| a pid recycled while it was being read is not matched | REWRITE | Mutate the kernel fixture after its environment bytes are read; selection must reject the changed start time without asserting private stat call counts. |
| SIGTERM first; SIGKILL only for what outlived the grace, by a fresh scan of the same sessions | REWRITE | Native mock timers verify no early SIGKILL and fresh-scan inclusion of a newly created descendant; the unrelated launch survives. |
| the wait ends as soon as everything is gone — a zombie counts as gone | REWRITE | Terminated/zombie processes complete without advancing the native mock clock or receiving SIGKILL. |
| a pid recycled before its signal is never signalled | REWRITE | Recycle one scanned process when another receives SIGTERM; the reused PID must survive. This stages a signal-time race without a hardcoded third-read hook. |
| off Linux there is no /proc: nothing is read and nothing is signalled | REWRITE | Set the native process platform to Darwin; neither exported action may access `/proc` or signal a PID. |
| an empty launch id matches nothing | REWRITE | An empty marker must never authorize selection, even when a process carries that empty value. |
| recordChildSessions: each child's own session, and the parent's for a child that shares it | REWRITE | Real parser reads fixed kernel records; only direct-child sessions 700/701/702 are recorded, never the grandchild's as a new owner. |
| the real /proc: a recorded session's members are stopped, a daemon and a stranger spared | KEEP | Actual Linux processes prove live ownership and signal effects; only the dead poll override is removed. No fake can replace this kernel integration. |

The previously deleted empty-sweep read-count case remains deleted; ownership and platform no-effect contracts protect its meaningful behavior.

`support/leftover-work.test.ts` has two necessary caller migrations plus its platform case. They retain the prior audit's six bars: the independent persisted-work contract requires every recorded launch to use its own marker/session, erase the record after completion, and sweep multiple launches concurrently. Wrong signals, leaked processes, retained records, or multiplied shutdown grace are caller-visible failures; literal PIDs/counts and actual scratch JSON files are independent oracles. Native OS mocks replace only the kernel and clock; public `recordLeftoverWork`/`sweepLeftoverWork` and real disk persistence remain the stable lowest composition seam. The five other storage tests remain as dispositioned in the original audit.

| Existing persisted-work test | Final disposition before edits | Failure / stronger coverage |
|---|---|---|
| the sweep stops each launch's work by its own marker and sessions — nothing else — then forgets it | REWRITE | Native filesystem/signal fixture must stop 200/201/300, preserve 250/202, then delete the actual scratch record; no lower process test owns launch-file iteration and deletion. |
| a close sweeps every remembered launch at once: one grace window, not one per launch | REWRITE | After one native-clock grace, all eight stubborn launches must finish; sequential sweeping leaves later processes active. |
| a thread with nothing remembered sweeps nothing, and off Linux nothing is read | REWRITE | Use native platform instead of option; preserve empty-result behavior. |

Risk: process tests must intercept `process.kill` before invoking the owner and restore native globals after each case; the real integration retains its isolated child cleanup. All production default durations and statement order remain unchanged. Validation: focused `leftover-processes.test.ts` plus `leftover-work.test.ts` using existing daemon node import hooks, followed by root's integrated gates.

Completed implementation and validation:

- Both process test files use `leftover-processes.testing.ts`, one fixture that serves raw Linux kernel bytes through native `fs/promises` mocks and intercepts native `process.kill`. It contains no launch/session selection or sweep implementation. Named ESM filesystem bindings are refreshed and restored with `syncBuiltinESMExports`; every synthetic test installs the signal interceptor before calling the owner.
- Removed `ProcSource`, exported `PROC`, and `proc`, `kill`, `now`, `sleep`, `platform`, and `pollMs` production overrides. The normal 50 ms poll interval, default grace, Linux gating, start-time checks, signal order, fresh scan, and durable-work sweep order remain unchanged. `graceMs` and `parseStat` keep their real production callers. `leftover-work.ts` needs no source change because its forwarding options narrow automatically.
- The two test files plus their new shared fixture decrease from 644 to 498 lines (net -146, including all new support). No new test case was added. The preexisting DELETE remains deleted; 13 retained cases have necessary native-seam rewrites, the actual `/proc` integration remains, and the other five storage cases remain untouched.
- Focused command from `apps/daemon`: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/agent-host/support/leftover-processes.test.ts src/agent-host/support/leftover-work.test.ts`. Result: **19 passed, 0 failed, 0 skipped**, including the actual Linux process tree. Log: `/tmp/orquester-test-cleanup/host-process-seams.log`.
- Reviewed the full production diff and `git diff --check`; no behavior changes or unresolved scope-specific failures. Root runs the final integrated typecheck/test/build gates after this last source cleanup.
