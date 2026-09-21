/**
 * MANUAL smoke test — drives ONE tiny real turn through the OpenCode adapter
 * and prints the normalised events (spec §9, "tests that drive a real provider
 * CLI stay opt-in behind an environment variable").
 *
 * **Not part of `pnpm test`.** The filename has no `.test.ts` suffix, so the
 * daemon's `find src -name '*.test.ts'` never picks it up, and it refuses to
 * run unless `ORQ_AGENT_SMOKE=1`.
 *
 * ```sh
 * ORQ_AGENT_SMOKE=1 node --import tsx \
 *   apps/daemon/src/agent-host/adapters/opencode/smoke.ts
 * ```
 *
 * Cost discipline: this spends a real subscription. The prompt is two words,
 * one turn, no tools. Run it sparingly.
 *
 * Optional environment:
 * - `ORQ_SMOKE_MODEL`   — the `provider/model` slug (default: read from `GET /provider`)
 * - `ORQ_SMOKE_PROMPT`  — the prompt (default: a two-word reply request)
 * - `ORQ_SMOKE_DIR`     — the throwaway repo (default: a fresh mkdtemp)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { buildProviderEnv } from "../../support/env.ts";
import { createOpenCodeAdapter } from "./index.ts";

const PROMPT =
  process.env.ORQ_SMOKE_PROMPT ??
  "Reply with exactly the two words: hello world. Do not call any tools.";

function bail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function makeThrowawayRepo(): string {
  const existing = process.env.ORQ_SMOKE_DIR;
  if (existing !== undefined && existing.length > 0) {
    return existing;
  }
  const dir = mkdtempSync(join(tmpdir(), "orq-opencode-smoke-"));
  writeFileSync(join(dir, "README.md"), "# smoke\n", "utf8");
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
    execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir, env });
    execFileSync("git", ["config", "user.name", "smoke"], { cwd: dir, env });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, env });
    execFileSync("git", ["add", "-A"], { cwd: dir, env });
    execFileSync("git", ["commit", "-qm", "smoke"], { cwd: dir, env });
  } catch {
    // A repo is convenient, not required.
  }
  return dir;
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, bin);
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

function describe(event: RuntimeEvent): string {
  const payload = JSON.stringify(event.payload);
  const short = payload.length > 240 ? `${payload.slice(0, 240)}…` : payload;
  return `${event.type.padEnd(28)} ${short}`;
}

async function main(): Promise<void> {
  if (process.env.ORQ_AGENT_SMOKE !== "1") {
    bail("refusing to run: set ORQ_AGENT_SMOKE=1 (this spends a real subscription)");
  }
  const bin = which("opencode");
  if (bin === null) {
    bail("no `opencode` on PATH");
  }

  const cwd = makeThrowawayRepo();
  const home = process.env.HOME ?? tmpdir();
  process.stderr.write(`smoke: repo ${cwd}\n`);

  const abort = new AbortController();
  let ids = 0;
  const ctx: AdapterContext = {
    logger: {
      debug: () => undefined,
      info: (message, detail) =>
        process.stderr.write(`info  ${message} ${JSON.stringify(detail ?? {})}\n`),
      warn: (message, detail) =>
        process.stderr.write(`warn  ${message} ${JSON.stringify(detail ?? {})}\n`),
      error: (message, detail) =>
        process.stderr.write(`error ${message} ${JSON.stringify(detail ?? {})}\n`)
    },
    clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
    ids: {
      eventId: () => `evt-${(ids += 1)}`,
      messageId: (prefix) => `${prefix}-${(ids += 1)}`,
      uuid: () => `${Date.now().toString(16)}-${(ids += 1)}`
    },
    resolveAttachmentPath: async () => {
      throw new Error("no attachments in the smoke test");
    },
    attachmentsDir: () => join(cwd, ".attachments"),
    logRawFrame: () => undefined,
    buildEnv: () =>
      buildProviderEnv({
        adapter: "opencode",
        sessionPath: process.env.PATH ?? "",
        tmpDir: tmpdir(),
        homeDir: home,
        sessionId: "smoke"
      }),
    resolveBin: async () => bin,
    sessionPath: () => process.env.PATH ?? "",
    tmpDir: () => tmpdir(),
    signal: abort.signal
  };

  const adapter = await createOpenCodeAdapter(ctx);
  const events: RuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.events) {
      events.push(event);
      process.stdout.write(`${describe(event)}\n`);
    }
  })();

  try {
    const snapshot = await adapter.refreshSnapshot({ cwd });
    process.stderr.write(
      `smoke: opencode ${String(snapshot.version)} · ${snapshot.status} · auth ${
        snapshot.auth.status
      } · ${snapshot.models.length} models · ${snapshot.slashCommands.length} commands · ${
        snapshot.skills.length
      } skills\n`
    );
    const model =
      process.env.ORQ_SMOKE_MODEL ??
      snapshot.models.find((candidate) => candidate.isDefault === true)?.slug ??
      snapshot.models[0]?.slug;
    if (model === undefined) {
      bail("no model available — is OpenCode logged in? (`opencode auth login`)");
    }
    process.stderr.write(`smoke: model ${model}\n`);

    await adapter.startSession({
      threadId: "smoke-thread",
      cwd,
      home: { kind: "system", path: home },
      title: "orquester smoke",
      modelSelection: { model },
      runtimeMode: "approval-required"
    });

    const settled = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (
          events.some(
            (event) => event.type === "turn.completed" || event.type === "turn.aborted"
          )
        ) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      timer.unref?.();
    });

    const turn = await adapter.sendTurn({
      threadId: "smoke-thread",
      input: PROMPT,
      attachments: [],
      interactionMode: "default"
    });
    process.stderr.write(`smoke: turn ${turn.turnId}\n`);
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 120_000);
        timer.unref?.();
      })
    ]);
  } finally {
    await adapter.stopAll();
    abort.abort();
    await drained.catch(() => undefined);
  }

  process.stderr.write(`smoke: ${events.length} normalised events\n`);
}

await main();
