import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderHttpError } from "./http.ts";
import { ovhAdapter, ovhSignature } from "./ovh.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID, type RecordedRequest, type ReplayRoute } from "./fixtures/vm-replay.ts";

const API = "https://eu.api.ovh.com/1.0";
const PROJECT = "11111111111111111111111111111111";
const P = `${API}/cloud/project/${PROJECT}`;
const SERVER_TIME = 1792368000;
const SSH_KEY_ID = "b3JxLTBhMWIyYzNkNGU1Zg==";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222201";
const credentials = {
  applicationKey: "ak-test-0001",
  applicationSecret: "as-test-secret",
  consumerKey: "ck-test-secret",
  projectId: PROJECT
};

interface Flavor {
  name: string;
  region: string;
  osType: string;
}

const authTime: ReplayRoute = { method: "GET", url: `${API}/auth/time`, body: fixture("ovh", "auth-time"), times: Infinity };
const catalogRoute: ReplayRoute = { method: "GET", url: `${API}/order/catalog/public/cloud?ovhSubsidiary=FR`, body: fixture("ovh", "catalog") };

function flavorsIn(region: string): Flavor[] {
  return fixture<Flavor[]>("ovh", "flavors").filter((flavor) => flavor.region === region);
}

function imagesIn(os: "linux" | "windows", region: string): Array<{ region: string }> {
  return fixture<Array<{ region: string }>>("ovh", `images-${os}`).filter((image) => image.region === region);
}

function offersRoutes(os: "linux" | "windows"): ReplayRoute[] {
  return [
    authTime,
    { method: "GET", url: `${P}/flavor`, body: fixture("ovh", "flavors") },
    { method: "GET", url: `${P}/image?osType=${os}`, body: fixture("ovh", `images-${os}`) },
    catalogRoute
  ];
}

function createReads(os: "linux" | "windows", region: string): ReplayRoute[] {
  return [
    authTime,
    { method: "GET", url: `${P}/flavor?region=${region}`, body: flavorsIn(region) },
    { method: "GET", url: `${P}/image?osType=${os}&region=${region}`, body: imagesIn(os, region) },
    catalogRoute
  ];
}

/** The request carries the application and consumer keys and a signature over exactly what was sent. */
function assertSigned(request: RecordedRequest): void {
  assert.equal(request.headers["x-ovh-application"], credentials.applicationKey);
  assert.equal(request.headers["x-ovh-consumer"], credentials.consumerKey);
  const timestamp = request.headers["x-ovh-timestamp"]!;
  // The API clock, not the local one (the fixture's clock is a day behind).
  assert.ok(Math.abs(Number(timestamp) - SERVER_TIME) <= 5, `timestamp ${timestamp} follows /auth/time`);
  assert.equal(
    request.headers["x-ovh-signature"],
    ovhSignature({
      applicationSecret: credentials.applicationSecret,
      consumerKey: credentials.consumerKey,
      method: request.method,
      url: request.url,
      body: request.rawBody ?? "",
      timestamp
    })
  );
  assert.equal(JSON.stringify(request.headers).includes(credentials.applicationSecret), false);
}

// Expected USD examples are fixed to the captured catalog and bundled currency/licence assumptions.
test("ovhSignature: $1$ + SHA-1 of secret+consumer+method+url+body+timestamp", () => {
  // Expected values computed independently with `printf '%s' '<AS>+<CK>+GET+<url>++1792368000' | sha1sum`.
  const keys = { applicationSecret: "EgWIz07P0HYwtQDs", consumerKey: "MtSwSrPpNjqfVSmJhLbPyr2i45lSDRbC", timestamp: "1792368000" };
  assert.equal(
    ovhSignature({ ...keys, method: "GET", url: "https://eu.api.ovh.com/1.0/cloud/project", body: "" }),
    "$1$d7e9ed9a23b68bf9a3db70ffccc6e1bf21177f55"
  );
  assert.equal(
    ovhSignature({
      ...keys,
      method: "POST",
      url: `https://eu.api.ovh.com/1.0/cloud/project/${PROJECT}/sshkey`,
      body: '{"name":"orq-0a1b2c3d4e5f"}'
    }),
    "$1$c91b99ff47bfb3986596303001ea49118ac5b89f"
  );
});

