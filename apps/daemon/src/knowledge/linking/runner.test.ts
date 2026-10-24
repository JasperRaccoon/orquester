import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeClock } from "../../workflows/agent/testing/fake-clock.ts";
import { InboxBroker } from "./inbox.ts";
import { writeMykgConfig } from "./mykg-config.ts";
import { mykgSessionPaths } from "./mykg-files.ts";
import { mykgArgs, mykgEnv, procMykgProbe, startMykgRun, stopStaleMykg, type MykgProcessProbe } from "./runner.ts";
import { FAKE_RUNTIME as RUNTIME, defaultAnswer, fakeSpawn } from "./testing.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(entries: Record<string, string>): Promise<{ root: string; mykgDir: string; homeDir: string; inputDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "orq-runner-"));
  roots.push(root);
  const mykgDir = join(root, "mykg");
  const inputDir = join(mykgDir, "input");
  const homeDir = join(root, "home");
  await mkdir(inputDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeMykgConfig(mykgDir, { concurrency: 2 });
  for (const [id, body] of Object.entries(entries)) await writeFile(join(inputDir, `${id}.md`), body);
  return { root, mykgDir, homeDir, inputDir };
}

/** Answers every task of a session's inbox until the run ends (a stand-in for the worker chats). */
function answerAll(broker: InboxBroker): Promise<number> {
  return (async () => {
    let answered = 0;
    let reply = await broker.next("worker");
    while (reply.kind === "task") {
      const submitted = await broker.submit("worker", reply.task.taskId, defaultAnswer(reply.task));
      if (!submitted.accepted) throw new Error(submitted.error);
      answered += 1;
      reply = submitted.next;
    }
    return answered;
  })();
}

describe("mykg argv and env", () => {
  it("builds the four invocations", () => {
    assert.deepEqual(mykgArgs({ inputDir: "/in", mode: "full", session: null }), ["extract-graph", "/in"]);
    assert.deepEqual(mykgArgs({ inputDir: "/in", mode: "rebuild", session: "s2" }), ["extract-graph", "/in", "--session", "s2"]);
    assert.deepEqual(mykgArgs({ inputDir: "/in", mode: "update", session: "s1" }), ["extract-graph", "/in", "--session", "s1", "--update"]);
    assert.deepEqual(mykgArgs({ inputDir: "/in", mode: "grow-schema", session: "s1" }), [
      "extract-graph",
      "/in",
      "--session",
      "s1",
      "--update",
      "--append-with-grow-schema"
    ]);
    assert.throws(() => mykgArgs({ inputDir: "/in", mode: "update", session: null }));
  });

  it("is a minimal environment: HOME in the plugin, the venv first on PATH, nothing of the daemon's", () => {
    const env = mykgEnv(RUNTIME, "/plugin/mykg-home");
    assert.equal(env.HOME, "/plugin/mykg-home");
    assert.equal(env.PATH!.split(":")[0], "/plugin/runtime/versions/0.4.10/venv/bin");
    assert.equal(env.VIRTUAL_ENV, "/plugin/runtime/versions/0.4.10/venv");
    assert.equal(env.TIKTOKEN_CACHE_DIR, RUNTIME.tiktokenCacheDir, "the runtime's prefetched encodings");
    for (const key of Object.keys(env)) assert.doesNotMatch(key, /API_KEY|_TOKEN$|ANTHROPIC|OPENAI|CLAUDE|CODEX|ACCOUNT|SECRET/);
    assert.deepEqual(Object.keys(env).sort(), [
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "PYTHONDONTWRITEBYTECODE",
      "PYTHONIOENCODING",
      "PYTHONUNBUFFERED",
      "TERM",
      "TIKTOKEN_CACHE_DIR",
      "TMPDIR",
      "VIRTUAL_ENV",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME"
    ]);
  });
});

