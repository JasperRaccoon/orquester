/**
 * Agent chat — a type-level guard over the contracts.
 *
 * These assertions are mostly for the COMPILER: `pnpm check` is what fails if
 * a union loses a member or a name drifts. The runtime asserts pin the values
 * the spec states literally, so a silent edit to a bound or a route cannot
 * pass review.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CHAT_COMMAND_NAMES,
  AGENT_CHAT_ERROR_CODES,
  AGENT_CHAT_EVENT_TYPES,
  AGENT_CHAT_HEARTBEAT_LINE,
  AGENT_CHAT_REPLAY_MAX_EVENTS,
  COMMANDS_ALLOWED_IN_ERROR_STATE,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DOMAIN_EVENT_TYPES,
  MAX_TURN_ATTACHMENTS,
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  MAX_TURN_INPUT_CHARS,
  RECEIPTS_RING_SIZE,
  ROSTER_LIMIT,
  RUNTIME_MODES,
  TOOL_LIFECYCLE_ITEM_TYPES,
  agentChatCommandPath,
  agentChatRoutes,
  classifyTaskAgentKind,
  isToolLifecycleItemType,
  requestKindFromRequestType,
  settledTurnStateForSessionStatus,
  isSettledTurnState
} from "./index.ts";
import type {
  AgentAdapterId,
  ApprovalDecision,
  CanonicalItemType,
  CanonicalRequestType,
  DomainEventType,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeTaskStatus,
  RuntimeTurnState,
  TurnState,
  TurnTokenUsage
} from "./index.ts";

/** Fails to compile if `T` is not exactly `U`. */
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const exact = <T>(_value: Exact<T, T>): void => {};

test("the closed unions have exactly the members the spec lists", () => {
  // Compile-time: each alias must equal its literal union verbatim.
  const adapters: Exact<
    AgentAdapterId,
    "claude" | "codex" | "opencode" | "grok"
  > = true;
  const decisions: Exact<
    ApprovalDecision,
    "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
  > = true;
  const turnStates: Exact<
    RuntimeTurnState,
    "completed" | "failed" | "interrupted" | "cancelled"
  > = true;
  const taskStatuses: Exact<
    RuntimeTaskStatus,
    | "pending"
    | "running"
    | "waiting"
    | "idle"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
  > = true;
  exact(adapters);
  exact(decisions);
  exact(turnStates);
  exact(taskStatuses);

  // Runtime: the eleven canonical request types and the item vocabulary.
  const requestTypes: CanonicalRequestType[] = [
    "command_execution_approval",
    "file_read_approval",
    "file_change_approval",
    "apply_patch_approval",
    "exec_command_approval",
    "mcp_elicitation_approval",
    "permission_approval",
    "tool_user_input",
    "dynamic_tool_call",
    "auth_tokens_refresh",
    "unknown"
  ];
  assert.equal(requestTypes.length, 11);

  // The two review types stay in the enum (§2/§4.2) even though nothing
  // renders them: the Codex classifier needs somewhere to put them.
  const reviewEntered: CanonicalItemType = "review_entered";
  const reviewExited: CanonicalItemType = "review_exited";
  assert.equal(reviewEntered, "review_entered");
  assert.equal(reviewExited, "review_exited");

  assert.equal(TOOL_LIFECYCLE_ITEM_TYPES.length, 7);
  assert.equal(isToolLifecycleItemType("command_execution"), true);
  assert.equal(isToolLifecycleItemType("review_entered"), false, "review is not a tool row");
  assert.equal(isToolLifecycleItemType("assistant_message"), false);
});

test("the persisted domain union is the fourteen types of §5.1", () => {
  assert.equal(DOMAIN_EVENT_TYPES.length, 14);
  // A dismissal has NO event of its own, and a model change rides meta-updated.
  assert.ok(!(DOMAIN_EVENT_TYPES as readonly string[]).includes("thread.user-input-dismissed"));
  assert.ok(!(DOMAIN_EVENT_TYPES as readonly string[]).includes("thread.model-set"));
  assert.ok((DOMAIN_EVENT_TYPES as readonly string[]).includes("thread.meta-updated"));

  const t: DomainEventType = "thread.turn-diff-completed";
  assert.equal(t, "thread.turn-diff-completed");
});

test("the runtime union carries its envelope and the deliberate exclusions", () => {
  const event: RuntimeEvent = {
    eventId: "e1",
    threadId: "t1",
    createdAt: "2026-09-21T00:00:00.000Z",
    turnId: "turn-1",
    itemId: "item-1",
    requestId: "req-1",
    agentId: "agent-1",
    providerRefs: { providerTurnId: "p-turn", providerItemId: "p-item" },
    raw: { source: "acp.x.ai.extension", method: "session/update", payload: {} },
    type: "content.delta",
    payload: { streamKind: "assistant_text", delta: "hi" }
  };
  assert.equal(event.type, "content.delta");

  // The raw source is a closed enum WITH a templated ACP vendor arm.
  const claudeRaw: RuntimeEvent = {
    ...event,
    raw: { source: "claude.sdk.permission", payload: {} }
  };
  assert.equal(claudeRaw.raw?.source, "claude.sdk.permission");

  const type: RuntimeEventType = "task.completed";
  assert.equal(type, "task.completed");
});

test("turn token usage is tagged by usageStatus", () => {
  const complete: TurnTokenUsage = {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: 10,
    outputTokens: 20,
    hasSubagents: false
  };
  const partial: TurnTokenUsage = {
    usageScope: "main_agent",
    usageStatus: "partial",
    hasSubagents: true
  };
  assert.equal(complete.usageStatus, "complete");
  assert.equal(partial.inputTokens, undefined);
  // `hasSubagents` is mandatory on both arms (§4.2).
  assert.equal(partial.hasSubagents, true);
});

