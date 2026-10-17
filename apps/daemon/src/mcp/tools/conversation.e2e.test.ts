/**
 * The review scenario end to end (unified MCP design 2026-10-15 §8.7, §14.2 item 11): a Claude chat
 * opens a Codex chat to review its work and the two talk to each other — through the catalog tools,
 * THE executor, callers derived as the chat route derives them (`buildThreadCaller`: mode, planning,
 * the running turn's exchange), and Task 5's real services: the `ReplyRouter` (reply subscriptions,
 * persisted, CAS) and the `LineageService` delivery queue, behind the daemon's routes on a fake host.
 *
 * 1. Claude ("Implement auth", full-access) calls `create_session {agent: "codex", runtimeMode:
 *    "approval-required", title: "Codex review", prompt, reply: "notify"}` — an `opened`,
 *    `agentCreated` child; its first turn is hop 1.
 * 2. Claude ends its turn; Codex's review lands in Claude as `[Reply from thread "Codex review" …]`
 *    (hop 2).
 * 3. Claude, in that turn, sends `send_message {reply: "wait"}` (hop 3) and gets Codex's answer;
 *    meanwhile Codex asking Claude back is refused: never broader (§5.3) while Codex runs
 *    approval-required, and `WAIT_CYCLE` once the user raised its mode.
 * 4. At hop 8 the next agent-caused turn is refused `EXCHANGE_LIMIT`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventMessage, SessionSummary } from "@orquester/api";
import {
  agentChatRoutes,
  parseThreadMessage,
  THREAD_MESSAGE_CONTEXT_KIND,
  THREAD_REPLY_CONTEXT_KIND,
  type CallerPrincipal,
  type CausedBy,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type Turn
} from "@orquester/api/agent-chat";

import { gateSessionCreateBody } from "../../agent-chat/lineage-routes.ts";
import { LineageService } from "../../agent-chat/lineage.ts";
import { REPLY_ERROR_STATUS, ReplyError, ReplyRouter } from "../../agent-chat/replies.ts";
import { buildThreadCaller } from "../../session-tools/route.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import { toolByName } from "../catalog/index.ts";
import type { DaemonApi, DaemonResponse } from "../daemon-api.ts";
import { executeToolCall } from "../executor.ts";
import { headFromThreadRead } from "../testing.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "umcp-t8-e2e-")));
const WS = join(ROOT, "w");
const PROJECT = join(WS, "jaspersito/orquester");
mkdirSync(PROJECT, { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

interface FakeThread {
  seq: number;
  runtimeMode: string;
  turns: Turn[];
  items: ThreadItem[];
  events: { seq: number; type: string; commandId: string | null; payload: Record<string, unknown> }[];
}

const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } }
] };
const providers = { hostInstanceId: "h", providers: ["claude", "codex"].map((id) => ({
  id, refIds: [id], installed: true, version: "1", status: "ready", auth: { status: "authenticated" }, checkedAt: "t", slashCommands: [], skills: [], capabilities: { showPlanModeToggle: id === "claude" },
  models: [{ slug: `${id}-default`, name: "Default", isDefault: true, capabilities: null }]
})) };

/**
 * The daemon as the tools and the services see it: tabs, threads on a fake host (receipts, `ifIdle`,
 * events by seq), session creation behind the real principal gate, and the socket-only
 * reply-subscription routes answered by the real router.
 */
