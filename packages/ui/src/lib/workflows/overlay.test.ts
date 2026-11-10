import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowBlockRun } from "@orquester/api";

import { deriveRunOverlay } from "./overlay.ts";
import { edge, loopEdge, node, workflow } from "./testing.ts";

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

  describe("loops", () => {
    // Trigger → Fix → Review (if) → true: Deploy; false loops back to Fix (max 2).
    const looped = workflow(
      [node("t", "trigger.manual"), node("fix", "agent"), node("rev", "if"), node("dep", "shell")],
      [edge("t", "fix"), edge("fix", "rev"), edge("rev", "dep", "true"), loopEdge("rev", "fix", "false")]
    );
    const LOOP = "rev-false-loop-fix";

    it("a loop edge not used yet is idle, its counter 0/max", () => {
      const overlay = deriveRunOverlay(
        { status: "running", blocks: { t: block("t", "succeeded"), fix: block("fix", "running") }, takenEdges: ["t-success-fix"], deadEdges: [] },
        looped
      );
      assert.equal(overlay.edges[LOOP], "idle");
      assert.deepEqual(overlay.loops[LOOP], { used: 0, max: 2, exhausted: false });
      assert.equal(overlay.nodes.fix?.pass, undefined, "one pass: no pass shown");
    });

    it("taken once used — active while its target runs again — whatever the source's latest handle", () => {
      const running = deriveRunOverlay(
        {
          status: "running",
          blocks: {
            t: block("t", "succeeded"),
            fix: block("fix", "running", { pass: 2, passes: [{ ...block("fix", "succeeded"), pass: 1 }] }),
            rev: block("rev", "pending", { pass: 2, passes: [{ ...block("rev", "succeeded", { handle: "false" }), pass: 1 }] })
          },
          takenEdges: ["t-success-fix"],
          // The engine's lists come from the latest pass: Review's edges are open again.
          deadEdges: ["rev-true-dep"],
          loopCounters: { [LOOP]: 1 }
        },
        looped
      );
      assert.equal(running.edges[LOOP], "active");
      assert.equal(running.edges["rev-true-dep"], "idle", "a dead mark from an earlier pass does not stand while the source runs again");
      assert.deepEqual(running.loops[LOOP], { used: 1, max: 2, exhausted: false });
      assert.equal(running.nodes.fix?.pass, 2);
      assert.equal(running.nodes.fix?.passCount, 2);

      const approved = deriveRunOverlay(
        {
          status: "succeeded",
          blocks: {
            t: block("t", "succeeded"),
            fix: block("fix", "succeeded", { pass: 3 }),
            rev: block("rev", "succeeded", { pass: 3, handle: "true" }),
            dep: block("dep", "succeeded")
          },
          takenEdges: ["t-success-fix", "fix-success-rev", "rev-true-dep"],
          deadEdges: [LOOP],
          loopCounters: { [LOOP]: 2 }
        },
        looped
      );
      assert.equal(approved.edges[LOOP], "taken", "it was used, even though the last pass went to Deploy");
      assert.equal(approved.edges["rev-true-dep"], "taken");
      assert.deepEqual(approved.loops[LOOP], { used: 2, max: 2, exhausted: true });
    });

    it("never used and its source left by another handle: dead", () => {
      const overlay = deriveRunOverlay(
        {
          status: "succeeded",
          blocks: { t: block("t", "succeeded"), fix: block("fix", "succeeded"), rev: block("rev", "succeeded", { handle: "true" }) },
          takenEdges: [],
          deadEdges: []
        },
        looped
      );
      assert.equal(overlay.edges[LOOP], "dead");
    });

    it("a limit raised by Allow one more loop replaces maxLoops", () => {
      const overlay = deriveRunOverlay(
        { status: "running", blocks: {}, takenEdges: [], deadEdges: [], loopCounters: { [LOOP]: 2 }, loopLimits: { [LOOP]: 3 } },
        looped
      );
      assert.deepEqual(overlay.loops[LOOP], { used: 2, max: 3, exhausted: false });
    });
  });
});
