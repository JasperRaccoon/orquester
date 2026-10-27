import assert from "node:assert/strict";
import { test } from "node:test";

import { civoAdapter } from "./civo.ts";
import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";

const API = "https://api.civo.com/v2";
const credentials = { apiKey: "civo-test-key" };
const INSTANCE_ID = "77777777-7777-4777-8777-000000000001";
const instanceUrl = `${API}/instances/${INSTANCE_ID}?region=LON1`;

function createRoutes(createStatus = 200, createBody: unknown = fixture("civo", "instance-created")) {
  return [
    { method: "GET", url: `${API}/disk_images?region=LON1`, body: fixture("civo", "disk-images") },
    { method: "GET", url: `${API}/networks?region=LON1`, body: fixture("civo", "networks") },
    { method: "GET", url: `${API}/sizes`, body: fixture("civo", "sizes") },
    { method: "POST", url: `${API}/instances`, status: createStatus, body: createBody, times: 2 }
  ];
}

// Expected USD examples are fixed to the captured catalog and bundled currency/licence assumptions.
test("validate: ok with a working key, Civo's reason for a bad or missing one", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/instances?page=1&per_page=1`, body: fixture("civo", "instances-empty") },
    { method: "GET", url: `${API}/instances?page=1&per_page=1`, status: 401, body: fixture("civo", "error-unauthorized") }
  ]);
  assert.deepEqual(await civoAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer civo-test-key");
  const bad = await civoAdapter.validate({ apiKey: "nope" }, replayOptions(t, replay));
  assert.deepEqual(bad, { ok: false, message: "Civo: Authentication failed, please check your API key (check the key and its permissions)" });
  assert.deepEqual(await civoAdapter.validate({}, replayOptions(t, replay)), { ok: false, message: "Civo: API key is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers: instance sizes with table prices, open regions, Ubuntu 24.04 first", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/regions`, body: fixture("civo", "regions") },
    { method: "GET", url: `${API}/sizes`, body: fixture("civo", "sizes") },
    // Image names are read from the account's default region.
    { method: "GET", url: `${API}/disk_images?region=FRA1`, body: fixture("civo", "disk-images") }
  ]);
  const offers = await civoAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "table");
  // No Kubernetes, database, GPU or non-selectable sizes; an unknown family has no price.
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd]),
    [
      ["g3.xsmall", 0.0074],
      ["g3.small", 0.0149],
      ["g3.medium", 0.0298],
      ["g3.large", 0.0595],
      ["g4m.small", 0.1071],
      ["g4c.small", 0.1905],
      ["g4z.huge", null]
    ]
  );
  assert.deepEqual(offers.sizes[1], {
    id: "g3.small",
    label: "g3.small — Small, 1 vCPU, 2 GB",
    vcpu: 1,
    ramGb: 2,
    diskGb: 25,
    gpu: null,
    hourlyUsd: 0.0149,
    regions: []
  });
  // NYC1 is out of capacity, MUM1 sells no compute.
  assert.deepEqual(offers.regions, [
    { id: "LON1", label: "London 1 (LON1)", country: "GB" },
    { id: "FRA1", label: "Frankfurt 1 (FRA1)", country: "DE" },
    { id: "PHX1", label: "Phoenix 1 (PHX1)", country: "US" }
  ]);
  // Available Ubuntu and Debian only.
  assert.deepEqual(offers.images, [
    { id: "ubuntu-noble", label: "Ubuntu 24.04 LTS" },
    { id: "ubuntu-jammy", label: "Ubuntu 22.04 LTS" },
    { id: "debian-12", label: "Debian 12" }
  ]);
  await assert.rejects(civoAdapter.offers(credentials, "linux-gpu", replayOptions(t, replayFetch([]))), /does not rent linux-gpu/);
});

test("create: resolves image and network in the region, one POST with hostname, tags and the shell script", async (t) => {
  const replay = replayFetch(createRoutes());
  const request = testCreateRequest({ size: "g3.small", region: "LON1" });
  const result = await civoAdapter.create(credentials, request, replayOptions(t, replay));
  const post = replay.requests.find((entry) => entry.method === "POST")!;
  assert.deepEqual(post.body, {
    hostname: `orq-${TEST_BOX_ID}`,
    size: "g3.small",
    region: "LON1",
    count: 1,
    template_id: "11111111-1111-4111-8111-000000000001",
    network_id: "22222222-2222-4222-8222-000000000001",
    public_ip: "create",
    initial_user: "civo",
    // Civo runs `script` as a root shell script at the end of cloud-init.
    script: request.bootstrap.posixScript,
    tags: `orquester-box orquester-box=${TEST_BOX_ID}`
  });
  assert.deepEqual(result, { ref: { instanceId: INSTANCE_ID, region: "LON1" }, hourlyUsd: 0.0149 });
  assert.equal(JSON.stringify(result).includes("redacted-password"), false);
});

