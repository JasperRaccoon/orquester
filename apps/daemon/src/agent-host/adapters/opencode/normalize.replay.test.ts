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

import {
  closeLiveChildAgents,
  normalizeOpenCodeEvent,
  type NormalizeContext,
  type NormalizerSignal
} from "./normalize.ts";
import {
  KNOWN_IGNORED_EVENT_TYPES,
  asRawEvent,
  isHandledEventType,
  type OpenCodeRawEvent
} from "./protocol.ts";
import type { ProviderListResponse } from "./routes.ts";
import { modelContextLimits } from "./snapshot.ts";
import {
  createSessionState,
  makeTurnTokenUsageAccumulator,
  type OpenCodeSessionState
} from "./state.ts";

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
  /** What the capture left behind, so a test can feed frames that follow it. */
  state: OpenCodeSessionState;
  ctx: NormalizeContext;
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
    /** What the server's `limit.context` resolved to for the thread's model. */
    contextMaxTokens?: number;
  } = {}
): Replay {
  const records = readFixture(name);
  const parent = options.sessionId ?? sessionIds(records)[0] ?? "ses_unknown";
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: parent,
    directory: "/repo",
    runtimeMode: options.runtimeMode ?? "approval-required",
    ...(options.contextMaxTokens !== undefined
      ? { contextMaxTokens: options.contextMaxTokens }
      : {})
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

  return { events, signals, types: events.map((event) => event.type), state, ctx };
}

/**
 * Feed frames on after a replay, on its state and its id counter. One list per
 * frame, so a test can say WHICH frame emitted an event.
 */
function feed(replayed: Replay, frames: readonly OpenCodeRawEvent[]): RuntimeEvent[][] {
  return frames.map((frame) => normalizeOpenCodeEvent(replayed.state, frame, replayed.ctx).events);
}

/** Narrow a fold's output to one arm of the union, so payloads typecheck. */
function eventsOfType<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Extract<RuntimeEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: T }> => event.type === type
  );
}

