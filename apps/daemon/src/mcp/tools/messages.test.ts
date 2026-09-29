import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { agentChatRoutes,encodeHistoryCursor,type ThreadItem,type ThreadSnapshotPayload,type Turn } from "@orquester/api/agent-chat";
import { busEvent,FakeDaemonApi } from "../testing.ts";
import { activity,chatSummary,head,message,shellSummary,snapshot,stamp,turn } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { messageTools } from "./messages.ts";

const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

// The fake routes every test shares, copied from sessions.test.ts (the two files never import each other's helpers).
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } }
] };
const providers = { hostInstanceId: "h", providers: [{ id: "claude", refIds: ["claude"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [],
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
  models: [{ slug: "default", name: "Default", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] } }, { slug: "haiku", name: "Haiku", capabilities: null }] }] };
const accounts = { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }, { id: "acc-2", agent: "codex", label: "e@x.io", email: "e@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };

async function harness(sessions = [chatSummary(), shellSummary()], snap = snapshot()) {
  const root = await mkdtemp(join(tmpdir(), "mcp-msg-"));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  const projectPath = join(root, "acme", "api");
  const fix = (s: ReturnType<typeof chatSummary>) => ({ ...s, projectPath, cwd: projectPath });
  api.on("GET", "/api/sessions", { status: 200, body: sessions.map(fix) })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, projectPath, cwd: projectPath } } } })
    .on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts });
  const ctx: ToolContext = { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") };
  return { api, ctx, projectPath, root, close: () => rm(root, { recursive: true, force: true }) };
}

/** One macrotask turn. The tools run on in-process fakes, so a single yield parks one wherever it waits; a tool that spins never yields at all. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/** `n` macrotask turns: long enough for a loop that re-reads once per macrotask to show itself. */
const ticks = async (n: number) => { for (let i = 0; i < n; i += 1) await tick(); };
/** A clock that jumps an hour on every read: a wait measured by it is over at its first check, with no real waiting. */
const racing = () => { let t = Date.parse("2026-09-22T12:00:00.000Z"); return () => (t += 3_600_000); };
/** Whether `p` has settled, readable after a yield. */
function settledFlag(p: Promise<unknown>): () => boolean {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

const tool = (name: string) => messageTools.find((t) => t.name === name)!;
const done = (over = {}) => chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, ...over });

test("send_message posts the turn body, waits for the new turn and returns its reply", async (t) => {
  const h = await harness(); t.after(h.close);
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("user", "hi", { turnId: "t2" }), message("assistant", "hello!", { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { posted = true; const sent = body as { input: string; interactionMode: string }; assert.equal(sent.input, "hi"); assert.equal(sent.interactionMode, "default"); return { status: 200, body: { seq: 21 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: posted ? { ...after, head: { ...after.head, projectPath: h.projectPath, cwd: h.projectPath } } : snapshot() } }));
  const p = tool("send_message").run({ sessionId: "c1", text: " hi ", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...done(), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.seq, 21); assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "hello!"); assert.equal(r.pending, undefined);
});

test("send_message without wait returns sent; attachments are uploaded first and referenced", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { const b = body as { attachments: { id: string }[]; input: string }; assert.deepEqual(b.attachments.map((ref) => ref.id), ["c1-att-1"]); assert.equal(b.input, "see"); return { status: 200, body: { seq: 3 } }; });
  const r = await tool("send_message").run({ sessionId: "c1", text: "see", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }], planMode: false, wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent");
});

test("send_message refusals: empty, pending request, plan mode unsupported; an errored session is sent to", async (t) => {
  const h = await harness(); t.after(h.close);
  const run = (a: Record<string, unknown>, ctx = h.ctx) => tool("send_message").run({ planMode: false, wait: false, timeoutMs: 1000, ...a }, ctx);
  await assert.rejects(run({ sessionId: "c1", text: "  " }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  const err = await harness([chatSummary({ chatSessionStatus: "error" })]); t.after(err.close);
  err.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 2 } });
  assert.equal((await run({ sessionId: "c1", text: "hi" }, err.ctx)).outcome, "sent", "an errored session is restarted by the next message");
  const stopped = await harness([chatSummary({ chatSessionStatus: "stopped" })]); t.after(stopped.close);
  stopped.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 2 } });
  assert.equal((await run({ sessionId: "c1", text: "hi" }, stopped.ctx)).outcome, "sent", "a stopped session resumes on the next message");
  const grok = await harness([chatSummary({ refId: "grok" })]); t.after(grok.close);
  grok.api.on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [{ id: "grok", refIds: ["grok"], installed: true, version: "1", status: "ready", auth: { status: "unknown" }, checkedAt: stamp(0), slashCommands: [], skills: [], models: [], capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: false, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } } }] } });
  await assert.rejects(run({ sessionId: "c1", text: "hi", planMode: true }, grok.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /plan mode/i.test(e.message));
  assert.ok(!h.api.calls.some((c) => c.method === "POST"));
});

test("send_message reports needs-input with the pending requests, and timeout", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 4 } });
  const asked = snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq: 4 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: { ...(posted ? asked : snapshot()), head: { ...snapshot().head, projectPath: h.projectPath, cwd: h.projectPath } } } }));
  const p = tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...chatSummary({ chatSessionStatus: "running", hasPendingApprovals: true }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "needs-input"); assert.equal((r.pending as { approvals: { requestId: string }[] }).approvals[0].requestId, "r1"); assert.equal(r.reply, undefined);
  const slow = await harness(); t.after(slow.close);
  slow.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 5 } });
  const to = await tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 1000 }, { ...slow.ctx, now: racing() });
  assert.equal(to.outcome, "timeout");
});

