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
import { createIngestion } from "../../ingestion/index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  settle
} from "../../ingestion/test-harness.ts";

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

describe("claude normaliser — a turn the CLI starts itself keeps its opening message in place", () => {
  // The CLI starts a turn on its own when a background task or subagent
  // finishes. Its first API message streams BEFORE the complete `assistant`
  // frame that opens the synthetic turn, and the CLI emits every per-block
  // `assistant` frame before that block's `content_block_stop` (fixture 07).
  // Live thread 19976137, turn f83776c1 (seq 38664/38963): the opening
  // paragraph streamed as one item, its per-block frame minted a second one,
  // and `result` flushed that one BELOW the final summary — where the timeline
  // took it for the turn's answer and folded the real answer away.
  type Frame = Record<string, unknown>;
  type Block =
    | { type: "thinking"; thinking: string }
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string };

  const stream = (event: Frame): Frame => ({
    type: "stream_event",
    event,
    uuid: "u",
    session_id: "s",
    parent_tool_use_id: null
  });
  const blockFrame = (messageId: string, block: Frame): Frame => ({
    type: "assistant",
    uuid: `uuid-${messageId}`,
    session_id: "s",
    parent_tool_use_id: null,
    message: { id: messageId, role: "assistant", model: "claude-opus-5", content: [block], stop_reason: null }
  });

  /** One API message in the CLI's own order: each per-block frame BEFORE its block's stop. */
  function apiMessage(messageId: string, blocks: Block[]): Frame[] {
    const frames: Frame[] = [
      stream({ type: "message_start", message: { id: messageId, role: "assistant", content: [], usage: {} } })
    ];
    blocks.forEach((block, index) => {
      if (block.type === "thinking") {
        frames.push(
          stream({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
          stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }),
          blockFrame(messageId, { type: "thinking", thinking: block.thinking, signature: "sig" }),
          stream({ type: "content_block_stop", index })
        );
      } else if (block.type === "text") {
        const half = Math.ceil(block.text.length / 2);
        frames.push(
          stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
          stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(0, half) } }),
          stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(half) } }),
          blockFrame(messageId, { type: "text", text: block.text }),
          stream({ type: "content_block_stop", index })
        );
      } else {
        frames.push(
          stream({
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: "Bash", input: {} }
          }),
          stream({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: '{"command":"git status"}' }
          }),
          blockFrame(messageId, { type: "tool_use", id: block.id, name: "Bash", input: { command: "git status" } }),
          stream({ type: "content_block_stop", index })
        );
      }
    });
    frames.push(
      stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      stream({ type: "message_stop" })
    );
    return frames;
  }
  const toolResult = (toolUseId: string): Frame => ({
    type: "user",
    uuid: "u",
    session_id: "s",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "clean", is_error: false }]
    }
  });
  const result = (): Frame => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Goal tracking is built.",
    stop_reason: "end_turn",
    num_turns: 2,
    duration_ms: 1000,
    duration_api_ms: 900,
    total_cost_usd: 0,
    permission_denials: [],
    usage: { input_tokens: 10, output_tokens: 10 },
    modelUsage: {},
    uuid: "u",
    session_id: "s"
  });

  /** The incident's turn: open with a paragraph and a tool call, then the final summary. */
  function openingTurn(opening: Block[]): Frame[] {
    return [
      ...apiMessage("msg_open", [...opening, { type: "tool_use", id: "toolu_1" }]),
      toolResult("toolu_1"),
      ...apiMessage("msg_final", [
        { type: "thinking", thinking: "Write it up." },
        { type: "text", text: "Goal tracking is built." }
      ])
    ];
  }

  function feedAll(normalizer: ClaudeNormalizer, frames: readonly Frame[]): RuntimeEvent[] {
    return frames.flatMap((frame) => normalizer.handleMessage(frame as unknown as SDKMessage));
  }

  function newNormalizer(): ClaudeNormalizer {
    return new ClaudeNormalizer({ threadId: "t", clock: fixedClock(), ids: countingIds() });
  }

  function isAssistantItem(event: RuntimeEvent, type: "item.started" | "item.completed"): boolean {
    return (
      event.type === type &&
      (event.payload as { itemType?: string }).itemType === "assistant_message"
    );
  }

  function assistantText(events: readonly RuntimeEvent[]): Array<[string, string]> {
    const byItem = new Map<string, string>();
    for (const event of events) {
      if (
        event.type === "content.delta" &&
        (event.payload as { streamKind?: string }).streamKind === "assistant_text"
      ) {
        const key = event.itemId ?? "";
        byItem.set(key, `${byItem.get(key) ?? ""}${(event.payload as { delta: string }).delta}`);
      }
    }
    return [...byItem.entries()];
  }

  function thinking(events: readonly RuntimeEvent[]): Array<[string, string | undefined]> {
    return events
      .filter(
        (event) =>
          event.type === "content.delta" &&
          (event.payload as { streamKind?: string }).streamKind === "reasoning_summary_text"
      )
      .map((event) => [(event.payload as { delta: string }).delta, event.turnId]);
  }

  it("an opening message that thinks first is ONE item, closed in place, and keeps its thinking", () => {
    const normalizer = newNormalizer();
    const before = feedAll(
      normalizer,
      openingTurn([
        { type: "thinking", thinking: "Round 5 is clean." },
        { type: "text", text: "All checks are now clean." }
      ])
    );
    const atResult = feedAll(normalizer, [result()]);
    const all = [...before, ...atResult];

    const turnIds = [...new Set(all.filter((event) => event.type === "turn.started").map((e) => e.turnId))];
    assert.equal(turnIds.length, 1, "one synthetic turn");
    const started = all.filter((event) => isAssistantItem(event, "item.started")).map((e) => e.itemId);
    assert.equal(started.length, 2, "one item per text block: the per-block frame joins its streamed block");
    assert.deepEqual(
      assistantText(all).map(([, text]) => text),
      ["All checks are now clean.", "Goal tracking is built."],
      "each text once, in the order it was said"
    );
    assert.deepEqual(
      before.filter((event) => isAssistantItem(event, "item.completed")).map((e) => e.itemId),
      started,
      "both items close at their own content_block_stop, before `result`"
    );
    assert.deepEqual(
      atResult.filter((event) => event.type === "content.delta" || isAssistantItem(event, "item.started")),
      [],
      "`result` settles the turn; it never carries text"
    );
    assert.deepEqual(
      thinking(all),
      [
        ["Round 5 is clean.", turnIds[0]],
        ["Write it up.", turnIds[0]]
      ],
      "the thinking that streamed before the turn opened reaches it"
    );
  });

  it("an opening message with no thinking is closed in place, not held back to `result`", () => {
    // Every delta of a text-first opening block arrives before the frame that
    // opens the turn. Its snapshot-only item used to wait for `result` and
    // surfaced after the final summary — one copy, but out of order.
    const normalizer = newNormalizer();
    const all = feedAll(normalizer, [
      ...openingTurn([{ type: "text", text: "Task 7 is done; launching its review." }]),
      result()
    ]);

    const started = all.filter((event) => isAssistantItem(event, "item.started")).map((e) => e.itemId);
    assert.equal(started.length, 2);
    assert.deepEqual(
      assistantText(all).map(([, text]) => text),
      ["Task 7 is done; launching its review.", "Goal tracking is built."]
    );
    const openingClosedAt = all.findIndex(
      (event) => isAssistantItem(event, "item.completed") && event.itemId === started[0]
    );
    const finalOpenedAt = all.findIndex(
      (event) => isAssistantItem(event, "item.started") && event.itemId === started[1]
    );
    assert.ok(
      openingClosedAt !== -1 && openingClosedAt < finalOpenedAt,
      "the opening item closes before the final message starts"
    );
  });

  it("a user turn that opens mid-message adopts the message streaming so far", () => {
    // `sendTurn` can land while the CLI's own message is still thinking: the
    // rest of that message then streams inside the user's turn, and the part
    // that streamed before it must join it rather than split from it.
    const normalizer = newNormalizer();
    const frames = apiMessage("msg_open", [
      { type: "thinking", thinking: "Round 5 is clean." },
      { type: "text", text: "All checks are now clean." }
    ]);
    const cut = frames.findIndex((frame) => frame.type === "assistant");
    const all = [
      ...feedAll(normalizer, frames.slice(0, cut)),
      ...normalizer.beginTurn({ turnId: "turn-user" }),
      ...feedAll(normalizer, frames.slice(cut)),
      ...feedAll(normalizer, [result()])
    ];

    assert.deepEqual(
      assistantText(all).map(([, text]) => text),
      ["All checks are now clean."]
    );
    assert.equal(all.filter((event) => isAssistantItem(event, "item.started")).length, 1);
    assert.deepEqual(thinking(all), [["Round 5 is clean.", "turn-user"]]);
  });

  /** Where `apiMessage` splits a text block between its two deltas. */
  const halves = (text: string): [string, string] => {
    const half = Math.ceil(text.length / 2);
    return [text.slice(0, half), text.slice(half)];
  };
  /** Just past the FIRST delta of block `index`: that block is mid-stream. */
  const midBlock = (frames: readonly Frame[], index: number): number =>
    frames.findIndex((frame) => {
      const event = frame.event as { type?: string; index?: number } | undefined;
      return event?.type === "content_block_delta" && event.index === index;
    }) + 1;

  it("a user turn that auto-closes a synthetic turn mid-message keeps that message's join", () => {
    // `sendTurn` settles a stale synthetic turn and opens the user's while the
    // CLI's own message is still streaming: the rest of that message streams
    // into the user's turn. A fresh turn used to start with no stream join at
    // all, so the block's per-block frame minted a twin that `result` flushed
    // below the user's answer (code review of this fix, 2026-09-24).
    const normalizer = newNormalizer();
    const frames = apiMessage("msg_open", [
      { type: "text", text: "Opening." },
      { type: "text", text: "Second paragraph." }
    ]);
    const cut = midBlock(frames, 1);
    const all = [
      ...feedAll(normalizer, frames.slice(0, cut)),
      ...normalizer.completeTurn("completed"),
      ...normalizer.beginTurn({ turnId: "turn-user" }),
      ...feedAll(normalizer, [
        ...frames.slice(cut),
        ...apiMessage("msg_final", [{ type: "text", text: "Final answer." }])
      ])
    ];
    const atResult = feedAll(normalizer, [result()]);

    const [head, tail] = halves("Second paragraph.");
    assert.deepEqual(
      assistantText([...all, ...atResult]).map(([, text]) => text),
      ["Opening.", head, tail, "Final answer."],
      "the block splits at the turn boundary, and nothing is said twice"
    );
    assert.deepEqual(
      atResult.filter((event) => event.type === "content.delta" || isAssistantItem(event, "item.started")),
      [],
      "`result` carries no text"
    );
  });

  it("a turn that begins while a synthetic turn is open settles that turn first, never overwrites it", () => {
    // `sendTurn` looks for a stale synthetic turn BEFORE its awaits (model,
    // mode, skill discovery); the CLI can open one during them. Overwritten,
    // that turn never settled and its open items never closed.
    const normalizer = newNormalizer();
    const frames = apiMessage("msg_open", [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Background task finished." }
    ]);
    const cut = midBlock(frames, 1);
    const before = feedAll(normalizer, frames.slice(0, cut));
    const syntheticTurnId = before.find((event) => event.type === "turn.started")?.turnId;
    assert.ok(syntheticTurnId !== undefined, "the per-block frame opened a synthetic turn");
    const all = [
      ...before,
      ...normalizer.beginTurn({ turnId: "turn-user" }),
      ...feedAll(normalizer, [
        ...frames.slice(cut),
        ...apiMessage("msg_final", [{ type: "text", text: "Answer to the user." }]),
        result()
      ])
    ];

    const settledAt = all.findIndex(
      (event) => event.type === "turn.completed" && event.turnId === syntheticTurnId
    );
    const userOpenedAt = all.findIndex(
      (event) => event.type === "turn.started" && event.turnId === "turn-user"
    );
    assert.ok(settledAt !== -1 && settledAt < userOpenedAt, "the synthetic turn settles before the user's opens");
    const started = all.filter((event) => isAssistantItem(event, "item.started")).map((e) => e.itemId);
    const completed = all.filter((event) => isAssistantItem(event, "item.completed")).map((e) => e.itemId);
    assert.deepEqual([...completed].sort(), [...started].sort(), "no assistant item is left open");
    const [head, tail] = halves("Background task finished.");
    assert.deepEqual(
      assistantText(all).map(([, text]) => text),
      [head, tail, "Answer to the user."]
    );
  });

  it("a held message keeps every delta, however long its first block streams", () => {
    // The first block streams in full before the frame that opens the turn;
    // Opus can think for thousands of deltas, and a tool's input streams as
    // deltas too. None of it may be lost to a frame cap.
    const normalizer = newNormalizer();
    const thinkingDeltas = Array.from({ length: 12_000 }, (_, n) => `t${n} `);
    const inputChunks = Array.from({ length: 12_000 }, () => " ");
    const frames: Frame[] = [
      stream({ type: "message_start", message: { id: "msg_long", role: "assistant", content: [], usage: {} } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ...thinkingDeltas.map((thinking) =>
        stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } })
      ),
      stream({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      blockFrame("msg_long", { type: "thinking", thinking: thinkingDeltas.join(""), signature: "sig" }),
      stream({ type: "content_block_stop", index: 0 }),
      stream({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_long", name: "Bash", input: {} }
      }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
      ...inputChunks.map((partial_json) =>
        stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } })
      ),
      stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } }),
      blockFrame("msg_long", { type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "ls" } }),
      stream({ type: "content_block_stop", index: 1 })
    ];
    const all = feedAll(normalizer, frames);

    assert.equal(
      thinking(all).map(([delta]) => delta).join(""),
      thinkingDeltas.join(""),
      "every thinking delta reaches the turn, in order"
    );
    const toolRows = all.filter(
      (event) => (event.type === "item.started" || event.type === "item.updated") && event.itemId === "toolu_long"
    );
    assert.deepEqual(
      (toolRows.at(-1)?.payload as { data?: { input?: unknown } } | undefined)?.data?.input,
      { command: "ls" },
      "the tool keeps its streamed input"
    );
  });

  it("a message that ended before any turn opened is never replayed into a later turn", () => {
    for (const end of ["message_stop", "result"] as const) {
      const normalizer = newNormalizer();
      const stale: Frame[] = [
        stream({ type: "message_start", message: { id: "msg_stale", role: "assistant", content: [], usage: {} } }),
        stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Stale." } }),
        end === "message_stop" ? stream({ type: "message_stop" }) : result()
      ];
      const all = [
        ...feedAll(normalizer, stale),
        ...normalizer.beginTurn({ turnId: "turn-user" }),
        ...feedAll(normalizer, [...apiMessage("msg_fresh", [{ type: "text", text: "Fresh." }]), result()])
      ];
      assert.deepEqual(
        assistantText(all).map(([, text]) => text),
        ["Fresh."],
        `a message closed by ${end} stays out of the next turn`
      );
    }
  });

  it("through ingestion, the incident's turn is one message per text block, the answer last", async () => {
    const clock = new FakeClock("2026-09-24T15:07:42.000Z");
    const timers = new FakeTimers(clock);
    const sink = new RecordingSink();
    const ingestion = createIngestion({
      sink: sink.sink,
      liveness: new RecordingLiveness(),
      clock,
      idGen: counterIdGen("d"),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      slim: (payload: unknown) => payload
    });
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock, ids: countingIds() });
    const frames = [
      ...openingTurn([
        { type: "thinking", thinking: "Round 5 is clean." },
        { type: "text", text: "All checks are now clean." }
      ]),
      result()
    ];
    for (const frame of frames) {
      clock.advance(30);
      for (const event of normalizer.handleMessage(frame as unknown as SDKMessage)) {
        await ingestion.ingest(event);
      }
      await settle();
    }
    timers.advance(1000);
    await ingestion.drain();
    await settle();

    const texts = new Map<string, string>();
    for (const event of sink.messages()) {
      if (event.payload.role !== "assistant") continue;
      texts.set(event.payload.messageId, `${texts.get(event.payload.messageId) ?? ""}${event.payload.text}`);
    }
    assert.deepEqual(
      [...texts.values()],
      ["All checks are now clean.", "Goal tracking is built."],
      "no message id repeats the opening paragraph, and the summary is the turn's last message"
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

describe("claude normaliser — a task keeps its own description through progress frames", () => {
  it("does not retitle a task from its progress frames' live-activity description", () => {
    const normalizer = new ClaudeNormalizer({ threadId: "t", clock: fixedClock(), ids: countingIds() });
    normalizer.beginTurn({ turnId: "turn-1" });
    const system = (frame: Record<string, unknown>): RuntimeEvent[] =>
      normalizer.handleMessage({ type: "system", uuid: "u", session_id: "s", ...frame } as unknown as SDKMessage);
    system({
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "toolu_1",
      description: "Audit the workflows",
      subagent_type: "Explore",
      task_type: "local_agent",
      is_backgrounded: false
    });
    const progress = system({
      subtype: "task_progress",
      task_id: "a1",
      tool_use_id: "toolu_1",
      description: "Reading b.txt",
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 }
    });
    const row = progress.find((event) => event.type === "task.progress");
    assert.ok(row);
    const payload = row.payload as { title?: string; description?: string };
    assert.equal(payload.title, "Audit the workflows", "the linkage title is the task's own description");
    assert.equal(payload.description, "Reading b.txt", "the live activity still rides `description`");
  });
});