describe("MykgRun (against a fake myKG)", { timeout: 30_000 }, () => {
  it("a first run creates and names its session, and its tasks are answered through the inbox", async () => {
    const dirs = await setup({ ke_aaaaaaaaaaaa: "Author: A\nalpha", ke_bbbbbbbbbbbb: "Author: B\nbeta" });
    const clock = new FakeClock();
    const run = startMykgRun({ runtime: RUNTIME, ...dirs, mode: "full", session: null }, { clock, spawn: fakeSpawn });
    const broker = new InboxBroker({ clock });
    const sessions: string[] = [];
    let answering: Promise<number> | null = null;
    run.onSession((session) => {
      sessions.push(session);
      void broker.attach(mykgSessionPaths(dirs.mykgDir, session).intermediate);
      answering = answerAll(broker);
    });
    const result = await run.done;
    broker.finish("run-finished");
    assert.equal(result.kind, "ok");
    assert.equal(sessions.length, 1);
    assert.equal(result.kind === "ok" && result.session, sessions[0]);
    assert.equal(await answering, 3, "one Pass 1 task and one Pass 2 task per entry");
    const nodes = (await readFile(mykgSessionPaths(dirs.mykgDir, sessions[0]!).nodes, "utf8")).trim().split("\n");
    assert.equal(nodes.length, 2);
    broker.dispose();
    const log = (await readFile(join(dirs.mykgDir, "fake-mykg.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(log[0].argv, ["extract-graph", dirs.inputDir]);
    assert.equal(log[0].env.HOME, dirs.homeDir);
    assert.equal(log[0].env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(log[0].env.ANTHROPIC_API_KEY, undefined);
  });

  it("an update run reuses the session and only asks for the changed entry", async () => {
    const dirs = await setup({ ke_aaaaaaaaaaaa: "alpha", ke_bbbbbbbbbbbb: "beta" });
    const clock = new FakeClock();
    const first = startMykgRun({ runtime: RUNTIME, ...dirs, mode: "full", session: null }, { clock, spawn: fakeSpawn });
    const broker1 = new InboxBroker({ clock });
    first.onSession((session) => void broker1.attach(mykgSessionPaths(dirs.mykgDir, session).intermediate).then(() => answerAll(broker1)));
    const done = await first.done;
    broker1.dispose();
    assert.equal(done.kind, "ok");
    const session = done.kind === "ok" ? done.session : "";
    await writeFile(join(dirs.inputDir, "ke_bbbbbbbbbbbb.md"), "beta, edited");
    const second = startMykgRun({ runtime: RUNTIME, ...dirs, mode: "update", session }, { clock, spawn: fakeSpawn });
    const broker2 = new InboxBroker({ clock });
    await broker2.attach(mykgSessionPaths(dirs.mykgDir, session).intermediate);
    const answering = answerAll(broker2);
    const result = await second.done;
    broker2.finish("run-finished");
    assert.deepEqual(result, { kind: "ok", session });
    assert.equal(await answering, 1);
    broker2.dispose();
  });

  it("a failed run reports the failed step and the stderr tail", async () => {
    const dirs = await setup({ ke_aaaaaaaaaaaa: "alpha" });
    await writeFile(join(dirs.mykgDir, "fake-mykg.json"), JSON.stringify({ fail: "names did not normalize" }));
    const clock = new FakeClock();
    const run = startMykgRun({ runtime: RUNTIME, ...dirs, mode: "full", session: null }, { clock, spawn: fakeSpawn });
    const broker = new InboxBroker({ clock });
    run.onSession((session) => void broker.attach(mykgSessionPaths(dirs.mykgDir, session).intermediate).then(() => answerAll(broker)));
    const result = await run.done;
    broker.dispose();
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.match(result.error, /^myKG exited with code 1\./);
    assert.match(result.error, /normalize_names: names did not normalize/);
    assert.match(result.error, /PipelineHaltError/);
  });

  it("an unknown session fails with myKG's message", async () => {
    const dirs = await setup({ ke_aaaaaaaaaaaa: "alpha" });
    const run = startMykgRun({ runtime: RUNTIME, ...dirs, mode: "update", session: "2026-01-01T00-00-00" }, { clock: new FakeClock(), spawn: fakeSpawn });
    const result = await run.done;
    assert.equal(result.kind, "failed");
    assert.match(result.kind === "failed" ? result.error : "", /Session '2026-01-01T00-00-00' not found/);
  });

  it("cancel stops the child and reports cancelled", async () => {
    const dirs = await setup({ ke_aaaaaaaaaaaa: "alpha" });
    const run = startMykgRun({ runtime: RUNTIME, ...dirs, mode: "full", session: null }, { clock: new FakeClock(), spawn: fakeSpawn });
    run.onSession(() => run.cancel());
    const result = await run.done;
    assert.equal(result.kind, "cancelled");
  });
});

const MYKG_CMDLINE = "/venv/bin/python /venv/bin/mykg extract-graph /plugin/input --session s --update";

/** A process table of one pid the test steers: what it is, and how it answers signals. */
function fakeProcess(options: { cmdline?: string; startTime?: number; exitsOn?: NodeJS.Signals[] }) {
  const signals: { signal: NodeJS.Signals; at: number }[] = [];
  let alive = true;
  let clock: FakeClock | null = null;
  const probe: MykgProcessProbe = {
    cmdline: async () => (alive ? (options.cmdline ?? MYKG_CMDLINE) : null),
    startTime: async () => (alive ? (options.startTime ?? 777) : null),
    signal: (_pid, signal) => {
      if (!alive) return false;
      signals.push({ signal, at: clock!.now().getTime() });
      if ((options.exitsOn ?? ["SIGTERM"]).includes(signal)) alive = false;
      return true;
    }
  };
  return {
    probe,
    signals,
    get alive() {
      return alive;
    },
    use(c: FakeClock) {
      clock = c;
    }
  };
}

describe("stopStaleMykg", () => {
  it("leaves alone a pid that is not the recorded myKG child (another command, a reused pid, no process)", async () => {
    const clock = new FakeClock();
    const other = fakeProcess({ cmdline: "/usr/bin/python3 -m http.server" });
    other.use(clock);
    assert.equal(await stopStaleMykg({ pid: null, startTime: null }, { clock, probe: other.probe }), "none");
    assert.equal(await stopStaleMykg({ pid: 1234, startTime: null }, { clock, probe: other.probe }), "none");
    const reused = fakeProcess({ startTime: 999 });
    reused.use(clock);
    assert.equal(await stopStaleMykg({ pid: 1234, startTime: 777 }, { clock, probe: reused.probe }), "none", "same command line, another start time");
    const elsewhere = fakeProcess({});
    elsewhere.use(clock);
    assert.equal(await stopStaleMykg({ pid: 1234, startTime: 777, inputDir: "/other/input" }, { clock, probe: elsewhere.probe }), "none", "another appdir's myKG");
    for (const proc of [other, reused, elsewhere]) assert.deepEqual(proc.signals, []);
  });

  it("waits for the child to exit after SIGTERM", async () => {
    const clock = new FakeClock();
    const proc = fakeProcess({ exitsOn: ["SIGTERM"] });
    proc.use(clock);
    const result = await clock.drive(stopStaleMykg({ pid: 1234, startTime: 777, inputDir: "/plugin/input" }, { clock, probe: proc.probe }));
    assert.equal(result, "stopped");
    assert.deepEqual(proc.signals.map((s) => s.signal), ["SIGTERM"]);
  });

  it("escalates to SIGKILL after the grace, and resolves only once the child is gone", async () => {
    const clock = new FakeClock();
    const start = clock.now().getTime();
    const proc = fakeProcess({ exitsOn: ["SIGKILL"] });
    proc.use(clock);
    let settled = false;
    const stopping = stopStaleMykg({ pid: 1234, startTime: 777 }, { clock, probe: proc.probe, termGraceMs: 10_000 }).finally(() => (settled = true));
    await clock.advance(9_000);
    assert.equal(settled, false, "still waiting for the SIGTERM to take");
    assert.deepEqual(proc.signals.map((s) => s.signal), ["SIGTERM"]);
    assert.equal(await clock.drive(stopping), "stopped");
    assert.deepEqual(proc.signals.map((s) => [s.signal, s.at - start]), [["SIGTERM", 0], ["SIGKILL", 10_000]]);
  });

  it("answers alive when even SIGKILL does not end it within the bound", async () => {
    const clock = new FakeClock();
    const proc = fakeProcess({ exitsOn: [] });
    proc.use(clock);
    assert.equal(await clock.drive(stopStaleMykg({ pid: 1234, startTime: 777 }, { clock, probe: proc.probe, termGraceMs: 1_000, killWaitMs: 1_000 })), "alive");
    assert.deepEqual(proc.signals.map((s) => s.signal), ["SIGTERM", "SIGKILL"]);
  });

  it("stops a real process through /proc (command line and start time)", { skip: process.platform !== "linux" }, async () => {
    const clock = new FakeClock();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "mykg", "extract-graph", "/plugin/input"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    const startTime = await procMykgProbe.startTime(child.pid!);
    assert.equal(typeof startTime, "number");
    assert.equal(await stopStaleMykg({ pid: child.pid!, startTime: startTime! + 1, inputDir: "/plugin/input" }, { clock }), "none", "a pid reused by another process");
    let result: string | undefined;
    const stopping = stopStaleMykg({ pid: child.pid!, startTime, inputDir: "/plugin/input" }, { clock }).then((value) => (result = value));
    assert.equal(await exited, "SIGTERM");
    // The child is gone: the next liveness check on the (fake) clock sees it.
    while (result === undefined) await clock.advance(100);
    await stopping;
    assert.equal(result, "stopped");
  });

  it("signals only this knowledge base's myKG extract, never another appdir's on a recycled pid", async () => {
    const clock = new FakeClock();
    for (const other of ["/venv/bin/python /venv/bin/mykg extract-graph /other/in --session s --update", "/venv/bin/mykg extract-graph /in/sub", "grep mykg extract-graph"]) {
      const proc = fakeProcess({ cmdline: other });
      proc.use(clock);
      assert.equal(await stopStaleMykg({ pid: 1234, startTime: null, inputDir: "/in" }, { clock, probe: proc.probe }), "none", other);
      assert.deepEqual(proc.signals, [], other);
    }
    const ours = fakeProcess({ cmdline: "/venv/bin/python /venv/bin/mykg extract-graph /in --session s --update", exitsOn: ["SIGTERM"] });
    ours.use(clock);
    assert.equal(await clock.drive(stopStaleMykg({ pid: 1234, startTime: null, inputDir: "/in" }, { clock, probe: ours.probe })), "stopped");
    assert.equal(await stopStaleMykg({ pid: 1.5, startTime: null, inputDir: "/in" }, { clock, probe: ours.probe }), "none", "not an integer pid");
  });
});
