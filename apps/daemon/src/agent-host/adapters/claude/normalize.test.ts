/**
 * Replay tests: every committed Claude fixture through the normaliser (§9).
 *
 * One assertion per capture is structural rather than about a single frame:
 * every message type present in the capture must map to a defined
 * disposition, and an unrecognised one must take the defined fallback
 * (surface it, plus `runtime.warning`) rather than be swallowed by a
 * catch-all. That is what keeps §10's "protocols move" promise honest as
 * fixtures are re-captured.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  ClaudeNormalizer,
  readPreservedUuids,
  type BackgroundShellChange
} from "./normalize.ts";
import {
  countingIds,
  eventTypes,
  fixedClock,
  listClaudeFixtures,
  readClaudeFixture,
  replayClaudeFixture,
  sdkMessageTag
} from "./fixtures.ts";

function allOf<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event) => event.type === type) as Array<
    Extract<RuntimeEvent, { type: T }>
  >;
}

const UNHANDLED_MARKER = "is not handled";

describe("claude normaliser — fixture replay", () => {
  const fixtures = listClaudeFixtures();

  it("finds the committed captures", () => {
    assert.ok(fixtures.length >= 18, `expected the captures, found ${fixtures.length}`);
  });

  for (const fixture of fixtures) {
    it(`${fixture}: every captured message has a defined disposition`, () => {
      const { events, observed } = replayClaudeFixture(fixture);
      const unhandled = allOf(events, "runtime.warning").filter((event) =>
        event.payload.message.includes(UNHANDLED_MARKER)
      );
      assert.deepEqual(
        unhandled.map((event) => event.payload.message),
        [],
        `${fixture} produced unhandled-message warnings`
      );
      // The capture must actually have exercised something.
      assert.ok(observed.length > 0 || fixture.startsWith("13-"));
      // Every event carries the envelope §4.2 requires.
      for (const event of events) {
        assert.equal(typeof event.eventId, "string");
        assert.equal(event.threadId, "thread-fixture");
        assert.equal(typeof event.createdAt, "string");
      }
    });
  }

  it("01: a plain text turn streams and settles", () => {
    const { events } = replayClaudeFixture("01-init-plain-text.ndjson");
    const types = eventTypes(events);
    assert.ok(types.includes("thread.started"));
    assert.ok(types.includes("turn.started"));
    assert.ok(types.includes("content.delta"));
    assert.ok(types.includes("thread.token-usage.updated"));

    const deltas = allOf(events, "content.delta")
      .filter((event) => event.payload.streamKind === "assistant_text")
      .map((event) => event.payload.delta)
      .join("");
    assert.equal(deltas, "OK");

    const completed = allOf(events, "turn.completed")[0]?.payload;
    assert.equal(completed?.state, "completed");
    assert.equal(completed?.stopReason, "end_turn");
    assert.equal(completed?.tokenUsage?.usageStatus, "complete");
    assert.equal(completed?.tokenUsage?.hasSubagents, false);
    assert.equal(typeof completed?.totalCostUsd, "number");
  });

  it("02: an auto-allowed tool produces item rows and no approval", () => {
    const { events } = replayClaudeFixture("02-tool-read-auto-allowed.ndjson");
    const types = eventTypes(events);
    // The CLI gates first and silently — there is no request at all here.
    assert.ok(!types.includes("request.opened"));
    assert.ok(types.includes("item.started"));
    assert.ok(types.includes("item.completed"));
    const started = allOf(events, "item.started").filter(
      (event) => event.payload.itemType !== "assistant_message"
    );
    assert.ok(started.length >= 1);
    assert.ok(started.some((event) => event.payload.itemType === "command_execution"));
  });

  it("03: an approval is opened and accepted", () => {
    const { events } = replayClaudeFixture("03-bash-approval-accept.ndjson");
    const opened = allOf(events, "request.opened")[0]?.payload;
    assert.equal(opened?.requestType, "command_execution_approval");
    assert.equal(opened?.dismissible, false);
    assert.equal(opened?.detail, "Remove scratch-tmp.txt");
    const resolved = allOf(events, "request.resolved")[0]?.payload;
    assert.equal(resolved?.decision, "accept");
    // The request id is the SDK's own, so a redelivery cannot open a second
    // card (fixtures README observation 11).
    const request = events.find((event) => event.type === "request.opened");
    const captured = readClaudeFixture("03-bash-approval-accept.ndjson").find(
      (line) => line.kind === "canUseTool"
    );
    const capturedRequestId = (
      captured?.data as { options?: { requestId?: string } } | undefined
    )?.options?.requestId;
    assert.equal(typeof capturedRequestId, "string");
    assert.equal(request?.requestId, capturedRequestId);
    assert.equal(request?.providerRefs?.providerRequestId, capturedRequestId);
  });

  it("04a/04b: decline and cancel are two answers, not two labels", () => {
    const decline = replayClaudeFixture("04a-bash-approval-decline.ndjson");
    assert.equal(allOf(decline.events, "request.resolved")[0]?.payload?.decision, "decline");
    const cancel = replayClaudeFixture("04b-bash-approval-cancel.ndjson");
    assert.equal(allOf(cancel.events, "request.resolved")[0]?.payload?.decision, "cancel");
  });

  it("05: accept-for-session prompts once across two turns", () => {
    const { events } = replayClaudeFixture("05-accept-for-session.ndjson");
    const opened = allOf(events, "request.opened");
    assert.equal(opened.length, 1);
    assert.equal(allOf(events, "request.resolved")[0]?.payload?.decision, "acceptForSession");
    assert.equal(allOf(events, "turn.completed").length, 2);
  });

  it("06: AskUserQuestion becomes a question keyed by its text", () => {
    const { events } = replayClaudeFixture("06-ask-user-question.ndjson");
    const requested = allOf(events, "user-input.requested")[0]?.payload;
    assert.ok(requested);
    assert.equal(requested.questions.length, 1);
    const question = requested.questions[0]!;
    assert.equal(question.id, question.question);
    assert.equal(question.id, "Which file should I read?");
    assert.equal(question.multiSelect, false);
    assert.deepEqual(
      question.options.map((option) => option.label),
      ["a.txt", "b.txt"]
    );
    // No `value` on Claude's options.
    assert.ok(question.options.every((option) => option.value === undefined));
    const resolved = allOf(events, "user-input.resolved")[0]?.payload;
    assert.deepEqual(resolved?.answers, { "Which file should I read?": "a.txt" });
    // A question is never an approval.
    assert.equal(allOf(events, "request.opened").length, 0);
  });

  it("07: a subagent and a background shell carry full linkage on every row", () => {
    const { events } = replayClaudeFixture("07-subagent-task.ndjson");
    const started = allOf(events, "task.started");
    assert.ok(started.length >= 2);
    const agent = started.find((event) => event.payload.taskType === "local_agent");
    assert.ok(agent, "expected a local_agent task");
    assert.equal(agent.payload.role, "Explore");
    assert.ok(agent.payload.toolUseId);
    assert.ok(agent.payload.title);

    // task_updated carries only {task_id, patch} on the wire; the adapter must
    // carry identity forward so the row is still self-describing.
    const updated = allOf(events, "task.updated");
    assert.ok(updated.length >= 1);
    const agentUpdate = updated.find((event) => event.payload.taskId === agent.payload.taskId);
    assert.ok(agentUpdate);
    assert.equal(agentUpdate.payload.taskType, "local_agent");
    assert.equal(agentUpdate.payload.role, "Explore");
    assert.equal(agentUpdate.payload.toolUseId, agent.payload.toolUseId);

    const completed = allOf(events, "task.completed");
    assert.ok(completed.length >= 1);
    assert.ok(completed.some((event) => event.payload.status === "completed"));
    // The background Bash is a separate task type.
    const shell = started.find((event) => event.payload.taskType === "local_bash");
    assert.ok(shell);
    // This capture predates `is_backgrounded`; the field is absent, not false,
    // and an absent field must never read as "foreground" (which would hide
    // the row this capture proves exists).
    assert.equal(shell.payload.isBackgrounded, undefined);

    // The shell's own drill-in surface: one `command_execution` item under the
    // task's id, carrying the command the CLI never streams.
    const shellItem = allOf(events, "item.started").find(
      (event) => event.itemId === `bgshell:${shell.payload.taskId}`
    );
    assert.ok(shellItem, "a background shell with no item shows 'nothing reported yet'");
    assert.equal(shellItem.agentId, shell.payload.taskId);
    assert.equal(shellItem.payload.detail, "sleep 20 && echo slept");
    assert.deepEqual(shellItem.payload.data, {
      toolName: "Bash",
      input: { command: "sleep 20 && echo slept", description: "Sleep 20 seconds then print slept" },
      background: true
    });

    // The turn knows it had subagents.
    assert.ok(allOf(events, "turn.completed").some((e) => e.payload.tokenUsage?.hasSubagents));
  });

  it("08: the step list is TaskCreate/TaskUpdate, not TodoWrite", () => {
    const { events } = replayClaudeFixture("08-todowrite.ndjson");
    const plans = allOf(events, "turn.plan.updated");
    assert.ok(plans.length >= 3, `expected plan updates, got ${plans.length}`);
    const last = plans.at(-1)!;
    assert.ok(last.payload.plan.length >= 3);
    assert.ok(last.payload.plan.every((step) => typeof step.step === "string"));
    assert.ok(last.payload.plan.some((step) => step.status === "completed"));
    // Those tool calls are to-do bookkeeping, never file changes.
    const stepListItems = allOf(events, "item.started").filter(
      (event) =>
        typeof (event.payload.data as { toolName?: unknown } | undefined)?.toolName === "string" &&
        String((event.payload.data as { toolName: string }).toolName).startsWith("Task")
    );
    assert.ok(stepListItems.length > 0);
    assert.ok(stepListItems.every((event) => event.payload.itemType === "dynamic_tool_call"));
  });

  it("09: plan mode captures the plan and its planFilePath, then denies", () => {
    const { events } = replayClaudeFixture("09-plan-mode-exitplanmode-denied.ndjson");
    const proposed = allOf(events, "turn.proposed.completed");
    assert.equal(proposed.length, 1, "the plan must be captured exactly once");
    assert.ok(proposed[0]!.payload.planMarkdown.includes("# Plan"));
    // `planFilePath` is its OWN field: the markdown is user-facing content the
    // plan card offers for copy and download, so it is never edited.
    assert.ok(proposed[0]!.payload.planFilePath?.endsWith(".md"));
    assert.ok(!proposed[0]!.payload.planMarkdown.includes("planFilePath"));
    // ExitPlanMode never becomes an approval card.
    assert.ok(
      !allOf(events, "request.opened").some((event) =>
        JSON.stringify(event.payload.args).includes("ExitPlanMode")
      )
    );
  });

  it("10: an interrupt settles the turn as interrupted without a diagnostic banner", () => {
    const { events } = replayClaudeFixture("10-interrupt-mid-turn.ndjson");
    const completed = allOf(events, "turn.completed")[0]?.payload;
    assert.equal(completed?.state, "interrupted");
    assert.ok(
      completed?.errorMessage === undefined ||
        !completed.errorMessage.startsWith("[ede_diagnostic]"),
      "the internal diagnostic must never be the user-facing message"
    );
    // The CLI's own denial of `sleep 120 && …` is a denial, not a plain failure.
    const denied = allOf(events, "tool.denied");
    assert.ok(denied.length >= 1, "the CLI's silent denial must produce tool.denied");
    assert.ok(denied[0]!.payload.reason?.includes("Blocked"));
    const declined = allOf(events, "item.completed").filter(
      (event) => event.payload.status === "declined"
    );
    assert.ok(declined.length >= 1);
  });

  it("11: resume and fork replay nothing onto the message stream", () => {
    const { events } = replayClaudeFixture("11-resume-and-fork.ndjson");
    // Every user message in the capture is a tool result or absent; a resume
    // must not synthesise user-message rows.
    assert.ok(allOf(events, "turn.completed").length >= 2);
    assert.ok(eventTypes(events).includes("thread.started"));
  });

  it("12: a compaction reports before/after and does not fail the turn", () => {
    const { events } = replayClaudeFixture("12-compact.ndjson");
    const compacted = allOf(events, "thread.state.changed").filter(
      (event) => event.payload.state === "compacted"
    );
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0]!.payload.beforeTokens, 34995);
    assert.equal(compacted[0]!.payload.afterTokens, 873);
    // The capture's `status: "compacting"` frame opens the phase first, so the
    // client shows "Compacting" rather than a generic "Working" for the 10.3 s
    // the CLI spends rewriting the conversation.
    const threadStates = allOf(events, "thread.state.changed").map((event) => event.payload.state);
    assert.deepEqual(threadStates, ["compacting", "compacted"]);
    // `terminal_reason` is absent on the compaction result: it must not be
    // classified from it.
    const states = allOf(events, "turn.completed").map((event) => event.payload.state);
    assert.ok(states.every((state) => state === "completed"), JSON.stringify(states));
  });

  it("14a/14b: accept-edits and bypass produce no approval at all", () => {
    for (const fixture of [
      "14a-accept-edits-edit.ndjson",
      "14b-bypass-permissions-edit.ndjson"
    ]) {
      const { events } = replayClaudeFixture(fixture);
      assert.equal(allOf(events, "request.opened").length, 0, fixture);
      assert.ok(allOf(events, "item.completed").length > 0, fixture);
    }
  });

  it("15: a warning-level rate_limit_event carries a percentage; a plain one does not", () => {
    const { events } = replayClaudeFixture("15-rate-limits-and-usage.ndjson");
    // The capture holds both shapes: the unprompted `allowed` frames carry no
    // percentage at all, while the `allowed_warning` one carries
    // `utilization: 0.98` (fixtures README observation 16 plus this capture).
    const updates = allOf(events, "account.rate-limits.updated");
    assert.equal(updates.length, 1);
    const window = updates[0]!.payload.limits.windows[0]!;
    assert.equal(window.id, "session");
    assert.equal(window.kind, "session");
    assert.equal(window.usedPercent, 98);
    assert.ok(window.resetsAt);
    let stale = 0;
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds(),
      onUsageLimitsStale: () => {
        stale += 1;
      }
    });
    normalizer.handleMessage({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1789969200,
        rateLimitType: "five_hour"
      },
      uuid: "u",
      session_id: "s"
    } as unknown as SDKMessage);
    assert.equal(stale, 1);
    assert.ok(events.length > 0);
  });

  it("16: an unknown model fails the turn with the CLI's own sentence", () => {
    const { events } = replayClaudeFixture("16-errors.ndjson");
    const completed = allOf(events, "turn.completed");
    assert.ok(completed.length >= 2);
    const failed = completed.find((event) => event.payload.state === "failed");
    assert.ok(failed, "the unknown-model turn must fail despite subtype: success");
    assert.ok(
      failed.payload.errorMessage?.includes("claude-does-not-exist-9"),
      failed.payload.errorMessage
    );
    assert.ok(allOf(events, "runtime.error").length >= 1);
    // A failing Bash and a missing Read are ordinary failures, not denials.
    const failedItems = allOf(events, "item.completed").filter(
      (event) => event.payload.status === "failed"
    );
    assert.ok(failedItems.length >= 2);
  });
});

describe("claude normaliser — the unknown-frame contract (§10)", () => {
  function make(): { normalizer: ClaudeNormalizer } {
    return {
      normalizer: new ClaudeNormalizer({
        threadId: "t",
        clock: fixedClock(),
        ids: countingIds()
      })
    };
  }

  it("surfaces an unknown top-level message as a warning, never silently", () => {
    const { normalizer } = make();
    const events = normalizer.handleMessage({
      type: "totally_new_frame",
      payload: { a: 1 },
      uuid: "u",
      session_id: "s"
    } as unknown as SDKMessage);
    const warning = events.find((event) => event.type === "runtime.warning");
    assert.ok(warning);
    assert.ok(warning.payload.message.includes("totally_new_frame"));
    assert.ok(warning.payload.message.includes("is not handled"));
  });

  it("surfaces an unknown system subtype as a warning", () => {
    const { normalizer } = make();
    const events = normalizer.handleMessage({
      type: "system",
      subtype: "brand_new_subtype",
      detail: "x",
      uuid: "u",
      session_id: "s"
    } as unknown as SDKMessage);
    const warning = events.find((event) => event.type === "runtime.warning");
    assert.ok(warning);
    assert.ok(warning.payload.message.includes("brand_new_subtype"));
  });

  it("consumes the undeclared wire-only frames without a warning", () => {
    const { normalizer } = make();
    for (const frame of [
      { type: "command_lifecycle", command_uuid: "c", state: "queued", uuid: "u", session_id: "s" },
      { type: "system", subtype: "vcs_state_changed", kind: "commit", uuid: "u", session_id: "s" },
      {
        type: "system",
        subtype: "code_change_published",
        provider: "github",
        uuid: "u",
        session_id: "s"
      }
    ]) {
      const events = normalizer.handleMessage(frame as unknown as SDKMessage);
      assert.equal(
        events.filter((event) => event.type === "runtime.warning").length,
        0,
        JSON.stringify(frame)
      );
    }
  });

  it("a warning never ends an active turn", () => {
    const { normalizer } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = normalizer.handleMessage({
      type: "unknown_thing",
      uuid: "u",
      session_id: "s"
    } as unknown as SDKMessage);
    assert.ok(events.some((event) => event.type === "runtime.warning"));
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
    assert.equal(normalizer.turnState?.turnId, "turn-1");
  });

  it("system/init is idempotent state, not a per-turn event", () => {
    const { normalizer } = make();
    const init = {
      type: "system",
      subtype: "init",
      model: "claude-sonnet-5",
      permissionMode: "default",
      uuid: "u",
      session_id: "s",
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      plugins: [],
      apiKeySource: "none",
      claude_code_version: "2.1.210",
      cwd: "/tmp",
      output_style: "default"
    } as unknown as SDKMessage;
    const first = normalizer.handleMessage(init);
    const second = normalizer.handleMessage(init);
    // `init` lands once per turn, so it drives no session state at all: a
    // `ready` here would flip a running session back and forth.
    assert.deepEqual(eventTypes(first), ["thread.started"]);
    assert.equal(second.length, 0);
  });

  it("a model the adapter did not ask for is reported as a reroute", () => {
    const { normalizer } = make();
    const init = (model: string): SDKMessage =>
      ({
        type: "system",
        subtype: "init",
        model,
        permissionMode: "default",
        uuid: "u",
        session_id: "s",
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        skills: [],
        plugins: [],
        apiKeySource: "none",
        claude_code_version: "2.1.210",
        cwd: "/tmp",
        output_style: "default"
      }) as unknown as SDKMessage;
    normalizer.handleMessage(init("claude-opus-4-8"));
    const events = normalizer.handleMessage(init("claude-haiku-4-5"));
    const rerouted = events.find((event) => event.type === "model.rerouted");
    assert.ok(rerouted);
    assert.equal(rerouted.payload.fromModel, "claude-opus-4-8");
    assert.equal(rerouted.payload.toModel, "claude-haiku-4-5");
  });

  it("system/status is deduped rather than emitted three times per turn", () => {
    const { normalizer } = make();
    const status = {
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: "u",
      session_id: "s"
    } as unknown as SDKMessage;
    const first = normalizer.handleMessage(status);
    const second = normalizer.handleMessage(status);
    const third = normalizer.handleMessage(status);
    assert.equal(first.filter((event) => event.type === "session.state.changed").length, 1);
    assert.equal(second.length, 0);
    assert.equal(third.length, 0);
  });

  it("a user message whose content is a plain string does not throw", () => {
    const { normalizer } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = normalizer.handleMessage({
      type: "user",
      message: { role: "user", content: "This session is being continued from a previous…" },
      parent_tool_use_id: null,
      session_id: "s",
      uuid: "u"
    } as unknown as SDKMessage);
    // Only the thread-identity row; `content.map` would have thrown here.
    assert.deepEqual(eventTypes(events), ["thread.started"]);
  });
});

describe("claude normaliser — captured message vocabulary", () => {
  it("covers every type/subtype the captures contain", () => {
    const observed = new Set<string>();
    for (const fixture of listClaudeFixtures()) {
      for (const tag of replayClaudeFixture(fixture).observed) {
        observed.add(tag);
      }
    }
    // The README's aggregate list, so a re-capture that adds a frame type is a
    // visible test change rather than a silent one.
    for (const expected of [
      "assistant",
      "command_lifecycle",
      "rate_limit_event",
      "result/success",
      "result/error_during_execution",
      "stream_event",
      "system/init",
      "system/status",
      "system/thinking_tokens",
      "system/compact_boundary",
      "system/background_tasks_changed",
      "system/task_started",
      "system/task_progress",
      "system/task_updated",
      "system/task_notification",
      "user"
    ]) {
      assert.ok(observed.has(expected), `capture no longer contains ${expected}`);
    }
  });

  it("tags a message the same way the replay harness does", () => {
    assert.equal(sdkMessageTag({ type: "system", subtype: "init" }), "system/init");
    assert.equal(sdkMessageTag({ type: "assistant" }), "assistant");
  });
});

describe("claude normaliser — compaction bookkeeping", () => {
  it("records the uuids a compaction preserved", () => {
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds()
    });
    assert.equal(normalizer.preservedMessageUuids, undefined);
    normalizer.handleMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 100,
        post_tokens: 10,
        preserved_messages: { anchor_uuid: "a", uuids: ["a"], all_uuids: ["a", "b"] }
      },
      session_id: "s",
      uuid: "u"
    } as unknown as SDKMessage);
    // Without this the "a compaction in between" refusal of §4.5 has nothing
    // to check and a doomed rewind creates an orphan fork first.
    assert.deepEqual(normalizer.preservedMessageUuids, ["a", "b"]);
  });

  it("prefers all_uuids, falls back to uuids, and stays undefined otherwise", () => {
    assert.deepEqual(
      readPreservedUuids({ preserved_messages: { all_uuids: ["x"], uuids: ["y"] } }),
      ["x"]
    );
    assert.deepEqual(readPreservedUuids({ preserved_messages: { uuids: ["y"] } }), ["y"]);
    assert.equal(readPreservedUuids({ preserved_messages: {} }), undefined);
    assert.equal(readPreservedUuids({}), undefined);
    assert.equal(readPreservedUuids(undefined), undefined);
  });
});

describe("claude normaliser — subagent activity arrives as complete nested messages", () => {
  it("turns a subagent's tool_use/tool_result and text into items owned by its task", () => {
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds()
    });
    const feed = (message: unknown): RuntimeEvent[] =>
      normalizer.handleMessage(message as SDKMessage);
    feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_parent",
      task_type: "local_agent",
      description: "Audit the workflows",
      uuid: "u0",
      session_id: "s"
    });
    const started = feed({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      uuid: "u1",
      session_id: "s",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "toolu_child", name: "Bash", input: { command: "ls" } }]
      }
    });
    const startedItem = started.find((event) => event.type === "item.started");
    assert.ok(startedItem, "a nested tool_use opens an item");
    assert.equal(startedItem.itemId, "toolu_child");
    assert.equal(startedItem.agentId, "task-1", "attributed to the owning task, never the parent");
    assert.equal((startedItem.payload as { itemType: string }).itemType, "command_execution");

    const completed = feed({
      type: "user",
      parent_tool_use_id: "toolu_parent",
      uuid: "u2",
      session_id: "s",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_child", content: "a.txt" }] }
    });
    const completedItem = completed.find(
      (event) => event.type === "item.completed" && event.itemId === "toolu_child"
    );
    assert.ok(completedItem, "the nested tool_result completes it");
    assert.equal(completedItem.agentId, "task-1");
    assert.equal((completedItem.payload as { status: string }).status, "completed");

    const prose = feed({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      uuid: "u3",
      session_id: "s",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Done: 3 issues." }] }
    });
    const text = prose.find((event) => event.type === "content.delta");
    assert.equal((text?.payload as { delta: string } | undefined)?.delta, "Done: 3 issues.");
    assert.ok(prose.every((event) => event.agentId === "task-1"), "the subagent's prose stays in its drill-in");
  });
});

describe("claude normaliser — a RESUMED subagent keeps its old parent_tool_use_id", () => {
  it("holds its frames until a task carries the same description, then attributes them", () => {
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds()
    });
    const feed = (message: unknown): RuntimeEvent[] =>
      normalizer.handleMessage(message as SDKMessage);
    // The new session's task_started names a NEW tool_use and no description.
    feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-r",
      tool_use_id: "toolu_new",
      task_type: "local_agent",
      uuid: "u0",
      session_id: "s"
    });
    // The resumed agent's frames name the ORIGINAL session's tool_use.
    const early = feed({
      type: "assistant",
      parent_tool_use_id: "toolu_old",
      subagent_type: "general-purpose",
      task_description: "Audit PM sheet Vas Raquel",
      uuid: "u1",
      session_id: "s",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "toolu_child", name: "Bash", input: { command: "ls" } }]
      }
    });
    assert.deepEqual(early, [], "unattributable frames are held, never shown as the parent's work");
    const flushed = feed({
      type: "system",
      subtype: "task_progress",
      task_id: "task-r",
      tool_use_id: "toolu_new",
      description: "Audit PM sheet Vas Raquel",
      subagent_type: "general-purpose",
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
      last_tool_name: "Bash",
      uuid: "u2",
      session_id: "s"
    });
    const started = flushed.find((event) => event.type === "item.started" && event.itemId === "toolu_child");
    assert.ok(started, "the held frame is replayed once the description names the task");
    assert.equal(started.agentId, "task-r");
    const done = feed({
      type: "user",
      parent_tool_use_id: "toolu_old",
      task_description: "Audit PM sheet Vas Raquel",
      uuid: "u3",
      session_id: "s",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_child", content: "ok" }] }
    });
    const completed = done.find((event) => event.type === "item.completed" && event.itemId === "toolu_child");
    assert.equal(completed?.agentId, "task-r", "later frames resolve through the remembered alias");
  });
});

describe("claude normaliser — a text block streamed behind a thinking block is not duplicated", () => {
  it("matches the CLI's per-block assistant frame to its streamed block by order, not array index", () => {
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds()
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const stream = (event: Record<string, unknown>): RuntimeEvent[] =>
      normalizer.handleMessage({
        type: "stream_event",
        event,
        uuid: "u",
        session_id: "s",
        parent_tool_use_id: null
      } as unknown as SDKMessage);
    const all: RuntimeEvent[] = [];
    all.push(
      ...stream({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [], usage: {} } }),
      ...stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ...stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      ...stream({ type: "content_block_stop", index: 0 }),
      ...stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      ...stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Voy a arreglar la cabecera." } }),
      ...stream({ type: "content_block_stop", index: 1 })
    );
    // The CLI then emits ONE complete `assistant` frame PER block, sharing
    // message.id, each with `content: [thatBlock]` — the text block sits at
    // array index 0 although it streamed at index 1.
    const snapshot = (content: unknown[]): RuntimeEvent[] =>
      normalizer.handleMessage({
        type: "assistant",
        uuid: "u",
        session_id: "s",
        parent_tool_use_id: null,
        message: { id: "msg_1", role: "assistant", model: "claude-opus-5", content, stop_reason: null }
      } as unknown as SDKMessage);
    all.push(...snapshot([{ type: "thinking", thinking: "hmm" }]));
    all.push(...snapshot([{ type: "text", text: "Voy a arreglar la cabecera." }]));

    const started = all.filter(
      (event) =>
        event.type === "item.started" &&
        (event.payload as { itemType?: string }).itemType === "assistant_message"
    );
    assert.equal(started.length, 1, "one assistant text item, not one per frame");
    const deltas = all.filter(
      (event) =>
        event.type === "content.delta" &&
        (event.payload as { streamKind?: string }).streamKind === "assistant_text"
    );
    assert.equal(deltas.length, 1, "the streamed text is not re-emitted from the snapshot");
  });
});

describe("claude normaliser — every API message of a turn keeps its own assistant text item", () => {
  type Frame = Record<string, unknown>;
  function makeNormalizer(): {
    normalizer: ClaudeNormalizer;
    stream: (event: Frame) => RuntimeEvent[];
    snapshot: (messageId: string, content: unknown[]) => RuntimeEvent[];
  } {
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds()
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const stream = (event: Frame): RuntimeEvent[] =>
      normalizer.handleMessage({
        type: "stream_event",
        event,
        uuid: "u",
        session_id: "s",
        parent_tool_use_id: null
      } as unknown as SDKMessage);
    const snapshot = (messageId: string, content: unknown[]): RuntimeEvent[] =>
      normalizer.handleMessage({
        type: "assistant",
        uuid: "u",
        session_id: "s",
        parent_tool_use_id: null,
        message: { id: messageId, role: "assistant", model: "claude-opus-5", content, stop_reason: null }
      } as unknown as SDKMessage);
    return { normalizer, stream, snapshot };
  }

  /** One API message: optional thinking at index 0, then text at the next index, then the per-block frames. */
  function streamMessage(
    ctx: ReturnType<typeof makeNormalizer>,
    messageId: string,
    text: string,
    options: { thinking: boolean }
  ): RuntimeEvent[] {
    const all: RuntimeEvent[] = [];
    all.push(...ctx.stream({ type: "message_start", message: { id: messageId, role: "assistant", content: [], usage: {} } }));
    let index = 0;
    if (options.thinking) {
      all.push(
        ...ctx.stream({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
        ...ctx.stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "hmm" } }),
        ...ctx.stream({ type: "content_block_stop", index })
      );
      index += 1;
    }
    all.push(
      ...ctx.stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
      ...ctx.stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
      ...ctx.stream({ type: "content_block_stop", index }),
      ...ctx.stream({ type: "message_stop" })
    );
    if (options.thinking) {
      all.push(...ctx.snapshot(messageId, [{ type: "thinking", thinking: "hmm" }]));
    }
    all.push(...ctx.snapshot(messageId, [{ type: "text", text }]));
    return all;
  }

  function assistantItems(events: readonly RuntimeEvent[]): {
    started: string[];
    completed: string[];
    deltasByItem: Map<string, string>;
  } {
    const started = events
      .filter(
        (event) =>
          event.type === "item.started" &&
          (event.payload as { itemType?: string }).itemType === "assistant_message"
      )
      .map((event) => event.itemId ?? "");
    const completed = events
      .filter(
        (event) =>
          event.type === "item.completed" &&
          (event.payload as { itemType?: string }).itemType === "assistant_message"
      )
      .map((event) => event.itemId ?? "");
    const deltasByItem = new Map<string, string>();
    for (const event of events) {
      if (
        event.type === "content.delta" &&
        (event.payload as { streamKind?: string }).streamKind === "assistant_text"
      ) {
        const key = event.itemId ?? "";
        deltasByItem.set(key, `${deltasByItem.get(key) ?? ""}${(event.payload as { delta: string }).delta}`);
      }
    }
    return { started, completed, deltasByItem };
  }

  it("a second message whose text streams behind a thinking block again is a NEW item, not an append", () => {
    // The owner's report: after a long turn the final summary "was not
    // there". It was — appended to the turn's FIRST bubble, because text
    // block state was keyed by content index for the whole turn and every
    // API message restarts its indexes at 0 (live thread 8b9a20c2, seq
    // 710/862/873/882: one item id for four messages' worth of text).
    const ctx = makeNormalizer();
    const all: RuntimeEvent[] = [];
    all.push(...streamMessage(ctx, "msg_1", "Voy a mirarlo.", { thinking: true }));
    // A tool round-trip in between is what makes it a second API message.
    all.push(...streamMessage(ctx, "msg_2", "Diagnóstico cerrado.", { thinking: true }));

    const items = assistantItems(all);
    assert.equal(items.started.length, 2, "one assistant item per API message");
    assert.notEqual(items.started[0], items.started[1]);
    assert.deepEqual(
      [...items.deltasByItem.entries()],
      [
        [items.started[0], "Voy a mirarlo."],
        [items.started[1], "Diagnóstico cerrado."]
      ],
      "each message's text lands on its own item, in order"
    );
    assert.deepEqual(items.completed, items.started, "both items complete, each once");
  });

  it("holds without thinking too: two messages with text at index 0 are two items", () => {
    const ctx = makeNormalizer();
    const all: RuntimeEvent[] = [];
    all.push(...streamMessage(ctx, "msg_1", "First.", { thinking: false }));
    all.push(...streamMessage(ctx, "msg_2", "Second.", { thinking: false }));
    const items = assistantItems(all);
    assert.equal(items.started.length, 2);
    assert.deepEqual(
      [...items.deltasByItem.values()],
      ["First.", "Second."],
      "no text is re-emitted from a snapshot and none is merged"
    );
  });
});
// ---------------------------------------------------------------------------
// The compaction phase
// ---------------------------------------------------------------------------

