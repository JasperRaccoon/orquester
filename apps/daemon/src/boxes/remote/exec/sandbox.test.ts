import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { SandboxHandle, SandboxSpawnRequest } from "../../../workflows/contracts.ts";
import type { DetailedSandboxRunner, SandboxExitDetail } from "../../../workflows/sandbox/sandbox.ts";
import type { BoxExecOptions } from "../../contracts.ts";
import { localBoxConnection } from "../../testing.ts";
import { ResultLineFilter, createBoxAwareSandboxRunner } from "./sandbox.ts";
import { boxRecord, fakeAgentConnection, fakeBoxes } from "./testing.ts";

let root: string;
let project: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-box-sandbox-"));
  project = join(root, "ws", "app");
  await mkdir(project, { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  counter += 1;
  const dir = join(root, "attempts", `attempt-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function request(overrides: Partial<SandboxSpawnRequest> & Pick<SandboxSpawnRequest, "kind" | "source" | "attemptDir">): SandboxSpawnRequest {
  return { cwd: project, env: {}, timeoutMs: 30_000, runId: "run-1", workflowId: "wf-1", projectPath: project, ...overrides };
}

const waitOpts = (signal: AbortSignal = new AbortController().signal, deadlineMs = 30_000) => ({ deadlineAt: new Date(Date.now() + deadlineMs), signal });

/** A host runner that must not be used for box projects (and records when it is). */
function hostRunner(): DetailedSandboxRunner & { spawned: SandboxSpawnRequest[] } {
  const spawned: SandboxSpawnRequest[] = [];
  return {
    spawned,
    async spawn(req) {
      spawned.push(req);
      return { pid: 99, starttime: 1, attemptDir: req.attemptDir };
    },
    wait: async () => ({ code: 0, signal: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }),
    isAlive: () => false,
    readHandle: async (attemptDir) => {
      try {
        const value = JSON.parse(await readFile(join(attemptDir, "handle.json"), "utf8")) as SandboxHandle;
        return { pid: value.pid, starttime: value.starttime, attemptDir };
      } catch {
        return null;
      }
    },
    readExit: async (attemptDir) => {
      try {
        const exit = JSON.parse(await readFile(join(attemptDir, "exit.json"), "utf8")) as SandboxExitDetail;
        const result = existsSync(join(attemptDir, "result.json")) ? JSON.parse(await readFile(join(attemptDir, "result.json"), "utf8")) : undefined;
        return result ? { ...exit, result } : exit;
      } catch {
        return null;
      }
    },
    kill: async () => undefined
  };
}

/** A box project on this machine (`localBoxConnection`), recording every exec. */
function localRig() {
  const connection = localBoxConnection({ boxId: "box-1", sys: { agentPath: "/opt/orq/orq-agent" } });
  const execs: BoxExecOptions[] = [];
  const localExec = connection.exec;
  connection.exec = (options: BoxExecOptions) => {
    execs.push(options);
    return localExec(options);
  };
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1", { project: { workspace: "ws", name: "app", path: project } }), connection);
  const host = hostRunner();
  const runner = createBoxAwareSandboxRunner(host, { registry: boxes.registry, hub: boxes.hub });
  return { connection, execs, boxes, host, runner };
}

async function runIn(runner: DetailedSandboxRunner, req: SandboxSpawnRequest) {
  const handle = await runner.spawn(req);
  const exit = await runner.wait(handle, waitOpts());
  const stdout = await readFile(join(req.attemptDir, "stdout.log"), "utf8").catch(() => "");
  const stderr = await readFile(join(req.attemptDir, "stderr.log"), "utf8").catch(() => "");
  return { handle, exit, stdout, stderr };
}

describe("shell blocks in a box", () => {
  test("run detached in the box with the block env, logs and exit on the host", async () => {
    const r = localRig();
    const attemptDir = await freshDir();
    const { handle, exit, stdout, stderr } = await runIn(
      r.runner,
      request({ kind: "shell", source: 'echo "out:$GREETING"; echo "err" >&2; pwd; exit 3', env: { GREETING: "hi" }, attemptDir })
    );
    assert.equal(exit.code, 3);
    assert.equal(exit.timedOut, false);
    assert.equal(stdout, `out:hi\n${project}\n`);
    assert.equal(stderr, "err\n");
    assert.equal(r.host.spawned.length, 0);
    const exitJson = JSON.parse(await readFile(join(attemptDir, "exit.json"), "utf8")) as { code: number; stdoutBytes: number };
    assert.equal(exitJson.code, 3);
    assert.equal(exitJson.stdoutBytes, Buffer.byteLength(stdout));

    const spec = r.execs.find((e) => e.detach)!;
    assert.equal(spec.command, "bash");
    assert.equal(spec.args?.[0], "-c");
    assert.equal(spec.cwd, project);
    assert.match(spec.detach!.procId, /^wf-/);
    assert.equal(spec.env?.TERM, "dumb");
    assert.equal(spec.env?.ORQUESTER_WORKFLOW_RUN_ID, "run-1");
    assert.equal(spec.env?.GREETING, "hi");
    // No git overrides: no credential helper (a box never gets a token), no GIT_SSH_COMMAND over the box's pinned config.
    assert.equal(spec.env?.GIT_CONFIG_COUNT, undefined);
    assert.equal(spec.env?.GIT_SSH_COMMAND, undefined);
    assert.equal(spec.env?.PATH, undefined, "the host PATH is never handed to the box");
    const state = JSON.parse(await readFile(join(attemptDir, "box.json"), "utf8")) as { boxId: string; procId: string };
    assert.equal(state.boxId, "box-1");
    assert.equal(state.procId, spec.detach!.procId);
  });

  test("a host project goes to the host runner", async () => {
    const r = localRig();
    const attemptDir = await freshDir();
    await r.runner.spawn(request({ kind: "shell", source: "true", attemptDir, cwd: root, projectPath: join(root, "ws", "other") }));
    assert.equal(r.host.spawned.length, 1);
    assert.equal(r.execs.length, 0);
  });

  test("a box that is not connected fails the spawn with BOX_NOT_READY", async () => {
    const r = localRig();
    r.connection.setConnected(false);
    await assert.rejects(r.runner.spawn(request({ kind: "shell", source: "true", attemptDir: await freshDir() })), /not connected/);
  });
});

describe("code blocks in a box", () => {
  test("input and secrets travel on stdin only; the result comes back and is cut out of the log", async () => {
    const r = localRig();
    const attemptDir = await freshDir();
    const secret = "s3cr3t-value-for-the-box";
    const { exit, stdout } = await runIn(
      r.runner,
      request({
        kind: "code",
        source: "export default async ({ input, secrets, log, require }) => { log('working', input.n); return { doubled: input.n * 2, secretLength: secrets.TOKEN.length, hasRequire: typeof require === 'function' }; }",
        input: { input: { n: 21 }, secrets: { TOKEN: secret } },
        attemptDir
      })
    );
    assert.equal(exit.code, 0);
    assert.deepEqual(exit.result, { ok: true, value: { doubled: 42, secretLength: secret.length, hasRequire: true } });
    assert.equal(stdout, "working 21\n");
    assert.doesNotMatch(stdout, /ORQ-RESULT/);

    const spec = r.execs.find((e) => e.detach)!;
    assert.equal(spec.command, "node");
    assert.ok(spec.args?.includes("--input-type=module"));
    assert.ok(!JSON.stringify(spec).includes(secret), "the secret is in no argument and no env var");
    // Nothing secret-bearing is written for the box (no input.json); the host keeps only its records.
    const files = await readdir(attemptDir);
    assert.ok(!files.includes("input.json"));
    for (const file of files) {
      assert.ok(!(await readFile(join(attemptDir, file), "utf8")).includes(secret), `${file} holds no secret`);
    }
  });

  test("a throw, stop() and a forged result line are handled like the host's code host", async () => {
    const r = localRig();
    const thrown = await runIn(r.runner, request({ kind: "code", source: "export default async () => { throw new Error('nope'); }", attemptDir: await freshDir() }));
    assert.equal(thrown.exit.result && "ok" in thrown.exit.result && !thrown.exit.result.ok && thrown.exit.result.error.message, "nope");

    const stopped = await runIn(r.runner, request({ kind: "code", source: "export default async ({ stop }) => stop('enough')", attemptDir: await freshDir() }));
    assert.deepEqual(stopped.exit.result, { stop: true, reason: "enough" });

    // The block cannot fake a result: it does not know the attempt's nonce.
    const forged = await runIn(
      r.runner,
      request({
        kind: "code",
        source: `export default async ({ log }) => { log('\\x1eORQ-RESULT:guess:' + Buffer.from('{"ok":true,"value":"forged"}').toString('base64')); return 'real'; }`,
        attemptDir: await freshDir()
      })
    );
    assert.deepEqual(forged.exit.result, { ok: true, value: "real" });
    assert.match(forged.stdout, /ORQ-RESULT:guess:/);
  });
});

describe("box attempts across a daemon restart", () => {
  test("a fresh runner re-adopts the attempt and reattaches from the recorded offset", async () => {
    const connection = fakeAgentConnection({ sys: { agentPath: "/opt/orq/orq-agent" } });
    const boxes = fakeBoxes();
    boxes.add(boxRecord("box-1", { project: { workspace: "ws", name: "app", path: project } }), connection);
    const host = hostRunner();
    // The first daemon run's runner stops hearing the hub when that daemon "exits".
    let firstAlive = true;
    const firstHub = {
      get: boxes.hub.get,
      onConnectionChange: (listener: (boxId: string, connected: boolean) => void) =>
        boxes.hub.onConnectionChange((boxId, connected) => {
          if (firstAlive) listener(boxId, connected);
        })
    };
    const first = createBoxAwareSandboxRunner(host, { registry: boxes.registry, hub: firstHub });
    const attemptDir = await freshDir();
    const handle = await first.spawn(request({ kind: "shell", source: "long-running", attemptDir }));
    const procId = connection.execs.find((e) => e.detach)!.detach!.procId;
    const control = connection.proc(procId)!;

    // Output before the "restart" is written by the first runner as it streams.
    const logged = new Promise<void>((resolve) => {
      void first.wait(handle, {
        ...waitOpts(),
        onLogs: (bytes) => {
          if (bytes.stdout === "before\n".length) resolve();
        }
      });
    });
    control.write("before\n");
    await logged;

    // The daemon goes away; the work keeps running and finishes in the box.
    firstAlive = false;
    connection.dropLink();
    control.write("during\n");
    control.write("oops\n", 2);
    control.exit(0);

    const second = createBoxAwareSandboxRunner(host, { registry: boxes.registry, hub: boxes.hub });
    assert.equal(second.isAlive(handle), true, "unknown until the box answers");
    const waited = second.wait(handle, waitOpts());
    connection.restoreLink();
    const exit = await waited;
    assert.equal(exit.code, 0);
    assert.equal(await readFile(join(attemptDir, "stdout.log"), "utf8"), "before\nduring\n");
    assert.equal(await readFile(join(attemptDir, "stderr.log"), "utf8"), "oops\n");
    assert.equal(second.isAlive(handle), false);
    assert.equal((await second.readExit(attemptDir))?.code, 0);
    assert.ok(connection.calls.some((c) => c.method === "proc.release"));
  });

  test("the deadline SIGTERMs the box process and records a timeout; a cancel records a cancel", async () => {
    const connection = fakeAgentConnection();
    const boxes = fakeBoxes();
    boxes.add(boxRecord("box-1", { project: { workspace: "ws", name: "app", path: project } }), connection);
    // Timers that hold the test's event loop (the daemon's are unref'd; its server holds the loop).
    const clock = {
      now: () => new Date(),
      setTimeout(fn: () => void, ms: number) {
        const timer = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(timer) };
      }
    };
    const runner = createBoxAwareSandboxRunner(hostRunner(), { registry: boxes.registry, hub: boxes.hub, clock });

    const timedDir = await freshDir();
    const timed = await runner.spawn(request({ kind: "shell", source: "sleep", attemptDir: timedDir }));
    const timedExit = await runner.wait(timed, waitOpts(new AbortController().signal, 0));
    assert.equal(timedExit.timedOut, true);
    assert.equal(timedExit.signal, "SIGTERM");

    const cancelDir = await freshDir();
    const cancelled = await runner.spawn(request({ kind: "shell", source: "sleep", attemptDir: cancelDir }));
    const abort = new AbortController();
    const waiting = runner.wait(cancelled, waitOpts(abort.signal));
    abort.abort();
    const cancelExit = await waiting;
    assert.equal(cancelExit.cancelled, true);
    assert.equal(cancelExit.timedOut, false);
  });

  test("an attempt given up while its box is away is SIGKILLed and released once it is back, retried until that succeeds", async () => {
    // The process ignores the first SIGKILL it is sent (a link that drops mid-kill), then dies.
    let kills = 0;
    let firstKillSeen!: () => void;
    const firstKill = new Promise<void>((resolve) => (firstKillSeen = resolve));
    const connection = fakeAgentConnection({
      behavior: (control) => ({
        onSignal(signal) {
          if (signal !== "SIGKILL") return;
          kills += 1;
          if (kills === 1) firstKillSeen();
          else control.exit(null, "SIGKILL");
        }
      })
    });
    const boxes = fakeBoxes();
    boxes.add(boxRecord("box-1", { project: { workspace: "ws", name: "app", path: project } }), connection);
    // A manual clock: the deadline, grace and backstop fire when the test says so.
    const timers: (() => void)[] = [];
    const clock = {
      now: () => new Date(),
      setTimeout(fn: () => void, _ms: number) {
        timers.push(fn);
        return {
          cancel: () => {
            const index = timers.indexOf(fn);
            if (index >= 0) timers.splice(index, 1);
          }
        };
      }
    };
    const runner = createBoxAwareSandboxRunner(hostRunner(), { registry: boxes.registry, hub: boxes.hub, clock });
    const handle = await runner.spawn(request({ kind: "shell", source: "sleep", attemptDir: await freshDir() }));
    const procId = connection.execs.find((e) => e.detach)!.detach!.procId;

    // The box goes away; the deadline passes and the attempt is given up.
    connection.dropLink();
    const waiting = runner.wait(handle, waitOpts(new AbortController().signal, 0));
    while (timers.length > 0) timers.shift()!();
    const exit = await waiting;
    assert.equal(exit.interrupted, true);
    assert.ok(connection.detachedProcs().some((proc) => proc.procId === procId && proc.running), "still running in the box");

    // Back: the first SIGKILL is lost with the link, so the process is still owed.
    connection.restoreLink();
    await firstKill;
    connection.dropLink();
    assert.ok(connection.detachedProcs().some((proc) => proc.procId === procId), "kept while not confirmed");

    // Next connect: killed, seen to exit, released.
    const released = connection.nextCall("proc.release");
    connection.restoreLink();
    await released;
    assert.equal(kills, 2);
    assert.ok(!connection.detachedProcs().some((proc) => proc.procId === procId), "released from the box");
  });

  test("a box destroyed under a running attempt ends it as interrupted", async () => {
    const connection = fakeAgentConnection();
    const boxes = fakeBoxes();
    boxes.add(boxRecord("box-1", { project: { workspace: "ws", name: "app", path: project } }), connection);
    const runner = createBoxAwareSandboxRunner(hostRunner(), { registry: boxes.registry, hub: boxes.hub });
    const handle = await runner.spawn(request({ kind: "shell", source: "sleep", attemptDir: await freshDir() }));
    const waiting = runner.wait(handle, waitOpts());
    connection.dropLink();
    boxes.update("box-1", { state: "destroyed" });
    const exit = await waiting;
    assert.equal(exit.interrupted, true);
    assert.equal(runner.isAlive(handle), false);
  });
});

test("the result filter finds the line across any chunking and holds only what may start it", () => {
  const nonce = "n0nce";
  const line = `\x1eORQ-RESULT:${nonce}:${Buffer.from('{"ok":true,"value":1}').toString("base64")}\n`;
  const stream = Buffer.from(`log line\npartial\x1e${line}`);
  for (let size = 1; size <= stream.length; size += 3) {
    const filter = new ResultLineFilter(nonce, 1024);
    const kept: Buffer[] = [];
    for (let at = 0; at < stream.length; at += size) kept.push(filter.push(stream.subarray(at, at + size)));
    kept.push(filter.flush());
    assert.equal(Buffer.concat(kept).toString(), "log line\npartial\x1e", `chunk size ${size}`);
    assert.equal(filter.result, '{"ok":true,"value":1}');
    assert.equal(filter.held, 0);
  }
  const holding = new ResultLineFilter(nonce, 1024);
  assert.equal(holding.push(Buffer.from("text\x1eORQ")).toString(), "text");
  assert.equal(holding.held, 4);
  assert.equal(holding.push(Buffer.from(" not it")).toString(), "\x1eORQ not it");
  assert.equal(holding.held, 0);
});
