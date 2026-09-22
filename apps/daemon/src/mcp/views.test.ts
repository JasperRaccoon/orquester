import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "./fixtures.ts";
import { buildViewContext, chatDetail, lastReply, optionsObject, pendingApprovalViews, pendingQuestionViews, planView, sessionDetail, sessionReason, sessionView, type ViewContext } from "./views.ts";

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
  assert.deepEqual(chat.chat, { sessionStatus: "ready", accountId: "acc-1", latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(0), completedAt: stamp(1) }, pending: { approvals: false, questions: false }, planReady: false, backgroundLiveness: null });
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
  assert.deepEqual(d.chat.supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: true });
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
  const q = pendingQuestionViews(snap)[0];
  assert.equal(q.responseMode, "message"); assert.equal(q.dismissible, true); assert.equal(q.questions[0].multiSelect, true);
});

test("planView caps the markdown, lastReply skips subagent text and unsettled turns, optionsObject flattens", () => {
  const long = "x".repeat(20_000);
  const snap = snapshot({ items: [activity("turn.proposed.completed", { planId: "p", planMarkdown: long })] });
  const p = planView(snap, chatSummary())!;
  assert.equal(p.truncated, true); assert.equal(p.markdown.length, 16_384); assert.equal(p.actionable, false);
  assert.equal(planView(snapshot(), chatSummary()), null);
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
