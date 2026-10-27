import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";
import { upcloudAdapter, upcloudTiming } from "./upcloud.ts";

upcloudTiming.pollMs = 0;

const API = "https://api.upcloud.com/1.3";
const credentials = { token: "ucat_01TESTTOKEN0000000000000000" };
const SERVER_ID = "00111111-1111-4111-8111-111111111101";
const UBUNTU_2404 = "01000000-0000-4000-8000-000030240200";
const unauthorized = { status: 401, body: fixture("upcloud", "error-unauthorized") };

// Expected USD examples are fixed to the captured catalog and bundled currency/licence assumptions.
test("validate: bearer token or Basic subaccount; a message for bad or missing credentials", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/account`, body: fixture("upcloud", "account"), times: 2 },
    { method: "GET", url: `${API}/account`, ...unauthorized }
  ]);
  assert.deepEqual(await upcloudAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[0]!.headers.authorization, "Bearer ucat_01TESTTOKEN0000000000000000");

  assert.deepEqual(await upcloudAdapter.validate({ username: "orq-api", password: "pw-123", token: " " }, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[1]!.headers.authorization, `Basic ${Buffer.from("orq-api:pw-123").toString("base64")}`);

  const bad = await upcloudAdapter.validate({ token: "ucat_wrong" }, replayOptions(t, replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /^UpCloud: Authentication failed using the given username and password\./);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /ucat_wrong/);

  assert.deepEqual(await upcloudAdapter.validate({ username: "orq-api" }, replayOptions(t, replay)), {
    ok: false,
    message: "UpCloud: an API token, or a username and password, is missing"
  });
  assert.equal(replay.requests.length, 3);
});

test("offers: current non-GPU plans priced per zone, Cloud Native with its disk, Linux templates", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/plan`, body: fixture("upcloud", "plans") },
    { method: "GET", url: `${API}/price`, body: fixture("upcloud", "prices") },
    { method: "GET", url: `${API}/zone`, body: fixture("upcloud", "zones") },
    { method: "GET", url: `${API}/storage/template`, body: fixture("upcloud", "templates") }
  ]);
  const offers = await upcloudAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "live");
  // No 512 MB starter, no plan out of offering, no GPU plan; 1xCPU-1GB costs more in New York.
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["DEV-1xCPU-2GB", 0.006, ["de-fra1", "fi-hel1", "us-nyc1"]],
      ["1xCPU-1GB", 0.0086, ["de-fra1", "fi-hel1"]],
      ["1xCPU-1GB@us-nyc1", 0.0104, ["us-nyc1"]],
      ["2xCPU-4GB", 0.0345, ["de-fra1", "fi-hel1", "us-nyc1"]],
      // 2.0833 ¢/h plan + 40 GiB × 0.028 ¢ per GiB-hour of MaxIOPS storage; not sold in New York.
      ["CLOUDNATIVE-2xCPU-8GB", 0.0372, ["de-fra1", "fi-hel1"]]
    ]
  );
  const cloudNative = offers.sizes.at(-1)!;
  assert.equal(cloudNative.label, "CLOUDNATIVE-2xCPU-8GB Cloud Native — 2 vCPU, 8 GB");
  assert.equal(cloudNative.diskGb, 40);
  assert.equal(offers.sizes[1]!.diskGb, 25);
  assert.equal(offers.sizes[1]!.gpu, null);
  // Public zones that sell something; London has no prices here, the private cloud is not public.
  assert.deepEqual(offers.regions, [
    { id: "de-fra1", label: "Frankfurt #1 (de-fra1)", country: "DE" },
    { id: "fi-hel1", label: "Helsinki #1 (fi-hel1)", country: "FI" },
    { id: "us-nyc1", label: "New York #1 (us-nyc1)", country: "US" }
  ]);
  assert.deepEqual(
    offers.images.map((image) => image.label),
    [
      "Ubuntu Server 24.04 LTS (Noble Numbat)",
      "Ubuntu Server 26.04 LTS (Resolute Raccoon)",
      "Ubuntu Server 22.04 LTS (Jammy Jellyfish)",
      "Debian GNU/Linux 13 (Trixie)",
      "Debian GNU/Linux 12 (Bookworm)"
    ]
  );
  assert.equal(offers.images[0]!.id, UBUNTU_2404);
});

test("offers: USD accounts are not converted; Windows is refused", async (t) => {
  const prices = fixture<{ prices: Record<string, unknown> }>("upcloud", "prices");
  const replay = replayFetch([
    { method: "GET", url: `${API}/plan`, body: fixture("upcloud", "plans") },
    { method: "GET", url: `${API}/price`, body: { prices: { ...prices.prices, currency: "USD" } } },
    { method: "GET", url: `${API}/zone`, body: fixture("upcloud", "zones") },
    { method: "GET", url: `${API}/storage/template`, body: fixture("upcloud", "templates") }
  ]);
  const offers = await upcloudAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.sizes.find((size) => size.id === "2xCPU-4GB")?.hourlyUsd, 0.0298);
  await assert.rejects(upcloudAdapter.offers(credentials, "windows", replayOptions(t, replayFetch([]))), /does not rent windows/);
});

