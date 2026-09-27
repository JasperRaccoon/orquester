import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt, type AgentGoalStatus } from "@orquester/api/agent-chat";
import { resolveChatActivity } from "../agent-chat/activity-ladder.ts";
import { FakeDaemonApi } from "./testing.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "./result.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "./fixtures.ts";
import { buildViewContext, chatDetail, lastReply, optionsObject, pendingApprovalViews, pendingQuestionViews, planView, SESSION_DETAIL_BYTES, sessionDetail, sessionReason, sessionView, type SessionDetail, type ViewContext } from "./views.ts";

const ctx: ViewContext = { workspacesDir: "/w", adapterByRefId: new Map([["claude", "claude"], ["codex", "codex"]]), accountLabelById: new Map([["acc-1", "jasperclaude"]]),
  capabilitiesByAdapter: new Map([["claude", { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" }, supportsBackgroundTasks: true }]]) };

test("sessionReason: every ladder rung, plus new and exited", () => {
  assert.equal(sessionReason(chatSummary({ hasPendingApprovals: true })), "approval");
  assert.equal(sessionReason(chatSummary({ hasPendingUserInput: true })), "question");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "error" })), "error");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "starting" })), "starting");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } })), "running");
  assert.equal(sessionReason(chatSummary({ hasActionableProposedPlan: true })), "plan-ready");
  assert.equal(sessionReason(chatSummary({ backgroundLiveness: "working" })), "background-working");
  assert.equal(sessionReason(chatSummary({ backgroundLiveness: "monitoring" })), "monitoring");
  assert.equal(sessionReason(chatSummary({ goal: { objective: "Migrate the parser", status: "active", continuing: true } })), "goal-continuing");
  assert.equal(sessionReason(chatSummary()), "completed");
  assert.equal(sessionReason(chatSummary({ chatSessionStatus: "idle", latestTurn: null })), "new");
  assert.equal(sessionReason(shellSummary({ status: "exited", exitCode: 0 })), "exited");
  assert.equal(sessionReason(shellSummary()), null);
});

test("sessionView projects a chat summary and a terminal summary", () => {
  const chat = sessionView(chatSummary({ accountId: "acc-1" }), ctx);
  assert.equal(chat.kind, "chat"); assert.equal(chat.adapter, "claude"); assert.equal(chat.agent, "claude");
  assert.deepEqual(chat.project, { workspace: "acme", name: "api", path: "/w/acme/api" });
  assert.equal(chat.status, "idle"); assert.equal(chat.attention, "finished"); assert.equal(chat.needsAttentionAt, stamp(1)); assert.equal(chat.reason, "completed");
  assert.deepEqual(chat.chat, { sessionStatus: "ready", accountId: "acc-1", latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(0), completedAt: stamp(1) }, pending: { approvals: false, questions: false }, planReady: false, backgroundLiveness: null, goal: null });
  assert.equal(chat.terminal, undefined);
  const system = sessionView(chatSummary(), ctx);
  assert.equal(system.chat?.accountId, "system");
  const term = sessionView(shellSummary({ kind: "agent", status: "exited", exitCode: 1 }), ctx);
  assert.equal(term.kind, "terminal"); assert.deepEqual(term.terminal, { status: "exited", exitCode: 1, legacyAgent: true }); assert.equal(term.chat, undefined);
});

test("sessionDetail merges the head, context window, pending requests, plan, roster and last reply", () => {
  const snap = snapshot({
    head: head({ accountId: "acc-1", home: "account", session: { status: "ready", activeTurnId: null, lastError: "boom" }, turnCount: 2, continueAfterRestart: { turnId: "t1" } }),
    turns: [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) })],
    items: [
      message("user", "hi", { turnId: "t1" }), message("assistant", "first", { turnId: "t1" }),
      message("user", "again", { turnId: "t2" }), message("assistant", "part one", { turnId: "t2" }), message("assistant", "sub text", { turnId: "t2", agentId: "task-9" }), message("assistant", "part two", { turnId: "t2" }),
      activity("context-window.updated", { usedTokens: 50_000, maxTokens: 200_000, compactsAutomatically: true }),
      activity("approval.requested", { requestId: "r1", requestKind: "command", requestType: "command_execution_approval", dismissible: false, detail: "rm -rf build", args: { toolName: "Bash", input: { command: "rm -rf build" } } }, { tone: "approval" }),
      activity("user-input.requested", { requestId: "q1", dismissible: false, questions: [{ id: "Which db?", header: "DB", question: "Which db?", options: [{ label: "Postgres", description: "pg" }], isSecret: true }] }),
      activity("turn.proposed.completed", { planId: "p1", planMarkdown: "# Plan\n\ndo x" })
    ],
    pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5), detail: "rm -rf build" }],
      userInputs: [{ requestId: "q1", createdAt: stamp(6), dismissible: false, turnId: "t2", questions: [{ id: "Which db?", header: "DB", question: "Which db?", options: [{ label: "Postgres", description: "pg" }], multiSelect: false, allowCustomAnswer: true }] }] },
    roster: [{ id: "task-9", kind: "subagent", agentKind: "agent", title: "Explore", role: null, model: "sonnet", effort: null, status: "completed", activationCount: 1, usage: null, progress: null, lastToolName: "Read", result: null, error: null, outputFile: null, exitCode: null, isBackgrounded: false, parentAgentId: null, agentIndex: null, phaseIndex: null, phaseTitle: null, attempt: 1, workflowName: null, phases: [], runHandles: [], recentActivity: [], firstSeenAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3), updatedAt: stamp(3) } as never]
  });
  const d = sessionDetail(chatSummary({ accountId: "acc-1", hasPendingApprovals: true, hasPendingUserInput: true, hasActionableProposedPlan: true }), snap, ctx);
  assert.equal(d.chat.model, "claude-fable-5-1[1m]"); assert.deepEqual(d.chat.options, { effort: "high" }); assert.equal(d.chat.runtimeMode, "full-access");
  assert.equal(d.chat.home, "account"); assert.equal(d.chat.accountLabel, "jasperclaude"); assert.equal(d.chat.lastError, "boom"); assert.equal(d.chat.turnCount, 2, "two started turns (t1, t2) — counted by order, not by head.turnCount or checkpoints"); assert.equal(d.chat.continueAfterRestart, true);
  assert.deepEqual(d.chat.contextWindow, { usedTokens: 50_000, maxTokens: 200_000, percentUsed: 25, compactsAutomatically: true });
  assert.deepEqual(d.chat.supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: true, goals: null });
  assert.equal(d.chat.goal, null, "a snapshot without a goal");
  assert.equal(d.pending.approvals[0].requestId, "r1"); assert.deepEqual(d.pending.approvals[0].tool, { name: "Bash", input: { command: "rm -rf build" } });
  assert.deepEqual(d.pending.approvals[0].decisions.map((x) => x.decision), ["accept", "acceptForSession", "decline", "cancel"]);
  assert.equal(d.pending.questions[0].responseMode, "blocking"); assert.equal(d.pending.questions[0].questions[0].index, 1); assert.equal(d.pending.questions[0].questions[0].isSecret, true); assert.equal(d.pending.questions[0].questions[0].allowCustomAnswer, true);
  assert.deepEqual(d.plan, { planId: "p1", markdown: "# Plan\n\ndo x", truncated: false, actionable: true });
  assert.equal(d.subagents[0].id, "task-9"); assert.equal(d.subagents[0].status, "completed"); assert.equal(d.subagents[0].lastToolName, "Read");
  assert.deepEqual(d.lastReply, { turnId: "t2", text: "part one\n\npart two", truncated: false, completedAt: stamp(3) });
});

