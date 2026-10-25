import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoxExecOptions } from "../../boxes/contracts.ts";
import { localBoxConnection } from "../../boxes/testing.ts";
import { DETACHED_BUFFER_BYTES, spawnBoxChild } from "./remote-child.ts";
import { reattachableBoxConnection } from "./testing.ts";

/** Collect a readable's text until a predicate holds (event-driven, never a sleep). */
function collect(stream: NodeJS.ReadableStream): { text: () => string; until: (predicate: (text: string) => boolean) => Promise<void> } {
  let text = "";
  const waiters: { predicate: (text: string) => boolean; resolve: () => void }[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    text += chunk.toString();
    for (const waiter of [...waiters]) {
      if (waiter.predicate(text)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  return {
    text: () => text,
    until: (predicate) =>
      predicate(text) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ predicate, resolve }))
  };
}

const ECHO = `
process.stdout.write("ready\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line === "quit") process.exit(7);
    process.stdout.write("echo:" + line + "\\n");
  }
});
process.on("SIGUSR2", () => process.stdout.write("during-drop\\n"));
process.stdin.on("end", () => process.exit(0));
`;

test("a box child has the ProviderChild shape: stdio, exit code, no local pid", async () => {
  const connection = localBoxConnection();
  const child = spawnBoxChild({ connection, command: process.execPath, args: ["-e", ECHO], env: {}, cwd: process.cwd() });
  assert.equal(child.pid, undefined);
  assert.equal(child.process, null);
  assert.equal(child.box.boxId, connection.boxId);
  const out = collect(child.stdout);
  await out.until((text) => text.includes("ready\n"));
  child.stdin.write("hello\n");
  await out.until((text) => text.includes("echo:hello\n"));
  child.stdin.write("quit\n");
  const reason = await child.exited;
  assert.deepEqual(reason, { kind: "exit", code: 7, signal: null });
  assert.equal(child.hasExited(), true);
});

test("kill() is SIGTERM, then SIGKILL in the box once the grace runs out", async () => {
  const connection = localBoxConnection();
  const stubborn = `process.on("SIGTERM", () => process.stdout.write("ignored\\n")); process.stdout.write("up\\n"); setInterval(() => {}, 1000);`;
  const child = spawnBoxChild({ connection, command: process.execPath, args: ["-e", stubborn], env: {}, cwd: process.cwd(), killGraceMs: 200 });
  const out = collect(child.stdout);
  await out.until((text) => text.includes("up\n"));
  const reason = await child.kill();
  assert.deepEqual(reason, { kind: "signal", code: null, signal: "SIGKILL" });
  assert.match(out.text(), /ignored/);
  // Idempotent after the end.
  assert.deepEqual(await child.kill(), reason);
  assert.equal(child.signal("SIGTERM"), false);
});

test("a command the box cannot start is a spawn-error outcome, never a throw", async () => {
  const connection = localBoxConnection();
  const child = spawnBoxChild({ connection, command: "/nonexistent/orq-box-cli", args: [], env: {}, cwd: process.cwd() });
  const reason = await child.exited;
  assert.equal(reason.kind, "spawn-error");
});

test("a detached child survives a dropped link and reattaches from the bytes it had", async () => {
  const connection = reattachableBoxConnection();
  const child = spawnBoxChild({
    connection,
    command: process.execPath,
    args: ["-e", ECHO],
    env: {},
    cwd: process.cwd(),
    detach: { procId: "agent-test-1" }
  });
  const out = collect(child.stdout);
  await out.until((text) => text.includes("ready\n"));
  child.stdin.write("a\n");
  await out.until((text) => text.includes("echo:a\n"));
  const received = Buffer.byteLength(out.text());

  connection.dropLink();
  // Written while the link is down: held, delivered after the reattach.
  child.stdin.write("b\n");
  // The process runs on in the box and writes while nobody is attached.
  await connection.request("proc.signal", { procId: "agent-test-1", signal: "SIGUSR2" });
  await connection.outputSeen("agent-test-1", (text) => text.includes("during-drop\n"));
  assert.equal(child.hasExited(), false);

  connection.restoreLink();
  await out.until((text) => text.includes("echo:b\n"));
  assert.deepEqual(connection.attaches, [{ procId: "agent-test-1", fromOffset: received }]);
  // Nothing lost, nothing repeated.
  assert.equal(out.text(), "ready\necho:a\nduring-drop\necho:b\n");
  child.stdin.write("quit\n");
  assert.deepEqual(await child.exited, { kind: "exit", code: 7, signal: null });
});

