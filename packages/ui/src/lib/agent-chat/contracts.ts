/**
 * Agent chat — the client-side seams (spec §7.2, §7.3, §7.4).
 *
 * Types only. `hooks.ts` ships inert stubs so components compile today;
 * package **W11** replaces them with the real store slice and transport.
 * This file is additive-only afterwards.
 */

import type {
  AgentGoalChange,
  AgentPanelModel,
  ApprovalDecision,
  AttachmentRef,
  BackgroundLiveness,
  Checkpoint,
  CompactionMarkerState,
  ComposerContextRecord,
  InteractionMode,
  ModelSelection,
  PendingApproval,
  PendingUserInput,
  ProviderRequestKind,
  ProviderSnapshot,
  RuntimeMode,
  RuntimeSubagent,
  ThreadActivityItem,
  ThreadGoal,
  ThreadHead,
  ThreadHistoryBounds,
  ThreadHistoryPage,
  ThreadItem,
  ThreadMessageItem,
  ThreadSessionStatus,
  ThreadTokenUsage,
  ToolLifecycleItemType,
  Turn,
  TurnState
} from "@orquester/api/agent-chat";
import type { ComposerDraft } from "./composer.logic";

// ---------------------------------------------------------------------------
// §7.2 — the per-thread store slice
// ---------------------------------------------------------------------------

/** Where the timeline is scrolled, remembered per thread in a 100-entry LRU. */
export interface RememberedTimelinePosition {
  rowId: string | null;
  offsetWithinRow: number;
  scrollOffset: number;
  atEnd: boolean;
  /**
   * The full set of what was open — expanded turns, expanded activity groups,
   * expanded subagent rows, expanded reasoning blocks, and the scroll offset
   * inside each expanded tool output — so returning to a tab restores the
   * reading position *and* the shape of the page under it.
   */
  disclosures: DisclosureState;
  /** The plan-mode toggle §6.2 keeps out of thread state and re-sends per turn. */
  interactionMode: InteractionMode;
}

export interface DisclosureState {
  expandedTurnIds: string[];
  expandedGroupIds: string[];
  expandedAgentIds: string[];
  expandedReasoningIds: string[];
  /** Row id → scroll offset inside that row's expanded tool output. */
  toolOutputOffsets: Record<string, number>;
}

/** §7.2 LRU capacity. */
export const TIMELINE_POSITION_LRU_LIMIT = 100;

/** Where the open thread's stream is, for the status line and the banners. */
export type AgentChatConnectionState =
  | "idle"
  | "connecting"
  | "synchronized"
  | "reconnecting"
  | "error";

/**
 * The client's own queue of messages it has not dispatched yet. A **different
 * thing** from the host-side queue that holds already-posted `/turn`s behind a
 * running compaction (§3.4). Held in memory only: a queued message is a live
 * intent, not a draft worth persisting (§7.4).
 */
export interface QueuedComposerMessage {
  id: string;
  text: string;
  attachments: AttachmentRef[];
  context: ComposerContextRecord[];
  interactionMode: InteractionMode;
  /** The tool activity it was queued behind; re-anchored as the queue drains. */
  queuedAfterToolActivityId: string | null;
  /** A failed send is re-inserted at the front with this, so nothing overtakes it. */
  holdUntilUserAction: boolean;
  queuedAt: string;
}

/**
 * The indexed history BELOW the retained window (design 2026-09-23 §C
 * "History page", "Client"): what the snapshot said about it, the pages the
 * user has pulled in so far, and the bridge that keeps them joined to the
 * window while it keeps evicting (design 2026-09-23 fold performance,
 * "Client — the history bridge").
 *
 * A cache of a log that may have been reverted, never an authority: a
 * `snapshot` frame resets it (bounds re-read, pages and bridge dropped), and
 * so does a rewind that reaches into a loaded page or a bridge row. In memory
 * only — it rides the retained thread snapshot and nothing is persisted.
 *
 * *Added with the thread index; `contracts.ts` stays additive-only.*
 */
