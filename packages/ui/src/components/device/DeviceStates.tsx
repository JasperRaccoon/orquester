/**
 * The Device panel's non-live views: the picker (empty state), a booting device's steps, a failed
 * boot, a lost or unreachable device, and the tabs over the chat's devices.
 */

import React from "react";
import { AlertTriangle, Check, CircleDashed, Loader2, Plus, Settings2, Smartphone, Tablet, TabletSmartphone, WifiOff, X } from "lucide-react";

import type { DeviceFormFactor, DeviceLeaseSummary, DevicePlatform, DeviceProfile } from "@orquester/api";

import { cn } from "../../lib/cn";
import { lostDeviceText, type BootStep, type PickerGroup } from "./device-panel.logic";

// ---------------------------------------------------------------------------
// Glyphs and small pieces
// ---------------------------------------------------------------------------

/** Apple and Android marks, as simple strokes that sit with lucide's icons. */
export function PlatformGlyph({ platform, className }: { platform: DevicePlatform; className?: string }) {
  if (platform === "ios") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden className={cn("h-3.5 w-3.5", className)} fill="currentColor">
        <path d="M16.37 12.53c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.63 1.11 8.8.73 1.06 1.6 2.25 2.74 2.21 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.08 2.65-2.15.84-1.23 1.18-2.42 1.2-2.48-.03-.01-2.3-.88-2.32-3.5zM14.2 6.07c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.68.97.08 1.96-.49 2.56-1.23z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("h-3.5 w-3.5", className)} fill="currentColor">
      <path d="M17.6 9.48l1.84-3.18a.38.38 0 00-.66-.38l-1.86 3.22a11.4 11.4 0 00-9.84 0L5.22 5.92a.38.38 0 10-.66.38L6.4 9.48A10.78 10.78 0 001 18h22a10.78 10.78 0 00-5.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
    </svg>
  );
}

export function FormFactorIcon({ formFactor, size = 16, className }: { formFactor: DeviceFormFactor; size?: number; className?: string }) {
  const Icon = formFactor === "tablet" ? Tablet : formFactor === "foldable" ? TabletSmartphone : Smartphone;
  return <Icon size={size} strokeWidth={1.6} aria-hidden className={className} />;
}

function Spinner({ className }: { className?: string }) {
  return <Loader2 size={14} strokeWidth={2} aria-hidden className={cn("animate-spin motion-reduce:animate-none", className)} />;
}

