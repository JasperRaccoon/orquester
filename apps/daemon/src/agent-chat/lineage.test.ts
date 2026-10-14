/**
 * Thread lineage, the daemon side (spec 2026-10-14 §6): the lineage read, and
 * the merge back — sent at once to an idle parent, queued (and persisted) for
 * a busy one, delivered on the parent's next idle point, idempotent by its id,
 * surviving a restart.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { EventMessage, SessionSummary } from "@orquester/api";
import { parseMergeBackMessage, type ThreadSnapshotPayload, type Turn } from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonResponse } from "../mcp/daemon-api.ts";
import { acceptsMessage, LineageError, LineageService } from "./lineage.ts";

const turn = (turnId: string, state: Turn["state"]): Turn => ({
  turnId,
  state,
  turnCount: null,
  requestedAt: "t",
  startedAt: "t",
  completedAt: "t",
  assistantMessageId: null
});

function snapshot(input: { busy?: boolean; reply?: string } = {}): ThreadSnapshotPayload {
  return {
    head: {
      id: "x",
      session: { status: input.busy ? "running" : "ready", activeTurnId: input.busy ? "t2" : null }
    },
    items: input.reply
      ? [
          {
            kind: "message",
            id: "a1",
            role: "assistant",
            text: input.reply,
            turnId: "t1",
            streaming: false,
            createdAt: "t",
            updatedAt: "t"
          }
        ]
      : [],
    turns: input.busy ? [turn("t1", "completed"), turn("t2", "running")] : [turn("t1", "completed")],
    checkpoints: [],
    pending: { approvals: [], userInputs: [] },
    roster: [],
    seq: 1
  } as unknown as ThreadSnapshotPayload;
}

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    kind: "agent-chat",
    refId: "claude",
    title: id,
    projectPath: "/w/p",
    cwd: "/w/p",
    cols: 0,
    rows: 0,
    status: "running",
    order: 0,
    createdAt: "2026-10-14T00:00:00.000Z",
    ...extra
  }) as SessionSummary;

/** The daemon's own routes, faked: thread reads by session, `/turn` recorded. */
function fakeWorld() {
  const sessions = new Map<string, SessionSummary>();
  const threads = new Map<string, ThreadSnapshotPayload>();
  const turns: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
  const listeners = new Set<(event: EventMessage) => void>();
  let turnStatus = 200;
  const api: DaemonApi = {
    fsRoot: "/",
    workspacesDir: "/w",
    async request(method, path, opts): Promise<DaemonResponse> {
      const read = /^\/api\/sessions\/([^/]+)\/thread$/.exec(path);
      if (method === "GET" && read) {
        const snap = threads.get(decodeURIComponent(read[1]!));
        return snap ? { status: 200, body: { kind: "snapshot", thread: snap } } : { status: 404, body: null };
      }
      const post = /^\/api\/sessions\/([^/]+)\/turn$/.exec(path);
      if (method === "POST" && post) {
        turns.push({ sessionId: decodeURIComponent(post[1]!), body: opts?.body as Record<string, unknown> });
        return turnStatus < 400
          ? { status: 200, body: { seq: 9 } }
          : { status: turnStatus, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } };
      }
      return { status: 404, body: null };
    },
    async uploadAttachment() {
      return { status: 503, value: null };
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
    turns,
    setTurnStatus: (status: number) => {
      turnStatus = status;
    },
    /** The parent's tab changed: the bus event the summary service raises. */
    touch(id: string): void {
      for (const listener of listeners) {
        listener({ channel: "sessions", type: "updated", payload: { id } } as unknown as EventMessage);
      }
    },
    listing: {
      get: (id: string) => sessions.get(id),
      list: () => [...sessions.values()]
    }
  };
}

