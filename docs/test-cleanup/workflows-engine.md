# Workflow engine test cleanup audit

Status: cleanup implemented, with dispositions recorded before editing and validation below. Audited 222 original tests across 23 files: 7 DELETE, 15 REWRITE, 200 KEEP; 215 remain. Test code decreased by 399 lines; production/support cleanup removed another 106 net lines.

Scope: every original test in workflows top level, nodes, sandbox and git-remote; agent and triggers subdirectories belong to another audit. Parameter loops are recorded under their declared test title.

Independent specification: `docs/superpowers/specs/2026-09-28-automated-workflows-design.md` (section references below), public API/config contracts, AGENTS.md security/storage rules, and specifically described crash regressions. Current source was checked rather than assuming the design matches every detail.

Six-bar key for every retained/reworked row: **B1** the file contract and per-case failure below; **B2** that failure changes a returned value, persisted artifact, process lifetime, security result or public event; **B3** fixed input/literal expected outcome shown in each row, never an expectation computed by the implementation; **B4** the production seam listed per file; **B5** assertions use contract state/output/IO rather than source, markup or private identifier/call inventory; **B6** the lowest distinct owner and stronger-coverage comparison listed below. The exceptions explicitly explain the narrowed seam.

Validation command prefix (from apps/daemon): `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2`. Append each `src/workflows/<file>` below for its focused check. Repository gates are coordinated by the root agent.

## `apps/daemon/src/workflows/e2e-agent.test.ts`

**B1 independent contract:** §5.8 agent command persisted-before-POST and resume exactly once. **Source reviewed:** daemon-wiring.ts, engine.ts, agent/executor.ts.
**B4 stable seam / non-test callers:** Real workflow routes/stores restarted over one appdir; host protocol fake; index.ts workflow daemon wiring.
**B6 remaining stronger coverage:** Only retained E2E proves frozen persisted agent wait state is restored by actual runtime/store wiring; lower executor resume tests use context fakes.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L71 | a usage limit switches accounts in the same session, then hands off across families | Repeats account switching, cross-family handoff, cooldown and selection matrices through a fake chat host. These outcomes are owned by agent/failover.test.ts and agent/select.test.ts; the retained persisted restart E2E covers daemon agent wiring. Remaining owner: agent/failover.test.ts, agent/select.test.ts. Risk: low; no unique behavior removed. |
| DELETE L159 | the host catalogue: unknown agents and models are validation problems, and the preview passes over them | Repeats catalogue rejection and preview selection with a fake catalogue at an additional layer. Remaining owner: agent/validation-catalog.test.ts, agent/failover.test.ts and API validate tests. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/e2e-mcp.test.ts`

**B1 independent contract:** §8.2 and docs/orquester-mcp.md workflow tooling. **Source reviewed:** mcp/tools/workflows.ts, mcp/server.ts, routes.ts + real runtime.
**B4 stable seam / non-test callers:** Public MCP JSON-RPC tools/call → real daemon stores; MCP client tools.
**B6 remaining stronger coverage:** Retained minimal-draft validation catches fake-daemon schema disagreement; run(wait)/read proves real event-bus wait and persisted output.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| REWRITE L67 | the Jira fixer: create by names, read, edit with ops, list by project, refusals named by index | Retain only validation of the actual published create/edit example through real MCP and service, with fixed zero-error and disabled-state expectations. The MCP owner is removing its fake business logic and no longer checks this example. Delete duplicated CRUD, list, conflict and refusal matrix. B1: published authoring guide; B2: unusable example fails; B3: valid/disabled expected independently of fixture construction; B4: tools/call; B5: content validity across refactors; B6: sole real guide-consumer validation. |
| REWRITE L156 | run_workflow waits on the bus for a real run; runs, outputs, secrets and cancel round-trip | Keep the real MCP run(wait) → run history/output round trip and persisted output artifact; remove duplicated IF/shell/secret/overlap/cancel matrix owned by engine, routes, and MCP tests. B1: public MCP run(wait)/output contract; B2: an early wait result or missing persisted output fails; B3: fixed input 21 must produce 42, completed state succeeded; B4: tools/call; B5: no private engine shape; B6: only retained real MCP→runtime wait integration. |

## `apps/daemon/src/workflows/e2e.test.ts`

**B1 independent contract:** §2 daemon wiring; §5.6–5.8, §6, §8.1 critical workflow integrations. **Source reviewed:** daemon-wiring.ts, factory.ts, routes.ts and real stores/sandbox.
**B4 stable seam / non-test callers:** Real workflow routes and bus over temporary appdir; index.ts createWorkflowDaemon wiring.
**B6 remaining stronger coverage:** Retained manual pipeline, detached-process restart, schedule and git dispatch prove production wiring with persisted run/state artifacts; unit stores cannot prove these integrations.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L387 | cancels its active runs and deletes its runs, secrets and the temp projects failed runs kept | Replays cascade policy with a mock DELETE endpoint that records names but never removes the project; cannot prove the advertised filesystem cleanup. Real storage cascade and engine cancellation/retention owners cover the policy. Remaining owner: routes.test.ts deletion cascade; engine.test.ts deletion; services.test.ts sweepers. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/engine-fixes.test.ts`

