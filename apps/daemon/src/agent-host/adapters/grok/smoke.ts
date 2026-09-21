/**
 * Grok adapter — the manual real-CLI smoke script (spec §9 "Tests that drive a
 * real provider CLI stay opt-in behind an environment variable and are skipped
 * otherwise, so the suite never needs an account or a network").
 *
 * **Not part of `pnpm test`.** The filename deliberately ends in `.ts`, not
 * `.test.ts`, so `find src -name '*.test.ts'` never picks it up, and it
 * refuses to run without `ORQ_AGENT_SMOKE=1`.
 *
 * It drives ONE tiny real turn through the real adapter against the real
 * `grok` CLI in a throwaway git repo under the scratch dir, prints the
 * normalised event stream, and stops. Cost discipline: a real subscription is
 * billed for every run, so the prompt is five words and the script exits as
 * soon as the turn settles.
 *
 * ```sh
 * ORQ_AGENT_SMOKE=1 \
 *   GROK_HOME=/var/lib/orquester/daemon/agent-accounts/grok/<id>/home \
 *   node --import tsx apps/daemon/src/agent-host/adapters/grok/smoke.ts
 * ```
 *
 * Optional: `ORQ_SMOKE_PROMPT` to change the prompt, `ORQ_SMOKE_BIN` to point
 * at a `grok` other than the one on PATH, `ORQ_SMOKE_MODE` for the runtime
 * mode (default `approval-required`).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AccountHome, RuntimeEvent, RuntimeMode } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { buildProviderEnv } from "../../support/env.ts";
import { createGrokAdapter } from "./index.ts";

const SCRATCH = "/var/lib/orquester/tmp/agent-chat-fixtures/grok";

async function main(): Promise<void> {
  if (process.env["ORQ_AGENT_SMOKE"] !== "1") {
    console.error("refusing to run: set ORQ_AGENT_SMOKE=1 (this spends real tokens)");
    process.exitCode = 2;
    return;
  }
  const grokHome = process.env["GROK_HOME"];
  if (grokHome === undefined || grokHome.length === 0) {
    console.error("set GROK_HOME to a managed account home; never copy an auth.json");
    process.exitCode = 2;
    return;
  }

  const cwd = await mkdtemp(join(SCRATCH, "smoke-"));
  spawnSync("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "README.md"), "# smoke\n", "utf8");

  const binary = process.env["ORQ_SMOKE_BIN"] ?? "grok";
  const prompt = process.env["ORQ_SMOKE_PROMPT"] ?? "Reply with exactly: OK";
  const runtimeMode = (process.env["ORQ_SMOKE_MODE"] ?? "approval-required") as RuntimeMode;
  const home: AccountHome = { kind: "account", accountId: "smoke", path: grokHome };

  const controller = new AbortController();
  const context: AdapterContext = {
    logger: {
      debug: () => {},
      info: (message, detail) => console.log(`[info] ${message}`, detail ?? ""),
      warn: (message, detail) => console.log(`[warn] ${message}`, detail ?? ""),
      error: (message, detail) => console.log(`[error] ${message}`, detail ?? "")
    },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: {
      eventId: () => randomUUID(),
      messageId: (prefix) => `${prefix}-${randomUUID()}`,
      uuid: () => randomUUID()
    },
    resolveAttachmentPath: async () => await Promise.resolve(cwd),
    attachmentsDir: () => cwd,
    // The raw frames are exactly what `raw.ndjson` would hold; printing them
    // here would defeat the point of the redactor, so only the method shows.
    logRawFrame: (_threadId, frame) => {
      const record = frame as { direction?: string; frame?: { method?: string; id?: number } };
      if (record.frame?.method !== undefined) {
        console.log(`  raw ${record.direction} ${record.frame.method}`);
      }
    },
    buildEnv: (input) =>
      buildProviderEnv({
        adapter: "grok",
        sessionPath: process.env["PATH"] ?? "",
        tmpDir: SCRATCH,
        homeDir: process.env["HOME"] ?? SCRATCH,
        accountHomeDir: input.home.path,
        ...(input.extraEnv === undefined ? {} : { extraEnv: input.extraEnv }),
        sessionId: "smoke"
      }),
    resolveBin: async () => await Promise.resolve(binary),
    sessionPath: () => process.env["PATH"] ?? "",
    tmpDir: () => SCRATCH,
    signal: controller.signal
  };

  const adapter = await createGrokAdapter(context);

  const settled = new Promise<void>((resolve) => {
    void (async () => {
      for await (const event of adapter.events) {
        print(event);
        if (event.type === "turn.completed" || event.type === "session.exited") {
          resolve();
        }
      }
    })();
  });

  console.log("--- starting a session ---");
  const session = await adapter.startSession({
    threadId: "smoke",
    cwd,
    home,
    modelSelection: { model: "grok-build" },
    runtimeMode
  });
  console.log({ status: session.status, model: session.model, cursor: session.resumeCursor });

  // AFTER the session, so the probe runs under the account home the thread
  // uses rather than the daemon user's own (empty) `~/.grok`.
  console.log("--- provider snapshot ---");
  const snapshot = await adapter.refreshSnapshot({ cwd });
  console.log({
    installed: snapshot.installed,
    version: snapshot.version,
    status: snapshot.status,
    auth: snapshot.auth.status,
    models: snapshot.models.map((model) => model.slug),
    slashCommands: snapshot.slashCommands.map((command) => command.name).slice(0, 8),
    slashCommandCount: snapshot.slashCommands.length,
    skills: snapshot.skills.length
  });

  console.log(`--- sending: ${prompt} ---`);
  const turn = await adapter.sendTurn({
    threadId: "smoke",
    input: prompt,
    attachments: [],
    interactionMode: "default"
  });
  console.log({ turnId: turn.turnId });

  await settled;
  console.log("--- stopping ---");
  await adapter.stopAll();
  controller.abort();
  console.log(`sandbox left at ${cwd}`);
}

function print(event: RuntimeEvent): void {
  switch (event.type) {
    case "content.delta":
      process.stdout.write(
        event.payload.streamKind === "assistant_text" ? event.payload.delta : `\u001b[2m·\u001b[0m`
      );
      return;
    case "turn.completed":
      console.log("\n", event.type, JSON.stringify(event.payload));
      return;
    default:
      console.log(event.type, JSON.stringify(event.payload).slice(0, 200));
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
