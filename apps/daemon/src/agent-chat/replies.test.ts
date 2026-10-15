/**
 * Reply subscriptions (unified MCP design 2026-10-15 §8.3, §8.4, §13 d–e), service level (§14.2.6):
 * queue-not-steer binding by command id, persisted-before-post, the waiter/router CAS in both
 * orders, needs-input keeping notify, restart conversion, receipt-deduped re-posts, boot
 * reconciliation (exactly once; claimed ones resumed), the empty-reply text, notices, hops.
 *
 * A fake host behind the daemon's own routes (`DaemonApi`): `/turn` appends the events a real host
 * does (`thread.message-sent`, `thread.turn-start-requested` under the command id), keeps
 * receipts (a repeat replays its seq), and the thread read answers a snapshot — or, with `after`,
 * the events since. The real delivery queue (`LineageService`) carries messages and replies.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { EventMessage, SessionSummary } from "@orquester/api";
import {
  parseThreadMessage,
  replyNoticeText,
  THREAD_MESSAGE_CONTEXT_KIND,
  THREAD_REPLY_CONTEXT_KIND,
  type CausedBy,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type Turn
} from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonResponse } from "../mcp/daemon-api.ts";
import { LineageService } from "./lineage.ts";
import { ReplyError, ReplyRouter } from "./replies.ts";
import { registerWait } from "./waits.ts";

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

interface FakeThread {
  seq: number;
  turns: Turn[];
  items: ThreadItem[];
  events: Array<{ seq: number; type: string; commandId: string | null; payload: Record<string, unknown> }>;
  asking: boolean;
}

interface Post {
  sessionId: string;
  body: Record<string, unknown>;
}

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    kind: "agent-chat",
    refId: "claude",
    title: id === "req" ? "Implement auth" : id === "tgt" ? "Codex review" : id,
    projectPath: id === "tgt" ? "/w/jaspersito/orquester-3" : "/w/jaspersito/orquester",
    cwd: "/w",
    cols: 0,
    rows: 0,
    status: "running",
    order: 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    ...extra
  }) as SessionSummary;

function fakeHost() {
  const sessions = new Map<string, SessionSummary>();
  const threads = new Map<string, FakeThread>();
  const posts: Post[] = [];
  const receipts = new Map<string, DaemonResponse>();
  const listeners = new Set<(event: EventMessage) => void>();
  let ids = 0;
  /** Called on every accepted `/turn` before it lands (assert what is on disk then). */
  let beforePost: ((post: Post) => void) | null = null;
  /** The next post's refusal, once. */
  let refuseNext: DaemonResponse | null = null;

  const thread = (id: string): FakeThread => {
    let t = threads.get(id);
    if (!t) {
      t = { seq: 1, turns: [], items: [], events: [], asking: false };
      threads.set(id, t);
    }
    return t;
  };
  const active = (t: FakeThread): Turn | undefined => t.turns.find((turn) => turn.state === "running" || turn.state === "pending");
  const snapshotOf = (id: string): ThreadSnapshotPayload => {
    const t = thread(id);
    const running = active(t);
    return {
      head: { id, session: { status: running ? "running" : "ready", activeTurnId: running?.turnId ?? null, lastError: null } },
      items: t.items,
      turns: t.turns,
      checkpoints: [],
      pending: { approvals: [], userInputs: t.asking ? [{ requestId: "q1" }] : [] },
      roster: [],
      seq: t.seq
    } as unknown as ThreadSnapshotPayload;
  };
  const touch = (id: string, type = "updated"): void => {
    for (const listener of listeners) listener({ channel: "sessions", type, payload: { id } } as unknown as EventMessage);
  };

  const api: DaemonApi = {
    fsRoot: "/",
    workspacesDir: "/w",
    async request(method, path, opts): Promise<DaemonResponse> {
      const read = /^\/api\/sessions\/([^/]+)\/thread$/.exec(path);
      if (method === "GET" && read) {
        const id = decodeURIComponent(read[1]!);
        if (!sessions.has(id)) return { status: 404, body: null };
        const after = opts?.query?.after;
        if (after !== undefined) {
          const t = thread(id);
          return { status: 200, body: { kind: "events", seq: t.seq, events: t.events.filter((e) => e.seq > Number(after)) } };
        }
        return { status: 200, body: { kind: "snapshot", thread: snapshotOf(id) } };
      }
      const turnPath = /^\/api\/sessions\/([^/]+)\/turn$/.exec(path);
      if (method === "POST" && turnPath) {
        const sessionId = decodeURIComponent(turnPath[1]!);
        const body = opts?.body as Record<string, unknown>;
        const commandId = body.commandId as string;
        const recorded = receipts.get(commandId);
        if (recorded) return recorded;
        if (refuseNext) {
          const refusal = refuseNext;
          refuseNext = null;
          if (refusal.status !== 503) receipts.set(commandId, refusal);
          return refusal;
        }
        const post = { sessionId, body };
        beforePost?.(post);
        posts.push(post);
        const t = thread(sessionId);
        const messageId = `msg-${(ids += 1)}`;
        const running = active(t);
        t.seq += 1;
        t.events.push({ seq: t.seq, type: "thread.message-sent", commandId, payload: { messageId, role: "user", text: body.input, turnId: running?.turnId ?? null } });
        t.items.push({ kind: "message", id: messageId, role: "user", text: body.input as string, turnId: running?.turnId ?? null, streaming: false, createdAt: "t", updatedAt: "t" } as ThreadItem);
        if (!running) {
          t.seq += 1;
          const turnId = `turn-${ids}`;
          t.events.push({ seq: t.seq, type: "thread.turn-start-requested", commandId, payload: { turnId: null, messageId, interactionMode: body.interactionMode ?? "default" } });
          t.turns.push({
            turnId,
            state: "running",
            turnCount: null,
            requestedAt: "t",
            startedAt: "t",
            completedAt: null,
            assistantMessageId: null,
            userMessageId: messageId,
            ...(body.causedBy ? { causedBy: body.causedBy as CausedBy } : {})
          });
        }
        const answer: DaemonResponse = { status: 200, body: { seq: t.seq } };
        receipts.set(commandId, answer);
        return answer;
      }
      return { status: 404, body: null };
    },
    async uploadAttachment() {
      return { status: 503, value: null };
    },
    async publishHtmlRender() {
      return { ok: false, code: "UNAVAILABLE", message: "none" };
    },
    async previewHtmlRender() {
      return { ok: false, code: "UNAVAILABLE", message: "none" };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };

  return {
    api,
    sessions,
    threads,
    posts,
    receipts,
    thread,
    touch,
    listing: { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] },
    onBeforePost(fn: ((post: Post) => void) | null) {
      beforePost = fn;
    },
    refuseNextWith(response: DaemonResponse) {
      refuseNext = response;
    },
    /** Start a turn of the target's own (the user typed): it is busy. */
    userTurn(id: string, turnId = "user-turn"): void {
      const t = thread(id);
      t.seq += 1;
      t.turns.push({ turnId, state: "running", turnCount: null, requestedAt: "t", startedAt: "t", completedAt: null, assistantMessageId: null });
    },
    /** Settle the running turn of `id` with a final reply (or none), and tell the bus. */
    settle(id: string, input: { reply?: string; state?: Turn["state"]; error?: string } = {}): string {
      const t = thread(id);
      const turn = active(t)!;
      turn.state = input.state ?? "completed";
      turn.completedAt = "t";
      if (input.error) turn.errorMessage = input.error;
      if (input.reply !== undefined) {
        t.items.push({ kind: "message", id: `a-${turn.turnId}`, role: "assistant", text: input.reply, turnId: turn.turnId, streaming: false, createdAt: "t", updatedAt: "t" } as ThreadItem);
      }
      t.seq += 1;
      touch(id);
      return turn.turnId!;
    },
    ask(id: string): void {
      thread(id).asking = true;
      touch(id);
    }
  };
}

