/**
 * Agent chat — the composer picker's model logic (moved from `packages/ui`'s `composer-model.ts`;
 * unified MCP design 2026-10-15 §4.1, D-20).
 *
 * One source for what the composer's model chip shows and what `list_agents` reports to agents:
 * which model a launch naming none gets, a model's chip label and picker hint, and each option's
 * current value. The UI re-exports these; {@link providerPickerView} is the catalogue as the
 * picker presents it, which `list_agents` reports.
 */

import type {
  ModelSelection,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderOptionSelectionValue,
  ProviderSnapshot,
  RuntimeMode,
  SelectProviderOptionDescriptor
} from "./adapter-types.ts";

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
export function findReasoningDescriptor(model: ProviderModel | null): SelectProviderOptionDescriptor | null {
  for (const descriptor of optionDescriptors(model)) {
    if (descriptor.type === "select" && REASONING_OPTION_IDS.includes(descriptor.id)) {
      return descriptor;
    }
  }
  return null;
}

/**
 * The model a selection names, else the default — the provider's `isDefault` model that is not
 * legacy, else its first non-legacy model, else its first model (D-23: a legacy model is never
 * chosen by default, but one named explicitly is honoured).
 *
 * **Behaviour change (D-23)** from the UI copy it replaced, which fell back to `isDefault ??
 * models[0]` legacy or not: a provider whose default-flagged or first model is legacy now gets its
 * first non-legacy model as the composer's default. Identical for every catalogue without legacy
 * models.
 */
export function resolveSelectedModel(models: readonly ProviderModel[], selection: ModelSelection | null): ProviderModel | null {
  if (selection) {
    const exact = models.find((model) => model.slug === selection.model);
    if (exact) return exact;
  }
  return (
    models.find((model) => model.isDefault === true && model.isLegacy !== true) ??
    models.find((model) => model.isLegacy !== true) ??
    models[0] ??
    null
  );
}

/**
 * THE model a launch gets — the one function `create_session` / `update_session` (Task 8) and
 * `list_agents`' `defaultModel` (Task 9, via {@link providerPickerView}) must both use, so the
 * reported default is exactly what a launch naming no model gets: `requested` when it names a
 * catalogue model (legacy included — D-23, marked by `isLegacy`), null for an unknown slug (the
 * caller refuses or passes it through as today), else the {@link resolveSelectedModel} default.
 */
export function resolveLaunchModel(models: readonly ProviderModel[], requested?: string | null): ProviderModel | null {
  if (requested !== undefined && requested !== null && requested !== "") {
    return models.find((model) => model.slug === requested) ?? null;
  }
  return resolveSelectedModel(models, null);
}

/** What the chip reads. Falls back to the raw slug so it is never blank. */
export function modelChipLabel(model: ProviderModel | null, selection: ModelSelection | null): string {
  return model?.shortName ?? model?.name ?? selection?.model ?? "Model";
}

/** The picker row's hint: the sub-provider, else "legacy" for a legacy model. */
export function modelPickerHint(model: ProviderModel): string | undefined {
  return model.subProvider ?? (model.isLegacy ? "legacy" : undefined);
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

/** Every option's value a launch naming no options gets: `currentOptionValue` with no selection. */
export function defaultOptionValues(model: ProviderModel | null): Record<string, ProviderOptionSelectionValue> {
  const out: Record<string, ProviderOptionSelectionValue> = {};
  for (const descriptor of optionDescriptors(model)) {
    const value = currentOptionValue(null, descriptor);
    if (value !== undefined) out[descriptor.id] = value;
  }
  return out;
}

export function optionChoiceLabel(
  descriptor: SelectProviderOptionDescriptor,
  value: ProviderOptionSelectionValue | undefined
): string | null {
  if (typeof value !== "string") return null;
  return descriptor.options.find((choice) => choice.id === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

/** Short chip labels for the four permission modes (§4.4's own column headings). */
export const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access"
};

/** One-line explanation of each mode (the launcher chip's title; `list_agents`' mode hints). */
export const RUNTIME_MODE_HINTS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Every tool call asks you first.",
  "auto-accept-edits": "File edits apply without asking; commands still ask.",
  auto: "The agent reviews its own work where the provider supports it; otherwise supervised.",
  "full-access": "Nothing asks. The agent may run any command in this project."
};

/** The composer's permission menu hints: shorter, no full stop. */
export const RUNTIME_MODE_SHORT_HINTS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Every tool call asks first",
  "auto-accept-edits": "File edits apply without asking",
  auto: "The provider reviews its own work where it can",
  "full-access": "Nothing asks. Commands run unsupervised"
};

