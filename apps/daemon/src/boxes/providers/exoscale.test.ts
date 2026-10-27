import assert from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";

import { exoscaleAdapter, exoscaleAuthorization, exoscaleTiming } from "./exoscale.ts";
import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID, type RecordedRequest } from "./fixtures/vm-replay.ts";

exoscaleTiming.pollMs = 0;

beforeEach((t) => (t as TestContext).mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T12:00:00Z") }));

const GVA = "https://api-ch-gva-2.exoscale.com/v2";
const FRA = "https://api-de-fra-1.exoscale.com/v2";
const DK = "https://api-ch-dk-2.exoscale.com/v2";
const PRICING = "https://portal.exoscale.com/api/pricing";
const credentials = { apiKey: "EXOtestkey0000000000000000", apiSecret: "orq-test-secret" };
const INSTANCE_ID = "11111111-1111-4111-8111-111111111101";
const OPERATION_ID = "22222222-2222-4222-8222-222222222201";
const MEDIUM_ID = "b6e9d1e8-89fc-4db3-aaa4-9b4c5b1d0844";
const UBUNTU_2404 = "ee00bf14-7004-4a9d-b71e-ddbc2e1fd6cd";
const WINDOWS_2022 = "e034fe23-9c48-4750-a71e-b18445f0b7dd";

function pricingRoutes() {
  return [
    { method: "GET", url: `${PRICING}/opencompute`, body: fixture("exoscale", "pricing-opencompute") },
    { method: "GET", url: `${PRICING}/licenses`, body: fixture("exoscale", "pricing-licenses") }
  ];
}

function catalogRoutes(base: string) {
  return [
    { method: "GET", url: `${base}/instance-type`, body: fixture("exoscale", "instance-types") },
    { method: "GET", url: `${base}/template?visibility=public`, body: fixture("exoscale", "templates") }
  ];
}

/** Recompute the request's signature from what was actually sent. */
function assertSigned(request: RecordedRequest): void {
  const header = request.headers.authorization ?? "";
  const expires = Number(/expires=(\d+)/.exec(header)?.[1]);
  assert.equal(expires, Date.parse("2026-10-20T12:10:00Z") / 1000, "signatures remain usable for ten minutes");
  assert.equal(
    header,
    exoscaleAuthorization(credentials.apiKey, credentials.apiSecret, { method: request.method, url: request.url, body: request.rawBody ?? "" }, expires)
  );
}

// Expected USD examples are fixed to the captured catalog and bundled currency/licence assumptions.
test("signature: EXO2-HMAC-SHA256 over method+path, body, query values, headers and expiry", () => {
  // Expected values computed independently with Python's hmac/hashlib/base64.
  assert.equal(
    exoscaleAuthorization("EXOkey", "orq-test-secret", { method: "GET", url: `${GVA}/template?visibility=public`, body: "" }, 1599140767),
    "EXO2-HMAC-SHA256 credential=EXOkey,signed-query-args=visibility,expires=1599140767,signature=YueUguyXqVXvry5iSN7ZAJhZTRQ4wrpFwEQC/TlALCg="
  );
  assert.equal(
    exoscaleAuthorization(
      "EXOkey",
      "orq-test-secret",
      { method: "POST", url: `${GVA}/security-group`, body: '{"name":"my-security-group"}' },
      1599140767
    ),
    "EXO2-HMAC-SHA256 credential=EXOkey,expires=1599140767,signature=c/77zK1TYqWQDX5p94Z3CPyWH4aAYOO6hniKppTiqCQ="
  );
  // The documented example's shape: query values concatenated in name order, names listed with semicolons.
  assert.equal(
    exoscaleAuthorization(
      "EXOkey",
      "orq-test-secret",
      { method: "GET", url: `${GVA}/resource/a02baf5a-a3e4-49a0-857b-8a08d276c1c0?p2=v2&p1=v1`, body: "" },
      1599140767
    ),
    "EXO2-HMAC-SHA256 credential=EXOkey,signed-query-args=p1;p2,expires=1599140767,signature=hADXt9gGQ6BCJir3gUhN/0TY21mbN1hVFM53wxJOjYM="
  );
});

test("validate: ok with a working key, a message for a bad or missing one", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${GVA}/instance`, body: fixture("exoscale", "instances-empty") },
    { method: "GET", url: `${GVA}/instance`, status: 403, body: fixture("exoscale", "error-forbidden") }
  ]);
  assert.deepEqual(await exoscaleAdapter.validate(credentials, replayOptions(t, replay)), { ok: true });
  assertSigned(replay.requests[0]!);
  assert.match(replay.requests[0]!.headers.authorization!, /^EXO2-HMAC-SHA256 credential=EXOtestkey0000000000000000,expires=\d+,signature=/);

  const bad = await exoscaleAdapter.validate({ apiKey: "EXOwrong", apiSecret: "wrong-secret" }, replayOptions(t, replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /Invalid key or request signature/);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /wrong-secret/);

  assert.deepEqual(await exoscaleAdapter.validate({ apiKey: "EXOkey" }, replayOptions(t, replay)), {
    ok: false,
    message: "Exoscale: API secret is missing"
  });
  assert.equal(replay.requests.length, 2);
});

test("offers: Linux types with live prices including the root disk, zones and curated templates", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${GVA}/zone`, body: fixture("exoscale", "zones") },
    ...catalogRoutes(GVA),
    ...pricingRoutes()
  ]);
  const offers = await exoscaleAdapter.offers(credentials, "linux", replayOptions(t, replay));
  assert.equal(offers.priceSource, "live");
  // micro (512 MB), mega (needs authorization), storage and GPU types are not offered.
  assert.deepEqual(
    offers.sizes.map((size) => size.id),
    ["standard.tiny", "standard.small", "standard.medium", "standard.large", "memory.extra-large", "cpu.extra-large"]
  );
  const tiny = offers.sizes[0]!;
  assert.equal(tiny.vcpu, 1);
  assert.equal(tiny.ramGb, 1);
  assert.equal(tiny.diskGb, 40);
  assert.equal(tiny.gpu, null);
  // standard.tiny $0.01458/h + 40 GiB × $0.00014 per GiB-hour.
  assert.equal(tiny.hourlyUsd, 0.0202);
  // Zones the account does not list (at-vie-1 here) are dropped from a type's regions.
  assert.deepEqual(tiny.regions, ["ch-dk-2", "de-fra-1", "ch-gva-2"]);
  assert.deepEqual(offers.sizes.find((size) => size.id === "memory.extra-large")?.regions, ["de-fra-1"]);
  assert.deepEqual(offers.regions, [
    { id: "ch-gva-2", label: "Geneva (ch-gva-2)", country: "CH" },
    { id: "ch-dk-2", label: "Zurich (ch-dk-2)", country: "CH" },
    { id: "de-fra-1", label: "Frankfurt (de-fra-1)", country: "DE" }
  ]);
  assert.deepEqual(
    offers.images.map((image) => image.label),
    [
      "Linux Ubuntu 24.04 LTS 64-bit",
      "Linux Ubuntu 26.04 LTS 64-bit",
      "Linux Ubuntu 22.04 LTS 64-bit",
      "Linux Debian 13 (Trixie) 64-bit",
      "Linux Debian 12 (Bookworm) 64-bit"
    ]
  );
  assert.equal(offers.images[0]!.id, UBUNTU_2404);
  // Public price lists are read without credentials.
  assert.equal(replay.requests.find((entry) => entry.url.startsWith(PRICING))?.headers.authorization, undefined);
});