async function setup(options: { parentBusy?: boolean; outbox?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-lineage-"));
  const outboxFile = join(dir, "agent-merge-outbox.json");
  if (options.outbox !== undefined) await writeFile(outboxFile, options.outbox);
  const world = fakeWorld();
  world.sessions.set("parent", summary("parent", { title: "Parent" }));
  world.sessions.set(
    "child",
    summary("child", {
      title: "Try B",
      lineage: {
        parentThreadId: "parent",
        relation: "fork",
        forkedFrom: { messageId: "m1", turnId: "t1" },
        createdAt: "2026-10-14T01:00:00.000Z"
      }
    })
  );
  world.threads.set("parent", snapshot({ busy: options.parentBusy === true }));
  world.threads.set("child", snapshot({ reply: "B works; A does not." }));
  if (options.parentBusy) {
    world.sessions.set("parent", summary("parent", { title: "Parent", chatSessionStatus: "running" }));
  }
  let ids = 0;
  const make = () =>
    new LineageService({
      sessions: world.listing,
      outboxFile,
      recheckMs: 0,
      newId: () => `merge-${(ids += 1)}`,
      now: () => new Date("2026-10-14T02:00:00.000Z")
    });
  const service = make();
  await service.load();
  service.attachApi(world.api);
  return {
    world,
    service,
    make,
    outboxFile,
    cleanup: async () => {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Let the service's delivery chain settle: its per-parent run, then its write. */
async function settled(service: LineageService): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await (service as unknown as { writes: Promise<void> }).writes;
  for (const run of (service as unknown as { draining: Map<string, Promise<void>> }).draining.values()) {
    await run;
  }
}

describe("acceptsMessage", () => {
  it("is false while anything runs or waits on the user", () => {
    assert.equal(acceptsMessage(summary("p"), snapshot()), true);
    assert.equal(acceptsMessage(summary("p"), snapshot({ busy: true })), false);
    assert.equal(acceptsMessage(summary("p", { hasPendingApprovals: true }), snapshot()), false);
    assert.equal(acceptsMessage(summary("p", { chatSessionStatus: "starting" }), snapshot()), false);
    assert.equal(
      acceptsMessage(summary("p", { goal: { objective: "x", status: "active", continuing: true } } as Partial<SessionSummary>), snapshot()),
      false
    );
  });
});

describe("merge back", () => {
  it("sends the child's final reply to an idle parent at once, marked as coming from the fork", async () => {
    const { world, service, cleanup } = await setup();
    const result = await service.mergeBack("child", {});
    assert.deepEqual(result, { parentSessionId: "parent", delivery: "sent", mergeId: "merge-1", seq: 9 });
    assert.equal(world.turns.length, 1);
    const { sessionId, body } = world.turns[0]!;
    assert.equal(sessionId, "parent");
    assert.equal(body.commandId, "merge-1", "delivered under the merge's own id");
    assert.deepEqual(parseMergeBackMessage(body.input as string), {
      relation: "fork",
      childTitle: "Try B",
      body: "B works; A does not."
    });
    await cleanup();
  });

  it("sends the user's own summary instead when given one", async () => {
    const { world, service, cleanup } = await setup();
    await service.mergeBack("child", { text: "  Go with B.  " });
    assert.equal(parseMergeBackMessage(world.turns[0]!.body.input as string)?.body, "Go with B.");
    await cleanup();
  });

  it("queues for a busy parent, persists it, and delivers it on the parent's next idle point", async () => {
    const { world, service, outboxFile, cleanup } = await setup({ parentBusy: true });
    const result = await service.mergeBack("child", { commandId: "fixed-id" });
    assert.equal(result.delivery, "queued");
    assert.equal(result.mergeId, "fixed-id");
    await settled(service);
    assert.equal(world.turns.length, 0, "nothing reaches a busy parent");
    const persisted = JSON.parse(await readFile(outboxFile, "utf8")) as { entries: Array<{ mergeId: string }> };
    assert.deepEqual(persisted.entries.map((entry) => entry.mergeId), ["fixed-id"]);
    assert.deepEqual(service.view("parent").pendingMerges.map((entry) => entry.childSessionId), ["child"]);

    // The same merge again is the same merge.
    assert.equal((await service.mergeBack("child", { commandId: "fixed-id" })).delivery, "queued");
    assert.equal(service.pending().length, 1);

    // Still busy: an event changes nothing.
    world.touch("parent");
    await settled(service);
    assert.equal(world.turns.length, 0);

    // The turn ends: the next event delivers it.
    world.sessions.set("parent", summary("parent", { title: "Parent", chatSessionStatus: "ready" }));
    world.threads.set("parent", snapshot());
    world.touch("parent");
    await settled(service);
    assert.equal(world.turns.length, 1);
    assert.equal(world.turns[0]!.body.commandId, "fixed-id");
    assert.equal(service.pending().length, 0);
    const after = JSON.parse(await readFile(outboxFile, "utf8")) as { entries: unknown[] };
    assert.deepEqual(after.entries, []);
    await cleanup();
  });

  it("keeps a queued merge across a restart, and a host restart, until delivered", async () => {
    const first = await setup({ parentBusy: true });
    await first.service.mergeBack("child", {});
    await settled(first.service);
    await first.service.stop();

    // A new daemon: same outbox, parent idle now, host still restarting.
    const second = first.make();
    await second.load();
    first.world.sessions.set("parent", summary("parent", { title: "Parent" }));
    first.world.threads.set("parent", snapshot());
    first.world.setTurnStatus(503);
    second.attachApi(first.world.api);
    await settled(second);
    assert.equal(second.pending().length, 1, "a 503 keeps it queued");

    first.world.setTurnStatus(200);
    first.world.touch("parent");
    await settled(second);
    assert.equal(second.pending().length, 0);
    assert.equal(first.world.turns.at(-1)!.body.commandId, "merge-1", "the id it was queued with");
    await second.stop();
    await first.cleanup();
  });

  it("drops a queued merge whose parent was closed, and keeps entries it cannot read", async () => {
    const { world, service, outboxFile, cleanup } = await setup({
      outbox: JSON.stringify({
        version: 1,
        entries: [
          { mergeId: "old", parentSessionId: "gone", childSessionId: "child", input: "x", queuedAt: "t" },
          { from: "a newer build" }
        ]
      })
    });
    await settled(service);
    assert.equal(world.turns.length, 0);
    assert.equal(service.pending().length, 0);
    const persisted = JSON.parse(await readFile(outboxFile, "utf8")) as { entries: unknown[] };
    assert.deepEqual(persisted.entries, [{ from: "a newer build" }]);
    await cleanup();
  });

  it("refuses a session with no parent, a closed parent, and a child with nothing to say", async () => {
    const { world, service, cleanup } = await setup();
    await assert.rejects(service.mergeBack("parent", {}), (error: unknown) => error instanceof LineageError && error.code === "COMMAND_REJECTED");
    world.threads.set("child", snapshot());
    await assert.rejects(service.mergeBack("child", {}), /no reply to merge back/);
    await assert.rejects(service.mergeBack("child", { text: 5 } as never), /text must be a string/);
    world.sessions.delete("parent");
    await assert.rejects(service.mergeBack("child", { text: "x" }), /was closed/);
    await assert.rejects(service.mergeBack("nope", {}), (error: unknown) => error instanceof LineageError && error.code === "THREAD_NOT_FOUND");
    await cleanup();
  });
});

describe("the lineage read", () => {
  it("names the parent and lists the children oldest first, with their status", async () => {
    const { world, service, cleanup } = await setup();
    world.sessions.set(
      "delegate",
      summary("delegate", {
        title: "Task",
        chatSessionStatus: "running",
        lineage: { parentThreadId: "parent", relation: "delegate", createdAt: "2026-10-14T00:30:00.000Z" }
      })
    );
    const parent = service.view("parent");
    assert.equal(parent.lineage, null);
    assert.equal(parent.parent, null);
    assert.deepEqual(parent.children.map((child) => [child.sessionId, child.relation]), [
      ["delegate", "delegate"],
      ["child", "fork"]
    ]);
    assert.equal(parent.children[0]!.chatSessionStatus, "running");
    assert.deepEqual(parent.children[1]!.forkedFrom, { messageId: "m1", turnId: "t1" });

    const child = service.view("child");
    assert.deepEqual(child.parent, { sessionId: "parent", title: "Parent", exists: true });
    world.sessions.delete("parent");
    assert.deepEqual(service.view("child").parent, { sessionId: "parent", title: "parent", exists: false });
    await cleanup();
  });
});
