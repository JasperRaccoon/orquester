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
import type { AgentAccountAgent } from "@orquester/api";
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
  // The proxy launchers: `proxyAccountFamily` in agent-chat/service.ts (a test pins them equal).
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
 */
export type UsesAccount = (refId: string, model: string) => boolean;

/**
 * The predicate over a live list of router providers (re-read on every call, so a provider added
 * in Settings counts at once). claudemix always uses its Claude account: its model is the Claude
 * main loop's, never a proxy model (`launchesProxyModel`, mcp/agents.ts).
 */
export function createUsesAccount(routerProviders: () => readonly RouterProvider[]): UsesAccount {
  return (refId, model) => {
    if (accountFamilyOf(refId) === null) return false;
    if (refId !== "claudex") return true;
    if (resolveXaiModel(model)) return false;
    return resolveRouterModel(routerProviders(), model) === null;
  };
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
 * The family a chain entry's cooldowns and exclusions are keyed under (`<family>:<accountId>`).
 * An account-bearing launch uses its account family ("codex:acc1"); an accountless one — opencode,
 * a claudex router/xAI model — has the single candidate "system" under its own refId
 * ("opencode:system", "claudex:system"), so its limit never cools the family's system login.
 */
export function cooldownFamilyOf(refId: string, model: string, usesAccount: UsesAccount = defaultUsesAccount): string {
  const family = accountFamilyOf(refId);
  return family !== null && usesAccount(refId, model) ? family : refId;
}

export function cooldownKey(family: string, accountId: string): string {
  return `${family}:${accountId}`;
}
