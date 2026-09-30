import React, { useEffect, useState } from "react";
import { Bell, Loader2, RefreshCw } from "lucide-react";
import { disablePush, enablePush, getSubscription, pushSupported } from "../../lib/push";
import { Button, Switch } from "../ui";
import { useApi, useOrquester } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
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

const runtimeLabel = (runtime: Runtime): string =>
  runtime === "desktop" ? "Desktop app" : isInstalledPwa() ? "Web app (installed)" : "Web browser";

export const GeneralSettings: React.FC = () => {
  const { runtime } = useOrquester();
  const appConfig = useAppStore((s) => s.appConfig);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const connections = useAppStore((s) => s.connections);
  const activeId = useAppStore((s) => s.activeConnectionId);
  const active = connections.find((c) => c.id === activeId);
  const [reloading, setReloading] = useState(false);

  // Force the web client to pull the freshly deployed bundle. Pull-to-refresh is
  // disabled app-wide (it was reloading the SPA on terminal scroll), so an
  // installed PWA left open has no gesture to refresh itself. Nudge the service
  // worker to re-check for a new version, then reload — navigations are
  // network-first and assets are content-hashed, so this lands on the latest.
  const reloadApp = async () => {
    setReloading(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      /* SW unsupported/blocked — the reload below still refreshes the shell */
    }
    window.location.reload();
  };

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
          <SettingRow label="Custom titlebar" description="Frameless window with in-app window controls.">
            <Switch
              label="Custom titlebar"
              checked={appConfig.useTitlebar}
              onChange={(checked) => void updateAppConfig({ useTitlebar: checked })}
            />
          </SettingRow>
        )}
      </SettingsSection>

      {runtime === "web" && <NotificationsSection />}

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
        {runtime === "web" && (
          <SettingRow
            label="Reload app"
            description="Fetch the latest version if the app looks out of date after an update."
          >
            <Button size="sm" variant="outline" disabled={reloading} onClick={() => void reloadApp()}>
              {reloading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Reload
            </Button>
          </SettingRow>
        )}
      </SettingsSection>
    </SettingsPage>
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
