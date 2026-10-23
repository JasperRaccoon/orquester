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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { EventMessage, SessionSummary } from "@orquester/api";
import {
  nextCausedBy,
  parseThreadMessage,
  replyNoticeText,
  STOP_CASCADED_ACTIVITY_KIND,
  THREAD_MESSAGE_CONTEXT_KIND,
  THREAD_REPLY_CONTEXT_KIND,
  type CausedBy,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type Turn
} from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonResponse } from "../mcp/daemon-api.ts";
import { headFromThreadRead } from "../mcp/testing.ts";
import { DelegateStopCascade } from "./delegates.ts";
import { LineageService } from "./lineage.ts";
import { HELD_AFTER_STOP_TEXT, HISTORY_RETRY_MAX_MS, MAX_REDELIVERY_READS, ReplyError, ReplyRouter, waitResponseOf } from "./replies.ts";
import { registerWait, waitsOn } from "./waits.ts";

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

interface FakeThread {
  seq: number;
  turns: Turn[];
  items: ThreadItem[];
  events: Array<{ seq: number; type: string; commandId: string | null; payload: Record<string, unknown> }>;
  asking: boolean;
  /** Questions the thread asks its user, by request id (what `agentChat.pending` announces). */
  questions: Array<{ requestId: string; question: string }>;
  /** Turns below the snapshot's retained window, served by `GET …/history` only. */
  archived: Turn[];
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
  const interrupts: Post[] = [];
  const receipts = new Map<string, DaemonResponse>();
  const listeners = new Set<(event: EventMessage) => void>();
  let ids = 0;
  /** Called on every accepted `/turn` before it lands (assert what is on disk then). */
  let beforePost: ((post: Post) => void) | null = null;
  /** The next post's refusal, once. */
  let refuseNext: DaemonResponse | null = null;
  /** An older host: `ifIdle` ignored (a busy target is steered). */
  let ignoreIfIdle = false;
  /** Sessions whose user starts a turn just before the next post lands (the idle-check race). */
  const raceOnNextPost = new Set<string>();
  /** Full thread reads (snapshots) per session. */
  const snapshotReads = new Map<string, number>();
  const headReads = new Map<string, number>();
  /** History pages read, and how the index behaves: `endless` never reaches turn 1. */
  let historyReads = 0;
  const historyMode = { endless: false };

  const thread = (id: string): FakeThread => {
    let t = threads.get(id);
    if (!t) {
      t = { seq: 1, turns: [], items: [], events: [], asking: false, questions: [], archived: [] };
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
      pending: {
        approvals: [],
        userInputs: [
          ...(t.asking ? [{ requestId: "q1" }] : []),
          ...t.questions.map((q) => ({
            requestId: q.requestId,
            createdAt: "t",
            dismissible: false,
            questions: [{ id: "answer", header: "Question", question: q.question, options: [] }]
          }))
        ]
      },
      roster: [],
      seq: t.seq,
      ...(t.archived.length > 0
        ? { history: { indexed: true, hasOlder: true, beforeCursor: "older-1", oldestRetainedOrdinal: t.archived.length + 1, totalTurns: t.archived.length + t.turns.length } }
        : {})
    } as unknown as ThreadSnapshotPayload;
  };
  const touch = (id: string, type = "updated"): void => {
    // The summary follows the thread, as the host's poll makes it.
    const tab = sessions.get(id);
    if (tab) {
      const t = thread(id);
      const last = t.turns.at(-1);
      sessions.set(id, {
        ...tab,
        ...(last ? { latestTurn: { turnId: last.turnId, state: last.state } } : {}),
        hasPendingUserInput: t.asking || t.questions.length > 0
      } as SessionSummary);
    }
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
        snapshotReads.set(id, (snapshotReads.get(id) ?? 0) + 1);
        return { status: 200, body: { kind: "snapshot", thread: snapshotOf(id) } };
      }
      const head = /^\/api\/sessions\/([^/]+)\/head$/.exec(path);
      if (method === "GET" && head) {
        const id = decodeURIComponent(head[1]!);
        if (!sessions.has(id)) return { status: 404, body: null };
        headReads.set(id, (headReads.get(id) ?? 0) + 1);
        return headFromThreadRead({ status: 200, body: { kind: "snapshot", thread: snapshotOf(id) } }, opts?.query);
      }
      const history = /^\/api\/sessions\/([^/]+)\/history$/.exec(path);
      if (method === "GET" && history) {
        historyReads += 1;
        const t = thread(decodeURIComponent(history[1]!));
        if (historyMode.endless) {
          return { status: 200, body: { threadId: history[1], turns: [], items: [], checkpoints: [], page: { beforeCursor: "more" }, seq: t.seq } };
        }
        return {
          status: 200,
          body: {
            threadId: history[1],
            turns: t.archived.map((turn, i) => ({
              turnId: turn.turnId,
              ordinal: i + 1,
              userMessageId: turn.userMessageId ?? null,
              requestedAt: "t",
              startedAt: "t",
              completedAt: turn.completedAt,
              rewindable: true
            })),
            items: t.items,
            checkpoints: [],
            page: { beforeCursor: null },
            seq: t.seq
          }
        };
      }
      const interruptPath = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(path);
      if (method === "POST" && interruptPath) {
        // The host's interrupt: the running turn settles `interrupted`; a cascade's cause leaves
        // its `STOP_CASCADED_ACTIVITY_KIND` row on that turn, as the host writes it.
        const sessionId = decodeURIComponent(interruptPath[1]!);
        const body = (opts?.body ?? {}) as Record<string, unknown>;
        interrupts.push({ sessionId, body });
        const t = thread(sessionId);
        const turn = active(t);
        if (turn) {
          if (body.cause !== undefined) {
            t.items.push({ kind: "activity", id: `stop-${turn.turnId}`, activityKind: STOP_CASCADED_ACTIVITY_KIND, tone: "info", summary: "Stopped", payload: body.cause, turnId: turn.turnId, createdAt: "t" } as unknown as ThreadItem);
          }
          turn.state = "interrupted";
          turn.completedAt = "t";
          t.seq += 1;
          touch(sessionId);
        }
        return { status: 200, body: { seq: t.seq } };
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
        if (raceOnNextPost.delete(sessionId)) {
          const raced = thread(sessionId);
          raced.seq += 1;
          raced.turns.push({ turnId: "raced-turn", state: "running", turnCount: null, requestedAt: "t", startedAt: "t", completedAt: null, assistantMessageId: null });
        }
        const t = thread(sessionId);
        if (body.ifIdle === true && !ignoreIfIdle && active(t)) {
          // The host's precondition: refused, NOT recorded (the same id may land later).
          return { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "working" } } };
        }
        const post = { sessionId, body };
        beforePost?.(post);
        posts.push(post);
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
    interrupts,
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
    olderHost() {
      ignoreIfIdle = true;
    },
    raceNextPost(id: string) {
      raceOnNextPost.add(id);
    },
    snapshotReads: (id: string) => snapshotReads.get(id) ?? 0,
    headReads: (id: string) => headReads.get(id) ?? 0,
    historyReads: () => historyReads,
    endlessHistory(): void {
      historyMode.endless = true;
    },
    /** The index reaches turn 1 again (after {@link endlessHistory}). */
    finiteHistory(): void {
      historyMode.endless = false;
    },
    /** Move the target's oldest turns below the snapshot's window (still in the index). */
    archive(id: string, count: number): void {
      const t = thread(id);
      t.archived.push(...t.turns.splice(0, count));
    },
    /** Rewind the target past its latest turn: the turn and its user message are gone. */
    rewindLast(id: string): void {
      const t = thread(id);
      const turn = t.turns.pop();
      if (turn?.userMessageId) t.items = t.items.filter((item) => item.id !== turn.userMessageId);
      t.seq += 1;
      touch(id);
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
    },
    /** `id` asks its user `question` (request `requestId`): the summary moves, then `agentChat.pending` opens it. */
    openQuestion(id: string, requestId: string, question: string): void {
      thread(id).questions.push({ requestId, question });
      touch(id);
      emitPending(id, requestId, question, true);
    },
    /** The user answered: the request closes. */
    answerQuestion(id: string, requestId: string): void {
      const t = thread(id);
      t.questions = t.questions.filter((q) => q.requestId !== requestId);
      touch(id);
      emitPending(id, requestId, "", false);
    },
    /** `agentChat.pending` for a request again (a restarted summary service announces what is open). */
    announce(id: string, requestId: string, open = true): void {
      emitPending(id, requestId, "", open);
    }
  };

  function emitPending(id: string, requestId: string, title: string, open: boolean): void {
    for (const listener of listeners) {
      listener({ channel: "sessions", type: "agentChat.pending", payload: { id, requestId, kind: "question", title, open } } as unknown as EventMessage);
    }
  }
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