type Host = ReturnType<typeof fakeHost>;

/** A fake timer the waiter uses: fired by hand. */
function fakeTimers() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (fn: () => void) => {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    fireAll(): void {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    pending: () => timers.size
  };
}

async function world(options: { replyOutbox?: string; mergeOutbox?: string; host?: Host; dir?: string } = {}) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "orq-replies-")));
  const replyFile = join(dir, "agent-reply-outbox.json");
  const mergeFile = join(dir, "agent-merge-outbox.json");
  if (options.replyOutbox !== undefined) await writeFile(replyFile, options.replyOutbox);
  if (options.mergeOutbox !== undefined) await writeFile(mergeFile, options.mergeOutbox);
  const host = options.host ?? fakeHost();
  if (!options.host) {
    host.sessions.set("req", summary("req"));
    host.sessions.set("tgt", summary("tgt"));
    host.thread("req");
    host.thread("tgt");
  }
  let n = 0;
  const timers = fakeTimers();
  const queue = new LineageService({
    sessions: host.listing,
    outboxFile: mergeFile,
    recheckMs: 0,
    newId: () => `m-${(n += 1)}`,
    setPendingMerges: () => undefined
  });
  await queue.load();
  const router = new ReplyRouter({
    outboxFile: replyFile,
    sessions: host.listing,
    queue,
    recheckMs: 0,
    newId: () => `id-${(n += 1)}`,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  await router.load();
  queue.setDeliveryListener(router);
  queue.attachApi(host.api);
  await router.whenReady();
  return {
    dir,
    host,
    queue,
    router,
    timers,
    replyFile,
    mergeFile,
    cleanup: async (remove = true) => {
      await queue.stop();
      if (remove) await rm(dir, { recursive: true, force: true });
    }
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Let every lane, evaluation and write settle. */
async function settled(w: World): Promise<void> {
  const q = w.queue as unknown as { writes: Promise<void>; lanes: Map<string, Promise<unknown>> };
  const r = w.router as unknown as { writes: Promise<void>; evalTail: Map<string, Promise<void>> };
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([...q.lanes.values()]);
    await Promise.all([...r.evalTail.values()]);
    await q.writes;
    await r.writes;
  }
}

const exchange = (hop = 1, exchangeId = "ex-1"): CausedBy => ({ threadId: "req", exchangeId, hop });

const request = (reply: "wait" | "notify", extra: Record<string, unknown> = {}) => ({
  fromThreadId: "req",
  reply,
  input: '[Sent by thread "Implement auth" · session req · jaspersito/orquester]\nAnother agent chat sent this.\n\nReview it.',
  causedBy: exchange(),
  ...extra
});

const postsTo = (host: Host, id: string): Post[] => host.posts.filter((post) => post.sessionId === id);

// ---------------------------------------------------------------------------

describe("reply subscriptions: binding", () => {
  it("persists the subscription BEFORE the message is posted, and binds the turn it caused", async () => {
    const w = await world();
    let seenOnDisk: unknown = null;
    w.host.onBeforePost((post) => {
      if (post.sessionId === "tgt") seenOnDisk = JSON.parse(readFileSync(w.replyFile, "utf8"));
    });
    const res = await w.router.subscribe("tgt", request("notify", { causedBy: exchange(3) }));
    assert.equal(res.delivery, "sent");
    assert.equal(res.commandId, "id-2");
    const disk = seenOnDisk as { subscriptions: Array<{ id: string; state: string; commandId: string }> } | null;
    assert.ok(disk, "the target's /turn came after the write");
    assert.deepEqual(disk.subscriptions.map((s) => [s.id, s.state, s.commandId]), [[res.subscriptionId, "notify", res.commandId]]);
    const post = postsTo(w.host, "tgt")[0]!;
    assert.equal(post.body.commandId, res.commandId, "posted under the subscription's fixed id");
    assert.deepEqual(post.body.causedBy, exchange(3), "the caused turn carries its exchange");
    assert.equal((post.body.context as Array<{ kind: string }>)[0]!.kind, THREAD_MESSAGE_CONTEXT_KIND);
    await settled(w);
    const sub = w.router.subscriptions()[0]! as { turnId?: string; posted?: { messageId?: string } };
    assert.equal(sub.posted?.messageId, "msg-1", "bound by the receipt's events to the user message it opened");
    await w.cleanup();
  });

  it("queues — never steers — a message to a working target, and replies with THAT turn's answer only", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    assert.equal(res.delivery, "queued");
    assert.equal(res.queueEntryId, res.commandId);
    assert.equal(postsTo(w.host, "tgt").length, 0, "no steer into the running turn");
    assert.deepEqual(w.queue.pending().map((p) => [p.kind, p.parentSessionId, p.childSessionId]), [["message", "tgt", "req"]]);

    // The user's own turn ends: its answer is not the reply; the message is posted as the next turn.
    w.host.settle("tgt", { reply: "the user's answer" });
    await settled(w);
    assert.equal(postsTo(w.host, "tgt").length, 1);
    assert.equal(w.router.deliveries().length, 0, "someone else's turn never answers");
    w.host.settle("tgt", { reply: "Three findings." });
    await settled(w);
    const deliveries = w.router.deliveries();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.outcome, "reply");
    assert.equal(parseThreadMessage(deliveries[0]!.input)?.body, "Three findings.");
    const reply = postsTo(w.host, "req")[0]!;
    assert.equal(reply.body.commandId, deliveries[0]!.commandId);
    assert.equal((reply.body.context as Array<{ kind: string }>)[0]!.kind, THREAD_REPLY_CONTEXT_KIND);
    assert.deepEqual(reply.body.causedBy, { threadId: "tgt", exchangeId: "ex-1", hop: 2 }, "a delivery is the next hop");
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    await w.cleanup();
  });

  it("binds through a retried post: the attempt that landed, found by its own command id", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    w.host.settle("tgt", { reply: "user" });
    w.host.refuseNextWith({ status: 409, body: { error: { code: "COMMAND_REJECTED", message: "timed out", detail: { reason: "deadline" } } } });
    await settled(w);
    assert.equal(postsTo(w.host, "tgt").length, 0, "the first attempt was refused");
    // The retry delay is the queue's; act on it directly (Deliver now) to keep the test clock-free.
    await w.queue.actOnMerge("tgt", res.commandId, { action: "deliver" });
    await settled(w);
    const landed = postsTo(w.host, "tgt")[0]!;
    assert.equal(landed.body.commandId, `${res.commandId}:1`, "a retry is a new command id");
    w.host.settle("tgt", { reply: "Bound anyway." });
    await settled(w);
    assert.equal(parseThreadMessage(w.router.deliveries()[0]!.input)?.body, "Bound anyway.");
    await w.cleanup();
  });
});