describe("claude normaliser — the context meter is the MAIN agent's, never a subagent's", () => {
  const makeNormalizer = (): ClaudeNormalizer =>
    new ClaudeNormalizer({ threadId: "t", clock: fixedClock(), ids: countingIds() });

  const system = (normalizer: ClaudeNormalizer, extra: Record<string, unknown>): RuntimeEvent[] =>
    normalizer.handleMessage({
      type: "system",
      uuid: `u-${String(Math.random()).slice(2)}`,
      session_id: "s",
      ...extra
    } as unknown as SDKMessage);

  it("a subagent's task_progress usage never moves the thread meter", () => {
    const normalizer = makeNormalizer();
    normalizer.beginTurn({ turnId: "turn-1" });
    system(normalizer, {
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "toolu_1",
      description: "Audit the workflows",
      subagent_type: "Explore",
      task_type: "local_agent"
    });
    const progress = system(normalizer, {
      subtype: "task_progress",
      task_id: "a1",
      tool_use_id: "toolu_1",
      description: "Reading b.txt",
      usage: { total_tokens: 182_721, tool_uses: 9, duration_ms: 50 }
    });
    assert.deepEqual(
      allOf(progress, "thread.token-usage.updated"),
      [],
      "a subagent's cumulative total is roster data, not the thread's context size"
    );
    // The roster row still carries it.
    const row = progress.find((event) => event.type === "task.progress");
    assert.equal((row?.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens, 182_721);

    const notification = system(normalizer, {
      subtype: "task_notification",
      task_id: "a1",
      tool_use_id: "toolu_1",
      status: "completed",
      output_file: "",
      summary: "done",
      usage: { total_tokens: 210_419, tool_uses: 12, duration_ms: 90 }
    });
    assert.deepEqual(allOf(notification, "thread.token-usage.updated"), []);
  });

  it("a nested stream frame's message_delta usage never moves the thread meter", () => {
    const normalizer = makeNormalizer();
    normalizer.beginTurn({ turnId: "turn-1" });
    const nested = normalizer.handleMessage({
      type: "stream_event",
      parent_tool_use_id: "toolu_1",
      uuid: "u1",
      session_id: "s",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 120_000, output_tokens: 900 }
      }
    } as unknown as SDKMessage);
    assert.deepEqual(allOf(nested, "thread.token-usage.updated"), []);

    const own = normalizer.handleMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "s",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 4_000, output_tokens: 100 }
      }
    } as unknown as SDKMessage);
    const emitted = allOf(own, "thread.token-usage.updated");
    assert.equal(emitted.length, 1, "the main agent's own delta still reports");
    assert.equal(emitted[0]?.payload.usage.usedTokens, 4_100);
  });

  it("a result with no assistant usage keeps the last known reading, never result.usage", () => {
    const normalizer = makeNormalizer();
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 4_000, output_tokens: 100 }
      }
    } as unknown as SDKMessage);

    const settled = normalizer.completeTurn("completed", undefined, {
      type: "result",
      subtype: "success",
      // The whole-turn rollup: main-loop-only and per-turn, never a context size.
      usage: { input_tokens: 900_000, output_tokens: 12_000 },
      modelUsage: {
        "claude-opus-4-8[1m]": {
          inputTokens: 900_000,
          outputTokens: 12_000,
          cacheReadInputTokens: 40_000,
          cacheCreationInputTokens: 8_000,
          contextWindow: 1_000_000
        }
      }
    } as never);

    const emitted = allOf(settled, "thread.token-usage.updated");
    // `usedTokens` is unchanged, so the dedupe may swallow the row entirely;
    // what must never happen is a jump to the turn rollup.
    for (const event of emitted) {
      assert.notEqual(event.payload.usage.usedTokens, 912_000);
    }
    const turn = settled.find((event) => event.type === "turn.completed");
    assert.ok(turn, "the turn still settles");
  });

  it("totalProcessedTokens is the cumulative modelUsage sum, not result.usage", () => {
    const normalizer = makeNormalizer();
    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 4_000, output_tokens: 100 }
      }
    } as unknown as SDKMessage);
    const settled = normalizer.completeTurn("completed", undefined, {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 5_000, output_tokens: 100 },
      modelUsage: {
        "claude-opus-4-8[1m]": {
          inputTokens: 40_000,
          outputTokens: 2_000,
          cacheReadInputTokens: 300_000,
          cacheCreationInputTokens: 50_000,
          contextWindow: 1_000_000
        },
        "claude-haiku-4-5": {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200_000
        }
      }
    } as never);
    const emitted = allOf(settled, "thread.token-usage.updated").at(-1);
    assert.ok(emitted);
    assert.equal(emitted.payload.usage.totalProcessedTokens, 393_100);
    assert.equal(emitted.payload.usage.maxTokens, 1_000_000);
  });

  it("folds an authoritative getContextUsage response through the same dedupe", () => {
    const normalizer = makeNormalizer();
    const response = {
      categories: [{ name: "Free space", tokens: 1, kind: "free" }],
      totalTokens: 15_868,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      autoCompactThreshold: 967_000,
      isAutoCompactEnabled: true
    };
    const first = allOf(normalizer.applyContextUsage(response, "turn-1"), "thread.token-usage.updated");
    assert.equal(first.length, 1);
    assert.equal(first[0]?.turnId, "turn-1", "the row keeps the turn it was requested for");
    assert.equal(first[0]?.payload.usage.usedTokens, 15_868);
    assert.equal(first[0]?.payload.usage.maxTokens, 1_000_000);
    assert.equal(first[0]?.payload.usage.autoCompactAtTokens, 967_000);
    assert.equal(first[0]?.payload.usage.compactsAutomatically, true);
    assert.deepEqual(normalizer.applyContextUsage(response, "turn-1"), [], "the same reading is not re-emitted");
    const off = allOf(
      normalizer.applyContextUsage({ ...response, isAutoCompactEnabled: false }, undefined),
      "thread.token-usage.updated"
    );
    assert.equal(off.length, 1, "only the auto-compaction verdict moved, and that is a change");
    assert.equal(off[0]?.payload.usage.compactsAutomatically, false);
    assert.equal(off[0]?.turnId, undefined);
  });

  it("a result's nominal per-model window never overwrites the authoritative one", () => {
    const normalizer = makeNormalizer();
    // The CLI measures its own percentage against a 200k compaction window
    // even though the model's nominal window is 1M.
    normalizer.applyContextUsage(
      {
        categories: [],
        totalTokens: 15_868,
        maxTokens: 1_000_000,
        rawMaxTokens: 200_000,
        isAutoCompactEnabled: true
      },
      undefined
    );
    assert.equal(normalizer.lastKnownContextWindow, 200_000);

    normalizer.beginTurn({ turnId: "turn-1" });
    normalizer.handleMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 20_000, output_tokens: 100 }
      }
    } as unknown as SDKMessage);
    const settled = normalizer.completeTurn("completed", undefined, {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 20_000, output_tokens: 100 },
      modelUsage: {
        "claude-opus-4-8[1m]": {
          inputTokens: 20_000,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 1_000_000
        }
      }
    } as never);
    assert.equal(normalizer.lastKnownContextWindow, 200_000);
    for (const row of allOf(settled, "thread.token-usage.updated")) {
      assert.equal(row.payload.usage.maxTokens, 200_000);
    }
  });
});

