import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CreateSessionRequest, RegistryEntry, SessionSummary } from "@orquester/api";

import { setSessionNodePreload } from "../../../plugins/session-env.ts";
import type { RegistryService } from "../../../registry.ts";
import { drainSessionIndexWrites, LocalSessionManager, SessionError, type ISessionManager } from "../../../sessions.ts";
import { BOX_TMUX_SERVER, BoxAwareSessionManager, BoxTerminalManager, composeIndexContributors } from "./terminals.ts";
import { boxRecord, fakeAgentConnection, fakeBoxes, type FakeAgentConnection, type FakeProcBehavior } from "./testing.ts";

const PROJECT = "/srv/workspaces/acme/app";

const entry = (id: string, kind: RegistryEntry["kind"]): RegistryEntry =>
  ({ id, name: id === "bash" ? "Bash" : "Claude Code", kind, bin: [id], enabled: true, resolvedBin: `/usr/bin/${id}`, installState: { status: "idle" } }) as unknown as RegistryEntry;
const ENTRIES = new Map<string, RegistryEntry>([
  ["bash", entry("bash", "shell")],
  ["claude", entry("claude", "agent")]
]);
const entries = { get: (id: string) => ENTRIES.get(id) };

/** An echoing shell: every input comes back as `echo:<input>`. */
const echoShell: FakeProcBehavior = (control) => ({
  onInput: (data) => control.write(`echo:${data}`)
});

/** A host backend double that records what reached it. */
function hostDouble(): ISessionManager & { created: CreateSessionRequest[]; persisted: number } {
  const lifecycle = new EventEmitter();
  const created: CreateSessionRequest[] = [];
  const host = {
    lifecycle,
    created,
    persisted: 0,
    async create(req: CreateSessionRequest): Promise<SessionSummary> {
      created.push(req);
      return { id: "host-1", kind: "shell", refId: req.refId, title: "Bash", projectPath: req.projectPath ?? "", cwd: "/", cols: 80, rows: 24, status: "running", order: 0, createdAt: "2026-01-01T00:00:00.000Z" };
    },
    list: () => [],
    get: () => undefined,
    scrollback: async () => "",
    buffer: () => "",
    activity: () => undefined,
    agentEvent: () => false,
    input: () => undefined,
    resize: () => undefined,
    rename: () => undefined,
    reorder: () => undefined,
    close: () => false,
    closeByProjectPrefix: () => undefined,
    subscribe: () => () => undefined,
    shutdown: () => undefined,
    closeAll: () => undefined,
    reattach: async () => undefined,
    liveAccountIds: () => new Set<string>(),
    persistIndexNow() {
      host.persisted += 1;
    }
  };
  return host;
}

interface Rig {
  connection: FakeAgentConnection;
  boxes: ReturnType<typeof fakeBoxes>;
  box: BoxTerminalManager;
  host: ReturnType<typeof hostDouble>;
  sessions: BoxAwareSessionManager;
  tmuxCalls: string[][];
}