export interface AgentChatHistoryState {
  /** The snapshot's `history` block; null from a host that predates the index. */
  bounds: ThreadHistoryBounds | null;
  /**
   * Oldest first, exactly as the host sent them. A row two pages share, or a
   * page shares with the bridge or the window, is resolved where the rows are
   * built: once, at its oldest place, with its newest content.
   */
  pages: ThreadHistoryPage[];
  /**
   * The rows the window's retention dropped while a page was loaded (or the
   * first one was on its way), oldest first — what sits between the newest
   * page and the window. Without it every eviction opened a hole there until
   * the chat was reloaded. Only rows the parent timeline renders are kept.
   *
   * *Added with the history bridge; `contracts.ts` stays additive-only.*
   */
  bridge: readonly ThreadItem[];
  /**
   * How many of the window's own items, counted from its oldest (the fold's
   * list order — the log's first-emission order), lie before the END of the
   * loaded history — the newest page's end, or the newest bridge row,
   * whichever is later. A message outlives the tool rows around it (2 000
   * against 500), and an agent's launch row or a compaction marker outlives
   * everything, so such rows render with the history, in their place, and
   * not below it. Zero with nothing loaded.
   *
   * *Added with the history bridge; `contracts.ts` stays additive-only.*
   */
  windowCut: number;
  /**
   * The window has dropped a row the parent timeline renders since the
   * snapshot the bounds came from. There is then older history to show
   * whatever that snapshot's `hasOlder` said, and its cursor names the block
   * below the window as it WAS — so the first page is asked for without one.
   * Reset by the next snapshot.
   *
   * *Added with the history bridge; `contracts.ts` stays additive-only.*
   */
  windowEvicted: boolean;
  /** A `GET …/history` is in flight; the "Load older turns" row spins. */
  loading: boolean;
  /** Why the last load failed, readable as it stands; cleared by the next success. */
  error: string | null;
}

/** One open thread's slice. Created on tab open, dropped on tab close (§7.2). */
export interface AgentChatThreadSlice {
  sessionId: string;
  head: ThreadHead | null;
  /** The snapshot's `items` with every later frame folded in. */
  entries: ThreadItem[];
  turns: Turn[];
  checkpoints: Checkpoint[];
  pending: { approvals: PendingApproval[]; userInputs: PendingUserInput[] };
  roster: RuntimeSubagent[];
  /** The latest turn's state, for the composer's primary action and the status line. */
  turnStatus: TurnState | null;
  sessionStatus: ThreadSessionStatus | null;
  backgroundLiveness: BackgroundLiveness | null;
  contextWindow: ThreadTokenUsage | null;
  seq: number;
  connection: AgentChatConnectionState;
  /** Live-follow is a render-visible flag, never a ref (§7.3). */
  follow: boolean;
  scroll: RememberedTimelinePosition | null;
  disclosures: DisclosureState;
  /** Client-local, re-sent on every `/turn`. */
  interactionMode: InteractionMode;
  queue: QueuedComposerMessage[];
  /** Request ids with a decision in flight; every control in that row is disabled. */
  respondingRequestIds: string[];
  /** Thread-level error banner text, overlaid — never a timeline row (§7.3). */
  errorBanner: string | null;
  /**
   * The indexed history below the retained window — its bounds and the pages
   * pulled in so far (design 2026-09-23 §C).
   *
   * *Added with the thread index; `contracts.ts` stays additive-only.*
   */
  history: AgentChatHistoryState;
  /**
   * The provider's goal as the fold holds it (goals §8.1): the snapshot's,
   * then every live `goal.updated` row that parses. `null` when the thread has
   * none — and from a host that predates goals. The fold's own object, so it
   * keeps its identity through every event that does not move it.
   *
   * *Added with agent goals; `contracts.ts` stays additive-only.*
   */
  goal: ThreadGoal | null;
}

/**
 * A turn the store wants on screen — the command palette's search hit
 * (design 2026-09-23 "Client"). The timeline scrolls `rowId` to the top of
 * the viewport, disarms follow, and acknowledges the `nonce`; a newer request
 * replaces an unhandled one.
 *
 * *Added with the thread index; `contracts.ts` stays additive-only.*
 */
