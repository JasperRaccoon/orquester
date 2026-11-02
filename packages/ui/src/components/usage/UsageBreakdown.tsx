import React from "react";

import { getRegistryIcon } from "../../icons/registry-icons";
import { cn } from "../../lib/cn";
import { agentColor, formatCount, formatPercent, formatPeriodLong, formatTokens, formatUsd } from "../../lib/usage-history-format";
import { SegmentedControl } from "../settings/primitives";
import { labelForAgent } from "../topbar/usage-format";
import type { UsageBreakdownMode, UsageMetric } from "./types";
import type { UsageView } from "./usage-view.logic";

const TH = "px-3 py-2 font-medium";
const ROW = "border-b border-neutral-800/60 last:border-b-0 transition-colors hover:bg-neutral-800/40";
const TD = "px-3 py-2 text-xs tabular-nums";

const Empty: React.FC<{ colSpan: number }> = ({ colSpan }) => (
  <tr>
    <td colSpan={colSpan} className="px-3 py-8 text-center text-xs text-neutral-500">
      No activity in this window.
    </td>
  </tr>
);

const Unpriced: React.FC = () => <span className="text-neutral-500">Unpriced</span>;

export const UsageBreakdown: React.FC<{
  view: UsageView;
  metric: UsageMetric;
  resolution: "hour" | "day";
  timeZone: string;
  mode: UsageBreakdownMode;
  onModeChange: (mode: UsageBreakdownMode) => void;
  onSelectModel: (key: string) => void;
  /** Figures dim while newer data loads. */
  figures: string;
}> = ({ view, metric, resolution, timeZone, mode, onModeChange, onSelectModel, figures }) => (
  <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-3 py-2.5 sm:px-4">
      <h2 className="text-sm font-medium text-neutral-100">Breakdown</h2>
      <SegmentedControl<UsageBreakdownMode>
        size="xs"
        ariaLabel="Usage breakdown"
        value={mode}
        onChange={onModeChange}
        options={[
          { value: "model", label: "Model" },
          { value: "period", label: resolution === "hour" ? "Hour" : "Day" },
          { value: "project", label: "Project" }
        ]}
      />
    </div>
    {mode === "model" ? (
      <ModelTable view={view} metric={metric} onSelectModel={onSelectModel} figures={figures} />
    ) : mode === "period" ? (
      <PeriodTable view={view} resolution={resolution} timeZone={timeZone} figures={figures} />
    ) : (
      <ProjectTable view={view} figures={figures} />
    )}
  </section>
);

const HeadRow: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <tr
    className={cn(
      "border-b border-neutral-800 bg-neutral-900/60 text-right text-[10px] uppercase tracking-wider text-neutral-500",
      className
    )}
  >
    {children}
  </tr>
);

