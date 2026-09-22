/**
 * Claude adapter — the model catalogue and its option descriptors (spec §4.1,
 * §4.5 "Models", §3.2 "minimum CLI version").
 *
 * **differs from T3 and from spec §4.5.** T3 ships a bundled
 * `model-manifest.json` with a remote refresh and per-model
 * `minVersion`/`maxVersionExclusive` ranges, and §4.5 repeats that ("Models
 * are a manifest, not a call"). The real CLI answers `supportedModels()` — and
 * `initializationResult().models` — for free from the same never-yielding
 * probe that already reads the account and the command list
 * (fixtures/claude README observation 15), and it answers with **per-model**
 * capability flags a static manifest cannot keep current:
 * `supportedEffortLevels` (which includes `xhigh` and `max`, so the effort
 * descriptor must not hard-code low/medium/high), `supportsFastMode` and
 * `supportsAdaptiveThinking`. Reading the installed CLI also makes the
 * per-model version gate inherent: a CLI that does not support a model does
 * not list it.
 *
 * A small static fallback remains for the case where the probe itself failed,
 * so the composer can still offer the aliases every recent CLI accepts.
 *
 * **Two consequences of that swap, stated here so they are not re-derived.**
 *
 * 1. §4.1's *"gates each catalogue model on a `minVersion`/`maxVersionExclusive`
 *    range … and explains the gap rather than hiding the model"* no longer has
 *    a per-model half: an unsupported model is simply absent from
 *    `supportedModels()`, so there is nothing to explain a gap about. The
 *    "explain the gap" requirement therefore applies only to the **whole-CLI**
 *    gate, which {@link claudeVersionGateMessage} satisfies by naming the
 *    version needed and how to install it.
 * 2. T3's `ultracode` was an *effort choice* in its bundled manifest
 *    (`effortMap` → `effort: "xhigh"` **plus** `settings.ultracode: true`). The
 *    CLI's own `supportedEffortLevels` never contains it, so it is offered here
 *    as a separate boolean descriptor gated on `xhigh` support — the SDK still
 *    accepts the setting and it would otherwise be unreachable.
 */

import type {
  ModelCapabilities,
  ModelSelection,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderOptionSelectionValue
} from "@orquester/api/agent-chat";

/**
 * The CLI version this adapter was validated against, and the floor it
 * refuses below (§3.2, §10 "version gates refuse rather than degrade").
 *
 * 2.1.121 is the release in which `AskUserQuestion` answers are looked up by
 * **question text** (§4.5). Below it the reply shape this adapter sends is
 * silently ignored, which is the difference between a question the user can
 * answer and a turn that hangs — so it is refused with the required version
 * rather than started.
 */
export const MINIMUM_CLAUDE_CLI_VERSION = "2.1.121";

/** The CLI version the committed fixtures were captured from (§9 provenance). */
export const VALIDATED_CLAUDE_CLI_VERSION = "2.1.210";

/** `claude --version` prints `2.1.210 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  return match ? match[0] : null;
}

/**
 * Compare two dotted versions numerically. Returns <0, 0 or >0. Unparsable
 * segments count as 0, which is deliberate: a version that cannot be read must
 * fail a minimum rather than pass it (§10).
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/);
  const b = right.split(/[.+-]/);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = Number.parseInt(a[index] ?? "0", 10);
    const y = Number.parseInt(b[index] ?? "0", 10);
    const xn = Number.isFinite(x) ? x : 0;
    const yn = Number.isFinite(y) ? y : 0;
    if (xn !== yn) {
      return xn < yn ? -1 : 1;
    }
  }
  return 0;
}

export function meetsMinimumClaudeVersion(version: string | null): boolean {
  if (version === null) {
    return false;
  }
  return compareVersions(version, MINIMUM_CLAUDE_CLI_VERSION) >= 0;
}

export function claudeVersionGateMessage(version: string | null): string {
  return version === null
    ? `Could not read the Claude CLI version. Orquester chat needs claude ${MINIMUM_CLAUDE_CLI_VERSION} or newer.`
    : `Claude CLI ${version} is too old for Orquester chat. Install claude ${MINIMUM_CLAUDE_CLI_VERSION} or newer (npm install -g @anthropic-ai/claude-code).`;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** The SDK's `ModelInfo`, read structurally so an added field cannot break it. */