test("implement_plan sends the prefixed plan in default mode; refuses without an actionable plan", async (t) => {
  const planned = snapshot({ items: [activity("turn.proposed.completed", { planId: "p1", planMarkdown: "  # Plan\n1. do  " })] });
  const h = await harness([chatSummary({ hasActionableProposedPlan: true })], planned); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { const { input, interactionMode } = body as { input: string; interactionMode: string }; assert.deepEqual({ input, interactionMode }, { input: "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n1. do", interactionMode: "default" }); return { status: 200, body: { seq: 6 } }; });
  const r = await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent");
  const none = await harness(); t.after(none.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, none.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

// ---- Beyond the brief: the Task 9 rulings, and the spec points (§7.4, §7.6) its code left out. ----

test("implement_plan sends the FULL plan: a plan slimmed on the wire is read back unslimmed, never sent cut", async (t) => {
  const full = `# Plan\n${Array(700).fill("1. a step long enough to matter").join("\n")}`; // ~22 KB: over the 16 KiB wire cap
  const plan = activity("turn.proposed.completed", { planId: "p1", planMarkdown: `${full.slice(0, 1_000)}…`, truncated: true });
  const itemPath = agentChatRoutes.item("c1", plan.id);
  const h = await harness([chatSummary({ hasActionableProposedPlan: true })], snapshot({ items: [plan] })); t.after(h.close);
  h.api.on("GET", itemPath, { status: 200, body: { item: { ...plan, payload: { planId: "p1", planMarkdown: full } } } });
  let input = "";
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { input = (body as { input: string }).input; return { status: 200, body: { seq: 7 } }; });
  assert.equal((await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx)).outcome, "sent");
  assert.equal(input, `PLEASE IMPLEMENT THIS PLAN:\n${full}`);
  // No full copy to be had: refused, rather than having the agent implement a cut plan.
  const gone = await harness([chatSummary({ hasActionableProposedPlan: true })], snapshot({ items: [plan] })); t.after(gone.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, gone.ctx), (e: { code: string }) => e.code === "NOT_FOUND");
  assert.ok(!gone.api.calls.some((c) => c.method === "POST"), "nothing was sent");
});

test("implement_plan judges the plan on the fresh snapshot (the host's rule), not on the summary one poll behind", async (t) => {
  const plan = activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# Plan" });
  // Already implemented, the summary not caught up yet: a second call must not send the plan twice.
  const implemented = snapshot({ items: [plan, message("user", "PLEASE IMPLEMENT THIS PLAN:\n# Plan", { turnId: "t2" })] });
  const twice = await harness([chatSummary({ hasActionableProposedPlan: true })], implemented); t.after(twice.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, twice.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /already/.test(e.message));
  assert.ok(!twice.api.calls.some((c) => c.method === "POST"), "nothing was sent");
  // Just proposed: the snapshot has the plan before the summary flags it.
  const fresh = await harness([chatSummary({ hasActionableProposedPlan: false })], snapshot({ items: [plan] })); t.after(fresh.close);
  fresh.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 8 } });
  assert.equal((await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, fresh.ctx)).outcome, "sent");
});

test("send_message: a needs-input the snapshot does not confirm is the summary's lag, and the wait goes on", async (t) => {
  const h = await harness(); t.after(h.close);
  const where = { projectPath: h.projectPath, cwd: h.projectPath };
  // As in production, the list answers what the bus last published.
  let current = { ...chatSummary(), ...where };
  h.api.on("GET", "/api/sessions", () => ({ status: 200, body: [current] }));
  const publish = (s: ReturnType<typeof chatSummary>) => { current = { ...s, ...where }; h.api.emit(busEvent("session.updated", current)); };
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("user", "go on", { turnId: "t2" }), message("assistant", "done.", { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq: 30 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: { ...(posted ? after : snapshot()), head: { ...snapshot().head, ...where } } } }));
  const p = tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  const settled = settledFlag(p);
  await tick();
  // One poll behind: the question just answered is still flagged, while the snapshot has no request open.
  publish(chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }));
  await ticks(10);
  assert.ok(h.api.calls.filter((call) => call.path === "/api/sessions/c1/thread").length <= 3, "a stale flag must not busy-poll the snapshot");
  assert.equal(settled(), false, "still waiting");
  publish(done());
  await tick();
  assert.ok(settled(), "the bus event ends the stale wait at once, long before the 2 s re-check");
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "done."); assert.equal(r.pending, undefined);
  assert.equal((r.session as { lastReply?: unknown }).lastReply, undefined, "the reply is returned once, as `reply`");
});

test("send_message: a wait on a flag the snapshot never confirms still ends — at the timeout, on a close, on an abort", async (t) => {
  const stale = async (timeoutMs: number, over: Partial<ToolContext> = {}) => {
    const h = await harness(); t.after(h.close);
    // One poll behind from the start (right after answer_question): the list still flags a question the snapshot no longer has.
    h.api.on("GET", "/api/sessions", { status: 200, body: [{ ...chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }), projectPath: h.projectPath, cwd: h.projectPath }] });
    h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 40 } });
    const run = tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: true, timeoutMs }, { ...h.ctx, ...over });
    return { api: h.api, run, settled: settledFlag(run) };
  };
  const late = await stale(60_000, { now: racing() });
  assert.equal((await late.run).outcome, "timeout", "an unconfirmed flag is not an outcome");
  const gone = await stale(5_000);
  await tick();
  assert.equal(gone.settled(), false, "parked on the stale flag");
  gone.api.emit(busEvent("session.closed", { id: "c1" }));
  await tick();
  assert.ok(gone.settled(), "the close ends the wait at once");
  await assert.rejects(gone.run, (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  const ac = new AbortController();
  const dropped = await stale(5_000, { signal: ac.signal });
  await tick();
  assert.equal(dropped.settled(), false, "parked on the stale flag");
  ac.abort();
  await tick();
  assert.ok(dropped.settled(), "the abort ends the wait at once");
  assert.equal((await dropped.run).outcome, "timeout");
  assert.deepEqual([late, gone, dropped].map((wait) => wait.api.listenerCount()), [0, 0, 0], "every bus listener is removed");
});

test("send_message: PENDING_REQUEST names each open request and the tool that settles it", async (t) => {
  const open = snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [{ requestId: "q1", createdAt: stamp(6), dismissible: false, questions: [] }] } });
  const h = await harness([chatSummary({ hasPendingApprovals: true, hasPendingUserInput: true })], open); t.after(h.close);
  await assert.rejects(tool("send_message").run({ sessionId: "c1", text: "hi", planMode: false, wait: false, timeoutMs: 1000 }, h.ctx),
    (e: { code: string; message: string; detail: unknown }) => {
      assert.equal(e.code, "PENDING_REQUEST");
      assert.deepEqual(e.detail, { approvals: ["r1"], questions: ["q1"] });
      return /r1/.test(e.message) && /q1/.test(e.message) && /resolve_approval/.test(e.message) && /answer_question/.test(e.message);
    });
});