describe("reply subscriptions: refusals", () => {
  it("a message the idle target refuses for good is taken back: the sender hears it, nothing stays queued", async () => {
    const w = await world();
    w.host.refuseNextWith({ status: 409, body: { error: { code: "COMMAND_REJECTED", message: "session in error" } } });
    await assert.rejects(w.router.subscribe("tgt", request("notify")), (e) => e instanceof ReplyError && e.code === "COMMAND_REJECTED");
    assert.equal(w.queue.pending().length, 0);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    await w.cleanup();
  });
});

describe("reply subscriptions: the waiter and the router (CAS)", () => {
  it("router first: the attached waiter gets the reply, and nothing is delivered", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await settled(w);
    w.host.settle("tgt", { reply: "Done." });
    const answer = await waiting;
    assert.deepEqual(answer, { outcome: "replied", turnId: "turn-1", state: "completed", reply: "Done." });
    await settled(w);
    assert.equal(w.router.deliveries().length, 0);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    // The timer firing late changes nothing.
    w.timers.fireAll();
    await settled(w);
    assert.equal(w.router.deliveries().length, 0);
    await w.cleanup();
  });

  it("timeout first: the waiter returns notify, and the reply is delivered once as a message", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 1 });
    await settled(w);
    w.timers.fireAll();
    assert.deepEqual(await waiting, { outcome: "notify", reason: "timeout", willNotify: true });
    assert.equal(w.router.subscriptions()[0]!.state, "notify");
    w.host.settle("tgt", { reply: "Later." });
    await settled(w);
    w.host.touch("tgt");
    await settled(w);
    assert.equal(w.router.deliveries().length, 1, "exactly one delivery");
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });

  it("the edge: settle and timeout in the same tick — exactly one consumer, either way", async () => {
    for (const order of ["timer-then-router", "router-then-timer"] as const) {
      const w = await world();
      const res = await w.router.subscribe("tgt", request("wait"));
      const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 1 });
      await settled(w);
      if (order === "timer-then-router") {
        w.host.settle("tgt", { reply: "Edge." });
        w.timers.fireAll();
      } else {
        w.host.settle("tgt", { reply: "Edge." });
        // Fire once the router has claimed for the waiter (its persisted CAS), before it resolved.
        for (let i = 0; i < 200 && w.router.subscriptions()[0]!.state === "waiting"; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        w.timers.fireAll();
      }
      const answer = await waiting;
      await settled(w);
      const delivered = w.router.deliveries().length;
      if (answer.outcome === "replied") {
        assert.equal(answer.reply, "Edge.");
        assert.equal(delivered, 0, `${order}: the waiter had it, so no delivery`);
      } else {
        assert.equal(answer.outcome, "notify");
        assert.equal(delivered, 1, `${order}: notify, so exactly one delivery`);
      }
      assert.equal(order === "timer-then-router" ? answer.outcome : "replied", answer.outcome);
      await w.cleanup();
    }
  });

  it("needs-input: the waiter returns early and the subscription stays notify; the reply follows", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await settled(w);
    w.host.ask("tgt");
    assert.deepEqual(await waiting, { outcome: "notify", reason: "needs-input", willNotify: true });
    await settled(w);
    assert.equal(w.router.subscriptions()[0]!.state, "notify");
    w.host.thread("tgt").asking = false;
    w.host.settle("tgt", { reply: "Answered." });
    await settled(w);
    assert.equal(w.router.deliveries().length, 1);
    await w.cleanup();
  });

  it("a wait that would close a cycle is WAIT_CYCLE; only the requester may wait", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const release = registerWait("tgt", "req");
    await assert.rejects(w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 5 }), (e) => e instanceof ReplyError && e.code === "WAIT_CYCLE");
    release();
    await assert.rejects(
      w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 5 }, { principal: { kind: "agent", threadId: "tgt", projectPath: "" } }),
      (e) => e instanceof ReplyError && e.code === "PERMISSION_DENIED"
    );
    await assert.rejects(w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 0 }), (e) => e instanceof ReplyError && e.code === "INVALID_COMMAND");
    await w.cleanup();
  });
});