test("pending views: advertised decisions win over the default four; a message-mode question is dismissible", () => {
  const snap = snapshot({ pending: { approvals: [{ requestId: "r2", requestKind: "permission", createdAt: stamp(1), options: [{ decision: "accept", label: "Allow once" }, { decision: "decline", label: "Deny", warning: "w" }] }],
    userInputs: [{ requestId: "q2", createdAt: stamp(2), dismissible: true, responseMode: "message", questions: [{ id: "x", header: "H", question: "X?", options: [], multiSelect: true, allowCustomAnswer: true }] }] } });
  assert.deepEqual(pendingApprovalViews(snap)[0].decisions, [{ decision: "accept", label: "Allow once" }, { decision: "decline", label: "Deny", warning: "w" }]);
  assert.deepEqual(pendingApprovalViews(snapshot({ pending: { approvals: [{ requestId: "r3", requestKind: "command", createdAt: stamp(3), options: [] }], userInputs: [] } }))[0].decisions.map((x) => x.decision), ["accept", "acceptForSession", "decline", "cancel"]);
  const q = pendingQuestionViews(snap)[0];
  assert.equal(q.responseMode, "message"); assert.equal(q.dismissible, true); assert.equal(q.questions[0].multiSelect, true);
});

test("planView caps the markdown, lastReply skips subagent text and unsettled turns, optionsObject flattens", () => {
  const long = "x".repeat(20_000);
  const snap = snapshot({ items: [activity("turn.proposed.completed", { planId: "p", planMarkdown: long })] });
  const p = planView(snap)!;
  assert.equal(p.truncated, true); assert.equal(p.markdown.length, 16_384); assert.equal(p.actionable, true, "the latest plan, not implemented");
  assert.equal(planView(snapshot()), null);
  const running = snapshot({ turns: [turn({ turnId: "t1", state: "running", completedAt: null })], items: [message("assistant", "partial", { turnId: "t1" })] });
  assert.equal(lastReply(running), null);
  assert.deepEqual(optionsObject([{ id: "effort", value: "high" }, { id: "thinking", value: true }]), { effort: "high", thinking: true });
  assert.deepEqual(optionsObject(undefined), {});
});

test("chatDetail refuses a terminal session and builds a detail for a chat", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), shellSummary()] })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snapshot() } })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } })
    .on("GET", "/api/agent/providers", { status: 503, body: null });
  await assert.rejects(chatDetail(api, "t1"), (e: { code: string }) => e.code === "NOT_A_CHAT_SESSION");
  const d = await chatDetail(api, "c1");
  assert.equal(d.chat.model, "claude-fable-5-1[1m]"); assert.equal(d.chat.accountId, "system");
});

test("buildViewContext reads registry, accounts and providers and tolerates a failing providers call", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "deepseek", kind: "agent", name: "DeepSeek", bin: ["deepseek"], enabled: false, installState: "idle" }] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: null, grok: null } } })
    .on("GET", "/api/agent/providers", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } });
  const c = await buildViewContext(api);
  assert.deepEqual([...c.adapterByRefId], [["claude", "claude"]]);
  assert.equal(c.accountLabelById.get("acc-1"), "jasperclaude");
  assert.equal(c.capabilitiesByAdapter.size, 0);
  assert.equal(c.workspacesDir, "/w");
});

test("buildViewContext reads a degraded providers body field-wise, as list_agents does: nothing throws, and only a row with an id and a capabilities object counts", async () => {
  const registryBody = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } }] };
  const claudeCaps = { sessionModelSwitch: "in-session", showPlanModeToggle: true, supportsConversationRollback: true };
  const bodies: [string, unknown, [string, unknown][]][] = [
    ["a null body", null, []],
    ["a body that is not JSON", "<html>502 Bad Gateway</html>", []],
    ["providers null", { providers: null }, []],
    ["providers a number", { providers: 5 }, []],
    ["providers a string", { providers: "claude" }, []],
    ["providers an object", { providers: { claude: { id: "claude", capabilities: claudeCaps } } }, []],
    ["junk rows beside a good one", { providers: [null, 1, "codex", [], {}, { id: "" }, { id: 7, capabilities: claudeCaps }, { id: "codex", capabilities: null }, { id: "grok", capabilities: "all" }, { id: "claude", capabilities: claudeCaps }] }, [["claude", claudeCaps]]]
  ];
  for (const [label, body, expected] of bodies) {
    const api = new FakeDaemonApi()
      .on("GET", "/api/sessions", { status: 200, body: [chatSummary()] })
      .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snapshot() } })
      .on("GET", "/api/registry", { status: 200, body: registryBody })
      .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } })
      .on("GET", "/api/agent/providers", { status: 200, body });
    const c = await buildViewContext(api);
    assert.deepEqual([...c.capabilitiesByAdapter], expected, label);
    assert.deepEqual([...c.adapterByRefId], [["claude", "claude"], ["codex", "codex"]], `${label}: the registry still reads`);
    // get_session, send_message and create_session build their detail through it: a degraded body reads as "no capabilities".
    const d = await chatDetail(api, "c1");
    assert.deepEqual(d.chat.supports, expected.length ? { planMode: true, rollback: true, compaction: false, backgroundTasks: false, goals: null } : { planMode: false, rollback: false, compaction: false, backgroundTasks: false, goals: null }, `${label}: supports`);
  }
});