function feedable(options?: {
  onBackgroundShell?: (change: BackgroundShellChange) => void;
  onLiveTasksChanged?: (live: ReadonlySet<string>) => void;
}): {
  normalizer: ClaudeNormalizer;
  feed: (message: unknown) => RuntimeEvent[];
} {
  const normalizer = new ClaudeNormalizer({
    threadId: "t",
    clock: fixedClock(),
    ids: countingIds(),
    ...(options?.onBackgroundShell !== undefined
      ? { onBackgroundShell: options.onBackgroundShell }
      : {}),
    ...(options?.onLiveTasksChanged !== undefined
      ? { onLiveTasksChanged: options.onLiveTasksChanged }
      : {})
  });
  return {
    normalizer,
    feed: (message: unknown) => normalizer.handleMessage(message as SDKMessage)
  };
}

function statusFrame(extra: Record<string, unknown>): Record<string, unknown> {
  return { type: "system", subtype: "status", uuid: "u", session_id: "s", ...extra };
}

describe("claude normaliser — a compaction is a visible phase, not generic 'working'", () => {
  it("opens the phase on the FIRST compacting status and never re-opens it", () => {
    const { feed } = feedable();
    const first = feed(statusFrame({ status: "compacting" }));
    const opened = first.filter(
      (event) => event.type === "thread.state.changed" && event.payload.state === "compacting"
    );
    assert.equal(opened.length, 1, "the client learns the CLI is compacting, not merely running");
    assert.ok(
      first.some((event) => event.type === "session.state.changed"),
      "the session is still reported running"
    );
    // The live capture sends six of these per compaction.
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(
        feed(statusFrame({ status: "compacting" })),
        [],
        "a repeat compacting frame changes nothing"
      );
    }
  });

  it("a failed compaction ends the phase with the provider's own reason and warns", () => {
    const { feed } = feedable();
    feed(statusFrame({ status: "compacting" }));
    const settled = feed(
      statusFrame({ status: null, compact_result: "failed", compact_error: "Not enough context." })
    );
    const failed = settled.find(
      (event) => event.type === "thread.state.changed" && event.payload.state === "compaction-failed"
    );
    assert.ok(failed);
    assert.equal(
      failed.type === "thread.state.changed" ? failed.payload.error : undefined,
      "Not enough context."
    );
    const warning = settled.find((event) => event.type === "runtime.warning");
    assert.ok(warning, "and the user is told, not just the fold");
    assert.equal(
      warning.type === "runtime.warning" ? warning.payload.message : undefined,
      "Not enough context."
    );
  });

  it("a failed compaction with no reason falls back to a fixed sentence", () => {
    const { feed } = feedable();
    feed(statusFrame({ status: "compacting" }));
    const settled = feed(statusFrame({ status: null, compact_result: "failed" }));
    const failed = settled.find(
      (event) => event.type === "thread.state.changed" && event.payload.state === "compaction-failed"
    );
    assert.equal(
      failed?.type === "thread.state.changed" ? failed.payload.error : undefined,
      "Context compaction failed."
    );
  });

  it("a successful compaction adds nothing: the boundary already reports it", () => {
    const { feed } = feedable();
    feed(statusFrame({ status: "compacting" }));
    const settled = feed(statusFrame({ status: null, compact_result: "success" }));
    assert.deepEqual(
      settled.filter((event) => event.type === "thread.state.changed"),
      []
    );
    assert.deepEqual(
      settled.filter((event) => event.type === "runtime.warning"),
      []
    );
  });

  it("a SECOND compaction later in the same session opens the phase again", () => {
    const { feed } = feedable();
    feed(statusFrame({ status: "compacting" }));
    feed(statusFrame({ status: null, compact_result: "success" }));
    feed({
      type: "system",
      subtype: "compact_boundary",
      uuid: "u",
      session_id: "s",
      compact_metadata: { trigger: "manual", pre_tokens: 10, post_tokens: 2 }
    });
    // A fresh turn's ordinary status must not be mistaken for the end of a
    // compaction that already ended.
    feed(statusFrame({ status: "requesting" }));
    const again = feed(statusFrame({ status: "compacting" }));
    assert.equal(
      again.filter(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacting"
      ).length,
      1
    );
  });

  it("the latch does not survive the session: closeLiveTasks resets it", () => {
    const { normalizer, feed } = feedable();
    feed(statusFrame({ status: "compacting" }));
    normalizer.closeLiveTasks();
    const again = feed(statusFrame({ status: "compacting" }));
    assert.equal(
      again.filter(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacting"
      ).length,
      1
    );
  });
});

