import test from "node:test";
import assert from "node:assert/strict";

import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  proposedPlanTitle,
  shouldShowPlanFollowUpPrompt
} from "./plan.logic.ts";

/**
 * The shell's half of §7.3's plan-ready decision.
 *
 * The regression: `AgentChatView` hard-coded `actionableProposedPlan={null}`
 * on the composer while the dock got the real flag, so the "Plan ready" banner
 * rendered with no way to say yes — the primary action never became Implement
 * and the thread could never leave plan mode. These assert the exact
 * composition the shell now performs.
 */

type ProposedPlan = Parameters<typeof findLatestProposedPlan>[0][number];

const plan = (over: Partial<ProposedPlan>) =>
  ({
    id: over.id ?? "p1",
    turnId: "turn-1",
    planMarkdown: "# Ship it\n\n- step",
    implementedAt: null,
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...over
  }) as ProposedPlan;

/** Exactly what the shell computes before handing the plan to the composer. */
function shellPlanFollowUp(input: {
  plans: Parameters<typeof findLatestProposedPlan>[0];
  latestTurnId: string | null;
  pendingUserInputCount: number;
  interactionMode: "default" | "plan";
  latestTurnSettled: boolean;
}): { planMarkdown: string } | null {
  const latest = findLatestProposedPlan(input.plans, input.latestTurnId);
  const actionable = hasActionableProposedPlan(latest) ? { planMarkdown: latest!.planMarkdown } : null;
  return shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: input.pendingUserInputCount,
    interactionMode: input.interactionMode,
    latestTurnSettled: input.latestTurnSettled,
    hasActionableProposedPlan: actionable !== null,
    hasComposerAttachments: false
  })
    ? actionable
    : null;
}

const settledPlanMode = {
  plans: [plan({})],
  latestTurnId: "turn-1",
  pendingUserInputCount: 0,
  interactionMode: "plan" as const,
  latestTurnSettled: true
};

test("a settled plan-mode turn with an un-implemented proposal reaches the composer", () => {
  const result = shellPlanFollowUp(settledPlanMode);
  assert.deepEqual(result, { planMarkdown: "# Ship it\n\n- step" });
});

test("an implemented proposal is no longer actionable", () => {
  assert.equal(
    shellPlanFollowUp({
      ...settledPlanMode,
      plans: [plan({ implementedAt: "2026-09-21T10:05:00.000Z" })]
    }),
    null
  );
});

test("the prompt stays away while the turn runs, while a question is open, or out of plan mode", () => {
  assert.equal(shellPlanFollowUp({ ...settledPlanMode, latestTurnSettled: false }), null);
  assert.equal(shellPlanFollowUp({ ...settledPlanMode, pendingUserInputCount: 1 }), null);
  assert.equal(shellPlanFollowUp({ ...settledPlanMode, interactionMode: "default" }), null);
});

test("no proposal at all is simply no prompt", () => {
  assert.equal(shellPlanFollowUp({ ...settledPlanMode, plans: [] }), null);
});

test("the current turn's proposal wins over an older one", () => {
  const result = shellPlanFollowUp({
    ...settledPlanMode,
    latestTurnId: "turn-2",
    plans: [
      plan({ id: "old", turnId: "turn-1", planMarkdown: "old" }),
      plan({
        id: "new",
        turnId: "turn-2",
        planMarkdown: "new",
        updatedAt: "2026-09-21T11:00:00.000Z"
      })
    ]
  });
  assert.deepEqual(result, { planMarkdown: "new" });
});

test("the banner can name the plan it is about", () => {
  // The dock's description slot was permanently empty before.
  assert.equal(proposedPlanTitle("# Ship it\n\n- step"), "Ship it");
});
