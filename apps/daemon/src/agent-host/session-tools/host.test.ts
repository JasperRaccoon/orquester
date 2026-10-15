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

import type { SessionToolCallRequest, SessionToolsManifest } from "../host-protocol.ts";
import { legacyChatTools } from "../../mcp/catalog/legacy.ts";
import { DAEMON_UNAVAILABLE_MESSAGE, cancelledResult } from "../../session-tools/results.ts";
import { testSessionToolRegistry } from "../../session-tools/testing.ts";
import { buildChatToolDefinitions, knownSessionToolNames } from "./definitions.ts";
import { createDaemonForwarder, type ManifestAnswer } from "./forwarder.ts";
import { createSessionToolsHost, issueSessionToolsGrant, type SessionToolsGrant, type SessionToolsHost } from "./index.ts";
import { LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS } from "./legacy-definitions.ts";

const TEST_TOOLS = legacyChatTools(testSessionToolRegistry().tools);
const TEST_NAMES = TEST_TOOLS.map((tool) => tool.name);

/** The daemon's manifests: every test-toolkit tool for a thread unless `byThread` says otherwise. */
function manifests(byThread: Record<string, Partial<SessionToolsManifest>> = {}) {
  const asked: string[] = [];
  const answer = (threadId: string): ManifestAnswer => ({
    kind: "manifest",
    manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], ...byThread[threadId] }
  });
  return { asked, fetch: async (threadId: string): Promise<ManifestAnswer> => (asked.push(threadId), answer(threadId)) };
}

/** A host over the test toolkit (definitions and known names), with `manifest` as the daemon. */
function testHost(forward: (call: SessionToolCallRequest, signal: AbortSignal) => Promise<CallToolResult>, manifest = manifests().fetch): SessionToolsHost {
  return createSessionToolsHost({
    forward,
    manifest,
    definitions: buildChatToolDefinitions(TEST_TOOLS),
    knownNames: knownSessionToolNames(TEST_TOOLS)
  });
}

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
  const service = testHost(forward.forward);
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
  const grant = await service.issue("thread-a", "codex");
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
  const a = await connect(t, await service.issue("thread-a", "codex"));
  const b = await connect(t, await service.issue("thread-b", "codex"));
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
  const first = await service.issue("thread-a", "codex");
  assert.equal((await fetch(first.url, initialize(first.authorization))).status, 200);
  assert.equal((await fetch(first.url, initialize())).status, 401);
  assert.equal((await fetch(first.url, initialize("Bearer not-a-credential"))).status, 401);
  assert.equal((await fetch(first.url, initialize(`Basic ${first.token}`))).status, 401);
  // The relaunch: a new credential for the same thread revokes the first.
  const second = await service.issue("thread-a", "codex");
  assert.equal((await fetch(first.url, initialize(first.authorization))).status, 401);
  assert.equal((await fetch(second.url, initialize(second.authorization))).status, 200);
  // The session ended.
  second.revoke();
  assert.equal((await fetch(second.url, initialize(second.authorization))).status, 401);
});

test("the endpoint serves POST /mcp only", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a", "codex");
  const get = await fetch(grant.url, { headers: { authorization: grant.authorization } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const elsewhere = await fetch(grant.url.replace(/\/mcp$/, "/other"), initialize(grant.authorization));
  assert.equal(elsewhere.status, 404);
});

test("a provider's own cancel aborts the call", async (t) => {
  const { host: service, rec } = host(t);
  const client = await connect(t, await service.issue("thread-a", "codex"));
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
  const a = await connect(t, await service.issue("thread-a", "codex"));
  const b = await connect(t, await service.issue("thread-b", "codex"));
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
  const grant = await service.issue("thread-a", "codex");
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
  const service = testHost(createDaemonForwarder({ socketPath: () => join(tmpdir(), "no-such-orquester.sock"), token: "t" }));
  t.after(() => service.stop());
  const client = await connect(t, await service.issue("thread-a", "codex"));
  const result = (await client.callTool({ name: "echo", arguments: { text: "x" } })) as CallToolResult;
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }]);
});

test("stop revokes every credential and closes the endpoint", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a", "codex");
  await service.stop();
  await assert.rejects(fetch(grant.url, initialize(grant.authorization)));
  await assert.rejects(service.issue("thread-a", "codex"), /stopping/);
});

test("an adapter whose grant cannot be issued starts without session tools, logged", async (t) => {
  const { host: service } = host(t);
  await service.stop();
  const warnings: string[] = [];
  const grant = await issueSessionToolsGrant({ sessionTools: service, logger: { warn: (message) => warnings.push(message) } }, "thread-a", "codex");
  assert.equal(grant, undefined);
  assert.equal(warnings.length, 1);
  assert.equal(await issueSessionToolsGrant({ logger: { warn: () => {} } }, "thread-a", "codex"), undefined, "no service, no grant");
});

// ---------------------------------------------------------------------------
// Per-thread lists (unified MCP design 2026-10-15 §9.4, §9.3, §14.1)
// ---------------------------------------------------------------------------