async function world(options: { replyOutbox?: string; mergeOutbox?: string; host?: Host; dir?: string; now?: () => Date } = {}) {
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
    ...(options.now ? { now: options.now } : {}),
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

/** Wait until the router and the delivery queue are both idle — each one's work may start the other's. */
async function idle(w: World): Promise<void> {
  do {
    await w.router.whenIdle();
    await w.queue.whenIdle();
  } while (w.router.hasWorkInFlight() || w.queue.hasWorkInFlight());
}

/**
 * Yield to the event loop until `check` holds: an intermediate state of the router's own async
 * steps, which no idle signal can name. Bounded by wall-clock time, not a turn count (a loaded
 * machine needs more turns), and loud when it is never reached.
 */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the awaited state was never reached");
    await new Promise((resolve) => setImmediate(resolve));
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
    await idle(w);
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
    await idle(w);
    assert.equal(postsTo(w.host, "tgt").length, 1);
    assert.equal(w.router.deliveries().length, 0, "someone else's turn never answers");
    w.host.settle("tgt", { reply: "Three findings." });
    await idle(w);
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
    await idle(w);
    assert.equal(postsTo(w.host, "tgt").length, 0, "the first attempt was refused");
    // The retry delay is the queue's; act on it directly (Deliver now) to keep the test clock-free.
    await w.queue.actOnMerge("tgt", res.commandId, { action: "deliver" });
    await idle(w);
    const landed = postsTo(w.host, "tgt")[0]!;
    assert.equal(landed.body.commandId, `${res.commandId}:1`, "a retry is a new command id");
    w.host.settle("tgt", { reply: "Bound anyway." });
    await idle(w);
    assert.equal(parseThreadMessage(w.router.deliveries()[0]!.input)?.body, "Bound anyway.");
    await w.cleanup();
  });
});

describe("reply subscriptions: whenIdle", () => {
  it("resolves once the evaluation a settled turn starts, its delivery and every write are done — no event-loop counting", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify"));
    await w.router.whenIdle();
    await w.queue.whenIdle();
    assert.equal(w.router.hasWorkInFlight() || w.queue.hasWorkInFlight(), false);
    w.host.settle("tgt", { reply: "Found it." });
    assert.equal(w.router.hasWorkInFlight(), true, "the bus event started an evaluation");
    do {
      await w.router.whenIdle();
      await w.queue.whenIdle();
    } while (w.router.hasWorkInFlight() || w.queue.hasWorkInFlight());
    assert.equal(w.router.deliveries().length, 1);
    assert.equal(parseThreadMessage(postsTo(w.host, "req")[0]!.body.input as string)?.body, "Found it.");
    assert.equal(JSON.parse(readFileSync(w.replyFile, "utf8")).subscriptions[0].state, "done", "the last write landed");
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
    await idle(w);
    w.host.settle("tgt", { reply: "Done." });
    const answer = await waiting;
    assert.deepEqual(answer, { outcome: "replied", turnId: "turn-1", state: "completed", reply: "Done." });
    await idle(w);
    assert.equal(w.router.deliveries().length, 0);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    // The timer firing late changes nothing.
    w.timers.fireAll();
    await idle(w);
    assert.equal(w.router.deliveries().length, 0);
    await w.cleanup();
  });

  it("timeout first: the waiter returns notify, and the reply is delivered once as a message", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 1 });
    await idle(w);
    w.timers.fireAll();
    assert.deepEqual(await waiting, { outcome: "notify", reason: "timeout", willNotify: true });
    assert.equal(w.router.subscriptions()[0]!.state, "notify");
    w.host.settle("tgt", { reply: "Later." });
    await idle(w);
    w.host.touch("tgt");
    await idle(w);
    assert.equal(w.router.deliveries().length, 1, "exactly one delivery");
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });

  it("the edge: settle and timeout in the same tick — exactly one consumer, either way", async () => {
    for (const order of ["timer-then-router", "router-then-timer"] as const) {
      const w = await world();
      const res = await w.router.subscribe("tgt", request("wait"));
      const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 1 });
      await idle(w);
      if (order === "timer-then-router") {
        w.host.settle("tgt", { reply: "Edge." });
        w.timers.fireAll();
      } else {
        w.host.settle("tgt", { reply: "Edge." });
        // Fire once the router has claimed for the waiter (its persisted CAS), before it resolved.
        await until(() => w.router.subscriptions()[0]!.state !== "waiting");
        w.timers.fireAll();
      }
      const answer = await waiting;
      await idle(w);
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
    await idle(w);
    w.host.ask("tgt");
    assert.deepEqual(await waiting, { outcome: "notify", reason: "needs-input", willNotify: true });
    await idle(w);
    assert.equal(w.router.subscriptions()[0]!.state, "notify");
    w.host.thread("tgt").asking = false;
    w.host.settle("tgt", { reply: "Answered." });
    await idle(w);
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
    await idle(w);
    w.host.settle("tgt", {});
    await idle(w);
    const input = w.router.deliveries()[0]!.input;
    assert.equal(w.router.deliveries()[0]!.outcome, "empty");
    assert.ok(input.startsWith('[Reply from thread "Codex review" · session tgt · jaspersito/orquester-3]\n'), input);
    assert.equal(parseThreadMessage(input)?.body, replyNoticeText("empty", { title: "Codex review", sessionId: "tgt" }));
    assert.match(input, /"Codex review" finished its turn without a written reply\. Read what it did with read_transcript \{sessionId: "tgt"\}\./);
    await w.cleanup();

    const v = await world();
    const res = await v.router.subscribe("tgt", request("wait"));
    const waiting = v.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(v);
    v.host.settle("tgt", {});
    assert.deepEqual(await waiting, { outcome: "replied", turnId: "turn-1", state: "completed", emptyReply: true });
    await v.cleanup();
  });

  it("a failed or interrupted bound turn delivers its state and error", async () => {
    for (const state of ["failed", "interrupted"] as const) {
      const w = await world();
      await w.router.subscribe("tgt", request("notify"));
      await idle(w);
      w.host.settle("tgt", { state, ...(state === "failed" ? { error: "rate limited" } : {}) });
      await idle(w);
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
    await idle(w);
    assert.equal(w.queue.has(res.commandId), false, "the queued message for the closed target is dropped");
    const delivery = w.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "closed");
    assert.equal(parseThreadMessage(delivery.input)?.body, '"Codex review" was closed before replying.');
    await w.cleanup();

    const v = await world();
    const sub = await v.router.subscribe("tgt", request("wait"));
    const waiting = v.router.wait("tgt", sub.subscriptionId, { timeoutSeconds: 60 });
    await idle(v);
    v.host.sessions.delete("tgt");
    v.host.touch("tgt", "session.closed");
    assert.deepEqual(await waiting, { outcome: "closed" });
    await v.cleanup();

    const r = await world();
    await r.router.subscribe("tgt", request("notify"));
    await idle(r);
    r.host.sessions.delete("req");
    r.host.touch("req", "session.closed");
    await idle(r);
    assert.equal(r.router.subscriptions()[0]!.state, "done");
    r.host.settle("tgt", { reply: "nobody reads this" });
    await idle(r);
    assert.equal(r.router.deliveries().length, 0, "the requester is gone: dropped, never delivered");
    await r.cleanup();
  });

  it("a queued message the target's user discards tells the requester; one the requester takes back does not", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    await w.queue.actOnMerge("tgt", res.commandId, { action: "discard" });
    await idle(w);
    const delivery = w.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "failed");
    assert.match(parseThreadMessage(delivery.input)!.body, /Your message to "Codex review" was discarded from its queue before it ran/);
    await w.cleanup();

    const v = await world();
    v.host.userTurn("tgt");
    const own = await v.router.subscribe("tgt", request("notify"));
    await v.queue.actOnMerge("req", own.commandId, { action: "discard" });
    await idle(v);
    assert.equal(v.router.deliveries().length, 0);
    assert.equal(v.router.subscriptions()[0]!.state, "done");
    await v.cleanup();
  });
});

describe("reply subscriptions: exchanges and limits", () => {
  it("hop: a message carries its own, a reply the replying turn's + 1; past the cap the delivery says so", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify", { causedBy: exchange(8) }));
    await idle(w);
    assert.deepEqual(postsTo(w.host, "tgt")[0]!.body.causedBy, exchange(8));
    w.host.settle("tgt", { reply: "Last word." });
    await idle(w);
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
    await idle(w);
    await w.cleanup(false);
    // Down: the target's turn ends.
    w.host.settle("tgt", { reply: "While you were away." });
    const again = await world({ host: w.host, dir: w.dir });
    await idle(again);
    const sub = again.router.subscriptions().find((s) => s.id === res.subscriptionId)!;
    assert.equal(sub.state, "done");
    assert.equal(again.router.deliveries().length, 1);
    assert.equal(postsTo(again.host, "req").length, 1, "delivered once");
    await again.cleanup(false);
    // A second restart delivers nothing more.
    const third = await world({ host: w.host, dir: w.dir });
    await idle(third);
    assert.equal(postsTo(third.host, "req").length, 1);
    await third.cleanup();
  });

  it("an open wait survives a restart as notify (no waiter outlives the process)", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    await idle(w);
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
    await idle(w);
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
    await idle(w);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    assert.equal(postsTo(w.host, "tgt").length, 0);
    await w.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------


describe("fix round 1: released waiters", () => {
  it("a released waiter is never handed the reply: it is delivered as a message instead", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    // The tool call was cancelled; its inject cannot be aborted, so the tool releases the wait.
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: true, state: "notify" });
    assert.deepEqual(await waiting, { outcome: "notify", reason: "timeout", willNotify: true });
    assert.equal(w.timers.pending(), 0, "its timer is cleared");
    w.host.settle("tgt", { reply: "Here it is." });
    await idle(w);
    assert.equal(w.router.deliveries().length, 1);
    assert.equal(parseThreadMessage(postsTo(w.host, "req")[0]!.body.input as string)?.body, "Here it is.");
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 1, "a delivered reply is never sent twice");
    await w.cleanup();
  });

  it("release racing the router's claim: exactly one consumer — the reply is delivered, never lost", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Raced." });
    // The router has written `claimed-by-waiter` (or is writing it) when the release lands.
    await until(() => w.router.subscriptions()[0]!.state !== "waiting");
    const state = w.router.subscriptions()[0]!.state;
    const released = await w.router.release("tgt", res.subscriptionId);
    const answer = await waiting;
    await idle(w);
    const delivered = w.router.deliveries().length;
    if (state === "claimed-by-waiter") {
      assert.equal(released.released, true);
      assert.equal(answer.outcome, "notify", "the released waiter got nothing");
      assert.equal(delivered, 1, "so the reply was delivered");
    } else {
      // The waiter took it, then its call went away (the release): the reply comes as a message too.
      assert.equal(answer.outcome, "replied");
      assert.equal(delivered, 1);
    }
    assert.equal(postsTo(w.host, "req").length, 1, "exactly one message either way");
    await w.cleanup();
  });

  it("a requester closed while it waits: the wait ends 'closed' and its registration is released", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    assert.equal(waitsOn("req", "tgt"), true);
    w.host.sessions.delete("req");
    w.host.touch("req", "session.closed");
    assert.deepEqual(await waiting, { outcome: "closed" });
    assert.equal(waitsOn("req", "tgt"), false);
    await w.cleanup();
  });
});

