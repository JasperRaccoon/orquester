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

import {
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type RuntimeEvent,
  type RuntimeSubagent
} from "@orquester/api/agent-chat";

import { createIngestion } from "../../ingestion/index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen
} from "../../ingestion/test-harness.ts";
import { joinToolOutput } from "../../store/tool-output.ts";
import {
  closeLiveChildAgents,
  normalizeOpenCodeEvent,
  settleChildSurvival,
  taskResultText,
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
  advanceOutputMark,
  borderOverlap,
  claimPrompt,
  createSessionState,
  makeTurnTokenUsageAccumulator,
  suffixPrefixOverlap,
  type OpenCodeSessionState
} from "./state.ts";
import {
  childLaunch,
  compactionContinues,
  compactionPrompt,
  compactionSummary,
  wokenReply
} from "./testing/woken.ts";

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

  // The runtime's half, again: `sendTurn` claims the prompt it mints before
  // it submits it, so no reply to it is ever taken for one the server wrote
  // itself — and a blocking `/command` is recorded only when it returns,
  // after the frames of its reply (fixture 11).
  for (const record of records) {
    const http = record.data as HttpRecord;
    const body = http.requestBody as { messageID?: string } | undefined;
    if (
      record.kind === "http" &&
      http.method === "POST" &&
      (http.path.includes("/prompt_async") || http.path.includes("/command")) &&
      http.path.includes(parent) &&
      typeof body?.messageID === "string"
    ) {
      claimPrompt(state, body.messageID);
    }
  }

  // And `compact()` holds `hostCompacting` up while its `summarize` runs. That
  // request too is recorded only when it returns (fixture 09), so the flag
  // goes up at its own first frame — its prompt's manual `compaction` part —
  // and down at its record.
  let summarizing = records.filter((record) => {
    const http = record.data as HttpRecord;
    return (
      record.kind === "http" &&
      http.method === "POST" &&
      http.path.includes("/summarize") &&
      http.path.includes(parent)
    );
  }).length;

  for (const record of records) {
    if (record.kind === "http") {
      const http = record.data as HttpRecord;
      if (http.method === "POST" && http.path.includes("/summarize") && http.path.includes(parent)) {
        state.hostCompacting = false;
        summarizing -= 1;
      }
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
    const part = (raw.properties as { part?: { type?: unknown; auto?: unknown; sessionID?: unknown } } | undefined)
      ?.part;
    if (summarizing > 0 && part?.type === "compaction" && part.auto === false && part.sessionID === parent) {
      state.hostCompacting = true;
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
function feed(
  replayed: Pick<Replay, "state" | "ctx">,
  frames: readonly OpenCodeRawEvent[]
): RuntimeEvent[][] {
  return frames.map((frame) => normalizeOpenCodeEvent(replayed.state, frame, replayed.ctx).events);
}

/** A fresh thread on the upstream session `sessionId`, with a turn running. */
function liveSession(sessionId: string): Pick<Replay, "state" | "ctx"> {
  const state = createSessionState({
    threadId: "thread-1",
    openCodeSessionId: sessionId,
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  state.activeTurnId = "turn-1";
  let counter = 0;
  return {
    state,
    ctx: { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "2026-09-21T00:00:00.000Z" }
  };
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

/**
 * Run runtime events through the host's REAL ingestion and fold what it writes
 * with the real thread fold: the log's events, and the roster the user reads.
 */
async function throughHost(
  events: readonly RuntimeEvent[]
): Promise<{ log: DomainEvent[]; roster: RuntimeSubagent[] }> {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  for (const event of events) {
    await ingestion.ingest(event);
  }
  await ingestion.drain();
  // `thread.created` is the host's, not ingestion's.
  let state = applyDomainEvent(createEmptyThreadState(), {
    seq: 1,
    eventId: "created",
    threadId: "thread-1",
    occurredAt: "2026-09-21T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      projectPath: "/repo",
      cwd: "/repo",
      title: "New thread",
      adapter: "opencode",
      refId: "opencode",
      accountId: "",
      home: "system",
      modelSelection: { model: "openrouter/google/gemini-3.1-flash-lite" },
      runtimeMode: "approval-required"
    }
  });
  const log: DomainEvent[] = [];
  for (const event of sink.events()) {
    const stamped = { ...event, seq: log.length + 2 } as DomainEvent;
    log.push(stamped);
    state = applyDomainEvent(state, stamped);
  }
  return { log, roster: state.roster };
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

test("06: an abort arrives as MessageAbortedError, the Stop's own answer on the stream — never surfaced as an error", () => {
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
  state.cancellation = { turnId: "turn-1", deferredIdle: false };
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
  assert.deepEqual(
    eventsOfType(events, "runtime.error"),
    [],
    "an acknowledged abort must not become a runtime.error"
  );
  assert.ok(!signals.some((signal) => signal.kind === "turn-failed"), "nor fail the turn: the Stop settles it");
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
/**
 * What the child answered: the parent `task` part's output (line 180) inside
 * the `<task id="…" state="completed"><task_result>` envelope the tool wraps
 * it in for the parent's model.
 */
const CHILD_RESULT = "The files in the current directory are:\n\n- README.md\n- a.ts";

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
  return fixtureFrames(CHILD_FIXTURE, lines, renames);
}

/** A capture's frames by their 1-based line, with every id in `renames` swapped. */
function fixtureFrames(
  name: string,
  lines: readonly number[],
  renames: Readonly<Record<string, string>> = {}
): OpenCodeRawEvent[] {
  const records = readFixture(name);
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
 * new — and any text in `edits` swapped too (the answer, say).
 */
function resumeFrames(
  callId: string,
  edits: Readonly<Record<string, string>> = {}
): {
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
    msg_0c202c2b2001xGlEiTF0IJjyd6: `msg_child_${callId}`,
    ...edits
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

test("12: a child session is a roster task: one start, one end, then the run's result", () => {
  const { events } = replayChildParent();
  const started = eventsOfType(events, "task.started");
  const completed = eventsOfType(events, "task.completed");
  assert.equal(started.length, 1, "exactly one subagent ran in this capture");

  const start = started[0];
  assert.equal(start?.payload.taskId, CHILD_SESSION_ID, "the task id IS the child session id");
  assert.equal(start?.payload.agentId, CHILD_SESSION_ID);
  assert.equal(start?.agentId, CHILD_SESSION_ID, "and it is stamped on the envelope too");
  assert.equal(start?.payload.taskType, "subagent");
  // The child's own `session.idle` (line 179) ends the run; the parent's part
  // that follows it (line 180) adds the result to that end, and ends nothing.
  assert.deepEqual(
    completed.map((event) => [event.payload.status, event.payload.summary]),
    [
      ["completed", undefined],
      ["completed", CHILD_RESULT]
    ]
  );
  for (const event of completed) {
    assert.equal(event.payload.taskId, CHILD_SESSION_ID);
    assert.equal(event.payload.toolUseId, CHILD_LAUNCH_CALL, "one run, the capture's own");
  }
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
  // The session's title, less the "(@explore subagent)" the role already says.
  assert.equal(enriched.payload.title, "list files");
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

test("12: the child's own steps are its roster usage, and never the parent's meter", () => {
  const { events } = replayChildParent();
  const usages = eventsOfType(events, "task.progress")
    .map((event) => event.payload.usage)
    .filter((usage) => usage !== undefined);
  // The child's two `step-finish` parts (lines 161 and 174), summed once each
  // however often a part is restated.
  assert.deepEqual(usages.at(-1), {
    totalTokens: 3538 + 3585,
    inputTokens: 3454 + 3544,
    cachedInputTokens: 0,
    outputTokens: 16 + 68 + 18 + 23,
    reasoningOutputTokens: 68 + 23,
    toolUses: 1
  });
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
    (event) => event.agentId === CHILD_SESSION_ID && event.payload.streamKind === "assistant_text"
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
  const settledBy = eventsOfType(perFrame[frames.indexOf(idle)] ?? [], "task.completed");
  assert.deepEqual(
    settledBy.map((event) => [event.payload.status, event.payload.summary]),
    [["completed", undefined]],
    "settled by the child's own session.idle"
  );
  // The part's own end ends nothing: it gives the run its result.
  const result = eventsOfType(perFrame.at(-1) ?? [], "task.completed");
  assert.deepEqual(
    result.map((event) => [event.payload.status, event.payload.summary]),
    [["completed", CHILD_RESULT]]
  );
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
  assert.equal(changed[0]?.payload.title, "list hidden files");
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
  // Its part's answer said the child was still working: never the run's result.
  assert.deepEqual(taskRows(feed(run, [inBackground(completed)]).flat()), []);
});

// ---------------------------------------------------------------------------
// A run's result: the parent part that settles after the child's own idle
// ---------------------------------------------------------------------------

/** A parent `task` part frame turned into its `error` state, as the tool fails. */
function erroredPart(frame: OpenCodeRawEvent, error: string): OpenCodeRawEvent {
  const copy = JSON.parse(JSON.stringify(frame)) as {
    type: string;
    properties: { part: { state: Record<string, unknown> } };
  };
  const state = copy.properties.part.state;
  delete state.output;
  delete state.title;
  state.status = "error";
  state.error = error;
  return copy;
}

test("12 end to end: the child's roster row ends with its task part's output as its result", async () => {
  const { roster } = await throughHost(replayChildParent().events);
  const child = roster.find((row) => row.id === CHILD_SESSION_ID);
  assert.ok(child, `roster had ${JSON.stringify(roster.map((row) => row.id))}`);
  assert.equal(child.status, "completed");
  assert.equal(child.activationCount, 1);
  assert.equal(child.result, CHILD_RESULT);
  assert.equal(child.error, null);
});

test("a run gets its result once: the same part again adds nothing", () => {
  const run = replayChildParent();
  assert.deepEqual(taskRows(feed(run, childFixtureFrames([180])).flat()), []);
});

test("a resumed run's result is its own; a late part of the first call adds nothing", async () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume", {
    "The files in the current directory are:": "On a second look, the files are:"
  });
  const second = "On a second look, the files are:\n\n- README.md\n- a.ts";
  const perFrame = feed(run, [
    resume.pending,
    resume.running,
    ...resume.work,
    ...resume.settle,
    resume.completed
  ]);
  assert.deepEqual(
    eventsOfType(perFrame.at(-1) ?? [], "task.completed").map((event) => [
      event.payload.toolUseId,
      event.payload.summary
    ]),
    [["call_resume", second]]
  );
  const late = feed(run, childFixtureFrames([180])).flat();
  assert.deepEqual(taskRows(late), [], "the first run's part is stale");

  const { roster } = await throughHost([...run.events, ...perFrame.flat(), ...late]);
  const child = roster.find((row) => row.id === CHILD_SESSION_ID);
  assert.ok(child);
  assert.equal(child.status, "completed");
  assert.equal(child.activationCount, 2, "the resumed run");
  assert.equal(child.result, second);
});

test("a part that errors after the child's idle gives the run its error, ending nothing", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work, ...resume.settle]);
  const failure = `Subagent failed (task_id: ${CHILD_SESSION_ID}): the last tool call failed`;
  const ends = eventsOfType(
    feed(run, [erroredPart(resume.completed, failure)]).flat(),
    "task.completed"
  );
  // The run's end is the child's own; the parent's verdict rides it as text.
  assert.deepEqual(
    ends.map((event) => [event.payload.status, event.payload.summary, event.payload.toolUseId]),
    [["completed", failure, "call_resume"]]
  );
});

test("a result is the text inside the task tool's envelope; other output stands as it is", () => {
  const [completed] = childFixtureFrames([180]);
  const part = (completed?.properties as { part: { state: { output: string } } }).part;
  assert.equal(taskResultText(part.state.output), CHILD_RESULT);
  // 1.18.32's `TaskTool` may put a summary line before the result.
  assert.equal(
    taskResultText(
      [
        '<task id="ses_x" state="completed">',
        "<summary>Background task completed: list files</summary>",
        "<task_result>",
        "two lines\n</task_result> quoted inside",
        "</task_result>",
        "</task>"
      ].join("\n")
    ),
    "two lines\n</task_result> quoted inside"
  );
  assert.equal(taskResultText("plain words"), "plain words");
  const unclosed = '<task id="ses_x" state="completed">\nno result';
  assert.equal(taskResultText(unclosed), unclosed);
  assert.equal(taskResultText(undefined), undefined);
});

test("a part that settles BEFORE the child's idle ends the run itself, with its result", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  const ends = eventsOfType(
    feed(run, [
      resume.pending,
      resume.running,
      ...resume.work,
      resume.completed,
      ...resume.settle
    ]).flat(),
    "task.completed"
  );
  assert.deepEqual(
    ends.map((event) => [event.payload.status, event.payload.summary]),
    [["completed", CHILD_RESULT]],
    "one end, the part's, and the idle after it adds nothing"
  );
});

/** The child's own `session.error`, as fixture 13 shapes one. */
function childSessionError(childId: string, message: string): OpenCodeRawEvent {
  return {
    type: "session.error",
    properties: { sessionID: childId, error: { name: "UnknownError", data: { message } } }
  };
}

test("no result after a run the child's own session.error ended", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);
  const failed = feed(run, [childSessionError(CHILD_SESSION_ID, "Model not found: x")]).flat();
  assert.deepEqual(taskRows(failed), ["task.completed:failed"]);
  // Its error already fills the row; whatever the part then answers adds nothing.
  assert.deepEqual(taskRows(feed(run, [...resume.settle, resume.completed]).flat()), []);
});

/** A session's `busy`, as its runner says it at the top of a step. */
function busyOf(sessionId: string): OpenCodeRawEvent {
  return { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } };
}

/**
 * A launch's `task` part as 1.18.32's processor closes it when an abort cuts
 * the call: `error` "Tool execution aborted", `metadata.interrupted: true`
 * (fixtures README observation 29, read from the source).
 */
function abortedCall(frame: OpenCodeRawEvent): OpenCodeRawEvent {
  const copy = JSON.parse(JSON.stringify(frame)) as {
    type: string;
    properties: { part: { state: Record<string, unknown> } };
  };
  const state = copy.properties.part.state;
  state.status = "error";
  state.error = "Tool execution aborted";
  state.metadata = { ...(state.metadata as Record<string, unknown>), interrupted: true };
  return copy as unknown as OpenCodeRawEvent;
}

test("a child an abort cancels ends stopped, never failed, when its own abort error or its call's cleanup beats the adapter's close — a grandchild too", async () => {
  const live: RuntimeEvent = {
    eventId: "evt-live",
    threadId: "thread-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    providerRefs: { providerTurnId: "ses_parent" },
    type: "session.state.changed",
    payload: { state: "ready" }
  };

  // Its own `MessageAbortedError`.
  {
    const run = liveSession("ses_parent");
    const launched = feed(run, [
      ...childLaunch({ sessionId: "ses_parent", childId: "ses_child", callId: "call_child", description: "list files", background: false }),
      busyOf("ses_child")
    ]).flat();
    const ended = feed(run, [
      { type: "session.error", properties: { sessionID: "ses_child", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }
    ]).flat();
    assert.deepEqual(eventsOfType(ended, "task.completed").map((event) => event.payload.status), ["stopped"]);
    assert.deepEqual(closeLiveChildAgents(run.state, run.ctx, "interrupted"), [], "ended already");
    const { roster } = await throughHost([live, ...launched, ...ended]);
    assert.equal(roster.find((row) => row.id === "ses_child")?.status, "interrupted");
  }

  // Its launching call's cleanup — the child's in the parent's session, and a
  // grandchild's in the child's own.
  {
    const run = liveSession("ses_parent");
    const [created, running] = childLaunch({ sessionId: "ses_parent", childId: "ses_child", callId: "call_child", description: "list files", background: false });
    const [gcCreated, gcRunning] = childLaunch({ sessionId: "ses_child", childId: "ses_gc", callId: "call_gc", description: "dig deeper", background: false });
    assert.ok(created && running && gcCreated && gcRunning);
    const launched = feed(run, [created, running, busyOf("ses_child"), gcCreated, gcRunning, busyOf("ses_gc")]).flat();
    assert.deepEqual(eventsOfType(launched, "task.started").map((event) => event.payload.taskId), ["ses_child", "ses_gc"]);
    const ended = feed(run, [abortedCall(gcRunning), abortedCall(running)]).flat();
    assert.deepEqual(
      eventsOfType(ended, "task.completed").map((event) => [event.payload.taskId, event.payload.status, event.payload.summary]),
      [
        ["ses_gc", "stopped", "Tool execution aborted"],
        ["ses_child", "stopped", "Tool execution aborted"]
      ]
    );
    const { roster } = await throughHost([live, ...launched, ...ended]);
    assert.deepEqual(
      ["ses_child", "ses_gc"].map((id) => roster.find((row) => row.id === id)?.status),
      ["interrupted", "interrupted"]
    );
    // The cleanup is the parent's word on its call, not the child's on its
    // run — a job the abort did not reach runs on: a report that it runs is
    // judged, as after the adapter's own close.
    const reported = normalizeOpenCodeEvent(run.state, busyOf("ses_child"), run.ctx).signals;
    assert.deepEqual(reported.map((signal) => signal.kind), ["child-reports-run"]);
  }

  // A call that fails on its own — no abort's mark — still fails the run, on
  // the provider's word: nothing for a later report to undo.
  {
    const run = liveSession("ses_parent");
    const [created, running] = childLaunch({ sessionId: "ses_parent", childId: "ses_child", callId: "call_child", description: "list files", background: false });
    assert.ok(created && running);
    feed(run, [created, running, busyOf("ses_child")]);
    const ended = feed(run, [erroredPart(running, "the subagent crashed")]).flat();
    assert.deepEqual(
      eventsOfType(ended, "task.completed").map((event) => [event.payload.status, event.payload.summary]),
      [["failed", "the subagent crashed"]]
    );
    assert.deepEqual(normalizeOpenCodeEvent(run.state, busyOf("ses_child"), run.ctx).signals, []);
  }
});

test("no result after a run the host stopped", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  feed(run, [resume.pending, resume.running, ...resume.work]);
  assert.deepEqual(taskRows(closeLiveChildAgents(run.state, run.ctx, "interrupted")), [
    "task.completed:stopped"
  ]);
  assert.deepEqual(taskRows(feed(run, [...resume.settle, resume.completed]).flat()), []);
});

// ---------------------------------------------------------------------------
// A background run's answer arrives in the parent (fixtures README obs. 27)
// ---------------------------------------------------------------------------

/** Fixture 12's child and its launching call, renamed for a run in the background. */
const BACKGROUND_RENAMES = {
  [CHILD_SESSION_ID]: "ses_background_child",
  [CHILD_LAUNCH_CALL]: "call_background",
  prt_0c202c25e001GFB7AW0OKeLoLz: "prt_background",
  msg_0c202b215001elzGd6pT1U41EE: "msg_background"
};

/**
 * A `task` call run in the background: its part runs and completes at once
 * (fixture 12, lines 140-142 and 180, with `inBackground`), and the child
 * works on after it.
 */
function launchInBackground(run: Replay): RuntimeEvent[] {
  const [pending, created, running, completed] = childFixtureFrames(
    [140, 141, 142, 180],
    BACKGROUND_RENAMES
  );
  assert.ok(pending && created && running && completed);
  return feed(run, [pending, created, inBackground(running), inBackground(completed)]).flat();
}

/**
 * 1.18.32's `TaskTool.injectBackgroundResult` (read from the source, not
 * captured): a background run's answer reaches the PARENT as a new prompt — a
 * user message whose one text part is `synthetic` and wraps the answer in the
 * tool's envelope, naming the child. Cloned from fixture 12's own prompt
 * (lines 122-123) under new ids.
 */
function injectedResult(
  childId: string,
  answer: string,
  options: { state?: string; description?: string; messageId?: string } = {}
): OpenCodeRawEvent[] {
  const messageId = options.messageId ?? "msg_injected";
  const [message, part] = childFixtureFrames([122, 123], {
    msg_01a0c202b1b56tqi5gdjmgr8y9: messageId,
    prt_0c202b1d8001Ef7fckL6t7C4aG: `prt_${messageId}`
  });
  assert.ok(message && part);
  const copy = JSON.parse(JSON.stringify(part)) as {
    type: string;
    properties: { part: Record<string, unknown> };
  };
  const state = options.state ?? "completed";
  const tag = state === "error" ? "task_error" : "task_result";
  const outcome = state === "error" ? "failed" : "completed";
  copy.properties.part.synthetic = true;
  copy.properties.part.text = [
    `<task id="${childId}" state="${state}">`,
    `<summary>Background task ${outcome}: ${options.description ?? "list files"}</summary>`,
    `<${tag}>`,
    answer,
    `</${tag}>`,
    "</task>"
  ].join("\n");
  return [message, copy];
}

test("a background run's answer, injected into the parent, becomes its result, once", async () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  const launch = launchInBackground(run);
  run.state.activeTurnId = undefined;
  const idle = feed(run, childFixtureFrames([179], BACKGROUND_RENAMES)).flat();
  assert.deepEqual(
    eventsOfType(idle, "task.completed").map((event) => event.payload.summary),
    [undefined],
    "the child's own idle ends the run with no answer yet"
  );

  const injected = injectedResult("ses_background_child", "Found README.md and a.ts.");
  const result = feed(run, injected).flat();
  assert.deepEqual(
    eventsOfType(result, "task.completed").map((event) => [
      event.payload.status,
      event.payload.summary,
      event.payload.toolUseId,
      event.payload.taskId
    ]),
    [["completed", "Found README.md and a.ts.", "call_background", "ses_background_child"]]
  );
  assert.deepEqual(
    result.filter((event) => event.type !== "task.completed"),
    [],
    "the injected prompt is no message of the user's, nor the agent's"
  );
  assert.deepEqual(taskRows(feed(run, injected).flat()), [], "once");

  const { roster } = await throughHost([...run.events, ...launch, ...idle, ...result]);
  const child = roster.find((row) => row.id === "ses_background_child");
  assert.equal(child?.status, "completed");
  assert.equal(child?.result, "Found README.md and a.ts.");
});