export interface ClaudeModelInfo {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
  supportsAdaptiveThinking?: unknown;
  supportsFastMode?: unknown;
  supportsAutoMode?: unknown;
}

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

const DEFAULT_EFFORT_CHOICE = "medium";

export const CLAUDE_OPTION_IDS = {
  effort: "effort",
  thinking: "thinking",
  fastMode: "fastMode",
  ultracode: "ultracode"
} as const;

function optionDescriptorsFor(info: ClaudeModelInfo): ProviderOptionDescriptor[] {
  const descriptors: ProviderOptionDescriptor[] = [];
  const levels = Array.isArray(info.supportedEffortLevels)
    ? info.supportedEffortLevels.filter((level): level is string => typeof level === "string")
    : [];
  if (info.supportsEffort === true && levels.length > 0) {
    descriptors.push({
      id: CLAUDE_OPTION_IDS.effort,
      label: "Effort",
      description: "How much reasoning the model spends on a turn.",
      type: "select",
      options: levels.map((level) => ({
        id: level,
        label: EFFORT_LABELS[level] ?? level,
        ...(level === DEFAULT_EFFORT_CHOICE ? { isDefault: true } : {})
      }))
    });
  }
  // Absence means "not supported", not "unknown": the haiku row omits every
  // capability flag (fixtures README observation 15).
  if (info.supportsAdaptiveThinking === true) {
    descriptors.push({
      id: CLAUDE_OPTION_IDS.thinking,
      label: "Thinking",
      description: "Show the model's summarised reasoning.",
      type: "boolean"
    });
  }
  if (info.supportsFastMode === true) {
    descriptors.push({
      id: CLAUDE_OPTION_IDS.fastMode,
      label: "Fast mode",
      description: "Trade some quality for latency where the plan allows it.",
      type: "boolean"
    });
  }
  // T3 carried `ultracode` as an effort choice in its bundled manifest; the
  // CLI's own level list never names it, so it is its own boolean, gated on the
  // `xhigh` support the SDK requires for it.
  if (levels.includes("xhigh")) {
    descriptors.push({
      id: CLAUDE_OPTION_IDS.ultracode,
      label: "Ultracode",
      description: "Extra-high effort plus standing dynamic-workflow orchestration.",
      type: "boolean"
    });
  }
  return descriptors;
}

export function toProviderModel(info: ClaudeModelInfo): ProviderModel | undefined {
  const slug = typeof info.value === "string" ? info.value.trim() : "";
  if (slug.length === 0) {
    return undefined;
  }
  const displayName = typeof info.displayName === "string" ? info.displayName.trim() : "";
  const descriptors = optionDescriptorsFor(info);
  const capabilities: ModelCapabilities | null =
    descriptors.length > 0 ? { optionDescriptors: descriptors } : null;
  return {
    slug,
    name: displayName.length > 0 ? displayName : slug,
    ...(displayName.length > 0 ? { shortName: displayName } : {}),
    ...(slug === "default" ? { isDefault: true } : {}),
    capabilities,
    // `description` has no home on ProviderModel; the resolved id does, as the
    // sub-provider line the picker shows under the name.
    ...(typeof info.resolvedModel === "string" && info.resolvedModel.trim().length > 0
      ? { subProvider: info.resolvedModel.trim() }
      : {})
  };
}

export function toProviderModels(models: unknown): ProviderModel[] {
  if (!Array.isArray(models)) {
    return [];
  }
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const model = toProviderModel(entry as ClaudeModelInfo);
    if (model && !seen.has(model.slug)) {
      seen.add(model.slug);
      out.push(model);
    }
  }
  return out.map((model) => nameDefaultAfterItsModel(model, out));
}

