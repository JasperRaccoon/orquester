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
import { DAEMON_UNAVAILABLE_MESSAGE, cancelledResult } from "../../session-tools/results.ts";
import { TEST_CHAT_TOOLS } from "../../session-tools/testing.ts";
import { buildChatToolDefinitions, knownSessionToolNames } from "./definitions.ts";
import { createDaemonForwarder, type ManifestAnswer } from "./forwarder.ts";
import {
  createSessionToolsHost,
  DENIAL_DEGRADED_WARNING,
  DENIALS_UNKNOWN_MESSAGE,
  isSessionToolsDenialsUnknown,
  issueSessionToolsGrant,
  type SessionToolsGrant,
  type SessionToolsHost
} from "./index.ts";
import { LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS } from "./legacy-definitions.ts";

const TEST_TOOLS = TEST_CHAT_TOOLS;
/** A Codex launch in the system home of project /p (what the fallback is keyed on). */
const CODEX = { agent: "codex" as const, home: "system", project: "/p" };
const CLAUDE = { agent: "claude" as const, home: "system", project: "/p" };
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
  const grant = await service.issue("thread-a", CODEX);
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
  const a = await connect(t, await service.issue("thread-a", CODEX));
  const b = await connect(t, await service.issue("thread-b", CODEX));
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
  const first = await service.issue("thread-a", CODEX);
  const other = await service.issue("thread-b", CODEX);
  assert.equal((await fetch(first.url, initialize(first.authorization))).status, 200);
  assert.equal((await fetch(first.url, initialize())).status, 401);
  assert.equal((await fetch(first.url, initialize("Bearer not-a-credential"))).status, 401);
  assert.equal((await fetch(first.url, initialize(`Basic ${first.token}`))).status, 401);
  // The relaunch: a new credential for the same thread revokes the first.
  const second = await service.issue("thread-a", CODEX);
  assert.equal((await fetch(first.url, initialize(first.authorization))).status, 401);
  assert.equal((await fetch(second.url, initialize(second.authorization))).status, 200);
  assert.equal((await fetch(other.url, initialize(other.authorization))).status, 200, "another thread keeps its credential");
  // The session ended.
  second.revoke();
  assert.equal((await fetch(second.url, initialize(second.authorization))).status, 401);
});

test("the endpoint serves POST /mcp only", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a", CODEX);
  const get = await fetch(grant.url, { headers: { authorization: grant.authorization } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const elsewhere = await fetch(grant.url.replace(/\/mcp$/, "/other"), initialize(grant.authorization));
  assert.equal(elsewhere.status, 404);
});

test("a provider's own cancel aborts the call", async (t) => {
  const { host: service, rec } = host(t);
  const client = await connect(t, await service.issue("thread-a", CODEX));
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
  const a = await connect(t, await service.issue("thread-a", CODEX));
  const b = await connect(t, await service.issue("thread-b", CODEX));
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
  const grant = await service.issue("thread-a", CODEX);
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
  const client = await connect(t, await service.issue("thread-a", CODEX));
  const result = (await client.callTool({ name: "echo", arguments: { text: "x" } })) as CallToolResult;
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }]);
});

test("stop revokes every credential and closes the endpoint", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a", CODEX);
  await service.stop();
  await assert.rejects(fetch(grant.url, initialize(grant.authorization)));
  await assert.rejects(service.issue("thread-a", CODEX), /stopping/);
});

test("an adapter whose grant cannot be issued starts without session tools, logged", async (t) => {
  const { host: service } = host(t);
  await service.stop();
  const warnings: string[] = [];
  const launched = await issueSessionToolsGrant({ sessionTools: service, logger: { warn: (message) => warnings.push(message) } }, "thread-a", CODEX);
  assert.equal(launched.grant, undefined);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await issueSessionToolsGrant({ logger: { warn: () => {} } }, "thread-a", CODEX), { prepared: null }, "no service, no grant");
});

// ---------------------------------------------------------------------------
// Per-thread lists (unified MCP design 2026-10-15 §9.4, §9.3, §14.1)
// ---------------------------------------------------------------------------

test("each thread lists its own manifest's tools, instructions and denials", async (t) => {
  const daemon = manifests({ "thread-b": { tools: ["echo"], instructions: "## B", deny: ["orquester_remote"] } });
  const service = testHost(recordingForward().forward, daemon.fetch);
  t.after(() => service.stop());
  const a = await service.issue("thread-a", CODEX);
  const b = await service.issue("thread-b", CODEX);
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
  assert.deepEqual([...(await newer.prepare("x", CODEX)).names], ["echo"]);
});

