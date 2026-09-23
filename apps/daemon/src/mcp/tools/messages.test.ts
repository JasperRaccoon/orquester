import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { agentChatRoutes, buildPlanImplementationPrompt, encodeHistoryCursor, type ThreadItem, type ThreadSnapshotPayload, type Turn } from "@orquester/api/agent-chat";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "../result.ts";
import { HISTORY_PAGES_PER_READ } from "../history.ts";
import { TRANSCRIPT_HINT_BYTES } from "../transcript.ts";
import { messageTools, transcriptHint } from "./messages.ts";

// The fake routes every test shares, copied from sessions.test.ts (the two files never import each other's helpers).
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } }
] };
const providers = { hostInstanceId: "h", providers: [{ id: "claude", refIds: ["claude", "claudex"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [],
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
  models: [{ slug: "default", name: "Default", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] } }, { slug: "haiku", name: "Haiku", capabilities: null }] }] };
const accounts = { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }, { id: "acc-2", agent: "codex", label: "e@x.io", email: "e@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };
const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [{ id: "acc-2", provider: "codex", label: "e@x.io" }], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };

async function harness(sessions = [chatSummary(), shellSummary()], snap = snapshot()) {
  const root = await mkdtemp(join(tmpdir(), "mcp-msg-"));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  const projectPath = join(root, "acme", "api");
  const fix = (s: ReturnType<typeof chatSummary>) => ({ ...s, projectPath, cwd: projectPath });
  api.on("GET", "/api/sessions", { status: 200, body: sessions.map(fix) })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, projectPath, cwd: projectPath } } } })
    .on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts }).on("GET", "/api/cliproxy", { status: 200, body: cliproxy }).on("GET", "/api/cliproxy/models", { status: 200, body: { models: [], asOf: null } });
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
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { posted = true; assert.deepEqual(body, { commandId: (body as { commandId: string }).commandId, input: "hi", interactionMode: "default" }); return { status: 200, body: { seq: 21 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: posted ? { ...after, head: { ...after.head, projectPath: h.projectPath, cwd: h.projectPath } } : snapshot() } }));
  const p = tool("send_message").run({ sessionId: "c1", text: " hi ", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...done(), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.seq, 21); assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "hello!"); assert.equal(r.pending, undefined);
});

test("send_message without wait returns sent; attachments are uploaded first and referenced", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { const b = body as { attachments: { id: string }[]; input: string }; assert.equal(b.attachments.length, 1); assert.equal(b.input, "see"); return { status: 200, body: { seq: 3 } }; });
  const r = await tool("send_message").run({ sessionId: "c1", text: "see", attachments: [{ name: "a.png", base64: Buffer.from("png").toString("base64") }], planMode: false, wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent"); assert.equal(h.api.uploads.length, 1); assert.equal(h.api.uploads[0].meta.type, "image/png");
});

test("send_message refusals: empty, pending request, error state, plan mode unsupported", async (t) => {
  const h = await harness(); t.after(h.close);
  const run = (a: Record<string, unknown>, ctx = h.ctx) => tool("send_message").run({ planMode: false, wait: false, timeoutMs: 1000, ...a }, ctx);
  await assert.rejects(run({ sessionId: "c1", text: "  " }), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  const pending = await harness([chatSummary({ hasPendingUserInput: true })], snapshot({ pending: { approvals: [], userInputs: [{ requestId: "q1", createdAt: stamp(1), dismissible: false, questions: [{ id: "x", header: "H", question: "X?", options: [], multiSelect: false, allowCustomAnswer: true }] }] } })); t.after(pending.close);
  await assert.rejects(run({ sessionId: "c1", text: "hi" }, pending.ctx), (e: { code: string; detail: { questions: string[] } }) => e.code === "PENDING_REQUEST" && e.detail.questions[0] === "q1");
  const err = await harness([chatSummary({ chatSessionStatus: "error" })]); t.after(err.close);
  await assert.rejects(run({ sessionId: "c1", text: "hi" }, err.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && /stop_session/.test(e.message));
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
  const to = await tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 20 }, { ...slow.ctx, now: racing() });
  assert.equal(to.outcome, "timeout");
});