test("a background run's answer injected while a Stop's leftovers are still dropped is its result all the same", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  launchInBackground(run);
  run.state.activeTurnId = undefined;
  feed(run, childFixtureFrames([179], BACKGROUND_RENAMES));
  // A Stop whose leftovers still linger: the parent's own output is dropped,
  // but a user message's part is none of it.
  run.state.interruptedTurnId = "turn-stopped";
  run.state.reconcileIdleStatus = true;
  const result = feed(run, injectedResult("ses_background_child", "Found it.")).flat();
  assert.deepEqual(
    eventsOfType(result, "task.completed").map((event) => [event.payload.taskId, event.payload.summary]),
    [["ses_background_child", "Found it."]]
  );
});

test("a child relaunched on the server's word still takes its own call's answer: the parent's part ends the reopened run, naming its new launch", () => {
  const run = liveSession("ses_parent");
  feed(run, childLaunch({ sessionId: "ses_parent", childId: "ses_fg", callId: "call_fg", description: "read the code", background: false }));
  closeLiveChildAgents(run.state, run.ctx, "interrupted");
  const reported = normalizeOpenCodeEvent(
    run.state,
    { type: "session.status", properties: { sessionID: "ses_fg", status: { type: "busy" } } },
    run.ctx
  ).signals.find((signal) => signal.kind === "child-reports-run");
  assert.ok(reported !== undefined && reported.kind === "child-reports-run");
  const relaunched = settleChildSurvival(run.state, "ses_fg", reported.checkId, true, run.ctx);
  assert.deepEqual(
    eventsOfType(relaunched, "task.started").map((event) => event.payload.toolUseId),
    ["opencode-revive:call_fg:1"]
  );
  // Its answer rides the call it was launched by, which the provider still names.
  const answered = feed(run, [
    {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          id: "prt_call_fg",
          messageID: "msg_launch_call_fg",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          callID: "call_fg",
          state: {
            status: "completed",
            title: "read the code",
            input: { subagent_type: "explore", description: "read the code", prompt: "read the code" },
            metadata: { parentSessionId: "ses_parent", sessionId: "ses_fg" },
            output: '<task id="ses_fg" state="completed">\n<task_result>\nIt is fine.\n</task_result>\n</task>',
            time: { start: 1, end: 2 }
          }
        }
      }
    }
  ]).flat();
  assert.deepEqual(
    eventsOfType(answered, "task.completed").map((event) => [event.payload.status, event.payload.summary, event.payload.toolUseId]),
    [["completed", "It is fine.", "opencode-revive:call_fg:1"]]
  );
});

