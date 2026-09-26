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

import { readFileSync } from "node:fs";

const scenario = process.env.GROK_MOCK_SCENARIO ?? "happy";
const agentVersion = process.env.GROK_MOCK_VERSION ?? "1.0.34";
const sessionId = "01a0c19e-de22-78c0-a72a-7e230ccfbec0";

/**
 * `GROK_MOCK_SCENARIO=replay` plays a recorded capture back
 * (`GROK_MOCK_REPLAY`, an absolute fixture path): the capture's own frames, in
 * its own order, with no frame invented. Every client frame the harness sent
 * is a sync point: when the adapter sends a frame of the same method, the
 * frames the agent sent after it — up to the harness's next frame — are
 * played, a recorded reply's id rewritten to the adapter's. A client frame the
 * capture has no match for is answered `{}` (a request) or ignored. Frames are
 * paced by their recorded gaps, clamped to 1–25 ms, so each reaches the
 * adapter in its own read, as it did live.
 */
const replay =
  scenario === "replay"
    ? readFileSync(process.env.GROK_MOCK_REPLAY ?? "", "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    : [];
let replayCursor = 0;
/** The capture's own request ids → the adapter's, for the replies. */
const replayIds = new Map();
let replayQueue = Promise.resolve();

function handleReplay(frame) {
  if (typeof frame.method !== "string") {
    return; // the adapter answering a request of the agent's: nothing recorded to match
  }
  let at = -1;
  for (let index = replayCursor; index < replay.length; index += 1) {
    const entry = replay[index];
    if (entry.dir === "send" && entry.frame?.method === frame.method) {
      at = index;
      break;
    }
  }
  if (at === -1) {
    if (frame.id !== undefined) {
      result(frame.id, {});
    }
    return;
  }
  if (frame.id !== undefined && replay[at].frame.id !== undefined) {
    replayIds.set(replay[at].frame.id, frame.id);
  }
  let end = at + 1;
  while (end < replay.length && replay[end].dir !== "send") {
    end += 1;
  }
  const window = replay.slice(at + 1, end).filter((entry) => entry.dir === "recv");
  replayCursor = end;
  replayQueue = replayQueue.then(async () => {
    let previous = replay[at].t;
    for (const entry of window) {
      const gap = Math.min(25, Math.max(1, entry.t - previous));
      previous = entry.t;
      await new Promise((resolve) => setTimeout(resolve, gap));
      const out = { ...entry.frame };
      if (out.method === undefined && replayIds.has(out.id)) {
        out.id = replayIds.get(out.id);
      }
      send(out);
    }
  });
}

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

/** Several frames in ONE write, so the adapter reads them in one chunk. */
function sendTogether(frames) {
  process.stdout.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
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

function handle(frame) {
  if (scenario === "replay") {
    handleReplay(frame);
    return;
  }
  const { id, method, params } = frame;

  // The adapter's answer to `_x.ai/ask_user_question`, likewise.
  if (method === undefined && id === QUESTION_REQUEST_ID && frame.result !== undefined) {
    questionAnswer = frame.result;
    return;
  }

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

  if (scenario === "permission" || scenario === "cancel" || scenario === "permission-exit") {
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
    // The process dies with the card open: the adapter settles it itself.
    if (scenario === "permission-exit") {
      setTimeout(() => process.exit(143), 20);
      return;
    }
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

  if (scenario === "steer") {
    if (promptSeq === 1) {
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } },
        _meta: { totalTokens: 1700, promptId }
      });
      // Answers only once the client cancels — exactly what
      // `05-cancel-with-pending-permission.ndjson` records.
      await waitFor(() => cancelled);
      notify("_x.ai/session/prompt_complete", {
        sessionId,
        promptId,
        stopReason: "cancelled",
        cancellationCategory: "MidTurnAbort"
      });
      result(id, { stopReason: "cancelled", _meta: { sessionId, promptId } });
      return;
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

  if (scenario === "open-work" || scenario === "open-work-exit") {
    // A turn that settles with a call still open (a cut call gets no terminal
    // frame, fixture 05) and a background shell running: what Stop, the
    // session's stop and the exit must close — the call before the task.
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-open-1",
        title: "run_terminal_command",
        rawInput: { command: "sleep 600" },
        _meta: { "x.ai/tool": { version: 1, name: "run_terminal_command", kind: "execute", namespace: "grok_build", label: "Run", read_only: false } }
      },
      _meta: { totalTokens: 1700, promptId }
    });
    notify("_x.ai/task_backgrounded", {
      sessionId,
      update: {
        sessionUpdate: "task_backgrounded",
        tool_call_id: "call-bg-1",
        task_id: "task-bg-1",
        command: "npm run dev",
        description: "dev server"
      }
    });
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    if (scenario === "open-work-exit") {
      setTimeout(() => process.exit(143), 20);
    }
    return;
  }

  if (scenario === "wake-pending-stop") {
    // The CLI finished our prompt and already runs a prompt of its own (it is
    // announced, and its first frame names it) — but our RPC result is not
    // out yet: fixture 20's 15 ms window, held open until the client's Stop.
    // The cancel then ends the CLI's prompt, the one running.
    const wake = "notifications-01a0d913-68c6-71f3-9a84-ffc23e5f43ed";
    sendTogether([
      chunkFrame("WATCHING", promptId),
      turnCompletedFrame(promptId),
      {
        jsonrpc: "2.0",
        method: "_x.ai/queue/changed",
        params: {
          sessionId,
          entries: [],
          runningPromptId: wake,
          runningText: '<monitor-event task_id="task-mon-1">\n[tick watch] tick 1\n</monitor-event>',
          runningKind: "prompt"
        }
      },
      {
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId,
          update: { sessionUpdate: "hook_run_started", event_name: "user_prompt_submit", prompt_id: wake, count: 1 }
        }
      },
      readMarkerFrame()
    ]);
    await waitFor(() => cancelled);
    notify("_x.ai/session_notification", {
      sessionId,
      update: { sessionUpdate: "turn_completed", prompt_id: wake, stop_reason: "cancelled" }
    });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "wake-finished-steer" && promptSeq === 2) {
    // The steer's own prompt, run at once: the CLI is idle, the wake over.
    sendTogether([
      {
        jsonrpc: "2.0",
        method: "_x.ai/queue/changed",
        params: { sessionId, entries: [], runningPromptId: promptId, runningKind: "prompt" }
      },
      chunkFrame("steered;", promptId),
      turnCompletedFrame(promptId)
    ]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "wake-held" || scenario === "wake-finished-stop" || scenario === "wake-finished-steer") {
    // The CLI finished our prompt and ran one of its own to its end — a
    // background agent's, `GROK_MOCK_WAKE_CHUNKS` chunks and its
    // `turn_completed` — before our RPC result went out: fixture 20's window,
    // as long as a steer or a `set_model` round trip can make it.
    // `wake-held` answers our prompt right after; the other two only once the
    // client cancels (a Stop, or a steer, after the wake finished).
    const count = Number(process.env.GROK_MOCK_WAKE_CHUNKS ?? "300");
    sendTogether([
      chunkFrame("ours;", promptId),
      turnCompletedFrame(promptId),
      announceFrame(WAKE_ID),
      ...Array.from({ length: count }, (_, index) => chunkFrame(`w${index + 1};`, WAKE_ID)),
      turnCompletedFrame(WAKE_ID),
      readMarkerFrame()
    ]);
    if (scenario !== "wake-held") {
      await waitFor(() => cancelled);
    }
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "wake-queued-steer") {
    if (promptSeq === 1) {
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one;" } },
        _meta: { totalTokens: 1700, promptId }
      });
      await waitFor(() => cancelled);
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
    // The steered prompt queues behind a prompt of the CLI's own — a
    // background agent's end, queued while the first prompt ran — and the CLI
    // runs its queue in order (fixture 08): the wake first, then ours.
    await waitFor(() => firstPromptAnswered);
    sendTogether([
      {
        jsonrpc: "2.0",
        method: "_x.ai/queue/changed",
        params: {
          sessionId,
          entries: [{ id: promptId, version: 0, kind: "prompt", text, position: 0 }],
          runningPromptId: WAKE_ID,
          runningText: "<system-reminder>…</system-reminder>",
          runningKind: "prompt"
        }
      },
      chunkFrame("woke;", WAKE_ID),
      turnCompletedFrame(WAKE_ID),
      {
        jsonrpc: "2.0",
        method: "_x.ai/queue/changed",
        params: { sessionId, entries: [], runningPromptId: promptId, runningKind: "prompt" }
      },
      chunkFrame("steered;", promptId),
      turnCompletedFrame(promptId)
    ]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, {
      stopReason: "end_turn",
      _meta: { sessionId, promptId, usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 } }
    });
    return;
  }

  if (scenario === "wake-pending-hold" || scenario === "wake-pending-exit") {
    // Our prompt is done and the CLI runs one of its own, but our RPC result
    // never comes: the session stops (`wake-pending-hold`) or the process
    // exits (`wake-pending-exit`) while the wake's frames wait for its turn.
    sendTogether([
      chunkFrame("ours;", promptId),
      turnCompletedFrame(promptId),
      announceFrame(WAKE_ID),
      chunkFrame("w1;", WAKE_ID),
      chunkFrame("w2;", WAKE_ID),
      readMarkerFrame()
    ]);
    if (scenario === "wake-pending-exit") {
      setTimeout(() => process.exit(143), 20);
    }
    return;
  }

  if (scenario === "wake-question") {
    // The CLI finished our prompt and runs one of its own, which asks the user
    // a question (fixture 07b's request) before our RPC result went out —
    // fixture 20's window. Our prompt is answered while the question waits;
    // the wake goes on once the question is answered.
    sendTogether([
      chunkFrame("ours;", promptId),
      turnCompletedFrame(promptId),
      announceFrame(WAKE_ID),
      questionRequestFrame(sessionId)
    ]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    await waitFor(() => questionAnswer !== null);
    sendTogether([chunkFrame(`answered:${JSON.stringify(questionAnswer.answers)};`, WAKE_ID), turnCompletedFrame(WAKE_ID)]);
    return;
  }

  if (scenario === "child-question" || scenario === "child-question-exit") {
    // A subagent's child session asks the user while our prompt runs: the
    // request names the CHILD's session. Our prompt goes on once answered.
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one;" } },
      _meta: { totalTokens: 1700, promptId }
    });
    send(questionRequestFrame(CHILD_SESSION_ID));
    // The process dies with the question open: the adapter settles it itself.
    if (scenario === "child-question-exit") {
      setTimeout(() => process.exit(143), 20);
      return;
    }
    await waitFor(() => questionAnswer !== null);
    sendTogether([chunkFrame("two;", promptId), turnCompletedFrame(promptId)]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "question") {
    // Our own prompt asks the user (fixture 07b's request, in the parent's
    // session) and goes on once answered, echoing the WHOLE reply it got — so
    // a test reads exactly what reached the CLI: an answer, or a cancel.
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one;" } },
      _meta: { totalTokens: 1700, promptId }
    });
    send(questionRequestFrame(sessionId));
    await waitFor(() => questionAnswer !== null);
    sendTogether([chunkFrame(`reply:${JSON.stringify(questionAnswer)};`, promptId), turnCompletedFrame(promptId)]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "wake-auto-permission") {
    // A waiting wake's tool asks for permission — under full-access, answered
    // by the adapter itself, no card — while our RPC result is still out.
    sendTogether([
      chunkFrame("ours;", promptId),
      turnCompletedFrame(promptId),
      announceFrame(WAKE_ID),
      chunkFrame("w1;", WAKE_ID),
      {
        jsonrpc: "2.0",
        id: 9100,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "call-w-1", kind: "execute", title: "Run `ls`", rawInput: { command: "ls" } },
          options: [
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "reject-once", name: "No", kind: "reject_once" }
          ]
        }
      },
      chunkFrame("w2;", WAKE_ID),
      turnCompletedFrame(WAKE_ID),
      readMarkerFrame()
    ]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "wake-spawn-reorder") {
    // A woken parent spawns a subagent while our RPC result is still out, as
    // fixture 16's parent does: the call names the wake, and the
    // `subagent_spawned` right after it names none (only `parent_prompt_id`).
    const call = "call-a00d2553-adc5-48f4-9181-4a66616fc94f-0";
    const child = "01a0d90e-56c2-78d2-9a27-2d007429d0aa";
    sendTogether([
      turnCompletedFrame(promptId),
      announceFrame(WAKE_ID),
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: call,
            title: "spawn_subagent",
            rawInput: { description: "check it", prompt: "Check it.", subagent_type: "general-purpose", background: true },
            _meta: {
              "x.ai/tool": { version: 1, name: "spawn_subagent", kind: "task", namespace: "grok_build", label: "Subagent", read_only: false },
              subagentBackground: true
            }
          },
          _meta: { totalTokens: 1800, promptId: WAKE_ID }
        }
      },
      {
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId,
          update: {
            sessionUpdate: "subagent_spawned",
            subagent_id: child,
            child_session_id: child,
            parent_session_id: sessionId,
            parent_prompt_id: WAKE_ID,
            subagent_type: "general-purpose",
            description: "check it",
            effective_context_source: "new"
          }
        }
      },
      turnCompletedFrame(WAKE_ID),
      readMarkerFrame()
    ]);
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, { stopReason: "end_turn", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "wake-steer" && promptSeq === 2) {
    // The adapter's steer of the woken turn: an ordinary prompt of ours.
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "steered" } },
      _meta: { totalTokens: 2100, promptId }
    });
    notify("_x.ai/session_notification", {
      sessionId,
      update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" }
    });
    notify("_x.ai/session/prompt_complete", { sessionId, promptId, stopReason: "end_turn" });
    result(id, {
      stopReason: "end_turn",
      _meta: { sessionId, promptId, usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 } }
    });
    return;
  }

  if (scenario === "slow") {
    // Answers only after a cancel arrives; otherwise it runs forever, which
    // is what the liveness watchdog is for.
    await waitFor(() => cancelled);
    result(id, { stopReason: "cancelled", _meta: { sessionId, promptId } });
    return;
  }

  if (scenario === "self-resolve") {
    // What the CLI does for a tool under `--always-approve`, `--permission-mode
    // auto` — or with `support_permission` off: it opens and resolves its own
    // interaction 6 ms apart and never asks the client (observation 5).
    notify("_x.ai/session_notification", {
      sessionId,
      update: { sessionUpdate: "pending_interaction", tool_call_id: `call-${promptSeq}`, kind: "permission" }
    });
    notify("_x.ai/session_notification", {
      sessionId,
      update: { sessionUpdate: "interaction_resolved", tool_call_id: `call-${promptSeq}` }
    });
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
  if (scenario === "wake-steer") {
    await wakeUntilCancelled();
  }
}

