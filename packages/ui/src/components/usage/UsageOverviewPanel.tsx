import React, { useMemo, useState } from "react";
import { Info } from "lucide-react";

import type { UsageHistoryResponse } from "@orquester/api";

import { getRegistryIcon } from "../../icons/registry-icons";
import { cn } from "../../lib/cn";
import { agentColor, formatCount, formatPercent, formatTokens, formatUsd } from "../../lib/usage-history-format";
import { labelForAgent } from "../topbar/usage-format";
import type { UsageMetric, UsageOverviewPanelProps } from "./types";
import { UsageBreakdown } from "./UsageBreakdown";
import { UsageChart } from "./UsageChart";
import { UsageModelDialog } from "./UsageModelDialog";
import { costTypeSegments, speedCostSegments, tokenTypeSegments, UsageShareBar } from "./UsageShareBar";
import { deriveModelDetail, deriveUsageView, type UsageAgentRow, type UsageView } from "./usage-view.logic";

/** Kept figures fade (after a beat, so a quick answer never flickers) while newer data loads. */
function figureClass(loading: boolean): string {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

const plural = (n: number, one: string) => `${formatCount(n)} ${n === 1 ? one : `${one}s`}`;

/** The Cost / Tokens tabs: hero totals by agent, the trend chart, totals, share bars and the breakdown. */
export const UsageOverviewPanel: React.FC<UsageOverviewPanelProps> = ({
  data,
  metric,
  hiddenAgents,
  loading,
  breakdown,
  onBreakdownChange,
  onSetPrice
}) => {
  const view = useMemo(() => deriveUsageView(data, metric, hiddenAgents), [data, metric, hiddenAgents]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const detail = useMemo(
    () => (selectedModel === null ? null : deriveModelDetail(data, selectedModel, metric, hiddenAgents)),
    [data, selectedModel, metric, hiddenAgents]
  );
  const figures = figureClass(loading);
  const hourly = data.resolution === "hour";
  const format = metric === "cost" ? formatUsd : formatTokens;
  const chartTitle = `${hourly ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "processed tokens"} by agent`;

  return (
    <div aria-busy={loading} className="flex flex-col gap-8">
      <section className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-8">
        <Hero view={view} metric={metric} figures={figures} />
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium text-neutral-100">{chartTitle}</h2>
          <div className={figures}>
            <UsageChart
              periods={data.periods}
              resolution={data.resolution}
              timeZone={data.timeZone}
              series={view.series}
              format={format}
              ariaLabel={chartTitle}
            />
          </div>
        </div>
      </section>

      <Totals view={view} hourly={hourly} figures={figures} />

      {view.totals.processed > 0 ? (
        <section className={cn("grid gap-x-12 gap-y-7 lg:grid-cols-2", figures)}>
          {metric === "cost" ? (
            <UsageShareBar label="Cost by type" segments={costTypeSegments(view.totals.costByType)} format={formatUsd} />
          ) : null}
          <UsageShareBar label="Tokens by type" segments={tokenTypeSegments(view.totals.tokens)} format={formatTokens} />
          {metric === "cost" && view.totals.costBySpeed.fast + view.totals.costBySpeed.ultrafast > 0 ? (
            <UsageShareBar label="Cost by speed" segments={speedCostSegments(view.totals.costBySpeed)} format={formatUsd} />
          ) : null}
        </section>
      ) : null}

      <UsageBreakdown
        view={view}
        metric={metric}
        resolution={data.resolution}
        timeZone={data.timeZone}
        mode={breakdown}
        onModeChange={onBreakdownChange}
        onSelectModel={setSelectedModel}
        figures={figures}
      />

      <Footnotes data={data} view={view} />

      <UsageModelDialog
        detail={detail}
        periods={data.periods}
        resolution={data.resolution}
        timeZone={data.timeZone}
        onClose={() => setSelectedModel(null)}
        onSetPrice={onSetPrice}
      />
    </div>
  );
};

const Hero: React.FC<{ view: UsageView; metric: UsageMetric; figures: string }> = ({ view, metric, figures }) => {
  const { totals } = view;
  const unknownTotal = metric === "cost" && totals.costUsd === null;
  const unpricedNote = `Excludes ${formatPercent(totals.unpricedShare)} of tokens with no known price`;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span
          className={cn(
            "text-4xl font-semibold tracking-tight tabular-nums",
            unknownTotal ? "text-neutral-500" : "text-neutral-50",
            figures
          )}
        >
          {metric === "cost" ? (unknownTotal ? "Unpriced" : formatUsd(totals.costUsd)) : formatTokens(totals.processed)}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-neutral-500">
          <span>
            <span className={figures}>{plural(totals.sessions, "session")}</span>
            {metric === "cost" ? " · API estimate" : ""}
          </span>
          {metric === "cost" && totals.unpricedTokens > 0 ? (
            <span
              role="img"
              tabIndex={0}
              aria-label={unpricedNote}
              title={unpricedNote}
              className="inline-flex cursor-help rounded text-neutral-500 outline-none hover:text-neutral-300 focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              <Info size={12} aria-hidden />
            </span>
          ) : null}
        </span>
      </div>
      {view.agentRows.length > 0 ? (
        <ul className="flex flex-col gap-3.5">
          {view.agentRows.map((row) => (
            <AgentRow key={row.agent} row={row} metric={metric} figures={figures} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-neutral-500">No activity in this window.</p>
      )}
    </div>
  );
};

const AgentRow: React.FC<{ row: UsageAgentRow; metric: UsageMetric; figures: string }> = ({ row, metric, figures }) => {
  const unpriced = row.costUsd === null;
  const value =
    metric === "cost" ? (unpriced ? <span className="text-neutral-500">Unpriced</span> : formatUsd(row.costUsd)) : formatTokens(row.processed);
  const share =
    metric === "cost"
      ? row.costShare === null
        ? `${formatTokens(row.processed)} tokens · no known price`
        : `${formatPercent(row.costShare)} of cost · ${formatTokens(row.processed)} tokens`
      : `${formatPercent(row.tokenShare)} of tokens · ${unpriced ? "Unpriced" : formatUsd(row.costUsd)}`;
  const detail = `${plural(row.sessions, "session")} · ${share}`;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2 text-sm text-neutral-100">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: agentColor(row.agent) }} />
          <span className="shrink-0 self-center">{getRegistryIcon("agent", row.agent, 16)}</span>
          <span className="truncate">{labelForAgent(row.agent)}</span>
        </span>
        <span className={cn("shrink-0 text-sm font-medium tabular-nums text-neutral-100", figures)}>{value}</span>
      </div>
      <span className={cn("pl-4 text-xs tabular-nums text-neutral-500", figures)}>{detail}</span>
    </li>
  );
};

const Totals: React.FC<{ view: UsageView; hourly: boolean; figures: string }> = ({ view, hourly, figures }) => {
  const t = view.totals;
  const cells: { label: string; value: string; detail: string }[] = [
    {
      label: "Processed tokens",
      value: formatTokens(t.processed),
      detail: t.activePeriods > 0 ? `${formatTokens(t.processedPerActivePeriod)} per active ${hourly ? "hour" : "day"}` : "No activity"
    },
    { label: "Cached input", value: formatTokens(t.tokens.cacheRead), detail: `${formatPercent(t.cachedInputShare)} of input` },
    { label: "Uncached input", value: formatTokens(t.tokens.input), detail: `${formatTokens(t.tokens.cacheWrite)} cache writes` },
    { label: "Output", value: formatTokens(t.tokens.output), detail: `incl. ${formatTokens(t.tokens.reasoning)} reasoning` },
    { label: "Cache savings", value: formatUsd(t.cacheSavingsUsd), detail: "vs full input rates" }
  ];
  if (t.unpricedTokens > 0) {
    cells.push({
      label: "Unpriced",
      value: formatTokens(t.unpricedTokens),
      detail: `${formatPercent(t.unpricedShare)} of tokens, excluded from cost`
    });
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-neutral-100">Totals</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-4 md:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="truncate text-xs text-neutral-500">{c.label}</dt>
            <dd className={cn("text-base font-semibold tabular-nums text-neutral-100", figures)}>{c.value}</dd>
            <dd className={cn("text-[11px] leading-snug text-neutral-500", figures)}>
              {c.detail}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

function orquesterOnlyNote(data: UsageHistoryResponse, view: UsageView): string | null {
  const chatsOnly = new Set(data.sources.filter((s) => s.scope === "orquester-chats").map((s) => s.agent));
  const agents = view.agents.filter((a) => chatsOnly.has(a) || a === "grok" || a === "opencode");
  if (agents.length === 0) return null;
  const names = agents.map(labelForAgent);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  return `${list} count${names.length === 1 ? "s" : ""} only Orquester chats.`;
}

function recordedSinceNote(data: UsageHistoryResponse): string | null {
  if (!data.recordedSince) return null;
  const recorded = Date.parse(data.recordedSince);
  const since = Date.parse(data.since);
  if (!Number.isFinite(recorded) || !Number.isFinite(since) || recorded <= since) return null;
  let date: string;
  try {
    date = new Date(recorded).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: data.timeZone });
  } catch {
    date = new Date(recorded).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  return `Claude Code keeps transcripts for 30 days; Orquester has recorded usage since ${date}.`;
}

const Footnotes: React.FC<{ data: UsageHistoryResponse; view: UsageView }> = ({ data, view }) => {
  const notes = [
    "API-equivalent estimate at list prices, including prompt-cache reads and writes. Subscription usage isn't billed per token.",
    orquesterOnlyNote(data, view),
    recordedSinceNote(data)
  ].filter((n): n is string => n !== null);
  return (
    <footer className="flex flex-col gap-1 border-t border-neutral-800/70 pt-4 text-xs leading-relaxed text-neutral-500">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </footer>
  );
};

const Block: React.FC<{ className?: string }> = ({ className }) => (
  <div aria-hidden className={cn("animate-pulse rounded-md bg-neutral-800/60", className)} />
);

/** First-load placeholder mirroring {@link UsageOverviewPanel}'s layout. */
export const UsageOverviewSkeleton: React.FC = () => (
  <div role="status" aria-label="Loading usage" className="flex flex-col gap-8">
    <section className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-8">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Block className="h-10 w-44" />
          <Block className="h-3 w-32" />
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-4">
                <Block className="h-4 w-36" />
                <Block className="h-4 w-16" />
              </div>
              <Block className="ml-4 h-3 w-40" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Block className="h-4 w-40" />
        <div className="flex gap-2">
          <div className="w-12 shrink-0 sm:w-14" />
          <Block className="h-56 flex-1" />
        </div>
        <div className="flex justify-between pl-14 sm:pl-16">
          <Block className="h-2.5 w-10" />
          <Block className="h-2.5 w-10" />
          <Block className="h-2.5 w-10" />
        </div>
      </div>
    </section>
    <section className="flex flex-col gap-3">
      <Block className="h-4 w-16" />
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-4 md:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Block className="h-3 w-20" />
            <Block className="h-5 w-14" />
            <Block className="h-2.5 w-24" />
          </div>
        ))}
      </div>
    </section>
    <section className="grid gap-x-12 gap-y-7 lg:grid-cols-2">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2.5">
          <Block className="h-4 w-28" />
          <Block className="h-2 w-full rounded-full" />
          <Block className="h-3 w-2/3" />
        </div>
      ))}
    </section>
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2.5">
        <Block className="h-4 w-20" />
        <Block className="h-6 w-44 rounded-lg" />
      </div>
      <div className="flex flex-col gap-3 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <Block className="h-3.5 w-1/3" />
            <Block className="h-3.5 w-24" />
          </div>
        ))}
      </div>
    </section>
  </div>
);