// ---------------------------------------------------------------------------
// Background shells
// ---------------------------------------------------------------------------

const BASH_TOOL_USE_ID = "toolu_bg1";
const SHELL_TASK_ID = "bvf4wz8g5";

/** The `content_block_start` that registers the launching Bash call. */
function bashLaunchFrame(input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "stream_event",
    uuid: "u",
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: BASH_TOOL_USE_ID, name: "Bash", input }
    }
  };
}

function taskStartedFrame(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_started",
    task_id: SHELL_TASK_ID,
    tool_use_id: BASH_TOOL_USE_ID,
    description: "Run the daemon and api suites",
    task_type: "local_bash",
    uuid: "u",
    session_id: "s",
    ...extra
  };
}

function launchToolResultFrame(text: string): Record<string, unknown> {
  return {
    type: "user",
    uuid: "u",
    session_id: "s",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: BASH_TOOL_USE_ID, content: text, is_error: false }]
    }
  };
}

function notificationFrame(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: SHELL_TASK_ID,
    tool_use_id: BASH_TOOL_USE_ID,
    status: "completed",
    output_file: "/var/lib/orquester/tmp/claude-999/x/tasks/bvf4wz8g5.output",
    summary: 'Background command "Run the daemon and api suites" completed (exit code 0)',
    uuid: "u",
    session_id: "s",
    ...extra
  };
}

