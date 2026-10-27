import assert from "node:assert/strict";
import { test } from "node:test";

import { hetznerAdapter } from "./hetzner.ts";
import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";

const API = "https://api.hetzner.cloud/v1";
const credentials = { token: "hcloud-test-token" };
const unauthorized = { status: 401, body: fixture("hetzner", "error-unauthorized") };

function readRoutes() {
  return [
    { method: "GET", url: `${API}/server_types?page=1&per_page=50`, body: fixture("hetzner", "server-types") },
    { method: "GET", url: `${API}/locations?page=1&per_page=50`, body: fixture("hetzner", "locations") },
    { method: "GET", url: `${API}/images?type=system&status=available&page=1&per_page=50`, body: fixture("hetzner", "images") },
    { method: "GET", url: `${API}/pricing`, body: fixture("hetzner", "pricing") }
  ];
}

// Expected USD examples are fixed to the captured catalog and bundled currency/licence assumptions.
test("validate: ok with a working token, a message for a bad or missing one", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/servers?per_page=1`, body: fixture("hetzner", "servers-empty") },
    { method: "GET", url: `${API}/servers?per_page=1`, ...unauthorized }
  ]);
  assert.deepEqual(await hetznerAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer hcloud-test-token");

  const bad = await hetznerAdapter.validate({ token: "wrong" }, replayOptions(t, replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /token you have provided is invalid/);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /wrong/);

  const missing = await hetznerAdapter.validate({}, replayOptions(t, replay));
  assert.deepEqual(missing, { ok: false, message: "Hetzner: API token is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers: live sizes per available location with the IPv4 price, converted from EUR", async (t) => {
  const replay = replayFetch(readRoutes());
  const offers = await hetznerAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "live");

  // cx33 has no location where it can be ordered: not offered.
  assert.equal(offers.sizes.some((size) => size.id.startsWith("cx33")), false);

  const cx23 = offers.sizes.find((size) => size.id === "cx23");
  assert.ok(cx23, "cx23 offered");
  assert.equal(cx23.vcpu, 2);
  assert.equal(cx23.ramGb, 4);
  assert.equal(cx23.diskGb, 40);
  assert.equal(cx23.gpu, null);
  // 0.0088 € server + 0.0008 € primary IPv4 per hour.
  assert.equal(cx23.hourlyUsd, 0.0111);

  // cpx02 costs more in Singapore: one offer per price, the dearer one with a suffixed id.
  const cpx02 = offers.sizes.filter((size) => size.id.startsWith("cpx02"));
  assert.deepEqual(
    cpx02.map((size) => [size.id, size.regions]),
    [
      ["cpx02", ["fsn1", "nbg1", "hel1"]],
      ["cpx02@sin", ["sin"]]
    ]
  );
  assert.ok((cpx02[1]!.hourlyUsd ?? 0) > (cpx02[0]!.hourlyUsd ?? 0));

  // cpx11 is only orderable in the US locations, whose price differs from its EU list price.
  const cpx11 = offers.sizes.find((size) => size.id === "cpx11");
  assert.deepEqual(cpx11?.regions, ["ash", "hil"]);
  assert.equal(cpx11?.hourlyUsd, 0.0334);

  // Cheapest first.
  const prices = offers.sizes.map((size) => size.hourlyUsd ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"]
  );
  assert.deepEqual(offers.regions[0], { id: "fsn1", label: "Falkenstein (fsn1)", country: "DE" });
  // Ubuntu 24.04 first, one entry per name (x86 and Arm images share it), no Rocky.
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["ubuntu-24.04", "ubuntu-26.04", "ubuntu-22.04", "debian-12"]
  );
});

test("create: one POST with name, labels and cloud-init; price for the chosen location", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/pricing`, body: fixture("hetzner", "pricing") },
    { method: "POST", url: `${API}/servers`, status: 201, body: fixture("hetzner", "create-server") }
  ]);
  const request = testCreateRequest({ size: "cx23", region: "fsn1" });
  const result = await hetznerAdapter.create(credentials, request, replayOptions(t, replay));

  const post = replay.requests.find((entry) => entry.method === "POST");
  assert.deepEqual(post?.body, {
    name: `orq-${TEST_BOX_ID}`,
    server_type: "cx23",
    location: "fsn1",
    image: "ubuntu-24.04",
    user_data: request.bootstrap.cloudInit,
    labels: { "orquester-box": TEST_BOX_ID },
    start_after_create: true,
    public_net: { enable_ipv4: true, enable_ipv6: true }
  });
  assert.deepEqual(result.ref, { serverId: 100000001, location: "fsn1" });
  assert.equal(result.hourlyUsd, 0.0111);
  assert.equal(result.windowsPassword, undefined);
  assert.equal(JSON.stringify(result).includes("root_password"), false);
});

