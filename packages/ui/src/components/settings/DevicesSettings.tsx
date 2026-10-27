/**
 * Settings → Devices (devices spec §10.5): the "Device simulators" plugin's own page.
 *
 * - **Android on this host**: the readiness checklist with Install all / Repair and per-item fixes,
 *   the live setup job (steps, percent, log line), the SDK licence notice, profiles, capacity.
 * - **iPhone & iPad (Mac hosts)**: the box provider (Blacksmith, set up in the Ephemeral AI VMs
 *   plugin), size with its price, lifetime, idle teardown, renting without asking with a monthly
 *   cap, profiles, and the Mac hosts running now with their cost and Destroy.
 * - **Agents**: the toolset, following the agent, lease idle time and devices per chat.
 * - **Tools**: the pinned tools' installed versions.
 * - **Fleet (preview)**: the phase 2 pool settings, collapsed.
 *
 * Every change is one `updateDevicesSettings` patch (pure builders in `devices-settings.logic.ts`);
 * only the control being saved is disabled, and nothing changes until the daemon answers.
 */

import React from "react";
import {
  Apple,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  MinusCircle,
  Package,
  Server,
  Smartphone,
  Trash2,
  Wrench,
  XCircle
} from "lucide-react";

import {
  DEVICE_PLACEMENT_MODES,
  DEVICE_PLATFORM_LABELS,
  DEVICES_SETTINGS_LIMITS,
  deviceProfilesFor,
  isBoxProviderId,
  type BoxSizeOffer,
  type DeviceHostSummary,
  type DevicePlacementMode,
  type DevicePlatform,
  type DevicesSettings as DevicesSettingsValue,
  type DevicesSettingsPatch
} from "@orquester/api";

import { cn } from "../../lib/cn";
import { formatHourlyRate } from "../../lib/boxes/format";
import { useBoxesEnabled, useNow, useOpenBoxesSettings } from "../../lib/boxes/hooks";
import { loadBoxOffers, loadBoxProviders, useBoxProviders } from "../../lib/boxes/store";
import { useDeviceHosts, useDevicesEnabled, useDevicesLoaded, useDevicesSettings, useDevicesState, useDeviceSetupJob } from "../../lib/devices/hooks";
import { loadDevices, startDeviceSetup, updateDevicesSettings } from "../../lib/devices/store";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog, Input } from "../ui";
import { Switch } from "../ui/switch";
import {
  fixLabel,
  macHosts,
  macHostView,
  noMacHostText,
  nullableText,
  parseSettingNumber,
  PLACEMENT_HINTS,
  PLACEMENT_LABELS,
  profilesPatch,
  READINESS_BADGE,
  readinessSummary,
  setupJobView,
  toolRows,
  type NumberLimits,
  type SetupStepIcon
} from "./devices-settings.logic";
import { Badge, EmptyState, Notice, SegmentedControl, SettingRow, SettingsPage, SettingsSection } from "./primitives";

const ANDROID_LICENCE_URL = "https://developer.android.com/studio/terms";

const errorText = (err: unknown): string => {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
};

const selectClass =
  "h-7 min-w-0 max-w-full rounded-md border border-neutral-700 bg-neutral-900 px-1.5 text-base text-neutral-100 disabled:opacity-50 sm:text-xs";

