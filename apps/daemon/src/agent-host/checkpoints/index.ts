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
  CheckpointRefUnavailableError,
  CheckpointTurnRangeError,
  createCheckpointService
} from "./service.ts";
