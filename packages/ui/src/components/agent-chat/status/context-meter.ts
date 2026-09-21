// Ported from T3 Code (MIT): apps/web/src/lib/contextWindow.ts:28-90 and
// apps/web/src/components/chat/ContextWindowMeter.logic.ts:100-110

/**
 * The context-window meter's arithmetic (spec §7.6).
 *
 * The rule the whole file exists to enforce: **without `maxTokens` there is no
 * ring and no percentage, only a bare total.** An adapter with
 * `reportsContextWindow: false` (OpenCode, Grok) reports tokens and nothing
 * else, and inventing "0%" for it would be a lie the user cannot detect.
 * `usedPercentage` is therefore `null` whenever `maxTokens` is, all the way
 * through to {@link MeterRing}, which draws its track only.
 *
 * *T3: `lib/contextWindow.ts:28-75` — the percentage and the remaining tokens
 * are `null` exactly when `maxTokens` is.*
 */

export interface ContextMeterInput {
  /** `thread.token-usage.updated {usage.usedTokens}`; `null` before the first. */
  usedTokens: number | null;
  maxTokens: number | null;
  autoCompactAtTokens: number | null;
  totalProcessedTokens: number | null;
  /** The adapter's `AdapterCapabilities.reportsContextWindow`. */
  reportsContextWindow: boolean;
}

export interface ContextMeterModel {
  usedTokens: number;
  /** `null` ⇒ the degraded readout: a token count and no ring. */
  maxTokens: number | null;
  usedPercentage: number | null;
  remainingTokens: number | null;
  autoCompactAtTokens: number | null;
  totalProcessedTokens: number | null;
  /** True when there is no window to measure against. */
  degraded: boolean;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build the meter's model, or `null` when there is nothing to show at all.
 *
 * A usage frame that has not arrived is `null` — **not** a zeroed model: the
 * meter's slot stays empty rather than claiming a fresh thread has used 0 of 0
 * tokens.
 */
export function deriveContextMeter(input: ContextMeterInput): ContextMeterModel | null {
  const usedTokens = finite(input.usedTokens);
  if (usedTokens === null || usedTokens < 0) return null;

  const reportedMax = finite(input.maxTokens);
  const maxTokens =
    input.reportsContextWindow && reportedMax !== null && reportedMax > 0 ? reportedMax : null;

  const usedPercentage = maxTokens === null ? null : Math.min(100, (usedTokens / maxTokens) * 100);
  const remainingTokens = maxTokens === null ? null : Math.max(0, Math.round(maxTokens - usedTokens));

  const autoCompactAtTokens = finite(input.autoCompactAtTokens);
  const totalProcessedTokens = finite(input.totalProcessedTokens);

  return {
    usedTokens,
    maxTokens,
    usedPercentage,
    remainingTokens,
    autoCompactAtTokens: autoCompactAtTokens !== null && autoCompactAtTokens > 0 ? autoCompactAtTokens : null,
    totalProcessedTokens:
      totalProcessedTokens !== null && totalProcessedTokens > 0 ? totalProcessedTokens : null,
    degraded: maxTokens === null
  };
}

/**
 * Token counts for the meter and the status line: exact below 1 000, one
 * decimal to 10 k, whole thousands to a million, then `m`.
 *
 * Finer than the roster's {@link formatSubagentTokenCount} on purpose — this
 * number is the one the user checks against a context limit, so `128k` and
 * `1.4k` both have to be readable.
 *
 * *T3: `lib/contextWindow.ts:77-90`.*
 */
export function formatContextTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * The auto-compaction sentence. A reported threshold is stated exactly,
 * because it is the number the user will watch the meter approach; without one
 * the sentence stays vague rather than guessing.
 *
 * *T3: `ContextWindowMeter.logic.ts:100-110`.*
 */
export function formatAutoCompactionSentence(
  modelLabel: string | null | undefined,
  autoCompactAtTokens: number | null | undefined
): string {
  if (typeof autoCompactAtTokens === "number" && autoCompactAtTokens > 0) {
    return `Compacts automatically at ${autoCompactAtTokens.toLocaleString("en-US")} tokens.`;
  }
  return modelLabel
    ? `Context for ${modelLabel} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/** `used/total` for the popover header, or the bare total when degraded. */
export function formatContextUsage(model: ContextMeterModel): string {
  if (model.maxTokens === null) return formatContextTokens(model.usedTokens);
  return `${formatContextTokens(model.usedTokens)}/${formatContextTokens(model.maxTokens)}`;
}
