import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID, type ReplayRoute } from "./fixtures/vm-replay.ts";
import { EUR_TO_USD, roundUsd, SCALEWAY_BLOCK_EUR_PER_GB_HOUR, SCALEWAY_IPV4_EUR_PER_HOUR } from "./price-tables.ts";
import { scalewayAdapter } from "./scaleway.ts";

const API = "https://api.scaleway.com";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const credentials = { secretKey: "scw-test-secret-key", projectId: PROJECT };
const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const VOLUME_ID = "44444444-4444-4444-8444-444444444444";
const ZONES = ["fr-par-1", "fr-par-2", "fr-par-3", "nl-ams-1", "nl-ams-2", "nl-ams-3", "pl-waw-1", "pl-waw-2", "pl-waw-3", "it-mil-1"];
const WITH_FIXTURES = new Set(["fr-par-1", "fr-par-2", "fr-par-3"]);

const zoneApi = (zone: string): string => `${API}/instance/v1/zones/${zone}`;
const serverUrl = `${zoneApi("fr-par-1")}/servers/${SERVER_ID}`;
const ref = { serverId: SERVER_ID, zone: "fr-par-1", volumeIds: [VOLUME_ID] };

function linuxEur(hourly: number, rootGb: number): number {
  return roundUsd((hourly + rootGb * SCALEWAY_BLOCK_EUR_PER_GB_HOUR + SCALEWAY_IPV4_EUR_PER_HOUR) * EUR_TO_USD);
}

function mapPage(name: string): { body: unknown; headers: Record<string, string> } {
  const body = fixture<{ servers: Record<string, unknown> }>("scaleway", name);
  return { body, headers: { "x-total-count": String(Object.keys(body.servers).length) } };
}

/** Catalog reads for every zone; the zones without fixtures stock nothing. */
function catalogRoutes(): ReplayRoute[] {
  const routes: ReplayRoute[] = [];
  for (const zone of ZONES) {
    const products = WITH_FIXTURES.has(zone) ? mapPage(`products-servers-${zone}`) : { body: { servers: {} }, headers: { "x-total-count": "0" } };
    const levels = WITH_FIXTURES.has(zone) ? mapPage(`availability-${zone}`) : { body: { servers: {} }, headers: { "x-total-count": "0" } };
    routes.push(
      { method: "GET", url: `${zoneApi(zone)}/products/servers?page=1&per_page=100`, ...products },
      { method: "GET", url: `${zoneApi(zone)}/products/servers/availability?page=1&per_page=100`, ...levels }
    );
  }
  routes.push({ method: "GET", url: `${API}/marketplace/v2/images?arch=x86_64&page=1&page_size=100`, body: fixture("scaleway", "marketplace-images") });
  return routes;
}

function createRoutes(): ReplayRoute[] {
  return [
    { method: "GET", url: `${zoneApi("fr-par-1")}/products/servers?page=1&per_page=100`, ...mapPage("products-servers-fr-par-1") },
    {
      method: "GET",
      url: `${API}/marketplace/v2/local-images?image_label=ubuntu_noble&zone=fr-par-1&type=instance_sbs&page=1&page_size=100`,
      body: fixture("scaleway", "local-images-ubuntu-noble")
    }
  ];
}

