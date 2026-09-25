import React from "react";
import { flushSync } from "react-dom";

import {
  DEFAULT_RUNTIME_MODE,
  SETTLED_TURN_STATES,
  startedTurns,
  TERMINAL_SUBAGENT_STATUSES
} from "@orquester/api/agent-chat";
import type { GoalAction, ThreadItem } from "@orquester/api/agent-chat";

import { shortAccountLabel } from "../../lib/account-label";
import {
  buildChatAccountOptions,
  canSwitchChatAccount,
  chatAccountLabel,
  chatAccountSelectionId,
  chatAccountSwitchRefusal,
  chatAccountSwitchSupported,
  isGoalContinuing
} from "../../lib/agent-chat/account-switch";
import { isGoalHeldForUpdate } from "../../lib/agent-chat/goal.logic";
import { ApiError } from "../../lib/api-client";
import { useApi } from "../../context/orquester-context";
import { Modal, ModalCloseButton } from "../ui";
import { DiffView } from "../git/DiffView";
import {
  useAgentChatPending,
  useAgentChatRoster,
  useAgentChatStatus,
  useAgentChatThread,
  useProviderSnapshot
} from "../../lib/agent-chat/hooks";
import {
  clearComposerInbox,
  composerTextForDelivery,
  subscribeComposerInbox,
  takeComposerDeliveries,
  type ComposerDelivery
} from "../../lib/composer-inbox";
import {
  focusComposer,
  insertComposerText,
  openComposerControl,
  sendComposerText,
  stageComposerAttachment
} from "./composer/composer-bridge";
import { rewindPickerEnabled } from "./composer/RewindControl";
import {
  createEscapeSequence,
  deriveRewindTargets,
  type EscapeSequence,
  type RewindTarget
} from "../../lib/agent-chat/rewind.logic";
import { cn } from "../../lib/cn";
import { canLoadOlderHistory } from "../../lib/agent-chat/history.logic";
import { isDefaultThreadTitle } from "../../lib/session-kind";
import { isActiveChatTab, releaseActiveChatTab } from "../../lib/agent-chat-active-tab";
import { anotherLayerOwnsTheKeyboard } from "../attention/GlobalShortcutListener";
import { deriveThreadTitleSeed } from "../../lib/agent-chat/title.logic";
import { chatEscapeSequenceStep, resolveChatEscape } from "./escape-action";
import { proposedPlanTitle, shouldShowPlanFollowUpPrompt } from "../../lib/agent-chat/plan.logic";
import { useAppStore } from "../../store/app";
import { AgentDrillIn } from "./roster/AgentDrillIn";
import { AgentRoster } from "./roster/AgentRoster";
import { EmptyThreadPanel } from "./EmptyThreadPanel";

/** Per-device: the roster folded to its summary line. */
const ROSTER_COLLAPSED_KEY = "orquester.chat.roster-collapsed";
import { ChatBannerDock } from "./banners/ChatBannerDock";
import { ChatComposer } from "./composer/ChatComposer";
import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { ChatStatusLine } from "./status/ChatStatusLine";
import { GOAL_ACTION_TEXT, goalActions, goalActionsNote } from "./status/goal-chip";
import { ChatTimeline } from "./timeline/ChatTimeline";
import {
  nextHeldTimeline,
  resolveThreadSwitchTimeline,
  type HeldTimeline
} from "./thread-switch";
import type { AgentChatTimelineRow } from "../../lib/agent-chat/contracts";
import type { AgentChatViewProps, AgentRosterMainRow } from "./contracts";

/** Stable empty arrays, so a neutralised render never churns child props. */
const NO_APPROVALS: never[] = [];
const NO_REQUEST_IDS: readonly string[] = [];
const NO_REWIND_TARGETS: readonly RewindTarget[] = [];

/** Every row callback is a no-op while the paint hold is in effect (§7.1). */
const noop = (): void => {};

/**
 * Fire a §6.2 command from a `void`-returning UI callback.
 *
 * The store's `command()` sets `slice.errorBanner` and then **rethrows**, so
 * the user-visible half is already handled — but a bare `void` on a rejecting
 * promise is an `unhandledrejection`, which is noise in the console and a hard
 * failure in the web smoke test (it fails on any uncaught page error). The
 * banner carries the reason; this only stops the rejection escaping.
 */
function dispatch(run: () => Promise<unknown>): void {
  void run().catch(() => {
    /* surfaced by the thread's own error banner */
  });
}

/** The read-only overlay for a turn diff or one item's full, unslimmed payload. */
interface ChatViewerState {
  kind: "diff" | "output";
  title: string;
  loading: boolean;
  diff?: string;
  text?: string;
  error?: string;
}

/** The daemon's own message where it sent one, else a plain fallback. */
function errorText(error: unknown, fallback: string): string {
  return (error instanceof ApiError ? error.serverMessage : null) ?? fallback;
}

/**
 * An unslimmed item as text. The §5.6 allow-list is what the *row* renders; the
 * full payload is by definition whatever the adapter wrote, so it is shown as
 * pretty JSON rather than re-interpreted — a plain string payload stays plain.
 */
function fullOutputText(item: ThreadItem): string {
  if (item.kind === "message") {
    return item.text;
  }
  if (typeof item.payload === "string") {
    return item.payload;
  }
  try {
    return JSON.stringify(item.payload, null, 2);
  } catch {
    return item.summary;
  }
}