test("a daemon without the manifest route gets the frozen legacy definitions", async (t) => {
  const service = createSessionToolsHost({ forward: recordingForward().forward, manifest: async () => ({ kind: "legacy" }) });
  t.after(() => service.stop());
  const grant = await service.issue("thread-a", CODEX);
  assert.equal(grant.prepared.source, "legacy");
  assert.deepEqual(grant.prepared.tools, LEGACY_SESSION_TOOL_DEFINITIONS);
  assert.equal(grant.prepared.instructions, LEGACY_SESSION_TOOL_INSTRUCTIONS);
  const listed = await (await connect(t, grant)).listTools();
  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  assert.deepEqual(json(listed.tools), json(LEGACY_SESSION_TOOL_DEFINITIONS), "the old server's tools/list, verbatim");
});

test("an unreachable daemon: the SAME launch's last list, warned; denials never known are never skipped", async (t) => {
  let up = true;
  const warnings: [string, string][] = [];
  const daemon = manifests({ "thread-a": { tools: ["echo"], deny: ["remote"] } });
  const service = createSessionToolsHost({
    forward: recordingForward().forward,
    manifest: async (threadId) => (up ? daemon.fetch(threadId) : { kind: "unavailable" }),
    definitions: buildChatToolDefinitions(TEST_TOOLS),
    knownNames: knownSessionToolNames(TEST_TOOLS),
    onWarning: (threadId, message) => warnings.push([threadId, message]),
    // The wait for denials is the behaviour under test; its bound is kept short.
    denialsWaitMs: 20
  });
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  up = false;
  const again = await service.issue("thread-a", CODEX);
  assert.equal(again.prepared.source, "fallback");
  assert.deepEqual([...again.prepared.names], ["echo"]);
  assert.deepEqual(again.prepared.deny, ["remote"]);
  assert.deepEqual(warnings, [["thread-a", DENIAL_DEGRADED_WARNING]], "a fallback is never silent");
  // Another thread of the same agent, home and project: the same config, the same denials.
  assert.deepEqual((await service.issue("thread-z", CODEX)).prepared.deny, ["remote"]);
  // The thread's OWN last manifest comes first (thread-a's list is ["echo"], not thread-z's).
  assert.deepEqual([...(await service.issue("thread-a", CODEX)).prepared.names], ["echo"]);
  // Another account home (or project): NEVER that key's denials (Codex fails a thread whose config
  // lacks a denied name) — and no launch without denials either: refused, retryable.
  await assert.rejects(service.issue("thread-y", { ...CODEX, home: "acct-2" }), (error: unknown) => {
    assert.ok(isSessionToolsDenialsUnknown(error));
    assert.equal(error.message, DENIALS_UNKNOWN_MESSAGE);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(service.current("thread-y"), null, "nothing launched");
  await assert.rejects(service.issue("thread-x", { ...CODEX, project: "/q" }), isSessionToolsDenialsUnknown);
  // An account switch of thread-a: its own last manifest is the OLD home's — not reused.
  await assert.rejects(service.issue("thread-a", { ...CODEX, home: "acct-3" }), isSessionToolsDenialsUnknown);
});

test("the degraded row is added once per degraded state: again only after a good manifest", async (t) => {
  let up = true;
  const warnings: string[] = [];
  const service = createSessionToolsHost({
    forward: recordingForward().forward,
    manifest: async (threadId) => (up ? manifests().fetch(threadId) : { kind: "unavailable" }),
    definitions: buildChatToolDefinitions(TEST_TOOLS),
    knownNames: knownSessionToolNames(TEST_TOOLS),
    onWarning: (threadId) => warnings.push(threadId)
  });
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  up = false;
  await service.issue("thread-a", CODEX);
  await service.issue("thread-a", CODEX);
  await service.issue("thread-a", CODEX);
  assert.deepEqual(warnings, ["thread-a"], "one row for the whole degraded stretch");
  // A good manifest ends it; the next degraded launch is a new state, warned again.
  up = true;
  await service.issue("thread-a", CODEX);
  up = false;
  await service.issue("thread-a", CODEX);
  assert.deepEqual(warnings, ["thread-a", "thread-a"]);
  // A pushed manifest is a good one too.
  await service.applyManifest("thread-a", { tools: TEST_NAMES, instructions: "", deny: [] });
  await service.issue("thread-a", CODEX);
  assert.deepEqual(warnings, ["thread-a", "thread-a", "thread-a"]);
  // Another thread has its own state.
  await service.issue("thread-b", CODEX);
  assert.deepEqual(warnings, ["thread-a", "thread-a", "thread-a", "thread-b"]);
});

test("a cold host refuses a launch it knows no denials for, and launches with them once the daemon answers", async (t) => {
  let up = false;
  const daemon = manifests({ "thread-a": { deny: ["remote"] } });
  const service = createSessionToolsHost({
    forward: recordingForward().forward,
    manifest: async (threadId) => (up ? daemon.fetch(threadId) : { kind: "unavailable" }),
    definitions: buildChatToolDefinitions(TEST_TOOLS),
    knownNames: knownSessionToolNames(TEST_TOOLS),
    denialsWaitMs: 20
  });
  t.after(() => service.stop());
  const warnings: string[] = [];
  const context = { sessionTools: service, logger: { warn: (message: string) => warnings.push(message) } };
  // The adapter's way in: never a grant, never a launch without the denials.
  await assert.rejects(issueSessionToolsGrant(context, "thread-a", CODEX), isSessionToolsDenialsUnknown);
  assert.equal(service.current("thread-a"), null);
  assert.deepEqual(warnings, [], "not the tools-only failure path");
  up = true;
  const retried = await issueSessionToolsGrant(context, "thread-a", CODEX);
  assert.deepEqual(retried.prepared?.deny, ["remote"]);
  assert.equal(retried.prepared?.source, "manifest");
  retried.grant?.revoke();
});

test("a launch waiting for its denials takes the manifest the daemon pushes for its thread", async (t) => {
  let entered!: () => void;
  const asked = new Promise<void>((resolve) => (entered = resolve));
  const service = testHost(recordingForward().forward, async () => {
    entered();
    return { kind: "unavailable" };
  });
  t.after(() => service.stop());
  const launch = service.issue("thread-a", CODEX);
  await asked;
  const pushed: SessionToolsManifest = { tools: ["echo"], instructions: "## pushed", deny: ["remote"], seq: 4, epoch: "e1" };
  // The daemon's push once its read succeeded: the waiting launch launches with it…
  const applied = service.applyManifest("thread-a", pushed);
  const grant = await launch;
  assert.equal(grant.prepared.source, "manifest");
  assert.deepEqual(grant.prepared.deny, ["remote"]);
  assert.deepEqual([...grant.prepared.names], ["echo"]);
  // …and the push has nothing left to apply (no restart churn).
  assert.equal(await applied, "unchanged");
  assert.equal(service.needsRestart("thread-a"), false);
  grant.revoke();
});

test("a launch waiting for its denials takes the manifest another launch of its key reads", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const asked = new Promise<void>((resolve) => (entered = resolve));
  const service = testHost(recordingForward().forward, async (threadId) => {
    if (threadId === "thread-a") {
      entered();
      return { kind: "unavailable" };
    }
    await gate;
    return { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: ["remote"], seq: 9, epoch: "e1" } };
  });
  t.after(() => service.stop());
  const waiting = service.issue("thread-a", CODEX);
  await asked;
  const other = service.issue("thread-b", CODEX);
  release();
  const [a, b] = await Promise.all([waiting, other]);
  assert.equal(a.prepared.source, "fallback");
  assert.deepEqual(a.prepared.deny, ["remote"]);
  assert.equal(a.prepared.seq, undefined, "another thread's stamp never orders this one");
  assert.equal(b.prepared.source, "manifest");
  a.revoke();
  b.revoke();
});

