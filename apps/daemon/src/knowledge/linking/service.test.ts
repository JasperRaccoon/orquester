import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import type { KnowledgeConceptRef, KnowledgeEntry, KnowledgeEntryMeta, KnowledgeLinkState, KnowledgeSettings } from "@orquester/api";
import { KNOWLEDGE_DEFAULT_SETTINGS } from "@orquester/api";
import { knowledgeMykgDir, knowledgeMykgInputDir, knowledgePairChecksPath, knowledgeStatePath, parseKnowledgeLinkingState } from "@orquester/config";
import { FakeClock, flushAsync } from "../../workflows/agent/testing/fake-clock.ts";
import type {
  KnowledgeEntryChange,
  KnowledgeGraphPort,
  KnowledgeRoundTask,
  KnowledgeRoundTaskSource,
  KnowledgeRuntime,
  KnowledgeRuntimePort,
  KnowledgeSettingsPort,
  KnowledgeStorePort
} from "../ports.ts";
import { FAKE_THRESHOLDS, FakeVectorIndex, around, axis } from "../search/fake-vector-index.ts";
import { CONTEXT_HEADING, LINK_CONTEXT_VERSION, type KnowledgeLinkGraphView } from "./context.ts";
import { mykgSessionPaths } from "./mykg-files.ts";
import type { MykgProcessProbe, SpawnMykg } from "./runner.ts";
import { MAX_REFUSALS } from "./inbox.ts";
import { PAIR_CHECK_BODY_CHARS, PAIR_CHECK_INPUT_VERSION } from "./pair-checks.ts";
import { DEFAULT_NORMALIZE_TYPES, KnowledgeLinkingService, type KnowledgeLinkingOptions } from "./service.ts";
import { FAKE_RUNTIME, FakeWorkerPort, fakeSpawn, writeMykgTask, type FakeAccountBehaviour } from "./testing.ts";

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
  readonly bodies = new Map<string, string>();
  async getEntry(id: string): Promise<KnowledgeEntry | null> {
    const meta = this.metas.get(id);
    return meta ? { ...meta, body: this.bodies.get(id) ?? "" } : null;
  }
  async setLinkState(ids: readonly string[], state: KnowledgeLinkState): Promise<void> {
    for (const id of ids) {
      this.linkStates.set(id, state);
      const meta = this.metas.get(id);
      if (meta) this.metas.set(id, { ...meta, linkState: state });
    }
  }
  readonly linkContexts = new Map<string, number>();
  linkContext(id: string): number | null {
    return this.linkContexts.get(id) ?? null;
  }
  async setLinkContext(ids: readonly string[], version: number): Promise<void> {
    for (const id of ids) if (this.metas.has(id)) this.linkContexts.set(id, version);
  }
  onChange(): () => void {
    return () => undefined;
  }

  async put(id: string, body: string): Promise<KnowledgeEntryChange> {
    const kind = this.metas.has(id) ? "edited" : "added";
    await mkdir(this.mykgInputDir, { recursive: true });
    await writeFile(join(this.mykgInputDir, `${id}.md`), body);
    this.bodies.set(id, body);
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
  private nodes: { type?: string }[] = [];
  async load(outputDir: string): Promise<{ nodes: number; edges: number }> {
    this.loads.push(outputDir);
    const text = await readFile(join(outputDir, "nodes.jsonl"), "utf8");
    this.nodes = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string });
    return { nodes: this.nodes.length, edges: 0 };
  }
  counts(): { nodes: number; edges: number } {
    return { nodes: this.nodes.length, edges: 0 };
  }
  conceptTypes(): Map<string, number> {
    const types = new Map<string, number>();
    for (const node of this.nodes) if (typeof node.type === "string") types.set(node.type, (types.get(node.type) ?? 0) + 1);
    return types;
  }
  set(types: Record<string, number>): void {
    this.nodes = Object.entries(types).flatMap(([type, n]) => Array.from({ length: n }, () => ({ type })));
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
    processProbe: { cmdline: async () => null, startTime: async () => 777, signal: () => false },
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
  it("a save made while start() still loads the state reports queued, and is linked once loading finishes", async () => {
    const children: FakeChild[] = [];
    const h = await harness({
      spawn: (_file, args) => {
        const child = new FakeChild(args);
        children.push(child);
        return child as unknown as ChildProcess;
      }
    });
    const change = await h.store.put(ID(1), "one");
    const starting = h.service.start();
    // state.json is still being read: the change is buffered, and the status says it is waiting.
    h.service.entriesChanged(change);
    h.service.entriesChanged({ kind: "edited", entryIds: [ID(1)] });
    assert.deepEqual(h.service.status(), { state: "queued", pendingEntries: 1, startsAt: "2026-10-23T10:00:00.000Z" });
    await starting;
    assert.deepEqual(h.service.status(), { state: "queued", pendingEntries: 1, startsAt: "2026-10-23T10:00:20.000Z" });
    await h.clock.advance(20_000);
    await h.until(() => children.length === 1);
    assert.deepEqual((await readState(h)).currentRun?.entryIds, [ID(1)], "the run links it");
  });

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

describe("KnowledgeLinkingService — one child per run", () => {
  it("two environment changes in a row resume an interrupted run once, and a stopped service starts none", async () => {
    const children: FakeChild[] = [];
    const spawn: SpawnMykg = (_file, args) => {
      const child = new FakeChild(args);
      children.push(child);
      return child as unknown as ChildProcess;
    };
    const first = await harness({ spawn, workerMode: "manual" });
    await first.service.start();
    first.service.entriesChanged(await first.store.put(ID(1), "one"));
    await first.clock.advance(20_000);
    await first.until(() => children.length === 1);
    await first.service.stop();
    assert.ok((await readState(first)).currentRun, "the interrupted run stays recorded");

    const second = await harness({ appdir: first.appdir, store: first.store, spawn, workerMode: "manual" });
    second.settings.on = false;
    await second.service.start();
    assert.equal(children.length, 1);
    // The plugin comes on and, at once, another setting moves: both ask to resume the run.
    second.settings.set(true);
    second.settings.set(true);
    await second.until(() => second.service.status().state === "running");
    await flushAsync(20);
    assert.equal(children.length, 2, "one myKG child for the resumed run, never two on its session");

    // Stopping while a start is under way never leaves a child behind.
    await second.service.stop();
    const third = await harness({ appdir: first.appdir, store: first.store, spawn, workerMode: "manual" });
    const starting = third.service.start();
    await third.service.stop();
    await starting;
    await flushAsync(20);
    assert.equal(children.length, 2, "no child after stop()");
  });
});

describe("KnowledgeLinkingService — a myKG child left running by the previous daemon", () => {
  it("is stopped (SIGTERM, SIGKILL after the grace) and gone before the resumed run starts its own child", async () => {
    const events: string[] = [];
    const children: FakeChild[] = [];
    const spawn: SpawnMykg = (_file, args) => {
      const child = new FakeChild(args);
      children.push(child);
      events.push("spawn");
      return child as unknown as ChildProcess;
    };
    const probe = (alive: () => boolean, onSignal: (signal: NodeJS.Signals) => void): MykgProcessProbe => ({
      cmdline: async (pid) => (pid === 4242 && alive() ? `/venv/bin/python /venv/bin/mykg extract-graph ${knowledgeMykgInputDir(first.appdir)} --session s` : null),
      startTime: async (pid) => (pid === 4242 && alive() ? 777 : null),
      signal: (_pid, signal) => (onSignal(signal), true)
    });
    const first = await harness({ spawn, workerMode: "manual", extra: { processProbe: probe(() => true, () => undefined) } });
    await first.service.start();
    first.service.entriesChanged(await first.store.put(ID(1), "one"));
    await first.clock.advance(20_000);
    await first.until(() => children.length === 1);
    await first.service.stop();
    const recorded = (await readState(first)).currentRun!;
    assert.equal(recorded.pid, 4242);
    assert.equal(recorded.pidStartTime, 777, "the child's start time is recorded with its pid");

    // The daemon died without stopping its child: it is still running, and ignores SIGTERM.
    let survivor = true;
    let acknowledgeTerm!: () => void;
    const termSent = new Promise<void>((resolve) => { acknowledgeTerm = resolve; });
    const second = await harness({
      appdir: first.appdir,
      store: first.store,
      spawn,
      workerMode: "manual",
      extra: {
        processProbe: probe(
          () => survivor,
          (signal) => {
            events.push(signal);
            if (signal === "SIGTERM") acknowledgeTerm();
            if (signal === "SIGKILL") survivor = false;
          }
        )
      }
    });
    let started = false;
    const starting = second.service.start().then(() => (started = true));
    // State loading uses real I/O: measure the grace after SIGTERM, not after calling start().
    await Promise.race([termSent, starting]);
    await second.clock.advance(9_000);
    assert.deepEqual(events, ["spawn", "SIGTERM"], "no new child while the old one may still write to the session");
    assert.equal(started, false);
    await second.clock.advance(1_000);
    await starting;
    assert.deepEqual(events, ["spawn", "SIGTERM", "SIGKILL", "spawn"]);
    await second.service.stop();
  });

  it("a survivor that cannot be stopped pauses the run with an error instead of starting a second child", async () => {
    let spawned = 0;
    const spawn: SpawnMykg = (_file, args) => {
      spawned += 1;
      return new FakeChild(args) as unknown as ChildProcess;
    };
    const first = await harness({ spawn, workerMode: "manual" });
    await first.service.start();
    first.service.entriesChanged(await first.store.put(ID(1), "one"));
    await first.clock.advance(20_000);
    await first.until(() => spawned === 1);
    await first.service.stop();
    const stuck: MykgProcessProbe = {
      cmdline: async () => `/venv/bin/mykg extract-graph ${knowledgeMykgInputDir(first.appdir)}`,
      startTime: async () => 777,
      signal: () => true
    };
    const second = await harness({ appdir: first.appdir, store: first.store, spawn, workerMode: "manual", extra: { processProbe: stuck } });
    let started = false;
    const starting = second.service.start().then(() => (started = true));
    // The service waits on its clock (SIGTERM's grace, then SIGKILL's): time moves until it gives up.
    while (!started) await second.clock.advance(1_000);
    await starting;
    assert.equal(spawned, 1);
    const status = second.service.status();
    assert.equal(status.state, "paused");
    assert.equal(status.state === "paused" && status.reason, "error");
    assert.match(second.service.snapshot().lastError?.message ?? "", /did not stop/);
    assert.ok((await readState(second)).currentRun, "the run stays recorded for the retry");
    await second.service.stop();
  });
});

describe("KnowledgeLinkingService — tasks a previous myKG process left in the inbox", () => {
  it("a re-run hands workers only the tasks its own process asks for; answered tasks stay cached", async () => {
    const children: FakeChild[] = [];
    const clock = new FakeClock("2026-10-23T10:00:00.000Z");
    const settleMs = 120_000;
    let settlementStarted: (() => void) | null = null;
    const setTimeout = clock.setTimeout.bind(clock);
    clock.setTimeout = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (ms === settleMs) settlementStarted?.();
      return timer;
    };
    const h = await harness({
      clock,
      workerMode: "manual",
      spawn: (_file, args) => {
        const child = new FakeChild(args);
        children.push(child);
        return child as unknown as ChildProcess;
      }
    });
    const failRun = async (child: FakeChild): Promise<void> => {
      const settling = new Promise<void>((resolve) => { settlementStarted = resolve; });
      child.exit(1);
      const drained = h.service.idle();
      // The child's close handler reads progress from disk before it asks the
      // workers to settle. Advance only once that timer exists, or the run has
      // already drained without workers; filesystem latency cannot move it past
      // a fixed clock jump and leave idle() waiting on frozen time.
      await Promise.race([settling, drained]);
      settlementStarted = null;
      await clock.advance(settleMs);
      await drained;
    };
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    await h.clock.advance(20_000);
    await h.until(() => children.length === 1);
    const session = "2026-10-23T10-00-20";
    children[0]!.stdout.write(`Session: ${session}\n`);
    const paths = mykgSessionPaths(h.mykgDir, session);
    const inbox = join(paths.intermediate, "agent_inbox");
    const outbox = join(paths.intermediate, "agent_outbox");
    await h.until(() => h.service.snapshot().lastRun?.outcome === "running");
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox, { recursive: true });
    // The first process asked for two tasks; one was answered, then it died.
    const answered = await writeMykgTask(inbox, { system: "PASS1", user: "corpus", step: "pass1", context: "pass1 batch 0/1", createdAt: "2026-10-23T10:00:21.000Z" });
    await writeFile(join(outbox, `${answered}.answer.json`), JSON.stringify({ task_id: answered, answer: "{}" }));
    await writeFile(join(outbox, `${answered}.done`), "");
    const leftover = await writeMykgTask(inbox, { system: "PASS2", user: "FILE old.md", step: "pass2", context: "pass2 batch 1", createdAt: "2026-10-23T10:00:22.000Z" });
    // The run waits for its chats to end their turns (they never do here), then records the failure.
    await failRun(children[0]!);
    assert.equal(lastRun(h)?.outcome, "failed");

    // The retry resumes the session with a new process.
    await h.clock.advance(30 * 60_000);
    await h.until(() => children.length === 2);
    await h.until(() => h.service.status().state === "running");
    assert.deepEqual(children[1]!.args.slice(-2), ["--session", session]);
    assert.deepEqual(await readdir(inbox), [`${answered}.task.json`], "the previous process's unanswered task is gone");
    assert.deepEqual((await readdir(outbox)).sort(), [`${answered}.answer.json`, `${answered}.done`].sort(), "answers are kept for myKG's cache");
    // The live process asks for its own task (created later than the leftover was).
    const live = await writeMykgTask(inbox, { system: "PASS2", user: "FILE ke_000000000001.md", step: "pass2", context: "pass2 batch 1", createdAt: "2026-10-23T10:32:00.000Z" });
    const reply = await h.service.workerNext("probe-worker");
    assert.equal(reply.kind, "task");
    assert.equal(reply.kind === "task" && reply.task.taskId, live);
    assert.notEqual(live, leftover);
    await failRun(children[1]!);
    await h.service.stop();
  });
});

