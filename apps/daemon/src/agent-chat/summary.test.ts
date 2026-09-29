import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "@orquester/api";
import { ChatSessionManager } from "./chat-sessions.ts";
import { AgentHostClient } from "./host-client.ts";
import {
  AgentChatSummaryService,
  type ThreadUsageReading
} from "./summary.ts";

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
  read(id: string, fields: unknown, pendingRequests?: unknown[], status?: number): Promise<void>;
}

async function harness(
  t: TestContext,
  now: () => number = () => 1_000_000,
  onTurnSettled?: () => void,
  onBackgroundWorkEnded?: () => void,
  onUsageLimits?: (reading: ThreadUsageReading) => void
): Promise<Harness> {
  t.mock.timers.enable({ apis: ["Date"], now: now() });
  const dir = await mkdtemp(join(tmpdir(), "orq-summary-"));
  const socketPath = join(dir, "host.sock");
  const responses = new Map<string, { status: number; body: unknown }>();
  const server = createServer((req, res) => {
    const response = responses.get(req.url ?? "") ?? { status: 200, body: {} };
    res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const published: Published[] = [];
  const pushes: Array<{ id: string; type: string }> = [];
  const service = new AgentChatSummaryService({
    client: new AgentHostClient({ socketPath, token: () => "tok" }),
    chat,
    broadcaster: { publish: (channel, type, payload) => published.push({ channel, type, payload }) },
    push: { notifyStructural: async (session: SessionSummary, type) => { pushes.push({ id: session.id, type }); } },
    onTurnSettled,
    onBackgroundWorkEnded,
    onUsageLimits
  });
  return {
    service, chat, published, pushes,
    async read(id, fields, pendingRequests, status = 200) {
      t.mock.timers.setTime(now());
      responses.set(`/threads/${encodeURIComponent(id)}/summary`, {
        status,
        body: pendingRequests === undefined ? fields : { ...(fields as object), pendingRequests }
      });
      await service.refreshAll();
    }
  };
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

test("a pending approval pushes 'needs your input' exactly once per raise", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  // The first poll only seeds the baseline (see the restart test below), so
  // start from a quiet thread and let the approval be a real transition.
  await h.read("t1", { chatSessionStatus: "running" });
  await h.read("t1", { hasPendingApprovals: true });
  await h.read("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "needs-input" }]);
});

test("a daemon restart NEVER pushes for state it is merely discovering", async (t) => {
  // Regression: after `systemctl restart orquester` (every deploy) the first
  // poll tick reads each open tab's long-settled turn as a brand-new
  // "finished" attention and fired one Web Push per tab for work the user saw
  // hours ago. The 30 s debounce is in-memory and resets with the process, so
  // it was no backstop.
  const h = await harness(t);

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
    seedTab(h.chat, id);
    await h.read(id, settledHoursAgo);
  }
  assert.deepEqual(h.pushes, [], "no push for state the daemon is discovering");
  // …but the tabs still get their activity, so the UI is correct immediately.
  assert.equal(h.chat.get("t1")?.activity?.attention, "finished");
  assert.equal(h.published.filter((p) => p.type === "session.activity").length, 3);
  // And a genuine transition after that still pushes.
  await h.read("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "needs-input" }]);
});

test("a re-adopted thread (after forget) also seeds silently", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { hasPendingApprovals: true });
  await h.read("t1", { chatSessionStatus: "running" });
  const before = h.pushes.length;
  h.service.forget("t1");
  await h.read("t1", { hasPendingApprovals: true });
  assert.equal(h.pushes.length, before, "a host handover is not a new attention");
});

test("NEVER a 'finished' push while background liveness is non-null", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  const completed = {
    turnId: "a",
    state: "completed" as const,
    startedAt: null,
    completedAt: "2026-09-21T00:00:01.000Z"
  };
  // A settled turn whose subagents are still running: working, no push.
  await h.read("t1", {
    chatSessionStatus: "ready",
    backgroundLiveness: "working",
    latestTurn: completed
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.state, "working");

  // Monitoring: idle, but still no finished stamp and still no push.
  await h.read("t1", {
    chatSessionStatus: "ready",
    backgroundLiveness: "monitoring",
    latestTurn: completed
  });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.attention, null);

  // The work drains: now it is finished, and now it pushes.
  await h.read("t1", {
    chatSessionStatus: "ready",
    backgroundLiveness: null,
    latestTurn: completed
  });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
});

