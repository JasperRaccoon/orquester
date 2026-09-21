import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { SessionSummary } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { AGENT_HOST_AUTH_HEADER } from "../agent-host/host-protocol.ts";
import { AgentHostClient } from "./host-client.ts";
import { registerAgentChatRoutes } from "./proxy-routes.ts";

// §6.2/§6.3 route coverage. A fake host on a real unix socket stands in for
// `agent-host.sock`, so the proxy hop — auth header, body passthrough, error
// envelope passthrough, streaming and client-disconnect cancellation — is
// exercised end to end without an agent host ever being started.

interface FakeHost {
  socketPath: string;
  requests: Array<{ method: string; url: string; body: string; auth?: string }>;
  /** Set per test: answers one request. */
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  /** Resolves when an upstream stream response is destroyed by the proxy. */
  streamClosed: Promise<void>;
  close(): Promise<void>;
}

async function makeFakeHost(): Promise<FakeHost> {
  const dir = await mkdtemp(join(tmpdir(), "orq-host-"));
  const socketPath = join(dir, "agent-host.sock");
  let signalClosed: () => void = () => undefined;
  const fake: FakeHost = {
    socketPath,
    requests: [],
    handler: (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"),
    streamClosed: new Promise<void>((resolve) => {
      signalClosed = resolve;
    }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      fake.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        auth: req.headers[AGENT_HOST_AUTH_HEADER] as string | undefined
      });
      res.on("close", signalClosed);
      fake.handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return fake;
}

interface Harness {
  app: FastifyInstance;
  host: FakeHost;
  healthy: boolean;
  seqs: Array<[string, number]>;
  restarts: number;
  providerBroadcasts: string[];
  close(): Promise<void>;
}

async function makeHarness(
  sessions: Record<string, SessionSummary | undefined> = {},
  attachments: Record<string, string> = {}
): Promise<Harness> {
  const host = await makeFakeHost();
  const app = Fastify({ logger: false });
  const harness: Partial<Harness> = { host, healthy: true, seqs: [], restarts: 0, providerBroadcasts: [] };
  registerAgentChatRoutes(app, {
    client: new AgentHostClient({ socketPath: host.socketPath, token: () => "tok" }),
    isHostHealthy: () => harness.healthy === true,
    chatSession: (id) => sessions[id],
    noteSeq: (id, seq) => harness.seqs?.push([id, seq]),
    restartHost: async () => {
      harness.restarts = (harness.restarts ?? 0) + 1;
      return { hostInstanceId: "host-2", markedThreadIds: ["t1"] };
    },
    onProvidersChanged: (adapterId) => harness.providerBroadcasts?.push(adapterId),
    attachmentPath: async (_sessionId, attachmentId) =>
      attachments[attachmentId] === undefined ? null : attachments[attachmentId],
    sendAttachment: async (reply, path) => reply.code(200).send({ streamed: path })
  });
  await app.ready();
  harness.app = app;
  harness.close = async () => {
    await app.close();
    await host.close();
  };
  return harness as Harness;
}

const tab = (id: string): SessionSummary => ({
  id,
  kind: "agent-chat",
  refId: "claude",
  title: id,
  projectPath: "/w/p",
  cwd: "/w/p",
  cols: 0,
  rows: 0,
  status: "running",
  order: 0,
  createdAt: "2026-09-21T00:00:00.000Z"
});

test("a command is proxied verbatim, with the host token attached", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seq: 42 }));
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.turn("t1"),
    payload: { commandId: "c1", input: "hi" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { seq: 42 });
  assert.equal(h.host.requests.length, 1);
  assert.equal(h.host.requests[0].method, "POST");
  assert.equal(h.host.requests[0].url, "/threads/t1/turn");
  assert.equal(h.host.requests[0].auth, "Bearer tok");
  assert.deepEqual(JSON.parse(h.host.requests[0].body), { commandId: "c1", input: "hi" });
  await h.close();
});

test("every §6.2 command has a route", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seq: 1 }));
  const paths = [
    agentChatRoutes.turn("t1"),
    agentChatRoutes.interrupt("t1"),
    agentChatRoutes.approval("t1"),
    agentChatRoutes.answer("t1"),
    agentChatRoutes.dismiss("t1"),
    agentChatRoutes.revert("t1"),
    agentChatRoutes.compact("t1"),
    agentChatRoutes.mode("t1"),
    agentChatRoutes.sessionStop("t1")
  ];
  for (const url of paths) {
    const response = await h.app.inject({ method: "POST", url, payload: { commandId: "c" } });
    assert.equal(response.statusCode, 200, url);
  }
  await h.close();
});

test("the host's error envelope is passed through verbatim, status included", async () => {
  // Exactly one surface describes a failure, whichever layer produced it.
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res
      .writeHead(409, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code: "COMMAND_REJECTED", message: "revert past turnCount" } }));
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.revert("t1"),
    payload: { commandId: "c1", targetTurnCount: 99 }
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: { code: "COMMAND_REJECTED", message: "revert past turnCount" }
  });
  await h.close();
});

test("an unknown session is 404 THREAD_NOT_FOUND and never reaches the host", async () => {
  const h = await makeHarness();
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.turn("ghost"),
    payload: { commandId: "c1" }
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "THREAD_NOT_FOUND");
  assert.equal(h.host.requests.length, 0);
  await h.close();
});

