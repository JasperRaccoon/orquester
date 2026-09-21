import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SessionSummary } from "@orquester/api";
import { ChatSessionManager } from "./chat-sessions.ts";
import { AgentHostClient } from "./host-client.ts";
import { parseAgentHostSignalFrame } from "./host-signals.ts";
import { AgentChatSummaryService } from "./summary.ts";

// §6.4: the six derived fields, the three new bus events, and the pushes the
// protocol now produces instead of bells and hooks.

interface Published {
  channel: string;
  type: string;
  payload: unknown;
}

function harness(now = () => 1_000_000): {
  service: AgentChatSummaryService;
  chat: ChatSessionManager;
  published: Published[];
  pushes: Array<{ id: string; type: string }>;
} {
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const published: Published[] = [];
  const pushes: Array<{ id: string; type: string }> = [];
  const service = new AgentChatSummaryService({
    // The client is never used: every test drives `applyFrame` directly.
    client: new AgentHostClient({ socketPath: "/dev/null", token: () => null }),
    chat,
    broadcaster: {
      publish: (channel, type, payload) => published.push({ channel, type, payload })
    },
    push: {
      notifyStructural: async (session: SessionSummary, type) => {
        pushes.push({ id: session.id, type });
      }
    },
    now
  });
  return { service, chat, published, pushes };
}

function seedTab(chat: ChatSessionManager, id: string): void {
  chat.create({
    id,
    refId: "claude",
    title: id,
    projectPath: "/w/p",
    cwd: "/w/p",
    order: 0,
    accountId: "acc-1",
    home: "account"
  });
}

test("a thread frame folds onto the tab and publishes session.activity", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: { chatSessionStatus: "running" }
  });
  const summary = h.chat.get("t1");
  assert.equal(summary?.chatSessionStatus, "running");
  assert.equal(summary?.activity?.state, "working");
  const activity = h.published.filter((p) => p.type === "session.activity");
  assert.equal(activity.length, 1);
  assert.deepEqual((activity[0].payload as { id: string }).id, "t1");
});

test("an unchanged activity is not re-broadcast", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { chatSessionStatus: "running" } });
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { chatSessionStatus: "running" } });
  assert.equal(h.published.filter((p) => p.type === "session.activity").length, 1);
});

test("a pending approval pushes 'needs your input' exactly once per raise", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { hasPendingApprovals: true } });
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { hasPendingApprovals: true } });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "needs-input" }]);
});

test("a completed turn pushes 'finished'", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: {
      chatSessionStatus: "ready",
      latestTurn: { turnId: "a", state: "completed", startedAt: null, completedAt: "2026-09-21T00:00:01.000Z" }
    }
  });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
});

test("NEVER a 'finished' push while background liveness is non-null", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  // A settled turn whose subagents are still running: working, no push.
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: {
      chatSessionStatus: "ready",
      backgroundLiveness: "working",
      latestTurn: { turnId: "a", state: "completed", startedAt: null, completedAt: "2026-09-21T00:00:01.000Z" }
    }
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.state, "working");

  // Monitoring: idle, but still no finished stamp and still no push.
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: {
      chatSessionStatus: "ready",
      backgroundLiveness: "monitoring",
      latestTurn: { turnId: "a", state: "completed", startedAt: null, completedAt: "2026-09-21T00:00:01.000Z" }
    }
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.attention, null);

  // The work drains: now it is finished, and now it pushes.
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: {
      chatSessionStatus: "ready",
      backgroundLiveness: null,
      latestTurn: { turnId: "a", state: "completed", startedAt: null, completedAt: "2026-09-21T00:00:01.000Z" }
    }
  });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
});

test("an errored thread whose watch loop is still live does not push 'finished'", () => {
  // The error rung outranks liveness for the ACTIVITY, but the push is still
  // suppressed — work is live in the thread.
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: { chatSessionStatus: "error", backgroundLiveness: "monitoring" }
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.attention, "finished", "the failure is still surfaced");
});

test("needsAttentionAt is stamped when attention rises and cleared when it clears", () => {
  let clock = 1_000;
  const h = harness(() => clock);
  seedTab(h.chat, "t1");
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { hasPendingApprovals: true } });
  const raised = h.chat.get("t1")?.activity?.needsAttentionAt;
  assert.equal(raised, new Date(1_000).toISOString());
  clock = 9_999;
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { hasPendingApprovals: true } });
  assert.equal(
    h.chat.get("t1")?.activity?.needsAttentionAt,
    raised,
    "a still-raised attention keeps its original stamp — the Attention Center orders by it"
  );
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { chatSessionStatus: "running" } });
  assert.equal(h.chat.get("t1")?.activity?.needsAttentionAt, null);
});

