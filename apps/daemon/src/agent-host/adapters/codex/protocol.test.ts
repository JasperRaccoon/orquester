/**
 * Codex adapter — the NDJSON peer (spec §4.5 "Transport", §3.1).
 *
 * Driven over in-memory streams: the framing, the two independent id spaces,
 * the 32 in-flight cap and the terminate-once rule are the units under test.
 */

import assert from "node:assert/strict";
import { PassThrough, type Writable } from "node:stream";
import { describe, it } from "node:test";

import {
  CodexPeer,
  CodexRequestRefusal,
  CodexRequestWithdrawn,
  CodexRpcError,
  CodexTransportClosedError,
  isNoActiveTurnError
} from "./protocol.ts";

interface Harness {
  peer: CodexPeer;
  /** Frames the peer wrote to the child's stdin. */
  sent: Record<string, unknown>[];
  /** Deliver one server→client frame. */
  deliver(frame: unknown): void;
  deliverRaw(text: string): void;
  notifications: { method: string; params: unknown }[];
  unknown: { frame: unknown; reason: string }[];
  malformed: { line: string }[];
  requests: { resolve: (value: unknown) => void; reject: (error: unknown) => void; method: string }[];
}

function harness(
  options: {
    onRequest?: (method: string, params: unknown) => Promise<object>;
  } = {}
): Harness {
  const stdout = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  const notifications: Harness["notifications"] = [];
  const unknown: Harness["unknown"] = [];
  const malformed: Harness["malformed"] = [];
  const requests: Harness["requests"] = [];

  const stdin = {
    destroyed: false,
    writableEnded: false,
    write(chunk: string): boolean {
      for (const line of chunk.split("\n")) {
        if (line.trim().length > 0) {
          sent.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      return true;
    }
  } as unknown as Writable;

  const peer = new CodexPeer({
    stdin,
    stdout,
    handlers: {
      onRequest: (request) => {
        if (options.onRequest !== undefined) {
          return options.onRequest(request.method, request.params) as Promise<never>;
        }
        return new Promise<unknown>((resolve, reject) => {
          requests.push({ resolve, reject, method: request.method });
        }) as Promise<never>;
      },
      onNotification: (method, params) => {
        notifications.push({ method, params });
      },
      onUnknownFrame: (frame, reason) => {
        unknown.push({ frame, reason });
      },
      onMalformedLine: (line) => {
        malformed.push({ line });
      }
    }
  });

  return {
    peer,
    sent,
    deliver: (frame) => stdout.write(`${JSON.stringify(frame)}\n`),
    deliverRaw: (text) => stdout.write(text),
    notifications,
    unknown,
    malformed,
    requests
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("codex transport — framing", () => {
  it("writes {id, method, params} with NO jsonrpc field", async () => {
    const h = harness();
    const params = { clientInfo: { name: "x", title: null, version: "1" }, capabilities: null };
    const pending = h.peer.request("initialize", params);
    assert.deepEqual(h.sent[0], { id: 1, method: "initialize", params });
    h.deliver({ id: 1, result: { userAgent: "orquester/0.154.0" } });
    await pending;
  });

  it("omits params entirely on a notification that takes none", async () => {
    const h = harness();
    h.peer.notify("initialized");
    await tick();
    assert.deepEqual(h.sent[0], { method: "initialized" });
  });

  it("resolves a response and rejects an error with the method named", async () => {
    const h = harness();
    const ok = h.peer.request("thread/compact/start", { threadId: "t" });
    h.deliver({ id: 1, result: {} });
    assert.deepEqual(await ok, {});

    const bad = h.peer.request("turn/interrupt", { threadId: "t", turnId: "x" });
    h.deliver({ id: 2, error: { code: -32600, message: "no active turn to interrupt" } });
    const error = await bad.catch((e: unknown) => e);
    assert.ok(error instanceof CodexRpcError);
    assert.equal(error.code, -32600);
    assert.equal(error.method, "turn/interrupt");
    assert.match(error.message, /no active turn to interrupt/);
  });

  it("isNoActiveTurnError separates the benign race from a real failure", async () => {
    // Both arrive as `-32600` from the SAME method, so a code-only test would
    // call a malformed request of ours a successful Stop (V1).
    const h = harness();
    const reject = (message: string): Promise<unknown> => {
      const pending = h.peer.request("turn/interrupt", { threadId: "t", turnId: "x" });
      h.deliver({ id: h.sent.length, error: { code: -32600, message } });
      return pending.catch((error: unknown) => error);
    };

    assert.equal(isNoActiveTurnError(await reject("no active turn to interrupt")), true);
    assert.equal(isNoActiveTurnError(await reject("unknown turn id")), true);
    assert.equal(isNoActiveTurnError(await reject("Invalid request: missing field `turnId`")), false);
    assert.equal(isNoActiveTurnError(await reject("stream disconnected before completion")), false);

    // Not every rejection is even an RPC error — a transport teardown or a
    // deadline must never be mistaken for "already settled".
    assert.equal(isNoActiveTurnError(new Error("no active turn to interrupt")), false);
    assert.equal(isNoActiveTurnError(new CodexTransportClosedError("child exited")), false);
    assert.equal(isNoActiveTurnError(undefined), false);
  });

  it("reports a malformed line instead of taking the read loop down", async () => {
    const h = harness();
    h.deliverRaw("not json\n");
    h.deliver({ method: "warning", params: { threadId: null, message: "still alive" } });
    await tick();
    assert.equal(h.malformed.length, 1);
    assert.equal(h.notifications.length, 1);
  });

  it("surfaces a frame that is neither request, response nor notification", async () => {
    const h = harness();
    h.deliver({ something: "else" });
    h.deliver([1, 2, 3]);
    await tick();
    assert.equal(h.unknown.length, 2);
  });
});

describe("codex transport — the two id spaces are independent", () => {
  it("a server request sharing our request id cannot resolve it", async () => {
    const h = harness({ onRequest: () => Promise.resolve({ decision: "accept" }) });
    // Both directions may use the same numeric id (fixtures README obs. 15).
    const pending = h.peer.request("thread/compact/start", { threadId: "t" });
    h.deliver({ id: 1, method: "item/fileChange/requestApproval", params: { threadId: "t" } });
    await tick();
    await tick();
    // The server request was answered, and our request is still parked.
    assert.deepEqual(h.sent.at(-1), { id: 1, result: { decision: "accept" } });
    h.deliver({ id: 1, result: { from: "server response" } });
    assert.deepEqual(await pending, { from: "server response" });
  });

  it("a response for an unknown id is surfaced, not silently dropped", async () => {
    const h = harness();
    h.deliver({ id: 99, result: {} });
    await tick();
    assert.match(h.unknown[0]!.reason, /unknown request id 99/);
  });
});

describe("codex transport — inbound requests", () => {
  it("does not block the read loop while a handler is parked", async () => {
    const h = harness();
    h.deliver({ id: 0, method: "item/commandExecution/requestApproval", params: {} });
    await tick();
    assert.equal(h.requests.length, 1, "the handler is running");
    // A notification delivered while the approval is parked still arrives.
    h.deliver({ method: "warning", params: { threadId: null, message: "meanwhile" } });
    await tick();
    assert.equal(h.notifications.length, 1);
    h.requests[0]!.resolve({ decision: "accept" });
    await tick();
    assert.deepEqual(h.sent.at(-1), { id: 0, result: { decision: "accept" } });
  });

  it("refuses an unknown server request with -32601 AND surfaces it", async () => {
    const h = harness();
    h.deliver({ id: 3, method: "some/futureRequest", params: {} });
    await tick();
    assert.equal((h.sent.at(-1) as { error: { code: number } }).error.code, -32601);
    assert.match(h.unknown[0]!.reason, /unknown server request some\/futureRequest/);
  });

  it("answers a handler's CodexRequestRefusal with its own code", async () => {
    const h = harness({
      onRequest: () => Promise.reject(CodexRequestRefusal.invalidParams("no answerable questions"))
    });
    h.deliver({ id: 0, method: "item/tool/requestUserInput", params: {} });
    await tick();
    await tick();
    assert.deepEqual(h.sent.at(-1), {
      id: 0,
      error: { code: -32602, message: "no answerable questions" }
    });
  });

  it("answers an unexpected handler throw with -32603, never a wedged turn", async () => {
    const h = harness({ onRequest: () => Promise.reject(new Error("boom")) });
    h.deliver({ id: 0, method: "item/fileChange/requestApproval", params: {} });
    await tick();
    await tick();
    assert.deepEqual(h.sent.at(-1), { id: 0, error: { code: -32603, message: "boom" } });
  });

  it("writes nothing for a request its handler withdrew, and still frees its slot", async () => {
    // The wait on it has ended (`serverRequest/resolved` named it, or a collab
    // child's turn ended or its thread closed): nothing consumes an answer, and
    // the server may no longer hold the request at all. The handler must not
    // dangle either, or the cap and a Stop's `whenServerRequestsSettled` count
    // it for ever.
    const h = harness();
    for (let id = 0; id < 32; id += 1) {
      h.deliver({ id, method: "item/commandExecution/requestApproval", params: {} });
    }
    await tick();
    const settled = h.peer.whenServerRequestsSettled();

    for (const request of h.requests) {
      request.reject(new CodexRequestWithdrawn("the child's turn ended"));
    }
    await settled;
    assert.deepEqual(
      h.sent.filter((frame) => frame.id === 0),
      [],
      "no result and no error: the server resolved it itself"
    );

    // The slot is free: the next request reaches its handler instead of -32001.
    h.deliver({ id: 1, method: "item/commandExecution/requestApproval", params: {} });
    await tick();
    assert.equal(h.requests.length, 33);
    assert.equal(h.sent.length, 0);
  });

  it("answers -32001 past the 32 in-flight cap", async () => {
    const h = harness();
    for (let index = 0; index < 32; index += 1) {
      h.deliver({ id: index, method: "item/fileChange/requestApproval", params: {} });
    }
    await tick();
    assert.equal(h.requests.length, 32);
    h.deliver({ id: 999, method: "item/fileChange/requestApproval", params: {} });
    await tick();
    const refusal = h.sent.at(-1) as { id: number; error: { code: number } };
    assert.equal(refusal.id, 999);
    assert.equal(refusal.error.code, -32001);
    // Answering one frees a slot.
    h.requests[0]!.resolve({ decision: "cancel" });
    await tick();
    await tick();
    h.deliver({ id: 1000, method: "item/fileChange/requestApproval", params: {} });
    await tick();
    assert.equal(h.requests.length, 33, "a freed slot accepts the next request");
  });

});

describe("codex transport — termination", () => {
  it("fails every pending request ONCE, and later sends fail fast", async () => {
    const h = harness();
    const a = h.peer.request("thread/compact/start", { threadId: "t" });
    const b = h.peer.request("thread/turns/list", { threadId: "t" });
    h.peer.close("child exited with code 0");

    for (const pending of [a, b]) {
      const error = await pending.catch((e: unknown) => e);
      assert.ok(error instanceof CodexTransportClosedError);
      assert.match((error as Error).message, /child exited with code 0/);
    }

    const after = await h.peer
      .request("thread/compact/start", { threadId: "t" })
      .catch((e: unknown) => e);
    assert.ok(after instanceof CodexTransportClosedError);

    // Idempotent: a second close must not throw or re-reject.
    h.peer.close("again");
    assert.equal(h.peer.isClosed, true);
  });

  it("a notification after close is ignored rather than written", async () => {
    const h = harness();
    h.peer.close("gone");
    const before = h.sent.length;
    h.peer.notify("initialized");
    await tick();
    assert.equal(h.sent.length, before);
  });
});
