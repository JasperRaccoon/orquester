import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Gauge, RefreshCw } from "lucide-react";
import type { AgentUsage, UsageAccount, UsageHistoryResponse } from "@orquester/api";
import { shortAccountLabel } from "../../lib/account-label";
import { usageAgentEnabled } from "@orquester/config";
import { AdaptiveMenu, DropdownContext } from "../ui";
import { SegmentedControl } from "../settings/primitives";
import { UsageAccountCard, maxWindowCount } from "./UsageAccountCard";
import { getRegistryIcon } from "../../icons";
import { useUsageNow, useUsageResetFormat } from "../../hooks";
import { ApiError, type ApiClient } from "../../lib/api-client";
import {
  formatCostFigure,
  formatTokens,
  formatUsd,
  labelForModel,
  localTimeZone,
  PARTLY_UNPRICED_NOTE,
  type CostFigure
} from "../../lib/usage-history-format";
import { onUsagePricesChanged } from "../../lib/usage-prices-events";
import { useAppStore } from "../../store/app";
import { popoverCostFromHistory, popoverCostFromTokenRows, type PopoverCostSummary } from "./usage-cost.logic";
import { STALE_MIN, formatAgo, formatChipWindows, formatClock, gaugeClass, labelForAgent, minutesSince, missingUsageAgents, normalizeUsageWindows, pickDriver, usageLoginHint, windowMax } from "./usage-format";

/**
 * The Cost tab's data: the Usage view's 14-day history (local days, every agent), or the older
 * `/api/usage/tokens` rows from a daemon without it (404) or while it fails. Kept per API client,
 * so one daemon's figures never show under another; refetched when the model prices change.
 * An answer taken mid-scan is shown, then asked for once more with `refresh=1` (as the view
 * does); when the history and the fallback both fail, `failed` says so instead of loading on.
 */
function usePopoverCost(): { summary: PopoverCostSummary | null; failed: boolean; load: (force?: boolean) => void } {
  const api = useAppStore((s) => s.api);
  const usageTokens = useAppStore((s) => s.usageTokens);
  const loadUsageTokens = useAppStore((s) => s.loadUsageTokens);
  const [history, setHistory] = useState<{ api: ApiClient; data: UsageHistoryResponse } | null>(null);
  const [legacyFor, setLegacyFor] = useState<ApiClient | null>(null);
  const [failedFor, setFailedFor] = useState<ApiClient | null>(null);
  const [tokensFailedFor, setTokensFailedFor] = useState<ApiClient | null>(null);
  const seq = useRef(0);
  const loaded = useRef(false);

  const load = useCallback(
    (force = false) => {
      if (!api) return;
      loaded.current = true;
      const id = ++seq.current;
      const loadTokens = () =>
        void loadUsageTokens(force).then((ok) => {
          if (id === seq.current) setTokensFailedFor(ok ? null : api);
        });
      if (legacyFor === api) {
        loadTokens();
        return;
      }
      const fetchHistory = (forced: boolean) =>
        api.getUsageHistory("14d", localTimeZone(), forced).then(
          (data) => {
            if (id !== seq.current) return;
            setHistory({ api, data });
            setFailedFor(null);
            // Mid-scan totals may still grow: ask once more, awaiting the scan.
            if (data.scanning && !forced) fetchHistory(true);
          },
          (error: unknown) => {
            if (id !== seq.current) return;
            if (error instanceof ApiError && error.status === 404) setLegacyFor(api);
            else setFailedFor(api);
            loadTokens();
          }
        );
      fetchHistory(force);
    },
    [api, legacyFor, loadUsageTokens]
  );

  // Saved prices reprice all history: refetch what the tab has shown.
  useEffect(() => onUsagePricesChanged(() => loaded.current && load()), [load]);

  const live = history?.api === api ? history.data : null;
  const fallback = legacyFor === api || failedFor === api;
  const summary = live
    ? popoverCostFromHistory(live)
    : fallback && usageTokens
      ? popoverCostFromTokenRows(usageTokens.rows, Date.now())
      : null;
  return { summary, failed: summary === null && fallback && tokensFailedFor === api, load };
}

/** The hover note of a cost figure that is not fully priced. */
function unpricedTitle(figure: CostFigure): string | undefined {
  if (figure.unpriced === "all") return "No known price";
  return figure.unpriced === "some" ? PARTLY_UNPRICED_NOTE : undefined;
}

