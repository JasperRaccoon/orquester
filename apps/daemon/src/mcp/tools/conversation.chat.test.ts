/**
 * The conversation family (unified MCP design 2026-10-15 §4 rows 10, 13–16, §8, §13 a–d) through THE
 * executor with the approval-port double, for chat and external callers: reply modes (wait / notify /
 * none) over the reply-subscription routes, provenance header v2, the exchange (`causedBy`, hop cap),
 * queue-not-steer for external waits, the release of a cancelled wait, `create_session`'s defaults,
 * caps, lineage (`opened` / `delegate`, `agentCreated`) and account source, forks marked
 * `agentCreated`, merge-back for forks only, and `wait_for_session`'s settle wait (content rights,
 * empty replies, `WAIT_CYCLE`).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSET_IDS, type SessionSummary } from "@orquester/api";
import { agentChatRoutes, parseThreadMessage, replyNoticeText, THREAD_MESSAGE_CONTEXT_KIND, UNTRUSTED_NOTICE, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";

import { registerWait } from "../../agent-chat/waits.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { toolByName } from "../catalog/index.ts";
import { chatToolByName } from "../../session-tools/legacy-aliases.ts";
import { audienceDescription, audienceSchema, audienceShape, executeToolCall } from "../executor.ts";
import { chatSummary, head, message, snapshot, stamp, turn } from "../fixtures.ts";
import { busEvent, FakeDaemonApi } from "../testing.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "umcp-t8-")));
const WS = join(ROOT, "w");
const OWN = join(WS, "jaspersito/orquester");
const SAME = join(WS, "jaspersito/orquester-3");
const OTHER = join(WS, "beta/app");
for (const dir of [OWN, SAME, OTHER, join(OWN, "src")]) mkdirSync(dir, { recursive: true });
/** Outside the sandbox (`fsRoot` is ROOT). */
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), "umcp-t8-outside-")));
symlinkSync(OUTSIDE, join(OWN, "escape"));
symlinkSync(OTHER, join(OWN, "sidestep"));
/** A project directory that is itself a link out of the sandbox. */
symlinkSync(OUTSIDE, join(WS, "jaspersito/linked"));
test.after(() => { rmSync(ROOT, { recursive: true, force: true }); rmSync(OUTSIDE, { recursive: true, force: true }); });

const tab = (id: string, projectPath: string, over: Partial<SessionSummary> = {}) => chatSummary({ id, title: `Chat ${id}`, projectPath, cwd: projectPath, ...over });

function tabs(): SessionSummary[] {
  return [
    tab("me", OWN, { title: "Implement auth", accountId: "acc-1" }),
    tab("peer", OWN, { title: "Peer", refId: "codex" }),
    tab("near", SAME, { title: "Near" }),
    tab("far", OTHER, { title: "Far" }),
    tab("fork", OWN, { title: "My fork", lineage: { parentThreadId: "me", relation: "fork", createdAt: stamp(1), agentCreated: true } }),
    tab("task", OWN, { title: "My task", lineage: { parentThreadId: "me", relation: "delegate", createdAt: stamp(1), agentCreated: true } })
  ];
}

const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } }
] };
const effort = { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] };
const providers = { hostInstanceId: "h", providers: [
  { id: "claude", refIds: ["claude"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], capabilities: { showPlanModeToggle: true },
    models: [{ slug: "claude-fable-5-1[1m]", name: "Fable", isDefault: true, capabilities: effort }, { slug: "claude-3", name: "Old", isLegacy: true, capabilities: null }] },
  { id: "codex", refIds: ["codex"], installed: true, version: "1", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], capabilities: { showPlanModeToggle: false },
    models: [{ slug: "gpt-old", name: "Old", isDefault: true, isLegacy: true, capabilities: null }, { slug: "gpt-5", name: "GPT-5", capabilities: effort }] }
] };
const accounts = { accounts: [{ id: "acc-1", agent: "claude", label: "work", email: "me@example.com", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: null, codex: null, grok: null } };

function thread(id: string, over: Partial<ThreadSnapshotPayload> = {}): ThreadSnapshotPayload {
  return snapshot({ head: head({ id, runtimeMode: "auto" }), items: [message("user", `ask ${id}`), message("assistant", `reply of ${id}`)], turns: [turn()], ...over });
}

interface RigOptions {
  sessions?: SessionSummary[];
  threads?: Record<string, ThreadSnapshotPayload>;
}

function rig(options: RigOptions = {}) {
  const api = new FakeDaemonApi();
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const sessions = options.sessions ?? tabs();
  const threads: Record<string, ThreadSnapshotPayload> = { me: thread("me", { head: head({ id: "me", runtimeMode: "full-access" }) }), ...options.threads };
  api.on("GET", "/api/sessions", ({ query }) => ({ status: 200, body: query?.projectPath ? sessions.filter((s) => s.projectPath === query.projectPath) : sessions }))
    .on("GET", "/api/registry", { status: 200, body: registry })
    .on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts })
    .on("GET", "/api/workspaces", { status: 200, body: [] })
    .on("GET", "/api/accounts", { status: 200, body: [] });
  for (const s of sessions) api.on("GET", agentChatRoutes.thread(s.id), () => ({ status: 200, body: { kind: "snapshot", thread: threads[s.id] ?? thread(s.id) } }));
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "" });
  const caller = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
    kind: "thread", threadId: "me", title: "Implement auth", projectPath: OWN, workspace: "jaspersito", cwd: OWN, agentId: "claude",
    callId: `call-${Math.random()}`, runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  });
  const deps = { approvals: port, enabledToolsets: async () => new Set(TOOLSET_IDS), lookup: (n: string, audience: "external" | "chat") => toolByName(n, audience), newId: () => "ex-new" };
  const call = (name: string, args: Record<string, unknown>, over: Partial<ThreadCaller> = {}, signal = new AbortController().signal) =>
    executeToolCall(deps, { name, arguments: args }, { caller: caller(over), api, signal });
  const external = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
    executeToolCall(deps, { name, arguments: args }, { caller: { kind: "external" }, api, signal });
  return { api, port, call, external, sessions, threads };
}

const body = (result: CallToolResult) => result.structuredContent as Record<string, any>;
const code = (result: CallToolResult) => (result.isError ? body(result).code : undefined);
const posted = (api: FakeDaemonApi, path: string) => api.calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body as Record<string, any>);

