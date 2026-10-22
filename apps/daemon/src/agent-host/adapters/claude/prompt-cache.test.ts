/**
 * Idle compaction's input: the prompt-cache lifetime and expiry the Claude adapter stamps on every
 * context reading (`ThreadTokenUsage.promptCacheTtlMs` / `.promptCacheExpiresAt`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent, ThreadTokenUsage } from "@orquester/api/agent-chat";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Clock } from "../../adapter.ts";
import { countingIds, fixedClock, replayClaudeFixture } from "./fixtures.ts";
import { ClaudeNormalizer } from "./normalize.ts";
import { claudePromptCacheTtlMs } from "./usage.ts";

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

function readings(events: readonly RuntimeEvent[]): ThreadTokenUsage[] {
  return events.flatMap((event) => (event.type === "thread.token-usage.updated" ? [event.payload.usage] : []));
}

/** A clock the test moves. */
function movableClock(startIso: string): Clock & { set(iso: string): void } {
  let now = new Date(startIso);
  return {
    now: () => now,
    nowIso: () => now.toISOString(),
    set: (iso) => {
      now = new Date(iso);
    }
  };
}

function frame(event: Record<string, unknown>, parent: string | null = null): SDKMessage {
  return { type: "stream_event", parent_tool_use_id: parent, uuid: "u", session_id: "s", event } as unknown as SDKMessage;
}

function messageStart(id: string, cacheCreation: Record<string, number> | undefined): SDKMessage {
  return frame({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 240_000,
        ...(cacheCreation !== undefined ? { cache_creation: cacheCreation } : {}),
        output_tokens: 1
      }
    }
  });
}

function messageDelta(usage: Record<string, unknown> = {}): SDKMessage {
  return frame({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 240_000, output_tokens: 500, ...usage }
  });
}

