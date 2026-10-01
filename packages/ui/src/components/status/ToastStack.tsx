import React from "react";
import { createPortal } from "react-dom";
import { AgentAuthErrorToast } from "./AgentAuthErrorToast";
import { ConnectionStatusToast } from "./ConnectionStatusToast";
import { NoticeToast } from "./NoticeToast";
import { ResumeErrorToast } from "./ResumeErrorToast";
import { WorkflowRunToast } from "../workflows/runs/WorkflowRunToast";

/**
 * The one floating toast region. Each toast used to portal its own
 * `fixed inset-x-0 top-3` wrapper, so two of them showing at once stacked in
 * the same place and the lower one was unreadable (a refused resume plus a
 * reconnect is exactly the pairing that happens). They now render bare cards
 * into this single column, which lays them out with a gap.
 *
 * Order is by urgency: transport trouble first (it explains why the others may
 * be failing), then a refused resume, then the agent-auth failure (every turn
 * on that thread will fail until it is fixed), then a finished workflow run,
 * then plain notices.
 *
 * The column also bounds the cards on a phone: each is capped to the column's
 * width and long unbroken text (a prompt-derived tab title with a URL in it)
 * wraps anywhere, so a card can never grow past the screen edges. The top
 * offset clears the status bar of an installed PWA.
 */
export const ToastStack: React.FC = () =>
  createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[95] mx-auto flex max-w-[calc(32rem+1.5rem)] flex-col items-center gap-2 px-3 [overflow-wrap:anywhere] [&>*]:max-w-full">
      <ConnectionStatusToast />
      <ResumeErrorToast />
      <AgentAuthErrorToast />
      <WorkflowRunToast />
      <NoticeToast />
    </div>,
    document.body
  );
