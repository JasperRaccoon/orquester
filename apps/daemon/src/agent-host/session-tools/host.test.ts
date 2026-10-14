/**
 * The host's session-tool service end to end, through a real MCP client over
 * the loopback endpoint (design 2026-10-14 §1.1–§1.2): the thread a call acts
 * as is the credential's, an unknown or revoked credential is a 401, and a
 * call is cancelled by the provider, by an interrupt or by its credential's
 * revocation. The daemon is replaced by a recording forwarder, except where
 * the daemon being gone is the point.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SessionToolCallRequest } from "../host-protocol.ts";
import { DAEMON_UNAVAILABLE_MESSAGE, cancelledResult } from "../../session-tools/results.ts";
import { testSessionToolRegistry } from "../../session-tools/testing.ts";
import { createDaemonForwarder } from "./forwarder.ts";
import { createSessionToolsHost, issueSessionToolsGrant, type SessionToolsGrant, type SessionToolsHost } from "./index.ts";

interface Recorded {
  call: SessionToolCallRequest;
  signal: AbortSignal;
}

/** A forwarder that records each call; `wait_for_cancel` parks until its signal aborts. */
function recordingForward() {
  const calls: Recorded[] = [];
  const waiters: Array<() => void> = [];
  const forward = async (call: SessionToolCallRequest, signal: AbortSignal): Promise<CallToolResult> => {
    calls.push({ call, signal });
    waiters.splice(0).forEach((wake) => wake());
    if (call.name === "wait_for_cancel") {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return cancelledResult();
    }
    return { content: [{ type: "text", text: JSON.stringify({ thread: call.threadId, args: call.arguments }) }] };
  };
  const nextCall = () => new Promise<void>((resolve) => waiters.push(resolve));
  return { forward, calls, nextCall };
}

async function connect(t: { after(fn: () => Promise<void>): void }, grant: SessionToolsGrant): Promise<Client> {
  const client = new Client({ name: "probe", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: grant.authorization } }
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

function host(t: { after(fn: () => Promise<void>): void }, forward = recordingForward()): { host: SessionToolsHost; rec: ReturnType<typeof recordingForward> } {
  const service = createSessionToolsHost({ registry: testSessionToolRegistry(), forward: forward.forward });
  t.after(() => service.stop());
  return { host: service, rec: forward };
}

const initialize = (authorization?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(authorization !== undefined ? { authorization } : {})
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "0" } }
  })
});

test("a provider lists the registered tools and calls them as its credential's thread", async (t) => {
  const { host: service, rec } = host(t);
  const grant = await service.issue("thread-a");
  assert.match(grant.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(grant.authorization, `Bearer ${grant.token}`);
  const client = await connect(t, grant);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["echo", "wait_for_cancel", "pixel", "fail"]
  );
  const echo = listed.tools.find((tool) => tool.name === "echo")!;
  assert.deepEqual(Object.keys(echo.inputSchema.properties ?? {}), ["text"]);
  assert.equal(echo.annotations?.readOnlyHint, true);

  const result = await client.callTool({ name: "echo", arguments: { text: "hi", extra: 1 } });
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.call.threadId, "thread-a");
  assert.equal(rec.calls[0]!.call.name, "echo");
  // The arguments are forwarded raw: the daemon is the one validator.
  assert.deepEqual(rec.calls[0]!.call.arguments, { text: "hi", extra: 1 });
  assert.match(rec.calls[0]!.call.callId, /^call-/);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ thread: "thread-a", args: { text: "hi", extra: 1 } }) }]);
});

test("each credential acts only as its own thread", async (t) => {
  const { host: service, rec } = host(t);
  const a = await connect(t, await service.issue("thread-a"));
  const b = await connect(t, await service.issue("thread-b"));
  await b.callTool({ name: "echo", arguments: { text: "from b" } });
  await a.callTool({ name: "echo", arguments: { text: "from a" } });
  assert.deepEqual(
    rec.calls.map((entry) => [entry.call.threadId, (entry.call.arguments as { text: string }).text]),
    [
      ["thread-b", "from b"],
      ["thread-a", "from a"]
    ]
  );
});