const CostTab: React.FC<{ summary: PopoverCostSummary | null; failed: boolean; load: () => void }> = ({ summary, failed, load }) => {
  // Mounted while the popover shows the tab: each opening asks for fresh figures.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => loadRef.current(), []);

  if (failed) {
    return (
      <div className="px-3 pb-3 pt-2">
        <div className="flex items-center justify-between gap-3 rounded border border-dashed border-neutral-800 px-3 py-3 text-xs text-neutral-400">
          <span role="alert">Couldn't load costs.</span>
          <button
            type="button"
            className="rounded px-2 py-1 text-neutral-200 hover:bg-neutral-800"
            onClick={(e) => {
              e.stopPropagation();
              load();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!summary || summary.days.length === 0) {
    return (
      <div className="px-3 pb-3 pt-2">
        <div className="rounded border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
          {summary ? "No agent usage recorded yet. Costs appear after the next agent session." : "Loading…"}
        </div>
      </div>
    );
  }

  const { chart, days } = summary;
  const chartMax = Math.max(...chart.map((c) => c.cost));
  return (
    <div className="pb-2">
      <div className="flex items-end justify-between px-3 pt-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">Est. cost · today</p>
          <p className="text-xl font-semibold leading-tight tabular-nums text-neutral-100" title={unpricedTitle(summary.today)}>
            {formatCostFigure(summary.today, "Unpriced")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">7 days</p>
          <p className="text-xs font-medium tabular-nums text-neutral-300" title={unpricedTitle(summary.week)}>
            {formatCostFigure(summary.week, "Unpriced")}
          </p>
        </div>
      </div>
      <div className="px-3 pt-2">
        <div className="flex h-12 items-end gap-[2px]">
          {chart.map((c, i) => {
            const pct = chartMax > 0 ? (c.cost / chartMax) * 100 : 0;
            const isToday = i === chart.length - 1;
            return (
              <div
                key={c.day}
                className="group flex h-full flex-1 items-end"
                title={`${c.label} · ${formatCostFigure({ usd: c.cost, unpriced: c.unpriced }, "Unpriced")}`}
              >
                <div
                  className={`w-full rounded-t-[2px] ${
                    isToday ? "bg-neutral-200" : "bg-neutral-500 group-hover:bg-neutral-300"
                  }`}
                  style={{ height: c.cost > 0 ? `max(${pct}%, 2px)` : "1px" }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between pt-0.5 text-[9px] text-neutral-600">
          <span>{chart[0]?.label}</span>
          <span>Today</span>
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto px-3">
        {days.map((d) => (
          <div key={d.day} className="pt-2">
            <div className="flex items-baseline justify-between border-b border-neutral-800/80 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{d.label}</span>
              <span className="text-[11px] font-medium tabular-nums text-neutral-300" title={unpricedTitle(d.total)}>
                {formatCostFigure(d.total)}
              </span>
            </div>
            {d.rows.map((r) => {
              const bd = r.split;
              const bdTotal = bd ? bd.input + bd.output + bd.cache : 0;
              const seg = (n: number) => `${(n / bdTotal) * 100}%`;
              return (
                <div
                  key={`${r.agent}-${r.model}`}
                  className="-mx-1 rounded px-1 py-1.5 hover:bg-neutral-800/50"
                  title={`${labelForAgent(r.agent)} · ${r.model}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0">{getRegistryIcon("agent", r.agent, 14)}</span>
                      <p className="truncate text-xs text-neutral-200">{labelForModel(r.model)}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-neutral-200" title={unpricedTitle(r.cost)}>
                      {formatCostFigure(r.cost)}
                    </span>
                  </div>
                  {bd != null && bdTotal > 0 && (
                    <div
                      className="mt-1.5 flex h-1 gap-[2px]"
                      title={`Cost split — input ${formatUsd(bd.input)} · output ${formatUsd(bd.output)} · cache ${formatUsd(bd.cache)}`}
                    >
                      {bd.input > 0 && (
                        <div className="min-w-[3px] rounded-full bg-emerald-700" style={{ width: seg(bd.input) }} />
                      )}
                      {bd.output > 0 && (
                        <div className="min-w-[3px] rounded-full bg-fuchsia-500" style={{ width: seg(bd.output) }} />
                      )}
                      {bd.cache > 0 && (
                        <div className="min-w-[3px] rounded-full bg-sky-600" style={{ width: seg(bd.cache) }} />
                      )}
                    </div>
                  )}
                  <p className="mt-1 truncate text-[10px] tabular-nums text-neutral-500">
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-700 align-middle" /> {formatTokens(r.input)} in
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-500 align-middle" /> {formatTokens(r.output)} out
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-600 align-middle" /> {formatTokens(r.cache)} cache
                  </p>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mx-3 mt-2 border-t border-neutral-800/80 pt-2 text-[10px] leading-relaxed text-neutral-600">
        API-equivalent estimate, including prompt-cache reads and writes. Subscription usage isn't billed per token.
        {summary.hasUnpriced && " — has no known price; a + marks a cost that leaves out usage with none."}
      </p>
    </div>
  );
};

/** The popover header's way to the Usage view, on the tab matching the popover's (Windows → Limits). */
const OpenUsageLink: React.FC<{ tab: "windows" | "cost" }> = ({ tab }) => {
  const openUsageView = useAppStore((s) => s.openUsageView);
  const { close } = useContext(DropdownContext);
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded px-1.5 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      onClick={() => {
        close();
        openUsageView(tab === "cost" ? "cost" : "limits");
      }}
    >
      Open usage
      <ArrowUpRight size={12} aria-hidden />
    </button>
  );
};

const AccountRow: React.FC<{ agentId: string; account: UsageAccount }> = ({ agentId, account }) => {
  const [resetFormat] = useUsageResetFormat();
  const now = useUsageNow();
  const windows = normalizeUsageWindows(agentId, account.lastKnown ?? account);
  return (
    <UsageAccountCard
      name={shortAccountLabel(account.label) || account.id}
      meta={account.plan && <span className="text-[11px] text-neutral-500">{account.plan}</span>}
      windows={windows}
      muted={account.stale || windows.length === 0}
      resetFormat={resetFormat}
      now={now}
      login={account}
      lastKnown={account.stale || !!account.lastKnown}
      asOf={account.lastKnown?.asOf ?? account.asOf}
    />
  );
};

/** Column flex weight: a 3-window agent (Claude) gets ~1.9× a week-only one. */
function columnWeight(agent: AgentUsage): number {
  return 1 + 0.45 * (maxWindowCount(agent) - 1);
}

const AgentSection: React.FC<{ agent: AgentUsage }> = ({ agent }) => {
  // Ticks with the shared minute timer so "Updated 12m ago" ages while the
  // panel stays open, in step with the countdowns below it.
  const now = useUsageNow();
  const [resetFormat] = useUsageResetFormat();
  const openSettings = useAppStore((s) => s.openSettings);
  const { close } = useContext(DropdownContext);
  const hasTimestamp = Boolean(agent.asOf);
  const accounts = agent.accounts ?? [];
  const hasData = hasTimestamp && (agent.session || agent.weekly || agent.scopedWindows?.length || accounts.length > 0);
  const isOld = hasTimestamp && minutesSince(agent.asOf, now) > STALE_MIN;
  const muted = !hasData || isOld || agent.stale;
  const label = labelForAgent(agent.id);

  return (
    <section className="flex h-full flex-col rounded-lg border border-neutral-800 bg-neutral-900/40">
      <header className="flex items-center gap-2 py-2 pl-3 pr-1.5">
        <span className="shrink-0">{getRegistryIcon("agent", agent.id, 16)}</span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">{label} Usage</p>
        {/* Per-account cards carry their own plan; only show it here when pooled. */}
        {accounts.length === 0 && agent.plan && <span className="shrink-0 text-[11px] text-neutral-500">{agent.plan}</span>}
        <button
          type="button"
          className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          aria-label={`Open ${label} usage settings`}
          title="Open usage settings"
          onClick={() => {
            close();
            openSettings("usage");
          }}
        >
          <ChevronRight size={15} />
        </button>
      </header>
      {!hasData ? (
        <p className="px-3 pb-2 text-[11px] text-warn">Signed in — usage updating…</p>
      ) : isOld ? (
        <p className="px-3 pb-2 text-[11px] text-warn">Updated {formatAgo(agent.asOf, now)}</p>
      ) : null}
      <div className="space-y-2 px-2 pb-2">
        {accounts.length > 0 ? (
          <>
            {accounts.map((a) => (
              <AccountRow key={a.id} agentId={agent.id} account={a} />
            ))}
            {/* The System (daemon-home) login pools into the worst-account head
                numbers, so it must be visible — hidden, it can drive the chip
                above every listed account. */}
            {agent.system && <AccountRow key={agent.system.id} agentId={agent.id} account={agent.system} />}
          </>
        ) : (
          /* Same card chrome as AccountRow so week-only agents align with Claude/Codex. */
          <UsageAccountCard
            windows={normalizeUsageWindows(agent.id, agent.lastKnown ?? agent)}
            muted={muted}
            resetFormat={resetFormat}
            now={now}
            login={agent}
            lastKnown={agent.stale || !!agent.lastKnown}
            asOf={agent.lastKnown?.asOf ?? agent.asOf}
          />
        )}
      </div>
    </section>
  );
};

export const UsageWidget: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const [tab, setTab] = useState<"windows" | "cost">("windows");
  const cost = usePopoverCost();

  if (!prefs.enabled || !usage) return null;
  const agents = usage.agents.filter((a) => a.available && usageAgentEnabled(prefs, a.id));
  if (agents.length === 0) return null;

  const driver = pickDriver(agents, prefs.chip);
  if (!driver) return null;

  // Included agents that are enabled in prefs but aren't logged in (so not present
  // in the live snapshot) get a muted, actionable row in the panel.
  const missing = missingUsageAgents(prefs, usage.agents.map((a) => a.id));
  // Honest "as of": the most recent successful reading among the shown agents.
  const freshestAsOf = agents
    .map((a) => a.asOf)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);

  const chipText = formatChipWindows(driver);
  // Color by usage level whenever we have a number (even if stale — the value is
  // still real); grey only when there's no reading yet.
  const gauge = driver.session || driver.weekly ? gaugeClass(windowMax(driver)) : "text-neutral-600";
  const trigger = (
    <span className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800">
      {getRegistryIcon("agent", driver.id, 13)}
      <Gauge size={13} className={gauge} />
      <span>{chipText}</span>
      <ChevronDown size={13} className="text-neutral-500" />
    </span>
  );

  // One column per agent on the Windows tab so three agents with several
  // accounts each read side by side instead of one screen-height stack. Each
  // column is weighted by how many windows its cards lay side by side, and the
  // desktop dropdown's width follows the summed weight (capped to the
  // viewport): the content below carries that width and the panel is `w-max`
  // around it — leaving `width` unset would fall back to the Dropdown's own
  // `w-56` and scroll the columns sideways inside it. The mobile bottom sheet
  // stays stacked — AdaptiveMenu switches at md, the same breakpoint as the
  // `md:` classes below. The Cost tab keeps its narrow width.
  const weights = agents.map(columnWeight);
  const windowsWidth = `${Math.round(weights.reduce((a, w) => a + w, 0) * 18)}rem`;

  return (
    <AdaptiveMenu title="Usage" trigger={trigger} align="right" width={tab === "cost" ? "w-80" : "w-max"}>
      <div
        // `max-w-full` gives back the vertical scrollbar's width when the
        // panel is taller than the viewport.
        className={tab === "windows" ? "md:w-[min(var(--usage-panel-w),calc(100vw_-_2rem))] md:max-w-full" : undefined}
        style={{ "--usage-panel-w": windowsWidth } as React.CSSProperties}
      >
        <div className="flex items-center justify-between px-3 pt-2 text-[11px] text-neutral-500">
          <span>{freshestAsOf ? `Updated ${formatClock(freshestAsOf)}` : "Updating…"}</span>
          <div className="flex items-center gap-0.5">
            <OpenUsageLink tab={tab} />
            <button
              type="button"
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              onClick={(e) => {
                e.stopPropagation();
                void loadUsage(true);
                if (tab === "cost") cost.load(true);
              }}
              aria-label="Refresh usage"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>
        <div className="px-3 pb-1 pt-1">
          <SegmentedControl
            size="xs"
            ariaLabel="Usage view"
            value={tab}
            onChange={setTab}
            options={[
              { value: "windows", label: "Windows" },
              { value: "cost", label: "Cost" }
            ]}
          />
        </div>
        {tab === "windows" ? (
          <>
            <div className="flex flex-col gap-2 p-2 md:flex-row md:items-stretch">
              {agents.map((a, i) => (
                <div key={a.id} className="min-w-0 md:basis-0" style={{ flexGrow: weights[i] }}>
                  <AgentSection agent={a} />
                </div>
              ))}
            </div>
            {missing.map((id) => (
              <div key={id} className="px-3 pb-2 text-xs text-neutral-500">
                {labelForAgent(id)} — not logged in <span className="text-neutral-600">({usageLoginHint(id)})</span>
              </div>
            ))}
          </>
        ) : null}
        {tab === "cost" ? <CostTab summary={cost.summary} failed={cost.failed} load={cost.load} /> : null}
      </div>
    </AdaptiveMenu>
  );
};