describe("claude prompt cache lifetime", () => {
  it("reads 1h before 5m, from the top level or the last iteration, and unknown without a write", () => {
    assert.equal(claudePromptCacheTtlMs({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 9 } }), HOUR);
    assert.equal(claudePromptCacheTtlMs({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 9 } }), 5 * MINUTE);
    assert.equal(claudePromptCacheTtlMs({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), undefined);
    assert.equal(
      claudePromptCacheTtlMs({ iterations: [{ cache_creation: { ephemeral_5m_input_tokens: 3 } }, { cache_creation: { ephemeral_1h_input_tokens: 3 } }] }),
      HOUR
    );
    assert.equal(claudePromptCacheTtlMs({ input_tokens: 5 }), undefined);
    assert.equal(claudePromptCacheTtlMs(null), undefined);
  });

  it("fixture 15: the 1h write on message_start expires an hour after the request", () => {
    const { events } = replayClaudeFixture("15-rate-limits-and-usage.ndjson");
    const stamped = readings(events).filter((usage) => usage.promptCacheExpiresAt !== undefined);
    assert.ok(stamped.length > 0);
    // `fixedClock()` is the request's arrival; the capture wrote `ephemeral_1h_input_tokens: 26045`.
    assert.equal(stamped[0]?.promptCacheTtlMs, HOUR);
    assert.equal(stamped[0]?.promptCacheExpiresAt, "2026-09-21T01:00:00.000Z");
  });

  it("measures from the request's start, not from its response; a 5m write expires five minutes after it", () => {
    const clock = movableClock("2026-10-22T10:00:00.000Z");
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock, ids: countingIds() });
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage(messageStart("m1", { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 }));
    clock.set("2026-10-22T10:00:40.000Z");
    const [usage] = readings(normalizer.handleMessage(messageDelta()));
    assert.equal(usage?.promptCacheTtlMs, 5 * MINUTE);
    assert.equal(usage?.promptCacheExpiresAt, "2026-10-22T10:05:00.000Z");
  });

  it("every later reading carries the latest request's expiry; a request that wrote nothing makes it unknown", () => {
    const clock = movableClock("2026-10-22T10:00:00.000Z");
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock, ids: countingIds() });
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage(messageStart("m1", { ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 0 }));
    normalizer.handleMessage(messageDelta());
    // The authoritative context read after the result knows nothing of the cache: carried over.
    const [context] = readings(normalizer.applyContextUsage({ totalTokens: 250_000, rawMaxTokens: 1_000_000 }, "turn-1"));
    assert.equal(context?.promptCacheExpiresAt, "2026-10-22T11:00:00.000Z");

    // The next request, served whole from the cache: no entry written, expiry unknown.
    clock.set("2026-10-22T10:20:00.000Z");
    normalizer.handleMessage(messageStart("m2", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }));
    const [cached] = readings(normalizer.handleMessage(messageDelta({ output_tokens: 900 })));
    assert.equal(cached?.promptCacheExpiresAt, undefined);
    assert.equal(cached?.promptCacheTtlMs, undefined);

    // A later request that writes again: a fresh expiry, from its own start.
    clock.set("2026-10-22T10:30:00.000Z");
    normalizer.handleMessage(messageStart("m3", { ephemeral_1h_input_tokens: 4_000, ephemeral_5m_input_tokens: 0 }));
    const [fresh] = readings(normalizer.handleMessage(messageDelta({ output_tokens: 1_200 })));
    assert.equal(fresh?.promptCacheExpiresAt, "2026-10-22T11:30:00.000Z");
  });

  it("a message held for its turn and replayed into it keeps its own request time", () => {
    const clock = movableClock("2026-10-22T10:00:00.000Z");
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock, ids: countingIds() });
    // The same message_start seen twice (held, then replayed): timed once.
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage(messageStart("m1", { ephemeral_1h_input_tokens: 2_000 }));
    clock.set("2026-10-22T10:00:30.000Z");
    normalizer.handleMessage(messageStart("m1", { ephemeral_1h_input_tokens: 2_000 }));
    const [usage] = readings(normalizer.handleMessage(messageDelta()));
    assert.equal(usage?.promptCacheExpiresAt, "2026-10-22T11:00:00.000Z");
  });

  it("only the expiry moving is still a new reading", () => {
    const clock = movableClock("2026-10-22T10:00:00.000Z");
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock, ids: countingIds() });
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage(messageStart("m1", { ephemeral_1h_input_tokens: 2_000 }));
    assert.equal(readings(normalizer.handleMessage(messageDelta())).length, 1);
    clock.set("2026-10-22T10:10:00.000Z");
    normalizer.handleMessage(messageStart("m2", { ephemeral_1h_input_tokens: 2_000 }));
    const [same] = readings(normalizer.handleMessage(messageDelta()));
    assert.equal(same?.promptCacheExpiresAt, "2026-10-22T11:10:00.000Z");
  });

  it("a subagent's request never moves the conversation's cache, and a compaction forgets it", () => {
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock: fixedClock("2026-10-22T10:00:00.000Z"), ids: countingIds() });
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage(messageStart("m1", { ephemeral_1h_input_tokens: 2_000 }));
    normalizer.handleMessage(frame({ type: "message_start", message: { id: "sub", usage: { cache_creation: { ephemeral_5m_input_tokens: 9 } } } }, "toolu_1"));
    const [usage] = readings(normalizer.handleMessage(messageDelta()));
    assert.equal(usage?.promptCacheTtlMs, HOUR);

    // The boundary's own reading waits for its summary frame; the next reading after it shows the
    // cache forgotten.
    normalizer.handleMessage({
      type: "system",
      subtype: "compact_boundary",
      uuid: "b",
      session_id: "s",
      compact_metadata: { trigger: "manual", pre_tokens: 250_000, post_tokens: 20_000 }
    } as unknown as SDKMessage);
    const [after] = readings(normalizer.applyContextUsage({ totalTokens: 20_000, rawMaxTokens: 1_000_000 }, "turn-1"));
    assert.equal(after?.usedTokens, 20_000);
    assert.equal(after?.promptCacheExpiresAt, undefined);
  });
});
