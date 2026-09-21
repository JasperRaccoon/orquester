/**
 * Token usage and cost — the spec says Grok emits none; the CLI emits it in
 * four places. These tests pin the reading of each.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readCapture, promptResults } from "./fixtures.ts";
import {
  COST_USD_TICKS_PER_DOLLAR,
  costUsdFromTicks,
  parsePromptResultUsage,
  parseResponseCompletedUsage,
  parseXaiUsage,
  turnTokenUsage
} from "./usage.ts";
import { contextTokensOf, contextWindowFromModelState } from "./xai-meta.ts";

test("costUsdTicks is USD x 1e9", () => {
  assert.equal(COST_USD_TICKS_PER_DOLLAR, 1_000_000_000);
  assert.equal(costUsdFromTicks(121_754_000)?.toFixed(6), "0.121754");
  assert.equal(costUsdFromTicks(undefined), undefined);
  assert.equal(costUsdFromTicks(-1), undefined);
});

test("the recorded prompt result parses into a complete TurnTokenUsage", () => {
  const result = promptResults(readCapture("02-prompt-plain-text.ndjson"))[0];
  const parsed = parsePromptResultUsage(result["_meta"]);
  assert.equal(parsed.contextTokens, 22_460);
  assert.equal(parsed.modelId, "grok-4.6");
  assert.equal(parsed.costUsd?.toFixed(6), "0.121754");

  const usage = turnTokenUsage(parsed.usage);
  assert.equal(usage.usageStatus, "complete");
  assert.equal(usage.inputTokens, 22_423);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.cachedInputTokens, 6_144);
  assert.equal(usage.reasoningTokens, 29);
  assert.equal(usage.hasSubagents, false);
  assert.equal(usage.usageScope, "main_agent");
});

test("a locally handled slash command reports totalTokens 0, which is NOT a context size", () => {
  const results = promptResults(readCapture("10-compact-and-context.ndjson"));
  const compact = parsePromptResultUsage(results[1]["_meta"]);
  assert.equal(compact.contextTokens, undefined, "0 must never blank the meter");
  assert.equal(turnTokenUsage(compact.usage).usageStatus, "unavailable");
});

test("contextTokensOf reads the running size from a chunk's _meta and rejects 0", () => {
  assert.equal(contextTokensOf({ totalTokens: 1711 }), 1711);
  assert.equal(contextTokensOf({ totalTokens: 0 }), undefined);
  assert.equal(contextTokensOf({}), undefined);
  assert.equal(contextTokensOf(null), undefined);
});

test("the context WINDOW comes from the model state and is 500k on 1.0.34", () => {
  const entries = readCapture("01-initialize.ndjson");
  const initialize = entries
    .map((entry) => entry.frame as { result?: { _meta?: unknown } })
    .find((frame) => frame.result?._meta !== undefined)?.result;
  const modelState = (initialize?._meta as Record<string, unknown>)["modelState"];
  assert.equal(contextWindowFromModelState(modelState, "grok-4.6"), 500_000);
  assert.equal(contextWindowFromModelState(modelState, "grok-4.5"), 500_000);
  // An unknown model falls back to the first window rather than losing the meter.
  assert.equal(contextWindowFromModelState(modelState, "nope"), 500_000);
  assert.equal(contextWindowFromModelState(undefined), undefined);
});

test("turn_completed on the private channel carries the same usage object", () => {
  const entries = readCapture("02-prompt-plain-text.ndjson");
  const turnCompleted = entries
    .map((entry) => entry.frame as { method?: string; params?: { update?: Record<string, unknown> } })
    .find(
      (frame) =>
        frame.method === "_x.ai/session_notification" && frame.params?.update?.["sessionUpdate"] === "turn_completed"
    );
  const usage = parseXaiUsage(turnCompleted?.params?.update?.["usage"]);
  assert.equal(usage?.inputTokens, 22_423);
  assert.equal(usage?.costUsdTicks, 121_754_000);
});

test("response_completed's snake_case per-call usage normalises to the same shape", () => {
  const parsed = parseResponseCompletedUsage({
    input_tokens: 16_279,
    output_tokens: 30,
    cache_read_input_tokens: 6_144,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 29
  });
  assert.equal(parsed?.inputTokens, 16_279);
  assert.equal(parsed?.cachedReadTokens, 6_144);
  assert.equal(parsed?.reasoningTokens, 29);
});

test("a usage block with only one side is partial, and nothing is unavailable", () => {
  const partial = turnTokenUsage({ inputTokens: 10, outputTokens: Number.NaN, totalTokens: 10 });
  assert.equal(partial.usageStatus, "partial");
  assert.equal(partial.inputTokens, 10);
  assert.equal(turnTokenUsage(undefined).usageStatus, "unavailable");
  assert.equal(turnTokenUsage(undefined, true).hasSubagents, true);
});

test("a malformed usage block is undefined rather than a throw", () => {
  assert.equal(parseXaiUsage(null), undefined);
  assert.equal(parseXaiUsage({ nothing: 1 }), undefined);
  assert.equal(parseResponseCompletedUsage("nope"), undefined);
  assert.deepEqual(parsePromptResultUsage(undefined), {});
});
