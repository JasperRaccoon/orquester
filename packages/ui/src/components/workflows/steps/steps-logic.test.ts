import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Workflow } from "@orquester/api";

import { edge, loopEdge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
import {
  addFirstStep,
  addStepAfter,
  connectCandidates,
  deleteStep,
  deriveSteps,
  duplicateStepAfter,
  moveCandidates,
  moveStepToOutput,
  setStepsDisabled
} from "./steps-logic.ts";

const edgesOf = (wf: Pick<Workflow, "edges">) => wf.edges.map((e) => `${e.source}:${e.sourceHandle}>${e.target}`).sort();

const chain = () =>
  workflow(
    [
      node("t", "trigger.manual", {}, { name: "Start", position: { x: 0, y: 0 } }),
      node("a", "agent", {}, { name: "Review", position: { x: 352, y: 0 } }),
      node("b", "code", {}, { name: "Report", position: { x: 704, y: 0 } })
    ],
    [edge("t", "a"), edge("a", "b")]
  );

describe("addStepAfter", () => {
  it("splices into a chain without losing downstream connections", () => {
    const mint = sequentialIds();
    const before = chain();
    const { workflow: next, nodeId } = addStepAfter(before, { nodeId: "a", handle: "success" }, "shell", mint);
    assert.equal(next.nodes.find((node) => node.id === nodeId)?.type, "shell");
    assert.deepEqual(edgesOf(next), [`a:success>${nodeId}`, `${nodeId}:success>b`, "t:success>a"].sort());
  });

  it("a block with no outputs (Stop) never splices: it becomes another branch", () => {
    const mint = sequentialIds();
    const { workflow: next, nodeId } = addStepAfter(chain(), { nodeId: "a", handle: "success" }, "stop", mint);
    assert.equal(next.nodes.find((node) => node.id === nodeId)?.type, "stop");
    assert.deepEqual(edgesOf(next), ["a:success>b", `a:success>${nodeId}`, "t:success>a"].sort());
  });

  it("the first step goes after the trigger; with no trigger, loose", () => {
    const mint = sequentialIds();
    const lone = workflow([node("t", "trigger.manual")]);
    const first = addFirstStep(lone, "agent", mint);
    assert.deepEqual(edgesOf(first.workflow), [`t:success>${first.nodeId}`]);
    const empty = workflow([]);
    const trigger = addFirstStep(empty, "trigger.schedule", mint);
    assert.deepEqual(trigger.workflow.nodes.map((n) => [n.id, n.type]), [[trigger.nodeId, "trigger.schedule"]]);
    assert.equal(trigger.workflow.edges.length, 0);
  });
});

describe("connect and move", () => {
  it("connect candidates: connectable first, with why the rest cannot", () => {
    const candidates = connectCandidates(chain(), { nodeId: "b", handle: "success" });
    // Review runs before Report: connecting back to it makes a loop (spec 2026-11-10 §7.1).
    const review = candidates.find((c) => c.nodeId === "a")!;
    assert.equal(review.refusal, null);
    assert.equal(review.loop, true);
    assert.equal(candidates.some((c) => c.nodeId === "t"), false, "a trigger takes no input");
    assert.equal(candidates.some((c) => c.nodeId === "b"), false, "not itself");
    const extra = workflow([...chain().nodes, node("s", "stop", {}, { name: "Stop" })], chain().edges);
    const list = connectCandidates(extra, { nodeId: "b", handle: "success" });
    assert.deepEqual(list.map((c) => [c.nodeId, c.loop]), [["a", true], ["s", false]], "connectable ones in outline order");
  });

  it("move to another output: re-hangs the row's edge; loops are refused", () => {
    const mint = sequentialIds();
    const wf = workflow(
      [
        node("t", "trigger.manual", {}, { name: "Start" }),
        node("i", "if", {}, { name: "Check" }),
        node("y", "code", {}, { name: "Yes" }),
        node("z", "code", {}, { name: "After" })
      ],
      [edge("t", "i"), edge("i", "y", "true"), edge("y", "z")]
    );
    const candidates = moveCandidates(wf, "y", { nodeId: "i", handle: "true" });
    assert.equal(candidates.find((c) => c.nodeId === "i" && c.handle === "true")!.current, true);
    assert.notEqual(candidates.find((c) => c.nodeId === "z")!.refusal, null);
    const moved = moveStepToOutput(wf, "y", { nodeId: "i", handle: "true" }, { nodeId: "i", handle: "false" }, mint);
    assert.deepEqual(edgesOf(moved), ["i:false>y", "t:success>i", "y:success>z"]);
    assert.deepEqual(moveStepToOutput(wf, "y", { nodeId: "i", handle: "true" }, { nodeId: "z", handle: "success" }, mint), wf);
  });
});

describe("delete, duplicate, disable", () => {
  it("deleting a middle step heals the chain", () => {
    const mint = sequentialIds();
    const next = deleteStep(chain(), "a", mint);
    assert.deepEqual(edgesOf(next), ["t:success>b"]);
    assert.deepEqual(next.nodes.map((n) => n.id).sort(), ["b", "t"]);
  });

  it("a join (two edges in) is deleted without guessing a heal", () => {
    const mint = sequentialIds();
    const wf = workflow(
      [node("t", "trigger.manual"), node("a", "code"), node("b", "code"), node("m", "merge"), node("z", "code")],
      [edge("t", "a"), edge("t", "b"), edge("a", "m"), edge("b", "m"), edge("m", "z")]
    );
    assert.deepEqual(edgesOf(deleteStep(wf, "m", mint)), ["t:success>a", "t:success>b"]);
  });

  it("duplicate puts the copy right after the original, taking over what it fed", () => {
    const mint = sequentialIds("c");
    const result = duplicateStepAfter(chain(), "a", mint)!;
    const copy = result.nodeId;
    assert.deepEqual(edgesOf(result.workflow), [`a:success>${copy}`, `${copy}:success>b`, "t:success>a"].sort());
  });

  it("disable / enable", () => {
    const off = setStepsDisabled(chain(), ["a"], true);
    assert.deepEqual(off.nodes.filter((n) => n.disabled).map((n) => n.id), ["a"]);
    const on = setStepsDisabled(off, ["a"], false);
    assert.equal(on.nodes.some((n) => n.disabled), false);
  });
});

describe("loops in the step list", () => {
  // Start → Fix → Check(if) ─true→ Ship; Check.false loops back to Fix.
  const looped = () =>
    workflow(
      [
        node("t", "trigger.manual", {}, { name: "Start" }),
        node("fix", "agent", {}, { name: "Fix" }),
        node("chk", "if", {}, { name: "Check" }),
        node("ship", "code", {}, { name: "Ship" })
      ],
      [edge("t", "fix"), edge("fix", "chk"), edge("chk", "ship", "true"), loopEdge("chk", "fix", "false", { maxLoops: 3, session: "new" })]
    );

  it("a loop is a row of its source, not a step of its own", () => {
    const model = deriveSteps(looped(), [{ severity: "warning", code: "loop_x", message: "Mind the loop", edgeId: "chk-false-loop-fix" }], () => "");
    assert.deepEqual(
      model.rows.map((row) => `${row.kind}:${row.nodeId}`),
      ["node:t", "node:fix", "node:chk", "node:ship"],
      "no join-ref back to Fix"
    );
    const check = model.rows.find((row) => row.nodeId === "chk")!;
    assert.equal(check.loops.length, 1);
    assert.equal(check.loops[0]!.text, "↺ back to Fix (max 3, new chat)");
    assert.equal(check.loops[0]!.handleLabel, "false");
    assert.deepEqual(check.loops[0]!.problem, { severity: "warning", message: "Mind the loop" });
    const falseOut = check.outputs.find((output) => output.handle === "false")!;
    assert.equal(falseOut.loop, true);
    assert.deepEqual(falseOut.targets, [], "the loop is not one of the places it leads to");
    assert.equal(model.rows.find((row) => row.nodeId === "fix")!.loops.length, 0);
  });

  it("connecting to a block that runs before makes a loop; the candidate says so", () => {
    const wf = workflow(looped().nodes, looped().edges.filter((e) => !e.loop));
    const candidates = connectCandidates(wf, { nodeId: "chk", handle: "false" });
    const fix = candidates.find((candidate) => candidate.nodeId === "fix")!;
    assert.equal(fix.refusal, null);
    assert.equal(fix.loop, true);
    assert.equal(candidates.find((candidate) => candidate.nodeId === "ship")!.loop, false);
    const failure = connectCandidates(wf, { nodeId: "chk", handle: "error" }).find((candidate) => candidate.nodeId === "fix")!;
    assert.match(failure.refusal!, /failure output/);
  });

  it("moving never makes a loop and never drops a loop edge; a looping output takes nothing", () => {
    const wf = looped();
    const toShip = moveCandidates(wf, "fix", { nodeId: "t", handle: "success" });
    assert.match(toShip.find((c) => c.nodeId === "chk" && c.handle === "true")!.refusal!, /one direction/);
    assert.match(toShip.find((c) => c.nodeId === "chk" && c.handle === "false")!.refusal!, /one direction|loops back/);
    const shipMoves = moveCandidates(wf, "ship", { nodeId: "chk", handle: "true" });
    assert.match(shipMoves.find((c) => c.nodeId === "chk" && c.handle === "false")!.refusal!, /It loops back to Fix/);
    assert.equal(shipMoves.find((c) => c.nodeId === "fix" && c.handle === "success")!.refusal, null, "ancestors are not below it");
    // Fix hangs from Start and is a loop's target: moving it keeps the loop edge into it.
    const wide = workflow([...wf.nodes, node("pre", "code", {}, { name: "Pre" })], [...wf.edges, edge("t", "pre")]);
    const moved = moveStepToOutput(wide, "fix", null, { nodeId: "pre", handle: "success" }, sequentialIds());
    assert.deepEqual(edgesOf(moved), ["chk:false>fix", "chk:true>ship", "fix:success>chk", "pre:success>fix", "t:success>pre"]);
    assert.deepEqual(moved.edges.find((e) => e.loop)?.loop, { maxLoops: 3, session: "new" });
    assert.equal(moveStepToOutput(wf, "ship", { nodeId: "chk", handle: "true" }, { nodeId: "chk", handle: "false" }, sequentialIds()), wf);
  });

  it("deleting a loop's target heals over ordinary edges; its loop edge goes with it", () => {
    const next = deleteStep(looped(), "fix", sequentialIds());
    assert.deepEqual(edgesOf(next), ["chk:true>ship", "t:success>chk"]);
    assert.equal(next.edges.some((e) => e.loop), false);
  });

  it("a duplicate after the loop's source leaves the loop on the original", () => {
    const result = duplicateStepAfter(looped(), "chk", sequentialIds("c"))!;
    const loops = result.workflow.edges.filter((e) => e.loop);
    assert.equal(loops.length, 1);
    assert.equal(loops[0]!.source, "chk");
  });
});
