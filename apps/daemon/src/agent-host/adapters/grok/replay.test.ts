/**
 * Replay tests: recorded scenarios folded through the normaliser, with the
 * emitted `RuntimeEvent` sequence asserted (spec §9).
 *
 * These live under `src/` on purpose — `apps/daemon/package.json` runs
 * `find src -name '*.test.ts'` — and read the committed captures by path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { createTestClock } from "../../orchestration/testing/fakes.ts";
import { readCapture, agentFrames, type JsonRpcFrame } from "./fixtures.ts";
import { GrokNormalizer } from "./normalize.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { XAI_ROUTED_METHODS as XAI_CHANNEL_METHODS, driveCapture } from "./testing/capture-driver.ts";

/** Fold one capture's agent frames through a fresh normaliser. */
function replay(
  file: string,
  options: { contextWindow?: number } = {}
): RuntimeEvent[] {
  let counter = 0;
  const normalizer = new GrokNormalizer(
    {
      threadId: "thread-1",
      stamp: () => {
        counter += 1;
        return { eventId: `e${counter}`, createdAt: `2026-09-21T00:00:${String(counter % 60).padStart(2, "0")}.000Z` };
      },
      uuid: () => {
        counter += 1;
        return `u${counter}`;
      },
      activeTurnId: () => "turn-1",
      planHost: {
        platform: "linux",
        env: { GROK_HOME: "~/daemon/agent-accounts/grok/<account-id>/home" }
      },
      launchNonce: "replay"
    },
    "session-1"
  );
  // What the session does after the handshake resolves
  // `modelState.availableModels[]._meta.totalContextTokens`.
  normalizer.setContextWindow(options.contextWindow);
  normalizer.beginTurn();

  const events: RuntimeEvent[] = [];
  for (const frame of agentFrames(readCapture(file))) {
    events.push(...route(normalizer, frame));
  }
  return events;
}

function route(normalizer: GrokNormalizer, frame: JsonRpcFrame): RuntimeEvent[] {
  const method = frame.method;
  if (typeof method !== "string") {
    return [];
  }
  if (method === "session/update") {
    return normalizer.handleSessionUpdate(frame.params as SessionNotification);
  }
  if (XAI_CHANNEL_METHODS.has(method)) {
    return normalizer.handleXaiNotification(method, frame.params);
  }
  return [];
}

function only<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

// ---------------------------------------------------------------------------

test("02 plain prompt: assistant text is one segment with a bounded delta stream", () => {
  const events = replay("02-prompt-plain-text.ndjson");
  const started = only(events, "item.started").filter(
    (event) => event.payload.itemType === "assistant_message"
  );
  const completed = only(events, "item.completed").filter(
    (event) => event.payload.itemType === "assistant_message"
  );
  assert.equal(started.length, 1, "one assistant segment opened");
  assert.equal(completed.length, 0, "the segment is closed by endTurn, not by a frame");

  const deltas = only(events, "content.delta");
  const assistant = deltas.filter((event) => event.payload.streamKind === "assistant_text");
  const reasoning = deltas.filter((event) => event.payload.streamKind === "reasoning_text");
  assert.equal(assistant.map((event) => event.payload.delta).join(""), "OK");
  assert.ok(reasoning.length > 5, "thought chunks stream as reasoning_text");
  // Reasoning is never attached to an assistant item.
  assert.equal(reasoning.every((event) => event.itemId === undefined), true);
  assert.equal(assistant.every((event) => event.itemId === started[0].itemId), true);
});

test("02 plain prompt: EVERY chunk-driven meter row carries the window, not just the session's", () => {
  const events = replay("02-prompt-plain-text.ndjson", { contextWindow: 500_000 });
  const usage = only(events, "thread.token-usage.updated");
  assert.ok(usage.length > 1, "the capture streams many chunks, each with a running total");
  // The client keeps only the LATEST `context-window.updated` row, so one
  // window-less row in the middle of a turn blanks the ring until the next
  // session-level emission — the flicker this pins shut.
  for (const row of usage) {
    assert.equal(row.payload.usage.maxTokens, 500_000, "a chunk row is a full reading, never a partial one");
    assert.equal(row.payload.usage.compactsAutomatically, true);
  }
});

test("a window nobody resolved is omitted rather than invented", () => {
  const usage = only(replay("02-prompt-plain-text.ndjson"), "thread.token-usage.updated");
  assert.ok(usage.length > 0, "the capture still produces context readings");
  for (const row of usage) {
    assert.equal(row.payload.usage.maxTokens, undefined);
  }
});

