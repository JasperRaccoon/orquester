import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SessionSummary } from "@orquester/api";
import { ChatSessionManager } from "./chat-sessions.ts";
import { AgentHostClient } from "./host-client.ts";
import { AgentChatSummaryService, sanitizeFields } from "./summary.ts";

// §6.4: the six derived fields, the coarse bus events, and the pushes the
// protocol now produces instead of bells and hooks.

interface Published {
  channel: string;
  type: string;
  payload: unknown;
}

interface Harness {
  service: AgentChatSummaryService;
  chat: ChatSessionManager;
  published: Published[];
  pushes: Array<{ id: string; type: string }>;
}

function harness(now: () => number = () => 1_000_000, onTurnSettled?: () => void): Harness {
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const published: Published[] = [];
  const pushes: Array<{ id: string; type: string }> = [];
  const service = new AgentChatSummaryService({
    // The client is never dialled: every test drives `applyFields` directly.
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
    now,
    onTurnSettled
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

test("a summary read folds onto the tab and publishes session.activity", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  const summary = h.chat.get("t1");
  assert.equal(summary?.chatSessionStatus, "running");
  assert.equal(summary?.activity?.state, "working");
  const activity = h.published.filter((p) => p.type === "session.activity");
  assert.equal(activity.length, 1);
  assert.equal((activity[0].payload as { id: string }).id, "t1");
});

test("an unchanged activity is not re-broadcast on every poll tick", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  assert.equal(h.published.filter((p) => p.type === "session.activity").length, 1);
});

test("a pending approval pushes 'needs your input' exactly once per raise", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { hasPendingApprovals: true });
  h.service.applyFields("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "needs-input" }]);
});

test("a completed turn pushes 'finished'", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", {
    chatSessionStatus: "ready",
    latestTurn: {
      turnId: "a",
      state: "completed",
      startedAt: null,
      completedAt: "2026-09-21T00:00:01.000Z"
    }
  });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
});

test("NEVER a 'finished' push while background liveness is non-null", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  const completed = {
    turnId: "a",
    state: "completed" as const,
    startedAt: null,
    completedAt: "2026-09-21T00:00:01.000Z"
  };
  // A settled turn whose subagents are still running: working, no push.
  h.service.applyFields("t1", {
    chatSessionStatus: "ready",
    backgroundLiveness: "working",
    latestTurn: completed
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.state, "working");

  // Monitoring: idle, but still no finished stamp and still no push.
  h.service.applyFields("t1", {
    chatSessionStatus: "ready",
    backgroundLiveness: "monitoring",
    latestTurn: completed
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.attention, null);

  // The work drains: now it is finished, and now it pushes.
  h.service.applyFields("t1", {
    chatSessionStatus: "ready",
    backgroundLiveness: null,
    latestTurn: completed
  });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
});

test("an errored thread whose watch loop is still live does not push 'finished'", () => {
  // The error rung outranks liveness for the ACTIVITY, but the push is still
  // suppressed — work is live in the thread.
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { chatSessionStatus: "error", backgroundLiveness: "monitoring" });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.attention, "finished", "the failure is still surfaced");
});

test("needsAttentionAt is stamped when attention rises and cleared when it clears", () => {
  let clock = 1_000;
  const h = harness(() => clock);
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { hasPendingApprovals: true });
  const raised = h.chat.get("t1")?.activity?.needsAttentionAt;
  assert.equal(raised, new Date(1_000).toISOString());
  clock = 9_999;
  h.service.applyFields("t1", { hasPendingApprovals: true });
  assert.equal(
    h.chat.get("t1")?.activity?.needsAttentionAt,
    raised,
    "a still-raised attention keeps its original stamp — the Attention Center orders by it"
  );
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  assert.equal(h.chat.get("t1")?.activity?.needsAttentionAt, null);
});

