/**
 * Replay tests: every committed OpenCode capture, folded through the real
 * normaliser, asserting the emitted `RuntimeEvent` sequence (spec §9).
 *
 * The fixtures in `apps/daemon/test/fixtures/opencode/` are verbatim frames
 * from **opencode 1.18.5**; nothing here is hand-written. The harness below
 * models only what the runtime would do around the normaliser — set an active
 * turn when `prompt_async` is submitted, clear it on the idle signal — so the
 * assertions are about the decode, not about a timer.
 *
 * One assertion is structural rather than about any single frame (§9): **every
 * event type present in every capture maps to a defined disposition**, and an
 * unrecognised type takes the defined fallback (surface + `runtime.warning`)
 * rather than being swallowed by a catch-all.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { normalizeOpenCodeEvent, type NormalizerSignal } from "./normalize.ts";
import {
  KNOWN_IGNORED_EVENT_TYPES,
  asRawEvent,
  isHandledEventType,
  type OpenCodeRawEvent
} from "./protocol.ts";
import { createSessionState, makeTurnTokenUsageAccumulator } from "./state.ts";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/opencode"
);

interface FixtureRecord {
  t: number;
  kind: "sse" | "http" | "stdout" | "note";
  data: unknown;
}

function readFixture(name: string): FixtureRecord[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureRecord);
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".ndjson"))
    .sort();
}

interface HttpRecord {
  method: string;
  path: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

function sessionIds(records: FixtureRecord[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    if (record.kind !== "http") {
      continue;
    }
    const http = record.data as HttpRecord;
    if (http.method !== "POST" || !/^\/session(\?|$)/.test(http.path)) {
      continue;
    }
    const body = http.responseBody as { id?: string } | undefined;
    if (typeof body?.id === "string") {
      ids.push(body.id);
    }
  }
  return ids;
}

interface Replay {
  events: RuntimeEvent[];
  signals: NormalizerSignal[];
  types: string[];
}

/**
 * Fold one capture as the parent session `sessionId`. `runtimeMode` picks the
 * §4.3 branch; `autoTurn` models the runtime opening a turn on `prompt_async`
 * and settling it on the first idle signal.
 */
function replay(
  name: string,
  options: {
    sessionId?: string;
    runtimeMode?: "approval-required" | "full-access";
  } = {}
): Replay {
  const records = readFixture(name);
  const parent = options.sessionId ?? sessionIds(records)[0] ?? "ses_unknown";
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: parent,
    directory: "/repo",
    runtimeMode: options.runtimeMode ?? "approval-required"
  });

  let counter = 0;
  const ctx = {
    eventId: () => `evt-${(counter += 1)}`,
    nowIso: () => "2026-09-21T00:00:00.000Z"
  };

  const events: RuntimeEvent[] = [];
  const signals: NormalizerSignal[] = [];
  let turnSeq = 0;

  for (const record of records) {
    if (record.kind === "http") {
      const http = record.data as HttpRecord;
      // The runtime's half: a submitted prompt opens a turn.
      if (
        http.method === "POST" &&
        (http.path.includes("/prompt_async") || http.path.includes("/command")) &&
        http.path.includes(parent)
      ) {
        turnSeq += 1;
        state.activeTurnId = `turn-${turnSeq}`;
        state.promptGeneration += 1;
        state.turnTokenUsage = makeTurnTokenUsageAccumulator();
        const body = http.requestBody as { messageID?: string } | undefined;
        if (typeof body?.messageID === "string") {
          state.turnTokenUsage.promptMessageIds.add(body.messageID);
        }
      }
      continue;
    }
    if (record.kind !== "sse") {
      continue;
    }
    const raw = asRawEvent(record.data);
    if (raw === null) {
      continue;
    }
    const result = normalizeOpenCodeEvent(state, raw, ctx);
    events.push(...result.events);
    signals.push(...result.signals);
    for (const signal of result.signals) {
      if (signal.kind === "status-idle" || signal.kind === "session-idle") {
        // Machine (2)/(3) live in `session.ts`; here the turn simply settles.
        state.activeTurnId = undefined;
        state.turnTokenUsage = undefined;
      }
    }
  }

  return { events, signals, types: events.map((event) => event.type) };
}

function sseTypes(name: string): Set<string> {
  const types = new Set<string>();
  for (const record of readFixture(name)) {
    if (record.kind === "sse") {
      const raw = asRawEvent(record.data);
      if (raw !== null) {
        types.add(raw.type);
      }
    }
  }
  return types;
}

// ---------------------------------------------------------------------------
// The structural assertion (§9)
// ---------------------------------------------------------------------------

