import React from "react";

import { DEFAULT_RUNTIME_MODE, SETTLED_TURN_STATES } from "@orquester/api/agent-chat";

import { shortAccountLabel } from "../../lib/account-label";
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
import { focusComposer, insertComposerText } from "./composer/composer-bridge";
import { cn } from "../../lib/cn";
import { isDefaultThreadTitle, seedThreadTitle } from "../../lib/session-kind";
import { useAppStore } from "../../store/app";
import { AgentDrillIn } from "./roster/AgentDrillIn";
import { AgentRoster } from "./roster/AgentRoster";
import { ChatBannerDock } from "./banners/ChatBannerDock";
import { ChatComposer } from "./composer/ChatComposer";
import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { ChatStatusLine } from "./status/ChatStatusLine";
import { ChatTimeline } from "./timeline/ChatTimeline";
import { deriveAgentDrillInRows } from "./agent-rows";
import {
  nextHeldTimeline,
  resolveThreadSwitchTimeline,
  type HeldTimeline
} from "./thread-switch";
import type { AgentChatTimelineRow } from "../../lib/agent-chat/contracts";
import type {
  AgentChatViewProps,
  AgentRosterMainRow,
  TimelineScrollPosition
} from "./contracts";

/** Stable empty arrays, so a neutralised render never churns child props. */
const NO_ROWS: AgentChatTimelineRow[] = [];
const NO_APPROVALS: never[] = [];
const NO_REQUEST_IDS: readonly string[] = [];