function firstOfType<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Extract<RuntimeEvent, { type: T }> | undefined {
  return eventsOfType(events, type)[0];
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
    const warnings = eventsOfType(events, "runtime.warning").filter((event) =>
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

test("a re-stated title is mirrored once, not on every session.updated", () => {
  const state = createSessionState({
    threadId: "t",
    openCodeSessionId: "ses_1",
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "now" };
  const frame = {
    type: "session.updated",
    properties: { sessionID: "ses_1", info: { id: "ses_1", title: "orquester smoke" } }
  };
  const first = normalizeOpenCodeEvent(state, frame, ctx);
  const second = normalizeOpenCodeEvent(state, frame, ctx);
  const third = normalizeOpenCodeEvent(state, frame, ctx);
  assert.deepEqual(
    first.events.map((event) => event.type),
    ["thread.metadata.updated"]
  );
  assert.deepEqual(second.events, []);
  assert.deepEqual(third.events, []);

  const renamed = normalizeOpenCodeEvent(
    state,
    {
      type: "session.updated",
      properties: { sessionID: "ses_1", info: { id: "ses_1", title: "renamed" } }
    },
    ctx
  );
  assert.deepEqual(
    renamed.events.map((event) => event.type),
    ["thread.metadata.updated"]
  );
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
  const deltas = eventsOfType(events, "content.delta");
  assert.deepEqual(
    deltas.map((event) => event.payload.delta),
    ["hello", " world"]
  );
  assert.deepEqual(
    [...new Set(deltas.map((event) => event.payload.streamKind))],
    ["assistant_text"]
  );
  const completed = eventsOfType(events, "item.completed").filter(
    (event) => event.payload.itemType === "assistant_message"
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
  const opened = eventsOfType(events, "request.opened");
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

  const resolved = eventsOfType(events, "request.resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.payload.decision, "accept");
});

test("03: the bash tool part runs its whole pending -> running -> completed lifecycle", () => {
  const { events } = replay("03-permission-ask-reply-once.ndjson");
  const toolEvents = [
    ...eventsOfType(events, "item.started"),
    ...eventsOfType(events, "item.updated"),
    ...eventsOfType(events, "item.completed")
  ]
    .filter((event) => event.payload.itemType === "command_execution")
    .sort((left, right) => events.indexOf(left) - events.indexOf(right));
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
    eventsOfType(events, "request.opened"),
    []
  );
  const auto = signals.filter((signal) => signal.kind === "auto-reply-permission");
  assert.equal(auto.length, 1);
  // The terminal `permission.replied` must not surface a card the user never
  // saw, either.
  assert.deepEqual(
    eventsOfType(events, "request.resolved"),
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
  const asked = eventsOfType(events, "user-input.requested");
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

  const resolved = eventsOfType(events, "user-input.resolved");
  assert.ok(resolved.length >= 1);
  assert.deepEqual(resolved[0]?.payload.answers, { "question-0-colour-preference": "red" });
});

test("05: a rejected question resolves with no answers", () => {
  const records = readFixture("05-question-asked-reply-and-reject.ndjson");
  const second = sessionIds(records)[1];
  const { events } = replay("05-question-asked-reply-and-reject.ndjson", {
    ...(second !== undefined ? { sessionId: second } : {})
  });
  const resolved = eventsOfType(events, "user-input.resolved");
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
    eventsOfType(events, "runtime.error"),
    [],
    "an acknowledged abort must not become a runtime.error"
  );
  // `session.idle` is the ONLY idle signal after an abort (observation 6).
  assert.ok(signals.some((signal) => signal.kind === "session-idle"));
});

test("07: todos become a plan, and `field:\"text\"` deltas on a reasoning part stream as reasoning", () => {
  const { events } = replay("07-todo-updated.ndjson");
  const plans = eventsOfType(events, "turn.plan.updated");
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
  const compacted = eventsOfType(events, "thread.state.changed").filter(
    (event) => event.payload.state === "compacted"
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
  const rows = eventsOfType(events, "item.completed").filter(
    (event) => event.payload.title === "/fixture"
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

const CHILD_FIXTURE = "12-two-sessions-one-server-and-a-child-session.ndjson";
const CHILD_SESSION_ID = "ses_f3dfd3d8fffeHrM6kT1FcC9I6q";

function replayChildParent(): Replay {
  const parent = sessionIds(readFixture(CHILD_FIXTURE))[2];
  assert.ok(parent !== undefined, "fixture 12's third session is the one with a child");
  return replay(CHILD_FIXTURE, { sessionId: parent });
}

/**
 * Fixture 12's frames by their 1-based line in the capture, with every id in
 * `renames` swapped: the shapes stay verbatim 1.18.5, only the correlation
 * handles are new.
 */
function childFixtureFrames(
  lines: readonly number[],
  renames: Readonly<Record<string, string>> = {}
): OpenCodeRawEvent[] {
  const records = readFixture(CHILD_FIXTURE);
  return lines.map((line) => {
    const record = records[line - 1];
    assert.equal(record?.kind, "sse", `line ${line} is an SSE frame`);
    let text = JSON.stringify(record.data);
    for (const [from, to] of Object.entries(renames)) {
      text = text.replaceAll(from, to);
    }
    const raw = asRawEvent(JSON.parse(text));
    assert.ok(raw !== null, `line ${line} decodes`);
    return raw;
  });
}

/** The capture's launching call: the parent's `task` part for the child. */
const CHILD_LAUNCH_CALL = "call_107260";

/**
 * A `task_id` resume of fixture 12's child, as opencode's `TaskTool` runs one
 * (read from 1.18.32's source, not captured — fixtures README observation 26):
 * **no** `session.created`, because the tool re-prompts the session `task_id`
 * names rather than creating one, and a new `task` part whose `running` frame
 * names that child before the child's own frames begin. Cloned from the
 * capture's lines 140/142/180 (the part), 148 and 156-160 (busy, then one
 * `bash` call) and 177-179 (the settle), with every call, part and message id
 * new.
 */
function resumeFrames(callId: string): {
  pending: OpenCodeRawEvent;
  running: OpenCodeRawEvent;
  /** Busy, then a `bash` call's pending → running → completed. */
  work: OpenCodeRawEvent[];
  /** Busy → idle, then `session.idle`: the child's own settle. */
  settle: OpenCodeRawEvent[];
  completed: OpenCodeRawEvent;
} {
  const renames = {
    [CHILD_LAUNCH_CALL]: callId,
    prt_0c202c25e001GFB7AW0OKeLoLz: `prt_${callId}`,
    msg_0c202b215001elzGd6pT1U41EE: `msg_parent_${callId}`,
    call_174911: `call_bash_${callId}`,
    prt_0c202c732001AGeN2DzE72amve: `prt_bash_${callId}`,
    msg_0c202c2b2001xGlEiTF0IJjyd6: `msg_child_${callId}`
  };
  const [pending, running, completed] = childFixtureFrames([140, 142, 180], renames);
  assert.ok(pending && running && completed);
  return {
    pending,
    running,
    work: childFixtureFrames([148, 156, 157, 158, 159, 160], renames),
    settle: childFixtureFrames([177, 178, 179], renames),
    completed
  };
}

/**
 * A `task` part frame as 1.18.32 reports a call it runs in the BACKGROUND
 * (read from its `TaskTool` source): `metadata.background: true`, and on the
 * `completed` frame — which arrives at once, while the child works on — a
 * `jobId` and an output whose `state` is still `running`.
 */
function inBackground(
  frame: OpenCodeRawEvent,
  summary = "Background task started"
): OpenCodeRawEvent {
  const copy = JSON.parse(JSON.stringify(frame)) as {
    type: string;
    properties: { part: { state: Record<string, unknown> } };
  };
  const state = copy.properties.part.state;
  const metadata = state.metadata as Record<string, unknown>;
  const childId = String(metadata.sessionId);
  const done = state.status === "completed";
  state.metadata = { ...metadata, background: true, ...(done ? { jobId: childId } : {}) };
  if (done) {
    state.output = [
      `<task id="${childId}" state="running">`,
      `<summary>${summary}</summary>`,
      "<task_result>",
      "The task is still working in the background.",
      "</task_result>",
      "</task>"
    ].join("\n");
  }
  return copy;
}

/** The task rows among `events`, as `type:status` (status only where set). */
function taskRows(events: readonly RuntimeEvent[]): string[] {
  return events
    .filter((event) => event.type.startsWith("task."))
    .map((event) => {
      const status = (event.payload as { status?: string }).status;
      return status === undefined ? event.type : `${event.type}:${status}`;
    });
}

test("12: every emitted event belongs to this thread", () => {
  const { events } = replayChildParent();
  for (const event of events) {
    assert.equal(event.threadId, "thread-1");
  }
  assert.ok(events.length > 0);
});

test("12: a child session becomes a roster task, started once and completed once", () => {
  const { events } = replayChildParent();
  const started = eventsOfType(events, "task.started");
  const completed = eventsOfType(events, "task.completed");
  assert.equal(started.length, 1, "exactly one subagent ran in this capture");
  assert.equal(completed.length, 1);

  const start = started[0];
  assert.equal(start?.payload.taskId, CHILD_SESSION_ID, "the task id IS the child session id");
  assert.equal(start?.payload.agentId, CHILD_SESSION_ID);
  assert.equal(start?.agentId, CHILD_SESSION_ID, "and it is stamped on the envelope too");
  assert.equal(start?.payload.taskType, "subagent");
  assert.equal(completed[0]?.payload.status, "completed");
  assert.equal(completed[0]?.payload.taskId, CHILD_SESSION_ID);
});

test("12: the child's first task.started names the call that launched it", () => {
  // The roster fold reopens a settled agent only on a start naming a
  // DIFFERENT call than the previous start did, and both must name one: a
  // first start without its call would leave every later resume of this
  // child reading `completed` while it works.
  const started = eventsOfType(replayChildParent().events, "task.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]?.payload.toolUseId, CHILD_LAUNCH_CALL);
});

test("12: every task row repeats the whole linkage, and never stamps agentKind", () => {
  const { events } = replayChildParent();
  const rows = [
    ...eventsOfType(events, "task.started"),
    ...eventsOfType(events, "task.progress"),
    ...eventsOfType(events, "task.updated"),
    ...eventsOfType(events, "task.completed")
  ];
  assert.ok(rows.length >= 4, `expected a full task lifecycle, saw ${rows.length} rows`);
  for (const row of rows) {
    // §4.2: linkage on EVERY row, so a fold can rebuild an agent whose start
    // row aged out of activity retention.
    assert.equal(row.payload.taskId, CHILD_SESSION_ID, row.type);
    assert.equal(row.payload.agentId, CHILD_SESSION_ID, row.type);
    assert.equal(row.payload.taskType, "subagent", row.type);
    assert.ok(typeof row.payload.title === "string" && row.payload.title.length > 0, row.type);
    // The host stamps `agentKind` at ingestion and does not trust the provider.
    assert.equal(row.payload.agentKind, undefined, row.type);
  }
});

test("12: the parent's `task` tool part supplies the role, the model and the tool call", () => {
  const { events } = replayChildParent();
  const rows = [
    ...eventsOfType(events, "task.progress"),
    ...eventsOfType(events, "task.completed")
  ];
  const enriched = rows.find((row) => row.payload.role !== undefined);
  assert.ok(enriched !== undefined, "the running task part carries metadata.sessionId");
  assert.equal(enriched.payload.role, "explore");
  assert.equal(enriched.payload.model, "openrouter/google/gemini-3.1-flash-lite");
  assert.equal(enriched.payload.toolUseId, "call_107260");
  assert.match(String(enriched.payload.title), /@explore subagent/);
});

test("12: the child's own tool work reaches the roster as progress", () => {
  const { events } = replayChildParent();
  const withTool = eventsOfType(events, "task.progress").filter(
    (event) => event.payload.lastToolName !== undefined
  );
  assert.ok(withTool.length >= 1, "the child ran `bash`; the roster must say so");
  assert.equal(withTool[0]?.payload.lastToolName, "bash");
  assert.equal(withTool[0]?.payload.status, "running");

  // Its status transitions land as non-terminal patches.
  const statuses = eventsOfType(events, "task.updated").map((event) => event.payload.status);
  assert.ok(statuses.includes("running"), `saw ${JSON.stringify(statuses)}`);
});

test("12: a child's items and text are stamped with agentId; the parent's are not", () => {
  const { events } = replayChildParent();
  const items = [
    ...eventsOfType(events, "item.started"),
    ...eventsOfType(events, "item.updated"),
    ...eventsOfType(events, "item.completed")
  ];
  const childItems = items.filter((event) => event.agentId === CHILD_SESSION_ID);
  const parentItems = items.filter((event) => event.agentId === undefined);
  assert.ok(childItems.length >= 1, "the child's `ls -F` must be attributable");
  assert.ok(parentItems.length >= 1, "the parent's own `task` row stays on the timeline");
  for (const event of childItems) {
    // Both places: the envelope for §7.2's re-homing, the payload for the fold.
    assert.equal(event.payload.agentId, CHILD_SESSION_ID);
  }

  const childText = eventsOfType(events, "content.delta").filter(
    (event) => event.agentId === CHILD_SESSION_ID
  );
  assert.ok(childText.length >= 1, "the child's answer must not land in the parent timeline");
  assert.ok(
    childText.some((event) => event.payload.delta.includes("README.md")),
    "the subagent's reply is what it found"
  );
});

test("12: the parent's own `task` row still renders as a collab-agent call", () => {
  const { events } = replayChildParent();
  const taskRows = [
    ...eventsOfType(events, "item.started"),
    ...eventsOfType(events, "item.updated"),
    ...eventsOfType(events, "item.completed")
  ].filter(
    (event) =>
      event.payload.itemType === "collab_agent_tool_call" && event.agentId === undefined
  );
  assert.ok(taskRows.length >= 1);
});

test("12: a child seen during a live turn marks the turn as having subagents", () => {
  const records = readFixture(CHILD_FIXTURE);
  const parent = sessionIds(records)[2];
  assert.ok(parent !== undefined);
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: parent,
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  state.activeTurnId = "turn-1";
  state.turnTokenUsage = makeTurnTokenUsageAccumulator();
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "now" };
  for (const record of records) {
    if (record.kind !== "sse") {
      continue;
    }
    const raw = asRawEvent(record.data);
    if (raw !== null) {
      normalizeOpenCodeEvent(state, raw, ctx);
    }
  }
  assert.equal(state.turnTokenUsage?.hasSubagents, true);
  assert.ok(state.childAgents.has(CHILD_SESSION_ID));
  assert.equal(state.childAgents.get(CHILD_SESSION_ID)?.completed, true);
});

test("12: a child's step-finish tokens never reach the PARENT turn's accumulator", () => {
  // R4 #25(b): the old test asserted this in a comment and then checked
  // something else. Snapshot the accumulator around the child's frames.
  const records = readFixture(CHILD_FIXTURE);
  const parent = sessionIds(records)[2];
  assert.ok(parent !== undefined);
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: parent,
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  state.activeTurnId = "turn-1";
  state.turnTokenUsage = makeTurnTokenUsageAccumulator();
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "now" };

  let childStepFrames = 0;
  for (const record of records) {
    if (record.kind !== "sse") {
      continue;
    }
    const raw = asRawEvent(record.data);
    if (raw === null) {
      continue;
    }
    const isChildStep =
      raw.type === "message.part.updated" &&
      JSON.stringify(raw).includes(CHILD_SESSION_ID) &&
      JSON.stringify(raw).includes('"step-finish"');
    const before: number = state.turnTokenUsage?.partIds.size ?? 0;
    normalizeOpenCodeEvent(state, raw, ctx);
    const after: number = state.turnTokenUsage?.partIds.size ?? 0;
    if (isChildStep) {
      childStepFrames += 1;
      assert.equal(after, before, "a child's step-finish must not be accumulated");
    }
  }
  assert.ok(childStepFrames >= 1, "the capture really does contain a child step-finish");
});

test("a live child is closed `stopped` when the session goes down (§3.1)", () => {
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: "ses_parent",
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  state.activeTurnId = "turn-1";
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "now" };
  normalizeOpenCodeEvent(
    state,
    {
      type: "session.created",
      properties: {
        sessionID: "ses_child",
        info: { id: "ses_child", parentID: "ses_parent", title: "digging (@explore subagent)" }
      }
    },
    ctx
  );
  assert.equal(state.childAgents.get("ses_child")?.completed, false);

  const closing = closeLiveChildAgents(state, ctx, "host is shutting down");
  const closed = eventsOfType(closing, "task.completed");
  assert.equal(closed.length, 1);
  const [event] = closed;
  assert.equal(event?.payload.status, "stopped");
  assert.equal(event?.payload.taskId, "ses_child");
  // Idempotent: a second sweep has nothing left to close.
  assert.deepEqual(closeLiveChildAgents(state, ctx), []);
});

// ---------------------------------------------------------------------------
// A child resumed with `task_id` launches again (fixtures README obs. 26)
// ---------------------------------------------------------------------------

test("a `task_id` resume of a settled child launches it again, and its own idle settles it", () => {
  const run = replayChildParent();
  const child = run.state.childAgents.get(CHILD_SESSION_ID);
  assert.equal(child?.completed, true, "the capture's run settled");
  // The runtime opens the parent's next turn on its prompt.
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  const frames = [
    resume.pending,
    resume.running,
    ...resume.work,
    ...resume.settle,
    resume.completed
  ];
  const perFrame = feed(run, frames);
  const events = perFrame.flat();

  const started = eventsOfType(events, "task.started");
  assert.equal(started.length, 1, "exactly one new start");
  const [start] = started;
  assert.equal(start?.payload.taskId, CHILD_SESSION_ID);
  assert.equal(start?.payload.toolUseId, "call_resume", "naming the new call");
  assert.equal(
    events.find((event) => event.agentId === CHILD_SESSION_ID),
    start,
    "before any row of the run the child owns"
  );
  assert.ok(
    start !== undefined && perFrame[frames.indexOf(resume.running)]?.includes(start),
    "emitted by the part that names the child"
  );

  const rows = taskRows(events);
  assert.equal(rows[0], "task.started");
  assert.deepEqual(
    rows.filter((row) => row.startsWith("task.updated")),
    ["task.updated:running", "task.updated:idle"]
  );
  assert.equal(rows.at(-1), "task.completed:completed");
  const idle = resume.settle.at(-1);
  assert.ok(idle !== undefined);
  assert.deepEqual(
    taskRows(perFrame[frames.indexOf(idle)] ?? []),
    ["task.completed:completed"],
    "settled by the child's own session.idle"
  );
  assert.deepEqual(taskRows(perFrame.at(-1) ?? []), [], "the part's own end adds no second end");
  for (const event of events) {
    if (event.type.startsWith("task.")) {
      assert.equal((event.payload as { toolUseId?: string }).toolUseId, "call_resume", event.type);
    }
  }
});

test("after a relaunch, a stale part of the previous call is neither a run nor its end", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);

  // The capture's own frames of the call that launched the FIRST run.
  const stale = feed(run, childFixtureFrames([147, 180])).flat();
  assert.deepEqual(taskRows(stale), []);

  const ends = eventsOfType(feed(run, resume.settle).flat(), "task.completed");
  assert.equal(ends.length, 1, "the relaunched run is still live, and its own idle settles it");
  assert.equal(ends[0]?.payload.toolUseId, "call_resume", "under the call that launched it");
});

test("a second call on a LIVE child is not a relaunch, and its end does not settle it", () => {
  // 1.18.32's `TaskTool` hands a call naming a child that is still working to
  // the child's running job ("Background task updated") and answers at once.
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);

  const extend = resumeFrames("call_extend");
  const extra = feed(run, [
    extend.pending,
    extend.running,
    inBackground(extend.completed, "Background task updated")
  ]).flat();
  assert.deepEqual(taskRows(extra), []);
  assert.equal(run.state.childAgents.get(CHILD_SESSION_ID)?.completed, false, "still working");

  const ends = eventsOfType(feed(run, resume.settle).flat(), "task.completed");
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.payload.toolUseId, "call_resume", "the run keeps its launching call");
});

test("once a relaunched run settled, a late frame of ANY earlier call is stale", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);
  // A second call while the child works: handed to its running job.
  const extend = resumeFrames("call_extend");
  feed(run, [extend.pending, extend.running]);
  feed(run, [...resume.settle, resume.completed]);
  const child = run.state.childAgents.get(CHILD_SESSION_ID);
  assert.equal(child?.completed, true, "the relaunched run settled");

  // Late live frames of the capture's own launching call (line 147), and of
  // the call handed over while the child worked: a settled child and a live
  // part, but neither call is new.
  const late = feed(run, [...childFixtureFrames([147]), extend.running]).flat();
  assert.deepEqual(taskRows(late), []);
  assert.equal(child?.toolUseId, "call_resume", "the run keeps the call that launched it");
  assert.equal(child?.completed, true);
});

