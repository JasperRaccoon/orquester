import React, { useContext, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Gauge, RefreshCw } from "lucide-react";
import type { AgentUsage, UsageAccount, UsageTokenRow } from "@orquester/api";
import { shortAccountLabel } from "../../lib/account-label";
import { usageAgentEnabled } from "@orquester/config";
import { AdaptiveMenu, DropdownContext } from "../ui";
import { SegmentedControl } from "../settings/primitives";
import { UsageAccountCard, maxWindowCount } from "./UsageAccountCard";
import { getRegistryIcon } from "../../icons";
import { useUsageNow, useUsageResetFormat } from "../../hooks";
import { useAppStore } from "../../store/app";
import { STALE_MIN, compactCount, formatAgo, formatChipWindows, formatClock, gaugeClass, labelForAgent, minutesSince, missingUsageAgents, normalizeUsageWindows, pickDriver, usageLoginHint, windowMax } from "./usage-format";

/** "claude-opus-4-8-20260115" → "Opus 4.8", "gpt-5.6-sol" → "GPT-5.6 Sol". */
function labelForModel(model: string): string {
  const bare = model.replace(/-\d{8}$/, "");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const claude = bare.match(/^claude-([a-z]+)-([\d-]+)$/);
  if (claude) return `${cap(claude[1])} ${claude[2].replace(/-/g, ".")}`;
  const gpt = bare.match(/^gpt-([\d.]+)(?:-([a-z-]+))?$/);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split("-").map(cap).join(" ")}` : ""}`;
  return bare;
}