/** What the page's controls share: the saver, and which control is saving now. */
interface SaveContext {
  saving: string | null;
  save: (key: string, patch: DevicesSettingsPatch) => void;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** A number setting: typed freely, saved on blur or Enter once valid and changed. */
const NumberField: React.FC<{
  id: string;
  label: string;
  value: number;
  limits: NumberLimits;
  integer?: boolean;
  suffix?: string;
  prefix?: string;
  disabled?: boolean;
  ctx: SaveContext;
  patch: (value: number) => DevicesSettingsPatch;
}> = ({ id, label, value, limits, integer = true, suffix, prefix, disabled, ctx, patch }) => {
  const [text, setText] = React.useState(String(value));
  const [error, setError] = React.useState<string | null>(null);
  const editing = React.useRef(false);
  React.useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);
  const commit = () => {
    editing.current = false;
    const parsed = parseSettingNumber(text, limits, { integer });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    if (parsed.value !== value) ctx.save(id, patch(parsed.value));
  };
  const busy = ctx.saving === id;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {prefix && <span className="text-xs text-neutral-500">{prefix}</span>}
        <Input
          id={`devices-${id}`}
          aria-label={label}
          aria-invalid={error !== null}
          inputMode={integer ? "numeric" : "decimal"}
          className={cn("h-7 w-20 text-right text-xs tabular-nums", error && "border-danger")}
          value={text}
          disabled={disabled || busy}
          onChange={(event) => {
            editing.current = true;
            setText(event.target.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              editing.current = false;
              setText(String(value));
              setError(null);
            }
          }}
        />
        {suffix && <span className="text-xs text-neutral-500">{suffix}</span>}
        {busy && <Loader2 size={12} className="animate-spin text-neutral-500" aria-label="Saving" />}
      </div>
      {error && (
        <span role="alert" className="text-[11px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
};

/** A nullable text setting (blank: none), saved on blur or Enter. */
const TextField: React.FC<{
  id: string;
  label: string;
  value: string | null;
  placeholder: string;
  disabled?: boolean;
  ctx: SaveContext;
  patch: (value: string | null) => DevicesSettingsPatch;
}> = ({ id, label, value, placeholder, disabled, ctx, patch }) => {
  const [text, setText] = React.useState(value ?? "");
  React.useEffect(() => setText(value ?? ""), [value]);
  const commit = () => {
    const next = nullableText(text);
    if (next !== value) ctx.save(id, patch(next));
  };
  return (
    <Input
      aria-label={label}
      className="h-7 w-48 text-xs"
      placeholder={placeholder}
      value={text}
      disabled={disabled || ctx.saving === id}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
};

const SettingSwitch: React.FC<{
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  ctx: SaveContext;
  patch: (on: boolean) => DevicesSettingsPatch;
}> = ({ id, label, checked, disabled, ctx, patch }) => (
  <Switch checked={checked} label={label} disabled={disabled || ctx.saving === id} onChange={(on) => ctx.save(id, patch(on))} />
);

/** The profiles a platform offers, each a switch-like chip. */
const ProfilesRow: React.FC<{ platform: DevicePlatform; settings: DevicesSettingsValue; disabled?: boolean; ctx: SaveContext }> = ({
  platform,
  settings,
  disabled,
  ctx
}) => {
  const chosen = new Set(settings[platform].profiles);
  const key = `${platform}.profiles`;
  return (
    <SettingRow
      label="Profiles"
      description={platform === "android" ? "The models an emulator is prepared for (one AVD each)." : "The models agents and the panel's picker offer."}
      stacked
    >
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${DEVICE_PLATFORM_LABELS[platform]} profiles`}>
        {deviceProfilesFor(platform).map((profile) => {
          const on = chosen.has(profile.id);
          return (
            <button
              key={profile.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled || ctx.saving === key}
              onClick={() => ctx.save(key, profilesPatch(settings, platform, profile.id, !on))}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50",
                on
                  ? "border-neutral-600 bg-neutral-800 text-neutral-100"
                  : "border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
              )}
            >
              {on ? <CheckCircle2 size={12} className="text-ok" /> : <Circle size={12} />}
              {profile.label}
              <span className="text-[10px] text-neutral-500">{profile.os}</span>
            </button>
          );
        })}
      </div>
    </SettingRow>
  );
};

// ---------------------------------------------------------------------------
// Readiness and setup
// ---------------------------------------------------------------------------

const STEP_ICON: Readonly<Record<SetupStepIcon, React.ReactNode>> = {
  pending: <Circle size={12} className="text-neutral-600" />,
  spinner: <Loader2 size={12} className="animate-spin text-info" />,
  done: <CheckCircle2 size={12} className="text-ok" />,
  failed: <XCircle size={12} className="text-danger" />,
  skipped: <MinusCircle size={12} className="text-neutral-600" />
};

/** The live install / repair: a bar, the steps, the latest log line. */
const SetupProgress: React.FC<{ platform: DevicePlatform }> = ({ platform }) => {
  const view = setupJobView(useDeviceSetupJob(platform));
  if (!view) return null;
  return (
    <div className="space-y-2.5 px-4 py-3.5" aria-live="polite" data-device-setup={platform}>
      <div className="flex items-center justify-between gap-3">
        <p className={cn("text-sm", view.running ? "text-neutral-200" : "text-danger")}>{view.title}</p>
        {view.running && <Loader2 size={14} className="animate-spin text-neutral-500" aria-hidden />}
      </div>
      {view.running && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-neutral-800"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(view.percent !== null ? { "aria-valuenow": view.percent } : {})}
        >
          <div
            className={cn("h-full rounded-full bg-neutral-300 transition-[width] duration-500", view.percent === null && "w-1/3 animate-pulse")}
            style={view.percent !== null ? { width: `${view.percent}%` } : undefined}
          />
        </div>
      )}
      {view.steps.length > 0 && (
        <ol className="space-y-1">
          {view.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0">{STEP_ICON[step.icon]}</span>
              <span className={cn(step.icon === "pending" || step.icon === "skipped" ? "text-neutral-500" : "text-neutral-300")}>{step.label}</span>
              {step.detail && <span className="min-w-0 truncate text-neutral-500">{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {view.logLine && (
        <p className="truncate rounded-md bg-neutral-950/60 px-2 py-1 font-mono text-[11px] text-neutral-400" title={view.logLine}>
          {view.logLine}
        </p>
      )}
      {view.error && <Notice tone="danger">{view.error}</Notice>}
    </div>
  );
};

/** One host's checklist, with a fix per item that has one. */
const ReadinessList: React.FC<{ host: DeviceHostSummary; busy: boolean; onFix: (actionId: string) => void }> = ({ host, busy, onFix }) => (
  <>
    {host.readiness.checks
      .filter((check) => !check.id.startsWith("tool:"))
      .map((check) => {
        const badge = READINESS_BADGE[check.state];
        const fix = fixLabel(check);
        return (
          <SettingRow key={check.id} label={check.label} description={check.detail ?? undefined}>
            {fix && check.fixActionId && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onFix(check.fixActionId!)}>
                {fix}
              </Button>
            )}
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </SettingRow>
        );
      })}
  </>
);

const HOST_STATUS_TONE: Readonly<Record<DeviceHostSummary["status"], "ok" | "warn" | "danger" | "info" | "neutral">> = {
  disabled: "neutral",
  "needs-setup": "warn",
  installing: "info",
  starting: "info",
  ready: "ok",
  unreachable: "warn",
  stopping: "neutral",
  failed: "danger"
};

const HOST_STATUS_TEXT: Readonly<Record<DeviceHostSummary["status"], string>> = {
  disabled: "Off",
  "needs-setup": "Needs setup",
  installing: "Installing",
  starting: "Starting",
  ready: "Ready",
  unreachable: "Unreachable",
  stopping: "Stopping",
  failed: "Failed"
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const AndroidSection: React.FC<{ settings: DevicesSettingsValue; host: DeviceHostSummary | undefined; ctx: SaveContext; onError: (text: string) => void }> = ({
  settings,
  host,
  ctx,
  onError
}) => {
  const api = useAppStore((s) => s.api);
  const job = useDeviceSetupJob("android");
  const [starting, setStarting] = React.useState(false);
  const summary = readinessSummary(host?.readiness.checks ?? []);
  const jobRunning = job?.state === "running";
  const setup = (actions?: string[]) => {
    if (!api) return;
    setStarting(true);
    void startDeviceSetup(api, "android", actions)
      .catch((err) => onError(errorText(err)))
      .finally(() => setStarting(false));
  };
  const busy = starting || jobRunning;
  const enabled = settings.android.enabled;
  return (
    <SettingsSection
      title="Android on this host"
      description="Emulators run on this machine (Linux with KVM), booted from a prepared snapshot in seconds."
      actions={
        enabled && host && (summary.canInstall || summary.canRepair) ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setup()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
            {summary.canInstall ? "Install all" : "Repair"}
          </Button>
        ) : undefined
      }
    >
      <SettingRow label="Android emulators" icon={<Smartphone size={14} />} description="Agents and the Device panel can open Android devices.">
        <SettingSwitch id="android.enabled" label="Enable Android" checked={enabled} ctx={ctx} patch={(on) => ({ android: { enabled: on } })} />
      </SettingRow>
      {enabled && host && (
        <SettingRow
          label={host.label}
          description={[host.statusDetail, summary.label, host.capacity.total > 0 ? `${host.capacity.used} of ${host.capacity.total} devices running` : null]
            .filter(Boolean)
            .join(" · ")}
          icon={<Server size={14} />}
        >
          <Badge tone={HOST_STATUS_TONE[host.status]}>{HOST_STATUS_TEXT[host.status]}</Badge>
        </SettingRow>
      )}
      {enabled && host && <ReadinessList host={host} busy={busy} onFix={(actionId) => setup([actionId])} />}
      {enabled && <SetupProgress platform="android" />}
      {enabled && (summary.canInstall || summary.canRepair || jobRunning) && (
        <div className="px-4 py-3">
          <Notice tone="info">
            Installing accepts the Android SDK licence.{" "}
            <a href={ANDROID_LICENCE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-neutral-200 underline underline-offset-2">
              Read the terms
              <ExternalLink size={10} aria-hidden />
            </a>
          </Notice>
        </div>
      )}
      {enabled && <ProfilesRow platform="android" settings={settings} ctx={ctx} />}
      {enabled && (
        <SettingRow
          label="Most devices at once"
          description="The host also limits it by free memory and cores; above it an agent is told the host is full."
          htmlFor="devices-android.maxLocalDevices"
        >
          <NumberField
            id="android.maxLocalDevices"
            label="Most devices at once"
            value={settings.android.maxLocalDevices}
            limits={DEVICES_SETTINGS_LIMITS.maxLocalDevices}
            ctx={ctx}
            patch={(value) => ({ android: { maxLocalDevices: value } })}
          />
        </SettingRow>
      )}
    </SettingsSection>
  );
};

/** One running Mac host: its cost so far and Destroy. */
const MacHostRow: React.FC<{ host: DeviceHostSummary; now: number; onDestroy: (host: DeviceHostSummary) => void; destroying: boolean }> = ({
  host,
  now,
  onDestroy,
  destroying
}) => {
  const view = macHostView(host, now);
  return (
    <SettingRow label={host.label} icon={<Apple size={14} />} description={[view.line, `${host.capacity.used} of ${host.capacity.total} simulators`].filter(Boolean).join(" · ")}>
      {view.countdown && <Badge>{view.countdown}</Badge>}
      <Badge tone={HOST_STATUS_TONE[host.status]}>{HOST_STATUS_TEXT[host.status]}</Badge>
      <Button size="sm" variant="ghost" disabled={destroying || host.status === "stopping"} onClick={() => onDestroy(host)} aria-label={`Destroy ${host.label}`}>
        {destroying ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        Destroy
      </Button>
    </SettingRow>
  );
};

const IosSection: React.FC<{ settings: DevicesSettingsValue; hosts: readonly DeviceHostSummary[]; ctx: SaveContext; onError: (text: string) => void }> = ({
  settings,
  hosts,
  ctx,
  onError
}) => {
  const api = useAppStore((s) => s.api);
  const boxesOn = useBoxesEnabled();
  const providers = useBoxProviders();
  const openBoxes = useOpenBoxesSettings();
  const ios = settings.ios;
  const providerId = ios.provider;
  const provider = providers?.find((entry) => entry.id === providerId);
  const providerReady = boxesOn && provider?.status === "connected";
  const [sizes, setSizes] = React.useState<readonly BoxSizeOffer[] | null>(null);
  const [destroyTarget, setDestroyTarget] = React.useState<DeviceHostSummary | null>(null);
  const [destroying, setDestroying] = React.useState<string | null>(null);
  const running = macHosts(hosts);
  const now = useNow(30_000, running.length > 0);

  React.useEffect(() => {
    if (api && boxesOn && providers === null) void loadBoxProviders(api).catch(() => undefined);
  }, [api, boxesOn, providers]);

  React.useEffect(() => {
    if (!api || !providerReady || !isBoxProviderId(providerId)) return;
    const controller = new AbortController();
    void loadBoxOffers(api, providerId, "macos", { signal: controller.signal })
      .then((offers) => setSizes(offers.sizes))
      .catch(() => setSizes(null));
    return () => controller.abort();
  }, [api, providerReady, providerId]);

  const sizeOffer = sizes?.find((size) => size.id === ios.size);
  const hourly = sizeOffer?.hourlyUsd ?? null;
  const destroy = (host: DeviceHostSummary) => {
    if (!api) return;
    setDestroyTarget(null);
    setDestroying(host.id);
    void api
      .destroyDeviceHost(host.id)
      .catch((err) => onError(errorText(err)))
      .finally(() => setDestroying(null));
  };
  const enabled = ios.enabled;
  const rentDisabled = !providerReady;

  return (
    <SettingsSection title="iPhone & iPad (Mac hosts)" description="Simulators run on rented macOS boxes, shared by every chat and torn down when idle.">
      <SettingRow label="iOS simulators" icon={<Apple size={14} />} description="Agents and the Device panel can open iPhones and iPads.">
        <SettingSwitch id="ios.enabled" label="Enable iPhone & iPad" checked={enabled} ctx={ctx} patch={(on) => ({ ios: { enabled: on } })} />
      </SettingRow>
      {enabled && !providerReady && (
        <div className="px-4 py-3">
          <Notice
            tone="warn"
            title={!boxesOn ? "Ephemeral AI VMs is off" : `${provider?.label ?? "Blacksmith"} is not set up`}
            action={
              <Button size="sm" variant="outline" onClick={openBoxes}>
                Set up in Plugins
              </Button>
            }
          >
            Mac hosts are rented through the Ephemeral AI VMs plugin. Connect {provider?.label ?? "Blacksmith"} there to run iPhone and iPad simulators.
          </Notice>
        </div>
      )}
      {enabled && (
        <>
          <SettingRow
            label="Provider"
            description={provider ? `${provider.label}${provider.status === "connected" ? " · connected" : ""}` : "Blacksmith"}
            icon={<Server size={14} />}
          >
            <Badge tone={providerReady ? "ok" : "warn"}>{providerReady ? "Ready" : "Not set up"}</Badge>
          </SettingRow>
          <SettingRow label="Size" description={hourly !== null ? `About ${formatHourlyRate(hourly)} while a host runs.` : "The macOS box each host rents."}>
            {sizes && sizes.length > 0 ? (
              <select
                aria-label="Mac host size"
                className={selectClass}
                value={ios.size}
                disabled={rentDisabled || ctx.saving === "ios.size"}
                onChange={(event) => ctx.save("ios.size", { ios: { size: event.target.value } })}
              >
                {!sizeOffer && <option value={ios.size}>{ios.size}</option>}
                {sizes.map((size) => (
                  <option key={size.id} value={size.id}>
                    {size.label} · {size.vcpu} vCPU · {size.ramGb} GB{size.hourlyUsd !== null ? ` · ${formatHourlyRate(size.hourlyUsd)}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <TextField
                id="ios.size"
                label="Mac host size"
                value={ios.size}
                placeholder="blacksmith-6vcpu-macos-26"
                disabled={rentDisabled}
                ctx={ctx}
                patch={(value) => ({ ios: { size: value ?? ios.size } })}
              />
            )}
          </SettingRow>
          <SettingRow label="Lifetime" description="A Mac host is destroyed at this age, devices or not. Android hosts: Fleet → Android host lifetime.">
            <NumberField
              id="ios.lifetimeMinutes"
              label="Lifetime in minutes"
              suffix="min"
              value={ios.lifetimeMinutes}
              limits={DEVICES_SETTINGS_LIMITS.lifetimeMinutes}
              disabled={rentDisabled}
              ctx={ctx}
              patch={(value) => ({ ios: { lifetimeMinutes: value } })}
            />
          </SettingRow>
          <SettingRow
            label="Idle teardown"
            description="Any rented device host (Mac or Linux) with no device for this long is destroyed, except hosts kept warm; your own Mac stops its device helpers. The same setting as Fleet → Idle teardown."
          >
            <NumberField
              id="ios.idleTeardownMinutes"
              label="Idle teardown in minutes"
              suffix="min"
              value={settings.pool.idleTeardownMinutes}
              limits={DEVICES_SETTINGS_LIMITS.idleTeardownMinutes}
              disabled={rentDisabled}
              ctx={ctx}
              patch={(value) => ({ pool: { idleTeardownMinutes: value } })}
            />
          </SettingRow>
          <SettingRow label="Simulators per host" description="At most; a host runs fewer when its memory is short. Beyond that a second host is rented.">
            <NumberField
              id="ios.maxSimulatorsPerHost"
              label="Simulators per host"
              value={ios.maxSimulatorsPerHost}
              limits={DEVICES_SETTINGS_LIMITS.maxSimulatorsPerHost}
              disabled={rentDisabled}
              ctx={ctx}
              patch={(value) => ({ ios: { maxSimulatorsPerHost: value } })}
            />
          </SettingRow>
          <SettingRow
            label="Renting Mac hosts"
            description={
              settings.pool.rentWithoutAsking
                ? `Without asking, up to $${settings.pool.monthlyCapUsd} a month (Fleet below: one switch and cap for every device host).`
                : "The first iPhone or iPad an agent opens asks you in its chat before renting. “Rent device hosts without asking” under Fleet changes that."
            }
          />
          <ProfilesRow platform="ios" settings={settings} ctx={ctx} />
        </>
      )}
      {(enabled || running.length > 0) &&
        (running.length === 0 ? (
          <EmptyState icon={<Apple size={16} />} title="No Mac host running" description={noMacHostText(hourly).replace(/^No Mac host running — /, "")} className="py-5" />
        ) : (
          running.map((host) => <MacHostRow key={host.id} host={host} now={now} destroying={destroying === host.id} onDestroy={setDestroyTarget} />)
        ))}
      <ConfirmDialog
        open={destroyTarget !== null}
        title="Destroy this Mac host?"
        message={
          destroyTarget
            ? `${destroyTarget.label} and its ${destroyTarget.capacity.used === 1 ? "simulator" : `${destroyTarget.capacity.used} simulators`} go away; chats using them see their devices as lost.`
            : ""
        }
        confirmLabel="Destroy"
        onConfirm={() => destroyTarget && destroy(destroyTarget)}
        onCancel={() => setDestroyTarget(null)}
      />
    </SettingsSection>
  );
};