test("each thread lists its own manifest's tools, instructions and denials", async (t) => {
  const daemon = manifests({ "thread-b": { tools: ["echo"], instructions: "## B", deny: ["orquester_remote"] } });
  const service = testHost(recordingForward().forward, daemon.fetch);
  t.after(() => service.stop());
  const a = await service.issue("thread-a", "codex");
  const b = await service.issue("thread-b", "codex");
  assert.deepEqual([...a.prepared.names], TEST_NAMES);
  assert.deepEqual([...b.prepared.names], ["echo"]);
  assert.equal(b.prepared.instructions, "## B");
  assert.deepEqual(b.prepared.deny, ["orquester_remote"]);
  assert.deepEqual(daemon.asked, ["thread-a", "thread-b"]);
  const listedB = await (await connect(t, b)).listTools();
  assert.deepEqual(listedB.tools.map((tool) => tool.name), ["echo"]);
  const listedA = await (await connect(t, a)).listTools();
  assert.deepEqual(listedA.tools.map((tool) => tool.name), TEST_NAMES);
  // A name the host does not know (a newer daemon) is not advertised.
  const newer = testHost(recordingForward().forward, manifests({ x: { tools: ["echo", "from_the_future"] } }).fetch);
  t.after(() => newer.stop());
  assert.deepEqual([...(await newer.prepare("x", "codex")).names], ["echo"]);
});

test("a daemon without the manifest route gets the frozen legacy definitions", async (t) => {
  const service = createSessionToolsHost({ forward: recordingForward().forward, manifest: async () => ({ kind: "legacy" }) });
  t.after(() => service.stop());
  const grant = await service.issue("thread-a", "codex");
  assert.equal(grant.prepared.source, "legacy");
  assert.deepEqual(grant.prepared.tools, LEGACY_SESSION_TOOL_DEFINITIONS);
  assert.equal(grant.prepared.instructions, LEGACY_SESSION_TOOL_INSTRUCTIONS);
  const listed = await (await connect(t, grant)).listTools();
  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  assert.deepEqual(json(listed.tools), json(LEGACY_SESSION_TOOL_DEFINITIONS), "the old server's tools/list, verbatim");
});

test("an unreachable daemon: the thread's last list, else its agent's catalogue defaults", async (t) => {
  let up = true;
  const daemon = manifests({ "thread-a": { tools: ["echo"], deny: ["remote"] } });
  const service = testHost(recordingForward().forward, async (threadId) => (up ? daemon.fetch(threadId) : { kind: "unavailable" }));
  t.after(() => service.stop());
  await service.issue("thread-a", "codex");
  up = false;
  const again = await service.issue("thread-a", "codex");
  assert.equal(again.prepared.source, "fallback");
  assert.deepEqual([...again.prepared.names], ["echo"]);
  assert.deepEqual(again.prepared.deny, ["remote"]);
  // A thread never seen: the defaults (no test-toolkit tool is in a catalogue toolset), the
  // agent's last denials.
  const fresh = await service.issue("thread-z", "codex");
  assert.equal(fresh.prepared.source, "fallback");
  assert.deepEqual(fresh.prepared.deny, ["remote"]);
  assert.match(fresh.prepared.instructions, /^## Orquester/);
});

test("a thread the daemon does not know advertises nothing", async (t) => {
  const service = testHost(recordingForward().forward, async () => ({ kind: "no-thread" }));
  t.after(() => service.stop());
  assert.equal((await service.issue("ghost", "codex")).prepared.tools.length, 0);
});

test("a refresh: in-session for a live listener, at the next idle point otherwise, nothing without a session", async (t) => {
  const service = testHost(recordingForward().forward);
  t.after(() => service.stop());
  const changed: SessionToolsManifest = { tools: ["echo"], instructions: "## Orquester (test)", deny: [] };
  // No session.
  assert.equal(await service.applyManifest("nobody", changed), "next-start");
  // An endpoint session: marked stale until its next start.
  const grant = await service.issue("thread-a", "codex");
  assert.equal(await service.applyManifest("thread-a", { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [] }), "unchanged");
  assert.equal(service.needsRestart("thread-a"), false);
  assert.equal(await service.applyManifest("thread-a", changed), "next-idle");
  assert.equal(service.needsRestart("thread-a"), true);
  // The relaunch reads the daemon's manifest again: nothing owed.
  await service.issue("thread-a", "codex");
  assert.equal(service.needsRestart("thread-a"), false);
  // A revoked session (it ended) owes nothing either.
  grant.revoke();
  // An in-process session (Claude) takes the list live.
  const seen: string[][] = [];
  const { prepared, release } = await service.launchInProcess("thread-c", "claude", (next) => seen.push([...next.names]));
  assert.deepEqual([...prepared.names], TEST_NAMES);
  assert.equal(await service.applyManifest("thread-c", changed), "live");
  assert.deepEqual(seen, [["echo"]]);
  assert.deepEqual(service.current("thread-c")?.tools.map((tool) => tool.name), ["echo"]);
  assert.deepEqual(service.listSource("thread-c").list().map((tool) => tool.name), ["echo"]);
  assert.equal(service.needsRestart("thread-c"), false);
  // A changed denial cannot be taken in-session: restart at the next idle point.
  assert.equal(await service.applyManifest("thread-c", { ...changed, deny: ["remote"] }), "next-idle");
  assert.equal(service.needsRestart("thread-c"), true);
  release();
  assert.equal(service.current("thread-c"), null);
  assert.equal(service.needsRestart("thread-c"), false);
});

test("the inert /mcp/denied server lists nothing and refuses every call, without a credential", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a", "codex");
  assert.equal(grant.deniedUrl, grant.url.replace(/\/mcp$/, "/mcp/denied"));
  const client = new Client({ name: "grok-stand-in", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.deniedUrl)));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools, []);
  await assert.rejects(client.callTool({ name: "echo", arguments: {} }));
});