test("turn / pending / providers frames become the three coarse bus events", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({ kind: "turn", threadId: "t1", turnId: "a", state: "running" });
  h.service.applyFrame({
    kind: "pending",
    threadId: "t1",
    requestId: "r1",
    requestKind: "approval",
    title: "Run tests?",
    open: true
  });
  h.service.applyFrame({ kind: "providers", adapterId: "codex" });
  assert.deepEqual(
    h.published.map((p) => p.type),
    ["agentChat.turn", "agentChat.pending", "agent.providers.changed"]
  );
  assert.deepEqual(h.published[1].payload, {
    id: "t1",
    requestId: "r1",
    kind: "approval",
    title: "Run tests?",
    open: true
  });
});

test("a `hello` frame REPLACES the world: an absent thread has no live background work", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  seedTab(h.chat, "t2");
  h.service.applyFrame({
    kind: "thread",
    threadId: "t1",
    fields: { backgroundLiveness: "working", chatSessionStatus: "ready" }
  });
  h.service.applyFrame({
    kind: "hello",
    hostInstanceId: "host-2",
    threads: [{ threadId: "t2", fields: { chatSessionStatus: "ready" } }]
  });
  assert.equal(h.chat.get("t1")?.backgroundLiveness ?? null, null, "a restarted host's registry is empty");
  assert.equal(h.chat.get("t2")?.chatSessionStatus, "ready");
  assert.equal(h.service.currentHostInstanceId(), "host-2");
});

test("a changed host instance id notifies listeners (a restart is not a reconnect)", () => {
  const h = harness();
  const seen: string[] = [];
  h.service.onHostInstanceChanged((id) => seen.push(id));
  h.service.applyFrame({ kind: "hello", hostInstanceId: "host-1", threads: [] });
  assert.deepEqual(seen, [], "the first hello is not a change");
  h.service.applyFrame({ kind: "hello", hostInstanceId: "host-2", threads: [] });
  assert.deepEqual(seen, ["host-2"]);
});

test("a frame for a thread with no tab is dropped, never pushed", () => {
  const h = harness();
  h.service.applyFrame({ kind: "thread", threadId: "ghost", fields: { hasPendingApprovals: true } });
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.published, []);
});

test("forget() stops a closed tab producing any further activity", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { chatSessionStatus: "running" } });
  h.service.forget("t1");
  h.chat.close("t1");
  h.service.applyFrame({ kind: "thread", threadId: "t1", fields: { hasPendingApprovals: true } });
  assert.deepEqual(h.pushes, []);
});

// --- the tolerant line parser ----------------------------------------------

test("the signal parser skips blanks, heartbeats and malformed lines", () => {
  assert.equal(parseAgentHostSignalFrame(""), null);
  assert.equal(parseAgentHostSignalFrame("   "), null);
  assert.equal(parseAgentHostSignalFrame(":hb"), null);
  assert.equal(parseAgentHostSignalFrame("{not json"), null);
  assert.equal(parseAgentHostSignalFrame("[1,2]"), null);
  assert.equal(parseAgentHostSignalFrame('{"kind":"thread"}'), null, "a frame with no threadId");
  assert.equal(
    parseAgentHostSignalFrame('{"kind":"from-the-future","x":1}'),
    null,
    "a build-ahead host's unknown kind is skipped, never fatal"
  );
});

test("the signal parser keeps only well-shaped §6.4 fields", () => {
  const frame = parseAgentHostSignalFrame(
    JSON.stringify({
      kind: "thread",
      threadId: "t1",
      fields: {
        hasPendingApprovals: "yes",
        hasPendingUserInput: true,
        backgroundLiveness: "spinning",
        chatSessionStatus: "ready",
        latestTurn: { turnId: 7, state: "completed", startedAt: null, completedAt: null },
        somethingElse: { big: "payload" }
      }
    })
  );
  assert.ok(frame && frame.kind === "thread");
  assert.equal(frame.fields.hasPendingApprovals, undefined, "a wrongly-typed field is dropped");
  assert.equal(frame.fields.hasPendingUserInput, true);
  assert.equal(frame.fields.backgroundLiveness, undefined, "an unknown liveness value is dropped");
  assert.equal(frame.fields.latestTurn?.turnId, null, "a non-string turn id normalises to null");
  assert.equal((frame.fields as Record<string, unknown>).somethingElse, undefined);
});
