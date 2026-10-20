import assert from "node:assert/strict";
import { test } from "node:test";

import { flyAdapter } from "./fly.ts";
import { ProviderHttpError } from "./http.ts";
import { fixture, replayFetch, replayOptions, testCreateRequest, TEST_BOX_ID } from "./fixtures/vm-replay.ts";
import { roundUsd } from "./price-tables.ts";

const API = "https://api.machines.dev/v1";
const APP = `orq-${TEST_BOX_ID}`;
const credentials = { token: "FlyV1 fm2_test-token" };
const unauthorized = { status: 401, body: fixture("fly", "error-unauthorized") };

/** shared-cpu-2x with 4 GB at the Ashburn price: 2 vCPU + 3.5 GB above the included ½ GB. */
const SHARED_2X_4GB_IAD = (2 * 8.465e-7 + 3.5 * 2.316e-6) * 3600;

test("validate: ok with a working token, a message for a bad or missing one", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/apps?org_slug=personal&limit=1`, body: fixture("fly", "apps-empty") },
    { method: "GET", url: `${API}/apps?org_slug=my-team&limit=1`, ...unauthorized }
  ]);
  assert.deepEqual(await flyAdapter.validate(credentials, replayOptions(replay)), { ok: true });
  // A `FlyV1` token is sent as is.
  assert.equal(replay.requests[0]!.headers.authorization, "FlyV1 fm2_test-token");

  const bad = await flyAdapter.validate({ token: "wrong-token", orgSlug: "my-team" }, replayOptions(replay));
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /Authenticate: token validation error/);
  assert.doesNotMatch(!bad.ok ? bad.message : "", /wrong-token/);
  // Any other token is a bearer token.
  assert.equal(replay.requests[1]!.headers.authorization, "Bearer wrong-token");

  const missing = await flyAdapter.validate({ orgSlug: "personal" }, replayOptions(replay));
  assert.deepEqual(missing, { ok: false, message: "Fly.io: Access token is missing" });
  assert.equal(replay.requests.length, 2);
});

test("offers: bundled preset prices per live region, regional groups, curated images", async () => {
  const replay = replayFetch([{ method: "GET", url: `${API}/platform/regions`, body: fixture("fly", "regions") }]);
  const offers = await flyAdapter.offers(credentials, "linux", replayOptions(replay));
  assert.equal(offers.priceSource, "table");

  // The deprecated region is dropped; the live order is kept.
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["ams", "fra", "iad", "ord", "sin", "xyz"]
  );
  assert.deepEqual(offers.regions[2], { id: "iad", label: "Ashburn, Virginia (US) (iad)", country: "US" });
  assert.equal(offers.regions[5]!.country, null);

  // One offer per regional price: the cheapest group keeps the plain id.
  const shared2x4 = offers.sizes.filter((size) => size.id.startsWith("shared-cpu-2x-4gb"));
  assert.deepEqual(
    shared2x4.map((size) => [size.id, size.regions]),
    [
      ["shared-cpu-2x-4gb", ["iad"]],
      ["shared-cpu-2x-4gb@ams", ["ams"]],
      ["shared-cpu-2x-4gb@fra", ["fra"]],
      ["shared-cpu-2x-4gb@ord", ["ord"]],
      ["shared-cpu-2x-4gb@sin", ["sin"]],
      ["shared-cpu-2x-4gb@xyz", ["xyz"]]
    ]
  );
  assert.equal(shared2x4[0]!.hourlyUsd, roundUsd(SHARED_2X_4GB_IAD));
  assert.equal(shared2x4[2]!.hourlyUsd, roundUsd(SHARED_2X_4GB_IAD * 1.153846154));
  // A region the price table does not know has no price rather than a wrong one.
  assert.equal(shared2x4[5]!.hourlyUsd, null);
  assert.deepEqual(
    { vcpu: shared2x4[0]!.vcpu, ramGb: shared2x4[0]!.ramGb, diskGb: shared2x4[0]!.diskGb, gpu: shared2x4[0]!.gpu },
    { vcpu: 2, ramGb: 4, diskGb: 20, gpu: null }
  );

  // performance-1x includes its 2 GB: $33/30 days in Ashburn, as on the pricing page.
  const perf1x = offers.sizes.find((size) => size.id === "performance-1x-2gb");
  assert.equal(perf1x?.hourlyUsd, roundUsd(1.2732e-5 * 3600));
  assert.ok(Math.abs((perf1x?.hourlyUsd ?? 0) * 720 - 33) < 0.05);

  // No sub-1 GB presets; cheapest first.
  assert.equal(offers.sizes.some((size) => size.ramGb < 1), false);
  const prices = offers.sizes.map((size) => size.hourlyUsd ?? Infinity);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  assert.equal(offers.images[0]!.id, "buildpack-deps:noble-scm");
  assert.deepEqual(
    offers.images.map((image) => image.id),
    ["buildpack-deps:noble-scm", "buildpack-deps:noble", "buildpack-deps:jammy-scm", "buildpack-deps:bookworm-scm"]
  );
});

test("offers: refuses kinds Fly does not rent", async () => {
  const replay = replayFetch([]);
  await assert.rejects(flyAdapter.offers(credentials, "linux-gpu", replayOptions(replay)), /does not rent linux-gpu/);
});

test("create: one app and one Machine named after the box, the script delivered as a file", async () => {
  const replay = replayFetch([
    { method: "POST", url: `${API}/apps`, status: 201, body: fixture("fly", "create-app") },
    { method: "POST", url: `${API}/apps/${APP}/machines`, body: fixture("fly", "create-machine") }
  ]);
  const request = testCreateRequest({ size: "shared-cpu-2x-4gb@fra", region: "fra" });
  const result = await flyAdapter.create({ ...credentials, orgSlug: "my-team" }, request, replayOptions(replay));

  assert.deepEqual(replay.requests[0]!.body, { name: APP, app_name: APP, org_slug: "my-team", idempotency_key: TEST_BOX_ID });
  assert.deepEqual(replay.requests[1]!.body, {
    name: APP,
    region: "fra",
    config: {
      image: "buildpack-deps:noble-scm",
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
      init: { exec: ["/bin/sh", "/orq/bootstrap.sh"] },
      env: { ORQ_BOOTSTRAP: "1" },
      files: [{ guest_path: "/orq/bootstrap.sh", raw_value: Buffer.from(request.bootstrap.posixScript).toString("base64"), mode: 0o700 }],
      restart: { policy: "on-failure" },
      rootfs: { persist: "restart", size_gb: 20 },
      auto_destroy: false,
      metadata: { "orquester-box": TEST_BOX_ID }
    }
  });
  // The script is never in argv.
  assert.equal(JSON.stringify(replay.requests[1]!.body).includes("orq-bootstrap-posix"), false);
  assert.deepEqual(result.ref, { app: APP, machineId: "1111111a2b3c4d", region: "fra" });
  assert.equal(result.hourlyUsd, roundUsd(SHARED_2X_4GB_IAD * 1.153846154));
});

test("create: a failed Machine create is not retried and removes the app", async () => {
  const replay = replayFetch([
    { method: "POST", url: `${API}/apps`, status: 201, body: fixture("fly", "create-app") },
    { method: "POST", url: `${API}/apps/${APP}/machines`, status: 500, body: fixture("fly", "error-capacity"), times: 2 },
    { method: "DELETE", url: `${API}/apps/${APP}?force=true`, status: 202 }
  ]);
  await assert.rejects(
    flyAdapter.create(credentials, testCreateRequest({ size: "performance-2x-8gb", region: "iad", image: "buildpack-deps:noble" }), replayOptions(replay)),
    (error) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, 500);
      assert.match(error.message, /^Fly\.io: insufficient resources available/);
      return true;
    }
  );
  assert.equal(replay.requests.filter((entry) => entry.method === "POST").length, 2);
  assert.equal(replay.requests.at(-1)!.method, "DELETE");
  assert.equal(replay.pending().length, 1);
});

test("create: a failed app create is not retried; a taken name says so", async () => {
  const request = testCreateRequest({ size: "shared-cpu-1x-1gb", region: "iad" });
  const unavailable = replayFetch([{ method: "POST", url: `${API}/apps`, status: 503, body: fixture("fly", "error-rate-limit"), times: 2 }]);
  await assert.rejects(flyAdapter.create(credentials, request, replayOptions(unavailable)), /rate limit/);
  assert.equal(unavailable.requests.length, 1);

  const taken = replayFetch([{ method: "POST", url: `${API}/apps`, status: 422, body: fixture("fly", "error-name-taken") }]);
  await assert.rejects(flyAdapter.create(credentials, request, replayOptions(taken)), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 422);
    assert.match(error.message, new RegExp(`the app name ${APP} is already taken on Fly\\.io`));
    return true;
  });
});

test("create: rejects unknown sizes and invalid app names before any call", async () => {
  const replay = replayFetch([]);
  await assert.rejects(flyAdapter.create(credentials, testCreateRequest({ size: "shared-cpu-1x-256mb", region: "iad" }), replayOptions(replay)), /unknown size/);
  await assert.rejects(
    flyAdapter.create(credentials, testCreateRequest({ size: "shared-cpu-1x-1gb", region: "iad", name: "orq-ABC12345" }), replayOptions(replay)),
    /not a valid Fly app name/
  );
  assert.equal(replay.requests.length, 0);
});

test("status: maps Machine states, 404 is gone, 429 is retried", async () => {
  const started = fixture<Record<string, unknown>>("fly", "machine-started");
  const url = `${API}/apps/${APP}/machines/1111111a2b3c4d`;
  const replay = replayFetch([
    { method: "GET", url, status: 429, headers: { "retry-after": "0" }, body: fixture("fly", "error-rate-limit") },
    { method: "GET", url, body: started },
    { method: "GET", url, body: { ...started, state: "starting" } },
    { method: "GET", url, body: { ...started, state: "stopped" } },
    { method: "GET", url, body: { ...started, state: "failed" } },
    { method: "GET", url, body: { ...started, state: "destroyed" } },
    { method: "GET", url, status: 404, body: fixture("fly", "error-not-found") }
  ]);
  const ref = { app: APP, machineId: "1111111a2b3c4d", region: "fra" };
  assert.deepEqual(await flyAdapter.status(credentials, ref, replayOptions(replay)), { state: "running", detail: null, publicIp: null, hourlyUsd: null });
  assert.equal((await flyAdapter.status(credentials, ref, replayOptions(replay))).state, "pending");
  const stopped = await flyAdapter.status(credentials, ref, replayOptions(replay));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.detail, "Fly.io reports the Machine stopped");
  assert.equal((await flyAdapter.status(credentials, ref, replayOptions(replay))).state, "error");
  assert.equal((await flyAdapter.status(credentials, ref, replayOptions(replay))).state, "gone");
  assert.equal((await flyAdapter.status(credentials, ref, replayOptions(replay))).state, "gone");
  assert.equal(replay.pending().length, 0);
});

test("status: without a Machine id, the app's Machine; a deleted app is gone", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/apps/${APP}/machines?summary=true`, body: fixture("fly", "machines-list") },
    { method: "GET", url: `${API}/apps/${APP}/machines?summary=true`, status: 404, body: fixture("fly", "error-app-not-found") }
  ]);
  assert.equal((await flyAdapter.status(credentials, { app: APP }, replayOptions(replay))).state, "running");
  const gone = await flyAdapter.status(credentials, { app: APP }, replayOptions(replay));
  assert.equal(gone.state, "gone");
});

