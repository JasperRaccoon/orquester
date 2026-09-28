# Workflow daemon wiring seam cleanup addendum

This is implemented cleanup following the workflow engine audit. The dispositions below were recorded before editing. The earlier per-case dispositions in `workflow_engine.md` still cover all original cases; this addendum records five E2E setup rewrites required to remove unused production options.

## Caller audit and failure modes

`apps/daemon/src/index.ts` is the only production caller of `createWorkflowDaemon`. It supplies no `clock`, `triggerClock`, `mintId`, `sandbox`, `limits`, `usesAccount`, `workflowTabRetentionDays` or `random` overrides. Only `workflows/testing/daemon-harness.ts` forwards the clock, trigger clock, sandbox and random options; its E2E callers never supply an alternative sandbox. The other four options have no caller at all.

Remove those eight optional wrapper seams and their forwarding. Use the same existing real engine/trigger clocks, random UUIDs, sandbox runner, limits, account policy from the daemon's router file, seven-day tab retention and poll jitter defaults. Keep the lower-level dependency contracts used by production factory/engine/trigger owners. Tests can control the existing production clock dependencies with Node's scoped `t.mock.method`; no replacement production injection hook is needed. The git E2E similarly mocks native `Math.random` rather than passing a wiring-only override.

Potential failures this E2E coverage owns: account failover reaches the wrong service or loses persisted cooldowns; preview and runtime disagree about unavailable provider models; restart sends an already-receipted command again; a scheduler never publishes/fires its configured schedule; a poller loses its baseline, fires duplicate pushes, or hides poll failures. The lower owner tests cannot prove the real wiring and persisted run/store/routes cooperate for those failures.

## Per-case disposition

| Disposition | Path and original test | Exact expected behavior |
| --- | --- | --- |
| REWRITE | `apps/daemon/src/workflows/e2e-agent.test.ts` — a usage limit switches accounts in the same session, then hands off across families | A1→A2 preserves one Claude session; crossing to Codex creates another, carries previous text, persists cooldowns, and returns Codex's final result. |
| REWRITE | `apps/daemon/src/workflows/e2e-agent.test.ts` — the host catalogue: unknown agents and models are validation problems, and the preview passes over them | Public validation returns unknown-agent/model codes, refuses enable, and selects the next runnable account in preview. |
| REWRITE | `apps/daemon/src/workflows/e2e-agent.test.ts` — a restart while the agent works resumes the watcher and never sends the turn twice | Persisted watching state resumes after boot with one provider turn command and the complete final response. |
| REWRITE | `apps/daemon/src/workflows/e2e.test.ts` — nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows | A five-minute UTC schedule exposes 12:05, runs with that scheduled instant, and persists/exposes 12:10 afterward. Advance the actual trigger watcher clock before waiting for its rail publication. |
| REWRITE | `apps/daemon/src/workflows/e2e.test.ts` — the poller baselines, fires once on a push, and a failing poll shows on the rail | Baseline creates no run, changed SHA creates one run with old/new SHAs, and a later authentication failure reaches rail state without another run. |

All six retention bars for each row: (1) automated-workflows design §§5.4–5.8 and trigger sections specify the named public workflow behavior; (2) the row states a distinct wrong selection, duplicated action, missing schedule/push or lost persisted/public state; (3) expectations are supplied account IDs, timestamps, protocol codes and fixed input/output data, not production calculations; (4) tests act through real HTTP/MCP-compatible workflow routes with real stores and runtime wiring, observing public replies, event stream and durable run records; (5) private wiring can refactor without changing those outcomes, while only platform clock/random dependencies are controlled; (6) this E2E seam uniquely proves these components are connected and resume from actual disk state. Provider/network fakes supply external responses, not the workflow behavior asserted. Every boot leaves a verifiable `results.json` artifact through the shared daemon harness.

Risk: low for removed unused options; moderate for test clock migration because provider and engine must share the same test time and trigger ticks must not move real child-process clocks. Clock mocks are scoped to each test and restored by Node. No behavior assertions are removed.

Also remove orphan option comments in `routes.ts` and `sweepers.ts`.

## Validation

From `apps/daemon`:

`pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/workflows/e2e.test.ts src/workflows/e2e-agent.test.ts src/workflows/e2e-mcp.test.ts`

Result: **11 tests passed**, zero failed/skipped/cancelled, 19.1 seconds. Each harness close printed its retained `orq-workflow-evidence-*/results.json` artifact. Scoped `git diff --check` passed and the final production diff was reviewed: only unused option fields/forwarding and stale comments were removed; runtime values and callbacks are unchanged. The root audit runs the integrated daemon/repository typecheck and remaining gates.
