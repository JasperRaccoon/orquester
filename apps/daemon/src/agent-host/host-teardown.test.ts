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

import {
  agentChatThreadEventsPath,
  agentChatThreadLeftoverWorkPath,
  agentChatThreadMetaPath
} from "@orquester/config";
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
  /** The host's environment: a second host on the same appdir starts with it. */
  env: NodeJS.ProcessEnv;
  host: AgentHost;
  /**
   * Every host started on this rig, in order, `host` first: a test's
   * `finally` stops each, so a failure fails — a host left running (its
   * socket, its providers) would keep the file's process alive for good, and
   * with it the whole daemon run.
   */
  hosts: AgentHost[];
}

/** Point the shim `name` of the rig's PATH at `script`, run under this node. */
async function writeShim(home: string, name: string, script: string): Promise<void> {
  const shim = join(home, ".local", "bin", name);
  await writeFile(shim, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(shim, 0o755);
}

async function startHost(appdir: string, env: NodeJS.ProcessEnv): Promise<AgentHost> {
  const host = await startAgentHost({ appdir, env, logger: quiet });
  try {
    await host.ready;
  } catch (error) {
    await host.stop();
    throw error;
  }
  return host;
}

/** Start the next host on the rig's appdir — registered on the rig first, so the test stops it whatever fails. */
async function startNextHost(rig: Rig): Promise<AgentHost> {
  const host = await startAgentHost({ appdir: rig.appdir, env: rig.env, logger: quiet });
  rig.hosts.push(host);
  await host.ready;
  return host;
}

/** Stop every host the rig started, newest first. */
async function stopHosts(rig: Rig | undefined): Promise<void> {
  for (const host of [...(rig?.hosts ?? [])].reverse()) {
    await host.stop();
  }
}

/**
 * A host on a temp appdir whose PATH resolves exactly `shims` — name → the
 * script the shim runs under this node.
 */
async function bootHost(shims: Record<string, string>, extraEnv: Record<string, string> = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "host-teardown-"));
  const appdir = join(root, "appdir");
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(appdir, "tmp"), { recursive: true });
  for (const [name, script] of Object.entries(shims)) {
    await writeShim(home, name, script);
  }
  const env = { HOME: home, PATH: "/usr/bin:/bin", ORQUESTER_APPDIR: appdir, TMPDIR: join(appdir, "tmp"), ...extraEnv };
  const host = await startHost(appdir, env);
  return { root, appdir, project, env, host, hosts: [host] };
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
            return [payload.status, payload.leftRunning];
          }),
        [["stopped", true]],
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
  "host stop waits for a helper that ignores SIGTERM to be killed",
  { skip: process.platform !== "linux" },
  async () => {
    const mark = randomUUID();
    let rig: Rig | undefined;
    try {
      rig = await bootHost({ grok: GROK_MOCK });
      await grokTurnWithLeftovers(rig, { GROK_RIG_MARK: mark, GROK_MOCK_HELPER_IGNORES_TERM: "1" });
      assert.equal(launched(mark).helper.length, 1, "the helper runs");

      await rig.host.stop();

      assert.deepEqual(launched(mark).helper, [], "only the SIGKILL ends it, and it came");
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
            return [payload.status, payload.leftRunning];
          }),
        [["stopped", undefined]],
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

// ---------------------------------------------------------------------------
// §3.3's intentional-stop handover, through two real hosts on one appdir
// ---------------------------------------------------------------------------

/**
 * Resolve with the thread's log once `holds` is true of it — read off disk,
 * once the subscription is armed and again after every event the host appends.
 */
async function untilLog(
  host: AgentHost,
  appdir: string,
  threadId: string,
  holds: (log: DomainEvent[]) => boolean,
  label: string
): Promise<DomainEvent[]> {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<DomainEvent[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 30_000);
      let chain = Promise.resolve();
      const check = (): void => {
        chain = chain.then(async () => {
          const log = await readLog(appdir, threadId).catch(() => []);
          if (holds(log)) resolve(log);
        });
      };
      void host.orchestrator
        .subscribe(threadId, { onEvents: () => check() })
        .then((stop) => {
          unsubscribe = stop;
          check();
        }, reject);
    });
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
  }
}

/** The turn the log's latest session block says is running, or null. */
function runningTurn(log: readonly DomainEvent[]): string | null {
  const last = sessionSets(log).at(-1)?.payload.session;
  return last?.status === "running" && last.activeTurnId !== null ? last.activeTurnId : null;
}

async function readMeta(appdir: string, threadId: string): Promise<{
  session: { status: string; activeTurnId: string | null };
  continueAfterRestart?: { turnId: string; prepared?: boolean; markedAt?: string };
}> {
  return JSON.parse(await readFile(agentChatThreadMetaPath(appdir, threadId), "utf8")) as {
    session: { status: string; activeTurnId: string | null };
    continueAfterRestart?: { turnId: string; prepared?: boolean; markedAt?: string };
  };
}

