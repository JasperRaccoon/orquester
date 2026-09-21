/**
 * Per-home preparation a chat thread needs before its first turn.
 *
 * These are **reality findings from real CLI captures**, not spec text, and
 * each one is a silent failure if it is skipped:
 *
 * - **Claude project trust.** A directory the CLI has never seen starts
 *   untrusted (`hasTrustDialogAccepted: false`), and the project's
 *   `.claude/settings.json`, hooks and skills are then silently ignored — with
 *   nothing on the wire to say so. A chat thread has no trust dialog to show,
 *   so the daemon marks the project trusted for the home the thread will run
 *   under, exactly as the terminal path already forces the first-run flags.
 * - **Grok permission requests are OFF by default.** Without
 *   `[features] support_permission = true` no approval ever reaches the
 *   protocol, so §4.3's approval cards would simply never appear.
 * - **Grok auto-update.** `auto_update = true` is the shipped default and the
 *   CLI was observed upgrading itself mid-session (1.0.3 → 1.0.34). §8's rule
 *   is that a running process holds a lease on its version; a CLI that swaps
 *   its own binary under a live thread breaks that.
 *
 * Everything here is **best-effort and idempotent**: a failure may only mean a
 * trust dialog the user has to accept in a terminal once, never a refused
 * launch.
 *
 * *Deliberately NOT done here:* nothing strips the MCP servers a home already
 * configures. Grok's Claude-compat path boots every server it finds in
 * `~/.claude.json` on `session/new` (~3 s, ~157 tools observed), which is slow
 * — but it is exactly what a terminal launch of the same agent under the same
 * home does today, and a chat thread that silently had fewer tools than the
 * terminal tab beside it would be a worse surprise than three seconds. Parity
 * wins; §4.5's `mcpServers: {}` is the *Claude SDK adapter's* own choice and
 * belongs there, not in the home.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HomePrepLogger {
  warn?: (...args: unknown[]) => void;
}

/**
 * Mark `cwd` trusted in the `.claude.json` that `claudeConfigDir` owns, and
 * force onboarding complete. Returns true when a write happened.
 *
 * `claudeConfigDir` is the value of `CLAUDE_CONFIG_DIR` for the thread — a
 * managed account home, a cliproxy launcher home, or the system config dir —
 * because `.claude.json` lives *inside* that dir whenever the variable is set
 * (the same rule `agent-accounts.ts` and `cliproxy-files.ts` already follow).
 */
export async function markClaudeProjectTrusted(
  claudeConfigFile: string,
  cwd: string,
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
    const next = applyClaudeProjectTrust(config, cwd);
    if (next === null) return false;
    await writeFile(claudeConfigFile, JSON.stringify(next), { mode: 0o600 });
    return true;
  } catch (error) {
    logger?.warn?.(`could not mark ${cwd} trusted in ${claudeConfigFile}`, error);
    return false;
  }
}

/**
 * Pure half of {@link markClaudeProjectTrusted}. Returns the config to write,
 * or null when nothing would change (no write churn on every turn).
 */
export function applyClaudeProjectTrust(
  config: Record<string, unknown>,
  cwd: string
): Record<string, unknown> | null {
  const projects =
    config.projects && typeof config.projects === "object" && !Array.isArray(config.projects)
      ? { ...(config.projects as Record<string, unknown>) }
      : {};
  const existing =
    projects[cwd] && typeof projects[cwd] === "object" && !Array.isArray(projects[cwd])
      ? { ...(projects[cwd] as Record<string, unknown>) }
      : {};
  const alreadyTrusted =
    existing.hasTrustDialogAccepted === true &&
    existing.hasCompletedProjectOnboarding === true &&
    config.hasCompletedOnboarding === true;
  if (alreadyTrusted) return null;
  projects[cwd] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true
  };
  return { ...config, projects, hasCompletedOnboarding: true };
}

/** The two keys a Grok chat launch needs (see the module comment). */
export const GROK_CHAT_CONFIG: ReadonlyArray<{ section: string | null; key: string; value: string }> = [
  { section: "features", key: "support_permission", value: "true" },
  { section: null, key: "auto_update", value: "false" }
];

/**
 * Apply {@link GROK_CHAT_CONFIG} to `<grokHome>/config.toml`. Returns true
 * when a write happened.
 *
 * **Scope note.** `agent-accounts.ts` shares this file with the system
 * `~/.grok/config.toml` by symlink (it carries the critical
 * `[compat.claude] hooks = false`), and `writeFile` follows the link, so these
 * two keys land host-wide rather than per account. That is intentional and the
 * lesser evil: `support_permission` only *adds* a confirmation the terminal
 * TUI already knows how to render, and `auto_update = false` is what §8 wants
 * for every launch, not only for chat.
 */
export async function ensureGrokChatConfig(
  grokHome: string,
  logger?: HomePrepLogger
): Promise<boolean> {
  const file = join(grokHome, "config.toml");
  try {
    let current = "";
    try {
      current = await readFile(file, "utf8");
    } catch {
      current = "";
    }
    let next = current;
    for (const entry of GROK_CHAT_CONFIG) {
      next = setTomlKey(next, entry.section, entry.key, entry.value);
    }
    if (next === current) return false;
    await writeFile(file, next, "utf8");
    return true;
  } catch (error) {
    logger?.warn?.(`could not prepare grok config at ${file}`, error);
    return false;
  }
}

/**
 * Set one scalar key in a TOML document, preserving everything else verbatim.
 *
 * Deliberately minimal — it handles exactly the two shapes
 * {@link GROK_CHAT_CONFIG} needs (a root key and a key in a named table) and
 * no more. A full TOML parser would be a new dependency, and rewriting a
 * user's config through a lossy round-trip is worse than not writing at all.
 */
export function setTomlKey(
  source: string,
  section: string | null,
  key: string,
  value: string
): string {
  const lines = source.length === 0 ? [] : source.split("\n");
  const assignment = `${key} = ${value}`;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const sectionPattern = /^\s*\[([^\]]+)\]\s*$/;

  let current: string | null = null;
  let sectionStart = -1;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const header = sectionPattern.exec(lines[i]);
    if (header) {
      if (current === section) sectionEnd = i;
      current = header[1].trim();
      if (current === section) sectionStart = i;
      continue;
    }
    if (current !== section) continue;
    if (keyPattern.test(lines[i])) {
      if (lines[i].trim() === assignment) return source; // already exactly right
      lines[i] = assignment;
      return ensureTrailingNewline(lines.join("\n"));
    }
  }
  if (current === section && sectionEnd === -1) sectionEnd = lines.length;

  if (section === null) {
    // A root key goes above the first table header, or at the top of an
    // empty/headerless file — below one it would belong to that table.
    const firstHeader = lines.findIndex((line) => sectionPattern.test(line));
    const at = firstHeader === -1 ? lines.length : firstHeader;
    lines.splice(at, 0, assignment);
    return ensureTrailingNewline(lines.join("\n"));
  }
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(`[${section}]`, assignment, "");
    return ensureTrailingNewline(out.join("\n"));
  }
  lines.splice(sectionEnd === -1 ? lines.length : sectionEnd, 0, assignment);
  return ensureTrailingNewline(lines.join("\n"));
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
