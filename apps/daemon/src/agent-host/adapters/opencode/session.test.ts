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

import {
  applyDomainEvent,
  createEmptyThreadState,
  isMessageStreaming,
  messageStreamingContext,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { resumeCursorFor } from "../../orchestration/resume.ts";
import {
  OpenCodeThreadSession,
  parseOpenCodeModelSlug,
  parseOpenCodeResume,
  toQuestionAnswers
} from "./session.ts";
import type { OpenCodeServerHandle } from "./server.ts";
import { OpenCodeClient } from "./http.ts";
import { createHostIngestion } from "./testing/host.ts";
import {
  childLaunch,
  compactionContinues,
  compactionPrompt,
  compactionSummary,
  injectedAnswer,
  runSettles,
  wokenReply
} from "./testing/woken.ts";
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
  /** Overrides keyed by `METHOD path-suffix`; one may hold its answer back. */
  readonly overrides = new Map<string, () => Response | Promise<Response>>();
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** Waiting on the session's next `GET /event` (`nextStream`). */
  private streamWaiters: (() => void)[] = [];
  /** Waiting on a request the session has not sent yet (`waitForRequest`). */
  private requestWaiters: {
    method: string;
    suffix: string;
    arrived: (request: RecordedRequest) => void;
  }[] = [];
  private nextSession = 0;

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const recorded: RecordedRequest = { method, path, ...(body !== undefined ? { body } : {}) };
    this.requests.push(recorded);
    this.requestWaiters = this.requestWaiters.filter((waiter) => {
      if (waiter.method !== method || !path.endsWith(waiter.suffix)) {
        return true;
      }
      waiter.arrived(recorded);
      return false;
    });

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
      // The new stream is the one `push` feeds from here on.
      for (const opened of this.streamWaiters.splice(0)) {
        opened();
      }
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

  /** End the current event stream, as a dropped connection does: the session reconnects. */
  endStream(): void {
    this.controller?.close();
  }

  /** Settles once the session has opened its next event stream. */
  nextStream(): Promise<void> {
    return new Promise((resolve) => {
      this.streamWaiters.push(resolve);
    });
  }

  find(method: string, suffix: string): RecordedRequest | undefined {
    return this.requests.find(
      (request) => request.method === method && request.path.endsWith(suffix)
    );
  }

  /** Settles with the first request matching `method` and `suffix`, one already sent included. */
  waitForRequest(method: string, suffix: string): Promise<RecordedRequest> {
    const sent = this.find(method, suffix);
    if (sent !== undefined) {
      return Promise.resolve(sent);
    }
    return this.nextRequest(method, suffix);
  }

  /** Settles with the next request matching `method` and `suffix` sent from now on. */
  nextRequest(method: string, suffix: string): Promise<RecordedRequest> {
    return new Promise((resolve) => {
      this.requestWaiters.push({ method, suffix, arrived: resolve });
    });
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
    /** The session's wait between attempts; a real timer when absent. */
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {}
): Promise<OpenCodeThreadSession> {
  return await OpenCodeThreadSession.start(
    {
      ctx: harness.ctx,
      emit: harness.emit,
      onClosed: () => undefined,
      ...(options.delay !== undefined ? { delay: options.delay } : {})
    },
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

/**
 * A subagent announcing itself in the order 1.18.5 emits it (fixture 12, lines
 * 141-142): the child's own `session.created`, then the parent's `task` part
 * going `running` and naming it — the frame whose `task.started` carries the
 * launching call.
 */
function announceChild(fake: FakeOpenCode, parentSessionId: string, title: string): void {
  fake.push({
    type: "session.created",
    properties: {
      sessionID: "ses_child",
      info: { id: "ses_child", parentID: parentSessionId, title }
    }
  });
  fake.push({
    type: "message.part.updated",
    properties: {
      sessionID: parentSessionId,
      part: {
        id: "prt_task",
        messageID: "msg_task",
        sessionID: parentSessionId,
        type: "tool",
        tool: "task",
        callID: "call_task",
        state: {
          status: "running",
          title,
          input: { subagent_type: "explore", description: title, prompt: title },
          metadata: { parentSessionId, sessionId: "ses_child" },
          time: { start: 1 }
        }
      }
    }
  });
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

test("an xlsx rides as a path line in the text part; a csv is still a native file part (§4.5)", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "compare these",
    attachments: [
      {
        type: "file",
        id: "att-x",
        name: "q3.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 10
      },
      { type: "file", id: "att-c", name: "rows.csv", mimeType: "text/csv", sizeBytes: 10 }
    ],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.ok(submit !== undefined);
  const body = submit.body as {
    parts: { type: string; text?: string; url?: string; filename?: string }[];
  };
  assert.equal(body.parts.length, 2);
  assert.deepEqual(body.parts[0], {
    type: "text",
    text: "compare these\n\nAttached files:\n- q3.xlsx: /attachments/att-x"
  });
  assert.equal(body.parts[1]?.type, "file");
  assert.equal(body.parts[1]?.filename, "rows.csv");
  assert.equal(body.parts[1]?.url, "file:///attachments/att-c");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("an attachment-only turn with a non-native file no longer throws: the block is the text", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "",
    attachments: [{ type: "file", id: "att-x", name: "q3.xlsx", sizeBytes: 10 }],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  const body = submit?.body as { parts: { type: string; text?: string }[] };
  assert.deepEqual(body.parts, [
    { type: "text", text: "Attached files:\n- q3.xlsx: /attachments/att-x" }
  ]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a text file over the native cap rides as a path line, not a file part (§4.5)", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await session.sendTurn({
    threadId: "thread-1",
    input: "read this",
    attachments: [
      {
        type: "file",
        id: "att-big",
        name: "huge.log",
        mimeType: "text/plain",
        sizeBytes: 20 * 1024 * 1024 + 1
      }
    ],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.ok(submit !== undefined);
  assert.deepEqual((submit.body as { parts: unknown[] }).parts, [
    { type: "text", text: "read this\n\nAttached files:\n- huge.log: /attachments/att-big" }
  ]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a non-native file whose path the text already names adds no block: the text is verbatim", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const input = "compare /attachments/att-x with last quarter";
  await session.sendTurn({
    threadId: "thread-1",
    input,
    attachments: [
      {
        type: "file",
        id: "att-x",
        name: "q3.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 10
      }
    ],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.ok(submit !== undefined);
  assert.deepEqual((submit.body as { parts: unknown[] }).parts, [{ type: "text", text: input }]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("an attachment whose path cannot be resolved fails the turn instead of vanishing", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  harness.ctx.resolveAttachmentPath = async () => {
    throw new Error("agent-chat: attachment not found (removed or expired)");
  };
  await assert.rejects(
    session.sendTurn({
      threadId: "thread-1",
      input: "summarise this",
      attachments: [{ type: "file", id: "att-gone", name: "q3.xlsx", sizeBytes: 10 }],
      interactionMode: "default"
    }),
    /removed or expired/
  );
  assert.equal(harness.fake.find("POST", "/prompt_async"), undefined, "nothing reached the server");
  assert.equal(firstOfType(harness.events, "turn.started"), undefined, "no turn was opened");
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

test("a native command with a non-native file carries the path block in its arguments (§4.5)", async () => {
  const harness = makeHarness();
  harness.fake.commands = [{ name: "fixture", description: "a fixture command", hints: [] }];
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const pending = session.sendTurn({
    threadId: "thread-1",
    input: "/fixture hello there",
    attachments: [
      {
        type: "file",
        id: "att-x",
        name: "q3.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 10
      }
    ],
    interactionMode: "default"
  });
  await waitFor(harness, "turn.started");
  assert.equal(
    harness.fake.find("POST", "/prompt_async"),
    undefined,
    "a native command must not go through prompt_async"
  );
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
  const body = command?.body as { command: string; arguments: string; parts: unknown[] };
  assert.equal(body.command, "fixture");
  // The command match runs on the APPENDED text, so the block rides `$ARGUMENTS`
  // — after the typed arguments, never before them (§4.6.9).
  assert.equal(body.arguments, "hello there\n\nAttached files:\n- q3.xlsx: /attachments/att-x");
  assert.deepEqual(body.parts, [], "a non-native file is never a file part");
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
  announceChild(harness.fake, sessionId, "digging (@explore subagent)");
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

test("a child session's question rides no turn, and so does its answer; the parent's own ride its turn", async () => {
  // Codex's and Grok's `questionTurnId` rule: a turn's end dismisses every
  // question on it in the log only (`settleStrandedQuestions`), and a
  // background child outlives the parent's turn — riding it, the child's card
  // was swept at the parent's turn end while the child still waited on it.
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({
    threadId: "thread-1",
    input: "delegate it",
    attachments: [],
    interactionMode: "default"
  });
  announceChild(harness.fake, sessionId, "digging (@explore subagent)");
  await waitFor(harness, "task.started");
  harness.fake.push({
    type: "question.asked",
    properties: {
      id: "que_child",
      sessionID: "ses_child",
      questions: [{ question: "Which file?", header: "File", options: [{ label: "a.ts" }] }]
    }
  });
  harness.fake.push({
    type: "question.asked",
    properties: {
      id: "que_parent",
      sessionID: sessionId,
      questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes" }] }]
    }
  });
  const child = await waitFor(harness, "user-input.requested", (event) => event.requestId === "que_child");
  const parent = await waitFor(harness, "user-input.requested", (event) => event.requestId === "que_parent");
  assert.equal(child.turnId, undefined, "the child's question rides no turn");
  assert.equal(parent.turnId, turn.turnId, "the parent's own question rides its turn");

  await session.respondToUserInput("que_child", { "question-0-file": "a.ts" });
  await session.respondToUserInput("que_parent", { "question-0-proceed": "Yes" });
  const answers = eventsOfType(harness.events, "user-input.resolved");
  const childAnswer = answers.find((event) => event.requestId === "que_child");
  const parentAnswer = answers.find((event) => event.requestId === "que_parent");
  assert.ok(childAnswer !== undefined && parentAnswer !== undefined);
  assert.equal(childAnswer.turnId, undefined, "its answer rides the same: none");
  assert.equal(parentAnswer.turnId, turn.turnId);
  await session.stop({ reason: "test", hostInitiated: true });
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
  announceChild(harness.fake, sessionId, "digging (@explore subagent)");
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
  announceChild(harness.fake, sessionId, "watching (@explore subagent)");
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
// A background answer wakes the parent (fixtures README observation 27)
// ---------------------------------------------------------------------------

/** Push `frames`, in order, onto the session's stream. */
function pushAll(fake: FakeOpenCode, frames: readonly unknown[]): void {
  for (const frame of frames) {
    fake.push(frame);
  }
}

/**
 * A frame whose event proves the ones pushed before it were handled — the
 * stream is one ordered queue — so a test can assert what did NOT happen
 * without waiting on a clock.
 */
async function drainedWith(harness: Harness, sessionId: string, title: string): Promise<void> {
  harness.fake.push({
    type: "session.updated",
    properties: { sessionID: sessionId, info: { id: sessionId, title } }
  });
  await waitFor(
    harness,
    "thread.metadata.updated",
    (event) => (event as Extract<RuntimeEvent, { type: "thread.metadata.updated" }>).payload.name === title
  );
}

/** The reply a background answer wakes the parent into, answering the prompt `msg_injected`. */
const FIRST = { promptId: "msg_injected", replyId: "msg_woken", text: "The child found README.md." };

/** The parent at rest, then a background answer woken into its reply: the turn opened, the reply streaming. */
async function wokenMidReply(harness: Harness): Promise<{ session: OpenCodeThreadSession; sessionId: string }> {
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins,
    ...reply.streams
  ]);
  await waitFor(harness, "content.delta");
  assert.deepEqual(
    eventsOfType(harness.events, "turn.started").map((event) => event.turnId),
    [FIRST.promptId],
    "the reply opened a turn, named by the prompt it answers"
  );
  return { session, sessionId };
}

test("a background answer wakes the parent: its reply runs as a turn named by the injected prompt, and the run's idle settles it", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await wokenMidReply(harness);

  const started = eventsOfType(harness.events, "turn.started");
  assert.deepEqual(started.map((event) => event.turnId), ["msg_injected"]);
  const order = typesOf(harness.events);
  assert.ok(order.indexOf("turn.started") < order.indexOf("content.delta"), "the turn opens before any row of the reply");
  assert.deepEqual(
    [session.session.status, session.session.activeTurnId],
    ["running", "msg_injected"],
    "the session reads running while the reply streams"
  );

  pushAll(harness.fake, [...wokenReply({ sessionId, ...FIRST }).ends, ...runSettles(sessionId)]);
  const completed = await waitFor(harness, "turn.completed");
  assert.equal(completed.turnId, "msg_injected");
  assert.equal(completed.payload.state, "completed");
  // input + cache.read + cache.write; output + reasoning — the reply's own step.
  assert.equal(completed.payload.tokenUsage?.usageStatus, "complete");
  assert.equal(completed.payload.tokenUsage?.inputTokens, 1_346 + 42_514);
  assert.equal(completed.payload.tokenUsage?.outputTokens, 13 + 77);
  for (const event of harness.events) {
    if (event.type === "content.delta" || event.type === "item.completed" || event.type === "thread.token-usage.updated") {
      assert.equal(event.turnId, "msg_injected", `${event.type} rides the woken turn`);
    }
  }
  assert.deepEqual([session.session.status, session.session.activeTurnId], ["ready", undefined]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a session.error during the woken reply fails its turn, as it fails any", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await wokenMidReply(harness);
  harness.fake.push({
    type: "session.error",
    properties: { sessionID: sessionId, error: { name: "UnknownError", data: { message: "Rate limit exceeded" } } }
  });
  const completed = await waitFor(harness, "turn.completed");
  assert.deepEqual(
    [completed.turnId, completed.payload.state, completed.payload.errorMessage],
    ["msg_injected", "failed", "Rate limit exceeded"]
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("the user's message during the woken reply steers it: one turn, which the run's idle ends", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await wokenMidReply(harness);

  const steer = await session.sendTurn({
    threadId: "thread-1",
    input: "check b.ts too",
    attachments: [],
    interactionMode: "default"
  });
  assert.equal(steer.turnId, "msg_injected", "the server queues it into the same run");
  const messageId = (harness.fake.find("POST", "/prompt_async")?.body as { messageID: string }).messageID;
  // Its user message, then — after the first reply ends — the reply to it, in the same run.
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: messageId, role: "user", sessionID: sessionId } } },
    ...wokenReply({ sessionId, ...FIRST }).ends
  ]);
  const second = wokenReply({ sessionId, promptId: messageId, replyId: "msg_steered", text: "b.ts is there too." });
  pushAll(harness.fake, [...second.begins, ...second.streams, ...second.ends, ...runSettles(sessionId)]);

  const completed = await waitFor(harness, "turn.completed");
  assert.equal(completed.turnId, "msg_injected");
  assert.equal(completed.payload.state, "completed");
  assert.deepEqual(eventsOfType(harness.events, "turn.started").map((event) => event.turnId), ["msg_injected"]);
  assert.equal(completed.payload.tokenUsage?.inputTokens, 2 * (1_346 + 42_514), "both replies' steps are the turn's");
  assert.equal(
    eventsOfType(harness.events, "content.delta").filter((event) => event.turnId === "msg_injected").length,
    2
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a second answer that arrives while the woken reply runs joins its turn: one turn, one completion", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await wokenMidReply(harness);
  const second = wokenReply({ sessionId, promptId: "msg_injected_2", replyId: "msg_woken_2", text: "And a.ts." });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: "msg_injected_2", childId: "ses_child_2", answer: "Found a.ts." }),
    ...wokenReply({ sessionId, ...FIRST }).ends,
    ...second.begins,
    ...second.streams,
    ...second.ends,
    ...runSettles(sessionId)
  ]);
  const completed = await waitFor(harness, "turn.completed");
  assert.equal(completed.turnId, "msg_injected");
  assert.deepEqual(eventsOfType(harness.events, "turn.started").map((event) => event.turnId), ["msg_injected"]);
  assert.equal(eventsOfType(harness.events, "turn.completed").length, 1);
  assert.equal(completed.payload.tokenUsage?.inputTokens, 2 * (1_346 + 42_514));
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a Stop during the woken reply aborts its turn, and what the aborted run still sends opens nothing", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await wokenMidReply(harness);

  await session.interruptTurn("msg_injected");
  const aborted = firstOfType(harness.events, "turn.aborted");
  assert.equal(aborted?.turnId, "msg_injected");
  assert.ok(harness.fake.find("POST", `/session/${sessionId}/abort`) !== undefined, "the run is aborted provider-side");
  assert.deepEqual([session.session.status, session.session.activeTurnId], ["ready", undefined]);

  // The aborted reply's own end, then a reply to another prompt the server wrote: nothing reopens.
  pushAll(harness.fake, [
    ...wokenReply({ sessionId, ...FIRST }).ends,
    ...wokenReply({ sessionId, promptId: "msg_late_answer", replyId: "msg_late", text: "late" }).begins
  ]);
  await drainedWith(harness, sessionId, "after the stop");
  assert.deepEqual(eventsOfType(harness.events, "turn.started").map((event) => event.turnId), ["msg_injected"]);
  assert.equal(session.session.activeTurnId, undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a Stop's leftovers end once a later turn fails: a background answer after it still wakes the parent into a turn", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  // A turn the user stops…
  const stopped = await session.sendTurn({ threadId: "thread-1", input: "one", attachments: [], interactionMode: "default" });
  await session.interruptTurn(stopped.turnId);
  // …then a later one that launches a background task and fails: a rate limit.
  const failing = await session.sendTurn({ threadId: "thread-1", input: "two", attachments: [], interactionMode: "default" });
  const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
    messageID: string;
  }).messageID;
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: "msg_two", role: "assistant", parentID: promptId, sessionID: sessionId } } },
    {
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429, isRetryable: true } }
      }
    }
  ]);
  const failed = await waitFor(harness, "turn.completed", (event) => event.turnId === failing.turnId);
  assert.equal((failed as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "failed");

  // The job outlives the failed turn, and its answer wakes the parent.
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins,
    ...reply.streams,
    ...reply.ends,
    ...runSettles(sessionId)
  ]);
  await drainedWith(harness, sessionId, "after the wake");
  assert.deepEqual(
    eventsOfType(harness.events, "turn.completed")
      .filter((event) => event.turnId === FIRST.promptId)
      .map((event) => event.payload.state),
    ["completed"],
    "the woken reply ran as a turn, and settled"
  );
  assert.ok(
    eventsOfType(harness.events, "content.delta").some((event) => event.turnId === FIRST.promptId),
    "the woken reply is written, on its own turn"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

/**
 * A turn that launched children, then failed on a rate limit: its user
 * message, its run, the launches, the provider's error.
 */
async function turnFailsAfterLaunching(
  harness: Harness,
  session: OpenCodeThreadSession,
  launches: readonly { childId: string; callId: string; description: string; background: boolean }[]
): Promise<string> {
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
    messageID: string;
  }).messageID;
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: "msg_delegating", role: "assistant", parentID: promptId, sessionID: sessionId } } },
    ...launches.flatMap((launch) => childLaunch({ sessionId, ...launch }))
  ]);
  await waitFor(harness, "task.started", (event) => event.agentId === launches.at(-1)?.childId);
  harness.fake.push({
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429, isRetryable: true } }
    }
  });
  await waitFor(harness, "turn.completed", (event) => event.turnId === turn.turnId);
  return turn.turnId;
}

