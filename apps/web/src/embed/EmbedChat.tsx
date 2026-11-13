/**
 * The embed's React tree: the app's own timeline over the element's thread,
 * and beside it a dock for the thread's open questions and approvals (design
 * `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md` §5.4,
 * §5.6).
 *
 * Mounted by the element (`element.tsx`) in its shadow root with its own
 * {@link ChatHost} and portal container. Every app-only affordance the
 * timeline takes as a prop is left out — never a control that does nothing:
 * no rewind, fork, "continue in…", turn diff, file opening (paths are plain
 * text), agent drill-in, queue or background tool, and no "load full output"
 * until the host sets both the `item` and the `itemOutput` loaders (a row's
 * read may need either, and which one is known only once the first answers).
 */

import React from "react";

import type { ApprovalDecision, AttachmentRef } from "@orquester/api/agent-chat";

import { ChatHostProvider, type ChatHost } from "../../../../packages/ui/src/components/agent-chat/chat-host";
import { FullOutputPane } from "../../../../packages/ui/src/components/agent-chat/FullOutputPane";
import { ApprovalCard } from "../../../../packages/ui/src/components/agent-chat/banners/ApprovalCard";
import { resolveDockCard } from "../../../../packages/ui/src/components/agent-chat/banners/banner-model";
import { QuestionCard, type QuestionAttachment } from "../../../../packages/ui/src/components/agent-chat/banners/QuestionCard";
import { ChatTimeline } from "../../../../packages/ui/src/components/agent-chat/timeline/ChatTimeline";
import {
  TimelineRowContext,
  useTimelineRowContext,
  type TimelineRowContextValue
} from "../../../../packages/ui/src/components/agent-chat/timeline/context";
import { Modal, ModalCloseButton } from "../../../../packages/ui/src/components/ui/modal";
import { BackCloseProvider } from "../../../../packages/ui/src/hooks/use-back-close";
import { useMediaQuery } from "../../../../packages/ui/src/hooks/use-media-query";
import type { AgentChatTimelineRow } from "../../../../packages/ui/src/lib/agent-chat/contracts";
import {
  createViewerReads,
  fullOutputViewerCopy,
  type FullOutputSource
} from "../../../../packages/ui/src/lib/agent-chat/full-output";
import { PortalContainerProvider } from "../../../../packages/ui/src/lib/portal-container";

import { loadFullOutput } from "./full-output";
import type { EmbedSettings } from "./settings";
import type { EmbedThread, EmbedThreadView } from "./thread";

/** What a card asks the element to send: the command body without its `commandId`. */
export type EmbedCommandRequest =
  | { command: "answer"; requestId: string; answers: Record<string, unknown> }
  | { command: "dismiss"; requestId: string }
  | { command: "approval"; requestId: string; decision: ApprovalDecision };

export interface EmbedChatProps {
  thread: EmbedThread;
  settings: EmbedSettings;
  host: ChatHost;
  /** Where popovers, menus and the viewer mount: a node inside the shadow root. */
  portal: HTMLElement;
  onCommand: (request: EmbedCommandRequest) => void;
}

const noop = (): void => {};
const NO_SKILLS: readonly string[] = [];
const NO_NOTES: readonly string[] = [];

interface ViewerState {
  title: string;
  loading: boolean;
  text?: string;
  notes?: readonly string[];
  error?: string;
}

