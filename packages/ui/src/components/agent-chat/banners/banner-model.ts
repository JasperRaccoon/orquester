// Ported from T3 Code (MIT): apps/web/src/components/chat/ComposerBannerStack.tsx,
// apps/web/src/components/chat/ComposerPendingApprovalActions.tsx,
// apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx
/**
 * What the dock shows, in what order, and what each card's copy is
 * (spec §7.5, §4.3, §7.6).
 *
 * Pure. The dock component renders this; nothing here reaches the host.
 */

import {
  TOOL_APPROVAL_KEYBOARD_GUARD_MS,
  type ApprovalOption,
  type BackgroundLiveness,
  type ParsedToolApprovalSummary,
  type ProviderRequestKind,
  type ToolApprovalGrantScope
} from "@orquester/api/agent-chat";
import { workingLivenessTitle } from "../../../lib/agent-chat/roster.logic";

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
function bannerPriority(entry: BannerStackEntry): number {
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
const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
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
 * "N agents working" — "N agents and M shells running" when shells run beside
 * them, "M shells running" alone, "Background work" when nothing is named —
 * for `working`; "Monitoring" for `monitoring`. {@link workingLivenessTitle}.
 *
 * *T3: `ChatView.tsx:6270-6277`.*
 */
export function backgroundLivenessTitle(
  liveness: BackgroundLiveness,
  liveAgentCount: number,
  liveShellCount = 0
): string {
  if (liveness !== "working") return "Monitoring";
  return workingLivenessTitle(liveAgentCount, liveShellCount);
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
 * The dock's fixed priority order: approval, then pending question, then an
 * agent's request for a secret (`request_secret`, design 2026-10-14 §5 — the
 * agent waits on it as on a question, on mobile too), then an MCP App's
 * consent request (spec 2026-10-14 §3 — the agent's own requests come first:
 * an app waits, a turn is blocked), then the plan-ready prompt, then the
 * mobile-collapsed question. One request at a time.
 *
 * *T3: `ChatComposer.tsx:6152-6265` — the four-branch if-chain; T3 shows the
 * secret card in the timeline instead.*
 */
export type DockCard =
  | "approval"
  | "tool-approval"
  | "question"
  | "secret"
  | "app-consent"
  | "plan-ready"
  | "question-mobile"
  | null;

/**
 * An Orquester approval card (unified MCP §7) comes right after a provider approval: both are a
 * tool call held for the user's decision, and the provider's request is the older of the two when
 * both are up (an Orquester card only opens inside a running tool call).
 */
export function resolveDockCard(input: {
  hasApproval: boolean;
  hasToolApproval?: boolean;
  hasUserInput: boolean;
  hasSecretRequest?: boolean;
  hasActionableProposedPlan: boolean;
  isComposerCollapsedMobile: boolean;
  hasAppConsent?: boolean;
}): DockCard {
  if (input.hasApproval) return "approval";
  if (input.hasToolApproval === true) return "tool-approval";
  if (input.hasUserInput) {
    return input.isComposerCollapsedMobile ? "question-mobile" : "question";
  }
  if (input.hasSecretRequest === true) return "secret";
  if (input.hasAppConsent === true) return "app-consent";
  if (input.hasActionableProposedPlan && !input.isComposerCollapsedMobile) return "plan-ready";
  return null;
}

// ---------------------------------------------------------------------------
// Orquester approval cards (unified MCP §7.1, §9.3)
// ---------------------------------------------------------------------------

type CardFacts = Pick<ParsedToolApprovalSummary, "kind" | "family" | "scope">;

/**
 * The "what will change" sentence every card carries under its title: what approving does, said
 * plainly, so the decision never rests on the agent's own words alone. Composed here from the
 * card's kind and family (never from agent text); the scope badge names where.
 */
export function toolApprovalChangeSentence(card: CardFacts): string {
  if (card.kind === "toolset") {
    return "Enabling adds these tools to this chat only (the agent cannot enable anything itself). If the agent's session has to restart to see them, it does so at its next idle point and keeps the conversation.";
  }
  switch (card.family) {
    case "workflows":
      return "Approving saves or runs this workflow change exactly as previewed. A saved workflow then runs on its own triggers, without asking again.";
    case "workflow-secrets":
      return "Approving stores the secret for the workflow. The value you type goes to Orquester's secret store, never to the agent.";
    case "agent-profile":
      return "Approving changes the agent CLI's own configuration files exactly as previewed. The change affects every chat of that CLI in the scope shown, and stays until someone changes it back.";
    case "desktops":
      return "Approving starts or changes processes on the host machine as previewed.";
    case "saved-prompts":
      return "Approving changes a saved prompt you wrote, exactly as previewed.";
    case "cross-project":
      return "Approving lets the agent act in another project: it sends or changes what the preview shows there.";
    case "cross-project-read":
    case "cross-workspace-read":
      return "Approving lets the agent read content (transcripts, files or diffs) of another project, as the preview shows. Nothing is changed.";
    default:
      return "This approval comes from a newer Orquester than this client knows: check it on an updated client before approving.";
  }
}

/** The card's badge: what kind of decision it is. */
export function toolApprovalKindBadge(card: Pick<ParsedToolApprovalSummary, "kind">): string {
  switch (card.kind) {
    case "admin":
      return "Admin";
    case "boundary":
      return "Another project";
    case "toolset":
      return "Tools";
    default:
      return "Approval";
  }
}

/** The primary button: "Enable for this chat" on a toolset card (§9.3), else "Approve once". */
export function toolApprovalPrimaryLabel(card: Pick<ParsedToolApprovalSummary, "kind">): string {
  return card.kind === "toolset" ? "Enable for this chat" : "Approve once";
}

export interface ToolApprovalGrantChoice {
  scope: ToolApprovalGrantScope;
  label: string;
  /** What the grant then allows without a card, said before it is made. */
  hint: string;
}

/**
 * The Approve menu's grant choices — EXACTLY the card's `grantOptions` (the daemon decided them,
 * and validates the answer against them again): never a scope it did not offer, none when it
 * offered none.
 */
export function toolApprovalGrantChoices(card: Pick<ParsedToolApprovalSummary, "grantOptions" | "family">): ToolApprovalGrantChoice[] {
  const what =
    card.family === "workflows"
      ? "changes to the workflows created or approved in this chat"
      : card.family === "desktops"
        ? "opening desktops and launching apps in this project"
        : card.family === "saved-prompts"
          ? "edits of your saved prompts"
          : card.family === "cross-project"
            ? "actions in that project"
            : "calls like this one";
  return card.grantOptions.map((scope) =>
    scope === "chat"
      ? { scope, label: "Approve and allow for this chat", hint: `Until this chat closes, ${what} run without asking. Revoke it from the Tools chip or Settings › Agent tools.` }
      : { scope, label: "Approve and allow for this project", hint: `Until you revoke it, ${what} from any chat of this project run without asking. Revoke it in Settings › Agent tools.` }
  );
}

/** The minimum a keyboard event needs for {@link toolApprovalKeyAction}. */
export interface ToolApprovalKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

/**
 * What a key pressed INSIDE a card does (§7.1): ⌘/Ctrl+Enter is the only keyboard approval —
 * Enter alone never approves, and Shift/Alt chords are someone else's (⌘/Ctrl+Shift+Enter steers
 * the queue). Pressed within {@link TOOL_APPROVAL_KEYBOARD_GUARD_MS} of the card appearing or
 * changing, it is swallowed (`guarded`): a chord meant for the composer a moment ago must not land
 * on a card that just slid in. In the deny-reason field the chord sends the denial instead.
 * `null`: not the card's key.
 */
export function toolApprovalKeyAction(
  event: ToolApprovalKeyEvent,
  context: { now: number; shownAt: number; inDenyReason?: boolean }
): "approve" | "deny" | "guarded" | null {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return null;
  if (event.repeat === true) return "guarded";
  if (context.now - context.shownAt < TOOL_APPROVAL_KEYBOARD_GUARD_MS) return "guarded";
  return context.inDenyReason === true ? "deny" : "approve";
}

/**
 * What "appears or changes" means for the keyboard guard: a new card, or the same card whose
 * decision-bearing content moved (title, scope, grant choices, secret fields, the preview).
 */
export function toolApprovalGuardKey(card: ParsedToolApprovalSummary, previewRevision = 0): string {
  return JSON.stringify([
    card.approvalId,
    card.title,
    card.scope.label,
    card.grantOptions,
    card.secretFields.map((field) => field.key),
    card.sections.length,
    card.fullPreview,
    previewRevision
  ]);
}

/** "Expires in 29 min" / "Expires in 40 s" / "Expired", from the card's deadline. */
export function toolApprovalExpiryText(expiresAt: string, now: number): string {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return "";
  const left = deadline - now;
  if (left <= 0) return "Expired";
  if (left < 60_000) return `Expires in ${Math.ceil(left / 1000)} s`;
  return `Expires in ${Math.ceil(left / 60_000)} min`;
}

export function toolApprovalExpired(expiresAt: string, now: number): boolean {
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) && deadline <= now;
}

/** Why an answer did not go through, from its HTTP status — never the server's words or a value. */
export function toolApprovalAnswerFailure(status: number | null): { text: string; closed: boolean } {
  if (status === 409) return { text: "The agent stopped waiting: your answer was not used.", closed: true };
  if (status === 404) return { text: "This approval has already ended.", closed: true };
  if (status === 400) return { text: "The answer was refused: check the card and try again.", closed: false };
  return { text: "Could not send the answer. Try again.", closed: false };
}

/**
 * A card is ready to approve: not expired, nothing in flight, every asked secret typed — and of a
 * kind this client knows: a newer daemon's card can only be denied here (fail closed; its caution
 * says to use an updated client).
 */
export function toolApprovalCanApprove(input: {
  card: Pick<ParsedToolApprovalSummary, "secretFields" | "kind" | "family">;
  secrets: Readonly<Record<string, string>>;
  submitting: boolean;
  expired: boolean;
}): boolean {
  if (input.submitting || input.expired) return false;
  if (input.card.kind === "unknown" || input.card.family === "unknown") return false;
  return input.card.secretFields.every((field) => (input.secrets[field.key] ?? "").length > 0);
}