export function PanelButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" }) {
  const { tone = "ghost", className, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:pointer-events-none disabled:opacity-40",
        tone === "primary" && "bg-neutral-100 text-neutral-900 hover:bg-white",
        tone === "ghost" && "text-neutral-300 ring-1 ring-inset ring-neutral-700 hover:bg-neutral-800 hover:text-neutral-100",
        tone === "danger" && "text-danger ring-1 ring-inset ring-danger/40 hover:bg-danger-soft",
        className
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface DeviceTab {
  lease: DeviceLeaseSummary;
  name: string;
}

export function DeviceTabs(props: {
  tabs: readonly DeviceTab[];
  selectedId: string | null;
  picking: boolean;
  canAdd: boolean;
  onSelect: (leaseId: string) => void;
  onRelease: (leaseId: string) => void;
  onAdd: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800/80 px-2 [scrollbar-width:none]" role="tablist" aria-label="This chat's devices">
      {props.tabs.map(({ lease, name }) => {
        const selected = !props.picking && lease.id === props.selectedId;
        const dot =
          lease.state === "lost" || lease.error
            ? "bg-danger"
            : lease.state !== "ready"
              ? "bg-neutral-500"
              : lease.controller === "agent"
                ? "bg-warn"
                : "bg-info";
        const dotTitle =
          lease.state === "ready" ? (lease.controller === "agent" ? "The agent is controlling" : "You have control") : lease.state === "lost" ? "Lost" : lease.error ? "Couldn't start" : "Starting";
        return (
          <div
            key={lease.id}
            className={cn(
              "group/tab flex h-7 shrink-0 items-center rounded-md text-[12px] transition-colors",
              selected ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            )}
            onAuxClick={(event) => {
              // Middle-click releases, as browsers close tabs.
              if (event.button === 1) {
                event.preventDefault();
                props.onRelease(lease.id);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => props.onSelect(lease.id)}
              title={`${name} · ${lease.osVersion || lease.platform}`}
              className="flex h-full items-center gap-1.5 rounded-md pl-2 pr-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              <PlatformGlyph platform={lease.platform} className={selected ? "text-neutral-300" : "text-neutral-500"} />
              <span className="max-w-[9rem] truncate">{name}</span>
              <span aria-label={dotTitle} title={dotTitle} className={cn("ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
            </button>
            <button
              type="button"
              aria-label={`Release ${name}`}
              title={`Release ${name} (middle-click)`}
              onClick={() => props.onRelease(lease.id)}
              className={cn(
                "mr-0.5 flex h-5 w-5 items-center justify-center rounded text-neutral-500 transition-opacity hover:bg-neutral-700 hover:text-neutral-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                selected ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
              )}
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={props.onAdd}
        disabled={!props.canAdd}
        aria-pressed={props.picking}
        title={props.canAdd ? "Open another device" : "This chat has as many devices as it may hold"}
        className={cn(
          "ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-40",
          props.picking && "bg-neutral-800 text-neutral-100"
        )}
      >
        <Plus size={13} aria-hidden />
        {props.tabs.length === 0 ? "Open a device" : null}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The picker (empty state)
// ---------------------------------------------------------------------------

export function DevicePicker(props: {
  groups: readonly PickerGroup[];
  opening: string | null;
  error: string | null;
  /** The chat already has devices: the picker is "add another". */
  adding: boolean;
  onOpen: (profile: DeviceProfile) => void;
  onSettings: () => void;
  onCancel?: () => void;
}): React.ReactElement {
  const empty = props.groups.length === 0;
  return (
    <div className="ac-scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-5" data-device-picker="">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-800/80 text-neutral-300 ring-1 ring-inset ring-neutral-700/60">
          <Smartphone size={18} strokeWidth={1.6} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-medium text-neutral-100">{props.adding ? "Open another device" : "No device in this chat yet"}</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-neutral-500">
            {props.adding
              ? "It joins this chat's devices; the agent can drive it too."
              : "When the agent opens a simulator or emulator it appears here. You can also open one yourself."}
          </p>
        </div>
        {props.onCancel ? (
          <button
            type="button"
            onClick={props.onCancel}
            aria-label="Back to the device"
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      {props.error ? (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-danger-900/60 bg-danger-soft/25 px-3 py-2 text-[12px] text-neutral-200">
          <AlertTriangle size={14} aria-hidden className="mt-px shrink-0 text-danger" />
          <span className="min-w-0 flex-1">{props.error}</span>
        </div>
      ) : null}
      {empty ? (
        <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-6 text-center">
          <p className="text-[12px] text-neutral-400">No device profiles are offered.</p>
          <button type="button" onClick={props.onSettings} className="mt-2 text-[12px] text-neutral-200 underline-offset-2 hover:underline">
            Settings → Devices
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        {props.groups.map((group) => (
          <section key={group.platform} aria-label={group.title}>
            <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
              <PlatformGlyph platform={group.platform} className="text-neutral-500" />
              <h4 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">{group.title}</h4>
            </div>
            {group.note ? <p className="mb-2 px-0.5 text-[11.5px] leading-relaxed text-neutral-500">{group.note}</p> : null}
            <ul className="divide-y divide-neutral-800/70 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
              {group.rows.map((row) => {
                const opening = props.opening === row.profile.id;
                return (
                  <li key={row.profile.id} className="flex items-center gap-3 px-3 py-2.5" data-profile={row.profile.id} aria-disabled={!row.enabled || undefined} title={row.hint ?? undefined}>
                    <FormFactorIcon formFactor={row.profile.formFactor} className={row.enabled ? "text-neutral-400" : "text-neutral-600"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn("truncate text-[13px]", row.enabled ? "text-neutral-100" : "text-neutral-400")}>{row.profile.label}</span>
                        <span className="shrink-0 text-[11px] text-neutral-500">{row.profile.os}</span>
                      </div>
                      {row.reason ? (
                        <p className="mt-0.5 text-[11.5px] leading-snug text-neutral-500">
                          {row.reason}{" "}
                          {/Settings/.test(row.reason) ? (
                            <button type="button" onClick={props.onSettings} className="inline-flex items-center gap-0.5 text-neutral-300 underline-offset-2 hover:underline">
                              <Settings2 size={11} aria-hidden />
                              Open
                            </button>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    {row.enabled ? (
                      <>
                        {row.badge !== "Ready" ? <span className="hidden shrink-0 text-[11px] text-neutral-500 min-[380px]:inline">{row.badge}</span> : null}
                        <PanelButton
                          tone="primary"
                          disabled={props.opening !== null}
                          onClick={() => props.onOpen(row.profile)}
                          aria-label={`${row.action === "queue" ? "Queue" : "Open"} ${row.profile.label}`}
                          title={row.hint ?? undefined}
                        >
                          {opening ? <Spinner /> : null}
                          {opening ? "Opening" : row.action === "queue" ? "Queue" : "Open"}
                        </PanelButton>
                      </>
                    ) : (
                      <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] font-medium text-neutral-400">{row.badge}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Booting, failed, lost, unreachable
// ---------------------------------------------------------------------------

function DeviceCard(props: { name: string; lease: DeviceLeaseSummary; children: React.ReactNode; formFactor: DeviceFormFactor }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-[19rem]">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="relative mb-3 flex h-[72px] w-12 items-center justify-center rounded-[14px] border border-neutral-700/80 bg-gradient-to-b from-neutral-800/80 to-neutral-900 shadow-inner">
            <FormFactorIcon formFactor={props.formFactor} size={18} className="text-neutral-500" />
            <span aria-hidden className="absolute top-1.5 h-1 w-4 rounded-full bg-neutral-700/80" />
          </div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-neutral-100">
            <PlatformGlyph platform={props.lease.platform} className="text-neutral-400" />
            {props.name}
          </div>
          <div className="mt-0.5 text-[11.5px] text-neutral-500">{props.lease.osVersion || (props.lease.platform === "ios" ? "iOS simulator" : "Android emulator")}</div>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function DeviceBooting(props: {
  lease: DeviceLeaseSummary;
  name: string;
  formFactor: DeviceFormFactor;
  steps: readonly BootStep[];
  elapsed: string;
  failed: boolean;
  onRetry: () => void;
  onRelease: () => void;
  busy: boolean;
}): React.ReactElement {
  return (
    <DeviceCard name={props.name} lease={props.lease} formFactor={props.formFactor}>
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-1.5" aria-live="polite">
        <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-[11px] text-neutral-500">
          <span>{props.failed ? "Couldn't start" : "Starting"}</span>
          <span className="tabular-nums">{props.elapsed}</span>
        </div>
        <ol>
          {props.steps.map((step) => (
            <li key={step.id} className={cn("flex items-start gap-2.5 rounded-lg px-2 py-1.5", step.state === "active" && "bg-neutral-800/60")} data-step={step.id} data-state={step.state}>
              <span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center">
                {step.state === "done" ? (
                  <Check size={13} strokeWidth={2.4} aria-hidden className="text-ok" />
                ) : step.state === "active" ? (
                  <Spinner className="text-neutral-200" />
                ) : step.state === "failed" ? (
                  <X size={13} strokeWidth={2.4} aria-hidden className="text-danger" />
                ) : (
                  <CircleDashed size={13} aria-hidden className="text-neutral-600" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("text-[12.5px]", step.state === "pending" ? "text-neutral-500" : step.state === "failed" ? "text-danger" : "text-neutral-200")}>{step.label}</div>
                {step.detail ? <div className="text-[11px] text-neutral-500">{step.detail}</div> : null}
              </div>
              {step.elapsed ? <span className="shrink-0 pt-px text-[11px] tabular-nums text-neutral-500">{step.elapsed}</span> : null}
            </li>
          ))}
        </ol>
      </div>
      {props.failed ? (
        <>
          <p role="alert" className="mt-3 text-center text-[12px] leading-relaxed text-danger">
            {props.lease.error}
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <PanelButton tone="primary" onClick={props.onRetry} disabled={props.busy}>
              Retry
            </PanelButton>
            <PanelButton onClick={props.onRelease} disabled={props.busy}>
              Dismiss
            </PanelButton>
          </div>
        </>
      ) : (
        <div className="mt-3 flex justify-center">
          <button type="button" onClick={props.onRelease} disabled={props.busy} className="text-[11.5px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline disabled:opacity-40">
            Cancel
          </button>
        </div>
      )}
    </DeviceCard>
  );
}

export function DeviceGone(props: {
  lease: DeviceLeaseSummary;
  name: string;
  formFactor: DeviceFormFactor;
  kind: "lost" | "suspended";
  onRetry: () => void;
  onRelease: () => void;
  busy: boolean;
}): React.ReactElement {
  const lost = props.kind === "lost";
  return (
    <DeviceCard name={props.name} lease={props.lease} formFactor={props.formFactor}>
      <div className={cn("flex items-start gap-2.5 rounded-xl border px-3 py-2.5", lost ? "border-danger-900/60 bg-danger-soft/20" : "border-warn-900/60 bg-warn-soft/20")}>
        {lost ? <AlertTriangle size={15} aria-hidden className="mt-px shrink-0 text-danger" /> : <WifiOff size={15} aria-hidden className="mt-px shrink-0 text-warn" />}
        <div className="min-w-0 text-[12px] leading-relaxed text-neutral-300">
          <p className="font-medium text-neutral-100">{lost ? "This device is gone" : "Can't reach this device's host"}</p>
          <p className="text-neutral-400">
            {lost ? lostDeviceText(props.lease.error) : "The device keeps running; it comes back when the host does."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-center gap-2">
        {lost ? (
          <PanelButton tone="primary" onClick={props.onRetry} disabled={props.busy}>
            {props.busy ? <Spinner /> : null}
            Open a new {props.name}
          </PanelButton>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-neutral-500">
            <Spinner /> Reconnecting…
          </span>
        )}
        <PanelButton onClick={props.onRelease} disabled={props.busy}>
          {lost ? "Dismiss" : "Release"}
        </PanelButton>
      </div>
    </DeviceCard>
  );
}

/** A centred line for "Open an agent chat", "Loading devices…". */
export function PanelMessage({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
      <p className="text-[13px] text-neutral-300">{title}</p>
      {hint ? <p className="max-w-xs text-[12px] leading-relaxed text-neutral-500">{hint}</p> : null}
      {children}
    </div>
  );
}
