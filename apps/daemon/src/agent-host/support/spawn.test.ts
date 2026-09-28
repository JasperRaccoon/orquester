import assert from "node:assert/strict";
import test from "node:test";

import { exitOutcome, spawnProviderChild } from "./spawn.ts";

const NODE = process.execPath;

function child(script: string, extra: Partial<Parameters<typeof spawnProviderChild>[0]> = {}) {
  return spawnProviderChild({
    command: NODE,
    args: ["-e", script],
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
    cwd: process.cwd(),
    ...extra
  });
}

test("records the pid and resolves with the exit code", async () => {
  const proc = child("process.exit(3)");
  assert.equal(typeof proc.pid, "number");
  assert.ok((proc.pid ?? 0) > 0);
  const reason = await proc.exited;
  assert.deepEqual(reason, { kind: "exit", code: 3, signal: null });
  assert.equal(proc.hasExited(), true);
  assert.deepEqual(proc.exitReason(), reason);
});

test("the environment is exactly what was passed — nothing is inherited", async () => {
  process.env.ORQ_SPAWN_CANARY = "leaked";
  try {
    const proc = spawnProviderChild({
      command: NODE,
      args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      env: { PATH: "/usr/bin:/bin", ORQUESTER_SESSION_ID: "s1" },
      cwd: process.cwd()
    });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    await proc.exited;
    const keys = JSON.parse(Buffer.concat(chunks).toString("utf8")) as string[];
    assert.deepEqual(keys, ["ORQUESTER_SESSION_ID", "PATH"]);
  } finally {
    delete process.env.ORQ_SPAWN_CANARY;
  }
});

test("stderr is piped, not discarded", async () => {
  const proc = child("process.stderr.write('boom\\n'); process.exit(1)");
  const chunks: Buffer[] = [];
  proc.stderr.on("data", (c: Buffer) => chunks.push(c));
  await proc.exited;
  assert.equal(Buffer.concat(chunks).toString("utf8"), "boom\n");
});

test("a spawn failure is an outcome, never a throw", async () => {
  const proc = spawnProviderChild({
    command: "/nonexistent/orquester-agent-binary",
    args: [],
    env: { PATH: "/usr/bin" },
    cwd: process.cwd()
  });
  const reason = await proc.exited;
  assert.equal(reason.kind, "spawn-error");
});

test("kill escalates SIGTERM to SIGKILL past the grace deadline", async () => {
  // Ignores SIGTERM and keeps an interval alive, so only SIGKILL ends it.
  const proc = child(
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('up')",
    { killGraceMs: 150 }
  );
  await new Promise<void>((resolve) => proc.stdout.once("data", () => resolve()));

  const reason = await proc.kill();
  assert.equal(reason.kind, "signal");
  assert.equal(reason.signal, "SIGKILL");
});

test("kill is idempotent and safe after the child is already gone", async () => {
  const proc = child("process.exit(0)");
  await proc.exited;
  const a = await proc.kill();
  const b = await proc.kill();
  assert.deepEqual(a, b);
  assert.deepEqual(a, { kind: "exit", code: 0, signal: null });
});

test("exitOutcome follows the §3.1 rule", () => {
  const zero = { kind: "exit", code: 0, signal: null } as const;
  const nonZero = { kind: "exit", code: 2, signal: null } as const;

  assert.equal(exitOutcome(zero, false).status, "stopped");
  assert.equal(exitOutcome(zero, false).exitKind, "graceful");
  assert.equal(exitOutcome(nonZero, false).status, "error");
  assert.equal(exitOutcome(nonZero, false).exitKind, "error");
  // A host-initiated close is graceful whatever the code.
  assert.equal(exitOutcome(nonZero, true).exitKind, "graceful");
  assert.equal(exitOutcome(nonZero, true).status, "stopped");
});
