/**
 * Agent chat — the per-thread zustand slice (spec §7.2, §6.6).
 *
 * **A zustand slice per open thread, created on tab open and dropped on tab
 * close.** Closed tabs keep nothing; the tab strip reads only
 * `SessionSummary`. The slices are held in a refcounted registry so one
 * `AgentChatView` instance can serve every chat tab in a project (§7.1) and a
 * tab switch never tears down the thread the user is switching *from* until
 * the next snapshot lands.
 *
 * **Server-authoritative, cursor-ordered** (§6.6): every mutation is a command
 * answered with `{seq}`; sends, approvals, answers and interrupts have **no**
 * optimistic path — the user's message appears when its event arrives. The one
 * narrow optimistic rule (tab-local reorder/rename) lives in the app store, not
 * here.
 *
 * No React import — `hooks.ts` is the only React file in this package.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

import {
  ACTIVE_SUBAGENT_STATUSES,
  DEFAULT_INTERACTION_MODE,
  type AgentChatCommandBodies,
  type AgentChatCommandName,
  type ApprovalDecision,
  type AttachmentRef,
  type ComposerContextRecord,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode,
  type RuntimeSubagent,
  type ThreadTokenUsage
} from "@orquester/api/agent-chat";

import type {
  ActivePlanState,
  AgentChatActions,
  AgentChatThreadSlice,
  AgentChatTimelineRow,
  DisclosureState,
  QueuedComposerMessage
} from "./contracts";
import {
  EMPTY_DRAFT,
  type ComposerDraft,
  readPersistedDrafts,
  writePersistedDrafts
} from "./composer.logic";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  type ThreadTimelineProjection
} from "./entries.logic";
import { deriveActivePlanState } from "./plan.logic";
import {
  applyFrame,
  createReducerState,
  latestTurnSettled,
  needsResync,
  patchSlice,
  type AgentChatReducerState
} from "./reducer.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "./rows.logic";
import { liveAgentTaskIds } from "./roster.logic";
import { latestContextWindowActivity } from "./status.logic";
import {
  drainQueue,
  EMPTY_QUEUE,
  enqueue,
  holdAtFront,
  latestCompletedToolActivityId,
  removeQueued,
  takeQueued,
  type QueuePhase,
  type QueueState
} from "./queue.logic";
import {
  composerHandle,
  insertComposerText
} from "../../components/agent-chat/composer/composer-bridge";
import { disclosureSets, timelinePositionStore } from "./timeline-position";
import {
  AgentChatCommandError,
  type AgentChatStreamHandle,
  type AgentChatTransport
} from "./transport";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ThreadStoreDeps {
  transport: AgentChatTransport;
  /** Injected so tests are deterministic. */
  newId?: () => string;
  now?: () => string;
  /** How many times a `HOST_UNAVAILABLE` command is retried with the SAME id. */
  hostUnavailableRetries?: number;
  /** Injected in tests; production uses `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

function defaultId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) {
    return cryptoRef.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AgentChatThreadState {
  /** What the hooks read (§7.2). */
  slice: AgentChatThreadSlice;
  /** The three memoised projection layers, kept so each can take its fast path. */
  rows: AgentChatTimelineRow[];
  activePlan: ActivePlanState | null;
  /** The composer's persisted draft for this thread. */
  draft: ComposerDraft;
  /** True while an interrupt is in flight; the Stop button reads "Stopping…". */
  stopping: boolean;
  actions: AgentChatActions;
}

interface InternalState extends AgentChatThreadState {
  reducer: AgentChatReducerState;
  queue: QueueState;
  timeline: ThreadTimelineProjection;
  rowsProjection: TimelineRowsProjection | null;
  stableRows: StableRowsState;
}

export type ThreadStore = StoreApi<AgentChatThreadState>;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * `backgroundLiveness` is the §3.1 registry value: `"working"` while any agent
 * work is live, `"monitoring"` only when watch loops and background shells are
 * the *only* live work, `null` otherwise. The authoritative copy rides
 * `SessionSummary` for the ambient surfaces (§6.4); the open tab derives the
 * same answer from the roster it already has rather than waiting on a bus
 * event, and the two agree because both read the same task classification.
 */