function world() {
  const sessions = new Map<string, SessionSummary>();
  const threads = new Map<string, FakeThread>();
  const receipts = new Map<string, DaemonResponse>();
  const listeners = new Set<(event: EventMessage) => void>();
  const posts: { sessionId: string; body: Record<string, any> }[] = [];
  /** Waiters for the next accepted post to a session (a receipt, never a clock). */
  const postWaiters = new Map<string, (() => void)[]>();
  let ids = 0;
  let router!: ReplyRouter;

  const active = (t: FakeThread) => t.turns.find((turn) => turn.state === "running" || turn.state === "pending");
  const snapshotOf = (id: string): ThreadSnapshotPayload => {
    const t = threads.get(id)!;
    const running = active(t);
    const tab = sessions.get(id)!;
    return {
      head: { id, projectPath: tab.projectPath, cwd: tab.cwd, title: tab.title, adapter: tab.refId, refId: tab.refId, accountId: "", home: "system", modelSelection: { model: `${tab.refId}-default`, options: [] }, runtimeMode: t.runtimeMode,
        session: { status: running ? "running" : "ready", activeTurnId: running?.turnId ?? null, lastError: null }, turnCount: t.turns.length, seq: t.seq, createdAt: "t", updatedAt: "t" },
      items: t.items, turns: t.turns, checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: t.seq
    } as unknown as ThreadSnapshotPayload;
  };
  const touch = (id: string): void => {
    const tab = sessions.get(id);
    const t = threads.get(id);
    if (tab && t) {
      const last = t.turns.at(-1);
      sessions.set(id, { ...tab, chatSessionStatus: active(t) ? "running" : "ready", ...(last ? { latestTurn: { turnId: last.turnId!, state: last.state, startedAt: "t", completedAt: last.completedAt } } : {}) } as SessionSummary);
    }
    for (const listener of listeners) listener({ id: `e${ids}`, channel: "sessions", type: "session.updated", createdAt: "t", payload: sessions.get(id) ?? { id } } as EventMessage);
  };
  const addTab = (id: string, over: Partial<SessionSummary>, runtimeMode: string): void => {
    sessions.set(id, { id, kind: "agent-chat", refId: "claude", title: id, projectPath: PROJECT, cwd: PROJECT, cols: 0, rows: 0, status: "running", order: sessions.size, createdAt: "2026-10-15T00:00:00.000Z", chatSessionStatus: "ready", ...over } as SessionSummary);
    threads.set(id, { seq: 1, runtimeMode, turns: [], items: [], events: [] });
  };
  /** A turn on the host: posted (agent-caused carries `causedBy`) or the user's own. */
  const startTurn = (sessionId: string, body: Record<string, any>, commandId: string | null): string => {
    const t = threads.get(sessionId)!;
    const messageId = `msg-${(ids += 1)}`;
    const running = active(t);
    t.seq += 1;
    t.events.push({ seq: t.seq, type: "thread.message-sent", commandId, payload: { messageId, role: "user", text: body.input, turnId: running?.turnId ?? null } });
    t.items.push({ kind: "message", id: messageId, role: "user", text: body.input, turnId: running?.turnId ?? null, streaming: false, createdAt: "t", updatedAt: "t", ...(body.context ? { context: body.context } : {}) } as ThreadItem);
    if (!running) {
      t.seq += 1;
      const turnId = `turn-${ids}`;
      t.events.push({ seq: t.seq, type: "thread.turn-start-requested", commandId, payload: { turnId: null, messageId } });
      t.turns.push({ turnId, state: "running", turnCount: t.turns.length + 1, requestedAt: "t", startedAt: "t", completedAt: null, assistantMessageId: null, userMessageId: messageId, ...(body.causedBy ? { causedBy: body.causedBy as CausedBy } : {}) });
    }
    return messageId;
  };

  const replyRoute = async (run: () => Promise<unknown>): Promise<DaemonResponse> => {
    try {
      return { status: 200, body: await run() };
    } catch (error) {
      if (error instanceof ReplyError) return { status: REPLY_ERROR_STATUS[error.code], body: { error: { code: error.code, message: error.message } } };
      throw error;
    }
  };

  const api: DaemonApi = {
    fsRoot: ROOT,
    workspacesDir: WS,
    async request(method, path, opts): Promise<DaemonResponse> {
      const principal = (opts as { principal?: CallerPrincipal } | undefined)?.principal;
      if (method === "GET" && path === "/api/sessions") return { status: 200, body: [...sessions.values()] };
      if (method === "GET" && path === "/api/registry") return { status: 200, body: registry };
      if (method === "GET" && path === agentChatRoutes.providers) return { status: 200, body: providers };
      if (method === "GET" && path === "/api/agent-accounts") return { status: 200, body: { accounts: [], defaults: {} } };
      if (method === "GET" && (path === "/api/workspaces" || path === "/api/accounts")) return { status: 200, body: [] };
      if (method === "POST" && path === "/api/sessions") {
        // The route's principal gate: `agentCreated` only from the parent's own agent.
        const body = gateSessionCreateBody(structuredClone(opts?.body), principal) as Record<string, any>;
        const id = `chat-${(ids += 1)}`;
        const lineage = body.chat.lineage ? { ...body.chat.lineage, createdAt: "t", delegationDepth: 1 } : undefined;
        addTab(id, { refId: body.refId, title: body.title, projectPath: body.projectPath, cwd: body.cwd, ...(lineage ? { lineage } : {}) }, body.chat.runtimeMode);
        return { status: 200, body: sessions.get(id) };
      }
      const headRead = /^\/api\/sessions\/([^/]+)\/head$/.exec(path);
      if (method === "GET" && headRead) {
        const id = decodeURIComponent(headRead[1]!);
        if (!threads.has(id)) return { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "gone" } } };
        return headFromThreadRead({ status: 200, body: { kind: "snapshot", thread: snapshotOf(id) } }, opts?.query);
      }
      const read = /^\/api\/sessions\/([^/]+)\/thread$/.exec(path);
      if (method === "GET" && read) {
        const id = decodeURIComponent(read[1]!);
        if (!threads.has(id)) return { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "gone" } } };
        const after = opts?.query?.after;
        if (after !== undefined) {
          const t = threads.get(id)!;
          return { status: 200, body: { kind: "events", seq: t.seq, events: t.events.filter((e) => e.seq > Number(after)) } };
        }
        return { status: 200, body: { kind: "snapshot", thread: snapshotOf(id) } };
      }
      const turnPath = /^\/api\/sessions\/([^/]+)\/turn$/.exec(path);
      if (method === "POST" && turnPath) {
        const sessionId = decodeURIComponent(turnPath[1]!);
        const body = opts?.body as Record<string, any>;
        const recorded = receipts.get(body.commandId);
        if (recorded) return recorded;
        const t = threads.get(sessionId)!;
        if (body.ifIdle === true && active(t)) return { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "working" } } };
        posts.push({ sessionId, body });
        startTurn(sessionId, body, body.commandId);
        for (const wake of postWaiters.get(sessionId)?.splice(0) ?? []) wake();
        const answer: DaemonResponse = { status: 200, body: { seq: t.seq } };
        receipts.set(body.commandId, answer);
        touch(sessionId);
        return answer;
      }
      const subscribe = /^\/api\/sessions\/([^/]+)\/reply-subscriptions$/.exec(path);
      if (method === "POST" && subscribe) return replyRoute(() => router.subscribe(decodeURIComponent(subscribe[1]!), opts?.body, principal));
      const wait = /^\/api\/sessions\/([^/]+)\/reply-subscriptions\/([^/]+)\/wait$/.exec(path);
      if (method === "POST" && wait) return replyRoute(() => router.wait(decodeURIComponent(wait[1]!), decodeURIComponent(wait[2]!), opts?.body, { ...(principal ? { principal } : {}) }));
      const release = /^\/api\/sessions\/([^/]+)\/reply-subscriptions\/([^/]+)\/release$/.exec(path);
      if (method === "POST" && release) return replyRoute(() => router.release(decodeURIComponent(release[1]!), decodeURIComponent(release[2]!), principal));
      return { status: 404, body: { error: { code: "NOT_FOUND", message: `no route ${method} ${path}` } } };
    },
    async uploadAttachment() { return { status: 503, value: null }; },
    async publishHtmlRender() { return { ok: false, code: "UNAVAILABLE", message: "none" }; },
    async previewHtmlRender() { return { ok: false, code: "UNAVAILABLE", message: "none" }; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };

  const dir = mkdtempSync(join(ROOT, "appdir-"));
  const listing = { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] };
  let n = 0;
  const queue = new LineageService({ sessions: listing, outboxFile: join(dir, "agent-merge-outbox.json"), recheckMs: 0, newId: () => `m-${(n += 1)}`, setPendingMerges: () => undefined });
  router = new ReplyRouter({ outboxFile: join(dir, "agent-reply-outbox.json"), sessions: listing, queue, recheckMs: 0, newId: () => `id-${(n += 1)}` });

  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "" });
  let calls = 0;
  /** A tool call from a chat, its caller derived as the chat route derives it. */
  const call = async (threadId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const tab = sessions.get(threadId)!;
    const caller = await buildThreadCaller(api, threadId, { projectPath: tab.projectPath, cwd: tab.cwd, agentId: tab.refId as "claude" | "codex" }, `call-${(calls += 1)}`);
    return executeToolCall(
      { approvals: port, lookup: (tool, audience) => toolByName(tool, audience), newId: () => "ex-1" },
      { name, arguments: args },
      { caller, api, signal: new AbortController().signal }
    );
  };

  return {
    api, sessions, threads, posts, queue, router, port, call, addTab, touch,
    async start() {
      await queue.load();
      await router.load();
      queue.setDeliveryListener(router);
      queue.attachApi(api);
      await router.whenReady();
    },
    /** The user types into a chat: a user-authored turn (no exchange). */
    userTurn(id: string, text: string) {
      startTurn(id, { input: text }, null);
      touch(id);
    },
    /** The chat's running turn ends with its final reply. */
    settle(id: string, reply: string) {
      const t = threads.get(id)!;
      const turn = active(t)!;
      turn.state = "completed";
      turn.completedAt = "t";
      t.items.push({ kind: "message", id: `a-${turn.turnId}`, role: "assistant", text: reply, turnId: turn.turnId, streaming: false, createdAt: "t", updatedAt: "t" } as ThreadItem);
      t.seq += 1;
      touch(id);
    },
    runningTurn: (id: string) => active(threads.get(id)!),
    /** Resolves when the next turn is posted to `id`. */
    nextPost: (id: string) => new Promise<void>((resolve) => { postWaiters.set(id, [...(postWaiters.get(id) ?? []), resolve]); }),
    /** Let every lane, evaluation and write settle (no clock): the queue and the router until neither has work. */
    async drain() {
      do {
        await queue.whenIdle();
        await router.whenIdle();
      } while (queue.hasWorkInFlight() || router.hasWorkInFlight());
    },
    async stop() {
      await queue.stop();
    }
  };
}

