#!/usr/bin/env node
/**
 * A scripted mock Grok agent (spec §9 "Runtime-level tests spawn a small mock
 * peer that speaks the provider's transport").
 *
 * It is a real child process speaking real ACP NDJSON on stdio, launched
 * through the same `support/spawn.ts` path as the CLI, so the adapter's
 * framing, supervision, deadlines and teardown are all exercised without an
 * account or a network call.
 *
 * The scenario comes from `GROK_MOCK_SCENARIO`; every frame it sends is shaped
 * on a real capture under `apps/daemon/test/fixtures/grok/`.
 *
 * Deliberately plain ESM with no imports beyond node: builtins — it must run
 * under a bare `node`, not through tsx.
 */

const scenario = process.env.GROK_MOCK_SCENARIO ?? "happy";
const agentVersion = process.env.GROK_MOCK_VERSION ?? "1.0.34";
const sessionId = "01a0c19e-de22-78c0-a72a-7e230ccfbec0";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A mock that dies on a bad line is useless for testing resilience.
      }
    }
    index = buffer.indexOf("\n");
  }
});

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
    sessionCapabilities: { list: {}, resume: {}, close: {} }
  },
  authMethods: [
    { id: "cached_token", name: "cached_token", description: "Cached token" },
    { id: "grok.com", name: "Grok", description: "Sign in with Grok" }
  ],
  _meta: {
    defaultAuthMethodId: "cached_token",
    agentVersion,
    currentWorkingDirectory: process.cwd(),
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            totalContextTokens: 500000,
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", value: "high", label: "High Effort", default: true },
              { id: "low", value: "low", label: "Low Effort", default: false }
            ]
          }
        },
        { modelId: "grok-4.5", name: "Grok 4.5", _meta: { totalContextTokens: 500000 } }
      ]
    },
    availableCommands: [
      { name: "compact", description: "Compress conversation history", input: { hint: "optional" } },
      { name: "always-approve", description: "Toggle always-approve mode", input: { hint: "on|off" } },
      { name: "context", description: "Show context window usage", input: null }
    ]
  }
};

let promptSeq = 0;

// The `goal` scenario's goal (goals §6.3). Every field is a real
// `goal_updated` row's, in its order (fixtures README observation 36); the
// text is invented.
const goalId = "3f6b2c1e-8a4d-4f0b-9c2e-7d5a1b9e0c44";
const goalObjective = "Audit every request handler for cross-clinic data access and fix each hole";

function goalUpdate(fields) {
  return {
    sessionUpdate: "goal_updated",
    goal_id: goalId,
    objective: goalObjective,
    status: "active",
    phase: "executing",
    tokens_used: 0,
    elapsed_ms: 0,
    total_deliverables: 0,
    completed_deliverables: 0,
    total_worker_rounds: 0,
    total_verify_rounds: 0,
    token_baseline: 15509,
    finished_subagent_tokens: 0,
    last_event: "goal_created",
    last_event_timestamp: "2026-09-24T09:00:00.622415836+00:00",
    ...fields
  };
}

const goalRoundOne = {
  tokens_used: 1200000,
  elapsed_ms: 2400000,
  total_worker_rounds: 1,
  last_event: "worker_completed",
  last_event_detail: "Round one: the handlers were inventoried.",
  last_event_timestamp: "2026-09-24T09:40:00.176452626+00:00",
  classifier_runs_attempted: 1,
  classifier_max_runs: 6,
  verifying_completion: true
};

/** What the CLI replays as the goal's user message: a reminder, not the typed `/goal`. */
const goalReminder =
  `<system-reminder>\nA goal has been set: ${goalObjective}\n\n` +
  "You are working directly on this goal across multiple turns. Deliver\n" +
  "EVERYTHING the user asked for yourself — no follow-up questions, no manual\n" +
  "steps left for the user.\n\nStart now.\n</system-reminder>\n\n";

