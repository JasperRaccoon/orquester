/**
 * The picker's model/default contracts (unified MCP design 2026-10-15 §4.1, D-20, D-23).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel, ProviderSnapshot } from "./adapter-types.ts";
import {
  defaultOptionValues,
  modelPickerHint,
  providerPickerView,
  resolveLaunchModel,
  resolveSelectedModel
} from "./model-selection.ts";

const OPUS: ProviderModel = {
  slug: "claude-opus-5",
  name: "Claude Opus 5",
  shortName: "Opus 5",
  isDefault: true,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true }
        ]
      },
      { id: "fastMode", label: "Fast mode", description: "Faster output", type: "boolean", currentValue: false }
    ]
  }
};
const HAIKU: ProviderModel = { slug: "claude-haiku-5", name: "Claude Haiku 5", subProvider: "Anthropic", capabilities: null };
const OLD: ProviderModel = { slug: "claude-3", name: "Claude 3", isLegacy: true, capabilities: { optionDescriptors: [] } };

/** The fixture snapshot both views are derived from. */
const SNAPSHOT: Pick<ProviderSnapshot, "status" | "models"> = { status: "ready", models: [OLD, HAIKU, OPUS] };

test("the fixture's picker view, exactly", () => {
  assert.deepEqual(providerPickerView(SNAPSHOT, { includeLegacy: true }), {
    status: "ready",
    catalogueLoading: false,
    defaultModel: "claude-opus-5",
    models: [
      { slug: "claude-3", name: "Claude 3", shortName: "Claude 3", hint: "legacy", isDefault: false, isLegacy: true, options: [] },
      { slug: "claude-haiku-5", name: "Claude Haiku 5", shortName: "Claude Haiku 5", subProvider: "Anthropic", hint: "Anthropic", isDefault: false, options: [] },
      {
        slug: "claude-opus-5",
        name: "Claude Opus 5",
        shortName: "Opus 5",
        isDefault: true,
        options: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            values: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true }
            ],
            default: "high"
          },
          { id: "fastMode", label: "Fast mode", type: "boolean", description: "Faster output", default: false }
        ]
      }
    ]
  });
});

test("a legacy model is never the default, but one named explicitly is honoured (D-23)", () => {
  assert.equal(resolveSelectedModel([OLD, HAIKU], null)?.slug, "claude-haiku-5");
  assert.equal(resolveSelectedModel([{ ...OLD, isDefault: true }, HAIKU], null)?.slug, "claude-haiku-5");
  assert.equal(resolveSelectedModel([OLD, HAIKU], { model: "claude-3" })?.slug, "claude-3");
  assert.equal(resolveSelectedModel([OLD], null)?.slug, "claude-3", "only legacy models: the first");
  assert.equal(resolveSelectedModel([], null), null);
  assert.equal(modelPickerHint(OLD), "legacy");
});

test("option defaults resolve as the composer's chips do", () => {
  assert.deepEqual(defaultOptionValues(OPUS), { effort: "high", fastMode: false });
  assert.deepEqual(defaultOptionValues(null), {});
});

test("an empty catalogue from a ready provider reads as still loading", () => {
  assert.equal(providerPickerView({ status: "ready", models: [] }).catalogueLoading, true);
  assert.equal(providerPickerView({ status: "error", models: [] }).catalogueLoading, false);
  assert.equal(providerPickerView({ status: "ready", models: [] }).defaultModel, null);
});

test("resolveLaunchModel: the one choice both the launch and the reported default use", () => {
  const models = SNAPSHOT.models;
  assert.equal(resolveLaunchModel(models)?.slug, "claude-opus-5");
  assert.equal(resolveLaunchModel(models, "")?.slug, "claude-opus-5");
  assert.equal(resolveLaunchModel(models, "claude-3")?.isLegacy, true, "a legacy model named explicitly");
  assert.equal(resolveLaunchModel(models, "nope"), null);
  assert.equal(resolveLaunchModel([]), null);
});