test("offers: Windows sizes from 4 GB with the licence tier by vCPU count", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${GVA}/zone`, body: fixture("exoscale", "zones") },
    ...catalogRoutes(GVA),
    ...pricingRoutes()
  ]);
  const offers = await exoscaleAdapter.offers(credentials, "windows", replayOptions(t, replay));
  assert.deepEqual(
    offers.sizes.map((size) => size.id),
    ["standard.medium", "standard.large", "memory.extra-large", "cpu.extra-large"]
  );
  const medium = offers.sizes[0]!;
  assert.equal(medium.diskGb, 60);
  // 2 vCPUs: the up-to-7-vCPU licence.
  assert.equal(medium.hourlyUsd, 0.0662);
  // 8 vCPUs: the 8-or-more licence.
  assert.equal(offers.sizes.find((size) => size.id === "cpu.extra-large")?.hourlyUsd, 0.264);
  assert.deepEqual(
    offers.images.map((image) => [image.id, image.label]),
    [
      [WINDOWS_2022, "Windows Server 2022"],
      ["2501a755-0298-4a44-bd87-3c8fde04e73a", "Windows Server 2025"]
    ]
  );
});

test("create: one signed POST with name, labels, base64 cloud-init and the resolved ids", async (t) => {
  const replay = replayFetch([
    ...catalogRoutes(FRA),
    ...pricingRoutes(),
    { method: "POST", url: `${FRA}/instance`, body: fixture("exoscale", "create-operation") }
  ]);
  const request = testCreateRequest({ size: "standard.medium", region: "de-fra-1" });
  const result = await exoscaleAdapter.create(credentials, request, replayOptions(t, replay));

  const post = replay.requests.find((entry) => entry.method === "POST")!;
  assert.deepEqual(post.body, {
    name: `orq-${TEST_BOX_ID}`,
    "instance-type": { id: MEDIUM_ID },
    template: { id: UBUNTU_2404 },
    "disk-size": 40,
    "user-data": Buffer.from(request.bootstrap.cloudInit, "utf8").toString("base64"),
    labels: { "orquester-box": TEST_BOX_ID },
    "public-ip-assignment": "inet4"
  });
  assert.equal(post.headers["content-type"], "application/json");
  assertSigned(post);
  // Every read came first.
  assert.equal(replay.requests.at(-1), post);
  assert.deepEqual(result.ref, { instanceId: INSTANCE_ID, zone: "de-fra-1" });
  assert.equal(result.hourlyUsd, 0.0523);
  assert.equal(result.windowsPassword, undefined);
});

test("create: Windows gets cloudbase-init user data, the template's disk floor and the generated password", async (t) => {
  const replay = replayFetch([
    ...catalogRoutes(GVA),
    ...pricingRoutes(),
    { method: "POST", url: `${GVA}/instance`, body: fixture("exoscale", "create-operation") },
    { method: "GET", url: `${GVA}/instance/${INSTANCE_ID}:password`, body: fixture("exoscale", "instance-password") }
  ]);
  const request = testCreateRequest({ kind: "windows", size: "standard.medium", region: "ch-gva-2", image: WINDOWS_2022 });
  const result = await exoscaleAdapter.create(credentials, request, replayOptions(t, replay));
  const body = replay.requests.find((entry) => entry.method === "POST")!.body as Record<string, unknown>;
  assert.equal(Buffer.from(body["user-data"] as string, "base64").toString("utf8"), `#ps1_sysnative\r\n${request.bootstrap.powershellScript}`);
  assert.deepEqual(body.template, { id: WINDOWS_2022 });
  assert.equal(body["disk-size"], 60);
  assert.equal(result.hourlyUsd, 0.0662);
  assert.equal(result.windowsPassword, "Redacted-Windows-Password-1");
  assertSigned(replay.requests.at(-1)!);
});

