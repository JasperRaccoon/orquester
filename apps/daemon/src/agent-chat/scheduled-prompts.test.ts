import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { EventMessage } from "@orquester/api";
import { parseSessionsConfig } from "@orquester/config";

import type { DaemonApi, DaemonMethod, DaemonRequestOptions, DaemonResponse } from "../mcp/daemon-api.ts";
import type { Clock } from "../workflows/contracts.ts";
import { ChatSessionManager } from "./chat-sessions.ts";
import { ChatScheduledPrompts, ScheduledPromptError } from "./scheduled-prompts.ts";

const T0 = Date.parse("2026-10-31T00:00:00.000Z");
const HOUR = 60 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Manual timers: `advance` runs what came due, in order. Never a real sleep. */
class FakeClock implements Clock {
  t = T0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  now(): Date {
    return new Date(this.t);
  }
  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.t + Math.max(0, ms), fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  }
  advance(ms: number): void {
    this.t += ms;
    for (;;) {
      const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.cancelled = true;
      due.fn();
    }
  }
}

/** The daemon's own routes, faked: the head read and the `/turn` command with the host's receipts and `ifIdle`. */
class FakeApi implements DaemonApi {
  readonly fsRoot = "/w";
  readonly workspacesDir = "/w";
  turns: Record<string, unknown>[] = [];
  /** Commands the host already took, by id. */
  receipts = new Set<string>();
  /** The thread has a turn in flight (the head and `ifIdle` both see it). */
  activeTurn = false;
  turnAnswer: DaemonResponse | null = null;

  async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    if (method === "GET" && path.endsWith("/head")) {
      return {
        status: 200,
        body: {
          head: { session: { status: this.activeTurn ? "running" : "ready", activeTurnId: this.activeTurn ? "t" : null } },
          pending: { approvals: [], userInputs: [] },
          recentTurns: []
        }
      };
    }
    const body = (opts?.body ?? {}) as Record<string, unknown>;
    const commandId = String(body.commandId);
    if (this.receipts.has(commandId)) return { status: 200, body: { seq: 1 } };
    if (this.turnAnswer) return this.turnAnswer;
    if (body.ifIdle === true && this.activeTurn) return { status: 409, body: { error: { code: "TURN_NOT_IDLE", message: "busy" } } };
    this.receipts.add(commandId);
    this.turns.push(body);
    return { status: 200, body: { seq: 1 } };
  }
  async uploadAttachment(): Promise<{ status: number; value: unknown }> {
    return { status: 500, value: null };
  }
  subscribe(_listener: (event: EventMessage) => void): () => void {
    return () => undefined;
  }
  async publishHtmlRender(): Promise<never> {
    throw new Error("unused");
  }
  async previewHtmlRender(): Promise<never> {
    throw new Error("unused");
  }
}

function newChat(): ChatSessionManager {
  const chat = new ChatSessionManager();
  chat.create({ id: "s1", refId: "claude", title: "chat", projectPath: "/w/p", cwd: "/w/p", order: 0, accountId: "acc1", home: "account" });
  return chat;
}

function harness(opts: { chat?: ChatSessionManager; clock?: FakeClock; api?: FakeApi; attach?: boolean } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const chat = opts.chat ?? newChat();
  const api = opts.api ?? new FakeApi();
  const scheduler = new ChatScheduledPrompts({ chat, clock, retryMs: 30_000 });
  scheduler.start();
  if (opts.attach !== false) scheduler.attachApi(api);
  const advance = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await scheduler.idle();
  };
  return { clock, chat, api, scheduler, advance };
}

/** The tab records written to `sessions.json` and read back by the next boot. */
function restartRecords(chat: ChatSessionManager): ChatSessionManager {
  const written = JSON.parse(JSON.stringify({ version: 1, sessions: chat.records() }));
  const next = new ChatSessionManager();
  next.adopt(parseSessionsConfig(written).sessions);
  return next;
}

test("a scheduled prompt goes out at its time with the turn it was scheduled with, then leaves the list", async () => {
  const h = harness();
  await h.scheduler.create("s1", {
    id: "p1",
    sendAt: iso(T0 + 4 * HOUR),
    input: "  run the migration  ",
    interactionMode: "plan",
    modelSelection: { model: "claude-opus" },
    attachments: [{ type: "image", id: "att1", name: "a.png", mimeType: "image/png", sizeBytes: 3 }]
  });
  assert.deepEqual(h.chat.get("s1")?.scheduledPrompts?.map((p) => [p.id, p.state, p.preview, p.attachmentCount]), [
    ["p1", "scheduled", "run the migration", 1]
  ]);

  await h.advance(4 * HOUR - 1_000);
  assert.equal(h.api.turns.length, 0, "not before its time");

  await h.advance(1_000);
  assert.equal(h.api.turns.length, 1);
  const turn = h.api.turns[0]!;
  assert.equal(turn.input, "run the migration");
  assert.equal(turn.interactionMode, "plan");
  assert.deepEqual(turn.modelSelection, { model: "claude-opus" });
  assert.equal((turn.attachments as unknown[]).length, 1);
  assert.equal(turn.ifIdle, true);
  assert.deepEqual(h.chat.get("s1")?.scheduledPrompts, [], "published empty, not dropped");
});