export interface AgentChatRevealRequest {
  turnId: string;
  rowId: string;
  nonce: number;
}

// ---------------------------------------------------------------------------
// §7.2 — the normalised activity record the presentation resolver reads
// ---------------------------------------------------------------------------

export type WorkLogTone = "thinking" | "tool" | "info" | "error";

export type WorkLogToolLifecycleStatus = "inProgress" | "completed" | "failed" | "declined";

/**
 * **One normalised record, not a component taxonomy** (§7.2). Icon, label and
 * status chrome are all functions of these fields; adding a tool never adds a
 * component, and nothing branches on the provider.
 *
 * *T3: `apps/web/src/session-logic.ts:56-95` (`WorkLogEntry`).*
 */
export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId: string | null;
  /** Stable provider identity across the in-progress and completed updates of one call. */
  toolCallId?: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: readonly string[];
  tone: WorkLogTone;
  toolTitle?: string;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: ProviderRequestKind;
  /** From the runtime item/task payload `status` when present. */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** The originating activity kind (e.g. `user-input.requested`), for row chrome. */
  sourceActivityKind?: string;
  /**
   * True when §5.6's slimming dropped something and `GET …/items/:itemId`
   * genuinely holds more, so the expanded row may offer "load full output".
   * Mirrors `ThreadActivityPayloadFields.truncated`.
   *
   * *Added by W12; additive to the foundation's contract.*
   */
  truncated?: boolean;
  /** Grouping key for subagent lifecycle rows — one row per agent. */
  taskId?: string;
  /**
   * The tool call this row happened *inside* — a hook run or a CLI-side denial
   * belongs under the call that triggered it, not beside it. §5.1 promotes it
   * out of the payload precisely so the presentation layer can read it without
   * decoding.
   *
   * *Added by W11 in the fix wave (R7-10); `contracts.ts` stays additive-only.*
   */
  parentToolUseId?: string;
  agentRole?: string;
  /** Present on an answered-question row; the expansion shows the full history. */
  questionAnswer?: {
    requestId: string;
    answers: Record<string, unknown>;
    questionTextById?: Record<string, string>;
  };
  /**
   * Present on agent-spawn rows: **ids only**. The label, live flag and member
   * list resolve from the roster model at render time, because a persisted
   * count goes stale the moment a member finishes (§7.6).
   */
  agentSpawn?: {
    workflowId: string | null;
    agentTaskIds: readonly string[];
  };
  /**
   * Present on a compaction marker. Carried on `thread.state.changed` and
   * formatted client-side (§7.3 — differs from T3, which bakes the numbers
   * into a server-side label the row never reads).
   *
   * *Added by W11; `contracts.ts` stays additive-only.*
   */
  compaction?: {
    /**
     * Which of the three markers this is. An old log only ever recorded the
     * settled one and carries no `state` at all, so a marker with nothing
     * readable reads as `compacted` — never as an in-flight phase that would
     * shimmer forever.
     */
    state: CompactionMarkerState;
    beforeTokens?: number;
    afterTokens?: number;
    /** Set on `compaction-failed`: the provider's own reason, already user-facing. */
    error?: string;
    /**
     * The summary the provider wrote in place of everything it dropped — the
     * only record of what the thread used to say. Revealed behind the
     * marker's own toggle, collapsed by default (the CLI's `ctrl+o`).
     */
    summary?: string;
    /** The summary met §5.6's wire cap; the whole one is a full-item read away. */
    summaryTruncated?: boolean;
  };
  /**
   * Present on the §3.4 account-switch marker. **Ids only**, like
   * `agentSpawn`: the label resolves from the live account list at render
   * time, because the host has none to write and a name frozen into the log
   * goes stale the moment the account is renamed.
   */
  accountSwitch?: {
    /** Empty string is the system identity, as everywhere else. */
    accountId: string;
    previousAccountId?: string;
  };
  /**
   * Present on a goal marker (goals §8.4) — a `goal.updated` row that parsed
   * and is not `progress`. The label is the row's own summary; this is what
   * the marker needs beyond it, read off the goal the row is about (the
   * current one, or the one that ended).
   *
   * *Added with agent goals; `contracts.ts` stays additive-only.*
   */
  goal?: {
    change: AgentGoalChange;
    /** The whole objective: the summary cuts it to 200 characters. */
    objective?: string;
    rounds?: number;
    elapsedMs?: number;
    tokensUsed?: number;
  };
}