test("validate: ok with a working key, a message for a bad key or missing fields", async () => {
  const url = `${zoneApi("fr-par-1")}/servers?project=${PROJECT}&per_page=1`;
  const replay = replayFetch([
    { method: "GET", url, body: fixture("scaleway", "servers-empty") },
    { method: "GET", url, status: 401, body: fixture("scaleway", "error-unauthorized") }
  ]);
  assert.deepEqual(await scalewayAdapter.validate(credentials, replayOptions(replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers["x-auth-token"], "scw-test-secret-key");

  const bad = await scalewayAdapter.validate({ ...credentials, secretKey: "wrong-secret" }, replayOptions(replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /^Scaleway: authentication is denied/);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /wrong-secret/);

  assert.deepEqual(await scalewayAdapter.validate({ projectId: PROJECT }, replayOptions(replay)), {
    ok: false,
    message: "Scaleway: Secret key is missing"
  });
  assert.deepEqual(await scalewayAdapter.validate({ secretKey: "k" }, replayOptions(replay)), {
    ok: false,
    message: "Scaleway: Project ID is missing"
  });
  const notUuid = await scalewayAdapter.validate({ secretKey: "k", projectId: "my-project" }, replayOptions(replay));
  assert.match(!notUuid.ok ? notUuid.message : "", /Project ID must be a UUID/);
  assert.equal(replay.requests.length, 2);
});

test("offers: live per-zone prices plus block volume and IPv4, no Windows, GPU or end-of-service types for linux", async () => {
  const replay = replayFetch(catalogRoutes());
  const offers = await scalewayAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.equal(offers.priceSource, "table");

  const ids = offers.sizes.map((size) => size.id);
  for (const excluded of ["POP2-2C-8G-WIN", "L4-1-24G", "H100-1-80G", "DEV1-S", "POP2-HC-64C-128G"]) {
    assert.equal(ids.some((id) => id.startsWith(excluded)), false, `${excluded} not offered`);
  }

  // POP2-2C-8G costs more in fr-par-3: one offer per price, the dearer one with a suffixed id.
  const pop2 = offers.sizes.filter((size) => size.id.startsWith("POP2-2C-8G"));
  assert.deepEqual(
    pop2.map((size) => [size.id, size.regions, size.hourlyUsd]),
    [
      ["POP2-2C-8G", ["fr-par-1", "fr-par-2"], linuxEur(0.0735, 20)],
      ["POP2-2C-8G@fr-par-3", ["fr-par-3"], linuxEur(0.11025, 20)]
    ]
  );
  assert.equal(pop2[0]!.vcpu, 2);
  assert.equal(pop2[0]!.ramGb, 8);
  assert.equal(pop2[0]!.diskGb, 20);
  assert.equal(pop2[0]!.gpu, null);

  // "scarce" stock is still offered; Arm types too.
  const pico = offers.sizes.find((size) => size.id === "PLAY2-PICO");
  assert.deepEqual(pico?.regions, ["fr-par-1", "fr-par-2"]);
  assert.equal(pico?.hourlyUsd, linuxEur(0.01428, 20));
  assert.match(offers.sizes.find((size) => size.id === "BASIC2-A2C-4G")?.label ?? "", /Arm64/);

  const prices = offers.sizes.map((size) => size.hourlyUsd ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  assert.deepEqual(offers.regions, [
    { id: "fr-par-1", label: "Paris 1 (fr-par-1)", country: "FR" },
    { id: "fr-par-2", label: "Paris 2 (fr-par-2)", country: "FR" },
    { id: "fr-par-3", label: "Paris 3 (fr-par-3)", country: "FR" }
  ]);
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["ubuntu_noble", "ubuntu_resolute", "ubuntu_jammy", "debian_trixie", "debian_bookworm"]
  );
  assert.deepEqual(offers.images[0], { id: "ubuntu_noble", label: "Ubuntu 24.04 Noble Numbat" });
});

test("offers: linux-gpu lists only GPU types with their GPU, a larger root volume and the GPU OS image first", async () => {
  const replay = replayFetch(catalogRoutes());
  const offers = await scalewayAdapter.offers(credentials, "linux-gpu", replayOptions(replay));
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.regions]),
    [
      ["L4-1-24G", ["fr-par-1", "fr-par-2"]],
      ["H100-1-80G", ["fr-par-2"]]
    ]
  );
  const l4 = offers.sizes[0]!;
  assert.deepEqual(l4.gpu, { model: "L4", count: 1, vramGb: 24 });
  assert.equal(l4.diskGb, 100);
  assert.equal(l4.hourlyUsd, linuxEur(0.7875, 100));
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["ubuntu_noble_gpu_os_13_nvidia", "ubuntu_noble"]
  );
  await assert.rejects(scalewayAdapter.offers(credentials, "windows", replayOptions(replayFetch([]))), /does not rent windows/);
});