test("the input bounds are stated once and are the spec's numbers", () => {
  assert.equal(MAX_TURN_INPUT_CHARS, 120_000);
  assert.equal(MAX_TURN_ATTACHMENTS, 8);
  assert.equal(MAX_TURN_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_TURN_FILE_BYTES, 50 * 1024 * 1024);
});

test("the defaults differ from T3's where the spec says they do", () => {
  // The runtime mode default is T3's own: full access, the same posture the
  // terminal launchers always had (`--dangerously-skip-permissions`, `--yolo`).
  assert.equal(DEFAULT_RUNTIME_MODE, "full-access");
  assert.equal(DEFAULT_INTERACTION_MODE, "default");
  assert.deepEqual(RUNTIME_MODES, [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access"
  ]);
});

test("route builders produce the §6 paths and encode their segments", () => {
  assert.equal(agentChatRoutes.turn("s1"), "/api/sessions/s1/turn");
  assert.equal(agentChatRoutes.sessionStop("s1"), "/api/sessions/s1/session/stop");
  assert.equal(agentChatRoutes.events("s1"), "/api/sessions/s1/events");
  assert.equal(agentChatRoutes.turnDiff("s1", 7), "/api/sessions/s1/turns/7/diff");
  assert.equal(agentChatRoutes.item("s1", "a/b"), "/api/sessions/s1/items/a%2Fb");
  assert.equal(agentChatRoutes.providers, "/api/agent/providers");
  assert.equal(agentChatRoutes.hostStop, "/api/agent-host/stop");

  assert.equal(AGENT_CHAT_COMMAND_NAMES.length, 10);
  for (const name of AGENT_CHAT_COMMAND_NAMES) {
    assert.ok(agentChatCommandPath("s1", name).startsWith("/api/sessions/s1/"));
  }
  assert.equal(agentChatCommandPath("s1", "session/stop"), "/api/sessions/s1/session/stop");
});

test("the error-code list is closed and RESUME_UNAVAILABLE is not in it", () => {
  assert.deepEqual(AGENT_CHAT_ERROR_CODES, [
    "INVALID_COMMAND",
    "THREAD_NOT_FOUND",
    "COMMAND_ID_CONFLICT",
    "COMMAND_REJECTED",
    "COMPACTION_UNAVAILABLE",
    "HOST_UNAVAILABLE"
  ]);
  assert.ok(!(AGENT_CHAT_ERROR_CODES as readonly string[]).includes("RESUME_UNAVAILABLE"));

  // §6.2: 409 for every command against a thread in `error`, except these two.
  assert.deepEqual([...COMMANDS_ALLOWED_IN_ERROR_STATE].sort(), ["revert", "session/stop"]);
});

test("the stream and bus constants match §6.3 / §6.4", () => {
  assert.equal(AGENT_CHAT_HEARTBEAT_LINE, ":hb");
  assert.equal(AGENT_CHAT_REPLAY_MAX_EVENTS, 1_000);
  assert.deepEqual(AGENT_CHAT_EVENT_TYPES, [
    "agentChat.turn",
    "agentChat.pending",
    "agent.providers.changed"
  ]);
  assert.equal(RECEIPTS_RING_SIZE, 500);
  assert.equal(ROSTER_LIMIT, 100);
});

test("classifyTaskAgentKind is a denylist, and nesting flips it", () => {
  assert.equal(classifyTaskAgentKind({ taskType: "subagent" }), "agent");
  assert.equal(classifyTaskAgentKind({ taskType: "local_agent" }), "agent", "drifted names pass");
  assert.equal(classifyTaskAgentKind({ taskType: "shell" }), "background");
  assert.equal(classifyTaskAgentKind({ taskType: "plan" }), "background");
  // Launched from inside a subagent: background unless itself agent-flavoured.
  assert.equal(classifyTaskAgentKind({ taskType: "shell", agentId: "a1" }), "background");
  assert.equal(classifyTaskAgentKind({ taskType: "subagent", agentId: "a1" }), "agent");
  assert.equal(classifyTaskAgentKind({ agentId: "a1" }), "background");
  assert.equal(classifyTaskAgentKind({}), "agent");
});

test("requestKindFromRequestType folds the native types onto the canonical five", () => {
  assert.equal(requestKindFromRequestType("exec_command_approval"), "command");
  assert.equal(requestKindFromRequestType("apply_patch_approval"), "file-change");
  assert.equal(requestKindFromRequestType("file_read_approval"), "file-read");
  assert.equal(requestKindFromRequestType("mcp_elicitation_approval"), "mcp-elicitation");
  assert.equal(requestKindFromRequestType("permission_approval"), "permission");
  // A question is not an approval (§5.1 drops it from the approval path).
  assert.equal(requestKindFromRequestType("tool_user_input"), null);
  assert.equal(requestKindFromRequestType("nonsense"), null);
});

test("a turn settles from SESSION status, never from turn.completed", () => {
  assert.equal(settledTurnStateForSessionStatus("ready"), "completed");
  assert.equal(settledTurnStateForSessionStatus("idle"), "completed");
  assert.equal(settledTurnStateForSessionStatus("stopped"), "interrupted");
  assert.equal(settledTurnStateForSessionStatus("error"), "failed");
  assert.equal(settledTurnStateForSessionStatus("starting"), null);
  assert.equal(settledTurnStateForSessionStatus("running"), null);

  const pending: TurnState = "pending";
  assert.equal(isSettledTurnState(pending), false);
  assert.equal(isSettledTurnState("running"), false);
  assert.equal(isSettledTurnState("cancelled"), true);
});
