import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { ionosAdapter } from "./ionos.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID, type ReplayRoute } from "./fixtures/vm-replay.ts";

const API = "https://api.ionos.com/cloudapi/v6";
const credentials = { token: "ionos-test-token" };
const DC = "11111111-1111-4111-8111-111111111111";
const DC2 = "11111111-1111-4111-8111-111111111112";
const SERVER = "22222222-2222-4222-8222-222222222222";
const REQUEST_URL = `${API}/requests/55555555-5555-4555-8555-555555555555/status`;
const ref = { datacenterId: DC, serverId: SERVER, location: "de/fra" };

function createRoutes(): ReplayRoute[] {
  return [
    { method: "GET", url: `${API}/locations?depth=1`, body: fixture("ionos", "locations") },
    { method: "POST", url: `${API}/datacenters`, status: 202, headers: { location: REQUEST_URL }, body: fixture("ionos", "datacenter-created") },
    { method: "GET", url: REQUEST_URL, body: fixture("ionos", "request-done"), times: 2 },
    { method: "POST", url: `${API}/datacenters/${DC}/labels`, status: 201, body: fixture("ionos", "label-created") },
    { method: "POST", url: `${API}/datacenters/${DC}/lans`, status: 202, headers: { location: REQUEST_URL }, body: fixture("ionos", "lan-created") }
  ];
}

