import React from "react";
import { AlertTriangle, X } from "lucide-react";
import { launchWithNotice } from "../../lib/launch-notice";
import { useAppStore } from "../../store/app";

/**
 * Toast for a refused resume. The daemon answers `RESUME_UNAVAILABLE` rather
 * than quietly starting a fresh session the user would mistake for their old
 * one — so nothing was launched, and the only useful recovery is offered here:
 * start a fresh session with the same agent, under the same account/model, in
 * the project the refused attempt targeted (`startFreshFromResumeError`).
 *
 * Positioning belongs to {@link ToastStack} — this renders only its card.
 */
export const ResumeErrorToast: React.FC = () => {
  const error = useAppStore((s) => s.resumeError);
  const dismiss = useAppStore((s) => s.dismissResumeError);
  const startFresh = useAppStore((s) => s.startFreshFromResumeError);

  if (!error) {
    return null;
  }

  return (
    <div className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border border-amber-700/60 bg-neutral-900/95 py-2 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0 text-neutral-200">
        <div>{error.message}</div>
        <button
          type="button"
          onClick={() => launchWithNotice(startFresh(), error.agentName)}
          className="mt-1 rounded text-[12px] font-medium text-amber-300 underline-offset-2 hover:underline"
        >
          Start a fresh {error.agentName} session
        </button>
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