test("after an adapter relaunch, a provider relaunch names its own new call", () => {
  const run = liveSession("ses_parent");
  feed(run, childLaunch({ sessionId: "ses_parent", childId: "ses_bg", callId: "call_bg", description: "list files", background: true }));
  closeLiveChildAgents(run.state, run.ctx, "interrupted");
  const reported = normalizeOpenCodeEvent(
    run.state,
    { type: "session.status", properties: { sessionID: "ses_bg", status: { type: "busy" } } },
    run.ctx
  ).signals.find((signal) => signal.kind === "child-reports-run");
  assert.ok(reported !== undefined && reported.kind === "child-reports-run");
  settleChildSurvival(run.state, "ses_bg", reported.checkId, true, run.ctx);
  // The relaunched run ends by its own idle; then the model resumes the child
  // with `task_id`, under a call of its own.
  feed(run, [
    { type: "session.status", properties: { sessionID: "ses_bg", status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: "ses_bg" } }
  ]);
  const resumed = feed(run, childLaunch({ sessionId: "ses_parent", childId: "ses_bg", callId: "call_resume", description: "list files", background: true }).slice(1)).flat();
  assert.deepEqual(
    eventsOfType(resumed, "task.started").map((event) => event.payload.toolUseId),
    ["call_resume"],
    "its own call: a changed id the roster reopens for, not the adapter's last relaunch id"
  );
});

test("a child no task part names still starts under a launch id of its own: `opencode-child:<session>`", () => {
  const run = liveSession("ses_parent");
  // Its `session.created`, then its own frames — the part that launched it
  // never reached this stream (a gap, or a launch inside a session this
  // thread does not read).
  const started = feed(run, [
    { type: "session.created", properties: { sessionID: "ses_orphan", info: { id: "ses_orphan", parentID: "ses_parent", title: "digging" } } },
    { type: "session.status", properties: { sessionID: "ses_orphan", status: { type: "busy" } } }
  ]).flat();
  assert.deepEqual(
    eventsOfType(started, "task.started").map((event) => event.payload.toolUseId),
    ["opencode-child:ses_orphan"],
    "every agent's FIRST start names a launch: the relaunch contract"
  );
});

test("a child whose own frames beat its launching part names the provider's call on every row once the part is read, and a relaunch still reopens it", async () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  // Fixture 12's launch in the background, its `running` frame lost in a
  // reconnect gap: the child's `session.created`, then its own `busy` — no
  // part has named it yet — then the part's `completed` frame, which does.
  const [pending, created, completed] = childFixtureFrames([140, 141, 180], BACKGROUND_RENAMES);
  assert.ok(pending && created && completed);
  const before = feed(run, [pending, created, ...childFixtureFrames([148], BACKGROUND_RENAMES)]).flat();
  assert.deepEqual(
    eventsOfType(before, "task.started").map((event) => event.payload.toolUseId),
    ["opencode-child:ses_background_child"],
    "its first start names a launch of its own"
  );
  const named = feed(run, [inBackground(completed)]).flat();
  assert.deepEqual(taskRows(named), [], "a call answered in the background ends nothing");
  // Its work, its idle, and its answer, injected into the parent.
  const after = [
    ...feed(run, childFixtureFrames([156, 157, 158, 159, 160], BACKGROUND_RENAMES)).flat(),
    ...feed(run, childFixtureFrames([177, 178, 179], BACKGROUND_RENAMES)).flat(),
    ...feed(run, injectedResult("ses_background_child", "Found README.md.")).flat()
  ];
  const rows = after.filter((event) => event.type.startsWith("task."));
  assert.ok(rows.length > 0);
  assert.deepEqual(
    [...new Set(rows.map((event) => (event.payload as { toolUseId?: string }).toolUseId))],
    ["call_background"],
    "once the call is known, every row names it: the timeline hides the launching call behind the agent"
  );

  // The start's own launch is what a relaunch changes: a Stop closes the run,
  // and the server's word that it runs reopens it under a new launch id.
  const live: RuntimeEvent = {
    eventId: "evt-live",
    threadId: "thread-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    providerRefs: { providerTurnId: "ses_parent" },
    type: "session.state.changed",
    payload: { state: "ready" }
  };
  const relaunchRun = replayChildParent();
  relaunchRun.state.activeTurnId = "turn-background";
  const launched = feed(relaunchRun, [pending, created, ...childFixtureFrames([148], BACKGROUND_RENAMES), inBackground(completed)]).flat();
  const stopped = closeLiveChildAgents(relaunchRun.state, relaunchRun.ctx, "interrupted");
  const reported = normalizeOpenCodeEvent(
    relaunchRun.state,
    childFixtureFrames([148], BACKGROUND_RENAMES)[0]!,
    relaunchRun.ctx
  ).signals.find((signal) => signal.kind === "child-reports-run");
  assert.ok(reported !== undefined && reported.kind === "child-reports-run");
  const relaunched = settleChildSurvival(relaunchRun.state, "ses_background_child", reported.checkId, true, relaunchRun.ctx);
  assert.deepEqual(
    eventsOfType(relaunched, "task.started").map((event) => event.payload.toolUseId),
    ["opencode-revive:call_background:1"]
  );
  const { roster } = await throughHost([live, ...launched, ...stopped, ...relaunched]);
  assert.equal(roster.find((row) => row.id === "ses_background_child")?.status, "running", "reopened");
});

/** Fixture 12's parent session, fresh: no frame of the capture replayed yet. */
function freshChildParent(): Pick<Replay, "state" | "ctx"> {
  const parent = sessionIds(readFixture(CHILD_FIXTURE))[2];
  assert.ok(parent !== undefined);
  return liveSession(parent);
}

/** A `task` part frame whose call names `childId` as the task to resume (`task_id`). */
function resumingTask(frame: OpenCodeRawEvent, childId: string): OpenCodeRawEvent {
  const copy = JSON.parse(JSON.stringify(frame)) as {
    type: string;
    properties: { part: { state: { input?: Record<string, unknown> } } };
  };
  copy.properties.part.state.input = { ...(copy.properties.part.state.input ?? {}), task_id: childId };
  return copy as unknown as OpenCodeRawEvent;
}

test("a child no part ever named, resumed by a `task_id` call once settled, is relaunched: a start naming the call, running, then completed with its answer", async () => {
  const run = freshChildParent();
  // Fixture 12's child with its launching part never read: its own frames
  // start it under its own launch id, and its idle settles it.
  const [created] = childFixtureFrames([141]);
  assert.ok(created);
  const first = feed(run, [created, ...childFixtureFrames([148, 177, 178, 179])]).flat();
  assert.deepEqual(taskRows(first), ["task.started", "task.updated:running", "task.updated:idle", "task.completed:completed"]);
  assert.deepEqual(
    eventsOfType(first, "task.started").map((event) => event.payload.toolUseId),
    [`opencode-child:${CHILD_SESSION_ID}`]
  );

  // A `task` call resuming it (`task_id`): a new run, which the roster reopens for.
  const resume = resumeFrames("call_resume");
  const relaunch = feed(run, [resume.pending, resumingTask(resume.running, CHILD_SESSION_ID)]).flat();
  assert.deepEqual(
    eventsOfType(relaunch, "task.started").map((event) => event.payload.toolUseId),
    ["call_resume"],
    "a relaunch, not the first launch's late part"
  );
  const rest = feed(run, [...resume.work, ...resume.settle, resume.completed]).flat();
  const live: RuntimeEvent = {
    eventId: "evt-live",
    threadId: "thread-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    providerRefs: { providerTurnId: "ses_parent" },
    type: "session.state.changed",
    payload: { state: "ready" }
  };
  const { roster: whileRunning } = await throughHost([live, ...first, ...relaunch]);
  const reopened = whileRunning.find((row) => row.id === CHILD_SESSION_ID);
  assert.deepEqual([reopened?.status, reopened?.activationCount], ["running", 2], "reopened");
  const { roster: afterEnd } = await throughHost([live, ...first, ...relaunch, ...rest]);
  const ended = afterEnd.find((row) => row.id === CHILD_SESSION_ID);
  assert.deepEqual([ended?.status, ended?.result], ["completed", CHILD_RESULT]);
});

test("a `task_id` call on a child no part named is no launch of its run: while it works, and never adopted as its call", () => {
  const run = freshChildParent();
  const [created] = childFixtureFrames([141]);
  assert.ok(created);
  feed(run, [created, ...childFixtureFrames([148])]);
  // A call handed to the working child: no start, and its rows never name it.
  const resume = resumeFrames("call_handed_over");
  const handed = feed(run, [resume.pending, resumingTask(resume.running, CHILD_SESSION_ID)]).flat();
  assert.deepEqual(eventsOfType(handed, "task.started"), []);
  const later = feed(run, [...resume.work, ...childFixtureFrames([177, 178, 179])]).flat();
  assert.ok(later.some((event) => event.type === "task.completed"));
  assert.deepEqual(
    later
      .filter((event) => event.type.startsWith("task."))
      .filter((event) => (event.payload as { toolUseId?: string }).toolUseId === "call_handed_over"),
    [],
    "the call is not the run's launch"
  );
});

