/**
 * The bounded git runner. The "git" here is a stand-in script, because what is
 * under test is the bounding — env, exit handling, timeout, output cap,
 * transient retry and the permit pool — not git itself. The real thing is
 * exercised end-to-end in `service.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitExitError,
  GitOutputLimitError,
  GitTimeoutError,
  Semaphore,
  createGitRunner,
  isTransientGitExit
} from "./git.ts";

const FAKE = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [mode, ...rest] = process.argv.slice(2);
if (mode === "env") {
  process.stdout.write(JSON.stringify(process.env));
} else if (mode === "exit") {
  if (rest[1]) process.stderr.write(rest[1]);
  process.exit(Number(rest[0]));
} else if (mode === "spew") {
  process.stdout.write("x".repeat(Number(rest[0])));
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "stdin") {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => process.stdout.write(Buffer.concat(chunks).toString("hex")));
} else if (mode === "flaky") {
  let count = 0;
  try { count = Number(readFileSync(rest[0], "utf8")); } catch {}
  count += 1;
  writeFileSync(rest[0], String(count));
  if (count <= Number(rest[1])) {
    process.stderr.write("fatal: Unable to create '/repo/.git/index.lock': File exists.");
    process.exit(1);
  }
  process.stdout.write("recovered after " + count);
} else if (mode === "trace") {
  appendFileSync(rest[0], "start\\n");
  setTimeout(() => { appendFileSync(rest[0], "end\\n"); }, 60);
}
`;

async function fakeGit(t: { after(fn: () => unknown): void }): Promise<{
  dir: string;
  script: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "orq-fakegit-"));
  const script = join(dir, "fake-git.mjs");
  await writeFile(script, FAKE, "utf8");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, script };
}

function runnerFor(env: Record<string, string> = {}) {
  return createGitRunner({
    gitEnv: { PATH: "/usr/bin:/bin", ...env },
    resolveGitBinary: () => process.execPath
  });
}

test("the child env is exactly what was configured, plus the runner's defaults", async (t) => {
  const { script } = await fakeGit(t);
  process.env.ORQ_CHECKPOINT_CANARY = "leaked";
  t.after(() => {
    delete process.env.ORQ_CHECKPOINT_CANARY;
  });

  const runner = runnerFor({ HOME: "/tmp/home" });
  const result = await runner.run({
    operation: "test",
    cwd: process.cwd(),
    args: [script, "env"],
    env: { GIT_INDEX_FILE: "/tmp/idx", LC_ALL: undefined }
  });
  const env = JSON.parse(result.stdout) as Record<string, string>;

  assert.equal(env.ORQ_CHECKPOINT_CANARY, undefined, "process.env is never spread in");
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.GIT_INDEX_FILE, "/tmp/idx");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "a credential prompt can never park a child");
  assert.equal(env.LC_ALL, undefined, "an explicit undefined removes a key");
});

test("a non-zero exit throws unless the caller allows it", async (t) => {
  const { script } = await fakeGit(t);
  const runner = runnerFor();

  await assert.rejects(
    runner.run({ operation: "test", cwd: process.cwd(), args: [script, "exit", "3", "boom"] }),
    (error: unknown) => {
      assert.ok(error instanceof GitExitError);
      assert.equal(error.exitCode, 3);
      assert.match(error.message, /boom/);
      assert.equal(error.retryable, false);
      return true;
    }
  );

  const allowed = await runner.run({
    operation: "test",
    cwd: process.cwd(),
    args: [script, "exit", "3", "boom"],
    allowNonZeroExit: true
  });
  assert.equal(allowed.exitCode, 3);
  assert.match(allowed.stderr, /boom/);
});

test("a hung child is killed at the deadline", async (t) => {
  const { script } = await fakeGit(t);
  const runner = runnerFor();
  await assert.rejects(
    runner.run({
      operation: "test",
      cwd: process.cwd(),
      args: [script, "hang"],
      timeoutMs: 120
    }),
    GitTimeoutError
  );
});

test("output over the cap truncates, or fails when the answer must be whole", async (t) => {
  const { script } = await fakeGit(t);
  const runner = runnerFor();

  const truncated = await runner.run({
    operation: "test",
    cwd: process.cwd(),
    args: [script, "spew", "5000"],
    maxOutputBytes: 100,
    appendTruncationMarker: true
  });
  assert.equal(truncated.stdoutTruncated, true);
  assert.equal(truncated.stdout.slice(0, 100), "x".repeat(100));
  assert.match(truncated.stdout, /\[truncated\]$/);

  await assert.rejects(
    runner.run({
      operation: "test",
      cwd: process.cwd(),
      args: [script, "spew", "5000"],
      maxOutputBytes: 100,
      outputMode: "error"
    }),
    GitOutputLimitError
  );
});

test("a transient lock failure is retried, and only when the caller asked", async (t) => {
  const { dir, script } = await fakeGit(t);
  const runner = runnerFor();

  const counter = join(dir, "attempts-retry");
  const recovered = await runner.run({
    operation: "test",
    cwd: process.cwd(),
    args: [script, "flaky", counter, "2"],
    retryTransient: true
  });
  assert.equal(recovered.stdout, "recovered after 3");

  const other = join(dir, "attempts-plain");
  await assert.rejects(
    runner.run({
      operation: "test",
      cwd: process.cwd(),
      args: [script, "flaky", other, "2"]
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitExitError);
      assert.equal(error.retryable, true, "classified as transient, just not retried here");
      return true;
    }
  );

  // Three attempts is the ceiling: a failure that outlasts them still surfaces.
  const stubborn = join(dir, "attempts-stubborn");
  await assert.rejects(
    runner.run({
      operation: "test",
      cwd: process.cwd(),
      args: [script, "flaky", stubborn, "99"],
      retryTransient: true
    }),
    GitExitError
  );
});

test("stdin reaches the child byte for byte", async (t) => {
  const { script } = await fakeGit(t);
  const runner = runnerFor();
  const payload = "delete refs/x\0\0delete refs/y\0\0";
  const result = await runner.run({
    operation: "test",
    cwd: process.cwd(),
    args: [script, "stdin"],
    stdin: payload
  });
  assert.equal(result.stdout, Buffer.from(payload, "utf8").toString("hex"));
});

test("the permit pool never lets more than its count run at once", async (t) => {
  const { dir, script } = await fakeGit(t);
  const trace = join(dir, "trace.log");
  const runner = createGitRunner({
    gitEnv: { PATH: "/usr/bin:/bin" },
    maxConcurrentGit: 1,
    resolveGitBinary: () => process.execPath
  });

  await Promise.all(
    [0, 1, 2].map(() =>
      runner.run({ operation: "test", cwd: process.cwd(), args: [script, "trace", trace] })
    )
  );

  const lines = (await readFile(trace, "utf8")).trim().split("\n");
  assert.deepEqual(lines, ["start", "end", "start", "end", "start", "end"]);
});

test("Semaphore hands out exactly its permits and releases once", async () => {
  const semaphore = new Semaphore(2);
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  let thirdAcquired = false;
  const third = semaphore.acquire().then((release) => {
    thirdAcquired = true;
    return release;
  });

  await Promise.resolve();
  assert.equal(thirdAcquired, false, "the third caller waits");

  first();
  first(); // a double release must not create a permit out of thin air
  const release = await third;
  assert.equal(thirdAcquired, true);
  release();
  second();
});

test("only real lock/ENOENT noise is classified as transient", () => {
  assert.equal(
    isTransientGitExit("fatal: Unable to create '/r/.git/index.lock': File exists."),
    true
  );
  assert.equal(isTransientGitExit("error: open(\"a.txt\"): No such file or directory"), true);
  assert.equal(isTransientGitExit("error: pathspec 'nope' did not match any file"), false);
});