/** Each task's terminal rows, as `taskId:status[:summary]`. */
function taskEnds(events: readonly RuntimeEvent[]): string[] {
  return eventsOfType(events, "task.completed").map((event) =>
    [event.payload.taskId, event.payload.status, ...(event.payload.summary !== undefined ? [event.payload.summary] : [])].join(":")
  );
}

/**
 * One turn of the event loop: whatever the session queued — a promise chain
 * with nothing left to wait on, the fake server's answers — has run. How a
 * test that asserts something did NOT happen gets there without a clock.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Rewind the thread past `turnId`, the turn its session's first prompt opened:
 * the fork keeps nothing before it. `children` is what `GET …/children`
 * answers for the source session.
 */
async function rewindPast(
  harness: Harness,
  session: OpenCodeThreadSession,
  turnId: string,
  children: { id: string }[]
): Promise<void> {
  harness.fake.faithfulForks = true;
  harness.fake.messages = [
    { info: { id: turnId, role: "user" }, parts: [] },
    { info: { id: "msg_turn_reply", role: "assistant" }, parts: [] }
  ];
  harness.fake.children = children;
  await session.rollbackThread(1, { firstRemovedTurnId: turnId, droppedTurnIds: [turnId], retainedTurnIds: [] });
}

/**
 * The roster once the host appends the rewind's `thread.reverted` (keeping no
 * turn), in both orders it can land in against the rewind's own rows: after
 * them, or — the host appends it once `rollbackThread` resolved, while the
 * adapter's rows still reach the log through ingestion — before them.
 */
function rostersAfterRevert(before: readonly DomainEvent[], after: readonly DomainEvent[]): string[][] {
  const reverted = (seq: number): DomainEvent => ({
    seq,
    eventId: "reverted",
    threadId: "thread-1",
    occurredAt: "2026-09-21T11:00:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.reverted",
    payload: { turnCount: 0 }
  });
  const rowsOf = (log: DomainEvent[]): string[] =>
    log.reduce(applyDomainEvent, createEmptyThreadState()).roster.map((row) => `${row.id}:${row.status}`);
  const revertLast = [...after, reverted(after.length + 1)];
  const revertFirst = [
    ...before,
    reverted(before.length + 1),
    ...after.slice(before.length).map((event, index) => ({ ...event, seq: before.length + 2 + index }) as DomainEvent)
  ];
  return [rowsOf(revertLast), rowsOf(revertFirst)];
}

/** The child's running call as 1.18.32's cleanup closes it when an abort cuts it (README observation 29). */
function childCallCut(childId: string): unknown {
  const frame = JSON.parse(JSON.stringify(childCall(childId))) as { properties: { part: { state: unknown } } };
  frame.properties.part.state = {
    status: "error",
    error: "Tool execution aborted",
    metadata: { interrupted: true },
    time: { start: 1, end: 2 }
  };
  return frame;
}

/** Every event after `from` that names `agentId` as its task or its owner. */
function rowsOfAgent(events: readonly RuntimeEvent[], from: number, agentId: string): RuntimeEvent[] {
  return events
    .slice(from)
    .filter(
      (event) =>
        event.agentId === agentId || (event.payload as { taskId?: string } | undefined)?.taskId === agentId
    );
}