test("validate: ok with working keys, a message for bad, missing or malformed ones", async (t) => {
  const replay = replayFetch([
    authTime,
    { method: "GET", url: P, body: fixture("ovh", "project") },
    { method: "GET", url: P, status: 403, body: fixture("ovh", "error-invalid-credential") }
  ]);
  assert.deepEqual(await ovhAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assert.equal(replay.requests[0]!.url, `${API}/auth/time`);
  // /auth/time is unauthenticated.
  assert.equal(replay.requests[0]!.headers["x-ovh-signature"], undefined);
  assertSigned(replay.requests[1]!);

  const bad = await ovhAdapter.validate({ ...credentials, consumerKey: "ck-wrong" }, replayOptions(t, replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /^OVHcloud: This credential is not valid \(check the key/);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /ck-wrong|as-test-secret/);

  const before = replay.requests.length;
  assert.deepEqual(await ovhAdapter.validate({ ...credentials, consumerKey: " " }, replayOptions(t, replay)), {
    ok: false,
    message: "OVHcloud: Consumer key is missing"
  });
  assert.deepEqual(await ovhAdapter.validate({ ...credentials, endpoint: "ovh-asia" }, replayOptions(t, replay)), {
    ok: false,
    message: "OVHcloud: API endpoint must be ovh-eu, ovh-ca or ovh-us"
  });
  assert.equal(replay.requests.length, before);
});

test("validate: an empty project ID picks the account's only project, and asks when there are several", async (t) => {
  const { projectId: _projectId, ...withoutProject } = credentials;
  const replay = replayFetch([
    authTime,
    { method: "GET", url: `${API}/cloud/project`, body: fixture("ovh", "projects") },
    { method: "GET", url: P, body: fixture("ovh", "project") },
    { method: "GET", url: `${API}/cloud/project`, body: [PROJECT, "11111111111111111111111111111112"] }
  ]);
  assert.deepEqual(await ovhAdapter.validate(withoutProject, replayOptions(t, replay)), { ok: true });
  assert.deepEqual(await ovhAdapter.validate(withoutProject, replayOptions(t, replay)), {
    ok: false,
    message: "OVHcloud: the account has 2 Public Cloud projects: enter the project ID"
  });
  assert.equal(replay.pending().length, 0);
});

test("offers (linux): hourly flavors in stock, catalog prices from EUR, one offer per regional price", async (t) => {
  const replay = replayFetch(offersRoutes("linux"));
  const offers = await ovhAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "live");
  // The catalog is fetched unsigned; the project calls are signed.
  assert.equal(replay.requests.find((entry) => entry.url.includes("/order/catalog"))?.headers["x-ovh-signature"], undefined);
  assertSigned(replay.requests.find((entry) => entry.url === `${P}/flavor`)!);

  // No GPU flavors, no bare metal, no monthly-only b2-15, no t1-45 without quota, d2-2 only where in stock.
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["d2-2", 0.0121, ["GRA11"]],
      ["b3-8", 0.0594, ["GRA11", "BHS5", "EU-WEST-PAR"]],
      ["b2-7", 0.0822, ["GRA11"]],
      ["b3-8@AF-NORTH-LZ-RBA-A", 0.1079, ["AF-NORTH-LZ-RBA-A"]]
    ]
  );
  const b38 = offers.sizes[1]!;
  assert.equal(b38.label, "b3-8 — 2 vCPU, 8 GB");
  assert.equal(b38.vcpu, 2);
  assert.equal(b38.ramGb, 8);
  assert.equal(b38.diskGb, 50);
  assert.equal(b38.gpu, null);
  assert.equal(offers.sizes.find((size) => size.id === "b2-7")?.ramGb, 7);

  assert.deepEqual(offers.regions, [
    { id: "AF-NORTH-LZ-RBA-A", label: "AF-NORTH-LZ-RBA-A", country: null },
    { id: "BHS5", label: "Beauharnois (BHS5)", country: "CA" },
    { id: "EU-WEST-PAR", label: "Paris (EU-WEST-PAR)", country: "FR" },
    { id: "GRA11", label: "Gravelines (GRA11)", country: "FR" }
  ]);
  // Ubuntu 24.04 first, LTS only, then Debian; one entry per name across regions.
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["Ubuntu 24.04", "Ubuntu 22.04", "Debian 13", "Debian 12"]
  );
});

