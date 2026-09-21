/**
 * Claude adapter — token usage and subscription windows (spec §4.1, §4.2,
 * §4.5 "Token usage").
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts` (the usage normalisers)
 * and `apps/server/src/provider/Layers/claudeUsageLimits.ts`, translated from
 * Effect into plain TypeScript.
 *
 * Two sources produce the same window ids so a turn-driven `rate_limit_event`
 * lands on the row the probe's `get_usage` established:
 *
 * - `usage_EXPERIMENTAL…` (during the probe) reports every window at once as
 *   0–100 percentages with ISO reset times.
 * - `rate_limit_event` (streamed during a turn) names one window at a time,
 *   with an epoch-seconds reset — and, on CLI 2.1.210, **no percentage at
 *   all** (fixtures/claude README observation 16), which is why that path can
 *   only mark the cached snapshot stale.
 */

import type {
  ProviderUsageLimits,
  ProviderUsageLimitsUpdate,
  ProviderUsageWindow,
  RuntimeTaskUsage,
  RuntimeTurnState,
  ThreadTokenUsage,
  TurnTokenUsage
} from "@orquester/api/agent-chat";

import { nonNegativeInt } from "./classify.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

export function claudeUsageInputTokens(usage: Record<string, unknown>): number {
  return (
    (finiteNonNegativeInteger(usage.input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_read_input_tokens) ?? 0)
  );
}

export function claudeUsageOutputTokens(usage: Record<string, unknown>): number {
  return finiteNonNegativeInteger(usage.output_tokens) ?? 0;
}

export function lastClaudeUsageIteration(
  value: Record<string, unknown>
): Record<string, unknown> | undefined {
  const iterations = Array.isArray(value.iterations) ? value.iterations : [];
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration: unknown = iterations[index];
    if (iteration !== null && typeof iteration === "object" && !Array.isArray(iteration)) {
      return iteration as Record<string, unknown>;
    }
  }
  return undefined;
}

export function claudeTotalProcessedTokens(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const explicit = finiteNonNegativeInteger(usage.total_tokens);
  if (explicit !== undefined && explicit > 0) {
    return explicit;
  }
  const total = claudeUsageInputTokens(usage) + claudeUsageOutputTokens(usage);
  return total > 0 ? total : undefined;
}

/**
 * The context-meter snapshot, plus `lastUsedTokens` — the before-value a
 * compaction boundary reports. `ThreadTokenUsage` on the wire has no such
 * field (§4.2 puts it on `thread.state.changed {beforeTokens}` instead), so it
 * stays internal to this module and its caller.
 */
export interface ClaudeTokenUsageSnapshot extends ThreadTokenUsage {
  lastUsedTokens?: number;
}

export function makeTokenUsageSnapshot(input: {
  activeTokens: number;
  contextWindow?: number;
  totalProcessedTokens?: number;
  lastUsedTokens?: number;
}): ClaudeTokenUsageSnapshot | undefined {
  const activeTokens = finiteNonNegativeInteger(input.activeTokens);
  if (activeTokens === undefined || activeTokens <= 0) {
    return undefined;
  }
  const maxTokens = finitePositiveInteger(input.contextWindow);
  const usedTokens = maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens;
  const lastUsedTokens = finiteNonNegativeInteger(input.lastUsedTokens) ?? usedTokens;
  const totalProcessedTokens = finiteNonNegativeInteger(input.totalProcessedTokens);
  return {
    usedTokens,
    lastUsedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {})
  };
}

/** A live `usage` block (assistant snapshot, `message_delta`, `result`). */
export function normalizeActiveTokenUsage(
  value: unknown,
  contextWindow?: number,
  totalProcessedTokens?: number
): ClaudeTokenUsageSnapshot | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const activeUsage = lastClaudeUsageIteration(usage) ?? usage;
  const activeTokens =
    claudeTotalProcessedTokens(activeUsage) ??
    claudeUsageInputTokens(activeUsage) + claudeUsageOutputTokens(activeUsage);
  if (activeTokens <= 0) {
    return undefined;
  }
  return makeTokenUsageSnapshot({
    activeTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {})
  });
}

/** Drop the internal `lastUsedTokens` before an event carries the snapshot. */
export function toThreadTokenUsage(snapshot: ClaudeTokenUsageSnapshot): ThreadTokenUsage {
  const { lastUsedTokens: _lastUsedTokens, ...rest } = snapshot;
  return rest;
}

