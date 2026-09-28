// Automated workflows — the sandbox the code and shell blocks run in (spec §5.6, §5.7, §5.8).
export {
  createSandboxRunner,
  readSandboxExit,
  SANDBOX_DEADLINE_BACKSTOP_MS,
  SANDBOX_KILL_GRACE_MS,
  SANDBOX_RUNNER_PATH,
  type DetailedSandboxRunner,
  type SandboxExitDetail,
  type SandboxExitRecord,
  type SandboxRunnerOptions
} from "./sandbox.ts";
export {
  buildSandboxEnv,
  defaultSandboxTmpDir,
  WORKFLOW_ID_ENV_VAR,
  WORKFLOW_RUN_ID_ENV_VAR,
  type SandboxEnvInput
} from "./env.ts";
export {
  createChunkRedactor,
  createRedactor,
  MIN_REDACTED_SECRET_LENGTH,
  redactChunk,
  secretPlaceholder,
  type ChunkRedactor,
  type SecretMatch,
  type SecretRedactor
} from "./redact.ts";
export { followLog, readLogWindow, type FollowLogOptions, type LogWindow, type ReadLogWindowOptions } from "./log-reader.ts";
export { isSameProcessAlive, readStarttime, signalGroupIfOurs } from "./proc.ts";
