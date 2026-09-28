# Host scheduling seam cleanup

This is an implemented supplement to `host-goals.md`, `host-orchestrator.md`, and `host_orchestration.md`, which contain the per-case behavioral dispositions. Recorded before editing the timer seams.

## Callers and decision

- DELETE `OrchestratorOptions.setTimer` / `.clearTimer` in `apps/daemon/src/agent-host/orchestration/orchestrator.ts`: no production caller overrides them. The orchestration harness and Codex integration harness were their only callers. Use the existing native `setTimeout(...).unref()` / `clearTimeout` behavior directly.
- DELETE `TurnWatchdogOptions.setTimer` / `.clearTimer` in `turn-watchdog.ts`: the orchestrator only forwarded the above defaults, and the unit harness supplied a bespoke wheel. Native time control tests the same scheduling behavior without a production injection hook.
- DELETE `TestHost.timers`, `createTestTimers`, and `TestTimers` after the separate stream/Codex owners migrate their remaining consumers. Keep the independent clock seam: production services consume it for event timestamps and deadline decisions.
- REWRITE timing setup in `goals.test.ts`, `goal-hold.test.ts`, `orchestrator.test.ts`, `fix-wave.test.ts`, and `turn-watchdog.test.ts` to Node's native mock timers. Replace timer-pending probes with consumption of actual runtime events. Each case retains its original caller-visible assertion and its independently specified deadline.

## Retained timing contract and six-bar justification

The exact case names and outcomes are enumerated in the owning reports above. This supplement changes scheduling setup only. Their independent requirements are agent-host spec §3.1 (observable progress, 10-minute silent and 30-minute open-tool deadlines, user-card pause), goal spec §5.2 (60-minute active-goal silence), and goal spec §5.7 (120-second renewable handover hold, conditional release, stopping/user-action precedence).

1. These deadlines and precedence rules are specified independently of the timer implementation; expected values remain literal spec values or the existing independently audited behavioral assertions.
2. A cancelled user request, never-cancelled stalled turn, prematurely resumed goal, lost handover mark, or resume during shutdown fails the cases through adapter commands, persisted heads, or public summaries.
3. Expectations are literal elapsed time and resulting caller-visible state, never a timer callback count or timer map inspection.
4. Watchdog cases use its production owner API; orchestration cases use commands, consumed runtime events, persisted records, and adapter protocol effects. Native mock timers replace process time rather than adding a production hook.
5. No assertion depends on timer handles, timer count, wheel ordering, or internal callback shape. Equivalent scheduling refactors preserve outcomes.
6. Watchdog tests own the policy; orchestration cases protect the separate wiring and handover races the isolated policy cannot observe. Existing parent reports identify/deleted duplicate policy cases.

Unit failure modes: starting the watchdog before progress; choosing the wrong silence window; cancelling a user-held request; failing to reconsider a changed goal; keeping a timer after completion; failing to release an expired hold; extending an unrenewed lease; resuming after user intervention or shutdown.

Risk: native timers also advance bounded provider deadlines, unlike the old partial wheel. If a scenario relied on contradictory elapsed times it must use a real ordering and continue to assert the protocol contract. Production timer delays, unref behavior, and cancellation remain unchanged.

Validation planned: focused daemon tests for watchdog, goals, goal-hold, fix-wave, and orchestrator with the repository's tsx/assert-ok/quiet-mock-timers hooks; daemon typecheck; root runs full gates.

## Affected timing scenarios

All rows are REWRITE of scheduling setup only under the six-bar contract above; their individual outcomes and remaining-owner analysis stay in the original owning audit. Other cases in the same files retain those original dispositions.

