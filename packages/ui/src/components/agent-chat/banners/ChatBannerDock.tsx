// Ported from T3 Code (MIT): apps/web/src/components/chat/ChatComposer.tsx:6131-6274,
// apps/web/src/components/chat/ComposerBannerStack.tsx
import React from "react";
import type {
  AttachmentRef,
  ParsedToolApprovalSummary,
  SecretRequestSummary,
  ThreadItem,
  ToolApprovalAnswer
} from "@orquester/api/agent-chat";
import { MAX_TURN_ATTACHMENTS } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import {
  failureStatus,
  fetchToolApprovalDetail,
  markToolApprovalClosed
} from "../../../lib/agent-tools/store";
import { useAppStore } from "../../../store/app";
import { useMediaQuery } from "../../../hooks/use-media-query";
import type { AgentChatActions } from "../../../lib/agent-chat/contracts";
import type { ChatBannerDockProps } from "../contracts";
import { BannerCard } from "../primitives";
import { TimelineRowContext, useTimelineRowContext, type TimelineRowContextValue } from "../timeline/context";
import { prepareImageForUpload } from "../composer/composer-image-fit";
import { ApprovalCard } from "./ApprovalCard";
import { McpAppConsentCard } from "./McpAppConsentCard";
import { mcpAppConsents } from "../../../lib/agent-chat/mcp-app-consent";
import { BackgroundLivenessBanner } from "./BackgroundLivenessBanner";
import { PlanReadyBanner } from "./PlanReadyBanner";
import { QuestionCard, type QuestionAttachment } from "./QuestionCard";
import { SecretRequestCard, type SecretRequestAnswer } from "./SecretRequestCard";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { useToolApprovals } from "./use-tool-approvals";
import {
  resolveDockCard,
  showBackgroundLivenessBanner,
  sortBannerStack,
  toolApprovalAnswerFailure,
  type BannerPriority,
  type BannerVariantName,
  type DockCard
} from "./banner-model";
import { questionAttachmentKey } from "./pending-answer";

/**
 * One ambient message in the notice stack above the primary card.
 *
 * Not part of {@link ChatBannerDockProps}: the dock accepts a superset of the
 * shared contract so the integration layer can hand it things the contract
 * does not name yet, without any surface having to change that file.
 */
