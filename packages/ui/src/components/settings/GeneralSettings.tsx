import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { SelfUpdateStatusResponse } from "@orquester/api";
import { Bell, Download, Loader2, RefreshCw } from "lucide-react";
import { disablePush, enablePush, getSubscription, pushSupported } from "../../lib/push";
import { Button, Switch } from "../ui";
import { useApi, useOrquester } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { serverVersionLabel } from "../../lib/server-version";
import { ApiError } from "../../lib/api-client";
import { relativeTime } from "../../lib/relative-time";
import { lastRunFailure, nextUpdatePhase, type FollowedRequest } from "../../lib/self-update.logic";
import type { Runtime } from "../../types";
import {
  Badge,
  InfoRow,
  Notice,
  SettingRow,
  SettingsCard,
  SettingsPage,
  SettingsSection,
  type Tone
} from "./primitives";

/**
 * True when the web client runs as an installed PWA rather than in a browser
 * tab — `display-mode: standalone` everywhere, `navigator.standalone` on iOS.
 */
const isInstalledPwa = (): boolean => {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
};

// Force the web client to pull the freshly deployed bundle. Pull-to-refresh is
// disabled app-wide (it was reloading the SPA on terminal scroll), so an
// installed PWA left open has no gesture to refresh itself. Nudge the service
// worker to re-check for a new version, then reload — navigations are
// network-first and assets are content-hashed, so this lands on the latest.
const reloadApp = async (): Promise<void> => {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* SW unsupported/blocked — the reload below still refreshes the shell */
  }
  window.location.reload();
};

const runtimeLabel = (runtime: Runtime): string =>
  runtime === "desktop" ? "Desktop app" : isInstalledPwa() ? "Web app (installed)" : "Web browser";

export const GeneralSettings: React.FC = () => {
  const { runtime, desktopHost } = useOrquester();
  const appConfig = useAppStore((s) => s.appConfig);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const connections = useAppStore((s) => s.connections);
  const activeId = useAppStore((s) => s.activeConnectionId);
  const active = connections.find((c) => c.id === activeId);
  const [reloading, setReloading] = useState(false);

  return (
    <SettingsPage title="General" description="How the app window behaves, what notifies you, and what you're connected to.">
      <SettingsSection title="Window & tabs">
        <SettingRow
          label="Confirm before closing a session"
          description="Closing an agent or terminal tab ends its running session."
        >
          <Switch
            label="Confirm before closing a session"
            checked={appConfig.confirmCloseSession}
            onChange={(checked) => void updateAppConfig({ confirmCloseSession: checked })}
          />
        </SettingRow>
        {runtime === "desktop" && (
          <SettingRow
            label="Run in background"
            description="Closing the window keeps the daemon running in the tray."
          >
            <Switch
              label="Run in background"
              checked={appConfig.runInBackground}
              onChange={(checked) => void updateAppConfig({ runInBackground: checked })}
            />
          </SettingRow>
        )}
        {/* Only the desktop runtime has native window controls to replace. */}
        {runtime === "desktop" && (
          <SettingRow
            label="Custom titlebar"
            description={
              // macOS keeps its hidden titlebar and traffic lights either way;
              // elsewhere the window's frame changes, which needs a new window.
              desktopHost?.platform === "darwin"
                ? "In-app window controls in the top bar."
                : "Frameless window with in-app window controls. The window reopens to apply a change."
            }
          >
            <Switch
              label="Custom titlebar"
              checked={appConfig.useTitlebar}
              // Saved first: the shell reads the setting back from app.json
              // when it decides whether to rebuild the window.
              onChange={(checked) =>
                void updateAppConfig({ useTitlebar: checked }).then(() => desktopHost?.titlebarChanged?.())
              }
            />
          </SettingRow>
        )}
      </SettingsSection>

      {runtime === "web" ? <NotificationsSection /> : <DesktopNotificationsSection />}

      <SettingsSection title="About">
        <InfoRow label="Runtime" value={runtimeLabel(runtime)} />
        <InfoRow
          label="Connected server"
          value={
            active ? (
              <span className="inline-flex max-w-full items-center gap-2">
                <span className="truncate">{active.name}</span>
                <Badge tone={active.kind === "local" ? "neutral" : "info"}>
                  {active.kind === "local" ? "Local" : "Remote"}
                </Badge>
              </span>
            ) : (
              <span className="text-neutral-500">Not connected</span>
            )
          }
        />
        {active && <ServerVersionRow key={active.id} />}
        {active && <UpdatesRow key={active.id} connectionId={active.id} />}
        {runtime === "web" && (
          <SettingRow
            label="Reload app"
            description="Fetch the latest version if the app looks out of date after an update."
          >
            <Button
              size="sm"
              variant="outline"
              disabled={reloading}
              onClick={() => {
                setReloading(true);
                void reloadApp();
              }}
            >
              {reloading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Reload
            </Button>
          </SettingRow>
        )}
      </SettingsSection>
    </SettingsPage>
  );
};

/**
 * Desktop: the shell's system notifications for the daemon's pushes and the
 * dock/taskbar badge (`components/attention/DesktopHostBridge.tsx`). A shell
 * whose preload has no notification bridge says so instead of a dead switch.
 */
const DesktopNotificationsSection: React.FC = () => {
  const { desktopHost } = useOrquester();
  const enabled = useAppStore((s) => s.appConfig.desktopNotifications);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const supported = typeof desktopHost?.notify === "function";
  return (
    <SettingsSection title="Notifications">
      <SettingRow
        label="Desktop notifications"
        description={
          supported
            ? "Notify when an agent needs you, finishes, has a plan ready or messages you, and when a workflow run ends — not for the session you're looking at. The app icon's badge counts sessions waiting on you."
            : "This version of the desktop app can't show notifications. Update the app to turn them on."
        }
      >
        {supported ? (
          <Switch
            label="Desktop notifications"
            checked={enabled}
            onChange={(checked) => void updateAppConfig({ desktopNotifications: checked })}
          />
        ) : (
          <Badge>Unavailable</Badge>
        )}
      </SettingRow>
    </SettingsSection>
  );
};

/** Web only; a browser without push gets an explanation instead of a dead switch. */
const NotificationsSection: React.FC = () => {
  const supported = pushSupported();
  return (
    <SettingsSection title="Notifications" bare>
      {supported ? (
        <PushNotificationsField />
      ) : (
        <SettingsCard>
          <SettingRow
            label="Push notifications"
            description="This browser can't receive web push. On iPhone and iPad, add the app to your Home Screen first."
          >
            <Badge>Unavailable</Badge>
          </SettingRow>
        </SettingsCard>
      )}
    </SettingsSection>
  );
};

/** The connected daemon's commit (`GET /api/info`), which is its version; hidden when it reports none. */
const ServerVersionRow: React.FC = () => {
  const api = useApi();
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api
      .info(controller.signal)
      .then((info) => setLabel(serverVersionLabel(info)))
      .catch(() => {
        /* offline or an older daemon: no row */
      });
    return () => controller.abort();
  }, [api]);
  return label ? <InfoRow label="Server version" value={label} mono /> : null;
};