test("implement_plan sends the prefixed plan in default mode; refuses without an actionable plan", async (t) => {
  const planned = snapshot({ items: [activity("turn.proposed.completed", { planId: "p1", planMarkdown: "  # Plan\n1. do  " })] });
  const h = await harness([chatSummary({ hasActionableProposedPlan: true })], planned); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { assert.deepEqual(body, { commandId: (body as { commandId: string }).commandId, input: "PLEASE IMPLEMENT THIS PLAN:\n# Plan\n1. do", interactionMode: "default" }); return { status: 200, body: { seq: 6 } }; });
  const r = await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent");
  const none = await harness(); t.after(none.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, none.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("read_transcript projects the snapshot with defaults and validates agentId", async (t) => {
  const snap = snapshot({ items: [message("user", "hi"), message("reasoning", "hmm"), message("assistant", "yo")], roster: [{ id: "task-1", kind: "subagent", agentKind: "agent", title: "Explore", status: "completed" } as never] });
  const h = await harness([chatSummary()], snap); t.after(h.close);
  const r = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 40_000 }, h.ctx);
  assert.deepEqual((r.entries as { kind: string }[]).map((e) => e.kind), ["user", "assistant"]);
  assert.deepEqual(r.subagents, [{ id: "task-1", title: "Explore", status: "completed" }]);
  const withReasoning = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["reasoning"], maxChars: 40_000 }, h.ctx);
  assert.equal((withReasoning.entries as unknown[]).length, 3);
  await assert.rejects(tool("read_transcript").run({ sessionId: "c1", turns: 3, agentId: "nope", include: [], maxChars: 40_000 }, h.ctx), (e: { message: string }) => /task-1/.test(e.message));
});

// ---- Beyond the brief: the Task 9 rulings, and the spec points (§7.4, §7.6) its code left out. ----

test("implement_plan sends the FULL plan: a plan slimmed on the wire is read back unslimmed, never sent cut", async (t) => {
  const full = `# Plan\n${"1. a step long enough to matter\n".repeat(700)}`; // ~22 KB: over the 16 KiB wire cap
  const plan = activity("turn.proposed.completed", { planId: "p1", planMarkdown: `${full.slice(0, 1_000)}…`, truncated: true });
  const itemPath = agentChatRoutes.item("c1", plan.id);
  const h = await harness([chatSummary({ hasActionableProposedPlan: true })], snapshot({ items: [plan] })); t.after(h.close);
  h.api.on("GET", itemPath, { status: 200, body: { item: { ...plan, payload: { planId: "p1", planMarkdown: full } } } });
  let input = "";
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { input = (body as { input: string }).input; return { status: 200, body: { seq: 7 } }; });
  assert.equal((await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx)).outcome, "sent");
  assert.ok(h.api.calls.some((c) => c.method === "GET" && c.path === itemPath), "the full row was read");
  assert.equal(input, buildPlanImplementationPrompt(full));
  // No full copy to be had: refused, rather than having the agent implement a cut plan.
  const gone = await harness([chatSummary({ hasActionableProposedPlan: true })], snapshot({ items: [plan] })); t.after(gone.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, gone.ctx), (e: { code: string }) => e.code === "NOT_FOUND");
  assert.ok(!gone.api.calls.some((c) => c.method === "POST"), "nothing was sent");
});

test("implement_plan judges the plan on the fresh snapshot (the host's rule), not on the summary one poll behind", async (t) => {
  const plan = activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# Plan" });
  // Already implemented, the summary not caught up yet: a second call must not send the plan twice.
  const implemented = snapshot({ items: [plan, message("user", buildPlanImplementationPrompt("# Plan"), { turnId: "t2" })] });
  const twice = await harness([chatSummary({ hasActionableProposedPlan: true })], implemented); t.after(twice.close);
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, twice.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /already/.test(e.message));
  assert.ok(!twice.api.calls.some((c) => c.method === "POST"), "nothing was sent");
  // Just proposed: the snapshot has the plan before the summary flags it.
  const fresh = await harness([chatSummary({ hasActionableProposedPlan: false })], snapshot({ items: [plan] })); t.after(fresh.close);
  fresh.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 8 } });
  assert.equal((await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, fresh.ctx)).outcome, "sent");
  assert.ok(!fresh.api.calls.some((c) => c.path.includes("/items/")), "a plan that was not slimmed needs no read-back");
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
  const reads = () => h.api.calls.filter((c) => c.path === "/api/sessions/c1/thread").length;
  const p = tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  const settled = settledFlag(p);
  await tick();
  // One poll behind: the question just answered is still flagged, while the snapshot has no request open.
  publish(chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }));
  await ticks(10);
  assert.ok(reads() <= 3, `the stale flag is not re-checked in a loop (${reads()} snapshot reads)`);
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
  assert.deepEqual([late, gone, dropped].map((s) => s.api.listenerCount()), [0, 0, 0], "every bus listener is removed");
});