test("a launch waiting for its denials gives up when the host stops", async () => {
  let entered!: () => void;
  const asked = new Promise<void>((resolve) => (entered = resolve));
  const service = testHost(recordingForward().forward, async () => {
    entered();
    return { kind: "unavailable" };
  });
  const launch = service.issue("thread-a", CODEX);
  await asked;
  await service.stop();
  await assert.rejects(launch, isSessionToolsDenialsUnknown);
});

test("a fallback launch drops a wanted list it cannot read anyway (no restart at every idle point)", async (t) => {
  let up = true;
  const service = testHost(recordingForward().forward, async () =>
    up ? { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 1, epoch: "e1" } } : { kind: "unavailable" }
  );
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 2, epoch: "e1" }), "next-idle");
  assert.equal(service.needsRestart("thread-a"), true);
  // The restart could not ask the daemon: it fell back, and does not ask to restart again.
  up = false;
  const relaunched = await service.issue("thread-a", CODEX);
  assert.equal(relaunched.prepared.source, "fallback");
  assert.equal(service.needsRestart("thread-a"), false);
});

test("a late push of an EARLIER daemon epoch never retires the newer one (handover inversion)", async (t) => {
  let epoch = "old";
  const service = testHost(recordingForward().forward, async () => ({ kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 10, epoch } }));
  t.after(() => service.stop());
  // thread-b launched under the old daemon; thread-a's FIRST launch is the new daemon's.
  await service.issue("thread-b", CODEX);
  epoch = "new";
  await service.issue("thread-a", CODEX);
  // The old daemon's late push to thread-a: stale (its epoch was seen first) — and retires nothing.
  assert.equal(await service.applyManifest("thread-a", { tools: ["pixel"], instructions: "", deny: [], seq: 99, epoch: "old" }), "superseded");
  // The new daemon still speaks for both threads.
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 11, epoch: "new" }), "next-idle");
  assert.equal(await service.applyManifest("thread-b", { tools: ["echo"], instructions: "", deny: [], seq: 12, epoch: "new" }), "next-idle");
  // …and once thread-b moved on, the old epoch is retired everywhere.
  assert.equal(await service.applyManifest("thread-b", { tools: ["pixel"], instructions: "", deny: [], seq: 100, epoch: "old" }), "superseded");
});

