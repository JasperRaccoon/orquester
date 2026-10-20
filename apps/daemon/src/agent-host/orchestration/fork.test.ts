/**
 * Thread lineage — the host's fork (spec 2026-10-14 §6): the cut a message
 * names, the native path (a create-time resume of the provider's fork), the
 * transcript handoff (Grok, and any native refusal), and that the parent is
 * never touched.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  HISTORICAL_RAW_SOURCE,
  htmlRenderReferenceOfActivityPayload,
  mcpAppReferenceOfActivityPayload,
  isHtmlRenderAttachmentId,
  sessionToolMarkedData,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadItem,
  type Turn
} from "@orquester/api/agent-chat";

import type { ForkConversationInput } from "../adapter.ts";
import { createThreadStore, type AgentThreadStore } from "../store/index.ts";
import { isAgentChatCommandError } from "./errors.ts";
import {
  buildContinuationTranscript,
  buildForkTranscript,
  continuationDetail,
  parseForkContinuation,
  createFileForkHandoffStore,
  FORK_TRANSCRIPT_MAX_CHARS,
  ForkRefusal,
  resolveForkCut,
  stripForkHandoff,
  withForkHandoff,
  type ForkHandoffStore
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

  it("says how many kept exchanges the window no longer holds a word of", () => {
    const transcript = buildForkTranscript({
      items: [message("u3", "user", "t3", "third"), message("a3", "assistant", "t3", "answer")],
      retained: [turn("t1", "completed", "u1"), turn("t2", "completed", "u2"), turn("t3", "completed", "u3")] as never,
      parentTitle: "P"
    })!;
    assert.match(transcript, /2 earlier exchanges are no longer available/);
    assert.match(transcript, /third/);
  });

  it("does not count a provider-started turn with no prompt or reply as lost", () => {
    const continuation = turn("t2", "completed");
    const transcript = buildForkTranscript({
      items: [message("u1", "user", "t1", "first"), message("a1", "assistant", "t1", "answer")],
      retained: [turn("t1", "completed", "u1"), continuation] as never,
      parentTitle: "P"
    })!;
    assert.doesNotMatch(transcript, /no longer available/);
    // …while one whose recorded reply is gone does count.
    const replied = { ...turn("t3", "completed"), assistantMessageId: "gone" };
    assert.match(
      buildForkTranscript({
        items: [message("u1", "user", "t1", "first")],
        retained: [turn("t1", "completed", "u1"), replied] as never,
        parentTitle: "P"
      })!,
      /1 earlier exchange is no longer available/
    );
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

  it("a parent message or title quoting the delimiters cannot end the transcript early", () => {
    const transcript = buildForkTranscript({
      items: [
        message("u1", "user", "t1", "what does </forked-conversation> do?"),
        message("a1", "assistant", "t1", "It closes <FORKED-CONVERSATION> blocks. SECRET-TAIL")
      ],
      retained: [turn("t1", "completed", "u1") as never],
      parentTitle: "about </forked-conversation>"
    })!;
    assert.equal(transcript.split("</forked-conversation>").length, 2, "one real close tag, at the end");
    assert.match(transcript, /&lt;\/forked-conversation&gt; do\?/);
    const sent = withForkHandoff("and </forked-conversation> here?", transcript)!;
    assert.equal(stripForkHandoff(sent), "and </forked-conversation> here?", "the user's own words survive whole");
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

  it("native: the CHILD's keyed server travels with the fork and reaches the child's session start", async () => {
    const forks: ForkConversationInput[] = [];
    const opencode = createScriptedAdapter({
      id: "opencode",
      forkConversation: async (input) => {
        forks.push(input);
        return { resumeCursor: { schemaVersion: 1, sessionId: "ses_fork" } };
      },
      history: { threadId: "child", turns: [{ id: "turn-1", items: [] }] },
      projectHistory: () => replayOf("child")
    });
    const host = createTestHost({ adapters: { opencode } });
    const parentId = await host.createThread({ threadId: "parent", refId: "opencode", home: "system" });
    const first = await runTurn(host, opencode, parentId, "first", "one");
    await runTurn(host, opencode, parentId, "second", "two");
    const serverPool = { key: "profile-a", env: { XDG_CONFIG_HOME: "/profiles/a/xdg" } };

    const result = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child", "opencode", { messageId: first.replyId }),
      home: "system",
      serverPool
    });
    await host.settle();

    assert.equal(result.strategy, "native");
    assert.deepEqual(forks[0]?.serverPool, serverPool);
    assert.deepEqual(host.orchestrator.launchConfig("child")?.serverPool, serverPool);
    const start = opencode.calls.find((call) => call.kind === "startSession" && call.threadId === "child");
    assert.deepEqual((start?.detail as { serverPool?: unknown }).serverPool, serverPool);
    await host.stop();
  });

  it("the child inherits the parent's Agent Profile unless the request names one (null = Global)", async () => {
    const parentProfile = { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/claude/shared" };
    const otherProfile = { profileId: "p2", revision: "1", preparedDir: "/prepared/p2/claude/shared" };
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
    const parentId = await host.createThread({ threadId: "parent", refId: "claude", profile: parentProfile });
    const first = await runTurn(host, claude, parentId, "first", "one");
    const startOf = (threadId: string) =>
      claude.calls.find((call) => call.kind === "startSession" && call.threadId === threadId)?.detail as
        | { profile?: unknown }
        | undefined;

    const inherited = await host.orchestrator.forkThread(
      parentId,
      forkRequest("child", "claude", { messageId: first.replyId })
    );
    await host.settle();
    assert.equal(inherited.head.profileId, "p1", "recorded on the child's thread.created");
    assert.deepEqual(forks[0]?.profile, parentProfile, "the native fork is made with the child's profile");
    assert.deepEqual(host.orchestrator.launchConfig("child")?.profile, parentProfile);
    assert.deepEqual(startOf("child")?.profile, parentProfile);

    const overridden = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child-2", "claude", { messageId: first.replyId }),
      profile: otherProfile
    });
    await host.settle();
    assert.equal(overridden.head.profileId, "p2");
    assert.deepEqual(forks[1]?.profile, otherProfile);
    assert.deepEqual(startOf("child-2")?.profile, otherProfile);

    const global = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child-3", "claude", { messageId: first.replyId }),
      profile: null
    });
    await host.settle();
    assert.equal(global.head.profileId, undefined);
    assert.equal("profile" in (forks[2] ?? {}), false);
    assert.equal("profile" in (host.orchestrator.launchConfig("child-3") ?? {}), false);
    assert.equal(startOf("child-3") !== undefined && "profile" in startOf("child-3")!, false);

    // The parent is only read: its profile is what it was.
    assert.deepEqual(host.orchestrator.launchConfig(parentId)?.profile, parentProfile);
    await host.stop();
  });

  it("a Global fork of a deleted profile's chat carries the daemon's fallback notice onto the child", async () => {
    const parentProfile = { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/claude/shared" };
    const claude = createScriptedAdapter({ id: "claude" });
    const host = createTestHost({ adapters: { claude } });
    const parentId = await host.createThread({ threadId: "parent", refId: "claude", profile: parentProfile });
    const first = await runTurn(host, claude, parentId, "first", "one");
    const notice = 'Agent Profile "Video" was deleted; this chat now uses Global.';
    const child = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child", "claude", { messageId: first.replyId }),
      profile: null,
      profileId: null,
      profileFallback: { previousProfileId: "p1", notice }
    });
    await host.settle();
    assert.equal(child.head.profileId, undefined, "Global");
    const row = activitiesOf(host, "child").find((activity) => activity.activityKind === "runtime.warning");
    assert.equal(row?.summary, notice);
    assert.deepEqual(
      { profileId: (row?.payload as Record<string, unknown>).profileId, previousProfileId: (row?.payload as Record<string, unknown>).previousProfileId },
      { profileId: null, previousProfileId: "p1" }
    );

    // A fallback beside a profile is not one: no notice.
    await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child-2", "claude", { messageId: first.replyId }),
      profileFallback: { previousProfileId: "p1", notice }
    });
    await host.settle();
    assert.equal(activitiesOf(host, "child-2").some((activity) => activity.activityKind === "runtime.warning"), false);
    await host.stop();
  });

  it("links the child to its parent's secrets before its first event, native or transcript — never more", async () => {
    const links: Array<{ threadId: string; parentThreadId: string; childEventsBefore: number }> = [];
    let host: TestHost | undefined;
    const secrets = {
      link: (threadId: string, parentThreadId: string) => {
        links.push({
          threadId,
          parentThreadId,
          childEventsBefore: host!.ingestion.ingested.filter((event) => event.threadId === threadId).length
        });
      },
      maskValue: (_threadId: string, value: unknown) => value
    };
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async (input) => ({ resumeCursor: { threadId: input.threadId, resume: "forked-session" } }),
      history: { threadId: "child", turns: [{ id: "turn-1", items: [] }] },
      projectHistory: () => replayOf("child")
    });
    const grok = createScriptedAdapter({ id: "grok" });
    host = createTestHost({ adapters: { claude, grok }, secrets }) as TestHost;
    const parentId = await host.createThread({ threadId: "parent" });
    const first = await runTurn(host, claude, parentId, "first", "one");
    await host.orchestrator.forkThread(parentId, forkRequest("child", "claude", { messageId: first.replyId }));
    await host.settle();
    assert.ok(
      host.ingestion.ingested.some((event) => event.threadId === "child" && event.raw?.source === HISTORICAL_RAW_SOURCE),
      "the replay came after the link"
    );
    const grokParent = await host.createThread({ threadId: "grok-parent", refId: "grok" });
    const said = await runTurn(host, grok, grokParent, "hello", "hi");
    await host.orchestrator.forkThread(grokParent, forkRequest("grok-child", "grok", { messageId: said.replyId }));
    await host.settle();
    assert.deepEqual(links, [
      { threadId: "child", parentThreadId: parentId, childEventsBefore: 0 },
      { threadId: "grok-child", parentThreadId: grokParent, childEventsBefore: 0 }
    ]);
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

  it("transcript: a first turn that fails keeps the handoff for the next message; one that succeeds does not", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const parentId = await host.createThread({ threadId: "parent", refId: "grok" });
    const said = await runTurn(host, grok, parentId, "remember SWORDFISH", "noted");
    await host.orchestrator.forkThread(parentId, forkRequest("child", "grok", { messageId: said.replyId }));
    await host.settle();

    const settle = async (status: "error" | "ready") => {
      await host.orchestrator.ingestionSink("child", [
        domainEvent("child", host, "thread.session-set", {
          session: { status, activeTurnId: null, ...(status === "error" ? { lastError: "provider error" } : {}) }
        })
      ]);
      await host.settle();
    };
    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "continue" });
    await host.settle();
    assert.match(grok.lastTurn?.input ?? "", /^<forked-conversation>[\s\S]*SWORDFISH[\s\S]*\n\ncontinue$/);
    await settle("error");
    const failed = (await snapshotOf(host, "child")).turns?.at(-1);
    assert.equal(failed?.state, "failed");

    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "retry" });
    await host.settle();
    assert.match(grok.lastTurn?.input ?? "", /^<forked-conversation>[\s\S]*SWORDFISH[\s\S]*\n\nretry$/, "carried again");
    await settle("ready");

    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "again" });
    await host.settle();
    assert.equal(grok.lastTurn?.input, "again", "delivered once it settled");
    await host.stop();
  });

  it("transcript: the handoff record lives with the child; a failed carrier and a rewind past a completed one re-arm it, with a newer build's fields", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-fork-handoff-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pathFor = (threadId: string) => join(root, threadId, "fork-handoff.json");
    const files = createFileForkHandoffStore(pathFor);
    let host: TestHost | undefined;
    let marks = 0;
    const store: ForkHandoffStore = {
      load: (threadId) => files.load(threadId),
      save: async (threadId, record) => {
        await files.save(threadId, record);
        // The reviewer's window: the delivery mark is written before the turn is adopted,
        // and an ingestion batch lands right there (a cold child's first message).
        if (record.deliveredTurnId !== undefined && (marks += 1) === 1) {
          await host!.orchestrator.ingestionSink(threadId, [
            domainEvent(threadId, host!, "thread.activity-appended", {
              activity: {
                id: "between",
                kind: "activity",
                tone: "info",
                activityKind: "runtime.warning",
                summary: "a frame between the send and the adoption",
                payload: null,
                turnId: null,
                createdAt: host!.clock.nowIso(),
                updatedAt: host!.clock.nowIso()
              }
            })
          ]);
        }
      }
    };
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async () => {
        throw new Error("compacted after that turn");
      }
    });
    host = createTestHost({ adapters: { claude }, forkHandoffs: store });
    const parentId = await host.createThread({ threadId: "parent" });
    const said = await runTurn(host, claude, parentId, "remember SWORDFISH", "noted");
    assert.equal(
      (await host.orchestrator.forkThread(parentId, forkRequest("child", "claude", { messageId: said.replyId }))).strategy,
      "transcript"
    );
    await host.settle();
    // A newer build's field on the record: every rewrite keeps it.
    const written = JSON.parse(await readFile(pathFor("child"), "utf8")) as Record<string, unknown>;
    await writeFile(pathFor("child"), JSON.stringify({ ...written, fromNewerBuild: { kept: true } }));
    const onDisk = async () => JSON.parse(await readFile(pathFor("child"), "utf8")) as Record<string, unknown>;

    // The first message carries it, a batch lands before the turn is adopted, and the turn fails.
    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "continue" });
    await host.settle();
    assert.equal(marks, 1);
    assert.match(claude.lastTurn?.input ?? "", /SWORDFISH/);
    const carrier = claude.turnIds.at(-1)!;
    assert.equal((await onDisk()).deliveredTurnId, carrier);
    assert.deepEqual((await onDisk()).fromNewerBuild, { kept: true }, "an unknown field survives the delivery mark");
    await host.orchestrator.ingestionSink("child", [
      domainEvent("child", host, "thread.session-set", { session: { status: "error", activeTurnId: null, lastError: "boom" } })
    ]);
    await host.settle();

    // The retry carries it again, and completes.
    await runTurn(host, claude, "child", "retry", "ok");
    assert.match(claude.lastTurn?.input ?? "", /^<forked-conversation>[\s\S]*SWORDFISH[\s\S]*\n\nretry$/, "the retry carries the transcript");
    await runTurn(host, claude, "child", "next", "ok");
    assert.equal(claude.lastTurn?.input, "next", "delivered once its carrier completed");
    const delivered = await onDisk();
    assert.equal(typeof delivered.deliveredTurnId, "string", "kept for the child's lifetime");
    assert.deepEqual(delivered.fromNewerBuild, { kept: true });

    // A rewind past the completed carrier: the provider no longer has the parent's conversation.
    await host.orchestrator.command("child", "revert", { commandId: cmd(), targetTurnCount: 0 });
    await host.settle();
    assert.ok(claude.calls.some((call) => call.kind === "rollbackThread"));
    const rearmed = await onDisk();
    assert.equal(rearmed.deliveredTurnId, undefined);
    assert.deepEqual(rearmed.fromNewerBuild, { kept: true }, "and survives the re-arm");
    await runTurn(host, claude, "child", "from the top", "ok");
    assert.match(claude.lastTurn?.input ?? "", /^<forked-conversation>[\s\S]*SWORDFISH[\s\S]*\n\nfrom the top$/);
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

  it("a repeat of the same fork answers the existing child; turns with no words left are `unavailable`", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const parentId = await host.createThread({ threadId: "parent", refId: "grok" });
    const first = await runTurn(host, grok, parentId, "q", "a");
    const fork = await host.orchestrator.forkThread(parentId, forkRequest("child", "grok", { messageId: first.replyId }));
    const repeat = await host.orchestrator.forkThread(parentId, forkRequest("child", "grok", { messageId: first.replyId }));
    assert.equal(repeat.strategy, fork.strategy);
    assert.equal(repeat.strategy, "transcript");
    assert.equal(logOf(host, "child").filter((event) => event.type === "thread.created").length, 1);

    // A settled turn with no words in the window (its messages long evicted, here never
    // written): the conversation cannot be carried — `unavailable`, never "before the first message".
    const wordless = await host.createThread({ threadId: "wordless", refId: "grok" });
    await host.orchestrator.ingestionSink(wordless, [
      domainEvent(wordless, host, "thread.turn-start-requested", {
        turnId: "old-turn",
        messageId: "evicted-prompt",
        interactionMode: "default",
        settled: { state: "completed", completedAt: host.clock.nowIso() }
      })
    ]);
    await host.settle();
    const lost = await host.orchestrator.forkThread(wordless, forkRequest("child-2", "grok", {}));
    await host.settle();
    assert.equal(lost.strategy, "unavailable");
    const row = activitiesOf(host, "child-2").find((activity) => activity.activityKind === "thread.forked");
    assert.match(JSON.stringify(row?.payload), /could not be carried over/);
    assert.doesNotMatch(JSON.stringify(row?.payload), /before the first message/);
    await host.stop();
  });

  it("a repeated fork answers the strategy the head recorded, after the window dropped its row and a restart", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-fork-strategy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = createThreadStore({ rootDir: join(root, "threads") });
    t.after(() => store.close());
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok }, store });
    const parentId = await host.createThread({ threadId: "parent", refId: "grok" });
    const said = await runTurn(host as unknown as TestHost, grok, parentId, "q", "a");
    const request = forkRequest("child", "grok", { messageId: said.replyId });
    assert.equal((await host.orchestrator.forkThread(parentId, request)).strategy, "transcript");
    await host.settle();

    // A long child: its `thread.forked` row leaves the fold's activity window.
    const rows = Array.from({ length: 600 }, (_, index) =>
      domainEvent("child", host as unknown as TestHost, "thread.activity-appended", {
        activity: {
          id: `row-${index}`,
          kind: "activity",
          tone: "info",
          activityKind: "runtime.warning",
          summary: `row ${index}`,
          payload: null,
          turnId: null,
          createdAt: host.clock.nowIso(),
          updatedAt: host.clock.nowIso()
        }
      })
    );
    await host.orchestrator.ingestionSink("child", rows);
    await host.settle();
    const child = await snapshotOf(host as unknown as TestHost, "child");
    assert.equal(
      child.items.some((item) => item.kind === "activity" && item.activityKind === "thread.forked"),
      false,
      "the row is out of the window"
    );
    assert.equal(child.head.forkStrategy, "transcript");
    assert.equal((await host.orchestrator.forkThread(parentId, request)).strategy, "transcript");
    await host.stop();

    const next = createTestHost({ adapters: { grok: createScriptedAdapter({ id: "grok" }) }, store });
    t.after(() => next.stop());
    assert.equal((await next.orchestrator.forkThread(parentId, { ...request, confirmOnly: true })).strategy, "transcript");
    assert.equal((await next.orchestrator.forkThread(parentId, request)).strategy, "transcript");
  });

  it("never hands back a deleted fork child for a repeated fork", async () => {
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok } });
    const parentId = await host.createThread({ threadId: "parent", refId: "grok" });
    const first = await runTurn(host, grok, parentId, "q", "a");
    await host.orchestrator.forkThread(parentId, forkRequest("child", "grok", { messageId: first.replyId }));
    await host.orchestrator.ingestionSink("child", [
      domainEvent("child", host, "thread.message-sent", { messageId: "c1", role: "user", text: "child's own words", streaming: false, turnId: null })
    ]);
    await host.settle();
    await host.orchestrator.deleteThread("child");
    // Gone: the id is free, and a repeat starts a NEW thread — the old log is not resurrected.
    const again = await host.orchestrator.forkThread(parentId, forkRequest("child", "grok", { messageId: first.replyId }));
    await host.settle();
    assert.equal(again.head.seq < 5, true);
    const created = logOf(host, "child").filter((event) => event.type === "thread.created");
    assert.equal(created.length, 1);
    assert.equal(
      logOf(host, "child").some((event) => event.type === "thread.message-sent" && JSON.stringify(event.payload).includes("child's own words")),
      false
    );
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
    // A continuation in another agent must name that agent's model.
    assert.equal(
      await codeOf(host.orchestrator.forkThread(parentId, { ...forkRequest("c4", "grok", {}), continuation: {} })),
      "INVALID_COMMAND"
    );
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// "Continue in another agent": a fork onto another adapter or account
// ---------------------------------------------------------------------------

describe("the continuation handoff", () => {
  const retained = [turn("t1", "completed", "u1"), turn("t2", "completed", "u2")] as Parameters<typeof buildContinuationTranscript>[0]["retained"];
  const items = [
    message("u1", "user", null, "first question"),
    message("a1", "assistant", "t1", "first answer"),
    message("r2", "reasoning", "t2", "secret thoughts"),
    message("u2", "user", null, "second question"),
    message("a2", "assistant", "t2", "second answer")
  ];

  it("budgets whole messages, names the source and the reader, and carries the working tree", () => {
    const built = buildContinuationTranscript({
      items,
      retained,
      parentThreadId: "parent-1",
      parentTitle: "Login bug",
      sourceLabel: "Claude Opus 4.1",
      targetLabel: "Codex",
      gitStatus: " M src/login.ts"
    })!;
    assert.deepEqual(built.summary, { carried: 4, total: 4, bytes: built.summary.bytes });
    assert.match(built.transcript, /^<forked-conversation>\n/);
    assert.match(built.transcript, /ran on Claude Opus 4\.1 \(Orquester session parent-1\)/);
    assert.match(built.transcript, /read_transcript/);
    assert.match(built.transcript, /\[Assistant \(Claude Opus 4\.1\)\]\nsecond answer/);
    assert.ok(!built.transcript.includes("secret thoughts"), "no reasoning");
    assert.match(built.transcript, /`git status --short` of the project:\n\n M src\/login\.ts\n<\/forked-conversation>$/);
    // The same delimiters as the same-agent transcript: a replayed prompt strips back to the user's words.
    assert.equal(stripForkHandoff(withForkHandoff("go on", built.transcript)!), "go on");
  });

  it("leaves the oldest out past the budget and says so", () => {
    const built = buildContinuationTranscript({
      items,
      retained,
      parentThreadId: "parent-1",
      parentTitle: "Login bug",
      sourceLabel: "Claude",
      targetLabel: "Codex",
      budgetBytes: 2 * (48 + 15)
    })!;
    assert.equal(built.summary.carried, 2);
    assert.equal(built.summary.total, 4);
    assert.match(built.transcript, /the last 2 of 4 messages/);
    assert.ok(!built.transcript.includes("first question"));
  });

  it("is null when the kept turns hold no message", () => {
    assert.equal(
      buildContinuationTranscript({ items: [], retained, parentThreadId: "p", parentTitle: "t", sourceLabel: "Claude", targetLabel: "Codex" }),
      null
    );
  });

  it("reads the request's continuation tolerantly, and words the child's row", () => {
    assert.equal(parseForkContinuation(undefined), undefined);
    assert.equal(parseForkContinuation("yes"), undefined);
    assert.deepEqual(parseForkContinuation({}), {});
    assert.deepEqual(parseForkContinuation({ gitStatus: 3 }), {});
    assert.deepEqual(parseForkContinuation({ gitStatus: "?? a" }), { gitStatus: "?? a" });
    assert.match(continuationDetail("transcript", { carried: 23, total: 41, bytes: 58 * 1024 }, "Codex"), /^The last 23 of 41 messages \(≈58 KB\) are handed to Codex with your first message/);
    assert.match(continuationDetail("transcript", { carried: 4, total: 4, bytes: 900 }, "Codex"), /^The whole conversation \(4 messages, ≈1 KB\)/);
    assert.match(continuationDetail("transcript", { carried: 1, total: 2, bytes: 60_000, clipped: true }, "Codex"), /^Only the end of the newest message/);
    assert.match(continuationDetail("empty", undefined, "Codex"), /Codex starts fresh/);
    assert.match(continuationDetail("unavailable", undefined, "Codex"), /could not be carried over/);
  });
});

describe("forkThread: continue in another agent", () => {
  const codexSelection = { model: "gpt-5-codex", options: [{ id: "effort", value: "high" }] };

  it("hands a claude conversation to codex as a budgeted transcript, never natively", async () => {
    const forks: ForkConversationInput[] = [];
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async (input) => {
        forks.push(input);
        return { resumeCursor: { threadId: input.threadId, resume: "forked" } };
      }
    });
    const codex = createScriptedAdapter({ id: "codex" });
    const host = createTestHost({ adapters: { claude, codex } });
    const parentProfile = { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/claude/shared" };
    const parentId = await host.createThread({ threadId: "parent", refId: "claude", profile: parentProfile });
    await runTurn(host, claude, parentId, "remember SWORDFISH", "noted");
    const second = await runTurn(host, claude, parentId, "and then?", "done");
    await runTurn(host, claude, parentId, "past the fork point", "not carried");
    const parentLog = logOf(host, parentId).length;

    const result = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child", "codex", { messageId: second.replyId }),
      accountId: "",
      home: "system",
      modelSelection: codexSelection,
      continuation: { gitStatus: " M src/app.ts" }
    });
    await host.settle();

    assert.equal(result.strategy, "transcript");
    assert.equal(forks.length, 0, "another agent is never forked natively");
    assert.equal(result.head.adapter, "codex");
    assert.equal(result.head.home, "system", "the child's own home, not the parent's");
    assert.deepEqual(result.head.modelSelection, codexSelection);
    assert.equal(result.head.profileId, undefined, "the parent's profile does not cross agents unasked");
    assert.equal(result.lineage.relation, "fork");
    assert.equal(result.lineage.sourceAgent, "claude");
    assert.equal(result.lineage.sourceModel, "test-model");
    assert.deepEqual(result.lineage.forkedFrom, { messageId: second.replyId, turnId: second.turnId });
    assert.deepEqual(result.handoff, { carried: 4, total: 4, bytes: result.handoff!.bytes });

    const row = activitiesOf(host, "child").find((activity) => activity.activityKind === "thread.forked");
    assert.match(row?.summary ?? "", /^Continued from "Test thread" \(Claude · test-model\)$/);
    assert.match((row?.payload as { detail?: string } | undefined)?.detail ?? "", /handed to Codex with your first message/);
    const continuation = (row?.payload as { continuation?: Record<string, unknown> }).continuation;
    assert.equal(continuation?.sourceAgent, "claude");
    assert.equal(continuation?.targetAgent, "codex");
    assert.equal(continuation?.sourceTitle, "Test thread");

    await host.orchestrator.command("child", "turn", { commandId: cmd(), input: "carry on" });
    await host.settle();
    const sent = codex.lastTurn?.input ?? "";
    assert.match(sent, /^<forked-conversation>\n/);
    assert.match(sent, /remember SWORDFISH/);
    assert.ok(!sent.includes("past the fork point"), "only history up to the fork point");
    assert.match(sent, /read_transcript` with \{"sessionId":"parent"/);
    assert.match(sent, /M src\/app\.ts/);
    assert.match(sent, /\n\ncarry on$/);
    const userTexts = (await snapshotOf(host, "child")).items
      .filter((item) => item.kind === "message" && item.role === "user")
      .map((item) => (item as { text: string }).text);
    assert.deepEqual(userTexts, ["carry on"], "the timeline keeps what the user typed");

    // The parent is only read.
    assert.equal(logOf(host, parentId).length, parentLog);
    assert.deepEqual(host.orchestrator.launchConfig(parentId)?.profile, parentProfile);

    // A repeat answers the child it made.
    const again = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child", "codex", { messageId: second.replyId }),
      accountId: "",
      home: "system",
      modelSelection: codexSelection,
      continuation: {}
    });
    assert.equal(again.head.id, "child");
    assert.equal(again.strategy, "transcript");
    await host.stop();
  });

  it("the same agent under another account is a continuation too: no native fork into the wrong home", async () => {
    const forks: ForkConversationInput[] = [];
    const claude = createScriptedAdapter({
      id: "claude",
      forkConversation: async (input) => {
        forks.push(input);
        return { resumeCursor: { threadId: input.threadId, resume: "forked" } };
      }
    });
    const host = createTestHost({ adapters: { claude } });
    const parentId = await host.createThread({ threadId: "parent", refId: "claude" });
    const said = await runTurn(host, claude, parentId, "hello", "hi");
    const result = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child", "claude", { messageId: said.replyId }),
      accountId: "acc2",
      continuation: {}
    });
    await host.settle();
    assert.equal(result.strategy, "transcript");
    assert.equal(forks.length, 0);
    assert.equal(result.head.accountId, "acc2");
    assert.equal(result.lineage.sourceAgent, "claude");
    assert.equal(result.head.modelSelection.model, "test-model", "the same agent keeps its model unless one is named");
    await host.stop();
  });

  it("a continuation before the first message starts the other agent fresh", async () => {
    const claude = createScriptedAdapter({ id: "claude" });
    const codex = createScriptedAdapter({ id: "codex" });
    const host = createTestHost({ adapters: { claude, codex } });
    const parentId = await host.createThread({ threadId: "parent", refId: "claude" });
    const result = await host.orchestrator.forkThread(parentId, {
      ...forkRequest("child", "codex", {}),
      modelSelection: codexSelection,
      continuation: {}
    });
    await host.settle();
    assert.equal(result.strategy, "empty");
    assert.equal(result.handoff, undefined);
    const row = activitiesOf(host, "child").find((activity) => activity.activityKind === "thread.forked");
    assert.match((row?.payload as { detail?: string } | undefined)?.detail ?? "", /Codex starts fresh/);
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// A fork's child and the parent's published pages (spec 2026-10-14 §2.2, §3, §6)
// ---------------------------------------------------------------------------

/** An `html_render` row as each native-forking provider records it, marked as ingestion marks it. */
function pageRowData(provider: "claude" | "codex" | "opencode", page: { attachmentId: string; title: string; height: number }) {
  const text = JSON.stringify({ htmlRender: page, message: "Shown." });
  const data =
    provider === "claude"
      ? {
          toolName: "mcp__orquester__html_render",
          input: { html: "<p>x</p>", title: page.title, height: page.height },
          result: { type: "tool_result", content: [{ type: "text", text }] }
        }
      : provider === "codex"
        ? {
            server: "orquester",
            tool: "html_render",
            arguments: { html: "<p>x</p>" },
            result: { content: [{ type: "text", text }], structuredContent: { htmlRender: page, message: "Shown." } }
          }
        : {
            tool: "orquester-0123456789abcdef_html_render",
            state: { status: "completed", input: { html: "<p>x</p>" }, output: text }
          };
  return sessionToolMarkedData(data, new Set(["html_render"]));
}