test("send_message into a running turn steers it, and turnId names that turn", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const live = snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [turn(), turn({ turnId: "t2", state: "running", turnCount: null, requestedAt: stamp(2), startedAt: stamp(2), completedAt: null })] });
  const h = await harness([running], live); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 9 } });
  const r = await tool("send_message").run({ sessionId: "c1", text: "also cover the edge case", planMode: false, wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent"); assert.equal(r.turnId, "t2");
  // A new turn has no id until the provider starts it.
  const idle = await harness(); t.after(idle.close);
  idle.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 10 } });
  assert.equal((await tool("send_message").run({ sessionId: "c1", text: "next", planMode: false, wait: false, timeoutMs: 1000 }, idle.ctx)).turnId, undefined);
});

test("send_message: PENDING_REQUEST names each open request and the tool that settles it", async (t) => {
  const open = snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [{ requestId: "q1", createdAt: stamp(6), dismissible: false, questions: [] }] } });
  const h = await harness([chatSummary({ hasPendingApprovals: true, hasPendingUserInput: true })], open); t.after(h.close);
  await assert.rejects(tool("send_message").run({ sessionId: "c1", text: "hi", planMode: false, wait: false, timeoutMs: 1000 }, h.ctx),
    (e: { code: string; message: string }) => e.code === "PENDING_REQUEST" && /r1/.test(e.message) && /q1/.test(e.message) && /resolve_approval/.test(e.message) && /answer_question/.test(e.message));
});

test("read_transcript: maxChars is at most 55 000 (results are capped at 60 000 bytes); a shed result says how to get more", async (t) => {
  const schema = z.object(tool("read_transcript").input);
  assert.equal(schema.parse({ sessionId: "c1" }).maxChars, 40_000);
  assert.equal(schema.safeParse({ sessionId: "c1", maxChars: 55_000 }).success, true);
  assert.equal(schema.safeParse({ sessionId: "c1", maxChars: 55_001 }).success, false);
  const h = await harness([chatSummary()], snapshot({ items: [message("user", "x".repeat(3_000)), message("assistant", "ok")] })); t.after(h.close);
  const cut = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 2_000 }, h.ctx);
  assert.equal(cut.truncated, true); assert.match(String(cut.hint), /maxChars/);
  const whole = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 40_000 }, h.ctx);
  assert.equal(whole.truncated, false); assert.equal(whole.hint, undefined);
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

