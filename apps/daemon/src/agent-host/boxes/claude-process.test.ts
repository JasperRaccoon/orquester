import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { localBoxConnection } from "../../boxes/testing.ts";
import { boxClaudeSpawner } from "./claude-process.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/claude/01-init-plain-text.ndjson");

function spawnOptions(command: string, args: string[], signal = new AbortController().signal) {
  return { command, args, cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, signal };
}

let procSeq = 0;
const procId = (): string => `claude-test-${++procSeq}`;

test("the SDK's SpawnedProcess: exit fields set before 'exit', stderr to the session's capture", async () => {
  const stderr: string[] = [];
  const spawn = boxClaudeSpawner({ connection: localBoxConnection(), procId, stderr: (data) => stderr.push(data) });
  const child = spawn(spawnOptions(process.execPath, ["-e", 'process.stderr.write("warn line\\n"); process.stdout.write("{}\\n"); process.exit(3)']));
  assert.equal(child.exitCode, null);
  assert.equal(child.killed, false);
  const seen = await new Promise<{ code: number | null; signal: string | null; atEmit: number | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, atEmit: child.exitCode }));
  });
  assert.deepEqual(seen, { code: 3, signal: null, atEmit: 3 });
  assert.equal(child.signalCode, null);
  // Once ended, a late SIGKILL from the SDK's close() is a harmless false.
  assert.equal(child.kill("SIGKILL"), false);
  assert.match(stderr.join(""), /warn line/);
});

test("kill() sends one signal now and marks the process killed; a signal death reads as such", async () => {
  const spawn = boxClaudeSpawner({ connection: localBoxConnection(), procId });
  const child = spawn(spawnOptions(process.execPath, ["-e", 'process.stdout.write("up\\n"); setInterval(() => {}, 1000)']));
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  assert.equal(child.kill("SIGTERM"), true);
  assert.equal(child.killed, true);
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => child.once("exit", (c, s) => resolve([c, s])));
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
});

test("a spawn failure is an 'error' with a spawn syscall and no 'exit', as Node's own child", async () => {
  const spawn = boxClaudeSpawner({ connection: localBoxConnection(), procId });
  const child = spawn(spawnOptions("/nonexistent/claude", []));
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const error = await new Promise<Error & { syscall?: string }>((resolve) => child.on("error", resolve));
  assert.match(error.syscall ?? "", /^spawn/);
  assert.equal(exited, false);
});

test("the forwarded abort signal ends the box process", async () => {
  const spawn = boxClaudeSpawner({ connection: localBoxConnection(), procId });
  const abort = new AbortController();
  const child = spawn(spawnOptions(process.execPath, ["-e", 'process.stdout.write("up\\n"); setInterval(() => {}, 1000)'], abort.signal));
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  abort.abort();
  const signal = await new Promise<string | null>((resolve) => child.once("exit", (_code, s) => resolve(s)));
  assert.equal(signal, "SIGTERM");
});

/**
 * A stand-in `claude` that speaks the CLI side of the SDK's stream-json transport and answers
 * with the frames recorded in fixture 01: the `initialize` control request gets the fixture's
 * `initializationResult`, and the first user message the fixture's own SDK messages, in order.
 */
function writeReplayClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), "box-claude-replay-"));
  const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
  const init = lines.find((line) => line.kind === "control" && line.data.op === "initializationResult")?.data.result ?? {};
  // `command_lifecycle` rows are the SDK's own bookkeeping, not CLI output.
  const replies = lines.filter((line) => line.kind === "sdk-message" && line.data.type !== "command_lifecycle").map((line) => line.data);
  writeFileSync(join(dir, "replay.json"), JSON.stringify({ init, replies }), "utf8");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const { init, replies } = JSON.parse(readFileSync(new URL("./replay.json", import.meta.url), "utf8"));
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      const response = frame.request && frame.request.subtype === "initialize" ? init : {};
      send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response } });
    } else if (frame.type === "user") {
      for (const reply of replies) send(reply);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    "utf8"
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("the Agent SDK drives a CLI in the box through spawnClaudeCodeProcess (fixture 01 replayed)", async () => {
  const connection = localBoxConnection();
  const spawned: string[] = [];
  const spawn = boxClaudeSpawner({ connection, procId, stderr: () => undefined });
  const bin = writeReplayClaude();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Say hi." } };
    await released;
  }
  const q = query({
    prompt: prompt(),
    options: {
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: bin,
      env: { PATH: process.env.PATH ?? "" },
      includePartialMessages: true,
      spawnClaudeCodeProcess: (options) => {
        spawned.push(options.command);
        return spawn(options);
      }
    }
  });
  const seen: string[] = [];
  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      seen.push(message.type === "system" ? `system/${(message as { subtype?: string }).subtype}` : message.type);
      if (message.type === "result") break;
    }
  } finally {
    release();
    q.close();
  }
  assert.deepEqual(spawned, [bin]);
  assert.ok(seen.includes("system/init"), seen.join(","));
  assert.ok(seen.includes("assistant"), seen.join(","));
  assert.equal(seen.at(-1), "result");
});