test("supports.rollback is offered only on an explicit true: an absent flag and no provider snapshot read false", () => {
  const caps = { sessionModelSwitch: "in-session", showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" } } as const;
  const withCaps = (c: typeof caps & { supportsConversationRollback?: boolean }): ViewContext => ({ ...ctx, capabilitiesByAdapter: new Map([["claude", c]]) });
  assert.equal(sessionDetail(chatSummary(), snapshot(), withCaps(caps)).chat.supports.rollback, false);
  assert.equal(sessionDetail(chatSummary(), snapshot(), withCaps({ ...caps, supportsConversationRollback: true })).chat.supports.rollback, true);
  assert.equal(sessionDetail(chatSummary(), snapshot(), { ...ctx, capabilitiesByAdapter: new Map() }).chat.supports.rollback, false);
});

test("the context meter skips a row without a usable reading, as the host's snapshot drop rule expects", () => {
  const snap = snapshot({ items: [activity("context-window.updated", { usedTokens: 50_000, maxTokens: 200_000 }), activity("context-window.updated", { maxTokens: 200_000 })] });
  assert.deepEqual(sessionDetail(chatSummary(), snap, ctx).chat.contextWindow, { usedTokens: 50_000, maxTokens: 200_000, percentUsed: 25 });
  assert.equal(sessionDetail(chatSummary(), snapshot({ items: [activity("context-window.updated", null)] }), ctx).chat.contextWindow, undefined);
});

test("planView reports a plan the snapshot's wire slimming already cut as truncated", () => {
  const snap = snapshot({ items: [activity("turn.proposed.completed", { planId: "p", planMarkdown: "計画…", truncated: true })] });
  assert.deepEqual(planView(snap), { planId: "p", markdown: "計画…", truncated: true, actionable: true });
});

test("the context meter's percentUsed is clamped to 100, as the GUI's ring is; the raw token counts are kept", () => {
  const over = snapshot({ items: [activity("context-window.updated", { usedTokens: 250_000, maxTokens: 200_000 })] });
  assert.deepEqual(sessionDetail(chatSummary(), over, ctx).chat.contextWindow, { usedTokens: 250_000, maxTokens: 200_000, percentUsed: 100 });
  const at = snapshot({ items: [activity("context-window.updated", { usedTokens: 200_000, maxTokens: 200_000 })] });
  assert.equal(sessionDetail(chatSummary(), at, ctx).chat.contextWindow?.percentUsed, 100);
});

test("lastReply is the turn's answer: Codex commentary (the fold's messageKind) is left out while the turn has an answer", () => {
  const codex = snapshot({ items: [
    message("user", "fix the parser", { turnId: "t1" }),
    message("assistant", "I'll look at the failing test first.", { turnId: "t1", messageKind: "commentary" }),
    message("assistant", "Now running the suite.", { turnId: "t1", messageKind: "commentary" }),
    message("assistant", "Fixed: the parser skipped empty lines.", { turnId: "t1", messageKind: "answer" })
  ] });
  assert.deepEqual(lastReply(codex), { turnId: "t1", text: "Fixed: the parser skipped empty lines.", truncated: false, completedAt: stamp(1) });
  // Without a phase (Claude, an older Codex) every assistant message of the turn is its answer, as before.
  const claude = snapshot({ items: [message("assistant", "Looking.", { turnId: "t1" }), message("assistant", "Done.", { turnId: "t1" })] });
  assert.equal(lastReply(claude)?.text, "Looking.\n\nDone.");
});

test("a turn with no answer at all ends on its last commentary, as the GUI's timeline does; a subagent's commentary never counts", () => {
  // Interrupted before its answer (and every Codex goal turn the goal-aware Stop paused, then interrupted).
  const cut = snapshot({ turns: [turn({ state: "interrupted" })], items: [
    message("user", "fix the parser", { turnId: "t1" }),
    message("assistant", "I'll start with the tests.", { turnId: "t1", messageKind: "commentary" }),
    message("assistant", "Two tests fail on empty lines; fixing the tokenizer next.", { turnId: "t1", messageKind: "commentary" })
  ] });
  assert.deepEqual(lastReply(cut), { turnId: "t1", text: "Two tests fail on empty lines; fixing the tokenizer next.", truncated: false, completedAt: stamp(1) }, "the last commentary alone, never the narration joined");
  // A subagent narrates inside the parent's turn: its commentary is its own, never the parent's last word.
  const sub = (text: string) => message("assistant", text, { turnId: "t1", messageKind: "commentary", agentId: "task-9" });
  assert.equal(lastReply(snapshot({ items: [message("assistant", "I'll start with the tests.", { turnId: "t1", messageKind: "commentary" }), sub("Reading the tokenizer.")] }))?.text, "I'll start with the tests.");
  assert.equal(lastReply(snapshot({ items: [message("user", "fix the parser", { turnId: "t1" }), sub("Reading the tokenizer.")] }))?.text, "", "only a subagent spoke");
  // An answer, however short, wins over any amount of narration.
  assert.equal(lastReply(snapshot({ items: [message("assistant", "Fixed.", { turnId: "t1" }), message("assistant", "Checking once more.", { turnId: "t1", messageKind: "commentary" })] }))?.text, "Fixed.");
});

// ---- Final fix wave F2 (M3): one rule decides whether a plan is actionable, judged on the snapshot. ----

test("plan.actionable is judged on the snapshot with the host's own rule, never on the summary flag one poll behind", () => {
  const plan = (id: string) => activity("turn.proposed.completed", { planId: id, planMarkdown: `# ${id}` });
  const implementing = (id: string) => message("user", buildPlanImplementationPrompt(`# ${id}`), { turnId: "t2" });
  // Just implemented (implement_plan {wait:false} reads this): the summary still flags the plan it was sent for.
  const sent = snapshot({ items: [plan("p1"), implementing("p1")] });
  assert.deepEqual(sessionDetail(chatSummary({ hasActionableProposedPlan: true }), sent, ctx).plan, { planId: "p1", markdown: "# p1", truncated: false, actionable: false });
  // Just proposed: the summary has not flagged it yet.
  assert.equal(sessionDetail(chatSummary({ hasActionableProposedPlan: false }), snapshot({ items: [plan("p1")] }), ctx).plan?.actionable, true);
  // Only the LATEST plan counts: one proposed after an implemented one is actionable again.
  assert.equal(sessionDetail(chatSummary({ hasActionableProposedPlan: false }), snapshot({ items: [plan("p1"), implementing("p1"), plan("p2")] }), ctx).plan?.actionable, true);
});

// ---- Final fix wave F2 (A): a session detail keeps within the result cap. ----

/** A roster row as the host folds it; `text` supplies its title, progress and error. */
function rosterRow(i: number, status: string, text: (label: string) => string): never {
  return { id: `task-${i}`, kind: "subagent", agentKind: "agent", title: text("Title"), role: null, model: "sonnet", effort: "high", status, activationCount: 1, usage: null, progress: text("Progress"), lastToolName: "Read", result: null, error: text("Error"), outputFile: null, exitCode: null,
    isBackgrounded: false, parentAgentId: null, agentIndex: null, phaseIndex: null, phaseTitle: null, attempt: 1, workflowName: null, phases: [], runHandles: null, recentActivity: [], firstSeenAt: stamp(i), startedAt: stamp(i), completedAt: status === "running" ? null : stamp(i + 1), updatedAt: stamp(i + 1) } as never;
}

test("a subagent's title, progress and error are capped at 200 code points in a session view, a cut ending in \"…\"", () => {
  const long = "é".repeat(150) + "🙂".repeat(100);
  const d = sessionDetail(chatSummary(), snapshot({ roster: [rosterRow(1, "failed", () => long), rosterRow(2, "completed", (label) => `${label}: short`)] }), ctx);
  const [cut, whole] = d.subagents;
  for (const text of [cut!.title!, cut!.progress!, cut!.error!]) {
    assert.equal([...text].length, 200);
    assert.equal(text, `${[...long].slice(0, 199).join("")}…`, "cut on a code point, never inside a surrogate pair");
  }
  assert.deepEqual([whole!.title, whole!.progress, whole!.error], ["Title: short", "Progress: short", "Error: short"]);
  assert.equal(d.subagentsTruncated, undefined, "a detail that fits is not flagged");
});

test("a session detail keeps within the result cap: 100 long subagents beside a 16 KB plan and reply shed settled rows oldest first, then live ones; every other field stays whole", () => {
  const long = (label: string, i: number) => `${label} of agent ${i}: ${"a long line of narration ".repeat(60)}`;
  // Every tenth row still running; the rest settled.
  const roster = Array.from({ length: 100 }, (_, i) => rosterRow(i, i % 10 === 9 ? "running" : "completed", (label) => long(label, i)));
  const plan = `# Plan\n${"1. a step of the plan\n".repeat(800)}`.slice(0, 16_000);
  const reply = `Done. ${"the reply goes on ".repeat(1_000)}`.slice(0, 16_000);
  const snap = snapshot({
    items: [message("user", "go", { turnId: "t1" }), message("assistant", reply, { turnId: "t1" }), activity("turn.proposed.completed", { planId: "p1", planMarkdown: plan }),
      activity("approval.requested", { requestId: "r1", requestKind: "command", detail: "rm -rf build", args: { toolName: "Bash", input: { command: "rm -rf build" } } }, { tone: "approval" })],
    roster, pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5), detail: "rm -rf build" }], userInputs: [] }
  });
  const summary = chatSummary({ hasPendingApprovals: true });
  const d = sessionDetail(summary, snap, ctx);
  const size = resultBytes({ session: d });
  assert.ok(size <= MAX_RESULT_BYTES, `${size} bytes`);
  assert.deepEqual(ok({ session: d }).structuredContent, { session: d }, "never cut by ok()'s last resort");
  assert.equal(d.subagentsTruncated, true);
  // Every other field whole: exactly the detail of the same session without a roster.
  const alone = sessionDetail(summary, { ...snap, roster: [] }, ctx);
  assert.deepEqual({ ...d, subagents: [], subagentsTruncated: undefined }, { ...alone, subagentsTruncated: undefined });
  assert.equal(d.plan?.markdown, plan);
  assert.equal(d.lastReply?.text, reply);
  assert.equal(d.pending.approvals[0]?.requestId, "r1");
  // Settled rows go first, oldest first; the live ones stay while there is room. Kept rows keep the roster's order.
  const ids = roster.map((r) => (r as { id: string }).id);
  const live = ids.filter((_, i) => i % 10 === 9);
  const settled = ids.filter((_, i) => i % 10 !== 9);
  const kept = d.subagents.map((s) => s.id);
  assert.deepEqual(kept, ids.filter((id) => kept.includes(id)));
  assert.ok(live.every((id) => kept.includes(id)), "every live row is kept");
  const keptSettled = kept.filter((id) => settled.includes(id));
  assert.ok(keptSettled.length > 0 && keptSettled.length < settled.length, `${keptSettled.length} settled rows kept`);
  assert.deepEqual(keptSettled, settled.slice(settled.length - keptSettled.length), "the newest settled rows");
  // Not shed past need: the cap less the room the tools keep beside a detail (≤ 1 KB) and one more row (< 1 KB).
  assert.ok(size > MAX_RESULT_BYTES - 2_000, `${size} bytes`);
  // With only live rows over the cap, the oldest live rows go.
  const allLive = sessionDetail(summary, { ...snap, roster: Array.from({ length: 100 }, (_, i) => rosterRow(i, "running", (label) => long(label, i))) }, ctx);
  assert.ok(resultBytes({ session: allLive }) <= MAX_RESULT_BYTES, `${resultBytes({ session: allLive })} bytes`);
  assert.equal(allLive.subagentsTruncated, true);
  const keptLive = allLive.subagents.map((s) => s.id);
  assert.deepEqual(keptLive, ids.slice(ids.length - keptLive.length), "the newest live rows");
});

