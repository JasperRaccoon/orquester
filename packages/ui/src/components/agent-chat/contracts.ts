import type React from "react";
/**
 * Agent chat — component prop contracts (spec §7.1, §7.3–§7.6).
 *
 * Shared props for the thread view and its child components.
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
import type {
  AgentGoal,
  AgentPanelModel,
  GoalAction,
  RuntimeMode
} from "@orquester/api/agent-chat";

import type { ChatAccountOption } from "../../lib/agent-chat/account-switch";
import type { GoalActionModel } from "./status/goal-chip";
import type {
  ActivePlanState,
  AgentChatActions,
  AgentChatConnectionState,
  AgentChatTimelineRow,
  DisclosureState,
  QueuedComposerMessage,
  RememberedTimelinePosition
} from "../../lib/agent-chat/contracts";
import type { FullOutputSource } from "../../lib/agent-chat/full-output";
import type { DrillInMemoryEntry } from "./roster/drill-in-memory";
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
   */
  revertBusy?: boolean | undefined;
  /**
   * How many turns the thread has started (`startedTurns(turns).length`), so
   * a row can say how many turns its rewind removes. Absent means 0, which
   * makes every rewind read as removing one turn — the floor.
   */
  startedTurnCount?: number | undefined;
  /** Open a turn's unified diff (`GET …/turns/:n/diff`). */
  onOpenTurnDiff: (turnCount: number) => void;
  /** Click-through from a file-change row to an editor tab. */
  onOpenFile: (path: string) => void;
  /**
   * Fetch one item's full, unslimmed payload (§5.6 "load full output") — or,
   * for a command whose output streamed (`source: "streamed"`), first its
   * call's whole output as the host joins it (§6.3).
   */
  onLoadFullOutput: (itemId: string, source?: FullOutputSource) => void;
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
   * Set by the drill-in (§7.6): `rows` are then THIS agent's, which the
   * drill-in projected itself (`useAgentChatDrillIn`) — the timeline renders
   * them as they are, as it renders the thread's. Its presence also forces
   * {@link readOnly}, because a child view dispatches no commands.
   */
  agentId?: string | undefined;
  /** Read-only: every mutating affordance is withheld, nothing is disabled-looking. */
  readOnly?: boolean | undefined;
  /**
   * The thread's retained window has dropped rows (the store's
   * `retentionDropped`). Read by a drill-in's empty copy alone: an agent's
   * rows may be said to have LEFT the window only when the window dropped
   * some (`timeline/empty-notice.ts`). Absent means no.
   */
  retentionDropped?: boolean | undefined;
  /**
   * The roster the spawn row resolves against **at render time** — a persisted
   * member count goes stale the moment a member finishes (§7.6).
   */
  roster?: readonly RuntimeSubagent[] | undefined;
  /**
   * A drill-in's agent row as the drill-in knows it: the roster's, else the
   * last one it saw — the roster keeps 100 rows and evicts the oldest settled
   * ones first (`drillInAgentRow`). Read instead of looking the row up in
   * `roster`: its kind decides the shell pane and the empty copy. Absent: the
   * roster's.
   */
  drilledAgent?: RuntimeSubagent | null | undefined;
  /**
   * `drilledAgent` is the row the drill-in last saw, not the roster's: its
   * kind holds, its status is not current — the empty copy reads it as not
   * live, as the timeline's rows do.
   */
  drilledAgentRemembered?: boolean | undefined;
  /**
   * The drill-in is a background shell's: its row says so, or, with no row at
   * all, its items (`isBackgroundShellItems`). Absent: the drilled row's kind.
   */
  backgroundShell?: boolean | undefined;
  /** The project directory, so changed-file paths render workspace-relative. */
  projectPath?: string | undefined;
  /**
   * The current per-cwd skill names, so a sent message's `$mentions` are
   * **re-chipped from the stored text** (§4.6.7) — no `isCommand` flag is
   * persisted, the text is the record. Wired from the provider snapshot
   * (`timelineSkillNames`: every skill in the thread's cwd's overlay, else in
   * the machine-level catalogue — wider than the `$` menu, which offers only
   * the enabled, user-invocable ones); empty means no chips.
   */
  skills?: readonly string[] | undefined;
  /**
   * The remembered reading position to restore on mount and on every
   * `sessionId` (or `agentId`) change: the thread's, from W11's 100-entry LRU
   * (§7.2); a drill-in's, from the view's per-agent memory
   * (`roster/drill-in-memory.ts`), never that LRU. An absent or at-end
   * position opens at the end.
   */
  scroll?: TimelineScrollPosition | null | undefined;
  /**
   * Publishes the reading position as the user scrolls (one measurement per
   * frame). The thread's view passes its store's `rememberScroll`, which
   * writes `slice.scroll`, sets `follow` from `atEnd` and persists the §7.2
   * LRU entry at once — a no-op while the view paints a held timeline (the
   * §7.1 paint hold). The timeline also writes the same action itself,
   * debounced and flushed on unmount and on a thread switch: a second write
   * of the thread's LRU, never made for a drill-in. A drill-in hands the
   * position to its per-agent memory (`roster/drill-in-memory.ts`), never the
   * LRU.
   */
  onScrollPositionChange?: ((position: TimelineScrollPosition) => void) | undefined;
  /**
   * Older turns exist beyond everything the timeline holds (design
   * 2026-09-23 §C "History page"): a "Load older turns" row sits above the
   * first row. Never offered on a read-only surface or the drill-in. Absent
   * means no.
   */
  historyHasOlder?: boolean | undefined;
  /** A page is loading: the row spins and cannot be pressed again. */
  historyLoading?: boolean | undefined;
  /** Why the last load failed, in words, shown inline under the row. */
  historyError?: string | null | undefined;
  /**
   * Fetch the next older page. It is prepended ABOVE the rows; the timeline
   * keeps the viewport on what the user was reading (scroll anchoring) unless
   * it is following the end.
   */
  onLoadOlderHistory?: (() => void) | undefined;
  /**
   * A row the store wants on screen — the command palette's search hit. The
   * timeline scrolls it to the top of the viewport once it is rendered and
   * visible, disarms follow, and hands the nonce back through
   * {@link onRevealHandled}.
   */
  revealRequest?: { rowId: string; nonce: number } | null | undefined;
  onRevealHandled?: ((nonce: number) => void) | undefined;
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
  /**
   * The reason the picker is closed, in the host's own order and words
   * (`chatAccountSwitchRefusal`): a running compaction, else a goal held for
   * an Orquester update, which the user's `/goal pause` takes back (goals
   * §5.7), else a continuing goal, which only a pause ends (§5.5). Absent ⇒
   * the chip's own "available when idle".
   */
  accountSwitchRefusal?: string | null | undefined;
  /** A turn is live: Enter steers, Escape interrupts, the primary action is Stop. */
  isTurnActive: boolean;
  /** Blocks a flush and disables submit while a card is open (§7.4). */
  hasPendingRequest: boolean;
  queue: QueuedComposerMessage[];
  activePlan: ActivePlanState | null;
  /**
   * The un-implemented proposal that turns the primary action into a split
   * button. Implement reads it through `actions.readFullPlanMarkdown`, so it
   * takes that reader's own input type.
   */
  actionableProposedPlan: Parameters<AgentChatActions["readFullPlanMarkdown"]>[0] | null;
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
  /** Live subagents — never a background shell (`rosterKindCounts`). */
  liveAgentCount: number;
  /** Background shells still running, named apart from the agents. */
  liveShellCount?: number;
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
 * Without it the roster renders no main row and settled rows never fade.
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
  /** Read-only: the child view dispatches no commands (§7.6). */
  onBack: () => void;
  /**
   * The docked overlay's measured height — status line, banner dock, composer
   * and roster. The drill-in swaps only the main area, so the overlay floats
   * over the child's timeline exactly as over the thread's own, and that
   * timeline reserves the same footer: at 0 the child's newest rows stayed
   * behind the composer, out of reach of any scroll.
   */
  bottomInset: number;
  /**
   * The thread's roster, forwarded to the timeline so a spawn row *inside* a
   * child (an agent that spawned its own) resolves its members at render time
   * instead of reading "Status unavailable".
   */
  roster?: readonly RuntimeSubagent[] | undefined;
  /** Forwarded so changed-file paths render workspace-relative. */
  projectPath?: string | undefined;
  /**
   * The parent view's full-output viewer. A read, not a command, so the child
   * view offers it too: an agent's window keeps 200 rows, and a long
   * command's output outlives it in the host's join. Absent means inert.
   */
  onLoadFullOutput?: ((itemId: string, source?: FullOutputSource) => void) | undefined;
  /**
   * The parent view's click-through to the file browser: navigation, not a
   * command, so a file a child's words link to, a changed-file line and a
   * diff heading open it as they do in the thread. Absent means inert.
   */
  onOpenFile?: ((path: string) => void) | undefined;
  /**
   * Switch the drill-in to another agent: a spawn row inside a child — an
   * agent that launched its own — lists its members, and opening one is
   * navigation, as the roster's rows are. Absent means inert.
   */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  /**
   * The THREAD's error banner, overlaid on the child's timeline as on the
   * thread's own. The overlay stays live over a child — approvals, answers,
   * Stop, compact — and those commands report a failure only here, so a
   * drill-in that hid it hid the failure until Back. Dismissing it is a UI
   * action, not a command. Absent means no banner.
   */
  errorBanner?: string | null | undefined;
  onDismissErrorBanner?: (() => void) | undefined;
  /**
   * What the host remembered of this agent (`roster/drill-in-memory.ts`): the
   * drill-in opens from it — its disclosures, and a reading position left
   * mid-list, with follow off. The host keys the component by `agentId`, so
   * every agent opens from its own entry. Absent: at the end, following.
   */
  remembered?: DrillInMemoryEntry | null | undefined;
  /** Every change of the agent's disclosures, follow or reading position: the host's memory. */
  onRemember?: ((agentId: string, entry: DrillInMemoryEntry) => void) | undefined;
  /**
   * The thread's skill names, so a `$mention` in the child's rows — its
   * launch prompt above all — re-chips as it does in the thread
   * (`ChatTimelineProps.skills`). Absent means no chips.
   */
  skills?: readonly string[] | undefined;
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
   * *T3 passes `modelDisplayName`,
   * `ContextWindowMeter.tsx:136-138`.*
   */
  modelLabel?: string | null;
  /**
   * The thread's goal, as the fold holds it (goals §8.2). The chip shows
   * exactly an unfinished one, in a stable slot before the plan chip; absent
   * or `null` ⇒ no chip.
   */
  goal?: AgentGoal | null;
  /**
   * The paused goal is HELD for an Orquester update (goals §5.7) —
   * `isGoalHeldForUpdate` over the fold's goal, the tab summary and the
   * head. The chip then reads `paused for update` in the in-motion tone, not
   * a user's pause in the warn tone, and its popover says it resumes by
   * itself. Absent reads as no.
   */
  goalHeldForUpdate?: boolean;
  /** The chip's actions, already gated by the §8.2 matrix (`goalActions`). */
  goalActions?: readonly GoalActionModel[];
  /** Why the popover offers no action right now, when that needs saying. */
  goalActionsNote?: string | null;
  /**
   * Send one action as the user's message — through the composer's own send
   * path, never around it (goals §8.2).
   */
  onGoalAction?: (action: GoalAction) => void;
}
