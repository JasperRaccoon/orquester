/**
 * Lifecycle tests for the OpenCode thread session, against an **injected
 * transport** (spec §9): a fake `fetch` that answers the real routes and an
 * SSE stream the test pushes verbatim frames into. The adapter's own code —
 * the three completion machines, the settle-before-interrupt ordering, the
 * fork-based rollback, the native-command dispatch — is what runs.
 *
 * Nothing here sleeps. Every assertion waits on an emitted event or on a
 * recorded request.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { resumeCursorFor } from "../../orchestration/resume.ts";
import {
  OpenCodeThreadSession,
  parseOpenCodeModelSlug,
  parseOpenCodeResume,
  toQuestionAnswers
} from "./session.ts";
import type { OpenCodeServerHandle } from "./server.ts";
import { OpenCodeClient } from "./http.ts";
import { deferred } from "./util.ts";

// ---------------------------------------------------------------------------
// The fake server
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

type FakeMessage = { info: { id: string; role: string }; parts: unknown[] };

class FakeOpenCode {
  readonly requests: RecordedRequest[] = [];
  readonly sessions = new Map<string, { id: string; directory: string; title?: string }>();
  statusMap: Record<string, { type: string }> = {};
  messages: FakeMessage[] = [];
  forkMessages: FakeMessage[] = [];
  /**
   * When set, `POST /session/{id}/fork` forks like the real server (fixtures
   * README observations 17 and 10): the new session holds the source's
   * messages BEFORE `messageID`, in order, every id re-minted — into
   * `sessionMessages`, which `GET …/message` reads before the two lists above.
   */
  faithfulForks = false;
  readonly sessionMessages = new Map<string, FakeMessage[]>();
  children: { id: string }[] = [];
  commands: { name: string; description?: string; hints?: string[] }[] = [];
  permissionsOpen: unknown[] = [];
  questionsOpen: unknown[] = [];
  /** Overrides keyed by `METHOD path-suffix`. */
  readonly overrides = new Map<string, () => Response>();
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private nextSession = 0;

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });

    for (const [key, handler] of this.overrides) {
      const [overrideMethod, overridePath] = key.split(" ", 2);
      if (method === overrideMethod && path === overridePath) {
        this.overrides.delete(key);
        return handler();
      }
    }

    if (path === "/event") {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    if (path === "/session" && method === "POST") {
      this.nextSession += 1;
      const id = `ses_created_${this.nextSession}`;
      const record = {
        id,
        directory: url.searchParams.get("directory") ?? "/repo",
        ...(typeof (body as { title?: string })?.title === "string"
          ? { title: (body as { title: string }).title }
          : {})
      };
      this.sessions.set(id, record);
      return json(record);
    }
    if (path === "/session/status") {
      return json(this.statusMap);
    }
    if (path === "/command") {
      return json(this.commands);
    }
    if (path === "/permission") {
      return json(this.permissionsOpen);
    }
    if (path === "/question") {
      return json(this.questionsOpen);
    }
    if (path.startsWith("/permission/") || path.startsWith("/question/")) {
      return json(true);
    }
    const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (sessionMatch !== null) {
      const id = sessionMatch[1]!;
      const tail = sessionMatch[2] ?? "";
      if (tail === "" && method === "GET") {
        const record = this.sessions.get(id);
        return record === undefined
          ? json({ name: "NotFoundError", data: { message: `Session not found: ${id}` } }, 404)
          : json(record);
      }
      if (tail === "" && method === "PATCH") {
        return json(true);
      }
      if (tail === "/prompt_async") {
        return new Response(null, { status: 204 });
      }
      if (tail === "/command") {
        return json({ info: { id: "msg_assistant", role: "assistant" }, parts: [] });
      }
      if (tail === "/abort") {
        return json(true);
      }
      if (tail === "/summarize") {
        return json(true);
      }
      if (tail === "/children") {
        return json(this.children);
      }
      if (tail === "/message") {
        return json(this.messagesOf(id));
      }
      if (tail.startsWith("/message/")) {
        const messageId = tail.slice("/message/".length);
        const found = this.messages.find((entry) => entry.info.id === messageId);
        return found === undefined
          ? json({ name: "NotFoundError", data: { message: "gone" } }, 404)
          : json(found);
      }
      if (tail === "/fork") {
        const forkId = `ses_fork_${this.nextSession += 1}`;
        this.sessions.set(forkId, { id: forkId, directory: "/repo" });
        if (this.faithfulForks) {
          const source = this.messagesOf(id);
          const cut = source.findIndex(
            (entry) => entry.info.id === (body as { messageID?: string } | undefined)?.messageID
          );
          this.sessionMessages.set(
            forkId,
            source.slice(0, cut < 0 ? source.length : cut).map((entry, index) => ({
              ...entry,
              info: { ...entry.info, id: `${forkId}-msg-${index + 1}` }
            }))
          );
        }
        return json({ id: forkId, directory: "/repo" });
      }
    }
    return json({}, 404);
  };

  messagesOf(sessionId: string): FakeMessage[] {
    return (
      this.sessionMessages.get(sessionId) ??
      (sessionId.startsWith("ses_fork") ? this.forkMessages : this.messages)
    );
  }

  /** Push one verbatim SSE frame onto the stream. */
  push(event: unknown): void {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    this.controller?.enqueue(new TextEncoder().encode(chunk));
  }

  find(method: string, suffix: string): RecordedRequest | undefined {
    return this.requests.find(
      (request) => request.method === method && request.path.endsWith(suffix)
    );
  }

  indexOf(method: string, suffix: string): number {
    return this.requests.findIndex(
      (request) => request.method === method && request.path.endsWith(suffix)
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Waiter {
  type: string;
  predicate?: (event: RuntimeEvent) => boolean;
  resolve: (event: RuntimeEvent) => void;
}

interface Harness {
  fake: FakeOpenCode;
  events: RuntimeEvent[];
  server: OpenCodeServerHandle;
  ctx: AdapterContext;
  emit: (event: RuntimeEvent) => void;
  killServer: () => void;
  dispose: () => void;
}

function makeHarness(): Harness {
  const fake = new FakeOpenCode();
  const events: RuntimeEvent[] = [];
  const waiters = new Set<Waiter>();
  const abort = new AbortController();
  const exit = deferred<{ kind: "exit"; code: number; signal: null }>();

  const emit = (event: RuntimeEvent): void => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.type === event.type && (waiter.predicate?.(event) ?? true)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };

  let ids = 0;
  const ctx: AdapterContext = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    clock: { now: () => new Date(0), nowIso: () => "2026-09-21T00:00:00.000Z" },
    ids: {
      eventId: () => `evt-${(ids += 1)}`,
      messageId: (prefix: string) => `${prefix}-${(ids += 1)}`,
      uuid: () => `uuid-${(ids += 1)}`
    },
    resolveAttachmentPath: async (_threadId, attachmentId) => `/attachments/${attachmentId}`,
    attachmentsDir: () => "/attachments",
    logRawFrame: () => undefined,
    buildEnv: () => ({}),
    resolveBin: async () => "/usr/bin/opencode",
    sessionPath: () => "/usr/bin",
    tmpDir: () => "/tmp",
    signal: abort.signal
  };

  const server: OpenCodeServerHandle = {
    url: "http://127.0.0.1:1",
    version: "1.18.5",
    serverPassword: undefined,
    projectDir: "/repo",
    pid: 1234,
    client: (directory: string) =>
      new OpenCodeClient({ baseUrl: "http://127.0.0.1:1", directory, fetchImpl: fake.fetchImpl }),
    exited: exit.promise,
    hasExited: () => false,
    release: () => undefined
  };

  const harness: Harness = {
    fake,
    events,
    server,
    ctx,
    emit,
    killServer: () => exit.resolve({ kind: "exit", code: 1, signal: null }),
    dispose: () => abort.abort()
  };
  harnessWaiters.set(harness, waiters);
  return harness;
}

