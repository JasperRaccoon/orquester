/**
 * The native-history worker, driven as a REAL child over a REAL pipe.
 *
 * Q1 #5: writes to a pipe are asynchronous on POSIX and `spawnProviderChild`
 * always pipes all three stdio, so a worker that calls `process.exit()` right
 * after `process.stdout.write()` discards everything past the ~64 KiB pipe
 * buffer. A `getSessionMessages` transcript is far bigger than that, and the
 * out-of-process path is taken for **every managed-account thread** — so every
 * rewind failed with "Unexpected end of JSON input".
 *
 * The lifecycle suite's fake child cannot see this (it emits the whole payload
 * in one synchronous `data` event), so these tests spawn node for real.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";

import { createClaudeHistoryReader } from "./history.ts";

/** Comfortably past the 64 KiB pipe buffer. */
const PAYLOAD_ENTRIES = 4_000;

let root: string;
let flushingWorker: string;
let truncatingWorker: string;
let emptyWorker: string;
let garbageWorker: string;

function bigPayload(): string {
  return JSON.stringify(
    Array.from({ length: PAYLOAD_ENTRIES }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `uuid-${index}`,
      parent_tool_use_id: null,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: "x".repeat(64) }
    }))
  );
}

async function writeWorker(name: string, body: string): Promise<string> {
  const file = nodePath.join(root, name);
  await fs.writeFile(file, body, "utf8");
  return file;
}

before(async () => {
  root = await fs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "orq-claude-history-"));
  const payload = `JSON.stringify(Array.from({length:${PAYLOAD_ENTRIES}},(_,i)=>({type:i%2===0?"user":"assistant",uuid:"uuid-"+i,parent_tool_use_id:null,message:{role:i%2===0?"user":"assistant",content:"x".repeat(64)}})))`;

  // What the worker does now: write, WAIT for the flush, then let the loop end.
  flushingWorker = await writeWorker(
    "flushing.mjs",
    `import { writeAllToStdout } from ${JSON.stringify(nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), "stdout-write.ts"))};\n` +
      `await writeAllToStdout(${payload});\n` +
      `process.exitCode = 0;\n`
  );

  // A payload cut short, which is what a worker that exits before the flush
  // (or is killed) leaves behind on the pipe.
  truncatingWorker = await writeWorker(
    "truncating.mjs",
    `process.stdout.write(${payload}.slice(0, -200));\nprocess.exitCode = 0;\n`
  );

  emptyWorker = await writeWorker("empty.mjs", `process.exitCode = 0;\n`);
  garbageWorker = await writeWorker(
    "garbage.mjs",
    `process.stdout.write("{not json");\nprocess.exitCode = 0;\n`
  );
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function reader(workerPath: string) {
  return createClaudeHistoryReader({
    // A config dir that differs from the host's is what selects the
    // out-of-process path — the normal case for a managed account.
    env: { CLAUDE_CONFIG_DIR: "/homes/acc-1/home", PATH: process.env.PATH ?? "/usr/bin" },
    cwd: root,
    hostConfigDir: "/host/.claude",
    workerPath
  });
}

describe("claude history worker — the payload survives the pipe", () => {
  it("reads a transcript far larger than the pipe buffer", async () => {
    const expected = JSON.parse(bigPayload()) as unknown[];
    const messages = await reader(flushingWorker).readMessages({ sessionId: "s" });
    assert.equal(messages.length, expected.length);
    assert.equal(messages.length, PAYLOAD_ENTRIES);
    assert.equal(messages.at(-1)?.uuid, `uuid-${PAYLOAD_ENTRIES - 1}`);
    assert.ok(bigPayload().length > 64 * 1024, "the fixture must exceed the pipe buffer");
  });

  it("a truncated payload is a named refusal, not a bare SyntaxError", async () => {
    // "Unexpected end of JSON input" is what the user used to see when the
    // worker exited before its pipe flushed.
    await assert.rejects(
      () => reader(truncatingWorker).readMessages({ sessionId: "s" }),
      /read the Claude conversation history: the history worker's output was incomplete/
    );
  });

  it("names an empty payload rather than throwing 'Unexpected end of JSON input'", async () => {
    await assert.rejects(
      () => reader(emptyWorker).readMessages({ sessionId: "s" }),
      /produced no output/
    );
  });

  it("names unparsable output on the fork path too", async () => {
    await assert.rejects(
      () => reader(garbageWorker).fork({ sessionId: "s", upToMessageId: "u" }),
      /fork the Claude conversation: the history worker's output was incomplete/
    );
  });

  it("the shipped worker never calls process.exit on the success path", async () => {
    const source = await fs.readFile(
      nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), "history-worker.ts"),
      "utf8"
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    assert.ok(
      !/process\.exit\(/.test(code),
      "process.exit() discards queued pipe writes; set process.exitCode instead"
    );
    assert.ok(source.includes("writeAllToStdout"));
  });
});