test("offers: follows X-Total-Count pages of a zone's catalog", async () => {
  const all = fixture<{ servers: Record<string, unknown> }>("scaleway", "products-servers-fr-par-1").servers;
  const names = Object.keys(all);
  const first = Object.fromEntries(names.slice(0, 3).map((name) => [name, all[name]]));
  const rest = Object.fromEntries(names.slice(3).map((name) => [name, all[name]]));
  const routes = catalogRoutes().filter((route) => route.url !== `${zoneApi("fr-par-1")}/products/servers?page=1&per_page=100`);
  routes.push(
    { method: "GET", url: `${zoneApi("fr-par-1")}/products/servers?page=1&per_page=100`, body: { servers: first }, headers: { "x-total-count": String(names.length) } },
    { method: "GET", url: `${zoneApi("fr-par-1")}/products/servers?page=2&per_page=100`, body: { servers: rest }, headers: { "x-total-count": String(names.length) } }
  );
  const replay = replayFetch(routes);
  const offers = await scalewayAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.ok(offers.sizes.some((size) => size.id === "BASIC2-A2C-4G"), "a type from page 2 is offered");
  assert.equal(replay.pending().length, 0);
});

test("create: tagged server on a block root volume, cloud-init as raw user data, then poweron", async () => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${zoneApi("fr-par-1")}/servers`, status: 201, body: fixture("scaleway", "create-server") },
    { method: "PATCH", url: `${serverUrl}/user_data/cloud-init`, status: 204 },
    { method: "POST", url: `${serverUrl}/action`, status: 202, body: fixture("scaleway", "action-poweron") }
  ]);
  const request = testCreateRequest({ size: "POP2-2C-8G", region: "fr-par-1" });
  const result = await scalewayAdapter.create(credentials, request, replayOptions(replay));

  const create = replay.requests.find((entry) => entry.method === "POST" && entry.url.endsWith("/servers"));
  assert.deepEqual(create?.body, {
    name: `orq-${TEST_BOX_ID}`,
    commercial_type: "POP2-2C-8G",
    image: "a4a3ce62-effa-4293-bf89-2a5c2ceb9d71",
    project: PROJECT,
    tags: ["orquester-box", `orquester-box=${TEST_BOX_ID}`],
    dynamic_ip_required: true,
    volumes: { "0": { size: 20_000_000_000, volume_type: "sbs_volume" } },
    protected: false
  });
  const userData = replay.requests.find((entry) => entry.method === "PATCH");
  assert.equal(userData?.rawBody, request.bootstrap.cloudInit);
  assert.equal(userData?.headers["content-type"], "text/plain");
  assert.deepEqual(replay.requests.at(-1)?.body, { action: "poweron" });
  assert.deepEqual(
    replay.requests.map((entry) => entry.method),
    ["GET", "GET", "POST", "PATCH", "POST"]
  );

  assert.deepEqual(result.ref, { serverId: SERVER_ID, zone: "fr-par-1", volumeIds: [VOLUME_ID] });
  assert.equal(result.hourlyUsd, linuxEur(0.0735, 20));
  assert.equal(result.windowsPassword, undefined);
});

test("create: Arm types get the zone's arm64 image; a regional size id is sent as the plain type", async () => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${zoneApi("fr-par-1")}/servers`, status: 201, body: fixture("scaleway", "create-server") },
    { method: "PATCH", url: `${serverUrl}/user_data/cloud-init`, status: 204 },
    { method: "POST", url: `${serverUrl}/action`, status: 202, body: fixture("scaleway", "action-poweron") }
  ]);
  await scalewayAdapter.create(credentials, testCreateRequest({ size: "BASIC2-A2C-4G@fr-par-1", region: "fr-par-1" }), replayOptions(replay));
  const body = replay.requests.find((entry) => entry.method === "POST" && entry.url.endsWith("/servers"))?.body as Record<string, unknown>;
  assert.equal(body.commercial_type, "BASIC2-A2C-4G");
  assert.equal(body.image, "037f7fe4-f7c8-40b1-92ba-da0092d62f29");
});