**B1 independent contract:** §5.7–5.10; AGENTS.md persistence, redaction and prototype containment; named race regressions. **Source reviewed:** engine.ts and nodes/http.ts/process.ts/code.ts.
**B4 stable seam / non-test callers:** WorkflowEngine operations, persisted records and actual fetch boundary; daemon-wiring.ts, routes.ts.
**B6 remaining stronger coverage:** Each retained case supplies a distinct crash/security failure absent from ordinary engine happy paths.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L56 | setWaitingOn rejects once the engine stopped | Tests the internal context exception rather than the forbidden POST; adjacent retained POST-after-stop regression proves that no side effect happens and restart sends it once. Remaining owner: engine-fixes.test.ts HTTP POST after stop. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/engine-resume.test.ts`

**B1 independent contract:** §5.8; AGENTS.md persist-before-side-effect/idempotent command rules. **Source reviewed:** engine.ts, nodes/process.ts/http.ts/wait.ts/subworkflow.ts.
**B4 stable seam / non-test callers:** WorkflowEngine stop/resume over PersistedRun records; daemon-wiring.ts startup/shutdown.
**B6 remaining stronger coverage:** Distinct interrupted-record states below the restart E2E; E2E cannot exhaust retry, HTTP safety and damaged records.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| REWRITE L259 | queued runs start after a restart; a run whose definition cannot be read is marked interrupted | Rewrite: Fill the actual four-run cap before restart; keep queued recovery and unreadable-record behavior without limit injection. Oracle evidence: assert.equal((await env.shared.runStore.load(b.runId!))!.status, "queued");; assert.equal(resultA.status, "failed", "A's code block was cut by the restart (no retry)"); |

## `apps/daemon/src/workflows/engine.test.ts`

**B1 independent contract:** §3.2–3.4, §5.7–5.11, §7.6. **Source reviewed:** engine.ts + node executors.
**B4 stable seam / non-test callers:** WorkflowEngine run/fire/testNode/cancel, public run results and broadcaster payloads; routes.ts, factory.ts, scheduler/poller via TriggerHost.
**B6 remaining stronger coverage:** Engine scheduling is the lowest owner: API graph tests compute readiness but cannot prove executor admission, lifecycle or persisted outcomes.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| REWRITE L226 | an agent waiting for a usage reset (kind agent, phase waiting-reset) reads waiting and resumes as such | Rewrite: Remove irrelevant test-only concurrency override; preserve waiting/running state behavior. Oracle evidence: assert.equal(block.status, "waiting");; assert.equal(block.waitingUntil, "2026-09-28T12:00:00.000Z"); |
| REWRITE L386 | a big output goes to a file with an inline preview; downstream and nodeOutput read it whole | Rewrite: Exercise the actual 64 KiB preview contract with 100 KiB output, removing the test-only limit override. Oracle evidence: assert.equal(run.blocks.A!.outputTruncated, true);; assert.equal(typeof run.blocks.A!.output, "string"); |
| REWRITE L409 | an output over the hard cap fails the block with limit_exceeded | Rewrite: Exercise the actual 16 MiB output cap instead of injecting a smaller test cap. Oracle evidence: assert.equal(run.blocks.A!.error?.kind, "limit_exceeded");; assert.equal(result.status, "failed"); |
| REWRITE L494 | a block that ignores its abort cannot hold a cancelled run forever | Rewrite: Advance the fake clock through the actual 30 s shutdown grace; remove test-only grace override. Oracle evidence: assert.equal(result.status, "cancelled");; assert.equal((await h.engine.getRun(runId!))!.blocks.A!.status, "cancelled"); |
| REWRITE L575 | the global run cap queues runs beyond it, FIFO | Rewrite: Use the specified four-run capacity and an additional queued run; remove production limit injection. Oracle evidence: assert.equal(code.calls.length, 2);; assert.equal(waiting.status, "queued"); |
| REWRITE L598 | a queued run can be cancelled before it starts | Rewrite: Fill the actual four-run capacity before cancelling the next run; remove production limit injection. Oracle evidence: assert.equal(await h.engine.cancel(b.runId!), true);; assert.equal(result.status, "cancelled"); |
| REWRITE L609 | agent blocks and sandbox processes wait behind their global caps | Rewrite: Use the actual four-agent/eight-process capacities and one extra of each; remove production limit injection. Oracle evidence: assert.equal(agent.calls.length, 1);; assert.equal(code.calls.length, 1); |
| REWRITE L637 | an agent block's timer wait releases its slot; waking takes it back | Rewrite: Fill the actual four-agent pool; prove a waiting block frees capacity and reacquires it; remove production limit injection. Oracle evidence: assert.equal(agent.calls.length, 1);; assert.equal(agent.calls.length, 2, "the other agent block got the slot"); |
| REWRITE L895 | the depth limit and cycles are refused at run time | Rewrite: Exercise six child levels against the specified depth-five cap rather than a private override. Oracle evidence: assert.equal(run.status, "failed");; assert.equal(bRun.blocks.S!.error?.kind, "limit_exceeded"); |
| REWRITE L931 | child runs bypass the global run cap (no deadlock) | Rewrite: Use a five-run parent/child chain to exceed the real four-run cap without an injected override. Oracle evidence: assert.equal(result.status, "succeeded"); |

## `apps/daemon/src/workflows/git-remote/clone-ref.test.ts`

**B1 independent contract:** §5.10 clone branch/tag/SHA semantics; git external CLI protocol and input safety. **Source reviewed:** clone-ref.ts.
**B4 stable seam / non-test callers:** clone ref validation, git argv and ls-remote parsing; accounts.ts cloneRepo; index.ts clone request validation.
**B6 remaining stronger coverage:** External git argv is a stable protocol, not private collaborator shape; Accounts owner confirmed no equivalent successful branch/tag/full-SHA case.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| REWRITE L16 | cloneRefProblem accepts branches, tags and shas | Rewrite: Use literal boundary fixture instead of importing the implementation maximum; remove test-only constant export. Oracle evidence: assert.equal(cloneRefProblem(ok), null, ok); |
| REWRITE L22 | cloneRefProblem refuses empty, long, option-like, whitespace and control characters | Rewrite: Use literal 251-character oversized input independent of the implementation maximum; retain option/control rejection. Independent oracle: empty strings, 251 characters, leading options, whitespace/control bytes and non-string inputs all return a validation problem. |

## `apps/daemon/src/workflows/git-remote/ls-remote.test.ts`

**B1 independent contract:** §6.2 git ls-remote protocol, annotated tags, SHA-256 and prototype safety. **Source reviewed:** ls-remote.ts.
**B4 stable seam / non-test callers:** parseLsRemote text protocol; accounts.ts remote listing, git-poller.ts.
**B6 remaining stronger coverage:** Only parser owner protects these raw provider byte forms; poller fakes receive already parsed maps.

## `apps/daemon/src/workflows/git-remote/remote-url.test.ts`

**B1 independent contract:** §6.2 repository identity/provider URL forms; AGENTS.md host-only credentials. **Source reviewed:** remote-url.ts.
**B4 stable seam / non-test callers:** public URL validation/key/display/sanitization helpers; accounts.ts, triggers/git-poller.ts and repo-resolve.ts.
**B6 remaining stronger coverage:** Only daemon remote owner covers SSH aliases/DC contexts, unsupported transports and URL userinfo sanitization; API display helper is separate UI-only formatting.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L112 | redactUrlUserinfo hides a token user in http(s) text and a password anywhere, keeps ssh logins | Fixed oracle: HTTP token usernames and username/password become `***`; `ssh://git@github.com/o/r` and text without a URL stay intact. A token in a Git diagnostic must never be returned to the caller. |

