import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowGateState } from "@orquester/api";

import {
  choicePastTense,
  commentRule,
  decisionToastText,
  gateAttentionRows,
  gateChoiceDestinations,
  gateDeciderNote,
  gateNeedsPerson,
  gateRecordLine,
  gatesOfNode,
  gateTitle,
  mergeGate,
  runGateBadge,
  sanitizeDecideAnswer,
  sanitizeGateList,
  sanitizeGateState,
  waitingGatesOfWorkflow
} from "./gates.ts";
import { edge, node, workflow } from "./testing.ts";

const T0 = "2026-11-10T10:00:00.000Z";

function gate(overrides: Partial<WorkflowGateState> = {}): WorkflowGateState {
  return {
    gateId: "g1",
    runId: "r1",
    workflowId: "wf-1",
    nodeId: "Gate",
    nodeName: "Gate",
    source: "gate",
    question: "Deploy v2?",
    choices: [
      { id: "approve", label: "Approve", color: "primary", comment: "none" },
      { id: "reject", label: "Reject", color: "danger", comment: "optional" }
    ],
    decider: { kind: "human", label: "you" },
    phase: "person",
    openedAt: T0,
    escalated: false,
    ...overrides
  };
}

describe("gates off the wire", () => {
  it("keeps what it can trust, defaults the rest, and drops a gate without its identity", () => {
    const parsed = sanitizeGateState({
      gateId: "g1",
      runId: "r1",
      workflowId: "wf-1",
      nodeId: "n1",
      question: "Ship?",
      choices: [{ id: "yes", label: " Yes ", color: "neon", comment: "maybe" }, { id: "" }, "no", { id: "no", label: "" }],
      decider: { kind: "robot", label: "" },
      phase: "later",
      openedAt: T0,
      escalated: "yes",
      pass: 2.7,
      decision: { choice: "yes", comment: "  ", decidedBy: { kind: "alien", label: "Ana", sessionId: 3 }, decidedAt: T0 },
      cancelled: "no",
      test: true,
      extra: 1
    });
    assert.deepEqual(parsed, {
      gateId: "g1",
      runId: "r1",
      workflowId: "wf-1",
      nodeId: "n1",
      nodeName: "n1",
      source: "gate",
      question: "Ship?",
      choices: [
        { id: "yes", label: "Yes", comment: "none" },
        { id: "no", label: "no", comment: "none" }
      ],
      decider: { kind: "human", label: "you" },
      phase: "person",
      openedAt: T0,
      escalated: false,
      pass: 2,
      decision: { choice: "yes", decidedBy: { kind: "human", label: "Ana" }, decidedAt: T0 },
      test: true
    });
    for (const missing of ["gateId", "runId", "workflowId", "nodeId"]) {
      const value: Record<string, unknown> = { gateId: "g", runId: "r", workflowId: "w", nodeId: "n" };
      delete value[missing];
      assert.equal(sanitizeGateState(value), null, missing);
    }
    assert.equal(sanitizeGateState("g"), null);
  });

  it("reads the daemon's loop-limit gate as it sends it; an expired gate no longer waits", () => {
    // As the engine records it (apps/daemon/src/workflows/engine.ts `waitAtLoopLimit`).
    const wire = {
      gateId: "id-7",
      runId: "r1",
      workflowId: "wf-1",
      nodeId: "review",
      nodeName: "Review",
      pass: 3,
      source: "loop_limit",
      edgeId: "review-loop-fix",
      question: "Review → Fix reached its limit (2).",
      details: "The loop back to Fix already ran 2 loops. **Allow one more loop** runs Fix again once more; **Stop** ends the loop: Review fails, and with it the run.",
      choices: [
        { id: "allow", label: "Allow one more loop", color: "primary", comment: "none" },
        { id: "stop", label: "Stop", color: "danger", comment: "none" }
      ],
      decider: { kind: "human", label: "you" },
      phase: "person",
      openedAt: T0,
      phaseStartedAt: T0,
      phaseDeadlineAt: "2026-11-17T10:42:00.000Z",
      escalated: false
    };
    const parsed = sanitizeGateState(wire)!;
    assert.deepEqual(parsed, wire, "nothing the daemon sends is lost");
    assert.equal(gateNeedsPerson(parsed), true);
    const expired = sanitizeGateState({ ...wire, expired: true, escalationReason: "x" })!;
    assert.equal(expired.expired, true);
    assert.equal(expired.escalationReason, "x");
    assert.equal(gateNeedsPerson(expired), false, "an expired gate leaves the attention rows");
    assert.equal(mergeGate(parsed, expired).expired, true);
    assert.equal(mergeGate(expired, parsed).expired, true, "it never waits again");
  });

  it("reads a run's map and an update's array alike", () => {
    const one = { gateId: "g1", runId: "r", workflowId: "w", nodeId: "n" };
    assert.equal(sanitizeGateList([one, null, {}]).length, 1);
    assert.equal(sanitizeGateList({ g1: one, g2: { ...one, gateId: "g2" } }).length, 2);
    assert.deepEqual(sanitizeGateList("x"), []);
  });

  it("reads a decide answer, its decision falling back to the gate's", () => {
    const decided = gate({ decision: { choice: "reject", decidedBy: { kind: "agent", label: "Reviewer" }, decidedAt: T0 } });
    assert.deepEqual(sanitizeDecideAnswer({ alreadyDecided: true, gate: decided }), {
      alreadyDecided: true,
      gate: decided,
      decision: decided.decision
    });
    assert.equal(sanitizeDecideAnswer({ alreadyDecided: false }), null);
  });
});

