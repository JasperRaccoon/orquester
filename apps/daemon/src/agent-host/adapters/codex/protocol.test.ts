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
  CodexRpcError,
  CodexTransportClosedError,
  MAX_IN_FLIGHT_SERVER_REQUESTS,
  TOO_MANY_REQUESTS_CODE
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
    maxInFlightServerRequests?: number;
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
    ...(options.maxInFlightServerRequests !== undefined
      ? { maxInFlightServerRequests: options.maxInFlightServerRequests }
      : {}),
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
    void h.peer.request("initialize", { clientInfo: { name: "x", title: null, version: "1" }, capabilities: null });
    await tick();
    assert.deepEqual(Object.keys(h.sent[0]!).sort(), ["id", "method", "params"]);
    assert.ok(!("jsonrpc" in h.sent[0]!));
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

  it("handles a response split across chunk boundaries and CRLF", async () => {
    const h = harness();
    const pending = h.peer.request("thread/compact/start", { threadId: "t" });
    h.deliverRaw('{"id":1,"res');
    await tick();
    h.deliverRaw('ult":{"ok":true}}\r\n');
    assert.deepEqual(await pending, { ok: true });
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
  it("a server request with id 0 does not resolve our request 0", async () => {
    const h = harness({ onRequest: () => Promise.resolve({ decision: "accept" }) });
    // Our own ids start at 1; the server's at 0 (fixtures README obs. 15).
    const pending = h.peer.request("thread/compact/start", { threadId: "t" });
    h.deliver({ id: 0, method: "item/fileChange/requestApproval", params: { threadId: "t" } });
    await tick();
    await tick();
    // The server request was answered, and our request is still parked.
    assert.deepEqual(h.sent.at(-1), { id: 0, result: { decision: "accept" } });
    assert.equal(h.peer.pendingRequestCount, 1);
    h.deliver({ id: 1, result: {} });
    assert.deepEqual(await pending, {});
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

  it("answers -32001 past the 32 in-flight cap", async () => {
    const h = harness();
    for (let index = 0; index < MAX_IN_FLIGHT_SERVER_REQUESTS; index += 1) {
      h.deliver({ id: index, method: "item/fileChange/requestApproval", params: {} });
    }
    await tick();
    assert.equal(h.peer.openServerRequestCount, MAX_IN_FLIGHT_SERVER_REQUESTS);
    h.deliver({ id: 999, method: "item/fileChange/requestApproval", params: {} });
    await tick();
    const refusal = h.sent.at(-1) as { id: number; error: { code: number } };
    assert.equal(refusal.id, 999);
    assert.equal(refusal.error.code, TOO_MANY_REQUESTS_CODE);
    // Answering one frees a slot.
    h.requests[0]!.resolve({ decision: "cancel" });
    await tick();
    await tick();
    assert.equal(h.peer.openServerRequestCount, MAX_IN_FLIGHT_SERVER_REQUESTS - 1);
  });

  it("the cap is configurable, so a test does not need 32 frames to reach it", async () => {
    const h = harness({ maxInFlightServerRequests: 1 });
    h.deliver({ id: 0, method: "item/fileChange/requestApproval", params: {} });
    await tick();
    h.deliver({ id: 1, method: "item/fileChange/requestApproval", params: {} });
    await tick();
    assert.equal((h.sent.at(-1) as { error: { code: number } }).error.code, TOO_MANY_REQUESTS_CODE);
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