/**
 * The update this client follows: started here, or found running when the Updates row loaded.
 * Module state rather than the row's, so closing Settings mid-update keeps the poll going and the
 * page still reloads onto the new release. The poll ends when the active connection changes.
 */
interface FollowedUpdate {
  connectionId: string;
  request: FollowedRequest;
  /**
   * "updating" and "stalled" (the host updater has not taken the request yet) keep polling; the
   * others are final. "timedOut": nothing settled within {@link UPDATE_GIVE_UP_MS}.
   */
  phase: "updating" | "stalled" | "failed" | "reverted" | "timedOut";
  /** Identifies one follow: a newer one (another request) ends the older one's poll. */
  token: object;
}

const UPDATE_POLL_MS = 3_000;
/** One poll's own limit: a request to a daemon that is mid-restart may hang rather than fail. */
const UPDATE_POLL_TIMEOUT_MS = 10_000;
/**
 * Stop waiting after this: longer than the host updater's own 2 h limit would be pointless, and a
 * real update (builds, health wait, even a revert) is far shorter — the server is down or stuck.
 */
const UPDATE_GIVE_UP_MS = 60 * 60 * 1000;

let followedUpdate: FollowedUpdate | null = null;
const followedUpdateListeners = new Set<() => void>();

const setFollowedUpdate = (next: FollowedUpdate | null): void => {
  followedUpdate = next;
  for (const listener of [...followedUpdateListeners]) listener();
};

const subscribeFollowedUpdate = (listener: () => void): (() => void) => {
  followedUpdateListeners.add(listener);
  return () => {
    followedUpdateListeners.delete(listener);
  };
};

const getFollowedUpdate = (): FollowedUpdate | null => followedUpdate;

/**
 * Poll the server's update status until it runs another commit or this update's run succeeds (then
 * reload), the run fails or reverts, or {@link UPDATE_GIVE_UP_MS} passes. A request the host updater
 * has not taken shows as "stalled" while the poll goes on, so fixing the updater still finishes it.
 * Following the update already followed is a no-op; another request replaces the follow.
 */
