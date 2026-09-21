import test from "node:test";
import assert from "node:assert/strict";

import type { ProviderModel } from "@orquester/api/agent-chat";

import {
  LAUNCH_MODEL_CHIP_LIMIT,
  groupModelsByProvider,
  launchModelList,
  modelDisplayName,
  modelProviderOf,
  resolveLaunchModel
} from "./launch-models.ts";

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
  assert.ok(resolved && resolved.length > 0);
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

test("two models flagged default resolve deterministically to catalogue order", () => {
  // OpenCode really does flag two; "the default" must not depend on luck.
  const twoDefaults = [
    model("first", { isDefault: true }),
    model("second", { isDefault: true })
  ];
  assert.equal(resolveLaunchModel({ snapshot: { models: twoDefaults } }), "first");
});

test("no default flag at all falls back to the first entry", () => {
  assert.equal(resolveLaunchModel({ snapshot: { models: [model("only")] } }), "only");
});

test("no catalogue yields null, so the caller can refuse instead of posting", () => {
  assert.equal(resolveLaunchModel({ snapshot: null }), null);
  assert.equal(resolveLaunchModel({ snapshot: { models: [] } }), null);
  assert.equal(resolveLaunchModel({ snapshot: null, preferred: "x" }), null);
});

/* ── the picker ─────────────────────────────────────────────────────────── */

const big = Array.from({ length: 378 }, (_, i) =>
  model(i === 0 ? "opencode/big-pickle" : `openrouter/vendor-${i}/model-${i}`, {
    name: `Model ${i}`,
    ...(i === 0 ? { isDefault: true } : {})
  })
);

test("a 378-model catalogue never renders as 378 chips", () => {
  const list = launchModelList({ models: big, selected: "opencode/big-pickle" });
  assert.ok(list.shown.length <= LAUNCH_MODEL_CHIP_LIMIT, `${list.shown.length} chips`);
  assert.equal(list.hidden, 378 - list.shown.length);
  assert.equal(list.searchable, true);
});

test("the selected model is always shown, even when a query excludes it", () => {
  const list = launchModelList({
    models: big,
    selected: "opencode/big-pickle",
    query: "vendor-7/"
  });
  assert.equal(list.shown[0]?.slug, "opencode/big-pickle");
  assert.ok(list.shown.slice(1).every((choice) => choice.slug.includes("vendor-7/")));
});

test("the catalogue default stays one click away when it is not the selection", () => {
  const list = launchModelList({ models: big, selected: "openrouter/vendor-5/model-5" });
  assert.deepEqual(
    list.shown.slice(0, 2).map((choice) => choice.slug),
    ["openrouter/vendor-5/model-5", "opencode/big-pickle"]
  );
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

test("a small catalogue is not searchable and shows everything", () => {
  const list = launchModelList({ models: catalogue, selected: null });
  assert.equal(list.searchable, false);
  assert.equal(list.hidden, 0);
  assert.equal(list.shown.length, catalogue.length);
});

test("a search is capped, so one character cannot render the catalogue", () => {
  const list = launchModelList({ models: big, selected: null, query: "model" });
  assert.ok(list.shown.length <= LAUNCH_MODEL_CHIP_LIMIT * 4);
  assert.ok(list.hidden > 0);
});

/* ── naming and grouping ────────────────────────────────────────────────── */

test("a model reads by its catalogue name, matching the composer's chip", () => {
  // The launch menu showed raw slugs while the composer showed friendly names.
  assert.equal(modelDisplayName(model("x", { name: "GPT-5.6-Luna" })), "GPT-5.6-Luna");
  assert.equal(
    modelDisplayName(model("x", { name: "Long", shortName: "Short" })),
    "Short"
  );
  // No name at all: the last meaningful slug segment beats the whole path.
  assert.equal(
    modelDisplayName({ slug: "openrouter/anthropic/claude-3-haiku", name: "" } as ProviderModel),
    "claude-3-haiku"
  );
});

test("the provider is the segment before the first slash, or none", () => {
  assert.equal(modelProviderOf("openrouter/anthropic/claude-3-haiku"), "openrouter");
  assert.equal(modelProviderOf("big-pickle"), null);
  assert.equal(modelProviderOf("/leading"), null);
});

test("grouping keeps catalogue order of first appearance", () => {
  const groups = groupModelsByProvider([
    model("openrouter/a"),
    model("bare"),
    model("openrouter/b")
  ]);
  assert.deepEqual(
    groups.map((group) => [group.provider, group.models.length]),
    [
      ["openrouter", 2],
      [null, 1]
    ]
  );
});
