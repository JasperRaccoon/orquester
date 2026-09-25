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
import { after, describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { resumeCursorFor } from "../../orchestration/resume.ts";
import type { CodexProtocol } from "./_generated/index.ts";
import { AsyncEventQueue } from "./event-queue.ts";
import { CodexSession, fileChangeDetail, type CodexSessionOptions } from "./session.ts";
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
  stop(): Promise<void>;
  closed: () => boolean;
}

function rig(
  mock: Omit<MockConfig, "logPath"> & { bin?: string },
  overrides: Partial<CodexSessionOptions> = {}
): Rig {
  const server =
    mock.bin !== undefined
      ? { bin: mock.bin, dir: null as string | null, received: () => [] }
      : writeMockCodexServer(mock);
  if (server.dir !== null && server.dir !== undefined) {
    const dir = server.dir;
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  }

  const { context } = createFakeContext();
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
    stop,
    closed: () => closed
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
  it("handshakes, opens a thread and streams a text turn end to end", async () => {
    const r = rig({ turns: [{ kind: "text", text: "hello from the mock" }] });
    const summary = await r.session.start();
    assert.equal(summary.status, "ready");

    const { turnId } = await r.session.sendTurn({
      input: "say hello",
      attachments: [],
      interactionMode: "default"
    });
    assert.ok(turnId.length > 0);

    const completed = await r.events.waitForType("turn.completed");
    assert.equal((completed.payload as { state: string }).state, "completed");

    const deltas = r.events.events.filter((event) => event.type === "content.delta");
    assert.equal(
      deltas.map((event) => (event.payload as { delta: string }).delta).join(""),
      "hello from the mock"
    );

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

  it("sends the thread-level sandbox spelling on thread/start and the turn one on turn/start", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] }, { runtimeMode: "full-access" });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");

    const [start] = sentFrames(r.received(), "thread/start");
    assert.equal(start!.sandbox, "danger-full-access");
    assert.equal(start!.approvalPolicy, "never");
    const [turn] = sentFrames(r.received(), "turn/start");
    assert.deepEqual(turn!.sandboxPolicy, { type: "dangerFullAccess" });
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

  it("an attachment-only turn is the path block alone, and a path already in the text is not repeated", async () => {
    const r = rig({ turns: [{ kind: "text", text: "ok" }, { kind: "text", text: "ok" }] });
    await r.session.start();
    await r.session.sendTurn({
      input: "",
      attachments: [{ type: "file", id: "att-2", name: "a.txt", sizeBytes: 10 }],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.completed");
    const [first] = sentFrames(r.received(), "turn/start");
    assert.deepEqual(first!.input, [
      { type: "text", text: "Attached files:\n- a.txt: /attachments/thread-1/att-2", text_elements: [] }
    ]);
    await r.session.sendTurn({
      input: "see /attachments/thread-1/att-2",
      attachments: [{ type: "file", id: "att-2", name: "a.txt", sizeBytes: 10 }],
      interactionMode: "default"
    });
    // `waitForType` answers the first match, already seen or not, so the second
    // turn's completion is counted rather than awaited by type.
    await waitUntil(
      () => r.events.events.filter((event) => event.type === "turn.completed").length === 2,
      "two turns"
    );
    const [, second] = sentFrames(r.received(), "turn/start");
    assert.deepEqual(second!.input, [
      { type: "text", text: "see /attachments/thread-1/att-2", text_elements: [] }
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

    r.session.injectNotificationForTest("mcpServer/startupStatus/updated", {
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
  it("a second sendTurn during a live turn reuses the active turn id", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    const first = await r.session.sendTurn({
      input: "one",
      attachments: [],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.started");
    const second = await r.session.sendTurn({
      input: "actually, two",
      attachments: [],
      interactionMode: "default"
    });
    assert.equal(second.turnId, first.turnId, "steering is neither an error nor a second turn");
    assert.equal(sentFrames(r.received(), "turn/start").length, 2);
    assert.equal(
      r.events.events.filter((event) => event.type === "turn.started").length,
      1,
      "only one turn ever started"
    );
    await r.stop();
  });

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
      detail?: string;
      args?: { changes?: { path: string; diff: string }[] };
    };

    assert.ok(payload.detail !== undefined, "the card body must not be empty");
    assert.notEqual(payload.detail, "File change approval", "not its own type name");
    assert.match(payload.detail, /fixture\.txt/, "the PATH is in the body");
    assert.match(payload.detail, /\+1/, "and the size of the change");

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

  it("a file-change approval with no joinable item says so rather than inventing a path", async () => {
    assert.equal(
      fileChangeDetail([]),
      "Apply a file change (the provider sent no file list)."
    );
    assert.equal(fileChangeDetail([], "needs write access"), "needs write access");
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
    r.session.injectNotificationForTest("item/completed", {
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
    assert.match(String(payload.reason), /you were not asked/);
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
      r.events.events.some(
        (event) =>
          event.type === "runtime.warning" &&
          String((event.payload as { message: string }).message).includes("cannot render provider forms")
      ),
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
    assert.match(String((refusal.error as { message: string }).message), /could not be rendered/);
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
    assert.match(String(asked.requestId), /^codex-async:/);
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
      "settle, THEN interrupt — the server silently abandons unanswered requests"
    );
    await r.stop();
  });

  it("a stale turn id is a client-side no-op, never a -32600 on the wire", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    await r.session.interruptTurn("some-other-turn");
    assert.equal(
      sentFrames(r.received(), "turn/interrupt").length,
      0,
      "a Stop that races a settling turn must not kill the next one"
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

  it("interrupting when no turn is active does nothing at all", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    await r.session.interruptTurn();
    assert.equal(sentFrames(r.received(), "turn/interrupt").length, 0);
    await r.stop();
  });

  it("closes the abandoned in-progress item, so no tool row spins for ever", async () => {
    // Fixtures README obs. 5: the `commandExecution` that was `inProgress`
    // never gets an `item/completed` after an interrupt (R3 finding 1).
    const r = rig({ turns: [{ kind: "command-approval", command: "sleep 30" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "sleep", attachments: [], interactionMode: "default" });
    await r.events.waitForType("request.opened");
    await r.session.interruptTurn();
    await r.events.waitForType("turn.completed");

    const started = r.events.events.filter((event) => event.type === "item.started");
    const completed = r.events.events.filter((event) => event.type === "item.completed");
    for (const open of started) {
      assert.ok(
        completed.some((done) => done.itemId === open.itemId),
        `item ${String(open.itemId)} was left dangling inProgress`
      );
    }
    await r.stop();
  });

  it("emits exactly ONE user-input.resolved per parked question", async () => {
    // `settlePendingRequests` used to emit its own row AND let the handler
    // emit a second for the same requestId (Q1 finding 17).
    const r = rig({
      turns: [
        {
          kind: "user-input",
          questionId: "q",
          header: "H",
          question: "Q?",
          options: [{ label: "a", description: "b" }]
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "plan" });
    const asked = await r.events.waitForType("user-input.requested");
    await r.session.interruptTurn();
    await waitUntil(
      () => r.events.types().includes("user-input.resolved"),
      "user-input.resolved"
    );
    assert.equal(
      r.events.events.filter(
        (event) => event.type === "user-input.resolved" && event.requestId === asked.requestId
      ).length,
      1
    );
    await r.stop();
  });

  it("settles a pending user-input request too", async () => {
    const r = rig({
      turns: [
        {
          kind: "user-input",
          questionId: "q",
          header: "H",
          question: "Q?",
          options: [{ label: "a", description: "b" }]
        }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "plan" });
    await r.events.waitForType("user-input.requested");
    await r.session.interruptTurn();
    const resolved = await r.events.waitForType("user-input.resolved");
    assert.deepEqual((resolved.payload as { answers: unknown }).answers, {});
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
    await waitUntil(
      () => r.session.liveChildTurnsForTest.length === 1,
      "the child turn was registered"
    );
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
    assert.deepEqual(r.session.liveChildTurnsForTest, [["child-1", "child-1-turn"]]);
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

  it("a STALE turn-scoped Stop is still a no-op", async () => {
    const r = rig({ turns: [{ kind: "silent" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.started");
    await r.session.interruptTurn("a-turn-that-is-not-active");
    assert.equal(
      sentFrames(r.received(), "turn/interrupt").length,
      0,
      "a Stop racing a settling turn must not kill the next one"
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
    await waitUntil(() => r.session.liveChildTurnsForTest.length === 1, "the child's first turn");

    r.session.injectNotificationForTest("turn/completed", {
      threadId: "child-1",
      turn: childTurn("child-1-turn", "completed")
    });
    r.session.injectNotificationForTest("item/completed", {
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
    r.session.injectNotificationForTest("turn/started", {
      threadId: "child-1",
      turn: childTurn("child-1-turn-2", "inProgress")
    });
    const relaunch = await r.events.waitFor(
      (event) =>
        event.type === "task.started" && event.payload.toolUseId === "codex-run:child-1-turn-2",
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

  it("a child's command the user declined is the user's decline, never a policy deny", async () => {
    // Approvals of a child stay the parent's to answer, but the item they name
    // is the child's: the session must join the answer to the child's
    // namespaced call, or the decline reads as "you were not asked".
    const r = rig({ turns: [{ kind: "child-approval", childThreadId: "child-1", item: "command" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    assert.equal(opened.agentId, undefined, "the card is the parent's");
    r.session.respondToApproval(opened.requestId!, "decline");

    const ended = await r.events.waitFor(
      (event) => event.type === "item.completed" && event.agentId === "child-1",
      "the child's call ends"
    );
    assert.match(String(ended.itemId), /^codex-child:child-1:/);
    assert.equal((ended.payload as { status?: string }).status, "declined");
    await r.events.waitForType("turn.completed");
    assert.equal(
      r.events.types().includes("tool.denied"),
      false,
      "the USER declined this one; it is not a policy deny"
    );
    await r.stop();
  });

  it("a child's file-change card carries the child's path and diff", async () => {
    const r = rig({ turns: [{ kind: "child-approval", childThreadId: "child-1", item: "file-change" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const payload = opened.payload as {
      detail?: string;
      args?: { changes?: { path: string; diff: string }[] };
    };
    assert.match(String(payload.detail), /child\.txt/, "joined on the child's call, not a missing one");
    assert.deepEqual(
      payload.args?.changes?.map((change) => change.path),
      ["/tmp/child.txt"]
    );
    r.session.respondToApproval(opened.requestId!, "accept");
    await r.events.waitForType("turn.completed");
    await r.stop();
  });

  it("a child's item declined with no request behind it is a policy deny — owned by the child", async () => {
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    await r.events.waitForType("task.started");
    r.session.injectNotificationForTest("item/completed", {
      item: childCommand("policy-denied-1", "declined"),
      threadId: "child-1",
      turnId: "child-1-turn",
      completedAtMs: 1
    });
    const denied = await r.events.waitForType("tool.denied");
    const payload = denied.payload as { toolUseId?: string; agentId?: string; reason?: string };
    assert.equal(payload.toolUseId, "codex-child:child-1:policy-denied-1");
    assert.equal(payload.agentId, "child-1");
    assert.equal(denied.agentId, "child-1", "the deny is a row of the child's drill-in");
    assert.match(String(payload.reason), /you were not asked/);
    await r.stop();
  });

  it("a session-scoped Stop closes a child's running command, as the child's, before its task", async () => {
    const r = rig({ turns: [{ kind: "spawn-child", childThreadId: "child-1" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    await waitUntil(() => r.session.currentTurnId === null, "the parent turn settled");
    r.session.injectNotificationForTest("item/started", {
      item: childCommand("call_long", "inProgress"),
      threadId: "child-1",
      turnId: "child-1-turn",
      startedAtMs: 0
    });
    await r.events.waitFor(
      (event) => event.type === "item.started" && event.itemId === "codex-child:child-1:call_long",
      "the child's call is a row"
    );

    await r.session.interruptTurn();

    const closed = await r.events.waitFor(
      (event) => event.type === "item.completed" && event.itemId === "codex-child:child-1:call_long",
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

  it("a child's QUESTION rows ride no turn — the parent's turn end cannot strand them — and the answer reaches the child", async () => {
    // Unlike an approval, a question IS settled by its turn: the host dismisses
    // every native-callback question of a turn when that turn ends (§6.2). On
    // the parent's turn, a parent whose `wait` returned swept the child's card
    // away while the child still waited for its answer.
    const r = rig({
      turns: [
        { kind: "child-approval", childThreadId: "child-1", item: "question", parentSettles: "while-asking" }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const asked = await r.events.waitForType("user-input.requested");
    assert.equal(asked.turnId, undefined, "no turn: a turn's end sweeps that turn's questions");
    assert.equal(asked.agentId, undefined, "still the parent's card");
    assert.equal(asked.providerRefs?.providerTurnId, "child-1-turn", "the child's own turn stays the provider's ref");
    await r.events.waitForType("turn.completed");

    r.session.respondToUserInput(asked.requestId!, { branch: "main" });
    const resolved = await r.events.waitForType("user-input.resolved");
    assert.equal(resolved.turnId, undefined, "requested and resolved agree");
    await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended, answered"
    );
    const reply = r
      .received()
      .find((frame) => (frame.result as { answers?: unknown } | undefined)?.answers !== undefined);
    assert.deepEqual(
      (reply?.result as { answers: unknown }).answers,
      { branch: { answers: ["main"] } },
      "the user's answer reached the child"
    );
    await r.stop();
  });

  it("a child's request bookkeeping ends with the child's own turn, its thread's close, or a Stop", async () => {
    // The parent settles FIRST, so only the child's own turn end can clear
    // what the child's card left behind (an accepted call keeps its entry).
    const r = rig({
      turns: [
        { kind: "child-approval", childThreadId: "child-1", item: "command", parentSettles: "before-asking" }
      ]
    });
    await r.session.start();
    await r.session.sendTurn({ input: "spawn", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    assert.equal(r.session.childRequestEntriesForTest, 1, "the child's asked item");
    r.session.respondToApproval(opened.requestId!, "accept");
    await r.events.waitFor(
      (event) => event.type === "task.updated" && event.payload.taskId === "child-1",
      "the child's turn ended"
    );
    assert.equal(r.session.childRequestEntriesForTest, 0, "gone with the child's own turn");

    // A child's file change is remembered for its card; its thread closing,
    // and a Stop, forget it.
    const fileChange = (id: string): CodexProtocol.v2.ThreadItem => ({
      type: "fileChange",
      id,
      changes: [{ path: "/tmp/later.txt", kind: { type: "add" }, diff: "+later\n" }],
      status: "inProgress"
    });
    r.session.injectNotificationForTest("turn/started", {
      threadId: "child-1",
      turn: { id: "child-1-turn-2", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 0, completedAt: null, durationMs: null }
    });
    r.session.injectNotificationForTest("item/started", {
      item: fileChange("call_f1"),
      threadId: "child-1",
      turnId: "child-1-turn-2",
      startedAtMs: 0
    });
    assert.equal(r.session.childRequestEntriesForTest, 1);
    r.session.injectNotificationForTest("thread/closed", { threadId: "child-1" });
    assert.equal(r.session.childRequestEntriesForTest, 0, "gone with the child's thread");

    r.session.injectNotificationForTest("item/started", {
      item: fileChange("call_f2"),
      threadId: "child-2",
      turnId: "child-2-turn",
      startedAtMs: 0
    });
    assert.equal(r.session.childRequestEntriesForTest, 1);
    await r.session.interruptTurn();
    assert.equal(r.session.childRequestEntriesForTest, 0, "gone with a Stop");
    await r.stop();
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
 * wrote before it is in the log.
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
      await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      assert.equal(r.session.childRequestEntriesForTest, 0, "the child's bookkeeping went with its turn");

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

    await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
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

      await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
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
    await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
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

      await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
      await wireBarrier(r);
      assert.deepEqual(
        r.session.liveChildTurnsForTest,
        [["child-1", "child-1-turn"]],
        "the child's turn never ended: the resolution alone settled the card"
      );
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
    answered.session.injectNotificationForTest("turn/completed", {
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
    ended.session.injectNotificationForTest("turn/completed", {
      threadId: "child-1",
      turn: turnOf("child-1-turn", "interrupted")
    });
    ended.session.respondToApproval(second.requestId!, "accept");
    await waitUntil(() => ended.session.openServerRequestsForTest === 0, "the request's handler finished");
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
    r.session.injectNotificationForTest("turn/started", {
      threadId: "child-2",
      turn: turnOf("child-2-turn", "inProgress")
    });
    r.session.injectNotificationForTest("turn/completed", {
      threadId: "child-2",
      turn: turnOf("child-2-turn", "interrupted")
    });
    r.session.injectNotificationForTest("thread/closed", { threadId: "child-2" });
    await wireBarrier(r);
    assert.equal(resolutionsOf(r, opened.requestId).length, 0);
    assert.equal(r.session.openServerRequestsForTest, 1, "child-1's card is still parked");

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
    r.session.injectNotificationForTest("item/completed", {
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
    r.session.injectNotificationForTest("turn/started", {
      threadId: "child-9",
      turn: turnOf("child-9-turn", "inProgress")
    });
    r.session.injectNotificationForTest("turn/completed", {
      threadId: "child-9",
      turn: turnOf("child-9-turn", "interrupted")
    });
    r.session.injectNotificationForTest("thread/closed", { threadId: "child-9" });
    // …and a resolution naming a request that is not this card.
    r.session.injectNotificationForTest("serverRequest/resolved", {
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
    assert.equal(r.session.openServerRequestsForTest, 1, "the parent's card is still parked for the user");

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

  it("the parent's own turn end alone settles nothing in the adapter: its card stays parked until a Stop answers it", async () => {
    const r = rig({ turns: [{ kind: "command-approval", command: "ls -1" }] });
    await r.session.start();
    const turn = await r.session.sendTurn({ input: "ls", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");
    const parentThreadId = (r.session.summary().resumeCursor as { threadId: string }).threadId;
    r.session.injectNotificationForTest("turn/completed", {
      threadId: parentThreadId,
      turn: turnOf(turn.turnId, "interrupted")
    });
    await wireBarrier(r);
    assert.equal(
      r.events.types().includes("request.resolved"),
      false,
      "the adapter settles nothing at its own turn's end"
    );
    assert.equal(r.session.openServerRequestsForTest, 1);

    await r.session.interruptTurn();
    const resolved = await r.events.waitForType("request.resolved");
    assert.deepEqual(resolved.payload, { requestType: "command_execution_approval", decision: "cancel" });
    await wireBarrier(r);
    assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), [{ decision: "cancel" }]);
    await r.stop();
  });
});

describe("codex session — the parent's own card the server resolved itself (sweep, follow-ups 2026-09-25)", () => {
  // A `serverRequest/resolved` naming a card still parked cannot be the ack
  // of our own answer: every path that answers takes the card out before it
  // writes. Left parked, the card paused the session's watchdog for every
  // later turn, held one of the 32 in-flight slots, and a later Stop answered
  // a request the server had dropped and wrote a second row for it.
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

      await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
      assert.equal(r.session.currentTurnId, turn.turnId, "the turn runs on");
      assert.equal(r.session.livenessArmedForTest, true, "no card left to pause the watchdog");

      // A later Stop writes nothing more for it, and never answers it.
      await r.session.interruptTurn(turn.turnId);
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1);
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      await r.stop();
    });

    it(`a parent ${item} card resolved after its turn ended is cancelled once, and the next turn's watchdog arms`, async () => {
      const r = rig({ turns: [ask(["turn-interrupted", "resolved"]), { kind: "silent" }] });
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
      assert.equal((resolved.payload as { withdrawn?: boolean }).withdrawn, true);
      assert.equal(resolved.turnId, turn.turnId, "the card's own turn, ended as it was");
      await waitUntil(() => r.session.openServerRequestsForTest === 0, "the request's handler finished");
      assert.equal(r.session.currentTurnId, null);

      // The next turn is watched again: no stale card pauses it.
      const next = await r.session.sendTurn({ input: "again", attachments: [], interactionMode: "plan" });
      assert.equal(r.session.currentTurnId, next.turnId);
      assert.equal(r.session.livenessArmedForTest, true);

      await r.session.interruptTurn();
      await wireBarrier(r);
      assert.equal(resolutionsOf(r, opened.requestId).length, 1, "a later Stop writes nothing more");
      assert.deepEqual(answersTo(r, opened.providerRefs?.providerRequestId), []);
      await r.stop();
    });
  }
});

describe("codex session — the liveness watchdog really pauses (Q1 finding 16)", () => {
  it("answering a card that outlived the window does not kill the turn", async () => {
    // The window is shrunk and the card is held open well past it. Before the
    // fix, `remaining` collapsed to its 50 ms floor on re-arm and the watchdog
    // interrupted the turn the user had just approved.
    const r = rig(
      {
        turns: [
          {
            kind: "file-change-approval",
            path: "/tmp/a.txt",
            diff: "x\n",
            // Silent after the answer — but for LESS than one window, so a
            // correctly-reset clock never fires. Without the reset the re-arm
            // collapses to its 50 ms floor and fires inside this hold.
            holdAfterApprovalMs: 120
          }
        ]
      },
      { livenessWindows: { idleMs: 300, activeToolMs: 300 } }
    );
    await r.session.start();
    await r.session.sendTurn({ input: "write", attachments: [], interactionMode: "default" });
    const opened = await r.events.waitForType("request.opened");

    // The card sits open well past the window — "left open over lunch".
    await new Promise((resolve) => setTimeout(resolve, 500));
    r.session.respondToApproval(opened.requestId!, "accept");
    await r.events.waitForType("turn.completed");

    const killed = r.events.events.some(
      (event) =>
        event.type === "runtime.warning" &&
        String((event.payload as { message: string }).message).includes("No Codex activity")
    );
    assert.equal(killed, false, "a turn waiting on a human is not a stalled turn (§3.1)");
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

  it("fails every request still parked on the dead transport", async () => {
    const r = rig({ turns: [{ kind: "command-approval", command: "sleep 30" }] });
    await r.session.start();
    await r.session.sendTurn({ input: "x", attachments: [], interactionMode: "default" });
    await r.events.waitForType("request.opened");
    // Kill the child out from under the parked approval.
    await r.stop();
    await r.events.waitForType("request.resolved").catch(() => undefined);
    await waitUntil(
      () => r.events.types().includes("session.exited"),
      "session.exited after a host-initiated stop"
    );
    const resolved = r.events.events.filter((event) => event.type === "request.resolved");
    assert.ok(resolved.length > 0, "the parked approval is resolved, not left dangling");
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

  it("a child that never answers initialize is KILLED by the deadline, not left starting forever", async () => {
    // This is the one place the design deliberately departs from T3, whose
    // `initialize` is an unbounded await (§3.1). The production window is 30 s;
    // the override makes the same code path observable in milliseconds.
    const r = rig({ hangOnInitialize: true }, { deadlines: { handshakeMs: 150 } });
    const outcome = await r.session.start().then(
      () => new Error("start resolved, but the handshake never answered"),
      (error: unknown) => error
    );
    assert.match(String(outcome), /timed out after 150ms/);
    await waitUntil(() => r.events.types().includes("session.exited"), "session.exited");
    assert.equal(r.session.isLive, false, "the thread does not stay `starting` forever");
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
    // Both still name the thread, so a raw log stays greppable.
    assert.ok(first.startsWith("codex-thread-1-"));
    assert.ok(second.startsWith("codex-thread-1-"));
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
    const surfaced = r.events.events.find((event) =>
      String((event.payload as { message?: string }).message ?? "").includes("Could not resume")
    );
    assert.ok(surfaced !== undefined, "never a silent degrade");
    assert.equal(surfaced.type, "runtime.error", "not a tone-info warning");
    assert.equal((surfaced.payload as { class: string }).class, "provider_error");
    assert.match(
      String((surfaced.payload as { message: string }).message),
      /NEW, empty one/,
      "says plainly that this is not the old conversation"
    );
    await r.stop();
  });

  it("resumes from the host's MINIMAL create-time cursor (§6.1)", async () => {
    // The §6.1 path: a thread created from the resume picker carries only a
    // conversation id, and the host wraps it with `resumeCursorFor`. The
    // adapter must open that conversation, NOT a fresh thread — a silent
    // degrade here is a user opening what they believe is their old session.
    const conversationId = "01a0c19d-e1f9-7e73-8dc5-a0d355d3d232";
    const minimal = resumeCursorFor("codex", "thread-1", conversationId);
    const r = rig({ turns: [{ kind: "text", text: "a" }] }, { resumeCursor: minimal });
    await r.session.start();

    const [resume] = sentFrames(r.received(), "thread/resume");
    assert.ok(resume !== undefined, "the picker's conversation was resumed");
    assert.equal(resume.threadId, conversationId);
    assert.equal(
      sentFrames(r.received(), "thread/start").length,
      0,
      "a fresh thread would be the silent degrade §6.1 forbids"
    );
    await r.stop();
  });

  it("a malformed cursor means 'no resume', never an error", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] }, { resumeCursor: { threadId: 42 } });
    await r.session.start();
    assert.equal(sentFrames(r.received(), "thread/resume").length, 0);
    assert.equal(sentFrames(r.received(), "thread/start").length, 1);
    await r.stop();
  });

  it("the summary carries the resume cursor as {threadId}", async () => {
    const r = rig({ threadId: "codex-thread-9", turns: [{ kind: "text", text: "a" }] });
    const summary = await r.session.start();
    assert.deepEqual(summary.resumeCursor, { threadId: "codex-thread-9" });
    await r.stop();
  });
});

describe("codex session — compaction", () => {
  it("thread/compact/start runs as a whole extra turn and lands the compacted state", async () => {
    const r = rig({ turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    await r.session.compact();
    const compacted = await r.events.waitFor(
      (event) =>
        event.type === "thread.state.changed" &&
        (event.payload as { state: string }).state === "compacted",
      "thread.state.changed {compacted}"
    );
    assert.ok(compacted !== undefined);
    assert.ok(
      r.events.types().includes("turn.started"),
      "compaction lights up as a running turn"
    );
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

  it("readThread hydrates history out of band", async () => {
    const r = rig({ historyTurnIds: ["t2", "t1"], turns: [{ kind: "text", text: "a" }] });
    await r.session.start();
    const snapshot = await r.session.readThread();
    assert.deepEqual(
      snapshot.turns.map((turn) => turn.id),
      ["t1", "t2"]
    );
    assert.ok(snapshot.turns[0]!.items.length > 0, "items come from thread/turns/list");
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
    const server = writeMockCodexServer({ turns: [{ kind: "text", text: "a" }] });
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

    // Feed a stderr line naming both homes, the way a real codex error does.
    session.injectStderrForTest(
      `ERROR codex: cannot read ${accountHome}/auth.json (HOME=/var/lib/orquester)\n`
    );
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
  it("logs every frame in both directions to the raw sink", async () => {
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
