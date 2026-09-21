/**
 * Agent host — the launch environment for provider children
 * (spec §3.1 "Launch environment for provider children").
 *
 * Built **explicitly, never by spreading `process.env`**: the daemon's own
 * environment holds cliproxy and push secrets, and a provider child has no
 * business seeing them. That is the one place this differs from T3, which
 * layers per-instance vars over a spread of `process.env`
 * (`apps/server/src/provider/ProviderInstanceEnvironment.ts:5-22`).
 *
 * Two further rules from the same section:
 * - **Ambient credentials for the same vendor that did not come from the
 *   selected account are removed rather than left to win**, so a thread can
 *   never silently bill a different identity. Since nothing is inherited here,
 *   that is enforced by construction plus an explicit denylist for anything a
 *   caller passes in through `extraEnv`.
 * - **Values are passed verbatim.** `child_process.spawn` does not shell-expand
 *   env values, so any path the host injects must already be absolute — a
 *   `CODEX_HOME=~/.codex_work` reaches codex as the literal `~/...` and it
 *   errors that the path does not exist (§4.5 Codex).
 */

import type { AgentAdapterId } from "@orquester/api/agent-chat";

/** The env variable each adapter binds its managed account home through. */
export const ACCOUNT_HOME_ENV_VAR: Record<AgentAdapterId, string> = {
  /**
   * `CLAUDE_CONFIG_DIR` only. `HOME` is **never** overridden for Claude:
   * relocating `HOME` also relocates the macOS keychain lookup and the CLI
   * then reports "Not logged in" (§4.5 Claude).
   */
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "OPENCODE_DATA",
  grok: "GROK_HOME"
};

/**
 * Vendor credentials that must not reach a child unless they came from the
 * selected account. Anything matching is dropped from `extraEnv` for the
 * adapter that owns it; nothing is ever inherited, so this is a second line of
 * defence against a caller that builds `extraEnv` from a wider source.
 */
export const AMBIENT_CREDENTIAL_ENV_VARS: Record<AgentAdapterId, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY"],
  codex: ["OPENAI_API_KEY", "OPENAI_API_BASE", "CODEX_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"]
};

export interface BuildProviderEnvInput {
  adapter: AgentAdapterId;
  /**
   * `sessionPath()` — deliberately WIDER than the daemon's own PATH, which
   * under systemd omits the per-user bin dirs (`~/.local/bin`, `~/.cargo/bin`,
   * `~/go/bin`, …) that terminal sessions get.
   */
  sessionPath: string;
  /** `/tmp` is unavailable under `ProtectSystem=strict`; this is the appdir one. */
  tmpDir: string;
  /** The daemon user's HOME. Absolute. */
  homeDir: string;
  /**
   * The managed account's home dir, bound through
   * {@link ACCOUNT_HOME_ENV_VAR}. Absolute, already expanded. Omitted for a
   * system-identity thread.
   */
  accountHomeDir?: string;
  /**
   * The registry entry's own env plus, for claudex/claudemix, the cliproxy
   * launcher env exactly as `resolveExtraEnv` produces it today
   * (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
   * compaction and timeout vars).
   */
  extraEnv?: Readonly<Record<string, string | undefined>>;
  /** The chat session id. Stamped so a child can name its own tab. */
  sessionId: string;
  /**
   * Keep an ambient credential that this adapter would normally strip. The
   * ONLY legitimate caller is the cliproxy launcher path, where
   * `ANTHROPIC_AUTH_TOKEN` *is* the selected identity.
   */
  allowCredentialVars?: readonly string[];
}

/**
 * Build the complete environment for one provider child. The result is the
 * whole env — there is nothing to merge it into.
 *
 * Entries whose value is `undefined` are dropped rather than passed as the
 * string `"undefined"`, which is what `spawn` would otherwise do.
 */
export function buildProviderEnv(input: BuildProviderEnvInput): Record<string, string> {
  const {
    adapter,
    sessionPath,
    tmpDir,
    homeDir,
    accountHomeDir,
    extraEnv,
    sessionId,
    allowCredentialVars
  } = input;

  const env: Record<string, string> = {
    PATH: sessionPath,
    TMPDIR: tmpDir,
    HOME: homeDir,
    ORQUESTER_SESSION_ID: sessionId
  };

  const allowed = new Set(allowCredentialVars ?? []);
  const denied = new Set(
    AMBIENT_CREDENTIAL_ENV_VARS[adapter].filter((name) => !allowed.has(name))
  );

  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined || key.length === 0) {
      continue;
    }
    if (denied.has(key)) {
      continue;
    }
    // PATH/TMPDIR/HOME are the host's to decide; a launcher env must not move
    // a child off the session PATH or out of the writable TMPDIR.
    if (key === "PATH" || key === "TMPDIR" || key === "HOME") {
      continue;
    }
    env[key] = value;
  }

  // Last, so nothing in extraEnv can shadow the account binding.
  if (accountHomeDir !== undefined && accountHomeDir.length > 0) {
    env[ACCOUNT_HOME_ENV_VAR[adapter]] = accountHomeDir;
  }

  return env;
}

/**
 * True when a value would need shell expansion to be usable. The host injects
 * only absolute paths (§3.1), so this is an assertion helper for adapters and
 * for tests, not a fixer — nothing here rewrites a value.
 */
export function needsShellExpansion(value: string): boolean {
  return value.startsWith("~") || value.includes("$");
}
