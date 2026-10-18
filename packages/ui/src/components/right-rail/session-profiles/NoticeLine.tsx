/**
 * The panel's one-line feedback (what a change did, or why it did not), with
 * a dismiss button. Read out: the same text goes to a live region.
 */

import React from "react";
import { AlertTriangle, Check, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import type { SessionProfilesNotice } from "../../../lib/session-profiles/store";

export const NoticeLine: React.FC<{ notice: SessionProfilesNotice; sheet: boolean; onDismiss: () => void }> = ({
  notice,
  sheet,
  onDismiss
}) => (
  <div
    data-session-profiles-notice={notice.tone}
    role={notice.tone === "error" ? "alert" : "status"}
    className="flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 py-2 pl-2.5 pr-1.5 text-xs"
  >
    {notice.tone === "ok" ? (
      <Check size={13} aria-hidden className="mt-px shrink-0 text-neutral-400" />
    ) : (
      <AlertTriangle size={13} aria-hidden className="mt-px shrink-0 text-danger" />
    )}
    <span className={cn("min-w-0 flex-1 break-words leading-5", notice.tone === "ok" ? "text-neutral-300" : "text-danger")}>
      {notice.text}
    </span>
    <button
      type="button"
      title="Dismiss"
      onClick={onDismiss}
      className={cn(
        "-my-1 inline-flex shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        sheet ? "h-10 w-10" : "h-6 w-6"
      )}
    >
      <X size={12} aria-hidden />
      <span className="sr-only">Dismiss</span>
    </button>
  </div>
);
