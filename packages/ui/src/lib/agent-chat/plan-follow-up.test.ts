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
  /** Published back by the composer — the draft is state in there. */
  composerAttachments?: number;
}): { planMarkdown: string } | null {
  const latest = findLatestProposedPlan(input.plans, input.latestTurnId);
  const actionable = hasActionableProposedPlan(latest) ? { planMarkdown: latest!.planMarkdown } : null;
  return shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: input.pendingUserInputCount,
    interactionMode: input.interactionMode,
    latestTurnSettled: input.latestTurnSettled,
    hasActionableProposedPlan: actionable !== null,
    hasComposerAttachments: (input.composerAttachments ?? 0) > 0
  })
    ? actionable
    : null;
}

/**
 * The composer's own re-application of the same clause, from its local draft —
 * belt and braces against the frame between a file landing in the tray and the
 * shell's re-render.
 */
function composerPlanFollowUp(
  fromShell: { planMarkdown: string } | null,
  attachmentCount: number
): { planMarkdown: string } | null {
  return attachmentCount > 0 ? null : fromShell;
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

/*
 * §7.3's last condition, "the composer holds no attachments" (R7-2 residual:
 * it was hard-coded `false` in the shell and never applied in the composer).
 */

test("a staged attachment withdraws the plan follow-up from both sides", () => {
  // Why it is not cosmetic: `submit` resolves the follow-up BEFORE its
  // emptiness guard, so an ungated Implement on a draft that is empty except
  // for files would send the plan prompt, leave plan mode, and carry the
  // attachments into a message the user never composed.
  assert.equal(shellPlanFollowUp({ ...settledPlanMode, composerAttachments: 1 }), null);
  assert.equal(composerPlanFollowUp({ planMarkdown: "# Ship it" }, 1), null);
});

test("removing the last attachment brings it back", () => {
  assert.deepEqual(shellPlanFollowUp({ ...settledPlanMode, composerAttachments: 0 }), {
    planMarkdown: "# Ship it\n\n- step"
  });
  assert.deepEqual(composerPlanFollowUp({ planMarkdown: "# Ship it" }, 0), {
    planMarkdown: "# Ship it"
  });
});

test("the composer never resurrects a follow-up the shell withheld", () => {
  // The shell owns every other term; an empty tray is not a second opinion.
  assert.equal(composerPlanFollowUp(null, 0), null);
});