function deriveBackgroundLiveness(
  roster: readonly RuntimeSubagent[]
): "working" | "monitoring" | null {
  let liveAgents = 0;
  let liveBackground = 0;
  for (const agent of roster) {
    if (!ACTIVE_SUBAGENT_STATUSES.has(agent.status)) {
      continue;
    }
    if (agent.agentKind === "background") {
      liveBackground += 1;
    } else {
      liveAgents += 1;
    }
  }
  if (liveAgents > 0) {
    return "working";
  }
  return liveBackground > 0 ? "monitoring" : null;
}

function project(state: InternalState): InternalState {
  const timeline0 = deriveTimelineEntriesFromItems(state.slice.entries, state.timeline);
  const contextWindowEntry = latestContextWindowActivity(timeline0.activities);
  const backgroundLiveness = deriveBackgroundLiveness(state.slice.roster);
  const contextWindow = contextWindowEntry?.usage ?? null;
  const derivedReducer =
    state.slice.backgroundLiveness === backgroundLiveness &&
    sameUsage(state.slice.contextWindow, contextWindow)
      ? state.reducer
      : patchSlice(state.reducer, {
          backgroundLiveness,
          contextWindow: sameUsage(state.slice.contextWindow, contextWindow)
            ? state.slice.contextWindow
            : contextWindow
        });
  if (derivedReducer !== state.reducer) {
    state = { ...state, reducer: derivedReducer, slice: derivedReducer.slice };
  }
  const slice = state.slice;
  const timeline = timeline0;
  const sets = disclosureSets(slice.disclosures);
  const runningTurnId = slice.head?.session.activeTurnId ?? null;
  const latestTurn = slice.turns.at(-1) ?? null;
  const rowsProjection = deriveTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      latestTurn: latestTurn
        ? {
            turnId: latestTurn.turnId,
            state: latestTurn.state,
            startedAt: latestTurn.startedAt,
            completedAt: latestTurn.completedAt
          }
        : null,
      runningTurnId,
      expandedTurnIds: sets.expandedTurnIds,
      expandedWorkGroupIds: sets.expandedGroupIds,
      isWorking:
        slice.sessionStatus === "running" ||
        slice.turnStatus === "running" ||
        slice.turnStatus === "pending",
      activeTurnStartedAt: latestTurn?.startedAt ?? latestTurn?.requestedAt ?? null,
      checkpoints: slice.checkpoints,
      // Without the provider snapshot we cannot know; "rewind to here" is then
      // withheld rather than offered and failing at step 2 of §5.5.
      supportsConversationRollback: state.slice.head !== null,
      liveAgentTaskIds: liveAgentTaskIds(slice.roster),
      queuedMessages: state.queue.messages
    },
    state.rowsProjection
  );
  const stableRows = computeStableRows(rowsProjection.rows, state.stableRows);
  const activities = timeline.activities;
  const activePlan = deriveActivePlanState(activities, latestTurn?.turnId ?? null);

  if (
    timeline === state.timeline &&
    rowsProjection === state.rowsProjection &&
    stableRows === state.stableRows &&
    activePlan === state.activePlan
  ) {
    return state;
  }
  return {
    ...state,
    timeline,
    rowsProjection,
    stableRows,
    rows: stableRows.result,
    // `deriveActivePlanState` rebuilds its object each call; keep the previous
    // one when nothing about it moved, so the composer's checklist does not
    // re-render on every streamed token.
    activePlan: samePlan(state.activePlan, activePlan) ? state.activePlan : activePlan
  };
}

function sameUsage(
  left: ThreadTokenUsage | null,
  right: ThreadTokenUsage | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.usedTokens === right.usedTokens &&
    left.maxTokens === right.maxTokens &&
    left.autoCompactAtTokens === right.autoCompactAtTokens &&
    left.totalProcessedTokens === right.totalProcessedTokens
  );
}

