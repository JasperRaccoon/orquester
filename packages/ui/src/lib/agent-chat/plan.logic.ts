/**
 * Agent chat — plan checklist and plan proposals (spec §7.3, §7.4).
 *
 * Ported from T3 Code (MIT): `apps/web/src/proposedPlan.ts`,
 * `apps/web/src/session-logic.ts:324-350` (`deriveActivePlanState`) and
 * `apps/web/src/components/ChatView.logic.ts:951-965`
 * (`shouldShowPlanFollowUpPrompt`).
 *
 * Two distinct surfaces:
 * - **the plan checklist** is a *composer* surface, not a timeline row: one
 *   active plan state — current step, completed count, total — displayed beside
 *   the status line, with the last plan of any turn retained so a follow-up
 *   message does not blank it;
 * - **the plan proposal** is a timeline card with copy and save-to-file and
 *   **no approve affordance**; approval is the composer's split button.
 *
 * No React import.
 */

import type { ThreadActivityItem } from "@orquester/api/agent-chat";

import type { ActivePlanState } from "./contracts";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX, type ProposedPlanEntry } from "./entries.logic";

export { PLAN_IMPLEMENTATION_PROMPT_PREFIX };

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function planStateFromActivity(activity: ThreadActivityItem): ActivePlanState | null {
  const payload = asRecord(activity.payload);
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps: ActivePlanState["steps"] = [];
  for (const entry of rawPlan) {
    const record = asRecord(entry);
    if (!record || typeof record.step !== "string") {
      continue;
    }
    const status = record.status;
    steps.push({
      step: record.step,
      status: status === "inProgress" || status === "completed" ? status : "pending"
    });
  }
  if (steps.length === 0) {
    return null;
  }
  const explanation = payload?.explanation;
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(typeof explanation === "string" ? { explanation } : {}),
    steps
  };
}

/**
 * Prefer the plan from the current turn; **fall back to the most recent plan
 * from any turn** so the checklist persists across follow-up messages.
 *
 * *T3: `session-logic.ts:324-350`.*
 */
export function deriveActivePlanState(
  activities: readonly ThreadActivityItem[],
  latestTurnId: string | null | undefined
): ActivePlanState | null {
  const planActivities = activities.filter(
    (activity) => activity.activityKind === "turn.plan.updated"
  );
  if (planActivities.length === 0) {
    return null;
  }
  const fromCurrentTurn = latestTurnId
    ? [...planActivities].reverse().find((activity) => activity.turnId === latestTurnId)
    : undefined;
  const latest = fromCurrentTurn ?? planActivities.at(-1);
  if (!latest) {
    return null;
  }
  return planStateFromActivity(latest);
}

export function planProgress(plan: ActivePlanState | null): {
  completed: number;
  total: number;
  currentStep: string | null;
} {
  if (!plan) {
    return { completed: 0, total: 0, currentStep: null };
  }
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const current =
    plan.steps.find((step) => step.status === "inProgress") ??
    plan.steps.find((step) => step.status === "pending");
  return { completed, total: plan.steps.length, currentStep: current?.step ?? null };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/** *T3: `proposedPlan.ts:1-4`.* */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(planMarkdown)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/** *T3: `proposedPlan.ts:6-20`.* */
export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const source = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (source[0]?.trim().length === 0) {
    source.shift();
  }
  const firstHeading = source[0] ? /^\s{0,3}#{1,6}\s+(.+)$/.exec(source[0]) : null;
  if (firstHeading?.[1]?.trim().toLowerCase() === "summary") {
    source.shift();
    while (source[0]?.trim().length === 0) {
      source.shift();
    }
  }
  return source.join("\n");
}

/** *T3: `proposedPlan.ts:22-60`.* */
export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: { maxLines?: number }
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const preview: string[] = [];
  let visible = 0;
  let hasMore = false;
  for (const line of lines) {
    const isVisible = line.trim().length > 0;
    if (isVisible && visible >= maxLines) {
      hasMore = true;
      break;
    }
    preview.push(line);
    if (isVisible) {
      visible += 1;
    }
  }
  while (preview.length > 0 && preview.at(-1)?.trim().length === 0) {
    preview.pop();
  }
  if (preview.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  }
  if (hasMore) {
    preview.push("", "...");
  }
  return preview.join("\n");
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  return `${sanitizePlanFileSegment(proposedPlanTitle(planMarkdown) ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

/** *T3: `proposedPlan.ts:75-77`.* */
export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

/**
 * The composer's split button:
 * - with an **empty draft** it *implements* — one turn whose input is the fixed
 *   prefix plus the plan markdown, sent with `interactionMode: "default"` so
 *   the thread leaves plan mode;
 * - with **draft text** it *refines* — sends that text and stays in plan mode.
 *
 * *T3: `proposedPlan.ts:79-96`.*
 */
export function resolvePlanFollowUpSubmission(input: {
  draftText: string;
  planMarkdown: string;
}): { text: string; interactionMode: "default" | "plan" } {
  const trimmed = input.draftText.trim();
  if (trimmed.length > 0) {
    return { text: trimmed, interactionMode: "plan" };
  }
  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default"
  };
}

/**
 * The "Plan ready" banner docks above the composer only when the latest turn
 * has settled in plan mode with an un-implemented proposal and the composer
 * holds no attachments.
 *
 * *T3: `ChatView.logic.ts:951-965`.*
 */
export function shouldShowPlanFollowUpPrompt(input: {
  pendingUserInputCount: number;
  interactionMode: "default" | "plan";
  latestTurnSettled: boolean;
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
}): boolean {
  return (
    input.pendingUserInputCount === 0 &&
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    input.hasActionableProposedPlan &&
    !input.hasComposerAttachments
  );
}

/** *T3: `session-logic.ts:383-387`.* */
export function hasActionableProposedPlan(
  plan: Pick<ProposedPlanEntry, "implementedAt"> | null
): boolean {
  return plan !== null && plan.implementedAt === null;
}

/**
 * The proposal the composer acts on: the latest for the current turn, else the
 * latest of any turn.
 *
 * *T3: `session-logic.ts:352-380` (`findLatestProposedPlan`).*
 */
export function findLatestProposedPlan(
  plans: readonly ProposedPlanEntry[],
  latestTurnId: string | null | undefined
): ProposedPlanEntry | null {
  if (plans.length === 0) {
    return null;
  }
  const sorted = [...plans].sort(
    (left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
  );
  if (latestTurnId) {
    const forTurn = sorted.filter((plan) => plan.turnId === latestTurnId).at(-1);
    if (forTurn) {
      return forTurn;
    }
  }
  return sorted.at(-1) ?? null;
}
