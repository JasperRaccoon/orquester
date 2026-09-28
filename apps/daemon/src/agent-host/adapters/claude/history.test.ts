/** Managed-account history is read by the shipped worker over a real OS pipe. */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";

import { createClaudeHistoryReader } from "./history.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
let root: string;
let configDir: string;

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "orq-claude-history-"));
  configDir = join(root, "account");
  // Claude's native projects/<encoded cwd>/<session UUID>.jsonl format.
  const project = join(configDir, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  await fs.mkdir(project, { recursive: true });
  const records = Array.from({ length: 4_000 }, (_, index) => ({
    type: index % 2 === 0 ? "user" : "assistant",
    uuid: `uuid-${index}`,
    parentUuid: index === 0 ? null : `uuid-${index - 1}`,
    sessionId: SESSION_ID,
    cwd: root,
    timestamp: "2026-09-21T12:00:00.000Z",
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(64)
    }
  }));
  await fs.writeFile(join(project, `${SESSION_ID}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function reader() {
  return createClaudeHistoryReader({
    env: { CLAUDE_CONFIG_DIR: configDir, PATH: process.env.PATH ?? "/usr/bin" },
    cwd: root,
    hostConfigDir: join(root, "host-account")
  });
}

/** Fault only the OS process boundary; the reader still consumes a real child pipe. */
async function workerOutput(t: TestContext, output: string): Promise<void> {
  const script = join(root, "broken-worker.mjs");
  await fs.writeFile(script, `process.stdout.write(${JSON.stringify(output)});\n`);
  const spawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", (
    command: string,
    _args: readonly string[],
    options: childProcess.SpawnOptions
  ) => spawn(command, [script], options));
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

function operationFailure(operation: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof SyntaxError));
    assert.match(error.message, operation);
    return true;
  };
}

describe("claude history worker — the payload survives the pipe", () => {
  it("reads a transcript far larger than the pipe buffer", async () => {
    const messages = await reader().readMessages({ sessionId: SESSION_ID, cwd: root });
    assert.equal(messages.length, 4_000);
    assert.equal(messages.at(-1)?.uuid, "uuid-3999");
    assert.ok(JSON.stringify(messages).length > 64 * 1024);
  });

  it("a truncated payload is a named refusal, not a bare SyntaxError", async (t) => {
    await workerOutput(t, '[{"type":"user","uuid":"incomplete"');
    await assert.rejects(
      () => reader().readMessages({ sessionId: SESSION_ID }),
      operationFailure(/read.*history/i)
    );
  });

  it("names an empty payload rather than throwing 'Unexpected end of JSON input'", async (t) => {
    await workerOutput(t, "");
    await assert.rejects(
      () => reader().readMessages({ sessionId: SESSION_ID }),
      operationFailure(/read.*history/i)
    );
  });

  it("names unparsable output on the fork path too", async (t) => {
    await workerOutput(t, "{not json");
    await assert.rejects(
      () => reader().fork({ sessionId: SESSION_ID, upToMessageId: "uuid-1" }),
      operationFailure(/fork.*conversation/i)
    );
  });
});