// ---- Final fix wave F2, round 2: a plan and a reply too wide for one result are cut by bytes. ----

/** The two texts the byte cut may touch, blanked with their flags, so the rest of a detail can be compared whole. */
const blankTexts = (d: SessionDetail) => ({ ...d, plan: d.plan && { ...d.plan, markdown: "", truncated: false }, lastReply: d.lastReply && { ...d.lastReply, text: "", truncated: false } });
/** Whether `cut` is a head of `whole` ending on a code-point boundary: no lone high surrogate at its end. */
const headOf = (cut: string, whole: string) => whole.startsWith(cut) && !/[\uD800-\uDBFF]$/.test(cut);

test("a plan and a reply of 16 384 wide characters pass the cap on their own: the reply is cut by bytes first, then the plan, on code-point boundaries, each marked truncated; every other field stays whole", () => {
  const plan = "漢".repeat(16_384); // 49 152 bytes of UTF-8
  const reply = "😀".repeat(16_384); // 65 536 bytes
  const request = "確認".repeat(2_048); // 4 096 characters, 12 288 bytes: whole in the approval view
  const detailOf = (planText: string, replyText: string, pending: boolean) => sessionDetail(chatSummary({ hasPendingApprovals: pending }), snapshot({
    items: [message("user", "plan it", { turnId: "t1" }), message("assistant", replyText, { turnId: "t1" }), activity("turn.proposed.completed", { planId: "p1", planMarkdown: planText }),
      activity("context-window.updated", { usedTokens: 50_000, maxTokens: 200_000 }),
      ...(pending ? [activity("approval.requested", { requestId: "r1", requestKind: "command", detail: request, args: { toolName: "Bash", input: { command: request } } }, { tone: "approval" })] : [])],
    pending: { approvals: pending ? [{ requestId: "r1", requestKind: "command", createdAt: stamp(5), detail: request }] : [], userInputs: [] }
  }), ctx);
  for (const pending of [false, true]) {
    const d = detailOf(plan, reply, pending);
    const label = pending ? "with a large request open" : "alone";
    assert.ok(resultBytes({ session: d }) <= MAX_RESULT_BYTES, `${label}: ${resultBytes({ session: d })} bytes`);
    assert.deepEqual(ok({ session: d }).structuredContent, { session: d }, `${label}: never cut by ok()'s last resort`);
    // Every other field whole: exactly the detail of the same session with texts that need no cut.
    assert.deepEqual(blankTexts(d), blankTexts(detailOf("# short", "short", pending)), `${label}: the rest is whole`);
    assert.equal(d.lastReply!.truncated, true, `${label}: the reply is marked cut`);
    assert.ok(headOf(d.lastReply!.text, reply) && d.lastReply!.text.length < reply.length, `${label}: the reply keeps a head, whole code points`);
    if (!pending) {
      // The reply goes first, and cutting it made room: the plan is left whole — the cut stops as soon as the detail fits.
      assert.ok(d.lastReply!.text.length > 0, "a head of the reply is kept");
      assert.deepEqual(d.plan, { planId: "p1", markdown: plan, truncated: false, actionable: true });
      // Tight: one more character of the reply (4 bytes) would pass the budget.
      assert.ok(resultBytes(d) + 4 > SESSION_DETAIL_BYTES, `${resultBytes(d)} bytes`);
    } else {
      // The request stays whole, so the reply alone cannot make room: it is cut to nothing, then the plan is cut too.
      assert.equal(d.lastReply!.text, "");
      assert.equal(d.plan!.truncated, true, "the plan is marked cut");
      assert.ok(headOf(d.plan!.markdown, plan) && d.plan!.markdown.length > 0 && d.plan!.markdown.length < plan.length, "the plan keeps a head, whole code points");
      assert.equal(d.pending.approvals[0]!.detail, request);
      assert.ok(resultBytes(d) + 3 > SESSION_DETAIL_BYTES, `${resultBytes(d)} bytes`);
    }
  }
  // A text already marked cut (a plan over 16 384 characters, capped by planView) is cut further by bytes, flag kept.
  const longer = detailOf("😀".repeat(16_385), reply, false);
  assert.deepEqual([longer.lastReply!.text, longer.lastReply!.truncated, longer.plan!.truncated], ["", true, true]);
  assert.ok(headOf(longer.plan!.markdown, "😀".repeat(16_384)) && longer.plan!.markdown.length > 0, "a head of the plan");
  assert.ok(resultBytes(longer) <= SESSION_DETAIL_BYTES && resultBytes(longer) + 4 > SESSION_DETAIL_BYTES, `${resultBytes(longer)} bytes: fits, and tightly`);
  // Nothing is cut that fits.
  const small = detailOf("# Plan", "Done.", false);
  assert.deepEqual([small.plan, small.lastReply?.text, small.lastReply?.truncated], [{ planId: "p1", markdown: "# Plan", truncated: false, actionable: true }, "Done.", false]);
});