/** The reply-subscription routes as Task 5's router answers them. */
function replyRoutes(api: FakeDaemonApi, target: string, wait: (body: any) => any = () => ({ outcome: "replied", turnId: "t9", state: "completed", reply: "Found 3 issues." })) {
  api.on("POST", agentChatRoutes.replySubscriptions(target), { status: 200, body: { subscriptionId: "sub-1", commandId: "cmd-1", delivery: "sent", seq: 4 } });
  api.on("POST", agentChatRoutes.replySubscriptionWait(target, "sub-1"), ({ body: b }) => ({ status: 200, body: wait(b) }));
}

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

test("send_message notify: persisted subscription with a v2 header, the new exchange at hop 1, the chip; returns at once", async () => {
  const r = rig();
  replyRoutes(r.api, "peer");
  const result = await r.call("send_message", { sessionId: "peer", text: "Review my diff", reply: "notify" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [sub] = posted(r.api, agentChatRoutes.replySubscriptions("peer"));
  assert.equal(sub.fromThreadId, "me");
  assert.equal(sub.reply, "notify");
  assert.equal(sub.origin, "sent");
  assert.deepEqual(sub.causedBy, { threadId: "me", exchangeId: "ex-new", hop: 1 });
  assert.deepEqual(sub.context.map((c: { kind: string }) => c.kind), [THREAD_MESSAGE_CONTEXT_KIND]);
  assert.match(sub.idempotencyKey, /^[0-9a-f]{64}$/);
  const parsed = parseThreadMessage(sub.input)!;
  assert.equal(parsed.origin, "sent");
  assert.equal(parsed.fromSessionId, "me");
  assert.equal(parsed.fromProject, "jaspersito/orquester");
  assert.equal(parsed.body, "Review my diff");
  assert.match(sub.input, /goes back to it automatically/);
  assert.equal(body(result).willNotify, true);
  assert.equal(body(result).delivery, "sent");
  assert.deepEqual(body(result).threadRef, { threadId: "peer", title: "Peer", relation: "thread" });
  assert.equal(posted(r.api, agentChatRoutes.replySubscriptionWait("peer", "sub-1")).length, 0, "notify never waits");
});

test("send_message wait: the bound turn's reply, marked as another agent's words; a running exchange continues at hop + 1", async () => {
  const r = rig();
  replyRoutes(r.api, "peer");
  const result = await r.call("send_message", { sessionId: "peer", text: "Re-review", timeoutSeconds: 30 }, { exchange: { id: "ex-1", hop: 2 } });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  assert.deepEqual(posted(r.api, agentChatRoutes.replySubscriptions("peer"))[0]!.causedBy, { threadId: "me", exchangeId: "ex-1", hop: 3 });
  assert.deepEqual(posted(r.api, agentChatRoutes.replySubscriptionWait("peer", "sub-1"))[0], { timeoutSeconds: 30 });
  const out = body(result);
  assert.equal(Object.keys(out)[0], "notice");
  assert.equal(out.notice, UNTRUSTED_NOTICE);
  assert.equal(out.outcome, "completed");
  assert.equal(out.reply, "Found 3 issues.");
  assert.equal(out.turnId, "t9");
});

test("send_message wait: a question or the timeout goes on as notify; an empty reply says so (§13 d); a closed target too", async () => {
  const cases: [unknown, Record<string, unknown>][] = [
    [{ outcome: "notify", reason: "needs-input", willNotify: true }, { outcome: "needs-input", willNotify: true }],
    [{ outcome: "notify", reason: "timeout", willNotify: true }, { outcome: "timeout", willNotify: true }],
    [{ outcome: "replied", turnId: "t9", state: "completed", emptyReply: true }, { outcome: "completed", emptyReply: true, hint: replyNoticeText("empty", { title: "Peer", sessionId: "peer" }) }],
    [{ outcome: "replied", turnId: "t9", state: "failed", error: "boom" }, { outcome: "failed", error: "boom" }],
    [{ outcome: "closed" }, { outcome: "closed" }]
  ];
  for (const [answer, expected] of cases) {
    const r = rig();
    replyRoutes(r.api, "peer", () => answer);
    const out = body(await r.call("send_message", { sessionId: "peer", text: "?" }));
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(out[key], value, `${JSON.stringify(answer)}: ${key}`);
  }
});

test("send_message wait cancelled: the waiter is released through its route, once, so the reply comes as a message", async () => {
  const r = rig();
  r.api.on("POST", agentChatRoutes.replySubscriptions("peer"), { status: 200, body: { subscriptionId: "sub-1", commandId: "cmd-1", delivery: "queued", queueEntryId: "cmd-1" } });
  let answer!: (value: unknown) => void;
  const waited = new Promise((resolve) => { answer = resolve; });
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => { arrived = resolve; });
  // The wait answers only once released.
  const realRequest = r.api.request.bind(r.api);
  r.api.request = async (method, path, opts) => {
    if (path === agentChatRoutes.replySubscriptionWait("peer", "sub-1")) {
      r.api.calls.push({ method, path, body: opts?.body });
      arrived();
      return (await waited) as never;
    }
    return realRequest(method, path, opts);
  };
  let releases = 0;
  r.api.on("POST", agentChatRoutes.replySubscriptionRelease("peer", "sub-1"), () => {
    releases += 1;
    answer({ status: 200, body: { outcome: "notify", reason: "timeout", willNotify: true } });
    return { status: 200, body: { released: true, state: "notify" } };
  });
  const controller = new AbortController();
  const running = r.call("send_message", { sessionId: "peer", text: "Long job" }, {}, controller.signal);
  await waiting;
  controller.abort();
  const result = await running;
  assert.equal(releases, 1, "one release: the router's tombstone makes it deterministic in every order");
  assert.equal(body(result).willNotify, true);
});

test("send_message none: a working target is steered with a header asking for a send_message answer; one waiting for its user is refused", async () => {
  const working = thread("peer", { head: head({ id: "peer", runtimeMode: "auto", session: { status: "running", activeTurnId: "t2" } }) });
  const r = rig({ threads: { peer: working } });
  r.api.on("POST", "/api/sessions/peer/turn", { status: 200, body: { seq: 12 } });
  const result = await r.call("send_message", { sessionId: "peer", text: "FYI: tests are green", reply: "none" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [turnBody] = posted(r.api, "/api/sessions/peer/turn");
  // `peer` runs auto, narrower than this Full access chat: it may not message back, and is told so.
  assert.match(turnBody!.input, /The sender can't be messaged from this chat; your answer is visible in this chat\./);
  assert.doesNotMatch(turnBody!.input, /send_message/);
  assert.deepEqual(turnBody!.causedBy, { threadId: "me", exchangeId: "ex-new", hop: 1 });
  assert.equal(turnBody!.ifIdle, undefined, "none steers");
  const peerOfSameMode = rig({ threads: { peer: working } });
  peerOfSameMode.api.on("POST", "/api/sessions/peer/turn", { status: 200, body: { seq: 13 } });
  await peerOfSameMode.call("send_message", { sessionId: "peer", text: "FYI", reply: "none" }, { runtimeMode: "auto" });
  assert.match(posted(peerOfSameMode.api, "/api/sessions/peer/turn")[0]!.input, /To answer, call send_message with sessionId me\./, "a receiver as broad as the sender may answer");
  assert.equal(body(result).outcome, "sent");
  assert.equal(posted(r.api, agentChatRoutes.replySubscriptions("peer")).length, 0);

  const asking = thread("peer", { pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } as never });
  const refused = rig({ threads: { peer: asking } });
  const out = await refused.call("send_message", { sessionId: "peer", text: "hi", reply: "none" });
  assert.equal(code(out), "PENDING_REQUEST");
  assert.match(body(out).message, /reply "wait" or "notify"/);
  assert.doesNotMatch(body(out).message, /answer_question|resolve_approval|dismiss_question/);
});

test("send_message refusals: self, the exchange cap (before any route), a broader target, implementPlan while planning", async () => {
  const r = rig();
  replyRoutes(r.api, "peer");
  assert.equal(code(await r.call("send_message", { sessionId: "me", text: "hi" })), "PERMISSION_DENIED");
  const capped = await r.call("send_message", { sessionId: "peer", text: "hi" }, { exchange: { id: "ex-1", hop: 8 } });
  assert.equal(code(capped), "EXCHANGE_LIMIT");
  assert.match(body(capped).message, /Summarise for your user/);
  assert.equal(r.api.calls.filter((c) => c.method === "POST").length, 0, "nothing posted past the cap");
  const atSeven = await r.call("send_message", { sessionId: "peer", text: "hi", reply: "notify" }, { exchange: { id: "ex-1", hop: 7 } });
  assert.equal(posted(r.api, agentChatRoutes.replySubscriptions("peer"))[0]!.causedBy.hop, 8, "hop 8 is the last allowed");
  assert.equal(atSeven.isError, undefined);
  const broader = rig({ threads: { peer: thread("peer", { head: head({ id: "peer", runtimeMode: "full-access" }) }) } });
  assert.equal(code(await broader.call("send_message", { sessionId: "peer", text: "hi" }, { runtimeMode: "auto" })), "PERMISSION_DENIED");
  const planning = await r.call("send_message", { sessionId: "peer", implementPlan: true }, { planning: true });
  assert.equal(code(planning), "PERMISSION_DENIED");
  assert.match(body(planning).message, /planning/);
});

test("send_message carries plan mode on, and refuses an agent with no plan mode while planning", async () => {
  const r = rig();
  replyRoutes(r.api, "near");
  const planned = await r.call("send_message", { sessionId: "near", text: "Plan the migration", reply: "notify" }, { planning: true });
  assert.equal(planned.isError, undefined, JSON.stringify(body(planned)));
  assert.equal(posted(r.api, agentChatRoutes.replySubscriptions("near"))[0]!.interactionMode, "plan");
  assert.equal(body(planned).planMode, true);
  // `peer` runs Codex, whose capabilities show no plan mode.
  const refused = await r.call("send_message", { sessionId: "peer", text: "Plan it" }, { planning: true });
  assert.equal(code(refused), "PERMISSION_DENIED");
});

test("send_message implementPlan: the plan as the GUI's Implement sends it (no header: the host marks it implemented), chip and exchange kept", async () => {
  const plan = { kind: "activity", id: "plan-1", tone: "info", activityKind: "turn.proposed.completed", summary: "Plan", payload: { planMarkdown: "1. Do it" }, turnId: "t1", createdAt: stamp(3), updatedAt: stamp(3) };
  const r = rig({ threads: { peer: thread("peer", { items: [message("user", "plan please"), plan as never] }) } });
  r.api.on("POST", "/api/sessions/peer/turn", { status: 200, body: { seq: 3 } });
  const result = await r.call("send_message", { sessionId: "peer", implementPlan: true, reply: "none" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [turnBody] = posted(r.api, "/api/sessions/peer/turn");
  assert.equal(turnBody!.input, "PLEASE IMPLEMENT THIS PLAN:\n1. Do it");
  assert.equal(turnBody!.interactionMode, "default");
  assert.deepEqual(turnBody!.context.map((c: { kind: string }) => c.kind), [THREAD_MESSAGE_CONTEXT_KIND]);
  assert.equal(turnBody!.causedBy.hop, 1);
});

test("send_message across projects: Full access acts in its workspace; a supervised caller gets a composed boundary card, never raw arguments", async () => {
  const r = rig();
  replyRoutes(r.api, "near");
  assert.equal((await r.call("send_message", { sessionId: "near", text: "hi", reply: "notify" })).isError, undefined);
  assert.equal(r.port.cards.length, 0);
  const supervised = rig({ threads: { near: thread("near", { head: head({ id: "near", runtimeMode: "approval-required" }) }) } });
  replyRoutes(supervised.api, "near");
  const attached = await supervised.call("send_message", { sessionId: "near", text: "Please look", reply: "notify", attachments: [{ name: "a.png", base64: Buffer.from("png-bytes").toString("base64") }] }, { runtimeMode: "approval-required" });
  assert.equal(attached.isError, undefined, JSON.stringify(body(attached)));
  const [card] = supervised.port.cards;
  assert.equal(card!.kind, "boundary");
  assert.equal(card!.family, "cross-project");
  const shown = JSON.stringify(card!.sections);
  assert.match(shown, /Please look/);
  assert.match(shown, /a\.png \(\d+ bytes\)/);
  assert.doesNotMatch(shown, new RegExp(Buffer.from("png-bytes").toString("base64")), "no attachment bytes on the card");
  // A workflow-owned chat never acts in another project.
  const owned = await r.call("send_message", { sessionId: "near", text: "hi", reply: "notify" }, { workflowOwned: true });
  assert.equal(code(owned), "PERMISSION_DENIED");
});

test("an old host's thread_send {wait} (Task 6's real alias onto send_message): no subscription — the old steer-and-wait, a registered wait (WAIT_CYCLE)", async () => {
  const r = rig();
  const release = registerWait("peer", "me");
  try {
    // The production alias lookup: thread_send {wait: true} → send_message {reply: "wait"} with ctx.legacyAlias "thread_send".
    const deps = { approvals: r.port, enabledToolsets: async () => new Set(TOOLSET_IDS), lookup: (name: string) => chatToolByName(name) };
    const cycle = await executeToolCall(deps, { name: "thread_send", arguments: { threadId: "peer", text: "hi", wait: true } }, {
      caller: { kind: "thread", threadId: "me", title: "Implement auth", projectPath: OWN, workspace: "jaspersito", cwd: OWN, agentId: "claude", callId: "c1", runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null },
      api: r.api, signal: new AbortController().signal
    });
    assert.equal(code(cycle), "WAIT_CYCLE");
  } finally {
    release();
  }
  assert.equal(posted(r.api, agentChatRoutes.replySubscriptions("peer")).length, 0);
});

test("send_message from an external client: notify and delegate are chat-only; wait queues behind a working session under one command id", async () => {
  const r = rig();
  assert.equal(code(await r.external("send_message", { sessionId: "peer", text: "hi", reply: "notify" })), "INVALID_ARGUMENT");
  assert.equal(code(await r.external("create_session", { project: "jaspersito/orquester", agent: "claude", delegate: true })), "INVALID_ARGUMENT");
  let busy = true;
  const posts: Record<string, any>[] = [];
  const done = snapshot({ head: head({ id: "peer" }), turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(5), startedAt: stamp(5), completedAt: stamp(6) })], items: [message("assistant", "the new answer", { turnId: "t2" })] });
  r.api.on("GET", agentChatRoutes.thread("peer"), () => ({ status: 200, body: { kind: "snapshot", thread: busy ? thread("peer", { head: head({ id: "peer", session: { status: "running", activeTurnId: "t1" } }), turns: [turn({ state: "running", completedAt: null })] }) : posts.length > 1 ? done : thread("peer") } }));
  const waiters: [number, () => void][] = [];
  const postCount = (n: number) => new Promise<void>((resolve) => { if (posts.length >= n) resolve(); else waiters.push([n, resolve]); });
  r.api.on("POST", "/api/sessions/peer/turn", ({ body: b }) => {
    posts.push(b as Record<string, any>);
    for (const [n, wake] of waiters) if (posts.length >= n) wake();
    return busy ? { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "working" } } } : { status: 200, body: { seq: 20 } };
  });
  const running = r.external("send_message", { sessionId: "peer", text: "Next task", timeoutSeconds: 30 });
  await postCount(1);
  assert.equal(posts[0]!.ifIdle, true, "never a steer");
  busy = false;
  const summaries = r.sessions.map((s) => (s.id === "peer" ? { ...s, latestTurn: { turnId: "t1", state: "completed" as const, startedAt: stamp(0), completedAt: stamp(1) } } : s));
  r.api.on("GET", "/api/sessions", { status: 200, body: summaries });
  r.api.emit(busEvent("session.updated", summaries.find((s) => s.id === "peer")));
  await postCount(2);
  assert.equal(posts[1]!.commandId, posts[0]!.commandId, "posted again under the same command id");
  const later = summaries.map((s) => (s.id === "peer" ? { ...s, latestTurn: { turnId: "t2", state: "completed" as const, startedAt: stamp(5), completedAt: stamp(6) } } : s));
  r.api.on("GET", "/api/sessions", { status: 200, body: later });
  r.api.emit(busEvent("session.updated", later.find((s) => s.id === "peer")));
  const result = await running;
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  assert.equal(body(result).outcome, "completed");
  assert.equal(body(result).reply, "the new answer");
});