describe("a gate never goes backwards", () => {
  it("a settled gate never waits again, the person phase never returns to its agent, the first decision stands", () => {
    const agent = gate({ phase: "agent", decider: { kind: "agent", label: "Reviewer" } });
    const person = gate({ escalated: true });
    const decided = gate({ decision: { choice: "approve", decidedBy: { kind: "human", label: "you" }, decidedAt: T0 } });
    const cancelled = gate({ cancelled: true });
    assert.equal(mergeGate(undefined, agent), agent);
    assert.equal(mergeGate(agent, person), person);
    assert.equal(mergeGate(person, agent), person);
    assert.equal(mergeGate(person, decided), decided);
    assert.equal(mergeGate(decided, person), decided);
    assert.equal(mergeGate(decided, cancelled), decided);
    assert.equal(mergeGate(cancelled, decided), decided);
  });

  it("a run's copy keeps the list row's workflow name and project", () => {
    const listed = gate({ workflowName: "Deploy", projectPath: "/w/a/app" });
    const update = gate({ escalated: true });
    assert.deepEqual(mergeGate(listed, update), { ...update, workflowName: "Deploy", projectPath: "/w/a/app" });
  });
});

describe("where each choice leads", () => {
  const nodes = [
    node("T", "trigger.manual"),
    node("Fix", "agent"),
    node("Gate", "gate"),
    node("Deploy", "shell"),
    node("Notify", "http")
  ];

  it("names the next block, the loop target, or the end", () => {
    const definition = workflow(nodes, [
      edge("T", "Fix"),
      edge("Fix", "Gate"),
      edge("Gate", "Deploy", "choice:approve"),
      edge("Gate", "Notify", "choice:approve")
    ]);
    const loop = { ...edge("Gate", "Fix", "choice:reject", "loop-1"), loop: { maxLoops: 3, session: "continue" as const } };
    const looped = { ...definition, edges: [...definition.edges, loop] };
    const destinations = gateChoiceDestinations(looped, gate());
    assert.deepEqual(destinations.approve, { kind: "next", text: "→ Deploy, Notify", spoken: "goes on to Deploy, Notify" });
    assert.deepEqual(destinations.reject, { kind: "loop", text: "↺ Fix", spoken: "loops back to Fix" });
    assert.deepEqual(gateChoiceDestinations(definition, gate()).reject, { kind: "end", text: "→ End", spoken: "ends this path" });
    assert.deepEqual(gateChoiceDestinations(null, gate()), {});
  });

  it("a loop-limit gate: “Stop” fails the source block, the other choice loops again", () => {
    const loop = { ...edge("Review", "Fix", "success", "loop-1"), loop: { maxLoops: 3, session: "continue" as const } };
    const definition = workflow([node("T", "trigger.manual"), node("Fix", "agent"), node("Review", "agent"), node("Alert", "http")], [
      edge("T", "Fix"),
      edge("Fix", "Review")
    ]);
    const limitGate = gate({
      nodeId: "Review",
      nodeName: "Review",
      source: "loop_limit",
      edgeId: "loop-1",
      question: "",
      choices: [
        { id: "allow", label: "Allow one more loop", comment: "none" },
        { id: "stop", label: "Stop", color: "danger", comment: "none" }
      ]
    });
    const withLoop = { ...definition, edges: [...definition.edges, loop] };
    assert.deepEqual(gateChoiceDestinations(withLoop, limitGate), {
      allow: { kind: "loop", text: "↺ Fix", spoken: "loops back to Fix" },
      stop: { kind: "end", text: "→ End (fails)", spoken: "fails the step" }
    });
    const withFailure = { ...withLoop, edges: [...withLoop.edges, edge("Review", "Alert", "error")] };
    assert.equal(gateChoiceDestinations(withFailure, limitGate).stop?.text, "→ Alert");
    assert.equal(gateTitle(limitGate, withLoop), "Review → Fix reached its limit (3)");
    // The daemon's question names the limit when it asked: a later raise does not rewrite it.
    assert.equal(gateTitle({ ...limitGate, question: "Review → Fix reached its limit (3)." }, withLoop, { "loop-1": 4 }), "Review → Fix reached its limit (3).");
    assert.equal(gateTitle(limitGate, withLoop, { "loop-1": 4 }), "Review → Fix reached its limit (4)");
    assert.equal(gateTitle(limitGate, null), "Review's loop reached its limit");
    assert.equal(gateTitle({ ...limitGate, question: "Review → Fix reached its limit (3)." }, null), "Review → Fix reached its limit (3).");
  });
});