export function EmbedChat({ thread, settings, host, portal, onCommand }: EmbedChatProps): React.ReactElement {
  const view = React.useSyncExternalStore(thread.subscribe, thread.getView);
  const config = React.useSyncExternalStore(settings.subscribe, settings.get);
  const sessionId = view.sessionId;

  // "Load full output": a read with no thread state behind it, shown in a
  // modal, one read at a time — as `AgentChatView` does.
  const [viewer, setViewer] = React.useState<ViewerState | null>(null);
  const [viewerReads] = React.useState(createViewerReads);
  const closeViewer = React.useCallback(() => {
    viewerReads.retire();
    setViewer(null);
  }, [viewerReads]);
  const onLoadFullOutput = React.useCallback(
    (itemId: string, source?: FullOutputSource) => {
      const { item, itemOutput } = settings.get().loaders;
      if (item === undefined || itemOutput === undefined || sessionId === null) return;
      const signal = viewerReads.begin();
      setViewer({ title: fullOutputViewerCopy(source).title, loading: true });
      void loadFullOutput({ item, itemOutput }, sessionId, itemId, source, signal).then((result) => {
        if (signal.aborted) return;
        setViewer(
          result.kind === "output"
            ? { title: result.title, loading: false, text: result.text, notes: result.notes }
            : { title: result.title, loading: false, error: result.error }
        );
      });
    },
    [sessionId, settings, viewerReads]
  );
  // A viewer belongs to the thread that opened it.
  React.useEffect(() => {
    closeViewer();
    return () => viewerReads.retire();
  }, [closeViewer, sessionId, viewerReads]);

  const onFollowChange = React.useCallback((follow: boolean) => thread.setFollow(follow), [thread]);
  const onDisclosureChange = React.useCallback(
    (patch: Parameters<EmbedThread["setDisclosure"]>[0]) => thread.setDisclosure(patch),
    [thread]
  );
  const onLoadOlderHistory = React.useCallback(() => void thread.loadOlder(), [thread]);
  const historyHasOlder = config.loaders.history !== undefined && thread.canLoadOlder();
  const canLoadFullOutput = config.loaders.item !== undefined && config.loaders.itemOutput !== undefined;

  return (
    <ChatHostProvider host={host}>
      {/* The page's history is its own: no overlay here pushes entries for Back. */}
      <BackCloseProvider enabled={false}>
        <PortalContainerProvider container={portal}>
          <div data-orq-embed-chat="" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-neutral-950 text-neutral-200">
            <ChatTimeline
              sessionId={sessionId ?? ""}
              rows={view.rows as AgentChatTimelineRow[]}
              follow={view.slice.follow}
              onFollowChange={onFollowChange}
              disclosures={view.slice.disclosures}
              onDisclosureChange={onDisclosureChange}
              bottomInset={0}
              canRevert={false}
              onRevert={noop}
              // Nothing opens here: no turn diff, file or agent drill-in, so
              // those render as plain text. Full output only with both its loaders.
              onOpenTurnDiff={null}
              onOpenFile={null}
              onLoadFullOutput={canLoadFullOutput ? onLoadFullOutput : null}
              onOpenAgent={null}
              onSendQueuedNow={noop}
              onReturnQueuedToComposer={noop}
              threadReady={sessionId !== null}
              canBackgroundTasks={false}
              errorBanner={null}
              onDismissErrorBanner={noop}
              // Not read-only: the timeline offers "load older" only on a
              // writable surface. Every command affordance is withheld above.
              readOnly={false}
              retentionDropped={view.retentionDropped}
              roster={view.slice.roster}
              projectPath={config.workspaceRoot}
              skills={NO_SKILLS}
              historyHasOlder={historyHasOlder}
              historyLoading={view.slice.history.loading}
              historyError={view.slice.history.error}
              onLoadOlderHistory={onLoadOlderHistory}
            />
            <EmbedPendingDock view={view} workspaceRoot={config.workspaceRoot} onCommand={onCommand} />
          </div>
          <Modal open={viewer !== null} onClose={closeViewer} className="max-h-[85vh] max-w-4xl">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
                <span className="truncate text-sm text-neutral-200">{viewer?.title}</span>
                <ModalCloseButton onClose={closeViewer} />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {viewer?.error ? (
                  <p className="px-4 py-6 text-sm text-danger">{viewer.error}</p>
                ) : (
                  <FullOutputPane loading={viewer?.loading ?? false} text={viewer?.text ?? ""} notes={viewer?.notes ?? NO_NOTES} />
                )}
              </div>
            </div>
          </Modal>
        </PortalContainerProvider>
      </BackCloseProvider>
    </ChatHostProvider>
  );
}