/**
 * The chat shell (spec §7.1).
 *
 * ```
 * ┌─ root (relative, flex col) ───────────────────────────────┐
 * │ ┌─ main area (relative, flex-1) ─────────────────────────┐│
 * │ │  timeline  ·  or the subagent drill-in                 ││
 * │ │ ┌ overlay (absolute, inset-x-0 bottom-0, z-20) ───────┐││
 * │ │ │  status line                                        │││
 * │ │ │  banner dock                                        │││
 * │ │ │  composer                                           │││
 * │ │ │  agent roster                                       │││
 * │ │ └─────────────────────────────────────────────────────┘││
 * │ └────────────────────────────────────────────────────────┘│
 * └───────────────────────────────────────────────────────────┘
 * ```
 *
 * **The composer is an overlay, not a flex child.** It lets the composer grow
 * without moving the messages behind it; the timeline instead reserves space
 * with a bottom inset equal to the overlay's measured height.
 * *T3: `apps/web/src/components/ChatView.tsx:9941-9988` — `contentInsetEndAdjustment`.*
 *
 * **The drill-in swaps only the main area.** The composer and roster stay
 * mounted, so the parent can be steered while watching a child (§7.6).
 *
 * **Placement note (deliberate difference from §7.1's wording).** The spec says
 * one `AgentChatView` instance serves every chat tab in a project. Orquester's
 * `MainView` keeps *every* tab mounted — that is what makes grid view work and
 * what stops a terminal from being torn down — so here each chat tab owns its
 * instance and switching tabs is show/hide, which is strictly better than a
 * shared instance for the property the rule exists to protect: a switch cannot
 * flash an empty timeline because the outgoing tab was never unmounted. The
 * paint hold is implemented anyway and does engage — on a reconnect
 * re-snapshot, and if this instance is ever handed a different `session.id`.
 */
