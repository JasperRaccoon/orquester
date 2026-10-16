/**
 * The Sessions family for CHAT callers (unified MCP design 2026-10-15 §4.1, §5, §13 a–c), through THE executor with
 * the approval-port double: own project by default, `"all"` narrowed per mode (never a card), content omitted on
 * metadata reads without content rights, boundary cards for content reads and cross-project Act, own children =
 * `agentCreated` children only (a GUI fork is the user's), self, the plan-mode data-change refusal, and
 * respond_to_request answering provider questions only (an Orquester card id is not found there).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSET_IDS, type SessionSummary } from "@orquester/api";
import { agentChatRoutes, UNTRUSTED_NOTICE, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";

import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { toolByName } from "../catalog/index.ts";
import { executeToolCall } from "../executor.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "umcp-t7-")));
const WS = join(ROOT, "w");
const OWN = join(WS, "acme/api");
const SAME = join(WS, "acme/web");
const OTHER = join(WS, "beta/app");
for (const dir of [OWN, SAME, OTHER]) mkdirSync(dir, { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

const goal = { objective: "Ship the secret plan", status: "active", continuing: false } as unknown as SessionSummary["goal"];
const tab = (id: string, projectPath: string, over: Partial<SessionSummary> = {}) => chatSummary({ id, title: `Chat ${id}`, projectPath, cwd: projectPath, ...over });

/** The tabs: the caller, siblings in each project class, its children (agent-made and a GUI fork), a terminal. */
function tabs(): SessionSummary[] {
  return [
    tab("me", OWN, { title: "Implement auth", order: 1 }),
    tab("sib", OWN, { order: 2, goal }),
    tab("child", OWN, { order: 3, lineage: { parentThreadId: "me", relation: "opened", createdAt: stamp(1), agentCreated: true } }),
    tab("task", OWN, { order: 4, lineage: { parentThreadId: "me", relation: "delegate", createdAt: stamp(1), agentCreated: true } }),
    tab("guifork", OWN, { order: 5, lineage: { parentThreadId: "me", relation: "fork", createdAt: stamp(1) } }),
    tab("web1", SAME, { order: 1, goal }),
    tab("far", OTHER, { order: 1, goal }),
    tab("farkid", OTHER, { order: 2, lineage: { parentThreadId: "me", relation: "opened", createdAt: stamp(1), agentCreated: true } }),
    shellSummary({ id: "term", projectPath: OWN, cwd: OWN, order: 6 })
  ];
}

/** A chat's thread: a settled turn whose reply says who it is, an optional plan, pending requests. */
function thread(id: string, over: Partial<ThreadSnapshotPayload> = {}): ThreadSnapshotPayload {
  return snapshot({ head: head({ id, runtimeMode: "auto" }), items: [message("user", `ask ${id}`), message("assistant", `reply of ${id}`)], turns: [turn()], ...over });
}

const QUESTION = { requestId: "q1", createdAt: stamp(1), dismissible: false, questions: [{ id: "db", header: "DB", question: "Which database?", options: [{ label: "Postgres", description: "pg" }], multiSelect: false, allowCustomAnswer: true }] };
const SECRET_QUESTION = { requestId: "q2", createdAt: stamp(1), dismissible: false, questions: [{ id: "tok", header: "Token", question: "API token?", options: [], multiSelect: false, allowCustomAnswer: true }] };