describe("reply subscriptions: notices", () => {
  it("an empty final reply delivers the §13 d text; a waiter gets emptyReply and no reply", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify"));
    await settled(w);
    w.host.settle("tgt", {});
    await settled(w);
    const input = w.router.deliveries()[0]!.input;
    assert.equal(w.router.deliveries()[0]!.outcome, "empty");
    assert.ok(input.startsWith('[Reply from thread "Codex review" · session tgt · jaspersito/orquester-3]\n'), input);
    assert.equal(parseThreadMessage(input)?.body, replyNoticeText("empty", { title: "Codex review", sessionId: "tgt" }));
    assert.match(input, /"Codex review" finished its turn without a written reply\. Read what it did with read_transcript \{sessionId: "tgt"\}\./);
    await w.cleanup();

    const v = await world();
    const res = await v.router.subscribe("tgt", request("wait"));
    const waiting = v.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await settled(v);
    v.host.settle("tgt", {});
    assert.deepEqual(await waiting, { outcome: "replied", turnId: "turn-1", state: "completed", emptyReply: true });
    await v.cleanup();
  });

  it("a failed or interrupted bound turn delivers its state and error", async () => {
    for (const state of ["failed", "interrupted"] as const) {
      const w = await world();
      await w.router.subscribe("tgt", request("notify"));
      await settled(w);
      w.host.settle("tgt", { state, ...(state === "failed" ? { error: "rate limited" } : {}) });
      await settled(w);
      const delivery = w.router.deliveries()[0]!;
      assert.equal(delivery.outcome, state);
      assert.equal(
        parseThreadMessage(delivery.input)?.body,
        replyNoticeText(state, { title: "Codex review", sessionId: "tgt", ...(state === "failed" ? { error: "rate limited" } : {}) })
      );
      await w.cleanup();
    }
  });

  it("a target closed first delivers 'closed before replying' (a waiter hears closed); a requester closed first drops it", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    w.host.sessions.delete("tgt");
    w.host.touch("tgt", "session.closed");
    await settled(w);
    assert.equal(w.queue.has(res.commandId), false, "the queued message for the closed target is dropped");
    const delivery = w.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "closed");
    assert.equal(parseThreadMessage(delivery.input)?.body, '"Codex review" was closed before replying.');
    await w.cleanup();

    const v = await world();
    const sub = await v.router.subscribe("tgt", request("wait"));
    const waiting = v.router.wait("tgt", sub.subscriptionId, { timeoutSeconds: 60 });
    await settled(v);
    v.host.sessions.delete("tgt");
    v.host.touch("tgt", "session.closed");
    assert.deepEqual(await waiting, { outcome: "closed" });
    await v.cleanup();

    const r = await world();
    await r.router.subscribe("tgt", request("notify"));
    await settled(r);
    r.host.sessions.delete("req");
    r.host.touch("req", "session.closed");
    await settled(r);
    assert.equal(r.router.subscriptions()[0]!.state, "done");
    r.host.settle("tgt", { reply: "nobody reads this" });
    await settled(r);
    assert.equal(r.router.deliveries().length, 0, "the requester is gone: dropped, never delivered");
    await r.cleanup();
  });

  it("a queued message the target's user discards tells the requester; one the requester takes back does not", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    await w.queue.actOnMerge("tgt", res.commandId, { action: "discard" });
    await settled(w);
    const delivery = w.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "failed");
    assert.match(parseThreadMessage(delivery.input)!.body, /discarded from "Codex review"'s queue before it ran/);
    await w.cleanup();

    const v = await world();
    v.host.userTurn("tgt");
    const own = await v.router.subscribe("tgt", request("notify"));
    await v.queue.actOnMerge("req", own.commandId, { action: "discard" });
    await settled(v);
    assert.equal(v.router.deliveries().length, 0);
    assert.equal(v.router.subscriptions()[0]!.state, "done");
    await v.cleanup();
  });
});

