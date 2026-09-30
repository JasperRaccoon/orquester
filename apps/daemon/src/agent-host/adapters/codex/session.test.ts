/**
 * Codex adapter — lifecycle tests against a SCRIPTED MOCK PEER (spec §9).
 *
 * The mock is a real child process launched through the same
 * `support/spawn.ts` path as the real CLI and speaking the same NDJSON
 * framing, so the transport, the deadlines and the exit handling are under
 * test — not a stubbed method on the session object.
 *
 * Every wait here is on an EVENT, never on a sleep.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { after, describe, it } from "node:test";

import type { AgentGoal, GoalUpdatedPayload, RuntimeEvent, UserInputRequestedPayload } from "@orquester/api/agent-chat";

import type { CodexProtocol } from "./_generated/index.ts";
import { AsyncEventQueue } from "./event-queue.ts";
import { createCodexAdapter } from "./index.ts";
import { CodexSession, type CodexSessionOptions } from "./session.ts";
import {
  EventCollector,
  createFakeContext,
  waitUntil,
  writeMockCodexServer,
  type MockConfig,
  type MockParentAskEnd,
  type MockTurnScript
} from "./testing.ts";

/**
 * Every rig registers its teardown here rather than relying on the test body
 * reaching its own `stop()`: a failed assertion would otherwise leave a mock
 * child alive and the whole test process would never exit.
 */
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

interface Rig {
  session: CodexSession;
  events: EventCollector;
  received: () => ReturnType<ReturnType<typeof writeMockCodexServer>["received"]>;
  notify(method: string, params: unknown): Promise<void>;
  waitForSent(method: string): Promise<void>;
  stop(): Promise<void>;
  closed: () => boolean;
  logs: ReturnType<typeof createFakeContext>["logs"];
  /** Every frame the session logged, both directions, in the order it read or wrote them. */
  rawFrames: ReturnType<typeof createFakeContext>["rawFrames"];
}

function rig(
  mock: Omit<MockConfig, "logPath"> & { bin?: string },
  overrides: Partial<CodexSessionOptions> = {}
): Rig {
  const server =
    mock.bin !== undefined
      ? { bin: mock.bin, dir: null as string | null, received: () => [], notify: () => {} }
      : writeMockCodexServer(mock);
  if (server.dir !== null && server.dir !== undefined) {
    const dir = server.dir;
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  }

  const { context, logs, rawFrames } = createFakeContext();
  const wire = new EventEmitter();
  const logRawFrame = context.logRawFrame;
  context.logRawFrame = (threadId, frame) => {
    logRawFrame(threadId, frame);
    wire.emit("frame");
  };
  const queue = new AsyncEventQueue<RuntimeEvent>();
  const events = new EventCollector(queue);
  let closed = false;
  let seq = 0;

  const session = new CodexSession({
    context,
    threadId: "thread-1",
    cwd: process.cwd(),
    bin: server.bin,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    runtimeMode: "approval-required",
    modelSelection: { model: "gpt-5.5" },
    emit: (draft) => {
      queue.push({
        ...draft,
        eventId: `ev-${++seq}`,
        threadId: "thread-1",
        createdAt: "2026-09-21T00:00:00.000Z"
      } as RuntimeEvent);
    },
    onClosed: () => {
      closed = true;
    },
    ...overrides
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    await session.stop();
    queue.close();
  };
  cleanups.push(stop);

  return {
    session,
    events,
    received: () => server.received(),
    waitForSent: async (method) => {
      const sent = (): boolean => rawFrames.some(({ frame }) => {
        const logged = frame as { direction: string; frame: { method?: string } };
        return logged.direction === "send" && logged.frame.method === method;
      });
      if (sent()) return;
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (!sent()) return;
          wire.off("frame", check);
          resolve();
        };
        wire.on("frame", check);
      });
    },
    notify: async (method, params) => {
      server.notify(method, params);
      await session.readThread();
    },
    stop,
    closed: () => closed,
    logs,
    rawFrames
  };
}

function sentFrames(
  received: ReturnType<Rig["received"]>,
  method: string
): Record<string, unknown>[] {
  return received
    .filter((frame) => frame.method === method)
    .map((frame) => (frame.params ?? {}) as Record<string, unknown>);
}

