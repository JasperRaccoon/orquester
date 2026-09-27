/**
 * The host's own teardown — and the user's end of a session, the other end
 * the host drives through every adapter hook — through the real composition
 * root.
 *
 * Every deploy's drain-restart, a manual host restart and a SIGTERM run
 * `startAgentHost(...).stop()`: `shutdown.abort()` fires each adapter's own
 * abort listener — which starts its `stopAll()` — and `stop()` then awaits
 * `adapter.stopAll()` itself, lets the consumers read what the teardown
 * queued, and only then stops the orchestrator. Only a test through `stop()`
 * sees what the teardown finishes before the process exits: an adapter-level
 * test calls `stopAll()` once, with nothing racing it and nobody consuming
 * its stream.
 *
 * The provider CLIs on the host's PATH are the committed mocks, behind shims
 * in the temp HOME's `.local/bin` (`hostSessionPath` puts it on the session
 * PATH); `PATH=/usr/bin:/bin` resolves no other adapter's CLI. Linux-only:
 * the leftover sweep reads `/proc`, and so do these assertions.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { agentChatThreadEventsPath, agentChatThreadLeftoverWorkPath } from "@orquester/config";
import type { DomainEvent, ThreadActivityItem } from "@orquester/api/agent-chat";

import type { AdapterLogger } from "./adapter.ts";
import { writeMockCodexServer } from "./adapters/codex/testing.ts";
import { startAgentHost, type AgentHost } from "./main.ts";

const GROK_MOCK = join(dirname(fileURLToPath(import.meta.url)), "adapters/grok/testing/mock-grok.mjs");

const quiet: AdapterLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Whether `pid` still runs (a zombie is gone). */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** Every live process whose environment carries `entry` exactly, with its argv. */
function processesWith(entry: string): Array<{ pid: number; argv: string[] }> {
  const found: Array<{ pid: number; argv: string[] }> = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(entry)) continue;
      if (!running(pid)) continue;
      found.push({ pid, argv: readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").filter(Boolean) });
    } catch {
      // Gone, or not ours to read.
    }
  }
  return found;
}

/** What the Grok mock's `leftover` scenario started under `mark`, by role. */
function launched(mark: string): { helper: number[]; shell: number[]; member: number[]; daemon: number[] } {
  const found = { helper: [] as number[], shell: [] as number[], member: [] as number[], daemon: [] as number[] };
  for (const { pid, argv } of processesWith(`GROK_RIG_MARK=${mark}`)) {
    const line = argv.join(" ");
    if (line === "sleep 301") found.helper.push(pid);
    else if (line === "sleep 302") found.member.push(pid);
    else if (line === "sleep 303") found.daemon.push(pid);
    else if (argv[0] === "sh" && line.includes("sleep 302 &")) found.shell.push(pid);
  }
  return found;
}

/** Kill whatever carries `entry`, so nothing a test started outlives the suite. */
function reap(entry: string): void {
  for (const { pid } of processesWith(entry)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Resolve once the thread has persisted an event `matches` accepts. */
async function persisted(host: AgentHost, threadId: string, matches: (event: DomainEvent) => boolean): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      void host.orchestrator
        .subscribe(threadId, {
          onEvents: (events) => {
            if (events.some(matches)) resolve();
          }
        })
        .then((stop) => {
          unsubscribe = stop;
        });
    });
  } finally {
    unsubscribe?.();
  }
}

