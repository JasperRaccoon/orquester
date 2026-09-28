/**
 * Agent profile §4.8 — OpenCode server recycling, at the adapter: the REAL
 * adapter, its REAL server pool and REAL thread sessions, over an injected
 * transport (a fake `fetch` answering the routes a session uses, and an SSE
 * stream the test pushes verbatim-shaped frames into) and a fake server child
 * handed to the pool through its `startServer` seam — so no `opencode serve`,
 * no account and no network.
 *
 * Nothing here sleeps: every wait is on an emitted event, a recorded request,
 * a fake child's kill or the adapter's own `recycleSettled()` drain.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import type { ChildExitReason } from "../../support/spawn.ts";
import { OpenCodeAdapterImpl } from "./index.ts";
import type { OpenCodeStartedServer } from "./server.ts";
import { createHostIngestion, HOST_THREAD_ID } from "./testing/host.ts";
import { deferred } from "./util.ts";

// ---------------------------------------------------------------------------
// The fake OpenCode: one store behind every server, as the real data dir is.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: URL;
  body?: unknown;
}

class FakeOpenCode {
  readonly requests: RecordedRequest[] = [];
  /** While set, `GET /session/:id/message` answers only once it resolves (a history read in flight). */
  messagesGate: Promise<void> | undefined;
  /** Resolved by the first gated `GET /session/:id/message`. */
  readonly messagesRequested = deferred<void>();
  private readonly sessions = new Map<string, { id: string; directory: string }>();
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private nextSession = 0;

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, url, ...(body !== undefined ? { body } : {}) });
    const path = url.pathname;
    if (path === "/event") {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/session" && method === "POST") {
      this.nextSession += 1;
      const record = { id: `ses_${this.nextSession}`, directory: url.searchParams.get("directory") ?? "/repo" };
      this.sessions.set(record.id, record);
      return json(record);
    }
    if (path === "/session/status") return json({});
    const match = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (match !== null) {
      const tail = match[2] ?? "";
      if (tail === "" && method === "GET") {
        const record = this.sessions.get(match[1]!);
        return record === undefined ? json({ name: "NotFoundError", data: { message: "gone" } }, 404) : json(record);
      }
      if (tail === "" && method === "PATCH") return json(true);
      if (tail === "/prompt_async") return new Response(null, { status: 204 });
      if (tail === "/abort") return json(true);
      if (tail === "/message" && method === "GET" && this.messagesGate !== undefined) {
        this.messagesRequested.resolve();
        await this.messagesGate;
      }
      if (tail === "/message" || tail === "/children") return json([]);
    }
    return json({}, 404);
  };

  /** Push one SSE frame onto the newest event stream. */
  push(event: unknown): void {
    this.controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  find(method: string, suffix: string): RecordedRequest | undefined {
    return this.requests.find((request) => request.method === method && request.url.pathname.endsWith(suffix));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeServer {
  url: string;
  killed: boolean;
}

interface Harness {
  adapter: OpenCodeAdapterImpl;
  fake: FakeOpenCode;
  servers: FakeServer[];
  events: RuntimeEvent[];
  waitFor(type: RuntimeEvent["type"], from?: number): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
}

function makeHarness(): Harness {
  const fake = new FakeOpenCode();
  const servers: FakeServer[] = [];
  const events: RuntimeEvent[] = [];
  const waiters = new Set<{ type: string; from: number; resolve: (event: RuntimeEvent) => void }>();
  const abort = new AbortController();
  let ids = 0;
  const ctx: AdapterContext = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    clock: { now: () => new Date(0), nowIso: () => "2026-09-28T00:00:00.000Z" },
    ids: {
      eventId: () => `evt-${(ids += 1)}`,
      messageId: (prefix: string) => `${prefix}-${(ids += 1)}`,
      uuid: () => `uuid-${(ids += 1)}`
    },
    resolveAttachmentPath: async (_threadId, attachmentId) => `/attachments/${attachmentId}`,
    attachmentsDir: () => "/attachments",
    logRawFrame: () => undefined,
    buildEnv: () => ({}),
    // No binary: the forked catalogue refresh a session start kicks answers
    // "not installed" and never touches the pool.
    resolveBin: async () => null,
    sessionPath: () => "/usr/bin",
    tmpDir: () => "/tmp",
    signal: abort.signal
  };
  const startServer = async (): Promise<OpenCodeStartedServer> => {
    const server: FakeServer = { url: `http://127.0.0.1:${4100 + servers.length}`, killed: false };
    servers.push(server);
    const exited = deferred<ChildExitReason>();
    return {
      url: server.url,
      version: "1.18.32",
      serverPassword: undefined,
      child: {
        pid: 9000 + servers.length,
        exited: exited.promise,
        hasExited: () => exited.settled(),
        kill: async () => {
          server.killed = true;
          const reason: ChildExitReason = { kind: "signal", code: null, signal: "SIGTERM" };
          exited.resolve(reason);
          return reason;
        }
      }
    };
  };
  const adapter = new OpenCodeAdapterImpl(ctx, { pool: { startServer, fetchImpl: fake.fetchImpl } });
  // The host's one consumer of the adapter's stream.
  const consumed = (async () => {
    for await (const event of adapter.events) {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.type === event.type && events.length - 1 >= waiter.from) {
          waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    }
  })();
  return {
    adapter,
    fake,
    servers,
    events,
    waitFor(type, from = 0) {
      const found = events.slice(from).find((event) => event.type === type);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) => {
        waiters.add({ type, from, resolve });
      });
    },
    async dispose() {
      await adapter.stopAll();
      abort.abort();
      await consumed;
    }
  };
}