test("a child's title change is a progress row; a re-stated title is not (observation 19)", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);

  // The capture's `session.updated` for the child (line 143), retitled.
  const retitled = childFixtureFrames([143], {
    "list files (@explore subagent)": "list hidden files (@explore subagent)"
  });
  const changed = eventsOfType(feed(run, retitled).flat(), "task.progress");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.payload.summary, "list hidden files (@explore subagent)");
  assert.equal(changed[0]?.payload.title, "list hidden files (@explore subagent)");
  assert.deepEqual(taskRows(feed(run, retitled).flat()), [], "re-stated, it is not a change");
});

test("a relaunched child is closed `stopped` when the session goes down (§3.1)", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);

  const closing = closeLiveChildAgents(run.state, run.ctx, "host is shutting down");
  assert.deepEqual(taskRows(closing), ["task.completed:stopped"]);
  assert.equal(eventsOfType(closing, "task.completed")[0]?.payload.toolUseId, "call_resume");
  assert.deepEqual(closeLiveChildAgents(run.state, run.ctx), []);
});

test("a task part answered in the background does not settle the child it launched", () => {
  // `background: true` (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) ends the
  // part at once, while the child works on: the child's own idle settles it.
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  const renames = {
    [CHILD_SESSION_ID]: "ses_background_child",
    [CHILD_LAUNCH_CALL]: "call_background",
    prt_0c202c25e001GFB7AW0OKeLoLz: "prt_background",
    msg_0c202b215001elzGd6pT1U41EE: "msg_background"
  };
  const [pending, created, running, completed] = childFixtureFrames([140, 141, 142, 180], renames);
  assert.ok(pending && created && running && completed);
  const launch = feed(run, [
    pending,
    created,
    inBackground(running),
    inBackground(completed)
  ]).flat();
  assert.deepEqual(taskRows(launch), ["task.started", "task.progress:running"]);
  assert.equal(eventsOfType(launch, "task.started")[0]?.payload.toolUseId, "call_background");
  assert.equal(run.state.childAgents.get("ses_background_child")?.completed, false);

  const idle = feed(run, childFixtureFrames([179], renames)).flat();
  assert.deepEqual(taskRows(idle), ["task.completed:completed"]);
});

