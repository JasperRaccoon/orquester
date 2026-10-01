/**
 * Managed-account overlay for a provider snapshot's `auth` (spec §7.7).
 *
 * Provider probes use the host's system identity, without a thread account.
 * A usable managed account still authenticates that provider; the daemon
 * overlays it here to avoid a false sign-in warning for an expired system login.
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
