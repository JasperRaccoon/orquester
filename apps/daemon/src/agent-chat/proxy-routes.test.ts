import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { SessionSummary } from "@orquester/api";
import {
  AGENT_CHAT_ERROR_CODES,
  THREAD_SEARCH_MAX_QUERY_CHARS,
  agentChatRoutes,
  type AgentChatErrorCode,
  type ThreadHistoryPage,
  type ThreadSearchResponse
} from "@orquester/api/agent-chat";
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
  /** `[sessionId, accountId]` per §3.4 account switch reaching the service. */
  accountSwitches: Array<[string, string]>;
  close(): Promise<void>;
}

async function makeHarness(
  sessions: Record<string, SessionSummary | undefined> = {},
  attachments: Record<string, string> = {}
): Promise<Harness> {
  const host = await makeFakeHost();
  const app = Fastify({ logger: false });
  const harness: Partial<Harness> = {
    host,
    healthy: true,
    seqs: [],
    restarts: 0,
    providerBroadcasts: [],
    accountSwitches: []
  };
  registerAgentChatRoutes(app, {
    client: new AgentHostClient({ socketPath: host.socketPath, token: () => "tok" }),
    isHostHealthy: () => harness.healthy === true,
    chatSession: (id) => sessions[id],
    noteSeq: (id, seq) => harness.seqs?.push([id, seq]),
    switchAccount: async (id, body) => {
      harness.accountSwitches?.push([id, body.accountId]);
      if (body.accountId === "refused") {
        throw Object.assign(new Error("That account cannot run this agent."), {
          code: "INVALID_COMMAND"
        });
      }
      // `throw:<code>` refuses with that code, to pin the status of each one.
      if (body.accountId.startsWith("throw:")) {
        throw Object.assign(new Error(`Refused with ${body.accountId}.`), {
          code: body.accountId.slice("throw:".length)
        });
      }
      return { seq: 7 };
    },
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
    ["GET", agentChatRoutes.itemOutput("t1", "i1")],
    ["GET", agentChatRoutes.turnDiff("t1", 2)],
    ["GET", agentChatRoutes.history("t1")],
    ["GET", agentChatRoutes.providers],
    ["GET", agentChatRoutes.search],
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

test("a tool call's streamed output is proxied verbatim — the host's own 404 and an older host's route miss alike", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  const joined = { toolUseId: "bgshell:task-1", output: "one\n  two\n", complete: false, truncated: false };
  h.host.handler = (req, res) => {
    if (req.url?.includes("/items/gone/")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "ITEM_NOT_FOUND", message: "No tool call behind item 'gone'." } }));
    } else if (req.url?.includes("/items/old/")) {
      // A host that predates the route: its generic route miss, which the daemon does not interpret.
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "THREAD_NOT_FOUND", message: `No route for GET ${req.url}.` } }));
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(joined));
    }
  };
  const served = await h.app.inject({ method: "GET", url: agentChatRoutes.itemOutput("t1", "bgshell:task-1") });
  assert.equal(served.statusCode, 200);
  assert.deepEqual(served.json(), joined);
  // The id stays one encoded segment on the host's route too.
  assert.equal(h.host.requests[0].url, "/threads/t1/items/bgshell%3Atask-1/output");
  assert.equal(h.host.requests[0].method, "GET");
  assert.equal(h.host.requests[0].auth, "Bearer tok");

  const gone = await h.app.inject({ method: "GET", url: agentChatRoutes.itemOutput("t1", "gone") });
  assert.equal(gone.statusCode, 404);
  assert.deepEqual(gone.json(), { error: { code: "ITEM_NOT_FOUND", message: "No tool call behind item 'gone'." } });
  const old = await h.app.inject({ method: "GET", url: agentChatRoutes.itemOutput("t1", "old") });
  assert.equal(old.statusCode, 404);
  assert.deepEqual(old.json(), { error: { code: "THREAD_NOT_FOUND", message: "No route for GET /threads/t1/items/old/output." } });

  // An unknown tab never reaches the host.
  const ghost = await h.app.inject({ method: "GET", url: agentChatRoutes.itemOutput("ghost", "i1") });
  assert.equal(ghost.statusCode, 404);
  assert.equal(ghost.json().error.code, "THREAD_NOT_FOUND");
  assert.equal(h.host.requests.length, 3);
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

// --- §3.4 the account switch ----------------------------------------------

