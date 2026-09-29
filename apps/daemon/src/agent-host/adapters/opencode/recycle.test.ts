/**
 * Agent profile §4.8 — OpenCode server recycling, at the adapter: the REAL
 * adapter, its REAL server pool and REAL thread sessions against real server
 * processes — the scripted mock peer of `testing/peer.ts`, spawned by the pool
 * exactly as `opencode serve` is and stopped by its real group kill. Each peer
 * forwards the session routes to one in-process OpenCode fake (`MOCK_UPSTREAM`):
 * it records every request with the server it reached, answers the routes a
 * session uses, and holds the SSE stream the test pushes verbatim-shaped frames
 * into — so no `opencode`, no account and no network.
 *
 * Nothing here sleeps: every wait is on an emitted event, a recorded request,
 * the real spawned child's close event.
 */

import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AgentAdapter, AdapterContext, StartSessionInput } from "../../adapter.ts";
import { createOpenCodeAdapter } from "./index.ts";
import { createHostIngestion, HOST_THREAD_ID } from "./testing/host.ts";
import { makePeer, type Peer } from "./testing/peer.ts";
import { deferred } from "./util.ts";

// ---------------------------------------------------------------------------
// The fake OpenCode: one store behind every server, as the real data dir is.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  /** The URL as the adapter sent it: the origin is the server it reached. */
  url: URL;
  body?: unknown;
}

/** An `opencode serve` the pool started (a peer process), as it announced itself. */
interface PeerServer {
  url: string;
  pid: number;
}