function rig(threads: Record<string, ThreadSnapshotPayload> = {}, extra: SessionSummary[] = []) {
  const api = new FakeDaemonApi();
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const sessions = [...tabs(), ...extra];
  api.on("GET", "/api/sessions", ({ query }) => ({ status: 200, body: query?.projectPath ? sessions.filter((s) => s.projectPath === query.projectPath) : sessions }))
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } })
    .on("GET", "/api/workspaces", { status: 200, body: [] })
    .on("GET", "/api/accounts", { status: 200, body: [] });
  for (const s of sessions.filter((x) => x.kind === "agent-chat")) {
    api.on("GET", agentChatRoutes.thread(s.id), { status: 200, body: { kind: "snapshot", thread: threads[s.id] ?? thread(s.id) } });
    api.on("GET", agentChatRoutes.lineage(s.id), {
      status: 200,
      body: {
        sessionId: s.id, lineage: s.lineage ?? null, parent: s.lineage ? { sessionId: s.lineage.parentThreadId, title: "Implement auth", exists: true } : null,
        children: s.id === "me" ? [{ sessionId: "child", title: "Chat child", exists: true, relation: "opened", createdAt: stamp(1) }] : [],
        pendingMerges: s.id === "web1" ? [{ kind: "reply", mergeId: "m1", parentSessionId: "web1", childSessionId: "x", queuedAt: stamp(2), state: "queued", preview: "words of another chat", attempts: 0 }] : []
      }
    });
    for (const command of ["interrupt", "compact", "answer", "session/stop"]) api.on("POST", `/api/sessions/${s.id}/${command}`, { status: 200, body: { seq: 7 } });
    api.on("DELETE", `/api/sessions/${s.id}`, { status: 204, body: null });
  }
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "" });
  const call = (name: string, args: Record<string, unknown>, over: Partial<ThreadCaller> = {}) =>
    executeToolCall(
      { approvals: port, enabledToolsets: async () => new Set(TOOLSET_IDS), lookup: (n, audience) => toolByName(n, audience) },
      { name, arguments: args },
      { caller: { kind: "thread", threadId: "me", title: "Implement auth", projectPath: OWN, workspace: "acme", cwd: OWN, agentId: "claude", callId: "c", runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over }, api, signal: new AbortController().signal }
    );
  return { api, port, call };
}

const body = (result: CallToolResult) => result.structuredContent as Record<string, any>;
const code = (result: CallToolResult) => (result.isError ? body(result).code : undefined);
const posts = (api: FakeDaemonApi) => api.calls.filter((c) => c.method === "POST" || c.method === "DELETE").map((c) => `${c.method} ${c.path}`);

test("list_sessions: this chat's project by default, self marked; a terminal listed; nothing else", async () => {
  const r = rig();
  const result = await r.call("list_sessions", {});
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  const rows = body(result).sessions as { id: string; self?: true }[];
  assert.deepEqual(rows.map((row) => row.id), ["me", "sib", "child", "task", "guifork", "term"]);
  assert.deepEqual(rows.filter((row) => row.self).map((row) => row.id), ["me"]);
  assert.equal(r.port.cards.length, 0);
});

test("list_sessions \"all\": narrowed below Full access to the workspace, never a card; content omitted below auto", async () => {
  const supervised = rig();
  const narrowed = body(await supervised.call("list_sessions", { project: "all", kind: "chat" }));
  assert.equal(narrowed.listed, "workspace");
  assert.equal(narrowed.excludedProjects, 1, "beta/app (far) — a project counted once, for its chat tabs");
  const byId = new Map((narrowed.sessions as Record<string, any>[]).map((row) => [row.id, row]));
  // Its own agent-created children come along wherever they are (farkid, in another workspace); a GUI fork is the user's.
  assert.deepEqual([...byId.keys()].sort(), ["child", "farkid", "guifork", "me", "sib", "task", "web1"]);
  assert.equal(byId.get("farkid")!.contentOmitted, true, "listed as its own work, but another workspace's content stays out");
  assert.equal(byId.get("web1")!.contentOmitted, true, "another project of the workspace, below auto: no content");
  assert.equal(byId.get("web1")!.chat.goal.objective, undefined);
  assert.equal(byId.get("sib")!.chat.goal.objective, "Ship the secret plan", "own project: content");
  assert.match(narrowed.hint, /read_transcript asks for content access/);
  assert.equal(supervised.port.cards.length, 0);

  const auto = body(await rig().call("list_sessions", { project: "all", kind: "chat" }, { runtimeMode: "auto" }));
  assert.equal(auto.listed, "workspace");
  assert.equal((auto.sessions as Record<string, any>[]).find((row) => row.id === "web1")!.contentOmitted, undefined);

  const full = body(await rig().call("list_sessions", { project: "all", kind: "chat" }, { runtimeMode: "full-access" }));
  assert.equal(full.listed, "all");
  assert.equal(full.excludedProjects, undefined);
  assert.ok((full.sessions as { id: string }[]).some((row) => row.id === "far"));
});

test("list_sessions of another workspace's project: a cross-workspace-read card below Full access (S13), none in it", async () => {
  const r = rig();
  const result = await r.call("list_sessions", { project: "beta/app" });
  assert.equal(result.isError, undefined);
  assert.equal(r.port.cards.length, 1);
  assert.equal(r.port.cards[0]!.family, "cross-workspace-read");
  assert.match(r.port.cards[0]!.title, /list the chats of beta\/app/);
  const full = rig();
  await full.call("list_sessions", { project: "beta/app" }, { runtimeMode: "full-access" });
  assert.equal(full.port.cards.length, 0);
});

