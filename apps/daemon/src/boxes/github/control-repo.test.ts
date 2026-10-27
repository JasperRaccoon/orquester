import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";

import {
  cancelRun,
  dispatchBoxRun,
  dispatchWorkflowRun,
  ensureControlRepo,
  ensureControlWorkflows,
  ensureWorkflowFile,
  forceCancelRun,
  getRun,
  listRecentRuns,
  waitWorkflowReady
} from "./control-repo.ts";
import { FakeGithub } from "./fake-github.ts";
import {
  BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE,
  BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH,
  BLACKSMITH_WORKFLOW_FILE,
  BLACKSMITH_WORKFLOW_PATH,
  blacksmithWorkflowTemplate
} from "./workflow-template.ts";

const TOKEN = "ghp_TESTTOKEN0123456789";
const signal = new AbortController().signal;

const fetchMocks = new WeakMap<test.TestContext, test.Mock<typeof fetch>>();

function call(t: test.TestContext, github: FakeGithub) {
  const mocked = fetchMocks.get(t);
  if (mocked) mocked.mock.mockImplementation(github.fetch);
  else fetchMocks.set(t, t.mock.method(globalThis, "fetch", github.fetch));
  return { token: TOKEN, signal };
}

/** Run a promise whose waits use mocked setTimeout: flush I/O, then advance the clock, until it settles. */
async function drive<T>(t: test.TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  while (!settled) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(1000);
  }
  return promise;
}

const inputs = {
  box_id: "box-0123456789ab",
  lifetime_minutes: "60",
  daemon_url: "https://orq.example.com",
  runner: "blacksmith-6vcpu-macos-26",
  os: "macos",
  prepare: "none"
} as const;

test("ensureControlRepo and ensureWorkflowFile are idempotent and update a changed template", async (t) => {
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  assert.deepEqual(repo, { repository: "Org/orquester-macos-boxes", defaultBranch: "main", htmlUrl: "https://github.com/Org/orquester-macos-boxes", created: true });
  assert.equal(github.repos.get("Org/orquester-macos-boxes")!.private, true);
  assert.equal((await ensureControlRepo("Org", call(t, github))).created, false);

  const template = blacksmithWorkflowTemplate();
  const first = await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, template, call(t, github));
  assert.equal(first.changed, true);
  assert.equal((await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, template, call(t, github))).changed, false);
  const updated = blacksmithWorkflowTemplate({ tailscale: { oauthClientId: "kClient123", audience: "api.tailscale.com/kClient123" } });
  assert.equal((await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, updated, call(t, github))).changed, true);
  assert.equal(github.repos.get("Org/orquester-macos-boxes")!.files.get(BLACKSMITH_WORKFLOW_PATH)!.content, updated);

  github.repos.get("Org/orquester-macos-boxes")!.private = false;
  await assert.rejects(ensureControlRepo("Org", call(t, github)), /is public/);
});

test("ensureControlWorkflows commits both workflows, then only the ones whose content hash changed", async (t) => {
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  const files = () => github.repos.get("Org/orquester-macos-boxes")!.files;
  const puts = () => github.calls.filter((entry) => entry.method === "PUT").map((entry) => entry.path.replace(/^.*\/contents\//, ""));

  assert.deepEqual(await ensureControlWorkflows(repo, {}, call(t, github)), { changed: [BLACKSMITH_WORKFLOW_PATH, BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH] });
  const committed = parse(files().get(BLACKSMITH_WORKFLOW_PATH)!.content);
  assert.deepEqual(committed.on.workflow_dispatch.inputs.os.options, ["macos", "linux"]);
  assert.deepEqual(committed.on.workflow_dispatch.inputs.prepare.options, ["none", "devices"]);
  assert.ok(parse(files().get(BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH)!.content).on.workflow_dispatch.inputs.request_id);

  // Unchanged: two reads, no write.
  const before = puts().length;
  assert.deepEqual(await ensureControlWorkflows(repo, {}, call(t, github)), { changed: [] });
  assert.equal(puts().length, before);

  // An org set up by an older build (an old box workflow): only that file is re-committed.
  files().set(BLACKSMITH_WORKFLOW_PATH, { content: "name: Orquester box\n# an older template\n", sha: "old-blob" });
  const writes = puts().length;
  assert.deepEqual(await ensureControlWorkflows(repo, {}, call(t, github)), { changed: [BLACKSMITH_WORKFLOW_PATH] });
  assert.deepEqual(puts().slice(writes), [BLACKSMITH_WORKFLOW_PATH]);
  assert.equal(parse(files().get(BLACKSMITH_WORKFLOW_PATH)!.content).on.workflow_dispatch.inputs.os.default, "macos");

  // Options are part of the content: the Tailscale join changes only the box workflow.
  const tailscale = { oauthClientId: "kClient123", audience: "api.tailscale.com/kClient123" };
  assert.deepEqual(await ensureControlWorkflows(repo, { tailscale }, call(t, github)), { changed: [BLACKSMITH_WORKFLOW_PATH] });

});

test("ensureWorkflowFile trusts a matching blob sha without decoding the content", async (t) => {
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  // Independent Git object IDs (`git hash-object --stdin`), including UTF-8 byte length.
  for (const [content, sha] of [["hello\n", "ce013625030ba8dba906f756967f9e9ca394464a"], ["", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"], ["é\n", "c6003325155f475bd7c87731607525dce73be9cf"]]) {
    github.repos.get("Org/orquester-macos-boxes")!.files.set(BLACKSMITH_WORKFLOW_PATH, { content: "not decoded", sha: sha! });
    assert.deepEqual(await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, content!, call(t, github)), { changed: false, commitSha: null });
  }
});

test("dispatchWorkflowRun starts a device-cache run and finds it by name when GitHub answers 204", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  await ensureControlWorkflows(repo, {}, call(t, github));
  github.dispatchNoDetails = true;
  const inputs = { request_id: "6f1c1d1e-4a1b-4c7d-9e2f-0a1b2c3d4e5f", os: "linux", runner: "blacksmith-8vcpu-ubuntu-2404" };
  const found = await drive(
    t,
    dispatchWorkflowRun(
      { repository: repo.repository, workflowFile: BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE, ref: "main", inputs, runName: `orq-cache-linux-${inputs.request_id}` },
      call(t, github)
    )
  );
  const run = github.runs.get(found.runId)!;
  assert.equal(run.workflowFile, BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE);
  assert.deepEqual(run.inputs, inputs);
});

test("a dispatch with inputs the committed workflow does not declare is retried until the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  // An older box workflow without the os/prepare inputs: GitHub refuses the dispatch (422).
  const old = "name: Old box\non:\n  workflow_dispatch:\n    inputs:\n      box_id: {}\n      lifetime_minutes: {}\n      daemon_url: {}\n      runner: {}\n";
  await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, old, call(t, github));
  await assert.rejects(
    drive(t, dispatchBoxRun({ repository: repo.repository, workflowFile: BLACKSMITH_WORKFLOW_FILE, ref: "main", inputs }, { ...call(t, github), deadlineMs: 10_000 })),
    /does not accept dispatches/
  );
  assert.equal(github.runs.size, 0);
});