test("a revival whose run started with no launch id seeds one first, so the roster reopens: running, then completed — the defensive branch", async () => {
  const run = liveSession("ses_parent");
  // A record no start this adapter writes leaves — every one names a launch —
  // built by hand: a grandchild's start with none, in the log and in the
  // adapter's own record of it. Unreachable today (the host's first load
  // names an older log's runs, `legacyLaunchStarts`); pinned all the same.
  run.state.relatedSessionIds.add("ses_gc");
  run.state.childAgents.set("ses_gc", {
    sessionId: "ses_gc",
    parentSessionId: "ses_bg",
    parentAgentId: "ses_bg",
    description: "dig deeper",
    started: true,
    completed: false
  });
  const olderStart: RuntimeEvent = {
    eventId: "evt-older-start",
    threadId: "thread-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    agentId: "ses_gc",
    providerRefs: { providerTurnId: "ses_gc" },
    type: "task.started",
    payload: { taskId: "ses_gc", taskType: "subagent", agentId: "ses_gc", parentAgentId: "ses_bg", description: "dig deeper" }
  };
  const stopped = closeLiveChildAgents(run.state, run.ctx, "interrupted");
  const reported = normalizeOpenCodeEvent(
    run.state,
    { type: "session.status", properties: { sessionID: "ses_gc", status: { type: "busy" } } },
    run.ctx
  ).signals.find((signal) => signal.kind === "child-reports-run");
  assert.ok(reported !== undefined && reported.kind === "child-reports-run");
  const relaunched = settleChildSurvival(run.state, "ses_gc", reported.checkId, true, run.ctx);
  assert.deepEqual(
    eventsOfType(relaunched, "task.started").map((event) => event.payload.toolUseId),
    ["opencode-child:ses_gc", "opencode-revive:ses_gc:1"],
    "a seed naming the first run's launch — a late delivery — then the relaunch"
  );
  const ended = feed(run, [
    { type: "session.status", properties: { sessionID: "ses_gc", status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: "ses_gc" } }
  ]).flat();

  // A live session: the roster reads no run of a dead one as running.
  const live: RuntimeEvent = {
    eventId: "evt-live",
    threadId: "thread-1",
    createdAt: "2026-09-21T00:00:00.000Z",
    providerRefs: { providerTurnId: "ses_parent" },
    type: "session.state.changed",
    payload: { state: "ready" }
  };
  const { roster: whileRunning } = await throughHost([live, olderStart, ...stopped, ...relaunched]);
  assert.equal(whileRunning.find((row) => row.id === "ses_gc")?.status, "running", "reopened");
  const { roster: afterEnd } = await throughHost([live, olderStart, ...stopped, ...relaunched, ...ended]);
  assert.equal(afterEnd.find((row) => row.id === "ses_gc")?.status, "completed");
});

test("a background answer that arrives before the child's idle rides the run's own end", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  launchInBackground(run);
  const early = feed(run, injectedResult("ses_background_child", "Found it.")).flat();
  assert.deepEqual(taskRows(early), []);
  const idle = feed(run, childFixtureFrames([179], BACKGROUND_RENAMES)).flat();
  assert.deepEqual(
    eventsOfType(idle, "task.completed").map((event) => [
      event.payload.status,
      event.payload.summary
    ]),
    [["completed", "Found it."]]
  );
});

test("an injected envelope naming no child of this thread, or not synthetic, is no result", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  launchInBackground(run);
  feed(run, childFixtureFrames([179], BACKGROUND_RENAMES));
  assert.deepEqual(taskRows(feed(run, injectedResult("ses_somebody_else", "x")).flat()), []);
  const typed = injectedResult("ses_background_child", "typed by hand");
  const [message, part] = typed;
  assert.ok(message && part);
  const unmarked = JSON.parse(JSON.stringify(part)) as {
    type: string;
    properties: { part: Record<string, unknown> };
  };
  delete unmarked.properties.part.synthetic;
  assert.deepEqual(taskRows(feed(run, [message, unmarked]).flat()), []);
});

test("a previous background run's late answer never becomes a relaunched run's result", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  launchInBackground(run);
  run.state.activeTurnId = undefined;
  feed(run, childFixtureFrames([179], BACKGROUND_RENAMES));
  // A FOREGROUND relaunch of the child, and the first run's answer after it.
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume", { [CHILD_SESSION_ID]: "ses_background_child" });
  const events = feed(run, [
    resume.pending,
    resume.running,
    ...injectedResult("ses_background_child", "RUN 1 ANSWER"),
    ...resume.work,
    ...resume.settle,
    resume.completed
  ]).flat();
  assert.deepEqual(
    eventsOfType(events, "task.completed").map((event) => [
      event.payload.toolUseId,
      event.payload.summary
    ]),
    [
      ["call_resume", undefined],
      ["call_resume", CHILD_RESULT]
    ],
    "the relaunched run ends by its own idle and takes its own part's answer"
  );
});

test("a background run takes no answer written for another run's task", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  launchInBackground(run);
  run.state.activeTurnId = undefined;
  feed(run, childFixtureFrames([179], BACKGROUND_RENAMES));
  // Relaunched in the background too, under another description.
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume", {
    [CHILD_SESSION_ID]: "ses_background_child",
    "list files": "list hidden files"
  });
  const events = feed(run, [
    resume.pending,
    inBackground(resume.running),
    inBackground(resume.completed),
    ...injectedResult("ses_background_child", "RUN 1 ANSWER"),
    ...resume.work,
    ...resume.settle,
    ...injectedResult("ses_background_child", "RUN 2 ANSWER", {
      description: "list hidden files"
    })
  ]).flat();
  assert.deepEqual(
    eventsOfType(events, "task.completed").map((event) => [
      event.payload.toolUseId,
      event.payload.summary
    ]),
    [
      ["call_resume", undefined],
      ["call_resume", "RUN 2 ANSWER"]
    ]
  );
});

// ---------------------------------------------------------------------------
// A background answer wakes the parent: its reply is a turn (obs. 27)
// ---------------------------------------------------------------------------

/** Fixture 12's session C — the one with a child — whose own reply the frames below clone. */
const CHILD_PARENT_ID = "ses_f3dfd4e50ffe7r6H3Rf8jBDXUl";

/**
 * The parent's reply to a prompt the server wrote itself. 1.18.32's
 * `injectBackgroundResult` prompts the calling session through
 * `SessionPrompt.prompt`, the path `prompt_async` takes (read from the
 * source, not captured): the prompt's user message, then the run — `busy`,
 * the reply's assistant message naming the prompt as its parent, its parts,
 * its completion — then `busy` → `idle` → `session.idle`. So the frames are
 * fixture 12's own reply to its prompt (lines 186-187, 197-202) answering
 * `promptId` under new ids, its completion (202 with `time.completed`), and
 * the settle (177-179, the child's, as the parent's).
 */
function wokenReplyFrames(
  promptId: string,
  replyId: string
): { begins: OpenCodeRawEvent[]; streams: OpenCodeRawEvent[]; ends: OpenCodeRawEvent[]; settle: OpenCodeRawEvent[] } {
  const renames = {
    msg_0c202cdef001WhUEivs8Y0ozoo: replyId,
    msg_01a0c202b1b56tqi5gdjmgr8y9: promptId,
    prt_0c202d300001iPUUe8kF98xzzI: `prt_start_${replyId}`,
    prt_0c202d308001SGe0qwNz3du3Ri: `prt_text_${replyId}`,
    prt_0c202d3d20012r6QX7WcsIYfVJ: `prt_step_${replyId}`
  };
  const [busy, begins, start, open, delta, close, step, stopped] = childFixtureFrames(
    [186, 187, 197, 198, 199, 200, 201, 202],
    renames
  );
  assert.ok(busy && begins && start && open && delta && close && step && stopped);
  const completed = JSON.parse(JSON.stringify(stopped)) as {
    type: string;
    properties: { info: { time: Record<string, unknown> } };
  };
  completed.properties.info.time.completed = 1789961359000;
  return {
    begins: [busy, begins],
    streams: [start, open, delta],
    ends: [close, step, stopped, completed],
    settle: [
      busy,
      ...childFixtureFrames([178, 179], { [CHILD_SESSION_ID]: CHILD_PARENT_ID })
    ]
  };
}

/**
 * Fixture 12's parent at rest after a background launch, its child settled:
 * what a wake finds. The capture ends mid-run (line 202), so the parent's own
 * run is settled here too — `busy` → `idle` → `session.idle`, lines 177-179 as
 * the parent's.
 */
function parentAtRest(): Replay {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  launchInBackground(run);
  run.state.activeTurnId = undefined;
  run.state.turnTokenUsage = undefined;
  feed(run, childFixtureFrames([179], BACKGROUND_RENAMES));
  feed(run, childFixtureFrames([177, 178, 179], { [CHILD_SESSION_ID]: CHILD_PARENT_ID }));
  return run;
}

test("a background answer wakes the parent: its reply opens a turn named by the injected prompt, and every row rides it", () => {
  const run = parentAtRest();
  const prompt = feed(run, injectedResult("ses_background_child", "Found README.md and a.ts.")).flat();
  assert.deepEqual(eventsOfType(prompt, "turn.started"), [], "a prompt alone is no reply: nothing opens yet");
  // The child's end came first (1.18.32's runner publishes its idle before the
  // job completes), and the result its answer carries lands before the reply
  // opens the turn: neither rides it, so a rewind of it takes neither.
  assert.deepEqual(
    eventsOfType(prompt, "task.completed").map((event) => [event.payload.summary, event.turnId]),
    [["Found README.md and a.ts.", undefined]]
  );

  const reply = wokenReplyFrames("msg_injected", "msg_woken");
  const [busy, begins] = reply.begins.map((frame) => normalizeOpenCodeEvent(run.state, frame, run.ctx));
  assert.deepEqual(busy?.events, [], "the run's busy comes first, before any reply exists");
  assert.equal(begins?.events[0]?.type, "turn.started", "the reply's first frame opens the turn, before any row of it");
  assert.equal(begins?.events[0]?.turnId, "msg_injected", "named by the prompt it answers, as a live turn is");
  assert.deepEqual(begins?.signals, [{ kind: "turn-woken", turnId: "msg_injected" }]);
  assert.equal(run.state.activeTurnId, "msg_injected");

  const rows = feed(run, [...reply.streams, ...reply.ends]).flat();
  assert.ok(rows.length > 0);
  for (const event of rows) {
    assert.equal(event.turnId, "msg_injected", `${event.type} rides the woken turn`);
  }
  assert.deepEqual(
    eventsOfType(rows, "content.delta").map((event) => event.payload.delta).join(""),
    "The files in this directory are README.md and a.ts."
  );
  assert.equal(eventsOfType(rows, "thread.token-usage.updated").length, 1, "its step is the turn's own");
  assert.equal(eventsOfType([...rows], "turn.started").length, 0, "one turn, however many frames");

  // The run's settle is the session's to act on, as for any turn.
  const settle = reply.settle.flatMap((frame) => normalizeOpenCodeEvent(run.state, frame, run.ctx).signals);
  assert.deepEqual(
    settle.map((signal) => signal.kind),
    ["status-busy", "status-idle", "session-idle"]
  );
});