const harnessWaiters = new WeakMap<Harness, Set<Waiter>>();

function waitFor<T extends RuntimeEvent["type"]>(
  harness: Harness,
  type: T,
  predicate?: (event: RuntimeEvent) => boolean
): Promise<Extract<RuntimeEvent, { type: T }>> {
  type Narrowed = Extract<RuntimeEvent, { type: T }>;
  const found = harness.events.find(
    (event): event is Narrowed =>
      event.type === type && (predicate === undefined || predicate(event))
  );
  if (found !== undefined) {
    return Promise.resolve(found);
  }
  return new Promise<Narrowed>((resolve) => {
    harnessWaiters.get(harness)?.add({
      type,
      ...(predicate !== undefined ? { predicate } : {}),
      resolve: (event) => resolve(event as Narrowed)
    });
  });
}

/** Start a session on the harness. */
async function startSession(
  harness: Harness,
  options: {
    resumeCursor?: unknown;
    runtimeMode?: "approval-required" | "full-access";
    cwd?: string;
  } = {}
): Promise<OpenCodeThreadSession> {
  return await OpenCodeThreadSession.start(
    { ctx: harness.ctx, emit: harness.emit, onClosed: () => undefined },
    {
      threadId: "thread-1",
      cwd: options.cwd ?? "/repo",
      modelSelection: { model: "openrouter/google/gemini-2.5-flash-lite" },
      runtimeMode: options.runtimeMode ?? "approval-required",
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      server: harness.server
    }
  );
}

/** Narrow to one arm of the union, so payload fields typecheck. */
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