test("create: polls the operation until it names the instance", async (t) => {
  const replay = replayFetch([
    ...catalogRoutes(FRA),
    ...pricingRoutes(),
    { method: "POST", url: `${FRA}/instance`, body: fixture("exoscale", "create-operation-unreferenced") },
    { method: "GET", url: `${FRA}/operation/${OPERATION_ID}`, body: fixture("exoscale", "create-operation-unreferenced") },
    { method: "GET", url: `${FRA}/operation/${OPERATION_ID}`, body: { ...fixture<object>("exoscale", "create-operation"), state: "success" } }
  ]);
  const result = await exoscaleAdapter.create(credentials, testCreateRequest({ size: "standard.small", region: "de-fra-1" }), replayOptions(t, replay));
  assert.deepEqual(result.ref, { instanceId: INSTANCE_ID, zone: "de-fra-1" });
  assert.equal(replay.pending().length, 0);
});

test("create: a failed operation surfaces Exoscale's message", async (t) => {
  const replay = replayFetch([
    ...catalogRoutes(FRA),
    ...pricingRoutes(),
    { method: "POST", url: `${FRA}/instance`, body: fixture("exoscale", "create-operation-unreferenced") },
    { method: "GET", url: `${FRA}/operation/${OPERATION_ID}`, body: fixture("exoscale", "operation-failed") }
  ]);
  await assert.rejects(
    exoscaleAdapter.create(credentials, testCreateRequest({ size: "standard.medium", region: "de-fra-1" }), replayOptions(t, replay)),
    /Exoscale: creating the instance failed \(Insufficient capacity for instance type standard\.medium\)/
  );
});

