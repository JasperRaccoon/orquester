import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTemplate, createWorkflowFromRequest, type Workflow } from "@orquester/api";

import { edge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
import {
  addFirstStep,
  addStepAfter,
  connectCandidates,
  connectStep,
  deleteStep,
  deriveSteps,
  duplicateStepAfter,
  moveCandidates,
  moveStepToOutput,
  setStepsDisabled
} from "./steps-logic.ts";

const summary = (n: { name: string }) => `about ${n.name}`;
const edgesOf = (wf: Pick<Workflow, "edges">) => wf.edges.map((e) => `${e.source}:${e.sourceHandle}>${e.target}`).sort();
const nameOf = (wf: Pick<Workflow, "nodes">, id: string) => wf.nodes.find((n) => n.id === id)!.name;

const chain = () =>
  workflow(
    [
      node("t", "trigger.manual", {}, { name: "Start", position: { x: 0, y: 0 } }),
      node("a", "agent", {}, { name: "Review", position: { x: 352, y: 0 } }),
      node("b", "code", {}, { name: "Report", position: { x: 704, y: 0 } })
    ],
    [edge("t", "a"), edge("a", "b")]
  );

describe("deriveSteps", () => {
  it("dresses the outline: names, summaries, outputs and their wiring, problems", () => {
    const wf = workflow(
      [
        node("t", "trigger.manual", {}, { name: "Start" }),
        node("i", "if", {}, { name: "Check" }),
        node("y", "code", {}, { name: "Yes" }),
        node("n", "stop", {}, { name: "No" }),
        node("loose", "shell", {}, { name: "Loose", disabled: true })
      ],
      [edge("t", "i"), edge("i", "y", "true"), edge("i", "n", "false")]
    );
    const model = deriveSteps(
      wf,
      [
        { code: "x", severity: "error", nodeId: "y", message: "Yes: the source is empty" },
        { code: "w", severity: "warning", nodeId: "y", message: "a warning" },
        { code: "i", severity: "info", nodeId: "y", message: "info is not counted" }
      ],
      summary
    );
    assert.deepEqual(
      model.rows.map((row) => [row.name, row.depth, row.via?.label ?? null]),
      [
        ["Start", 0, null],
        ["Check", 0, null],
        ["Yes", 1, "true"],
        ["No", 1, "false"],
        ["Loose", 0, null]
      ]
    );
    const check = model.rows[1]!;
    assert.deepEqual(
      check.outputs.map((out) => [out.label, out.connected, out.tone]),
      [
        ["true", true, "ok"],
        ["false", true, "neutral"],
        ["failure", false, "danger"]
      ]
    );
    const yes = model.rows[2]!;
    assert.equal(yes.errors, 1);
    assert.equal(yes.warnings, 1);
    assert.equal(yes.firstProblem, "the source is empty");
    assert.equal(yes.summary, "about Yes");
    const loose = model.rows[4]!;
    assert.equal(loose.unreachable, true);
    assert.equal(loose.firstUnreachable, true);
    assert.equal(loose.disabled, true);
    assert.equal(model.hasTrigger, true);
    assert.equal(model.blockCount, 5);
  });

  it("a plain success child is not labelled; a join lists what leads into it", () => {
    const wf = workflow(
      [
        node("t", "trigger.manual", {}, { name: "Start" }),
        node("i", "if", {}, { name: "Check" }),
        node("y", "code", {}, { name: "Yes" }),
        node("m", "merge", {}, { name: "Join" })
      ],
      [edge("t", "i"), edge("i", "y", "true"), edge("i", "m", "false"), edge("y", "m")]
    );
    const rows = deriveSteps(wf, [], summary).rows;
    const join = rows.find((row) => row.kind === "node" && row.nodeId === "m")!;
    assert.deepEqual(join.joinOf.sort(), ["Check", "Yes"]);
    assert.ok(rows.some((row) => row.kind === "join-ref" && row.nodeId === "m"));
    assert.equal(rows[1]!.via, null, "Check hangs from a trigger's only output");
  });

  it("an empty workflow has no trigger", () => {
    const model = deriveSteps(workflow([]), [], summary);
    assert.deepEqual(model, { rows: [], hasTrigger: false, blockCount: 0 });
  });
});

describe("addStepAfter", () => {
  it("splices into a chain: the new block goes between, downstream shifts a column right", () => {
    const mint = sequentialIds();
    const before = chain();
    const { workflow: next, nodeId } = addStepAfter(before, { nodeId: "a", handle: "success" }, "shell", mint);
    assert.deepEqual(edgesOf(next), [`a:success>${nodeId}`, `${nodeId}:success>b`, "t:success>a"].sort());
    const report = next.nodes.find((n) => n.id === "b")!;
    const added = next.nodes.find((n) => n.id === nodeId)!;
    assert.ok(report.position.x > added.position.x, "the rest of the chain moved right of it");
    assert.equal(added.position.x, 704);
  });

  it("an unconnected output: added and connected, placed right of its source", () => {
    const mint = sequentialIds();
    const { workflow: next, nodeId } = addStepAfter(chain(), { nodeId: "b", handle: "success" }, "http", mint);
    assert.ok(edgesOf(next).includes(`b:success>${nodeId}`));
    assert.ok(next.nodes.find((n) => n.id === nodeId)!.position.x > 704);
  });

  it("a block with no outputs (Stop) never splices: it becomes another branch", () => {
    const mint = sequentialIds();
    const { workflow: next, nodeId } = addStepAfter(chain(), { nodeId: "a", handle: "success" }, "stop", mint);
    assert.deepEqual(edgesOf(next), ["a:success>b", `a:success>${nodeId}`, "t:success>a"].sort());
  });

  it("the failure output: one more branch", () => {
    const mint = sequentialIds();
    const { workflow: next, nodeId } = addStepAfter(chain(), { nodeId: "a", handle: "error" }, "stop", mint);
    assert.ok(edgesOf(next).includes(`a:error>${nodeId}`));
  });

  it("the first step goes after the trigger; with no trigger, loose", () => {
    const mint = sequentialIds();
    const lone = workflow([node("t", "trigger.manual")]);
    const first = addFirstStep(lone, "agent", mint);
    assert.deepEqual(edgesOf(first.workflow), [`t:success>${first.nodeId}`]);
    const empty = workflow([]);
    const trigger = addFirstStep(empty, "trigger.schedule", mint);
    assert.equal(trigger.workflow.nodes.length, 1);
    assert.equal(trigger.workflow.edges.length, 0);
  });
});

describe("connect and move", () => {
  it("connect candidates: connectable first, with why the rest cannot", () => {
    const candidates = connectCandidates(chain(), { nodeId: "b", handle: "success" });
    const review = candidates.find((c) => c.nodeId === "a")!;
    assert.match(review.refusal ?? "", /loop/);
    assert.equal(candidates.some((c) => c.nodeId === "t"), false, "a trigger takes no input");
    assert.equal(candidates.some((c) => c.nodeId === "b"), false, "not itself");
    const extra = workflow([...chain().nodes, node("s", "stop", {}, { name: "Stop" })], chain().edges);
    const list = connectCandidates(extra, { nodeId: "b", handle: "success" });
    assert.equal(list[0]!.nodeId, "s");
    assert.equal(list[0]!.refusal, null);
  });

  it("connectStep adds the edge, or nothing when refused", () => {
    const mint = sequentialIds();
    const extra = workflow([...chain().nodes, node("s", "stop", {}, { name: "Stop" })], chain().edges);
    assert.ok(edgesOf(connectStep(extra, { nodeId: "a", handle: "error" }, "s", mint)).includes("a:error>s"));
    const refused = connectStep(extra, { nodeId: "b", handle: "success" }, "a", mint);
    assert.equal(refused, extra);
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
    assert.match(candidates.find((c) => c.nodeId === "z")!.refusal ?? "", /loop/);
    const moved = moveStepToOutput(wf, "y", { nodeId: "i", handle: "true" }, { nodeId: "i", handle: "false" }, mint);
    assert.deepEqual(edgesOf(moved), ["i:false>y", "t:success>i", "y:success>z"]);
    assert.equal(moveStepToOutput(wf, "y", { nodeId: "i", handle: "true" }, { nodeId: "z", handle: "success" }, mint), wf);
  });
});

describe("delete, duplicate, disable", () => {
  it("deleting a middle step heals the chain", () => {
    const mint = sequentialIds();
    const next = deleteStep(chain(), "a", mint);
    assert.deepEqual(edgesOf(next), ["t:success>b"]);
    assert.equal(next.nodes.length, 2);
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
    assert.notEqual(nameOf(result.workflow, copy), "Review");
    assert.deepEqual(edgesOf(result.workflow), [`a:success>${copy}`, `${copy}:success>b`, "t:success>a"].sort());
    // The copy takes the next column; what followed moves one column on, never under it.
    const at = (id: string) => result.workflow.nodes.find((n) => n.id === id)!.position;
    assert.equal(at(copy).x, 704);
    assert.equal(at("b").x > at(copy).x, true, "the next block moved right, not stacked on the copy");
  });

  it("disable / enable", () => {
    const off = setStepsDisabled(chain(), ["a"], true);
    assert.equal(off.nodes.find((n) => n.id === "a")!.disabled, true);
    const on = setStepsDisabled(off, ["a"], false);
    assert.equal("disabled" in on.nodes.find((n) => n.id === "a")!, false);
  });

  it("the Jira template reads as one chain with a failure branch", () => {
    const env = { mintId: sequentialIds("j"), now: new Date("2026-09-28T10:00:00.000Z") };
    const wf = createWorkflowFromRequest(buildTemplate("jira-fixer", { projectPath: "/w/a/b", timezone: "UTC" }), env);
    const rows = deriveSteps(wf, [], summary).rows;
    assert.deepEqual(
      rows.filter((row) => row.kind === "node").map((row) => row.name),
      ["Every15Min", "FetchTickets", "FixTickets", "MarkDone", "Failed"]
    );
  });
});
