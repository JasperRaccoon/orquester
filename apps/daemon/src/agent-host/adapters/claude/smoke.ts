/**
 * Claude adapter — the manual smoke script (spec §9 "tests that drive a real
 * provider CLI stay opt-in").
 *
 * **Not part of `pnpm test`.** It runs only with `ORQ_AGENT_SMOKE=1`, drives
 * ONE tiny real turn through the adapter in a throwaway repo under the scratch
 * dir, prints the normalised `RuntimeEvent` stream and stops the session.
 *
 * ```sh
 * ORQ_AGENT_SMOKE=1 node --import tsx \
 *   apps/daemon/src/agent-host/adapters/claude/smoke.ts
 * ```
 *
 * Cost discipline: a real subscription pays for this. One sentence, one turn,
 * run sparingly. `ORQ_AGENT_SMOKE_PROMPT` overrides the prompt,
 * `ORQ_AGENT_SMOKE_DIR` the sandbox, `CLAUDE_BIN` the binary.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { createClaudeAdapterWith } from "./index.ts";
import { defaultClaudeAdapterDeps } from "./deps.ts";

const run = promisify(execFile);

const DEFAULT_PROMPT =
  "Read a.txt and reply with only the first word you find. Do not run any other tool.";

async function resolveBinary(): Promise<string> {
  const override = process.env.CLAUDE_BIN?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const { stdout } = await run("which", ["claude"]);
  const path = stdout.trim();
  if (path.length === 0) {
    throw new Error("claude is not on PATH; set CLAUDE_BIN.");
  }
  return path;
}

async function makeSandbox(): Promise<string> {
  const base =
    process.env.ORQ_AGENT_SMOKE_DIR?.trim() ??
    nodePath.join("/var/lib/orquester/tmp/agent-chat-smoke", `claude-${Date.now()}`);
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(nodePath.join(base, "a.txt"), "alpha beta gamma\n", "utf8");
  await run("git", ["init", "-q"], { cwd: base }).catch(() => undefined);
  return base;
}

function describe(event: RuntimeEvent): string {
  const payload = JSON.stringify(event.payload);
  const short = payload.length > 240 ? `${payload.slice(0, 237)}…` : payload;
  return `${event.type.padEnd(28)} ${short}`;
}

async function main(): Promise<void> {
  if (process.env.ORQ_AGENT_SMOKE !== "1") {
    process.stdout.write("Set ORQ_AGENT_SMOKE=1 to run the Claude smoke test.\n");
    return;
  }

  const executablePath = await resolveBinary();
  const cwd = await makeSandbox();
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() ?? nodePath.join(nodeOs.homedir(), ".claude");
  const attachments = nodePath.join(cwd, ".orq-attachments");
  await fs.mkdir(attachments, { recursive: true });

  let eventId = 0;
  const controller = new AbortController();
  const context: AdapterContext = {
    logger: {
      debug: () => {},
      info: (message) => process.stdout.write(`[info] ${message}\n`),
      warn: (message) => process.stdout.write(`[warn] ${message}\n`),
      error: (message) => process.stdout.write(`[error] ${message}\n`)
    },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: {
      eventId: () => `ev-${(eventId += 1)}`,
      messageId: (prefix) => `${prefix}-${(eventId += 1)}`,
      uuid: () => crypto.randomUUID()
    },
    resolveAttachmentPath: async (_threadId, id) => nodePath.join(attachments, id),
    attachmentsDir: () => attachments,
    logRawFrame: () => {},
    // Built explicitly, never a spread of process.env (§3.1).
    buildEnv: () => ({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? nodeOs.homedir(),
      TMPDIR: process.env.TMPDIR ?? nodeOs.tmpdir(),
      CLAUDE_CONFIG_DIR: home,
      ORQUESTER_SESSION_ID: "smoke"
    }),
    resolveBin: async () => executablePath,
    sessionPath: () => process.env.PATH ?? "/usr/bin:/bin",
    tmpDir: () => process.env.TMPDIR ?? nodeOs.tmpdir(),
    signal: controller.signal
  };

  const adapter = await createClaudeAdapterWith(context, defaultClaudeAdapterDeps());

  const snapshot = await adapter.refreshSnapshot({ cwd });
  process.stdout.write(
    `snapshot: installed=${snapshot.installed} version=${snapshot.version} auth=${snapshot.auth.status} ` +
      `models=${snapshot.models.length} commands=${snapshot.slashCommands.length} ` +
      `windows=${snapshot.usageLimits?.windows.length ?? 0}\n\n`
  );

  const settled = new Promise<void>((resolve) => {
    void (async () => {
      for await (const event of adapter.events) {
        process.stdout.write(`${describe(event)}\n`);
        if (event.type === "turn.completed" || event.type === "session.exited") {
          resolve();
        }
      }
    })();
  });

  const threadId = `smoke-${Date.now()}`;
  await adapter.startSession({
    threadId,
    cwd,
    home: { kind: "system", path: home },
    modelSelection: { model: "sonnet" },
    runtimeMode: "approval-required"
  });

  const turn = await adapter.sendTurn({
    threadId,
    input: process.env.ORQ_AGENT_SMOKE_PROMPT ?? DEFAULT_PROMPT,
    attachments: [],
    interactionMode: "default"
  });
  process.stdout.write(`\nturn ${turn.turnId} sent; waiting for it to settle…\n\n`);

  await settled;
  await adapter.stopAll();
  controller.abort();
  process.stdout.write(`\nsandbox: ${cwd}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
);
