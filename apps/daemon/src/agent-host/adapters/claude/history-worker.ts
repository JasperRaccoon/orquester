/**
 * Claude adapter — the native-history worker (spec §4.5 "Rollback").
 *
 * The SDK's history helpers (`getSessionMessages`, `forkSession`) read
 * `process.env` for `CLAUDE_CONFIG_DIR`. The agent host serves several
 * accounts at once, so changing its own environment to read one thread's
 * history would move every other thread's too. This file is therefore run as
 * a **child process** with that one account's env, exactly as T3 does
 * (`apps/server/src/claudeHistoryWorker.ts` + `claude-history-worker.ts`).
 *
 * Usage: `node --import tsx history-worker.ts <method> <sessionId> <jsonArgs>`
 * Prints the JSON result on stdout; any failure exits non-zero with the
 * message on stderr.
 *
 * The SDK import here is static. The §8 "no lazy dynamic `import()`" rule is
 * about the surviving host process; this is a separate, short-lived child.
 */

import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

async function main(): Promise<void> {
  const [method, sessionId, rawArgs] = process.argv.slice(2);
  if (method === undefined || sessionId === undefined) {
    throw new Error("usage: history-worker <getSessionMessages|forkSession> <sessionId> [json]");
  }
  const args: unknown = rawArgs === undefined ? {} : JSON.parse(rawArgs);
  const options = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};

  if (method === "getSessionMessages") {
    const messages = await getSessionMessages(sessionId, options);
    process.stdout.write(JSON.stringify(messages));
    return;
  }
  if (method === "forkSession") {
    const result = await forkSession(sessionId, options);
    process.stdout.write(JSON.stringify(result));
    return;
  }
  throw new Error(`unknown history method '${method}'`);
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
