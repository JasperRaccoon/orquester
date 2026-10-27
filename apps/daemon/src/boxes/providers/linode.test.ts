import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { linodeAdapter } from "./linode.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";

const API = "https://api.linode.com/v4";
const credentials = { token: "linode-test-token" };
const instanceUrl = `${API}/linode/instances/600000001`;

function readRoutes() {
  return [
    { method: "GET", url: `${API}/linode/types?page=1&page_size=500`, body: fixture("linode", "types") },
    { method: "GET", url: `${API}/regions?page=1&page_size=500`, body: fixture("linode", "regions") },
    { method: "GET", url: `${API}/regions/availability?page=1&page_size=500`, body: fixture("linode", "availability") }
  ];
}

test("validate: ok with a working token, Linode's reason for a bad or missing one", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/linode/instances?page=1&page_size=25`, body: fixture("linode", "instances-empty") },
    { method: "GET", url: `${API}/linode/instances?page=1&page_size=25`, status: 401, body: fixture("linode", "error-unauthorized") }
  ]);
  assert.deepEqual(await linodeAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer linode-test-token");
  const bad = await linodeAdapter.validate({ token: "wrong-token" }, replayOptions(t, replay));
  assert.deepEqual(bad, { ok: false, message: "Linode: Invalid Token (check the key and its permissions)" });
  assert.deepEqual(await linodeAdapter.validate({ token: "" }, replayOptions(t, replay)), { ok: false, message: "Linode: API token is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers linux: live prices per regional price, Metadata core regions only, no GPU or accelerated plans", async (t) => {
  const replay = replayFetch(readRoutes());
  const offers = await linodeAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["g6-nanode-1", 0.0075, ["us-east", "us-ord", "eu-central"]],
      ["g6-nanode-1@id-cgk", 0.009, ["id-cgk"]],
      ["g6-nanode-1@br-gru", 0.0105, ["br-gru"]],
      ["g6-standard-2", 0.036, ["us-east", "us-ord", "eu-central"]],
      ["g6-standard-2@id-cgk", 0.043, ["id-cgk"]],
      ["g6-standard-2@br-gru", 0.05, ["br-gru"]],
      ["g6-dedicated-2", 0.054, ["us-east", "us-ord", "eu-central", "id-cgk", "br-gru"]],
      // Premium plans only where the region has "Premium Plans" (Paris is in an outage).
      ["g7-premium-2", 0.0645, ["us-east", "us-ord"]]
    ]
  );
  assert.deepEqual(
    { ...offers.sizes[0]!, regions: [] },
    { id: "g6-nanode-1", label: "Nanode 1GB — 1 vCPU, 1 GB", vcpu: 1, ramGb: 1, diskGb: 25, gpu: null, hourlyUsd: 0.0075, regions: [] }
  );
  // No Singapore (no Metadata service), no distributed edge site, no region in an outage.
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["us-east", "us-ord", "eu-central", "id-cgk", "br-gru"]
  );
  assert.deepEqual(offers.regions[2], { id: "eu-central", label: "Frankfurt, DE (eu-central)", country: "DE" });
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["linode/ubuntu24.04", "linode/ubuntu22.04", "linode/debian12"]
  );
});

test("offers linux-gpu: GPU plans in GPU regions, sold-out regions dropped", async (t) => {
  const replay = replayFetch(readRoutes());
  const offers = await linodeAdapter.offers(credentials, "linux-gpu", replayOptions(t, replay));
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions, size.gpu]),
    [
      ["g2-gpu-rtx4000a1-s", 0.52, ["us-east", "eu-central"], { model: "NVIDIA RTX 4000 Ada", count: 1, vramGb: 20 }],
      ["g1-gpu-rtx6000-1", 1.5, ["us-east", "us-ord", "eu-central"], { model: "NVIDIA Quadro RTX 6000", count: 1, vramGb: 24 }]
    ]
  );
  assert.equal(offers.sizes[1]!.diskGb, 640);
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["us-east", "us-ord", "eu-central"]
  );
  await assert.rejects(linodeAdapter.offers(credentials, "windows", replayOptions(t, replayFetch([]))), /does not rent windows/);
});

test("create: one POST with label, tags, base64 cloud-init, the box key and a throwaway root password", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/linode/types/g6-nanode-1`, body: fixture("linode", "type-nanode") },
    { method: "POST", url: `${API}/linode/instances`, body: fixture("linode", "instance-created") }
  ]);
  const request = testCreateRequest({ size: "g6-nanode-1@id-cgk", region: "id-cgk" });
  const result = await linodeAdapter.create(credentials, request, replayOptions(t, replay));
  const post = replay.requests.find((entry) => entry.method === "POST")!;
  const body = post.body as Record<string, unknown>;
  const rootPass = body.root_pass as string;
  assert.ok(typeof rootPass === "string" && rootPass.length >= 32 && rootPass.length <= 128);
  assert.deepEqual(body, {
    label: `orq-${TEST_BOX_ID}`,
    type: "g6-nanode-1",
    region: "id-cgk",
    image: "linode/ubuntu24.04",
    root_pass: rootPass,
    authorized_keys: [request.sshPublicKey],
    tags: ["orquester-box", `orquester-box=${TEST_BOX_ID}`],
    metadata: { user_data: Buffer.from(request.bootstrap.cloudInit, "utf8").toString("base64") },
    booted: true,
    backups_enabled: false
  });
  // The regional price, and the password is never handed back.
  assert.deepEqual(result, { ref: { linodeId: 600000001, region: "id-cgk" }, hourlyUsd: 0.009 });
  assert.equal(JSON.stringify(result).includes(rootPass), false);

  // Each box gets a fresh password.
  const again = replayFetch([
    { method: "GET", url: `${API}/linode/types/g6-nanode-1`, body: fixture("linode", "type-nanode") },
    { method: "POST", url: `${API}/linode/instances`, body: fixture("linode", "instance-created") }
  ]);
  await linodeAdapter.create(credentials, request, replayOptions(t, again));
  assert.notEqual((again.requests[1]!.body as Record<string, unknown>).root_pass, rootPass);
});

