/**
 * Grok adapter — what a profile thread launches with (Agent Profiles spec §6.0, §6.3).
 *
 * A Grok profile chat runs with `GROK_HOME` = its prepared (version) directory and
 * `GROK_AUTH_PATH` = the account's `auth.json`; both arrive in the launch env from the daemon's
 * contribution (`session-profiles/contributions/grok.ts`). {@link prepareGrokProfileSpawn} does
 * the rest before EVERY spawn of `grok agent stdio`:
 * - reads the prepared section (`loadProfileManifest(input, "grok")`; a missing or mismatched one
 *   FAILS the start — never a Global launch);
 * - computes `[skills] ignore` afresh (`grokSkillIgnoreList`: every entry of `~/.claude/skills`
 *   and `~/.agents/skills` by path, plus each symlinked entry's target — Grok follows symlinked
 *   skill dirs, so a skill linked in since the last spawn must be listed);
 * - runs `grok inspect --json` under the profile home (cwd = the home, so no project layer joins
 *   in and the project's own plugins stay as in Global) and denies every discovered plugin by
 *   exact name (`[plugins] disabled`) except the profile's own: Grok enables Claude-installed
 *   plugins by itself, and only exact names stop them. An inspect that fails FAILS the start — a
 *   chat never launches with an unknown plugin set;
 * - renders `config.toml` from the prepared base (`renderGrokProfileConfigToml`: carried-over
 *   runtime settings, the profile's `[mcp_servers]`, `[cli] auto_update/use_leader = false`, the
 *   compat cells) and replaces the home's file atomically (temp + rename; 0600, it carries the
 *   profile's MCP secrets). Grok rewrites that file itself, hence at every spawn;
 * - answers the argv the `agent` subcommand gets (`--no-leader`, one `--plugin-dir` per profile
 *   plugin and the generated hooks plugin) and the env the child must carry (`GROK_HOME` = the
 *   home, `GROK_PROFILE_ENV`).
 *
 * SHARED HOME, NOT PER-THREAD (spec §10 left it to the builder). Every chat of a profile version
 * uses the one home; the rendered `config.toml` does not depend on the thread, the project or the
 * account (inspect runs with cwd = the home), so concurrent spawns write the same content, and a
 * render taken after a Global change is right for a chat already running too. Renders in this
 * host are serialized per home; the file is swapped by rename, so a starting CLI reads the old or
 * the new file, never a torn one. A per-thread home would split Grok's other per-home state
 * (bundled skills, model and settings caches, memory) per chat for no isolation gain.
 *
 * Static imports only (AGENTS.md: no dynamic `import()` under `agent-host`).
 */

import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { parse as parseToml } from "@decimalturn/toml-patch";

import {
  GROK_AUTH_PATH_ENV,
  GROK_PROFILE_ENV,
  grokDiscoveredPluginNames,
  grokSkillIgnoreList,
  renderGrokProfileConfigToml,
  type GrokPluginNamesResult
} from "../../../agent-isolation/grok.ts";
import type { GrokPreparedSection } from "../../../session-profiles/manifest/grok.ts";
import type { HostThreadProfile } from "../../host-protocol.ts";
import { ProfileLaunchError, loadProfileManifest } from "../profile-manifest.ts";

type Doc = Record<string, unknown>;

/** What a profile spawn adds to the Global launch. */
export interface GrokProfileSpawn {
  /** Laid over the child's env. */
  env: Record<string, string>;
  /** Options of the `agent` subcommand: inserted right after `agent` ({@link withAgentOptions}). */
  agentArgs: string[];
}

export interface GrokProfileSpawnInput {
  profile?: HostThreadProfile;
  /** The child's env as `buildEnv` made it (`HOME`, `GROK_AUTH_PATH` from the launch env). */
  env: Readonly<Record<string, string>>;
  /** The resolved `grok` binary. */
  command: string;
  /** Tests: `grok inspect --json` stand-in (same contract as `grokDiscoveredPluginNames`). */
  inspect?: (options: Parameters<typeof grokDiscoveredPluginNames>[0]) => Promise<GrokPluginNamesResult>;
}

