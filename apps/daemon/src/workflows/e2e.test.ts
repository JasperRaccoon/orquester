// End to end, in-process: the workflow runtime exactly as `startDaemon` wires it (daemon-wiring.ts),
// driven over its REAL routes, on real stores in a temp appdir, with the REAL sandbox (node/bash
// children) and a local node:http server. Every wait is an event on the "workflows" bus.
//
//   - a manual run: code → IF → shell (env mapping, a secret) → HTTP, the false branch skipped;
//     every block's status/output/handle, the taken and dead edges, the persisted run, the events;
//   - secrets: redacted in outputs, run.json, events.ndjson and the log route (the raw log keeps it);
//   - a restart mid-run: the runtime torn down while a shell block sleeps, a new one over the same
//     appdir resumes the detached child and finishes the run;
//   - the schedule trigger on a manual clock (nextRunAt on the rail, the fire, the next time);
//   - the git trigger through the poller over a fake remote (baseline, push, a poll error on the rail);
//   - deleting a workflow deletes the temporary projects its failed runs kept.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type {
  EventMessage,
  GetWorkflowRunResponse,
  ListWorkflowsResponse,
  RunWorkflowResponse,
  WorkflowRun,
  WorkflowSummary,
  WorkflowWriteResponse
} from "@orquester/api";
import { workflowRunsDir } from "@orquester/config";

import { ManualClock } from "./testing/manual-trigger-clock.ts";
import { systemTriggerClock } from "./triggers/clock.ts";
import { advance } from "./triggers/test-support.ts";
import { boot, FakeGitRemote, runFinished, tempAppdir, waitForFileState, type Booted } from "./testing/daemon-harness.ts";

const SECRET = "tok-e2e-5ecret-value";

let hook: Server;
let hookUrl: string;
const hookRequests: { method?: string; url?: string; token?: string; body: string }[] = [];

