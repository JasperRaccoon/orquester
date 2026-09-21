/**
 * Codex adapter — MANUAL smoke test against the real CLI.
 *
 * **Not part of `pnpm test`.** It spends real subscription tokens, so it only
 * runs with `ORQ_AGENT_SMOKE=1` and it drives exactly ONE tiny turn in a
 * throwaway git repo under the scratch dir.
 *
 * ```sh
 * ORQ_AGENT_SMOKE=1 node --import tsx \
 *   apps/daemon/src/agent-host/adapters/codex/smoke.ts
 * ```
 *
 * Optional env:
 * - `ORQ_SMOKE_CODEX_BIN`  — the binary (default: `codex` resolved on PATH)
 * - `ORQ_SMOKE_CODEX_HOME` — `CODEX_HOME` (default: the caller's own)
 * - `ORQ_SMOKE_MODEL`      — the model slug (default: `gpt-5.5`)
 * - `ORQ_SMOKE_DIR`        — where the throwaway repo goes
 *
 * It prints: the probe's shape, the NORMALISED event sequence of one turn, and
 * the rollback path proving `thread/rollback` is dead and `thread/revert`
 * works.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { AsyncEventQueue } from "./event-queue.ts";
import { CodexPeer } from "./protocol.ts";
import { probeCodex } from "./probe.ts";
import { CodexSession } from "./session.ts";
import { spawnProviderChild } from "../../support/spawn.ts";
import { createFakeContext } from "./testing.ts";

const PROMPT = "Reply with exactly: pineapple-42";

async function main(): Promise<void> {
  if (process.env.ORQ_AGENT_SMOKE !== "1") {
    console.error("refusing to run: set ORQ_AGENT_SMOKE=1 (this spends real tokens)");
    process.exitCode = 2;
    return;
  }

  const bin = process.env.ORQ_SMOKE_CODEX_BIN ?? resolveOnPath("codex");
  if (bin === null) {
    console.error("codex is not on PATH; set ORQ_SMOKE_CODEX_BIN");
    process.exitCode = 2;
    return;
  }
  const codexHome = process.env.ORQ_SMOKE_CODEX_HOME ?? join(homedir(), ".codex");
  const model = process.env.ORQ_SMOKE_MODEL ?? "gpt-5.5";

  const root = process.env.ORQ_SMOKE_DIR ?? tmpdir();
  const cwd = mkdtempSync(join(root, "codex-smoke-"));
  writeFileSync(join(cwd, "README.md"), "# smoke\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd });
  console.log(`# repo: ${cwd}`);
  console.log(`# bin:  ${bin}`);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    TMPDIR: tmpdir(),
    CODEX_HOME: codexHome
  };

  // ---------------------------------------------------------------- the probe
  console.log("\n## probe (no turn, no tokens)");
  const probeChild = spawnProviderChild({ command: bin, args: ["app-server"], env, cwd });
  probeChild.stderr.resume();
  const probePeer = new CodexPeer({
    stdin: probeChild.stdin,
    stdout: probeChild.stdout,
    handlers: {
      onRequest: () => Promise.reject(new Error("no server requests during a probe")),
      onNotification: () => {},
      onUnknownFrame: () => {},
      onMalformedLine: () => {}
    }
  });
  const initialize = await probePeer.request("initialize", {
    clientInfo: { name: "orquester", title: "Orquester smoke", version: "1" },
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
  probePeer.notify("initialized");
  const snapshot = await probeCodex({
    peer: probePeer,
    initialize,
    cwd,
    nowIso: new Date().toISOString(),
    onWarning: (message, detail) => console.log(`  ! ${message}`, detail ?? "")
  });
  console.log(
    JSON.stringify(
      {
        version: snapshot.version,
        status: snapshot.status,
        auth: { status: snapshot.auth.status, type: snapshot.auth.type, label: snapshot.auth.label },
        models: snapshot.models.map((m) => m.slug),
        effortOptions: snapshot.models[0]?.capabilities?.optionDescriptors?.map((d) => d.id),
        slashCommands: snapshot.slashCommands.map((c) => c.name),
        skillCount: snapshot.skills.length,
        usageWindows: snapshot.usageLimits?.windows.map((w) => `${w.id}=${w.usedPercent}%`)
      },
      null,
      2
    )
  );
  probePeer.close("probe done");
  await probeChild.kill();

  // ----------------------------------------------------------------- one turn
  console.log("\n## one turn");
  const { context } = createFakeContext();
  const queue = new AsyncEventQueue<RuntimeEvent>();
  let seq = 0;
  const printed: string[] = [];
  void (async () => {
    for await (const event of queue) {
      printed.push(event.type);
      console.log(`  ${event.type} ${summarise(event)}`);
    }
  })();

  const session = new CodexSession({
    context,
    threadId: "smoke-thread",
    cwd,
    codexHome,
    bin,
    env,
    runtimeMode: "approval-required",
    modelSelection: { model, options: [{ id: "effort", value: "low" }] },
    emit: (draft) => {
      queue.push({
        ...draft,
        eventId: `ev-${++seq}`,
        threadId: "smoke-thread",
        createdAt: new Date().toISOString()
      } as RuntimeEvent);
    },
    onClosed: () => console.log("  (session closed)")
  });

  const started = await session.start();
  console.log(`  session ${started.status}, cursor ${JSON.stringify(started.resumeCursor)}`);

  const settled = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (printed.includes("turn.completed")) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
  const turn = await session.sendTurn({
    input: PROMPT,
    attachments: [],
    interactionMode: "default"
  });
  console.log(`  turn ${turn.turnId}`);
  await settled;

  // ----------------------------------------------------------------- rollback
  console.log("\n## rollback (thread/turns/list → thread/revert)");
  try {
    const snapshotAfter = await session.rollbackThread(1);
    console.log(`  turns after revert: ${snapshotAfter.turns.length}`);
  } catch (error) {
    console.log(`  rollback failed: ${String(error)}`);
  }

  await session.stop();
  queue.close();
  console.log(`\n# event sequence: ${printed.join(" → ")}`);
  console.log(`# repo left at ${cwd} — delete it when you are done.`);
}

function summarise(event: RuntimeEvent): string {
  switch (event.type) {
    case "content.delta":
      return JSON.stringify(event.payload.delta);
    case "item.started":
    case "item.completed":
      return `${event.payload.itemType}${event.payload.status !== undefined ? ` ${event.payload.status}` : ""}`;
    case "turn.completed":
      return `${event.payload.state} usage=${event.payload.tokenUsage?.usageStatus ?? "none"}`;
    case "thread.token-usage.updated":
      return `${event.payload.usage.usedTokens}/${event.payload.usage.maxTokens ?? "?"}`;
    case "runtime.warning":
    case "runtime.error":
      return event.payload.message.slice(0, 120);
    case "request.opened":
      return event.payload.requestType;
    default:
      return "";
  }
}

function resolveOnPath(name: string): string | null {
  try {
    return execFileSync("command", ["-v", name], { shell: true, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

await main();