// ---------------------------------------------------------------------------
// A subagent's prose and reasoning belong to its drill-in
// ---------------------------------------------------------------------------

describe("claude normaliser — a subagent's thinking is its own, not the parent's", () => {
  /**
   * Frames quoted from a live 2.1.278 thread (2026-09-22, thread df121813,
   * raw.ndjson lines 2158 and 2166): the CLI forwards a subagent's narration
   * as COMPLETE `assistant` messages carrying `parent_tool_use_id`,
   * `subagent_type` and `task_description` — text blocks and `thinking`
   * blocks alike. The thinking ones were dropped on the floor: that thread
   * held 50 nested thinking blocks and persisted none of them.
   */
  function nestedAgent(): {
    normalizer: ClaudeNormalizer;
    feed: (message: unknown) => RuntimeEvent[];
  } {
    const normalizer = new ClaudeNormalizer({
      threadId: "t",
      clock: fixedClock(),
      ids: countingIds()
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const feed = (message: unknown): RuntimeEvent[] =>
      normalizer.handleMessage(message as SDKMessage);
    feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_01Qxuz9M5tRG9F866QNUQNuP",
      task_type: "local_agent",
      subagent_type: "general-purpose",
      description: "Persist composer draft across unmount",
      uuid: "u0",
      session_id: "s"
    });
    return { normalizer, feed };
  }

  function nestedAssistant(content: unknown[]): Record<string, unknown> {
    return {
      type: "assistant",
      parent_tool_use_id: "toolu_01Qxuz9M5tRG9F866QNUQNuP",
      subagent_type: "general-purpose",
      task_description: "Persist composer draft across unmount",
      uuid: "u1",
      session_id: "s",
      message: {
        id: "msg_011CfJsDz939kZ35rjjx92a8",
        role: "assistant",
        model: "claude-opus-5",
        content
      }
    };
  }

  it("projects a nested thinking block as the agent's own reasoning row", () => {
    const { feed } = nestedAgent();
    const events = feed(
      nestedAssistant([
        {
          type: "thinking",
          thinking: "I'll run the typecheck first and read through the relevant files.",
          signature: "CAISmwQKpgEIEhgCKkCW"
        }
      ])
    );
    const started = events.filter(
      (event) =>
        event.type === "item.started" &&
        (event.payload as { itemType?: string }).itemType === "reasoning"
    );
    assert.equal(started.length, 1, "one reasoning row per nested thinking block");
    assert.equal(started[0]!.agentId, "task-1");
    const delta = events.find(
      (event) =>
        event.type === "content.delta" &&
        (event.payload as { streamKind?: string }).streamKind === "reasoning_summary_text"
    );
    assert.ok(delta, "the reasoning text reaches the drill-in");
    assert.equal(delta.agentId, "task-1");
    assert.equal(
      (delta.payload as { delta: string }).delta,
      "I'll run the typecheck first and read through the relevant files."
    );
    const completed = events.filter(
      (event) =>
        event.type === "item.completed" &&
        (event.payload as { itemType?: string }).itemType === "reasoning"
    );
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.agentId, "task-1");
    assert.equal(completed[0]!.itemId, started[0]!.itemId, "the block is one item, start to finish");
    assert.ok(
      events.every((event) => event.agentId === "task-1"),
      "nothing a subagent thinks is attributed to the parent"
    );
  });

  it("keeps the agent's text and its thinking on separate items", () => {
    const { feed } = nestedAgent();
    const events = feed(
      nestedAssistant([
        { type: "thinking", thinking: "Check the store first." },
        { type: "text", text: "I'll start with the setup, then read the relevant code." }
      ])
    );
    const itemsByKind = new Map<string, Set<string>>();
    for (const event of events) {
      if (event.type !== "item.started") continue;
      const itemType = (event.payload as { itemType?: string }).itemType ?? "";
      const seen = itemsByKind.get(itemType) ?? new Set<string>();
      seen.add(event.itemId ?? "");
      itemsByKind.set(itemType, seen);
    }
    assert.equal(itemsByKind.get("reasoning")?.size, 1);
    assert.equal(itemsByKind.get("assistant_message")?.size, 1);
    assert.notDeepEqual(
      [...(itemsByKind.get("reasoning") ?? [])],
      [...(itemsByKind.get("assistant_message") ?? [])],
      "thinking and prose are two rows, never one"
    );
  });

  it("a nested stream_event never touches the parent's text block", () => {
    const { feed } = nestedAgent();
    const stream = (event: Record<string, unknown>, parent: string | null): RuntimeEvent[] =>
      feed({ type: "stream_event", event, uuid: "u", session_id: "s", parent_tool_use_id: parent });
    stream(
      { type: "message_start", message: { id: "msg_parent", role: "assistant", content: [], usage: {} } },
      null
    );
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, null);
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Parent " } }, null);
    // The subagent's stream, at the same content index as the parent's open
    // block. Dropped whole: the complete nested frame carries the text.
    const nested = [
      stream(
        { type: "message_start", message: { id: "msg_child", role: "assistant", content: [], usage: {} } },
        "toolu_01Qxuz9M5tRG9F866QNUQNuP"
      ),
      stream(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        "toolu_01Qxuz9M5tRG9F866QNUQNuP"
      ),
      stream(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child " } },
        "toolu_01Qxuz9M5tRG9F866QNUQNuP"
      ),
      stream({ type: "content_block_stop", index: 0 }, "toolu_01Qxuz9M5tRG9F866QNUQNuP")
    ].flat();
    assert.deepEqual(nested, [], "a nested stream frame produces nothing at all");
    const after = stream(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "again." } },
      null
    );
    const parentDeltas = after.filter((event) => event.type === "content.delta");
    assert.equal(parentDeltas.length, 1, "the parent's block is still open and still its own");
    assert.equal(parentDeltas[0]!.agentId, undefined);
  });
});