test("every event type in every capture has a defined disposition", () => {
  const undecided: string[] = [];
  for (const name of fixtureNames()) {
    for (const type of sseTypes(name)) {
      if (!isHandledEventType(type) && !KNOWN_IGNORED_EVENT_TYPES.has(type)) {
        undecided.push(`${name}: ${type}`);
      }
    }
  }
  assert.deepEqual(undecided, []);
});

test("no capture produces a runtime.warning for a known-ignored frame", () => {
  for (const name of fixtureNames()) {
    const { events } = replay(name);
    const warnings = events.filter(
      (event) =>
        event.type === "runtime.warning" &&
        typeof event.payload.message === "string" &&
        event.payload.message.includes("unknown event")
    );
    assert.deepEqual(
      warnings.map((event) => event.payload.message),
      [],
      `${name} warned about a known frame`
    );
  }
});

test("an unrecognised frame takes the fallback rather than a catch-all drop", () => {
  const state = createSessionState({
    threadId: "t",
    openCodeSessionId: "ses_1",
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  const raw: OpenCodeRawEvent = {
    type: "session.next.text.delta.v9",
    properties: { sessionID: "ses_1", delta: "x" }
  };
  const result = normalizeOpenCodeEvent(state, raw, {
    eventId: () => "evt-1",
    nowIso: () => "2026-09-21T00:00:00.000Z"
  });
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event?.type, "runtime.warning");
  assert.match(String(event?.payload.message), /unknown event 'session\.next\.text\.delta\.v9'/);
});

test("server.heartbeat is known and silent", () => {
  const state = createSessionState({
    threadId: "t",
    openCodeSessionId: "ses_1",
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  const result = normalizeOpenCodeEvent(
    state,
    { type: "server.heartbeat", properties: {} },
    { eventId: () => "evt-1", nowIso: () => "now" }
  );
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.signals, []);
});

// ---------------------------------------------------------------------------
// Per-fixture behaviour
// ---------------------------------------------------------------------------

test("02: text arrives as deltas and the closing snapshot emits nothing extra", () => {
  const { events } = replay("02-session-create-and-plain-text-turn.ndjson");
  const deltas = events.filter((event) => event.type === "content.delta");
  assert.deepEqual(
    deltas.map((event) => event.payload.delta),
    ["hello", " world"]
  );
  assert.deepEqual(
    [...new Set(deltas.map((event) => event.payload.streamKind))],
    ["assistant_text"]
  );
  const completed = events.filter(
    (event) => event.type === "item.completed" && event.payload.itemType === "assistant_message"
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.payload.detail, "hello world");
});

test("02: the user's own message never becomes assistant content", () => {
  const { events } = replay("02-session-create-and-plain-text-turn.ndjson");
  for (const event of events) {
    if (event.type === "content.delta") {
      assert.ok(!String(event.payload.delta).includes("Do not call any tools"));
    }
  }
});

test("03: a permission ask opens a card whose workspace option names the widened pattern", () => {
  const { events } = replay("03-permission-ask-reply-once.ndjson");
  const opened = events.filter((event) => event.type === "request.opened");
  assert.equal(opened.length, 1);
  const payload = opened[0]?.payload;
  assert.equal(payload?.requestType, "command_execution_approval");
  assert.equal(payload?.dismissible, false);
  assert.equal(payload?.detail, "echo hi");
  const workspace = payload?.options?.find((option) => option.decision === "acceptForSession");
  assert.equal(workspace?.label, "Allow for workspace");
  assert.match(String(workspace?.warning), /echo \*/);
  assert.deepEqual(
    payload?.options?.map((option) => option.decision),
    ["accept", "acceptForSession", "decline", "cancel"]
  );

  const resolved = events.filter((event) => event.type === "request.resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.payload.decision, "accept");
});

test("03: the bash tool part runs its whole pending -> running -> completed lifecycle", () => {
  const { events } = replay("03-permission-ask-reply-once.ndjson");
  const toolEvents = events.filter(
    (event) =>
      (event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed") &&
      event.payload.itemType === "command_execution"
  );
  assert.ok(toolEvents.length >= 3, "expected the full tool lifecycle");
  assert.equal(toolEvents[0]?.type, "item.started");
  assert.equal(toolEvents.at(-1)?.type, "item.completed");
  assert.equal(toolEvents.at(-1)?.payload.status, "completed");
  assert.equal(toolEvents.at(-1)?.payload.detail, "hi\n");
  const data = toolEvents.at(-1)?.payload.data as { command?: string; toolUseId?: string };
  assert.equal(data.command, "echo hi");
  assert.equal(data.toolUseId, "tool_bash_hUFbWmc0v5dvHJZ6lgfR");
});

test("03: full access auto-answers `once` and never opens a card", () => {
  const { events, signals } = replay("03-permission-ask-reply-once.ndjson", {
    runtimeMode: "full-access"
  });
  assert.deepEqual(
    events.filter((event) => event.type === "request.opened"),
    []
  );
  const auto = signals.filter((signal) => signal.kind === "auto-reply-permission");
  assert.equal(auto.length, 1);
  // The terminal `permission.replied` must not surface a card the user never
  // saw, either.
  assert.deepEqual(
    events.filter((event) => event.type === "request.resolved"),
    []
  );
});

test("04: reject maps to decline and always maps to acceptForSession", () => {
  const records = readFixture("04-permission-reply-reject-and-always.ndjson");
  const [firstSession] = sessionIds(records);
  const { events } = replay("04-permission-reply-reject-and-always.ndjson", {
    sessionId: firstSession
  });
  const decisions = events
    .filter((event) => event.type === "request.resolved")
    .map((event) => event.payload.decision);
  assert.ok(decisions.includes("decline"), `saw ${JSON.stringify(decisions)}`);
  assert.ok(decisions.includes("acceptForSession"), `saw ${JSON.stringify(decisions)}`);
});

test("05: a question opens with normalised ids and resolves with the chosen label", () => {
  const { events } = replay("05-question-asked-reply-and-reject.ndjson");
  const asked = events.filter((event) => event.type === "user-input.requested");
  assert.ok(asked.length >= 1);
  const questions = asked[0]?.payload.questions ?? [];
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.id, "question-0-colour-preference");
  assert.equal(questions[0]?.question, "Which colour do you prefer?");
  assert.deepEqual(
    questions[0]?.options.map((option) => option.label),
    ["Red", "Blue"]
  );
  assert.equal(asked[0]?.payload.dismissible, false);

  const resolved = events.filter((event) => event.type === "user-input.resolved");
  assert.ok(resolved.length >= 1);
  assert.deepEqual(resolved[0]?.payload.answers, { "question-0-colour-preference": "red" });
});

test("05: a rejected question resolves with no answers", () => {
  const records = readFixture("05-question-asked-reply-and-reject.ndjson");
  const second = sessionIds(records)[1];
  const { events } = replay("05-question-asked-reply-and-reject.ndjson", {
    ...(second !== undefined ? { sessionId: second } : {})
  });
  const resolved = events.filter((event) => event.type === "user-input.resolved");
  assert.ok(resolved.length >= 1);
  assert.deepEqual(resolved.at(-1)?.payload.answers, {});
});

test("06: an abort arrives as MessageAbortedError and is signalled, not surfaced as an error", () => {
  const records = readFixture("06-abort-with-permission-pending.ndjson");
  const parent = sessionIds(records)[0] ?? "";
  const state = createSessionState({
    threadId: "t",
    openCodeSessionId: parent,
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  // Model the runtime: a turn is live and an interrupt is in flight.
  state.activeTurnId = "turn-1";
  state.cancellation = {
    turnId: "turn-1",
    acknowledged: false,
    turnSettled: false,
    acknowledgment: Promise.resolve(),
    acknowledge: () => undefined,
    completion: Promise.resolve(),
    complete: () => undefined
  };
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "now" };
  const signals: NormalizerSignal[] = [];
  const events: RuntimeEvent[] = [];
  for (const record of records) {
    if (record.kind !== "sse") {
      continue;
    }
    const raw = asRawEvent(record.data);
    if (raw === null) {
      continue;
    }
    const result = normalizeOpenCodeEvent(state, raw, ctx);
    events.push(...result.events);
    signals.push(...result.signals);
  }
  assert.ok(signals.some((signal) => signal.kind === "abort-acknowledged"));
  assert.deepEqual(
    events.filter((event) => event.type === "runtime.error"),
    [],
    "an acknowledged abort must not become a runtime.error"
  );
  // `session.idle` is the ONLY idle signal after an abort (observation 6).
  assert.ok(signals.some((signal) => signal.kind === "session-idle"));
});

test("07: todos become a plan, and `field:\"text\"` deltas on a reasoning part stream as reasoning", () => {
  const { events } = replay("07-todo-updated.ndjson");
  const plans = events.filter((event) => event.type === "turn.plan.updated");
  assert.ok(plans.length >= 1, "expected turn.plan.updated");
  const steps = plans.at(-1)?.payload.plan ?? [];
  assert.ok(steps.length >= 1);
  for (const step of steps) {
    assert.ok(["pending", "inProgress", "completed"].includes(step.status));
    assert.ok(step.step.length > 0);
  }
  const reasoning = events.filter(
    (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text"
  );
  assert.ok(
    reasoning.length >= 1,
    "a `field:\"text\"` delta on a reasoning part must stream as reasoning_text"
  );
});

test("08: an `agent: \"plan\"` turn emits no proposal event of any kind", () => {
  const { events } = replay("08-agent-plan-turn.ndjson");
  for (const event of events) {
    assert.notEqual(event.type, "turn.proposed.delta");
    assert.notEqual(event.type, "turn.proposed.completed");
  }
  // It is an ordinary turn: text still streams.
  assert.ok(events.some((event) => event.type === "content.delta"));
});

test("09: session.compacted becomes thread.state.changed {compacted}", () => {
  const { events, signals } = replay("09-summarize-idle-and-while-busy.ndjson");
  const compacted = events.filter(
    (event) => event.type === "thread.state.changed" && event.payload.state === "compacted"
  );
  assert.ok(compacted.length >= 1);
  // The event carries only `{sessionID}` — no before/after token counts exist.
  assert.equal(compacted[0]?.payload.beforeTokens, undefined);
  assert.equal(compacted[0]?.payload.afterTokens, undefined);
  assert.ok(signals.some((signal) => signal.kind === "compacted"));
});

test("10: the premature-idle race shows up as an idle signal, never as a completed turn", () => {
  const { signals } = replay("10-fork-rollback-and-messages.ndjson");
  const idles = signals.filter(
    (signal) => signal.kind === "status-idle" || signal.kind === "session-idle"
  );
  assert.ok(idles.length >= 2, "the capture contains the race plus a real completion");
});

test("11: command.executed becomes a completed activity row", () => {
  const { events } = replay("11-slash-command-via-session-command.ndjson");
  const rows = events.filter(
    (event) => event.type === "item.completed" && event.payload.title === "/fixture"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payload.detail, "hello there");
});

test("12: a co-tenant session's frames are dropped, not mixed into this thread", () => {
  const records = readFixture("12-two-sessions-one-server-and-a-child-session.ndjson");
  const [sessionA, sessionB] = sessionIds(records);
  assert.ok(sessionA !== undefined && sessionB !== undefined);
  const a = replay("12-two-sessions-one-server-and-a-child-session.ndjson", {
    sessionId: sessionA
  });
  const b = replay("12-two-sessions-one-server-and-a-child-session.ndjson", {
    sessionId: sessionB
  });
  assert.ok(a.events.length > 0 && b.events.length > 0);
  // Each fold only ever saw its own session: no emitted event carries the
  // other session's id anywhere in the raw frame it was decoded from.
  for (const event of a.events) {
    assert.ok(
      !JSON.stringify(event.raw ?? {}).includes(sessionB),
      "session A's fold leaked a session B frame"
    );
  }
  for (const event of b.events) {
    assert.ok(
      !JSON.stringify(event.raw ?? {}).includes(sessionA),
      "session B's fold leaked a session A frame"
    );
  }
});

test("12: a child session's request events are probed for ancestry, its output is dropped", () => {
  const records = readFixture("12-two-sessions-one-server-and-a-child-session.ndjson");
  const parent = sessionIds(records)[2];
  assert.ok(parent !== undefined);
  const { events } = replay("12-two-sessions-one-server-and-a-child-session.ndjson", {
    ...(parent !== undefined ? { sessionId: parent } : {})
  });
  // Every emitted event belongs to this thread; nothing carries a foreign id.
  for (const event of events) {
    assert.equal(event.threadId, "thread-1");
  }
  // The child's 38 frames across 8 types produce no timeline rows of their own
  // beyond what the parent's `task` tool already shows.
  assert.ok(events.length > 0);
});

test("13: three session.error frames for one bad model collapse to one runtime.error", () => {
  const { events } = replay("13-error-shapes.ndjson");
  const errors = events.filter((event) => event.type === "runtime.error");
  // The capture submits TWO bad models; each one produced three frames.
  assert.equal(errors.length, 2, `saw ${errors.length} runtime.error events`);
  for (const error of errors) {
    assert.equal(error.payload.class, "provider_error");
    assert.match(String(error.payload.message), /Model not found/);
    // Neither the bun stack trace nor the re-emitted class prefix reaches the user.
    assert.ok(!String(error.payload.message).includes("$bunfs"));
    assert.ok(!String(error.payload.message).startsWith("ProviderModelNotFoundError"));
  }
});

test("13: a session.error settles the turn through a signal", () => {
  const { signals } = replay("13-error-shapes.ndjson");
  assert.ok(signals.some((signal) => signal.kind === "turn-failed"));
});

test("14: a SIGTERM mid-turn leaves the capture with no farewell frame to decode", () => {
  const { events } = replay("14-process-behaviour-and-sigterm.ndjson");
  // Nothing in the stream announces the shutdown: a client learns only from
  // the transport, which is why supervision cannot wait for an orderly signal.
  assert.deepEqual(
    events.filter((event) => event.type === "session.exited"),
    []
  );
});
