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
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L71 | a usage limit switches accounts in the same session, then hands off across families | Repeats account switching, cross-family handoff, cooldown and selection matrices through a fake chat host. These outcomes are owned by agent/failover.test.ts and agent/select.test.ts; the retained persisted restart E2E covers daemon agent wiring. Remaining owner: agent/failover.test.ts, agent/select.test.ts. Risk: low; no unique behavior removed. |
| DELETE L159 | the host catalogue: unknown agents and models are validation problems, and the preview passes over them | Repeats catalogue rejection and preview selection with a fake catalogue at an additional layer. Remaining owner: agent/validation-catalog.test.ts, agent/failover.test.ts and API validate tests. Risk: low; no unique behavior removed. |
| KEEP L211 | a restart while the agent works resumes the watcher and never sends the turn twice | Oracle evidence: assert.equal(waitingOn.kind, "agent");; assert.equal(waitingOn.phase, "watching", JSON.stringify(waitingOn)); |

## `apps/daemon/src/workflows/e2e-mcp.test.ts`

**B1 independent contract:** §8.2 and docs/orquester-mcp.md workflow tooling. **Source reviewed:** mcp/tools/workflows.ts, mcp/server.ts, routes.ts + real runtime.
**B4 stable seam / non-test callers:** Public MCP JSON-RPC tools/call → real daemon stores; MCP client tools.
**B6 remaining stronger coverage:** Retained minimal-draft validation catches fake-daemon schema disagreement; run(wait)/read proves real event-bus wait and persisted output.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| REWRITE L67 | the Jira fixer: create by names, read, edit with ops, list by project, refusals named by index | Retain only validation of the actual published create/edit example through real MCP and service, with fixed zero-error and disabled-state expectations. The MCP owner is removing its fake business logic and no longer checks this example. Delete duplicated CRUD, list, conflict and refusal matrix. B1: published authoring guide; B2: unusable example fails; B3: valid/disabled expected independently of fixture construction; B4: tools/call; B5: content validity across refactors; B6: sole real guide-consumer validation. |
| KEEP L114 | validate_workflow: a draft with the placeholders the tool fills in validates on the real route | Oracle evidence: assert.equal(good.valid, true, JSON.stringify(good.problems));; assert.equal(minimal.valid, true, JSON.stringify(minimal.problems)); |
| REWRITE L156 | run_workflow waits on the bus for a real run; runs, outputs, secrets and cancel round-trip | Keep the real MCP run(wait) → run history/output round trip and persisted output artifact; remove duplicated IF/shell/secret/overlap/cancel matrix owned by engine, routes, and MCP tests. B1: public MCP run(wait)/output contract; B2: an early wait result or missing persisted output fails; B3: fixed input 21 must produce 42, completed state succeeded; B4: tools/call; B5: no private engine shape; B6: only retained real MCP→runtime wait integration. |

## `apps/daemon/src/workflows/e2e.test.ts`

