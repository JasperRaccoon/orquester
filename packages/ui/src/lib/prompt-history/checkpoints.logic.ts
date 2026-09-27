/**
 * The right rail's History — checkpoints, as the panel lists them.
 *
 * A checkpoint is the working tree as one turn left it (§5.4): captured per
 * turn in a git project, never in any other, and numbered by the turn's
 * ORDER. The panel browses them — the files each turn changed, its diff —
 * and offers "Rewind to here" on the prompt that started the turn, which is
 * the existing conversation-only rewind: files are never touched.
 *
 * Only `ready` checkpoints are listed or joined: a `missing` one is a
 * placeholder, an `error` one captured nothing, and neither has a diff.
 */

import type { Checkpoint, CheckpointFile, ThreadHistoryPage, Turn } from "@orquester/api/agent-chat";

import type { HistoryPrompt, LoadedPrompts } from "./prompts.logic";
import type { RewindPrompt } from "./rewind.logic";

/** The fold's own key for one checkpoint (`fold.ts` `checkpointKey`). */
export function checkpointKey(checkpoint: Pick<Checkpoint, "turnId" | "checkpointTurnCount">): string {
  return checkpoint.turnId !== null ? `t:${checkpoint.turnId}` : `n:${checkpoint.checkpointTurnCount}`;
}

/**
 * Every `ready` checkpoint the chat holds, NEWEST FIRST (by turn count): the
 * fold's own (it keeps the latest 500), then any older one only a loaded
 * history page carries. The fold's copy wins a key both hold.
 */
export function readyCheckpoints(
  checkpoints: readonly Checkpoint[],
  pages: readonly ThreadHistoryPage[] = []
): Checkpoint[] {
  const byKey = new Map<string, Checkpoint>();
  for (const page of pages) {
    for (const checkpoint of page.checkpoints) {
      if (checkpoint.status === "ready") byKey.set(checkpointKey(checkpoint), checkpoint);
    }
  }
  for (const checkpoint of checkpoints) {
    const key = checkpointKey(checkpoint);
    if (checkpoint.status === "ready") {
      byKey.set(key, checkpoint);
    } else {
      // The fold is the authority: a checkpoint it holds as not-ready is not
      // made ready by a page read before it changed.
      byKey.delete(key);
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.checkpointTurnCount - left.checkpointTurnCount
  );
}

/** Turn id → its `ready` checkpoint — what a prompt that started the turn shows. */
export function checkpointsByTurnId(ready: readonly Checkpoint[]): ReadonlyMap<string, Checkpoint> {
  const byTurn = new Map<string, Checkpoint>();
  for (const checkpoint of ready) {
    if (checkpoint.turnId !== null && !byTurn.has(checkpoint.turnId)) {
      byTurn.set(checkpoint.turnId, checkpoint);
    }
  }
  return byTurn;
}

/**
 * The checkpoint a listed prompt shows: its turn's, only when the prompt
 * STARTED that turn — a steer rides a turn another prompt opened.
 */
export function promptCheckpoint(
  prompt: Pick<HistoryPrompt, "turnId" | "turnOrdinal">,
  byTurnId: ReadonlyMap<string, Checkpoint>
): Checkpoint | null {
  if (prompt.turnId === null || prompt.turnOrdinal === null) return null;
  return byTurnId.get(prompt.turnId) ?? null;
}

export interface DiffSummary {
  fileCount: number;
  additions: number;
  deletions: number;
}

/** "3 files +20 −4" as numbers; a file without counts (binary) counts as a file only. */
export function diffSummaryOf(files: readonly CheckpointFile[]): DiffSummary {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (typeof file.additions === "number") additions += file.additions;
    if (typeof file.deletions === "number") deletions += file.deletions;
  }
  return { fileCount: files.length, additions, deletions };
}

/**
 * What opened a checkpoint's turn, as the Checkpoints view names it. Every
 * user message that opened a turn is what "Rewind to here" goes back to —
 * the listed prompt, or the `opener` of a plan's Implement or of a message
 * the list does not hold — and the timeline's rows still decide whether the
 * rewind is offered (`promptRewindTarget`).
 */
export type CheckpointOrigin =
  /** A prompt the list holds — shown, reusable, and what "Rewind to here" goes back to. */
  | { kind: "prompt"; prompt: HistoryPrompt }
  /** No prompt: a goal continuation, a turn the CLI started by itself. */
  | { kind: "agent" }
  /** The Implement prompt the app composed from a proposed plan. */
  | { kind: "plan"; opener: RewindPrompt | null }
  /**
   * A user message opened it, but not one the list holds: older than what is
   * loaded, or one that is not a reusable prompt (an image-only message).
   */
  | { kind: "unlisted"; opener: RewindPrompt | null };

