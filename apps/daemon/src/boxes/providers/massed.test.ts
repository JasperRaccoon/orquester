// Massed Compute adapter against fixtures (fixtures/massed/) built from the OpenAPI spec at
// vm-docs.massedcompute.com (plugin-redoc-0.yaml) and its documented examples and error strings;
// the 401 body is what the API returned to an unauthenticated probe. No live account was used;
// ids and IPs are made up. Stubbed fetch only.

import assert from "node:assert/strict";
import { test } from "node:test";

import { detachedStartCommand } from "./gpu-common.ts";
import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import { massedAdapter, massedGpu, pickMassedImage } from "./massed.ts";

const creds = { apiKey: "mc_test" };
const f = (name: string): string => fixture("massed", name);
const UUID = "8b52a46b-0f3c-4c1e-9a7e-6d13226908f7";

test("massed: validate posts the token check; 401 is ok:false", async () => {
  const good = routedFetch([{ method: "POST", path: "/api/v1/account/token/validation", replies: [{ body: f("token-valid.json") }] }]);
  assert.deepEqual(await massedAdapter.validate(creds, callOptions(good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers.authorization, "Bearer mc_test");
  const bad = routedFetch([{ method: "POST", path: "/api/v1/account/token/validation", replies: [{ status: 401, body: f("unauthorized.json") }] }]);
  const result = await massedAdapter.validate(creds, callOptions(bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Authentication not correct/);
});

test("massed: offers list GPU products with capacity, their regions and the images", async () => {
  const { fetch } = routedFetch([
    { path: "/api/v1/gpu-inventory", replies: [{ body: f("gpu-inventory.json") }] },
    { path: "/api/v1/images", replies: [{ body: f("images.json") }] }
  ]);
  const offers = await massedAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["gpu_1x_a6000", 0.57, ["any", "us-central-1"]],
      ["gpu_1x_l40", 0.99, ["any", "us-central-3", "us-central-1"]]
    ]
  );
  assert.deepEqual(offers.sizes[1]!.gpu, { model: "L40", count: 1, vramGb: null });
  assert.equal(offers.sizes[1]!.vcpu, 26);
  assert.equal(offers.sizes[1]!.diskGb, 625);
  assert.deepEqual(
    offers.regions.map((region) => region.id),
    ["any", "us-central-1", "us-central-3"]
  );
  assert.deepEqual(offers.images.map((image) => image.id), ["3", "7", "9"]);
});

test("massed: create registers the box key, launches once with the start command, and prices from inventory", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/api/v1/gpu-inventory", replies: [{ body: f("gpu-inventory.json") }] },
    { path: "/api/v1/images", replies: [{ body: f("images.json") }] },
    { method: "POST", path: "/api/v1/ssh-keys", replies: [{ body: f("ssh-key-created.json") }] },
    { method: "POST", path: "/api/v1/instance/launch", replies: [{ status: 202, body: f("launch.json") }] }
  ]);
  const request = sampleCreateRequest({ size: "gpu_1x_l40", region: "any" });
  const result = await massedAdapter.create(creds, request, callOptions(fetch));
  const posts = seen.filter((call) => call.method === "POST");
  assert.deepEqual(posts[0]!.body, { name: "orq-box-0123abcd", publicKey: request.sshPublicKey });
  assert.deepEqual(posts[1]!.body, {
    imageId: 7,
    productName: "gpu_1x_l40",
    regionName: "any",
    instanceName: "orq-box-0123abcd",
    command: detachedStartCommand(request.bootstrap.posixScript),
    sshKeys: ["orq-box-0123abcd"]
  });
  assert.equal(posts.length, 2);
  assert.deepEqual(result, { ref: { uuid: UUID, sshKeyId: 412, product: "gpu_1x_l40" }, hourlyUsd: 0.99 });
});

test("massed: a refused launch removes the key; the launch is never retried", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/api/v1/gpu-inventory", replies: [{ body: f("gpu-inventory.json") }] },
    { method: "POST", path: "/api/v1/ssh-keys", replies: [{ body: f("ssh-key-created.json") }] },
    { method: "POST", path: "/api/v1/instance/launch", replies: [{ status: 400, body: f("launch-no-availability.json") }] },
    { method: "DELETE", path: "/api/v1/ssh-keys/412", replies: [{ body: f("ssh-key-deleted.json") }] }
  ]);
  await assert.rejects(
    massedAdapter.create(creds, sampleCreateRequest({ size: "gpu_1x_a6000", region: "us-central-1", image: "3" }), callOptions(fetch)),
    /No Availability/
  );
  assert.equal(seen.filter((call) => call.url.endsWith("/instance/launch")).length, 1);
  assert.equal(seen.filter((call) => call.method === "DELETE").length, 1);
  assert.ok(!seen.some((call) => call.url.endsWith("/images")), "an explicit image skips the image list");

  const unknown = routedFetch([
    { path: "/api/v1/gpu-inventory", replies: [{ body: f("gpu-inventory.json") }] },
    { path: "/api/v1/images", replies: [{ body: f("images.json") }] }
  ]);
  await assert.rejects(massedAdapter.create(creds, sampleCreateRequest({ size: "gpu_8x_b200", region: "any" }), callOptions(unknown.fetch)), /unknown product/);
});