// ---------------------------------------------------------------------------
// The picker view (what `list_agents` reports, spec §4.1)
// ---------------------------------------------------------------------------

export interface PickerOptionView {
  id: string;
  label: string;
  type: "select" | "boolean";
  description?: string;
  /** A select's choices. */
  values?: { id: string; label: string; description?: string; isDefault?: boolean }[];
  /** The value a launch naming no options gets ({@link currentOptionValue} with no selection). */
  default?: ProviderOptionSelectionValue;
}

export interface PickerModelView {
  slug: string;
  name: string;
  /** The chip label ({@link modelChipLabel}). */
  shortName: string;
  /** The provider's sub-provider, when it names one. */
  subProvider?: string;
  /** The picker row's hint ({@link modelPickerHint}): the sub-provider, else "legacy". */
  hint?: string;
  /** The model a launch naming none gets (exactly one per catalogue; never a legacy one when another exists). */
  isDefault: boolean;
  isLegacy?: true;
  options: PickerOptionView[];
}

export interface PickerView {
  /** `ready | degraded | error | unknown`; `catalogueLoading` when a ready-or-unknown provider lists no model yet. */
  status: ProviderSnapshot["status"];
  catalogueLoading: boolean;
  /** The model a launch naming none gets ({@link resolveLaunchModel} with no request); null with no models. */
  defaultModel: string | null;
  models: PickerModelView[];
}

function optionView(descriptor: ProviderOptionDescriptor): PickerOptionView {
  const value = currentOptionValue(null, descriptor);
  const base: PickerOptionView = {
    id: descriptor.id,
    label: descriptor.label,
    type: descriptor.type,
    ...(descriptor.description ? { description: descriptor.description } : {})
  };
  if (descriptor.type === "select") {
    base.values = descriptor.options.map((choice) => ({
      id: choice.id,
      label: choice.label,
      ...(choice.description ? { description: choice.description } : {}),
      ...(choice.isDefault === true ? { isDefault: true } : {})
    }));
  }
  if (value !== undefined) base.default = value;
  return base;
}

/**
 * One provider's catalogue as the composer picker presents it: every model (legacy ones only with
 * `includeLegacy`, always marked), its chip label, hint, default flag and options with the values a
 * launch naming none gets, and the default model.
 */
export function providerPickerView(snapshot: Pick<ProviderSnapshot, "status" | "models">, opts?: { includeLegacy?: boolean }): PickerView {
  const listed = snapshot.models.filter((model) => opts?.includeLegacy === true || model.isLegacy !== true);
  const fallback = resolveLaunchModel(snapshot.models);
  return {
    status: snapshot.status,
    catalogueLoading: snapshot.models.length === 0 && (snapshot.status === "ready" || snapshot.status === "unknown"),
    defaultModel: fallback?.slug ?? null,
    models: listed.map((model) => {
      const hint = modelPickerHint(model);
      return {
        slug: model.slug,
        name: model.name,
        shortName: modelChipLabel(model, null),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        ...(hint !== undefined ? { hint } : {}),
        isDefault: model.slug === fallback?.slug,
        ...(model.isLegacy === true ? { isLegacy: true as const } : {}),
        options: optionDescriptors(model).map(optionView)
      };
    })
  };
}
