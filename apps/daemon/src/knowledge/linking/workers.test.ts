import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeClock, flushAsync } from "../../workflows/agent/testing/fake-clock.ts";
import { InboxBroker } from "./inbox.ts";
import { FakeWorkerPort, writeMykgTask, type FakeAccountBehaviour } from "./testing.ts";
import { WorkerPool, WorkerStartError, type WorkerPoolEvent } from "./workers.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  clock: FakeClock;
  broker: InboxBroker;
  port: FakeWorkerPort;
  pool: WorkerPool;
  events: WorkerPoolEvent[];
  addTasks(count: number, system?: string): Promise<string[]>;
  /** Resolves once a pool event matches (event-driven). */
  untilEvent(predicate: (event: WorkerPoolEvent) => boolean): Promise<WorkerPoolEvent>;
}

async function harness(options: {
  accounts?: string[];
  behaviour?: Record<string, FakeAccountBehaviour>;
  concurrency?: number;
  budget?: { tasks: number; tokens: number };
  mode?: "auto" | "manual";
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orq-workers-"));
  roots.push(dir);
  const clock = new FakeClock("2026-10-23T10:00:00.000Z");
  const broker = new InboxBroker({ clock, watch: null, ...(options.budget ? { budget: options.budget } : {}) });
  await broker.attach(dir);
  const port = new FakeWorkerPort(options.accounts ?? ["a1", "a2"], () => clock.now(), options.behaviour ?? {});
  port.mode = options.mode ?? "auto";
  port.broker = () => broker;
  const events: WorkerPoolEvent[] = [];
  const waiters = new Set<(event: WorkerPoolEvent) => void>();
  const pool = new WorkerPool({
    port,
    broker,
    runId: "kr_1",
    concurrency: options.concurrency ?? 2,
    clock,
    onEvent: (event) => {
      events.push(event);
      for (const waiter of [...waiters]) waiter(event);
    }
  });
  let n = 0;
  return {
    clock,
    broker,
    port,
    pool,
    events,
    untilEvent(predicate) {
      const seen = events.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => {
        const waiter = (event: WorkerPoolEvent): void => {
          if (!predicate(event)) return;
          waiters.delete(waiter);
          resolve(event);
        };
        waiters.add(waiter);
      });
    },
    async addTasks(count, system = "SYSTEM") {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        ids.push(await writeMykgTask(join(dir, "agent_inbox"), { system, user: `FILE ke_${n}.md\nbody`, step: "pass2", context: `pass2 ${n}`, createdAt: `2026-10-23T10:00:${String(n).padStart(2, "0")}Z` }));
        n += 1;
      }
      await broker.rescan();
      return ids;
    }
  };
}

/** Resolves once the broker accepted `count` answers (event-driven). */
function untilAnswered(h: Harness, count: number): Promise<void> {
  if (h.broker.counts().answered >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (h.broker.counts().answered < count) return;
      h.broker.events.off("answered", check);
      resolve();
    };
    h.broker.events.on("answered", check);
  });
}

/** Lets the fake chats answer `count` tasks, then ends the run so parked calls return. */
async function drain(h: Harness, count: number): Promise<void> {
  await untilAnswered(h, count);
  h.broker.finish("run-finished");
  await h.pool.settle(60_000);
  await flushAsync(10);
}

