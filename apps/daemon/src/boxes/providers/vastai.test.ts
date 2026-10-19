// vast.ai adapter against fixtures (fixtures/vastai/) built from the shapes in vast.ai's OpenAPI
// spec (docs.vast.ai/api-reference/openapi.yaml) and the official SDK/CLI (vast-ai/vast-cli,
// vastai/api/*.py) — no live account was used; ids, IPs and keys are made up or redacted.
// Every request goes to a stubbed fetch.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import { ProviderHttpError } from "./http.ts";
import { VAST_DEFAULT_IMAGE, VAST_DISK_GB, VAST_ONSTART_MAX, vastCountry, vastSearchBody, vastaiAdapter } from "./vastai.ts";

const creds = { apiKey: "vast_test" };
const f = (name: string): string => fixture("vastai", name);

test("vastai: validate reads the current user; a bad key is ok:false", async () => {
  const good = routedFetch([{ path: "/api/v0/users/current/", replies: [{ body: f("users-current.json") }] }]);
  assert.deepEqual(await vastaiAdapter.validate(creds, callOptions(good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers.authorization, "Bearer vast_test");

  const bad = routedFetch([{ path: "/api/v0/users/current/", replies: [{ status: 401, body: f("unauthorized.json") }] }]);
  const result = await vastaiAdapter.validate(creds, callOptions(bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Invalid user key/);
});

test("vastai: offers search verified on-demand single-GPU offers and keep the best price per GPU model", async () => {
  const { fetch, seen } = routedFetch([{ method: "POST", path: "/api/v0/bundles/", replies: [{ body: f("bundles.json") }] }]);
  const offers = await vastaiAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  const body = seen[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.verified, { eq: true });
  assert.deepEqual(body.rentable, { eq: true });
  assert.deepEqual(body.reliability, { gte: 0.98 });
  assert.deepEqual(body.num_gpus, { eq: 1 });
  assert.equal(body.type, "on-demand");
  assert.equal(body.allocated_storage, VAST_DISK_GB);
  assert.deepEqual(body.order, [["dph_total", "asc"]]);

  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd]),
    [
      ["RTX 3090", 0.169],
      ["RTX 4090", 0.299],
      ["H100 SXM", 1.659]
    ]
  );
  const rtx4090 = offers.sizes[1]!;
  assert.deepEqual(rtx4090.gpu, { model: "RTX 4090", count: 1, vramGb: 24 });
  assert.equal(rtx4090.vcpu, 12);
  assert.equal(rtx4090.ramGb, 126);
  assert.deepEqual(rtx4090.regions, ["any", "DE", "US"]);
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["any", "CA", "DE", "US"]
  );
  assert.equal(offers.images[0]!.id, VAST_DEFAULT_IMAGE);
  assert.deepEqual((await vastaiAdapter.offers(creds, "linux", callOptions(fetch))).sizes, []);
});

test("vastai: create rents the cheapest matching offer once, with label, onstart and env", async () => {
  const { fetch, seen } = routedFetch([
    { method: "POST", path: "/api/v0/bundles/", replies: [{ body: f("bundles.json") }] },
    { method: "PUT", path: "/api/v0/asks/", replies: [{ body: f("rent-ok.json") }] }
  ]);
  const request = sampleCreateRequest({ size: "RTX 4090", region: "US" });
  const result = await vastaiAdapter.create(creds, request, callOptions(fetch));
  const search = seen[0]!.body as Record<string, unknown>;
  assert.deepEqual(search.gpu_name, { eq: "RTX 4090" });
  assert.deepEqual(search.geolocation, { in: ["US"] });
  assert.deepEqual(search.cuda_max_good, { gte: 12.8 });
  // The cheapest RTX 4090 offer the search returned.
  assert.equal(new URL(seen[1]!.url).pathname, "/api/v0/asks/22001002/");
  const rent = seen[1]!.body as Record<string, unknown>;
  assert.equal(rent.client_id, "me");
  assert.equal(rent.label, "orq-box-0123abcd");
  assert.equal(rent.runtype, "ssh");
  assert.equal(rent.onstart, request.bootstrap.posixScript);
  assert.equal(rent.disk, VAST_DISK_GB);
  assert.equal(rent.image, VAST_DEFAULT_IMAGE);
  assert.equal(rent.cancel_unavail, true);
  assert.deepEqual(rent.env, { ...request.bootstrap.env, ORQUESTER_BOX_ID: "box-0123abcd" });
  assert.deepEqual(result.ref, { instanceId: 31002002, offerId: 22001002, gpuName: "RTX 4090" });
  assert.equal(result.hourlyUsd, 0.299);
  assert.ok(!JSON.stringify(result).includes("instance_api_key"));
});