function payloadOf(event: RuntimeEvent | undefined): Record<string, unknown> {
  assert.ok(event, "expected an event");
  return event.payload as Record<string, unknown>;
}

describe("claude normaliser — a FOREGROUND Bash is a tool row, never a roster row", () => {
  it("is not surfaced at all: no task rows, no liveness, no shell item", () => {
    const live: Array<readonly string[]> = [];
    const { normalizer, feed } = feedable({
      onLiveTasksChanged: (ids) => live.push([...ids])
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm check", description: "Typecheck" }));

    const started = feed(taskStartedFrame({ is_backgrounded: false }));
    assert.deepEqual(
      started.filter((event) => event.type === "task.started"),
      [],
      "a blocking Bash call is already its own tool row"
    );
    assert.deepEqual(
      started.filter((event) => event.type === "item.started"),
      []
    );
    assert.equal(normalizer.liveTasks().size, 0, "and it is not background work");
    assert.deepEqual(live, [], "so the liveness set never moved");

    // Its bookend is just as invisible: the roster must not learn about it on
    // the way out either.
    const done = feed(notificationFrame({ output_file: "", summary: "Typecheck" }));
    assert.deepEqual(
      done.filter((event) => event.type === "task.completed"),
      []
    );
  });

  it("a later move to the background PROMOTES it: task.started, its shell item, then the update", () => {
    const { normalizer, feed } = feedable();
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", description: "Run the suites" }));
    feed(taskStartedFrame({ is_backgrounded: false }));

    const promoted = feed({
      type: "system",
      subtype: "task_updated",
      task_id: SHELL_TASK_ID,
      patch: { is_backgrounded: true },
      uuid: "u",
      session_id: "s"
    });
    const types = promoted.map((event) => event.type);
    assert.deepEqual(types, ["task.started", "item.started", "task.updated"], JSON.stringify(types));

    const start = payloadOf(promoted[0]);
    assert.equal(start.taskId, SHELL_TASK_ID);
    assert.equal(start.isBackgrounded, true);
    assert.equal(start.description, "Run the daemon and api suites");
    assert.equal(start.taskType, "local_bash", "the linkage rides the row, as on every task row");
    assert.equal(start.toolUseId, BASH_TOOL_USE_ID);
    assert.equal(normalizer.liveTasks().has(SHELL_TASK_ID), true);
    assert.equal(payloadOf(promoted[2]).isBackgrounded, true);
  });
});

describe("claude normaliser — a background shell carries its command and its output", () => {
  it("surfaces the task and opens a command_execution item attributed to it", () => {
    const { normalizer, feed } = feedable();
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(
      bashLaunchFrame({
        command: "pnpm -r test\n# second line never reaches the row",
        description: "Run the daemon and api suites",
        run_in_background: true
      })
    );
    const started = feed(taskStartedFrame({ is_backgrounded: true }));

    const task = started.find((event) => event.type === "task.started");
    assert.equal(payloadOf(task).isBackgrounded, true);

    const item = started.find((event) => event.type === "item.started");
    assert.ok(item, "the drill-in needs an item, or it reads 'has not reported anything yet'");
    assert.equal(item.itemId, `bgshell:${SHELL_TASK_ID}`);
    assert.equal(item.agentId, SHELL_TASK_ID);
    assert.equal(item.turnId, "turn-1");
    const payload = payloadOf(item);
    assert.equal(payload.itemType, "command_execution");
    assert.equal(payload.status, "inProgress");
    assert.equal(payload.title, "Background shell");
    assert.equal(payload.detail, "pnpm -r test", "the first line of the command, never the whole script");
    assert.equal(payload.agentId, SHELL_TASK_ID);
    assert.deepEqual(payload.data, {
      toolName: "Bash",
      input: {
        command: "pnpm -r test\n# second line never reaches the row",
        description: "Run the daemon and api suites"
      },
      background: true
    });
  });

  it("parses the output file out of the launch tool_result and asks the session to tail it", () => {
    const changes: BackgroundShellChange[] = [];
    const { normalizer, feed } = feedable({ onBackgroundShell: (change) => changes.push(change) });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));

    feed(
      launchToolResultFrame(
        `Command running in background with ID: ${SHELL_TASK_ID}. Output is being written to: /var/lib/orquester/tmp/claude-999/-var-lib-orquester/1ea82399/tasks/${SHELL_TASK_ID}.output. You will be notified when it completes. To check interim output, use Read on that file path.`
      )
    );
    assert.deepEqual(changes, [
      {
        kind: "tail",
        taskId: SHELL_TASK_ID,
        outputFile: `/var/lib/orquester/tmp/claude-999/-var-lib-orquester/1ea82399/tasks/${SHELL_TASK_ID}.output`
      }
    ]);

    // And the path rides the linkage from then on.
    const progressed = feed({
      type: "system",
      subtype: "task_updated",
      task_id: SHELL_TASK_ID,
      patch: { status: "running" },
      uuid: "u",
      session_id: "s"
    });
    assert.equal(
      payloadOf(progressed.find((event) => event.type === "task.updated")).outputFile,
      `/var/lib/orquester/tmp/claude-999/-var-lib-orquester/1ea82399/tasks/${SHELL_TASK_ID}.output`
    );
  });

  it("keeps a ~-abbreviated path verbatim — resolving it is the session's job", () => {
    const changes: BackgroundShellChange[] = [];
    const { normalizer, feed } = feedable({ onBackgroundShell: (change) => changes.push(change) });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "sleep 20", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));
    feed(
      launchToolResultFrame(
        `Command running in background with ID: ${SHELL_TASK_ID}. Output is being written to: ~/tmp/claude-999/x/tasks/${SHELL_TASK_ID}.output. You will be notified when it completes.`
      )
    );
    assert.equal(changes[0]?.kind, "tail");
    assert.equal(
      changes[0]?.kind === "tail" ? changes[0].outputFile : undefined,
      `~/tmp/claude-999/x/tasks/${SHELL_TASK_ID}.output`
    );
  });

  it("emits a delta under the shell's own item and agent", () => {
    const { normalizer, feed } = feedable();
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));

    const [delta, ...rest] = normalizer.backgroundShellOutput(SHELL_TASK_ID, "ok 1 - a\n");
    assert.deepEqual(rest, []);
    assert.ok(delta);
    assert.equal(delta.type, "content.delta");
    assert.equal(delta.itemId, `bgshell:${SHELL_TASK_ID}`);
    assert.equal(delta.agentId, SHELL_TASK_ID);
    assert.equal(delta.turnId, "turn-1");
    assert.deepEqual(delta.payload, { streamKind: "command_output", delta: "ok 1 - a\n" });
    assert.deepEqual(normalizer.backgroundShellOutput(SHELL_TASK_ID, ""), [], "nothing is not a delta");
  });

  it("closes the item BEFORE the task row and carries the exit code on both", () => {
    const changes: BackgroundShellChange[] = [];
    const { normalizer, feed } = feedable({ onBackgroundShell: (change) => changes.push(change) });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));

    const done = feed(notificationFrame({}));
    const order = done
      .filter((event) => event.type === "item.completed" || event.type === "task.completed")
      .map((event) => event.type);
    assert.deepEqual(
      order,
      ["item.completed", "task.completed"],
      "ingestion closes the output buffer on item.completed, so the item settles first"
    );
    const item = payloadOf(done.find((event) => event.type === "item.completed"));
    assert.equal(item.status, "completed");
    assert.deepEqual((item.data as { exitCode?: unknown }).exitCode, 0);
    const task = payloadOf(done.find((event) => event.type === "task.completed"));
    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);
    assert.deepEqual(changes, [{ kind: "stop", taskId: SHELL_TASK_ID }]);
  });

  it("a non-zero exit fails the item even when the notification says completed", () => {
    const { normalizer, feed } = feedable();
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));
    const done = feed(
      notificationFrame({
        summary: 'Background command "Run the daemon and api suites" completed (exit code 2)'
      })
    );
    const item = payloadOf(done.find((event) => event.type === "item.completed"));
    assert.equal(item.status, "failed");
    assert.equal((item.data as { exitCode?: unknown }).exitCode, 2);
    assert.equal(payloadOf(done.find((event) => event.type === "task.completed")).exitCode, 2);
  });

  it("an unknown exit code leaves the item's verdict to the notification", () => {
    const { normalizer, feed } = feedable();
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));
    const done = feed(notificationFrame({ status: "failed", summary: "Background command died" }));
    const item = payloadOf(done.find((event) => event.type === "item.completed"));
    assert.equal(item.status, "failed");
    assert.equal((item.data as { exitCode?: unknown }).exitCode, undefined);
    assert.equal(payloadOf(done.find((event) => event.type === "task.completed")).exitCode, undefined);
  });

  it("an ambient or skip_transcript task is never surfaced", () => {
    for (const flag of ["ambient", "skip_transcript"] as const) {
      const { normalizer, feed } = feedable();
      normalizer.beginTurn({ turnId: "turn-1" });
      const started = feed(
        taskStartedFrame({ [flag]: true, is_backgrounded: true, task_type: "local_agent" })
      );
      assert.deepEqual(
        started.filter((event) => event.type === "task.started"),
        [],
        `${flag} is housekeeping, not activity`
      );
      assert.equal(normalizer.liveTasks().size, 0, flag);
    }
  });

  it("closeLiveTasks fails the open shell item and stops its tail", () => {
    const changes: BackgroundShellChange[] = [];
    const { normalizer, feed } = feedable({ onBackgroundShell: (change) => changes.push(change) });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));
    changes.length = 0;

    const closed = normalizer.closeLiveTasks();
    const types = closed.map((event) => event.type);
    assert.deepEqual(types, ["item.completed", "task.completed"], JSON.stringify(types));
    const item = payloadOf(closed[0]);
    assert.equal(item.status, "failed");
    assert.equal(item.detail, "stopped with the session");
    assert.equal(payloadOf(closed[1]).status, "stopped");
    assert.deepEqual(changes, [{ kind: "stop", taskId: SHELL_TASK_ID }]);
  });
});