/**
 * "Default (recommended)" says nothing about WHICH model that is, and the
 * owner read it as Fable when the CLI resolves it to Opus. The row keeps the
 * CLI's slug (`default`, so the launch still tracks the CLI's own choice) but
 * reads as `Default · Opus (1M context)` — the name of the sibling the
 * `resolvedModel` points at, or the resolved id itself when no sibling lists it.
 */
function nameDefaultAfterItsModel(model: ProviderModel, all: readonly ProviderModel[]): ProviderModel {
  if (model.slug !== "default" || !model.subProvider) return model;
  const resolved = model.subProvider;
  const sibling = all.find(
    (candidate) =>
      candidate.slug !== "default" &&
      (candidate.slug === resolved || candidate.subProvider === resolved)
  );
  const label = `Default · ${sibling?.shortName ?? sibling?.name ?? resolved}`;
  return { ...model, name: label, shortName: label };
}

/**
 * Used only when the probe failed outright, so the model chip is not empty on
 * a host whose CLI is momentarily unreachable. Deliberately tiny: the real
 * list always comes from the CLI.
 */
export const FALLBACK_CLAUDE_MODELS: readonly ProviderModel[] = [
  { slug: "default", name: "Default (recommended)", isDefault: true, capabilities: null },
  { slug: "opus", name: "Opus", capabilities: null },
  { slug: "sonnet", name: "Sonnet", capabilities: null },
  { slug: "haiku", name: "Haiku", capabilities: null }
];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectionOptionValue(
  selection: ModelSelection | undefined,
  id: string
): ProviderOptionSelectionValue | undefined {
  return selection?.options?.find((option) => option.id === id)?.value;
}

export function selectionStringOption(
  selection: ModelSelection | undefined,
  id: string
): string | undefined {
  const value = selectionOptionValue(selection, id);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function selectionBooleanOption(
  selection: ModelSelection | undefined,
  id: string
): boolean | undefined {
  const value = selectionOptionValue(selection, id);
  return typeof value === "boolean" ? value : undefined;
}

/** The SDK's `EffortLevel` union — anything else is dropped, never passed on. */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function resolveEffortLevel(
  selection: ModelSelection | undefined,
  model: ProviderModel | undefined
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const requested = selectionStringOption(selection, CLAUDE_OPTION_IDS.effort);
  if (requested === undefined || !EFFORT_LEVELS.has(requested)) {
    return undefined;
  }
  if (model === undefined) {
    // No catalogue entry to check against (a probe that failed): pass the
    // level through and let the CLI reject it rather than silently dropping
    // the user's choice.
    return requested as "low" | "medium" | "high" | "xhigh" | "max";
  }
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (entry) => entry.id === CLAUDE_OPTION_IDS.effort
  );
  // Absence means "not supported", not "unknown": the haiku row omits every
  // capability flag (fixtures/claude README observation 15).
  if (descriptor === undefined || descriptor.type !== "select") {
    return undefined;
  }
  if (!descriptor.options.some((option) => option.id === requested)) {
    return undefined;
  }
  return requested as "low" | "medium" | "high" | "xhigh" | "max";
}

/** A boolean option only applies where the selected model advertises it. */
export function resolveBooleanOption(
  selection: ModelSelection | undefined,
  model: ProviderModel | undefined,
  id: string
): boolean | undefined {
  const requested = selectionBooleanOption(selection, id);
  if (requested === undefined) {
    return undefined;
  }
  const descriptor = model?.capabilities?.optionDescriptors?.find((entry) => entry.id === id);
  if (model !== undefined && (descriptor === undefined || descriptor.type !== "boolean")) {
    return undefined;
  }
  return requested;
}

export function findModel(
  models: readonly ProviderModel[],
  slug: string | undefined
): ProviderModel | undefined {
  if (slug === undefined || slug.trim().length === 0) {
    return undefined;
  }
  const needle = slug.trim();
  return (
    models.find((model) => model.slug === needle) ??
    models.find((model) => model.subProvider === needle)
  );
}