test("get_session (§13 a): another project's chat without content rights is metadata only, never a content card", async () => {
  const r = rig({ web1: thread("web1", { pending: { approvals: [], userInputs: [QUESTION] }, roster: [] }) });
  const result = body(await r.call("get_session", { sessionId: "web1" }));
  assert.equal(r.port.cards.length, 0, "same workspace metadata: no card");
  assert.equal(result.contentOmitted, true);
  assert.equal(result.hint, "read_transcript asks for content access");
  assert.equal(result.notice, undefined);
  assert.equal(result.session.lastReply, undefined);
  assert.deepEqual(result.session.pending, { approvals: 0, questions: 1 });
  assert.equal(result.session.chat.goal?.objective, undefined);
  assert.equal(result.pendingDeliveries[0].preview, undefined, "a queued delivery's words are content");
  assert.ok(!JSON.stringify(result).includes("reply of web1"));
  assert.deepEqual(result.threadRef, { threadId: "web1", title: "Chat web1", relation: "thread" });

  // From auto, the same workspace's content is readable: the whole detail, marked as another chat's words.
  const auto = body(await rig().call("get_session", { sessionId: "web1" }, { runtimeMode: "auto" }));
  assert.equal(auto.notice, UNTRUSTED_NOTICE);
  assert.equal(auto.session.lastReply.text, "reply of web1");
  assert.equal(auto.pendingDeliveries[0].preview, "words of another chat");
  assert.equal(auto.contentOmitted, undefined);
});

test("get_session: lineage, a delegate's settled reply as its result, and the caller itself", async () => {
  const r = rig();
  const task = body(await r.call("get_session", { sessionId: "task" }));
  assert.deepEqual(task.result, { text: "reply of task", turnId: "t1" });
  assert.equal(task.session.lastReply, undefined);
  assert.equal(task.lineage.relation, "delegate");
  assert.equal(task.lineage.parent.sessionId, "me");
  assert.equal(task.threadRef.relation, "delegate");
  const self = body(await r.call("get_session", { sessionId: "me" }));
  assert.equal(self.notice, undefined, "its own words are no other chat's");
  assert.deepEqual(self.lineage.children.map((c: { sessionId: string }) => c.sessionId), ["child"]);
});

test("get_session of another workspace below Full access: a metadata card (S13); content still omitted after approval", async () => {
  const r = rig();
  const result = body(await r.call("get_session", { sessionId: "far" }, { runtimeMode: "auto" }));
  assert.equal(r.port.cards[0]?.family, "cross-workspace-read");
  assert.equal(result.contentOmitted, true);
  r.port.answerWith({ outcome: "denied", approvalId: "", reason: "not that one" });
  assert.equal(code(await r.call("get_session", { sessionId: "far" })), "APPROVAL_DENIED");
});

test("read_transcript: own project free; another project below auto raises a boundary card naming the session — the content read is the card", async () => {
  const r = rig();
  const own = body(await r.call("read_transcript", { sessionId: "sib" }));
  assert.equal(own.notice, UNTRUSTED_NOTICE);
  assert.equal(own.threadRef.threadId, "sib");
  assert.equal(r.port.cards.length, 0);
  const same = await r.call("read_transcript", { sessionId: "web1" });
  assert.equal(same.isError, undefined);
  const card = r.port.cards[0]!;
  assert.equal(card.kind, "boundary");
  assert.equal(card.family, "cross-project-read");
  assert.match(card.title, /read the transcript of the chat "Chat web1" in acme\/web/);
  assert.ok(!card.sections.some((section) => section.kind === "code"), "a composed preview, not the raw arguments");
  const auto = rig();
  await auto.call("read_transcript", { sessionId: "web1" }, { runtimeMode: "auto" });
  assert.equal(auto.port.cards.length, 0);
});