test("a co-tenant session that is NOT a child of this thread is still dropped", () => {
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: "ses_parent",
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  state.activeTurnId = "turn-1";
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "now" };
  const result = normalizeOpenCodeEvent(
    state,
    {
      type: "session.created",
      properties: {
        sessionID: "ses_other",
        info: { id: "ses_other", title: "somebody else's tab" }
      }
    },
    ctx
  );
  assert.deepEqual(result.events, []);
  assert.equal(state.childAgents.size, 0);
});

test("13: three session.error frames for one bad model collapse to one runtime.error", () => {
  const { events } = replay("13-error-shapes.ndjson");
  const errors = eventsOfType(events, "runtime.error");
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
    eventsOfType(events, "session.exited"),
    []
  );
});

// ---------------------------------------------------------------------------
// The context meter (§7.6)
// ---------------------------------------------------------------------------

test("03: every owned step-finish reports the window it carried", () => {
  const { events } = replay("03-permission-ask-reply-once.ndjson", {
    contextMaxTokens: 1_000_000
  });
  const meter = eventsOfType(events, "thread.token-usage.updated");
  // The capture's two owned steps: tokens.total 38 543 then 38 490.
  assert.deepEqual(
    meter.map((event) => event.payload.usage.usedTokens),
    [38_543, 38_490],
    "the numerator is the step's own total, not a running sum"
  );
  for (const row of meter) {
    assert.equal(row.payload.usage.maxTokens, 1_000_000);
    assert.equal(row.payload.usage.compactsAutomatically, true);
  }
  assert.equal(
    meter.at(-1)?.payload.usage.totalProcessedTokens,
    38_543 + 38_490,
    "the thread's running sum is what 'total processed' means"
  );
});