const ModelTable: React.FC<{
  view: UsageView;
  metric: UsageMetric;
  onSelectModel: (key: string) => void;
  figures: string;
}> = ({ view, metric, onSelectModel, figures }) => {
  const peak = view.models.reduce((max, m) => Math.max(max, m.value), 0);
  return (
    <table className="w-full text-left">
      <thead>
        <HeadRow>
          <th className={cn(TH, "w-8 text-left")}>#</th>
          <th className={cn(TH, "w-full pl-0 text-left")}>Model</th>
          <th className={TH}>Cost</th>
          <th className={cn(TH, "hidden sm:table-cell")}>Share</th>
          <th className={TH}>Tokens</th>
        </HeadRow>
      </thead>
      <tbody>
        {view.models.length === 0 ? (
          <Empty colSpan={5} />
        ) : (
          view.models.map((m, i) => {
            const share = metric === "cost" ? m.costShare : m.tokenShare;
            const hasBar = peak > 0 && m.value > 0;
            return (
              <tr
                key={m.key}
                className={cn(
                  ROW,
                  "relative whitespace-nowrap text-right text-neutral-400 has-[:focus-visible]:bg-neutral-800/50"
                )}
              >
                <td className={cn(TD, "text-left text-neutral-500")}>{i + 1}</td>
                <td className="whitespace-normal py-2 pr-3 text-left">
                  <button
                    type="button"
                    onClick={() => onSelectModel(m.key)}
                    title={`${labelForAgent(m.agent)} · ${m.model}`}
                    className={cn(
                      "flex min-w-0 items-center gap-2 text-left text-xs text-neutral-100 outline-none after:absolute after:inset-0 after:content-['']",
                      "focus-visible:underline focus-visible:decoration-neutral-500 focus-visible:underline-offset-4",
                      !hasBar && "py-1"
                    )}
                  >
                    <span className="shrink-0">{getRegistryIcon("agent", m.agent, 14)}</span>
                    <span className="break-all font-medium">{m.model}</span>
                  </button>
                  {hasBar ? (
                    <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", figures)}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `max(0.5rem, ${(m.value / peak) * 100}%)`, backgroundColor: agentColor(m.agent) }}
                      />
                    </div>
                  ) : null}
                </td>
                <td className={cn(TD, "text-neutral-100", figures)}>{m.costUsd === null ? <Unpriced /> : formatUsd(m.costUsd)}</td>
                <td className={cn(TD, "hidden sm:table-cell", figures)}>{share === null ? "" : formatPercent(share)}</td>
                <td className={cn(TD, figures)}>{formatTokens(m.processed)}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
};

const PeriodTable: React.FC<{
  view: UsageView;
  resolution: "hour" | "day";
  timeZone: string;
  figures: string;
}> = ({ view, resolution, timeZone, figures }) => (
  <div
    role="region"
    aria-label={resolution === "hour" ? "Usage by hour" : "Usage by day"}
    tabIndex={0}
    className="max-h-[28rem] overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
  >
    <table className="w-full whitespace-nowrap text-left">
      <thead className="sticky top-0 z-[1]">
        <HeadRow className="bg-neutral-900">
          <th className={cn(TH, "text-left")}>{resolution === "hour" ? "Hour" : "Day"}</th>
          {view.agents.map((agent) => (
            <th key={agent} className={TH}>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: agentColor(agent) }} />
                {labelForAgent(agent)}
              </span>
            </th>
          ))}
          <th className={TH}>Total</th>
          <th className={TH}>Tokens</th>
        </HeadRow>
      </thead>
      <tbody>
        {view.periodRows.length === 0 ? (
          <Empty colSpan={view.agents.length + 3} />
        ) : (
          view.periodRows.map((row) => (
            <tr key={row.period} className={ROW}>
              <td className={cn(TD, "text-left text-neutral-200")}>{formatPeriodLong(row.period, resolution, timeZone)}</td>
              {view.agents.map((agent) => {
                const cost = row.costByAgent[agent];
                return (
                  <td key={agent} className={cn(TD, "text-right text-neutral-400", figures)}>
                    {cost === undefined ? <span className="text-neutral-600">—</span> : cost === null ? <Unpriced /> : formatUsd(cost)}
                  </td>
                );
              })}
              <td className={cn(TD, "text-right text-neutral-100", figures)}>
                {row.costUsd === null ? <Unpriced /> : formatUsd(row.costUsd)}
              </td>
              <td className={cn(TD, "text-right text-neutral-400", figures)}>{formatTokens(row.processed)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

const ProjectTable: React.FC<{ view: UsageView; figures: string }> = ({ view, figures }) => (
  <div className="overflow-x-auto">
    <table className="w-full whitespace-nowrap text-left">
      <thead>
        <HeadRow>
          <th className={cn(TH, "w-full text-left")}>Project</th>
          <th className={TH}>Sessions</th>
          <th className={TH}>Cost</th>
          <th className={cn(TH, "hidden sm:table-cell")}>Share</th>
          <th className={TH}>Tokens</th>
        </HeadRow>
      </thead>
      <tbody>
        {view.projects.length === 0 ? (
          <Empty colSpan={5} />
        ) : (
          view.projects.map((p) => (
            <tr key={p.project} className={cn(ROW, "text-right text-neutral-400")}>
              <td className={cn(TD, "whitespace-normal break-words text-left")}>
                {p.project === "" ? (
                  <span className="italic text-neutral-400">Outside workspaces</span>
                ) : (
                  <>
                    {p.workspace ? <span className="block text-[11px] text-neutral-500 sm:inline sm:text-xs">{p.workspace}/</span> : null}
                    <span className="font-medium text-neutral-100">{p.name}</span>
                  </>
                )}
              </td>
              <td className={cn(TD, figures)}>{formatCount(p.sessions)}</td>
              <td className={cn(TD, "text-neutral-100", figures)}>{p.costUsd === null ? <Unpriced /> : formatUsd(p.costUsd)}</td>
              <td className={cn(TD, "hidden sm:table-cell", figures)}>{p.share === null ? "" : formatPercent(p.share)}</td>
              <td className={cn(TD, figures)}>{formatTokens(p.processed)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);