// ---- Goals: the provider's goal on a session view and a session detail (goals §4.7). ----

/** `text` as clipText cuts it to `max` code points: the head, then "…". */
const clipped = (text: string, max: number) => `${[...text].slice(0, max - 1).join("")}…`;

test("chat.goal is the summary's unfinished goal, its objective cut to 200 code points ending in \"…\"; a session without one reads null", () => {
  const long = "é".repeat(150) + "🙂".repeat(100); // 250 code points
  const v = sessionView(chatSummary({ goal: { objective: long, status: "active", continuing: false } }), ctx);
  assert.deepEqual(v.chat?.goal, { objective: clipped(long, 200), status: "active", continuing: false });
  assert.equal([...v.chat!.goal!.objective].length, 200, "cut on a code point, never inside a surrogate pair");
  assert.deepEqual(sessionView(chatSummary({ goal: { objective: "Ship it", status: "active", continuing: false } }), ctx).chat?.goal, { objective: "Ship it", status: "active", continuing: false }, "a short objective is whole");
  assert.equal(sessionView(chatSummary(), ctx).chat?.goal, null, "no goal field (a daemon from before goals)");
  assert.equal(sessionView(chatSummary({ goal: null }), ctx).chat?.goal, null);
});

test("chat.goal tells a goal that stopped short from a finished session, which reason alone cannot: every settled turn reads \"completed\"", () => {
  for (const status of ["paused", "blocked", "budget-limited", "usage-limited"] as const) {
    const v = sessionView(chatSummary({ goal: { objective: "Ship it", status, continuing: false } }), ctx);
    assert.deepEqual([v.reason, v.chat?.goal?.status], ["completed", status], status);
  }
});

