import { agentFamily } from "./agent-hooks.ts";

/**
 * Structural match for index.ts's unexported `LaunchEnv`. Declared locally on
 * purpose: index.ts imports THIS module, so importing the type back from
 * index.ts would be a cycle. `composeExtraEnv` accepts this shape structurally.
 */
type TimeoutLaunchEnv = { env: Record<string, string> };

/**
 * Claude harness stream/API timeout env for one session launch.
 *
 * Claude Code aborts a streaming request after 180 s with no bytes received
 * (its `$Dh` default) and renders "[Request interrupted by user]" — which
 * killed 37 of 52 subagents in a single workflow run on the VPS. These three
 * variables are the documented per-process overrides. The managed CLIProxyAPI
 * is NOT involved: it has no timeout of any kind and merely observes the
 * client hang up.
 *
 * Keys on the FAMILY, never the raw id: claudex/claudemix run the real `claude`
 * binary against the managed proxy, so they need the same env as plain `claude`
 * (same reasoning as agent-hooks.ts's config targeting).
 *
 * Returns null for non-claude launchers — these variables mean nothing to
 * codex/opencode/gemini and must not be set for them.
 */
export function claudeTimeoutEnv(entryId: string, minutes: number): TimeoutLaunchEnv | null {
  if (agentFamily(entryId) !== "claude") return null;
  const ms = String(minutes * 60_000);
  return {
    env: {
      API_TIMEOUT_MS: ms,
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: ms,
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: ms
    }
  };
}
