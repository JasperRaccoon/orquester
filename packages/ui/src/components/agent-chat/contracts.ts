import type React from "react";
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
// `RuntimeMode` MUST come from this path: the root `@orquester/api` declares a
// `RuntimeMode` of its own (the client platform — `desktop-local` | …) whose
// local declaration shadows the star re-export, so importing it from there
// silently types the composer's permission-mode chip as a platform name.
import type { AgentPanelModel, RuntimeMode } from "@orquester/api/agent-chat";

import type { ChatAccountOption } from "../../lib/agent-chat/account-switch";
import type {
  ActivePlanState,
  AgentChatActions,
  AgentChatConnectionState,
  AgentChatTimelineRow,
  DisclosureState,
  QueuedComposerMessage,
  RememberedTimelinePosition
} from "../../lib/agent-chat/contracts";
import type { RewindTarget } from "../../lib/agent-chat/rewind.logic";

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
  /**
   * "Rewind to here" on a user message (§5.5), confirmed in the row's own
   * popover: the conversation goes back to just before `messageId`, keeping
   * `targetTurnCount` turns, and the message returns to the composer. Files
   * are never touched. The view dispatches `actions.rewindTo(input)`.
   */
  onRevert: (input: { messageId: string; targetTurnCount: number }) => void;
  /**
   * A turn is running or a revert is in flight: the rewind button is shown
   * but disabled ("Available when the agent is idle"). Absent means idle.
   *
   * *Added with the rewind surfaces; additive to the foundation's contract.*
   */
  revertBusy?: boolean | undefined;
  /**
   * How many turns the thread has started (`startedTurns(turns).length`), so
   * a row can say how many turns its rewind removes. Absent means 0, which
   * makes every rewind read as removing one turn — the floor.
   *
   * *Added with the rewind surfaces; additive to the foundation's contract.*
   */
  startedTurnCount?: number | undefined;
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
  /**
   * What an EMPTY, synchronized thread shows instead of "No messages yet."
   * (the provider's resumable conversations, built by the view so the
   * timeline never imports the registry or its icons). Absent means the plain
   * placeholder.
   */
  emptyThreadPanel?: React.ReactNode;
  /**
   * The thread's stream is synchronized and its rows are the real ones. The
   * empty-thread panel is gated on it: while a thread is still (re)connecting
   * it has no rows either, and the panel must not flash over a thread that is
   * anything but empty.
   */
  threadReady?: boolean;
  /** See `TimelineRowContextValue.canBackgroundTasks`; absent means no. */
  canBackgroundTasks?: boolean;
  /** The user's Ctrl+B on one running tool call (`/background`). */
  onBackgroundTool?: (toolUseId: string) => void;
  /** Overlaid, never a row: it must not change the list's content height (§7.3). */
  errorBanner: string | null;
  onDismissErrorBanner: () => void;
  /**
   * Set by the drill-in (§7.6): the same component renders THIS agent's rows,
   * already filtered by the store. Its presence also forces {@link readOnly},
   * because a child view dispatches no commands.
   *
   * *Added by W12; additive to the foundation's contract.*
   */
  agentId?: string | undefined;
  /** Read-only: every mutating affordance is withheld, nothing is disabled-looking. */
  readOnly?: boolean | undefined;
  /**
   * The roster the spawn row resolves against **at render time** — a persisted
   * member count goes stale the moment a member finishes (§7.6).
   *
   * *Added by W12; additive to the foundation's contract.*
   */
  roster?: readonly RuntimeSubagent[] | undefined;
  /** The project directory, so changed-file paths render workspace-relative. */
  projectPath?: string | undefined;
  /**
   * The current per-cwd skill names, so a sent message's `$mentions` are
   * **re-chipped from the stored text** (§4.6.7) — no `isCommand` flag is
   * persisted, the text is the record. Wire it from the provider snapshot
   * (`provider.skills.map((skill) => skill.name)`); empty means no chips.
   *
   * *Added by W12; additive to the foundation's contract.*
   */
  skills?: readonly string[] | undefined;
  /**
   * The remembered reading position for this thread, from W11's 100-entry LRU
   * (§7.2). Restored on mount and on every `sessionId` change.
   *
   * *Added by W12; additive to the foundation's contract.*
   */
  scroll?: TimelineScrollPosition | null | undefined;
  /** Publishes the reading position back into that LRU as the user scrolls. */
  onScrollPositionChange?: ((position: TimelineScrollPosition) => void) | undefined;
}

/**
 * The scroll half of {@link RememberedTimelinePosition}: the disclosure sets
 * and the interaction mode belong to the store and the composer, not to the
 * scroll container, so the timeline reads and writes only these four fields.
 */
export type TimelineScrollPosition = Pick<
  RememberedTimelinePosition,
  "rowId" | "offsetWithinRow" | "scrollOffset" | "atEnd"