test("read_transcript accepts maxChars through 55000 with a 40000-byte default", () => {
  const schema = z.object(tool("read_transcript").input);
  assert.equal(schema.parse({ sessionId: "c1" }).maxChars, 40_000);
  assert.equal(schema.safeParse({ sessionId: "c1", maxChars: 55_000 }).success, true);
  assert.equal(schema.safeParse({ sessionId: "c1", maxChars: 55_001 }).success, false);
});

// ---- Fix round 1: the baseline is read right before the POST; a reply is this message's only if its turn was not over then. ----

test("send_message: the baseline is read right before the POST, so a turn that ended during the upload is not this message's", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const h = await harness([running], snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [turn(), turn({ turnId: "t2", turnCount: null, state: "running", requestedAt: stamp(2), startedAt: stamp(2), completedAt: null })] })); t.after(h.close);
  const where = { projectPath: h.projectPath, cwd: h.projectPath };
  const t2 = turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) });
  const t3 = turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: stamp(5) });
  const thread = (over: Parameters<typeof snapshot>[0]) => ({ status: 200, body: { kind: "snapshot", thread: { ...snapshot(over), head: { ...head(), ...where } } } });
  // t2 ends while the attachment uploads, and the summary catches up before the POST.
  h.api.onUpload((_id, meta, bytes) => {
    h.api.on("GET", "/api/sessions", { status: 200, body: [{ ...chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) } }), ...where }] });
    h.api.on("GET", "/api/sessions/c1/thread", thread({ turns: [turn(), t2], items: [message("assistant", "OLD (t2)", { turnId: "t2" })] }));
    return { status: 200, value: { type: "image", id: "att-1", name: meta.name, mimeType: meta.type, sizeBytes: bytes.length } };
  });
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 60 } });
  const p = tool("send_message").run({ sessionId: "c1", text: "and this", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }], planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  const settled = settledFlag(p);
  await tick();
  assert.equal(settled(), false, "t2 ending is not this message's outcome");
  h.api.on("GET", "/api/sessions/c1/thread", thread({ turns: [turn(), t2, t3], items: [message("assistant", "OLD (t2)", { turnId: "t2" }), message("assistant", "NEW (t3)", { turnId: "t3" })] }));
  h.api.emit(busEvent("session.updated", { ...chatSummary({ latestTurn: { turnId: "t3", state: "completed", startedAt: stamp(4), completedAt: stamp(5) } }), ...where }));
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t3"); assert.equal(r.reply, "NEW (t3)");
});

test("send_message never returns an earlier turn's id or reply: a provider that fails to (re)start", async (t) => {
  const old = snapshot({ items: [message("user", "earlier"), message("assistant", "OLD REPLY (turn t1)")] });
  // "starting" — a stopped session restarting its provider — with t1 long finished (the reviewer's reproduction).
  const h = await harness([chatSummary({ chatSessionStatus: "starting" })], old); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 61 } });
  const p = tool("send_message").run({ sessionId: "c1", text: "hi", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...chatSummary({ chatSessionStatus: "error" }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "failed"); assert.equal(r.turnId, undefined); assert.equal(r.reply, undefined);
  // A send with wait:false just before: its turn is still a pending row with no id, so the summary never names t1.
  const queued = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: null, state: "pending", startedAt: null, completedAt: null } });
  const q = await harness([queued], snapshot({ items: old.items, turns: [turn(), turn({ turnId: null, state: "pending", turnCount: null, requestedAt: stamp(2), startedAt: null, completedAt: null })] })); t.after(q.close);
  q.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 62 } });
  const qp = tool("send_message").run({ sessionId: "c1", text: "and hi", planMode: false, wait: true, timeoutMs: 5_000 }, q.ctx);
  await tick();
  q.api.emit(busEvent("session.updated", { ...chatSummary({ chatSessionStatus: "error", latestTurn: { turnId: null, state: "failed", startedAt: null, completedAt: stamp(3) } }), projectPath: q.projectPath }));
  const qr = await qp;
  assert.equal(qr.outcome, "failed"); assert.equal(qr.turnId, undefined); assert.equal(qr.reply, undefined);
});

test("send_message refusals upload nothing; plan mode needs a known capability", async (t) => {
  const png = [{ name: "a.png", base64: Buffer.from("png").toString("base64") }];
  const run = (ctx: ToolContext, a: Record<string, unknown> = {}) => tool("send_message").run({ sessionId: "c1", text: "hi", attachments: png, planMode: false, wait: false, timeoutMs: 1000, ...a }, ctx);
  const pending = await harness([chatSummary({ hasPendingApprovals: true })], snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } })); t.after(pending.close);
  await assert.rejects(run(pending.ctx), (e: { code: string }) => e.code === "PENDING_REQUEST");
  // The provider list could not be read: get_session reports supports.planMode false, and the gate agrees.
  const blind = await harness(); t.after(blind.close);
  blind.api.on("GET", "/api/agent/providers", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting." } } });
  await assert.rejects(run(blind.ctx, { planMode: true }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /plan mode/i.test(e.message));
  for (const h of [pending, blind]) {
    assert.equal(h.api.uploads.length, 0, "nothing was uploaded");
    assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was posted");
  }
});

// ---- Final wave C1: the timed stale re-check, the summary half of "over", a stamped running turn, a lagging list. ----

test("send_message: with no bus event at all, a stale needs-input is rechecked and the completed reply returned", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(); t.after(h.close);
  const where = { projectPath: h.projectPath, cwd: h.projectPath };
  // One poll behind from the start: the list flags a question the snapshot no longer has.
  let listed = { ...chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }), ...where };
  h.api.on("GET", "/api/sessions", () => ({ status: 200, body: [listed] }));
  let hostSettled = false;
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("assistant", "done.", { turnId: "t2" })] });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: { ...(hostSettled ? after : snapshot()), head: { ...snapshot().head, ...where } } } }));
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 70 } });
  let clock = Date.parse("2026-09-22T12:00:00.000Z");
  const p = tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: true, timeoutMs: 60_000 }, { ...h.ctx, now: () => clock });
  const settled = settledFlag(p);
  await ticks(10);
  // t2 settles, but the event that says so is lost: only the timed re-check can notice.
  listed = { ...done(), ...where };
  hostSettled = true;
  clock += 2_000; t.mock.timers.tick(2_000);
  await ticks(10);
  assert.ok(settled(), "the 2 s re-check read the list again and saw t2 settled");
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "done.");
});

