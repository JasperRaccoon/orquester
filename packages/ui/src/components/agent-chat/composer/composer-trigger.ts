// Ported from T3 Code (MIT): apps/web/src/composer-logic.ts
/**
 * Caret-relative trigger detection for the composer (spec §7.4, §4.6.7).
 *
 * Orquester's composer is a plain `<textarea>`, not T3's Tiptap document, so
 * this file is the whole of T3's three cursor coordinate spaces collapsed into
 * one: the caret is a plain character offset into the draft string and nothing
 * expands or collapses under it. The three triggers themselves are T3's,
 * character for character:
 *
 *  - **`/` only at the start of the current LINE** — `/^\/(\S*)$/` against the
 *    text from the line start to the caret. A slash mid-word is a path, a date
 *    or a regex, never a command menu.
 *  - **`\p{Sc}` (any currency symbol) starts a skill token.** T3 matches the
 *    Unicode category rather than a literal `$` so a keyboard laid out for €
 *    or £ reaches skills too.
 *  - **`@` starts a path token**, on the current whitespace-delimited token.
 *
 * T3's `#` pull-request trigger has no Orquester equivalent and is dropped.
 *
 * *T3: `composer-logic.ts:218-262` (`detectComposerTrigger`), `:280-289`
 * (`parseStandaloneComposerSlashCommand`), `:291-302` (`replaceTextRange`).*
 */

/** `path` = `@…`, `slash-command` = `/…` at a line start, `skill` = `$…`. */
export type ComposerTriggerKind = "path" | "slash-command" | "skill";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  /** What the user typed after the trigger character. */
  query: string;
  /** Offset of the trigger character itself. */
  rangeStart: number;
  /** The caret — insertion replaces `[rangeStart, rangeEnd)`. */
  rangeEnd: number;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

/**
 * The trigger under the caret, or `null`.
 *
 * A trigger stops existing the moment the token contains whitespace, which is
 * what closes the menu when the user types past a command name.
 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      return {
        kind: "slash-command",
        query: commandMatch[1] ?? "",
        rangeStart: lineStart,
        rangeEnd: cursor
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);

  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor
    };
  }

  if (!token.startsWith("@")) {
    return null;
  }

  return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

/**
 * `true` when this trigger opens the whole message.
 *
 * §4.6.7's position gate: a provider expands a slash command only when it is
 * the first thing in the message, so offering one anywhere else would hand the
 * user a guaranteed no-op.
 */
export function isTriggerAtPromptStart(trigger: ComposerTrigger): boolean {
  return trigger.rangeStart === 0;
}

/** Replace `[rangeStart, rangeEnd)` and report where the caret lands. */
export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  return {
    text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
    cursor: safeStart + replacement.length
  };
}

/**
 * Swallow one space that already follows the caret when the replacement ends
 * in one, so picking `/plan` from a menu typed mid-sentence does not leave
 * `/plan  rest` with a double space.
 *
 * *T3: `ChatComposer.tsx` — `extendReplacementRangeForTrailingSpace`.*
 */
export function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string
): number {
  if (!replacement.endsWith(" ")) return rangeEnd;
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

/**
 * `/plan` or `/default` typed out and SENT, with nothing else in the draft.
 *
 * §4.6.5(a): these two are re-recognised on submit; `/model` and `/effort` are
 * deliberately **not**, which keeps the submit path free of guesswork — typed
 * out and sent they are ordinary text.
 */
export function parseStandaloneComposerSlashCommand(text: string): "plan" | "default" | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) return null;
  return match[1]?.toLowerCase() === "plan" ? "plan" : "default";
}

/**
 * §4.6.5(b): the host-native compaction predicate, exact and deliberately
 * narrow — the trimmed, lowercased draft is exactly `/compact`. The composer
 * may send either this or the `/compact` command; they land on the same host
 * path.
 */
export function isStandaloneCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/compact";
}