test("a continuing goal holds the finished stamp and push until the goal stops (goals §4.7)", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  const goal = { objective: "ship it", status: "active" as const, continuing: true };
  const completed = {
    turnId: "a",
    state: "completed" as const,
    startedAt: "2026-09-21T00:00:00.000Z",
    completedAt: "2026-09-21T00:00:01.000Z"
  };
  await h.read("t1", {
    chatSessionStatus: "running",
    latestTurn: { ...completed, state: "running", completedAt: null },
    goal
  });
  // The turn settles; Codex will start the next one itself.
  await h.read("t1", { chatSessionStatus: "ready", latestTurn: completed, goal });
  assert.deepEqual(h.pushes, [], "no finished push between two of the provider's own turns");
  assert.equal(h.chat.get("t1")?.activity?.state, "working");
  assert.equal(h.chat.get("t1")?.activity?.attention, null, "no finished stamp");
  assert.deepEqual(h.chat.get("t1")?.goal, goal, "the tab carries the goal");

  // The goal is achieved: now it is finished, and now it pushes.
  await h.read("t1", { chatSessionStatus: "ready", latestTurn: completed, goal: null });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
  assert.equal(h.chat.get("t1")?.goal, null);
});

test("a goal turn killed by a restart raises no finished stamp or push while its resume is owed (goals §5.5)", async (t) => {
  // The host settles the orphaned turn as an error but keeps the goal
  // `continuing` until the resume attempt completes: nothing is finished yet.
  const h = await harness(t);
  seedTab(h.chat, "t1");
  const goal = { objective: "ship it", status: "active" as const, continuing: true };
  const running = {
    turnId: "codex-goal-2",
    state: "running" as const,
    startedAt: "2026-09-21T00:00:00.000Z",
    completedAt: null
  };
  const failed = { ...running, state: "failed" as const, completedAt: "2026-09-21T00:05:00.000Z" };
  await h.read("t1", { chatSessionStatus: "running", latestTurn: running, goal });
  await h.read("t1", { chatSessionStatus: "error", latestTurn: failed, goal });
  assert.deepEqual(h.pushes, [], "no push in the gap");
  assert.equal(h.chat.get("t1")?.activity?.attention, null, "no finished stamp");
  assert.equal(h.chat.get("t1")?.activity?.state, "working");

  // The resume failed: the host stops reporting the goal as continuing, and
  // the error is an error again.
  await h.read("t1", {
    chatSessionStatus: "error",
    latestTurn: failed,
    goal: { ...goal, continuing: false }
  });
  assert.deepEqual(h.pushes, [{ id: "t1", type: "finished" }]);
  assert.equal(h.chat.get("t1")?.activity?.attention, "finished");
});

test("a continuing goal never feeds the drain's background-work view (goals §4.7)", async (t) => {
  // A Codex goal survives a drain-restart — the resume continues it — so it
  // must never hold a deploy's handover open the way a subagent fleet does.
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", {
    chatSessionStatus: "ready",
    goal: { objective: "ship it", status: "active", continuing: true }
  });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), []);
});

test("an errored thread keeps status 'running' — the TAB is live — and shows the error via activity", async (t) => {
  // E2E E18: `SessionSummary.status` is the tab's liveness, not the thread's.
  // `exited` would make every client drop a tab the user can still recover
  // with `/session/stop` or a new turn; the error reaches the tab strip and the
  // Attention Center through `activity` + `chatSessionStatus`.
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { chatSessionStatus: "running" });
  await h.read("t1", { chatSessionStatus: "error" });
  const summary = h.chat.get("t1");
  assert.equal(summary?.status, "running");
  assert.equal(summary?.chatSessionStatus, "error");
  assert.equal(summary?.activity?.state, "idle");
  assert.equal(summary?.activity?.attention, "finished");
});

test("an errored thread whose watch loop is still live does not push 'finished'", async (t) => {
  // The error rung outranks liveness for the ACTIVITY, but the push is still
  // suppressed — work is live in the thread.
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { chatSessionStatus: "running", backgroundLiveness: "monitoring" });
  await h.read("t1", { chatSessionStatus: "error", backgroundLiveness: "monitoring" });
  assert.deepEqual(h.pushes, []);
  assert.equal(h.chat.get("t1")?.activity?.attention, "finished", "the failure is still surfaced");
});