test("send_message: a stale park never outlives the timeout — the last one is only what is left of it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(); t.after(h.close);
  h.api.on("GET", "/api/sessions", { status: 200, body: [{ ...chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }), projectPath: h.projectPath, cwd: h.projectPath }] });
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 71 } });
  let clock = Date.parse("2026-09-22T12:00:00.000Z");
  const p = tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: true, timeoutMs: 3_000 }, { ...h.ctx, now: () => clock });
  const settled = settledFlag(p);
  await ticks(10);
  clock += 2_000; t.mock.timers.tick(2_000); // the first re-check: still stale, 1 000 ms left
  await ticks(10);
  clock += 999; t.mock.timers.tick(999);
  await ticks(10);
  assert.equal(settled(), false, "the second park is the 1 000 ms that are left, not another 2 s");
  clock += 1; t.mock.timers.tick(1);
  await ticks(10);
  assert.ok(settled(), "over at the timeout");
  assert.equal((await p).outcome, "timeout");
});

test("send_message: a turn that ended during the upload is over even when only the summary knows it — a failed next turn returns no old reply", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  // The snapshot the send is checked on still shows t2 running: only the summary read right before the POST says it ended.
  const h = await harness([running], snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [turn(), turn({ turnId: "t2", turnCount: null, state: "running", requestedAt: stamp(2), startedAt: stamp(2), completedAt: null })] })); t.after(h.close);
  const where = { projectPath: h.projectPath, cwd: h.projectPath };
  const t2Done = { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) } as const;
  h.api.onUpload((_id, meta, bytes) => {
    h.api.on("GET", "/api/sessions", { status: 200, body: [{ ...chatSummary({ latestTurn: t2Done }), ...where }] });
    h.api.on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("assistant", "OLD (t2)", { turnId: "t2" })] }), head: { ...head(), ...where } } } });
    return { status: 200, value: { type: "image", id: "att-1", name: meta.name, mimeType: meta.type, sizeBytes: bytes.length } };
  });
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 72 } });
  const p = tool("send_message").run({ sessionId: "c1", text: "and this", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }], planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  // The next turn's provider fails to start: the session errors with t2 still its latest turn.
  h.api.emit(busEvent("session.updated", { ...chatSummary({ chatSessionStatus: "error", latestTurn: t2Done }), ...where }));
  const r = await p;
  assert.equal(r.outcome, "failed"); assert.equal(r.reply, undefined, "t2's reply answers an earlier message"); assert.equal(r.turnId, undefined);
});

test("send_message: a running turn stamped with a mid-turn completedAt is not over — a steer into it gets its reply", async (t) => {
  // turn-state.ts: a running turn's completedAt can hold a mid-turn placeholder-checkpoint stamp; only the state settles a turn.
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: stamp(3) } });
  const live = snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [turn(), turn({ turnId: "t2", turnCount: null, state: "running", requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("assistant", "OLD (t1)")] });
  const h = await harness([running], live); t.after(h.close);
  const answered = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(5) })], items: [message("assistant", "OLD (t1)"), message("assistant", "steered answer", { turnId: "t2" })] });
  let settledHost = false;
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 73 } });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: { ...(settledHost ? answered : live), head: { ...(settledHost ? answered : live).head, projectPath: h.projectPath, cwd: h.projectPath } } } }));
  assert.equal((await tool("send_message").run({ sessionId: "c1", text: "also the edge case", planMode: false, wait: false, timeoutMs: 1000 }, h.ctx)).turnId, "t2", "wait:false names the steered turn");
  const p = tool("send_message").run({ sessionId: "c1", text: "also the edge case", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  settledHost = true;
  h.api.emit(busEvent("session.updated", { ...chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(5) } }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "steered answer");
});

test("send_message: the list catching up on a turn that was already over is not this message's outcome — the wait goes on to its own turn", async (t) => {
  const h = await harness(); t.after(h.close);
  const where = { projectPath: h.projectPath, cwd: h.projectPath };
  // The host has settled t2 (the snapshot says so) while the list, one poll behind, still shows it running.
  let current = { ...chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }), ...where };
  h.api.on("GET", "/api/sessions", () => ({ status: 200, body: [current] }));
  const publish = (s: ReturnType<typeof chatSummary>) => { current = { ...s, ...where }; h.api.emit(busEvent("session.updated", current)); };
  const thread = (over: Parameters<typeof snapshot>[0]) => ({ status: 200, body: { kind: "snapshot", thread: { ...snapshot(over), head: { ...head(), ...where } } } });
  const t2 = turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) });
  h.api.on("GET", "/api/sessions/c1/thread", thread({ turns: [turn(), t2], items: [message("assistant", "OLD (t2)", { turnId: "t2" })] }));
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 74 } });
  const p = tool("send_message").run({ sessionId: "c1", text: "next", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  const settled = settledFlag(p);
  await tick();
  publish(chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) } }));
  await ticks(10);
  assert.equal(settled(), false, "t2 settling in the list is old news");
  const t3 = turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: stamp(5) });
  h.api.on("GET", "/api/sessions/c1/thread", thread({ turns: [turn(), t2, t3], items: [message("assistant", "OLD (t2)", { turnId: "t2" }), message("assistant", "NEW (t3)", { turnId: "t3" })] }));
  publish(chatSummary({ latestTurn: { turnId: "t3", state: "completed", startedAt: stamp(4), completedAt: stamp(5) } }));
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t3"); assert.equal(r.reply, "NEW (t3)");
});

test("read_transcript includes its truncation hint within the byte budget when only the roster is trimmed", async (t) => {
  const roster = Array.from({ length: 40 }, (_, i) => ({
    id: `task-${i}`, kind: "subagent", agentKind: "agent", title: `Survey package ${i}: list its exports, callers and test coverage`,
    status: "completed", firstSeenAt: stamp(i)
  }) as never);
  const h = await harness([chatSummary()], snapshot({
    items: [message("user", "Survey the packages."), message("assistant", "Every package is surveyed.")], roster
  }));
  t.after(h.close);
  const r = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 2_000 }, h.ctx);
  assert.deepEqual((r.entries as { text: string }[]).map((entry) => entry.text), ["Survey the packages.", "Every package is surveyed."]);
  assert.deepEqual([r.truncated, r.subagentsTruncated], [true, true]);
  assert.ok(typeof r.hint === "string" && r.hint.length > 0);
  assert.ok(resultBytes(r) <= 2_000);
});