test("no credential, a wrong one, or one a relaunch revoked is a 401", async (t) => {
  const { host: service } = host(t);
  const first = await service.issue("thread-a");
  assert.equal((await fetch(first.url, initialize(first.authorization))).status, 200);
  assert.equal((await fetch(first.url, initialize())).status, 401);
  assert.equal((await fetch(first.url, initialize("Bearer not-a-credential"))).status, 401);
  assert.equal((await fetch(first.url, initialize(`Basic ${first.token}`))).status, 401);
  // The relaunch: a new credential for the same thread revokes the first.
  const second = await service.issue("thread-a");
  assert.equal((await fetch(first.url, initialize(first.authorization))).status, 401);
  assert.equal((await fetch(second.url, initialize(second.authorization))).status, 200);
  // The session ended.
  second.revoke();
  assert.equal((await fetch(second.url, initialize(second.authorization))).status, 401);
});

test("the endpoint serves POST /mcp only", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a");
  const get = await fetch(grant.url, { headers: { authorization: grant.authorization } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const elsewhere = await fetch(grant.url.replace(/\/mcp$/, "/other"), initialize(grant.authorization));
  assert.equal(elsewhere.status, 404);
});

test("a provider's own cancel aborts the call", async (t) => {
  const { host: service, rec } = host(t);
  const client = await connect(t, await service.issue("thread-a"));
  const controller = new AbortController();
  const started = rec.nextCall();
  const pending = client.callTool({ name: "wait_for_cancel", arguments: {} }, undefined, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending);
  // The SDK's `notifications/cancelled` reached the endpoint and aborted the forward.
  await new Promise<void>((resolve) => {
    const signal = rec.calls[0]!.signal;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  assert.equal(rec.calls[0]!.signal.aborted, true);
});

test("an interrupted turn aborts its thread's calls, and only its thread's", async (t) => {
  const { host: service, rec } = host(t);
  const a = await connect(t, await service.issue("thread-a"));
  const b = await connect(t, await service.issue("thread-b"));
  let started = rec.nextCall();
  const pendingA = a.callTool({ name: "wait_for_cancel", arguments: {} });
  await started;
  started = rec.nextCall();
  const pendingB = b.callTool({ name: "wait_for_cancel", arguments: {} });
  await started;
  service.abortThreadCalls("thread-a");
  const resultA = (await pendingA) as CallToolResult;
  assert.equal(resultA.isError, true);
  assert.equal(rec.calls[0]!.signal.aborted, true);
  assert.equal(rec.calls[1]!.signal.aborted, false);
  service.abortThreadCalls("thread-b");
  await pendingB;
});

test("revoking a credential aborts the calls made with it", async (t) => {
  const { host: service, rec } = host(t);
  const grant = await service.issue("thread-a");
  const client = await connect(t, grant);
  const started = rec.nextCall();
  const pending = client.callTool({ name: "wait_for_cancel", arguments: {} });
  await started;
  grant.revoke();
  await pending.catch(() => undefined);
  assert.equal(rec.calls[0]!.signal.aborted, true);
});

test("the in-process path (Claude's) files calls under the thread it was bound to", async (t) => {
  const { host: service, rec } = host(t);
  const result = await service.call({ threadId: "thread-c", name: "echo", arguments: { text: "x" }, callId: "toolu_9" });
  assert.equal(result.isError, undefined);
  assert.equal(rec.calls[0]!.call.threadId, "thread-c");
  assert.equal(rec.calls[0]!.call.callId, "toolu_9");
  const unknown = await service.call({ threadId: "thread-c", name: "nope", arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(rec.calls.length, 1, "an unknown tool never reaches the daemon");
});

test("with the daemon down, a call answers the restart message — no throw, no hang", async (t) => {
  const service = createSessionToolsHost({
    registry: testSessionToolRegistry(),
    forward: createDaemonForwarder({ socketPath: () => join(tmpdir(), "no-such-orquester.sock"), token: "t" })
  });
  t.after(() => service.stop());
  const client = await connect(t, await service.issue("thread-a"));
  const result = (await client.callTool({ name: "echo", arguments: { text: "x" } })) as CallToolResult;
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }]);
});

test("stop revokes every credential and closes the endpoint", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a");
  await service.stop();
  await assert.rejects(fetch(grant.url, initialize(grant.authorization)));
  await assert.rejects(service.issue("thread-a"), /stopping/);
});

test("an adapter whose grant cannot be issued starts without session tools, logged", async (t) => {
  const { host: service } = host(t);
  await service.stop();
  const warnings: string[] = [];
  const grant = await issueSessionToolsGrant({ sessionTools: service, logger: { warn: (message) => warnings.push(message) } }, "thread-a");
  assert.equal(grant, undefined);
  assert.equal(warnings.length, 1);
  assert.equal(await issueSessionToolsGrant({ logger: { warn: () => {} } }, "thread-a"), undefined, "no service, no grant");
});
