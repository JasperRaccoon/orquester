/** The OpenCode catalogue's context windows: the `limit.context` the meter divides by. */

import assert from "node:assert/strict";
import test from "node:test";

import { buildSnapshot, modelContextLimits } from "./snapshot.ts";
import type { OpenCodeInventory } from "./snapshot.ts";

test("each connected model carries its `limit.context` as its context window, when it states one", () => {
  const providers = {
    all: [
      {
        id: "local",
        name: "Local",
        models: {
          small: { id: "small", name: "Small", limit: { context: 32_768, output: 4_096 } },
          nolimit: { id: "nolimit", name: "No limit" },
          zero: { id: "zero", name: "Zero", limit: { context: 0 } }
        }
      }
    ],
    connected: ["local"],
    default: {}
  };
  const inventory = { providers, agents: [], commands: [], skills: [] } as unknown as OpenCodeInventory;
  const models = buildSnapshot({ version: "1.18.32", checkedAt: "2026-10-22T00:00:00.000Z", inventory }).models;
  assert.deepEqual(
    models.map((model) => [model.slug, model.contextWindow]),
    [
      ["local/nolimit", undefined],
      ["local/small", 32_768],
      ["local/zero", undefined]
    ]
  );
  // The meter's denominators agree.
  assert.equal(modelContextLimits(inventory.providers).get("local/small"), 32_768);
});
