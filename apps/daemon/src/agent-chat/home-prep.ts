/**
 * Grant Claude project trust for a chat thread, which cannot show a trust dialog.
 * Without it Claude ignores the project's settings, hooks and skills.
 *
 * The caller must confine the project path to fsRoot before granting trust.
 * Write atomically through dotfile symlinks, preserve the rest of the config,
 * and force mode 0600 because the file may contain credentials. A concurrent
 * CLI write can still race this read-modify-write.
 *
 * Grok settings belong in the adapter's per-launch overlay; managed homes may
 * symlink the system config. Leave configured MCP servers intact so chat and
 * terminal launches have the same tools.
 */

import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../agent-hooks.ts";

export interface HomePrepLogger {
  warn?: (...args: unknown[]) => void;
}

/**
 * Mark `projectDir` trusted in the `.claude.json` that the thread's home owns,
 * and force onboarding complete. Returns true when a write happened.
 *
 * `claudeConfigFile` is `<CLAUDE_CONFIG_DIR>/.claude.json` for the thread — a
 * managed account home or the system config file — the same rule
 * `agent-accounts.ts` already follows.
 *
 * `projectDir` MUST be a path the caller has confined to `fsRoot`; this
 * function is the writer, not the gatekeeper.
 */
export async function markClaudeProjectTrusted(
  claudeConfigFile: string,
  projectDir: string,
  logger?: HomePrepLogger
): Promise<boolean> {
  try {
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(claudeConfigFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Absent or unreadable: a fresh home. Writing the minimal shape is
      // correct — `seedClaudeConfig` merges onto whatever is there next time.
    }
    const next = applyClaudeProjectTrust(config, projectDir);
    if (next === null) return false;
    // Atomic, symlink-following, mode forced to 0600 (see the module comment).
    await writeFileAtomic(claudeConfigFile, JSON.stringify(next), 0o600, false);
    return true;
  } catch (error) {
    logger?.warn?.(`could not mark ${projectDir} trusted in ${claudeConfigFile}`, error);
    return false;
  }
}

/**
 * Pure half of {@link markClaudeProjectTrusted}. Returns the config to write,
 * or null when nothing would change (no write churn on every turn).
 */
export function applyClaudeProjectTrust(
  config: Record<string, unknown>,
  projectDir: string
): Record<string, unknown> | null {
  const projects =
    config.projects && typeof config.projects === "object" && !Array.isArray(config.projects)
      ? { ...(config.projects as Record<string, unknown>) }
      : {};
  const existing =
    projects[projectDir] && typeof projects[projectDir] === "object" && !Array.isArray(projects[projectDir])
      ? { ...(projects[projectDir] as Record<string, unknown>) }
      : {};
  const alreadyTrusted =
    existing.hasTrustDialogAccepted === true &&
    existing.hasCompletedProjectOnboarding === true &&
    config.hasCompletedOnboarding === true;
  if (alreadyTrusted) return null;
  projects[projectDir] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true
  };
  return { ...config, projects, hasCompletedOnboarding: true };
}