function rig(options: { tmux?: boolean; tmuxAlive?: boolean; tooling?: boolean; pendingKillsFile?: string } = {}): Rig {
  const tmuxCalls: string[][] = [];
  const connection = fakeAgentConnection({
    sys: { tmux: options.tmux ?? false, shell: "/bin/bash", home: "/home/box", agentPath: "/opt/orq/orq-agent" },
    behavior: echoShell,
    run: (spec) => {
      if (spec.command === "tmux") {
        tmuxCalls.push(spec.args ?? []);
        const verb = spec.args?.[2];
        if (verb === "has-session") return { code: options.tmuxAlive ? 0 : 1 };
        if (verb === "display-message") return { code: 0, stdout: "0\n" };
        if (verb === "capture-pane") return { code: 0, stdout: "captured pane\n" };
        return { code: 0 };
      }
      if (spec.command === "/bin/sh") return { code: 0, stdout: "/usr/local/bin:/usr/bin:/bin" };
      return undefined;
    }
  });
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1", { project: { workspace: "acme", name: "app", path: PROJECT } }), connection);
  boxes.add(boxRecord("tmp-1", { purpose: "temporary", project: null, threadId: "t-1" }), connection);
  const box = new BoxTerminalManager({
    registry: boxes.registry,
    hub: boxes.hub,
    ...(options.pendingKillsFile ? { pendingKillsFile: options.pendingKillsFile } : {}),
    ...(options.tooling
      ? { tooling: { contribution: () => ({ pathPrepend: ["/var/lib/orq-agent/tools/bin"], env: { TSRS_ENGINE: "tsrs" }, nodeRequire: ["/var/lib/orq-agent/tools/preload.cjs"] }) } }
      : {})
  });
  const host = hostDouble();
  const sessions = new BoxAwareSessionManager(host, box, entries);
  return { connection, boxes, box, host, sessions, tmuxCalls };
}

/** Resolves with the next "output" of a session (the test's event, never a sleep). */
const nextOutput = (sessions: ISessionManager, id: string, match: RegExp): Promise<string> =>
  new Promise((resolve) => {
    let seen = "";
    const off = sessions.subscribe(
      id,
      (data) => {
        seen += data;
        if (match.test(seen)) {
          off();
          resolve(seen);
        }
      },
      () => undefined
    );
  });

const once = <T>(emitter: EventEmitter, event: string): Promise<T> => new Promise((resolve) => emitter.once(event, resolve));

test("a box project's terminal runs a detached login shell in the box; input, output, resize work", async () => {
  const r = rig();
  setSessionNodePreload("/host/appdir/plugins/preload.cjs");
  try {
    const created = once<SessionSummary>(r.sessions.lifecycle, "created");
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT, cols: 100, rows: 30, initialCommand: "npm run dev" });
    assert.equal((await created).id, summary.id);
    assert.equal(summary.boxId, "box-1");
    assert.equal(summary.cwd, PROJECT);
    assert.equal(r.host.created.length, 0, "the host backend never sees a box terminal");

    const spawned = r.connection.execs.find((e) => e.detach);
    assert.ok(spawned);
    assert.equal(spawned.command, "/bin/bash");
    assert.deepEqual(spawned.args, ["-l"]);
    assert.equal(spawned.cwd, PROJECT);
    assert.deepEqual(spawned.detach, { procId: summary.id });
    assert.deepEqual(spawned.pty, { cols: 100, rows: 30, term: "xterm-256color" });
    assert.equal(spawned.env?.TERM, "xterm-256color");
    assert.equal(spawned.env?.GIT_CONFIG_COUNT, undefined, "no git credential helper: a box never gets a token");
    assert.equal(spawned.env?.GIT_SSH_COMMAND, undefined);
    assert.equal(spawned.env?.NODE_OPTIONS, undefined, "the host preload never reaches a box");

    const control = r.connection.proc(summary.id)!;
    assert.deepEqual(control.input, ["npm run dev\n"], "initialCommand is typed into the shell");

    const sniffed: string[] = [];
    r.sessions.lifecycle.on("output", ({ data }: { data: string }) => sniffed.push(data));
    const output = nextOutput(r.sessions, summary.id, /echo:ls\n/);
    r.sessions.input(summary.id, "ls\n");
    assert.match(await output, /echo:ls\n/);
    assert.ok(sniffed.join("").includes("echo:ls"), "the project's URL watcher hears its box terminals");
    assert.match(r.sessions.buffer(summary.id), /echo:npm run dev\n.*echo:ls\n/s);

    r.sessions.resize(summary.id, 120, 40);
    assert.deepEqual(control.resizes, [{ cols: 120, rows: 40 }]);
    assert.equal(r.sessions.get(summary.id)?.cols, 120);
    assert.ok(r.host.persisted > 0, "box records are persisted through the host's index writer");
    assert.deepEqual(r.sessions.list(PROJECT).map((s) => s.id), [summary.id]);
  } finally {
    setSessionNodePreload(null);
    r.box.dispose();
  }
});

