import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";

import type { SandboxHandle, SandboxSpawnRequest } from "../contracts.ts";
import { AGENT_LAUNCH_ENV_VAR } from "../../agent-host/support/leftover-processes.ts";
import { isSameProcessAlive, readStarttime, signalGroupIfOurs } from "./proc.ts";
import { createSandboxRunner, type SandboxExitDetail } from "./sandbox.ts";
import { waitForFileState } from "../testing/daemon-harness.ts";

const runner = createSandboxRunner();

let root: string;
let counter = 0;
const exits = new Map<number, { child: ChildProcess; closed: Promise<void> }>();
const spawn = childProcess.spawn;
const observed = mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
  const child = spawn(command, args, options);
  if (child.pid !== undefined) exits.set(child.pid, { child, closed: new Promise((resolve) => child.once("close", () => resolve())) });
  return child;
});
syncBuiltinESMExports();

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-sandbox-test-"));
});

after(async () => {
  observed.mock.restore();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  counter += 1;
  const dir = join(root, `attempt-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function request(overrides: Partial<SandboxSpawnRequest> & Pick<SandboxSpawnRequest, "kind" | "source" | "attemptDir">): SandboxSpawnRequest {
  return {
    cwd: root,
    env: {},
    timeoutMs: 30_000,
    runId: "run-1",
    workflowId: "wf-1",
    projectPath: root,
    ...overrides
  };
}

function waitOpts(signal: AbortSignal = new AbortController().signal, deadlineMs = 30_000) {
  return { deadlineAt: new Date(Date.now() + deadlineMs), signal };
}

async function run(req: SandboxSpawnRequest): Promise<{ exit: SandboxExitDetail; handle: SandboxHandle; stdout: string; stderr: string }> {
  const handle = await runner.spawn(req);
  const exit = await runner.wait(handle, waitOpts());
  const stdout = await readFile(join(req.attemptDir, "stdout.log"), "utf8").catch(() => "");
  const stderr = await readFile(join(req.attemptDir, "stderr.log"), "utf8").catch(() => "");
  return { exit, handle, stdout, stderr };
}

async function code(source: string, input: Record<string, unknown> = {}, extra: Partial<SandboxSpawnRequest> = {}) {
  return run(request({ kind: "code", source, input, attemptDir: await freshDir(), ...extra }));
}

async function shell(source: string, extra: Partial<SandboxSpawnRequest> = {}) {
  return run(request({ kind: "shell", source, attemptDir: await freshDir(), ...extra }));
}

async function runnerExited(handle: SandboxHandle): Promise<void> {
  const exited = exits.get(handle.pid);
  assert.ok(exited, "the fixture observed the spawned runner");
  exited.child.ref();
  await exited.closed;
}

describe("code blocks", () => {
  test("an async module returns its result and logs, then exits despite an open handle", async () => {
    const { exit, stdout, handle } = await code(
      "const multiplier = await Promise.resolve(2); export default async ({ input, nodes, run, log }) => { setInterval(() => {}, 1000); log('hello', input.n); console.log('plain'); return { doubled: input.n * multiplier, fromNode: nodes.A.output, run: run.id }; }",
      { input: { n: 21 }, nodes: { A: { output: "a-out", status: "succeeded" } }, run: { id: "run-1" } }
    );
    assert.equal(exit.code, 0, "the code host exits 0");
    assert.deepEqual(exit.result, { ok: true, value: { doubled: 42, fromNode: "a-out", run: "run-1" } }, "the return value is the result");
    assert.equal(stdout, "hello 21\nplain\n", "log() and console.log both go to stdout.log");
    assert.equal(exit.stdoutBytes, Buffer.byteLength(stdout), "stdoutBytes counts the log");
    assert.equal(existsSync(join(handle.attemptDir, "input.json")), false, "input.json is gone once the attempt ends");
    await runnerExited(handle);
  });

  test("undefined returns as null", async () => {
    const { exit } = await code("export default () => {}");
    assert.deepEqual(exit.result, { ok: true, value: null }, "undefined is stored as null");
  });

  test("a throw is a failure with message and stack", async () => {
    const { exit } = await code("export default () => { throw new Error('boom'); }");
    assert.equal(exit.code, 1, "a failing block exits non-zero");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "the result is a failure");
    assert.equal(exit.result.error.message, "boom", "the error's message is kept");
    assert.match(exit.result.error.stack ?? "", /boom/, "the error's stack is kept");
  });

  test("stop() ends the run as stopped, with its reason, even from a promise chain", async () => {
    const { exit, stdout } = await code(
      "export default async ({ stop, log }) => { await Promise.resolve(); try { stop('nothing to do'); } catch { log('caught'); } finally { log('continued'); } return 'not reached'; }"
    );
    assert.deepEqual(exit.result, { stop: true, reason: "nothing to do" }, "stop() records its reason");
    assert.equal(exit.code, 0, "a stop is not a crash");
    assert.equal(stdout, "", "stop() exits before catch or finally can continue the block");
  });

  test("require resolves the project's own node_modules", async () => {
    const project = join(root, "project-with-deps");
    const pkg = join(project, "node_modules", "fake-pkg");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fake-pkg", version: "1.0.0", main: "index.js" }));
    await writeFile(join(pkg, "index.js"), "module.exports = { answer: 42 };\n");
    const { exit } = await code("export default ({ require }) => require('fake-pkg').answer", {}, { projectPath: project, cwd: project });
    assert.deepEqual(exit.result, { ok: true, value: 42 }, "the package came from <project>/node_modules");
  });

  test("a non-serializable return is an error", async () => {
    const { exit } = await code("export default () => ({ big: 10n })");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "a BigInt is refused");
    assert.match(exit.result.error.message, /JSON-serializable/);
  });

  test("a return over maxOutputBytes is an error", async () => {
    const { exit } = await code("export default () => 'x'.repeat(16 * 1024 * 1024)");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "an oversized result is refused");
    assert.match(exit.result.error.message, /bytes.*limit.*16777216/i);
  });

  test("a default export that is not a function is a clear error", async () => {
    const none = await code("export const x = 1;");
    assert.ok(none.exit.result && "ok" in none.exit.result && none.exit.result.ok === false, "no default export fails");
    assert.match(none.exit.result.error.message, /no default export/i);
  });

  test("a syntax error is a failure", async () => {
    const { exit } = await code("export default () => {");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "an unparsable module fails");
    assert.match(exit.result.error.stack ?? "", /^SyntaxError:/);
  });

});

describe("shell blocks", () => {
  test("sh works too, and the cwd is the request's", async () => {
    const { exit, stdout } = await shell("pwd", { shell: "sh" });
    assert.equal(exit.code, 0, "sh ran the script");
    assert.equal(stdout.trim(), root, "the work runs in the request's cwd");
  });

  test("each stream is capped with one notice line", async () => {
    const { exit, stdout } = await shell("head -c 52429824 /dev/zero | tr '\\0' 'a'; echo tail >&2");
    assert.ok(stdout.startsWith("a".repeat(50 * 1024 * 1024)), "the specified first 50 MiB are kept");
    const notice = stdout.slice(50 * 1024 * 1024).trim();
    assert.ok(notice.length > 0, "truncation is reported");
    assert.equal(notice.split("\n").length, 1, "exactly one notice");
    assert.equal(exit.stdoutCapped, true, "exit.json says stdout was capped");
    assert.equal(exit.stdoutBytes, Buffer.byteLength(stdout), "stdoutBytes is what the file holds");
    assert.equal(exit.stderrCapped, undefined, "stderr was not capped");
  });

  test("the environment is built, never inherited", async () => {
    const saved = process.env.ORQUESTER_HTTP_PASSWORD;
    process.env.ORQUESTER_HTTP_PASSWORD = "hunter2-do-not-leak";
    try {
      const { stdout } = await run(
        request({
          kind: "shell",
          source: "env",
          attemptDir: await freshDir(),
          env: { FOO: "bar", [AGENT_LAUNCH_ENV_VAR]: "spoofed", ORQUESTER_WORKFLOW_RUN_ID: "spoofed" }
        })
      );
      const env = new Map(
        stdout
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const)
      );
      assert.equal(stdout.includes("hunter2-do-not-leak"), false, "a daemon credential never reaches the child");
      assert.equal(env.has("ORQUESTER_HTTP_PASSWORD"), false, "not even the name");
      assert.match(env.get(AGENT_LAUNCH_ENV_VAR) ?? "", /^[0-9a-f-]{36}$/, "the launch marker is a fresh UUID");
      assert.equal(env.get("ORQUESTER_WORKFLOW_RUN_ID"), "run-1", "the run id cannot be shadowed");
      assert.equal(env.get("ORQUESTER_WORKFLOW_ID"), "wf-1", "the workflow id is set");
      assert.equal(env.get("FOO"), "bar", "the block's env is applied");
      assert.equal(env.get("TERM"), "dumb", "TERM is dumb");
      assert.ok(env.get("PATH"), "PATH is the session PATH");
      assert.ok(env.get("HOME"), "HOME is set");
      assert.ok(env.get("TMPDIR"), "TMPDIR is set");
    } finally {
      if (saved === undefined) delete process.env.ORQUESTER_HTTP_PASSWORD;
      else process.env.ORQUESTER_HTTP_PASSWORD = saved;
    }
  });

  test("an invalid env name refuses the spawn", async () => {
    await assert.rejects(
      runner.spawn(request({ kind: "shell", source: "true", attemptDir: await freshDir(), env: { "BAD-NAME": "x" } })),
      /Invalid environment variable name/,
      "a name the shell cannot hold is refused"
    );
  });

  test("a missing cwd refuses the spawn", async () => {
    await assert.rejects(
      runner.spawn(request({ kind: "shell", source: "true", attemptDir: await freshDir(), cwd: join(root, "does-not-exist") })),
      { code: "ENOENT" },
      "the runner cannot start in a directory that does not exist"
    );
  });
});

describe("deadlines, cancels and restarts", () => {
  test("the runner enforces the deadline itself", async () => {
    const attemptDir = await freshDir();
    const handle = await runner.spawn(request({ kind: "shell", source: "sleep 30", attemptDir, timeoutMs: 200 }));
    // wait()'s own backstop is far away: only the runner can end this in time.
    const exit = await runner.wait(handle, waitOpts(new AbortController().signal, 60_000));
    assert.equal(exit.timedOut, true, "exit.json says it timed out");
    assert.equal(exit.cancelled, false, "a timeout is not a cancel");
    assert.equal(exit.signal, "SIGTERM", "the work was ended by SIGTERM");
    assert.equal(exit.interrupted, undefined, "the runner recorded it");
  });

  test("a work that ignores SIGTERM is SIGKILLed after the grace", async () => {
    const attemptDir = await freshDir();
    const ready = join(attemptDir, "trap-installed");
    const handle = await runner.spawn(
      request({
        kind: "shell",
        source: `trap '' TERM; touch ${JSON.stringify(ready)}; exec tail -f /dev/null`,
        attemptDir
      })
    );
    await waitForFileState(ready, async () => existsSync(ready), Boolean);
    const controller = new AbortController();
    const waiting = runner.wait(handle, waitOpts(controller.signal));
    controller.abort();
    const exit = await waiting;
    assert.equal(exit.cancelled, true, "cancelled");
    assert.equal(exit.signal, "SIGKILL", "the grace ran out and SIGKILL ended it");
  });

  test("a cancel kills the whole group, grandchildren included", async (t) => {
    if (process.platform !== "linux") {
      t.skip("needs /proc");
      return;
    }
    const attemptDir = await freshDir();
    const pidFile = join(attemptDir, "grandchild.pid");
    const handle = await runner.spawn(
      request({ kind: "shell", source: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`, attemptDir })
    );
    assert.equal(runner.isAlive(handle), true, "the runner is alive while the work runs");
    await waitForFileState(pidFile, () => readFile(pidFile, "utf8").catch(() => ""), (text) => /^\d+\s*$/.test(text));
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    const grandchildStart = readStarttime(grandchild);
    assert.ok(grandchildStart > 0, "the grandchild is running");

    const controller = new AbortController();
    const waiting = runner.wait(handle, waitOpts(controller.signal));
    controller.abort();
    const exit = await waiting;
    assert.equal(exit.cancelled, true, "exit.json records the cancel");
    assert.equal(exit.timedOut, false, "a cancel is not a timeout");
    // exit.json is written just before the runner exits.
    await runnerExited(handle);
    assert.equal(isSameProcessAlive(grandchild, grandchildStart), false, "the grandchild is gone when the runner exits");
  });

  test("kill() ends a running attempt", async () => {
    const attemptDir = await freshDir();
    const handle = await runner.spawn(request({ kind: "code", source: "export default () => new Promise(() => { setInterval(() => {}, 1000); });", attemptDir }));
    await runner.kill(handle);
    assert.equal(runner.isAlive(handle), false, "kill() returns once the runner is gone");
    const exit = await runner.readExit(attemptDir);
    assert.ok(exit !== null, "the runner still recorded its exit");
    assert.equal(exit.cancelled, true, "as a cancel");
    assert.equal(exit.result, undefined, "the code never produced a result");
  });

  test("a runner killed outright reads as interrupted, and its work is ended", async (t) => {
    if (process.platform !== "linux") {
      t.skip("needs /proc");
      return;
    }
    const attemptDir = await freshDir();
    const server = createServer();
    t.after(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connected = once(server, "connection");
    const port = (server.address() as AddressInfo).port;
    const handle = await runner.spawn(request({ kind: "shell", source: `node -e 'require("node:net").connect(${port}, "127.0.0.1");'`, attemptDir }));
    const [socket] = await connected;
    t.after(() => socket.destroy());
    let child: { pid: number; starttime: number } | undefined;
    t.after(() => {
      signalGroupIfOurs(handle.pid, handle.starttime, "SIGKILL");
      if (child) signalGroupIfOurs(child.pid, child.starttime, "SIGKILL");
    });
    await waitForFileState(join(attemptDir, "child.json"), async () => existsSync(join(attemptDir, "child.json")), Boolean);
    child = JSON.parse(await readFile(join(attemptDir, "child.json"), "utf8")) as { pid: number; starttime: number };
    assert.equal(isSameProcessAlive(child.pid, child.starttime), true, "the work is running before the runner dies");
    process.kill(handle.pid, "SIGKILL");
    await runnerExited(handle);
    // The live work and its SIGTERM remain real. Once it is gone, advance only the host's
    // documented 5 s escalation grace; the separate SIGTERM-resistant case keeps real time.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gone = once(socket, "close");
    const waiting = runner.wait(handle, waitOpts());
    await gone;

    t.mock.timers.tick(5_000);
    const exit = await waiting;
    assert.equal(exit.interrupted, true, "no exit.json: interrupted");
    assert.equal(exit.code, null, "no exit code");
    assert.equal(exit.signal, "SIGKILL", "reported as killed");
  });

  test("a restarted daemon adopts a running attempt and reads its exit", async () => {
    const attemptDir = await freshDir();
    const go = join(attemptDir, "go");
    const handle = await runner.spawn(
      request({ kind: "shell", source: `node -e 'const fs = require("node:fs"); const file = process.argv[1]; const done = () => { if (fs.existsSync(file)) { console.log("finished"); process.exit(4); } }; fs.watch(require("node:path").dirname(file), done); done();' ${JSON.stringify(go)}`, attemptDir })
    );
    // What run.json would persist; a new runner instance knows nothing else.
    const persisted = JSON.parse(await readFile(join(attemptDir, "handle.json"), "utf8")) as SandboxHandle;
    assert.deepEqual(persisted, handle, "handle.json holds the handle");
    const adopter = createSandboxRunner();
    assert.equal(adopter.isAlive(persisted), true, "the adopted runner is alive (pid + starttime)");
    const sizes: Array<{ stdout: number; stderr: number }> = [];
    const waiting = adopter.wait(persisted, { ...waitOpts(), onLogs: (bytes) => sizes.push(bytes) });
    await writeFile(go, "");
    const exit = await waiting;
    assert.equal(exit.code, 4, "the exit code came from exit.json");
    // exit.json is written just before the runner exits.
    await runnerExited(persisted);
    assert.deepEqual(sizes.at(-1), { stdout: 9, stderr: 0 }, "onLogs reported the final sizes");
  });

  test("isAlive refuses a recycled pid (starttime mismatch)", (t) => {
    if (process.platform !== "linux") {
      t.skip("needs /proc");
      return;
    }
    const self = { pid: process.pid, starttime: readStarttime(process.pid), attemptDir: root };
    assert.equal(runner.isAlive(self), true, "our own pid and starttime match");
    assert.equal(runner.isAlive({ ...self, starttime: self.starttime + 1 }), false, "another starttime is another process");
  });
});