test("offers (windows): Windows flavors with the licence — per vCore on b3, included in win-* plans", async (t) => {
  const replay = replayFetch(offersRoutes("windows"));
  const offers = await ovhAdapter.offers(credentials, "windows", replayOptions(t, replay));
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["b3-8", 0.1399, ["GRA11"]],
      ["win-b2-7", 0.2212, ["GRA11"]]
    ]
  );
  assert.deepEqual(offers.regions.map((region) => region.id), ["GRA11"]);
  assert.deepEqual(
    offers.images.map((image) => image.id),
    [
      "Windows Server 2022 Standard (Desktop)",
      "Windows Server 2025 Standard (Desktop)",
      "Windows Server 2022 Standard (Core)",
      "Windows Server 2019 Standard (Desktop)"
    ]
  );
});

test("offers (GPU kinds): only GPU flavors, described from the catalog", async (t) => {
  const linux = replayFetch(offersRoutes("linux"));
  const linuxGpu = await ovhAdapter.offers(credentials, "linux-gpu", replayOptions(t, linux));
  // t1-45 has no quota left in the project: not offered.
  assert.deepEqual(linuxGpu.sizes, [
    {
      id: "l4-90",
      label: "l4-90 — 22 vCPU, 90 GB, 1× L4 24 GB",
      vcpu: 22,
      ramGb: 90,
      diskGb: 400,
      gpu: { model: "L4", count: 1, vramGb: 24 },
      hourlyUsd: 0.87,
      regions: ["GRA11"]
    }
  ]);

  const windows = replayFetch(offersRoutes("windows"));
  const windowsGpu = await ovhAdapter.offers(credentials, "windows-gpu", replayOptions(t, windows));
  assert.deepEqual(
    windowsGpu.sizes.map((size) => [size.id, size.hourlyUsd, size.gpu?.model]),
    [["win-l4-90", 1.7516, "L4"]]
  );

  await assert.rejects(ovhAdapter.offers(credentials, "macos", replayOptions(t, replayFetch([]))), /does not rent macos/);
});

test("offers (ovh-ca): the Canadian endpoint and catalog, CAD converted to USD", async (t) => {
  const CA = "https://ca.api.ovh.com/1.0";
  const catalog = { ...fixture<Record<string, unknown>>("ovh", "catalog"), locale: { currencyCode: "CAD", subsidiary: "CA", taxRate: 0 } };
  const replay = replayFetch([
    { method: "GET", url: `${CA}/auth/time`, body: SERVER_TIME },
    { method: "GET", url: `${CA}/cloud/project/${PROJECT}/flavor`, body: fixture("ovh", "flavors") },
    { method: "GET", url: `${CA}/cloud/project/${PROJECT}/image?osType=linux`, body: fixture("ovh", "images-linux") },
    { method: "GET", url: `${CA}/order/catalog/public/cloud?ovhSubsidiary=CA`, body: catalog }
  ]);
  const offers = await ovhAdapter.offers({ ...credentials, endpoint: "OVH-CA" }, "linux", replayOptions(t, replay));
  assert.equal(offers.sizes[0]!.hourlyUsd, 0.0075);
  assert.equal(replay.pending().length, 0);
});

test("create (linux): registers the box's SSH key, then one POST with name, flavor, image and raw cloud-init", async (t) => {
  const replay = replayFetch([
    ...createReads("linux", "GRA11"),
    { method: "POST", url: `${P}/sshkey`, body: fixture("ovh", "sshkey-created") },
    { method: "POST", url: `${P}/instance`, body: fixture("ovh", "instance-created") }
  ]);
  const request = testCreateRequest({ size: "b3-8", region: "GRA11" });
  const result = await ovhAdapter.create(credentials, request, replayOptions(t, replay));

  const posts = replay.requests.filter((entry) => entry.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0]!.body, { name: `orq-${TEST_BOX_ID}`, publicKey: request.sshPublicKey });
  assert.deepEqual(posts[1]!.body, {
    name: `orq-${TEST_BOX_ID}`,
    // The linux b3-8 in GRA11, and the Ubuntu 24.04 image for every flavor type (not the bare-metal one).
    flavorId: "33333333-3333-4333-8333-333333333304",
    imageId: "44444444-4444-4444-8444-444444444401",
    region: "GRA11",
    monthlyBilling: false,
    userData: request.bootstrap.cloudInit,
    sshKeyId: SSH_KEY_ID
  });
  for (const post of posts) {
    assert.equal(post.headers["content-type"], "application/json");
    assertSigned(post);
  }
  assert.deepEqual(result.ref, { projectId: PROJECT, instanceId: INSTANCE_ID, region: "GRA11", sshKeyId: SSH_KEY_ID });
  assert.equal(result.hourlyUsd, 0.0594);
  assert.equal(result.windowsPassword, undefined);
});