describe("fix round 1: never someone else's turn", () => {
  it("Deliver now on a queued message while the target works is refused TARGET_BUSY and stays queued", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    await assert.rejects(w.queue.actOnMerge("tgt", res.commandId, { action: "deliver" }), (e: unknown) => (e as { code?: string }).code === "TARGET_BUSY");
    assert.equal(w.queue.has(res.commandId), true);
    assert.equal(postsTo(w.host, "tgt").length, 0, "never a steer");
    await w.cleanup();
  });

  it("the idle-check race: the host's ifIdle refusal keeps the message queued (no attempt counted), posted at the next idle point", async () => {
    const w = await world();
    w.host.raceNextPost("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    assert.equal(res.delivery, "queued", "the host refused the post: a turn had started");
    assert.equal(postsTo(w.host, "tgt").length, 0);
    assert.equal(w.queue.pending()[0]!.attempts, 0);
    w.host.settle("tgt", { reply: "the user's turn" });
    await idle(w);
    const post = postsTo(w.host, "tgt")[0]!;
    assert.equal(post.body.commandId, res.commandId, "the same id: the refusal was not recorded");
    assert.equal(post.body.ifIdle, true);
    w.host.settle("tgt", { reply: "Mine." });
    await idle(w);
    assert.equal(parseThreadMessage(w.router.deliveries()[0]!.input)?.body, "Mine.");
    await w.cleanup();
  });

  it("an older host steers anyway: the requester gets 'joined a running turn', never that turn's reply", async () => {
    const w = await world();
    w.host.olderHost();
    w.host.raceNextPost("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    assert.equal(res.delivery, "sent");
    await idle(w);
    const delivery = w.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "failed");
    assert.match(parseThreadMessage(delivery.input)!.body, /joined its running turn instead of starting its own/);
    w.host.settle("tgt", { reply: "someone else's answer" });
    await idle(w);
    assert.equal(w.router.deliveries().length, 1, "that turn's reply is never delivered");
    await w.cleanup();
  });
});

describe("fix round 1: crash windows and duplicates", () => {
  it("the claim and its delivery record are one write: on disk together before the reply is posted", async () => {
    const w = await world();
    let disk: { subscriptions: Array<{ state: string }>; deliveries: unknown[] } | null = null;
    w.host.onBeforePost((post) => {
      if (post.sessionId === "req") disk = JSON.parse(readFileSync(w.replyFile, "utf8"));
    });
    w.host.userTurn("req");
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    w.host.settle("tgt", { reply: "x" });
    await idle(w);
    // The requester is busy: the delivery is queued. What is on disk now is what a crash leaves.
    const now = JSON.parse(await readFile(w.replyFile, "utf8")) as { subscriptions: Array<{ state: string }>; deliveries: Array<{ state: string }> };
    assert.equal(now.deliveries.length, 1);
    assert.equal(now.subscriptions[0]!.state, "done");
    w.host.settle("req", {});
    await idle(w);
    assert.ok(disk, "posted");
    assert.equal((disk as { deliveries: unknown[] }).deliveries.length, 1);
    await w.cleanup();
  });

  it("a claimed-by-router subscription with no delivery record (an older build's crash) is delivered once", async () => {
    const host = fakeHost();
    host.sessions.set("req", summary("req"));
    host.sessions.set("tgt", summary("tgt"));
    host.thread("req");
    await host.api.request("POST", "/api/sessions/tgt/turn", { body: { commandId: "c-1", input: "Review", causedBy: exchange() } });
    host.settle("tgt", { reply: "Recovered." });
    const outbox = {
      version: 1,
      subscriptions: [
        { id: "s-1", fromThreadId: "req", toThreadId: "tgt", commandId: "c-1", queueEntryId: "c-1", state: "claimed-by-router", interactionMode: "default", exchange: { id: "ex-1", hop: 1 }, createdAt: "t", posted: { commandId: "c-1", seq: 3, messageId: "msg-1" } }
      ],
      deliveries: []
    };
    const w = await world({ host, replyOutbox: JSON.stringify(outbox) });
    await idle(w);
    assert.equal(w.router.deliveries().length, 1);
    assert.equal(parseThreadMessage(postsTo(host, "req")[0]!.body.input as string)?.body, "Recovered.");
    await w.cleanup();
  });

  it("a pending delivery handed twice at once is queued and posted once", async () => {
    const w = await world();
    w.host.userTurn("req");
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    w.host.settle("tgt", { reply: "once" });
    await idle(w);
    const delivery = w.router.deliveries()[0]!;
    delivery.state = "pending";
    const internals = w.router as unknown as { hand(d: unknown): Promise<void> };
    await Promise.all([internals.hand(delivery), internals.hand(delivery)]);
    w.host.settle("req", {});
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });

  it("a wait that would close a cycle is refused at subscribe, with nothing saved or queued", async () => {
    const w = await world();
    const release = registerWait("tgt", "req");
    await assert.rejects(w.router.subscribe("tgt", request("wait")), (e) => e instanceof ReplyError && e.code === "WAIT_CYCLE");
    release();
    assert.equal(w.router.subscriptions().length, 0);
    assert.equal(w.queue.pending().length, 0);
    assert.equal(postsTo(w.host, "tgt").length, 0);
    await w.cleanup();
  });
});

describe("fix round 1: late waiters, lost turns, quiet events", () => {
  it("a reply that settled before the waiter attached is returned to it (taken back from the queue), not delivered", async () => {
    const w = await world();
    w.host.userTurn("req"); // the requester is in its tool call: busy
    const res = await w.router.subscribe("tgt", request("wait"));
    await idle(w);
    w.host.settle("tgt", { reply: "Early." });
    await idle(w);
    assert.equal(w.router.deliveries()[0]!.state, "queued");
    const answer = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.deepEqual(answer, { outcome: "replied", turnId: "turn-1", state: "completed", reply: "Early." });
    assert.equal(w.queue.pending().length, 0, "taken back");
    w.host.settle("req", {});
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0, "exactly once: the waiter had it");
    await w.cleanup();
  });

  it("a bound turn rewound away ends with a notice and frees the slot", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    w.host.rewindLast("tgt");
    await idle(w);
    const delivery = w.router.deliveries()[0]!;
    assert.match(parseThreadMessage(delivery.input)!.body, /lost track of the turn your message to "Codex review" started/);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    await w.cleanup();
  });

  it("the fallback match needs the message's own text: a reply-none turn of the same hop is never taken", async () => {
    let now = Date.parse("2026-10-15T10:00:00.000Z");
    const w = await world({ now: () => new Date(now) });
    // A `reply: "none"` message of the same exchange and hop is already the target's turn.
    await w.host.api.request("POST", "/api/sessions/tgt/turn", { body: { commandId: "none-1", input: "fire and forget", causedBy: exchange() } });
    w.host.settle("tgt", { reply: "not for the subscription" });
    // The subscription's message landed, but its receipt events could not be read back.
    const outbox = {
      version: 1,
      subscriptions: [
        { id: "s-2", fromThreadId: "req", toThreadId: "tgt", commandId: "c-2", queueEntryId: "c-2", state: "notify", interactionMode: "default", exchange: { id: "ex-1", hop: 1 }, createdAt: new Date(now).toISOString(), posted: { commandId: "c-2", seq: 9, at: new Date(now).toISOString(), inputHash: "0".repeat(32) } }
      ],
      deliveries: []
    };
    await w.cleanup(false);
    const again = await world({ host: w.host, dir: w.dir, replyOutbox: JSON.stringify(outbox), now: () => new Date(now) });
    await idle(again);
    assert.equal(again.router.deliveries().length, 0, "the reply-none turn is not its reply");
    // Unidentified past the grace period: a notice, the slot freed.
    now += 61 * 60 * 1000;
    again.host.touch("tgt", "session.updated-later");
    (again.router as unknown as { seen: Map<string, string> }).seen.clear();
    again.host.touch("tgt");
    await idle(again);
    assert.match(parseThreadMessage(again.router.deliveries()[0]!.input)!.body, /lost track of the turn/);
    await again.cleanup();
  });

  it("a subscription past its maximum age ends with a notice", async () => {
    let now = Date.parse("2026-10-15T10:00:00.000Z");
    const w = await world({ now: () => new Date(now) });
    w.host.userTurn("tgt");
    await w.router.subscribe("tgt", request("notify"));
    now += 8 * 24 * 60 * 60 * 1000;
    w.host.touch("tgt");
    await idle(w);
    assert.match(parseThreadMessage(w.router.deliveries()[0]!.input)!.body, /came within 7 days; Orquester stopped waiting/);
    assert.equal(w.router.subscriptions()[0]!.state, "done");
    await w.cleanup();
  });

  it("a sessions event that moves nothing in the target's summary reads no thread", async () => {
    const w = await world();
    // Posted at once: the bound turn runs, nothing waits in the target's queue.
    await w.router.subscribe("tgt", request("notify"));
    w.host.touch("tgt");
    await idle(w);
    const reads = w.host.snapshotReads("tgt");
    for (let i = 0; i < 5; i += 1) w.host.touch("tgt");
    await idle(w);
    assert.equal(w.host.snapshotReads("tgt"), reads);
    await w.cleanup();
  });
});