test("create: a chosen image is looked up by name; an unknown one fails before anything is created", async (t) => {
  const replay = replayFetch(createRoutes());
  await civoAdapter.create(credentials, testCreateRequest({ size: "g3.small", region: "LON1", image: "debian-12" }), replayOptions(t, replay));
  assert.equal((replay.requests.find((entry) => entry.method === "POST")!.body as Record<string, unknown>).template_id, "11111111-1111-4111-8111-000000000003");

  const missing = replayFetch(createRoutes());
  await assert.rejects(
    civoAdapter.create(credentials, testCreateRequest({ size: "g3.small", region: "LON1", image: "ubuntu-focal" }), replayOptions(t, missing)),
    /Civo: no disk image ubuntu-focal in LON1/
  );
  assert.equal(missing.requests.some((entry) => entry.method === "POST"), false);
});

test("create: a failed create is never retried and surfaces Civo's reason", async (t) => {
  const replay = replayFetch(createRoutes(500, fixture("civo", "error-server")));
  await assert.rejects(civoAdapter.create(credentials, testCreateRequest({ size: "g3.small", region: "LON1" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "Civo: An unexpected error occurred, please try again later");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);
});

test("status: maps instance states, not found is gone, 429 is retried", async (t) => {
  const active = fixture<Record<string, unknown>>("civo", "instance-active");
  const replay = replayFetch([
    { method: "GET", url: instanceUrl, status: 429, headers: { "retry-after": "0" }, body: fixture("civo", "error-rate-limit") },
    { method: "GET", url: instanceUrl, body: active },
    { method: "GET", url: instanceUrl, body: fixture("civo", "instance-created") },
    { method: "GET", url: instanceUrl, body: { ...active, status: "SHUTOFF" } },
    { method: "GET", url: instanceUrl, body: { ...active, status: "FAILED" } },
    { method: "GET", url: instanceUrl, body: { ...active, status: "SOMETHING_NEW" } },
    { method: "GET", url: instanceUrl, status: 404, body: fixture("civo", "error-not-found") },
    // Civo's not-found code counts as gone whatever the status.
    { method: "GET", url: instanceUrl, status: 400, body: fixture("civo", "error-not-found") }
  ]);
  const ref = { instanceId: INSTANCE_ID, region: "LON1" };
  assert.deepEqual(await civoAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.10",
    hourlyUsd: null
  });
  assert.deepEqual(await civoAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "pending",
    detail: "Civo reports the instance BUILDING",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal((await civoAdapter.status(credentials, ref, replayOptions(t, replay))).state, "stopped");
  assert.equal((await civoAdapter.status(credentials, ref, replayOptions(t, replay))).state, "error");
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await civoAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  const gone = { state: "gone", detail: "The instance no longer exists in Civo", publicIp: null, hourlyUsd: null };
  assert.deepEqual(await civoAdapter.status(credentials, ref, replayOptions(t, replay)), gone);
  assert.deepEqual(await civoAdapter.status(credentials, ref, replayOptions(t, replay)), gone);
  assert.equal(replay.pending().length, 0);
  await assert.rejects(civoAdapter.status(credentials, { instanceId: INSTANCE_ID }, replayOptions(t, replay)), /instance reference has no region/);
});

test("destroy: deletes the instance in its region and is idempotent", async (t) => {
  const replay = replayFetch([
    { method: "DELETE", url: instanceUrl, body: fixture("civo", "delete-instance") },
    { method: "DELETE", url: instanceUrl, status: 404, body: fixture("civo", "error-not-found") },
    { method: "DELETE", url: instanceUrl, status: 400, body: fixture("civo", "error-not-found") },
    { method: "DELETE", url: instanceUrl, status: 403, body: fixture("civo", "error-unauthorized") }
  ]);
  const ref = { instanceId: INSTANCE_ID, region: "LON1" };
  await civoAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await civoAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await civoAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await assert.rejects(civoAdapter.destroy(credentials, ref, replayOptions(t, replay)), /^ProviderHttpError: Civo: Authentication failed/);
  assert.equal(replay.pending().length, 0);
});

test("listManaged: every compute region, pages followed, marked instances only", async (t) => {
  const lon1 = fixture<{ items: unknown[] }>("civo", "instances-lon1");
  const replay = replayFetch([
    { method: "GET", url: `${API}/regions`, body: fixture("civo", "regions") },
    { method: "GET", url: `${API}/instances?region=LON1&page=1&per_page=100`, body: { page: 1, per_page: 100, pages: 2, items: lon1.items.slice(0, 1) } },
    { method: "GET", url: `${API}/instances?region=LON1&page=2&per_page=100`, body: { page: 2, per_page: 100, pages: 2, items: lon1.items.slice(1) } },
    { method: "GET", url: `${API}/instances?region=FRA1&page=1&per_page=100`, body: fixture("civo", "instances-empty") },
    // Out of capacity for new instances, still listed.
    { method: "GET", url: `${API}/instances?region=NYC1&page=1&per_page=100`, body: fixture("civo", "instances-nyc1") },
    { method: "GET", url: `${API}/instances?region=PHX1&page=1&per_page=100`, body: fixture("civo", "instances-empty") }
  ]);
  assert.deepEqual(await civoAdapter.listManaged(credentials, replayOptions(t, replay)), [
    {
      ref: { instanceId: INSTANCE_ID, region: "LON1" },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { instanceId: "77777777-7777-4777-8777-000000000002", region: "NYC1" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
  assert.equal(replay.pending().length, 0);
});