const followUpdate = (connectionId: string, request: FollowedRequest): void => {
  const current = followedUpdate;
  if (
    current &&
    current.connectionId === connectionId &&
    current.request.requestedAt === request.requestedAt &&
    (current.phase === "updating" || current.phase === "stalled")
  ) {
    return;
  }
  const token = {};
  const giveUpAt = Date.now() + UPDATE_GIVE_UP_MS;
  setFollowedUpdate({ connectionId, request, phase: "updating", token });
  const settle = (phase: FollowedUpdate["phase"]): void => {
    if (followedUpdate?.token === token && followedUpdate.phase !== phase) setFollowedUpdate({ ...followedUpdate, phase });
  };
  const poll = async (): Promise<void> => {
    if (followedUpdate?.token !== token) return;
    const { api, activeConnectionId } = useAppStore.getState();
    if (activeConnectionId !== connectionId) {
      setFollowedUpdate(null);
      return;
    }
    // The store rebuilds its client on every reconnect, so each poll takes the current one.
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(UPDATE_POLL_TIMEOUT_MS) : undefined;
    const status = api ? await api.selfUpdateStatus(signal).catch(() => null) : null;
    if (followedUpdate?.token !== token || useAppStore.getState().activeConnectionId !== connectionId) return;
    const phase = nextUpdatePhase(request, status);
    if (phase === "done") {
      void reloadApp();
    } else if (phase === "failed" || phase === "reverted") {
      settle(phase);
    } else if (Date.now() >= giveUpAt) {
      settle("timedOut");
    } else {
      settle(phase === "stalled" ? "stalled" : "updating");
      setTimeout(() => void poll(), UPDATE_POLL_MS);
    }
  };
  setTimeout(() => void poll(), UPDATE_POLL_MS);
};

const errorText = (err: unknown): string =>
  err instanceof ApiError ? (err.serverMessage ?? err.message) : err instanceof Error ? err.message : String(err);

const commitsBehind = (status: SelfUpdateStatusResponse): string =>
  `${status.behindBy} commit${status.behindBy === 1 ? "" : "s"} behind ${status.branch}`;

/**
 * Whether the server is behind its branch on GitHub (`GET /api/self-update`) and, on an install
 * that can update itself, the Update button. Hidden for an older daemon without the route.
 */
const UpdatesRow: React.FC<{ connectionId: string }> = ({ connectionId }) => {
  const api = useAppStore((s) => s.api);
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  const followed = useSyncExternalStore(subscribeFollowedUpdate, getFollowedUpdate, getFollowedUpdate);
  const mine = followed?.connectionId === connectionId ? followed : null;
  const [status, setStatus] = useState<SelfUpdateStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!api || !connected) return;
    const controller = new AbortController();
    api
      .selfUpdateStatus(controller.signal)
      .then((next) => {
        setStatus(next);
        setLoadError(null);
        // Someone started an update elsewhere: follow it here too, so this page reloads with it.
        if (next.run?.state === "running" && next.current) {
          followUpdate(connectionId, { from: next.current, requestedAt: next.run.startedAt });
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setLoadError(errorText(err));
      });
    return () => controller.abort();
  }, [api, connected, connectionId]);

  const start = async (from: string) => {
    if (!api) return;
    setStarting(true);
    setStartError(null);
    try {
      const { requestedAt } = await api.startSelfUpdate();
      followUpdate(connectionId, { from, requestedAt });
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: unknown } | null | undefined)?.code : undefined;
      const requestedAt = err instanceof ApiError ? (err.body as { requestedAt?: unknown } | null | undefined)?.requestedAt : undefined;
      if (code === "SELF_UPDATE_BUSY" && typeof requestedAt === "string" && Number.isFinite(Date.parse(requestedAt))) {
        // Already running or requested elsewhere: wait for that update like our own.
        followUpdate(connectionId, { from, requestedAt });
      } else {
        setStartError(errorText(err));
      }
    } finally {
      setStarting(false);
    }
  };

  // Still waiting on the followed update (a stalled request included: it may yet be taken).
  const updating = mine?.phase === "updating";
  const stalled = mine?.phase === "stalled";
  if (missing || (!connected && !updating)) return null;

  let description: React.ReactNode;
  if (updating) {
    description = "Updating… The server restarts and this page reloads when it's done.";
  } else if (stalled) {
    description = "Waiting for the server's updater to take the request… This page reloads when the update is done.";
  } else if (!status) {
    description = loadError ? `Couldn't check for updates: ${loadError}` : "Checking for updates…";
  } else if (status.error && !status.checkedAt) {
    description = `Couldn't check for updates: ${status.error}`;
  } else if (!status.checkedAt) {
    description = "Not checked yet.";
  } else if (status.behindBy > 0) {
    description = status.canUpdate
      ? `${commitsBehind(status)}.`
      : `${commitsBehind(status)}. Update this server with ./deploy.sh deploy.`;
  } else {
    const checked = relativeTime(status.checkedAt);
    description = checked ? `Up to date · checked ${checked}` : "Up to date";
  }

  const from = status?.current ?? null;
  // This client's followed update, or else what the server reports: a request its updater never
  // took, or the last run's failure while the server still runs the commit it started from.
  const outcome: Exclude<FollowedUpdate["phase"], "updating"> | null =
    mine && mine.phase !== "updating"
      ? mine.phase
      : !updating && status
        ? status.requestStalled
          ? "stalled"
          : lastRunFailure(status)
        : null;
  const canStart = !updating && !!status?.canUpdate && status.behindBy > 0 && !!from;
  const journal = (
    <>
      Details: <code>journalctl -u orquester-update</code> on the server.
    </>
  );

  return (
    <>
      <SettingRow label="Updates" description={description}>
        {updating ? (
          <Badge tone="info" icon={<Loader2 size={11} className="animate-spin" />}>
            Updating
          </Badge>
        ) : (
          canStart &&
          from && (
            <Button size="sm" variant="outline" disabled={starting} onClick={() => void start(from)}>
              {starting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Update
            </Button>
          )
        )}
      </SettingRow>
      {(outcome || startError) && (
        <div className="px-4 py-3">
          {startError ? (
            <Notice tone="danger" title="Couldn't start the update">
              {startError}
            </Notice>
          ) : outcome === "reverted" ? (
            <Notice tone="warn" title="The update failed and the previous version was restored">
              {journal}
            </Notice>
          ) : outcome === "stalled" ? (
            <Notice tone="warn" title="The server's updater didn't start the update">
              Check <code>systemctl status orquester-update.path</code> on the server, then try again.
            </Notice>
          ) : outcome === "timedOut" ? (
            <Notice tone="warn" title="The update hasn't finished after an hour">
              The server may be down or the update stuck. {journal}
            </Notice>
          ) : (
            <Notice tone="danger" title="The update failed">
              {journal}
            </Notice>
          )}
        </div>
      )}
    </>
  );
};