before(async () => {
  hook = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const token = req.headers["x-token"] as string | undefined;
      hookRequests.push({ method: req.method, url: req.url, token, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, token, echo: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => hook.close(() => resolve()));
});

async function json<T>(h: Booted, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await h.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
}

async function create(h: Booted, body: Record<string, unknown>): Promise<WorkflowWriteResponse> {
  const res = await json<WorkflowWriteResponse>(h, "POST", "/api/workflows", body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function runNow(h: Booted, workflowId: string, input?: unknown): Promise<string> {
  const res = await json<RunWorkflowResponse>(h, "POST", `/api/workflows/${workflowId}/run`, input === undefined ? {} : { input });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.runId, JSON.stringify(res.body));
  return res.body.runId!;
}

async function getRun(h: Booted, runId: string): Promise<WorkflowRun> {
  const res = await json<GetWorkflowRunResponse>(h, "GET", `/api/workflow-runs/${runId}`);
  assert.equal(res.status, 200);
  return res.body.run;
}


describe("e2e: a manual run through code, IF, shell and HTTP", () => {
  let dir: Awaited<ReturnType<typeof tempAppdir>>;
  let h: Booted;
  before(async () => {
    dir = await tempAppdir();
    h = await boot(dir.root);
  });
  after(async () => {
    await h.close();
    await dir.cleanup();
  });

  test("every block's status, output, handle and edge; the run persisted; secrets redacted everywhere", async () => {
    const projectPath = join(dir.workspacesDir, "acme", "app");
    const secret = await json<{ secrets: { name: string }[] }>(h, "PUT", "/api/workflow-secrets/TOKEN", { value: SECRET });
    assert.equal(secret.status, 200);
    assert.deepEqual(secret.body.secrets.map((s) => s.name), ["TOKEN"]);
    assert.ok(!JSON.stringify(secret.body).includes(SECRET), "a secret value never crosses the wire");

    const written = await create(h, {
      name: "Pipeline",
      project: { kind: "existing", projectPath },
      settings: { timezone: "UTC" },
      nodes: [
        { id: "start", type: "trigger.manual", name: "Start" },
        {
          id: "compute",
          type: "code",
          name: "Compute",
          config: {
            source:
              "export default async ({ input, secrets, log }) => { log('computing ' + secrets.TOKEN); return { ok: input.input.n > 10, greeting: 'hello ' + input.input.name, n: input.input.n, leaked: secrets.TOKEN }; }"
          }
        },
        { id: "check", type: "if", name: "Check", config: { combine: "all", rules: [{ left: "{{ nodes.Compute.output.ok }}", op: "isTrue" }] } },
        {
          id: "greet",
          type: "shell",
          name: "Greet",
          config: {
            script: 'echo "greet=$GREETING"; echo "token=$TOKEN"; echo "careful" >&2',
            env: [
              { name: "GREETING", value: "{{ nodes.Compute.output.greeting }}" },
              { name: "TOKEN", value: "{{ secrets.TOKEN }}" }
            ]
          }
        },
        { id: "never", type: "shell", name: "Never", config: { script: "echo never" } },
        {
          id: "call",
          type: "http",
          name: "Call",
          config: {
            method: "POST",
            url: `${hookUrl}/hook`,
            query: [{ name: "n", value: "{{ nodes.Compute.output.n }}" }],
            headers: [{ name: "X-Token", value: "{{ secrets.TOKEN }}" }],
            body: { kind: "json", value: '{"exit": {{ nodes.Greet.output.exitCode }}, "who": "{{ nodes.Compute.output.greeting }}"}' }
          }
        }
      ],
      edges: [
        { source: "Start", target: "Compute" },
        { source: "Compute", target: "Check" },
        { source: "Check", sourceHandle: "true", target: "Greet" },
        { source: "Check", sourceHandle: "false", target: "Never" },
        { source: "Greet", target: "Call" }
      ]
    });
    assert.deepEqual(written.problems.filter((p) => p.severity === "error"), []);
    const workflowId = written.workflow.id;
    await h.waitEvent((e) => e.type === "workflow.upserted" && (e.payload as { workflow: WorkflowSummary }).workflow.id === workflowId);

    const since = h.events.length;
    const runId = await runNow(h, workflowId, { n: 21, name: "Ada" });
    await h.waitEvent(runFinished(runId), 30_000, since);
    const run = await getRun(h, runId);
    assert.equal(run.status, "succeeded", JSON.stringify(run.blocks, null, 2));
    assert.equal(run.trigger.kind, "manual");

    const b = run.blocks;
    assert.deepEqual(b.compute!.output, { ok: true, greeting: "hello Ada", n: 21, leaked: "«secret:TOKEN»" });
    const greet = b.greet!.output as { stdout: string; stderr: string; exitCode: number };
    assert.match(greet.stdout, /greet=hello Ada/);
    assert.match(greet.stdout, /token=«secret:TOKEN»/);
    assert.match(greet.stderr, /careful/);
    assert.equal(greet.exitCode, 0);
    const call = b.call!.output as { status: number; body: { method: string; url: string; token: string; echo: unknown } };
    assert.equal(call.status, 200);
    assert.equal(call.body.method, "POST");
    assert.equal(call.body.url, "/hook?n=21");
    assert.equal(call.body.token, "«secret:TOKEN»", "the echoed secret is redacted in the block's output");
    assert.deepEqual(call.body.echo, { exit: 0, who: "hello Ada" });
    assert.equal(hookRequests.at(-1)!.token, SECRET, "the real value was sent");

    assert.deepEqual(run.finalOutput, call);

    // The bus: started, updates, finished, and a rail row carrying the last run.
    const mine = h.events.slice(since).filter((e) => (e.payload as { run?: { id?: string } })?.run?.id === runId);
    assert.equal(mine[0]!.type, "workflowRun.started");
    assert.ok(mine.some((e) => e.type === "workflowRun.updated"));
    assert.equal(mine.at(-1)!.type, "workflowRun.finished");
    const rows = h.events.slice(since).filter((e) => e.type === "workflow.upserted").map((e) => (e.payload as { workflow: WorkflowSummary }).workflow);
    assert.ok(rows.some((row) => row.lastRun?.id === runId && row.lastRun.status === "succeeded" && row.activeRuns.length === 0));
    for (const event of h.events) assert.ok(!JSON.stringify(event).includes(SECRET), `event ${event.type} carries no secret`);

    // Persisted: run.json and events.ndjson hold no secret; the history lists the run.
    const runDir = join(workflowRunsDir(dir.root), runId);
    const onDisk = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as WorkflowRun;
    assert.equal(onDisk.status, "succeeded");
    assert.equal(onDisk.blocks.greet!.status, "succeeded");
    assert.ok(!(await readFile(join(runDir, "run.json"), "utf8")).includes(SECRET));
    assert.ok(!(await readFile(join(runDir, "events.ndjson"), "utf8")).includes(SECRET));
    const history = await json<{ runs: { id: string }[] }>(h, "GET", `/api/workflows/${workflowId}/runs`);
    assert.equal(history.body.runs[0]!.id, runId);

    // Logs: redacted when served (the raw attempt log on disk keeps what the process printed).
    const log = await h.inject({ method: "GET", url: `/api/workflow-runs/${runId}/nodes/greet/log?stream=stdout` });
    assert.equal(log.statusCode, 200);
    assert.match(log.body, /token=«secret:TOKEN»/);
    assert.ok(!log.body.includes(SECRET));
    assert.equal(log.headers["x-log-live"], "0");
    const codeLog = await h.inject({ method: "GET", url: `/api/workflow-runs/${runId}/nodes/compute/log?stream=stdout` });
    assert.match(codeLog.body, /computing «secret:TOKEN»/);
    const raw = await readFile(join(runDir, "nodes", "greet", "1", "stdout.log"), "utf8");
    assert.match(raw, new RegExp(`token=${SECRET}`));
    await assert.rejects(stat(join(runDir, "nodes", "compute", "1", "input.json")), "input.json (with secrets) is gone");

    // A block's whole output through its route.
    const out = await json<{ output: unknown }>(h, "GET", `/api/workflow-runs/${runId}/nodes/compute/output`);
    assert.deepEqual(out.body.output, { ok: true, greeting: "hello Ada", n: 21, leaked: "«secret:TOKEN»" });
  });
});

describe("e2e: a daemon restart mid-run", () => {
  test("the runtime stops while a shell block sleeps; a new one over the same appdir resumes it", async () => {
    const dir = await tempAppdir();
    let h = await boot(dir.root);
    try {
      const written = await create(h, {
        name: "Sleeper",
        project: { kind: "existing", projectPath: join(dir.workspacesDir, "acme", "app") },
        nodes: [
          { id: "start", type: "trigger.manual", name: "Start" },
          { id: "sleep", type: "shell", name: "Sleep", config: { script: `node -e 'const fs = require("node:fs"); const file = process.env.RELEASE; const done = () => { if (fs.existsSync(file)) { console.log("slept"); process.exit(0); } }; fs.watch(require("node:path").dirname(file), done); done();'`, env: [{ name: "RELEASE", value: join(dir.root, "release") }] } },
          { id: "after", type: "code", name: "After", config: { source: "export default ({ input }) => ({ after: input.stdout.trim() })" } }
        ],
        edges: [
          { source: "Start", target: "Sleep" },
          { source: "Sleep", target: "After" }
        ]
      });
      const runId = await runNow(h, written.workflow.id);
      // Wait until the block runs and what it waits on is on disk.
      await h.waitEvent(
        (e) =>
          e.type === "workflowRun.updated" &&
          (e.payload as { run: { id: string }; blocks: { nodeId: string; status: string }[] }).run.id === runId &&
          (e.payload as { blocks: { nodeId: string; status: string }[] }).blocks.some((block) => block.nodeId === "sleep" && block.status === "running")
      );
      const persisted = await waitForFileState(join(workflowRunsDir(dir.root), runId, "run.json"), () => h.runStore.load(runId), (run) => run?.blocks.sleep?.waitingOn?.kind === "process");
      const waitingOn = persisted!.blocks.sleep!.waitingOn;
      assert.equal(waitingOn?.kind, "process", JSON.stringify(persisted!.blocks.sleep));
      const pid = (waitingOn as { pid: number }).pid;

      await h.close();
      // The detached child outlived the runtime that started it.
      assert.doesNotThrow(() => process.kill(pid, 0), "the sandbox child survives the stop");
      const stopped = await h.runStore.load(runId);
      assert.equal(stopped!.status, "running");

      h = await boot(dir.root);
      await writeFile(join(dir.root, "release"), "go");
      await h.waitEvent(runFinished(runId), 30_000);
      const run = await getRun(h, runId);
      assert.equal(run.status, "succeeded", JSON.stringify(run.blocks, null, 2));
      assert.equal(run.blocks.sleep!.attempt, 1, "the block was resumed, never re-run");
      assert.match((run.blocks.sleep!.output as { stdout: string }).stdout, /slept/);
      assert.deepEqual(run.blocks.after!.output, { after: "slept" });
    } finally {
      await h.close();
      await dir.cleanup();
    }
  });
});

describe("e2e: the schedule trigger", () => {
  test("nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows", async (t) => {
    const dir = await tempAppdir();
    const clock = new ManualClock("2026-09-28T12:01:30.000Z");
    t.mock.method(systemTriggerClock, "now", () => clock.now());
    t.mock.method(systemTriggerClock, "setTimeout", (fn: () => void, ms: number) => clock.setTimeout(fn, ms));
    const h = await boot(dir.root);
    try {
      const since = h.events.length;
      const written = await create(h, {
        name: "Every five",
        enabled: true,
        project: { kind: "existing", projectPath: join(dir.workspacesDir, "acme", "app") },
        settings: { timezone: "UTC" },
        nodes: [
          { id: "tick", type: "trigger.schedule", name: "Tick", config: { preset: { kind: "minutes", every: 5 }, cron: "*/5 * * * *" } },
          { id: "work", type: "code", name: "Work", config: { source: "export default ({ trigger }) => ({ kind: trigger.kind, scheduledFor: trigger.scheduledFor })" } }
        ],
        edges: [{ source: "Tick", target: "Work" }]
      });
      assert.equal(written.workflow.enabled, true);
      const workflowId = written.workflow.id;
      // The edit's own row went out before the scheduler reconciled; the watcher follows with the time.
      await h.wf.scheduler.idle();
      await advance(clock, () => h.wf.scheduler.idle(), 15_000);
      await h.waitEvent(
        (e) => e.type === "workflow.upserted" && (e.payload as { workflow: WorkflowSummary }).workflow.triggers[0]?.nextRunAt === "2026-09-28T12:05:00.000Z",
        5_000,
        since
      );
      const listed = await json<ListWorkflowsResponse>(h, "GET", "/api/workflows");
      assert.equal(listed.body.workflows.find((w) => w.id === workflowId)!.triggers[0]!.nextRunAt, "2026-09-28T12:05:00.000Z");

      const before = h.events.length;
      await advance(clock, () => h.wf.scheduler.idle(), 3.25 * 60_000);
      const started = await h.waitEvent((e) => e.type === "workflowRun.started" && (e.payload as { run: { workflowId: string } }).run.workflowId === workflowId, 5_000, before);
      const runId = (started.payload as { run: { id: string } }).run.id;
      await h.waitEvent(runFinished(runId));
      const run = await getRun(h, runId);
      assert.equal(run.status, "succeeded");
      assert.equal(run.trigger.kind, "schedule");
      assert.equal(run.trigger.nodeId, "tick");
      assert.deepEqual(run.blocks.work!.output, { kind: "schedule", scheduledFor: "2026-09-28T12:05:00.000Z" });
      const after = await json<ListWorkflowsResponse>(h, "GET", "/api/workflows");
      assert.equal(after.body.workflows.find((w) => w.id === workflowId)!.triggers[0]!.nextRunAt, "2026-09-28T12:10:00.000Z");
      assert.equal(h.state.get().schedules[`${workflowId}:tick`]!.lastFiredAt, "2026-09-28T12:05:00.000Z");
    } finally {
      await h.close();
      await dir.cleanup();
    }
  });
});

describe("e2e: the git trigger", () => {
  test("the poller baselines, fires once on a push, and a failing poll shows on the rail", async (t) => {
    const dir = await tempAppdir();
    const clock = new ManualClock("2026-09-28T12:00:00.000Z");
    const remote = new FakeGitRemote();
    const sha = (c: string) => c.repeat(40);
    remote.heads = { main: sha("a") };
    t.mock.method(systemTriggerClock, "now", () => clock.now());
    t.mock.method(systemTriggerClock, "setTimeout", (fn: () => void, ms: number) => clock.setTimeout(fn, ms));
    t.mock.method(Math, "random", () => 0);
    const h = await boot(dir.root, { gitRemote: remote });
    const pump = (ms: number) => advance(clock, () => h.wf.poller.idle(), ms);
    try {
      const written = await create(h, {
        name: "On push",
        enabled: true,
        project: { kind: "existing", projectPath: join(dir.workspacesDir, "acme", "app") },
        nodes: [
          { id: "push", type: "trigger.git", name: "Push", config: { repo: { kind: "url", url: "https://github.com/acme/app.git" }, event: { kind: "push", branches: ["main"] } } },
          { id: "see", type: "code", name: "See", config: { source: "export default ({ trigger }) => ({ branch: trigger.branch, sha: trigger.sha, previousSha: trigger.previousSha })" } }
        ],
        edges: [{ source: "Push", target: "See" }]
      });
      const workflowId = written.workflow.id;
      await h.wf.poller.idle();
      await pump(1_000);
      assert.equal(h.state.get().git[`${workflowId}:push`]!.baselined, true);
      assert.equal(h.events.filter((e) => e.type === "workflowRun.started").length, 0, "a baseline fires nothing");
      const listed = await json<ListWorkflowsResponse>(h, "GET", "/api/workflows");
      assert.ok(listed.body.workflows[0]!.triggers[0]!.lastPollAt, "the rail knows the last poll");

      remote.heads = { main: sha("b") };
      const before = h.events.length;
      await pump(70_000);
      const started = await h.waitEvent((e) => e.type === "workflowRun.started", 5_000, before);
      const runId = (started.payload as { run: { id: string } }).run.id;
      await h.waitEvent(runFinished(runId));
      const run = await getRun(h, runId);
      assert.equal(run.status, "succeeded", JSON.stringify(run.blocks));
      assert.equal(run.trigger.kind, "git");
      assert.deepEqual(run.blocks.see!.output, { branch: "main", sha: sha("b"), previousSha: sha("a") });

      // The same state again fires nothing; a failing poll lands on the rail as lastError.
      const quiet = h.events.length;
      remote.lsError = Object.assign(new Error("Permission denied (publickey)"), { kind: "auth" });
      await pump(70_000);
      assert.equal(h.events.slice(quiet).filter((e) => e.type === "workflowRun.started").length, 0);
      const failing = await h.waitEvent(
        (e) => e.type === "workflow.upserted" && Boolean((e.payload as { workflow: WorkflowSummary }).workflow.triggers[0]?.lastError),
        5_000,
        quiet
      );
      assert.equal((failing.payload as { workflow: WorkflowSummary }).workflow.id, workflowId);
    } finally {
      await h.close();
      await dir.cleanup();
    }
  });
});

describe("e2e: deleting a workflow", () => {
  test("cancels its active runs and deletes its runs, secrets and the temp projects failed runs kept", async () => {
    const dir = await tempAppdir();
    const deleted: string[] = [];
    // Temp projects go through the daemon's own project routes: record the deletes they ask for.
    const h = await boot(dir.root, {
      engineApi: (inject) => ({
        request: async (method, path, opts) => {
          const project = /^\/api\/workspaces\/([^/]+)\/projects(?:\/([^/]+))?$/.exec(path);
          if (project && method === "POST") {
            const name = (opts?.body as { name: string }).name;
            const path = join(dir.workspacesDir, decodeURIComponent(project[1]!), name);
            await mkdir(path, { recursive: true });
            return { status: 201, body: { path, name, workspace: decodeURIComponent(project[1]!) } };
          }
          if (project && method === "DELETE") {
            deleted.push(decodeURIComponent(project[2]!));
            return { status: 204, body: null };
          }
          return inject.request(method, path, opts);
        },
        uploadAttachment: (...args) => inject.uploadAttachment(...args),
        subscribe: (listener) => inject.subscribe(listener),
        get fsRoot() {
          return inject.fsRoot;
        },
        get workspacesDir() {
          return inject.workspacesDir;
        }
      })
    });
    try {
      const written = await create(h, {
        name: "Fails",
        project: { kind: "temp", workspace: "acme", source: { kind: "empty" } },
        settings: { keepFailedTempDays: 3 },
        nodes: [
          { id: "start", type: "trigger.manual", name: "Start" },
          { id: "slow", type: "if", name: "Slow", config: { rules: [{ left: "{{ trigger.input.slow }}", op: "isTrue" }] } },
          { id: "boom", type: "code", name: "Boom", config: { source: "export default () => { throw new Error('boom'); }" } },
          { id: "nap", type: "shell", name: "Nap", config: { script: "sleep 20" } }
        ],
        edges: [
          { source: "Start", target: "Slow" },
          { source: "Slow", sourceHandle: "false", target: "Boom" },
          { source: "Slow", sourceHandle: "true", target: "Nap" }
        ]
      });
      const workflowId = written.workflow.id;
      await json(h, "PUT", `/api/workflow-secrets/OWN?workflowId=${workflowId}`, { value: "own-secret-value" });
      const runId = await runNow(h, workflowId);
      await h.waitEvent(runFinished(runId));
      const run = await getRun(h, runId);
      assert.equal(run.status, "failed");
      assert.ok(run.tempProject && !run.tempProject.deleted && run.tempProject.deleteAfter, "the failed run keeps its temp project");
      const tempName = run.tempProject.path.split("/").at(-1)!;
      assert.equal(deleted.length, 0);

      // A second run still going when the workflow is deleted.
      const active = await runNow(h, workflowId, { slow: true });
      await h.waitEvent(
        (e) =>
          e.type === "workflowRun.updated" &&
          (e.payload as { run: { id: string }; blocks: { nodeId: string; status: string }[] }).run.id === active &&
          (e.payload as { blocks: { nodeId: string; status: string }[] }).blocks.some((block) => block.nodeId === "nap" && block.status === "running")
      );
      const activeTemp = (await getRun(h, active)).tempProject!.path.split("/").at(-1)!;

      const res = await h.inject({ method: "DELETE", url: `/api/workflows/${workflowId}` });
      assert.equal(res.statusCode, 204);
      assert.ok(deleted.includes(tempName), "the kept temp project went with the workflow");
      // The delete waited for the cancelled run to end: its own temp project is gone already.
      const ended = await h.waitEvent(runFinished(active), 1);
      assert.equal((ended.payload as { run: { status: string } }).run.status, "cancelled");
      assert.deepEqual([...deleted].sort(), [tempName, activeTemp].sort(), "the cancelled run's temp project went too");
      assert.equal(await h.runStore.load(active), null);
      assert.equal(await h.runStore.load(runId), null);
      const left = await readdir(workflowRunsDir(dir.root)).then((names) => names.filter((n) => n !== "index.json"));
      assert.deepEqual(left, []);
      assert.deepEqual(h.secrets.list(), []);
      assert.ok(h.events.some((e: EventMessage) => e.type === "workflow.deleted"));
    } finally {
      await h.close();
      await dir.cleanup();
    }
  });
});
