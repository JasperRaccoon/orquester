import type { ProviderModel, ProviderSnapshot } from "@orquester/api/agent-chat";

/**
 * Picking a model at launch (agent chat spec §6.1).
 *
 * Two problems this solves, both found end to end:
 *
 * 1. **A launch must always name a model.** The host validates
 *    `modelSelection.model` as a non-empty string at thread creation, so the
 *    shell's old `{ model: "" }` "let the provider decide" placeholder was
 *    rejected — every one-click launcher on the project overview died with
 *    *"modelSelection.model is required"*. The client has the catalogue; it
 *    resolves the default itself.
 * 2. **A catalogue is not a picker.** OpenCode reports 378 models; rendering
 *    them as inline chips makes the "+" menu a multi-screen wall that every
 *    open pays for. The menu shows a short, stable subset and a search over
 *    the rest.
 *
 * Pure, so both rules are testable without a renderer or a live daemon.
 */

/** How many model chips the launcher shows before the rest go behind search. */
export const LAUNCH_MODEL_CHIP_LIMIT = 6;

/** How many rows a search may return, so a one-character query stays cheap. */
export const LAUNCH_MODEL_SEARCH_LIMIT = 40;

/**
 * The model a launch should use.
 *
 * In order: the user's remembered pick when the catalogue still serves it, the
 * catalogue's own default, then its first entry. `null` only when there is no
 * catalogue at all — the caller must not post a launch it knows will be
 * refused, and says so instead.
 *
 * A remembered pick the catalogue no longer lists is **not** honoured: the
 * launch would fail at the provider rather than at the chip. That differs from
 * the proxy-launcher chips, which deliberately keep a stale pick visible (spec
 * §2) — there the daemon resolves it, here the provider would reject it.
 *
 * Ties on `isDefault` resolve to catalogue order, deterministically: OpenCode
 * really does flag two models default, and "the default" must not depend on
 * iteration luck.
 */
export function resolveLaunchModel(input: {
  snapshot: Pick<ProviderSnapshot, "models"> | null;
  preferred?: string | undefined;
}): string | null {
  const models = input.snapshot?.models ?? [];
  if (models.length === 0) {
    return null;
  }
  if (input.preferred && models.some((model) => model.slug === input.preferred)) {
    return input.preferred;
  }
  return models.find((model) => model.isDefault)?.slug ?? models[0]?.slug ?? null;
}

/**
 * The provider a slug belongs to: the segment before the first `/`
 * (`openrouter/anthropic/claude-3-haiku` → `openrouter`), or `null` for a
 * bare slug the adapter serves itself.
 */
export function modelProviderOf(slug: string): string | null {
  const cut = slug.indexOf("/");
  return cut > 0 ? slug.slice(0, cut) : null;
}

/**
 * What a model reads as in a list. The catalogue's own `name` where it has one
 * — the composer's chip already uses it, and the two surfaces naming the same
 * model differently is its own bug — else the last meaningful slug segment.
 */
export function modelDisplayName(model: Pick<ProviderModel, "slug" | "name" | "shortName">): string {
  if (model.shortName && model.shortName.length > 0) {
    return model.shortName;
  }
  if (model.name && model.name.length > 0) {
    return model.name;
  }
  const segments = model.slug.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? model.slug;
}

export interface LaunchModelChoice {
  slug: string;
  label: string;
  /** `null` for a model the adapter serves under its own name. */
  provider: string | null;
  isDefault: boolean;
}

function toChoice(model: ProviderModel): LaunchModelChoice {
  return {
    slug: model.slug,
    label: modelDisplayName(model),
    provider: modelProviderOf(model.slug),
    isDefault: model.isDefault === true
  };
}

export interface LaunchModelList {
  /** The chips to render, always including the selected model. */
  shown: LaunchModelChoice[];
  /** How many the query or the cap left out — the "…and N more" count. */
  hidden: number;
  /** True when the catalogue is big enough to be worth searching. */
  searchable: boolean;
}

/**
 * The models a launcher row actually renders.
 *
 * With no query: the selected model, the catalogue default and the first few
 * entries — never the whole catalogue. With a query: a case-insensitive match
 * on the slug **or** the display name, capped, so typing `haiku` finds
 * `openrouter/anthropic/claude-3-haiku` and typing `openrouter` finds that
 * provider's models.
 *
 * The selected model is always present, even when the query excludes it, so
 * the row can never show a chip set with nothing selected.
 */
export function launchModelList(input: {
  models: readonly ProviderModel[];
  selected: string | null;
  query?: string;
  limit?: number;
}): LaunchModelList {
  const limit = input.limit ?? LAUNCH_MODEL_CHIP_LIMIT;
  const all = input.models.map(toChoice);
  const searchable = all.length > limit;
  const query = (input.query ?? "").trim().toLowerCase();

  const matches = query
    ? all.filter(
        (choice) =>
          choice.slug.toLowerCase().includes(query) || choice.label.toLowerCase().includes(query)
      )
    : all;

  const cap = query ? Math.min(LAUNCH_MODEL_SEARCH_LIMIT, limit * 4) : limit;
  const shown: LaunchModelChoice[] = [];
  const taken = new Set<string>();

  // The selected model leads, so it is visible whatever the query says.
  const selected = input.selected ? all.find((choice) => choice.slug === input.selected) : undefined;
  if (selected) {
    shown.push(selected);
    taken.add(selected.slug);
  }
  // Then the catalogue's default (when it is not already the selection), so
  // "back to the default" is always one click away.
  if (!query) {
    const fallback = all.find((choice) => choice.isDefault && !taken.has(choice.slug));
    if (fallback) {
      shown.push(fallback);
      taken.add(fallback.slug);
    }
  }
  for (const choice of matches) {
    if (shown.length >= cap) {
      break;
    }
    if (!taken.has(choice.slug)) {
      shown.push(choice);
      taken.add(choice.slug);
    }
  }

  const eligible = query ? matches.length : all.length;
  return { shown, hidden: Math.max(0, eligible - shown.length), searchable };
}

/**
 * Models grouped by provider, biggest group last-named first is NOT the rule —
 * groups keep catalogue order of first appearance, so a provider never jumps
 * around between renders.
 */
export function groupModelsByProvider(
  models: readonly ProviderModel[]
): Array<{ provider: string | null; models: LaunchModelChoice[] }> {
  const groups = new Map<string, { provider: string | null; models: LaunchModelChoice[] }>();
  for (const model of models) {
    const choice = toChoice(model);
    const key = choice.provider ?? "";
    const group = groups.get(key);
    if (group) {
      group.models.push(choice);
    } else {
      groups.set(key, { provider: choice.provider, models: [choice] });
    }
  }
  return [...groups.values()];
}