const AgentsSection: React.FC<{ settings: DevicesSettingsValue; ctx: SaveContext }> = ({ settings, ctx }) => {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <SettingsSection title="Agents">
      <SettingRow
        label="Let agents use devices"
        icon={<Bot size={14} />}
        description={
          <>
            Agent chats get the device tools (list, open, drive, screenshot, close) while a platform is on.{" "}
            <button type="button" className="text-neutral-300 underline underline-offset-2 hover:text-neutral-100" onClick={() => openSettings("agent-tools")}>
              Agent tools settings
            </button>
          </>
        }
      >
        <SettingSwitch id="agents.enabled" label="Let agents use devices" checked={settings.agents.enabled} ctx={ctx} patch={(on) => ({ agents: { enabled: on } })} />
      </SettingRow>
      <SettingRow label="Show the device when an agent opens one" description="The right rail opens on the Device panel, unless you closed it for that chat.">
        <SettingSwitch
          id="agents.followAgentDevices"
          label="Show the device when an agent opens one"
          checked={settings.agents.followAgentDevices}
          ctx={ctx}
          patch={(on) => ({ agents: { followAgentDevices: on } })}
        />
      </SettingRow>
      <SettingRow label="Release idle devices after" description="With no agent or viewer activity for this long, a chat's device is released.">
        <NumberField
          id="leaseIdleMinutes"
          label="Release idle devices after, in minutes"
          suffix="min"
          value={settings.leaseIdleMinutes}
          limits={DEVICES_SETTINGS_LIMITS.leaseIdleMinutes}
          ctx={ctx}
          patch={(value) => ({ leaseIdleMinutes: value })}
        />
      </SettingRow>
      <SettingRow label="Devices per chat" description="How many devices one chat may hold at once.">
        <NumberField
          id="maxLeasesPerChat"
          label="Devices per chat"
          value={settings.maxLeasesPerChat}
          limits={DEVICES_SETTINGS_LIMITS.maxLeasesPerChat}
          ctx={ctx}
          patch={(value) => ({ maxLeasesPerChat: value })}
        />
      </SettingRow>
    </SettingsSection>
  );
};

