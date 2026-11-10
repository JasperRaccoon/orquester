import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampMaxLoops,
  convertToLoop,
  convertToOrdinary,
  edgeConversion,
  inLoopBody,
  isAncestor,
  loopCounterOf,
  loopEdgeDescription,
  loopEdgeLabel,
  loopEdgeView,
  loopResetSet,
  loopRowText,
  setLoopSettings
} from "./loops.ts";
import { edge, loopEdge, node, workflow } from "./testing.ts";

const nodes = [
  node("t", "trigger.manual"),
  node("fix", "agent", {}, { name: "Fix" }),
  node("rev", "if", {}, { name: "Review" }),
  node("dep", "shell", {}, { name: "Deploy" }),
  node("side", "code", {}, { name: "Side" })
];
const loop = loopEdge("rev", "fix", "false");
const wf = workflow(nodes, [edge("t", "fix"), edge("fix", "rev"), edge("rev", "dep", "true"), loop]);

describe("loop words", () => {
  it("the step list's row", () => {
    assert.equal(loopRowText("Fix", { maxLoops: 2, session: "continue" }), "↺ back to Fix (max 2, same chat)");
    assert.equal(loopRowText("Fix", { maxLoops: 5, session: "new" }), "↺ back to Fix (max 5, new chat)");
  });

  it("the edge label: settings in the editor, used/max in a run", () => {
    assert.equal(loopEdgeLabel("changes", { maxLoops: 3 }), "↺ changes · max 3");
    assert.equal(loopEdgeLabel("success", { maxLoops: 3 }), "↺ max 3", "a lone success output is not named");
    assert.equal(loopEdgeLabel("changes", { maxLoops: 3 }, { used: 1, max: 3, exhausted: false }), "↺ changes · 1/3");
  });

  it("a description for screen readers", () => {
    assert.equal(
      loopEdgeDescription("Review", "false", "Fix", { maxLoops: 2, session: "new" }, { used: 2, max: 2, exhausted: true }),
      "Review loops back to Fix on false, at most 2 times, in a new chat; used 2 of 2, its limit"
    );
    assert.equal(loopEdgeDescription("Review", null, "Fix", { maxLoops: 1, session: "continue" }), "Review loops back to Fix, at most once, in the same chat");
    // A run that raised the limit ("Allow one more loop"): at most the raised limit, as the label's used/max.
    assert.equal(
      loopEdgeDescription("Review", null, "Fix", { maxLoops: 2, session: "continue" }, { used: 2, max: 3, exhausted: false }),
      "Review loops back to Fix, at most 3 times, in the same chat; used 2 of 3"
    );
  });

  it("the edge view names both ends and the handle", () => {
    const view = loopEdgeView(wf, loop as never)!;
    assert.equal(view.sourceName, "Review");
    assert.equal(view.targetName, "Fix");
    assert.equal(view.handleLabel, "false");
    assert.equal(loopEdgeView(wf, wf.edges[0]!), null);
  });
});

describe("loop counters", () => {
  it("used against the limit, raised by Allow one more loop", () => {
    assert.deepEqual(loopCounterOf(loop, {}), { used: 0, max: 2, exhausted: false });
    assert.deepEqual(loopCounterOf(loop, { loopCounters: { [loop.id]: 2 } }), { used: 2, max: 2, exhausted: true });
    assert.deepEqual(loopCounterOf(loop, { loopCounters: { [loop.id]: 2 }, loopLimits: { [loop.id]: 3 } }), { used: 2, max: 3, exhausted: false });
    assert.equal(loopCounterOf(wf.edges[0]!, {}), null);
  });
});

describe("loop settings", () => {
  it("clamps maxLoops to 1–20 whole numbers", () => {
    assert.equal(clampMaxLoops(0), 1);
    assert.equal(clampMaxLoops(25), 20);
    assert.equal(clampMaxLoops(3.6), 4);
    assert.equal(clampMaxLoops(Number.NaN), 2);
  });

  it("edits a loop edge; the same workflow when nothing changes", () => {
    const next = setLoopSettings(wf, loop.id, { maxLoops: 40, session: "new" });
    assert.deepEqual(next.edges.find((candidate) => candidate.id === loop.id)!.loop, { maxLoops: 20, session: "new" });
    assert.equal(setLoopSettings(wf, loop.id, { maxLoops: 2 }), wf);
    assert.equal(setLoopSettings(wf, "t-success-fix", { maxLoops: 3 }), wf, "an ordinary edge has no settings");
  });
});

describe("converting edges", () => {
  it("an ordinary back-edge can become a loop; a forward one offers nothing", () => {
    const cyclic = workflow(nodes, [edge("t", "fix"), edge("fix", "rev"), edge("rev", "fix", "false")]);
    assert.deepEqual(edgeConversion(cyclic, "rev-false-fix"), { toLoop: null });
    assert.deepEqual(edgeConversion(cyclic, "t-success-fix"), {});
    const fixed = convertToLoop(cyclic, "rev-false-fix");
    assert.deepEqual(fixed.edges.find((candidate) => candidate.id === "rev-false-fix")!.loop, { maxLoops: 2, session: "continue" });
  });

  it("a back-edge from a failure output, or a shared output, cannot become a loop", () => {
    const failure = workflow(nodes, [edge("t", "fix"), edge("fix", "rev"), edge("rev", "fix", "error")]);
    assert.match(edgeConversion(failure, "rev-error-fix").toLoop!, /failure output/);
    assert.equal(convertToLoop(failure, "rev-error-fix"), failure);
    const shared = workflow(nodes, [edge("t", "fix"), edge("fix", "rev"), edge("rev", "fix", "false"), edge("rev", "side", "false")]);
    assert.match(edgeConversion(shared, "rev-false-fix").toLoop!, /output of its own/);
  });

  it("a loop edge stays a loop while its target runs first; else it may become ordinary", () => {
    assert.match(edgeConversion(wf, loop.id).toOrdinary!, /must stay a loop/);
    assert.equal(convertToOrdinary(wf, loop.id), wf);
    const sideways = workflow(nodes, [edge("t", "fix"), loopEdge("dep", "side")]);
    assert.deepEqual(edgeConversion(sideways, "dep-success-loop-side"), { toOrdinary: null });
    const plain = convertToOrdinary(sideways, "dep-success-loop-side");
    assert.equal("loop" in plain.edges.find((candidate) => candidate.id === "dep-success-loop-side")!, false);
  });
});

describe("the forward graph", () => {
  it("ancestors ignore loop edges", () => {
    assert.equal(isAncestor(wf, "fix", "rev"), true);
    assert.equal(isAncestor(wf, "rev", "fix"), false, "only the loop edge leads back");
    assert.equal(isAncestor(wf, "fix", "fix"), false);
  });

  it("the reset set: the target and everything downstream of it", () => {
    assert.deepEqual(loopResetSet(wf, loop).map((n) => n.name), ["Fix", "Review", "Deploy"]);
  });

  it("the loop body: its target and what follows it", () => {
    assert.equal(inLoopBody(wf, "fix"), true);
    assert.equal(inLoopBody(wf, "rev"), true);
    assert.equal(inLoopBody(wf, "dep"), true);
    assert.equal(inLoopBody(wf, "t"), false);
    assert.equal(inLoopBody(wf, "side"), false);
  });
});