test("create: a failed create is never retried and surfaces Linode's reasons", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/linode/types/g6-nanode-1`, body: fixture("linode", "type-nanode") },
    { method: "POST", url: `${API}/linode/instances`, status: 500, body: fixture("linode", "error-server"), times: 2 }
  ]);
  await assert.rejects(linodeAdapter.create(credentials, testCreateRequest({ size: "g6-nanode-1", region: "us-east" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "Linode: Linode busy.");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);

  const invalid = replayFetch([
    { method: "GET", url: `${API}/linode/types/g6-nanode-1`, status: 404, body: fixture("linode", "error-not-found") },
    { method: "POST", url: `${API}/linode/instances`, status: 400, body: fixture("linode", "error-validation") }
  ]);
  await assert.rejects(
    linodeAdapter.create(credentials, testCreateRequest({ size: "g6-nanode-1", region: "ap-south" }), replayOptions(t, invalid)),
    /^ProviderHttpError: Linode: region: Region does not support Metadata\.$/
  );
});

test("status: maps instance states, 404 is gone, 429 is retried", async (t) => {
  const running = fixture<Record<string, unknown>>("linode", "instance-running");
  const replay = replayFetch([
    { method: "GET", url: instanceUrl, status: 429, headers: { "retry-after": "0" }, body: fixture("linode", "error-rate-limit") },
    { method: "GET", url: instanceUrl, body: running },
    { method: "GET", url: instanceUrl, body: fixture("linode", "instance-created") },
    { method: "GET", url: instanceUrl, body: { ...running, status: "shutting_down" } },
    { method: "GET", url: instanceUrl, body: { ...running, status: "billing_suspension" } },
    { method: "GET", url: instanceUrl, status: 404, body: fixture("linode", "error-not-found") }
  ]);
  const ref = { linodeId: 600000001, region: "us-east" };
  // The private 192.168/16 address is skipped.
  assert.deepEqual(await linodeAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.10",
    hourlyUsd: null
  });
  assert.equal((await linodeAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  const stopping = await linodeAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.deepEqual([stopping.state, stopping.detail], ["stopped", "Linode reports the instance shutting down"]);
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await linodeAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  assert.deepEqual(await linodeAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "gone",
    detail: "The instance no longer exists in Akamai Cloud",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
});

test("destroy: deletes the instance and is idempotent", async (t) => {
  const replay = replayFetch([
    { method: "DELETE", url: instanceUrl, body: {} },
    { method: "DELETE", url: instanceUrl, status: 404, body: fixture("linode", "error-not-found") }
  ]);
  const ref = { linodeId: 600000001, region: "us-east" };
  await linodeAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await linodeAdapter.destroy(credentials, ref, replayOptions(t, replay));
  assert.equal(replay.pending().length, 0);
  await assert.rejects(linodeAdapter.destroy(credentials, {}, replayOptions(t, replay)), /instance reference has no linodeId/);
});

test("listManaged: X-Filter on the tag, pages followed, only marked instances", async (t) => {
  const managed = fixture<{ data: unknown[] }>("linode", "instances-managed");
  const replay = replayFetch([
    { method: "GET", url: `${API}/linode/instances?page=1&page_size=500`, body: { data: managed.data.slice(0, 2), page: 1, pages: 2, results: 3 } },
    { method: "GET", url: `${API}/linode/instances?page=2&page_size=500`, body: { data: managed.data.slice(2), page: 2, pages: 2, results: 3 } }
  ]);
  const result = await linodeAdapter.listManaged(credentials, replayOptions(t, replay));
  assert.equal(replay.requests[0]!.headers["x-filter"], '{"tags":"orquester-box"}');
  assert.deepEqual(result, [
    {
      ref: { linodeId: 600000001, region: "us-east" },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { linodeId: 600000002, region: "eu-central" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
});