describe("KnowledgeLinkingService — the rebuild estimate", () => {
  it("counts one name-normalization call per concept type of the current graph that has names to merge", async () => {
    const h = await harness();
    await h.service.start();
    assert.deepEqual(await h.service.rebuildEstimate(), { entries: 0, tasks: 0 });
    for (let i = 1; i <= 100; i += 1) await h.store.put(ID(i), "x".repeat(400));
    // Pass 1: one 16k batch + harmonize + review = 3; Pass 2: one call per entry = 100.
    h.graph.set({ Person: 30, Organization: 12, Tool: 2, Metric: 1 });
    assert.deepEqual(await h.service.rebuildEstimate(), { entries: 100, tasks: 3 + 100 + 3 }, "a type with a single name is never sent");
    h.graph.set({});
    assert.deepEqual(
      await h.service.rebuildEstimate(),
      { entries: 100, tasks: 3 + 100 + DEFAULT_NORMALIZE_TYPES },
      "no graph yet: the default number of types"
    );
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

describe("KnowledgeLinkingService — link states (metadata edits)", () => {
  it("an entry whose title or author is edited mid-run (its body hash unchanged) stays pending too", async () => {
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
    // The store's `edited` for a title change: the mirror moved, the body's contentHash did not.
    h.service.entriesChanged({ kind: "edited", entryIds: [ID(1)] });
    const session = "2026-10-23T10-00-20";
    children[0]!.stdout.write(`Session: ${session}\n`);
    const paths = mykgSessionPaths(h.mykgDir, session);
    await mkdir(paths.output, { recursive: true });
    await writeFile(paths.nodes, "");
    await h.until(() => h.service.snapshot().lastRun?.outcome === "running");
    children[0]!.exit(0);
    await h.until(ranOk(h, 1));
    assert.equal(h.store.linkStates.get(ID(2)), "linked");
    assert.equal(h.store.linkStates.has(ID(1)), false, "its new header line is not in the graph yet");
    assert.deepEqual((await readState(h)).pendingEntryIds, [ID(1)]);
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
    // The retry resumed the failed run's session (no new ingest): entry 2 goes in the next update.
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
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

  it("an entry saved after a failed first run, whose session the retry resumes, is linked by an update, not claimed", async () => {
    const h = await harness();
    await h.service.start();
    await mkdir(h.mykgDir, { recursive: true });
    await writeFile(join(h.mykgDir, "fake-mykg.json"), JSON.stringify({ fail: "names did not normalize" }));
    h.service.entriesChanged(await h.store.put(ID(1), "one"));
    h.service.entriesChanged(await h.store.put(ID(2), "two"));
    await h.clock.advance(20_000);
    await h.until(() => lastRun(h)?.outcome === "failed");
    await h.service.idle();
    assert.ok((await readState(h)).resumeSession, "the session the failed full run made is resumed next");

    await rm(join(h.mykgDir, "fake-mykg.json"));
    h.service.entriesChanged(await h.store.put(ID(3), "three"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    assert.equal(lastRun(h)!.mode, "full");
    // myKG resumed the session without a new ingest: entry 3 is not in it yet.
    assert.notEqual(h.store.linkStates.get(ID(3)), "linked", "never marked linked while it is not in the graph");
    assert.deepEqual((await readState(h)).pendingEntryIds, [ID(3)]);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(lastRun(h)!.mode, "update");
    assert.equal(h.store.linkStates.get(ID(3)), "linked");
    const nodes = (await readFile(h.graph.loads.at(-1)! + "/nodes.jsonl", "utf8")).trim().split("\n");
    assert.equal(nodes.length, 3);
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

describe("KnowledgeLinkingService — pair-check chats a crashed daemon left", () => {
  it("are interrupted, their tokens counted, closed and marked done at start; a run's own chats are left to its resume", async () => {
    const h = await harness();
    const worker = (sessionId: string, runId: string, state: "running" | "done") => ({ sessionId, accountId: "a1", runId, state, tasks: 1, startedAt: "2026-10-23T09:00:00.000Z", finishedAt: null });
    await mkdir(dirname(knowledgeStatePath(h.appdir)), { recursive: true });
    await writeFile(
      knowledgeStatePath(h.appdir),
      JSON.stringify({
        version: 1,
        workers: [worker("pair-1", "kp_aaaaaaaaaaaa", "running"), worker("pair-2", "kp_aaaaaaaaaaaa", "running"), worker("pair-old", "kp_000000000000", "done"), worker("run-1", "kr_bbbbbbbbbbbb", "running")],
        tokens: { total: { in: 10, out: 1 }, byDay: {} }
      })
    );
    h.port.foreignUsage.set("pair-1", { in: 700, out: 70 });
    h.port.foreignUsage.set("pair-2", { in: 300, out: 30 });
    await h.service.start();
    await h.service.pairChecksIdle();
    for (const id of ["pair-1", "pair-2"]) {
      assert.deepEqual(
        h.port.calls.filter((call) => call.endsWith(`:${id}`)),
        [`interrupt:${id}`, `usage:${id}`, `stop:${id}`],
        id
      );
    }
    assert.ok(!h.port.calls.some((call) => call.endsWith(":run-1") || call.endsWith(":pair-old")));
    const snapshot = h.service.snapshot();
    assert.deepEqual(snapshot.tokens.total, { in: 1010, out: 101 });
    assert.deepEqual(
      snapshot.workers.map((w) => [w.sessionId, w.state]),
      [
        ["pair-1", "done"],
        ["pair-2", "done"],
        ["pair-old", "done"],
        ["run-1", "running"]
      ]
    );
    await h.service.stop();
    const state = await readState(h);
    assert.deepEqual(state.tokens.total, { in: 1010, out: 101 });
    assert.ok(state.workers.filter((w) => w.sessionId.startsWith("pair-") && w.sessionId !== "pair-old").every((w) => w.state === "done" && w.finishedAt !== null));
  });
});

describe("KnowledgeLinkingService — a state.json a newer Orquester wrote", () => {
  const SESSION = "2026-10-20T08-00-00";
  async function newerState(h: Harness, extra: Record<string, unknown>): Promise<string> {
    const paths = mykgSessionPaths(h.mykgDir, SESSION);
    await mkdir(paths.output, { recursive: true });
    await writeFile(paths.nodes, '{"id":"a","type":"Person"}\n');
    const text = `${JSON.stringify(
      {
        version: 2,
        session: SESSION,
        pendingEntryIds: [],
        currentRun: { id: "kr_newer", mode: "update", startedAt: "2026-10-23T09:00:00.000Z", session: SESSION, entryIds: [ID(1)], entryHashes: {}, tasks: 0, tokensIn: 0, tokensOut: 0, pid: null, pidStartTime: null, stage: "newer" },
        recentRuns: [{ id: "kr_0", mode: "full", startedAt: "t0", finishedAt: "t1", durationMs: 5, entries: 1, tasks: 3, tokensIn: 10, tokensOut: 4, outcome: "ok", error: null }],
        futureField: { kept: true },
        ...extra
      },
      null,
      2
    )}\n`;
    await mkdir(dirname(knowledgeStatePath(h.appdir)), { recursive: true });
    await writeFile(knowledgeStatePath(h.appdir), text);
    return text;
  }

  it("keeps the session and runs, links nothing, says why, and rewrites the file with its version and unknown fields", async () => {
    let spawned = 0;
    const h = await harness({ spawn: (file, args, options) => (spawned++, fakeSpawn(file, args, options)) });
    await newerState(h, {});
    await h.service.start();
    assert.deepEqual(h.graph.loads, [mykgSessionPaths(h.mykgDir, SESSION).output], "the recorded graph is still served");
    assert.equal(h.service.graphDir(), mykgSessionPaths(h.mykgDir, SESSION).output);
    const status = h.service.status();
    assert.equal(status.state, "paused");
    assert.equal(status.state === "paused" && status.reason, "error");
    assert.match(status.state === "paused" ? status.message : "", /newer Orquester/);
    assert.match(h.service.snapshot().lastError?.message ?? "", /newer Orquester/);
    assert.deepEqual(h.service.snapshot().recentRuns.map((run) => run.id), ["kr_0"]);

    h.service.entriesChanged(await h.store.put(ID(2), "two"));
    await h.service.rebuild();
    await h.clock.advance(60 * 60_000);
    await h.service.idle();
    assert.equal(spawned, 0, "no myKG child on a newer build's session");
    assert.equal(h.service.status().state, "paused");
    const written = JSON.parse(await readFile(knowledgeStatePath(h.appdir), "utf8")) as Record<string, unknown>;
    assert.equal(written.version, 2);
    assert.deepEqual(written.futureField, { kept: true });
    assert.equal((written.currentRun as Record<string, unknown>).stage, "newer");
    assert.deepEqual(written.pendingEntryIds, [ID(2)]);
    assert.equal(written.lastError ?? null, null, "the notice is not written into the newer file");
    assert.deepEqual((await readdir(dirname(knowledgeStatePath(h.appdir)))).filter((name) => name.includes("unreadable")), [], "never moved aside");
    await h.service.stop();
  });

  it("never writes over a newer file holding a field this build cannot read", async () => {
    const h = await harness();
    const text = await newerState(h, { pendingEntryIds: { byCollection: { c1: [ID(1)] } } });
    await h.service.start();
    assert.equal(h.service.status().state, "paused");
    h.service.entriesChanged(await h.store.put(ID(2), "two"));
    await h.service.rebuild();
    assert.equal(await readFile(knowledgeStatePath(h.appdir), "utf8"), text, "byte for byte as the newer build wrote it");
    await h.service.stop();
  });
});

// ---------------------------------------------------------------------------
// Phase 2: neighbour context, automatic re-linking, link gaps, pair checks
// ---------------------------------------------------------------------------

/** Search and the concept graph as linking reads them: every entry close to every other, sharing one concept. */
function fakeGraphView() {
  const index = new FakeVectorIndex();
  index.limits = null; // no embedder yet: no context, no re-linking
  const concepts = new Map<string, KnowledgeConceptRef[]>();
  const view: KnowledgeLinkGraphView = {
    vectors: () => index,
    conceptsOf: (id) => concepts.get(id) ?? [],
    contradicting: () => []
  };
  /** The embedder is loaded and the entries have vectors and concepts. */
  const ready = (ids: readonly string[]): void => {
    index.limits = FAKE_THRESHOLDS;
    ids.forEach((id, i) => {
      index.set(id, around(16, 0, (i % 15) + 1, 0.9));
      concepts.set(id, [
        { id: "tactic-shared", type: "Tactic", name: "Shared tactic" },
        { id: `tool-${i}`, type: "Tool", name: `Tool ${i}` }
      ]);
    });
  };
  return { index, concepts, view, ready };
}

const pass2Inputs = (h: Harness) => h.port.sessions.flatMap((s) => s.inputs).filter((i) => i.step === "pass2");
const withContext = (h: Harness) => pass2Inputs(h).filter((i) => i.input.includes(CONTEXT_HEADING)).length;

describe("KnowledgeLinkingService — phase 2: re-linking with neighbour context", { timeout: 120_000 }, () => {
  it("re-links entries linked without context in batches of 25 once no save waits, myKG really asks again, and the status counts", async () => {
    const graph = fakeGraphView();
    const h = await harness({ extra: { graphView: graph.view } });
    await h.service.start();
    const ids = Array.from({ length: 30 }, (_, i) => ID(i + 1));
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `Author: A\n\n# ${id}\n\nbody of ${id}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    assert.equal(h.store.linkContexts.size, 0, "linked before context could be built: no version");
    assert.equal(h.service.snapshot().relink, null, "no embedder: nothing to re-link yet");
    assert.equal(withContext(h), 0);

    // The embedder is loaded; any environment change reschedules.
    graph.ready(ids);
    h.settings.set(true);
    assert.deepEqual(h.service.snapshot().relink, { pending: 30, done: 0, total: 30 });
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    const second = lastRun(h)!;
    assert.equal(second.mode, "update");
    assert.equal(second.entries, 25, "at most 25 per run");
    assert.equal(second.tasks, 25, "myKG asked again for every entry of the batch (manifest keys dropped, cached answers cleared)");
    assert.equal(withContext(h), 25, "and every one of those tasks carried the neighbour context");
    assert.equal(h.store.linkContexts.size, 25);
    assert.deepEqual(h.service.snapshot().relink, { pending: 5, done: 25, total: 30 });
    const state = await readState(h);
    assert.equal(state.schema.changedSince, 0, "re-linked entries never count toward schema growth");
    assert.equal(state.relink.prepared.length, 0);

    await h.clock.advance(20_000);
    await h.until(ranOk(h, 3));
    assert.equal(lastRun(h)!.entries, 5);
    assert.equal(withContext(h), 30);
    assert.ok(ids.every((id) => h.store.linkContexts.get(id) === LINK_CONTEXT_VERSION));
    assert.equal(h.service.snapshot().relink, null, "nothing left");
    assert.equal((await readState(h)).relink.done, 0, "the next wave counts from zero");
    const argv = (await h.log()).map((entry) => entry.argv);
    assert.ok(argv.slice(1).every((a) => a.includes("--update")));
    // Nothing more to do: no further run.
    await h.clock.advance(60_000);
    await h.service.idle();
    assert.equal(h.service.snapshot().recentRuns.length, 3);
    await h.service.stop();
  });

  it("after a restart, re-linking starts once the entry vectors have loaded: no entry change or setting change is needed", async () => {
    const graph = fakeGraphView();
    const first = await harness({ extra: { graphView: graph.view } });
    const ids = [ID(1), ID(2), ID(3)];
    // Linked before phase 2 (no context version), then the daemon stops.
    await first.service.start();
    for (const id of ids) first.service.entriesChanged(await first.store.put(id, `body of ${id}`));
    await first.clock.advance(20_000);
    await first.until(ranOk(first, 1));
    await first.service.stop();

    // The next start: the embedder is there, but the vectors are still loading.
    let settle!: () => void;
    const loaded = new Promise<void>((resolve) => (settle = resolve));
    graph.index.limits = FAKE_THRESHOLDS;
    const view: KnowledgeLinkGraphView = { ...graph.view, vectorsSettled: () => loaded };
    const second = await harness({ appdir: first.appdir, store: first.store, extra: { graphView: view } });
    await second.service.start();
    assert.equal(second.service.snapshot().relink, null, "no vectors yet: nothing to re-link");
    await second.clock.advance(60_000);
    assert.equal(second.service.snapshot().recentRuns.length, 1, "no run while the vectors load");

    // They load (nothing else happens): linking looks again and re-links.
    graph.ready(ids);
    settle();
    await second.until(() => second.service.snapshot().relink !== null);
    assert.deepEqual(second.service.snapshot().relink, { pending: 3, done: 0, total: 3 });
    await second.clock.advance(20_000);
    await second.until(ranOk(second, 2));
    assert.equal(lastRun(second)!.entries, 3);
    assert.equal(withContext(second), 3);
    await second.service.stop();
  });

  it("a waiting save goes first; the plugin switched off pauses re-linking; a restart resumes the batch without asking again what it already answered", async () => {
    const graph = fakeGraphView();
    const first = await harness({ accounts: ["a1"], extra: { graphView: graph.view } });
    first.settings.value.concurrency = 1;
    const ids = [ID(1), ID(2), ID(3)];
    // Linked before phase 2 (no context version): a first run with no embedder.
    await first.service.start();
    for (const id of ids) first.service.entriesChanged(await first.store.put(id, `body of ${id}`));
    await first.clock.advance(20_000);
    await first.until(ranOk(first, 1));
    graph.ready([...ids, ID(4)]);

    // A save arrives as re-linking becomes possible: its run carries only the save.
    first.service.entriesChanged(await first.store.put(ID(4), "a new save"));
    await first.clock.advance(20_000);
    await first.until(ranOk(first, 2));
    assert.equal(lastRun(first)!.entries, 1, "the save is served first, alone");
    assert.equal(first.store.linkContexts.get(ID(4)), LINK_CONTEXT_VERSION, "linked with context");
    assert.deepEqual(first.service.snapshot().relink, { pending: 3, done: 0, total: 3 });

    // Plugin off: re-linking waits with the rest.
    first.settings.set(false);
    await first.clock.advance(60_000);
    assert.equal(first.service.status().state, "paused");
    assert.equal(first.service.snapshot().recentRuns.length, 2, "no run while off");
    assert.deepEqual(first.service.snapshot().relink, { pending: 3, done: 0, total: 3 });

    // On again: the re-link run starts, answers one task, then the only account hits its limit.
    first.port.behaviour.a1 = { limitAfter: 1, resetsAt: "2026-10-23T15:00:00.000Z" };
    first.settings.set(true);
    await first.clock.advance(20_000);
    await first.until(() => first.service.status().state === "paused" && (first.service.status() as { reason: string }).reason === "usage-limit");
    const persisted = await readState(first);
    assert.deepEqual(persisted.currentRun?.relinkEntryIds, ids);
    assert.deepEqual(persisted.relink.prepared, ids, "prepared before the child was spawned");
    await first.service.stop();

    const second = await harness({ appdir: first.appdir, store: first.store, accounts: ["b1"], extra: { graphView: graph.view } });
    await second.service.start();
    await second.until(() => lastRun(second)?.id === persisted.currentRun!.id && lastRun(second)?.outcome === "ok");
    assert.equal(lastRun(second)!.id, persisted.currentRun!.id, "the same run, resumed");
    assert.equal(pass2Inputs(second).length, 2, "the answer given with context before the restart was kept, not cleared again");
    assert.equal(withContext(second), 2);
    assert.ok(ids.every((id) => first.store.linkContexts.get(id) === LINK_CONTEXT_VERSION));
    assert.equal(second.service.snapshot().relink, null);
    await second.service.stop();
  });

  it("records the context version only for entries whose task was shown context; never re-links an entry without a vector", async () => {
    const graph = fakeGraphView();
    const h = await harness({ extra: { graphView: graph.view } });
    await h.service.start();
    const ids = [ID(1), ID(2), ID(3), ID(4)];
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    // 1 and 2 are close and have concepts; 3 has a vector but no neighbour close enough; 4 has none yet.
    graph.ready([ID(1), ID(2)]);
    graph.index.set(ID(3), axis(16, 15));
    h.settings.set(true);
    assert.deepEqual(h.service.snapshot().relink, { pending: 3, done: 0, total: 3 }, "no vector: not taken");
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(lastRun(h)!.entries, 3);
    assert.equal(withContext(h), 2);
    assert.deepEqual(
      ids.map((id) => h.store.linkContexts.get(id) ?? null),
      [LINK_CONTEXT_VERSION, LINK_CONTEXT_VERSION, null, null],
      "3 was re-linked without a context block: no version"
    );
    const state = await readState(h);
    assert.deepEqual(Object.keys(state.relink.attempts).sort(), [ID(1), ID(2), ID(3)]);
    assert.equal(state.currentRun, null);
    assert.equal(h.service.snapshot().relink, null, "3 is not taken again at this version and content");
    await h.clock.advance(60_000);
    await h.service.idle();
    assert.equal(h.service.snapshot().recentRuns.length, 2, "no run re-links 3 again");
    // Once 4 has a vector it is re-linked.
    graph.ready([ID(1), ID(2), ID(4)]);
    h.settings.set(true);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 3));
    assert.equal(lastRun(h)!.entries, 1);
    assert.equal(h.store.linkContexts.get(ID(4)), LINK_CONTEXT_VERSION);
    await h.service.stop();
  });

  it("a context version that cannot be saved never re-links the entry again and again", async () => {
    const graph = fakeGraphView();
    const appdir = await tempAppdir();
    const store = new FailingContextStore(knowledgeMykgInputDir(appdir));
    const h = await harness({ appdir, store, extra: { graphView: graph.view } });
    await h.service.start();
    const ids = [ID(1), ID(2)];
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    graph.ready(ids);
    h.settings.set(true);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(lastRun(h)!.entries, 2);
    assert.equal(store.linkContexts.size, 0, "the version could not be saved");
    assert.equal(h.service.snapshot().relink, null);
    for (let i = 0; i < 3; i += 1) await h.clock.advance(60_000);
    await h.service.idle();
    assert.equal(h.service.snapshot().recentRuns.length, 2, "no second re-link of the same entries");
    await h.service.stop();
  });

  it("a re-link that fails to extract an entry is retried twice, then given up on and reported", async () => {
    const graph = fakeGraphView();
    const h = await harness({ extra: { graphView: graph.view } });
    await h.service.start();
    const ids = [ID(1), ID(2)];
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    graph.ready(ids);
    await writeFile(join(h.mykgDir, "fake-mykg.json"), JSON.stringify({ failFiles: [`${ID(1)}.md`] }));
    h.settings.set(true);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(h.store.linkStates.get(ID(1)), "failed", "its re-link failed: out of the graph");
    assert.equal(h.store.linkContexts.get(ID(2)), LINK_CONTEXT_VERSION);
    assert.deepEqual(h.service.snapshot().relink, { pending: 1, done: 2, total: 3 }, "due a retry");
    // Two retries, each failing again.
    for (const runs of [3, 4]) {
      await h.clock.advance(20_000);
      await h.until(ranOk(h, runs));
      assert.equal(lastRun(h)!.entries, 1);
      assert.equal(h.store.linkStates.get(ID(1)), "failed");
    }
    assert.equal(h.service.snapshot().relink, null, "given up on");
    assert.match(h.service.snapshot().lastError?.message ?? "", new RegExp(`failed 3 times.*${ID(1)}`));
    assert.equal((await readState(h)).relink.attempts[ID(1)]?.failures, 3);
    for (let i = 0; i < 3; i += 1) await h.clock.advance(60_000);
    await h.service.idle();
    assert.equal(h.service.snapshot().recentRuns.length, 4, "no fourth try");
    await h.service.stop();
  });

  it("a re-link that failed once is retried and, linked this time, is back in the graph", async () => {
    const graph = fakeGraphView();
    const h = await harness({ extra: { graphView: graph.view } });
    await h.service.start();
    h.service.entriesChanged(await h.store.put(ID(1), "body of 1"));
    h.service.entriesChanged(await h.store.put(ID(2), "body of 2"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    graph.ready([ID(1), ID(2)]);
    await writeFile(join(h.mykgDir, "fake-mykg.json"), JSON.stringify({ failFiles: [`${ID(1)}.md`] }));
    h.settings.set(true);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(h.store.linkStates.get(ID(1)), "failed");
    await rm(join(h.mykgDir, "fake-mykg.json"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 3));
    assert.equal(h.store.linkStates.get(ID(1)), "linked");
    assert.equal(h.store.linkContexts.get(ID(1)), LINK_CONTEXT_VERSION);
    assert.equal((await readState(h)).relink.attempts[ID(1)]?.failures, 0);
    assert.equal(h.service.snapshot().relink, null);
    await h.service.stop();
  });
});

/** A store whose linking-context writes fail (a disk error, a file that does not read back). */
class FailingContextStore extends FakeStore {
  override async setLinkContext(): Promise<void> {
    throw new Error("disk full");
  }
}

async function tempAppdir(): Promise<string> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-linking-"));
  roots.push(appdir);
  return appdir;
}

describe("KnowledgeLinkingService — phase 2: link-gap scans", { timeout: 120_000 }, () => {
  it("a graph load that changed nothing the scan reads (the vectors, the graph's content) is not scanned again", async () => {
    const graph = fakeGraphView();
    let revision = 1;
    const view: KnowledgeLinkGraphView = { ...graph.view, graphRevision: () => revision };
    const h = await harness({ extra: { graphView: view } });
    const ids = [ID(1), ID(2), ID(3)];
    graph.ready(ids);
    graph.concepts.set(ID(3), [{ id: "tool-x", type: "Tool", name: "X" }]);
    await h.service.start();
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    const pairs = async () => Object.keys((await readState(h)).relink.gapPairs).sort();
    assert.deepEqual(await pairs(), [`${ID(1)} ${ID(3)}`, `${ID(2)} ${ID(3)}`]);
    // What a scan would read now differs, but neither the vectors nor the graph's revision moved
    // (so the scan is known to find what it found): the gap run's load scans nothing.
    graph.concepts.set(ID(1), [{ id: "tool-y", type: "Tool", name: "Y" }]);
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(lastRun(h)!.entries, 3, "the gap run");
    assert.deepEqual(await pairs(), [`${ID(1)} ${ID(3)}`, `${ID(2)} ${ID(3)}`], "not scanned again");
    // The graph's content moves: the next load scans.
    revision += 1;
    h.service.entriesChanged(await h.store.put(ID(4), "body of 4"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 3));
    assert.deepEqual(await pairs(), [`${ID(1)} ${ID(2)}`, `${ID(1)} ${ID(3)}`, `${ID(2)} ${ID(3)}`]);
    await h.service.stop();
  });
});

describe("KnowledgeLinkingService — phase 2: link gaps and pair checks", { timeout: 120_000 }, () => {
  it("after a graph load, link gaps are queued once; a pair-check round answers close pairs and counts its tokens", async () => {
    const graph = fakeGraphView();
    const h = await harness({ extra: { graphView: graph.view } });
    const ids = [ID(1), ID(2), ID(3)];
    graph.ready(ids);
    // Entry 3 shares no concept with the others although it is as close: a link gap with each.
    graph.concepts.set(ID(3), [{ id: "tool-x", type: "Tool", name: "X" }]);
    await h.service.start();
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    const recorded = new Promise<void>((resolve) => {
      const off = h.service.pairChecks.onChange(() => {
        if (h.service.pairChecks.all().length < 1) return;
        off();
        resolve();
      });
    });
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    assert.ok(ids.every((id) => h.store.linkContexts.get(id) === LINK_CONTEXT_VERSION), "linked with context from the start");
    assert.deepEqual([...h.service.gapQueued()].sort(), ids, "both entries of each gap pair are queued");
    const gaps = (await readState(h)).relink.gapPairs;
    assert.deepEqual(Object.keys(gaps).sort(), [`${ID(1)} ${ID(3)}`, `${ID(2)} ${ID(3)}`]);

    // The gap entries are re-linked by the next run; the same gaps are not queued again (same hashes).
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    assert.equal(lastRun(h)!.entries, 3);
    assert.deepEqual([...h.service.gapQueued()], []);

    // Then linking is idle: the round checks the pair sharing a Tactic (1, 2).
    await recorded;
    await h.service.pairChecksIdle();
    assert.deepEqual(h.service.pairChecks.all().map((c) => [c.a, c.b, c.verdict]), [[ID(1), ID(2), "consistent"]]);
    const state = await readState(h);
    const runTokens = state.recentRuns.reduce((sum, run) => sum + run.tokensIn, 0);
    assert.ok(state.tokens.total.in > runTokens, "the round's chats count too");
    assert.ok(state.workers.some((w) => w.runId.startsWith("kp_") && w.state === "done"));
    // An edit: its gap pairs are worth another try (new hashes); the pair checked stays checked.
    h.service.entriesChanged(await h.store.put(ID(3), "body of 3, edited"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 3));
    assert.deepEqual([...h.service.gapQueued()].sort(), ids, "queued again after the edit");
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 4));
    await flushAsync(20);
    await h.service.pairChecksIdle();
    assert.equal(h.service.pairChecks.all().length, 1);
    assert.equal(h.port.sessions.flatMap((s) => s.inputs).filter((i) => i.step === "pair-check").length, 1, "each pair is checked once per pair of content hashes");
    await h.service.stop();
  });

  it("a consistent check on input version 1 that saw a cut body is asked again once, with excerpts, and recorded on the current version", async () => {
    const graph = fakeGraphView();
    const h = await harness({ extra: { graphView: graph.view } });
    const ids = [ID(1), ID(2), ID(3)];
    graph.ready(ids);
    graph.concepts.set(ID(3), [{ id: "tool-x", type: "Tool", name: "X" }]);
    const bodies: Record<string, string> = {
      [ID(1)]: Array.from({ length: 100 }, (_, i) => `Step ${i}: filler line number ${i} about phones.`).join("\n") + "\nUse Gmail specifically, never Outlook.",
      [ID(2)]: "make an outlook/proton email for the account",
      [ID(3)]: "body of 3"
    };
    assert.ok(bodies[ID(1)]!.length > PAIR_CHECK_BODY_CHARS, "longer than the old cut, and excerpted now");
    const hash = (id: string) => createHash("sha256").update(bodies[id]!).digest("hex");
    const v1 = (a: string, b: string) => ({ a, b, hashA: hash(a), hashB: hash(b), verdict: "consistent", note: "Same playbook.", checkedAt: "t" });
    await mkdir(dirname(knowledgePairChecksPath(h.appdir)), { recursive: true });
    await writeFile(knowledgePairChecksPath(h.appdir), JSON.stringify({ version: 1, checks: [v1(ID(1), ID(2))] }));
    await h.service.start();
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, bodies[id]!));
    const pairInputs = () => h.port.sessions.flatMap((s) => s.inputs).filter((i) => i.step === "pair-check");
    const reasked = new Promise<void>((resolve) => {
      const off = h.service.pairChecks.onChange(() => {
        if (h.service.pairChecks.get(ID(1), ID(2))?.note !== "Both say the same.") return;
        off();
        resolve();
      });
    });
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    // The gap entries are re-linked first; then linking is idle and the round runs.
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 2));
    await reasked;
    await h.service.pairChecksIdle();
    const asked = pairInputs();
    assert.equal(asked.length, 1, "the version-1 check of the cut body is asked again");
    assert.ok(asked[0]!.input.includes("Use Gmail specifically, never Outlook."), "with the passage that bears on the other entry");
    assert.ok(asked[0]!.input.includes("(Excerpts chosen for relevance to the other entry"));
    await h.service.pairChecks.flush();
    const file = JSON.parse(await readFile(knowledgePairChecksPath(h.appdir), "utf8")) as { checks: { a: string; b: string; inputVersion?: number; note: string }[] };
    assert.deepEqual(
      file.checks.map((c) => [c.a, c.b, c.inputVersion, c.note]),
      [[ID(1), ID(2), PAIR_CHECK_INPUT_VERSION, "Both say the same."]]
    );

    // The next rounds (gap re-links, an edit elsewhere) do not ask it again.
    h.service.entriesChanged(await h.store.put(ID(3), "body of 3, edited"));
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 3));
    await flushAsync(20);
    await h.service.pairChecksIdle();
    assert.equal(pairInputs().filter((i) => i.input.includes(`(${ID(1)})`) && i.input.includes(`(${ID(2)})`)).length, 1, "asked again once");
    await h.service.stop();
  });
});

/** The attempt key of the round-test source's task for `item`: its task id (myKG's, of its prompt and label). */
const roundTaskKey = (item: string): string =>
  createHash("sha256").update(`Answer {"ok": true}.\n--user--\nItem ${item}\n--ctx--\nround-test ${item}`).digest("hex");
/** Failed rounds counted for the round-test source's `item`. */
const attemptsOf = (h: Harness, item: string): number =>
  (h.service.pairChecks as unknown as { attempts: Map<string, { failures: number }> }).attempts.get(roundTaskKey(item))?.failures ?? 0;

/** A round task source that asks for the items it is given, once each, and records the answers. */
function fakeRoundSource(items: string[]) {
  const listeners = new Set<() => void>();
  const asked = new Set<string>();
  const recorded: string[] = [];
  const calls: string[] = [];
  let probe: () => string = () => "";
  const source: KnowledgeRoundTaskSource = {
    step: "round-test",
    async tasks(): Promise<KnowledgeRoundTask[]> {
      calls.push(probe());
      const fresh = items.filter((item) => !asked.has(item) && !recorded.includes(item)).slice(0, 2);
      return fresh.map((item) => ({ label: `round-test ${item}`, system: "Answer {\"ok\": true}.", user: `Item ${item}`, payload: { item } }));
    },
    validate: (value) => ((value as { ok?: unknown } | null)?.ok === true ? null : 'Answer {"ok": true}.'),
    async record(payload) {
      const item = (payload as { item: string }).item;
      asked.add(item);
      recorded.push(item);
    },
    onWork(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return {
    source,
    recorded,
    calls,
    work: () => [...listeners].forEach((listener) => listener()),
    watch: (read: () => string) => (probe = read)
  };
}

describe("KnowledgeLinkingService — round task sources", { timeout: 120_000 }, () => {
  it("answers a source's capped tasks in the idle rounds only, counts their tokens, and asks each item once", async () => {
    const graph = fakeGraphView();
    const round = fakeRoundSource(["x", "y", "z"]);
    const h = await harness({ extra: { graphView: graph.view, roundTasks: [round.source] } });
    round.watch(() => h.service.status().state);
    const ids = [ID(1), ID(2)];
    graph.ready(ids);
    await h.service.start();
    for (const id of ids) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    // New work while a save waits: no round yet.
    round.work();
    await flushAsync(20);
    assert.equal(round.calls.length, 0, "no round while entries wait to be linked");
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    await h.until(() => round.recorded.length >= 2);
    await h.service.pairChecksIdle();
    assert.deepEqual(round.recorded.sort(), ["x", "y"], "the source's own cap: 2 a round");
    assert.ok(round.calls.length > 0 && round.calls.every((state) => state === "idle"), JSON.stringify(round.calls));
    const state = await readState(h);
    const runTokens = state.recentRuns.reduce((sum, run) => sum + run.tokensIn, 0);
    assert.ok(state.tokens.total.in > runTokens, "the round's chats count");
    // More work: the next round takes the rest; then nothing is asked again.
    round.work();
    await h.until(() => round.recorded.length >= 3);
    await h.service.pairChecksIdle();
    round.work();
    await flushAsync(20);
    await h.service.pairChecksIdle();
    const asked = h.port.sessions.flatMap((s) => s.inputs).filter((i) => i.step === "round-test").map((i) => i.input);
    assert.equal(asked.length, 3, "each item once");
    await h.service.stop();
  });

  it("an item no chat answers acceptably cannot sink its round, and after three rounds it is never asked again", async () => {
    const graph = fakeGraphView();
    const listeners = new Set<() => void>();
    const recorded: string[] = [];
    const source: KnowledgeRoundTaskSource = {
      step: "round-test",
      async tasks(options) {
        const tasks = ["bad", "good"]
          .filter((item) => !recorded.includes(item))
          .map((item) => ({ label: `round-test ${item}`, system: 'Answer {"ok": true}.', user: `Item ${item}`, payload: { item } }));
        return tasks.filter((task) => !options?.skip?.(task));
      },
      // No answer to "bad" is ever acceptable.
      validate: (value, payload) =>
        (payload as { item: string }).item === "bad" ? "Not acceptable." : (value as { ok?: unknown } | null)?.ok === true ? null : 'Answer {"ok": true}.',
      async record(payload) {
        recorded.push((payload as { item: string }).item);
      },
      onWork(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    const work = (): void => listeners.forEach((listener) => listener());
    const h = await harness({ extra: { graphView: graph.view, roundTasks: [source] } });
    graph.ready([ID(1), ID(2)]);
    await h.service.start();
    for (const id of [ID(1), ID(2)]) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    work();
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    await h.until(() => recorded.includes("good"));
    await h.service.pairChecksIdle();
    const askedBad = () => h.port.sessions.flatMap((s) => s.inputs).filter((i) => i.input === "Item bad").length;
    // Two chats gave up on it (each refused MAX_REFUSALS times), then it was out of the round: a third
    // chat answered the rest instead of failing the round's pool (3 chats in a row giving up).
    assert.equal(askedBad(), 2 * MAX_REFUSALS);
    assert.ok(!h.service.pairChecks.gaveUp(roundTaskKey("bad")), "one failed round");
    for (let round = 2; round <= 3; round += 1) {
      work();
      await h.until(() => h.service.pairChecks.givenUp().length > 0 || attemptsOf(h, "bad") >= round);
      await h.service.pairChecksIdle();
    }
    assert.ok(h.service.pairChecks.gaveUp(roundTaskKey("bad")), "given up after three rounds");
    const asked = askedBad();
    work();
    await flushAsync(50);
    await h.service.pairChecksIdle();
    assert.equal(askedBad(), asked, "never asked again");
    assert.deepEqual(recorded, ["good"]);
    const written = JSON.parse(await readFile(knowledgePairChecksPath(h.appdir), "utf8")) as { attempts?: { label: string; failures: number }[] };
    assert.deepEqual(written.attempts?.map((a) => [a.label, a.failures]), [["round-test bad", 3]]);
    await h.service.stop();
  });

  it("an answer still being recorded when its round ends is recorded once, not again by the round's harvest", async () => {
    const graph = fakeGraphView();
    const listeners = new Set<() => void>();
    const records: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let recording!: () => void;
    const firstRecording = new Promise<void>((resolve) => (recording = resolve));
    const source: KnowledgeRoundTaskSource = {
      step: "round-test",
      async tasks() {
        return records.length > 0 ? [] : [{ label: "round-test slow", system: 'Answer {"ok": true}.', user: "Item slow", payload: { item: "slow" } }];
      },
      validate: (value) => ((value as { ok?: unknown } | null)?.ok === true ? null : 'Answer {"ok": true}.'),
      async record(payload) {
        records.push((payload as { item: string }).item);
        if (records.length === 1) {
          recording();
          await gate; // a slow write: the round ends meanwhile (this was its last task)
        }
      },
      onWork(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    const h = await harness({ extra: { graphView: graph.view, roundTasks: [source] } });
    graph.ready([ID(1), ID(2)]);
    await h.service.start();
    for (const id of [ID(1), ID(2)]) h.service.entriesChanged(await h.store.put(id, `body of ${id}`));
    for (const listener of listeners) listener(); // the source has work: a round once linking is idle
    await h.clock.advance(20_000);
    await h.until(ranOk(h, 1));
    await firstRecording;
    // The round's chats end and its inbox is harvested while the answer is still being recorded.
    await flushAsync(50);
    assert.deepEqual(records, ["slow"], "the harvest waits for the recording instead of recording the answer again");
    release();
    await h.service.pairChecksIdle();
    assert.deepEqual(records, ["slow"]);
    await h.service.stop();
  });
});