test("create: a 5xx on the create is never retried; unknown sizes and images fail before it", async (t) => {
  const replay = replayFetch([
    ...catalogRoutes(FRA),
    ...pricingRoutes(),
    { method: "POST", url: `${FRA}/instance`, status: 503, body: fixture("exoscale", "error-unavailable"), times: 2 }
  ]);
  await assert.rejects(exoscaleAdapter.create(credentials, testCreateRequest({ size: "standard.medium", region: "de-fra-1" }), replayOptions(t, replay)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 503);
    assert.equal(error.message, "Exoscale: Service temporarily unavailable");
    return true;
  });
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 1);

  const reads = replayFetch([...catalogRoutes(FRA), ...catalogRoutes(FRA)]);
  await assert.rejects(
    exoscaleAdapter.create(credentials, testCreateRequest({ size: "gpu2.small", region: "de-fra-1" }), replayOptions(t, reads)),
    /Exoscale: no instance type gpu2\.small for linux boxes in de-fra-1/
  );
  await assert.rejects(
    exoscaleAdapter.create(credentials, testCreateRequest({ size: "standard.medium", region: "de-fra-1", image: "00000000-0000-4000-8000-000000000000" }), replayOptions(t, reads)),
    /no template 00000000-0000-4000-8000-000000000000 in de-fra-1/
  );
  assert.equal(reads.requests.some((entry) => entry.method === "POST"), false);
});

test("status: maps instance states in the ref's zone, 404 is gone, 429 is retried", async (t) => {
  const running = fixture<Record<string, unknown>>("exoscale", "instance-running");
  const url = `${FRA}/instance/${INSTANCE_ID}`;
  const replay = replayFetch([
    { method: "GET", url, status: 429, headers: { "retry-after": "0" }, body: fixture("exoscale", "error-rate-limit") },
    { method: "GET", url, body: running },
    { method: "GET", url, body: { ...running, state: "starting" } },
    { method: "GET", url, body: { ...running, state: "stopped" } },
    { method: "GET", url, body: { ...running, state: "destroying" } },
    { method: "GET", url, body: { ...running, state: "error" } },
    { method: "GET", url, body: { ...running, state: "something-new" } },
    { method: "GET", url, status: 404, body: fixture("exoscale", "error-not-found") }
  ]);
  const ref = { instanceId: INSTANCE_ID, zone: "de-fra-1" };
  assert.deepEqual(await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "running",
    detail: null,
    publicIp: "203.0.113.20",
    hourlyUsd: null
  });
  assert.equal((await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  const stopped = await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.detail, "Exoscale reports the instance stopped");
  assert.equal((await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay))).state, "gone");
  assert.equal((await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay))).state, "error");
  // A state the adapter does not know is transient (pending), never a failure that destroys the box.
  assert.equal((await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay))).state, "pending");
  assert.deepEqual(await exoscaleAdapter.status(credentials, ref, replayOptions(t, replay)), {
    state: "gone",
    detail: "The instance no longer exists in Exoscale",
    publicIp: null,
    hourlyUsd: null
  });
  assert.equal(replay.pending().length, 0);
  replay.requests.forEach(assertSigned);
});

test("destroy: deletes the instance in its zone and is idempotent", async (t) => {
  const url = `${FRA}/instance/${INSTANCE_ID}`;
  const replay = replayFetch([
    { method: "DELETE", url, body: fixture("exoscale", "delete-operation") },
    { method: "DELETE", url, status: 404, body: fixture("exoscale", "error-not-found") }
  ]);
  const ref = { instanceId: INSTANCE_ID, zone: "de-fra-1" };
  await exoscaleAdapter.destroy(credentials, ref, replayOptions(t, replay));
  await exoscaleAdapter.destroy(credentials, ref, replayOptions(t, replay));
  assert.equal(replay.pending().length, 0);
  assertSigned(replay.requests[0]!);
  await assert.rejects(exoscaleAdapter.destroy(credentials, { instanceId: INSTANCE_ID }, replayOptions(t, replay)), /instance reference has no zone/);
});

test("listManaged: every zone, by label or orq- name, with the zone in the ref", async (t) => {
  const replay = replayFetch([
    { method: "GET", url: `${GVA}/zone`, body: fixture("exoscale", "zones") },
    { method: "GET", url: `${GVA}/instance`, body: fixture("exoscale", "instances-gva") },
    { method: "GET", url: `${DK}/instance`, body: fixture("exoscale", "instances-empty") },
    { method: "GET", url: `${FRA}/instance`, body: fixture("exoscale", "instances-fra") }
  ]);
  assert.deepEqual(await exoscaleAdapter.listManaged(credentials, replayOptions(t, replay)), [
    {
      ref: { instanceId: INSTANCE_ID, zone: "ch-gva-2" },
      name: `orq-${TEST_BOX_ID}`,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    {
      ref: { instanceId: "11111111-1111-4111-8111-111111111102", zone: "de-fra-1" },
      name: "orq-ffeeddccbbaa",
      boxId: "ffeeddccbbaa",
      createdAt: "2026-10-19T21:12:00.000Z",
      state: "pending"
    }
  ]);
  assert.equal(replay.pending().length, 0);
});