export function AgentChatView({ session, projectPath, active }: AgentChatViewProps): JSX.Element {
  const sessionId = session.id;
  const { slice, actions, rows, activePlan, actionableProposedPlan, reverting, reveal } =
    useAgentChatThread(sessionId);
  const pending = useAgentChatPending(sessionId);
  const roster = useAgentChatRoster(sessionId);
  const status = useAgentChatStatus(sessionId);
  const provider = useProviderSnapshot(session.refId);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  // §3.4's account chip: a proxy launcher may only pin accounts SEEDED into
  // the model proxy, the same rule the "+" menu's launch chips apply.
  const cliproxy = useAppStore((s) => s.cliproxy);
  const setPreferredModelSelection = useAppStore((s) => s.setPreferredModelSelection);
  const setPreferredRuntimeMode = useAppStore((s) => s.setPreferredRuntimeMode);
  const setPreferredAccount = useAppStore((s) => s.setPreferredAccount);
  // What the composer's pickers change becomes this device's preference for
  // the agent, so the next chat opens the same way (model, effort, thinking,
  // fast mode, permission mode). The thread itself still gets the command.
  const composerActions = React.useMemo(
    () => ({
      ...actions,
      setMode: async (input: Parameters<typeof actions.setMode>[0]) => {
        await actions.setMode(input);
        if (input.modelSelection) setPreferredModelSelection(session.refId, input.modelSelection);
        if (input.runtimeMode) setPreferredRuntimeMode(session.refId, input.runtimeMode);
      },
      // §3.4: the account the user moved this thread to becomes this device's
      // preference for the agent, exactly as the model and mode picks do — but
      // only once the switch was accepted.
      setAccount: async (input: Parameters<typeof actions.setAccount>[0]) => {
        await actions.setAccount(input);
        setPreferredAccount(session.refId, input.accountId);
      }
    }),
    [
      actions,
      session.refId,
      setPreferredAccount,
      setPreferredModelSelection,
      setPreferredRuntimeMode
    ]
  );
  const api = useApi();

  // --- the §7.1 paint hold -------------------------------------------------
  const heldRef = React.useRef<HeldTimeline<AgentChatTimelineRow> | null>(null);
  const loading = slice.connection !== "synchronized";
  const displayed = resolveThreadSwitchTimeline({
    sessionId,
    rows,
    loading,
    held: heldRef.current
  });
  heldRef.current = nextHeldTimeline(heldRef.current, displayed);
  const paintOnly = displayed.paintOnly;

  // --- the composer overlay's published height -----------------------------
  const [overlay, setOverlay] = React.useState<HTMLDivElement | null>(null);
  const [overlayHeight, setOverlayHeight] = React.useState(0);
  const [composerHeight, setComposerHeight] = React.useState(0);
  React.useEffect(() => {
    if (!overlay) {
      return;
    }
    const publish = () => setOverlayHeight(Math.ceil(overlay.getBoundingClientRect().height));
    publish();
    // A composer grows with its draft and the dock grows with a banner, so the
    // inset is measured rather than derived: one observer covers all of it.
    const observer = new ResizeObserver(publish);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [overlay]);
  // The composer publishes its own height too (§7.4's contract). It is the
  // floor rather than the value: a mid-layout measurement can read the overlay
  // before the banner above the composer has laid out.
  const bottomInset = Math.max(overlayHeight, composerHeight);

  // --- the subagent drill-in (§7.6) ----------------------------------------
  const [drillInAgentId, setDrillInAgentId] = React.useState<string | null>(null);
  // A drill-in belongs to one thread; carrying it across a switch would open a
  // stranger's agent. The hold is exactly the window where that could happen.
  React.useEffect(() => setDrillInAgentId(null), [sessionId]);
  // Auto-return: an agent that SETTLES (finishes, fails, is stopped) while its
  // drill-in is open hands the view back to the thread — the parent is where
  // the result lands. Only a live→settled transition observed here does it,
  // so deliberately opening an already-finished agent stays open.
  const drilledStatus = drillInAgentId
    ? (roster.agents.find((agent) => agent.id === drillInAgentId)?.status ?? null)
    : null;
  const drilledWasLive = React.useRef(false);
  React.useEffect(() => {
    if (drillInAgentId === null || drilledStatus === null) {
      drilledWasLive.current = false;
      return;
    }
    const settled = TERMINAL_SUBAGENT_STATUSES.has(drilledStatus);
    if (!settled) {
      drilledWasLive.current = true;
      return;
    }
    if (drilledWasLive.current) {
      drilledWasLive.current = false;
      setDrillInAgentId(null);
    }
  }, [drillInAgentId, drilledStatus]);
  // The child's rows and its roster row come from `useAgentChatDrillIn`, which
  // AgentDrillIn calls itself: one projection off this thread's slice, sharing
  // the parent's memoisation instead of a second one beside it.

  // --- roster collapse state (§7.6) ----------------------------------------
  const [rosterExpanded, setRosterExpanded] = React.useState(false);
  // Folded roster: one summary line instead of the rows. Per device — it is
  // how this person likes the space split, not thread state.
  const [rosterCollapsed, setRosterCollapsed] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(ROSTER_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const updateRosterCollapsed = React.useCallback((collapsed: boolean) => {
    setRosterCollapsed(collapsed);
    try {
      localStorage.setItem(ROSTER_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, []);
  React.useEffect(() => setRosterExpanded(false), [sessionId]);

  // --- the remembered reading position (§7.2) ------------------------------
  // Straight through to the store's 100-entry LRU: the timeline publishes the
  // four scroll fields, the store keeps the disclosures beside them, and
  // `slice.scroll` is what a remount reads back.
  const rememberScrollPosition = actions.rememberScroll;
  const scrollPosition = slice.scroll;

  // --- deliveries into the composer draft (§7.4) ---------------------------
  // A browser element pick and a session upload both end in this thread's
  // draft, never in a pane. They are queued by session id because the
  // delivering surface (a sheet over the browser tab, a drop handler on the
  // shell) cannot hold a handle to a composer it does not render; the shell
  // drains the queue and hands each one to W13's composer bridge.
  React.useEffect(() => {
    const apply = (delivery: ComposerDelivery) => {
      // Attachments become real chips: they are already uploaded, so the
      // composer stages them exactly like a picked file. Only the ones it
      // refuses (the eight-attachment budget, the turn's size bounds, or no
      // composer mounted yet) fall back to their path in the draft text —
      // a visible path beats a file that silently disappears.
      const unstaged = delivery.attachments.filter(
        (attachment) => !stageComposerAttachment(sessionId, attachment)
      );
      const text = composerTextForDelivery({ ...delivery, attachments: unstaged });
      if (text.length > 0) {
        insertComposerText(sessionId, text, "append");
      }
    };
    for (const delivery of takeComposerDeliveries(sessionId)) {
      apply(delivery);
    }
    return subscribeComposerInbox(sessionId, apply);
  }, [sessionId]);

  // A closed tab keeps nothing (§7.2), and an undelivered element-pick payload
  // for a tab that no longer exists must not linger in the inbox. A tab that
  // was the visible one also gives the keyboard back, so no unmounted thread
  // keeps a claim the shell will never correct.
  React.useEffect(
    () => () => {
      clearComposerInbox(sessionId);
      releaseActiveChatTab(sessionId);
    },
    [sessionId]
  );

  // --- a queued message returned to the composer (§7.4) --------------------
  // Every other insert from outside the composer places the caret and leaves
  // focus where it is. "Cancel and return to the composer" is the user asking
  // to edit that message, so here the composer takes focus, at the end of the
  // returned text. The store's action does the insert (`appendToDraft`: the
  // text into the draft, the attachments back as chips); this adds only the
  // explicit `focusComposer`. `flushSync` first: `focusAtEnd` measures the
  // textarea's value, and the returned text must already be in it.
  const returnQueuedToComposer = React.useCallback(
    (queuedId: string) => {
      flushSync(() => actions.returnQueuedToComposer(queuedId));
      focusComposer(sessionId);
    },
    [actions, sessionId]
  );

  // --- the client-seeded thread title (§7.7) -------------------------------
  // There is no title-generation service and none is introduced: the client
  // seeds the title from the first message and writes it through the ordinary
  // rename `PUT`, which appends `thread.meta-updated`. The host may improve it
  // later, but only while the title is still exactly the seed or the default,
  // so a manual rename is never clobbered — and the same rule applies here:
  // once per thread, and only over a title nobody has chosen.
  const seededRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (seededRef.current === sessionId) {
      return;
    }
    const first = slice.entries.find(
      (item) => item.kind === "message" && item.role === "user" && item.agentId === undefined
    );
    if (!first || first.kind !== "message") {
      return;
    }
    seededRef.current = sessionId;
    if (!isDefaultThreadTitle(session.title, session.refId)) {
      return;
    }
    const seed = deriveThreadTitleSeed({
      text: first.text,
      attachments: first.attachments,
      context: first.context
    });
    if (seed && seed !== session.title) {
      // `seed: true`: this is the shell's own first-message title, not a
      // rename the user typed, so the host leaves it replaceable by a provider
      // retitle (§7.7). Sending it as a plain rename marked every real thread
      // manually-renamed and no provider name could ever land.
      dispatch(() => useAppStore.getState().renameTab(sessionId, seed, { seed: true }));
    }
  }, [sessionId, slice.entries, session.title, session.refId]);

  const turnActive = slice.turnStatus !== null && !SETTLED_TURN_STATES.has(slice.turnStatus);

  // --- "Rewind to here" and the Esc-Esc picker (§5.5) ----------------------
  // Two surfaces, one list: the per-row button reads `revertTurnCount` off
  // the rows the timeline renders, and the composer's picker gets the SAME
  // rows projected into targets, so the two can never disagree about what is
  // rewindable. A rewind is conversation only — files are never touched — and
  // `rewindTo` hands the message back to the composer for editing.
  const canRevert = !paintOnly && provider?.capabilities?.supportsConversationRollback !== false;
  const startedTurnCount = React.useMemo(() => startedTurns(slice.turns).length, [slice.turns]);
  const rewindTargets = React.useMemo(
    () =>
      paintOnly || !canRevert ? NO_REWIND_TARGETS : deriveRewindTargets(displayed.rows, slice.turns),
    [canRevert, displayed.rows, paintOnly, slice.turns]
  );
  // The row button waits while a turn runs (the host refuses a rewind mid-
  // turn) or a revert is already rewriting the history it points at (§7.5).
  const revertBusy = !paintOnly && (turnActive || reverting);
  // The picker's own gate, shared with its button and the composer's Esc Esc,
  // so the shell's double press never "opens" a picker that is disabled.
  const rewindAvailable =
    !paintOnly &&
    rewindPickerEnabled({
      targetCount: rewindTargets.length,
      isTurnActive: turnActive,
      reverting,
      hasPendingRequest: pending.totalCount > 0
    });
  const rewindTo = React.useCallback(
    (input: { messageId: string; targetTurnCount: number }) =>
      dispatch(() =>
        actions.rewindTo({ messageId: input.messageId, targetTurnCount: input.targetTurnCount })
      ),
    [actions]
  );
  const rewindToTarget = React.useCallback(
    (target: RewindTarget) =>
      rewindTo({ messageId: target.messageId, targetTurnCount: target.targetTurnCount }),
    [rewindTo]
  );

  // --- older history and the palette's reveal (design 2026-09-23) ----------
  // The "Load older turns" row pages the indexed log in ABOVE the window; the
  // rows it brings are already in `rows` (the store merges them), so this is
  // only the door and its state. A failure lands on the row in words — the
  // action never rejects — and a search hit's reveal scrolls a row into view.
  const historyHasOlder = !paintOnly && canLoadOlderHistory(slice.history);
  const loadOlderHistory = React.useCallback(
    () => dispatch(() => actions.loadOlderHistory()),
    [actions]
  );

  // --- the plan-ready decision (§7.3, §7.5) --------------------------------
  // The "Plan ready" banner deliberately carries no buttons: the decision is
  // the composer's primary action, which becomes Implement on an empty draft
  // and Refine once the user types. Handing the composer the proposal is what
  // makes that switch happen — without it the banner is a dead end and the
  // thread can never leave plan mode.
  //
  // The thread-side half of §7.4's gate lives here (nothing pending, still in
  // plan mode, the turn has settled); the last term — an empty attachment tray
  // — is the composer's, because the draft is state inside it. It publishes
  // the count back (`onDraftAttachmentCountChange`) so the **docked banner**,
  // which lives up here, obeys the same rule as the primary action: staging a
  // file while a plan is proposed must not leave a "Plan ready" banner over a
  // composer whose only button is Send.
  const [composerAttachments, setComposerAttachments] = React.useState(0);
  const planFollowUp =
    !paintOnly &&
    shouldShowPlanFollowUpPrompt({
      pendingUserInputCount: pending.userInputs.length,
      interactionMode: slice.interactionMode,
      latestTurnSettled: !turnActive,
      hasActionableProposedPlan: actionableProposedPlan !== null,
      hasComposerAttachments: composerAttachments > 0
    })
      ? actionableProposedPlan
      : null;

  // --- Escape, for the whole visible tab (§7.4, §7.6) ----------------------
  // Escape leaves the drill-in and, failing that, interrupts a running turn.
  // Both are advertised by the shared keybinding table, and both used to work
  // only while focus happened to be inside the chat subtree: click a tool row
  // to expand it and `document.activeElement` becomes `<body>`, after which a
  // React handler on our root never fires again. So it is a `window` listener.
  //
  // **Escape is shared with the composer by SCOPE, never by order.** Two
  // capture-phase `window` listeners exist for this key and exactly one may
  // act: two on the same node cannot be ordered — a listener whose effect deps
  // change (the composer's include `queue`) re-registers and moves to the back
  // of the list — so whichever ran first won, which meant two interrupts when
  // both fired and a stopped turn instead of a closed drill-in when the
  // composer went first. This one therefore owns every Escape whose target is
  // OUTSIDE the composer shell, and the composer's `composerOwnsEscape` owns
  // the inside; that is why `insideComposer` is one of the gates below, and
  // why both sides also bail on `defaultPrevented`.
  //
  // Every rule lives in `resolveChatEscape`, which is pure and tested; this
  // keeps only the three lines that touch the event.
  //
  // **The idle Escape is the CLI's double press** (§5.5): with nothing to
  // leave and nothing to stop, two Escapes in a row outside the composer open
  // the composer's rewind picker — the textarea counts its own Escapes the
  // same way, on its own sequence, so one press can never advance both. What
  // counts as a press (only an idle Escape; anything else starts over) is
  // `chatEscapeSequenceStep`, pure and tested beside the rest.
  const escapeState = React.useRef({ drillInAgentId, turnActive, rewindAvailable });
  escapeState.current = { drillInAgentId, turnActive, rewindAvailable };
  const escapeSequenceRef = React.useRef<EscapeSequence | null>(null);
  if (escapeSequenceRef.current === null) escapeSequenceRef.current = createEscapeSequence();
  React.useEffect(() => {
    if (!active) {
      return;
    }
    const sequence = escapeSequenceRef.current;
    // A tab coming back into view starts a fresh count.
    sequence?.reset();
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      const state = escapeState.current;
      const inside = (selector: string): boolean =>
        typeof target?.closest === "function" && target.closest(selector) !== null;
      const gate = {
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isActiveTab: isActiveChatTab(sessionId),
        blockingLayerOpen: anotherLayerOwnsTheKeyboard(),
        insideComposer: inside(`[data-agent-chat-composer-shell="${CSS.escape(sessionId)}"]`),
        drillInOpen: state.drillInAgentId !== null,
        turnActive: state.turnActive
      };
      const step = chatEscapeSequenceStep({
        ...gate,
        repeat: event.repeat,
        insideFloatingLayer: inside("[data-chat-composer-floating-layer]")
      });
      if (step === "reset") {
        sequence?.reset();
      }
      const action = resolveChatEscape({
        ...gate,
        secondPress: step === "press" && sequence?.press(Date.now()) === true,
        rewindAvailable: state.rewindAvailable
      });
      if (action === "ignore") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === "close-drill-in") {
        setDrillInAgentId(null);
        return;
      }
      if (action === "rewind") {
        // The same door the keybinding handler uses: the composer un-collapses,
        // focuses, and clicks the control carrying the `rewind` token.
        openComposerControl(sessionId, "rewind");
        return;
      }
      void actions.interrupt().catch(() => {
        // The thread's own error banner already carries the reason.
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, sessionId, actions]);

  // §3.4's account chip. The HEAD is the authority — the host records the
  // switch there first — with the tab summary as the fallback for a thread
  // whose snapshot has not landed yet.
  const threadAccountId = slice.head?.accountId ?? session.accountId ?? "";
  // OpenCode runs one server per project under its own identity (§3.2), so
  // there is nothing to pick: the chip stays the label it always was.
  const accountOptions = chatAccountSwitchSupported({
    refId: session.refId,
    adapterId: provider?.id
  })
    ? buildChatAccountOptions({
        refId: session.refId,
        accounts: agentAccounts?.accounts,
        seededAccountIds: cliproxy?.accounts?.map((account) => account.id),
        shortLabel: shortAccountLabel
      })
    : undefined;
  // A thread on the system identity showed no chip before the picker existed;
  // it shows one now, because "System" is a choice the user can move off.
  const accountLabel =
    accountOptions !== undefined || session.accountId
      ? chatAccountLabel({
          accountId: threadAccountId,
          accounts: agentAccounts?.accounts,
          shortLabel: shortAccountLabel
        })
      : null;
  // The goal the status-line chip renders (goals §8.2).
  const threadGoal = paintOnly ? null : slice.goal;
  // Goals §5.7: a deploy's drain paused the goal between two of its turns and
  // the next host resumes it — the fold reads `paused`, the tab reads working.
  // The goal chip says so rather than showing the user's pause (its actions
  // stay a paused goal's, Resume and Clear, since the user wins), and the
  // account chip names the hold rather than asking for a pause it has had.
  const goalHeldForUpdate = isGoalHeldForUpdate({
    goal: threadGoal,
    summaryGoal: session.goal,
    goalHeldForHandover: slice.head?.goalHeldForHandover === true
  });
  // Goals §5.5: a goal the provider keeps working on by itself (Codex) holds
  // the switch — its next turn would start under the old account and die on
  // the restart — and the chip says to pause it rather than to wait. Only
  // while it IS continuing: the host's verdict on the tab summary when there
  // is one, else a coarser form of the host's predicate (`isGoalContinuing`).
  // A stopped or errored session may switch, except one whose resume mark is
  // still pending (after a handover it may read `stopped` or `error`), which
  // reads as continuing — and so does a goal a deploy holds (§5.7), whose
  // mark the head carries on a snapshot.
  const accountSwitchState = {
    isTurnActive: turnActive,
    hasPendingRequest: pending.totalCount > 0,
    queuedCount: slice.queue.length,
    reverting,
    connection: slice.connection,
    backgroundLive: session.backgroundLiveness != null,
    goalContinuing: isGoalContinuing({
      summaryGoal: session.goal,
      goal: slice.goal,
      support: provider?.capabilities?.goals,
      sessionStatus: slice.sessionStatus,
      resumeGoalAfterRestart: slice.head?.resumeGoalAfterRestart === true,
      goalHeldForHandover: slice.head?.goalHeldForHandover === true
    }),
    // A held goal is paused already: the chip names the hold, in the host's
    // words, as the goal chip reads it.
    goalHeldForUpdate,
    // The host refuses a switch for a running compaction first (and the chip
    // then names it, as the host would).
    compacting: status.isCompacting
  };
  const accountSwitchEnabled = !paintOnly && canSwitchChatAccount(accountSwitchState);
  const accountSwitchRefusal = paintOnly ? null : chatAccountSwitchRefusal(accountSwitchState);

  // --- the goal chip (goals §8.2) -------------------------------------------
  // The chip shows whatever unfinished goal the fold holds; which actions its
  // popover offers is the §8.2 matrix over the adapter's own goal block (none
  // on OpenCode, or from a host that predates goals). "Background live" reads
  // both copies — the roster this tab derives and the summary the daemon
  // sends — so a nudge is withheld while either says work is still running.
  const goalSupport = provider?.capabilities?.goals ?? null;
  // `threadGoal` and `goalHeldForUpdate` are read above, beside the account
  // chip, which names a held goal too.
  const goalBackgroundLive = roster.backgroundLiveness !== null || session.backgroundLiveness != null;
  const { goalActionList, goalNote } = React.useMemo(() => {
    const input = {
      goal: threadGoal,
      support: goalSupport,
      turnRunning: turnActive,
      backgroundLive: goalBackgroundLive
    };
    return { goalActionList: goalActions(input), goalNote: goalActionsNote(input) };
  }, [threadGoal, goalSupport, turnActive, goalBackgroundLive]);
  // An action is the user's message, sent by the composer itself: its guards,
  // the thread's mode and model, `/turn` (goals §8.2). A refusal is the
  // composer's own notice, in the composer just below the chip.
  const sendGoalAction = React.useCallback(
    (action: GoalAction) => {
      sendComposerText(sessionId, GOAL_ACTION_TEXT[action]);
    },
    [sessionId]
  );

  const latestCheckpoint = slice.checkpoints.length
    ? slice.checkpoints[slice.checkpoints.length - 1]
    : null;
  const latestTurn = slice.turns.length ? slice.turns[slice.turns.length - 1] : null;
  // The roster's own first row is the THREAD — it is not a task, so it is not
  // in `agents` and its state is handed over here. `turnActive` is also the
  // roster's only turn signal: it drives the fade of finished rows (§7.6).
  const rosterMain: AgentRosterMainRow = {
    turnActive: !paintOnly && turnActive,
    awaitingUser: !paintOnly && pending.totalCount > 0,
    failed: !paintOnly && slice.turnStatus === "failed",
    activityLabel: paintOnly ? null : status.activityLabel,
    turnStartedAt: paintOnly ? null : status.turnStartedAt,
    turnEndedAt: latestTurn?.completedAt ?? null,
    tokensUsed: slice.contextWindow?.usedTokens ?? null,
    model: slice.head?.modelSelection.model ?? session.model ?? null
  };
  // --- the read-only viewer for a turn diff / a full tool output -----------
  // Both are §6.3 reads with no store slice behind them: the timeline asks,
  // the shell fetches, and the answer is shown in the existing modal + diff
  // view rather than folded back into the thread. Keeping them out of the
  // slice is deliberate — a 200 KB unslimmed payload is something the user
  // asked to look at once, not thread state every later render pays for.
  const [viewer, setViewer] = React.useState<ChatViewerState | null>(null);
  const openTurnDiff = React.useCallback(
    (turnCount: number) => {
      setViewer({ kind: "diff", title: `Turn ${turnCount}`, loading: true });
      void api
        .agentChatTurnDiff(sessionId, turnCount)
        .then((response) =>
          setViewer({
            kind: "diff",
            title: `Turn ${turnCount}`,
            loading: false,
            diff: response.diff
          })
        )
        .catch((error: unknown) =>
          setViewer({
            kind: "diff",
            title: `Turn ${turnCount}`,
            loading: false,
            error: errorText(error, "That turn's diff could not be read.")
          })
        );
    },
    [api, sessionId]
  );
  const loadFullOutput = React.useCallback(
    (itemId: string) => {
      setViewer({ kind: "output", title: "Full output", loading: true });
      void api
        .agentChatItem(sessionId, itemId)
        .then((response) =>
          setViewer({
            kind: "output",
            title: "Full output",
            loading: false,
            text: fullOutputText(response.item)
          })
        )
        .catch((error: unknown) =>
          setViewer({
            kind: "output",
            title: "Full output",
            loading: false,
            error: errorText(error, "That output is no longer available.")
          })
        );
    },
    [api, sessionId]
  );
  // A viewer belongs to the thread that opened it.
  React.useEffect(() => setViewer(null), [sessionId]);

  /**
   * Click-through from a changed-file row to the file browser.
   *
   * Reuses this project's open Files tab where there is one rather than
   * stacking a new tab per click — clicking six changed files should not leave
   * six identical tabs behind.
   *
   * **Known gap:** the file browser has no "reveal this path" entry point, so
   * this lands in the browser at the project root rather than on the file.
   * Wiring a target path through `FileBrowser` is a follow-up; opening the
   * wrong-looking surface is still better than a dead link.
   */
  const openFile = React.useCallback(
    (path: string) => {
      void path;
      const state = useAppStore.getState();
      const existing = state.fileTabsByProject[projectPath]?.[0];
      if (existing) {
        state.activateTab(existing.id);
        return;
      }
      state.openFileBrowser();
    },
    [projectPath]
  );

  return (
    <div
      data-agent-chat={sessionId}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-950",
        // D's looping indicators are play-state gated on this variable, so a
        // hidden tab's shimmers and pulses stop costing frames without any
        // component knowing it is hidden.
        !active && "[--ac-anim-state:paused]"
      )}
    >
      <ChatErrorBoundary sessionId={sessionId}>
        {/* Main area — the one thing the drill-in swaps. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
          {drillInAgentId ? (
            <AgentDrillIn
              sessionId={sessionId}
              agentId={drillInAgentId}
              roster={roster.agents}
              projectPath={projectPath}
              onBack={() => setDrillInAgentId(null)}
            />
          ) : (
            <ChatTimeline
              sessionId={displayed.displaySessionId}
              rows={displayed.rows as AgentChatTimelineRow[]}
              follow={!paintOnly && slice.follow}
              onFollowChange={paintOnly ? noop : actions.setFollow}
              disclosures={slice.disclosures}
              onDisclosureChange={paintOnly ? noop : actions.setDisclosure}
              bottomInset={bottomInset}
              canRevert={canRevert}
              // "Rewind to here", confirmed in the row's own popover: the whole
              // §5.5 flow, ending with the message back in the composer.
              onRevert={paintOnly ? noop : rewindTo}
              revertBusy={revertBusy}
              startedTurnCount={startedTurnCount}
              onOpenTurnDiff={paintOnly ? noop : openTurnDiff}
              onOpenFile={paintOnly ? noop : openFile}
              onLoadFullOutput={paintOnly ? noop : loadFullOutput}
              onOpenAgent={paintOnly ? noop : setDrillInAgentId}
              threadReady={!paintOnly && status.connection === "synchronized"}
              emptyThreadPanel={
                projectPath ? (
                  <EmptyThreadPanel
                    sessionId={sessionId}
                    projectPath={projectPath}
                    agentRefId={session.refId}
                    bottomInset={bottomInset}
                  />
                ) : undefined
              }
              onSendQueuedNow={paintOnly ? noop : (id) => dispatch(() => actions.sendQueuedNow(id))}
              // The user's Ctrl+B (§4.5): offered on a running command only
              // where the provider can honour it.
              canBackgroundTasks={
                !paintOnly && provider?.capabilities?.supportsBackgroundTasks === true
              }
              onBackgroundTool={
                paintOnly ? noop : (toolUseId) => dispatch(() => actions.backgroundTool({ toolUseId }))
              }
              // The store's action already puts the message's text back in the
              // draft and its attachments back as chips (`appendToDraft`), so the
              // wrapper must not insert anything itself: it only adds the focus.
              onReturnQueuedToComposer={paintOnly ? noop : returnQueuedToComposer}
              errorBanner={paintOnly ? null : slice.errorBanner}
              onDismissErrorBanner={paintOnly ? noop : actions.dismissErrorBanner}
              roster={roster.agents}
              projectPath={projectPath}
              scroll={paintOnly ? null : scrollPosition}
              onScrollPositionChange={paintOnly ? noop : rememberScrollPosition}
              historyHasOlder={historyHasOlder}
              historyLoading={!paintOnly && slice.history.loading}
              historyError={paintOnly ? null : slice.history.error}
              onLoadOlderHistory={paintOnly ? noop : loadOlderHistory}
              revealRequest={paintOnly ? null : reveal}
              onRevealHandled={actions.acknowledgeReveal}
            />
          )}

          {/*
            Docked overlay: status line, then the banner dock, then the
            composer. `pointer-events-none` so the timeline stays clickable
            where the overlay is only reserving space; each band re-enables
            them on its own content column.
          */}
          <div
            ref={setOverlay}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col pt-1.5 sm:pt-2"
          >
            {/* The band the overlay sits on: solid under the status line,
                composer and roster, fading out just above, so a transcript the
                user scrolled up past never reads through the composer. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-8 bottom-0 -z-10 bg-gradient-to-t from-neutral-950 via-neutral-950 via-[calc(100%-2rem)] to-transparent"
            />
            <div className="pointer-events-auto mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
              <ChatStatusLine
                sessionId={sessionId}
                connection={status.connection}
                turnStartedAt={paintOnly ? null : status.turnStartedAt}
                activityLabel={paintOnly ? null : status.activityLabel}
                tokensUsed={slice.contextWindow?.usedTokens ?? null}
                contextMaxTokens={slice.contextWindow?.maxTokens ?? null}
                autoCompactAtTokens={slice.contextWindow?.autoCompactAtTokens ?? null}
                totalProcessedTokens={slice.contextWindow?.totalProcessedTokens ?? null}
                reportsContextWindow={status.reportsContextWindow}
                compactsAutomatically={slice.contextWindow?.compactsAutomatically ?? null}
                activePlan={paintOnly ? null : activePlan}
                onCompact={paintOnly ? noop : () => dispatch(() => actions.compact())}
                latestCheckpoint={latestCheckpoint}
                modelLabel={slice.head?.modelSelection.model ?? session.model ?? null}
                goal={threadGoal}
                goalHeldForUpdate={goalHeldForUpdate}
                goalActions={goalActionList}
                goalActionsNote={goalNote}
                onGoalAction={paintOnly ? noop : sendGoalAction}
              />
            </div>
            {/* The dock overlaps the composer by 17px so the two read as ONE
                shape — a drawer pulled out of the composer, not a card resting
                on it. The pull lives on the dock's own root (it renders null
                when empty): on this always-present wrapper it dragged the
                composer 17px up over the status line on every idle thread.
                (D's reference §1.5, T3 `ComposerBanner.tsx:55`.) */}
            <div className="pointer-events-auto relative z-0 mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
              <ChatBannerDock
                sessionId={sessionId}
                approvals={paintOnly ? NO_APPROVALS : pending.approvals}
                userInputs={paintOnly ? NO_APPROVALS : pending.userInputs}
                respondingRequestIds={paintOnly ? NO_REQUEST_IDS : pending.respondingRequestIds}
                backgroundLiveness={paintOnly ? null : roster.backgroundLiveness}
                liveAgentCount={paintOnly ? 0 : roster.panel.liveCount}
                stopping={!paintOnly && roster.stopping}
                // The dock shows the banner on exactly the decision the
                // composer acts on — not on the summary flag alone, which
                // stays true through a running turn, an open question and a
                // staged attachment.
                actionableProposedPlan={planFollowUp !== null}
                onApprove={paintOnly ? noop : (input) => dispatch(() => actions.respondApproval(input))}
                onAnswer={paintOnly ? noop : (input) => dispatch(() => actions.answerQuestion(input))}
                onDismiss={
                  paintOnly ? noop : (requestId) => dispatch(() => actions.dismissQuestion({ requestId }))
                }
                onStopBackgroundWork={paintOnly ? noop : () => dispatch(() => actions.interrupt())}
                // Text displaced by an answer goes back into the draft rather
                // than being silently discarded (§7.5).
                onCarryTextToDraft={
                  paintOnly ? noop : (text) => insertComposerText(sessionId, text, "append")
                }
                isTurnWorking={!paintOnly && turnActive}
                uploadAttachment={actions.uploadAttachment}
                active={active}
                entries={paintOnly ? undefined : slice.entries}
                planTitle={planFollowUp ? proposedPlanTitle(planFollowUp.planMarkdown) : null}
              />
            </div>
            <div className="pointer-events-auto relative z-10 mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
              <ChatComposer
                sessionId={sessionId}
                provider={provider}
                modelSelection={slice.head?.modelSelection ?? null}
                runtimeMode={slice.head?.runtimeMode ?? DEFAULT_RUNTIME_MODE}
                interactionMode={slice.interactionMode}
                showPlanModeToggle={provider?.capabilities?.showPlanModeToggle === true}
                accountLabel={accountLabel}
                accountOptions={accountOptions}
                accountId={chatAccountSelectionId(threadAccountId)}
                accountSwitchEnabled={accountSwitchEnabled}
                accountSwitchRefusal={accountSwitchRefusal}
                isTurnActive={!paintOnly && turnActive}
                hasPendingRequest={!paintOnly && pending.totalCount > 0}
                queue={slice.queue}
                activePlan={paintOnly ? null : activePlan}
                actionableProposedPlan={planFollowUp}
                onDraftAttachmentCountChange={setComposerAttachments}
                reverting={reverting}
                // The Esc-Esc picker: the same targets the rows offer.
                rewindTargets={rewindTargets}
                onRewind={paintOnly ? noop : rewindToTarget}
                active={active}
                actions={composerActions}
                onHeightChange={setComposerHeight}
                // `/compact` is offered only where there is something to
                // compact (§4.6.7): an empty thread would earn a refusal.
                threadHasContent={slice.entries.length > 0}
              />
            </div>
            {/*
              The roster docks BELOW the composer, inside the same overlay, so
              its height is part of the published bottom inset and the timeline
              reserves room for it instead of scrolling behind it. Absent
              entirely when there is nothing to list, so an ordinary thread
              gives the timeline every pixel.
            */}
            {roster.panel.hasAgents && !paintOnly ? (
              <div className="pointer-events-auto mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
                <AgentRoster
                  sessionId={sessionId}
                  agents={roster.agents}
                  panel={roster.panel}
                  expanded={rosterExpanded}
                  collapsed={rosterCollapsed}
                  onCollapsedChange={updateRosterCollapsed}
                  onExpandedChange={setRosterExpanded}
                  onOpenAgent={setDrillInAgentId}
                  onOpenMain={() => setDrillInAgentId(null)}
                  main={rosterMain}
                  activeAgentId={drillInAgentId}
                />
              </div>
            ) : null}
          </div>
        </div>
      </ChatErrorBoundary>

      {/* Read-only §6.3 reads, on the app's own modal layer (z-100) — above the
          chat overlays by construction, so the ladder needs no new z-index. */}
      <Modal open={viewer !== null} onClose={() => setViewer(null)} className="max-h-[85vh] max-w-4xl">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
            <span className="truncate text-sm text-neutral-200">{viewer?.title}</span>
            <ModalCloseButton onClose={() => setViewer(null)} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {viewer?.error ? (
              <p className="px-4 py-6 text-sm text-danger">{viewer.error}</p>
            ) : viewer?.kind === "diff" ? (
              <DiffView
                diff={viewer.diff ?? ""}
                loading={viewer.loading}
                emptyLabel="This turn changed no files."
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-neutral-300">
                {viewer?.loading ? "Loading…" : (viewer?.text ?? "")}
              </pre>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default AgentChatView;
