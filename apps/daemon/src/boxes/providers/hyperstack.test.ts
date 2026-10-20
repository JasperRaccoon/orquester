// Hyperstack adapter against fixtures (fixtures/hyperstack/) built from the Infrahub OpenAPI spec
// (infrahub-api-doc.nexgencloud.com/api.json) and its documented examples; the 401 body is what the
// API returned to a fake key. No live account was used; ids and IPs are made up. Stubbed fetch only.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";
import { hyperstackAdapter, hyperstackEnvironmentName, pickHyperstackImage } from "./hyperstack.ts";

const creds = { apiKey: "hs_test" };
const f = (name: string): string => fixture("hyperstack", name);

const offerRoutes = (pricebook = f("pricebook.json")) => [
  { path: "/v1/core/flavors", replies: [{ body: f("flavors.json") }] },
  { path: "/v1/core/regions", replies: [{ body: f("regions.json") }] },
  { path: "/v1/pricebook", replies: [{ body: pricebook }] }
];

test("hyperstack: validate sends the api_key header; a bad key is ok:false", async () => {
  const good = routedFetch([{ path: "/v1/core/environments", replies: [{ body: f("environments.json") }] }]);
  assert.deepEqual(await hyperstackAdapter.validate(creds, callOptions(good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers.api_key, "hs_test");
  const bad = routedFetch([{ path: "/v1/core/environments", replies: [{ status: 401, body: f("unauthorized.json") }] }]);
  const result = await hyperstackAdapter.validate(creds, callOptions(bad.fetch));
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /Invalid API Key/);
});

test("hyperstack: offers list in-stock GPU flavors priced from the pricebook plus the public IP", async () => {
  const { fetch } = routedFetch(offerRoutes());
  const offers = await hyperstackAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  assert.equal(offers.priceSource, "live");
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["n3-RTX-A6000x1", 0.507, ["CANADA-1"]],
      ["n3-H100x1", 1.907, ["NORWAY-1", "CANADA-1"]],
      // No pricebook or table entry for this GPU.
      ["n3-L40Sx1", null, ["US-1"]]
    ]
  );
  const a6000 = offers.sizes[0]!;
  assert.deepEqual(a6000.gpu, { model: "RTX-A6000", count: 1, vramGb: null });
  assert.equal(a6000.vcpu, 28);
  assert.equal(a6000.ramGb, 58);
  assert.equal(offers.sizes[1]!.diskGb, 850);
  assert.deepEqual(
    offers.regions.map((region) => [region.id, region.country]),
    [
      ["CANADA-1", "CA"],
      ["NORWAY-1", "NO"],
      ["US-1", "US"]
    ]
  );
});

test("hyperstack: a GPU missing from the pricebook is priced from the bundled table", async () => {
  const pricebook = JSON.stringify(JSON.parse(f("pricebook.json")).filter((entry: { name: string }) => entry.name !== "H100-80G-PCIe"));
  const { fetch } = routedFetch(offerRoutes(pricebook));
  const offers = await hyperstackAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  assert.equal(offers.priceSource, "table");
  assert.equal(offers.sizes.find((size) => size.id === "n3-H100x1")!.hourlyUsd, 2.507);
});

test("hyperstack: create ensures the region environment, imports the box key pair and starts one labelled VM", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/v1/core/flavors?region=CANADA-1", replies: [{ body: f("flavors.json") }] },
    { path: "/v1/pricebook", replies: [{ body: f("pricebook.json") }] },
    { path: "/v1/core/images?region=CANADA-1", replies: [{ body: f("images.json") }] },
    { method: "POST", path: "/v1/core/environments", replies: [{ status: 409, body: f("environment-exists.json") }] },
    { method: "POST", path: "/v1/core/keypairs", replies: [{ body: f("keypair-imported.json") }] },
    { method: "POST", path: "/v1/core/virtual-machines", replies: [{ body: f("vm-create.json") }] }
  ]);
  const request = sampleCreateRequest({ size: "n3-RTX-A6000x1", region: "CANADA-1" });
  const result = await hyperstackAdapter.create(creds, request, callOptions(fetch));
  const posts = seen.filter((call) => call.method === "POST");
  assert.deepEqual(posts[0]!.body, { name: "orquester-canada-1", region: "CANADA-1" });
  assert.deepEqual(posts[1]!.body, { name: "orq-box-0123abcd", environment_name: "orquester-canada-1", public_key: request.sshPublicKey });
  assert.deepEqual(posts[2]!.body, {
    name: "orq-box-0123abcd",
    environment_name: "orquester-canada-1",
    image_name: "Ubuntu Server 22.04 LTS R550 CUDA 12.4 with Docker",
    flavor_name: "n3-RTX-A6000x1",
    key_name: "orq-box-0123abcd",
    count: 1,
    assign_floating_ip: true,
    create_bootable_volume: false,
    user_data: request.bootstrap.cloudInit,
    labels: ["orquester-box=box-0123abcd"]
  });
  assert.equal(posts.length, 3, "the VM create is sent once");
  assert.deepEqual(result, {
    ref: { vmId: 7613, region: "CANADA-1", environment: "orquester-canada-1", keypairId: 5521, keyName: "orq-box-0123abcd" },
    hourlyUsd: 0.507
  });
});

