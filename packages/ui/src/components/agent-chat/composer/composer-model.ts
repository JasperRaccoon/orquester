/**
 * The model chip's selection maths (spec §7.4, §4.6.5(a)).
 *
 * `ModelSelection` is `{instanceId?, model, options?}` and a **deep-equality
 * change of the whole object restarts a Claude session** (§3.4), so every
 * edit here rebuilds it deliberately rather than mutating in place, and an
 * edit that changes nothing returns the identical object so a no-op click
 * cannot restart a session.
 */

import type {
  ModelSelection,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderOptionSelectionValue,
  SelectProviderOptionDescriptor
} from "@orquester/api/agent-chat";

/**
 * The descriptor ids the four adapters use for reasoning effort: Claude and
 * Codex `effort`, Grok `reasoningEffort`, OpenCode `variant` (labelled
 * "Reasoning"). `/effort` writes exactly this one option and nothing else.
 */
export const REASONING_OPTION_IDS: readonly string[] = ["effort", "reasoningEffort", "variant"];

export function optionDescriptors(model: ProviderModel | null): ProviderOptionDescriptor[] {
  return model?.capabilities?.optionDescriptors ?? [];
}

/** The reasoning select of a model, or `null` — what gates `/effort` (§4.6.7). */
export function findReasoningDescriptor(
  model: ProviderModel | null
): SelectProviderOptionDescriptor | null {
  for (const descriptor of optionDescriptors(model)) {
    if (descriptor.type === "select" && REASONING_OPTION_IDS.includes(descriptor.id)) {
      return descriptor;
    }
  }
  return null;
}

export function resolveSelectedModel(
  models: readonly ProviderModel[],
  selection: ModelSelection | null
): ProviderModel | null {
  if (selection) {
    const exact = models.find((model) => model.slug === selection.model);
    if (exact) return exact;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

/** What the chip reads. Falls back to the raw slug so it is never blank. */
export function modelChipLabel(
  model: ProviderModel | null,
  selection: ModelSelection | null
): string {
  return model?.shortName ?? model?.name ?? selection?.model ?? "Model";
}

/** The descriptor's current value: the selection first, the descriptor's own default behind it. */
export function currentOptionValue(
  selection: ModelSelection | null,
  descriptor: ProviderOptionDescriptor
): ProviderOptionSelectionValue | undefined {
  const selected = selection?.options?.find((option) => option.id === descriptor.id);
  if (selected) return selected.value;
  if (descriptor.type === "select") {
    return descriptor.currentValue ?? descriptor.options.find((choice) => choice.isDefault)?.id;
  }
  return descriptor.currentValue;
}

export function optionChoiceLabel(
  descriptor: SelectProviderOptionDescriptor,
  value: ProviderOptionSelectionValue | undefined
): string | null {
  if (typeof value !== "string") return null;
  return descriptor.options.find((choice) => choice.id === value)?.label ?? value;
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  if (left.model !== right.model || left.instanceId !== right.instanceId) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) return false;
  return leftOptions.every(
    (option, index) =>
      option.id === rightOptions[index]?.id && option.value === rightOptions[index]?.value
  );
}

/** Returns the SAME object when nothing changed — a no-op must not restart a session. */
export function applyOptionSelection(
  selection: ModelSelection,
  id: string,
  value: ProviderOptionSelectionValue
): ModelSelection {
  const options = selection.options ?? [];
  const next = options.some((option) => option.id === id)
    ? options.map((option) => (option.id === id ? { id, value } : option))
    : [...options, { id, value }];
  const candidate: ModelSelection = { ...selection, options: next };
  return sameSelection(selection, candidate) ? selection : candidate;
}

/**
 * Switch the model, dropping any option the new model does not advertise.
 *
 * Carrying a stale `variant` or `effort` across a model switch is how a thread
 * ends up pinned to an option its model has never heard of — the provider
 * either rejects the turn or silently ignores it, and neither is visible.
 */
export function applyModelSelection(
  selection: ModelSelection | null,
  model: ProviderModel
): ModelSelection {
  const descriptors = optionDescriptors(model);
  const kept = (selection?.options ?? []).filter((option) =>
    descriptors.some((descriptor) => {
      if (descriptor.id !== option.id) return false;
      if (descriptor.type === "boolean") return typeof option.value === "boolean";
      return (
        typeof option.value === "string" &&
        descriptor.options.some((choice) => choice.id === option.value)
      );
    })
  );
  const candidate: ModelSelection = {
    ...(selection?.instanceId !== undefined ? { instanceId: selection.instanceId } : {}),
    model: model.slug,
    ...(kept.length > 0 ? { options: kept } : {})
  };
  return selection && sameSelection(selection, candidate) ? selection : candidate;
}

/**
 * `/effort <id>` applies directly (§4.6.5(a)). The id is matched against the
 * descriptor's own choices — by id first, then case-insensitively by label —
 * and an unknown one is refused rather than written through, because a bogus
 * effort silently degrades every later turn.
 */
export function applyEffortArgument(
  selection: ModelSelection,
  descriptor: SelectProviderOptionDescriptor,
  argument: string
): ModelSelection | null {
  const wanted = argument.trim().toLowerCase();
  if (!wanted) return null;
  const choice =
    descriptor.options.find((entry) => entry.id.toLowerCase() === wanted) ??
    descriptor.options.find((entry) => entry.label.toLowerCase() === wanted);
  if (!choice) return null;
  return applyOptionSelection(selection, descriptor.id, choice.id);
}