test("chat.goal reads the summary defensively, as the GUI's tab marker does: a finished goal, or one without a usable objective or status, is null", () => {
  const unread: [string, unknown][] = [
    ["complete", { objective: "Ship it", status: "complete", continuing: false }], ["failed", { objective: "Ship it", status: "failed", continuing: false }],
    ["an empty objective", { objective: "", status: "active", continuing: true }], ["no objective", { status: "active", continuing: true }],
    ["an unknown status", { objective: "Ship it", status: "done", continuing: false }], ["a string", "Ship it"], ["a list", [{ objective: "Ship it", status: "active", continuing: false }]]
  ];
  for (const [label, goal] of unread) assert.equal(sessionView(chatSummary({ goal: goal as never }), ctx).chat?.goal, null, label);
  assert.deepEqual(sessionView(chatSummary({ goal: { objective: "Ship it", status: "active", continuing: "yes" } as never }), ctx).chat?.goal, { objective: "Ship it", status: "active", continuing: false }, "continuing counts only when it is really true");
});

test("goal-continuing: between two turns of a goal the provider continues by itself, a settled turn reads working — the ladder's own rung — with no finished stamp", () => {
  const summary = chatSummary({ refId: "codex", goal: { objective: "Migrate the parser", status: "active", continuing: true } });
  // The activity the daemon stamps from the same ladder (AgentChatSummaryService.applyFields).
  const { state, attention } = resolveChatActivity(summary);
  const v = sessionView({ ...summary, activity: { state, attention, lastOutputAt: null, needsAttentionAt: null } }, ctx);
  assert.deepEqual([v.reason, v.status, v.attention, v.needsAttentionAt], ["goal-continuing", "working", null, null]);
  assert.equal(v.chat?.latestTurn?.state, "completed", "the turn itself settled");
  assert.deepEqual(v.chat?.goal, { objective: "Migrate the parser", status: "active", continuing: true });
  // The same settled turn without the host's word is finished.
  assert.equal(sessionReason(chatSummary({ goal: { objective: "Migrate the parser", status: "active", continuing: false } })), "completed");
});

test("the detail's goal is the fold's, a finished one too while the provider's last update carries it, with every fact the provider reported and nothing else; list_sessions shows only an unfinished one", () => {
  // Codex and Grok report a met goal as `complete` and keep it.
  const done = { objective: "Make the suite green", status: "complete", goalId: "g-7", rounds: 3, lastCheck: "All 412 tests pass.", tokensUsed: 120_000, tokenBudget: 500_000, elapsedMs: 754_000, setAt: stamp(0), updatedAt: stamp(9) } as const;
  // The host drops a finished goal from the summary (goals §4.7), so nothing says it continues.
  const d = sessionDetail(chatSummary({ goal: null }), snapshot({ goal: done }), ctx);
  assert.deepEqual(d.chat.goal, { objective: "Make the suite green", status: "complete", continuing: false, rounds: 3, lastCheck: "All 412 tests pass.", tokensUsed: 120_000, tokenBudget: 500_000, elapsedMs: 754_000, setAt: stamp(0), updatedAt: stamp(9) }, "the provider's own goal id is left out");
  assert.equal(d.reason, "completed");
  assert.equal(sessionView(chatSummary({ goal: null }), ctx).chat?.goal, null);
});

