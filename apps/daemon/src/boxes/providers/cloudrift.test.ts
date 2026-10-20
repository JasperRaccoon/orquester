// CloudRift adapter. `instance-types.json` and `recipes.json` were recorded from CloudRift's public
// (unauthenticated) catalog endpoints on 2026-10-20, trimmed to three types; their availability
// and kernel-module fields were set by hand so the test has stock to offer. The instance, rent and
// terminate bodies follow the OpenAPI spec (api.cloudrift.ai/api-docs/openapi.json); the plain-text
// errors are the API's documented wording. No live account was used. Stubbed fetch only.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { CLOUDRIFT_PROTOCOL, cloudriftAdapter, pickCloudriftImage } from "./cloudrift.ts";
import { detachedStartCommand } from "./gpu-common.ts";
import { callOptions, fixture, routedFetch, sampleCreateRequest } from "./gpu-testing.ts";

const creds = { apiKey: "rift_secret_key_123" };
const f = (name: string): string => fixture("cloudrift", name);
const recipes = JSON.parse(f("recipes.json")).data.groups.flatMap((group: { recipes: unknown[] }) => group.recipes);
const imageOf = (name: string): string => recipes.find((recipe: { name: string }) => recipe.name === name).details.VirtualMachine.image_url;
const text = (status: number, body: string) => ({ status, body, headers: { "content-type": "text/plain" } });

test("cloudrift: validate posts /auth/me with X-API-Key; a bad key never leaks into the message", async () => {
  const good = routedFetch([{ method: "POST", path: "/api/v1/auth/me", replies: [{ body: f("auth-me.json") }] }]);
  assert.deepEqual(await cloudriftAdapter.validate(creds, callOptions(good.fetch)), { ok: true });
  assert.equal(good.seen[0]!.headers["x-api-key"], "rift_secret_key_123");

  const bad = routedFetch([{ method: "POST", path: "/api/v1/auth/me", replies: [text(403, "API key rift_secret_key_123 not found")] }]);
  const result = await cloudriftAdapter.validate(creds, callOptions(bad.fetch));
  assert.equal(result.ok, false);
  const message = (result as { message: string }).message;
  assert.match(message, /API key … not found/);
  assert.ok(!message.includes("rift_secret_key_123"));
});

test("cloudrift: offers list GPU variants with a free node, priced from cents", async () => {
  const { fetch, seen } = routedFetch([{ method: "POST", path: "/api/v1/instance-types/list", replies: [{ body: f("instance-types.json") }] }]);
  const offers = await cloudriftAdapter.offers(creds, "linux-gpu", callOptions(fetch));
  assert.deepEqual(seen[0]!.body, {
    version: CLOUDRIFT_PROTOCOL,
    data: { selector: { ByServiceAndLocation: { services: ["vm"], datacenters: null } } }
  });
  assert.deepEqual(
    offers.sizes.map((size) => [size.id, size.hourlyUsd, size.regions]),
    [
      ["rtx49-7c-kn.1", 0.388, ["any", "ap-east-tw-kn-2"]],
      ["rtx59-16c-nr.1", 0.624, ["any", "us-east-nc-nr-1"]]
    ]
  );
  const rtx5090 = offers.sizes[1]!;
  assert.deepEqual(rtx5090.gpu, { model: "RTX 5090", count: 1, vramGb: 32 });
  assert.equal(rtx5090.vcpu, 30);
  assert.equal(rtx5090.ramGb, 100);
  assert.equal(rtx5090.diskGb, 1000);
  assert.deepEqual(
    offers.regions.map((region) => [region.id, region.country]),
    [
      ["any", null],
      ["ap-east-tw-kn-2", "TWN"],
      ["us-east-nc-nr-1", "USA"]
    ]
  );
});