test("hyperstack: a key pair left by an earlier attempt (409) is reused", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/v1/core/flavors?region=CANADA-1", replies: [{ body: f("flavors.json") }] },
    { path: "/v1/pricebook", replies: [{ body: f("pricebook.json") }] },
    { path: "/v1/core/images?region=CANADA-1", replies: [{ body: f("images.json") }] },
    { method: "POST", path: "/v1/core/environments", replies: [{ body: f("environment-created.json") }] },
    {
      method: "POST",
      path: "/v1/core/keypairs",
      replies: [{ status: 409, body: '{"status":false,"message":"Keypair orq-box-0123abcd already exists","error_reason":"already_exist"}' }]
    },
    { path: "/v1/core/keypairs?search=orq-box-0123abcd", replies: [{ body: f("keypairs-search.json") }] },
    { method: "POST", path: "/v1/core/virtual-machines", replies: [{ body: f("vm-create.json") }] }
  ]);
  const result = await hyperstackAdapter.create(creds, sampleCreateRequest({ size: "n3-RTX-A6000x1", region: "CANADA-1" }), callOptions(fetch));
  assert.equal(result.ref.keypairId, 5521);
  assert.equal((seen.at(-1)!.body as { key_name: string }).key_name, "orq-box-0123abcd");
});

test("hyperstack: a rejected VM create removes the key pair it imported; unknown flavors fail early", async () => {
  const { fetch, seen } = routedFetch([
    { path: "/v1/core/flavors?region=CANADA-1", replies: [{ body: f("flavors.json") }] },
    { path: "/v1/pricebook", replies: [{ body: f("pricebook.json") }] },
    { method: "POST", path: "/v1/core/environments", replies: [{ body: f("environment-created.json") }] },
    { method: "POST", path: "/v1/core/keypairs", replies: [{ body: f("keypair-imported.json") }] },
    {
      method: "POST",
      path: "/v1/core/virtual-machines",
      replies: [{ status: 400, body: '{"status":false,"message":"Insufficient stock for flavor","error_reason":"bad_request"}' }]
    },
    { method: "DELETE", path: "/v1/core/keypair/5521", replies: [{ body: f("keypair-deleted.json") }] }
  ]);
  await assert.rejects(
    hyperstackAdapter.create(creds, sampleCreateRequest({ size: "n3-RTX-A6000x1", region: "CANADA-1", image: "Ubuntu Server 24.04 LTS (Noble Numbat)" }), callOptions(fetch)),
    /Insufficient stock/
  );
  assert.ok(!seen.some((call) => call.url.includes("/core/images")), "an explicit image skips the image lookup");
  assert.equal(seen.filter((call) => call.method === "DELETE").length, 1);

  const unknown = routedFetch([
    { path: "/v1/core/flavors?region=US-1", replies: [{ body: f("flavors.json") }] },
    { path: "/v1/pricebook", replies: [{ body: f("pricebook.json") }] },
    { path: "/v1/core/images", replies: [{ body: f("images.json") }] }
  ]);
  await assert.rejects(hyperstackAdapter.create(creds, sampleCreateRequest({ size: "n3-B200x1", region: "US-1" }), callOptions(unknown.fetch)), /not offered/);
});