test("a reply the host asked for, a compaction's summary, or a message that already ended opens no turn", () => {
  // Fixture 12's own prompt was the host's: a new reply to it, while nothing runs, is a late one.
  const hosts = parentAtRest();
  const late = wokenReplyFrames("msg_01a0c202b1b56tqi5gdjmgr8y9", "msg_late");
  assert.deepEqual(eventsOfType(feed(hosts, late.begins).flat(), "turn.started"), []);
  assert.equal(hosts.state.activeTurnId, undefined);

  // A message that already ended — a fork copies a session's messages whole,
  // completed ones included (fixture 10, lines at t=9362) — is no reply beginning.
  const copied = parentAtRest();
  const done = wokenReplyFrames("msg_copied_prompt", "msg_copied").ends.at(-1);
  assert.ok(done !== undefined);
  assert.deepEqual(eventsOfType(feed(copied, [done]).flat(), "turn.started"), []);

  // The host's own `/compact` (fixture 09): `compact()` holds `hostCompacting`
  // up while its `summarize` runs, and the summary opens nothing — its run
  // `busy` and all.
  const compacting = parentAtRest();
  compacting.state.hostCompacting = true;
  const summary = compactionSummary({
    sessionId: CHILD_PARENT_ID,
    promptId: "msg_compaction",
    replyId: "msg_summary",
    text: "## Objective"
  });
  const own = feed(compacting, [
    ...compactionPrompt({ sessionId: CHILD_PARENT_ID, promptId: "msg_compaction", auto: false }),
    ...summary.begins,
    ...summary.streams,
    ...summary.ends
  ]).flat();
  assert.deepEqual(eventsOfType(own, "turn.started"), []);
  assert.equal(compacting.state.activeTurnId, undefined);
});

test("a woken run that compacts first runs as one turn from its summary on, the summary off the meter", () => {
  const run = parentAtRest();
  const sessionId = CHILD_PARENT_ID;
  feed(run, injectedResult("ses_background_child", "Found README.md and a.ts."));
  // 1.18.32's `SessionPrompt.run` (read from the source): the run's first
  // iteration finds the last answer's context over the model's limit and
  // writes an automatic compaction's prompt; the next summarises; the one
  // after answers the prompt the compaction writes to go on with.
  const busy: OpenCodeRawEvent = { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } };
  const summary = compactionSummary({ sessionId, promptId: "msg_compaction", replyId: "msg_summary", text: "## Goal" });
  const reply = wokenReply({ sessionId, promptId: "msg_continue", replyId: "msg_reply", text: "Done." });
  const before = feed(run, [busy, ...compactionPrompt({ sessionId, promptId: "msg_compaction", auto: true })]).flat();
  assert.deepEqual(before, [], "a compaction's prompt is no reply: nothing opens yet");

  const perFrame = feed(run, [
    ...summary.begins,
    ...summary.streams,
    ...summary.ends,
    ...compactionContinues({ sessionId, promptId: "msg_continue" }),
    ...reply.begins,
    ...reply.streams,
    ...reply.ends
  ]);
  const events = perFrame.flat();
  assert.deepEqual(
    eventsOfType(events, "turn.started").map((event) => event.turnId),
    ["msg_compaction"],
    "the summary opens the turn — the thread reads working through the compaction — named by the prompt it answers"
  );
  assert.equal(perFrame[1]?.[0]?.type, "turn.started", "on the summary's first frame, before any row of it");
  for (const event of events) {
    assert.equal(event.turnId, "msg_compaction", `${event.type} rides the woken turn`);
  }
  assert.ok(events.some((event) => event.type === "thread.state.changed"), "the compaction lands on it too");
  // The summary call answers no prompt of the conversation, so its step stays
  // off the meter, as inside a turn the host started; the reply's counts.
  assert.equal(eventsOfType(events, "thread.token-usage.updated").length, 1, "only the reply's step moves the meter");
  assert.equal(run.state.turnTokenUsage?.promptMessageIds.has("msg_compaction"), false);
  assert.equal(run.state.turnTokenUsage?.promptMessageIds.has("msg_continue"), true);
  assert.equal(run.state.claimedPromptIds.has("msg_compaction"), true);
});

test("a reply with no `busy` since the parent's last idle — no run behind it — opens no turn", () => {
  const run = parentAtRest();
  feed(run, injectedResult("ses_background_child", "Found README.md and a.ts."));
  const reply = wokenReplyFrames("msg_injected", "msg_woken");
  const [busy, begins] = reply.begins;
  assert.ok(busy && begins);
  // The assistant frame alone: every loop iteration of 1.18.32's
  // `SessionPrompt.run` sets `busy` before it writes the reply, so a reply
  // with none before it has no run to end it — a turn opened on it would
  // never settle, and hold a deploy's drain until the user acted.
  const lone = feed(run, [begins, ...reply.streams]).flat();
  assert.deepEqual(eventsOfType(lone, "turn.started"), []);
  assert.equal(run.state.activeTurnId, undefined);

  // The run's own `busy`, then its next reply: that one opens the turn.
  const next = wokenReplyFrames("msg_injected", "msg_woken_2");
  const opened = feed(run, next.begins).flat();
  assert.deepEqual(eventsOfType(opened, "turn.started").map((event) => event.turnId), ["msg_injected"]);

  // A run that ended (`idle`) is no evidence for the next reply.
  const ended = parentAtRest();
  feed(ended, [
    ...injectedResult("ses_background_child", "Found it."),
    busy,
    ...childFixtureFrames([178, 179], { [CHILD_SESSION_ID]: CHILD_PARENT_ID })
  ]);
  assert.deepEqual(eventsOfType(feed(ended, [begins]).flat(), "turn.started"), []);
});

test("no capture opens a turn of its own: every reply in them answers a prompt the host sent, or is a compaction", () => {
  for (const name of fixtureNames()) {
    for (const sessionId of sessionIds(readFixture(name))) {
      const { events, signals } = replay(name, { sessionId });
      assert.deepEqual(eventsOfType(events, "turn.started"), [], `${name} as ${sessionId}`);
      assert.ok(!signals.some((signal) => signal.kind === "turn-woken"), `${name} as ${sessionId}`);
    }
  }
});

test("while a turn runs, a reply to a prompt the server wrote belongs to it, and its steps count as the turn's", () => {
  const run = parentAtRest();
  run.state.activeTurnId = "turn-host";
  run.state.turnTokenUsage = makeTurnTokenUsageAccumulator();
  run.state.turnTokenUsage.promptMessageIds.add("msg_host_prompt");
  const reply = wokenReplyFrames("msg_injected", "msg_woken");
  const events = feed(run, [
    ...injectedResult("ses_background_child", "Found it."),
    ...reply.begins,
    ...reply.streams,
    ...reply.ends
  ]).flat();
  assert.deepEqual(eventsOfType(events, "turn.started"), []);
  for (const event of events.filter((candidate) => !candidate.type.startsWith("task."))) {
    assert.equal(event.turnId, "turn-host", `${event.type} rides the running turn`);
  }
  assert.equal(eventsOfType(events, "thread.token-usage.updated").length, 1, "the reply's step counts");
  assert.equal(run.state.activeTurnId, "turn-host");
});

test("a second answer that arrives while the woken reply runs joins its turn", () => {
  const run = parentAtRest();
  const first = wokenReplyFrames("msg_injected", "msg_woken");
  const second = wokenReplyFrames("msg_injected_2", "msg_woken_2");
  const events = feed(run, [
    ...injectedResult("ses_background_child", "Found it."),
    ...first.begins,
    ...first.streams,
    ...injectedResult("ses_background_child", "And more.", { messageId: "msg_injected_2" }),
    ...first.ends,
    ...second.begins,
    ...second.streams,
    ...second.ends
  ]).flat();
  assert.deepEqual(
    eventsOfType(events, "turn.started").map((event) => event.turnId),
    ["msg_injected"],
    "the server answers the second prompt in the same run: one turn"
  );
  const rows = events.filter((event) => !event.type.startsWith("task.") && event.type !== "turn.started");
  for (const event of rows) {
    assert.equal(event.turnId, "msg_injected", `${event.type} rides the woken turn`);
  }
  assert.equal(eventsOfType(events, "thread.token-usage.updated").length, 2, "both replies' steps count");
});

test("output that follows an interruption opens nothing, a woken reply's included", () => {
  const run = parentAtRest();
  run.state.interruptedTurnId = "turn-stopped";
  run.state.reconcileIdleStatus = true;
  const reply = wokenReplyFrames("msg_injected", "msg_woken");
  const events = feed(run, [...reply.begins, ...reply.streams, ...reply.ends]).flat();
  assert.deepEqual(events, []);
  assert.equal(run.state.activeTurnId, undefined);
});

test("a request after an interruption waits for the server's word on its asker: no card, one signal; a repeat adds nothing, an answer meanwhile no row", () => {
  const run = liveSession("ses_parent");
  run.state.activeTurnId = undefined;
  run.state.interruptedTurnId = "turn-stopped";
  run.state.reconcileIdleStatus = true;
  const asks: OpenCodeRawEvent[] = [
    {
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_parent", permission: "bash", patterns: ["ls"] }
    },
    {
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_parent", questions: [{ question: "Which?", header: "Which", options: [] }] }
    }
  ];
  for (const ask of asks) {
    const first = normalizeOpenCodeEvent(run.state, ask, run.ctx);
    assert.deepEqual(first.events, [], `${ask.type}: nothing is shown`);
    assert.deepEqual(first.signals.map((signal) => signal.kind), ["request-after-interrupt"]);
    const again = normalizeOpenCodeEvent(run.state, ask, run.ctx);
    assert.deepEqual([again.events, again.signals], [[], []], `${ask.type}: a repeated frame adds nothing`);
  }
  const answered = feed(run, [
    { type: "permission.replied", properties: { sessionID: "ses_parent", requestID: "per_1", reply: "once" } },
    { type: "question.rejected", properties: { sessionID: "ses_parent", requestID: "que_1" } }
  ]).flat();
  assert.deepEqual(answered, [], "answered elsewhere while held: no card was written, so no row closes one");
  assert.deepEqual([...run.state.heldRequestIds], []);
});

// ---------------------------------------------------------------------------
// A running command's output streams as it grows (fixtures README obs. 28)
// ---------------------------------------------------------------------------

/** Fixture 04's first session, and the `bash` call it answered `always` for. */
const BASH_FIXTURE = "04-permission-reply-reject-and-always.ndjson";
const BASH_SESSION_ID = "ses_f3e6186f8ffenPAB8S3kFkEG5C";
const BASH_CALL = "tool_bash_ScHQURJqKbvpqpPqfcWJ";

/**
 * That call's frames, verbatim: `pending` (line 103), `running` with no
 * metadata yet (105), `running` with `metadata.output: ""` (110) and with
 * `"two\n"` (111), then `completed` (114).
 */
