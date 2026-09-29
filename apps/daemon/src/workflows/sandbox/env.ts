// Automated workflows — the environment of a sandbox attempt (spec §5.6).
//
// Built explicitly, NEVER a spread of the daemon's `process.env` (the `sessionEnvBase` rule: the
// daemon's own environment holds `ORQUESTER_HTTP_PASSWORD` and push secrets, none of which
// a workflow script has any business seeing). What a script gets:
//
//   PATH      sessionPath() — the terminal sessions' PATH, wider than the daemon's under systemd
//   HOME, USER, LANG, TERM=dumb
//   TMPDIR    <appdir>/tmp (`/tmp` is unavailable under ProtectSystem=strict)
//   ORQUESTER_WORKFLOW_RUN_ID, ORQUESTER_WORKFLOW_ID
//   ORQUESTER_AGENT_LAUNCH  one fresh UUID per attempt — the launch marker every descendant
//                           inherits, so Settings → System lists (and can kill) a leftover
//   + the block's own env (already rendered; secrets allowed there by the user's choice)
//
// The workflow ids and the launch marker are set LAST: a block's env cannot shadow them.

import { randomUUID } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";

import { AGENT_LAUNCH_ENV_VAR } from "../../agent-host/support/leftover-processes.ts";
import { sessionPath } from "../../tmux.ts";

export const WORKFLOW_RUN_ID_ENV_VAR = "ORQUESTER_WORKFLOW_RUN_ID";
export const WORKFLOW_ID_ENV_VAR = "ORQUESTER_WORKFLOW_ID";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SandboxEnvInput {
  runId: string;
  workflowId: string;
  /** The block's env (rendered). */
  env: Readonly<Record<string, string>>;
  /** `<appdir>/tmp`. */
  tmpDir: string;
}

function currentUser(processEnv: NodeJS.ProcessEnv): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return processEnv.USER ?? processEnv.LOGNAME;
  }
}

/** The default `<appdir>/tmp`: the daemon's own TMPDIR (systemd points it there), else the OS's. */
export function defaultSandboxTmpDir(): string {
  return process.env.TMPDIR && process.env.TMPDIR.length > 0 ? process.env.TMPDIR : tmpdir();
}

/**
 * The attempt's environment. Throws on an env name that is not a shell identifier or a value with
 * a NUL byte (neither can reach a child process intact).
 */
export function buildSandboxEnv(input: SandboxEnvInput): Record<string, string> {
  const processEnv = process.env;
  const env: Record<string, string> = {
    PATH: sessionPath(),
    HOME: processEnv.HOME && processEnv.HOME.length > 0 ? processEnv.HOME : homedir(),
    LANG: processEnv.LANG && processEnv.LANG.length > 0 ? processEnv.LANG : "C.UTF-8",
    TERM: "dumb",
    TMPDIR: input.tmpDir
  };
  const user = currentUser(processEnv);
  if (user) {
    env.USER = user;
  }
  for (const [name, value] of Object.entries(input.env)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`The environment variable ${name} holds a value that cannot be passed to a process.`);
    }
    env[name] = value;
  }
  env[WORKFLOW_RUN_ID_ENV_VAR] = input.runId;
  env[WORKFLOW_ID_ENV_VAR] = input.workflowId;
  env[AGENT_LAUNCH_ENV_VAR] = randomUUID();
  return env;
}
