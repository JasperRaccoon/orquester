// TensorDock adapter against fixtures (fixtures/tensordock/) built from the v2 API docs
// (dashboard.tensordock.com/api/docs/*: getting-started, fetch-hostnodes, instance-creation,
// instance-management) — no live account was used; ids and IPs are made up. The 401 body is the
// plain-text `Unauthorized` the API returned to an unauthenticated probe. Stubbed fetch only.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import {
  TENSORDOCK_DEFAULT_IMAGE,
  TENSORDOCK_RAM_GB,
  TENSORDOCK_STORAGE_GB,
  TENSORDOCK_VCPU,
  tensordockAdapter,
  tensordockCloudInit
} from "./tensordock.ts";

const creds = { apiKey: "td_test" };
const f = (name: string): string => fixture("tensordock", name);
const AUSTIN = "1d6a3b52-0c7e-4f5e-9a51-6f1a2b3c4d5e";
const FRANKFURT = "7f3e9c10-2b4d-4a6e-8c1f-0a9b8c7d6e5f";
const unauthorized = { status: 401, body: "Unauthorized", headers: { "content-type": "text/plain" } };

test("tensordock: Linux + GPU only, and validate checks the token on /instances", async () => {
  assert.deepEqual(tensordockAdapter.kinds, ["linux-gpu"]);
  assert.match(tensordockAdapter.accountNote ?? "", /Windows/);

  const good = routedFetch([{ path: "/api/v2/instances", replies: [{ body: f("instances-list.json") }] }]);
  assert.deepEqual(await tensordockAdapter.validate(creds, callOptions(good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers.authorization, "Bearer td_test");

  const bad = routedFetch([{ path: "/api/v2/instances", replies: [unauthorized] }]);
  const result = await tensordockAdapter.validate(creds, callOptions(bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Unauthorized/);
});

test("tensordock: offers price the fixed size per location and keep the cheapest per GPU", async () => {
  const { fetch } = routedFetch([{ path: "/api/v2/locations", replies: [{ body: f("locations.json") }] }]);
  const offers = await tensordockAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      // Frankfurt: 0.32 + 8×0.0025 + 32×0.0015 + 100×0.00005; Austin would be 0.443.
      ["geforcertx4090-pcie-24gb", 0.393, ["any", AUSTIN, FRANKFURT]],
      ["h100-sxm5-80gb", 2.293, ["any", AUSTIN]]
    ]
  );
  // The A4000 location caps vCPUs below the box size and the 3090 has no stock: neither is offered.
  const size = offers.sizes[0]!;
  assert.equal(size.vcpu, TENSORDOCK_VCPU);
  assert.equal(size.ramGb, TENSORDOCK_RAM_GB);
  assert.equal(size.diskGb, TENSORDOCK_STORAGE_GB);
  assert.deepEqual(size.gpu, { model: "GeForce RTX 4090 PCIe 24GB", count: 1, vramGb: 24 });
  assert.deepEqual(
    offers.regions.map((region) => [region.id, region.label]),
    [
      ["any", "Cheapest location"],
      [AUSTIN, "Austin, Texas, United States"],
      [FRANKFURT, "Frankfurt, Hesse, Germany"]
    ]
  );
  assert.deepEqual((await tensordockAdapter.offers(creds, "windows-gpu", callOptions(fetch))).sizes, []);
});

test("tensordock: create places on the cheapest location and sends cloud-init, the key and the name once", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/api/v2/locations", replies: [{ body: f("locations.json") }] },
    { method: "POST", path: "/api/v2/instances", replies: [{ body: f("create.json") }] }
  ]);
  const request = sampleCreateRequest({ size: "geforcertx4090-pcie-24gb", region: "any" });
  const result = await tensordockAdapter.create(creds, request, callOptions(fetch));
  const posts = seen.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  const attributes = (posts[0]!.body as { data: { type: string; attributes: Record<string, unknown> } }).data.attributes;
  assert.equal(attributes.name, "orq-box-0123abcd");
  assert.equal(attributes.image, TENSORDOCK_DEFAULT_IMAGE);
  assert.equal(attributes.location_id, FRANKFURT);
  assert.deepEqual(attributes.resources, {
    vcpu_count: TENSORDOCK_VCPU,
    ram_gb: TENSORDOCK_RAM_GB,
    storage_gb: TENSORDOCK_STORAGE_GB,
    gpus: { "geforcertx4090-pcie-24gb": { count: 1 } }
  });
  assert.equal(attributes.ssh_key, request.sshPublicKey);
  assert.deepEqual(attributes.cloud_init, tensordockCloudInit(request.bootstrap.posixScript));
  assert.deepEqual(result, {
    ref: { instanceId: "5c0ffee0-1234-4abc-9def-00000000beef", locationId: FRANKFURT, gpu: "geforcertx4090-pcie-24gb" },
    hourlyUsd: 0.393
  });

  const cloudInit = tensordockCloudInit("echo hi");
  assert.deepEqual(cloudInit.write_files, [{ path: "/root/.orq-bootstrap.sh", content: "echo hi", owner: "root:root", permissions: "0700" }]);
});

