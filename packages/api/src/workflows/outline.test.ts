import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildStepOutline, type OutlineItem } from "./outline.ts";
import { createWorkflowFromRequest } from "./patch.ts";
import { buildTemplate } from "./templates.ts";
import { sequentialIds } from "./testing.ts";
import type { WorkflowNodeType } from "./types.ts";

function wf(nodes: [string, WorkflowNodeType, { y?: number; config?: unknown }?][], edges: [string, string, string?][]) {
  return {
    nodes: nodes.map(([id, type, extra]) => ({ id, type, position: { x: 0, y: extra?.y ?? 0 }, config: extra?.config ?? {} })),
    edges: edges.map(([source, target, handle], index) => ({ id: `e${index}`, source, target, sourceHandle: handle ?? "success" }))
  };
}

/** One line per item: indentation, "↪" for a join-ref, "[handle]" when hanging from one. */
function render(items: OutlineItem[]): string[] {
  return items.map((item) => {
    const via = item.viaHandle ? `[${item.viaHandle}] ` : "";
    const mark = item.kind === "join-ref" ? "↪ " : "";
    const suffix = item.unreachable ? " (unreachable)" : item.joinOf ? ` (joins ${item.joinOf.join("+")})` : "";
    return `${"  ".repeat(item.depth)}${via}${mark}${item.nodeId}${suffix}`;
  });
}

describe("buildStepOutline", () => {
  it("a straight line stays flat", () => {
    const outline = buildStepOutline(wf([["t", "trigger.manual"], ["a", "code"], ["b", "agent"]], [["t", "a"], ["a", "b"]]));
    assert.deepEqual(render(outline), ["t", "[success] a", "[success] b"]);
    assert.equal(outline[1]!.parentId, "t");
  });

  it("an IF indents both branches, true first", () => {
    const outline = buildStepOutline(
      wf(
        [["t", "trigger.manual"], ["if", "if"], ["no", "code"], ["yes", "code"], ["yes2", "code"]],
        [["t", "if"], ["if", "no", "false"], ["if", "yes", "true"], ["yes", "yes2"]]
      )
    );
    assert.deepEqual(render(outline), ["t", "[success] if", "  [true] yes", "  [success] yes2", "  [false] no"]);
  });

  it("an error route indents the success path too", () => {
    const outline = buildStepOutline(
      wf([["t", "trigger.manual"], ["a", "agent"], ["ok", "code"], ["fail", "stop"]], [["t", "a"], ["a", "fail", "error"], ["a", "ok"]])
    );
    assert.deepEqual(render(outline), ["t", "[success] a", "  [success] ok", "  [error] fail"]);
  });

  it("a lone non-success output is indented", () => {
    const outline = buildStepOutline(wf([["t", "trigger.manual"], ["a", "agent"], ["fail", "stop"]], [["t", "a"], ["a", "fail", "error"]]));
    assert.deepEqual(render(outline), ["t", "[success] a", "  [error] fail"]);
  });

  it("a diamond: the join appears once, after both branches, at the fork's level", () => {
    const outline = buildStepOutline(
      wf(
        [["t", "trigger.manual"], ["if", "if"], ["a", "code"], ["b", "code"], ["m", "merge"], ["after", "code"]],
        [["t", "if"], ["if", "a", "true"], ["if", "b", "false"], ["a", "m"], ["b", "m"], ["m", "after"]]
      )
    );
    assert.deepEqual(render(outline), [
      "t",
      "[success] if",
      "  [true] a",
      "  [success] ↪ m",
      "  [false] b",
      "  [success] ↪ m",
      "m (joins a+b)",
      "[success] after"
    ]);
    assert.equal(outline.filter((item) => item.kind === "node" && item.nodeId === "m").length, 1);
    assert.equal(new Set(outline.map((item) => item.key)).size, outline.length, "keys are unique");
  });

  it("parallel branches from one block join after them", () => {
    const outline = buildStepOutline(
      wf(
        [["t", "trigger.manual"], ["x", "code", { y: 100 }], ["y", "code", { y: 0 }], ["m", "merge"]],
        [["t", "x"], ["t", "y"], ["x", "m"], ["y", "m"]]
      )
    );
    assert.deepEqual(render(outline), ["t", "  [success] y", "  [success] ↪ m", "  [success] x", "  [success] ↪ m", "m (joins x+y)"]);
  });

  it("the Jira template: one failure stop fed from three blocks", () => {
    const workflow = createWorkflowFromRequest(buildTemplate("jira-fixer", { projectPath: "/w/ws/app", timezone: "UTC" }), {
      mintId: sequentialIds("n"),
      now: new Date(0)
    });
    const names = new Map(workflow.nodes.map((node) => [node.id, node.name]));
    const lines = render(buildStepOutline(workflow)).map((line) => line.replace(/n-\d+/g, (id) => names.get(id) ?? id));
    assert.deepEqual(lines, [
      "Every15Min",
      "[success] FetchTickets",
      "  [success] FixTickets",
      "    [success] MarkDone",
      "      [error] ↪ Failed",
      "    [error] ↪ Failed",
      "  [error] ↪ Failed",
      "Failed (joins FetchTickets+FixTickets+MarkDone)"
    ]);
  });

  it("two triggers feeding one block", () => {
    const outline = buildStepOutline(
      wf([["m", "trigger.manual"], ["s", "trigger.schedule"], ["a", "agent"]], [["m", "a"], ["s", "a"]])
    );
    assert.deepEqual(render(outline), ["m", "[success] ↪ a", "s", "[success] ↪ a", "a (joins m+s)"]);
  });

  it("the same target on two handles", () => {
    const outline = buildStepOutline(wf([["t", "trigger.manual"], ["if", "if"], ["x", "code"]], [["t", "if"], ["if", "x", "true"], ["if", "x", "false"]]));
    assert.deepEqual(render(outline), ["t", "[success] if", "  [true] ↪ x", "  [false] ↪ x", "x (joins if)"]);
  });

  it("switch cases in order", () => {
    const outline = buildStepOutline(
      wf(
        [["t", "trigger.manual"], ["sw", "switch", { config: { cases: [{}, {}], fallback: true } }], ["d", "code"], ["c1", "code"], ["c0", "code"]],
        [["t", "sw"], ["sw", "d", "default"], ["sw", "c1", "case:1"], ["sw", "c0", "case:0"]]
      )
    );
    assert.deepEqual(render(outline), ["t", "[success] sw", "  [case:0] c0", "  [case:1] c1", "  [default] d"]);
  });

  it("unreachable blocks come last, flat; notes are not steps", () => {
    const outline = buildStepOutline(
      wf(
        [["lonely", "code"], ["t", "trigger.manual"], ["n", "note"], ["a", "code"], ["orphan", "code"], ["child", "code"]],
        [["t", "a"], ["orphan", "child"]]
      )
    );
    assert.deepEqual(render(outline), [
      "t",
      "[success] a",
      "lonely (unreachable)",
      "orphan (unreachable)",
      "child (unreachable)"
    ]);
  });

  it("a cycle does not loop forever", () => {
    const outline = buildStepOutline(
      wf([["t", "trigger.manual"], ["a", "code"], ["b", "code"]], [["t", "a"], ["a", "b"], ["b", "a"]])
    );
    assert.equal(outline.filter((item) => item.kind === "node").length, 3);
  });

  it("no trigger: everything is unreachable", () => {
    assert.deepEqual(render(buildStepOutline(wf([["a", "code"]], []))), ["a (unreachable)"]);
    assert.deepEqual(buildStepOutline({ nodes: [], edges: [] }), []);
  });
});