test("a turn transition becomes the coarse agentChat.turn bus event", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  const turn = (state: "running" | "completed") => ({
    chatSessionStatus: "running" as const,
    latestTurn: { turnId: "a", state, startedAt: null, completedAt: null }
  });
  h.service.applyFields("t1", turn("running"));
  h.service.applyFields("t1", turn("running"));
  h.service.applyFields("t1", turn("completed"));
  assert.deepEqual(
    h.published
      .filter((p) => p.type === "agentChat.turn")
      .map((p) => (p.payload as { state: string }).state),
    ["running", "completed"],
    "one event per transition, never per poll tick"
  );
});

test("a settled turn reopens the version drain window", () => {
  const settled: number[] = [];
  const h = harness(
    () => 1_000_000,
    () => settled.push(1)
  );
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", {
    chatSessionStatus: "running",
    latestTurn: { turnId: "a", state: "running", startedAt: null, completedAt: null }
  });
  assert.deepEqual(settled, []);
  h.service.applyFields("t1", {
    chatSessionStatus: "ready",
    latestTurn: { turnId: "a", state: "completed", startedAt: null, completedAt: "x" }
  });
  assert.deepEqual(settled, [1]);
});

test("agent.providers.changed is the one coarse provider event", () => {
  const h = harness();
  h.service.publishProvidersChanged({ adapterId: "codex" });
  assert.deepEqual(h.published, [
    { channel: "registry", type: "agent.providers.changed", payload: { adapterId: "codex" } }
  ]);
});

test("a summary for a thread with no tab is dropped, never pushed", () => {
  const h = harness();
  h.service.applyFields("ghost", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.published, []);
});

test("forget() stops a closed tab producing any further activity", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  h.service.forget("t1");
  h.chat.close("t1");
  h.service.applyFields("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, []);
});

test("the poll idles entirely while nothing is open or the host is down", async () => {
  const h = harness();
  // No tabs: no I/O at all (the client would throw — it has no token).
  await h.service.refreshAll();
  assert.deepEqual(h.published, []);

  const down = new AgentChatSummaryService({
    client: new AgentHostClient({ socketPath: "/dev/null", token: () => "tok" }),
    chat: h.chat,
    broadcaster: { publish: () => undefined },
    push: { notifyStructural: async () => undefined },
    isHostHealthy: () => false
  });
  seedTab(h.chat, "t1");
  await down.refreshAll();
  assert.equal(down.activity("t1"), undefined, "a down host is never dialled");
});

test("a failed read leaves the last known state alone rather than blanking the tab", async () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  // The socket does not exist, so the read throws.
  await h.service.refreshThread("t1");
  assert.equal(h.chat.get("t1")?.activity?.state, "working", "a host restarting mid-poll must not flicker every tab");
});

// --- validation of the host's JSON ------------------------------------------

test("a summary body is validated field-wise before it reaches typed code", () => {
  const fields = sanitizeFields({
    hasPendingApprovals: "yes",
    hasPendingUserInput: true,
    backgroundLiveness: "spinning",
    chatSessionStatus: "ready",
    latestTurn: { turnId: 7, state: "completed", startedAt: null, completedAt: null },
    somethingElse: { big: "payload" }
  });
  assert.equal(fields.hasPendingApprovals, undefined, "a wrongly-typed field is dropped");
  assert.equal(fields.hasPendingUserInput, true);
  assert.equal(fields.backgroundLiveness, undefined, "an unknown liveness value is dropped");
  assert.equal(fields.chatSessionStatus, "ready");
  assert.equal(fields.latestTurn?.turnId, null, "a non-string turn id normalises to null");
  assert.equal((fields as Record<string, unknown>).somethingElse, undefined);
});

test("a non-object body yields no fields rather than throwing", () => {
  assert.deepEqual(sanitizeFields(null), {});
  assert.deepEqual(sanitizeFields("nope"), {});
  assert.deepEqual(sanitizeFields([1, 2]), {});
  assert.deepEqual(sanitizeFields({ backgroundLiveness: null }), { backgroundLiveness: null });
});
