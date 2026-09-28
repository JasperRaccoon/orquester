import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowBlockRun } from "@orquester/api";

import { deriveRunOverlay } from "./overlay.ts";
import { edge, node, workflow } from "./testing.ts";

const def = workflow(
  [node("t", "trigger.manual"), node("i", "if"), node("a", "agent"), node("b", "shell"), node("s", "stop")],
  [edge("t", "i"), edge("i", "a", "true"), edge("i", "b", "false"), edge("a", "s"), edge("a", "s", "error", "a-err-s")]
);

function block(nodeId: string, status: WorkflowBlockRun["status"], extra: Partial<WorkflowBlockRun> = {}): WorkflowBlockRun {
  return { nodeId, name: nodeId, type: "agent", status, attempt: 1, ...extra };
}

describe("deriveRunOverlay", () => {
  it("per block: status, duration (live for a running one), attempt, handle, account and hops", () => {
    const now = Date.parse("2026-09-28T10:10:00.000Z");
    const overlay = deriveRunOverlay(
      {
        status: "running",
        blocks: {
          t: block("t", "succeeded", { startedAt: "2026-09-28T10:00:00.000Z", endedAt: "2026-09-28T10:00:01.500Z" }),
          i: block("i", "succeeded", { handle: "true" }),
          a: block("a", "running", {
            attempt: 2,
            startedAt: "2026-09-28T10:02:00.000Z",
            activity: "Editing src/app.ts",
            hops: [
              { agent: "claude", model: "opus", accountId: "acc1", accountLabel: "jasper", sessionId: "s1", startedAt: "", via: "initial" },
              { agent: "codex", model: "gpt", accountId: "acc2", accountLabel: "eduard", sessionId: "s2", startedAt: "", via: "handoff" }
            ]
          })
        },
        takenEdges: ["t-success-i"],
        deadEdges: []
      },
      def,
      now
    );
    assert.equal(overlay.runStatus, "running");
    assert.equal(overlay.nodes.t?.durationMs, 1500);
    assert.equal(overlay.nodes.a?.durationMs, 8 * 60_000);
    assert.equal(overlay.nodes.a?.attempt, 2);
    assert.equal(overlay.nodes.a?.accountLabel, "eduard");
    assert.equal(overlay.nodes.a?.hopCount, 2);
    assert.equal(overlay.nodes.a?.activity, "Editing src/app.ts");
    assert.equal(overlay.nodes.i?.handle, "true");
    assert.equal(overlay.nodes.b, undefined, "not reached");
  });

  it("edges: taken, active into a running block, dead, idle — read off the source when the lists lag", () => {
    const overlay = deriveRunOverlay(
      {
        status: "running",
        blocks: {
          t: block("t", "succeeded"),
          i: block("i", "succeeded", { handle: "true" }),
          a: block("a", "running")
        },
        takenEdges: ["t-success-i"],
        deadEdges: []
      },
      def
    );
    assert.equal(overlay.edges["t-success-i"], "taken");
    assert.equal(overlay.edges["i-true-a"], "active", "taken (by the handle) and its target runs");
    assert.equal(overlay.edges["i-false-b"], "dead", "the other handle of a finished block");
    assert.equal(overlay.edges["a-success-s"], "idle");
    assert.equal(overlay.edges["a-err-s"], "idle");
  });

  it("a failed block takes its error edge unless the run records another path", () => {
    const failed = {
      status: "failed" as const,
      blocks: {
        a: block("a", "failed", { error: { kind: "agent_error", message: "Boom" } }),
        s: block("s", "succeeded")
      },
      takenEdges: [],
      deadEdges: ["a-success-s"]
    };
    const overlay = deriveRunOverlay(failed, def);
    assert.equal(overlay.edges["a-success-s"], "dead");
    assert.equal(overlay.edges["a-err-s"], "taken");
    assert.equal(overlay.nodes.a?.errorMessage, "Boom");
    const recorded = deriveRunOverlay({ ...failed, takenEdges: ["a-success-s"], deadEdges: ["a-err-s"] }, def);
    assert.equal(recorded.edges["a-success-s"], "taken");
    assert.equal(recorded.edges["a-err-s"], "dead");
  });
});