describe("fix round 1: exchanges", () => {
  it("merge-back causedBy must name the merging session", async () => {
    const w = await world();
    w.host.sessions.set("fork", summary("fork", { lineage: { parentThreadId: "req", relation: "fork", createdAt: "t" } }));
    w.host.thread("fork");
    await assert.rejects(w.queue.mergeBack("fork", { text: "x", causedBy: { threadId: "req", exchangeId: "e", hop: 2 } }), /causedBy\.threadId/);
    await w.cleanup();
  });

  it("the hop carries on through deliveries and resets only on a user turn", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify", { causedBy: exchange(2) }));
    await idle(w);
    // The target's user speaks after the bound turn started: the delivery still continues the exchange.
    w.host.settle("tgt", { reply: "r1" });
    await idle(w);
    const delivered = postsTo(w.host, "req")[0]!.body.causedBy as CausedBy;
    assert.deepEqual(delivered, { threadId: "tgt", exchangeId: "ex-1", hop: 3 });
    // What the requester's next tool call computes (the executor's rule) from its own turns:
    const reqTurns = w.host.thread("req").turns;
    assert.deepEqual(nextCausedBy({ callerThreadId: "req", running: reqTurns.at(-1)!.causedBy, newExchangeId: "fresh" }), { threadId: "req", exchangeId: "ex-1", hop: 4 });
    w.host.settle("req", {});
    w.host.userTurn("req", "typed-by-user");
    assert.deepEqual(nextCausedBy({ callerThreadId: "req", running: w.host.thread("req").turns.at(-1)!.causedBy, newExchangeId: "fresh" }), { threadId: "req", exchangeId: "fresh", hop: 1 }, "only a user turn starts a new exchange");
    await w.cleanup();
  });

  it("a delivery queued behind the requester's own user turn keeps its causedBy", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify", { causedBy: exchange(4) }));
    await idle(w);
    w.host.userTurn("req", "user-spoke-first");
    w.host.settle("tgt", { reply: "later" });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0, "queued behind the user's turn");
    w.host.settle("req", { reply: "user's answer" });
    await idle(w);
    assert.deepEqual(postsTo(w.host, "req")[0]!.body.causedBy, { threadId: "tgt", exchangeId: "ex-1", hop: 5 });
    await w.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------------

const hash32 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

describe("fix round 2", () => {
  it("a bound turn that left the snapshot's window is looked up in the history, not declared lost", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    // Lazy boot / retention: the bound turn is below the window now, still running.
    w.host.archive("tgt", 1);
    w.host.userTurn("tgt", "newer");
    w.host.touch("tgt");
    await idle(w);
    assert.equal(w.router.deliveries().length, 0, "not lost: the index still has it, unsettled");
    assert.equal(w.router.subscriptions()[0]!.state, "notify");
    // It settles (the index records completion), with its reply.
    const t = w.host.thread("tgt");
    const bound = t.archived[0]!;
    bound.state = "completed";
    bound.completedAt = "t2";
    t.items.push({ kind: "message", id: "a-old", role: "assistant", text: "From the index.", turnId: bound.turnId, streaming: false, createdAt: "t", updatedAt: "t" } as ThreadItem);
    w.host.settle("tgt", { reply: "the newer turn" });
    await idle(w);
    assert.equal(parseThreadMessage(w.router.deliveries()[0]!.input)?.body, "From the index.");
    await w.cleanup();
  });

  it("Deliver now on a message no reply waits for may steer as before (only reply-bound messages are TARGET_BUSY)", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    await w.queue.enqueue({
      mergeId: "plain-1",
      parentSessionId: "tgt",
      childSessionId: "req",
      input: "no reply wanted",
      queuedAt: "t",
      state: "queued",
      attempts: 0,
      kind: "message"
    });
    const res = await w.queue.actOnMerge("tgt", "plain-1", { action: "deliver" });
    assert.equal(res.outcome, "sent");
    const post = postsTo(w.host, "tgt")[0]!;
    assert.equal("ifIdle" in post.body, false, "no precondition for a message no reply is bound to");
    await w.cleanup();
  });

  it("the fallback match compares the trimmed text the host stores", async () => {
    const host = fakeHost();
    host.sessions.set("req", summary("req"));
    host.sessions.set("tgt", summary("tgt"));
    host.thread("req");
    // The host trims the input; the subscription hashed it trimmed too.
    await host.api.request("POST", "/api/sessions/tgt/turn", { body: { commandId: "c-3", input: "Review it.", causedBy: exchange() } });
    host.settle("tgt", { reply: "Matched by text." });
    const outbox = {
      version: 1,
      subscriptions: [
        { id: "s-3", fromThreadId: "req", toThreadId: "tgt", commandId: "c-3", queueEntryId: "c-3", state: "notify", interactionMode: "default", exchange: { id: "ex-1", hop: 1 }, createdAt: new Date().toISOString(), posted: { commandId: "c-3", seq: 3, at: new Date().toISOString(), inputHash: hash32("Review it.") } }
      ],
      deliveries: []
    };
    const w = await world({ host, replyOutbox: JSON.stringify(outbox) });
    await idle(w);
    assert.equal(parseThreadMessage(w.router.deliveries()[0]!.input)?.body, "Matched by text.");
    await w.cleanup();
  });

  it("two resumes of one claimed-by-router subscription at once make one delivery", async () => {
    const host = fakeHost();
    host.sessions.set("req", summary("req"));
    host.sessions.set("tgt", summary("tgt"));
    host.thread("req");
    await host.api.request("POST", "/api/sessions/tgt/turn", { body: { commandId: "c-4", input: "Review", causedBy: exchange() } });
    host.settle("tgt", { reply: "One." });
    const outbox = {
      version: 1,
      subscriptions: [
        { id: "s-4", fromThreadId: "req", toThreadId: "tgt", commandId: "c-4", queueEntryId: "c-4", state: "claimed-by-router", interactionMode: "default", exchange: { id: "ex-1", hop: 1 }, createdAt: "t", posted: { commandId: "c-4", seq: 3, messageId: "msg-1" } }
      ],
      deliveries: []
    };
    const w = await world({ host, replyOutbox: JSON.stringify(outbox) });
    const internals = w.router as unknown as { resumeClaimed(sub: unknown): Promise<void>; claimForRouter(sub: unknown, r: unknown): Promise<() => Promise<void>> };
    const sub = w.router.subscriptions()[0]!;
    await Promise.all([internals.resumeClaimed(sub), internals.resumeClaimed(sub)]);
    // Even two direct claims (different callers) never make a second record.
    await internals.claimForRouter(sub, { kind: "turn", turnId: "turn-1", state: "completed", reply: "One." });
    await idle(w);
    assert.equal(w.router.deliveries().length, 1);
    assert.equal(postsTo(host, "req").length, 1);
    await w.cleanup();
  });

  it("a second wait after a take-back answers truthfully: the same reply, and no message follows", async () => {
    const w = await world();
    w.host.userTurn("req");
    const res = await w.router.subscribe("tgt", request("wait"));
    await idle(w);
    w.host.settle("tgt", { reply: "Early." });
    await idle(w);
    assert.equal((await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 })).outcome, "replied");
    const again = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.deepEqual(again, { outcome: "replied", turnId: "turn-1", state: "completed", reply: "Early." });
    w.host.settle("req", {});
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0);
    await w.cleanup();
  });

  it("a take-back whose queue write fails leaves the reply queued, delivered without a restart", async () => {
    const w = await world();
    w.host.userTurn("req");
    const res = await w.router.subscribe("tgt", request("wait"));
    await idle(w);
    w.host.settle("tgt", { reply: "Kept." });
    await idle(w);
    const delivery = w.router.deliveries()[0]!;
    // The merge outbox cannot be written now.
    await rm(w.mergeFile, { force: true });
    await mkdir(join(w.mergeFile, "blocked"), { recursive: true });
    assert.equal(await w.queue.retract(delivery.queueEntryId!), false);
    assert.equal(w.queue.has(delivery.queueEntryId!), true, "restored in memory");
    // So the late waiter is told it comes as a message — and it does.
    assert.deepEqual(await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 }), { outcome: "notify", reason: "timeout", willNotify: true });
    await rm(w.mergeFile, { recursive: true, force: true });
    w.host.settle("req", {});
    await idle(w);
    assert.equal(parseThreadMessage(postsTo(w.host, "req")[0]!.body.input as string)?.body, "Kept.");
    await w.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Fix round 3
