/**
 * Settings → Plugins → Knowledge Graph → Activity: one worker chat's transcript, read-only, in a
 * dialog over Settings (spec "Worker sessions": the Activity panel links to each transcript for
 * debugging).
 *
 * A worker chat is no project's tab: its "project" is the plugin's workers folder, so it is shown
 * here rather than navigated to. The rows are the thread's own (`useAgentChatThread`, the same
 * stream a chat tab holds) in the shared `ChatTimeline`, read-only, with every command inert
 * (`drillInTimelineCallbacks`). The daemon closes a worker chat when it is done, and its thread is
 * then no longer readable: the dialog says so and keeps what it had loaded.
 */

import React from "react";

import { useAgentChatThread } from "../../lib/agent-chat/hooks";
import { Modal, ModalCloseButton } from "../ui";
import { drillInTimelineCallbacks } from "../agent-chat/roster/drill-in-callbacks";
import { ChatTimeline } from "../agent-chat/timeline/ChatTimeline";

const noop = (): void => {};
const INERT = drillInTimelineCallbacks({});

export const WorkerTranscriptDialog: React.FC<{ sessionId: string | null; onClose: () => void }> = ({ sessionId, onClose }) => (
  <Modal open={sessionId !== null} onClose={onClose} className="h-[85vh] flex-col">
    {sessionId !== null && (
      <>
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-neutral-100">Worker transcript</h2>
            <code className="select-all font-mono text-[11px] text-neutral-500">{sessionId}</code>
          </div>
          <ModalCloseButton onClose={onClose} />
        </header>
        <WorkerTranscript sessionId={sessionId} />
      </>
    )}
  </Modal>
);

const WorkerTranscript: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { slice, actions, rows } = useAgentChatThread(sessionId);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-neutral-950">
      {slice.connection === "gone" && (
        <p className="shrink-0 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-500">
          This worker chat has closed; only what was already loaded is shown.
        </p>
      )}
      <ChatTimeline
        sessionId={sessionId}
        readOnly
        rows={rows}
        follow={slice.follow}
        onFollowChange={actions.setFollow}
        disclosures={slice.disclosures}
        onDisclosureChange={actions.setDisclosure}
        bottomInset={0}
        {...INERT}
        threadReady={slice.connection === "synchronized"}
        errorBanner={null}
        onDismissErrorBanner={noop}
      />
    </div>
  );
};
