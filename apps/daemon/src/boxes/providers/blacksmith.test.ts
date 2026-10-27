import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { buildBootstrap } from "../bootstrap/bootstrap.ts";
import type { ProviderCreateRequest } from "../contracts.ts";
import { FakeGithub } from "../github/fake-github.ts";
import {
  BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH,
  BLACKSMITH_WORKFLOW_PATH,
  blacksmithWorkflowTemplate
} from "../github/workflow-template.ts";
import { BLACKSMITH_ADAPTER, deviceCacheWarmStatus, dispatchDeviceCacheWarm } from "./blacksmith.ts";

const TOKEN = "ghp_TESTTOKEN0123456789";
const signal = new AbortController().signal;
const credentials = { githubToken: TOKEN, org: "Org", repo: "Org/orquester-macos-boxes" };

/** Run a promise whose waits use mocked setTimeout: flush I/O, then advance the clock, until it settles. */
async function drive<T>(t: test.TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  while (!settled) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(2000);
  }
  return promise;
}

function setUp(t: test.TestContext): FakeGithub {
  const github = new FakeGithub({ token: TOKEN, org: "Org" });
  github.repos.set("Org/orquester-macos-boxes", {
    fullName: "Org/orquester-macos-boxes",
    private: true,
    defaultBranch: "main",
    files: new Map([[BLACKSMITH_WORKFLOW_PATH, { content: blacksmithWorkflowTemplate(), sha: "1".repeat(40) }]])
  });
  t.mock.method(globalThis, "fetch", github.fetch);
  return github;
}

function createRequest(overrides: Partial<ProviderCreateRequest> = {}): ProviderCreateRequest {
  return {
    boxId: "box-0123456789ab",
    name: "orq-box-0123456789ab",
    kind: "macos",
    size: "12vcpu",
    region: "blacksmith",
    image: "macos-15",
    tags: { "orquester-box": "box-0123456789ab" },
    bootstrap: buildBootstrap({
      boxId: "box-0123456789ab",
      daemonUrl: "https://orq.example.com:8443",
      bootstrapToken: "obt_unused-for-macos-0123",
      tailscaleAuthKey: null,
      container: false
    }),
    sshPublicKey: "ssh-ed25519 AAAA",
    windowsPassword: null,
    lifetimeMinutes: 120,
    ...overrides
  };
}

test("describes macOS M4 sizes, images and the 5-day limit without credential fields", async () => {
  assert.equal(BLACKSMITH_ADAPTER.id, "blacksmith");
  assert.deepEqual(BLACKSMITH_ADAPTER.kinds, ["macos", "linux"]);
  assert.deepEqual(BLACKSMITH_ADAPTER.credentialFields, []);
  assert.equal(BLACKSMITH_ADAPTER.maxLifetimeMinutes, 7200);
  const offers = await BLACKSMITH_ADAPTER.offers(credentials, "macos", { signal });
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.vcpu, size.hourlyUsd]),
    [
      ["6vcpu", 6, 4.8],
      ["12vcpu", 12, 9.6]
    ]
  );
  assert.deepEqual(offers.images.map((image) => image.id), ["macos-26", "macos-15", "macos-27"]);
  assert.equal(offers.priceSource, "table");
  assert.deepEqual((await BLACKSMITH_ADAPTER.offers(credentials, "windows", { signal })).sizes, []);
  assert.deepEqual((await BLACKSMITH_ADAPTER.offers(credentials, "linux-gpu", { signal })).sizes, []);
});

test("describes x64 Linux sizes at $0.004 per 2 vCPU-minute and the Ubuntu 24.04 image", async () => {
  const offers = await BLACKSMITH_ADAPTER.offers(credentials, "linux", { signal });
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.vcpu, size.ramGb, size.hourlyUsd]),
    [
      ["2vcpu", 2, 8, 0.24],
      ["4vcpu", 4, 16, 0.48],
      ["8vcpu", 8, 32, 0.96],
      ["16vcpu", 16, 64, 1.92],
      ["32vcpu", 32, 128, 3.84]
    ]
  );
  assert.deepEqual(offers.images.map((image) => image.id), ["ubuntu-2404"]);
  assert.deepEqual(offers.regions.map((region) => region.id), ["blacksmith"]);
});