// ---------------------------------------------------------------------------

/** A settled turn of the target's own at a given time (the window's turns carry real times). */
function oldTurn(host: Host, id: string, turnId: string, requestedAt: string): void {
  host.thread(id).turns.push({ turnId, state: "completed", turnCount: null, requestedAt, startedAt: requestedAt, completedAt: requestedAt, assistantMessageId: null });
}

describe("fix round 3", () => {
  it("a bound turn posted after the window's oldest turn and missing from it is lost at once — no history read", async () => {
    const now = Date.parse("2026-10-15T10:00:00.000Z");
    const w = await world({ now: () => new Date(now) });
    oldTurn(w.host, "tgt", "older", "2026-10-15T08:00:00.000Z");
    oldTurn(w.host, "tgt", "in-window", "2026-10-15T09:00:00.000Z");
    w.host.archive("tgt", 1); // the window now starts at 09:00 and has older history below it
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    w.host.rewindLast("tgt");
    await idle(w);
    assert.match(parseThreadMessage(w.router.deliveries()[0]!.input)!.body, /lost track of the turn/);
    assert.equal(w.host.historyReads(), 0);
    await w.cleanup();
  });

  it("an inconclusive history lookup backs off instead of re-reading pages on every look", async () => {
    let now = Date.parse("2026-10-15T10:00:00.000Z");
    const host = fakeHost();
    host.sessions.set("req", summary("req"));
    host.sessions.set("tgt", summary("tgt"));
    host.thread("req");
    oldTurn(host, "tgt", "below", "2026-10-15T07:00:00.000Z");
    oldTurn(host, "tgt", "window", "2026-10-15T09:30:00.000Z");
    host.archive("tgt", 1);
    host.endlessHistory();
    // Posted BEFORE the window's oldest turn: its turn may be anywhere below — not conclusive.
    const outbox = {
      version: 1,
      subscriptions: [
        { id: "s-5", fromThreadId: "req", toThreadId: "tgt", commandId: "c-5", queueEntryId: "c-5", state: "notify", interactionMode: "default", exchange: { id: "ex-1", hop: 1 }, createdAt: "2026-10-15T09:00:00.000Z", posted: { commandId: "c-5", seq: 2, at: "2026-10-15T09:00:00.000Z", messageId: "msg-far-below" } }
      ],
      deliveries: []
    };
    const w = await world({ host, replyOutbox: JSON.stringify(outbox), now: () => new Date(now) });
    await idle(w);
    assert.equal(host.historyReads(), 5, "one lookup: five pages, no answer");
    const look = async (): Promise<void> => {
      (w.router as unknown as { seen: Map<string, string> }).seen.clear();
      host.touch("tgt");
      await idle(w);
    };
    await look();
    assert.equal(host.historyReads(), 5, "within the backoff: no history read");
    now += 61_000;
    await look();
    assert.equal(host.historyReads(), 10, "after it: one more lookup");
    now += 61_000;
    await look();
    assert.equal(host.historyReads(), 10, "the delay doubled (2 min)");
    assert.equal(w.router.deliveries().length, 0, "never declared lost while inconclusive");
    await w.cleanup();
  });

  it("expiry drops the still-queued message: it never runs after the requester was told no reply comes", async () => {
    let now = Date.parse("2026-10-15T10:00:00.000Z");
    const w = await world({ now: () => new Date(now) });
    w.host.userTurn("tgt");
    const res = await w.router.subscribe("tgt", request("notify"));
    assert.equal(w.queue.has(res.commandId), true);
    now += 8 * 24 * 60 * 60 * 1000;
    w.host.touch("tgt");
    await idle(w);
    assert.match(parseThreadMessage(w.router.deliveries()[0]!.input)!.body, /stopped waiting/);
    assert.equal(w.queue.has(res.commandId), false, "the queued message is dropped");
    w.host.settle("tgt", { reply: "the user's turn" });
    await idle(w);
    assert.equal(postsTo(w.host, "tgt").length, 0, "never delivered afterwards");
    await w.cleanup();
  });
});

describe("Task 8 fix round 1: the release tombstone", () => {
  it("a release before the waiter attached: the late wait answers notify at once, and the reply is a message — never claimed-by-waiter", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "notify" });
    assert.deepEqual(await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 }), { outcome: "notify", reason: "timeout", willNotify: true });
    assert.equal(w.timers.pending(), 0, "the late wait never attached");
    w.host.settle("tgt", { reply: "As a message." });
    await idle(w);
    const sub = w.router.subscriptions()[0]! as { state: string; ended?: string; released?: true };
    assert.equal(sub.released, true, "the tombstone is persisted with the record");
    assert.equal(sub.ended, "delivered");
    assert.equal(parseThreadMessage(postsTo(w.host, "req")[0]!.body.input as string)?.body, "As a message.");
    await w.cleanup();
  });

  it("a reply the waiter took, whose call never got it (released after): re-delivered as a message, once", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Took it." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0, "the waiter had it");
    // The provider dropped the tool result (`delivered` false): the tool releases.
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: true, state: "done" });
    await idle(w);
    assert.equal(parseThreadMessage(postsTo(w.host, "req")[0]!.body.input as string)?.body, "Took it.");
    await w.router.release("tgt", res.subscriptionId);
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 1, "never twice");
    await w.cleanup();
  });

  it("a reply taken back from the queue for a late waiter, then released: put back and delivered", async () => {
    const w = await world();
    w.host.userTurn("req");
    const res = await w.router.subscribe("tgt", request("wait"));
    w.host.settle("tgt", { reply: "Taken back." });
    await idle(w);
    // The requester is busy: the reply waits in its queue; a late waiter takes it back (D-4).
    assert.equal((await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 })).outcome, "replied");
    assert.equal(w.queue.pending().filter((entry) => entry.kind === "reply").length, 0);
    await w.router.release("tgt", res.subscriptionId);
    await idle(w);
    assert.equal(w.queue.pending().filter((entry) => entry.kind === "reply").length, 1, "queued again for the requester");
    w.host.settle("req", { reply: "user turn done" });
    await idle(w);
    assert.equal(parseThreadMessage(postsTo(w.host, "req").at(-1)!.body.input as string)?.body, "Taken back.");
    await w.cleanup();
  });
});

describe("Task 8 fix round 2: re-delivery after a release", () => {
  it("the tombstone and the re-delivery are one write: a crash before the hand is delivered once by the restarted router", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Survives a crash." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    // The queue refuses the hand (the process dies right after the release's write).
    const queue = w.queue as unknown as { enqueue: (...args: unknown[]) => Promise<unknown> };
    const enqueue = queue.enqueue.bind(w.queue);
    queue.enqueue = async () => { throw new Error("crashed"); };
    await w.router.release("tgt", res.subscriptionId);
    const disk = JSON.parse(await readFile(w.replyFile, "utf8")) as { subscriptions: { id: string; released?: true }[]; deliveries: { subscriptionId: string; state: string }[] };
    assert.equal(disk.subscriptions.find((sub) => sub.id === res.subscriptionId)?.released, true);
    assert.deepEqual(disk.deliveries.map((d) => [d.subscriptionId, d.state]), [[res.subscriptionId, "pending"]], "written with the tombstone");
    queue.enqueue = enqueue;
    await w.cleanup(false);
    const again = await world({ dir: w.dir, host: w.host });
    await idle(again);
    assert.equal(parseThreadMessage(postsTo(again.host, "req")[0]!.body.input as string)?.body, "Survives a crash.");
    await again.router.release("tgt", res.subscriptionId);
    await idle(again);
    assert.equal(postsTo(again.host, "req").length, 1, "exactly once");
    await again.cleanup();
  });

  it("a reply that cannot be read again is recorded: a later wait says so truthfully, never willNotify", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Gone soon." });
    assert.equal((await waiting).outcome, "replied");
    w.host.rewindLast("tgt");
    await idle(w);
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    // Retried by the safety re-check, a bounded number of reads, before it is given up.
    assert.deepEqual(await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 }), { outcome: "notify", reason: "timeout", willNotify: true }, "still being retried");
    for (let read = 1; read < MAX_REDELIVERY_READS; read += 1) await w.router.recheckNow();
    assert.equal((w.router.subscriptions()[0] as { unreadable?: true }).unreadable, true);
    const later = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.equal(later.outcome, "replied");
    assert.ok(later.outcome === "replied" && later.state === "failed" && /no message will follow/.test(later.error ?? ""));
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0);
    await w.cleanup();
  });

  it("a waiter released while its take-back reads the reply never receives it: the reply stays a message", async () => {
    const w = await world();
    w.host.userTurn("req");
    const res = await w.router.subscribe("tgt", request("wait"));
    w.host.settle("tgt", { reply: "Not for a cancelled call." });
    await idle(w);
    assert.equal(w.queue.pending().filter((entry) => entry.kind === "reply").length, 1);
    // The take-back's thread read is where the cancel lands.
    const api = w.host.api as { request: typeof w.host.api.request };
    const read = api.request.bind(w.host.api);
    let released: Promise<unknown> | null = null;
    api.request = async (method, path, opts) => {
      if (released === null && method === "GET" && path === "/api/sessions/tgt/thread" && opts?.query?.after === undefined) {
        released = w.router.release("tgt", res.subscriptionId);
      }
      return read(method, path, opts);
    };
    const answer = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await released;
    api.request = read;
    assert.equal(answer.outcome, "notify", "a cancelled waiter gets nothing");
    w.host.settle("req", { reply: "user turn done" });
    await idle(w);
    assert.equal(parseThreadMessage(postsTo(w.host, "req").at(-1)!.body.input as string)?.body, "Not for a cancelled call.");
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });

  it("a host re-sending the same call gets the reply again; the first call's lost result then delivers nothing — exactly one holder delivers", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait", { idempotencyKey: "call-1" }));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Once." });
    assert.equal((await waiting).outcome, "replied");
    // The host restarts and re-sends the call: the same subscription answers it again.
    const resent = await w.router.subscribe("tgt", request("wait", { idempotencyKey: "call-1" }));
    assert.equal(resent.subscriptionId, res.subscriptionId);
    const second = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.ok(second.outcome === "replied" && second.reply === "Once.");
    // The first call's result never reached the provider: its release finds another holder.
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0, "the re-sent call holds the reply");
    // Had the re-sent call's result been lost too, the reply goes out once.
    await w.router.release("tgt", res.subscriptionId);
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });
});

