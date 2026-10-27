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

import { registerSecretRequestRoutes, SecretRequestRegistry } from "./secret-requests.ts";

const VALUE = "hunter2-but-longer-0815";
const INPUT = { name: "API_KEY", prompt: "Paste your API key.", purpose: "Call the API" };

function registry() {
  const events: AgentChatSecretRequestEventPayload[] = [];
  const waiters: Array<(payload: AgentChatSecretRequestEventPayload) => void> = [];
  const created = new SecretRequestRegistry({
    publish: (payload) => {
      events.push(payload);
      for (const waiter of waiters.splice(0)) waiter(payload);
    }
  });
  /** The next published event — the open of a request just made. */
  const next = () => new Promise<AgentChatSecretRequestEventPayload>((resolve) => waiters.push(resolve));
  return { registry: created, events, next };
}

describe("secret requests — the wait", () => {
  it("hands the value to the waiting call, once, and publishes only the request", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T10:00:00.000Z") });
    const { registry: requests, events, next } = registry();
    const opened = next();
    const answer = requests.request("t1", INPUT, new AbortController().signal);
    const { request } = await opened;
    assert.deepEqual(requests.list("t1"), [request]);
    assert.deepEqual(requests.list("other"), []);
    assert.equal(await requests.answer("t1", request.requestId, { answer: "provide", value: VALUE }), "provided");
    assert.deepEqual(await answer, { outcome: "provided", value: VALUE });
    // Answered once: a second answer finds nothing, and nothing is held.
    assert.equal(await requests.answer("t1", request.requestId, { answer: "provide", value: "again" }), null);
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
      requestId: request.requestId,
      sessionId: "t1",
      name: "API_KEY",
      prompt: "Paste your API key.",
      purpose: "Call the API",
      createdAt: "2026-10-14T10:00:00.000Z"
    });
  });

  it("only the asking thread can answer its card", async () => {
    const { registry: requests, next } = registry();
    const opened = next();
    const controller = new AbortController();
    const answer = requests.request("t1", INPUT, controller.signal);
    const { request } = await opened;
    assert.equal(await requests.answer("t2", request.requestId, { answer: "decline" }), null);
    assert.equal(requests.list("t1").length, 1);
    controller.abort();
    assert.deepEqual(await answer, { outcome: "cancelled" });
  });

  it("declining and the call ending each close the card", async () => {
    const { registry: requests, events, next } = registry();
    // Declined.
    let opened = next();
    const declined = requests.request("t1", INPUT, new AbortController().signal);
    assert.equal(await requests.answer("t1", (await opened).request.requestId, { answer: "decline" }), "declined");
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
  });

  it("the deadline closes a card nobody answers", async (t) => {
    // Mocked timers: the registry's deadline timer is unref'd (it must never hold the daemon
    // open), so with real timers it is the only thing left in this test's event loop and Node
    // may end the loop before it fires — the test then fails "event loop already resolved".
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = registry();
    const waiting = h.registry.request("t1", INPUT, new AbortController().signal);
    t.mock.timers.tick(10 * 60_000 - 1);
    assert.equal(h.registry.list("t1").length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await waiting, { outcome: "timed_out" });
    assert.deepEqual(h.registry.list("t1"), []);
    assert.deepEqual(h.events.map((event) => [event.open, event.outcome]), [[true, undefined], [false, "timed_out"]]);
  });
});