function typesOf(events: RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Drive the frames a normal turn produces, in the order 1.18.5 emits them. */
function driveTurn(
  fake: FakeOpenCode,
  input: { sessionId: string; userMessageId: string; assistantId?: string; text?: string }
): void {
  const assistantId = input.assistantId ?? "msg_assistant";
  fake.push({
    type: "message.updated",
    properties: {
      sessionID: input.sessionId,
      info: { id: input.userMessageId, role: "user" }
    }
  });
  fake.push({
    type: "session.status",
    properties: { sessionID: input.sessionId, status: { type: "busy" } }
  });
  fake.push({
    type: "message.updated",
    properties: {
      sessionID: input.sessionId,
      info: { id: assistantId, role: "assistant", parentID: input.userMessageId }
    }
  });
  fake.push({
    type: "message.part.updated",
    properties: {
      sessionID: input.sessionId,
      part: {
        id: "prt_1",
        messageID: assistantId,
        type: "text",
        text: "",
        time: { start: 1 }
      }
    }
  });
  fake.push({
    type: "message.part.delta",
    properties: {
      sessionID: input.sessionId,
      messageID: assistantId,
      partID: "prt_1",
      field: "text",
      delta: input.text ?? "done"
    }
  });
  fake.push({
    type: "message.part.updated",
    properties: {
      sessionID: input.sessionId,
      part: {
        id: "prt_step",
        messageID: assistantId,
        type: "step-finish",
        reason: "stop",
        tokens: { input: 100, output: 5, reasoning: 1, cache: { read: 10, write: 2 } },
        cost: 0.5
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Start / resume
// ---------------------------------------------------------------------------

test("a fresh session is created WITH the ruleset in the create body", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const create = harness.fake.find("POST", "/session");
  assert.ok(create !== undefined, "expected POST /session");
  const body = create.body as { permission?: { permission: string; action: string }[] };
  assert.ok(Array.isArray(body.permission));
  assert.equal(body.permission?.[0]?.permission, "*");
  assert.equal(body.permission?.[0]?.action, "ask");
  assert.deepEqual(typesOf(harness.events).slice(0, 3), [
    "session.started",
    "thread.started",
    "session.state.changed"
  ]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("resume in the same directory reuses the session and RE-ASSERTS the ruleset", async () => {
  const harness = makeHarness();
  harness.fake.sessions.set("ses_old", { id: "ses_old", directory: "/repo" });
  const session = await startSession(harness, {
    resumeCursor: { schemaVersion: 1, sessionId: "ses_old" }
  });
  assert.equal(harness.fake.find("POST", "/session"), undefined, "must not create a session");
  const patch = harness.fake.find("PATCH", "/session/ses_old");
  assert.ok(patch !== undefined, "a runtime-mode change must reach the reused session");
  const started = firstOfType(harness.events, "session.started");
  assert.deepEqual(started?.payload.resume, { schemaVersion: 1, sessionId: "ses_old" });
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("resume against a confirmed 404 falls through to a fresh session", async () => {
  const harness = makeHarness();
  const session = await startSession(harness, {
    resumeCursor: { schemaVersion: 1, sessionId: "ses_gone" }
  });
  assert.ok(harness.fake.find("POST", "/session") !== undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("resume against a 500 PROPAGATES — a blip must never reset a live thread", async () => {
  const harness = makeHarness();
  // A malformed session id answers 500 in 1.18.5; it must not read as "gone".
  harness.fake.overrides.set(
    "GET /session/not-a-session-id",
    () => json({ name: "UnknownError", data: { message: "Unexpected server error." } }, 500)
  );
  await assert.rejects(
    startSession(harness, { resumeCursor: { schemaVersion: 1, sessionId: "not-a-session-id" } }),
    /500/
  );
  assert.equal(harness.fake.find("POST", "/session"), undefined, "no silent new session");
  harness.dispose();
});

test("the host's §6.1 create-time cursor resumes, byte for byte", async () => {
  // W1 builds the minimal §4.1 cursor for a thread created from the resume
  // picker, where all the host has is a conversation id. If this adapter did
  // not accept that partial form, §6.1 resume would silently degrade to a
  // fresh, empty session the user believes is their old one.
  const cursor = resumeCursorFor("opencode", "thread-1", "ses_from_picker");
  assert.deepEqual(cursor, { schemaVersion: 1, sessionId: "ses_from_picker" });
  assert.deepEqual(parseOpenCodeResume(cursor), { sessionId: "ses_from_picker" });

  const harness = makeHarness();
  harness.fake.sessions.set("ses_from_picker", {
    id: "ses_from_picker",
    directory: "/repo"
  });
  const session = await startSession(harness, { resumeCursor: cursor });
  assert.equal(session.sessionId, "ses_from_picker");
  assert.equal(harness.fake.find("POST", "/session"), undefined, "must not create a session");
  assert.ok(harness.fake.find("PATCH", "/session/ses_from_picker") !== undefined);
  // The adapter re-mints its own full cursor from the adopted session.
  assert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "ses_from_picker" });
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a cursor carrying unknown extra fields still resumes", async () => {
  // Forward-compat: a newer host (or a newer adapter release) may persist more
  // than the two fields this version reads. Extras are ignored, never fatal.
  const harness = makeHarness();
  harness.fake.sessions.set("ses_old", { id: "ses_old", directory: "/repo" });
  const session = await startSession(harness, {
    resumeCursor: {
      schemaVersion: 1,
      sessionId: "ses_old",
      somethingNewerWrote: { turnCount: 7 }
    }
  });
  assert.equal(session.sessionId, "ses_old");
  assert.equal(harness.fake.find("POST", "/session"), undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a cursor of the wrong shape means `no resume`, never an error", async () => {
  const harness = makeHarness();
  const session = await startSession(harness, {
    resumeCursor: { schemaVersion: 99, sessionId: "ses_old" }
  });
  assert.ok(harness.fake.find("POST", "/session") !== undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a cwd change forks rather than minting an empty session", async () => {
  const harness = makeHarness();
  harness.fake.sessions.set("ses_old", { id: "ses_old", directory: "/elsewhere" });
  const session = await startSession(harness, {
    resumeCursor: { schemaVersion: 1, sessionId: "ses_old" },
    cwd: "/repo"
  });
  assert.ok(harness.fake.find("POST", "/session/ses_old/fork") !== undefined);
  assert.equal(harness.fake.find("POST", "/session"), undefined);
  // The fork gets the ruleset too.
  assert.ok(harness.fake.requests.some((r) => r.method === "PATCH" && r.path.includes("fork")));
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

test("a turn submits prompt_async with a minted id, the system addendum and the variant", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const result = await session.sendTurn({
    threadId: "thread-1",
    input: "hello",
    attachments: [],
    interactionMode: "default",
    modelSelection: {
      model: "openrouter/google/gemini-2.5-flash-lite",
      options: [
        { id: "variant", value: "high" },
        { id: "agent", value: "build" }
      ]
    }
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.ok(submit !== undefined);
  const body = submit.body as {
    messageID: string;
    model: { providerID: string; modelID: string };
    variant?: string;
    agent?: string;
    system?: string;
    parts: { type: string; text?: string }[];
  };
  assert.match(body.messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.deepEqual(body.model, {
    providerID: "openrouter",
    modelID: "google/gemini-2.5-flash-lite"
  });
  assert.equal(body.variant, "high");
  assert.equal(body.agent, "build");
  assert.match(String(body.system), /OpenCode harness/);
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }]);
  // No `reasoningEffort` / `thinking` field is EVER sent (§4.5).
  assert.equal("reasoningEffort" in body, false);
  assert.equal("thinking" in body, false);

  const started = firstOfType(harness.events, "turn.started");
  assert.equal(started?.turnId, result.turnId);
  assert.equal(started?.payload.effort, "high");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("plan mode rides the `agent` field, per turn", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "plan it",
    attachments: [],
    interactionMode: "plan"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.equal((submit?.body as { agent?: string }).agent, "plan");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a turn completes on idle, with accumulated usage and cost", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  const messageId = (submit?.body as { messageID: string }).messageID;

  driveTurn(harness.fake, { sessionId, userMessageId: messageId });
  harness.fake.push({
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: "idle" } }
  });

  const completed = await waitFor(harness, "turn.completed");
  assert.equal(completed.turnId, turn.turnId);
  assert.equal(completed.payload.state, "completed");
  const usage = completed.payload.tokenUsage;
  assert.equal(usage?.usageStatus, "complete");
  // input + cache.read + cache.write; output + reasoning.
  assert.equal(usage?.inputTokens, 112);
  assert.equal(usage?.outputTokens, 6);
  assert.equal(completed.payload.totalCostUsd, 0.5);
  assert.deepEqual(
    eventsOfType(harness.events, "content.delta").map((e) => e.payload.delta),
    ["done"]
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("the premature-idle race still completes the turn (machine 3)", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;

  // Idle lands right after `prompt_async` returns and BEFORE any assistant
  // message exists — the exact 30 ms race fixture 10 captured. Machine (3) is
  // what has to notice the turn is really over.
  const submitted = session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  const turn = await submitted;
  const messageId = (harness.fake.find("POST", "/prompt_async")?.body as { messageID: string })
    .messageID;
  // The user message exists, which is what machine 3 confirms.
  harness.fake.messages = [{ info: { id: messageId, role: "user" }, parts: [] }];
  harness.fake.push({
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: "busy" } }
  });
  harness.fake.push({
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: "idle" } }
  });
  harness.fake.push({ type: "session.idle", properties: { sessionID: sessionId } });

  const completed = await waitFor(harness, "turn.completed");
  assert.equal(completed.turnId, turn.turnId);
  assert.equal(completed.payload.state, "completed");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a second sendTurn during a live turn STEERS: same turn id, one turn.started", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const first = await session.sendTurn({
    threadId: "thread-1",
    input: "one",
    attachments: [],
    interactionMode: "default"
  });
  const second = await session.sendTurn({
    threadId: "thread-1",
    input: "two",
    attachments: [],
    interactionMode: "default"
  });
  assert.equal(second.turnId, first.turnId, "steering reuses the active turn id");
  assert.equal(
    eventsOfType(harness.events, "turn.started").length,
    1,
    "a steer is neither an error nor a second turn"
  );
  assert.equal(
    harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).length,
    2
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a refused submit settles the turn as failed rather than leaving it running", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.fake.overrides.set(`POST /session/${session.sessionId}/prompt_async`, () =>
    json({ name: "UnknownError", data: { message: "nope" } }, 500)
  );
  await assert.rejects(
    session.sendTurn({
      threadId: "thread-1",
      input: "hi",
      attachments: [],
      interactionMode: "default"
    })
  );
  const completed = firstOfType(harness.events, "turn.completed");
  assert.equal(completed?.payload.state, "failed");
  assert.ok(harness.events.some((event) => event.type === "runtime.error"));
  harness.dispose();
});

// ---------------------------------------------------------------------------
// Slash commands (§4.6.5(c))
// ---------------------------------------------------------------------------

test("a name in `command.list` is dispatched through session.command", async () => {
  const harness = makeHarness();
  harness.fake.commands = [{ name: "fixture", description: "a fixture command", hints: [] }];
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const pending = session.sendTurn({
    threadId: "thread-1",
    input: "/fixture hello there",
    attachments: [],
    interactionMode: "default"
  });
  // `session.command` is bounded by the user-message receipt, not a submit cap.
  await waitFor(harness, "turn.started");
  const submitted = harness.fake.find("POST", "/prompt_async");
  assert.equal(submitted, undefined, "a native command must not go through prompt_async");
  harness.fake.push({
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      info: {
        id: (harness.fake.find("POST", "/session/" + sessionId + "/command")?.body as {
          messageID: string;
        }).messageID,
        role: "user"
      }
    }
  });
  await pending;
  const command = harness.fake.find("POST", "/command");
  const body = command?.body as { command: string; arguments: string; model: string };
  assert.equal(body.command, "fixture");
  assert.equal(body.arguments, "hello there");
  // The model is a STRING here, an object on prompt_async. The asymmetry is real.
  assert.equal(body.model, "openrouter/google/gemini-2.5-flash-lite");
  assert.equal("system" in body, false, "session.command accepts no system addendum");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a name that is NOT in `command.list` falls through to an ordinary prompt", async () => {
  const harness = makeHarness();
  harness.fake.commands = [{ name: "fixture" }];
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "/definitely-not-a-command hi",
    attachments: [],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.ok(submit !== undefined);
  assert.deepEqual((submit.body as { parts: unknown[] }).parts, [
    { type: "text", text: "/definitely-not-a-command hi" }
  ]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// Approvals and interrupt ordering
// ---------------------------------------------------------------------------

test("an approval reply reaches `POST /permission/{id}/reply`, never the SDK trap route", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  await session.sendTurn({
    threadId: "thread-1",
    input: "run it",
    attachments: [],
    interactionMode: "default"
  });
  harness.fake.push({
    type: "permission.asked",
    properties: {
      id: "per_1",
      sessionID: sessionId,
      permission: "bash",
      patterns: ["echo hi"],
      always: ["echo *"]
    }
  });
  await waitFor(harness, "request.opened");
  await session.respondToApproval("per_1", "acceptForSession");
  const reply = harness.fake.find("POST", "/permission/per_1/reply");
  assert.ok(reply !== undefined, "the spec's route is the one that works");
  assert.deepEqual(reply.body, { reply: "always" });
  assert.equal(
    harness.fake.requests.some((request) => request.path.includes("/permissions/")),
    false,
    "the SDK's /session/:id/permissions/:id route must never be used"
  );
  const resolved = await waitFor(harness, "request.resolved");
  assert.equal(resolved.payload.decision, "acceptForSession");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("interrupt SETTLES every open request before the abort reaches the provider", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  await session.sendTurn({
    threadId: "thread-1",
    input: "run it",
    attachments: [],
    interactionMode: "default"
  });
  harness.fake.push({
    type: "permission.asked",
    properties: { id: "per_1", sessionID: sessionId, permission: "bash", patterns: ["sleep 60"] }
  });
  await waitFor(harness, "request.opened");

  const resolvedBeforeAbort = waitFor(harness, "request.resolved");
  await session.interruptTurn();
  const resolved = await resolvedBeforeAbort;
  assert.equal(resolved.payload.decision, "cancel");

  const rejectIndex = harness.fake.indexOf("POST", "/permission/per_1/reply");
  const abortIndex = harness.fake.indexOf("POST", "/abort");
  assert.ok(rejectIndex >= 0, "the orphaned request is released, not merely ignored");
  assert.ok(
    rejectIndex < abortIndex,
    "settling must happen BEFORE the interrupt RPC, or Stop deadlocks on an open prompt"
  );
  harness.dispose();
});

test("interrupt emits turn.aborted, not turn.completed", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const turn = await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  await session.interruptTurn(turn.turnId);
  const aborted = firstOfType(harness.events, "turn.aborted");
  assert.ok(aborted !== undefined);
  assert.equal(aborted.turnId, turn.turnId);
  assert.equal(
    harness.events.some((event) => event.type === "turn.completed"),
    false
  );
  harness.dispose();
});

test("interrupt is turn-scoped: a Stop on a settled turn cannot kill the next one", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  await session.interruptTurn("opencode-turn-does-not-exist");
  assert.equal(harness.fake.find("POST", "/abort"), undefined, "a stale Stop is a no-op");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a question is answered on its reply route and dismissed on its reject route", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  await session.sendTurn({
    threadId: "thread-1",
    input: "ask me",
    attachments: [],
    interactionMode: "default"
  });
  harness.fake.push({
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID: sessionId,
      questions: [
        {
          question: "Which colour?",
          header: "Colour Preference",
          options: [{ label: "Red" }, { label: "Blue" }]
        }
      ]
    }
  });
  const asked = await waitFor(harness, "user-input.requested");
  assert.equal(asked.payload.questions[0]?.id, "question-0-colour-preference");

  await session.respondToUserInput("que_1", { "question-0-colour-preference": "Red" });
  const reply = harness.fake.find("POST", "/question/que_1/reply");
  assert.deepEqual(reply?.body, { answers: [["Red"]] });

  harness.fake.push({
    type: "question.asked",
    properties: {
      id: "que_2",
      sessionID: sessionId,
      questions: [{ question: "Again?", header: "Again", options: [] }]
    }
  });
  await waitFor(harness, "user-input.requested", (event) => event.requestId === "que_2");
  await session.respondToUserInput("que_2", {});
  assert.ok(harness.fake.find("POST", "/question/que_2/reject") !== undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// Compaction, rollback, death
// ---------------------------------------------------------------------------

test("compaction is REFUSED while a turn runs — the server has no such backstop", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  await assert.rejects(session.compact(), /cannot compact while a turn is running/);
  assert.equal(harness.fake.find("POST", "/summarize"), undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("compaction on an idle session posts summarize with auto:false", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.compact();
  const summarize = harness.fake.find("POST", "/summarize");
  assert.deepEqual(summarize?.body, {
    providerID: "openrouter",
    modelID: "google/gemini-2.5-flash-lite",
    auto: false
  });
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("rollback forks, verifies the boundary count, re-applies the ruleset and re-points", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.fake.messages = [
    { info: { id: "m1", role: "user" }, parts: [] },
    { info: { id: "m2", role: "assistant" }, parts: [] },
    { info: { id: "m3", role: "user" }, parts: [] },
    { info: { id: "m4", role: "assistant" }, parts: [] }
  ];
  // Rewinding one turn removes m3/m4, so the fork must keep exactly m1+m2.
  harness.fake.forkMessages = [
    { info: { id: "f1", role: "user" }, parts: [] },
    { info: { id: "f2", role: "assistant" }, parts: [] }
  ];
  const before = session.sessionId;
  const snapshot = await session.rollbackThread(1);
  assert.notEqual(session.sessionId, before, "the fork becomes the thread's session");
  assert.equal(session.resumeCursor.sessionId, session.sessionId);
  const fork = harness.fake.find("POST", `/session/${before}/fork`);
  assert.equal((fork?.body as { messageID: string }).messageID, "m3");
  assert.ok(
    harness.fake.requests.some(
      (request) => request.method === "PATCH" && request.path.includes("ses_fork")
    ),
    "the fork gets the ruleset"
  );
  assert.ok(harness.events.some((event) => event.type === "thread.started"));
  assert.equal(snapshot.turns.length, 1);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("rollback refuses when the fork did not preserve the boundary", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.fake.messages = [
    { info: { id: "m1", role: "user" }, parts: [] },
    { info: { id: "m2", role: "assistant" }, parts: [] },
    { info: { id: "m3", role: "user" }, parts: [] },
    { info: { id: "m4", role: "assistant" }, parts: [] }
  ];
  harness.fake.forkMessages = [{ info: { id: "f1", role: "user" }, parts: [] }];
  const before = session.sessionId;
  await assert.rejects(session.rollbackThread(1), /did not preserve the requested rewind/);
  assert.equal(session.sessionId, before, "a failed rollback must not re-point the thread");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

/** Three exchanges as OpenCode stores them: each prompt, then its answer. */
function threeExchanges(): FakeMessage[] {
  return [
    { info: { id: "msg_p1", role: "user" }, parts: [] },
    { info: { id: "msg_a1", role: "assistant" }, parts: [] },
    { info: { id: "msg_p2", role: "user" }, parts: [] },
    { info: { id: "msg_a2", role: "assistant" }, parts: [] },
    { info: { id: "msg_p3", role: "user" }, parts: [] },
    { info: { id: "msg_a3", role: "assistant" }, parts: [] }
  ];
}

test("rollback by turn ID forks at the NAMED turn's prompt, wherever the count points", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.fake.faithfulForks = true;
  // A replayed turn is named by its assistant message (`toThreadSnapshot`).
  // The host drops ONE turn by its count, but a third exchange it never saw
  // (the session went on elsewhere) would put a count-based cut at msg_p3.
  harness.fake.messages = threeExchanges();
  const before = session.sessionId;
  const snapshot = await session.rollbackThread(1, {
    firstRemovedTurnId: "msg_a2",
    droppedTurnIds: ["msg_a2"],
    retainedTurnIds: ["msg_a1"]
  });
  const fork = harness.fake.find("POST", `/session/${before}/fork`);
  assert.equal(
    (fork?.body as { messageID: string }).messageID,
    "msg_p2",
    "the fork lands on the prompt that opens the named turn"
  );
  assert.notEqual(session.sessionId, before, "the fork becomes the thread's session");
  assert.equal(snapshot.turns.length, 1, "exactly the first exchange survives");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a live turn is named by the prompt that opened it, so a rewind finds it again", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  const promptId = (harness.fake.find("POST", "/prompt_async")?.body as { messageID: string })
    .messageID;
  assert.equal(turn.turnId, promptId, "the turn id IS the OpenCode id of its opening prompt");
  assert.equal(firstOfType(harness.events, "turn.started")?.turnId, promptId);
  driveTurn(harness.fake, { sessionId, userMessageId: promptId });
  harness.fake.push({
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: "idle" } }
  });
  await waitFor(harness, "turn.completed");

  // A turn that ran tools wrote several assistant messages; its id still
  // names the one prompt that opened it.
  harness.fake.faithfulForks = true;
  harness.fake.messages = [
    { info: { id: "msg_p0", role: "user" }, parts: [] },
    { info: { id: "msg_a0", role: "assistant" }, parts: [] },
    { info: { id: promptId, role: "user" }, parts: [] },
    { info: { id: "msg_step_1", role: "assistant" }, parts: [] },
    { info: { id: "msg_step_2", role: "assistant" }, parts: [] }
  ];
  await session.rollbackThread(1, {
    firstRemovedTurnId: turn.turnId,
    droppedTurnIds: [turn.turnId],
    retainedTurnIds: ["msg_a0"]
  });
  const fork = harness.fake.find("POST", `/session/${sessionId}/fork`);
  assert.equal((fork?.body as { messageID: string }).messageID, promptId);
  assert.notEqual(session.sessionId, sessionId);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("rollback refuses a turn ID the session no longer holds, before forking anything", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.fake.messages = threeExchanges();
  const before = session.sessionId;
  const requestsBefore = harness.fake.requests.length;
  // Shaped like the ids live turns carried before they were named by their
  // prompt: nothing in OpenCode answers to it.
  const unknown = "opencode-turn-uuid-7";
  await assert.rejects(
    session.rollbackThread(1, {
      firstRemovedTurnId: unknown,
      droppedTurnIds: [unknown],
      retainedTurnIds: ["msg_a1", "msg_a2"]
    }),
    /opencode: the turn to rewind to is no longer in this session/
  );
  assert.deepEqual(
    harness.fake.requests.slice(requestsBefore).filter((request) => request.method !== "GET"),
    [],
    "no fork and no ruleset patch: an unresolvable id is never a count-based guess"
  );
  assert.equal(session.sessionId, before, "a refused rollback must not re-point the thread");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a second rewind finds a turn the first one kept, under the fork's re-minted ids", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.fake.faithfulForks = true;
  harness.fake.messages = threeExchanges();

  // Rewind 1 drops the third exchange; the fork re-mints every id it keeps.
  await session.rollbackThread(1, {
    firstRemovedTurnId: "msg_p3",
    droppedTurnIds: ["msg_p3"],
    retainedTurnIds: ["msg_p1", "msg_p2"]
  });
  const firstFork = session.sessionId;
  const kept = harness.fake.messagesOf(firstFork);
  assert.equal(kept.length, 4);
  assert.ok(
    kept.every((entry) => !entry.info.id.startsWith("msg_")),
    "no pre-fork id survives the fork"
  );

  // Rewind 2 names msg_p2 as the fold still knows it.
  await session.rollbackThread(1, {
    firstRemovedTurnId: "msg_p2",
    droppedTurnIds: ["msg_p2"],
    retainedTurnIds: ["msg_p1"]
  });
  const second = harness.fake.find("POST", `/session/${firstFork}/fork`);
  assert.equal(
    (second?.body as { messageID: string }).messageID,
    kept[2]!.info.id,
    "translated to the first fork's spelling of msg_p2"
  );
  assert.equal(harness.fake.messagesOf(session.sessionId).length, 2, "one exchange left");

  // A turn a rewind already cut stays cut.
  const third = session.sessionId;
  await assert.rejects(
    session.rollbackThread(1, {
      firstRemovedTurnId: "msg_p3",
      droppedTurnIds: ["msg_p3"],
      retainedTurnIds: ["msg_p1"]
    }),
    /opencode: the turn to rewind to is no longer in this session/
  );
  assert.equal(session.sessionId, third);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a dead server settles the turn and the requests BEFORE session.exited", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  harness.fake.push({
    type: "permission.asked",
    properties: { id: "per_1", sessionID: sessionId, permission: "bash", patterns: ["x"] }
  });
  await waitFor(harness, "request.opened");

  harness.killServer();
  await waitFor(harness, "session.exited");

  const order = typesOf(harness.events);
  const exitedAt = order.lastIndexOf("session.exited");
  const turnAt = order.lastIndexOf("turn.completed");
  const requestAt = order.lastIndexOf("request.resolved");
  assert.ok(turnAt >= 0 && turnAt < exitedAt, "a running state never outlives its process");
  assert.ok(requestAt >= 0 && requestAt < exitedAt, "parked requests fail before the exit");
  const exited = firstOfType(harness.events, "session.exited");
  assert.equal(exited?.payload.exitKind, "error");
  assert.equal(exited?.payload.recoverable, true);
  assert.equal(
    firstOfType(harness.events, "turn.completed")?.payload.state,
    "failed",
    "an unexpected death fails the turn"
  );
  harness.dispose();
});

test("a host-initiated stop settles the turn as interrupted and exits gracefully", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "hi",
    attachments: [],
    interactionMode: "default"
  });
  await session.stop({ reason: "tab closed", hostInitiated: true });
  const order = typesOf(harness.events);
  assert.ok(order.lastIndexOf("turn.completed") < order.lastIndexOf("session.exited"));
  const completed = firstOfType(harness.events, "turn.completed");
  assert.equal(completed?.payload.state, "interrupted");
  const exited = firstOfType(harness.events, "session.exited");
  assert.equal(exited?.payload.exitKind, "graceful");
  // Teardown aborts the PARENT first so it cannot spawn a new child.
  const abortIndex = harness.fake.indexOf("POST", "/abort");
  const childrenIndex = harness.fake.indexOf("GET", "/children");
  assert.ok(abortIndex >= 0 && (childrenIndex === -1 || abortIndex < childrenIndex));
  harness.dispose();
});

test("a live subagent is closed `stopped` before session.exited", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  await session.sendTurn({
    threadId: "thread-1",
    input: "delegate it",
    attachments: [],
    interactionMode: "default"
  });
  // The child announces itself with a parentID this thread owns.
  harness.fake.push({
    type: "session.created",
    properties: {
      sessionID: "ses_child",
      info: { id: "ses_child", parentID: sessionId, title: "digging (@explore subagent)" }
    }
  });
  const started = await waitFor(harness, "task.started");
  assert.equal(started.payload.taskId, "ses_child");
  assert.equal(session.hasLiveSubagents(), true);

  await session.stop({ reason: "tab closed", hostInitiated: true });

  const completed = eventsOfType(harness.events, "task.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.payload.status, "stopped");
  const order = typesOf(harness.events);
  assert.ok(
    order.lastIndexOf("task.completed") < order.lastIndexOf("session.exited"),
    "a subagent row must never outlive the process that ran it"
  );
  assert.equal(session.hasLiveSubagents(), false);
  harness.dispose();
});

test("interrupting a turn closes its subagents too", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({
    threadId: "thread-1",
    input: "delegate it",
    attachments: [],
    interactionMode: "default"
  });
  harness.fake.push({
    type: "session.created",
    properties: {
      sessionID: "ses_child",
      info: { id: "ses_child", parentID: sessionId, title: "digging (@explore subagent)" }
    }
  });
  await waitFor(harness, "task.started");

  await session.interruptTurn(turn.turnId);

  const completed = eventsOfType(harness.events, "task.completed");
  assert.equal(completed[0]?.payload.status, "stopped");
  const order = typesOf(harness.events);
  assert.ok(order.lastIndexOf("task.completed") < order.lastIndexOf("turn.aborted"));
  harness.dispose();
});

test("§6.2: an interrupt with NO active turn still stops all background work", async () => {
  // R6 #1: Stop is addressed to the SESSION, not to a turn, and the client
  // omits `turnId` whenever the session is not `running`. Claude and Codex
  // early-returned here; OpenCode aborted provider-side but never closed the
  // roster rows, so `backgroundLiveness` never dropped to null and the UI's
  // Stop stayed on "Stopping…" forever.
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({
    threadId: "thread-1",
    input: "delegate it",
    attachments: [],
    interactionMode: "default"
  });
  const messageId = (harness.fake.find("POST", "/prompt_async")?.body as { messageID: string })
    .messageID;
  harness.fake.push({
    type: "session.created",
    properties: {
      sessionID: "ses_child",
      info: { id: "ses_child", parentID: sessionId, title: "watching (@explore subagent)" }
    }
  });
  await waitFor(harness, "task.started");

  // The turn settles on its own; the subagent keeps running.
  driveTurn(harness.fake, { sessionId, userMessageId: messageId });
  harness.fake.push({
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: "idle" } }
  });
  await waitFor(harness, "turn.completed");
  assert.equal(session.hasLiveSubagents(), true, "the subagent outlived the turn");

  const before = harness.fake.requests.length;
  // Exactly what the client sends when the session is not running: no turnId.
  await session.interruptTurn();

  assert.equal(session.hasLiveSubagents(), false, "background work must be stopped");
  const completed = eventsOfType(harness.events, "task.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.payload.status, "stopped");
  assert.equal(completed[0]?.payload.taskId, "ses_child");
  // It really reached the provider, not just the local roster.
  const aborts = harness.fake.requests
    .slice(before)
    .filter((request) => request.path.endsWith("/abort"));
  assert.ok(aborts.length >= 1, "the session abort is still issued");
  assert.equal(turn.turnId.length > 0, true);
  harness.dispose();
});

test("§6.2: a session-scoped interrupt with nothing live is a clean no-op", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.interruptTurn();
  assert.equal(session.hasLiveSubagents(), false);
  assert.deepEqual(eventsOfType(harness.events, "turn.aborted"), []);
  assert.deepEqual(eventsOfType(harness.events, "task.completed"), []);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("stop is idempotent and emits exactly one session.exited", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.stop({ reason: "a", hostInitiated: true });
  await session.stop({ reason: "b", hostInitiated: true });
  assert.equal(
    eventsOfType(harness.events, "session.exited").length,
    1
  );
  harness.dispose();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("a model slug splits on the FIRST slash, so a nested model id survives", () => {
  assert.deepEqual(parseOpenCodeModelSlug("openrouter/google/gemini-2.5-flash-lite"), {
    providerID: "openrouter",
    modelID: "google/gemini-2.5-flash-lite"
  });
  assert.equal(parseOpenCodeModelSlug("bare-model"), null);
  assert.equal(parseOpenCodeModelSlug("/leading"), null);
  assert.equal(parseOpenCodeModelSlug("trailing/"), null);
  assert.equal(parseOpenCodeModelSlug(undefined), null);
});

test("answers are keyed by question id, header or text, in that order", () => {
  const request = {
    id: "que_1",
    sessionID: "ses_1",
    questions: [
      { question: "Which colour?", header: "Colour Preference", options: [] },
      { question: "How many?", header: "Count", options: [], multiple: true }
    ]
  };
  assert.deepEqual(
    toQuestionAnswers(request, {
      "question-0-colour-preference": "Red",
      Count: ["one", "two"]
    }),
    [["Red"], ["one", "two"]]
  );
  assert.deepEqual(toQuestionAnswers(request, {}), [[], []]);
});

// ---------------------------------------------------------------------------
// Q1 #21 — the ancestry probe is capped, and released
// ---------------------------------------------------------------------------

/**
 * The server is per **project** (§3.2), so this thread's `GET /event` also
 * carries every co-tenant thread's frames. T3 could retry an unresolved
 * `*.asked` ancestry walk forever because its server was per *thread* and a
 * foreign frame could not arrive; here it can, and an uncapped chain meant one
 * live poll per foreign ask for the rest of the session's life, with a map key
 * that was never released.
 */

function probeCount(harness: Harness, sessionId: string): number {
  return harness.fake.requests.filter(
    (request) => request.method === "GET" && request.path === `/session/${sessionId}`
  ).length;
}

/** The chain is driven by real backoff timers, so these tests watch the clock. */
async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make one session id unreadable, **before** the session starts: the client is
 * built with whatever `fetchImpl` the fake holds at that moment.
 */
function failReadsOf(harness: Harness, sessionId: string): void {
  const inner = harness.fake.fetchImpl;
  Object.defineProperty(harness.fake, "fetchImpl", {
    configurable: true,
    value: (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const path = new URL(String(input)).pathname;
      // A 500, deliberately: a 404 is a definitive "not here" and ends the
      // walk, while this is the transient shape that earns a retry.
      if (path === `/session/${sessionId}`) {
        harness.fake.requests.push({ method: init?.method ?? "GET", path });
        return new Response("boom", { status: 500 });
      }
      return await inner(input, init);
    }) as typeof fetch
  });
}

test("Q1 #21: a co-tenant thread's ask is probed ONCE, not polled forever", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  // A session that exists on this shared server and has no parent: the walk
  // completes at a root that is not ours, which is a definitive answer.
  harness.fake.sessions.set("ses_cotenant", { id: "ses_cotenant", directory: "/repo" });

  harness.fake.push({
    type: "permission.asked",
    properties: {
      id: "per_foreign",
      sessionID: "ses_cotenant",
      permission: "bash",
      patterns: ["echo hi"]
    }
  });
  await settle(400);

  assert.equal(probeCount(harness, "ses_cotenant"), 1, "a walked foreign root is not retried");
  // And it never became this thread's card.
  assert.deepEqual(eventsOfType(harness.events, "request.opened"), []);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("Q1 #21: an unreadable session is retried, but the chain is CAPPED", async () => {
  const harness = makeHarness();
  failReadsOf(harness, "ses_unreadable");
  const session = await startSession(harness);

  // A non-`asked` request frame takes the SHORT cap, so the whole chain — with
  // its 250 ms to 4 s backoff — finishes inside this test rather than in 25 s.
  harness.fake.push({
    type: "permission.replied",
    properties: { requestID: "per_unreadable", sessionID: "ses_unreadable", reply: "once" }
  });
  await settle(9_000);

  const probes = probeCount(harness, "ses_unreadable");
  assert.ok(probes > 1, `the unknown outcome is retried (saw ${probes})`);
  assert.ok(probes <= 5, `the chain is capped (saw ${probes})`);

  // Capped means STOPPED, not merely slowed: nothing more arrives afterwards.
  await settle(1_500);
  assert.equal(probeCount(harness, "ses_unreadable"), probes);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("Q1 #21: closing the thread abandons an in-flight ancestry chain", async () => {
  const harness = makeHarness();
  failReadsOf(harness, "ses_gone");
  const session = await startSession(harness);

  harness.fake.push({
    type: "permission.asked",
    properties: { id: "per_gone", sessionID: "ses_gone", permission: "bash", patterns: ["x"] }
  });
  await settle(300);
  const beforeClose = probeCount(harness, "ses_gone");
  assert.ok(beforeClose >= 1);

  await session.stop({ reason: "test", hostInitiated: true });
  await settle(1_500);
  assert.equal(
    probeCount(harness, "ses_gone"),
    beforeClose,
    "a closed session must not keep polling the provider"
  );
  harness.dispose();
});