function bashFrames(renames: Readonly<Record<string, string>> = {}): {
  pending: OpenCodeRawEvent;
  running: OpenCodeRawEvent;
  empty: OpenCodeRawEvent;
  grown: OpenCodeRawEvent;
  completed: OpenCodeRawEvent;
} {
  const [pending, running, empty, grown, completed] = fixtureFrames(
    BASH_FIXTURE,
    [103, 105, 110, 111, 114],
    renames
  );
  assert.ok(pending && running && empty && grown && completed);
  return { pending, running, empty, grown, completed };
}

/** A tool part frame whose `metadata.output` — and a completion's output — read `output`. */
function withOutput(frame: OpenCodeRawEvent, output: string): OpenCodeRawEvent {
  const copy = JSON.parse(JSON.stringify(frame)) as {
    type: string;
    properties: { part: { state: Record<string, unknown> } };
  };
  const state = copy.properties.part.state;
  state.metadata = { ...(state.metadata as Record<string, unknown> | undefined), output };
  if (state.status === "completed") {
    state.output = output;
  }
  return copy;
}

/** The `command_output` chunks among `events`, in order. */
function outputChunks(
  events: readonly RuntimeEvent[]
): Extract<RuntimeEvent, { type: "content.delta" }>[] {
  return eventsOfType(events, "content.delta").filter(
    (event) => event.payload.streamKind === "command_output"
  );
}

function joined(chunks: readonly Extract<RuntimeEvent, { type: "content.delta" }>[]): string {
  return chunks.map((chunk) => chunk.payload.delta).join("");
}

/**
 * What 1.18.32's `ShellTool` puts in `metadata.output` for `printed` (`Ze`,
 * read from the source): all of it up to 30 000 characters, then `"...\n\n"`
 * and the last 30 000.
 */
function outputWindow(printed: string): string {
  return printed.length <= 30_000 ? printed : `...\n\n${printed.slice(-30_000)}`;
}

/** `count` numbered lines from `from`, 11 characters each. */
function numberedLines(from: number, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `line ${String(from + index).padStart(5, "0")}\n`
  ).join("");
}

test("03: a running bash part streams what it printed, on its call, in its turn", () => {
  const { events } = replay("03-permission-ask-reply-once.ndjson");
  const call = "tool_bash_hUFbWmc0v5dvHJZ6lgfR";
  const chunks = outputChunks(events);
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["hi\n"]
  );
  const completed = eventsOfType(events, "item.completed").find((event) => event.itemId === call);
  assert.ok(completed !== undefined);
  assert.equal(chunks[0]?.itemId, call, "the call's own item, which its rows join on");
  assert.equal(chunks[0]?.turnId, completed.turnId);
  assert.equal(chunks[0]?.agentId, undefined, "the thread's own command");
  assert.equal(joined(chunks), (completed.payload.data as { result?: string }).result);
});

test("running bash parts yield chunks whose concatenation is the final output", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const final = "one\ntwo\nthree\n";
  const perFrame = feed(session, [
    bash.pending,
    bash.running,
    bash.empty,
    withOutput(bash.grown, "one\n"),
    withOutput(bash.grown, "one\n"),
    withOutput(bash.grown, "one\ntwo\n"),
    withOutput(bash.grown, final),
    withOutput(bash.completed, final)
  ]);
  const chunks = outputChunks(perFrame.flat());
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["one\n", "two\n", "three\n"],
    "only what each frame appended; a re-stated value adds nothing"
  );
  assert.equal(joined(chunks), final);
  for (const chunk of chunks) {
    assert.equal(chunk.itemId, BASH_CALL);
    assert.equal(chunk.turnId, "turn-1");
    assert.equal(chunk.agentId, undefined);
  }
  // The completion is what it was: its own output, and no chunk.
  const last = perFrame.at(-1) ?? [];
  assert.deepEqual(outputChunks(last), []);
  const done = eventsOfType(last, "item.completed")[0];
  assert.equal(done?.payload.detail, final);
  assert.equal((done?.payload.data as { result?: string }).result, final);
  assert.equal(session.state.outputMarks.size, 0, "a settled part keeps no mark");
});

test("12: a subagent's running bash streams under the subagent, like the call's rows", () => {
  const { events } = replayChildParent();
  const chunks = outputChunks(events);
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["README.md\na.ts\n"]
  );
  const completed = eventsOfType(events, "item.completed").find(
    (event) => event.itemId === "call_174911"
  );
  assert.equal(completed?.agentId, CHILD_SESSION_ID);
  for (const chunk of chunks) {
    assert.equal(chunk.itemId, "call_174911");
    assert.equal(chunk.agentId, CHILD_SESSION_ID);
  }
  assert.equal(joined(chunks), (completed?.payload.data as { result?: string }).result);
});

test("a resumed subagent's growing bash output streams under it, every chunk once", () => {
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume");
  const [busy, pending, running, empty, grown, completed] = resume.work;
  assert.ok(busy && pending && running && empty && grown && completed);
  const final = "README.md\na.ts\nsrc/\n";
  const events = feed(run, [
    resume.pending,
    resume.running,
    busy,
    pending,
    running,
    empty,
    withOutput(grown, "README.md\n"),
    withOutput(grown, "README.md\na.ts\n"),
    withOutput(grown, final),
    withOutput(completed, final)
  ]).flat();
  const chunks = outputChunks(events);
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["README.md\n", "a.ts\n", "src/\n"]
  );
  assert.equal(joined(chunks), final);
  for (const chunk of chunks) {
    assert.equal(chunk.agentId, CHILD_SESSION_ID);
    assert.equal(chunk.itemId, "call_bash_call_resume");
    assert.equal(chunk.turnId, "turn-resume");
  }
});

test("12 through the host: the chunks are the child call's output, joined and closed", async () => {
  const { log } = await throughHost(replayChildParent().events);
  const rows = log.flatMap((event) =>
    event.type === "thread.activity-appended" ? [event.payload.activity] : []
  );
  const ofCall = rows.filter(
    (row) => (row.payload as { toolUseId?: unknown }).toolUseId === "call_174911"
  );
  const chunks = ofCall.filter((row) => row.activityKind === "tool.output");
  const completion = ofCall.find((row) => row.activityKind === "tool.completed");
  assert.ok(chunks.length >= 1 && completion !== undefined);
  for (const chunk of chunks) {
    assert.equal(chunk.agentId, CHILD_SESSION_ID, "the child's window and drill-in");
    assert.ok(rows.indexOf(chunk) < rows.indexOf(completion), "written before the completion");
  }
  // What `read_tool_output` answers for the call (`store/tool-output.ts`).
  assert.deepEqual(joinToolOutput(log, completion.id), {
    toolUseId: "call_174911",
    output: "README.md\na.ts\n",
    complete: true,
    truncated: false
  });
});

test("a tool that is not a command streams nothing from its metadata", () => {
  const session = liveSession(BASH_SESSION_ID);
  const read = bashFrames({ '"tool":"bash"': '"tool":"read"' });
  const events = feed(session, [
    read.pending,
    read.running,
    withOutput(read.grown, "file contents\n")
  ]).flat();
  assert.deepEqual(outputChunks(events), []);
});

test("a tail window re-bases on what it keeps, and never repeats a character", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  // 29 700 characters, then past the 30 000 the tool keeps: 330, 11, 1 859.
  const pieces = [
    numberedLines(0, 2_700),
    numberedLines(2_700, 30),
    numberedLines(2_730, 1),
    numberedLines(2_731, 169)
  ];
  let printed = "";
  const frames = [bash.pending, bash.running, bash.empty];
  for (const piece of pieces) {
    printed += piece;
    frames.push(withOutput(bash.grown, outputWindow(printed)));
  }
  assert.ok(printed.length > 30_000);
  const chunks = outputChunks(feed(session, frames).flat());
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    pieces
  );
  assert.equal(joined(chunks), printed, "every character printed, once");
});

test("a window that keeps nothing already shown is shown whole, its head marking the gap", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const first = numberedLines(0, 100);
  // A burst longer than the window between two frames.
  const burst = numberedLines(100, 3_000);
  const windowed = outputWindow(first + burst);
  const chunks = outputChunks(
    feed(session, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, first),
      withOutput(bash.grown, windowed)
    ]).flat()
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    [first, windowed]
  );
  assert.ok(windowed.startsWith("...\n\n"));
});

test("a value that rewinds adds nothing, and the output goes on from the most shown", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const chunks = outputChunks(
    feed(session, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, "one\ntwo\n"),
      withOutput(bash.grown, ""),
      withOutput(bash.grown, "one\n"),
      withOutput(bash.grown, "one\ntwo\nthree\n")
    ]).flat()
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["one\ntwo\n", "three\n"]
  );
});

test("a value of no known shape shares nothing provable: it re-bases and adds nothing", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const chunks = outputChunks(
    feed(session, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, "one\ntwo\n"),
      withOutput(bash.grown, "[redrawn] 40%"),
      withOutput(bash.grown, "[redrawn] 40%\ndone\n")
    ]).flat()
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["one\ntwo\n", "\ndone\n"]
  );
});

test("a removed part drops its mark; the marks are bounded, the longest unwritten first", () => {
  const session = liveSession(BASH_SESSION_ID);
  const partOf = (frame: OpenCodeRawEvent): string =>
    (frame.properties as { part: { id: string } }).part.id;
  const bash = bashFrames();
  feed(session, [withOutput(bash.grown, "one\n")]);
  assert.deepEqual([...session.state.outputMarks.keys()], [partOf(bash.grown)]);
  feed(session, [
    {
      type: "message.part.removed",
      properties: {
        sessionID: BASH_SESSION_ID,
        messageID: "msg_0c19e9533001yJC1rvPg6UFOT3",
        partID: partOf(bash.grown)
      }
    }
  ]);
  assert.equal(session.state.outputMarks.size, 0);

  // 64 commands running at once, none of them settling, then a 65th: the
  // mark written longest ago is the one that goes.
  const command = (index: number, output: string): OpenCodeRawEvent =>
    withOutput(bashFrames({ prt_0c19e993b0013DG2Hi0JnCZ7bT: `prt_cmd_${index}` }).grown, output);
  feed(
    session,
    Array.from({ length: 64 }, (_, index) => command(index, "x\n"))
  );
  const more = feed(session, [command(0, "x\ny\n"), command(64, "z\n")]).flat();
  assert.deepEqual(
    outputChunks(more).map((chunk) => chunk.payload.delta),
    ["y\n", "z\n"]
  );
  assert.equal(session.state.outputMarks.size, 64);
  assert.equal(session.state.outputMarks.has("prt_cmd_0"), true, "written again, so kept");
  assert.equal(session.state.outputMarks.has("prt_cmd_1"), false);
});

test("a repeating output that slides into itself loses the repeat, never shows it twice", () => {
  const bar = "=".repeat(30_000);
  const window = outputWindow(`${bar}==`);
  assert.deepEqual(advanceOutputMark(bar, window), { mark: window, chunk: "" });
});