describe("codex session — start, turn, stop", () => {
  it("handshakes and emits one thread start before any turn", async () => {
    const r = rig({ turns: [] });
    const summary = await r.session.start();
    assert.equal(summary.status, "ready");

    // `session.started` is emitted before anything else on the stream.
    assert.equal(r.events.events[0]!.type, "session.started");
    assert.equal(
      r.events.events.filter((event) => event.type === "thread.started").length,
      1,
      "thread/start answers the id AND fires thread/started; only one event may result"
    );
    await r.stop();
  });

  it("emits thread.started once on resume too, where no notification fires", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] }, {
      resumeCursor: { threadId: "prior" }
    });
    await r.session.start();
    assert.equal(
      r.events.events.filter((event) => event.type === "thread.started").length,
      1
    );
    await r.stop();
  });

  it("sends approvalsReviewer and a collaborationMode on EVERY turn", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "one", attachments: [], interactionMode: "plan" });
    await r.events.waitForType("turn.completed");
    await r.session.sendTurn({ input: "two", attachments: [], interactionMode: "default" });
    await waitUntil(
      () => r.events.events.filter((event) => event.type === "turn.completed").length === 2,
      "two turns"
    );

    const turns = sentFrames(r.received(), "turn/start");
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.equal(turn.approvalsReviewer, "user", "always explicit, so auto_review never sticks");
      assert.ok(turn.collaborationMode !== undefined, "plan mode is sticky; always send it");
    }
    assert.equal((turns[0]!.collaborationMode as { mode: string }).mode, "plan");
    // Sending `default` explicitly is the ONLY way out of plan mode.
    assert.equal((turns[1]!.collaborationMode as { mode: string }).mode, "default");
    await r.stop();
  });

  it("attaches an image by PATH, never base64, and a file as a path line in the text item", async () => {
    const r = rig({ turns: [{ kind: "text", text: "ok" }] });
    await r.session.start();
    await r.session.sendTurn({
      input: "look",
      attachments: [
        { type: "image", id: "att-1", name: "a.png", mimeType: "image/png", sizeBytes: 10 },
        { type: "file", id: "att-2", name: "a.txt", sizeBytes: 10 }
      ],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.completed");
    const [turn] = sentFrames(r.received(), "turn/start");
    assert.deepEqual(turn!.input, [
      {
        type: "text",
        text: "look\n\nAttached files:\n- a.txt: /attachments/thread-1/att-2",
        text_elements: []
      },
      { type: "localImage", path: "/attachments/thread-1/att-1" }
    ]);
    await r.stop();
  });

  it("only reloads MCP config before a turn once a server has announced itself", async () => {
    // R3 finding 10: an MCP server added to `config.toml` mid-session is not
    // picked up until the thread restarts, so the turn is preceded by a
    // `config/mcpServer/reload`. It is gated on the one live signal that MCP
    // is configured at all — paying a round trip before EVERY turn on the
    // (common) host with no MCP servers is what the gate exists to avoid.
    const r = rig({ turns: [{ kind: "text", text: "a" }] });
    await r.session.start();

    await r.session.sendTurn({ input: "one", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    assert.equal(
      sentFrames(r.received(), "config/mcpServer/reload").length,
      0,
      "no MCP server has ever reported: the reload must not be sent"
    );

    await r.notify("mcpServer/startupStatus/updated", {
      server: "demo",
      status: { type: "ready" }
    });
    await r.session.sendTurn({ input: "two", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");

    const reloads = sentFrames(r.received(), "config/mcpServer/reload");
    assert.equal(reloads.length, 1);
    // And it really precedes the turn it belongs to — a reload that lands
    // after `turn/start` configures the NEXT turn, not this one.
    const frames = r.received().filter((frame) => frame.method !== undefined);
    const reloadIndex = frames.findIndex((frame) => frame.method === "config/mcpServer/reload");
    const secondTurnIndex = frames.reduce(
      (last, frame, index) => (frame.method === "turn/start" ? index : last),
      -1
    );
    assert.ok(reloadIndex !== -1 && reloadIndex < secondTurnIndex);
    await r.stop();
  });
});

describe("codex session — steering", () => {
  it("steering does not reset the turn's usage baseline", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "one", attachments: [], interactionMode: "default" });
    await r.events.waitForType("thread.token-usage.updated");
    // Steer while the turn is still live; the mock's script keeps running.
    await r.session.sendTurn({ input: "two", attachments: [], interactionMode: "default" });
    const completed = await r.events.waitForType("turn.completed");
    const usage = (completed.payload as { tokenUsage?: { usageStatus: string; inputTokens?: number } })
      .tokenUsage;
    assert.equal(usage?.usageStatus, "complete", "a steered turn still reports its usage");
    assert.ok(
      (usage?.inputTokens ?? 0) > 0,
      "the baseline was not reset to the mid-turn total by the steer"
    );
    await r.stop();
  });
});

describe("codex session — approvals", () => {
  it("opens a request with the provider's advertised options and answers it", async () => {
    const r = rig({ turns: [{ kind: "command-approval", command: "ls -1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "list", attachments: [], interactionMode: "default" });

    const opened = await r.events.waitForType("request.opened");
    const payload = opened.payload as {
      requestType: string;
      dismissible: boolean;
      options?: { decision: string }[];
      detail?: string;
    };
    assert.equal(payload.requestType, "command_execution_approval");
    assert.equal(payload.dismissible, false, "a native-callback approval is never dismissible");
    assert.equal(payload.detail, "ls -1");
    assert.deepEqual(
      payload.options?.map((option) => option.decision),
      ["accept", "acceptAlways", "cancel"],
      "rendered from availableDecisions"
    );

    r.session.respondToApproval(opened.requestId!, "accept");
    const resolved = await r.events.waitForType("request.resolved");
    assert.equal((resolved.payload as { decision: string }).decision, "accept");
    await r.events.waitForType("turn.completed");

    const answers = r.received().filter((frame) => frame.result !== undefined);
    assert.deepEqual(answers.at(-1)!.result, { decision: "accept" });
    await r.stop();
  });

  it("acceptAlways rides the execpolicy amendment the server proposed", async () => {
    const r = rig({ turns: [{ kind: "command-approval", command: "ls -1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "list", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    r.session.respondToApproval(opened.requestId!, "acceptAlways");
    await r.events.waitForType("turn.completed");
    const answered = r.received().filter((frame) => frame.result !== undefined).at(-1);
    assert.deepEqual(answered!.result, {
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls", "-1"] } }
    });
    await r.stop();
  });

  it("the file-change card carries the PATH and the diff, joined on itemId (E2E E7)", async () => {
    // Fixture `04-…`: the approval request carries no path and no diff at all
    // — they live on the `item/started` `fileChange` that precedes it. The
    // card cannot do that join (it never sees the item), so the adapter must,
    // or the user approves a write they cannot see.
    const r = rig({
      turns: [
        {
          kind: "file-change-approval",
          path: "/tmp/repo/fixture.txt",
          diff: "+banana\n"
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "write", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const payload = opened.payload as {
      args?: { changes?: { path: string; diff: string }[] };
    };

    assert.deepEqual(
      payload.args?.changes?.map((change) => change.path),
      ["/tmp/repo/fixture.txt"],
      "the full diff rides args.changes for the card to render"
    );
    assert.match(String(payload.args?.changes?.[0]?.diff), /banana/);

    r.session.respondToApproval(opened.requestId!, "accept");
    await r.events.waitForType("turn.completed");
    await r.stop();
  });

  it("a file-change approval falls back to the default four options", async () => {
    const r = rig({
      turns: [{ kind: "file-change-approval", path: "/tmp/a.txt", diff: "banana\n" }]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "write", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    assert.equal((opened.payload as { requestType: string }).requestType, "file_change_approval");
    assert.deepEqual(
      (opened.payload as { options?: { decision: string }[] }).options?.map((o) => o.decision),
      ["cancel", "decline", "acceptForSession", "accept"]
    );
    r.session.respondToApproval(opened.requestId!, "decline");
    await r.events.waitForType("turn.completed");
    assert.equal(
      r.events.types().includes("tool.denied"),
      false,
      "the USER declined this one; it is not a policy deny"
    );
    await r.stop();
  });

  it("an item declined with no request behind it is a CLI policy deny (§4.2)", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    // Feed an item that completes `declined` without any preceding request —
    // exactly what a CLI-side refusal looks like on the wire.
    await r.notify("item/completed", {
      item: {
        type: "commandExecution",
        id: "policy-denied-1",
        pluginId: null,
        scriptPath: null,
        command: "rm -rf /",
        cwd: process.cwd(),
        processId: null,
        source: "agent",
        status: "declined",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      },
      // The session's OWN provider thread id: a notification for any other
      // thread is now routed as collab-child traffic (R3 finding 2), so a
      // stray id here would silently become a `task.progress` row.
      threadId: (r.session.summary().resumeCursor as { threadId: string }).threadId,
      turnId: "turn-x",
      completedAtMs: 1
    });
    const denied = await r.events.waitForType("tool.denied");
    const payload = denied.payload as { toolName: string; toolUseId?: string; reason?: string };
    assert.equal(payload.toolName, "rm -rf /");
    assert.equal(payload.toolUseId, "policy-denied-1");
    await r.stop();
  });

  it("an MCP elicitation answers {action, content, _meta}, not {decision}", async () => {
    const r = rig({
      turns: [{ kind: "elicitation", serverName: "serena", message: 'Allow "replace_in_files"?' }]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "edit", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const payload = opened.payload as { requestType: string; appName?: string; detail?: string };
    assert.equal(payload.requestType, "mcp_elicitation_approval");
    assert.equal(payload.appName, "serena");
    assert.equal(payload.detail, 'Allow "replace_in_files"?');
    r.session.respondToApproval(opened.requestId!, "decline");
    await r.events.waitForType("turn.completed");
    const answered = r.received().filter((frame) => frame.result !== undefined).at(-1);
    assert.deepEqual(answered!.result, { action: "decline", content: null, _meta: null });
    await r.stop();
  });

  it("declines a GENUINE MCP form rather than accepting it with no fields", async () => {
    // `mode:"form"` is used for both an approval and a real form;
    // `_meta.codex_approval_kind` tells them apart (R3 finding 11). Answering
    // a real form Approve/Decline sends `content: null`, i.e. the MCP server
    // gets an accepted elicitation with none of the fields it asked for.
    const r = rig({
      turns: [{ kind: "mcp-form", serverName: "serena", message: "Which branch?" }]
    });
    await r.session.start();
    const beforeRequest = r.events.events.length;
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");

    assert.equal(
      r.events.types().includes("request.opened"),
      false,
      "a form is not an approval card"
    );
    const answered = r.received().filter((frame) => frame.result !== undefined).at(-1);
    assert.deepEqual(answered!.result, { action: "decline", content: null, _meta: null });
    assert.ok(
      r.events.events.slice(beforeRequest).some((event) => event.type === "runtime.warning"),
      "surfaced, not silent"
    );
    await r.stop();
  });

  it("refuses a PARTIALLY renderable question set rather than answering half of it", async () => {
    // §4.5 maps a per-question validation failure to `invalidParams`; answering
    // only the survivors tells the model the dropped question never existed
    // and it proceeds on an answer it never got (R3 finding 12).
    const r = rig({
      turns: [
        {
          kind: "user-input",
          questionId: "q",
          header: "H",
          question: "Q?",
          options: [{ label: "a", description: "b" }],
          withUnrenderable: true
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "plan" });
    await waitUntil(
      () => r.received().some((frame) => frame.error !== undefined),
      "the request is refused"
    );
    const refusal = r.received().find((frame) => frame.error !== undefined)!;
    assert.equal((refusal.error as { code: number }).code, -32602, "invalidParams");
    assert.equal(
      r.events.types().includes("user-input.requested"),
      false,
      "no half-populated card is shown"
    );
    await r.stop();
  });

  it("asks the reply-less async questions as a dismissible message-mode card", async () => {
    // §4.5's second question path: the answer is an ordinary turn, not a
    // JSON-RPC reply, so there is no pending request (R3 finding 3).
    const r = rig({
      turns: [{ kind: "async-questions", title: "Which branch?", options: ["main", "dev"] }]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    const asked = await r.events.waitForType("user-input.requested");
    const payload = asked.payload as {
      responseMode?: string;
      dismissible: boolean;
      questions: { question: string; options: { label: string }[]; allowCustomAnswer?: boolean }[];
    };
    assert.equal(payload.responseMode, "message");
    assert.equal(payload.dismissible, true);
    assert.equal(payload.questions[0]!.question, "Which branch?");
    assert.deepEqual(
      payload.questions[0]!.options.map((option) => option.label),
      ["main", "dev"]
    );
    assert.equal(payload.questions[0]!.allowCustomAnswer, true, "answered in prose");
    await r.stop();
  });

  it("asks a blocking question and answers with the LABEL", async () => {
    const r = rig({
      turns: [
        {
          kind: "user-input",
          questionId: "license_choice",
          header: "License",
          question: "Which license?",
          options: [
            { label: "MIT (Recommended)", description: "Short and permissive." },
            { label: "Apache-2.0", description: "Permissive with a patent grant." }
          ],
          isOther: true
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "license", attachments: [], interactionMode: "plan" });
    const asked = await r.events.waitForType("user-input.requested");
    const payload = asked.payload as {
      dismissible: boolean;
      questions: {
        id: string;
        question: string;
        allowCustomAnswer?: boolean;
        isOther?: boolean;
        isSecret?: boolean;
        multiSelect?: boolean;
      }[];
    };
    assert.equal(payload.dismissible, false, "isBlocking:true is not dismissible");
    assert.equal(payload.questions[0]!.question, "Which license?");
    assert.equal(payload.questions[0]!.allowCustomAnswer, true, "isOther → allowCustomAnswer");
    assert.equal(payload.questions[0]!.isOther, true, "the provider's own spelling too (W13)");
    assert.equal(payload.questions[0]!.multiSelect, false);
    assert.equal(
      (asked.payload as { isBlocking?: boolean }).isBlocking,
      true,
      "the provider's own blocking signal, beside our `dismissible` derivation"
    );

    r.session.respondToUserInput(asked.requestId!, { license_choice: "MIT (Recommended)" });
    await r.events.waitForType("user-input.resolved");
    await r.events.waitForType("turn.completed");
    const answered = r.received().filter((frame) => frame.result !== undefined).at(-1);
    assert.deepEqual(answered!.result, {
      answers: { license_choice: { answers: ["MIT (Recommended)"] } }
    });
    await r.stop();
  });

  it("refuses malformed questions and optionless questions without custom input", async () => {
    for (const invalid of [{ questionId: "" }, { header: " " }, { question: "  " }, { options: null }]) {
      const r = rig({ turns: [{
        kind: "user-input", questionId: "q", header: "Choice", question: "Which?",
        options: [{ label: "A", description: "First" }], ...invalid
      }] });
      await r.session.start();
      await r.session.sendTurn({ input: "choose", attachments: [], interactionMode: "plan" });
      await r.events.waitForType("turn.completed");
      const refused = r.received().find((frame) => frame.error !== undefined);
      assert.equal((refused?.error as { code: number } | undefined)?.code, -32602);
      assert.equal(r.events.types().includes("user-input.requested"), false);
      await r.stop();
    }
  });

  it("filters unusable options, preserves secret input, and sends selected labels", async () => {
    const r = rig({ turns: [{
      kind: "user-input", questionId: "q", header: "Choice", question: "Which?", isSecret: true,
      options: [
        { label: "A", description: "First" }, { label: "B", description: "Second" },
        { label: "", description: "Missing label" }, { label: "Missing description", description: "" }
      ]
    }] });
    await r.session.start();
    await r.session.sendTurn({ input: "choose", attachments: [], interactionMode: "plan" });
    const asked = await r.events.waitForType("user-input.requested");
    const question = (asked.payload as UserInputRequestedPayload).questions[0]!;
    assert.deepEqual(question.options, [{ label: "A", description: "First" }, { label: "B", description: "Second" }]);
    assert.equal(question.isSecret, true);
    assert.equal(question.isOther, undefined);
    r.session.respondToUserInput(asked.requestId!, { q: ["A", "B"] });
    await r.events.waitForType("turn.completed");
    assert.deepEqual(r.received().filter((frame) => frame.result !== undefined).at(-1)?.result,
      { answers: { q: { answers: ["A", "B"] } } });
    await r.stop();
  });

  it("accepts nullable options for custom input and omits unanswered values on the wire", async () => {
    for (const answers of [{ q: "" }, {}]) {
      const r = rig({ turns: [{
        kind: "user-input", questionId: "q", header: "Choice", question: "Which?",
        options: null, isOther: true
      }] });
      await r.session.start();
      await r.session.sendTurn({ input: "choose", attachments: [], interactionMode: "plan" });
      const asked = await r.events.waitForType("user-input.requested");
      const question = (asked.payload as UserInputRequestedPayload).questions[0]!;
      assert.deepEqual(question.options, []);
      assert.equal(question.allowCustomAnswer, true);
      assert.equal(question.isOther, true);
      assert.equal(question.isSecret, undefined);
      r.session.respondToUserInput(asked.requestId!, answers);
      await r.events.waitForType("turn.completed");
      assert.deepEqual(r.received().filter((frame) => frame.result !== undefined).at(-1)?.result, { answers: {} });
      await r.stop();
    }
  });

  it("a non-blocking question is dismissible", async () => {
    const r = rig({
      turns: [
        {
          kind: "user-input",
          questionId: "q",
          header: "H",
          question: "Q?",
          options: [{ label: "a", description: "b" }],
          isBlocking: false
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "plan" });
    const asked = await r.events.waitForType("user-input.requested");
    assert.equal((asked.payload as { dismissible: boolean }).dismissible, true);
    r.session.respondToUserInput(asked.requestId!, { q: "a" });
    await r.events.waitForType("turn.completed");
    await r.stop();
  });
});

describe("codex session — interrupt ordering", () => {
  it("settles a pending approval as cancel BEFORE turn/interrupt reaches the provider", async () => {
    const r = rig({ turns: [{ kind: "command-approval", command: "sleep 30" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "sleep", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");

    await r.session.interruptTurn();

    const resolved = await r.events.waitForType("request.resolved");
    assert.equal(resolved.requestId, opened.requestId);
    assert.equal((resolved.payload as { decision: string }).decision, "cancel");

    // The approval's answer reached the wire before the interrupt request did.
    const received = r.received();
    const answerIndex = received.findIndex((frame) => frame.result !== undefined);
    const interruptIndex = received.findIndex((frame) => frame.method === "turn/interrupt");
    assert.ok(answerIndex !== -1 && interruptIndex !== -1);
    assert.ok(
      answerIndex < interruptIndex,
      "settle, THEN interrupt — the answer must reach a request the server still holds"
    );
    await r.stop();
  });

  it("a turn/interrupt failure that is NOT the benign race REJECTS", async () => {
    // V1: the catch swallowed the whole `CodexRpcError` class, so every
    // failure looked like a successful Stop. `-32600` is this server's
    // catch-all — a malformed `turn/interrupt` of OURS lands on it too
    // (`13-error-envelopes.ndjson` case (c)) — so only the message separates
    // "already settled" from "the interrupt did not happen". Rejecting is what
    // the host turns into `provider.turn.interrupt.failed`.
    const r = rig({
      turns: [{ kind: "silent" }],
      interruptError: { code: -32600, message: "Invalid request: missing field `turnId`" }
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");

    await assert.rejects(
      () => r.session.interruptTurn(),
      /missing field/,
      "a failed interrupt must surface, not be reported to the user as a Stop"
    );

    // And the turn is still the active one: the model never stopped, so
    // clearing it would strand a running turn the UI can no longer Stop.
    const summary = r.session.summary();
    assert.equal(summary.status, "running");
    assert.ok(summary.activeTurnId !== undefined);
    await r.stop();
  });

  it("still swallows the benign \"no active turn\" race and clears the stale turn", async () => {
    // The other half of the same branch (Q1 finding 3): the turn settled
    // underneath us, the user's Stop got what they asked for, and the session
    // must not stay `running` for ever.
    const r = rig({
      turns: [{ kind: "silent" }],
      interruptError: { code: -32600, message: "no active turn to interrupt" }
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");

    await r.session.interruptTurn();

    const summary = r.session.summary();
    assert.equal(summary.status, "ready");
    assert.equal(summary.activeTurnId, undefined);
    await r.stop();
  });

});

describe("codex session — a live turn's children are interrupted first (R3 finding 4)", () => {
  it("interrupts every child BEFORE the parent's own turn/interrupt", async () => {
    // Collab children are full threads on the same connection, so interrupting
    // only the parent leaves the fleet running and spending tokens. Order is
    // load-bearing (§4.5 "Interrupt, in order"): the parent's interrupt can
    // settle the turn and tear down the bookkeeping that names the children.
    const r = rig({
      turns: [{ kind: "spawn-child", childThreadId: "child-1", keepParentRunning: true }]
    });
    await r.session.start();
    const turn = await r.session.sendTurn({
      input: "spawn",
      attachments: [],
      interactionMode: "default"
    });
    await r.events.waitForType("task.started");
    await wireBarrier(r);
    assert.equal(r.session.currentTurnId, turn.turnId, "the parent turn is still live");

    await r.session.interruptTurn(turn.turnId);

    const interrupts = sentFrames(r.received(), "turn/interrupt");
    const childIndex = interrupts.findIndex((params) => params.threadId === "child-1");
    const parentIndex = interrupts.findIndex((params) => params.turnId === turn.turnId);
    assert.ok(childIndex !== -1, "the child turn was never interrupted on the wire");
    assert.ok(parentIndex !== -1, "the parent turn was never interrupted on the wire");
    assert.ok(childIndex < parentIndex, "children first, then the parent");
    await r.stop();
  });
});

describe("codex session — hasSubagents is per TURN (Q1 finding 19)", () => {
  it("reports true for the turn that had subagents and false for the next", async () => {
    // `knownAgentPaths` is pruned only by a terminal `subAgentActivity`, which
    // a turn whose fleet is still running never sends. Left alone it makes
    // every later turn claim subagents; cleared at interrupt time instead it
    // reports false for the very turn that HAD them. It is cleared after
    // `usage.completeTurn` reads it — the one moment the answer is final.
    const r = rig({
      turns: [
        { kind: "spawn-child", childThreadId: "child-1" },
        { kind: "text", text: "plain" }
      ]
    });
    await r.session.start();

    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const withAgents = await r.events.waitForType("turn.completed");
    assert.equal(
      (withAgents.payload as { tokenUsage?: { hasSubagents?: boolean } }).tokenUsage?.hasSubagents,
      true
    );

    await waitUntil(() => r.session.currentTurnId === null, "the first turn settled");
    await r.session.sendTurn({ input: "plain", attachments: [], interactionMode: "default" });
    await waitUntil(
      () => r.events.events.filter((event) => event.type === "turn.completed").length === 2,
      "the second turn.completed"
    );
    const [, plain] = r.events.events.filter((event) => event.type === "turn.completed");
    assert.equal(
      (plain!.payload as { tokenUsage?: { hasSubagents?: boolean } }).tokenUsage?.hasSubagents,
      false,
      "the next turn must start from an empty set"
    );

    // And the clear did NOT take the child bookkeeping with it: §6.2's Stop
    // still has something to reach the fleet with (R6).

    await r.stop();
  });
});

describe("codex session — session-scoped Stop with no running turn (R6)", () => {
  it("stops the background fleet instead of returning a no-op", async () => {
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    // The parent turn finishes while the child keeps working — §3.1's
    // "background work outlives the turn".
    await r.events.waitForType("turn.completed");
    await waitUntil(() => r.session.currentTurnId === null, "the parent turn settled");
    await r.events.waitForType("task.started");

    // Session-scoped Stop: no turn id.
    await r.session.interruptTurn();

    // (a) the child was interrupted ON THE WIRE, not just locally
    const childInterrupts = sentFrames(r.received(), "turn/interrupt").filter(
      (frame) => frame.threadId === "child-1"
    );
    assert.equal(childInterrupts.length, 1, "the fleet is reached, not only the root thread");

    // (b) the live task is closed so the liveness registry can clear
    const stopped = r.events.events.filter(
      (event) =>
        event.type === "task.completed" &&
        (event.payload as { status: string }).status === "stopped"
    );
    assert.ok(stopped.length > 0, "task.completed {stopped} is what clears backgroundLiveness");
    await r.stop();
  });

  it("is idempotent — a second Stop emits no further task rows", async () => {
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    await r.events.waitForType("task.started");
    await waitUntil(() => r.session.currentTurnId === null, "the parent turn settled");

    await r.session.interruptTurn();
    const after = r.events.events.filter((event) => event.type === "task.completed").length;
    await r.session.interruptTurn();
    assert.equal(
      r.events.events.filter((event) => event.type === "task.completed").length,
      after,
      "nothing is left to stop"
    );
    await r.stop();
  });

});

describe("codex session — Stop closes a child re-engaged after it completed (I5)", () => {
  const childTurn = (id: string, status: CodexProtocol.v2.TurnStatus): CodexProtocol.v2.Turn => ({
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null
  });

  it("the relaunch registers the new run, so a session-scoped Stop closes it `stopped`", async () => {
    // The child's first run ends — its own turn completes, and the parent's
    // `subAgentActivity completed` closes the task, which drops it from the
    // live-task registry — then the child's next turn relaunches it. Without a
    // relaunch start nothing put it back, and Stop left the new run open.
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    await waitUntil(() => r.session.currentTurnId === null, "the parent turn settled");
    await wireBarrier(r);

    await r.notify("turn/completed", {
      threadId: "child-1",
      turn: childTurn("child-1-turn", "completed")
    });
    await r.notify("item/completed", {
      item: {
        type: "subAgentActivity",
        id: "sub-child-1-done",
        kind: "completed",
        agentThreadId: "child-1",
        agentPath: "/root/child-1"
      },
      threadId: (r.session.summary().resumeCursor as { threadId: string }).threadId,
      turnId: "turn-x",
      completedAtMs: 1
    });
    const firstLaunch = r.events.events.find((event) => event.type === "task.started");
    await r.notify("turn/started", {
      threadId: "child-1",
      turn: childTurn("child-1-turn-2", "inProgress")
    });
    const relaunch = await r.events.waitFor(
      (event) => event.type === "task.started" && event !== firstLaunch,
      "the relaunch start"
    );

    await r.session.interruptTurn();

    const stopped = await r.events.waitFor(
      (event) =>
        event.type === "task.completed" &&
        event.payload.taskId === "child-1" &&
        event.payload.status === "stopped",
      "the re-engaged run closed `stopped`"
    );
    assert.ok(r.events.events.indexOf(stopped) > r.events.events.indexOf(relaunch));
    await r.stop();
  });
});

describe("codex session — a collab child's own calls (Task 3)", () => {
  /** A child's item as its own thread reports it: the child's call, under the child's namespace. */
  const childCommand = (
    id: string,
    status: CodexProtocol.v2.CommandExecutionStatus
  ): CodexProtocol.v2.ThreadItem => ({
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: "make -j8",
    cwd: process.cwd(),
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null
  });

  it("a child's item declined with no request behind it is a policy deny — owned by the child", async () => {
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    await r.events.waitForType("task.started");
    await r.notify("item/completed", {
      item: childCommand("policy-denied-1", "declined"),
      threadId: "child-1",
      turnId: "child-1-turn",
      completedAtMs: 1
    });
    const denied = await r.events.waitForType("tool.denied");
    const payload = denied.payload as { toolUseId?: string; agentId?: string; reason?: string };
    assert.equal(denied.providerRefs?.providerItemId, "policy-denied-1");
    assert.equal(payload.agentId, "child-1");
    assert.equal(denied.agentId, "child-1", "the deny is a row of the child's drill-in");
    await r.stop();
  });

  it("a session-scoped Stop closes a child's running command, as the child's, before its task", async () => {
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    await waitUntil(() => r.session.currentTurnId === null, "the parent turn settled");
    await r.notify("item/started", {
      item: childCommand("call_long", "inProgress"),
      threadId: "child-1",
      turnId: "child-1-turn",
      startedAtMs: 0
    });
    const opened = await r.events.waitFor(
      (event) => event.type === "item.started" && event.agentId === "child-1" && event.providerRefs?.providerItemId === "call_long",
      "the child's call is a row"
    );

    await r.session.interruptTurn();

    const closed = await r.events.waitFor(
      (event) => event.type === "item.completed" && event.itemId === opened.itemId,
      "the child's running call closed"
    );
    assert.equal(closed.agentId, "child-1");
    assert.equal((closed.payload as { status?: string; agentId?: string }).status, "failed");
    assert.equal((closed.payload as { agentId?: string }).agentId, "child-1");
    // Calls before tasks, as every other close-out orders them (the exit, the
    // host's leftover closers): a call never outlives the agent that ran it.
    const stopped = await r.events.waitFor(
      (event) =>
        event.type === "task.completed" &&
        event.payload.taskId === "child-1" &&
        event.payload.status === "stopped",
      "the child's task stopped"
    );
    assert.ok(
      r.events.events.indexOf(closed) < r.events.events.indexOf(stopped),
      "the call closes before its task's stopped row"
    );
    await r.stop();
  });

  it("a child's card declined after the PARENT's turn settled is still the user's decline", async () => {
    // A parent whose `wait` returned settles its turn while the child's card
    // is still open: the session's per-item bookkeeping for the child must not
    // go with the parent's turn, or the decline reads "you were not asked".
    const r = rig({
      turns: [
        { kind: "child-approval", childThreadId: "child-1", item: "command", parentSettles: "while-asking" }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    await r.events.waitForType("turn.completed");
    await waitUntil(() => r.session.currentTurnId === null, "the parent's turn settled, the card still open");

    r.session.respondToApproval(opened.requestId!, "decline");
    await r.events.waitFor(
      (event) =>
        event.type === "item.completed" &&
        event.agentId === "child-1" &&
        (event.payload as { status?: string }).status === "declined",
      "the child's call ends declined"
    );
    await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended"
    );
    assert.equal(
      r.events.types().includes("tool.denied"),
      false,
      "the USER declined this one, after the parent's turn ended; it is not a policy deny"
    );
    await r.stop();
  });

  it("a child's remembered diff survives the parent's settle", async () => {
    const r = rig({
      turns: [
        { kind: "child-approval", childThreadId: "child-1", item: "file-change", parentSettles: "before-asking" }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const payload = opened.payload as { detail?: string; args?: { changes?: { path: string }[] } };
    assert.match(String(payload.detail), /child\.txt/, "the child's item was remembered past the parent's turn");
    assert.deepEqual(
      payload.args?.changes?.map((change) => change.path),
      ["/tmp/child.txt"]
    );
    r.session.respondToApproval(opened.requestId!, "accept");
    await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended"
    );
    await r.stop();
  });

  it("a child's approval rows ride the parent turn live when the request arrives, as its call does", async () => {
    const live = rig({ turns: [{ kind: "child-approval", childThreadId: "child-1", item: "command" }] });
    await live.session.start();
    const turn = await live.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await live.events.waitForType("request.opened");
    assert.equal(opened.turnId, turn.turnId, "the parent's turn, not the child's own");
    assert.equal(opened.agentId, undefined, "still the parent's card");
    assert.deepEqual(opened.providerRefs?.providerTurnId, "child-1-turn", "the child's turn stays the provider's ref");
    live.session.respondToApproval(opened.requestId!, "accept");
    const resolved = await live.events.waitForType("request.resolved");
    assert.equal(resolved.turnId, turn.turnId);
    await live.events.waitForType("turn.completed");
    await live.stop();

    // A child asking between parent turns: no parent turn is live, so none.
    const idle = rig({
      turns: [
        { kind: "child-approval", childThreadId: "child-1", item: "command", parentSettles: "before-asking" }
      ]
    });
    await idle.session.start();
    await idle.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const asked = await idle.events.waitForType("request.opened");
    assert.equal(asked.turnId, undefined);
    idle.session.respondToApproval(asked.requestId!, "accept");
    await idle.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended"
    );
    await idle.stop();
  });

});

// ---------------------------------------------------------------------------
// A card nobody answers: shared by the two blocks below
// ---------------------------------------------------------------------------

function turnOf(id: string, status: CodexProtocol.v2.TurnStatus): CodexProtocol.v2.Turn {
  return {
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null
  };
}

/** Every resolution the session emitted for one request, answered or not. */
function resolutionsOf(r: Rig, requestId: string | undefined): RuntimeEvent[] {
  return r.events.events.filter(
    (event) =>
      (event.type === "request.resolved" || event.type === "user-input.resolved") &&
      event.requestId === requestId
  );
}

/** What the adapter wrote to the wire for one server→client request: a response carries no method. */
function answersTo(r: Rig, providerRequestId: string | undefined): unknown[] {
  return r
    .received()
    .filter((frame) => frame.method === undefined && String(frame.id) === providerRequestId)
    .map((frame) => frame.result ?? frame.error);
}

/**
 * A barrier on the wire: the mock logs every frame in the order it reads
 * them, so once it has answered a request of ours, everything the adapter
 * wrote before it is in the log, and every earlier provider frame has been
 * read and its events emitted.
 */
async function wireBarrier(r: Rig): Promise<void> {
  await r.session.readThread();
}

function indexOf(r: Rig, event: RuntimeEvent): number {
  return r.events.events.indexOf(event);
}

describe("codex session — a collab child's open cards end with the child (follow-ups 2026-09-25)", () => {
  // The gap: a child's own turn was interrupted (or failed, or its thread
  // closed) with one of its cards open, and the card stayed open — blocking
  // the composer and the MCP's send_message — until the user answered it or
  // pressed Stop. Nothing waits on an answer to it any more (fixtures README
  // observation 20, which reads the server's side from its binary: not
  // captured for a child). Now the card is settled as a Stop settles one —
  // once, on the turn stamp it was opened with — and nothing is answered on
  // the wire.
  for (const status of ["interrupted", "failed", "completed"] as const) {
    it(`an approval open as the child's turn ends ${status}: cancelled once, on its parent turn, never answered`, async () => {
      const r = rig({
        turns: [
          {
            kind: "child-approval",
            childThreadId: "child-1",
            item: "command",
            afterAsking: [`turn-${status}`, "resolved"]
          }
        ]
      });
      await r.session.start();
      const turn = await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
      const opened = await r.events.waitForType("request.opened");
      assert.equal(opened.turnId, turn.turnId);

      const resolved = await r.events.waitForType("request.resolved");
      assert.equal(resolved.requestId, opened.requestId);
      assert.deepEqual(resolved.payload, {
        requestType: "command_execution_approval",
        decision: "cancel",
        withdrawn: true
      });
      assert.equal(resolved.turnId, turn.turnId, "the parent turn the card rode, as it was opened");
      assert.equal(resolved.agentId, undefined, "still the parent's card");

      // The card first, as a Stop settles it: before the child's abandoned
      // call closes and before the child's own task row.
      const callClosed = await r.events.waitFor(
        (event) => event.type === "item.completed" && event.agentId === "child-1",
        "the child's abandoned call closed"
      );
      const taskRow = await r.events.waitFor(
        (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
        "the child's turn ended"
      );
      assert.ok(indexOf(r, resolved) < indexOf(r, callClosed));
      assert.ok(indexOf(r, callClosed) < indexOf(r, taskRow));

      // The handler is finished, not dangling, and wrote nothing: the server
      // resolved the request itself.
      await wireBarrier(r);
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);

      // An answer that comes after it changes nothing.
      r.session.respondToApproval(opened.requestId!, "accept");
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      await r.stop();
    });
  }

  it("a question open when the child's turn is interrupted is cancelled once, turnless, and never answered", async () => {
    const r = rig({
      turns: [
        {
          kind: "child-approval",
          childThreadId: "child-1",
          item: "question",
          afterAsking: ["turn-interrupted", "resolved"]
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const asked = await r.events.waitForType("user-input.requested");
    assert.equal(asked.turnId, undefined);

    const resolved = await r.events.waitForType("user-input.resolved");
    assert.equal(resolved.requestId, asked.requestId);
    assert.deepEqual(resolved.payload, { answers: {}, withdrawn: true });
    assert.equal(resolved.turnId, undefined, "turnless, as it was asked");
    assert.equal(resolved.agentId, undefined);
    const taskRow = await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended"
    );
    assert.ok(indexOf(r, resolved) < indexOf(r, taskRow));

    await wireBarrier(r);
    await wireBarrier(r);
    assert.equal(resolutionsOf(r, asked.requestId).length, 1);
    assert.deepEqual(answersTo(r, asked.providerRefs?.providerRequestId), []);

    r.session.respondToUserInput(asked.requestId!, { branch: "main" });
    await wireBarrier(r);
    assert.equal(resolutionsOf(r, asked.requestId).length, 1);
    assert.deepEqual(answersTo(r, asked.providerRefs?.providerRequestId), []);
    await r.stop();
  });

  for (const item of ["command", "question"] as const) {
    it(`the child's thread closing with no turn end cancels its open ${item} card the same way`, async () => {
      const r = rig({
        turns: [{ kind: "child-approval", childThreadId: "child-1", item, afterAsking: ["thread-closed"] }]
      });
      await r.session.start();
      const turn = await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
      const opened = await r.events.waitFor(
        (event) => event.type === "request.opened" || event.type === "user-input.requested",
        "the child's card"
      );
      const resolved = await r.events.waitFor(
        (event) =>
          (event.type === "request.resolved" || event.type === "user-input.resolved") &&
          event.requestId === opened.requestId,
        "the card settled"
      );
      assert.equal((resolved.payload as { withdrawn?: boolean }).withdrawn, true);
      assert.equal(resolved.turnId, item === "command" ? turn.turnId : undefined);
      const taskClosed = await r.events.waitFor(
        (event) => event.type === "task.completed" && event.payload.taskId === "child-1",
        "the child's thread closed"
      );
      assert.ok(indexOf(r, resolved) < indexOf(r, taskClosed), "the card before the child's task row");

      await wireBarrier(r);
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      await r.stop();
    });
  }

  it("serverRequest/resolved naming a child's open card cancels it; the child's turn end after it adds nothing", async () => {
    const r = rig({
      turns: [
        {
          kind: "child-approval",
          childThreadId: "child-1",
          item: "command",
          afterAsking: ["resolved", "turn-interrupted"]
        }
      ]
    });
    await r.session.start();
    const turn = await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const resolved = await r.events.waitForType("request.resolved");
    assert.deepEqual(resolved.payload, {
      requestType: "command_execution_approval",
      decision: "cancel",
      withdrawn: true
    });
    assert.equal(resolved.turnId, turn.turnId);
    await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended"
    );
    await wireBarrier(r);
    await wireBarrier(r);
    assert.equal(resolutionsOf(r, opened.requestId).length, 1);
    assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
    await r.stop();
  });

  for (const item of ["command", "question"] as const) {
    it(`serverRequest/resolved alone cancels the child's open ${item} card while the child's turn runs on`, async () => {
      // The resolution with no turn end behind it: whatever settles the card
      // here is the resolved branch, not the child's turn end.
      const r = rig({
        turns: [{ kind: "child-approval", childThreadId: "child-1", item, afterAsking: ["resolved"] }]
      });
      await r.session.start();
      const turn = await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
      const opened = await r.events.waitFor(
        (event) => event.type === "request.opened" || event.type === "user-input.requested",
        "the child's card"
      );
      const resolved = await r.events.waitFor(
        (event) =>
          (event.type === "request.resolved" || event.type === "user-input.resolved") &&
          event.requestId === opened.requestId,
        "the card settled"
      );
      assert.equal((resolved.payload as { withdrawn?: boolean }).withdrawn, true);
      assert.equal(resolved.turnId, item === "command" ? turn.turnId : undefined);

      await wireBarrier(r);
      await wireBarrier(r);

      assert.equal(
        r.events.events.some((event) => event.type === "task.updated" && event.payload.taskId === "child-1"),
        false
      );
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      await r.stop();
    });
  }

  it("an answer that races the child's turn end settles the card once, whichever lands first", async () => {
    // The user's answer first: it is the card's one resolution, and it goes
    // on the wire; the child's turn end after it finds nothing parked.
    const answered = rig({ turns: [{ kind: "child-approval", childThreadId: "child-1", item: "command" }] });
    await answered.session.start();
    await answered.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const first = await answered.events.waitForType("request.opened");
    answered.session.respondToApproval(first.requestId!, "accept");
    await answered.notify("turn/completed", {
      threadId: "child-1",
      turn: turnOf("child-1-turn", "interrupted")
    });
    await answered.events.waitFor(
      (event) => event.type === "item.completed" && event.agentId === "child-1",
      "the child's call"
    );
    await wireBarrier(answered);
    const answeredResolutions = resolutionsOf(answered, first.requestId);
    assert.equal(answeredResolutions.length, 1);
    assert.deepEqual(answeredResolutions[0]!.payload, {
      requestType: "command_execution_approval",
      decision: "accept"
    });
    assert.deepEqual(answersTo(answered, first.providerRefs?.providerRequestId), [{ decision: "accept" }]);
    await answered.stop();

    // The child's turn end first: the card is cancelled, and the answer that
    // follows is dropped — never a second row, never on the wire.
    const ended = rig({ turns: [{ kind: "child-approval", childThreadId: "child-1", item: "command" }] });
    await ended.session.start();
    await ended.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const second = await ended.events.waitForType("request.opened");
    await ended.notify("turn/completed", {
      threadId: "child-1",
      turn: turnOf("child-1-turn", "interrupted")
    });
    ended.session.respondToApproval(second.requestId!, "accept");
    await wireBarrier(ended);
    await wireBarrier(ended);
    const endedResolutions = resolutionsOf(ended, second.requestId);
    assert.equal(endedResolutions.length, 1);
    assert.equal((endedResolutions[0]!.payload as { withdrawn?: boolean }).withdrawn, true);
    assert.deepEqual(answersTo(ended, second.providerRefs?.providerRequestId), []);
    await ended.stop();
  });

  it("another child's end leaves this child's card open for its answer", async () => {
    const r = rig({ turns: [{ kind: "child-approval", childThreadId: "child-1", item: "command" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    await r.notify("turn/started", {
      threadId: "child-2",
      turn: turnOf("child-2-turn", "inProgress")
    });
    await r.notify("turn/completed", {
      threadId: "child-2",
      turn: turnOf("child-2-turn", "interrupted")
    });
    await r.notify("thread/closed", { threadId: "child-2" });
    await wireBarrier(r);
    assert.equal(resolutionsOf(r, opened.requestId).length, 0);

    r.session.respondToApproval(opened.requestId!, "accept");
    await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "child-1's turn ran on"
    );
    assert.equal(resolutionsOf(r, opened.requestId).length, 1);
    assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), [{ decision: "accept" }]);
    await r.stop();
  });

  it("the parent's own cards are untouched by a child's turn end, its thread's close, or another request's resolution", async () => {
    // A child's end reaches the child's cards only, and a resolution only the
    // card it names. A message-mode question is never a parked request, so
    // nothing here can reach it either (§6.2).
    const r = rig({ turns: [{ kind: "command-approval", command: "ls -1" }] });
    await r.session.start();
    const turn = await r.session.sendTurn({ input: "ls", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const parentThreadId = (r.session.summary().resumeCursor as { threadId: string }).threadId;
    await r.notify("item/completed", {
      item: {
        type: "agentMessage",
        id: "msg-async",
        text: "Which branch?",
        phase: "final_answer",
        memoryCitation: null,
        delivery: "async",
        questions: [{ title: "Branch", options: ["main", "dev"] }]
      },
      threadId: parentThreadId,
      turnId: turn.turnId,
      completedAtMs: 1
    });
    const asked = await r.events.waitForType("user-input.requested");
    assert.equal((asked.payload as { responseMode?: string }).responseMode, "message");

    // A child this session never saw launched: its turn, its end, its close.
    await r.notify("turn/started", {
      threadId: "child-9",
      turn: turnOf("child-9-turn", "inProgress")
    });
    await r.notify("turn/completed", {
      threadId: "child-9",
      turn: turnOf("child-9-turn", "interrupted")
    });
    await r.notify("thread/closed", { threadId: "child-9" });
    // …and a resolution naming a request that is not this card.
    await r.notify("serverRequest/resolved", {
      threadId: parentThreadId,
      requestId: Number(opened.providerRefs?.providerRequestId) + 1
    });
    await wireBarrier(r);
    assert.deepEqual(
      r.events.events.filter(
        (event) => event.type === "request.resolved" || event.type === "user-input.resolved"
      ),
      [],
      "nothing settled"
    );

    r.session.respondToApproval(opened.requestId!, "accept");
    const resolved = await r.events.waitForType("request.resolved");
    assert.deepEqual(resolved.payload, { requestType: "command_execution_approval", decision: "accept" });
    await r.events.waitFor(
      (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      "the parent's turn ran on"
    );
    assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), [{ decision: "accept" }]);
    await r.stop();
  });
});

describe("codex session — the parent's own card nobody answered (sweep, follow-ups 2026-09-25)", () => {
  // Its turn's end, its thread's close, or a `serverRequest/resolved` naming
  // it ends the wait on it (a card still parked is never the ack of our own
  // answer: every path that answers takes the card out before it writes).
  // Left parked, the card paused the session's watchdog for every later turn,
  // held one of the 32 in-flight slots, kept an approval blocking the
  // composer, and a later Stop answered a request nothing waited on and wrote
  // a second row for it.
  for (const item of ["command", "question"] as const) {
    const ask = (afterAsking: MockParentAskEnd): MockTurnScript =>
      item === "command"
        ? { kind: "command-approval", command: "ls -1", afterAsking }
        : {
            kind: "user-input",
            questionId: "branch",
            header: "Branch",
            question: "Which branch?",
            options: [{ label: "main", description: "The default branch" }],
            afterAsking
          };

    it(`a parent ${item} card resolved mid-turn is cancelled once, frees its slot and wakes the watchdog`, async () => {
      const r = rig({ turns: [ask(["resolved"])] });
      await r.session.start();
      const turn = await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "plan" });
      const opened = await r.events.waitFor(
        (event) => event.type === "request.opened" || event.type === "user-input.requested",
        "the parent's card"
      );
      const resolved = await r.events.waitFor(
        (event) =>
          (event.type === "request.resolved" || event.type === "user-input.resolved") &&
          event.requestId === opened.requestId,
        "the card settled"
      );
      assert.deepEqual(
        resolved.payload,
        item === "command"
          ? { requestType: "command_execution_approval", decision: "cancel", withdrawn: true }
          : { answers: {}, withdrawn: true }
      );
      assert.equal(resolved.turnId, turn.turnId, "the card's own turn, as it was opened");

      await wireBarrier(r);
      assert.equal(r.session.currentTurnId, turn.turnId, "the turn runs on");

      // A later Stop writes nothing more for it, and never answers it.
      await r.session.interruptTurn(turn.turnId);
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      await r.stop();
    });

    const turnEnds = [["turn-interrupted"], ["turn-failed"], ["turn-interrupted", "resolved"]] as const;
    for (const steps of turnEnds) {
      it(`a parent ${item} card open as its turn ends (${steps.join(", then ")}) is cancelled once after the end; the next turn is watched`, async () => {
        const r = rig({ turns: [ask([...steps]), { kind: "silent" }] });
        await r.session.start();
        const turn = await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "plan" });
        const opened = await r.events.waitFor(
          (event) => event.type === "request.opened" || event.type === "user-input.requested",
          "the parent's card"
        );
        const turnEnded = await r.events.waitFor(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
          "the turn's end"
        );
        const resolved = await r.events.waitFor(
          (event) =>
            (event.type === "request.resolved" || event.type === "user-input.resolved") &&
            event.requestId === opened.requestId,
          "the card settled"
        );
        assert.equal((resolved.payload as { withdrawn?: boolean }).withdrawn, true);
        assert.equal(resolved.turnId, turn.turnId, "the card's own turn, ended as it was");
        assert.ok(
          indexOf(r, turnEnded) < indexOf(r, resolved),
          "after the turn's end, so the host's own dismissal of a question on it comes first"
        );
        await wireBarrier(r);
        assert.equal(r.session.currentTurnId, null);

        // The next turn is watched again: no stale card pauses it.
        const next = await r.session.sendTurn({ input: "again", attachments: [], interactionMode: "plan" });
        assert.equal(r.session.currentTurnId, next.turnId);

        await r.session.interruptTurn();
        await wireBarrier(r);
        assert.equal(resolutionsOf(r, opened.requestId).length, 1, "a later Stop writes nothing more");
        assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), [], "and sends nothing");
        await r.stop();
      });
    }
  }

  it("the parent's own thread closing with a card open cancels it once, never answered", async () => {
    const r = rig({ turns: [{ kind: "command-approval", command: "ls -1" }] });
    await r.session.start();
    const turn = await r.session.sendTurn({ input: "ls", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const parentThreadId = (r.session.summary().resumeCursor as { threadId: string }).threadId;
    await r.notify("thread/closed", { threadId: parentThreadId });
    const resolved = await r.events.waitForType("request.resolved");
    assert.equal(resolved.requestId, opened.requestId);
    assert.equal((resolved.payload as { withdrawn?: boolean }).withdrawn, true);
    assert.equal(resolved.turnId, turn.turnId);
    await wireBarrier(r);
    await wireBarrier(r);
    assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
    await r.stop();
  });

  it("a card no turn raised outlives a turn's end; its thread's close ends it", async () => {
    // An MCP server may ask outside any turn (`turnId: null`): a turn's end
    // says nothing about whether anything still waits on it.
    const r = rig({ turns: [{ kind: "elicitation", serverName: "serena", message: "Allow it?", turnless: true }] });
    await r.session.start();
    const turn = await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    assert.equal(opened.providerRefs?.providerTurnId, undefined, "asked outside any turn");
    const parentThreadId = (r.session.summary().resumeCursor as { threadId: string }).threadId;
    await r.notify("turn/completed", {
      threadId: parentThreadId,
      turn: turnOf(turn.turnId, "interrupted")
    });
    await wireBarrier(r);
    assert.equal(resolutionsOf(r, opened.requestId).length, 0, "the turn's end is not its end");

    await r.notify("thread/closed", { threadId: parentThreadId });
    const resolved = await r.events.waitForType("request.resolved");
    assert.equal(resolved.requestId, opened.requestId);
    assert.equal((resolved.payload as { withdrawn?: boolean }).withdrawn, true);
    await wireBarrier(r);
    await r.stop();
  });
});

describe("codex session — the liveness watchdog really pauses (Q1 finding 16)", () => {
  it("answering a card that outlived the window does not kill the turn", async (t) => {
    const r = rig({
      turns: [{ kind: "file-change-approval", path: "/tmp/a.txt", diff: "x\n", holdAfterApproval: true }]
    });
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    await r.session.sendTurn({ input: "write", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");

    t.mock.timers.tick(2 * 30 * 60_000);
    await wireBarrier(r);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 0, "the card pauses the watchdog");
    r.session.respondToApproval(opened.requestId!, "accept");
    await wireBarrier(r);
    t.mock.timers.tick(100);
    await wireBarrier(r);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 0, "answering resets the window");
    await r.stop();
  });
});

describe("codex session — a dead child never leaves a running state", () => {
  it("settles the turn, fails parked requests and only THEN emits session.exited", async () => {
    const r = rig({ turns: [{ kind: "exit-mid-turn", exitCode: 1 }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("session.exited");

    const types = r.events.types();
    const turnIndex = types.lastIndexOf("turn.completed");
    const exitIndex = types.lastIndexOf("session.exited");
    assert.ok(turnIndex !== -1, "the in-flight turn is settled");
    assert.ok(turnIndex < exitIndex, "the turn settles BEFORE session.exited");

    const settled = r.events.events[turnIndex]!;
    assert.equal(
      (settled.payload as { state: string }).state,
      "failed",
      "a non-zero exit settles the turn failed"
    );

    // A SIGTERM'd child writes not one further byte (fixtures README obs. 16),
    // so `handleExit` is the ONLY thing that can close its in-progress item —
    // the `14-…` capture's dangling `command_execution` (R3 finding 1).
    const closed = r.events.events.filter((event) => event.type === "item.completed");
    const opened = r.events.events.filter((event) => event.type === "item.started");
    assert.ok(opened.length > 0, "the turn really opened a tool item");
    for (const open of opened) {
      assert.ok(
        closed.some((done) => done.itemId === open.itemId),
        `item ${String(open.itemId)} was left spinning after the child died`
      );
    }
    assert.ok(
      r.events.types().lastIndexOf("item.completed") < exitIndex,
      "items close BEFORE session.exited"
    );

    const exited = r.events.events[exitIndex]!.payload as {
      exitKind: string;
      recoverable: boolean;
    };
    assert.equal(exitIndex, types.length - 1, "session.exited is last");
    assert.equal(exited.exitKind, "error");
    assert.equal(exited.recoverable, true, "recovery is thread/resume against the rollout file");
    assert.equal(r.session.isLive, false);
    assert.equal(r.closed(), true);
    await r.stop();
  });

  it("a zero exit settles the turn interrupted and reports a graceful exit", async () => {
    const r = rig({ turns: [{ kind: "exit-mid-turn", exitCode: 0 }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    const exited = await r.events.waitForType("session.exited");
    assert.equal((exited.payload as { exitKind: string }).exitKind, "graceful");
    const settled = r.events.events.filter((event) => event.type === "turn.completed").at(-1)!;
    assert.equal((settled.payload as { state: string }).state, "interrupted");
    await r.stop();
  });

  it("a later call on a dead session fails fast rather than hanging", async () => {
    const r = rig({ turns: [{ kind: "exit-mid-turn", exitCode: 1 }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("session.exited");
    await assert.rejects(
      () => r.session.sendTurn({ input: "y", attachments: [], interactionMode: "default" }),
      /not connected/
    );
    await r.stop();
  });
});

/**
 * A card nobody answered, closed by the session's own teardown — an interrupt,
 * a Stop, the process dying under it — is one row marked `withdrawn` ("Request
 * cancelled" / "Question cancelled"), on the stamps the card was opened with,
 * as Claude's, Grok's and OpenCode's are. It used to be "Approval resolved
 * {cancel}" / "User input submitted", saying someone answered — and on a
 * crash with no turn at all. The user's own answers, a `cancel` among them,
 * keep their normal row.
 */
describe("codex session — a card nobody answered, closed by the session's own teardown", () => {
  const closings = (r: Rig, requestId: string | undefined): RuntimeEvent[] =>
    r.events.events.filter(
      (event) =>
        (event.type === "request.resolved" || event.type === "user-input.resolved") &&
        event.requestId === requestId
    );
  const approval = (afterAsking?: MockParentAskEnd): MockTurnScript => ({
    kind: "command-approval",
    command: "sleep 30",
    ...(afterAsking !== undefined ? { afterAsking } : {})
  });
  const question = (afterAsking?: MockParentAskEnd): MockTurnScript => ({
    kind: "user-input",
    questionId: "q",
    header: "H",
    question: "Q?",
    options: [{ label: "a", description: "b" }],
    ...(afterAsking !== undefined ? { afterAsking } : {})
  });
  const WITHDRAWN = {
    approval: { requestType: "command_execution_approval", decision: "cancel", withdrawn: true },
    question: { answers: {}, withdrawn: true }
  } as const;

  /** A session whose one turn has parked the card `script` asks. */
  async function parked(
    item: "approval" | "question",
    afterAsking?: MockParentAskEnd
  ): Promise<{ r: Rig; opened: RuntimeEvent }> {
    const r = rig({ turns: [item === "approval" ? approval(afterAsking) : question(afterAsking)] });
    await r.session.start();
    await r.session.sendTurn({
      input: "x",
      attachments: [],
      interactionMode: item === "approval" ? "default" : "plan"
    });
    const opened = await r.events.waitForType(item === "approval" ? "request.opened" : "user-input.requested");
    return { r, opened };
  }

  for (const item of ["approval", "question"] as const) {
    it(`an interrupt withdraws a parked ${item}: one row, on its own stamps — and still cancels it on the wire`, async () => {
      const { r, opened } = await parked(item);
      await r.session.interruptTurn();
      await waitUntil(() => closings(r, opened.requestId).length > 0, "the card's closing row");
      const rows = closings(r, opened.requestId);
      assert.equal(rows.length, 1, "one closing row");
      assert.deepEqual(rows[0]!.payload, WITHDRAWN[item], "nobody answered it");
      assert.equal(rows[0]!.turnId, opened.turnId, "on the turn the card was opened with");
      const answered = r.received().filter((frame) => frame.result !== undefined).at(-1);
      assert.deepEqual(
        answered?.result,
        item === "approval" ? { decision: "cancel" } : { answers: {} },
        "the server's request is still answered before the interrupt (§4.1)"
      );
      await r.stop();
      assert.equal(closings(r, opened.requestId).length, 1, "a later Stop writes nothing more");
    });

    it(`a crash withdraws a parked ${item}: one row, on its own stamps, before session.exited`, async () => {
      const { r, opened } = await parked(item, ["exit"]);
      await r.events.waitForType("session.exited");
      const rows = closings(r, opened.requestId);
      assert.equal(rows.length, 1, "one closing row");
      assert.deepEqual(rows[0]!.payload, WITHDRAWN[item], "nobody answered it");
      assert.equal(rows[0]!.turnId, opened.turnId, "on the turn the card was opened with");
      if (item === "approval") {
        assert.equal(rows[0]!.itemId, opened.itemId, "and on its item");
      }
      const order = r.events.events;
      const closedAt = order.indexOf(rows[0]!);
      assert.ok(
        closedAt < order.findIndex((event) => event.type === "turn.completed"),
        "the card closes before its turn settles, as every adapter's does"
      );
      assert.ok(closedAt < order.findIndex((event) => event.type === "session.exited"));
      await r.stop();
    });
  }

  it("the user's own cancel is an answer: its normal row, never withdrawn", async () => {
    const { r, opened } = await parked("approval");
    r.session.respondToApproval(opened.requestId!, "cancel");
    await r.events.waitForType("turn.completed");
    const rows = closings(r, opened.requestId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.payload, { requestType: "command_execution_approval", decision: "cancel" });
    assert.equal(rows[0]!.turnId, opened.turnId);
    await r.stop();
  });

  it("the user's own answer to a question keeps its normal row", async () => {
    const { r, opened } = await parked("question");
    r.session.respondToUserInput(opened.requestId!, { q: "a" });
    await r.events.waitForType("turn.completed");
    const rows = closings(r, opened.requestId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.payload, { answers: { q: "a" } });
    assert.equal(rows[0]!.turnId, opened.turnId);
    await r.stop();
  });
});

describe("codex session — spawn and handshake failures", () => {
  it("a missing binary is an outcome, not an exception that hides the cause", async () => {
    const r = rig({ bin: "/nonexistent/codex-binary", turns: [] });
    await assert.rejects(() => r.session.start());
    await waitUntil(() => r.events.types().includes("session.exited"), "session.exited");
    const exited = r.events.events.find((event) => event.type === "session.exited")!;
    assert.equal((exited.payload as { exitKind: string }).exitKind, "error");
    assert.match(String((exited.payload as { reason?: string }).reason), /failed to spawn/);
    await r.stop();
  });

  it("a child that never answers initialize is KILLED by the deadline, not left starting forever", async (t) => {
    const r = rig({ hangOnInitialize: true });
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const outcome = assert.rejects(r.session.start(), /timed out after 30000ms/);
    await r.waitForSent("initialize");
    t.mock.timers.tick(30_000);
    await outcome;
    await r.events.waitForType("session.exited");
    assert.equal(r.session.isLive, false, "the thread does not stay starting forever");
    await r.stop();
  });

  it("a child that exits before the handshake settles the session", async () => {
    const r = rig({ exitAfterMs: 1, hangOnInitialize: true });
    await assert.rejects(() => r.session.start());
    await waitUntil(() => r.events.types().includes("session.exited"), "session.exited");
    await r.stop();
  });
});

describe("codex session — request ids are unique across a thread's SESSIONS (R2-1)", () => {
  it("a second session of the same thread never reuses the first's request ids", async () => {
    // A thread outlives its provider sessions (host restart → `thread/resume`),
    // but the request counter restarts at 1 with each one. Spelled
    // `codex-<threadId>-<n>`, the first approval of session two was identical
    // to the first approval of session one — which the host had already
    // resolved and TOMBSTONED — so the new card was swallowed and the turn
    // hung on a prompt the user never saw (E2E round 2).
    //
    // One shared context across both sessions, exactly as the host has one
    // adapter context for every session it opens.
    const { context } = createFakeContext();

    const openApproval = async (script: MockTurnScript): Promise<string> => {
      const r = rig({ turns: [script] }, { context });
      await r.session.start();
      await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
      const opened = await r.events.waitForType("request.opened");
      await r.stop();
      return String(opened.requestId);
    };

    const first = await openApproval({ kind: "command-approval", command: "rm -rf /tmp/x" });
    const second = await openApproval({
      kind: "file-change-approval",
      path: "/tmp/a.ts",
      diff: "+x\n"
    });

    assert.notEqual(second, first, "a resolved id from a dead session must never come back");
  });

  it("ids stay unique WITHIN a session too", async () => {
    const r = rig({
      turns: [
        { kind: "command-approval", command: "one" },
        { kind: "command-approval", command: "two" }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "a", attachments: [], interactionMode: "default" });
    const one = await r.events.waitForType("request.opened");
    await r.session.respondToApproval(String(one.requestId), "accept");
    await r.events.waitForType("turn.completed");

    await r.session.sendTurn({ input: "b", attachments: [], interactionMode: "default" });
    await waitUntil(
      () => r.events.events.filter((event) => event.type === "request.opened").length === 2,
      "the second approval"
    );
    const opened = r.events.events.filter((event) => event.type === "request.opened");
    assert.notEqual(String(opened[1]!.requestId), String(opened[0]!.requestId));
    await r.stop();
  });
});

describe("codex session — resume", () => {
  it("resumes with excludeTurns:true and every launch param", async () => {
    const r = rig({ turns: [{ kind: "text", text: "pineapple-42" }] }, {
      resumeCursor: { threadId: "prior-thread" }
    });
    await r.session.start();
    const [resume] = sentFrames(r.received(), "thread/resume");
    assert.equal(resume!.threadId, "prior-thread");
    assert.equal(resume!.excludeTurns, true, "full-history hydration is deprecated");
    assert.equal(resume!.approvalsReviewer, "user", "explicit, including on resume");
    assert.equal(resume!.sandbox, "read-only");
    assert.equal(sentFrames(r.received(), "thread/start").length, 0);
    await r.stop();
  });

  it("a failed resume falls back to a fresh thread and TELLS the user", async () => {
    const r = rig({ failResume: true, turns: [{ kind: "text", text: "fresh" }] }, {
      resumeCursor: { threadId: "gone" }
    });
    await r.session.start();
    assert.equal(sentFrames(r.received(), "thread/start").length, 1, "fell back to a fresh thread");
    // A `runtime.warning` renders tone `info` and got buried among the host's
    // bubblewrap notices, so the user believed they had reopened their
    // conversation (E2E E5/E19). Losing a conversation is an ERROR row.
    const surfaced = r.events.events.find((event) => event.type === "runtime.error");
    assert.ok(surfaced !== undefined, "never a silent degrade");
    assert.equal(surfaced.type, "runtime.error", "not a tone-info warning");
    assert.equal((surfaced.payload as { class: string }).class, "provider_error");
    await r.stop();
  });

  it("a malformed cursor means 'no resume', never an error", async () => {
    for (const resumeCursor of [
      undefined, null, {}, { threadId: "" }, { threadId: 42 }, "t-1", [],
      "01a0c19d-e1f9-7e73-8dc5-a0d355d3d232", { threadId: "../../etc/passwd" },
      { threadId: "-flag-shaped" }, { threadId: "x".repeat(257) }
    ]) {
      const r = rig({ turns: [] }, { resumeCursor });
      await r.session.start();
      assert.equal(sentFrames(r.received(), "thread/resume").length, 0);
      assert.equal(sentFrames(r.received(), "thread/start").length, 1);
      await r.stop();
    }
  });

  it("the summary carries the resume cursor as {threadId}", async () => {
    const r = rig({ threadId: "codex-thread-9", turns: [{ kind: "text", text: "a" }] });
    const summary = await r.session.start();
    assert.deepEqual(summary.resumeCursor, { threadId: "codex-thread-9" });
    await r.stop();
  });
});

describe("codex session — compaction", () => {
  it("sends native compaction to the provider thread", async () => {
    const r = rig({ threadId: "provider-compact", turns: [] });
    await r.session.start();
    await r.session.compact();
    assert.deepEqual(sentFrames(r.received(), "thread/compact/start"), [
      { threadId: "provider-compact" }
    ]);
    await r.stop();
  });
});

describe("codex session — rollback", () => {
  it("never calls the dead thread/rollback; it lists turns then reverts", async () => {
    const r = rig({
      historyTurnIds: ["turn-newest", "turn-older", "turn-oldest"],
      turns: [{ kind: "text", text: "a" }]
    });
    await r.session.start();
    const snapshot = await r.session.rollbackThread(1);

    assert.equal(sentFrames(r.received(), "thread/rollback").length, 0, "that endpoint is dead");
    const [list] = sentFrames(r.received(), "thread/turns/list");
    assert.ok(list !== undefined);
    const [revert] = sentFrames(r.received(), "thread/revert");
    assert.equal(
      revert!.beforeTurnId,
      "turn-newest",
      "rolling back one turn reverts before the newest"
    );
    // The revert response's `turns` is always empty; the snapshot is
    // re-hydrated through thread/turns/list.
    assert.equal(snapshot.threadId, "thread-1");
    assert.equal(snapshot.turns.length, 3);
    assert.equal(snapshot.turns[0]!.id, "turn-oldest", "the snapshot reads oldest-first");
    await r.stop();
  });

  it("reverting further back than the history refuses rather than half-performing", async () => {
    const r = rig({ historyTurnIds: ["only-one"], turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    await assert.rejects(() => r.session.rollbackThread(5), /cannot roll back 5 turn/);
    assert.equal(sentFrames(r.received(), "thread/revert").length, 0, "nothing was touched");
    await r.stop();
  });

  it("reverts before the turn the host NAMED, even where its count points elsewhere", async () => {
    // Compaction runs as a whole extra turn (fixtures README observation 8):
    // the provider's list holds a turn the host's fold did not count, so the
    // 2nd-newest turn is not the one the user rewound to.
    const r = rig({
      historyTurnIds: ["turn-3", "turn-compact", "turn-2", "turn-1"],
      turns: [{ kind: "text", text: "a" }]
    });
    await r.session.start();
    const snapshot = await r.session.rollbackThread(2, {
      firstRemovedTurnId: "turn-2",
      droppedTurnIds: ["turn-2", "turn-3"],
      retainedTurnIds: ["turn-1"]
    });

    const reverts = sentFrames(r.received(), "thread/revert");
    assert.equal(reverts.length, 1);
    assert.equal(
      reverts[0]!.beforeTurnId,
      "turn-2",
      "the id wins; a count of 2 would have reverted before turn-compact"
    );
    // Re-hydrated through thread/turns/list AFTER the revert, as on the count path.
    const methods = r.received().map((frame) => frame.method);
    assert.ok(methods.lastIndexOf("thread/turns/list") > methods.indexOf("thread/revert"));
    assert.equal(snapshot.threadId, "thread-1");
    await r.stop();
  });

  it("refuses a turn the thread no longer holds, and reverts nothing", async () => {
    const r = rig({ historyTurnIds: ["turn-2", "turn-1"], turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    await assert.rejects(
      () =>
        r.session.rollbackThread(1, {
          firstRemovedTurnId: "turn-gone",
          droppedTurnIds: ["turn-gone"],
          retainedTurnIds: ["turn-1", "turn-2"]
        }),
      /codex: the turn to rewind to is no longer in this thread/
    );
    assert.equal(
      sentFrames(r.received(), "thread/revert").length,
      0,
      "an unresolvable id is a refusal, never a count-based guess"
    );
    await r.stop();
  });

  it("pages back only as far as the named turn, and reads ids without items", async () => {
    const r = rig({
      historyTurnIds: ["t7", "t6", "t5", "t4", "t3", "t2", "t1"],
      turnsPageSize: 2,
      turns: [{ kind: "text", text: "a" }]
    });
    await r.session.start();
    await r.session.rollbackThread(1, {
      firstRemovedTurnId: "t3",
      droppedTurnIds: ["t3", "t4", "t5", "t6", "t7"],
      retainedTurnIds: ["t1", "t2"]
    });

    const frames = r.received();
    const revertAt = frames.findIndex((frame) => frame.method === "thread/revert");
    assert.ok(revertAt >= 0, "the revert was sent");
    assert.equal(
      (frames[revertAt]!.params as { beforeTurnId: string }).beforeTurnId,
      "t3",
      "found on the third page, well past a count-sized first page"
    );
    const lookup = frames
      .slice(0, revertAt)
      .filter((frame) => frame.method === "thread/turns/list")
      .map((frame) => frame.params as Record<string, unknown>);
    assert.deepEqual(
      lookup.map((params) => params.cursor ?? null),
      [null, "2", "4"],
      "each page resumes from the cursor the last one handed back, and the fourth is never read"
    );
    assert.ok(
      lookup.every((params) => !("itemsView" in params)),
      "the lookup takes the server's default summary view"
    );
    await r.stop();
  });
});

describe("codex session — stderr is home-path redacted (S1 finding 4)", () => {
  it("collapses the account home and HOME to ~ before the line leaves the host", async () => {
    // §3.1: the excerpt is "redacted before it leaves the host — home paths
    // collapsed to `~`". `redactStderr` only collapses the dirs it is HANDED,
    // so this is a call-site test: the function's own tests cannot catch a
    // `new StderrCapture()` built with no options.
    const accountHome = "/var/lib/orquester/daemon/agent-accounts/codex/acc-secret/home";
    const server = writeMockCodexServer({
      turns: [{ kind: "text", text: "a" }],
      stderr: `ERROR codex: cannot read ${accountHome}/auth.json (HOME=/var/lib/orquester)\n`
    });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));

    const { context } = createFakeContext();
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const events = new EventCollector(queue);
    let seq = 0;
    const session = new CodexSession({
      context,
      threadId: "thread-redact",
      cwd: process.cwd(),
      codexHome: accountHome,
      bin: server.bin,
      env: { PATH: process.env.PATH ?? "", HOME: "/var/lib/orquester" },
      runtimeMode: "approval-required",
      modelSelection: { model: "gpt-5.5" },
      emit: (draft) => {
        queue.push({
          ...draft,
          eventId: `ev-${++seq}`,
          threadId: "thread-redact",
          createdAt: "2026-09-21T00:00:00.000Z"
        } as RuntimeEvent);
      },
      onClosed: () => {}
    });
    await session.start();

    const surfaced = await events.waitFor(
      (event) =>
        (event.type === "runtime.error" || event.type === "runtime.warning") &&
        String((event.payload as { message: string }).message).includes("cannot read"),
      "the stderr row (not the unrelated CODEX_HOME warning)"
    );
    const message = String((surfaced.payload as { message: string }).message);
    assert.ok(!message.includes("/var/lib/orquester"), `absolute host path leaked: ${message}`);
    assert.ok(!message.includes("acc-secret"), "the account id leaked with the path");
    assert.match(message, /~/);

    await session.stop();
    queue.close();
  });
});

describe("codex session — raw frame logging", () => {
  it("logs sent and received frames under their owning thread", async () => {
    const fake = createFakeContext();
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const events = new EventCollector(queue);
    const server = writeMockCodexServer({ turns: [{ kind: "text", text: "a" }] });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    let seq = 0;
    const session = new CodexSession({
      context: fake.context,
      threadId: "thread-raw",
      cwd: process.cwd(),
      bin: server.bin,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
      runtimeMode: "approval-required",
      modelSelection: { model: "gpt-5.5" },
      emit: (draft) => {
        queue.push({
          ...draft,
          eventId: `ev-${++seq}`,
          threadId: "thread-raw",
          createdAt: "2026-09-21T00:00:00.000Z"
        } as RuntimeEvent);
      },
      onClosed: () => {}
    });
    await session.start();
    await session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await events.waitForType("turn.completed");

    const directions = new Set(
      fake.rawFrames.map((entry) => (entry.frame as { direction: string }).direction)
    );
    assert.deepEqual([...directions].sort(), ["recv", "send"]);
    assert.ok(fake.rawFrames.every((entry) => entry.threadId === "thread-raw"));
    await session.stop();
    queue.close();
  });
});

// ---------------------------------------------------------------------------
// Goals (goals §6.2)
// ---------------------------------------------------------------------------

/** The mock's default stored goal, normalised — what the fold would hold. */
const knownGoal = (overrides: Partial<AgentGoal> = {}): AgentGoal => ({
  objective: "Make the build green",
  status: "active",
  tokensUsed: 0,
  tokenBudget: null,
  elapsedMs: 0,
  setAt: "2026-09-21T00:20:00.000Z",
  ...overrides
});

/** The same goal as the mock's goal store holds it. */
const STORED_GOAL = { objective: "Make the build green", status: "active" };

/** Resumed onto a thread whose fold already holds `knownGoal()`. */
const RESUMED_WITH_GOAL: Partial<CodexSessionOptions> = {
  resumeCursor: { threadId: "prior-thread" },
  knownGoal: knownGoal()
};

function goalRows(r: Rig): GoalUpdatedPayload[] {
  return r.events.events
    .filter((event) => event.type === "thread.goal.updated")
    .map((event) => event.payload as GoalUpdatedPayload);
}

function goalRequests(r: Rig): { method: string; params: Record<string, unknown> }[] {
  return r
    .received()
    .filter((frame) => typeof frame.method === "string" && frame.method.startsWith("thread/goal/"))
    .map((frame) => ({
      method: frame.method!,
      params: (frame.params ?? {}) as Record<string, unknown>
    }));
}

function waitForGoalRow(r: Rig, change: string): Promise<RuntimeEvent> {
  return r.events.waitFor(
    (event) =>
      event.type === "thread.goal.updated" &&
      (event.payload as GoalUpdatedPayload).change === change,
    `thread.goal.updated {${change}}`
  );
}

/** How many `thread/goal/updated` frames the session has read off the wire. */
function readGoalUpdates(r: Rig): number {
  return r.rawFrames.filter((entry) => {
    const logged = entry.frame as { direction?: string; frame?: { method?: string } };
    return logged.direction === "recv" && logged.frame?.method === "thread/goal/updated";
  }).length;
}

function isPause(frame: { method?: string; params?: unknown }): boolean {
  return (
    frame.method === "thread/goal/set" && (frame.params as { status?: string }).status === "paused"
  );
}

describe("codex session — /goal is mapped onto thread/goal/* (goals §6.2.3)", () => {
  it("status with no goal says so, and asks only thread/goal/get", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "status" }), {
      summary: "No goal is set."
    });
    assert.deepEqual(goalRequests(r), [
      { method: "thread/goal/get", params: { threadId: "thread-mock-1" } }
    ]);
    await r.stop();
  });

  it("set with no goal: get, then set it active — and the reply and its notification are ONE `set` row", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    assert.deepEqual(
      await r.session.goalCommand({ kind: "set", objective: "Make the build green" }),
      { summary: "" },
      "the provider's own update tells the story"
    );
    assert.deepEqual(goalRequests(r), [
      { method: "thread/goal/get", params: { threadId: "thread-mock-1" } },
      {
        method: "thread/goal/set",
        params: { threadId: "thread-mock-1", objective: "Make the build green", status: "active" }
      }
    ]);
    const row = await waitForGoalRow(r, "set");
    assert.deepEqual((row.payload as GoalUpdatedPayload).goal, {
      objective: "Make the build green",
      status: "active",
      tokensUsed: 0,
      tokenBudget: null,
      elapsedMs: 0,
      setAt: "2026-09-21T00:20:01.000Z"
    });
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => payload.change),
      ["set"]
    );
    await r.stop();
  });

  it("set over an existing goal clears it first — get, clear, set — and the rows say so", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    await r.session.goalCommand({ kind: "set", objective: "Ship the release" });
    assert.deepEqual(
      goalRequests(r).map((request) => request.method),
      ["thread/goal/get", "thread/goal/clear", "thread/goal/set"]
    );
    await waitForGoalRow(r, "set");
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => [
        payload.change,
        payload.goal?.objective ?? payload.previous?.objective
      ]),
      [
        ["cleared", "Make the build green"],
        ["set", "Ship the release"]
      ]
    );
    await r.stop();
  });

  it("edit changes the objective in place — `replaced`, status kept", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    assert.deepEqual(
      await r.session.goalCommand({ kind: "edit", objective: "Make the build green, fast" }),
      { summary: "" }
    );
    assert.deepEqual(goalRequests(r), [
      { method: "thread/goal/get", params: { threadId: "thread-mock-1" } },
      {
        method: "thread/goal/set",
        params: { threadId: "thread-mock-1", objective: "Make the build green, fast" }
      }
    ]);
    const row = await waitForGoalRow(r, "replaced");
    assert.equal((row.payload as GoalUpdatedPayload).goal?.status, "active");
    await r.stop();
  });

  it("edit with no goal says so and changes nothing — never a set", async () => {
    // A bare `set {objective}` would CREATE an active goal here, which is not
    // what "edit" asked for (fix round 1, ruling 1).
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "edit", objective: "Ship it" }), {
      summary: "No goal is set. Use /goal <objective> to set one."
    });
    assert.deepEqual(
      goalRequests(r).map((request) => request.method),
      ["thread/goal/get"]
    );
    await wireBarrier(r);
    assert.deepEqual(goalRows(r), []);
    await r.stop();
  });

  it("pause and resume set the status and nothing else — resume reads the goal first", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "pause" }), { summary: "" });
    await waitForGoalRow(r, "paused");
    assert.deepEqual(await r.session.goalCommand({ kind: "resume" }), { summary: "" });
    await waitForGoalRow(r, "resumed");
    assert.deepEqual(goalRequests(r), [
      { method: "thread/goal/set", params: { threadId: "thread-mock-1", status: "paused" } },
      { method: "thread/goal/get", params: { threadId: "thread-mock-1" } },
      { method: "thread/goal/set", params: { threadId: "thread-mock-1", status: "active" } }
    ]);
    await r.stop();
  });

  it("resume with no goal answers `No goal is set.` and sends no set", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "resume" }), {
      summary: "No goal is set."
    });
    assert.deepEqual(
      goalRequests(r).map((request) => request.method),
      ["thread/goal/get"]
    );
    await r.stop();
  });

  it("resume on a goal that reached its budget says so and sends nothing", async () => {
    // Codex would keep a budget-limited goal budget-limited, silently.
    const r = rig(
      { goal: { ...STORED_GOAL, status: "budgetLimited" }, turns: [{ kind: "silent" }] },
      {
        resumeCursor: { threadId: "prior-thread" },
        knownGoal: knownGoal({ status: "budget-limited" })
      }
    );
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "resume" }), {
      summary:
        "This goal reached its token budget and can't be resumed. Set a new goal or clear it."
    });
    assert.deepEqual(
      goalRequests(r).map((request) => request.method),
      ["thread/goal/get"]
    );
    await r.stop();
  });

  it("clear clears — and a second clear finds nothing and says so", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "clear" }), { summary: "" });
    const row = await waitForGoalRow(r, "cleared");
    assert.deepEqual(row.payload, { goal: null, change: "cleared", previous: knownGoal() });
    assert.deepEqual(await r.session.goalCommand({ kind: "clear" }), {
      summary: "No goal is set."
    });
    assert.deepEqual(
      goalRequests(r).map((request) => request.method),
      ["thread/goal/clear", "thread/goal/clear"]
    );
    await wireBarrier(r);
    assert.equal(goalRows(r).length, 1, "nothing to clear is no row");
    await r.stop();
  });

  it("a provider error rejects with the provider's own message", async () => {
    const r = rig({
      goalError: { code: -32600, message: "goals feature is disabled" },
      turns: [{ kind: "silent" }]
    });
    await r.session.start();
    await assert.rejects(r.session.goalCommand({ kind: "pause" }), {
      message: "goals feature is disabled"
    });
    await r.stop();
  });

  it("a get a notification overtook is discarded (goals §6.2.5)", async () => {
    // #8615: re-emitting a stale `get` put an older goal back over a newer one.
    const r = rig(
      { goal: STORED_GOAL, goalMovesDuringGet: "paused", turns: [{ kind: "silent" }] },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    const { summary } = await r.session.goalCommand({ kind: "status" });
    assert.match(summary, /^Goal paused: /, "the newer word wins");
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => payload.change),
      ["paused"],
      "the stale reply re-emitted nothing"
    );
    await r.stop();
  });
});

describe("codex session — Stop pauses an active goal first (goals §6.2.4)", () => {
  it("sends thread/goal/set {status:paused} BEFORE turn/interrupt", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.session.goalCommand({ kind: "set", objective: "Make the build green" });
    await waitForGoalRow(r, "set");
    const { turnId } = await r.session.sendTurn({
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.started");

    await r.session.interruptTurn(turnId, { pauseGoal: true });

    const received = r.received();
    const pauseIndex = received.findIndex(isPause);
    const interruptIndex = received.findIndex((frame) => frame.method === "turn/interrupt");
    assert.ok(pauseIndex !== -1, "the goal was paused");
    assert.ok(interruptIndex !== -1, "the turn was interrupted");
    assert.ok(
      pauseIndex < interruptIndex,
      "paused FIRST: an interrupt alone lets the next continuation start at once (openai/codex #28104)"
    );
    assert.deepEqual(received[pauseIndex]!.params, { threadId: "thread-mock-1", status: "paused" });
    await waitForGoalRow(r, "paused");
    await r.events.waitForType("turn.completed");
    await r.stop();
  });

  it("still interrupts when the pause fails, and logs why", async () => {
    const r = rig(
      {
        goal: STORED_GOAL,
        goalError: { code: -32600, message: "goals feature is disabled" },
        turns: [{ kind: "silent" }]
      },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    const { turnId } = await r.session.sendTurn({
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.started");

    await r.session.interruptTurn(turnId, { pauseGoal: true });

    const received = r.received();
    assert.ok(received.findIndex(isPause) !== -1, "the pause was tried");
    assert.equal(sentFrames(received, "turn/interrupt").length, 1, "never blocked by the pause");
    await r.events.waitForType("turn.completed");
    assert.ok(
      r.logs.some((log) => log.level === "warn" && /pause/i.test(log.message)),
      "the failure is logged"
    );
    await r.stop();
  });

  it("still interrupts when the pause times out — and the child lives", async (t) => {
    const r = rig(
      { goal: STORED_GOAL, hangGoalSet: true, turns: [{ kind: "silent" }] },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const interrupted = r.session.interruptTurn(undefined, { pauseGoal: true });
    await r.waitForSent("thread/goal/set");
    t.mock.timers.tick(1_500);
    await interrupted;

    const received = r.received();
    const pauseIndex = received.findIndex(isPause);
    const interruptIndex = received.findIndex((frame) => frame.method === "turn/interrupt");
    assert.ok(pauseIndex !== -1 && interruptIndex !== -1 && pauseIndex < interruptIndex);
    await r.events.waitForType("turn.completed");
    assert.equal(r.session.isLive, true, "a slow pause never kills the child");
    await r.stop();
  });

  it("asks nothing when the goal is not active", async () => {
    const r = rig(
      { goal: { ...STORED_GOAL, status: "paused" }, turns: [{ kind: "silent" }] },
      { resumeCursor: { threadId: "prior-thread" }, knownGoal: knownGoal({ status: "paused" }) }
    );
    await r.session.start();
    const { turnId } = await r.session.sendTurn({
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.started");
    await r.session.interruptTurn(turnId, { pauseGoal: true });
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 0);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 1);
    await r.stop();
  });

  it("a session-scoped Stop with no turn running pauses the goal too", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    await r.session.interruptTurn(undefined, { pauseGoal: true });
    assert.deepEqual(sentFrames(r.received(), "thread/goal/set"), [
      { threadId: "thread-mock-1", status: "paused" }
    ]);
    await r.stop();
  });

  it("a STALE Stop pauses nothing", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    await r.session.interruptTurn("some-other-turn", { pauseGoal: true });
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 0);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 0);
    await r.stop();
  });

  it("stopping the SESSION never pauses — a drain-restart must let Codex continue the goal", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    await r.stop();
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 0);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 1, "the turn itself still stops");
  });

});

describe("codex session — the adapter's own watchdog stands down for an active goal (fix round 1)", () => {
  it("with no goal it fires as it always did, and pauses nothing", async (t) => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    t.mock.timers.tick(10 * 60_000);
    await r.events.waitForType("turn.completed");
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 1, "the watchdog fired");
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 0);
    await r.stop();
  });

  it("an active goal stands it down, and pausing the goal mid-turn hands the turn back", async (t) => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    t.mock.timers.tick(8 * 10 * 60_000);
    await wireBarrier(r);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 0, "eight windows, no interrupt");

    await r.session.goalCommand({ kind: "pause" });
    await wireBarrier(r);
    t.mock.timers.tick(10 * 60_000);
    await r.events.waitForType("turn.completed");
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 1, "back on its normal window");
    assert.deepEqual(sentFrames(r.received(), "thread/goal/set"), [
      { threadId: "thread-mock-1", status: "paused" }
    ], "only the user's pause: the adapter's watchdog pauses nothing");
    await r.stop();
  });

  it("an open tool does not bring it back either", async (t) => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "open-tool" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("item.started");
    t.mock.timers.tick(8 * 30 * 60_000);
    await wireBarrier(r);
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 0, "eight tool windows, no interrupt");

    await r.session.goalCommand({ kind: "pause" });
    await wireBarrier(r);
    t.mock.timers.tick(30 * 60_000);
    await r.events.waitForType("turn.completed");
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 1, "the tool window is back");
    await r.stop();
  });
});

describe("codex session — the resume snapshot against the fold's goal (goals §6.2.2)", () => {
  it("the goal the fold already has is no news, and nothing is asked on session start", async () => {
    const r = rig({ goal: STORED_GOAL, turns: [{ kind: "silent" }] }, RESUMED_WITH_GOAL);
    await r.session.start();
    await wireBarrier(r);
    assert.deepEqual(goalRows(r), []);
    assert.deepEqual(goalRequests(r), [], "no goal request runs on session start");
    await r.stop();
  });

  it("none, on an account switch, re-creates the goal — paused unless it was active, with its budget — as `restored`", async () => {
    const r = rig(
      { turns: [{ kind: "silent" }] },
      {
        resumeCursor: { threadId: "prior-thread" },
        knownGoal: knownGoal({ status: "blocked", tokenBudget: 50_000, tokensUsed: 7_000 }),
        carryGoal: true
      }
    );
    await r.session.start();
    const row = await waitForGoalRow(r, "restored");
    assert.deepEqual(goalRequests(r), [
      {
        method: "thread/goal/set",
        params: {
          threadId: "thread-mock-1",
          objective: "Make the build green",
          status: "paused",
          tokenBudget: 50_000
        }
      }
    ]);
    assert.deepEqual((row.payload as GoalUpdatedPayload).goal, {
      objective: "Make the build green",
      status: "paused",
      tokensUsed: 0,
      tokenBudget: 50_000,
      elapsedMs: 0,
      setAt: "2026-09-21T00:20:01.000Z"
    });
    const received = r.received();
    assert.ok(
      received.findIndex((frame) => frame.method === "thread/resume") <
        received.findIndex((frame) => frame.method === "thread/goal/set"),
      "re-created on the resumed thread"
    );
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => payload.change),
      ["restored"],
      "never reported cleared, and the reply and its notification are one row"
    );
    await r.stop();
  });

  it("a carry that fails reports the goal cleared, and says why", async () => {
    const r = rig(
      { goalError: { code: -32600, message: "goals feature is disabled" }, turns: [{ kind: "silent" }] },
      { ...RESUMED_WITH_GOAL, carryGoal: true }
    );
    await r.session.start();
    const row = await waitForGoalRow(r, "cleared");
    assert.deepEqual(row.payload, { goal: null, change: "cleared", previous: knownGoal() });
    const warning = await r.events.waitFor(
      (event) =>
        event.type === "runtime.warning" &&
        JSON.stringify(event.payload).includes("goals feature is disabled"),
      "the carry's warning"
    );
    assert.match(String((warning.payload as { message: string }).message), /goal/i);
    await r.stop();
  });

  it("with no snapshot, the first turn closes the window: a later update is an ordinary one", async () => {
    const r = rig(
      {
        goal: STORED_GOAL,
        noResumeGoalSnapshot: true,
        goalMovesDuringGet: "paused",
        turns: [{ kind: "text", text: "a" }]
      },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    await r.session.sendTurn({ input: "go", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    // The mock moves the goal and announces it BEFORE the reply: a
    // notification only, so nothing but the window decides what it is.
    await r.session.goalCommand({ kind: "status" });
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => payload.change),
      ["paused"],
      "`restored` would mean the window outlived the turn"
    );
    await r.stop();
  });
});

describe("codex adapter — the goal surface (goals §4.6)", () => {
  it("goalCommand needs a live session, exactly as sendTurn does", async () => {
    const { context } = createFakeContext();
    const adapter = await createCodexAdapter(context);
    await assert.rejects(
      adapter.goalCommand!("thread-nobody", { kind: "status" }),
      /no live session/
    );
    await adapter.stopAll();
  });

  it("hands the fold's goal and the carry to the session, and Stop pauses before interrupting", async () => {
    const server = writeMockCodexServer({ turns: [{ kind: "silent" }] });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    const { context } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin) });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    const events = new EventCollector(adapter.events);
    // Probe this cwd up front, so `startSession` finds it cached and forks no
    // background probe for the teardown to orphan.
    await adapter.refreshSnapshot({ cwd: process.cwd() });

    await adapter.startSession({
      threadId: "thread-1",
      cwd: process.cwd(),
      home: { kind: "system", path: "" },
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required",
      resumeCursor: { threadId: "prior-thread" },
      knownGoal: knownGoal(),
      carryGoal: true
    });
    // The resumed thread has no goal on this home, so it is re-created —
    // which only happens when both fields reached the session.
    await events.waitFor(
      (event) =>
        event.type === "thread.goal.updated" &&
        (event.payload as GoalUpdatedPayload).change === "restored",
      "the carried goal"
    );

    const { turnId } = await adapter.sendTurn({
      threadId: "thread-1",
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await events.waitForType("turn.started");
    await adapter.interruptTurn("thread-1", turnId);

    const received = server.received();
    const pauseIndex = received.findIndex(isPause);
    const interruptIndex = received.findIndex((frame) => frame.method === "turn/interrupt");
    assert.ok(pauseIndex !== -1, "the adapter's Stop paused the goal");
    assert.ok(interruptIndex !== -1 && pauseIndex < interruptIndex);

    // Goals §4.6 `GoalCommandOptions`: the adapter hands the model through.
    await adapter.goalCommand!(
      "thread-1",
      { kind: "status" },
      { modelSelection: { model: "gpt-5.6-luna" } }
    );
    assert.deepEqual(sentFrames(server.received(), "thread/settings/update"), [
      { threadId: "thread-mock-1", model: "gpt-5.6-luna" }
    ]);
    await adapter.stopAll();
  });
});

describe("codex session — a /goal right after an account switch waits for the carry (fix round 1)", () => {
  const SWITCHED: Partial<CodexSessionOptions> = {
    resumeCursor: { threadId: "prior-thread" },
    knownGoal: knownGoal({ status: "paused" }),
    carryGoal: true
  };

  it("/goal resume issued right after the switch succeeds once the carry lands", async () => {
    const r = rig({ resumeGoalSnapshotDelayMs: 150, turns: [{ kind: "silent" }] }, SWITCHED);
    await r.session.start();
    // The snapshot has not come yet: the command waits for it and the carry.
    assert.deepEqual(await r.session.goalCommand({ kind: "resume" }), { summary: "" });
    await waitForGoalRow(r, "resumed");
    assert.deepEqual(goalRequests(r), [
      {
        method: "thread/goal/set",
        params: {
          threadId: "thread-mock-1",
          objective: "Make the build green",
          status: "paused",
          tokenBudget: null
        }
      },
      // `resume` reads the goal first — the carried one, by now.
      { method: "thread/goal/get", params: { threadId: "thread-mock-1" } },
      { method: "thread/goal/set", params: { threadId: "thread-mock-1", status: "active" } }
    ]);
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => payload.change),
      ["restored", "resumed"]
    );
    await r.stop();
  });

  it("a reply read before the snapshot is stale: no `cleared`, and the carry still happens", async (t) => {
    const r = rig({ noResumeGoalSnapshot: true, turns: [{ kind: "silent" }] }, SWITCHED);
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const command = r.session.goalCommand({ kind: "status" });
    await wireBarrier(r);
    t.mock.timers.tick(2_000);
    const { summary } = await command;
    assert.match(summary, /^Goal paused: /, "answered from the fold's goal, not a home still settling");
    await r.notify("thread/goal/cleared", { threadId: "thread-mock-1", turnId: null });
    await waitForGoalRow(r, "restored");
    await wireBarrier(r);
    assert.deepEqual(goalRows(r).map((payload) => payload.change), ["restored"], "never cleared");
    assert.deepEqual(goalRequests(r).map((request) => request.method), ["thread/goal/get", "thread/goal/set"]);
    await r.stop();
  });
});

describe("codex session — replies are read only where no notification follows (fix round 1)", () => {
  it("a stale update trailing the pause's reply makes no `resumed` flicker", async () => {
    // Notifications can trail replies: a progress flush queued before the
    // pause goes out after its reply, still saying `active`.
    const r = rig(
      { goal: STORED_GOAL, staleGoalUpdateAfterSet: true, turns: [{ kind: "silent" }] },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    const { turnId } = await r.session.sendTurn({
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.started");
    await r.session.interruptTurn(turnId, { pauseGoal: true });
    // The resume's snapshot, then the trailing pair — the stale `active` and
    // the set's own `paused` — all read before anything is asserted.
    await waitUntil(() => readGoalUpdates(r) >= 3, "the trailing goal updates");
    await wireBarrier(r);
    assert.deepEqual(
      goalRows(r).map((payload) => payload.change),
      ["paused"]
    );
    await r.stop();
  });
});

describe("codex session — the host's conditional resume of a held goal (goals §5.7)", () => {
  it("resumes a goal Codex holds paused; any other is left alone — only the get, and no text", async () => {
    const paused = rig(
      { goal: { ...STORED_GOAL, status: "paused" }, turns: [{ kind: "silent" }] },
      { resumeCursor: { threadId: "prior-thread" }, knownGoal: knownGoal({ status: "paused" }) }
    );
    await paused.session.start();
    assert.deepEqual(await paused.session.goalCommand({ kind: "resume" }, { onlyIfPaused: true }), {
      summary: ""
    });
    await waitForGoalRow(paused, "resumed");
    assert.deepEqual(
      goalRequests(paused).map((request) => request.method),
      ["thread/goal/get", "thread/goal/set"]
    );
    await paused.stop();

    // Going already, at its budget (which no resume moves), met, or gone: a
    // user's `/goal resume` would answer or re-activate some of these; the
    // host's own resume leaves every one as it is, and says nothing.
    const others: [string, { objective: string; status: string } | null, Partial<CodexSessionOptions>][] = [
      ["active", STORED_GOAL, RESUMED_WITH_GOAL],
      [
        "budget-limited",
        { ...STORED_GOAL, status: "budgetLimited" },
        { resumeCursor: { threadId: "prior-thread" }, knownGoal: knownGoal({ status: "budget-limited" }) }
      ],
      [
        "complete",
        { ...STORED_GOAL, status: "complete" },
        { resumeCursor: { threadId: "prior-thread" }, knownGoal: knownGoal({ status: "complete" }) }
      ],
      ["none", null, {}]
    ];
    for (const [label, goal, options] of others) {
      const r = rig({ goal, turns: [{ kind: "silent" }] }, options);
      await r.session.start();
      assert.deepEqual(
        await r.session.goalCommand({ kind: "resume" }, { onlyIfPaused: true }),
        { summary: "", notPaused: true },
        label
      );
      assert.deepEqual(
        goalRequests(r).map((request) => request.method),
        ["thread/goal/get"],
        `${label}: never a set`
      );
      await r.stop();
    }
  });

  it("decides on Codex's reply, not on a stale update the get let through first: a held goal is still resumed", async () => {
    // The hold's pause is answered, its notifications still queued behind a
    // progress flush that says `active`. The release's `get` meets that flush
    // first — the tracker reads `active` — while the reply carries `paused`.
    const r = rig(
      { goal: STORED_GOAL, setUpdatesStraddleNextGet: true, turns: [{ kind: "silent" }] },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "pause" }), { summary: "" });
    assert.deepEqual(await r.session.goalCommand({ kind: "resume" }, { onlyIfPaused: true }), {
      summary: ""
    });
    assert.deepEqual(
      goalRequests(r).map((request) => [request.method, request.params.status]),
      [
        ["thread/goal/set", "paused"],
        ["thread/goal/get", undefined],
        ["thread/goal/set", "active"]
      ]
    );
    await r.stop();
  });
});

describe("codex session — one deadline per /goal command (fix round 1)", () => {
  it("a slow goal store fails the whole command at ONE deadline, and starts nothing after it", async (t) => {
    const r = rig(
      { goal: STORED_GOAL, goalReplyDelayMs: 150, turns: [{ kind: "silent" }] },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const outcome = assert.rejects(
      r.session.goalCommand({ kind: "set", objective: "Ship the release" }),
      /\/goal set timed out after 10000ms/
    );
    await r.waitForSent("thread/goal/get");
    t.mock.timers.tick(7_000);
    await r.waitForSent("thread/goal/clear");
    t.mock.timers.tick(3_000);
    await outcome;
    await wireBarrier(r);
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 0, "no set starts after the deadline");
    assert.equal(r.session.isLive, true);
    await r.stop();
  });
});

describe("codex session — a model picked with /goal reaches the goal's turns (final fix wave)", () => {
  const LUNA = { model: "gpt-5.6-luna", options: [{ id: "effort", value: "high" }] };

  it("thread/settings/update goes out BEFORE the goal request, and the session keeps the new model", async () => {
    // Codex starts the goal's turns itself, on the thread's own settings: the
    // next turn the user sends would be too late.
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.session.goalCommand(
      { kind: "set", objective: "Make the build green" },
      { modelSelection: LUNA }
    );
    const sent = r
      .received()
      .filter((frame) => frame.method === "thread/settings/update" || frame.method?.startsWith("thread/goal/"))
      .map((frame) => frame.method);
    assert.deepEqual(sent, ["thread/settings/update", "thread/goal/get", "thread/goal/set"]);
    assert.deepEqual(sentFrames(r.received(), "thread/settings/update"), [
      { threadId: "thread-mock-1", model: "gpt-5.6-luna", effort: "high" }
    ]);
    assert.equal(r.session.summary().model, "gpt-5.6-luna");
    await r.stop();
  });

  it("the goal's next turn — one Codex starts — reports the new model", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.session.goalCommand({ kind: "status" }, { modelSelection: LUNA });
    await r.notify("turn/started", {
      threadId: "thread-mock-1",
      turn: {
        id: "goal-turn-1",
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
        startedAt: 0,
        completedAt: null,
        durationMs: null
      }
    });
    const started = await r.events.waitForType("turn.started");
    assert.deepEqual(started.payload, { model: "gpt-5.6-luna", effort: "high" });
    await r.stop();
  });

  it("the model the session already runs sends nothing", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.session.goalCommand({ kind: "status" }, { modelSelection: { model: "gpt-5.5" } });
    assert.equal(sentFrames(r.received(), "thread/settings/update").length, 0);
    await r.stop();
  });

  it("a refused settings update is logged and the goal command still runs", async () => {
    const r = rig({
      settingsError: { code: -32600, message: "unknown model gpt-5.6-luna" },
      turns: [{ kind: "silent" }]
    });
    await r.session.start();
    assert.deepEqual(
      await r.session.goalCommand(
        { kind: "set", objective: "Make the build green" },
        { modelSelection: LUNA }
      ),
      { summary: "" }
    );
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 1, "the goal was still set");
    assert.equal(r.session.summary().model, "gpt-5.5", "the session keeps the model it has");
    assert.ok(
      r.logs.some((log) => log.level === "warn" && /model/i.test(log.message)),
      "the failure is logged"
    );
    await r.stop();
  });
});