test("the account route is daemon-owned: it never hits the host socket itself", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.account("t1"),
    payload: { commandId: "c1", accountId: "acc-2" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { seq: 7 });
  assert.deepEqual(h.accountSwitches, [["t1", "acc-2"]]);
  assert.deepEqual(h.host.requests, [], "the daemon calls the host itself, not by proxy");
  await h.close();
});

test("a refused switch answers the §6.2 envelope with its own status", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  const response = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.account("t1"),
    payload: { commandId: "c1", accountId: "refused" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_COMMAND");
  await h.close();
});

test("the account route is 404 for an unknown tab and 503 while the host is down", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  const missing = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.account("nope"),
    payload: { commandId: "c1", accountId: "acc-2" }
  });
  assert.equal(missing.statusCode, 404);
  h.healthy = false;
  const down = await h.app.inject({
    method: "POST",
    url: agentChatRoutes.account("t1"),
    payload: { commandId: "c1", accountId: "acc-2" }
  });
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().error.code, "HOST_UNAVAILABLE");
  assert.deepEqual(h.accountSwitches, [], "nothing reached the service");
  await h.close();
});

test("a daemon-side refusal answers the §6.2 status of its code, INDEX_UNAVAILABLE included", async () => {
  // The account route is the one place the daemon maps a code onto a status
  // itself; a code must never fall through to a 409 it was not documented as.
  const h = await makeHarness({ t1: tab("t1") });
  const expected: Record<AgentChatErrorCode, number> = {
    INVALID_COMMAND: 400,
    THREAD_NOT_FOUND: 404,
    COMMAND_ID_CONFLICT: 409,
    COMMAND_REJECTED: 409,
    COMPACTION_UNAVAILABLE: 409,
    HOST_UNAVAILABLE: 503,
    INDEX_UNAVAILABLE: 503,
    ITEM_NOT_FOUND: 404
  };
  for (const code of AGENT_CHAT_ERROR_CODES) {
    const response = await h.app.inject({
      method: "POST",
      url: agentChatRoutes.account("t1"),
      payload: { commandId: "c1", accountId: `throw:${code}` }
    });
    assert.equal(response.statusCode, expected[code], code);
    assert.equal(response.json().error.code, code, code);
  }
  await h.close();
});

// --- indexed history and search (design 2026-09-23) ------------------------

const historyPage = {
  threadId: "t1",
  turns: [
    {
      turnId: "turn-3",
      ordinal: 3,
      userMessageId: "msg-3",
      requestedAt: "2026-09-23T10:00:00.000Z",
      startedAt: "2026-09-23T10:00:01.000Z",
      completedAt: "2026-09-23T10:02:00.000Z",
      rewindable: false
    }
  ],
  items: [],
  checkpoints: [],
  page: { beforeCursor: "eyJ0IjoidDEiLCJhIjoiMjAyNi0wOS0yMyIsImkiOiJ0dXJuLTMifQ" },
  seq: 88
} satisfies ThreadHistoryPage;

test("a history read forwards before/turns verbatim and passes the page through", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(historyPage));
  // Clamping is the host's, in one place: an out-of-range count crosses unchanged.
  const response = await h.app.inject({
    method: "GET",
    url: `${agentChatRoutes.history("t1")}?before=eyJ0IjoidDEifQ&turns=500`
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), historyPage);
  assert.equal(h.host.requests.length, 1);
  assert.equal(h.host.requests[0].method, "GET");
  assert.equal(h.host.requests[0].url, "/threads/t1/history?before=eyJ0IjoidDEifQ&turns=500");
  assert.equal(h.host.requests[0].auth, "Bearer tok");
  // The page names the thread's CURRENT seq but delivers only old turns:
  // noting it would move the tab's §6.3 reconnect cursor past live events the
  // client was never sent.
  assert.deepEqual(h.seqs, []);
  await h.close();
});

test("a history read with no query asks the host for the page below the window", async () => {
  // No cursor = "the turns just below the retained window", no count = the
  // host's default. The proxy invents neither.
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(historyPage));
  const response = await h.app.inject({ method: "GET", url: agentChatRoutes.history("t1") });
  assert.equal(response.statusCode, 200);
  assert.equal(h.host.requests[0].url, "/threads/t1/history");
  await h.close();
});