test("waitWorkflowReady and dispatchBoxRun retry until GitHub has indexed the workflow", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, blacksmithWorkflowTemplate(), call(t, github));
  github.workflowGet404s = 2;
  assert.equal((await drive(t, waitWorkflowReady(repo.repository, BLACKSMITH_WORKFLOW_FILE, call(t, github)))).state, "active");

  github.dispatch404s = 1;
  github.dispatch422s = 1;
  const dispatched = await drive(
    t,
    dispatchBoxRun({ repository: repo.repository, workflowFile: BLACKSMITH_WORKFLOW_FILE, ref: "main", inputs }, call(t, github))
  );
  const run = github.runs.get(dispatched.runId)!;
  assert.equal(run.displayTitle, "orq-box-0123456789ab");
  assert.deepEqual(run.inputs, inputs);
  const dispatchCalls = github.calls.filter((entry) => entry.path.endsWith("/dispatches"));
  assert.equal(dispatchCalls.length, 3);
  assert.equal((dispatchCalls[2]!.body as { return_run_details: boolean }).return_run_details, true);
});

test("dispatchBoxRun fails at once on a real input error and finds the run when GitHub answers 204", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  const request = { repository: repo.repository, workflowFile: BLACKSMITH_WORKFLOW_FILE, ref: "main" };
  await assert.rejects(dispatchBoxRun({ ...request, inputs: { ...inputs, runner: "ubuntu-latest" } }, call(t, github)), /not in the list of allowed values/);
  assert.equal(github.runs.size, 0);

  github.dispatchNoDetails = true;
  const found = await drive(t, dispatchBoxRun({ ...request, inputs }, call(t, github)));
  assert.equal(github.runs.get(found.runId)!.displayTitle, "orq-box-0123456789ab");
});

test("runs: get, list since, cancel and force-cancel", async (t) => {
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(t, github));
  const old = github.addRun({ displayTitle: "orq-box-old000000000", createdAt: "2026-10-01T00:00:00Z" });
  const live = github.addRun({ displayTitle: "orq-box-live00000000", cancellable: false });
  const recent = await listRecentRuns(repo.repository, BLACKSMITH_WORKFLOW_FILE, { ...call(t, github), since: new Date(Date.now() - 3600_000) });
  assert.deepEqual(recent.map((run) => run.id), [live.id]);
  assert.ok(old.id < live.id);

  assert.equal(await cancelRun(repo.repository, live.id, call(t, github)), true);
  assert.equal((await getRun(repo.repository, live.id, call(t, github)))!.status, "in_progress", "this cancel did not land");
  assert.equal(await forceCancelRun(repo.repository, live.id, call(t, github)), true);
  const done = (await getRun(repo.repository, live.id, call(t, github)))!;
  assert.deepEqual([done.status, done.conclusion], ["completed", "cancelled"]);
  assert.equal(await cancelRun(repo.repository, live.id, call(t, github)), false, "a completed run answers 409");
  assert.equal(await getRun(repo.repository, 12345, call(t, github)), null);
});