## `apps/daemon/src/workflows/integration.test.ts`

**B1 independent contract:** §3.2, §4, §5.6–5.9 executor output/error/security contracts. **Source reviewed:** nodes/code.ts/shell.ts/http.ts/process.ts + sandbox.
**B4 stable seam / non-test callers:** WorkflowEngine results with real local HTTP and subprocess IO; factory.ts registered node executors.
**B6 remaining stronger coverage:** Retained cases own executor translation (timeout/exit_code/http_status), shell env safety and actual cancellation; lower sandbox tests do not assert workflow errors.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L41 | a code block reads its context and secrets; the secret is redacted from its output | Repeats context transport and redaction between the real sandbox test and retained manual pipeline E2E; suffix and log-size assertions add implementation shape. Remaining owner: sandbox/sandbox.test.ts; engine.test.ts redaction; e2e.test.ts manual pipeline. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/nodes/nodes.test.ts`

**B1 independent contract:** §4 Wait timezone and §3.2/§5.9 shell output tails. **Source reviewed:** nodes/wait.ts and nodes/shell.ts.
**B4 stable seam / non-test callers:** WorkflowEngine outcomes over real executors; nodes/index.ts registered executors.
**B6 remaining stronger coverage:** Distinct timezone precedence and real shell-tail cap are not covered by UTC-duration resume or raw sandbox log cap.

## `apps/daemon/src/workflows/nodes/regex-worker.test.ts`

**B1 independent contract:** §4 bounded regex execution; §5.7 no secret prefix leakage. **Source reviewed:** nodes/regex-worker.ts and API rules.ts.
**B4 stable seam / non-test callers:** RegexMatcher match; evaluateRulesAsync output/warnings; nodes/flow.ts; agent rules consumers.
**B6 remaining stronger coverage:** Actual worker responsiveness/recovery cannot be proved by mocked matcher API tests; API owner confirmed clipping regression is unique.

## `apps/daemon/src/workflows/routes.test.ts`

**B1 independent contract:** §8.1 HTTP protocol; AGENTS.md secret/transport boundaries. **Source reviewed:** routes.ts.
**B4 stable seam / non-test callers:** Fastify HTTP injection; deleteWorkflowCascade is the daemon deletion owner; index.ts registers routes; API client/MCP invoke routes.
**B6 remaining stronger coverage:** HTTP status/body/header mapping, unavailable-engine fallback, request limits and cascade are owned here; store tests cannot assert transport behavior.

## `apps/daemon/src/workflows/run-store.test.ts`

**B1 independent contract:** §5.8 durable run records, index, retention and output files; AGENTS.md containment. **Source reviewed:** run-store.ts.
**B4 stable seam / non-test callers:** FileRunStore public methods and files read by a fresh store; engine.ts, routes.ts, daemon-wiring.ts, sweepers.ts.
**B6 remaining stronger coverage:** Real filesystem and index semantics cannot be proved by in-memory engine fakes.

## `apps/daemon/src/workflows/sandbox/log-reader.test.ts`

**B1 independent contract:** §5.6–5.7, §7.3 byte-positioned, UTF-8-safe, redacted logs. **Source reviewed:** log-reader.ts and redact.ts byteMatches.
**B4 stable seam / non-test callers:** readLogWindow/followLog over real growing files; routes.ts; nodes/shell.ts.
**B6 remaining stronger coverage:** Only owner of offset-inside-secret, tiny windows, incomplete UTF-8 and abort semantics; route tests validate HTTP headers/transport instead.

## `apps/daemon/src/workflows/sandbox/redact.test.ts`

**B1 independent contract:** §5.7 literal, nested secret redaction. **Source reviewed:** redact.ts.
**B4 stable seam / non-test callers:** createRedactor text/value; engine.ts, nodes/http.ts/shell.ts, routes.ts, agent/secret-text.ts.
**B6 remaining stronger coverage:** Retained literal/deep/overlap cases own redaction itself. Deleted string streaming had no production caller; actual byte-window streaming stays in log-reader tests.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L8 | text: every value ≥ 4 chars, longest first | Fixed oracle: `tok-12345`, `tok-12345-extended`, and `9876` become their named secret placeholders; three-character `abc` stays intact. Matching the shorter token inside the longer one would leak its suffix and fail. |
| KEEP L16 | value: deep through arrays and objects, values only | Fixed nested-object oracle replaces string values with named placeholders while preserving the `tok-12345` object key, numbers, null, booleans and the original input. A nested secret leak or destructive mutation fails. |
| DELETE L46 | every two-chunk split replaces complete secrets with their placeholders | Exercises an unused string-stream API. Production log streaming uses readLogWindow/followLog byte offsets, not createChunkRedactor. No non-test callers. Remaining owner: sandbox/log-reader.test.ts split-window and live-tail redaction. Risk: low; no unique behavior removed. |
| DELETE L54 | one character at a time never emits part of a secret | Only keeps the dead SecretRedactor.stream helper alive; no production caller. The actual byte-window reader retains split-secret security coverage. Remaining owner: sandbox/log-reader.test.ts. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/sandbox/sandbox.test.ts`

