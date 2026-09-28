// Automated workflows — which managed-account family an agent draws from (spec §5.2).
//
// The daemon's own rule is `proxyAccountFamily(refId) ?? refId` (agent-chat/service.ts): the proxy
// launchers borrow another family's accounts — claudemix Claude's, claudex Codex's — and only the
// accounts SEEDED into the model proxy can carry a launch (`seededAccountRefusal`, index.ts).
// OpenCode has no managed accounts at all (one server per project under the daemon's own login).
//
// A claudex launch naming a router-provider model or an xAI OAuth model carries NO account: the
// proxy routes it by the provider key / the linked Grok login, and the seeded-account gate exempts
// it. The same two resolvers decide it here (`resolveRouterModel`, `resolveXaiModel` from
// @orquester/config), injected as a predicate because the router providers live on disk
// (`cliproxy/state.json`) and the selection itself stays pure.

import { readFileSync } from "node:fs";
import { SYSTEM_ACCOUNT_ID, type AgentAccountAgent } from "@orquester/api";
import {
  cliproxyStateFile,
  parseCliProxyState,
  resolveRouterModel,
  resolveXaiModel,
  type RouterProvider
} from "@orquester/config";

export type AccountFamily = AgentAccountAgent;

const FAMILY_OF: Readonly<Record<string, AccountFamily>> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  // The proxy launchers: `proxyAccountFamily` in agent-chat/service.ts.
  claudemix: "claude",
  claudex: "codex"
};

/** The managed-account family an agent's accounts come from; null for an agent with none (opencode). */
export function accountFamilyOf(refId: string): AccountFamily | null {
  return Object.prototype.hasOwnProperty.call(FAMILY_OF, refId) ? FAMILY_OF[refId]! : null;
}

/** claudex / claudemix: only accounts seeded into the model proxy can carry their launch. */
export function isProxyLauncher(refId: string): boolean {
  return refId === "claudex" || refId === "claudemix";
}

/**
 * Does a launch of `refId` with `model` run under a managed account? False for an agent with no
 * family, and for a claudex model the proxy serves without one (a router provider's or xAI's).
 * `routerProviderOf`, when present, names the router provider serving a claudex model — the
 * cooldown key of an accountless router launch (`cooldownSubject`).
 */
export type UsesAccount = ((refId: string, model: string) => boolean) & {
  routerProviderOf?: (model: string) => string | null;
};

/**
 * The predicate over a live list of router providers (re-read on every call, so a provider added
 * in Settings counts at once). claudemix always uses its Claude account: its model is the Claude
 * main loop's, never a proxy model (`launchesProxyModel`, mcp/agents.ts).
 */
export function createUsesAccount(routerProviders: () => readonly RouterProvider[]): UsesAccount {
  const uses = (refId: string, model: string): boolean => {
    if (accountFamilyOf(refId) === null) return false;
    if (refId !== "claudex") return true;
    if (resolveXaiModel(model)) return false;
    return resolveRouterModel(routerProviders(), model) === null;
  };
  return Object.assign(uses, {
    routerProviderOf: (model: string): string | null => resolveRouterModel(routerProviders(), model)?.providerId ?? null
  });
}

/** Without the proxy state: only the curated xAI list is known, every other claudex model uses an account. */
export const defaultUsesAccount: UsesAccount = createUsesAccount(() => []);

/** The router providers persisted in `<daemonDir>/cliproxy/state.json`; [] when absent or unreadable. */
export function routerProvidersFromDisk(daemonDir: string): RouterProvider[] {
  try {
    return parseCliProxyState(JSON.parse(readFileSync(cliproxyStateFile(daemonDir), "utf8"))).routerProviders ?? [];
  } catch {
    return [];
  }
}

/**
 * What a candidate's cooldowns and exclusions are keyed under: `<family>:<account>`
 * (`cooldownKey`). Cooldowns live in `workflow-state.json` and are shared by every workflow, so a
 * key must name exactly the quota that ran out — never a wider one:
 *   - an account-bearing launch: its account family and account ("claude:acc1", "codex:system");
 *   - the proxy launchers' own pick ("system" on claudex / claudemix — whichever seeded account the
 *     proxy routes to): "claudex:proxy" / "claudemix:proxy", never the family's system login;
 *   - an accountless launch, keyed by the PROVIDER that answered: OpenCode by the model's
 *     `providerID/` prefix ("opencode:provider:anthropic"), a claudex router model by its router
 *     provider ("claudex:router:openrouter"), an xAI model as "claudex:xai" — so one provider's 429
 *     never cools another provider's entries. A model whose provider cannot be named (a router model
 *     with no provider list at hand, an OpenCode model with no prefix) is keyed by the model itself.
 */
export function cooldownSubject(
  refId: string,
  model: string,
  accountId: string,
  usesAccount: UsesAccount = defaultUsesAccount
): { family: string; account: string } {
  const family = accountFamilyOf(refId);
  if (family !== null && usesAccount(refId, model)) {
    if (isProxyLauncher(refId) && accountId === SYSTEM_ACCOUNT_ID) return { family: refId, account: "proxy" };
    return { family, account: accountId };
  }
  return { family: refId, account: accountlessProvider(refId, model, usesAccount) };
}

function accountlessProvider(refId: string, model: string, usesAccount: UsesAccount): string {
  const bare = model.replace(/^acc[0-9a-fA-F]+\//, "");
  if (isProxyLauncher(refId)) {
    if (resolveXaiModel(model)) return "xai";
    const router = usesAccount.routerProviderOf?.(model);
    if (router) return `router:${router}`;
    return `model:${bare}`;
  }
  const slash = bare.indexOf("/");
  if (slash > 0) return `provider:${bare.slice(0, slash)}`;
  return `model:${bare}`;
}

export function cooldownKey(family: string, accountId: string): string {
  return `${family}:${accountId}`;
}