describe("WorkerPool", () => {
  it("starts chats only for tasks no chat will take, up to the concurrency", async () => {
    const h = await harness({ mode: "manual", concurrency: 2 });
    h.pool.reconcile();
    await flushAsync();
    assert.equal(h.port.sessions.length, 0, "an empty inbox costs nothing");
    await h.addTasks(1);
    await flushAsync();
    assert.equal(h.port.sessions.length, 1, "one task, one chat");
    await h.addTasks(4);
    await flushAsync();
    assert.equal(h.port.sessions.length, 2, "never more than the concurrency");
    assert.deepEqual(
      h.events.filter((e) => e.kind === "worker").map((e) => e.kind === "worker" && e.record.state),
      ["running", "running"]
    );
  });

  it("answers every task, retiring each chat at its budget and starting a fresh one while tasks remain", async () => {
    const h = await harness({ concurrency: 1, budget: { tasks: 2, tokens: 1_000_000 } });
    await h.addTasks(5);
    await drain(h, 5);
    assert.equal(h.broker.counts().answered, 5);
    assert.deepEqual(h.port.sessions.map((s) => s.answered.length), [2, 2, 1]);
    assert.ok(h.port.sessions.every((s) => s.stopped?.interrupt === false), "a chat that ended its turn is closed, not interrupted");
    // Instructions once per chat.
    assert.deepEqual(h.port.sessions[0]!.seenInstructions, ["SYSTEM", null]);
    assert.deepEqual(h.port.sessions[1]!.seenInstructions, ["SYSTEM", null]);
    const tokens = h.events.filter((e) => e.kind === "tokens");
    assert.equal(tokens.length, 3);
    assert.equal(h.pool.size, 0);
  });

  it("an invalid answer goes back to the same chat, which redoes it", async () => {
    const h = await harness({ concurrency: 1, accounts: ["a1"], behaviour: { a1: { invalidFirst: true } } });
    const [id] = await h.addTasks(1);
    await drain(h, 1);
    assert.equal(h.port.sessions.length, 1);
    assert.equal(h.port.sessions[0]!.refused, 1);
    assert.deepEqual(h.port.sessions[0]!.answered, [id]);
  });

  it("a usage limit cools the account down and fails over to another account", async () => {
    const h = await harness({
      concurrency: 1,
      accounts: ["a1", "a2"],
      behaviour: { a1: { limitAfter: 1, resetsAt: "2026-10-23T15:00:00.000Z" } }
    });
    await h.addTasks(3);
    await drain(h, 3);
    assert.deepEqual(h.port.coolDowns, [{ accountId: "a1", resetsAt: "2026-10-23T15:00:00.000Z" }]);
    assert.deepEqual(h.port.sessions.map((s) => [s.accountId, s.answered.length]), [["a1", 1], ["a2", 2]]);
    assert.equal(h.port.sessions[0]!.stopped?.interrupt, true, "the limited chat is interrupted and closed");
    assert.equal(h.broker.counts().answered, 3, "the task it held went to the next chat");
  });

  it("pauses with resumesAt when every account is limited, and resumes at the reset", async () => {
    const h = await harness({ concurrency: 1, accounts: ["a1"], behaviour: { a1: { limitAfter: 1, resetsAt: "2026-10-23T11:00:00.000Z" } } });
    await h.addTasks(2);
    const paused = await h.untilEvent((e) => e.kind === "paused");
    assert.deepEqual(paused, { kind: "paused", reason: "usage-limit", resumesAt: "2026-10-23T11:00:00.000Z", message: "Every account is at its limit." });
    assert.equal(h.pool.isPaused(), true);
    assert.equal(h.port.sessions.length, 1);
    h.port.behaviour.a1 = {};
    await h.clock.advance(60 * 60_000);
    await h.untilEvent((e) => e.kind === "resumed");
    await drain(h, 2);
    assert.equal(h.port.sessions.length, 2);
    assert.equal(h.broker.counts().answered, 2);
  });

  it("a run that ends while the pool is paused leaves no timer behind", async () => {
    const h = await harness({ concurrency: 1, accounts: ["a1"], behaviour: { a1: { limitAfter: 1, resetsAt: "2026-10-23T11:00:00.000Z" } } });
    await h.addTasks(2);
    await h.untilEvent((e) => e.kind === "paused");
    await flushAsync(10);
    h.broker.finish("run-finished");
    await h.pool.settle(60_000);
    const after = h.events.length;
    await h.clock.advance(2 * 60 * 60_000);
    await flushAsync(10);
    assert.deepEqual(h.events.slice(after), [], "no resume (or anything else) after the run ended");
  });

  it("says no-account when there is no Claude account at all", async () => {
    const h = await harness({ concurrency: 1, accounts: [] });
    await h.addTasks(1);
    await flushAsync();
    assert.deepEqual(h.events.at(-1), { kind: "paused", reason: "no-account", resumesAt: null, message: "No Claude account." });
  });

  it("a chat that fails mid-task has its lease reassigned to a new chat", async () => {
    const h = await harness({ mode: "manual", concurrency: 1 });
    const [id] = await h.addTasks(1);
    await flushAsync();
    const first = h.port.sessions[0]!;
    const taken = await h.broker.next(first.id);
    assert.equal(taken.kind === "task" && taken.task.taskId, id);
    first.end({ kind: "failed", message: "the CLI crashed" });
    await flushAsync(20);
    assert.equal(h.port.sessions.length, 2, "a replacement chat starts for the released task");
    const again = await h.broker.next(h.port.sessions[1]!.id);
    assert.equal(again.kind === "task" && again.task.taskId, id);
  });

  it("chats that end their turn while holding a task count as failures: no endless restarts on a task nobody answers", async () => {
    const h = await harness({ mode: "manual", concurrency: 1 });
    const [id] = await h.addTasks(1);
    for (let round = 0; round < 6; round += 1) {
      await flushAsync(20);
      const chat = h.port.sessions[round];
      if (!chat) break;
      const taken = await h.broker.next(chat.id);
      assert.equal(taken.kind === "task" && taken.task.taskId, id);
      // The chat gives up on it (it ends its turn without submitting).
      chat.end({ kind: "done" });
    }
    await flushAsync(20);
    assert.equal(h.port.sessions.length, 3, "three chats tried it, no fourth is started");
    assert.deepEqual(
      h.events.filter((e) => e.kind === "error").map((e) => e.kind === "error" && e.message),
      ["Worker chats keep ending without answering their task."]
    );
  });

  it("a chat that keeps submitting answers that do not parse is retired and its task handed on", async () => {
    const h = await harness({ mode: "manual", concurrency: 1 });
    const [id] = await h.addTasks(1);
    await flushAsync();
    const chat = h.port.sessions[0]!;
    await h.broker.next(chat.id);
    for (let i = 0; i < 2; i += 1) assert.equal((await h.broker.submit(chat.id, id!, "no JSON here")).accepted, false);
    const third = await h.broker.submit(chat.id, id!, "still no JSON");
    assert.equal(third.accepted, false);
    assert.match(!third.accepted ? third.error : "", /end your turn/);
    assert.equal((await h.broker.submit(chat.id, id!, "and again")).accepted, false);
    assert.deepEqual(await h.broker.next(chat.id), { kind: "done", reason: "session-budget" });
    assert.equal(h.broker.counts().pending, 1, "the task waits for another chat (a retired chat never takes it back)");
  });

  it("gives up with an error after repeated start failures", async () => {
    const h = await harness({ concurrency: 1 });
    h.port.failStarts = 5;
    await h.addTasks(1);
    await h.clock.advance(60_000);
    assert.deepEqual(h.events.filter((e) => e.kind === "error").map((e) => e.kind === "error" && e.message), ["Worker chats could not be started: create refused"]);
  });

  it("a fatal start error (the profile cannot be prepared) stops the pool at once", async () => {
    const h = await harness({ concurrency: 1 });
    h.port.start = async () => {
      throw new WorkerStartError("The Knowledge indexer profile could not be prepared: disk full", true);
    };
    await h.addTasks(1);
    await flushAsync();
    assert.deepEqual(h.events.at(-1), { kind: "error", message: "The Knowledge indexer profile could not be prepared: disk full" });
  });

  it("stop() interrupts and closes every chat", async () => {
    const h = await harness({ mode: "manual", concurrency: 2 });
    await h.addTasks(2);
    await flushAsync();
    await h.pool.stop();
    assert.ok(h.port.sessions.length === 2 && h.port.sessions.every((s) => s.stopped?.interrupt === true));
    assert.equal(h.pool.size, 0);
  });

  it("adopts a chat from before a restart that still works, and closes one that does not", async () => {
    const h = await harness({ concurrency: 2 });
    h.port.running.add("old-1");
    await h.pool.adopt([
      { sessionId: "old-1", accountId: "a1", runId: "kr_1", state: "running", tasks: 0, startedAt: "t", finishedAt: null },
      { sessionId: "old-2", accountId: "a1", runId: "kr_1", state: "running", tasks: 3, startedAt: "t", finishedAt: null },
      { sessionId: "other-run", accountId: "a1", runId: "kr_0", state: "running", tasks: 0, startedAt: "t", finishedAt: null }
    ]);
    await h.addTasks(1);
    await drain(h, 1);
    assert.equal(h.port.sessions.length, 1, "no new chat beside the adopted one");
    assert.ok(h.port.sessions.some((s) => s.id === "old-1" && s.answered.length === 1), "the adopted chat picked the task up");
    const closed = h.events.filter((e) => e.kind === "worker" && e.record.sessionId === "old-2");
    assert.equal(closed.length === 1 && closed[0]!.kind === "worker" && closed[0]!.record.state, "done");
  });
});
