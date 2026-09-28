// Automated workflows — the editor's "Who would run now?" (spec §5.2,
// `POST /api/workflows/account-preview`).
//
// The very function the agent block selects with (`selectAccount`), over the same live readers — the
// in-memory usage snapshot, the managed accounts, the proxy's seeded ids and the shared cooldowns —
// so the preview and the next run cannot disagree (the catalogue check a run adds is not I/O-free and
// is left to the run).

import type { AccountSelectionDecision, AgentChainEntry } from "@orquester/api";
import { agentChainEntrySchema } from "@orquester/config";
import type { AccountsReader, Clock, CooldownStore, UsageReader } from "../contracts.ts";
import type { UsesAccount } from "./families.ts";
import { selectAccount } from "./select.ts";

export interface AccountPreviewDeps {
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  usesAccount?: UsesAccount;
  clock: Pick<Clock, "now">;
}

export type AccountPreview = (chain: AgentChainEntry[], projectPath?: string) => Promise<AccountSelectionDecision>;

export function createAccountPreview(deps: AccountPreviewDeps): AccountPreview {
  return async (chain) => {
    // A preview body did not go through the definition's parse: fill the schema's defaults.
    const parsed = chain.map((entry) => {
      const result = agentChainEntrySchema.safeParse(entry);
      return result.success ? result.data : entry;
    });
    return selectAccount({
      chain: parsed,
      usage: deps.usage.snapshot(),
      accounts: deps.accounts.list(),
      seededAccountIds: deps.accounts.seededAccountIds(),
      cooldowns: deps.cooldowns.list(),
      now: deps.clock.now(),
      ...(deps.usesAccount ? { usesAccount: deps.usesAccount } : {})
    });
  };
}