test("create: a regional size id is sent as the plain server type", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/pricing`, body: fixture("hetzner", "pricing") },
    { method: "POST", url: `${API}/servers`, status: 201, body: fixture("hetzner", "create-server") }
  ]);
  await hetznerAdapter.create(credentials, testCreateRequest({ size: "cpx02@sin", region: "sin", image: "debian-12" }), replayOptions(t, replay));
  const post = replay.requests.find((entry) => entry.method === "POST")?.body as Record<string, unknown>;
  assert.equal(post.server_type, "cpx02");
  assert.equal(post.image, "debian-12");
});

test("create: a failed create is never retried and surfaces Hetzner's message", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/pricing`, body: fixture("hetzner", "pricing") },
    { method: "POST", url: `${API}/servers`, status: 503, body: fixture("hetzner", "error-unavailable"), times: 2 }
  ]);
  await assert.rejects(hetznerAdapter.create(credentials, testCreateRequest({ size: "cx23", region: "fsn1" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 503);
    assert.match(error.message, /^Hetzner: server type cx23 is unavailable in this location/);
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);
});

test("status: maps server states, 404 is gone, 429 is retried", async (t) => {
  const running = fixture<{ server: Record<string, unknown> }>("hetzner", "server-running");
  const starting = { server: { ...running.server, status: "starting" } };
  const off = { server: { ...running.server, status: "off" } };
  const replay = replayFetch([
    { method: "GET", url: `${API}/servers/100000001`, status: 429, headers: { "retry-after": "0" }, body: fixture("hetzner", "error-rate-limit") },
    { method: "GET", url: `${API}/servers/100000001`, body: running },
    { method: "GET", url: `${API}/servers/100000001`, body: starting },
    { method: "GET", url: `${API}/servers/100000001`, body: off },
    { method: "GET", url: `${API}/servers/100000001`, body: { server: { ...running.server, status: "unknown" } } },
    { method: "GET", url: `${API}/servers/100000001`, status: 404, body: fixture("hetzner", "error-not-found") }
  ]);
  const ref = { serverId: 100000001, location: "fsn1" };
  assert.deepEqual(await hetznerAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.10",
    hourlyUsd: null
  });
  assert.equal((await hetznerAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  const stopped = await hetznerAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.detail, "Hetzner reports the server off");
  // Hetzner's `unknown` is transient (pending), never a failure that destroys the box.
  assert.equal((await hetznerAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  assert.equal((await hetznerAdapter.status(credentials, ref, replayOptions(t, replay))).state, "gone");
  assert.equal(replay.pending().length, 0);
});

test("destroy: deletes the server and is idempotent", async (t) => {
  const replay = replayFetch([
    { method: "DELETE", url: `${API}/servers/100000001`, body: fixture("hetzner", "delete-server") },
    { method: "DELETE", url: `${API}/servers/100000001`, status: 404, body: fixture("hetzner", "error-not-found") }
  ]);
  const ref = { serverId: 100000001, location: "fsn1" };
  await hetznerAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await hetznerAdapter.destroy(credentials, ref, replayOptions(t, replay));
  assert.equal(replay.pending().length, 0);
  await assert.rejects(hetznerAdapter.destroy(credentials, {}, replayOptions(t, replay)), /instance reference has no serverId/);
});

test("listManaged: filters by the orquester-box label and follows pages", async (t) => {
  const page1 = fixture<{ servers: unknown[]; meta: unknown }>("hetzner", "servers-managed");
  const replay = replayFetch([
    {
      method: "GET",
      url: `${API}/servers?label_selector=orquester-box&page=1&per_page=50`,
      body: { servers: page1.servers.slice(0, 1), meta: { pagination: { page: 1, next_page: 2 } } }
    },
    {
      method: "GET",
      url: `${API}/servers?label_selector=orquester-box&page=2&per_page=50`,
      body: { servers: page1.servers.slice(1), meta: { pagination: { page: 2, next_page: null } } }
    }
  ]);
  const managed = await hetznerAdapter.listManaged(credentials, replayOptions(t, replay));
  assert.deepEqual(managed, [
    {
      ref: { serverId: 100000001, location: "fsn1" },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { serverId: 100000002, location: "hel1" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
});
