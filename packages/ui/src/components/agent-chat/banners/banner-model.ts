// Ported from T3 Code (MIT): apps/web/src/components/chat/ComposerBannerStack.tsx,
// apps/web/src/components/chat/ComposerPendingApprovalActions.tsx,
// apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx
/**
 * What the dock shows, in what order, and what each card's copy is
 * (spec §7.5, §4.3, §7.6).
 *
 * Pure. The dock component renders this; nothing here reaches the host.
 */

import type { ApprovalOption, BackgroundLiveness, ProviderRequestKind } from "@orquester/api/agent-chat";

// ---------------------------------------------------------------------------
// Stack order (§7.5)
// ---------------------------------------------------------------------------

export type BannerPriority = "activity" | "urgent" | "notice";
export type BannerVariantName = "default" | "info" | "success" | "warning" | "error";

export interface BannerStackEntry {
  id: string;
  variant: BannerVariantName;
  priority?: BannerPriority;
}

/**
 * **Activity stays attached; urgency and severity only order the notices
 * behind it.** A live thing the user is watching outranks a warning about
 * something that already happened.
 *
 * *T3: `ComposerBannerStack.tsx:33-41`.*
 */
export function bannerPriority(entry: BannerStackEntry): number {
  if (entry.priority === "activity") return 0;
  if (entry.priority === "urgent" || entry.variant === "error" || entry.variant === "warning") {
    return 1;
  }
  return 2;
}

/** Stable sort: equal priorities keep the caller's order. */
export function sortBannerStack<T extends BannerStackEntry>(entries: readonly T[]): T[] {
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        bannerPriority(left.entry) - bannerPriority(right.entry) || left.index - right.index
    )
    .map(({ entry }) => entry);
}

// ---------------------------------------------------------------------------
// Approvals (§4.3)
// ---------------------------------------------------------------------------

/**
 * What the UI offers when the provider advertises no options (Grok).
 *
 * Approve and Decline stay primary; **Always allow this session and Cancel sit
 * in the overflow menu** — which falls out of {@link splitApprovalOptions}
 * rather than being spelled twice.
 *
 * *T3: `ComposerPendingApprovalActions.tsx:23-28`.*
 */
export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" }
];

/**
 * Approve and Decline are primary buttons; **every other advertised option,
 * with its own label and warning, goes in the overflow menu.** The split is on
 * the decision, not on the position, so a provider that reorders its options
 * still gets the same two buttons.
 *
 * *T3: `ComposerPendingApprovalActions.tsx:36-41`.*
 */
export function splitApprovalOptions(options?: readonly ApprovalOption[]): {
  primary: ApprovalOption[];
  overflow: ApprovalOption[];
} {
  const offered = options && options.length > 0 ? options : DEFAULT_APPROVAL_OPTIONS;
  return {
    primary: offered.filter(
      (option) => option.decision === "decline" || option.decision === "accept"
    ),
    overflow: offered.filter(
      (option) => option.decision !== "decline" && option.decision !== "accept"
    )
  };
}

/** The header label, from the request type. *T3: `…ApprovalPanel.tsx:17-36`.* */
export function approvalKindLabel(kind: ProviderRequestKind): string {
  switch (kind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "file-change":
      return "File change approval";
    case "mcp-elicitation":
      return "App access approval";
    case "permission":
      return "App permission approval";
  }
}

/** The aria twin of {@link approvalKindLabel}, naming the detail block. */
export function approvalDetailAriaLabel(kind: ProviderRequestKind): string {
  switch (kind) {
    case "command":
      return "Command";
    case "file-read":
      return "File to read";
    case "file-change":
      return "File change";
    case "mcp-elicitation":
      return "App access request";
    case "permission":
      return "Permission request";
  }
}

/** An elicitation is prose; everything else is a command or a path — mono. */
export function approvalDetailIsProse(kind: ProviderRequestKind): boolean {
  return kind === "mcp-elicitation";
}

// ---------------------------------------------------------------------------
// Background liveness (§7.6)
// ---------------------------------------------------------------------------

/**
 * "N agents working" — or "Background work" when the live agent count is zero
 * — for `working`; "Monitoring" for `monitoring`.
 *
 * *T3: `ChatView.tsx:6270-6277`.*
 */
export function backgroundLivenessTitle(
  liveness: BackgroundLiveness,
  liveAgentCount: number
): string {
  if (liveness !== "working") return "Monitoring";
  if (liveAgentCount <= 0) return "Background work";
  return `${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`;
}

/**
 * The banner sits in the stack **only while liveness is non-null and no turn
 * is working** — once a turn settles the composer's stop button is gone, so
 * this is the only visible stop affordance; while a turn runs, the composer
 * already has one.
 *
 * *T3: `ChatView.tsx:6230-6231`.*
 */
export function showBackgroundLivenessBanner(input: {
  backgroundLiveness: BackgroundLiveness | null;
  isTurnWorking: boolean;
}): boolean {
  return input.backgroundLiveness !== null && !input.isTurnWorking;
}

// ---------------------------------------------------------------------------
// Dock order (§7.5)
// ---------------------------------------------------------------------------

/**
 * The dock's fixed priority order: approval, then pending question, then the
 * plan-ready prompt, then the mobile-collapsed question. One request at a time.
 *
 * *T3: `ChatComposer.tsx:6152-6265` — the four-branch if-chain.*
 */
export type DockCard = "approval" | "question" | "plan-ready" | "question-mobile" | null;

export function resolveDockCard(input: {
  hasApproval: boolean;
  hasUserInput: boolean;
  hasActionableProposedPlan: boolean;
  isComposerCollapsedMobile: boolean;
}): DockCard {
  if (input.hasApproval) return "approval";
  if (input.hasUserInput) {
    return input.isComposerCollapsedMobile ? "question-mobile" : "question";
  }
  if (input.hasActionableProposedPlan && !input.isComposerCollapsedMobile) return "plan-ready";
  return null;
}