const ToolsSection: React.FC<{ hosts: readonly DeviceHostSummary[] }> = ({ hosts }) => {
  const rows = toolRows(hosts);
  const multiHost = new Set(rows.map((row) => row.hostLabel)).size > 1;
  return (
    <SettingsSection title="Tools" description="The pinned device tools (expo-device-hub, agent-device) each host runs.">
      {rows.length === 0 ? (
        <p className="px-4 py-3.5 text-xs text-neutral-500">Shown once the host has been checked.</p>
      ) : (
        rows.map((row) => {
          const badge = READINESS_BADGE[row.state];
          return (
            <SettingRow
              key={row.id}
              label={row.label}
              icon={<Package size={14} />}
              description={[row.detail, multiHost ? row.hostLabel : null].filter(Boolean).join(" · ") || undefined}
            >
              <Badge tone={badge.tone}>{row.state === "ok" ? "Installed" : badge.text}</Badge>
            </SettingRow>
          );
        })
      )}
    </SettingsSection>
  );
};

const FleetSection: React.FC<{ settings: DevicesSettingsValue; ctx: SaveContext }> = ({ settings, ctx }) => {
  const [open, setOpen] = React.useState(false);
  const poolSummary = useDevicesState((s) => s.pool);
  const pool = settings.pool;
  const L = DEVICES_SETTINGS_LIMITS;
  return (
    <section className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded text-sm font-medium text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      >
        <ChevronRight size={14} className={cn("text-neutral-500 transition-transform", open && "rotate-90")} aria-hidden />
        Fleet (preview)
        <Badge>Phase 2</Badge>
      </button>
      {open && (
        <div className="divide-y divide-neutral-800/80 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40" data-devices-fleet="">
          {poolSummary && (
            <SettingRow
              label="Pool now"
              description={`${poolSummary.hosts} host${poolSummary.hosts === 1 ? "" : "s"} · ${poolSummary.capacity.used} of ${poolSummary.capacity.total} devices · ${formatHourlyRate(poolSummary.hourlyUsd)}${poolSummary.queue > 0 ? ` · ${poolSummary.queue} waiting` : ""}`}
            />
          )}
          <SettingRow label="Placement" description={PLACEMENT_HINTS[pool.placement]} stacked>
            <SegmentedControl<DevicePlacementMode>
              ariaLabel="Placement"
              value={pool.placement}
              options={DEVICE_PLACEMENT_MODES.map((mode) => ({ value: mode, label: PLACEMENT_LABELS[mode] }))}
              onChange={(mode) => ctx.save("pool.placement", { pool: { placement: mode } })}
            />
          </SettingRow>
          <SettingRow label="Pool provider" description="The box provider pool hosts are rented from; blank: none.">
            <TextField id="pool.provider" label="Pool provider" value={pool.provider} placeholder="none" ctx={ctx} patch={(value) => ({ pool: { provider: value } })} />
          </SettingRow>
          <SettingRow label="Android host size" description="Linux (KVM) size; blank: the provider's default.">
            <TextField
              id="pool.androidSize"
              label="Android host size"
              value={pool.androidSize}
              placeholder="provider default"
              ctx={ctx}
              patch={(value) => ({ pool: { androidSize: value } })}
            />
          </SettingRow>
          <SettingRow label="Android host lifetime" description="A rented Linux host is destroyed at this age, devices or not.">
            <NumberField
              id="pool.androidLifetimeMinutes"
              label="Android host lifetime in minutes"
              suffix="min"
              value={pool.androidLifetimeMinutes}
              limits={L.lifetimeMinutes}
              ctx={ctx}
              patch={(value) => ({ pool: { androidLifetimeMinutes: value } })}
            />
          </SettingRow>
          <SettingRow label="iOS host size" description="macOS size; blank: the Mac host size above.">
            <TextField id="pool.iosSize" label="iOS host size" value={pool.iosSize} placeholder="same as Mac hosts" ctx={ctx} patch={(value) => ({ pool: { iosSize: value } })} />
          </SettingRow>
          <SettingRow label="Most pool hosts">
            <NumberField id="pool.maxHosts" label="Most pool hosts" value={pool.maxHosts} limits={L.maxHosts} ctx={ctx} patch={(value) => ({ pool: { maxHosts: value } })} />
          </SettingRow>
          <SettingRow label="Hourly cap" description="The pool's summed cost per hour.">
            <NumberField
              id="pool.maxHourlyUsd"
              label="Hourly cap in US dollars"
              prefix="$"
              suffix="/h"
              integer={false}
              value={pool.maxHourlyUsd}
              limits={L.maxHourlyUsd}
              ctx={ctx}
              patch={(value) => ({ pool: { maxHourlyUsd: value } })}
            />
          </SettingRow>
          <SettingRow label="Warm Android hosts" description="Ready hosts kept running for fast opens.">
            <NumberField
              id="pool.minWarmHosts.android"
              label="Warm Android hosts"
              value={pool.minWarmHosts.android}
              limits={L.minWarmHosts}
              ctx={ctx}
              patch={(value) => ({ pool: { minWarmHosts: { android: value } } })}
            />
          </SettingRow>
          <SettingRow label="Warm iOS hosts">
            <NumberField
              id="pool.minWarmHosts.ios"
              label="Warm iOS hosts"
              value={pool.minWarmHosts.ios}
              limits={L.minWarmHosts}
              ctx={ctx}
              patch={(value) => ({ pool: { minWarmHosts: { ios: value } } })}
            />
          </SettingRow>
          <SettingRow label="Idle teardown" description="A rented host with no device for this long is destroyed, except warm ones (the same setting as the Mac hosts' Idle teardown).">
            <NumberField
              id="pool.idleTeardownMinutes"
              label="Idle teardown in minutes"
              suffix="min"
              value={pool.idleTeardownMinutes}
              limits={L.idleTeardownMinutes}
              ctx={ctx}
              patch={(value) => ({ pool: { idleTeardownMinutes: value } })}
            />
          </SettingRow>
          <SettingRow label="Wait for room" description="How long a request above the caps waits before failing.">
            <NumberField
              id="pool.capacityWaitSeconds"
              label="Wait for room in seconds"
              suffix="s"
              value={pool.capacityWaitSeconds}
              limits={L.capacityWaitSeconds}
              ctx={ctx}
              patch={(value) => ({ pool: { capacityWaitSeconds: value } })}
            />
          </SettingRow>
          <SettingRow label="Rent device hosts without asking" description="Mac and Linux hosts alike: within the caps, no approval card.">
            <SettingSwitch
              id="pool.rentWithoutAsking"
              label="Rent device hosts without asking"
              checked={pool.rentWithoutAsking}
              ctx={ctx}
              patch={(on) => ({ pool: { rentWithoutAsking: on } })}
            />
          </SettingRow>
          <SettingRow label="Monthly cap" description="This month's device-host spend, plus what running hosts are committed to, plus a new host's whole time limit. Above it, renting asks again.">
            <NumberField
              id="pool.monthlyCapUsd"
              label="Monthly cap in US dollars"
              prefix="$"
              integer={false}
              value={pool.monthlyCapUsd}
              limits={L.monthlyCapUsd}
              disabled={!pool.rentWithoutAsking}
              ctx={ctx}
              patch={(value) => ({ pool: { monthlyCapUsd: value } })}
            />
          </SettingRow>
        </div>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export const DevicesSettings: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const openSettings = useAppStore((s) => s.openSettings);
  const enabled = useDevicesEnabled();
  const loaded = useDevicesLoaded();
  const settings = useDevicesSettings();
  const hosts = useDeviceHosts();
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (enabled && api && !loaded) void loadDevices(api).catch((err) => setError(errorText(err)));
  }, [enabled, api, loaded]);

  const ctx = React.useMemo<SaveContext>(
    () => ({
      saving,
      save: (key, patch) => {
        if (!api) return;
        setSaving(key);
        setError(null);
        void updateDevicesSettings(api, patch)
          .catch((err) => setError(errorText(err)))
          .finally(() => setSaving((current) => (current === key ? null : current)));
      }
    }),
    [api, saving]
  );

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

  const localHost = hosts.find((host) => host.kind === "local" && host.platforms.includes("android"));

  return (
    <SettingsPage title="Devices" description="iOS simulators and Android emulators beside your chats; agents drive them and you watch live.">
      {error && <Notice tone="danger">{error}</Notice>}
      {!settings ? (
        <Notice tone="info">Loading…</Notice>
      ) : (
        <>
          <AndroidSection settings={settings} host={localHost} ctx={ctx} onError={setError} />
          <IosSection settings={settings} hosts={hosts} ctx={ctx} onError={setError} />
          <AgentsSection settings={settings} ctx={ctx} />
          <ToolsSection hosts={hosts} />
          <FleetSection settings={settings} ctx={ctx} />
        </>
      )}
    </SettingsPage>
  );
};