test("a rewind ends a relaunched child the fork leaves behind: aborted, its call and then its run closed, and nothing of it comes back", async () => {
  // Probe PY: a child a Stop closed and the server's word relaunched — its
  // relaunch start rides no turn, so no rewind drops it — then a rewind past
  // the turn that launched it.
  const harness = makeHarness();
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const { session, sessionId } = await stoppedWithChild(harness);
  const launchTurn = firstOfType(harness.events, "turn.started")!.turnId!;
  const revival = nextStartOf(harness, "ses_bg");
  pushAll(harness.fake, [...childStreams("ses_bg", "a.ts"), childCall("ses_bg")]);
  assert.equal((await revival).turnId, undefined, "relaunched between turns");
  await drainedWith(harness, sessionId, "after the relaunch");
  assert.equal(livenessOf(harness).liveness("thread-1"), "working");

  const host = createHostIngestion();
  await host.ingest(harness.events);
  const before = host.log();
  const fed = harness.events.length;
  const requestsBefore = harness.fake.requests.length;
  // The child's abort ends its run on the server, which says so on the
  // stream — by then a session the thread has left.
  harness.fake.overrides.set("POST /session/ses_bg/abort", async () => {
    pushAll(harness.fake, [
      { type: "session.error", properties: { sessionID: "ses_bg", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } },
      childCallCut("ses_bg"),
      ...runSettles("ses_bg")
    ]);
    await drainedWith(harness, session.sessionId, "as the child's abort answers");
    return json(true);
  });
  await rewindPast(harness, session, launchTurn, [{ id: "ses_bg" }]);
  const rewound = harness.events.slice(fed);

  assert.deepEqual(
    rewound
      .filter((event) => event.type === "item.completed" || event.type === "task.completed")
      .map((event) =>
        event.type === "item.completed"
          ? `call:${event.itemId}:${event.payload.status}:${event.payload.detail}`
          : `task:${(event as Extract<RuntimeEvent, { type: "task.completed" }>).payload.taskId}:${event.payload.status}:${event.payload.summary}`
      ),
    ["call:call_child_ls:failed:Stopped by a rewind.", "task:ses_bg:stopped:Stopped by a rewind."],
    "its open call first, then its run, each saying why"
  );
  assert.deepEqual(
    harness.fake.requests
      .slice(requestsBefore)
      .filter((request) => request.method === "POST" && request.path.endsWith("/abort"))
      .map((request) => request.path),
    [`/session/${sessionId}/abort`, "/session/ses_bg/abort"],
    "the source session, then every child, aborted on the server"
  );
  assert.equal(livenessOf(harness).liveness("thread-1"), null, "the drain is released");
  await host.ingest(rewound);
  assert.deepEqual(
    rostersAfterRevert(before, host.log()),
    [["ses_bg:interrupted"], ["ses_bg:interrupted"]],
    "stopped, whichever of the host's revert and the rewind's rows lands first"
  );

  // Nothing of it comes back: a later Stop closes nothing, and its own end,
  // late, is a frame of a session the thread left behind.
  const after = harness.events.length;
  await session.interruptTurn();
  pushAll(harness.fake, runSettles("ses_bg"));
  await drainedWith(harness, session.sessionId, "after its late end");
  assert.deepEqual(rowsOfAgent(harness.events, after, "ses_bg"), []);
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a rewind ends a background child still running between turns: aborted, closed, and the drain released", async () => {
  // Probe PR: no Stop at all — a child launched in the background outlives
  // its turn, and the thread is rewound while it works.
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: turn.turnId, role: "user", sessionID: sessionId } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    ...childLaunch({ sessionId, childId: "ses_bg", callId: "call_bg", description: "list files", background: true }),
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: sessionId } }
  ]);
  await waitFor(harness, "turn.completed", (event) => event.turnId === turn.turnId);
  // One call finished, one still running.
  const finished = JSON.parse(JSON.stringify(childCall("ses_bg"))) as { properties: { part: Record<string, unknown> } };
  finished.properties.part = {
    ...finished.properties.part,
    id: "prt_child_done",
    callID: "call_child_done",
    state: { status: "completed", title: "pwd", input: { command: "pwd" }, output: "/repo\n", metadata: { output: "/repo\n" }, time: { start: 1, end: 2 } }
  };
  pushAll(harness.fake, [
    { type: "session.status", properties: { sessionID: "ses_bg", status: { type: "busy" } } },
    finished,
    childCall("ses_bg")
  ]);
  await drainedWith(harness, sessionId, "while it works");
  assert.equal(livenessOf(harness).liveness("thread-1"), "working");

  const host = createHostIngestion();
  await host.ingest(harness.events);
  const before = host.log();
  const fed = harness.events.length;
  await rewindPast(harness, session, turn.turnId, [{ id: "ses_bg" }]);
  const rewound = harness.events.slice(fed);
  assert.deepEqual(
    rewound
      .filter((event) => event.type === "item.completed" || event.type === "task.completed")
      .map((event) => `${event.type}:${event.itemId ?? (event.payload as { taskId?: string }).taskId}:${event.payload.status}`),
    ["item.completed:call_child_ls:failed", "task.completed:ses_bg:stopped"],
    "the call it finished is not closed again"
  );
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  await host.ingest(rewound);
  assert.deepEqual(rostersAfterRevert(before, host.log()), [["ses_bg:interrupted"], ["ses_bg:interrupted"]]);

  const after = harness.events.length;
  pushAll(harness.fake, runSettles("ses_bg"));
  await drainedWith(harness, session.sessionId, "after its late end");
  assert.deepEqual(rowsOfAgent(harness.events, after, "ses_bg"), []);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a child whose abort frames beat the Stop's own close ends stopped — its own abort error, or its call's cleanup — never failed", async () => {
  for (const first of ["its abort error", "its call's cleanup"] as const) {
    const harness = makeHarness();
    const session = await startSession(harness);
    const sessionId = session.sessionId;
    const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
    const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
      messageID: string;
    }).messageID;
    const [created, running] = childLaunch({ sessionId, childId: "ses_fg", callId: "call_fg", description: "list files", background: false });
    assert.ok(created && running);
    pushAll(harness.fake, [
      { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
      created,
      running,
      { type: "session.status", properties: { sessionID: "ses_fg", status: { type: "busy" } } }
    ]);
    await waitFor(harness, "task.started", (event) => event.agentId === "ses_fg");

    // The server cancels the child while it answers the abort: its frame
    // reaches the stream before the Stop closes anything.
    const cut = JSON.parse(JSON.stringify(running)) as { properties: { part: { state: Record<string, unknown> } } };
    cut.properties.part.state = {
      ...cut.properties.part.state,
      status: "error",
      error: "Tool execution aborted",
      metadata: { ...(cut.properties.part.state.metadata as Record<string, unknown>), interrupted: true }
    };
    harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
      harness.fake.push(
        first === "its abort error"
          ? { type: "session.error", properties: { sessionID: "ses_fg", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }
          : cut
      );
      await drainedWith(harness, sessionId, "during the abort");
      return json(true);
    });
    await session.interruptTurn(turn.turnId);
    assert.deepEqual(
      taskEnds(harness.events),
      [first === "its abort error" ? "ses_fg:stopped:Aborted" : "ses_fg:stopped:Tool execution aborted"],
      `${first}: one end, stopped — the Stop's close found it ended`
    );
    await session.stop({ reason: "test", hostInitiated: true });
    harness.dispose();
  }
});

test("a background child outlives its launching turn's failure — running in the roster and in liveness — and ends by its own idle and answer", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  await turnFailsAfterLaunching(harness, session, [
    { childId: "ses_bg", callId: "call_bg", description: "list files", background: true }
  ]);

  // 1.18.32 keeps the job running: nothing but a cancel ends it.
  assert.deepEqual(taskEnds(harness.events), [], "the failed turn closes no background run");
  assert.equal(session.hasLiveSubagents(), true);
  const liveness = createLivenessRegistry({ clock: harness.ctx.clock });
  for (const event of harness.events) liveness.observe(event);
  assert.equal(liveness.liveness("thread-1"), "working", "it holds a deploy's drain");
  const host = createHostIngestion();
  await host.ingest(harness.events);
  const afterFailure = host.fold();
  assert.equal(afterFailure.turns.at(-1)?.state, "failed");
  assert.equal(afterFailure.head?.session.status, "ready", "the session lives on: the failure was the turn's");
  assert.deepEqual(
    afterFailure.roster.map((row) => [row.id, row.status]),
    [["ses_bg", "running"]],
    "the roster reads it working, never interrupted"
  );

  // Its run ends, its answer wakes the parent, and the reply runs as a turn.
  const fed = harness.events.length;
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...runSettles("ses_bg"),
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_bg", answer: "Found README.md.", description: "list files" }),
    ...reply.begins,
    ...reply.streams,
    ...reply.ends,
    ...runSettles(sessionId)
  ]);
  const woken = await waitFor(harness, "turn.completed", (event) => event.turnId === FIRST.promptId);
  assert.equal(woken.payload.state, "completed");
  assert.deepEqual(taskEnds(harness.events), ["ses_bg:completed", "ses_bg:completed:Found README.md."]);
  for (const event of harness.events.slice(fed)) liveness.observe(event);
  assert.equal(liveness.liveness("thread-1"), null);
  await host.ingest(harness.events.slice(fed));
  const end = host.fold();
  const child = end.roster.find((row) => row.id === "ses_bg");
  assert.deepEqual([child?.status, child?.result], ["completed", "Found README.md."]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a foreground child of a failed turn is still closed stopped", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  await turnFailsAfterLaunching(harness, session, [
    { childId: "ses_fg", callId: "call_fg", description: "read the code", background: false }
  ]);
  assert.deepEqual(taskEnds(harness.events), ["ses_fg:stopped:Rate limit exceeded"]);
  assert.equal(session.hasLiveSubagents(), false);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a Stop closes every child — a background one too: the abort cancels its job", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  pushAll(harness.fake, [
    ...childLaunch({ sessionId, childId: "ses_bg", callId: "call_bg", description: "list files", background: true }),
    ...childLaunch({ sessionId, childId: "ses_fg", callId: "call_fg", description: "read the code", background: false })
  ]);
  await waitFor(harness, "task.started", (event) => event.agentId === "ses_fg");
  await session.interruptTurn(turn.turnId);
  assert.deepEqual(taskEnds(harness.events).sort(), ["ses_bg:stopped:interrupted", "ses_fg:stopped:interrupted"]);
  assert.equal(session.hasLiveSubagents(), false);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// A child the Stop closed that runs on (README observation 29)
// ---------------------------------------------------------------------------

/** A background child launched in a turn, then the user's Stop, which closes it. */
async function stoppedWithChild(harness: Harness): Promise<{ session: OpenCodeThreadSession; sessionId: string }> {
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
    messageID: string;
  }).messageID;
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    ...childLaunch({ sessionId, childId: "ses_bg", callId: "call_bg", description: "list files", background: true })
  ]);
  await waitFor(harness, "task.started", (event) => event.agentId === "ses_bg");
  await session.interruptTurn(turn.turnId);
  assert.deepEqual(taskEnds(harness.events), ["ses_bg:stopped:interrupted"], "the Stop closed it, on the adapter's word");
  return { session, sessionId };
}

/** The child's reply streaming: its assistant message, a text part, a delta. */
function childStreams(childId: string, text: string): unknown[] {
  return [
    { type: "message.updated", properties: { sessionID: childId, info: { id: "msg_child_reply", role: "assistant", sessionID: childId } } },
    {
      type: "message.part.updated",
      properties: { sessionID: childId, part: { id: "prt_child_text", messageID: "msg_child_reply", sessionID: childId, type: "text", text: "", time: { start: 1 } } }
    },
    { type: "message.part.delta", properties: { sessionID: childId, messageID: "msg_child_reply", partID: "prt_child_text", field: "text", delta: text } }
  ];
}

/** The next `task.started` for `agentId` the session emits from now on — none before counts. */
function nextStartOf(harness: Harness, agentId: string): Promise<Extract<RuntimeEvent, { type: "task.started" }>> {
  const earlier = new Set<RuntimeEvent>(harness.events);
  return waitFor(harness, "task.started", (event) => event.agentId === agentId && !earlier.has(event));
}

/** The liveness registry the host keeps, fed every event the session emitted. */
function livenessOf(harness: Harness): ReturnType<typeof createLivenessRegistry> {
  const liveness = createLivenessRegistry({ clock: harness.ctx.clock });
  for (const event of harness.events) liveness.observe(event);
  return liveness;
}

/** A running call of the child's, as a `bash` part reports it. */
function childCall(childId: string): unknown {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: childId,
      part: {
        id: "prt_child_tool",
        messageID: "msg_child_reply",
        sessionID: childId,
        type: "tool",
        tool: "bash",
        callID: "call_child_ls",
        state: { status: "running", title: "ls", input: { command: "ls" }, metadata: { output: "" }, time: { start: 1 } }
      }
    }
  };
}