test("needsAttentionAt is stamped when attention rises and cleared when it clears", async (t) => {
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "t1");
  await h.read("t1", { hasPendingApprovals: true });
  const raised = h.chat.get("t1")?.activity?.needsAttentionAt;
  assert.equal(raised, new Date(1_000).toISOString());
  clock = 9_999;
  await h.read("t1", { hasPendingApprovals: true });
  assert.equal(
    h.chat.get("t1")?.activity?.needsAttentionAt,
    raised,
    "a still-raised attention keeps its original stamp — the Attention Center orders by it"
  );
  await h.read("t1", { chatSessionStatus: "running" });
  assert.equal(h.chat.get("t1")?.activity?.needsAttentionAt, null);
});

// --- the stamp is the MCP wait's cursor (MCP v2 spec §9.2) --------------------
//
// `wait_for_session` reports a session only once its `needsAttentionAt` passes
// the caller's cursor, so the stamp must move whenever something NEW calls for
// the user — also when the attention VALUE stays the same.

const iso = (ms: number): string => new Date(ms).toISOString();
const approval = (requestId: string) => ({ requestId, kind: "approval" as const, title: `Run ${requestId}?` });
/** A Supervised turn parked on an approval: the ladder's `needs-input`. */
const awaitingApproval = { chatSessionStatus: "running" as const, hasPendingApprovals: true };
const activityEvents = (h: Harness) => h.published.filter((p) => p.type === "session.activity");
const settledTurn = (turnId: string, state: "completed" | "failed", at: number) => ({
  chatSessionStatus: "ready" as const,
  latestTurn: { turnId, state, startedAt: iso(at - 400), completedAt: iso(at) }
});

test("approval A answered and approval B raised inside one poll restamps, and says so on the bus", async (t) => {
  // A Supervised Claude session raises Edit/Bash approvals back to back. The
  // attention stays `needs-input` throughout, so a value-change-only stamp kept
  // A's and the bus carried only `agentChat.pending`: a client looping on A's
  // cursor never heard about B.
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  await h.read("c1", { chatSessionStatus: "running" });
  clock = 2_000;
  await h.read("c1", awaitingApproval, [approval("A")]);
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(2_000));
  const seen = activityEvents(h).length;

  clock = 3_500;
  await h.read("c1", awaitingApproval, [approval("B")]);
  const expected = { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: iso(3_500) };
  assert.deepEqual(h.chat.get("c1")?.activity, expected, "the same attention, re-stamped: B is a new call");
  assert.deepEqual(
    activityEvents(h).slice(seen).map((p) => p.payload),
    [{ id: "c1", activity: expected }],
    "a stamp that moved alone is still published"
  );
});

test("a turn that starts and settles inside one poll restamps; a turn that stays settled does not", async (t) => {
  // t2 fails fast (a usage limit, say) between two polls: `finished` stays
  // `finished`, and only the latest turn moving says anything happened.
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  await h.read("c1", settledTurn("t1", "completed", 900));
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(1_000));
  const seen = activityEvents(h).length;

  clock = 2_500;
  await h.read("c1", settledTurn("t2", "failed", 2_400));
  assert.equal(h.chat.get("c1")?.activity?.attention, "finished", "the attention value never moved");
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(2_500));
  assert.equal(activityEvents(h).length, seen + 1, "session.activity carried the new stamp");

  clock = 4_000;
  await h.read("c1", settledTurn("t2", "failed", 2_400));
  assert.equal(
    h.chat.get("c1")?.activity?.needsAttentionAt,
    iso(2_500),
    "a settled turn is reported once — restamping every poll is v1's busy loop"
  );
  assert.equal(activityEvents(h).length, seen + 1);
});

test("the same turn settling under a still-open question restamps too", async (t) => {
  // A message-mode question may outlive its turn: `needs-input` holds while the
  // turn goes running → completed, and that settle is news for a waiter.
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  const question = [{ requestId: "q1", kind: "question" as const, title: "Which branch?" }];
  await h.read(
    "c1",
    {
      chatSessionStatus: "running",
      hasPendingUserInput: true,
      latestTurn: { turnId: "t1", state: "running", startedAt: iso(500), completedAt: null }
    },
    question
  );
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(1_000));

  clock = 2_500;
  await h.read(
    "c1",
    {
      chatSessionStatus: "ready",
      hasPendingUserInput: true,
      latestTurn: { turnId: "t1", state: "completed", startedAt: iso(500), completedAt: iso(2_400) }
    },
    question
  );
  assert.equal(h.chat.get("c1")?.activity?.attention, "needs-input");
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(2_500));
});