describe("Task 8 follow-up: re-delivery edges", () => {
  it("a release that lands while a re-sent call's answer is read: that call answers notify, and one message goes out", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait", { idempotencyKey: "call-2" }));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Raced again." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    // The re-sent call's wait reads the reply again; the first call's release lands during that read.
    const api = w.host.api as { request: typeof w.host.api.request };
    const read = api.request.bind(w.host.api);
    let released: Promise<unknown> | null = null;
    api.request = async (method, path, opts) => {
      if (released === null && method === "GET" && path === "/api/sessions/tgt/thread" && opts?.query?.after === undefined) {
        released = w.router.release("tgt", res.subscriptionId);
        await released;
      }
      return read(method, path, opts);
    };
    await w.router.subscribe("tgt", request("wait", { idempotencyKey: "call-2" }));
    const answer = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    api.request = read;
    assert.deepEqual(answer, { outcome: "notify", reason: "timeout", willNotify: true });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 1, "the reply is a message, once");
    await w.cleanup();
  });

  it("a transient read failure is retried by the safety re-check, and the reply is then delivered once", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Read on the retry." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    const api = w.host.api as { request: typeof w.host.api.request };
    const read = api.request.bind(w.host.api);
    let failing = true;
    api.request = async (method, path, opts) => {
      if (failing && method === "GET" && path === "/api/sessions/tgt/thread") return { status: 503, body: null };
      return read(method, path, opts);
    };
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0);
    assert.equal((w.router.subscriptions()[0] as { unreadable?: true }).unreadable, undefined, "not given up after one failed read");
    failing = false;
    api.request = read;
    await w.router.recheckNow();
    await idle(w);
    assert.equal(parseThreadMessage(postsTo(w.host, "req")[0]!.body.input as string)?.body, "Read on the retry.");
    await w.router.recheckNow();
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });

  it("after a daemon restart the old holder's call is gone: a re-sent call's lost result still delivers exactly once", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait", { idempotencyKey: "call-3" }));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "After the restart." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    // The daemon restarts: the first call died with it, and its release never comes.
    await w.cleanup(false);
    const again = await world({ dir: w.dir, host: w.host });
    const sub = again.router.subscriptions()[0] as { handOuts?: number; lostHandOuts?: number };
    assert.deepEqual([sub.handOuts, sub.lostHandOuts], [0, 0], "holders are counted afresh");
    await again.router.subscribe("tgt", request("wait", { idempotencyKey: "call-3" }));
    const answer = await again.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.ok(answer.outcome === "replied" && answer.reply === "After the restart.");
    // The re-sent call's result is lost too: its release delivers the reply as a message, once.
    assert.equal((await again.router.release("tgt", res.subscriptionId)).released, true);
    await idle(again);
    assert.equal(postsTo(again.host, "req").length, 1);
    await again.router.release("tgt", res.subscriptionId);
    await idle(again);
    assert.equal(postsTo(again.host, "req").length, 1);
    await again.cleanup();
  });
});

describe("final fix wave: re-delivery reads and closed targets", () => {
  it("a look skipped while the history lookup backs off is no failed read: only lookups that ran count toward giving up", async () => {
    let now = Date.parse("2026-10-15T00:00:00.000Z");
    const w = await world({ now: () => new Date(now) });
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Below the window." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    // The bound turn leaves the retained window, and the history index never reaches it.
    w.host.archive("tgt", 1);
    w.host.endlessHistory();
    const sub = () => w.router.subscriptions()[0] as { rereads?: number; unreadable?: true };
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    assert.equal(sub().rereads, 1, "the first lookup ran and failed");
    const historyReads = w.host.historyReads();
    for (let check = 0; check < MAX_REDELIVERY_READS + 2; check += 1) await w.router.recheckNow();
    assert.equal(w.host.historyReads(), historyReads, "backing off: no lookup ran");
    assert.equal(sub().rereads, 1, "so none was counted");
    assert.equal(sub().unreadable, undefined, "and the reply is not given up");
    // Each time the back-off has passed, a lookup runs and counts — given up after the last one.
    for (let read = 2; read <= MAX_REDELIVERY_READS; read += 1) {
      now += HISTORY_RETRY_MAX_MS;
      await w.router.recheckNow();
      assert.equal(sub().rereads, read);
    }
    assert.ok(w.host.historyReads() > historyReads);
    assert.equal(sub().unreadable, true);
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0);
    await w.cleanup();
  });

  it("a target closed after its reply was taken: a re-sent call and the re-delivery still carry the reply text", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait", { idempotencyKey: "call-c" }));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Still yours." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    w.host.sessions.delete("tgt");
    w.host.touch("tgt", "session.closed");
    await idle(w);
    // A second wait on the taken reply (a re-sent call) is answered with the reply again, not "closed".
    const again = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.ok(again.outcome === "replied" && again.reply === "Still yours.", JSON.stringify(again));
    // Both calls' results were lost: the reply goes out once, as the reply.
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: true, state: "done" });
    await idle(w);
    const deliveries = w.router.deliveries();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.outcome, "reply");
    assert.equal(parseThreadMessage(deliveries[0]!.input)?.body, "Still yours.");
    assert.equal(postsTo(w.host, "req").length, 1);
    await w.cleanup();
  });

  it("a target closed after replying whose reply can no longer be read: the notice says it replied, never 'closed before replying'", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Lost with the process." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    // A restart forgets the reply it handed out; the target is closed meanwhile.
    await w.cleanup(false);
    w.host.sessions.delete("tgt");
    const again = await world({ dir: w.dir, host: w.host });
    assert.equal((await again.router.release("tgt", res.subscriptionId)).released, true);
    await idle(again);
    const delivery = again.router.deliveries()[0]!;
    assert.equal(delivery.outcome, "closed");
    const body = parseThreadMessage(delivery.input)?.body ?? "";
    assert.equal(body, replyNoticeText("closed-after-reply", { title: "Codex review", sessionId: "tgt" }));
    assert.doesNotMatch(body, /closed before replying/);
    assert.equal(postsTo(again.host, "req").length, 1);
    await again.cleanup();
  });
});

describe("final fix wave follow-up: deferred releases and closed-after-reply answers", () => {
  it("a release that lands while the history lookup backs off is saved: after a restart the reply is re-delivered exactly once", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Survives the back-off." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    // The turn leaves the window and the index never reaches it: a second wait's lookup is
    // inconclusive and starts the back-off (it hands nothing out).
    w.host.archive("tgt", 1);
    w.host.endlessHistory();
    const second = await w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.ok(second.outcome === "replied" && second.state === "failed", JSON.stringify(second));
    const historyReads = w.host.historyReads();
    // The call's result was lost: the release lands while the lookup backs off (no read runs).
    assert.deepEqual(await w.router.release("tgt", res.subscriptionId), { released: false, state: "done" });
    assert.equal(w.host.historyReads(), historyReads, "no lookup ran");
    await idle(w);
    const disk = JSON.parse(await readFile(w.replyFile, "utf8")) as { subscriptions: { id: string; released?: true; lostHandOuts?: number; rereads?: number }[] };
    const saved = disk.subscriptions.find((sub) => sub.id === res.subscriptionId)!;
    assert.equal(saved.released, true, "the tombstone is on disk");
    assert.equal(saved.lostHandOuts, 1);
    assert.equal(saved.rereads, undefined, "and no read was counted");
    // The daemon restarts; the index is whole again.
    await w.cleanup(false);
    w.host.finiteHistory();
    const again = await world({ dir: w.dir, host: w.host });
    await idle(again);
    assert.equal(parseThreadMessage(postsTo(again.host, "req")[0]!.body.input as string)?.body, "Survives the back-off.");
    await again.router.recheckNow();
    await again.router.release("tgt", res.subscriptionId);
    await idle(again);
    assert.equal(postsTo(again.host, "req").length, 1, "exactly once");
    await again.cleanup();
  });

  it("a wait on a taken reply whose target closed and whose reply is gone: a truthful failed answer, never a hand-out", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    w.host.settle("tgt", { reply: "Gone with the restart." });
    assert.equal((await waiting).outcome, "replied");
    await idle(w);
    await w.cleanup(false);
    w.host.sessions.delete("tgt");
    const again = await world({ dir: w.dir, host: w.host });
    const answer = await again.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    assert.deepEqual(answer, {
      outcome: "replied",
      turnId: "turn-1",
      state: "failed",
      error: replyNoticeText("closed-after-reply", { title: "Codex review", sessionId: "tgt" })
    });
    const sub = again.router.subscriptions()[0] as { handOuts?: number };
    assert.equal(sub.handOuts, 0, "nobody holds the reply: not a hand-out");
    // So the call's release is the last holder gone: the requester hears it once, as the notice.
    assert.equal((await again.router.release("tgt", res.subscriptionId)).released, true);
    await idle(again);
    assert.equal(again.router.deliveries()[0]!.outcome, "closed");
    assert.equal(postsTo(again.host, "req").length, 1);
    await again.cleanup();
  });

  it("waitResponseOf: closed after replying is a failed answer saying so, never outcome closed", () => {
    const answer = waitResponseOf({ kind: "closed", afterReply: true });
    assert.equal(answer.outcome, "replied");
    assert.ok(answer.outcome === "replied" && answer.state === "failed" && /replied, then was closed/.test(answer.error ?? ""));
    assert.deepEqual(waitResponseOf({ kind: "closed" }), { outcome: "closed" });
  });
});

