import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationPrompt,
  buildProposedPlanMarkdownFilename,
  deriveActivePlanState,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  planProgress,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  shouldShowPlanFollowUpPrompt,
  stripDisplayedPlanMarkdown,
  wholePlanMarkdown
} from "./plan.logic";
import { activity, resetBuilders, stamp } from "./test-helpers";

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

describe("the implement/refine split button", () => {
  it("implements with an empty draft and leaves plan mode", () => {
    const result = resolvePlanFollowUpSubmission({ draftText: "   ", planMarkdown: "# Plan\nbody" });
    assert.equal(result.interactionMode, "default");
    assert.ok(result.text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX));
    assert.ok(result.text.includes("# Plan"));
  });

  it("refines with draft text and stays in plan mode", () => {
    const result = resolvePlanFollowUpSubmission({ draftText: " tweak it ", planMarkdown: "# Plan" });
    assert.deepEqual(result, { text: "tweak it", interactionMode: "plan" });
  });

  it("builds the fixed prefix exactly", () => {
    assert.equal(buildPlanImplementationPrompt("  # Plan  "), `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`);
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

  it("is actionable until a turn implements it", () => {
    assert.equal(hasActionableProposedPlan(plan()), true);
    assert.equal(hasActionableProposedPlan(plan({ implementedAt: stamp(2) })), false);
    assert.equal(hasActionableProposedPlan(null), false);
  });

  it("reads the title from the first heading", () => {
    assert.equal(proposedPlanTitle("# Ship it\nbody"), "Ship it");
    assert.equal(proposedPlanTitle("no heading"), null);
    assert.equal(buildProposedPlanMarkdownFilename("# Ship it!"), "ship-it.md");
    assert.equal(buildProposedPlanMarkdownFilename("no heading"), "plan.md");
  });

  it("strips the displayed heading and a Summary heading", () => {
    assert.equal(stripDisplayedPlanMarkdown(plan().planMarkdown), "Do the thing");
  });

  it("truncates a long preview and marks it", () => {
    const long = `# T\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}`;
    const preview = buildCollapsedProposedPlanPreviewMarkdown(long, { maxLines: 3 });
    assert.equal(preview.split("\n").length, 5);
    assert.ok(preview.endsWith("..."));
  });

  it("picks the current turn's proposal, else the newest of any turn", () => {
    const plans = [plan({ id: "p1", turnId: "t1", updatedAt: stamp(1) }), plan({ id: "p2", turnId: "t2", updatedAt: stamp(2) })];
    assert.equal(findLatestProposedPlan(plans, "t1")?.id, "p1");
    assert.equal(findLatestProposedPlan(plans, "t9")?.id, "p2");
    assert.equal(findLatestProposedPlan([], "t1"), null);
  });
});

describe("what the plan card's Copy and Download hand over (§7.3)", () => {
  /** The store's `readFullPlanMarkdown` stand-in: records which proposal it read. */
  const reader = (answer: () => Promise<string>) => {
    const reads: string[] = [];
    return {
      reads,
      read: (plan: { id: string }) => {
        reads.push(plan.id);
        return answer();
      }
    };
  };

  it("is an intact plan's own markdown, answered at once with nothing read", () => {
    const store = reader(async () => "never read");
    const text = wholePlanMarkdown({ id: "p1", planMarkdown: "# Ship it\n\nstep" }, store.read);
    // Synchronous, so the clipboard write stays inside the click.
    assert.equal(text, "# Ship it\n\nstep");
    assert.deepEqual(store.reads, []);
  });

  it("reads a plan the wire cut (§5.6) back whole, by its proposal id", async () => {
    const whole = `# Ship it\n\n${"step\n".repeat(4_000)}done`;
    const store = reader(async () => whole);
    const text = wholePlanMarkdown({ id: "p-cut", planMarkdown: "# Ship it\n\nstep…", truncated: true }, store.read);
    assert.ok(text instanceof Promise, "a cut plan is read before anything is handed over");
    assert.equal(await text, whole);
    assert.deepEqual(store.reads, ["p-cut"]);
  });

  it("fails rather than ever hand over the cut text", async () => {
    const store = reader(() =>
      Promise.reject(new Error("The full plan could not be loaded, so nothing was sent. Try again."))
    );
    await assert.rejects(
      Promise.resolve(
        wholePlanMarkdown({ id: "p-cut", planMarkdown: "# Ship it\n\nstep…", truncated: true }, store.read)
      ),
      /full plan could not be loaded/
    );
    assert.deepEqual(store.reads, ["p-cut"]);
  });
});