test("cloudrift: create rents once with the right driver image, one-line cloud-init command, name and tag", async () => {
  const { fetch, seen } = routedFetch([
    { method: "POST", path: "/api/v1/instance-types/list", replies: [{ body: f("instance-types.json") }] },
    { method: "POST", path: "/api/v1/recipes/list", replies: [{ body: f("recipes.json") }] },
    { method: "POST", path: "/api/v1/instances/rent", replies: [{ status: 201, body: f("rent.json") }] }
  ]);
  const request = sampleCreateRequest({ size: "rtx49-7c-kn.1", region: "any" });
  const result = await cloudriftAdapter.create(creds, request, callOptions(fetch));
  const rents = seen.filter((call) => call.url.endsWith("/instances/rent"));
  assert.equal(rents.length, 1);
  const data = (rents[0]!.body as { data: Record<string, unknown> }).data;
  assert.deepEqual(data.selector, { ByInstanceTypeAndLocation: { instance_type: "rtx49-7c-kn.1", datacenters: ["ap-east-tw-kn-2"] } });
  const vm = (data.config as { VirtualMachine: Record<string, unknown> }).VirtualMachine;
  // This type loads only proprietary kernel modules.
  assert.equal(vm.image_url, imageOf("Ubuntu 24.04 Server (R580 proprietary, CUDA 12.9)"));
  assert.equal(vm.cloudinit_commands, detachedStartCommand(request.bootstrap.posixScript));
  assert.deepEqual(vm.ssh_key, { PublicKeys: [request.sshPublicKey] });
  assert.equal(data.with_public_ip, true);
  assert.equal(data.name, "orq-box-0123abcd");
  assert.deepEqual(data.tags, ["orquester-box=box-0123abcd"]);
  assert.deepEqual(result, { ref: { instanceId: "f8c403e6-3a1b-4c55-9d0e-7b2a1c9e0d11", instanceType: "rtx49-7c-kn.1" }, hourlyUsd: 0.388 });
});

test("cloudrift: create fails without a free node and never retries a failed rent", async () => {
  const busy = routedFetch([
    { method: "POST", path: "/api/v1/instance-types/list", replies: [{ body: f("instance-types.json") }] },
    { method: "POST", path: "/api/v1/recipes/list", replies: [{ body: f("recipes.json") }] }
  ]);
  await assert.rejects(cloudriftAdapter.create(creds, sampleCreateRequest({ size: "rtx59-16c-nr.2", region: "any" }), callOptions(busy.fetch)), /no free/);
  await assert.rejects(cloudriftAdapter.create(creds, sampleCreateRequest({ size: "nope.1", region: "any" }), callOptions(busy.fetch)), /unknown instance type/);

  const failing = routedFetch([
    { method: "POST", path: "/api/v1/instance-types/list", replies: [{ body: f("instance-types.json") }] },
    { method: "POST", path: "/api/v1/recipes/list", replies: [{ body: f("recipes.json") }] },
    { method: "POST", path: "/api/v1/instances/rent", replies: [text(503, "NodeAllocationModeMixed")] }
  ]);
  await assert.rejects(
    cloudriftAdapter.create(creds, sampleCreateRequest({ size: "rtx59-16c-nr.1", region: "us-east-nc-nr-1" }), callOptions(failing.fetch)),
    /NodeAllocationModeMixed/
  );
  const rents = failing.seen.filter((call) => call.url.endsWith("/instances/rent"));
  assert.equal(rents.length, 1);
  const vm = (rents[0]!.body as { data: { config: { VirtualMachine: { image_url: string } }; with_public_ip: boolean } }).data;
  assert.equal(vm.config.VirtualMachine.image_url, imageOf("Ubuntu 24.04 Server (R580, CUDA 13.3)"), "open modules, newest CUDA");
  assert.equal(vm.with_public_ip, false, "that data center has no public IPs");
});