describe("reply subscriptions: exchanges and limits", () => {
  it("hop: a message carries its own, a reply the replying turn's + 1; past the cap the delivery says so", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify", { causedBy: exchange(8) }));
    await settled(w);
    assert.deepEqual(postsTo(w.host, "tgt")[0]!.body.causedBy, exchange(8));
    w.host.settle("tgt", { reply: "Last word." });
    await settled(w);
    const delivery = w.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "exchange-limit");
    assert.deepEqual(delivery.causedBy, { threadId: "tgt", exchangeId: "ex-1", hop: 9 }, "past the cap: no tool call from it causes another turn");
    const body = parseThreadMessage(delivery.input)!.body;
    assert.ok(body.startsWith("Last word."));
    assert.ok(body.endsWith(replyNoticeText("exchange-limit", { title: "Codex review", sessionId: "tgt" })));
    await assert.rejects(w.router.subscribe("tgt", request("notify", { causedBy: exchange(9) })), (e) => e instanceof ReplyError && e.code === "EXCHANGE_LIMIT");
    await w.cleanup();
  });

  it("a merge back carries its causedBy, and one past the cap is refused", async () => {
    const w = await world();
    w.host.sessions.set("fork", summary("fork", { lineage: { parentThreadId: "req", relation: "fork", createdAt: "t" } }));
    w.host.thread("fork");
    await w.queue.mergeBack("fork", { text: "B works.", causedBy: { threadId: "fork", exchangeId: "ex-9", hop: 4 } });
    assert.deepEqual(postsTo(w.host, "req")[0]!.body.causedBy, { threadId: "fork", exchangeId: "ex-9", hop: 4 });
    await assert.rejects(w.queue.mergeBack("fork", { text: "x", causedBy: { threadId: "fork", exchangeId: "ex-9", hop: 9 } }), /limit of 8/);
    await w.cleanup();
  });

  it("caps pending subscriptions per requester, honours an idempotency key, and refuses another principal", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const first = await w.router.subscribe("tgt", request("notify", { idempotencyKey: "k1" }));
    const again = await w.router.subscribe("tgt", request("notify", { idempotencyKey: "k1" }));
    assert.equal(again.subscriptionId, first.subscriptionId);
    assert.equal(w.router.subscriptions().length, 1);
    await assert.rejects(
      w.router.subscribe("tgt", request("notify"), { kind: "agent", threadId: "tgt", projectPath: "" }),
      (e) => e instanceof ReplyError && e.code === "PERMISSION_DENIED"
    );
    for (let i = 1; i < 20; i += 1) await w.router.subscribe("tgt", request("notify"));
    await assert.rejects(w.router.subscribe("tgt", request("notify")), (e) => e instanceof ReplyError && e.code === "REPLY_SUBSCRIPTION_LIMIT");
    await w.cleanup();
  });
});