test("the detail's goal is continuing on the summary's word, and get_session's supports carry the provider's goal surface", () => {
  const codexGoals = { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true } as const;
  const codexCtx: ViewContext = { ...ctx, capabilitiesByAdapter: new Map([["codex", { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" }, goals: codexGoals }]]) };
  const goal = { objective: "Migrate the parser", status: "active", phase: "executing", tokensUsed: 40_000, tokenBudget: null, updatedAt: stamp(4) } as const;
  const snap = snapshot({ head: head({ adapter: "codex", refId: "codex" }), goal });
  const summary = (continuing: boolean) => chatSummary({ refId: "codex", goal: { objective: goal.objective, status: "active", continuing } });
  const d = sessionDetail(summary(true), snap, codexCtx);
  assert.deepEqual(d.chat.goal, { objective: "Migrate the parser", status: "active", continuing: true, phase: "executing", tokensUsed: 40_000, tokenBudget: null, updatedAt: stamp(4) }, "a budget the provider cleared stays null; an unreported fact is absent");
  assert.equal(d.reason, "goal-continuing");
  assert.deepEqual(d.chat.supports.goals, codexGoals);
  assert.equal(sessionDetail(summary(false), snap, codexCtx).chat.goal?.continuing, false);
  assert.equal(sessionDetail(chatSummary({ refId: "codex" }), snap, codexCtx).chat.goal?.continuing, false, "a summary without the field");
});

test("a stale summary's continuing never outlives the snapshot's goal: only an active goal continues, as the host's own predicate has it", () => {
  // Right after send_message "/goal pause": the snapshot says paused, while the summary, one host poll behind, still says continuing.
  const stale = chatSummary({ refId: "codex", goal: { objective: "Migrate the parser", status: "active", continuing: true } });
  const detailWith = (status: AgentGoalStatus) => sessionDetail(stale, snapshot({ head: head({ adapter: "codex", refId: "codex" }), goal: { objective: "Migrate the parser", status, updatedAt: stamp(6) } }), ctx);
  assert.deepEqual(detailWith("paused").chat.goal, { objective: "Migrate the parser", status: "paused", continuing: false, updatedAt: stamp(6) });
  for (const status of ["blocked", "budget-limited", "usage-limited", "complete", "failed"] as const) assert.equal(detailWith(status).chat.goal?.continuing, false, status);
  assert.equal(detailWith("active").chat.goal?.continuing, true);
});

test("goals §5.7: a goal an Orquester update holds reads paused, continuing and heldForUpdate — in a list and in a detail, the GUI's \"paused for update\"", () => {
  // The host's own reading of a hold: `paused`, and continuing — its predicate needs an `active` goal otherwise.
  const held = chatSummary({ refId: "codex", goal: { objective: "Migrate the parser", status: "paused", continuing: true } });
  // The activity the daemon stamps from the same ladder (AgentChatSummaryService.applyFields).
  const { state, attention } = resolveChatActivity(held);
  const view = sessionView({ ...held, activity: { state, attention, lastOutputAt: null, needsAttentionAt: null } }, ctx);
  assert.deepEqual(view.chat?.goal, { objective: "Migrate the parser", status: "paused", continuing: true, heldForUpdate: true });
  assert.deepEqual([view.reason, view.status, view.attention], ["goal-continuing", "working", null], "the tab reads working: no finished stamp mid-deploy");
  const detailWith = (summary: typeof held, status: AgentGoalStatus) =>
    sessionDetail(summary, snapshot({ head: head({ adapter: "codex", refId: "codex" }), goal: { objective: "Migrate the parser", status, updatedAt: stamp(6) } }), ctx).chat.goal;
  assert.deepEqual(detailWith(held, "paused"), { objective: "Migrate the parser", status: "paused", continuing: true, heldForUpdate: true, updatedAt: stamp(6) });
  // Set going again since the summary was read: the goal continues, held no longer.
  assert.deepEqual(detailWith(held, "active"), { objective: "Migrate the parser", status: "active", continuing: true, updatedAt: stamp(6) });
  // Ended, blocked or limited during its final turn: nothing continues and nothing is held.
  for (const status of ["blocked", "budget-limited", "usage-limited", "complete", "failed"] as const) {
    assert.deepEqual(detailWith(held, status), { objective: "Migrate the parser", status, continuing: false, updatedAt: stamp(6) }, status);
  }
  // The user's own pause is never a hold, in a list or a detail.
  const userPaused = chatSummary({ refId: "codex", goal: { objective: "Migrate the parser", status: "paused", continuing: false } });
  assert.deepEqual(sessionView(userPaused, ctx).chat?.goal, { objective: "Migrate the parser", status: "paused", continuing: false });
  assert.deepEqual(detailWith(userPaused, "paused"), { objective: "Migrate the parser", status: "paused", continuing: false, updatedAt: stamp(6) });
});

test("a snapshot without a goal reads null even while a stale summary still names one: Claude reports a met goal as no goal", () => {
  // Claude's last goal row was `achieved`: `goal: null`, the ended goal only as `previous`, which the fold does not keep.
  const stale = chatSummary({ goal: { objective: "Make the suite green", status: "active", continuing: false } });
  assert.equal(sessionDetail(stale, snapshot({ goal: null }), ctx).chat.goal, null);
});

test("the detail's goal is null when the snapshot's does not read, whatever the summary says, and from a host that predates goals; a mistyped fact is dropped", () => {
  const summary = chatSummary({ goal: { objective: "Ship it", status: "active", continuing: true } });
  const unread: [string, unknown][] = [
    ["no updatedAt", { objective: "Ship it", status: "active" }], ["an unknown status", { objective: "Ship it", status: "done", updatedAt: stamp(3) }],
    ["an empty objective", { objective: "", status: "active", updatedAt: stamp(3) }], ["an objective that is no string", { objective: 7, status: "active", updatedAt: stamp(3) }],
    ["a string", "Ship it"], ["a list", [{ objective: "Ship it", status: "active", updatedAt: stamp(3) }]], ["null", null]
  ];
  for (const [label, goal] of unread) assert.equal(sessionDetail(summary, snapshot({ goal: goal as never }), ctx).chat.goal, null, label);
  assert.equal(sessionDetail(summary, snapshot(), ctx).chat.goal, null, "an older host's snapshot has no goal field");
  const mistyped = { objective: "Ship it", status: "active", rounds: -1, tokensUsed: "many", lastCheck: "", elapsedMs: Number.NaN, updatedAt: stamp(3) };
  assert.deepEqual(sessionDetail(summary, snapshot({ goal: mistyped as never }), ctx).chat.goal, { objective: "Ship it", status: "active", continuing: true, updatedAt: stamp(3) });
});

test("the detail's goal text is cut in code points, ending in \"…\": an objective at 4 000, a last check at 2 000, a phase at 200; an objective at the limit stays whole", () => {
  const objective = "o".repeat(2_500) + "🙂".repeat(2_500); // 5 000 code points
  const lastCheck = "c".repeat(1_000) + "漢".repeat(1_500); // 2 500
  const phase = "p".repeat(300);
  const g = sessionDetail(chatSummary(), snapshot({ goal: { objective, status: "blocked", phase, lastCheck, updatedAt: stamp(5) } }), ctx).chat.goal!;
  assert.deepEqual(g, { objective: clipped(objective, 4_000), status: "blocked", continuing: false, phase: clipped(phase, 200), lastCheck: clipped(lastCheck, 2_000), updatedAt: stamp(5) });
  assert.deepEqual([[...g.objective].length, [...g.lastCheck!].length, [...g.phase!].length], [4_000, 2_000, 200]);
  const longest = "🙂".repeat(4_000); // Claude's and Codex's own limit, in code points
  assert.equal(sessionDetail(chatSummary(), snapshot({ goal: { objective: longest, status: "active", updatedAt: stamp(5) } }), ctx).chat.goal?.objective, longest);
});

test("a goal at its caps stays whole beside a 16 KB plan and reply and a large request: fitDetail cuts the reply, then the plan, to make room, never the goal", () => {
  const goal = { objective: "😀".repeat(5_000), status: "active", phase: "😀".repeat(300), rounds: 12, lastCheck: "😀".repeat(2_500), tokensUsed: 1_000_000, tokenBudget: 2_000_000, elapsedMs: 3_600_000, setAt: stamp(0), updatedAt: stamp(9) } as const;
  const plan = "漢".repeat(16_384);
  const reply = "😀".repeat(16_384);
  const request = "確認".repeat(2_048);
  const detailOf = (withGoal: boolean, planText: string, replyText: string) => sessionDetail(chatSummary({ hasPendingApprovals: true }), snapshot({
    items: [message("user", "go", { turnId: "t1" }), message("assistant", replyText, { turnId: "t1" }), activity("turn.proposed.completed", { planId: "p1", planMarkdown: planText }),
      activity("approval.requested", { requestId: "r1", requestKind: "command", detail: request, args: { toolName: "Bash", input: { command: request } } }, { tone: "approval" })],
    pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(5), detail: request }], userInputs: [] },
    ...(withGoal ? { goal } : {})
  }), ctx);
  const d = detailOf(true, plan, reply);
  assert.ok(resultBytes(d) <= SESSION_DETAIL_BYTES, `${resultBytes(d)} bytes`);
  assert.deepEqual(ok({ session: d }).structuredContent, { session: d }, "never cut by ok()'s last resort");
  // Every other field whole, the goal included: exactly the detail of the same session with texts that need no cut.
  assert.deepEqual(blankTexts(d), blankTexts(detailOf(true, "# short", "short")));
  assert.equal([...d.chat.goal!.objective].length, 4_000);
  assert.deepEqual([d.lastReply!.text, d.lastReply!.truncated, d.plan!.truncated], ["", true, true]);
  assert.ok(headOf(d.plan!.markdown, plan) && d.plan!.markdown.length > 0, "the plan keeps a head");
  assert.ok(detailOf(false, plan, reply).plan!.markdown.length > d.plan!.markdown.length, "the goal's room comes out of the plan");
});

// ---- An old Claude log's re-emitted opening paragraph (spec §7.3): left out of the reply, as the GUI leaves it out. ----

const OPENING = "The subagent finished; merging its findings.";
const ANSWER = "Merged: the parser now skips empty lines.";
/** A CLI-started turn as a host before the pre-turn-stream fix wrote it: its opening paragraph again at `result`, under a new id. */
const reEmittedTurn = () => [
  message("assistant", OPENING, { turnId: "t1", id: "m-open" }),
  activity("tool.completed", { itemType: "command_execution", toolUseId: "tu1", title: "Run pnpm check", status: "completed" }, { turnId: "t1", tone: "tool" }),
  message("assistant", ANSWER, { turnId: "t1", id: "m-answer" }),
  message("assistant", OPENING, { turnId: "t1", id: "m-copy" })
];

test("lastReply leaves out a Claude thread's re-emitted opening paragraph, as the GUI's timeline does; a Codex thread keeps the same items whole", () => {
  const items = reEmittedTurn();
  const claude = snapshot({ items });
  assert.deepEqual(lastReply(claude), { turnId: "t1", text: `${OPENING}\n\n${ANSWER}`, truncated: false, completedAt: stamp(1) }, "the opening stays where it was said, and the reply ends on the answer");
  // get_session's lastReply, and so send_message's reply, is that same answer.
  assert.equal(sessionDetail(chatSummary(), claude, ctx).lastReply?.text, `${OPENING}\n\n${ANSWER}`);
  // Only a Claude log holds such a copy: a Codex thread's repeat is its own words.
  const codex = snapshot({ head: head({ adapter: "codex", refId: "codex" }), items });
  assert.equal(lastReply(codex)?.text, `${OPENING}\n\n${ANSWER}\n\n${OPENING}`);
  assert.equal(sessionDetail(chatSummary({ refId: "codex" }), codex, ctx).lastReply?.text, `${OPENING}\n\n${ANSWER}\n\n${OPENING}`);
  // A turn whose opening paragraph was all it said: the reply is that paragraph, once.
  const alone = snapshot({ items: [message("assistant", OPENING, { turnId: "t1", id: "m-open" }), message("assistant", OPENING, { turnId: "t1", id: "m-copy" })] });
  assert.equal(lastReply(alone)?.text, OPENING);
});

test("a Claude turn whose final answer repeats a message other than its opening is untouched, and so is a repeat of the opening that more of its turn follows", () => {
  // A goal run is ONE turn of many rounds, and two of them can end on the same words: the later one is the turn's answer.
  const rounds = snapshot({ items: [
    message("assistant", "Working through the failing checks.", { turnId: "t1", id: "m-open" }),
    message("assistant", "All checks pass.", { turnId: "t1", id: "m-round-1" }),
    activity("goal.updated", { goal: { objective: "Make CI green", status: "active", rounds: 1 }, change: "checked" }, { turnId: "t1" }),
    message("assistant", "All checks pass.", { turnId: "t1", id: "m-round-2" })
  ] });
  assert.equal(lastReply(rounds)?.text, "Working through the failing checks.\n\nAll checks pass.\n\nAll checks pass.");
  // The copy was flushed at `result`: a repeat of the opening that the turn goes on after is the agent's own words.
  const again = snapshot({ items: [
    message("assistant", "Running the tests again.", { turnId: "t1", id: "m-open" }),
    message("assistant", "Running the tests again.", { turnId: "t1", id: "m-again" }),
    message("assistant", "All green: 212 passing.", { turnId: "t1", id: "m-answer" })
  ] });
  assert.equal(lastReply(again)?.text, "Running the tests again.\n\nRunning the tests again.\n\nAll green: 212 passing.");
});