test("send_message with wait into a running turn: the steered turn's reply and id are this message's", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const live = snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }), turns: [turn(), turn({ turnId: "t2", turnCount: null, state: "running", requestedAt: stamp(2), startedAt: stamp(2), completedAt: null })], items: [message("assistant", "OLD (t1)")] });
  const h = await harness([running], live); t.after(h.close);
  const answered = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("assistant", "OLD (t1)"), message("assistant", "steered answer", { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", () => { posted = true; return { status: 200, body: { seq: 63 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: { ...(posted ? answered : live), head: { ...(posted ? answered : live).head, projectPath: h.projectPath, cwd: h.projectPath } } } }));
  const p = tool("send_message").run({ sessionId: "c1", text: "also cover the edge case", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await tick();
  h.api.emit(busEvent("session.updated", { ...done(), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "steered answer");
});

test("send_message refusals upload nothing; plan mode needs a known capability; an errored session points at stop_session only", async (t) => {
  const png = [{ name: "a.png", base64: Buffer.from("png").toString("base64") }];
  const run = (ctx: ToolContext, a: Record<string, unknown> = {}) => tool("send_message").run({ sessionId: "c1", text: "hi", attachments: png, planMode: false, wait: false, timeoutMs: 1000, ...a }, ctx);
  const pending = await harness([chatSummary({ hasPendingApprovals: true })], snapshot({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5) }], userInputs: [] } })); t.after(pending.close);
  await assert.rejects(run(pending.ctx), (e: { code: string }) => e.code === "PENDING_REQUEST");
  const err = await harness([chatSummary({ chatSessionStatus: "error" })]); t.after(err.close);
  await assert.rejects(run(err.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && /stop_session/.test(e.message) && !/revert_session/.test(e.message));
  // The provider list could not be read: get_session reports supports.planMode false, and the gate agrees.
  const blind = await harness(); t.after(blind.close);
  blind.api.on("GET", "/api/agent/providers", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting." } } });
  await assert.rejects(run(blind.ctx, { planMode: true }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /plan mode/i.test(e.message));
  for (const h of [pending, err, blind]) {
    assert.equal(h.api.uploads.length, 0, "nothing was uploaded");
    assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was posted");
  }
});

// ---- Final wave C1: the timed stale re-check, the summary half of "over", a stamped running turn, a lagging list. ----

test("send_message: with no bus event at all, a needs-input the snapshot contradicts is looked at again after 2 s, never sooner", async (t) => {
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
  const reads = () => h.api.calls.filter((c) => c.path === "/api/sessions/c1/thread").length;
  const parked = reads();
  // t2 settles, but the event that says so is lost: only the timed re-check can notice.
  listed = { ...done(), ...where };
  hostSettled = true;
  clock += 1_999; t.mock.timers.tick(1_999);
  await ticks(10);
  assert.equal(settled(), false, "not before 2 s");
  assert.equal(reads(), parked, "no re-read while parked");
  clock += 1; t.mock.timers.tick(1);
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

test("read_transcript: maxChars is described as the byte budget it is, and a trimmed subagent list says where the rest is", () => {
  // Since the second roster pass (transcript.ts), the list keeps its quarter AND whatever the entries leave unused.
  assert.equal(tool("read_transcript").input.maxChars.description, "Size budget for the result, in UTF-8 bytes (max 55000; every tool result is capped at 60000 bytes). Over it, the transcript sheds reasoning, then tool detail, then its oldest rows, and cuts the latest reply last; the subagent list keeps at least a quarter when it needs it, plus whatever the transcript leaves unused.");
  assert.equal(transcriptHint({ truncated: false }), undefined);
  const shed = transcriptHint({ truncated: true })!;
  // The shed goes by row (transcript.ts `fitEntries`), the oldest turn's first: coveredTurns then names the turns left.
  assert.equal(shed, "Shed to fit maxChars: reasoning, then tool detail, then the oldest rows (coveredTurns says which turns are left). Raise maxChars (max 55000), include less, or use get_turn_diff for one turn's file changes.");
  assert.equal(transcriptHint({ truncated: true, subagentsTruncated: false }), shed);
  // get_session sheds subagent rows too when its detail passes the cap: the hint must not promise the whole roster.
  assert.equal(transcriptHint({ truncated: true, subagentsTruncated: true }), `${shed} The subagent list was trimmed too; get_session may list more of it.`);
});

test("read_transcript's hint, suffix included, fits the room transcript.ts keeps for it", () => {
  const hint = transcriptHint({ truncated: true, subagentsTruncated: true })!;
  const bytes = Buffer.byteLength(JSON.stringify({ hint }), "utf8");
  // A shed result stays TRANSCRIPT_HINT_BYTES under maxChars for this field (key, quotes and comma included).
  assert.ok(bytes <= TRANSCRIPT_HINT_BYTES, `${bytes} bytes, room ${TRANSCRIPT_HINT_BYTES}`);
});

test("read_transcript: every shed result says truncated:true, so it carries the hint — a trimmed subagent list alone included — and the answer, hint and all, fits maxChars", async (t) => {
  const agent = (i: number) => ({ id: `task-${i}`, kind: "subagent", agentKind: "agent", title: `Survey package ${i}: list its exports, callers and test coverage`, status: i % 3 ? "completed" : "running", firstSeenAt: stamp(i) }) as never;
  const roster = Array.from({ length: 40 }, (_, i) => agent(i)); // ~4.5 KB of subagent list
  const shapes = {
    "a long roster beside a short turn": snapshot({ items: [message("user", "Survey the packages, one subagent each.", { turnId: "t1" }), message("assistant", "Done: every package is surveyed.", { turnId: "t1" })], roster }),
    "a long turn, no roster": snapshot({ items: [message("user", "x".repeat(3_000), { turnId: "t1" }), message("assistant", "ok", { turnId: "t1" })] }),
    "both long": snapshot({ items: [message("user", "y".repeat(6_000), { turnId: "t1" }), message("assistant", "z".repeat(6_000), { turnId: "t1" })], roster })
  };
  for (const [shape, snap] of Object.entries(shapes)) {
    const h = await harness([chatSummary()], snap); t.after(h.close);
    const read = (maxChars: number) => tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars }, h.ctx);
    const whole = await read(55_000);
    assert.equal(whole.truncated, false, `${shape}: whole at 55 000`);
    for (const maxChars of [2_000, 3_000, 5_000, 9_000, 20_000]) {
      const r = await read(maxChars);
      const where = `${shape} at maxChars ${maxChars}`;
      const shed = JSON.stringify(r.entries) !== JSON.stringify(whole.entries) || JSON.stringify(r.subagents) !== JSON.stringify(whole.subagents);
      assert.equal(r.truncated, shed, `${where}: truncated says whether anything was shed`);
      if (r.subagentsTruncated) assert.equal(r.truncated, true, `${where}: a trimmed subagent list is a shed result`);
      assert.equal(r.hint, transcriptHint({ truncated: r.truncated as boolean, subagentsTruncated: r.subagentsTruncated as boolean | undefined }), `${where}: the hint follows the flags`);
      const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
      assert.ok(bytes <= maxChars, `${where}: ${bytes} bytes, hint included`);
    }
  }
  // The case the hint could miss: only the subagent list was trimmed, the transcript is whole.
  const h = await harness([chatSummary()], shapes["a long roster beside a short turn"]); t.after(h.close);
  const r = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 2_000 }, h.ctx);
  assert.deepEqual((r.entries as { text: string }[]).map((e) => e.text), ["Survey the packages, one subagent each.", "Done: every package is surveyed."], "the transcript is whole");
  assert.deepEqual([r.truncated, r.subagentsTruncated], [true, true], "only the roster was trimmed, and the result still says truncated");
  assert.match(String(r.hint), /trimmed too; get_session may list more of it\.$/);
});

test("read_transcript's description says a list cut to fit ends in a marker counting the rest, and the tool's rows do", async (t) => {
  const description = tool("read_transcript").description;
  assert.equal(description, "What was said and done in a session, newest turns last: messages, tool calls, approvals, questions, plans, file changes, errors. `beforeTurn` reads older turns; `agentId` drills into a subagent. A list cut to fit (a checkpoint's files, a tool's changedFiles, a message's attachments) ends in a marker counting the rest (\"…12 more files\"; a files marker has their real line totals), not a real entry.");
  assert.ok(description.length <= 400, `${description.length} characters`);
  // A checkpoint of 1 500 files at the smallest budget, the turn's newest row (no reply yet, so it is the row a shed
  // spares and cuts last): its files are a head, then the marker the description names.
  const files = Array.from({ length: 1_500 }, (_, i) => ({ path: `src/generated/table_${i}.ts`, additions: (i % 7) + 1, deletions: i % 3 }));
  const items = [message("user", "Regenerate the schema.", { turnId: "t1" })];
  const cp = { turnId: "t1", checkpointTurnCount: 1, checkpointRef: "refs/t1", status: "ready", files, assistantMessageId: null, completedAt: stamp(9_999) };
  const h = await harness([chatSummary()], snapshot({ items, checkpoints: [cp] as never })); t.after(h.close);
  const r = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 2_000 }, h.ctx);
  const changes = (r.entries as { kind: string; files?: typeof files }[]).find((e) => e.kind === "changes")?.files;
  assert.ok(changes && changes.length < files.length, "the checkpoint row, its files cut");
  const rest = files.slice(changes.length - 1);
  const total = (key: "additions" | "deletions") => rest.reduce((n, f) => n + f[key], 0);
  assert.deepEqual(changes.at(-1), { path: `…${rest.length} more files`, additions: total("additions"), deletions: total("deletions") }, "the marker: the rest counted, with their real line totals");
});

