/**
 * The model chip's selection maths (spec §7.4, §4.6.5(a)).
 *
 * `ModelSelection` is `{instanceId?, model, options?}` and a **deep-equality
 * change of the whole object restarts a Claude session** (§3.4), so every
 * edit here rebuilds it deliberately rather than mutating in place, and an
 * edit that changes nothing returns the identical object so a no-op click
 * cannot restart a session.
 */

import {
  optionDescriptors,
  type ModelSelection,
  type ProviderModel,
  type ProviderOptionSelectionValue,
  type SelectProviderOptionDescriptor
} from "@orquester/api/agent-chat";

/**
 * The picker's read-side logic lives in `@orquester/api` (`agent-chat/model-selection.ts`) so
 * `list_agents` reports exactly what the composer shows (unified MCP design 2026-10-15 §4.1).
 */
export {
  REASONING_OPTION_IDS,
  currentOptionValue,
  findReasoningDescriptor,
  modelChipLabel,
  optionChoiceLabel,
  optionDescriptors,
  resolveSelectedModel
} from "@orquester/api/agent-chat";

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
