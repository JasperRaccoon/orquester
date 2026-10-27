// RunPod adapter against responses recorded from the live v2 API on 2026-10-19 (fixtures/runpod/,
// redacted: the daemon URL and ssh proxy username are replaced). The live run created one community
// RTX A4500 pod, saw its start command call back, listed, destroyed it twice (204, then 404) and
// read it back as 404. Every request here goes to a stubbed fetch.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import { ProviderHttpError } from "./http.ts";
import { RUNPOD_DEFAULT_IMAGE, parseRunpodSize, runpodAdapter } from "./runpod.ts";

const creds = { apiKey: "rpa_test" };
const f = (name: string): string => fixture("runpod", name);

test("runpod: validate reads one pod page and maps 401 to ok:false with RunPod's wording", async (t) => {
  const good = routedFetch([{ path: "/v2/pods?limit=1", replies: [{ body: '{"pods":[],"pagination":{"hasNextPage":false}}' }] }]);
  assert.deepEqual(await runpodAdapter.validate(creds, callOptions(t, good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers.authorization, "Bearer rpa_test");

  const bad = routedFetch([{ path: "/v2/pods", replies: [{ status: 401, body: f("validate-unauthorized.json") }] }]);
  const result = await runpodAdapter.validate(creds, callOptions(t, bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Subject token is invalid or expired/);

  const missing = await runpodAdapter.validate({}, callOptions(t, bad.fetch));
  assert.equal(missing.ok, false);
});

test("runpod: offers list in-stock NVIDIA types per cloud with live prices and their data centers", async (t) => {
  const { fetch, seen } = routedFetch([
    { path: /^\/v2\/catalog\/gpus\?.*cloud=COMMUNITY/, replies: [{ body: f("gpus-community.json") }] },
    { path: /^\/v2\/catalog\/gpus\?.*cloud=SECURE/, replies: [{ body: f("gpus-secure.json") }] },
    { path: "/v2/catalog/datacenters", replies: [{ body: f("datacenters.json") }] }
  ]);
  const offers = await runpodAdapter.offers(creds, "linux-gpu", callOptions(t, fetch));
  assert.equal(offers.priceSource, "live");
  assert.ok(seen.every((request) => request.url.includes("include=AVAILABILITY&product=POD") || request.url.endsWith("/datacenters")));

  const ids = offers.sizes.map((size) => size.id);
  // Cheapest first; only types with stock; AMD MI350 (secure, LOW) is left out.
  assert.equal(ids[0], "community:NVIDIA RTX A4500");
  assert.ok(ids.includes("community:NVIDIA L40"));
  assert.ok(ids.includes("secure:NVIDIA L4"));
  assert.ok(!ids.some((id) => id.includes("AMD")));
  assert.ok(!ids.includes("community:NVIDIA GeForce RTX 4090"), "RTX 4090 had no community stock");
  const prices = offers.sizes.map((size) => size.hourlyUsd!);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  const a4500 = offers.sizes[0]!;
  assert.equal(a4500.hourlyUsd, 0.19);
  assert.deepEqual(a4500.gpu, { model: "RTX A4500", count: 1, vramGb: 20 });
  assert.deepEqual(a4500.regions, ["any"]);
  const l4 = offers.sizes.find((size) => size.id === "secure:NVIDIA L4")!;
  assert.deepEqual(l4.regions, ["any", "US-MO-2"]);

  assert.equal(offers.regions[0]!.id, "any");
  const moRegion = offers.regions.find((region) => region.id === "US-MO-2")!;
  assert.equal(moRegion.country, "US");
  assert.equal(offers.regions.find((region) => region.id === "EU-RO-1")?.country, "RO");
  assert.ok(!offers.regions.some((region) => region.id === "AP-JP-1"), "regions without stock are not offered");
  assert.equal(offers.images[0]!.id, RUNPOD_DEFAULT_IMAGE);

  const none = await runpodAdapter.offers(creds, "windows-gpu", callOptions(t, fetch));
  assert.deepEqual(none.sizes, []);
});

test("runpod: create sends one POST with name, GPU, cloud, entrypoint and env, and no ports", async (t) => {
  const { fetch, seen } = routedFetch([{ method: "POST", path: "/v2/pods", replies: [{ status: 201, body: f("pod-create.json") }] }]);
  const request = sampleCreateRequest({ size: "community:NVIDIA RTX A4500", region: "any" });
  const result = await runpodAdapter.create(creds, request, callOptions(t, fetch));
  assert.equal(seen.length, 1);
  const body = seen[0]!.body as Record<string, unknown>;
  assert.equal(body.name, "orq-box-0123abcd");
  assert.equal(body.cloud, "COMMUNITY");
  assert.equal(body.image, RUNPOD_DEFAULT_IMAGE);
  assert.deepEqual(body.gpu, { id: "NVIDIA RTX A4500", count: 1, minCudaVersion: "12.8" });
  assert.deepEqual(body.entrypoint, request.bootstrap.containerCommand);
  assert.deepEqual(body.cmd, []);
  assert.deepEqual(body.ports, []);
  assert.equal(body.dataCenterIds, undefined);
  assert.deepEqual(body.env, { ...request.bootstrap.env, ORQUESTER_BOX_ID: "box-0123abcd" });
  assert.deepEqual(result.ref, { podId: "8rejh12qb4vpre", cloud: "COMMUNITY", gpuId: "NVIDIA RTX A4500", dataCenterId: null });
  assert.equal(result.hourlyUsd, 0.19);
});

test("runpod: create pins a data center and never retries (no duplicate rentals)", async (t) => {
  const { fetch, seen } = routedFetch([
    {
      method: "POST",
      path: "/v2/pods",
      replies: [{ status: 500, body: '{"title":"Internal Server Error","status":500,"detail":"upstream timeout"}' }]
    }
  ]);
  const request = sampleCreateRequest({ size: "secure:NVIDIA L4", region: "US-MO-2", image: "runpod/base:1.4.1-ubuntu2404" });
  await assert.rejects(runpodAdapter.create(creds, request, callOptions(t, fetch)), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 500);
    assert.match(error.message, /upstream timeout/);
    return true;
  });
  assert.equal(seen.length, 1);
  const body = seen[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.dataCenterIds, ["US-MO-2"]);
  assert.deepEqual(body.gpu, { id: "NVIDIA L4", count: 1 }, "no CUDA floor for the driver-only image");
  assert.throws(() => parseRunpodSize("H100"), /unknown size/);
});

test("runpod: status maps RUNNING, 404 → gone, and other pod states", async (t) => {
  const running = routedFetch([{ path: "/v2/pods/8rejh12qb4vpre", replies: [{ body: f("pod-get-running.json") }] }]);
  const status = await runpodAdapter.status(creds, { podId: "8rejh12qb4vpre" }, callOptions(t, running.fetch));
  assert.deepEqual(status, { state: "running", detail: "RUNNING", publicIp: null, hourlyUsd: 0.19 });

  const gone = routedFetch([{ path: "/v2/pods/", replies: [{ status: 404, body: f("pod-not-found.json") }] }]);
  const goneStatus = await runpodAdapter.status(creds, { podId: "8rejh12qb4vpre" }, callOptions(t, gone.fetch));
  assert.equal(goneStatus.state, "gone");

  const pod = JSON.parse(f("pod-get-running.json"));
  for (const [raw, state] of [
    ["PROVISIONING", "pending"],
    ["STARTING", "pending"],
    ["EXITED", "stopped"],
    ["ERROR", "error"],
    ["TERMINATED", "gone"]
  ] as const) {
    const stub = routedFetch([{ path: "/v2/pods/", replies: [{ body: JSON.stringify({ ...pod, status: raw, cost: 0 }) }] }]);
    const mapped = await runpodAdapter.status(creds, { podId: "x" }, callOptions(t, stub.fetch));
    assert.equal(mapped.state, state, raw);
    assert.equal(mapped.hourlyUsd, null);
  }
  const ip = routedFetch([
    { path: "/v2/pods/", replies: [{ body: JSON.stringify({ ...pod, runtime: { ports: [{ ip: "203.0.113.7", public: 4000, private: 22 }] } }) }] }
  ]);
  assert.equal((await runpodAdapter.status(creds, { podId: "x" }, callOptions(t, ip.fetch))).publicIp, "203.0.113.7");
  await assert.rejects(runpodAdapter.status(creds, {}, callOptions(t, ip.fetch)), /no pod id/);
});

test("runpod: destroy is idempotent (204, then 404 resolves too)", async (t) => {
  const { fetch, seen } = routedFetch([
    { method: "DELETE", path: "/v2/pods/8rejh12qb4vpre", replies: [{ status: 204 }, { status: 404, body: f("pod-not-found.json") }] }
  ]);
  await runpodAdapter.destroy(creds, { podId: "8rejh12qb4vpre" }, callOptions(t, fetch));
  await runpodAdapter.destroy(creds, { podId: "8rejh12qb4vpre" }, callOptions(t, fetch));
  assert.equal(seen.length, 2);

  const cluster = routedFetch([
    { method: "DELETE", path: "/v2/pods/", replies: [{ status: 409, body: '{"title":"Conflict","status":409,"detail":"pod belongs to a cluster"}' }] }
  ]);
  await assert.rejects(runpodAdapter.destroy(creds, { podId: "x" }, callOptions(t, cluster.fetch)), /belongs to a cluster/);
});

test("runpod: listManaged keeps orq- pods, reads the box id from env, and follows the cursor", async (t) => {
  const page = JSON.parse(f("pod-list.json"));
  const other = { ...page.pods[0], id: "zzz", name: "my-own-pod", env: {} };
  const legacy = { ...page.pods[0], id: "yyy", name: "orq-box-77aa88bb", env: {} };
  const { fetch, seen } = routedFetch([
    {
      path: "/v2/pods?limit=500&cursor=c2",
      replies: [{ body: JSON.stringify({ pods: [legacy], pagination: { hasNextPage: false, nextCursor: null } }) }]
    },
    {
      path: "/v2/pods?limit=500",
      replies: [{ body: JSON.stringify({ pods: [page.pods[0], other], pagination: { hasNextPage: true, nextCursor: "c2" } }) }]
    }
  ]);
  const managed = await runpodAdapter.listManaged(creds, callOptions(t, fetch));
  assert.equal(seen.length, 2);
  assert.deepEqual(
    managed.map((instance) => [instance.name, instance.boxId, instance.state]),
    [
      ["orq-test-t3-f6de35", "test-t3-f6de35", "running"],
      ["orq-box-77aa88bb", "box-77aa88bb", "running"]
    ]
  );
  assert.equal(managed[0]!.createdAt, "2026-10-19T22:57:46.899Z");
  assert.equal(managed[0]!.ref.podId, "8rejh12qb4vpre");
});
