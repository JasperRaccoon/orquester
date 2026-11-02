/**
 * The server-level Usage view (spec §6.2–6.5): a toolbar — the window shown, the agent filter,
 * the range, the tab (Cost · Tokens · Limits), refresh and a menu with "Model prices…" — over the
 * Cost / Tokens overview or the Limits panel. It owns the history fetch (`useUsageHistory`: the
 * last answer stays while a newer one loads), the per-device prefs, the keyboard shortcuts and
 * the price editor's open state. The parts themselves draw the figures and their footnotes.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, MoreHorizontal, RefreshCw, SlidersHorizontal } from "lucide-react";

import { getRegistryIcon } from "../../icons";
import { cn } from "../../lib/cn";
import { isAnyLayerOpen } from "../../lib/open-layers";
import { formatWindow, localTimeZone, sortAgents, USAGE_AGENT_ORDER } from "../../lib/usage-history-format";
import {
  useUsageHistory,
  usageHistoryLoading,
  usageHistoryUpdating
} from "../../lib/usage-history-data";
import { readUsageViewPrefs, writeUsageViewPrefs, type UsageViewPrefs } from "../../lib/usage-view-prefs";
import { useAppStore } from "../../store/app";
import { SegmentedControl } from "../settings/primitives";
import { labelForAgent } from "../topbar/usage-format";
import { AdaptiveMenu, Button, DropdownItem, DropdownSeparator, IconButton } from "../ui";
import { UsageLimitsPanel } from "./UsageLimitsPanel";
import { UsageOverviewPanel, UsageOverviewSkeleton } from "./UsageOverviewPanel";
import { UsagePricesDialog } from "./UsagePricesDialog";
import type { UsageRangeOption, UsageTab } from "./types";
import { USAGE_RANGE_SHORTCUTS, USAGE_TAB_SHORTCUTS, resolveUsageShortcut, shortcutTitle } from "./usage-shortcuts";

const RANGE_OPTIONS: readonly { value: UsageRangeOption; label: string; long: string }[] = [
  { value: "24h", label: "24h", long: "Past 24 hours" },
  { value: "7d", label: "7d", long: "7 days" },
  { value: "30d", label: "30d", long: "30 days" },
  { value: "90d", label: "90d", long: "90 days" }
];

const TAB_OPTIONS: readonly { value: UsageTab; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" }
];

/** The agent filter: "All agents", or a checkbox per agent (multi-select; the menu stays open). */
const AgentFilter: React.FC<{
  agents: readonly string[];
  hidden: readonly string[];
  onChange: (hidden: string[]) => void;
}> = ({ agents, hidden, onChange }) => {
  const shown = agents.filter((id) => !hidden.includes(id));
  const label =
    shown.length === agents.length
      ? "All agents"
      : shown.length === 0
        ? "No agents"
        : shown.length === 1
          ? labelForAgent(shown[0]!)
          : `${shown.length} agents`;
  const toggle = (id: string) => onChange(hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);
  const check = (on: boolean) => (
    <Check size={14} aria-hidden className={on ? "text-neutral-200" : "invisible"} />
  );
  return (
    <AdaptiveMenu
      title="Agents"
      align="left"
      width="w-56"
      triggerClassName="rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      trigger={
        <span
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
          aria-label={`Agents: ${label}`}
        >
          {label}
          <ChevronDown size={13} aria-hidden className="text-neutral-500" />
        </span>
      }
    >
      <DropdownItem
        keepOpen
        role="menuitemcheckbox"
        aria-checked={hidden.length === 0}
        icon={check(hidden.length === 0)}
        onClick={() => onChange(hidden.length === 0 ? [...agents] : [])}
      >
        All agents
      </DropdownItem>
      <DropdownSeparator />
      {agents.map((id) => (
        <DropdownItem
          key={id}
          keepOpen
          role="menuitemcheckbox"
          aria-checked={!hidden.includes(id)}
          icon={check(!hidden.includes(id))}
          onClick={() => toggle(id)}
        >
          <span className="flex items-center gap-2">
            <span className="shrink-0">{getRegistryIcon("agent", id, 14)}</span>
            {labelForAgent(id)}
          </span>
        </DropdownItem>
      ))}
    </AdaptiveMenu>
  );
};