describe("secret requests — delivery", () => {
  it("a provided answer the call can no longer hand over is reported not delivered, and the card closes cancelled", async () => {
    const { registry: requests, events, next } = registry();
    let markDelivered!: (delivered: boolean) => void;
    const delivered = new Promise<boolean>((resolve) => {
      markDelivered = resolve;
    });
    const opened = next();
    const call = requests.request("t1", INPUT, new AbortController().signal, delivered);
    const { request } = await opened;
    const answered = requests.answer("t1", request.requestId, { answer: "provide", value: VALUE });
    // The handler got it, but its result never left the daemon (the route answered 499).
    assert.deepEqual(await call, { outcome: "provided", value: VALUE });
    markDelivered(false);
    assert.equal(await answered, "not_delivered");
    assert.deepEqual(events.at(-1)?.open, false);
    assert.equal(events.at(-1)?.outcome, "cancelled");
  });

  it("and is reported provided once the route handed the result over", async () => {
    const { registry: requests, events, next } = registry();
    const opened = next();
    const call = requests.request("t1", INPUT, new AbortController().signal, Promise.resolve(true));
    const { request } = await opened;
    assert.equal(await requests.answer("t1", request.requestId, { answer: "provide", value: VALUE }), "provided");
    await call;
    assert.equal(events.at(-1)?.outcome, "provided");
  });
});

describe("secret requests — an unconfirmed delivery", () => {
  it("a result that has not left the daemon within the bound is reported unconfirmed, never not-delivered", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: AgentChatSecretRequestEventPayload[] = [];
    const waiters: Array<() => void> = [];
    const requests = new SecretRequestRegistry({
      publish: (payload) => {
        events.push(payload);
        for (const waiter of waiters.splice(0)) waiter();
      }
    });
    const opened = new Promise<void>((resolve) => waiters.push(resolve));
    // The route never says either way (a stalled socket).
    const call = requests.request("t1", INPUT, new AbortController().signal, new Promise<boolean>(() => {}));
    await opened;
    const outcome = requests.answer("t1", events[0]!.request.requestId, { answer: "provide", value: VALUE });
    t.mock.timers.tick(30_000);
    assert.equal(await outcome, "unconfirmed");
    assert.deepEqual(await call, { outcome: "provided", value: VALUE }, "the call did receive it");
    assert.equal(events.at(-1)?.outcome, "provided", "handed to the call");
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
      payload: { answer: "provide", value: ` ${VALUE} ` }
    });
    assert.equal(posted.statusCode, 200);
    assert.deepEqual(posted.json(), { ok: true, outcome: "provided" });
    assert.deepEqual(await answer, { outcome: "provided", value: ` ${VALUE} ` }, "delivered exactly as typed");

    const again = await server.inject({
      method: "POST",
      url: agentChatRoutes.secretRequest("t1", request.requestId),
      payload: { answer: "provide", value: VALUE }
    });
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error.code, "SECRET_REQUEST_NOT_FOUND");
    assert.ok(!again.body.includes(VALUE));

    const declined = requests.request("t1", INPUT, new AbortController().signal);
    const card = requests.list("t1")[0]!;
    const declineResponse = await server.inject({
      method: "POST",
      url: agentChatRoutes.secretRequest("t1", card.requestId),
      payload: { answer: "decline", value: VALUE }
    });
    assert.deepEqual(declineResponse.json(), { ok: true, outcome: "declined" });
    assert.deepEqual(await declined, { outcome: "declined" });

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
      null,
      "provide",
      { answer: "provide", value: "   " },
      { answer: "provide", value: `${VALUE}${"x".repeat(SECRET_VALUE_MAX_CHARS)}` },
      { answer: "provide" },
      { answer: "maybe", value: VALUE },
      [VALUE]
    ]) {
      const response = await server.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
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

  it("an answer the agent stopped waiting for is 409 SECRET_NOT_DELIVERED, never echoed", async () => {
    const { server, requests, next, logs } = await app();
    const opened = next();
    void requests.request("t1", INPUT, new AbortController().signal, Promise.resolve(false));
    const { request } = await opened;
    const response = await server.inject({
      method: "POST",
      url: agentChatRoutes.secretRequest("t1", request.requestId),
      payload: { answer: "provide", value: VALUE }
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "SECRET_NOT_DELIVERED");
    assert.ok(!response.body.includes(VALUE));
    await server.close();
    assert.ok(!logs.join("").includes(VALUE));
  });
});
