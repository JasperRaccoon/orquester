import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow } from "@orquester/api";

import type { PersistedBlockState, PersistedRun } from "../contracts.ts";
import { edge, node, workflow } from "../testing/fakes.ts";
import { onLoopLimitReached } from "./limit.ts";
import {
  applyLoopReset,
  loopCount,
  loopEdgeTaken,
  loopFeedbackOf,
  loopLimit,
  loopNamespace,
  nodeLoopContext,
  pendingInterruptions,
  settleInterruptedPass,
  storageAttempt,
  type LoopEdge
} from "./state.ts";

const NOW = "2026-09-28T10:30:00.000Z";

function loopEdge(source: string, target: string, handle: string, maxLoops = 2, id = `${source}-loop-${target}`) {
  return { ...edge(source, target, handle, id), loop: { maxLoops, session: "continue" as const } };
}

/** T → A → B → Check(if); Check.false ↺ A; Check.true → Done; T → Side. */
function def(): Workflow {
  return workflow(
    "w1",
    [
      node("T", "trigger.manual"),
      node("A", "code"),
      node("B", "code"),
      node("Check", "if"),
      node("Done", "code"),
      node("Side", "code")
    ],
    [edge("T", "A"), edge("A", "B"), edge("B", "Check"), loopEdge("Check", "A", "false"), edge("Check", "Done", "true"), edge("T", "Side")]
  );
}

function block(nodeId: string, patch: Partial<PersistedBlockState> = {}): PersistedBlockState {
  return { nodeId, name: nodeId, type: "code", status: "succeeded", attempt: 1, startedAt: "2026-09-28T10:00:00.000Z", endedAt: "2026-09-28T10:01:00.000Z", ...patch };
}

function run(definition: Workflow, blocks: Record<string, PersistedBlockState>, extra: Partial<PersistedRun> = {}): PersistedRun {
  return {
    version: 1,
    id: "run-1",
    workflowId: definition.id,
    workflowName: definition.name,
    status: "running",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: "2026-09-28T10:00:00.000Z",
    definition,
    triggerPayload: { kind: "manual", input: null },
    blocks,
    takenEdges: [],
    deadEdges: [],
    depth: 0,
    ...extra
  };
}