const out = (result: CallToolResult) => result.structuredContent as Record<string, any>;

test("§8.7: Claude opens a Codex review with notify, gets the review as a Reply, re-reviews with wait; WAIT_CYCLE and the hop cap hold", async () => {
  const w = world();
  w.addTab("claude", { title: "Implement auth" }, "full-access");
  await w.start();
  try {
    // The user asks Claude for work: a user-authored turn, no exchange yet.
    w.userTurn("claude", "Implement auth, then get it reviewed.");

    // 1. Claude opens Codex in its own project, approval-required, with a notify reply.
    const opened = await w.call("claude", "create_session", {
      agent: "codex", runtimeMode: "approval-required", title: "Codex review",
      prompt: "Review the uncommitted diff in this project; list the issues.", reply: "notify"
    });
    assert.equal(opened.isError, undefined, JSON.stringify(out(opened)));
    assert.equal(out(opened).willNotify, true);
    assert.equal(w.port.cards.length, 0, "own project, Act: no card");
    const codex = out(opened).sessionId as string;
    const tab = w.sessions.get(codex)!;
    assert.equal(tab.title, "Codex review");
    assert.equal(tab.refId, "codex");
    assert.deepEqual({ ...tab.lineage }, { parentThreadId: "claude", relation: "opened", agentCreated: true, createdAt: "t", delegationDepth: 1 }, "agentCreated survived the principal gate");
    assert.equal(w.threads.get(codex)!.runtimeMode, "approval-required");
    await w.drain();
    const firstTurn = w.runningTurn(codex)!;
    assert.deepEqual(firstTurn.causedBy, { threadId: "claude", exchangeId: "ex-1", hop: 1 });
    const firstMessage = w.posts.find((post) => post.sessionId === codex)!.body;
    const header = parseThreadMessage(firstMessage.input)!;
    assert.equal(header.origin, "opened");
    assert.equal(header.fromSessionId, "claude");
    assert.equal(header.fromProject, "jaspersito/orquester");
    assert.match(firstMessage.input, /goes back to it automatically/);
    assert.equal(firstMessage.context[0].kind, THREAD_MESSAGE_CONTEXT_KIND);

    // 2. Claude ends its turn; Codex's review settles and is delivered to Claude as a Reply (hop 2).
    w.settle("claude", "I asked Codex to review.");
    w.settle(codex, "1. Missing CSRF check. 2. Token logged. 3. No rate limit.");
    await w.drain();
    const delivered = w.posts.filter((post) => post.sessionId === "claude");
    assert.equal(delivered.length, 1, "exactly one delivery");
    const reply = parseThreadMessage(delivered[0]!.body.input)!;
    assert.equal(reply.origin, "reply");
    assert.equal(reply.fromTitle, "Codex review");
    assert.equal(reply.fromSessionId, codex);
    assert.match(reply.body, /Missing CSRF check/);
    assert.equal(delivered[0]!.body.context[0].kind, THREAD_REPLY_CONTEXT_KIND);
    assert.deepEqual(w.runningTurn("claude")!.causedBy, { threadId: codex, exchangeId: "ex-1", hop: 2 });

    // 3. In that delivered turn Claude fixes and asks again, waiting (hop 3)…
    const posted = w.nextPost(codex);
    const asking = w.call("claude", "send_message", { sessionId: codex, text: "Fixed 1–3; re-review.", reply: "wait", timeoutSeconds: 60 });
    await posted;
    await w.drain();
    const second = w.runningTurn(codex)!;
    assert.deepEqual(second.causedBy, { threadId: "claude", exchangeId: "ex-1", hop: 3 });
    // …while Codex, mid-review, asks Claude back. As opened (approval-required) it may cause no turn in
    // the broader Claude at all — the turn policy's never-broader rule (§5.3), which §8.7 step 4 glosses.
    const narrower = await w.call(codex, "send_message", { sessionId: "claude", text: "Which rate limit?", reply: "wait" });
    assert.equal(out(narrower).code, "PERMISSION_DENIED");
    assert.match(out(narrower).message, /broader/);
    // Once the user raises Codex to Full access, the same wait would close a cycle: WAIT_CYCLE at once,
    // nothing saved or queued for Claude.
    w.threads.get(codex)!.runtimeMode = "full-access";
    const cycle = await w.call(codex, "send_message", { sessionId: "claude", text: "Which rate limit?", reply: "wait" });
    assert.equal(cycle.isError, true);
    assert.equal(out(cycle).code, "WAIT_CYCLE");
    assert.equal(w.queue.pending().filter((entry) => entry.parentSessionId === "claude").length, 0);
    // Codex answers in its final reply instead; Claude's wait returns it.
    w.settle(codex, "LGTM now.");
    const answered = await asking;
    assert.equal(answered.isError, undefined, JSON.stringify(out(answered)));
    assert.equal(out(answered).outcome, "completed");
    assert.equal(out(answered).reply, "LGTM now.");
    assert.ok(out(answered).notice, "another agent's words are marked");
    await w.drain();
    assert.equal(w.posts.filter((post) => post.sessionId === "claude").length, 1, "a reply a waiter took is never also delivered");

    // 4. The exchange cap: a turn at hop 8 may cause no further agent-caused turn.
    w.settle("claude", "Done.");
    const t = w.threads.get("claude")!;
    t.seq += 1;
    t.turns.push({ turnId: "late", state: "running", turnCount: t.turns.length + 1, requestedAt: "t", startedAt: "t", completedAt: null, assistantMessageId: null, causedBy: { threadId: codex, exchangeId: "ex-1", hop: 8 } });
    w.touch("claude");
    const before = w.posts.length;
    const capped = await w.call("claude", "send_message", { sessionId: codex, text: "One more?", reply: "notify" });
    assert.equal(out(capped).code, "EXCHANGE_LIMIT");
    assert.equal(w.posts.length, before, "nothing posted");
    assert.equal(w.router.subscriptions().filter((sub) => sub.state !== "done").length, 0, "nothing subscribed");
  } finally {
    await w.stop();
  }
});

test("a delegate's final reply is its result, delivered to the parent; the delegate is refused merge-back", async () => {
  const w = world();
  w.addTab("claude", { title: "Lead" }, "full-access");
  await w.start();
  try {
    w.userTurn("claude", "Split the work.");
    const delegated = await w.call("claude", "create_session", { prompt: "Write the migration.", delegate: true });
    assert.equal(delegated.isError, undefined, JSON.stringify(out(delegated)));
    const task = out(delegated).sessionId as string;
    assert.equal(w.sessions.get(task)!.lineage?.relation, "delegate");
    await w.drain();
    const refused = await w.call(task, "merge_back_session", { text: "Here it is." });
    assert.equal(out(refused).code, "INVALID_ARGUMENT");
    assert.match(out(refused).message, /delivered to your parent automatically/);
    w.settle("claude", "Delegated.");
    w.settle(task, "Migration written: 0042_auth.sql.");
    await w.drain();
    const result = w.posts.filter((post) => post.sessionId === "claude");
    assert.equal(result.length, 1);
    assert.match(parseThreadMessage(result[0]!.body.input)!.body, /0042_auth\.sql/);
  } finally {
    await w.stop();
  }
});