**B1 independent contract:** §2 daemon wiring; §5.6–5.8, §6, §8.1 critical workflow integrations. **Source reviewed:** daemon-wiring.ts, factory.ts, routes.ts and real stores/sandbox.
**B4 stable seam / non-test callers:** Real workflow routes and bus over temporary appdir; index.ts createWorkflowDaemon wiring.
**B6 remaining stronger coverage:** Retained manual pipeline, detached-process restart, schedule and git dispatch prove production wiring with persisted run/state artifacts; unit stores cannot prove these integrations.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L98 | every block's status, output, handle and edge; the run persisted; secrets redacted everywhere | Oracle evidence: assert.equal(secret.status, 200);; assert.deepEqual(secret.body.secrets.map((s) => s.name), ["TOKEN"]); |
| KEEP L222 | the runtime stops while a shell block sleeps; a new one over the same appdir resumes it | Oracle evidence: assert.equal(waitingOn?.kind, "process", JSON.stringify(persisted!.blocks.sleep));; assert.equal(stopped!.status, "running"); |
| KEEP L274 | nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows | Oracle evidence: assert.equal(written.workflow.enabled, true);; assert.equal(listed.body.workflows.find((w) => w.id === workflowId)!.triggers[0]!.nextRunAt, "2026-09-28T12:05:00.000Z"); |
| KEEP L327 | the poller baselines, fires once on a push, and a failing poll shows on the rail | Oracle evidence: assert.equal(h.state.get().git[`${workflowId}:push`]!.baselined, true);; assert.equal(h.events.filter((e) => e.type === "workflowRun.started").length, 0, "a baseline fires nothing"); |
| DELETE L387 | cancels its active runs and deletes its runs, secrets and the temp projects failed runs kept | Replays cascade policy with a mock DELETE endpoint that records names but never removes the project; cannot prove the advertised filesystem cleanup. Real storage cascade and engine cancellation/retention owners cover the policy. Remaining owner: routes.test.ts deletion cascade; engine.test.ts deletion; services.test.ts sweepers. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/engine-fixes.test.ts`

**B1 independent contract:** §5.7–5.10; AGENTS.md persistence, redaction and prototype containment; named race regressions. **Source reviewed:** engine.ts and nodes/http.ts/process.ts/code.ts.
**B4 stable seam / non-test callers:** WorkflowEngine operations, persisted records and actual fetch boundary; daemon-wiring.ts, routes.ts.
**B6 remaining stronger coverage:** Each retained case supplies a distinct crash/security failure absent from ordinary engine happy paths.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L56 | setWaitingOn rejects once the engine stopped | Tests the internal context exception rather than the forbidden POST; adjacent retained POST-after-stop regression proves that no side effect happens and restart sends it once. Remaining owner: engine-fixes.test.ts HTTP POST after stop. Risk: low; no unique behavior removed. |
| KEEP L65 | an HTTP POST reached after stop() is not sent; the resumed run sends it exactly once | Oracle evidence: assert.deepEqual(calls, [], "the stopped engine's block never sent its POST");; assert.equal(result.status, "succeeded"); |
| KEEP L94 | a runner spawned while the engine stopped is adopted from its handle, never spawned twice | Oracle evidence: assert.equal(marker?.kind, "process");; assert.equal((marker as { spawning?: boolean }).spawning, true, "the pre-spawn marker is on disk before the spawn"); |
| KEEP L127 | a parent's secret rendered into a sub-workflow's input is redacted in the child run | Oracle evidence: assert.ok(!text.includes("parent-only-secret-value"), "the child keeps and broadcasts no parent secret");; assert.match(JSON.stringify(childRun.triggerPayload), /«secret:PARENT_TOKEN»/); |
| KEEP L141 | a code runner stopped from outside fails the block; the run does not succeed | Oracle evidence: assert.equal(result.status, "failed");; assert.equal(run.blocks.A!.status, "failed"); |
| KEEP L153 | a block that answers cancelled while nothing cancelled the run fails it | Oracle evidence: assert.equal(result.status, "failed");; assert.deepEqual(code.seen, ["A"]); |
| KEEP L162 | a missing existing project fails the run with errorKind project_missing | Oracle evidence: assert.equal(result.status, "failed");; assert.equal(result.errorKind, "project_missing"); |
| KEEP L177 | a restart during the creation: the pending path is on disk, removed, and made again | Oracle evidence: assert.deepEqual(pending, { path: "/w/ws/wf-nightly-run0001", deleted: false, pending: true });; assert.equal(result.status, "succeeded"); |
| KEEP L206 | a failed creation removes what it left and records nothing pending | Oracle evidence: assert.equal(result.status, "failed");; assert.deepEqual(h.projects.deleted, ["/w/ws/wf-nightly-run0001"]); |
| KEEP L216 | a run whose saved state cannot be read is due for the sweeper | Oracle evidence: assert.equal(run.status, "interrupted");; assert.ok(run.tempProject?.deleteAfter, "the sweeper will delete its project"); |
| KEEP L242 | stopping during the finalize's delete leaves the project due for the sweeper | Oracle evidence: assert.equal(saved.status, "succeeded");; assert.equal(saved.tempProject?.deleted, false); |
| KEEP L258 | a release event clones at its tag; a PR head the clone cannot resolve is retried at the PR branch | Oracle evidence: assert.deepEqual(h.projects.created[0]!.source, { kind: "clone", url: "https://git.test/r.git", ref: "v1.2.0" });; assert.equal(result.status, "succeeded"); |
| KEEP L312 | a run is not active until its record exists; a failed create leaves nothing active | Oracle evidence: await assert.rejects(started, /Could not record the run/);; assert.deepEqual(seenDuringCreate, []); |
| KEEP L330 | a stored run naming a block `__proto__` is interrupted, never walked | Oracle evidence: assert.equal((await env.shared.runStore.load("evil"))!.status, "interrupted");; assert.equal(({} as Record<string, unknown>).status, undefined, "Object.prototype untouched"); |
| KEEP L360 | an invalid URL quoting a long secret is redacted before it is cut | Oracle evidence: assert.equal(error.kind, "validation");; assert.ok(!error.message.includes("ssssssssss"), error.message); |

## `apps/daemon/src/workflows/engine-resume.test.ts`

**B1 independent contract:** §5.8; AGENTS.md persist-before-side-effect/idempotent command rules. **Source reviewed:** engine.ts, nodes/process.ts/http.ts/wait.ts/subworkflow.ts.
**B4 stable seam / non-test callers:** WorkflowEngine stop/resume over PersistedRun records; daemon-wiring.ts startup/shutdown.
**B6 remaining stronger coverage:** Distinct interrupted-record states below the restart E2E; E2E cannot exhaust retry, HTTP safety and damaged records.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L50 | a Wait block's timer resumes at the same wall-clock instant | Oracle evidence: assert.equal(waiting.status, "waiting");; assert.deepEqual(waiting.waitingOn, { kind: "timer", until: "2026-09-28T10:10:00.000Z", purpose: "wait" }); |
| KEEP L73 | a retry delay resumes, then the next attempt runs | Oracle evidence: assert.equal((await blockOf(first, runId!, "A")).waitingOn?.kind, "timer");; assert.equal(result.status, "succeeded"); |
| KEEP L92 | a code process that ended while the daemon was down: its exit.json is read | Oracle evidence: assert.equal(result.status, "failed");; assert.deepEqual((await blockOf(second, runId!, "A")).error, { kind: "exception", message: "thrown", detail: { stack: "at x" } }); |
| KEEP L113 | a process gone without a record is interrupted — retried when the policy allows | Oracle evidence: assert.equal(result.status, "failed");; assert.equal((await blockOf(second, runId!, "A")).error?.kind, "interrupted"); |
| KEEP L147 | a child run is re-subscribed by its parent | Oracle evidence: assert.equal(waitingOn?.kind, "child-run");; assert.equal(result.status, "succeeded"); |
| KEEP L174 | an HTTP GET is re-issued; a POST fails interrupted | Oracle evidence: assert.equal((await blockOf(first, runId!, "H")).waitingOn?.kind, "http");; assert.equal(result.status, "succeeded"); |
| KEEP L206 | a block running without a WaitingOn: a pure block re-runs as the same attempt | Oracle evidence: assert.equal(result.status, "succeeded");; assert.equal(run.blocks.If!.attempt, 1, "the same attempt"); |
| KEEP L242 | a side-effecting block running without a WaitingOn is interrupted (no retry) | Oracle evidence: assert.equal(run.blocks.A!.error?.kind, "interrupted");; assert.equal(run.blocks.A!.status, "failed"); |
| REWRITE L259 | queued runs start after a restart; a run whose definition cannot be read is marked interrupted | Rewrite: Fill the actual four-run cap before restart; keep queued recovery and unreadable-record behavior without limit injection. Oracle evidence: assert.equal((await env.shared.runStore.load(b.runId!))!.status, "queued");; assert.equal(resultA.status, "failed", "A's code block was cut by the restart (no retry)"); |
| KEEP L285 | stop() persists the last state and writes nothing after | Oracle evidence: assert.equal(handover.status, "running");; assert.equal(handover.blocks.A!.activity, "last words"); |

## `apps/daemon/src/workflows/engine.test.ts`

**B1 independent contract:** §3.2–3.4, §5.7–5.11, §7.6. **Source reviewed:** engine.ts + node executors.
**B4 stable seam / non-test callers:** WorkflowEngine run/fire/testNode/cancel, public run results and broadcaster payloads; routes.ts, factory.ts, scheduler/poller via TriggerHost.
**B6 remaining stronger coverage:** Engine scheduling is the lowest owner: API graph tests compute readiness but cannot prove executor admission, lifecycle or persisted outcomes.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L22 | IF takes one branch; the other is skipped with its edges dead | Oracle evidence: assert.equal(run.status, "succeeded");; assert.equal(run.blocks.If!.handle, "true"); |
| KEEP L48 | Switch: the first matching case wins, the fallback takes the rest, no fallback kills every edge | Oracle evidence: assert.equal(run.blocks.Sw!.handle, "case:1");; assert.equal(run.blocks.B!.status, "succeeded"); |
| KEEP L76 | independent branches run concurrently; Merge (all) waits for every live input | Oracle evidence: assert.equal(code.calls.length, 2, "both branches started");; assert.equal(run.blocks.M!.status, "pending", "Merge waits for B"); |
| KEEP L99 | Merge (first) runs on the first arrival and ignores the later one | Oracle evidence: assert.equal(run.blocks.M!.status, "succeeded");; assert.deepEqual(run.blocks.M!.output, { B: "b" }); |
| KEEP L124 | a block with several live inputs and no Merge reads the merge object | Oracle evidence: assert.deepEqual(Object.keys(seen as object).sort(), ["A", "B"]); |
| KEEP L138 | a failure with an error edge routes down it and the run succeeds | Oracle evidence: assert.equal(run.status, "succeeded");; assert.equal(run.blocks.A!.status, "failed"); |
| KEEP L166 | a failure without an error edge fails the run and cancels the running siblings | Oracle evidence: assert.equal(result.status, "failed");; assert.equal(result.error, "A: exit 2"); |
| KEEP L184 | retries wait their delay on a persisted timer, then succeed | Oracle evidence: assert.equal(block.status, "waiting");; assert.equal(block.attempt, 1); |
| KEEP L214 | all_burnt and limit_exceeded failures are never retried | Oracle evidence: assert.deepEqual(agent.seen, ["A"], `${kind}: one attempt`);; assert.equal(run.blocks.A!.attempt, 1); |
| REWRITE L226 | an agent waiting for a usage reset (kind agent, phase waiting-reset) reads waiting and resumes as such | Rewrite: Remove irrelevant test-only concurrency override; preserve waiting/running state behavior. Oracle evidence: assert.equal(block.status, "waiting");; assert.equal(block.waitingUntil, "2026-09-28T12:00:00.000Z"); |
| KEEP L256 | retries exhausted: the last failure stands | Oracle evidence: assert.equal(run.status, "failed");; assert.equal(run.blocks.A!.attempt, 2); |
| KEEP L266 | a disabled block passes its input through as success without running | Oracle evidence: assert.deepEqual(code.seen, ["B"]);; assert.equal(run.blocks.A!.status, "succeeded"); |
| KEEP L276 | Stop as failure fails the run with its message and value | Oracle evidence: assert.equal(result.status, "failed");; assert.equal(result.error, "No tickets for Ada"); |
| KEEP L293 | code's stop() ends the run as stopped | Oracle evidence: assert.equal(result.status, "stopped");; assert.equal(result.error, "nothing to do"); |
| KEEP L304 | a trigger-less workflow starts at its roots with the manual input | Oracle evidence: assert.equal(run.status, "succeeded");; assert.deepEqual(run.blocks.A!.output, { node: "A", input: { hello: 1 } }); |
| KEEP L314 | a fired trigger runs; the others are skipped | Oracle evidence: assert.equal(result.status, "succeeded");; assert.equal(run.trigger.kind, "schedule"); |
| KEEP L340 | a run with validation errors is refused (manual) or recorded as failed (trigger) | Oracle evidence: await assert.rejects(h.engine.run("w1", {}), (error: unknown) => error instanceof WorkflowEngineError && error.code === "INVALID_WORKFLOW" && (error.problems?.length ?? 0) > 0);; assert.equal(stub.status, "failed"); |
| KEEP L351 | a projectOverride block runs in that project; a missing one fails the block | Oracle evidence: assert.equal(seenPath, "/w/ws/other");; assert.equal(run.blocks.A!.error?.kind, "project_missing"); |
| KEEP L369 | an executor that throws or answers nonsense fails its block as internal | Oracle evidence: assert.deepEqual(run.blocks.A!.error, { kind: "internal", message: "kaput" });; assert.equal(run.blocks.B!.error?.kind, "internal"); |
| REWRITE L386 | a big output goes to a file with an inline preview; downstream and nodeOutput read it whole | Rewrite: Exercise the actual 64 KiB preview contract with 100 KiB output, removing the test-only limit override. Oracle evidence: assert.equal(run.blocks.A!.outputTruncated, true);; assert.equal(typeof run.blocks.A!.output, "string"); |
| REWRITE L409 | an output over the hard cap fails the block with limit_exceeded | Rewrite: Exercise the actual 16 MiB output cap instead of injecting a smaller test cap. Oracle evidence: assert.equal(run.blocks.A!.error?.kind, "limit_exceeded");; assert.equal(result.status, "failed"); |
| KEEP L418 | a secret appearing in an output, an error or a warning is redacted everywhere | Oracle evidence: assert.deepEqual(run.blocks.A!.output, { token: "«secret:API_TOKEN»", text: "Bearer «secret:API_TOKEN»" });; assert.deepEqual(run.blocks.A!.warnings, ["saw «secret:API_TOKEN»"]); |
| KEEP L447 | the per-run update events are throttled; the final state is always published | Oracle evidence: assert.ok(burst <= 1, `at most one update in the same instant (got ${burst})`);; assert.equal(last.blocks.find((block) => block.nodeId === "A")?.activity, "step 49", "the latest state is what goes out"); |
| KEEP L479 | cancel mid-block aborts it and ends the run cancelled | Oracle evidence: assert.equal(await h.engine.cancel(runId!), true);; assert.equal(result.status, "cancelled"); |
| REWRITE L494 | a block that ignores its abort cannot hold a cancelled run forever | Rewrite: Advance the fake clock through the actual 30 s shutdown grace; remove test-only grace override. Oracle evidence: assert.equal(result.status, "cancelled");; assert.equal((await h.engine.getRun(runId!))!.blocks.A!.status, "cancelled"); |
| KEEP L507 | the run timeout fails the run and cancels what runs | Oracle evidence: assert.equal((await h.engine.getRun(runId!))!.status, "running");; assert.equal(result.status, "failed"); |
| KEEP L526 | skip: a second fire records a skipped stub; force runs anyway | Oracle evidence: assert.deepEqual(second, { runId: null, skipped: "overlap" });; assert.equal(runs.runs.length, 2); |
| KEEP L543 | queue: one pending fire waits for the active run; a further fire is skipped | Oracle evidence: assert.ok(second.runId);; assert.deepEqual(third, { runId: null, skipped: "overlap" }); |
| KEEP L565 | parallel: up to maxConcurrent, then skipped | Oracle evidence: assert.ok((await h.engine.run("w1", {})).runId);; assert.ok((await h.engine.run("w1", {})).runId); |
| REWRITE L575 | the global run cap queues runs beyond it, FIFO | Rewrite: Use the specified four-run capacity and an additional queued run; remove production limit injection. Oracle evidence: assert.equal(code.calls.length, 2);; assert.equal(waiting.status, "queued"); |
| REWRITE L598 | a queued run can be cancelled before it starts | Rewrite: Fill the actual four-run capacity before cancelling the next run; remove production limit injection. Oracle evidence: assert.equal(await h.engine.cancel(b.runId!), true);; assert.equal(result.status, "cancelled"); |
| REWRITE L609 | agent blocks and sandbox processes wait behind their global caps | Rewrite: Use the actual four-agent/eight-process capacities and one extra of each; remove production limit injection. Oracle evidence: assert.equal(agent.calls.length, 1);; assert.equal(code.calls.length, 1); |
| REWRITE L637 | an agent block's timer wait releases its slot; waking takes it back | Rewrite: Fill the actual four-agent pool; prove a waiting block frees capacity and reacquires it; remove production limit injection. Oracle evidence: assert.equal(agent.calls.length, 1);; assert.equal(agent.calls.length, 2, "the other agent block got the slot"); |
| KEEP L661 | usePinned: a pinned block is not executed and downstream reads its pin | Oracle evidence: assert.deepEqual(code.seen, ["B"]);; assert.equal(run.blocks.A!.pinned, true); |
| KEEP L673 | without usePinned, pins are ignored | Oracle evidence: assert.deepEqual(code.seen, ["A"]); |
| KEEP L681 | fromNodeId runs that block and its downstream; upstream from pins, else the latest run | Oracle evidence: assert.deepEqual(code.seen, ["B", "C"]);; assert.equal(run.test, true); |
| KEEP L702 | testNode executes only that block, even with no upstream data | Oracle evidence: assert.deepEqual(code.seen, ["B"]);; assert.equal(result.status, "succeeded"); |
| KEEP L716 | testNode seeds only the tested block's upstream: downstream and side branches stay skipped | Oracle evidence: assert.equal(first.run.blocks.C!.status, "succeeded");; assert.deepEqual(code.seen, ["B"]); |
| KEEP L741 | retryOf reuses the succeeded blocks and re-runs the failed ones | Oracle evidence: assert.equal(first.result.status, "failed");; assert.equal(retry.result.status, "succeeded"); |
| KEEP L762 | retryOf + fromNodeId on the fired trigger re-runs everything with the same event | Oracle evidence: assert.equal(first.status, "failed");; assert.equal(retry.result.status, "succeeded"); |
| KEEP L790 | retryOf + a non-trigger fromNodeId runs from there on that run's upstream outputs | Oracle evidence: assert.deepEqual(code.seen, ["B"]);; assert.deepEqual(retry.run.blocks.B!.output, { node: "B", input: "a1" }, "the retried run's A, not the latest"); |
| KEEP L804 | retryOf does not reuse a success that sits below a block being re-run | Oracle evidence: assert.equal(first.run.blocks.E!.status, "succeeded");; assert.equal(retry.run.blocks.A!.status, "succeeded"); |
| KEEP L828 | created per run, deleted when the run succeeds | Oracle evidence: assert.deepEqual(h.projects.created.map(({ name: _name, ...request }) => request), [{ workspace: "ws", source: { kind: "clone", url: "https://git.test/r.git", ref: "main" } }]);; assert.ok(run.projectPath?.startsWith("/w/ws/")); |
| KEEP L839 | kept keepFailedTempDays when the run fails; Delete now removes it | Oracle evidence: assert.deepEqual(h.projects.deleted, []);; assert.equal(run.tempProject?.deleted, false); |
| KEEP L851 | a git trigger on the project repo clones at the event's sha | Oracle evidence: assert.deepEqual(h.projects.created[0]!.source, { kind: "clone", url: "https://git.test/r.git", ref: "abc123" }); |
| KEEP L872 | the child's final output is the block's output; runs are linked both ways | Oracle evidence: assert.equal(result.status, "succeeded");; assert.deepEqual(run.blocks.S!.output, { doubled: 42 }); |
| KEEP L886 | a failing child fails the block with child_run_failed | Oracle evidence: assert.equal(run.blocks.S!.error?.kind, "child_run_failed");; assert.match(run.blocks.S!.error!.message, /inner/); |
| REWRITE L895 | the depth limit and cycles are refused at run time | Rewrite: Exercise six child levels against the specified depth-five cap rather than a private override. Oracle evidence: assert.equal(run.status, "failed");; assert.equal(bRun.blocks.S!.error?.kind, "limit_exceeded"); |
| KEEP L918 | cancelling the parent cancels the child | Oracle evidence: assert.equal(code.calls.length, 1, "the child is running");; assert.equal((await h.engine.waitForRun(childRunId)).status, "cancelled"); |
| REWRITE L931 | child runs bypass the global run cap (no deadlock) | Rewrite: Use a five-run parent/child chain to exceed the real four-run cap without an injected override. Oracle evidence: assert.equal(result.status, "succeeded"); |
| KEEP L941 | deleting a workflow cancels its runs and stops writing them | Oracle evidence: assert.equal(result.status, "cancelled");; assert.equal(await h.runStore.load(runId!), null, "late execution must not recreate deleted run data"); |
| KEEP L956 | enabledTriggers lists enabled workflows' live trigger nodes; definition changes are forwarded | Oracle evidence: assert.deepEqual(found.map((entry) => `${entry.workflow.id}:${entry.node.id}`), ["on:S1"]);; assert.equal(calls, 2); |
| KEEP L976 | recordSkipped writes a visible stub | Oracle evidence: assert.equal(runs[0]!.status, "skipped");; assert.equal(runs[0]!.skipReason, "missed"); |

## `apps/daemon/src/workflows/git-remote/clone-ref.test.ts`

**B1 independent contract:** §5.10 clone branch/tag/SHA semantics; git external CLI protocol and input safety. **Source reviewed:** clone-ref.ts.
**B4 stable seam / non-test callers:** clone ref validation, git argv and ls-remote parsing; accounts.ts cloneRepo; index.ts clone request validation.
**B6 remaining stronger coverage:** External git argv is a stable protocol, not private collaborator shape; Accounts owner confirmed no equivalent successful branch/tag/full-SHA case.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| REWRITE L16 | cloneRefProblem accepts branches, tags and shas | Rewrite: Use literal boundary fixture instead of importing the implementation maximum; remove test-only constant export. Oracle evidence: assert.equal(cloneRefProblem(ok), null, ok); |
| REWRITE L22 | cloneRefProblem refuses empty, long, option-like, whitespace and control characters | Rewrite: Use literal 251-character oversized input independent of the implementation maximum; retain option/control rejection. Independent oracle: empty strings, 251 characters, leading options, whitespace/control bytes and non-string inputs all return a validation problem. |
| KEEP L40 | sha detection: only full ids skip --branch; short hex may be either | Oracle evidence: assert.equal(isFullSha(SHA), true);; assert.equal(isFullSha("b".repeat(64)), true); |
| KEEP L51 | cloneArgs: a name rides --branch, a sha and no ref clone plainly, the URL follows -- | Oracle evidence: assert.deepEqual(cloneArgs("git@github.com:o/r.git", "r"), ["clone", "--", "git@github.com:o/r.git", "r"]);; assert.deepEqual(cloneArgs("https://github.com/o/r.git", "wf-x", "v1.2.3"), [ |
| KEEP L71 | isMissingRemoteRef recognises git's messages | Oracle evidence: assert.equal(isMissingRemoteRef("warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin"), true);; assert.equal(isMissingRemoteRef("fatal: couldn't find remote ref deadbeef"), true); |
| KEEP L77 | resolveAbbreviatedSha: one commit by prefix, null when none or ambiguous | Oracle evidence: assert.equal(resolveAbbreviatedSha(listing, "ABCDEF012345"), a);; assert.equal(resolveAbbreviatedSha(listing, "123456789abc"), null); |

## `apps/daemon/src/workflows/git-remote/ls-remote.test.ts`

**B1 independent contract:** §6.2 git ls-remote protocol, annotated tags, SHA-256 and prototype safety. **Source reviewed:** ls-remote.ts.
**B4 stable seam / non-test callers:** parseLsRemote text protocol; accounts.ts remote listing, git-poller.ts.
**B6 remaining stronger coverage:** Only parser owner protects these raw provider byte forms; poller fakes receive already parsed maps.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L10 | parseLsRemote reads heads, lightweight and annotated tags, and the HEAD symref | Oracle evidence: assert.deepEqual(parseLsRemote(stdout), { |
| KEEP L30 | parseLsRemote: a peeled line before its tag, CRLF, junk and uppercase shas | Oracle evidence: assert.deepEqual(parseLsRemote(stdout), { heads: {}, tags: { rel: { sha: B, commit: A } } }); |
| KEEP L43 | parseLsRemote: no HEAD line → no defaultBranch; a __proto__ branch stays an own key | Oracle evidence: assert.equal(result.defaultBranch, undefined);; assert.equal(Object.keys(result.heads).length, 2); |
| KEEP L51 | parseLsRemote: SHA-256 object ids | Oracle evidence: assert.deepEqual(parseLsRemote(`${long}\trefs/heads/main\n`).heads, { main: long }); |

## `apps/daemon/src/workflows/git-remote/remote-url.test.ts`

**B1 independent contract:** §6.2 repository identity/provider URL forms; AGENTS.md host-only credentials. **Source reviewed:** remote-url.ts.
**B4 stable seam / non-test callers:** public URL validation/key/display/sanitization helpers; accounts.ts, triggers/git-poller.ts and repo-resolve.ts.
**B6 remaining stronger coverage:** Only daemon remote owner covers SSH aliases/DC contexts, unsupported transports and URL userinfo sanitization; API display helper is separate UI-only formatting.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L5 | repoKeyOf: every GitHub form of one repo has one key | Oracle evidence: assert.equal(repoKeyOf(form), "github.com/octo-org/hello-world", form); |
| KEEP L29 | repoKeyOf: Bitbucket Cloud's old and new SSH hosts are one host | Oracle evidence: assert.equal(repoKeyOf(form), "bitbucket.org/acme/web-app", form); |
| KEEP L42 | repoKeyOf: Bitbucket Server/DC forms reduce to host/project/repo | Oracle evidence: assert.equal(repoKeyOf(form), "bb.corp.example/prj/api", form);; assert.equal(repoKeyOf("https://bb.corp.example/bitbucket/users/jdoe/repos/site/browse"), "bb.corp.example/~jdoe/site"); |
| KEEP L57 | repoKeyOf: other hosts keep their whole path (GitLab subgroups) | Oracle evidence: assert.equal(repoKeyOf("https://gitlab.com/group/sub/repo.git"), "gitlab.com/group/sub/repo");; assert.equal(repoKeyOf("git@gitlab.com:group/sub/repo.git"), "gitlab.com/group/sub/repo"); |
| KEEP L62 | repoKeyOf: refuses what git would not be handed | Oracle evidence: assert.equal(repoKeyOf(bad), null, JSON.stringify(bad)); |
| KEEP L78 | repoDisplayName keeps the original case | Oracle evidence: assert.equal(repoDisplayName("git@github.com:AppsStats/Apps-Stats.git"), "AppsStats/Apps-Stats");; assert.equal(repoDisplayName("https://bb.corp.example/bitbucket/scm/PRJ/api.git"), "PRJ/api"); |
| KEEP L85 | remoteUrlProblem accepts the four transports and refuses the rest | Oracle evidence: assert.equal(remoteUrlProblem(ok), null, ok); |
| KEEP L101 | stripUrlCredentials drops the whole http(s) userinfo (a token may be the user) and an ssh password | Oracle evidence: assert.equal(stripUrlCredentials("https://x-access-token:ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git");; assert.equal(stripUrlCredentials("https://ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git"); |
| KEEP L112 | redactUrlUserinfo hides a token user in http(s) text and a password anywhere, keeps ssh logins | Fixed oracle: HTTP token usernames and username/password become `***`; `ssh://git@github.com/o/r` and text without a URL stay intact. A token in a Git diagnostic must never be returned to the caller. |