describe("codex session — a pause never waits for the goal to settle (final fix wave)", () => {
  it("answers at once while a resume snapshot is still outstanding", async (t) => {
    // Pausing is idempotent, and a Stop's pause must not stall past the
    // host's own 1.5 s bound behind a snapshot that may never come.
    const r = rig(
      { goal: STORED_GOAL, noResumeGoalSnapshot: true, turns: [{ kind: "silent" }] },
      RESUMED_WITH_GOAL
    );
    await r.session.start();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    let result: { summary: string } | undefined;
    const paused = r.session.goalCommand({ kind: "pause" }).then((value) => { result = value; });
    await wireBarrier(r);
    assert.equal(sentFrames(r.received(), "thread/goal/set").length, 1, "pause bypasses the pending snapshot");
    await paused;
    assert.deepEqual(result, { summary: "" });
    assert.deepEqual(sentFrames(r.received(), "thread/goal/set"), [
      { threadId: "thread-mock-1", status: "paused" }
    ]);
    await r.stop();
  });
});

describe("codex session — a \"no goal\" answer reconciles a drifted fold (micro-fix)", () => {
  /**
   * The tracker holds a goal the provider no longer has: a notification this
   * session saw, while the mock's goal store has none.
   */
  async function drifted(): Promise<Rig> {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.notify("thread/goal/updated", {
      threadId: "thread-mock-1",
      turnId: null,
      goal: {
        threadId: "thread-mock-1",
        objective: "Make the build green",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1_789_950_000,
        updatedAt: 1_789_950_000
      }
    });
    await waitForGoalRow(r, "set");
    return r;
  }

  const cases: [string, Parameters<CodexSession["goalCommand"]>[0], string][] = [
    ["pause", { kind: "pause" }, "No goal is set."],
    ["resume", { kind: "resume" }, "No goal is set."],
    ["edit", { kind: "edit", objective: "Ship it" }, "No goal is set. Use /goal <objective> to set one."],
    ["clear", { kind: "clear" }, "No goal is set."]
  ];
  for (const [name, command, summary] of cases) {
    it(`${name} with no goal on the provider clears the goal the fold still shows`, async () => {
      const r = await drifted();
      assert.deepEqual(await r.session.goalCommand(command), { summary });
      const row = await waitForGoalRow(r, "cleared");
      assert.deepEqual(row.payload, { goal: null, change: "cleared", previous: knownGoal() });
      // Reconciled once: the next answer has nothing left to clear.
      await r.session.goalCommand({ kind: "status" });
      await wireBarrier(r);
      assert.deepEqual(
        goalRows(r).map((payload) => payload.change),
        ["set", "cleared"]
      );
      await r.stop();
    });
  }
});

describe("codex session — a typed /goal pause on a goal at its budget (micro-fix)", () => {
  it("says it already stopped there, and sends nothing", async () => {
    // Codex would keep it budget-limited, and the unchanged update is no row.
    const r = rig(
      { goal: { ...STORED_GOAL, status: "budgetLimited" }, turns: [{ kind: "silent" }] },
      {
        resumeCursor: { threadId: "prior-thread" },
        knownGoal: knownGoal({ status: "budget-limited" })
      }
    );
    await r.session.start();
    assert.deepEqual(await r.session.goalCommand({ kind: "pause" }), {
      summary: "This goal already stopped at its token budget."
    });
    assert.deepEqual(goalRequests(r), []);
    await r.stop();
  });
});
