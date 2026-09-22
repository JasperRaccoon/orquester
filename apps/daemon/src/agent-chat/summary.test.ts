import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@orquester/api";
import { ChatSessionManager } from "./chat-sessions.ts";
import { AgentHostClient } from "./host-client.ts";
import { AgentChatSummaryService, sanitizeFields, sanitizePendingRequests } from "./summary.ts";

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

function harness(
  now: () => number = () => 1_000_000,
  onTurnSettled?: () => void,
  onBackgroundWorkEnded?: () => void
): Harness {
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
    onTurnSettled,
    onBackgroundWorkEnded
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
  // The first poll only seeds the baseline (see the restart test below), so
  // start from a quiet thread and let the approval be a real transition.
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  h.service.applyFields("t1", { hasPendingApprovals: true });
  h.service.applyFields("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "needs-input" }]);
});

test("a completed turn pushes 'finished' — on the TRANSITION, not the first sight of it", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  const completed = {
    turnId: "a",
    state: "completed" as const,
    startedAt: null,
    completedAt: "2026-09-21T00:00:01.000Z"
  };
  // First poll = the daemon discovering the thread; it only seeds the baseline.
  h.service.applyFields("t1", { chatSessionStatus: "running", latestTurn: null });
  h.service.applyFields("t1", { chatSessionStatus: "ready", latestTurn: completed });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
});

test("a daemon restart NEVER pushes for state it is merely discovering", () => {
  // Regression: after `systemctl restart orquester` (every deploy) the first
  // poll tick reads each open tab's long-settled turn as a brand-new
  // "finished" attention and fired one Web Push per tab for work the user saw
  // hours ago. The 30 s debounce is in-memory and resets with the process, so
  // it was no backstop.
  const h = harness();
  seedTab(h.chat, "t1");
  seedTab(h.chat, "t2");
  seedTab(h.chat, "t3");
  const settledHoursAgo = {
    chatSessionStatus: "ready" as const,
    latestTurn: {
      turnId: "a",
      state: "completed" as const,
      startedAt: null,
      completedAt: "2026-09-20T09:00:00.000Z"
    }
  };
  for (const id of ["t1", "t2", "t3"]) {
    h.service.applyFields(id, settledHoursAgo);
  }
  assert.deepEqual(h.pushes, [], "no push for state the daemon is discovering");
  // …but the tabs still get their activity, so the UI is correct immediately.
  assert.equal(h.chat.get("t1")?.activity?.attention, "finished");
  assert.equal(h.published.filter((p) => p.type === "session.activity").length, 3);
  // And a genuine transition after that still pushes.
  h.service.applyFields("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "needs-input" }]);
});

test("a re-adopted thread (after forget) also seeds silently", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { hasPendingApprovals: true });
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  const before = h.pushes.length;
  h.service.forget("t1");
  h.service.applyFields("t1", { hasPendingApprovals: true });
  assert.equal(h.pushes.length, before, "a host handover is not a new attention");
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

test("an errored thread keeps status 'running' — the TAB is live — and shows the error via activity", () => {
  // E2E E18: `SessionSummary.status` is the tab's liveness, not the thread's.
  // `exited` would make every client drop a tab the user can still recover
  // with `/session/stop` or a new turn; the error reaches the tab strip and the
  // Attention Center through `activity` + `chatSessionStatus`.
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { chatSessionStatus: "running" });
  h.service.applyFields("t1", { chatSessionStatus: "error" });
  const summary = h.chat.get("t1");
  assert.equal(summary?.status, "running");
  assert.equal(summary?.chatSessionStatus, "error");
  assert.equal(summary?.activity?.state, "idle");
  assert.equal(summary?.activity?.attention, "finished");
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

test("agentChat.pending fires once per open and once per close, deduped across polls", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  const approval = { requestId: "r1", kind: "approval" as const, title: "Run tests?" };
  const pendingEvents = () => h.published.filter((p) => p.type === "agentChat.pending");

  // Three polls with the same open request → exactly one event.
  h.service.applyFields("t1", { hasPendingApprovals: true }, [approval]);
  h.service.applyFields("t1", { hasPendingApprovals: true }, [approval]);
  h.service.applyFields("t1", { hasPendingApprovals: true }, [approval]);
  assert.equal(pendingEvents().length, 1);
  assert.deepEqual(pendingEvents()[0].payload, {
    id: "t1",
    requestId: "r1",
    kind: "approval",
    title: "Run tests?",
    open: true
  });

  // It is answered: one close event.
  h.service.applyFields("t1", {}, []);
  assert.equal(pendingEvents().length, 2);
  assert.deepEqual(pendingEvents()[1].payload, {
    id: "t1",
    requestId: "r1",
    kind: "approval",
    title: "Run tests?",
    open: false
  });
  h.service.applyFields("t1", {}, []);
  assert.equal(pendingEvents().length, 2, "a closed request is never re-closed");
});

test("one request closing while another opens is TWO events, not silence", () => {
  // The booleans stay `true` across such a tick, so a diff on them alone would
  // never tell the client the first request was answered.
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { hasPendingApprovals: true }, [
    { requestId: "r1", kind: "approval", title: "first" }
  ]);
  h.service.applyFields("t1", { hasPendingApprovals: true }, [
    { requestId: "r2", kind: "approval", title: "second" }
  ]);
  assert.deepEqual(
    h.published
      .filter((p) => p.type === "agentChat.pending")
      .map((p) => {
        const payload = p.payload as { requestId: string; open: boolean };
        return [payload.requestId, payload.open];
      }),
    [
      ["r1", true],
      ["r2", true],
      ["r1", false]
    ]
  );
});