test("validate checks the account and the control repo without throwing", async (t) => {
  const github = setUp(t);
  assert.deepEqual(await BLACKSMITH_ADAPTER.validate(credentials, { signal }), { ok: true });
  const missing = await BLACKSMITH_ADAPTER.validate({}, { signal });
  assert.equal(missing.ok, false);
  const badToken = await BLACKSMITH_ADAPTER.validate({ ...credentials, githubToken: "nope" }, { signal });
  assert.deepEqual(badToken, { ok: false, message: "GitHub rejected the Git hosting account's token" });
  github.repos.clear();
  assert.match(((await BLACKSMITH_ADAPTER.validate(credentials, { signal })) as { message: string }).message, /does not exist yet/);
});

test("create dispatches a run named orq-<boxId> with only non-secret inputs", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = setUp(t);
  const result = await drive(t, BLACKSMITH_ADAPTER.create(credentials, createRequest(), { signal }));
  const run = [...github.runs.values()][0]!;
  assert.deepEqual(run.inputs, {
    box_id: "box-0123456789ab",
    lifetime_minutes: "120",
    daemon_url: "https://orq.example.com:8443",
    runner: "blacksmith-12vcpu-macos-15",
    os: "macos",
    prepare: "none"
  });
  assert.equal(run.displayTitle, "orq-box-0123456789ab");
  assert.deepEqual(result.ref, {
    repository: "Org/orquester-macos-boxes",
    runId: String(run.id),
    workflowFile: "orquester-box.yml",
    runner: "blacksmith-12vcpu-macos-15",
    htmlUrl: `https://github.com/x/actions/runs/${run.id}`
  });
  assert.equal(result.hourlyUsd, 9.6);
  assert.equal(result.deadlineAt, "2026-10-20T14:00:00.000Z");

  const clamped = await drive(
    t,
    BLACKSMITH_ADAPTER.create(credentials, createRequest({ lifetimeMinutes: 99_999, image: null, size: "6vcpu" }), { signal })
  );
  const second = github.runs.get(Number(clamped.ref.runId))!;
  assert.equal(second.inputs.lifetime_minutes, "7200");
  assert.equal(second.inputs.runner, "blacksmith-6vcpu-macos-26");

  await assert.rejects(BLACKSMITH_ADAPTER.create(credentials, createRequest({ size: "huge" }), { signal }), /unknown size/);
  await assert.rejects(BLACKSMITH_ADAPTER.create(credentials, createRequest({ kind: "windows" }), { signal }), /macOS and Linux boxes only/);
  await assert.rejects(BLACKSMITH_ADAPTER.create(credentials, createRequest({ kind: "linux" }), { signal }), /unknown Linux size 12vcpu/);
  // Nothing in the dispatch carries the GitHub token or the bootstrap token.
  const dispatches = JSON.stringify(github.calls.filter((entry) => entry.path.endsWith("/dispatches")));
  assert.ok(!dispatches.includes(TOKEN) && !dispatches.includes("obt_unused"));
});

test("create rents a Linux box (linux-x64 orq-agent, KVM) and a device host that restores the caches", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = setUp(t);
  const options = { signal };
  const linux = await drive(t, BLACKSMITH_ADAPTER.create(credentials, createRequest({ kind: "linux", size: "16vcpu", image: null }), options));
  const run = github.runs.get(Number(linux.ref.runId))!;
  assert.deepEqual(run.inputs, {
    box_id: "box-0123456789ab",
    lifetime_minutes: "120",
    daemon_url: "https://orq.example.com:8443",
    runner: "blacksmith-16vcpu-ubuntu-2404",
    os: "linux",
    prepare: "none"
  });
  assert.equal(linux.ref.runner, "blacksmith-16vcpu-ubuntu-2404");
  assert.equal(linux.hourlyUsd, 1.92);

  const host = await drive(t, BLACKSMITH_ADAPTER.create(credentials, createRequest({ kind: "linux", size: "8vcpu", image: "ubuntu-2404", prepare: "devices" }), options));
  assert.deepEqual([github.runs.get(Number(host.ref.runId))!.inputs.prepare, host.hourlyUsd], ["devices", 0.96]);
  const mac = await drive(t, BLACKSMITH_ADAPTER.create(credentials, createRequest({ prepare: "devices" }), options));
  assert.deepEqual(github.runs.get(Number(mac.ref.runId))!.inputs.prepare, "devices");

  await assert.rejects(BLACKSMITH_ADAPTER.create(credentials, createRequest({ kind: "linux", size: "8vcpu", image: "macos-26" }), options), /unknown Linux image/);
  await assert.rejects(BLACKSMITH_ADAPTER.create(credentials, createRequest({ size: "8vcpu" }), options), /unknown size 8vcpu/);
});