/** The CLI's own prompt the wake scenarios run: a background agent's end (fixture 16). */
const WAKE_ID = "subagent-completed-01a0d90e-56c2-78d2-9a27-2d007429d073";
let firstPromptAnswered = false;

/** A subagent's child session (`subagent_spawned.child_session_id`). */
const CHILD_SESSION_ID = "01a0d90e-56c2-78d2-9a27-2d007429d0bb";
const QUESTION_REQUEST_ID = 7100;
let questionAnswer = null;

/** Fixture 07b's `_x.ai/ask_user_question`, asked in `inSession`. */
function questionRequestFrame(inSession) {
  return {
    jsonrpc: "2.0",
    id: QUESTION_REQUEST_ID,
    method: "_x.ai/ask_user_question",
    params: {
      sessionId: inSession,
      toolCallId: "call-q-1",
      questions: [
        {
          question: "alpha or beta?",
          options: [
            { label: "alpha", description: "Name it alpha" },
            { label: "beta", description: "Name it beta" }
          ],
          multiSelect: null
        }
      ],
      mode: "default"
    }
  };
}

/** A prompt the CLI starts itself, announced as fixture 20 records it: never listed in `entries`. */
function announceFrame(wake) {
  return {
    jsonrpc: "2.0",
    method: "_x.ai/queue/changed",
    params: { sessionId, entries: [], runningPromptId: wake, runningText: "<system-reminder>…</system-reminder>", runningKind: "prompt" }
  };
}

