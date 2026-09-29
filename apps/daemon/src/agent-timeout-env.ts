import { agentFamily } from "./agent-hooks.ts";

type TimeoutLaunchEnv = { env: Record<string, string> };

/**
 * Override Claude's API and idle-stream timeouts for each session launch.
 * Other agent families do not use these variables.
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