test("a down host is 503 HOST_UNAVAILABLE on commands, reads and the stream", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.healthy = false;
  for (const [method, url] of [
    ["POST", agentChatRoutes.turn("t1")],
    ["GET", agentChatRoutes.thread("t1")],
    ["GET", agentChatRoutes.events("t1")],
    ["GET", agentChatRoutes.item("t1", "i1")],
    ["GET", agentChatRoutes.turnDiff("t1", 2)],
    ["GET", agentChatRoutes.providers],
    ["POST", agentChatRoutes.hostStop]
  ] as const) {
    const response = await h.app.inject({ method, url, payload: {} });
    assert.equal(response.statusCode, 503, url);
    assert.equal(response.json().error.code, "HOST_UNAVAILABLE", url);
  }
  assert.equal(h.host.requests.length, 0);
  await h.close();
});

test("an unreachable host socket is 503, not a 500", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  await h.host.close(); // the socket is gone; the supervisor has not noticed yet
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.turn("t1"),
    payload: { commandId: "c1" }
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "HOST_UNAVAILABLE");
  await h.app.close();
});

test("a non-JSON body from the host is a 502, never leaked raw", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>");
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.turn("t1"),
    payload: { commandId: "c1" }
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "HOST_UNAVAILABLE");
  await h.close();
});

test("a malformed turn count is rejected before the hop", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  const response = await h.app.inject({ method: "GET", url: "/api/sessions/t1/turns/abc/diff" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_COMMAND");
  assert.equal(h.host.requests.length, 0);
  await h.close();
});

test("a thread read records the sequence it served (§5.2 lastSeq)", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ kind: "snapshot", thread: { seq: 17 } }));
  await h.app.inject({ method: "GET", url: `${agentChatRoutes.thread("t1")}?after=3` });
  assert.deepEqual(h.seqs, [["t1", 17]]);
  assert.equal(h.host.requests[0].url, "/threads/t1/thread?after=3");
  await h.close();
});

test("an events-shaped read records its sequence too", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ kind: "events", seq: 9, events: [] }));
  await h.app.inject({ method: "GET", url: agentChatRoutes.thread("t1") });
  assert.deepEqual(h.seqs, [["t1", 9]]);
  await h.close();
});

test("a refresh broadcasts agent.providers.changed ONLY when it changed something", async () => {
  const h = await makeHarness();
  h.host.handler = (_req, res) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ provider: { id: "codex" }, changed: false }));
  await h.app.inject({ method: "POST", url: agentChatRoutes.providerRefresh("codex"), payload: {} });
  assert.deepEqual(h.providerBroadcasts, [], "a no-op refresh must not wake every client");
  h.host.handler = (_req, res) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ provider: { id: "codex" }, changed: true }));
  await h.app.inject({ method: "POST", url: agentChatRoutes.providerRefresh("codex"), payload: {} });
  assert.deepEqual(h.providerBroadcasts, ["codex"]);
  await h.close();
});

test("§6.3 attachment read-back resolves through the host and streams the file", async () => {
  // `/api/fs/download` cannot serve these: it is confined to `fsRoot` and the
  // thread's attachments live under the appdir. The host owns the namespace.
  const h = await makeHarness({ t1: tab("t1") }, { "att-1": "/appdir/threads/t1/attachments/a.png" });
  const ok = await h.app.inject({ method: "GET", url: agentChatRoutes.attachment("t1", "att-1") });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { streamed: "/appdir/threads/t1/attachments/a.png" });

  const missing = await h.app.inject({
    method: "GET",
    url: agentChatRoutes.attachment("t1", "nope")
  });
  assert.equal(missing.statusCode, 404);

  const ghost = await h.app.inject({
    method: "GET",
    url: agentChatRoutes.attachment("ghost", "att-1")
  });
  assert.equal(ghost.statusCode, 404);
  assert.equal(ghost.json().error.code, "THREAD_NOT_FOUND");

  h.healthy = false;
  const down = await h.app.inject({ method: "GET", url: agentChatRoutes.attachment("t1", "att-1") });
  assert.equal(down.statusCode, 503);
  await h.close();
});

test("the host-stop route drives the supervisor's drain restart", async () => {
  const h = await makeHarness();
  const response = await h.app.inject({ method: "POST", url: agentChatRoutes.hostStop, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(h.restarts, 1);
  assert.deepEqual(response.json(), {
    ok: true,
    markedThreadIds: ["t1"],
    hostInstanceId: "host-2"
  });
  await h.close();
});

// --- the long-lived §6.3 stream --------------------------------------------

test("the stream is piped through, and the client disconnect cancels the upstream", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(`${JSON.stringify({ kind: "synchronized", hostInstanceId: "host-1" })}\n`);
    // Deliberately never ends: this is a subscription.
  };
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
  void address;
  const port = (h.app.server.address() as AddressInfo).port;
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${port}${agentChatRoutes.events("t1")}?after=4`,
    { signal: controller.signal }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(response.headers.get("x-accel-buffering"), "no", "proxies must not hold the heartbeat");

  const reader = response.body!.getReader();
  const first = await reader.read();
  const line = Buffer.from(first.value!).toString("utf8").trim();
  assert.deepEqual(JSON.parse(line), { kind: "synchronized", hostInstanceId: "host-1" });
  assert.equal(h.host.requests[0].url, "/threads/t1/events?after=4");

  // A client that goes away must not leave the host holding a subscription.
  controller.abort();
  await h.host.streamClosed;
  await h.close();
});

test("a stream refusal answers the host's envelope rather than an empty stream", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code: "THREAD_NOT_FOUND", message: "gone" } }));
  const response = await h.app.inject({ method: "GET", url: agentChatRoutes.events("t1") });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "THREAD_NOT_FOUND");
  await h.close();
});
