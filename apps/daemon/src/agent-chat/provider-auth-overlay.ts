/**
 * Managed-account overlay for a provider snapshot's `auth` (spec §7.7).
 *
 * The host probes each provider under the HOST identity — the daemon user's
 * own `~/.claude`, `~/.codex`, `~/.grok` — because a provider-level probe has
 * no thread and therefore no account. On a box whose system login is stale but
 * whose managed accounts are all valid (the normal shape here: the system
 * Claude login is never used, every chat pins a managed account) that probe
 * says `unauthenticated`, and the client dutifully toasts "claude needs
 * signing in again" at a provider that is perfectly usable.
 *
 * The daemon is the one process that knows both facts, so it reconciles them
 * on the way out: a provider whose probe found no login, but for which at
 * least one managed account of that family is NOT flagged `needsReauth`, is
 * reported `authenticated` through that account. The toast then fires only
 * when there is genuinely nothing to launch with — no valid system login AND
 * no valid managed account — which is what the user asked for.
 *
 * Pure: takes the snapshot and the accounts list, returns a new snapshot.
 */

import type { AgentAccount } from "@orquester/api";

/** Which managed-account family serves which adapter. OpenCode has none. */
const ACCOUNT_FAMILY_BY_ADAPTER: Record<string, AgentAccount["agent"] | undefined> = {
  claude: "claude",
  codex: "codex",
  grok: "grok"
};

interface SnapshotLike {
  id: string;
  status: string;
  message?: string;
  auth: { status: string; type?: string; label?: string; email?: string };
}

export function overlayManagedAccountAuth<T extends SnapshotLike>(
  snapshot: T,
  accounts: readonly AgentAccount[],
  defaults?: Partial<Record<AgentAccount["agent"], string | null>>
): T {
  if (snapshot.auth.status === "authenticated") return snapshot;
  const family = ACCOUNT_FAMILY_BY_ADAPTER[snapshot.id];
  if (family === undefined) return snapshot;
  const valid = accounts.filter((account) => account.agent === family && !account.needsReauth);
  if (valid.length === 0) return snapshot;
  // Prefer the family default when it is one of the valid ones; else the first.
  const preferredId = defaults?.[family] ?? null;
  const account = valid.find((candidate) => candidate.id === preferredId) ?? valid[0]!;
  const auth = {
    ...snapshot.auth,
    status: "authenticated",
    ...(snapshot.auth.type === undefined ? { type: "firstParty" } : {}),
    label: account.label,
    ...(account.email ? { email: account.email } : {})
  };
  // A provider whose only fault was "not logged in" is ready once an account
  // is; any other error (missing binary, bad version) keeps its status and text.
  const onlyAuthWasWrong =
    snapshot.status === "error" && snapshot.auth.status === "unauthenticated";
  if (onlyAuthWasWrong) {
    const { message: _dropped, ...rest } = snapshot;
    return { ...rest, status: "ready", auth } as T;
  }
  return { ...snapshot, auth } as T;
}