test("create re-commits workflows whose content changed before it dispatches (old orgs gain the new inputs)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = setUp(t);
  const files = github.repos.get("Org/orquester-macos-boxes")!.files;
  // Set up by an older build: a box workflow without os/prepare, no device-cache workflow.
  const old = "name: Orquester box\non:\n  workflow_dispatch:\n    inputs:\n      box_id: {}\n      lifetime_minutes: {}\n      daemon_url: {}\n      runner: {}\n";
  files.set(BLACKSMITH_WORKFLOW_PATH, { content: old, sha: "0".repeat(40) });
  await drive(t, BLACKSMITH_ADAPTER.create(credentials, createRequest({ kind: "linux", size: "4vcpu", image: null }), { signal }));
  const workflow = parseYaml(files.get(BLACKSMITH_WORKFLOW_PATH)!.content) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, string> }> }>;
  };
  assert.ok(workflow.on.workflow_dispatch.inputs.os);
  assert.ok(workflow.on.workflow_dispatch.inputs.prepare);
  assert.ok(parseYaml(files.get(BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH)!.content).on.workflow_dispatch.inputs.request_id);

  // Up to date: no write before the next dispatch.
  const before = github.calls.length;
  await drive(t, BLACKSMITH_ADAPTER.create(credentials, createRequest(), { signal }));
  assert.equal(github.calls.slice(before).some((entry) => entry.method === "PUT" && entry.path.includes("/contents/")), false);

  // The setup's Tailscale join travels in the credentials: the template keeps its step.
  const join = { ...credentials, tailscaleClientId: "kClient123", tailscaleAudience: "api.tailscale.com/kClient123" };
  await drive(t, BLACKSMITH_ADAPTER.create(join, createRequest(), { signal }));
  const joined = parseYaml(files.get(BLACKSMITH_WORKFLOW_PATH)!.content) as typeof workflow;
  const tailscale = Object.values(joined.jobs).flatMap((job) => job.steps).find((step) => step.uses?.startsWith("tailscale/github-action@"));
  assert.equal(tailscale?.with?.["oauth-client-id"], "kClient123");
  assert.equal(tailscale?.with?.audience, "api.tailscale.com/kClient123");
});

test("dispatchDeviceCacheWarm starts the device-cache workflow; deviceCacheWarmStatus follows it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = setUp(t);
  const options = { signal };
  const linux = await drive(t, dispatchDeviceCacheWarm(credentials, { os: "linux" }, options));
  const run = github.runs.get(Number(linux.runId))!;
  assert.equal(run.workflowFile, "orquester-device-cache.yml");
  assert.equal(run.inputs.os, "linux");
  assert.equal(run.inputs.runner, "blacksmith-8vcpu-ubuntu-2404");
  assert.match(run.inputs.request_id!, /^[0-9a-f-]{36}$/);
  assert.equal(run.displayTitle, `orq-cache-linux-${run.inputs.request_id}`);
  assert.equal(linux.runner, "blacksmith-8vcpu-ubuntu-2404");

  const mac = await drive(t, dispatchDeviceCacheWarm(credentials, { os: "macos", size: "12vcpu" }, options));
  assert.equal(github.runs.get(Number(mac.runId))!.inputs.runner, "blacksmith-12vcpu-macos-26");
  await assert.rejects(dispatchDeviceCacheWarm(credentials, { os: "linux", size: "6vcpu" }, options), /unknown Linux size/);
  await assert.rejects(dispatchDeviceCacheWarm(credentials, { os: "windows" as "linux" }, options), /unknown OS/);

  assert.deepEqual(await deviceCacheWarmStatus(credentials, linux.runId, options), {
    runId: linux.runId,
    state: "queued",
    conclusion: null,
    htmlUrl: `https://github.com/x/actions/runs/${linux.runId}`
  });
  run.status = "in_progress";
  assert.equal((await deviceCacheWarmStatus(credentials, linux.runId, options)).state, "running");
  run.status = "completed";
  run.conclusion = "success";
  const completed = await deviceCacheWarmStatus(credentials, linux.runId, options);
  assert.deepEqual(
    [completed.state, completed.conclusion],
    ["completed", "success"]
  );
  assert.equal((await deviceCacheWarmStatus(credentials, "1", options)).state, "gone");
  // Box listing never shows cache runs.
  assert.deepEqual(await BLACKSMITH_ADAPTER.listManaged(credentials, options), []);
});