async function pushPageRow(
  host: TestHost<AgentThreadStore>,
  threadId: string,
  turnId: string,
  id: string,
  data: unknown
): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    domainEvent(threadId, host as unknown as TestHost, "thread.activity-appended", {
      activity: {
        id,
        kind: "activity",
        tone: "tool",
        activityKind: "tool.completed",
        summary: "orquester: html_render",
        payload: { itemType: "mcp_tool_call", toolUseId: id, status: "completed", data },
        turnId,
        createdAt: host.clock.nowIso(),
        updatedAt: host.clock.nowIso()
      }
    })
  ]);
  await host.settle();
}

describe("a fork's child and its parent's pages", () => {
  for (const provider of ["claude", "codex", "opencode"] as const) {
    it(`${provider} (native): the retained turns' pages load in the child, survive the parent and the child's sweep`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "orq-fork-pages-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const store = createThreadStore({ rootDir: join(root, "threads") });
      t.after(() => store.close());
      const adapter = createScriptedAdapter({
        id: provider,
        forkConversation: async (input) => ({ resumeCursor: { threadId: input.threadId, resume: "forked" } })
      });
      const host = createTestHost({ adapters: { [provider]: adapter }, store });
      t.after(() => host.stop());
      const parentId = await host.createThread({ threadId: "parent", refId: provider });
      const asFake = host as unknown as TestHost;
      const first = await runTurn(asFake, adapter, parentId, "chart it", "here");
      const second = await runTurn(asFake, adapter, parentId, "another", "there");

      const publish = async (title: string) => {
        const source = join(root, `${title}.html`);
        await writeFile(source, `<p>${title}</p>`);
        const ref = await store.putAttachment({ threadId: parentId, name: `${title}.html`, mimeType: "text/html", sourcePath: source });
        assert.ok(isHtmlRenderAttachmentId(ref.id), ref.id);
        return { attachmentId: ref.id, title, height: 300 };
      };
      const kept = await publish("Kept");
      const dropped = await publish("Dropped");
      await pushPageRow(host, parentId, first.turnId, "row-kept", pageRowData(provider, kept));
      await pushPageRow(host, parentId, second.turnId, "row-dropped", pageRowData(provider, dropped));

      const result = await host.orchestrator.forkThread(parentId, forkRequest("child", provider, { messageId: first.replyId }));
      await host.settle();
      assert.equal(result.strategy, "native");

      // The child's replay names the parent's page, as the provider's row did.
      await pushPageRow(host, "child", "child-turn-1", "child-row", pageRowData(provider, kept));
      const read = await host.orchestrator.readThread("child");
      assert.ok(read.kind === "snapshot");
      const childRow = read.thread.items.find((item) => item.kind === "activity" && item.id === "child-row");
      assert.deepEqual(
        htmlRenderReferenceOfActivityPayload((childRow as { payload?: unknown } | undefined)?.payload),
        kept,
        "the child's row is a visual row, from the slim row it is sent as"
      );

      // It loads in the child — the child's own copy — and only the kept turn's.
      const path = await store.resolveAttachment("child", kept.attachmentId);
      assert.ok(path.includes(join("child", "attachments")) && !path.includes(join("parent", "attachments")), path);
      assert.equal(await readFile(path, "utf8"), "<p>Kept</p>");
      await assert.rejects(store.resolveAttachment("child", dropped.attachmentId), /not found/);
      // A thread that holds no copy still cannot read another thread's page.
      await assert.rejects(store.resolveAttachment("stranger", kept.attachmentId));

      // Deleting the parent breaks nothing; the child's sweep keeps what its rows name.
      await store.deleteThread(parentId);
      await store.pruneAttachments({ threadId: "child", now: new Date(Date.now() + 365 * 24 * 3600_000) });
      assert.equal(await readFile(await store.resolveAttachment("child", kept.attachmentId), "utf8"), "<p>Kept</p>");
    });
  }

  it("codex (native): a replayed MCP App call gets its parent row's app, naming the child's own snapshot, which its sweep keeps", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-fork-apps-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = createThreadStore({ rootDir: join(root, "threads") });
    t.after(() => store.close());
    // The provider's history names the call, never its app (Codex `thread/read`'s `mcpToolCall`).
    const call = { server: "apps", tool: "show_widget", arguments: {}, result: { content: [{ type: "text", text: "ok" }] } };
    const replayed = (threadId: string): RuntimeEvent[] => {
      const raw = { source: HISTORICAL_RAW_SOURCE, payload: null };
      const base = { threadId, createdAt: "1970-01-01T00:00:00.000Z", turnId: "turn-1", raw };
      return [
        { ...base, eventId: "h-start", type: "turn.started", payload: {} },
        {
          ...base,
          eventId: "h-app",
          itemId: "call-app",
          type: "item.completed",
          payload: { itemType: "mcp_tool_call", status: "completed", title: "apps: show_widget", data: call }
        },
        { ...base, eventId: "h-other", itemId: "call-other", type: "item.completed", payload: { itemType: "mcp_tool_call", status: "completed", data: call } },
        { ...base, eventId: "h-end", type: "turn.completed", payload: { state: "completed", tokenUsage: { usageStatus: "unavailable" } } }
      ] as unknown as RuntimeEvent[];
    };
    const codex = createScriptedAdapter({
      id: "codex",
      forkConversation: async (input) => ({ resumeCursor: { threadId: input.threadId, resume: "forked" } }),
      history: { threadId: "child", turns: [{ id: "turn-1", items: [] }] },
      projectHistory: () => replayed("child")
    });
    const host = createTestHost({ adapters: { codex }, store });
    t.after(() => host.stop());
    const parentId = await host.createThread({ threadId: "parent", refId: "codex" });
    const first = await runTurn(host as unknown as TestHost, codex, parentId, "show it", "here");
    const source = join(root, "widget.html");
    await writeFile(source, "<h1>widget</h1>");
    const snapshot = await store.putAttachment({ threadId: parentId, name: "show_widget.html", mimeType: "text/html", sourcePath: source });
    const app = { attachmentId: snapshot.id, server: "apps", tool: "show_widget", resourceUri: "ui://apps/widget.html" };
    await pushPageRow(host, parentId, first.turnId, "call-app", { ...call, mcpApp: app });

    const result = await host.orchestrator.forkThread(parentId, forkRequest("child", "codex", { messageId: first.replyId }));
    await host.settle();
    assert.equal(result.strategy, "native");

    const ingested = (itemId: string) =>
      host.ingestion.ingested.find((event) => event.threadId === "child" && event.type === "item.completed" && event.itemId === itemId);
    const appCall = ingested("call-app");
    assert.deepEqual(mcpAppReferenceOfActivityPayload(appCall?.payload), app, "the replayed call renders its app");
    const other = ingested("call-other");
    assert.ok(other !== undefined);
    assert.equal(mcpAppReferenceOfActivityPayload(other.payload), undefined, "a call the parent showed no app for gets none");
    // The row ingestion writes from it (the fake ingestion writes none).
    await pushPageRow(host, "child", "child-turn-1", "call-app", (appCall!.payload as { data: unknown }).data);

    const path = await store.resolveAttachment("child", snapshot.id);
    assert.ok(path.includes(join("child", "attachments")), path);
    await store.deleteThread(parentId);
    await store.pruneAttachments({ threadId: "child", now: new Date(Date.now() + 365 * 24 * 3600_000) });
    assert.equal(await readFile(await store.resolveAttachment("child", snapshot.id), "utf8"), "<h1>widget</h1>");
  });

  it("grok (transcript): no row of the parent is replayed, so no page is copied", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-fork-pages-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = createThreadStore({ rootDir: join(root, "threads") });
    t.after(() => store.close());
    const grok = createScriptedAdapter({ id: "grok" });
    const host = createTestHost({ adapters: { grok }, store });
    t.after(() => host.stop());
    const parentId = await host.createThread({ threadId: "parent", refId: "grok" });
    const said = await runTurn(host as unknown as TestHost, grok, parentId, "chart it", "here");
    const source = join(root, "p.html");
    await writeFile(source, "<p>p</p>");
    const ref = await store.putAttachment({ threadId: parentId, name: "p.html", mimeType: "text/html", sourcePath: source });
    const result = await host.orchestrator.forkThread(parentId, forkRequest("child", "grok", { messageId: said.replyId }));
    await host.settle();
    assert.equal(result.strategy, "transcript");
    await assert.rejects(store.resolveAttachment("child", ref.id), /not found/);
  });
});