/** Whether the server's process is gone (the pool's kill resolves once it is reaped). */
function gone(server: PeerServer): boolean {
  try {
    process.kill(server.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

class FakeOpenCode {
  readonly requests: RecordedRequest[] = [];
  /** Every server started, in start order. */
  readonly servers: PeerServer[] = [];
  /** While set, `GET /session/:id/message` answers only once it resolves (a history read in flight). */
  messagesGate: Promise<void> | undefined;
  /** Resolved by the first gated `GET /session/:id/message`. */
  readonly messagesRequested = deferred<void>();
  readonly http = createServer((req, res) => {
    void this.handle(req, res);
  });
  private readonly sessions = new Map<string, { id: string; directory: string }>();
  private stream: ServerResponse | undefined;
  private nextSession = 0;

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", String(req.headers["x-peer-origin"] ?? "http://upstream.invalid"));
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (path === "/__peer/up") {
      const announced = JSON.parse(text) as PeerServer & { origin: string };
      this.servers.push({ url: announced.origin, pid: announced.pid });
      json(res, {});
      return;
    }
    const body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
    this.requests.push({ method, url, ...(body !== undefined ? { body } : {}) });
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      this.stream = res;
      return;
    }
    if (path === "/session" && method === "POST") {
      this.nextSession += 1;
      const record = { id: `ses_${this.nextSession}`, directory: url.searchParams.get("directory") ?? "/repo" };
      this.sessions.set(record.id, record);
      json(res, record);
      return;
    }
    if (path === "/session/status") return json(res, {});
    const match = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (match !== null) {
      const tail = match[2] ?? "";
      if (tail === "" && method === "GET") {
        const record = this.sessions.get(match[1]!);
        return record === undefined ? json(res, { name: "NotFoundError", data: { message: "gone" } }, 404) : json(res, record);
      }
      if (tail === "" && method === "PATCH") return json(res, true);
      if (tail === "/prompt_async") {
        res.writeHead(204).end();
        return;
      }
      if (tail === "/abort") return json(res, true);
      if (tail === "/message" && method === "GET" && this.messagesGate !== undefined) {
        this.messagesRequested.resolve();
        await this.messagesGate;
      }
      if (tail === "/message" || tail === "/children") return json(res, []);
    }
    json(res, {}, 404);
  }

  /** Push one SSE frame onto the newest event stream. */
  push(event: unknown): void {
    this.stream?.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  find(method: string, suffix: string): RecordedRequest | undefined {
    return this.requests.find((request) => request.method === method && request.url.pathname.endsWith(suffix));
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  adapter: AgentAdapter;
  recycleIdleServers: NonNullable<AgentAdapter["recycleIdleServers"]>;
  waitForExit(server: PeerServer): Promise<void>;
  fake: FakeOpenCode;
  servers: PeerServer[];
  events: RuntimeEvent[];
  /**
   * The host's session start for the thread, then the catalogue refresh the
   * start forks settled — a probe holding the server is in-flight work, and
   * the recycle counts below are about the thread's own session.
   */
  start(extra?: Partial<StartSessionInput>): Promise<Awaited<ReturnType<AgentAdapter["startSession"]>>>;
  waitFor(type: RuntimeEvent["type"], from?: number): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
}

async function makeHarness(t: test.TestContext): Promise<Harness> {
  const exits = new Map<number, Promise<void>>();
  const spawn = childProcess.spawn;
  const observed = t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = spawn(command, args, options);
    if (child.pid !== undefined) {
      exits.set(child.pid, new Promise((resolve) => child.once("close", () => resolve())));
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { observed.mock.restore(); syncBuiltinESMExports(); });
  const fake = new FakeOpenCode();
  await new Promise<void>((resolve) => fake.http.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(fake.http.address() as AddressInfo).port}`;
  const peer: Peer = makePeer();
  const project = await mkdtemp(join(tmpdir(), "orq-opencode-recycle-"));
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
    resolveAttachmentPath: async (_threadId, attachmentId) => join(peer.dir, attachmentId),
    attachmentsDir: () => peer.dir,
    logRawFrame: () => undefined,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      MOCK_VERSION: "1.18.32",
      MOCK_UPSTREAM: upstream
    }),
    resolveBin: async () => peer.bin,
    sessionPath: () => "/usr/bin",
    tmpDir: () => peer.dir,
    signal: abort.signal
  };
  const input: StartSessionInput = {
    threadId: HOST_THREAD_ID,
    projectPath: project,
    cwd: project,
    home: { kind: "system", path: peer.dir },
    modelSelection: { model: "openrouter/google/gemini-3.1-flash-lite" },
    runtimeMode: "approval-required"
  };
  const adapter = await createOpenCodeAdapter(ctx);
  assert.ok(adapter.recycleIdleServers !== undefined);
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
    recycleIdleServers: adapter.recycleIdleServers.bind(adapter),
    waitForExit(server) {
      const exit = exits.get(server.pid);
      assert.ok(exit !== undefined, "the peer is a real child of this test");
      return exit;
    },
    fake,
    servers: fake.servers,
    events,
    async start(extra = {}) {
      const started = await adapter.startSession({ ...input, ...extra });
      await adapter.refreshSnapshot({ cwd: project });
      return started;
    },
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
      fake.http.closeAllConnections();
      await new Promise<void>((resolve) => fake.http.close(() => resolve()));
      peer.cleanup();
      await rm(project, { recursive: true, force: true });
    }
  };
}

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

test("an idle project's server is stopped now, with no session.exited, and the thread's next start gets a fresh server", async (t) => {
  const h = await makeHarness(t);
  try {
    const first = await h.start();
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);

    assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 });
    assert.equal(gone(h.servers[0]!), true, "the idle server is gone once the route answers");
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
    await h.start({ resumeCursor: first.resumeCursor });
    assert.equal(h.servers.length, 2, "a fresh server — the one that reads the new config");
    assert.ok(h.fake.find("GET", `/session/${sessionId}`), "the same upstream session is resumed");
    const resumed = await h.waitFor("session.started", from);
    assert.ok(resumed.type === "session.started" && resumed.payload.resume !== undefined);
    const turnPath = await sendTurn(h);
    assert.equal(turnPath, `/session/${sessionId}/prompt_async`);
    const lastSubmit = h.fake.requests.filter((request) => request.url.pathname.endsWith("/prompt_async")).at(-1);
    assert.equal(lastSubmit?.url.origin, h.servers[1]!.url, "the turn runs on the new server");
    assert.equal(gone(h.servers[1]!), false);
  } finally {
    await h.dispose();
  }
});

test("a busy server is deferred and recycled when its turn ends", async (t) => {
  const h = await makeHarness(t);
  try {
    await h.start();
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);
    await sendTurn(h);

    assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 1 });
    assert.equal(gone(h.servers[0]!), false, "a running turn is never disturbed");
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true);
    // Asked again while still busy: still one server, still deferred.
    assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 1 });

    // The turn ends; the deferred recycle goes once the host has its events.
    const turnStart = h.events.length;
    const messageId = sessionPromptId(h);
    runTurnToIdle(h.fake, sessionId, messageId);
    const completed = await h.waitFor("turn.completed", turnStart);
    assert.ok(completed.type === "turn.completed" && completed.payload.state === "completed");
    await h.waitForExit(h.servers[0]!);
    assert.equal(gone(h.servers[0]!), true, "recycled once idle");
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), false);
    assert.equal(h.events.some((event) => event.type === "session.exited"), false);
  } finally {
    await h.dispose();
  }
});

test("a turn that reaches a recycled thread before its restart brings the session back itself", async (t) => {
  const h = await makeHarness(t);
  try {
    await h.start();
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);
    assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 });

    const turnPath = await sendTurn(h);
    assert.equal(turnPath, `/session/${sessionId}/prompt_async`, "the same upstream session");
    assert.equal(h.servers.length, 2);
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true);
  } finally {
    await h.dispose();
  }
});

test("nothing running means nothing recycled; a user's session stop after a recycle forgets the thread", async (t) => {
  const h = await makeHarness(t);
  try {
    assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 0 });
    await h.start();
    await h.waitFor("session.state.changed");
    assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 });
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

test("history reads and rewind on a recycled idle thread bring its session back (the host calls them without ensureSession)", async (t) => {
  const h = await makeHarness(t);
  try {
    await h.start();
    await h.waitFor("session.state.changed");
    const sessionId = sessionIdOf(h);
    assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 });
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), false);

    const snapshot = await h.adapter.readThread(HOST_THREAD_ID);
    assert.deepEqual(snapshot.turns, []);
    assert.equal(h.adapter.hasSession(HOST_THREAD_ID), true, "the read brought the session back");
    assert.equal(h.servers.length, 2, "on a fresh server");
    assert.ok(
      h.fake.requests.some((request) => request.url.origin === h.servers[1]!.url && request.url.pathname === `/session/${sessionId}/message`),
      "the same upstream session is read"
    );

    assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 });
    await assert.rejects(
      h.adapter.rollbackThread(HOST_THREAD_ID, 1, { firstRemovedTurnId: "msg_unknown", droppedTurnIds: ["msg_unknown"], retainedTurnIds: [] }),
      /the turn to rewind to is no longer in this session/,
      "a rewind reaches the session instead of failing for a missing one"
    );
    assert.equal(h.servers.length, 3);
  } finally {
    await h.dispose();
  }
});

test("a recycle never stops the server under a history read; it goes once the read ends", async (t) => {
  const h = await makeHarness(t);
  try {
    await h.start();
    await h.waitFor("session.state.changed");
    const gate = deferred<void>();
    h.fake.messagesGate = gate.promise;
    const reading = h.adapter.readThread(HOST_THREAD_ID);
    await h.fake.messagesRequested.promise;

    assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 1 });
    assert.equal(gone(h.servers[0]!), false, "the read's server stays up");
    gate.resolve();
    await reading;
    await h.waitForExit(h.servers[0]!);
    assert.equal(gone(h.servers[0]!), true, "recycled once the read ended");
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