## `apps/daemon/src/workflows/integration.test.ts`

**B1 independent contract:** §3.2, §4, §5.6–5.9 executor output/error/security contracts. **Source reviewed:** nodes/code.ts/shell.ts/http.ts/process.ts + sandbox.
**B4 stable seam / non-test callers:** WorkflowEngine results with real local HTTP and subprocess IO; factory.ts registered node executors.
**B6 remaining stronger coverage:** Retained cases own executor translation (timeout/exit_code/http_status), shell env safety and actual cancellation; lower sandbox tests do not assert workflow errors.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| DELETE L41 | a code block reads its context and secrets; the secret is redacted from its output | Repeats context transport and redaction between the real sandbox test and retained manual pipeline E2E; suffix and log-size assertions add implementation shape. Remaining owner: sandbox/sandbox.test.ts; engine.test.ts redaction; e2e.test.ts manual pipeline. Risk: low; no unique behavior removed. |
| KEEP L75 | a throw fails the block with its message and stack; stop() stops the run | Oracle evidence: assert.equal(result.status, "failed");; assert.equal(run.blocks.A!.error?.kind, "exception"); |
| KEEP L113 | a shell block gets its env (secrets included), never a rendered script; exit codes map | Oracle evidence: assert.deepEqual(run.blocks.Ok!.output, { stdout: "who=$(touch /tmp/pwned) ada key=«secret:API_KEY»\n", stderr: "oops\n", exitCode: 0 });; assert.equal(run.blocks.Bad!.status, "failed"); |
| KEEP L145 | cancelling a run kills its shell promptly | Oracle evidence: assert.equal(result.status, "cancelled"); |
| KEEP L231 | JSON responses are parsed; query and headers are rendered (secrets allowed, redacted after) | Oracle evidence: assert.equal(block.status, "succeeded");; assert.equal(output.status, 200); |
| KEEP L248 | text stays text; redirects are followed or not; statuses map | Oracle evidence: assert.equal((block.output as { body: unknown }).body, "plain text");; assert.deepEqual((block.output as { body: unknown }).body, { hello: "world", q: null }); |
| KEEP L264 | bodies: JSON rendered from a value, form fields, text | Oracle evidence: assert.deepEqual((block.output as { body: unknown }).body, { method: "POST", body: '{"a":[1,2]}', contentType: "application/json" });; assert.equal(((block.output as { body: { body: string } }).body).body, '{"name": "ada"}'); |
| KEEP L277 | the body cap, the timeout and a network error each fail the block with their kind | Oracle evidence: assert.equal(block.error?.kind, "limit_exceeded");; assert.equal(block.error?.kind, "timeout"); |