test("a request that stays open keeps its stamp; only a request id the last poll lacked restamps", async (t) => {
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  const stampOf = () => h.chat.get("c1")?.activity?.needsAttentionAt;
  await h.read("c1", { chatSessionStatus: "running" });
  clock = 2_000;
  await h.read("c1", awaitingApproval, [approval("A")]);
  let seen = activityEvents(h).length;

  clock = 3_500;
  await h.read("c1", awaitingApproval, [approval("A")]);
  assert.equal(stampOf(), iso(2_000), "A still open: the same call keeps the same stamp");
  assert.equal(activityEvents(h).length, seen, "and nothing is re-broadcast");

  clock = 5_000;
  await h.read("c1", awaitingApproval, [approval("A"), approval("B")]);
  assert.equal(stampOf(), iso(5_000), "B opened beside A");
  seen = activityEvents(h).length;

  clock = 6_500;
  await h.read("c1", awaitingApproval, [approval("B")]);
  assert.equal(stampOf(), iso(5_000), "A closing while B stays open is not a new call");
  assert.equal(activityEvents(h).length, seen);
});

test("a restamp alone never pushes: pushes stay gated on the attention VALUE changing", async (t) => {
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  await h.read("c1", { chatSessionStatus: "running" });
  clock = 2_000;
  await h.read("c1", awaitingApproval, [approval("A")]);
  assert.deepEqual(h.pushes, [{ id: "c1", type: "needs-input" }]);

  clock = 3_500;
  await h.read("c1", awaitingApproval, [approval("B")]);
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(3_500), "B restamped");

  clock = 5_000;
  await h.read("c1", settledTurn("t1", "completed", 4_900));
  clock = 6_500;
  await h.read("c1", settledTurn("t2", "failed", 6_400));
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(6_500), "t2 restamped");

  assert.deepEqual(
    h.pushes,
    [
      { id: "c1", type: "needs-input" },
      { id: "c1", type: "finished" }
    ],
    "one push per attention VALUE change; neither restamp pushed"
  );
});

// A turn restamps only when it settled SINCE the last poll: its `completedAt`
// is later than that poll. "The latest turn moved onto a settled one" is not
// enough, because a rewind and a history replay both move it onto turns that
// settled long ago.

test("a rewind back onto a turn that settled long ago keeps the stamp", async (t) => {
  // `thread.reverted` truncates the turns, so `latestTurn` goes t3 → t2. A
  // Codex rewind stays `finished`, and a client that called `revert_session`
  // itself must not be woken by its own rewind.
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  await h.read("c1", settledTurn("t2", "completed", 900));
  clock = 2_500;
  await h.read("c1", settledTurn("t3", "completed", 2_400));
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(2_500));
  const seen = activityEvents(h).length;
  const turnEvents = () => h.published.filter((p) => p.type === "agentChat.turn").length;
  const turnsSeen = turnEvents();

  clock = 4_000;
  await h.read("c1", settledTurn("t2", "completed", 900));
  assert.equal(h.chat.get("c1")?.activity?.attention, "finished");
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(2_500), "t2 settled long before the last poll");
  assert.equal(activityEvents(h).length, seen);
  assert.equal(turnEvents(), turnsSeen + 1, "agentChat.turn still reports the move");
});

test("a history replay committing settled rows one poll at a time keeps the stamp", async (t) => {
  // A create-time resume opens the session at once and replays the provider's
  // history while the head is still `idle`, i.e. `finished`. `stampHistoryTimes`
  // dates every replayed row before the thread was created, so each one is
  // older than any poll of the thread.
  let clock = 10_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  const replayed = (turnId: string, at: number) => ({
    chatSessionStatus: "idle" as const,
    latestTurn: { turnId, state: "completed" as const, startedAt: iso(at - 1), completedAt: iso(at) }
  });
  await h.read("c1", { chatSessionStatus: "idle", latestTurn: null });
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(10_000));
  const seen = activityEvents(h).length;

  clock = 11_500;
  await h.read("c1", replayed("h1", 9_997));
  clock = 13_000;
  await h.read("c1", replayed("h2", 9_998));
  assert.equal(h.chat.get("c1")?.activity?.attention, "finished");
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(10_000), "a replayed turn is the past");
  assert.equal(activityEvents(h).length, seen);
});