>;

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
  /**
   * The §3.4 account picker. Omitted (or empty) keeps the chip a label —
   * an OpenCode thread runs under its server's identity and has nothing to
   * pick. `accountSwitchEnabled` is the idle gate (`canSwitchChatAccount`);
   * the daemon is authoritative and refuses anything else with a 409.
   */
  accountOptions?: readonly ChatAccountOption[] | undefined;
  accountId?: string | undefined;
  accountSwitchEnabled?: boolean | undefined;
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
  /**
   * The messages the rewind picker lists, newest first (`deriveRewindTargets`
   * over the rows the timeline renders, so the picker and the per-row button
   * can never disagree). Empty hides the picker's button altogether.
   */
  rewindTargets: readonly RewindTarget[];
  /**
   * A confirmed pick from the rewind picker — the double Escape's
   * destination (§5.5). Conversation only; the view dispatches
   * `actions.rewindTo`, which returns the message to this composer.
   */
  onRewind: (target: RewindTarget) => void;
  actions: AgentChatActions;
  /** Republished so the timeline can use it as its bottom content inset. */
  onHeightChange: (height: number) => void;
  /**
   * Publishes how many attachments the draft holds, so the shell can apply
   * §7.3's last plan-ready condition ("the composer holds no attachments") to
   * the **docked banner** as well as the primary action.
   *
   * The draft is component state — the shell cannot read it, and the banner
   * lives above the composer in the shell's overlay stack — so the count has
   * to come back out. Fires on mount and on every change; a composer that
   * never mounts simply never publishes, and the shell's own default is 0.
   *
   * *Added by W15 for the R7-2 residual; additive to the foundation's
   * contract.*
   */
  onDraftAttachmentCountChange?: ((count: number) => void) | undefined;
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

/**
 * The roster's own first row: the thread itself (§7.6, "a `main` row, then one
 * row per subagent").
 *
 * The parent is not in `agents` — it is not a task — so the shell passes its
 * state here, in the same three-line shape a subagent row uses. `turnActive`
 * is also what drives the fade: finished rows disappear when the turn ends.
 *
 * **Added by W14** (additively; every field optional at the call site through
 * `main` itself being optional). Without it the roster simply renders no main
 * row and settled rows never fade.
 */
export interface AgentRosterMainRow {
  /** Defaults to "main". The thread title is the tab's job, not the roster's. */
  title?: string;
  /** A turn is running: the row is in-motion and finished rows stay visible. */
  turnActive: boolean;
  /** A request is waiting on the user — act-now, not in-motion. */
  awaitingUser?: boolean;
  /** The last turn failed; the row reads broken until the next turn starts. */
  failed?: boolean;
  /** Mirrors `ChatStatusLineProps.activityLabel`. */
  activityLabel: string | null;
  turnStartedAt: string | null;
  /** Freezes the elapsed readout once the turn settles. */
  turnEndedAt?: string | null;
  /** Thread tokens so far, for the metrics line. */
  tokensUsed: number | null;
  model?: string | null;
  effort?: string | null;
}

export interface AgentRosterProps {
  sessionId: string;
  agents: RuntimeSubagent[];
  panel: AgentPanelModel;
  /** Rows past five collapse behind "N more" — a LIVE background row is exempt (§7.6). */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenAgent: (agentId: string) => void;
  /** The `main` row was clicked: leave the drill-in and show the thread again. */
  onOpenMain?: () => void;
  /** The parent thread's own row. Omit it and no main row renders. */
  main?: AgentRosterMainRow | null;
  /** The drilled-in agent, so its row reads as the open one. */
  activeAgentId?: string | null;
  /** Folded to its one-line summary (the rows hidden); persisted per device. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export interface AgentDrillInProps {
  sessionId: string;
  agentId: string;
  /**
   * Overrides for what the component otherwise reads itself from
   * `useAgentChatDrillIn(sessionId, agentId)` — the agent's own items,
   * filtered by `agentId` and streaming live, projected off the parent's
   * slice. A host that already holds them may pass them; nobody has to.
   *
   * *Relaxed from required by W14 once W11's hook landed.*
   */
  agent?: RuntimeSubagent | null;
  rows?: AgentChatTimelineRow[];
  /** Read-only: the child view dispatches no commands (§7.6). */
  onBack: () => void;
  /**
   * The thread's roster, forwarded to the timeline so a spawn row *inside* a
   * child (an agent that spawned its own) resolves its members at render time
   * instead of reading "Status unavailable".
   *
   * *Added by W14; additive to the foundation's contract.*
   */
  roster?: readonly RuntimeSubagent[] | undefined;
  /** Forwarded so changed-file paths render workspace-relative. */
  projectPath?: string | undefined;
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
  /**
   * `thread.token-usage.updated {usage.compactsAutomatically}`. `false` is a
   * provider verdict and changes the popover's sentence; `null`/omitted means
   * nobody asked (§7.6).
   */
  compactsAutomatically?: boolean | null;
  activePlan: ActivePlanState | null;
  /** Always present: §4.6.3 synthesises `/compact` on all four adapters. */
  onCompact: () => void;
  latestCheckpoint: Checkpoint | null;
  /**
   * The thread's model, for the meter's auto-compaction sentence (§7.6): with
   * no `autoCompactAtTokens` the sentence can still name what compacts, and
   * without the label it degrades to a generic line although the model is
   * right there on the thread head.
   *
   * *Added by W14 and W15 for R8 m3; T3 passes `modelDisplayName`,
   * `ContextWindowMeter.tsx:136-138`.*
   */
  modelLabel?: string | null;
}
