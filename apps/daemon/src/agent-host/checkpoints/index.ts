/**
 * Checkpoint service factory — the composition seam W1 (host core) wires in
 * `main.ts` (spec §5.4, §5.5).
 *
 * One hidden ref per turn,
 * `refs/orquester/checkpoints/<base64url(threadId)>/turn/<n>`, captured through
 * an isolated temporary index inside the repository's git common dir. Nothing
 * here touches the user's working tree, index, HEAD, branches, stash or
 * visible reflog — §5.5's revert is conversation-only, so there is no restore
 * path to call by accident. A non-git project skips silently, and a capture or
 * diff failure is reported on the result (`status: "error"` / `detail`) rather
 * than thrown into the turn.
 */

export {
  CHECKPOINT_DIFF_CACHE_LIMIT,
  CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
  CHECKPOINT_REF_LIMIT,
  CheckpointRefUnavailableError,
  CheckpointRollbackUnsupportedError,
  CheckpointTurnRangeError,
  createCheckpointService
} from "./service.ts";
export type {
  CaptureBaselineInput,
  CaptureTurnEndInput,
  CheckpointServiceOptions
} from "./service.ts";

export {
  CHECKPOINT_REFS_PREFIX,
  checkpointRefForThreadTurn,
  checkpointRefNamespace,
  turnCountFromCheckpointRef
} from "./refs.ts";
export { parseTurnDiffFilesFromNumstat } from "./numstat.ts";
export {
  GIT_DEFAULT_CONCURRENCY,
  GIT_DEFAULT_MAX_OUTPUT_BYTES,
  GIT_DEFAULT_TIMEOUT_MS,
  GitError,
  GitExitError,
  GitOutputLimitError,
  GitSpawnError,
  GitTimeoutError,
  createGitRunner
} from "./git.ts";
export type { GitRunInput, GitRunResult, GitRunner, GitRunnerOptions } from "./git.ts";
export { CHECKPOINT_CAPTURE_OPERATION, captureCheckpoint, isInsideWorkTree } from "./capture.ts";