test("a history read for an unknown tab is 404 THREAD_NOT_FOUND and never reaches the host", async () => {
  const h = await makeHarness({ t1: tab("t1") });
  const response = await h.app.inject({ method: "GET", url: agentChatRoutes.history("ghost") });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "THREAD_NOT_FOUND");
  assert.equal(h.host.requests.length, 0);
  await h.close();
});

test("a search forwards q/limit/projectPath verbatim, and only those", async () => {
  // Host-level, like `providers`: no tab is needed. Quoting `q` for the FTS
  // parser and clamping are the host's job — the proxy must deliver exactly
  // the characters that make that job matter.
  const h = await makeHarness();
  const answer = {
    query: "x",
    hits: [
      {
        threadId: "t1",
        projectPath: "/w/my project",
        title: "Refactor",
        turnId: "turn-3",
        ordinal: 3,
        kind: "message",
        id: "msg-3",
        role: "assistant",
        activityKind: null,
        snippet: "say «héllo» wörld",
        at: "2026-09-23T10:02:00.000Z",
        seq: 41
      }
    ],
    truncated: false,
    indexed: true
  } satisfies ThreadSearchResponse;
  h.host.handler = (_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  const q = 'say "héllo" wörld* NEAR(a b) + 100%';
  const query = new URLSearchParams({ q, limit: "7", projectPath: "/w/my project", after: "3" });
  const response = await h.app.inject({ method: "GET", url: `${agentChatRoutes.search}?${query}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), answer);
  assert.equal(h.host.requests.length, 1);
  assert.equal(h.host.requests[0].method, "GET");
  assert.equal(h.host.requests[0].auth, "Bearer tok");
  const forwarded = new URL(h.host.requests[0].url, "http://agent-host.localhost");
  assert.equal(forwarded.pathname, "/search");
  assert.deepEqual(
    [...forwarded.searchParams],
    [
      ["q", q],
      ["limit", "7"],
      ["projectPath", "/w/my project"]
    ]
  );
  await h.close();
});

test("the host's INDEX_UNAVAILABLE 503 passes through verbatim on history and search", async () => {
  // A host without a usable index (driver missing, file being rebuilt)
  // answers it itself; the client sees the host's envelope, not one the
  // proxy made up.
  const h = await makeHarness({ t1: tab("t1") });
  const envelope = {
    error: { code: "INDEX_UNAVAILABLE", message: "The thread index is being rebuilt." }
  };
  h.host.handler = (_req, res) =>
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify(envelope));
  for (const url of [agentChatRoutes.history("t1"), `${agentChatRoutes.search}?q=x`]) {
    const response = await h.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 503, url);
    assert.deepEqual(response.json(), envelope, url);
  }
  assert.equal(h.host.requests.length, 2);
  await h.close();
});

test("a host that predates the index (404 on /search) answers the unavailable search shape", async () => {
  // Until its drain-restart, a surviving older host answers `/search` with its
  // generic route-miss 404 — a current host never 404s there. The palette must
  // read "unavailable on this host", not a failure. History keeps passing the
  // host's 404 through: there it can also mean a missing thread.
  const h = await makeHarness({ t1: tab("t1") });
  h.host.handler = (req, res) =>
    res.writeHead(404, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: { code: "THREAD_NOT_FOUND", message: `No route for GET ${req.url?.split("?")[0]}.` }
      })
    );

  const long = "ü".repeat(THREAD_SEARCH_MAX_QUERY_CHARS + 50);
  const clamped = await h.app.inject({
    method: "GET",
    url: `${agentChatRoutes.search}?${new URLSearchParams({ q: long, limit: "5" })}`
  });
  assert.equal(clamped.statusCode, 200);
  assert.deepEqual(clamped.json(), {
    query: "ü".repeat(THREAD_SEARCH_MAX_QUERY_CHARS),
    hits: [],
    truncated: false,
    indexed: false
  } satisfies ThreadSearchResponse);

  const bare = await h.app.inject({ method: "GET", url: agentChatRoutes.search });
  assert.equal(bare.statusCode, 200);
  assert.deepEqual(bare.json(), { query: "", hits: [], truncated: false, indexed: false });
  assert.equal(h.host.requests.length, 2, "the host was still asked both times");

  const history = await h.app.inject({ method: "GET", url: agentChatRoutes.history("t1") });
  assert.equal(history.statusCode, 404);
  assert.deepEqual(history.json(), {
    error: { code: "THREAD_NOT_FOUND", message: "No route for GET /threads/t1/history." }
  });
  await h.close();
});
