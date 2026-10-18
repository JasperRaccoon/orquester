/**
 * Codex adapter — an Agent Profile thread's own config (spec 2026-10-18 §6.2).
 *
 * A profile thread runs in its prepared `CODEX_HOME` (the daemon's launch contribution points
 * `CODEX_HOME` and the thread's home at it), which already holds only the profile's skills, MCP
 * servers, plugins, hooks and instructions. One global source is left: Codex reads user skills
 * from `$HOME/.agents/skills` whatever `CODEX_HOME` is. So at every `thread/start` AND
 * `thread/resume` (thread config is not persisted) the session lists the thread's skills
 * (`skills/list` with its cwd) and switches off, in the thread's `config`, every one that is not
 * the profile's:
 *
 * - any skill under a user skill root outside the home (`$HOME/.agents/skills`, and
 *   `$HOME/.agents/plugins` should a marketplace there surface one) — the prepared manifest's
 *   `userSkillRoots` plus the child's own `$HOME`, each also by realpath;
 * - any other `user`-scoped skill that does not live inside the prepared home (Codex
 *   canonicalizes skill paths, so a symlinked global skill shows up at its real location).
 *
 * Repo skills (`.agents/skills`, `.codex/skills` of the project) stay, as in a Global chat;
 * bundled (`system`) skills are hidden by the home's `[skills.bundled] enabled = false`.
 *
 * The override is NESTED: `config: {skills: {config: [{path, enabled: false}, …]}}` (verified on
 * codex-cli 0.159.0 against a capturing mock provider: the disabled skill is absent from the
 * model request, the profile's present). A table value is merged into the config, so the home's
 * `skills.bundled` stays. Quoted dotted keys are silently ignored, so never send those.
 */

import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { CodexPreparedSection } from "../../../session-profiles/manifest/codex.ts";
import { ProfileLaunchError } from "../profile-manifest.ts";
import type { CodexProtocol } from "./_generated/index.ts";

/** `thread/start`'s (and `thread/resume`'s) `config` map. */
type ThreadConfig = NonNullable<CodexProtocol.v2.ThreadStartParams["config"]>;

/** What a profile session is started with (the adapter builds it from the prepared manifest). */
export interface CodexProfileLaunch {
  /** The prepared home (`HostThreadProfile.preparedDir`): the child's `CODEX_HOME`. */
  codexHome: string;
  /** Its realpath when it differs (skill paths come back canonical). */
  codexHomeReal?: string;
  /** User skill roots outside the home whose skills are switched off, each also by realpath. */
  userSkillRoots: readonly string[];
}

function inside(path: string, root: string): boolean {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return base.length > 0 && (path === base || path.startsWith(`${base}/`));
}

/**
 * The `SKILL.md` paths, from a `skills/list` answer, that a profile thread switches off (see the
 * module header). Deduplicated, in listing order.
 */
export function codexProfileSkillDisables(
  entries: readonly CodexProtocol.v2.SkillsListEntry[],
  launch: CodexProfileLaunch
): string[] {
  const homes = [launch.codexHome, launch.codexHomeReal].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  const out: string[] = [];
  for (const entry of entries) {
    for (const skill of entry.skills) {
      const path = skill.path;
      if (typeof path !== "string" || path.length === 0 || out.includes(path)) continue;
      const ours = homes.some((home) => inside(path, home));
      const global = launch.userSkillRoots.some((root) => inside(path, root));
      if (global || (skill.scope === "user" && !ours)) out.push(path);
    }
  }
  return out;
}

/** The thread `config` switching `paths` off (nested; empty = nothing to send). */
export function codexProfileSkillsConfig(paths: readonly string[]): ThreadConfig {
  return paths.length === 0 ? {} : { skills: { config: paths.map((path) => ({ path, enabled: false })) } };
}

/**
 * The session's {@link CodexProfileLaunch} for a prepared home and its manifest section, with the
 * child's own `$HOME` roots added and every path also by realpath. Throws
 * {@link ProfileLaunchError} when the home's seeded state DB is gone (never launch an unseeded
 * home: it would rescan the whole history first, spec §6.2 — the daemon prepares a new version).
 */
export async function codexProfileLaunch(
  preparedDir: string,
  section: CodexPreparedSection,
  childHome: string | undefined
): Promise<CodexProfileLaunch> {
  if (section.stateDbFile) {
    const db = await lstat(join(preparedDir, section.stateDbFile)).catch(() => null);
    if (!db?.isFile()) {
      throw new ProfileLaunchError(
        "This chat's Agent Profile could not be loaded, so the agent was not started: its prepared Codex home is not seeded; it is being prepared again."
      );
    }
  }
  const roots = new Set<string>(section.userSkillRoots ?? []);
  if (childHome) {
    roots.add(join(childHome, ".agents", "skills"));
    roots.add(join(childHome, ".agents", "plugins"));
  }
  for (const root of [...roots]) {
    const real = await realpath(root).catch(() => null);
    if (real !== null) roots.add(real);
  }
  const real = await realpath(preparedDir).catch(() => null);
  return {
    codexHome: preparedDir,
    ...(real !== null && real !== preparedDir ? { codexHomeReal: real } : {}),
    userSkillRoots: [...roots]
  };
}