describe("head-only re-checks (follow-up: head reads)", () => {
  it("a re-check with every message still queued reads nothing", async () => {
    const w = await world();
    w.host.userTurn("tgt");
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    assert.equal(w.router.subscriptions()[0]!.posted, undefined, "queued behind the user's turn");
    const heads = w.host.headReads("tgt");
    const snapshots = w.host.snapshotReads("tgt");
    w.host.ask("tgt");
    await idle(w);
    // One head read: the delivery queue's own idle check of the target. The router reads nothing.
    assert.equal(w.host.headReads("tgt"), heads + 1);
    assert.equal(w.host.snapshotReads("tgt"), snapshots);
    await w.cleanup();
  });

  it("while the bound turn runs, the router's re-check and a wait's attach read the target's head, never its snapshot", async () => {
    const w = await world();
    const res = await w.router.subscribe("tgt", request("wait"));
    const waiting = w.router.wait("tgt", res.subscriptionId, { timeoutSeconds: 60 });
    await idle(w);
    const snapshots = w.host.snapshotReads("tgt");
    const heads = w.host.headReads("tgt");
    // The summary moves (a question opens): the router looks, and the head alone decides.
    w.host.ask("tgt");
    assert.deepEqual(await waiting, { outcome: "notify", reason: "needs-input", willNotify: true });
    await idle(w);
    assert.ok(w.host.headReads("tgt") > heads, "the head was read");
    assert.equal(w.host.snapshotReads("tgt"), snapshots, "no snapshot while the bound turn runs");
    // Once the turn settles, its reply is read whole from the snapshot and delivered once.
    w.host.thread("tgt").asking = false;
    w.host.settle("tgt", { reply: "Answered." });
    await idle(w);
    assert.equal(w.router.deliveries().length, 1);
    assert.ok(w.host.snapshotReads("tgt") > snapshots);
    await w.cleanup();
  });
});

// ---------------------------------------------------------------------------
// A delegated child blocked on its user wakes its parent
// ---------------------------------------------------------------------------

describe("attention: a delegated child's question wakes its parent", () => {
  /** `tgt` is a task `req` delegated (lineage `delegate`), sent with reply "notify". */
  async function delegated(options: { hop?: number } = {}) {
    const w = await world();
    w.host.sessions.set("tgt", summary("tgt", { lineage: { parentThreadId: "req", relation: "delegate", createdAt: "t", agentCreated: true } }));
    await w.router.subscribe("tgt", request("notify", { origin: "delegated", causedBy: exchange(options.hop ?? 1) }));
    await idle(w);
    assert.equal(postsTo(w.host, "tgt").length, 1, "the task is running");
    return w;
  }
  const notices = (host: Host) => postsTo(host, "req").filter((post) => parseThreadMessage(post.body.input as string)?.origin === "attention");

  it("delivers one short notice naming the child, quoting the question and saying how to answer — once per request id", async () => {
    const w = await delegated();
    w.host.openQuestion("tgt", "q-7", "Which database should the cache use?");
    await idle(w);
    const sent = notices(w.host);
    assert.equal(sent.length, 1);
    const parsed = parseThreadMessage(sent[0]!.body.input as string)!;
    assert.equal(parsed.fromTitle, "Codex review");
    assert.equal(parsed.fromSessionId, "tgt");
    assert.match(parsed.body, /"Codex review" is blocked: it asked its user "Which database should the cache use\?"/);
    assert.match(parsed.body, /respond_to_request \{sessionId: "tgt", requestId: "q-7"/);
    assert.match(parsed.body, /ask your user/);
    assert.equal((sent[0]!.body.context as Array<{ kind: string; ref?: string }>)[0]!.kind, THREAD_MESSAGE_CONTEXT_KIND);
    assert.deepEqual(sent[0]!.body.causedBy, { threadId: "tgt", exchangeId: "ex-1", hop: 2 }, "the hop after the child's turn");
    assert.equal(sent[0]!.body.ifIdle, true, "a turn of its own, never a steer");

    // The same request announced again (another poll, a re-check): nothing more.
    w.host.announce("tgt", "q-7");
    await w.router.recheckNow();
    await idle(w);
    assert.equal(notices(w.host).length, 1);

    // The user answers; a new question is a new notice. (The parent finishes the turn the first
    // notice started, as it would.)
    w.host.settle("req", { reply: "Asked my user." });
    w.host.answerQuestion("tgt", "q-7");
    w.host.openQuestion("tgt", "q-8", "May I drop the old table?");
    await idle(w);
    assert.equal(notices(w.host).length, 2);
    assert.match(parseThreadMessage(notices(w.host)[1]!.body.input as string)!.body, /May I drop the old table\?/);
    await w.cleanup();
  });

  it("queues the notice while the parent is mid-turn (never lost, never steered), and takes it back if the user answers first", async () => {
    const w = await delegated();
    w.host.userTurn("req", "parent-turn");
    w.host.openQuestion("tgt", "q-1", "Proceed?");
    await idle(w);
    assert.equal(notices(w.host).length, 0, "not steered into the running turn");
    assert.deepEqual(
      w.queue.pending().map((p) => [p.kind, p.parentSessionId, p.childSessionId]),
      [["reply", "req", "tgt"]]
    );
    w.host.settle("req", { reply: "done" });
    await idle(w);
    assert.equal(notices(w.host).length, 1, "delivered at the parent's next idle point");

    // Busy again; a question the user answers before the parent is free never wakes it.
    w.host.settle("req", { reply: "ok" });
    w.host.userTurn("req", "parent-turn-2");
    w.host.openQuestion("tgt", "q-2", "And this?");
    await idle(w);
    assert.equal(w.queue.pending().length, 1);
    w.host.answerQuestion("tgt", "q-2");
    await idle(w);
    assert.equal(w.queue.pending().length, 0, "taken back from the queue");
    w.host.settle("req", { reply: "ok" });
    await idle(w);
    assert.equal(notices(w.host).length, 1, "the answered question's notice never posted");
    await w.cleanup();
  });

  it("survives a restart through the outbox: a queued notice is delivered once, and an announced request is not noticed twice", async () => {
    const w = await delegated();
    w.host.userTurn("req", "parent-turn");
    w.host.openQuestion("tgt", "q-1", "Proceed?");
    await idle(w);
    await w.cleanup(false);
    const disk = JSON.parse(await readFile(w.replyFile, "utf8")) as { attentionNotices?: Array<{ requestId: string; state: string }> };
    assert.deepEqual(disk.attentionNotices?.map((n) => [n.requestId, n.state]), [["q-1", "queued"]]);

    const again = await world({ host: w.host, dir: w.dir });
    // A restarted summary service announces every open request afresh.
    w.host.announce("tgt", "q-1");
    await idle(again);
    w.host.settle("req", { reply: "done" });
    await idle(again);
    assert.equal(notices(w.host).length, 1);
    await again.cleanup();
  });

  it("re-hands a notice whose queue write never landed (a crash between the two writes), under the same id", async () => {
    const w = await delegated();
    w.host.userTurn("req", "parent-turn");
    w.host.openQuestion("tgt", "q-1", "Proceed?");
    await idle(w);
    await w.cleanup(false);
    // The delivery queue lost its entry; the reply outbox still says `queued`.
    const merge = JSON.parse(await readFile(w.mergeFile, "utf8")) as { entries: unknown[] };
    await writeFile(w.mergeFile, JSON.stringify({ ...merge, entries: [] }));
    const again = await world({ host: w.host, dir: w.dir });
    await idle(again);
    assert.equal(again.queue.pending().length, 1, "handed to the queue again");
    w.host.settle("req", { reply: "done" });
    await idle(again);
    assert.equal(notices(w.host).length, 1);
    await again.cleanup();
  });

  it("respects the exchange-hop cap: past it the notice says so and causes nothing further", async () => {
    const w = await delegated({ hop: 8 });
    w.host.openQuestion("tgt", "q-1", "Proceed?");
    await idle(w);
    const sent = notices(w.host);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.body.causedBy, { threadId: "tgt", exchangeId: "ex-1", hop: 9 });
    assert.match(parseThreadMessage(sent[0]!.body.input as string)!.body, /reached its limit of 8 agent-caused turns/);
    await w.cleanup();
  });

  it("wakes nobody for a chat that is no delegated task", async () => {
    const w = await world();
    await w.router.subscribe("tgt", request("notify"));
    await idle(w);
    w.host.openQuestion("tgt", "q-1", "Proceed?");
    await idle(w);
    assert.equal(notices(w.host).length, 0);
    await w.cleanup();
  });
});