/** The message a rewind from this checkpoint goes back to; null when no user message opened the turn. */
export function checkpointRewindPrompt(origin: CheckpointOrigin): RewindPrompt | null {
  switch (origin.kind) {
    case "prompt":
      return origin.prompt;
    case "agent":
      return null;
    case "plan":
    case "unlisted":
      return origin.opener;
  }
}

export interface CheckpointEntry {
  /** Stable React key. */
  key: string;
  checkpoint: Checkpoint;
  /** The turn's 1-based ordinal among the started turns; the checkpoint's own count otherwise. */
  turnNumber: number;
  origin: CheckpointOrigin;
  summary: DiffSummary;
}

/**
 * One card per `ready` checkpoint, newest first, each with what opened its
 * turn: the prompt from the merged list (`Turn.userMessageId`, the fold keeps
 * every turn), "the agent" for a turn no prompt opened, the plan's Implement
 * for the app's own prompt, and "unlisted" for a prompt the list lacks.
 */
export function deriveCheckpointEntries(input: {
  ready: readonly Checkpoint[];
  turns: readonly Turn[];
  ordinals: ReadonlyMap<string, number>;
  prompts: readonly HistoryPrompt[];
  unlisted: LoadedPrompts["unlisted"];
}): CheckpointEntry[] {
  const promptById = new Map<string, HistoryPrompt>();
  for (const prompt of input.prompts) promptById.set(prompt.messageId, prompt);
  const openerByTurnId = new Map<string, string | null>();
  for (const turn of input.turns) {
    if (turn.turnId !== null && !openerByTurnId.has(turn.turnId)) {
      openerByTurnId.set(turn.turnId, turn.userMessageId ?? null);
    }
  }
  return input.ready.map((checkpoint) => {
    const turnId = checkpoint.turnId;
    return {
      key: `${checkpointKey(checkpoint)}#${checkpoint.checkpointTurnCount}`,
      checkpoint,
      turnNumber: (turnId !== null ? input.ordinals.get(turnId) : undefined) ?? checkpoint.checkpointTurnCount,
      origin: checkpointOrigin(checkpoint, openerByTurnId, promptById, input.unlisted, input.ordinals),
      summary: diffSummaryOf(checkpoint.files)
    };
  });
}

function checkpointOrigin(
  checkpoint: Checkpoint,
  openerByTurnId: ReadonlyMap<string, string | null>,
  promptById: ReadonlyMap<string, HistoryPrompt>,
  unlisted: LoadedPrompts["unlisted"],
  ordinals: ReadonlyMap<string, number>
): CheckpointOrigin {
  const turnId = checkpoint.turnId;
  if (turnId === null || !openerByTurnId.has(turnId)) return { kind: "unlisted", opener: null };
  const opener = openerByTurnId.get(turnId) ?? null;
  if (opener === null) return { kind: "agent" };
  const prompt = promptById.get(opener);
  if (prompt !== undefined) return { kind: "prompt", prompt };
  const kind = unlisted.get(opener);
  if (kind === "agent") return { kind: "agent" };
  // Not a listed prompt, but still the user message that opened the turn:
  // the rows alone can offer a rewind to it (a "loaded" opener the rows do
  // not render is offered none), exactly as the timeline would.
  const rewindTo: RewindPrompt | null =
    ordinals.has(turnId)
      ? {
          messageId: opener,
          turnId,
          turnOrdinal: ordinals.get(turnId) ?? null,
          // Read only for an index-sourced prompt; this one is never that.
          createdAt: checkpoint.completedAt,
          source: "loaded",
          indexRewindable: null
        }
      : null;
  if (kind === "plan") return { kind: "plan", opener: rewindTo };
  return { kind: "unlisted", opener: rewindTo };
}

/** The checkpoints whose opening prompt or changed files hold every search term. */
export function filterCheckpointsBySearch(
  entries: readonly CheckpointEntry[],
  matches: (text: string) => boolean
): readonly CheckpointEntry[] {
  return entries.filter((entry) => {
    const prompt = entry.origin.kind === "prompt" ? entry.origin.prompt.text : "";
    const paths = entry.checkpoint.files.map((file) => file.path).join("\n");
    return matches(`${prompt}\n${paths}`);
  });
}
