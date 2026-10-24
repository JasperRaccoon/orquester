/**
 * Mounted once by the app shell: opens the session a push notification was
 * about (`lib/session-deep-link.ts`: the service worker's message, or
 * `/?session=<id>` on a cold start) once the app is connected — its tab, in
 * its own project, through the same "go there" navigation the Attention
 * Center's cards use (`jumpToProject`, which `focusAgentSession` wraps; a
 * notification may name any session, not only an agent's). A session that is
 * gone, or whose project the archived curtain hides, says so instead.
 */

import React, { useEffect, useRef, useSyncExternalStore } from "react";

import { useApi } from "../../context/orquester-context";
import { jumpToProject } from "../../lib/session-nav";
import {
  pendingSessionDeepLink,
  requestSessionDeepLink,
  resolveSessionDeepLink,
  subscribeSessionDeepLink,
  takeSessionDeepLink
} from "../../lib/session-deep-link";
import { useAppStore } from "../../store/app";
import { setMobileSection } from "../right-rail/mobile-section";

export const SessionDeepLinkHost: React.FC = () => {
  const pending = useSyncExternalStore(subscribeSessionDeepLink, pendingSessionDeepLink, () => null);
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const api = useApi();
  /** Bumped per link taken: a newer tap supersedes one still resolving. */
  const generation = useRef(0);

  useEffect(() => {
    if (!pending || !connected) return;
    const link = takeSessionDeepLink();
    if (!link) return;
    const mine = ++generation.current;
    const stale = (): boolean => mine !== generation.current || useAppStore.getState().api !== api;
    void (async () => {
      try {
        const target = await resolveSessionDeepLink(api, link.sessionId);
        if (stale()) return;
        if (target.kind === "gone") {
          useAppStore.getState().setNotice({ message: target.message });
          return;
        }
        // On a cold start the store may not hold the session yet: its tab needs it.
        if (!useAppStore.getState().sessions.some((session) => session.id === target.sessionId)) {
          await useAppStore.getState().loadSessions();
          if (stale()) return;
        }
        jumpToProject({ project: target.project, sessionId: target.sessionId });
        // A phone shows the tab itself: not the drawer, not a section over it.
        useAppStore.getState().setSidebarDrawer(false);
        setMobileSection(null);
      } catch {
        if (stale()) return;
        // The connection dropped mid-way: try again once it is back (unless a newer tap is waiting).
        if (useAppStore.getState().connectionStatus !== "connected") {
          if (!pendingSessionDeepLink()) requestSessionDeepLink(link);
          return;
        }
        useAppStore.getState().setNotice({ message: "Couldn't open that session." });
      }
    })();
  }, [pending, connected, api]);

  return null;
};
