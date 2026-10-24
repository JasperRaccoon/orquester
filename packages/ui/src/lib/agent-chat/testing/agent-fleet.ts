/**
 * Test scaffolding: a subagent fleet's log, shaped as the Claude adapter
 * writes one (on-demand agent rows, `@orquester/api`'s `agent-rows.ts`).
 *
 * One parent turn launches a fleet: agents that finished, failed, were
 * cancelled with an approval still open, were relaunched, launched a nested
 * agent of their own, or are still at work; a background shell; an older
 * log's unstamped output chunk; reasoning and answers streamed as deltas; the
 * parent's own words and calls between them all. Every row is stamped when
 * its event was (arrival order), as ingestion stamps it.
 */

import type { DomainEvent, ThreadActivityItem } from "@orquester/api/agent-chat";

const THREAD_ID = "s1";

/** One log, built in order. */
export function agentFleetLog(options: { callsPerAgent?: number } = {}): DomainEvent[] {
  const calls = options.callsPerAgent ?? 6;
  const events: DomainEvent[] = [];
  let seq = 0;
  const at = (n: number): string => new Date(Date.UTC(2026, 3, 1, 9, 0, 0) + n * 1000).toISOString();
  const push = (type: DomainEvent["type"], payload: unknown): void => {
    seq += 1;
    events.push({
      seq,
      eventId: `e${seq}`,
      threadId: THREAD_ID,
      type,
      payload,
      occurredAt: at(seq),
      commandId: null,
      causationEventId: null,
      metadata: {}
    } as DomainEvent);
  };
  const row = (
    id: string,
    activityKind: string,
    payload: Record<string, unknown>,
    extra: { agentId?: string; tone?: ThreadActivityItem["tone"]; turnId?: string | null } = {}
  ): void => {
    const stamp = at(seq + 1);
    const activity: ThreadActivityItem = {
      kind: "activity",
      id,
      tone: extra.tone ?? "tool",
      activityKind,
      summary: activityKind,
      payload,
      turnId: extra.turnId === undefined ? "t1" : extra.turnId,
      createdAt: stamp,
      updatedAt: stamp,
      ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {})
    };
    push("thread.activity-appended", { activity });
  };
  const words = (
    messageId: string,
    role: "assistant" | "reasoning",
    chunks: readonly string[],
    agentId?: string,
    close = true
  ): void => {
    for (const chunk of chunks) {
      push("thread.message-sent", {
        messageId,
        role,
        text: chunk,
        streaming: true,
        turnId: "t1",
        ...(agentId !== undefined ? { agentId } : {})
      });
    }
    if (close) {
      push("thread.message-sent", {
        messageId,
        role,
        text: "",
        streaming: false,
        turnId: "t1",
        ...(agentId !== undefined ? { agentId } : {})
      });
    }
  };
  /** One command the agent ran: start, streamed output, an update, the completion. */
  const command = (agentId: string | undefined, callId: string, title: string): void => {
    const call = { toolUseId: callId, itemType: "command_execution", title, command: title };
    const owner = agentId !== undefined ? { agentId } : {};
    row(`${callId}-start`, "tool.started", { ...call, status: "inProgress" }, owner);
    row(`${callId}-out-1`, "tool.output", { toolUseId: callId, delta: `${title}: line 1\n`, stream: "stdout" }, owner);
    row(`${callId}-update`, "tool.updated", { ...call, status: "inProgress", data: { command: title } }, owner);
    row(`${callId}-out-2`, "tool.output", { toolUseId: callId, delta: `${title}: line 2\n`, stream: "stdout" }, owner);
    row(`${callId}-done`, "tool.completed", { ...call, status: "completed", data: { output: `${title} ok` } }, owner);
  };
  const launch = (agentId: string, title: string, owner?: string, launchId = `launch-${agentId}`): void => {
    row(`${launchId}-call`, "tool.started", { toolUseId: launchId, itemType: "collab_agent_tool_call", title: "Agent" }, owner !== undefined ? { agentId: owner } : {});
    row(
      `${launchId}-task`,
      "task.started",
      {
        taskId: agentId,
        agentKind: "agent",
        title,
        prompt: `Please ${title.toLowerCase()} and report back.`,
        toolUseId: launchId,
        ...(owner !== undefined ? { parentAgentId: owner } : {})
      },
      owner !== undefined ? { agentId: owner } : {}
    );
  };
  const progress = (agentId: string, n: number, owner?: string): void =>
    row(`${agentId}-progress-${n}`, "task.progress", { taskId: agentId, agentKind: "agent", summary: `step ${n}`, lastToolName: "Bash", usage: { totalTokens: 1000 * n, toolUses: n } }, owner !== undefined ? { agentId: owner } : {});
  const finish = (agentId: string, status: string, owner?: string, n = 1): void =>
    row(`${agentId}-end-${n}`, "task.completed", { taskId: agentId, agentKind: "agent", status, summary: `${agentId} ${status}` }, owner !== undefined ? { agentId: owner } : {});

  push("thread.created", {
    projectPath: "/w/p",
    cwd: "/w/p",
    title: "Fleet",
    adapter: "claude",
    refId: "claude",
    accountId: "acc-1",
    home: "account",
    modelSelection: { model: "sonnet" },
    runtimeMode: "approval-required"
  });
  push("thread.message-sent", { messageId: "u1", role: "user", text: "Run the fleet", streaming: false, turnId: null });
  push("thread.session-set", { session: { status: "running", activeTurnId: "t1" } });
  words("p-think", "reasoning", ["Planning ", "the fleet."]);
  words("p-say", "assistant", ["Launching ", "six agents."]);

  // The fleet launches, the parent's own call between them.
  for (const [agentId, title] of [["a1", "Audit the build"], ["a2", "Port the parser"], ["a3", "Try the fix"], ["a4", "Split the work"], ["a5", "Watch the tests"], ["a6", "Rewrite the docs"]] as const) {
    launch(agentId, title);
  }
  row("sh-launch", "task.started", { taskId: "sh", agentKind: "background", title: "npm test --watch", toolUseId: "bgshell:sh" });
  command(undefined, "p-call-1", "git status");

  // Interleaved work: every agent a few commands and words, round after round.
  for (let round = 0; round < calls; round += 1) {
    for (const agentId of ["a1", "a2", "a3", "a4", "a5", "a6"]) {
      command(agentId, `${agentId}-c${round}`, `${agentId} step ${round}`);
      if (round % 2 === 0) words(`${agentId}-think-${round}`, "reasoning", [`${agentId} thinks `, `about ${round}.`], agentId);
      progress(agentId, round + 1);
    }
    row(`sh-out-${round}`, "tool.output", { toolUseId: "bgshell:sh", delta: `PASS ${round}\n` }, { agentId: "sh" });
    if (round === 1) {
      // a4's own agent, launched and run by it.
      launch("n1", "Check the split", "a4");
      command("n1", "n1-c0", "n1 step 0");
      words("n1-say", "assistant", ["Split ", "checks out."], "n1");
      progress("n1", 1, "a4");
      finish("n1", "completed", "a4");
      // An older host's chunk of a1's call, written with no owner of its own.
      row("a1-unstamped", "tool.output", { toolUseId: "a1-c1", delta: "late chunk\n", stream: "stdout" }, {});
    }
    if (round === 2) {
      // a6 asks to edit a file and is cancelled with the request still open.
      row("a6-edit-start", "tool.started", { toolUseId: "a6-edit", itemType: "file_change", title: "Edit README.md", status: "inProgress" }, { agentId: "a6" });
      row("a6-approval", "approval.requested", { requestId: "r-a6", requestType: "file_change_approval", toolUseId: "a6-edit", requestingAgentId: "a6" }, { agentId: "a6", tone: "approval" });
      finish("a6", "cancelled");
    }
  }
  // Endings: a1 and a4 finish, a3 fails on a denied call, a2 ends and is relaunched, a5 runs on.
  words("a1-say", "assistant", ["The build ", "is clean."], "a1");
  finish("a1", "completed");
  row("a3-denied", "tool.denied", { toolUseId: "a3-rm", itemType: "command_execution", title: "rm -rf build", reason: "denied" }, { agentId: "a3" });
  finish("a3", "failed");
  words("a4-say", "assistant", ["Split ", "done."], "a4");
  finish("a4", "completed");
  finish("a2", "completed");
  words("p-say-2", "assistant", ["Relaunching ", "a2."]);
  launch("a2", "Port the parser", undefined, "launch-a2-again");
  command("a2", "a2-again", "a2 again");
  words("a2-say", "assistant", ["Parser ", "ported."], "a2");
  finish("a2", "completed", undefined, 2);
  // Still at work: a5's answer is mid-stream.
  words("a5-say", "assistant", ["Tests are ", "still "], "a5", false);
  return events;
}
