/**
 * Replay tests: every recorded capture folded through the normaliser, with the
 * emitted `RuntimeEvent` sequence asserted (spec §9).
 *
 * These live under `src/` on purpose — `apps/daemon/package.json` runs
 * `find src -name '*.test.ts'` — and read the committed captures by path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { captureFiles, readCapture, agentFrames, promptResults, type JsonRpcFrame } from "./fixtures.ts";
import { GrokNormalizer } from "./normalize.ts";
import { XAI_EXTENSION_NOTIFICATIONS, xaiMethodSpellings } from "./acp/_generated/xai.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";

const XAI_CHANNEL_METHODS = new Set<string>([
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_notification),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.session_update),
  ...xaiMethodSpellings(XAI_EXTENSION_NOTIFICATIONS.task_backgrounded)
]);

interface ReplayRun {
  events: RuntimeEvent[];
  normalizer: GrokNormalizer;
}

/** Fold one capture's agent frames through a fresh normaliser. */
function replay(
  file: string,
  options: { turnId?: string; contextWindow?: number } = {}
): ReplayRun {
  let counter = 0;
  const turnId = options.turnId ?? "turn-1";
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
      activeTurnId: () => turnId,
      planHost: {
        platform: "linux",
        env: { GROK_HOME: "~/daemon/agent-accounts/grok/b9682f5c-425a-4c53-be6e-28de477be6c7/home" }
      }
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
  return { events, normalizer };
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

function types(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

function only<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

// ---------------------------------------------------------------------------

test("every capture folds without an unmapped-frame warning", () => {
  const offenders: string[] = [];
  for (const file of captureFiles()) {
    const { events } = replay(file);
    for (const warning of only(events, "runtime.warning")) {
      if (/unmapped/.test(warning.payload.message)) {
        offenders.push(`${file}: ${warning.payload.message} ${JSON.stringify(warning.payload.detail)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a recorded frame reached the unmapped fallback");
});

test("02 plain prompt: assistant text is one segment with a bounded delta stream", () => {
  const { events } = replay("02-prompt-plain-text.ndjson");
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

  assert.equal(
    only(events, "thread.metadata.updated").length,
    0,
    "02 produced no session_info_update"
  );
});

test("02 plain prompt: the running context size becomes thread.token-usage.updated", () => {
  const { events, normalizer } = replay("02-prompt-plain-text.ndjson");
  const usage = only(events, "thread.token-usage.updated");
  assert.ok(usage.length > 0, "the spec says Grok reports no usage; the CLI does");
  assert.ok((usage.at(-1)?.payload.usage.usedTokens ?? 0) > 1_000);
  assert.equal(normalizer.contextSize, usage.at(-1)?.payload.usage.usedTokens);
});

test("02 plain prompt: EVERY chunk-driven meter row carries the window, not just the session's", () => {
  const { events, normalizer } = replay("02-prompt-plain-text.ndjson", { contextWindow: 500_000 });
  const usage = only(events, "thread.token-usage.updated");
  assert.ok(usage.length > 1, "the capture streams many chunks, each with a running total");
  assert.equal(normalizer.contextWindowTokens, 500_000);
  // The client keeps only the LATEST `context-window.updated` row, so one
  // window-less row in the middle of a turn blanks the ring until the next
  // session-level emission — the flicker this pins shut.
  for (const row of usage) {
    assert.equal(row.payload.usage.maxTokens, 500_000, "a chunk row is a full reading, never a partial one");
    assert.equal(row.payload.usage.compactsAutomatically, true);
  }
});

test("a window nobody resolved is omitted rather than invented", () => {
  const { events } = replay("02-prompt-plain-text.ndjson");
  for (const row of only(events, "thread.token-usage.updated")) {
    assert.equal(row.payload.usage.maxTokens, undefined);
  }
});

test("02 plain prompt: the RPC result carries the turn's usage and its cost", () => {
  const results = promptResults(readCapture("02-prompt-plain-text.ndjson"));
  const meta = results[0]?.["_meta"] as Record<string, unknown>;
  const usage = meta["usage"] as Record<string, unknown>;
  assert.equal(usage["inputTokens"], 22423);
  assert.equal(usage["outputTokens"], 30);
  assert.equal(usage["costUsdTicks"], 121_754_000);
});

test("03 allow-once: the write tool is one item lifecycle, ending completed", () => {
  const { events } = replay("03-permission-allow-once.ndjson");
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
  const { events } = replay("03-permission-allow-once.ndjson");
  const named = only(events, "thread.metadata.updated");
  assert.deepEqual(
    named.map((event) => event.payload.name),
    ["Create notes.txt containing exactly hello"]
  );
});

test("03b: the accumulated bash output is coalesced, not one event per resend", () => {
  const { events } = replay("03b-bash-output-accumulation.ndjson");
  const toolEvents = events.filter(
    (event) =>
      event.itemId === "call-a7c3bfe8-967c-4ffe-916f-749b3b6da4c2-0" &&
      (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed")
  );
  // Four `tool_call`/`tool_call_update` frames; the two identical in-progress
  // resends collapse, the terminal one always emits.
  assert.ok(toolEvents.length <= 4 && toolEvents.length >= 2, `got ${toolEvents.length}`);
  assert.equal(toolEvents.at(-1)?.type, "item.completed");
});

test("04 reject: the tool fails and the turn's stop reason is a PermissionRejected cancel", () => {
  const { events } = replay("04-permission-reject.ndjson");
  const failed = only(events, "item.completed").filter((event) => event.payload.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].payload.detail ?? ""), /rejected/i);

  // The discriminator the README asks for, which the captures actually carry.
  const complete = agentFrames(readCapture("04-permission-reject.ndjson")).find(
    (frame) => frame.method === "_x.ai/session/prompt_complete"
  );
  const params = complete?.params as Record<string, unknown>;
  assert.equal(params["stopReason"], "cancelled");
  assert.equal(params["cancellationCategory"], "PermissionRejected");
});

test("05 cancel: the same stop reason carries MidTurnAbort instead", () => {
  const complete = agentFrames(readCapture("05-cancel-with-pending-permission.ndjson")).find(
    (frame) => frame.method === "_x.ai/session/prompt_complete"
  );
  const params = complete?.params as Record<string, unknown>;
  assert.equal(params["stopReason"], "cancelled");
  assert.equal(params["cancellationCategory"], "MidTurnAbort");
});

test("06 session/load: every replayed frame is dropped from the live stream", () => {
  const entries = readCapture("06-session-load-replay.ndjson");
  const replayed = agentFrames(entries).filter((frame) => {
    const params = frame.params as { _meta?: { isReplay?: boolean } } | undefined;
    return params?._meta?.isReplay === true;
  });
  assert.ok(replayed.length >= 3, "the capture really does contain replay frames");

  const { events } = replay("06-session-load-replay.ndjson");
  // The replayed `user_message_chunk` must not reappear as a timeline row.
  assert.equal(
    only(events, "content.delta").some((event) => event.payload.delta === "Reply with exactly: OK"),
    false
  );
});

test("06 session/load: the replay channel is the underscore x.ai method name", () => {
  const methods = new Set(
    agentFrames(readCapture("06-session-load-replay.ndjson"))
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === "string")
  );
  assert.ok(
    methods.has("_x.ai/session/update"),
    "T3 does not register this name; an adapter that skips it loses the replayed usage rows"
  );
});

test("07 plan mode: the plan file write becomes turn.proposed.completed once", () => {
  const { events } = replay("07-plan-mode-exit-plan.ndjson");
  const proposals = only(events, "turn.proposed.completed");
  assert.equal(proposals.length, 1, "deduped per turn");
  assert.match(proposals[0].payload.planMarkdown, /^# Add `subtract` to `add\.js`/);
});

test("07 plan mode: enter/exit are declared by _meta['x.ai/tool'].kind", () => {
  const kinds = new Set<string>();
  for (const frame of agentFrames(readCapture("07-plan-mode-exit-plan.ndjson"))) {
    if (frame.method !== "session/update") {
      continue;
    }
    const update = (frame.params as { update?: Record<string, unknown> }).update;
    const meta = update?.["_meta"] as Record<string, unknown> | undefined;
    const tool = meta?.["x.ai/tool"] as Record<string, unknown> | undefined;
    if (typeof tool?.["kind"] === "string") {
      kinds.add(tool["kind"]);
    }
  }
  assert.ok(kinds.has("enter_plan"));
  assert.ok(kinds.has("exit_plan"));
});

test("10 compact: auto_compact_completed becomes thread.state.changed", () => {
  const { events } = replay("10-compact-and-context.ndjson");
  const compacted = only(events, "thread.state.changed").filter(
    (event) => event.payload.state === "compacted"
  );
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].payload.beforeTokens, 22_462);
  assert.equal(compacted[0].payload.afterTokens, 22_462);
});

test("10 compact: a locally handled slash command reports totalTokens 0, which is not a context size", () => {
  const results = promptResults(readCapture("10-compact-and-context.ndjson"));
  const meta = results.at(-1)?.["_meta"] as Record<string, unknown>;
  assert.equal(meta["totalTokens"], 0);
  const { normalizer } = replay("10-compact-and-context.ndjson");
  assert.notEqual(normalizer.contextSize, 0, "0 must never blank the meter");
});

test("11 background task: the roster and the tool-call join produce one task.started", () => {
  const { events } = replay("11-background-task.ndjson");
  const started = only(events, "task.started");
  assert.equal(started.length, 1);
  assert.equal(started[0].payload.taskId, "01a0c1a7-3335-7fc3-894b-56f0bb60a6db");
  assert.equal(started[0].payload.agentKind, "background");
  assert.equal(started[0].payload.toolUseId, "call-3bd55661-e57d-41e1-a207-08f14c96b78c-0");
  // Nothing was emitted after the turn settled: the task never completes on
  // its own, which is exactly why the adapter must close it on session exit.
  assert.equal(only(events, "task.completed").length, 0);
});

test("11 background task: stopping the session closes every live task", () => {
  const { events, normalizer } = replay("11-background-task.ndjson");
  assert.equal(only(events, "task.started").length, 1);
  const closing = normalizer.stopBackgroundTasks();
  assert.equal(closing.length, 1);
  assert.equal(closing[0].type, "task.completed");
  assert.equal((closing[0] as Extract<RuntimeEvent, { type: "task.completed" }>).payload.status, "stopped");
});

test("hooks on the private channel become hook.started / hook.completed pairs", () => {
  const { events } = replay("02-prompt-plain-text.ndjson");
  const started = only(events, "hook.started");
  const completed = only(events, "hook.completed");
  assert.ok(started.length >= 2, "user_prompt_submit and stop both ran");
  assert.equal(completed.length, started.length);
  assert.equal(completed.every((event) => event.payload.outcome === "success"), true);
});

test("marketing payloads never reach the timeline", () => {
  for (const file of captureFiles()) {
    const { events } = replay(file);
    for (const event of events) {
      const serialised = JSON.stringify(event);
      assert.equal(
        /Hope you are having a wonderful day/.test(serialised),
        false,
        `${file} leaked an announcement into ${event.type}`
      );
    }
  }
});

test("every emitted event carries a unique id and the thread id", () => {
  for (const file of captureFiles()) {
    const { events } = replay(file);
    const ids = new Set<string>();
    for (const event of events) {
      assert.equal(event.threadId, "thread-1");
      assert.equal(ids.has(event.eventId), false, `${file} reused ${event.eventId}`);
      ids.add(event.eventId);
    }
  }
});

test("the emitted types stay inside the documented union", () => {
  const seen = new Set<string>();
  for (const file of captureFiles()) {
    for (const type of types(replay(file).events)) {
      seen.add(type);
    }
  }
  // A regression here means the normaliser started emitting something new;
  // that is fine, but it must be a deliberate edit.
  const expected = [
    "content.delta",
    "hook.completed",
    "hook.started",
    "item.completed",
    "item.started",
    "item.updated",
    "task.started",
    "thread.metadata.updated",
    "thread.state.changed",
    "thread.token-usage.updated",
    "turn.proposed.completed"
  ];
  assert.deepEqual([...seen].sort(), expected);
});
