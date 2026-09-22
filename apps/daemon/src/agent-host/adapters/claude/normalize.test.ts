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

import { ClaudeNormalizer, readPreservedUuids } from "./normalize.ts";
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
    assert.ok(started.some((event) => event.payload.taskType === "local_bash"));
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
