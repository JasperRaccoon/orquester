import React, { useEffect, useReducer } from "react";
import { AlertTriangle, Apple, Cpu, House, Info, Loader2, Monitor, Plus, RefreshCw, Server } from "lucide-react";
import type { BoxKind, BoxLocationRequest, BoxProviderId } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { loadBoxKinds, loadBoxOffers, loadBoxProviders, useBoxKinds, useBoxProviders } from "../../../lib/boxes/store";
import { useBoxesEnabled } from "../../../lib/boxes/hooks";
import { formatLifetime } from "../../../lib/boxes/format";
import { boxesErrorText } from "../../../lib/boxes/errors";
import {
  RUNS_ON_INITIAL,
  imageOptions,
  kindCards,
  lifetimeOptions,
  offersRequest,
  placementSelects,
  regionOptions,
  runsInBox,
  runsOnLocation,
  runsOnReady,
  runsOnReducer,
  runsOnSummary,
  sizeOptionLabel,
  sizeOptions,
  selectedSize,
  sizeSpecs,
  type RunsOnAction,
  type RunsOnState
} from "./runs-on.logic";

const KIND_ICON: Record<BoxKind, React.ReactNode> = {
  linux: <Server size={14} />,
  "linux-gpu": <Cpu size={14} />,
  windows: <Monitor size={14} />,
  "windows-gpu": <Cpu size={14} />,
  macos: <Apple size={14} />
};

const errorText = (err: unknown): string => boxesErrorText(err, "Could not load the offers.");

export interface RunsOn {
  /** The plugin is on: the row shows. */
  enabled: boolean;
  state: RunsOnState;
  dispatch: React.Dispatch<RunsOnAction>;
  /** `CreateProjectRequest.location`; undefined for this host (the request then omits it). */
  location: BoxLocationRequest | undefined;
  /** A box was chosen. */
  inBox: boolean;
  /** The choice is complete (this host always is). */
  ready: boolean;
}

/**
 * The Runs on choice of one dialog: refreshes the kinds and providers each
 * time the dialog opens (while the plugin is on), follows changes to them,
 * reads offers when a provider is picked, and starts over on close.
 */
export function useRunsOn(open: boolean): RunsOn {
  const enabled = useBoxesEnabled();
  const api = useAppStore((s) => s.api);
  const kinds = useBoxKinds();
  const [state, dispatch] = useReducer(runsOnReducer, RUNS_ON_INITIAL);
  const active = open && enabled;

  useEffect(() => {
    if (!active) {
      dispatch({ type: "reset" });
      return;
    }
    if (!api) return;
    // Availability is daemon state (a provider connected elsewhere): read it fresh per open.
    void loadBoxKinds(api).catch(() => undefined);
    void loadBoxProviders(api).catch(() => undefined);
  }, [active, api]);

  useEffect(() => {
    if (kinds) dispatch({ type: "kinds", kinds });
  }, [kinds]);

  const request = offersRequest(state);
  const provider = request?.provider;
  const kind = request?.kind;
  useEffect(() => {
    if (!api || !provider || !kind) return;
    let current = true;
    loadBoxOffers(api, provider, kind)
      .then((offers) => current && dispatch({ type: "offers-loaded", offers }))
      .catch((err: unknown) => current && dispatch({ type: "offers-failed", provider, kind, message: errorText(err) }));
    return () => {
      current = false;
    };
  }, [api, provider, kind]);

  const location = active ? (runsOnLocation(state) ?? undefined) : undefined;
  return {
    enabled,
    state,
    dispatch,
    location,
    inBox: active && runsInBox(state),
    ready: !active || runsOnReady(state)
  };
}

const selectClass =
  "h-8 w-full min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-base text-neutral-100 disabled:opacity-50 sm:text-xs";

