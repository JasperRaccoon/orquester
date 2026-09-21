/**
 * Agent chat — component prop contracts (spec §7.1, §7.3–§7.6).
 *
 * Types only. Each component ships as a placeholder next to this file;
 * packages W12–W15 and D replace the bodies, never these props.
 *
 * Ownership: `timeline/**` → W12, `{composer,banners}/**` → W13,
 * `{roster,status}/**` → W14, `AgentChatView.tsx` → W15,
 * `primitives/**` → D.
 */

import type {
  ApprovalDecision,
  AttachmentRef,
  BackgroundLiveness,
  Checkpoint,
  InteractionMode,
  ModelSelection,
  PendingApproval,
  PendingUserInput,
  ProviderSnapshot,
  RuntimeSubagent,
  SessionSummary
} from "@orquester/api";
import type { AgentPanelModel } from "@orquester/api/agent-chat";
// The documented collision (SEAMS §1): `@orquester/api` already exports
// `RuntimeMode` as the client-platform type, so the PERMISSION mode is
// `AgentRuntimeMode` at that path. Aliased here so the prop keeps its name.
import type { AgentRuntimeMode as RuntimeMode } from "@orquester/api";

import type {
  ActivePlanState,
  AgentChatActions,
  AgentChatConnectionState,
  AgentChatTimelineRow,
  DisclosureState,
  QueuedComposerMessage
} from "../../lib/agent-chat/contracts";

/**
 * §7.1: **one** `AgentChatView` instance serves every chat tab in a project.
 * Switching tabs changes props, never the component identity, and the outgoing
 * thread's rows keep painting until the next thread's snapshot lands — so a
 * tab switch never flashes an empty timeline. While that hold is in effect
 * every row callback is a no-op, so a click lands on the thread the user is
 * actually looking at.
 */
export interface AgentChatViewProps {
  session: SessionSummary;
  projectPath: string;
  /** True while this tab is the visible one; a hidden tab renders nothing live. */
  active: boolean;
}

export interface ChatTimelineProps {
  sessionId: string;
  rows: AgentChatTimelineRow[];
  /** Live-follow is a render-visible flag, never a ref (§7.3). */
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  disclosures: DisclosureState;
  onDisclosureChange: (patch: Partial<DisclosureState>) => void;
  /** Bottom content inset published by the composer overlay (§7.4). */
  bottomInset: number;
  /** Offered only where the adapter declares `supportsConversationRollback`. */
  canRevert: boolean;
  onRevert: (targetTurnCount: number) => void;
  /** Open a turn's unified diff (`GET …/turns/:n/diff`). */
  onOpenTurnDiff: (turnCount: number) => void;
  /** Click-through from a file-change row to an editor tab. */
  onOpenFile: (path: string) => void;
  /** Fetch one item's full, unslimmed payload (§5.6 "load full output"). */
  onLoadFullOutput: (itemId: string) => void;
  /** Drill in to a subagent's own timeline (§7.6). */
  onOpenAgent: (agentId: string) => void;
  onSendQueuedNow: (queuedId: string) => void;
  onReturnQueuedToComposer: (queuedId: string) => void;
  /** Overlaid, never a row: it must not change the list's content height (§7.3). */
  errorBanner: string | null;
  onDismissErrorBanner: () => void;
}

export interface ChatComposerProps {
  sessionId: string;
  /** The provider's catalog for the `/` and `$` menus (§4.6.7). */
  provider: ProviderSnapshot | null;
  modelSelection: ModelSelection | null;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** Shown only where `capabilities.showPlanModeToggle` (§4.4). */
  showPlanModeToggle: boolean;
  accountLabel: string | null;
  /** A turn is live: Enter steers, Escape interrupts, the primary action is Stop. */
  isTurnActive: boolean;
  /** Blocks a flush and disables submit while a card is open (§7.4). */
  hasPendingRequest: boolean;
  queue: QueuedComposerMessage[];
  activePlan: ActivePlanState | null;
  /** The un-implemented proposal that turns the primary action into a split button. */
  actionableProposedPlan: { planMarkdown: string } | null;
  /** The composer goes `inert` for exactly one reason (§7.5). */
  reverting: boolean;
  actions: AgentChatActions;
  /** Republished so the timeline can use it as its bottom content inset. */
  onHeightChange: (height: number) => void;
}

export interface ChatBannerDockProps {
  sessionId: string;
  /** One request at a time with a `1/N` counter (§7.5). */
  approvals: PendingApproval[];
  userInputs: PendingUserInput[];
  respondingRequestIds: readonly string[];
  /** Non-null with no turn working ⇒ the liveness banner with its single Stop (§7.6). */
  backgroundLiveness: BackgroundLiveness | null;
  liveAgentCount: number;
  stopping: boolean;
  actionableProposedPlan: boolean;
  onApprove: (input: { requestId: string; decision: ApprovalDecision }) => void;
  onAnswer: (input: {
    requestId: string;
    answers: Record<string, unknown>;
    attachmentsByQuestionId?: Record<string, AttachmentRef[]>;
  }) => void;
  /** Offered only when the request carries `dismissible` (§4.2, §6.2). */
  onDismiss: (requestId: string) => void;
  /** Posts `/interrupt` with no `turnId`. There is no per-row stop. */
  onStopBackgroundWork: () => void;
  /**
   * Text displaced by an answer is carried back into the draft rather than
   * silently discarded (§7.5).
   */
  onCarryTextToDraft: (text: string) => void;
}

export interface AgentRosterProps {
  sessionId: string;
  agents: RuntimeSubagent[];
  panel: AgentPanelModel;
  /** Rows past five collapse behind "N more" — a LIVE background row is exempt (§7.6). */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenAgent: (agentId: string) => void;
}

export interface AgentDrillInProps {
  sessionId: string;
  agentId: string;
  agent: RuntimeSubagent | null;
  /** The agent's own items, filtered by `agentId`, streaming live. */
  rows: AgentChatTimelineRow[];
  /** Read-only: the child view dispatches no commands (§7.6). */
  onBack: () => void;
}

export interface ChatStatusLineProps {
  sessionId: string;
  connection: AgentChatConnectionState;
  /** Self-ticking; never a prop pushed down the row tree (§7.6). */
  turnStartedAt: string | null;
  activityLabel: string | null;
  tokensUsed: number | null;
  contextMaxTokens: number | null;
  autoCompactAtTokens: number | null;
  totalProcessedTokens: number | null;
  /** False ⇒ the meter degrades to a bare total, never zeros (§7.6). */
  reportsContextWindow: boolean;
  activePlan: ActivePlanState | null;
  /** Always present: §4.6.3 synthesises `/compact` on all four adapters. */
  onCompact: () => void;
  latestCheckpoint: Checkpoint | null;
}