export function maxContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  if (modelUsage === null || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
    return undefined;
  }
  let max: number | undefined;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") {
      continue;
    }
    const window = finitePositiveInteger((value as { contextWindow?: unknown }).contextWindow);
    if (window !== undefined) {
      max = Math.max(max ?? 0, window);
    }
  }
  return max;
}

/**
 * `result.usage` → the turn rollup of §4.2. `complete` only when the turn
 * really ended successfully AND both totals are present; `partial` when every
 * included count is valid but the turn total is not known; `unavailable` when
 * the turn produced none.
 */
export function normalizeTurnTokenUsage(input: {
  usage: unknown;
  resultSubtype: string | undefined;
  hasSubagents: boolean;
  terminalStatus: RuntimeTurnState;
}): TurnTokenUsage {
  const { usage: rawUsage, resultSubtype, hasSubagents, terminalStatus } = input;
  if (rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents };
  }
  const usage = rawUsage as Record<string, unknown>;

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails =
    usage.output_tokens_details !== null && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);

  const cachedContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const creationContribution = usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedContribution !== undefined &&
    creationContribution !== undefined
      ? uncachedInputTokens + cachedContribution + creationContribution
      : undefined;

  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (resultSubtype !== "success" && !hasPositiveUsage)) {
    return { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents };
  }

  const common = {
    usageScope: "main_agent" as const,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents
  };

  if (
    terminalStatus === "completed" &&
    resultSubtype === "success" &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
  ) {
    return { ...common, usageStatus: "complete", inputTokens, outputTokens: rawOutputTokens };
  }
  return {
    ...common,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {})
  };
}

/** `system/compact_boundary` → the post-compaction meter reading. */
export function compactBoundarySnapshot(input: {
  compactMetadata: unknown;
  contextWindow?: number;
  totalProcessedTokens?: number;
}): ClaudeTokenUsageSnapshot | undefined {
  const { compactMetadata } = input;
  if (
    compactMetadata === null ||
    typeof compactMetadata !== "object" ||
    Array.isArray(compactMetadata)
  ) {
    return undefined;
  }
  const metadata = compactMetadata as Record<string, unknown>;
  const postTokens = finiteNonNegativeInteger(metadata.post_tokens);
  if (postTokens === undefined || postTokens <= 0) {
    return undefined;
  }
  const preTokens = finiteNonNegativeInteger(metadata.pre_tokens);
  const snapshot = makeTokenUsageSnapshot({
    activeTokens: postTokens,
    ...(preTokens !== undefined ? { lastUsedTokens: preTokens } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.totalProcessedTokens !== undefined
      ? { totalProcessedTokens: input.totalProcessedTokens }
      : {})
  });
  if (snapshot === undefined || preTokens !== undefined) {
    return snapshot;
  }
  const { lastUsedTokens: _dropped, ...withoutBefore } = snapshot;
  return withoutBefore;
}

/**
 * SDK task usage (`{total_tokens, tool_uses, duration_ms}`, sometimes with
 * input/output breakdowns) → the typed contract shape. Unknown or malformed
 * input yields `undefined` rather than a partial guess.
 */
export function normalizeTaskUsage(usage: unknown): RuntimeTaskUsage | undefined {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const totalTokens = nonNegativeInt(record.total_tokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const inputTokens = nonNegativeInt(record.input_tokens);
  const cachedInputTokens = nonNegativeInt(record.cache_read_input_tokens);
  const outputTokens = nonNegativeInt(record.output_tokens);
  const toolUses = nonNegativeInt(record.tool_uses);
  const durationMs = nonNegativeInt(record.duration_ms);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  };
}

// ---------------------------------------------------------------------------
// Subscription windows
// ---------------------------------------------------------------------------

export const CLAUDE_SESSION_WINDOW_ID = "session";
export const CLAUDE_WEEKLY_WINDOW_ID = "weekly_all";