test("vastai: create moves to the next offer only when the offer is gone, and never retries a failed rent", async () => {
  const taken = routedFetch([
    { method: "POST", path: "/api/v0/bundles/", replies: [{ body: f("bundles.json") }] },
    { method: "PUT", path: "/api/v0/asks/22001002/", replies: [{ status: 410, body: f("rent-no-such-ask.json") }] },
    { method: "PUT", path: "/api/v0/asks/22001003/", replies: [{ body: f("rent-ok.json") }] }
  ]);
  const result = await vastaiAdapter.create(creds, sampleCreateRequest({ size: "RTX 4090", region: "any" }), callOptions(taken.fetch));
  assert.equal(result.ref.offerId, 22001003);
  assert.equal((taken.seen[0]!.body as Record<string, unknown>).geolocation, undefined);

  const failing = routedFetch([
    { method: "POST", path: "/api/v0/bundles/", replies: [{ body: f("bundles.json") }] },
    { method: "PUT", path: "/api/v0/asks/", replies: [{ status: 500, body: '{"success":false,"error":"server_error","msg":"try later"}' }] }
  ]);
  await assert.rejects(vastaiAdapter.create(creds, sampleCreateRequest({ size: "RTX 4090", region: "any" }), callOptions(failing.fetch)), /try later/);
  assert.equal(failing.seen.filter((request) => request.method === "PUT").length, 1);

  const refused = routedFetch([
    { method: "POST", path: "/api/v0/bundles/", replies: [{ body: f("bundles.json") }] },
    { method: "PUT", path: "/api/v0/asks/", replies: [{ body: '{"success":false,"error":"invalid_args","msg":"disk too small"}' }] }
  ]);
  await assert.rejects(
    vastaiAdapter.create(creds, sampleCreateRequest({ size: "RTX 4090", region: "any" }), callOptions(refused.fetch)),
    (error: unknown) => error instanceof ProviderHttpError && /disk too small/.test(error.message)
  );

  const none = routedFetch([{ method: "POST", path: "/api/v0/bundles/", replies: [{ body: '{"offers":[]}' }] }]);
  await assert.rejects(vastaiAdapter.create(creds, sampleCreateRequest({ size: "B200", region: "IS" }), callOptions(none.fetch)), /no rentable B200 offer in IS/);
});

test("vastai: create refuses an onstart script over 4048 characters before renting", async () => {
  const { fetch, seen } = routedFetch([]);
  const request = sampleCreateRequest({ size: "RTX 4090", region: "any" });
  const long = { ...request, bootstrap: { ...request.bootstrap, posixScript: "#".repeat(VAST_ONSTART_MAX + 1) } };
  await assert.rejects(vastaiAdapter.create(creds, long, callOptions(fetch)), /at most 4048/);
  assert.equal(seen.length, 0);
});