## `apps/daemon/src/workflows/nodes/nodes.test.ts`

**B1 independent contract:** §4 Wait timezone and §3.2/§5.9 shell output tails. **Source reviewed:** nodes/wait.ts and nodes/shell.ts.
**B4 stable seam / non-test callers:** WorkflowEngine outcomes over real executors; nodes/index.ts registered executors.
**B6 remaining stronger coverage:** Distinct timezone precedence and real shell-tail cap are not covered by UTC-duration resume or raw sandbox log cap.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L16 | until HH:MM waits for the next such time in the block's time zone | Oracle evidence: assert.equal(block.status, "waiting");; assert.deepEqual(block.waitingOn, { kind: "timer", until: "2026-09-29T07:00:00.000Z", purpose: "wait" }); |
| KEEP L33 | the workflow's own time zone applies when the block names none | Oracle evidence: assert.equal((await h.runStore.load(runId!))!.blocks.W!.waitingUntil, "2026-09-28T10:30:00.000Z");; assert.equal((await h.engine.waitForRun(runId!)).status, "cancelled"); |
| KEEP L64 | stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk | Oracle evidence: assert.equal(result.status, "succeeded");; assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 16 * 1024 * 1024); |

## `apps/daemon/src/workflows/nodes/regex-worker.test.ts`

