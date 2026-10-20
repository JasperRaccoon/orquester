import assert from "node:assert/strict";
import { test } from "node:test";

import { digitaloceanAdapter, gpuImageSlug } from "./digitalocean.ts";
import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";

const API = "https://api.digitalocean.com/v2";
const credentials = { token: "dop_v1_test_token" };
const SIZES_URL = `${API}/sizes?page=1&per_page=200`;
const REGIONS_URL = `${API}/regions?page=1&per_page=200`;
const dropletUrl = `${API}/droplets/300000001`;
const keyUrl = `${API}/account/keys/500000001`;

function readRoutes() {
  return [
    { method: "GET", url: SIZES_URL, body: fixture("digitalocean", "sizes") },
    { method: "GET", url: REGIONS_URL, body: fixture("digitalocean", "regions") }
  ];
}

function createRoutes(dropletStatus = 202, dropletBody: unknown = fixture("digitalocean", "create-droplet")) {
  return [
    { method: "GET", url: SIZES_URL, body: fixture("digitalocean", "sizes") },
    { method: "POST", url: `${API}/account/keys`, status: 201, body: fixture("digitalocean", "ssh-key-created") },
    { method: "POST", url: `${API}/droplets`, status: dropletStatus, body: dropletBody, times: 2 },
    { method: "DELETE", url: keyUrl, status: 204 }
  ];
}

