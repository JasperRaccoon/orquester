import assert from "node:assert/strict";
import test from "node:test";

import { getPriority } from "node:os";

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

test("stderr is piped, not discarded", async () => {
  const proc = child("process.stderr.write('boom\\n'); process.exit(1)");
  const chunks: Buffer[] = [];
  proc.stderr.on("data", (c: Buffer) => chunks.push(c));
  await proc.exited;
  assert.equal(Buffer.concat(chunks).toString("utf8"), "boom\n");
});

test("the child runs at a lower CPU priority than the host", { skip: process.platform === "win32" }, async () => {
  const proc = child("process.stdout.write(String(require('node:os').getPriority()))");
  const chunks: Buffer[] = [];
  proc.stdout.on("data", (c: Buffer) => chunks.push(c));
  assert.deepEqual(await proc.exited, { kind: "exit", code: 0, signal: null });
  // Relative to whatever this runner itself was started at; 19 is the floor.
  const parentPriority = getPriority();
  const childPriority = Number(Buffer.concat(chunks).toString("utf8"));
  assert.ok(childPriority > parentPriority || (parentPriority === 19 && childPriority === 19));
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