**B1 independent contract:** §4 bounded regex execution; §5.7 no secret prefix leakage. **Source reviewed:** nodes/regex-worker.ts and API rules.ts.
**B4 stable seam / non-test callers:** RegexMatcher match; evaluateRulesAsync output/warnings; nodes/flow.ts; agent rules consumers.
**B6 remaining stronger coverage:** Actual worker responsiveness/recovery cannot be proved by mocked matcher API tests; API owner confirmed clipping regression is unique.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L13 | an ordinary pattern answers | Oracle evidence: assert.deepEqual(await matcher.match({ source: "^fe(at)?", flags: "i", text: "Feature/x" }), { result: true });; assert.deepEqual(await matcher.match({ source: "^fix", flags: "", text: "feature/x" }), { result: false }); |
| KEEP L18 | a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works | Oracle evidence: assert.equal(slow.result, false);; assert.ok(slow.warning, "a stopped search reports a warning"); |
| KEEP L35 | a clipped value is redacted before the clip | Oracle evidence: assert.equal(evaluated.result, false);; assert.ok(!text.includes("SSSSSSSSSS"), text); |

## `apps/daemon/src/workflows/routes.test.ts`

**B1 independent contract:** §8.1 HTTP protocol; AGENTS.md secret/transport boundaries. **Source reviewed:** routes.ts.
**B4 stable seam / non-test callers:** Fastify HTTP injection; deleteWorkflowCascade is the daemon deletion owner; index.ts registers routes; API client/MCP invoke routes.
**B6 remaining stronger coverage:** HTTP status/body/header mapping, unavailable-engine fallback, request limits and cascade are owned here; store tests cannot assert transport behavior.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L163 | without the engine: acting routes answer 503 ENGINE_UNAVAILABLE | Oracle evidence: assert.equal(response.statusCode, 503, url);; assert.equal(response.json().error.code, "ENGINE_UNAVAILABLE", url); |
| KEEP L181 | without the engine: history, run detail and outputs are read from the run store | Oracle evidence: assert.equal(list.statusCode, 200);; assert.deepEqual(list.json().runs.map((r: { id: string }) => r.id), ["run-2"]); |
| KEEP L219 | definitions: create, read, replace (409 on a stale revision), patch, duplicate, validate | Oracle evidence: assert.equal(read.statusCode, 200);; assert.equal(read.json().workflow.id, created.id); |
| KEEP L272 | the list filters by project: the existing project, plus temp workflows of its workspace | Oracle evidence: assert.equal(all.json().workflows.length, 4);; assert.deepEqual(filtered.json().workflows.map((w: { id: string }) => w.id).sort(), [mine.id, temp.id].sort()); |
| KEEP L288 | block types and the schedule preview | Oracle evidence: assert.equal(preview.json().valid, true);; assert.equal(preview.json().next.length, 3); |
| KEEP L301 | secrets: names only, write-only values, scoped to an existing workflow | Oracle evidence: assert.equal(put.statusCode, 200);; assert.deepEqual(put.json().secrets.map((s: { name: string }) => s.name), ["API_KEY"]); |
| KEEP L326 | delete cascades: active runs cancelled through the engine, runs and secrets removed | Oracle evidence: assert.equal(stale.statusCode, 409);; assert.equal(response.statusCode, 204); |
| KEEP L355 | with the engine: runs, tests, cancels and summaries go through it | Oracle evidence: assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.run("nope"), payload: {} })).statusCode, 404);; assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.testNode(workflow.id, "zz") })).json().error.code, "NODE_NOT_FOUND"); |
| KEEP L372 | log windows are redacted and report their position | Oracle evidence: assert.equal(window.statusCode, 200);; assert.equal(window.body, "token «secret:KEY» done\n"); |
| KEEP L393 | log follow streams as the file grows and redacts a secret split across writes | Oracle evidence: assert.equal(response.statusCode, 200);; assert.match(String(response.headers["content-type"]), /text\/plain/); |
| KEEP L441 | an engine refusal keeps its status, code and problems (never a generic 500) | Oracle evidence: assert.equal(run.statusCode, 400);; assert.deepEqual(run.json(), { error: { code: "INVALID_WORKFLOW", message: "The workflow has errors: x", problems: [{ severity: "error", code: "schema", message: "x" }] } }); |
| KEEP L460 | DELETE of a secret refuses prototype names and unknown workflows; Object.prototype is untouched | Oracle evidence: assert.equal(polluted.statusCode, 404);; assert.equal(polluted.json().error.code, "WORKFLOW_NOT_FOUND"); |
| KEEP L472 | validate returns at once past the hard limits (5 000 blocks) | Oracle evidence: assert.equal(res.statusCode, 200);; assert.ok(codes.includes("too_many_nodes") && codes.includes("too_many_edges"), codes.join(",")); |
| KEEP L482 | write routes take a body past 1 MiB, and one past their limit answers LIMIT_EXCEEDED | Oracle evidence: assert.equal(accepted.statusCode, 200, "1.5 MiB reaches the handler");; assert.equal(refused.statusCode, 413); |
| KEEP L493 | account-preview refuses a chain entry it cannot read (400, never 500) | Oracle evidence: assert.equal(res.statusCode, 400);; assert.equal(res.json().error.code, "INVALID_REQUEST"); |
| KEEP L501 | the delete cascade keeps a run record whose temp project it could not delete; deletes it directly when it can | Oracle evidence: assert.equal(await h.runStore.load("plain"), null);; assert.deepEqual(deleted, ["/w/ws/wf-kept"]); |

## `apps/daemon/src/workflows/run-store.test.ts`

**B1 independent contract:** §5.8 durable run records, index, retention and output files; AGENTS.md containment. **Source reviewed:** run-store.ts.
**B4 stable seam / non-test callers:** FileRunStore public methods and files read by a fresh store; engine.ts, routes.ts, daemon-wiring.ts, sweepers.ts.
**B6 remaining stronger coverage:** Real filesystem and index semantics cannot be proved by in-memory engine fakes.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L59 | create/save: run.json is atomic and 0600, the last save wins, the index follows | Oracle evidence: assert.equal((await stat(file)).mode & 0o777, 0o600);; assert.equal(store.activeForWorkflow("wf-1").length, 1); |
| KEEP L85 | init rebuilds the index from the run directories; an unreadable run.json is skipped | Oracle evidence: assert.deepEqual(page.runs.map((r) => r.id), ["run-new", "run-old"]);; assert.equal(page.before, null); |
| KEEP L117 | paging: `before` is a run id cursor, newest first; an unknown cursor is a first page | Oracle evidence: assert.deepEqual(one.runs.map((r) => r.id), ["run-4", "run-3"]);; assert.equal(one.before, "run-3"); |
| KEEP L134 | sweep keeps the newest 100 and nothing older than 30 days, preserving active runs | Oracle evidence: assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 200 })).runs.map((r) => r.id), [...Array.from({ length: 100 }, (_, i) => `run-${i}`), "run-active"]);; assert.deepEqual((await store.listForWorkflow("wf-2", { limit: 10 })).runs.map((r) => r.id), ["run-ancient-active"]); |
| KEEP L157 | sweep keeps a run whose temporary project is still there, until the project is deleted | Oracle evidence: assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 10 })).runs.map((r) => r.id), ["run-new", "run-kept"]);; assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 10 })).runs.map((r) => r.id), ["run-new"]); |
| KEEP L176 | events append as NDJSON; attempt dirs and output files live under the run | Oracle evidence: assert.deepEqual(lines, [{ n: 1 }, { n: 2 }, { n: 3 }]);; assert.equal(attempt, join(dir, "run-x", "nodes", "node-1", "2")); |
| KEEP L203 | deleteForWorkflow removes every run of that workflow only | Oracle evidence: assert.equal(store.latestForWorkflow("wf-1"), undefined);; assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("run-")), ["run-c"]); |
| KEEP L216 | runSummaryOf / persistedRunToWire: bookkeeping stripped, outputs cut to the preview | Oracle evidence: assert.equal(summary.status, "failed");; assert.equal(summary.error, "boom"); |