test("the window's overlap is the longest suffix of the mark that starts it", () => {
  // Against the obvious quadratic reading, on a two-letter alphabet where
  // borders repeat and a wrong fallback shows: short words, and long ones
  // made of a few repeated blocks, which past the 256-character anchor offer
  // the search many places to try.
  let seed = 7;
  const next = (bound: number): number => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % bound;
  };
  const letters = (length: number): string =>
    Array.from({ length }, () => (next(2) === 0 ? "a" : "b")).join("");
  const blocks = (): string => {
    const block = letters(1 + next(4));
    return `${block.repeat(Math.floor(next(700) / block.length))}${letters(next(3))}`;
  };
  const longest = (left: string, right: string): number => {
    let length = Math.min(left.length, right.length);
    while (length > 0 && !left.endsWith(right.slice(0, length))) {
      length -= 1;
    }
    return length;
  };
  for (let round = 0; round < 2_000; round += 1) {
    const long = round % 10 === 0;
    const left = long ? blocks() : letters(next(13));
    const right = long ? blocks() : letters(next(13));
    const expected = longest(left, right);
    assert.equal(suffixPrefixOverlap(left, right), expected, `${left} / ${right}`);
    assert.equal(borderOverlap(left, right), expected, `${left} / ${right}`);
  }
  // Hundreds of places end with the anchor and only the last verifies: the
  // linear pass answers.
  const defect = `${"a".repeat(300)}b${"a".repeat(300)}`;
  assert.equal(suffixPrefixOverlap(defect, "a".repeat(601)), 300);
});

test("a head-less value that does not extend the mark adds nothing, whatever it overlaps", () => {
  // Its leading "\n" overlaps the mark's end; read as a window, it repeated one\ntwo.
  const value = "\n[truncated]\none\ntwo\nthree\n";
  assert.deepEqual(advanceOutputMark("one\ntwo\n", value), { mark: value, chunk: "" });
});

test("a removed message drops its parts' marks", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  feed(session, [withOutput(bash.grown, "one\n")]);
  assert.equal(session.state.outputMarks.size, 1);
  feed(session, [
    {
      type: "message.removed",
      properties: { sessionID: BASH_SESSION_ID, messageID: "msg_0c19e9533001yJC1rvPg6UFOT3" }
    }
  ]);
  assert.equal(session.state.outputMarks.size, 0);
});

// ---------------------------------------------------------------------------
// A settled command's stream ends as its completion does (fixtures README
// obs. 28): 1.18.32's final `output` is not always the last running value
// ---------------------------------------------------------------------------

/**
 * What 1.18.32's `ShellTool.run` appends to a command's final `output` when
 * it stopped the command (read from the source, not captured).
 */
function shellMetadata(...notes: string[]): string {
  return `\n\n<shell_metadata>\n${notes.join("\n")}\n</shell_metadata>`;
}
const TIMEOUT_NOTE = shellMetadata(
  "shell tool terminated command after exceeding timeout 120000 ms. If this command is " +
    "expected to take longer and is not waiting for interactive input, retry with a larger " +
    "timeout value in milliseconds."
);
const ABORT_NOTE = shellMetadata("User aborted the command");

/**
 * A completed `bash` part as 1.18.32 ends one: `output` the final text,
 * `metadata.output` the last running value (`w || Ze(B)`, read from the
 * source).
 */
function settledAs(
  frame: OpenCodeRawEvent,
  output: string,
  last: string,
  metadata: Record<string, unknown> = {}
): OpenCodeRawEvent {
  const copy = JSON.parse(JSON.stringify(frame)) as {
    type: string;
    properties: { part: { state: Record<string, unknown> } };
  };
  const state = copy.properties.part.state;
  state.output = output;
  state.metadata = { output: last, exit: null, truncated: false, ...metadata };
  return copy;
}

test("a timeout's note reaches the stream, before the completion closes it", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const printed = "starting\nready\n";
  const final = `${printed}${TIMEOUT_NOTE}`;
  const perFrame = feed(session, [
    bash.pending,
    bash.running,
    bash.empty,
    withOutput(bash.grown, "starting\n"),
    withOutput(bash.grown, printed),
    settledAs(bash.completed, final, printed)
  ]);
  const chunks = outputChunks(perFrame.flat());
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["starting\n", "ready\n", TIMEOUT_NOTE]
  );
  assert.equal(joined(chunks), final, "the settled row reads what the completion says");
  assert.deepEqual(
    (perFrame.at(-1) ?? []).map((event) => event.type),
    ["content.delta", "item.completed"],
    "the remainder goes out before the completion that closes the call's buffer"
  );
  assert.equal(session.state.outputMarks.size, 0);
});

test("an abort's note reaches the stream too", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const printed = "watching…\n";
  const chunks = outputChunks(
    feed(session, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, printed),
      settledAs(bash.completed, `${printed}${ABORT_NOTE}`, printed)
    ]).flat()
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    [printed, ABORT_NOTE]
  );
});

test("a completion that extends the last running value adds what the frames missed", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const chunks = outputChunks(
    feed(session, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, "one\n"),
      settledAs(bash.completed, "one\ntwo\n", "one\n")
    ]).flat()
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.payload.delta),
    ["one\n", "two\n"]
  );
});

/** The note 1.18.32's `ShellTool.run` opens a final output it cut with (read from the source). */
function cutNote(saved: string): string {
  return `...output truncated...\n\nFull output saved to: ${saved}\n\n`;
}

test("a windowed output killed at the timeout: its note reaches the joined output", async () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  const pieces = [numberedLines(0, 2_700), numberedLines(2_700, 400)];
  let printed = "";
  const frames = [bash.pending, bash.running, bash.empty];
  for (const piece of pieces) {
    printed += piece;
    frames.push(withOutput(bash.grown, outputWindow(printed)));
  }
  // The final output is its own cut: a note naming the saved file, the last
  // lines within the tool's limits, then the timeout's note.
  const saved = "/tmp/opencode/tool_output_1";
  const tail = printed.split("\n").slice(-2_001).join("\n");
  const final = `${cutNote(saved)}${tail}${TIMEOUT_NOTE}`;
  frames.push(
    settledAs(bash.completed, final, outputWindow(printed), { truncated: true, outputPath: saved })
  );
  const events = feed(session, frames).flat();
  // The cut's own note opens the final output, before the stream's end: it
  // could never be in the remainder, so its pointer closes the stream.
  const pointer = `\n\nFull output saved to: ${saved}`;
  assert.deepEqual(
    outputChunks(events).map((chunk) => chunk.payload.delta),
    [...pieces, `${TIMEOUT_NOTE}${pointer}`]
  );

  const { log } = await throughHost(events);
  const completion = log
    .flatMap((event) => (event.type === "thread.activity-appended" ? [event.payload.activity] : []))
    .find(
      (row) =>
        row.activityKind === "tool.completed" &&
        (row.payload as { toolUseId?: unknown }).toolUseId === BASH_CALL
    );
  assert.ok(completion !== undefined);
  assert.deepEqual(joinToolOutput(log, completion.id), {
    toolUseId: BASH_CALL,
    output: `${printed}${TIMEOUT_NOTE}${pointer}`,
    complete: true,
    truncated: false
  });
});

test("a cut final output closes the stream with where the whole output was saved", () => {
  const bash = bashFrames();
  const saved = "/tmp/opencode/tool_output_2";
  const printed = numberedLines(0, 3_000);
  const tail = printed.split("\n").slice(-2_001).join("\n");
  const pointer = `\n\nFull output saved to: ${saved}`;
  // Nothing past the stream's end but the pointer.
  const plain = outputChunks(
    feed(liveSession(BASH_SESSION_ID), [
      bash.pending,
      bash.running,
      withOutput(bash.grown, outputWindow(printed)),
      settledAs(bash.completed, `${cutNote(saved)}${tail}`, outputWindow(printed))
    ]).flat()
  );
  assert.deepEqual(
    plain.map((chunk) => chunk.payload.delta),
    [outputWindow(printed), pointer]
  );
  // Where the stream's end cannot be placed, the pointer alone: it repeats nothing.
  const lost = outputChunks(
    feed(liveSession(BASH_SESSION_ID), [
      bash.pending,
      bash.running,
      withOutput(bash.grown, numberedLines(9_000, 10)),
      settledAs(bash.completed, `${cutNote(saved)}${tail}`, numberedLines(9_000, 10))
    ]).flat()
  );
  assert.deepEqual(
    lost.map((chunk) => chunk.payload.delta),
    [numberedLines(9_000, 10), pointer]
  );
  // A final output that extends the stream was never cut: no pointer.
  const whole = outputChunks(
    feed(liveSession(BASH_SESSION_ID), [
      bash.pending,
      bash.running,
      withOutput(bash.grown, "one\n"),
      settledAs(bash.completed, "one\ntwo\n", "one\n")
    ]).flat()
  );
  assert.deepEqual(
    whole.map((chunk) => chunk.payload.delta),
    ["one\n", "two\n"]
  );
});

test("a completion whose final output the tool cut is stored marked cut; any other is not", () => {
  const bash = bashFrames();
  const saved = "/tmp/opencode/tool_output_3";
  const printed = numberedLines(0, 3_000);
  // What 1.18.32's `ShellTool.run` keeps of an output past its limits: its
  // END (`es` walks the lines from the last one), behind the note.
  const tail = printed.split("\n").slice(-2_001).join("\n");
  const kept = `${cutNote(saved)}${tail}`;
  const completionOf = (events: readonly RuntimeEvent[]) => {
    const done = eventsOfType(events, "item.completed").find((event) => event.itemId === BASH_CALL);
    assert.ok(done !== undefined, "the call's completion");
    return done.payload;
  };

  const cut = feed(liveSession(BASH_SESSION_ID), [
    bash.pending,
    bash.running,
    withOutput(bash.grown, outputWindow(printed)),
    settledAs(bash.completed, kept, outputWindow(printed), { truncated: true, outputPath: saved })
  ]).flat();
  const stored = completionOf(cut);
  assert.equal(stored.truncated, true, "its data keeps only the part the tool kept");
  assert.equal((stored.data as { result?: string }).result, kept, "that part, as the tool wrote it");
  for (const row of [...eventsOfType(cut, "item.started"), ...eventsOfType(cut, "item.updated")]) {
    assert.equal("truncated" in row.payload, false, "only the completion is marked");
  }

  // Nothing streamed before it: the completion is marked all the same.
  const unseen = feed(liveSession(BASH_SESSION_ID), [
    bash.pending,
    settledAs(bash.completed, kept, outputWindow(printed), { truncated: true, outputPath: saved })
  ]).flat();
  assert.equal(completionOf(unseen).truncated, true);

  // Whole: a final output the tool never cut, even one that quotes the note
  // somewhere other than at its start, is stored whole and says nothing.
  for (const final of ["one\ntwo\n", `grep found:\n${cutNote(saved)}done\n`]) {
    const whole = feed(liveSession(BASH_SESSION_ID), [
      bash.pending,
      bash.running,
      withOutput(bash.grown, "one\n"),
      settledAs(bash.completed, final, "one\n")
    ]).flat();
    assert.equal("truncated" in completionOf(whole), false, JSON.stringify(final));
  }

  // A tool that is not a command keeps its output as it is: no reader takes
  // its data for a command's output.
  const read = JSON.parse(JSON.stringify(settledAs(bash.completed, kept, ""))) as {
    type: string;
    properties: { part: { tool: string } };
  };
  read.properties.part.tool = "read";
  const readDone = eventsOfType(feed(liveSession(BASH_SESSION_ID), [read]).flat(), "item.completed")[0];
  assert.equal(readDone?.payload.itemType, "dynamic_tool_call");
  assert.equal("truncated" in (readDone?.payload ?? {}), false);
});

