/**
 * Settings → Devices (devices spec §10.5): the "Device simulators" plugin's own page. This first
 * version shows the platforms' switches, each host's readiness checklist and the agents' access,
 * from the devices store (`lib/devices`); install/repair with live progress, the Mac host budget,
 * current hosts with cost and Destroy, and the pinned tools build on it.
 */

import React from "react";

import { DEVICE_PLATFORM_LABELS, type DeviceHostSummary, type DevicePlatform, type DevicesSettingsPatch } from "@orquester/api";

import { useDeviceHosts, useDevicesEnabled, useDevicesLoaded, useDevicesSettings, useDeviceSetupJob } from "../../lib/devices/hooks";
import { loadDevices, updateDevicesSettings } from "../../lib/devices/store";
import { useAppStore } from "../../store/app";
import { Switch } from "../ui/switch";
import { Badge, Notice, SettingRow, SettingsPage, SettingsSection } from "./primitives";

const errorText = (err: unknown): string => {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
};

const READINESS_TONE = { ok: "ok", missing: "warn", error: "danger", working: "info" } as const;

/** One host's readiness checklist. */
const ReadinessList: React.FC<{ host: DeviceHostSummary }> = ({ host }) => (
  <>
    {host.readiness.checks.map((check) => (
      <SettingRow key={check.id} label={check.label} description={check.detail ?? undefined}>
        <Badge tone={READINESS_TONE[check.state]}>{check.state === "ok" ? "OK" : check.state === "working" ? "Working…" : check.state === "error" ? "Error" : "Missing"}</Badge>
      </SettingRow>
    ))}
  </>
);

const SetupProgress: React.FC<{ platform: DevicePlatform }> = ({ platform }) => {
  const job = useDeviceSetupJob(platform);
  if (!job || job.state === "done") return null;
  return (
    <SettingRow
      label={job.state === "running" ? `Setting up… ${job.percent ?? 0}%` : job.state === "failed" ? "Setup failed" : "Setup cancelled"}
      description={job.error ?? job.logLine ?? undefined}
    />
  );
};

export const DevicesSettings: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const openSettings = useAppStore((s) => s.openSettings);
  const enabled = useDevicesEnabled();
  const loaded = useDevicesLoaded();
  const settings = useDevicesSettings();
  const hosts = useDeviceHosts();
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (enabled && api && !loaded) void loadDevices(api).catch((err) => setError(errorText(err)));
  }, [enabled, api, loaded]);

  const save = (patch: DevicesSettingsPatch) => {
    if (!api) return;
    setSaving(true);
    setError(null);
    void updateDevicesSettings(api, patch)
      .catch((err) => setError(errorText(err)))
      .finally(() => setSaving(false));
  };

  if (!enabled) {
    return (
      <SettingsPage title="Devices" description="iOS simulators and Android emulators beside your chats.">
        <Notice
          tone="info"
          title="Device simulators is off"
          action={
            <button type="button" className="text-xs text-neutral-200 underline" onClick={() => openSettings("plugins")}>
              Open Plugins
            </button>
          }
        >
          Turn the plugin on in Settings → Plugins to run devices.
        </Notice>
      </SettingsPage>
    );
  }

  const hostsFor = (platform: DevicePlatform) => hosts.filter((host) => host.platforms.includes(platform));

  return (
    <SettingsPage title="Devices" description="iOS simulators and Android emulators beside your chats; agents drive them and you watch live.">
      {error && <Notice tone="danger">{error}</Notice>}
      {!settings ? (
        <Notice tone="info">Loading…</Notice>
      ) : (
        <>
          {(["android", "ios"] as const).map((platform) => (
            <SettingsSection
              key={platform}
              title={platform === "android" ? "Android on this host" : `${DEVICE_PLATFORM_LABELS.ios} (Mac hosts)`}
              description={
                platform === "android"
                  ? "Emulators run on this machine (Linux with KVM)."
                  : "Simulators run on rented macOS boxes, shared by every chat."
              }
            >
              <SettingRow label={`Enable ${DEVICE_PLATFORM_LABELS[platform]}`}>
                <Switch
                  checked={settings[platform].enabled}
                  disabled={saving}
                  label={`Enable ${DEVICE_PLATFORM_LABELS[platform]}`}
                  onChange={(on) => save({ [platform]: { enabled: on } })}
                />
              </SettingRow>
              {platform === "ios" && (
                <SettingRow label="Mac host" description={`${settings.ios.provider} · ${settings.ios.size}`}>
                  <Badge>{settings.ios.rentWithoutAsking ? "Rents without asking" : "Asks before renting"}</Badge>
                </SettingRow>
              )}
              {hostsFor(platform).map((host) => (
                <React.Fragment key={host.id}>
                  <SettingRow label={host.label} description={host.statusDetail ?? undefined}>
                    <Badge tone={host.status === "ready" ? "ok" : host.status === "failed" ? "danger" : "neutral"}>{host.status}</Badge>
                  </SettingRow>
                  <ReadinessList host={host} />
                </React.Fragment>
              ))}
              <SetupProgress platform={platform} />
            </SettingsSection>
          ))}
          <SettingsSection title="Agents">
            <SettingRow label="Let agents use devices" description="Agent chats get the device tools while a platform is enabled.">
              <Switch checked={settings.agents.enabled} disabled={saving} label="Let agents use devices" onChange={(on) => save({ agents: { enabled: on } })} />
            </SettingRow>
            <SettingRow label="Show the device when an agent opens one">
              <Switch
                checked={settings.agents.followAgentDevices}
                disabled={saving}
                label="Show the device when an agent opens one"
                onChange={(on) => save({ agents: { followAgentDevices: on } })}
              />
            </SettingRow>
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
};
