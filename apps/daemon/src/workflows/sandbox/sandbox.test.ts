import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { SandboxHandle, SandboxSpawnRequest } from "../contracts.ts";
import { AGENT_LAUNCH_ENV_VAR } from "../../agent-host/support/leftover-processes.ts";
import { isSameProcessAlive, readStarttime } from "./proc.ts";
import { createSandboxRunner, type SandboxExitDetail } from "./sandbox.ts";

const runner = createSandboxRunner();

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-sandbox-test-"));
});

after(async () => {
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

/** Polls a condition (never a fixed sleep): resolves once it holds, fails past `ms`. */
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const endAt = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > endAt) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("code blocks", () => {
  test("a return value is the result; log() and console.log reach stdout", async () => {
    const { exit, stdout, handle } = await code(
      "export default async ({ input, nodes, run, log }) => { log('hello', input.n); console.log('plain'); return { doubled: input.n * 2, fromNode: nodes.A.output, run: run.id }; }",
      { input: { n: 21 }, nodes: { A: { output: "a-out", status: "succeeded" } }, run: { id: "run-1" } }
    );
    assert.equal(exit.code, 0, "the code host exits 0");
    assert.deepEqual(exit.result, { ok: true, value: { doubled: 42, fromNode: "a-out", run: "run-1" } }, "the return value is the result");
    assert.equal(stdout, "hello 21\nplain\n", "log() and console.log both go to stdout.log");
    assert.equal(exit.stdoutBytes, Buffer.byteLength(stdout), "stdoutBytes counts the log");
    assert.equal(existsSync(join(handle.attemptDir, "input.json")), false, "input.json is gone once the attempt ends");
    await until("the runner to exit", () => !runner.isAlive(handle), 5_000);
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

  test("a module with top-level await works", async () => {
    const { exit } = await code("const v = await Promise.resolve(7);\nexport default () => v * 6;");
    assert.deepEqual(exit.result, { ok: true, value: 42 }, "top-level await ran before the default export");
  });

  test("a non-serializable return is an error", async () => {
    const { exit } = await code("export default () => ({ big: 10n })");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "a BigInt is refused");
    assert.ok(exit.result.error.message.length > 0);
  });

  test("a return over maxOutputBytes is an error", async () => {
    const { exit } = await code("export default () => 'x'.repeat(16 * 1024 * 1024)");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "an oversized result is refused");
    assert.ok(exit.result.error.message.length > 0);
  });

  test("a default export that is not a function is a clear error", async () => {
    const none = await code("export const x = 1;");
    assert.ok(none.exit.result && "ok" in none.exit.result && none.exit.result.ok === false, "no default export fails");
    assert.ok(none.exit.result.error.message.length > 0);
    const object = await code("export default { a: 1 };");
    assert.ok(object.exit.result && "ok" in object.exit.result && object.exit.result.ok === false, "an object default fails");
    assert.ok(object.exit.result.error.message.length > 0);
  });

  test("a syntax error is a failure", async () => {
    const { exit } = await code("export default () => {");
    assert.ok(exit.result && "ok" in exit.result && exit.result.ok === false, "an unparsable module fails");
  });

  test("an open handle does not hold the attempt", async () => {
    const { exit } = await code("export default () => { setInterval(() => {}, 1000); return 'done'; }");
    assert.deepEqual(exit.result, { ok: true, value: "done" }, "the host exits once the result is written");
  });
});

describe("shell blocks", () => {
  test("stdout, stderr and the exit code", async () => {
    const ok = await shell("echo out; echo err >&2");
    assert.equal(ok.exit.code, 0, "a clean script exits 0");
    assert.equal(ok.stdout, "out\n", "stdout is captured");
    assert.equal(ok.stderr, "err\n", "stderr is captured");
    assert.equal(ok.exit.result, undefined, "a shell block has no result.json");

    const failed = await shell("echo nope; exit 7");
    assert.equal(failed.exit.code, 7, "the script's exit code is recorded");
    assert.equal(failed.exit.signal, null, "no signal ended it");
  });

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
        source: `trap '' TERM; touch ${JSON.stringify(ready)}; while true; do sleep 0.05; done`,
        attemptDir
      })
    );
    await until("the trap to be installed", () => existsSync(ready));
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
    await until("the grandchild's pid", async () => (await stat(pidFile).catch(() => null))?.size !== undefined && (await readFile(pidFile, "utf8")).trim().length > 0);
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
    await until("the runner to exit", () => !runner.isAlive(handle), 5_000);
    await until("the grandchild to be gone", () => !isSameProcessAlive(grandchild, grandchildStart), 5_000);
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
    const handle = await runner.spawn(request({ kind: "shell", source: "sleep 60", attemptDir }));
    await until("child.json", () => existsSync(join(attemptDir, "child.json")));
    const child = JSON.parse(await readFile(join(attemptDir, "child.json"), "utf8")) as { pid: number; starttime: number };
    process.kill(handle.pid, "SIGKILL");
    const exit = await runner.wait(handle, waitOpts());
    assert.equal(exit.interrupted, true, "no exit.json: interrupted");
    assert.equal(exit.code, null, "no exit code");
    assert.equal(exit.signal, "SIGKILL", "reported as killed");
    await until("the orphaned work to be gone", () => !isSameProcessAlive(child.pid, child.starttime), 5_000);
  });

  test("a restarted daemon adopts a running attempt and reads its exit", async () => {
    const attemptDir = await freshDir();
    const go = join(attemptDir, "go");
    const handle = await runner.spawn(
      request({ kind: "shell", source: `while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.02; done; echo finished; exit 4`, attemptDir })
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
    await until("the adopted runner to exit", () => !adopter.isAlive(persisted), 5_000);
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