test("send_message planMode on a degraded 200 providers body: the capability could not be read, and the refusal says so", async (t) => {
  const run = (ctx: ToolContext) => tool("send_message").run({ sessionId: "c1", text: "plan it", planMode: true, wait: false, timeoutMs: 1000 }, ctx);
  const refused = "Plan mode can't be confirmed for claude right now: its capabilities could not be read. Retry shortly, or send without planMode.";
  const claudeRow = { id: "claude", refIds: ["claude", "claudex"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], models: [] };
  // An older host's degraded rows: capabilities a string, or null; a null row beside it; a body with no list at all.
  for (const body of [
    { hostInstanceId: "h", providers: [{ ...claudeRow, capabilities: "plan" }] },
    { hostInstanceId: "h", providers: [null, { ...claudeRow, capabilities: null }] },
    { hostInstanceId: "h", providers: "claude" }
  ]) {
    const h = await harness(); t.after(h.close);
    h.api.on("GET", "/api/agent/providers", { status: 200, body });
    await assert.rejects(run(h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === refused, JSON.stringify(body));
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

test("implement_plan {wait:false}: the plan it just sent reads as no longer actionable — in the detail as in the transcript — though the summary still flags it", async (t) => {
  const plan = activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# Plan" });
  const before = snapshot({ items: [plan] });
  const after = snapshot({ items: [plan, message("user", buildPlanImplementationPrompt("# Plan"), { turnId: "t2" })] });
  // The summary is served unchanged throughout: one host poll behind, it still flags the plan.
  const h = await harness([chatSummary({ hasActionableProposedPlan: true })], before); t.after(h.close);
  threadAfterPost(h, before, after, 9);
  const r = await tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx);
  assert.equal(r.outcome, "sent");
  assert.equal((r.session as { plan?: { planId: string; actionable: boolean } }).plan?.actionable, false);
  const transcript = await tool("read_transcript").run({ sessionId: "c1", turns: 3, include: ["tools", "activity"], maxChars: 40_000 }, h.ctx);
  assert.deepEqual((transcript.entries as { kind: string; actionable?: boolean }[]).filter((e) => e.kind === "plan").map((e) => e.actionable), [false]);
  // And the check itself agrees: a second call is refused, the plan is not sent twice.
  await assert.rejects(tool("implement_plan").run({ sessionId: "c1", wait: false, timeoutMs: 1000 }, h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /already/.test(e.message));
  assert.equal(h.api.calls.filter((c) => c.method === "POST").length, 1);
});

test("read_transcript refuses an empty agentId rather than answering the main view", async (t) => {
  const input = tool("read_transcript").input as Record<string, { safeParse(v: unknown): { success: boolean } }>;
  assert.equal(input.agentId!.safeParse("").success, false, "the schema refuses it");
  const h = await harness([chatSummary()], snapshot({ items: [message("user", "hi"), message("assistant", "yo")] })); t.after(h.close);
  // run() on its own refuses it too: "" names no subagent.
  await assert.rejects(tool("read_transcript").run({ sessionId: "c1", turns: 3, agentId: "", include: [], maxChars: 40_000 }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message.startsWith("No subagent \"\"."));
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
  assert.ok(resultBytes(r) <= MAX_RESULT_BYTES, `${resultBytes(r)} bytes`);
  assert.deepEqual(r.pending, session.pending, "the request, whole, in both places");
  assert.equal((session.pending as { approvals: { detail: string }[] }).approvals[0]?.detail, command);
  assert.equal(session.lastReply?.text, reply, "the reply stays whole");
  assert.equal(session.subagentsTruncated, true);
  // Settled rows go oldest first; and no more than needed: the newest one dropped would not have fitted. Every kept
  // row has the same size as it (ids of two digits, texts capped to the same 200 code points).
  const ids = roster.map((row) => (row as { id: string }).id);
  const kept = session.subagents.map((s) => s.id);
  assert.deepEqual(kept, ids.slice(ids.length - kept.length));
  assert.ok(kept.length > 10 && kept.length < 80, `${kept.length} rows kept`);
  assert.ok(resultBytes(r) + resultBytes(session.subagents[0]) + 1 > MAX_RESULT_BYTES, "no more was shed than needed");
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
  assert.ok(resultBytes(r) <= MAX_RESULT_BYTES, `${resultBytes(r)} bytes`);
  assert.deepEqual(ok(r).structuredContent, r, "never cut by ok()'s last resort");
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

test("read_transcript pages older turns from the host's index: a 3-turn window over a 10-turn thread, turns 5, reads turns 6 to 10", async (t) => {
  const th = history(10, 8);
  const h = await harness([chatSummary()], th.snap); t.after(h.close);
  // The page ends at the window's boundary, inside turn 8, and its soft cap reaches turn 5, one below the range: it
  // begins inside turn 5, so turn 6 is whole.
  h.api.on("GET", agentChatRoutes.history("c1"), ({ query }) => { assert.deepEqual(query, { turns: "4" }); return th.page(th.rowsOf(5, 7), th.cursorIn(5)); });
  const r = await tool("read_transcript").run(readArgs({ turns: 5 }), h.ctx);
  assert.deepEqual((r.entries as { turn: number; text: string }[]).map((e) => [e.turn, e.text]), [6, 7, 8, 9, 10].flatMap((n) => [[n, `ask ${n}`], [n, `reply ${n}`]]), "turns 6 and 7 from the page, 8 to 10 from the window; turn 5 left out");
  assert.deepEqual([r.turnCount, r.olderTurns, r.coveredTurns, r.truncated], [10, 5, [6, 10], false]);
  assert.equal("unavailableTurns" in r, false); assert.equal(r.hint, undefined);
  assert.equal(historyCalls(h).length, 1);
  // A range after the window's oldest turn (8, which may be partial) is the window's alone: nothing is read.
  const latest = await tool("read_transcript").run(readArgs({ turns: 2 }), h.ctx);
  assert.deepEqual([latest.olderTurns, latest.coveredTurns], [8, [9, 10]]);
  assert.equal(historyCalls(h).length, 1, "no page for a range the window holds");
});

test("read_transcript: beforeTurn past turnCount + 1 is refused naming the range, one below 2 by the schema — before any page is read", async (t) => {
  const input = z.object(tool("read_transcript").input);
  for (const beforeTurn of [1, 0, -3, 2.5]) assert.equal(input.safeParse({ sessionId: "c1", beforeTurn }).success, false, `beforeTurn ${beforeTurn}`);
  assert.equal(input.safeParse({ sessionId: "c1", beforeTurn: 2 }).success, true);
  const refused = async (n: number, beforeTurn: number, message: string) => {
    const h = await harness([chatSummary()], history(n, 1).snap); t.after(h.close);
    await assert.rejects(tool("read_transcript").run(readArgs({ beforeTurn }), h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === message);
    assert.equal(historyCalls(h).length, 0);
  };
  await refused(10, 12, "beforeTurn must be between 2 and 11: this conversation has 10 started turns.");
  await refused(1, 3, "beforeTurn must be 2: this conversation has 1 started turn.");
  await refused(0, 2, "This conversation has no started turn yet, so there is no turn to read before: leave beforeTurn out.");
  // turnCount + 1 is the latest turns, as without it.
  const h = await harness([chatSummary()], history(10, 1).snap); t.after(h.close);
  const r = await tool("read_transcript").run(readArgs({ beforeTurn: 11, turns: 2 }), h.ctx);
  assert.deepEqual([r.olderTurns, r.coveredTurns], [8, [9, 10]]);
});

test("read_transcript: beforeTurn below the window asks for the page that ends where turn beforeTurn begins; olderTurns says how far back to go", async (t) => {
  const th = history(10, 8);
  const h = await harness([chatSummary()], th.snap); t.after(h.close);
  h.api.on("GET", agentChatRoutes.history("c1"), ({ query }) => {
    assert.equal(query!.turns, "3", "turns 4 down to 2, one below the range");
    return th.page(th.rowsOf(3, 4), th.cursorIn(2));
  });
  const r = await tool("read_transcript").run(readArgs({ beforeTurn: 5, turns: 2 }), h.ctx);
  assert.deepEqual((r.entries as { text: string }[]).map((e) => e.text), ["ask 3", "reply 3", "ask 4", "reply 4"]);
  assert.deepEqual([r.olderTurns, r.coveredTurns, r.hint], [2, [3, 4], undefined], "two turns older: beforeTurn 3 reads them");
});

test("read_transcript: turns it could not read whole are named with a hint, never an error — the index unavailable, or the page limit", async (t) => {
  const th = history(10, 8);
  const h = await harness([chatSummary()], th.snap); t.after(h.close);
  h.api.on("GET", agentChatRoutes.history("c1"), { status: 503, body: { error: { code: "INDEX_UNAVAILABLE", message: "Older history is not available on this host right now." } } });
  const r = await tool("read_transcript").run(readArgs({ turns: 5 }), h.ctx);
  assert.deepEqual((r.entries as { turn: number }[]).map((e) => e.turn), [8, 8, 9, 9, 10, 10], "the window's rows are still served");
  assert.deepEqual([r.olderTurns, r.coveredTurns, r.unavailableTurns, r.truncated], [5, [8, 10], [6, 8], false]);
  assert.equal(r.hint, "Turns 6–8 could not be read whole: older turns are unavailable on this host right now. Try again later.");
  // The page limit: every page reaches one turn further back, and five do not reach turn 1.
  let k = 8;
  h.api.on("GET", agentChatRoutes.history("c1"), () => { k -= 1; return th.page(th.rowsOf(k, k), th.cursorIn(k)); });
  const limited = await tool("read_transcript").run(readArgs({ turns: 10 }), h.ctx);
  assert.equal(historyCalls(h).length, 1 + HISTORY_PAGES_PER_READ);
  assert.deepEqual([limited.olderTurns, limited.coveredTurns, limited.unavailableTurns], [0, [3, 10], [1, 3]]);
  assert.equal(limited.hint, `Turns 1–3 could not be read whole: one call reads at most ${HISTORY_PAGES_PER_READ} pages of older history. Read them with beforeTurn: 4, turns: 3.`);
});

test("read_transcript while the host's index has not caught up with the thread: the turns up to the window's oldest are named, and a turn larger than one call says so", async (t) => {
  const th = history(10, 8);
  // The window's rows: a tool call in each of its turns, where the window's oldest activity row says it begins.
  const call = (n: number) => activity("tool.completed", { itemType: "command_execution", toolUseId: `call-${n}`, title: "pnpm test", status: "completed" }, { turnId: `t${n}`, tone: "tool", createdAt: th.rowsOf(n, n)[0]!.createdAt });
  const fresh = snapshot({ ...th.snap, items: [call(8), ...th.snap.items, call(9), call(10)], history: { indexed: true, hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 0 } });
  const h = await harness([chatSummary()], fresh); t.after(h.close);
  const r = await tool("read_transcript").run(readArgs({ turns: 5 }), h.ctx);
  assert.equal(historyCalls(h).length, 0, "nothing to page yet");
  assert.deepEqual([r.olderTurns, r.coveredTurns, r.unavailableTurns], [5, [8, 10], [6, 8]]);
  assert.equal(r.hint, "Turns 6–8 could not be read whole: older turns are unavailable on this host right now. Try again later.");
  // Caught up, with turn 7 more than five pages long: each page ends a little further inside it.
  const h2 = await harness([chatSummary()], th.snap); t.after(h2.close);
  let seq = 100;
  h2.api.on("GET", agentChatRoutes.history("c1"), () => th.page([], encodeHistoryCursor({ threadId: "c1", beforeAnchorAt: th.snap.turns[6]!.requestedAt, beforeTurnId: "t7", beforeSeq: (seq -= 10) })));
  const large = await tool("read_transcript").run(readArgs({ beforeTurn: 8, turns: 3 }), h2.ctx);
  assert.equal(historyCalls(h2).length, HISTORY_PAGES_PER_READ);
  assert.deepEqual([large.unavailableTurns, large.olderTurns], [[5, 7], 4]);
  assert.equal(large.hint, `Turn 7 is larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned. Read turns 5–6 with beforeTurn: 7, turns: 2.`);
});

test("read_transcript: with turns named unavailable, the answer — its hint, and the shed hint after it — still fits maxChars", async (t) => {
  const th = history(10, 8);
  const long = snapshot({ ...th.snap, items: [...th.snap.items, message("assistant", "z".repeat(12_000), { turnId: "t10" })] });
  const h = await harness([chatSummary()], long); t.after(h.close);
  h.api.on("GET", agentChatRoutes.history("c1"), { status: 503, body: { error: { code: "INDEX_UNAVAILABLE", message: "rebuilding" } } });
  const sentence = "Turns 6–8 could not be read whole: older turns are unavailable on this host right now. Try again later.";
  for (const maxChars of [2_000, 3_000, 5_000, 9_000, 12_300, 20_000]) {
    const r = await tool("read_transcript").run(readArgs({ turns: 5, maxChars }), h.ctx);
    const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
    assert.ok(bytes <= maxChars, `maxChars ${maxChars}: ${bytes} bytes, hint included`);
    assert.deepEqual(r.unavailableTurns, [6, 8], `maxChars ${maxChars}`);
    assert.equal(r.hint, r.truncated ? `${sentence} ${transcriptHint({ truncated: true, subagentsTruncated: r.subagentsTruncated as boolean | undefined })}` : sentence, `maxChars ${maxChars}: the sentence first`);
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
