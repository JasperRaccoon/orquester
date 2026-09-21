/**
 * The generic ACP peer: framing, duplex dispatch, deadlines, the extension
 * registry, the unknown-method fallback and transport death.
 *
 * Every test drives the peer through an injected transport — no child process
 * — and waits on events rather than sleeps (§9).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ACP_ERROR_CODES, AcpRpcError, AcpTransportClosedError } from "./errors.ts";
import { AcpPeer, summarisePayload, unwrapExtensionParams } from "./peer.ts";

interface Harness {
  peer: AcpPeer;
  sent: Array<Record<string, unknown>>;
  warnings: Array<{ message: string; detail?: unknown }>;
  /** Feed a frame as if the agent had written it. */
  recv(frame: unknown): void;
  /** Answer the last request with a result. */
  reply(result: unknown): void;
  replyError(error: { code: number; message: string; data?: unknown }): void;
}

function harness(): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const warnings: Array<{ message: string; detail?: unknown }> = [];
  const peer = new AcpPeer({
    send: (line) => {
      sent.push(JSON.parse(line) as Record<string, unknown>);
    },
    onWarning: (message, detail) => {
      warnings.push({ message, detail });
    },
    defaultTimeoutMs: 0
  });
  const lastId = (): number => {
    const outbound = [...sent].reverse().find((frame) => typeof frame["id"] === "number" && "method" in frame);
    return outbound?.["id"] as number;
  };
  return {
    peer,
    sent,
    warnings,
    recv: (frame) => peer.handleLine(JSON.stringify(frame)),
    reply: (result) => peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: lastId(), result })),
    replyError: (error) => peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: lastId(), error }))
  };
}

// ---------------------------------------------------------------------- framing

test("a request is framed as JSON-RPC 2.0 with an incrementing numeric id", async () => {
  const h = harness();
  const first = h.peer.request("initialize", { protocolVersion: 1 });
  const second = h.peer.request("session/new", { cwd: "/tmp" });
  assert.deepEqual(h.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 }
  });
  assert.equal(h.sent[1]["id"], 2);
  h.peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }));
  h.peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: 2 } }));
  assert.deepEqual(await first, { ok: 1 });
  assert.deepEqual(await second, { ok: 2 });
});

test("a notification carries NO id and no extra keys", () => {
  const h = harness();
  h.peer.notify("session/cancel", { sessionId: "s1" });
  assert.deepEqual(h.sent[0], { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
  assert.equal("id" in h.sent[0], false, "Grok drops a notification that carries an id");
});

test("a malformed line is surfaced and the stream keeps going", () => {
  const h = harness();
  h.peer.handleLine("{not json");
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0].message, /unparsable/);
  // The next line still parses: a bad frame must not tear down the session.
  let seen = false;
  h.peer.onNotification("session/update", () => {
    seen = true;
  });
  h.recv({ jsonrpc: "2.0", method: "session/update", params: {} });
  assert.equal(seen, true);
});

test("a blank line is ignored without a warning", () => {
  const h = harness();
  h.peer.handleLine("   ");
  assert.equal(h.warnings.length, 0);
});

// ---------------------------------------------------------------- duplex

test("an inbound request with id 0 is a request, not a notification", async () => {
  const h = harness();
  h.peer.onRequest("session/request_permission", async () => await Promise.resolve({ outcome: { outcome: "cancelled" } }));
  h.recv({ jsonrpc: "2.0", id: 0, method: "session/request_permission", params: {} });
  await tick();
  assert.deepEqual(h.sent[0], {
    jsonrpc: "2.0",
    id: 0,
    result: { outcome: { outcome: "cancelled" } }
  });
});

test("the inbound id is echoed verbatim, string or number", async () => {
  const h = harness();
  h.peer.onRequest("ping", async () => await Promise.resolve({}));
  h.recv({ jsonrpc: "2.0", id: "abc", method: "ping" });
  await tick();
  assert.equal(h.sent[0]["id"], "abc");
});

