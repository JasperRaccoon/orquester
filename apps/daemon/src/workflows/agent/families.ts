// Automated workflows — which managed-account family an agent draws from (spec §5.2).
//
// An agent's accounts are its own family's: claude, codex and grok each have managed accounts
// (the agent-accounts store). OpenCode has no managed accounts at all (one server per project under
// the daemon's own login), and neither does any other refId — a chain entry naming an agent this
// host does not offer is refused by the catalogue before any launch.

import type { AgentAccountAgent } from "@orquester/api";

export type AccountFamily = AgentAccountAgent;

const FAMILY_OF: Readonly<Record<string, AccountFamily>> = {
  claude: "claude",
  codex: "codex",
  grok: "grok"
};

/** The managed-account family an agent's accounts come from; null for an agent with none (opencode). */
export function accountFamilyOf(refId: string): AccountFamily | null {
  return Object.prototype.hasOwnProperty.call(FAMILY_OF, refId) ? FAMILY_OF[refId]! : null;
}

/**
 * What a candidate's cooldowns and exclusions are keyed under: `<family>:<account>`
 * (`cooldownKey`). Cooldowns live in `workflow-state.json` and are shared by every workflow, so a
 * key must name exactly the quota that ran out — never a wider one:
 *   - an account-bearing launch: its account family and account ("claude:acc1", "codex:system");
 *   - an accountless launch (OpenCode), keyed by the PROVIDER that answered: the model's
 *     `providerID/` prefix ("opencode:provider:anthropic"), so one provider's 429 never cools
 *     another provider's entries. A model with no prefix is keyed by the model itself.
 */
export function cooldownSubject(refId: string, model: string, accountId: string): { family: string; account: string } {
  const family = accountFamilyOf(refId);
  if (family !== null) return { family, account: accountId };
  return { family: refId, account: accountlessProvider(model) };
}

function accountlessProvider(model: string): string {
  const slash = model.indexOf("/");
  if (slash > 0) return `provider:${model.slice(0, slash)}`;
  return `model:${model}`;
}

export function cooldownKey(family: string, accountId: string): string {
  return `${family}:${accountId}`;
}