const START: StartSessionInput = {
  threadId: HOST_THREAD_ID,
  projectPath: "/repo",
  cwd: "/repo",
  home: { kind: "system", path: "/home/owner" },
  modelSelection: { model: "openrouter/google/gemini-3.1-flash-lite" },
  runtimeMode: "approval-required"
};

/** One turn's frames, in the order 1.18.x emits them, ending on the parent's idle. */
function runTurnToIdle(fake: FakeOpenCode, sessionId: string, userMessageId: string): void {
  const frames = [
    { type: "message.updated", properties: { sessionID: sessionId, info: { id: userMessageId, role: "user" } } },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } },
    {
      type: "message.updated",
      properties: { sessionID: sessionId, info: { id: "msg_reply", role: "assistant", parentID: userMessageId } }
    },
    {
      type: "message.part.updated",
      properties: { sessionID: sessionId, part: { id: "prt_1", messageID: "msg_reply", type: "text", text: "", time: { start: 1 } } }
    },
    {
      type: "message.part.delta",
      properties: { sessionID: sessionId, messageID: "msg_reply", partID: "prt_1", field: "text", delta: "done" }
    },
    {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: { id: "prt_step", messageID: "msg_reply", type: "step-finish", reason: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }
      }
    },
    { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } }
  ];
  for (const frame of frames) fake.push(frame);
}

/** Send a turn; answers the path it was submitted on. */
async function sendTurn(h: Harness): Promise<string> {
  const before = h.fake.requests.length;
  await h.adapter.sendTurn({ threadId: HOST_THREAD_ID, input: "hi", attachments: [], interactionMode: "default" });
  const submit = h.fake.requests.slice(before).find((request) => request.url.pathname.endsWith("/prompt_async"));
  assert.ok(submit !== undefined, "the turn was submitted");
  return submit.url.pathname;
}

function sessionIdOf(h: Harness): string {
  const started = h.events.find((event) => event.type === "thread.started");
  assert.ok(started !== undefined && started.type === "thread.started");
  return started.payload.providerThreadId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("an idle project's server is stopped now, with no session.exited, and the thread's next start gets a fresh server", async () => {
  const h = makeHarness();
  try {
    const first = await h.adapter.startSession(START);
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);

    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 1, deferred: 0 });
    assert.equal(h.servers[0]!.killed, true, "the idle server is gone once the route answers");
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), false);
    assert.deepEqual(h.adapter.listSessions(), []);
    assert.equal(
      h.events.some((event) => event.type === "session.exited"),
      false,
      "an idle thread is let go of silently"
    );

    // What the host writes for the thread: nothing says it stopped.
    const ingestion = createHostIngestion();
    await ingestion.ingest(h.events);
    const stopped = ingestion
      .log()
      .filter((event) => event.type === "thread.session-set")
      .filter((event) => (event.payload as { session: { status: string } }).session.status === "stopped");
    assert.deepEqual(stopped, [], "no spurious stopped row");
    assert.equal(ingestion.fold().head?.session.status, "ready");

    // The host's `ensureSession` on the next turn: a start from the binding's cursor.
    const from = h.events.length;
    await h.adapter.startSession({ ...START, resumeCursor: first.resumeCursor });
    assert.equal(h.servers.length, 2, "a fresh server — the one that reads the new config");
    assert.ok(h.fake.find("GET", `/session/${sessionId}`), "the same upstream session is resumed");
    const resumed = await h.waitFor("session.started", from);
    assert.ok(resumed.type === "session.started" && resumed.payload.resume !== undefined);
    const turnPath = await sendTurn(h);
    assert.equal(turnPath, `/session/${sessionId}/prompt_async`);
    const lastSubmit = h.fake.requests.filter((request) => request.url.pathname.endsWith("/prompt_async")).at(-1);
    assert.equal(lastSubmit?.url.origin, h.servers[1]!.url, "the turn runs on the new server");
    assert.equal(h.servers[1]!.killed, false);
  } finally {
    await h.dispose();
  }
});