/** Adaptive precision: tiny costs keep 4 decimals so they don't read as $0.00. */
function formatCost(v: number | null): string {
  if (v == null) return "—";
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/** UTC day string → "Today" / "Yesterday" / "Jul 21" (days are UTC-bucketed). */
function labelForDay(day: string, nowMs: number): string {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (day === iso(nowMs)) return "Today";
  if (day === iso(nowMs - 86_400_000)) return "Yesterday";
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

const CostTab: React.FC<{ rows: UsageTokenRow[] }> = ({ rows }) => {
  const now = Date.now();
  const visible = rows.filter((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0);
  const days: { day: string; rows: UsageTokenRow[]; total: number | null }[] = [];
  for (const r of visible) {
    let group = days.at(-1);
    if (!group || group.day !== r.day) {
      group = { day: r.day, rows: [], total: null };
      days.push(group);
    }
    group.rows.push(r);
    if (r.costUsd != null) group.total = (group.total ?? 0) + r.costUsd;
  }

  // Continuous last-14-day series for the spend chart (zero-usage days included
  // so gaps read as gaps, not missing bars).
  const totalByDay = new Map(days.map((d) => [d.day, d.total ?? 0]));
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const chart: { day: string; cost: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = isoDay(now - i * 86_400_000);
    chart.push({ day, cost: totalByDay.get(day) ?? 0 });
  }
  const chartMax = Math.max(...chart.map((c) => c.cost));
  const todayCost = totalByDay.get(isoDay(now)) ?? 0;
  const weekCost = chart.slice(-7).reduce((a, c) => a + c.cost, 0);
  const hasUnpriced = visible.some((r) => r.costUsd == null);

  if (visible.length === 0) {
    return (
      <div className="px-3 pb-3 pt-2">
        <div className="rounded border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
          No agent usage recorded yet. Costs appear after the next Claude Code or Codex session.
        </div>
      </div>
    );
  }

  return (
    <div className="pb-2">
      <div className="flex items-end justify-between px-3 pt-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">Est. cost · today</p>
          <p className="text-xl font-semibold leading-tight tabular-nums text-neutral-100">{formatCost(todayCost)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">7 days</p>
          <p className="text-xs font-medium tabular-nums text-neutral-300">{formatCost(weekCost)}</p>
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
                title={`${labelForDay(c.day, now)} · ${formatCost(c.cost)}`}
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
          <span>{labelForDay(chart[0].day, now)}</span>
          <span>Today</span>
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto px-3">
        {days.map((d) => (
          <div key={d.day} className="pt-2">
            <div className="flex items-baseline justify-between border-b border-neutral-800/80 pb-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{labelForDay(d.day, now)}</span>
              <span className="text-[11px] font-medium tabular-nums text-neutral-300">{formatCost(d.total)}</span>
            </div>
            {d.rows.map((r) => {
              const cache = r.cacheReadTokens + r.cacheWriteTokens;
              const bd = r.costBreakdown ?? null;
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
                    <span
                      className="shrink-0 text-xs tabular-nums text-neutral-200"
                      title={r.costUsd == null ? "No pricing data for this model" : undefined}
                    >
                      {formatCost(r.costUsd)}
                    </span>
                  </div>
                  {bd != null && bdTotal > 0 && (
                    <div
                      className="mt-1.5 flex h-1 gap-[2px]"
                      title={`Cost split — input ${formatCost(bd.input)} · output ${formatCost(bd.output)} · cache ${formatCost(bd.cache)}`}
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
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-700 align-middle" /> {compactCount(r.inputTokens)} in
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-500 align-middle" /> {compactCount(r.outputTokens)} out
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-600 align-middle" /> {compactCount(cache)} cache
                  </p>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mx-3 mt-2 border-t border-neutral-800/80 pt-2 text-[10px] leading-relaxed text-neutral-600">
        API-equivalent estimate, including prompt-cache reads and writes. Subscription usage isn't billed per token.
        {hasUnpriced && " Rows marked — have no pricing data and are excluded from totals."}
      </p>
    </div>
  );
};

const AccountRow: React.FC<{ agentId: string; account: UsageAccount }> = ({ agentId, account }) => {
  const [resetFormat] = useUsageResetFormat();
  const now = useUsageNow();
  const windows = normalizeUsageWindows(agentId, account);
  return (
    <UsageAccountCard
      name={shortAccountLabel(account.label) || account.id}
      meta={account.plan && <span className="text-[11px] text-neutral-500">{account.plan}</span>}
      windows={windows}
      muted={account.stale || windows.length === 0}
      resetFormat={resetFormat}
      now={now}
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
  const muted = !hasData || isOld;
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
            windows={normalizeUsageWindows(agent.id, agent)}
            muted={muted}
            resetFormat={resetFormat}
            now={now}
          />
        )}
      </div>
    </section>
  );
};

export const UsageWidget: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const usageTokens = useAppStore((s) => s.usageTokens);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const loadUsageTokens = useAppStore((s) => s.loadUsageTokens);
  const [tab, setTab] = useState<"windows" | "cost">("windows");

  // Fetch token/cost aggregates the first time the Cost tab is opened.
  useEffect(() => {
    if (tab === "cost" && !usageTokens) void loadUsageTokens();
  }, [tab, usageTokens, loadUsageTokens]);

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
  // viewport). The mobile bottom sheet stays stacked — AdaptiveMenu switches
  // at md, the same breakpoint as the `md:` classes below. The Cost tab keeps
  // its narrow width.
  const weights = agents.map(columnWeight);
  const windowsWidth = `${Math.round(weights.reduce((a, w) => a + w, 0) * 18)}rem`;

  return (
    <AdaptiveMenu title="Usage" trigger={trigger} align="right" width={tab === "cost" ? "w-80" : undefined}>
      <div
        className={tab === "windows" ? "md:w-[min(var(--usage-panel-w),calc(100vw_-_2rem))]" : undefined}
        style={{ "--usage-panel-w": windowsWidth } as React.CSSProperties}
      >
        <div className="flex items-center justify-between px-3 pt-2 text-[11px] text-neutral-500">
          <span>{freshestAsOf ? `Updated ${formatClock(freshestAsOf)}` : "Updating…"}</span>
          <button
            type="button"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={(e) => {
              e.stopPropagation();
              void loadUsage(true);
            }}
            aria-label="Refresh usage"
          >
            <RefreshCw size={13} />
          </button>
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
        {tab === "cost" ? <CostTab rows={usageTokens?.rows ?? []} /> : null}
      </div>
    </AdaptiveMenu>
  );
};