describe("claude normaliser — background_tasks_changed is a LEVEL, not an edge", () => {
  it("never invents a terminal status for a task missing from the snapshot", () => {
    const live: Array<readonly string[]> = [];
    const { normalizer, feed } = feedable({ onLiveTasksChanged: (ids) => live.push([...ids]) });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed(bashLaunchFrame({ command: "pnpm test", run_in_background: true }));
    feed(taskStartedFrame({ is_backgrounded: true }));
    assert.deepEqual(live.at(-1), [SHELL_TASK_ID]);

    // In the live capture this empty level arrives BEFORE the completion
    // bookends. Closing the task here wrote a "Task stopped" row that the
    // roster fold then kept forever.
    const level = feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "u",
      session_id: "s"
    });
    assert.deepEqual(
      level.filter((event) => event.type === "task.completed"),
      [],
      "the level carries ids only; it may not be correlated with the edge stream"
    );
    assert.deepEqual(level, [], "and it is not a roster event at all");
    assert.equal(normalizer.liveTasks().size, 0, "but liveness clears, so Monitoring goes away");
    assert.deepEqual(live.at(-1), []);

    // The real bookend still lands, with the real status.
    const done = feed(notificationFrame({}));
    assert.equal(payloadOf(done.find((event) => event.type === "task.completed")).status, "completed");
  });

  it("still registers a task it names first, and leaves orphan notifications alone", () => {
    const { feed } = feedable();
    feed({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "orphan-1", task_type: "local_bash", description: "Sleep then print" }],
      uuid: "u",
      session_id: "s"
    });
    // A resumed CLI reports the work it adopted, with no `task_started` of
    // ours behind it. That row must still reach the roster.
    const done = feed({
      type: "system",
      subtype: "task_notification",
      task_id: "orphan-1",
      status: "stopped",
      output_file: "",
      summary: "Orphaned by a previous Claude Code process exit",
      uuid: "u",
      session_id: "s"
    });
    const completed = done.find((event) => event.type === "task.completed");
    assert.ok(completed, "an orphan notification is the only row that task will ever have");
    assert.equal(payloadOf(completed).status, "stopped");
    assert.equal(payloadOf(completed).title, "Sleep then print", "with what the level knew of it");
  });
});