test("tensordock: create honours a chosen location, refuses unavailable sizes and never retries", async () => {
  const pinned = routedFetch([
    { path: "/api/v2/locations", replies: [{ body: f("locations.json") }] },
    { method: "POST", path: "/api/v2/instances", replies: [{ status: 503, body: '{"error":"no capacity on this location"}' }] }
  ]);
  await assert.rejects(
    tensordockAdapter.create(creds, sampleCreateRequest({ size: "geforcertx4090-pcie-24gb", region: AUSTIN }), callOptions(pinned.fetch)),
    /no capacity/
  );
  const posts = pinned.seen.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1, "a create is never retried");
  assert.equal((posts[0]!.body as { data: { attributes: { location_id: string } } }).data.attributes.location_id, AUSTIN);

  const none = routedFetch([{ path: "/api/v2/locations", replies: [{ body: f("locations.json") }] }]);
  await assert.rejects(
    tensordockAdapter.create(creds, sampleCreateRequest({ size: "rtx3090-pcie-24gb", region: "any" }), callOptions(none.fetch)),
    /not available/
  );
  await assert.rejects(
    tensordockAdapter.create(creds, sampleCreateRequest({ kind: "windows-gpu", size: "x", region: "any" }), callOptions(none.fetch)),
    /only Linux/
  );
});

test("tensordock: status reads the unwrapped instance; 404 → gone; status words map case-insensitively", async () => {
  const running = routedFetch([{ path: "/api/v2/instances/5c0ffee0", replies: [{ body: f("instance-get.json") }] }]);
  assert.deepEqual(
    await tensordockAdapter.status(creds, { instanceId: "5c0ffee0-1234-4abc-9def-00000000beef" }, callOptions(running.fetch)),
    { state: "running", detail: "Running", publicIp: "198.51.100.23", hourlyUsd: 0.425 }
  );
  const gone = routedFetch([{ path: "/api/v2/instances/", replies: [{ status: 404, body: '{"error":"Instance not found"}' }] }]);
  assert.equal((await tensordockAdapter.status(creds, { instanceId: "x" }, callOptions(gone.fetch))).state, "gone");

  const base = JSON.parse(f("instance-get.json"));
  for (const [raw, state] of [
    ["deploying", "pending"],
    ["starting", "pending"],
    ["Stopped", "stopped"],
    ["StoppedDisassociated", "stopped"],
    ["error", "error"]
  ] as const) {
    const stub = routedFetch([{ path: "/api/v2/instances/", replies: [{ body: JSON.stringify({ data: { ...base, status: raw } }) }] }]);
    assert.equal((await tensordockAdapter.status(creds, { instanceId: "x" }, callOptions(stub.fetch))).state, state, raw);
  }
});

test("tensordock: destroy is idempotent", async () => {
  const { fetch, seen } = routedFetch([
    { method: "DELETE", path: "/api/v2/instances/", replies: [{ body: f("delete.json") }, { status: 404, body: '{"error":"Instance not found"}' }] }
  ]);
  await tensordockAdapter.destroy(creds, { instanceId: "5c0ffee0" }, callOptions(fetch));
  await tensordockAdapter.destroy(creds, { instanceId: "5c0ffee0" }, callOptions(fetch));
  assert.equal(seen.length, 2);
  const denied = routedFetch([{ method: "DELETE", path: "/api/v2/instances/", replies: [unauthorized] }]);
  await assert.rejects(tensordockAdapter.destroy(creds, { instanceId: "5c0ffee0" }, callOptions(denied.fetch)), /Unauthorized/);
});

test("tensordock: listManaged accepts both documented list shapes and keeps orq- names", async () => {
  const first = routedFetch([{ path: "/api/v2/instances", replies: [{ body: f("instances-list.json") }] }]);
  assert.deepEqual(
    (await tensordockAdapter.listManaged(creds, callOptions(first.fetch))).map((instance) => [instance.name, instance.boxId, instance.state]),
    [["orq-box-0123abcd", "box-0123abcd", "running"]]
  );
  const alt = routedFetch([{ path: "/api/v2/instances", replies: [{ body: f("instances-list-alt.json") }] }]);
  assert.deepEqual(
    (await tensordockAdapter.listManaged(creds, callOptions(alt.fetch))).map((instance) => [instance.ref.instanceId, instance.boxId, instance.state]),
    [["66666666-7777-4888-9999-000000000000", "box-99887766", "stopped"]]
  );
});

test("tensordock: a 429 is retried", async () => {
  const { fetch, seen } = routedFetch([
    {
      path: "/api/v2/instances",
      replies: [{ status: 429, headers: { "retry-after": "0" }, body: '{"error":"Too many requests"}' }, { body: f("instances-list.json") }]
    }
  ]);
  assert.equal((await tensordockAdapter.listManaged(creds, callOptions(fetch))).length, 1);
  assert.equal(seen.length, 2);
});