test("a child that survives the Stop is relaunched on the server's word: the roster reads it running, then completed with its own answer", async () => {
  const harness = makeHarness();
  // The abort never reaches it (a `task_id` extension's run, a job started
  // after the abort listed the jobs): the server still runs it after.
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const { session, sessionId } = await stoppedWithChild(harness);
  assert.equal(livenessOf(harness).liveness("thread-1"), null, "closed, it held no drain");
  const host = createHostIngestion();
  await host.ingest(harness.events);
  assert.equal(host.fold().roster.find((row) => row.id === "ses_bg")?.status, "interrupted", "the Stop's own end");
  assert.equal(
    host.fold().head?.session.status,
    "ready",
    "the Stop ended a turn, not the session: live, so the roster can read a run in it and the host takes the next Stop"
  );

  let fed = harness.events.length;
  const revival = nextStartOf(harness, "ses_bg");
  pushAll(harness.fake, childStreams("ses_bg", "a.ts, README.md"));
  const revived = await revival;
  assert.equal(
    revived.payload.toolUseId,
    "opencode-revive:call_bg:1",
    "a NEW launch id: the relaunch contract, which reopens the roster's row"
  );
  assert.equal(session.hasLiveSubagents(), true, "back in the adapter's live set: a Stop or the exit closes it");
  assert.equal(livenessOf(harness).liveness("thread-1"), "working", "it holds a deploy's drain again");
  await host.ingest(harness.events.slice(fed));
  const running = host.fold().roster.find((row) => row.id === "ses_bg");
  assert.deepEqual(
    [running?.status, running?.result],
    ["running", null],
    "running again, and nothing of the Stop's end — its summary included — on the reopened run"
  );

  // Its run calls a tool, ends, and its answer reaches the parent (the Stop's
  // leftovers still linger there: no new run has said busy).
  fed = harness.events.length;
  pushAll(harness.fake, [
    childCall("ses_bg"),
    ...runSettles("ses_bg"),
    ...injectedAnswer({ sessionId, promptId: "msg_answer", childId: "ses_bg", answer: "Found README.md.", description: "list files" })
  ]);
  await waitFor(harness, "task.completed", (event) => {
    const completed = event as Extract<RuntimeEvent, { type: "task.completed" }>;
    return completed.payload.taskId === "ses_bg" && completed.payload.summary === "Found README.md.";
  });
  assert.deepEqual(taskEnds(harness.events.slice(fed)), ["ses_bg:completed", "ses_bg:completed:Found README.md."], "one end, one result");
  for (const event of harness.events.slice(fed).filter((event) => event.type.startsWith("task."))) {
    assert.equal(
      (event.payload as { toolUseId?: string }).toolUseId,
      "opencode-revive:call_bg:1",
      `${event.type} names the reopened run's launch`
    );
  }
  assert.equal(livenessOf(harness).liveness("thread-1"), null, "its own end drops it");
  await host.ingest(harness.events.slice(fed));
  const end = host.fold().roster.find((row) => row.id === "ses_bg");
  assert.deepEqual([end?.status, end?.result], ["completed", "Found README.md."]);
  await session.stop({ reason: "test", hostInitiated: true });
  assert.deepEqual(taskEnds(harness.events).filter((row) => row.endsWith(":stopped:test")), [], "a finished run is not closed again");
  harness.dispose();
});

test("a second Stop closes a relaunched child, and a confirmed report relaunches it again under its next id", async () => {
  const harness = makeHarness();
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const { session } = await stoppedWithChild(harness);
  const first = nextStartOf(harness, "ses_bg");
  pushAll(harness.fake, childStreams("ses_bg", "a.ts"));
  assert.equal((await first).payload.toolUseId, "opencode-revive:call_bg:1");

  // The second Stop reaches nothing either: the server still runs it.
  const fed = harness.events.length;
  await session.interruptTurn();
  assert.deepEqual(taskEnds(harness.events.slice(fed)), ["ses_bg:stopped:interrupted"], "the relaunched run is in the live set: the Stop closes it");
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  const host = createHostIngestion();
  await host.ingest(harness.events);
  const ingested = harness.events.length;
  assert.equal(host.fold().roster.find((row) => row.id === "ses_bg")?.status, "interrupted");

  const second = nextStartOf(harness, "ses_bg");
  pushAll(harness.fake, [childCall("ses_bg")]);
  assert.equal((await second).payload.toolUseId, "opencode-revive:call_bg:2", "each relaunch its own id");
  await host.ingest(harness.events.slice(ingested));
  assert.equal(host.fold().roster.find((row) => row.id === "ses_bg")?.status, "running");
  assert.equal(livenessOf(harness).liveness("thread-1"), "working");
  await session.stop({ reason: "tab closed", hostInitiated: true });
  assert.deepEqual(
    taskEnds(harness.events).filter((row) => row.startsWith("ses_bg:stopped")),
    ["ses_bg:stopped:interrupted", "ses_bg:stopped:interrupted", "ses_bg:stopped:tab closed"],
    "and the exit closes the run in progress, as any"
  );
  harness.dispose();
});

test("a NESTED subagent that survives the Stop is relaunched too: its first start names its call, and it reads running, then completed with its own answer", async () => {
  const harness = makeHarness();
  harness.fake.statusMap = { ses_gc: { type: "busy" } };
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
    messageID: string;
  }).messageID;
  // The child launches a grandchild of its own, in the background: the
  // grandchild's `session.created`, then the CHILD's own `task` part.
  const grandchildStart = nextStartOf(harness, "ses_gc");
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    ...childLaunch({ sessionId, childId: "ses_bg", callId: "call_bg", description: "list files", background: true }),
    ...childLaunch({ sessionId: "ses_bg", childId: "ses_gc", callId: "call_gc", description: "dig deeper", background: true })
  ]);
  const first = await grandchildStart;
  assert.equal(first.payload.toolUseId, "call_gc", "its FIRST start names a launch: the child's own call");
  assert.equal(first.payload.parentAgentId, "ses_bg");
  await session.interruptTurn(turn.turnId);
  assert.deepEqual(taskEnds(harness.events).sort(), ["ses_bg:stopped:interrupted", "ses_gc:stopped:interrupted"]);

  const host = createHostIngestion();
  let fed = harness.events.length;
  await host.ingest(harness.events);
  const revival = nextStartOf(harness, "ses_gc");
  pushAll(harness.fake, childStreams("ses_gc", "found it"));
  assert.equal((await revival).payload.toolUseId, "opencode-revive:call_gc:1");
  await host.ingest(harness.events.slice(fed));
  fed = harness.events.length;
  assert.equal(host.fold().roster.find((row) => row.id === "ses_gc")?.status, "running", "reopened");
  assert.equal(livenessOf(harness).liveness("thread-1"), "working");

  // Its run ends, and its answer is prompted into the child that launched it.
  pushAll(harness.fake, [
    ...runSettles("ses_gc"),
    ...injectedAnswer({ sessionId: "ses_bg", promptId: "msg_gc_answer", childId: "ses_gc", answer: "Deep answer.", description: "dig deeper" })
  ]);
  await waitFor(harness, "task.completed", (event) => {
    const completed = event as Extract<RuntimeEvent, { type: "task.completed" }>;
    return completed.payload.taskId === "ses_gc" && completed.payload.summary === "Deep answer.";
  });
  await host.ingest(harness.events.slice(fed));
  const end = host.fold().roster.find((row) => row.id === "ses_gc");
  assert.deepEqual([end?.status, end?.result], ["completed", "Deep answer."]);
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a failed admission a relaunched child holds the drain, but reads interrupted: that session reads error, which the roster takes for dead", async () => {
  const harness = makeHarness();
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const session = await startSession(harness, { delay: async () => undefined });
  const sessionId = session.sessionId;
  // The prompt's message never shows: machine (3) fails the turn and aborts,
  // closing the child the turn launched.
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  pushAll(harness.fake, childLaunch({ sessionId, childId: "ses_bg", callId: "call_bg", description: "list files", background: true }));
  await waitFor(harness, "turn.completed", (event) => event.turnId === turn.turnId);
  assert.deepEqual(taskEnds(harness.events).map((row) => row.split(":").slice(0, 2).join(":")), ["ses_bg:stopped"]);

  const revival = nextStartOf(harness, "ses_bg");
  pushAll(harness.fake, childStreams("ses_bg", "a.ts"));
  assert.equal((await revival).payload.toolUseId, "opencode-revive:call_bg:1");
  assert.equal(livenessOf(harness).liveness("thread-1"), "working", "the drain waits for it");
  const host = createHostIngestion();
  await host.ingest(harness.events);
  assert.equal(host.fold().head?.session.status, "error", "a failed admission keeps its transport doubt");
  assert.equal(
    host.fold().roster.find((row) => row.id === "ses_bg")?.status,
    "interrupted",
    "the documented exception: the roster reads no run of a session it takes for dead"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a child the Stop ended sends its leftovers: the server says it runs nothing, and it stays ended", async () => {
  const harness = makeHarness();
  const { session } = await stoppedWithChild(harness);
  const fed = harness.events.length;
  const statusReads = (): number =>
    harness.fake.requests.filter((request) => request.method === "GET" && request.path === "/session/status").length;
  const readsBefore = statusReads();
  // Its run's last frames, published before its cancel, reach the stream late.
  const asked = harness.fake.nextRequest("GET", "/session/status");
  pushAll(harness.fake, [
    { type: "session.status", properties: { sessionID: "ses_bg", status: { type: "busy" } } },
    ...childStreams("ses_bg", "a.ts")
  ]);
  await asked;
  await nextTurn();
  assert.equal(statusReads() - readsBefore, 1, "one question for the whole burst");
  // Told it runs nothing, more of its text asks nothing more; a `busy` asks again.
  pushAll(harness.fake, [
    { type: "message.part.delta", properties: { sessionID: "ses_bg", messageID: "msg_child_reply", partID: "prt_child_text", field: "text", delta: ", b.ts" } }
  ]);
  await drainedWith(harness, session.sessionId, "after another leftover");
  assert.equal(statusReads() - readsBefore, 1);
  const askedAgain = harness.fake.nextRequest("GET", "/session/status");
  harness.fake.push({ type: "session.status", properties: { sessionID: "ses_bg", status: { type: "busy" } } });
  await askedAgain;
  await nextTurn();
  assert.equal(statusReads() - readsBefore, 2);
  pushAll(harness.fake, [
    { type: "session.error", properties: { sessionID: "ses_bg", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } },
    { type: "session.status", properties: { sessionID: "ses_bg", status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: "ses_bg" } }
  ]);
  await drainedWith(harness, session.sessionId, "after the leftovers");
  assert.deepEqual(
    harness.events.slice(fed).filter((event) => event.type.startsWith("task.")),
    [],
    "no start, no end: it stays ended on the Stop's word"
  );
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a child the Stop closed that reports while the server cannot say counts live again: the drain outranks a duplicate row", async () => {
  const harness = makeHarness();
  const { session } = await stoppedWithChild(harness);
  harness.fake.overrides.set("GET /session/status", () => new Response("boom", { status: 500 }));
  const revival = nextStartOf(harness, "ses_bg");
  pushAll(harness.fake, childStreams("ses_bg", "a.ts"));
  await revival;
  assert.equal(livenessOf(harness).liveness("thread-1"), "working");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a report from a child the Stop closed, arriving while a later Stop is under way, is judged after that Stop: its abort may end the child", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedWithChild(harness);
  // Until the second Stop's abort, the child runs; that abort cancels it.
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const abortSent = deferred<void>();
  const abortAnswered = deferred<void>();
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
    abortSent.resolve();
    await abortAnswered.promise;
    harness.fake.statusMap = {};
    return json(true);
  });
  const stopping = session.interruptTurn();
  await abortSent.promise;
  const readsBefore = harness.fake.requests.filter((request) => request.path === "/session/status").length;
  const fed = harness.events.length;
  pushAll(harness.fake, childStreams("ses_bg", "a.ts"));
  await drainedWith(harness, sessionId, "during the second Stop");
  await nextTurn();
  assert.equal(
    harness.fake.requests.filter((request) => request.path === "/session/status").length,
    readsBefore,
    "no question to the server while the abort that may end the child is under way"
  );
  const asked = harness.fake.nextRequest("GET", "/session/status");
  abortAnswered.resolve();
  await stopping;
  await asked;
  await nextTurn();
  assert.deepEqual(harness.events.slice(fed).filter((event) => event.type === "task.started"), [], "the abort ended it: no revival");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a Stop that begins and ends while the server is asked about a child makes that answer stale: it asks again, and does not relaunch a child it ended", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedWithChild(harness);
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, () => {
    harness.fake.statusMap = {};
    return json(true);
  });
  const asked = deferred<void>();
  const answer = deferred<void>();
  harness.fake.overrides.set("GET /session/status", async () => {
    asked.resolve();
    await answer.promise;
    return json({ ses_bg: { type: "busy" } });
  });
  const fed = harness.events.length;
  pushAll(harness.fake, childStreams("ses_bg", "a.ts"));
  await asked.promise;
  await session.interruptTurn();
  const askedAgain = harness.fake.nextRequest("GET", "/session/status");
  answer.resolve();
  await askedAgain;
  await nextTurn();
  assert.deepEqual(
    harness.events.slice(fed).filter((event) => event.type === "task.started"),
    [],
    "the second answer is the one that counts: the Stop ended it"
  );
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a child whose own idle arrives while the server is asked about it is not revived: that report was its last", async () => {
  const harness = makeHarness();
  const { session } = await stoppedWithChild(harness);
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const asked = deferred<void>();
  const answer = deferred<void>();
  harness.fake.overrides.set("GET /session/status", async () => {
    asked.resolve();
    await answer.promise;
    return json(harness.fake.statusMap);
  });
  const fed = harness.events.length;
  pushAll(harness.fake, childStreams("ses_bg", "a.ts"));
  await asked.promise;
  pushAll(harness.fake, [
    { type: "session.status", properties: { sessionID: "ses_bg", status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: "ses_bg" } }
  ]);
  await drainedWith(harness, session.sessionId, "after its idle");
  answer.resolve();
  await nextTurn();
  assert.deepEqual(harness.events.slice(fed).filter((event) => event.type.startsWith("task.")), []);
  assert.equal(livenessOf(harness).liveness("thread-1"), null);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("the session stopping during the woken reply settles its turn before session.exited", async () => {
  const harness = makeHarness();
  const { session } = await wokenMidReply(harness);
  await session.stop({ reason: "tab closed", hostInitiated: true });
  const completed = firstOfType(harness.events, "turn.completed");
  assert.deepEqual([completed?.turnId, completed?.payload.state], ["msg_injected", "interrupted"]);
  const order = typesOf(harness.events);
  assert.ok(order.lastIndexOf("turn.completed") < order.lastIndexOf("session.exited"));
  harness.dispose();
});