// Expected USD examples are fixed to the captured catalog and bundled currency/licence assumptions.
test("validate: ok with a working token, IONOS's message for a bad or missing one", async () => {
  const url = `${API}/datacenters?depth=0&limit=1`;
  const replay = replayFetch([
    { method: "GET", url, body: { id: "datacenters", type: "collection", items: [] } },
    { method: "GET", url, status: 401, body: fixture("ionos", "error-unauthorized") }
  ]);
  assert.deepEqual(await ionosAdapter.validate(credentials, replayOptions(replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer ionos-test-token");

  const bad = await ionosAdapter.validate({ token: "wrong-token" }, replayOptions(replay));
  assert.deepEqual(bad, { ok: false, message: "IONOS Cloud: Unauthorized (check the key and its permissions)" });

  assert.deepEqual(await ionosAdapter.validate({}, replayOptions(replay)), { ok: false, message: "IONOS Cloud: API token is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers: curated vCPU sizes at table prices in the vCPU locations the account lists", async () => {
  const replay = replayFetch([{ method: "GET", url: `${API}/locations?depth=1`, body: fixture("ionos", "locations") }]);
  const offers = await ionosAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.equal(offers.priceSource, "table");

  // Karlsruhe and Las Vegas have no vCPU Servers; Frankfurt 2 and the rest are not in this account's list.
  assert.deepEqual(offers.regions, [
    { id: "de/fra", label: "Frankfurt (de/fra)", country: "DE" },
    { id: "de/txl", label: "Berlin (de/txl)", country: "DE" },
    { id: "us/ewr", label: "Newark (us/ewr)", country: "US" }
  ]);

  const small = offers.sizes.find((size) => size.id === "vcpu-2-4");
  assert.deepEqual(small, {
    id: "vcpu-2-4",
    label: "vCPU Server — 2 vCPU, 4 GB",
    vcpu: 2,
    ramGb: 4,
    diskGb: 30,
    gpu: null,
    hourlyUsd: 0.0405,
    regions: ["de/fra", "de/txl", "us/ewr"]
  });
  assert.equal(offers.sizes[0]!.id, "vcpu-1-2");
  const prices = offers.sizes.map((size) => size.hourlyUsd ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  // Ubuntu 24.04 first; installer ISOs, CentOS and Windows aliases are not offered.
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["ubuntu:24.04", "ubuntu:latest", "ubuntu:22.04", "debian:latest", "debian:12", "debian:11"]
  );
  assert.deepEqual(offers.images[1], { id: "ubuntu:latest", label: "Ubuntu (latest)" });

  await assert.rejects(ionosAdapter.offers(credentials, "windows", replayOptions(replayFetch([]))), /does not rent windows/);
});

test("create: a VDC named after the box, labels, a public LAN, then one server with its boot volume and NIC", async () => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${API}/datacenters/${DC}/servers`, status: 202, headers: { location: REQUEST_URL }, body: fixture("ionos", "server-created") }
  ]);
  const request = testCreateRequest({ size: "vcpu-2-4", region: "de/fra" });
  const result = await ionosAdapter.create(credentials, request, replayOptions(replay));

  const posts = replay.requests.filter((entry) => entry.method === "POST");
  assert.deepEqual(
    posts.map((entry) => [entry.url, entry.body]),
    [
      [`${API}/datacenters`, { properties: { name: `orq-${TEST_BOX_ID}`, description: `orquester-box=${TEST_BOX_ID}`, location: "de/fra" } }],
      [`${API}/datacenters/${DC}/labels`, { properties: { key: "orquester-box", value: TEST_BOX_ID } }],
      [`${API}/datacenters/${DC}/lans`, { properties: { name: `orq-${TEST_BOX_ID}`, public: true } }],
      [
        `${API}/datacenters/${DC}/servers`,
        {
          properties: { name: `orq-${TEST_BOX_ID}`, type: "VCPU", cores: 2, ram: 4096, availabilityZone: "AUTO" },
          entities: {
            volumes: {
              items: [
                {
                  properties: {
                    name: `orq-${TEST_BOX_ID}`,
                    type: "BALANCED",
                    size: 30,
                    imageAlias: "ubuntu:24.04",
                    sshKeys: [request.sshPublicKey],
                    userData: Buffer.from(request.bootstrap.cloudInit, "utf8").toString("base64")
                  }
                }
              ]
            },
            nics: { items: [{ properties: { name: `orq-${TEST_BOX_ID}`, lan: 1, dhcp: true, firewallActive: false } }] }
          }
        }
      ]
    ]
  );
  // The VDC and LAN requests are awaited; the server request is not.
  assert.equal(replay.requests.filter((entry) => entry.url === REQUEST_URL).length, 2);
  assert.equal(replay.requests.every((entry) => entry.headers.authorization === "Bearer ionos-test-token"), true);

  assert.deepEqual(result.ref, { datacenterId: DC, serverId: SERVER, location: "de/fra" });
  assert.equal(result.hourlyUsd, 0.0405);
});

test("create: an image or size the location cannot serve is refused before anything is created", async () => {
  const replay = replayFetch([{ method: "GET", url: `${API}/locations?depth=1`, body: fixture("ionos", "locations"), times: Infinity }]);
  // Newark lists no ubuntu:24.04: the default falls back to ubuntu:latest, an explicit 24.04 is refused.
  await assert.rejects(
    ionosAdapter.create(credentials, testCreateRequest({ size: "vcpu-2-4", region: "us/ewr", image: "ubuntu:24.04" }), replayOptions(replay)),
    /image ubuntu:24.04 is not available in us\/ewr/
  );
  await assert.rejects(
    ionosAdapter.create(credentials, testCreateRequest({ size: "vcpu-3-5", region: "de/fra" }), replayOptions(replay)),
    /unknown size vcpu-3-5/
  );
  await assert.rejects(
    ionosAdapter.create(credentials, testCreateRequest({ size: "vcpu-2-4", region: "us/las" }), replayOptions(replay)),
    /location us\/las offers no vCPU Servers/
  );
  assert.equal(replay.requests.some((entry) => entry.method !== "GET"), false);
});

test("create: the server POST is never retried; a failure deletes the VDC and surfaces IONOS's message", async () => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${API}/datacenters/${DC}/servers`, status: 500, body: fixture("ionos", "error-internal"), times: 2 },
    { method: "DELETE", url: `${API}/datacenters/${DC}`, status: 202 }
  ]);
  await assert.rejects(ionosAdapter.create(credentials, testCreateRequest({ size: "vcpu-2-4", region: "de/fra" }), replayOptions(replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "IONOS Cloud: An internal error occurred. Please try again later.");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.url.endsWith("/servers")).length, 1);
  assert.equal(replay.requests.at(-1)?.method, "DELETE");
  assert.equal(replay.requests.at(-1)?.url, `${API}/datacenters/${DC}`);
});

test("create: a failed VDC request deletes the VDC with the request's reason", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/locations?depth=1`, body: fixture("ionos", "locations") },
    { method: "POST", url: `${API}/datacenters`, status: 202, headers: { location: REQUEST_URL }, body: fixture("ionos", "datacenter-created") },
    { method: "GET", url: REQUEST_URL, body: fixture("ionos", "request-failed") },
    { method: "DELETE", url: `${API}/datacenters/${DC}`, status: 202 }
  ]);
  await assert.rejects(
    ionosAdapter.create(credentials, testCreateRequest({ size: "vcpu-2-4", region: "de/fra" }), replayOptions(replay)),
    /IONOS Cloud: creating the data center failed: \[VDC-1-1213\] Resource limit exceeded: cores/
  );
  assert.equal(replay.pending().length, 0);
});

test("status: maps vmState and metadata.state, 404 is gone, 429 is retried", async () => {
  const url = `${API}/datacenters/${DC}/servers/${SERVER}?depth=2`;
  const running = fixture<{ properties: Record<string, unknown>; metadata: Record<string, unknown> }>("ionos", "server-running");
  const replay = replayFetch([
    { method: "GET", url, status: 429, headers: { "retry-after": "0" }, body: fixture("ionos", "error-rate-limit") },
    { method: "GET", url, body: running },
    { method: "GET", url, body: fixture("ionos", "server-deploying") },
    { method: "GET", url, body: { ...running, properties: { ...running.properties, vmState: "SHUTOFF" } } },
    { method: "GET", url, body: { ...running, properties: { ...running.properties, vmState: "CRASHED" } } },
    { method: "GET", url, status: 404, body: fixture("ionos", "error-not-found") },
    { method: "GET", url: `${API}/datacenters/${DC}?depth=0`, status: 404, body: fixture("ionos", "error-not-found") }
  ]);
  assert.deepEqual(await ionosAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.30",
    hourlyUsd: null
  });
  const deploying = await ionosAdapter.status(credentials, ref, replayOptions(replay));
  assert.deepEqual([deploying.state, deploying.detail, deploying.publicIp], ["pending", "IONOS Cloud reports the server BUSY", null]);
  const off = await ionosAdapter.status(credentials, ref, replayOptions(replay));
  assert.deepEqual([off.state, off.detail], ["stopped", "IONOS Cloud reports the server SHUTOFF"]);
  assert.equal((await ionosAdapter.status(credentials, ref, replayOptions(replay))).state, "error");
  assert.deepEqual(await ionosAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "gone",
    detail: "The server no longer exists in IONOS Cloud",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
});

test("status: a data-center-only ref (from listManaged) is read through the data center; gone only with it", async () => {
  const servers = `${API}/datacenters/${DC}/servers?depth=1&offset=0&limit=100`;
  const server = `${API}/datacenters/${DC}/servers/${SERVER}?depth=2`;
  const datacenter = `${API}/datacenters/${DC}?depth=0`;
  const replay = replayFetch([
    { method: "GET", url: servers, body: fixture("ionos", "servers-in-datacenter") },
    { method: "GET", url: server, body: fixture("ionos", "server-running") },
    { method: "GET", url: servers, body: fixture("ionos", "servers-empty") },
    { method: "GET", url: servers, status: 404, body: fixture("ionos", "error-not-found") },
    // The server was deleted but its data center (and so its volume) is still there.
    { method: "GET", url: server, status: 404, body: fixture("ionos", "error-not-found") },
    { method: "GET", url: datacenter, body: fixture("ionos", "datacenter-created") }
  ]);
  const dcOnly = { datacenterId: DC, location: "de/fra" };
  assert.equal((await ionosAdapter.status(credentials, dcOnly, replayOptions(replay))).state, "running");
  assert.deepEqual(await ionosAdapter.status(credentials, dcOnly, replayOptions(replay)), {
    state: "error",
    detail: "The IONOS Cloud data center has no server",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal((await ionosAdapter.status(credentials, dcOnly, replayOptions(replay))).state, "gone");
  assert.equal((await ionosAdapter.status(credentials, ref, replayOptions(replay))).state, "error");
  assert.equal(replay.pending().length, 0);
});

test("destroy: deletes the VDC with everything in it, idempotent on 404", async () => {
  const replay = replayFetch([
    { method: "DELETE", url: `${API}/datacenters/${DC}`, status: 202, headers: { location: REQUEST_URL } },
    { method: "DELETE", url: `${API}/datacenters/${DC}`, status: 404, body: fixture("ionos", "error-not-found") }
  ]);
  await ionosAdapter.destroy(credentials, ref, replayOptions(replay));
  await ionosAdapter.destroy(credentials, { datacenterId: DC }, replayOptions(replay));
  assert.equal(replay.pending().length, 0);
  await assert.rejects(ionosAdapter.destroy(credentials, {}, replayOptions(replay)), /instance reference has no datacenterId/);
});

test("listManaged: VDCs named orq-<boxId>, with their server's state; one without a server is still listed", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/datacenters?depth=1&offset=0&limit=100`, body: fixture("ionos", "datacenters") },
    { method: "GET", url: `${API}/datacenters/${DC}/servers?depth=1&offset=0&limit=100`, body: fixture("ionos", "servers-in-datacenter") },
    { method: "GET", url: `${API}/datacenters/${DC2}/servers?depth=1&offset=0&limit=100`, body: fixture("ionos", "servers-empty") }
  ]);
  const managed = await ionosAdapter.listManaged(credentials, replayOptions(replay));
  assert.deepEqual(managed, [
    {
      ref: { datacenterId: DC, serverId: SERVER, location: "de/fra" },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { datacenterId: DC2, location: "gb/lhr" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "error"
    }
  ]);
  assert.equal(replay.pending().length, 0);
});