function createRoutes() {
  return [
    { method: "GET", url: `${API}/plan`, body: fixture("upcloud", "plans") },
    { method: "GET", url: `${API}/storage/template`, body: fixture("upcloud", "templates") },
    { method: "GET", url: `${API}/price?zone=de-fra1`, body: fixture("upcloud", "prices-fra") }
  ];
}

test("create: one POST with title, labels, cloud-init, metadata and the throwaway SSH key", async (t) => {
  const replay = replayFetch([...createRoutes(), { method: "POST", url: `${API}/server`, status: 202, body: fixture("upcloud", "create-server") }]);
  const request = testCreateRequest({ size: "1xCPU-1GB", region: "de-fra1" });
  const result = await upcloudAdapter.create(credentials, request, replayOptions(t, replay));

  const post = replay.requests.find((entry) => entry.method === "POST")!;
  assert.equal(replay.requests.at(-1), post, "every read comes before the create");
  assert.deepEqual(post.body, {
    server: {
      zone: "de-fra1",
      title: `orq-${TEST_BOX_ID}`,
      hostname: `orq-${TEST_BOX_ID}`,
      plan: "1xCPU-1GB",
      labels: { label: [{ key: "orquester-box", value: TEST_BOX_ID }] },
      metadata: "yes",
      user_data: request.bootstrap.cloudInit,
      login_user: { create_password: "no", ssh_keys: { ssh_key: [request.sshPublicKey] } },
      password_delivery: "none",
      simple_backup: "no",
      storage_devices: {
        storage_device: [{ action: "clone", storage: UBUNTU_2404, title: `orq-${TEST_BOX_ID}-disk`, size: 25 }]
      },
      networking: {
        interfaces: {
          interface: [
            { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
            { type: "public", ip_addresses: { ip_address: [{ family: "IPv6" }] } }
          ]
        }
      }
    }
  });
  assert.deepEqual(result.ref, { serverUuid: SERVER_ID, zone: "de-fra1" });
  assert.equal(result.hourlyUsd, 0.0086);
  assert.equal(result.windowsPassword, undefined);
});

test("create: a regional Cloud Native size gets its own MaxIOPS disk and the chosen template", async (t) => {
  const replay = replayFetch([...createRoutes(), { method: "POST", url: `${API}/server`, status: 202, body: fixture("upcloud", "create-server") }]);
  const debian = "01000000-0000-4000-8000-000020080100";
  const result = await upcloudAdapter.create(
    credentials,
    testCreateRequest({ size: "CLOUDNATIVE-2xCPU-8GB@de-fra1", region: "de-fra1", image: debian }),
    replayOptions(t, replay)
  );
  const server = (replay.requests.find((entry) => entry.method === "POST")!.body as { server: Record<string, unknown> }).server;
  assert.equal(server.plan, "CLOUDNATIVE-2xCPU-8GB");
  assert.deepEqual(server.storage_devices, {
    storage_device: [{ action: "clone", storage: debian, title: `orq-${TEST_BOX_ID}-disk`, size: 40, tier: "maxiops" }]
  });
  assert.equal(result.hourlyUsd, 0.0372);
});

test("create: a 5xx on the create is never retried; unknown plans and templates fail before it", async (t) => {
  const replay = replayFetch([
    ...createRoutes(),
    { method: "POST", url: `${API}/server`, status: 503, body: fixture("upcloud", "error-unavailable"), times: 2 }
  ]);
  await assert.rejects(upcloudAdapter.create(credentials, testCreateRequest({ size: "1xCPU-1GB", region: "de-fra1" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 503);
    assert.equal(error.message, "UpCloud: The API service is not in use because of maintenance.");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);

  const reads = replayFetch([...createRoutes(), ...createRoutes()]);
  await assert.rejects(
    upcloudAdapter.create(credentials, testCreateRequest({ size: "GPU-8xCPU-64GB-1xL40S", region: "de-fra1" }), replayOptions(t, reads)),
    /UpCloud: no plan GPU-8xCPU-64GB-1xL40S/
  );
  await assert.rejects(
    upcloudAdapter.create(
      credentials,
      testCreateRequest({ size: "1xCPU-1GB", region: "de-fra1", image: "01000000-0000-4000-8000-000010080300" }),
      replayOptions(t, reads)
    ),
    /UpCloud: no Linux template 01000000-0000-4000-8000-000010080300/
  );
  assert.equal(reads.requests.some((entry) => entry.method === "POST"), false);
});

test("status: maps server states, 404 is gone, 429 is retried", async (t) => {
  const started = fixture<{ server: Record<string, unknown> }>("upcloud", "server-started");
  const url = `${API}/server/${SERVER_ID}`;
  const replay = replayFetch([
    { method: "GET", url, status: 429, headers: { "retry-after": "0" }, body: fixture("upcloud", "error-rate-limit") },
    { method: "GET", url, body: started },
    { method: "GET", url, body: { server: { ...started.server, state: "maintenance" } } },
    { method: "GET", url, body: { server: { ...started.server, state: "stopped" } } },
    { method: "GET", url, body: { server: { ...started.server, state: "error" } } },
    { method: "GET", url, body: { server: { ...started.server, state: "something-new" } } },
    { method: "GET", url, status: 404, body: fixture("upcloud", "error-not-found") }
  ]);
  const ref = { serverUuid: SERVER_ID, zone: "de-fra1" };
  assert.deepEqual(await upcloudAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.30",
    hourlyUsd: null
  });
  assert.equal((await upcloudAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  const stopped = await upcloudAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.detail, "UpCloud reports the server stopped");
  assert.equal((await upcloudAdapter.status(credentials, ref, replayOptions(t, replay))).state, "error");
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await upcloudAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  assert.deepEqual(await upcloudAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "gone",
    detail: "The server no longer exists in UpCloud",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
});

test("destroy: hard stop, poll until stopped, then delete the server with its storage", async (t) => {
  const started = fixture<{ server: Record<string, unknown> }>("upcloud", "server-started");
  const url = `${API}/server/${SERVER_ID}`;
  const replay = replayFetch([
    // Still being created: a stop is refused, the next poll tries again.
    { method: "GET", url, body: { server: { ...started.server, state: "maintenance" } } },
    { method: "GET", url, body: started },
    { method: "POST", url: `${url}/stop`, status: 409, body: fixture("upcloud", "error-state-illegal") },
    { method: "GET", url, body: started },
    { method: "POST", url: `${url}/stop`, body: fixture("upcloud", "stop-server") },
    { method: "GET", url, body: { server: { ...started.server, state: "stopped" } } },
    { method: "DELETE", url: `${url}?storages=1&backups=delete`, status: 204 }
  ]);
  await upcloudAdapter.destroy(credentials, { serverUuid: SERVER_ID, zone: "de-fra1" }, replayOptions(t, replay));
  assert.equal(replay.pending().length, 0);
  assert.deepEqual(replay.requests.find((entry) => entry.method === "POST")?.body, { stop_server: { stop_type: "hard" } });
  assert.deepEqual(
    replay.requests.map((entry) => entry.method),
    ["GET", "GET", "POST", "GET", "POST", "GET", "DELETE"]
  );
});

test("destroy: idempotent when the server is already gone, and gives up after its deadline", async (t) => {
  const url = `${API}/server/${SERVER_ID}`;
  const gone = replayFetch([
    { method: "GET", url, status: 404, body: fixture("upcloud", "error-not-found") },
    { method: "GET", url, body: { server: { ...fixture<{ server: object }>("upcloud", "server-started").server, state: "stopped" } } },
    { method: "DELETE", url: `${url}?storages=1&backups=delete`, status: 404, body: fixture("upcloud", "error-not-found") }
  ]);
  const ref = { serverUuid: SERVER_ID, zone: "de-fra1" };
  await upcloudAdapter.destroy(credentials, ref, replayOptions(t, gone));
  await upcloudAdapter.destroy(credentials, ref, replayOptions(t, gone));
  assert.equal(gone.pending().length, 0);

  const deadline = upcloudTiming.destroyDeadlineMs;
  upcloudTiming.destroyDeadlineMs = 0;
  try {
    const stuck = replayFetch([
      { method: "GET", url, body: { server: { ...fixture<{ server: object }>("upcloud", "server-started").server, state: "maintenance" } } }
    ]);
    await assert.rejects(upcloudAdapter.destroy(credentials, ref, replayOptions(t, stuck)), /UpCloud: the server .* did not stop in time \(state maintenance\)/);
  } finally {
    upcloudTiming.destroyDeadlineMs = deadline;
  }
  await assert.rejects(upcloudAdapter.destroy(credentials, {}, replayOptions(t, gone)), /instance reference has no serverUuid/);
});

test("listManaged: the label filter, paged", async (t) => {
  const managed = fixture<{ servers: { server: unknown[] } }>("upcloud", "servers-managed");
  const replay = replayFetch([
    {
      method: "GET",
      url: `${API}/server?label=orquester-box&limit=100&offset=0`,
      body: { servers: { server: Array.from({ length: 100 }, () => managed.servers.server[0]) } }
    },
    { method: "GET", url: `${API}/server?label=orquester-box&limit=100&offset=100`, body: { servers: { server: managed.servers.server.slice(1) } } }
  ]);
  const list = await upcloudAdapter.listManaged(credentials, replayOptions(t, replay));
  assert.equal(list.length, 101);
  assert.deepEqual(list[0], {
    ref: { serverUuid: SERVER_ID, zone: "de-fra1" },
    name: `orq-${TEST_BOX_ID}`,
    boxId: TEST_BOX_ID,
    createdAt: "2026-10-19T23:00:37.000Z",
    state: "running"
  });
  assert.deepEqual(list[100], {
    ref: { serverUuid: "00111111-1111-4111-8111-111111111102", zone: "fi-hel1" },
    name: "orq-ffeeddccbbaa",
    boxId: "ffeeddccbbaa",
    createdAt: "2026-10-19T21:12:00.000Z",
    state: "pending"
  });
});