const LocationCard: React.FC<{
  title: string;
  description: React.ReactNode;
  icon: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  tooltip?: string;
  dashed?: boolean;
  role?: "radio";
  onClick: () => void;
}> = ({ title, description, icon, selected, disabled, tooltip, dashed, role, onClick }) => (
  <button
    type="button"
    role={role}
    aria-checked={role === "radio" ? !!selected : undefined}
    // A disabled button shows no tooltip in most browsers: aria-disabled keeps it hoverable.
    aria-disabled={disabled || undefined}
    title={tooltip}
    onClick={() => {
      if (!disabled) onClick();
    }}
    className={cn(
      "flex min-w-0 flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
      "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
      dashed && "border-dashed",
      selected
        ? "border-info/60 bg-info-soft/20"
        : disabled
          ? "cursor-not-allowed border-neutral-800 opacity-50"
          : "border-neutral-800 bg-neutral-900 hover:border-neutral-600"
    )}
  >
    <span className="flex w-full min-w-0 items-center gap-1.5 text-xs font-medium text-neutral-100">
      <span aria-hidden className="shrink-0 text-neutral-400">
        {icon}
      </span>
      <span className="truncate">{title}</span>
    </span>
    <span className="line-clamp-2 text-[11px] leading-snug text-neutral-500">{description}</span>
  </button>
);

/**
 * The New project dialog's "Runs on" row: This host, one card per box kind,
 * "Set up more…"; a chosen kind reveals its provider, size and region (or OS
 * image) selects and a price note. Renders nothing while the plugin is off.
 */
