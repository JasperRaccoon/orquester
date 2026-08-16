import React from "react";
import { AlertTriangle, X } from "lucide-react";
import { useAppStore } from "../../store/app";

/**
 * Toast for a claudex/claudemix session's launch-time pre-flight: the models it
 * referenced that the live proxy catalog didn't offer. The launch still
 * succeeded (a missing model warns, it never blocks), so this is purely
 * advisory and dismissible. Driven by the transient `modelWarning` store field.
 *
 * Positioning belongs to {@link ToastStack} — this renders only its card.
 */
export const ModelWarningToast: React.FC = () => {
  const warning = useAppStore((s) => s.modelWarning);
  const dismiss = useAppStore((s) => s.dismissModelWarning);

  if (!warning) {
    return null;
  }

  return (
    <div className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border border-warn-700/60 bg-neutral-900/95 py-2 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 text-neutral-200">
        <span className="font-medium">{warning.title}</span> launched, but these models
        aren&apos;t in the live catalog:{" "}
        <span className="break-words text-warn-300">{warning.models.join(", ")}</span>.
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