const NO_ATTACHMENTS: Record<string, QuestionAttachment[]> = {};

/**
 * The open request the thread waits on, one at a time in the app dock's
 * order (`resolveDockCard`): an approval, then a question. The card stays
 * "responding" from its answer until the frames show the request settled or
 * the host calls `respondFailed`.
 *
 * Unlike the app's dock: no attachments in answers, no composer bridge, and
 * no digit shortcuts (`active={false}`) — a host page owns its own keys.
 */
function EmbedPendingDock({
  view,
  workspaceRoot,
  onCommand
}: {
  view: EmbedThreadView;
  workspaceRoot: string | undefined;
  onCommand: (request: EmbedCommandRequest) => void;
}): React.ReactElement | null {
  const isMobile = !useMediaQuery("(min-width: 640px)");
  const { approvals, userInputs } = view.slice.pending;
  const approval = approvals[0] ?? null;
  const userInput = userInputs[0] ?? null;
  const card = resolveDockCard({
    hasApproval: approval !== null,
    hasUserInput: userInput !== null,
    hasActionableProposedPlan: false,
    isMobile
  });
  // An answer given elsewhere locks the card too: its resolution is on its way.
  const responding = React.useMemo(
    () => new Set([...view.slice.respondingRequestIds, ...(view.slice.answeredRequestIds ?? [])]),
    [view.slice.answeredRequestIds, view.slice.respondingRequestIds]
  );
  // The question's markdown resolves against the row context, which the dock
  // sits outside of: the read-only fallback, with this thread's session.
  const rowContext = useTimelineRowContext();
  const questionContext = React.useMemo<TimelineRowContextValue>(
    () => ({ ...rowContext, ...(view.sessionId === null ? {} : { sessionId: view.sessionId }), workspaceRoot }),
    [rowContext, view.sessionId, workspaceRoot]
  );
  if (card === null) return null;
  const shownId = card === "approval" ? approval?.requestId : userInput?.requestId;
  const failure = view.failure !== null && view.failure.requestId === shownId ? view.failure.message : null;
  return (
    <div
      data-orq-embed-dock=""
      className="ac-scroll-thin mx-auto max-h-[60%] w-full min-w-0 max-w-3xl shrink-0 overflow-y-auto px-3 pb-3 sm:px-5"
    >
      {failure !== null ? (
        <p role="alert" className="px-1 pb-1 text-xs text-danger">
          {failure}
        </p>
      ) : null}
      {card === "approval" && approval ? (
        <div className="min-w-0 rounded-xl bg-neutral-950">
          <ApprovalCard
            key={approval.requestId}
            approval={approval}
            pendingCount={approvals.length}
            isResponding={responding.has(approval.requestId)}
            entries={view.slice.entries}
            onRespond={(decision) => onCommand({ command: "approval", requestId: approval.requestId, decision })}
          />
        </div>
      ) : null}
      {(card === "question" || card === "question-mobile") && userInput ? (
        <div className="min-w-0 rounded-xl bg-neutral-950">
          <TimelineRowContext.Provider value={questionContext}>
            <QuestionCard
              key={userInput.requestId}
              request={userInput}
              compact={card === "question-mobile"}
              isResponding={responding.has(userInput.requestId)}
              attachments={NO_ATTACHMENTS}
              onSubmit={({ answers }: { answers: Record<string, string | string[]>; attachmentsByQuestionId: Record<string, AttachmentRef[]> }) =>
                onCommand({ command: "answer", requestId: userInput.requestId, answers })
              }
              onDismiss={
                userInput.dismissible ? () => onCommand({ command: "dismiss", requestId: userInput.requestId }) : null
              }
              onOpenFile={null}
              active={false}
            />
          </TimelineRowContext.Provider>
        </div>
      ) : null}
    </div>
  );
}