// ---------------------------------------------------------------------------
// A Stop sticks: the delegate stop cascade and the reply router together
// ---------------------------------------------------------------------------

describe("a stopped chat is not woken by the delegates its stop interrupted", () => {
  const delegate = (parentThreadId: string): Partial<SessionSummary> => ({ lineage: { parentThreadId, relation: "delegate", createdAt: "t", agentCreated: true } });

  /** `req` delegated a task to `tgt` (`reply: "notify"`, as `create_session {delegate: true}`), now running; the cascade is wired as the daemon wires it. */
  async function stoppable(options: { reply?: "wait" | "notify" } = {}) {
    const w = await world();
    w.host.sessions.set("tgt", summary("tgt", delegate("req")));
    const cascade = new DelegateStopCascade({ sessions: w.host.listing });
    cascade.attachApi(w.host.api);
    cascade.setListener(w.router);
    const res = await w.router.subscribe("tgt", request(options.reply ?? "notify", { origin: "delegated" }));
    await idle(w);
    assert.equal(postsTo(w.host, "tgt").length, 1, "the task is running");
    // Its summary says so (the cascade interrupts only unfinished chats).
    w.host.touch("tgt");
    const stop = async (sessionId = "req", command: "interrupt" | "session/stop" = "interrupt"): Promise<void> => {
      cascade.commandAccepted(sessionId, command, { commandId: `stop-${sessionId}` });
      await cascade.whenIdle();
      await idle(w);
    };
    return { ...w, cascade, res, stop };
  }
  const sub = (w: World, id: string) => w.router.subscriptions().find((candidate) => candidate.id === id)!;

  it("an idle parent stopped by the user gets no 'interrupted before it replied' turn", async () => {
    const w = await stoppable();
    await w.stop();
    assert.equal(w.host.interrupts.filter((i) => i.sessionId === "tgt").length, 1, "the delegate was interrupted");
    assert.equal(w.host.threads.get("tgt")!.turns.at(-1)!.state, "interrupted");
    assert.equal(postsTo(w.host, "req").length, 0, "no turn on the chat the user stopped");
    assert.deepEqual([sub(w, w.res.subscriptionId).state, (sub(w, w.res.subscriptionId) as { ended?: string }).ended], ["done", "stopped"]);
    assert.equal(w.router.deliveries().length, 0);
    // Persisted: a restart delivers nothing either.
    const again = await world({ host: w.host, dir: w.dir });
    await idle(again);
    assert.equal(postsTo(w.host, "req").length, 0);
    await again.cleanup(false);
    await w.cleanup();
  });

  it("a session/stop does the same", async () => {
    const w = await stoppable();
    await w.stop("req", "session/stop");
    assert.equal(w.host.interrupts.filter((i) => i.sessionId === "tgt").length, 1);
    assert.equal(postsTo(w.host, "req").length, 0);
    await w.cleanup();
  });

  it("a parent waiting in wait_for_session returns at once, told the task stopped with it, and is not woken after", async () => {
    const w = await stoppable({ reply: "wait" });
    const waiting = w.router.wait("tgt", w.res.subscriptionId, { timeoutSeconds: 60 }, { principal: { kind: "agent", threadId: "req", projectPath: "" } });
    await until(() => sub(w, w.res.subscriptionId).state === "waiting" && w.timers.pending() > 0);
    await w.stop();
    const answer = await waiting;
    assert.equal(answer.outcome, "replied");
    assert.match((answer as { error?: string }).error ?? "", /was stopped together with the chat that asked, so no reply will come/);
    assert.equal(postsTo(w.host, "req").length, 0);
    // A later wait on it says the same, truthfully.
    const later = await w.router.wait("tgt", w.res.subscriptionId, { timeoutSeconds: 1 }, { principal: { kind: "agent", threadId: "req", projectPath: "" } });
    assert.equal((later as { state?: string }).state, "interrupted");
    await w.cleanup();
  });

  it("a delegate the user stops directly, its parent left alone, still reports back", async () => {
    const w = await stoppable();
    // The user's own Stop on the child: no cause, no cascade above it.
    await w.host.api.request("POST", "/api/sessions/tgt/interrupt", { body: { commandId: "user-stop" } });
    await idle(w);
    const sent = postsTo(w.host, "req");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body.input as string, /interrupted/);
    await w.cleanup();
  });

  it("deliveries already waiting when the Stop lands are not posted: a notice is dropped, a reply is held for the user", async () => {
    const w = await stoppable();
    // A second delegate, finished: its reply waits while the parent works.
    w.host.sessions.set("tgt2", summary("tgt2", delegate("req")));
    w.host.thread("tgt2");
    await w.router.subscribe("tgt2", request("notify", { origin: "delegated", causedBy: exchange(1, "ex-2") }));
    await idle(w);
    w.host.userTurn("req", "parent-turn");
    w.host.touch("req");
    w.host.settle("tgt2", { reply: "The cache uses Redis." });
    // The first delegate is stopped by its own user meanwhile: an "interrupted" notice waits too.
    await w.host.api.request("POST", "/api/sessions/tgt/interrupt", { body: { commandId: "user-stop" } });
    await idle(w);
    assert.equal(w.queue.pendingFor("req").length, 2, "both wait for the busy parent");
    // The user stops the parent: its turn settles, and it goes idle.
    await w.stop();
    w.host.settle("req", { state: "interrupted" });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0, "nothing wakes the stopped parent");
    const pending = w.queue.pendingFor("req");
    assert.equal(pending.length, 1, "the notice is gone, the reply is kept");
    assert.equal(pending[0]!.childSessionId, "tgt2");
    assert.equal(pending[0]!.state, "failed");
    assert.equal(pending[0]!.error, HELD_AFTER_STOP_TEXT);
    const dropped = w.router.deliveries().find((d) => d.fromThreadId === "tgt") as { state: string; stopped?: true };
    assert.deepEqual([dropped.state, dropped.stopped], ["dropped", true]);
    // A later turn of the parent's own does not release it either; Deliver now does.
    w.host.userTurn("req", "later-turn");
    w.host.settle("req", { reply: "ok" });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0);
    await w.queue.actOnMerge("req", pending[0]!.mergeId, { action: "deliver" });
    await idle(w);
    assert.match(postsTo(w.host, "req")[0]!.body.input as string, /The cache uses Redis\./);
    await w.cleanup();
  });

  it("a message still queued for the delegate is taken back, so the stop sticks below too", async () => {
    const w = await stoppable();
    w.host.settle("tgt", { reply: "first done" });
    await idle(w);
    w.host.userTurn("tgt", "own-turn");
    w.host.touch("tgt");
    const next = await w.router.subscribe("tgt", request("notify", { origin: "delegated", causedBy: exchange(3, "ex-3") }));
    await idle(w);
    assert.equal(w.queue.pendingFor("tgt").length, 1, "queued behind the child's own turn");
    const before = postsTo(w.host, "req").length;
    await w.stop();
    assert.equal(w.queue.pendingFor("tgt").length, 0, "never runs");
    assert.equal((sub(w, next.subscriptionId) as { ended?: string }).ended, "stopped");
    assert.equal(postsTo(w.host, "tgt").length, 1, "the child got no new turn");
    assert.equal(postsTo(w.host, "req").length, before);
    await w.cleanup();
  });

  it("the stop runs down the whole tree: a grandchild's notice wakes neither chat", async () => {
    const w = await stoppable();
    w.host.sessions.set("g", summary("g", delegate("tgt")));
    w.host.thread("g");
    await w.router.subscribe("g", { ...request("notify", { origin: "delegated", causedBy: { threadId: "tgt", exchangeId: "ex-g", hop: 2 } }), fromThreadId: "tgt" });
    await idle(w);
    assert.equal(postsTo(w.host, "g").length, 1);
    w.host.touch("g");
    await w.stop();
    assert.equal(w.host.interrupts.filter((i) => i.sessionId === "g").length, 1);
    assert.equal(postsTo(w.host, "tgt").length, 1, "the child got no notice turn");
    assert.equal(postsTo(w.host, "req").length, 0);
    await w.cleanup();
  });

  it("without the stop's own record, the cascade's row on the interrupted turn still keeps the parent asleep", async () => {
    const w = await stoppable();
    // The cascade's interrupt lands, but the router never heard the stop (its write was lost).
    await w.host.api.request("POST", "/api/sessions/tgt/interrupt", {
      body: { commandId: "cascade", cause: { kind: "parent-stopped", parentSessionId: "req", parentTitle: "Implement auth", action: "interrupted" } }
    });
    await idle(w);
    assert.equal(postsTo(w.host, "req").length, 0);
    assert.equal((sub(w, w.res.subscriptionId) as { ended?: string }).ended, "stopped");
    await w.cleanup();
  });
});