test("a busy server is deferred, recycled once when its turn ends, and not again on later idles", async () => {
  const h = makeHarness();
  try {
    const first = await h.adapter.startSession(START);
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);
    await sendTurn(h);

    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 0, deferred: 1 });
    assert.equal(h.servers[0]!.killed, false, "a running turn is never disturbed");
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true);
    // Asked again while still busy: still one server, still deferred.
    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 0, deferred: 1 });

    // The turn ends; the deferred recycle goes once the host has its events.
    const turnStart = h.events.length;
    const messageId = sessionPromptId(h);
    runTurnToIdle(h.fake, sessionId, messageId);
    const completed = await h.waitFor("turn.completed", turnStart);
    assert.ok(completed.type === "turn.completed" && completed.payload.state === "completed");
    await h.adapter.recycleSettled();
    assert.equal(h.servers[0]!.killed, true, "recycled once idle");
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), false);
    assert.equal(h.events.some((event) => event.type === "session.exited"), false);

    // Back on a fresh server, another turn to idle: no second recycle.
    await h.adapter.startSession({ ...START, resumeCursor: first.resumeCursor });
    await sendTurn(h);
    const again = h.events.length;
    runTurnToIdle(h.fake, sessionId, sessionPromptId(h));
    await h.waitFor("turn.completed", again);
    await h.adapter.recycleSettled();
    assert.equal(h.servers.length, 2);
    assert.equal(h.servers[1]!.killed, false, "the mark was spent on the first idle");
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true);
  } finally {
    await h.dispose();
  }
});

test("a turn that reaches a recycled thread before its restart brings the session back itself", async () => {
  const h = makeHarness();
  try {
    await h.adapter.startSession(START);
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);
    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 1, deferred: 0 });

    const turnPath = await sendTurn(h);
    assert.equal(turnPath, `/session/${sessionId}/prompt_async`, "the same upstream session");
    assert.equal(h.servers.length, 2);
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true);
  } finally {
    await h.dispose();
  }
});

test("nothing running means nothing recycled; a user's session stop after a recycle forgets the thread", async () => {
  const h = makeHarness();
  try {
    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 0, deferred: 0 });
    await h.adapter.startSession(START);
    await h.waitFor("session.state.changed");
    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 1, deferred: 0 });
    await h.adapter.stopSession(HOST_THREAD_ID);
    await assert.rejects(
      h.adapter.sendTurn({ threadId: HOST_THREAD_ID, input: "hi", attachments: [], interactionMode: "default" }),
      /no live session/
    );
    assert.equal(h.servers.length, 1, "a stopped thread is not brought back by the backstop");
  } finally {
    await h.dispose();
  }
});

test("history reads and rewind on a recycled idle thread bring its session back (the host calls them without ensureSession)", async () => {
  const h = makeHarness();
  try {
    await h.adapter.startSession(START);
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);
    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 1, deferred: 0 });
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), false);

    const snapshot = await h.adapter.readThread(HOST_THREAD_ID);
    assert.deepEqual(snapshot.turns, []);
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true, "the read brought the session back");
    assert.equal(h.servers.length, 2, "on a fresh server");
    assert.ok(
      h.fake.requests.some((request) => request.url.origin === h.servers[1]!.url && request.url.pathname === `/session/${sessionId}/message`),
      "the same upstream session is read"
    );

    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 1, deferred: 0 });
    await assert.rejects(
      h.adapter.rollbackThread(HOST_THREAD_ID, 1, { turnId: "msg_unknown" }),
      (error: Error) => !/no live session/.test(error.message),
      "a rewind reaches the session instead of failing for a missing one"
    );
    assert.equal(h.servers.length, 3);
  } finally {
    await h.dispose();
  }
});

test("a recycle never stops the server under a history read; it goes once the read ends", async () => {
  const h = makeHarness();
  try {
    await h.adapter.startSession(START);
    await h.waitFor("session.state.changed");
    const gate = deferred<void>();
    h.fake.messagesGate = gate.promise;
    const reading = h.adapter.readThread(HOST_THREAD_ID);
    await h.fake.messagesRequested.promise;

    assert.deepEqual(await h.adapter.recycleIdleServers(), { recycled: 0, deferred: 1 });
    assert.equal(h.servers[0]!.killed, false, "the read's server stays up");
    gate.resolve();
    await reading;
    await h.adapter.recycleSettled();
    assert.equal(h.servers[0]!.killed, true, "recycled once the read ended");
    assert.equal(h.events.some((event) => event.type === "session.exited"), false);
  } finally {
    h.fake.messagesGate = undefined;
    await h.dispose();
  }
});

/** The message id the newest submitted prompt carried — the user message its turn's frames name. */
function sessionPromptId(h: Harness): string {
  const submit = h.fake.requests.filter((request) => request.url.pathname.endsWith("/prompt_async")).at(-1);
  const messageId = (submit?.body as { messageID?: unknown } | undefined)?.messageID;
  assert.ok(typeof messageId === "string", "the prompt carried a minted message id");
  return messageId;
}
