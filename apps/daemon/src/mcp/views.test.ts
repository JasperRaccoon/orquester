import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt } from "@orquester/api/agent-chat";
import { FakeDaemonApi } from "./testing.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "./result.ts";
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
    assert.deepEqual(d.chat.supports, expected.length ? { planMode: true, rollback: true, compaction: false, backgroundTasks: false } : { planMode: false, rollback: false, compaction: false, backgroundTasks: false }, `${label}: supports`);
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

test("lastReply is the turn's answer: Codex commentary (the fold's messageKind) is left out, as the GUI demotes it", () => {
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
  // A turn cut before its answer said nothing that answers: its narration is not passed off as a reply.
  const cut = snapshot({ turns: [turn({ state: "interrupted" })], items: [message("assistant", "I'll start with the tests.", { turnId: "t1", messageKind: "commentary" })] });
  assert.equal(lastReply(cut)?.text, "");
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
