/**
 * The daemon's `request_secret` cards (design 2026-10-14 §5 "Secrets"): the
 * wait and its endings, and the answer routes — the value goes to the waiting
 * call and to no response, bus event or log line.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import Fastify from "fastify";
import {
  agentChatRoutes,
  SECRET_VALUE_MAX_CHARS,
  type AgentChatSecretRequestEventPayload
} from "@orquester/api/agent-chat";

import { parseSecretAnswer, registerSecretRequestRoutes, SecretRequestRegistry } from "./secret-requests.ts";

const VALUE = "hunter2-but-longer-0815";
const INPUT = { name: "API_KEY", prompt: "Paste your API key.", purpose: "Call the API" };

function registry(options: { timeoutMs?: number } = {}) {
  const events: AgentChatSecretRequestEventPayload[] = [];
  const waiters: Array<(payload: AgentChatSecretRequestEventPayload) => void> = [];
  let n = 0;
  const created = new SecretRequestRegistry({
    publish: (payload) => {
      events.push(payload);
      for (const waiter of waiters.splice(0)) waiter(payload);
    },
    newId: () => `req-${(n += 1)}`,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  });
  /** The next published event — the open of a request just made. */
  const next = () => new Promise<AgentChatSecretRequestEventPayload>((resolve) => waiters.push(resolve));
  return { registry: created, events, next };
}

describe("secret requests — the wait", () => {
  it("hands the value to the waiting call, once, and publishes only the request", async () => {
    const { registry: requests, events, next } = registry();
    const opened = next();
    const answer = requests.request("t1", INPUT, new AbortController().signal);
    const { request } = await opened;
    assert.deepEqual(requests.list("t1"), [request]);
    assert.deepEqual(requests.list("other"), []);
    assert.equal(requests.answer("t1", request.requestId, { answer: "provide", value: VALUE }), true);
    assert.deepEqual(await answer, { outcome: "provided", value: VALUE });
    // Answered once: a second answer finds nothing, and nothing is held.
    assert.equal(requests.answer("t1", request.requestId, { answer: "provide", value: "again" }), false);
    assert.deepEqual(requests.list("t1"), []);
    assert.deepEqual(
      events.map((event) => [event.open, event.outcome]),
      [
        [true, undefined],
        [false, "provided"]
      ]
    );
    assert.ok(!JSON.stringify(events).includes(VALUE), "the bus never carries the value");
    assert.deepEqual(events[0]?.request, {
      requestId: "req-1",
      sessionId: "t1",
      name: "API_KEY",
      prompt: "Paste your API key.",
      purpose: "Call the API",
      createdAt: events[0]?.request.createdAt
    });
  });

  it("only the asking thread can answer its card", async () => {
    const { registry: requests, next } = registry();
    const opened = next();
    const controller = new AbortController();
    const answer = requests.request("t1", INPUT, controller.signal);
    const { request } = await opened;
    assert.equal(requests.answer("t2", request.requestId, { answer: "decline" }), false);
    assert.equal(requests.list("t1").length, 1);
    controller.abort();
    assert.deepEqual(await answer, { outcome: "cancelled" });
  });

  it("declining, the call ending and the deadline each close the card", async () => {
    const { registry: requests, events, next } = registry();
    // Declined.
    let opened = next();
    const declined = requests.request("t1", INPUT, new AbortController().signal);
    requests.answer("t1", (await opened).request.requestId, { answer: "decline" });
    assert.deepEqual(await declined, { outcome: "declined" });
    // Cancelled: the provider cancelled, the turn was stopped, the session ended.
    const controller = new AbortController();
    opened = next();
    const cancelled = requests.request("t1", INPUT, controller.signal);
    await opened;
    controller.abort();
    assert.deepEqual(await cancelled, { outcome: "cancelled" });
    // Already aborted: no card at all.
    const before = events.length;
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await requests.request("t1", INPUT, aborted.signal), { outcome: "cancelled" });
    assert.equal(events.length, before);
    assert.deepEqual(
      events.filter((event) => !event.open).map((event) => event.outcome),
      ["declined", "cancelled"]
    );
    // Timed out: the registry's own deadline (5 ms here) ends a card nobody answers.
    const short = registry({ timeoutMs: 5 });
    assert.deepEqual(await short.registry.request("t1", INPUT, new AbortController().signal), { outcome: "timed_out" });
    assert.deepEqual(short.registry.list("t1"), []);
    assert.deepEqual(short.events.map((event) => [event.open, event.outcome]), [[true, undefined], [false, "timed_out"]]);
  });
});

