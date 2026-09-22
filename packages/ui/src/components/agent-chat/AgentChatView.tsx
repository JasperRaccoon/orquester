import React from "react";

import {
  DEFAULT_RUNTIME_MODE,
  SETTLED_TURN_STATES,
  TERMINAL_SUBAGENT_STATUSES
} from "@orquester/api/agent-chat";
import type { ThreadItem } from "@orquester/api/agent-chat";

import { shortAccountLabel } from "../../lib/account-label";
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
  stageComposerAttachment
} from "./composer/composer-bridge";
import { cn } from "../../lib/cn";
import { isDefaultThreadTitle } from "../../lib/session-kind";
import { isActiveChatTab, releaseActiveChatTab } from "../../lib/agent-chat-active-tab";
import { anotherLayerOwnsTheKeyboard } from "../attention/GlobalShortcutListener";
import { deriveThreadTitleSeed } from "../../lib/agent-chat/title.logic";
import { resolveChatEscape } from "./escape-action";
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
  const { slice, actions, rows, activePlan, actionableProposedPlan, reverting } =
    useAgentChatThread(sessionId);
  const pending = useAgentChatPending(sessionId);
  const roster = useAgentChatRoster(sessionId);
  const status = useAgentChatStatus(sessionId);
  const provider = useProviderSnapshot(session.refId);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const setPreferredModelSelection = useAppStore((s) => s.setPreferredModelSelection);
  const setPreferredRuntimeMode = useAppStore((s) => s.setPreferredRuntimeMode);
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
      }
    }),
    [actions, session.refId, setPreferredModelSelection, setPreferredRuntimeMode]
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
  const escapeState = React.useRef({ drillInAgentId, turnActive });
  escapeState.current = { drillInAgentId, turnActive };
  React.useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      const state = escapeState.current;
      const action = resolveChatEscape({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isActiveTab: isActiveChatTab(sessionId),
        blockingLayerOpen: anotherLayerOwnsTheKeyboard(),
        insideComposer:
          typeof target?.closest === "function" &&
          target.closest(`[data-agent-chat-composer-shell="${CSS.escape(sessionId)}"]`) !== null,
        drillInOpen: state.drillInAgentId !== null,
        turnActive: state.turnActive
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
      void actions.interrupt().catch(() => {
        // The thread's own error banner already carries the reason.
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, sessionId, actions]);

  const accountLabel = session.accountId
    ? (shortAccountLabel(
        agentAccounts?.accounts.find((a) => a.id === session.accountId)?.label
      ) ?? null)
    : null;
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
              canRevert={
                !paintOnly && provider?.capabilities?.supportsConversationRollback !== false
              }
              onRevert={
                paintOnly
                  ? noop
                  : (targetTurnCount) => dispatch(() => actions.revert({ targetTurnCount }))
              }
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
              // A straight pass-through: the store's action already puts the
              // message's text back in the draft and its attachments back as
              // chips (`appendToDraft`), so wrapping it would insert twice.
              onReturnQueuedToComposer={paintOnly ? noop : actions.returnQueuedToComposer}
              errorBanner={paintOnly ? null : slice.errorBanner}
              onDismissErrorBanner={paintOnly ? noop : actions.dismissErrorBanner}
              roster={roster.agents}
              projectPath={projectPath}
              scroll={paintOnly ? null : scrollPosition}
              onScrollPositionChange={paintOnly ? noop : rememberScrollPosition}
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
                activePlan={paintOnly ? null : activePlan}
                onCompact={paintOnly ? noop : () => dispatch(() => actions.compact())}
                latestCheckpoint={latestCheckpoint}
                modelLabel={slice.head?.modelSelection.model ?? session.model ?? null}
              />
            </div>
            {/* The dock overlaps the composer by 17px so the two read as ONE
                shape — a drawer pulled out of the composer, not a card resting
                on it. The pull lives on the dock's own root (it renders null
                when empty): on this always-present wrapper it dragged the
                composer 17px up over the status line on every idle thread.
                (D's reference §1.5, T3 `ComposerBanner.tsx:55`.) */}
            <div className="pointer-events-auto mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
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
            <div className="pointer-events-auto mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
              <ChatComposer
                sessionId={sessionId}
                provider={provider}
                modelSelection={slice.head?.modelSelection ?? null}
                runtimeMode={slice.head?.runtimeMode ?? DEFAULT_RUNTIME_MODE}
                interactionMode={slice.interactionMode}
                showPlanModeToggle={provider?.capabilities?.showPlanModeToggle === true}
                accountLabel={accountLabel}
                isTurnActive={!paintOnly && turnActive}
                hasPendingRequest={!paintOnly && pending.totalCount > 0}
                queue={slice.queue}
                activePlan={paintOnly ? null : activePlan}
                actionableProposedPlan={planFollowUp}
                onDraftAttachmentCountChange={setComposerAttachments}
                reverting={reverting}
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