test("03 allow-once: the write tool is one item lifecycle, ending completed", () => {
  const events = replay("03-permission-allow-once.ndjson");
  const items = events.filter(
    (event) =>
      (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
      event.itemId?.startsWith("call-") === true
  );
  assert.ok(items.length >= 2, "the tool call produced at least a start and an end");
  const terminal = only(events, "item.completed").filter(
    (event) => event.itemId === "call-486f0cb1-3534-4c3c-a237-e7d938aaa418-0"
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].payload.status, "completed");
  assert.equal(terminal[0].payload.itemType, "file_change");
});

test("03 allow-once: the session title arrives as thread.metadata.updated", () => {
  const events = replay("03-permission-allow-once.ndjson");
  const named = only(events, "thread.metadata.updated");
  assert.deepEqual(
    named.map((event) => event.payload.name),
    ["Create notes.txt containing exactly hello"]
  );
});

test("04 reject: the tool fails with the provider rejection detail", () => {
  const events = replay("04-permission-reject.ndjson");
  const failed = only(events, "item.completed").filter((event) => event.payload.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].payload.detail ?? ""), /rejected/i);
});

test("05 Stop: the write its permission held is closed with the turn it cut — the CLI never answers it", () => {
  const WRITE = "call-02831799-9eea-411d-8f2d-a4d739e7504f-0";
  const run = driveCapture("05-cancel-with-pending-permission.ndjson", {
    atNote: (note, control) => (/sending session\/cancel notification/.test(note) ? control.interrupt() : [])
  });
  const rows = run.events.filter(
    (event) => event.type.startsWith("item.") && (event as { itemId?: string }).itemId === WRITE
  );
  const closed = rows.filter((row) => row.type === "item.completed");
  assert.equal(closed.length, 1, "closed once");
  const payload = closed[0]!.payload as { status?: string; detail?: string };
  assert.deepEqual([closed[0]!.turnId, payload.status, payload.detail], ["turn-1", "failed", "Stopped."]);
  const turnEnd = run.events.findIndex((event) => event.type === "turn.completed" && event.turnId === "turn-1");
  assert.ok(run.events.indexOf(closed[0]!) < turnEnd, "before the turn it rides settles");
});

test("07 plan mode: the plan file write becomes turn.proposed.completed once", () => {
  const events = replay("07-plan-mode-exit-plan.ndjson");
  const proposals = only(events, "turn.proposed.completed");
  assert.equal(proposals.length, 1, "deduped per turn");
  assert.match(proposals[0].payload.planMarkdown, /^# Add `subtract` to `add\.js`/);
});

test("10 compact: auto_compact_completed becomes thread.state.changed", () => {
  const events = replay("10-compact-and-context.ndjson");
  const compacted = only(events, "thread.state.changed").filter(
    (event) => event.payload.state === "compacted"
  );
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].payload.beforeTokens, 22_462);
  assert.equal(compacted[0].payload.afterTokens, 22_462);
});

test("11 background task: the roster and the tool-call join produce one task.started", () => {
  const events = replay("11-background-task.ndjson");
  const started = only(events, "task.started");
  assert.equal(started.length, 1);
  assert.equal(started[0].payload.taskId, "01a0c1a7-3335-7fc3-894b-56f0bb60a6db");
  assert.equal(started[0].payload.agentKind, "background");
  assert.equal(started[0].payload.toolUseId, "call-3bd55661-e57d-41e1-a207-08f14c96b78c-0");
  // Nothing ended it in the 22 s the capture watched (the `sleep 25` outlived
  // it, observation 29), and nobody polled it — which is exactly why the
  // adapter must close it on session exit.
  assert.equal(only(events, "task.completed").length, 0);
});

test("11 background task: the shell is live work — monitoring — in the real registry, bounded by its TTL", () => {
  // Every task row of a Grok shell names the shell itself as its `agentId`;
  // the registry once read that as "a subagent's own shell" and dropped it, so
  // a dev server left running neither read "monitoring" nor held a deploy.
  const events = replay("11-background-task.ndjson");
  const clock = createTestClock(0);
  const registry = createLivenessRegistry({ clock });
  for (const event of events) {
    registry.observe(event);
  }
  assert.equal(registry.liveness("thread-1"), "monitoring");
  assert.equal(registry.liveAgentCount("thread-1"), 0);
  clock.set(600_000);
  assert.equal(registry.liveness("thread-1"), null, "the TTL still bounds a silent shell");
});

test("hooks on the private channel become hook.started / hook.completed pairs", () => {
  const events = replay("02-prompt-plain-text.ndjson");
  const started = only(events, "hook.started");
  const completed = only(events, "hook.completed");
  assert.ok(started.length >= 2, "user_prompt_submit and stop both ran");
  assert.equal(completed.length, started.length);
  assert.equal(completed.every((event) => event.payload.outcome === "success"), true);
});
