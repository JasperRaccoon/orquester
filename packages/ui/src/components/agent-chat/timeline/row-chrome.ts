/**
 * Row chrome the components own — the part of §7.3 that is not the shared
 * presentation resolver.
 *
 * **The resolver itself lives in `lib/agent-chat/presentation.logic.ts` and
 * there is exactly one of it** (fix-wave arbitration for R7-6). This file
 * holds only what has no counterpart there and never will: helpers whose
 * output is a class name, a glyph name or a re-shaped row rather than a
 * decision about an entry. Nothing here duplicates a function in that module —
 * if you are about to add one, add it there instead.
 */

import { IDENTITY_CHANGED_ACTIVITY_KIND } from "@orquester/api/agent-chat";

import type { ToolGroupSummaryKind, WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { skillMentionsInText } from "../composer/composer-menu";
import {
  toolGroupSummaryIconName,
  type WorkEntryIconName
} from "../../../lib/agent-chat/presentation.logic";
import { escapeRegExp } from "../../../lib/regexp";

/**
 * Absorbed by W11 into the one resolver (fix-wave R7-6) and re-exported here
 * only so existing imports keep resolving. **These are not second copies** —
 * there is exactly one implementation, in `presentation.logic.ts`.
 */
export {
  showDestructiveRowStyle,
  workEntryIsActiveTurnActivity
} from "../../../lib/agent-chat/presentation.logic";

/**
 * Glyph names the timeline adds on top of the shared union: a compaction
 * marker and the rerouted-model notice, neither of which is a tool call, so
 * neither belongs in the resolver's icon vocabulary.
 */
export type RowGlyphName = WorkEntryIconName | "minimize-2" | "shuffle";

/** The "+N more" row carries the contract's five-arm kind, not the resolver's. */
export function summaryKindIconName(kind: ToolGroupSummaryKind): WorkEntryIconName {
  return toolGroupSummaryIconName(kind);
}

/** The inline "the model you asked for was not the model that ran" notice (§7.3). */
export function workEntryIsRerouteNotice(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "model.rerouted";
}

/**
 * The §3.4 account switch marker — "from here on, another identity".
 *
 * Like the reroute notice it is a statement about *this point in the
 * conversation* rather than an action the agent took, so it renders as an
 * inline banded row and not as a tool call.
 */
export function workEntryIsIdentityChange(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === IDENTITY_CHANGED_ACTIVITY_KIND;
}

// ---------------------------------------------------------------------------
// Folding one tool call's lifecycle rows into the row that renders it
// ---------------------------------------------------------------------------

/** A streamed output chunk of a tool call, not a tool call of its own. */
export function isToolOutputRow(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "tool.output";
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Folds one tool call's lifecycle rows into the row that renders it.
 *
 * Two realities from the protocol captures make this necessary, and both are
 * keyed on `toolUseId` (`toolCallId` here), which §5.6 guarantees is stable
 * across every update of one call:
 *
 *  - **Streamed command output arrives as its own rows.** W3 turns
 *    `content.delta {command_output|file_change_output}` into chunked, batched
 *    `tool.output` activities. They are the *inside* of a tool row, not twenty
 *    sibling rows: they are concatenated in arrival order and become the owning
 *    row's expanded output, and they are removed from the group.
 *  - **A `fileChange` approval carries no diff** (Codex): only the id of the
 *    `item.started` that preceded it. A row that says "Apply patch?" and
 *    nothing else is unanswerable, so a row borrows `command`, `detail` and
 *    `changedFiles` from a sibling of the same call that has them.
 *
 * Three properties keep this from being a re-derivation of thread state:
 *
 *  - it is scoped to the rows already in one group, never to the thread;
 *  - it is keyed on the id, never on a label match;
 *  - it only ever **adds** to a row, except for the streamed output, which is
 *    the fuller truth and therefore wins over a slimmed summary. An orphan
 *    output chunk — one whose owner is not in this group — is kept as its own
 *    row rather than silently dropped. The returned entry is the same reference
 *    when nothing was filled, so a settled group's row memos are untouched.
 */
export function joinLifecycleDetails<T extends WorkLogEntry>(entries: readonly T[]): T[] {
  const owners = new Set<string>();
  const outputs = new Map<string, string[]>();
  const borrowed = new Map<
    string,
    { command?: string; detail?: string; changedFiles?: readonly string[] }
  >();

  for (const entry of entries) {
    const callId = entry.toolCallId;
    if (callId === undefined) continue;
    if (isToolOutputRow(entry)) {
      // NOT `nonEmpty`: trimming a streamed chunk would eat the newlines that
      // separate it from the next one, and a command's output is its whitespace.
      const chunk = entry.detail;
      if (chunk !== undefined && chunk.length > 0) {
        const chunks = outputs.get(callId);
        if (chunks) chunks.push(chunk);
        else outputs.set(callId, [chunk]);
      }
      continue;
    }
    owners.add(callId);
    const slot = borrowed.get(callId) ?? {};
    if (slot.command === undefined && nonEmpty(entry.command) !== null) slot.command = entry.command;
    if (slot.detail === undefined && nonEmpty(entry.detail) !== null) slot.detail = entry.detail;
    if (slot.changedFiles === undefined && (entry.changedFiles?.length ?? 0) > 0) {
      slot.changedFiles = entry.changedFiles;
    }
    borrowed.set(callId, slot);
  }

  if (borrowed.size === 0 && outputs.size === 0) return [...entries];

  // The streamed output lands on the LAST row that owns the call — the terminal
  // one — so it is printed once, and so it survives
  // `omitSupersededLifecycleMarkers` dropping the unkeyed start frame.
  const outputRow = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as T;
    const callId = entry.toolCallId;
    if (callId === undefined || isToolOutputRow(entry)) continue;
    if (outputs.has(callId)) outputRow.set(callId, index);
  }

  const result: T[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as T;
    const callId = entry.toolCallId;
    if (callId === undefined) {
      result.push(entry);
      continue;
    }
    if (isToolOutputRow(entry)) {
      // Kept only when nothing in this group owns it, so nothing is lost.
      if (!owners.has(callId)) result.push(entry);
      continue;
    }
    const slot = borrowed.get(callId);
    const patch: Partial<WorkLogEntry> = {};
    if (slot !== undefined) {
      if (nonEmpty(entry.command) === null && slot.command !== undefined) patch.command = slot.command;
      if (nonEmpty(entry.detail) === null && slot.detail !== undefined) patch.detail = slot.detail;
      if ((entry.changedFiles?.length ?? 0) === 0 && slot.changedFiles !== undefined) {
        patch.changedFiles = slot.changedFiles;
      }
    }
    if (outputRow.get(callId) === index) {
      patch.detail = (outputs.get(callId) ?? []).join("");
    }
    result.push(Object.keys(patch).length === 0 ? entry : { ...entry, ...patch });
  }
  return result;
}

// ---------------------------------------------------------------------------
// §4.6.5(b) — a `/compact` submission is a marker, not a bubble
// ---------------------------------------------------------------------------

/**
 * A user message that is the `/compact` command itself.
 *
 * §4.6.5(b): the submission is persisted **verbatim** and re-recognised by
 * string comparison at render time, so the timeline shows a compaction marker
 * rather than a literal `/compact` bubble. The orchestrator stores the raw
 * input, so `"  /COMPACT  "` reaches us untrimmed — hence trim + lowercase.
 * A message carrying attachments is never the command.
 *
 * *T3: `apps/web/src/components/ChatView.tsx:735-738` (`isCompactCommandMessage`).*
 */
export function isCompactCommandMessage(message: {
  role: string;
  text: string;
  attachments?: readonly unknown[] | undefined;
}): boolean {
  return (
    message.role === "user" &&
    (message.attachments?.length ?? 0) === 0 &&
    message.text.trim().toLowerCase() === "/compact"
  );
}

// ---------------------------------------------------------------------------
// §4.6.7 — `$skill` mentions are re-chipped from the stored text
// ---------------------------------------------------------------------------

/** One run of a user message: plain text, or a recognised skill mention. */
export interface MessageTextRun {
  text: string;
  /** The skill's name when this run is a mention; absent for plain text. */
  skill?: string;
}

/**
 * Splits a message into text and skill-mention runs, for re-chipping (§4.6.7).
 *
 * **What counts as a mention is decided entirely by the composer's own
 * tokeniser** ({@link skillMentionsInText}) — the arbitration makes
 * `composer/composer-menu.ts` the one slash/skill implementation, so this must
 * not re-state its rules. It hands the text and the current per-cwd catalog to
 * that tokeniser and only *locates* the names it came back with, so a mention
 * renders as a chip in exactly the cases the composer would have treated as
 * one: unknown names stay literal, the catalog match is case-insensitive while
 * the typed spelling is preserved, `\p{Sc}` means a € or £ keyboard reaches
 * skills too, and a name may contain dots and dashes.
 *
 * Longest-first alternation mirrors the tokeniser's greedy `[\w.-]+`: with both
 * `my-skill` and `my-skill.v2` known, `$my-skill.v2` is one chip, not a chip
 * plus a stray `.v2`.
 *
 * Returns a single plain run when there is nothing to chip, so the common path
 * neither scans nor allocates.
 */
export function splitSkillMentions(text: string, skills: readonly string[]): MessageTextRun[] {
  if (text.length === 0 || skills.length === 0) return [{ text }];
  const names = skillMentionsInText(text, skills);
  if (names.length === 0) return [{ text }];

  const alternation = [...names]
    .sort((a, b) => b.length - a.length)
    // `.` is a regex metacharacter and `-` is legal in a skill name; the helper
    // escapes the former, and `-` needs no escape outside a character class (it
    // would be illegal under the `u` flag).
    .map((name) => escapeRegExp(name))
    .join("|");
  // The same boundary the tokeniser uses: start-of-text or whitespace, then a
  // currency symbol. The trailing guard stops a shorter name matching inside a
  // longer one the tokeniser would have taken whole.
  const pattern = new RegExp(`(^|\\s)(\\p{Sc})(${alternation})(?![\\w.-])`, "gu");

  const runs: MessageTextRun[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const lead = match[1] ?? "";
    const symbol = match[2] ?? "";
    const name = match[3] ?? "";
    const start = match.index + lead.length;
    if (start > cursor) runs.push({ text: text.slice(cursor, start) });
    runs.push({ text: `${symbol}${name}`, skill: name });
    cursor = start + symbol.length + name.length;
  }
  if (runs.length === 0) return [{ text }];
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
}