**B1 independent contract:** §5.6–5.9 subprocess protocol, process ownership, env security and detached resume. **Source reviewed:** sandbox.ts, runner.mjs, code-host.mjs, proc.ts, env.ts.
**B4 stable seam / non-test callers:** SandboxRunner API against native child processes and durable files; nodes/process.ts; factory.ts.
**B6 remaining stronger coverage:** Lowest native process owner; engine fakes do not prove signals, grandchildren, serialization, env filtering or PID identity.

## `apps/daemon/src/workflows/secrets.test.ts`

**B1 independent contract:** §5.7 host-only scoped secrets; §3.1 tolerant storage; AGENTS.md no secret leakage. **Source reviewed:** secrets.ts.
**B4 stable seam / non-test callers:** WorkflowSecretsService public writes/lists/resolve and disk files; routes.ts, engine.ts, daemon-wiring.ts.
**B6 remaining stronger coverage:** Store permissions, shadowing and recovery are distinct from route response redaction.

## `apps/daemon/src/workflows/service.test.ts`

**B1 independent contract:** §3.1 and §8.1 workflow storage/revision contracts. **Source reviewed:** service.ts.
**B4 stable seam / non-test callers:** WorkflowService public operations, reload, disk records and lifecycle events; routes.ts, daemon-wiring.ts, engine.ts.
**B6 remaining stronger coverage:** This owner enforces writes/revision/enable policy; parser tests alone cannot prove durable mutation or publication.

