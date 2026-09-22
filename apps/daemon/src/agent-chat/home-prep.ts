/**
 * Per-home preparation a chat thread needs before its first turn.
 *
 * Exactly one thing lives here now: **Claude project trust.** A directory the
 * CLI has never seen starts untrusted (`hasTrustDialogAccepted: false`), and
 * the project's `.claude/settings.json`, hooks and skills are then silently
 * ignored — with nothing on the wire to say so. A chat thread has no trust
 * dialog to show, so the daemon marks the project trusted for the home the
 * thread will run under, exactly as the terminal path already forces the
 * first-run flags.
 *
 * Two rules the reviewers found the hard way, and both are load-bearing:
 *
 * 1. **The write is atomic and mode-explicit.** For `home: "system"` the target
 *    is the user's real `~/.claude.json`, which the Claude CLI in terminal tabs
 *    rewrites constantly and which carries `oauthAccount`/`userID` and the MCP
 *    config. A plain truncating `writeFile` leaves an empty config on a crash
 *    or a full disk, destroying every project entry and the account state.
 *    `writeFileAtomic` is the house helper for exactly this class of file
 *    (tmp + realpath + rename, so a dotfiles symlink survives); the mode is
 *    forced to 0600 rather than preserved, because `{mode}` on `writeFile` is
 *    inert for an existing file and a 0644 credential-bearing config should
 *    narrow, never stay wide.
 *
 *    A lost update against a concurrently-writing CLI is still possible and is
 *    inherent to a read-modify-write on someone else's file; the window is one
 *    call per chat-tab create, and the read and the write are adjacent.
 *
 * 2. **The trusted path is the daemon's, never the client's.** Claude's trust
 *    dialog is a security control: an untrusted directory's hooks (arbitrary
 *    shell, run as the daemon user, which holds scoped passwordless sudo) are
 *    ignored until it is accepted. The caller must therefore hand in a path it
 *    has already confined to `fsRoot` — see `resolveTrustedProjectDir` in
 *    `index.ts`. Never `cwd` off the create request.
 *
 * **Deliberately NOT here any more: the Grok config write.** It used to set
 * `[features] support_permission = true` and `auto_update = false` in
 * `<grokHome>/config.toml`. On a managed account home that file is a SYMLINK to
 * the daemon user's own `~/.grok/config.toml` (`agent-accounts.ts` shares it
 * for `[compat.claude] hooks = false`), so the write followed the link and
 * reconfigured Grok host-wide — for every terminal tab and every account — from
 * one chat launch. Per the fix-wave arbitration the daemon no longer writes any
 * shared home file; the Grok adapter (W9) owns getting those settings to the
 * CLI without touching it.
 *
 * *Deliberately NOT done either:* nothing strips the MCP servers a home already
 * configures. Grok's Claude-compat path boots every server it finds in
 * `~/.claude.json` on `session/new` (~3 s, ~157 tools observed) and Codex boots
 * whatever `~/.codex/config.toml` names, which is slow — but it is exactly what
 * a terminal launch of the same agent under the same home does today, and a
 * chat thread that silently had fewer tools than the terminal tab beside it
 * would be a worse surprise. Parity wins; §4.5's `mcpServers: {}` is the
 * *Claude SDK adapter's* own choice and belongs there, not in the home.
 *
 * **The recorded cost of that decision (E2E E20).** A provider CLI spawns its
 * MCP servers itself, so they are children of the provider child, not of the
 * daemon. One observed `serena start-mcp-server` survived both the agent host
 * and the daemon, reparented to init, held a fixed loopback port for five
 * hours, and was reaped by neither `session/stop`, thread deletion nor host
 * shutdown — and being outside the daemon's process tree it is not a legal
 * `POST /api/system/processes/kill` target either. On a long-lived VPS that is
 * one leak per configured MCP server per thread. The decision to inherit
 * stands; the reaping belongs to the host's teardown (a process-group kill of
 * each provider child), which is where the parent relationship actually
 * exists. Tracked as an open issue against the host, not worked around here.
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
 * managed account home, a cliproxy launcher home, or the system config file —
 * the same rule `agent-accounts.ts` and `cliproxy-files.ts` already follow.
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
