import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Workflow } from "@orquester/api";

import { edge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
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

describe("the agent a block shows", () => {
  const codex = [{ agent: "codex", model: "gpt-5.5", accounts: { strategy: "least-used" } }];
  const graph = () =>
    workflow(
      [
        node("t", "trigger.manual", {}, { name: "Start" }),
        node("a", "agent", { chain: codex }, { name: "Review" }),
        node("e", "agent", {}, { name: "Fix" }),
        node("b", "code", {}, { name: "Report" })
      ],
      [edge("t", "a"), edge("a", "b"), edge("t", "e")]
    );

  it("rows carry an agent block's first agent, and nothing for other blocks", () => {
    const rows = deriveSteps(graph(), [], () => "").rows;
    const agentOf = Object.fromEntries(rows.map((row) => [row.nodeId, row.agent]));
    assert.deepEqual(agentOf, { t: undefined, a: "codex", e: "claude", b: undefined });
  });

  it("connect and move candidates carry it too", () => {
    const connect = connectCandidates(graph(), { nodeId: "t", handle: "success" });
    assert.equal(connect.find((c) => c.nodeId === "a")?.agent, "codex");
    assert.equal(connect.find((c) => c.nodeId === "b")?.agent, undefined);
    const move = moveCandidates(graph(), "b", { nodeId: "a", handle: "success" });
    assert.equal(move.find((c) => c.nodeId === "a")?.agent, "codex");
    assert.equal(move.find((c) => c.nodeId === "t")?.agent, undefined);
  });
});

describe("addStepAfter", () => {
  it("splices into a chain without losing downstream connections", () => {
    const mint = sequentialIds();
    const before = chain();
    const { workflow: next, nodeId } = addStepAfter(before, { nodeId: "a", handle: "success" }, "shell", mint);
    assert.deepEqual(edgesOf(next), [`a:success>${nodeId}`, `${nodeId}:success>b`, "t:success>a"].sort());
  });

  it("a block with no outputs (Stop) never splices: it becomes another branch", () => {
    const mint = sequentialIds();
    const { workflow: next, nodeId } = addStepAfter(chain(), { nodeId: "a", handle: "success" }, "stop", mint);
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
    const review = candidates.find((c) => c.nodeId === "a")!;
    assert.notEqual(review.refusal, null);
    assert.equal(candidates.some((c) => c.nodeId === "t"), false, "a trigger takes no input");
    assert.equal(candidates.some((c) => c.nodeId === "b"), false, "not itself");
    const extra = workflow([...chain().nodes, node("s", "stop", {}, { name: "Stop" })], chain().edges);
    const list = connectCandidates(extra, { nodeId: "b", handle: "success" });
    assert.equal(list[0]!.nodeId, "s");
    assert.equal(list[0]!.refusal, null);
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