## `apps/daemon/src/workflows/services.test.ts`

**B1 independent contract:** §5.3, §5.9–5.11 project addressing, prompt timezone, notifications, resource admission and retention. **Source reviewed:** projects.ts, prompt-renderer.ts, notifier.ts, scheduler-queue.ts, sweepers.ts.
**B4 stable seam / non-test callers:** ProjectOps/PromptRenderer/WorkflowNotifier/SlotPool/WorkflowSweepers contracts; factory.ts and engine.ts; DaemonApi routes for projects/tabs.
**B6 remaining stronger coverage:** Each row owns its distinct adapter/policy result; external services supply input, not selection, eligibility, redaction or retention logic.

## `apps/daemon/src/workflows/state-store.test.ts`

**B1 independent contract:** §3 runtime-state separation and §5.8 durable recovery; cache contract in state-store.ts API. **Source reviewed:** state-store.ts.
**B4 stable seam / non-test callers:** WorkflowStateStore update/get/load and fresh-instance disk reads; scheduler.ts, git-poller.ts, agent/cooldowns.ts.
**B6 remaining stronger coverage:** Only this suite owns immediate visibility, snapshots and concurrent durable state mutation; parser tests do not exercise I/O.

## `apps/daemon/src/workflows/storage-fixes.test.ts`