/**
 * What 1.18.32's generic `Truncate.output` makes of a tool's output past its
 * limits (read from the source, not captured): the HEAD — its default
 * direction, the only one any tool uses — then its note at the END, whose last
 * line depends on whether the agent may delegate to the Task tool. Every tool
 * but the shell goes through it (`Tool.define`, and every MCP tool), with
 * `metadata.truncated` and `outputPath` set beside it.
 */
function genericCut(head: string, cut: string, saved: string, taskHint = false): string {
  const hint = taskHint
    ? "Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context."
    : "Use Grep to search the full content or Read with offset/limit to view specific sections.";
  return `${head}\n\n...${cut} truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${saved}\n${hint}`;
}

test("a command's completion the generic truncation cut — the head kept, its note at the end — is stored marked cut too", () => {
  const bash = bashFrames();
  const saved = "/home/u/.local/share/opencode/tool-output/tool_1";
  // A command-named tool that is not the shell: an MCP server's, say.
  const asTool = (frame: OpenCodeRawEvent, tool: string): OpenCodeRawEvent => {
    const copy = JSON.parse(JSON.stringify(frame)) as { type: string; properties: { part: { tool: string } } };
    copy.properties.part.tool = tool;
    return copy;
  };
  const completionFor = (tool: string, output: string) =>
    eventsOfType(
      feed(liveSession(BASH_SESSION_ID), [
        asTool(settledAs(bash.completed, output, "", { truncated: true, outputPath: saved }), tool)
      ]).flat(),
      "item.completed"
    )[0]?.payload;

  const head = numberedLines(0, 2_000);
  for (const output of [
    genericCut(head, "1200 lines", saved),
    genericCut(head, "1200 lines", saved, true),
    // A first line past the byte limit: nothing of it kept, the note alone.
    genericCut("", "80000 bytes", saved)
  ]) {
    const stored = completionFor("shell_run_command", output);
    assert.equal(stored?.itemType, "command_execution");
    assert.equal(stored?.truncated, true, JSON.stringify(output.slice(-120)));
  }
  // The note anywhere but at the end is output, not the tool's cut.
  const quoted = completionFor("shell_run_command", `${genericCut(head, "5 lines", saved)}\nmore output\n`);
  assert.equal("truncated" in (quoted ?? {}), false);
  // A tool that is not a command keeps its output as it is.
  const read = completionFor("read", genericCut(head, "1200 lines", saved));
  assert.equal(read?.itemType, "dynamic_tool_call");
  assert.equal("truncated" in (read ?? {}), false);
});

test("a final output that neither extends the stream nor holds its end adds nothing", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  // A stream too short to anchor on: its end proves nothing where it recurs.
  const short = outputChunks(
    feed(session, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, "ok\n"),
      settledAs(bash.completed, `...output truncated...\n\nok\nok\n${TIMEOUT_NOTE}`, "ok\n")
    ]).flat()
  );
  assert.deepEqual(
    short.map((chunk) => chunk.payload.delta),
    ["ok\n"]
  );
  // A long stream whose end the final output does not hold.
  const other = liveSession(BASH_SESSION_ID);
  const printed = numberedLines(0, 100);
  const long = outputChunks(
    feed(other, [
      bash.pending,
      bash.running,
      withOutput(bash.grown, printed),
      settledAs(bash.completed, `...output truncated...\n\n${numberedLines(500, 10)}`, printed)
    ]).flat()
  );
  assert.deepEqual(
    long.map((chunk) => chunk.payload.delta),
    [printed]
  );
});

test("a command that printed nothing, or failed, adds nothing at its end", () => {
  const session = liveSession(BASH_SESSION_ID);
  const bash = bashFrames();
  // Nothing streamed, so nothing replaces its completion's own "(no output)".
  const silent = feed(session, [
    bash.pending,
    bash.running,
    bash.empty,
    settledAs(bash.completed, "(no output)", "(no output)")
  ]).flat();
  assert.deepEqual(outputChunks(silent), []);

  // An errored part has no final output: its error stays the completion's.
  const failing = liveSession(BASH_SESSION_ID);
  const failed = feed(failing, [
    bash.pending,
    bash.running,
    withOutput(bash.grown, "one\n"),
    erroredPart(withOutput(bash.grown, "one\n"), "Tool execution aborted")
  ]).flat();
  assert.deepEqual(
    outputChunks(failed).map((chunk) => chunk.payload.delta),
    ["one\n"]
  );
  assert.equal(failing.state.outputMarks.size, 0);
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

test("13: the recorded errors name no account failure", () => {
  const { events } = replay("13-error-shapes.ndjson");
  for (const error of eventsOfType(events, "runtime.error")) {
    assert.equal(error.payload.reason, undefined);
  }
});

test("an account failure on session.error carries a structured reason (workflows §5.4)", () => {
  // No capture holds a limit or a refused login: the frames follow the
  // recorded session.error envelope of 13, with the SDK's typed errors in it.
  const { state, ctx } = replay("13-error-shapes.ndjson");
  const sessionID = state.openCodeSessionId;
  const reasons = (error: unknown): Array<[string | undefined, string | undefined]> => {
    state.activeTurnId = "turn-limit";
    state.lastSessionErrorMessage = undefined;
    const { events } = normalizeOpenCodeEvent(
      state,
      { type: "session.error", properties: { sessionID, error } } as OpenCodeRawEvent,
      ctx
    );
    return eventsOfType(events, "runtime.error").map((event) => [
      event.payload.reason,
      event.payload.resetsAt
    ]);
  };
  const apiError = (statusCode: number, responseHeaders?: Record<string, string>): unknown => ({
    name: "APIError",
    data: {
      message: `status ${statusCode}`,
      statusCode,
      isRetryable: false,
      ...(responseHeaders !== undefined ? { responseHeaders } : {})
    }
  });
  assert.deepEqual(reasons(apiError(429)), [["usage_limit", undefined]]);
  // `ctx.nowIso` is 2026-09-21T00:00:00.000Z.
  assert.deepEqual(reasons(apiError(429, { "Retry-After": "120" })), [
    ["usage_limit", "2026-09-21T00:02:00.000Z"]
  ]);
  assert.deepEqual(reasons(apiError(429, { "retry-after-ms": "1500" })), [
    ["usage_limit", "2026-09-21T00:00:01.500Z"]
  ]);
  assert.deepEqual(reasons(apiError(401)), [["auth", undefined]]);
  assert.deepEqual(reasons(apiError(403)), [["auth", undefined]]);
  assert.deepEqual(
    reasons({ name: "ProviderAuthError", data: { providerID: "anthropic", message: "no key" } }),
    [["auth", undefined]]
  );
  assert.deepEqual(reasons(apiError(500)), [[undefined, undefined]]);
  assert.deepEqual(reasons({ name: "UnknownError", data: { message: "429 Too Many Requests" } }), [
    [undefined, undefined]
  ]);
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

// ---------------------------------------------------------------------------
// An agent's start carries the prompt its launching part gave it (§7.6)
// ---------------------------------------------------------------------------

/** Fixture 12's launching `task` part, as the capture holds it: its `running` frame (line 142). */
function launchPromptOfFixture12(): string {
  const [running] = childFixtureFrames([142]);
  const prompt = (running as { properties: { part: { state: { input?: { prompt?: unknown } } } } })
    .properties.part.state.input?.prompt;
  assert.ok(typeof prompt === "string" && prompt.startsWith("List the files"));
  return prompt;
}

test("12: the child's start carries the prompt its launching `task` part gave it; no other task row does", () => {
  const prompt = launchPromptOfFixture12();
  const { events } = replayChildParent();
  const [start, ...rest] = eventsOfType(events, "task.started");
  assert.deepEqual(rest, []);
  assert.equal(start?.payload.prompt, prompt, "the part's `input.prompt`, verbatim");
  for (const row of events.filter((event) => event.type.startsWith("task.") && event !== start)) {
    assert.equal("prompt" in (row.payload as object), false, `${row.type} repeats no prompt`);
  }
});

test("a `task_id` resume's start carries the resume's own prompt, never the first launch's", () => {
  const first = launchPromptOfFixture12();
  const run = replayChildParent();
  run.state.activeTurnId = "turn-resume";
  const resume = resumeFrames("call_resume", { [first]: "Now list the hidden files too." });
  const [start] = eventsOfType(feed(run, [resume.pending, resume.running]).flat(), "task.started");
  assert.equal(start?.payload.toolUseId, "call_resume");
  assert.equal(start?.payload.prompt, "Now list the hidden files too.");
});

test("a grandchild's start carries the prompt its parent child's `task` part gave it", () => {
  const run = liveSession("ses_parent");
  // Prompts unlike their descriptions: the start carries `input.prompt`, and
  // the description stays the task's name.
  const launched = feed(run, [
    ...childLaunch({
      sessionId: "ses_parent",
      childId: "ses_child",
      callId: "call_child",
      description: "list files",
      prompt: "List every file under src/ and name the largest.",
      background: false
    }),
    busyOf("ses_child"),
    ...childLaunch({
      sessionId: "ses_child",
      childId: "ses_gc",
      callId: "call_gc",
      description: "dig deeper",
      prompt: "Read the largest file and summarise its exports.",
      background: false
    })
  ]).flat();
  assert.deepEqual(
    eventsOfType(launched, "task.started").map((event) => [
      event.payload.taskId,
      event.payload.description,
      event.payload.prompt
    ]),
    [
      ["ses_child", "list files", "List every file under src/ and name the largest."],
      ["ses_gc", "dig deeper", "Read the largest file and summarise its exports."]
    ]
  );
});

test("a start no part named yet carries no prompt, and neither does a revive of a run that already had one", () => {
  // Fixture 12's child in the background, its `running` frame lost: its own
  // `busy` starts it under its own launch id, before any part names it.
  const run = replayChildParent();
  run.state.activeTurnId = "turn-background";
  const [pending, created, completed] = childFixtureFrames([140, 141, 180], BACKGROUND_RENAMES);
  assert.ok(pending && created && completed);
  const launched = feed(run, [pending, created, ...childFixtureFrames([148], BACKGROUND_RENAMES), inBackground(completed)]).flat();
  const [orphan] = eventsOfType(launched, "task.started");
  assert.equal(orphan?.payload.toolUseId, "opencode-child:ses_background_child");
  assert.equal("prompt" in (orphan?.payload ?? {}), false, "no part had said what it was asked");

  // A Stop closes it; the server says it runs on: the revive continues the run
  // its launch prompted, with no prompt of its own.
  closeLiveChildAgents(run.state, run.ctx, "interrupted");
  const reported = normalizeOpenCodeEvent(run.state, childFixtureFrames([148], BACKGROUND_RENAMES)[0]!, run.ctx)
    .signals.find((signal) => signal.kind === "child-reports-run");
  assert.ok(reported !== undefined && reported.kind === "child-reports-run");
  const revived = eventsOfType(
    settleChildSurvival(run.state, "ses_background_child", reported.checkId, true, run.ctx),
    "task.started"
  );
  assert.deepEqual(revived.map((event) => event.payload.toolUseId), ["opencode-revive:call_background:1"]);
  assert.equal("prompt" in (revived[0]?.payload ?? {}), false);
});
