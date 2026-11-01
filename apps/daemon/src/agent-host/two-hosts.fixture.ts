/**
 * A stand-in agent host process for `two-hosts.test.ts` (host updates, spec 2026-11-01 P2.7): the
 * real host (`startAgentHost`: store, index, server, ingestion) with a scripted Claude adapter in
 * place of the CLI. The generation, socket, token and foreign threads come from the environment,
 * exactly as the daemon passes them (`AGENT_HOST_ENV`).
 *
 * stdout, one JSON line each: `{ "ready": true }` once the gate is open, then `{ "call": kind,
 * "threadId": … }` for every provider call the host makes. stdin, one JSON line each:
 * `{ "emit": RuntimeEvent }` — pushed onto the adapter's event stream as the provider's own.
 *
 * argv: <appdir>
 */

import { createInterface } from "node:readline";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { startAgentHost } from "./main.ts";
import { createScriptedAdapter } from "./orchestration/testing/scripted-adapter.ts";

const appdir = process.argv[2]!;
const report = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const adapter = createScriptedAdapter({ id: "claude" });
for (const kind of ["startSession", "sendTurn", "stopSession"] as const) {
  const call = adapter[kind].bind(adapter) as (...args: unknown[]) => Promise<unknown>;
  (adapter as unknown as Record<string, unknown>)[kind] = async (...args: unknown[]) => {
    const first = args[0];
    const threadId = typeof first === "string" ? first : (first as { threadId?: string }).threadId;
    const result = await call(...args);
    report({ call: kind, threadId });
    return result;
  };
}

const quiet = (): void => undefined;
const host = await startAgentHost({
  appdir,
  env: process.env,
  logger: { debug: quiet, info: quiet, warn: (message) => process.stderr.write(`${message}\n`), error: (message) => process.stderr.write(`${message}\n`) },
  adapterFactories: { claude: async () => adapter },
  onStopped: () => process.exit(0)
});
await host.ready;
report({ ready: true });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { emit?: RuntimeEvent };
  if (message.emit !== undefined) adapter.emit(message.emit);
});