function handle(frame) {
  const { id, method, params } = frame;

  // The adapter's reply to `session/request_permission` is an ordinary
  // response frame travelling the other way down the same pipe.
  if (method === undefined && id === pendingPermissionId && frame.result !== undefined) {
    const outcome = frame.result.outcome;
    permissionAnswer = outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
    return;
  }

  if (method === "initialize") {
    if (scenario === "no-handshake") {
      return; // Never answers: exercises the handshake deadline.
    }
    result(id, initializeResult);
    return;
  }
  if (method === "authenticate") {
    result(id, { _meta: { auth_mode: "Oidc" } });
    return;
  }
  if (method === "session/new") {
    result(id, { sessionId, models: initializeResult._meta.modelState });
    // The real CLI pushes the full 69-command catalog once a session exists.
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compress conversation history" },
          { name: "always-approve", description: "Toggle always-approve mode" },
          { name: "context", description: "Show context window usage" },
          { name: "loop", description: "Run a loop" }
        ]
      }
    });
    return;
  }
  if (method === "session/load") {
    if (params.sessionId !== sessionId) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Path not found.", data: { code: "FS_NOT_FOUND" } }
      });
      return;
    }
    if (scenario === "goal") {
      // A goal session's persisted `updates.jsonl`, replayed: the goal's rows
      // come BEFORE its user message, which is the reminder block.
      notify("_x.ai/session/update", {
        sessionId,
        update: goalUpdate({}),
        _meta: { eventId: `${sessionId}-2`, agentTimestampMs: 1790240400622, isReplay: true }
      });
      notify("_x.ai/session/update", {
        sessionId,
        update: goalUpdate({ planning: true }),
        _meta: { eventId: `${sessionId}-3`, agentTimestampMs: 1790240400623, isReplay: true }
      });
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: goalReminder } },
        _meta: { eventId: `${sessionId}-4`, agentTimestampMs: 1790240400700, isReplay: true }
      });
      notify("_x.ai/session/update", {
        sessionId,
        update: goalUpdate(goalRoundOne),
        _meta: { eventId: `${sessionId}-5`, agentTimestampMs: 1790242800176, isReplay: true }
      });
    }
    // Replay, on the underscore-prefixed channel T3 does not register.
    notify("_x.ai/session/update", {
      sessionId,
      update: { sessionUpdate: "turn_completed", prompt_id: "old", stop_reason: "end_turn" },
      _meta: { isReplay: true }
    });
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } },
      _meta: { isReplay: true }
    });
    result(id, { models: initializeResult._meta.modelState });
    return;
  }
  if (method === "session/set_model") {
    if (params.modelId === "grok-build" || params.modelId === "nope") {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params", data: "unknown model id" } });
      return;
    }
    result(id, { _meta: { model: { Ok: params.modelId } } });
    return;
  }
  if (method === "session/cancel") {
    cancelled = true;
    return;
  }
  if (method === "session/prompt") {
    void runPrompt(id, params);
    return;
  }
  if (typeof id === "number" || typeof id === "string") {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

let cancelled = false;
let firstPromptAnswered = false;
let pendingPermissionId = null;
let permissionAnswer = null;

async function runPrompt(id, params) {
  promptSeq += 1;
  const promptId = `prompt-${promptSeq}`;
  const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");

  notify("_x.ai/queue/changed", {
    sessionId,
    entries: [{ id: promptId, version: 0, kind: "prompt", text, position: 0 }]
  });

  if (scenario === "exit-mid-turn") {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wor" } },
      _meta: { totalTokens: 1711, promptId }
    });
    // Exit WITHOUT answering: the adapter owns settling the turn.
    setTimeout(() => process.exit(143), 10);
    return;
  }

  if (scenario === "permission" || scenario === "cancel") {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "write",
        rawInput: { file_path: "/tmp/notes.txt", content: "hello\n" },
        _meta: { "x.ai/tool": { version: 1, name: "write", kind: "write", namespace: "opencode", label: "Write", read_only: false } }
      },
      _meta: { totalTokens: 22540, promptId }
    });
    const requestId = 9000 + promptSeq;
    pendingPermissionId = requestId;
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "call-1",
          kind: "edit",
          title: "Write `/tmp/notes.txt`",
          rawInput: { variant: "Write", file_path: "/tmp/notes.txt", content: "hello\n" }
        },
        options: [
          { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
          { optionId: "allow-once", name: "Yes", kind: "allow_once" },
          { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" }
        ]
      }
    });
    // The real CLI settles a cancel WITHOUT waiting for the pending reply.
    if (scenario === "cancel") {
      await waitFor(() => cancelled);
      notify("_x.ai/session_notification", {
        sessionId,
        update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "cancelled" }
      });
      notify("_x.ai/session/prompt_complete", {
        sessionId,
        promptId,
        stopReason: "cancelled",
        cancellationCategory: "MidTurnAbort"
      });
      result(id, { stopReason: "cancelled", _meta: { sessionId, promptId } });
      return;
    }
    await waitFor(() => permissionAnswer !== null);
    const answer = permissionAnswer;
    permissionAnswer = null;
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: answer === "reject-once" ? "failed" : "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: answer === "reject-once" ? "User rejected the execution for tool `write`" : "written"
            }
          }
        ]
      },
      _meta: { totalTokens: 22600, promptId }
    });
    const stopReason = answer === "reject-once" ? "cancelled" : "end_turn";
    notify("_x.ai/session/prompt_complete", {
      sessionId,
      promptId,
      stopReason,
      ...(answer === "reject-once" ? { cancellationCategory: "PermissionRejected" } : {})
    });
    result(id, {
      stopReason,
      _meta: {
        sessionId,
        promptId,
        totalTokens: 22600,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsdTicks: 1_000_000 }
      }
    });
    return;
  }

  if (scenario === "steer" || scenario === "steer-tail") {
    if (promptSeq === 1) {
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } },
        _meta: { totalTokens: 1700, promptId }
      });
      // Answers only once the client cancels — exactly what
      // `05-cancel-with-pending-permission.ndjson` records.
      await waitFor(() => cancelled);
      if (scenario === "steer-tail") {
        // ACP lets a cancelled prompt flush what it already produced before it
        // answers `cancelled`; the chunk still carries ITS OWN promptId.
        notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " two" } },
          _meta: { totalTokens: 1705, promptId }
        });
      }
      notify("_x.ai/session/prompt_complete", {
        sessionId,
        promptId,
        stopReason: "cancelled",
        cancellationCategory: "MidTurnAbort"
      });
      result(id, { stopReason: "cancelled", _meta: { sessionId, promptId } });
      firstPromptAnswered = true;
      return;
    }
    if (scenario === "steer-tail") {
      // The real CLI queues a prompt behind the running one (fixtures README
      // 19, capture 08): nothing of the steered prompt streams until the
      // cancelled prompt has answered.
      await waitFor(() => firstPromptAnswered);
    }
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } },
      _meta: { totalTokens: 2100, promptId }
    });
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, {
      stopReason: "end_turn",
      _meta: {
        sessionId,
        promptId,
        totalTokens: 2100,
        usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44, costUsdTicks: 2_000_000 }
      }
    });
    return;
  }

  if (scenario === "background") {
    // A turn that settles while a background shell keeps running — the state
    // §7.6 keeps the Stop button up for, with no active turn to interrupt.
    notify("_x.ai/task_backgrounded", {
      sessionId,
      update: {
        sessionUpdate: "task_backgrounded",
        tool_call_id: "call-bg-1",
        task_id: "task-bg-1",
        command: "sleep 600",
        description: "Start sleep 600 in background"
      }
    });
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "slow") {
    // Answers only after a cancel arrives; otherwise it runs forever, which
    // is what the liveness watchdog is for.
    await waitFor(() => cancelled);
    result(id, { stopReason: "cancelled", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "goal") {
    // The whole goal runs inside this one prompt turn. Its frames go out on
    // every private-channel spelling the adapter registers — the last one
    // LIVE on the replay method name — and the completion twice, verbatim.
    notify("_x.ai/session_notification", {
      sessionId,
      update: goalUpdate({}),
      _meta: { eventId: `${sessionId}-g1`, agentTimestampMs: 1790240400622 }
    });
    // The rest of a goal run's private traffic (fixtures README observation
    // 37): the goal engine's planner as a subagent, a transport retry, and a
    // compaction checkpoint — real shapes, invented ids.
    const planner = "01a05789-0cc0-7563-9e4f-4b4b576928cc";
    notify("_x.ai/session_notification", {
      sessionId,
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: planner,
        parent_session_id: sessionId,
        parent_prompt_id: promptId,
        child_session_id: planner,
        subagent_type: "general-purpose",
        description: "goal plan writer",
        effective_context_source: "new",
        model: "grok-4.6"
      },
      _meta: { eventId: `${sessionId}-s1`, agentTimestampMs: 1790240400623 }
    });
    notify("_x.ai/session_notification", {
      sessionId,
      update: {
        sessionUpdate: "retry_state",
        type: "retrying",
        attempt: 1,
        max_retries: 15,
        reason: "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses)"
      },
      _meta: { eventId: `${sessionId}-r1`, agentTimestampMs: 1790240400700 }
    });
    notify("_x.ai/session_notification", {
      sessionId,
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: planner,
        child_session_id: planner,
        status: "completed",
        tool_calls: 44,
        turns: 1,
        duration_ms: 222472,
        tokens_used: 66865,
        output: "Done",
        will_wake: false
      },
      _meta: { eventId: `${sessionId}-s2`, agentTimestampMs: 1790240623095 }
    });
    notify("_x.ai/session_notification", {
      sessionId,
      update: {
        sessionUpdate: "compaction_checkpoint",
        checkpoint_id: "da9439f2-d6e4-4479-9507-e7909c769b6a",
        prompt_index_at_compaction: 3,
        checkpoint_file: "compaction_checkpoints/da9439f2-d6e4-4479-9507-e7909c769b6a.json",
        schema_version: 1,
        created_at: "2026-09-24T09:03:42.539454633+00:00"
      },
      _meta: { eventId: `${sessionId}-c1`, agentTimestampMs: 1790240622539 }
    });
    notify("x.ai/session_notification", {
      sessionId,
      update: goalUpdate(goalRoundOne),
      _meta: { eventId: `${sessionId}-g2`, agentTimestampMs: 1790242800176 }
    });
    const completed = goalUpdate({
      ...goalRoundOne,
      status: "complete",
      phase: "idle",
      last_event: "goal_completed",
      last_event_detail: undefined,
      last_event_timestamp: "2026-09-24T10:00:00.291969815+00:00",
      verifying_completion: undefined,
      last_classifier_verdict: "achieved",
      last_classifier_details_path: "/scratch/goal-classifier-1.md"
    });
    for (const eventId of ["g3", "g4"]) {
      notify("_x.ai/session/update", {
        sessionId,
        update: completed,
        _meta: { eventId: `${sessionId}-${eventId}`, agentTimestampMs: 1790244000291 }
      });
    }
    // …then the turn settles as the happy path does.
  }

  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    _meta: { totalTokens: 1700, promptId }
  });
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } },
    _meta: { totalTokens: 1711, promptId }
  });
  notify("_x.ai/session_notification", {
    sessionId,
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: promptId,
      stop_reason: "end_turn",
      usage: {
        inputTokens: 22423,
        outputTokens: 30,
        totalTokens: 22453,
        cachedReadTokens: 6144,
        costUsdTicks: 121_754_000
      }
    }
  });
  notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn", agentResult: null });
  result(id, {
    stopReason: "end_turn",
    _meta: {
      sessionId,
      promptId,
      totalTokens: 22460,
      modelId: "grok-4.6",
      usage: {
        inputTokens: 22423,
        outputTokens: 30,
        totalTokens: 22453,
        cachedReadTokens: 6144,
        costUsdTicks: 121_754_000
      }
    }
  });
}

function waitFor(predicate) {
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

process.on("SIGTERM", () => {
  // The real CLI installs its own handler and exits 143 with signal null, so a
  // supervisor keying on the signal misclassifies a clean stop.
  process.exit(143);
});
