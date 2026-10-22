/** The Grok catalogue as `initialize._meta.modelState` states it: models, defaults and windows. */

import assert from "node:assert/strict";
import test from "node:test";

import type { InitializeResponse } from "./acp/_generated/schema.ts";
import { modelsFromInitialize } from "./probe.ts";

test("each model carries its `totalContextTokens` as its context window, when it states one", () => {
  const initialize = {
    protocolVersion: 1,
    _meta: {
      modelState: {
        currentModelId: "grok-code",
        availableModels: [
          { modelId: "grok-code", name: "Grok Code", _meta: { totalContextTokens: 500_000 } },
          { modelId: "grok-mini", name: "Grok Mini", _meta: { totalContextTokens: "lots" } },
          { modelId: "grok-old", name: "Grok Old", _meta: { totalContextTokens: 0 } },
          { modelId: "grok-bare", name: "Grok Bare" }
        ]
      }
    }
  } as unknown as InitializeResponse;
  const models = modelsFromInitialize(initialize);
  assert.deepEqual(
    models.map((model) => [model.slug, model.contextWindow, model.isDefault === true]),
    [
      ["grok-code", 500_000, true],
      ["grok-mini", undefined, false],
      ["grok-old", undefined, false],
      ["grok-bare", undefined, false]
    ]
  );
});
