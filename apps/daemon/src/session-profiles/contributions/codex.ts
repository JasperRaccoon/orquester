/**
 * Agent Profiles — Codex's launch contribution (spec §6.2, §7 "One seam"): what a Codex chat with
 * a profile adds to its account's launch. The prepared version dir IS the chat's `CODEX_HOME`
 * (it links the account's `auth.json` and `sessions/`), so the contribution points `CODEX_HOME`
 * and the thread's `homePath` (its resume identity, spec §7) at it. The account's own unset list
 * (`OPENAI_API_KEY`, …) still applies.
 *
 * Never an unseeded home: the lifecycle's `ensureReady` (run right before every contribution)
 * already prepares a new version when the current one lost its state DB (the Codex preparer's
 * `unusableReason`); a home found unseeded here anyway fails the launch rather than starting a
 * Codex that would rescan the whole shared history first.
 */

import { CODEX_STATE_DB_FILE, codexStateDbPresent } from "../../agent-isolation/index.ts";
import type { ProfileLaunchContext, ProfileLaunchContribution } from "../launch.ts";

/** Codex's entry of `profileLaunchContributors` (`../launch.ts`). */
export async function codexProfileLaunchContribution(
  ctx: Pick<ProfileLaunchContext<"codex">, "profile">
): Promise<ProfileLaunchContribution> {
  const home = ctx.profile.preparedDir;
  if (!(await codexStateDbPresent(home))) {
    throw new Error(`its prepared Codex home is not seeded (${CODEX_STATE_DB_FILE} is missing); the next start prepares it anew.`);
  }
  return { env: { CODEX_HOME: home }, homePath: home };
}