test("destroy: force-deletes the app and is idempotent", async () => {
  const replay = replayFetch([
    { method: "DELETE", url: `${API}/apps/${APP}?force=true`, status: 202 },
    { method: "DELETE", url: `${API}/apps/${APP}?force=true`, status: 404, body: fixture("fly", "error-app-not-found") }
  ]);
  const ref = { app: APP, machineId: "1111111a2b3c4d", region: "fra" };
  await flyAdapter.destroy(credentials, ref, replayOptions(replay));
  await flyAdapter.destroy(credentials, ref, replayOptions(replay));
  assert.equal(replay.pending().length, 0);
  await assert.rejects(flyAdapter.destroy(credentials, {}, replayOptions(replay)), /instance reference has no app/);
});

test("listManaged: the org's orq- apps with their Machine", async () => {
  const replay = replayFetch([
    { method: "GET", url: `${API}/apps?org_slug=personal`, body: fixture("fly", "apps-managed") },
    { method: "GET", url: `${API}/apps/${APP}/machines?summary=true`, body: fixture("fly", "machines-list") },
    { method: "GET", url: `${API}/apps/orq-ffeeddccbbaa/machines?summary=true`, body: [] }
  ]);
  const managed = await flyAdapter.listManaged(credentials, replayOptions(replay));
  assert.deepEqual(managed, [
    {
      ref: { app: APP, machineId: "1111111a2b3c4d", region: "fra" },
      name: APP,
      boxId: TEST_BOX_ID,
      createdAt: "2026-10-19T23:00:37.000Z",
      state: "running"
    },
    { ref: { app: "orq-ffeeddccbbaa" }, name: "orq-ffeeddccbbaa", boxId: "ffeeddccbbaa", createdAt: null, state: "pending" }
  ]);
  // my-website is not Orquester's and is never touched.
  assert.equal(replay.requests.some((entry) => entry.url.includes("my-website")), false);
});
