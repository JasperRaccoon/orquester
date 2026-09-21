import test from "node:test";
import assert from "node:assert/strict";
import type { ModelSelection, ProviderModel } from "@orquester/api/agent-chat";

import {
  applyEffortArgument,
  applyModelSelection,
  applyOptionSelection,
  currentOptionValue,
  findReasoningDescriptor,
  modelChipLabel,
  optionChoiceLabel,
  resolveSelectedModel
} from "./composer-model.ts";

const EFFORT = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra high" }
  ]
};

const FAST = { id: "fastMode", label: "Fast mode", type: "boolean" as const };

const OPUS: ProviderModel = {
  slug: "claude-opus-5",
  name: "Claude Opus 5",
  shortName: "Opus 5",
  capabilities: { optionDescriptors: [EFFORT, FAST] }
};

const HAIKU: ProviderModel = {
  slug: "claude-haiku-5",
  name: "Claude Haiku 5",
  isDefault: true,
  capabilities: null
};

test("the reasoning descriptor is found under any of the four adapters' ids", () => {
  assert.equal(findReasoningDescriptor(OPUS)?.id, "effort");
  assert.equal(
    findReasoningDescriptor({
      ...HAIKU,
      capabilities: {
        optionDescriptors: [{ id: "variant", label: "Reasoning", type: "select", options: [] }]
      }
    })?.id,
    "variant"
  );
  assert.equal(findReasoningDescriptor(HAIKU), null);
  assert.equal(findReasoningDescriptor(null), null);
});

test("a boolean descriptor is never mistaken for the reasoning select", () => {
  assert.equal(
    findReasoningDescriptor({
      ...HAIKU,
      capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "boolean" }] }
    }),
    null
  );
});

test("the selected model falls back to the provider default, then to the first", () => {
  assert.equal(resolveSelectedModel([OPUS, HAIKU], { model: "claude-opus-5" })?.slug, "claude-opus-5");
  assert.equal(resolveSelectedModel([OPUS, HAIKU], { model: "gone" })?.slug, "claude-haiku-5");
  assert.equal(resolveSelectedModel([OPUS], null)?.slug, "claude-opus-5");
  assert.equal(resolveSelectedModel([], null), null);
});

test("the chip label prefers the short name and never goes blank", () => {
  assert.equal(modelChipLabel(OPUS, null), "Opus 5");
  assert.equal(modelChipLabel(HAIKU, null), "Claude Haiku 5");
  assert.equal(modelChipLabel(null, { model: "raw-slug" }), "raw-slug");
  assert.equal(modelChipLabel(null, null), "Model");
});

test("an unset option reads the descriptor's default, then its currentValue", () => {
  assert.equal(currentOptionValue(null, EFFORT), "high");
  assert.equal(currentOptionValue({ model: "x", options: [{ id: "effort", value: "low" }] }, EFFORT), "low");
  assert.equal(currentOptionValue(null, { ...FAST, currentValue: true }), true);
  assert.equal(currentOptionValue(null, FAST), undefined);
});

test("a choice label resolves, and an unknown value prints itself", () => {
  assert.equal(optionChoiceLabel(EFFORT, "xhigh"), "Extra high");
  assert.equal(optionChoiceLabel(EFFORT, "mystery"), "mystery");
  assert.equal(optionChoiceLabel(EFFORT, true), null);
});

test("setting an option adds it, then replaces it in place", () => {
  const base: ModelSelection = { model: "claude-opus-5" };
  const withEffort = applyOptionSelection(base, "effort", "low");
  assert.deepEqual(withEffort.options, [{ id: "effort", value: "low" }]);
  const changed = applyOptionSelection(withEffort, "effort", "xhigh");
  assert.deepEqual(changed.options, [{ id: "effort", value: "xhigh" }]);
});

test("a no-op edit returns the SAME object, so it cannot restart a session", () => {
  const selection: ModelSelection = { model: "m", options: [{ id: "effort", value: "low" }] };
  assert.equal(applyOptionSelection(selection, "effort", "low"), selection);
});

test("switching model drops options the new model does not advertise", () => {
  const selection: ModelSelection = {
    instanceId: "claude:acc1",
    model: "claude-opus-5",
    options: [
      { id: "effort", value: "low" },
      { id: "fastMode", value: true }
    ]
  };
  const switched = applyModelSelection(selection, HAIKU);
  assert.deepEqual(switched, { instanceId: "claude:acc1", model: "claude-haiku-5" });
  // Back to a model that does advertise them: nothing is invented.
  assert.deepEqual(applyModelSelection(switched, OPUS), {
    instanceId: "claude:acc1",
    model: "claude-opus-5"
  });
});

test("an option whose value is no longer a valid choice is dropped too", () => {
  const selection: ModelSelection = {
    model: "claude-opus-5",
    options: [{ id: "effort", value: "ultra" }]
  };
  assert.deepEqual(applyModelSelection(selection, OPUS), { model: "claude-opus-5" });
});

test("re-picking the current model returns the SAME object", () => {
  const selection: ModelSelection = {
    model: "claude-opus-5",
    options: [{ id: "effort", value: "low" }]
  };
  assert.equal(applyModelSelection(selection, OPUS), selection);
});

test("/effort <id> matches by id or label and refuses anything else", () => {
  const selection: ModelSelection = { model: "claude-opus-5" };
  assert.deepEqual(applyEffortArgument(selection, EFFORT, "XHIGH")?.options, [
    { id: "effort", value: "xhigh" }
  ]);
  assert.deepEqual(applyEffortArgument(selection, EFFORT, " extra high ")?.options, [
    { id: "effort", value: "xhigh" }
  ]);
  assert.equal(applyEffortArgument(selection, EFFORT, "ludicrous"), null);
  assert.equal(applyEffortArgument(selection, EFFORT, "  "), null);
});