/**
 * A deploy's handover: `/stop` marks the running turn (§3.3), the host's
 * teardown writes what it did to it (the turn interrupted, the session
 * stopped), and the next host on the same appdir continues it — for every
 * adapter, now that every adapter's teardown rows reach the log.
 */
async function handover(
  rig: Rig,
  thread: { refId: string; model: string; launchEnv?: Record<string, string> },
  beforeNextHost: () => Promise<void> = async () => undefined
): Promise<{ first: string; log: DomainEvent[] }> {
  await rig.host.orchestrator.createThread({
    threadId: "t1",
    projectPath: rig.project,
    cwd: rig.project,
    title: "handover",
    refId: thread.refId,
    accountId: "",
    home: "system",
    modelSelection: { model: thread.model },
    runtimeMode: "approval-required",
    ...(thread.launchEnv === undefined ? {} : { launchEnv: thread.launchEnv })
  });
  const running = untilLog(rig.host, rig.appdir, "t1", (log) => runningTurn(log) !== null, "the turn running");
  await rig.host.orchestrator.command("t1", "turn", {
    commandId: randomUUID(),
    input: "a long job",
    interactionMode: "default"
  });
  const first = runningTurn(await running)!;
  assert.deepEqual(await rig.host.orchestrator.markThreadsForContinuation(), ["t1"], "/stop marks it");
  await rig.host.stop();

  const stopped = await readMeta(rig.appdir, "t1");
  assert.equal(stopped.session.status, "stopped", "the teardown's rows reached the log");
  assert.equal(stopped.session.activeTurnId, null);
  // Stamped: only a marker this code wrote may continue a turn the teardown
  // settled. The next host reads it back through the store's schema.
  assert.equal(stopped.continueAfterRestart?.turnId, first);
  assert.equal(typeof stopped.continueAfterRestart?.markedAt, "string", "the marker is stamped");

  await beforeNextHost();
  const next = await startNextHost(rig);
  const log = await untilLog(
    next,
    rig.appdir,
    "t1",
    (entries) => {
      const turn = runningTurn(entries);
      return turn !== null && turn !== first;
    },
    "the continuation's turn"
  );
  // The continuation's effect clears the marker once the turn runs.
  await next.orchestrator.drain();
  return { first, log };
}

/** What the handover must leave: the old turn settled once, by the teardown; no error; no marker. */
async function assertContinued(rig: Rig, first: string, log: readonly DomainEvent[]): Promise<void> {
  assert.equal((await readMeta(rig.appdir, "t1")).continueAfterRestart, undefined, "the marker is cleared");
  assert.equal(
    sessionSets(log).filter((event) => event.payload.turn?.turnId === first).length,
    1,
    "the old turn is settled once — by the teardown"
  );
  assert.deepEqual(
    activitiesOf(log, "runtime.error").map((activity) => activity.summary),
    [],
    "never 'Session did not survive a restart'"
  );
}

test("an intentional stop's running Grok turn is continued by the next host, the teardown's rows kept", async () => {
  let rig: Rig | undefined;
  try {
    rig = await bootHost({ grok: GROK_MOCK }, { ORQUESTER_AGENT_CONTINUE_AFTER_RESTART: "1" });
    // `slow`: the turn runs until something cancels it.
    const done = await handover(rig, { refId: "grok", model: "grok-4.6", launchEnv: { GROK_MOCK_SCENARIO: "slow" } });
    await assertContinued(rig, done.first, done.log);
  } finally {
    await stopHosts(rig);
    if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("an intentional stop's running Codex turn is continued by the next host, the teardown's rows kept", async () => {
  // A turn that never ends on its own, on a server that numbers its turns from
  // 1; the next host's server numbers from 101, as a real one never reuses an id.
  const firstServer = writeMockCodexServer({ turns: [{ kind: "silent" }] });
  const nextServer = writeMockCodexServer({ turns: [{ kind: "silent" }], firstTurnSeq: 100 });
  let rig: Rig | undefined;
  try {
    rig = await bootHost({ codex: firstServer.bin }, { ORQUESTER_AGENT_CONTINUE_AFTER_RESTART: "1" });
    const home = rig.env["HOME"]!;
    const done = await handover(rig, { refId: "codex", model: "gpt-5.5" }, async () => {
      await writeShim(home, "codex", nextServer.bin);
    });
    await assertContinued(rig, done.first, done.log);
    const resumed = nextServer.received().filter((frame) => frame.method === "thread/resume");
    assert.equal(resumed.length, 1, "the next host resumed the thread from its cursor");
  } finally {
    await stopHosts(rig);
    reap("ORQUESTER_SESSION_ID=t1");
    if (rig !== undefined) await rm(rig.root, { recursive: true, force: true, maxRetries: 3 });
    rmSync(firstServer.dir, { recursive: true, force: true });
    rmSync(nextServer.dir, { recursive: true, force: true });
  }
});