// ---------------------------------------------------------------------------
// create_session
// ---------------------------------------------------------------------------

function createRoutes(api: FakeDaemonApi, sessions: SessionSummary[]) {
  const creates: Record<string, any>[] = [];
  api.on("POST", "/api/sessions", ({ body: b }) => {
    const req = b as Record<string, any>;
    creates.push(req);
    const created = tab("new", req.projectPath, { title: req.title, refId: req.refId, ...(req.accountId && req.accountId !== "system" ? { accountId: req.accountId } : {}), ...(req.chat?.lineage ? { lineage: { ...req.chat.lineage, createdAt: stamp(9) } } : {}) });
    sessions.push(created);
    return { status: 200, body: created };
  });
  api.on("POST", "/api/sessions/new/turn", { status: 200, body: { seq: 2 } });
  api.on("GET", agentChatRoutes.thread("new"), { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ id: "new" }), turns: [] }) } });
  return creates;
}

test("create_session from a chat: an opened child of this chat with its mode, model, options and account; the first turn names its sender", async () => {
  const r = rig();
  const creates = createRoutes(r.api, r.sessions);
  const result = await r.call("create_session", { prompt: "Summarise the README" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [req] = creates;
  assert.equal(req!.projectPath, OWN);
  assert.equal(req!.cwd, OWN);
  assert.equal(req!.refId, "claude");
  assert.equal(req!.chat.runtimeMode, "full-access");
  assert.deepEqual(req!.chat.modelSelection, { model: "claude-fable-5-1[1m]", options: [{ id: "effort", value: "high" }] });
  assert.equal(req!.chat.accountId, "acc-1");
  assert.deepEqual(req!.chat.lineage, { parentThreadId: "me", relation: "opened", agentCreated: true });
  const out = body(result);
  assert.equal(out.accountSource, "inherited");
  assert.equal(out.relation, "opened");
  assert.deepEqual(out.threadRef, { threadId: "new", title: "Claude Code", relation: "opened" });
  assert.equal(out.outcome, "sent");
  const [first] = posted(r.api, "/api/sessions/new/turn");
  assert.equal(parseThreadMessage(first!.input)!.origin, "opened");
  assert.match(first!.input, /To answer, call send_message with sessionId me\./, "reply none: the opened chat answers by send_message");
  assert.deepEqual(first!.causedBy, { threadId: "me", exchangeId: "ex-new", hop: 1 });
  assert.ok(JSON.stringify(out).indexOf("me@example.com") === -1, "no account email in a chat result");
});

test("create_session delegate: notify by default, a \"Task:\" title, origin delegated; another agent gets its own defaults (never a legacy model)", async () => {
  const r = rig();
  const creates = createRoutes(r.api, r.sessions);
  replyRoutes(r.api, "new");
  const result = await r.call("create_session", { agent: "codex", runtimeMode: "approval-required", prompt: "Review the uncommitted diff\nin this project", delegate: true });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [req] = creates;
  assert.equal(req!.title, "Task: Review the uncommitted diff");
  assert.equal(req!.chat.runtimeMode, "approval-required");
  assert.equal(req!.chat.modelSelection.model, "gpt-5", "the default skips the legacy-flagged model");
  assert.equal(req!.chat.accountId, undefined);
  assert.deepEqual(req!.chat.lineage, { parentThreadId: "me", relation: "delegate", agentCreated: true });
  const [sub] = posted(r.api, agentChatRoutes.replySubscriptions("new"));
  assert.equal(sub!.reply, "notify");
  assert.equal(sub!.origin, "delegated");
  assert.match(sub!.input, /your final reply is its result and goes back automatically/);
  const out = body(result);
  assert.equal(out.accountSource, "family-default");
  assert.equal(out.willNotify, true);
  assert.equal(out.relation, "delegate");
  // A legacy model named explicitly is accepted and marked.
  const legacy = await r.call("create_session", { agent: "codex", model: "gpt-old", prompt: "hi" });
  assert.equal(body(legacy).isLegacy, true);
});

test("create_session caps and refusals: a broader mode, no prompt, 6 unfinished children (GUI forks don't count), depth 2, cwd outside the project", async () => {
  const r = rig();
  createRoutes(r.api, r.sessions);
  assert.equal(code(await r.call("create_session", { prompt: "x", runtimeMode: "full-access" }, { runtimeMode: "auto" })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("create_session", {})), "INVALID_ARGUMENT");
  assert.equal(code(await r.call("create_session", { prompt: "x", cwd: OTHER })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("create_session", { prompt: "x", cwd: "src" })), undefined);
  const working = { chatSessionStatus: "running" as const };
  const kids = (n: number, agentCreated: boolean) => Array.from({ length: n }, (_, i) => tab(`kid${agentCreated ? "a" : "g"}${i}`, OWN, { ...working, lineage: { parentThreadId: "me", relation: "fork", createdAt: stamp(1), ...(agentCreated ? { agentCreated: true as const } : {}) } }));
  const full = rig({ sessions: [...tabs(), ...kids(6, true)] });
  createRoutes(full.api, full.sessions);
  const limited = await full.call("create_session", { prompt: "x" });
  assert.equal(code(limited), "DELEGATION_LIMIT");
  const gui = rig({ sessions: [...tabs(), ...kids(5, true), ...kids(4, false)] });
  createRoutes(gui.api, gui.sessions);
  assert.equal((await gui.call("create_session", { prompt: "x" })).isError, undefined, "GUI forks are the user's");
  const deep = rig({ sessions: tabs().map((s) => (s.id === "me" ? { ...s, lineage: { parentThreadId: "root", relation: "delegate" as const, createdAt: stamp(0), delegationDepth: 2, agentCreated: true as const } } : s)) });
  createRoutes(deep.api, deep.sessions);
  assert.equal(code(await deep.call("create_session", { prompt: "x" })), "DELEGATION_LIMIT");
});

test("create_session (ported from the old delegate_task): a child opened a moment ago counts before its summary shows a turn, one that never started stops counting after its grace; depth is counted up the open tabs; a chat with no project names one", async () => {
  const child = (id: string, createdAt: string) => tab(id, OWN, { createdAt, latestTurn: null, lineage: { parentThreadId: "me", relation: "delegate", createdAt: stamp(1), agentCreated: true } });
  // Six just opened, no turn on their summary yet: they hold their slots.
  const fresh = new Date().toISOString();
  const r = rig({ sessions: [...tabs().filter((s) => s.lineage?.parentThreadId !== "me"), ...Array.from({ length: 6 }, (_, i) => child(`kid${i}`, fresh))] });
  createRoutes(r.api, r.sessions);
  assert.equal(code(await r.call("create_session", { prompt: "x", delegate: true })), "DELEGATION_LIMIT");
  // Six that never started, opened more than the grace window ago: no slot held.
  const stale = new Date(Date.now() - 61_000).toISOString();
  const later = rig({ sessions: [...tabs().filter((s) => s.lineage?.parentThreadId !== "me"), ...Array.from({ length: 6 }, (_, i) => child(`old${i}`, stale))] });
  createRoutes(later.api, later.sessions);
  const room = await later.call("create_session", { prompt: "x", delegate: true, reply: "none" });
  assert.equal(room.isError, undefined, JSON.stringify(body(room)));
  // Lineage records from before `delegationDepth`: counted up the open tabs (me → d1 → d1f (a fork, not counted) → d2).
  const chain = [
    ...tabs().map((s) => (s.id === "me" ? { ...s, lineage: undefined } : s)),
    tab("d1", OWN, { lineage: { parentThreadId: "me", relation: "delegate", createdAt: stamp(1), agentCreated: true } }),
    tab("d1f", OWN, { lineage: { parentThreadId: "d1", relation: "fork", createdAt: stamp(1), agentCreated: true } }),
    tab("d2", OWN, { lineage: { parentThreadId: "d1f", relation: "delegate", createdAt: stamp(1), agentCreated: true } })
  ];
  const deep = rig({ sessions: chain, threads: { d1: thread("d1", { head: head({ id: "d1", runtimeMode: "full-access" }) }), d2: thread("d2", { head: head({ id: "d2", runtimeMode: "full-access" }) }) } });
  createRoutes(deep.api, deep.sessions);
  assert.equal(code(await deep.call("create_session", { prompt: "more", delegate: true }, { threadId: "d2" })), "DELEGATION_LIMIT");
  const fine = await deep.call("create_session", { prompt: "fine", delegate: true, reply: "none" }, { threadId: "d1" });
  assert.equal(fine.isError, undefined, JSON.stringify(body(fine)));
  // A chat bound to no project opens a chat only where it names one.
  const homeless = rig();
  createRoutes(homeless.api, homeless.sessions);
  assert.equal(code(await homeless.call("create_session", { prompt: "x" }, { projectPath: "", workspace: "" })), "INVALID_ARGUMENT");
});

test("create_session in another workspace: a boundary card showing the prompt; workflow-owned callers are denied; an inherited account gone falls back", async () => {
  const r = rig();
  createRoutes(r.api, r.sessions);
  const result = await r.call("create_session", { project: "beta/app", prompt: "Look at the API" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [card] = r.port.cards;
  assert.equal(card!.kind, "boundary");
  assert.match(JSON.stringify(card!.sections), /Look at the API/);
  assert.equal(code(await r.call("create_session", { project: "beta/app", prompt: "x" }, { workflowOwned: true })), "PERMISSION_DENIED");
  const gone = rig({ sessions: tabs().map((s) => (s.id === "me" ? { ...s, accountId: "acc-gone" } : s)) });
  createRoutes(gone.api, gone.sessions);
  const fallback = body(await gone.call("create_session", { prompt: "x" }));
  assert.equal(fallback.accountSource, "family-default");
  assert.match(fallback.accountNote, /not usable/);
});

test("create_session from an external client: project required, full-access by default, no lineage, reply none by default", async () => {
  const r = rig();
  const creates = createRoutes(r.api, r.sessions);
  assert.equal(code(await r.external("create_session", { agent: "claude" })), "INVALID_ARGUMENT");
  const result = await r.external("create_session", { project: "jaspersito/orquester", agent: "claude", prompt: "hello" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [req] = creates;
  assert.equal(req!.chat.runtimeMode, "full-access");
  assert.equal(req!.chat.lineage, undefined);
  assert.equal(body(result).accountSource, "family-default");
  assert.equal(body(result).session.id, "new");
  const [first] = posted(r.api, "/api/sessions/new/turn");
  assert.equal(first!.input, "hello", "no provenance header from an external client");
  assert.equal(first!.causedBy, undefined);
});

// ---------------------------------------------------------------------------
// fork_session, merge_back_session
// ---------------------------------------------------------------------------

test("fork_session from a chat forks itself by default, marked agentCreated, finished turns only", async () => {
  const r = rig({ threads: { me: thread("me", { head: head({ id: "me", runtimeMode: "full-access" }), turns: [turn(), turn({ turnId: "t2", turnCount: 2, state: "running", completedAt: null })] }) } });
  r.api.on("POST", agentChatRoutes.fork("me"), { status: 200, body: { session: tab("f2", OWN, { title: "Implement auth (fork)" }), strategy: "native", lineage: { parentThreadId: "me", relation: "fork", createdAt: stamp(1), agentCreated: true } } });
  const result = await r.call("fork_session", { throughTurn: 1 });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  const [req] = posted(r.api, agentChatRoutes.fork("me"));
  assert.equal(req!.agentCreated, true);
  assert.equal(req!.turnId, "t1");
  assert.deepEqual(body(result).threadRef, { threadId: "f2", title: "Implement auth (fork)", relation: "fork" });
  assert.equal(code(await r.call("fork_session", { throughTurn: 2 })), "INVALID_ARGUMENT", "the running turn is not part of a fork");
  assert.equal(code(await r.external("fork_session", {})), "INVALID_ARGUMENT", "external callers name the session");
});

test("merge_back_session: forks only — a delegate is told its final reply goes back by itself; a fork merges with its exchange", async () => {
  const r = rig();
  r.api.on("POST", agentChatRoutes.mergeBack("fork"), { status: 200, body: { parentSessionId: "me", delivery: "queued", mergeId: "m1" } });
  const delegate = await r.call("merge_back_session", { text: "done" }, { threadId: "task", title: "My task" });
  assert.equal(code(delegate), "INVALID_ARGUMENT");
  assert.match(body(delegate).message, /delivered to your parent automatically/);
  assert.equal(code(await r.call("merge_back_session", { text: "done" })), "INVALID_ARGUMENT", "a chat with no parent");
  assert.equal(code(await r.call("merge_back_session", { sessionId: "fork", text: "done" })), "PERMISSION_DENIED", "only as itself");
  const merged = await r.call("merge_back_session", { text: "Use B." }, { threadId: "fork", title: "My fork", exchange: { id: "ex-4", hop: 4 } });
  assert.equal(merged.isError, undefined, JSON.stringify(body(merged)));
  const [req] = posted(r.api, agentChatRoutes.mergeBack("fork"));
  assert.equal(req!.text, "Use B.");
  assert.deepEqual(req!.causedBy, { threadId: "fork", exchangeId: "ex-4", hop: 5 });
  assert.deepEqual(body(merged).threadRef, { threadId: "me", title: "Implement auth", relation: "parent" });
  // External: a delegate is refused too; mergeId + action act on a queued delivery.
  assert.equal(code(await r.external("merge_back_session", { sessionId: "task" })), "INVALID_ARGUMENT");
  r.api.on("POST", agentChatRoutes.mergeBackItem("me", "m1"), { status: 200, body: { mergeId: "m1", outcome: "discarded" } });
  assert.deepEqual(body(await r.call("merge_back_session", { mergeId: "m1", action: "discard" })), { mergeId: "m1", outcome: "discarded" });
  assert.equal(code(await r.call("merge_back_session", { mergeId: "m1" })), "INVALID_ARGUMENT");
});

// ---------------------------------------------------------------------------
// wait_for_session
// ---------------------------------------------------------------------------

test("wait_for_session from a chat: an idle session returns at once with its reply; another project's below its rights has none (§13 a)", async () => {
  const r = rig();
  const own = await r.call("wait_for_session", { sessionId: "peer" });
  assert.equal(own.isError, undefined, JSON.stringify(body(own)));
  assert.equal(body(own).notice, UNTRUSTED_NOTICE);
  assert.equal(body(own).state, "idle");
  assert.equal(body(own).reply, "reply of peer");
  assert.equal(body(own).timedOut, false);
  assert.deepEqual(body(own).threadRef, { threadId: "peer", title: "Peer", relation: "thread" });
  const near = await r.call("wait_for_session", { sessionId: "near" }, { runtimeMode: "auto-accept-edits" });
  assert.equal(near.isError, undefined, JSON.stringify(body(near)));
  assert.equal(body(near).reply, undefined);
  assert.equal(body(near).contentOmitted, true);
  assert.equal(body(near).notice, undefined);
  assert.equal(r.port.cards.length, 0, "a same-workspace metadata read never cards");
  assert.equal(code(await r.call("wait_for_session", { sessionId: "me" })), "PERMISSION_DENIED");
});

test("wait_for_session: an empty final reply says so; several sessions return when one settles; WAIT_CYCLE across projects", async () => {
  const empty = rig({ threads: { peer: thread("peer", { items: [message("user", "go")] }) } });
  const out = body(await empty.call("wait_for_session", { sessionId: "peer" }));
  assert.equal(out.emptyReply, true);
  assert.equal(out.hint, replyNoticeText("empty", { title: "Peer", sessionId: "peer" }));
  const busy = (id: string) => thread(id, { head: head({ id, session: { status: "running", activeTurnId: "t1" } }), turns: [turn({ state: "running", completedAt: null })] });
  const several = rig({ threads: { peer: busy("peer") } });
  const many = body(await several.call("wait_for_session", { sessionIds: ["peer", "task"] }));
  assert.deepEqual(many.sessions.map((s: { sessionId: string; state: string }) => [s.sessionId, s.state]), [["peer", "working"], ["task", "idle"]]);
  const release = registerWait("far", "me");
  try {
    assert.equal(code(await several.call("wait_for_session", { sessionId: "far" })), "WAIT_CYCLE");
  } finally {
    release();
  }
});

test("wait_for_session from an external client: attention after the cursor, timeoutSeconds, and a single session's state and reply", async () => {
  const flagged = tab("peer", OWN, { title: "Peer", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } });
  const r = rig({ sessions: [...tabs().filter((s) => s.id !== "peer"), flagged] });
  const result = await r.external("wait_for_session", { sessionId: "peer", after: stamp(1), timeoutSeconds: 1 });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  assert.equal(body(result).cursor, stamp(7));
  assert.equal(body(result).state, "idle");
  assert.equal(body(result).reply, "reply of peer");
  assert.equal(code(await r.external("wait_for_session", { sessionId: "peer", project: "x/y" })), "INVALID_ARGUMENT");
  assert.equal(code(await r.external("wait_for_session", { timeoutMs: 1_000 })), "INVALID_ARGUMENT", "timeoutMs is gone");
});

// ---------------------------------------------------------------------------
// Byte budgets (§9.5 trim plan): each conversation tool's own target, under the registry test's ceilings
// ---------------------------------------------------------------------------

const TARGETS: Record<string, number> = { create_session: 2_900, send_message: 2_300, wait_for_session: 1_200, fork_session: 1_200, merge_back_session: 1_100 };

test("the conversation tools meet their §9.5 targets in tools/list, for both audiences (descriptions ≤ 1 000 bytes, field texts ≤ 160)", async () => {
  for (const audience of ["chat", "external"] as const) {
    const server = new McpServer({ name: "orquester", version: "test" });
    for (const name of Object.keys(TARGETS)) {
      const tool = toolByName(name, audience)!;
      const shape = audienceShape(tool, audience);
      server.registerTool(name, {
        title: tool.title, description: audienceDescription(tool, audience), inputSchema: Object.keys(shape).length > 0 ? shape : audienceSchema(tool, audience), annotations: tool.annotations,
        ...(audience === "external" ? { _meta: { "orquester/tier": tool.tier as string, "orquester/toolset": tool.toolset } } : {})
      }, () => ({ content: [] }));
    }
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "budget", version: "test" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      for (const entry of (await client.listTools()).tools) {
        const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
        assert.ok(bytes <= TARGETS[entry.name]!, `${audience} ${entry.name}: ${bytes} bytes > ${TARGETS[entry.name]}`);
        assert.ok(Buffer.byteLength(entry.description ?? "", "utf8") <= 1_000, `${entry.name}: description`);
        for (const field of Object.values((entry.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {})) {
          assert.ok(Buffer.byteLength(field.description ?? "", "utf8") <= 160, `${entry.name}: a field text`);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("external send_message parity: none steers and refuses an open request (respond_to_request named); attachments are uploaded and referenced", async () => {
  const asking = thread("peer", { pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } as never });
  const r = rig({ threads: { peer: asking } });
  const refused = await r.external("send_message", { sessionId: "peer", text: "hi", reply: "none" });
  assert.equal(code(refused), "PENDING_REQUEST");
  assert.match(body(refused).message, /respond_to_request/);
  const ok = rig();
  ok.api.on("POST", "/api/sessions/peer/turn", { status: 200, body: { seq: 3 } });
  const sent = await ok.external("send_message", { sessionId: "peer", text: "see", reply: "none", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }] });
  assert.equal(sent.isError, undefined, JSON.stringify(body(sent)));
  assert.equal(body(sent).outcome, "sent");
  const [turnBody] = posted(ok.api, "/api/sessions/peer/turn");
  assert.equal(turnBody!.input, "see");
  assert.deepEqual(turnBody!.attachments.map((a: { id: string }) => a.id), ["peer-att-1"]);
  assert.equal(turnBody!.causedBy, undefined, "external turns start no exchange");
  assert.equal(code(await ok.external("send_message", { sessionId: "peer", text: "  " })), "INVALID_ARGUMENT");
  assert.equal(code(await ok.external("send_message", { sessionId: "peer", implementPlan: true, text: "and this" })), "INVALID_ARGUMENT");
});

test("external fork_session and merge_back_session parity (§11): throughTurn, the host's refusal, the old result; resolve_merge_back as mergeId + action", async () => {
  const r = rig({ sessions: [...tabs(), tab("f9", OWN)], threads: { peer: thread("peer", { turns: [turn({ turnId: "t1" }), turn({ turnId: "t2", turnCount: 2 })] }) } });
  r.api.on("POST", agentChatRoutes.fork("peer"), { status: 200, body: { session: tab("f9", OWN), strategy: "native", lineage: { parentThreadId: "peer", relation: "fork", createdAt: stamp(1) } } });
  const forked = await r.external("fork_session", { sessionId: "peer", throughTurn: 1, title: "B" });
  assert.equal(forked.isError, undefined, JSON.stringify(body(forked)));
  assert.equal(body(forked).strategy, "native");
  assert.equal(body(forked).session.id, "f9");
  const [req] = posted(r.api, agentChatRoutes.fork("peer"));
  assert.equal(req!.turnId, "t1");
  assert.equal(req!.role, "assistant");
  assert.equal(req!.agentCreated, undefined, "an external client's fork is nobody's child");
  assert.equal(code(await r.external("fork_session", { sessionId: "peer", throughTurn: 3 })), "INVALID_ARGUMENT");
  r.api.on("POST", agentChatRoutes.fork("peer"), { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } } });
  assert.equal(code(await r.external("fork_session", { sessionId: "peer" })), "COMMAND_REJECTED");
  r.api.on("POST", agentChatRoutes.mergeBack("fork"), { status: 200, body: { parentSessionId: "me", delivery: "sent", mergeId: "m2", seq: 4 } });
  assert.deepEqual(body(await r.external("merge_back_session", { sessionId: "fork", text: "Use B." })), { parentSessionId: "me", delivery: "sent", mergeId: "m2", seq: 4 });
  assert.equal(posted(r.api, agentChatRoutes.mergeBack("fork"))[0]!.causedBy, undefined);
  r.api.on("POST", agentChatRoutes.mergeBackItem("me", "m2"), { status: 409, body: { error: { code: "TARGET_BUSY", message: "It is working." } } });
  assert.equal(code(await r.external("merge_back_session", { sessionId: "me", mergeId: "m2", action: "deliver" })), "TARGET_BUSY");
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

test("cwd containment is by real paths: a link out of the sandbox or into another project is refused, for both audiences", async () => {
  const r = rig();
  createRoutes(r.api, r.sessions);
  const external = await r.external("create_session", { project: "jaspersito/orquester", agent: "claude", cwd: "escape" });
  assert.equal(code(external), "PATH_NOT_ALLOWED");
  const sideways = await r.external("create_session", { project: "jaspersito/orquester", agent: "claude", cwd: "sidestep" });
  assert.equal(code(sideways), "PERMISSION_DENIED");
  // A chat: the gate classifies the link by its target (outside → denied), and the tool re-checks.
  assert.equal(code(await r.call("create_session", { prompt: "x", cwd: "escape" })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("create_session", { prompt: "x", cwd: "sidestep" })), "PERMISSION_DENIED");
  assert.equal(posted(r.api, "/api/sessions").length, 0, "no tab was opened");
  // A project directory that links out of the sandbox is no project to the gate (never the lexical path).
  const linked = rig({ sessions: [...tabs(), tab("odd", join(WS, "jaspersito/linked"))] });
  assert.equal(code(await linked.call("wait_for_session", { sessionId: "odd" })), "PERMISSION_DENIED");
});

test("a wait that fails after the message went out is no failed send: willNotify, and the agent is told not to send again", async () => {
  const r = rig();
  r.api.on("POST", agentChatRoutes.replySubscriptions("peer"), { status: 200, body: { subscriptionId: "sub-1", commandId: "cmd-1", delivery: "queued", queueEntryId: "cmd-1" } });
  r.api.on("POST", agentChatRoutes.replySubscriptionWait("peer", "sub-1"), { status: 409, body: { error: { code: "WAIT_CYCLE", message: "It is waiting on you." } } });
  const result = await r.call("send_message", { sessionId: "peer", text: "hi" });
  assert.equal(result.isError, undefined, JSON.stringify(body(result)));
  assert.equal(body(result).willNotify, true);
  assert.equal(body(result).delivery, "queued");
  assert.match(body(result).hint, /do not send it again/);
});

test("a reply the waiter took whose result never reached the provider is released, so it comes again as a message", async () => {
  const r = rig();
  replyRoutes(r.api, "peer");
  r.api.on("POST", agentChatRoutes.replySubscriptionRelease("peer", "sub-1"), { status: 200, body: { released: true, state: "done" } });
  let undelivered!: (value: boolean) => void;
  const delivered = new Promise<boolean>((resolve) => { undelivered = resolve; });
  const result = await r.call("send_message", { sessionId: "peer", text: "hi" }, { delivered });
  assert.equal(body(result).reply, "Found 3 issues.");
  assert.equal(posted(r.api, agentChatRoutes.replySubscriptionRelease("peer", "sub-1")).length, 0, "nothing released while the result may still arrive");
  undelivered(false);
  await delivered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(r.api.calls.filter((c) => c.path === agentChatRoutes.replySubscriptionRelease("peer", "sub-1")).length, 1);
});

test("an external wait uploads nothing for a message that is never sent, and posts nothing once cancelled", async () => {
  const busy = thread("peer", { head: head({ id: "peer", session: { status: "running", activeTurnId: "t1" } }), turns: [turn({ state: "running", completedAt: null })] });
  const r = rig({ threads: { peer: busy } });
  r.api.on("POST", "/api/sessions/peer/turn", { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "working" } } });
  const timedOut = await r.external("send_message", { sessionId: "peer", text: "see", timeoutSeconds: 1, attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }] });
  assert.equal(body(timedOut).sent, false);
  assert.equal(r.api.uploads.length, 0, "no orphaned upload");
  assert.equal(posted(r.api, "/api/sessions/peer/turn").length, 0);
  // Cancelled while it waits for the session after a refused post: no further post, ever.
  const later = rig({ threads: { peer: busy } });
  let refused!: () => void;
  const firstPost = new Promise<void>((resolve) => { refused = resolve; });
  later.api.on("POST", "/api/sessions/peer/turn", () => { refused(); return { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "working" } } }; });
  const controller = new AbortController();
  const running = later.external("send_message", { sessionId: "peer", text: "hi", timeoutSeconds: 60 }, controller.signal);
  await firstPost;
  controller.abort();
  later.threads.peer = thread("peer");
  later.api.emit(busEvent("session.updated", later.sessions.find((s) => s.id === "peer")));
  const cancelled = await running;
  assert.equal(cancelled.isError, true);
  assert.equal(posted(later.api, "/api/sessions/peer/turn").length, 1, "the one refused post only");
});

test("a failed wait is worded by why: a message follows only for WAIT_CYCLE / HOST_UNAVAILABLE; another wait or a gone subscription says so", async () => {
  const cases: [number, string, boolean, RegExp][] = [
    [409, "WAIT_CYCLE", true, /delivered to you as a new message/],
    [503, "HOST_UNAVAILABLE", true, /delivered to you as a new message/],
    [409, "COMMAND_REJECTED", false, /another wait of this chat already holds its reply/],
    [404, "THREAD_NOT_FOUND", false, /No reply will come here/],
    [403, "PERMISSION_DENIED", false, /unknown/]
  ];
  for (const [status, failure, notify, hint] of cases) {
    const r = rig();
    r.api.on("POST", agentChatRoutes.replySubscriptions("peer"), { status: 200, body: { subscriptionId: "sub-1", commandId: "cmd-1", delivery: "sent", seq: 3 } });
    r.api.on("POST", agentChatRoutes.replySubscriptionWait("peer", "sub-1"), { status, body: { error: { code: failure, message: "nope" } } });
    const out = body(await r.call("send_message", { sessionId: "peer", text: "hi" }));
    assert.equal(out.willNotify, notify, failure);
    assert.match(out.hint, hint, failure);
    assert.match(out.hint, /not send it again|before sending again/, failure);
    if (!notify) assert.doesNotMatch(out.hint, /will be delivered/, failure);
  }
});