test("two turns that fail before the provider names them, inside one poll, restamp", async (t) => {
  // A turn that fails while still `pending` settles `failed` with a null id, so
  // two in a row look alike to `turnMoved`. Only the second one's
  // `completedAt`, written once when it settled, says it is new.
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  const failedUnnamed = (at: number) => ({
    chatSessionStatus: "error" as const,
    latestTurn: { turnId: null, state: "failed" as const, startedAt: null, completedAt: iso(at) }
  });
  await h.read("c1", failedUnnamed(900));
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(1_000));
  const seen = activityEvents(h).length;

  clock = 2_500;
  await h.read("c1", failedUnnamed(2_400));
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(2_500));
  assert.equal(activityEvents(h).length, seen + 1);
});

test("a turn moving into pending or running never restamps, whatever its completedAt says", async (t) => {
  // Pins the "settled" half. The error rung outranks running, so the attention
  // stays `finished` while a new turn is requested and runs. A running turn's
  // `completedAt` can hold a mid-turn placeholder-checkpoint stamp
  // (`turn-state.ts`), so a `completedAt` later than the last poll alone does
  // not mean the turn settled since then.
  let clock = 1_000;
  const h = await harness(t, () => clock);
  seedTab(h.chat, "c1");
  await h.read("c1", {
    chatSessionStatus: "error",
    latestTurn: { turnId: "t1", state: "failed", startedAt: iso(500), completedAt: iso(900) }
  });
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(1_000));
  const seen = activityEvents(h).length;

  clock = 2_500;
  await h.read("c1", {
    chatSessionStatus: "error",
    latestTurn: { turnId: null, state: "pending", startedAt: null, completedAt: null }
  });
  clock = 4_000;
  await h.read("c1", {
    chatSessionStatus: "error",
    latestTurn: { turnId: "t2", state: "running", startedAt: iso(3_000), completedAt: iso(3_900) }
  });
  assert.equal(h.chat.get("c1")?.activity?.attention, "finished", "the error rung outranks running");
  assert.equal(h.chat.get("c1")?.activity?.needsAttentionAt, iso(1_000));
  assert.equal(activityEvents(h).length, seen);
});

test("a turn transition becomes the coarse agentChat.turn bus event", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  const turn = (state: "running" | "completed") => ({
    chatSessionStatus: "running" as const,
    latestTurn: { turnId: "a", state, startedAt: null, completedAt: null }
  });
  await h.read("t1", turn("running"));
  await h.read("t1", turn("running"));
  await h.read("t1", turn("completed"));
  assert.deepEqual(
    h.published
      .filter((p) => p.type === "agentChat.turn")
      .map((p) => (p.payload as { state: string }).state),
    ["running", "completed"],
    "one event per transition, never per poll tick"
  );
});

test("a settled turn reopens the version drain window", async (t) => {
  const settled: number[] = [];
  const h = await harness(
    t,
    () => 1_000_000,
    () => settled.push(1)
  );
  seedTab(h.chat, "t1");
  await h.read("t1", {
    chatSessionStatus: "running",
    latestTurn: { turnId: "a", state: "running", startedAt: null, completedAt: null }
  });
  assert.deepEqual(settled, []);
  await h.read("t1", {
    chatSessionStatus: "ready",
    latestTurn: { turnId: "a", state: "completed", startedAt: null, completedAt: "1970-01-01T00:16:40.000Z" }
  });
  assert.deepEqual(settled, [1]);
});

test("agentChat.pending fires once per open and once per close, deduped across polls", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  const approval = { requestId: "r1", kind: "approval" as const, title: "Run tests?" };
  const pendingEvents = () => h.published.filter((p) => p.type === "agentChat.pending");

  // Three polls with the same open request → exactly one event.
  await h.read("t1", { hasPendingApprovals: true }, [approval]);
  await h.read("t1", { hasPendingApprovals: true }, [approval]);
  await h.read("t1", { hasPendingApprovals: true }, [approval]);
  assert.equal(pendingEvents().length, 1);
  assert.deepEqual(pendingEvents()[0].payload, {
    id: "t1",
    requestId: "r1",
    kind: "approval",
    title: "Run tests?",
    open: true
  });

  // It is answered: one close event.
  await h.read("t1", {}, []);
  assert.equal(pendingEvents().length, 2);
  assert.deepEqual(pendingEvents()[1].payload, {
    id: "t1",
    requestId: "r1",
    kind: "approval",
    title: "Run tests?",
    open: false
  });
  await h.read("t1", {}, []);
  assert.equal(pendingEvents().length, 2, "a closed request is never re-closed");
});

