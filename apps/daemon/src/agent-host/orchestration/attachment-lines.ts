/**
 * Agent host — how an attachment reaches a provider that does not ingest it
 * natively (spec §4.1, §6.2).
 *
 * Every adapter ingests SOME attachments natively — Claude inline image
 * bytes, Codex a `localImage` path item, OpenCode a `file` part — and nothing
 * else. Everything else (a PDF, a CSV, a large paste the composer turned into
 * `pasted-text.txt`, and every attachment on Grok, which declares no prompt
 * capability for images) reaches the agent as one line per file, appended
 * AFTER the turn text:
 *
 *     Attached file: <name> (<absolute path>)
 *
 * The path is the host's own copy in the thread's `attachments/` dir, which
 * the agent can open with its own read tool (Claude gets that dir as an
 * additional allowed directory, so no approval prompt either). The same line
 * is what a native question answer folds its attachments into, so a file
 * reads identically wherever it arrives.
 *
 * This step used to be missing: the adapters skipped every attachment they
 * did not ingest on the assumption that the host had already put its path in
 * the prompt, and nothing had — so a PDF never reached Claude or Codex (nor
 * OpenCode outside image/text/PDF or above 20 MiB), and a file-only turn
 * broke outright. Grok alone printed its own path block.
 *
 * Pure: no I/O. The orchestrator resolves and stats the files, then asks the
 * adapter's `ingestsAttachment` predicate, then renders with this module.
 */

import { MAX_TURN_ATTACHMENTS, type AttachmentRef } from "@orquester/api/agent-chat";

/**
 * One attachment the host has resolved against the thread's attachments dir.
 * `ref.sizeBytes` is the size the host STAT'd, never the one the client
 * declared (§6.3).
 */
export interface ResolvedAttachment {
  readonly ref: AttachmentRef;
  readonly path: string;
}

/** A display name in a line is capped at this many characters (code points). */
export const ATTACHMENT_LINE_NAME_MAX_CHARS = 255;

/**
 * Room each line leaves for everything that is not the name: the fixed
 * `Attached file: ` / ` (` / `)` frame, the separating newline and the
 * absolute path itself — which is `<appdir>/daemon/agent/threads/<id>/
 * attachments/<attachmentId>.<ext>`, around 200 characters on a real host.
 */
const ATTACHMENT_LINE_PATH_ROOM_CHARS = 512;

/**
 * The most a turn's lines add to its text: one line per attachment, at most
 * {@link MAX_TURN_ATTACHMENTS} of them, each a capped name plus path room.
 * An adapter that bounds its whole input (Grok) bounds it at
 * `MAX_TURN_INPUT_CHARS + ATTACHMENT_LINES_MAX_CHARS`, since `MAX_TURN_INPUT_CHARS`
 * is the bound of the text the user typed, before any line was appended.
 */
export const ATTACHMENT_LINES_MAX_CHARS =
  MAX_TURN_ATTACHMENTS * (ATTACHMENT_LINE_NAME_MAX_CHARS + ATTACHMENT_LINE_PATH_ROOM_CHARS);

/** The prefix every line starts with — one spelling, used everywhere. */
const LINE_PREFIX = "Attached file: ";

/**
 * Control characters (C0, DEL, C1) and the Unicode line and paragraph
 * separators: anything that would end the line early, or smuggle a second
 * "line" into the provider's prompt under a file's name.
 */
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * A file name as a line shows it: every control character becomes a space,
 * runs of whitespace collapse to one, the ends are trimmed, and the result is
 * capped at {@link ATTACHMENT_LINE_NAME_MAX_CHARS} code points (never half a
 * surrogate pair). A name with nothing left is `attachment` — a line must
 * always name something.
 */
export function attachmentLineName(name: string): string {
  const flat = name.replace(LINE_BREAKING, " ").replace(/\s+/gu, " ").trim();
  const capped = Array.from(flat).slice(0, ATTACHMENT_LINE_NAME_MAX_CHARS).join("").trimEnd();
  return capped.length > 0 ? capped : "attachment";
}

/** `Attached file: <name> (<absolute path>)`. */
export function attachmentPathLine(entry: ResolvedAttachment): string {
  return `${LINE_PREFIX}${attachmentLineName(entry.ref.name)} (${entry.path})`;
}

/**
 * `Attached file: <name> (not available)` — for an attachment the host could
 * not resolve where a whole command cannot be refused for it any more (a
 * native question answer): the agent still learns a file was meant.
 */
export function unavailableAttachmentLine(ref: AttachmentRef): string {
  return `${LINE_PREFIX}${attachmentLineName(ref.name)} (not available)`;
}

/** One line per entry, in order, joined with `\n`. Empty for no entries. */
export function attachmentPathLines(entries: readonly ResolvedAttachment[]): string {
  return entries.map(attachmentPathLine).join("\n");
}

/**
 * The lines go AFTER the text, separated by a blank line — never before and
 * never wrapping it, so a turn that opens with `/command` still opens with it
 * and the CLI still dispatches it (§4.6.9). A file-only turn is the lines
 * alone; no lines leaves the text untouched.
 */
export function appendAttachmentLines(text: string, lines: string): string {
  if (lines.length === 0) {
    return text;
  }
  if (text.length === 0) {
    return lines;
  }
  return `${text}\n\n${lines}`;
}

/**
 * Split a turn's resolved attachments on the adapter's `ingestsAttachment`
 * predicate, in one pass and in order: `native` rides `SendTurnInput.attachments`
 * as references (carrying the stat'd size), `flattened` becomes path lines.
 */
export function partitionAttachments(
  resolved: readonly ResolvedAttachment[],
  ingests: (attachment: AttachmentRef) => boolean
): { native: AttachmentRef[]; flattened: ResolvedAttachment[] } {
  const native: AttachmentRef[] = [];
  const flattened: ResolvedAttachment[] = [];
  for (const entry of resolved) {
    if (ingests(entry.ref)) {
      native.push(entry.ref);
    } else {
      flattened.push(entry);
    }
  }
  return { native, flattened };
}