/**
 * The three states a compaction marker comes in. Declared in
 * `@orquester/api/agent-chat` (`compaction.ts`) with the rule that classifies
 * a row, which the host's thread index and the MCP share; re-exported here.
 */
export type { CompactionMarkerState };

// ---------------------------------------------------------------------------
// §7.3 — the twelve projected row kinds
// ---------------------------------------------------------------------------

export type ToolGroupSummaryKind = "read" | "edit" | "command" | "search" | "other";

/**
 * The twelve row kinds the timeline projects, T3's set verbatim
 * (`apps/web/src/components/chat/MessagesTimeline.logic.ts:329-442`), with
 * `worktree-setup` dropped (per-thread worktrees are a non-goal, §2) and
 * `turn-diff` added for the changed-files card §7.3 names — and, with agent
 * goals, `goal-marker` for a goal's landmarks (goals §8.4).
 */
export type AgentChatTimelineRow =
  | {
      kind: "activity-group";
      id: string;
      createdAt: string;
      turnId: string;
      groupId: string;
      entries: WorkLogEntry[];
      expanded: boolean;
      active: boolean;
      /** Set only on a LIVE group: its header is a live placeholder too. */
      compacting?: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      turnId: string | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: string;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      /** Carried on the event and formatted client-side (differs from T3). */
      beforeTokens?: number;
      afterTokens?: number;
      /**
       * The compaction did not happen and the conversation is unchanged: the
       * same hairline in the danger tone. Only ever set from a
       * `compaction-failed` marker — the in-flight `compacting` one projects
       * no row at all.
       */
      failed?: boolean;
      /** The failure's reason, on a second line under the label. */
      detail?: string;
      /**
       * The provider's summary of everything the compaction dropped, revealed
       * behind a toggle on the marker itself (§7.3). A failed compaction has
       * none — nothing was dropped.
       */
      summary?: string;
      /** The summary arrived capped by §5.6; the full one is one read away. */
      summaryTruncated?: boolean;
    }
  /**
   * A goal's landmark (goals §8.4): set, checked, paused, stopped, achieved,
   * failed, cleared — never `progress`, which only keeps the chip current.
   * Its own row like the compaction marker, never grouped — and, unlike it,
   * never folded into a settled turn: the story of the goal outlives the work
   * it drove.
   *
   * *Added with agent goals; additive to the contract.*
   */
  | {
      kind: "goal-marker";
      id: string;
      createdAt: string;
      turnId: string | null;
      /** The row's summary, as ingestion wrote it (goals §4.3). */
      label: string;
      change: AgentGoalChange;
      /** The whole objective, for the tooltip. */
      objective?: string;
      /**
       * Achieved/failed only: what the goal cost, carried raw and formatted
       * client-side like the compaction marker's counts. Each only when known.
       */
      rounds?: number;
      elapsedMs?: number;
      tokensUsed?: number;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ThreadMessageItem;
      durationStart: string;
      showAssistantMeta: boolean;
      /** Offered only where `supportsConversationRollback` (§6.3). */
      revertTurnCount?: number;
    }
  | {
      kind: "assistant-meta";
      id: string;
      createdAt: string;
      message: ThreadMessageItem;
    }
  | {
      kind: "turn-diff";
      id: string;
      createdAt: string;
      turnCount: number;
      turnId: string | null;
      files: Checkpoint["files"];
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      planMarkdown: string;
      implementedAt: string | null;
      /**
       * The wire cut `planMarkdown` at 16 KiB (§5.6). The card's Copy and
       * Download then read the whole plan back (`readFullPlanMarkdown`)
       * rather than hand over text that ends in "…".
       */
      truncated?: true;
    }
  /**
   * The live placeholders. `compacting` is set while the thread is in the
   * context-compaction phase, which replaces the generic label in place — the
   * row must never be remounted for it, or the shimmer restarts and the line
   * re-measures mid-turn (§7.3).
   */
  | { kind: "working"; id: string; createdAt: string | null; compacting?: boolean }
  | { kind: "thinking"; id: string; createdAt: string | null; compacting?: boolean }
  | {
      kind: "queued-message";
      id: string;
      createdAt: string;
      queuedMessage: QueuedComposerMessage;
      /** The oldest queued message — the one the next boundary sends. */
      isNext: boolean;
    };