test("with tmux in the box the shell is a private tmux session; close kills it", async () => {
  const r = rig({ tmux: true, tooling: true });
  try {
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT });
    const spawned = r.connection.execs.find((e) => e.detach)!;
    assert.equal(spawned.command, "tmux");
    assert.deepEqual(spawned.args?.slice(0, 2), ["-L", BOX_TMUX_SERVER]);
    const sessionArgs = spawned.args?.slice(spawned.args.indexOf("new-session"));
    assert.deepEqual(sessionArgs?.slice(0, 4), ["new-session", "-A", "-s", `orq-${summary.id}`]);
    assert.ok(spawned.args?.includes(`PATH=/var/lib/orq-agent/tools/bin:/usr/local/bin:/usr/bin:/bin`));
    assert.ok(spawned.args?.includes(`NODE_OPTIONS=--require "/var/lib/orq-agent/tools/preload.cjs"`));
    assert.equal(spawned.env?.TSRS_ENGINE, "tsrs");

    assert.equal(await r.sessions.scrollback(summary.id), "captured pane\n");

    const control = r.connection.proc(summary.id)!;
    const closed = once<{ id: string }>(r.sessions.lifecycle, "closed");
    const released = r.connection.nextCall("proc.release");
    assert.equal(r.sessions.close(summary.id), true);
    assert.equal((await closed).id, summary.id);
    // Killing the tmux session first, then the client (SIGHUP), then releasing the procId.
    assert.deepEqual(await released, { procId: summary.id });
    assert.ok(r.tmuxCalls.some((args) => args[2] === "kill-session" && args.includes(`orq-${summary.id}`)));
    assert.deepEqual(control.signals, ["SIGHUP"]);
    assert.equal(r.sessions.get(summary.id), undefined);
  } finally {
    r.box.dispose();
  }
});

test("terminal agents are refused in boxes; host projects go to the host backend", async () => {
  const r = rig();
  try {
    await assert.rejects(r.sessions.create({ kind: "agent", refId: "claude", projectPath: PROJECT }), (error: unknown) => {
      assert.ok(error instanceof SessionError);
      assert.match(error.message, /can't run in a box/);
      return true;
    });
    assert.equal(r.connection.execs.length, 0);
    const host = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: "/srv/workspaces/acme/other" });
    assert.equal(host.id, "host-1");
    assert.equal(r.host.created.length, 1);
  } finally {
    r.box.dispose();
  }
});

test("an explicit boxId opens a temporary box's terminal in the box user's home; a destroyed box refuses", async () => {
  const r = rig();
  try {
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: "/srv/workspaces/acme/chat-project", boxId: "tmp-1" });
    assert.equal(summary.boxId, "tmp-1");
    assert.equal(summary.cwd, "/home/box");
    assert.equal(summary.projectPath, "/srv/workspaces/acme/chat-project");
    assert.equal(r.connection.execs.find((e) => e.detach)?.cwd, "/home/box");

    // Its output is not taken for the (host) project's dev servers.
    const sniffed: string[] = [];
    r.sessions.lifecycle.on("output", ({ data }: { data: string }) => sniffed.push(data));
    const seen = nextOutput(r.sessions, summary.id, /localhost:5173/);
    r.connection.proc(summary.id)!.write("http://localhost:5173\n");
    await seen;
    assert.deepEqual(sniffed, []);

    r.boxes.update("tmp-1", { state: "destroyed" });
    assert.equal(r.sessions.get(summary.id)?.status, "exited", "a destroyed box ends its terminals");
    await assert.rejects(r.sessions.create({ kind: "shell", refId: "bash", boxId: "tmp-1" }), /destroyed/);
    await assert.rejects(r.sessions.create({ kind: "shell", refId: "bash", boxId: "nope" }), /no box/);
  } finally {
    r.box.dispose();
  }
});