test("an epoch never seen before counts as newest — until a manifest the host asks for says which daemon is live", async (t) => {
  const service = testHost(recordingForward().forward, async () => ({ kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 10, epoch: "new" } }));
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  // A host started mid-handover hears the old daemon (never seen) after the new one: taken as newer.
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 1, epoch: "old" }), "next-idle");
  assert.equal(await service.applyManifest("thread-a", { tools: ["pixel"], instructions: "", deny: [], seq: 11, epoch: "new" }), "superseded", "the residual");
  // A relaunch asks the daemon its socket reaches — the new one — and that epoch is live again.
  await service.issue("thread-a", CODEX);
  assert.equal(await service.applyManifest("thread-a", { tools: ["pixel"], instructions: "", deny: [], seq: 12, epoch: "new" }), "next-idle");
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 2, epoch: "old" }), "superseded");
});

test("a pulled manifest names the live daemon only when its socket is still the current one", async (t) => {
  let answer: ManifestAnswer = { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 10, epoch: "new" } };
  const service = testHost(recordingForward().forward, async () => answer);
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  // A relaunch's read answered by the OLD daemon's socket after the host moved on: used, not recorded.
  answer = { kind: "manifest", manifest: { tools: ["echo"], instructions: "", deny: [], seq: 99, epoch: "old" }, current: false };
  const relaunched = await service.issue("thread-a", CODEX);
  assert.deepEqual([...relaunched.prepared.names], ["echo"]);
  // The new daemon's epoch is still the live one: its next push applies.
  assert.equal(await service.applyManifest("thread-a", { tools: TEST_NAMES, instructions: "", deny: [], seq: 11, epoch: "new" }), "next-idle");
});

test("forgetting a thread, or interrupting its turn, ends a launch's wait for its denials at once", async (t) => {
  for (const end of ["forgetThread", "abortThreadCalls"] as const) {
    let entered!: () => void;
    const asked = new Promise<void>((resolve) => (entered = resolve));
    const service = testHost(recordingForward().forward, async () => {
      entered();
      return { kind: "unavailable" };
    });
    t.after(() => service.stop());
    const launch = service.issue("thread-a", CODEX);
    await asked;
    service[end]("thread-a");
    await assert.rejects(launch, isSessionToolsDenialsUnknown, end);
  }
});