test("a cancelled prompt never goes out, and comes back whole for the composer", async () => {
  const h = harness();
  await h.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "hello", context: [{ kind: "file", label: "a.ts" }] });
  const result = await h.scheduler.cancel("s1", "p1");
  assert.equal(result.cancelled.input, "hello");
  assert.deepEqual(result.cancelled.context, [{ kind: "file", label: "a.ts" }]);
  assert.deepEqual(result.scheduledPrompts, []);
  await h.advance(2 * HOUR);
  assert.equal(h.api.turns.length, 0);
  await assert.rejects(h.scheduler.cancel("s1", "p1"), (error: unknown) => error instanceof ScheduledPromptError && error.code === "ITEM_NOT_FOUND");
});

test("a repeated create with the same id schedules it once", async () => {
  const h = harness();
  await h.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "hello" });
  await h.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "hello" });
  assert.equal(h.chat.get("s1")?.scheduledPrompts?.length, 1);
  await h.advance(HOUR);
  assert.equal(h.api.turns.length, 1);
});

test("a prompt that comes due while the chat works waits, and goes out once the chat is idle", async () => {
  const h = harness();
  await h.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "later" });
  h.api.activeTurn = true;
  h.chat.applyFields("s1", { ...idleFields(), latestTurn: { turnId: "t", state: "running" } as never, chatSessionStatus: "running" });
  await h.advance(HOUR);
  assert.equal(h.api.turns.length, 0, "never steers the running turn");
  assert.equal(h.chat.get("s1")?.scheduledPrompts?.[0]?.state, "waiting");

  h.api.activeTurn = false;
  h.chat.applyFields("s1", idleFields());
  await h.scheduler.idle();
  assert.equal(h.api.turns.length, 1);
  assert.deepEqual(h.chat.get("s1")?.scheduledPrompts, []);
});

test("a refused prompt is kept as failed with the reason, and a retry posts under a new command id", async () => {
  const h = harness();
  await h.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "x" });
  h.api.turnAnswer = { status: 400, body: { error: { code: "INVALID_COMMAND", message: "That model is gone." } } };
  await h.advance(HOUR);
  const failed = h.chat.get("s1")?.scheduledPrompts?.[0];
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "That model is gone.");

  h.api.turnAnswer = null;
  await h.scheduler.sendNow("s1", "p1");
  assert.equal(h.api.turns.length, 1);
  assert.equal(h.api.turns[0]!.commandId, "scheduled:p1:1");
  assert.deepEqual(h.chat.get("s1")?.scheduledPrompts, []);
});

test("restart: a prompt survives in the tab records, and one that came due while the daemon was down goes out on boot", async () => {
  const first = harness();
  await first.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "while you sleep" });
  first.scheduler.stop();

  // Down past its time; the next boot reads `sessions.json` back.
  const clock = new FakeClock();
  clock.t = T0 + 3 * HOUR;
  const second = harness({ chat: restartRecords(first.chat), clock, attach: false });
  assert.equal(second.chat.get("s1")?.scheduledPrompts?.[0]?.state, "scheduled");
  await second.advance(0);
  assert.equal(second.api.turns.length, 0, "nothing goes out before the daemon's API is bound");
  assert.equal(second.chat.get("s1")?.scheduledPrompts?.[0]?.state, "waiting");

  second.scheduler.attachApi(second.api);
  await second.scheduler.idle();
  assert.equal(second.api.turns.length, 1);
  assert.equal(second.api.turns[0]!.input, "while you sleep");
});

test("restart mid-post: the prompt is re-posted under the same command id, so the host's receipt keeps it from sending twice", async () => {
  const api = new FakeApi();
  const first = harness({ api });
  await first.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "once" });
  // The host took the turn, but the daemon died before it could take the prompt off the list.
  api.receipts.add("scheduled:p1:0");
  const prompts = first.chat.scheduledPromptsOf("s1").map((p) => ({ ...p, state: "sending" as const }));
  first.chat.setScheduledPrompts("s1", prompts);
  first.scheduler.stop();

  const second = harness({ chat: restartRecords(first.chat), api });
  await second.scheduler.idle();
  assert.equal(api.turns.length, 0, "the receipt answered; no second turn");
  assert.deepEqual(second.chat.get("s1")?.scheduledPrompts, []);
});

test("create refuses a prompt that is empty or too far ahead", async () => {
  const h = harness();
  const invalid = (error: unknown) => error instanceof ScheduledPromptError && error.code === "INVALID_COMMAND";
  await assert.rejects(h.scheduler.create("s1", { id: "p1", sendAt: iso(T0 + HOUR), input: "   " }), invalid);
  await assert.rejects(h.scheduler.create("s1", { id: "p2", sendAt: iso(T0 + 31 * 24 * HOUR), input: "x" }), invalid);
  assert.equal(h.chat.get("s1")?.scheduledPrompts, undefined);
});

function idleFields() {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    latestTurn: { turnId: "t", state: "completed" } as never,
    chatSessionStatus: "ready" as never,
    goal: null
  };
}