test("the host's own /compact runs no turn: its summary streams while summarize runs, and opens nothing", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  // `summarize` answers only once its run has ended (fixture 09): hold it
  // open while the compaction's frames arrive, as the server does.
  const requested = deferred<void>();
  const answer = deferred<void>();
  harness.fake.overrides.set(`POST /session/${sessionId}/summarize`, async () => {
    requested.resolve();
    await answer.promise;
    return json(true);
  });
  const compacting = session.compact();
  await requested.promise;
  const summary = compactionSummary({ sessionId, promptId: "msg_compaction", replyId: "msg_summary", text: "## Objective" });
  pushAll(harness.fake, [
    ...compactionPrompt({ sessionId, promptId: "msg_compaction", auto: false }),
    ...summary.begins,
    ...summary.streams,
    ...summary.ends,
    { type: "session.compacted", properties: { sessionID: sessionId } }
  ]);
  await drainedWith(harness, sessionId, "during the compaction");
  answer.resolve();
  await compacting;
  pushAll(harness.fake, runSettles(sessionId));
  await drainedWith(harness, sessionId, "after the compaction");
  assert.deepEqual(eventsOfType(harness.events, "turn.started"), []);
  assert.equal(session.session.activeTurnId, undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a woken run that compacts first runs as one turn from its summary on, which the run's idle settles", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const busy = { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } };
  const summary = compactionSummary({ sessionId, promptId: "msg_compaction", replyId: "msg_summary", text: "## Goal" });
  const reply = wokenReply({ sessionId, promptId: "msg_continue", replyId: "msg_reply", text: "Done." });
  // The answer, then a run that compacts before it replies (1.18.32's
  // `SessionPrompt.run`: the context was already full).
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    busy,
    ...compactionPrompt({ sessionId, promptId: "msg_compaction", auto: true }),
    ...summary.begins,
    ...summary.streams
  ]);
  await waitFor(harness, "content.delta");
  assert.deepEqual(
    eventsOfType(harness.events, "turn.started").map((event) => event.turnId),
    ["msg_compaction"],
    "the thread reads working through the compaction"
  );
  assert.deepEqual([session.session.status, session.session.activeTurnId], ["running", "msg_compaction"]);

  pushAll(harness.fake, [
    ...summary.ends,
    ...compactionContinues({ sessionId, promptId: "msg_continue" }),
    ...reply.begins,
    ...reply.streams,
    ...reply.ends,
    ...runSettles(sessionId)
  ]);
  const completed = await waitFor(harness, "turn.completed");
  assert.deepEqual([completed.turnId, completed.payload.state], ["msg_compaction", "completed"]);
  assert.equal(
    completed.payload.tokenUsage?.inputTokens,
    1_346 + 42_514,
    "the reply's step alone: the summary call stays off the turn's usage"
  );
  assert.deepEqual(eventsOfType(harness.events, "turn.started").length, 1);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a rewind's fork is the past: its copied messages, delivered late, open no turn", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  // The first exchange's reply never completed: its run died with a server
  // (`time.completed` unset). A fork copies it whole, under new ids.
  harness.fake.faithfulForks = true;
  harness.fake.messages = [
    { info: { id: "msg_p0", role: "user" }, parts: [] },
    { info: { id: "msg_a0", role: "assistant" }, parts: [] },
    { info: { id: "msg_p1", role: "user" }, parts: [] },
    { info: { id: "msg_a1", role: "assistant" }, parts: [] }
  ];
  await session.rollbackThread(1, {
    firstRemovedTurnId: "msg_p1",
    droppedTurnIds: ["msg_p1"],
    retainedTurnIds: ["msg_a0"]
  });
  const forkId = session.sessionId;
  // The copy's frames, reaching the stream only after the thread moved onto the fork.
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: forkId, info: { id: `${forkId}-msg-1`, role: "user", sessionID: forkId } } },
    {
      type: "message.updated",
      properties: {
        sessionID: forkId,
        info: { id: `${forkId}-msg-2`, role: "assistant", parentID: `${forkId}-msg-1`, sessionID: forkId, time: { created: 1 } }
      }
    }
  ]);
  await drainedWith(harness, forkId, "after the rewind");
  assert.deepEqual(eventsOfType(harness.events, "turn.started"), []);
  assert.equal(session.session.activeTurnId, undefined);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("end to end: through the host's real ingestion and fold, the woken reply reads as a running turn, then a settled one", async () => {
  const harness = makeHarness();
  const host = createHostIngestion();
  let fed = 0;
  const ingestNew = async (): Promise<void> => {
    const fresh = harness.events.slice(fed);
    fed = harness.events.length;
    await host.ingest(fresh);
  };
  const { session, sessionId } = await wokenMidReply(harness);
  await ingestNew();

  const mid = host.fold();
  assert.deepEqual(
    [mid.head?.session.status, mid.head?.session.activeTurnId],
    ["running", "msg_injected"],
    "the thread reads working: nobody sent a /turn, and it is running"
  );
  const turn = mid.turns.find((candidate) => candidate.turnId === "msg_injected");
  assert.equal(turn?.state, "running");
  const answer = mid.items.find(
    (item): item is ThreadMessageItem => item.kind === "message" && item.role === "assistant"
  );
  assert.ok(answer !== undefined, "the reply's words are on the timeline");
  assert.equal(answer.turnId, "msg_injected", "the reply's words ride the turn");
  assert.equal(answer.streaming, true);
  assert.equal(isMessageStreaming(answer, messageStreamingContext(mid)), true, "and read as streaming");

  pushAll(harness.fake, [...wokenReply({ sessionId, ...FIRST }).ends, ...runSettles(sessionId)]);
  await waitFor(harness, "turn.completed");
  await ingestNew();

  const end = host.fold();
  assert.deepEqual([end.head?.session.status, end.head?.session.activeTurnId], ["ready", null]);
  const settled = end.turns.find((candidate) => candidate.turnId === "msg_injected");
  assert.equal(settled?.state, "completed");
  assert.ok(settled?.completedAt !== null, "a settled turn, whose end raises the thread's 'finished'");
  const done = end.items.find(
    (item): item is ThreadMessageItem => item.kind === "message" && item.id === answer.id
  );
  assert.ok(done !== undefined);
  assert.equal(done.text, "The child found README.md.");
  assert.equal(isMessageStreaming(done, messageStreamingContext(end)), false, "and reads as settled");
  assert.equal(end.turns.length, 1, "one turn, and no other");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// After a Stop: the stopped run's leftovers, then a new run's own turn
// ---------------------------------------------------------------------------

/** A turn whose run is streaming: its prompt, `busy`, the reply and a text part. */
async function turnStreaming(
  harness: Harness,
  session: OpenCodeThreadSession
): Promise<{ turnId: string; replyId: string; partId: string }> {
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "run it", attachments: [], interactionMode: "default" });
  const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
    messageID: string;
  }).messageID;
  const replyId = "msg_stopped_reply";
  const partId = "prt_stopped_text";
  pushAll(harness.fake, [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    {
      type: "message.updated",
      properties: { sessionID: sessionId, info: { id: replyId, role: "assistant", parentID: promptId, sessionID: sessionId } }
    },
    {
      type: "message.part.updated",
      properties: { sessionID: sessionId, part: { id: partId, messageID: replyId, sessionID: sessionId, type: "text", text: "", time: { start: 1 } } }
    },
    {
      type: "message.part.delta",
      properties: { sessionID: sessionId, messageID: replyId, partID: partId, field: "text", delta: "Working" }
    }
  ]);
  await waitFor(harness, "content.delta", (event) => event.itemId === partId);
  return { turnId: turn.turnId, replyId, partId };
}

/**
 * What the stopped run still sends once the abort has answered, in 1.18.32's
 * order (read from the source): a `busy` it wrote before the interrupt and a
 * delta; `SessionProcessor.halt`'s abort error and idle; the cleanup — the
 * text part closed, the reply completed with its error; then the runner's own
 * idle, published once the run's fiber has ended.
 */
function stoppedRunLeftovers(sessionId: string, stopped: { replyId: string; partId: string }): unknown[] {
  const idle = [
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: sessionId } }
  ];
  return [
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    {
      type: "message.part.delta",
      properties: { sessionID: sessionId, messageID: stopped.replyId, partID: stopped.partId, field: "text", delta: " on it" }
    },
    { type: "session.error", properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } },
    ...idle,
    {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: { id: stopped.partId, messageID: stopped.replyId, sessionID: sessionId, type: "text", text: "Working on it", time: { start: 1, end: 2 } }
      }
    },
    {
      type: "message.updated",
      properties: {
        sessionID: sessionId,
        info: {
          id: stopped.replyId,
          role: "assistant",
          sessionID: sessionId,
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          time: { created: 1, completed: 3 }
        }
      }
    },
    ...idle
  ];
}

/** Every event after `from` that writes a row of the thread's own timeline. */
function timelineRows(events: readonly RuntimeEvent[], from: number): RuntimeEvent[] {
  return events
    .slice(from)
    .filter((event) => event.type.startsWith("content.") || event.type.startsWith("item.") || event.type.startsWith("turn."));
}