describe("the card's words", () => {
  it("says an agent is deciding, only while it is", () => {
    assert.equal(
      gateDeciderNote(gate({ phase: "agent", decider: { kind: "agent", label: "reviewer (claude)" } })),
      "Reviewer (claude) is deciding; you can decide first."
    );
    assert.equal(gateDeciderNote(gate()), null);
    assert.equal(gateDeciderNote(gate({ phase: "agent", cancelled: true })), null);
  });

  it("past tense for one-word labels, quotes for the rest", () => {
    assert.equal(choicePastTense("Approve"), "approved");
    assert.equal(choicePastTense("Reject"), "rejected");
    assert.equal(choicePastTense("Deny"), "denied");
    assert.equal(choicePastTense("Merged"), "merged");
    assert.equal(choicePastTense("Allow one more loop"), "“Allow one more loop”");
  });

  it("the record line once settled; nothing while it waits", () => {
    const clock = (iso: string) => (iso === T0 ? "10:42" : "?");
    assert.equal(gateRecordLine(gate(), clock), null);
    assert.equal(
      gateRecordLine(gate({ decision: { choice: "approve", comment: "looks good", decidedBy: { kind: "human", label: "you" }, decidedAt: T0 } }), clock),
      "approved by you, 10:42: looks good"
    );
    assert.equal(
      gateRecordLine(gate({ decision: { choice: "reject", decidedBy: { kind: "timeout", label: "after 1 d" }, decidedAt: T0 } }), clock),
      "rejected by timeout, 10:42"
    );
    assert.equal(gateRecordLine(gate({ cancelled: true }), clock), "Cancelled with the run");
    assert.equal(gateRecordLine(gate({ expired: true }), clock), "Expired: nobody decided in time");
    // A loop-limit gate's choices.
    const limit = gate({ choices: [{ id: "allow", label: "Allow one more loop", comment: "none" }, { id: "stop", label: "Stop", color: "danger", comment: "none" }] });
    assert.equal(gateRecordLine({ ...limit, decision: { choice: "stop", decidedBy: { kind: "human", label: "you" }, decidedAt: T0 } }, clock), "stopped by you, 10:42");
    assert.equal(gateRecordLine({ ...limit, decision: { choice: "allow", decidedBy: { kind: "human", label: "you" }, decidedAt: T0 } }, clock), "“Allow one more loop” by you, 10:42");
    assert.equal(choicePastTense("Ship"), "shipped");
    assert.equal(choicePastTense("Edit"), "edited");
    assert.equal(choicePastTense("Allow"), "allowed");
  });

  it("the toast: sent, or who decided first", () => {
    assert.equal(decisionToastText({ alreadyDecided: false, gate: gate() }, "approve"), "Approve: sent");
    const first = { choice: "reject", decidedBy: { kind: "human" as const, label: "Ana" }, decidedAt: T0 };
    assert.equal(decisionToastText({ alreadyDecided: true, decision: first, gate: gate({ decision: first }) }, "approve"), "Already decided: Reject by Ana");
  });

  it("Send waits for a required comment only", () => {
    assert.deepEqual(commentRule({ comment: "none" }, ""), { asks: false, required: false, canSend: true });
    assert.deepEqual(commentRule({ comment: "optional" }, ""), { asks: true, required: false, canSend: true });
    assert.deepEqual(commentRule({ comment: "required" }, "  "), { asks: true, required: true, canSend: false });
    assert.deepEqual(commentRule({ comment: "required" }, "because"), { asks: true, required: true, canSend: true });
  });
});