test("massed: status maps booted/booting/terminated and 404 → gone", async () => {
  const running = routedFetch([{ path: `/api/v1/instance/${UUID}`, replies: [{ body: f("instance.json") }] }]);
  assert.deepEqual(await massedAdapter.status(creds, { uuid: UUID }, callOptions(running.fetch)), {
    state: "running",
    detail: "rented",
    publicIp: "198.51.100.77",
    hourlyUsd: 0.99
  });
  const gone = routedFetch([{ path: "/api/v1/instance/", replies: [{ status: 404, body: f("instance-not-found.json") }] }]);
  assert.equal((await massedAdapter.status(creds, { uuid: UUID }, callOptions(gone.fetch))).state, "gone");
  const base = JSON.parse(f("instance.json")).runningInstance;
  for (const [status, booted, state] of [
    ["rented", 0, "pending"],
    ["booting", 0, "pending"],
    ["stopped", 1, "stopped"],
    ["terminated", 0, "gone"]
  ] as const) {
    const stub = routedFetch([{ path: "/api/v1/instance/", replies: [{ body: JSON.stringify({ runningInstance: { ...base, status, os_booted: booted } }) }] }]);
    assert.equal((await massedAdapter.status(creds, { uuid: UUID }, callOptions(stub.fetch))).state, state, status);
  }
});

test("massed: destroy terminates and deletes the key; repeated and reconciler destroys succeed", async () => {
  const first = routedFetch([
    { method: "POST", path: "/api/v1/instance/terminate", replies: [{ status: 202, body: f("terminate.json") }] },
    { method: "DELETE", path: "/api/v1/ssh-keys/412", replies: [{ body: f("ssh-key-deleted.json") }] }
  ]);
  await massedAdapter.destroy(creds, { uuid: UUID, sshKeyId: 412 }, callOptions(first.fetch));
  assert.deepEqual(first.seen[0]!.body, { instanceUuids: [UUID] });

  const again = routedFetch([
    { method: "POST", path: "/api/v1/instance/terminate", replies: [{ status: 400, body: f("terminate-rejected.json") }] },
    { path: `/api/v1/instance/${UUID}`, replies: [{ status: 404, body: f("instance-not-found.json") }] },
    { method: "DELETE", path: "/api/v1/ssh-keys/412", replies: [{ status: 404, body: '{"message":"SSH key not found"}' }] }
  ]);
  await massedAdapter.destroy(creds, { uuid: UUID, sshKeyId: 412 }, callOptions(again.fetch));

  const byName = routedFetch([
    { method: "POST", path: "/api/v1/instance/terminate", replies: [{ status: 202, body: f("terminate.json") }] },
    { path: "/api/v1/ssh-keys", replies: [{ body: f("ssh-keys.json") }] },
    { method: "DELETE", path: "/api/v1/ssh-keys/412", replies: [{ body: f("ssh-key-deleted.json") }] }
  ]);
  await massedAdapter.destroy(creds, { uuid: UUID, keyName: "orq-box-0123abcd" }, callOptions(byName.fetch));
  assert.equal(byName.seen.filter((call) => call.method === "DELETE").length, 1);

  const live = routedFetch([
    { method: "POST", path: "/api/v1/instance/terminate", replies: [{ status: 403, body: '{"message":"Read only token"}' }] },
    { path: `/api/v1/instance/${UUID}`, replies: [{ body: f("instance.json") }] }
  ]);
  await assert.rejects(massedAdapter.destroy(creds, { uuid: UUID }, callOptions(live.fetch)), /Read only token/);
});

test("massed: listManaged keeps orq- names", async () => {
  const { fetch } = routedFetch([{ path: "/api/v1/instance", replies: [{ body: f("instances.json") }] }]);
  assert.deepEqual(
    (await massedAdapter.listManaged(creds, callOptions(fetch))).map((instance) => [instance.ref.uuid, instance.boxId, instance.state, instance.ref.keyName]),
    [
      [UUID, "box-0123abcd", "running", "orq-box-0123abcd"],
      ["66666666-7777-4888-9999-000000000000", "box-99887766", "pending", "orq-box-99887766"]
    ]
  );
});

test("massed: helpers parse products and pick the newest Ubuntu; 429 is retried", async () => {
  assert.deepEqual(massedGpu("gpu_2x_h100_sxm5", "2x H100 SXM5"), { model: "H100 SXM5", count: 2 });
  assert.deepEqual(massedGpu("gpu_1x_l40", undefined), { model: "L40", count: 1 });
  assert.equal(massedGpu("cpu_8x", "8 vCPU"), null);
  assert.equal(pickMassedImage(JSON.parse(f("images.json")).images), 7);
  const { fetch, seen } = routedFetch([
    { method: "POST", path: "/api/v1/account/token/validation", replies: [{ status: 429, headers: { "retry-after": "0" }, body: '{"message":"Too Many Requests"}' }, { body: f("token-valid.json") }] }
  ]);
  assert.deepEqual(await massedAdapter.validate(creds, callOptions(fetch)), { ok: true });
  assert.equal(seen.length, 2);
});