| Path | Case |
| --- | --- |
| `apps/daemon/src/agent-host/orchestration/goals.test.ts` | finding 2: a turn Codex starts by itself for a host /goal is watched, and cancelled on silence |
| `apps/daemon/src/agent-host/orchestration/goals.test.ts` | finding 2: a replayed turn.started never arms one |
| `apps/daemon/src/agent-host/orchestration/goals.test.ts` | finding 3: a goal that ends mid-turn gives the silence the normal window, not the hour |
| `apps/daemon/src/agent-host/orchestration/goals.test.ts` | a pause that hangs is given up after its deadline, and Stop goes on |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a pause that hangs is given up after its deadline, holding nothing |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | resumes a held goal that still reads paused, and clears both marks |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a renewal pushes the end back: the timer waits out the remainder |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | resumes nothing for a goal achieved, cleared, blocked or limited during its final turn |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a resume that fails says so on the timeline, the marks go anyway, and the goal stays paused |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a resume the provider refuses in words puts those words on the timeline |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | the release brings back a provider that died while the goal was held, then resumes it |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a held session that cannot be brought back is a failed resume, said on the timeline |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | the release starts no session for a goal that ended meanwhile |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a session the release starts after a stop began is stopped again, and the mark is kept |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | …even while the pause's own update trails: the release asks the provider, which holds the goal paused |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a stop that cuts the hold's pause short keeps the thread held; aborted, the lease's end asks the provider |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a release still queued when a stop begins resumes nothing and keeps the mark |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a stop that begins while the provider answers the release keeps the mark |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a stop under way suspends the lease; an aborted stop brings it back |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | /goal pause: the hold goes, nothing is resumed, and the goal stays paused |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | /goal resume: the goal goes again, renewals leave it alone, and a new lease holds it |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a session stop: the hold goes with the session, and nothing is resumed |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | deleting the thread: nothing is held any more, and nothing is resumed |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | /goal status reads the goal and keeps the hold: a read must not cancel the promised resume |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a held goal the host has set going again is no longer held: the pause advice is back |
| `apps/daemon/src/agent-host/orchestration/goal-hold.test.ts` | a pause that lands after its deadline is adopted as a hold — mark, then row |
| `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` | a question an earlier turn raised keeps a turn the provider started from being cancelled; closed, a quiet turn is |
| `apps/daemon/src/agent-host/orchestration/fix-wave.test.ts` | the resumed turn has a liveness bound like any other |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | does not arm until the protocol produces observable progress |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | cancels a turn that goes silent for the idle window |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | widens to the tool window while a tool call is open |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | is paused entirely while an approval is open |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | re-checks the pause immediately before cancelling |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | never stalls a turn while the thread holds a card waiting on the user — even one an earlier turn raised |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | stops on turn completion |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | a card the user holds under an active goal: looked at again a normal window later, and the goal's window names the stall |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | while a goal is active a silent turn is not cancelled at the idle window |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | a goal that turns active after the timer was armed is honoured when it fires |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | a goal that ends while the timer is armed cancels at the normal window, not the hour |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | the goal window is re-checked at every normal window, so it holds while the goal does |
| `apps/daemon/src/agent-host/orchestration/turn-watchdog.test.ts` | is still paused entirely while an approval is open |

## Completed validation

- `cd apps/daemon && node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/agent-host/orchestration/turn-watchdog.test.ts src/agent-host/orchestration/goals.test.ts src/agent-host/orchestration/goal-hold.test.ts src/agent-host/orchestration/fix-wave.test.ts`: **151 passed, zero failures**.
- Same hooks with `src/agent-host/orchestration/orchestrator.test.ts`: **101 passed, zero failures** after the owning agent completed two concurrent checkpoint assertions.
- Repository-wide source search confirms no remaining `createTestTimers` / `TestTimers` references and no timer injection in orchestration. Stream and Codex owners validated their migrated consumers independently.
- `git diff --check` for this scope passed. Initial daemon typecheck was interrupted by concurrent `supervisor.test.ts` syntax edits; final repository gates are recorded by the coordinator.

All native calls retain the previous production behavior: watchdog and goal-hold timeouts remain unreferenced, cancellation still clears the active native handle, and no elapsed-time windows changed in this supplement. No replacement test cases were added.
