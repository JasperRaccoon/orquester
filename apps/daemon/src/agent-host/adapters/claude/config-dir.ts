/**
 * Claude adapter — where a CLI child keeps its config, sessions and
 * transcripts (spec §4.5 Claude).
 *
 * One answer for every reader: the probe's cache key and the per-cwd skills
 * overlay (`index.ts`), and the goal transcript reader (`goal-transcript.ts`,
 * goals §6.1.4). Two spellings of it drifted once — one fell back to the
 * env's `HOME`, the other to the host's — and a reader that disagrees with
 * the CLI about this directory reads nothing at all.
 */

import * as nodeOs from "node:os";
import * as nodePath from "node:path";

/**
 * The child env's `CLAUDE_CONFIG_DIR` (a managed account's home is bound
 * through it, `support/env.ts`), else the host user's `~/.claude` — the
 * child's `HOME` is always the daemon user's own, so that is the same
 * directory the CLI falls back to.
 */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.CLAUDE_CONFIG_DIR ?? nodePath.join(nodeOs.homedir(), ".claude");
}