test("after a Stop, a background answer's run is a new run: its reply is written on its own woken turn, the stopped run's late frames still dropped", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const stopped = await turnStreaming(harness, session);
  await session.interruptTurn(stopped.turnId);
  const fed = harness.events.length;

  pushAll(harness.fake, stoppedRunLeftovers(sessionId, stopped));
  await drainedWith(harness, sessionId, "after the stopped run");
  assert.deepEqual(timelineRows(harness.events, fed), [], "the stopped run's late frames write nothing");

  // A background job's answer, injected once the abort had found the runner
  // idle, starts the parent again: that run's `busy`, then its reply.
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins,
    ...reply.streams,
    ...reply.ends,
    ...runSettles(sessionId)
  ]);
  const woken = await waitFor(harness, "turn.completed", (event) => event.turnId === FIRST.promptId);
  assert.equal((woken as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "completed");
  assert.deepEqual(
    eventsOfType(harness.events, "turn.started").map((event) => event.turnId),
    [stopped.turnId, FIRST.promptId],
    "the new run opened its own turn"
  );
  const written = eventsOfType(harness.events.slice(fed), "content.delta");
  assert.deepEqual(
    written.map((event) => [event.turnId, event.payload.delta]),
    [[FIRST.promptId, FIRST.text]],
    "the woken reply is written, on its turn, and nothing of the stopped run"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, a new run whose busy arrives before the abort answers still gets its woken turn once the abort is over", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const stopped = await turnStreaming(harness, session);
  const abortSent = deferred<void>();
  const abortAnswered = deferred<void>();
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
    abortSent.resolve();
    await abortAnswered.promise;
    return json(true);
  });
  const stopping = session.interruptTurn(stopped.turnId);
  await abortSent.promise;
  // The stream wins the race: the stopped run's teardown, the answer's prompt
  // and the new run's `busy`, all before the abort's own answer.
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...stoppedRunLeftovers(sessionId, stopped).slice(2),
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins.filter((frame) => frame.type === "session.status")
  ]);
  await drainedWith(harness, sessionId, "during the abort");
  abortAnswered.resolve();
  await stopping;

  pushAll(harness.fake, [
    ...reply.begins.filter((frame) => frame.type !== "session.status"),
    ...reply.streams,
    ...reply.ends,
    ...runSettles(sessionId)
  ]);
  const woken = await waitFor(harness, "turn.completed", (event) => event.turnId === FIRST.promptId);
  assert.equal((woken as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "completed");
  assert.equal(firstOfType(harness.events, "turn.aborted")?.turnId, stopped.turnId);
  assert.ok(
    eventsOfType(harness.events, "content.delta").some((event) => event.turnId === FIRST.promptId),
    "the woken reply is written on its own turn"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("while a Stop is under way, a run the abort then cancels says busy after an idle: its reply opens no turn, before the abort answers or after", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const abortSent = deferred<void>();
  const abortAnswered = deferred<void>();
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
    abortSent.resolve();
    await abortAnswered.promise;
    return json(true);
  });
  // A Stop with no turn running: the session-scoped one that stops background work.
  const stopping = session.interruptTurn();
  await abortSent.promise;
  const fed = harness.events.length;
  const idle = [
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: sessionId } }
  ];
  // An idle, then a run an injected answer started — which the abort, still
  // under way, cancels: its reply begins, then its own teardown's idle.
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...idle,
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins,
    ...reply.streams,
    { type: "session.error", properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } },
    ...idle
  ]);
  await drainedWith(harness, sessionId, "during the abort");
  assert.deepEqual(timelineRows(harness.events, fed), [], "no turn for a run the abort under way may end");
  abortAnswered.resolve();
  await stopping;
  pushAll(harness.fake, reply.ends);
  await drainedWith(harness, sessionId, "after the abort");
  assert.deepEqual(timelineRows(harness.events, fed), [], "its idle came after its busy: nothing to end");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("when the stream wins the race and the boundary is crossed early, the cancelled run's own abort error is an echo: no failure, no error", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const abortSent = deferred<void>();
  const abortAnswered = deferred<void>();
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
    abortSent.resolve();
    await abortAnswered.promise;
    return json(true);
  });
  const stopping = session.interruptTurn();
  await abortSent.promise;
  // An idle (the last run's, ending just before the Stop), then a run an
  // injected answer started — whose `busy` reaches us before the abort's answer.
  pushAll(harness.fake, [
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: sessionId } },
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } }
  ]);
  await drainedWith(harness, sessionId, "during the abort");
  abortAnswered.resolve();
  await stopping;
  const fed = harness.events.length;

  // The abort cancelled that run after all: its own error.
  harness.fake.push({
    type: "session.error",
    properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
  });
  await drainedWith(harness, sessionId, "after the echo");
  assert.deepEqual(eventsOfType(harness.events.slice(fed), "runtime.error"), [], "the echo of an abort is no provider error");
  assert.deepEqual(
    eventsOfType(harness.events.slice(fed), "turn.completed").filter((event) => event.payload.state === "failed"),
    []
  );
  assert.notEqual(session.session.status, "error");

  // One echo only: a second abort error, before any idle, is the provider's word again.
  harness.fake.push({
    type: "session.error",
    properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
  });
  const reported = await waitFor(harness, "runtime.error");
  assert.equal((reported as Extract<RuntimeEvent, { type: "runtime.error" }>).payload.message, "Aborted");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("the echo is expected only until the parent's next idle, in either spelling: after a real new run, an abort error nobody here sent is reported", async () => {
  // 1.18.32 ends a run with `session.status {idle}` and `session.idle`; 1.18.5
  // after an abort with `session.idle` alone (fixtures README observation 6).
  for (const idle of ["session.status", "session.idle"] as const) {
    const harness = makeHarness();
    const session = await startSession(harness);
    const sessionId = session.sessionId;
    const stopped = await turnStreaming(harness, session);
    await session.interruptTurn(stopped.turnId);
    // The stopped run's teardown, then a real new run — which ends, with no echo.
    pushAll(harness.fake, [
      ...stoppedRunLeftovers(sessionId, stopped),
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
      idle === "session.status"
        ? { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } }
        : { type: "session.idle", properties: { sessionID: sessionId } }
    ]);
    await drainedWith(harness, sessionId, `after the new run (${idle})`);
    const fed = harness.events.length;
    harness.fake.push({
      type: "session.error",
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
    });
    const reported = await waitFor(harness, "runtime.error", (event) => harness.events.indexOf(event) >= fed);
    assert.equal((reported as Extract<RuntimeEvent, { type: "runtime.error" }>).payload.message, "Aborted", idle);
    await session.stop({ reason: "test", hostInitiated: true });
    harness.dispose();
  }
});

test("a host turn sent after a Stop is no abort's victim: an abort error mid-turn fails it, whichever of its busy and its prompt's answer comes first", async () => {
  // Its busy before the prompt's answer: the busy ends the interruption
  // (`awaitingBusyAfterInterruption`). The answer first — fixture 10's order:
  // the busy comes 30 ms after it — and the interruption's residue outlives
  // the busy until the turn settles. Neither may take the turn's own abort for
  // the Stop's echo.
  for (const order of ["busy first", "answer first"] as const) {
    const harness = makeHarness();
    const session = await startSession(harness);
    const sessionId = session.sessionId;
    const stopped = await turnStreaming(harness, session);
    await session.interruptTurn(stopped.turnId);
    pushAll(harness.fake, stoppedRunLeftovers(sessionId, stopped));
    await drainedWith(harness, sessionId, "after the leftovers");

    // The user's next message. `sendTurn` prompts only once every interrupt is
    // over, so its run starts after the abort did, whose echo came first.
    const begins = (promptId: string): unknown[] => [
      { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } }
    ];
    const promptPath = `/session/${sessionId}/prompt_async`;
    const promptOf = (): string =>
      (harness.fake.requests.filter((request) => request.path === promptPath).at(-1)?.body as { messageID: string }).messageID;
    if (order === "busy first") {
      harness.fake.overrides.set(`POST ${promptPath}`, async () => {
        pushAll(harness.fake, begins(promptOf()));
        await drainedWith(harness, sessionId, "before the prompt's answer");
        return new Response(null, { status: 204 });
      });
    }
    const next = await session.sendTurn({ threadId: "thread-1", input: "go on", attachments: [], interactionMode: "default" });
    if (order === "answer first") {
      pushAll(harness.fake, begins(promptOf()));
    }
    await drainedWith(harness, sessionId, "after its busy");
    const fed = harness.events.length;

    // An abort nobody here sent — another client's, say — ends the turn it ran in.
    harness.fake.push({
      type: "session.error",
      properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
    });
    await drainedWith(harness, sessionId, "after the abort error");
    assert.deepEqual(
      eventsOfType(harness.events.slice(fed), "turn.completed").map((event) => [event.turnId, event.payload.state]),
      [[next.turnId, "failed"]],
      `${order}: the turn's own abort is the provider's word`
    );
    assert.deepEqual(
      eventsOfType(harness.events.slice(fed), "runtime.error").map((event) => event.payload.message),
      ["Aborted"],
      order
    );
    await session.stop({ reason: "test", hostInitiated: true });
    harness.dispose();
  }
});

test("an abort error that may still be the Stop's echo fails no host turn: before the stopped run's idle came, or before the turn's prompt was taken", async () => {
  const abortError = (sessionId: string): unknown => ({
    type: "session.error",
    properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
  });
  const nothingFailed = (harness: Harness, fed: number, title: string): void => {
    assert.deepEqual(eventsOfType(harness.events.slice(fed), "runtime.error"), [], title);
    assert.deepEqual(
      eventsOfType(harness.events.slice(fed), "turn.completed").filter((event) => event.payload.state === "failed"),
      [],
      title
    );
  };

  // The turn's prompt taken and its run under way, but nothing of the stopped
  // run seen since the Stop: its abort error may still be on its way.
  {
    const harness = makeHarness();
    const session = await startSession(harness);
    const sessionId = session.sessionId;
    const stopped = await turnStreaming(harness, session);
    await session.interruptTurn(stopped.turnId);
    await session.sendTurn({ threadId: "thread-1", input: "go on", attachments: [], interactionMode: "default" });
    const promptId = (harness.fake.requests.filter((request) => request.path.endsWith("/prompt_async")).at(-1)?.body as {
      messageID: string;
    }).messageID;
    pushAll(harness.fake, [
      { type: "message.updated", properties: { sessionID: sessionId, info: { id: promptId, role: "user", sessionID: sessionId } } },
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } }
    ]);
    await drainedWith(harness, sessionId, "after its busy");
    const fed = harness.events.length;
    harness.fake.push(abortError(sessionId));
    await drainedWith(harness, sessionId, "after the late echo");
    nothingFailed(harness, fed, "no idle of the stopped run yet");
    await session.stop({ reason: "test", hostInitiated: true });
    harness.dispose();
  }

  // The stopped run's idle come, but the turn's prompt not taken yet: its run
  // cannot have begun, so an abort error now is not its own.
  {
    const harness = makeHarness();
    const session = await startSession(harness);
    const sessionId = session.sessionId;
    const stopped = await turnStreaming(harness, session);
    await session.interruptTurn(stopped.turnId);
    pushAll(harness.fake, stoppedRunLeftovers(sessionId, stopped));
    await drainedWith(harness, sessionId, "after the leftovers");
    const answer = deferred<void>();
    harness.fake.overrides.set(`POST /session/${sessionId}/prompt_async`, async () => {
      await answer.promise;
      return new Response(null, { status: 204 });
    });
    const prompted = harness.fake.nextRequest("POST", "/prompt_async");
    const sending = session.sendTurn({ threadId: "thread-1", input: "go on", attachments: [], interactionMode: "default" });
    await prompted;
    const fed = harness.events.length;
    harness.fake.push(abortError(sessionId));
    await drainedWith(harness, sessionId, "after an abort error before the prompt was taken");
    nothingFailed(harness, fed, "the prompt not taken yet");
    answer.resolve();
    await sending;
    await session.stop({ reason: "test", hostInitiated: true });
    harness.dispose();
  }
});

test("after a Stop whose abort request failed, the stopped turn is no turn sent since: an abort error is still the Stop's echo", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const stopped = await turnStreaming(harness, session);
  // The server stops the run — its abort error, then its idle — but the
  // abort's own answer is an error: the turn stays the thread's.
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
    pushAll(harness.fake, [
      { type: "session.error", properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } },
      { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID: sessionId } }
    ]);
    await drainedWith(harness, sessionId, "during the abort");
    return new Response("boom", { status: 500 });
  });
  await assert.rejects(session.interruptTurn(stopped.turnId));
  const fed = harness.events.length;
  harness.fake.push({
    type: "session.error",
    properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
  });
  await drainedWith(harness, sessionId, "after another abort error");
  assert.deepEqual(eventsOfType(harness.events.slice(fed), "runtime.error"), []);
  assert.deepEqual(
    eventsOfType(harness.events.slice(fed), "turn.completed").filter((event) => event.payload.state === "failed"),
    [],
    "the Stop's own turn is not failed by the Stop's echo"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, a busy from before the stopped run's idle ends nothing: a reply to an unclaimed prompt after it still opens no turn", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const stopped = await turnStreaming(harness, session);
  await session.interruptTurn(stopped.turnId);
  const fed = harness.events.length;

  // The stopped run's late `busy` (published before the interrupt), then a
  // reply the server wrote to a prompt nobody claimed — no idle between.
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins,
    ...reply.streams
  ]);
  await drainedWith(harness, sessionId, "after the late busy");
  assert.deepEqual(timelineRows(harness.events, fed), [], "no idle since the Stop: that busy may be the stopped run's own");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// A reconnect clears the run evidence (`parentBusy`)
// ---------------------------------------------------------------------------

/**
 * The parent at rest after a run's `busy` — its `idle` not yet seen — then
 * the stream dropped and the session reconnected. The session's wait between
 * attempts is the test's own, which returns at once and keeps what it was
 * asked to wait: the reconnect needs no clock.
 */
