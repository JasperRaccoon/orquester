/**
 * One case per §5.1 ingestion rule: which runtime event becomes which activity
 * row, which becomes none, and what each row carries.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_GOAL_CHANGES,
  GOAL_ACTIVITY_KIND,
  HISTORICAL_RAW_SOURCE,
  TASK_PROMPT_MAX_CHARS,
  TOOL_LIFECYCLE_ITEM_TYPES,
  type AgentGoal,
  type CanonicalItemType,
  type GoalUpdatedPayload
} from "@orquester/api/agent-chat";

import { cancelledRequestActivity } from "../orchestration/events.ts";
import {
  requestKindFromCanonicalRequestType,
  runtimeEventToActivities,
  taskLinkageActivityFields
} from "./activities.ts";
import { runtimeEvent } from "./test-harness.ts";

function payloadOf(activity: { payload: unknown }): Record<string, unknown> {
  assert.ok(typeof activity.payload === "object" && activity.payload !== null);
  return activity.payload as Record<string, unknown>;
}

describe("requestKindFromCanonicalRequestType (§5.1 requestKind rewrite)", () => {
  const cases: [string, string | undefined][] = [
    ["command_execution_approval", "command"],
    ["exec_command_approval", "command"],
    ["file_read_approval", "file-read"],
    ["file_change_approval", "file-change"],
    ["apply_patch_approval", "file-change"],
    ["mcp_elicitation_approval", "mcp-elicitation"],
    ["permission_approval", "permission"],
    // NOT mapped at ingestion. The client-side reader folds it into `command`
    // so older rows classify; T3 keeps the two functions apart and so do we.
    ["dynamic_tool_call", undefined],
    ["auth_tokens_refresh", undefined],
    ["tool_user_input", undefined],
    ["unknown", undefined]
  ];
  for (const [requestType, expected] of cases) {
    it(`${requestType} -> ${expected ?? "unmapped"}`, () => {
      assert.equal(requestKindFromCanonicalRequestType(requestType), expected);
    });
  }
});

describe("approvals (§5.1)", () => {
  it("request.opened keeps BOTH the canonical kind and the raw requestType", () => {
    const [row, ...rest] = runtimeEventToActivities(
      runtimeEvent(
        "request.opened",
        { requestType: "exec_command_approval", dismissible: false, detail: "rm -rf /" },
        { requestId: "req-1", turnId: "turn-1" }
      )
    );
    assert.equal(rest.length, 0);
    assert.ok(row);
    assert.equal(row.activityKind, "approval.requested");
    assert.equal(row.tone, "approval");
    assert.equal(row.summary, "Command approval requested");
    assert.equal(row.turnId, "turn-1");
    const payload = payloadOf(row);
    assert.equal(payload.requestKind, "command");
    assert.equal(payload.requestType, "exec_command_approval");
    assert.equal(payload.requestId, "req-1");
    assert.equal(payload.dismissible, false);
  });

  it("tool_user_input is dropped from BOTH request arms — it is a question, not an approval", () => {
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("request.opened", { requestType: "tool_user_input", dismissible: true })
      ),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("request.resolved", { requestType: "tool_user_input" })
      ),
      []
    );
  });

  it("request.resolved carries the decision", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent(
        "request.resolved",
        { requestType: "permission_approval", decision: "decline" },
        { requestId: "req-2" }
      )
    );
    assert.ok(row);
    assert.equal(row.activityKind, "approval.resolved");
    assert.equal(payloadOf(row).requestKind, "permission");
    assert.equal(payloadOf(row).decision, "decline");
  });

  it("an unmapped request type still produces a row, with no requestKind", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("request.opened", { requestType: "dynamic_tool_call", dismissible: false })
    );
    assert.ok(row);
    assert.equal(payloadOf(row).requestKind, undefined);
    assert.equal(payloadOf(row).requestType, "dynamic_tool_call");
    assert.equal(row.summary, "Approval requested");
  });
});

describe("a request the provider withdrew is the host's own cancelled row", () => {
  // Nobody answered it: the work that asked went away (a Codex collab child's
  // turn ended or its thread closed) or the provider resolved it itself. The
  // row a Stop writes says exactly that, "Request cancelled" / "Question
  // cancelled"; "Approval resolved" / "User input submitted" would say
  // someone answered.
  it("an approval: one 'Request cancelled' row, on the turn its card rode", () => {
    const event = runtimeEvent(
      "request.resolved",
      { requestType: "command_execution_approval", decision: "cancel", withdrawn: true },
      { requestId: "req-7", turnId: "turn-3" }
    );
    assert.deepEqual(runtimeEventToActivities(event), [
      cancelledRequestActivity({
        requestId: "req-7",
        kind: "approval",
        turnId: "turn-3",
        createdAt: event.createdAt
      })
    ]);
  });

  it("a question: one 'Question cancelled' row, turnless when its card was", () => {
    const event = runtimeEvent(
      "user-input.resolved",
      { answers: {}, withdrawn: true },
      { requestId: "q-7" }
    );
    const rows = runtimeEventToActivities(event);
    assert.deepEqual(rows, [
      cancelledRequestActivity({
        requestId: "q-7",
        kind: "question",
        turnId: null,
        createdAt: event.createdAt
      })
    ]);
    assert.equal(rows[0]!.summary, "Question cancelled");
  });

  it("a withdrawn tool_user_input resolution is still no row: a question closes by its own event", () => {
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent(
          "request.resolved",
          { requestType: "tool_user_input", decision: "cancel", withdrawn: true },
          { requestId: "q-8" }
        )
      ),
      []
    );
  });

  it("an answered resolution keeps its own row", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent(
        "request.resolved",
        { requestType: "command_execution_approval", decision: "cancel" },
        { requestId: "req-9" }
      )
    );
    assert.equal(row!.summary, "Approval resolved", "a user's Cancel is an answer");
  });
});

describe("item lifecycle is gated on isToolLifecycleItemType (§5.1)", () => {
  for (const itemType of TOOL_LIFECYCLE_ITEM_TYPES) {
    it(`${itemType} produces tool.started / tool.updated / tool.completed`, () => {
      const kinds = (["item.started", "item.updated", "item.completed"] as const).map(
        (type) =>
          runtimeEventToActivities(
            runtimeEvent(type, { itemType, status: "inProgress" }, { itemId: "call-1" })
          )[0]?.activityKind
      );
      assert.deepEqual(kinds, ["tool.started", "tool.updated", "tool.completed"]);
    });
  }

  const dropped: CanonicalItemType[] = [
    "user_message",
    "assistant_message",
    "reasoning",
    "plan",
    "review_entered",
    "review_exited",
    "context_compaction",
    "error",
    "unknown"
  ];
  for (const itemType of dropped) {
    it(`${itemType} is dropped from the activity path`, () => {
      for (const type of ["item.started", "item.updated", "item.completed"] as const) {
        assert.deepEqual(runtimeEventToActivities(runtimeEvent(type, { itemType })), []);
      }
    });
  }

  it("toolUseId is stable across a call's whole lifecycle", () => {
    const ids = (["item.started", "item.updated", "item.completed"] as const).map(
      (type) =>
        payloadOf(
          runtimeEventToActivities(
            runtimeEvent(type, { itemType: "command_execution" }, { itemId: "call-42" })
          )[0]!
        ).toolUseId
    );
    assert.deepEqual(ids, ["call-42", "call-42", "call-42"]);
  });

  it("agentId, parentToolUseId and status are promoted out of the payload", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent(
        "item.completed",
        {
          itemType: "mcp_tool_call",
          status: "failed",
          agentId: "agent-7",
          parentToolUseId: "parent-1"
        },
        { itemId: "call-9" }
      )
    );
    assert.ok(row);
    assert.equal(row.agentId, "agent-7");
    assert.equal(row.parentToolUseId, "parent-1");
    assert.equal(row.status, "failed");
  });

  it("an item whose adapter stored only a head of its output says so on the row (`truncated`, §5.6)", () => {
    // Codex keeps a command's output in the completion, bounded: past the
    // bound its data holds a head, and the row must not pass it off as whole.
    const [cut] = runtimeEventToActivities(
      runtimeEvent(
        "item.completed",
        {
          itemType: "command_execution",
          status: "completed",
          data: { item: { aggregatedOutput: "head" } },
          truncated: true
        },
        { itemId: "call-1" }
      )
    );
    assert.equal(payloadOf(cut!).truncated, true);
    const [whole] = runtimeEventToActivities(
      runtimeEvent(
        "item.completed",
        { itemType: "command_execution", status: "completed", data: { item: { aggregatedOutput: "all" } } },
        { itemId: "call-2" }
      )
    );
    assert.equal("truncated" in payloadOf(whole!), false);
  });
});

describe("token usage and compaction (§5.1)", () => {
  it("thread.token-usage.updated becomes context-window.updated", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("thread.token-usage.updated", {
        usage: { usedTokens: 1200, maxTokens: 200_000 }
      })
    );
    assert.ok(row);
    assert.equal(row.activityKind, "context-window.updated");
    assert.equal(payloadOf(row).usedTokens, 1200);
    assert.equal(payloadOf(row).maxTokens, 200_000);
  });

  it("a negative usedTokens is dropped", () => {
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("thread.token-usage.updated", { usage: { usedTokens: -1 } })
      ),
      []
    );
  });

  it("only the compacted thread state produces a row, and it carries the token counts", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("thread.state.changed", {
        state: "compacted",
        beforeTokens: 120_000,
        afterTokens: 18_000
      })
    );
    assert.ok(row);
    assert.equal(row.activityKind, "context-compaction");
    assert.equal(payloadOf(row).beforeTokens, 120_000);
    assert.equal(payloadOf(row).afterTokens, 18_000);
    for (const state of ["active", "idle", "archived", "closed", "error"] as const) {
      assert.deepEqual(runtimeEventToActivities(runtimeEvent("thread.state.changed", { state })), []);
    }
  });

  it("the compaction PHASE is a row too, so a /compact turn is not a blank 'Working'", () => {
    const [opening, ...rest] = runtimeEventToActivities(
      runtimeEvent("thread.state.changed", { state: "compacting" }, { requestId: "req-9" })
    );
    assert.deepEqual(rest, []);
    assert.ok(opening);
    assert.equal(opening.tone, "info");
    assert.equal(opening.activityKind, "context-compaction");
    assert.equal(opening.summary, "Compacting context");
    // The client renders on `payload.state`, never on the summary text.
    assert.equal(payloadOf(opening).state, "compacting");
    assert.equal(payloadOf(opening).requestId, "req-9");
    assert.equal(payloadOf(opening).beforeTokens, undefined);
  });

  it("carries the provider's summary, whole, so the marker can reveal it", () => {
    const summary = "This session is being continued from a previous conversation.\n\n1. Fixed X.";
    const [row] = runtimeEventToActivities(
      runtimeEvent("thread.state.changed", {
        state: "compacted",
        beforeTokens: 120_000,
        afterTokens: 18_000,
        summary
      })
    );
    assert.ok(row);
    assert.equal(
      payloadOf(row).summary,
      summary,
      "untruncated on disk: the wire cap is the slimmer's job, and `GET …/items/:itemId` serves this"
    );
  });

  it("a failed compaction is an error row carrying the provider's own reason", () => {
    const [row, ...rest] = runtimeEventToActivities(
      runtimeEvent("thread.state.changed", {
        state: "compaction-failed",
        error: "Not enough context to compact."
      })
    );
    assert.deepEqual(rest, []);
    assert.ok(row);
    assert.equal(row.tone, "error");
    assert.equal(row.activityKind, "context-compaction");
    assert.equal(row.summary, "Context compaction failed");
    assert.equal(payloadOf(row).state, "compaction-failed");
    assert.equal(payloadOf(row).error, "Not enough context to compact.");
  });
});

describe("task linkage rides every row (§4.2/§5.1)", () => {
  it("agentKind is stamped once, here", () => {
    assert.equal(taskLinkageActivityFields({ taskType: "subagent" }).agentKind, "agent");
    assert.equal(taskLinkageActivityFields({ taskType: "monitor" }).agentKind, "background");
    assert.equal(taskLinkageActivityFields({ taskType: "plan" }).agentKind, "background");
    // A task launched from inside a subagent is background work unless it is
    // itself agent-flavoured — a nested agent can outlive its parent.
    assert.equal(
      taskLinkageActivityFields({ agentId: "a1", taskType: "shell" }).agentKind,
      "background"
    );
    assert.equal(
      taskLinkageActivityFields({ agentId: "a1", taskType: "subagent" }).agentKind,
      "agent"
    );
  });

  const linkage = {
    taskType: "subagent",
    agentId: "agent-1",
    parentAgentId: "agent-0",
    toolUseId: "tool-1",
    title: "Refactor",
    model: "gpt-5",
    outputFile: "/tmp/out.md"
  };

  for (const type of ["task.started", "task.updated", "task.completed"] as const) {
    it(`${type} carries the whole linkage bundle`, () => {
      const rows = runtimeEventToActivities(
        runtimeEvent(type, {
          taskId: "task-1",
          ...(type === "task.completed" ? { status: "completed" as const } : {}),
          ...linkage
        })
      );
      const payload = payloadOf(rows[0]!);
      assert.equal(payload.agentKind, "agent");
      for (const [key, value] of Object.entries(linkage)) {
        assert.equal(payload[key], value, `${type} lost ${key}`);
      }
    });
  }

  it("task.started keeps an agent's launch prompt verbatim — never the 180-character detail cap", () => {
    // Pages of it, leading and trailing whitespace included: the drill-in shows
    // the prompt the agent was given, not a preview of it (§7.6).
    const prompt = `  Read b.txt and report its first word.\n\n${"Context line.\n".repeat(900)}  `;
    assert.ok(prompt.length > 180 && prompt.length < TASK_PROMPT_MAX_CHARS);
    const [row] = runtimeEventToActivities(
      runtimeEvent("task.started", {
        taskId: "task-1",
        description: "Read b.txt first word",
        prompt,
        ...linkage
      })
    );
    const payload = payloadOf(row!);
    assert.equal(payload.prompt, prompt);
    assert.equal("promptTruncated" in payload, false, "a whole prompt is not marked cut");
    // The description is still the task's name, and still the row's detail.
    assert.equal(payload.detail, "Read b.txt first word");
  });

  it("task.started keeps a prompt of exactly TASK_PROMPT_MAX_CHARS whole, and cuts a longer one there", () => {
    const exact = "p".repeat(TASK_PROMPT_MAX_CHARS);
    const [whole] = runtimeEventToActivities(
      runtimeEvent("task.started", { taskId: "task-1", prompt: exact, ...linkage })
    );
    assert.equal(payloadOf(whole!).prompt, exact);
    assert.equal("promptTruncated" in payloadOf(whole!), false);

    const [cut] = runtimeEventToActivities(
      runtimeEvent("task.started", { taskId: "task-1", prompt: `${exact}and more`, ...linkage })
    );
    assert.equal(payloadOf(cut!).prompt, exact, "the head, at the cap, with no marker text inside it");
    assert.equal(payloadOf(cut!).promptTruncated, true);
  });

  it("task.started never cuts a prompt through a surrogate pair", () => {
    // The pair straddles the cap: keeping its high half would store a lone
    // surrogate, which is no character at all.
    const prompt = `${"p".repeat(TASK_PROMPT_MAX_CHARS - 1)}😀 after`;
    const [row] = runtimeEventToActivities(
      runtimeEvent("task.started", { taskId: "task-1", prompt, ...linkage })
    );
    const stored = payloadOf(row!).prompt;
    assert.equal(stored, "p".repeat(TASK_PROMPT_MAX_CHARS - 1));
    assert.equal(payloadOf(row!).promptTruncated, true);

    // A pair wholly inside the cap is kept whole.
    const inside = `${"p".repeat(TASK_PROMPT_MAX_CHARS - 2)}😀 after`;
    const [kept] = runtimeEventToActivities(
      runtimeEvent("task.started", { taskId: "task-1", prompt: inside, ...linkage })
    );
    assert.equal(payloadOf(kept!).prompt, `${"p".repeat(TASK_PROMPT_MAX_CHARS - 2)}😀`);
    assert.equal(payloadOf(kept!).promptTruncated, true);
  });

  it("task.started without a prompt, or with a blank one, has no prompt key", () => {
    for (const prompt of [undefined, "", "  \n\t "]) {
      const [row] = runtimeEventToActivities(
        runtimeEvent("task.started", {
          taskId: "task-1",
          ...(prompt !== undefined ? { prompt } : {}),
          ...linkage
        })
      );
      const payload = payloadOf(row!);
      assert.equal("prompt" in payload, false, `prompt ${JSON.stringify(prompt)} was written`);
      assert.equal("promptTruncated" in payload, false);
    }
  });

  it("task.progress splits activity and usage onto two stable ids", () => {
    const rows = runtimeEventToActivities(
      runtimeEvent("task.progress", {
        taskId: "task-1",
        description: "Reading files",
        usage: { totalTokens: 500 },
        ...linkage
      })
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, "task-progress:t1:task-1");
    assert.equal(rows[1]!.id, "task-usage:t1:task-1");
    assert.equal(payloadOf(rows[1]!).usageSnapshot, true);
    // The usage row must not carry the status, or a usage tick would blank the
    // last meaningful state.
    assert.equal(payloadOf(rows[1]!).status, undefined);
  });

  it("a usage-only task.progress produces the usage row alone", () => {
    const rows = runtimeEventToActivities(
      runtimeEvent("task.progress", {
        taskId: "task-1",
        description: "",
        usage: { totalTokens: 10 }
      })
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "task-usage:t1:task-1");
  });

  it("task.completed is titled from the remembered description", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("task.completed", { taskId: "task-1", status: "stopped" }),
      { taskTitle: "Refactor the store" }
    );
    assert.ok(row);
    assert.equal(row.summary, "Task stopped");
    assert.equal(payloadOf(row).title, "Refactor the store");
  });

  it("a failed task row is toned error", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("task.completed", { taskId: "task-1", status: "failed" })
    );
    assert.equal(row!.tone, "error");
  });

  it("task.completed carries a shell's exit code — a signal's negative one included", () => {
    for (const exitCode of [0, 2, -15]) {
      const [row] = runtimeEventToActivities(
        runtimeEvent("task.completed", {
          taskId: "task-1",
          taskType: "shell",
          status: exitCode === 0 ? "completed" : "failed",
          exitCode
        })
      );
      assert.equal(payloadOf(row!).exitCode, exitCode, `exit code ${exitCode}`);
    }
    const [unreported] = runtimeEventToActivities(
      runtimeEvent("task.completed", { taskId: "task-1", status: "completed" })
    );
    assert.equal("exitCode" in payloadOf(unreported!), false, "no code reported, none written");
  });

  it("task.completed carries the adapter's left-running marker, and only when set", () => {
    const [marked] = runtimeEventToActivities(
      runtimeEvent("task.completed", {
        taskId: "task-1",
        status: "stopped",
        summary: "Left running when the agent host stopped — stop it from Settings → System.",
        leftRunning: true
      })
    );
    assert.equal(payloadOf(marked!).leftRunning, true);
    const [plain] = runtimeEventToActivities(
      runtimeEvent("task.completed", { taskId: "task-1", status: "stopped", summary: "VITE v5.4.0 ready in 312 ms" })
    );
    assert.equal("leftRunning" in payloadOf(plain!), false);
  });
});

describe("tool progress, denials and diagnostics (§5.1 catch-all)", () => {
  it("parent-conversation tool.progress is ephemeral; only agent-owned heartbeats persist", () => {
    assert.deepEqual(
      runtimeEventToActivities(runtimeEvent("tool.progress", { toolUseId: "tu-1" })),
      []
    );
    const [row] = runtimeEventToActivities(
      runtimeEvent("tool.progress", { toolUseId: "tu-1", taskId: "task-1", toolName: "Bash" })
    );
    assert.ok(row);
    assert.equal(row.id, "tool-progress:t1:task-1");
    assert.equal(row.summary, "Bash");
  });

  it("tool.denied is an error row", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("tool.denied", { toolName: "Bash", reason: "blocked by policy" })
    );
    assert.equal(row!.tone, "error");
    assert.equal(row!.summary, "Tool denied: Bash");
  });

  it("runtime.error keeps its class; runtime.warning uses the message as the label", () => {
    const [error] = runtimeEventToActivities(
      runtimeEvent("runtime.error", { message: "boom", class: "provider_error" })
    );
    assert.equal(error!.tone, "error");
    assert.equal(payloadOf(error!).class, "provider_error");

    const [warning] = runtimeEventToActivities(
      runtimeEvent("runtime.warning", { message: "unmapped frame xyz" })
    );
    assert.equal(warning!.tone, "info");
    assert.equal(warning!.summary, "unmapped frame xyz");
  });

  it("an account failure's reason and reset reach the activity payload (workflows §5.4)", () => {
    const [error] = runtimeEventToActivities(
      runtimeEvent("runtime.error", {
        message: "Claude usage limit reached. Send the message again once the limit resets.",
        class: "provider_error",
        reason: "usage_limit",
        resetsAt: "2026-09-28T22:40:00.000Z"
      })
    );
    assert.equal(payloadOf(error!).reason, "usage_limit");
    assert.equal(payloadOf(error!).resetsAt, "2026-09-28T22:40:00.000Z");

    const [warning] = runtimeEventToActivities(
      runtimeEvent("runtime.warning", { message: "Claude usage limit reached.", reason: "auth" })
    );
    assert.equal(payloadOf(warning!).reason, "auth");
    assert.equal("resetsAt" in payloadOf(warning!), false);

    // A payload without the fields is exactly the row it always was.
    const [plain] = runtimeEventToActivities(
      runtimeEvent("runtime.error", { message: "boom", class: "provider_error" })
    );
    assert.deepEqual(payloadOf(plain!), { message: "boom", class: "provider_error" });
  });

  it("hooks, plans and reroutes become rows", () => {
    assert.equal(
      runtimeEventToActivities(
        runtimeEvent("hook.started", { hookId: "h1", hookName: "fmt", hookEvent: "PostToolUse" })
      )[0]?.activityKind,
      "hook.started"
    );
    const [failed] = runtimeEventToActivities(
      runtimeEvent("hook.completed", { hookId: "h1", outcome: "error", exitCode: 2 })
    );
    assert.equal(failed!.tone, "error");
    assert.equal(
      runtimeEventToActivities(
        runtimeEvent("turn.plan.updated", { plan: [{ step: "a", status: "pending" }] })
      )[0]?.activityKind,
      "turn.plan.updated"
    );
    assert.equal(
      runtimeEventToActivities(
        runtimeEvent("model.rerouted", { fromModel: "a", toModel: "b", reason: "quota" })
      )[0]?.activityKind,
      "model.rerouted"
    );
  });

  it("questions become their own rows", () => {
    const [requested] = runtimeEventToActivities(
      runtimeEvent(
        "user-input.requested",
        { questions: [], dismissible: true, responseMode: "message" },
        { requestId: "q1" }
      )
    );
    assert.equal(requested!.activityKind, "user-input.requested");
    assert.equal(payloadOf(requested!).dismissible, true);
    const [resolved] = runtimeEventToActivities(
      runtimeEvent("user-input.resolved", { answers: { q: "yes" } }, { requestId: "q1" })
    );
    assert.equal(resolved!.activityKind, "user-input.resolved");
  });
});

describe("goals (goals §4.3)", () => {
  const goal: AgentGoal = {
    objective: "Make CI green",
    status: "active",
    rounds: 2,
    lastCheck: "lint still fails",
    tokenBudget: null
  };

  it("one thread.goal.updated is ONE goal.updated row carrying the payload verbatim", () => {
    const payload: GoalUpdatedPayload = { goal, change: "checked" };
    const rows = runtimeEventToActivities(
      runtimeEvent("thread.goal.updated", payload, { eventId: "re-goal", turnId: "turn-7" })
    );
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row!.id, "re-goal");
    assert.equal(row!.activityKind, GOAL_ACTIVITY_KIND);
    assert.equal(row!.tone, "info");
    assert.equal(row!.summary, "Goal check 2: not met — lint still fails");
    assert.equal(row!.turnId, "turn-7");
    assert.deepEqual(row!.payload, payload);
  });

  it("a goal outside a turn is turnless, and no row ever names an agent", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent(
        "thread.goal.updated",
        { goal: null, change: "cleared", previous: goal },
        { agentId: "agent-1" }
      )
    );
    assert.equal(row!.turnId, null);
    assert.equal(row!.agentId, undefined);
    assert.equal("agentId" in payloadOf(row!), false);
    assert.equal(row!.summary, "Goal cleared: Make CI green");
  });

  it("only a failed goal is error-toned", () => {
    for (const change of AGENT_GOAL_CHANGES) {
      const [row] = runtimeEventToActivities(
        runtimeEvent("thread.goal.updated", { goal: null, change, previous: goal })
      );
      assert.equal(row!.tone, change === "failed" ? "error" : "info", change);
    }
  });

  it("the row text is §4.3's: a long objective is cut, the payload keeps it whole", () => {
    const objective = `Refactor ${"the billing module ".repeat(30)}`;
    const payload: GoalUpdatedPayload = {
      goal: { objective, status: "active", rounds: 0 },
      change: "set"
    };
    const [row] = runtimeEventToActivities(runtimeEvent("thread.goal.updated", payload));
    assert.ok(row!.summary.startsWith("Goal set: Refactor the billing module"));
    assert.ok(row!.summary.endsWith("…"));
    assert.ok(row!.summary.length <= "Goal set: ".length + 200);
    assert.equal((payloadOf(row!).goal as AgentGoal).objective, objective);

    const [limited] = runtimeEventToActivities(
      runtimeEvent("thread.goal.updated", {
        goal: { ...goal, status: "usage-limited" },
        change: "limited"
      })
    );
    assert.equal(limited!.summary, "Goal stopped: usage limit reached");
  });

  it("a cleared goal's row keeps the goal that ended, verbatim", () => {
    const [row] = runtimeEventToActivities(
      runtimeEvent("thread.goal.updated", { goal: null, change: "cleared", previous: goal })
    );
    assert.deepEqual(row!.payload, { goal: null, change: "cleared", previous: goal });
  });

  it("every hidden progress row of a thread shares ONE stable id — the latest replaces it in place", () => {
    // A `progress` row is the goal's latest state, not history (§8.4 hides
    // it): a fresh id per tick would spend one slot of the 500-row parent
    // window on each, like the `task-progress:` rows before them.
    const rows = [1, 2, 3].map((rounds) =>
      runtimeEventToActivities(
        runtimeEvent(
          "thread.goal.updated",
          { goal: { ...goal, rounds }, change: "progress" },
          { threadId: "thread-9" }
        )
      )[0]!
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ["goal-progress:thread-9", "goal-progress:thread-9", "goal-progress:thread-9"]
    );
    assert.equal(rows[2]!.summary, "Goal progress");
    assert.deepEqual(rows[2]!.payload, { goal: { ...goal, rounds: 3 }, change: "progress" });
    // Every other change is a row of its own, history the timeline shows.
    for (const change of AGENT_GOAL_CHANGES.filter((entry) => entry !== "progress")) {
      const [row] = runtimeEventToActivities(
        runtimeEvent("thread.goal.updated", { goal, change }, { eventId: `re-${change}` })
      );
      assert.equal(row!.id, `re-${change}`, change);
    }
  });

  it("a goal event replayed out of the provider's history produces nothing", () => {
    // Adapters must not emit goal events from replayed history (goals §6.3);
    // ingestion refuses one anyway, so a replay can never move the goal.
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent(
          "thread.goal.updated",
          { goal, change: "restored" },
          { raw: { source: HISTORICAL_RAW_SOURCE, payload: {} } }
        )
      ),
      []
    );
  });
});

describe("events that are not thread facts (§5.1)", () => {
  it("auth.status and account.rate-limits.updated update the provider snapshot, not the thread", () => {
    assert.deepEqual(runtimeEventToActivities(runtimeEvent("auth.status", {})), []);
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("account.rate-limits.updated", { limits: { windows: [] } })
      ),
      []
    );
  });

  it("session, turn and content events produce no activity of their own", () => {
    assert.deepEqual(runtimeEventToActivities(runtimeEvent("session.started", {})), []);
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("session.state.changed", { state: "running" })
      ),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("session.exited", { recoverable: true, exitKind: "graceful" })
      ),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(runtimeEvent("thread.started", { providerThreadId: "p1" })),
      []
    );
    assert.deepEqual(runtimeEventToActivities(runtimeEvent("turn.started", {})), []);
    assert.deepEqual(
      runtimeEventToActivities(runtimeEvent("turn.completed", { state: "completed" })),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(runtimeEvent("turn.aborted", { reason: "user" })),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(
        runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "hi" })
      ),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(runtimeEvent("turn.diff.updated", { unifiedDiff: "" })),
      []
    );
    assert.deepEqual(
      runtimeEventToActivities(runtimeEvent("thread.metadata.updated", { name: "x" })),
      []
    );
  });
});