test("a fallback launch takes a pending pushed list of the same launch key over the older last one (no change lost, no churn)", async (t) => {
  let up = true;
  const service = createSessionToolsHost({
    forward: recordingForward().forward,
    manifest: async () =>
      up ? { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: ["remote"], seq: 1, epoch: "e1" } } : { kind: "unavailable" },
    definitions: buildChatToolDefinitions(TEST_TOOLS),
    knownNames: knownSessionToolNames(TEST_TOOLS),
    denialsWaitMs: 20
  });
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  // A pushed list change waits for the session's restart…
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "## changed", deny: ["remote"], seq: 2, epoch: "e1" }), "next-idle");
  up = false;
  // …and the restart cannot ask the daemon: it launches with the pending list, not the older one.
  const relaunched = await service.issue("thread-a", CODEX);
  assert.equal(relaunched.prepared.source, "fallback");
  assert.deepEqual([...relaunched.prepared.names], ["echo"]);
  assert.equal(relaunched.prepared.instructions, "## changed");
  assert.equal(service.needsRestart("thread-a"), false, "no restart churn");
  // A second fallback keeps it: it became the key's last list when it was adopted.
  assert.deepEqual([...(await service.issue("thread-a", CODEX)).prepared.names], ["echo"]);
  assert.deepEqual([...(await service.issue("thread-z", CODEX)).prepared.names], ["echo"], "another thread of the key too");
  // Another launch key (an account switch) never takes it.
  await assert.rejects(service.issue("thread-a", { ...CODEX, home: "acct-2" }), isSessionToolsDenialsUnknown);
});

test("a failed grant still hands back the thread's denials (they never fail open)", async (t) => {
  const service = testHost(recordingForward().forward, manifests({ "thread-a": { deny: ["remote"] } }).fetch);
  await service.stop();
  const launched = await issueSessionToolsGrant({ sessionTools: service, logger: { warn: () => {} } }, "thread-a", CODEX);
  assert.equal(launched.grant, undefined);
  assert.deepEqual(launched.prepared?.deny, ["remote"]);
  void t;
});

test("a refresh landing while a session's manifest is read is judged against what it launched with", async (t) => {
  for (const [label, refreshTools, expected, stale] of [
    ["a newer list", ["echo"], "next-idle", true],
    ["the very list it reads", TEST_NAMES, "unchanged", false]
  ] as const) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const service = testHost(recordingForward().forward, async (threadId) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return manifests().fetch(threadId);
    });
    t.after(() => service.stop());
    const issuing = service.issue("thread-a", CODEX);
    await reading;
    const refreshed = service.applyManifest("thread-a", { tools: [...refreshTools], instructions: "## Orquester (test)", deny: [] });
    release();
    await issuing;
    assert.equal(await refreshed, expected, label);
    assert.equal(service.needsRestart("thread-a"), stale, label);
  }
});

test("pushes finishing out of order never roll a list back (`superseded`)", async (t) => {
  const service = testHost(recordingForward().forward, async (threadId) => ({
    kind: "manifest",
    manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 10 }
  }));
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  // Older than what the session launched with.
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 9 }), "superseded");
  assert.equal(service.needsRestart("thread-a"), false);
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 12 }), "next-idle");
  // The seq-11 push arrives late: ignored, the seq-12 list stays wanted.
  assert.equal(await service.applyManifest("thread-a", { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 11 }), "superseded");
  assert.equal(service.needsRestart("thread-a"), true);
});

test("a session relaunched while its client was being told is not restarted again", async (t) => {
  const service = testHost(recordingForward().forward);
  t.after(() => service.stop());
  let relaunch!: () => Promise<void>;
  const first = await service.launchInProcess("thread-c", CLAUDE, async () => {
    // The thread's session restarts meanwhile (an account switch, a crash): it reads the current list.
    await relaunch();
    return false;
  });
  relaunch = async () => {
    first.release();
    await service.launchInProcess("thread-c", CLAUDE, () => true);
  };
  assert.equal(await service.applyManifest("thread-c", { tools: TEST_NAMES.filter((name) => name !== "pixel"), instructions: "## Orquester (test)", deny: [] }), "next-idle");
  // The relaunch read the daemon's manifest (every tool): it still differs, so it is wanted — but not
  // FORCED: an equal one would owe nothing.
  assert.equal(service.needsRestart("thread-c"), true);
  // The relaunch read the very list pushed (the daemon's manifest moved first): nothing is owed.
  let current: string[] = TEST_NAMES;
  const again = testHost(recordingForward().forward, async () => ({ kind: "manifest", manifest: { tools: current, instructions: "## Orquester (test)", deny: [] } }));
  t.after(() => again.stop());
  let relaunchSame!: () => Promise<void>;
  const old = await again.launchInProcess("thread-e", CLAUDE, async () => {
    await relaunchSame();
    return false;
  });
  relaunchSame = async () => {
    old.release();
    await again.launchInProcess("thread-e", CLAUDE, () => true);
  };
  current = ["echo"];
  assert.equal(await again.applyManifest("thread-e", { tools: ["echo"], instructions: "## Orquester (test)", deny: [] }), "unchanged");
  assert.equal(again.needsRestart("thread-e"), false);
});

