import assert from "node:assert/strict";
import test from "node:test";

import { describeExit, exitOutcome, spawnProviderChild } from "./spawn.ts";

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
  assert.match(describeExit(reason), /failed to spawn/);
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

test("concurrent kills share one escalation", async () => {
  const proc = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", {
    killGraceMs: 100
  });
  const [a, b] = await Promise.all([proc.kill(), proc.kill()]);
  assert.deepEqual(a, b);
});

test("a detached child is signalled as a process group, so its own child dies too", async () => {
  // The parent spawns a grandchild that ignores SIGTERM; killing the GROUP is
  // what reaches it. The grandchild writes its pid so the test can check it.
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    process.stdout.write(String(g.pid));
    setInterval(() => {}, 1000);
  `;
  const proc = child(script, { detached: true, killGraceMs: 150 });
  const grandPid = await new Promise<number>((resolve) => {
    proc.stdout.once("data", (c: Buffer) => resolve(Number(c.toString("utf8").trim())));
  });

  await proc.kill();
  // Give the group signal a moment to land on the grandchild.
  await new Promise((resolve) => setTimeout(resolve, 200));

  let alive = true;
  try {
    process.kill(grandPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the whole group is signalled, not just the direct child");
});

test("exitOutcome follows the §3.1 rule", () => {
  const zero = { kind: "exit", code: 0, signal: null } as const;
  const nonZero = { kind: "exit", code: 2, signal: null } as const;

  assert.deepEqual(exitOutcome(zero, false), {
    status: "stopped",
    exitKind: "graceful",
    reason: "exited with code 0"
  });
  assert.deepEqual(exitOutcome(nonZero, false), {
    status: "error",
    exitKind: "error",
    reason: "exited with code 2"
  });
  // A host-initiated close is graceful whatever the code.
  assert.equal(exitOutcome(nonZero, true).exitKind, "graceful");
  assert.equal(exitOutcome(nonZero, true).status, "stopped");
});

test("describeExit names the signal when there is one", () => {
  assert.equal(
    describeExit({ kind: "signal", code: null, signal: "SIGKILL" }),
    "killed by SIGKILL"
  );
});
