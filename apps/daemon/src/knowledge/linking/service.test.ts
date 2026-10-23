import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import type { KnowledgeEntryMeta, KnowledgeLinkState, KnowledgeSettings } from "@orquester/api";
import { KNOWLEDGE_DEFAULT_SETTINGS } from "@orquester/api";
import { knowledgeMykgDir, knowledgeMykgInputDir, knowledgeStatePath, parseKnowledgeLinkingState } from "@orquester/config";
import { FakeClock } from "../../workflows/agent/testing/fake-clock.ts";
import type { KnowledgeEntryChange, KnowledgeGraphPort, KnowledgeRuntime, KnowledgeRuntimePort, KnowledgeSettingsPort, KnowledgeStorePort } from "../ports.ts";
import { mykgSessionPaths } from "./mykg-files.ts";
import type { SpawnMykg } from "./runner.ts";
import { KnowledgeLinkingService, type KnowledgeLinkingOptions } from "./service.ts";
import { FAKE_RUNTIME, FakeWorkerPort, fakeSpawn, type FakeAccountBehaviour } from "./testing.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Fakes of the other modules' ports
// ---------------------------------------------------------------------------

class FakeStore implements KnowledgeStorePort {
  readonly metas = new Map<string, KnowledgeEntryMeta>();
  readonly linkStates = new Map<string, KnowledgeLinkState>();
  constructor(readonly mykgInputDir: string) {}

  listMeta(): readonly KnowledgeEntryMeta[] {
    return [...this.metas.values()];
  }
  getMeta(id: string): KnowledgeEntryMeta | null {
    return this.metas.get(id) ?? null;
  }
  async getEntry(): Promise<null> {
    return null;
  }
  async setLinkState(ids: readonly string[], state: KnowledgeLinkState): Promise<void> {
    for (const id of ids) this.linkStates.set(id, state);
  }
  onChange(): () => void {
    return () => undefined;
  }

  async put(id: string, body: string): Promise<KnowledgeEntryChange> {
    const kind = this.metas.has(id) ? "edited" : "added";
    await mkdir(this.mykgInputDir, { recursive: true });
    await writeFile(join(this.mykgInputDir, `${id}.md`), body);
    this.metas.set(id, {
      id,
      title: id,
      kind: "note",
      author: null,
      handle: null,
      url: null,
      postedAt: null,
      savedAt: "t",
      updatedAt: "t",
      savedFrom: { by: "user" },
      collections: [],
      contentHash: createHash("sha256").update(body).digest("hex"),
      linkState: "pending"
    });
    return { kind, entryIds: [id] };
  }

  async remove(id: string): Promise<KnowledgeEntryChange> {
    this.metas.delete(id);
    await rm(join(this.mykgInputDir, `${id}.md`), { force: true });
    return { kind: "deleted", entryIds: [id] };
  }
}

class FakeGraph implements KnowledgeGraphPort {
  readonly loads: string[] = [];
  private nodes = 0;
  async load(outputDir: string): Promise<{ nodes: number; edges: number }> {
    this.loads.push(outputDir);
    const text = await readFile(join(outputDir, "nodes.jsonl"), "utf8");
    this.nodes = text.split("\n").filter(Boolean).length;
    return { nodes: this.nodes, edges: 0 };
  }
  counts(): { nodes: number; edges: number } {
    return { nodes: this.nodes, edges: 0 };
  }
}

