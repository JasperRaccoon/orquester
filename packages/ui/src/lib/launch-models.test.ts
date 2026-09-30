import test from "node:test";
import assert from "node:assert/strict";

import type { ProviderModel } from "@orquester/api/agent-chat";

import { launchModelList, resolveLaunchModel } from "./launch-models.ts";

const model = (slug: string, over: Partial<ProviderModel> = {}): ProviderModel =>
  ({ slug, name: slug, capabilities: null, ...over }) as ProviderModel;

const catalogue = [
  model("gpt-5.6-luna", { name: "GPT-5.6-Luna" }),
  model("big-pickle", { name: "Big Pickle", isDefault: true }),
  model("openrouter/anthropic/claude-3-haiku", { name: "Claude 3 Haiku" })
];

test("a launch always names a model, so the host cannot refuse it", () => {
  // The regression: the project overview posted `{ model: "" }` and every
  // one-click launcher died with "modelSelection.model is required".
  const resolved = resolveLaunchModel({ snapshot: { models: catalogue } });
  assert.equal(resolved, "big-pickle");
});

test("the remembered pick wins while the catalogue still serves it", () => {
  assert.equal(
    resolveLaunchModel({ snapshot: { models: catalogue }, preferred: "gpt-5.6-luna" }),
    "gpt-5.6-luna"
  );
});

test("a remembered pick the catalogue dropped falls back to the default", () => {
  // Honouring it would fail at the provider instead of at the chip.
  assert.equal(
    resolveLaunchModel({ snapshot: { models: catalogue }, preferred: "retired-model" }),
    "big-pickle"
  );
});

test("no default flag at all falls back to the first entry", () => {
  assert.equal(resolveLaunchModel({ snapshot: { models: [model("only")] } }), "only");
});

test("no catalogue yields null, so the caller can refuse instead of posting", () => {
  assert.equal(resolveLaunchModel({ snapshot: null }), null);
  assert.equal(resolveLaunchModel({ snapshot: { models: [] } }), null);
  assert.equal(resolveLaunchModel({ snapshot: null, preferred: "x" }), null);
});

test("the selected model is always shown, even when a query excludes it", () => {
  const list = launchModelList({
    models: catalogue,
    selected: "big-pickle",
    query: "haiku"
  });
  assert.deepEqual(new Set(list.shown.map((choice) => choice.slug)), new Set([
    "big-pickle", "openrouter/anthropic/claude-3-haiku"
  ]));
});

test("search matches the slug or the display name, case-insensitively", () => {
  const list = launchModelList({ models: catalogue, selected: null, query: "HAIKU" });
  assert.deepEqual(
    list.shown.map((choice) => choice.slug),
    ["openrouter/anthropic/claude-3-haiku"]
  );
  const byName = launchModelList({ models: catalogue, selected: null, query: "big pickle" });
  assert.deepEqual(
    byName.shown.map((choice) => choice.slug),
    ["big-pickle"]
  );
});

test("a query with no match shows nothing but the selection", () => {
  const list = launchModelList({ models: catalogue, selected: "big-pickle", query: "zzz" });
  assert.deepEqual(
    list.shown.map((choice) => choice.slug),
    ["big-pickle"]
  );
  assert.equal(list.hidden, 0);
});