function samePlan(left: ActivePlanState | null, right: ActivePlanState | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.createdAt === right.createdAt &&
    left.turnId === right.turnId &&
    left.explanation === right.explanation &&
    left.steps.length === right.steps.length &&
    left.steps.every(
      (step, index) =>
        step.step === right.steps[index]?.step && step.status === right.steps[index]?.status
    )
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const newId = deps.newId ?? defaultId;
  const now = deps.now ?? (() => new Date().toISOString());
  const delay = deps.delay ?? defaultDelay;
  const maxRetries = deps.hostUnavailableRetries ?? 3;
  const positions = timelinePositionStore();

  let stream: AgentChatStreamHandle | null = null;
  let closed = false;

  const store = createStore<InternalState>()((set, get) => {
    const update = (mutate: (state: InternalState) => InternalState): void => {
      set((state) => {
        const next = mutate(state);
        return next === state ? state : project(next);
      });
    };

    const setSlice = (patch: Partial<AgentChatThreadSlice>): void => {
      update((state) => {
        const reducer = patchSlice(state.reducer, patch);
        return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
      });
    };

    /**
     * §6.2: `commandId` is minted by the client and is the idempotency key. A
     * 503 `HOST_UNAVAILABLE` is retried with the **same** id, which the receipt
     * makes free; anything else is surfaced.
     */
    const command = async <TName extends AgentChatCommandName>(
      name: TName,
      body: Omit<AgentChatCommandBodies[TName], "commandId">,
      commandId = newId()
    ): Promise<void> => {
      const payload = { ...body, commandId } as AgentChatCommandBodies[TName];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await deps.transport.command(sessionId, name, payload);
          return;
        } catch (error) {
          if (
            error instanceof AgentChatCommandError &&
            error.retryable &&
            attempt < maxRetries &&
            !closed
          ) {
            await delay(Math.min(4_000, 250 * 2 ** attempt));
            continue;
          }
          setSlice({ errorBanner: errorMessage(error) });
          throw error;
        }
      }
    };

    const withResponding = async <T>(requestId: string, run: () => Promise<T>): Promise<T> => {
      update((state) => {
        const ids = state.slice.respondingRequestIds;
        if (ids.includes(requestId)) {
          return state;
        }
        const reducer = patchSlice(state.reducer, { respondingRequestIds: [...ids, requestId] });
        return { ...state, reducer, slice: reducer.slice };
      });
      try {
        return await run();
      } finally {
        // A failed command removes the pending marker in a `finally` (§6.6).
        update((state) => {
          const ids = state.slice.respondingRequestIds.filter((id) => id !== requestId);
          const reducer = patchSlice(state.reducer, { respondingRequestIds: ids });
          return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
        });
      }
    };

    const phase = (): QueuePhase => {
      const state = get().slice;
      if (state.connection === "connecting" || state.sessionStatus === "starting") {
        return "connecting";
      }
      if (state.sessionStatus === "running" || state.turnStatus === "running") {
        return "running";
      }
      if (state.sessionStatus === "stopped" || state.sessionStatus === "error") {
        return "disconnected";
      }
      return "ready";
    };

    const setDraft = (draft: ComposerDraft): void => {
      update((state) => (state.draft === draft ? state : { ...state, draft }));
      const all = readPersistedDrafts();
      all[sessionId] = draft;
      writePersistedDrafts(all);
    };

    /**
     * Return a message's content to the composer.
     *
     * **There is one visible draft, and the composer owns it.** When a
     * composer is mounted for this session (W13's `composer-bridge` handle) the
     * text goes straight into it at the caret; the store's own draft is the
     * fallback for the window where the tab is not mounted yet — a queued
     * message returned by an interrupt while the user is on another tab must
     * not be lost. Keeping two live drafts would let them disagree.
     */
    const appendToDraft = (message: QueuedComposerMessage): void => {
      if (composerHandle(sessionId)) {
        insertComposerText(sessionId, message.text, "append");
        if (message.attachments.length > 0 || message.context.length > 0) {
          const draft = get().draft;
          setDraft({
            text: draft.text,
            attachments: [...draft.attachments, ...message.attachments],
            context: [...draft.context, ...message.context]
          });
        }
        return;
      }
      const draft = get().draft;
      const text = draft.text.trim().length === 0 ? message.text : `${draft.text.trimEnd()}\n\n${message.text}`;
      setDraft({
        text,
        attachments: [...draft.attachments, ...message.attachments],
        context: [...draft.context, ...message.context]
      });
    };

    const actions: AgentChatActions = {
      async sendTurn(input) {
        await command("turn", {
          input: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.context ? { context: input.context } : {}),
          interactionMode: input.interactionMode ?? get().slice.interactionMode,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {})
        });
      },

      async steer(input) {
        await actions.sendTurn(input);
      },

      async interrupt(input) {
        // Interrupting returns EVERY queued message to the composer rather
        // than discarding it (§7.4), and it happens BEFORE the command so the
        // drain generation is already bumped when the post lands.
        actions.drainQueueToComposer();
        update((state) => ({ ...state, stopping: true }));
        const slice = get().slice;
        // The client omits `turnId` whenever the session is not `running`, so
        // a stale interrupt cannot kill the next turn and a background-only
        // stop is still valid (§6.2, §7.6).
        const turnId =
          input?.turnId ??
          (slice.sessionStatus === "running" ? (slice.head?.session.activeTurnId ?? undefined) : undefined);
        try {
          await command("interrupt", turnId === undefined ? {} : { turnId });
        } catch (error) {
          // A failed command clears the pending flag at once and surfaces the
          // error; a successful one holds it until liveness clears (§7.6).
          update((state) => ({ ...state, stopping: false }));
          throw error;
        }
      },

      async respondApproval(input) {
        await withResponding(input.requestId, () =>
          command("approval", {
            requestId: input.requestId,
            decision: input.decision as ApprovalDecision
          })
        );
      },

      async answerQuestion(input) {
        await withResponding(input.requestId, () =>
          command("answer", {
            requestId: input.requestId,
            answers: input.answers,
            ...(input.attachmentsByQuestionId
              ? { attachmentsByQuestionId: input.attachmentsByQuestionId }
              : {})
          })
        );
      },

      async dismissQuestion(input) {
        await withResponding(input.requestId, () =>
          command("dismiss", { requestId: input.requestId })
        );
      },

      async revert(input) {
        await command("revert", { targetTurnCount: input.targetTurnCount });
      },

      async compact() {
        await command("compact", {});
      },

      async setMode(input) {
        await command("mode", {
          ...(input.runtimeMode ? { runtimeMode: input.runtimeMode as RuntimeMode } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection as ModelSelection } : {})
        });
      },

      async stopSession() {
        await command("session/stop", {});
      },

      async uploadAttachment(file, meta) {
        return deps.transport.upload(sessionId, file, meta);
      },

      queueMessage(message) {
        update((state) => {
          // The anchor is stamped HERE, not by the composer: the boundary a
          // queued message waits for is the newest completed tool call at the
          // moment it was queued, and only the store observes activities. A
          // caller that passes `null` (the composer does — it has no activity
          // feed) would otherwise flush at the very next boundary check
          // instead of the next *new* tool call (§7.4).
          const anchored =
            message.queuedAfterToolActivityId === null
              ? {
                  ...message,
                  queuedAfterToolActivityId: latestCompletedToolActivityId(
                    state.timeline.activities
                  )
                }
              : message;
          const { state: queue } = enqueue(state.queue, anchored, now, newId);
          const reducer = patchSlice(state.reducer, { queue: [...queue.messages] });
          return { ...state, queue, reducer, slice: reducer.slice };
        });
      },

      async sendQueuedNow(id) {
        const before = get().queue.drainGeneration;
        // Taking the message is computed from the current state and then
        // applied, rather than mutated inside the updater, so exactly one
        // caller can win the race for a given id.
        const current = get();
        const boundary = latestCompletedToolActivityId(current.timeline.activities);
        const taken = takeQueued(current.queue, id, boundary);
        const message = taken.message;
        if (!message) {
          return;
        }
        update((state) =>
          state.queue === current.queue
            ? (() => {
                const reducer = patchSlice(state.reducer, { queue: [...taken.state.messages] });
                return { ...state, queue: taken.state, reducer, slice: reducer.slice };
              })()
            : state
        );
        // Guard 1: a send that grabbed a message before an interrupt and
        // finished after it must detect the drain and give up, or Stop is
        // followed by a queued message starting a new turn (§7.4).
        if (get().queue.drainGeneration !== before) {
          appendToDraft(message);
          return;
        }
        try {
          await actions.sendTurn({
            text: message.text,
            attachments: message.attachments,
            context: message.context,
            interactionMode: message.interactionMode
          });
        } catch (error) {
          // Guard 2: a failed send is re-inserted at the FRONT with
          // `holdUntilUserAction`, so nothing overtakes it (§7.4).
          update((state) => {
            const queue = holdAtFront(state.queue, message);
            const reducer = patchSlice(state.reducer, { queue: [...queue.messages] });
            return { ...state, queue, reducer, slice: reducer.slice };
          });
          throw error;
        }
      },

      returnQueuedToComposer(id) {
        const result = removeQueued(get().queue, id);
        if (!result.message) {
          return;
        }
        update((state) => {
          const reducer = patchSlice(state.reducer, { queue: [...result.state.messages] });
          return { ...state, queue: result.state, reducer, slice: reducer.slice };
        });
        appendToDraft(result.message);
      },

      drainQueueToComposer() {
        const result = drainQueue(get().queue);
        if (result.messages.length === 0) {
          return;
        }
        update((state) => {
          const reducer = patchSlice(state.reducer, { queue: [] });
          return { ...state, queue: result.state, reducer, slice: reducer.slice };
        });
        for (const message of result.messages) {
          appendToDraft(message);
        }
      },

      setInteractionMode(mode: InteractionMode) {
        setSlice({ interactionMode: mode });
        const remembered = positions.read(sessionId);
        if (remembered) {
          positions.remember(sessionId, { ...remembered, interactionMode: mode });
        }
      },

      setFollow(follow) {
        setSlice({ follow });
      },

      setDisclosure(patch: Partial<DisclosureState>) {
        update((state) => {
          const disclosures = { ...state.slice.disclosures, ...patch };
          const reducer = patchSlice(state.reducer, { disclosures });
          return reducer === state.reducer ? state : { ...state, reducer, slice: reducer.slice };
        });
      },

      dismissErrorBanner() {
        setSlice({ errorBanner: null });
      },

      async refresh() {
        const response = await deps.transport.read(sessionId);
        if (response.kind === "snapshot") {
          applyStreamFrame({ kind: "snapshot", thread: response.thread });
          return;
        }
        for (const event of response.events) {
          applyStreamFrame({ kind: "event", seq: event.seq, event });
        }
      }
    };

    const applyStreamFrame: (frame: Parameters<typeof applyFrame>[1]) => void = (frame) => {
      update((state) => {
        // §6.3/§8: a different host instance id means re-read, not resume.
        if (needsResync(state.reducer.hostInstanceId, frame)) {
          queueMicrotask(() => {
            void actions.refresh().catch(() => {
              /* the stream's own reconnect will try again */
            });
          });
        }
        const reducer = applyFrame(state.reducer, frame);
        if (reducer === state.reducer) {
          return state;
        }
        // A `snapshot` replaces loaded history, so the queue's anchors are no
        // longer meaningful but the queue itself is the user's live intent and
        // survives; drafts, disclosures and scroll are client-local throughout.
        return { ...state, reducer, slice: reducer.slice };
      });
      // The Stop button reads "Stopping…" until `backgroundLiveness` clears,
      // not until the command returns: an accepted interrupt is not yet a dead
      // process (§7.6).
      const state = get();
      if (
        state.stopping &&
        state.slice.backgroundLiveness === null &&
        latestTurnSettled(state.slice)
      ) {
        set({ stopping: false });
      }
    };

    // The store is created with its stream already wired, so `open()` is not a
    // separate step a caller can forget.
    queueMicrotask(() => {
      if (closed) {
        return;
      }
      stream = deps.transport.stream(
        sessionId,
        {},
        {
          onFrame: applyStreamFrame,
          onOpen: () => {
            if (get().slice.connection === "idle") {
              setSlice({ connection: "connecting" });
            }
          },
          onReconnect: () => setSlice({ connection: "reconnecting" }),
          onError: () => setSlice({ connection: "error" })
        }
      );
    });

    const reducer = createReducerState(sessionId);
    const remembered = positions.read(sessionId);
    const initialReducer = remembered
      ? patchSlice(reducer, {
          scroll: remembered,
          disclosures: remembered.disclosures,
          interactionMode: remembered.interactionMode,
          follow: remembered.atEnd
        })
      : reducer;

    return {
      reducer: initialReducer,
      slice: initialReducer.slice,
      queue: EMPTY_QUEUE,
      timeline: EMPTY_TIMELINE_PROJECTION,
      rowsProjection: null,
      stableRows: EMPTY_STABLE_ROWS,
      rows: [],
      activePlan: null,
      draft: readPersistedDrafts()[sessionId] ?? EMPTY_DRAFT,
      stopping: false,
      actions
    };
  });

  // Expose the teardown on the store object so the registry can call it.
  (store as ThreadStore & { destroy?: () => void }).destroy = () => {
    closed = true;
    stream?.close();
    stream = null;
  };

  return store;
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentChatCommandError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "The command failed.";
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface RegistryEntry {
  store: ThreadStore;
  /** Effect-held references only. A render-created entry starts at 0. */
  refCount: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, RegistryEntry>();

/**
 * How long an unreferenced slice lingers before its stream is closed.
 *
 * Two reasons it is not zero. §7.1: one `AgentChatView` serves every chat tab
 * in a project, and the outgoing thread's rows keep painting until the next
 * thread's snapshot lands — tearing its stream down on the same tick would
 * make a tab switch flash. And React's StrictMode mounts, unmounts and
 * re-mounts an effect in development; a zero grace would close and re-open
 * every stream on every mount.
 */
export const THREAD_STORE_DISPOSE_GRACE_MS = 2_000;

function scheduleDispose(sessionId: string, entry: RegistryEntry): void {
  if (entry.disposeTimer !== null) {
    return;
  }
  entry.disposeTimer = setTimeout(() => {
    const current = registry.get(sessionId);
    if (!current || current !== entry || current.refCount > 0) {
      return;
    }
    registry.delete(sessionId);
    (current.store as ThreadStore & { destroy?: () => void }).destroy?.();
  }, THREAD_STORE_DISPOSE_GRACE_MS);
  entry.disposeTimer.unref?.();
}

function cancelDispose(entry: RegistryEntry): void {
  if (entry.disposeTimer !== null) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
}

/**
 * Get (or create) a thread's slice **without** taking a reference. Safe to
 * call during render: a slice nobody retains is disposed after the grace
 * period rather than leaking a stream.
 */
export function ensureThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const existing = registry.get(sessionId);
  if (existing) {
    if (existing.refCount === 0) {
      cancelDispose(existing);
      scheduleDispose(sessionId, existing);
    }
    return existing.store;
  }
  const entry: RegistryEntry = {
    store: createThreadStore(sessionId, deps),
    refCount: 0,
    disposeTimer: null
  };
  registry.set(sessionId, entry);
  scheduleDispose(sessionId, entry);
  return entry.store;
}

/** Take a reference (a mounted effect). Cancels any pending disposal. */
export function retainThreadStore(sessionId: string, deps: ThreadStoreDeps): ThreadStore {
  const store = ensureThreadStore(sessionId, deps);
  const entry = registry.get(sessionId)!;
  entry.refCount += 1;
  cancelDispose(entry);
  return store;
}

/** Drop a reference; the slice and its stream go once the grace elapses (§7.2). */
export function releaseThreadStore(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) {
    return;
  }
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount === 0) {
    scheduleDispose(sessionId, entry);
  }
}

/** The live slice for a session, if any. For surfaces that must not open one. */
export function peekThreadStore(sessionId: string): ThreadStore | null {
  return registry.get(sessionId)?.store ?? null;
}

/** Test seam: drop every slice immediately. */
export function resetThreadStores(): void {
  for (const [sessionId, entry] of [...registry.entries()]) {
    cancelDispose(entry);
    registry.delete(sessionId);
    (entry.store as ThreadStore & { destroy?: () => void }).destroy?.();
  }
}

export type { AttachmentRef, ComposerContextRecord, InteractionMode };
export { DEFAULT_INTERACTION_MODE };