class FakeSettings implements KnowledgeSettingsPort {
  on = true;
  value: KnowledgeSettings = { ...KNOWLEDGE_DEFAULT_SETTINGS, concurrency: 2 };
  private readonly listeners = new Set<() => void>();
  enabled(): boolean {
    return this.on;
  }
  get(): KnowledgeSettings {
    return this.value;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(on: boolean): void {
    this.on = on;
    for (const listener of this.listeners) listener();
  }
}

class FakeRuntime implements KnowledgeRuntimePort {
  value: KnowledgeRuntime | null = FAKE_RUNTIME;
  current(): KnowledgeRuntime | null {
    return this.value;
  }
  onChange(): () => void {
    return () => undefined;
  }
}

/** A child the test drives: it prints the session line and exits when told. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly args: readonly string[]) {
    super();
  }
  kill(signal: NodeJS.Signals): boolean {
    this.signalCode = signal;
    this.end();
    this.emit("close", null, signal);
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.end();
    this.emit("close", code, null);
  }
  private end(): void {
    this.stdout.end();
    this.stderr.end();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  appdir: string;
  clock: FakeClock;
  store: FakeStore;
  graph: FakeGraph;
  settings: FakeSettings;
  runtime: FakeRuntime;
  port: FakeWorkerPort;
  service: KnowledgeLinkingService;
  mykgDir: string;
  /** Resolves once `predicate` holds, re-checked on every status event. */
  until(predicate: () => boolean): Promise<void>;
  log(): Promise<{ argv: string[] }[]>;
}