describe("loop state", () => {
  test("loopEdgeTaken finds a handle's loop edge (never from error); count and limit read the run", () => {
    const d = def();
    const taken = loopEdgeTaken(d, "Check", "false")!;
    assert.equal(taken.id, "Check-loop-A");
    assert.equal(loopEdgeTaken(d, "Check", "true"), undefined);
    assert.equal(loopEdgeTaken(d, "Check", undefined), undefined);
    assert.equal(loopEdgeTaken(d, "B", "success"), undefined);
    assert.equal(loopCount({}, taken.id), 0);
    assert.equal(loopCount({ loopCounters: { [taken.id]: 2 } }, taken.id), 2);
    assert.equal(loopLimit({}, taken), 2);
    assert.equal(loopLimit({ loopLimits: { [taken.id]: 4 } }, taken), 4, "a raised limit");
    assert.equal(loopLimit({ loopLimits: { [taken.id]: 1 } }, taken), 2, "never below maxLoops");
  });

  test("the reset set gets new passes: archived, attempts counted on, the target's feedback; the rest untouched", () => {
    const d = def();
    const r = run(d, {
      T: block("T", { type: "trigger.manual" }),
      A: block("A", { attempt: 2, output: { a: 1 }, outputFile: "/runs/A/2/output.json" }),
      B: block("B", { status: "running", endedAt: undefined, waitingOn: { kind: "process", pid: 7, starttime: 1, attemptDir: "/runs/B/1", deadlineAt: NOW } }),
      Check: block("Check", { type: "if", handle: "false", output: null }),
      Done: block("Done", { status: "pending", attempt: 0, startedAt: undefined, endedAt: undefined }),
      Side: block("Side", { status: "running", endedAt: undefined })
    });
    const edgeTaken = loopEdgeTaken(d, "Check", "false")!;
    const result = applyLoopReset({ run: r, def: d, edge: edgeTaken, sourceId: "Check", inFlight: new Set(["B", "Check", "Side"]), feedback: "try again", now: NOW });
    assert.deepEqual(result.reset, ["A", "B", "Check", "Done"]);
    assert.deepEqual(result.interrupt, ["B"], "the source's own execution is ending; Side is outside the set");
    assert.deepEqual(result.unfinished, ["B"]);
    assert.deepEqual(r.loopCounters, { [edgeTaken.id]: 1 });

    const a = r.blocks.A!;
    assert.equal(a.status, "pending");
    assert.equal(a.pass, 2);
    assert.equal(a.attempt, 0);
    assert.equal(a.passAttemptBase, 2, "storage goes on from attempt 2");
    assert.equal(storageAttempt(a, 1), 3);
    assert.equal(a.loopFeedback, "try again");
    assert.equal(a.loopEdgeId, edgeTaken.id);
    assert.equal(a.output, undefined);
    assert.deepEqual(a.passes!.map((pass) => [pass.pass, pass.status, pass.outputFile]), [[1, "succeeded", "/runs/A/2/output.json"]]);

    const b = r.blocks.B!;
    assert.equal(b.pass, 2);
    assert.equal(b.loopFeedback, undefined, "only the target gets feedback");
    const stopped = b.passes![0]!;
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.error?.kind, "interrupted");
    assert.equal(stopped.endedAt, NOW);
    assert.deepEqual(stopped.interruptedFrom, { kind: "process", pid: 7, starttime: 1, attemptDir: "/runs/B/1", deadlineAt: NOW });
    assert.equal("waitingOn" in b, false);

    assert.equal(r.blocks.Check!.pass, 2);
    const done = r.blocks.Done!;
    assert.equal(done.pass, undefined, "a block that did not run in this pass keeps its pass");
    assert.equal(done.passes, undefined);
    assert.equal(done.loopEdgeId, edgeTaken.id);
    assert.equal(r.blocks.T!.pass, undefined, "before the target: untouched");
    assert.equal(r.blocks.Side!.status, "running", "a parallel branch outside the set: untouched");

    assert.deepEqual(pendingInterruptions(r).map((entry) => entry.nodeId), ["B"]);
    assert.equal(settleInterruptedPass(r.blocks.B), true);
    assert.equal(settleInterruptedPass(r.blocks.B), false);
    assert.deepEqual(pendingInterruptions(r), []);
  });

  test("a timer wait leaves nothing to stop; an executing block that had not started still gets a fresh object", () => {
    const d = def();
    const queued = block("B", { status: "queued", startedAt: undefined, endedAt: undefined, attempt: 0 });
    const r = run(d, {
      A: block("A", { status: "waiting", waitingOn: { kind: "timer", until: NOW, purpose: "retry-delay" } }),
      B: queued,
      Check: block("Check", { type: "if", handle: "false" })
    });
    const result = applyLoopReset({ run: r, def: d, edge: loopEdgeTaken(d, "Check", "false")!, sourceId: "Check", inFlight: new Set(["A", "B", "Check"]), now: NOW });
    assert.deepEqual(result.interrupt, ["A", "B"]);
    assert.equal(r.blocks.A!.passes![0]!.interruptedFrom, undefined, "a timer has no side effect to stop");
    assert.notEqual(r.blocks.B, queued, "a fresh object: the stale execution is told by it");
    assert.equal(r.blocks.B!.status, "pending");
    assert.equal(r.blocks.B!.pass, undefined);
    assert.equal(r.blocks.A!.loopFeedback, undefined, "no feedback given");
  });

  test("an outer loop resets the counters of the loops inside what it runs again", () => {
    const d = workflow(
      "w1",
      [node("T", "trigger.manual"), node("Outer", "code"), node("Inner", "code"), node("InnerCheck", "if"), node("OuterCheck", "if"), node("Before", "code"), node("Elsewhere", "if")],
      [
        edge("T", "Before"),
        edge("Before", "Outer"),
        edge("Outer", "Inner"),
        edge("Inner", "InnerCheck"),
        loopEdge("InnerCheck", "Inner", "false"),
        edge("InnerCheck", "OuterCheck", "true"),
        loopEdge("OuterCheck", "Outer", "false"),
        edge("T", "Elsewhere"),
        loopEdge("Elsewhere", "Before", "false", 2, "elsewhere-loop")
      ]
    );
    const r = run(d, { Outer: block("Outer"), Inner: block("Inner"), InnerCheck: block("InnerCheck"), OuterCheck: block("OuterCheck") }, {
      loopCounters: { "InnerCheck-loop-Inner": 2, "OuterCheck-loop-Outer": 0, "elsewhere-loop": 1 }
    });
    applyLoopReset({ run: r, def: d, edge: loopEdgeTaken(d, "OuterCheck", "false")!, sourceId: "OuterCheck", inFlight: new Set(), now: NOW });
    assert.deepEqual(r.loopCounters, { "OuterCheck-loop-Outer": 1, "elsewhere-loop": 1 }, "the inner loop's budget is fresh; an unrelated loop keeps its count");
  });

  test("feedback: an agent's report summary (else its output's), a gate's choice label and comment, nothing for If", () => {
    const agent = node("Review", "agent");
    assert.equal(loopFeedbackOf(agent, { report: { summary: "  Fix the null check. ", sessionId: "s", reportedAt: NOW } }, { summary: "older" }), "Fix the null check.");
    assert.equal(loopFeedbackOf(agent, {}, { text: "x", summary: "From the output" }), "From the output");
    assert.equal(loopFeedbackOf(agent, {}, { text: "no report" }), undefined);
    assert.equal(loopFeedbackOf(agent, {}, { summary: "   " }), undefined);
    const gate = node("Approve", "gate", { choices: [{ id: "approve", label: "Approve" }, { id: "rework", label: "Send back", comment: "required" }] });
    assert.equal(loopFeedbackOf(gate, {}, { choice: "rework", comment: "Tests are missing" }), "Send back: Tests are missing");
    assert.equal(loopFeedbackOf(gate, {}, { choice: "rework" }), "Send back");
    assert.equal(loopFeedbackOf(gate, {}, { choice: "unknown_id" }), "unknown_id");
    assert.equal(loopFeedbackOf(node("Check", "if"), {}, { anything: true }), undefined);
    assert.equal(loopFeedbackOf(agent, {}, { summary: "x".repeat(9_000) })!.length, 8_001, "cut at 8 000 characters");
  });

  test("the loop context an executor gets, from pass 2 on", () => {
    const d = def();
    const r = run(d, { A: block("A"), B: block("B"), Check: block("Check", { type: "if" }) });
    const taken = loopEdgeTaken(d, "Check", "false")!;
    assert.equal(nodeLoopContext(r, d, r.blocks.A!), undefined, "pass 1: none");
    applyLoopReset({ run: r, def: d, edge: taken, sourceId: "Check", inFlight: new Set(), feedback: "more tests", now: NOW });
    const target = nodeLoopContext(r, d, r.blocks.A!)!;
    assert.deepEqual(
      { ...target, previous: target.previous?.status },
      { pass: 2, edgeId: taken.id, loopPass: 2, maxPasses: 3, session: "continue", target: true, sourceName: "Check", targetName: "A", feedback: "more tests", previous: "succeeded" }
    );
    const other = nodeLoopContext(r, d, r.blocks.B!)!;
    assert.equal(other.target, false);
    assert.equal(other.feedback, undefined);
    assert.deepEqual(loopNamespace(r.blocks.A), { pass: 2, feedback: "more tests" });
    assert.deepEqual(loopNamespace(r.blocks.B), { pass: 2 });
    assert.deepEqual(loopNamespace(undefined), { pass: 1 });
  });

  test("the loop-limit decision fails the pass with loop_limit, naming the edge and its limit", () => {
    const taken = loopEdgeTaken(def(), "Check", "false") as LoopEdge;
    const decision = onLoopLimitReached({ edge: taken, sourceName: "Check", targetName: "A", limit: 2 });
    assert.equal(decision.kind, "fail");
    assert.equal(decision.error.kind, "loop_limit");
    assert.equal(decision.error.message, "Check → A reached its limit (2 loops).");
    assert.deepEqual(decision.error.detail, { edgeId: taken.id, limit: 2 });
  });
});