export interface DockNotice {
  id: string;
  variant: BannerVariantName;
  priority?: BannerPriority;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** A second row under the title (`BannerCard`'s body): actions that would crowd a narrow first row. */
  body?: React.ReactNode;
  onDismiss?: () => void;
}

export interface ChatBannerDockExtraProps {
  /**
   * `true` while a turn is working. The liveness banner is **hidden** then,
   * because the composer already carries a Stop; it is the only stop
   * affordance once the turn settles (§7.6).
   *
   * The shared contract expects the caller to have nulled `backgroundLiveness`
   * in that case; passing this instead — or as well — makes the rule hold here
   * rather than depending on every caller remembering it.
   */
  isTurnWorking?: boolean;
  /** Enables per-question attachments (§7.5). Without it the card has none. */
  uploadAttachment?: AgentChatActions["uploadAttachment"];
  /** The general notice stack. Sorted activity-first, then by severity. */
  notices?: readonly DockNotice[];
  /** `false` while this tab is open but not visible — gates the digit keys. */
  active?: boolean;
  /**
   * The thread's items, so a file-change approval carrying no `detail` can be
   * joined to the tool call it gates and show its paths and diff (E2E E7).
   */
  entries?: readonly ThreadItem[];
  /**
   * The pending proposal's own title, for the "Plan ready" card's description
   * slot. Without it the banner names a plan the user cannot identify.
   *
   * *Added by W15; the boolean `actionableProposedPlan` still gates the card.*
   */
  planTitle?: string | null;
  /**
   * The thread's pending `request_secret` cards, oldest first (design
   * 2026-10-14 §5); the first is shown, after approvals and questions.
   */
  secretRequests?: readonly SecretRequestSummary[];
  /** Answers one; resolves once the daemon took it, rejects with the HTTP status (or null). */
  onAnswerSecret?: (requestId: string, answer: SecretRequestAnswer) => Promise<void>;
  /**
   * The chat's pending Orquester approval cards (unified MCP §7), oldest first. Absent: the dock
   * reads them itself (`useToolApprovals`) — the chat view passes nothing; a render check passes
   * fixtures.
   */
  toolApprovals?: readonly ParsedToolApprovalSummary[];
  /**
   * The project directory, so a question's markdown resolves a relative image
   * against it and reads it through the file API, as the timeline does.
   */
  projectPath?: string;
  /** Opens a workspace-relative link of a question in an editor tab, as the timeline does. */
  onOpenFile?: (path: string) => void;
}

const NO_SECRET_REQUESTS: readonly SecretRequestSummary[] = [];

/** Match `ac-banner-exit`: keep a dismissed notice mounted while it leaves. */
const DISMISS_TRANSITION_MS = 220;

/**
 * Every card sits on the page background rather than straight on the timeline.
 *
 * `BannerCard`'s tone wash is a translucent tint by design (a `warn` card is
 * `bg-warn-soft/30`), and the timeline scrolls **behind** this dock — without
 * an opaque layer under it, rows would visibly slide through the approval the
 * user is reading.
 */
const CARD_BACKDROP = "min-w-0 rounded-t-xl bg-neutral-950";

/**
 * The docked banner — everything that needs the user *now*, between the status
 * line and the composer.
 *
 * **Fixed priority order, one request at a time.** Approval, then an
 * Orquester approval card, then pending question, then an agent's request for
 * a secret, then the plan-ready prompt,
 * then the mobile-collapsed question ({@link resolveDockCard}); a `1/N` counter says how many are behind it.
 * Nothing here is ever a modal, nothing steals focus, and nothing scrolls
 * away — a request that scrolls away is a turn that hangs.
 *
 * Above the card sits the notice stack, sorted **activity first, then
 * severity**: a live thing the user is watching outranks a warning about
 * something that already happened. The background-liveness banner lives there,
 * at activity priority, and is the only stop affordance once a turn settles.
 *
 * *T3: `ChatComposer.tsx:6131-6274` (the dock and its four-branch chain);
 * `ComposerBannerStack.tsx:33-41, 91-92` (the sort).*
 */
export function ChatBannerDock({
  sessionId,
  approvals,
  userInputs,
  respondingRequestIds,
  backgroundLiveness,
  liveAgentCount,
  liveShellCount = 0,
  stopping,
  actionableProposedPlan,
  onApprove,
  onAnswer,
  onDismiss,
  onStopBackgroundWork,
  onCarryTextToDraft,
  isTurnWorking = false,
  uploadAttachment,
  notices,
  active,
  entries,
  planTitle = null,
  secretRequests = NO_SECRET_REQUESTS,
  onAnswerSecret,
  toolApprovals: toolApprovalsProp,
  projectPath,
  onOpenFile
}: ChatBannerDockProps & ChatBannerDockExtraProps): React.ReactElement | null {
  // One breakpoint governs every mobile rule in the chat surface (§7.8).
  const isMobile = !useMediaQuery("(min-width: 640px)");
  const [stackExpanded, setStackExpanded] = React.useState(false);
  const [exitingNoticeId, setExitingNoticeId] = React.useState<string | null>(null);
  const dismissTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [questionAttachments, setQuestionAttachments] = React.useState<
    Record<string, QuestionAttachment[]>
  >({});

  const approval = approvals[0] ?? null;
  const userInput = userInputs[0] ?? null;

  // Orquester approval cards (unified MCP §7): daemon-owned and memory-only, like the secret
  // cards; answered on their own route only. Secrets typed on one go from the card to that
  // route's body and nowhere else on this side.
  const storedToolApprovals = useToolApprovals(sessionId, toolApprovalsProp === undefined);
  const toolApprovals = toolApprovalsProp ?? storedToolApprovals;
  const toolApproval = toolApprovals[0] ?? null;
  const api = useAppStore((state) => state.api);
  const openSettings = useAppStore((state) => state.openSettings);
  // An answer that arrived after the card ended: said here, since the card itself is gone.
  const [toolApprovalNotice, setToolApprovalNotice] = React.useState<string | null>(null);
  React.useEffect(() => setToolApprovalNotice(null), [sessionId]);
  const answerToolApproval = React.useCallback(
    async (approvalId: string, answer: ToolApprovalAnswer): Promise<void> => {
      if (!api) throw null;
      try {
        await api.answerToolApproval(sessionId, approvalId, answer);
      } catch (error) {
        const status = failureStatus(error);
        const failure = toolApprovalAnswerFailure(status);
        if (failure.closed) {
          markToolApprovalClosed(sessionId, approvalId);
          setToolApprovalNotice(failure.text);
          return;
        }
        throw status;
      }
      setToolApprovalNotice(null);
      markToolApprovalClosed(sessionId, approvalId);
    },
    [api, sessionId]
  );
  const loadToolApprovalDetail = React.useCallback(
    (approvalId: string): Promise<ParsedToolApprovalSummary | null> =>
      api ? fetchToolApprovalDetail(api, sessionId, approvalId) : Promise.resolve(null),
    [api, sessionId]
  );
  const secretRequest = onAnswerSecret ? (secretRequests[0] ?? null) : null;

  // MCP Apps (spec 2026-10-14 §3): this dock is where an app of this thread
  // asks for consent. While it is mounted the thread can be asked; an app
  // asking with no dock mounted is told nobody could be (`mcp-app-consent.ts`).
  React.useEffect(() => mcpAppConsents.attachDock(sessionId), [sessionId]);
  const appConsents = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => mcpAppConsents.subscribe(listener), []),
    () => mcpAppConsents.pending(sessionId),
    () => mcpAppConsents.pending(sessionId)
  );
  const appConsent = appConsents[0] ?? null;

  /*
   * The question card renders the chat's markdown, whose images resolve
   * against the row context's `workspaceRoot`; the dock sits outside the
   * timeline's provider, so it provides one. Outside a timeline the context
   * holds its read-only fallback, which is what a card wants for the rest:
   * no row affordance applies to it.
   */
  const rowContext = useTimelineRowContext();
  const questionRowContext = React.useMemo<TimelineRowContextValue>(
    () => ({
      ...rowContext,
      sessionId,
      workspaceRoot: projectPath || undefined,
      ...(onOpenFile ? { onOpenFile } : {})
    }),
    [onOpenFile, projectPath, rowContext, sessionId]
  );

  // Per-question attachment drafts belong to one request; a new one starts
  // clean rather than inheriting the previous question's files.
  const userInputRequestId = userInput?.requestId ?? null;
  React.useEffect(() => {
    setQuestionAttachments({});
  }, [userInputRequestId, sessionId]);

  React.useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
    },
    []
  );

  const liveCard = resolveDockCard({
    hasApproval: approval !== null,
    hasToolApproval: toolApproval !== null,
    hasUserInput: userInput !== null,
    hasSecretRequest: secretRequest !== null,
    hasActionableProposedPlan: actionableProposedPlan,
    isComposerCollapsedMobile: isMobile,
    hasAppConsent: appConsent !== null
  });
  /*
   * R8-m1: answering an approval or a question used to make the card vanish in
   * one frame — only the ambient notices got T3's 64px drop. Hold the resolved
   * card for the exit's duration so the user sees where it went. The held card
   * is `pointer-events: none` via `ac-banner-exit`, so a click cannot land on
   * something already half-way behind the composer.
   */
  const [exitingCard, setExitingCard] = React.useState<DockCard>(null);
  const previousCardRef = React.useRef<DockCard>(liveCard);
  const cardExitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    const previous = previousCardRef.current;
    previousCardRef.current = liveCard;
    if (liveCard !== null || previous === null) return;
    setExitingCard(previous);
    if (cardExitTimerRef.current !== null) clearTimeout(cardExitTimerRef.current);
    cardExitTimerRef.current = setTimeout(() => {
      cardExitTimerRef.current = null;
      setExitingCard(null);
    }, DISMISS_TRANSITION_MS);
  }, [liveCard]);
  React.useEffect(
    () => () => {
      if (cardExitTimerRef.current !== null) clearTimeout(cardExitTimerRef.current);
    },
    []
  );
  const card = liveCard ?? exitingCard;
  const cardLeaving = liveCard === null && exitingCard !== null;

  const stackItems = React.useMemo(() => {
    const stackEntries: Array<DockNotice & { render: React.ReactNode }> = [];
    if (
      backgroundLiveness !== null &&
      showBackgroundLivenessBanner({ backgroundLiveness, isTurnWorking })
    ) {
      stackEntries.push({
        id: `background-liveness:${sessionId}`,
        variant: "default",
        priority: "activity",
        title: "",
        render: (
          <BackgroundLivenessBanner
            liveness={backgroundLiveness}
            liveAgentCount={liveAgentCount}
            liveShellCount={liveShellCount}
            stopping={stopping}
            onStop={onStopBackgroundWork}
          />
        )
      });
    }
    const allNotices: DockNotice[] = [...(notices ?? [])];
    if (toolApprovalNotice !== null) {
      allNotices.push({
        id: `tool-approval-notice:${sessionId}`,
        variant: "warning",
        title: "Approval",
        description: toolApprovalNotice,
        onDismiss: () => setToolApprovalNotice(null)
      });
    }
    for (const notice of allNotices) {
      stackEntries.push({
        ...notice,
        render: (
          <BannerCard
            variant={notice.variant}
            density="compact"
            icon={notice.icon}
            title={notice.title}
            description={notice.description}
            actions={notice.actions}
            onDismiss={notice.onDismiss ? () => requestDismiss(notice) : undefined}
            {...(notice.body ? { children: notice.body } : {})}
            className={exitingNoticeId === notice.id ? "ac-banner-exit" : undefined}
          />
        )
      });
    }
    return sortBannerStack(stackEntries);
    // `requestDismiss` is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    backgroundLiveness,
    exitingNoticeId,
    isTurnWorking,
    liveAgentCount,
    liveShellCount,
    notices,
    onStopBackgroundWork,
    sessionId,
    stopping,
    toolApprovalNotice
  ]);

  // R8-m6: expand the stack, let the notices resolve, and the next one would
  // otherwise arrive already open. T3 resets on exactly this condition.
  const stackCount = stackItems.length;
  React.useEffect(() => {
    if (stackCount < 2) setStackExpanded(false);
  }, [stackCount]);

  function requestDismiss(notice: DockNotice): void {
    if (!notice.onDismiss || exitingNoticeId !== null) return;
    setExitingNoticeId(notice.id);
    if (dismissTimerRef.current !== null) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null;
      setExitingNoticeId(null);
      notice.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  }

  const attachToQuestion = React.useCallback(
    (questionId: string, files: File[]) => {
      if (!uploadAttachment || !userInputRequestId) return;
      const key = questionAttachmentKey(userInputRequestId, questionId);
      for (const file of files) {
        const entryKey = `${key}:${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
        setQuestionAttachments((current) => {
          const existing = current[key] ?? [];
          // Staged plus in-flight share the budget; refuse rather than exceed.
          if (existing.length >= MAX_TURN_ATTACHMENTS) return current;
          return {
            ...current,
            [key]: [...existing, { key: entryKey, name: file.name, status: "uploading" }]
          };
        });
        // A large photo goes up at the provider's size, as in the composer.
        void prepareImageForUpload(file)
          .then((prepared) => uploadAttachment(prepared, { name: prepared.name, type: prepared.type }))
          .then((ref: AttachmentRef) => {
            setQuestionAttachments((current) => ({
              ...current,
              [key]: (current[key] ?? []).map((entry) =>
                entry.key === entryKey ? { ...entry, status: "ready" as const, ref } : entry
              )
            }));
          })
          .catch(() => {
            setQuestionAttachments((current) => ({
              ...current,
              [key]: (current[key] ?? []).map((entry) =>
                entry.key === entryKey ? { ...entry, status: "failed" as const } : entry
              )
            }));
          });
      }
    },
    [uploadAttachment, userInputRequestId]
  );

  const removeQuestionAttachment = React.useCallback(
    (questionId: string, entryKey: string) => {
      if (!userInputRequestId) return;
      const key = questionAttachmentKey(userInputRequestId, questionId);
      setQuestionAttachments((current) => ({
        ...current,
        [key]: (current[key] ?? []).filter((entry) => entry.key !== entryKey)
      }));
    },
    [userInputRequestId]
  );

  if (stackItems.length === 0 && card === null) return null;

  const frontItem = stackItems[0];
  const restItems = stackItems.slice(1);
  // The card the composer's top edge overlaps carries the tuck as padding
  // (`ac-banner-attached`, see `agent-chat.css`): the primary card when there
  // is one, else the front notice. It is always a CARD — the stack's toggle
  // sits above the notices, never at the bottom, so it can never be the
  // element pulled behind the composer.
  const primaryAttached = card !== null;

  return (
    <div
      data-agent-chat-banner-dock={sessionId}
      // `-mb-[calc(1rem+1px)]` is the 17px pull behind the composer (T3
      // `ComposerBanner.tsx:55`). It sits here, on the element that is absent
      // when there is nothing to show, so an empty dock displaces nothing.
      // The horizontal inset is the composer box's own inset (8px, 16px from
      // `sm:`) plus its 22px corner radius, so a card's straight sides meet the
      // box's FLAT top edge and disappear behind it — an inset smaller than the
      // radius left them notching into the rounded corners.
      className="pointer-events-auto -mb-[calc(1rem+1px)] flex w-full min-w-0 flex-col gap-px px-[1.875rem] pt-1 sm:px-[2.375rem]"
    >
      {restItems.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={stackExpanded}
            onClick={() => setStackExpanded((value) => !value)}
            className={cn(
              "ac-press self-end rounded-md px-2 py-0.5 text-[11px] text-neutral-500",
              "hover:bg-neutral-800 hover:text-neutral-300",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            )}
          >
            {stackExpanded ? "Show less" : `${restItems.length} more`}
          </button>
          <div className="ac-stack" data-open={stackExpanded ? "true" : "false"}>
            <div className="ac-stack-panel">
              <div className="ac-stack-items flex flex-col gap-px">
                {restItems.map((item) => (
                  <div key={item.id} className={CARD_BACKDROP}>
                    {item.render}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
      {frontItem ? (
        <div className={cn(CARD_BACKDROP, !primaryAttached && "ac-banner-attached")}>
          {frontItem.render}
        </div>
      ) : null}

      <div
        className={cn(
          card === null ? "hidden" : cn(CARD_BACKDROP, "ac-banner-attached"),
          cardLeaving && "ac-banner-exit"
        )}
      >
      {card === "approval" && approval ? (
        <ApprovalCard
          key={approval.requestId}
          approval={approval}
          pendingCount={approvals.length}
          isResponding={respondingRequestIds.includes(approval.requestId)}
          entries={entries}
          onRespond={(decision) => onApprove({ requestId: approval.requestId, decision })}
        />
      ) : null}

      {card === "tool-approval" && toolApproval ? (
        <ToolApprovalCard
          key={toolApproval.approvalId}
          card={toolApproval}
          pendingCount={toolApprovals.length}
          isMobile={isMobile}
          onAnswer={(answer) => answerToolApproval(toolApproval.approvalId, answer)}
          onLoadFull={() => loadToolApprovalDetail(toolApproval.approvalId)}
          onOpenSettings={() => openSettings("agent-tools")}
        />
      ) : null}

      {(card === "question" || card === "question-mobile") && userInput ? (
        <TimelineRowContext.Provider value={questionRowContext}>
          <QuestionCard
            key={userInput.requestId}
            request={userInput}
            compact={card === "question-mobile"}
            isResponding={respondingRequestIds.includes(userInput.requestId)}
            attachments={questionAttachments}
            onAttachFiles={uploadAttachment ? attachToQuestion : undefined}
            onRemoveAttachment={uploadAttachment ? removeQuestionAttachment : undefined}
            onSubmit={({ answers, attachmentsByQuestionId }) =>
              onAnswer({
                requestId: userInput.requestId,
                answers,
                ...(Object.keys(attachmentsByQuestionId).length > 0
                  ? { attachmentsByQuestionId }
                  : {})
              })
            }
            onDismiss={userInput.dismissible ? () => onDismiss(userInput.requestId) : null}
            onCarryTextToDraft={onCarryTextToDraft}
            active={active}
            onOpenFile={onOpenFile}
          />
        </TimelineRowContext.Provider>
      ) : null}

      {card === "secret" && secretRequest && onAnswerSecret ? (
        <SecretRequestCard
          key={secretRequest.requestId}
          request={secretRequest}
          pendingCount={secretRequests.length}
          onAnswer={(answer) => onAnswerSecret(secretRequest.requestId, answer)}
        />
      ) : null}

      {card === "app-consent" && appConsent ? (
        <McpAppConsentCard
          key={appConsent.id}
          request={appConsent}
          pendingCount={appConsents.length}
          onAnswer={(allowed) => mcpAppConsents.answer(appConsent.id, allowed)}
        />
      ) : null}

      {card === "plan-ready" ? <PlanReadyBanner planTitle={planTitle} /> : null}
      </div>
    </div>
  );
}

export default ChatBannerDock;
