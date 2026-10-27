/**
 * Agent host — the environment of a CLI launched in a box (spec 2026-10-19
 * §8.5, §10, §7).
 *
 * Built FROM the host launch env (`buildProviderEnv` + the daemon's launch
 * env, so the account binding, the launch marker and the launcher's own
 * variables stay exactly what a host launch gets) and then made box-shaped:
 *
 * - host-only variables are dropped — `PATH`, `TMPDIR`, `HOME` and
 *   `NODE_OPTIONS` (the host's plugin preload, or any `--require` of a host
 *   file, makes every Node process in the box fail to start);
 * - every remaining value that is an absolute host path is mapped
 *   (`hostToBoxPath`, identity on POSIX boxes, `C:\orq\…` on Windows);
 * - ambient vendor credentials are stripped as on the host — and for a box
 *   EVERY vendor's, since the box receives only the brokered token the
 *   adapter adds itself;
 * - the box's own login PATH, with the tooling plugins' `pathPrepend` first,
 *   their `env`, and their `nodeRequire` files as `NODE_OPTIONS` (§10), all in
 *   the box's path syntax;
 * - Claude Code's auto-updater off: its plugin updates would come back from
 *   every box as changes to approve (config sync), and it has no plugin-only
 *   switch, so the box's CLI keeps the version it was installed with.
 */

import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { HostThreadBox } from "../host-protocol.ts";
import { ACCOUNT_HOME_ENV_VAR } from "../support/env.ts";
import { boxPathSyntax, mapHostValue } from "./launch-info.ts";

/** Never forwarded into a box: the host's own, or meaningless there. */
const HOST_ONLY_VARS = ["PATH", "Path", "TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "NODE_OPTIONS"] as const;

/**
 * Every vendor's ambient credentials. A box gets only the token the adapter
 * asked the broker for, in the variable the adapter sets after this.
 */
export const BOX_STRIPPED_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "CODEX_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "OPENCODE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN"
] as const;

export interface BoxEnvResult {
  /** Merged over `orq-agent`'s own environment by the exec. */
  env: Record<string, string>;
  /** Removed from `orq-agent`'s environment first (so nothing it inherited leaks into the CLI). */
  unset: string[];
}

export function buildBoxProviderEnv(input: {
  /** What `AdapterContext.buildEnv` produced for this launch (host-shaped). */
  hostEnv: Readonly<Record<string, string>>;
  adapter: AgentAdapterId;
  box: HostThreadBox;
  /** The box's login PATH (`box-tools.ts`), before the tooling prepend. */
  boxPath: string;
}): BoxEnvResult {
  const { box } = input;
  const { delimiter } = boxPathSyntax(box.sys.os);
  const stripped = new Set<string>([...HOST_ONLY_VARS, ...BOX_STRIPPED_CREDENTIAL_VARS]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.hostEnv)) {
    if (stripped.has(key) || value === undefined) continue;
    env[key] = mapHostValue(box.paths, value);
  }
  // The account home is a path by contract; map it even when the generic rule would not.
  const homeVar = ACCOUNT_HOME_ENV_VAR[input.adapter];
  const accountHome = input.hostEnv[homeVar];
  if (accountHome !== undefined && accountHome.startsWith("/")) {
    env[homeVar] = mapHostValue(box.paths, accountHome);
  }
  // Tooling (§10): already in the box's own syntax.
  for (const [key, value] of Object.entries(box.tooling.env)) {
    if (!stripped.has(key)) env[key] = value;
  }
  // The host's Claude updates the shared plugins; config sync brings them to the box.
  if (input.adapter === "claude") env.DISABLE_AUTOUPDATER = "1";
  const pathEntries = [...box.tooling.pathPrepend, ...input.boxPath.split(delimiter)].filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const path = pathEntries.filter((entry) => (seen.has(entry) ? false : (seen.add(entry), true))).join(delimiter);
  env[box.sys.os === "win32" ? "Path" : "PATH"] = path;
  if (box.sys.os !== "win32") env.HOME = box.sys.home;
  const unset: string[] = [...BOX_STRIPPED_CREDENTIAL_VARS];
  if (box.tooling.nodeRequire.length > 0) {
    env.NODE_OPTIONS = box.tooling.nodeRequire.map((file) => `--require ${JSON.stringify(file)}`).join(" ");
  } else {
    unset.push("NODE_OPTIONS");
  }
  return { env, unset: unset.filter((name) => env[name] === undefined) };
}
