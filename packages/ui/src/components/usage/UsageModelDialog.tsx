import React from "react";

import { getRegistryIcon } from "../../icons/registry-icons";
import { formatCount, formatPercent, formatTokens, formatUsd } from "../../lib/usage-history-format";
import { Button } from "../ui/button";
import { Modal, ModalCloseButton } from "../ui/modal";
import { labelForAgent } from "../topbar/usage-format";
import { UsageChart } from "./UsageChart";
import { costTypeSegments, speedCostSegments, tokenTypeSegments, UsageShareBar } from "./UsageShareBar";
import type { UsageModelDetail } from "./usage-view.logic";

/** One model's drill-down: its figures, its own trend, and how its cost and tokens split. */
export const UsageModelDialog: React.FC<{
  detail: UsageModelDetail | null;
  periods: readonly string[];
  resolution: "hour" | "day";
  timeZone: string;
  onClose: () => void;
  onSetPrice: (model: string) => void;
}> = ({ detail, periods, resolution, timeZone, onClose, onSetPrice }) => (
  <Modal open={detail !== null} onClose={onClose} className="max-w-3xl flex-col">
    {detail ? (
      <ModelDialogBody
        detail={detail}
        periods={periods}
        resolution={resolution}
        timeZone={timeZone}
        onClose={onClose}
        onSetPrice={onSetPrice}
      />
    ) : null}
  </Modal>
);

const ModelDialogBody: React.FC<{
  detail: UsageModelDetail;
  periods: readonly string[];
  resolution: "hour" | "day";
  timeZone: string;
  onClose: () => void;
  onSetPrice: (model: string) => void;
}> = ({ detail, periods, resolution, timeZone, onClose, onSetPrice }) => {
  const stats = [
    { label: "Cost", value: detail.costUnknown ? "Unpriced" : formatUsd(detail.costUsd), muted: detail.costUnknown },
    { label: "Tokens", value: formatTokens(detail.processed) },
    detail.perMillionUsd === null ? null : { label: "Per 1M tokens", value: formatUsd(detail.perMillionUsd) },
    detail.cacheHitRate === null ? null : { label: "Cache hit", value: formatPercent(detail.cacheHitRate) }
  ].filter((s): s is { label: string; value: string; muted?: boolean } => s !== null);
  const share =
    detail.costShare !== null ? `${formatPercent(detail.costShare)} of cost` : `${formatPercent(detail.tokenShare)} of tokens`;
  const hasSpeed = detail.costBySpeed.fast + detail.costBySpeed.ultrafast > 0;
  const chartNoun = detail.chartMetric === "cost" ? "cost" : "processed tokens";
  return (
    <div className="flex min-h-0 w-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-neutral-800 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="shrink-0">{getRegistryIcon("agent", detail.agent, 18)}</span>
            <h2 className="break-all text-base font-semibold text-neutral-100">
              {detail.model}
            </h2>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            {labelForAgent(detail.agent)} · {share}
            {detail.sessions > 0 ? ` · ${formatCount(detail.sessions)} ${detail.sessions === 1 ? "session" : "sessions"}` : ""}
          </p>
        </div>
        <ModalCloseButton onClose={onClose} />
      </header>
      <div className="flex min-h-0 flex-col gap-7 overflow-y-auto px-5 py-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-neutral-500">{s.label}</dt>
              <dd className={s.muted ? "text-2xl font-semibold text-neutral-500" : "text-2xl font-semibold tabular-nums text-neutral-100"}>
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
        {/* An unpriced model's cost is unknown, not zero: its trend shows tokens. */}
        <div className="flex flex-col gap-2">
          <h3 className="text-xs text-neutral-500">
            {resolution === "hour" ? "Hourly" : "Daily"} {chartNoun}
          </h3>
          <UsageChart
            periods={periods}
            resolution={resolution}
            timeZone={timeZone}
            series={[{ agent: detail.agent, values: detail.values }]}
            format={detail.chartMetric === "cost" ? formatUsd : formatTokens}
            ariaLabel={`${resolution === "hour" ? "Hourly" : "Daily"} ${chartNoun} for ${detail.model}`}
            heightClass="h-40 sm:h-44"
          />
        </div>
        <div className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
          {detail.costUnknown ? null : <UsageShareBar label="Cost by type" segments={costTypeSegments(detail.costByType)} format={formatUsd} />}
          <UsageShareBar label="Tokens by type" segments={tokenTypeSegments(detail.tokens)} format={formatTokens} />
          {hasSpeed ? <UsageShareBar label="Cost by speed" segments={speedCostSegments(detail.costBySpeed)} format={formatUsd} /> : null}
        </div>
      </div>
      {detail.unpricedTokens > 0 ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-900/60 px-5 py-3">
          <span className="text-xs text-neutral-400">
            <span className="tabular-nums text-neutral-200">{formatTokens(detail.unpricedTokens)}</span> tokens have no known price
          </span>
          <Button
            size="sm"
            onClick={() => {
              onClose();
              onSetPrice(detail.model);
            }}
          >
            Set price
          </Button>
        </footer>
      ) : null}
    </div>
  );
};
