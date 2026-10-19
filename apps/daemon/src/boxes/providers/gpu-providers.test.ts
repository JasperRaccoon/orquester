// The GPU adapter list as a whole: one adapter per GPU provider id, consistent static metadata,
// and the shared rules every adapter follows (no kinds outside the GPU ones, no secrets in
// credential metadata, validate never throwing for missing credentials).

import assert from "node:assert/strict";
import { test } from "node:test";

import { BOX_PROVIDER_IDS } from "@orquester/api";

import { GPU_PROVIDER_ADAPTERS } from "./gpu-providers.ts";
import { callOptions, routedFetch } from "./gpu-testing.ts";
import { tableHourlyUsd } from "./gpu-price-tables.ts";

const GPU_IDS = ["vastai", "runpod", "hyperstack", "thunder", "cloudrift", "massed", "jarvislabs", "tensordock"];

test("gpu providers: one adapter per GPU provider id with complete metadata", () => {
  assert.deepEqual(GPU_PROVIDER_ADAPTERS.map((adapter) => adapter.id).sort(), [...GPU_IDS].sort());
  for (const adapter of GPU_PROVIDER_ADAPTERS) {
    assert.ok((BOX_PROVIDER_IDS as readonly string[]).includes(adapter.id), adapter.id);
    assert.ok(adapter.label.length > 0, adapter.id);
    assert.match(adapter.website, /^https:\/\//, adapter.id);
    assert.match(adapter.credentialsUrl, /^https:\/\//, adapter.id);
    assert.ok(adapter.credentialFields.length > 0 && adapter.credentialFields.every((field) => field.secret), adapter.id);
    assert.equal(adapter.maxLifetimeMinutes, null, adapter.id);
    assert.equal(adapter.needsWindowsImage, false, adapter.id);
    assert.ok(adapter.kinds.every((kind) => kind === "linux-gpu"), `${adapter.id} rents only Linux + GPU`);
  }
  // Thunder has no unattended bootstrap; TensorDock's Windows image runs no first-boot script.
  assert.deepEqual(GPU_PROVIDER_ADAPTERS.find((adapter) => adapter.id === "thunder")!.kinds, []);
  assert.deepEqual(GPU_PROVIDER_ADAPTERS.find((adapter) => adapter.id === "tensordock")!.kinds, ["linux-gpu"]);
});

test("gpu providers: validate with no credentials answers ok:false without a request", async () => {
  const { fetch, seen } = routedFetch([]);
  for (const adapter of GPU_PROVIDER_ADAPTERS) {
    const result = await adapter.validate({}, callOptions(fetch));
    assert.equal(result.ok, false, adapter.id);
  }
  assert.equal(seen.length, 0);
});

test("gpu providers: offers for a non-GPU kind are empty without a request", async () => {
  const { fetch, seen } = routedFetch([]);
  for (const adapter of GPU_PROVIDER_ADAPTERS) {
    const offers = await adapter.offers({ apiKey: "x" }, "linux", callOptions(fetch));
    assert.deepEqual(offers.sizes, [], adapter.id);
  }
  assert.equal(seen.length, 0);
});

test("gpu price tables: per-GPU price × count plus the per-box extra; unknown GPUs are null", () => {
  assert.equal(tableHourlyUsd("hyperstack", "RTX-A6000", 2), 1.007);
  assert.equal(tableHourlyUsd("jarvislabs", "L4", 1), 0.44);
  assert.equal(tableHourlyUsd("jarvislabs", "nope", 1), null);
  assert.equal(tableHourlyUsd("runpod", "anything", 1), null);
});