test("a detached child asks the box to keep a large output buffer unless told otherwise", async () => {
  const connection = reattachableBoxConnection();
  const asked: (BoxExecOptions["detach"] | undefined)[] = [];
  const exec = connection.exec.bind(connection);
  connection.exec = (options: BoxExecOptions) => {
    asked.push(options.detach);
    return exec(options);
  };
  for (const detach of [{ procId: "agent-test-buffer" }, { procId: "agent-test-small", bufferBytes: 1024 }]) {
    const child = spawnBoxChild({ connection, command: process.execPath, args: ["-e", ECHO], env: {}, cwd: process.cwd(), detach });
    await collect(child.stdout).until((text) => text.includes("ready\n"));
    child.stdin.write("quit\n");
    await child.exited;
  }
  assert.deepEqual(asked, [
    { procId: "agent-test-buffer", bufferBytes: DETACHED_BUFFER_BYTES },
    { procId: "agent-test-small", bufferBytes: 1024 }
  ]);
  assert.ok(DETACHED_BUFFER_BYTES >= 64 * 1024 * 1024);
});

test("a detached child whose box never comes back ends as SIGHUP at the reattach deadline", async () => {
  const connection = reattachableBoxConnection();
  const notices: string[] = [];
  const child = spawnBoxChild({
    connection,
    command: process.execPath,
    args: ["-e", ECHO],
    env: {},
    cwd: process.cwd(),
    detach: { procId: "agent-test-2" },
    reattachTimeoutMs: 50,
    onNotice: (message) => notices.push(message)
  });
  const out = collect(child.stdout);
  await out.until((text) => text.includes("ready\n"));
  connection.dropLink();
  assert.deepEqual(await child.exited, { kind: "signal", code: null, signal: "SIGHUP" });
  assert.ok(notices.some((notice) => notice.includes("did not come back")));
  connection.restoreLink();
  // The test's own process in the "box" is cleaned up.
  await connection.killAll();
});

/** A detached child that saw `ready`, its link dropped, and `orq-agent` restarted under it. */
async function childAcrossARestart(mode: "lose" | "forget" | "unrecorded"): Promise<{ reason: unknown; errText: string; notices: string[] }> {
  const connection = reattachableBoxConnection();
  const notices: string[] = [];
  const child = spawnBoxChild({
    connection,
    command: process.execPath,
    args: ["-e", ECHO],
    env: {},
    cwd: process.cwd(),
    detach: { procId: `agent-test-${mode}` },
    onNotice: (message) => notices.push(message)
  });
  const out = collect(child.stdout);
  const err = collect(child.stderr);
  await out.until((text) => text.includes("ready\n"));
  connection.dropLink();
  await connection.restartAgent(mode, "orq-agent restarted in the box, so this process's output could no longer be followed; it was stopped");
  connection.restoreLink();
  const reason = await child.exited;
  await connection.killAll();
  return { reason, errText: err.text(), notices };
}

test("a child orq-agent lost in a restart ends with the box's reason and the signal that stopped it", async () => {
  const { reason, errText, notices } = await childAcrossARestart("lose");
  assert.deepEqual(reason, { kind: "signal", code: null, signal: "SIGTERM" });
  assert.equal(errText, "[orquester] orq-agent restarted in the box, so this process's output could no longer be followed; it was stopped\n");
  assert.ok(notices.some((notice) => notice.includes("could no longer be followed")));
});

test("a child the box lists as ended without an exit code or signal never ends as a clean exit", async () => {
  const { reason, errText } = await childAcrossARestart("unrecorded");
  assert.deepEqual(reason, { kind: "signal", code: null, signal: "SIGHUP" });
  assert.match(errText, /^\[orquester\] the box reported no exit code or signal for this process/);
});

test("a child the box has no record of ends as SIGHUP, saying the box no longer knows it", async () => {
  const { reason, errText } = await childAcrossARestart("forget");
  assert.deepEqual(reason, { kind: "signal", code: null, signal: "SIGHUP" });
  assert.match(errText, /^\[orquester\] the box no longer knows this process \(orq-agent restarted there\)/);
});