describe("secret requests — the routes", () => {
  async function app() {
    const logs: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
    // The daemon's own logger settings (index.ts): info level, method + url only.
    const server = Fastify({
      logger: {
        level: "info",
        stream,
        serializers: { req: (request: { method: string; url: string }) => ({ method: request.method, url: request.url }) }
      }
    });
    const { registry: requests, next } = registry();
    registerSecretRequestRoutes(server, { registry: requests, isChatSession: (id) => id === "t1" || id === "t2" });
    await server.ready();
    return { server, requests, next, logs };
  }

  it("lists the thread's cards and takes an answer without ever echoing it", async () => {
    const { server, requests, next, logs } = await app();
    const opened = next();
    const answer = requests.request("t1", INPUT, new AbortController().signal);
    const { request } = await opened;

    const list = await server.inject({ method: "GET", url: agentChatRoutes.secretRequests("t1") });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { requests: [request] });
    assert.deepEqual((await server.inject({ method: "GET", url: agentChatRoutes.secretRequests("t2") })).json(), { requests: [] });
    assert.equal((await server.inject({ method: "GET", url: agentChatRoutes.secretRequests("nope") })).statusCode, 404);

    // Another thread's id cannot answer it.
    const wrong = await server.inject({
      method: "POST",
      url: agentChatRoutes.secretRequest("t2", request.requestId),
      payload: { answer: "provide", value: VALUE }
    });
    assert.equal(wrong.statusCode, 404);
    assert.ok(!wrong.body.includes(VALUE));

    const posted = await server.inject({
      method: "POST",
      url: agentChatRoutes.secretRequest("t1", request.requestId),
      payload: { answer: "provide", value: `  ${VALUE}\n` }
    });
    assert.equal(posted.statusCode, 200);
    assert.deepEqual(posted.json(), { ok: true, outcome: "provided" });
    assert.deepEqual(await answer, { outcome: "provided", value: VALUE }, "trimmed, delivered");

    const again = await server.inject({
      method: "POST",
      url: agentChatRoutes.secretRequest("t1", request.requestId),
      payload: { answer: "provide", value: VALUE }
    });
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error.code, "SECRET_REQUEST_NOT_FOUND");
    assert.ok(!again.body.includes(VALUE));

    await server.close();
    assert.ok(logs.length > 0, "the server logged its requests");
    assert.ok(!logs.join("").includes(VALUE), "no log line holds the value");
  });

  it("refuses a malformed answer without quoting it, and keeps the card", async () => {
    const { server, requests, next, logs } = await app();
    const opened = next();
    const controller = new AbortController();
    const answer = requests.request("t1", INPUT, controller.signal);
    const { request } = await opened;
    const url = agentChatRoutes.secretRequest("t1", request.requestId);
    for (const payload of [
      { answer: "provide", value: "   " },
      { answer: "provide", value: `${VALUE}${"x".repeat(SECRET_VALUE_MAX_CHARS)}` },
      { answer: "provide" },
      { answer: "maybe", value: VALUE },
      [VALUE]
    ]) {
      const response = await server.inject({ method: "POST", url, payload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "INVALID_ARGUMENT");
      assert.ok(!response.body.includes(VALUE));
    }
    // Not JSON at all: Fastify's own refusal, which never quotes the body either.
    const broken = await server.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: `{"value":"${VALUE}"` });
    assert.equal(broken.statusCode, 400);
    assert.ok(!broken.body.includes(VALUE));
    assert.equal(requests.list("t1").length, 1, "a refused answer leaves the card open");
    controller.abort();
    assert.deepEqual(await answer, { outcome: "cancelled" });
    await server.close();
    assert.ok(!logs.join("").includes(VALUE), "no log line holds the value");
  });

  it("parses exactly the two answers", () => {
    assert.deepEqual(parseSecretAnswer({ answer: "decline", value: "ignored" }), { answer: "decline" });
    assert.deepEqual(parseSecretAnswer({ answer: "provide", value: " v " }), { answer: "provide", value: "v" });
    assert.equal(parseSecretAnswer(null), null);
    assert.equal(parseSecretAnswer("provide"), null);
  });
});