test("a slow request handler does not block the read loop", async () => {
  const h = harness();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.peer.onRequest("session/request_permission", async () => {
    await blocked;
    return { outcome: { outcome: "cancelled" } };
  });
  const notifications: unknown[] = [];
  h.peer.onNotification("session/update", (params) => notifications.push(params));

  h.recv({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: {} });
  // The permission card is open; frames must keep arriving.
  h.recv({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
  h.recv({ jsonrpc: "2.0", method: "session/update", params: { n: 2 } });
  assert.equal(notifications.length, 2, "an open approval must not stall the pipe");
  release();
  await tick();
  assert.equal(h.sent.length, 1);
});

test("a handler that throws answers -32603 rather than dying", async () => {
  const h = harness();
  h.peer.onRequest("boom", async () => {
    await Promise.resolve();
    throw new Error("nope");
  });
  h.recv({ jsonrpc: "2.0", id: 4, method: "boom" });
  await tick();
  assert.deepEqual(h.sent[0]["error"], { code: ACP_ERROR_CODES.internalError, message: "nope" });
});

test("a handler may choose its own JSON-RPC code", async () => {
  const h = harness();
  h.peer.onRequest("boom", async () => {
    await Promise.resolve();
    throw new AcpRpcError("boom", { code: -32602, message: "Invalid params", data: "bad" });
  });
  h.recv({ jsonrpc: "2.0", id: 5, method: "boom" });
  await tick();
  const error = h.sent[0]["error"] as Record<string, unknown>;
  assert.equal(error["code"], -32602);
  assert.equal(error["data"], "bad");
});

// ---------------------------------------------------------- unknown methods

test("an unknown inbound REQUEST is answered -32601 and warned about", async () => {
  const h = harness();
  h.recv({ jsonrpc: "2.0", id: 9, method: "orquester/definitely_not_a_method", params: { hello: "world" } });
  await tick();
  assert.deepEqual(h.sent[0], {
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32601, message: "Method not found" }
  });
  assert.match(h.warnings[0].message, /unknown method/);
});

test("an unknown inbound NOTIFICATION is warned about and not answered", () => {
  const h = harness();
  h.recv({ jsonrpc: "2.0", method: "_x.ai/brand_new_thing", params: { a: 1 } });
  assert.equal(h.sent.length, 0);
  assert.match(h.warnings[0].message, /unhandled notification/);
});

test("the warning summarises the payload rather than copying it", () => {
  const h = harness();
  h.recv({
    jsonrpc: "2.0",
    method: "_x.ai/brand_new_thing",
    params: { secret: "x".repeat(400), list: [1, 2, 3] }
  });
  const detail = JSON.stringify(h.warnings[0].detail);
  assert.equal(detail.includes("xxxx"), false, "a payload must never be logged raw");
  assert.match(detail, /string\(400\)/);
  assert.match(detail, /array\(3\)/);
});

test("summarisePayload keeps shapes and drops values", () => {
  assert.deepEqual(summarisePayload({ a: "short", b: 1, c: null, d: {} }), {
    a: '"short"',
    b: "1",
    c: "null",
    d: "object(0)"
  });
});

// -------------------------------------------------------------- extensions

test("an extension is registered under BOTH spellings", async () => {
  const h = harness();
  const seen: string[] = [];
  h.peer.registerExtension("x.ai/exit_plan_mode", async (params) => {
    seen.push((params as { toolCallId: string }).toolCallId);
    return await Promise.resolve({ outcome: "abandoned" });
  });
  h.recv({ jsonrpc: "2.0", id: 1, method: "x.ai/exit_plan_mode", params: { toolCallId: "a" } });
  h.recv({ jsonrpc: "2.0", id: 2, method: "_x.ai/exit_plan_mode", params: { toolCallId: "b" } });
  await tick();
  assert.deepEqual(seen, ["a", "b"], "1.0.34 uses the underscore spelling only; both must work");
});

test("wrapped {method, params} is unwrapped, and a payload with its own `method` is not", () => {
  assert.deepEqual(
    unwrapExtensionParams({ method: "_x.ai/exit_plan_mode", params: { toolCallId: "a" } }, "x.ai/exit_plan_mode"),
    { toolCallId: "a" }
  );
  const passthrough = { method: "something-else", params: { a: 1 } };
  assert.deepEqual(unwrapExtensionParams(passthrough, "x.ai/exit_plan_mode"), passthrough);
  assert.deepEqual(unwrapExtensionParams({ toolCallId: "a" }, "x.ai/exit_plan_mode"), { toolCallId: "a" });
});

// ----------------------------------------------------- errors and deadlines

test("an error response becomes a typed AcpRpcError carrying data", async () => {
  const h = harness();
  const promise = h.peer.request("session/set_model", { modelId: "grok-build" });
  h.replyError({ code: -32602, message: "Invalid params", data: "unknown model id" });
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  );
  assert.ok(error instanceof AcpRpcError);
  assert.equal(error.code, -32602);
  assert.equal(error.data, "unknown model id");
  assert.equal(error.method, "session/set_model");
  assert.match(error.message, /unknown model id/);
});

test("a request deadline rejects and sends nothing to the peer", async () => {
  const h = harness();
  const before = h.sent.length;
  const error = await h.peer.request("session/load", {}, { timeoutMs: 1 }).then(
    () => null,
    (reason: unknown) => reason
  );
  assert.ok(error instanceof AcpRpcError);
  assert.match(error.message, /timed out/);
  assert.equal(h.sent.length, before + 1, "no cancel frame is invented for a timeout");
});

test("a reply after the deadline is a warning, not a crash", async () => {
  const h = harness();
  await h.peer.request("session/load", {}, { timeoutMs: 1 }).catch(() => undefined);
  h.reply({ late: true });
  assert.ok(h.warnings.some((warning) => /unknown request id/.test(warning.message)));
});

test("transport death fails every in-flight request exactly once, then fails fast", async () => {
  const h = harness();
  const a = h.peer.request("session/prompt", {});
  const b = h.peer.request("session/new", {});
  h.peer.close("grok: child exited with code 143");
  const [aError, bError] = await Promise.all([
    a.then(() => null, (reason: unknown) => reason),
    b.then(() => null, (reason: unknown) => reason)
  ]);
  assert.ok(aError instanceof AcpTransportClosedError);
  assert.ok(bError instanceof AcpTransportClosedError);
  assert.equal(h.peer.inFlightCount, 0);

  const after = await h.peer.request("session/prompt", {}).then(
    () => null,
    (reason: unknown) => reason
  );
  assert.ok(after instanceof AcpTransportClosedError, "a later send fails fast");
  h.peer.close("second");
  assert.equal(h.peer.isClosed, true);
});

test("an aborted request rejects with the signal's reason", async () => {
  const h = harness();
  const controller = new AbortController();
  const promise = h.peer.request("session/prompt", {}, { signal: controller.signal });
  controller.abort(new Error("stopping"));
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  );
  assert.equal((error as Error).message, "stopping");
});

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