test("create (windows): no SSH key, cloudbase-init user data, licence in the price", async (t) => {
  const created = { ...fixture<Record<string, unknown>>("ovh", "instance-created"), sshKeyId: null };
  const replay = replayFetch([...createReads("windows", "GRA11"), { method: "POST", url: `${P}/instance`, body: created }]);
  const request = testCreateRequest({ kind: "windows", size: "b3-8", region: "GRA11" });
  const result = await ovhAdapter.create(credentials, request, replayOptions(t, replay));

  const posts = replay.requests.filter((entry) => entry.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0]!.body, {
    name: `orq-${TEST_BOX_ID}`,
    flavorId: "33333333-3333-4333-8333-333333333308",
    imageId: "44444444-4444-4444-8444-444444444502",
    region: "GRA11",
    monthlyBilling: false,
    userData: `#ps1_sysnative\r\n${request.bootstrap.powershellScript}`
  });
  assert.deepEqual(result.ref, { projectId: PROJECT, instanceId: INSTANCE_ID, region: "GRA11" });
  assert.equal(result.hourlyUsd, 0.1399);
});

test("create: a regional size id resolves to the flavor of that region; unknown sizes fail before anything is created", async (t) => {
  const region = "AF-NORTH-LZ-RBA-A";
  const replay = replayFetch([
    authTime,
    { method: "GET", url: `${P}/flavor?region=${region}`, body: flavorsIn(region) },
    { method: "GET", url: `${P}/image?osType=linux&region=${region}`, body: [{ ...imagesIn("linux", "GRA11")[0]!, region }] },
    catalogRoute,
    { method: "POST", url: `${P}/sshkey`, body: fixture("ovh", "sshkey-created") },
    { method: "POST", url: `${P}/instance`, body: { ...fixture<Record<string, unknown>>("ovh", "instance-created"), region } }
  ]);
  const result = await ovhAdapter.create(credentials, testCreateRequest({ size: `b3-8@${region}`, region }), replayOptions(t, replay));
  const post = replay.requests.find((entry) => entry.url === `${P}/instance`)?.body as Record<string, unknown>;
  assert.equal(post.flavorId, "33333333-3333-4333-8333-333333333307");
  assert.equal(result.hourlyUsd, 0.1079);

  const unknown = replayFetch(createReads("linux", "GRA11"));
  await assert.rejects(
    ovhAdapter.create(credentials, testCreateRequest({ size: "c3-4", region: "GRA11" }), replayOptions(t, unknown)),
    /OVHcloud: size c3-4 is not offered for linux in GRA11/
  );
  assert.equal(unknown.requests.some((entry) => entry.method === "POST"), false);
});

