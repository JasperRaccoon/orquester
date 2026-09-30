import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
deriveActivePlanState,
findLatestProposedPlan,
planProgress,
shouldShowPlanFollowUpPrompt,
wholePlanMarkdown
} from "./plan.logic";
import { activity,resetBuilders,stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

describe("deriveActivePlanState", () => {
  it("prefers the current turn's plan", () => {
    const plan = deriveActivePlanState(
      [
        activity("turn.plan.updated", { plan: [{ step: "old", status: "completed" }] }, { turnId: "t1" }),
        activity("turn.plan.updated", { plan: [{ step: "new", status: "inProgress" }] }, { turnId: "t2" })
      ],
      "t1"
    );
    assert.equal(plan?.steps[0]?.step, "old");
  });

  it("falls back to the most recent plan from ANY turn so a follow-up does not blank it", () => {
    const plan = deriveActivePlanState(
      [activity("turn.plan.updated", { plan: [{ step: "a", status: "pending" }] }, { turnId: "t1" })],
      "t9"
    );
    assert.equal(plan?.steps[0]?.step, "a");
  });

  it("is null when no plan was ever reported", () => {
    assert.equal(deriveActivePlanState([], "t1"), null);
  });

  it("tolerates a malformed step list", () => {
    assert.equal(deriveActivePlanState([activity("turn.plan.updated", { plan: "nope" })], null), null);
    const plan = deriveActivePlanState(
      [activity("turn.plan.updated", { plan: [{ step: "a" }, { nope: 1 }] })],
      null
    );
    assert.equal(plan?.steps.length, 1);
    assert.equal(plan?.steps[0]?.status, "pending");
  });

  it("summarises progress for the composer's checklist", () => {
    const plan = deriveActivePlanState(
      [
        activity("turn.plan.updated", {
          plan: [
            { step: "a", status: "completed" },
            { step: "b", status: "inProgress" },
            { step: "c", status: "pending" }
          ]
        })
      ],
      null
    );
    assert.deepEqual(planProgress(plan), { completed: 1, total: 3, currentStep: "b" });
    assert.deepEqual(planProgress(null), { completed: 0, total: 0, currentStep: null });
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false
  };

  it("docks only under all five conditions", () => {
    assert.equal(shouldShowPlanFollowUpPrompt(base), true);
    assert.equal(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 }), false);
    assert.equal(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" }), false);
    assert.equal(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false }), false);
    assert.equal(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false }), false);
    assert.equal(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true }), false);
  });
});

describe("proposal helpers", () => {
  const plan = (overrides: Record<string, unknown> = {}) => ({
    id: "p1",
    createdAt: stamp(1),
    updatedAt: stamp(1),
    turnId: "t1",
    planMarkdown: "# Ship it\n\n## Summary\n\nDo the thing",
    implementedAt: null,
    ...overrides
  });

  it("picks the current turn's proposal, else the newest of any turn", () => {
    const plans = [plan({ id: "p1", turnId: "t1", updatedAt: stamp(1) }), plan({ id: "p2", turnId: "t2", updatedAt: stamp(2) })];
    assert.equal(findLatestProposedPlan(plans, "t1")?.id, "p1");
    assert.equal(findLatestProposedPlan(plans, "t9")?.id, "p2");
    assert.equal(findLatestProposedPlan([], "t1"), null);
  });
});

describe("the plan card's Copy and Download content", () => {
  it("returns an intact plan synchronously without reading it", () => {
    const text = wholePlanMarkdown({ id: "p1", planMarkdown: "# Ship it\n\nstep" }, async () => {
      assert.fail("an intact plan must stay inside the clipboard gesture");
    });
    assert.equal(text, "# Ship it\n\nstep");
  });

  it("reads a truncated proposal by id and never falls back to its cut text", async () => {
    const plan = { id: "p-cut", planMarkdown: "# Ship it\n\nstep…", truncated: true as const };
    const whole = "# Ship it\n\nstep one\nstep two";
    assert.equal(await wholePlanMarkdown(plan, async (requested) => {
      assert.equal(requested.id, "p-cut");
      return whole;
    }), whole);
    await assert.rejects(
      Promise.resolve(wholePlanMarkdown(plan, async () => { throw new Error("Full plan unavailable"); })),
      /Full plan unavailable/
    );
  });
});
