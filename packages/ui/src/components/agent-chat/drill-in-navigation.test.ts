/**
 * When the view leaves a drill-in on its own (§7.6): the auto-return when the
 * agent the reader is following settles (S2), and a palette search hit, which
 * only the thread's timeline can take (S5).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeSubagentStatus } from "@orquester/api/agent-chat";

import { NO_DRILL_IN_WATCH, nextDrillInReturn, revealClosesDrillIn, type DrillInWatch } from "./drill-in-navigation";

/** Feed the observations in order; the ids of the steps that returned to the thread. */
function walk(
  steps: Array<{ agentId: string | null; status: RuntimeSubagentStatus | null; following?: boolean }>
): number[] {
  let watch: DrillInWatch = NO_DRILL_IN_WATCH;
  const returned: number[] = [];
  steps.forEach((step, index) => {
    const next = nextDrillInReturn(watch, { following: true, ...step });
    watch = next.watch;
    if (next.returnToMain) returned.push(index);
  });
  return returned;
}

describe("nextDrillInReturn: the auto-return is per agent, and never yanks a reader", () => {
  it("an agent seen at work that settles while the reader follows its end hands the view back", () => {
    assert.deepEqual(
      walk([
        { agentId: "a", status: "running" },
        { agentId: "a", status: "completed" }
      ]),
      [1]
    );
    for (const settled of ["failed", "cancelled", "interrupted"] as const) {
      assert.deepEqual(walk([{ agentId: "a", status: "waiting" }, { agentId: "a", status: settled }]), [1], settled);
    }
  });

  it("opening a finished agent from a running agent's view stays open (was one flag for the whole view)", () => {
    assert.deepEqual(
      walk([
        { agentId: "a", status: "running" },
        { agentId: "b", status: "completed" },
        { agentId: "b", status: "completed" }
      ]),
      []
    );
  });

  it("an agent opened already finished stays open", () => {
    assert.deepEqual(walk([{ agentId: "b", status: "completed" }]), []);
    assert.deepEqual(walk([{ agentId: null, status: null }, { agentId: "b", status: "failed" }]), []);
  });

  it("a reader who scrolled up stays when it settles — and is not yanked later on reaching the end", () => {
    assert.deepEqual(
      walk([
        { agentId: "a", status: "running" },
        { agentId: "a", status: "completed", following: false },
        { agentId: "a", status: "completed", following: true }
      ]),
      []
    );
  });

  it("idle is not at work: an idle agent that settles returns nothing", () => {
    assert.deepEqual(walk([{ agentId: "a", status: "idle" }, { agentId: "a", status: "completed" }]), []);
  });

  it("an agent the roster dropped, then back, starts over", () => {
    assert.deepEqual(
      walk([
        { agentId: "a", status: "running" },
        { agentId: "a", status: null },
        { agentId: "a", status: "completed" }
      ]),
      []
    );
  });

  it("A → B → A: each agent is watched from its own opening", () => {
    assert.deepEqual(
      walk([
        { agentId: "a", status: "running" },
        { agentId: "b", status: "running" },
        { agentId: "a", status: "completed" }
      ]),
      [],
      "A was opened again already finished"
    );
  });
});

describe("revealClosesDrillIn: a palette hit goes to the thread's timeline", () => {
  it("a NEW reveal closes an open drill-in, so the thread's timeline takes it at once", () => {
    assert.equal(revealClosesDrillIn(null, 7), true);
    assert.equal(revealClosesDrillIn(6, 7), true);
  });

  it("no new reveal closes nothing: opening a drill-in while an old one is pending leaves it open", () => {
    assert.equal(revealClosesDrillIn(7, 7), false);
    assert.equal(revealClosesDrillIn(7, null), false, "the thread acknowledged it");
    assert.equal(revealClosesDrillIn(null, null), false);
  });
});
