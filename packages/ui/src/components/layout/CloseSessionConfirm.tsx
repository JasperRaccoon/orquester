import React from "react";
import { ConfirmDialog } from "../ui";
import { useAppStore } from "../../store/app";
import { desktopCloseMessage } from "../../lib/desktop-state";

/**
 * The single close-confirm prompt for tabs whose close ends something running:
 * live sessions (gated by `appConfig.confirmCloseSession`) and desktops with
 * running apps (always; spec §10.6). State lives in the store
 * (`pendingCloseTabId`) so every entry point — tab "x", context menu, grid
 * cell, mobile switcher, a desktop's own toolbar — shares one dialog; the
 * title and body come from whichever tab is pending.
 */
export const CloseSessionConfirm: React.FC = () => {
  const pendingId = useAppStore((s) => s.pendingCloseTabId);
  const sessionTitle = useAppStore((s) =>
    s.pendingCloseTabId ? s.sessions.find((x) => x.id === s.pendingCloseTabId)?.title ?? null : null
  );
  const desktop = useAppStore((s) =>
    s.pendingCloseTabId ? s.desktops.find((d) => d.id === s.pendingCloseTabId) ?? null : null
  );
  const confirmCloseTab = useAppStore((s) => s.confirmCloseTab);
  const cancelCloseTab = useAppStore((s) => s.cancelCloseTab);

  return (
    <ConfirmDialog
      open={pendingId !== null}
      title={desktop ? "Stop desktop" : "Close session"}
      message={
        desktop ? (
          desktopCloseMessage(desktop)
        ) : (
          <>
            Close <span className="text-neutral-200">{sessionTitle ?? "this session"}</span>? This ends
            the running session and can’t be undone.
          </>
        )
      }
      confirmLabel={desktop ? "Stop" : "Close"}
      danger
      onCancel={cancelCloseTab}
      onConfirm={confirmCloseTab}
    />
  );
};
