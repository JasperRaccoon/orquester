import React from "react";
import { createPortal } from "react-dom";
import { ConnectionStatusToast } from "./ConnectionStatusToast";
import { ModelWarningToast } from "./ModelWarningToast";
import { NoticeToast } from "./NoticeToast";
import { ResumeErrorToast } from "./ResumeErrorToast";

/**
 * The one floating toast region. Each toast used to portal its own
 * `fixed inset-x-0 top-3` wrapper, so two of them showing at once stacked in
 * the same place and the lower one was unreadable (a refused resume plus a
 * reconnect is exactly the pairing that happens). They now render bare cards
 * into this single column, which lays them out with a gap.
 *
 * Order is by urgency: transport trouble first (it explains why the others may
 * be failing), then launch-time warnings, then plain notices.
 */
export const ToastStack: React.FC = () =>
  createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[95] flex flex-col items-center gap-2 px-3">
      <ConnectionStatusToast />
      <ModelWarningToast />
      <ResumeErrorToast />
      <NoticeToast />
    </div>,
    document.body
  );
