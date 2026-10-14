/**
 * Thread lineage — the host's fork (spec 2026-10-14 §6): the cut a message
 * names, the native path (a create-time resume of the provider's fork), the
 * transcript handoff (Grok, and any native refusal), and that the parent is
 * never touched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HISTORICAL_RAW_SOURCE,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadItem,
  type Turn
} from "@orquester/api/agent-chat";

import type { ForkConversationInput } from "../adapter.ts";
import { isAgentChatCommandError } from "./errors.ts";
import {
  buildForkTranscript,
  FORK_TRANSCRIPT_MAX_CHARS,
  ForkRefusal,
  resolveForkCut,
  stripForkHandoff,
  withForkHandoff
} from "./fork.ts";
import { createScriptedAdapter, createTestHost, type TestHost } from "./testing/index.ts";
import type { ScriptedAdapter } from "./testing/scripted-adapter.ts";

let seq = 0;
const cmd = (): string => `fork-${(seq += 1)}`;

const turn = (turnId: string, state: Turn["state"], userMessageId?: string): Turn => ({
  turnId,
  state,
  turnCount: null,
  requestedAt: "t",
  startedAt: "t",
  completedAt: state === "running" ? null : "t",
  assistantMessageId: null,
  ...(userMessageId !== undefined ? { userMessageId } : {})
});

const message = (
  id: string,
  role: "user" | "assistant" | "reasoning",
  turnId: string | null,
  text = id,
  extra: Partial<ThreadItem> = {}
): ThreadItem =>
  ({
    kind: "message",
    id,
    role,
    text,
    turnId,
    streaming: false,
    createdAt: "t",
    updatedAt: "t",
    ...extra
  }) as ThreadItem;

describe("resolveForkCut", () => {
  const state = {
    turns: [turn("t1", "completed", "u1"), turn("t2", "completed", "u2"), turn("t3", "completed", "u3")],
    items: [
      message("u1", "user", "t1"),
      message("a1", "assistant", "t1"),
      message("u2", "user", "t2"),
      message("a2", "assistant", "t2"),
      message("u3", "user", "t3"),
      message("a3", "assistant", "t3")
    ]
  };

  it("keeps every turn through an assistant message's own", () => {
    const cut = resolveForkCut(state, { messageId: "a2" });
    assert.deepEqual(cut.retained.map((t) => t.turnId), ["t1", "t2"]);
    assert.equal(cut.firstRemovedTurnId, "t3");
    assert.deepEqual(cut.forkedFrom, { messageId: "a2", turnId: "t2" });
  });

  it("keeps every turn before a user message's own", () => {
    const cut = resolveForkCut(state, { messageId: "u2" });
    assert.deepEqual(cut.retained.map((t) => t.turnId), ["t1"]);
    assert.equal(cut.firstRemovedTurnId, "t2");
  });

  it("keeps nothing before the first prompt", () => {
    const cut = resolveForkCut(state, { messageId: "u1" });
    assert.deepEqual(cut.retained, []);
    assert.equal(cut.firstRemovedTurnId, "t1");
  });

  it("keeps the whole conversation from its last reply", () => {
    const cut = resolveForkCut(state, { messageId: "a3" });
    assert.equal(cut.retained.length, 3);
    assert.equal(cut.firstRemovedTurnId, null);
  });

  it("without a message, keeps through the latest SETTLED turn", () => {
    const running = { ...state, turns: [...state.turns.slice(0, 2), turn("t3", "running", "u3")] };
    const cut = resolveForkCut(running, {});
    assert.deepEqual(cut.retained.map((t) => t.turnId), ["t1", "t2"]);
    assert.equal(cut.firstRemovedTurnId, "t3");
    assert.equal(cut.forkedFrom, undefined);
  });

  it("refuses a reply whose turn is still running", () => {
    const running = { ...state, turns: [...state.turns.slice(0, 2), turn("t3", "running", "u3")] };
    assert.throws(() => resolveForkCut(running, { messageId: "a3" }), ForkRefusal);
    // …but forking BEFORE the running turn's prompt is fine.
    assert.equal(resolveForkCut(running, { messageId: "u3" }).retained.length, 2);
  });

  it("refuses reasoning, a subagent's words and an unanswered prompt", () => {
    const odd = {
      turns: state.turns,
      items: [
        ...state.items,
        message("r1", "reasoning", "t1"),
        message("s1", "assistant", "t1", "sub", { agentId: "agent-1" } as Partial<ThreadItem>),
        message("u4", "user", null)
      ]
    };
    assert.throws(() => resolveForkCut(odd, { messageId: "r1" }), /reasoning/);
    assert.throws(() => resolveForkCut(odd, { messageId: "s1" }), /subagent/);
    assert.throws(() => resolveForkCut(odd, { messageId: "u4" }), /not been answered/);
  });

  it("cuts by turn alone when no message is named", () => {
    const withReply = { ...state, turns: state.turns.map((t) => ({ ...t, assistantMessageId: `a${t.turnId!.slice(1)}` })) };
    const through = resolveForkCut(withReply, { turnId: "t2" });
    assert.deepEqual(through.retained.map((t) => t.turnId), ["t1", "t2"]);
    assert.deepEqual(through.forkedFrom, { messageId: "a2", turnId: "t2" });
    assert.deepEqual(resolveForkCut(withReply, { turnId: "t2", role: "user" }).retained.map((t) => t.turnId), ["t1"]);
    assert.throws(() => resolveForkCut(withReply, { turnId: "t9" }), /not part of this conversation/);
  });

  it("takes the client's turn and role only for a message the window lost", () => {
    const cut = resolveForkCut(state, { messageId: "gone", turnId: "t1", role: "assistant" });
    assert.deepEqual(cut.retained.map((t) => t.turnId), ["t1"]);
    assert.throws(() => resolveForkCut(state, { messageId: "gone" }), /loaded history/);
    assert.throws(
      () => resolveForkCut(state, { messageId: "gone", turnId: "nope", role: "assistant" }),
      /not part of this conversation/
    );
  });
});

describe("the transcript handoff", () => {
  it("carries the kept turns' prompts and replies, nothing else", () => {
    const transcript = buildForkTranscript({
      items: [
        message("u1", "user", "t1", "first question"),
        message("r1", "reasoning", "t1", "thinking"),
        message("a1", "assistant", "t1", "first answer"),
        message("s1", "assistant", "t1", "subagent", { agentId: "x" } as Partial<ThreadItem>),
        message("u2", "user", "t2", "second question"),
        message("a2", "assistant", "t2", "second answer")
      ],
      retained: [turn("t1", "completed", "u1") as never],
      parentTitle: "Parent"
    });
    assert.ok(transcript);
    assert.match(transcript, /^<forked-conversation>/);
    assert.match(transcript, /fork of "Parent"/);
    assert.match(transcript, /\[User\]\nfirst question/);
    assert.match(transcript, /\[Assistant\]\nfirst answer/);
    assert.doesNotMatch(transcript, /thinking|subagent|second/);
  });

  it("keeps the newest messages within its budget and says how many it left out", () => {
    const big = "x".repeat(7_000);
    const items: ThreadItem[] = [];
    const turns: Turn[] = [];
    for (let i = 0; i < 40; i += 1) {
      turns.push(turn(`t${i}`, "completed", `u${i}`));
      items.push(message(`u${i}`, "user", `t${i}`, `q${i} ${big}`));
    }
    const transcript = buildForkTranscript({ items, retained: turns as never, parentTitle: "P" })!;
    assert.ok(transcript.length <= FORK_TRANSCRIPT_MAX_CHARS + 1_000);
    assert.match(transcript, /q39 /);
    assert.doesNotMatch(transcript, /q0 /);
    assert.match(transcript, /oldest messages were left out/);
  });

  it("is null when the kept turns hold no message", () => {
    assert.equal(
      buildForkTranscript({ items: [], retained: [turn("t1", "completed") as never], parentTitle: "P" }),
      null
    );
  });

  it("rides in front of the first ordinary message, never a /command, and strips back off", () => {
    const transcript = "<forked-conversation>\nctx\n</forked-conversation>";
    assert.equal(withForkHandoff("/context", transcript), null);
    const sent = withForkHandoff("go on", transcript)!;
    assert.equal(sent, `${transcript}\n\ngo on`);
    assert.equal(stripForkHandoff(sent), "go on");
    assert.equal(stripForkHandoff("plain"), "plain");
  });
});

// ---------------------------------------------------------------------------
// Through the orchestrator
// ---------------------------------------------------------------------------

function domainEvent(threadId: string, host: TestHost, type: string, payload: unknown): DomainEvent {
  return {
    eventId: `ev-${cmd()}`,
    threadId,
    type,
    payload,
    occurredAt: host.clock.nowIso(),
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as unknown as DomainEvent;
}

/** One finished turn: the prompt through the real `/turn`, the reply and the settle from the "provider". */
async function runTurn(
  host: TestHost,
  adapter: ScriptedAdapter,
  threadId: string,
  input: string,
  reply: string
): Promise<{ turnId: string; replyId: string }> {
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input });
  await host.settle();
  const turnId = adapter.turnIds.at(-1)!;
  const replyId = `reply-${turnId}`;
  await host.orchestrator.ingestionSink(threadId, [
    domainEvent(threadId, host, "thread.message-sent", {
      messageId: replyId,
      role: "assistant",
      text: reply,
      streaming: false,
      turnId
    }),
    domainEvent(threadId, host, "thread.session-set", {
      session: { status: "ready", activeTurnId: null }
    })
  ]);
  await host.settle();
  return { turnId, replyId };
}