test("one request closing while another opens is TWO events, not silence", async (t) => {
  // The booleans stay `true` across such a tick, so a diff on them alone would
  // never tell the client the first request was answered.
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { hasPendingApprovals: true }, [
    { requestId: "r1", kind: "approval", title: "first" }
  ]);
  await h.read("t1", { hasPendingApprovals: true }, [
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

test("approvals and questions keep their kinds (different UI, different push copy)", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { hasPendingApprovals: true, hasPendingUserInput: true }, [
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

test("pending rows are validated and duplicate request IDs keep the last row", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { pendingRequests: "nope" });
  assert.equal(h.published.filter((event) => event.type === "agentChat.pending").length, 0);
  await h.read("t1", {}, [
    { requestId: "", kind: "approval", title: "x" },
    { requestId: "r1", kind: "elsewhere", title: "x" },
    { requestId: "r2", kind: "approval", title: 7 },
    null,
    { requestId: "r3", kind: "approval", title: "replaced" },
    { requestId: "r3", kind: "question", title: "ok" }
  ]);
  assert.deepEqual(h.published.filter((event) => event.type === "agentChat.pending").map((event) => event.payload), [
    { id: "t1", requestId: "r2", kind: "approval", title: "", open: true },
    { id: "t1", requestId: "r3", kind: "question", title: "ok", open: true }
  ]);
});

test("a thread the host no longer has closes out its open requests", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { hasPendingApprovals: true }, [
    { requestId: "r1", kind: "approval", title: "Run tests?" }
  ]);
  h.published.length = 0;
  await h.read("t1", {}, undefined, 404);
  assert.deepEqual(h.published.filter((event) => event.type === "agentChat.pending").map((event) => event.payload), [
    { id: "t1", requestId: "r1", kind: "approval", title: "Run tests?", open: false }
  ]);
});

test("agent.providers.changed is the one coarse provider event", async (t) => {
  const h = await harness(t);
  h.service.publishProvidersChanged({ adapterId: "codex" });
  assert.deepEqual(h.published, [
    { channel: "registry", type: "agent.providers.changed", payload: { adapterId: "codex" } }
  ]);
});

test("forget() stops a closed tab producing any further activity", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { chatSessionStatus: "running" });
  h.service.forget("t1");
  h.chat.close("t1");
  h.published.length = 0;
  await h.read("t1", { hasPendingApprovals: true });
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(h.published, []);
});

test("a failed read leaves the last known state alone rather than blanking the tab", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { chatSessionStatus: "running" });
  await h.read("t1", {}, undefined, 503);
  assert.equal(h.chat.get("t1")?.activity?.state, "working");
});

test("a summary body is validated field-wise before it reaches typed code", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  for (const body of [null, "nope", [1, 2]]) {
    await h.read("t1", body);
    assert.equal(h.chat.get("t1")?.activity?.attention, null);
  }
  await h.read("t1", {
    hasPendingApprovals: "yes",
    hasPendingUserInput: true,
    backgroundLiveness: "spinning",
    chatSessionStatus: "ready",
    latestTurn: { turnId: 7, state: "completed", startedAt: null, completedAt: null },
    somethingElse: { big: "payload" }
  });
  const summary = h.chat.get("t1");
  assert.equal(summary?.hasPendingApprovals, undefined);
  assert.equal(summary?.hasPendingUserInput, true);
  assert.equal(summary?.backgroundLiveness, undefined);
  assert.equal(summary?.chatSessionStatus, "ready");
  assert.equal(summary?.latestTurn?.turnId, null);
  assert.equal(summary?.activity?.attention, "needs-input");
  assert.equal((summary as unknown as Record<string, unknown>).somethingElse, undefined);
});

