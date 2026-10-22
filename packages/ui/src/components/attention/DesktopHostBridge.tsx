import { useEffect, useMemo } from "react";

import {
  desktopBadgeCount,
  desktopNotificationFor,
  parseMenuAction,
  parseNotificationTarget,
  subscribePushNotifications,
  type DesktopHost
} from "../../lib/desktop-host";
import { openNotificationTarget, viewingSessionId } from "../../lib/desktop-host-nav";
import { useProjectIndex } from "../../lib/project-index";
import { useAppStore } from "../../store/app";
import { useAgentSessions, verifiedAgentSessions } from "./agent-sessions";

/**
 * The desktop shell's native side (`lib/desktop-host.ts`), mounted once when
 * the shell provides a host: the daemon's pushes become system notifications,
 * the dock/taskbar badge counts the sessions that need the user, a clicked
 * notification opens its session or workflow run, and the application menu's
 * Settings… opens Settings. Renders nothing.
 */
// Adapted from T3 Code (MIT): apps/web/src/components/ThreadNotificationCoordinator.tsx
export function DesktopHostBridge({ host }: { host: DesktopHost }): null {
  const enabled = useAppStore((s) => s.appConfig.desktopNotifications);
  const derived = useAgentSessions();
  const index = useProjectIndex();
  // Before the project index resolves, the store-derived list stands in (the
  // Opened Agents header does the same) rather than a fail-closed zero.
  const count = useMemo(
    () => desktopBadgeCount(index === null ? derived : verifiedAgentSessions(derived, index)),
    [derived, index]
  );
  const badge = enabled ? count : 0;

  useEffect(() => {
    host.setBadgeCount?.(badge);
  }, [host, badge]);
  useEffect(() => () => host.setBadgeCount?.(0), [host]);

  useEffect(() => {
    if (!host.notify) return;
    return subscribePushNotifications((event) => {
      const request = desktopNotificationFor(event, {
        enabled: useAppStore.getState().appConfig.desktopNotifications,
        windowFocused: document.visibilityState === "visible" && document.hasFocus(),
        viewingSessionId: viewingSessionId()
      });
      if (request) host.notify?.(request);
    });
  }, [host]);

  useEffect(
    () =>
      host.onNotificationOpen?.((raw) => {
        const target = parseNotificationTarget(raw);
        if (target) openNotificationTarget(target);
      }),
    [host]
  );

  useEffect(
    () =>
      host.onMenuAction?.((raw) => {
        if (parseMenuAction(raw) === "open-settings") useAppStore.getState().setSettingsOpen(true);
      }),
    [host]
  );

  return null;
}
