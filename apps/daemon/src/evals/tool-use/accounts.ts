/**
 * The managed Claude account a run uses, named explicitly: a label (or its part before `@`) or an
 * id prefix from `agent-accounts.json`. There is no default — not the "system" home, and not the
 * agent's default account — so a run never lands on a login the user did not pick.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { agentAccountsDir, agentAccountsFile, parseAgentAccounts, type AgentAccountRecord } from "@orquester/config";

export interface EvalAccount {
  id: string;
  label: string;
  /** The account home: the CLI's config dir (`CLAUDE_CONFIG_DIR`). */
  home: string;
}

export function pickAccount(accounts: readonly AgentAccountRecord[], wanted: string): AgentAccountRecord {
  const query = wanted.trim().toLowerCase();
  if (query.length === 0 || query === "system") throw new Error('Name a managed account (--account <label or id>); the system login is never used.');
  const claude = accounts.filter((account) => account.agent === "claude");
  const hits = claude.filter(
    (account) => account.id.toLowerCase().startsWith(query) || account.label.toLowerCase() === query || account.label.toLowerCase().split("@")[0] === query
  );
  if (hits.length === 1) return hits[0]!;
  const known = claude.map((account) => account.label).join(", ");
  if (hits.length === 0) throw new Error(`No managed Claude account "${wanted}". Known: ${known}.`);
  throw new Error(`"${wanted}" names ${hits.length} accounts; use more of the id. Known: ${known}.`);
}

/** The account named `wanted` under appdir `baseDir`, checked to hold a login. */
export async function resolveAccount(baseDir: string, wanted: string): Promise<EvalAccount> {
  const index = parseAgentAccounts(JSON.parse(await readFile(agentAccountsFile(baseDir), "utf8")));
  const account = pickAccount(index.accounts, wanted);
  if (account.needsReauth) throw new Error(`Account ${account.label} needs a new login in Orquester first.`);
  const home = join(agentAccountsDir(baseDir), "claude", account.id, "home");
  await access(join(home, ".credentials.json")).catch(() => {
    throw new Error(`Account ${account.label} has no login in ${home}.`);
  });
  return { id: account.id, label: account.label, home };
}