export const RunsOnRow: React.FC<{
  runsOn: RunsOn;
  disabled?: boolean;
  onSetUpMore: () => void;
}> = ({ runsOn, disabled, onSetUpMore }) => {
  const kinds = useBoxKinds();
  const providers = useBoxProviders();
  if (!runsOn.enabled) return null;
  const { state, dispatch } = runsOn;
  const cards = kindCards(kinds, providers);
  const availability = kinds?.find((entry) => entry.kind === state.choice);
  const providerLabel = (id: string) => providers?.find((provider) => provider.id === id)?.label ?? id;
  const sizes = sizeOptions(state);
  const chosenSize = selectedSize(state);
  const regions = regionOptions(state);
  const images = imageOptions(state);
  const placement = placementSelects(state);
  const summary = runsOnSummary(state);
  const lifetimes = lifetimeOptions(state.maxLifetimeMinutes);
  const offersLoading = state.offers.status === "loading";

  return (
    <div className="space-y-2" aria-disabled={disabled || undefined}>
      <span id="runs-on-label" className="text-xs text-neutral-400">
        Runs on
      </span>
      <div role="radiogroup" aria-labelledby="runs-on-label" className="grid grid-cols-3 gap-2">
        <LocationCard
          role="radio"
          title="This host"
          description="Default. Uses the Orquester server."
          icon={<House size={14} />}
          selected={state.choice === "host"}
          disabled={disabled}
          onClick={() => dispatch({ type: "host" })}
        />
        {cards.map((card) => (
          <LocationCard
            key={card.kind}
            role="radio"
            title={card.label}
            description={
              <>
                {card.providers && <span className="block truncate">{card.providers}</span>}
                {card.price && <span className="block truncate">{card.price}</span>}
              </>
            }
            icon={KIND_ICON[card.kind]}
            selected={state.choice === card.kind}
            disabled={disabled || card.disabled}
            tooltip={card.reason ?? undefined}
            onClick={() => {
              const entry = kinds?.find((k) => k.kind === card.kind);
              if (entry) dispatch({ type: "kind", availability: entry });
            }}
          />
        ))}
        <LocationCard
          title="Set up more…"
          description="Opens plugin settings"
          icon={<Plus size={14} />}
          dashed
          disabled={disabled}
          onClick={onSetUpMore}
        />
      </div>

      {state.choice !== "host" && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <label className="min-w-0 space-y-1">
              <span className="block text-[11px] text-neutral-500">Provider</span>
              <select
                aria-label="Provider"
                className={selectClass}
                disabled={disabled}
                value={state.provider ?? ""}
                onChange={(e) => dispatch({ type: "provider", provider: e.target.value as BoxProviderId })}
              >
                {(availability?.providers ?? (state.provider ? [state.provider] : [])).map((id) => (
                  <option key={id} value={id}>
                    {providerLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="block text-[11px] text-neutral-500">Size</span>
              <select
                aria-label="Size"
                className={selectClass}
                disabled={disabled || sizes.length === 0}
                value={state.size ?? ""}
                title={chosenSize ? sizeSpecs(chosenSize) : undefined}
                onChange={(e) => dispatch({ type: "size", id: e.target.value })}
              >
                {sizes.length === 0 && <option value="">{offersLoading ? "Loading…" : "None"}</option>}
                {sizes.map((size) => (
                  <option key={size.id} value={size.id} title={sizeSpecs(size)}>
                    {sizeOptionLabel(size)}
                  </option>
                ))}
              </select>
            </label>
            {placement.region && (
              <label className="min-w-0 space-y-1">
                <span className="block text-[11px] text-neutral-500">Region</span>
                <select
                  aria-label="Region"
                  className={selectClass}
                  disabled={disabled || regions.length === 0}
                  value={state.region ?? ""}
                  onChange={(e) => dispatch({ type: "region", id: e.target.value })}
                >
                  {regions.length === 0 && <option value="">{offersLoading ? "Loading…" : "None"}</option>}
                  {regions.map((region) => (
                    <option key={region.id} value={region.id}>
                      {region.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {placement.image && (
              <label className="min-w-0 space-y-1">
                <span className="block text-[11px] text-neutral-500">OS version</span>
                <select
                  aria-label="OS version"
                  className={selectClass}
                  disabled={disabled}
                  value={state.image ?? ""}
                  onChange={(e) => dispatch({ type: "image", id: e.target.value })}
                >
                  {images.map((image) => (
                    <option key={image.id} value={image.id}>
                      {image.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {offersLoading && (
            <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              <Loader2 size={12} className="animate-spin" /> Loading sizes and prices…
            </p>
          )}
          {state.offers.status === "error" && (
            <div className="flex items-center gap-2 text-[11px] text-danger">
              <span className="min-w-0 flex-1">{state.offers.message}</span>
              <button
                type="button"
                onClick={() => dispatch({ type: "retry-offers" })}
                className="flex shrink-0 items-center gap-1 text-neutral-400 hover:text-neutral-200"
              >
                <RefreshCw size={11} /> Retry
              </button>
            </div>
          )}
          {state.offers.status === "ready" && sizes.length === 0 && (
            <p className="text-[11px] text-warn">This provider offers no sizes for this kind right now.</p>
          )}

          {summary && (
            <div
              role="note"
              className={cn(
                "flex gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed",
                summary.tone === "warn"
                  ? "border-warn-900/60 bg-warn-soft/20 text-warn"
                  : "border-neutral-800 bg-neutral-950 text-neutral-400"
              )}
            >
              {summary.tone === "warn" ? (
                <AlertTriangle size={13} className="mt-px shrink-0" />
              ) : (
                <Info size={13} className="mt-px shrink-0 text-neutral-500" />
              )}
              <div className="min-w-0 flex-1 space-y-1.5">
                <p>{summary.text}</p>
                {lifetimes.length > 0 && (
                  <label className="flex flex-wrap items-center gap-2 text-neutral-300">
                    Lifetime
                    <select
                      aria-label="Lifetime"
                      className={cn(selectClass, "h-7 w-auto")}
                      disabled={disabled}
                      value={state.lifetimeMinutes ?? ""}
                      onChange={(e) => dispatch({ type: "lifetime", minutes: Number(e.target.value) })}
                    >
                      {lifetimes.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {formatLifetime(minutes)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