## `apps/daemon/src/workflows/sandbox/log-reader.test.ts`

**B1 independent contract:** §5.6–5.7, §7.3 byte-positioned, UTF-8-safe, redacted logs. **Source reviewed:** log-reader.ts and redact.ts byteMatches.
**B4 stable seam / non-test callers:** readLogWindow/followLog over real growing files; routes.ts; nodes/shell.ts.
**B6 remaining stronger coverage:** Only owner of offset-inside-secret, tiny windows, incomplete UTF-8 and abort semantics; route tests validate HTTP headers/transport instead.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L45 | windows of any size cut at character boundaries and join to the whole text | Oracle evidence: assert.equal(windows.join(""), text, `windows of ${size} bytes join to the text`);; assert.equal(window.includes("�"), false, `no window of ${size} bytes splits a character`); |
| KEEP L56 | a secret is never split across windows | Oracle evidence: assert.equal(windows.join(""), expected, `windows of ${size} bytes join to the redacted text`);; assert.equal(/sk-live-ÄBC-123\|pw12/.test(window), false, `no window of ${size} bytes shows a secret`); |
| KEEP L70 | an offset inside a secret serves its placeholder, never its tail | Oracle evidence: assert.equal(window.text, "«secret:KEY»67890", "the partial secret became its placeholder");; assert.equal(window.eof, true, "and the window reached the end"); |
| KEEP L78 | holdTail keeps back a partial character and a possible secret prefix | Oracle evidence: assert.equal(first.text.includes("topsec"), false, "the possible secret prefix is held");; assert.equal(first.eof, false, "the held bytes are still to come"); |
| KEEP L94 | a missing file reads as empty | Oracle evidence: assert.deepEqual(window, { text: "", nextOffset: 0, eof: true, size: 0 }, "empty, at its end"); |
| KEEP L102 | yields as the file grows and ends once it is not live and fully read | Oracle evidence: assert.equal(chunks.join(""), "first «secret:KEY» line\nsecond «secret:KEY» last", "everything, redacted, in order"); |
| KEEP L126 | an abort ends a live follow | Oracle evidence: assert.deepEqual(chunks, ["abc"], "the follow ended at the abort"); |

## `apps/daemon/src/workflows/sandbox/redact.test.ts`

**B1 independent contract:** §5.7 literal, nested secret redaction. **Source reviewed:** redact.ts.
**B4 stable seam / non-test callers:** createRedactor text/value; engine.ts, nodes/http.ts/shell.ts, routes.ts, agent/secret-text.ts.
**B6 remaining stronger coverage:** Retained literal/deep/overlap cases own redaction itself. Deleted string streaming had no production caller; actual byte-window streaming stays in log-reader tests.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L8 | text: every value ≥ 4 chars, longest first | Fixed oracle: `tok-12345`, `tok-12345-extended`, and `9876` become their named secret placeholders; three-character `abc` stays intact. Matching the shorter token inside the longer one would leak its suffix and fail. |
| KEEP L16 | value: deep through arrays and objects, values only | Fixed nested-object oracle replaces string values with named placeholders while preserving the `tok-12345` object key, numbers, null, booleans and the original input. A nested secret leak or destructive mutation fails. |
| KEEP L35 | special regex characters in a value are literal | Oracle evidence: assert.equal(special.text("a.b*c(d) axbbc(d)"), "«secret:P» axbbc(d)", "the value is matched literally"); |
| DELETE L46 | every two-chunk split replaces complete secrets with their placeholders | Exercises an unused string-stream API. Production log streaming uses readLogWindow/followLog byte offsets, not createChunkRedactor. No non-test callers. Remaining owner: sandbox/log-reader.test.ts split-window and live-tail redaction. Risk: low; no unique behavior removed. |
| DELETE L54 | one character at a time never emits part of a secret | Only keeps the dead SecretRedactor.stream helper alive; no production caller. The actual byte-window reader retains split-secret security coverage. Remaining owner: sandbox/log-reader.test.ts. Risk: low; no unique behavior removed. |

## `apps/daemon/src/workflows/sandbox/sandbox.test.ts`