test("approvals and questions keep their kinds (different UI, different push copy)", () => {
  const h = harness();
  seedTab(h.chat, "t1");
  h.service.applyFields("t1", { hasPendingApprovals: true, hasPendingUserInput: true }, [
    { requestId: "r1", kind: "approval", title: "Run tests?" },
    { requestId: "r2", kind: "question", title: "Which branch?" }
  ]);
  assert.deepEqual(
    h.published
      .filter((p) => p.type === "agentChat.pending")
      .map((p) => (p.payload as { kind: string }).kind),
    ["approval", "question"]
  );
});

test("a malformed pending row is dropped rather than published", () => {
  // `requestId` is what a client posts an approval against: a row without a
  // usable one is worse than no row.
  assert.deepEqual(sanitizePendingRequests(null), []);
  assert.deepEqual(sanitizePendingRequests({ pendingRequests: "nope" }), []);
  assert.deepEqual(
    sanitizePendingRequests({
      pendingRequests: [
        { requestId: "", kind: "approval", title: "x" },
        { requestId: "r1", kind: "elsewhere", title: "x" },
        { requestId: "r2", kind: "approval", title: 7 },
        null,
        { requestId: "r3", kind: "question", title: "ok" }
      ]
    }),
    [
      { requestId: "r2", kind: "approval", title: "" },
      { requestId: "r3", kind: "question", title: "ok" }
    ]
  );
});

test("a thread the host no longer has closes out its open requests", async () => {
  // The TAB may still exist here, so a card that can never be answered must
  // not be left on screen.
  const dir = await mkdtemp(join(tmpdir(), "orq-summary-404-"));
  const socketPath = join(dir, "host.sock");
  const server = createServer((_req, res) =>
    res.writeHead(404, { "content-type": "application/json" }).end("{}")
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const published: Published[] = [];
  const service = new AgentChatSummaryService({
    client: new AgentHostClient({ socketPath, token: () => "tok" }),
    chat,
    broadcaster: { publish: (channel, type, payload) => published.push({ channel, type, payload }) },
    push: { notifyStructural: async () => undefined }
  });
  seedTab(chat, "t1");
  service.applyFields("t1", { hasPendingApprovals: true }, [
    { requestId: "r1", kind: "approval", title: "Run tests?" }
  ]);
  published.length = 0;
  await service.refreshThread("t1");
  assert.deepEqual(published.filter((p) => p.type === "agentChat.pending").map((p) => p.payload), [
    { id: "t1", requestId: "r1", kind: "approval", title: "Run tests?", open: false }
  ]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
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

test("the daemon's own background-liveness view feeds the drain, and its ending reopens the window", () => {
  // The §3.1 drain-restart also waits on subagent fleets and watch loops. A
  // host from before `/health` reported them cannot say so itself, so the
  // supervisor reads the summary poll's `backgroundLiveness` too.
  let reopened = 0;
  const h = harness(undefined, undefined, () => reopened++);
  seedTab(h.chat, "t1");
  seedTab(h.chat, "t2");
  h.service.applyFields("t1", { chatSessionStatus: "ready", backgroundLiveness: "working" });
  h.service.applyFields("t2", { chatSessionStatus: "ready", backgroundLiveness: "monitoring" });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness().sort(), ["t1", "t2"]);
  assert.equal(reopened, 0, "work starting reopens nothing");
  h.service.applyFields("t1", { chatSessionStatus: "ready", backgroundLiveness: null });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), ["t2"]);
  assert.equal(reopened, 1, "the fleet finishing reopens the drain window");
  h.service.applyFields("t2", { chatSessionStatus: "ready" });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), [], "an absent field reads as none");
  assert.equal(reopened, 2);
  h.service.forget("t2");
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), []);
});

test("hasPolled flips after the first completed poll round, even an empty one", async () => {
  // The supervisor adopts a host at boot BEFORE the poll starts; until one
  // round has run, the background-liveness view is unknown, not empty.
  const h = harness();
  assert.equal(h.service.hasPolled(), false);
  await h.service.refreshAll();
  assert.equal(h.service.hasPolled(), true, "no tabs open is still a completed round");
});

test("a non-object body yields no fields rather than throwing", () => {
  assert.deepEqual(sanitizeFields(null), {});
  assert.deepEqual(sanitizeFields("nope"), {});
  assert.deepEqual(sanitizeFields([1, 2]), {});
  assert.deepEqual(sanitizeFields({ backgroundLiveness: null }), { backgroundLiveness: null });
});
