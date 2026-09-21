import React from "react";
import { KeyRound, X } from "lucide-react";
import { useAppStore } from "../../store/app";

/**
 * Toast for a chat provider's `auth.status` reporting an error (spec §7.7).
 *
 * Distinct from the plain `NoticeToast` because it carries an action: the fix
 * is always the same place — Settings → Accounts — and a notice that names a
 * problem without a way to it is a dead end. The thread itself keeps its own
 * banner; this is the ambient copy for a user who is looking elsewhere.
 *
 * Positioning belongs to {@link ToastStack} — this renders only its card.
 */
export const AgentAuthErrorToast: React.FC = () => {
  const error = useAppStore((s) => s.agentAuthError);
  const dismiss = useAppStore((s) => s.dismissAgentAuthError);
  const openSettings = useAppStore((s) => s.openSettings);

  if (!error) {
    return null;
  }

  return (
    <div className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border border-danger-500/40 bg-neutral-900/95 py-2 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur">
      <KeyRound size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 text-neutral-200">
        <div className="font-medium">{error.agentName} needs signing in again</div>
        <div className="text-[12px] text-neutral-400">{error.message}</div>
        <button
          type="button"
          onClick={() => {
            dismiss();
            openSettings("accounts");
          }}
          className="mt-1.5 rounded border border-neutral-700 px-2 py-1 text-[12px] text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
        >
          Open Settings → Accounts
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