test("a dropped link detaches the shell; reconnecting reattaches from the last offset without loss or repeats", async () => {
  const r = rig();
  try {
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT });
    const control = r.connection.proc(summary.id)!;
    const first = nextOutput(r.sessions, summary.id, /one\n/);
    control.write("one\n");
    await first;

    r.connection.dropLink();
    control.write("while-away\n");
    assert.equal(r.sessions.get(summary.id)?.status, "running", "the tab stays open while the box is away");

    const resumed = nextOutput(r.sessions, summary.id, /while-away\n/);
    r.connection.restoreLink();
    assert.equal(await resumed, "while-away\n");

    const live = nextOutput(r.sessions, summary.id, /echo:pwd\n/);
    r.sessions.input(summary.id, "pwd\n");
    await live;
    assert.equal(r.sessions.buffer(summary.id), "one\nwhile-away\necho:pwd\n");
  } finally {
    r.box.dispose();
  }
});

test("a resize made while the box is away reaches the PTY once the shell is reattached", async () => {
  const r = rig();
  try {
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT, cols: 80, rows: 24 });
    const control = r.connection.proc(summary.id)!;
    r.connection.dropLink();
    r.sessions.resize(summary.id, 132, 50);
    assert.deepEqual(control.resizes, [], "no process to tell while away");
    assert.equal(r.sessions.get(summary.id)?.cols, 132);

    const resumed = nextOutput(r.sessions, summary.id, /back\n/);
    control.write("back\n");
    r.connection.restoreLink();
    await resumed;
    assert.deepEqual(control.resizes, [{ cols: 132, rows: 50 }]);
  } finally {
    r.box.dispose();
  }
});

test("a terminal closed while its box is away is ended on reconnect, across a daemon restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-box-terminals-"));
  const pendingKillsFile = join(dir, "boxes", "pending-terminal-kills.json");
  const r = rig({ pendingKillsFile });
  try {
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT });
    const control = r.connection.proc(summary.id)!;
    r.connection.dropLink();
    assert.equal(r.sessions.close(summary.id), true);
    await r.box.pendingKillsSaved();
    assert.deepEqual(JSON.parse(await readFile(pendingKillsFile, "utf8")), { version: 1, kills: [{ boxId: "box-1", procId: summary.id }] });

    // The daemon restarts before the box is back: the new manager still owes the kill.
    r.box.dispose();
    const box2 = new BoxTerminalManager({ registry: r.boxes.registry, hub: r.boxes.hub, pendingKillsFile });
    try {
      assert.deepEqual([...box2.pendingKills()], [["box-1", [summary.id]]]);
      const released = r.connection.nextCall("proc.release");
      r.connection.restoreLink();
      assert.deepEqual(await released, { procId: summary.id });
      assert.deepEqual(control.signals, ["SIGHUP"]);
      assert.ok(!r.connection.detachedProcs().some((proc) => proc.procId === summary.id), "nothing left in the box");
      await box2.pendingKillsSaved();
      assert.deepEqual(box2.pendingKills().size, 0);
      assert.deepEqual(JSON.parse(await readFile(pendingKillsFile, "utf8")), { version: 1, kills: [] });
    } finally {
      box2.dispose();
    }
  } finally {
    r.box.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the shell's exit ends the tab and releases its procId", async () => {
  const r = rig();
  try {
    const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT });
    const exited = once<SessionSummary>(r.sessions.lifecycle, "exited");
    r.connection.proc(summary.id)!.exit(3);
    const done = await exited;
    assert.equal(done.id, summary.id);
    assert.equal(done.exitCode, 3);
    assert.ok(r.connection.calls.some((c) => c.method === "proc.release" && (c.params as { procId: string }).procId === summary.id));
    assert.equal(r.box.records().length, 0, "an ended terminal is not persisted");
  } finally {
    r.box.dispose();
  }
});

