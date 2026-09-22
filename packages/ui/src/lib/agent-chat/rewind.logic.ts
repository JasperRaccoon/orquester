/**
 * "Rewind to here" — the client's pure half (spec §5.5, §7.3, §7.4).
 *
 * Two surfaces offer a rewind: the per-row button under a user message and
 * the composer's picker, which the CLI's double-Escape opens ("jump to a
 * previous message"). Both read the SAME list, derived here from the rows the
 * timeline already stamped with `revertTurnCount`, so the button and the
 * picker can never disagree about what is rewindable.
 */

import type { Turn } from "@orquester/api/agent-chat";
import { startedTurns } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";

export interface RewindTarget {
  messageId: string;
  /** The message as sent; the composer gets it back verbatim. */
  text: string;
  createdAt: string;
  /** Turns kept — §5.5's `targetTurnCount`. */
  targetTurnCount: number;
  /** Turns the rewind removes, this message's own turn included. */
  droppedTurnCount: number;
  attachmentCount: number;
}

/**
 * Every user message the thread can rewind to, NEWEST first — the order the
 * picker lists them in, like the CLI's own. A row qualifies exactly when the
 * timeline stamped it with `revertTurnCount` (the adapter supports rollback,
 * the message opened a turn, no compaction sits after it), so this is a
 * projection of the rows, never a second rule.
 */
export function deriveRewindTargets(
  rows: readonly AgentChatTimelineRow[],
  turns: readonly Turn[]
): RewindTarget[] {
  const started = startedTurns(turns).length;
  const targets: RewindTarget[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (
      row.kind !== "message" ||
      row.message.role !== "user" ||
      typeof row.revertTurnCount !== "number"
    ) {
      continue;
    }
    targets.push({
      messageId: row.message.id,
      text: row.message.text,
      createdAt: row.message.createdAt,
      targetTurnCount: row.revertTurnCount,
      droppedTurnCount: Math.max(1, started - row.revertTurnCount),
      attachmentCount: row.message.attachments?.length ?? 0
    });
  }
  return targets;
}

/** One line of a message for a picker row: first non-empty line, collapsed, capped. */
export function rewindTargetPreview(text: string, maxChars = 90): string {
  const line =
    text
      .split("\n")
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .find((entry) => entry.length > 0) ?? "";
  if (line.length <= maxChars) {
    return line;
  }
  return `${line.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Two Escapes within this window make one double press — the CLI's own feel. */
export const ESCAPE_SEQUENCE_WINDOW_MS = 600;

export interface EscapeSequence {
  /** Record a press; `true` when it completes a double press. */
  press(nowMs: number): boolean;
  reset(): void;
}

/**
 * The CLI's double-Escape as a tiny state machine: a press within the window
 * of the previous one completes the sequence and clears it, so a third press
 * starts over rather than firing again.
 */
export function createEscapeSequence(windowMs = ESCAPE_SEQUENCE_WINDOW_MS): EscapeSequence {
  let lastAt: number | null = null;
  return {
    press(nowMs) {
      const second = lastAt !== null && nowMs >= lastAt && nowMs - lastAt <= windowMs;
      lastAt = second ? null : nowMs;
      return second;
    },
    reset() {
      lastAt = null;
    }
  };
}