test("vastai: status maps the instance, and {instances:null} means gone", async () => {
  const running = routedFetch([{ path: "/api/v0/instances/31002002/?owner=me", replies: [{ body: f("instance-show-running.json") }] }]);
  assert.deepEqual(await vastaiAdapter.status(creds, { instanceId: 31002002 }, callOptions(running.fetch)), {
    state: "running",
    detail: "success, running vastai/base-image_cuda-12.8.1-auto/ssh",
    publicIp: "203.0.113.42",
    hourlyUsd: 0.299
  });

  const gone = routedFetch([{ path: "/api/v0/instances/", replies: [{ body: f("instance-show-null.json") }] }]);
  assert.equal((await vastaiAdapter.status(creds, { instanceId: 1 }, callOptions(gone.fetch))).state, "gone");

  const base = JSON.parse(f("instance-show-running.json")).instances;
  for (const [actual, intended, state] of [
    [null, "running", "pending"],
    ["loading", "running", "pending"],
    ["exited", "running", "error"],
    ["exited", "stopped", "stopped"],
    ["offline", "running", "error"],
    ["stopped", "stopped", "stopped"]
  ] as const) {
    const stub = routedFetch([
      { path: "/api/v0/instances/", replies: [{ body: JSON.stringify({ instances: { ...base, actual_status: actual, intended_status: intended } }) }] }
    ]);
    assert.equal((await vastaiAdapter.status(creds, { instanceId: 1 }, callOptions(stub.fetch))).state, state, `${actual}/${intended}`);
  }
});

test("vastai: destroy is idempotent (200, 404, and success:false for a gone instance)", async () => {
  const ok = routedFetch([{ method: "DELETE", path: "/api/v0/instances/31002002/", replies: [{ body: f("destroy-ok.json") }] }]);
  await vastaiAdapter.destroy(creds, { instanceId: 31002002 }, callOptions(ok.fetch));
  assert.deepEqual(ok.seen[0]!.body, {});

  const missing = routedFetch([{ method: "DELETE", path: "/api/v0/instances/", replies: [{ status: 404, body: f("destroy-not-found.json") }] }]);
  await vastaiAdapter.destroy(creds, { instanceId: 31002002 }, callOptions(missing.fetch));

  const softGone = routedFetch([
    { method: "DELETE", path: "/api/v0/instances/", replies: [{ body: f("destroy-not-found.json") }] },
    { path: "/api/v0/instances/", replies: [{ body: f("instance-show-null.json") }] }
  ]);
  await vastaiAdapter.destroy(creds, { instanceId: 31002002 }, callOptions(softGone.fetch));

  const refused = routedFetch([
    { method: "DELETE", path: "/api/v0/instances/", replies: [{ body: '{"success":false,"msg":"instance is locked"}' }] },
    { path: "/api/v0/instances/", replies: [{ body: f("instance-show-running.json") }] }
  ]);
  await assert.rejects(vastaiAdapter.destroy(creds, { instanceId: 31002002 }, callOptions(refused.fetch)), /instance is locked/);
});

test("vastai: listManaged pages through v1 instances and keeps orq- labels", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/api/v1/instances/?limit=25&after_token=tok-2", replies: [{ body: f("instances-page2.json") }] },
    { path: "/api/v1/instances/?limit=25", replies: [{ body: f("instances-page1.json") }] }
  ]);
  const managed = await vastaiAdapter.listManaged(creds, callOptions(fetch));
  assert.equal(seen.length, 2);
  assert.deepEqual(
    managed.map((instance) => [instance.name, instance.boxId, instance.state, instance.ref.instanceId]),
    [
      ["orq-box-0123abcd", "box-0123abcd", "pending", 31002002],
      ["orq-box-99887766", "box-99887766", "error", 31002004]
    ]
  );
  assert.equal(managed[0]!.createdAt, new Date(1760914666123).toISOString());
});

test("vastai: a 429 is retried, and helpers parse countries and build searches", async () => {
  const { fetch, seen } = routedFetch([
    {
      path: "/api/v0/users/current/",
      replies: [{ status: 429, headers: { "retry-after": "0", "content-type": "text/plain" }, body: "API requests too frequent endpoint threshold=4.5" }, { body: f("users-current.json") }]
    }
  ]);
  assert.deepEqual(await vastaiAdapter.validate(creds, callOptions(fetch)), { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(vastCountry("Oregon, US"), "US");
  assert.equal(vastCountry("SE"), "SE");
  assert.equal(vastCountry(null), null);
  assert.equal(vastSearchBody({ minCuda: 12.4, limit: 5 }).limit, 5);
});