function forkRequest(threadId: string, refId: string, fork: object) {
  return {
    threadId,
    projectPath: "/work/project",
    cwd: "/work/project",
    title: "Test thread (fork)",
    refId,
    accountId: "acc1",
    home: "account" as const,
    modelSelection: undefined,
    runtimeMode: undefined,
    fork
  };
}

async function snapshotOf(host: TestHost, threadId: string) {
  const read = await host.orchestrator.readThread(threadId);
  assert.equal(read.kind, "snapshot");
  return (read as Extract<typeof read, { kind: "snapshot" }>).thread;
}

function logOf(host: TestHost, threadId: string): DomainEvent[] {
  return host.store.logs.get(threadId) ?? [];
}

function activitiesOf(host: TestHost, threadId: string): ThreadActivityItem[] {
  return logOf(host, threadId)
    .filter(
      (event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
        event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);
}

/** A history replay of one turn, as `projectHistory` produces (§4.1). */
function replayOf(threadId: string): RuntimeEvent[] {
  const raw = { source: HISTORICAL_RAW_SOURCE, payload: null };
  const base = { threadId, createdAt: "1970-01-01T00:00:00.000Z", turnId: "turn-1", raw };
  return [
    { ...base, eventId: "h-start", type: "turn.started", payload: {} },
    {
      ...base,
      eventId: "h-user",
      itemId: "h-user",
      type: "item.completed",
      payload: { itemType: "user_message", status: "completed", title: "first", detail: "first" }
    },
    {
      ...base,
      eventId: "h-end",
      type: "turn.completed",
      payload: { state: "completed", tokenUsage: { usageStatus: "unavailable" } }
    }
  ] as unknown as RuntimeEvent[];
}

describe("forkThread", () => {
  it("native: forks through the message's turn and resumes the provider's fork in the child", async () => {
    const forks: ForkConversationInput[] = [];
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async (input) => {
        forks.push(input);
        return { resumeCursor: { threadId: input.threadId, resume: "forked-session" } };
      },
      history: { threadId: "child", turns: [{ id: "turn-1", items: [] }] },
      projectHistory: () => replayOf("child")
    });
    const host = createTestHost({ adapters: { claude } });
    const parentId = await host.createThread({ threadId: "parent" });
    const first = await runTurn(host, claude, parentId, "first", "one");
    await runTurn(host, claude, parentId, "second", "two");
    const parentLog = logOf(host, parentId).length;
    const parentCursor = (await snapshotOf(host, parentId)).head.session.resumeCursor;

    const result = await host.orchestrator.forkThread(
      parentId,
      forkRequest("child", "claude", { messageId: first.replyId })
    );
    await host.settle();

    assert.equal(result.strategy, "native");
    assert.deepEqual(result.lineage.forkedFrom, { messageId: first.replyId, turnId: first.turnId });
    assert.equal(result.head.lineage?.parentThreadId, parentId);
    assert.equal(result.head.modelSelection.model, "test-model", "the parent's model");
    assert.equal(forks.length, 1);
    assert.equal(forks[0]!.sourceThreadId, parentId);
    assert.deepEqual(forks[0]!.sourceResumeCursor, parentCursor);
    assert.deepEqual(forks[0]!.cut, { retainedTurnIds: [first.turnId], firstRemovedTurnId: "turn-2" });

    // The child resumes the fork at once and replays its history.
    const start = claude.calls.find((call) => call.kind === "startSession" && call.threadId === "child");
    assert.deepEqual((start?.detail as { resumeCursor?: unknown }).resumeCursor, {
      threadId: "child",
      resume: "forked-session"
    });
    assert.ok(
      host.ingestion.ingested.some(
        (event) =>
          event.threadId === "child" &&
          event.raw?.source === HISTORICAL_RAW_SOURCE &&
          event.type === "item.completed"
      ),
      "the fork's history is replayed into the child"
    );
    const child = await snapshotOf(host, "child");
    assert.equal(child.head.lineage?.relation, "fork");

    // The parent is untouched: no event, no new session start.
    assert.equal(logOf(host, parentId).length, parentLog);
    await host.stop();
  });

  it("transcript: an adapter without a fork gets the conversation with the child's first message", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const parentId = await host.createThread({ threadId: "parent", refId: "grok" });
    await runTurn(host, grok, parentId, "remember SWORDFISH", "noted");
    const second = await runTurn(host, grok, parentId, "and then?", "done");

    const result = await host.orchestrator.forkThread(
      parentId,
      forkRequest("child", "grok", { messageId: second.replyId })
    );
    await host.settle();
    assert.equal(result.strategy, "transcript");
    const note = activitiesOf(host, "child").find((row) => row.activityKind === "thread.forked");
    assert.ok(note, "the child says it was forked, and how");
    assert.match(JSON.stringify(note?.payload), /no fork of its own/);

    // A /command first: not prefixed, the transcript keeps waiting.
    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "/context" });
    await host.settle();
    assert.equal(grok.lastTurn?.input, "/context");

    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "continue" });
    await host.settle();
    const sent = grok.lastTurn?.input ?? "";
    assert.match(sent, /^<forked-conversation>/);
    assert.match(sent, /remember SWORDFISH/);
    assert.match(sent, /\n\ncontinue$/);
    // The timeline keeps what the user typed.
    const userTexts = (await snapshotOf(host, "child")).items
      .filter((item) => item.kind === "message" && item.role === "user")
      .map((item) => (item as { text: string }).text);
    assert.deepEqual(userTexts, ["/context", "continue"]);

    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "again" });
    await host.settle();
    assert.equal(grok.lastTurn?.input, "again", "handed over once");
    await host.stop();
  });

  it("falls back to the transcript when the native fork refuses, and says why", async () => {
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async () => {
        throw new Error("compacted after that turn");
      }
    });
    const host = createTestHost({ adapters: { claude } });
    const parentId = await host.createThread({ threadId: "parent" });
    const first = await runTurn(host, claude, parentId, "first", "one");
    const result = await host.orchestrator.forkThread(
      parentId,
      forkRequest("child", "claude", { messageId: first.replyId })
    );
    await host.settle();
    assert.equal(result.strategy, "transcript");
    const note = activitiesOf(host, "child").find((row) => row.activityKind === "thread.forked");
    assert.match(JSON.stringify(note?.payload), /compacted after that turn/);
    assert.equal(
      claude.calls.some((call) => call.kind === "startSession" && call.threadId === "child"),
      false,
      "nothing to resume: the child starts fresh on its first message"
    );
    await host.stop();
  });

  it("forks before the first prompt as an empty child, without asking the provider", async () => {
    const calls: unknown[] = [];
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async (input) => {
        calls.push(input);
        return { resumeCursor: {} };
      }
    });
    const host = createTestHost({ adapters: { claude } });
    const parentId = await host.createThread({ threadId: "parent" });
    await runTurn(host, claude, parentId, "first", "one");
    const prompt = (await snapshotOf(host, parentId)).items.find(
      (item) => item.kind === "message" && item.role === "user"
    )!;
    const result = await host.orchestrator.forkThread(
      parentId,
      forkRequest("child", "claude", { messageId: prompt.id })
    );
    assert.equal(result.strategy, "empty");
    assert.equal(calls.length, 0);
    assert.equal(result.head.lineage?.forkedFrom?.messageId, prompt.id);
    await host.stop();
  });

  it("refuses an unknown parent, another agent, a running reply and an existing child", async () => {
    const claude = createScriptedAdapter({ id: "claude" });
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { claude, grok } });
    const parentId = await host.createThread({ threadId: "parent" });
    await host.orchestrator.command(parentId, "turn", { commandId: cmd(), input: "long job" });
    await host.settle();
    const runningTurn = claude.turnIds.at(-1)!;
    await host.orchestrator.ingestionSink(parentId, [
      domainEvent(parentId, host, "thread.message-sent", {
        messageId: "partial",
        role: "assistant",
        text: "half",
        streaming: false,
        turnId: runningTurn
      })
    ]);
    await host.settle();

    const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
      try {
        await promise;
        return undefined;
      } catch (error) {
        return isAgentChatCommandError(error) ? error.code : String(error);
      }
    };
    assert.equal(
      await codeOf(host.orchestrator.forkThread("nope", forkRequest("c1", "claude", {}))),
      "THREAD_NOT_FOUND"
    );
    assert.equal(
      await codeOf(host.orchestrator.forkThread(parentId, forkRequest("c2", "grok", {}))),
      "INVALID_COMMAND"
    );
    assert.equal(
      await codeOf(
        host.orchestrator.forkThread(parentId, forkRequest("c3", "claude", { messageId: "partial" }))
      ),
      "COMMAND_REJECTED"
    );
    assert.equal(
      await codeOf(host.orchestrator.forkThread(parentId, forkRequest(parentId, "claude", {}))),
      "INVALID_COMMAND"
    );
    await host.stop();
  });
});