test("03: a model the catalogue never described degrades to a bare count", () => {
  const { events } = replay("03-permission-ask-reply-once.ndjson");
  const meter = eventsOfType(events, "thread.token-usage.updated");
  assert.ok(meter.length > 0, "the count is still reported");
  for (const row of meter) {
    assert.equal(row.payload.usage.maxTokens, undefined, "never a ring against a guess");
  }
});

test("01: the committed /provider capture yields the meter's denominators", () => {
  // The catalogue read lives in `snapshot.ts`, but its input is this capture,
  // so the assertion belongs beside the other fixture-driven ones.
  const providers = readFixture("01-server-start-and-snapshot.ndjson")
    .filter((record) => record.kind === "http")
    .map((record) => record.data as HttpRecord)
    .find((http) => http.method === "GET" && http.path === "/provider")
    ?.responseBody as ProviderListResponse | undefined;
  assert.ok(providers, "fixture 01 captures GET /provider");

  const limits = modelContextLimits(providers);
  assert.ok(limits.size > 0);
  assert.equal(limits.get("anthropic/claude-sonnet-4-6"), 1_000_000);
  assert.equal(
    limits.get("anthropic/not-a-model"),
    undefined,
    "an unknown model has no window, and the meter degrades rather than guessing"
  );
});

test("12: a child session's step-finish tokens never reach the parent's meter", () => {
  const { events } = replay("12-two-sessions-one-server-and-a-child-session.ndjson", {
    sessionId: "ses_f3dfd4e50ffe7r6H3Rf8jBDXUl",
    contextMaxTokens: 400_000
  });
  const used = eventsOfType(events, "thread.token-usage.updated").map(
    (event) => event.payload.usage.usedTokens
  );
  assert.deepEqual(used, [43_803, 43_950], "only the parent's own two steps");
  // The child `ses_f3dfd3d8…` spent 3 538 and 3 585 on the same server; those
  // are a different session's spend (fixtures README observation 19).
  assert.ok(!used.includes(3_538));
  assert.ok(!used.includes(3_585));
});