describe("attention and badges", () => {
  const gates = {
    r1: {
      g1: gate({ openedAt: "2026-11-10T10:05:00.000Z", projectPath: "/w/acme/app", workflowName: "Deploy" }),
      g2: gate({ gateId: "g2", phase: "agent" }),
      g3: gate({ gateId: "g3", decision: { choice: "approve", decidedBy: { kind: "human", label: "you" }, decidedAt: T0 } })
    },
    r2: {
      g1: gate({ runId: "r2", workflowId: "wf-2", openedAt: T0 }),
      g4: gate({ runId: "r2", gateId: "g4", workflowId: "wf-2", test: true })
    },
    child: { g5: gate({ runId: "child", gateId: "g5", workflowId: "wf-child", rootRunId: "r1", nodeId: "Inner" }) }
  };

  it("a row per gate waiting for the person, never a test run's, oldest first, names filled in", () => {
    const rows = gateAttentionRows(gates, {
      workflowName: (id) => (id === "wf-2" ? "Nightly" : undefined),
      runProjectPath: (id) => (id === "r2" ? "/w/acme/api/" : undefined)
    });
    assert.deepEqual(
      rows.map((row) => [row.key, row.workflowName, row.projectName ?? null]),
      [
        ["child/g5", "Workflow", null],
        ["r2/g1", "Nightly", "api"],
        ["r1/g1", "Deploy", "app"]
      ]
    );
    assert.equal(rows[2]!.question, "Deploy v2?");
  });

  it("a workflow's card holds its waiting gates and its child runs' ones", () => {
    const list = waitingGatesOfWorkflow(gates, "wf-1", (runId) => (runId === "r1" ? "wf-1" : undefined));
    assert.deepEqual(
      list.map((entry) => `${entry.runId}/${entry.gateId}`).sort(),
      ["child/g5", "r1/g1", "r1/g2"]
    );
    assert.deepEqual(waitingGatesOfWorkflow(gates, "wf-2", () => undefined).map((entry) => entry.gateId), ["g1"]);
  });

  it("a block's gates, newest first", () => {
    assert.deepEqual(gatesOfNode(gates.r1, "Gate").map((entry) => entry.gateId), ["g1", "g2", "g3"]);
    assert.deepEqual(gatesOfNode(undefined, "Gate"), []);
  });

  it("a run row's badge", () => {
    assert.deepEqual(runGateBadge({ pendingGates: 2, pendingPersonGates: 1 }), { tone: "warn", text: "Needs you" });
    assert.deepEqual(runGateBadge({ pendingGates: 3, pendingPersonGates: 2 }), { tone: "warn", text: "Needs you · 2" });
    assert.deepEqual(runGateBadge({ pendingGates: 1 }), { tone: "info", text: "Awaiting a decision" });
    assert.equal(runGateBadge({}), null);
  });
});
