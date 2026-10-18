/**
 * Agent Profiles — Grok's launch contribution (spec §6.3): what a Grok profile chat adds to its
 * account's launch environment.
 *
 * - `GROK_HOME` = the prepared (version) directory — and so the thread's `homePath`, the resume
 *   identity's home (spec §7; `sessions/` in it is shared with Global, so a resume works anywhere).
 * - `GROK_AUTH_PATH` = the ACCOUNT's `auth.json` (the System identity: the Global home's). Grok
 *   reads only that file and refreshes it in place under `<dir>/auth.json.lock`, exactly as a
 *   Global chat on the account does; the profile home holds no credential.
 * - The compat switches of `GROK_PROFILE_ENV` (Claude/Cursor rules, agents, MCP servers and hooks
 *   off; Cursor skills off; Claude skills ON so the repo's `.claude/skills` loads).
 *
 * The rest of the recipe (`config.toml`, `--no-leader`, `--plugin-dir`) is the adapter's, at
 * every spawn (`agent-host/adapters/grok/profile-launch.ts`). Pure: no I/O.
 */

import { isAbsolute, join, relative } from "node:path";
import { GROK_AUTH_PATH_ENV, GROK_PROFILE_ENV } from "../../agent-isolation/grok.ts";

/** The part of the launch context (`../launch.ts` `ProfileLaunchContext`) Grok reads; registered in `profileLaunchContributors`. */
export interface GrokLaunchContributionContext {
  profile: { preparedDir: string };
  /** The account's Grok home (System: the Global `~/.grok`); `null` when unknown. */
  accountHome: string | null;
}

export interface GrokLaunchContribution {
  env: Record<string, string>;
  homePath: string;
}

export function grokProfileLaunchContribution(ctx: GrokLaunchContributionContext): GrokLaunchContribution {
  const home = ctx.profile.preparedDir;
  const accountHome = ctx.accountHome;
  if (accountHome === null || accountHome.length === 0 || !isAbsolute(accountHome)) {
    throw new Error("The Grok account's home is not known, so its sign-in cannot be used.");
  }
  const inside = relative(home, accountHome);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new Error("The Grok account's home cannot be inside the prepared profile.");
  }
  return {
    env: { GROK_HOME: home, [GROK_AUTH_PATH_ENV]: join(accountHome, "auth.json"), ...GROK_PROFILE_ENV },
    homePath: home
  };
}
