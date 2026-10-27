// Missing credentials are refused at the adapter boundary before any network request.

import assert from "node:assert/strict";
import { test } from "node:test";

import { GPU_PROVIDER_ADAPTERS } from "./gpu-providers.ts";
import { callOptions, routedFetch } from "./gpu-testing.ts";
import { tableHourlyUsd } from "./gpu-price-tables.ts";

test("gpu providers: validate with no credentials answers ok:false without a request", async (t) => {
  const { fetch, seen } = routedFetch([]);
  for (const adapter of GPU_PROVIDER_ADAPTERS) {
    const result = await adapter.validate({}, callOptions(t, fetch));
    assert.equal(result.ok, false, adapter.id);
  }
  assert.equal(seen.length, 0);
});

test("gpu price tables: per-GPU price × count plus the per-box extra; unknown GPUs are null", () => {
  assert.equal(tableHourlyUsd("hyperstack", "RTX-A6000", 2), 1.007);
  assert.equal(tableHourlyUsd("jarvislabs", "L4", 1), 0.44);
  assert.equal(tableHourlyUsd("jarvislabs", "nope", 1), null);
  assert.equal(tableHourlyUsd("runpod", "anything", 1), null);
});
