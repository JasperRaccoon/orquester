/**
 * Claude adapter — the fixture replay harness (spec §9).
 *
 * `apps/daemon/test/fixtures/claude/*.ndjson` is real traffic captured from
 * the CLI installed on this host. This module replays one of those files
 * through {@link ClaudeNormalizer} exactly as the live session would drive it,
 * so a replay test asserts the normalised `RuntimeEvent` sequence against
 * reality rather than against the design's guesses.
 *
 * Shared by the adapter replay and lifecycle tests.
 */

import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeEvent } from "@orquester/api/agent-chat";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Clock, IdGen } from "../../adapter.ts";
import { ClaudeNormalizer } from "./normalize.ts";

export const CLAUDE_FIXTURES_DIR = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/claude"
);

interface FixtureLine {
  t: number;
  kind: "sdk-message" | "input" | "canUseTool" | "canUseToolResult" | "control" | "note";
  data: unknown;
}

export function readClaudeFixture(name: string): FixtureLine[] {
  const raw = readFileSync(nodePath.join(CLAUDE_FIXTURES_DIR, name), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
}

/** A clock that never moves, so a replay is byte-stable (§9). */
export function fixedClock(iso = "2026-09-21T00:00:00.000Z"): Clock {
  const date = new Date(iso);
  return { now: () => date, nowIso: () => iso };
}

/** Counting id generators, so a replay is byte-stable (§9). */
export function countingIds(): IdGen {
  let events = 0;
  let messages = 0;
  let uuids = 0;
  return {
    eventId: () => `ev-${++events}`,
    messageId: (prefix) => `${prefix}-${++messages}`,
    uuid: () => `uuid-${++uuids}`
  };
}

interface ReplayResult {
  events: RuntimeEvent[];
  normalizer: ClaudeNormalizer;
}

/**
 * Replay one capture. `input` lines open a turn (the harness stamps the turn
 * id as the message uuid, exactly as `sendTurn` does). SDK callbacks are
 * exercised through the real session in lifecycle.test.ts.
 */
export function replayClaudeFixture(name: string): ReplayResult {
  const lines = readClaudeFixture(name);
  const normalizer = new ClaudeNormalizer({
    threadId: "thread-fixture",
    clock: fixedClock(),
    ids: countingIds()
  });
  const events: RuntimeEvent[] = [];

  for (const line of lines) {
    switch (line.kind) {
      case "input": {
        const data = line.data as { uuid?: unknown };
        const turnId = typeof data.uuid === "string" ? data.uuid : `turn-${events.length}`;
        events.push(...normalizer.beginTurn({ turnId, anchorUuid: turnId }));
        break;
      }
      case "sdk-message": {
        events.push(...normalizer.handleMessage(line.data as SDKMessage));
        break;
      }
      case "canUseTool":
      case "canUseToolResult":
      case "control":
      case "note":
        break;
    }
  }

  return { events, normalizer };
}

export function eventTypes(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}
