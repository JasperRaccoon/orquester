import React from "react";
import { Info, X } from "lucide-react";
import { useAppStore } from "../../store/app";
import { useAutoDismiss } from "./use-auto-dismiss";

/**
 * Toast for a plain after-the-fact notice with no action of its own — today the
 * "project created, but its setup command didn't start" case, whose modal has
 * already closed onto the created project.
 *
 * Positioning belongs to {@link ToastStack} — this renders only its card.
 */
export const NoticeToast: React.FC = () => {
  const notice = useAppStore((s) => s.notice);
  const dismiss = useAppStore((s) => s.dismissNotice);
  // Advisory and actionless, so it leaves on its own rather than covering the
  // timeline until someone clicks it.
  useAutoDismiss(notice ? `${notice.title ?? ""}\u0000${notice.message}` : null, dismiss);

  if (!notice) {
    return null;
  }

  return (
    <div className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border border-neutral-700 bg-neutral-900/95 py-2 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur">
      <Info size={16} className="mt-0.5 shrink-0 text-neutral-400" />
      <div className="min-w-0 text-neutral-200">
        {notice.title && <div className="font-medium">{notice.title}</div>}
        <div className={notice.title ? "text-[12px] text-neutral-400" : undefined}>
          {notice.message}
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      >
        <X size={14} />
      </button>
    </div>
  );
};