export type AgentChatTimelineRowKind = AgentChatTimelineRow["kind"];

/** The plan checklist is a **composer** surface, not a timeline row (§7.3). */
export interface ActivePlanState {
  createdAt: string;
  turnId: string | null;
  explanation?: string | null;
  steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
}

// ---------------------------------------------------------------------------
// §7.2 / §7.4 — the actions interface
// ---------------------------------------------------------------------------

/**
 * Every mutation a chat surface can perform. Each maps onto one §6.2 command
 * and mints its own `commandId`; a retry reuses it, which the receipt makes
 * free (§6.6).
 *
 * **No optimistic path** for sends, approvals, answers or interrupts — the
 * user's message appears when its event arrives (§6.6).
 */
export interface AgentChatActions {
  /** `/turn`. Starts a turn, or steers the active one. */
  sendTurn(input: {
    text: string;
    attachments?: AttachmentRef[];
    context?: ComposerContextRecord[];
    interactionMode?: InteractionMode;
    modelSelection?: ModelSelection;
  }): Promise<void>;
  /** `/turn` against a live turn. Same route; named apart for call-site clarity. */
  steer(input: { text: string; attachments?: AttachmentRef[] }): Promise<void>;
  /**
   * The whole markdown of a proposal Implement is about to send (§7.3): as is
   * when intact, read back through `GET …/items/:itemId` when the wire cut it
   * (`truncated`, §5.6). Rejects rather than ever answer the cut text.
   */
  readFullPlanMarkdown(plan: { id: string; planMarkdown: string; truncated?: true }): Promise<string>;
  /**
   * `/interrupt`. Omits `turnId` whenever the session is not `running`, which
   * is also the only way to stop background work — and it stops all of it.
   */
  interrupt(input?: { turnId?: string }): Promise<void>;
  respondApproval(input: { requestId: string; decision: ApprovalDecision }): Promise<void>;
  answerQuestion(input: {
    requestId: string;
    answers: Record<string, unknown>;
    attachmentsByQuestionId?: Record<string, AttachmentRef[]>;
  }): Promise<void>;
  /** `/dismiss`. Offered only when the request carries `dismissible`. */
  dismissQuestion(input: { requestId: string }): Promise<void>;
  /** `/revert`. Conversation only — files are never restored (§5.5). */
  revert(input: { targetTurnCount: number }): Promise<void>;
  /**
   * "Rewind to here" / the Esc-Esc picker, end to end: `/revert` to
   * `targetTurnCount`, wait for the host to truncate the thread (or to land a
   * `checkpoint.revert.failed` row), then return the rewound message — its
   * text and its attachment chips — to the composer for editing, exactly as
   * the CLI's own rewind and T3's "Edit from here" do. `reverting` stays set
   * for the whole of it (§7.5). Rejects with the failure's reason.
   */
  rewindTo(input: { messageId: string; targetTurnCount: number }): Promise<void>;
  compact(): Promise<void>;
  /**
   * `/background` — the user's Ctrl+B: move one running tool call (or every
   * foreground one) to the background so the turn continues. Offered only
   * where the provider's capabilities carry `supportsBackgroundTasks`.
   */
  backgroundTool(input: { toolUseId?: string }): Promise<void>;
  setMode(input: { runtimeMode?: RuntimeMode; modelSelection?: ModelSelection }): Promise<void>;
  /**
   * `POST /api/sessions/:id/account` — §3.4's account switch, applied on the
   * next message. `accountId` is a managed account of the thread's family or
   * `SYSTEM_ACCOUNT_ID`. Offered only while the thread is idle
   * (`canSwitchChatAccount`); the daemon refuses anything else with a 409.
   */
  setAccount(input: { accountId: string }): Promise<void>;
  stopSession(): Promise<void>;
  /** The existing `POST /api/sessions/:id/upload`; returns the attachment reference. */
  uploadAttachment(file: File | Blob, meta: { name: string; type?: string }): Promise<AttachmentRef>;
  /** `GET /api/sessions/:id/attachments/:attachmentId` — bytes for an image chip's preview (§7.4). */
  fetchAttachmentBytes(attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer>;

  // Client-local queue ops (§7.4). None of these touch the host.
  queueMessage(message: Omit<QueuedComposerMessage, "id" | "queuedAt">): void;
  /** Send the head of the queue now, leaving the current draft alone. */
  sendQueuedNow(id: string): Promise<void>;
  /** Return one queued message to the composer. */
  returnQueuedToComposer(id: string): void;
  /** Interrupting returns EVERY queued message to the composer (§7.4). */
  drainQueueToComposer(): void;

  // Client-local view state.
  setInteractionMode(mode: InteractionMode): void;
  setFollow(follow: boolean): void;
  setDisclosure(patch: Partial<DisclosureState>): void;
  /**
   * Write this thread's entry in the §7.2 100-entry LRU: reading position
   * **and** the shape of the page under it. The timeline calls this as the
   * user scrolls (debounced by the caller); the disclosures come from the
   * slice, so a caller may pass the position fields alone.
   *
   * *Added by W11; `contracts.ts` stays additive-only.*
   */
  rememberScroll(position: Partial<RememberedTimelinePosition>): void;
  dismissErrorBanner(): void;
  /**
   * Persist what the composer has not sent (§7.4).
   *
   * **This store's draft is the one durable copy of an unsent message.** A
   * mounted composer loads it on mount and writes back through here on every
   * change (debounced, flushed on unmount), which is what carries a half-typed
   * message across a tab switch to another project — where the composer is
   * unmounted outright — and across a reload. `appendToDraft` merges into the
   * same draft for the window when no composer is mounted at all, so a queued
   * message returned by an interrupt is found by the next mount.
   *
   * Empty drafts are dropped from storage rather than stored, so a send that
   * clears the composer must reach this immediately: a write held back by the
   * debounce would let a reload resurrect a message that was already sent.
   *
   * *Added by W13 (as `takeDraft`) and turned into a save when the composer
   * became the owner of nothing; `contracts.ts` stays additive-only.*
   */
  saveDraft(draft: ComposerDraft): void;
  /** Re-read the thread (a host instance change, or a user retry). */
  refresh(): Promise<void>;
  /**
   * `GET …/history`: the next page of turns OLDER than what the thread holds,
   * prepended above everything loaded (design 2026-09-23 §C). Asks by the
   * oldest page's cursor; with nothing loaded, by the snapshot's — unless the
   * window has evicted rows since that snapshot, when it asks with none (the
   * block just below the window as it stands). Asks nothing when there is
   * nothing older.
   *
   * Never rejects: a failure lands in `slice.history.error` in words, never
   * in the thread's error banner. Overlapping calls share the one request in
   * flight, and a page that lands after a snapshot (or a rewind) replaced
   * the history it was asked against is dropped.
   *
   * *Added with the thread index; `contracts.ts` stays additive-only.*
   */
  loadOlderHistory(): Promise<void>;
  /**
   * Bring `turnId` on screen — the command palette's search hit. Waits for
   * the thread to synchronize, then scrolls to the turn when the window or a
   * loaded page holds it, and otherwise loads older pages until one does,
   * bounded at 25 pages. Resolves `true` once a reveal request is set, and
   * `false` for a turn the thread no longer has or cannot reach. Never
   * rejects.
   *
   * *Added with the thread index; `contracts.ts` stays additive-only.*
   */
  revealTurn(turnId: string): Promise<boolean>;
  /**
   * The timeline handled the reveal request carrying `nonce`; clear it. A
   * stale nonce clears nothing, so a newer request is never dropped.
   *
   * *Added with the thread index; `contracts.ts` stays additive-only.*
   */
  acknowledgeReveal(nonce: number): void;
}

// ---------------------------------------------------------------------------
// View-model hook signatures (implemented by W11 in `hooks.ts`)
// ---------------------------------------------------------------------------

export interface AgentChatThreadView {
  slice: AgentChatThreadSlice;
  actions: AgentChatActions;
  /** Memoised rows (§7.2: entries → rows → stable rows). */
  rows: AgentChatTimelineRow[];
  activePlan: ActivePlanState | null;
  /**
   * The un-implemented proposal the composer's primary action acts on (§7.3):
   * `null` turns the split button back into a plain send. Derived from the
   * timeline projection's `proposedPlans`, which never leaves the store.
   * `id`/`turnId` ride along so a consumer can tell one proposal from the next
   * without diffing markdown.
   *
   * *Added by W15, widened by W11 in the fix wave (R8-B1 / R7-2);
   * `contracts.ts` stays additive-only.*
   */
  actionableProposedPlan: {
    id: string;
    planMarkdown: string;
    turnId: string | null;
    /** The wire cut `planMarkdown` (§5.6): see `readFullPlanMarkdown`. */
    truncated?: true;
  } | null;
  /**
   * True while a `/revert` is in flight — §7.5's one reason the composer goes
   * `inert`, so a turn cannot race history the host is rewriting.
   *
   * *Added by W15; `contracts.ts` stays additive-only.*
   */
  reverting: boolean;
  /**
   * The turn the timeline should bring on screen, until it acknowledges it.
   *
   * *Added with the thread index; `contracts.ts` stays additive-only.*
   */
  reveal: AgentChatRevealRequest | null;
}

export interface AgentChatRosterView {
  agents: RuntimeSubagent[];
  panel: AgentPanelModel;
  backgroundLiveness: BackgroundLiveness | null;
  /** True while an interrupt is in flight; the Stop button reads "Stopping…". */
  stopping: boolean;
}

export interface AgentChatPendingView {
  approvals: PendingApproval[];
  userInputs: PendingUserInput[];
  /** `1/N` counters and the in-flight lock-out come from these. */
  respondingRequestIds: readonly string[];
  totalCount: number;
}

export interface AgentChatStatusView {
  sessionStatus: ThreadSessionStatus | null;
  turnStatus: TurnState | null;
  connection: AgentChatConnectionState;
  contextWindow: ThreadTokenUsage | null;
  /** Absent on an adapter with `reportsContextWindow: false`; degrade, never zeros. */
  reportsContextWindow: boolean;
  activityLabel: string | null;
  turnStartedAt: string | null;
  /**
   * The provider is compacting the conversation — the store's own phase, the
   * one the timeline's live placeholders show. The account chip names it the
   * way the host's refusal does (goals §5.5, fix round 2).
   *
   * *Added with agent goals; `contracts.ts` stays additive-only.*
   */
  isCompacting: boolean;
}

export type UseAgentChatThread = (sessionId: string) => AgentChatThreadView;
export type UseAgentChatRoster = (sessionId: string) => AgentChatRosterView;
export type UseAgentChatPending = (sessionId: string) => AgentChatPendingView;
export type UseAgentChatStatus = (sessionId: string) => AgentChatStatusView;
/** `refId` is the registry id; the hook maps it to its adapter's snapshot. */
export type UseProviderSnapshot = (refId: string) => ProviderSnapshot | null;

/** Narrowing helpers the row components use instead of re-deriving. */
export function isActivityEntry(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity";
}

export function isMessageEntry(item: ThreadItem): item is ThreadMessageItem {
  return item.kind === "message";
}