/** Every row callback is a no-op while the paint hold is in effect (§7.1). */
const noop = (): void => {};

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
  const { slice, actions, rows, activePlan } = useAgentChatThread(sessionId);
  const pending = useAgentChatPending(sessionId);
  const roster = useAgentChatRoster(sessionId);
  const status = useAgentChatStatus(sessionId);
  const provider = useProviderSnapshot(session.refId);
  const agentAccounts = useAppStore((s) => s.agentAccounts);

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
  const drillInAgent = React.useMemo(
    () => (drillInAgentId ? (roster.agents.find((a) => a.id === drillInAgentId) ?? null) : null),
    [roster.agents, drillInAgentId]
  );
  const drillInRows = React.useMemo(
    () => (drillInAgentId ? deriveAgentDrillInRows(slice.entries, drillInAgentId) : NO_ROWS),
    [slice.entries, drillInAgentId]
  );
  // Escape leaves the child view. Bound on the subtree, not on `window`: the
  // app's one global listener owns window-level keys (AGENTS.md), and Escape
  // here must not reach a tab that merely has a drill-in open in the background.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && drillInAgentId) {
      event.stopPropagation();
      setDrillInAgentId(null);
    }
  };

  // --- roster collapse state (§7.6) ----------------------------------------
  const [rosterExpanded, setRosterExpanded] = React.useState(false);
  React.useEffect(() => setRosterExpanded(false), [sessionId]);

  // --- the remembered reading position (§7.2) ------------------------------
  // The store owns the 100-entry LRU and hands it over as `slice.scroll`, but
  // `AgentChatActions` has no write for it, so the timeline's publishes are
  // held here and only *fall back* to the slice. The effect is the same for a
  // tab hidden and re-shown — which is the case that matters in this shell,
  // since a tab is never unmounted — and a real store write supersedes it the
  // moment one exists.
  const scrollRef = React.useRef(new Map<string, TimelineScrollPosition>());
  const [, bumpScroll] = React.useReducer((n: number) => n + 1, 0);
  const rememberScrollPosition = React.useCallback(
    (position: TimelineScrollPosition) => {
      scrollRef.current.set(sessionId, position);
    },
    [sessionId]
  );
  // Read once per render rather than on every publish: a scroll must not
  // re-render the shell, only feed the next mount.
  const scrollPosition = scrollRef.current.get(sessionId) ?? slice.scroll ?? null;
  React.useEffect(() => {
    // One re-read when the thread changes, so a switch picks the right entry.
    bumpScroll();
  }, [sessionId]);

  // --- deliveries into the composer draft (§7.4) ---------------------------
  // A browser element pick and a session upload both end in this thread's
  // draft, never in a pane. They are queued by session id because the
  // delivering surface (a sheet over the browser tab, a drop handler on the
  // shell) cannot hold a handle to a composer it does not render; the shell
  // drains the queue and hands each one to W13's composer bridge.
  React.useEffect(() => {
    const apply = (delivery: ComposerDelivery) => {
      const text = composerTextForDelivery(delivery);
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
  // for a tab that no longer exists must not linger in the inbox.
  React.useEffect(() => () => clearComposerInbox(sessionId), [sessionId]);

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
    const seed = seedThreadTitle(first.text, first.attachments ?? []);
    if (seed && seed !== session.title) {
      void useAppStore.getState().renameTab(sessionId, seed);
    }
  }, [sessionId, slice.entries, session.title, session.refId]);

  const turnActive = slice.turnStatus !== null && !SETTLED_TURN_STATES.has(slice.turnStatus);
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
  /**
   * "Return this queued message to the composer" is two halves: the store drops
   * it from the queue, and its text goes back into the draft. Dropping it
   * without the second half loses what the user typed.
   */
  const returnQueuedToComposer = React.useCallback(
    (queuedId: string) => {
      const queued = slice.queue.find((message) => message.id === queuedId);
      actions.returnQueuedToComposer(queuedId);
      if (queued) {
        insertComposerText(
          sessionId,
          composerTextForDelivery({ text: queued.text, attachments: queued.attachments }),
          "append"
        );
      }
    },
    [sessionId, slice.queue, actions]
  );

  const openFile = React.useCallback(
    (path: string) => {
      void path;
      // The file browser is a project tab, and a chat tab may be in grid view
      // beside it; opening one is the store's job, not this view's.
      useAppStore.getState().openFileBrowser();
    },
    []
  );

  return (
    <div
      onKeyDown={onKeyDown}
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
              agent={drillInAgent}
              rows={drillInRows}
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
                !paintOnly && provider?.capabilities.supportsConversationRollback !== false
              }
              onRevert={
                paintOnly
                  ? noop
                  : (targetTurnCount) => void actions.revert({ targetTurnCount })
              }
              onOpenTurnDiff={paintOnly ? noop : (turnCount) => void turnCount}
              onOpenFile={paintOnly ? noop : openFile}
              onLoadFullOutput={paintOnly ? noop : (itemId) => void itemId}
              onOpenAgent={paintOnly ? noop : setDrillInAgentId}
              onSendQueuedNow={paintOnly ? noop : (id) => void actions.sendQueuedNow(id)}
              onReturnQueuedToComposer={paintOnly ? noop : returnQueuedToComposer}
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
                onCompact={paintOnly ? noop : () => void actions.compact()}
                latestCheckpoint={latestCheckpoint}
              />
            </div>
            <div className="pointer-events-auto mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
              <ChatBannerDock
                sessionId={sessionId}
                approvals={paintOnly ? NO_APPROVALS : pending.approvals}
                userInputs={paintOnly ? NO_APPROVALS : pending.userInputs}
                respondingRequestIds={paintOnly ? NO_REQUEST_IDS : pending.respondingRequestIds}
                backgroundLiveness={paintOnly ? null : roster.backgroundLiveness}
                liveAgentCount={paintOnly ? 0 : roster.panel.liveCount}
                stopping={!paintOnly && roster.stopping}
                actionableProposedPlan={
                  !paintOnly && session.hasActionableProposedPlan === true
                }
                onApprove={paintOnly ? noop : (input) => void actions.respondApproval(input)}
                onAnswer={paintOnly ? noop : (input) => void actions.answerQuestion(input)}
                onDismiss={
                  paintOnly ? noop : (requestId) => void actions.dismissQuestion({ requestId })
                }
                onStopBackgroundWork={paintOnly ? noop : () => void actions.interrupt()}
                // Text displaced by an answer goes back into the draft rather
                // than being silently discarded (§7.5).
                onCarryTextToDraft={
                  paintOnly ? noop : (text) => insertComposerText(sessionId, text, "append")
                }
                isTurnWorking={!paintOnly && turnActive}
                uploadAttachment={actions.uploadAttachment}
                onRequestCustomAnswerFocus={() => focusComposer(sessionId)}
              />
            </div>
            <div className="pointer-events-auto mx-auto w-full min-w-0 max-w-3xl px-3 sm:px-5">
              <ChatComposer
                sessionId={sessionId}
                provider={provider}
                modelSelection={slice.head?.modelSelection ?? null}
                runtimeMode={slice.head?.runtimeMode ?? DEFAULT_RUNTIME_MODE}
                interactionMode={slice.interactionMode}
                showPlanModeToggle={provider?.capabilities.showPlanModeToggle === true}
                accountLabel={accountLabel}
                isTurnActive={!paintOnly && turnActive}
                hasPendingRequest={!paintOnly && pending.totalCount > 0}
                queue={slice.queue}
                activePlan={paintOnly ? null : activePlan}
                actionableProposedPlan={null}
                reverting={false}
                actions={actions}
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
                  onExpandedChange={setRosterExpanded}
                  onOpenAgent={setDrillInAgentId}
                  main={rosterMain}
                  activeAgentId={drillInAgentId}
                />
              </div>
            ) : null}
          </div>
        </div>
      </ChatErrorBoundary>
    </div>
  );
}

export default AgentChatView;