**B1 independent contract:** §5.6–5.9 subprocess protocol, process ownership, env security and detached resume. **Source reviewed:** sandbox.ts, runner.mjs, code-host.mjs, proc.ts, env.ts.
**B4 stable seam / non-test callers:** SandboxRunner API against native child processes and durable files; nodes/process.ts; factory.ts.
**B6 remaining stronger coverage:** Lowest native process owner; engine fakes do not prove signals, grandchildren, serialization, env filtering or PID identity.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L80 | a return value is the result; log() and console.log reach stdout | Oracle evidence: assert.equal(exit.code, 0, "the code host exits 0");; assert.deepEqual(exit.result, { ok: true, value: { doubled: 42, fromNode: "a-out", run: "run-1" } }, "the return value is the result"); |
| KEEP L92 | undefined returns as null | Oracle evidence: assert.deepEqual(exit.result, { ok: true, value: null }, "undefined is stored as null"); |
| KEEP L97 | a throw is a failure with message and stack | Oracle evidence: assert.equal(exit.code, 1, "a failing block exits non-zero");; assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "the result is a failure"); |
| KEEP L105 | stop() ends the run as stopped, with its reason, even from a promise chain | Oracle evidence: assert.deepEqual(exit.result, { stop: true, reason: "nothing to do" }, "stop() wins even when its throw is swallowed");; assert.equal(exit.code, 0, "a stop is not a crash"); |
| KEEP L113 | require resolves the project's own node_modules | Oracle evidence: assert.deepEqual(exit.result, { ok: true, value: 42 }, "the package came from <project>/node_modules"); |
| KEEP L123 | a module with top-level await works | Oracle evidence: assert.deepEqual(exit.result, { ok: true, value: 42 }, "top-level await ran before the default export"); |
| KEEP L128 | a non-serializable return is an error | Oracle evidence: assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "a BigInt is refused");; assert.ok(exit.result.error.message.length > 0); |
| KEEP L134 | a return over maxOutputBytes is an error | Oracle evidence: assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "an oversized result is refused");; assert.ok(exit.result.error.message.length > 0); |
| KEEP L140 | a default export that is not a function is a clear error | Oracle evidence: assert.ok(none.exit.result && "ok" in none.exit.result && none.exit.result.ok === false, "no default export fails");; assert.ok(none.exit.result.error.message.length > 0); |
| KEEP L149 | a syntax error is a failure | Oracle evidence: assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "an unparsable module fails"); |
| KEEP L154 | an open handle does not hold the attempt | Oracle evidence: assert.deepEqual(exit.result, { ok: true, value: "done" }, "the host exits once the result is written"); |
| KEEP L162 | stdout, stderr and the exit code | Oracle evidence: assert.equal(ok.exit.code, 0, "a clean script exits 0");; assert.equal(ok.stdout, "out\n", "stdout is captured"); |
| KEEP L173 | sh works too, and the cwd is the request's | Oracle evidence: assert.equal(exit.code, 0, "sh ran the script");; assert.equal(stdout.trim(), root, "the work runs in the request's cwd"); |
| KEEP L179 | each stream is capped with one notice line | Oracle evidence: assert.ok(stdout.startsWith("a".repeat(50 * 1024 * 1024)), "the specified first 50 MiB are kept");; assert.ok(notice.length > 0, "truncation is reported"); |
| KEEP L190 | the environment is built, never inherited | Oracle evidence: assert.equal(stdout.includes("hunter2-do-not-leak"), false, "a daemon credential never reaches the child");; assert.equal(env.has("ORQUESTER_HTTP_PASSWORD"), false, "not even the name"); |
| KEEP L225 | an invalid env name refuses the spawn | Oracle evidence: await assert.rejects( |
| KEEP L233 | a missing cwd refuses the spawn | Oracle evidence: await assert.rejects( |
| KEEP L243 | the runner enforces the deadline itself | Oracle evidence: assert.equal(exit.timedOut, true, "exit.json says it timed out");; assert.equal(exit.cancelled, false, "a timeout is not a cancel"); |
| KEEP L253 | a work that ignores SIGTERM is SIGKILLed after the grace | Oracle evidence: assert.equal(exit.cancelled, true, "cancelled");; assert.equal(exit.signal, "SIGKILL", "the grace ran out and SIGKILL ended it"); |
| KEEP L272 | a cancel kills the whole group, grandchildren included | Oracle evidence: assert.equal(runner.isAlive(handle), true, "the runner is alive while the work runs");; assert.ok(grandchildStart > 0, "the grandchild is running"); |
| KEEP L299 | kill() ends a running attempt | Oracle evidence: assert.equal(runner.isAlive(handle), false, "kill() returns once the runner is gone");; assert.ok(exit !== null, "the runner still recorded its exit"); |
| KEEP L310 | a runner killed outright reads as interrupted, and its work is ended | Oracle evidence: assert.equal(exit.interrupted, true, "no exit.json: interrupted");; assert.equal(exit.code, null, "no exit code"); |
| KEEP L327 | a restarted daemon adopts a running attempt and reads its exit | Oracle evidence: assert.deepEqual(persisted, handle, "handle.json holds the handle");; assert.equal(adopter.isAlive(persisted), true, "the adopted runner is alive (pid + starttime)"); |
| KEEP L348 | readExit is null before an attempt ends | Oracle evidence: assert.equal(await runner.readExit(await freshDir()), null, "no exit.json, no exit"); |
| KEEP L352 | isAlive refuses a recycled pid (starttime mismatch) | Oracle evidence: assert.equal(runner.isAlive(self), true, "our own pid and starttime match");; assert.equal(runner.isAlive({ ...self, starttime: self.starttime + 1 }), false, "another starttime is another process"); |

## `apps/daemon/src/workflows/secrets.test.ts`

**B1 independent contract:** §5.7 host-only scoped secrets; §3.1 tolerant storage; AGENTS.md no secret leakage. **Source reviewed:** secrets.ts.
**B4 stable seam / non-test callers:** WorkflowSecretsService public writes/lists/resolve and disk files; routes.ts, engine.ts, daemon-wiring.ts.
**B6 remaining stronger coverage:** Store permissions, shadowing and recovery are distinct from route response redaction.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L30 | values are stored 0600 (also after an existing file was looser) and never listed | Oracle evidence: assert.equal((await stat(file)).mode & 0o777, 0o600);; assert.equal((await stat(file)).mode & 0o777, 0o600); |
| KEEP L53 | a workflow's own secret shadows a global one; list shows both scopes; deleteForWorkflow removes its own | Oracle evidence: assert.deepEqual(secrets.resolve("wf-1"), { TOKEN: "own-value", BASE: "https://example.test" });; assert.deepEqual(secrets.resolve("wf-2"), { TOKEN: "global-value", BASE: "https://example.test" }); |
| KEEP L83 | names and values are validated: 400 SECRET_INVALID | Oracle evidence: assert.deepEqual(secrets.names(), ["EXACT"]); |
| KEEP L96 | a foreign-version file is moved aside, without quoting a value | Oracle evidence: assert.deepEqual(secrets.list(), []);; assert.ok(aside); |
| KEEP L110 | an unreadable path makes the store read-only (503) and preserves existing content | Oracle evidence: assert.equal(await readFile(sentinel, "utf8"), "original"); |

## `apps/daemon/src/workflows/service.test.ts`

**B1 independent contract:** §3.1 and §8.1 workflow storage/revision contracts. **Source reviewed:** service.ts.
**B4 stable seam / non-test callers:** WorkflowService public operations, reload, disk records and lifecycle events; routes.ts, daemon-wiring.ts, engine.ts.
**B6 remaining stronger coverage:** This owner enforces writes/revision/enable policy; parser tests alone cannot prove durable mutation or publication.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L72 | create → read back; persisted atomically at 0600; a reload lists it | Oracle evidence: assert.equal(created.workflow.name, "Nightly");; assert.equal(created.workflow.revision, 0); |
| KEEP L91 | tolerant load: rejected entries and unknown keys are written back verbatim and never listed | Oracle evidence: assert.deepEqual(service.list().map((w) => w.id), [good.id], "the malformed entry and the repeated id are not listed");; assert.deepEqual(written.futureKey, { keep: true }); |
| KEEP L116 | a corrupt or foreign-version file is moved aside, never overwritten | Oracle evidence: assert.deepEqual(service.list(), []);; assert.ok(aside, `moved aside: ${names.join(", ")}`); |
| KEEP L135 | an unreadable path blocks mutation with 503 WORKFLOWS_UNAVAILABLE and preserves content | Oracle evidence: assert.equal(await readFile(sentinel, "utf8"), "original"); |
| KEEP L146 | revisions: +1 on every write, a stale revision is a 409 naming the current one | Oracle evidence: assert.equal(patched.revision, 1);; assert.equal(replaced.revision, 2); |
| KEEP L167 | a bad patch op is 400 INVALID_WORKFLOW naming the op, and changes nothing | Oracle evidence: assert.equal(error.body().error.opIndex, 1, "the body names the op (the MCP's update_workflow reads it)");; assert.equal(service.get(created.id)!.name, "Nightly"); |
| KEEP L188 | a definition with errors saves disabled, but can never be (or stay) enabled | Oracle evidence: assert.ok(saved.problems.some((p) => p.severity === "error" && p.code === "subworkflow_unset"));; assert.equal(saved.workflow.enabled, false); |
| KEEP L216 | a schema-invalid replace is refused whole | Oracle evidence: assert.deepEqual(service.get(created.id), created); |
| KEEP L230 | limits: the workflow count and the definition size are LIMIT_EXCEEDED | Oracle evidence: assert.equal(service.list().length, 500); |
| KEEP L261 | duplicate: new ids for the workflow, blocks and connections; disabled; pins follow | Oracle evidence: assert.equal(copy.enabled, false);; assert.equal(copy.revision, 0); |
| KEEP L283 | events: upserted after every write, deleted after a delete; the bridge publishes summaries | Oracle evidence: assert.deepEqual(changed, [`${created.id}@0`, `${created.id}@1`]);; assert.deepEqual(deleted, [created.id]); |

## `apps/daemon/src/workflows/services.test.ts`

**B1 independent contract:** §5.3, §5.9–5.11 project addressing, prompt timezone, notifications, resource admission and retention. **Source reviewed:** projects.ts, prompt-renderer.ts, notifier.ts, scheduler-queue.ts, sweepers.ts.
**B4 stable seam / non-test callers:** ProjectOps/PromptRenderer/WorkflowNotifier/SlotPool/WorkflowSweepers contracts; factory.ts and engine.ts; DaemonApi routes for projects/tabs.
**B6 remaining stronger coverage:** Each row owns its distinct adapter/policy result; external services supply input, not selection, eligibility, redaction or retention logic.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L72 | resolveExisting accepts exactly <workspacesDir>/<ws>/<project> | Oracle evidence: assert.deepEqual(await ops.resolveExisting(join(root, "ws", "app")), { path: join(root, "ws", "app"), name: "app", workspace: "ws", temp: false });; assert.deepEqual(await ops.resolveExisting("ws/app"), { path: join(root, "ws", "app"), name: "app", workspace: "ws", temp: false }); |
| KEEP L83 | createTemp and deleteProject go through the daemon's routes | Oracle evidence: assert.deepEqual(created, { path: "/w/ws/wf-x-1", name: "wf-x-1", workspace: "ws", temp: true });; await assert.rejects(ops.deleteProject("/w/ws/locked"), /BUSY: in use/); |
| KEEP L105 | a refused create names the daemon's code | Oracle evidence: await assert.rejects(ops.createTemp({ workspace: "ws", name: "n", source: { kind: "empty" } }), /NO_GIT_ACCOUNT/);; await assert.rejects(detached.createTemp({ workspace: "ws", name: "n", source: { kind: "empty" } }), /not attached/); |
| KEEP L113 | gitStatusShort renders porcelain-style lines within the byte cap | Oracle evidence: assert.equal(await porcelain.gitStatusShort("/w/ws/app", 1024), "M  a.ts\n M b.ts\n?? c.ts\nR  old.ts -> d.ts");; assert.ok(Buffer.byteLength(text) <= 1024); |
| KEEP L134 | renders {variables} with git reads in the workflow's time zone | Oracle evidence: assert.equal(result.ok, true);; assert.match((result as { text: string }).text, /^app on main at .*2026.* by Claude\/Opus$/); |
| KEEP L148 | a failed git read renders nothing and names the variables | Oracle evidence: assert.equal(result.ok, false);; assert.match((result as { reason: string }).reason, /fatal: not a repo.*\{branch\}/); |
| KEEP L173 | pushes per settings.notify, debounced per workflow and kind | Oracle evidence: assert.equal(pushed.length, 2);; assert.deepEqual(pushed.map((payload) => payload.workflowId), ["w1", "w1"]); |
| KEEP L199 | FIFO past the cap; aborted waiters leave the queue; force skips it | Oracle evidence: assert.deepEqual(order, ["third aborted", "second", "fourth"]);; await assert.rejects(pool.acquire(aborter.signal), SlotAbortedError); |
| KEEP L247 | deletes temp projects past deleteAfter and closes old workflow tabs nobody wrote in | Oracle evidence: assert.deepEqual(report.errors, []);; assert.deepEqual(report.tempProjectsDeleted, ["/w/ws/wf-old"]); |
| KEEP L299 | runs hourly on the injected clock and stops cleanly | Oracle evidence: assert.deepEqual(projects.deleted, []);; assert.deepEqual(projects.deleted, ["/w/ws/due"]); |

## `apps/daemon/src/workflows/state-store.test.ts`

**B1 independent contract:** §3 runtime-state separation and §5.8 durable recovery; cache contract in state-store.ts API. **Source reviewed:** state-store.ts.
**B4 stable seam / non-test callers:** WorkflowStateStore update/get/load and fresh-instance disk reads; scheduler.ts, git-poller.ts, agent/cooldowns.ts.
**B6 remaining stronger coverage:** Only this suite owns immediate visibility, snapshots and concurrent durable state mutation; parser tests do not exercise I/O.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L25 | a missing file loads empty, silently; updates persist atomically at 0600 | Oracle evidence: assert.deepEqual(store.get(), { version: 1, schedules: {}, git: {}, cooldowns: {}, etags: {} });; assert.deepEqual(lines, []); |
| KEEP L44 | get() is a snapshot | Oracle evidence: assert.deepEqual(store.get().cooldowns, {}); |
| KEEP L51 | a corrupt file starts empty, is moved aside and logged — never thrown | Oracle evidence: assert.deepEqual(store.get().cooldowns, {});; assert.ok(lines.length > 0); |
| KEEP L66 | bad entries are dropped by the tolerant parse, good ones kept | Oracle evidence: assert.deepEqual(store.get().cooldowns, { "claude:a": cooldown });; assert.deepEqual(store.get().schedules, {}); |
| KEEP L76 | an unreadable path starts empty and logs | Oracle evidence: assert.deepEqual(store.get().cooldowns, {});; assert.ok(lines.length > 0); |
| KEEP L85 | concurrent updates are immediately visible and all become durable | Oracle evidence: assert.deepEqual(Object.keys(store.get().cooldowns), ["claude:1", "claude:2", "claude:3", "claude:4"]);; assert.deepEqual(Object.keys(reloaded.get().cooldowns), ["claude:1", "claude:2", "claude:3", "claude:4"]); |
| KEEP L96 | a throwing mutator changes nothing; a failed write retains changes for the next write | Oracle evidence: await assert.rejects(store.update((draft) => {; assert.deepEqual(store.get().cooldowns, {}); |

## `apps/daemon/src/workflows/storage-fixes.test.ts`

**B1 independent contract:** AGENTS.md unknown-field preservation and prototype safety; §3.1/§5.8; pending-save index regression. **Source reviewed:** config/workflows.ts, API validate.ts, secrets.ts, run-store.ts.
**B4 stable seam / non-test callers:** Public config parse/validation APIs and real persistent stores; WorkflowService, engine.ts, routes.ts.
**B6 remaining stronger coverage:** Config/API owner confirmed no duplicate nested-field/prototype matrix; the index race uniquely reopens while run write is pending.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L42 | a newer build's nested fields survive this build's parse (a save never erases them) | Oracle evidence: assert.equal(value.project.futureProjectKey, 1);; assert.equal(value.settings.notify.futureNotifyKey, "slack"); |
| KEEP L67 | block and connection ids that could key Object.prototype are refused, by the schema and by validation | Oracle evidence: assert.equal(workflowRecordSchema.safeParse(evil).success, false);; assert.equal(file.workflows.length, 0); |
| KEEP L89 | the secrets file keeps what this build cannot read, verbatim, across a write | Oracle evidence: assert.deepEqual(secrets.names("wf-1").sort(), ["OLD", "OWN"]);; assert.deepEqual(written.futureTopLevel, { a: 1 }); |
| KEEP L113 | the secrets store never indexes past its own maps | Oracle evidence: assert.equal(await secrets.delete("hasOwnProperty", "__proto__"), false);; assert.equal(await secrets.delete("TOKEN", "__proto__"), false); |
| KEEP L128 | an unfinished run remains recoverable when the index lands before its pending save | Oracle evidence: assert.deepEqual((await reopened.listUnfinished()).map((entry) => ({ id: entry.id, status: entry.status })), [{ id: "r1", status: "running" }]); |

## `apps/daemon/src/workflows/summary.test.ts`

**B1 independent contract:** §5.11 notification settings and §7.1/§8.1 WorkflowSummary wire contract. **Source reviewed:** summary.ts.
**B4 stable seam / non-test callers:** buildWorkflowSummary result; routes.ts, daemon-wiring.ts; UI notification consumers.
**B6 remaining stronger coverage:** Only summary owner test checks notify reaches open clients; notifier tests cover push policy instead.
**B2/B3/B5:** each KEEP row identifies its exact failure through its descriptive title and original fixed assertion evidence. A behavior-preserving owner refactor must preserve these outcomes. Risk is regression in that named outcome; tests remain unless a DELETE reason names its stronger owner or demonstrates dead code.

| Disposition / original line | Exact test / caller-visible failure | Independent oracle or deletion/rewrite reason |
|---|---|---|
| KEEP L8 | the summary carries settings.notify so open clients honour it | Oracle evidence: assert.deepEqual(defaults.notify, { onFailure: true, onSuccess: false });; assert.deepEqual(custom.notify, { onFailure: false, onSuccess: true }); |

## Completed production/support cleanup

- Removed unused string-stream redaction API and helpers (`SecretRedactor.stream`, `maxSecretLength`, `ChunkRedactor`, `createChunkRedactor`, `redactChunk`, `redactPrefix`) and barrel exports. Whole-text/deep/byte-window redaction remain production-used. Repository search found no non-test string-stream callers.
- Removed test-only engine limit overrides from WorkflowEngineOptions, factory and test harness. Tests exercise real documented limits instead. No production caller supplied a limits override.
- Removed unused factory sandbox/mintId overrides: daemon-wiring is the sole runtime factory caller and supplies neither; retained its actual shared clock dependency.
- Internalized MAX_CLONE_REF_LENGTH after tests stopped importing it.
- Removed imports and local fixtures only used by deleted scenarios, including the unused MCP E2E workspace. Shared daemon harness remains required by retained E2Es.
- Removed unused sandbox environment overrides (`SandboxEnvInput.processEnv`, `launchId`, and `defaultSandboxTmpDir`'s parameter). Repository-wide callers use only the real process environment and a fresh launch UUID. The real sandbox environment isolation test remains the behavior owner; risk is low because production invocation stays identical.
- Removed unused daemon E2E fake Git call recording and the two account fixtures used only by deleted failover/catalogue scenarios. The separate trigger-test fake retains its protocol assertions.

## Validation and final review

- Before edits, the focused baseline E2E-agent, E2E-MCP, integration, engine-fixes and redactor run passed all 34 tests (`/tmp/workflows-engine-baseline.log`). No retained baseline failure was deleted.
- After cleanup, focused engine, engine-resume, engine-fixes, redactor, log-reader and clone-ref checks passed all 93 tests (`/tmp/workflows-engine-focused.log`).
- The complete owned scope passed all 215 tests, 37 suites, with no failures, cancellations or skips (`/tmp/workflows-engine-all.log`): run the command prefix above with `src/workflows/*.test.ts src/workflows/nodes/*.test.ts src/workflows/sandbox/*.test.ts src/workflows/git-remote/*.test.ts`.
- Retained E2Es emitted real persisted artifacts, including `/var/lib/orquester/tmp/orq-workflow-evidence-qeK2N4/results.json` and `/var/lib/orquester/tmp/orq-workflow-evidence-467G33/results.json`. These host-local verification artifacts are not committed.
- The final MCP E2E rerun after removing its unused workspace fixture passed all 3 tests (`/tmp/workflows-engine-mcp-final.log`), with evidence at `/var/lib/orquester/tmp/orq-workflow-evidence-Mxa2dW/results.json`.
- `git diff --check` passed. Final production and test diff reviewed; unused-import scan found none in modified owned files. No production caller used any removed override/export. No production behavior change was needed and no coverage/count gate blocked cleanup.
- The first daemon typecheck exposed a missing explicit response-array type in the rewritten FIFO test, which was fixed; it also observed concurrent agent-profile edits outside this scope. The final `pnpm --filter @orquester/daemon typecheck` had no workflow errors and failed only on concurrent `agent-host/adapters/codex/replay.test.ts:400,402` missing `RuntimeEvent` (`/tmp/workflows-engine-typecheck-final.log`). This was reported to the coordinator. Root owns required repository-wide gates and commit/push.
