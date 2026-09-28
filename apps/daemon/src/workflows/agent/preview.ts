// Automated workflows — the editor's "Who would run now?" (spec §5.2,
// `POST /api/workflows/account-preview`).
//
// The very selection the agent block makes: `pickCandidate` over the same live readers — the
// in-memory usage snapshot, the managed accounts and the shared cooldowns —
// with the same catalogue check (`AgentCatalog.check`, create.ts), so the preview and the next run
// cannot disagree: an agent that is not a chat agent here, or a model its provider does not list,
// is passed over (`why: "catalog"`) exactly as the run passes over it. Before the daemon's own
// client is attached — or when the catalogue cannot be read — the preview is the account selection
// alone (`selectAccount`), which the run then narrows.

import type { AccountSelectionDecision, AgentChainEntry } from "@orquester/api";
import { agentChainEntrySchema } from "@orquester/config";
import type { DaemonApi } from "../../chat-client/index.ts";
import type { AccountsReader, Clock, CooldownStore, UsageReader } from "../contracts.ts";
import { AgentCatalog } from "./create.ts";
import { emptyMemory, pickCandidate } from "./failover.ts";
import { selectAccount } from "./select.ts";

export interface AccountPreviewDeps {
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  clock: Pick<Clock, "now">;
  /** The daemon's own client, once attached: the catalogue check reads through it. */
  api?: () => DaemonApi | null;
}

export type AccountPreview = (chain: AgentChainEntry[], projectPath?: string) => Promise<AccountSelectionDecision>;

export function createAccountPreview(deps: AccountPreviewDeps): AccountPreview {
  return async (chain) => {
    // A preview body did not go through the definition's parse: fill the schema's defaults.
    const parsed = chain.map((entry) => {
      const result = agentChainEntrySchema.safeParse(entry);
      return result.success ? result.data : entry;
    });
    const api = deps.api?.() ?? null;
    if (api) {
      const catalog = new AgentCatalog(api);
      try {
        await catalog.list();
      } catch {
        // No catalogue to check against: the selection alone.
        return selectionOnly(deps, parsed);
      }
      const pick = await pickCandidate(deps, parsed, emptyMemory(), 0, (candidate) => catalog.check(candidate));
      return pick.decision;
    }
    return selectionOnly(deps, parsed);
  };
}

function selectionOnly(deps: AccountPreviewDeps, chain: AgentChainEntry[]): AccountSelectionDecision {
  return selectAccount({
    chain,
    usage: deps.usage.snapshot(),
    accounts: deps.accounts.list(),
    cooldowns: deps.cooldowns.list(),
    now: deps.clock.now()
  });
}