test("hyperstack: status maps VM states and 404 → gone", async () => {
  const running = routedFetch([{ path: "/v1/core/virtual-machines/7613", replies: [{ body: f("vm-get.json") }] }]);
  assert.deepEqual(await hyperstackAdapter.status(creds, { vmId: 7613 }, callOptions(running.fetch)), {
    state: "running",
    detail: "ACTIVE",
    publicIp: "192.0.2.118",
    hourlyUsd: null
  });
  const gone = routedFetch([{ path: "/v1/core/virtual-machines/", replies: [{ status: 404, body: f("vm-not-found.json") }] }]);
  assert.equal((await hyperstackAdapter.status(creds, { vmId: 7613 }, callOptions(gone.fetch))).state, "gone");
  const vm = JSON.parse(f("vm-get.json")).instance;
  for (const [raw, state] of [
    ["CREATING", "pending"],
    ["BUILD", "pending"],
    ["SHUTOFF", "stopped"],
    ["HIBERNATED", "stopped"],
    ["DELETING", "gone"],
    ["ERROR", "error"]
  ] as const) {
    const stub = routedFetch([{ path: "/v1/core/virtual-machines/", replies: [{ body: JSON.stringify({ instance: { ...vm, status: raw } }) }] }]);
    assert.equal((await hyperstackAdapter.status(creds, { vmId: 1 }, callOptions(stub.fetch))).state, state, raw);
  }
});

test("hyperstack: destroy deletes the VM and its key pair, idempotently, retrying after creation settles", async () => {
  const plain = routedFetch([
    { method: "DELETE", path: "/v1/core/virtual-machines/7613", replies: [{ body: f("vm-deleted.json") }, { status: 404, body: f("vm-not-found.json") }] },
    { method: "DELETE", path: "/v1/core/keypair/5521", replies: [{ body: f("keypair-deleted.json") }, { status: 404, body: '{"status":false,"message":"Keypair not found","error_reason":"not_found"}' }] }
  ]);
  await hyperstackAdapter.destroy(creds, { vmId: 7613, keypairId: 5521 }, callOptions(plain.fetch));
  await hyperstackAdapter.destroy(creds, { vmId: 7613, keypairId: 5521 }, callOptions(plain.fetch));
  assert.equal(plain.seen.length, 4);

  const creating = routedFetch([
    {
      method: "DELETE",
      path: "/v1/core/virtual-machines/7613",
      replies: [{ status: 400, body: f("vm-creating-cannot-delete.json") }, { body: f("vm-deleted.json") }]
    },
    { path: "/v1/core/virtual-machines/7613", replies: [{ body: f("vm-get.json") }] },
    { path: "/v1/core/keypairs?search=orq-box-0123abcd", replies: [{ body: f("keypairs-search.json") }] },
    { method: "DELETE", path: "/v1/core/keypair/5521", replies: [{ body: f("keypair-deleted.json") }] }
  ]);
  // A ref from listManaged: the key pair is found by its exact name.
  await hyperstackAdapter.destroy(creds, { vmId: 7613, keyName: "orq-box-0123abcd" }, callOptions(creating.fetch));
  assert.deepEqual(
    creating.seen.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    [
      "DELETE /v1/core/virtual-machines/7613",
      "GET /v1/core/virtual-machines/7613",
      "DELETE /v1/core/virtual-machines/7613",
      "GET /v1/core/keypairs",
      "DELETE /v1/core/keypair/5521"
    ]
  );
});

test("hyperstack: listManaged keeps labelled or orq- named VMs", async () => {
  const { fetch, seen } = routedFetch([{ path: "/v1/core/virtual-machines?page=1&pageSize=100", replies: [{ body: f("vms-list.json") }] }]);
  const managed = await hyperstackAdapter.listManaged(creds, callOptions(fetch));
  assert.equal(seen.length, 1);
  assert.deepEqual(
    managed.map((vm) => [vm.ref.vmId, vm.boxId, vm.state, vm.ref.keyName]),
    [
      [7613, "box-0123abcd", "running", "orq-box-0123abcd"],
      [7615, "box-99887766", "stopped", "orq-box-99887766"]
    ]
  );
});

test("hyperstack: helpers pick the newest CUDA image and name environments; 429 is retried", async () => {
  assert.equal(
    pickHyperstackImage([
      "Ubuntu Server 22.04 LTS R535 CUDA 12.2 with Docker",
      "Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker",
      "Ubuntu Server 24.04 LTS (Noble Numbat)",
      "Windows Server 2022"
    ]),
    "Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker"
  );
  assert.equal(pickHyperstackImage(["Windows Server 2022"]), null);
  assert.equal(hyperstackEnvironmentName("NORWAY-1"), "orquester-norway-1");

  const { fetch, seen } = routedFetch([
    { path: "/v1/core/environments", replies: [{ status: 429, headers: { "retry-after": "0" }, body: "" }, { body: f("environments.json") }] }
  ]);
  assert.deepEqual(await hyperstackAdapter.validate(creds, callOptions(fetch)), { ok: true });
  assert.equal(seen.length, 2);
});