test("status follows the run and its job", async (t) => {
  const github = setUp(t);
  const options = { signal };
  const run = github.addRun({ displayTitle: "orq-box-0123456789ab", status: "in_progress", jobStatus: "queued" });
  const ref = { repository: "Org/orquester-macos-boxes", runId: String(run.id) };
  assert.deepEqual(await BLACKSMITH_ADAPTER.status(credentials, ref, options), {
    state: "pending",
    detail: "Waiting for a Blacksmith macOS runner",
    publicIp: null,
    hourlyUsd: null
  });
  run.jobStatus = "in_progress";
  assert.equal((await BLACKSMITH_ADAPTER.status(credentials, ref, options)).state, "running");
  run.status = "completed";
  run.conclusion = "timed_out";
  assert.deepEqual(await BLACKSMITH_ADAPTER.status(credentials, ref, options), { state: "gone", detail: "macOS time limit reached", publicIp: null, hourlyUsd: null });
  assert.equal((await BLACKSMITH_ADAPTER.status(credentials, { ...ref, runId: "1" }, options)).state, "gone");
  await assert.rejects(BLACKSMITH_ADAPTER.status(credentials, {}, options), /no workflow run reference/);
});

test("destroy cancels, force-cancels a run that does not stop, and is idempotent", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-20T12:00:00Z") });
  const github = setUp(t);
  const options = { signal };
  const easy = github.addRun({ displayTitle: "orq-box-easy00000000" });
  await drive(t, BLACKSMITH_ADAPTER.destroy(credentials, { repository: "Org/orquester-macos-boxes", runId: String(easy.id) }, options));
  assert.equal(easy.conclusion, "cancelled");
  assert.equal(github.calls.filter((entry) => entry.path.endsWith("/force-cancel")).length, 0);

  const stuck = github.addRun({ displayTitle: "orq-box-stuck0000000", cancellable: false });
  await drive(t, BLACKSMITH_ADAPTER.destroy(credentials, { repository: "Org/orquester-macos-boxes", runId: String(stuck.id) }, options));
  assert.equal(stuck.status, "completed");
  assert.equal(github.calls.filter((entry) => entry.path.endsWith("/force-cancel")).length, 1);

  // Already gone, or never existed: resolves without calls to cancel.
  const before = github.calls.length;
  await BLACKSMITH_ADAPTER.destroy(credentials, { repository: "Org/orquester-macos-boxes", runId: String(stuck.id) }, options);
  await BLACKSMITH_ADAPTER.destroy(credentials, { repository: "Org/orquester-macos-boxes", runId: "1" }, options);
  assert.equal(github.calls.slice(before).filter((entry) => entry.method === "POST").length, 0);
});

test("a run 404 behind a control repo the token cannot see is not gone", async (t) => {
  const github = setUp(t);
  const options = { signal };
  const run = github.addRun({ displayTitle: "orq-box-0123456789ab", status: "in_progress", jobStatus: "in_progress" });
  const ref = { repository: "Org/orquester-macos-boxes", runId: String(run.id) };
  // Access removed (GitHub then answers 404 for the repo and its runs alike).
  github.repos.delete("Org/orquester-macos-boxes");
  await assert.rejects(BLACKSMITH_ADAPTER.status(credentials, ref, options), /control repo Org\/orquester-macos-boxes is not visible/);
  await assert.rejects(BLACKSMITH_ADAPTER.destroy(credentials, ref, options), /cannot be confirmed/);
});

test("listManaged returns the active orq- runs", async (t) => {
  const github = setUp(t);
  const live = github.addRun({ displayTitle: "orq-box-live00000000", status: "in_progress" });
  const queued = github.addRun({ displayTitle: "orq-box-queued000000", status: "queued" });
  github.addRun({ displayTitle: "orq-box-done00000000", status: "completed", conclusion: "success" });
  github.addRun({ displayTitle: "someone else's run", status: "in_progress" });
  const managed = await BLACKSMITH_ADAPTER.listManaged(credentials, { signal });
  assert.deepEqual(
    managed.map((instance) => [instance.name, instance.boxId, instance.state, instance.ref.runId]),
    [
      ["orq-box-queued000000", "box-queued000000", "pending", String(queued.id)],
      ["orq-box-live00000000", "box-live00000000", "running", String(live.id)]
    ]
  );
});