test("send_message planMode on a degraded 200 providers body: the capability could not be read, and the refusal says so", async (t) => {
  const run = (ctx: ToolContext) => tool("send_message").run({ sessionId: "c1", text: "plan it", planMode: true, wait: false, timeoutMs: 1000 }, ctx);
  const supported = await harness(); t.after(supported.close);
  supported.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 1 } });
  assert.equal((await run(supported.ctx)).outcome, "sent");
  const claudeRow = { id: "claude", refIds: ["claude"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], models: [] };
  // An older host's degraded rows: capabilities a string, or null; a null row beside it; a body with no list at all.
  for (const body of [
    { hostInstanceId: "h", providers: [{ ...claudeRow, capabilities: "plan" }] },
    { hostInstanceId: "h", providers: [null, { ...claudeRow, capabilities: null }] },
    { hostInstanceId: "h", providers: "claude" }
  ]) {
    const h = await harness(); t.after(h.close);
    h.api.on("GET", "/api/agent/providers", { status: 200, body });
    await assert.rejects(run(h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT", JSON.stringify(body));
    assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was posted");
  }
});

// ---- Final fix wave F2 ----

/** The thread route answering `before` until the turn is posted (answered `seq`), then `after` — with the harness's project path. */
function threadAfterPost(h: Awaited<ReturnType<typeof harness>>, before: ThreadSnapshotPayload, after: ThreadSnapshotPayload, seq: number): void {
  let posted = false;
  const at = (snap: ThreadSnapshotPayload) => ({ status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, projectPath: h.projectPath, cwd: h.projectPath } } } });
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => at(posted ? after : before));
}

test("read_transcript refuses an empty agentId rather than answering the main view", () => {
  const schema = z.object(tool("read_transcript").input);
  assert.equal(schema.safeParse({ sessionId: "c1", agentId: "" }).success, false);
  assert.equal(schema.safeParse({ sessionId: "c1", agentId: "task-1" }).success, true);
});

/** A roster row as the host folds it; `text` supplies its title, progress and error (copied from views.test.ts). */
function rosterRow(i: number, status: string, text: (label: string) => string): never {
  return { id: `task-${i}`, kind: "subagent", agentKind: "agent", title: text("Title"), role: null, model: "sonnet", effort: "high", status, activationCount: 1, usage: null, progress: text("Progress"), lastToolName: "Read", result: null, error: text("Error"), outputFile: null, exitCode: null,
    isBackgrounded: false, parentAgentId: null, agentIndex: null, phaseIndex: null, phaseTitle: null, attempt: 1, workflowName: null, phases: [], runHandles: null, recentActivity: [], firstSeenAt: stamp(i), startedAt: stamp(i), completedAt: status === "running" ? null : stamp(i + 1), updatedAt: stamp(i + 1) } as never;
}

test("send_message's result keeps within the cap beside a full detail: the pending request it returns twice is paid for by the subagent list", async (t) => {
  const long = (label: string, i: number) => `${label} of agent ${i}: ${"a long line of narration ".repeat(60)}`;
  const roster = Array.from({ length: 100 }, (_, i) => rosterRow(i, "completed", (label) => long(label, i)));
  const reply = `Done. ${"the reply goes on ".repeat(1_000)}`.slice(0, 16_000);
  const command = `rm -rf ${"build/".repeat(600)}`; // 3 607 characters: whole, under the view's 4 096 cap
  const before = snapshot({ items: [message("user", "go", { turnId: "t1" }), message("assistant", reply, { turnId: "t1" })], roster });
  // Right after the post, the agent asks to run a long command.
  const after = snapshot({ ...before,
    items: [...before.items, activity("approval.requested", { requestId: "r1", requestKind: "command", detail: command, args: { toolName: "Bash", input: { command } } }, { tone: "approval" })],
    pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5), detail: command }], userInputs: [] } });
  const h = await harness([chatSummary()], before); t.after(h.close);
  threadAfterPost(h, before, after, 11);
  const r = await tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: false, timeoutMs: 1000 }, h.ctx);
  type Detail = { pending: unknown; subagents: { id: string }[]; subagentsTruncated?: true; lastReply?: { text: string } };
  const session = r.session as Detail;
  assert.equal(r.outcome, "sent");
  assert.ok(resultBytes(r) <= 60_000, `${resultBytes(r)} bytes`);
  assert.deepEqual(r.pending, session.pending, "the request, whole, in both places");
  assert.equal((session.pending as { approvals: { detail: string }[] }).approvals[0]?.detail, command);
  assert.equal(session.lastReply?.text, reply, "the reply stays whole");
  assert.equal(session.subagentsTruncated, true);
});

test("send_message: a reply too wide for one result beside a wide plan is cut by bytes, on a code-point boundary, and comes back as `reply` with replyTruncated", async (t) => {
  const h = await harness(); t.after(h.close);
  const plan = "漢".repeat(16_384); // 49 152 bytes of UTF-8
  const reply = "😀".repeat(16_384); // 65 536 bytes
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })],
    items: [message("user", "plan it", { turnId: "t2" }), message("assistant", reply, { turnId: "t2" }), activity("turn.proposed.completed", { planId: "p1", planMarkdown: plan }, { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq: 30 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: posted ? { ...after, head: { ...after.head, projectPath: h.projectPath, cwd: h.projectPath } } : snapshot() } }));
  const p = tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...done(), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2");
  assert.ok(resultBytes(r) <= 60_000, `${resultBytes(r)} bytes`);
  const text = r.reply as string;
  assert.equal(r.replyTruncated, true);
  assert.ok(text.length > 0 && text.length < reply.length && reply.startsWith(text) && !/[\uD800-\uDBFF]$/.test(text), "a head of the reply, whole code points");
  const session = r.session as { lastReply?: unknown; plan?: { markdown: string; truncated: boolean } };
  assert.equal(session.lastReply, undefined, "returned once, as reply");
  assert.deepEqual([session.plan?.markdown === plan, session.plan?.truncated], [true, false], "the reply went first, and cutting it made room");
});

// ---- Older history (design item 3): read_transcript pages the host's thread index. ----

/**
 * A thread of `n` started turns — each an opening message written with the idle session's null turnId and linked back
 * by `userMessageId`, then a reply — whose retained window holds turns `oldest`..n, with the bounds a current host
 * stamps; and the rows of any turns, for a page to answer with.
 */
