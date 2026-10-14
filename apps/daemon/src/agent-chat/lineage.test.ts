/**
 * Thread lineage, the daemon side (spec 2026-10-14 §6): the lineage read, and
 * the merge back — sent at once to an idle parent, queued (and persisted) for
 * a busy one, delivered on the parent's next idle point, idempotent by its id,
 * surviving a restart.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { EventMessage, PendingMergeBack, SessionSummary } from "@orquester/api";
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
  let turnCode = "HOST_UNAVAILABLE";
  let turnRefusal: { message?: string; detail?: unknown } = {};
  /**
   * The host's receipts: a command id it accepted or REJECTED is answered the same way
   * again (orchestration `replayRecordedRejection`); a 503 records nothing.
   */
  const receipts = new Map<string, DaemonResponse>();
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
        const body = opts?.body as Record<string, unknown>;
        const recorded = receipts.get(body.commandId as string);
        if (recorded) return recorded;
        turns.push({ sessionId: decodeURIComponent(post[1]!), body });
        const answer: DaemonResponse =
          turnStatus < 400
            ? { status: 200, body: { seq: 9 } }
            : {
                status: turnStatus,
                body: { error: { code: turnCode, message: turnRefusal.message ?? `refused: ${turnCode}`, ...("detail" in turnRefusal ? { detail: turnRefusal.detail } : {}) } }
              };
        if (answer.status !== 503) receipts.set(body.commandId as string, answer);
        return answer;
      }
      return { status: 404, body: null };
    },
    async uploadAttachment() {
      return { status: 503, value: null };
    },
    async publishHtmlRender() {
      return { ok: false, code: "UNAVAILABLE", message: "no pages in tests" };
    },
    async previewHtmlRender() {
      return { ok: false, code: "UNAVAILABLE", message: "no pages in tests" };
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
    setTurnStatus: (status: number, code = "HOST_UNAVAILABLE", refusal: { message?: string; detail?: unknown } = {}) => {
      turnStatus = status;
      turnCode = code;
      turnRefusal = refusal;
    },
    /** The host's post-gate deadline refusal of a `/turn` (`http-server.ts` `sendError`), as a real host words it. */
    refuseWithDeadline(marked = true): void {
      turnStatus = 409;
      turnCode = "COMMAND_REJECTED";
      turnRefusal = {
        message: "codex thread/start timed out after 30000ms",
        ...(marked ? { detail: { reason: "deadline" } } : {})
      };
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

async function setup(options: { parentBusy?: boolean; outbox?: string; outboxIsDirectory?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-lineage-"));
  const outboxFile = join(dir, "agent-merge-outbox.json");
  if (options.outbox !== undefined) await writeFile(outboxFile, options.outbox);
  if (options.outboxIsDirectory === true) await mkdir(outboxFile);
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
  const published = new Map<string, PendingMergeBack[]>();
  let nowMs = Date.parse("2026-10-14T02:00:00.000Z");
  const make = () =>
    new LineageService({
      sessions: world.listing,
      outboxFile,
      recheckMs: 0,
      retryDelayMs: 1_000,
      setPendingMerges: (id, merges) => published.set(id, merges),
      newId: () => `merge-${(ids += 1)}`,
      now: () => new Date(nowMs)
    });
  const service = make();
  await service.load();
  service.attachApi(world.api);
  return {
    world,
    service,
    make,
    outboxFile,
    dir,
    published,
    /** Move the service's clock on: a deadline refusal's retry delay passes. */
    advance: (ms: number) => {
      nowMs += ms;
    },
    cleanup: async () => {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Let the service's delivery chain settle: every parent's lane, then its write. */
async function settled(service: LineageService): Promise<void> {
  const internals = service as unknown as { writes: Promise<void>; lanes: Map<string, Promise<unknown>> };
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([...internals.lanes.values()]);
    await internals.writes;
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

  it("a merge from a planning turn reaches the parent in plan mode, sent at once or queued and persisted", async () => {
    const now = await setup();
    await now.service.mergeBack("child", { text: "Plan B.", interactionMode: "plan" });
    assert.equal(now.world.turns[0]!.body.interactionMode, "plan");
    await assert.rejects(now.service.mergeBack("child", { text: "x", interactionMode: "edit" as never }), /interactionMode/);
    await now.service.mergeBack("child", { text: "Plain." });
    assert.equal(now.world.turns.at(-1)!.body.interactionMode, "default");
    await now.cleanup();

    const busy = await setup({ parentBusy: true });
    await busy.service.mergeBack("child", { text: "Plan B.", interactionMode: "plan" });
    await settled(busy.service);
    const persisted = JSON.parse(await readFile(busy.outboxFile, "utf8")) as { entries: Array<{ interactionMode?: string }> };
    assert.equal(persisted.entries[0]!.interactionMode, "plan");
    busy.world.sessions.set("parent", summary("parent", { title: "Parent", chatSessionStatus: "ready" }));
    busy.world.threads.set("parent", snapshot());
    busy.world.touch("parent");
    await settled(busy.service);
    assert.equal(busy.world.turns[0]!.body.interactionMode, "plan");
    await busy.cleanup();
  });

  it("a merge keeps a planning parent in plan mode — sent at once or delivered later (D-I1)", async () => {
    const planning = (busy: boolean) => {
      const snap = snapshot({ busy });
      return { ...snap, turns: snap.turns.map((t) => ({ ...t, interactionMode: "plan" as const })) };
    };
    const now = await setup();
    now.world.threads.set("parent", planning(false));
    await now.service.mergeBack("child", { text: "Plain." });
    assert.equal(now.world.turns.at(-1)!.body.interactionMode, "plan", "the parent's own mode, not default");
    await now.cleanup();

    const later = await setup({ parentBusy: true });
    later.world.threads.set("parent", planning(true));
    await later.service.mergeBack("child", { text: "Plain." });
    await settled(later.service);
    later.world.sessions.set("parent", summary("parent", { title: "Parent", chatSessionStatus: "ready" }));
    later.world.threads.set("parent", planning(false));
    later.world.touch("parent");
    await settled(later.service);
    assert.equal(later.world.turns[0]!.body.interactionMode, "plan");
    await later.cleanup();
  });

  it("never answers queued for a merge it could not save: refused, nothing left queued (D-M1)", async () => {
    const { service, outboxFile, published, cleanup } = await setup({ parentBusy: true });
    // The file's place is taken: the write's rename fails.
    await mkdir(outboxFile);
    await assert.rejects(
      service.mergeBack("child", { commandId: "lost" }),
      (error: unknown) => error instanceof LineageError && error.code === "HOST_UNAVAILABLE"
    );
    assert.deepEqual(service.view("parent").pendingMerges, []);
    assert.deepEqual(published.get("parent") ?? [], []);
    await cleanup();
  });

  it("a corrupt outbox, or another version, is moved aside and never overwritten (D-I2)", async () => {
    for (const body of ["{not json", JSON.stringify({ version: 2, entries: [{ future: true }] })]) {
      const { service, dir, cleanup } = await setup({ parentBusy: true, outbox: body });
      const aside = (await readdir(dir)).find((name) => name.startsWith("agent-merge-outbox.json.corrupt-"));
      assert.ok(aside, "moved aside");
      assert.equal(await readFile(join(dir, aside), "utf8"), body);
      // It works on from an empty queue.
      assert.equal((await service.mergeBack("child", { commandId: "after" })).delivery, "queued");
      await cleanup();
    }
  });

  it("an unreadable outbox makes merges that would queue refused for the run, the file left alone (D-I2)", async () => {
    const { service, outboxFile, cleanup } = await setup({ parentBusy: true, outboxIsDirectory: true });
    await assert.rejects(
      service.mergeBack("child", { commandId: "x" }),
      (error: unknown) => error instanceof LineageError && error.code === "HOST_UNAVAILABLE"
    );
    assert.deepEqual(await readdir(outboxFile), [], "left as it was");
    await cleanup();
  });

  it("unknown top-level keys and entries of a newer build survive a rewrite (D-I2)", async () => {
    const { service, outboxFile, cleanup } = await setup({
      parentBusy: true,
      outbox: JSON.stringify({ version: 1, entries: [{ fromTheFuture: 1 }], newerBuild: { keep: true } })
    });
    await service.mergeBack("child", { commandId: "kept" });
    await settled(service);
    const disk = JSON.parse(await readFile(outboxFile, "utf8")) as { newerBuild?: unknown; entries: unknown[] };
    assert.deepEqual(disk.newerBuild, { keep: true });
    assert.equal(disk.entries.length, 2);
    await cleanup();
  });

  it("sends the user's own summary instead when given one", async () => {
    const { world, service, cleanup } = await setup();
    await service.mergeBack("child", { text: "  Go with B.  " });
    assert.equal(parseMergeBackMessage(world.turns[0]!.body.input as string)?.body, "Go with B.");
    await cleanup();
  });

  it("queues for a busy parent, persists it, and delivers it on the parent's next idle point", async () => {
    const { world, service, outboxFile, published, cleanup } = await setup({ parentBusy: true });
    const result = await service.mergeBack("child", { commandId: "fixed-id" });
    assert.equal(result.delivery, "queued");
    assert.equal(result.mergeId, "fixed-id");
    await settled(service);
    assert.equal(world.turns.length, 0, "nothing reaches a busy parent");
    const persisted = JSON.parse(await readFile(outboxFile, "utf8")) as { entries: Array<{ mergeId: string }> };
    assert.deepEqual(persisted.entries.map((entry) => entry.mergeId), ["fixed-id"]);
    assert.deepEqual(service.view("parent").pendingMerges.map((entry) => entry.childSessionId), ["child"]);
    // Both tabs show it, with what it says.
    assert.equal(published.get("parent")?.[0]?.preview, "B works; A does not.");
    assert.equal(published.get("child")?.[0]?.state, "queued");

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

  it("keeps a merge whose parent was closed as failed — said, never dropped — and entries it cannot read", async () => {
    const { world, service, outboxFile, published, cleanup } = await setup({
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
    assert.deepEqual(service.pending().map((merge) => [merge.mergeId, merge.state]), [["old", "failed"]]);
    assert.match(service.pending()[0]!.error ?? "", /closed/);
    assert.equal(published.get("child")?.[0]?.state, "failed", "the fork's tab shows it");
    const persisted = JSON.parse(await readFile(outboxFile, "utf8")) as { entries: Array<Record<string, unknown>> };
    assert.equal(persisted.entries[0]!.state, "failed");
    assert.deepEqual(persisted.entries[1], { from: "a newer build" });
    // Discarding it is the user's call.
    assert.deepEqual(await service.actOnMerge("child", "old", { action: "discard" }), { mergeId: "old", outcome: "discarded" });
    assert.equal(service.pending().length, 0);
    assert.deepEqual(published.get("child"), []);
    await cleanup();
  });

  it("the host's deadline refusal is retried under a NEW command id, once its retry delay has passed", async () => {
    const { world, service, advance, cleanup } = await setup({ parentBusy: true });
    await service.mergeBack("child", { commandId: "m1" });
    world.sessions.set("parent", summary("parent", { title: "Parent" }));
    world.threads.set("parent", snapshot());
    world.refuseWithDeadline();
    world.touch("parent");
    await settled(service);
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["m1"]);
    assert.deepEqual([service.pending()[0]!.state, service.pending()[0]!.attempts], ["queued", 1]);

    // Its own tab update, and any event before the delay has passed: no new attempt.
    world.touch("parent");
    world.touch("parent");
    await settled(service);
    assert.equal(world.turns.length, 1, "never back to back");

    // The delay passed: the retry is a new command (the host records no receipt for a
    // deadline, but a retry is a new attempt all the same).
    world.setTurnStatus(200);
    advance(1_000);
    world.touch("parent");
    await settled(service);
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["m1", "m1:1"]);
    assert.equal(service.pending().length, 0, "delivered on the retry");
    await cleanup();
  });

  it("three deadline refusals a delay apart fail it; Retry then delivers under a fresh id", async () => {
    const { world, service, published, advance, cleanup } = await setup({ parentBusy: true });
    await service.mergeBack("child", { commandId: "m1" });
    world.sessions.set("parent", summary("parent", { title: "Parent" }));
    world.threads.set("parent", snapshot());
    world.refuseWithDeadline();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      world.touch("parent");
      await settled(service);
      assert.equal(service.pending()[0]!.attempts, attempt);
      advance(1_000);
    }
    assert.equal(service.pending()[0]!.state, "failed", "failed after the third refusal of the moment");
    assert.equal(published.get("parent")?.[0]?.state, "failed", "the parent's tab shows it too");
    world.touch("parent");
    await settled(service);
    assert.equal(service.pending()[0]!.attempts, 3, "a failed merge waits for the user");

    world.setTurnStatus(200);
    assert.equal((await service.actOnMerge("parent", "m1", { action: "deliver" })).outcome, "sent");
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["m1", "m1:1", "m1:2", "m1:3"]);
    assert.equal(service.pending().length, 0);
    assert.deepEqual(published.get("child"), []);
    await cleanup();
  });

  it("a deadline refusal of a merge sent at once queues it rather than refusing the caller", async () => {
    const { world, service, advance, cleanup } = await setup();
    // A host from before the `detail` marker words it the same way: still the refusal of a moment.
    world.refuseWithDeadline(false);
    const result = await service.mergeBack("child", { commandId: "m7" });
    assert.equal(result.delivery, "queued");
    const [merge] = service.pending();
    assert.deepEqual([merge!.state, merge!.attempts, merge!.error], ["queued", 1, "codex thread/start timed out after 30000ms"]);
    world.setTurnStatus(200);
    advance(1_000);
    world.touch("parent");
    await settled(service);
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["m7", "m7:1"]);
    assert.equal(service.pending().length, 0);
    await cleanup();
  });

  it("a COMMAND_REJECTED (the thread's own state) fails a queued merge at once, its reason shown", async () => {
    const { world, service, published, cleanup } = await setup({ parentBusy: true });
    await service.mergeBack("child", { commandId: "m9" });
    world.sessions.set("parent", summary("parent", { title: "Parent" }));
    world.threads.set("parent", snapshot());
    world.setTurnStatus(409, "COMMAND_REJECTED");
    world.touch("parent");
    await settled(service);
    const [merge] = service.pending();
    assert.deepEqual([merge!.state, merge!.attempts, merge!.error], ["failed", 1, "refused: COMMAND_REJECTED"]);
    assert.equal(published.get("child")?.[0]?.error, "refused: COMMAND_REJECTED");
    await cleanup();
  });

  it("only the deadline is a refusal of the moment: any other COMMAND_REJECTED, or COMPACTION_UNAVAILABLE, fails at once", async () => {
    for (const [code, message] of [
      ["COMMAND_REJECTED", "This thread's session is in an error state. Stop the session or rewind to continue."],
      ["COMPACTION_UNAVAILABLE", "refused: COMPACTION_UNAVAILABLE"]
    ] as const) {
      const { world, service, cleanup } = await setup({ parentBusy: true });
      await service.mergeBack("child", { commandId: "m8" });
      world.sessions.set("parent", summary("parent", { title: "Parent" }));
      world.threads.set("parent", snapshot());
      world.setTurnStatus(409, code, { message });
      world.touch("parent");
      await settled(service);
      const [merge] = service.pending();
      assert.deepEqual([merge!.state, merge!.attempts, merge!.error], ["failed", 1, message], code);
      await cleanup();
    }
  });

  it("a caller's merge id is refused, never replaced: too long, blank, or holding the retry separator", async () => {
    const { service, world, cleanup } = await setup();
    for (const commandId of ["x".repeat(181), " ", "a:1", 7]) {
      await assert.rejects(
        service.mergeBack("child", { commandId } as never),
        (error: unknown) => error instanceof LineageError && error.code === "INVALID_COMMAND"
      );
    }
    assert.equal(world.turns.length, 0);
    // A merge sent at once is never queued, so nothing remembers it.
    await service.mergeBack("child", { commandId: "x".repeat(180) });
    assert.equal((service as unknown as { delivered: Map<string, number> }).delivered.size, 0);
    await cleanup();
  });

  it("a refusal that will not pass fails it at once; a 503 re-posts the SAME id", async () => {
    const { world, service, cleanup } = await setup({ parentBusy: true });
    await service.mergeBack("child", { commandId: "m2" });
    world.sessions.set("parent", summary("parent", { title: "Parent" }));
    world.threads.set("parent", snapshot());
    world.setTurnStatus(503);
    world.touch("parent");
    await settled(service);
    world.setTurnStatus(400, "INVALID_COMMAND");
    world.touch("parent");
    await settled(service);
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["m2", "m2"]);
    assert.deepEqual([service.pending()[0]!.state, service.pending()[0]!.attempts], ["failed", 1]);
    await cleanup();
  });

  it("a discard that races a delivery answers what happened: sent", async () => {
    const { world, service, cleanup } = await setup({ parentBusy: true });
    await service.mergeBack("child", { commandId: "m3" });
    world.sessions.set("parent", summary("parent", { title: "Parent" }));
    world.threads.set("parent", snapshot());
    // The drain gets into the lane first; the discard asked in the meantime runs after it.
    world.touch("parent");
    const discard = service.actOnMerge("child", "m3", { action: "discard" });
    await settled(service);
    assert.deepEqual(await discard, { mergeId: "m3", outcome: "sent", seq: 9 });
    await assert.rejects(service.actOnMerge("child", "nope", { action: "discard" }), /No pending merge/);
    await cleanup();
  });

  it("delivers now, past a parent a continuing goal keeps busy — one message, steering the turn", async () => {
    const { world, service, cleanup } = await setup({ parentBusy: true });
    world.sessions.set(
      "parent",
      summary("parent", { title: "Parent", goal: { objective: "x", status: "active", continuing: true } } as Partial<SessionSummary>)
    );
    await service.mergeBack("child", { commandId: "m1" });
    world.touch("parent");
    await settled(service);
    assert.equal(world.turns.length, 0, "the goal keeps it queued");
    const result = await service.actOnMerge("child", "m1", { action: "deliver" });
    assert.deepEqual(result, { mergeId: "m1", outcome: "sent", seq: 9 });
    assert.equal(world.turns.length, 1);
    assert.equal(world.turns[0]!.body.commandId, "m1");
    await assert.rejects(service.actOnMerge("child", "m1", { action: "deliver" }), /No pending merge/);
    await assert.rejects(service.actOnMerge("child", "m1", { action: "nope" } as never), /action must be/);
    await cleanup();
  });

  it("a merge to an idle parent with an older one queued waits behind it, oldest delivered first", async () => {
    const { world, service, cleanup } = await setup({ parentBusy: true });
    await service.mergeBack("child", { commandId: "older", text: "first" });
    // The parent goes idle; the bus event that would drain has not come yet.
    world.sessions.set("parent", summary("parent", { title: "Parent" }));
    world.threads.set("parent", snapshot());
    const newer = await service.mergeBack("child", { commandId: "newer", text: "second" });
    await settled(service);
    assert.equal(newer.delivery, "queued", "never overtakes the older one");
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["older"], "the older one went first");
    // The parent is busy with it now; at its next idle point the newer one follows.
    world.touch("parent");
    await settled(service);
    assert.deepEqual(world.turns.map((turn) => turn.body.commandId), ["older", "newer"]);
    assert.equal(service.pending().length, 0);
    await cleanup();
  });

  it("serializes concurrent merges to one idle parent, so neither steers into the other", async () => {
    const { world, service, cleanup } = await setup();
    // The fake parent goes busy the moment it takes a turn, as a real one does.
    const api = world.api;
    const request = api.request.bind(api);
    api.request = async (method, path, opts) => {
      const res = await request(method, path, opts);
      if (method === "POST" && path.endsWith("/turn")) {
        world.threads.set("parent", snapshot({ busy: true }));
      }
      return res;
    };
    const [a, b] = await Promise.all([
      service.mergeBack("child", { commandId: "a", text: "one" }),
      service.mergeBack("child", { commandId: "b", text: "two" })
    ]);
    assert.deepEqual([a.delivery, b.delivery], ["sent", "queued"]);
    assert.equal(world.turns.length, 1);
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