/**
 * Web-push opt-in. Mounted only when `runtime === "web" && pushSupported()`, so
 * the desktop never mounts it. The switch reflects the live `PushSubscription`
 * presence (the single global notification preference), loaded async on mount.
 */
const PushNotificationsField: React.FC = () => {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const [denied, setDenied] = useState(
    typeof Notification !== "undefined" && Notification.permission === "denied"
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: Exclude<Tone, "neutral">; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Load the live subscription state on mount.
  useEffect(() => {
    let active = true;
    getSubscription()
      .then((sub) => {
        if (active) setEnabled(!!sub);
      })
      .catch(() => {
        /* leave disabled */
      });
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setStatus(null);
    // Optimistic; revert on failure.
    setEnabled(next);
    try {
      if (next) {
        await enablePush(api);
        setDenied(false);
      } else {
        await disablePush(api);
      }
    } catch (err) {
      setEnabled(!next);
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        setDenied(true);
      }
      setStatus({ tone: "danger", text: err instanceof Error ? err.message : "Could not update notifications." });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const res = await api.pushTest();
      setStatus(
        res.sent > 0
          ? { tone: "ok", text: `Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"}.` }
          : { tone: "warn", text: "No devices subscribed." }
      );
    } catch (err) {
      setStatus({ tone: "danger", text: err instanceof Error ? err.message : "Could not send a test notification." });
    } finally {
      setTesting(false);
    }
  };

  const on = enabled && !denied;

  return (
    <>
      <SettingsCard>
        <SettingRow
          label="Push notifications"
          description="Get a push on this device when an agent session needs your attention."
        >
          {on && (
            <Button size="sm" variant="ghost" disabled={testing} onClick={() => void sendTest()}>
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Bell size={13} />} Send test
            </Button>
          )}
          {denied && <Badge tone="warn">Blocked</Badge>}
          <Switch
            label="Push notifications"
            checked={on}
            disabled={busy || denied}
            onChange={(v) => void toggle(v)}
          />
        </SettingRow>
      </SettingsCard>
      {denied ? (
        <Notice tone="warn" title="Notifications are blocked">
          Allow them for this site in your browser's settings, then turn this on.
        </Notice>
      ) : (
        status && <Notice tone={status.tone}>{status.text}</Notice>
      )}
    </>
  );
};
