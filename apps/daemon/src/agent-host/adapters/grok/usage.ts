/**
 * Grok adapter — token usage and cost (spec §4.2 `TurnTokenUsage`,
 * `thread.token-usage.updated`).
 *
 * **This module exists because the spec is wrong.** §4.5 states:
 *
 * > *"**Grok emits no token usage at all** — no `thread.token-usage.updated`,
 * > no `turn.completed.tokenUsage`. The context meter and per-turn cost are
 * > simply absent on Grok (`reportsContextWindow: false`)."*
 *
 * That was true of the build T3 was written against. CLI 1.0.34 emits usage in
 * four independent places (fixtures observation 14):
 *
 * - **every streamed chunk** carries `_meta.totalTokens`, the running context
 *   size;
 * - the **`session/prompt` result** carries a complete per-turn block
 *   including `costUsdTicks`;
 * - `_x.ai/session_notification` `turn_completed` repeats the same `usage`
 *   object; and
 * - `response_completed` reports per-model-call usage in snake_case.
 *
 * and the context window is
 * `initialize._meta.modelState.availableModels[]._meta.totalContextTokens`
 * (500 000). So `reportsContextWindow` is **true** for Grok and the status
 * line shows a real meter.
 *
 * ACP 0.11.3 also defines `Usage` / `UsageUpdate` and a `session/update`
 * variant for them; this CLI does not use them, preferring `_meta`.
 */

import type { TurnTokenUsage } from "@orquester/api/agent-chat";

import type { XaiUsage } from "./acp/_generated/xai.ts";

/** `costUsdTicks` is USD × 1e9: `121_754_000` ticks = $0.121754. */
export const COST_USD_TICKS_PER_DOLLAR = 1_000_000_000;

export function costUsdFromTicks(ticks: unknown): number | undefined {
  return typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0
    ? ticks / COST_USD_TICKS_PER_DOLLAR
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The camelCase `usage` block from `session/prompt._meta` or `turn_completed`. */
export function parseXaiUsage(value: unknown): XaiUsage | undefined {
  const block = record(value);
  if (block === undefined) {
    return undefined;
  }
  const inputTokens = count(block["inputTokens"]);
  const outputTokens = count(block["outputTokens"]);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: count(block["totalTokens"]) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(count(block["cachedReadTokens"]) === undefined ? {} : { cachedReadTokens: count(block["cachedReadTokens"]) }),
    ...(count(block["cacheCreationTokens"]) === undefined
      ? {}
      : { cacheCreationTokens: count(block["cacheCreationTokens"]) }),
    ...(count(block["reasoningTokens"]) === undefined ? {} : { reasoningTokens: count(block["reasoningTokens"]) }),
    ...(count(block["modelCalls"]) === undefined ? {} : { modelCalls: count(block["modelCalls"]) }),
    ...(count(block["apiDurationMs"]) === undefined ? {} : { apiDurationMs: count(block["apiDurationMs"]) }),
    ...(count(block["costUsdTicks"]) === undefined ? {} : { costUsdTicks: count(block["costUsdTicks"]) }),
    ...(count(block["numTurns"]) === undefined ? {} : { numTurns: count(block["numTurns"]) })
  } as XaiUsage;
}

/**
 * `usage` → the §4.2 `TurnTokenUsage`.
 *
 * `usageStatus` follows the contract exactly: `complete` only when the
 * provider supplied BOTH totals, `partial` when some counts are valid but the
 * turn total is not known, `unavailable` when the turn produced none —
 * which is what a locally handled slash command (`/compact`, `/context`)
 * reports, since those carry no `usage` block at all.
 *
 * `hasSubagents` is mandatory on the contract. Grok has no subagent usage
 * rollup on this surface, so it is `false` unless the caller knows better
 * from the background-task roster.
 */
export function turnTokenUsage(usage: XaiUsage | undefined, hasSubagents = false): TurnTokenUsage {
  if (usage === undefined) {
    return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
  }
  const optional = {
    ...(usage.cachedReadTokens === undefined ? {} : { cachedInputTokens: usage.cachedReadTokens }),
    ...(usage.cacheCreationTokens === undefined ? {} : { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens })
  };
  const hasInput = Number.isFinite(usage.inputTokens);
  const hasOutput = Number.isFinite(usage.outputTokens);
  if (hasInput && hasOutput) {
    return {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      hasSubagents,
      ...optional
    };
  }
  return {
    usageScope: "main_agent",
    usageStatus: "partial",
    ...(hasInput ? { inputTokens: usage.inputTokens } : {}),
    ...(hasOutput ? { outputTokens: usage.outputTokens } : {}),
    hasSubagents,
    ...optional
  };
}

/**
 * The snake_case `response_completed.usage`, which reports ONE model call
 * rather than the turn. Normalised to the same shape so the two sources can be
 * compared, but it is never used as the turn's total — `turn_completed` and
 * the RPC result are.
 */
export function parseResponseCompletedUsage(value: unknown): XaiUsage | undefined {
  const block = record(value);
  if (block === undefined) {
    return undefined;
  }
  const inputTokens = count(block["input_tokens"]);
  const outputTokens = count(block["output_tokens"]);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(count(block["cache_read_input_tokens"]) === undefined
      ? {}
      : { cachedReadTokens: count(block["cache_read_input_tokens"]) }),
    ...(count(block["cache_creation_input_tokens"]) === undefined
      ? {}
      : { cacheCreationTokens: count(block["cache_creation_input_tokens"]) }),
    ...(count(block["reasoning_tokens"]) === undefined ? {} : { reasoningTokens: count(block["reasoning_tokens"]) })
  } as XaiUsage;
}

/**
 * The `session/prompt` result's `_meta`, which is the **richest** of the four
 * sources: it is the only one carrying both the usage block and the resulting
 * context size, so it beats the `prompt_complete` notification that races it.
 */
export interface PromptResultUsage {
  /** Context size AFTER the turn. Absent when the provider reported 0. */
  readonly contextTokens?: number;
  readonly usage?: XaiUsage;
  readonly modelId?: string;
  readonly costUsd?: number;
}

export function parsePromptResultUsage(meta: unknown): PromptResultUsage {
  const block = record(meta);
  if (block === undefined) {
    return {};
  }
  const usage = parseXaiUsage(block["usage"]);
  const total = count(block["totalTokens"]);
  const modelId = typeof block["modelId"] === "string" ? block["modelId"] : undefined;
  return {
    // 0 means "no measurement" (a locally handled slash command), not "the
    // context is empty" — reporting it would blank the meter after `/compact`.
    ...(total === undefined || total === 0 ? {} : { contextTokens: total }),
    ...(usage === undefined ? {} : { usage }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(costUsdFromTicks(usage?.costUsdTicks) === undefined
      ? {}
      : { costUsd: costUsdFromTicks(usage?.costUsdTicks) })
  };
}
