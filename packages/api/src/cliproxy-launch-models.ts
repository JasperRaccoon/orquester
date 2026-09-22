import { CURATED_PROXY_MODEL_IDS, XAI_OAUTH_MODELS } from "@orquester/config";
import type { CliProxyStatus } from "./index.ts";

/** Provider label for the xAI OAuth models — the linked account IS the "key". */
export const XAI_PROVIDER_LABEL = "Grok account";

export interface ProxyLaunchModel {
  id: string;
  /** Label of the keyed router provider / xAI account serving it; null for the curated proxy list. */
  providerLabel: string | null;
}

/**
 * The models a `claudex`/`claudemix` launch may name — what the "+" menu offers:
 * the curated proxy picks, plus every model (alias when there is one) of a KEYED
 * router provider, plus the xAI models while an xAI credential exists (`linked`
 * or `expired`). When the proxy's live catalogue is non-empty the picks are
 * filtered to what it serves; if none survive, all picks are offered so the
 * chips never vanish.
 */
export function proxyLaunchModels(status: CliProxyStatus | null, catalog: readonly string[]): ProxyLaunchModel[] {
  const labelById = new Map<string, string | null>();
  for (const id of CURATED_PROXY_MODEL_IDS) labelById.set(id, null);
  // `?? []` / `?.xai` — a status persisted by an older bundle, or sent by an
  // older daemon, may predate `routerProviders` and `xai` (persisted-shape rule).
  for (const provider of status?.routerProviders ?? []) {
    // Only a keyed provider is rendered into the proxy's config.yaml; an unkeyed
    // one serves nothing.
    if (provider.keyState === "none") continue;
    for (const model of provider.models) {
      const id = model.alias ?? model.name;
      if (!labelById.has(id)) labelById.set(id, provider.label);
    }
  }
  // `expired` included: the daemon's gate is "an xAI credential file exists" —
  // the expiry stamp is informational and the proxy refreshes on next use.
  if (status?.xai?.state === "linked" || status?.xai?.state === "expired") {
    for (const model of XAI_OAUTH_MODELS) {
      if (!labelById.has(model.id)) labelById.set(model.id, XAI_PROVIDER_LABEL);
    }
  }
  const all = [...labelById.entries()].map(([id, providerLabel]) => ({ id, providerLabel }));
  const served = catalog.length ? all.filter((m) => catalog.includes(m.id)) : all;
  return served.length ? served : all;
}