test("cloudrift: status by id; a missing instance is gone; Failed carries the user message", async () => {
  const active = routedFetch([{ method: "POST", path: "/api/v1/instances/list", replies: [{ body: f("list-one.json") }] }]);
  assert.deepEqual(await cloudriftAdapter.status(creds, { instanceId: "f8c403e6-3a1b-4c55-9d0e-7b2a1c9e0d11" }, callOptions(active.fetch)), {
    state: "running",
    detail: "Active",
    publicIp: "203.0.113.90",
    hourlyUsd: null
  });
  assert.deepEqual((active.seen[0]!.body as { data: { selector: unknown } }).data.selector, { ById: ["f8c403e6-3a1b-4c55-9d0e-7b2a1c9e0d11"] });

  const missing = routedFetch([{ method: "POST", path: "/api/v1/instances/list", replies: [{ body: f("list-empty.json") }] }]);
  assert.equal((await cloudriftAdapter.status(creds, { instanceId: "x" }, callOptions(missing.fetch))).state, "gone");

  const failed = routedFetch([{ method: "POST", path: "/api/v1/instances/list", replies: [{ body: f("list-by-status.json") }] }]);
  const status = await cloudriftAdapter.status(creds, { instanceId: "00000000-0000-4000-8000-000000000002" }, callOptions(failed.fetch));
  assert.deepEqual([status.state, status.detail], ["error", "The VM failed to boot"]);
});

test("cloudrift: destroy terminates; an empty terminated list is fine when the instance is gone", async () => {
  const ok = routedFetch([{ method: "POST", path: "/api/v1/instances/terminate", replies: [{ status: 201, body: f("terminate.json") }] }]);
  await cloudriftAdapter.destroy(creds, { instanceId: "f8c403e6-3a1b-4c55-9d0e-7b2a1c9e0d11" }, callOptions(ok.fetch));
  assert.equal(ok.seen.length, 1);

  const already = routedFetch([
    { method: "POST", path: "/api/v1/instances/terminate", replies: [{ status: 201, body: f("terminate-none.json") }] },
    { method: "POST", path: "/api/v1/instances/list", replies: [{ body: f("list-empty.json") }] }
  ]);
  await cloudriftAdapter.destroy(creds, { instanceId: "f8c403e6-3a1b-4c55-9d0e-7b2a1c9e0d11" }, callOptions(already.fetch));

  const stuck = routedFetch([
    { method: "POST", path: "/api/v1/instances/terminate", replies: [{ status: 201, body: f("terminate-none.json") }] },
    { method: "POST", path: "/api/v1/instances/list", replies: [{ body: f("list-one.json") }] }
  ]);
  await assert.rejects(cloudriftAdapter.destroy(creds, { instanceId: "f8c403e6-3a1b-4c55-9d0e-7b2a1c9e0d11" }, callOptions(stuck.fetch)), /did not stop/);
});

test("cloudrift: listManaged reads live statuses and keeps tagged or orq- named instances", async () => {
  const { fetch, seen } = routedFetch([{ method: "POST", path: "/api/v1/instances/list", replies: [{ body: f("list-by-status.json") }] }]);
  const managed = await cloudriftAdapter.listManaged(creds, callOptions(fetch));
  assert.deepEqual((seen[0]!.body as { data: { selector: unknown } }).data.selector, {
    ByStatus: { statuses: ["Initializing", "Active", "Deactivating", "Failed"] }
  });
  assert.deepEqual(
    managed.map((instance) => [instance.name, instance.boxId, instance.state]),
    [
      ["orq-box-0123abcd", "box-0123abcd", "running"],
      ["orq-box-99887766", "box-99887766", "error"]
    ]
  );
});

test("cloudrift: the start command is one line that decodes the script; image choice follows the driver rules; 429 retried", async () => {
  const command = detachedStartCommand("#!/bin/sh\necho 'hi'\n");
  assert.ok(!command.includes("\n"));
  const encoded = /echo (\S+) \| base64 -d/.exec(command)![1]!;
  // The script deletes its own file (it holds the bootstrap token) before anything else.
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "rm -f \"$0\"\n#!/bin/sh\necho 'hi'\n");
  assert.equal(pickCloudriftImage(recipes, "OpenOrProprietary"), imageOf("Ubuntu 24.04 Server (R580, CUDA 13.3)"));
  assert.equal(pickCloudriftImage([], "OpenOnly"), null);

  const { fetch, seen } = routedFetch([
    { method: "POST", path: "/api/v1/auth/me", replies: [{ status: 429, headers: { "retry-after": "0" }, body: "" }, { body: f("auth-me.json") }] }
  ]);
  assert.deepEqual(await cloudriftAdapter.validate(creds, callOptions(fetch)), { ok: true });
  assert.equal(seen.length, 2);
});