test("create: a failed create is never retried, surfaces OVH's message and removes the SSH key", async (t) => {
  const replay = replayFetch([
    ...createReads("linux", "GRA11"),
    { method: "POST", url: `${P}/sshkey`, body: fixture("ovh", "sshkey-created") },
    { method: "POST", url: `${P}/instance`, status: 500, body: fixture("ovh", "error-internal"), times: 2 },
    { method: "DELETE", url: `${P}/sshkey/${encodeURIComponent(SSH_KEY_ID)}`, body: null }
  ]);
  await assert.rejects(ovhAdapter.create(credentials, testCreateRequest({ size: "b3-8", region: "GRA11" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.equal(error.message, "OVHcloud: Internal server error");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.url === `${P}/instance`).length, 1);
  const cleanup = replay.requests.find((entry) => entry.method === "DELETE");
  assert.ok(cleanup, "SSH key deleted");
  assertSigned(cleanup);
});

test("create: a quota refusal on the SSH key creates nothing else", async (t) => {
  const replay = replayFetch([
    ...createReads("linux", "GRA11"),
    { method: "POST", url: `${P}/sshkey`, status: 400, body: fixture("ovh", "error-quota") }
  ]);
  await assert.rejects(
    ovhAdapter.create(credentials, testCreateRequest({ size: "b3-8", region: "GRA11" }), replayOptions(t, replay)),
    /OVHcloud: Quota exceeded for instances in region GRA11/
  );
  assert.equal(replay.requests.some((entry) => entry.url === `${P}/instance`), false);
});

test("status: maps instance states, 404 is gone, 429 is retried", async (t) => {
  const active = fixture<Record<string, unknown>>("ovh", "instance-active");
  const url = `${P}/instance/${INSTANCE_ID}`;
  const replay = replayFetch([
    authTime,
    { method: "GET", url, status: 429, headers: { "retry-after": "0" }, body: fixture("ovh", "error-rate-limit") },
    { method: "GET", url, body: active },
    { method: "GET", url, body: { ...active, status: "BUILD", ipAddresses: [] } },
    { method: "GET", url, body: { ...active, status: "SHUTOFF" } },
    { method: "GET", url, body: { ...active, status: "SHELVED_OFFLOADED" } },
    { method: "GET", url, body: { ...active, status: "ERROR" } },
    { method: "GET", url, body: { ...active, status: "UNKNOWN" } },
    { method: "GET", url, body: { ...active, status: "DELETING" } },
    { method: "GET", url, status: 404, body: fixture("ovh", "error-not-found") }
  ]);
  const ref = { projectId: PROJECT, instanceId: INSTANCE_ID, region: "GRA11", sshKeyId: SSH_KEY_ID };
  // Public IPv4 over the public IPv6 and the private address.
  assert.deepEqual(await ovhAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.20",
    hourlyUsd: null
  });
  const building = await ovhAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.deepEqual([building.state, building.publicIp], ["pending", null]);
  const stopped = await ovhAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.deepEqual([stopped.state, stopped.detail], ["stopped", "OVHcloud reports the instance SHUTOFF"]);
  assert.equal((await ovhAdapter.status(credentials, ref, replayOptions(t, replay))).state, "stopped");
  assert.equal((await ovhAdapter.status(credentials, ref, replayOptions(t, replay))).state, "error");
  // OpenStack's UNKNOWN (the hypervisor did not answer) is transient: never a failure that destroys the box.
  assert.equal((await ovhAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  assert.equal((await ovhAdapter.status(credentials, ref, replayOptions(t, replay))).state, "gone");
  assert.deepEqual(await ovhAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "gone",
    detail: "The instance no longer exists in OVHcloud",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
});

test("destroy: deletes the instance and its SSH key, idempotent on 404", async (t) => {
  const instanceUrl = `${P}/instance/${INSTANCE_ID}`;
  const keyUrl = `${P}/sshkey/${encodeURIComponent(SSH_KEY_ID)}`;
  const replay = replayFetch([
    authTime,
    { method: "DELETE", url: instanceUrl, body: null },
    { method: "DELETE", url: keyUrl, body: null },
    { method: "DELETE", url: instanceUrl, status: 404, body: fixture("ovh", "error-not-found") },
    { method: "DELETE", url: keyUrl, status: 404, body: fixture("ovh", "error-not-found") },
    { method: "DELETE", url: instanceUrl, body: null }
  ]);
  const ref = { projectId: PROJECT, instanceId: INSTANCE_ID, region: "GRA11", sshKeyId: SSH_KEY_ID };
  await ovhAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await ovhAdapter.destroy(credentials, ref, replayOptions(t, replay));
  // A Windows box has no key.
  await ovhAdapter.destroy(credentials, { projectId: PROJECT, instanceId: INSTANCE_ID, region: "GRA11" }, replayOptions(t, replay));
  assert.equal(replay.pending().length, 0);
  for (const request of replay.requests.filter((entry) => entry.method === "DELETE")) assertSigned(request);
  await assert.rejects(ovhAdapter.destroy(credentials, { projectId: PROJECT }, replayOptions(t, replay)), /instance reference has no instanceId/);
});

test("listManaged: every orq- instance of the project, with refs destroy can use", async (t) => {
  const { projectId: _projectId, ...withoutProject } = credentials;
  const replay = replayFetch([
    authTime,
    { method: "GET", url: `${API}/cloud/project`, body: fixture("ovh", "projects") },
    { method: "GET", url: `${P}/instance`, body: fixture("ovh", "instances") }
  ]);
  assert.deepEqual(await ovhAdapter.listManaged(withoutProject, replayOptions(t, replay)), [
    {
      ref: { projectId: PROJECT, instanceId: INSTANCE_ID, region: "GRA11", sshKeyId: SSH_KEY_ID },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { projectId: PROJECT, instanceId: "22222222-2222-4222-8222-222222222202", region: "GRA11" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
});