test("search_sessions: own project by default; \"all\" narrowed per mode and never carded; a named other project follows the matrix", async () => {
  const hits = [
    { threadId: "sib", projectPath: OWN, title: "", turnId: "t1", ordinal: 1, kind: "message", id: "1", role: "assistant", activityKind: null, snippet: "«build» own", at: stamp(1), seq: 1 },
    { threadId: "web1", projectPath: SAME, title: "", turnId: "t1", ordinal: 1, kind: "message", id: "2", role: "assistant", activityKind: null, snippet: "«build» web", at: stamp(1), seq: 2 },
    { threadId: "far", projectPath: OTHER, title: "", turnId: "t1", ordinal: 1, kind: "message", id: "3", role: "assistant", activityKind: null, snippet: "«build» far", at: stamp(1), seq: 3 }
  ];
  const searching = () => {
    const r = rig();
    r.api.on("GET", agentChatRoutes.search, ({ query }) => ({ status: 200, body: { query: "build", hits: query?.projectPath ? hits.filter((h) => h.projectPath === query.projectPath) : hits, truncated: false, indexed: true } }));
    return r;
  };
  const ids = (result: CallToolResult) => (body(result).hits as { sessionId: string }[]).map((h) => h.sessionId);

  const byDefault = searching();
  const own = await byDefault.call("search_sessions", { query: "build" });
  assert.deepEqual(ids(own), ["sib"]);
  assert.equal(body(own).searched, "own-project");
  assert.equal(body(own).notice, UNTRUSTED_NOTICE);

  const supervised = searching();
  const narrowed = await supervised.call("search_sessions", { query: "build", project: "all" });
  assert.deepEqual(ids(narrowed), ["sib"]);
  assert.equal(body(narrowed).searched, "own-project");
  assert.equal(body(narrowed).excludedProjects, 2);
  assert.equal(supervised.port.cards.length, 0);

  const auto = searching();
  const workspace = await auto.call("search_sessions", { query: "build", project: "all" }, { runtimeMode: "auto" });
  assert.deepEqual(ids(workspace), ["sib", "web1"]);
  assert.equal(body(workspace).searched, "workspace");
  assert.equal(body(workspace).excludedProjects, 1);

  const full = searching();
  assert.deepEqual(ids(await full.call("search_sessions", { query: "build", project: "all" }, { runtimeMode: "full-access" })), ["sib", "web1", "far"]);

  const named = searching();
  const other = await named.call("search_sessions", { query: "build", project: "beta/app" }, { runtimeMode: "auto" });
  assert.equal(named.port.cards[0]?.family, "cross-workspace-read");
  assert.deepEqual(ids(other), ["far"]);
});

test("control_session: interrupt any chat but self; stop_process/compact/rewind/close only on agent-created children (§13 c)", async () => {
  const r = rig();
  assert.equal((await r.call("control_session", { sessionId: "sib", action: "interrupt" })).isError, undefined, "interrupt only stops work");
  const self = await r.call("control_session", { sessionId: "me", action: "interrupt" });
  assert.equal(code(self), "PERMISSION_DENIED");
  const gui = await r.call("control_session", { sessionId: "guifork", action: "close" });
  assert.equal(code(gui), "PERMISSION_DENIED", "a GUI fork is the user's");
  assert.match(body(gui).message, /chats this chat created/);
  assert.equal(code(await r.call("control_session", { sessionId: "sib", action: "compact" })), "PERMISSION_DENIED");
  const closed = await r.call("control_session", { sessionId: "child", action: "close" });
  assert.deepEqual({ ...body(closed), threadRef: undefined }, { closed: true, sessionId: "child", threadRef: undefined });
  assert.equal(body(closed).threadRef.relation, "opened");
  assert.deepEqual(posts(r.api), ["POST /api/sessions/sib/interrupt", "DELETE /api/sessions/child"]);
  assert.equal(code(await r.call("control_session", { sessionId: "child", action: "rewind" })), "INVALID_ARGUMENT", "rewind needs keepTurns");
});

test("control_session while planning: a data change is refused, stopping work is not", async () => {
  const r = rig();
  const compact = await r.call("control_session", { sessionId: "child", action: "compact" }, { planning: true });
  assert.equal(code(compact), "PERMISSION_DENIED");
  assert.match(body(compact).message, /planning/);
  assert.equal((await r.call("control_session", { sessionId: "child", action: "interrupt" }, { planning: true })).isError, undefined);
  assert.deepEqual(posts(r.api), ["POST /api/sessions/child/interrupt"]);
});

test("control_session on an own child in another workspace: a cross-project Act card below Full access", async () => {
  const r = rig();
  await r.call("control_session", { sessionId: "farkid", action: "compact" }, { runtimeMode: "auto" });
  assert.equal(r.port.cards[0]?.family, "cross-project");
  assert.match(r.port.cards[0]!.title, /compact the context of the chat "Chat farkid" in beta\/app/);
});