async function reconnectedAfterBusy(
  harness: Harness
): Promise<{ session: OpenCodeThreadSession; sessionId: string; waits: number[] }> {
  const waits: number[] = [];
  const session = await startSession(harness, {
    delay: async (ms) => {
      waits.push(ms);
    }
  });
  const sessionId = session.sessionId;
  harness.fake.push({ type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
  await drainedWith(harness, sessionId, "before the gap");
  const reconnected = harness.fake.nextStream();
  harness.fake.endStream();
  await reconnected;
  assert.deepEqual(waits, [250], "the reconnect waited the backoff's first step, on the injected wait");
  return { session, sessionId, waits };
}

test("a reconnect clears a stale busy: a reply the host never started, after the gap, opens no turn", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await reconnectedAfterBusy(harness);

  // The run whose `busy` came before the gap may have ended in it: its reply
  // to a prompt the server wrote, arriving with no `busy` since, is no
  // evidence of a run that an `idle` will ever settle.
  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins.filter((frame) => frame.type !== "session.status"),
    ...reply.streams
  ]);
  await drainedWith(harness, sessionId, "after the gap");
  assert.deepEqual(eventsOfType(harness.events, "turn.started"), [], "a busy from before the gap opens nothing");
  assert.deepEqual([session.session.status, session.session.activeTurnId], ["ready", undefined]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a reconnect keeps what a live run says after it: a busy after the gap still opens the woken turn", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await reconnectedAfterBusy(harness);

  const reply = wokenReply({ sessionId, ...FIRST });
  pushAll(harness.fake, [
    ...injectedAnswer({ sessionId, promptId: FIRST.promptId, childId: "ses_child", answer: "Found README.md." }),
    ...reply.begins,
    ...reply.streams
  ]);
  await waitFor(harness, "content.delta");
  assert.deepEqual(
    eventsOfType(harness.events, "turn.started").map((event) => event.turnId),
    [FIRST.promptId],
    "the run's own busy after the gap is the evidence"
  );
  pushAll(harness.fake, [...reply.ends, ...runSettles(sessionId)]);
  const completed = await waitFor(harness, "turn.completed");
  assert.deepEqual([completed.turnId, completed.payload.state], [FIRST.promptId, "completed"]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

// ---------------------------------------------------------------------------
// A request after an interrupt: shown while its asker waits, answered once it is gone
// ---------------------------------------------------------------------------

/**
 * A turn that launched a child in the background, then the user's Stop. The
 * fake server kills nothing, so what the test lists in `GET /permission`,
 * `GET /question` and `GET /session/status` afterwards is what the real one
 * would say: whether the abort reached the asker.
 */
async function stoppedAfterLaunching(
  harness: Harness,
  options: { runtimeMode?: "approval-required" | "full-access" } = {}
): Promise<{ session: OpenCodeThreadSession; sessionId: string; turnId: string }> {
  const session = await startSession(harness, options);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "delegate it", attachments: [], interactionMode: "default" });
  pushAll(harness.fake, childLaunch({ sessionId, childId: "ses_bg", callId: "call_bg", description: "list files", background: true }));
  await waitFor(harness, "task.started", (event) => event.agentId === "ses_bg");
  await session.interruptTurn(turn.turnId);
  assert.equal(session.session.activeTurnId, undefined);
  return { session, sessionId, turnId: turn.turnId };
}

/** An ask as `permission.asked` carries it, and `GET /permission` lists it (fixture 03). */
function permissionAsk(id: string, sessionID: string): Record<string, unknown> {
  return { id, sessionID, permission: "bash", patterns: ["ls -la"], metadata: { command: "ls -la" }, always: ["ls *"] };
}

/** A question as `question.asked` carries it, and `GET /question` lists it (fixture 05). */
function questionAsk(id: string, sessionID: string): Record<string, unknown> {
  return { id, sessionID, questions: [{ question: "Which file?", header: "File", options: [{ label: "a.ts", description: "" }] }] };
}

test("after a Stop, a question from a child the abort never reached is shown on no turn, and its answer reaches the server", async () => {
  const harness = makeHarness();
  const { session } = await stoppedAfterLaunching(harness);
  // The child runs on: the server still lists its question, and its session is busy.
  harness.fake.questionsOpen = [questionAsk("que_survivor", "ses_bg")];
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  harness.fake.push({ type: "question.asked", properties: questionAsk("que_survivor", "ses_bg") });

  const asked = await waitFor(harness, "user-input.requested");
  assert.equal(asked.requestId, "que_survivor");
  assert.equal(asked.turnId, undefined, "a child's question rides no turn");
  const host = createHostIngestion();
  await host.ingest(harness.events);
  assert.deepEqual(host.fold().pending.userInputs.map((input) => input.requestId), ["que_survivor"], "the card is up");

  const fed = harness.events.length;
  await session.respondToUserInput("que_survivor", { "question-0-file": "a.ts" });
  assert.deepEqual(harness.fake.find("POST", "/question/que_survivor/reply")?.body, { answers: [["a.ts"]] });
  const resolved = await waitFor(harness, "user-input.resolved");
  assert.equal(resolved.requestId, "que_survivor");
  await host.ingest(harness.events.slice(fed));
  assert.deepEqual(host.fold().pending.userInputs, [], "answered");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, a live asker's approval is shown — on the turn running then, none here — and answered on its reply route", async () => {
  const harness = makeHarness();
  const { session } = await stoppedAfterLaunching(harness);
  harness.fake.permissionsOpen = [permissionAsk("per_survivor", "ses_bg")];
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_survivor", "ses_bg") });

  const opened = await waitFor(harness, "request.opened");
  assert.deepEqual([opened.requestId, opened.turnId], ["per_survivor", undefined]);
  assert.equal(opened.payload.requestType, "command_execution_approval");
  await session.respondToApproval("per_survivor", "accept");
  assert.deepEqual(harness.fake.find("POST", "/permission/per_survivor/reply")?.body, { reply: "once" });
  const resolved = await waitFor(harness, "request.resolved");
  assert.deepEqual([resolved.requestId, resolved.payload.decision], ["per_survivor", "accept"]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, a request whose asker the abort ended is rejected on the wire and writes no card — nor a row when it closes", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedAfterLaunching(harness);
  // 1.18.32 drops an interrupted ask from its lists (`Permission.ask` awaits under
  // `ensuring`): the frames of the aborted run's last asks reach the stream late.
  // Unlisted is enough, whatever the asker's session runs now.
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_late", sessionId) });
  harness.fake.push({ type: "question.asked", properties: questionAsk("que_late", "ses_bg") });

  const rejectedAsk = await harness.fake.waitForRequest("POST", "/permission/per_late/reply");
  assert.deepEqual(rejectedAsk.body, { reply: "reject" });
  await harness.fake.waitForRequest("POST", "/question/que_late/reject");
  harness.fake.push({ type: "permission.replied", properties: { sessionID: sessionId, requestID: "per_late", reply: "reject" } });
  harness.fake.push({ type: "question.rejected", properties: { sessionID: "ses_bg", requestID: "que_late" } });
  await drainedWith(harness, sessionId, "after the late asks");
  for (const type of ["request.opened", "user-input.requested", "request.resolved", "user-input.resolved"] as const) {
    assert.deepEqual(
      eventsOfType(harness.events, type).filter((event) => event.requestId === "per_late" || event.requestId === "que_late"),
      [],
      `no ${type} for an ask nobody waits on`
    );
  }
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, a request answered elsewhere while the server is asked about it is dropped: no card, no row, nothing sent", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedAfterLaunching(harness);
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  const judging = deferred<void>();
  const listRead = deferred<void>();
  harness.fake.overrides.set("GET /permission", async () => {
    judging.resolve();
    await listRead.promise;
    return json([permissionAsk("per_elsewhere", "ses_bg")]);
  });
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_elsewhere", "ses_bg") });
  await judging.promise;
  // Another client answers it while the list is read; the list still names it.
  harness.fake.push({ type: "permission.replied", properties: { sessionID: "ses_bg", requestID: "per_elsewhere", reply: "once" } });
  await drainedWith(harness, sessionId, "after the answer elsewhere");
  listRead.resolve();
  // A later ask whose asker is gone: its reject is sent after that judgement ended.
  harness.fake.push({ type: "question.asked", properties: questionAsk("que_after", "ses_bg") });
  await harness.fake.waitForRequest("POST", "/question/que_after/reject");
  for (const type of ["request.opened", "request.resolved"] as const) {
    assert.deepEqual(
      eventsOfType(harness.events, type).filter((event) => event.requestId === "per_elsewhere"),
      [],
      `no ${type} for a request someone else answered`
    );
  }
  assert.equal(harness.fake.find("POST", "/permission/per_elsewhere/reply"), undefined, "nothing sent for it");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, an older server's orphan — still listed, its session idle — is rejected too, and shown nowhere", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedAfterLaunching(harness);
  // Fixture 06 (1.18.5): the aborted run's ask stays in `GET /permission`, and nothing runs.
  harness.fake.permissionsOpen = [permissionAsk("per_orphan", sessionId)];
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_orphan", sessionId) });

  const rejected = await harness.fake.waitForRequest("POST", "/permission/per_orphan/reply");
  assert.deepEqual(rejected.body, { reply: "reject" });
  assert.deepEqual(eventsOfType(harness.events, "request.opened"), []);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a request that arrives while the Stop's abort is in flight is judged after it: an asker the abort ended gets no card on the stopped turn", async () => {
  const harness = makeHarness();
  const session = await startSession(harness);
  const sessionId = session.sessionId;
  const turn = await session.sendTurn({ threadId: "thread-1", input: "run it", attachments: [], interactionMode: "default" });
  // Until the abort answers, the ask's run is alive; the abort ends it, and it
  // drops out of the server's lists.
  harness.fake.permissionsOpen = [permissionAsk("per_inflight", sessionId)];
  harness.fake.statusMap = { [sessionId]: { type: "busy" } };
  const abortSent = deferred<void>();
  const abortAnswered = deferred<void>();
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, async () => {
    abortSent.resolve();
    await abortAnswered.promise;
    harness.fake.permissionsOpen = [];
    harness.fake.statusMap = {};
    return json(true);
  });
  const stopping = session.interruptTurn(turn.turnId);
  await abortSent.promise;
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_inflight", sessionId) });
  await drainedWith(harness, sessionId, "during the abort");
  assert.deepEqual(eventsOfType(harness.events, "request.opened"), [], "no card while the abort may still end its asker");
  assert.equal(harness.fake.find("GET", "/permission"), undefined, "nor a question to the server before the abort is over");

  abortAnswered.resolve();
  await stopping;
  const rejected = await harness.fake.waitForRequest("POST", "/permission/per_inflight/reply");
  assert.deepEqual(rejected.body, { reply: "reject" });
  assert.deepEqual(eventsOfType(harness.events, "request.opened"), []);
  assert.equal(firstOfType(harness.events, "turn.aborted")?.turnId, turn.turnId);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a request that arrives once the next turn is sent, before its run says busy, is judged too: the stopped run's leftover is no card on the new turn", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedAfterLaunching(harness);
  const next = await session.sendTurn({ threadId: "thread-1", input: "try again", attachments: [], interactionMode: "default" });
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_leftover", sessionId) });

  const rejected = await harness.fake.waitForRequest("POST", "/permission/per_leftover/reply");
  assert.deepEqual(rejected.body, { reply: "reject" });
  assert.deepEqual(eventsOfType(harness.events, "request.opened"), []);
  assert.equal(session.session.activeTurnId, next.turnId, "the new turn runs on");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("an ask that arrives while the Stop withdraws the parked cards is held too: judged after the abort, no card on the stopped turn", async () => {
  const harness = makeHarness();
  const session = await sessionWithParkedCards(harness);
  const sessionId = session.sessionId;
  // The Stop's first step answers each parked card on the wire: hold the first
  // answer, and ask meanwhile. Until the abort that follows, the asker waits
  // (listed, its run busy); the abort ends it.
  harness.fake.permissionsOpen = [permissionAsk("per_during_settle", sessionId)];
  harness.fake.statusMap = { [sessionId]: { type: "busy" } };
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, () => {
    harness.fake.permissionsOpen = [];
    harness.fake.statusMap = {};
    return json(true);
  });
  const withdrawing = deferred<void>();
  const withdrawn = deferred<void>();
  harness.fake.overrides.set("POST /permission/per_1/reply", async () => {
    withdrawing.resolve();
    await withdrawn.promise;
    return json(true);
  });
  const stopping = session.interruptTurn();
  await withdrawing.promise;
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_during_settle", sessionId) });
  await drainedWith(harness, sessionId, "while the cards are withdrawn");
  assert.deepEqual(
    eventsOfType(harness.events, "request.opened").filter((event) => event.requestId === "per_during_settle"),
    [],
    "no card while the Stop is under way"
  );
  assert.equal(harness.fake.find("GET", "/permission"), undefined, "nor a question to the server before its abort");

  withdrawn.resolve();
  await stopping;
  const rejected = await harness.fake.waitForRequest("POST", "/permission/per_during_settle/reply");
  assert.deepEqual(rejected.body, { reply: "reject" });
  assert.deepEqual(
    eventsOfType(harness.events, "request.opened").map((event) => event.requestId),
    ["per_1"],
    "the parked card only, never one for the ended asker"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a prompt admission fails and aborts the session, a request is judged as after a Stop: the aborted run's is rejected, a live asker's shown", async () => {
  const harness = makeHarness();
  const session = await startSession(harness, { delay: async () => undefined });
  const sessionId = session.sessionId;
  // Accepted, but its message never shows and the session reads idle: machine
  // (3) gives up after five attempts, aborts the session and fails the turn.
  const turn = await session.sendTurn({ threadId: "thread-1", input: "run it", attachments: [], interactionMode: "default" });
  const failed = await waitFor(harness, "turn.completed", (event) => event.turnId === turn.turnId);
  assert.equal((failed as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "failed");
  assert.ok(harness.fake.find("POST", `/session/${sessionId}/abort`) !== undefined, "the admission's abort");

  // The aborted run's last ask, late: no longer listed.
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_after_admission", sessionId) });
  const rejected = await harness.fake.waitForRequest("POST", "/permission/per_after_admission/reply");
  assert.deepEqual(rejected.body, { reply: "reject" });
  // A run the abort never reached, asking: listed, its session busy.
  harness.fake.permissionsOpen = [permissionAsk("per_live", sessionId)];
  harness.fake.statusMap = { [sessionId]: { type: "busy" } };
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_live", sessionId) });
  const opened = await waitFor(harness, "request.opened");
  assert.equal(opened.requestId, "per_live");
  assert.deepEqual(eventsOfType(harness.events, "request.opened").map((event) => event.requestId), ["per_live"]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("a Stop that begins and ends while the server is asked about a held request makes that answer stale: it asks again", async () => {
  const harness = makeHarness();
  const { session, sessionId } = await stoppedAfterLaunching(harness);
  // Before the second Stop the asker waits (listed, its session busy); that
  // Stop's abort ends it.
  harness.fake.statusMap = { ses_bg: { type: "busy" } };
  harness.fake.overrides.set(`POST /session/${sessionId}/abort`, () => {
    harness.fake.statusMap = {};
    return json(true);
  });
  const asked = deferred<void>();
  const answer = deferred<void>();
  harness.fake.overrides.set("GET /permission", async () => {
    asked.resolve();
    await answer.promise;
    return json([permissionAsk("per_quick", "ses_bg")]);
  });
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_quick", "ses_bg") });
  await asked.promise;
  // The whole second Stop happens while the list is read: no interrupt is
  // under way by the time the (stale) answer lands.
  await session.interruptTurn();
  answer.resolve();

  const rejected = await harness.fake.waitForRequest("POST", "/permission/per_quick/reply");
  assert.deepEqual(rejected.body, { reply: "reject" }, "asked again after that Stop: its asker is gone");
  assert.deepEqual(
    eventsOfType(harness.events, "request.opened").filter((event) => event.requestId === "per_quick"),
    [],
    "no card for an asker the Stop ended while it was being judged"
  );
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("after a Stop, a request the server cannot say anything about is shown: the user answers it, never a reject on their behalf", async () => {
  const harness = makeHarness();
  const { session } = await stoppedAfterLaunching(harness);
  harness.fake.overrides.set("GET /permission", () => new Response("boom", { status: 500 }));
  harness.fake.overrides.set("GET /session/status", () => new Response("boom", { status: 500 }));
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_unknown", "ses_bg") });

  const opened = await waitFor(harness, "request.opened");
  assert.equal(opened.requestId, "per_unknown");
  assert.equal(harness.fake.find("POST", "/permission/per_unknown/reply"), undefined, "nothing answered for the user");
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("full access: a live asker's request after a Stop is answered once, as any; a reply the server refuses shows the card once", async () => {
  const harness = makeHarness();
  const { session } = await stoppedAfterLaunching(harness, { runtimeMode: "full-access" });
  harness.fake.permissionsOpen = [permissionAsk("per_auto", "ses_bg"), permissionAsk("per_refused", "ses_bg")];
  harness.fake.statusMap = { ses_bg: { type: "busy" } };

  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_auto", "ses_bg") });
  const auto = await harness.fake.waitForRequest("POST", "/permission/per_auto/reply");
  assert.deepEqual(auto.body, { reply: "once" }, "never always: full access answers once");

  harness.fake.overrides.set("POST /permission/per_refused/reply", () => new Response("boom", { status: 500 }));
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_refused", "ses_bg") });
  const opened = await waitFor(harness, "request.opened");
  assert.equal(opened.requestId, "per_refused");
  assert.equal(
    harness.fake.requests.filter((request) => request.path.endsWith("/permission/per_refused/reply")).length,
    1,
    "the card, not a second automatic reply"
  );
  assert.deepEqual(eventsOfType(harness.events, "request.opened").map((event) => event.requestId), ["per_refused"]);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("full access: an automatic reply the server refuses falls back to the card while a turn runs", async () => {
  const harness = makeHarness();
  const session = await startSession(harness, { runtimeMode: "full-access" });
  const sessionId = session.sessionId;
  await session.sendTurn({ threadId: "thread-1", input: "run it", attachments: [], interactionMode: "default" });
  harness.fake.overrides.set("POST /permission/per_refused/reply", () => new Response("boom", { status: 500 }));
  harness.fake.push({ type: "permission.asked", properties: permissionAsk("per_refused", sessionId) });

  const opened = await waitFor(harness, "request.opened");
  assert.equal(opened.requestId, "per_refused");
  assert.equal(opened.turnId, session.session.activeTurnId, "on the running turn");
  await session.stop({ reason: "test", hostInitiated: true });
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

/**
 * The session's wait between attempts as these tests drive it: it keeps what
 * it was asked to wait, and answers at once — or, `held`, only when the
 * session's stop aborts it, as `util.ts`'s `delay` does. `asked(n)` settles
 * once the n-th wait has been asked for. No clock is involved.
 */
function recordedDelay(options: { held?: boolean } = {}): {
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  waits: number[];
  asked: (count: number) => Promise<void>;
} {
  const waits: number[] = [];
  let waiters: { count: number; resolve: () => void }[] = [];
  const delay = (ms: number, signal: AbortSignal): Promise<void> => {
    waits.push(ms);
    waiters = waiters.filter((waiter) => {
      if (waits.length < waiter.count) {
        return true;
      }
      waiter.resolve();
      return false;
    });
    if (options.held !== true || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const asked = (count: number): Promise<void> =>
    waits.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve }));
  return { delay, waits, asked };
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
  const backoff = recordedDelay();
  const session = await startSession(harness, { delay: backoff.delay });
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
  await harness.fake.waitForRequest("GET", "/session/ses_cotenant");
  await nextTurn();

  assert.equal(probeCount(harness, "ses_cotenant"), 1, "a walked foreign root is not retried");
  assert.deepEqual(backoff.waits, [], "nor waited on to retry");
  // And it never became this thread's card.
  assert.deepEqual(eventsOfType(harness.events, "request.opened"), []);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("Q1 #21: an unreadable session is retried, but the chain is CAPPED", async () => {
  const harness = makeHarness();
  failReadsOf(harness, "ses_unreadable");
  const backoff = recordedDelay();
  const session = await startSession(harness, { delay: backoff.delay });

  // A non-`asked` request frame takes the SHORT cap: five probes, each unknown
  // answer backing off `250 ms · 2^n` before the next.
  harness.fake.push({
    type: "permission.replied",
    properties: { requestID: "per_unreadable", sessionID: "ses_unreadable", reply: "once" }
  });
  await backoff.asked(5);
  await nextTurn();

  assert.equal(probeCount(harness, "ses_unreadable"), 5, "the unknown outcome is retried, up to the cap");
  assert.deepEqual(backoff.waits, [250, 500, 1_000, 2_000, 4_000]);

  // Capped means STOPPED, not merely slowed: nothing more follows the last wait.
  await nextTurn();
  assert.equal(probeCount(harness, "ses_unreadable"), 5);
  assert.equal(backoff.waits.length, 5);
  await session.stop({ reason: "test", hostInitiated: true });
  harness.dispose();
});

test("Q1 #21: closing the thread abandons an in-flight ancestry chain", async () => {
  const harness = makeHarness();
  failReadsOf(harness, "ses_gone");
  // The chain waits to retry until the stop ends the wait.
  const backoff = recordedDelay({ held: true });
  const session = await startSession(harness, { delay: backoff.delay });

  harness.fake.push({
    type: "permission.asked",
    properties: { id: "per_gone", sessionID: "ses_gone", permission: "bash", patterns: ["x"] }
  });
  await backoff.asked(1);
  assert.equal(probeCount(harness, "ses_gone"), 1, "one probe, unknown: the chain waits to retry");

  await session.stop({ reason: "test", hostInitiated: true });
  await nextTurn();
  assert.equal(
    probeCount(harness, "ses_gone"),
    1,
    "a closed session must not keep polling the provider"
  );
  assert.deepEqual(backoff.waits, [250]);
  harness.dispose();
});

// ---------------------------------------------------------------------------
// A card nobody answered is withdrawn (final fix wave)
// ---------------------------------------------------------------------------

/** Every closing row the adapter wrote for one request. */
function closingsOf(harness: Harness, requestId: string): RuntimeEvent[] {
  return harness.events.filter(
    (event) =>
      (event.type === "request.resolved" || event.type === "user-input.resolved") &&
      event.requestId === requestId
  );
}

/** A running turn holding one approval and one question, both unanswered. */
async function sessionWithParkedCards(harness: Harness): Promise<OpenCodeThreadSession> {
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
  harness.fake.push({
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID: sessionId,
      questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }] }]
    }
  });
  await waitFor(harness, "request.opened");
  await waitFor(harness, "user-input.requested");
  return session;
}

function assertWithdrawnOnce(harness: Harness): void {
  const approval = closingsOf(harness, "per_1");
  assert.equal(approval.length, 1, "one closing row per card");
  assert.deepEqual(
    approval[0]?.payload,
    { requestType: "command_execution_approval", decision: "cancel", withdrawn: true },
    "nobody answered it: 'Request cancelled', never 'Approval resolved'"
  );
  const question = closingsOf(harness, "que_1");
  assert.equal(question.length, 1, "one closing row per card");
  assert.deepEqual(
    question[0]?.payload,
    { answers: {}, withdrawn: true },
    "nobody answered it: 'Question cancelled', never 'User input submitted'"
  );
}

test("a stop withdraws every parked card, once each", async () => {
  const harness = makeHarness();
  const session = await sessionWithParkedCards(harness);
  await session.stop({ reason: "tab closed", hostInitiated: true });
  assertWithdrawnOnce(harness);
  harness.dispose();
});

test("an interrupt withdraws every parked card, once each", async () => {
  const harness = makeHarness();
  const session = await sessionWithParkedCards(harness);
  await session.interruptTurn();
  assertWithdrawnOnce(harness);
  await session.stop({ reason: "test", hostInitiated: true });
  assert.equal(closingsOf(harness, "per_1").length, 1, "the stop finds nothing left to close");
  harness.dispose();
});

test("a dead server withdraws every parked card once, before session.exited", async () => {
  const harness = makeHarness();
  await sessionWithParkedCards(harness);
  harness.killServer();
  await waitFor(harness, "session.exited");
  assertWithdrawnOnce(harness);
  const order = typesOf(harness.events);
  assert.ok(
    order.lastIndexOf("user-input.resolved") < order.lastIndexOf("session.exited"),
    "the cards close before the exit"
  );
  harness.dispose();
});

test("the user's own answers are never withdrawn — and the server's echo adds no row", async () => {
  const harness = makeHarness();
  const session = await sessionWithParkedCards(harness);
  await session.respondToApproval("per_1", "cancel");
  await session.respondToUserInput("que_1", {});
  harness.fake.push({
    type: "permission.replied",
    properties: { sessionID: session.sessionId, requestID: "per_1", reply: "reject" }
  });
  harness.fake.push({
    type: "question.rejected",
    properties: { sessionID: session.sessionId, requestID: "que_1" }
  });
  await session.stop({ reason: "test", hostInitiated: true });
  const approval = closingsOf(harness, "per_1");
  assert.equal(approval.length, 1);
  assert.deepEqual(approval[0]?.payload, {
    requestType: "command_execution_approval",
    decision: "cancel"
  });
  const question = closingsOf(harness, "que_1");
  assert.equal(question.length, 1);
  assert.deepEqual(question[0]?.payload, { answers: {} });
  harness.dispose();
});