test("create: an image the type cannot boot is refused before anything is created", async () => {
  const replay = replayFetch(createRoutes());
  await assert.rejects(
    scalewayAdapter.create(credentials, testCreateRequest({ size: "POP2-HC-64C-128G", region: "fr-par-1" }), replayOptions(replay)),
    /image ubuntu_noble is not available for POP2-HC-64C-128G in fr-par-1/
  );
  assert.equal(replay.requests.some((entry) => entry.method !== "GET"), false);
  await assert.rejects(
    scalewayAdapter.create(credentials, testCreateRequest({ size: "POP2-2C-8G", region: "us-east-1" }), replayOptions(replay)),
    /unknown zone us-east-1/
  );
});

test("create: a failed create is never retried and surfaces Scaleway's message", async () => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${zoneApi("fr-par-1")}/servers`, status: 500, body: fixture("scaleway", "error-internal"), times: 2 }
  ]);
  await assert.rejects(scalewayAdapter.create(credentials, testCreateRequest({ size: "POP2-2C-8G", region: "fr-par-1" }), replayOptions(replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "Scaleway: internal error");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);

  const quota = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${zoneApi("fr-par-1")}/servers`, status: 403, body: fixture("scaleway", "error-quota") }
  ]);
  await assert.rejects(
    scalewayAdapter.create(credentials, testCreateRequest({ size: "POP2-2C-8G", region: "fr-par-1" }), replayOptions(quota)),
    /^ProviderHttpError: Scaleway: Quotas exceeded for this resource$/
  );
});