test("update_session: own title yes, own settings no; children only; never a broader mode", async () => {
  const r = rig();
  r.api.on("PUT", "/api/sessions/me", { status: 200, body: {} }).on("PUT", "/api/sessions/child", { status: 200, body: {} });
  assert.equal((await r.call("update_session", { sessionId: "me", title: "Renamed" })).isError, undefined);
  assert.equal(code(await r.call("update_session", { sessionId: "me", model: "haiku" })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("update_session", { sessionId: "guifork", title: "x" })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("update_session", { sessionId: "sib", title: "x" })), "PERMISSION_DENIED");
  const broader = await r.call("update_session", { sessionId: "child", runtimeMode: "full-access" });
  assert.equal(code(broader), "PERMISSION_DENIED");
  assert.match(body(broader).message, /broader/);
  assert.equal((await r.call("update_session", { sessionId: "child", title: "Kid" })).isError, undefined);
  assert.equal(code(await r.call("update_session", { sessionId: "child", title: "Kid" }, { planning: true })), "PERMISSION_DENIED", "a data change while planning");
  // A caller mode the catalogue does not know is the narrowest (fail closed): no mode is allowed, not every one.
  const unknown = await r.call("update_session", { sessionId: "child", runtimeMode: "approval-required" }, { runtimeMode: "god-mode" as never });
  assert.equal(code(unknown), "PERMISSION_DENIED");
  assert.match(body(unknown).message, /allowed: none/);
});

test("respond_to_request: own children's provider questions only; never a decision, a secret, or an Orquester card", async () => {
  const r = rig({
    child: thread("child", { pending: { approvals: [], userInputs: [QUESTION] } }),
    // A secret question is flagged on its raw request row, as the provider asked it.
    task: thread("task", { items: [activity("user-input.requested", { requestId: "q2", questions: [{ ...SECRET_QUESTION.questions[0], isSecret: true }] })], pending: { approvals: [], userInputs: [SECRET_QUESTION] } }),
    sib: thread("sib", { pending: { approvals: [], userInputs: [QUESTION] } })
  });
  // A card id (an Orquester approval, which lives on its own route) is no provider request.
  const card = await r.call("respond_to_request", { sessionId: "child", requestId: "a_1", answers: { db: "Postgres" } });
  assert.equal(code(card), "INVALID_ARGUMENT");
  assert.match(body(card).message, /No pending question/);
  assert.equal(code(await r.call("respond_to_request", { sessionId: "child", decision: "accept" })), "INVALID_ARGUMENT", "decision is external only");
  assert.equal(code(await r.call("respond_to_request", { sessionId: "sib", answers: { db: "Postgres" } })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("respond_to_request", { sessionId: "guifork", answers: { db: "Postgres" } })), "PERMISSION_DENIED");
  assert.equal(code(await r.call("respond_to_request", { sessionId: "task", answers: { tok: "sk-x" } })), "PERMISSION_DENIED", "a secret is the user's to give");
  assert.deepEqual(posts(r.api), []);
  const answered = await r.call("respond_to_request", { sessionId: "child", answers: { db: "Postgres" } });
  assert.equal(answered.isError, undefined, JSON.stringify(answered.structuredContent));
  assert.deepEqual(posts(r.api), ["POST /api/sessions/child/answer"]);
});

test("respond_to_request's boundary card lists an inline attachment by name and size, never its bytes", async () => {
  const r = rig({ farkid: thread("farkid", { pending: { approvals: [], userInputs: [QUESTION] } }) });
  const base64 = Buffer.from("x".repeat(3000)).toString("base64");
  await r.call("respond_to_request", { sessionId: "farkid", answers: { db: "see log" }, attachments: { db: [{ name: "log.txt", base64 }] } }, { runtimeMode: "auto" });
  const shown = JSON.stringify(r.port.cards[0]!.sections);
  assert.ok(!shown.includes(base64.slice(0, 64)));
  assert.match(shown, /log\.txt \(3000 bytes, inline\)/);
  assert.match(shown, /see log/);
});

test("a workflow-owned caller's \"all\" is narrowed too, and a would-be card is a denial", async () => {
  const r = rig();
  assert.equal(body(await r.call("list_sessions", { project: "all" }, { workflowOwned: true })).listed, "workspace");
  assert.equal(code(await r.call("read_transcript", { sessionId: "web1" }, { workflowOwned: true })), "PERMISSION_DENIED");
  assert.equal(r.port.cards.length, 0);
});

