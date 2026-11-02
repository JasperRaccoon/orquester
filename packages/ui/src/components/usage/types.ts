// Shared props of the Usage view's parts (spec: docs/superpowers/specs/2026-11-02-usage-panel-design.md §6).

import type { UsageHistoryResponse } from "@orquester/api";

export type UsageTab = "cost" | "tokens" | "limits";
export type UsageMetric = "cost" | "tokens";
export type UsageRangeOption = "24h" | "7d" | "30d" | "90d";
export type UsageBreakdownMode = "model" | "period" | "project";

/** The Cost / Tokens tabs' content. */
export interface UsageOverviewPanelProps {
  data: UsageHistoryResponse;
  metric: UsageMetric;
  /** Agents the user filtered out (their usage is left out of every figure). */
  hiddenAgents: readonly string[];
  /** Figures dim (delayed) while newer data loads: kept data during a range switch or refresh. */
  loading: boolean;
  breakdown: UsageBreakdownMode;
  onBreakdownChange: (mode: UsageBreakdownMode) => void;
  /** The model dialog's "Set price": open the price editor with a new row for `model`. */
  onSetPrice: (model: string) => void;
}

/** The Limits tab's content. */
export interface UsageLimitsPanelProps {
  /** The tab shows: refresh the quota snapshot on entering it. */
  active: boolean;
}

/** The "Model prices" editor. */
export interface UsagePricesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Start with a new row for this model (the model dialog's "Set price"). */
  initialModel?: string | null;
}