function history(n: number, oldest: number) {
  const turns: Turn[] = [];
  const rows: ThreadItem[][] = [];
  for (let t = 1; t <= n; t += 1) {
    const ask = message("user", `ask ${t}`, { turnId: null, id: `ask-${t}` });
    const reply = message("assistant", `reply ${t}`, { turnId: `t${t}`, id: `reply-${t}` });
    turns.push(turn({ turnId: `t${t}`, turnCount: t, requestedAt: ask.createdAt, startedAt: ask.createdAt, completedAt: reply.createdAt, userMessageId: ask.id }));
    rows.push([ask, reply]);
  }
  const rowsOf = (from: number, to: number): ThreadItem[] => rows.slice(from - 1, to).flat();
  const snap = snapshot({ turns, items: rowsOf(oldest, n), history: { indexed: true, hasOlder: true, beforeCursor: "window", oldestRetainedOrdinal: oldest, totalTurns: n } });
  /** The cursor a host mints for a page that begins inside turn `k`. */
  const cursorIn = (k: number): string => encodeHistoryCursor({ threadId: "c1", beforeAnchorAt: turns[k - 1]!.requestedAt, beforeTurnId: `t${k}`, beforeSeq: k * 10 });
  const page = (items: ThreadItem[], beforeCursor: string | null) => ({ status: 200, body: { threadId: "c1", turns: [], items, checkpoints: [], page: { beforeCursor }, seq: 999 } });
  return { snap, rowsOf, cursorIn, page };
}
const historyCalls = (h: { api: FakeDaemonApi }) => h.api.calls.filter((c) => c.path === agentChatRoutes.history("c1"));
const readArgs = (over: Record<string, unknown> = {}) => ({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 40_000, ...over });

test("read_transcript: beforeTurn past turnCount + 1 is refused naming the range, one below 2 by the schema — before any page is read", async (t) => {
  const input = z.object(tool("read_transcript").input);
  for (const beforeTurn of [1, 0, -3, 2.5]) assert.equal(input.safeParse({ sessionId: "c1", beforeTurn }).success, false, `beforeTurn ${beforeTurn}`);
  assert.equal(input.safeParse({ sessionId: "c1", beforeTurn: 2 }).success, true);
  const refused = async (n: number, beforeTurn: number, range?: RegExp) => {
    const h = await harness([chatSummary()], history(n, 1).snap); t.after(h.close);
    await assert.rejects(tool("read_transcript").run(readArgs({ beforeTurn }), h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message.length > 0 && (range === undefined || range.test(e.message)));
    assert.equal(historyCalls(h).length, 0);
  };
  await refused(10, 12, /\b2\b.*\b11\b/);
  await refused(1, 3, /\b2\b/);
  await refused(0, 2);
  // turnCount + 1 is the latest turns, as without it.
  const h = await harness([chatSummary()], history(10, 1).snap); t.after(h.close);
  const r = await tool("read_transcript").run(readArgs({ beforeTurn: 11, turns: 2 }), h.ctx);
  assert.deepEqual([r.olderTurns, r.coveredTurns], [8, [9, 10]]);
});

test("read_transcript: with turns named unavailable, the answer — its hint, and the shed hint after it — still fits maxChars", async (t) => {
  const th = history(10, 8);
  const long = snapshot({ ...th.snap, items: [...th.snap.items, message("assistant", "z".repeat(12_000), { turnId: "t10" })] });
  const h = await harness([chatSummary()], long); t.after(h.close);
  h.api.on("GET", agentChatRoutes.history("c1"), { status: 503, body: { error: { code: "INDEX_UNAVAILABLE", message: "rebuilding" } } });
  for (const maxChars of [2_000, 3_000, 5_000, 9_000, 12_300, 20_000]) {
    const r = await tool("read_transcript").run(readArgs({ turns: 5, maxChars }), h.ctx);
    const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
    assert.ok(bytes <= maxChars, `maxChars ${maxChars}: ${bytes} bytes, hint included`);
    assert.deepEqual(r.unavailableTurns, [6, 8], `maxChars ${maxChars}`);
    assert.equal(typeof r.hint, "string");
    assert.ok((r.hint as string).length > 0, `maxChars ${maxChars}: unavailable range is explained`);
  }
});

test("read_transcript: a subagent of an older turn is known by the rows a page brought back", async (t) => {
  const th = history(10, 8);
  const h = await harness([chatSummary()], th.snap); t.after(h.close);
  const [, reply6] = th.rowsOf(6, 6);
  const at = new Date(Date.parse(reply6!.createdAt) + 500).toISOString();
  const own = message("assistant", "the old agent's own words", { turnId: "t6", agentId: "task-old", createdAt: at, updatedAt: at });
  h.api.on("GET", agentChatRoutes.history("c1"), th.page([...th.rowsOf(5, 6), own, ...th.rowsOf(7, 7)], th.cursorIn(5)));
  const r = await tool("read_transcript").run(readArgs({ turns: 5, agentId: "task-old" }), h.ctx);
  assert.deepEqual((r.entries as { text: string }[]).map((e) => e.text), ["the old agent's own words"]);
  // Unknown anywhere, it is still refused.
  await assert.rejects(tool("read_transcript").run(readArgs({ turns: 5, agentId: "task-none" }), h.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

// ---------------------------------------------------------------------------
// Goals §5.1: a `/goal` the host runs itself (Codex) starts no turn and answers in a row
// ---------------------------------------------------------------------------

const codexRegistry = { ...registry, agents: [...registry.agents, { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } }] };
const codexProviders = { ...providers, providers: [...providers.providers, { id: "codex", refIds: ["codex"], installed: true, version: "0.155.1", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], models: [],
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" }, goals: { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true } } }] };
const goalStatusRow = () => activity("goal.status", {}, { summary: "Goal: Ship the parser (active, 2 rounds)" });

/** A Codex tab whose thread reads `before` until a turn is posted, then `after(input)`; `bodies` records every POST. */
async function goalHarness(before: ThreadSnapshotPayload, after: (input: string) => ThreadSnapshotPayload, over = {}) {
  const h = await harness([chatSummary({ refId: "codex", title: "Codex", ...over })], before);
  h.api.on("GET", "/api/registry", { status: 200, body: codexRegistry }).on("GET", "/api/agent/providers", { status: 200, body: codexProviders });
  const bodies: Record<string, unknown>[] = [];
  let posted: string | null = null;
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { bodies.push(body as Record<string, unknown>); posted = (body as { input: string }).input; return { status: 200, body: { seq: 30 } }; });
  const at = (snap: ThreadSnapshotPayload) => ({ status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, adapter: "codex" as const, refId: "codex", projectPath: h.projectPath, cwd: h.projectPath } } } });
  h.api.on("GET", "/api/sessions/c1/thread", () => at(posted === null ? before : after(posted)));
  return { ...h, bodies };
}

test("goals §5.1: a Codex /goal status runs on the host — no turn wait, and the status row is the answer", async (t) => {
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input), goalStatusRow()] })); t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "  /goal status ", planMode: false, wait: true, timeoutMs: 120_000 }, h.ctx);
  assert.deepEqual(h.bodies.map(({ input, interactionMode }) => ({ input, interactionMode })), [{ input: "/goal status", interactionMode: "default" }]);
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, "Goal: Ship the parser (active, 2 rounds)");
  assert.equal(r.turnId, undefined, "no turn started, and no agent read the message");
  assert.equal(r.reply, undefined);
  assert.equal(r.seq, 30);
});