test("§4.3: another chat's words are marked — list rows with goal text, and the session detail an Act returns", async () => {
  const r = rig({ child: thread("child", { pending: { approvals: [], userInputs: [QUESTION] } }) });
  r.api.on("PUT", "/api/sessions/me", { status: 200, body: {} }).on("PUT", "/api/sessions/child", { status: 200, body: {} });
  assert.equal(body(await r.call("list_sessions", {})).notice, UNTRUSTED_NOTICE, "sib's goal objective is another chat's words");
  assert.equal(body(await r.call("list_sessions", { kind: "terminal" })).notice, undefined);
  const interrupt = body(await r.call("control_session", { sessionId: "sib", action: "interrupt" }));
  assert.equal(Object.keys(interrupt)[0], "notice");
  assert.equal(interrupt.notice, UNTRUSTED_NOTICE);
  assert.equal(body(await r.call("update_session", { sessionId: "child", title: "Kid" })).notice, UNTRUSTED_NOTICE);
  assert.equal(body(await r.call("update_session", { sessionId: "me", title: "Me" })).notice, undefined, "its own title: its own words");
  assert.equal(body(await r.call("respond_to_request", { sessionId: "child", answers: { db: "Postgres" } })).notice, UNTRUSTED_NOTICE);
  assert.equal(body(await r.call("control_session", { sessionId: "child", action: "close" })).notice, undefined, "a closed tab returns no words");
});

test("the chat frame is measured: a 200-character CJK title cannot push get_turn_diff or read_tool_output past the result cap", async () => {
  const title = "長".repeat(200);
  const cjk = tab("cjk", OWN, { title, order: 9 });
  const huge = "x".repeat(90_000);
  const r = rig({ cjk: thread("cjk", { checkpoints: [{ turnId: "t1", checkpointTurnCount: 1, checkpointRef: "r", status: "ready", files: [], assistantMessageId: null, completedAt: stamp(2) }] }) }, [cjk]);
  r.api.on("GET", agentChatRoutes.turnDiff("cjk", 1), { status: 200, body: { fromTurnCount: 0, toTurnCount: 1, diff: huge } });
  const item = message("assistant", huge, { id: "big" });
  r.api.on("GET", agentChatRoutes.item("cjk", "big"), { status: 200, body: { item } });
  for (const [name, args] of [["get_turn_diff", { sessionId: "cjk" }], ["read_tool_output", { sessionId: "cjk", itemId: "big", maxBytes: 55_000 }]] as const) {
    const result = await r.call(name, args);
    const text = (result.content[0] as { text: string }).text;
    assert.equal(body(result).truncated === true && body(result).truncationNote !== undefined, false, `${name}: never cut by ok()`);
    assert.ok(Buffer.byteLength(text, "utf8") <= 60_000, `${name}: ${Buffer.byteLength(text, "utf8")} bytes`);
    assert.equal(body(result).threadRef.title, title);
    assert.equal(body(result).notice, UNTRUSTED_NOTICE);
  }
});

test("external callers through the executor: respond_to_request takes a decision; control_session argument errors come from scope, before any read", async () => {
  const r = rig({ sib: thread("sib", { pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(1) }], userInputs: [] } }) });
  r.api.on("POST", "/api/sessions/sib/approval", { status: 200, body: { seq: 9 } });
  const run = (name: string, args: Record<string, unknown>) =>
    executeToolCall({ approvals: r.port, lookup: (n, audience) => toolByName(n, audience) }, { name, arguments: args }, { caller: { kind: "external" }, api: r.api, signal: new AbortController().signal });
  const decided = await run("respond_to_request", { sessionId: "sib", decision: "accept" });
  assert.equal(decided.isError, undefined, JSON.stringify(decided.structuredContent));
  assert.equal(body(decided).seq, 9);
  assert.equal(body(decided).notice, undefined, "external results carry no chat frame");
  const reads = r.api.calls.length;
  const missing = await run("control_session", { sessionId: "sib", action: "stop_task" });
  assert.equal(code(missing), "INVALID_ARGUMENT");
  assert.match(body(missing).message, /needs taskId/);
  assert.equal(r.api.calls.length, reads, "refused in scope: nothing read");
  assert.equal(r.port.cards.length, 0);
});