async function harness(options: {
  appdir?: string;
  accounts?: string[];
  behaviour?: Record<string, FakeAccountBehaviour>;
  workerMode?: "auto" | "manual";
  spawn?: SpawnMykg;
  clock?: FakeClock;
  store?: FakeStore;
  extra?: Partial<KnowledgeLinkingOptions>;
} = {}): Promise<Harness> {
  let appdir = options.appdir;
  if (!appdir) {
    appdir = await mkdtemp(join(tmpdir(), "orq-linking-"));
    roots.push(appdir);
  }
  const clock = options.clock ?? new FakeClock("2026-10-23T10:00:00.000Z");
  const store = options.store ?? new FakeStore(knowledgeMykgInputDir(appdir));
  const graph = new FakeGraph();
  const settings = new FakeSettings();
  const runtime = new FakeRuntime();
  let service!: KnowledgeLinkingService;
  const port = new FakeWorkerPort(options.accounts ?? ["a1", "a2"], () => clock.now(), options.behaviour ?? {}, undefined, {
    next: (id) => service.workerNext(id),
    submit: (id, taskId, answer) => service.workerSubmit(id, taskId, answer)
  });
  port.mode = options.workerMode ?? "auto";
  service = new KnowledgeLinkingService({
    appdir,
    runtime,
    settings,
    store,
    graph,
    workers: port,
    clock,
    spawn: options.spawn ?? fakeSpawn,
    readCmdline: async () => null,
    ...options.extra
  });
  const mykgDir = knowledgeMykgDir(appdir);
  return {
    appdir,
    clock,
    store,
    graph,
    settings,
    runtime,
    port,
    service,
    mykgDir,
    until(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve) => {
        const check = (): void => {
          if (!predicate()) return;
          service.events.off("status", check);
          resolve();
        };
        service.events.on("status", check);
      });
    },
    async log() {
      try {
        return (await readFile(join(mykgDir, "fake-mykg.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    }
  };
}

const lastRun = (h: Harness) => h.service.snapshot().lastRun;
const ranOk = (h: Harness, runs: number) => () => h.service.snapshot().recentRuns.filter((run) => run.outcome === "ok").length >= runs;

async function readState(h: Harness) {
  return parseKnowledgeLinkingState(JSON.parse(await readFile(knowledgeStatePath(h.appdir), "utf8")));
}

const ID = (n: number) => `ke_${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KnowledgeLinkingService — the coalesced queue", () => {
  it("starts 20 s after the last change, never later than 2 min after the first; relabels never queue", async () => {
    const children: FakeChild[] = [];
    const h = await harness({
      spawn: (_file, args) => {
        const child = new FakeChild(args);
        children.push(child);
        return child as unknown as ChildProcess;
      }
    });
    await h.service.start();
    h.service.entriesChanged({ kind: "relabelled", entryIds: [ID(1)] });
    assert.deepEqual(h.service.status(), { state: "idle" });

    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    assert.deepEqual(h.service.status(), { state: "queued", pendingEntries: 1, startsAt: "2026-10-23T10:00:20.000Z" });
    // A change every 15 s keeps pushing the start back…
    for (let i = 2; i <= 8; i += 1) {
      await h.clock.advance(15_000);
      assert.equal(children.length, 0, `no run yet at ${i}`);
      h.service.entriesChanged(await h.store.put(ID(i), String(i)));
    }
    // …until the 2-minute cap after the first pending change (10:02:00).
    assert.equal((h.service.status() as { startsAt: string }).startsAt, "2026-10-23T10:02:00.000Z");
    await h.clock.advance(14_999);
    assert.equal(children.length, 0);
    await h.clock.advance(1);
    await h.until(() => children.length === 1);
    assert.deepEqual(children[0]!.args, ["extract-graph", knowledgeMykgInputDir(h.appdir)], "the first run is a full extract");
    const state = await readState(h);
    assert.equal(state.currentRun?.entryIds.length, 8, "the run is persisted with its entries before the child runs");
    assert.deepEqual(state.pendingEntryIds, []);

    // Saves during the run queue the next one.
    h.service.entriesChanged(await h.store.put(ID(9), "nine"));
    assert.equal(h.service.status().state, "running");
    assert.equal((h.service.status() as { pendingEntries: number }).pendingEntries, 1);
    const session = "2026-10-23T10-02-00";
    children[0]!.stdout.write(`Session: ${session}\n`);
    await h.until(() => (h.service.snapshot().lastRun?.id ?? "") !== "" && h.service.status().state === "running");
    const paths = mykgSessionPaths(h.mykgDir, session);
    await mkdir(paths.output, { recursive: true });
    await writeFile(paths.nodes, '{"id":"a"}\n');
    children[0]!.exit(0);
    await h.until(ranOk(h, 1));
    assert.equal(h.store.linkStates.get(ID(1)), "linked");
    assert.deepEqual(h.graph.loads, [paths.output]);
    // The queued change starts its own run once its debounce passes (it was saved during the run).
    await h.until(() => h.service.status().state === "queued");
    await h.clock.advance(20_000);
    await h.until(() => children.length === 2);
    assert.deepEqual(children[1]!.args, ["extract-graph", knowledgeMykgInputDir(h.appdir), "--session", session, "--update"]);
    children[1]!.exit(1);
    await h.service.idle();
    await h.service.stop();
  });
});

describe("KnowledgeLinkingService — link states", () => {
  it("an entry edited while its run is in flight stays pending and goes in the next run", async () => {
    const children: FakeChild[] = [];
    const h = await harness({
      spawn: (_file, args) => {
        const child = new FakeChild(args);
        children.push(child);
        return child as unknown as ChildProcess;
      }
    });
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    h.service.entriesChanged(await h.store.put(ID(2), "two"));
    await h.clock.advance(20_000);
    await h.until(() => children.length === 1);
    h.service.entriesChanged(await h.store.put(ID(1), "one, edited mid-run"));
    const session = "2026-10-23T10-00-20";
    children[0]!.stdout.write(`Session: ${session}\n`);
    const paths = mykgSessionPaths(h.mykgDir, session);
    await mkdir(paths.output, { recursive: true });
    await writeFile(paths.nodes, "");
    await h.until(() => h.service.snapshot().lastRun?.outcome === "running");
    children[0]!.exit(0);
    await h.until(ranOk(h, 1));
    assert.equal(h.store.linkStates.get(ID(2)), "linked");
    assert.equal(h.store.linkStates.has(ID(1)), false, "never marked linked from a stale extraction");
    assert.deepEqual((await readState(h)).pendingEntryIds, [ID(1)]);
    assert.equal(h.service.status().state, "queued");
    await h.service.stop();
  });
});

describe("KnowledgeLinkingService — runs against a fake myKG and fake worker chats", { timeout: 60_000 }, () => {
  it("links new entries through worker chats, then re-links only an edited one with --update", async () => {
    const h = await harness();
    await h.service.start();
    for (let i = 1; i <= 3; i += 1) h.service.entriesChanged(await h.store.put(ID(i), `Author: A\nentry ${i}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    const first = lastRun(h)!;
    assert.equal(first.mode, "full");
    assert.equal(first.tasks, 4, "one Pass 1 call and one Pass 2 call per entry");
    assert.equal(first.entries, 3);
    assert.ok(first.tokensIn > 0 && first.tokensOut > 0, "tokens from the chats' turns");
    for (let i = 1; i <= 3; i += 1) assert.equal(h.store.linkStates.get(ID(i)), "linked");
    const state = await readState(h);
    assert.ok(state.session, "the session myKG named is recorded");
    assert.equal(state.currentRun, null);
    assert.equal(h.graph.loads.at(-1), mykgSessionPaths(h.mykgDir, state.session!).output);
    // Instructions once per chat: the first Pass 2 task of a chat carries them, later ones point back.
    for (const session of h.port.sessions) {
      const seen = session.seenInstructions;
      const pass2 = seen.filter((s) => s === "PASS2-SYSTEM").length;
      assert.ok(pass2 <= 1, `chat ${session.id} got the Pass 2 instructions at most once: ${JSON.stringify(seen)}`);
    }
    assert.equal(h.port.sessions.flatMap((s) => s.seenInstructions).filter((s) => s === null).length >= 1, true);

    h.service.entriesChanged(await h.store.put(ID(2), "Author: A\nentry 2, edited"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    const second = lastRun(h)!;
    assert.equal(second.mode, "update");
    assert.equal(second.tasks, 1, "only the edited entry is extracted again");
    const argv = (await h.log()).map((entry) => entry.argv);
    assert.deepEqual(argv[1], ["extract-graph", knowledgeMykgInputDir(h.appdir), "--session", state.session, "--update"]);
    assert.equal(h.service.status().state, "idle");
    await h.service.stop();
  });

  it("fails over to another account on a usage limit and records the cooldown", async () => {
    const h = await harness({ accounts: ["a1", "a2"], behaviour: { a1: { limitAfter: 1, resetsAt: "2026-10-23T15:00:00.000Z" } } });
    h.settings.value.concurrency = 1;
    await h.service.start();
    for (let i = 1; i <= 3; i += 1) h.service.entriesChanged(await h.store.put(ID(i), `entry ${i}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    assert.deepEqual(h.port.coolDowns.map((c) => c.accountId), ["a1"]);
    assert.ok(h.port.sessions.some((s) => s.accountId === "a2" && s.answered.length > 0));
    assert.equal(lastRun(h)!.tasks, 4);
    await h.service.stop();
  });

  it("pauses with resumesAt when every account is limited, survives a restart, and resumes the same run", async () => {
    const first = await harness({ accounts: ["a1"], behaviour: { a1: { limitAfter: 1, resetsAt: "2026-10-23T15:00:00.000Z" } } });
    first.settings.value.concurrency = 1;
    await first.service.start();
    for (let i = 1; i <= 2; i += 1) first.service.entriesChanged(await first.store.put(ID(i), `entry ${i}`));
    await first.clock.advance(20_000);
    await first.until(() => first.service.status().state === "paused");
    assert.deepEqual(first.service.status(), {
      state: "paused",
      reason: "usage-limit",
      message: "Every account is at its limit.",
      resumesAt: "2026-10-23T15:00:00.000Z",
      pendingEntries: 0
    });
    const runId = (await readState(first)).currentRun!.id;
    // The daemon stops mid-run: the child goes, the run stays recorded.
    await first.service.stop();
    const persisted = await readState(first);
    assert.equal(persisted.currentRun?.id, runId);
    assert.ok(persisted.currentRun?.session, "the session the run created is known");

    const second = await harness({ appdir: first.appdir, store: first.store, accounts: ["b1"] });
    await second.service.start();
    await second.until(ranOk(second, 1));
    const run = lastRun(second)!;
    assert.equal(run.id, runId, "the interrupted run is re-run under its id");
    assert.equal(run.outcome, "ok");
    const argv = (await second.log()).map((entry) => entry.argv);
    assert.deepEqual(argv.at(-1), ["extract-graph", knowledgeMykgInputDir(first.appdir), "--session", persisted.currentRun!.session]);
    const answeredAfterRestart = second.port.sessions.reduce((sum, s) => sum + s.answered.length, 0);
    assert.equal(answeredAfterRestart, 2, "the task answered before the restart is not asked again");
    await second.service.stop();
  });

  it("a failed run keeps the error, marks its entries failed, and a later change retries it", async () => {
    const h = await harness();
    await h.service.start();
    await mkdir(h.mykgDir, { recursive: true });
    await writeFile(join(h.mykgDir, "fake-mykg.json"), JSON.stringify({ fail: "names did not normalize" }));
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    await h.clock.advance(20_000);
    await h.until(() => lastRun(h)?.outcome === "failed");
    assert.match(lastRun(h)!.error!, /normalize_names: names did not normalize/);
    assert.equal(h.store.linkStates.get(ID(1)), "failed");
    const status = h.service.status();
    assert.equal(status.state, "paused");
    assert.equal(status.state === "paused" && status.reason, "error");
    assert.equal(status.state === "paused" && status.resumesAt, "2026-10-23T10:30:20.000Z", "retried after 30 min");
    assert.match(h.service.snapshot().lastError!.message, /names did not normalize/);

    await rm(join(h.mykgDir, "fake-mykg.json"));
    h.service.entriesChanged(await h.store.put(ID(2), "two"));
    assert.equal(h.service.status().state, "queued", "a new change retries sooner");
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    assert.equal(h.store.linkStates.get(ID(1)), "linked");
    assert.equal(h.store.linkStates.get(ID(2)), "linked");
    await h.service.stop();
  });

  it("an update that died after myKG's ingest is re-run from the last good manifest: its edit and delete still land", async () => {
    const h = await harness();
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    h.service.entriesChanged(await h.store.put(ID(2), "two"));
    h.service.entriesChanged(await h.store.put(ID(3), "three"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    const session = (await readState(h)).session!;
    const paths = mykgSessionPaths(h.mykgDir, session);

    // myKG rewrites its manifest and evicts the edited and deleted entries' shards, then dies.
    await writeFile(join(h.mykgDir, "fake-mykg.json"), JSON.stringify({ failAfterEvict: "worker gone" }));
    h.service.entriesChanged(await h.store.put(ID(2), "two, edited"));
    h.service.entriesChanged(await h.store.remove(ID(3)));
    await h.clock.advance(20_000);
    await h.until(() => lastRun(h)?.outcome === "failed");
    assert.equal(h.store.linkStates.get(ID(2)), "failed");

    // The retry (30 min later) must still see the edit and the delete.
    await rm(join(h.mykgDir, "fake-mykg.json"));
    await h.clock.advance(30 * 60_000);
    await h.until(() => h.service.snapshot().recentRuns.filter((run) => run.outcome !== "running").length === 3);
    assert.equal(lastRun(h)!.outcome, "ok", lastRun(h)!.error ?? "");
    const nodes = (await readFile(paths.nodes, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { source_files: string[] });
    assert.deepEqual(nodes.map((node) => node.source_files[0]).sort(), [`${ID(1)}.md`, `${ID(2)}.md`], "the edited entry is extracted again and the deleted one is gone");
    const shard = JSON.parse(await readFile(join(paths.intermediate, "raw_extractions_shards", `${ID(2)}.md.json`), "utf8")) as { sha: string };
    assert.equal(shard.sha, createHash("sha256").update("two, edited").digest("hex"));
    assert.equal(h.store.linkStates.get(ID(2)), "linked");
    await h.service.stop();
  });

  it("turning the plugin off cancels the run and ends its chats; turning it on runs it again", async () => {
    const h = await harness({ workerMode: "manual" });
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    await h.clock.advance(20_000);
    await h.until(() => h.port.sessions.length === 1);
    h.settings.set(false);
    await h.until(() => lastRun(h)?.outcome === "cancelled");
    assert.equal(h.port.sessions[0]!.stopped?.interrupt, true, "the chat was interrupted and closed");
    assert.deepEqual(h.service.status(), { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries: 1 });
    h.port.mode = "auto";
    h.settings.set(true);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    assert.equal(h.store.linkStates.get(ID(1)), "linked");
    await h.service.stop();
  });

  it("rebuild extracts into a fresh session and switches to it only on success", async () => {
    const h = await harness();
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    const before = (await readState(h)).session!;
    assert.deepEqual(await h.service.rebuildEstimate(), { entries: 1, tasks: 5 }, "Pass 1 + harmonize + review, one Pass 2 call, one normalization call");
    await h.service.rebuild();
    await h.until(ranOk(h, 2));
    const run = lastRun(h)!;
    assert.equal(run.mode, "rebuild");
    const after = (await readState(h)).session!;
    assert.notEqual(after, before);
    assert.equal(h.graph.loads.at(-1), mykgSessionPaths(h.mykgDir, after).output);
    await assert.rejects(stat(mykgSessionPaths(h.mykgDir, before).root), "the old session is removed");
    assert.deepEqual((await readdir(join(h.mykgDir, "mykg_sessions"))).sort(), [after]);
    await h.service.stop();
  });

  it("a failed rebuild waits for the error retry like any failed run (no tight loop)", async () => {
    const h = await harness();
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    await writeFile(join(h.mykgDir, "fake-mykg.json"), JSON.stringify({ fail: "names did not normalize" }));
    await h.service.rebuild();
    await h.until(() => lastRun(h)?.mode === "rebuild" && lastRun(h)?.outcome === "failed");
    await h.service.idle();
    const spawned = (await h.log()).length;
    const status = h.service.status();
    assert.equal(status.state, "paused");
    assert.equal(status.state === "paused" && status.reason, "error");
    await h.clock.advance(1_000);
    await h.service.idle();
    assert.equal((await h.log()).length, spawned, "not started again at once");
    assert.equal(h.service.status().state, "paused");
    await rm(join(h.mykgDir, "fake-mykg.json"));
    await h.clock.advance(30 * 60_000);
    await h.until(ranOk(h, 2));
    assert.equal(lastRun(h)!.mode, "rebuild", "the rebuild is still owed, and runs at the retry");
    assert.equal((await h.log()).length, spawned + 1);
    await h.service.stop();
  });

  it("only the run's own worker chats pass the worker gate", async () => {
    const h = await harness({ workerMode: "manual" });
    await h.service.start();
    assert.equal(h.service.isActiveWorker({ kind: "knowledge-indexer", runId: "x" }), false);
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    await h.clock.advance(20_000);
    await h.until(() => h.port.sessions.length === 1);
    const runId = h.port.sessions[0]!.runId;
    assert.equal(h.service.isActiveWorker({ kind: "knowledge-indexer", runId }), true);
    assert.equal(h.service.isActiveWorker({ kind: "knowledge-indexer", runId: "kr_other" }), false);
    assert.equal(h.service.isActiveWorker({ kind: "workflow", workflowId: "w", runId, nodeId: "n" }), false);
    assert.equal(h.service.isActiveWorker(undefined), false);
    h.settings.set(false);
    await h.service.idle();
    await h.service.stop();
  });
});