test("create: a failure after the server exists deletes the stopped server and its volume", async () => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${zoneApi("fr-par-1")}/servers`, status: 201, body: fixture("scaleway", "create-server") },
    { method: "PATCH", url: `${serverUrl}/user_data/cloud-init`, status: 400, body: { message: "user data is too large", type: "invalid_arguments" } },
    { method: "GET", url: serverUrl, body: fixture("scaleway", "create-server") },
    { method: "DELETE", url: serverUrl, status: 204 },
    { method: "GET", url: serverUrl, status: 404, body: fixture("scaleway", "error-not-found") },
    { method: "DELETE", url: `${API}/block/v1/zones/fr-par-1/volumes/${VOLUME_ID}`, status: 204 }
  ]);
  await assert.rejects(
    scalewayAdapter.create(credentials, testCreateRequest({ size: "POP2-2C-8G", region: "fr-par-1" }), replayOptions(replay)),
    /Scaleway: user data is too large/
  );
  assert.equal(replay.pending().length, 0);
  assert.equal(replay.requests.some((entry) => entry.method === "POST" && entry.url.endsWith("/action")), false);
});

test("status: maps server states, 404 is gone, 429 is retried", async () => {
  const running = fixture<{ server: Record<string, unknown> }>("scaleway", "server-running");
  const withState = (state: string, detail = "") => ({ server: { ...running.server, state, state_detail: detail, public_ips: [], public_ip: null } });
  const replay = replayFetch([
    { method: "GET", url: serverUrl, status: 429, headers: { "retry-after": "0" }, body: fixture("scaleway", "error-rate-limit") },
    { method: "GET", url: serverUrl, body: running },
    { method: "GET", url: serverUrl, body: withState("starting", "provisioning node") },
    { method: "GET", url: serverUrl, body: withState("stopped in place") },
    { method: "GET", url: serverUrl, body: withState("locked") },
    { method: "GET", url: serverUrl, status: 404, body: fixture("scaleway", "error-not-found") }
  ]);
  assert.deepEqual(await scalewayAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.20",
    hourlyUsd: null
  });
  const starting = await scalewayAdapter.status(credentials, ref, replayOptions(replay));
  assert.deepEqual([starting.state, starting.detail, starting.publicIp], ["pending", "Scaleway reports the server starting (provisioning node)", null]);
  assert.equal((await scalewayAdapter.status(credentials, ref, replayOptions(replay))).state, "stopped");
  assert.equal((await scalewayAdapter.status(credentials, ref, replayOptions(replay))).state, "error");
  assert.deepEqual(await scalewayAdapter.status(credentials, ref, replayOptions(replay)), {
    state: "gone",
    detail: "The server no longer exists in Scaleway",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
});

test("destroy: terminates a running server, then deletes its detached block volume", async () => {
  const replay = replayFetch([
    { method: "GET", url: serverUrl, body: fixture("scaleway", "server-running") },
    { method: "POST", url: `${serverUrl}/action`, status: 202, body: { task: { id: "t", description: "server_terminate", status: "pending" } } },
    { method: "GET", url: serverUrl, status: 404, body: fixture("scaleway", "error-not-found") },
    { method: "DELETE", url: `${API}/block/v1/zones/fr-par-1/volumes/${VOLUME_ID}`, status: 204 }
  ]);
  await scalewayAdapter.destroy(credentials, ref, replayOptions(replay));
  assert.deepEqual(replay.requests[1]!.body, { action: "terminate" });
  assert.equal(replay.pending().length, 0);
});

test("destroy: idempotent when the server and volume are already gone; volumes found on the server are deleted too", async () => {
  const gone = replayFetch([
    { method: "GET", url: serverUrl, status: 404, body: fixture("scaleway", "error-not-found") },
    { method: "DELETE", url: `${API}/block/v1/zones/fr-par-1/volumes/${VOLUME_ID}`, status: 404, body: { message: "resource is not found", type: "not_found" } }
  ]);
  await scalewayAdapter.destroy(credentials, ref, replayOptions(gone));
  assert.equal(gone.pending().length, 0);

  // A ref without volume ids (e.g. from an older record) still cleans the volume the server reports.
  const stopped = replayFetch([
    { method: "GET", url: serverUrl, body: fixture("scaleway", "create-server") },
    { method: "DELETE", url: serverUrl, status: 204 },
    { method: "GET", url: serverUrl, status: 404, body: fixture("scaleway", "error-not-found") },
    { method: "DELETE", url: `${API}/block/v1/zones/fr-par-1/volumes/${VOLUME_ID}`, status: 204 }
  ]);
  await scalewayAdapter.destroy(credentials, { serverId: SERVER_ID, zone: "fr-par-1" }, replayOptions(stopped));
  assert.equal(stopped.pending().length, 0);

  await assert.rejects(scalewayAdapter.destroy(credentials, { serverId: SERVER_ID }, replayOptions(stopped)), /instance reference has no zone/);
});

test("listManaged: lists the orquester-box tag in every zone of the project", async () => {
  const routes: ReplayRoute[] = ZONES.map((zone) => {
    const name = zone === "fr-par-1" || zone === "nl-ams-1" ? `servers-managed-${zone}` : "servers-empty";
    const body = fixture<{ servers: unknown[] }>("scaleway", name);
    return {
      method: "GET",
      url: `${zoneApi(zone)}/servers?tags=orquester-box&project=${PROJECT}&page=1&per_page=100`,
      body,
      headers: { "x-total-count": String(body.servers.length) }
    };
  });
  const replay = replayFetch(routes);
  const managed = await scalewayAdapter.listManaged(credentials, replayOptions(replay));
  assert.deepEqual(managed, [
    {
      ref: { serverId: SERVER_ID, zone: "fr-par-1", volumeIds: [VOLUME_ID] },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.123Z",
      state: "running"
    },
    {
      ref: { serverId: "11111111-1111-4111-8111-111111111112", zone: "nl-ams-1", volumeIds: ["44444444-4444-4444-8444-444444444445"] },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
  assert.equal(replay.pending().length, 0);
});