// ---------------------------------------------------------------------------
// The compaction summary
// ---------------------------------------------------------------------------

describe("claude normaliser — the compaction marker carries the CLI's summary", () => {
  const BOUNDARY = {
    type: "system",
    subtype: "compact_boundary",
    session_id: "s",
    uuid: "f0c1c1a4-b94d-4fd8-8408-69993038b8f3",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 34995,
      post_tokens: 873,
      preserved_segment: { anchor_uuid: "63734266-3933-4b91-b49c-bcd6f2566349" },
      preserved_messages: {
        anchor_uuid: "63734266-3933-4b91-b49c-bcd6f2566349",
        all_uuids: ["803f7bad-6727-4953-9d2b-1809aa4fe973"]
      }
    }
  };
  const SUMMARY_TEXT =
    "This session is being continued from a previous conversation that ran out of context. " +
    "The summary below covers the earlier portion of the conversation.\n\n" +
    "1. We fixed the composer draft.\n\nContinue the conversation from where it left off.";
  const SUMMARY_FRAME = {
    type: "user",
    message: { role: "user", content: SUMMARY_TEXT },
    session_id: "s",
    parent_tool_use_id: null,
    uuid: "63734266-3933-4b91-b49c-bcd6f2566349",
    timestamp: "2026-09-21T01:45:59.587Z",
    isReplay: false,
    isSynthetic: true
  };

  function compactionOf(
    events: readonly RuntimeEvent[]
  ): { state: string; summary?: string } | undefined {
    const event = events.find(
      (candidate) =>
        candidate.type === "thread.state.changed" &&
        (candidate.payload as { state?: string }).state === "compacted"
    );
    return event?.payload as { state: string; summary?: string } | undefined;
  }

  it("holds the boundary until the synthetic summary that follows it", () => {
    const { feed } = feedable();
    const atBoundary = feed(BOUNDARY);
    assert.deepEqual(
      atBoundary.filter((event) => event.type === "thread.state.changed"),
      [],
      "the marker waits one frame for the summary the CLI is about to send"
    );
    const atSummary = feed(SUMMARY_FRAME);
    const compacted = compactionOf(atSummary);
    assert.equal(compacted?.state, "compacted");
    assert.equal(compacted?.summary, SUMMARY_TEXT);
    assert.deepEqual(
      atSummary.filter((event) => event.type === "content.delta"),
      [],
      "and the summary is never a user message: it is the marker's own body"
    );
  });

  it("flushes the marker unchanged when the next frame is something else", () => {
    const { feed } = feedable();
    feed(BOUNDARY);
    const next = feed({
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: "u",
      session_id: "s"
    });
    const compacted = compactionOf(next);
    assert.equal(compacted?.state, "compacted");
    assert.equal(compacted?.summary, undefined);
    assert.ok(
      next.findIndex((event) => event.type === "thread.state.changed") <
        next.findIndex((event) => event.type === "session.state.changed"),
      "the held marker keeps its place in front of the frame that flushed it"
    );
  });

  it("a synthetic frame that is not this boundary's anchor stays a normal frame", () => {
    const { feed } = feedable();
    feed(BOUNDARY);
    const other = feed({ ...SUMMARY_FRAME, uuid: "some-other-uuid" });
    assert.equal(compactionOf(other)?.summary, undefined, "the anchor is the join, not the shape");
  });

  it("leaves the `<local-command-stdout>` replay frame exactly as it was", () => {
    const { feed } = feedable();
    feed(BOUNDARY);
    feed(SUMMARY_FRAME);
    const replay = feed({
      type: "user",
      message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
      session_id: "s",
      parent_tool_use_id: null,
      uuid: "65dbb734-da8c-4e5c-8f36-9ac4c6211206",
      isReplay: true
    });
    assert.deepEqual(replay, [], "it was never a row and still is not");
  });

  it("12: the real capture's marker carries the real summary", () => {
    const { events } = replayClaudeFixture("12-compact.ndjson");
    const compacted = events.filter(
      (event) =>
        event.type === "thread.state.changed" &&
        (event.payload as { state?: string }).state === "compacted"
    );
    assert.equal(compacted.length, 1);
    const summary = (compacted[0]!.payload as { summary?: string }).summary;
    assert.ok(
      summary?.startsWith("This session is being continued from a previous conversation"),
      "the CLI's own summary, verbatim"
    );
  });
});
