/**
 * Codex adapter — token usage and rate limits (spec §4.2, §4.1).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexAdapter.ts:538-617, 1589, 2417-2444`.
 *
 * **Reality beats the spec here.** §4.5 says `thread/tokenUsage/updated`
 * "carries *cumulative thread* totals, so the adapter keeps a baseline and
 * diffs per turn". On 0.154.0 the notification carries **both** `total` (the
 * thread) and `last` (the most recent model call), plus `modelContextWindow`
 * (fixtures README observation 6). So there is no baseline arithmetic: the
 * turn total is the `total` observed at the end of the turn minus the `total`
 * observed when it started — a single subtraction of two reported numbers, not
 * a running sum of `last` values, because the notification fires three to five
 * times per turn.
 *
 * `turn/completed` carries **no** token usage at all, so the adapter stamps it
 * from the last observed notification exactly as T3 does.
 */

import type {
  ProviderUsageWindow,
  ThreadTokenUsage,
  TurnTokenUsage
} from "@orquester/api/agent-chat";

import type { CodexProtocol } from "./_generated/index.ts";

type Breakdown = CodexProtocol.v2.TokenUsageBreakdown;

const ZERO: Breakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
};

/** Per-thread usage accumulator. One instance per live session. */
export class CodexUsageTracker {
  private latestTotal: Breakdown | null = null;
  private contextWindow: number | null = null;
  /** `total` as it stood when the current turn started, keyed by turn id. */
  private readonly turnBaselines = new Map<string, Breakdown>();
  /** Whether any usage notification landed inside a given turn. */
  private readonly turnObserved = new Set<string>();

  /** Record the state at the start of a turn, so its delta is computable. */
  beginTurn(turnId: string): void {
    this.turnBaselines.set(turnId, this.latestTotal ?? ZERO);
    this.turnObserved.delete(turnId);
  }

  /** Feed one `thread/tokenUsage/updated`. Returns the thread-level snapshot. */
  observe(notification: CodexProtocol.v2.ThreadTokenUsageUpdatedNotification): ThreadTokenUsage {
    this.latestTotal = notification.tokenUsage.total;
    this.contextWindow = notification.tokenUsage.modelContextWindow;
    if (notification.turnId.length > 0) {
      this.turnObserved.add(notification.turnId);
      if (!this.turnBaselines.has(notification.turnId)) {
        // A usage row for a turn we never saw start (resume, or a compaction
        // turn the server began on its own): treat the first observation as
        // the baseline so the delta is never the whole thread.
        this.turnBaselines.set(notification.turnId, ZERO);
      }
    }
    return this.threadUsage();
  }

  /** The current context-meter snapshot (§7.6). */
  threadUsage(): ThreadTokenUsage {
    const total = this.latestTotal ?? ZERO;
    return {
      usedTokens: total.totalTokens,
      ...(this.contextWindow !== null ? { maxTokens: this.contextWindow } : {}),
      totalProcessedTokens: total.totalTokens
    };
  }

  /**
   * Settle a turn's usage.
   *
   * `complete` when the delta is real; `partial` for an interrupted turn whose
   * counts are valid but whose total is not the whole story; `unavailable`
   * when the turn produced no observation at all (§4.5).
   */
  completeTurn(
    turnId: string,
    options: { interrupted?: boolean; hasSubagents?: boolean } = {}
  ): TurnTokenUsage {
    const hasSubagents = options.hasSubagents === true;
    const baseline = this.turnBaselines.get(turnId);
    this.turnBaselines.delete(turnId);
    const observed = this.turnObserved.delete(turnId);

    if (!observed || baseline === undefined || this.latestTotal === null) {
      return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
    }

    const total = this.latestTotal;
    const inputTokens = clampNonNegative(total.inputTokens - baseline.inputTokens);
    const outputTokens = clampNonNegative(total.outputTokens - baseline.outputTokens);
    const cachedInputTokens = clampNonNegative(
      total.cachedInputTokens - baseline.cachedInputTokens
    );
    const cacheCreationTokens = clampNonNegative(
      total.cacheWriteInputTokens - baseline.cacheWriteInputTokens
    );
    const reasoningTokens = clampNonNegative(
      total.reasoningOutputTokens - baseline.reasoningOutputTokens
    );

    const base = {
      usageScope: "main_agent" as const,
      // The cache subsets are clamped INTO `inputTokens`, never beyond it:
      // a provider that reports a cached count above the input count would
      // otherwise produce a negative "fresh input" in the meter.
      cachedInputTokens: Math.min(cachedInputTokens, inputTokens),
      cacheCreationTokens: Math.min(cacheCreationTokens, inputTokens),
      reasoningTokens: Math.min(reasoningTokens, outputTokens),
      hasSubagents
    };

    if (options.interrupted === true) {
      return { ...base, usageStatus: "partial", inputTokens, outputTokens };
    }
    return { ...base, usageStatus: "complete", inputTokens, outputTokens };
  }

  /** Forget a turn without settling it (the turn never really started). */
  forgetTurn(turnId: string): void {
    this.turnBaselines.delete(turnId);
    this.turnObserved.delete(turnId);
  }
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// ---------------------------------------------------------------------------
// Rate limits (§4.1 usage windows)
// ---------------------------------------------------------------------------

/**
 * `limitId` is the stable per-window id §4.1's sparse merge needs; a snapshot
 * with no `limitId` falls back to `"codex"` so a later update still lands on
 * the same row. `windowDurationMins: 10080` is the weekly window (fixtures
 * README observation 18).
 */
export function usageWindowsFromRateLimits(
  snapshot: CodexProtocol.v2.RateLimitSnapshot
): ProviderUsageWindow[] {
  const limitId = snapshot.limitId ?? "codex";
  const windows: ProviderUsageWindow[] = [];
  const primary = toWindow(`${limitId}:primary`, snapshot.primary, snapshot.limitName);
  if (primary !== undefined) {
    windows.push(primary);
  }
  const secondary = toWindow(`${limitId}:secondary`, snapshot.secondary, snapshot.limitName);
  if (secondary !== undefined) {
    windows.push(secondary);
  }
  return windows;
}

function toWindow(
  id: string,
  window: CodexProtocol.v2.RateLimitWindow | null,
  limitName: string | null
): ProviderUsageWindow | undefined {
  if (window === null) {
    return undefined;
  }
  const durationMins = window.windowDurationMins;
  return {
    id,
    kind: windowKind(durationMins),
    label: windowLabel(durationMins, limitName),
    usedPercent: clampPercent(window.usedPercent),
    ...(window.resetsAt !== null
      ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() }
      : {}),
    ...(durationMins !== null ? { windowDurationMins: durationMins } : {})
  };
}

function windowKind(durationMins: number | null): ProviderUsageWindow["kind"] {
  if (durationMins === null) {
    return "other";
  }
  if (durationMins <= 24 * 60) {
    return "session";
  }
  if (durationMins <= 7 * 24 * 60) {
    return "weekly";
  }
  return "monthly";
}

function windowLabel(durationMins: number | null, limitName: string | null): string {
  const base = ((): string => {
    switch (windowKind(durationMins)) {
      case "session":
        return durationMins !== null && durationMins < 60
          ? `${durationMins}m limit`
          : `${Math.round((durationMins ?? 0) / 60)}h limit`;
      case "weekly":
        return "Weekly limit";
      case "monthly":
        return "Monthly limit";
      default:
        return "Usage limit";
    }
  })();
  return limitName !== null && limitName.length > 0 ? `${limitName} — ${base}` : base;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}
