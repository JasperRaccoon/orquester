import React, { useEffect, useState } from "react";
import { ChevronDown, Gauge, RefreshCw } from "lucide-react";
import type { AgentUsage, UsageAccount, UsageTokenRow, UsageWindow } from "@orquester/api";
import { usageAgentEnabled } from "@orquester/config";
import { AdaptiveMenu } from "../ui";
import { getRegistryIcon } from "../../icons";
import { useAppStore } from "../../store/app";
import { barClass, formatAgo, formatClock, formatCountdown, gaugeClass, minutesSince, missingUsageAgents, pickDriver, windowMax } from "./usage-format";
import { REGISTRY } from "@orquester/registry";

function labelForAgent(id: string): string {
  const entry = REGISTRY.agents?.find((a) => a.id === id);
  if (entry) return entry.name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

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

/** 84_812_345 → "84.8M", 137_333 → "137k", 616 → "616". */
function compactTokens(n: number): string {
  const fmt = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ""));
  if (n >= 1_000_000_000) return `${fmt(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmt(n / 1_000)}k`;
  return String(n);
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
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-700 align-middle" /> {compactTokens(r.inputTokens)} in
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-500 align-middle" /> {compactTokens(r.outputTokens)} out
                    <span className="mx-1 text-neutral-700">·</span>
                    <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-600 align-middle" /> {compactTokens(cache)} cache
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

const Bar: React.FC<{ label: string; window: UsageWindow | null; muted: boolean }> = ({ label, window, muted }) => {
  const pct = window?.percent ?? 0;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-300">{label}</span>
        <span className={muted ? "text-neutral-500" : "text-neutral-200"}>{window ? `${Math.round(pct)}%` : "—"}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full ${muted ? "bg-neutral-600" : barClass(pct)}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">{formatCountdown(window?.resetsAt, Date.now())}</p>
    </div>
  );
};

/** A reading older than this reads as stale in the panel. */
const STALE_MIN = 10;

const AccountRow: React.FC<{ account: UsageAccount }> = ({ account }) => {
  const muted = account.stale || !(account.session || account.weekly);
  return (
    <div className="border-t border-neutral-800/80 py-1.5 pl-2">
      <p className="truncate text-[11px] text-neutral-400">{account.label ?? account.id}</p>
      <Bar label="5h" window={account.session} muted={muted} />
      <Bar label="Week" window={account.weekly} muted={muted} />
    </div>
  );
};

const AgentSection: React.FC<{ agent: AgentUsage; view: "aggregate" | "accounts" }> = ({ agent, view }) => {
  const hasTimestamp = Boolean(agent.asOf);
  const hasData = hasTimestamp && (agent.session || agent.weekly || (agent.accounts && agent.accounts.length > 0));
  const isOld = hasTimestamp && minutesSince(agent.asOf, Date.now()) > STALE_MIN;
  const muted = !hasData || isOld;
  const multi = (agent.accounts?.length ?? 0) > 0;
  const showAccounts = multi && view === "accounts";

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm text-neutral-200">
          {getRegistryIcon("agent", agent.id, 14)}
          <span>{labelForAgent(agent.id)} Usage</span>
        </p>
        {agent.plan && <span className="text-xs text-neutral-500">{agent.plan}</span>}
      </div>
      {!hasData ? (
        <p className="text-[11px] text-amber-400">Signed in — usage updating…</p>
      ) : isOld ? (
        <p className="text-[11px] text-amber-400">Updated {formatAgo(agent.asOf, Date.now())}</p>
      ) : null}
      {multi && (
        <p className="mt-1 text-[11px] text-neutral-500">
          {agent.aggregate?.accountCount ?? agent.accounts!.length} accounts ·{" "}
          {view === "aggregate" ? "pooled" : "per account"}
        </p>
      )}
      {!showAccounts && (
        <>
          <Bar label="Current session (5 hours)" window={agent.session} muted={muted} />
          <Bar label="Current week" window={agent.weekly} muted={muted} />
        </>
      )}
      {showAccounts && agent.accounts!.map((a) => <AccountRow key={a.id} account={a} />)}
    </div>
  );
};

export const UsageWidget: React.FC = () => {
  const usage = useAppStore((s) => s.usage);
  const usageTokens = useAppStore((s) => s.usageTokens);
  const prefs = useAppStore((s) => s.appConfig.usage);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const loadUsageTokens = useAppStore((s) => s.loadUsageTokens);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const [localView, setLocalView] = useState<"aggregate" | "accounts" | null>(null);
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

  const view = localView ?? prefs.view ?? "aggregate";
  const hasMulti = agents.some((a) => (a.accounts?.length ?? 0) > 0);

  // Included agents that are enabled in prefs but aren't logged in (so not present
  // in the live snapshot) get a muted, actionable row in the panel.
  const missing = missingUsageAgents(prefs, usage.agents.map((a) => a.id));
  // Honest "as of": the most recent successful reading among the shown agents.
  const freshestAsOf = agents
    .map((a) => a.asOf)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);

  const cell = (w: AgentUsage["session"]) => (w ? `${Math.round(w.percent)}%` : "—");
  const chipText = `${cell(driver.session)} • ${cell(driver.weekly)}`;
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

  return (
    <AdaptiveMenu title="Usage" trigger={trigger} align="right" width="w-80">
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
      <div className="flex gap-1 px-3 pt-1">
        {(
          [
            ["windows", "Windows"],
            ["cost", "Cost"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded px-2 py-0.5 text-[11px] ${
              tab === id ? "bg-neutral-700 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setTab(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "windows" ? (
        <>
          {hasMulti && (
            <div className="flex gap-1 px-3 pt-1">
              {(
                [
                  ["aggregate", "Aggregated"],
                  ["accounts", "Per account"]
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`rounded px-2 py-0.5 text-[11px] ${
                    view === id ? "bg-neutral-700 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLocalView(id);
                    void updateAppConfig({ usage: { ...prefs, view: id } });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {agents.map((a) => (
            <AgentSection key={a.id} agent={a} view={view} />
          ))}
          {missing.map((id) => (
            <div key={id} className="px-3 py-2 text-xs text-neutral-500">
              {labelForAgent(id)} — not logged in <span className="text-neutral-600">(run {id} login)</span>
            </div>
          ))}
        </>
      ) : null}
      {tab === "cost" ? <CostTab rows={usageTokens?.rows ?? []} /> : null}
    </AdaptiveMenu>
  );
};