async function readLog(appdir: string, threadId: string): Promise<DomainEvent[]> {
  return (await readFile(agentChatThreadEventsPath(appdir, threadId), "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DomainEvent);
}

function activitiesOf(log: readonly DomainEvent[], kind: string): ThreadActivityItem[] {
  return log.flatMap((event) =>
    event.type === "thread.activity-appended" && event.payload.activity.activityKind === kind
      ? [event.payload.activity]
      : []
  );
}

function sessionSets(log: readonly DomainEvent[]): Array<Extract<DomainEvent, { type: "thread.session-set" }>> {
  return log.filter(
    (event): event is Extract<DomainEvent, { type: "thread.session-set" }> => event.type === "thread.session-set"
  );
}

interface Rig {
  root: string;
  appdir: string;
  project: string;
  host: AgentHost;
}

/**
 * A host on a temp appdir whose PATH resolves exactly `shims` — name → the
 * script the shim runs under this node.
 */
async function bootHost(shims: Record<string, string>): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "host-teardown-"));
  const appdir = join(root, "appdir");
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(appdir, "tmp"), { recursive: true });
  for (const [name, script] of Object.entries(shims)) {
    const shim = join(home, ".local", "bin", name);
    await writeFile(shim, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const host = await startAgentHost({
    appdir,
    env: { HOME: home, PATH: "/usr/bin:/bin", ORQUESTER_APPDIR: appdir, TMPDIR: join(appdir, "tmp") },
    logger: quiet
  });
  await host.ready;
  return { root, appdir, project, host };
}

/** Start a Grok thread `t1` whose turn leaves the mock's `leftover` work running, and settle it. */
async function grokTurnWithLeftovers(rig: Rig, launchEnv: Record<string, string>): Promise<void> {
  await rig.host.orchestrator.createThread({
    threadId: "t1",
    projectPath: rig.project,
    cwd: rig.project,
    title: "teardown",
    refId: "grok",
    accountId: "",
    home: "system",
    modelSelection: { model: "grok-4.6" },
    runtimeMode: "approval-required",
    launchEnv: { GROK_MOCK_SCENARIO: "leftover", ...launchEnv }
  });
  // The mock's turn starts a helper at the session's open, a shell with a
  // member and a daemonizing grandchild, then reports the shell and ends.
  const settled = persisted(
    rig.host,
    "t1",
    (event) =>
      event.type === "thread.session-set" &&
      event.payload.session.status === "ready" &&
      event.payload.session.activeTurnId === null &&
      event.payload.turn !== undefined
  );
  await rig.host.orchestrator.command("t1", "turn", {
    commandId: randomUUID(),
    input: "go",
    interactionMode: "default"
  });
  await settled;
}

test(
  "a host teardown waits for every Grok session's stop: its helpers swept, the left-running row and the stop in the log, its work left running",
  { skip: process.platform !== "linux" },
  async () => {
    const mark = randomUUID();
    let rig: Rig | undefined;
    try {
      rig = await bootHost({ grok: GROK_MOCK });
      await grokTurnWithLeftovers(rig, { GROK_RIG_MARK: mark });
      const before = launched(mark);
      assert.equal(before.helper.length, 1, "the helper runs");
      assert.equal(before.shell.length, 1, "and so does the shell the turn left");

      // What production does at a deploy, a host restart or a SIGTERM — and
      // then `process.exit(0)` the moment it resolves.
      await rig.host.stop();

      const after = launched(mark);
      assert.deepEqual(after.helper, [], "the session's helper is swept before the teardown resolves");
      assert.deepEqual(after.shell, before.shell, "a deploy never kills running work");
      assert.deepEqual(after.member, before.member);
      assert.deepEqual(after.daemon, before.daemon, "nor what daemonized away");

      const log = await readLog(rig.appdir, "t1");
      assert.deepEqual(
        activitiesOf(log, "task.completed")
          .filter((activity) => (activity.payload as { taskId?: string }).taskId === "task-bg-1")
          .map((activity) => {
            const payload = activity.payload as { status?: string; summary?: string; leftRunning?: boolean };
            return [payload.status, payload.summary, payload.leftRunning];
          }),
        [["stopped", "Left running when the agent host stopped — stop it from Settings → System.", true]],
        "the shell's closing row reaches the log, saying where to stop it"
      );
      assert.equal(sessionSets(log).at(-1)?.payload.session.status, "stopped", "and so does the session's own stop");
      const remembered = JSON.parse(await readFile(agentChatThreadLeftoverWorkPath(rig.appdir, "t1"), "utf8")) as {
        launches: unknown[];
      };
      assert.equal(remembered.launches.length, 1, "the work it left running is remembered for the user's end");
    } finally {
      reap(`GROK_RIG_MARK=${mark}`);
      await rig?.host.stop();
      if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
);

test(
  "a helper that ignores SIGTERM is killed inside the SIGTERM path's 3 s backstop",
  { skip: process.platform !== "linux" },
  async () => {
    const mark = randomUUID();
    let rig: Rig | undefined;
    try {
      rig = await bootHost({ grok: GROK_MOCK });
      await grokTurnWithLeftovers(rig, { GROK_RIG_MARK: mark, GROK_MOCK_HELPER_IGNORES_TERM: "1" });
      assert.equal(launched(mark).helper.length, 1, "the helper runs");

      // The process entry exits 3 s after a SIGTERM whatever the stop is
      // doing (`main.ts`): the helper's SIGKILL must land well before that.
      const began = performance.now();
      await rig.host.stop();
      const took = performance.now() - began;

      assert.deepEqual(launched(mark).helper, [], "only the SIGKILL ends it, and it came");
      assert.ok(took < 3_000, `the teardown took ${Math.round(took)} ms, past the SIGTERM backstop`);
    } finally {
      reap(`GROK_RIG_MARK=${mark}`);
      await rig?.host.stop();
      if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
);

test(
  "a host teardown waits for every Codex session's stop: the turn's settle, a live agent's stop and the session's in the log, the child gone",
  { skip: process.platform !== "linux" },
  async () => {
    // A turn that keeps running with a live collab child: what a deploy finds.
    const server = writeMockCodexServer({
      turns: [{ kind: "spawn-child", childThreadId: "child-1", keepParentRunning: true }]
    });
    let rig: Rig | undefined;
    try {
      rig = await bootHost({ codex: server.bin });
      await rig.host.orchestrator.createThread({
        threadId: "t1",
        projectPath: rig.project,
        cwd: rig.project,
        title: "teardown",
        refId: "codex",
        accountId: "",
        home: "system",
        modelSelection: { model: "gpt-5.5" },
        runtimeMode: "approval-required"
      });
      const started = persisted(
        rig.host,
        "t1",
        (event) =>
          event.type === "thread.activity-appended" && event.payload.activity.activityKind === "task.started"
      );
      await rig.host.orchestrator.command("t1", "turn", {
        commandId: randomUUID(),
        input: "go",
        interactionMode: "default"
      });
      await started;
      const child = (): number[] =>
        processesWith("ORQUESTER_SESSION_ID=t1")
          .filter(({ argv }) => argv.includes(server.bin))
          .map(({ pid }) => pid);
      assert.equal(child().length, 1, "the session's app-server runs");

      await rig.host.stop();

      assert.deepEqual(child(), [], "the app-server is gone before the teardown resolves");
      const log = await readLog(rig.appdir, "t1");
      const sets = sessionSets(log);
      assert.equal(sets.at(-1)?.payload.session.status, "stopped", "the session's stop reaches the log");
      assert.ok(
        sets.some((event) => event.payload.turn?.turnId === "thread-mock-1-turn-1"),
        "so does the running turn's settle"
      );
      assert.deepEqual(
        activitiesOf(log, "task.completed").map((activity) => {
          const payload = activity.payload as { taskId?: string; status?: string };
          return [payload.taskId, payload.status];
        }),
        [["child-1", "stopped"]],
        "and the live agent's stop"
      );
    } finally {
      reap("ORQUESTER_SESSION_ID=t1");
      await rig?.host.stop();
      if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 3 });
      rmSync(server.dir, { recursive: true, force: true });
    }
  }
);

test(
  "the user's end of a Grok session is prepared before its card is answered: a CLI that exits on the cancel still has its work stopped, and its row says so",
  { skip: process.platform !== "linux" },
  async () => {
    // `leftover-question-exit`: the turn leaves a background shell (with a
    // member and a daemonizing grandchild) and a question open, and the CLI
    // exits the moment its card is answered — which the host does, with a
    // cancel, right after `prepareUserEnd` and before it stops the session.
    // Whether the exit lands before the stop begins or inside it is the
    // scheduler's call here: the ORDER is pinned in `orchestrator.test.ts`,
    // and the exit before any stop in the Grok `lifecycle.test.ts`; this pins
    // the outcome through the real composition.
    const mark = randomUUID();
    let rig: Rig | undefined;
    try {
      rig = await bootHost({ grok: GROK_MOCK });
      await rig.host.orchestrator.createThread({
        threadId: "t1",
        projectPath: rig.project,
        cwd: rig.project,
        title: "user end",
        refId: "grok",
        accountId: "",
        home: "system",
        modelSelection: { model: "grok-4.6" },
        runtimeMode: "approval-required",
        launchEnv: { GROK_MOCK_SCENARIO: "leftover-question-exit", GROK_RIG_MARK: mark }
      });
      // The shell is reported before the question is asked, on one stream:
      // once the card is in the log, so is the shell's start.
      const asked = persisted(
        rig.host,
        "t1",
        (event) =>
          event.type === "thread.activity-appended" && event.payload.activity.activityKind === "user-input.requested"
      );
      await rig.host.orchestrator.command("t1", "turn", {
        commandId: randomUUID(),
        input: "go",
        interactionMode: "default"
      });
      await asked;
      const before = launched(mark);
      assert.equal(before.shell.length, 1, "the shell runs");
      assert.equal(before.member.length, 1);
      assert.equal(before.daemon.length, 1);

      // The session stop command, as the GUI and the MCP send it.
      await rig.host.orchestrator.command("t1", "session/stop", { commandId: randomUUID() });
      await rig.host.orchestrator.drain();

      const after = launched(mark);
      assert.deepEqual(after.helper, []);
      assert.deepEqual(after.shell, [], "the user ended the session: its work goes with it");
      assert.deepEqual(after.member, []);
      assert.deepEqual(after.daemon, before.daemon, "never what daemonized away");
      const log = await readLog(rig.appdir, "t1");
      assert.deepEqual(
        activitiesOf(log, "task.completed")
          .filter((activity) => (activity.payload as { taskId?: string }).taskId === "task-bg-1")
          .map((activity) => {
            const payload = activity.payload as { status?: string; summary?: string; leftRunning?: boolean };
            return [payload.status, payload.summary, payload.leftRunning];
          }),
        [["stopped", undefined, undefined]],
        "it really stopped: nothing left running to speak of"
      );
      assert.equal(
        existsSync(agentChatThreadLeftoverWorkPath(rig.appdir, "t1")),
        false,
        "and the thread remembers none of it"
      );
    } finally {
      reap(`GROK_RIG_MARK=${mark}`);
      await rig?.host.stop();
      if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
);