function chunkFrame(text, promptId) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      _meta: { totalTokens: 1800, promptId }
    }
  };
}

function turnCompletedFrame(promptId) {
  return {
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: { sessionId, update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" } }
  };
}

/**
 * A frame the adapter reports the moment it reads it — an MCP server's
 * failure is never held for a turn — so a test that waits for its warning
 * knows every frame written before it was read.
 */
function readMarkerFrame() {
  return {
    jsonrpc: "2.0",
    method: "_x.ai/mcp/server_status",
    params: { sessionId, name: "read-marker", status: "unavailable" }
  };
}

/**
 * The CLI's own prompt, as fixtures 16/19 record it: `runningPromptId` never
 * listed in `entries`, the parent's reply under it — and, here, no end until
 * a `session/cancel` arrives, when it settles `cancelled`.
 */
async function wakeUntilCancelled() {
  const wake = "subagent-completed-01a0d90e-56c2-78d2-9a27-2d007429d073";
  await new Promise((resolve) => setTimeout(resolve, 5));
  // One write: the wake's announcement and its first words reach the adapter
  // in the same read, the tightest order the CLI could produce.
  sendTogether([
    { jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId, entries: [] } },
    {
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: { sessionId, entries: [], runningPromptId: wake, runningText: "<system-reminder>…</system-reminder>", runningKind: "prompt" }
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The subagent finished" } },
        _meta: { totalTokens: 1800, promptId: wake }
      }
    }
  ]);
  await waitFor(() => cancelled);
  notify("_x.ai/session_notification", {
    sessionId,
    update: { sessionUpdate: "turn_completed", prompt_id: wake, stop_reason: "cancelled" }
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