test("goals §5.1: a goal update answers /goal <objective>, with the rest of the same command", async (t) => {
  const cleared = activity("goal.updated", { goal: null, change: "cleared", previous: { objective: "Old goal", status: "active" } }, { summary: "Goal cleared: Old goal" });
  const set = activity("goal.updated", { goal: { objective: "Ship it", status: "active" }, change: "set" }, { summary: "Goal set: Ship it" });
  let phase = 1;
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input), cleared, ...(phase === 2 ? [set] : [])] })); t.after(h.close);
  let now = Date.parse("2026-09-22T12:00:00.000Z");
  const p = tool("send_message").run({ sessionId: "c1", text: "/goal Ship it", planMode: false, wait: true, timeoutMs: 120_000 }, { ...h.ctx, now: () => now });
  const settled = settledFlag(p);
  await ticks(10);
  assert.equal(settled(), false, "an update alone waits for its siblings");
  // Replacing a goal writes "cleared", then "set": the second lands inside the settle window.
  phase = 2;
  now += 600;
  h.api.emit(busEvent("session.updated", { ...chatSummary({ refId: "codex" }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, "Goal cleared: Old goal\nGoal set: Ship it");
});

test("goals §5.1: a failed goal command is outcome failed, and the answer says why", async (t) => {
  const failed = activity("goal.command.failed", { detail: "codex: thread/goal/set timed out" }, { summary: "Goal command failed", tone: "error" });
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input), failed] })); t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "/goal pause", planMode: false, wait: true, timeoutMs: 120_000 }, h.ctx);
  assert.equal(r.outcome, "failed");
  assert.equal(r.answer, "Goal command failed: codex: thread/goal/set timed out");
});

test("goals §5.1: only rows after the command's own message answer it, and a hidden progress tick never does", async (t) => {
  // An update that landed between the check and the post answers another command (or none).
  const achieved = activity("goal.updated", { goal: { objective: "Old", status: "complete" }, change: "achieved" }, { summary: "Goal achieved: Old" });
  const progress = activity("goal.updated", { goal: { objective: "Ship it", status: "active" }, change: "progress" }, { id: "goal-progress:c1", summary: "Goal progress" });
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [achieved, message("user", input), progress, goalStatusRow()] })); t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "/goal", planMode: false, wait: true, timeoutMs: 120_000 }, h.ctx);
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, "Goal: Ship the parser (active, 2 rounds)");
});

test("goals §5.1: a command that writes no row comes back without an answer once the wait runs out", async (t) => {
  // Pausing a paused goal changes nothing, so nothing is written: the goal as it stands is in session.chat.
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input)] })); t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "/goal pause", planMode: false, wait: true, timeoutMs: 120_000 }, { ...h.ctx, now: racing() });
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, undefined);
  assert.ok(typeof r.hint === "string" && r.hint.length > 0);
  assert.equal(h.bodies.length, 1);
});

test("goals §5.1: wait:false posts a host /goal and returns sent, as for any message", async (t) => {
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input), goalStatusRow()] })); t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "/goal clear", planMode: false, wait: false, timeoutMs: 1_000 }, h.ctx);
  assert.equal(r.outcome, "sent");
  assert.equal(r.answer, undefined);
  assert.equal(h.bodies.length, 1);
});

test("goals §5.1: an open request holds back every message but a /goal the host runs", async (t) => {
  const asked = snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } });
  const h = await goalHarness(asked, (input) => snapshot({ ...asked, items: [message("user", input), activity("goal.updated", { goal: { objective: "Ship it", status: "paused" }, change: "paused" }, { summary: "Goal paused" })] }), { hasPendingApprovals: true, chatSessionStatus: "running" });
  t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "/goal pause", planMode: false, wait: true, timeoutMs: 120_000 }, { ...h.ctx, now: racing() });
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, "Goal paused");
  assert.equal((r.pending as { approvals: { requestId: string }[] }).approvals[0]!.requestId, "r1", "the request is still open, and reported");
  // A prompt still waits for the card, on the same tab.
  await assert.rejects(tool("send_message").run({ sessionId: "c1", text: "hi", planMode: false, wait: false, timeoutMs: 1_000 }, h.ctx), (e: { code: string }) => e.code === "PENDING_REQUEST");
  assert.equal(h.bodies.length, 1);
  // Where the provider parses /goal (Claude), it is a prompt like any other.
  const claude = await harness([chatSummary({ hasPendingApprovals: true })], asked); t.after(claude.close);
  await assert.rejects(tool("send_message").run({ sessionId: "c1", text: "/goal Ship it", planMode: false, wait: false, timeoutMs: 1_000 }, claude.ctx), (e: { code: string }) => e.code === "PENDING_REQUEST");
});

test("goals §5.1: a /goal whose route cannot be told — the capabilities unread — is refused, as plan mode is", async (t) => {
  // Sent as a prompt, the host might run it as a command while the call waited on a turn that never starts.
  const blind = await goalHarness(snapshot(), () => snapshot()); t.after(blind.close);
  blind.api.on("GET", "/api/agent/providers", { status: 503, body: { code: "HOST_UNAVAILABLE", message: "down" } });
  await assert.rejects(tool("send_message").run({ sessionId: "c1", text: "/goal pause", planMode: false, wait: true, timeoutMs: 120_000 }, blind.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT");
  assert.equal(blind.bodies.length, 0, "nothing was sent");
  // Any other text is unaffected: it needs no route.
  blind.api.on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...snapshot(), head: { ...snapshot().head, adapter: "codex", refId: "codex", projectPath: blind.projectPath, cwd: blind.projectPath } } } });
  assert.equal((await tool("send_message").run({ sessionId: "c1", text: "hi", planMode: false, wait: false, timeoutMs: 1_000 }, blind.ctx)).outcome, "sent");
});

