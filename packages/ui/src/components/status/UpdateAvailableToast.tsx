import React, { useCallback, useEffect, useState } from "react";
import { CircleArrowUp, X } from "lucide-react";
import type { SelfUpdateStatusResponse } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { readDismissedUpdate, updateToastKey, writeDismissedUpdate } from "../../lib/self-update.logic";
import { ACTION_TOAST_AUTO_DISMISS_MS, useAutoDismiss } from "./use-auto-dismiss";

/** The daemon checks GitHub hourly; re-reading its answer as often keeps a long-open tab current. */
const STATUS_REFRESH_MS = 60 * 60 * 1000;

/** localStorage, or null where reading the global itself throws (storage disabled, sandboxed frame). */
const browserStorage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * Toast for a server behind its branch on GitHub that can update itself (spec
 * 2026-11-13-self-update-design.md). Read on mount, on a connection switch or reconnect, and
 * hourly; only while connected, so a signed-out or unreachable server is never asked. Dismissing
 * it (or opening Settings from it) hides it for that branch head on that server until a newer
 * commit lands; timing out hides it for this page only.
 *
 * Positioning belongs to {@link ToastStack} — this renders only its card.
 */
export const UpdateAvailableToast: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  const connectionId = useAppStore((s) => s.activeConnectionId);
  const openSettings = useAppStore((s) => s.openSettings);
  const [loaded, setLoaded] = useState<{ connectionId: string; status: SelfUpdateStatusResponse } | null>(null);
  /** `<connection>\0<latest>` hidden for this page: dismissed (also persisted) or timed out. */
  const [hidden, setHidden] = useState<string | null>(null);

  useEffect(() => {
    if (!api || !connected || !connectionId) return;
    const controller = new AbortController();
    const load = () =>
      api
        .selfUpdateStatus(controller.signal)
        .then((status) => setLoaded({ connectionId, status }))
        .catch(() => {
          /* offline, or an older daemon without the route: no toast */
        });
    void load();
    const timer = setInterval(() => void load(), STATUS_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, connected, connectionId]);

  const latest = connected && loaded && loaded.connectionId === connectionId ? updateToastKey(loaded.status) : null;
  const storage = browserStorage();
  const persisted = latest && connectionId && storage ? readDismissedUpdate(storage, connectionId) : null;
  const visibleKey = latest && connectionId && latest !== persisted ? `${connectionId}\u0000${latest}` : null;

  const hide = useCallback(() => setHidden(visibleKey), [visibleKey]);
  const dismiss = useCallback(() => {
    if (connectionId && latest && storage) writeDismissedUpdate(storage, connectionId, latest);
    setHidden(visibleKey);
  }, [connectionId, latest, storage, visibleKey]);
  const shown = visibleKey !== null && visibleKey !== hidden;
  useAutoDismiss(shown ? visibleKey : null, hide, ACTION_TOAST_AUTO_DISMISS_MS);

  if (!shown || !loaded) {
    return null;
  }
  const { behindBy, branch } = loaded.status;

  return (
    <div className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border border-neutral-700 bg-neutral-900/95 py-2 pl-3 pr-2 text-sm shadow-xl shadow-black/40 backdrop-blur">
      <CircleArrowUp size={16} className="mt-0.5 shrink-0 text-info" />
      <div className="min-w-0 text-neutral-200">
        <div className="font-medium">Orquester is out of date</div>
        <div className="text-[12px] text-neutral-400">
          {behindBy} commit{behindBy === 1 ? "" : "s"} behind {branch}. Update it from Settings.
        </div>
        <button
          type="button"
          onClick={() => {
            dismiss();
            openSettings("general");
          }}
          className="mt-1.5 rounded border border-neutral-700 px-2 py-1 text-[12px] text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
        >
          Open settings
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