test("the daemon's own background-liveness view feeds the drain, and its ending reopens the window", async (t) => {
  // The §3.1 drain-restart also waits on subagent fleets and watch loops. A
  // host from before `/health` reported them cannot say so itself, so the
  // supervisor reads the summary poll's `backgroundLiveness` too.
  let reopened = 0;
  const h = await harness(t, undefined, undefined, () => reopened++);
  seedTab(h.chat, "t1");
  seedTab(h.chat, "t2");
  await h.read("t1", { chatSessionStatus: "ready", backgroundLiveness: "working" });
  await h.read("t2", { chatSessionStatus: "ready", backgroundLiveness: "monitoring" });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness().sort(), ["t1", "t2"]);
  assert.equal(reopened, 0, "work starting reopens nothing");
  await h.read("t1", { chatSessionStatus: "ready", backgroundLiveness: null });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), ["t2"]);
  assert.equal(reopened, 1, "the fleet finishing reopens the drain window");
  await h.read("t2", { chatSessionStatus: "ready" });
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), [], "an absent field reads as none");
  assert.equal(reopened, 2);
  h.service.forget("t2");
  assert.deepEqual(h.service.threadsWithBackgroundLiveness(), []);
});

test("hasPolled flips after the first completed poll round, even an empty one", async (t) => {
  // The supervisor adopts a host at boot BEFORE the poll starts; until one
  // round has run, the background-liveness view is unknown, not empty.
  const h = await harness(t);
  assert.equal(h.service.hasPolled(), false);
  await h.service.refreshAll();
  assert.equal(h.service.hasPolled(), true, "no tabs open is still a completed round");
});

test("the goal is validated field-wise, with a fallback, before the ladder reads it", async (t) => {
  const h = await harness(t);
  seedTab(h.chat, "t1");
  await h.read("t1", { goal: { objective: "ship it", status: "usage-limited", continuing: false, extra: { big: 1 } } });
  assert.deepEqual(h.chat.get("t1")?.goal, { objective: "ship it", status: "usage-limited", continuing: false });
  await h.read("t1", { goal: null });
  assert.equal(h.chat.get("t1")?.goal, null);
  for (const goal of [
    { objective: "", status: "active", continuing: true },
    { objective: 7, status: "active", continuing: true },
    { objective: "ship it", status: "running", continuing: true },
    { objective: "ship it", continuing: true },
    "ship it", ["ship it"]
  ]) {
    await h.read("t1", { chatSessionStatus: "idle", goal });
    assert.equal(h.chat.get("t1")?.goal, undefined, JSON.stringify(goal));
    assert.equal(h.chat.get("t1")?.activity?.attention, "finished");
  }
  for (const continuing of [undefined, "yes"]) {
    await h.read("t1", { goal: { objective: "ship it", status: "active", continuing } });
    assert.deepEqual(h.chat.get("t1")?.goal, { objective: "ship it", status: "active", continuing: false });
  }
  await h.read("t1", {});
  assert.equal(h.chat.get("t1")?.goal, undefined, "an older host can omit the goal field");
});

test("a thread's live usage reading is handed on once per new reading, with the tab's entry", async (t) => {
  const readings: ThreadUsageReading[] = [];
  const h = await harness(t, undefined, undefined, undefined, (reading) => readings.push(reading));
  seedTab(h.chat, "t1");
  const usageLimits = {
    observedAt: "2026-09-28T14:00:00.000Z", home: "account", accountId: "acc-1",
    windows: [
      { id: "session", kind: "session", label: "Session", usedPercent: 4 },
      { id: "junk", kind: "weekly", label: "x", usedPercent: "12" }
    ]
  };
  await h.read("t1", { usageLimits });
  await h.read("t1", { usageLimits });
  assert.deepEqual(readings, [{
    threadId: "t1", refId: "claude",
    limits: { observedAt: "2026-09-28T14:00:00.000Z", home: "account", accountId: "acc-1",
      windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 4 }] }
  }]);
  await h.read("t1", { usageLimits: { ...usageLimits, observedAt: "2026-09-28T14:00:05.000Z" } });
  assert.equal(readings.length, 2);
  for (const body of [{}, { usageLimits: { ...usageLimits, observedAt: "nope" } }, { usageLimits: { ...usageLimits, home: "elsewhere" } }]) {
    await h.read("t1", body);
    assert.equal(readings.length, 2);
  }
  h.chat.close("t1");
  await h.read("t1", { usageLimits: { ...usageLimits, observedAt: "2026-09-28T14:00:10.000Z" } });
  assert.equal(readings.length, 2);
});