test("goals §5.1: a host /goal with attachments is refused before anything is uploaded or posted", async (t) => {
  const h = await goalHarness(snapshot(), () => snapshot()); t.after(h.close);
  await assert.rejects(
    tool("send_message").run({ sessionId: "c1", text: "/goal Ship it", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }], planMode: false, wait: false, timeoutMs: 1_000 }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT"
  );
  assert.equal(h.api.uploads.length, 0);
  assert.equal(h.bodies.length, 0);
});

test("goals §5.1: on Claude a /goal is an ordinary prompt, waited on as a turn", async (t) => {
  const h = await harness(); t.after(h.close);
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("user", "/goal Ship it", { turnId: "t2" }), message("assistant", "Goal set: Ship it", { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq: 8 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: posted ? { ...after, head: { ...after.head, projectPath: h.projectPath, cwd: h.projectPath } } : snapshot() } }));
  const p = tool("send_message").run({ sessionId: "c1", text: "/goal Ship it", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...done(), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "completed");
  assert.equal(r.turnId, "t2");
  assert.equal(r.reply, "Goal set: Ship it");
  assert.equal(r.answer, undefined);
});

test("goals §5.1: the answer window runs from when the session is up — a cold session's start never eats it", async (t) => {
  // After stop_session the host starts the session before it runs the command: 20 s of that are not the answer's wait.
  let phase: "starting" | "answered" = "starting";
  const statusRow = goalStatusRow();
  const h = await goalHarness(snapshot({ head: head({ session: { status: "stopped", activeTurnId: null } }) }), (input) =>
    phase === "starting"
      ? snapshot({ head: head({ session: { status: "starting", activeTurnId: null } }), items: [message("user", input)] })
      : snapshot({ items: [message("user", input), statusRow] }), { chatSessionStatus: "stopped" }); t.after(h.close);
  let now = Date.parse("2026-09-22T12:00:00.000Z");
  const p = tool("send_message").run({ sessionId: "c1", text: "/goal status", planMode: false, wait: true, timeoutMs: 120_000 }, { ...h.ctx, now: () => now });
  const settled = settledFlag(p);
  await ticks(10);
  now += 20_000;
  h.api.emit(busEvent("session.updated", { ...chatSummary({ refId: "codex", chatSessionStatus: "starting" }), projectPath: h.projectPath }));
  await ticks(10);
  assert.equal(settled(), false, "still starting: the window has not begun");
  phase = "answered";
  h.api.emit(busEvent("session.updated", { ...chatSummary({ refId: "codex" }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, "Goal: Ship the parser (active, 2 rounds)");
});

test("goals §5.1: a pause of a paused goal, or a resume of an active one, waits a settle's worth, not the whole window", async (t) => {
  const run = async (text: string, status: "active" | "paused") => {
    const checked = snapshot({ goal: { objective: "Ship it", status, updatedAt: stamp(3) } });
    const h = await goalHarness(checked, (input) => snapshot({ ...checked, items: [message("user", input)] }));
    let now = Date.parse("2026-09-22T12:00:00.000Z");
    const abort = new AbortController();
    const p = tool("send_message").run({ sessionId: "c1", text, planMode: false, wait: true, timeoutMs: 120_000 }, { ...h.ctx, signal: abort.signal, now: () => now });
    const settled = settledFlag(p);
    await ticks(10);
    now += 1_000;
    h.api.emit(busEvent("session.updated", { ...chatSummary({ refId: "codex" }), projectPath: h.projectPath }));
    await ticks(10);
    return { h, p, settled, abort };
  };
  for (const [text, status] of [["/goal pause", "paused"], ["/goal RESUME", "active"]] as const) {
    const { h, p, settled } = await run(text, status); t.after(h.close);
    assert.equal(settled(), true, `${text} on a ${status} goal: the host writes nothing, and the call does not sit out 15 s`);
    const r = await p;
    assert.equal(r.outcome, "goal"); assert.equal(r.answer, undefined); assert.ok(r.hint);
  }
  // The same pause on an active goal changes it: a second in, the call is still waiting for the host's row. (The
  // client going away ends that wait, as it ends every wait: no timer outlives the test.)
  const live = await run("/goal pause", "active"); t.after(live.h.close);
  assert.equal(live.settled(), false);
  live.abort.abort();
  assert.equal((await live.p).outcome, "goal");
});

test("goals §5.1: an answer is cut by bytes, and says so, so the result keeps its cap", async (t) => {
  // A status quoting a 4 000-character objective in three-byte characters, and a detail beside it.
  const huge = activity("goal.status", {}, { summary: `Goal: ${"語".repeat(20_000)}` });
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input), huge] })); t.after(h.close);
  const r = await tool("send_message").run({ sessionId: "c1", text: "/goal status", planMode: false, wait: true, timeoutMs: 120_000 }, h.ctx);
  assert.equal(r.outcome, "goal");
  assert.equal(r.answerTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r.answer), "utf8") - 2 <= 8_192);
  assert.ok((r.answer as string).startsWith("Goal: 語語"));
  assert.ok(resultBytes(r) <= 60_000);
});

test("goals §5.7: a deploy's hold row is no answer: /goal status settles on its own status row", async (t) => {
  // The host writes one `goal.status` row when it holds a goal for a deploy; it can land between the command and
  // its answer.
  const held = activity("goal.status", { heldForUpdate: true }, { summary: "Goal paused for an Orquester update. It resumes by itself once the agent host has restarted." });
  let phase = 1;
  const h = await goalHarness(snapshot(), (input) => snapshot({ items: [message("user", input), held, ...(phase === 2 ? [goalStatusRow()] : [])] })); t.after(h.close);
  let now = Date.parse("2026-09-22T12:00:00.000Z");
  const p = tool("send_message").run({ sessionId: "c1", text: "/goal status", planMode: false, wait: true, timeoutMs: 120_000 }, { ...h.ctx, now: () => now });
  const settled = settledFlag(p);
  await ticks(10);
  assert.equal(settled(), false, "the hold's row settled nothing");
  phase = 2;
  now += 200;
  h.api.emit(busEvent("session.updated", { ...chatSummary({ refId: "codex" }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "goal");
  assert.equal(r.answer, "Goal: Ship the parser (active, 2 rounds)");
});
