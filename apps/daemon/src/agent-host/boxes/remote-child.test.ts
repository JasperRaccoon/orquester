import assert from "node:assert/strict";
import { test } from "node:test";

import { localBoxConnection } from "../../boxes/testing.ts";
import { spawnBoxChild } from "./remote-child.ts";
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
