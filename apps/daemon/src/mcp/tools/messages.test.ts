import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { agentChatRoutes, buildPlanImplementationPrompt } from "@orquester/api/agent-chat";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { messageTools } from "./messages.ts";

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

const tool = (name: string) => messageTools.find((t) => t.name === name)!;
const done = (over = {}) => chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, ...over });

test("send_message posts the turn body, waits for the new turn and returns its reply", async (t) => {
  const h = await harness(); t.after(h.close);
  const after = snapshot({ turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })], items: [message("user", "hi", { turnId: "t2" }), message("assistant", "hello!", { turnId: "t2" })] });
  let posted = false;
  h.api.on("POST", "/api/sessions/c1/turn", ({ body }) => { posted = true; assert.deepEqual(body, { commandId: (body as { commandId: string }).commandId, input: "hi", interactionMode: "default" }); return { status: 200, body: { seq: 21 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => ({ status: 200, body: { kind: "snapshot", thread: posted ? { ...after, head: { ...after.head, projectPath: h.projectPath, cwd: h.projectPath } } : snapshot() } }));
  const p = tool("send_message").run({ sessionId: "c1", text: " hi ", planMode: false, wait: true, timeoutMs: 5_000 }, h.ctx);
  await new Promise((r) => setTimeout(r, 5));
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
  await new Promise((r) => setTimeout(r, 5));
  h.api.emit(busEvent("session.updated", { ...chatSummary({ chatSessionStatus: "running", hasPendingApprovals: true }), projectPath: h.projectPath }));
  const r = await p;
  assert.equal(r.outcome, "needs-input"); assert.equal((r.pending as { approvals: { requestId: string }[] }).approvals[0].requestId, "r1"); assert.equal(r.reply, undefined);
  const slow = await harness(); t.after(slow.close);
  slow.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 5 } });
  const to = await tool("send_message").run({ sessionId: "c1", text: "go", planMode: false, wait: true, timeoutMs: 20 }, slow.ctx);
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
  await new Promise((r) => setTimeout(r, 5));
  // One poll behind: the question just answered is still flagged, while the snapshot has no request open.
  publish(chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(reads() <= 3, `the stale flag is not re-checked in a loop (${reads()} snapshot reads)`);
  publish(done());
  const r = await p;
  assert.equal(r.outcome, "completed"); assert.equal(r.turnId, "t2"); assert.equal(r.reply, "done."); assert.equal(r.pending, undefined);
  assert.equal((r.session as { lastReply?: unknown }).lastReply, undefined, "the reply is returned once, as `reply`");
});

test("send_message: a wait on a flag the snapshot never confirms still ends — at the timeout, on a close, on an abort", async (t) => {
  const stale = async (timeoutMs: number, signal?: AbortSignal) => {
    const h = await harness(); t.after(h.close);
    // One poll behind from the start (right after answer_question): the list still flags a question the snapshot no longer has.
    h.api.on("GET", "/api/sessions", { status: 200, body: [{ ...chatSummary({ chatSessionStatus: "running", hasPendingUserInput: true, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } }), projectPath: h.projectPath, cwd: h.projectPath }] });
    h.api.on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 40 } });
    return { api: h.api, run: tool("send_message").run({ sessionId: "c1", text: "go on", planMode: false, wait: true, timeoutMs }, signal ? { ...h.ctx, signal } : h.ctx) };
  };
  const late = await stale(60);
  assert.equal((await late.run).outcome, "timeout", "an unconfirmed flag is not an outcome");
  const gone = await stale(5_000);
  await new Promise((r) => setTimeout(r, 10));
  gone.api.emit(busEvent("session.closed", { id: "c1" }));
  await assert.rejects(gone.run, (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  const ac = new AbortController();
  const dropped = await stale(5_000, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  const abortedAt = performance.now();
  ac.abort();
  assert.equal((await dropped.run).outcome, "timeout");
  assert.ok(performance.now() - abortedAt < 1_000, "the abort ends the wait at once");
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