test("a thread the daemon does not know advertises nothing", async (t) => {
  const service = testHost(recordingForward().forward, async () => ({ kind: "no-thread" }));
  t.after(() => service.stop());
  assert.equal((await service.issue("ghost", CODEX)).prepared.tools.length, 0);
});

test("a refresh: in-session for a live listener, at the next idle point otherwise, nothing without a session", async (t) => {
  const service = testHost(recordingForward().forward);
  t.after(() => service.stop());
  const changed: SessionToolsManifest = { tools: ["echo"], instructions: "## Orquester (test)", deny: [] };
  // No session.
  assert.equal(await service.applyManifest("nobody", changed), "next-start");
  // An endpoint session: marked stale until its next start.
  const grant = await service.issue("thread-a", CODEX);
  assert.equal(await service.applyManifest("thread-a", { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [] }), "unchanged");
  assert.equal(service.needsRestart("thread-a"), false);
  assert.equal(await service.applyManifest("thread-a", changed), "next-idle");
  assert.equal(service.needsRestart("thread-a"), true);
  // The relaunch reads the daemon's manifest again: nothing owed.
  await service.issue("thread-a", CODEX);
  assert.equal(service.needsRestart("thread-a"), false);
  // A revoked session (it ended) owes nothing either.
  grant.revoke();
  // An in-process session (Claude) takes the list live.
  const seen: string[][] = [];
  const { prepared, release } = await service.launchInProcess("thread-c", CLAUDE, (next) => {
    seen.push([...next.names]);
    return true;
  });
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
  // A client that never re-lists in time: served, but only a restart is certain.
  const slow = await service.launchInProcess("thread-d", CLAUDE, () => false);
  assert.equal(await service.applyManifest("thread-d", changed), "next-idle");
  assert.equal(service.needsRestart("thread-d"), true);
  assert.deepEqual(service.listSource("thread-d").list().map((tool) => tool.name), ["echo"]);
  slow.release();
});

test("the inert /mcp/denied server lists nothing and refuses every call, without a credential", async (t) => {
  const { host: service } = host(t);
  const grant = await service.issue("thread-a", CODEX);
  assert.equal(grant.deniedUrl, grant.url.replace(/\/mcp$/, "/mcp/denied"));
  const client = new Client({ name: "grok-stand-in", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.deniedUrl)));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools, []);
  await assert.rejects(client.callTool({ name: "echo", arguments: {} }));
});

test("an older refresh queued behind a launch read is superseded by a newer one queued with it (the stamp is claimed atomically)", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => (entered = resolve));
  const service = testHost(recordingForward().forward, async () => {
    entered();
    await gate;
    return { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 10, epoch: "e1" } };
  });
  t.after(() => service.stop());
  const launching = service.launchInProcess("thread-c", CLAUDE, () => true);
  await reading;
  const twelve = service.applyManifest("thread-c", { tools: ["echo"], instructions: "## Orquester (test)", deny: [], seq: 12, epoch: "e1" });
  const eleven = service.applyManifest("thread-c", { tools: ["pixel"], instructions: "## Orquester (test)", deny: [], seq: 11, epoch: "e1" });
  release();
  await launching;
  assert.deepEqual(await Promise.all([twelve, eleven]), ["live", "superseded"]);
  assert.deepEqual(service.listSource("thread-c").list().map((tool) => tool.name), ["echo"], "seq 12's list");
});

test("sequences compare within one daemon epoch: a restarted daemon (new epoch, smaller seq) is accepted", async (t) => {
  const service = testHost(recordingForward().forward, async () => ({
    kind: "manifest",
    manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 1_000_000, epoch: "old-boot" }
  }));
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 5, epoch: "old-boot" }), "superseded");
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 1, epoch: "new-boot" }), "next-idle");
  // …and the new epoch is the one compared from now on.
  assert.equal(await service.applyManifest("thread-a", { tools: TEST_NAMES, instructions: "", deny: [], seq: 1, epoch: "new-boot" }), "superseded");
  // A deleted thread forgets its stamps.
  service.forgetThread("thread-a");
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 1, epoch: "new-boot" }), "next-idle");
});

