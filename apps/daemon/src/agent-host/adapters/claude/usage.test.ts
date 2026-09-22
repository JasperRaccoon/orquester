/**
 * Token usage and subscription windows (§4.1, §4.2, §4.5 "Token usage").
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readClaudeFixture } from "./fixtures.ts";
import {
  CLAUDE_SESSION_WINDOW_ID,
  CLAUDE_WEEKLY_WINDOW_ID,
  claudeTotalProcessedTokens,
  compactBoundarySnapshot,
  contextUsageSnapshot,
  describeUsageLimit,
  formatUsageLimitWait,
  isRateLimitBlocking,
  isRateLimitClearing,
  maxContextWindowFromModelUsage,
  normalizeActiveTokenUsage,
  normalizeTaskUsage,
  normalizeTurnTokenUsage,
  rateLimitEventToUpdate,
  scopedWindowId,
  toThreadTokenUsage,
  totalProcessedFromModelUsage,
  usageResponseToLimits
} from "./usage.ts";

describe("claude token usage", () => {
  it("counts cache reads and writes as input", () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 21_536,
      cache_read_input_tokens: 10,
      output_tokens: 4
    };
    const turn = normalizeTurnTokenUsage({
      usage,
      resultSubtype: "success",
      hasSubagents: false,
      terminalStatus: "completed"
    });
    assert.equal(turn.usageStatus, "complete");
    assert.equal(turn.inputTokens, 21_548);
    assert.equal(turn.outputTokens, 4);
    assert.equal(turn.cachedInputTokens, 10);
    assert.equal(turn.cacheCreationTokens, 21_536);
    assert.equal(turn.hasSubagents, false);
  });

  it("is partial when the turn did not end successfully", () => {
    const turn = normalizeTurnTokenUsage({
      usage: { input_tokens: 5, output_tokens: 1 },
      resultSubtype: "error_during_execution",
      hasSubagents: true,
      terminalStatus: "interrupted"
    });
    assert.equal(turn.usageStatus, "partial");
    assert.equal(turn.hasSubagents, true);
  });

  it("is unavailable when the turn produced none", () => {
    for (const usage of [undefined, null, {}, "nope"]) {
      const turn = normalizeTurnTokenUsage({
        usage,
        resultSubtype: "success",
        hasSubagents: false,
        terminalStatus: "completed"
      });
      assert.equal(turn.usageStatus, "unavailable", JSON.stringify(usage));
    }
  });

  it("reports reasoning tokens as a subset of output", () => {
    const turn = normalizeTurnTokenUsage({
      usage: {
        input_tokens: 1,
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: 40 }
      },
      resultSubtype: "success",
      hasSubagents: false,
      terminalStatus: "completed"
    });
    assert.equal(turn.reasoningTokens, 40);
  });

  it("prefers the last usage iteration for the live context reading", () => {
    const snapshot = normalizeActiveTokenUsage(
      {
        input_tokens: 1,
        output_tokens: 1,
        iterations: [
          { input_tokens: 10, output_tokens: 1 },
          { input_tokens: 500, output_tokens: 30 }
        ]
      },
      200_000
    );
    assert.equal(snapshot?.usedTokens, 530);
    assert.equal(snapshot?.maxTokens, 200_000);
    // The wire shape has no `lastUsedTokens`.
    assert.equal("lastUsedTokens" in toThreadTokenUsage(snapshot!), false);
  });

  it("clamps the reading to the context window", () => {
    const snapshot = normalizeActiveTokenUsage({ input_tokens: 500_000 }, 200_000);
    assert.equal(snapshot?.usedTokens, 200_000);
  });

  it("reads the widest context window off the result's per-model map", () => {
    assert.equal(
      maxContextWindowFromModelUsage({
        "claude-haiku-4-5": { contextWindow: 200_000 },
        "claude-opus-4-8[1m]": { contextWindow: 1_000_000 }
      }),
      1_000_000
    );
    assert.equal(maxContextWindowFromModelUsage(undefined), undefined);
  });

  it("turns a compaction boundary into before/after", () => {
    const snapshot = compactBoundarySnapshot({
      compactMetadata: { trigger: "manual", pre_tokens: 34_995, post_tokens: 873 },
      contextWindow: 200_000
    });
    assert.equal(snapshot?.lastUsedTokens, 34_995);
    assert.equal(snapshot?.usedTokens, 873);
    assert.equal(compactBoundarySnapshot({ compactMetadata: undefined }), undefined);
  });

  it("normalises a task usage rollup or nothing at all", () => {
    assert.deepEqual(
      normalizeTaskUsage({ total_tokens: 11_447, tool_uses: 1, duration_ms: 1424 }),
      { totalTokens: 11_447, toolUses: 1, durationMs: 1424 }
    );
    assert.equal(normalizeTaskUsage({ tool_uses: 2 }), undefined);
    assert.equal(normalizeTaskUsage("nope"), undefined);
  });

  it("derives a total from input + output when none is stated", () => {
    assert.equal(claudeTotalProcessedTokens({ input_tokens: 3, output_tokens: 4 }), 7);
    assert.equal(claudeTotalProcessedTokens({ total_tokens: 99 }), 99);
    assert.equal(claudeTotalProcessedTokens({}), undefined);
  });
});

describe("claude subscription windows", () => {
  const usageResponse = (() => {
    const line = readClaudeFixture("13-probe-never-yielding.ndjson").find(
      (entry) =>
        entry.kind === "control" &&
        String((entry.data as { op?: unknown }).op).startsWith("usage_")
    );
    return (line?.data as { result?: unknown }).result;
  })();

  it("reads the captured response into §4.1's window shape", () => {
    const { limits, names } = usageResponseToLimits({
      response: usageResponse,
      checkedAt: "2026-09-21T00:00:00.000Z"
    });
    assert.equal(limits.unavailable, undefined);
    const byId = new Map(limits.windows.map((window) => [window.id, window]));

    assert.equal(byId.get(CLAUDE_SESSION_WINDOW_ID)?.usedPercent, 83);
    assert.equal(byId.get(CLAUDE_SESSION_WINDOW_ID)?.kind, "session");
    assert.equal(byId.get(CLAUDE_WEEKLY_WINDOW_ID)?.usedPercent, 66);

    // A `weekly_scoped` row is distinguished ONLY by its scope, so two of them
    // must not collapse onto one id.
    const scoped = byId.get(scopedWindowId("Fable"));
    assert.equal(scoped?.usedPercent, 59);
    assert.equal(scoped?.label, "Weekly · Fable");
    assert.equal(names.overageIncluded, "Fable");

    // The dozen null codename windows are skipped, not rendered.
    assert.equal(limits.windows.length, 3);
    assert.ok(limits.windows.every((window) => typeof window.resetsAt === "string"));
  });

  it("clears the bars for a login with no subscription windows", () => {
    const { limits } = usageResponseToLimits({
      response: { rate_limits_available: false, rate_limits: null },
      checkedAt: "2026-09-21T00:00:00.000Z"
    });
    assert.equal(limits.unavailable?.reason, "unsupported");
    assert.deepEqual(limits.windows, []);
  });

  it("falls back to the legacy map when limits[] is absent", () => {
    const { limits, names } = usageResponseToLimits({
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: "2026-09-21T05:40:00Z" },
          seven_day: { utilization: 34, resets_at: null },
          nimbus_quill: null,
          model_scoped: [
            { display_name: "Fable", utilization: 7, resets_at: "2026-09-22T04:00:00Z" }
          ]
        }
      },
      checkedAt: "2026-09-21T00:00:00.000Z"
    });
    assert.deepEqual(
      limits.windows.map((window) => window.id),
      [CLAUDE_SESSION_WINDOW_ID, CLAUDE_WEEKLY_WINDOW_ID, scopedWindowId("Fable")]
    );
    assert.equal(names.overageIncluded, "Fable");
  });

  it("maps a streamed event onto the row the probe drew, or onto nothing", () => {
    const update = rateLimitEventToUpdate(
      { rateLimitType: "five_hour", utilization: 0.98, resetsAt: 1789969200 },
      {}
    );
    assert.equal(update?.windows[0]?.id, CLAUDE_SESSION_WINDOW_ID);
    assert.equal(update?.windows[0]?.usedPercent, 98);
    assert.equal(typeof update?.windows[0]?.resetsAt, "string");

    // No percentage on the wire means no row can be drawn.
    assert.equal(
      rateLimitEventToUpdate({ rateLimitType: "five_hour", status: "allowed" }, {}),
      undefined
    );
    // A scoped bucket no probe has named is never guessed at.
    assert.equal(
      rateLimitEventToUpdate(
        { rateLimitType: "seven_day_overage_included", utilization: 0.5 },
        {}
      ),
      undefined
    );
    assert.equal(
      rateLimitEventToUpdate(
        { rateLimitType: "seven_day_overage_included", utilization: 0.5 },
        { overageIncluded: "Fable" }
      )?.windows[0]?.id,
      scopedWindowId("Fable")
    );
  });

  it("recognises a blocking window and its recovery", () => {
    assert.equal(isRateLimitBlocking({ status: "rejected", overageStatus: "rejected" }), true);
    assert.equal(isRateLimitBlocking({ status: "rejected", isUsingOverage: true }), false);
    assert.equal(isRateLimitBlocking({ status: "allowed" }), false);
    assert.equal(isRateLimitClearing({ status: "allowed_warning" }), true);
    assert.equal(isRateLimitClearing({ status: "rejected" }), false);
  });

  it("states the remaining wait rather than a wall-clock time", () => {
    const nowMs = Date.parse("2026-09-21T00:00:00.000Z");
    const message = describeUsageLimit({
      info: { rateLimitType: "five_hour", resetsAt: nowMs / 1000 + 5_400 },
      nowMs,
      names: {}
    });
    assert.ok(message.includes("5-hour"));
    assert.ok(message.includes("1h 30m"), message);
    assert.equal(formatUsageLimitWait(45 * 60_000), "45m");
    assert.equal(formatUsageLimitWait(2 * 60 * 60_000), "2h");

    // An implausible reset ships without a wait rather than a silly one.
    const far = describeUsageLimit({
      info: { rateLimitType: "five_hour", resetsAt: nowMs / 1000 + 400 * 24 * 3600 },
      nowMs,
      names: {}
    });
    assert.ok(!far.includes(" in "), far);
  });
});

describe("claude context usage — the authoritative /context accounting", () => {
  const response = {
    categories: [
      { name: "System prompt", tokens: 106, kind: "used" },
      { name: "Messages", tokens: 8, kind: "used" },
      { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
      { name: "System tools (deferred)", tokens: 13_467, kind: "deferred" },
      { name: "Free space", tokens: 984_132, kind: "free" }
    ],
    totalTokens: 15_868,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 2,
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
    model: "claude-opus-4-8[1m]",
    apiUsage: null
  };

  it("measures against rawMaxTokens and states the reported threshold", () => {
    const snapshot = contextUsageSnapshot(response, undefined);
    assert.ok(snapshot);
    assert.equal(snapshot.usedTokens, 15_868);
    assert.equal(snapshot.maxTokens, 1_000_000);
    assert.equal(snapshot.autoCompactAtTokens, 967_000);
    assert.equal(snapshot.compactsAutomatically, true);
  });

  it("derives the threshold from the buffer rows when the CLI reports none", () => {
    const { autoCompactThreshold: _dropped, ...withoutThreshold } = response;
    const snapshot = contextUsageSnapshot(withoutThreshold, undefined);
    assert.equal(snapshot?.autoCompactAtTokens, 1_000_000 - 33_000);
  });

  it("carries no threshold and says so when auto-compaction is off", () => {
    const snapshot = contextUsageSnapshot({ ...response, isAutoCompactEnabled: false }, undefined);
    assert.equal(snapshot?.autoCompactAtTokens, undefined);
    assert.equal(snapshot?.compactsAutomatically, false);
  });

  it("falls back to maxTokens when rawMaxTokens is missing, and keeps the known total", () => {
    const { rawMaxTokens: _dropped, ...withoutRaw } = response;
    const snapshot = contextUsageSnapshot(withoutRaw, 4_000_000);
    assert.equal(snapshot?.maxTokens, 1_000_000);
    assert.equal(snapshot?.totalProcessedTokens, 4_000_000);
  });

  it("refuses a malformed or empty response rather than emitting a zeroed meter", () => {
    assert.equal(contextUsageSnapshot(null, undefined), undefined);
    assert.equal(contextUsageSnapshot({ totalTokens: "lots" }, undefined), undefined);
    assert.equal(
      contextUsageSnapshot(
        { totalTokens: 0, rawMaxTokens: 200_000, isAutoCompactEnabled: true },
        undefined
      ),
      undefined
    );
  });

  it("reads the real captured payload of fixture 13", () => {
    const control = readClaudeFixture("13-probe-never-yielding.ndjson").find((frame) => {
      const op = (frame.data as { op?: unknown } | null)?.op;
      return frame.kind === "control" && typeof op === "string" && op.startsWith("getContextUsage");
    });
    assert.ok(control, "fixture 13 carries the getContextUsage capture");
    const snapshot = contextUsageSnapshot((control.data as { result: unknown }).result, undefined);
    assert.equal(snapshot?.usedTokens, 15_868);
    assert.equal(snapshot?.maxTokens, 1_000_000);
    assert.equal(snapshot?.autoCompactAtTokens, 967_000);
  });
});

describe("claude totalProcessedTokens comes from modelUsage, not the per-turn rollup", () => {
  it("sums every model's input, output and cache counts", () => {
    const total = totalProcessedFromModelUsage({
      "claude-opus-4-8[1m]": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 500,
        contextWindow: 1_000_000
      },
      "claude-haiku-4-5": {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000
      }
    });
    assert.equal(total, 1_630);
  });

  it("is undefined for a missing or empty map, so the caller can fall back", () => {
    assert.equal(totalProcessedFromModelUsage(undefined), undefined);
    assert.equal(totalProcessedFromModelUsage({}), undefined);
    assert.equal(totalProcessedFromModelUsage("nope"), undefined);
  });
});
