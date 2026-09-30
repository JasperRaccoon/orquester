/**
 * Token usage and cost — the spec says Grok emits none; the CLI emits it in
 * four places. These tests pin the captured prompt result and fallback
 * sources that contribute to the user-visible usage meter.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readCapture, promptResults } from "./fixtures.ts";
import {
  parsePromptResultUsage,
  parseResponseCompletedUsage,
  parseXaiUsage,
  turnTokenUsage
} from "./usage.ts";
import { contextTokensOf, contextWindowFromModelState } from "./xai-meta.ts";

test("costUsdTicks is USD x 1e9", () => {
  const parseCost = (costUsdTicks: unknown) => parsePromptResultUsage({ usage: { inputTokens: 1, outputTokens: 1, costUsdTicks } }).costUsd;
  assert.equal(parseCost(121_754_000), 0.121754);
  assert.equal(parseCost(undefined), undefined);
  assert.equal(parseCost(-1), undefined);
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

test("a malformed usage block is undefined rather than a throw", () => {
  assert.equal(parseXaiUsage(null), undefined);
  assert.equal(parseXaiUsage({ nothing: 1 }), undefined);
  assert.equal(parseResponseCompletedUsage("nope"), undefined);
  assert.deepEqual(parsePromptResultUsage(undefined), {});
});