test("the launch-key fallback copies another thread's list WITHOUT its stamp", async (t) => {
  let up = true;
  const service = testHost(recordingForward().forward, async () =>
    up ? { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: ["remote"], seq: 50, epoch: "e1" } } : { kind: "unavailable" }
  );
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  up = false;
  const copy = await service.issue("thread-b", CODEX);
  assert.deepEqual(copy.prepared.deny, ["remote"]);
  assert.equal(copy.prepared.seq, undefined);
  assert.equal(copy.prepared.epoch, undefined);
  // thread-b's own refreshes are not judged against thread-a's sequence.
  assert.equal(await service.applyManifest("thread-b", { tools: ["echo"], instructions: "", deny: ["remote"], seq: 7, epoch: "e1" }), "next-idle");
});

test("a relaunch that already read this change or a newer one owes nothing (`superseded`)", async (t) => {
  let seq = 1;
  let tools: string[] = TEST_NAMES;
  const service = testHost(recordingForward().forward, async () => ({ kind: "manifest", manifest: { tools, instructions: "## Orquester (test)", deny: [], seq, epoch: "e1" } }));
  t.after(() => service.stop());
  let relaunch!: () => Promise<void>;
  const first = await service.launchInProcess("thread-c", CLAUDE, async () => {
    await relaunch();
    return false;
  });
  relaunch = async () => {
    first.release();
    // The daemon moved on to seq 3 (yet another list) before the relaunch read it.
    seq = 3;
    tools = ["pixel"];
    await service.launchInProcess("thread-c", CLAUDE, () => true);
  };
  assert.equal(await service.applyManifest("thread-c", { tools: ["echo"], instructions: "## Orquester (test)", deny: [], seq: 2, epoch: "e1" }), "superseded");
  assert.equal(service.needsRestart("thread-c"), false);
});

test("a daemon epoch some thread moved on from is retired host-wide", async (t) => {
  let epoch = "boot-1";
  const service = testHost(recordingForward().forward, async () => ({ kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 100, epoch } }));
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  await service.issue("thread-b", CODEX);
  // thread-a hears from the restarted daemon…
  epoch = "boot-2";
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 1, epoch: "boot-2" }), "next-idle");
  // …so a late push of the old daemon is stale everywhere, thread-b included.
  assert.equal(await service.applyManifest("thread-b", { tools: ["echo"], instructions: "", deny: [], seq: 500, epoch: "boot-1" }), "superseded");
});

test("a fallback (the thread's own last manifest too) carries no stamp and records none", async (t) => {
  let up = true;
  const service = testHost(recordingForward().forward, async () =>
    up ? { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: 50, epoch: "e1" } } : { kind: "unavailable" }
  );
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  up = false;
  const again = await service.issue("thread-a", CODEX);
  assert.equal(again.prepared.source, "fallback");
  assert.equal(again.prepared.seq, undefined);
  // The relaunch recorded nothing new; a newer refresh is judged against the last REAL manifest.
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 51, epoch: "e1" }), "next-idle");
});

test("a launch whose read is OLDER than a refresh that claimed meanwhile keeps the refresh's wanted list", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => (entered = resolve));
  const service = testHost(recordingForward().forward, async () => {
    reads += 1;
    if (reads === 2) {
      entered();
      await gate;
    }
    return { kind: "manifest", manifest: { tools: TEST_NAMES, instructions: "## Orquester (test)", deny: [], seq: reads === 1 ? 10 : 11, epoch: "e1" } };
  });
  t.after(() => service.stop());
  await service.issue("thread-a", CODEX);
  // The newer refresh is wanted (a restart at idle)…
  assert.equal(await service.applyManifest("thread-a", { tools: ["echo"], instructions: "", deny: [], seq: 12, epoch: "e1" }), "next-idle");
  // …and a relaunch whose read (seq 11) is older than it must not drop it.
  const relaunch = service.issue("thread-a", CODEX);
  await reading;
  release();
  await relaunch;
  assert.equal(service.needsRestart("thread-a"), true);
});