/**
 * The profile launch for a start, or `null` for a Global thread. Throws {@link ProfileLaunchError}
 * (the start fails with its message) when the home cannot be launched from.
 */
export async function prepareGrokProfileSpawn(input: GrokProfileSpawnInput): Promise<GrokProfileSpawn | null> {
  const section = await loadProfileManifest(input, "grok");
  if (section === null || input.profile === undefined) {
    return null;
  }
  const home = input.profile.preparedDir;
  const authPath = input.env[GROK_AUTH_PATH_ENV];
  if (authPath === undefined || authPath.length === 0 || !isAbsolute(authPath)) {
    throw new ProfileLaunchError(
      "This chat's Agent Profile could not be loaded, so the agent was not started: the launch names no Grok sign-in (GROK_AUTH_PATH)."
    );
  }
  if (isInside(home, authPath)) {
    throw new ProfileLaunchError(
      "This chat's Agent Profile could not be loaded, so the agent was not started: the Grok sign-in cannot live in the profile's home."
    );
  }
  await renderSerialized(home, () => renderConfig(home, section, input));
  return {
    env: { ...GROK_PROFILE_ENV, GROK_HOME: home },
    agentArgs: [
      "--no-leader",
      ...[...section.plugins, ...(section.hooksPlugin !== undefined ? [section.hooksPlugin] : [])].flatMap((plugin) => [
        "--plugin-dir",
        join(home, plugin.path)
      ])
    ]
  };
}

/** `args` (a `grokSpawnArgs` answer) with `agentArgs` right after the `agent` subcommand. */
export function withAgentOptions(args: readonly string[], agentArgs: readonly string[]): string[] {
  const at = args.indexOf("agent");
  if (at === -1 || agentArgs.length === 0) {
    return [...args];
  }
  return [...args.slice(0, at + 1), ...agentArgs, ...args.slice(at + 1)];
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** One render at a time per home in this host; a failed render does not block the next. */
const renders = new Map<string, Promise<void>>();

async function renderSerialized(home: string, work: () => Promise<void>): Promise<void> {
  const previous = renders.get(home) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  renders.set(home, settled);
  void settled.then(() => {
    if (renders.get(home) === settled) renders.delete(home);
  });
  await next;
}

async function renderConfig(home: string, section: GrokPreparedSection, input: GrokProfileSpawnInput): Promise<void> {
  const fail = (reason: string, cause?: unknown): never => {
    throw new ProfileLaunchError(`This chat's Agent Profile could not be loaded, so the agent was not started: ${reason}`, { cause });
  };

  let base: Doc = {};
  try {
    const parsed: unknown = parseToml(await readFile(join(home, section.configBase), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) base = parsed as Doc;
  } catch (error) {
    fail("its prepared Grok config could not be read.", error);
  }
  const { mcp_servers: mcpServers, ...carriedOver } = base;

  const skillsIgnore = await grokSkillIgnoreList({
    home: input.env.HOME ?? homedir(),
    grokHome: home,
    hideBundled: section.hideBundledSkills
  });

  const inspect = input.inspect ?? grokDiscoveredPluginNames;
  const discovered = await inspect({
    grokBin: input.command,
    env: { ...input.env, ...GROK_PROFILE_ENV, GROK_HOME: home },
    cwd: home
  });
  if (!discovered.ok) {
    fail(`Grok's plugin list could not be read (${discovered.error}), and a chat never starts with unknown plugins.`);
    return;
  }
  const own = new Set([...section.plugins.map((plugin) => plugin.name), ...(section.hooksPlugin ? [section.hooksPlugin.name] : [])]);
  const pluginsDisabled = discovered.names.filter((name) => !own.has(name));

  const text = renderGrokProfileConfigToml({
    carriedOver,
    mcpServers: typeof mcpServers === "object" && mcpServers !== null && !Array.isArray(mcpServers) ? (mcpServers as Record<string, Doc>) : {},
    skillsIgnore,
    pluginsDisabled
  });
  const target = join(home, "config.toml");
  const temp = join(home, `.config.toml.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    fail("its Grok config could not be written.", error);
  }
}