describe("reply subscriptions: restart (§13 e)", () => {
  it("waiting becomes notify on load; a turn that settled while down is delivered exactly once", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    await settled(w);
    await w.cleanup(false);
    // Down: the target's turn ends.
    w.host.settle("tgt", { reply: "While you were away." });
    const again = await world({ host: w.host, dir: w.dir });
    await settled(again);
    const sub = again.router.subscriptions().find((s) => s.id === res.subscriptionId)!;
    assert.equal(sub.state, "done");
    assert.equal(again.router.deliveries().length, 1);
    assert.equal(postsTo(again.host, "req").length, 1, "delivered once");
    await again.cleanup(false);
    // A second restart delivers nothing more.
    const third = await world({ host: w.host, dir: w.dir });
    await settled(third);
    assert.equal(postsTo(third.host, "req").length, 1);
    await third.cleanup();
  });

  it("an open wait survives a restart as notify (no waiter outlives the process)", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    await settled(w);
    await w.cleanup(false);
    const again = await world({ host: w.host, dir: w.dir });
    assert.equal(again.router.subscriptions().find((s) => s.id === res.subscriptionId)!.state, "notify");
    assert.deepEqual(await again.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 5 }), { outcome: "notify", reason: "timeout", willNotify: true });
    await again.cleanup();
  });

  it("a claimed-by-router subscription is resumed, not claimed again: its delivery re-posts under its id and the receipt dedupes", async () => {
    const host = fakeHost();
    host.sessions.set("req", summary("req"));
    host.sessions.set("tgt", summary("tgt"));
    host.thread("req");
    host.thread("tgt");
    // The delivery's first post landed before the crash (the host has its receipt) …
    await host.api.request("POST", "/api/sessions/req/turn", { body: { commandId: "d-1", input: "the reply" } });
    host.settle("req", { reply: "ok" });
    const outbox = {
      version: 1,
      subscriptions: [
        {
          id: "s-1",
          fromThreadId: "req",
          toThreadId: "tgt",
          commandId: "c-1",
          queueEntryId: "c-1",
          state: "claimed-by-router",
          interactionMode: "default",
          exchange: { id: "ex-1", hop: 1 },
          createdAt: "t",
          posted: { commandId: "c-1", seq: 3, messageId: "msg-x" }
        }
      ],
      // … but the crash came before the router recorded it.
      deliveries: [
        {
          id: "d-1",
          subscriptionId: "s-1",
          toThreadId: "req",
          fromThreadId: "tgt",
          commandId: "d-1",
          queueEntryId: "d-1",
          outcome: "reply",
          input: "the reply",
          interactionMode: "default",
          causedBy: { threadId: "tgt", exchangeId: "ex-1", hop: 2 },
          state: "pending",
          createdAt: "t"
        }
      ],
      futureKey: { kept: true }
    };
    const w = await world({ host, replyOutbox: JSON.stringify(outbox) });
    await settled(w);
    assert.equal(postsTo(host, "req").length, 1, "the re-post was answered by the receipt, not a second turn");
    assert.equal(w.router.deliveries().length, 1, "no second delivery");
    assert.equal(w.router.deliveries()[0]!.state, "delivered");
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    const disk = JSON.parse(await readFile(w.replyFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(disk.futureKey, { kept: true }, "unknown top-level keys survive the rewrite");
    await w.cleanup();
  });

  it("a subscription whose message never reached the queue is dropped at boot", async () => {
    const outbox = {
      version: 1,
      subscriptions: [
        { id: "s-9", fromThreadId: "req", toThreadId: "tgt", commandId: "c-9", queueEntryId: "c-9", state: "notify", interactionMode: "default", exchange: { id: "e", hop: 1 }, createdAt: "t" }
      ],
      deliveries: []
    };
    const w = await world({ replyOutbox: JSON.stringify(outbox) });
    await settled(w);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    assert.equal(postsTo(w.host, "tgt").length, 0);
    await w.cleanup();
  });
});
