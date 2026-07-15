import React from "react";
import { ConfirmDialog } from "../ui";
import { useAppStore } from "../../store/app";

/**
 * The single close-confirm prompt for live session tabs. State lives in the
 * store (`pendingCloseTabId`) so every entry point — tab "x", context menu,
 * grid cell, mobile switcher — shares one dialog. Gated by
 * `appConfig.confirmCloseSession` inside `requestCloseTab`.
 */
export const CloseSessionConfirm: React.FC = () => {
  const pendingId = useAppStore((s) => s.pendingCloseTabId);
  const title = useAppStore((s) =>
    s.pendingCloseTabId ? s.sessions.find((x) => x.id === s.pendingCloseTabId)?.title ?? null : null
  );
  const confirmCloseTab = useAppStore((s) => s.confirmCloseTab);
  const cancelCloseTab = useAppStore((s) => s.cancelCloseTab);

  return (
    <ConfirmDialog
      open={pendingId !== null}
      title="Close session"
      message={
        <>
          Close <span className="text-neutral-200">{title ?? "this session"}</span>? This ends the
          running session and can’t be undone.
        </>
      }
      confirmLabel="Close"
      danger
      onCancel={cancelCloseTab}
      onConfirm={confirmCloseTab}
    />
  );
};
