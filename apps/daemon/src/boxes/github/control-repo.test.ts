import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelRun,
  dispatchBoxRun,
  ensureControlRepo,
  ensureWorkflowFile,
  forceCancelRun,
  getRun,
  listRecentRuns,
  waitWorkflowReady
} from "./control-repo.ts";
import { FakeGithub } from "./fake-github.ts";
import { BLACKSMITH_WORKFLOW_FILE, BLACKSMITH_WORKFLOW_PATH, blacksmithWorkflowTemplate } from "./workflow-template.ts";

const TOKEN = "ghp_TESTTOKEN0123456789";
const signal = new AbortController().signal;

function call(github: FakeGithub) {
  return { token: TOKEN, signal, fetch: github.fetch };
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

const inputs = { box_id: "box-0123456789ab", lifetime_minutes: "60", daemon_url: "https://orq.example.com", runner: "blacksmith-6vcpu-macos-26" };

test("ensureControlRepo and ensureWorkflowFile are idempotent and update a changed template", async () => {
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(github));
  assert.deepEqual(repo, { repository: "Org/orquester-macos-boxes", defaultBranch: "main", htmlUrl: "https://github.com/Org/orquester-macos-boxes", created: true });
  assert.equal(github.repos.get("Org/orquester-macos-boxes")!.private, true);
  assert.equal((await ensureControlRepo("Org", call(github))).created, false);

  const template = blacksmithWorkflowTemplate();
  const first = await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, template, call(github));
  assert.equal(first.changed, true);
  assert.equal((await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, template, call(github))).changed, false);
  const updated = blacksmithWorkflowTemplate({ tailscale: { oauthClientId: "kClient123", audience: "api.tailscale.com/kClient123" } });
  assert.equal((await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, updated, call(github))).changed, true);
  assert.equal(github.repos.get("Org/orquester-macos-boxes")!.files.get(BLACKSMITH_WORKFLOW_PATH)!.content, updated);

  github.repos.get("Org/orquester-macos-boxes")!.private = false;
  await assert.rejects(ensureControlRepo("Org", call(github)), /is public/);
});

test("waitWorkflowReady and dispatchBoxRun retry until GitHub has indexed the workflow", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(github));
  await ensureWorkflowFile(repo, BLACKSMITH_WORKFLOW_PATH, blacksmithWorkflowTemplate(), call(github));
  github.workflowGet404s = 2;
  assert.equal((await drive(t, waitWorkflowReady(repo.repository, BLACKSMITH_WORKFLOW_FILE, call(github)))).state, "active");

  github.dispatch404s = 1;
  github.dispatch422s = 1;
  const dispatched = await drive(
    t,
    dispatchBoxRun({ repository: repo.repository, workflowFile: BLACKSMITH_WORKFLOW_FILE, ref: "main", inputs }, call(github))
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
  const repo = await ensureControlRepo("Org", call(github));
  const request = { repository: repo.repository, workflowFile: BLACKSMITH_WORKFLOW_FILE, ref: "main" };
  await assert.rejects(dispatchBoxRun({ ...request, inputs: { ...inputs, runner: "ubuntu-latest" } }, call(github)), /not in the list of allowed values/);
  assert.equal(github.runs.size, 0);

  github.dispatchNoDetails = true;
  const found = await drive(t, dispatchBoxRun({ ...request, inputs }, call(github)));
  assert.equal(github.runs.get(found.runId)!.displayTitle, "orq-box-0123456789ab");
});

test("runs: get, list since, cancel and force-cancel", async () => {
  const github = new FakeGithub({ token: TOKEN });
  const repo = await ensureControlRepo("Org", call(github));
  const old = github.addRun({ displayTitle: "orq-box-old000000000", createdAt: "2026-10-01T00:00:00Z" });
  const live = github.addRun({ displayTitle: "orq-box-live00000000", cancellable: false });
  const recent = await listRecentRuns(repo.repository, BLACKSMITH_WORKFLOW_FILE, { ...call(github), since: new Date(Date.now() - 3600_000) });
  assert.deepEqual(recent.map((run) => run.id), [live.id]);
  assert.ok(old.id < live.id);

  assert.equal(await cancelRun(repo.repository, live.id, call(github)), true);
  assert.equal((await getRun(repo.repository, live.id, call(github)))!.status, "in_progress", "this cancel did not land");
  assert.equal(await forceCancelRun(repo.repository, live.id, call(github)), true);
  const done = (await getRun(repo.repository, live.id, call(github)))!;
  assert.deepEqual([done.status, done.conclusion], ["completed", "cancelled"]);
  assert.equal(await cancelRun(repo.repository, live.id, call(github)), false, "a completed run answers 409");
  assert.equal(await getRun(repo.repository, 12345, call(github)), null);
});