/** `weekly_scoped` rows differ only by their scope, so the id carries it. */
export function scopedWindowId(displayName: string): string {
  return `weekly_scoped:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoFromString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The scoped-bucket names the last probe saw, reused by the event mapper. */
export interface ClaudeScopedLimitNames {
  overageIncluded?: string;
}

interface UsageLimitRow {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

function windowFromLimitsRow(row: UsageLimitRow): ProviderUsageWindow | undefined {
  const kind = typeof row.kind === "string" ? row.kind : undefined;
  const percent = typeof row.percent === "number" ? row.percent : undefined;
  if (kind === undefined || percent === undefined) {
    return undefined;
  }
  const resetsAt = isoFromString(row.resets_at);
  if (kind === "session") {
    return {
      id: CLAUDE_SESSION_WINDOW_ID,
      kind: "session",
      label: "Session",
      windowDurationMins: SESSION_MINS,
      usedPercent: clampPercent(percent),
      ...(resetsAt ? { resetsAt } : {})
    };
  }
  if (kind === "weekly_all") {
    return {
      id: CLAUDE_WEEKLY_WINDOW_ID,
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: WEEK_MINS,
      usedPercent: clampPercent(percent),
      ...(resetsAt ? { resetsAt } : {})
    };
  }
  if (kind === "weekly_scoped") {
    const displayName =
      typeof row.scope?.model?.display_name === "string"
        ? row.scope.model.display_name.trim()
        : "";
    if (displayName.length === 0) {
      // Two scoped rows would collapse onto one id without a discriminator, so
      // an unnamed scope is skipped rather than merged (§4.1 "stable id").
      return undefined;
    }
    return {
      id: scopedWindowId(displayName),
      kind: "weekly",
      label: `Weekly · ${displayName}`,
      windowDurationMins: WEEK_MINS,
      usedPercent: clampPercent(percent),
      ...(resetsAt ? { resetsAt } : {})
    };
  }
  return undefined;
}

/**
 * The `usage_EXPERIMENTAL…` response → §4.1's `usageLimits`. The modern
 * `rate_limits.limits[]` array is preferred; the legacy
 * `five_hour`/`seven_day`/`model_scoped` map is the fallback for a CLI that
 * does not ship it. The dozen `null` codename windows beside them are skipped
 * rather than rendered.
 */
export function usageResponseToLimits(input: {
  response: unknown;
  checkedAt: string;
}): { limits: ProviderUsageLimits; names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  const record =
    response !== null && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const available = record.rate_limits_available === true;
  const rateLimits =
    record.rate_limits !== null && typeof record.rate_limits === "object"
      ? (record.rate_limits as Record<string, unknown>)
      : undefined;

  if (!available || rateLimits === undefined) {
    return {
      limits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "unsupported",
          message: "This Claude login has no subscription usage windows."
        }
      },
      names: {}
    };
  }

  const windows: ProviderUsageWindow[] = [];
  const names: ClaudeScopedLimitNames = {};

  const rows = Array.isArray(rateLimits.limits) ? (rateLimits.limits as UsageLimitRow[]) : [];
  if (rows.length > 0) {
    for (const row of rows) {
      const window = windowFromLimitsRow(row);
      if (!window) {
        continue;
      }
      windows.push(window);
      if (
        row.kind === "weekly_scoped" &&
        names.overageIncluded === undefined &&
        typeof row.scope?.model?.display_name === "string"
      ) {
        names.overageIncluded = row.scope.model.display_name.trim();
      }
    }
  } else {
    const legacy: Array<[string, ProviderUsageWindow["kind"], string, number]> = [
      ["five_hour", "session", "Session", SESSION_MINS],
      ["seven_day", "weekly", "Weekly", WEEK_MINS]
    ];
    for (const [key, kind, label, durationMins] of legacy) {
      const entry = rateLimits[key];
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const utilization = (entry as { utilization?: unknown }).utilization;
      if (typeof utilization !== "number") {
        continue;
      }
      const resetsAt = isoFromString((entry as { resets_at?: unknown }).resets_at);
      windows.push({
        id: key === "five_hour" ? CLAUDE_SESSION_WINDOW_ID : CLAUDE_WEEKLY_WINDOW_ID,
        kind,
        label,
        windowDurationMins: durationMins,
        usedPercent: clampPercent(utilization),
        ...(resetsAt ? { resetsAt } : {})
      });
    }
    const modelScoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : [];
    for (const entry of modelScoped) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const row = entry as { display_name?: unknown; utilization?: unknown; resets_at?: unknown };
      if (typeof row.display_name !== "string" || typeof row.utilization !== "number") {
        continue;
      }
      const displayName = row.display_name.trim();
      const resetsAt = isoFromString(row.resets_at);
      windows.push({
        id: scopedWindowId(displayName),
        kind: "weekly",
        label: `Weekly · ${displayName}`,
        windowDurationMins: WEEK_MINS,
        usedPercent: clampPercent(row.utilization),
        ...(resetsAt ? { resetsAt } : {})
      });
      names.overageIncluded ??= displayName;
    }
  }

  return { limits: { checkedAt, windows }, names };
}

/**
 * The streamed `rate_limit_event`. On CLI 2.1.210 it carries **no**
 * utilization, so this returns `undefined` for every real frame today and the
 * caller marks the cached snapshot stale instead. Older/newer CLIs that do
 * send a 0–1 fraction still produce a sparse merge-by-id update.
 */
export function rateLimitEventToUpdate(
  info: unknown,
  names: ClaudeScopedLimitNames
): ProviderUsageLimitsUpdate | undefined {
  if (info === null || typeof info !== "object") {
    return undefined;
  }
  const record = info as Record<string, unknown>;
  const type = typeof record.rateLimitType === "string" ? record.rateLimitType : undefined;
  const utilization = record.utilization;
  if (type === undefined || typeof utilization !== "number") {
    return undefined;
  }
  const usedPercent = clampPercent(utilization * 100);
  const resetsAt = isoFromEpochSeconds(record.resetsAt);
  if (type === "five_hour") {
    return {
      windows: [
        {
          id: CLAUDE_SESSION_WINDOW_ID,
          kind: "session",
          label: "Session",
          windowDurationMins: SESSION_MINS,
          usedPercent,
          ...(resetsAt ? { resetsAt } : {})
        }
      ]
    };
  }
  if (type === "seven_day") {
    return {
      windows: [
        {
          id: CLAUDE_WEEKLY_WINDOW_ID,
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: WEEK_MINS,
          usedPercent,
          ...(resetsAt ? { resetsAt } : {})
        }
      ]
    };
  }
  if (type === "seven_day_overage_included" && names.overageIncluded !== undefined) {
    return {
      windows: [
        {
          id: scopedWindowId(names.overageIncluded),
          kind: "weekly",
          label: `Weekly · ${names.overageIncluded}`,
          windowDurationMins: WEEK_MINS,
          usedPercent,
          ...(resetsAt ? { resetsAt } : {})
        }
      ]
    };
  }
  // Guessing a name for a bucket no probe has drawn would open a row the next
  // probe cannot reconcile.
  return undefined;
}

const USAGE_LIMIT_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_overage_included: "7-day model",
  overage: "overage"
};

/** Beyond this the reset time is not credible, so the row ships without a wait. */
const USAGE_LIMIT_MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A rejected window parks the turn inside the SDK: no further messages arrive
 * and no result lands, so without this row the thread just spins (§4.5
 * "Traps"). The wait is stated as a duration rather than a wall-clock time
 * because this renders on the host and is read on clients in other timezones.
 */
export function describeUsageLimit(input: {
  info: unknown;
  nowMs: number;
  names: ClaudeScopedLimitNames;
}): string {
  const record =
    input.info !== null && typeof input.info === "object"
      ? (input.info as Record<string, unknown>)
      : {};
  const type = typeof record.rateLimitType === "string" ? record.rateLimitType : undefined;
  const label =
    type === "seven_day_overage_included" && input.names.overageIncluded !== undefined
      ? `7-day ${input.names.overageIncluded}`
      : type !== undefined
        ? USAGE_LIMIT_WINDOW_LABELS[type]
        : undefined;
  const resetsAtMs =
    typeof record.resetsAt === "number" && Number.isFinite(record.resetsAt)
      ? record.resetsAt * 1000
      : undefined;
  const waitMs = resetsAtMs === undefined ? undefined : resetsAtMs - input.nowMs;
  const wait =
    waitMs !== undefined && waitMs > 0 && waitMs <= USAGE_LIMIT_MAX_WAIT_MS
      ? formatUsageLimitWait(waitMs)
      : undefined;
  return `Claude usage limit reached. This turn is paused until the ${
    label ? `${label} ` : ""
  }limit resets${wait ? ` in ${wait}` : ""}.`;
}

export function formatUsageLimitWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${totalMinutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** True when a `rate_limit_info` says the window is currently blocking. */
export function isRateLimitBlocking(info: unknown): boolean {
  if (info === null || typeof info !== "object") {
    return false;
  }
  const record = info as Record<string, unknown>;
  const overageAllowed =
    record.overageStatus === "allowed" ||
    record.overageStatus === "allowed_warning" ||
    record.isUsingOverage === true ||
    record.overageInUse === true;
  return record.status === "rejected" && !overageAllowed;
}

/** True when the window reports headroom again, clearing a previous block. */
export function isRateLimitClearing(info: unknown): boolean {
  if (info === null || typeof info !== "object") {
    return false;
  }
  const record = info as Record<string, unknown>;
  return (
    record.status === "allowed" ||
    record.status === "allowed_warning" ||
    record.isUsingOverage === true ||
    record.overageStatus === "allowed" ||
    record.overageStatus === "allowed_warning"
  );
}