/** What the Cost / Tokens tabs show instead of (or over) the figures: a too-old daemon, or a failure. */
const Notice: React.FC<{ kind: "too-old" | "failed"; children: React.ReactNode; action?: React.ReactNode }> = ({ kind, children, action }) => (
  <div
    data-usage-notice={kind}
    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm text-neutral-300"
  >
    <span>{children}</span>
    {action}
  </div>
);

export const UsageView: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const connectionId = useAppStore((s) => s.activeConnectionId);
  const requestedTab = useAppStore((s) => s.usageViewTab);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const [prefs, setPrefs] = useState<UsageViewPrefs>(() => {
    const saved = readUsageViewPrefs();
    return requestedTab ? { ...saved, tab: requestedTab } : saved;
  });
  const [prices, setPrices] = useState<{ open: boolean; model: string | null }>({ open: false, model: null });
  const [limitsRefreshing, setLimitsRefreshing] = useState(false);
  const timeZone = useMemo(() => localTimeZone(), []);
  const { tab, range } = prefs;
  const metricTab = tab !== "limits";

  const update = useCallback((patch: Partial<UsageViewPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writeUsageViewPrefs(next);
      return next;
    });
  }, []);

  // `openUsageView(tab)` asks for a tab for this opening (also while the view already shows);
  // taken once, so asking for the same tab again later still lands.
  useEffect(() => {
    if (requestedTab === null) return;
    setPrefs((current) => (current.tab === requestedTab ? current : { ...current, tab: requestedTab }));
    useAppStore.setState({ usageViewTab: null });
  }, [requestedTab]);

  const history = useUsageHistory(api, connectionId, range, timeZone, metricTab);
  const { data, error } = history.state;
  const loading = usageHistoryLoading(history.state, range);
  const updating = usageHistoryUpdating(history.state);

  const agents = useMemo(
    () => sortAgents([...USAGE_AGENT_ORDER, ...(data?.buckets.map((b) => b.agent) ?? []), ...prefs.hiddenAgents]),
    [data, prefs.hiddenAgents]
  );

  const refresh = useCallback(() => {
    if (tab !== "limits") {
      history.refetch(true);
      return;
    }
    setLimitsRefreshing(true);
    void loadUsage(true).finally(() => setLimitsRefreshing(false));
  }, [tab, history, loadUsage]);
  const refreshing = metricTab ? updating : limitsRefreshing;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = resolveUsageShortcut(event, { tab, layerOpen: isAnyLayerOpen() });
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.kind === "tab") update({ tab: shortcut.tab });
      else update({ range: shortcut.range });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, update]);

  const openPrices = useCallback((model: string | null) => setPrices({ open: true, model }), []);
  const viewRef = useRef<HTMLDivElement | null>(null);
  /** The model the closed editor was opened for (null: from the menu); undefined while none closed. */
  const returnFocus = useRef<string | null | undefined>(undefined);
  const closePrices = useCallback(() => {
    returnFocus.current = prices.model;
    setPrices({ open: false, model: null });
  }, [prices.model]);

  // What opened the editor (the model dialog's Set price, a menu item) is gone by the time it
  // closes, which would leave focus on <body>: land on the model's row, else on the view. Run
  // after the Modal's own restore, so an opener that still exists keeps that role.
  useEffect(() => {
    if (prices.open || returnFocus.current === undefined) return undefined;
    const model = returnFocus.current;
    returnFocus.current = undefined;
    const timer = setTimeout(() => {
      const view = viewRef.current;
      const active = document.activeElement;
      if (!view?.isConnected || (active !== null && active !== document.body)) return;
      const row = [...view.querySelectorAll<HTMLElement>("[data-usage-model]")].find((el) => el.dataset.usageModel === model);
      (row ?? view).focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [prices.open]);

  const content = !metricTab ? (
    <UsageLimitsPanel active />
  ) : error === "too-old" ? (
    <Notice kind="too-old">This daemon is too old to report usage history. Update it to see this view.</Notice>
  ) : (
    <>
      {error === "failed" ? (
        <Notice
          kind="failed"
          action={
            <Button size="sm" variant="outline" onClick={() => history.refetch(false)}>
              Retry
            </Button>
          }
        >
          Couldn't load usage.
        </Notice>
      ) : null}
      {data ? (
        <UsageOverviewPanel
          data={data}
          metric={tab === "tokens" ? "tokens" : "cost"}
          hiddenAgents={prefs.hiddenAgents}
          loading={loading}
          breakdown={prefs.breakdown}
          onBreakdownChange={(breakdown) => update({ breakdown })}
          onSetPrice={(model) => openPrices(model)}
        />
      ) : error === null ? (
        <UsageOverviewSkeleton />
      ) : null}
    </>
  );

  return (
    <div ref={viewRef} tabIndex={-1} data-usage-view className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            {metricTab ? (
              <>
                <span data-usage-window className="truncate text-sm font-medium tabular-nums text-neutral-200">
                  {data ? formatWindow(data.periods, data.resolution, data.timeZone) : " "}
                </span>
                <AgentFilter agents={agents} hidden={prefs.hiddenAgents} onChange={(hiddenAgents) => update({ hiddenAgents })} />
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Hidden on Limits but keeping its slot, so the tabs don't shift. */}
            <div className={cn(!metricTab && "invisible")} aria-hidden={!metricTab || undefined}>
              <SegmentedControl
                size="xs"
                ariaLabel="Period"
                value={range}
                onChange={(next) => update({ range: next })}
                options={RANGE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: shortcutTitle(o.long, USAGE_RANGE_SHORTCUTS[o.value]) }))}
              />
            </div>
            <SegmentedControl
              size="xs"
              ariaLabel="Usage tab"
              value={tab}
              onChange={(next) => update({ tab: next })}
              options={TAB_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: shortcutTitle(o.label, USAGE_TAB_SHORTCUTS[o.value]) }))}
            />
            <IconButton
              label={metricTab ? "Refresh usage" : "Refresh limits"}
              aria-busy={refreshing || undefined}
              disabled={refreshing}
              onClick={refresh}
            >
              <RefreshCw size={14} aria-hidden className={cn(refreshing && "motion-safe:animate-spin")} />
            </IconButton>
            <AdaptiveMenu
              title="Usage"
              align="right"
              width="w-48"
              triggerClassName="rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
              trigger={
                // A span, not a button: the menu wraps its trigger in its own <button>.
                <span
                  title="More"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  <MoreHorizontal size={15} aria-hidden />
                  <span className="sr-only">More usage actions</span>
                </span>
              }
            >
              <DropdownItem icon={<SlidersHorizontal size={14} />} onClick={() => openPrices(null)}>
                Model prices…
              </DropdownItem>
            </AdaptiveMenu>
          </div>
        </div>
        <div className="relative flex flex-col gap-6">
          {metricTab && updating ? (
            <div
              role="status"
              className="pointer-events-none absolute -top-5 right-0 z-10 flex items-center gap-1.5 text-[11px] text-neutral-400"
            >
              <Loader2 size={12} aria-hidden className="motion-safe:animate-spin" />
              Updating…
            </div>
          ) : null}
          {content}
        </div>
      </div>
      <UsagePricesDialog open={prices.open} initialModel={prices.model} onClose={closePrices} />
    </div>
  );
};

export default UsageView;