test("sessions.json keeps box terminals (boxId) and a restarted daemon reattaches them from the box buffer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-box-terminals-"));
  const indexPath = join(dir, "sessions.json");
  const r = rig();
  const registry = { get: (id: string) => ENTRIES.get(id) } as unknown as RegistryService;
  try {
    // First daemon run: the direct-PTY host backend owns the index; the box terminals contribute.
    const host1 = new LocalSessionManager(registry, { indexContributor: composeIndexContributors(r.box.indexContributor()) }, indexPath);
    const sessions1 = new BoxAwareSessionManager(host1, r.box, entries);
    const summary = await sessions1.create({ kind: "shell", refId: "bash", projectPath: PROJECT, title: "dev server" });
    r.connection.proc(summary.id)!.write("ready on http://localhost:5173\n");
    await drainSessionIndexWrites(indexPath);
    const written = JSON.parse(await readFile(indexPath, "utf8")) as { sessions: { id: string; boxId?: string; title: string }[] };
    assert.deepEqual(
      written.sessions.map((s) => [s.id, s.boxId, s.title]),
      [[summary.id, "box-1", "dev server"]]
    );

    // The daemon goes away; the shell keeps running and printing in the box.
    sessions1.shutdown();
    r.box.dispose();
    r.connection.dropLink();
    r.connection.proc(summary.id)!.write("served /\n");

    // Second run: a fresh manager adopts the record and reattaches once the box connects.
    const box2 = new BoxTerminalManager({ registry: r.boxes.registry, hub: r.boxes.hub });
    const host2 = new LocalSessionManager(registry, { indexContributor: composeIndexContributors(box2.indexContributor()) }, indexPath);
    const sessions2 = new BoxAwareSessionManager(host2, box2, entries);
    await sessions2.reattach();
    assert.equal(sessions2.get(summary.id)?.status, "running");
    assert.equal(sessions2.get(summary.id)?.boxId, "box-1");
    const replayed = nextOutput(sessions2, summary.id, /served \/\n/);
    r.connection.restoreLink();
    assert.equal(await replayed, "ready on http://localhost:5173\nserved /\n", "the hot scrollback is rebuilt from the box's buffer");

    const echoed = nextOutput(sessions2, summary.id, /echo:after\n/);
    sessions2.input(summary.id, "after\n");
    await echoed;
    box2.dispose();
  } finally {
    r.box.dispose();
    await drainSessionIndexWrites(indexPath);
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of ["forget", "lose"] as const) {
  test(`after an orq-agent restart (${mode}) a tmux terminal re-joins its tmux session; without one it ends`, async () => {
    const r = rig({ tmux: true, tmuxAlive: true });
    try {
      const summary = await r.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT });
      r.connection.dropLink();
      r.connection.restartAgent(mode);
      const rejoin = r.connection.nextExec((spec) => spec.detach !== undefined);
      r.connection.restoreLink();
      const rejoined = await rejoin;
      const sessionArgs = rejoined.args?.slice(rejoined.args.indexOf("new-session"));
      assert.deepEqual(sessionArgs?.slice(0, 4), ["new-session", "-A", "-s", `orq-${summary.id}`]);
      assert.equal(r.sessions.get(summary.id)?.status, "running");
    } finally {
      r.box.dispose();
    }

    const plain = rig({ tmux: false });
    try {
      const summary = await plain.sessions.create({ kind: "shell", refId: "bash", projectPath: PROJECT });
      plain.connection.dropLink();
      plain.connection.restartAgent(mode);
      const exited = once<SessionSummary>(plain.sessions.lifecycle, "exited");
      plain.connection.restoreLink();
      assert.equal((await exited).id, summary.id);
    } finally {
      plain.box.dispose();
    }
  });
}