test("validate: ok with a working token, the provider's message for a bad or missing one", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/droplets?per_page=1`, body: fixture("digitalocean", "droplets-empty") },
    { method: "GET", url: `${API}/droplets?per_page=1`, status: 401, body: fixture("digitalocean", "error-unauthorized") }
  ]);
  assert.deepEqual(await digitaloceanAdapter.validate(credentials, replayOptions(replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer dop_v1_test_token");
  const bad = await digitaloceanAdapter.validate({ token: "dop_v1_wrong" }, replayOptions(replay));
  assert.deepEqual(bad, { ok: false, message: "DigitalOcean: Unable to authenticate you (check the key and its permissions)" });
  assert.deepEqual(await digitaloceanAdapter.validate({}, replayOptions(replay)), { ok: false, message: "DigitalOcean: API token is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers linux: live prices, available regions only, no GPU or sub-1 GB sizes", async () => {
  const replay = replayFetch(readRoutes());
  const offers = await digitaloceanAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => size.id),
    ["s-1vcpu-1gb", "s-2vcpu-4gb", "g-2vcpu-8gb"]
  );
  // Singapore is not open for new Droplets: dropped from the size's regions.
  assert.deepEqual(offers.sizes[0], {
    id: "s-1vcpu-1gb",
    label: "s-1vcpu-1gb — Basic, 1 vCPU, 1 GB",
    vcpu: 1,
    ramGb: 1,
    diskGb: 25,
    gpu: null,
    hourlyUsd: 0.0089,
    regions: ["ams3", "fra1", "nyc1", "nyc3"]
  });
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["nyc1", "nyc3", "ams3", "fra1"]
  );
  assert.deepEqual(offers.regions[3], { id: "fra1", label: "Frankfurt 1 (fra1)", country: "DE" });
  assert.equal(offers.images[0]!.id, "ubuntu-24-04-x64");
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["ubuntu-24-04-x64", "ubuntu-22-04-x64", "debian-12-x64"]
  );
});

test("offers linux-gpu: only GPU plans with their GPU, the AI/ML-ready image", async () => {
  const replay = replayFetch(readRoutes());
  const offers = await digitaloceanAdapter.offers(credentials, "linux-gpu", replayOptions(replay));
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd]),
    [
      ["gpu-4000adax1-20gb", 0.76],
      ["gpu-mi300x1-192gb", 1.99],
      ["gpu-h100x1-80gb", 3.39],
      ["gpu-h100x8-640gb", 23.92]
    ]
  );
  const h100 = offers.sizes.find((size) => size.id === "gpu-h100x1-80gb")!;
  assert.deepEqual(h100.gpu, { model: "NVIDIA H100", count: 1, vramGb: 80 });
  assert.equal(h100.ramGb, 240);
  assert.deepEqual(h100.regions, ["nyc2", "tor1"]);
  assert.match(h100.label, /1× NVIDIA H100 80 GB/);
  // The 8-GPU plan's VRAM is shown per GPU.
  assert.deepEqual(offers.sizes.find((size) => size.id === "gpu-h100x8-640gb")!.gpu, { model: "NVIDIA H100", count: 8, vramGb: 80 });
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["nyc2", "tor1", "atl1", "sfo3"]
  );
  assert.deepEqual(offers.images, [{ id: "gpu-ai-ml-ready", label: "AI/ML-ready Ubuntu (GPU drivers and CUDA)" }]);
  await assert.rejects(digitaloceanAdapter.offers(credentials, "windows", replayOptions(replayFetch([]))), /does not rent windows/);
});

test("gpuImageSlug: the AI/ML-ready image per plan", () => {
  assert.equal(gpuImageSlug({ slug: "gpu-h100x1-80gb", gpu_info: { count: 1, model: "nvidia_h100" } }), "gpu-h100x1-base");
  assert.equal(gpuImageSlug({ slug: "gpu-4000adax1-20gb", gpu_info: { count: 1, model: "nvidia_rtx_4000_ada" } }), "gpu-h100x1-base");
  assert.equal(gpuImageSlug({ slug: "gpu-h100x8-640gb", gpu_info: { count: 8, model: "nvidia_h100" } }), "gpu-h100x8-base");
  assert.equal(gpuImageSlug({ slug: "gpu-mi300x1-192gb", gpu_info: { count: 1, model: "amd_mi300x" } }), "gpu-amd-base");
  // Without size details the slug decides.
  assert.equal(gpuImageSlug({ slug: "gpu-mi300x8-1536gb", gpu_info: null }), "gpu-amd-base");
  assert.equal(gpuImageSlug({ slug: "gpu-h200x8-1128gb", gpu_info: null }), "gpu-h100x8-base");
});

test("create: registers the box key, one Droplet POST with name, tags, cloud-init and the key", async () => {
  const replay = replayFetch(createRoutes());
  const request = testCreateRequest({ size: "s-1vcpu-1gb", region: "fra1" });
  const result = await digitaloceanAdapter.create(credentials, request, replayOptions(replay));

  const posts = replay.requests.filter((entry) => entry.method === "POST");
  assert.deepEqual(posts[0]!.body, { name: `orq-${TEST_BOX_ID}`, public_key: request.sshPublicKey });
  assert.deepEqual(posts[1]!.body, {
    name: `orq-${TEST_BOX_ID}`,
    region: "fra1",
    size: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    ssh_keys: [500000001],
    user_data: request.bootstrap.cloudInit,
    tags: ["orquester-box", `orquester-box:${TEST_BOX_ID}`],
    ipv6: true,
    monitoring: false,
    backups: false
  });
  assert.deepEqual(result, { ref: { dropletId: 300000001, region: "fra1", sshKeyId: "500000001" }, hourlyUsd: 0.0089 });
  // The key stays while the Droplet lives.
  assert.equal(replay.requests.some((entry) => entry.method === "DELETE"), false);
});

test("create linux-gpu: the AI/ML-ready image matching the plan", async () => {
  const replay = replayFetch(createRoutes());
  const request = testCreateRequest({ kind: "linux-gpu", size: "gpu-mi300x1-192gb", region: "atl1" });
  const result = await digitaloceanAdapter.create(credentials, request, replayOptions(replay));
  const droplet = replay.requests.find((entry) => entry.url === `${API}/droplets`)?.body as Record<string, unknown>;
  assert.equal(droplet.image, "gpu-amd-base");
  assert.equal(droplet.size, "gpu-mi300x1-192gb");
  assert.equal(result.hourlyUsd, 1.99);
});

test("create: a failed Droplet create is never retried, surfaces DO's message and removes the key", async () => {
  const replay = replayFetch(createRoutes(500, fixture("digitalocean", "error-server")));
  await assert.rejects(digitaloceanAdapter.create(credentials, testCreateRequest({ size: "s-1vcpu-1gb", region: "fra1" }), replayOptions(replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "DigitalOcean: Unexpected server-side error");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.url === `${API}/droplets`).length, 1);
  assert.equal(replay.requests.filter((entry) => entry.method === "DELETE" && entry.url === keyUrl).length, 1);
});

test("status: maps Droplet states, 404 is gone, 429 is retried", async () => {
  const active = fixture<{ droplet: Record<string, unknown> }>("digitalocean", "droplet-active");
  const replay = replayFetch([
    { method: "GET", url: dropletUrl, status: 429, headers: { "retry-after": "0" }, body: fixture("digitalocean", "error-rate-limit") },
    { method: "GET", url: dropletUrl, body: active },
    { method: "GET", url: dropletUrl, body: fixture("digitalocean", "create-droplet") },
    { method: "GET", url: dropletUrl, body: { droplet: { ...active.droplet, status: "off" } } },
    { method: "GET", url: dropletUrl, body: { droplet: { ...active.droplet, status: "something-new" } } },
    { method: "GET", url: dropletUrl, body: { droplet: { ...active.droplet, status: "archive" } } },
    { method: "GET", url: dropletUrl, status: 404, body: fixture("digitalocean", "error-not-found") }
  ]);
  const ref = { dropletId: 300000001, region: "fra1", sshKeyId: "500000001" };
  assert.deepEqual(await digitaloceanAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.10",
    hourlyUsd: null
  });
  const pending = await digitaloceanAdapter.status(credentials, ref, replayOptions(replay));
  assert.deepEqual(pending, { state: "pending", detail: "DigitalOcean reports the Droplet new", publicIp: null, hourlyUsd: null });
  assert.equal((await digitaloceanAdapter.status(credentials, ref, replayOptions(replay))).state, "stopped");
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await digitaloceanAdapter.status(credentials, ref, replayOptions(replay))).state, "pending");
  assert.equal((await digitaloceanAdapter.status(credentials, ref, replayOptions(replay))).state, "gone");
  const gone = await digitaloceanAdapter.status(credentials, ref, replayOptions(replay));
  assert.deepEqual(gone, { state: "gone", detail: "The Droplet no longer exists in DigitalOcean", publicIp: null, hourlyUsd: null });
  assert.equal(replay.pending().length, 0);
});

test("destroy: deletes the Droplet and its key, idempotent on 404", async () => {
  const replay = replayFetch([
    { method: "DELETE", url: dropletUrl, status: 204 },
    { method: "DELETE", url: keyUrl, status: 204 },
    { method: "DELETE", url: dropletUrl, status: 404, body: fixture("digitalocean", "error-not-found") },
    { method: "DELETE", url: keyUrl, status: 404, body: fixture("digitalocean", "error-not-found") }
  ]);
  const ref = { dropletId: 300000001, region: "fra1", sshKeyId: "500000001" };
  await digitaloceanAdapter.destroy(credentials, ref, replayOptions(replay));
  await digitaloceanAdapter.destroy(credentials, ref, replayOptions(replay));
  assert.equal(replay.pending().length, 0);
  await assert.rejects(digitaloceanAdapter.destroy(credentials, {}, replayOptions(replay)), /instance reference has no dropletId/);
});

test("destroy: a reconciled Droplet's key is found by the box name", async () => {
  const replay = replayFetch([
    { method: "DELETE", url: `${API}/droplets/300000002`, status: 204 },
    { method: "GET", url: `${API}/account/keys?page=1&per_page=200`, body: fixture("digitalocean", "ssh-keys") },
    { method: "DELETE", url: `${API}/account/keys/500000002`, status: 204 }
  ]);
  await digitaloceanAdapter.destroy(credentials, { dropletId: 300000002, region: "nyc3", sshKeyName: "orq-ffeeddccbbaa" }, replayOptions(replay));
  assert.equal(replay.pending().length, 0);
  // The owner's own key is never touched.
  assert.equal(replay.requests.some((entry) => entry.url.endsWith("/500000009")), false);
});

test("listManaged: filters by the orquester-box tag and follows pages", async () => {
  const managed = fixture<{ droplets: unknown[] }>("digitalocean", "droplets-managed");
  const replay = replayFetch([
    {
      method: "GET",
      url: `${API}/droplets?tag_name=orquester-box&page=1&per_page=200`,
      body: { droplets: managed.droplets.slice(0, 1), links: { pages: { next: `${API}/droplets?page=2&per_page=200&tag_name=orquester-box` } }, meta: { total: 2 } }
    },
    {
      method: "GET",
      url: `${API}/droplets?tag_name=orquester-box&page=2&per_page=200`,
      body: { droplets: managed.droplets.slice(1), links: { pages: { prev: `${API}/droplets?page=1&per_page=200&tag_name=orquester-box` } }, meta: { total: 2 } }
    }
  ]);
  assert.deepEqual(await digitaloceanAdapter.listManaged(credentials, replayOptions(replay)), [
    {
      ref: { dropletId: 300000001, region: "fra1", sshKeyName: `orq-${TEST_BOX_ID}` },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { dropletId: 300000002, region: "nyc3", sshKeyName: "orq-ffeeddccbbaa" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
});