**B1 independent contract:** AGENTS.md unknown-field preservation and prototype safety; §3.1/§5.8; pending-save index regression. **Source reviewed:** config/workflows.ts, API validate.ts, secrets.ts, run-store.ts.
**B4 stable seam / non-test callers:** Public config parse/validation APIs and real persistent stores; WorkflowService, engine.ts, routes.ts.
**B6 remaining stronger coverage:** Config/API owner confirmed no duplicate nested-field/prototype matrix; the index race uniquely reopens while run write is pending.

## `apps/daemon/src/workflows/summary.test.ts`

**B1 independent contract:** §5.11 notification settings and §7.1/§8.1 WorkflowSummary wire contract. **Source reviewed:** summary.ts.
**B4 stable seam / non-test callers:** buildWorkflowSummary result; routes.ts, daemon-wiring.ts; UI notification consumers.
**B6 remaining stronger coverage:** Only summary owner test checks notify reaches open clients; notifier tests cover push policy instead.

## Completed production/support cleanup

- Removed unused string-stream redaction API and helpers (`SecretRedactor.stream`, `maxSecretLength`, `ChunkRedactor`, `createChunkRedactor`, `redactChunk`, `redactPrefix`) and barrel exports. Whole-text/deep/byte-window redaction remain production-used. Repository search found no non-test string-stream callers.
- Removed test-only engine limit overrides from WorkflowEngineOptions, factory and test harness. Tests exercise real documented limits instead. No production caller supplied a limits override.
- Removed unused factory sandbox/mintId overrides: daemon-wiring is the sole runtime factory caller and supplies neither; retained its actual shared clock dependency.
- Internalized MAX_CLONE_REF_LENGTH after tests stopped importing it.
- Removed imports and local fixtures only used by deleted scenarios, including the unused MCP E2E workspace. Shared daemon harness remains required by retained E2Es.
- Removed unused sandbox environment overrides (`SandboxEnvInput.processEnv`, `launchId`, and `defaultSandboxTmpDir`'s parameter). Repository-wide callers use only the real process environment and a fresh launch UUID. The real sandbox environment isolation test remains the behavior owner; risk is low because production invocation stays identical.
- Removed unused daemon E2E fake Git call recording and the two account fixtures used only by deleted failover/catalogue scenarios. The separate trigger-test fake retains its protocol assertions.

## Validation and final review

- Before edits, the focused baseline E2E-agent, E2E-MCP, integration, engine-fixes and redactor run passed all 34 tests. No retained baseline failure was deleted.
- After cleanup, focused engine, engine-resume, engine-fixes, redactor, log-reader and clone-ref checks passed all 93 tests.
- The complete owned scope passed all 215 tests, 37 suites, with no failures, cancellations or skips: run the command prefix above with `src/workflows/*.test.ts src/workflows/nodes/*.test.ts src/workflows/sandbox/*.test.ts src/workflows/git-remote/*.test.ts`.
- Retained E2Es emitted real persisted artifacts, including `/var/lib/orquester/tmp/orq-workflow-evidence-qeK2N4/results.json` and `/var/lib/orquester/tmp/orq-workflow-evidence-467G33/results.json`. These host-local verification artifacts are not committed.
- The final MCP E2E rerun after removing its unused workspace fixture passed all 3 tests, with evidence at `/var/lib/orquester/tmp/orq-workflow-evidence-Mxa2dW/results.json`.
- `git diff --check` passed. Final production and test diff reviewed; unused-import scan found none in modified owned files. No production caller used any removed override/export. No production behavior change was needed and no coverage/count gate blocked cleanup.
- The first daemon typecheck exposed a missing explicit response-array type in the rewritten FIFO test, which was fixed; it also observed concurrent agent-profile edits outside this scope. The final `pnpm --filter @orquester/daemon typecheck` had no workflow errors and failed only on concurrent `agent-host/adapters/codex/replay.test.ts:400,402` missing `RuntimeEvent`. This was reported to the coordinator. Root owns required repository-wide gates and commit/push.
